import { describe, expect, it, vi } from "vitest";
import { AgentSession, SessionManager, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import footer, { renderFooter } from "../pi-toolkit-lib/footer.ts";
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
    // Invoke the real public SDK stats implementation against this in-memory
    // ledger as an oracle, without starting an LLM/runtime or loading history.
    const native = AgentSession.prototype.getSessionStats.call({ sessionManager: sm, sessionId: sm.getSessionId(), getContextUsage: () => undefined } as unknown as AgentSession);
    expect(totals).toMatchObject({ ...native.tokens, cost: native.cost });
    expect(totals.total).toBe(418);
    expect(totals.cost).toBe(4.25);
    expect(totals.reasoning).toBe(20);
    // A resumed ledger has the same entries, without any in-process counters.
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

  it("renders one padded icon line with short gaps, optional branch, cost states, and Unicode-safe widths", () => {
    const snapshot = { ...usageSnapshot(context()), ...summarizeUsage([{ type: "message", message: assistant() }] as unknown as SessionEntry[]), model: "提供者/very-long-model-name", context: { tokens: undefined, percent: 36.8, contextWindow: 1000 } };
    const { report } = historyAccumulator();
    Object.assign(report.windows[0], summarizeUsage([{ type: "message", message: assistant() }] as unknown as SessionEntry[]));
    for (const width of [0, 1, 2, 8, 20, 40, 80, 160]) {
      const lines = renderFooter(snapshot, width, theme, { folder: "very-long-分支", branch: "功能/分支" });
      expect(lines).toHaveLength(1);
      for (const line of [...lines, ...renderUsage(report, 0, width, theme)]) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    expect(renderFooter(snapshot, 160, theme, { folder: "project", branch: "main" })[0]).toBe("  🤖 very-long-model-name:high  📁 project  ⎇ main  ◔ 36.8% [↑80 ↓20]  ⚡ 0.0t/s  $ 1.000  ");
    expect(renderFooter(snapshot, 160, theme, { folder: "project" })[0]).toBe("  🤖 very-long-model-name:high  📁 project  ◔ 36.8% [↑80 ↓20]  ⚡ 0.0t/s  $ 1.000  ");
    expect(renderFooter({ ...snapshot, missingCosts: 1 }, 160, theme, { folder: "project" })[0]).toContain("$ 1.000+?");
    const dashboard = renderUsage(report, 0, 160, theme).join("\n");
    expect(dashboard).toContain("Total tokens");
    expect(dashboard).toContain("Uncached");
    expect(dashboard).toContain("Estimated cost");
    expect(dashboard).not.toContain("LAST 10");
  });

  it("renders the exact approved preview and dims only the TPS suffix", () => {
    const snapshot = { ...usageSnapshot(context()), model: "test/gpt-6-astra", input: 2400, cacheRead: 9000, cacheWrite: 1000, output: 2100, cost: 0.127, context: { tokens: 368, percent: 36.8, contextWindow: 1000 } };
    const fg = vi.fn(theme.fg);
    expect(renderFooter(snapshot, 160, { ...theme, fg }, { folder: "rahul", branch: "main", tps: 87.4 })[0]).toBe("  🤖 gpt-6-astra:high  📁 rahul  ⎇ main  ◔ 36.8% [↑12.4k ↓2.1k]  ⚡ 87.4t/s  $ 0.127  ");
    expect(fg.mock.calls.filter(([color]) => color === "dim")).toEqual([["dim", "t/s"]]);
    expect(fg).toHaveBeenCalledWith("text", "⚡ 87.4");
    for (let width = 4; width < 160; width++) {
      const line = renderFooter(snapshot, width, theme)[0];
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      expect(line.startsWith("  ") && line.endsWith("  ")).toBe(true);
    }
  });

  it("uses final output tokens over observed generation time, freezes through tool waits, and resets lifecycle state", () => {
    const handlers = new Map<string, Function>();
    footer({ on: (name: string, fn: Function) => handlers.set(name, fn) } as unknown as ExtensionAPI);
    let component: any;
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const render = vi.fn();
    const ctx = { ...context(), cwd: "C:/project", mode: "tui", ui: { setFooter: (factory: Function) => { component = factory({ requestRender: render }, theme, { getGitBranch: () => null, onBranchChange: () => () => {} }); } } };
    const emit = (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
    const line = () => component.render(200)[0];
    const delta = (type = "text_delta", text = "one huge chunk is not a token count") => emit("message_update", { message: assistant(), assistantMessageEvent: { type, delta: text } });
    try {
      emit("session_start");
      emit("message_start", { message: assistant() });
      now = 10000; delta("text_delta", "");
      now = 20000; delta("thinking_delta");
      now = 20500; delta("toolcall_delta");
      expect(line()).toContain("⚡ 0.0t/s");
      now = 22000;
      emit("message_end", { message: { ...assistant(), usage: { ...u, output: 200 } } });
      expect(line()).toContain("⚡ 100.0t/s");
      emit("message_start", { message: assistant() });
      expect(line()).toContain("⚡ 100.0t/s");
      emit("message_end", { message: { ...assistant(), usage: { ...u, output: undefined } } });
      expect(line()).toContain("⚡ 100.0t/s");
      now = 90000;
      emit("message_start", { message: { role: "toolResult" } });
      emit("message_end", { message: { role: "toolResult", usage: { output: 999999 } } });
      emit("tool_execution_update", { partialResult: { usage: { output: 999999 } } });
      expect(line()).toContain("⚡ 100.0t/s");
      // A late duplicate completion cannot change the frozen sample.
      emit("message_end", { message: assistant() });
      expect(line()).toContain("⚡ 100.0t/s");
      emit("message_start", { message: assistant() });
      delta(); now += 1000;
      emit("message_end", { message: { ...assistant(), usage: { ...u, output: 0 } } });
      expect(line()).toContain("⚡ 0.0t/s");
      for (const lifecycle of ["model_select", "session_tree", "session_start"]) {
        emit(lifecycle);
        expect(line()).toContain("⚡ 0.0t/s");
        emit("message_start", { message: assistant() });
        delta(); now += 1000;
        emit("message_end", { message: assistant() });
        expect(line()).toContain("⚡ 20.0t/s");
      }
      expect(render).toHaveBeenCalled();
      emit("session_shutdown");
      render.mockClear();
      emit("model_select");
      expect(render).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it.each([undefined, -1, NaN, Infinity, 0, 20])("handles absent/invalid output usage %s and zero/no-sample intervals", (output) => {
    const handlers = new Map<string, Function>();
    footer({ on: (name: string, fn: Function) => handlers.set(name, fn) } as unknown as ExtensionAPI);
    let component: any;
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const ctx = { ...context(), cwd: "C:/project", mode: "tui", ui: { setFooter: (factory: Function) => { component = factory({ requestRender() {} }, theme, { getGitBranch: () => null, onBranchChange: () => () => {} }); } } };
    const emit = (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
    try {
      emit("session_start");
      for (const interval of [undefined, 0, 1000]) {
        emit("message_start", { message: assistant() });
        expect(component.render(200)[0]).toContain("⚡ 0.0t/s");
        if (interval !== undefined) emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "x" } });
        now += interval ?? 1000;
        emit("message_end", { message: { ...assistant(), stopReason: "aborted", usage: { ...u, output } } });
        const expected = interval === 1000 && output != null && Number.isFinite(output) && output >= 0 ? output.toFixed(1) : "0.0";
        expect(component.render(200)[0]).toContain(`⚡ ${expected}t/s`);
      }
    } finally { clock.mockRestore(); }
  });

  it("subscribes to native branch changes and cleans up on replacement and shutdown", () => {
    const handlers = new Map<string, Function>();
    footer({ on: (name: string, fn: Function) => handlers.set(name, fn) } as unknown as ExtensionAPI);
    const unsubscribes = [vi.fn(), vi.fn()];
    const listeners: Function[] = [];
    let branch: string | undefined = "main";
    let component: any;
    const render = vi.fn();
    const data = { getGitBranch: () => branch, onBranchChange: (fn: Function) => { listeners.push(fn); return unsubscribes[listeners.length - 1]; } };
    const ctx = { ...context(), cwd: "C:/runtime/project", mode: "tui", ui: { setFooter: (factory: Function) => { component = factory({ requestRender: render }, theme, data); } } };

    handlers.get("session_start")!({}, ctx);
    expect(component.render(160)[0]).toContain("⎇ main");
    branch = undefined;
    listeners[0]();
    expect(render).toHaveBeenCalledOnce();
    expect(component.render(160)[0]).not.toContain("⎇");

    handlers.get("session_start")!({}, ctx);
    expect(unsubscribes[0]).toHaveBeenCalledOnce();
    component.dispose();
    handlers.get("session_shutdown")!({}, ctx);
    expect(unsubscribes[1]).toHaveBeenCalledOnce();
  });

  it("registers independent modules without persistence, shell polling or non-TUI footer setup", async () => {
    const handlers = new Map<string, Function[]>();
    const commands = new Map<string, any>();
    const pi = { on: (name: string, fn: Function) => handlers.set(name, [...(handlers.get(name) ?? []), fn]), events: { on: vi.fn() }, registerCommand: (name: string, cmd: unknown) => commands.set(name, cmd) } as unknown as ExtensionAPI;
    footer(pi); usage(pi);
    expect([...commands.keys()]).toEqual(["ptk-usage"]);
    expect(handlers.has("turn_end")).toBe(false);
    const ctx = { ...context(), cwd: "C:/projects/runtime-folder", mode: "rpc", ui: { setFooter: vi.fn(), notify: vi.fn(), custom: vi.fn() } };
    for (const fn of handlers.get("session_start")!) await fn({}, ctx);
    await commands.get("ptk-usage").handler("", ctx);
    expect(ctx.ui.setFooter).not.toHaveBeenCalled();
    expect(ctx.ui.custom).not.toHaveBeenCalled();
    ctx.mode = "tui";
    for (const fn of handlers.get("session_start")!) await fn({}, ctx);
    expect(ctx.ui.setFooter).toHaveBeenCalledOnce();
    vi.useFakeTimers();
    try {
      const render = vi.fn();
      const component = ctx.ui.setFooter.mock.calls[0][0]({ requestRender: render }, theme, { getGitBranch: () => null, onBranchChange: () => () => {} });
      expect(component.render(160)).toHaveLength(1);
      expect(component.render(160)[0]).toContain("runtime-folder");
      vi.advanceTimersByTime(1000);
      expect(render).not.toHaveBeenCalled();
      component.dispose();
      for (const fn of handlers.get("session_shutdown")!) await fn({}, ctx);
      vi.advanceTimersByTime(1000);
      expect(render).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
