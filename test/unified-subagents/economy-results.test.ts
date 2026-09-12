import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../../pi-toolkit-lib/unified-subagents/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../../pi-toolkit-lib/unified-subagents/agent-runner.js")>("../../pi-toolkit-lib/unified-subagents/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});
import { runAgent } from "../../pi-toolkit-lib/unified-subagents/agent-runner.js";
import { registerUnifiedSubagents } from "../../pi-toolkit-lib/unified-subagents/index.js";
import { getLightModel } from "../../pi-toolkit-lib/unified-subagents/settings.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0)) await fn(); });
function setup() {
  const tools = new Map<string, any>();
  const events = new Map<string, any[]>();
  const pi = {
    registerMessageRenderer: vi.fn(), registerEntryRenderer: vi.fn(), registerFlag: vi.fn(), getFlag: vi.fn(), registerTool: (t: any) => tools.set(t.name, t), registerCommand: vi.fn(),
    on: (n: string, h: any) => events.set(n, [...(events.get(n) ?? []), h]),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) }, appendEntry: vi.fn(), sendMessage: vi.fn(),
  } as any;
  const [provider, ...parts] = getLightModel().split("/");
  const model = { provider, id: parts.join("/"), name: "Light" };
  const ctx = {
    hasUI: false, ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() }, cwd: process.cwd(),
    model, modelRegistry: { find: vi.fn(() => model), getAvailable: vi.fn(() => [model]), getAll: vi.fn(() => [model]) },
    sessionManager: { getSessionId: () => "economy-test", getBranch: () => [] }, getSystemPrompt: () => "parent secret",
  } as any;
  registerUnifiedSubagents(pi);
  cleanups.push(async () => { for (const h of events.get("session_shutdown") ?? []) await h({}, ctx); });
  const call = async (tool: string, params: any) => {
    const result = await tools.get(tool).execute("tc", params, undefined, undefined, ctx);
    const artifact = result.content[0].text.match(/Complete output: (.*)\. Use ranged read/)?.[1];
    if (artifact) cleanups.push(async () => { rmSync(dirname(artifact), { recursive: true, force: true }); });
    return result;
  };
  return { call };
}
const payload = "evidence\n".repeat(4000);
const session = () => ({ dispose: vi.fn(), messages: [{ role: "assistant", content: [{ type: "text", text: payload }] }] }) as any;
it.each([undefined, "provider failed"])("bounds foreground and verbose retrieval, preserving failure %s", async (failure) => {
  const { call } = setup();
  vi.mocked(runAgent).mockResolvedValue({ responseText: payload, session: session(), aborted: false, steered: false, failure } as any);
  const result = await call("Agent", { subagent_type: "bulk-reader", description: "inspect", prompt: "Find evidence in file.txt", run_in_background: false });
  expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(8192);
  expect(result.content[0].text).toContain(failure ? "Agent failed:" : "Agent completed");
  const fetched = await call("get_subagent_result", { agent_id: result.details.agentId, verbose: true });
  expect(Buffer.byteLength(fetched.content[0].text)).toBeLessThanOrEqual(8192);
  expect(fetched.content[0].text).toContain(failure ? "Status: error" : "Status: completed");
  expect(fetched.content[0].text).toContain("Complete output:");
});

it("keeps hard-aborted runs visibly incomplete while bounding partial output", async () => {
  const { call } = setup();
  vi.mocked(runAgent).mockResolvedValue({ responseText: payload, session: session(), aborted: true, steered: false } as any);
  const result = await call("Agent", { subagent_type: "bulk-reader", description: "inspect", prompt: "Inspect file.txt", run_in_background: false });
  expect(result.details.status).toBe("aborted");
  expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(8192);
  const fetched = await call("get_subagent_result", { agent_id: result.details.agentId });
  expect(fetched.content[0].text).toContain("Status: aborted");
});
