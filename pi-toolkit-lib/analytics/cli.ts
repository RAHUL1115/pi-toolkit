import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { generateReport, importToStore } from "./service.js";
import { renderReport } from "./report.js";
import { collectionEnabled, writePrivateJson } from "./store.js";
import { importHistory } from "./history.js";

const HELP = `Pi Toolkit local analytics (build first: npm run build)
  npm run analytics -- enable|disable|status [--store PATH]
  npm run analytics -- import [--sessions PATH] [--store PATH]
    [--max-files N] [--max-bytes N] [--max-file-bytes N] [--timeout-ms N]
  npm run analytics -- report [--store PATH] [--days N] [--project HASH] [--json] [--out PATH]
  npm run analytics -- evidence EVENT_HASH [--sessions PATH] [--store PATH]

Collection is opt-in, local and content-minimized. No model calls or automatic edits.
Import is read-only; partial coverage and limits are explicit. Re-imports deduplicate.
Reports are also saved to STORE/latest-report.{md,json}. No deletion of original sessions.
`;

async function main(argv: string[]): Promise<void> {
  if (!argv.length || argv.includes("--help") || argv[0] === "help") { console.log(HELP); return; }
  const action = argv[0]!;
  if (!["enable", "disable", "status", "import", "report", "evidence"].includes(action)) throw new Error("Unknown action; use --help");
  const evidenceId = action === "evidence" ? argv[1] : undefined;
  if (action === "evidence" && !/^[a-f0-9]{64}$/.test(evidenceId ?? "")) throw new Error("evidence requires a full event digest from the report");
  const flags = new Map<string, string>();
  let json = false;
  const valueFlags = new Set(["--store", "--sessions", "--max-files", "--max-bytes", "--max-file-bytes", "--timeout-ms", "--days", "--project", "--out"]);
  for (let i = action === "evidence" ? 2 : 1; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--json") { json = true; continue; }
    if (!valueFlags.has(flag) || flags.has(flag) || !argv[i + 1] || argv[i + 1]!.startsWith("--")) throw new Error("Invalid or duplicate option; use --help");
    flags.set(flag, argv[++i]!);
  }
  const number = (flag: string): number | undefined => {
    const raw = flags.get(flag);
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${flag} must be a positive safe integer`);
    return n;
  };
  const root = resolve(flags.get("--store") ?? join(getAgentDir(), "analytics"));
  if (action === "enable" || action === "disable") {
    await writePrivateJson(root, "config.json", { enabled: action === "enable" });
    console.log(`${action === "enable" ? "Enabled" : "Disabled"} analytics for future/reloaded Toolkit sessions. Existing sessions need /reload. Store: ${root}`);
  } else if (action === "status") {
    console.log(JSON.stringify({ enabled: await collectionEnabled(root), store: root, environmentDisabled: process.env.PI_TOOLKIT_ANALYTICS === "0" }, null, 2));
  } else if (action === "evidence") {
    const controller = new AbortController();
    let found: { file: string; line: number } | undefined;
    const stats = await importHistory({ root: resolve(flags.get("--sessions") ?? join(getAgentDir(), "sessions")),
      signal: controller.signal, maxFiles: number("--max-files"), maxBytes: number("--max-bytes"),
      maxFileBytes: number("--max-file-bytes"), timeoutMs: number("--timeout-ms"),
      onEvent(event, location) { if (event.id === evidenceId) { found = location; controller.abort(); } },
    });
    // Explicit local lookup only: source locations are never copied into stored analytics.
    console.log(JSON.stringify(found ? { event: evidenceId, location: found } : { event: evidenceId, found: false, coverage: stats }, null, 2));
    if (!found) process.exitCode = 2;
  } else if (action === "import") {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      const result = await importToStore(root, {
        root: resolve(flags.get("--sessions") ?? join(getAgentDir(), "sessions")), signal: controller.signal,
        maxFiles: number("--max-files"), maxBytes: number("--max-bytes"), maxFileBytes: number("--max-file-bytes"), timeoutMs: number("--timeout-ms"),
      });
      console.log(JSON.stringify(result, null, 2));
      if (result.stats.partial) process.exitCode = 2;
    } finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
  } else {
    const days = number("--days");
    const project = flags.get("--project");
    if (project && !/^[a-f0-9]{64}$/.test(project)) throw new Error("--project must be a stored opaque project digest");
    const report = await generateReport(root, { since: days ? Date.now() - days * 86_400_000 : undefined, project });
    const content = json ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report);
    const out = flags.get("--out");
    if (out) {
      const file = await open(resolve(out), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
      try { await file.chmod(0o600); await file.writeFile(content); } finally { await file.close(); }
      console.log(`Saved report: ${resolve(out)}`);
    } else console.log(content);
  }
}

void main(process.argv.slice(2)).catch(error => {
  console.error(error instanceof Error ? error.message : "Analytics failed");
  process.exitCode = 1;
});
