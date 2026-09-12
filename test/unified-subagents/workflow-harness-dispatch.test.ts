import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgents } from "../../pi-toolkit-lib/unified-subagents/agent-types.js";
import { createWorkflowHost } from "../../pi-toolkit-lib/unified-subagents/workflow/host.js";
import { compileJsonSchema } from "../../pi-toolkit-lib/unified-subagents/workflow/json-schema.js";
import type { WorkflowSpawnRequest } from "../../pi-toolkit-lib/unified-subagents/workflow/runtime.js";
import { ctx } from "./helpers/boot-extension.js";

const pi = { exec: vi.fn() } as any;
const trustedCtx = () => ctx({ isProjectTrusted: () => true });
const request = (overrides: Partial<WorkflowSpawnRequest> = {}): WorkflowSpawnRequest => ({
  agentId: "wf-agent-0",
  index: 0,
  prompt: "do work",
  label: "work",
  agentType: "general-purpose",
  ...overrides,
});

function record(id: string, harness: "pi" | "claude" | "codex" | "agy") {
  return {
    id,
    harness,
    status: "completed",
    result: "done",
    toolUses: 0,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 },
  } as any;
}

function fakeManager(harness: "pi" | "claude" | "codex" | "agy" = "pi") {
  const child = record("child-1", harness);
  const manager = {
    spawnAndWait: vi.fn(async (...args: any[]) => {
      args[5]?.(child.id);
      return { id: child.id, record: child };
    }),
    getRecord: vi.fn(() => child),
    resume: vi.fn(),
    abort: vi.fn(),
  };
  return { child, manager };
}

describe("workflow harness dispatch", () => {
  beforeEach(() => registerAgents(new Map()));

  it.each(["pi", "claude", "codex", "agy"] as const)("forwards an explicit %s harness through the authoritative plan", async harness => {
    const { manager } = fakeManager(harness);
    const host = createWorkflowHost({ pi, ctx: trustedCtx(), manager: manager as any });

    const result = await host.spawnAgent(request({ harness }));

    expect(result.ok).toBe(true);
    expect(manager.spawnAndWait.mock.calls[0][4]).toMatchObject({ harness });
  });

  it("honours a custom agent definition's native harness", async () => {
    registerAgents(new Map([["native", { name: "native", harness: "codex" } as any]]));
    const { manager } = fakeManager("codex");
    const host = createWorkflowHost({ pi, ctx: trustedCtx(), manager: manager as any });

    await host.spawnAgent(request({ agentType: "native" }));

    expect(manager.spawnAndWait.mock.calls[0][4]).toMatchObject({ harness: "codex", trusted: true });
  });

  it.each(["claude", "codex", "agy"] as const)("rejects schema explicitly for %s before spawning", async harness => {
    const compilation = compileJsonSchema({ type: "object", properties: {}, additionalProperties: false });
    if (!compilation.ok) throw new Error(compilation.message);
    const { manager } = fakeManager(harness);
    const host = createWorkflowHost({ pi, ctx: trustedCtx(), manager: manager as any });

    const result = await host.spawnAgent(request({ harness, schema: compilation.compiled }));

    expect(result).toMatchObject({ ok: false });
    expect(result.error).toMatch(/do not support schema\/StructuredOutput/);
    expect(manager.spawnAndWait).not.toHaveBeenCalled();
  });

  it("rejects resume explicitly for a non-Pi child", async () => {
    const { manager } = fakeManager("claude");
    const host = createWorkflowHost({ pi, ctx: trustedCtx(), manager: manager as any });
    await host.spawnAgent(request({ harness: "claude" }));

    const result = await host.resumeAgent!("wf-agent-0", "continue");

    expect(result).toMatchObject({ ok: false });
    expect(result.error).toMatch(/Claude workflow agents do not support resume/);
    expect(manager.resume).not.toHaveBeenCalled();
  });
});
