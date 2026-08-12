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
	getSettingsListTheme,
	keyHint,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	type AutocompleteItem,
	type AutocompleteProvider,
	type SettingItem,
	SettingsList,
	Text,
} from "@earendil-works/pi-tui";
import registerObservability from "./pi-toolkit-lib/observability.js";

const SETTINGS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "pi-toolkit.json");
const MAX_SUGGESTIONS = 20;
const DOLLAR_SELECTOR = /(^|\s)\$([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?=$|\s|[.,;:!?])/gi;
const SKILL_COMMAND = /^\/skill:([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\s+|$)/i;

type ToolView = "compact" | "list";
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
};
type ToolGroup = {
	calls: GroupCall[];
	leader?: Text;
	invalidate?: () => void;
	theme?: RenderTheme;
	expanded: boolean;
};
type CompactState = { call?: GroupCall };
type SkillCommand = ReturnType<ExtensionAPI["getCommands"]>[number];
type Message = ReturnType<ExtensionContext["sessionManager"]["buildSessionContext"]>["messages"][number];

function loadSettings(): Settings {
	try {
		return { compactTools: true, ctrlBackspace: true, dollarSkills: true, toolView: "list", ...JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) };
	} catch {
		return { compactTools: true, ctrlBackspace: true, dollarSkills: true, toolView: "list" };
	}
}

function saveSettings(settings: Settings): void {
	writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function shorten(value: unknown, fallback = ""): string {
	const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : fallback;
	return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function subject(tool: string, args: Args): string {
	switch (tool) {
		case "bash":
			return shorten(args.command, "command");
		case "grep":
			return `/${shorten(args.pattern)}/ in ${shorten(args.path, ".")}`;
		case "find":
			return `${shorten(args.pattern)} in ${shorten(args.path, ".")}`;
		case "ls":
			return shorten(args.path, ".");
		default:
			return shorten(args.path);
	}
}

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((item) => item.type === "text")?.text ?? "";
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

const CTRL_BACKSPACE = "\x08";
const CTRL_W = "\x17";

class CtrlBackspaceEditor extends CustomEditor {
	override handleInput(data: string): void {
		super.handleInput(data === CTRL_BACKSPACE ? CTRL_W : data);
	}
}

function supportsCtrlBackspaceNormalization(): boolean {
	return process.platform === "win32"
		&& (process.env.TERM_PROGRAM === "vscode" || Boolean(process.env.WT_SESSION));
}

function registerCtrlBackspace(pi: ExtensionAPI, settings: Settings): void {
	let previousEditor: Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0];
	let installed = false;

	pi.on("session_start", (_event, ctx) => {
		if (!settings.ctrlBackspace || ctx.mode !== "tui" || !supportsCtrlBackspaceNormalization()) return;
		previousEditor = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, theme, keybindings) =>
			new CtrlBackspaceEditor(tui, theme, keybindings));
		installed = true;
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (!installed) return;
		ctx.ui.setEditorComponent(previousEditor);
		installed = false;
	});
}

function registerCompactTools(pi: ExtensionAPI, settings: Settings): void {
	const cwd = process.cwd();
	const supported = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
	const calls = new Map<string, GroupCall>();
	const groups = new Map<string, ToolGroup>();

	const empty = (component: unknown): Container => {
		const container = component instanceof Container ? component : new Container();
		container.clear();
		return container;
	};

	const paint = (group: ToolGroup, theme = group.theme): void => {
		if (!group.leader || !theme) return;
		group.theme = theme;
		const counts = new Map<string, number>();
		for (const call of group.calls) counts.set(call.tool, (counts.get(call.tool) ?? 0) + 1);
		const countText = [...counts].map(([name, count]) => `${count} ${name}`).join(" · ");
		let text = theme.fg("toolTitle", theme.bold(`tools ${countText}`));
		const full = group.expanded;
		if (settings.toolView === "list" || full) {
			for (const [index, call] of group.calls.entries()) {
				const branch = index === group.calls.length - 1 ? "└" : "├";
				const status = call.partial
					? theme.fg("warning", " …")
					: call.error
						? theme.fg("error", " failed")
						: theme.fg("success", ` ${summary(call.tool, call.args, call.output, call.details)}`);
				text += `\n${theme.fg("dim", `${branch} `)}${theme.fg("toolTitle", call.tool)} ${theme.fg("accent", subject(call.tool, call.args))}${status}`;
				if (full && !call.partial) {
					const body = expandedBody(call.tool, call.args, call.output, call.details);
					if (body) text += `\n${theme.fg("toolOutput", body)}`;
				}
			}
		}
		if (!full) text += theme.fg("dim", ` · ${keyHint("app.tools.expand", "full output")}`);
		group.leader.setText(text);
	};

	const makeGroup = (specs: Array<{ id: string; tool: string; args: Args }>): void => {
		if (specs.length === 0) return;
		let group = groups.get(specs[0].id);
		if (!group) {
			group = { calls: [], expanded: false };
			groups.set(specs[0].id, group);
		}
		const next: GroupCall[] = [];
		for (const spec of specs) {
			let call = calls.get(spec.id);
			if (!call) {
				call = { ...spec, output: "", details: undefined, partial: true, error: false, group };
				calls.set(spec.id, call);
			}
			call.tool = spec.tool;
			call.args = spec.args;
			call.group = group;
			next.push(call);
		}
		group.calls = next;
		paint(group);
	};

	pi.on("session_start", () => {
		calls.clear();
		groups.clear();
	});

	pi.on("message_update", (event) => {
		if (event.message.role !== "assistant") return;
		let run: Array<{ id: string; tool: string; args: Args }> = [];
		const flush = () => {
			makeGroup(run);
			run = [];
		};
		for (const part of event.message.content) {
			if (part.type === "toolCall" && supported.has(part.name)) {
				run.push({ id: part.id, tool: part.name, args: part.arguments as Args });
			} else if (run.length > 0) {
				flush();
			}
		}
		flush();
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
				let call = calls.get(context.toolCallId);
				if (!call) {
					makeGroup([{ id: context.toolCallId, tool: tool.name, args }]);
					call = calls.get(context.toolCallId)!;
				}
				call.args = args;
				context.state.call = call;
				const group = call.group;
				group.expanded = context.expanded;
				group.theme = theme;
				if (group.calls[0] === call) {
					group.leader = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
					group.invalidate = context.invalidate;
					paint(group, theme);
					return group.leader;
				}
				paint(group, theme);
				group.invalidate?.();
				return empty(context.lastComponent);
			},
			renderResult(result, { expanded, isPartial }, theme, context) {
				const call = context.state.call ?? calls.get(context.toolCallId);
				if (call) {
					call.args = context.args as Args;
					call.output = textContent(result);
					call.details = result.details as Details;
					call.partial = isPartial;
					call.error = context.isError;
					call.group.expanded = expanded;
					paint(call.group, theme);
					if (call.group.calls[0] !== call) call.group.invalidate?.();
				}
				return empty(context.lastComponent);
			},
		});
	}
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
	const settings = loadSettings();
	registerCtrlBackspace(pi, settings);
	if (settings.compactTools) registerCompactTools(pi, settings);
	if (settings.dollarSkills) registerDollarSkills(pi);

	pi.registerCommand("ptk-workflow-settings", {
		description: "Toggle Pi Toolkit workflow features",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/ptk-workflow-settings requires TUI mode", "error");
				return;
			}
			let changed = false;
			const items: SettingItem[] = [
				{ id: "compactTools", label: "Compact tools", currentValue: settings.compactTools ? "on" : "off", values: ["on", "off"] },
				{ id: "toolView", label: "Collapsed tool view", currentValue: settings.toolView, values: ["list", "compact"] },
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
