import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createReadToolDefinition, truncateHead } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boundBulkResult, bulkReaderConfig, ECONOMY_READ_BYTES, ECONOMY_RESULT_BYTES, ECONOMY_SYSTEM_GUIDANCE, registerEconomy } from "../../pi-toolkit-lib/unified-subagents/economy.js";
import { runInChildSessionContext } from "../../pi-toolkit-lib/unified-subagents/child-context.js";
import { buildAgentRegistry } from "../../pi-toolkit-lib/unified-subagents/agent-types.js";

const dirs: string[] = [];
const textOf = (result: any): string => result.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "economy-test-")); dirs.push(dir);
  const file = join(dir, "large.txt");
  writeFileSync(file, Array.from({ length: 3000 }, (_, i) => `line ${i + 1}: ${"é".repeat(40)}`).join("\n"));
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  const pi = { on: (n: string, h: any) => handlers.set(n, h), registerCommand: (n: string, h: any) => commands.set(n, h) } as any;
  const ctx = { cwd: dir, ui: { notify: vi.fn() } } as any;
  const accountUsage = registerEconomy(pi);
  const native = createReadToolDefinition(dir);
  const hook = (event: any) => handlers.get("tool_result")(event, ctx);
  const call = async (args: any = {}) => {
    const input = { path: file, ...args };
    const nativeResult: any = await native.execute("read", input, undefined, undefined, ctx);
    nativeResult.structuredContent = textOf(nativeResult); // Host 1.0.4 canonical output.
    const event = { toolName: "read", toolCallId: "read", input, ...nativeResult, isError: false };
    const replacement = hook(event);
    return { result: { ...nativeResult, ...replacement }, nativeResult, input, replacement };
  };
  const command = (args: string) => commands.get("economy").handler(args, ctx);
  return { dir, file, handlers, commands, ctx, accountUsage, native, call, command, hook };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function expectPrefix(result: any, source: string, start = 1) {
  const text = textOf(result);
  const prefix = text.split("\n\n[Showing lines")[0];
  const count = prefix.split("\n").length;
  expect(Buffer.byteLength(prefix)).toBeLessThanOrEqual(ECONOMY_READ_BYTES);
  expect(prefix).toBe(source.split("\n").slice(start - 1, start - 1 + count).join("\n"));
  expect(text).toContain(`[Showing lines ${start}-${start + count - 1} (16.0KB economy limit). Use offset=${start + count} to continue.]`);
  expect(result.content).toHaveLength(1);
  expect(result.structuredContent).toBe(text);
  expect(result.details.truncation).toMatchObject({ maxBytes: ECONOMY_READ_BYTES, maxLines: 2000, outputLines: count, outputBytes: Buffer.byteLength(prefix), firstLineExceedsLimit: false });
  return count;
}

describe("minimal economy result adapter", () => {
  it("registers only result, prompt and session hooks, never mutating read input", async () => {
    const f = fixture();
    expect([...f.handlers.keys()].sort()).toEqual(["before_agent_start", "session_before_switch", "tool_result"]);
    const { result, input, nativeResult } = await f.call({ limit: 600 });
    expect(input).toEqual({ path: f.file, limit: 600 });
    expectPrefix(result, readFileSync(f.file, "utf8"));
    expect(result.details.truncation).toEqual(truncateHead(textOf(nativeResult).split("\n").slice(0, nativeResult.details.truncation.outputLines).join("\n"), { maxBytes: ECONOMY_READ_BYTES, maxLines: 2000 }));
  });
  it("does not count native footer lines as source content or skip the next source line", async () => {
    const f = fixture();
    const lines = Array.from({ length: 160 }, () => "x".repeat(101));
    lines[159] += "x".repeat(44);
    const content = lines.join("\n");
    expect(Buffer.byteLength(content)).toBe(16363);
    writeFileSync(f.file, content + "\nNEXT_SOURCE_LINE");
    const read = await f.call({ limit: 160 });
    expect(Buffer.byteLength(textOf(read.nativeResult))).toBeGreaterThan(ECONOMY_READ_BYTES);
    expect(read.replacement).toBeUndefined();
    expect(read.result).toEqual(read.nativeResult);
    expect(textOf(read.result)).toContain("offset=161");
    expect(textOf((await f.call({ offset: 161 })).result)).toBe("NEXT_SOURCE_LINE");
  });
  it("caps CONTENT at 16KiB, allowing native-style notice overhead", async () => {
    const f = fixture();
    writeFileSync(f.file, "x".repeat(ECONOMY_READ_BYTES) + "\ntail");
    const { result } = await f.call();
    expectPrefix(result, readFileSync(f.file, "utf8"));
    expect(Buffer.byteLength(textOf(result))).toBeGreaterThan(ECONOMY_READ_BYTES);
    expect(result.details.truncation.outputBytes).toBe(ECONOMY_READ_BYTES);
  });
  it("uses event offsets for exact complete continuations without rewriting limits", async () => {
    const f = fixture();
    const source = readFileSync(f.file, "utf8");
    const first = await f.call({ offset: 20, limit: 500 });
    const count = expectPrefix(first.result, source, 20);
    expect(first.input.limit).toBe(500);
    const next = await f.call({ offset: 20 + count, limit: 500 });
    expectPrefix(next.result, source, 20 + count);
    expect(textOf(first.result)).not.toContain("50.0KB");
    expect(textOf(first.result).match(/\[Showing lines/g)).toHaveLength(1);
  });
  it("returns successful warnings for 16-50KiB first lines, never partial lines", async () => {
    const f = fixture();
    writeFileSync(f.file, "tiny\n" + "é".repeat(10000) + "\ntail");
    const { result } = await f.call({ offset: 2, limit: 1 });
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toContain("Line 2");
    expect(textOf(result)).toContain("exceeds 16.0KB limit");
    expect(textOf(result)).toContain("Use bash: sed -n '2p'");
    expect(textOf(result)).toContain("head -c 16384");
    expect(textOf(result)).not.toContain("é");
    expect(textOf(result)).not.toContain("skip");
    expect(result.structuredContent).toBe(textOf(result));
    expect(result.details.truncation).toMatchObject({ firstLineExceedsLimit: true, outputLines: 0, outputBytes: 0 });
  });
  it("keeps a complete small prefix before a large second line and drops stale footers", async () => {
    const f = fixture();
    writeFileSync(f.file, "tiny\n" + "é".repeat(10000));
    expectPrefix((await f.call()).result, readFileSync(f.file, "utf8"));
    writeFileSync(f.file, "x".repeat(ECONOMY_READ_BYTES) + "\ntail");
    const { result, nativeResult } = await f.call({ limit: 1 });
    expect(textOf(nativeResult)).toContain("more lines in file");
    expect(result).toEqual(nativeResult); // Source fits exactly; native footer is allowed overhead.
    expect(textOf(result)).toContain("more lines in file");
    expect(textOf(result)).toContain("offset=2");
  });
  it.each([0, -2, 0.5, 1.5])("matches native offset normalization for %s", async (offset) => {
    const f = fixture();
    const start = offset ? Math.max(0, offset - 1) + 1 : 1;
    expectPrefix((await f.call({ offset })).result, readFileSync(f.file, "utf8"), start);
  });
  it("leaves the native >50KiB first-line warning unchanged", async () => {
    const f = fixture(); writeFileSync(f.file, "x".repeat(60000));
    const { result, nativeResult, replacement } = await f.call();
    expect(replacement).toBeUndefined();
    expect(result).toEqual(nativeResult);
    expect(textOf(result)).toContain("50.0KB");
  });
  it("leaves small native text, exact-cap EOF, footers, and off results unchanged", async () => {
    const f = fixture();
    expect((await f.call({ offset: 4, limit: 2 })).replacement).toBeUndefined();
    writeFileSync(f.file, "é".repeat(8192));
    expect((await f.call()).replacement).toBeUndefined();
    await f.command("off");
    writeFileSync(f.file, ("z".repeat(100) + "\n").repeat(3000));
    const off = await f.call(); expect(off.replacement).toBeUndefined(); expect(off.result).toEqual(off.nativeResult);
    await f.command("on"); expect((await f.call()).replacement).toBeDefined();
  });
  it("preserves native errors, non-read results, images and their attachments", async () => {
    const f = fixture();
    for (const args of [{ path: join(f.dir, "missing") }, { path: f.file, offset: 99999 }]) {
      const error = await f.native.execute("error", args, undefined, undefined, f.ctx).catch(e => e);
      expect(error).toBeInstanceOf(Error);
      expect(f.hook({ toolName: "read", input: args, content: [{ type: "text", text: error.message }], isError: true })).toBeUndefined();
    }
    const abort = new AbortController(); abort.abort();
    await expect(f.native.execute("abort", { path: f.file }, abort.signal, undefined, f.ctx)).rejects.toThrow("Operation aborted");
    const content = [{ type: "text", text: "x".repeat(60000) }, { type: "image", data: "abc", mimeType: "image/png" }];
    const event = { toolName: "read", input: {}, content, structuredContent: "x".repeat(60000), isError: false };
    expect(f.hook({ ...event, content: [content[0]], isError: true })).toBeUndefined();
    expect(f.hook(event)).toBeUndefined(); expect(event.content).toBe(content);
    expect(f.hook({ ...event, toolName: "bash" })).toBeUndefined();
    writeFileSync(f.file, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"));
    expect((await f.call()).replacement).toBeUndefined();
  });
  it("bounds canonical oversized string structured output and preserves other details", () => {
    const f = fixture();
    const source = "long line\n".repeat(6000);
    const result = f.hook({ toolName: "read", input: {}, content: [{ type: "text", text: "short" }], structuredContent: source, details: { extra: "kept" }, isError: false });
    expectPrefix(result, source);
    expect(result.details.extra).toBe("kept");
  });
  it("keeps prompt guidance byte-for-byte identical across on/off toggles", async () => {
    const f = fixture(); const before = f.handlers.get("before_agent_start");
    const added = before({ systemPrompt: "Base" });
    expect(added.systemPrompt).toBe(`Base\n\n${ECONOMY_SYSTEM_GUIDANCE}`);
    expect(before({ systemPrompt: added.systemPrompt })).toBeUndefined();
    for (const phrase of ["narrow", "multiple files", 'subagent_type="bulk-reader"', "explicit paths and a precise question", "relevant source chunks", "complete exact file", "not an exact read", "[Showing lines"]) expect(ECONOMY_SYSTEM_GUIDANCE).toContain(phrase);
    expect(ECONOMY_SYSTEM_GUIDANCE).not.toMatch(/economy allow|TOOL METADATA|response budget/);
    expect(ECONOMY_SYSTEM_GUIDANCE).toContain("when economy is enabled");
    expect(ECONOMY_SYSTEM_GUIDANCE).toContain("when disabled, native limits apply");
    await f.command("off"); expect(before({ systemPrompt: "Base" })).toEqual(added);
    expect(before({ systemPrompt: added.systemPrompt })).toBeUndefined();
    await f.command("on"); expect(before({ systemPrompt: "Base" })).toEqual(added);
    f.handlers.get("session_before_switch")(); expect(before({ systemPrompt: "Base" })).toEqual(added);
  });
  it("reports reads shortened, bytes withheld and approximate tokens without claiming net savings", async () => {
    const f = fixture();
    const first = await f.call();
    const removed = Buffer.byteLength(textOf(first.nativeResult)) - Buffer.byteLength(textOf(first.result));
    const before = f.handlers.get("before_agent_start")({ systemPrompt: "Base" }).systemPrompt;
    expect(removed).toBeGreaterThan(0);
    await f.command("stats");
    let stats = f.ctx.ui.notify.mock.lastCall![0];
    expect(stats).toContain("Reads shortened: 1");
    expect(stats).toContain(`Bytes withheld: ${removed.toLocaleString()}`);
    expect(stats).toContain(`Estimated input tokens avoided: ~${Math.ceil(removed / 4).toLocaleString()}`);
    expect(stats).toContain("not net or billing savings");
    await f.call({ limit: 1 }); // Unmodified results don't count.
    await f.command("off");
    await f.call(); // Native reads while off don't count either.
    await f.command("stats");
    stats = f.ctx.ui.notify.mock.lastCall![0];
    expect(stats).toContain("Reads shortened: 1");
    expect(stats).toContain(`Bytes withheld: ${removed.toLocaleString()}`);
    expect(f.handlers.get("before_agent_start")({ systemPrompt: "Base" }).systemPrompt).toBe(before);
    await f.command("on");
    const second = await f.call();
    const total = removed + Buffer.byteLength(textOf(second.nativeResult)) - Buffer.byteLength(textOf(second.result));
    await f.command("stats");
    expect(f.ctx.ui.notify.mock.lastCall![0]).toContain("Reads shortened: 2");
    expect(f.ctx.ui.notify.mock.lastCall![0]).toContain(`Bytes withheld: ${total.toLocaleString()}`);
    f.handlers.get("session_before_switch")();
    await f.command("stats");
    expect(f.ctx.ui.notify.mock.lastCall![0]).toContain("Reads shortened: 2");
    expect(f.handlers.get("before_agent_start")({ systemPrompt: "Base" }).systemPrompt).toBe(before);
  });
  it("reports toggle state and callable bulk usage accounting", async () => {
    const f = fixture(); expect(typeof f.accountUsage).toBe("function");
    await f.command("off"); f.accountUsage({ input: 7, output: 3, cacheWrite: 0, cacheRead: 11 });
    await f.command("stats");
    const stats = f.ctx.ui.notify.mock.lastCall![0];
    expect(stats).toContain("Economy off"); expect(stats).toContain('"input":7'); expect(stats).toContain('"cacheRead":11');
    expect(stats).toContain("Reads shortened: 0");
    expect(stats).toContain("Estimated input tokens avoided: ~0");
    expect(stats).not.toMatch(/bounded reads|pending|permits|UPPER BOUND/);
    await f.command("allow large.txt"); expect(f.ctx.ui.notify.mock.lastCall![0]).toBe("Usage: /economy on|off|stats");
    expect(f.commands.get("economy").description).not.toContain("allow");
  });
  it("registers no parent hooks in children and keeps the bulk profile available off", async () => {
    const on = vi.fn(); const registerCommand = vi.fn();
    await runInChildSessionContext(async () => {
      const account = registerEconomy({ on, registerCommand } as any);
      expect(typeof account).toBe("function"); account({ input: 1, output: 0, cacheWrite: 0 });
    });
    expect(on).not.toHaveBeenCalled(); expect(registerCommand).not.toHaveBeenCalled();
    const before = structuredClone(bulkReaderConfig); const f = fixture(); await f.command("off");
    expect(buildAgentRegistry(new Map()).get("bulk-reader")).toBe(bulkReaderConfig);
    await f.command("on");
    expect(buildAgentRegistry(new Map()).get("bulk-reader")).toBe(bulkReaderConfig);
    expect(bulkReaderConfig).toEqual(before);
    expect(bulkReaderConfig.builtinToolNames).toEqual(["read", "grep", "find", "ls"]);
    expect(bulkReaderConfig).toMatchObject({ extensions: false, skills: false, isolated: true, inheritContext: false, thinking: "low" });
  });
  it("retains the bulk result cap and exact overflow artifact independent of toggle", async () => {
    const f = fixture(); await f.command("off");
    const original = "Agent failed: provider error\n" + "😀".repeat(9000);
    const result = boundBulkResult(original);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(ECONOMY_RESULT_BYTES);
    expect(result).not.toContain("/economy allow");
    const path = result.match(/Complete output: (.*)\. Use ranged read/)![1];
    expect(readFileSync(path, "utf8")).toBe(original);
    rmSync(join(path, ".."), { recursive: true, force: true });
  });
});
