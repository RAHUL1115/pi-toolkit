import type { ExtensionAPI, ExtensionToolContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getKeybindings, type TUI } from "@earendil-works/pi-tui";
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
