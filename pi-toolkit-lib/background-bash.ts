import { closeSync, createWriteStream, openSync, readSync, statSync, type WriteStream } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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
import { BackgroundTaskViewer, type BackgroundTaskItem } from "./background-task-viewer.js";

const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;
const backgroundBashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
	run_in_background: Type.Optional(Type.Boolean({ description: "Run asynchronously and return a background task ID" })),
});

type JobStatus = "running" | "exited" | "failed" | "stopped" | "timed_out";
type ForegroundWaiter = {
	onData: (data: Buffer) => void;
	resolve: (exitCode: number | null) => void;
	reject: (error: Error) => void;
	detachAbort?: () => void;
};
type Job = {
	id: string;
	command: string;
	cwd: string;
	child: ChildProcess;
	output: WriteStream;
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
};

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
			spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true });
		} else {
			process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
		}
	} catch {
		// The process may already have exited.
	}
}

function readOutput(path: string): string {
	try {
		const size = statSync(path).size;
		const windowSize = Math.min(size, DEFAULT_MAX_BYTES * 4);
		const buffer = Buffer.alloc(windowSize);
		const fd = openSync(path, "r");
		try {
			readSync(fd, buffer, 0, windowSize, Math.max(0, size - windowSize));
		} finally {
			closeSync(fd);
		}
		const result = truncateTail(buffer.toString("utf8"), {
			maxBytes: DEFAULT_MAX_BYTES,
			maxLines: DEFAULT_MAX_LINES,
		});
		const prefix = size > windowSize || result.truncated
			? `[Output truncated; full output: ${path}]\n`
			: "";
		return `${prefix}${result.content}`.trimEnd();
	} catch {
		return "";
	}
}

function describe(job: Job, output = ""): string {
	const elapsed = ((job.endedAt ?? Date.now()) - job.startedAt) / 1000;
	const exit = job.exitCode === undefined ? "" : `, exit ${job.exitCode ?? "signal"}`;
	const error = job.error ? `\nError: ${job.error}` : "";
	const body = output ? `\n\n${output}` : "\n\n(no output yet)";
	return `${job.id}: ${job.status}${exit}, PID ${job.pid ?? "unknown"}, ${elapsed.toFixed(1)}s\nOutput: ${job.outputPath}${error}${body}`;
}

export class BackgroundBashManager {
	private readonly jobs = new Map<string, Job>();
	private readonly foregroundJobs = new Map<string, Job>();
	private nextId = 1;
	private disposed = false;

	constructor(
		private readonly cwd: string,
		private readonly onComplete?: (job: Job) => void,
		private readonly autoBackgroundMs = 60_000,
		private readonly onRunningCountChanged?: (count: number) => void,
	) {}

	private emitRunningCount(): void {
		if (this.disposed) return;
		this.onRunningCountChanged?.([...this.jobs.values()].filter((job) => job.status === "running").length);
	}

	private validateTimeout(timeoutSeconds: number | undefined): void {
		if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > MAX_TIMEOUT_SECONDS)) {
			throw new Error(`Invalid timeout: must be a finite positive number no greater than ${MAX_TIMEOUT_SECONDS} seconds`);
		}
	}

	private async spawnJob(command: string, timeoutSeconds: number | undefined, env: NodeJS.ProcessEnv, background: boolean): Promise<Job> {
		this.validateTimeout(timeoutSeconds);
		const directory = await mkdtemp(join(tmpdir(), "pi-background-bash-"));
		const outputPath = join(directory, "output.log");
		const output = createWriteStream(outputPath, { flags: "a" });
		const shell = getShellConfig();
		const fromStdin = shell.commandTransport === "stdin";
		const child = spawn(shell.shell, fromStdin ? shell.args : [...shell.args, command], {
			cwd: this.cwd,
			detached: process.platform !== "win32",
			env,
			stdio: [fromStdin ? "pipe" : "ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		if (fromStdin) {
			child.stdin?.on("error", () => {});
			child.stdin?.end(command);
		}

		const job: Job = {
			id: `bash-${this.nextId++}`,
			command,
			cwd: this.cwd,
			child,
			output,
			outputPath,
			pid: child.pid,
			startedAt: Date.now(),
			status: "running",
			timeoutSeconds,
			background,
		};
		if (background) {
			this.jobs.set(job.id, job);
			this.emitRunningCount();
		} else this.foregroundJobs.set(job.id, job);

		const writeData = (data: Buffer) => {
			output.write(data);
			job.foreground?.onData(data);
		};
		child.stdout?.on("data", writeData);
		child.stderr?.on("data", writeData);
		child.once("error", (error) => {
			job.status = "failed";
			job.error = error.message;
		});
		child.once("close", (code) => {
			if (job.status === "running") job.status = "exited";
			job.exitCode = code;
			job.endedAt = Date.now();
			if (job.timeout) clearTimeout(job.timeout);
			output.end(() => this.settle(job));
		});
		if (timeoutSeconds !== undefined) {
			job.timeout = setTimeout(() => {
				if (job.status !== "running" || !job.pid) return;
				job.status = "timed_out";
				this.emitRunningCount();
				killTree(job.pid, true);
			}, timeoutSeconds * 1000);
			job.timeout.unref();
		}
		return job;
	}

	private settle(job: Job): void {
		if (job.autoBackground) clearTimeout(job.autoBackground);
		this.foregroundJobs.delete(job.id);
		const waiter = job.foreground;
		if (waiter) {
			waiter.detachAbort?.();
			job.foreground = undefined;
			if (job.status === "failed") waiter.reject(new Error(job.error ?? "Bash process failed"));
			else if (job.status === "timed_out") waiter.reject(new Error(`timeout:${job.timeoutSeconds}`));
			else if (job.status === "stopped") waiter.reject(new Error("aborted"));
			else waiter.resolve(job.exitCode ?? null);
		}
		if (job.background) this.emitRunningCount();
		if (job.background && !job.notified && !this.disposed) {
			job.notified = true;
			this.onComplete?.(job);
		}
	}

	async start(command: string, timeoutSeconds: number | undefined, ctx: ExtensionContext): Promise<Job> {
		return this.spawnJob(command, timeoutSeconds, jobEnvironment(ctx), true);
	}

	async runForeground(
		command: string,
		timeoutSeconds: number | undefined,
		env: NodeJS.ProcessEnv,
		signal: AbortSignal | undefined,
		onData: (data: Buffer) => void,
	): Promise<{ exitCode: number | null }> {
		const job = await this.spawnJob(command, timeoutSeconds, env, false);
		return new Promise((resolve, reject) => {
			const onAbort = () => {
				if (job.status !== "running" || !job.pid) return;
				job.status = "stopped";
				killTree(job.pid);
			};
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
			job.foreground = {
				onData,
				resolve: (exitCode) => resolve({ exitCode }),
				reject,
				detachAbort: signal ? () => signal.removeEventListener("abort", onAbort) : undefined,
			};
			if (job.endedAt !== undefined) this.settle(job);
			else if (this.autoBackgroundMs > 0) {
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
		const waiter = job.foreground;
		job.foreground = undefined;
		waiter.detachAbort?.();
		const message = Buffer.from(`\nCommand moved to background: ${job.id} (PID ${job.pid ?? "unknown"})\nOutput: ${job.outputPath}\n`);
		job.output.write(message);
		waiter.onData(message);
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
		return readOutput(job.outputPath);
	}

	async stop(job: Job): Promise<void> {
		if (job.status !== "running" || !job.pid) return;
		job.status = "stopped";
		this.emitRunningCount();
		killTree(job.pid);
		await new Promise((resolve) => setTimeout(resolve, 100));
		if (job.exitCode === undefined) killTree(job.pid, true);
	}

	async delete(id: string): Promise<void> {
		const job = this.jobs.get(id);
		if (!job) return;
		job.notified = true;
		await this.stop(job);
		this.jobs.delete(id);
	}

	async stopAll(): Promise<void> {
		this.disposed = true;
		const jobs = new Set([...this.jobs.values(), ...this.foregroundJobs.values()]);
		await Promise.all([...jobs].map((job) => this.stop(job)));
	}
}

export function registerBackgroundBash(pi: ExtensionAPI, cwd = process.cwd(), autoBackgroundMs = 60_000): ToolDefinition<any, any, any> {
	const manager = new BackgroundBashManager(cwd, (job) => {
		const command = job.command.length > 500 ? `${job.command.slice(0, 500)}…` : job.command;
		const exit = job.exitCode === undefined ? "" : `, exit ${job.exitCode ?? "signal"}`;
		pi.sendMessage({
			customType: "background-bash-notification",
			content: `Background task ${job.id} finished: ${job.status}${exit}.\nCommand: ${command}\nOutput remains in temporary file: ${job.outputPath}\nUse bash_output only if the output is needed.`,
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
			),
		},
	});
	const bash = {
		...foreground,
		description: `${foreground.description} Commands start in the foreground and automatically move to the background after ${autoBackgroundMs / 1000} seconds. Set run_in_background=true to start there immediately, or press Ctrl+B while a foreground command is running. Use /tasks to manage them, or bash_output and bash_stop with the returned task ID.`,
		parameters: backgroundBashSchema,
		async execute(toolCallId: string, params: { command: string; timeout?: number; run_in_background?: boolean }, signal: AbortSignal | undefined, onUpdate: any, ctx: ExtensionContext) {
			if (!params.run_in_background) {
				return foreground.execute(toolCallId, { command: params.command, timeout: params.timeout }, signal, onUpdate, ctx);
			}
			const job = await manager.start(params.command, params.timeout, ctx);
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
		description: "Show and delete background tasks",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/tasks requires TUI mode", "error");
				return;
			}
			await ctx.ui.custom<undefined>((tui, theme, _keybindings, done) => new BackgroundTaskViewer(tui, {
				list: () => manager.list().map((job): BackgroundTaskItem => ({
					id: job.id,
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
				delete: (id) => manager.delete(id),
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
				details: { jobs: jobs.map((job) => ({ id: job.id, status: job.status, pid: job.pid, outputPath: job.outputPath })) },
			};
		},
	});

	pi.on("session_shutdown", async () => manager.stopAll());
	return bash as unknown as ToolDefinition<any, any, any>;
}
