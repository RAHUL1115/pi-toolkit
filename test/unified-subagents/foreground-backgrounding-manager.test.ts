import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../../pi-toolkit-lib/unified-subagents/agent-manager.js";

vi.mock("../../pi-toolkit-lib/unified-subagents/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../../pi-toolkit-lib/unified-subagents/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
}));

import { runAgent } from "../../pi-toolkit-lib/unified-subagents/agent-runner.js";

type RunResult = Awaited<ReturnType<typeof runAgent>>;

const mockPi = {} as ExtensionAPI;
const mockCtx = { cwd: "/tmp" } as ExtensionContext;
const result = (responseText: string): RunResult => ({
  responseText,
  session: { dispose: vi.fn() } as RunResult["session"],
  aborted: false,
  steered: false,
});

describe("AgentManager — foreground to background", () => {
  let manager: AgentManager;

  afterEach(() => {
    vi.useRealTimers();
    manager?.dispose();
  });

  it("releases the foreground caller, detaches parent abort, and joins the background pool", async () => {
    const finishes: Array<(value: RunResult) => void> = [];
    let childSignal: AbortSignal | undefined;
    const completed = vi.fn();
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options) => {
      childSignal = options.signal;
      return new Promise<RunResult>((resolve) => finishes.push(resolve));
    });
    manager = new AgentManager(completed, 1);

    const parent = new AbortController();
    let foregroundId = "";
    const foreground = manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "first", {
      description: "first",
      signal: parent.signal,
    }, (id) => { foregroundId = id; });

    const backgrounded = manager.backgroundForeground();
    expect(backgrounded).toEqual(expect.objectContaining({
      id: foregroundId,
      status: "running",
      isBackground: true,
      resultConsumed: false,
    }));
    await expect(foreground).resolves.toEqual({ id: foregroundId, record: backgrounded });

    parent.abort();
    expect(childSignal?.aborted).toBe(false);
    expect(backgrounded?.status).toBe("running");

    const queuedId = manager.spawn(mockPi, mockCtx, "general-purpose", "second", {
      description: "second",
      isBackground: true,
    });
    expect(manager.getRecord(queuedId)?.status).toBe("queued");

    finishes[0](result("first done"));
    await backgrounded?.promise;
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({
      id: foregroundId,
      status: "completed",
      resultConsumed: false,
    }));
    expect(manager.getRecord(queuedId)?.status).toBe("running");

    finishes[1](result("second done"));
    await manager.getRecord(queuedId)?.promise;
  });

  it("automatically backgrounds a foreground run after the requested delay", async () => {
    vi.useFakeTimers();
    let finish!: (value: RunResult) => void;
    vi.mocked(runAgent).mockImplementation(() => new Promise<RunResult>((resolve) => { finish = resolve; }));
    manager = new AgentManager();

    const foreground = manager.spawnAndWait(
      mockPi,
      mockCtx,
      "general-purpose",
      "slow",
      { description: "slow" },
      undefined,
      300_000,
    );
    const record = manager.listAgents()[0];

    await vi.advanceTimersByTimeAsync(299_999);
    expect(record.isBackground).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(foreground).resolves.toEqual({ id: record.id, record });
    expect(record.isBackground).toBe(true);

    finish(result("done"));
    await record.promise;
  });

  it("does nothing when no blocking foreground caller exists", () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise<RunResult>(() => {}));
    manager = new AgentManager();
    manager.spawn(mockPi, mockCtx, "general-purpose", "background", {
      description: "background",
      isBackground: true,
    });

    expect(manager.backgroundForeground()).toBeUndefined();
  });
});
