/**
 * background-by-default.test.ts — the `backgroundByDefault` flip, asserted at
 * the tool boundary rather than at the resolver.
 *
 * `documented-defaults.test.ts` pins `resolveAgentInvocationConfig`'s arguments;
 * this pins what the orchestrator actually receives back from a real `Agent`
 * call, which is the part the tool description makes promises about:
 *
 *   - an unqualified spawn starts foreground and detaches at 300 seconds,
 *   - `run_in_background: false` still blocks and returns the output inline,
 *   - an explicit immediate-background fan-out still fits under the documented
 *     default concurrency limit.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../pi-toolkit-lib/unified-subagents/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../../pi-toolkit-lib/unified-subagents/agent-runner.js")>("../../pi-toolkit-lib/unified-subagents/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../../pi-toolkit-lib/unified-subagents/agent-runner.js";
import { registerUnifiedSubagents as subagentsExtension } from "../../pi-toolkit-lib/unified-subagents/index.js";

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

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (r: any): string => r.content[0].text;

const settled = (text: string) =>
  vi.mocked(runAgent).mockResolvedValue({
    responseText: text,
    session: { dispose: vi.fn() } as any,
    aborted: false,
    steered: false,
  } as any);

function spawn(tools: Map<string, any>, params: Record<string, unknown> = {}) {
  return tools.get("Agent").execute(
    "tc",
    { prompt: "go", description: "d", subagent_type: "general-purpose", ...params },
    undefined,
    undefined,
    ctx(),
  );
}

describe("backgroundByDefault", () => {
  afterEach(() => vi.useRealTimers());

  it("starts foreground and returns an agent ID only after 300 seconds", async () => {
    vi.useFakeTimers();
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any);

    const call = spawn(tools);
    let settledCall = false;
    void call.then(() => { settledCall = true; });

    await vi.advanceTimersByTimeAsync(299_999);
    expect(settledCall).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const out = textOf(await call);
    expect(out).toContain("Agent moved to background");
    expect(out).toContain("Agent ID:");
  });

  it("still blocks and returns the output inline when run_in_background is false", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    settled("THE-PAYLOAD");

    const out = textOf(await spawn(tools, { run_in_background: false }));

    expect(out).toContain("THE-PAYLOAD");
    expect(out).not.toContain("started in background");
  });

  it("starts a six-way fan-out concurrently instead of queueing the tail", async () => {
    // Six is the shape the Agent tool description tells the model to send.
    // With maxConcurrent at its old 4 this queued two of them.
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    // Never settles — every agent stays occupying its slot for the whole test.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any);

    const outs: string[] = [];
    for (let i = 0; i < 6; i++) outs.push(textOf(await spawn(tools, { run_in_background: true })));

    expect(outs).toHaveLength(6);
    for (const out of outs) expect(out).not.toContain("queued");
  });
});
