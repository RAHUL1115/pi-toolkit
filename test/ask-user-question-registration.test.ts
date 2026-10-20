import type { ExtensionAPI, ExtensionToolContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getKeybindings, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import register from "../pi-toolkit-lib/ask-user-question/register.ts";
import { InputSchema, type Result, ResultSchema } from "../pi-toolkit-lib/ask-user-question/schema.ts";

const q = { question: "Choose", header: "Choice", multiSelect: false, options: [{ label: "A" }, { label: "B" }] };
const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s } as Theme;
function tool() {
  let definition: ToolDefinition<typeof InputSchema, Result> | undefined;
  register({ registerTool: (value: typeof definition) => { definition = value; }, setActiveTools() {}, getActiveTools: () => ["ask_user_question"] } as unknown as ExtensionAPI);
  return definition!;
}

function renderResult(details: Result, expanded = false, width = 200) {
  return tool().renderResult!(
    { content: [], details }, { expanded, isPartial: false }, theme,
  ).render(width).map(line => line.trimEnd());
}

describe("ask user completed summary", () => {
  it("shows full questions and selected answers in a compact tree", () => {
    const second = { ...q, question: "Which entries should it include?", header: "Entries" };
    expect(renderResult({
      questions: [q, second],
      answers: { Choose: "A", [second.question]: "Primary + addons (Recommended)" },
      answerDetails: [], cancelled: false,
    })).toEqual([
      "User answered the questions:",
      "└ · Choose → A",
      "  · Which entries should it include? → Primary + addons (Recommended)",
    ]);
  });

  it("retains notes and unanswered questions, including legacy results", () => {
    const details: Result = {
      questions: [q], answers: {}, cancelled: false,
      answerDetails: [{ questionIndex: 0, kind: "option", selectedLabels: [], note: "Context" }],
      globalNote: "Overall context",
    };
    expect(renderResult(details)).toEqual([
      "User answered the questions:", "└ · Choose → (no answer)",
      "    Note: Context", "  Global note: Overall context",
    ]);
    const { answerDetails: _unused, ...legacy } = details;
    expect(renderResult(legacy as Result)).toContain("└ · Choose → (no answer)");
  });

  it("summarizes multiline answers without losing their tail and expands them fully", () => {
    const details: Result = {
      questions: [q], answers: { Choose: "First\nSecond" }, answerDetails: [], cancelled: false,
    };
    expect(renderResult(details)).toContain("└ · Choose → First Second");
    expect(renderResult(details, true).join("\n")).toContain("First\nSecond");
    for (const expanded of [false, true]) {
      for (const line of renderResult(details, expanded, 16)) {
        expect(line).not.toMatch(/[\r\n]/);
        expect(visibleWidth(line)).toBeLessThanOrEqual(16);
      }
    }
  });

  it("keeps cancellation and errors separate from answered summaries", () => {
    const details: Result = { questions: [q], answers: {}, answerDetails: [], cancelled: true };
    expect(renderResult(details)).toEqual(["Cancelled"]);
    expect(renderResult({ ...details, cancelled: false, error: "Invalid question" })).toEqual(["Invalid question"]);
  });
});

describe("ask user structured registration", () => {
  it("declares output schema and returns matching details/structuredContent with notes", async () => {
    const definition = tool();
    expect(definition.outputSchema).toBe(ResultSchema);
    const ctx = { mode: "tui", ui: { custom: (factory: Parameters<ExtensionToolContext["ui"]["custom"]>[0]) => new Promise(resolve => {
      const c = factory({ requestRender() {}, terminal: { rows: 24, columns: 80 } } as TUI, theme, getKeybindings(), resolve);
      c.handleInput?.("n"); c.handleInput?.("note"); c.handleInput?.("\r"); c.handleInput?.("\r");
    }) } } as unknown as ExtensionToolContext;
    const result = await definition.execute("id", { questions: [q] }, undefined, undefined, ctx);
    expect(result.structuredContent).toEqual(result.details);
    expect(Check(ResultSchema, result.structuredContent)).toBe(true);
    expect(result.details.answerDetails).toEqual([{ questionIndex: 0, kind: "option", selectedLabels: ["A"], note: "note" }]);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Note for") });
  });

  it("marks validation and no-UI failures as errors, not user cancellation", async () => {
    const definition = tool();
    for (const questions of [[q, q], [q]]) {
      const result = await definition.execute("id", { questions }, undefined, undefined, { mode: "json" } as ExtensionToolContext);
      expect(result.isError).toBe(true);
      expect(result.details.cancelled).toBe(false);
      expect(result.details.error).toBeTruthy();
      expect(result.structuredContent).toEqual(result.details);
      expect(Check(ResultSchema, result.structuredContent)).toBe(true);
    }
  });

  it("returns a structured empty cancellation result", async () => {
    const result = await tool().execute("id", { questions: [q] }, undefined, undefined, { mode: "tui", ui: { custom: async () => null } } as unknown as ExtensionToolContext);
    expect(result.details.cancelled).toBe(true);
    expect(result.details.answerDetails).toEqual([]);
    expect(result.structuredContent).toEqual(result.details);
    expect(Check(ResultSchema, result.structuredContent)).toBe(true);
  });
});
