import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import type { AnalyticsEvent, FailureCategory, ImportStats } from "./types.js";
import { safeName } from "./normalize.js";

const MAX_QUEUE = 2048;
const MAX_LINE = 8192;
const IMPORT_REASONS = new Set(["cancelled", "timeout", "event_limit", "max_files", "unreadable_file", "unsupported_file", "max_file_bytes", "malformed_data", "max_line_bytes", "unsupported_version", "missing_header", "call_input_limit", "nested_call_limit", "nested_metadata_incomplete", "max_bytes", "missing_root", "unreadable_directory", "symlink", "max_depth", "store_write_failure", "existing_store_partial"]);
export interface StoreCoverage { files: number; invalid: number; duplicates: number; partial: boolean; reasons: string[] }
export interface StoreSnapshot { events: AnalyticsEvent[]; coverage: StoreCoverage; imports: Array<ImportStats & { rootHash?: string; importedAt?: number }> }

async function safeAncestors(root: string): Promise<void> {
  for (let path = resolve(root); ; path = dirname(path)) {
    try { if ((await lstat(path)).isSymbolicLink()) throw Object.assign(new Error("Analytics paths must not contain symlinks"), { code: "ANALYTICS_SYMLINK" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (path === dirname(path)) break;
  }
}

export async function privateDirectory(root: string): Promise<void> {
  await safeAncestors(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Analytics directory must be a real directory");
  await chmod(root, 0o700);
}

/** Atomic metadata writes; never follow a destination symlink. */
export async function writePrivateJson(root: string, name: string, value: unknown): Promise<void> {
  await writePrivateText(root, name, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writePrivateText(root: string, name: string, content: string): Promise<void> {
  if (!/^[a-z0-9-]+\.(?:json|md)$/.test(name)) throw new Error("Invalid metadata filename");
  await privateDirectory(root);
  const temp = join(root, `${name}.${randomUUID()}.tmp`);
  try {
    const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(content); } finally { await file.close(); }
    await rename(temp, join(root, name));
  } finally { await unlink(temp).catch(() => {}); }
}

export async function collectionEnabled(root: string): Promise<boolean> {
  if (process.env.PI_TOOLKIT_ANALYTICS === "0") return false;
  try {
    await safeAncestors(root);
    const file = await open(join(root, "config.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 4096) return false;
      return JSON.parse(await file.readFile("utf8"))?.enabled === true;
    } finally { await file.close(); }
  } catch { return false; }
}

/** One file per writer avoids cross-process locks and interleaved writes. Hot hooks only queue.
 * Failures/drop counts are observable; telemetry must never fail a tool or gate its execution. */
export class EventWriter {
  private queue: string[] = [];
  private draining?: Promise<void>;
  private name = `events-${randomUUID()}.jsonl`;
  private fileBytes = 0;
  private closed = false;
  dropped = 0;
  errors = 0;
  written = 0;
  constructor(readonly root: string) {}
  get pending(): number { return this.queue.length; }
  append(event: AnalyticsEvent): void {
    if (this.closed || this.queue.length >= MAX_QUEUE) { this.dropped++; return; }
    try {
      const safe = decodeEvent(event);
      if (!safe) { this.errors++; this.dropped++; return; }
      const line = JSON.stringify(safe) + "\n";
      if (Buffer.byteLength(line) > MAX_LINE) { this.dropped++; return; }
      this.queue.push(line);
      if (!this.draining) {
        // Defer IO off the tool event path; no timer survives shutdown.
        this.startDrain();
      }
    } catch { this.errors++; }
  }
  private startDrain(): void {
    this.draining = Promise.resolve().then(() => this.drain()).finally(() => {
      this.draining = undefined;
      if (this.queue.length) this.startDrain();
    });
  }
  private async drain(): Promise<void> {
    try {
      await privateDirectory(this.root);
      const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK;
      let file = await open(join(this.root, this.name), flags, 0o600);
      try {
        while (this.queue.length) {
          const batch = this.queue.splice(0, 256);
          const text = batch.join("");
          const bytes = Buffer.byteLength(text);
          try {
            if (this.fileBytes + bytes > 16 * 1024 * 1024) {
              await file.close();
              this.name = `events-${randomUUID()}.jsonl`;
              this.fileBytes = 0;
              file = await open(join(this.root, this.name), flags, 0o600);
            }
            if (!(await file.stat()).isFile()) throw new Error("Analytics requires a regular file");
            await file.writeFile(text); this.written += batch.length; this.fileBytes += bytes;
          }
          catch { this.dropped += batch.length; throw new Error("Analytics write failed"); }
        }
      } finally { await file.close(); }
    } catch { this.errors++; this.dropped += this.queue.length; this.queue.length = 0; }
  }
  async flush(): Promise<void> {
    while (this.draining || this.queue.length) {
      if (this.draining) await this.draining;
      else this.startDrain();
    }
  }
  async close(): Promise<void> { this.closed = true; await this.flush(); }
}

/** Whitelist schema at both boundaries. Unknown fields never enter storage/reports. */
function decodeEvent(value: any): AnalyticsEvent | undefined {
  const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
  if (!(value?.v === 1 && hash(value.id) && hash(value.session) && hash(value.project)
    && Number.isFinite(value.timestamp) && value.timestamp >= 0
    && ["live", "history"].includes(value.source) && ["tool", "skill"].includes(value.kind)
    && value.evidence && typeof value.evidence === "object"
    && (value.kind === "tool" ? typeof value.tool === "string" && ["ok", "error", "unfinished"].includes(value.status)
      : typeof value.skill === "string" && ["loaded", "invoked"].includes(value.skillState)))) return undefined;
  const result: AnalyticsEvent = {
    v: 1, id: value.id, session: value.session, project: value.project, source: value.source,
    timestamp: value.timestamp, kind: value.kind, evidence: {},
  };
  for (const key of ["call", "entry"] as const) if (hash(value.evidence[key])) result.evidence[key] = value.evidence[key];
  for (const key of ["parent", "inputHash", "skillHash"] as const) if (hash(value[key])) result[key] = value[key];
  for (const key of ["provider", "model", "harnessVersion"] as const) if (value[key] !== undefined) result[key] = safeName(value[key]);
  if (value.kind === "tool") { result.tool = safeName(value.tool); result.status = value.status; }
  else { result.skill = safeName(value.skill); result.skillState = value.skillState; }
  if (typeof value.durationMs === "number" && Number.isFinite(value.durationMs) && value.durationMs >= 0) {
    result.durationMs = value.durationMs;
    result.durationKind = value.durationKind === "nested_elapsed" ? "nested_elapsed" : "execution";
  }
  if (typeof value.rootTimestamp === "number" && Number.isFinite(value.rootTimestamp) && value.rootTimestamp >= 0) result.rootTimestamp = value.rootTimestamp;
  if (Number.isSafeInteger(value.exitCode)) result.exitCode = value.exitCode;
  if (typeof value.limited === "boolean") result.limited = value.limited;
  const categories: FailureCategory[] = ["invalid_arguments", "path_not_found", "edit_mismatch", "permission", "authentication", "rate_limit", "network", "timeout", "dependency", "cancelled", "runtime", "unknown"];
  const rules = new Set(["operation_cancelled", "authentication_rejected", "rate_limit_reached", "edit_target_mismatch", "argument_validation_failed", "path_missing", "permission_denied", "operation_timed_out", "network_connection_failed", "dependency_missing", "runtime_exception", "timeout_reported", "command_nonzero_exit", "tool_error_unclassified"]);
  if (categories.includes(value.failure?.category) && ["high", "medium", "low"].includes(value.failure?.confidence) && rules.has(value.failure?.rule)) {
    result.failure = { category: value.failure.category, confidence: value.failure.confidence, rule: value.failure.rule };
  }
  return result;
}

/** Bounded, local read. Identical copied/imported events are merged, preferring richer live data. */
export async function readStore(root: string, options: { maxBytes?: number; maxEvents?: number } = {}): Promise<StoreSnapshot> {
  const coverage: StoreCoverage = { files: 0, invalid: 0, duplicates: 0, partial: false, reasons: [] };
  const events = new Map<string, AnalyticsEvent>();
  const imports: StoreSnapshot["imports"] = [];
  const mark = (reason: string) => { coverage.partial = true; if (!coverage.reasons.includes(reason)) coverage.reasons.push(reason); };
  let bytes = 0;
  let names: string[];
  try {
    await safeAncestors(root);
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) { mark("unsafe_store"); return { events: [], coverage, imports }; }
    names = (await readdir(root)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") mark((error as NodeJS.ErrnoException).code === "ANALYTICS_SYMLINK" ? "unsafe_store" : "unreadable_store");
    return { events: [], coverage, imports };
  }
  for (const name of names) {
    if (!/^events-[a-f0-9-]+\.jsonl$/.test(name) && !/^import-[a-f0-9-]+\.json$/.test(name) && !/^health-[a-f0-9-]+\.json$/.test(name)) continue;
    if (coverage.files >= 20_000) { mark("store_file_limit"); break; }
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await file.stat();
      if (!info.isFile()) { mark("unsafe_file"); continue; }
      if (info.size > 32 * 1024 * 1024) { mark("store_file_size_limit"); continue; }
      bytes += info.size;
      if (bytes > (options.maxBytes ?? 256 * 1024 * 1024)) { mark("store_byte_limit"); break; }
      coverage.files++;
      const content = await file.readFile("utf8");
      if (!name.endsWith(".jsonl")) {
        const metadata = JSON.parse(content);
        if (name.startsWith("import-")) {
          const counts = ["files", "bytes", "events", "invalid", "skipped", "duplicates"] as const;
          if (!counts.every(k => Number.isSafeInteger(metadata?.[k]) && metadata[k] >= 0) || !Array.isArray(metadata.reasons)) { mark("invalid_import_metadata"); continue; }
          imports.push({ files: metadata.files, bytes: metadata.bytes, events: metadata.events, invalid: metadata.invalid,
            skipped: metadata.skipped, duplicates: metadata.duplicates, partial: metadata.partial === true,
            ...(typeof metadata.rootHash === "string" && /^[a-f0-9]{64}$/.test(metadata.rootHash) ? { rootHash: metadata.rootHash } : {}),
            ...(Number.isFinite(metadata.importedAt) && metadata.importedAt >= 0 ? { importedAt: metadata.importedAt } : {}),
            reasons: metadata.reasons.slice(0, 64).map((r: unknown) => typeof r === "string" && IMPORT_REASONS.has(r) ? r : "unknown_reason") });
        }
        else if (metadata.dropped || metadata.errors) mark("collector_dropped_events");
        continue;
      }
      for (const line of content.split("\n")) {
        if (!line) continue;
        let event: AnalyticsEvent | undefined;
        try { event = decodeEvent(JSON.parse(line)); } catch { coverage.invalid++; continue; }
        if (Buffer.byteLength(line) > MAX_LINE || !event) { coverage.invalid++; continue; }
        const prior = events.get(event.id);
        if (prior) {
          coverage.duplicates++;
          // Keep original provenance but fill metadata absent in one view. Live observations
          // include nested error details that bounded historical metadata may have omitted.
          const preferred = prior.source !== event.source ? (prior.source === "live" ? prior : event)
            : prior.limited !== event.limited ? (prior.limited ? event : prior) : event;
          const other = preferred === prior ? event : prior;
          events.set(event.id, { ...other, ...preferred, evidence: { ...other.evidence, ...preferred.evidence }, limited: preferred.limited ?? false });
        } else {
          if (events.size >= (options.maxEvents ?? 500_000)) { mark("store_event_limit"); break; }
          events.set(event.id, event);
        }
      }
      if (coverage.reasons.includes("store_event_limit")) break;
    } catch { mark("unreadable_record_file"); }
    finally { await file?.close().catch(() => {}); }
  }
  if (coverage.invalid) mark("invalid_store_records");
  return { events: [...events.values()].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id)), coverage, imports };
}

export async function recordHealth(writer: EventWriter): Promise<void> {
  if (writer.dropped || writer.errors) await writePrivateJson(writer.root, `health-${randomUUID()}.json`, { dropped: writer.dropped, errors: writer.errors }).catch(() => {});
}
