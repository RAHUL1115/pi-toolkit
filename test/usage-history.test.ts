import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { historyAccumulator, scanUsageHistory, usageTime } from "../pi-toolkit-lib/usage-history.ts";
import registerUsage, { usagePanel } from "../pi-toolkit-lib/usage.ts";
import * as history from "../pi-toolkit-lib/usage-history.ts";

const now = Date.parse("2026-06-18T12:00:00Z");
const day = 86_400_000;
const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 1, totalTokens: 10, cost: { total: 0.25 } };
const message = (id: string, time = now) => ({ type: "message", id, parentId: null, timestamp: new Date(now).toISOString(), message: { role: "assistant", content: [], provider: "custom-real-provider", model: "any-model", api: "openai-responses", usage, timestamp: time, stopReason: "stop" } }) as unknown as SessionEntry;
const header = { type: "session", version: 3, id: "ledger", timestamp: new Date(now).toISOString(), cwd: "/project" };
const theme = { bg: (_: string, text: string) => text, fg: (_: string, text: string) => text, bold: (text: string) => text };
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function root() { const dir = await mkdtemp(join(tmpdir(), "ptk-usage-")); dirs.push(dir); return dir; }
async function ledger(dir: string, name: string, entries: unknown[]) { const path = join(dir, name); await writeFile(path, [header, ...entries].map(e => JSON.stringify(e)).join("\n") + "\n"); return path; }

describe("rolling ledger usage", () => {
  it("uses message instants and inclusive rolling boundaries, never session/entry age", () => {
    const { report, add } = historyAccumulator(now);
    [now, now - day, now - day - 1, now - 7 * day, now - 7 * day - 1, now - 30 * day, now - 30 * day - 1, now + 1].forEach((time, i) => add(message(String(i), time)));
    expect(report.windows.map(w => w.total)).toEqual([20, 40, 60]);
    expect(report.windows.map(w => w.reasoning)).toEqual([2, 4, 6]);
    const m = message("legacy") as any;
    delete m.message.timestamp;
    m.timestamp = "2026-06-18T17:30:00+05:30";
    expect(usageTime(m)).toBe(now);
    m.timestamp = "2026-06-18T12:00:00";
    add(m);
    expect(report.invalid).toBe(1);
  });

  it("deduplicates native fork copies, not independent records or same-ID collisions", () => {
    const { report, add } = historyAccumulator(now);
    const original = message("same-id");
    add(original);
    add({ ...structuredClone(original), parentId: "new-root" });
    add(message("new-id"));
    add(message("same-id", now - 1));
    expect(report.windows[0]!.total).toBe(30);
    expect(report.duplicates).toBe(1);
  });

  it("counts finalized nested usage and summary usage once; not details, retained tail or obs events", () => {
    const { report, add } = historyAccumulator(now);
    add(message("assistant"));
    add({ type: "message", id: "tool", timestamp: new Date(now).toISOString(), message: { role: "toolResult", timestamp: now, usage, details: { usage, messages: [message("copy")] } } } as unknown as SessionEntry);
    add({ type: "compaction", id: "compact", timestamp: new Date(now).toISOString(), usage, retainedTail: [message("copy")] } as unknown as SessionEntry);
    add({ type: "branch_summary", id: "branch", timestamp: new Date(now).toISOString(), usage } as unknown as SessionEntry);
    add({ type: "custom", customType: "obs-turn", data: { usage } } as unknown as SessionEntry);
    expect(report.windows[0]).toMatchObject({ input: 4, output: 8, cacheRead: 12, cacheWrite: 16, total: 40, cost: 1, reasoning: 4 });
  });

  it("reconciles model buckets in every window after normalization, copies and unattributed aggregates", () => {
    const { report, add } = historyAccumulator(now);
    const model = (id: string, provider: string, name: string, time = now, cost: number | undefined = .25) => {
      const entry = message(id, time) as any;
      Object.assign(entry.message, { provider, model: name, usage: { ...usage, cost: cost === undefined ? undefined : { total: cost } } });
      return entry;
    };
    const original = model("one", " p ", " p/shared ");
    add(original); add(structuredClone(original));
    add(model("two", "p", "shared", now - 2 * day));
    add(model("three", "other", "shared", now - 8 * day));
    add(model("alias", "p", "shared-latest")); // Unknown aliases must not be guessed.
    add(model("zero", "p", "zero", now, 0));
    const missing = model("missing", "p", "shared"); delete missing.message.usage.cost; add(missing);
    add(model("unknown", "", "shared"));
    for (const type of ["compaction", "branch_summary"]) add({ type, id: type, timestamp: new Date(now).toISOString(), usage, provider: "p", model: "shared" } as any);
    add({ type: "message", id: "nested", timestamp: new Date(now).toISOString(), message: { role: "toolResult", timestamp: now, usage, provider: "p", model: "shared", details: { messages: [original] } } } as any);
    expect(report.duplicates).toBe(1);
    expect(report.windows.map(w => w.total)).toEqual([80, 90, 100]);
    for (const w of report.windows) {
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "total", "cost", "missingCosts", "reasoning"] as const) {
        expect(w.byModel.reduce((sum, b) => sum + (b[key] ?? 0), 0)).toBeCloseTo(w[key] ?? 0);
      }
      expect(w.byModel[0]).toMatchObject({ provider: null, model: null, total: 40 });
      expect(w.byModel.find(b => b.provider === "p" && b.model === "shared")).toMatchObject({ missingCosts: 1 });
    }
    expect(report.windows[2].byModel.map(b => [b.provider, b.model])).toEqual([[null, null], ["p", "shared"], ["other", "shared"], ["p", "shared-latest"], ["p", "zero"]]);
    const reverse = historyAccumulator(now);
    [model("b", "z", "b"), model("a", "z", "a"), model("c", "a", "z")].forEach(reverse.add);
    expect(reverse.report.windows[0].byModel.map(b => `${b.provider}/${b.model}`)).toEqual(["a/z", "z/a", "z/b"]);
  });

  it("flags missing pricing and malformed records without losing valid data", () => {
    const { report, add } = historyAccumulator(now);
    add(null as any);
    add({ type: "message" } as any);
    add({ ...message("missing"), message: { ...(message("missing") as any).message, usage: { ...usage, cost: undefined } } } as any);
    add({ ...message("bad-time"), message: { ...(message("bad-time") as any).message, timestamp: "bad" } } as any);
    expect(report.windows[0]).toMatchObject({ total: 10, cost: 0, missingCosts: 1 });
    expect(report.invalid).toBe(3);
  });

  it("streams native ledgers across projects and overlays unflushed memory without writing history", async () => {
    const dir = await root();
    const project = join(dir, "project"); await mkdir(project);
    const file = await ledger(project, "original.jsonl", [message("original")]);
    await ledger(project, "clone.jsonl", [message("original"), message("clone-new")]);
    await writeFile(join(project, "obs-history.jsonl"), JSON.stringify({ type: "obs-turn", cost: 999999 }));
    const before = await readFile(file, "utf8");
    const sm = SessionManager.inMemory();
    const entries = [message("original"), message("unflushed")];
    vi.spyOn(sm, "getEntries").mockReturnValue(entries);
    const report = await scanUsageHistory(sm, new AbortController().signal, { root: dir, now });
    expect(report.windows[0]!.total).toBe(30);
    expect(report.duplicates).toBe(2);
    expect(report.skipped).toBe(1);
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("reports corrupt/unsupported files, byte/file limits and pre-cancellation", async () => {
    const dir = await root();
    await ledger(dir, "good.jsonl", [message("a")]);
    await writeFile(join(dir, "broken.jsonl"), [JSON.stringify(header), "{bad", JSON.stringify(message("b"))].join("\n"));
    await writeFile(join(dir, "old.jsonl"), JSON.stringify({ ...header, version: 1 }));
    const sm = SessionManager.inMemory();
    const scan = (extra = {}) => scanUsageHistory(sm, new AbortController().signal, { root: dir, now, ...extra });
    expect(await scan()).toMatchObject({ invalid: 1, skipped: 1 });
    expect((await scan()).windows[0]!.total).toBe(20);
    expect(await scan({ maxFiles: 1 })).toMatchObject({ files: 1, partial: true });
    expect(await scan({ maxBytes: 1 })).toMatchObject({ partial: true });
    expect(await scanUsageHistory(sm, AbortSignal.abort(), { root: dir, now })).toMatchObject({ files: 0, partial: true });
  });

  it("stops at the scan deadline and releases its timer", async () => {
    const dir = await root(); await ledger(dir, "good.jsonl", [message("a")]);
    vi.useFakeTimers();
    try {
      const pending = scanUsageHistory(SessionManager.inMemory(), new AbortController().signal, { root: dir, now, timeoutMs: 100 });
      vi.advanceTimersByTime(100);
      expect(await pending).toMatchObject({ partial: true });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("scans once per opening and cancels/closes on session shutdown", async () => {
    const scan = vi.spyOn(history, "scanUsageHistory").mockResolvedValue(historyAccumulator(now).report);
    try {
      let command: any; let shutdown: Function = () => {}; let component: any;
      const tui = { terminal: { rows: 24 }, requestRender: vi.fn() };
      registerUsage({ registerCommand: (_name: string, cmd: any) => { command = cmd; }, on: (_name: string, fn: Function) => { shutdown = fn; } } as any);
      const ctx = { mode: "tui", sessionManager: SessionManager.inMemory(), ui: { custom: (factory: Function) => new Promise<void>(resolve => { component = factory(tui, theme, {}, resolve); }) } };
      const running = command.handler("", ctx);
      await vi.waitFor(() => expect(component.render(100).join("\n")).toContain(" 1 day "));
      component.handleInput("\t"); component.render(100); component.invalidate(); component.render(80);
      expect(scan).toHaveBeenCalledOnce();
      const signal = scan.mock.calls[0]![1];
      shutdown(); await running;
      expect(signal.aborted).toBe(true);
      component.dispose();
    } finally { scan.mockRestore(); }
  });

  it("cancels the loading view without waiting for a scan result", async () => {
    const scan = vi.spyOn(history, "scanUsageHistory").mockImplementation((_sm, signal) => new Promise(resolve => signal.addEventListener("abort", () => resolve(historyAccumulator(now).report), { once: true })));
    try {
      let command: any; let component: any;
      const tui = { terminal: { rows: 24 }, requestRender: vi.fn() };
      registerUsage({ registerCommand: (_name: string, cmd: any) => { command = cmd; }, on() {} } as any);
      const ctx = { mode: "tui", sessionManager: SessionManager.inMemory(), ui: { custom: (factory: Function) => new Promise<void>(resolve => { component = factory(tui, theme, {}, resolve); }) } };
      const running = command.handler("", ctx);
      expect(component.render(100)[0]).toContain("Reading local Pi ledgers");
      component.handleInput("\x1b"); await running; await Promise.resolve();
      expect(scan.mock.calls[0]![1].aborted).toBe(true);
      expect(tui.requestRender).not.toHaveBeenCalled();
    } finally { scan.mockRestore(); }
  });

  it("keeps tab row and key hints visible while scrolling; switches periods locally", () => {
    const { report, add } = historyAccumulator(now); add(message("a"));
    const done = vi.fn(); const tui = { terminal: { rows: 15 }, requestRender: vi.fn() };
    const panel = usagePanel(report, tui, theme, done);
    expect(panel.render(100)[1]).toContain(" 1 day ");
    panel.handleInput("\t"); expect(panel.render(100)[1]).toContain(" 7 days ");
    panel.handleInput("\x1b[C"); expect(panel.render(100)[1]).toContain(" 30 days ");
    panel.handleInput("\x1b[C"); expect(panel.render(100)[1]).toContain(" 1 day ");
    panel.handleInput("\x1b[D"); expect(panel.render(100)[1]).toContain(" 30 days ");
    panel.handleInput("\x1b[6~");
    const scrolled = panel.render(100);
    expect(scrolled[1]).toContain(" 30 days ");
    expect(scrolled.at(-2)).toContain("Esc close");
    expect(scrolled.join("\n")).not.toContain("Total tokens");
    panel.handleInput("\x1b[5~"); expect(panel.render(100).join("\n")).toContain("Total tokens");
    for (const width of [0, 1, 2, 20, 80]) for (const line of panel.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    panel.invalidate(); panel.handleInput("\x1b"); expect(done).toHaveBeenCalledOnce();
  });
});
