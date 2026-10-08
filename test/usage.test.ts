import { describe, expect, it, vi } from "vitest";
import { AgentSession, SessionManager, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import usage, { renderUsage } from "../pi-toolkit-lib/usage.ts";
import { historyAccumulator } from "../pi-toolkit-lib/usage-history.ts";
import { estimatedCost, summarizeUsage, usageSnapshot } from "../pi-toolkit-lib/usage-snapshot.ts";
import { PendingUsagePool } from "../pi-toolkit-lib/unified-subagents/usage.ts";

const theme = { fg: (_: string, s: string) => s, bold: (s: string) => s };
const u = { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, reasoning: 5, totalTokens: 100, cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 } };
const assistant = () => ({ role: "assistant", content: [], provider: "test", model: "model", api: "openai-responses", stopReason: "stop", timestamp: 1, usage: structuredClone(u) } as const);
function context(sm = SessionManager.inMemory()) {
  return { sessionManager: sm, model: { provider: "test", id: "model", reasoning: true }, thinkingLevel: "high", getContextUsage: () => ({ tokens: 50, percent: 5, contextWindow: 1000 }) } as unknown as ExtensionContext;
}

describe("current session usage", () => {
  it("agrees with Pi session stats including nested tools, all branches and compaction; never counts retained copies or legacy records", () => {
    const sm = SessionManager.inMemory();
    const first = sm.appendMessage(assistant());
    const pool = new PendingUsagePool();
    pool.add({ input: 3, output: 4, cacheRead: 5, cacheWrite: 6, cost: 0.25 });
    const nested = pool.drain();
    sm.appendMessage({ role: "toolResult", toolCallId: "agent", toolName: "Agent", content: [], isError: false, timestamp: 2, usage: nested, details: { usage: nested, messages: [assistant()] } });
    sm.appendMessage({ role: "toolResult", toolCallId: "result", toolName: "get_subagent_result", content: [], isError: false, timestamp: 3, usage: pool.drain() });
    sm.appendMessage(assistant());
    sm.appendCompaction("summary", first, 100, { retainedTail: [assistant()] }, false, u);
    sm.branchWithSummary(first, "branch", {}, false, u);
    sm.appendCustomEntry("obs-turn", { inputTokens: 999999, cost: 999999 });
    sm.appendCustomEntry("subagents:record", { usage: nested });
    const totals = summarizeUsage(sm.getEntries());
    // Invoke the real SDK stats implementation as a ledger oracle, without an LLM/runtime.
    const native = AgentSession.prototype.getSessionStats.call({ sessionManager: sm, sessionId: sm.getSessionId(), getContextUsage: () => undefined } as unknown as AgentSession);
    expect(totals).toMatchObject({ ...native.tokens, cost: native.cost });
    expect(totals.total).toBe(418);
    expect(totals.cost).toBe(4.25);
    expect(totals.reasoning).toBe(20);
    expect(summarizeUsage(JSON.parse(JSON.stringify(sm.getEntries())))).toEqual(totals);
    expect(usageSnapshot(context(SessionManager.inMemory())).total).toBe(0);
  });

  it("counts compaction usage but not materialized retainedTail", () => {
    const entries = [{ type: "message", message: assistant() }, { type: "compaction", usage: u, retainedTail: [assistant()] }] as unknown as SessionEntry[];
    expect(summarizeUsage(entries).total).toBe(200);
  });

  it("distinguishes missing cost from a real zero, and reasoning remains part of output", () => {
    const entries = [{ type: "message", message: { ...assistant(), usage: { ...u, cost: undefined } } }] as unknown as SessionEntry[];
    const totals = summarizeUsage(entries);
    expect(totals).toMatchObject({ total: 100, output: 20, reasoning: 5, cost: 0, missingCosts: 1 });
    expect(estimatedCost(totals)).toBe("~$0.0000+?");
    expect(estimatedCost(summarizeUsage([]))).toBe("~$0.0000");
    expect(summarizeUsage([]).reasoning).toBeUndefined();
  });

  it("isolates child-session ledgers and does not read parent files", () => {
    const parent = SessionManager.inMemory();
    parent.appendMessage(assistant());
    const child = SessionManager.inMemory();
    child.newSession({ parentSession: "never-read-parent.jsonl" });
    expect(usageSnapshot(context(child)).total).toBe(0);
    child.appendMessage(assistant());
    expect(usageSnapshot(context(child)).total).toBe(100);
    expect(usageSnapshot(context(parent)).total).toBe(100);
  });

  it("renders the usage dashboard within Unicode-safe widths", () => {
    const { report } = historyAccumulator();
    Object.assign(report.windows[0], summarizeUsage([{ type: "message", message: assistant() }] as unknown as SessionEntry[]));
    for (const width of [0, 1, 2, 8, 20, 40, 80, 160]) {
      for (const line of renderUsage(report, 0, width, theme)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    const dashboard = renderUsage(report, 0, 160, theme).join("\n");
    expect(dashboard).toContain("Total tokens");
    expect(dashboard).toContain("Uncached");
    expect(dashboard).toContain("Estimated cost");
    expect(dashboard).not.toContain("LAST 10");
  });

  it("registers the dashboard without replacing Pi's footer", async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const commands = new Map<string, any>();
    const pi = { on: (name: string, fn: (...args: any[]) => unknown) => handlers.set(name, fn), registerCommand: (name: string, cmd: unknown) => commands.set(name, cmd) } as unknown as ExtensionAPI;
    usage(pi);
    expect([...commands.keys()]).toEqual(["ptk-usage"]);
    expect([...handlers.keys()]).toEqual(["session_shutdown"]);
    const ctx = { ...context(), mode: "rpc", ui: { setFooter: vi.fn(), notify: vi.fn(), custom: vi.fn() } };
    await commands.get("ptk-usage").handler("", ctx);
    expect(ctx.ui.setFooter).not.toHaveBeenCalled();
    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("/ptk-usage requires TUI mode.", "info");
    await handlers.get("session_shutdown")?.({}, ctx);
    expect(ctx.ui.setFooter).not.toHaveBeenCalled();
  });
});
