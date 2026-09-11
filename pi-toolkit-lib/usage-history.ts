import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { getAgentDir, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { summarizeUsage } from "./usage-snapshot.js";

export const WINDOWS = [1, 7, 30] as const;
const DAY = 86_400_000;
type UsageTotals = ReturnType<typeof summarizeUsage>;
export type ModelUsage = UsageTotals & { provider: string | null; model: string | null };
export type HistoryReport = ReturnType<typeof emptyReport>;
function emptyReport(now: number) {
  return { now, windows: WINDOWS.map(() => ({ ...summarizeUsage([]), byModel: [] as ModelUsage[] })),  files: 0, skipped: 0, invalid: 0, duplicates: 0, partial: false };
}

/** Message time is authoritative, not session creation or filesystem mtime.
 * ISO entry time is used only for summary entries and legacy missing message time. */
export function usageTime(entry: SessionEntry): number {
  if (entry.type === "message" && entry.message.timestamp !== undefined) {
    return typeof entry.message.timestamp === "number" ? entry.message.timestamp : NaN;
  }
  // Reject local dates: ledger ISO timestamps must identify an instant.
  return typeof entry.timestamp === "string" && /(?:Z|[+-]\d\d:\d\d)$/.test(entry.timestamp) ? Date.parse(entry.timestamp) : NaN;
}

/** Normalize only whitespace and an exact redundant provider prefix. Never guess
 * aliases (or case-fold custom IDs): distinct recorded models stay distinct. */
function modelIdentity(entry: SessionEntry): Pick<ModelUsage, "provider" | "model"> {
  if (entry.type === "message" && entry.message.role === "assistant") {
    const provider = typeof entry.message.provider === "string" ? entry.message.provider.trim() : "";
    let model = typeof entry.message.model === "string" ? entry.message.model.trim() : "";
    if (provider && model.startsWith(`${provider}/`)) model = model.slice(provider.length + 1).trim();
    if (provider && model) return { provider, model };
  }
  // Aggregate tool and summary usage does not identify the model that earned it.
  return { provider: null, model: null };
}

function addTotals(target: UsageTotals, totals: UsageTotals) {
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total", "cost", "missingCosts"] as const) target[key] += totals[key];
  if (totals.reasoning !== undefined) target.reasoning = (target.reasoning ?? 0) + totals.reasoning;
}
const compareId = (a: string | null, b: string | null) => (a ?? "") < (b ?? "") ? -1 : (a ?? "") > (b ?? "") ? 1 : 0;

export function historyAccumulator(now = Date.now()) {
  const report = emptyReport(now);
  const seen = new Set<string>();
  return {
    report,
    add(entry: SessionEntry) {
      if (!entry || typeof entry !== "object") { report.invalid++; return; }
      if (entry.type === "message" && (!entry.message || typeof entry.message !== "object")) { report.invalid++; return; }
      const usage = entry.type === "compaction" || entry.type === "branch_summary" ? entry.usage
        : entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult") ? entry.message.usage : undefined;
      if (!usage) return;
      if (typeof usage !== "object" || Array.isArray(usage) || typeof entry.id !== "string" || !entry.id) { report.invalid++; return; }
      if (entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "pending") return;
      const time = usageTime(entry);
      if (!Number.isFinite(time)) { report.invalid++; return; }
      if (time < now - 30 * DAY || time > now) return;
      // Native fork/clone preserves entry IDs and timestamps. IDs alone are only
      // 32-bit; include the original timestamp and payload hash to avoid collisions.
      // Parent links can change on branch extraction, so deliberately omit them.
      const payload = entry.type === "message" ? entry.message : { usage, summary: "summary" in entry ? entry.summary : undefined };
      if (typeof entry.id === "string" && entry.id) {
        const key = createHash("sha256").update(JSON.stringify([entry.id, entry.timestamp, payload])).digest("hex");
        if (seen.has(key)) { report.duplicates++; return; }
        seen.add(key);
      }
      const totals = summarizeUsage([entry]);
      const identity = modelIdentity(entry);
      WINDOWS.forEach((days, i) => {
        if (time < now - days * DAY) return;
        const target = report.windows[i]!;
        addTotals(target, totals);
        let bucket = target.byModel.find(b => b.provider === identity.provider && b.model === identity.model);
        if (!bucket) { bucket = { ...summarizeUsage([]), ...identity }; target.byModel.push(bucket); }
        addTotals(bucket, totals);
        target.byModel.sort((a, b) => b.total - a.total || compareId(a.provider, b.provider) || compareId(a.model, b.model));
      });
    },
  };
}

/** Read-only, one-pass ledger scan. Pi's list/listAll read all message content to
 * build search previews, have neither pagination nor AbortSignal, and would need
 * a second synchronous SessionManager.open pass. No public cross-session usage
 * API exists in 0.84.2. Stream the documented format instead; never open/migrate
 * sessions, send content to a model, or write an accounting cache.
 * ponytail: sequential IO (concurrency 1), 30s/512MiB/10k files; partial is explicit.
 */
export async function scanUsageHistory(
  sm: ExtensionContext["sessionManager"], signal: AbortSignal,
  options: { root?: string; now?: number; maxFiles?: number; maxBytes?: number; timeoutMs?: number } = {},
): Promise<HistoryReport> {
  const { report, add } = historyAccumulator(options.now);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const timer = setTimeout(cancel, options.timeoutMs ?? 30_000);
  timer.unref();
  const root = options.root ?? join(getAgentDir(), "sessions");
  let bytes = 0;
  const visited = new Set<string>();
  const activeFile = sm.getSessionFile();
  try {
    // Include completed in-memory messages even if persistence has not flushed.
    for (const entry of sm.getEntries()) add(entry);
    const readSession = async (file: string) => {
      if (visited.has(resolve(file))) return;
      visited.add(resolve(file));
      if (controller.signal.aborted) { report.partial = true; return; }
      if (report.files >= (options.maxFiles ?? 10_000)) { report.partial = true; cancel(); return; }
      report.files++;
      try {
        const info = await stat(file);
        if (info.size > 64 * 1024 * 1024) { report.skipped++; return; }
        bytes += info.size;
        if (bytes > (options.maxBytes ?? 512 * 1024 * 1024)) { report.partial = true; cancel(); return; }
        const input = createReadStream(file, { encoding: "utf8", signal: controller.signal });
        const lines = createInterface({ input, crlfDelay: Infinity });
        let header = false;
        try {
          for await (const line of lines) {
            if (controller.signal.aborted) { report.partial = true; break; }
            if (!line.trim()) continue;
            let entry;
            try { entry = JSON.parse(line); } catch { report.invalid++; continue; }
            if (!header) {
              if (entry?.type !== "session" || typeof entry.id !== "string" || ![2, 3].includes(entry.version)) { report.skipped++; break; }
              header = true;
              continue;
            }
            add(entry);
          }
          if (!header) report.partial = true;
        } finally { lines.close(); input.destroy(); }
      } catch { if (controller.signal.aborted) report.partial = true; else report.skipped++; }
    };
    const visit = async (dir: string, children: boolean) => {
      if (controller.signal.aborted) { report.partial = true; return; }
      try {
        const entries = await opendir(dir);
        for await (const entry of entries) {
          if (controller.signal.aborted) { report.partial = true; break; }
          const path = join(dir, entry.name);
          if (entry.isFile() && entry.name.endsWith(".jsonl")) await readSession(path);
          else if (children && (entry.isDirectory() || entry.isSymbolicLink())) await visit(path, false);
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") report.skipped++; }
    };
    if (activeFile) await readSession(activeFile);
    await visit(root, true);
    const customDir = sm.getSessionDir();
    if (customDir && resolve(dirname(customDir)) !== resolve(root)) await visit(customDir, false);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
  return report;
}
