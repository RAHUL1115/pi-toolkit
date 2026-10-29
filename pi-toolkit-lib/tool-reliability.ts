import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const TOOL_RELIABILITY_SECTION = "pi-toolkit-tool-reliability";

/** Fixed guidance: runtime counters and settings must not change the prompt prefix. */
export const TOOL_RELIABILITY_POLICY = `## Tool reliability policy
- Paths: reuse paths confirmed by the user or current repository evidence. When a path is uncertain or missing, check the working directory and discover it with find/ls or an equivalent available tool instead of guessing repeatedly. Avoid redundant existence checks for already verified paths.
- Arguments: follow the current tool schema, required fields, and supported options. For an unfamiliar API or CLI, inspect its declaration, documentation, or help before inventing parameters. Use only tools available in this session.
- Edits: inspect the current relevant text before editing; use the smallest unique exact match. Combine disjoint replacements against the same original file and merge overlapping edits. After a mismatch, re-read the affected region and construct a new match before retrying. Preserve unrelated user changes; a failed edit is not a reason to overwrite the whole file.
- Recovery: inspect the actual error, command exit code, and structured status before choosing the next action. Change the next attempt based on that evidence. Retry an unchanged call only for a known transient failure when repetition is safe; keep retries bounded. If an evidence-based retry fails again, investigate the cause or report the blocker rather than loop or bypass a permission restriction.
- Dependencies: use the repository's documented package manager, scripts, and pinned tooling. For a missing executable or dependency, inspect the manifest, lockfile, and setup instructions before choosing a remedy. Obtain authorization for installation or environment changes when required; avoid silently downloading unpinned substitutes.
- Long-running commands: use background execution when supported and retain the task/output reference. Follow the task tool's completion contract rather than launching duplicate work. After a timeout or interruption, establish whether the original operation is still running or already took effect before repeating a write, migration, deployment, or other side-effecting action.
- Nested calls: inspect per-call outcomes, not just whether a batch or wrapper completed. Distinguish thrown/rejected errors from fulfilled results that carry a nonzero exit code or failure status. When catching errors, expose a concise name/message and relevant cause; preserve failure status instead of returning apparent success, and keep credentials out of diagnostics.
- Verification: treat expected negative results, such as no search matches or an intentionally failing regression test, according to the task rather than as automatic task failures. Verify edits and fixes with relevant checks. Report unresolved failures and checks not run; successful recovery or prompt guidance alone does not prove the task is complete.`;

export default function registerToolReliability(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => {
		// Preserve native prompt sections/deltas, including custom-message turns.
		if (event.systemPromptOptions.forceSystemPrompt !== undefined) {
			if (event.systemPrompt.includes(TOOL_RELIABILITY_POLICY)) return;
			return { systemPrompt: `${event.systemPrompt}\n\n${TOOL_RELIABILITY_POLICY}` };
		}
		event.systemPromptOptions.sections[TOOL_RELIABILITY_SECTION] = TOOL_RELIABILITY_POLICY;
	});
}
