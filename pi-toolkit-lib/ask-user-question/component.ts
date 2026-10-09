import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Editor,
  type Focusable,
  getKeybindings,
  type Keybinding,
  type KeybindingsManager,
  setKeybindings,
  type TUI,
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { AnswerDetail, Option, Question, Result } from "./schema.ts";

// ── TUILike ───────────────────────────────────────────────────────────────────
// Minimal interface satisfied by both the real TUI and a test stub.
export interface TUILike {
  requestRender(): void;
}

// ── QuestionState ─────────────────────────────────────────────────────────────
interface QuestionState {
  /** Visual cursor position — where the highlight is, NOT the answer */
  cursorIndex: number;
  /** Single-select: explicitly chosen option index; null = nothing chosen yet */
  selectedIndex: number | null;
  /** For multiSelect: set of explicitly selected option indices */
  selectedIndices: Set<number>;
  /** Whether the user has confirmed this question */
  confirmed: boolean;
  /** Free-text answer typed by the user; null = free-text not chosen */
  freeTextValue: string | null;
  /** Whether the inline Editor is currently active */
  inEditMode: boolean;
  draft: string;
  note: string;
}

type DisplayOption = Option & { isOther?: true };

// ── AskUserQuestionComponent ──────────────────────────────────────────────────
export class AskUserQuestionComponent implements Component, Focusable {
  private questions: Question[];
  private theme: Theme;
  private tui: TUILike;
  private done: (result: Result | null) => void;

  private states: QuestionState[];
  private activeTab: number = 0;
  private editor: Editor;
  private keybindings: KeybindingsManager;
  private editingNote = false;
  private globalNote = "";
  private editorWidth = 80;
  private _focused = false;

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) {
    this._focused = value;
    if (this.editor) this.editor.focused = value && this.isEditing;
    this.invalidate();
  }

  private get isEditing(): boolean {
    return this.editingNote || !!this.states[this.activeTab]?.inEditMode;
  }

  private matches(data: string, action: Keybinding): boolean {
    return this.keybindings.matches(data, action);
  }

  private hint(action: Keybinding): string {
    return this.keybindings.getKeys(action).join("/") || "unbound";
  }

  // Editor reads Pi's shared bindings. Scope the injected manager to this
  // synchronous dispatch, restoring the host's manager even if editing throws.
  private editorInput(data: string): void {
    const previous = getKeybindings();
    try {
      setKeybindings(this.keybindings);
      this.editor.handleInput(data);
    } finally {
      setKeybindings(previous);
    }
  }

  // Render cache
  private cachedWidth?: number;
  private cachedLines?: string[];

  // Guard: prevent done() being called more than once
  private _resolved: boolean = false;

  constructor(
    questions: Question[],
    tui: TUILike,
    theme: Theme,
    done: (result: Result | null) => void,
    keybindings: KeybindingsManager = getKeybindings(),
  ) {
    this.questions = questions;
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    this.keybindings = keybindings;

    this.states = questions.map(() => ({
      cursorIndex: 0,
      selectedIndex: null,
      selectedIndices: new Set<number>(),
      confirmed: false,
      freeTextValue: null,
      inEditMode: false,
      draft: "",
      note: "",
    }));

    this.editor = new Editor(tui as TUI, {
      borderColor: (s) => theme.fg("dim", s),
      selectList: {
        selectedPrefix: (s) => theme.fg("accent", s),
        selectedText: (s) => theme.fg("accent", s),
        description: (s) => theme.fg("muted", s),
        scrollInfo: (s) => theme.fg("dim", s),
        noMatch: (s) => theme.fg("dim", s),
      },
    }, { paddingX: 0 });
    this.editor.disableSubmit = true;

    this.invalidate();
  }

  // ── Derived helpers ─────────────────────────────────────────────────────────

  private allOptions(q: Question): DisplayOption[] {
    return [
      ...q.options,
      { label: "Type your own answer...", isOther: true as const },
    ];
  }

  private allConfirmed(): boolean {
    return this.states.every((s) => s.confirmed);
  }

  private get isSingle(): boolean {
    return this.questions.length === 1;
  }

  private get totalTabs(): number {
    return this.questions.length + 1; // questions + Submit
  }

  // ── Public interface ────────────────────────────────────────────────────────

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  // ── render() ────────────────────────────────────────────────────────────────

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedLines) {
      return this.cachedLines;
    }

    if (this.questions.length === 0) {
      return [];
    }

    width = Math.max(1, width);
    // Editor needs at least two content columns for wide graphemes.
    this.editorWidth = Math.max(2, width - 1);
    const t = this.theme;
    const lines: string[] = [];
    const add = (s: string) => {
      for (const line of s.split(/\r\n|\r|\n/)) lines.push(truncateToWidth(line, width));
    };

    // ── Top separator ──
    add(t.fg("accent", "─".repeat(width)));

    // ── Tab bar (multi-question only) ──
    if (!this.isSingle) {
      this.renderTabBar(width, add);
      lines.push("");
    }

    // ── Question body or Submit tab ──
    const q = this.questions[this.activeTab];
    if (!q) {
      // activeTab is on Submit tab (or out of bounds) — render Submit view
      this.renderSubmitTab(width, add);
    } else {
      const state = this.states[this.activeTab];
      this.renderQuestionBody(q, state, width, add);
    }

    if (this.editingNote) {
      add(t.fg("accent", this.activeTab === this.questions.length ? " Global note" : " Note"));
      for (const line of this.editor.render(Math.max(3, width))) add(line);
      add(t.fg("dim", ` ${this.hint("tui.input.newLine")} newline · ${this.hint("tui.input.submit")}/${this.hint("tui.select.cancel")} close`));
    }

    // ── Bottom separator ──
    add(t.fg("accent", "─".repeat(width)));

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private renderTabBar(_width: number, add: (s: string) => void): void {
    const t = this.theme;
    const parts: string[] = [" "];

    for (let i = 0; i < this.questions.length; i++) {
      const q = this.questions[i];
      const s = this.states[i];
      const isActive = i === this.activeTab;
      // Truncate header to 12 chars
      const header = truncateToWidth(q.header, 12);
      const label = ` ${header} `;

      let styled: string;
      if (isActive) {
        styled = t.bg("selectedBg", t.fg("text", label));
      } else if (s.confirmed) {
        styled = t.fg("success", ` ■${header} `);
      } else {
        styled = t.fg("muted", `  ${header} `);
      }
      parts.push(styled);
    }

    // Submit tab
    const isSubmitActive = this.activeTab === this.questions.length;
    const submitLabel = " ✓ Submit ";
    let submitStyled: string;
    if (isSubmitActive) {
      submitStyled = t.bg("selectedBg", t.fg("text", submitLabel));
    } else if (this.allConfirmed()) {
      submitStyled = t.fg("success", submitLabel);
    } else {
      submitStyled = t.fg("dim", submitLabel);
    }
    parts.push(submitStyled);

    add(parts.join(""));
  }

  private renderQuestionBody(
    q: Question,
    state: QuestionState,
    width: number,
    add: (s: string) => void,
  ): void {
    const t = this.theme;
    const opts = this.allOptions(q);

    // Question text (word-wrapped)
    {
      const wrapped = wrapTextWithAnsi(
        t.fg("text", ` ${q.question}`),
        Math.max(1, width - 2),
      );
      for (const line of wrapped) {
        add(line);
      }
    }
    add("");

    // Options list
    for (let i = 0; i < opts.length; i++) {
      const opt = opts[i];
      const isSelected = i === state.cursorIndex;
      const isOther = opt.isOther === true;
      const prefix = isSelected ? t.fg("accent", ">") : " ";

      if (q.multiSelect && !isOther) {
        // Checkbox style
        const checked = state.selectedIndices.has(i);
        const box = checked ? t.fg("accent", "[✓]") : t.fg("dim", "[ ]");
        const labelColor = isSelected ? "accent" : "text";
        add(`${prefix} ${box} ${t.fg(labelColor, `${i + 1}. ${opt.label}`)}`);
      } else if (isOther) {
        // The last option is the input, not a separate editor below the list.
        const hasFreeText = state.freeTextValue !== null && !state.inEditMode;
        const box = q.multiSelect
          ? hasFreeText ? t.fg("success", "[✓]") : t.fg("dim", "[ ]")
          : hasFreeText ? t.fg("success", "✓") : " ";
        const label = `${i + 1}. `;
        const display = state.freeTextValue ?? opt.label;
        add(`${prefix} ${box} ${t.fg(isSelected ? "accent" : "muted", label)}${t.fg(hasFreeText ? "text" : "dim", state.inEditMode ? "Custom answer" : display.split("\n")[0])}`);
        if (state.inEditMode) {
          // Render the complete built-in editor, retaining its cursor marker,
          // borders and wrapped lines instead of slicing ANSI output.
          for (const line of this.editor.render(Math.max(3, width))) add(line);
        }
      } else {
        // Single-select — show ✓ on the confirmed selection
        const isConfirmedChoice = state.selectedIndex === i;
        const check = isConfirmedChoice ? t.fg("success", "✓") : " ";
        const labelColor = isSelected ? "accent" : "text";
        add(`${prefix} ${check} ${t.fg(labelColor, `${i + 1}. ${opt.label}`)}`);
      }

      // Description (if present, not for "Type your own answer...")
      if (!isOther && opt.description) {
        const indent = q.multiSelect ? "       " : "     ";
        const wrapped = wrapTextWithAnsi(
          t.fg("muted", opt.description),
          Math.max(1, width - indent.length),
        );
        for (const line of wrapped) {
          add(`${indent}${line}`);
        }
      }
    }

    add("");

    if (state.note && !this.editingNote) {
      for (const line of wrapTextWithAnsi(t.fg("muted", ` Note: ${state.note}`), width)) add(line);
    }

    // Footer help — context-sensitive based on cursor position
    if (state.inEditMode) {
      add(t.fg("dim", ` ${this.hint("tui.input.submit")} submit · ${this.hint("tui.input.newLine")} newline · ${this.hint("tui.editor.cursorUp")} at top back · ${this.hint("tui.select.cancel")} back`));
    } else {
      const onOther = state.cursorIndex === opts.length - 1;
      const tabHint = this.isSingle ? "" : " · ←→/Tab/Shift+Tab switch tabs";
      let actionHint: string;
      if (onOther) {
        actionHint = `Type answer · ${this.hint("tui.select.confirm")} submit`;
      } else if (q.multiSelect) {
        actionHint = `Space toggle · ${this.hint("tui.select.confirm")} confirm`;
      } else {
        actionHint = `${this.hint("tui.select.confirm")} select`;
      }
      const noteHint = onOther ? "" : " · n note";
      add(t.fg("dim", ` ${this.hint("tui.select.up")}/${this.hint("tui.select.down")} navigate · ${actionHint}${tabHint}${noteHint} · ${this.hint("tui.select.cancel")} cancel`));
    }
  }

  private renderSubmitTab(_width: number, add: (s: string) => void): void {
    const t = this.theme;
    const allDone = this.allConfirmed();

    const title = allDone
      ? t.fg("success", t.bold(" Ready to submit"))
      : t.fg("warning", t.bold(" Unanswered questions"));
    add(title);
    add("");

    for (let i = 0; i < this.questions.length; i++) {
      const q = this.questions[i];
      const state = this.states[i];
      const answer = this.getAnswerText(q, state);
      if (answer !== null) {
        for (const line of wrapTextWithAnsi(
          t.fg("muted", ` ${truncateToWidth(q.header, 12)}: `) + t.fg("text", answer),
          Math.max(1, _width),
        )) add(line);
      } else {
        add(
          t.fg("dim", ` ${truncateToWidth(q.header, 12)}: `) +
            t.fg("warning", "—"),
        );
      }
      if (state.note) for (const line of wrapTextWithAnsi(t.fg("muted", ` ${q.header} note: ${state.note}`), Math.max(1, _width))) add(line);
    }
    if (this.globalNote) for (const line of wrapTextWithAnsi(t.fg("muted", ` Global note: ${this.globalNote}`), Math.max(1, _width))) add(line);
    add("");
    if (allDone) {
      add(t.fg("success", ` Press ${this.hint("tui.select.confirm")} to submit`));
    } else {
      const missing = this.questions
        .filter((_, i) => !this.states[i].confirmed)
        .map((q) => truncateToWidth(q.header, 12))
        .join(", ");
      add(t.fg("warning", ` Still needed: ${missing}`));
    }
    add("");
    add(t.fg("dim", ` ←→/Tab/Shift+Tab switch tabs · n global note · ${this.hint("tui.select.cancel")} cancel`));
  }

  private getAnswerText(q: Question, state: QuestionState): string | null {
    if (!state.confirmed) return null;
    if (q.multiSelect) {
      const labels = [...state.selectedIndices]
        .sort((a, b) => a - b)
        .map((idx) => q.options[idx].label);
      if (state.freeTextValue !== null) labels.push(state.freeTextValue);
      return labels.join(", ");
    }
    if (state.freeTextValue !== null) return state.freeTextValue;
    if (state.selectedIndex !== null)
      return q.options[state.selectedIndex].label;
    return null;
  }

  // ── Private navigation helpers ───────────────────────────────────────────────

  private moveCursor(delta: -1 | 1): void {
    const q = this.questions[this.activeTab];
    const state = this.states[this.activeTab];
    const max = this.allOptions(q).length - 1;
    state.cursorIndex = Math.max(0, Math.min(max, state.cursorIndex + delta));
    this.invalidate();
    this.tui.requestRender();
  }

  private toggleSelected(index: number): void {
    const state = this.states[this.activeTab];
    if (state.selectedIndices.has(index)) {
      state.selectedIndices.delete(index);
    } else {
      state.selectedIndices.add(index);
    }
    // If all answers removed, un-confirm so Submit tab blocks correctly
    if (state.selectedIndices.size === 0 && state.freeTextValue === null) {
      state.confirmed = false;
    }
    this.invalidate();
    this.tui.requestRender();
  }

  private enterEditMode(): void {
    const state = this.states[this.activeTab];
    state.inEditMode = true;
    this.editor.focused = this.focused;
    this.editor.setText(state.draft);
    this.invalidate();
    this.tui.requestRender();
  }

  private exitEditMode(save: boolean): void {
    const state = this.states[this.activeTab];
    if (save) {
      state.freeTextValue = this.editor.getExpandedText().trim();
      // Free-text replaces any prior regular-option selection — clear the ✓ indicator
      state.selectedIndex = null;
    }
    state.draft = this.editor.getExpandedText();
    this.editor.setText("");
    state.inEditMode = false;
    this.editor.focused = false;
    this.invalidate();
  }

  private autoConfirmIfAnswered(): void {
    const q = this.questions[this.activeTab];
    const state = this.states[this.activeTab];
    if (!q || !state || state.confirmed) return;
    if (q.multiSelect) {
      if (state.selectedIndices.size > 0 || state.freeTextValue !== null) {
        state.confirmed = true;
      }
    } else {
      if (state.freeTextValue !== null || state.selectedIndex !== null) {
        state.confirmed = true;
      }
    }
  }

  private confirmAndAdvance(): void {
    const state = this.states[this.activeTab];
    state.confirmed = true;
    this.advance();
  }

  private advance(): void {
    if (this.isSingle) {
      this.submit();
      return;
    }
    if (this.activeTab < this.questions.length - 1) {
      this.activeTab++;
    } else {
      this.activeTab = this.questions.length; // Submit tab
    }
    this.invalidate();
    this.tui.requestRender();
  }

  private submit(): void {
    this._resolved = true;
    this.done(this.buildResult());
  }

  private cancel(): void {
    this._resolved = true;
    this.done(null);
  }

  private buildResult(): Result {
    const answers: Record<string, string> = {};
    const answerDetails: AnswerDetail[] = [];
    for (let i = 0; i < this.questions.length; i++) {
      const q = this.questions[i];
      const s = this.states[i];
      if (!s.confirmed) continue;
      const selectedLabels = q.multiSelect
        ? [...s.selectedIndices].sort((a, b) => a - b).map((idx) => q.options[idx].label)
        : s.selectedIndex === null ? [] : [q.options[s.selectedIndex].label];
      answerDetails.push({
        questionIndex: i,
        kind: q.multiSelect ? "multi" : s.freeTextValue !== null ? "custom" : "option",
        selectedLabels,
        ...(s.freeTextValue !== null ? { customText: s.freeTextValue } : {}),
        ...(s.note ? { note: s.note } : {}),
      });
      if (q.multiSelect) {
        const labels = [...s.selectedIndices]
          .sort((a, b) => a - b)
          .map((idx) => q.options[idx].label);
        if (s.freeTextValue !== null) labels.push(s.freeTextValue);
        answers[q.question] = labels.join(", ");
      } else if (s.freeTextValue !== null) {
        answers[q.question] = s.freeTextValue;
      } else if (s.selectedIndex !== null) {
        answers[q.question] = q.options[s.selectedIndex].label;
      }
    }
    return { questions: this.questions, answers, answerDetails, ...(this.globalNote ? { globalNote: this.globalNote } : {}), cancelled: false };
  }

  // ── handleInput() ────────────────────────────────────────────────────────────

  handleInput(data: string): void {
    // Guard: once done has been called, ignore all further input
    if (this._resolved) return;

    const state = this.states[this.activeTab];
    const q = this.questions[this.activeTab];
    const confirm = this.matches(data, "tui.select.confirm") || this.matches(data, "tui.input.submit");
    const cancel = this.matches(data, "tui.select.cancel");

    if (this.isEditing) {
      // Newline takes precedence only inside an editor.
      if (this.matches(data, "tui.input.newLine")) {
        this.editor.insertTextAtCursor("\n");
      } else if (this.editingNote && (this.matches(data, "tui.input.submit") || cancel)) {
        const note = this.editor.getExpandedText();
        if (!q) this.globalNote = note;
        else state.note = note;
        this.editingNote = false;
        this.editor.focused = false;
      } else if (!this.editingNote && cancel) {
        this.exitEditMode(false);
      } else if (!this.editingNote && this.matches(data, "tui.input.submit")) {
        if (this.editor.getExpandedText().trim()) {
          this.exitEditMode(true);
          this.confirmAndAdvance();
        } else {
          state.freeTextValue = null;
          if (q.multiSelect ? state.selectedIndices.size === 0 : state.selectedIndex === null) state.confirmed = false;
          this.exitEditMode(false);
        }
      } else {
        const cursor = this.editor.getCursor();
        // Public wrapping/cursor APIs keep Up in wrapped continuation lines.
        // No private Editor fields or deep package imports (Pi aliases peers).
        const firstLine = wrapTextWithAnsi(this.editor.getLines()[0], this.editorWidth);
        const atTop = cursor.line === 0 && (firstLine.length === 1 || cursor.col < firstLine[0].length);
        if (!this.editingNote && this.matches(data, "tui.editor.cursorUp") && atTop) {
          this.exitEditMode(false);
          this.moveCursor(-1);
        } else {
          this.editorInput(data);
        }
      }
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    if (cancel) { this.cancel(); return; }
    if (!this.isSingle && (matchesKey(data, Key.right) || matchesKey(data, Key.left) || matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab")))) {
      if (q) this.autoConfirmIfAnswered();
      const delta = matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab")) ? -1 : 1;
      this.activeTab = (this.activeTab + delta + this.totalTabs) % this.totalTabs;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (data === "n" && !confirm && !this.matches(data, "tui.select.up") && !this.matches(data, "tui.select.down") && (!q || state.cursorIndex !== q.options.length)) {
      this.editingNote = true;
      this.editor.setText(q ? state.note : this.globalNote);
      this.editor.focused = this.focused;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (!q) {
      if (confirm && this.allConfirmed()) this.submit();
      return;
    }

    // ── Question tab ───────────────────────────────────────────────────────────
    if (this.matches(data, "tui.select.up")) {
      this.moveCursor(-1);
      return;
    }

    if (this.matches(data, "tui.select.down")) {
      this.moveCursor(1);
      return;
    }

    const opts = this.allOptions(q);
    const onOther = state.cursorIndex === opts.length - 1;

    // Type directly into the visible answer box; Space/Tab still work as shortcuts.
    if (onOther) {
      if (confirm) {
        if (state.freeTextValue !== null && state.draft.trim() === state.freeTextValue) this.confirmAndAdvance();
        else this.enterEditMode();
        return;
      }
      if (matchesKey(data, Key.space) || matchesKey(data, Key.tab)) {
        this.enterEditMode();
        return;
      }
      if (([...data].length === 1 && data >= " " && data !== "\x7f") || data.startsWith("\x1b[200~")) {
        this.enterEditMode();
        this.editorInput(data);
        this.invalidate();
        this.tui.requestRender();
        return;
      }
    }

    if (q.multiSelect) {
      if (matchesKey(data, Key.space) && !onOther) {
        // Space = toggle selection
        this.toggleSelected(state.cursorIndex);
        return;
      }
      if (confirm && !onOther) {
        if (state.selectedIndices.size > 0 || state.freeTextValue !== null) {
          this.confirmAndAdvance();
        }
        return;
      }
    } else {
      if (confirm && !onOther) {
        // Record explicit selection and clear any free-text
        state.selectedIndex = state.cursorIndex;
        state.freeTextValue = null;
        this.confirmAndAdvance();
        return;
      }
    }
  }
}
