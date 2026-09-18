/**
 * conversation-viewer.ts — Live conversation overlay for viewing agent sessions.
 *
 * Displays a scrollable, live-updating view of an agent's conversation.
 * Subscribes to session events for real-time streaming updates.
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { type Component, Input, Markdown, type MarkdownOptions, type MarkdownTheme, matchesKey, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderAgentName } from "../agent-color.js";
import type { SubagentSession } from "../backend.js";
import { extractText } from "../context.js";
import type { AgentRecord, ViewerMarkdownMode } from "../types.js";
import { getLifetimeCost, getLifetimeTotal, getSessionContextPercent } from "../usage.js";
import type { Theme } from "./agent-widget.js";
import { type AgentActivity, buildInvocationTags, describeActivity, fgPreservingNestedStyles, formatCost, formatDuration, formatSessionTokens, getPromptModeLabel } from "./agent-widget.js";
import { createViewerKeys, type ViewerKeybindings, type ViewerKeys } from "./viewer-keys.js";

/** Base lines consumed by chrome: top border + header + header sep + footer sep + footer + bottom border. */
const CHROME_LINES_BASE = 6;
const TOOL_ARGUMENT_PREVIEW_MAX = 140;
/** Coalesce streaming deltas into at most ~30 transcript paints per second. */
const LIVE_RENDER_INTERVAL_MS = 33;
/** Bound one displayed tool result or bash output without returning to the old 500-character cut. */
export const RESULT_MAX_CHARS = 16_000;

const MARKDOWN_MODES: readonly ViewerMarkdownMode[] = ["off", "assistant", "all"];
const MARKDOWN_MODE_LABELS: Record<ViewerMarkdownMode, string> = {
  off: "raw",
  assistant: "md",
  all: "md+",
};
const MARKDOWN_OPTIONS: MarkdownOptions = {
  preserveOrderedListMarkers: true,
  preserveBackslashEscapes: true,
};

function fallbackMarkdownTheme(th: Theme): MarkdownTheme {
  const sgr = (on: number, off: number) => (text: string) => `\x1b[${on}m${text}\x1b[${off}m`;
  return {
    heading: text => th.bold(th.fg("accent", text)),
    link: text => th.fg("accent", text),
    linkUrl: text => th.fg("muted", text),
    code: text => th.fg("muted", text),
    codeBlock: text => th.fg("muted", text),
    codeBlockBorder: text => th.fg("dim", text),
    quote: text => th.fg("muted", text),
    quoteBorder: text => th.fg("dim", text),
    hr: text => th.fg("dim", text),
    listBullet: text => th.fg("accent", text),
    bold: text => th.bold(text),
    italic: sgr(3, 23),
    underline: sgr(4, 24),
    strikethrough: sgr(9, 29),
  };
}

/** Probe eagerly because pi's Markdown theme can otherwise fail lazily during render in tests/embedders. */
function resolveMarkdownTheme(th: Theme): MarkdownTheme {
  try {
    const piTheme = getMarkdownTheme();
    piTheme.heading("probe");
    return piTheme;
  } catch {
    return fallbackMarkdownTheme(th);
  }
}

function capResult(text: string): { text: string; elided: number } {
  if (text.length <= RESULT_MAX_CHARS) return { text, elided: 0 };
  return { text: text.slice(0, RESULT_MAX_CHARS), elided: text.length - RESULT_MAX_CHARS };
}

function humanCount(n: number): string {
  if (n < 1_000) return `${n}`;
  const thousands = n < 999_950;
  const value = thousands ? n / 1_000 : n / 1_000_000;
  return `${value.toFixed(1).replace(/\.0$/, "")}${thousands ? "k" : "M"}`;
}

function truncationNote(elided: number): string {
  return `... (truncated, ${humanCount(elided)} more character${elided === 1 ? "" : "s"})`;
}

/** Cheap mutation snapshot for the live tail; string references catch streamed replacements without scanning their bytes. */
function messageState(message: SubagentSession["messages"][number] | undefined): unknown[] {
  if (!message) return [];
  const msg = message as any;
  const state: unknown[] = [message, msg.role, msg.content, msg.command, msg.output, msg.exitCode, msg.cancelled, msg.isError, msg.toolCallId, msg.toolUseId];
  if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      state.push(part, part?.type, part?.text, part?.thinking, part?.redacted, part?.id, part?.toolUseId, part?.name, part?.toolName, part?.arguments);
    }
  }
  return state;
}

function sameState(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Full-terminal overlay shared by FleetView and `/agents` running-agent views. */
export const CONVERSATION_OVERLAY_OPTIONS = {
  anchor: "center",
  width: "100%",
  maxHeight: "100%",
} as const;

function toolArgumentPreview(args: Record<string, unknown> | undefined): string | undefined {
  if (!args || Object.keys(args).length === 0) return undefined;
  let raw: string;
  if (typeof args.preview === "string") {
    raw = args.preview;
  } else {
    try {
      raw = JSON.stringify(args);
    } catch {
      return undefined;
    }
  }
  const oneLine = raw.replace(/\s+/g, " ").trim();
  if (!oneLine) return undefined;
  return oneLine.length <= TOOL_ARGUMENT_PREVIEW_MAX
    ? oneLine
    : oneLine.slice(0, TOOL_ARGUMENT_PREVIEW_MAX - 1) + "…";
}

export class ConversationViewer implements Component {
  private scrollOffset = 0;
  private autoScroll = true;
  private unsubscribe: (() => void) | undefined;
  private lastInnerW = 0;
  private closed = false;
  /** Two-press confirm guard for the stop key, so a stray key can't kill the agent. */
  private stopArmed = false;
  private toolsExpanded = false;
  private keys: ViewerKeys;
  /** Steering composer — present while the user is typing a message to the agent. */
  private composer: Input | undefined;
  private liveRenderTimer: ReturnType<typeof setTimeout> | undefined;
  private contentDirty = true;
  private cachedContentWidth = 0;
  private cachedContentLines: string[] = [];
  private cachedMarkdownMode: ViewerMarkdownMode | undefined;
  private cachedMessageCount = -1;
  private cachedTailState: unknown[] = [];
  /** Finalized messages already rendered into stableContentLines. */
  private stableMessages: unknown[] = [];
  private stableToolResults: unknown[] = [];
  private stableToolResultStates: unknown[][] = [];
  private stableContentLines: string[] = [];
  private stableHasContent = false;
  private readonly markdownTheme: MarkdownTheme;
  private markdownModeOverride: ViewerMarkdownMode | undefined;
  /** One reusable Markdown component per message; compacted messages remain collectible. */
  private markdownCache = new WeakMap<object, { md: Markdown; text: string; failed?: boolean }>();

  constructor(
    private tui: TUI,
    private session: SubagentSession,
    private record: AgentRecord,
    private activity: AgentActivity | undefined,
    private theme: Theme,
    private done: (result: undefined) => void,
    /** Abort the agent shown here. Omitted → no stop affordance (e.g. read-only history). */
    private onStop?: () => void,
    /** User keybindings from `ctx.ui.custom()`. Omitted → hardcoded defaults. */
    keybindings?: ViewerKeybindings,
    /** Send a steering message to the agent. Omitted → no compose affordance. */
    private onSteer?: (message: string) => void,
    /**
     * Whether the header shows an estimated cost after the token count. Read
     * once, at construction: the overlay is opened from a menu, so the setting
     * cannot change while it is on screen.
     */
    private showCost = false,
    /** Live viewer setting; omitted defaults to assistant-only Markdown. */
    private viewerMarkdown?: () => ViewerMarkdownMode,
    /** Persist an `m`-selected mode; omitted keeps the cycle local to this viewer. */
    private onMarkdownMode?: (mode: ViewerMarkdownMode) => void,
  ) {
    this.markdownTheme = resolveMarkdownTheme(theme);
    this.keys = createViewerKeys(keybindings);
    this.unsubscribe = session.subscribe(() => {
      if (this.closed) return;
      this.contentDirty = true;
      if (this.liveRenderTimer) return;
      this.liveRenderTimer = setTimeout(() => {
        this.liveRenderTimer = undefined;
        if (!this.closed) this.tui.requestRender();
      }, LIVE_RENDER_INTERVAL_MS);
    });
  }

  handleInput(data: string): void {
    // While composing a steer message, the input owns all keys (Enter sends,
    // Esc cancels — both wired in openComposer()). Editing keys flow through.
    if (this.composer) {
      this.composer.handleInput(data);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
      this.closed = true;
      this.done(undefined);
      return;
    }

    if (this.keys.toggleTools(data)) {
      this.toolsExpanded = !this.toolsExpanded;
      this.resetContentCache();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "m")) {
      this.stopArmed = false;
      const next = MARKDOWN_MODES[(MARKDOWN_MODES.indexOf(this.markdownMode()) + 1) % MARKDOWN_MODES.length];
      this.markdownModeOverride = next;
      this.onMarkdownMode?.(next);
      this.resetContentCache();
      this.tui.requestRender();
      return;
    }

    // Enter opens the steering composer (only while the agent can still be
    // steered) — then type + Enter sends, Esc or an empty submit returns. When
    // not steerable, fall through so the key still disarms a pending stop.
    if (matchesKey(data, "enter") && this.canSteer()) {
      this.stopArmed = false;
      this.openComposer();
      return;
    }

    // Stop/abort the agent (only while it can still be stopped). Two-press:
    // first "x" arms, second confirms — any other key disarms.
    if (matchesKey(data, "x")) {
      if (this.isStoppable()) {
        if (this.stopArmed) {
          this.stopArmed = false;
          this.onStop?.();
        } else {
          this.stopArmed = true;
        }
        this.tui.requestRender();
      }
      return;
    }
    if (this.stopArmed) this.stopArmed = false;

    const totalLines = this.buildContentLines(this.lastInnerW).length;
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, totalLines - viewportHeight);

    if (matchesKey(data, "ctrl+up") || matchesKey(data, "home") || matchesKey(data, "ctrl+home")) {
      this.scrollOffset = 0;
      this.autoScroll = false;
    } else if (matchesKey(data, "ctrl+down") || matchesKey(data, "end") || matchesKey(data, "ctrl+end")) {
      this.scrollOffset = maxScroll;
      this.autoScroll = true;
    } else if (this.keys.pageUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
      this.autoScroll = false;
    } else if (this.keys.pageDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (this.keys.scrollUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (this.keys.scrollDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    }
  }

  render(width: number): string[] {
    // Another UI event may have triggered a paint before the coalescing timer.
    // That paint consumes the dirty transcript, so suppress the redundant one.
    if (this.liveRenderTimer) {
      clearTimeout(this.liveRenderTimer);
      this.liveRenderTimer = undefined;
    }
    if (width < 6) return []; // too narrow for any meaningful rendering
    const th = this.theme;
    const innerW = width - 4; // border + padding
    this.lastInnerW = innerW;
    const lines: string[] = [];

    const pad = (s: string, len: number) => {
      const vis = visibleWidth(s);
      return s + " ".repeat(Math.max(0, len - vis));
    };
    const row = (content: string) =>
      th.fg("border", "│") + " " + truncateToWidth(pad(content, innerW), innerW, "...", true) + " " + th.fg("border", "│");
    const hrTop = th.fg("border", `╭${"─".repeat(width - 2)}╮`);
    const hrBot = th.fg("border", `╰${"─".repeat(width - 2)}╯`);
    const hrMid = row(th.fg("dim", "─".repeat(innerW)));

    // Header
    lines.push(hrTop);
    const modeLabel = getPromptModeLabel(this.record.type);
    const modeTag = modeLabel ? ` ${th.fg("dim", `(${modeLabel})`)}` : "";
    const statusIcon = this.record.status === "running"
      ? th.fg("accent", "●")
      : this.record.status === "completed"
        ? th.fg("success", "✓")
        : this.record.status === "error"
          ? th.fg("error", "✗")
          : th.fg("dim", "○");
    const duration = formatDuration(this.record.startedAt, this.record.completedAt);

    const headerParts: string[] = [duration];
    const toolUses = this.activity?.toolUses ?? this.record.toolUses;
    if (toolUses > 0) headerParts.unshift(`${toolUses} tool${toolUses === 1 ? "" : "s"}`);
    // Spend from the record, context from the live session: the record is the
    // only total that survives the agent finishing and the only one carrying a
    // nested child's spend.
    const tokens = getLifetimeTotal(this.record.lifetimeUsage);
    if (tokens > 0) {
      const percent = getSessionContextPercent(this.activity?.session);
      headerParts.push(formatSessionTokens(tokens, percent, th, this.record.compactionCount));
    }
    const cost = this.showCost ? formatCost(getLifetimeCost(this.record.lifetimeUsage)) : "";
    if (cost) headerParts.push(cost);

    lines.push(row(
      `${statusIcon} ${renderAgentName(this.record.type, th, { bold: true })}${modeTag}  ${th.fg("muted", this.record.description)} ${th.fg("dim", "·")} ${fgPreservingNestedStyles(th, "dim", headerParts.join(" · "))}`,
    ));
    const invocationLine = this.invocationLine();
    if (invocationLine) lines.push(row(invocationLine));
    lines.push(hrMid);

    // Reuse stable history and rebuild only content invalidated by live events.
    const contentLines = this.buildContentLines(innerW);
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);

    if (this.autoScroll) {
      this.scrollOffset = maxScroll;
    }

    const visibleStart = Math.min(this.scrollOffset, maxScroll);
    const visible = contentLines.slice(visibleStart, visibleStart + viewportHeight);

    for (let i = 0; i < viewportHeight; i++) {
      lines.push(row(visible[i] ?? ""));
    }

    // Footer
    lines.push(hrMid);
    if (this.composer) {
      // Composer row: the Input renders its own `> ` prompt and cursor.
      lines.push(row(this.composer.render(innerW)[0] ?? ""));
      const composeHint = th.fg("dim", "Enter send · Esc cancel");
      const composeLeft = th.fg("accent", "✎ steer");
      const composeGap = Math.max(1, innerW - visibleWidth(composeLeft) - visibleWidth(composeHint));
      lines.push(row(composeLeft + " ".repeat(composeGap) + composeHint));
    } else {
      // Actions on the left, navigation on the right. The scroll hint keeps its
      // full key list so the less-obvious bindings stay discoverable; it leads
      // the right group so "Esc close" is the only part that truncates first.
      const sep = th.fg("dim", " · ");
      const actions: string[] = [th.fg("dim", `Ctrl+O ${this.toolsExpanded ? "collapse" : "tools"}`)];
      if (this.canSteer()) actions.push(th.fg("dim", "Enter steer"));
      if (this.isStoppable()) {
        actions.push(this.stopArmed ? th.fg("error", "x again to STOP") : th.fg("dim", "x stop"));
      }
      actions.push(th.fg("dim", `m ${MARKDOWN_MODE_LABELS[this.markdownMode()]}`));
      const footerRight = th.fg("dim", "↑↓ lines · Alt+↑↓ pages · Ctrl+↑↓ top/end · Esc close");

      // Prepend the line-count/scroll-% readout only when there's spare width —
      // it's the first thing dropped so it never crowds out the hints.
      const scrollPct = contentLines.length <= viewportHeight
        ? "100%"
        : `${Math.round(((visibleStart + viewportHeight) / contentLines.length) * 100)}%`;
      const count = th.fg("dim", `${contentLines.length} lines · ${scrollPct}`);
      const withCount = [count, ...actions].join(sep);
      const footerLeft = visibleWidth(withCount) + visibleWidth(footerRight) + 1 <= innerW
        ? withCount
        : actions.join(sep);

      const footerGap = Math.max(1, innerW - visibleWidth(footerLeft) - visibleWidth(footerRight));
      lines.push(row(footerLeft + " ".repeat(footerGap) + footerRight));
    }
    lines.push(hrBot);

    return lines;
  }

  /** Stoppable only when a stop handler exists and the agent is still active. */
  private isStoppable(): boolean {
    return !!this.onStop && (this.record.status === "running" || this.record.status === "queued");
  }

  private markdownMode(): ViewerMarkdownMode {
    return this.markdownModeOverride ?? this.viewerMarkdown?.() ?? "assistant";
  }

  private rawLines(text: string, width: number, color?: "dim" | "error"): string[] {
    const lines = wrapTextWithAnsi(text, width);
    return color ? lines.map(line => this.theme.fg(color, line)) : lines;
  }

  /** Render Markdown with per-message parser caches and a remembered literal fallback. */
  private markdownLines(
    msg: SubagentSession["messages"][number],
    text: string,
    width: number,
    color?: "dim" | "error",
  ): string[] {
    let entry = this.markdownCache.get(msg);
    if (!entry) {
      entry = {
        md: new Markdown(
          text,
          0,
          0,
          this.markdownTheme,
          color ? { color: (value: string) => this.theme.fg(color, value) } : undefined,
          MARKDOWN_OPTIONS,
        ),
        text,
      };
      this.markdownCache.set(msg, entry);
    } else if (entry.text !== text) {
      const shouldRetry = !text.startsWith(entry.text);
      entry.md.setText(text);
      entry.text = text;
      if (shouldRetry) entry.failed = false;
    }
    if (entry.failed) return this.rawLines(text, width, color);

    try {
      return entry.md.render(width);
    } catch {
      entry.failed = true;
      return this.rawLines(text, width, color);
    }
  }

  private outputLines(
    msg: SubagentSession["messages"][number],
    text: string,
    width: number,
    color: "dim" | "error",
    markdown: boolean,
    indent = "",
  ): string[] {
    const contentWidth = Math.max(1, width - visibleWidth(indent));
    const rendered = markdown
      ? this.markdownLines(msg, text, contentWidth, color)
      : this.rawLines(text, contentWidth, color);
    return rendered.map(line => indent + line);
  }

  /** Steerable only when a steer handler exists and the agent is still active. */
  private canSteer(): boolean {
    return !!this.onSteer && (this.record.status === "running" || this.record.status === "queued");
  }

  /** Open the inline steering composer and route subsequent input to it. */
  private openComposer(): void {
    const input = new Input();
    input.focused = true;
    input.onSubmit = (value: string) => {
      const message = value.trim();
      this.composer = undefined;
      if (message) this.onSteer?.(message);
      this.tui.requestRender();
    };
    input.onEscape = () => {
      this.composer = undefined;
      this.tui.requestRender();
    };
    this.composer = input;
    this.tui.requestRender();
  }

  invalidate(): void {
    this.resetContentCache();
    this.markdownCache = new WeakMap();
  }

  dispose(): void {
    this.closed = true;
    if (this.liveRenderTimer) {
      clearTimeout(this.liveRenderTimer);
      this.liveRenderTimer = undefined;
    }
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  // ---- Private ----

  private viewportHeight(): number {
    return Math.max(0, this.tui.terminal.rows - this.chromeLines());
  }

  private chromeLines(): number {
    // The composer adds one row above the footer hint while it's open.
    return CHROME_LINES_BASE + (this.invocationLine() ? 1 : 0) + (this.composer ? 1 : 0);
  }

  private invocationLine(): string | undefined {
    // Canonical id here, short label everywhere else: this overlay is opened to
    // inspect one agent and has the width for it, and two providers can serve
    // models whose short names read alike.
    const { modelName, modelId, tags } = buildInvocationTags(this.record.invocation);
    const model = modelId ?? modelName;
    const parts = model ? [model, ...tags] : tags;
    if (parts.length === 0) return undefined;
    return this.theme.fg("dim", `  ↳ ${parts.join(" · ")}`);
  }

  private resetContentCache(): void {
    this.contentDirty = true;
    this.cachedContentWidth = 0;
    this.cachedContentLines = [];
    this.cachedMarkdownMode = undefined;
    this.cachedMessageCount = -1;
    this.cachedTailState = [];
    this.stableMessages = [];
    this.stableToolResults = [];
    this.stableToolResultStates = [];
    this.stableContentLines = [];
    this.stableHasContent = false;
  }

  /** Render one message without the separator that precedes it. */
  private renderMessageBlock(
    msg: SubagentSession["messages"][number],
    width: number,
    toolResults: Map<string, SubagentSession["messages"][number]>,
    pairedToolIds: Set<string>,
  ): string[] {
    const th = this.theme;
    const lines: string[] = [];
    const markdownMode = this.markdownMode();
    if (msg.role === "user") {
      const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
      if (!text.trim()) return [];
      lines.push(th.fg("accent", "[User]"));
      lines.push(...wrapTextWithAnsi(text.trim(), width));
    } else if (msg.role === "assistant") {
      const textParts: string[] = [];
      const thinkingParts: string[] = [];
      const toolCalls: Array<{ id?: string; name: string; preview?: string }> = [];
      for (const c of msg.content) {
        if (c.type === "text" && c.text) textParts.push(c.text);
        else if (c.type === "thinking" && (c.thinking || c.redacted)) {
          thinkingParts.push(c.redacted ? "[redacted]" : c.thinking);
        } else if (c.type === "toolCall") {
          const call = c as typeof c & { id?: string; toolUseId?: string };
          toolCalls.push({ id: call.id ?? call.toolUseId, name: c.name, preview: toolArgumentPreview(c.arguments) });
        }
      }
      if (textParts.length > 0 || thinkingParts.length > 0) lines.push(th.bold("[Assistant]"));
      if (textParts.length > 0) {
        const text = textParts.join("\n").trim();
        lines.push(...(markdownMode === "off"
          ? this.rawLines(text, width)
          : this.markdownLines(msg, text, width)));
      }
      for (const thinking of thinkingParts) {
        lines.push(th.fg("dim", "[Thinking]"));
        for (const line of wrapTextWithAnsi(thinking.trim(), width)) lines.push(th.fg("dim", line));
      }
      for (const tool of toolCalls) {
        const result = tool.id ? toolResults.get(tool.id) : undefined;
        const failed = result?.role === "toolResult" && !!result.isError;
        const icon = result
          ? (failed ? th.fg("error", "✗") : th.fg("success", "✓"))
          : this.record.status === "running" || this.record.status === "queued"
            ? th.fg("accent", "●")
            : th.fg("dim", "○");
        const preview = tool.preview ? ` ${tool.preview}` : "";
        lines.push(`${icon} ${th.fg("muted", `[Tool: ${tool.name}]${preview}`)}`);
        if (result?.role === "toolResult" && (this.toolsExpanded || failed)) {
          const { text, elided } = capResult(extractText(result.content).trim());
          const color = failed ? "error" : "dim";
          lines.push(th.fg(color, failed ? "  [Result: Error]" : "  [Result]"));
          if (text) lines.push(...this.outputLines(result, text, width, color, markdownMode === "all", "  "));
          if (elided) lines.push(`  ${th.fg(color, truncationNote(elided))}`);
        }
      }
    } else if (msg.role === "toolResult") {
      const result = msg as typeof msg & { toolCallId?: string; toolUseId?: string };
      const id = result.toolCallId ?? result.toolUseId;
      if (id && pairedToolIds.has(id)) return [];
      const { text, elided } = capResult(extractText(msg.content).trim());
      if (!text && !msg.isError) return [];
      const resultColor = msg.isError ? "error" : "dim";
      lines.push(th.fg(resultColor, msg.isError ? "[Result: Error]" : "[Result]"));
      if (text) lines.push(...this.outputLines(msg, text, width, resultColor, markdownMode === "all"));
      if (elided) lines.push(th.fg(resultColor, truncationNote(elided)));
    } else if ((msg as any).role === "bashExecution") {
      const bash = msg as any;
      const failed = bash.cancelled || (typeof bash.exitCode === "number" && bash.exitCode !== 0);
      const icon = failed ? th.fg("error", "✗") : th.fg("success", "✓");
      lines.push(`${icon} ${th.fg("muted", `$ ${bash.command}`)}`);
      if (bash.output?.trim() && (this.toolsExpanded || failed)) {
        const { text, elided } = capResult(bash.output.trim());
        const color = failed ? "error" : "dim";
        lines.push(...this.rawLines(text, Math.max(1, width - 2), color).map(line => `  ${line}`));
        if (elided) lines.push(`  ${th.fg(color, truncationNote(elided))}`);
      }
    }
    return lines.map(line => truncateToWidth(line, width));
  }

  private appendBlock(target: string[], block: string[], hasContent: boolean): boolean {
    if (block.length === 0) return hasContent;
    if (hasContent) target.push(this.theme.fg("dim", "───"));
    target.push(...block);
    return true;
  }

  private buildContentLines(width: number): string[] {
    if (width <= 0) return [];

    const messages = this.session.messages;
    const mode = this.markdownMode();
    const tailState = messageState(messages[messages.length - 1]);
    if (
      !this.contentDirty
      && width === this.cachedContentWidth
      && mode === this.cachedMarkdownMode
      && messages.length === this.cachedMessageCount
      && sameState(tailState, this.cachedTailState)
    ) return this.cachedContentLines;

    if (messages.length === 0) {
      this.cachedContentWidth = width;
      this.cachedContentLines = [this.theme.fg("dim", "(waiting for first message...)")];
      this.cachedMarkdownMode = mode;
      this.cachedMessageCount = 0;
      this.cachedTailState = tailState;
      this.contentDirty = false;
      return this.cachedContentLines;
    }

    const toolResults = new Map<string, SubagentSession["messages"][number]>();
    const pairedToolIds = new Set<string>();
    const resultMessages: SubagentSession["messages"][number][] = [];
    for (const message of messages) {
      if (message.role === "assistant") {
        for (const content of message.content) {
          if (content.type !== "toolCall") continue;
          const call = content as typeof content & { id?: string; toolUseId?: string };
          const id = call.id ?? call.toolUseId;
          if (id) pairedToolIds.add(id);
        }
      } else if (message.role === "toolResult") {
        resultMessages.push(message);
        const result = message as typeof message & { toolCallId?: string; toolUseId?: string };
        const id = result.toolCallId ?? result.toolUseId;
        if (id) toolResults.set(id, message);
      }
    }

    const stableCount = messages.length - 1;
    const stablePrefixStillValid = width === this.cachedContentWidth
      && this.stableMessages.length <= stableCount
      && this.stableMessages.every((message, index) => message === messages[index]);
    const resultStates = resultMessages.map(messageState);
    const toolResultsStillValid = this.stableToolResults.length === resultMessages.length
      && this.stableToolResults.every((message, index) => message === resultMessages[index])
      && this.stableToolResultStates.every((state, index) => sameState(state, resultStates[index] ?? []));
    if (!stablePrefixStillValid || !toolResultsStillValid) {
      this.stableMessages = [];
      this.stableContentLines = [];
      this.stableHasContent = false;
    }
    this.stableToolResults = resultMessages;
    this.stableToolResultStates = resultStates;

    // Completed history is immutable during ordinary streaming. Render each
    // message once; only the live tail is rebuilt for each delta. A compaction
    // replaces the prefix references, trips the guard above, and rebuilds it.
    while (this.stableMessages.length < stableCount) {
      const message = messages[this.stableMessages.length];
      const block = this.renderMessageBlock(message, width, toolResults, pairedToolIds);
      this.stableHasContent = this.appendBlock(this.stableContentLines, block, this.stableHasContent);
      this.stableMessages.push(message);
    }

    const lines = [...this.stableContentLines];
    let hasContent = this.stableHasContent;
    const liveBlock = this.renderMessageBlock(messages[messages.length - 1], width, toolResults, pairedToolIds);
    hasContent = this.appendBlock(lines, liveBlock, hasContent);

    // Streaming indicator for running agents.
    if (this.record.status === "running" && this.activity) {
      const act = describeActivity(this.activity.activeTools, this.activity.responseText);
      if (hasContent) lines.push("");
      lines.push(truncateToWidth(this.theme.fg("accent", "▍ ") + this.theme.fg("dim", act), width));
    }

    this.cachedContentWidth = width;
    this.cachedContentLines = lines;
    this.cachedMarkdownMode = mode;
    this.cachedMessageCount = messages.length;
    this.cachedTailState = tailState;
    this.contentDirty = false;
    return lines;
  }
}
