import { describe, expect, it, vi } from "vitest";
import registerCompactContext from "../pi-toolkit-lib/compact-context.ts";

function harness(userText = "please use compact_context now") {
	const commands = new Map<string, any>();
	let tool: any;
	const sendUserMessage = vi.fn();
	const pi = {
		registerCommand: vi.fn((name: string, definition: any) => commands.set(name, definition)),
		registerTool: vi.fn((definition: any) => { tool = definition; }),
		sendUserMessage,
	} as any;
	const messages: any[] = [{ role: "user", content: [{ type: "text", text: userText }] }];
	const ctx = {
		sessionManager: { buildSessionContext: () => ({ messages }) },
	} as any;
	registerCompactContext(pi);
	return { commands, ctx, getTool: () => tool, messages, sendUserMessage };
}

describe("compact_context", () => {
	it("queues the internal command only after an exact-name request", async () => {
		const { ctx, getTool, sendUserMessage } = harness();
		const result = await getTool().execute("call-1", { next_prompt: "continue" }, undefined, undefined, ctx);

		expect(result.terminate).toBe(true);
		expect(sendUserMessage).toHaveBeenCalledWith(expect.stringMatching(/^\/ptk-compact-context /), {
			deliverAs: "followUp",
			expandPromptTemplates: true,
		});
	});

	it("rejects proactive invocation", async () => {
		const { ctx, getTool, sendUserMessage } = harness("please reduce the context");
		await expect(getTool().execute("call-1", {}, undefined, undefined, ctx)).rejects.toThrow("exact name");
		expect(sendUserMessage).not.toHaveBeenCalled();
	});

	it("uses Pi compaction defaults and starts a fresh hidden-context session", async () => {
		const { commands, ctx, getTool, sendUserMessage } = harness();
		await getTool().execute("call-1", { next_prompt: "continue the work" }, undefined, undefined, ctx);
		const payload = sendUserMessage.mock.calls[0]![0].split(" ")[1]!;
		const appendCustomMessageEntry = vi.fn();
		const submitNextPrompt = vi.fn();
		const newSession = vi.fn(async (options: any) => {
			await options.setup({ appendCustomMessageEntry });
			await options.withSession({ sendUserMessage: submitNextPrompt, ui: { notify: vi.fn() } });
			return { cancelled: false };
		});
		const compact = vi.fn((options: any) => options.onComplete({ summary: "summary", firstKeptEntryId: "kept", tokensBefore: 123 }));
		const commandCtx = {
			waitForIdle: vi.fn(),
			compact,
			newSession,
			ui: { notify: vi.fn() },
			sessionManager: {
				getSessionFile: () => "old-session.jsonl",
				buildSessionContext: () => ({ messages: [
					{ role: "compactionSummary", summary: "summary", tokensBefore: 123, timestamp: Date.now() },
					{ role: "user", content: [{ type: "text", text: "recent work" }], timestamp: Date.now() },
				] }),
			},
		} as any;

		await commands.get("ptk-compact-context").handler(payload, commandCtx);

		expect(compact.mock.calls[0]![0].customInstructions).toBeUndefined();
		expect(newSession.mock.calls[0]![0].parentSession).toBe("old-session.jsonl");
		expect(appendCustomMessageEntry).toHaveBeenCalledWith(
			"pi-toolkit:compact-context",
			expect.stringContaining("recent work"),
			false,
			{ tokensBefore: 123 },
		);
		expect(submitNextPrompt).toHaveBeenCalledWith("continue the work");
	});
});
