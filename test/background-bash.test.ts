import { describe, expect, it } from "vitest";
import { BackgroundBashManager, registerBackgroundBash } from "../pi-toolkit-lib/background-bash.ts";
import { builtinRenderers } from "../pi-toolkit-lib/lib/footer-engine/segments.ts";

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

async function waitFor(check: () => Promise<string>, expected: RegExp): Promise<string> {
	const deadline = Date.now() + 3000;
	let value = "";
	do {
		value = await check();
		if (expected.test(value)) return value;
		await new Promise((resolve) => setTimeout(resolve, 25));
	} while (Date.now() < deadline);
	throw new Error(`Timed out waiting for ${expected}: ${value}`);
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
		const theme = { fg: (_color: string, text: string) => text };
		expect(builtinRenderers.backgroundShells!({ backgroundShells: 2, theme } as any)).toBe("bg tasks:2");
		expect(builtinRenderers.backgroundShells!({ backgroundShells: 0, theme } as any)).toBe("");
	});

	it("preserves normal foreground execution", async () => {
		const { ctx, shutdown, tools } = harness();
		try {
			const result = await tools.get("bash").execute("call-1", { command: "printf 'foreground\\n'" }, undefined, undefined, ctx);
			expect(result.content[0].text).toContain("foreground");
		} finally {
			await shutdown();
		}
	});

	it("moves a running foreground process to the background with Ctrl+B", async () => {
		const { ctx, notifications, shortcuts, shutdown, tools } = harness();
		try {
			const running = tools.get("bash").execute(
				"call-2",
				{ command: "printf 'ready\\n'; sleep 1; printf 'finished\\n'" },
				undefined,
				undefined,
				ctx,
			);
			await new Promise((resolve) => setTimeout(resolve, 100));
			shortcuts.get("ctrl+b")?.(ctx);
			const detached = await running;
			expect(detached.content[0].text).toContain("Command moved to background: bash-");

			const listed = await tools.get("bash_jobs").execute("call-3", {});
			const jobId = listed.details.jobs[0].id;
			expect(jobId).toMatch(/^bash-\d+$/);
			await waitFor(async () => notifications[0]?.message.content ?? "", /Background task .* finished/);
			expect(notifications[0].message.content).toContain(jobId);
			expect(notifications[0].message.content).toContain("Output remains in temporary file:");
		} finally {
			await shutdown();
		}
	});

	it("automatically backgrounds a foreground process after the threshold", async () => {
		const { backgroundCounts, ctx, shutdown, tools } = harness(100);
		try {
			const detached = await tools.get("bash").execute(
				"call-auto",
				{ command: "sleep 30" },
				undefined,
				undefined,
				ctx,
			);
			expect(detached.content[0].text).toContain("Command moved to background: bash-");
			const listed = await tools.get("bash_jobs").execute("call-auto-list", {});
			expect(listed.details.jobs).toHaveLength(1);
			expect(listed.details.jobs[0].status).toBe("running");
			expect(backgroundCounts).toContain(1);
		} finally {
			await shutdown();
		}
	});

	it("shows and deletes background tasks in the /tasks TUI", async () => {
		const { commands, ctx, shutdown, tools } = harness();
		try {
			await tools.get("bash").execute("call-tui", { command: "sleep 30", run_in_background: true }, undefined, undefined, ctx);
			let viewer: any;
			ctx.ui.custom = async (factory: any) => {
				viewer = factory(
					{ terminal: { rows: 12, columns: 80 }, requestRender: () => {} },
					{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
					undefined,
					() => {},
				);
			};

			await commands.get("tasks").handler("", ctx);
			const lines = viewer.render(80);
			expect(lines.join("\n")).toContain("Background tasks");
			expect(lines.join("\n")).toContain("bash-1");
			expect(lines).toHaveLength(7);
			viewer.handleInput("x");
			viewer.handleInput("x");
			await waitFor(async () => (await tools.get("bash_jobs").execute("call-list", {})).details.jobs.length.toString(), /^0$/);
			viewer.dispose();
		} finally {
			await shutdown();
		}
	});

	it("starts, reads, lists, and stops a background process", async () => {
		const { ctx, shutdown, tools } = harness();
		try {
			const started = await tools.get("bash").execute(
				"call-2",
				{ command: "printf 'ready\\n'; sleep 30", run_in_background: true },
				undefined,
				undefined,
				ctx,
			);
			const jobId = started.details.backgroundJobId;
			expect(jobId).toMatch(/^bash-\d+$/);

			const output = await waitFor(async () => {
				const result = await tools.get("bash_output").execute("call-3", { job_id: jobId });
				return result.content[0].text;
			}, /ready/);
			expect(output).toContain(`${jobId}: running`);

			const listed = await tools.get("bash_jobs").execute("call-4", {});
			expect(listed.content[0].text).toContain(jobId);

			const stopped = await tools.get("bash_stop").execute("call-5", { job_id: jobId });
			expect(stopped.content[0].text).toContain(`${jobId}: stopped`);
		} finally {
			await shutdown();
		}
	});

	it("notifies the main agent and clears the running count when a background process finishes", async () => {
		const { backgroundCounts, ctx, notifications, shutdown, tools } = harness();
		try {
			await tools.get("bash").execute(
				"call-6",
				{ command: "printf '\\144\\157\\156\\145\\n'", run_in_background: true },
				undefined,
				undefined,
				ctx,
			);
			await waitFor(async () => notifications[0]?.message.content ?? "", /Background task .* finished/);
			expect(notifications[0].message.content).not.toContain("done");
			expect(notifications[0].message.content).toContain("Output remains in temporary file:");
			expect(notifications[0].options).toEqual({ deliverAs: "followUp", triggerTurn: true });
			expect(backgroundCounts.at(-1)).toBe(0);
		} finally {
			await shutdown();
		}
	});
});
