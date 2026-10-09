import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, getKeybindings, KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { AskUserQuestionComponent } from "../pi-toolkit-lib/ask-user-question/component.ts";
import type { Question, Result } from "../pi-toolkit-lib/ask-user-question/schema.ts";

const down = "\x1b[B", up = "\x1b[A", esc = "\x1b", enter = "\r";
const q: Question = { question: "Pick one", header: "One", multiSelect: false, options: [{ label: "A, B" }, { label: "C" }] };
const q2: Question = { ...q, question: "Pick two", header: "Two" };
const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s } as Theme;
function setup(questions = [q, q2], kb?: KeybindingsManager) {
  const results: (Result | null)[] = [];
  const c = new AskUserQuestionComponent(questions, { requestRender() {}, terminal: { rows: 24, columns: 80 } } as never, theme, r => results.push(r), kb);
  c.focused = true;
  return { c, results };
}
function type(c: AskUserQuestionComponent, text: string) { for (const ch of text) c.handleInput(ch); }
function other(c: AskUserQuestionComponent) { c.handleInput(down); c.handleInput(down); c.handleInput(" "); }
function paste(c: AskUserQuestionComponent, text: string) { c.handleInput(`\x1b[200~${text}\x1b[201~`); }

describe("questionnaire upgrades", () => {
  it("isolates multiline drafts across tabs, notes and option selection", () => {
    const { c, results } = setup();
    other(c); type(c, "first"); c.handleInput("\x1b[13;2u"); type(c, "second"); c.handleInput(esc);
    c.handleInput(up); c.handleInput("n"); type(c, "context"); c.handleInput(esc); c.handleInput(down);
    c.handleInput("\t"); other(c); type(c, "different"); c.handleInput(esc);
    c.handleInput("\x1b[Z"); c.handleInput(" ");
    expect(c.render(80).join("\n")).toContain("first");
    expect(c.render(80).join("\n")).toContain("second");
    expect(c.render(80).join("\n")).not.toContain("different");
    c.handleInput(enter); // commit restored Q1 draft
    c.handleInput(" "); c.handleInput(enter); // restored Q2 draft
    c.handleInput(enter);
    expect(results[0]?.answers).toEqual({ "Pick one": "first\nsecond", "Pick two": "different" });
    expect(results[0]?.answerDetails[0]).toEqual({ questionIndex: 0, kind: "custom", selectedLabels: [], customText: "first\nsecond", note: "context" });
  });

  it("preserves multiline paste and navigates Up within text before leaving at the top", () => {
    const { c, results } = setup([q]);
    other(c); paste(c, "alpha\r\nbeta"); c.render(80);
    c.handleInput(up); // second to first line, still editing
    c.handleInput("!");
    c.handleInput(up); // top boundary leaves editing
    c.handleInput(down); c.handleInput(" "); c.handleInput(enter);
    expect(results[0]?.answers[q.question]).toBe("alph!a\nbeta");
  });

  it("keeps Up in wrapped text until the first visual line", () => {
    const { c } = setup([q]);
    other(c); type(c, "abcdefghijklmnopqrstuvwxyz"); c.render(10);
    c.handleInput(up); type(c, "!");
    expect(c.render(10).join("\n")).toContain(CURSOR_MARKER);
    c.handleInput(esc); c.handleInput(" ");
    expect(c.render(80).join("\n")).toContain("!");
  });

  it("notes never answer a question and global notes cannot bypass missing answers", () => {
    const { c, results } = setup();
    c.handleInput("n"); type(c, "question note"); c.handleInput(enter);
    c.handleInput("\x1b[D"); c.handleInput("n"); type(c, "global"); c.handleInput(enter);
    c.handleInput(enter);
    expect(results).toEqual([]);
    expect(c.render(80).join("\n")).toContain("Still needed");
    expect(c.render(80).join("\n")).toContain("question note");
    c.handleInput(esc); c.handleInput(esc);
    expect(results).toEqual([null]);
  });

  it("notes preserve selected choices, including a combined multi+custom answer", () => {
    const { c, results } = setup([{ ...q, multiSelect: true }, q2]);
    c.handleInput(" ");
    c.handleInput("n"); type(c, "n is text here"); c.handleInput("\n"); type(c, "line two"); c.handleInput(esc);
    other(c); paste(c, "extra\ncustom"); c.handleInput(enter);
    c.handleInput("n"); type(c, "second note"); c.handleInput(enter);
    c.handleInput(enter);
    c.handleInput("n"); type(c, "global note"); c.handleInput(esc);
    c.handleInput(enter);
    const result = results[0];
    expect(result?.answers[q.question]).toBe("A, B, extra\ncustom");
    expect(result?.answerDetails).toEqual([
      { questionIndex: 0, kind: "multi", selectedLabels: ["A, B"], customText: "extra\ncustom", note: "n is text here\nline two" },
      { questionIndex: 1, kind: "option", selectedLabels: ["A, B"], note: "second note" },
    ]);
    expect(result?.globalNote).toBe("global note");
  });

  it("injected bindings control navigation, cancellation and submission; newline wins only in editors", () => {
    const kb = new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.select.down": "j", "tui.select.up": "k", "tui.select.confirm": "ctrl+s",
      "tui.select.cancel": "ctrl+x", "tui.input.submit": "ctrl+s", "tui.input.newLine": ["ctrl+s", "ctrl+n"],
    });
    const previous = getKeybindings();
    const { c, results } = setup([q], kb);
    c.handleInput(down); // disabled default
    expect(c.render(80).join("\n")).toMatch(/>.*A, B/);
    c.handleInput("j"); c.handleInput("j"); c.handleInput(" "); type(c, "a");
    c.handleInput("\x13"); type(c, "b");
    expect(results).toEqual([]);
    expect(c.render(80).join("\n")).toContain("ctrl+s submit");
    expect(getKeybindings()).toBe(previous);
    c.handleInput("\x18"); // leave editor, not questionnaire
    c.handleInput("k"); c.handleInput("\x13"); // outside editor confirm wins
    expect(results[0]?.answers[q.question]).toBe("C");
    const cancelled = setup([q], kb);
    cancelled.c.handleInput("\x18"); expect(cancelled.results).toEqual([null]);
  });

  it("confirm reopens uncommitted drafts and changed committed drafts; n can start custom text", () => {
    const { c, results } = setup();
    other(c); type(c, "new"); c.handleInput(esc); c.handleInput(enter);
    expect(c.render(80).join("\n")).toContain(CURSOR_MARKER);
    c.handleInput(enter); c.handleInput("\x1b[D"); c.handleInput(" "); type(c, "er"); c.handleInput(esc);
    c.handleInput(enter); expect(c.render(80).join("\n")).toContain("newer");
    c.handleInput(enter); c.handleInput(enter); c.handleInput(enter);
    expect(results[0]?.answers[q.question]).toBe("newer");
    const fresh = setup([q]); fresh.c.handleInput(down); fresh.c.handleInput(down); type(fresh.c, "natural"); fresh.c.handleInput(enter);
    expect(fresh.results[0]?.answers[q.question]).toBe("natural");
  });

  it("configured n confirm takes precedence over the notes shortcut", () => {
    const kb = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.confirm": "n" });
    const { c, results } = setup([q], kb); c.handleInput("n");
    expect(results[0]?.answers[q.question]).toBe("A, B");
  });

  it("submit review produces physical lines for multiline answers and adjacent notes", () => {
    const { c } = setup();
    c.handleInput("n"); paste(c, "first note\nsecond note"); c.handleInput(esc);
    other(c); paste(c, "alpha\nbeta"); c.handleInput(enter); c.handleInput(enter);
    for (const width of [5, 20, 80]) {
      const lines = c.render(width);
      for (const line of lines) { expect(line).not.toMatch(/[\r\n]/); expect(visibleWidth(line)).toBeLessThanOrEqual(width); }
    }
    const text = c.render(80).join("\n"); expect(text).toContain("beta"); expect(text.indexOf("One note:")).toBeLessThan(text.indexOf("Two:"));
  });

  it("propagates focus and keeps editor and notes within narrow widths", () => {
    const { c } = setup(); other(c); paste(c, "漢字 and multiple\nlines");
    expect(c.render(30).join("\n")).toContain(CURSOR_MARKER);
    c.focused = false; expect(c.render(30).join("\n")).not.toContain(CURSOR_MARKER);
    c.focused = true;
    for (const width of [1, 5, 12, 30]) for (const line of c.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    c.handleInput(esc); c.handleInput(up); c.handleInput("n"); paste(c, "note\n漢字");
    for (const width of [1, 5, 12, 30]) for (const line of c.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  });
});
