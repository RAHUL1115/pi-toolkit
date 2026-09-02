/**
 * conversation-viewer.ts — Live conversation overlay for viewing agent sessions.
 *
 * Displays a scrollable, live-updating view of an agent's conversation.
 * Subscribes to session events for real-time streaming updates.
 */

import { type Component, Input, matchesKey, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderAgentName } from "../agent-color.js";
import type { SubagentSession } from "../backend.js";
import { extractText } from "../context.js";
import type { AgentRecord } from "../types.js";
import { getLifetimeCost, getLifetimeTotal, getSessionContextPercent } from "../usage.js";
import type { Theme } from "./agent-widget.js";
import { type AgentActivity, buildInvocationTags, describeActivity, fgPreservingNestedStyles, formatCost, formatDuration, formatSessionTokens, getPromptModeLabel } from "./agent-widget.js";
import { createViewerKeys, type ViewerKeybindings, type ViewerKeys } from "./viewer-keys.js";

/** Base lines consumed by chrome: top border + header + header sep + footer sep + footer + bottom border. */
const CHROME_LINES_BASE = 6;
const TOOL_ARGUMENT_PREVIEW_MAX = 160;
/** Coalesce streaming deltas into at most ~30 transcript paints per second. */
const LIVE_RENDER_INTERVAL_MS = 33;

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
  private keys: ViewerKeys;
  /** Steering composer — present while the user is typing a message to the agent. */
  private composer: Input | undefined;
  private liveRenderTimer: ReturnType<typeof setTimeout> | undefined;
  private contentDirty = true;
  private cachedContentWidth = 0;
  private cachedContentLines: string[] = [];
  /** Finalized messages already rendered into stableContentLines. */
  private stableMessages: unknown[] = [];
  private stableContentLines: string[] = [];
  private stableHasContent = false;

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
  ) {
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

    if (this.keys.scrollUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (this.keys.scrollDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (this.keys.pageUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
      this.autoScroll = false;
    } else if (this.keys.pageDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "home") || matchesKey(data, "ctrl+home")) {
      this.scrollOffset = 0;
      this.autoScroll = false;
    } else if (matchesKey(data, "end") || matchesKey(data, "ctrl+end")) {
      this.scrollOffset = maxScroll;
      this.autoScroll = true;
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

    // Content area — rebuild every render (live data, no cache needed)
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
      const actions: string[] = [];
      if (this.canSteer()) actions.push(th.fg("dim", "Enter steer"));
      if (this.isStoppable()) {
        actions.push(this.stopArmed ? th.fg("error", "x again to STOP") : th.fg("dim", "x stop"));
      }
      const footerRight = th.fg("dim", "↑↓ scroll · PgUp/PgDn page · Home/End jump · Esc close");

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
    this.stableMessages = [];
    this.stableContentLines = [];
    this.stableHasContent = false;
  }

  /** Render one message without the separator that precedes it. */
  private renderMessageBlock(msg: SubagentSession["messages"][number], width: number): string[] {
    const th = this.theme;
    const lines: string[] = [];
    if (msg.role === "user") {
      const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
      if (!text.trim()) return [];
      lines.push(th.fg("accent", "[User]"));
      lines.push(...wrapTextWithAnsi(text.trim(), width));
    } else if (msg.role === "assistant") {
      const textParts: string[] = [];
      const thinkingParts: string[] = [];
      const toolCalls: Array<{ name: string; preview?: string }> = [];
      for (const c of msg.content) {
        if (c.type === "text" && c.text) textParts.push(c.text);
        else if (c.type === "thinking" && (c.thinking || c.redacted)) {
          thinkingParts.push(c.redacted ? "[redacted]" : c.thinking);
        } else if (c.type === "toolCall") {
          toolCalls.push({ name: c.name, preview: toolArgumentPreview(c.arguments) });
        }
      }
      lines.push(th.bold("[Assistant]"));
      if (textParts.length > 0) lines.push(...wrapTextWithAnsi(textParts.join("\n").trim(), width));
      for (const thinking of thinkingParts) {
        lines.push(th.fg("dim", "[Thinking]"));
        for (const line of wrapTextWithAnsi(thinking.trim(), width)) lines.push(th.fg("dim", line));
      }
      for (const tool of toolCalls) {
        const preview = tool.preview ? ` ${tool.preview}` : "";
        lines.push(th.fg("muted", `  [Tool: ${tool.name}]${preview}`));
      }
    } else if (msg.role === "toolResult") {
      const text = extractText(msg.content);
      const truncated = text.length > 500 ? text.slice(0, 500) + "... (truncated)" : text;
      if (!truncated.trim() && !msg.isError) return [];
      const resultColor = msg.isError ? "error" : "dim";
      lines.push(th.fg(resultColor, msg.isError ? "[Result: Error]" : "[Result]"));
      for (const line of wrapTextWithAnsi(truncated.trim(), width)) lines.push(th.fg(resultColor, line));
    } else if ((msg as any).role === "bashExecution") {
      const bash = msg as any;
      lines.push(th.fg("muted", `  $ ${bash.command}`));
      if (bash.output?.trim()) {
        const out = bash.output.length > 500 ? bash.output.slice(0, 500) + "... (truncated)" : bash.output;
        for (const line of wrapTextWithAnsi(out.trim(), width)) lines.push(th.fg("dim", line));
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
    if (!this.contentDirty && width === this.cachedContentWidth) return this.cachedContentLines;

    const messages = this.session.messages;
    if (messages.length === 0) {
      this.cachedContentWidth = width;
      this.cachedContentLines = [this.theme.fg("dim", "(waiting for first message...)")];
      this.contentDirty = false;
      return this.cachedContentLines;
    }

    const stableCount = messages.length - 1;
    const stablePrefixStillValid = width === this.cachedContentWidth
      && this.stableMessages.length <= stableCount
      && this.stableMessages.every((message, index) => message === messages[index]);
    if (!stablePrefixStillValid) {
      this.stableMessages = [];
      this.stableContentLines = [];
      this.stableHasContent = false;
    }

    // Completed history is immutable during ordinary streaming. Render each
    // message once; only the live tail is rebuilt for each delta. A compaction
    // replaces the prefix references, trips the guard above, and rebuilds it.
    while (this.stableMessages.length < stableCount) {
      const message = messages[this.stableMessages.length];
      const block = this.renderMessageBlock(message, width);
      this.stableHasContent = this.appendBlock(this.stableContentLines, block, this.stableHasContent);
      this.stableMessages.push(message);
    }

    const lines = [...this.stableContentLines];
    let hasContent = this.stableHasContent;
    const liveBlock = this.renderMessageBlock(messages[messages.length - 1], width);
    hasContent = this.appendBlock(lines, liveBlock, hasContent);

    // Streaming indicator for running agents.
    if (this.record.status === "running" && this.activity) {
      const act = describeActivity(this.activity.activeTools, this.activity.responseText);
      if (hasContent) lines.push("");
      lines.push(truncateToWidth(this.theme.fg("accent", "▍ ") + this.theme.fg("dim", act), width));
    }

    this.cachedContentWidth = width;
    this.cachedContentLines = lines;
    this.contentDirty = false;
    return lines;
  }
}
