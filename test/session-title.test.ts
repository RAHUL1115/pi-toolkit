import { beforeEach, describe, expect, it, vi } from "vitest";
import registerAutomaticSessionTitles, {
	LITE_MODEL_ID,
	LITE_MODEL_PROVIDER,
	cleanSessionTitle,
	registerLiteVirtualModel,
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
			find: vi.fn(() => undefined),
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

	it.each([
		["gpt-5.6-luna", "gpt-6-luna"],
		["gpt-5.9-mini", "gpt-5.10-mini"],
		["claude-3-5-haiku-20241022", "claude-haiku-4-5"],
		["gemini-2.5-flash", "gemini-3-flash"],
		["model-1-lite", "model-2-lite"],
		["model-1-small", "model-2-small"],
	])("prefers the highest numeric version: %s → %s", (older, newer) => {
		for (const ids of [[older, newer], [newer, older]]) {
			expect(selectLiteModel(ids.map(model))?.id).toBe(newer);
		}
	});

	it("preserves family priority over version and ignores virtual models", () => {
		expect(selectLiteModel([
			model("gpt-10-mini"),
			model("gpt-5.6-luna"),
			{ ...model("gpt-99-luna"), api: "pi-virtual" },
		])?.id).toBe("gpt-5.6-luna");
	});

	it("uses display-name versions when the ID has no version and keeps ties stable", () => {
		const older = { ...model("old-luna"), name: "GPT 5.6 Luna" };
		const newer = { ...model("new-luna"), name: "GPT 6 Luna" };
		expect(selectLiteModel([older, newer])).toBe(newer);
		const first = model("gpt-6-luna");
		expect(selectLiteModel([first, { ...first, provider: "other" }])).toBe(first);
		expect(selectLiteModel([model("luna"), newer])).toBe(newer);
	});

	it("registers a lite virtual model that routes to a physical lite model", async () => {
		const registerVirtualModel = vi.fn();
		registerLiteVirtualModel({ registerVirtualModel } as any);

		const definition = registerVirtualModel.mock.calls[0]?.[0];
		expect(definition.provider).toBe(LITE_MODEL_PROVIDER);
		expect(definition.id).toBe(LITE_MODEL_ID);
		expect(await Promise.resolve(definition.route(
			{ reason: "user", thinkingLevel: "low" },
			{ modelRegistry: { getAvailable: () => [model("gpt-5.4-mini"), model("gpt-5.6-luna"), model("gpt-6-luna")] } },
		))).toMatchObject({ model: { id: "gpt-6-luna" }, thinkingLevel: "low" });
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

	it("prefers the registered lite virtual model for titles", async () => {
		const { ctx, complete, handlers } = harness();
		ctx.modelRegistry.find.mockReturnValue(model("lite"));
		complete.mockResolvedValue({ content: [{ type: "text", text: "Virtual title" }] });

		await handlers.get("session_start")?.({}, ctx);
		handlers.get("agent_end")?.(turn("use virtual lite"), ctx);
		await flushTitle();

		expect(ctx.modelRegistry.find).toHaveBeenCalledWith(LITE_MODEL_PROVIDER, LITE_MODEL_ID);
		expect(complete.mock.calls[0]?.[0].id).toBe("lite");
		expect(ctx.modelRegistry.getAvailable).not.toHaveBeenCalled();
	});

	it("respects scoped models", async () => {
		const { ctx, complete, handlers } = harness();
		ctx.scopedModels = [
			{ model: model("claude-3-5-haiku") },
			{ model: model("claude-haiku-4-5") },
		];
		complete.mockResolvedValue({ content: [{ type: "text", text: "Scoped title" }] });

		await handlers.get("session_start")?.({}, ctx);
		handlers.get("agent_end")?.(turn("use scoped models"), ctx);
		await flushTitle();

		expect(complete.mock.calls[0]?.[0].id).toBe("claude-haiku-4-5");
		expect(ctx.modelRegistry.find).not.toHaveBeenCalled();
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
