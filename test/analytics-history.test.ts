import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importHistory } from "../pi-toolkit-lib/analytics/history.js";
import { digest, skillEvent, toolEvent } from "../pi-toolkit-lib/analytics/normalize.js";
import type { AnalyticsEvent } from "../pi-toolkit-lib/analytics/types.js";

const timestamp = 1_700_000_000_000;
const iso = new Date(timestamp).toISOString();
const header = { type: "session", version: 3, id: "session-one", cwd: "/private/project-secret", timestamp: iso };
const entry = (id: string, message: object) => ({ type: "message", id, timestamp: iso, message });
const assistant = (id = "call-one", name = "bash", args: unknown = { command: "secret-command" }) => entry(`assistant-${id}`, {
  role: "assistant", provider: "openai", model: "test-model", stopReason: "toolUse", content: [{ type: "toolCall", id, name, arguments: args }], timestamp,
});
const result = (id = "call-one", toolName = "bash", extra = {}) => entry(`result-${id}`, { role: "toolResult", toolCallId: id, toolName, isError: false, content: [{ type: "text", text: "secret-output" }], timestamp, ...extra });
let root: string;
beforeEach(async () => { root = await mkdtemp(join(await realpath(tmpdir()), "analytics-history-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function fixture(name: string, entries: unknown[]) {
  const path = join(root, name);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${entries.map(value => typeof value === "string" ? value : JSON.stringify(value)).join("\n")}\n`);
  return path;
}
async function scan(options: Partial<Parameters<typeof importHistory>[0]> = {}) {
  const events: AnalyticsEvent[] = [];
  const stats = await importHistory({ root, onEvent: event => { events.push(event); }, ...options });
  return { stats, events };
}

describe("read-only analytics history", () => {
  it("imports original top and nested calls, classifies errors, and uses live-compatible IDs", async () => {
    const nested = { id: "nested", name: "read", timestamp: 999, durationMs: 12, status: "error", error: "ENOENT secret-error" };
    await fixture("project/session.jsonl", [header, assistant(), result("call-one", "bash", { nestedCalls: { calls: [nested, nested], complete: true }, durationMs: 7 }),
      { type: "compaction", id: "compact", timestamp: iso, summary: "secret-summary", details: { readFiles: ["SKILL.md"] } }]);
    const { stats, events } = await scan();
    expect(stats).toMatchObject({ files: 1, events: 2, duplicates: 1, invalid: 0, partial: false });
    expect(events[0]!.id).toBe(toolEvent({ scope: { session: "live", project: "live", source: "live" }, callId: "call-one", tool: "bash", timestamp, isError: false }).id);
    expect(events[0]).toMatchObject({ inputHash: digest({ command: "secret-command" }), session: digest(header.id), project: digest(header.cwd), provider: "openai", model: "test-model", durationMs: 7, evidence: { entry: digest("result-call-one") } });
    expect(events[1]).toMatchObject({ parent: digest("call-one"), limited: true, timestamp, durationMs: 12, status: "error", failure: { category: "path_not_found" } });
    expect(JSON.stringify(events)).not.toMatch(/secret|ENOENT|command|summary/);
  });

  it("deduplicates fork/clone results across session headers, never reads current skills", async () => {
    const original = await fixture("a.jsonl", [header, assistant(), result()]);
    await fixture("project/fork.jsonl", [{ ...header, id: "fork" }, assistant(), result()]);
    const before = await readFile(original, "utf8");
    const { stats } = await scan();
    expect(stats.events).toBe(1);
    expect(stats.duplicates).toBe(1);
    expect(await readFile(original, "utf8")).toBe(before);
  });

  it("distinguishes actual skill loads, invocations and advertised availability", async () => {
    const expanded = '<skill name="actual" location="/nonexistent/current/SKILL.md">\nsecret-body\n</skill>';
    await fixture("skills.jsonl", [header,
      assistant("read-ok", "read", { path: "/nonexistent/readskill/SKILL.md", offset: 1, limit: 2 }), result("read-ok", "read"),
      assistant("read-error", "read", { path: "/nonexistent/badskill/SKILL.md" }), result("read-error", "read", { isError: true }),
      entry("available", { role: "system", sections: { skills: expanded }, timestamp }),
      entry("active", { role: "system", sections: { "pi-toolkit-active-skills": expanded }, timestamp }),
      entry("native", { role: "user", content: expanded, timestamp }),
      entry("invoke", { role: "user", content: "/skill:actual hello secret-prompt", timestamp }),
      entry("prose", { role: "user", content: "Please discuss actual skills and $not-loaded", timestamp }),
      { type: "custom", id: "dollar1", timestamp: iso, customType: "pi-toolkit:skill-loader", data: { loaded: ["dollar"] } },
      { type: "custom", id: "dollar2", timestamp: iso, customType: "pi-toolkit:skill-loader", data: { loaded: ["dollar", "second"] } },
    ]);
    const { events } = await scan();
    const skills = events.filter(event => event.kind === "skill");
    expect(skills.map(event => [event.skill, event.skillState])).toEqual([["readskill", "loaded"], ["actual", "loaded"], ["actual", "invoked"], ["dollar", "invoked"], ["second", "invoked"]]);
    expect(skills[0]!.skillHash).toBeUndefined(); // A partial read cannot identify the original file version.
    expect(skills[1]!.skillHash).toBe(digest("secret-body")); // Actual expanded instructions, not current disk content.
    expect(skills.slice(2).every(event => event.skillHash === undefined)).toBe(true);
    expect(skills[1]!.id).toBe(skillEvent({ scope: { session: "live", project: "live", source: "live" }, timestamp, name: "actual", identity: `block:${timestamp}:actual`, state: "loaded" }).id);
    expect(skills[0]!.id).toBe(skillEvent({ scope: { session: "live", project: "live", source: "live" }, timestamp, name: "readskill", identity: `read:read-ok:${timestamp}`, state: "loaded" }).id);
    expect(JSON.stringify(events)).not.toMatch(/secret|nonexistent/);
  });

  it("ignores pending assistants and omits uncertain model provenance", async () => {
    const pending = assistant("pending");
    pending.message.stopReason = "pending";
    await fixture("pending.jsonl", [header, pending, result("pending"), assistant("known"), result("unknown"), result("known")]);
    const { events } = await scan();
    expect(events[0]!.inputHash).toBeUndefined();
    expect(events[0]!.provider).toBeUndefined();
    expect(events[1]!.model).toBeUndefined();
    expect(events[2]!.provider).toBe("openai");
  });

  it("uses entry ISO time only when message time is absent", async () => {
    await fixture("time.jsonl", [header, result("fallback", "read", { timestamp: undefined }), result("bad-time", "read", { timestamp: "bad" })]);
    const { stats, events } = await scan();
    expect(events).toHaveLength(1);
    expect(events[0]!.timestamp).toBe(timestamp);
    expect(stats.invalid).toBe(1);
  });

  it("reports malformed, legacy, missing-header and unsupported files explicitly", async () => {
    await fixture("malformed.jsonl", [header, "{bad", null, entry("bad", { role: "toolResult" }), assistant(), result()]);
    await fixture("legacy.jsonl", [{ ...header, version: 1 }, result()]);
    await fixture("missing.jsonl", [result()]);
    await fixture("empty.jsonl", []);
    await fixture("unrelated.txt", ["secret"]);
    const { stats, events } = await scan();
    expect(events).toHaveLength(1);
    expect(stats.invalid).toBe(3);
    expect(stats.partial).toBe(true);
    expect(stats.reasons).toEqual(expect.arrayContaining(["malformed_data", "unsupported_version", "missing_header", "unsupported_file"]));
    expect((await scan({ root: join(root, "absent") })).stats.reasons).toContain("missing_root");
  });

  it("enforces file, byte, per-file, timeout and cancellation limits", async () => {
    await fixture("one.jsonl", [header, assistant(), result()]);
    expect((await scan({ maxFiles: 0 })).stats.reasons).toContain("max_files");
    expect((await scan({ maxBytes: 10 })).stats).toMatchObject({ bytes: 10, partial: true, reasons: expect.arrayContaining(["max_bytes"]) });
    expect((await scan({ maxFileBytes: 10 })).stats.reasons).toContain("max_file_bytes");
    expect((await scan({ timeoutMs: 0 })).stats.reasons).toContain("timeout");
    const controller = new AbortController(); controller.abort();
    expect((await scan({ signal: controller.signal })).stats).toMatchObject({ events: 0, reasons: ["cancelled"] });
    const during = new AbortController();
    const stats = await importHistory({ root, signal: during.signal, onEvent: () => { during.abort(); } });
    expect(stats.reasons).toContain("cancelled");
  });

  it("bounds newline-free lines and recovers at the next record", async () => {
    await fixture("giant.jsonl", [header, "x".repeat(2 * 1024 * 1024), result()]);
    const { stats, events } = await scan();
    expect(stats.reasons).toContain("max_line_bytes");
    expect(stats.invalid).toBe(1);
    expect(events).toHaveLength(1);
  });

  it("refuses symlink files, directories, and roots and bounds traversal depth", async () => {
    const original = await fixture("original.jsonl", [header, result()]);
    await symlink(original, join(root, "link.jsonl"));
    await symlink(root, join(root, "loop"));
    await fixture("a/b/c/valid.jsonl", [{ ...header, version: 2 }, result("deep")]);
    await fixture("a/b/c/d/too-deep.jsonl", [header, result("too-deep")]);
    const { stats, events } = await scan();
    expect(events).toHaveLength(2);
    expect(stats.reasons).toEqual(expect.arrayContaining(["symlink", "max_depth"]));
    expect((await scan({ root: join(root, "loop") })).stats.reasons).toContain("symlink");
  });

  it("propagates sink failures instead of misreporting them as malformed input", async () => {
    await fixture("sink.jsonl", [header, result()]);
    await expect(importHistory({ root, onEvent: () => { throw new Error("sink failed"); } })).rejects.toThrow("sink failed");
  });
});
