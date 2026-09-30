import { matchesKey, truncateToWidth, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeTaskLabel } from "../../background-task-viewer.js";
import type { AgentRecord } from "../types.js";
import { formatDuration, getDisplayName } from "./agent-widget.js";

type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

/** The same bordered list layout as /tasks, with Enter opening a conversation. */
export class AgentListViewer {
  private selectedId?: string;
  private selectedIndex = 0;

  constructor(
    private tui: TUI,
    private list: () => AgentRecord[],
    private theme: Theme,
    private done: (record: AgentRecord | undefined) => void,
    initialSelectedId?: string,
  ) {
    this.selectedId = initialSelectedId;
  }

  private agents(): AgentRecord[] {
    const agents = this.list();
    const index = agents.findIndex(agent => agent.id === this.selectedId);
    this.selectedIndex = index < 0 ? Math.min(this.selectedIndex, Math.max(0, agents.length - 1)) : index;
    this.selectedId = agents[this.selectedIndex]?.id;
    return agents;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
      this.done(undefined);
      return;
    }
    const agents = this.agents();
    if (matchesKey(data, "up")) this.selectedIndex = Math.max(0, this.selectedIndex - 1);
    else if (matchesKey(data, "down")) this.selectedIndex = Math.min(agents.length - 1, this.selectedIndex + 1);
    else if (matchesKey(data, "enter")) {
      const selected = agents[this.selectedIndex];
      if (selected) this.done(selected);
      return;
    }
    this.selectedId = agents[this.selectedIndex]?.id;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (width < 8) return [];
    const agents = this.agents();
    const inner = width - 4;
    const row = (content: string) => {
      const clipped = truncateToWidth(content, inner, "…", true);
      return `${this.theme.fg("border", "│")} ${clipped}${" ".repeat(Math.max(0, inner - visibleWidth(clipped)))} ${this.theme.fg("border", "│")}`;
    };
    const separator = row(this.theme.fg("dim", "─".repeat(inner)));
    const running = agents.filter(agent => agent.status === "running" || agent.status === "queued").length;
    const lines = [
      this.theme.fg("border", `╭${"─".repeat(width - 2)}╮`),
      row(`${this.theme.bold("Agents")}  ${this.theme.fg("dim", `${running} running · ${agents.length} total`)}`),
      separator,
    ];
    if (agents.length === 0) {
      lines.push(row(this.theme.fg("muted", "No agents in this session.")));
    } else {
      const viewport = Math.min(8, agents.length);
      const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(viewport / 2), agents.length - viewport));
      for (const agent of agents.slice(start, start + viewport)) {
        const name = sanitizeTaskLabel(getDisplayName(agent.type));
        const description = sanitizeTaskLabel(agent.description);
        const status = this.theme.fg(agent.status === "running" ? "accent" : agent.status === "completed" ? "success" : "muted", agent.status);
        lines.push(row(`${agent.id === this.selectedId ? this.theme.fg("accent", "›") : " "} ${this.theme.bold(name)} (${description})  ${status} · ${formatDuration(agent.startedAt, agent.completedAt)}`));
      }
    }
    lines.push(separator, row(this.theme.fg("dim", "↑↓ agents · Enter open · Esc close")), this.theme.fg("border", `╰${"─".repeat(width - 2)}╯`));
    return lines;
  }

  invalidate(): void {}
}
