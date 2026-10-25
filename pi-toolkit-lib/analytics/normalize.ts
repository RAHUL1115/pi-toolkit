import { createHash } from "node:crypto";
import type { AnalyticsEvent, EventScope, Failure, SkillObservation, ToolObservation } from "./types.js";

/** Canonical JSON: object key order is irrelevant; array order remains significant. */
export function digest(...parts: unknown[]): string {
  const ancestors = new Set<object>();
  const canonical = (value: unknown): unknown => {
    if (typeof value === "bigint") return { $bigint: String(value) };
    if (value === null || typeof value !== "object") return value;
    if (ancestors.has(value)) return "[Circular]";
    ancestors.add(value);
    const result = Array.isArray(value)
      ? value.map(canonical)
      : Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
    ancestors.delete(value);
    return result;
  };
  return createHash("sha256").update(JSON.stringify(canonical(parts))).digest("hex");
}

function isName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 160
    && !/[^A-Za-z0-9_.:/-]/.test(value)
    && !value.startsWith("/") && !value.includes("://")
    && !/(^|\/)\.{1,2}(\/|$)/.test(value)
    && !/^[A-Za-z]:\//.test(value)
    && !/^(?:sk-|ghp_|github_pat_|xox[baprs]-|AKIA)/i.test(value);
}

/** Reject, rather than transform, free text and unsafe metadata. */
export function safeName(value: unknown, fallback = "unknown"): string {
  return isName(value) ? value : isName(fallback) ? fallback : "unknown";
}

type Rule = readonly [Failure["category"], Failure["confidence"], string, RegExp];
const RULES: readonly Rule[] = [
  ["cancelled", "high", "operation_cancelled", /\b(?:aborterror|aborted|cancelled|canceled)\b/i],
  ["authentication", "high", "authentication_rejected", /\b(?:unauthorized|authentication failed|invalid (?:api key|token)|expired token|HTTP 401)\b/i],
  ["rate_limit", "high", "rate_limit_reached", /\b(?:rate[ -]limit(?:ed| exceeded)?|too many requests|HTTP 429)\b/i],
  ["edit_mismatch", "high", "edit_target_mismatch", /(?:could not find (?:the )?(?:exact|old) text|oldText.*(?:not found|match|unique)|(?:text|edit|replacement).*(?:does not match|did not match|not unique)|multiple matches found)/i],
  ["invalid_arguments", "high", "argument_validation_failed", /\b(?:invalid (?:arguments?|parameters?)|validation (?:failed|error)|schema validation|required (?:argument|parameter).*missing|missing required (?:argument|parameter))\b/i],
  ["path_not_found", "high", "path_missing", /\b(?:ENOENT|no such file or directory|file not found|path not found)\b/i],
  ["permission", "high", "permission_denied", /\b(?:EACCES|EPERM|permission denied|operation not permitted|access denied|forbidden|HTTP 403)\b/i],
  ["timeout", "high", "operation_timed_out", /\b(?:ETIMEDOUT|ESOCKETTIMEDOUT|timed out|deadline exceeded|TimeoutError)\b/i],
  ["network", "high", "network_connection_failed", /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|network unreachable|network error|fetch failed|socket hang up)\b/i],
  ["dependency", "high", "dependency_missing", /\b(?:MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|cannot find (?:module|package)|command not found|No module named)\b/i],
  ["runtime", "high", "runtime_exception", /\b(?:TypeError|ReferenceError|SyntaxError|RangeError|segmentation fault|uncaught exception)\b/i],
  ["timeout", "medium", "timeout_reported", /\btimeout\b/i],
];

/** A command's exit status is not a tool/agent error, nor is prose evidence of failure. */
export function classifyFailure(text: string, isError: boolean, exitCode?: number): Failure | undefined {
  if (!isError) {
    return validExitCode(exitCode) && exitCode !== 0
      ? { category: "unknown", confidence: "low", rule: "command_nonzero_exit" }
      : undefined;
  }
  for (const [category, confidence, rule, pattern] of RULES) {
    if (pattern.test(text)) return { category, confidence, rule };
  }
  return { category: "unknown", confidence: "low", rule: "tool_error_unclassified" };
}

function validExitCode(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function exitCodeFrom(details: unknown): number | undefined {
  const data = record(details);
  if (validExitCode(data?.exitCode)) return data.exitCode;
  if (validExitCode(data?.exit_code)) return data.exit_code;
  return undefined;
}

function textFrom(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => {
    const data = record(block);
    return data?.type === "text" && typeof data.text === "string" ? [data.text] : [];
  }).join("\n");
}

function scopeFields(scope: EventScope): EventScope {
  // Session and project are opaque identifiers supplied by the collector/importer.
  return {
    session: scope.session,
    project: scope.project,
    source: scope.source,
    ...(scope.provider !== undefined ? { provider: safeName(scope.provider) } : {}),
    ...(scope.model !== undefined ? { model: safeName(scope.model) } : {}),
    ...(scope.harnessVersion !== undefined ? { harnessVersion: safeName(scope.harnessVersion) } : {}),
  };
}

export function toolEvent(o: ToolObservation): AnalyticsEvent {
  const exitCode = exitCodeFrom(o.details);
  const failure = classifyFailure(textFrom(o.content), o.isError, exitCode);
  return {
    ...scopeFields(o.scope),
    v: 1,
    id: o.parentId !== undefined
      ? digest("nested", o.callId, o.rootTimestamp ?? o.timestamp)
      : digest("tool", o.callId, o.timestamp, o.tool),
    timestamp: o.timestamp,
    kind: "tool",
    tool: safeName(o.tool),
    evidence: {
      call: digest(o.callId),
      ...(o.entryId !== undefined ? { entry: digest(o.entryId) } : {}),
    },
    ...(o.parentId !== undefined ? { parent: digest(o.parentId) } : {}),
    ...(o.input !== undefined ? { inputHash: digest(o.input) } : {}),
    status: o.isError ? "error" : o.unfinished ? "unfinished" : "ok",
    ...(typeof o.durationMs === "number" && Number.isFinite(o.durationMs) && o.durationMs >= 0
      ? { durationMs: o.durationMs, durationKind: o.durationKind ?? "execution" } : {}),
    ...(o.parentId !== undefined ? { rootTimestamp: o.rootTimestamp ?? o.timestamp } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(failure ? { failure } : {}),
    ...(o.limited !== undefined ? { limited: o.limited } : {}),
  };
}

export function skillEvent(o: SkillObservation): AnalyticsEvent {
  return {
    ...scopeFields(o.scope),
    v: 1,
    id: digest("skill", o.identity, o.name, o.state),
    timestamp: o.timestamp,
    kind: "skill",
    evidence: o.entryId !== undefined ? { entry: digest(o.entryId) } : {},
    skill: safeName(o.name),
    skillState: o.state,
    ...(o.content !== undefined ? { skillHash: digest(o.content) } : {}),
  };
}
