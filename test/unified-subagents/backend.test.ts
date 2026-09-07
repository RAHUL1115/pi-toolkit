import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../../pi-toolkit-lib/unified-subagents/agent-manager.js";
import { getBackend, type SubagentSession } from "../../pi-toolkit-lib/unified-subagents/backend.js";
import { agyBackend } from "../../pi-toolkit-lib/unified-subagents/backends/agy.js";
import { claudeBackend } from "../../pi-toolkit-lib/unified-subagents/backends/claude.js";
import { codexBackend } from "../../pi-toolkit-lib/unified-subagents/backends/codex.js";
import { piBackend } from "../../pi-toolkit-lib/unified-subagents/backends/pi.js";

vi.mock("../../pi-toolkit-lib/unified-subagents/backends/agy.js", () => ({
  agyBackend: {
    harness: "agy",
    run: vi.fn(),
    resume: vi.fn(),
  },
}));

vi.mock("../../pi-toolkit-lib/unified-subagents/backends/pi.js", () => ({
  piBackend: {
    harness: "pi",
    run: vi.fn(),
    resume: vi.fn(),
  },
}));

vi.mock("../../pi-toolkit-lib/unified-subagents/backends/claude.js", () => ({
  claudeBackend: {
    harness: "claude",
    run: vi.fn(),
    resume: vi.fn(),
  },
}));

vi.mock("../../pi-toolkit-lib/unified-subagents/backends/codex.js", () => ({
  codexBackend: {
    harness: "codex",
    run: vi.fn(),
    resume: vi.fn(),
  },
}));

vi.mock("../../pi-toolkit-lib/unified-subagents/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
}));

const pi = {} as ExtensionAPI;
const ctx = { cwd: "/tmp" } as ExtensionContext;

function sessionFixture(): SubagentSession {
  return {
    messages: [],
    subscribe: () => () => {},
    steer: async () => {},
    getSessionStats: () => ({
      tokens: { input: 0, output: 0, cacheWrite: 0 },
    }),
    dispose: vi.fn(),
  };
}

describe("AgentManager backend seam", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
    vi.clearAllMocks();
  });

  it("uses a fixed lookup with Pi as the default", () => {
    expect(getBackend()).toBe(piBackend);
    expect(getBackend("pi")).toBe(piBackend);
    expect(getBackend("claude")).toBe(claudeBackend);
    expect(getBackend("codex")).toBe(codexBackend);
    expect(getBackend("agy")).toBe(agyBackend);
  });

  it("routes new runs through the default Pi backend", async () => {
    const session = sessionFixture();
    vi.mocked(piBackend.run).mockResolvedValue({
      responseText: "done",
      session,
      aborted: false,
      steered: false,
    });
    manager = new AgentManager();

    const id = manager.spawn(pi, ctx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)?.promise;

    expect(piBackend.run).toHaveBeenCalledOnce();
    expect(claudeBackend.run).not.toHaveBeenCalled();
    expect(codexBackend.run).not.toHaveBeenCalled();
    expect(manager.getRecord(id)).toMatchObject({ harness: "pi", session });
  });

  it("routes mixed harnesses through one queue and propagates Claude-native options", async () => {
    const piSession = sessionFixture();
    const claudeSession = sessionFixture();
    let finishPi: (() => void) | undefined;
    vi.mocked(piBackend.run).mockImplementation(() => new Promise((resolve) => {
      finishPi = () => resolve({ responseText: "pi", session: piSession, aborted: false, steered: false });
    }));
    vi.mocked(claudeBackend.run).mockResolvedValue({
      responseText: "claude",
      session: claudeSession,
      aborted: false,
      steered: false,
    });
    manager = new AgentManager(undefined, 1);
    const config = {
      name: "native",
      description: "native",
      extensions: false,
      skills: false,
      systemPrompt: "custom",
      promptMode: "replace",
    } as const;

    const piId = manager.spawn(pi, ctx, "general-purpose", "pi", {
      description: "pi",
      isBackground: true,
    });
    const claudeId = manager.spawn(pi, ctx, "native", "claude", {
      description: "claude",
      harness: "claude",
      modelHint: "sonnet",
      trusted: true,
      agentConfig: config,
      isBackground: true,
    });

    expect(manager.getRecord(claudeId)).toMatchObject({ harness: "claude", status: "queued" });
    expect(claudeBackend.run).not.toHaveBeenCalled();
    finishPi?.();
    await manager.getRecord(piId)?.promise;
    await vi.waitFor(() => expect(claudeBackend.run).toHaveBeenCalledOnce());
    await manager.getRecord(claudeId)?.promise;

    expect(claudeBackend.run).toHaveBeenCalledWith(ctx, "native", "claude", expect.objectContaining({
      agentConfig: config,
      model: undefined,
      modelHint: "sonnet",
      trusted: true,
    }));
  });

  it("routes Codex-native options through the shared manager", async () => {
    const session = sessionFixture();
    vi.mocked(codexBackend.run).mockResolvedValue({
      responseText: "codex",
      session,
      aborted: false,
      steered: false,
    });
    manager = new AgentManager();

    const id = manager.spawn(pi, ctx, "native", "work", {
      description: "codex",
      harness: "codex",
      modelHint: "gpt-5.4",
      thinkingLevel: "high",
      trusted: true,
      isBackground: true,
    });
    await manager.getRecord(id)?.promise;

    expect(codexBackend.run).toHaveBeenCalledWith(ctx, "native", "work", expect.objectContaining({
      model: undefined,
      modelHint: "gpt-5.4",
      thinkingLevel: "high",
      trusted: true,
    }));
  });

  it("resumes through the record's original harness", async () => {
    const session = sessionFixture();
    vi.mocked(claudeBackend.run).mockResolvedValue({
      responseText: "first",
      session,
      aborted: false,
      steered: false,
    });
    vi.mocked(claudeBackend.resume).mockResolvedValue({ text: "second" });
    manager = new AgentManager();

    const id = manager.spawn(pi, ctx, "native", "test", {
      description: "test",
      harness: "claude",
      trusted: true,
      isBackground: true,
    });
    await manager.getRecord(id)?.promise;
    await manager.resume(id, "continue");

    expect(claudeBackend.resume).toHaveBeenCalledWith(session, "continue", expect.any(Object));
    expect(piBackend.resume).not.toHaveBeenCalled();
  });

  it("rejects a Claude custom cwd before backend execution", () => {
    manager = new AgentManager();
    expect(() => manager.spawn(pi, ctx, "native", "test", {
      description: "test",
      harness: "claude",
      trusted: true,
      cwd: "/",
    })).toThrow("does not support a custom cwd");
    expect(claudeBackend.run).not.toHaveBeenCalled();
  });

  it("routes resumed runs through the same Pi backend", async () => {
    const session = sessionFixture();
    vi.mocked(piBackend.run).mockResolvedValue({
      responseText: "first",
      session,
      aborted: false,
      steered: false,
    });
    vi.mocked(piBackend.resume).mockResolvedValue({ text: "second" });
    manager = new AgentManager();

    const id = manager.spawn(pi, ctx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)?.promise;
    await manager.resume(id, "continue");

    expect(piBackend.resume).toHaveBeenCalledWith(session, "continue", expect.any(Object));
    expect(manager.getRecord(id)?.result).toBe("second");
  });
});
