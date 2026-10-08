import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { liteModelSetting } from "../pi-toolkit-lib/lite-model-setting.js";
import { loadToolkitSettings, saveToolkitSettings } from "../pi-toolkit-lib/toolkit-settings.js";

vi.mock("@earendil-works/pi-coding-agent", () => ({
	getSelectListTheme: () => ({
		selectedPrefix: (text: string) => text,
		selectedText: (text: string) => text,
		description: (text: string) => text,
		scrollInfo: (text: string) => text,
		noMatch: (text: string) => text,
	}),
}));

const dirs: string[] = [];
function settingsPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "ptk-settings-"));
	dirs.push(dir);
	return join(dir, "pi-toolkit.json");
}

afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("Toolkit Lite settings", () => {
	it("defaults custom styling on and persists either toggle value", () => {
		const path = settingsPath();
		expect(loadToolkitSettings(path).customStyling).toBe(true);
		writeFileSync(path, JSON.stringify({ compactTools: false }));
		const settings = loadToolkitSettings(path);
		expect(settings.customStyling).toBe(true);
		for (const enabled of [false, true]) {
			settings.customStyling = enabled;
			saveToolkitSettings(path, settings);
			expect(loadToolkitSettings(path).customStyling).toBe(enabled);
		}
	});
	it("defaults to Auto for new and existing settings", () => {
		const path = settingsPath();
		expect(loadToolkitSettings(path)).toMatchObject({ liteModel: undefined, liteReasoning: "low" });
		writeFileSync(path, JSON.stringify({ compactTools: false, toolView: "compact" }));
		expect(loadToolkitSettings(path)).toMatchObject({ compactTools: false, toolView: "one line", liteModel: undefined });
	});

	it("ignores and removes the retired Ctrl+Backspace setting on save", () => {
		const path = settingsPath();
		writeFileSync(path, JSON.stringify({ ctrlBackspace: true, compactTools: false }));
		const settings = loadToolkitSettings(path);
		expect(settings).not.toHaveProperty("ctrlBackspace");
		expect(settings.compactTools).toBe(false);
		saveToolkitSettings(path, settings);
		expect(JSON.parse(readFileSync(path, "utf8"))).not.toHaveProperty("ctrlBackspace");
	});

	it("persists a manual pin across reloads and clears it when Auto is selected", () => {
		const path = settingsPath();
		const settings = loadToolkitSettings(path);
		settings.liteModel = "openai/gpt-5.6-luna";
		saveToolkitSettings(path, settings);
		expect(loadToolkitSettings(path).liteModel).toBe("openai/gpt-5.6-luna");
		settings.liteModel = undefined;
		saveToolkitSettings(path, settings);
		expect(JSON.parse(readFileSync(path, "utf8"))).not.toHaveProperty("liteModel");
		expect(loadToolkitSettings(path).liteModel).toBeUndefined();
	});

	it.each(["", "  ", "Auto", null, 123])("normalizes %s to Auto", (liteModel) => {
		const path = settingsPath();
		writeFileSync(path, JSON.stringify({ liteModel }));
		expect(loadToolkitSettings(path).liteModel).toBeUndefined();
	});

	it("persists default reasoning independently of the model choice", () => {
		const path = settingsPath();
		const settings = loadToolkitSettings(path);
		settings.liteReasoning = "medium";
		saveToolkitSettings(path, settings);
		expect(loadToolkitSettings(path)).toMatchObject({ liteModel: undefined, liteReasoning: "medium" });
		writeFileSync(path, JSON.stringify({ liteReasoning: "invalid" }));
		expect(loadToolkitSettings(path).liteReasoning).toBe("low");
	});

	it("displays the dynamically resolved Auto model and handles an empty catalog", () => {
		const older = { id: "gpt-5.6-luna", provider: "openai", api: "openai-responses" } as any;
		const newer = { ...older, id: "gpt-6-luna" };
		expect(liteModelSetting([older]).currentValue).toBe("Auto (openai/gpt-5.6-luna)");
		expect(liteModelSetting([older, newer]).currentValue).toBe("Auto (openai/gpt-6-luna)");
		expect(liteModelSetting([]).currentValue).toBe("Auto (no model available)");
		expect(liteModelSetting([older, newer], "openai/gpt-5.6-luna").currentValue).toBe("openai/gpt-5.6-luna");
	});

	it("provides a searchable physical-only submenu with Auto and cancellation", () => {
		const models = [
			{ id: "gpt-6-luna", provider: "openai", api: "openai-responses" },
			{ id: "gpt-99-luna", provider: "virtual", api: "pi-virtual" },
		] as any;
		const setting = liteModelSetting(models);
		expect(setting.currentValue).toBe("Auto (openai/gpt-6-luna)");
		const done = vi.fn();
		const submenu = setting.submenu!("Auto", done);
		expect(submenu.render(100).join("\n")).not.toContain("virtual/gpt-99-luna");
		submenu.handleInput!("luna");
		submenu.handleInput!("\x1b[B");
		submenu.handleInput!("\r");
		expect(done).toHaveBeenCalledWith("openai/gpt-6-luna");
		const chooseAuto = setting.submenu!("Auto", done);
		chooseAuto.handleInput!("\r");
		expect(done).toHaveBeenLastCalledWith("Auto");
		const cancel = setting.submenu!("Auto", done);
		cancel.handleInput!("\x1b");
		expect(done).toHaveBeenLastCalledWith();
	});
});
