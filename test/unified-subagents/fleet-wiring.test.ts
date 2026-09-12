/**
 * fleet-wiring.test.ts — end-to-end wiring of the FleetView through the REAL
 * extension (src/index.ts), not the FleetList class in isolation.
 *
 * The unit tests in fleet-list.test.ts drive FleetList with a fake ui/manager.
 * These prove the bits only the extension can: that `tool_execution_start`
 * hands the fleet the live UI (so it captures input), that spawning a background
 * agent actually registers the `belowEditor` widget once the agent has a session,
 * and that `session_shutdown` tears it down. runAgent is mocked (no LLM); the
 * manager, settings load, completion routing, and lifecycle handlers are real.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../pi-toolkit-lib/unified-subagents/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../../pi-toolkit-lib/unified-subagents/agent-runner.js")>("../../pi-toolkit-lib/unified-subagents/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../../pi-toolkit-lib/unified-subagents/agent-runner.js";
import { registerUnifiedSubagents as subagentsExtension } from "../../pi-toolkit-lib/unified-subagents/index.js";

type RunResult = Awaited<ReturnType<typeof runAgent>>;

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

/** A UI context with the surfaces the widget + fleet touch; setWidget is spied. */
function uiCtx() {
  return {
    setStatus: vi.fn(),
    setWidget: vi.fn(),
    notify: vi.fn(),
    onTerminalInput: vi.fn(() => vi.fn()),
    getEditorText: vi.fn(() => ""),
    custom: vi.fn(),
  };
}

function ctxWith(ui: ReturnType<typeof uiCtx>) {
  return {
    hasUI: true,
    ui,
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
    getSystemPrompt: () => "parent",
  } as any;
}

const textOf = (r: any): string => r.content[0].text;
const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

describe("FleetView wiring (real extension lifecycle)", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-fleet-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-fleet-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    // async join → completion routes straight to sendIndividualNudge (no batch
    // debounce), so fleet.onAgentFinished fires synchronously on the result.
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false, defaultJoinMode: "async" }));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("captures terminal input on tool_execution_start (fleet hooked into the UI)", async () => {
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);
    const ui = uiCtx();
    await lifecycle.get("tool_execution_start")?.({}, ctxWith(ui));
    expect(ui.onTerminalInput).toHaveBeenCalled();
  });

  it("Ctrl+B turns a blocking foreground Agent call into a live background run", async () => {
    let finish: (value: RunResult) => void = () => {};
    let childSignal: AbortSignal | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options) => {
      childSignal = options.signal;
      return new Promise<RunResult>((resolve) => { finish = resolve; });
    });

    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const ui = uiCtx();
    const toolCtx = ctxWith(ui);
    await lifecycle.get("tool_execution_start")?.({}, toolCtx);

    const parent = new AbortController();
    const call = tools.get("Agent").execute(
      "tc-fg",
      { prompt: "go", description: "live foreground", subagent_type: "general-purpose", run_in_background: false },
      parent.signal,
      vi.fn(),
      toolCtx,
    );
    await flush();

    const terminalHandler = ui.onTerminalInput.mock.calls[0]?.[0];
    expect(terminalHandler?.("\x02")).toEqual({ consume: true });

    const detached = await call;
    expect(textOf(detached)).toContain("Agent moved to background.");
    expect(textOf(detached)).toMatch(/Agent ID:/);
    expect(detached.details.status).toBe("background");
    expect(ui.notify).toHaveBeenCalledWith('Agent "live foreground" is now running in background.', "info");

    parent.abort();
    expect(childSignal?.aborted).toBe(false);

    finish({
      responseText: "done after detach",
      session: { dispose: vi.fn() } as RunResult["session"],
      aborted: false,
      steered: false,
    });
    await flush();

    const id = textOf(detached).match(/Agent ID: ([^\n]+)/)?.[1];
    const read = await tools.get("get_subagent_result").execute(
      "tc-read",
      { agent_id: id },
      undefined,
      undefined,
      toolCtx,
    );
    expect(textOf(read)).toContain("done after detach");

    await lifecycle.get("session_shutdown")?.({}, toolCtx);
  });

  it("registers the belowEditor widget once a spawned agent has a session, then clears it on shutdown", async () => {
    const session = { dispose: vi.fn() } as RunResult["session"];
    let finish!: (result: RunResult) => void;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options) => {
      options?.onSessionCreated?.(session);
      return new Promise<RunResult>(resolve => { finish = resolve; });
    });

    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const ui = uiCtx();
    await lifecycle.get("tool_execution_start")?.({}, ctxWith(ui)); // fleet captures THIS ui

    const spawn = await tools.get("Agent").execute(
      "tc",
      { prompt: "go", description: "live one", subagent_type: "general-purpose", run_in_background: true },
      undefined,
      undefined,
      ctxWith(ui),
    );
    expect(textOf(spawn)).toMatch(/Agent ID:/);
    await flush(); // inspect a live session: completed agents must not linger

    const fleetRegs = ui.setWidget.mock.calls.filter(c => c[0] === "fleet" && typeof c[1] === "function");
    expect(fleetRegs.length, "fleet widget should register with a render factory").toBeGreaterThan(0);
    expect(ui.setWidget.mock.calls.some(c => c[0] === "agents" && typeof c[1] === "function")).toBe(false);
    expect(ui.setStatus).not.toHaveBeenCalledWith("subagents", expect.any(String));

    finish({ responseText: "done", session, aborted: false, steered: false });
    await flush();
    await lifecycle.get("session_shutdown")?.({}, ctxWith(uiCtx()));
    expect(ui.setWidget).toHaveBeenCalledWith("fleet", undefined); // dispose cleared it
  });

  it("does not restore the legacy above-editor widget when FleetView is disabled", async () => {
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({
      schedulingEnabled: false,
      defaultJoinMode: "async",
      fleetView: false,
    }));
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });

    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const ui = uiCtx();
    const ctx = ctxWith(ui);
    await lifecycle.get("tool_execution_start")?.({}, ctx);
    await tools.get("Agent").execute(
      "tc-widget",
      { prompt: "go", description: "legacy fallback", subagent_type: "general-purpose", run_in_background: true },
      undefined,
      undefined,
      ctx,
    );

    expect(ui.setWidget.mock.calls.some(c => c[0] === "agents" && typeof c[1] === "function")).toBe(false);
    expect(ui.setWidget.mock.calls.some(c => c[0] === "fleet" && typeof c[1] === "function")).toBe(false);
    await lifecycle.get("session_shutdown")?.({}, ctx);
  });
});
