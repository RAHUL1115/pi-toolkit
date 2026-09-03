import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createBashToolDefinition,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	getShellConfig,
	truncateTail,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BackgroundTaskViewer, type BackgroundTaskItem, sanitizeTaskLabel } from "./background-task-viewer.js";

const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;
export const DEFAULT_BACKGROUND_LOG_BYTES = 2 * 1024 * 1024;
export const DEFAULT_FINISHED_TASKS = 50;
const DEFAULT_TERMINATION_GRACE_MS = 250;
const DEFAULT_TERMINATION_TIMEOUT_MS = 5_000;
const EXIT_STDIO_GRACE_MS = 100;
const OUTPUT_CAP_MARKER = Buffer.from("\n[Background task log limit reached; use bash_output for the recent tail.]\n");
const OUTPUT_TAIL_BYTES = DEFAULT_MAX_BYTES * 4;
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const UNSAFE_OUTPUT_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

const backgroundBashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
	run_in_background: Type.Optional(Type.Boolean({ description: "Run asynchronously and return a background task ID" })),
	title: Type.Optional(Type.String({ description: "Optional task title shown in /tasks (maximum 80 characters)", maxLength: 80 })),
});

type JobStatus = "running" | "exited" | "failed" | "stopped" | "timed_out";
type TerminationStatus = Extract<JobStatus, "stopped" | "timed_out">;
type ForegroundWaiter = {
	onData: (data: Buffer) => void;
	resolve: (exitCode: number | null) => void;
	reject: (error: Error) => void;
	detachAbort?: () => void;
};
type Job = {
	id: string;
	title: string;
	command: string;
	cwd: string;
	child: ChildProcess;
	output: WriteStream;
	directory: string;
	outputPath: string;
	pid?: number;
	startedAt: number;
	endedAt?: number;
	exitCode?: number | null;
	status: JobStatus;
	error?: string;
	timeoutSeconds?: number;
	timeout?: NodeJS.Timeout;
	autoBackground?: NodeJS.Timeout;
	background: boolean;
	foreground?: ForegroundWaiter;
	notified?: boolean;
	bytesWritten: number;
	droppedBytes: number;
	tailChunks: Buffer[];
	tailBytes: number;
	outputError?: Error;
	terminationStatus?: TerminationStatus;
	termination?: Promise<void>;
	closed: Promise<void>;
	settled: Promise<void>;
	finished: Promise<void>;
	cleanup?: Promise<void>;
};

export type BackgroundBashManagerOptions = {
	maxLogBytes?: number;
	maxFinishedJobs?: number;
	terminationGraceMs?: number;
	terminationTimeoutMs?: number;
	tempDirectory?: string;
};

type ManagerEvent = "list" | "output";
type ManagerListener = (id?: string) => void;

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function jobEnvironment(ctx: ExtensionContext): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.PI_SESSION_ID;
	delete env.PI_SESSION_FILE;
	delete env.PI_PROVIDER;
	delete env.PI_MODEL;
	delete env.PI_REASONING_LEVEL;
	env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (sessionFile) env.PI_SESSION_FILE = sessionFile;
	if (ctx.model) {
		env.PI_PROVIDER = ctx.model.provider;
		env.PI_MODEL = ctx.model.id;
	}
	if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
	return env;
}

function killTree(pid: number, force = false): void {
	try {
		if (process.platform === "win32") {
			// Windows has no reliable SIGTERM equivalent for an arbitrary console tree.
			spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true });
		} else {
			process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
		}
	} catch {
		// The process may already have exited.
	}
}

function processTreeExists(pid: number): boolean {
	if (process.platform === "win32") return false;
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

async function waitForTreeExit(pid: number, milliseconds: number): Promise<boolean> {
	const deadline = Date.now() + milliseconds;
	while (processTreeExists(pid) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return !processTreeExists(pid);
}

async function waitFor(promise: Promise<void>, milliseconds: number): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise.then(() => true),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), milliseconds);
				timer.unref();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function resolvedTitle(title: string | undefined, command: string): string {
	if (title !== undefined && title.length > 80) throw new Error("Invalid title: must be at most 80 characters");
	return sanitizeTaskLabel(title ?? "") || sanitizeTaskLabel(command).slice(0, 80) || "Untitled command";
}

function sanitizeOutput(value: string): string {
	return stripVTControlCharacters(value).replace(BIDI_CONTROLS, "").replace(UNSAFE_OUTPUT_CONTROLS, "");
}

function readOutput(job: Job): string {
	const result = truncateTail(Buffer.concat(job.tailChunks, job.tailBytes).toString("utf8"), {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: DEFAULT_MAX_LINES,
	});
	const prefix = result.truncated ? "[Output truncated to the recent tail]\n" : "";
	const retained = sanitizeOutput(`${prefix}${result.content}`).trimEnd();
	const overflow = job.droppedBytes > 0 ? `[Output cap reached; dropped ${job.droppedBytes} bytes from the retained log]` : "";
	return retained && overflow ? `${retained}\n${overflow}` : retained || overflow;
}

function describe(job: Job, output = ""): string {
	const elapsed = ((job.endedAt ?? Date.now()) - job.startedAt) / 1000;
	const exit = job.exitCode === undefined ? "" : `, exit ${job.exitCode ?? "signal"}`;
	const error = job.error ? `\nError: ${sanitizeTaskLabel(job.error)}` : "";
	const body = output ? `\n\n${output}` : "\n\n(no output yet)";
	return `${job.id}: ${job.status}${exit}, PID ${job.pid ?? "unknown"}, ${elapsed.toFixed(1)}s\nOutput: ${job.outputPath}${error}${body}`;
}

export class BackgroundBashManager {
	private readonly jobs = new Map<string, Job>();
	private readonly foregroundJobs = new Map<string, Job>();
	private readonly listeners: Record<ManagerEvent, Set<ManagerListener>> = { list: new Set(), output: new Set() };
	private readonly maxLogBytes: number;
	private readonly maxFinishedJobs: number;
	private readonly terminationGraceMs: number;
	private readonly terminationTimeoutMs: number;
	private readonly tempDirectory: string;
	private nextId = 1;
	private disposed = false;
	private shutdown?: Promise<void>;

	constructor(
		private readonly cwd: string,
		private readonly onComplete?: (job: Job) => void,
		private readonly autoBackgroundMs = 60_000,
		private readonly onRunningCountChanged?: (count: number) => void,
		options: BackgroundBashManagerOptions = {},
	) {
		this.maxLogBytes = options.maxLogBytes ?? DEFAULT_BACKGROUND_LOG_BYTES;
		this.maxFinishedJobs = options.maxFinishedJobs ?? DEFAULT_FINISHED_TASKS;
		this.terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
		this.terminationTimeoutMs = options.terminationTimeoutMs ?? DEFAULT_TERMINATION_TIMEOUT_MS;
		this.tempDirectory = options.tempDirectory ?? tmpdir();
		if (!Number.isInteger(this.maxLogBytes) || this.maxLogBytes <= 0) throw new Error("maxLogBytes must be a positive integer");
		if (!Number.isInteger(this.maxFinishedJobs) || this.maxFinishedJobs < 0) throw new Error("maxFinishedJobs must be a non-negative integer");
	}

	on(event: ManagerEvent, listener: ManagerListener): () => void {
		this.listeners[event].add(listener);
		return () => this.listeners[event].delete(listener);
	}

	private emit(event: ManagerEvent, id?: string): void {
		if (this.disposed) return;
		for (const listener of this.listeners[event]) {
			try {
				listener(id);
			} catch {
				// UI listeners must not break process or stream lifecycle callbacks.
			}
		}
	}

	private emitRunningCount(): void {
		if (this.disposed) return;
		try {
			this.onRunningCountChanged?.([...this.jobs.values()].filter((job) => job.status === "running").length);
		} catch {
			// Footer/event callbacks must not break process lifecycle.
		}
	}

	private validateTimeout(timeoutSeconds: number | undefined): void {
		if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > MAX_TIMEOUT_SECONDS)) {
			throw new Error(`Invalid timeout: must be a finite positive number no greater than ${MAX_TIMEOUT_SECONDS} seconds`);
		}
	}

	private appendOutput(job: Job, data: Buffer): void {
		try {
			job.foreground?.onData(data);
		} catch {
			// A renderer/update callback must not crash the child stream handler.
		}
		job.tailChunks.push(data);
		job.tailBytes += data.byteLength;
		while (job.tailBytes > OUTPUT_TAIL_BYTES && job.tailChunks.length > 0) {
			const first = job.tailChunks[0];
			const excess = job.tailBytes - OUTPUT_TAIL_BYTES;
			if (first.byteLength <= excess) {
				job.tailChunks.shift();
				job.tailBytes -= first.byteLength;
			} else {
				job.tailChunks[0] = first.subarray(excess);
				job.tailBytes -= excess;
			}
		}

		const payloadLimit = Math.max(0, this.maxLogBytes - Math.min(this.maxLogBytes, OUTPUT_CAP_MARKER.byteLength));
		const remaining = Math.max(0, payloadLimit - job.bytesWritten);
		const retained = Math.min(remaining, data.byteLength);
		if (retained > 0 && !job.output.destroyed && !job.outputError) {
			job.output.write(data.subarray(0, retained));
			job.bytesWritten += retained;
		}
		const dropped = data.byteLength - retained;
		if (dropped > 0 && job.droppedBytes === 0 && !job.output.destroyed && !job.outputError) {
			const marker = OUTPUT_CAP_MARKER.subarray(0, this.maxLogBytes - job.bytesWritten);
			if (marker.byteLength > 0) {
				job.output.write(marker);
				job.bytesWritten += marker.byteLength;
			}
		}
		job.droppedBytes += dropped;
		this.emit("output", job.id);
	}

	private async spawnJob(
		command: string,
		title: string | undefined,
		timeoutSeconds: number | undefined,
		env: NodeJS.ProcessEnv,
		background: boolean,
	): Promise<Job> {
		if (this.disposed) throw new Error("Background task manager is shut down");
		this.validateTimeout(timeoutSeconds);
		const taskTitle = resolvedTitle(title, command);
		const shell = getShellConfig();
		const fromStdin = shell.commandTransport === "stdin";
		const directory = await mkdtemp(join(this.tempDirectory, "pi-background-bash-"));
		if (this.disposed) {
			await rm(directory, { recursive: true, force: true });
			throw new Error("Background task manager is shut down");
		}
		const outputPath = join(directory, "output.log");
		const output = createWriteStream(outputPath, { flags: "a" });
		let child: ChildProcess;
		try {
			child = spawn(shell.shell, fromStdin ? shell.args : [...shell.args, command], {
				cwd: this.cwd,
				detached: process.platform !== "win32",
				env,
				stdio: [fromStdin ? "pipe" : "ignore", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (error) {
			await new Promise<void>((resolve) => {
				if (output.closed) resolve();
				else {
					output.once("close", resolve);
					output.destroy();
				}
			});
			await rm(directory, { recursive: true, force: true });
			throw error;
		}
		if (fromStdin) {
			child.stdin?.on("error", () => {});
			child.stdin?.end(command);
		}

		const childClosed = deferred();
		const outputClosed = deferred();
		const job: Job = {
			id: `bash-${this.nextId++}`,
			title: taskTitle,
			command,
			cwd: this.cwd,
			child,
			output,
			directory,
			outputPath,
			pid: child.pid,
			startedAt: Date.now(),
			status: "running",
			timeoutSeconds,
			background,
			bytesWritten: 0,
			droppedBytes: 0,
			tailChunks: [],
			tailBytes: 0,
			closed: childClosed.promise,
			settled: Promise.all([childClosed.promise, outputClosed.promise]).then(() => {}),
			finished: Promise.resolve(),
		};
		job.finished = job.settled.then(() => this.afterClosed(job));
		void job.finished.catch(() => {});

		output.once("error", (error) => {
			job.outputError = error;
			job.error = `Output log failed: ${error.message}`;
		});
		output.once("close", outputClosed.resolve);
		let exited = false;
		let stdioFinished = false;
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;
		let stdioIdle: NodeJS.Timeout | undefined;
		const finishStdio = () => {
			if (stdioFinished) return;
			stdioFinished = true;
			if (stdioIdle) clearTimeout(stdioIdle);
			child.stdout?.destroy();
			child.stderr?.destroy();
			if (output.destroyed) outputClosed.resolve();
			else output.end();
		};
		const armStdioIdle = () => {
			if (!exited || stdioFinished) return;
			if (stdioIdle) clearTimeout(stdioIdle);
			stdioIdle = setTimeout(finishStdio, EXIT_STDIO_GRACE_MS);
			stdioIdle.unref();
		};
		const finishProcess = (code: number | null) => {
			if (exited) return;
			exited = true;
			if (job.terminationStatus) job.status = job.terminationStatus;
			else if (job.error) job.status = "failed";
			else job.status = "exited";
			job.exitCode = code;
			job.endedAt = Date.now();
			if (job.timeout) clearTimeout(job.timeout);
			childClosed.resolve();
			if (stdoutEnded && stderrEnded) finishStdio();
			else armStdioIdle();
			if (job.background) this.emitRunningCount();
			this.emit("list", job.id);
		};
		const writeData = (data: Buffer | string) => {
			this.appendOutput(job, Buffer.isBuffer(data) ? data : Buffer.from(data));
			armStdioIdle();
		};
		child.stdout?.on("data", writeData);
		child.stderr?.on("data", writeData);
		child.stdout?.once("end", () => {
			stdoutEnded = true;
			if (exited && stderrEnded) finishStdio();
		});
		child.stderr?.once("end", () => {
			stderrEnded = true;
			if (exited && stdoutEnded) finishStdio();
		});
		child.once("error", (error) => {
			job.error = error.message;
		});
		child.once("exit", finishProcess);
		child.once("close", (code) => {
			finishProcess(code);
			finishStdio();
		});
		if (background) {
			this.jobs.set(job.id, job);
			this.emitRunningCount();
			this.emit("list", job.id);
		} else this.foregroundJobs.set(job.id, job);
		if (timeoutSeconds !== undefined) {
			job.timeout = setTimeout(() => {
				void this.terminate(job, "timed_out").catch((error) => {
					job.error = error instanceof Error ? error.message : String(error);
					this.emit("list", job.id);
				});
			}, timeoutSeconds * 1000);
			job.timeout.unref();
		}
		return job;
	}

	private async afterClosed(job: Job): Promise<void> {
		if (job.autoBackground) clearTimeout(job.autoBackground);
		if (job.background) {
			this.foregroundJobs.delete(job.id);
			this.emit("output", job.id);
		}
		if (job.outputError && !job.terminationStatus) {
			job.status = "failed";
			this.emit("list", job.id);
		}
		if (!job.background) {
			try {
				await this.cleanupJob(job);
				this.foregroundJobs.delete(job.id);
			} catch {
				// Keep it tracked so shutdown can retry without failing the Bash result.
			}
		}
		if (job.background && !job.notified && !this.disposed) {
			job.notified = true;
			try {
				this.onComplete?.(job);
			} catch {
				// Extension notifications must not block retention and cleanup.
			}
		}
		if (job.background) {
			try {
				await this.evictFinished();
			} catch {
				// Keep failed-cleanup jobs tracked so a later clear or shutdown can retry.
			}
		}
	}

	private finishForeground(job: Job, waiter: ForegroundWaiter): void {
		if (job.foreground !== waiter) return;
		waiter.detachAbort?.();
		job.foreground = undefined;
		if (job.status === "failed") waiter.reject(new Error(job.error ?? "Bash process failed"));
		else if (job.status === "timed_out") waiter.reject(new Error(`timeout:${job.timeoutSeconds}`));
		else if (job.status === "stopped") waiter.reject(new Error("aborted"));
		else waiter.resolve(job.exitCode ?? null);
	}

	private async cleanupJob(job: Job): Promise<void> {
		if (!job.cleanup) {
			const cleanup = rm(job.directory, { recursive: true, force: true });
			job.cleanup = cleanup;
			void cleanup.catch(() => {
				if (job.cleanup === cleanup) job.cleanup = undefined;
			});
		}
		await job.cleanup;
	}

	private async evictFinished(): Promise<void> {
		const finished = [...this.jobs.values()]
			.filter((job) => job.status !== "running")
			.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
		const evicted = finished.slice(0, Math.max(0, finished.length - this.maxFinishedJobs));
		for (const job of evicted) {
			await this.cleanupJob(job);
			this.jobs.delete(job.id);
		}
		if (evicted.length > 0) this.emit("list");
	}

	private async terminate(job: Job, requestedStatus: TerminationStatus): Promise<void> {
		if (job.status !== "running") {
			if (!(await waitFor(job.settled, this.terminationTimeoutMs))) throw new Error(`Task ${job.id} output log did not flush`);
			return;
		}
		if (job.termination) return job.termination;
		job.terminationStatus ??= requestedStatus;
		const termination = (async () => {
			if (job.pid && process.platform === "win32") {
				killTree(job.pid, true);
			} else if (job.pid) {
				killTree(job.pid);
				await waitFor(job.closed, this.terminationGraceMs);
				// Always force the remaining process group: its leader may exit before a descendant.
				killTree(job.pid, true);
			}
			if (!(await waitFor(job.closed, this.terminationTimeoutMs))) {
				throw new Error(`Could not confirm that task ${job.id} exited`);
			}
			if (job.pid && process.platform !== "win32" && !(await waitForTreeExit(job.pid, this.terminationTimeoutMs))) {
				throw new Error(`Could not confirm that task ${job.id} process tree exited`);
			}
			if (!(await waitFor(job.settled, this.terminationTimeoutMs))) throw new Error(`Task ${job.id} exited, but its output log did not flush`);
		})();
		job.termination = termination;
		try {
			await termination;
		} finally {
			if (job.termination === termination) job.termination = undefined;
		}
	}

	async start(command: string, timeoutSeconds: number | undefined, ctx: ExtensionContext, title?: string): Promise<Job> {
		return this.spawnJob(command, title, timeoutSeconds, jobEnvironment(ctx), true);
	}

	async runForeground(
		command: string,
		timeoutSeconds: number | undefined,
		env: NodeJS.ProcessEnv,
		signal: AbortSignal | undefined,
		onData: (data: Buffer) => void,
		title?: string,
	): Promise<{ exitCode: number | null }> {
		const job = await this.spawnJob(command, title, timeoutSeconds, env, false);
		return new Promise((resolve, reject) => {
			const waiter: ForegroundWaiter = {
				onData,
				resolve: (exitCode) => resolve({ exitCode }),
				reject,
			};
			const onAbort = () => {
				void this.terminate(job, "stopped").catch(reject);
			};
			waiter.detachAbort = signal ? () => signal.removeEventListener("abort", onAbort) : undefined;
			job.foreground = waiter;
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
			void job.finished.then(() => this.finishForeground(job, waiter), reject);
			if (job.status === "running" && this.autoBackgroundMs > 0) {
				job.autoBackground = setTimeout(() => this.background(job), this.autoBackgroundMs);
				job.autoBackground.unref();
			}
		});
	}

	private background(job: Job): Job | undefined {
		if (job.status !== "running" || !job.foreground) return undefined;
		if (job.autoBackground) clearTimeout(job.autoBackground);
		job.background = true;
		this.jobs.set(job.id, job);
		this.foregroundJobs.delete(job.id);
		this.emitRunningCount();
		this.emit("list", job.id);
		const waiter = job.foreground;
		const message = Buffer.from(`\nCommand moved to background: ${job.id} (PID ${job.pid ?? "unknown"})\nOutput: ${job.outputPath}\n`);
		this.appendOutput(job, message);
		job.foreground = undefined;
		waiter.detachAbort?.();
		waiter.resolve(0);
		return job;
	}

	backgroundForeground(): Job | undefined {
		const job = [...this.foregroundJobs.values()].reverse().find((candidate) => candidate.status === "running" && candidate.foreground);
		return job ? this.background(job) : undefined;
	}

	get(id: string): Job | undefined {
		return this.jobs.get(id);
	}

	list(): Job[] {
		return [...this.jobs.values()];
	}

	output(job: Job): string {
		return readOutput(job);
	}

	async stop(job: Job): Promise<void> {
		await this.terminate(job, "stopped");
	}

	async clear(id: string): Promise<boolean> {
		const job = this.jobs.get(id);
		if (!job || job.status === "running") return false;
		await job.finished;
		await this.cleanupJob(job);
		if (!this.jobs.delete(id)) return false;
		job.notified = true;
		this.emit("list", id);
		return true;
	}

	async delete(id: string): Promise<void> {
		await this.clear(id);
	}

	async clearFinished(): Promise<number> {
		const finished = [...this.jobs.values()].filter((job) => job.status !== "running");
		const results = await Promise.allSettled(finished.map(async (job) => {
			await job.finished;
			await this.cleanupJob(job);
			const removed = this.jobs.delete(job.id);
			if (removed) job.notified = true;
			return removed;
		}));
		const cleared = results.filter((result): result is PromiseFulfilledResult<boolean> => result.status === "fulfilled" && result.value).length;
		if (cleared > 0) this.emit("list");
		const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
		if (failures.length > 0) throw new AggregateError(failures.map((failure) => failure.reason), "Some background tasks could not be cleared");
		return cleared;
	}

	async stopAll(): Promise<void> {
		if (this.shutdown) return this.shutdown;
		this.disposed = true;
		const shutdown = (async () => {
			const jobs = [...new Set([...this.jobs.values(), ...this.foregroundJobs.values()])];
			const terminations = await Promise.allSettled(jobs.map((job) => this.terminate(job, "stopped")));
			const cleanups = await Promise.allSettled(jobs.map((job, index) =>
				terminations[index]?.status === "fulfilled" ? this.cleanupJob(job) : Promise.reject(terminations[index]?.reason),
			));
			for (let index = 0; index < jobs.length; index++) {
				if (cleanups[index]?.status === "fulfilled") {
					this.jobs.delete(jobs[index].id);
					this.foregroundJobs.delete(jobs[index].id);
				}
			}
			this.listeners.list.clear();
			this.listeners.output.clear();
			const failures = [...terminations, ...cleanups].filter((result): result is PromiseRejectedResult => result.status === "rejected");
			if (failures.length > 0) throw new AggregateError(failures.map((failure) => failure.reason), "Background task shutdown incomplete");
		})();
		this.shutdown = shutdown;
		try {
			await shutdown;
		} catch (error) {
			if (this.shutdown === shutdown) this.shutdown = undefined;
			throw error;
		}
	}
}

export function registerBackgroundBash(pi: ExtensionAPI, cwd = process.cwd(), autoBackgroundMs = 60_000): ToolDefinition<any, any, any> {
	const titleContext = new AsyncLocalStorage<{ title?: string }>();
	const manager = new BackgroundBashManager(cwd, (job) => {
		const command = sanitizeTaskLabel(job.command);
		const boundedCommand = command.length > 500 ? `${command.slice(0, 500)}…` : command;
		const exit = job.exitCode === undefined ? "" : `, exit ${job.exitCode ?? "signal"}`;
		pi.sendMessage({
			customType: "background-bash-notification",
			content: `Background task ${job.id} finished: ${job.status}${exit}.\nTitle: ${job.title}\nCommand: ${boundedCommand}\nOutput remains in temporary file: ${job.outputPath}\nUse bash_output only if the output is needed.`,
			display: true,
			details: { jobId: job.id, status: job.status, exitCode: job.exitCode, outputPath: job.outputPath },
		}, { deliverAs: "followUp", triggerTurn: true });
	}, autoBackgroundMs, (count) => pi.events.emit("background-bash:count", { running: count }));
	const foreground = createBashToolDefinition(cwd, {
		operations: {
			exec: (command, _cwd, options) => manager.runForeground(
				command,
				options.timeout,
				options.env ?? process.env,
				options.signal,
				options.onData,
				titleContext.getStore()?.title,
			),
		},
	});
	const bash = {
		...foreground,
		description: `${foreground.description} Commands start in the foreground and automatically move to the background after ${autoBackgroundMs / 1000} seconds. Set run_in_background=true to start there immediately, or press Ctrl+B while a foreground command is running. An optional title (maximum 80 characters) names the task in /tasks. Use /tasks to manage tasks, or bash_output and bash_stop with the returned task ID.`,
		parameters: backgroundBashSchema,
		async execute(toolCallId: string, params: { command: string; timeout?: number; run_in_background?: boolean; title?: string }, signal: AbortSignal | undefined, onUpdate: any, ctx: ExtensionContext) {
			resolvedTitle(params.title, params.command);
			if (!params.run_in_background) {
				return titleContext.run({ title: params.title }, () => foreground.execute(toolCallId, { command: params.command, timeout: params.timeout }, signal, onUpdate, ctx));
			}
			const job = await manager.start(params.command, params.timeout, ctx, params.title);
			return {
				content: [{ type: "text" as const, text: `Background task started: ${job.id} (PID ${job.pid ?? "unknown"})\nOutput: ${job.outputPath}` }],
				details: { backgroundJobId: job.id, pid: job.pid, outputPath: job.outputPath },
			};
		},
	};

	pi.registerShortcut("ctrl+b", {
		description: "Move the running Bash command to background tasks",
		handler: (ctx) => {
			const job = manager.backgroundForeground();
			if (job) ctx.ui.notify(`Task ${job.id} is now running in background.`, "info");
		},
	});

	pi.registerCommand("tasks", {
		description: "Show, stop, and clear background tasks",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/tasks requires TUI mode", "error");
				return;
			}
			await ctx.ui.custom<undefined>((tui, theme, _keybindings, done) => new BackgroundTaskViewer(tui, {
				list: () => manager.list().map((job): BackgroundTaskItem => ({
					id: job.id,
					title: job.title,
					command: job.command,
					status: job.status,
					pid: job.pid,
					startedAt: job.startedAt,
					endedAt: job.endedAt,
					exitCode: job.exitCode,
				})),
				output: (id) => {
					const job = manager.get(id);
					return job ? manager.output(job) : "";
				},
				stop: async (id) => {
					const job = manager.get(id);
					if (job) await manager.stop(job);
				},
				clear: (id) => manager.clear(id).then(() => {}),
				clearFinished: () => manager.clearFinished().then(() => {}),
				onList: (listener) => manager.on("list", listener),
				onOutput: (listener) => manager.on("output", (id) => {
					if (id) listener(id);
				}),
			}, theme, done));
		},
	});

	pi.registerTool({
		name: "bash_output",
		label: "task output",
		description: "Read current output and status for a background task. Output is truncated to the last 2000 lines or 50KB.",
		parameters: Type.Object({ job_id: Type.String({ description: "Background task ID returned by bash" }) }),
		async execute(_id, { job_id }) {
			const job = manager.get(job_id);
			if (!job) throw new Error(`Unknown background task: ${job_id}`);
			return {
				content: [{ type: "text", text: describe(job, manager.output(job)) }],
				details: { jobId: job.id, status: job.status, exitCode: job.exitCode, outputPath: job.outputPath },
			};
		},
	});

	pi.registerTool({
		name: "bash_stop",
		label: "stop task",
		description: "Stop a background task and its child process tree.",
		parameters: Type.Object({ job_id: Type.String({ description: "Background task ID returned by bash" }) }),
		async execute(_id, { job_id }) {
			const job = manager.get(job_id);
			if (!job) throw new Error(`Unknown background task: ${job_id}`);
			await manager.stop(job);
			return {
				content: [{ type: "text", text: describe(job, manager.output(job)) }],
				details: { jobId: job.id, status: job.status, exitCode: job.exitCode, outputPath: job.outputPath },
			};
		},
	});

	pi.registerTool({
		name: "bash_jobs",
		label: "background tasks",
		description: "List background tasks in the current Pi session.",
		parameters: Type.Object({}),
		async execute() {
			const jobs = manager.list();
			return {
				content: [{ type: "text", text: jobs.length ? jobs.map((job) => describe(job)).join("\n") : "No background tasks." }],
				details: { jobs: jobs.map((job) => ({ id: job.id, title: job.title, status: job.status, pid: job.pid, outputPath: job.outputPath })) },
			};
		},
	});

	pi.on("session_shutdown", async () => manager.stopAll());
	return bash as unknown as ToolDefinition<any, any, any>;
}
