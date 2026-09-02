import { describe, expect, it, vi } from "vitest";
import { resolveHarnessInvocation } from "../../pi-toolkit-lib/unified-subagents/harness-resolution.js";
import type { AgentConfig } from "../../pi-toolkit-lib/unified-subagents/types.js";

const piModel = { provider: "anthropic", id: "parent", name: "Parent" } as any;
const ctx = (trusted = true) => ({
  cwd: "/repo",
  model: piModel,
  modelRegistry: {
    find: vi.fn(),
    getAvailable: vi.fn(() => []),
    getAll: vi.fn(() => []),
  },
  isProjectTrusted: () => trusted,
}) as any;

const config = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  name: "worker",
  description: "Worker",
  extensions: true,
  skills: true,
  systemPrompt: "Work.",
  promptMode: "replace",
  ...overrides,
});

describe("harness resolution seam", () => {
  it("keeps custom-agent harness and model authoritative", () => {
    const result = resolveHarnessInvocation({
      ctx: ctx(),
      config: config({ harness: "codex", model: "openai/gpt-5.4" }),
      params: { harness: "pi", model: "anthropic/ignored", thinking: "high" },
      agentLabel: "Worker",
    });

    expect(result).toMatchObject({
      harness: "codex",
      model: undefined,
      modelHint: "gpt-5.4",
      trusted: true,
      thinking: "high",
      invocation: { harness: "codex", modelName: "gpt-5.4" },
    });
  });

  it("normalizes RPC aliases and strips native models from Pi resolution", () => {
    const context = ctx();
    const result = resolveHarnessInvocation({
      ctx: context,
      params: {
        harness: "codex",
        model: "openai/gpt-5.4",
        thinkingLevel: "xhigh",
        isBackground: true,
      },
      agentLabel: "RPC worker",
    });

    expect(result).toMatchObject({
      harness: "codex",
      modelHint: "gpt-5.4",
      thinking: "xhigh",
      runInBackground: true,
    });
    expect(context.modelRegistry.find).not.toHaveBeenCalled();
  });

  it("rejects unsupported native operations and forged values", () => {
    expect(() => resolveHarnessInvocation({
      ctx: ctx(), params: { harness: "codex" }, operation: "schedule", agentLabel: "worker",
    })).toThrow("does not support schedule");
    expect(() => resolveHarnessInvocation({
      ctx: ctx(false), params: { harness: "codex" }, agentLabel: "worker",
    })).toThrow("working directory to be trusted");
    expect(() => resolveHarnessInvocation({
      ctx: ctx(), params: { harness: "codex", model: piModel }, agentLabel: "worker",
    })).toThrow("native model ID string");
    expect(() => resolveHarnessInvocation({
      ctx: ctx(), params: { harness: "unknown" }, agentLabel: "worker",
    })).toThrow("Unknown subagent harness");
  });

  it("keeps omitted calls on Pi with the parent model", () => {
    const result = resolveHarnessInvocation({ ctx: ctx(), params: {}, agentLabel: "worker" });
    expect(result).toMatchObject({ harness: "pi", model: piModel, trusted: undefined });
  });
});
