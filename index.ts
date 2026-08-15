import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CustomEditor,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	getAgentDir,
	getSettingsListTheme,
	keyHint,
	rawKeyHint,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	type AutocompleteItem,
	type AutocompleteProvider,
	type Component,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
	matchesKey,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import registerObservability from "./pi-toolkit-lib/observability.js";

const SETTINGS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "pi-toolkit.json");
const MAX_SUGGESTIONS = 20;
const READ_PREVIEW_EDGE_LINES = 10;
const TOOL_PREVIEW_EDGE_LINES = 2;
const DOLLAR_SELECTOR = /(^|\s)\$([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?=$|\s|[.,;:!?])/gi;
const SKILL_COMMAND = /^\/skill:([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\s+|$)/i;

type ToolDetail = "collapsed" | "expanded";
type ToolView = "one line" | "list" | "normal";
type Settings = { compactTools: boolean; ctrlBackspace: boolean; dollarSkills: boolean; toolView: ToolView };
type Args = Record<string, unknown>;
type Details = Record<string, unknown> | undefined;
type RenderTheme = Parameters<NonNullable<ToolDefinition<any, any, any>["renderCall"]>>[1];
type GroupCall = {
	id: string;
	tool: string;
	args: Args;
	output: string;
	details: Details;
	partial: boolean;
	error: boolean;
	group: ToolGroup;
	shell?: Container;
};
type ToolGroup = {
	calls: GroupCall[];
	leader: Container;
	invalidate?: () => void;
	theme?: RenderTheme;
};
type CompactState = { call?: GroupCall };
type SkillCommand = ReturnType<ExtensionAPI["getCommands"]>[number];
type Message = ReturnType<ExtensionContext["sessionManager"]["buildSessionContext"]>["messages"][number];

function loadSettings(): Settings {
	try {
		const stored = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
		return {
			compactTools: stored.compactTools !== false,
			ctrlBackspace: stored.ctrlBackspace !== false,
			dollarSkills: stored.dollarSkills !== false,
			toolView: stored.toolView === "one line" || stored.toolView === "compact"
				? "one line"
				: stored.toolView === "normal" ? "normal" : "list",
		};
	} catch {
		return { compactTools: true, ctrlBackspace: true, dollarSkills: true, toolView: "list" };
	}
}

function loadOutputPad(): number {
	try {
		return JSON.parse(readFileSync(resolve(getAgentDir(), "settings.json"), "utf8")).outputPad === 0 ? 0 : 1;
	} catch {
		return 1;
	}
}

function saveSettings(settings: Settings): void {
	writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function display(value: unknown, fallback = "", compact = true): string {
	const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : fallback;
	return compact && text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function subject(tool: string, args: Args, compact = true): string {
	switch (tool) {
		case "bash":
			return display(args.command, "command", compact);
		case "grep":
			return `/${display(args.pattern, "", compact)}/ in ${display(args.path, ".", compact)}`;
		case "find":
			return `${display(args.pattern, "", compact)} in ${display(args.path, ".", compact)}`;
		case "ls":
			return display(args.path, ".", compact);
		default:
			return display(args.path, "", compact);
	}
}

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((item) => item.type === "text")?.text ?? "";
}

function isEmptyDisplayPart(part: { type: string; text?: string; thinking?: string }): boolean {
	return (part.type === "text" && !part.text?.trim()) || (part.type === "thinking" && !part.thinking?.trim());
}

function lineCount(text: string): number {
	return text ? text.split("\n").length : 0;
}

function editStats(diff: string): string {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) added++;
		if (line.startsWith("-") && !line.startsWith("---")) removed++;
	}
	return `+${added} -${removed}`;
}

function summary(tool: string, args: Args, output: string, details: Details): string {
	if (tool === "edit" && typeof details?.diff === "string") return editStats(details.diff);
	if (tool === "write" && typeof args.content === "string") return `${lineCount(args.content)} lines`;
	if (output) return `${lineCount(output)} lines`;
	return "done";
}

function expandedBody(tool: string, args: Args, output: string, details: Details): string {
	if (tool === "edit" && typeof details?.diff === "string") return details.diff;
	if (tool === "write" && typeof args.content === "string") return args.content;
	return output;
}

function previewBody(body: string, edgeLines: number): string {
	const lines = body.split("\n");
	while (lines.at(-1) === "") lines.pop();
	const hidden = lines.length - edgeLines * 2;
	if (hidden <= 0) return lines.join("\n");
	return [
		...lines.slice(0, edgeLines),
		`... (${hidden} more lines)`,
		...lines.slice(-edgeLines),
	].join("\n");
}

function colorBodyLine(tool: string, line: string, theme: RenderTheme): string {
	if (tool !== "edit") return theme.fg("toolOutput", line);
	if (line.startsWith("+")) return theme.fg("toolDiffAdded", line);
	if (line.startsWith("-")) return theme.fg("toolDiffRemoved", line);
	return theme.fg("toolDiffContext", line);
}

class ActivityText implements Component {
	readonly hasBackground: boolean;
	private readonly text: Text;
	private renderedWidth?: number;

	constructor(
		private readonly build: (width: number) => string,
		private readonly paddingX: number,
		background?: (text: string) => string,
	) {
		this.hasBackground = Boolean(background);
		this.text = new Text("", paddingX, 0, background);
	}

	render(width: number): string[] {
		const contentWidth = Math.max(1, width - this.paddingX * 2);
		if (this.renderedWidth !== contentWidth) {
			this.text.setText(this.build(contentWidth));
			this.renderedWidth = contentWidth;
		}
		return this.text.render(width);
	}

	invalidate(): void {
		this.renderedWidth = undefined;
		this.text.invalidate();
	}
}

const CTRL_BACKSPACE = "\x08";
const CTRL_W = "\x17";
const TOOLKIT_EDITOR_PADDING_X = 1;
type EditorArgs = ConstructorParameters<typeof CustomEditor>;
type PasteInternals = {
	handlePaste(text: string): void;
	handleBackspace(): void;
	isInPaste: boolean;
	pastes: Map<number, string>;
};
type RepeatablePaste = {
	rawContent: string;
	expandedContent: string;
	editorText: string;
	cursor: { line: number; col: number };
};
const PASTE_MARKER_AT_CURSOR = /\[paste #(\d+)(?: (?:\+\d+ lines|\d+ chars))?\]$/;

function cleanPastedText(text: string): string {
	const decoded = text.replace(/\x1b\[(\d+);5u/g, (match, code: string) => {
		const point = Number(code);
		if (point >= 97 && point <= 122) return String.fromCharCode(point - 96);
		if (point >= 65 && point <= 90) return String.fromCharCode(point - 64);
		return match;
	});
	return decoded
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/\t/g, "    ")
		.split("")
		.filter((character) => character === "\n" || character.charCodeAt(0) >= 32)
		.join("");
}
type ToolAction = (ctx: ExtensionContext) => void;
type ToolControls = { toggleExpanded: ToolAction; cycleCollapsed: ToolAction };

class ToolkitEditor extends CustomEditor {
	private repeatablePaste?: RepeatablePaste;

	constructor(
		tui: EditorArgs[0],
		theme: EditorArgs[1],
		private readonly toolkitKeybindings: EditorArgs[2],
		private readonly normalizeCtrlBackspace: boolean,
		private readonly toggleTools?: () => void,
		private readonly cycleCollapsedTools?: () => void,
		private readonly onRepeatablePasteChange?: (visible: boolean) => void,
	) {
		super(tui, theme, toolkitKeybindings, { paddingX: TOOLKIT_EDITOR_PADDING_X });
		const candidate = this as unknown as Partial<PasteInternals>;
		if (
			typeof candidate.handlePaste !== "function"
			|| typeof candidate.handleBackspace !== "function"
			|| typeof candidate.isInPaste !== "boolean"
			|| !(candidate.pastes instanceof Map)
		) return;
		const internals = candidate as PasteInternals;
		const defaultHandlePaste = internals.handlePaste.bind(this);
		const handlePaste = (text: string) => {
			const rawContent = cleanPastedText(text);
			const cursor = this.getCursor();
			const previous = this.repeatablePaste;
			if (
				previous
				&& rawContent === previous.rawContent
				&& this.getText() === previous.editorText
				&& cursor.line === previous.cursor.line
				&& cursor.col === previous.cursor.col
			) {
				// The built-in editor treats a paste marker as one backspace unit.
				internals.handleBackspace();
				this.insertTextAtCursor(previous.expandedContent);
				this.setRepeatablePaste(undefined);
				return;
			}

			defaultHandlePaste(text);
			const nextCursor = this.getCursor();
			const beforeCursor = this.getLines()[nextCursor.line]?.slice(0, nextCursor.col) ?? "";
			const marker = beforeCursor.match(PASTE_MARKER_AT_CURSOR);
			const expandedContent = marker ? internals.pastes.get(Number(marker[1])) : undefined;
			this.setRepeatablePaste(marker && expandedContent !== undefined
				? { rawContent, expandedContent, editorText: this.getText(), cursor: nextCursor }
				: undefined);
		};
		try {
			internals.handlePaste = handlePaste;
		} catch {
			// Upstream editor internals changed; retain Pi's default paste behavior.
		}
	}

	private setRepeatablePaste(paste: RepeatablePaste | undefined): void {
		const wasVisible = this.repeatablePaste !== undefined;
		this.repeatablePaste = paste;
		const visible = paste !== undefined;
		if (visible !== wasVisible) this.onRepeatablePasteChange?.(visible);
	}

	override setText(text: string): void {
		this.setRepeatablePaste(undefined);
		super.setText(text);
	}

	override setPaddingX(_padding: number): void {
		super.setPaddingX(TOOLKIT_EDITOR_PADDING_X);
	}

	override handleInput(data: string): void {
		const internals = this as unknown as PasteInternals;
		const isPasteInput = internals.isInPaste || data.includes("\x1b[200~");
		if (!isPasteInput) this.setRepeatablePaste(undefined);
		if (this.cycleCollapsedTools && matchesKey(data, "ctrl+shift+o")) {
			this.cycleCollapsedTools();
			return;
		}
		if (this.toggleTools && this.toolkitKeybindings.matches(data, "app.tools.expand")) {
			this.toggleTools();
			return;
		}
		super.handleInput(this.normalizeCtrlBackspace && data === CTRL_BACKSPACE ? CTRL_W : data);
	}
}

function supportsCtrlBackspaceNormalization(): boolean {
	return process.platform === "win32"
		&& (process.env.TERM_PROGRAM === "vscode" || Boolean(process.env.WT_SESSION));
}

function registerWorkflowEditor(pi: ExtensionAPI, settings: Settings, controls?: ToolControls): void {
	let previousEditor: Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0];
	let installed = false;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ensureActivityThemePatch();
		const normalizeCtrlBackspace = settings.ctrlBackspace && supportsCtrlBackspaceNormalization();
		previousEditor = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, theme, keybindings) =>
			new ToolkitEditor(
				tui,
				theme,
				keybindings,
				normalizeCtrlBackspace,
				controls ? () => controls.toggleExpanded(ctx) : undefined,
				controls ? () => controls.cycleCollapsed(ctx) : undefined,
				(visible) => {
					ctx.ui.setWidget(
						"ptk-paste-hint",
						visible ? ["Paste the same content again to expand it inline"] : undefined,
						visible ? { placement: "belowEditor" } : undefined,
					);
				},
			));
		installed = true;
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (!installed) return;
		ctx.ui.setWidget("ptk-paste-hint", undefined);
		ctx.ui.setEditorComponent(previousEditor);
		installed = false;
	});
}

function registerCompactTools(pi: ExtensionAPI, settings: Settings): ToolControls {
	const cwd = process.cwd();
	const outputPad = loadOutputPad();
	const supported = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
	const calls = new Map<string, GroupCall>();
	const groups = new Map<string, ToolGroup>();
	const shells = new Map<string, Container>();
	let replaySeed: Map<string, GroupCall> | undefined;
	let continuationId: string | undefined;
	let detail: ToolDetail = "collapsed";

	const syncShells = (group: ToolGroup): void => {
		for (const call of group.calls) call.shell?.clear();
		const leaderCall = group.calls.find((call) => call.shell);
		if (leaderCall?.shell) leaderCall.shell.addChild(group.leader);
	};

	const paint = (group: ToolGroup, theme = group.theme): void => {
		if (!theme) return;
		group.theme = theme;
		group.leader.clear();
		const counts = new Map<string, number>();
		for (const call of group.calls) counts.set(call.tool, (counts.get(call.tool) ?? 0) + 1);
		const countText = [...counts].map(([name, count]) => `${count} ${name}`).join(" · ");
		const running = group.calls.some((call) => call.partial);
		const viewHint = detail === "collapsed" ? ` · ${rawKeyHint("ctrl+shift+o", "view")}` : "";
		const hint = theme.fg("dim", ` · ${keyHint("app.tools.expand", detail === "collapsed" ? "expand" : "collapse")}${viewHint}`);
		const status = (call: GroupCall): string => call.partial
			? theme.fg("warning", " …")
			: call.error
				? theme.fg("error", " failed")
				: theme.fg("success", ` ${summary(call.tool, call.args, call.output, call.details)}`);
		const renderActivity = (call: GroupCall, index: number, width: number): string => {
			const callHint = index === group.calls.length - 1 ? hint : "";
			const heading = `${theme.fg("toolTitle", call.tool)} ${theme.fg("accent", subject(call.tool, call.args, false))}${status(call)}${callHint}`;
			const headingLines = wrapTextWithAnsi(heading, Math.max(1, width - 4));
			const lines = headingLines.map((line, lineIndex) => `${lineIndex === 0 ? "• " : "  │ "}${line}`);
			if (running || call.partial) return lines.join("\n");
			const body = expandedBody(call.tool, call.args, call.output, call.details);
			if (!body) return lines.join("\n");
			const renderedBody = detail === "expanded"
				? body
				: previewBody(body, call.tool === "read" ? READ_PREVIEW_EDGE_LINES : TOOL_PREVIEW_EDGE_LINES);
			let firstOutputLine = true;
			for (const bodyLine of renderedBody.split("\n")) {
				const wrapped = wrapTextWithAnsi(colorBodyLine(call.tool, bodyLine, theme), Math.max(1, width - 4));
				for (const line of wrapped) {
					lines.push(`${firstOutputLine ? "  └ " : "    "}${line}`);
					firstOutputLine = false;
				}
			}
			return lines.join("\n");
		};

		if (detail === "collapsed" && settings.toolView !== "normal") {
			group.leader.addChild(new ActivityText((width) => {
				const lines = [`${theme.fg("toolTitle", theme.bold(`• tools ${countText}`))}${hint}`];
				if (settings.toolView === "list") {
					for (const [index, call] of group.calls.entries()) {
						const branch = index === group.calls.length - 1 ? "└" : "├";
						const heading = `${theme.fg("toolTitle", call.tool)} ${theme.fg("accent", subject(call.tool, call.args))}${status(call)}`;
						const wrapped = wrapTextWithAnsi(heading, Math.max(1, width - 4));
						lines.push(`  ${branch} ${wrapped[0] ?? ""}`);
						for (const line of wrapped.slice(1)) lines.push(`  │ ${line}`);
					}
				}
				return lines.join("\n");
			}, outputPad));
			return;
		}

		if (detail === "collapsed") {
			const background = running
				? "toolPendingBg"
				: group.calls.some((call) => call.error)
					? "toolErrorBg"
					: "toolSuccessBg";
			group.leader.addChild(new ActivityText(
				(width) => group.calls.map((call, index) => renderActivity(call, index, width)).join("\n\n"),
				outputPad,
				(text) => theme.bg(background, text),
			));
			return;
		}

		for (const [index, call] of group.calls.entries()) {
			if (index > 0) group.leader.addChild(new Spacer(1));
			const background = call.partial ? "toolPendingBg" : call.error ? "toolErrorBg" : "toolSuccessBg";
			group.leader.addChild(new ActivityText(
				(width) => renderActivity(call, index, width),
				outputPad,
				(text) => theme.bg(background, text),
			));
		}
	};

	const makeGroup = (specs: Array<{ id: string; tool: string; args: Args }>, previous?: ToolGroup): void => {
		if (specs.length === 0) return;
		const specIds = new Set(specs.map((spec) => spec.id));
		const mapped = groups.get(specs[0].id) ?? calls.get(specs[0].id)?.group;
		let group = previous ?? mapped;
		if (!previous && group?.calls.some((call) => !specIds.has(call.id))) group = undefined;
		if (!group) group = {
			calls: [],
			leader: new Container(),
		};
		groups.set(specs[0].id, group);
		const next: GroupCall[] = [];
		const displaced = new Set<ToolGroup>();
		for (const spec of specs) {
			let call = calls.get(spec.id);
			if (!call) {
				const seed = replaySeed?.get(spec.id);
				call = {
					...spec,
					output: seed?.output ?? "",
					details: seed?.details,
					partial: seed?.partial ?? true,
					error: seed?.error ?? false,
					group,
					shell: shells.get(spec.id),
				};
				calls.set(spec.id, call);
			} else if (call.group !== group) {
				displaced.add(call.group);
			}
			call.tool = spec.tool;
			call.args = spec.args;
			call.group = group;
			next.push(call);
		}
		const ids = new Set(next.map((call) => call.id));
		group.calls = previous ? [...group.calls.filter((call) => !ids.has(call.id)), ...next] : next;
		for (const stale of displaced) {
			stale.calls = stale.calls.filter((call) => call.group === stale);
			syncShells(stale);
			stale.invalidate?.();
			if (stale.calls.length === 0) {
				for (const [id, candidate] of groups) if (candidate === stale) groups.delete(id);
			}
		}
		syncShells(group);
		paint(group);
	};

	const rebuildFromMessages = (messages: Message[]): void => {
		const results = new Map(
			messages
				.filter((message) => message.role === "toolResult")
				.map((message) => [message.toolCallId, message]),
		);
		const seeded = new Map<string, GroupCall>();
		for (const message of messages) {
			if (message.role !== "assistant") continue;
			for (const part of message.content) {
				if (part.type !== "toolCall" || !supported.has(part.name)) continue;
				const result = results.get(part.id);
				seeded.set(part.id, {
					id: part.id,
					tool: part.name,
					args: part.arguments as Args,
					output: result ? textContent(result) : "",
					details: result?.details as Details,
					partial: !result,
					error: result?.isError ?? false,
					group: undefined as unknown as ToolGroup,
				});
			}
		}
		calls.clear();
		groups.clear();
		continuationId = undefined;
		replaySeed = seeded;
		let previous: ToolGroup | undefined;
		for (const message of messages) {
			if (message.role === "toolResult") continue;
			if (message.role !== "assistant") {
				previous = undefined;
				continue;
			}
			let run: Array<{ id: string; tool: string; args: Args }> = [];
			const flush = () => {
				makeGroup(run, previous);
				if (run.length > 0) previous = calls.get(run.at(-1)!.id)?.group;
				run = [];
			};
			for (const part of message.content) {
				if (part.type === "toolCall" && supported.has(part.name)) {
					run.push({ id: part.id, tool: part.name, args: part.arguments as Args });
				} else if (!isEmptyDisplayPart(part)) {
					flush();
					previous = undefined;
				}
			}
			flush();
		}
		replaySeed = undefined;
	};

	pi.on("session_start", (_event, ctx) => {
		detail = ctx.ui.getToolsExpanded() ? "expanded" : "collapsed";
		rebuildFromMessages(ctx.sessionManager.buildSessionContext().messages);
	});

	pi.on("session_tree", (_event, ctx) => {
		rebuildFromMessages(ctx.sessionManager.buildSessionContext().messages);
	});

	pi.on("session_compact", (_event, ctx) => {
		rebuildFromMessages(ctx.sessionManager.buildSessionContext().messages);
	});

	pi.on("message_update", (event) => {
		if (event.message.role !== "assistant") return;
		let previous = continuationId ? calls.get(continuationId)?.group : undefined;
		let run: Array<{ id: string; tool: string; args: Args }> = [];
		const flush = () => {
			makeGroup(run, previous);
			previous = undefined;
			run = [];
		};
		for (const part of event.message.content) {
			if (part.type === "toolCall" && supported.has(part.name)) {
				run.push({ id: part.id, tool: part.name, args: part.arguments as Args });
			} else if (!isEmptyDisplayPart(part)) {
				if (run.length > 0) flush();
				previous = undefined;
			}
		}
		flush();
	});

	pi.on("message_end", (event) => {
		if (event.message.role === "toolResult") return;
		if (event.message.role !== "assistant") {
			continuationId = undefined;
			return;
		}
		const last = event.message.content.findLast((part) => !isEmptyDisplayPart(part));
		continuationId = last?.type === "toolCall" && supported.has(last.name) ? last.id : undefined;
	});

	const toolDefinitions = [
		createReadToolDefinition(cwd),
		createBashToolDefinition(cwd),
		createEditToolDefinition(cwd),
		createWriteToolDefinition(cwd),
		createGrepToolDefinition(cwd),
		createFindToolDefinition(cwd),
		createLsToolDefinition(cwd),
	];

	for (const original of toolDefinitions) {
		const tool = original as ToolDefinition<any, any, CompactState>;
		pi.registerTool({
			...tool,
			renderShell: "self",
			renderCall(args: Args, theme, context) {
				detail = context.expanded ? "expanded" : "collapsed";
				let call = calls.get(context.toolCallId);
				if (!call) {
					makeGroup([{ id: context.toolCallId, tool: tool.name, args }]);
					call = calls.get(context.toolCallId)!;
				}
				call.args = args;
				context.state.call = call;
				const shell = context.lastComponent instanceof Container ? context.lastComponent : new Container();
				shells.set(call.id, shell);
				call.shell = shell;
				const group = call.group;
				group.theme = theme;
				if (group.calls[0] === call) group.invalidate = context.invalidate;
				syncShells(group);
				paint(group, theme);
				if (group.calls[0] !== call) group.invalidate?.();
				return shell;
			},
			renderResult(result, { isPartial }, theme, context) {
				detail = context.expanded ? "expanded" : "collapsed";
				const call = context.state.call ?? calls.get(context.toolCallId);
				if (call) {
					call.args = context.args as Args;
					call.output = textContent(result);
					call.details = result.details as Details;
					call.partial = isPartial;
					call.error = context.isError;
					paint(call.group, theme);
					if (call.group.calls[0] !== call) call.group.invalidate?.();
				}
				const shell = context.lastComponent instanceof Container ? context.lastComponent : new Container();
				shell.clear();
				return shell;
			},
		});
	}

	const repaint = (): void => {
		for (const group of groups.values()) {
			paint(group);
			group.invalidate?.();
		}
	};

	return {
		toggleExpanded(ctx) {
			detail = detail === "collapsed" ? "expanded" : "collapsed";
			ctx.ui.setToolsExpanded(detail === "expanded");
			repaint();
		},
		cycleCollapsed(ctx) {
			settings.toolView = settings.toolView === "one line"
				? "list"
				: settings.toolView === "list" ? "normal" : "one line";
			saveSettings(settings);
			ctx.ui.notify(`Collapsed tool view: ${settings.toolView}`, "info");
			repaint();
		},
	};
}

function skills(pi: ExtensionAPI): SkillCommand[] {
	return pi.getCommands().filter((command) => command.source === "skill");
}

function skillName(command: SkillCommand): string {
	return command.name.slice("skill:".length);
}

function normalizePath(path: string, cwd: string): string {
	const normalized = resolve(cwd, path.replace(/^@/, ""));
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function textFrom(message: Message): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function isLoaded(command: SkillCommand, ctx: ExtensionContext): boolean {
	const messages = ctx.sessionManager.buildSessionContext().messages;
	const expectedPath = normalizePath(command.sourceInfo.path, ctx.cwd);
	const successfulReads = new Set(
		messages
			.filter((message) => message.role === "toolResult" && message.toolName === "read" && !message.isError)
			.map((message) => message.toolCallId),
	);

	for (const message of messages) {
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (
					part.type === "toolCall" &&
					part.name === "read" &&
					successfulReads.has(part.id) &&
					typeof part.arguments.path === "string" &&
					normalizePath(part.arguments.path, ctx.cwd) === expectedPath
				) return true;
			}
		}
		if (textFrom(message).includes(`<skill name="${skillName(command)}" `)) return true;
	}
	return false;
}

function directive(command: SkillCommand, loaded: boolean): string {
	const name = skillName(command);
	if (loaded) return `Follow the already-loaded ${name} skill instructions from this conversation; do not read the skill again.`;
	const filePath = command.sourceInfo.path;
	const baseDir = command.sourceInfo.baseDir ?? dirname(filePath);
	return `Before doing the task, use the standard read tool to load the ${name} skill from ${filePath}. Resolve its relative references from ${baseDir}, then follow it.`;
}

function selectedDollarSkills(text: string, pi: ExtensionAPI): SkillCommand[] {
	const available = new Map(skills(pi).map((command) => [skillName(command), command]));
	const selected: SkillCommand[] = [];
	for (const match of text.matchAll(DOLLAR_SELECTOR)) {
		const command = available.get((match[2] ?? "").toLowerCase());
		if (command && !selected.includes(command)) selected.push(command);
	}
	return selected;
}

function wasReferenced(command: SkillCommand, ctx: ExtensionContext): boolean {
	return ctx.sessionManager.buildSessionContext().messages.some(
		(message) =>
			message.role === "custom" &&
			message.customType === "dollar-skills-loader" &&
			Array.isArray(message.details?.referenced) &&
			message.details.referenced.includes(skillName(command)),
	);
}

function createAutocompleteProvider(pi: ExtensionAPI, current: AutocompleteProvider): AutocompleteProvider {
	return {
		triggerCharacters: ["$"],
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
			const match = beforeCursor.match(/(?:^|\s)\$([a-z0-9-]*)$/i);
			if (!match) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			const query = (match[1] ?? "").toLowerCase();
			const items: AutocompleteItem[] = skills(pi)
				.map((command) => ({ name: skillName(command), description: command.description }))
				.filter(({ name }) => name.includes(query))
				.sort((a, b) => Number(b.name.startsWith(query)) - Number(a.name.startsWith(query)) || a.name.localeCompare(b.name))
				.slice(0, MAX_SUGGESTIONS)
				.map(({ name, description }) => ({ value: `$${name}`, label: `$${name}`, description }));
			if (options.signal.aborted || items.length === 0) return null;
			return { prefix: `$${match[1] ?? ""}`, items };
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

const PI_THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
const TOOLKIT_THEME_PATCH_KEY = Symbol.for("pi-toolkit:activity-theme-patch");
type ActivityThemePatch = { pendingTranscriptMarker?: string; bypassThinkingItalic: boolean };
type PatchableTheme = {
	fg?: (color: string, text: string) => string;
	italic?: (text: string) => string;
	[key: symbol]: unknown;
};
const separatedFinalBlocks = new Set<string>();
let hasVisibleActivity = false;

function isStatusRender(): boolean {
	return new Error().stack?.split("\n").some((line) => /\bshowStatus \(/.test(line)) ?? false;
}

function ensureActivityThemePatch(): ActivityThemePatch | undefined {
	const activeTheme = (globalThis as unknown as Record<symbol, unknown>)[PI_THEME_KEY] as PatchableTheme | undefined;
	if (!activeTheme || typeof activeTheme.fg !== "function") return undefined;
	const existing = activeTheme[TOOLKIT_THEME_PATCH_KEY] as ActivityThemePatch | undefined;
	if (existing) return existing;

	const state: ActivityThemePatch = { bypassThinkingItalic: false };
	const originalFg = activeTheme.fg.bind(activeTheme);
	const originalItalic = activeTheme.italic?.bind(activeTheme);
	activeTheme.fg = (color, text) => {
		if (color === "mdListBullet" && text === "- " && state.pendingTranscriptMarker) {
			const selected = state.pendingTranscriptMarker;
			state.pendingTranscriptMarker = undefined;
			return originalFg(color, `${selected} `);
		}
		if (color === "thinkingText") {
			state.bypassThinkingItalic = true;
			return originalFg("dim", text);
		}
		if (
			color === "error"
			&& /^(?:Operation aborted|Aborted after \d+ retry attempt|Response was truncated before completion\.|Error:)/.test(text)
		) return originalFg(color, `× ${text}`);
		if (color === "dim" && isStatusRender()) return originalFg(color, ` ${text}`);
		return originalFg(color, text);
	};
	if (originalItalic) {
		activeTheme.italic = (text) => {
			if (!state.bypassThinkingItalic) return originalItalic(text);
			state.bypassThinkingItalic = false;
			return text;
		};
	}
	activeTheme[TOOLKIT_THEME_PATCH_KEY] = state;
	return state;
}

function primeTranscriptMarker(marker: string): void {
	const state = ensureActivityThemePatch();
	if (state) state.pendingTranscriptMarker = marker;
}

function finalSeparator(width: number): string {
	const line = "─".repeat(Math.max(1, Math.floor(width)));
	const activeTheme = (globalThis as unknown as Record<symbol, unknown>)[PI_THEME_KEY] as {
		fg?: (color: string, text: string) => string;
	} | undefined;
	return activeTheme?.fg?.("dim", line) ?? line;
}

function markMarkdown(markdown: string, marker: string): string {
	// A one-item Markdown list supplies a native two-column hanging indent for wrapped lines and nested blocks.
	primeTranscriptMarker(marker);
	return markdown
		.split("\n")
		.map((line, index) => `${index === 0 ? "- " : "  "}${line}`)
		.join("\n");
}

function compactThinkingSummaries(markdown: string): string {
	return markdown
		.replace(/(\*\*[^\n]+\*\*)\n{2,}(?=\*\*[^\n]+\*\*(?:\n|$))/g, "$1  \n")
		.replace(/\*\*([^\n]+)\*\*/g, "$1");
}

function finalTextBlocks(message: Message): string[] {
	if (
		message.role !== "assistant"
		|| message.content.some((part) => part.type === "toolCall")
		|| message.stopReason === "aborted"
		|| message.stopReason === "error"
		|| message.stopReason === "length"
	) return [];
	return message.content
		.filter((part) => part.type === "text" && part.text.trim())
		.slice(0, 1)
		.map((part) => part.text.trim());
}

function trackVisibleActivity(message: Message): void {
	if (message.role === "user") {
		hasVisibleActivity = false;
		return;
	}
	const finalBlocks = finalTextBlocks(message);
	if (finalBlocks.length > 0) {
		const hasThinking = message.role === "assistant"
			&& message.content.some((part) => part.type === "thinking" && part.thinking.trim());
		for (const text of finalBlocks) {
			if (hasVisibleActivity || hasThinking) separatedFinalBlocks.add(text);
			else separatedFinalBlocks.delete(text);
		}
		hasVisibleActivity = false;
		return;
	}
	if (message.role === "assistant") {
		hasVisibleActivity ||= message.content.some((part) =>
			(part.type === "text" && Boolean(part.text.trim()))
			|| (part.type === "thinking" && Boolean(part.thinking.trim()))
			|| part.type === "toolCall");
	} else if (message.role === "toolResult") {
		hasVisibleActivity = true;
	}
}

function registerFinalResponseTracking(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		separatedFinalBlocks.clear();
		hasVisibleActivity = false;
		for (const message of ctx.sessionManager.buildSessionContext().messages) trackVisibleActivity(message);
	});
	pi.on("message_end", (event) => trackVisibleActivity(event.message));
}

function registerTranscriptMarkers(pi: ExtensionAPI): void {
	const register = (pi as unknown as {
		registerMarkdownTransformer?: (
			transformer: (markdown: string, context: { messageType: string; availableWidth: number }) => string,
		) => void;
	}).registerMarkdownTransformer;
	register?.((markdown, context) => {
		if (context.messageType === "user") return markMarkdown(markdown, "›");
		if (context.messageType === "assistant-thinking") return markMarkdown(compactThinkingSummaries(markdown), "◦");
		if (context.messageType === "assistant") {
			const marked = markMarkdown(markdown, "•");
			return separatedFinalBlocks.has(markdown.trim()) ? `${finalSeparator(context.availableWidth)}\n\n${marked}` : marked;
		}
		return markdown;
	});
}

function registerDollarSkills(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.addAutocompleteProvider((current) => createAutocompleteProvider(pi, current));
	});

	pi.on("before_agent_start", (event, ctx) => {
		const selected = selectedDollarSkills(event.prompt, pi)
			.map((command) => ({ command, loaded: isLoaded(command, ctx) }))
			.filter(({ command, loaded }) => !loaded || !wasReferenced(command, ctx));
		if (selected.length === 0) return;
		return {
			message: {
				customType: "dollar-skills-loader",
				content: selected.map(({ command, loaded }) => directive(command, loaded)).join("\n"),
				display: false,
				details: { referenced: selected.filter(({ loaded }) => loaded).map(({ command }) => skillName(command)) },
			},
		};
	});

	pi.on("input", (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		const available = new Map(skills(pi).map((command) => [skillName(command), command]));
		const selected: SkillCommand[] = [];
		let text = event.text;
		const commandMatch = text.match(SKILL_COMMAND);
		if (commandMatch) {
			const command = available.get((commandMatch[1] ?? "").toLowerCase());
			if (command) {
				selected.push(command);
				text = text.slice(commandMatch[0].length);
			}
		}
		text = text.replace(DOLLAR_SELECTOR, (token, whitespace: string, name: string) => {
			const command = available.get(name.toLowerCase());
			if (!command) return token;
			if (!selected.includes(command)) selected.push(command);
			return whitespace;
		});
		if (selected.length === 0) return { action: "continue" };
		const instructions = selected.map((command) => directive(command, isLoaded(command, ctx)));
		const prompt = text.trim();
		return { action: "transform", text: prompt ? `${instructions.join("\n")}\n\n${prompt}` : instructions.join("\n") };
	});
}

export default function piToolkit(pi: ExtensionAPI): void {
	registerObservability(pi);
	registerTranscriptMarkers(pi);
	const settings = loadSettings();
	const toolControls = settings.compactTools ? registerCompactTools(pi, settings) : undefined;
	registerWorkflowEditor(pi, settings, toolControls);
	registerFinalResponseTracking(pi);
	if (settings.dollarSkills) registerDollarSkills(pi);

	pi.registerCommand("ptk-settings", {
		description: "Toggle Pi Toolkit workflow features",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/ptk-settings requires TUI mode", "error");
				return;
			}
			let changed = false;
			const items: SettingItem[] = [
				{ id: "compactTools", label: "Compact tools", currentValue: settings.compactTools ? "on" : "off", values: ["on", "off"] },
				{
					id: "toolView",
					label: "Collapsed tool view",
					description: "Collapsed layout: aggregate only, aggregate with calls, or preview output.",
					currentValue: settings.toolView,
					values: ["one line", "list", "normal"],
				},
				{ id: "dollarSkills", label: "Dollar skills", currentValue: settings.dollarSkills ? "on" : "off", values: ["on", "off"] },
				{
					id: "ctrlBackspace",
					label: "Ctrl+Backspace word delete",
					description: "Adds Ctrl+Backspace to Pi's delete-word keybind in VS Code and Windows Terminal.",
					currentValue: settings.ctrlBackspace ? "on" : "off",
					values: ["on", "off"],
				},
			];
			await ctx.ui.custom((tui, theme, _kb, done) => {
				const container = new Container();
				container.addChild(new Text(theme.fg("accent", theme.bold("Pi Toolkit Workflow Settings")), 1, 1));
				const list = new SettingsList(
					items,
					items.length + 2,
					getSettingsListTheme(),
					(id, value) => {
						if (id === "toolView") settings.toolView = value as ToolView;
						else settings[id as "compactTools" | "ctrlBackspace" | "dollarSkills"] = value === "on";
						saveSettings(settings);
						changed = true;
					},
					() => done(undefined),
				);
				container.addChild(list);
				return {
					render: (width: number) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => { list.handleInput?.(data); tui.requestRender(); },
				};
			});
			if (changed) await ctx.reload();
		},
	});
}
