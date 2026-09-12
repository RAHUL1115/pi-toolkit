import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../../pi-toolkit-lib/unified-subagents/types.js";

// ── Mock wrapTextWithAnsi ──────────────────────────────────────────────
// We need to control what wrapTextWithAnsi returns to simulate the
// upstream bug (returning lines wider than requested width).
// vi.mock is hoisted and intercepts before conversation-viewer.ts binds
// its import.

let wrapOverride: ((text: string, width: number) => string[]) | null = null;
let markdownConstructions = 0;
let markdownRenderCalls = 0;
let markdownThrows = false;

vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
  const original = await importOriginal<typeof import("@earendil-works/pi-tui")>();
  return {
    ...original,
    Markdown: class extends original.Markdown {
      constructor(...args: ConstructorParameters<typeof original.Markdown>) {
        markdownConstructions++;
        super(...args);
      }
      render(width: number): string[] {
        markdownRenderCalls++;
        if (markdownThrows) throw new RangeError("Maximum call stack size exceeded");
        return super.render(width);
      }
    },
    wrapTextWithAnsi: (...args: [string, number]) => {
      if (wrapOverride) return wrapOverride(...args);
      return original.wrapTextWithAnsi(...args);
    },
  };
});

// Must import AFTER vi.mock declaration (vitest hoists vi.mock but the
// dynamic import of the test subject must happen after)
const { visibleWidth } = await import("@earendil-works/pi-tui");
const { ConversationViewer, RESULT_MAX_CHARS } = await import("../../pi-toolkit-lib/unified-subagents/ui/conversation-viewer.js");

// ── Helpers ────────────────────────────────────────────────────────────

function mockTui(rows = 40, columns = 80) {
  return {
    terminal: { rows, columns },
    requestRender: vi.fn(),
  } as any;
}

function mockSession(messages: any[] = []) {
  return {
    messages,
    subscribe: vi.fn(() => vi.fn()),
    dispose: vi.fn(),
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }),
  } as any;
}

function mockRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "test-1",
    type: "general-purpose",
    harness: "pi",
    description: "test agent",
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
    ...overrides,
  } as AgentRecord;
}

function ansiTheme() {
  return {
    fg: (_color: string, text: string) => `\x1b[38;5;240m${text}\x1b[0m`,
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  } as any;
}

function semanticTheme() {
  return {
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    bold: (text: string) => `<bold>${text}</bold>`,
  } as any;
}

function assertAllLinesFit(lines: string[], width: number) {
  for (let i = 0; i < lines.length; i++) {
    const vw = visibleWidth(lines[i]);
    expect(vw, `line ${i} exceeds width (${vw} > ${width}): ${JSON.stringify(lines[i])}`).toBeLessThanOrEqual(width);
  }
}

// ── Tests ──────────────────────────────────────────────────────────────

beforeEach(() => {
  wrapOverride = null;
  markdownConstructions = 0;
  markdownRenderCalls = 0;
  markdownThrows = false;
});

describe("ConversationViewer invocation line", () => {
  /** The `↳` metadata row for a record, or "" when the viewer renders none. */
  function invocationLine(invocation: AgentRecord["invocation"]): string {
    const viewer = new ConversationViewer(
      mockTui(30, 200), mockSession([]), mockRecord({ invocation }), undefined,
      { fg: (_c: string, t: string) => t, bold: (t: string) => t } as any,
      vi.fn(),
    );
    // The row arrives inside the overlay's frame, padded out to the right
    // border; what is under test is the metadata it carries.
    const row = viewer.render(200).find(l => l.includes("↳"));
    return row ? row.slice(row.indexOf("↳")).replace(/\s*│\s*$/, "") : "";
  }

  // The canonical id, not the short label the widget uses: this overlay is
  // opened to inspect one agent and has the width to disambiguate providers.
  it("names the model with its provider", () => {
    expect(invocationLine({
      modelName: "sonnet 4.6",
      modelId: "anthropic/claude-sonnet-4-6",
      thinking: "high",
      maxTurns: 60,
    })).toBe("↳ anthropic/claude-sonnet-4-6 · thinking: high · max turns: 60");
  });

  it("falls back to the short label when no canonical id was captured", () => {
    expect(invocationLine({ modelName: "sonnet 4.6", thinking: "high" }))
      .toBe("↳ sonnet 4.6 · thinking: high");
  });

  it("discloses a model and level the run did not honor", () => {
    expect(invocationLine({
      modelName: "haiku 4.5",
      modelId: "anthropic/claude-haiku-4-5",
      requestedModel: "google/gemini-3-pro",
      thinking: "low",
      requestedThinking: "max",
    })).toBe("↳ anthropic/claude-haiku-4-5 (asked google/gemini-3-pro) · thinking: low (asked max)");
  });

  it("renders no row at all for a record with no invocation", () => {
    expect(invocationLine(undefined)).toBe("");
  });
});

describe("ConversationViewer cost display", () => {
  /** The header line, with a cost of `cost` on the record and showCost `on`. */
  function header(on: boolean, cost: number): string {
    const record = mockRecord({
      lifetimeUsage: { input: 1000, output: 200, cacheWrite: 0, cost },
    } as Partial<AgentRecord>);
    const viewer = new ConversationViewer(
      mockTui(30, 200), mockSession([]), record, undefined,
      { fg: (_c: string, t: string) => t, bold: (t: string) => t } as any,
      vi.fn(), undefined, undefined, undefined, on,
    );
    return viewer.render(200).join("\n");
  }

  it("shows the cost beside the token count when enabled", () => {
    // The viewer opens on finished agents, whose live activity entry is gone —
    // so this reads the record, and would show nothing if it did not.
    const out = header(true, 0.0042);
    expect(out).toContain("1.2k token");
    expect(out).toContain("~$0.0042");
  });

  it("shows no cost when disabled", () => {
    const out = header(false, 0.0042);
    expect(out).toContain("1.2k token");
    expect(out).not.toContain("$");
  });

  it("shows no cost for a model with no pricing data", () => {
    expect(header(true, 0)).not.toContain("$");
  });
});

describe("ConversationViewer", () => {
  it("closes with Ctrl+C when not composing", () => {
    const done = vi.fn();
    const viewer = new ConversationViewer(
      mockTui(), mockSession(), mockRecord(), undefined, ansiTheme(), done,
    );

    viewer.handleInput("\x03");

    expect(done).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith(undefined);
  });

  describe("render width safety", () => {
    const widths = [40, 80, 120, 216];

    it("no line exceeds width with empty messages", () => {
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession([]), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("uses all terminal rows for the viewport and chrome", () => {
      const rows = 30;
      const viewer = new ConversationViewer(
        mockTui(rows, 80), mockSession([]), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      expect(viewer.render(80)).toHaveLength(rows);
    });

    it("identifies Claude through invocation tags without adding Pi noise", () => {
      const claude = new ConversationViewer(
        mockTui(),
        mockSession([]),
        mockRecord({ harness: "claude", invocation: { harness: "claude" } }),
        undefined,
        semanticTheme(),
        vi.fn(),
      ).render(80).join("\n");
      const pi = new ConversationViewer(
        mockTui(),
        mockSession([]),
        mockRecord({ invocation: { harness: "pi" } }),
        undefined,
        semanticTheme(),
        vi.fn(),
      ).render(80).join("\n");

      expect(claude).toContain("claude");
      expect(pi).not.toContain("claude");
      expect(pi).not.toContain("↳ pi");
    });

    it("no line exceeds width with plain text messages", () => {
      const messages = [
        { role: "user", content: "Hello, how are you?" },
        { role: "assistant", content: [{ type: "text", text: "I am fine, thank you for asking." }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("keeps bordered rows exact-width at a double-width truncation boundary", () => {
      const width = 40;
      for (let prefixLength = 0; prefixLength < width; prefixLength++) {
        const viewer = new ConversationViewer(
          mockTui(30, width),
          mockSession([]),
          mockRecord({ description: `${"a".repeat(prefixLength)}界more` }),
          undefined,
          ansiTheme(),
          vi.fn(),
        );

        for (const line of viewer.render(width)) {
          expect(
            visibleWidth(line),
            `prefix ${prefixLength} produced an under-width bordered row: ${JSON.stringify(line)}`,
          ).toBe(width);
        }
      }
    });

    it("no line exceeds width when text is longer than viewport", () => {
      const longLine = "A".repeat(500);
      const messages = [
        { role: "user", content: longLine },
        { role: "assistant", content: [{ type: "text", text: longLine }] },
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: longLine }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with embedded ANSI escape codes in content", () => {
      const ansiText = `\x1b[1mBold heading\x1b[22m and \x1b[31mred text\x1b[0m ${"X".repeat(300)}`;
      const messages = [
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: ansiText }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with long URLs", () => {
      const url = "https://example.com/" + "a/b/c/d/e/".repeat(30) + "?q=" + "x".repeat(100);
      const messages = [
        { role: "assistant", content: [{ type: "text", text: `Check this link: ${url}` }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with wide table-like content", () => {
      const header = "| " + Array.from({ length: 20 }, (_, i) => `Column${i}`).join(" | ") + " |";
      const dataRow = "| " + Array.from({ length: 20 }, () => "value123").join(" | ") + " |";
      const table = [header, dataRow, dataRow, dataRow].join("\n");
      const messages = [
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: table }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with bashExecution messages", () => {
      const messages = [
        {
          role: "bashExecution", command: "cat " + "/very/long/path/".repeat(20) + "file.txt",
          output: "O".repeat(600),
          exitCode: 0, cancelled: false, truncated: false, timestamp: Date.now(),
        },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with running activity indicator", () => {
      const activity = {
        activeTools: new Map([["read", "file.ts"], ["grep", "pattern"]]),
        toolUses: 5, tokens: "10k", responseText: "R".repeat(400),
        session: { getSessionStats: () => ({ tokens: { total: 50000 } }) },
      };
      const messages = [
        { role: "user", content: "do the thing" },
        { role: "assistant", content: [{ type: "text", text: "working on it" }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord({ status: "running" }), activity as any, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with tool calls", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check that." },
            { type: "toolCall", toolUseId: "t1", name: "very_long_tool_name_" + "x".repeat(200), input: {} },
          ],
        },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width at narrow terminal", () => {
      const messages = [
        { role: "user", content: "Hello world, this is a normal sentence." },
        { role: "assistant", content: [{ type: "text", text: "Sure, here's the answer." }] },
      ];
      for (const w of [8, 10, 15, 20]) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with mixed ANSI + unicode content", () => {
      const text = `\x1b[32m✓\x1b[0m Test passed — 日本語テスト ${"あ".repeat(50)} \x1b[33m⚠\x1b[0m`;
      const messages = [
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });
  });

  describe("Markdown rendering", () => {
    const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

    function viewerFor(
      messages: any[],
      mode?: "off" | "assistant" | "all",
      onMode?: (mode: any) => void,
      rows = 200,
    ) {
      return new ConversationViewer(
        mockTui(rows, 80), mockSession(messages), mockRecord({ status: "completed" }), undefined,
        ansiTheme(), vi.fn(), undefined, undefined, undefined, false,
        mode ? () => mode : undefined, onMode,
      );
    }

    const assistant = (text: string) => [{ role: "assistant", content: [{ type: "text", text }] }];
    const result = (text: string) => [{ role: "toolResult", toolUseId: "t1", content: [{ type: "text", text }] }];

    it("renders assistant Markdown by default", () => {
      const out = strip(viewerFor(assistant("# Heading\n\n- first\n- second\n\n**bold**")).render(80).join("\n"));
      expect(out).toContain("Heading");
      expect(out).not.toContain("# Heading");
      expect(out).not.toContain("**bold**");
    });

    it("leaves assistant text verbatim under off", () => {
      const out = strip(viewerFor(assistant("# Heading\n\n**bold**"), "off").render(80).join("\n"));
      expect(out).toContain("# Heading");
      expect(out).toContain("**bold**");
    });

    it("leaves tool results verbatim under the default mode", () => {
      const raw = ["#!/bin/sh", "# section", "3) alpha", "7) beta", "9) gamma", "Section", "---", "next"].join("\n");
      const out = strip(viewerFor(result(raw)).render(80).join("\n"));
      for (const line of raw.split("\n")) expect(out).toContain(line);
    });

    it("renders tool-result Markdown under all without renumbering lists", () => {
      const markdown = strip(viewerFor(result("## ctx_execute\n\n- one\n- two"), "all").render(80).join("\n"));
      expect(markdown).toContain("ctx_execute");
      expect(markdown).not.toContain("## ctx_execute");

      const ordered = strip(viewerFor(result("3) alpha\n7) beta\n9) gamma"), "all").render(80).join("\n"));
      expect(ordered).toContain("3) alpha");
      expect(ordered).not.toContain("4. beta");
    });

    it("m cycles and persists off/assistant/all while updating the footer", () => {
      const onMode = vi.fn();
      const viewer = viewerFor(assistant("# Heading"), "assistant", onMode);
      expect(strip(viewer.render(80).join("\n"))).toContain("m md");

      viewer.handleInput("m");
      expect(onMode).toHaveBeenLastCalledWith("all");
      expect(strip(viewer.render(80).join("\n"))).toContain("m md+");

      viewer.handleInput("m");
      expect(onMode).toHaveBeenLastCalledWith("off");
      const off = strip(viewer.render(80).join("\n"));
      expect(off).toContain("m raw");
      expect(off).toContain("# Heading");

      viewer.handleInput("m");
      expect(onMode).toHaveBeenLastCalledWith("assistant");
    });

    it("m cycles locally without a persist hook and disarms stop", () => {
      const local = viewerFor(assistant("# Heading"), "assistant");
      local.handleInput("m");
      local.handleInput("m");
      expect(strip(local.render(80).join("\n"))).toContain("# Heading");

      const onStop = vi.fn();
      const stoppable = new ConversationViewer(
        mockTui(200, 80), mockSession(assistant("hi")), mockRecord({ status: "running" }), undefined,
        ansiTheme(), vi.fn(), onStop,
      );
      stoppable.handleInput("x");
      stoppable.handleInput("m");
      stoppable.handleInput("x");
      expect(onStop).not.toHaveBeenCalled();
    });

    it("keeps local tool/navigation actions and Markdown mode visible at 80 columns", () => {
      const viewer = new ConversationViewer(
        mockTui(200, 80), mockSession(assistant("hi")), mockRecord({ status: "running" }), undefined,
        ansiTheme(), vi.fn(), vi.fn(), undefined, vi.fn(),
      );
      const lines = viewer.render(80);
      const footer = strip(lines[lines.length - 2]);
      expect(footer).toContain("Ctrl+O");
      expect(footer).toContain("Enter steer");
      expect(footer).toContain("x stop");
      expect(footer).toContain("m md");
      expect(footer).toContain("Esc close");
    });

    it("caps tool results at 16k and reports the omitted character magnitude", () => {
      const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
      const out = strip(viewerFor(result(lines.join("\n")), undefined, undefined, 4000).render(80).join("\n"));
      expect(out).toContain("line 100");
      expect(out).not.toContain("line 2999");
      expect(out).toMatch(/\.\.\. \(truncated, [\d.]+[kM]? more characters\)/);
    });

    it("puts truncation notices outside Markdown code fences", () => {
      const text = `\`\`\`js\n${"const a = 1;\n".repeat(2000)}\`\`\``;
      const viewer = viewerFor(result(text), "all", undefined, 4000);
      const note = ((viewer as any).buildContentLines(76) as string[]).map(strip)
        .find(line => line.includes("... (truncated"));
      expect(note).toMatch(/^\.\.\. \(truncated, [\d.]+[kM]? more characters\)$/);
    });

    it("reports exact small counts and readable large counts", () => {
      const exact = `${"x".repeat(RESULT_MAX_CHARS)}😀x`;
      const exactContent = ((viewerFor(result(exact)) as any).buildContentLines(76) as string[]).map(strip);
      expect(exactContent).toContain("... (truncated, 3 more characters)");

      const large = `${"x".repeat(RESULT_MAX_CHARS)}${"y".repeat(1_100_000)}`;
      const largeNote = viewerFor(result(large)).render(50).map(strip).find(line => line.includes("truncated,"));
      expect(largeNote).toContain("1.1M more characters)");

      const rounded = `${"x".repeat(RESULT_MAX_CHARS)}${"y".repeat(999_999)}`;
      expect(strip(viewerFor(result(rounded)).render(80).join("\n"))).toContain("1M more characters");
    });

    it("falls back to literal wrapping once for an unsafe streaming prefix", () => {
      const messages = result("# heading");
      const viewer = viewerFor(messages, "all");
      markdownThrows = true;

      expect(() => viewer.render(80)).not.toThrow();
      expect(strip(viewer.render(80).join("\n"))).toContain("# heading");

      messages[0].content[0].text += "\nmore";
      expect(strip(viewer.render(80).join("\n"))).toContain("more");
      expect(markdownRenderCalls).toBe(1);

      markdownThrows = false;
      expect(strip(viewer.render(80).join("\n"))).toContain("# heading");
      expect(markdownRenderCalls).toBe(1);

      messages[0].content[0].text = "## safe";
      const replaced = strip(viewer.render(80).join("\n"));
      expect(markdownRenderCalls).toBe(2);
      expect(replaced).toContain("safe");
      expect(replaced).not.toContain("## safe");
    });

    it("tracks a growing result beyond the cap without constructing Markdown by default", () => {
      const msg = { role: "toolResult", toolUseId: "t", content: [{ type: "text", text: "row\n".repeat(4500) }] };
      const viewer = viewerFor([msg]);
      const elided = () => {
        const match = strip(((viewer as any).buildContentLines(76) as string[]).join("\n"))
          .match(/truncated, ([\d.]+)([kM]?) more/);
        return Number(match?.[1]) * (match?.[2] === "M" ? 1e6 : match?.[2] === "k" ? 1e3 : 1);
      };
      const before = elided();
      msg.content[0].text += "row\n".repeat(1000);
      const after = elided();
      expect(after).toBeGreaterThan(before);
      expect(markdownConstructions).toBe(0);
    });

    it("leaves under-cap results untouched and caps expanded bash output", () => {
      const text = `head\n${"filler line\n".repeat(200)}tail`;
      const out = strip(viewerFor(result(text), undefined, undefined, 600).render(80).join("\n"));
      expect(text.length).toBeLessThan(RESULT_MAX_CHARS);
      expect(out).toContain("tail");
      expect(out).not.toContain("truncated");

      const bashViewer = viewerFor([{ role: "bashExecution", command: "yes", output: "y\n".repeat(20000) }], undefined, undefined, 4000);
      bashViewer.handleInput("\x0f");
      expect(strip(bashViewer.render(80).join("\n"))).toMatch(/\.\.\. \(truncated, [\d.]+[kM]? more characters\)/);
    });

    it("styles result content on both Markdown and literal paths", () => {
      for (const mode of ["all", "assistant"] as const) {
        const viewer = viewerFor(result("plain result text"), mode);
        const line = ((viewer as any).buildContentLines(76) as string[])
          .find(value => strip(value).includes("plain result text"));
        expect(line).toContain("\x1b[38;5;240m");
      }
    });

    it("reuses Markdown per message and refreshes a directly-mutated live tail", () => {
      const messages = assistant("# One");
      const viewer = viewerFor(messages);
      expect(strip(viewer.render(80).join("\n"))).toContain("One");
      const afterFirst = markdownConstructions;
      viewer.render(80);
      viewer.render(80);
      expect(markdownConstructions).toBe(afterFirst);

      messages[0].content[0].text = "# Two";
      const updated = strip(viewer.render(80).join("\n"));
      expect(updated).toContain("Two");
      expect(updated).not.toContain("One");
      expect(markdownConstructions).toBe(1);
    });

    it("renders Markdown within width without relying on the truncation backstop", () => {
      const text = `# ${"Heading ".repeat(20)}\n\n| a | b |\n|---|---|\n| ${"x".repeat(90)} | 2 |\n\n\`\`\`js\nconst x = ${"1".repeat(120)};\n\`\`\``;
      for (const width of [20, 40, 80, 120]) {
        const viewer = new ConversationViewer(
          mockTui(30, width), mockSession(assistant(text)), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        const content = (viewer as any).buildContentLines(width) as string[];
        assertAllLinesFit(content, width);
        expect(content.filter(line => strip(line).endsWith("..."))).toEqual([]);
      }
    });
  });

  describe("safety net against upstream wrapTextWithAnsi bugs", () => {
    // These tests call buildContentLines() directly (via the private method)
    // because render() has its own truncation via row(). The safety net in
    // buildContentLines is what prevents the TUI crash — it must clamp
    // independently of render().

    /** Call the private buildContentLines method directly. */
    function callBuildContentLines(viewer: InstanceType<typeof ConversationViewer>, width: number): string[] {
      return (viewer as any).buildContentLines(width);
    }

    it("mock is intercepting wrapTextWithAnsi", async () => {
      const { wrapTextWithAnsi } = await import("@earendil-works/pi-tui");
      wrapOverride = () => ["MOCK_SENTINEL"];
      expect(wrapTextWithAnsi("anything", 10)).toEqual(["MOCK_SENTINEL"]);
      wrapOverride = null;
    });

    it("clamps overwidth lines from toolResult content", () => {
      const w = 80;
      wrapOverride = () => ["X".repeat(w + 50)];

      const messages = [
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: "output" }] },
      ];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });

    it("clamps overwidth lines from user message content", () => {
      const w = 80;
      wrapOverride = () => ["Y".repeat(w + 100)];

      const messages = [{ role: "user", content: "hello" }];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });

    it("clamps overwidth lines from assistant message content", () => {
      const w = 80;
      wrapOverride = () => ["Z".repeat(w + 100)];

      const messages = [
        { role: "assistant", content: [{ type: "text", text: "response" }] },
      ];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });

    it("clamps overwidth lines from bashExecution output", () => {
      const w = 80;
      wrapOverride = () => ["B".repeat(w + 100)];

      const messages = [
        {
          role: "bashExecution", command: "ls", output: "out",
          exitCode: 0, cancelled: false, truncated: false, timestamp: Date.now(),
        },
      ];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });

    it("clamps overwidth lines that also contain ANSI codes", () => {
      const w = 80;
      wrapOverride = () => [`\x1b[1m\x1b[31m${"W".repeat(w + 30)}\x1b[0m`];

      const messages = [
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: "output" }] },
      ];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });
  });

  describe("backend-neutral transcript rendering", () => {
    const renderContent = (viewer: InstanceType<typeof ConversationViewer>, width = 80): string[] =>
      (viewer as any).buildContentLines(width);

    it("renders thinking and redacted thinking dimly", () => {
      const viewer = new ConversationViewer(
        mockTui(),
        mockSession([{
          role: "assistant",
          content: [
            { type: "thinking", thinking: "inspect the code" },
            { type: "thinking", thinking: "", redacted: true },
          ],
        }]),
        mockRecord(),
        undefined,
        semanticTheme(),
        vi.fn(),
      );
      const output = renderContent(viewer).join("\n");

      expect(output).toContain("<dim>[Thinking]</dim>");
      expect(output).toContain("<dim>inspect the code</dim>");
      expect(output).toContain("<dim>[redacted]</dim>");
    });

    it("renders bounded one-line previews for Claude and Pi tool arguments", () => {
      const viewer = new ConversationViewer(
        mockTui(),
        mockSession([{
          role: "assistant",
          content: [
            { type: "toolCall", name: "Read", arguments: { preview: "{ file: a.ts }\nnext" } },
            { type: "toolCall", name: "grep", arguments: { path: "src", pattern: "x".repeat(300) } },
          ],
        }]),
        mockRecord(),
        undefined,
        semanticTheme(),
        vi.fn(),
      );
      const lines = renderContent(viewer, 500);
      const claude = lines.find(line => line.includes("[Tool: Read]"))!;
      const pi = lines.find(line => line.includes("[Tool: grep]"))!;

      expect(claude).toContain("{ file: a.ts } next");
      expect(pi).toContain('{"path":"src","pattern":"');
      expect(visibleWidth(pi)).toBeLessThan(200);
    });

    it("pairs tool calls with compact results and toggles details with Ctrl+O", () => {
      const tui = mockTui();
      const viewer = new ConversationViewer(
        tui,
        mockSession([
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "src/a.ts" } }],
          },
          {
            role: "toolResult",
            toolCallId: "tool-1",
            toolName: "read",
            content: [{ type: "text", text: "file contents" }],
            isError: false,
          },
        ]),
        mockRecord({ status: "completed" }),
        undefined,
        semanticTheme(),
        vi.fn(),
      );

      const collapsed = renderContent(viewer).join("\n");
      expect(collapsed).toContain("<success>✓</success> <muted>[Tool: read]");
      expect(collapsed).not.toContain("file contents");

      viewer.handleInput("\x0f");
      const expanded = renderContent(viewer).join("\n");
      expect(expanded).toContain("[Result]");
      expect(expanded).toContain("file contents");
      expect(tui.requestRender).toHaveBeenCalled();
    });

    it("keeps failed tool output visible while tools are collapsed", () => {
      const viewer = new ConversationViewer(
        mockTui(),
        mockSession([
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "missing.ts" } }],
          },
          {
            role: "toolResult",
            toolCallId: "tool-1",
            toolName: "read",
            content: [{ type: "text", text: "not found" }],
            isError: true,
          },
        ]),
        mockRecord({ status: "completed" }),
        undefined,
        semanticTheme(),
        vi.fn(),
      );
      const output = renderContent(viewer).join("\n");

      expect(output).toContain("<error>✗</error> <muted>[Tool: read]");
      expect(output).toContain("[Result: Error]");
      expect(output).toContain("not found");
    });

    it("renders error tool results with error styling", () => {
      const viewer = new ConversationViewer(
        mockTui(),
        mockSession([{
          role: "toolResult",
          toolName: "Read",
          content: [{ type: "text", text: "permission denied" }],
          isError: true,
        }]),
        mockRecord(),
        undefined,
        semanticTheme(),
        vi.fn(),
      );
      const output = renderContent(viewer).join("\n");

      expect(output).toContain("<error>[Result: Error]</error>");
      expect(output).toContain("<error>permission denied</error>");
    });
  });

  describe("live rendering performance", () => {
    function liveSession(messages: any[]) {
      let listener: ((event: any) => void) | undefined;
      return {
        session: {
          messages,
          subscribe: (next: (event: any) => void) => { listener = next; return () => { listener = undefined; }; },
          getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }),
        } as any,
        emit: () => listener?.({ type: "message_update" }),
      };
    }

    it("re-wraps only the streaming tail instead of the full transcript", () => {
      let wraps = 0;
      wrapOverride = (text) => { wraps++; return [text]; };
      const messages = Array.from({ length: 201 }, (_, i) => ({ role: "user", content: `message ${i}` }));
      const { session, emit } = liveSession(messages);
      const viewer = new ConversationViewer(
        mockTui(), session, mockRecord(), undefined, semanticTheme(), vi.fn(),
      );

      viewer.render(80);
      expect(wraps).toBe(201);

      messages[200].content = "streaming tail changed";
      emit();
      viewer.render(80);
      expect(wraps).toBe(202); // one new wrap, not another 201
      viewer.dispose();
    });

    it("coalesces bursts of session deltas into one requested paint", () => {
      vi.useFakeTimers();
      try {
        const tui = mockTui();
        const { session, emit } = liveSession([{ role: "user", content: "start" }]);
        const viewer = new ConversationViewer(tui, session, mockRecord(), undefined, semanticTheme(), vi.fn());

        for (let i = 0; i < 100; i++) emit();
        expect(tui.requestRender).not.toHaveBeenCalled();
        vi.advanceTimersByTime(33);
        expect(tui.requestRender).toHaveBeenCalledOnce();
        viewer.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("invalidates the stable prefix when session compaction replaces history", () => {
      const messages: any[] = [
        { role: "user", content: "old prompt" },
        { role: "assistant", content: [{ type: "text", text: "old answer" }] },
      ];
      const { session, emit } = liveSession(messages);
      const viewer = new ConversationViewer(
        mockTui(), session, mockRecord(), undefined, semanticTheme(), vi.fn(),
      );
      expect(viewer.render(80).join("\n")).toContain("old prompt");

      session.messages = [
        { role: "user", content: "compacted summary" },
        { role: "assistant", content: [{ type: "text", text: "new tail" }] },
      ];
      emit();
      const rendered = viewer.render(80).join("\n");
      expect(rendered).toContain("compacted summary");
      expect(rendered).toContain("new tail");
      expect(rendered).not.toContain("old prompt");
      viewer.dispose();
    });
  });

  describe("close keys", () => {
    it.each(["\x1b", "q"])("closes with %j", (key) => {
      const done = vi.fn();
      const viewer = new ConversationViewer(
        mockTui(), mockSession(), mockRecord(), undefined, ansiTheme(), done,
      );

      viewer.handleInput(key);
      expect(done).toHaveBeenCalledOnce();
    });
  });

  describe("stop key", () => {
    const W = 80;

    it("two-press x stops a running agent (first arms, second aborts)", () => {
      const onStop = vi.fn();
      const tui = mockTui(30, W);
      const viewer = new ConversationViewer(
        tui, mockSession(), mockRecord({ status: "running" }), undefined, ansiTheme(), vi.fn(), onStop,
      );

      // Idle footer offers the stop affordance.
      expect(viewer.render(W).join("\n")).toContain("x stop");

      // First press arms (no abort yet) and re-renders.
      viewer.handleInput("x");
      expect(onStop).not.toHaveBeenCalled();
      expect(tui.requestRender).toHaveBeenCalled();
      expect(viewer.render(W).join("\n")).toContain("x again to STOP");

      // Second press aborts.
      viewer.handleInput("x");
      expect(onStop).toHaveBeenCalledTimes(1);
    });

    it("any other key disarms the confirm", () => {
      const onStop = vi.fn();
      const viewer = new ConversationViewer(
        mockTui(30, W), mockSession(), mockRecord({ status: "running" }), undefined, ansiTheme(), vi.fn(), onStop,
      );

      viewer.handleInput("x");                       // arm
      viewer.handleInput("j");                       // scroll → disarm
      expect(viewer.render(W).join("\n")).toContain("x stop");
      expect(viewer.render(W).join("\n")).not.toContain("x again to STOP");

      viewer.handleInput("x");                       // arms again, does NOT stop
      expect(onStop).not.toHaveBeenCalled();
    });

    it("does not offer or perform stop once the agent is no longer running", () => {
      const onStop = vi.fn();
      const viewer = new ConversationViewer(
        mockTui(30, W), mockSession(), mockRecord({ status: "completed" }), undefined, ansiTheme(), vi.fn(), onStop,
      );

      expect(viewer.render(W).join("\n")).not.toContain("x stop");
      viewer.handleInput("x");
      viewer.handleInput("x");
      expect(onStop).not.toHaveBeenCalled();
    });

    it("no stop affordance when no onStop handler is provided (read-only history)", () => {
      const viewer = new ConversationViewer(
        mockTui(30, W), mockSession(), mockRecord({ status: "running" }), undefined, ansiTheme(), vi.fn(),
      );
      expect(viewer.render(W).join("\n")).not.toContain("x stop");
      expect(() => { viewer.handleInput("x"); viewer.handleInput("x"); }).not.toThrow();
    });
  });

  describe("steer composer", () => {
    const W = 80;

    function makeViewer(opts: { status?: AgentRecord["status"]; onSteer?: (m: string) => void } = {}) {
      const onSteer = opts.onSteer ?? vi.fn();
      const done = vi.fn();
      const tui = mockTui(30, W);
      const viewer = new ConversationViewer(
        tui, mockSession(), mockRecord({ status: opts.status ?? "running" }),
        undefined, ansiTheme(), done, undefined, undefined, onSteer,
      );
      return { viewer, tui, onSteer, done };
    }

    it("offers the steer affordance for a running agent and opens on Enter", () => {
      const { viewer } = makeViewer();
      expect(viewer.render(W).join("\n")).toContain("Enter steer");

      viewer.handleInput("\r"); // Enter
      // Composer is shown (its prompt + send/cancel hint), idle footer is gone.
      const out = viewer.render(W).join("\n");
      expect(out).toContain("Enter send · Esc cancel");
      expect(out).not.toContain("Enter steer");
    });

    it("typing then Enter sends the trimmed message and closes the composer", () => {
      const { viewer, onSteer } = makeViewer();
      viewer.handleInput("\r"); // open composer
      for (const ch of "  hello  ") viewer.handleInput(ch);
      viewer.handleInput("\r"); // send

      expect(onSteer).toHaveBeenCalledWith("hello");
      expect(viewer.render(W).join("\n")).not.toContain("Enter send"); // composer closed
    });

    it("composer Esc cancels only the composer; a second Esc closes the viewer", () => {
      const { viewer, onSteer, done } = makeViewer();
      viewer.handleInput("\r"); // open composer
      for (const ch of "draft") viewer.handleInput(ch);
      viewer.handleInput("\x1b"); // cancel composer

      expect(onSteer).not.toHaveBeenCalled();
      expect(done).not.toHaveBeenCalled();
      expect(viewer.render(W).join("\n")).not.toContain("Enter send");

      viewer.handleInput("\x1b"); // close viewer
      expect(done).toHaveBeenCalledOnce();
    });

    it("an empty submit just returns (like Esc), without calling onSteer", () => {
      const { viewer, onSteer } = makeViewer();
      viewer.handleInput("\r"); // open composer
      viewer.handleInput("\r"); // empty submit
      expect(onSteer).not.toHaveBeenCalled();
      expect(viewer.render(W).join("\n")).not.toContain("Enter send"); // composer closed
    });

    it("scroll keys are inert while composing (input owns them)", () => {
      const { viewer } = makeViewer();
      viewer.handleInput("\r"); // open composer
      // 'j' would normally scroll, but here it types into the composer.
      viewer.handleInput("j");
      expect(viewer.render(W).join("\n")).toContain("Enter send · Esc cancel");
    });

    it("no steer affordance once the agent is no longer running", () => {
      const { viewer, onSteer } = makeViewer({ status: "completed" });
      expect(viewer.render(W).join("\n")).not.toContain("Enter steer");
      viewer.handleInput("\r");
      expect(viewer.render(W).join("\n")).not.toContain("Enter send");
      expect(onSteer).not.toHaveBeenCalled();
    });

    it("no steer affordance when no onSteer handler is provided", () => {
      const viewer = new ConversationViewer(
        mockTui(30, W), mockSession(), mockRecord({ status: "running" }), undefined, ansiTheme(), vi.fn(),
      );
      expect(viewer.render(W).join("\n")).not.toContain("Enter steer");
      expect(() => viewer.handleInput("\r")).not.toThrow();
    });

    it("composer rows never exceed width", () => {
      for (const w of [40, 80, 120]) {
        const tui = mockTui(30, w);
        const viewer = new ConversationViewer(
          tui, mockSession(), mockRecord({ status: "running" }),
          undefined, ansiTheme(), vi.fn(), undefined, undefined, vi.fn(),
        );
        viewer.handleInput("\r"); // open composer
        for (const ch of "x".repeat(200)) viewer.handleInput(ch);
        assertAllLinesFit(viewer.render(w), w);
      }
    });
  });
});
