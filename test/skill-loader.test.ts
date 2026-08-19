import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import registerSkillLoader from "../pi-toolkit-lib/skill-loader.js";

type Handler = (event: any, ctx: any) => any;

function harness(skillFiles: Record<string, string>) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	const entries: Array<{ customType: string; data: unknown }> = [];
	const skillCommands = Object.entries(skillFiles).map(([name, path]) => ({
		name: `skill:${name}`,
		description: `${name} description`,
		source: "skill" as const,
		sourceInfo: { path, baseDir: join(path, ".."), source: "test", scope: "user", origin: "top-level" },
	}));
	const pi = {
		getCommands: () => skillCommands,
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ customType, data });
		},
		registerCommand(name: string, command: any) {
			commands.set(name, command);
		},
	} as unknown as ExtensionAPI;
	registerSkillLoader(pi);
	return { handlers, commands, entries };
}

function context(branch: any[] = [], mode = "tui") {
	const notifications: Array<{ message: string; type?: string }> = [];
	let autocompleteFactory: ((current: AutocompleteProvider) => AutocompleteProvider) | undefined;
	const ctx = {
		mode,
		ui: {
			notify(message: string, type?: string) { notifications.push({ message, type }); },
			addAutocompleteProvider(factory: (current: AutocompleteProvider) => AutocompleteProvider) {
				autocompleteFactory = factory;
			},
		},
		sessionManager: { getBranch: () => branch },
	} as unknown as ExtensionContext;
	return { ctx, notifications, getAutocompleteFactory: () => autocompleteFactory };
}

describe("dollar skill loader", () => {
	let directory: string;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "pi-toolkit-skills-"));
	});

	afterEach(() => rmSync(directory, { recursive: true, force: true }));

	function skill(name: string, body: string, disabled = false): string {
		const path = join(directory, `${name}.md`);
		writeFileSync(path, `---\nname: ${name}\ndescription: test\ndisable-model-invocation: ${disabled}\n---\n\n${body}\n`);
		return path;
	}

	it("activates explicit skills without an agent turn and injects fresh bodies", async () => {
		const publicPath = skill("public-skill", "first public body");
		const privatePath = skill("private-skill", "private body", true);
		const { handlers, entries } = harness({ "public-skill": publicPath, "private-skill": privatePath });
		const { ctx, notifications } = context();
		await handlers.get("session_start")![0]({}, ctx);

		expect(await handlers.get("before_agent_start")![0]({ systemPrompt: "base" }, ctx)).toBeUndefined();
		expect(await handlers.get("input")![0]({ text: "$public-skill $private-skill", source: "interactive" }, ctx))
			.toEqual({ action: "handled" });
		expect(entries.at(-1)?.data).toEqual({ loaded: ["public-skill", "private-skill"] });

		const first = await handlers.get("before_agent_start")![0]({ systemPrompt: "base" }, ctx);
		expect(first.systemPrompt).toContain("first public body");
		expect(first.systemPrompt).toContain("private body");
		expect(first.systemPrompt).not.toContain("disable-model-invocation");
		expect(notifications.at(-1)?.message).toBe("Loaded skills: public-skill, private-skill");

		writeFileSync(publicPath, "---\nname: public-skill\ndescription: test\n---\n\nupdated body\n");
		const updated = await handlers.get("before_agent_start")![0]({ systemPrompt: "base" }, ctx);
		expect(updated.systemPrompt).toContain("updated body");
		expect(updated.systemPrompt).not.toContain("first public body");
	});

	it("does not swallow normal prompts and reports bare or unknown selectors", async () => {
		const { handlers, entries } = harness({ alpha: skill("alpha", "alpha body") });
		const { ctx, notifications } = context();
		await handlers.get("session_start")![0]({}, ctx);
		const input = handlers.get("input")![0];

		expect(await input({ text: "$alpha do the work", source: "interactive" }, ctx)).toEqual({ action: "continue" });
		expect(await input({ text: "$", source: "interactive" }, ctx)).toEqual({ action: "handled" });
		expect(notifications.at(-1)?.message).toBe("Available skills: alpha");
		expect(await input({ text: "$missing", source: "interactive" }, ctx)).toEqual({ action: "handled" });
		expect(notifications.at(-1)).toEqual({ message: "Unknown skills: missing", type: "warning" });
		expect(entries).toEqual([]);
	});

	it("restores branch-local state and clears it through commands", async () => {
		const { handlers, commands, entries } = harness({ alpha: skill("alpha", "alpha body") });
		const branch = [
			{ type: "custom", customType: "pi-toolkit:skill-loader", data: { loaded: ["alpha"] } },
		];
		const { ctx, notifications } = context(branch);
		await handlers.get("session_start")![0]({}, ctx);

		const injected = await handlers.get("before_agent_start")![0]({ systemPrompt: "base" }, ctx);
		expect(injected.systemPrompt).toContain("alpha body");
		await commands.get("skills").handler("", ctx);
		expect(notifications.at(-1)?.message).toBe("Active skills: alpha");
		await commands.get("skills-clear").handler("", ctx);
		expect(entries.at(-1)?.data).toEqual({ loaded: [] });
		expect(await handlers.get("before_agent_start")![0]({ systemPrompt: "base" }, ctx)).toBeUndefined();

		const alternate = context([{ type: "custom", customType: "pi-toolkit:skill-loader", data: { loaded: ["alpha"] } }]);
		await handlers.get("session_tree")![0]({}, alternate.ctx);
		expect((await handlers.get("before_agent_start")![0]({ systemPrompt: "base" }, alternate.ctx)).systemPrompt)
			.toContain("alpha body");
	});

	it("fuzzy-ranks prefixes first and skips unreadable skills", async () => {
		const missingPath = join(directory, "missing.md");
		const { handlers } = harness({ writing: skill("writing", "writing body"), "web-writing": skill("web-writing", "web body"), missing: missingPath });
		const { ctx, notifications, getAutocompleteFactory } = context();
		await handlers.get("session_start")![0]({}, ctx);
		const current = {
			getSuggestions: async () => null,
			applyCompletion: (lines: string[], cursorLine: number, cursorCol: number) => ({ lines, cursorLine, cursorCol }),
		} as AutocompleteProvider;
		const provider = getAutocompleteFactory()!(current);
		const suggestions = await provider.getSuggestions(["$wri"], 0, 4, { signal: new AbortController().signal });
		expect(suggestions?.items.map((item) => item.value)).toEqual(["$writing", "$web-writing"]);

		await handlers.get("input")![0]({ text: "$missing", source: "interactive" }, ctx);
		expect(await handlers.get("before_agent_start")![0]({ systemPrompt: "base" }, ctx)).toBeUndefined();
		expect(notifications.at(-1)?.message).toMatch(/^Could not load skill missing:/);
	});
});
