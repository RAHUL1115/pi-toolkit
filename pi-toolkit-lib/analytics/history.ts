import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { digest, skillEvent, toolEvent } from "./normalize.js";
import type { AnalyticsEvent, EventScope, ImportStats } from "./types.js";
import { isSkillName, nestedParent, readSkillName, skillObservations } from "./skills.js";

const LINE_BYTES = 1024 * 1024;
const INPUT_BYTES = 4 * 1024 * 1024;
const MAX_CALLS = 256;
const MAX_EVENTS = 250_000;
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096;
const skillName = isSkillName;
function time(entry: Record<string, any>): number {
  if (entry.message?.timestamp !== undefined) return typeof entry.message.timestamp === "number" ? entry.message.timestamp : NaN;
  return typeof entry.timestamp === "string" && /(?:Z|[+-]\d\d:\d\d)$/.test(entry.timestamp) ? Date.parse(entry.timestamp) : NaN;
}

/** Read original v2/v3 ledger records only: no migration, context reconstruction,
 * current skill lookup, token accounting, or persistence. Limits deliberately
 * report partial coverage rather than silently treating summaries as originals. */
export async function importHistory(options: {
  root: string; signal?: AbortSignal; maxFiles?: number; maxBytes?: number;
  maxFileBytes?: number; timeoutMs?: number;
  onEvent: (event: AnalyticsEvent, location: { file: string; line: number }) => Promise<void> | void;
}): Promise<ImportStats> {
  const stats: ImportStats = { files: 0, bytes: 0, events: 0, invalid: 0, skipped: 0, duplicates: 0, partial: false, reasons: [] };
  const reason = (name: string) => { stats.partial = true; if (!stats.reasons.includes(name)) stats.reasons.push(name); };
  const limit = (value: number | undefined, fallback: number) => value === undefined ? fallback : Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const maxFiles = limit(options.maxFiles, 10_000);
  const maxBytes = limit(options.maxBytes, 512 * 1024 * 1024);
  const maxFileBytes = limit(options.maxFileBytes, 64 * 1024 * 1024);
  const deadline = Date.now() + limit(options.timeoutMs, 30_000);
  const stopped = () => {
    if (options.signal?.aborted) { reason("cancelled"); return true; }
    if (Date.now() >= deadline) { reason("timeout"); return true; }
    return false;
  };
  const seen = new Set<string>();
  let currentFile = "";
  let currentLine = 0;
  const emit = async (event: AnalyticsEvent) => {
    if (stopped()) return;
    if (seen.has(event.id)) { stats.duplicates++; return; }
    if (seen.size >= MAX_EVENTS) { reason("event_limit"); return; }
    // Sink errors propagate: they are not malformed history or filesystem errors.
    await options.onEvent(event, { file: currentFile, line: currentLine });
    seen.add(event.id);
    stats.events++;
  };
  const readFile = async (path: string) => {
    currentFile = path;
    currentLine = 0;
    if (stats.files >= maxFiles) { reason("max_files"); return; }
    stats.files++;
    let handle: Awaited<ReturnType<typeof open>>;
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch { stats.skipped++; reason("unreadable_file"); return; }
    try {
      const info = await handle.stat();
      if (!info.isFile()) { stats.skipped++; reason("unsupported_file"); return; }
      if (info.size > maxFileBytes) { stats.skipped++; reason("max_file_bytes"); return; }
      let scope: EventScope | undefined;
      let first = true;
      let rejected = false;
      let inputBytes = 0;
      const calls = new Map<string, { input: unknown; bytes: number; scope: EventScope }>();
      let loaded = new Set<string>();
      const invalid = () => { stats.invalid++; reason("malformed_data"); };
      const line = async (text: string) => {
        if (!text.trim()) return;
        let entry: Record<string, any>;
        try { const parsed: unknown = JSON.parse(text); if (!object(parsed)) { invalid(); return; } entry = parsed; }
        catch { invalid(); return; }
        if (first) {
          first = false;
          if (entry.type !== "session" || ![2, 3].includes(entry.version) || !identifier(entry.id) || !identifier(entry.cwd)) {
            stats.skipped++; reason(entry.type === "session" && ![2, 3].includes(entry.version) ? "unsupported_version" : "missing_header"); rejected = true; return;
          }
          scope = { session: digest(entry.id), project: digest(entry.cwd), source: "history" };
          return;
        }
        if (!scope) return;
        if (typeof entry.type !== "string" || !identifier(entry.id)) { invalid(); return; }
        const entryId = entry.id;
        const timestamp = time(entry);
        const skill = async (name: string, state: "loaded" | "invoked", identity: string, eventScope = scope!) => {
          await emit(skillEvent({ scope: eventScope, timestamp, name, state, identity, entryId }));
        };
        if (entry.type === "custom" && entry.customType === "pi-toolkit:skill-loader") {
          if (!Number.isFinite(timestamp) || !Array.isArray(entry.data?.loaded) || !entry.data.loaded.every(skillName)) { invalid(); return; }
          const next = new Set<string>(entry.data.loaded);
          // Activation state proves a request, not a successful body read.
          // Actual expanded user/system blocks are the loaded evidence.
          for (const name of next) if (!loaded.has(name)) await skill(name, "invoked", entryId);
          loaded = next;
          return;
        }
        if (entry.type !== "message") return;
        const message = entry.message;
        if (!object(message) || typeof message.role !== "string") { invalid(); return; }
        if (message.role === "assistant") {
          if (message.stopReason === "pending") return;
          // Provenance is paired to the actual call, not guessed from the latest
          // model_change or from a neighboring branch's assistant message.
          const callScope = { ...scope, provider: identifier(message.provider) ? message.provider : undefined, model: identifier(message.model) ? message.model : undefined };
          if (!Array.isArray(message.content)) { invalid(); return; }
          for (const block of message.content) {
            if (!object(block) || block.type !== "toolCall") continue;
            if (!identifier(block.id) || !identifier(block.name)) { invalid(); continue; }
            const bytes = Buffer.byteLength(JSON.stringify(block.arguments) ?? "");
            const previous = calls.get(block.id);
            if (previous) { inputBytes -= previous.bytes; calls.delete(block.id); }
            while (calls.size && (calls.size >= MAX_CALLS || inputBytes + bytes > INPUT_BYTES)) {
              const key = calls.keys().next().value!;
              inputBytes -= calls.get(key)!.bytes; calls.delete(key); reason("call_input_limit");
            }
            if (bytes <= INPUT_BYTES) { calls.set(block.id, { input: block.arguments, bytes, scope: callScope }); inputBytes += bytes; }
            else reason("call_input_limit");
          }
          return;
        }
        if (message.role === "user" || message.role === "system") {
          if (!Number.isFinite(timestamp)) { invalid(); return; }
          for (const observation of skillObservations({ ...message, timestamp })) {
            await emit(skillEvent({ ...observation, scope, timestamp, entryId }));
          }
          return;
        }
        if (message.role !== "toolResult") return;
        if (!Number.isFinite(timestamp)) { invalid(); return; }
        if (!identifier(message.toolCallId) || !identifier(message.toolName) || typeof message.isError !== "boolean") { invalid(); return; }
        const call = calls.get(message.toolCallId);
        const eventScope = call?.scope ?? scope;
        await emit(toolEvent({ scope: eventScope, callId: message.toolCallId, tool: message.toolName, timestamp, input: call?.input, content: message.content, details: message.details, isError: message.isError, durationMs: message.durationMs, limited: !call, entryId }));
        const nested = message.nestedCalls?.calls;
        if (message.nestedCalls?.complete === false) reason("nested_metadata_incomplete");
        if (Array.isArray(nested)) {
          if (nested.length > MAX_CALLS) reason("nested_call_limit");
          for (const child of nested.slice(0, MAX_CALLS)) {
            if (!object(child) || !identifier(child.id) || !identifier(child.name ?? child.toolName ?? child.tool) || !["ok", "error", "unfinished"].includes(child.status)) { invalid(); continue; }
            await emit(toolEvent({ scope: eventScope, callId: child.id, parentId: nestedParent(message.toolCallId, child.id), tool: child.name ?? child.toolName ?? child.tool, timestamp, input: child.arguments, isError: child.isError === true || child.status === "error", content: typeof child.error === "string" ? [{ type: "text", text: child.error }] : undefined, durationMs: typeof child.durationMs === "number" && Number.isFinite(child.durationMs) && child.durationMs >= 0 ? child.durationMs : undefined, unfinished: child.status === "unfinished", durationKind: "nested_elapsed", limited: true, entryId }));
          }
        }
        const readName = !message.isError ? readSkillName(message.toolName, call?.input) : undefined;
        if (readName) await skill(readName, "loaded", `read:${message.toolCallId}:${timestamp}`, eventScope);
        if (call) { inputBytes -= call.bytes; calls.delete(message.toolCallId); }
      };
      // A readline interface buffers a newline-free file without a bound. Keep
      // at most 1 MiB here and discard the rest of an oversized line in chunks.
      const buffer = Buffer.alloc(64 * 1024);
      let parts: Buffer[] = [];
      let length = 0;
      let dropping = false;
      let fileBytes = 0;
      while (!stopped() && !rejected && seen.size < MAX_EVENTS) {
        const budget = Math.min(buffer.length, maxBytes - stats.bytes, maxFileBytes - fileBytes);
        if (budget <= 0) {
          if (fileBytes < info.size) reason(stats.bytes >= maxBytes ? "max_bytes" : "max_file_bytes");
          break;
        }
        let count: number;
        try { count = (await handle.read(buffer, 0, budget, null)).bytesRead; }
        catch { stats.skipped++; reason("unreadable_file"); break; }
        if (!count) break;
        stats.bytes += count; fileBytes += count;
        let start = 0;
        for (let i = 0; i <= count; i++) {
          if (i !== count && buffer[i] !== 10) continue;
          const piece = buffer.subarray(start, i);
          if (!dropping && length + piece.length > LINE_BYTES) { dropping = true; parts = []; length = 0; invalid(); reason("max_line_bytes"); }
          if (!dropping) { parts.push(Buffer.from(piece)); length += piece.length; }
          if (i < count) {
            currentLine++;
            if (!dropping) await line(Buffer.concat(parts, length).toString("utf8"));
            parts = []; length = 0; dropping = false;
          }
          start = i + 1;
          if (rejected || stopped()) break;
        }
      }
      if (!stopped() && !rejected && length && fileBytes === info.size) { currentLine++; await line(Buffer.concat(parts, length).toString("utf8")); }
      if (first && !rejected) { stats.skipped++; reason("missing_header"); }
    } finally { await handle.close(); }
  };
  const visit = async (path: string, depth: number): Promise<void> => {
    if (stopped() || seen.size >= MAX_EVENTS || stats.reasons.includes("max_bytes") || stats.reasons.includes("max_files")) return;
    let info: Awaited<ReturnType<typeof lstat>>;
    try { info = await lstat(path); }
    catch (error) { stats.skipped++; reason((error as NodeJS.ErrnoException).code === "ENOENT" ? "missing_root" : "unreadable_directory"); return; }
    if (info.isSymbolicLink()) { stats.skipped++; reason("symlink"); return; }
    if (info.isFile()) { if (path.endsWith(".jsonl")) await readFile(path); else { stats.skipped++; reason("unsupported_file"); } return; }
    if (!info.isDirectory()) { stats.skipped++; reason("unsupported_file"); return; }
    let entries: Awaited<ReturnType<typeof opendir>>;
    try { entries = await opendir(path); }
    catch { stats.skipped++; reason("unreadable_directory"); return; }
    for await (const entry of entries) {
      if (stopped() || seen.size >= MAX_EVENTS || stats.reasons.includes("max_bytes") || stats.reasons.includes("max_files")) break;
      if (entry.isDirectory() && depth >= 3) { stats.skipped++; reason("max_depth"); continue; }
      await visit(join(path, entry.name), depth + 1);
    }
  };
  const root = resolve(options.root);
  // Refuse symlink ancestors as well as direct directory/file entries.
  for (let ancestor = dirname(root); ; ancestor = dirname(ancestor)) {
    try { if ((await lstat(ancestor)).isSymbolicLink()) { stats.skipped++; reason("symlink"); return stats; } }
    catch { /* visit reports missing/unreadable roots */ }
    if (ancestor === dirname(ancestor)) break;
  }
  if (!stopped()) await visit(root, 0);
  if (seen.size >= MAX_EVENTS) reason("event_limit");
  return stats;
}
