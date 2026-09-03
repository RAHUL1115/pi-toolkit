import { stripVTControlCharacters } from "node:util";
import { matchesKey, truncateToWidth, type TUI, visibleWidth } from "@earendil-works/pi-tui";

const PREVIEW_LINES = 5;
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const TERMINAL_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;

export type BackgroundTaskItem = {
	id: string;
	title?: string;
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
	stop(id: string): Promise<void>;
	clear(id: string): Promise<void>;
	clearFinished(): Promise<void>;
	onList?(listener: () => void): () => void;
	onOutput?(listener: (id: string) => void): () => void;
};

type Theme = {
	fg(color: string, text: string): string;
	bold(text: string): string;
};

type ArmedAction = {
	kind: "stop" | "clear" | "clear-all";
	id?: string;
	key: "x" | "c" | "delete" | "C";
};

export function sanitizeTaskLabel(value: string): string {
	return stripVTControlCharacters(value)
		.replace(BIDI_CONTROLS, "")
		.replace(TERMINAL_CONTROLS, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function safeOutputLines(value: string): string[] {
	if (!value) return [];
	return stripVTControlCharacters(value)
		.replace(BIDI_CONTROLS, "")
		.replace(/\r\n|\r/g, "\n")
		.split("\n")
		.map((line) => line.replace(TERMINAL_CONTROLS, "").replaceAll("\t", "    "));
}

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

function taskName(task: BackgroundTaskItem): string {
	return sanitizeTaskLabel(task.title ?? "") || sanitizeTaskLabel(task.command) || "Untitled command";
}

export class BackgroundTaskViewer {
	private selectedId?: string;
	private selectedIndex = 0;
	private armed?: ArmedAction;
	private readonly pending = new Set<string>();
	private actionError?: string;
	private closed = false;
	private clock?: ReturnType<typeof setInterval>;
	private outputRefresh?: ReturnType<typeof setTimeout>;
	private outputRefreshId?: string;
	private cachedOutputId?: string;
	private cachedOutput: string[] = [];
	private outputStart = 0;
	private following = true;
	private readonly unsubscribe: Array<() => void> = [];

	constructor(
		private tui: TUI,
		private tasks: BackgroundTaskController,
		private theme: Theme,
		private done: (result: undefined) => void,
	) {
		if (tasks.onList) this.unsubscribe.push(tasks.onList(() => this.onListChanged()));
		if (tasks.onOutput) this.unsubscribe.push(tasks.onOutput((id) => this.onOutputChanged(id)));
		this.syncTasks(tasks.list());
	}

	private syncClock(tasks: BackgroundTaskItem[]): void {
		const running = tasks.some((task) => task.status === "running");
		if (running && !this.clock) {
			this.clock = setInterval(() => {
				if (!this.closed) this.tui.requestRender();
			}, 1000);
			this.clock.unref();
		} else if (!running && this.clock) {
			clearInterval(this.clock);
			this.clock = undefined;
		}
	}

	private syncTasks(tasks: BackgroundTaskItem[]): void {
		this.syncClock(tasks);
		let index = this.selectedId ? tasks.findIndex((task) => task.id === this.selectedId) : -1;
		if (index < 0 && tasks.length > 0) index = Math.min(this.selectedIndex, tasks.length - 1);
		const id = index >= 0 ? tasks[index]?.id : undefined;
		this.selectedIndex = Math.max(0, index);
		if (id !== this.selectedId) {
			this.selectedId = id;
			this.following = true;
			this.outputStart = 0;
			this.loadOutput();
		}
		if (!id) {
			this.cachedOutputId = undefined;
			this.cachedOutput = [];
		}
	}

	private select(tasks: BackgroundTaskItem[], index: number): void {
		const next = tasks[Math.max(0, Math.min(index, tasks.length - 1))];
		if (!next || next.id === this.selectedId) return;
		this.selectedId = next.id;
		this.selectedIndex = tasks.indexOf(next);
		this.following = true;
		this.outputStart = 0;
		this.armed = undefined;
		this.actionError = undefined;
		this.loadOutput();
	}

	private loadOutput(): void {
		if (!this.selectedId) return;
		this.cachedOutputId = this.selectedId;
		this.cachedOutput = safeOutputLines(this.tasks.output(this.selectedId));
		const lastPage = Math.max(0, this.cachedOutput.length - PREVIEW_LINES);
		this.outputStart = this.following ? lastPage : Math.min(this.outputStart, lastPage);
	}

	private onListChanged(): void {
		if (this.closed) return;
		this.syncTasks(this.tasks.list());
		this.tui.requestRender();
	}

	private onOutputChanged(id: string): void {
		if (this.closed || id !== this.selectedId) return;
		if (this.outputRefresh && this.outputRefreshId === id) return;
		if (this.outputRefresh) clearTimeout(this.outputRefresh);
		this.outputRefreshId = id;
		this.outputRefresh = setTimeout(() => {
			this.outputRefresh = undefined;
			this.outputRefreshId = undefined;
			if (this.closed || id !== this.selectedId) return;
			this.loadOutput();
			this.tui.requestRender();
		}, 100);
		this.outputRefresh.unref();
	}

	private scrollOutput(amount: number): void {
		if (!this.selectedId) return;
		const lastPage = Math.max(0, this.cachedOutput.length - PREVIEW_LINES);
		this.outputStart = Math.max(0, Math.min(lastPage, this.outputStart + amount));
		this.following = this.outputStart === lastPage;
		this.armed = undefined;
	}

	private armOrRun(action: ArmedAction, run: () => Promise<void>): void {
		const pendingKey = `${action.kind}:${action.id ?? "all"}`;
		if (this.pending.has(pendingKey)) return;
		if (this.armed?.kind !== action.kind || this.armed.id !== action.id || this.armed.key !== action.key) {
			this.armed = action;
			this.actionError = undefined;
			return;
		}
		this.armed = undefined;
		this.pending.add(pendingKey);
		this.tui.requestRender();
		void run()
			.catch((error) => {
				this.actionError = sanitizeTaskLabel(error instanceof Error ? error.message : String(error));
			})
			.finally(() => {
				this.pending.delete(pendingKey);
				if (!this.closed) {
					this.syncTasks(this.tasks.list());
					this.tui.requestRender();
				}
			});
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
			this.dispose();
			this.done(undefined);
			return;
		}
		const tasks = this.tasks.list();
		this.syncTasks(tasks);
		const selectedTask = tasks.find((task) => task.id === this.selectedId);
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.select(tasks, this.selectedIndex - 1);
		} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.select(tasks, this.selectedIndex + 1);
		} else if (matchesKey(data, "shift+k")) {
			this.scrollOutput(-1);
		} else if (matchesKey(data, "shift+j")) {
			this.scrollOutput(1);
		} else if (matchesKey(data, "pageUp")) {
			this.scrollOutput(-PREVIEW_LINES);
		} else if (matchesKey(data, "pageDown")) {
			this.scrollOutput(PREVIEW_LINES);
		} else if (matchesKey(data, "g")) {
			this.following = false;
			this.outputStart = 0;
			this.armed = undefined;
		} else if (matchesKey(data, "shift+g")) {
			this.following = true;
			this.outputStart = Math.max(0, this.cachedOutput.length - PREVIEW_LINES);
			this.armed = undefined;
		} else if (matchesKey(data, "x") && selectedTask?.status === "running") {
			this.armOrRun({ kind: "stop", id: selectedTask.id, key: "x" }, () => this.tasks.stop(selectedTask.id));
		} else if (matchesKey(data, "shift+c") && tasks.some((task) => task.status !== "running")) {
			this.armOrRun({ kind: "clear-all", key: "C" }, () => this.tasks.clearFinished());
		} else if (matchesKey(data, "c") && selectedTask && selectedTask.status !== "running") {
			this.armOrRun({ kind: "clear", id: selectedTask.id, key: "c" }, () => this.tasks.clear(selectedTask.id));
		} else if (matchesKey(data, "delete") && selectedTask && selectedTask.status !== "running") {
			this.armOrRun({ kind: "clear", id: selectedTask.id, key: "delete" }, () => this.tasks.clear(selectedTask.id));
		} else {
			this.armed = undefined;
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (width < 8) return [];
		const tasks = this.tasks.list();
		this.syncTasks(tasks);
		if (this.selectedId && this.cachedOutputId !== this.selectedId) this.loadOutput();
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
		const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(viewport / 2), tasks.length - viewport));
		if (tasks.length === 0) {
			lines.push(row(this.theme.fg("muted", "No background tasks in this session.")));
		} else {
			for (let i = 0; i < viewport; i++) {
				const task = tasks[start + i];
				if (!task) continue;
				const selected = task.id === this.selectedId;
				const cursor = selected ? this.theme.fg("accent", "›") : " ";
				lines.push(row(`${cursor} ${this.theme.bold(taskName(task))}  ${status(task, this.theme)} · ${elapsed(task)}  ${this.theme.fg("dim", task.id)}`));
			}
		}
		lines.push(separator);
		const selectedTask = tasks.find((task) => task.id === this.selectedId);
		if (selectedTask) {
			const lastPage = Math.max(0, this.cachedOutput.length - PREVIEW_LINES);
			this.outputStart = this.following ? lastPage : Math.min(this.outputStart, lastPage);
			const preview = this.cachedOutput.slice(this.outputStart, this.outputStart + PREVIEW_LINES);
			const position = this.cachedOutput.length > 0
				? `${this.outputStart + 1}-${this.outputStart + preview.length}/${this.cachedOutput.length}`
				: "0/0";
			lines.push(row(`${this.theme.bold("Output preview")}  ${this.theme.fg("dim", `${selectedTask.id} · ${position} · ${this.following ? "following tail" : "paused"}`)}`));
			if (preview.length === 0) lines.push(row(this.theme.fg("muted", "(no output yet)")));
			else for (const line of preview) lines.push(row(this.theme.fg("muted", line)));
			lines.push(separator);
		}
		let help = "↑↓/k j tasks · K/J/Pg scroll · g/G top/follow · x stop · c/Del clear · C clear finished";
		if (this.armed?.kind === "stop") help = "Press x again to stop this task (output will be retained)";
		else if (this.armed?.kind === "clear") help = `Press ${this.armed.key === "delete" ? "Delete" : "c"} again to clear this finished task`;
		else if (this.armed?.kind === "clear-all") help = "Press C again to clear all finished tasks";
		else if (this.pending.size > 0) help = "Task action in progress…";
		else if (this.actionError) help = `Action failed: ${this.actionError}`;
		lines.push(row(this.theme.fg(this.armed || this.actionError ? "warning" : "dim", help)));
		lines.push(bottom);
		return lines;
	}

	invalidate(): void {}

	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.clock) clearInterval(this.clock);
		if (this.outputRefresh) clearTimeout(this.outputRefresh);
		this.outputRefreshId = undefined;
		for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
	}
}
