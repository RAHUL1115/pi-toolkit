import { readFileSync, writeFileSync } from "node:fs";

export type ToolView = "one line" | "list" | "normal";
export const LITE_REASONING_LEVELS = ["off", "low", "medium"] as const;
export type LiteReasoningEffort = typeof LITE_REASONING_LEVELS[number];
export const DEFAULT_LITE_REASONING: LiteReasoningEffort = "low";
export interface ToolkitSettings {
	autoSessionTitles: boolean;
	compactTools: boolean;
	ctrlBackspace: boolean;
	dollarSkills: boolean;
	toolView: ToolView;
	/** Absent means Auto. A provider/id value pins ptk/lite to that model. */
	liteModel?: string;
	liteReasoning: LiteReasoningEffort;
}

export function loadToolkitSettings(path: string): ToolkitSettings {
	let stored: Partial<Omit<ToolkitSettings, "toolView">> & { toolView?: string } = {};
	try {
		stored = JSON.parse(readFileSync(path, "utf8")) ?? {};
	} catch {
		// Missing or unreadable settings use defaults.
	}
	const liteModel = typeof stored.liteModel === "string" ? stored.liteModel.trim() : undefined;
	return {
		autoSessionTitles: stored.autoSessionTitles !== false,
		compactTools: stored.compactTools !== false,
		ctrlBackspace: stored.ctrlBackspace !== false,
		dollarSkills: stored.dollarSkills !== false,
		toolView: stored.toolView === "one line" || stored.toolView === "compact"
			? "one line"
			: stored.toolView === "normal" ? "normal" : "list",
		liteModel: liteModel && liteModel !== "Auto" ? liteModel : undefined,
		liteReasoning: LITE_REASONING_LEVELS.includes(stored.liteReasoning as LiteReasoningEffort)
			? stored.liteReasoning as LiteReasoningEffort : DEFAULT_LITE_REASONING,
	};
}

export function saveToolkitSettings(path: string, settings: ToolkitSettings): void {
	writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}
