import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import registerGoals from "../pi-toolkit-lib/goals.js";
import { runInChildSessionContext } from "../pi-toolkit-lib/unified-subagents/child-context.js";
import { fauxModelBackend } from "./unified-subagents/helpers/faux-model-backend.js";
import { registerFauxProvider } from "./unified-subagents/helpers/pi-ai.js";

vi.setConfig({ testTimeout: 30_000 });

function fakePi() {
  const commands = new Map<string, unknown>();
  const tools = new Map<string, unknown>();
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  const bus = new EventEmitter();
  const pi = {
    registerCommand: (name: string, value: unknown) => commands.set(name, value),
    registerTool: (value: { name: string }) => tools.set(value.name, value),
    on: (event: string, handler: (...args: any[]) => unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    events: {
      on: (event: string, handler: (...args: any[]) => void) => {
        bus.on(event, handler);
        return () => bus.off(event, handler);
      },
      emit: (event: string, value: unknown) => bus.emit(event, value),
    },
  };
  return { pi: pi as any, commands, tools, handlers };
}

function latestGoal(manager: SessionManager) {
  const entry = [...manager.getEntries()].reverse().find(entry => entry.type === "custom" && entry.customType === "goal-state");
  return entry?.type === "custom" ? (entry.data as any)?.goal : undefined;
}

async function withSession(run: (session: Awaited<ReturnType<typeof createAgentSession>>["session"], faux: ReturnType<typeof registerFauxProvider>) => Promise<void>) {
  const cwd = mkdtempSync(join(tmpdir(), "ptk-goal-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = cwd;
  const faux = registerFauxProvider({ provider: "ptk-goal-test", models: [{ id: "test", contextWindow: 200_000 }] });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const loader = new DefaultResourceLoader({
      cwd, agentDir: cwd,
      noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true,
      extensionFactories: [pi => { registerGoals(pi); }],
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const backend = fauxModelBackend(faux.getModel());
    ({ session } = await createAgentSession({
      cwd, agentDir: cwd, resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      model: faux.getModel(), modelRuntime: backend.modelRuntime, tools: ["goal_complete", "goal_blocked", "goal_wait"],
    }));
    await session.bindExtensions({});
    await run(session, faux);
  } finally {
    try { await session?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }); }
    finally {
      session?.dispose();
      faux.unregister();
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(cwd, { recursive: true, force: true });
    }
  }
}

describe("integrated goals", () => {
  it("registers /goal and exactly the three Goal tools", () => {
    const { pi, commands, tools, handlers } = fakePi();
    registerGoals(pi);
    expect([...commands.keys()]).toEqual(["goal"]);
    expect([...tools.keys()].sort()).toEqual(["goal_blocked", "goal_complete", "goal_wait"]);
    expect(handlers.has("agent_settled")).toBe(true);
  });

  it("does not register Goal commands, tools, or handlers in child sessions", async () => {
    const { pi, commands, tools, handlers } = fakePi();
    await runInChildSessionContext(async () => { registerGoals(pi); });
    expect(commands.size).toBe(0);
    expect(tools.size).toBe(0);
    expect(handlers.size).toBe(0);
  });

  it("does not activate or continue an ordinary real SDK turn just because Goal tools are visible", async () => {
    await withSession(async (session, faux) => {
      expect(session.getActiveToolNames().sort()).toEqual(["goal_blocked", "goal_complete", "goal_wait"]);
      faux.setResponses(["ordinary response"]);
      await session.prompt("This is ordinary work, not Goal mode.");
      expect(latestGoal(session.sessionManager)).toBeUndefined();
      expect(session.messages.filter(message => message.role === "assistant")).toHaveLength(1);
    });
  });

  it("rejects completion outside Goal mode without creating a Goal", async () => {
    await withSession(async (session, faux) => {
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("goal_complete", { goal_id: "not-active", summary: "Ordinary work finished." })], { stopReason: "toolUse" }),
        "The inactive Goal tool was rejected.",
      ]);
      await session.prompt("Test the inactive Goal guard.");
      const result = session.messages.find(message => message.role === "toolResult" && message.toolName === "goal_complete");
      expect(result?.content).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("no active goal") })]));
      expect(latestGoal(session.sessionManager)).toBeUndefined();
    });
  });

  it("rejects a stale id before completing the real SDK Goal with preserved session state", async () => {
    await withSession(async (session, faux) => {
      let goalId: string | undefined;
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("goal_complete", { goal_id: "stale-goal", summary: "All requirements verified." })], { stopReason: "toolUse" }),
        context => {
        const goal = latestGoal(session.sessionManager);
        expect(goal.status).toBe("active");
        goalId = goal.id;
        expect(getCurrentTools(context.messages).map(tool => tool.name)).toContain("goal_complete");
        return fauxAssistantMessage([fauxToolCall("goal_complete", {
          goal_id: goalId, summary: "Verified the integrated registrar, parent-only scope, and persisted Goal lifecycle with real SDK tests.",
        })], { stopReason: "toolUse" });
      }]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe = () => {};
      const ended = new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Goal turn did not settle")), 20_000);
        unsubscribe = session.subscribe(event => {
          if (event.type === "agent_end") resolve();
        });
      });
      try {
        const runner = session.extensionRunner!;
        const command = runner.getCommand("goal");
        expect(command).toBeDefined();
        await command!.handler("Verify Toolkit Goal integration", runner.createCommandContext());
        await ended;
        expect(goalId).toBeTruthy();
        const states = session.sessionManager.getEntries().filter(entry => entry.type === "custom" && entry.customType === "goal-state");
        expect(states.map(entry => (entry as any).data?.goal)).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: goalId, status: "complete", text: "Verify Toolkit Goal integration" }),
        ]));
        expect(latestGoal(session.sessionManager)).toBeNull();
        const results = session.messages.filter(message => message.role === "toolResult" && message.toolName === "goal_complete");
        expect(results).toHaveLength(2);
        expect(results[0].content).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("goal_id does not match the active goal") })]));
        expect(results[1].content).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("Goal complete:") })]));
      } finally {
        clearTimeout(timer);
        unsubscribe();
      }
    });
  });
});
