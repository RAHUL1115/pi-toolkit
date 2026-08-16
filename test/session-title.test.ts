import { beforeEach, describe, expect, it, vi } from "vitest";
import registerAutomaticSessionTitles, {
	cleanSessionTitle,
	selectLiteModel,
	titleTranscript,
} from "../pi-toolkit-lib/session-title.ts";

const model = (id: string) => ({ id, name: id, provider: "test", api: "openai-responses" }) as any;

function harness() {
	const handlers = new Map<string, (...args: any[]) => unknown>();
	const entries: any[] = [];
	let name: string | undefined;
	const complete = vi.fn();
	const pi = {
		on: vi.fn((event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler)),
		getSessionName: vi.fn(() => name),
		setSessionName: vi.fn((next: string) => { name = next; }),
		appendEntry: vi.fn((customType: string, data: unknown) => entries.push({ type: "custom", customType, data })),
	} as any;
	const ctx = {
		scopedModels: [],
		modelRegistry: {
			getAvailable: vi.fn(() => [model("gpt-5.4-mini"), model("gpt-5.6-luna")]),
			complete,
		},
		sessionManager: {
			getSessionId: vi.fn(() => "session-1"),
			getEntries: vi.fn(() => entries),
		},
	} as any;

	registerAutomaticSessionTitles(pi);
	return { pi, ctx, complete, entries, handlers, getName: () => name, setName: (next: string) => { name = next; } };
}

async function flushTitle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

const turn = (text: string) => ({
	messages: [
		{ role: "user", content: text },
		{ role: "assistant", content: [{ type: "text", text: "Working on it" }] },
	],
});

describe("automatic session titles", () => {
	beforeEach(() => vi.clearAllMocks());

	it("recognizes and prefers Luna as a lite model", () => {
		expect(selectLiteModel([model("gpt-5.4-mini"), model("gpt-5.6-luna")])?.id).toBe("gpt-5.6-luna");
	});

	it("builds and cleans bounded title text", () => {
		expect(titleTranscript([{ role: "toolResult", content: "ignore" }, { role: "user", content: "  fix   auth  " }])).toBe("user: fix auth");
		expect(cleanSessionTitle('"Title: Fix authentication flow."\nextra')).toBe("Fix authentication flow");
	});

	it("refreshes its generated title after every turn", async () => {
		const { pi, ctx, complete, handlers, getName } = harness();
		complete
			.mockResolvedValueOnce({ content: [{ type: "text", text: "First session title" }] })
			.mockResolvedValueOnce({ content: [{ type: "text", text: "Updated session title" }] });

		await handlers.get("session_start")?.({}, ctx);
		handlers.get("agent_end")?.(turn("add session titles"), ctx);
		await flushTitle();
		expect(getName()).toBe("First session title");

		handlers.get("agent_end")?.(turn("refresh the title"), ctx);
		await flushTitle();
		expect(getName()).toBe("Updated session title");
		expect(complete).toHaveBeenCalledTimes(2);
		expect(complete.mock.calls[0]?.[0].id).toBe("gpt-5.6-luna");
		expect(pi.appendEntry).toHaveBeenCalledTimes(2);
	});

	it("respects scoped models", async () => {
		const { ctx, complete, handlers } = harness();
		ctx.scopedModels = [{ model: model("claude-haiku-4-5") }];
		complete.mockResolvedValue({ content: [{ type: "text", text: "Scoped title" }] });

		await handlers.get("session_start")?.({}, ctx);
		handlers.get("agent_end")?.(turn("use scoped models"), ctx);
		await flushTitle();

		expect(complete.mock.calls[0]?.[0].id).toBe("claude-haiku-4-5");
		expect(ctx.modelRegistry.getAvailable).not.toHaveBeenCalled();
	});

	it("continues refreshing generated titles after resume", async () => {
		const { ctx, complete, entries, handlers, getName, setName } = harness();
		setName("Previous generated title");
		entries.push({ type: "custom", customType: "pi-toolkit:auto-title", data: { name: "Previous generated title" } });
		complete.mockResolvedValue({ content: [{ type: "text", text: "Resumed generated title" }] });

		await handlers.get("session_start")?.({}, ctx);
		handlers.get("agent_end")?.(turn("continue after resume"), ctx);
		await flushTitle();

		expect(getName()).toBe("Resumed generated title");
	});

	it("keeps model failures out of the main turn", async () => {
		const { pi, ctx, complete, handlers } = harness();
		complete.mockImplementation(() => { throw new Error("offline"); });

		await handlers.get("session_start")?.({}, ctx);
		expect(() => handlers.get("agent_end")?.(turn("keep working"), ctx)).not.toThrow();
		await flushTitle();

		expect(pi.setSessionName).not.toHaveBeenCalled();
	});

	it("does not overwrite a manual session name", async () => {
		const { pi, ctx, complete, handlers, setName } = harness();
		complete.mockResolvedValue({ content: [{ type: "text", text: "Generated title" }] });

		await handlers.get("session_start")?.({}, ctx);
		handlers.get("agent_end")?.(turn("first turn"), ctx);
		await flushTitle();

		setName("My manual name");
		handlers.get("agent_end")?.(turn("second turn"), ctx);
		await flushTitle();

		expect(pi.setSessionName).toHaveBeenCalledTimes(1);
		expect(complete).toHaveBeenCalledTimes(1);
	});
});
