import { mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AnalyticsCollector, scopeFor } from "../pi-toolkit-lib/analytics/collector.js";
import { digest, toolEvent } from "../pi-toolkit-lib/analytics/normalize.js";
import { buildReport, renderReport } from "../pi-toolkit-lib/analytics/report.js";
import { EventWriter, collectionEnabled, readStore, writePrivateJson } from "../pi-toolkit-lib/analytics/store.js";
import { importToStore } from "../pi-toolkit-lib/analytics/service.js";
import { importHistory } from "../pi-toolkit-lib/analytics/history.js";
import registerAnalytics from "../pi-toolkit-lib/analytics/register.js";
import type { AnalyticsEvent } from "../pi-toolkit-lib/analytics/types.js";

const directories: string[] = [];
async function temp() { const root = await realpath(await mkdtemp(join(tmpdir(), "ptk-analytics-"))); directories.push(root); return root; }
afterEach(async () => { for (const d of directories.splice(0)) await rm(d, { recursive: true, force: true }); });
const scope = scopeFor("session", "/private/project");
function event(call = "call", timestamp = 100, isError = false) {
  return toolEvent({ scope, callId: call, tool: "read", timestamp, input: { path: "/secret/config" }, isError, content: [{ type: "text", text: isError ? "ENOENT /secret/config token=secret" : "ok" }] });
}

describe("local analytics", () => {
  it("writes private files, strips unknown content, deduplicates and prefers rich live events", async () => {
    const root = await temp();
    const writer = new EventWriter(root);
    const e = event();
    writer.append({ ...e, secret: "never-store-me" } as AnalyticsEvent);
    writer.append({ ...e, source: "history", limited: true });
    await writer.close();
    const snapshot = await readStore(root);
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.events[0]).toMatchObject({ source: "live", limited: false });
    expect(snapshot.coverage.duplicates).toBe(1);
    const name = (await readdir(root)).find(n => n.endsWith(".jsonl"))!;
    const text = await readFile(join(root, name), "utf8");
    expect(text).not.toMatch(/never-store-me|secret\/config|token=secret/);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, name))).mode & 0o777).toBe(0o600);
  });

  it("has bounded nonthrowing queues and reports malformed/truncated storage", async () => {
    const root = await temp();
    const writer = new EventWriter(root);
    for (let i = 0; i < 2100; i++) writer.append(event(`c${i}`, i));
    await writer.close();
    expect(writer.dropped).toBe(52);
    expect(writer.written).toBe(2048);
    await writeFile(join(root, "events-deadbeef.jsonl"), "{broken\n{}");
    const snapshot = await readStore(root, { maxEvents: 3 });
    expect(snapshot.coverage.partial).toBe(true);
    expect(snapshot.events.length).toBeLessThanOrEqual(3);
  });

  it("handles multiple concurrent writers without losing events", async () => {
    const root = await temp();
    const a = new EventWriter(root), b = new EventWriter(root);
    for (let i = 0; i < 10; i++) {
      a.append(event(`a${i}`, i)); b.append(event(`b${i}`, i));
      await Promise.resolve();
    }
    await Promise.all([a.close(), b.close()]);
    expect((await readStore(root)).events).toHaveLength(20);
    expect(a.errors + b.errors).toBe(0);
  });

  it("refuses a symlink store and disables collection by default", async () => {
    const root = await temp();
    const target = await temp();
    const link = join(root, "linked");
    await symlink(target, link);
    const writer = new EventWriter(link);
    writer.append(event());
    await writer.close();
    expect(writer.errors).toBeGreaterThan(0);
    expect(await readdir(target)).toEqual([]);
    expect(await collectionEnabled(root)).toBe(false);
    await writePrivateJson(root, "config.json", { enabled: true });
    expect(await collectionEnabled(root)).toBe(true);
    expect((await readStore(link)).coverage.reasons).toContain("unsafe_store");
  });

  it("observes nested calls once and distinguishes skill read success from availability", () => {
    const events: AnalyticsEvent[] = [];
    const collector = new AnalyticsCollector(scope, e => events.push(e));
    const input = { path: "/private/skills/tdd/SKILL.md" };
    collector.message({ role: "assistant", timestamp: 1, provider: "test", model: "fixed", stopReason: "toolUse", content: [{ type: "toolCall", id: "outer", name: "codemode", arguments: { code: "secret" } }] });
    collector.start({ toolCallId: "outer/1", parentToolCallId: "outer", toolName: "read", args: input });
    collector.end({ toolCallId: "outer/1", parentToolCallId: "outer", toolName: "read", isError: false, durationMs: 3, result: { content: [{ type: "text", text: "private skill" }] } });
    collector.end({ toolCallId: "outer", toolName: "codemode", isError: false, durationMs: 4, result: {} });
    collector.message({ role: "toolResult", timestamp: 10, toolCallId: "outer", toolName: "codemode", isError: false, content: [], nestedCalls: { calls: [{ id: "outer/1", name: "read", status: "ok" }] } });
    collector.message({ role: "system", timestamp: 11, sections: { skills: '<skills><skill><name>never-loaded</name></skill></skills>' } });
    collector.stop();
    expect(events.filter(e => e.kind === "tool")).toHaveLength(2);
    expect(events.filter(e => e.kind === "skill")).toMatchObject([{ skill: "tdd", skillState: "loaded" }]);
    expect(events.find(e => e.tool === "codemode")?.durationMs).toBe(4);
    expect(events.find(e => e.parent)?.id).toBe(digest("nested", "outer/1", 10));
    expect(JSON.stringify(events)).not.toMatch(/private skill|private\/skills|code.*secret/);
  });

  it("reports only cautious temporal success signals and review-only proposals", () => {
    const events = [event("a", 1, true), event("b", 2, true), event("c", 3, true), event("d", 4),
      toolEvent({ scope, callId: "test", tool: "bash", timestamp: 5, isError: false, details: { exitCode: 1 }, content: [{ type: "text", text: "tests failed" }] })];
    const report = buildReport({ events, coverage: { files: 1, invalid: 0, duplicates: 0, partial: false, reasons: [] }, imports: [] });
    expect(report.totals).toMatchObject({ toolErrors: 3, commandFailures: 1, sameInputLaterSuccess: 1, exactRepeats: 3 });
    expect(report.proposals).toMatchObject([{ status: "proposed", category: "path_not_found", occurrences: 3 }]);
    expect(report.proposals[0]?.validation).toContain("Retain baseline");
    expect(renderReport(report)).toContain("not effectiveness scores");
    expect(JSON.stringify(report)).not.toMatch(/token=secret|\/secret\/config/);
  });

  it("imports idempotently without modifying source history", async () => {
    const root = await temp();
    const source = await temp();
    const text = [
      { type: "session", version: 3, id: "source-session", cwd: "/private/project" },
      { type: "message", id: "a", timestamp: "2026-01-01T00:00:00Z", message: { role: "assistant", timestamp: 1, content: [{ type: "toolCall", id: "c", name: "read", arguments: { path: "secret" } }] } },
      { type: "message", id: "b", timestamp: "2026-01-01T00:00:00Z", message: { role: "toolResult", toolCallId: "c", toolName: "read", timestamp: 2, content: [], isError: false } },
    ].map(v => JSON.stringify(v)).join("\n") + "\n";
    await writeFile(join(source, "session.jsonl"), text);
    expect((await importToStore(root, { root: source })).added).toBe(1);
    expect((await importToStore(root, { root: source })).alreadyStored).toBe(1);
    expect((await readStore(root)).events).toHaveLength(1);
    expect(await readFile(join(source, "session.jsonl"), "utf8")).toBe(text);
    const locations: unknown[] = [];
    await importHistory({ root: source, onEvent: (_event, location) => { locations.push(location); } });
    expect(locations).toEqual([{ file: join(source, "session.jsonl"), line: 3 }]);
  });

  it("deduplicates flattened grandchildren using root timestamps and keeps timing kinds separate", async () => {
    const source = await temp();
    const live: AnalyticsEvent[] = [];
    const collector = new AnalyticsCollector(scopeFor("nested-session", "/private/project"), e => live.push(e));
    collector.start({ toolCallId: "outer", toolName: "codemode", args: {} });
    collector.start({ toolCallId: "outer/1", parentToolCallId: "outer", toolName: "wrapper", args: {} });
    collector.start({ toolCallId: "outer/1/1", parentToolCallId: "outer/1", toolName: "read", args: { path: "missing" } });
    collector.end({ toolCallId: "outer/1/1", parentToolCallId: "outer/1", toolName: "read", isError: true, result: { content: [{ type: "text", text: "ENOENT" }] }, durationMs: 5 });
    collector.end({ toolCallId: "outer/1", parentToolCallId: "outer", toolName: "wrapper", isError: false, result: {}, durationMs: 6 });
    expect(live).toHaveLength(0); // Normalized descendants wait for stable root identity.
    const result = { role: "toolResult", toolCallId: "outer", toolName: "codemode", timestamp: 123, isError: false, content: [], nestedCalls: { complete: true, calls: [
      { id: "outer/1", name: "wrapper", status: "ok", durationMs: 60 },
      { id: "outer/1/1", name: "read", status: "error", error: "ENOENT", durationMs: 50 },
    ] } };
    collector.message(result);
    const history: AnalyticsEvent[] = [];
    await writeFile(join(source, "session.jsonl"), [
      { type: "session", version: 3, id: "nested-session", cwd: "/private/project" },
      { type: "message", id: "r", timestamp: "2026-01-01T00:00:00Z", message: result },
    ].map(e => JSON.stringify(e)).join("\n") + "\n");
    await importHistory({ root: source, onEvent: e => { history.push(e); } });
    expect(history.map(e => e.id).sort()).toEqual(live.map(e => e.id).sort());
    expect(history.find(e => e.tool === "read")?.parent).toBe(digest("outer/1"));
    expect(history.find(e => e.tool === "read")?.durationKind).toBe("nested_elapsed");
    const report = buildReport({ events: history, coverage: { files: 1, invalid: 0, duplicates: 0, partial: false, reasons: [] }, imports: [] });
    expect(report.byTool.find(t => t.tool === "read")).toMatchObject({ timed: 0, nestedTimed: 1, nestedElapsedMs: 50 });
  });

  it("shares exact skill parsing across history/live and rejects embedded examples", async () => {
    const source = await temp();
    const messages = [
      { role: "user", timestamp: 1, content: "/skill:foo_bar" },
      { role: "user", timestamp: 2, content: 'Example:\n\n<skill name="quoted" location="/example">\nnot a load\n</skill>' },
      { role: "user", timestamp: 3, content: '<skill name="foo_bar" location="/example">\nactual body\n</skill>\n\nrequest' },
    ];
    const live: AnalyticsEvent[] = [], history: AnalyticsEvent[] = [];
    const collector = new AnalyticsCollector(scope, e => live.push(e));
    for (const message of messages) collector.message(message);
    await writeFile(join(source, "session.jsonl"), [
      { type: "session", version: 3, id: "session", cwd: "/private/project" },
      ...messages.map((message, i) => ({ type: "message", id: `m${i}`, timestamp: "2026-01-01T00:00:00Z", message })),
    ].map(e => JSON.stringify(e)).join("\n") + "\n");
    await importHistory({ root: source, onEvent: e => { history.push(e); } });
    expect(live.map(e => e.id)).toEqual(history.map(e => e.id));
    expect(live.map(e => e.skill)).toEqual(["foo_bar", "foo_bar"]);
    expect(live[1]?.skillHash).toBe(history[1]?.skillHash);
  });

  it("rejects raw import metadata and marks malformed coverage without breaking rendering", async () => {
    const root = await temp();
    await writeFile(join(root, "import-deadbeef.json"), JSON.stringify({ files: 1, bytes: 1, events: 1, invalid: 0, skipped: 0, duplicates: 0, partial: false, reasons: [], raw: "secret" }));
    await writeFile(join(root, "import-bad.json"), "null");
    const snapshot = await readStore(root);
    const report = buildReport(snapshot);
    expect(snapshot.coverage.partial).toBe(true);
    expect(renderReport(report)).not.toContain('"raw"');
    expect(JSON.stringify(report)).not.toContain("secret");
  });

  it.skipIf(process.platform === "win32")("does not block on FIFOs in config or recognized store names", async () => {
    const root = await temp();
    execFileSync("mkfifo", [join(root, "config.json")]);
    execFileSync("mkfifo", [join(root, "events-deadbeef.jsonl")]);
    expect(await collectionEnabled(root)).toBe(false);
    expect((await readStore(root)).coverage.reasons).toContain("unsafe_file");
  });

  it("refuses symlink ancestors before creating/writing a store", async () => {
    const root = await temp(), target = await temp();
    await symlink(target, join(root, "redirect"));
    const writer = new EventWriter(join(root, "redirect", "analytics"));
    writer.append(event()); await writer.close();
    expect(writer.errors).toBeGreaterThan(0);
    expect(await readdir(target)).toEqual([]);
    expect((await readStore(join(root, "redirect", "analytics"))).coverage.partial).toBe(true);
  });

  it("registers passive hooks, defaults off, and enable/disable commands work without model calls", async () => {
    const root = await temp();
    const handlers = new Map<string, (e: any, ctx: any) => any>();
    const commands = new Map<string, any>();
    const pi = { on: (name: string, handler: any) => handlers.set(name, handler), registerCommand: (name: string, command: any) => commands.set(name, command) } as unknown as ExtensionAPI;
    const notices: string[] = [];
    const ctx = { cwd: "/private/project", sessionManager: { getSessionId: () => "session" }, ui: { notify: (text: string) => notices.push(text) } } as unknown as ExtensionContext;
    registerAnalytics(pi, { root });
    await handlers.get("session_start")!({}, ctx);
    expect(await readdir(root)).toEqual([]);
    const command = commands.get("ptk-analytics");
    await command.handler("enable", ctx);
    await handlers.get("tool_execution_start")!({ toolCallId: "c", toolName: "read", args: { path: "/secret/path" } }, ctx);
    await handlers.get("tool_execution_end")!({ toolCallId: "c", toolName: "read", isError: true, result: {} }, ctx);
    await handlers.get("message_end")!({ message: { role: "toolResult", toolCallId: "c", toolName: "read", timestamp: 42, isError: true, content: [{ type: "text", text: "ENOENT /secret/path" }] } }, ctx);
    await handlers.get("agent_settled")!({}, ctx);
    await command.handler("report", ctx);
    expect((await readStore(root)).events).toHaveLength(1);
    expect(await readFile(join(root, "latest-report.md"), "utf8")).toContain("path_not_found");
    await command.handler("disable", ctx);
    await handlers.get("session_shutdown")!({}, ctx);
    expect(await collectionEnabled(root)).toBe(false);
    expect(notices.some(n => n.includes("Local analytics enabled"))).toBe(true);
    expect(handlers.has("tool_call")).toBe(false); // No gating hook; cannot block tool execution.
  });
});
