import { initTheme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerUnifiedSubagents as subagentsExtension } from "../../pi-toolkit-lib/unified-subagents/index.js";

initTheme("dark", false);

function resultTool() {
  const tools = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    on: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  subagentsExtension(pi);
  return tools.get("get_subagent_result");
}

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

function render(tool: any, text: string, expanded: boolean): string {
  return tool.renderResult(
    { content: [{ type: "text", text }] },
    { expanded, isPartial: false },
    theme,
    {},
  ).render(120).map((line: string) => line.trimEnd()).join("\n");
}

describe("get_subagent_result rendering", () => {
  it("compacts long output until tool results are expanded", () => {
    const text = Array.from({ length: 30 }, (_, index) => `result line ${index + 1}`).join("\n");
    const collapsed = render(resultTool(), text, false);
    const expanded = render(resultTool(), text, true);

    expect(collapsed).toContain("result line 1");
    expect(collapsed).not.toContain("result line 30");
    expect(collapsed).toContain("to expand");
    expect(expanded).toBe(text);
  });

  it("compacts a long single line", () => {
    const text = `start ${"x".repeat(1500)} end`;
    const collapsed = render(resultTool(), text, false);

    expect(collapsed).not.toContain(" end");
    expect(collapsed).toContain("to expand");
    expect(render(resultTool(), text, true)).toContain(" end");
  });

  it("leaves short output unchanged", () => {
    const text = "Agent: abc\nStatus: completed\n\nDone.";
    expect(render(resultTool(), text, false)).toBe(text);
  });
});
