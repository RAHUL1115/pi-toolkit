import { randomUUID } from "node:crypto";
import { importHistory } from "./history.js";
import { digest } from "./normalize.js";
import { buildReport, renderReport } from "./report.js";
import { EventWriter, readStore, recordHealth, writePrivateJson, writePrivateText } from "./store.js";

export async function importToStore(store: string, options: Omit<Parameters<typeof importHistory>[0], "onEvent">) {
  const existing = await readStore(store);
  const seen = new Set(existing.events.map(e => e.id));
  const writer = new EventWriter(store);
  let alreadyStored = 0;
  let added = 0;
  try {
    const stats = await importHistory({ ...options, onEvent: async event => {
      if (seen.has(event.id)) { alreadyStored++; return; }
      seen.add(event.id);
      writer.append(event);
      added++;
      if (writer.pending >= 256) await writer.flush();
    } });
    await writer.close();
    stats.duplicates += alreadyStored;
    if (writer.errors || writer.dropped) {
      stats.partial = true;
      stats.reasons.push("store_write_failure");
    }
    if (existing.coverage.partial) {
      stats.partial = true;
      stats.reasons.push("existing_store_partial");
    }
    await writePrivateJson(store, `import-${randomUUID()}.json`, { ...stats, rootHash: digest(options.root), importedAt: Date.now(), added: writer.written, alreadyStored });
    return { stats, added: writer.written, alreadyStored, dropped: writer.dropped, attempted: added };
  } finally { await writer.close(); await recordHealth(writer); }
}

export async function generateReport(store: string, options: Parameters<typeof buildReport>[1] = {}) {
  const snapshot = await readStore(store);
  const report = buildReport(snapshot, options);
  await writePrivateJson(store, "latest-report.json", report);
  await writePrivateText(store, "latest-report.md", renderReport(report));
  return report;
}
