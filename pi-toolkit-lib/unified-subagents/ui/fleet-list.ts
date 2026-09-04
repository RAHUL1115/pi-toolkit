/**
 * fleet-list.ts — shared activity list rendered below the editor.
 *
 * Running background tasks and top-level subagents share one surface. Down first
 * focuses the tab strip, Left/Right switches tabs, and another Down expands and
 * enters the selected rows. The inactive surface stays collapsed to counters. Enter opens
 * the existing task detail or agent conversation view. Ctrl+B keeps its agent-first
 * backgrounding behavior even when the visual surface is disabled.
 */

import { Editor, isKeyRelease, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  BackgroundTaskViewer,
  type BackgroundTaskController,
  type BackgroundTaskItem,
  sanitizeTaskLabel,
} from "../../background-task-viewer.js";
import { hasAgentBadge, renderAgentName } from "../agent-color.js";
import type { AgentManager } from "../agent-manager.js";
import type { AgentRecord } from "../types.js";
import { getLifetimeCost, getLifetimeTotal, getSessionContextPercent } from "../usage.js";
import {
  type AgentActivity,
  describeActivity,
  fgPreservingNestedStyles,
  formatCost,
  formatSessionTokens,
  formatTurns,
  type Theme,
} from "./agent-widget.js";
import { CONVERSATION_OVERLAY_OPTIONS, ConversationViewer } from "./conversation-viewer.js";

const FLEET_KEY = "fleet";
const MAX_ROWS = 5;
const TICK_MS = 1000;

type ActivityTab = "tasks" | "agents";
type FocusLevel = "tabs" | "rows";
type ActivityTheme = Theme & { bg(color: string, text: string): string };

/** Minimal UI surface the activity list needs from `ctx.ui` (structural subset). */
export type FleetUICtx = {
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: ActivityTheme) => { render(width: number): string[]; invalidate(): void; dispose?(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
  getEditorText(): string;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  custom<T>(
    factory: (tui: any, theme: Theme, keybindings: any, done: (result: T) => void) => { render(width: number): string[]; invalidate(): void; dispose?(): void },
    options?: { overlay?: boolean; overlayOptions?: unknown; onHandle?: (handle: unknown) => void },
  ): Promise<T>;
};

/** `11s` — integer seconds, no decimal/suffix (matches Claude Code, unlike formatMs). */
export function formatFleetElapsed(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

/** `↓ 13.1k tokens` — down-arrow prefix, compact magnitude, plural "tokens". */
export function formatFleetTokens(count: number): string {
  let compact: string;
  if (count >= 1_000_000) compact = `${(count / 1_000_000).toFixed(1)}M`;
  else if (count >= 1_000) compact = `${(count / 1_000).toFixed(1)}k`;
  else compact = `${count}`;
  return `↓ ${compact} tokens`;
}

function rightAlign(left: string, right: string, width: number): string {
  const rightW = visibleWidth(right);
  const maxLeft = Math.max(0, width - rightW - 1);
  const leftClamped = truncateToWidth(left, maxLeft);
  const gap = Math.max(1, width - visibleWidth(leftClamped) - rightW);
  return truncateToWidth(leftClamped + " ".repeat(gap) + right, width);
}

function taskName(task: BackgroundTaskItem): string {
  return sanitizeTaskLabel(task.title ?? "") || sanitizeTaskLabel(task.command) || "Untitled command";
}

export class FleetList {
  private ui: FleetUICtx | undefined;
  private tui: any | undefined;
  private inputUnsub: (() => void) | undefined;
  private taskUnsub: (() => void) | undefined;
  private widgetRegistered = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  private enabled = true;
  private focus: FocusLevel | undefined;
  private selectedTab: ActivityTab = "agents";
  private selectedIndex: Record<ActivityTab, number> = { tasks: 0, agents: 0 };
  private viewerClose: (() => void) | undefined;

  constructor(
    private manager: AgentManager,
    private agentActivity: Map<string, AgentActivity>,
    private showCost: () => boolean = () => false,
    private tasks?: BackgroundTaskController,
  ) {
    this.taskUnsub = tasks?.onList?.(() => this.update());
  }

  // ---- Lifecycle ----

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) this.focus = undefined;
    this.update();
  }

  setUICtx(ui: FleetUICtx): void {
    if (ui === this.ui) return;
    this.inputUnsub?.();
    this.ui = ui;
    this.widgetRegistered = false;
    this.tui = undefined;
    this.inputUnsub = ui.onTerminalInput(data => this.handleKey(data));
  }

  ensureTimer(): void {
    if (!this.timer) this.timer = setInterval(() => this.update(), TICK_MS);
  }

  onAgentFinished(_id: string): void {
    this.update();
  }

  dispose(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.inputUnsub?.();
    this.inputUnsub = undefined;
    this.taskUnsub?.();
    this.taskUnsub = undefined;
    if (this.viewerClose) { this.viewerClose(); this.viewerClose = undefined; }
    if (this.ui && this.widgetRegistered) this.ui.setWidget(FLEET_KEY, undefined);
    this.widgetRegistered = false;
    this.tui = undefined;
    this.focus = undefined;
    this.ui = undefined;
  }

  update(): void {
    if (!this.ui) return;
    const tabs = this.availableTabs();
    const visible = this.enabled && tabs.length > 0;

    if (!visible) {
      if (this.widgetRegistered) {
        this.ui.setWidget(FLEET_KEY, undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
      this.focus = undefined;
      return;
    }

    this.normalizeSelection(tabs);
    this.ensureTimer();

    if (!this.widgetRegistered) {
      this.ui.setWidget(FLEET_KEY, (tui, theme) => {
        this.tui = tui;
        return {
          render: (w: number) => this.renderBar(w, theme),
          invalidate: () => { this.widgetRegistered = false; this.tui = undefined; },
        };
      }, { placement: "belowEditor" });
      this.widgetRegistered = true;
    } else {
      this.tui?.requestRender();
    }
  }

  // ---- Activity data ----

  private agentRecords(): AgentRecord[] {
    return this.manager.listAgents()
      .filter(a => !a.parentAgentId && (a.status === "running" || a.status === "queued"))
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  private taskRecords(): BackgroundTaskItem[] {
    return this.tasks?.list().filter(task => task.status === "running") ?? [];
  }

  private availableTabs(): ActivityTab[] {
    const tabs: ActivityTab[] = [];
    if (this.taskRecords().length > 0) tabs.push("tasks");
    if (this.agentRecords().length > 0) tabs.push("agents");
    return tabs;
  }

  private rows(tab = this.selectedTab): Array<BackgroundTaskItem | AgentRecord> {
    return tab === "tasks" ? this.taskRecords() : this.agentRecords();
  }

  private normalizeSelection(tabs = this.availableTabs()): void {
    if (tabs.length === 0) { this.focus = undefined; return; }
    if (!tabs.includes(this.selectedTab)) {
      this.selectedTab = tabs[0];
      this.selectedIndex[this.selectedTab] = 0;
    }
    const rows = this.rows();
    this.selectedIndex[this.selectedTab] = Math.max(0, Math.min(this.selectedIndex[this.selectedTab], rows.length - 1));
  }

  // ---- Key handling ----

  handleKey(data: string): { consume?: boolean; data?: string } | undefined {
    if (!this.ui || isKeyRelease(data) || this.viewerClose) return undefined;
    if (!this.editorHasFocus()) {
      if (this.focus) this.deactivate();
      return undefined;
    }

    if (matchesKey(data, Key.ctrl("b"))) {
      const record = this.manager.backgroundForeground();
      if (!record) return undefined;
      this.ui.notify(`Agent "${record.description}" is now running in background.`, "info");
      this.update();
      return { consume: true };
    }

    if (!this.enabled) return undefined;

    if (!this.focus) {
      if (matchesKey(data, "down") && this.availableTabs().length > 0 && this.ui.getEditorText() === "") {
        this.focus = "tabs";
        this.normalizeSelection();
        this.update();
        return { consume: true };
      }
      return undefined;
    }

    const tabs = this.availableTabs();
    this.normalizeSelection(tabs);
    if (!this.focus) return undefined;

    if (matchesKey(data, "escape")) {
      this.deactivate();
      return { consume: true };
    }

    if (matchesKey(data, "left") || matchesKey(data, "right")) {
      if (tabs.length > 1) {
        const current = tabs.indexOf(this.selectedTab);
        const direction = matchesKey(data, "left") ? -1 : 1;
        this.selectedTab = tabs[Math.max(0, Math.min(tabs.length - 1, current + direction))];
        this.update();
      }
      return { consume: true };
    }

    if (this.focus === "tabs") {
      if (matchesKey(data, "down")) {
        this.focus = "rows";
        this.update();
        return { consume: true };
      }
      if (matchesKey(data, "up")) {
        this.deactivate();
        return { consume: true };
      }
    } else {
      const index = this.selectedIndex[this.selectedTab];
      if (matchesKey(data, "down")) {
        this.selectedIndex[this.selectedTab] = Math.min(this.rows().length - 1, index + 1);
        this.update();
        return { consume: true };
      }
      if (matchesKey(data, "up")) {
        if (index === 0) {
          this.focus = "tabs";
          this.update();
        } else {
          this.selectedIndex[this.selectedTab] = index - 1;
          this.update();
        }
        return { consume: true };
      }
      if (matchesKey(data, Key.enter)) {
        this.openSelected();
        return { consume: true };
      }
    }

    this.deactivate();
    return undefined;
  }

  private editorHasFocus(): boolean {
    const focused = (this.tui as { focusedComponent?: unknown } | undefined)?.focusedComponent;
    return focused == null || focused instanceof Editor;
  }

  private deactivate(): void {
    this.focus = undefined;
    this.update();
  }

  private openSelected(): void {
    const selected = this.rows()[this.selectedIndex[this.selectedTab]];
    if (!selected || !this.ui) return;
    if (this.selectedTab === "tasks") this.openTask(selected as BackgroundTaskItem);
    else this.openAgent(selected as AgentRecord);
  }

  private openTask(task: BackgroundTaskItem): void {
    if (!this.ui || !this.tasks) return;
    void this.ui.custom<undefined>((tui, theme, _keybindings, done) => {
      this.viewerClose = () => done(undefined);
      return new BackgroundTaskViewer(tui, this.tasks!, theme, done, task.id);
    }).then(() => this.clearViewer(), () => this.clearViewer());
  }

  private openAgent(record: AgentRecord): void {
    if (!this.ui) return;
    if (!record.session) {
      this.ui.notify(`Agent is ${record.status} — no session available.`, "info");
      return;
    }
    const session = record.session;
    const activity = this.agentActivity.get(record.id);

    void this.ui.custom<undefined>(
      (tui, theme, keybindings, done) => {
        this.viewerClose = () => done(undefined);
        return new ConversationViewer(
          tui,
          session,
          record,
          activity,
          theme,
          done,
          () => {
            if (this.manager.abort(record.id)) this.ui?.notify(`Stopped "${record.description}".`, "info");
          },
          keybindings,
          (message: string) => this.manager.steer(record.id, message),
          this.showCost(),
        );
      },
      { overlay: true, overlayOptions: CONVERSATION_OVERLAY_OPTIONS },
    ).then(() => this.clearViewer(), () => this.clearViewer());
  }

  private clearViewer(): void {
    this.viewerClose = undefined;
    this.focus = this.availableTabs().length > 0 ? "rows" : undefined;
    this.update();
  }

  // ---- Rendering ----

  private renderBar(width: number, theme: ActivityTheme): string[] {
    const tabs = this.availableTabs();
    if (tabs.length === 0) return [];
    this.normalizeSelection(tabs);

    const hint = this.focus === "tabs"
      ? "←→ switch · ↓ enter · ↑/esc back"
      : this.focus === "rows"
        ? "↑↓ select · enter view · esc back"
        : "esc to interrupt · ↓ to manage";
    const tabLabels = tabs.map(tab => {
      const label = ` ${tab === "tasks" ? "Tasks" : "Agents"} ${this.rows(tab).length} `;
      const selected = this.focus != null && tab === this.selectedTab;
      const text = selected ? theme.bold(theme.fg(this.focus === "tabs" ? "accent" : "text", label)) : theme.fg("muted", label);
      const background = this.focus == null || selected ? "selectedBg" : "customMessageBg";
      return theme.bg(background, text);
    });
    const lines = [truncateToWidth(`  ${tabLabels.join(theme.fg("dim", "  |  "))}  ${theme.fg("dim", hint)}`, width)];
    if (this.focus === "rows") {
      if (this.selectedTab === "tasks") lines.push(...this.renderTasks(width, theme));
      else lines.push(...this.renderAgents(width, theme));
    }
    lines.push("");
    return lines;
  }

  private renderTasks(width: number, theme: ActivityTheme): string[] {
    const tasks = this.taskRecords();
    const selected = this.focus === "rows" ? this.selectedIndex.tasks : -1;
    const { start, visible, hiddenBelow } = this.window(tasks.length, selected);
    const lines: string[] = [];
    if (start > 0) lines.push(rightAlign("", theme.fg("dim", `↑ ${start} more`), width));
    for (let index = start; index < start + visible; index++) {
      const task = tasks[index];
      const isSelected = index === selected;
      const marker = isSelected ? theme.fg("accent", "●") : theme.fg("dim", "○");
      const title = isSelected ? theme.fg("text", taskName(task)) : theme.fg("muted", taskName(task));
      const left = `  ${marker} ${title}`;
      const elapsed = formatFleetElapsed(Date.now() - task.startedAt);
      const stats = fgPreservingNestedStyles(theme, isSelected ? "text" : "dim", `${task.id} · ${elapsed}`);
      lines.push(rightAlign(left, stats, width));
    }
    if (hiddenBelow > 0) lines.push(rightAlign("", theme.fg("dim", `↓ ${hiddenBelow} more`), width));
    return lines;
  }

  private renderAgents(width: number, theme: ActivityTheme): string[] {
    const agents = this.agentRecords();
    const selected = this.focus === "rows" ? this.selectedIndex.agents : -1;
    const { start, visible, hiddenBelow } = this.window(agents.length, selected);
    const lines: string[] = [];
    if (start > 0) lines.push(rightAlign("", theme.fg("dim", `↑ ${start} more`), width));
    for (let index = start; index < start + visible; index++) {
      lines.push(this.renderAgentRow(index, selected, agents[index], width, theme));
    }
    if (hiddenBelow > 0) lines.push(rightAlign("", theme.fg("dim", `↓ ${hiddenBelow} more`), width));
    return lines;
  }

  private window(total: number, selected: number): { start: number; visible: number; hiddenBelow: number } {
    const visible = Math.min(MAX_ROWS, total);
    const start = selected < visible ? 0 : selected - visible + 1;
    return { start, visible, hiddenBelow: total - (start + visible) };
  }

  private renderAgentRow(index: number, selected: number, record: AgentRecord, width: number, theme: ActivityTheme): string {
    const isSelected = index === selected;
    const marker = isSelected ? theme.fg("accent", "●") : theme.fg("dim", "○");
    const name = renderAgentName(record.type, theme, isSelected
      ? { fallbackColor: "text", bold: hasAgentBadge(record.type) }
      : { fallbackColor: "muted" });
    const harnessTag = record.harness === "pi" ? "" : ` ${theme.fg("dim", `(${record.harness})`)}`;
    const activity = this.agentActivity.get(record.id);
    const step = record.status === "running"
      ? activity?.activeTools.size
        ? describeActivity(activity.activeTools).replace(/…$/, "")
        : activity?.responseText.trim() ? "responding" : "thinking"
      : undefined;
    const stepTag = step ? ` ${theme.fg(isSelected ? "text" : "dim", `[${step}]`)}` : "";
    const description = isSelected ? theme.fg("text", record.description) : record.description;
    const left = `  ${marker} ${name}${harnessTag}${stepTag}  ${description}`;

    const toolUses = activity?.toolUses ?? record.toolUses;
    const tokens = getLifetimeTotal(record.lifetimeUsage);
    const contextPercent = getSessionContextPercent(activity?.session ?? record.session);
    const tokenText = tokens > 0 ? `↓ ${formatSessionTokens(tokens, contextPercent, theme, record.compactionCount)}` : "";
    const elapsedMs = Date.now() - record.startedAt;
    const cost = this.showCost() ? formatCost(getLifetimeCost(record.lifetimeUsage)) : "";
    const stats = [
      toolUses > 0 ? `${toolUses} tool use${toolUses === 1 ? "" : "s"}` : "",
      activity?.turnCount && activity.maxTurns != null ? formatTurns(activity.turnCount, activity.maxTurns) : "",
      tokenText,
      cost,
      formatFleetElapsed(elapsedMs),
    ].filter(Boolean).join(" · ");
    const right = fgPreservingNestedStyles(theme, isSelected ? "text" : "dim", stats);
    return rightAlign(left, right, width);
  }
}
