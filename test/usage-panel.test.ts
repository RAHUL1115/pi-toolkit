import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { historyAccumulator } from "../pi-toolkit-lib/usage-history.ts";
import { renderUsage, usagePanel, usageShare } from "../pi-toolkit-lib/usage.ts";

const theme = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s };
function setup(rows = 30) {
  const { report } = historyAccumulator(0);
  Object.assign(report.windows[0], { input: 27600, cacheRead: 84400, output: 16400, total: 128400, cost: .127 });
  report.windows[1].total = 777;
  report.windows[2].total = 3030;
  const tui = { terminal: { rows }, requestRender: vi.fn() };
  const done = vi.fn();
  const bg = vi.fn(theme.bg);
  const panel = usagePanel(report, tui, { ...theme, bg }, done);
  return { report, tui, done, bg, panel };
}

describe("usage panel", () => {
  it("renders rounded dim borders, exact two-column padding and blank inset rows", () => {
    const { panel } = setup();
    const lines = panel.render(52);
    expect(lines[0]).toBe("╭" + "─".repeat(50) + "╮");
    expect(lines.at(-1)).toBe("╰" + "─".repeat(50) + "╯");
    expect(lines[1]).toBe("│" + " ".repeat(50) + "│");
    expect(lines.at(-2)).toBe(lines[1]);
    expect(lines[2]).toBe("│  Usage" + " ".repeat(43) + "│");
    expect(lines[5]).toBe("│   1 day    7 days    30 days " + " ".repeat(20) + "│");
    for (const line of lines.slice(1, -1)) {
      expect(line.startsWith("│  ")).toBe(true);
      expect(line.endsWith("  │")).toBe(true);
      expect(visibleWidth(line)).toBe(52);
    }
    expect(lines.join("\n")).toContain("All projects · last 24h");
    expect(lines.join("\n")).not.toContain("Recorded Pi estimates");
    expect(lines.join("\n")).toContain("Esc close");
  });

  it("uses real theme backgrounds for active and inactive tabs, without brackets", () => {
    const { panel, bg } = setup();
    const lines = panel.render(60);
    expect(bg.mock.calls).toEqual([["searchMatchBg", " 1 day "], ["customMessageBg", " 7 days "], ["customMessageBg", " 30 days "]]);
    expect(lines.join("\n")).not.toMatch(/[\[\]]/);
    panel.handleInput("\t"); bg.mockClear(); panel.render(60);
    expect(bg.mock.calls[1]).toEqual(["searchMatchBg", " 7 days "]);
  });

  it("groups input tokens without double counting and keeps values beside labels at every width", () => {
    const { report } = setup();
    const wide = renderUsage(report, 0, 46, theme).map(line => line.trimEnd());
    expect(wide[0]).toBe("Total tokens      128.4k");
    expect(wide[1]).toBe("Estimated cost    ~$0.1270");
    expect(renderUsage(report, 0, 160, theme).slice(0, 7).map(line => line.trimEnd())).toEqual(wide.slice(0, 7));
    expect(wide[3]).toMatch(/^Input +112\.0k$/);
    expect(wide[4]).toMatch(/^  Uncached +27\.6k$/);
    expect(wide[5]).toMatch(/^  Cached reads +84\.4k$/);
    expect(wide[6]).toMatch(/^Output +16\.4k$/);
    expect(wide.join("\n")).not.toContain("Cache writes");
    report.windows[0].cacheWrite = 1000;
    expect(renderUsage(report, 0, 46, theme).join("\n")).toMatch(/Input +113\.0k/);
    expect(renderUsage(report, 0, 32, theme).slice(0, 2).map(line => line.trimEnd())).toEqual(["Total tokens      128.4k", "Estimated cost    ~$0.1270"]);
  });

  it("shows both model shares in compact left-clustered columns, known costs and provider details", () => {
    const { report } = setup();
    const empty = historyAccumulator(0).report.windows[0];
    report.windows[0].byModel = [
      { ...empty, provider: "openai", model: "gpt-6-astra", total: 80000, cost: .09 },
      { ...empty, provider: "other", model: "gpt-5.6-sol", total: 48400, cost: .037 },
    ];
    const text = renderUsage(report, 0, 160, theme).map(s => s.trimEnd());
    expect(text).toContain("Model        Tokens  Token %    Cost  Cost %");
    expect(text).toContain("gpt-6-astra   80.0k    62.3%  $0.090   70.9%");
    expect(text).toContain("gpt-5.6-sol   48.4k    37.7%  $0.037   29.1%");
    expect(renderUsage(report, 0, 60, theme).map(s => s.trimEnd())).toEqual(text);
    report.windows[0].byModel[1].model = "gpt-6-astra";
    report.windows[0].byModel[1].missingCosts = 1;
    const details = renderUsage(report, 0, 160, theme, true).join("\n");
    expect(details).toContain("openai/gpt-6-astra");
    expect(details).toContain("other/gpt-6-astra");
    expect(details).toContain("$0.037+?");
    expect(details).toContain("zero denominators show 0.0%");
    expect(usageShare(0, 0)).toBe("0.0%");
    expect(usageShare(.037, .127)).toBe("29.1%");
    expect(renderUsage(report, 1, 80, theme).join("\n")).toContain("No usage in this period");
  });

  it("stacks narrow model rows, truncates Unicode labels and keeps models in the scrolling body", () => {
    const { report, panel } = setup(20);
    const empty = historyAccumulator(0).report.windows[0];
    report.windows[0].byModel = [{ ...empty, provider: null, model: null, missingCosts: 1 },
      { ...empty, provider: "provider", model: "模型é".repeat(30), total: 128400, cost: .127 }];
    const narrow = renderUsage(report, 0, 30, theme).join("\n");
    expect(narrow).toContain("Unattributed");
    expect(narrow).toContain("Token %  0.0%");
    expect(narrow).toContain("Cost  $0.000+?");
    expect(narrow).toContain("Cost %  100.0%");
    for (let width = 1; width <= 100; width++) for (const line of renderUsage(report, 0, width, theme)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    const before = panel.render(80);
    panel.handleInput("\x1b[6~");
    const after = panel.render(80);
    expect(after.slice(0, 7)).toEqual(before.slice(0, 7));
    expect(after.slice(-4)).toEqual(before.slice(-4));
    expect(after.join("\n")).toContain("Models");
    expect(after.join("\n")).toContain("Unattributed");
  });

  it("cycles rolling scopes both ways, scrolls only the body, toggles details and closes", () => {
    const { panel, tui, done } = setup(20);
    const first = panel.render(64);
    panel.handleInput("\x1b[C");
    expect(panel.render(64).join("\n")).toContain("last 168h");
    panel.handleInput("\t");
    expect(panel.render(64).join("\n")).toContain("last 720h");
    panel.handleInput("\t");
    expect(panel.render(64)).toEqual(first);
    panel.handleInput("\x1b[Z");
    expect(panel.render(64).join("\n")).toContain("last 720h");
    panel.handleInput("\x1b[D");
    expect(panel.render(64).join("\n")).toContain("last 168h");
    panel.handleInput("d");
    const before = panel.render(64);
    panel.handleInput("\x1b[6~");
    const after = panel.render(64);
    expect(after.slice(0, 7)).toEqual(before.slice(0, 7));
    expect(after.slice(-4)).toEqual(before.slice(-4));
    expect(after).not.toEqual(before);
    panel.handleInput("\x1b[5~");
    expect(panel.render(64)).toEqual(before);
    tui.terminal.rows = 100;
    expect(panel.render(100).join("\n")).toContain("Recorded Pi estimates");
    panel.handleInput("d");
    expect(panel.render(100).join("\n")).not.toContain("Recorded Pi estimates");
    panel.handleInput("\x1b");
    expect(done).toHaveBeenCalledOnce();
  });

  it.each(["partial", "skipped", "invalid", "missingCosts"])("pins incomplete-data warning for %s even with details hidden or scrolled", (key) => {
    const { report, panel } = setup(20);
    if (key === "missingCosts") report.windows[0].missingCosts = 1;
    else Object.assign(report, { [key]: key === "partial" ? true : 1 });
    for (const input of ["", "d", "\x1b[6~", "\x1b[B", "d"]) {
      panel.handleInput(input);
      expect(panel.render(64).join("\n")).toContain("Incomplete data");
    }
  });

  it("fits every small viewport and resizing with ANSI, wide Unicode and combining marks", () => {
    const { report, tui } = setup();
    report.partial = true;
    const unicodeTheme = { ...theme, fg: (_: string, s: string) => `\x1b[36m${s === "Usage" ? "使用量 é" : s}\x1b[39m`, bg: (_: string, s: string) => `\x1b[44m${s}\x1b[49m` };
    const panel = usagePanel(report, tui, unicodeTheme, () => {});
    panel.handleInput("d");
    for (let rows = 0; rows <= 32; rows++) {
      tui.terminal.rows = rows;
      for (let width = 0; width <= 100; width++) {
        const lines = panel.render(width);
        expect(lines.length).toBeLessThanOrEqual(Math.max(0, rows - 2));
        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
    tui.terminal.rows = 30;
    panel.invalidate();
    expect(panel.render(64).join("\n")).toContain("使用量 é");
  }, 15_000);
});
