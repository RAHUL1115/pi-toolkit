import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerGoal from "@narumitw/pi-goal/dist/index.ts";
import { inChildSessionContext } from "./unified-subagents/child-context.js";

/** Goal owns the parent session; child agents must not inherit its continuation loop. */
export default function registerGoals(pi: ExtensionAPI): void {
	if (inChildSessionContext()) return;
	registerGoal(pi);
}
