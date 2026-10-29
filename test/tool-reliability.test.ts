import type { BeforeAgentStartEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import registerToolReliability, { TOOL_RELIABILITY_POLICY, TOOL_RELIABILITY_SECTION } from "../pi-toolkit-lib/tool-reliability.js";

function harness() {
	let handler!: (event: BeforeAgentStartEvent) => { systemPrompt: string } | undefined;
	const pi = {
		on(name: string, callback: typeof handler) {
			expect(name).toBe("before_agent_start");
			handler = callback;
		},
	} as unknown as ExtensionAPI;
	registerToolReliability(pi);
	return (event: BeforeAgentStartEvent) => handler(event);
}

function event(forced = false, messageType = "user"): BeforeAgentStartEvent {
	return {
		messageType,
		systemPrompt: "Existing instructions",
		systemPromptOptions: {
			sections: { existing: "Keep this section" },
			...(forced ? { forceSystemPrompt: "Existing instructions" } : {}),
		},
	} as BeforeAgentStartEvent;
}

describe("tool reliability prompt policy", () => {
	it.each(["user", "custom"])("adds a stable named section on %s turns without forcing the prompt", (messageType) => {
		const run = harness();
		const input = event(false, messageType);
		expect(run(input)).toBeUndefined();
		expect(input.systemPromptOptions.sections).toEqual({
			existing: "Keep this section",
			[TOOL_RELIABILITY_SECTION]: TOOL_RELIABILITY_POLICY,
		});
		expect(input.systemPromptOptions.forceSystemPrompt).toBeUndefined();
		const before = JSON.stringify(input.systemPromptOptions);
		expect(run(input)).toBeUndefined();
		expect(JSON.stringify(input.systemPromptOptions)).toBe(before);
	});

	it.each(["user", "custom"])("appends once to an opaque prompt on %s turns", (messageType) => {
		const run = harness();
		const input = event(true, messageType);
		const result = run(input);
		expect(result).toEqual({ systemPrompt: `Existing instructions\n\n${TOOL_RELIABILITY_POLICY}` });
		input.systemPrompt = result!.systemPrompt;
		input.systemPromptOptions.forceSystemPrompt = result!.systemPrompt;
		expect(run(input)).toBeUndefined();
		expect(input.systemPromptOptions.sections).toEqual({ existing: "Keep this section" });
	});

	it("covers recurring failures and preserves safe, evidence-based recovery", () => {
		for (const topic of ["Paths:", "Arguments:", "Edits:", "Recovery:", "Dependencies:", "Long-running commands:", "Nested calls:", "Verification:"]) {
			expect(TOOL_RELIABILITY_POLICY).toContain(topic);
		}
		expect(TOOL_RELIABILITY_POLICY).toContain("keep retries bounded");
		expect(TOOL_RELIABILITY_POLICY).toContain("Preserve unrelated user changes");
		expect(TOOL_RELIABILITY_POLICY).toContain("already took effect");
		expect(TOOL_RELIABILITY_POLICY).toContain("checks not run");
	});
});
