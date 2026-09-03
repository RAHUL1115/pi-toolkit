import { stripVTControlCharacters } from "node:util";
import { matchesKey, truncateToWidth, type TUI, visibleWidth } from "@earendil-works/pi-tui";

export type BackgroundTaskItem = {
	id: string;
	command: string;
	status: "running" | "exited" | "failed" | "stopped" | "timed_out";
	pid?: number;
	startedAt: number;
	endedAt?: number;
	exitCode?: number | null;
};

export type BackgroundTaskController = {
	list(): BackgroundTaskItem[];
	output(id: string): string;
	delete(id: string): Promise<void>;
};

type Theme = {
	fg(color: string, text: string): string;
	bold(text: string): string;
};

function elapsed(task: BackgroundTaskItem): string {
	const seconds = Math.max(0, ((task.endedAt ?? Date.now()) - task.startedAt) / 1000);
	return seconds < 60 ? `${Math.floor(seconds)}s` : `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}

function status(task: BackgroundTaskItem, theme: Theme): string {
	if (task.status === "running") return theme.fg("accent", "running");
	if (task.status === "exited" && task.exitCode === 0) return theme.fg("success", "done");
	if (task.status === "failed" || (task.status === "exited" && task.exitCode !== 0)) return theme.fg("error", "failed");
	return theme.fg("warning", task.status === "timed_out" ? "timed out" : "stopped");
}

function taskName(command: string): string {
	return stripVTControlCharacters(command).replace(/[\u202a-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim() || "Untitled command";
}

function outputPreview(output: string): string[] {
	if (!output) return [];
	return stripVTControlCharacters(output).split(/\r\n|\n|\r/).slice(-5);
}

export class BackgroundTaskViewer {
	private selected = 0;
	private deleteArmed = false;
	private closed = false;
	private clock: ReturnType<typeof setInterval>;

	constructor(
		private tui: TUI,
		private tasks: BackgroundTaskController,
		private theme: Theme,
		private done: (result: undefined) => void,
	) {
		this.clock = setInterval(() => {
			if (!this.closed) this.tui.requestRender();
		}, 1000);
		this.clock.unref();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
			this.closed = true;
			this.done(undefined);
			return;
		}
		const tasks = this.tasks.list();
		this.selected = Math.min(this.selected, Math.max(0, tasks.length - 1));
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.selected = Math.max(0, this.selected - 1);
			this.deleteArmed = false;
		} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.selected = Math.min(tasks.length - 1, this.selected + 1);
			this.deleteArmed = false;
		} else if (matchesKey(data, "x") && tasks[this.selected]) {
			if (this.deleteArmed) {
				this.deleteArmed = false;
				void this.tasks.delete(tasks[this.selected].id).finally(() => this.tui.requestRender());
			} else this.deleteArmed = true;
		} else this.deleteArmed = false;
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (width < 8) return [];
		const tasks = this.tasks.list();
		this.selected = Math.min(this.selected, Math.max(0, tasks.length - 1));
		const inner = width - 4;
		const row = (content: string) => {
			const clipped = truncateToWidth(content, inner, "…", true);
			return `${this.theme.fg("border", "│")} ${clipped}${" ".repeat(Math.max(0, inner - visibleWidth(clipped)))} ${this.theme.fg("border", "│")}`;
		};
		const top = this.theme.fg("border", `╭${"─".repeat(width - 2)}╮`);
		const bottom = this.theme.fg("border", `╰${"─".repeat(width - 2)}╯`);
		const separator = row(this.theme.fg("dim", "─".repeat(inner)));
		const running = tasks.filter((task) => task.status === "running").length;
		const lines = [top, row(`${this.theme.bold("Background tasks")}  ${this.theme.fg("dim", `${running} running · ${tasks.length} total`)}`), separator];
		const viewport = Math.max(1, Math.min(8, tasks.length));
		const start = Math.max(0, Math.min(this.selected - Math.floor(viewport / 2), tasks.length - viewport));
		if (tasks.length === 0) {
			lines.push(row(this.theme.fg("muted", "No background tasks in this session.")));
		} else {
			for (let i = 0; i < viewport; i++) {
				const task = tasks[start + i];
				if (!task) {
					lines.push(row(""));
					continue;
				}
				const selected = start + i === this.selected;
				const cursor = selected ? this.theme.fg("accent", "›") : " ";
				lines.push(row(`${cursor} ${this.theme.bold(taskName(task.command))}  ${status(task, this.theme)} · ${elapsed(task)}  ${this.theme.fg("dim", task.id)}`));
			}
		}
		lines.push(separator);
		const selectedTask = tasks[this.selected];
		if (selectedTask) {
			lines.push(row(`${this.theme.bold("Recent output")}  ${this.theme.fg("dim", `${selectedTask.id} · last 5 lines`)}`));
			const preview = outputPreview(this.tasks.output(selectedTask.id));
			if (preview.length === 0) lines.push(row(this.theme.fg("muted", "(no output yet)")));
			else for (const line of preview) lines.push(row(this.theme.fg("muted", line)));
			lines.push(separator);
		}
		lines.push(row(this.deleteArmed ? this.theme.fg("warning", "Press x again to delete this task") : this.theme.fg("dim", "↑↓ navigate · x delete · Esc close")));
		lines.push(bottom);
		return lines;
	}

	invalidate(): void {}

	dispose(): void {
		this.closed = true;
		clearInterval(this.clock);
	}
}
