import { digest } from "./normalize.js";
import type { AnalyticsEvent, FailureCategory } from "./types.js";
import type { StoreSnapshot } from "./store.js";

export interface Proposal {
  id: string;
  status: "proposed";
  category: FailureCategory;
  occurrences: number;
  hypothesis: string;
  evidence: string[];
  validation: string;
}
const HYPOTHESES: Partial<Record<FailureCategory, string>> = {
  invalid_arguments: "Clarify tool schemas/examples and validate inputs before dispatch; do not silently coerce ambiguous arguments.",
  path_not_found: "Discover candidate paths before opening guessed filenames; test whether this reduces failed reads without excessive searching.",
  edit_mismatch: "Read the current narrow source range before editing; use a unique exact match and preserve unrelated changes.",
  timeout: "Distinguish execution deadlines from background lifetimes; choose bounded task-specific budgets rather than increasing all timeouts.",
  dependency: "Add an explicit environment preflight for the affected workflow, without automatically installing untrusted dependencies.",
  rate_limit: "Use bounded retry/backoff for idempotent operations and respect provider retry guidance.",
  network: "Test bounded retries for transient, idempotent requests; preserve failures instead of retrying indefinitely.",
};

export function buildReport(snapshot: StoreSnapshot, options: { since?: number; project?: string } = {}) {
  const events = snapshot.events.filter(e => e.timestamp >= (options.since ?? 0) && (!options.project || e.project === options.project))
    .sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
  const tools = events.filter(e => e.kind === "tool");
  const skills = events.filter(e => e.kind === "skill");
  const failures = tools.filter(e => e.status === "error");
  const commandFailures = tools.filter(e => e.status === "ok" && e.exitCode !== undefined && e.exitCode !== 0);
  const categories = new Map<FailureCategory, AnalyticsEvent[]>();
  for (const event of failures) {
    const category = event.failure?.category ?? "unknown";
    const list = categories.get(category) ?? []; list.push(event); categories.set(category, list);
  }
  const byTool = new Map<string, { tool: string; calls: number; errors: number; unfinished: number; commandFailures: number; timed: number; durationMs: number; nestedTimed: number; nestedElapsedMs: number }>();
  const bySkill = new Map<string, { skill: string; loaded: number; invoked: number; observedHashes: Set<string> }>();
  let exactRepeats = 0;
  const sameInputLaterSuccess: Array<{ failed: string; succeeded: string }> = [];
  const last = new Map<string, AnalyticsEvent>();
  // This is a temporal signal, never a claim that the task recovered or the same branch was followed.
  for (const e of tools) {
    const bucket = byTool.get(e.tool!) ?? { tool: e.tool!, calls: 0, errors: 0, unfinished: 0, commandFailures: 0, timed: 0, durationMs: 0, nestedTimed: 0, nestedElapsedMs: 0 };
    bucket.calls++;
    if (e.status === "error") bucket.errors++;
    if (e.status === "unfinished") bucket.unfinished++;
    if (e.status === "ok" && e.exitCode !== undefined && e.exitCode !== 0) bucket.commandFailures++;
    if (e.durationMs !== undefined) {
      if (e.durationKind === "nested_elapsed") { bucket.nestedTimed++; bucket.nestedElapsedMs += e.durationMs; }
      else { bucket.timed++; bucket.durationMs += e.durationMs; }
    }
    byTool.set(e.tool!, bucket);
    if (!e.inputHash || e.status === "unfinished") continue;
    const key = `${e.session}/${e.parent ?? "direct"}/${e.tool}/${e.inputHash}`;
    const previous = last.get(key);
    if (previous && e.timestamp > previous.timestamp && e.timestamp - previous.timestamp <= 15 * 60_000) {
      exactRepeats++;
      if (previous.status === "error" && e.status === "ok" && (e.exitCode === undefined || e.exitCode === 0)) {
        sameInputLaterSuccess.push({ failed: previous.id, succeeded: e.id });
      }
    }
    last.set(key, e);
  }
  for (const e of skills) {
    const bucket = bySkill.get(e.skill!) ?? { skill: e.skill!, loaded: 0, invoked: 0, observedHashes: new Set<string>() };
    if (e.skillState === "loaded") bucket.loaded++;
    if (e.skillState === "invoked") bucket.invoked++;
    if (e.skillHash) bucket.observedHashes.add(e.skillHash);
    bySkill.set(e.skill!, bucket);
  }
  const proposals: Proposal[] = [...categories.entries()].flatMap(([category, list]) => {
    const hypothesis = HYPOTHESES[category];
    if (!hypothesis || list.length < 3) return [];
    return [{
      id: digest("proposal", category, ...list.map(e => e.id).sort()), status: "proposed" as const, category,
      occurrences: list.length, hypothesis, evidence: list.slice(0, 5).map(e => e.id),
      validation: "Manually review evidence; reproduce in a disposable fixture. Compare fixed-model baseline and candidate across repeated trials plus held-out tasks. Require acceptance tests, no safety regressions, and acceptable cost/latency. Retain baseline on a tie or uncertainty; approve and version changes explicitly.",
    }];
  }).sort((a, b) => b.occurrences - a.occurrences || a.category.localeCompare(b.category));
  return {
    version: 1,
    coverage: { ...snapshot.coverage, partial: snapshot.coverage.partial || snapshot.imports.some(i => i.partial || i.skipped > 0 || i.invalid > 0),
      storePartial: snapshot.coverage.partial, imports: snapshot.imports, filteredSince: options.since ?? null, project: options.project ?? null },
    totals: { events: events.length, toolCalls: tools.length, direct: tools.filter(e => !e.parent).length, nested: tools.filter(e => e.parent).length,
      toolErrors: failures.length, commandFailures: commandFailures.length, unfinished: tools.filter(e => e.status === "unfinished").length,
      limited: tools.filter(e => e.limited).length, exactRepeats, sameInputLaterSuccess: sameInputLaterSuccess.length, skillObservations: skills.length },
    byTool: [...byTool.values()].sort((a, b) => b.errors - a.errors || b.calls - a.calls || a.tool.localeCompare(b.tool)),
    byFailure: [...categories.entries()].map(([category, list]) => ({ category, count: list.length, evidence: list.slice(0, 5).map(e => e.id) })).sort((a, b) => b.count - a.count || a.category.localeCompare(b.category)),
    bySkill: [...bySkill.values()].map(b => ({ ...b, observedHashes: [...b.observedHashes].sort() })).sort((a, b) => b.loaded - a.loaded || a.skill.localeCompare(b.skill)),
    sameInputLaterSuccess,
    proposals,
    limitations: [
      "Tool success is not verified task completion. Nonzero command exits are separate and may be expected (grep no-match, red tests).",
      "Failure categories are rule-based hypotheses, not proven root causes. Cancellation/permission denials are not necessarily mistakes.",
      "Later same-input success is temporal evidence only; branch changes and unrelated tasks can intervene. Changed-input recovery is not inferred.",
      "Skill loads/invocations do not prove application, usefulness or causality; historical version hashes are usually unavailable.",
      "Parent and nested calls are distinct attempts, not independent incidents. Non-Pi child processes are not automatically instrumented.",
      "Historical nested elapsed time includes hooks/queueing and is excluded from execution-time averages. Live nested observations wait for root finalization to share historical IDs.",
      "No token/cost accounting here: use /ptk-usage; aggregate parent/child usage lacks reliable cross-ledger provenance.",
      "Opaque digests are pseudonymous, not anonymous. No raw prompts, arguments, outputs, errors or reasoning are stored here.",
    ],
  };
}

export function renderReport(report: ReturnType<typeof buildReport>): string {
  const t = report.totals;
  const partialImports = report.coverage.imports.filter(i => i.partial || i.skipped || i.invalid);
  return [
    "# Pi Toolkit analytics", "",
    `${t.toolCalls} observed tool calls (${t.direct} direct / ${t.nested} nested); ${t.toolErrors} tool errors; ${t.commandFailures} nonzero command exits; ${t.unfinished} unfinished.`,
    `${t.exactRepeats} exact repeats within 15m; ${t.sameInputLaterSuccess} error → same-input later success signals.`,
    `${t.skillObservations} skill observations; ${t.limited} calls have limited historical metadata.`, "",
    report.coverage.partial || partialImports.length ? "**Partial coverage: inspect coverage metadata below.**" : "Coverage: imported/collected observations only; absence is not proof that no event occurred.",
    "", "## Tools", "", "| Tool | Calls | Errors | Nonzero exit | Timed calls | Mean execution ms |", "|---|---:|---:|---:|---:|---:|",
    ...report.byTool.map(b => `| ${b.tool} | ${b.calls} | ${b.errors} | ${b.commandFailures} | ${b.timed} | ${b.timed ? Math.round(b.durationMs / b.timed) : "unknown"} |`),
    "", "## Failure categories (inferred)", "",
    ...report.byFailure.map(b => `- **${b.category}**: ${b.count}. Evidence: ${b.evidence.map(e => e.slice(0, 16)).join(", ")}`),
    "", "## Skill observations — not effectiveness scores", "",
    ...report.bySkill.map(b => `- **${b.skill}**: ${b.loaded} loaded, ${b.invoked} invoked; ${b.observedHashes.length} observed instruction/version hashes.`),
    "", "## Improvement proposals — manual review only", "",
    ...(report.proposals.length ? report.proposals.flatMap(p => [
      `### ${p.category} (${p.occurrences} observations)`, p.hypothesis,
      `Evidence: ${p.evidence.join(", ")}`, `Validation: ${p.validation}`, "",
    ]) : ["No supported category has at least three observed tool failures. No changes proposed."]),
    "", "## Coverage", "", "```json", JSON.stringify(report.coverage, null, 2), "```",
    "", "## Limitations", "", ...report.limitations.map(l => `- ${l}`), "",
  ].join("\n");
}
