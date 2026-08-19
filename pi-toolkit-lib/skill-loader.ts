import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	stripFrontmatter,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";

const STATE_TYPE = "pi-toolkit:skill-loader";
const MAX_SUGGESTIONS = 20;
const ACTIVATION_TOKEN = /^\$([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)$/i;

type SkillCommand = ReturnType<ExtensionAPI["getCommands"]>[number];
type SkillState = { loaded: string[] };

function skillCommands(pi: ExtensionAPI): SkillCommand[] {
	return pi.getCommands().filter((command) => command.source === "skill");
}

function skillName(command: SkillCommand): string {
	return command.name.slice("skill:".length);
}

function commandMap(pi: ExtensionAPI): Map<string, SkillCommand> {
	return new Map(skillCommands(pi).map((command) => [skillName(command).toLowerCase(), command]));
}

function activationNames(text: string): string[] | undefined {
	const trimmed = text.trim();
	if (trimmed === "$") return [];
	if (!trimmed) return undefined;
	const names: string[] = [];
	for (const token of trimmed.split(/\s+/)) {
		const match = token.match(ACTIVATION_TOKEN);
		if (!match) return undefined;
		names.push((match[1] ?? "").toLowerCase());
	}
	return names;
}

function fuzzyScore(name: string, query: string): number | undefined {
	if (!query) return 0;
	if (name.startsWith(query)) return 1_000_000 - name.length;
	let previous = -2;
	let position = -1;
	let score = 0;
	for (const character of query) {
		position = name.indexOf(character, position + 1);
		if (position < 0) return undefined;
		score += position === previous + 1 ? 100 : 10;
		score += Math.max(0, 50 - position);
		previous = position;
	}
	return score;
}

export function createSkillAutocompleteProvider(pi: ExtensionAPI, current: AutocompleteProvider): AutocompleteProvider {
	return {
		triggerCharacters: ["$"],
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
			const match = beforeCursor.match(/(?:^|\s)\$([a-z0-9-]*)$/i);
			if (!match) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			const query = (match[1] ?? "").toLowerCase();
			const items: AutocompleteItem[] = skillCommands(pi)
				.map((command) => ({
					name: skillName(command),
					description: command.description,
					score: fuzzyScore(skillName(command).toLowerCase(), query),
				}))
				.filter((item): item is typeof item & { score: number } => item.score !== undefined)
				.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
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

function restoredNames(ctx: ExtensionContext): string[] {
	let latest: string[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
		const data = entry.data as Partial<SkillState> | undefined;
		if (Array.isArray(data?.loaded) && data.loaded.every((name) => typeof name === "string")) {
			latest = data.loaded;
		}
	}
	return latest;
}

function skillBlock(command: SkillCommand): string {
	const name = skillName(command);
	const location = command.sourceInfo.path;
	const baseDir = command.sourceInfo.baseDir ?? dirname(location);
	const body = stripFrontmatter(readFileSync(location, "utf8")).trim();
	if (!body) throw new Error("skill file has no instruction body");
	return `<skill name="${name}" location="${location}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
}

export default function registerSkillLoader(pi: ExtensionAPI): void {
	let loaded = new Set<string>();
	const persist = () => pi.appendEntry(STATE_TYPE, { loaded: [...loaded] } satisfies SkillState);
	const restore = (ctx: ExtensionContext) => {
		const available = commandMap(pi);
		const restored = restoredNames(ctx);
		loaded = new Set(restored.filter((name) => available.has(name.toLowerCase())));
		const missing = restored.filter((name) => !available.has(name.toLowerCase()));
		if (missing.length > 0) ctx.ui.notify(`Skipped unavailable skills: ${missing.join(", ")}`, "warning");
	};

	pi.on("session_start", (_event, ctx) => {
		restore(ctx);
		if (ctx.mode === "tui") {
			ctx.ui.addAutocompleteProvider((current) => createSkillAutocompleteProvider(pi, current));
		}
	});
	pi.on("session_tree", (_event, ctx) => restore(ctx));

	pi.on("input", (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		const names = activationNames(event.text);
		if (names === undefined) return { action: "continue" };
		const available = commandMap(pi);
		if (names.length === 0) {
			ctx.ui.notify(`Available skills: ${[...available.keys()].sort().join(", ") || "none"}`, "info");
			return { action: "handled" };
		}

		const unknown = [...new Set(names.filter((name) => !available.has(name)))];
		const selected = [...new Set(names.filter((name) => available.has(name)))];
		const added = selected.filter((name) => !loaded.has(name));
		for (const name of added) loaded.add(name);
		if (added.length > 0) {
			persist();
			ctx.ui.notify(`Loaded skills: ${added.join(", ")}`, "info");
		}
		if (unknown.length > 0) ctx.ui.notify(`Unknown skills: ${unknown.join(", ")}`, "warning");
		if (selected.length === 0) return { action: "handled" };
		if (added.length === 0) ctx.ui.notify("Those skills are already active", "info");
		return {
			action: "transform",
			text: `Follow the active skill instructions now: ${selected.join(", ")}.`,
		};
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (loaded.size === 0) return;
		const available = commandMap(pi);
		const blocks: string[] = [];
		for (const name of loaded) {
			const command = available.get(name.toLowerCase());
			if (!command) {
				ctx.ui.notify(`Could not load skill ${name}: no longer available`, "error");
				continue;
			}
			try {
				blocks.push(skillBlock(command));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not load skill ${name}: ${message}`, "error");
			}
		}
		if (blocks.length === 0) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${blocks.join("\n\n")}` };
	});

	pi.registerCommand("skills", {
		description: "Show active dollar skills",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`Active skills: ${[...loaded].join(", ") || "none"}`, "info");
		},
	});

	pi.registerCommand("skills-clear", {
		description: "Clear active dollar skills",
		handler: async (_args, ctx) => {
			if (loaded.size === 0) {
				ctx.ui.notify("No active skills to clear", "info");
				return;
			}
			loaded.clear();
			persist();
			ctx.ui.notify("Cleared active skills", "info");
		},
	});
}
