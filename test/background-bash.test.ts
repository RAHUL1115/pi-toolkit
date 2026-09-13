import { access, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BackgroundBashManager, registerBackgroundBash } from "../pi-toolkit-lib/background-bash.ts";
import { BackgroundTaskViewer, type BackgroundTaskController, type BackgroundTaskItem } from "../pi-toolkit-lib/background-task-viewer.ts";
import { backgroundStatus } from "../pi-toolkit-lib/footer.ts";

function harness(autoBackgroundMs = 60_000) {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const shortcuts = new Map<string, (ctx: any) => void>();
	const notifications: Array<{ message: any; options: any }> = [];
	const backgroundCounts: number[] = [];
	const shutdownHandlers: Array<() => Promise<void>> = [];
	const pi = {
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerShortcut: (key: string, shortcut: any) => shortcuts.set(key, shortcut.handler),
		sendMessage: (message: any, options: any) => notifications.push({ message, options }),
		events: {
			emit: (channel: string, data: any) => {
				if (channel === "background-bash:count") backgroundCounts.push(data.running);
			},
		},
		on: (event: string, handler: () => Promise<void>) => {
			if (event === "session_shutdown") shutdownHandlers.push(handler);
		},
	} as any;
	const bash = registerBackgroundBash(pi, process.cwd(), autoBackgroundMs);
	tools.set("bash", bash);
	const ctx = {
		mode: "tui",
		model: { provider: "test", id: "test-model" },
		thinkingLevel: "off",
		sessionManager: {
			getSessionId: () => "test-session",
			getSessionFile: () => undefined,
		},
		ui: { notify: () => {} },
	} as any;
	return {
		backgroundCounts,
		commands,
		ctx,
		notifications,
		shortcuts,
		tools,
		shutdown: async () => Promise.all(shutdownHandlers.map((handler) => handler())),
	};
}

function testTheme() {
	return { fg: (_color: string, text: string) => text, bold: (text: string) => text };
}

async function waitFor<T>(check: () => Promise<T> | T, accept: (value: T) => boolean, label = "condition"): Promise<T> {
	const deadline = Date.now() + 5000;
	let value = await check();
	while (!accept(value) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 25));
		value = await check();
	}
	if (!accept(value)) throw new Error(`Timed out waiting for ${label}: ${String(value)}`);
	return value;
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

class ViewerController implements BackgroundTaskController {
	items: BackgroundTaskItem[];
	outputs = new Map<string, string>();
	stopCalls = 0;
	clearCalls = 0;
	clearAllCalls = 0;
	readonly listListeners = new Set<() => void>();
	readonly outputListeners = new Set<(id: string) => void>();

	constructor(items: BackgroundTaskItem[]) {
		this.items = items;
	}

	list(): BackgroundTaskItem[] {
		return this.items;
	}

	output(id: string): string {
		return this.outputs.get(id) ?? "";
	}

	async stop(id: string): Promise<void> {
		this.stopCalls++;
		const task = this.items.find((item) => item.id === id);
		if (task) task.status = "stopped";
		this.emitList();
	}

	async clear(id: string): Promise<void> {
		this.clearCalls++;
		this.items = this.items.filter((item) => item.id !== id);
		this.emitList();
	}

	async clearFinished(): Promise<void> {
		this.clearAllCalls++;
		this.items = this.items.filter((item) => item.status === "running");
		this.emitList();
	}

	onList(listener: () => void): () => void {
		this.listListeners.add(listener);
		return () => this.listListeners.delete(listener);
	}

	onOutput(listener: (id: string) => void): () => void {
		this.outputListeners.add(listener);
		return () => this.outputListeners.delete(listener);
	}

	emitList(): void {
		for (const listener of this.listListeners) listener();
	}

	emitOutput(id: string): void {
		for (const listener of this.outputListeners) listener(id);
	}
}

describe("background bash", () => {
	it("does not emit through a stale extension after shutdown", async () => {
		let stale = false;
		const manager = new BackgroundBashManager(process.cwd(), undefined, 60_000, () => {
			if (stale) throw new Error("stale extension ctx");
		});

		await manager.stopAll();
		stale = true;

		expect(() => (manager as any).emitRunningCount()).not.toThrow();
	});

	it("shows only running background tasks in the footer", () => {
		expect(backgroundStatus(2)).toBe("bg tasks:2");
		expect(backgroundStatus(0)).toBe("");
	});

	it("uses sanitized titles and command fallbacks and sanitizes preview output", () => {
		const controller = new ViewerController([
			{
				id: "bash-1",
				title: "\u001b[31mDeploy\u001b[0m \u202eprod",
				command: "ignored",
				status: "running",
				startedAt: Date.now(),
			},
		]);
		controller.outputs.set("bash-1", "one\ntwo\nthree\nfour\nfive\n\u001b[31msix\u001b[0m\u202e\u0007");
		const viewer = new BackgroundTaskViewer({ requestRender: () => {} } as any, controller, testTheme(), () => {});

		const rendered = viewer.render(80).join("\n");
		expect(rendered).toContain("Deploy prod  running");
		expect(rendered).toContain("Output preview  bash-1 · 2-6/6 · following tail");
		expect(rendered).not.toContain("│ one");
		for (const line of ["two", "three", "four", "five", "six"]) expect(rendered).toContain(`│ ${line}`);
		expect(rendered).not.toContain("\u001b[31m");
		expect(rendered).not.toMatch(/[\u202e\u0007]/);
		viewer.dispose();
	});

	it("scrolls and follows five-line output while keeping selection by task ID", async () => {
		const now = Date.now();
		const controller = new ViewerController([
			{ id: "bash-1", command: "first", status: "running", startedAt: now },
			{ id: "bash-2", command: "second", status: "running", startedAt: now },
		]);
		controller.outputs.set("bash-1", "1\n2\n3\n4\n5\n6\n7\n8");
		controller.outputs.set("bash-2", "a\nb\nc\nd\ne\nf");
		const viewer = new BackgroundTaskViewer({ requestRender: () => {} } as any, controller, testTheme(), () => {});

		expect(viewer.render(90).join("\n")).toContain("bash-1 · 4-8/8 · following tail");
		viewer.handleInput("\u001b[1;7A");
		expect(viewer.render(90).join("\n")).toContain("bash-1 · 3-7/8 · paused");
		controller.outputs.set("bash-1", "1\n2\n3\n4\n5\n6\n7\n8\n9");
		controller.emitOutput("bash-1");
		controller.emitOutput("bash-1");
		await new Promise((resolve) => setTimeout(resolve, 125));
		expect(viewer.render(90).join("\n")).toContain("bash-1 · 3-7/9 · paused");
		viewer.handleInput("\u001b[1;3B");
		expect(viewer.render(90).join("\n")).toContain("bash-1 · 5-9/9 · following tail");
		viewer.handleInput("\u001b[1;3A");
		expect(viewer.render(90).join("\n")).toContain("bash-1 · 1-5/9 · paused");
		viewer.handleInput("\u001b[1;2B");
		expect(viewer.render(90).join("\n")).toContain("bash-1 · 5-9/9 · following tail");
		viewer.handleInput("\u001b[1;2A");
		expect(viewer.render(90).join("\n")).toContain("bash-1 · 1-5/9 · paused");
		viewer.handleInput("\u001b[1;3B");
		viewer.handleInput("\u001b[1;7A");
		expect(viewer.render(90).join("\n")).toContain("bash-1 · 4-8/9 · paused");
		viewer.handleInput("\u001b[1;7B");
		expect(viewer.render(90).join("\n")).toContain("bash-1 · 5-9/9 · following tail");
		viewer.handleInput("k");
		expect(viewer.render(90).join("\n")).toContain("bash-1 · 5-9/9 · following tail");

		controller.items.reverse();
		controller.emitList();
		expect(viewer.render(90).join("\n")).toContain("Output preview  bash-1");
		viewer.handleInput("\u001b[A");
		expect(viewer.render(90).join("\n")).toContain("bash-2 · 2-6/6 · following tail");
		viewer.dispose();
	});

	it("refreshes the new selection when the previous task already has a pending paint", async () => {
		const now = Date.now();
		const controller = new ViewerController([
			{ id: "bash-1", command: "first", status: "running", startedAt: now },
			{ id: "bash-2", command: "second", status: "running", startedAt: now },
		]);
		controller.outputs.set("bash-1", "first old");
		controller.outputs.set("bash-2", "second old");
		const viewer = new BackgroundTaskViewer({ requestRender: () => {} } as any, controller, testTheme(), () => {});

		controller.emitOutput("bash-1");
		viewer.handleInput("\u001b[B");
		controller.outputs.set("bash-2", "second final");
		controller.emitOutput("bash-2");
		await new Promise((resolve) => setTimeout(resolve, 125));
		expect(viewer.render(90).join("\n")).toContain("second final");
		viewer.dispose();
	});

	it("throttles output events, does not reread output on clock renders, and unsubscribes on dispose", async () => {
		const task = { id: "bash-1", command: "clock", status: "running", startedAt: Date.now() } as BackgroundTaskItem;
		const controller = new ViewerController([task]);
		let outputReads = 0;
		controller.output = (id: string) => {
			outputReads++;
			return controller.outputs.get(id) ?? "line";
		};
		let renders = 0;
		const viewer = new BackgroundTaskViewer({ requestRender: () => renders++ } as any, controller, testTheme(), () => {});
		expect(outputReads).toBe(1);
		viewer.render(80);
		viewer.render(80);
		expect(outputReads).toBe(1);

		controller.emitOutput("bash-1");
		controller.emitOutput("bash-1");
		controller.emitOutput("bash-1");
		await new Promise((resolve) => setTimeout(resolve, 125));
		expect(outputReads).toBe(2);
		expect(renders).toBeGreaterThan(0);
		viewer.render(80);
		expect(outputReads).toBe(2);

		task.status = "exited";
		controller.emitList();
		expect((viewer as any).clock).toBeUndefined();
		viewer.dispose();
		expect(controller.listListeners.size).toBe(0);
		expect(controller.outputListeners.size).toBe(0);
		controller.emitOutput("bash-1");
		await new Promise((resolve) => setTimeout(resolve, 125));
		expect(outputReads).toBe(2);
	});

	it("clears a finished selection with Delete twice", async () => {
		const controller = new ViewerController([{ id: "bash-1", command: "done", status: "exited", exitCode: 0, startedAt: Date.now() }]);
		const viewer = new BackgroundTaskViewer({ requestRender: () => {} } as any, controller, testTheme(), () => {});
		viewer.handleInput("\u001b[3~");
		expect(viewer.render(90).join("\n")).toContain("Press Delete again to clear");
		viewer.handleInput("\u001b[3~");
		await waitFor(() => controller.clearCalls, (calls) => calls === 1, "Delete clear");
		viewer.dispose();
	});

	it("prevents duplicate pending viewer actions", async () => {
		const controller = new ViewerController([{ id: "bash-1", command: "wait", status: "running", startedAt: Date.now() }]);
		let release = () => {};
		controller.stop = async () => {
			controller.stopCalls++;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		};
		const viewer = new BackgroundTaskViewer({ requestRender: () => {} } as any, controller, testTheme(), () => {});
		viewer.handleInput("x");
		viewer.handleInput("x");
		viewer.handleInput("x");
		expect(controller.stopCalls).toBe(1);
		release();
		await new Promise((resolve) => setTimeout(resolve, 0));
		viewer.dispose();
	});

	it("preserves normal foreground execution and existing tool names", async () => {
		const { ctx, shutdown, tools } = harness();
		try {
			expect([...tools.keys()].sort()).toEqual(["bash", "bash_jobs", "bash_output", "bash_stop"]);
			const result = await tools.get("bash").execute("call-1", { command: "printf 'foreground\\n'" }, undefined, undefined, ctx);
			expect(result.content[0].text).toContain("foreground");
		} finally {
			await shutdown();
		}
	});

	it("automatically backgrounds a foreground process without changing its result contract", async () => {
		const { ctx, shutdown, tools } = harness(50);
		try {
			const result = await tools.get("bash").execute("call-auto", { command: "sleep 30" }, undefined, undefined, ctx);
			expect(result.content[0].text).toContain("Command moved to background: bash-");
			const listed = await tools.get("bash_jobs").execute("call-auto-list", {});
			expect(listed.details.jobs).toHaveLength(1);
			expect(listed.details.jobs[0]).toMatchObject({ id: "bash-1", status: "running", title: "sleep 30" });
		} finally {
			await shutdown();
		}
	});

	it("preserves an explicit title when a foreground process detaches", async () => {
		const { ctx, shortcuts, shutdown, tools } = harness();
		try {
			const running = tools.get("bash").execute(
				"call-title",
				{ command: "printf 'ready\\n'; sleep 1", title: "Dev server" },
				undefined,
				undefined,
				ctx,
			);
			await new Promise((resolve) => setTimeout(resolve, 100));
			shortcuts.get("ctrl+b")?.(ctx);
			await running;
			const listed = await tools.get("bash_jobs").execute("call-title-list", {});
			expect(listed.details.jobs[0]).toMatchObject({ id: "bash-1", title: "Dev server" });
		} finally {
			await shutdown();
		}
	});

	it("uses a sanitized normalized command fallback and enforces title length", async () => {
		const { ctx, shutdown, tools } = harness();
		try {
			await tools.get("bash").execute(
				"call-fallback",
				{ command: "printf   '\\033[31mok\\033[0m\\n'", run_in_background: true },
				undefined,
				undefined,
				ctx,
			);
			const listed = await tools.get("bash_jobs").execute("call-fallback-list", {});
			expect(listed.details.jobs[0].title).toBe("printf '\\033[31mok\\033[0m\\n'");
			expect(listed.details.jobs[0].title.length).toBeLessThanOrEqual(80);
			await tools.get("bash").execute(
				"call-long-command",
				{ command: `printf '${"x".repeat(100)}'`, run_in_background: true },
				undefined,
				undefined,
				ctx,
			);
			const withLongCommand = await tools.get("bash_jobs").execute("call-long-command-list", {});
			expect(withLongCommand.details.jobs[1].title).toHaveLength(80);
			await expect(tools.get("bash").execute(
				"call-long-title",
				{ command: "printf nope", title: "x".repeat(81), run_in_background: true },
				undefined,
				undefined,
				ctx,
			)).rejects.toThrow("at most 80");
		} finally {
			await shutdown();
		}
	});

	it("sanitizes terminal and bidi controls from model-facing output", async () => {
		const { ctx, shutdown, tools } = harness();
		try {
			const started = await tools.get("bash").execute(
				"call-safe-output",
				{ command: `node -e "process.stdout.write('\\x1b[31mred\\x1b[0m\\u202e')"`, run_in_background: true },
				undefined,
				undefined,
				ctx,
			);
			const result = await waitFor(
				() => tools.get("bash_output").execute("call-safe-read", { job_id: started.details.backgroundJobId }),
				(value) => value.details.status !== "running",
				"safe task output",
			);
			expect(result.content[0].text).toContain("red");
			expect(result.content[0].text).not.toMatch(/[\u001b\u202e]/);
		} finally {
			await shutdown();
		}
	});

	it("preserves the bash_stop result contract", async () => {
		const { ctx, shutdown, tools } = harness();
		try {
			const started = await tools.get("bash").execute(
				"call-stop-contract",
				{ command: "sleep 30", run_in_background: true },
				undefined,
				undefined,
				ctx,
			);
			const stopped = await tools.get("bash_stop").execute("call-stop-contract-result", { job_id: started.details.backgroundJobId });
			expect(stopped.content[0].text).toContain(`${started.details.backgroundJobId}: stopped`);
			expect(stopped.details).toMatchObject({ jobId: started.details.backgroundJobId, status: "stopped" });
		} finally {
			await shutdown();
		}
	});

	it("uses the shared termination flow for timeouts", async () => {
		const { ctx, shutdown, tools } = harness();
		try {
			const started = await tools.get("bash").execute(
				"call-timeout",
				{ command: "sleep 30", timeout: 0.05, run_in_background: true },
				undefined,
				undefined,
				ctx,
			);
			const jobs = await waitFor(
				async () => (await tools.get("bash_jobs").execute("call-timeout-list", {})).details.jobs,
				(value) => value[0]?.status === "timed_out",
				"timed out task",
			);
			expect(jobs[0].id).toBe(started.details.backgroundJobId);
		} finally {
			await shutdown();
		}
	});

	it("stops a running task but retains it until a separate clear", async () => {
		const { commands, ctx, shutdown, tools } = harness();
		let viewer: BackgroundTaskViewer | undefined;
		try {
			const started = await tools.get("bash").execute("call-stop", { command: "sleep 30", run_in_background: true }, undefined, undefined, ctx);
			ctx.ui.custom = async (factory: any) => {
				viewer = factory({ requestRender: () => {} }, testTheme(), undefined, () => {});
			};
			await commands.get("tasks").handler("", ctx);
			viewer!.handleInput("c");
			viewer!.handleInput("c");
			expect((await tools.get("bash_jobs").execute("call-still-running", {})).details.jobs).toHaveLength(1);
			viewer!.handleInput("x");
			expect(viewer!.render(100).join("\n")).toContain("Press x again to stop");
			viewer!.handleInput("x");
			const stopped = await waitFor(
				async () => (await tools.get("bash_jobs").execute("call-stopped", {})).details.jobs,
				(jobs) => jobs.length === 1 && jobs[0].status === "stopped",
				"retained stopped task",
			);
			expect(stopped[0].id).toBe(started.details.backgroundJobId);
			expect(await exists(stopped[0].outputPath)).toBe(true);

			viewer!.handleInput("c");
			expect(viewer!.render(100).join("\n")).toContain("Press c again to clear");
			viewer!.handleInput("c");
			await waitFor(
				async () => (await tools.get("bash_jobs").execute("call-cleared", {})).details.jobs.length,
				(length) => length === 0,
				"cleared task",
			);
			expect(await exists(stopped[0].outputPath)).toBe(false);
		} finally {
			viewer?.dispose();
			await shutdown();
		}
	});

	it("clears all finished tasks with a confirmed C C action", async () => {
		const { commands, ctx, shutdown, tools } = harness();
		let viewer: BackgroundTaskViewer | undefined;
		try {
			await Promise.all([1, 2].map((number) => tools.get("bash").execute(
				`call-finished-${number}`,
				{ command: `printf '${number}\\n'`, run_in_background: true },
				undefined,
				undefined,
				ctx,
			)));
			await waitFor(
				async () => (await tools.get("bash_jobs").execute("call-finished-list", {})).details.jobs,
				(jobs) => jobs.length === 2 && jobs.every((job: any) => job.status !== "running"),
				"finished tasks",
			);
			ctx.ui.custom = async (factory: any) => {
				viewer = factory({ requestRender: () => {} }, testTheme(), undefined, () => {});
			};
			await commands.get("tasks").handler("", ctx);
			viewer!.handleInput("C");
			expect(viewer!.render(100).join("\n")).toContain("Press C again to clear all finished");
			viewer!.handleInput("C");
			await waitFor(
				async () => (await tools.get("bash_jobs").execute("call-empty-list", {})).details.jobs.length,
				(length) => length === 0,
				"clear all",
			);
		} finally {
			viewer?.dispose();
			await shutdown();
		}
	});

	it("isolates failing listeners and completion callbacks from task settlement", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-background-callback-test-"));
		const manager = new BackgroundBashManager(process.cwd(), () => {
			throw new Error("notification failed");
		}, 60_000, () => {
			throw new Error("running-count failed");
		}, { tempDirectory: root });
		manager.on("output", () => {
			throw new Error("listener failed");
		});
		try {
			const job: any = await manager.start("printf 'done\\n'", undefined, harness().ctx);
			await expect(job.finished).resolves.toBeUndefined();
			expect(job.status).toBe("exited");
		} finally {
			await manager.stopAll();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("emits manager list and output events with removable listeners", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-background-events-test-"));
		const manager = new BackgroundBashManager(process.cwd(), undefined, 60_000, undefined, { tempDirectory: root });
		const listEvents: Array<string | undefined> = [];
		const outputEvents: Array<string | undefined> = [];
		const offList = manager.on("list", (id) => listEvents.push(id));
		const offOutput = manager.on("output", (id) => outputEvents.push(id));
		try {
			const job: any = await manager.start("printf 'event\\n'", undefined, harness().ctx);
			await job.finished;
			expect(listEvents.filter((id) => id === job.id).length).toBeGreaterThanOrEqual(2);
			expect(outputEvents).toContain(job.id);
			offList();
			offOutput();
			const listCount = listEvents.length;
			await manager.clear(job.id);
			expect(listEvents).toHaveLength(listCount);
		} finally {
			offList();
			offOutput();
			await manager.stopAll();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("settles after a parent exits even when a quiet descendant inherits its output pipe", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-background-inherited-pipe-test-"));
		const manager = new BackgroundBashManager(process.cwd(), undefined, 60_000, undefined, { tempDirectory: root });
		try {
			const startedAt = Date.now();
			const command = `node -e "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},1000)'],{detached:true,stdio:['ignore','inherit','inherit']}).unref()"`;
			const result = await manager.runForeground(command, undefined, process.env, undefined, () => {});
			expect(result.exitCode).toBe(0);
			expect(Date.now() - startedAt).toBeLessThan(900);
		} finally {
			await manager.stopAll();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("shares concurrent stop requests and confirms settlement", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-background-stop-test-"));
		const manager = new BackgroundBashManager(process.cwd(), undefined, 60_000, undefined, { tempDirectory: root });
		try {
			const job: any = await manager.start("sleep 30", undefined, harness().ctx);
			await Promise.all([manager.stop(job), manager.stop(job)]);
			expect(job.status).toBe("stopped");
			await job.settled;
		} finally {
			await manager.stopAll();
			await rm(root, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32")("force-kills descendants that ignore graceful termination", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-background-tree-test-"));
		const manager = new BackgroundBashManager(process.cwd(), undefined, 60_000, undefined, { tempDirectory: root });
		try {
			const job: any = await manager.start("sh -c 'trap \"\" TERM; sleep 30' & wait", undefined, harness().ctx);
			await manager.stop(job);
			expect(() => process.kill(-job.pid, 0)).toThrow();
		} finally {
			await manager.stopAll();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("caps retained output, reports dropped bytes, and keeps the recent tail", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-background-cap-test-"));
		const manager = new BackgroundBashManager(process.cwd(), undefined, 60_000, undefined, {
			maxLogBytes: 64,
			tempDirectory: root,
		});
		try {
			const job: any = await manager.start("node -e \"process.stdout.write('x'.repeat(256) + 'FINAL')\"", undefined, harness().ctx);
			await job.finished;
			expect(job.status).toBe("exited");
			expect(job.exitCode).toBe(0);
			expect(job.droppedBytes).toBeGreaterThan(0);
			expect((await stat(job.outputPath)).size).toBeLessThanOrEqual(64);
			expect(await readFile(job.outputPath, "utf8")).toContain("log limit reached");
			expect(manager.output(job)).toContain("FINAL");
			expect(manager.output(job)).toContain("[Output cap reached; dropped");
		} finally {
			await manager.stopAll();
			expect(await readdir(root)).toEqual([]);
			await rm(root, { recursive: true, force: true });
		}
	});

	it("evicts old finished jobs and removes all retained directories on shutdown", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-background-retention-test-"));
		const manager = new BackgroundBashManager(process.cwd(), undefined, 60_000, undefined, {
			maxFinishedJobs: 1,
			tempDirectory: root,
		});
		try {
			const first: any = await manager.start("printf 'first\\n'", undefined, harness().ctx);
			await first.finished;
			const second: any = await manager.start("printf 'second\\n'", undefined, harness().ctx);
			await second.finished;
			expect(manager.list().map((job: any) => job.id)).toEqual([second.id]);
			expect(await exists(first.directory)).toBe(false);
			expect(await exists(second.directory)).toBe(true);
			await manager.stopAll();
			expect(await readdir(root)).toEqual([]);
		} finally {
			await manager.stopAll();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("cleans up foreground-only job directories after settlement", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-foreground-cleanup-test-"));
		const manager = new BackgroundBashManager(process.cwd(), undefined, 60_000, undefined, { tempDirectory: root });
		try {
			const result = await manager.runForeground("printf 'done\\n'", undefined, process.env, undefined, () => {});
			expect(result.exitCode).toBe(0);
			expect(await readdir(root)).toEqual([]);
		} finally {
			await manager.stopAll();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("notifies the main agent and clears the running count when a background process finishes", async () => {
		const { backgroundCounts, ctx, notifications, shutdown, tools } = harness();
		try {
			await tools.get("bash").execute(
				"call-notify",
				{ command: "printf '\\144\\157\\156\\145\\n'", run_in_background: true },
				undefined,
				undefined,
				ctx,
			);
			await waitFor(() => notifications[0]?.message.content ?? "", (value) => /Background task .* finished/.test(value), "completion notification");
			expect(notifications[0].message.content).not.toContain("\ndone\n");
			expect(notifications[0].message.content).toContain("Output remains in temporary file:");
			expect(notifications[0].options).toEqual({ deliverAs: "followUp", triggerTurn: true });
			expect(backgroundCounts.at(-1)).toBe(0);
		} finally {
			await shutdown();
		}
	});
});
