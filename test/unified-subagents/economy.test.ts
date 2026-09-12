import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boundBulkResult, bulkReaderConfig, ECONOMY_RESULT_BYTES, registerEconomy, requestedReadExceeds } from "../../pi-toolkit-lib/unified-subagents/economy.js";
import { runInChildSessionContext } from "../../pi-toolkit-lib/unified-subagents/child-context.js";
import { buildAgentRegistry } from "../../pi-toolkit-lib/unified-subagents/agent-types.js";
import { resolveAgentInvocationConfig } from "../../pi-toolkit-lib/unified-subagents/invocation-config.js";

const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "economy-test-")); dirs.push(dir);
  const file = join(dir, "large.txt");
  writeFileSync(file, "tiny\n" + "a".repeat(17000) + "\ntail\n");
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  const pi = { on: (n: string, h: any) => handlers.set(n, h), registerCommand: (n: string, h: any) => commands.set(n, h) } as any;
  const ctx = { cwd: dir, model: { cost: { input: 2 } }, ui: { notify: vi.fn() } } as any;
  return { dir, file, handlers, commands, pi, ctx };
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("economy", () => {
  it("counts requested UTF-8 bytes, including offset-only remainder", async () => {
    const { file } = fixture();
    expect(await requestedReadExceeds(file)).toBe(true);
    expect(await requestedReadExceeds(file, 1, 1)).toBe(false);
    expect(await requestedReadExceeds(file, 2)).toBe(true);
    expect(await requestedReadExceeds(file, 3)).toBe(false);
    writeFileSync(file, "é".repeat(9000));
    expect(await requestedReadExceeds(file, 1, 1)).toBe(true);
    writeFileSync(file, Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(20000)]));
    expect(await requestedReadExceeds(file)).toBe(false);
  });
  it("is off by default; allow is one-shot; off clears permits; errors stay native", async () => {
    const f = fixture();
    const account = registerEconomy(f.pi);
    account({ input: 7, output: 3, cacheWrite: 0, cacheRead: 11 });
    const read = (path = f.file, extra = {}) => f.handlers.get("tool_call")({ toolName: "read", input: { path, ...extra } }, f.ctx);
    const command = (s: string) => f.commands.get("economy").handler(s, f.ctx);
    expect(await read()).toBeUndefined();
    await command("on");
    expect((await read()).block).toBe(true);
    expect(f.ctx.ui.notify.mock.lastCall[0]).toMatch(/Economy kept ~[\d,]+ parent-input tokens.*list-price/);
    expect(await read(f.file, { limit: 1 })).toBeUndefined();
    expect((await read(f.file, { offset: 2 })).block).toBe(true);
    await command("allow large.txt");
    expect(await read()).toBeUndefined();
    expect((await read()).block).toBe(true);
    expect(await read("missing")).toBeUndefined();
    await command("allow large.txt"); await command("off");
    expect(await read()).toBeUndefined();
    await command("on"); expect((await read()).block).toBe(true);
    await command("stats"); expect(f.ctx.ui.notify.mock.lastCall[0]).toContain("permits used 1");
    expect(f.ctx.ui.notify.mock.lastCall[0]).toContain('"input":7');
    expect(f.ctx.ui.notify.mock.lastCall[0]).toContain('"cacheRead":11');
    expect(f.ctx.ui.notify.mock.lastCall[0]).toMatch(/estimated parent input avoided ~[\d,]+ tokens \/ ~\$0\.\d+ list-price/);
    expect(f.ctx.ui.notify.mock.lastCall[0]).toContain("before bulk-reader spend and future cache effects");
  });
  it("does not register hooks/commands inside runner-scoped child loading", async () => {
    const f = fixture();
    await runInChildSessionContext(async () => { registerEconomy(f.pi); });
    expect(f.handlers.size).toBe(0); expect(f.commands.size).toBe(0);
    registerEconomy(f.pi); expect(f.commands.has("economy")).toBe(true);
  });
  it("reserves read-only policy and ignores conflicting caller hints", () => {
    const registry = buildAgentRegistry(new Map([["bulk-reader", { ...bulkReaderConfig, builtinToolNames: ["write"] }]]));
    expect(registry.get("bulk-reader")).toBe(bulkReaderConfig);
    expect(bulkReaderConfig.builtinToolNames).toEqual(["read", "grep", "find", "ls"]);
    const plan = resolveAgentInvocationConfig(bulkReaderConfig, { harness: "claude", thinking: "high", inherit_context: true, isolated: false, isolation: "worktree" });
    expect(plan).toMatchObject({ harness: "pi", thinking: "low", inheritContext: false, isolated: true, isolation: undefined });
    expect(bulkReaderConfig.allowedSubagents).toBeUndefined();
  });
  it("bounds UTF-8 output including failure headlines and preserves overflow exactly", () => {
    const original = "Agent failed: provider error\n" + "😀".repeat(9000);
    const result = boundBulkResult(original);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(ECONOMY_RESULT_BYTES);
    expect(result).toContain("Agent failed: provider error");
    const path = result.match(/Complete output: (.*)\. Use ranged read/)![1];
    expect(readFileSync(path, "utf8")).toBe(original);
    rmSync(join(path, ".."), { recursive: true, force: true });
  });
});
