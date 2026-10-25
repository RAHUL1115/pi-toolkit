import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { AnalyticsCollector, scopeFor } from "./collector.js";
import { generateReport, importToStore } from "./service.js";
import { collectionEnabled, EventWriter, recordHealth, writePrivateJson } from "./store.js";

/** Explicit opt-in, separate from shared Toolkit settings so /ptk cannot accidentally reset consent. */
export default function registerAnalytics(pi: ExtensionAPI, options: { root?: string; sessions?: string } = {}): void {
  const root = options.root ?? join(getAgentDir(), "analytics");
  const sessions = options.sessions ?? join(getAgentDir(), "sessions");
  let writer: EventWriter | undefined;
  let collector: AnalyticsCollector | undefined;
  let importing: AbortController | undefined;
  let busy = false;
  const stop = async () => {
    const oldWriter = writer;
    const oldCollector = collector;
    collector = undefined;
    writer = undefined;
    oldCollector?.stop();
    if (oldWriter) {
      if (oldCollector?.incomplete) oldWriter.dropped += oldCollector.incomplete;
      await oldWriter.close();
      await recordHealth(oldWriter);
    }
  };
  const start = async (ctx: ExtensionContext) => {
    await stop();
    if (!(await collectionEnabled(root))) return;
    const next = new EventWriter(root);
    writer = next;
    collector = new AnalyticsCollector(scopeFor(ctx.sessionManager.getSessionId(), ctx.cwd), event => next.append(event));
  };
  const observe = (operation: () => void) => {
    try { operation(); } catch { if (writer) writer.errors++; }
  };
  pi.on("session_start", async (_event, ctx) => { try { await start(ctx); } catch { /* Analytics must not break session startup. */ } });
  pi.on("session_shutdown", async () => { importing?.abort(); await stop().catch(() => {}); });
  pi.on("tool_execution_start", event => observe(() => collector?.start(event)));
  pi.on("tool_execution_end", event => observe(() => collector?.end(event)));
  pi.on("message_end", event => observe(() => collector?.message(event.message)));
  pi.on("agent_settled", async () => {
    const current = writer;
    if (!current) return;
    await current.flush();
    if (current.dropped || current.errors) await recordHealth(current);
  });

  pi.registerCommand("ptk-analytics", {
    description: "Local tool/skill analytics: status, enable, disable, import, report (no automatic edits)",
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (!["status", "enable", "disable", "import", "report"].includes(action)) {
        ctx.ui.notify("Usage: /ptk-analytics status|enable|disable|import|report. See docs/analytics.md for CLI limits/custom roots.", "info");
        return;
      }
      if (busy) { ctx.ui.notify("An analytics operation is already running.", "warning"); return; }
      busy = true;
      try {
        if (action === "status") {
          ctx.ui.notify(`Analytics collection: ${collector ? "active" : "inactive"}; saved opt-in: ${await collectionEnabled(root) ? "on" : "off"}. Local store: ${root}. Queued: ${writer?.pending ?? 0}; dropped: ${writer?.dropped ?? 0}; errors: ${writer?.errors ?? 0}. No automatic skill/config edits.`, "info");
        } else if (action === "enable") {
          await writePrivateJson(root, "config.json", { enabled: true });
          await start(ctx);
          ctx.ui.notify(collector ? "Local analytics enabled for this session and future Toolkit sessions. Other running sessions need /reload." : "Saved opt-in, but PI_TOOLKIT_ANALYTICS=0 disables collection in this process.", "info");
        } else if (action === "disable") {
          await writePrivateJson(root, "config.json", { enabled: false });
          await stop();
          ctx.ui.notify("Analytics collection disabled here and for future sessions. Other running sessions need /reload. Existing local records retained.", "info");
        } else if (action === "import") {
          importing = new AbortController();
          const result = await importToStore(root, { root: sessions, signal: importing.signal });
          const partial = result.stats.partial || result.stats.invalid || result.stats.skipped;
          ctx.ui.notify(`Imported ${result.added} new observations from ${result.stats.files} files; ${result.alreadyStored} already stored.${partial ? ` Partial coverage: ${result.stats.reasons.join(", ")}. Use CLI for larger limits.` : ""} Run /ptk-analytics report.`, partial ? "warning" : "info");
        } else {
          await writer?.flush();
          const report = await generateReport(root);
          ctx.ui.notify(`Analytics: ${report.totals.toolCalls} tool calls, ${report.totals.toolErrors} tool errors, ${report.proposals.length} review-only proposals. Reports: ${join(root, "latest-report.md")} and latest-report.json.`, report.coverage.partial ? "warning" : "info");
        }
      } catch {
        ctx.ui.notify("Analytics operation failed. Check store access and CLI diagnostics; original sessions were not modified.", "error");
      } finally { importing = undefined; busy = false; }
    },
  });
}
