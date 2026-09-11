import type { ExtensionContext, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";

export type UsageTheme = Pick<Theme, "fg" | "bold">;
const amount = (n: number | undefined) => typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
export const tokens = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}m` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : `${n}`;
export const singleLine = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ");

/** Mirrors Pi 0.84's AgentSession.getSessionStats ledger scope. ExtensionContext
 * does not expose that method. getEntries() is the public accounting source:
 * all branches, including compacted messages, summary usage and toolResult.usage.
 * Never recurse into tool details/retainedTail or add subagent lifecycle events:
 * those duplicate usage already carried by finalized tool results.
 */
export function summarizeUsage(entries: readonly SessionEntry[]) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, missingCosts: 0, reasoning: undefined as number | undefined };
  for (const entry of entries) {
    const usage = entry.type === "compaction" || entry.type === "branch_summary" ? entry.usage
      : entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult") ? entry.message.usage : undefined;
    if (!usage) continue;
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) totals[key] += amount(usage[key]);
    if (typeof usage.reasoning === "number" && Number.isFinite(usage.reasoning)) totals.reasoning = (totals.reasoning ?? 0) + amount(usage.reasoning);
    if (typeof usage.cost?.total === "number" && Number.isFinite(usage.cost.total) && usage.cost.total >= 0) totals.cost += usage.cost.total;
    else totals.missingCosts++;
  }
  totals.total = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
  return totals;
}

export function usageSnapshot(ctx: Pick<ExtensionContext, "sessionManager" | "model" | "thinkingLevel" | "getContextUsage">) {
  return {
    ...summarizeUsage(ctx.sessionManager.getEntries()),
    model: singleLine(ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "No model"),
    thinking: ctx.model?.reasoning ? ctx.thinkingLevel : undefined,
    context: ctx.getContextUsage(),
  };
}
export type UsageSnapshot = ReturnType<typeof usageSnapshot>;
export const estimatedCost = (s: Pick<UsageSnapshot, "cost" | "missingCosts">) => `~$${s.cost.toFixed(4)}${s.missingCosts ? "+?" : ""}`;
export function contextLabel(s: UsageSnapshot) {
  const c = s.context;
  return c?.tokens != null ? `${c.percent?.toFixed(0) ?? "?"}% ${tokens(c.tokens)}/${tokens(c.contextWindow)}` : c ? `unknown/${tokens(c.contextWindow)}` : "unavailable";
}
