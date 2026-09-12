import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentSession, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../pi-toolkit-lib/unified-subagents/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../../pi-toolkit-lib/unified-subagents/agent-runner.js")>("../../pi-toolkit-lib/unified-subagents/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

vi.mock("../../pi-toolkit-lib/unified-subagents/backends/agy.js", () => ({
  agyBackend: {
    harness: "agy",
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

import { runAgent } from "../../pi-toolkit-lib/unified-subagents/agent-runner.js";
import type { SubagentSession } from "../../pi-toolkit-lib/unified-subagents/backend.js";
import { agyBackend } from "../../pi-toolkit-lib/unified-subagents/backends/agy.js";
import { claudeBackend } from "../../pi-toolkit-lib/unified-subagents/backends/claude.js";
import { codexBackend } from "../../pi-toolkit-lib/unified-subagents/backends/codex.js";
import { resolveAgyModelHint, resolveClaudeModelHint, resolveCodexModelHint } from "../../pi-toolkit-lib/unified-subagents/harness-resolution.js";
import { getLightModelChoices, registerUnifiedSubagents as subagentsExtension } from "../../pi-toolkit-lib/unified-subagents/index.js";

function session(): SubagentSession {
  return {
    messages: [],
    subscribe: vi.fn(() => vi.fn()),
    steer: vi.fn(async () => {}),
    getSessionStats: vi.fn(() => ({
      tokens: { input: 0, output: 0, cacheWrite: 0 },
      contextUsage: { percent: 0 },
    })),
    dispose: vi.fn(),
  };
}

type ToolResult = { content: Array<{ type: "text"; text: string }> };
type RegisteredTool = {
  name: string;
  parameters: { properties: { harness: { anyOf: Array<{ const: string }> } } };
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ExtensionContext,
  ): Promise<ToolResult>;
};
type RegisteredCommand = { handler(args: string, ctx: ExtensionCommandContext): Promise<void> | void };
type LifecycleHandler = (...args: unknown[]) => unknown;

function makePi() {
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, RegisteredCommand>();
  const lifecycle = new Map<string, LifecycleHandler>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    registerTool: vi.fn((tool: unknown) => {
      const registered = tool as RegisteredTool;
      tools.set(registered.name, registered);
    }),
    registerCommand: vi.fn((name: string, command: RegisteredCommand) => commands.set(name, command)),
    on: vi.fn((event: string, handler: LifecycleHandler) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  };
  return { pi, tools, commands, lifecycle };
}

function makeCtx(cwd: string, trusted = true, uiOverrides: Record<string, unknown> = {}): ExtensionContext {
  return {
    hasUI: false,
    mode: "print",
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn(), ...uiOverrides },
    cwd,
    model: { provider: "parent-provider", id: "parent-model", name: "Parent Model" },
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "session-1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent prompt that Claude must not receive"),
    isProjectTrusted: vi.fn(() => trusted),
  } as unknown as ExtensionContext;
}

const textOf = (result: ToolResult): string => result.content[0].text;
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

it("builds sorted, deduplicated full model choices and retains an unavailable current value", () => {
  const registry = {
    getAvailable: () => [
      { provider: "zeta", id: "model-2" },
      { provider: "alpha", id: "model-1" },
      { provider: "alpha", id: "model-1" },
    ],
    getAll: () => [],
    find: vi.fn(),
  };
  expect(getLightModelChoices(registry, "missing/current")).toEqual([
    "alpha/model-1",
    "missing/current",
    "zeta/model-2",
  ]);
});

describe("Agent tool harness routing", () => {
  let cwd: string;
  let agentDir: string;
  let previousCwd: string;
  let previousAgentDir: string | undefined;
  let previousHome: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-harness-cwd-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-harness-agent-"));
    previousCwd = process.cwd();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    previousHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "subagents.json"),
      JSON.stringify({ schedulingEnabled: false, defaultJoinMode: "async", outputTranscript: false }),
    );
    process.chdir(cwd);

    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      const created = session() as unknown as AgentSession;
      options.onSessionCreated?.(created);
      return { responseText: "pi done", session: created, aborted: false, steered: false };
    });
    vi.mocked(agyBackend.run).mockImplementation(async (_ctx, _type, _prompt, options) => {
      const created = session();
      options.onSessionCreated?.(created);
      options.onTextDelta?.("agy done", "agy done");
      options.onTurnEnd?.(1);
      return { responseText: "agy done", session: created, aborted: false, steered: false };
    });
    vi.mocked(claudeBackend.run).mockImplementation(async (_ctx, _type, _prompt, options) => {
      const created = session();
      options.onSessionCreated?.(created);
      options.onTextDelta?.("claude done", "claude done");
      options.onTurnEnd?.(1);
      return { responseText: "claude done", session: created, aborted: false, steered: false };
    });
    vi.mocked(codexBackend.run).mockImplementation(async (_ctx, _type, _prompt, options) => {
      const created = session();
      options.onSessionCreated?.(created);
      options.onTextDelta?.("codex done", "codex done");
      options.onTurnEnd?.(1);
      return { responseText: "codex done", session: created, aborted: false, steered: false };
    });
  });

  afterEach(() => {
    process.chdir(previousCwd);
    if (previousAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousHome == null) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("exposes harness in the existing schema and defaults omitted calls to Pi", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi as unknown as ExtensionAPI);
    const agent = tools.get("Agent");

    expect(agent.parameters.properties.harness.anyOf.map(entry => entry.const)).toEqual(["pi", "claude", "codex", "agy"]);
    const result = await agent.execute(
      "tool-call",
      { prompt: "work", description: "Do work", subagent_type: "general-purpose", run_in_background: false },
      undefined,
      undefined,
      makeCtx(cwd),
    );

    expect(textOf(result)).toContain("pi done");
    expect(runAgent).toHaveBeenCalledOnce();
    expect(claudeBackend.run).not.toHaveBeenCalled();
    await lifecycle.get("session_shutdown")?.({}, makeCtx(cwd));
  });

  it("initializes one light model from the current provider on session start", async () => {
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi as unknown as ExtensionAPI);
    const context = makeCtx(cwd) as any;
    context.model = { provider: "anthropic", id: "claude-sonnet-4-6", name: "Sonnet" };
    context.modelRegistry = {
      getAvailable: () => [
        { provider: "anthropic", id: "claude-haiku-4-5" },
        { provider: "anthropic", id: "claude-sonnet-4-5" },
        { provider: "anthropic", id: "claude-haiku-4-6" },
        { provider: "anthropic", id: "claude-sonnet-4-6" },
      ],
      find: vi.fn(),
    };

    await lifecycle.get("session_start")?.({}, context);

    expect(JSON.parse(readFileSync(join(agentDir, "subagents.json"), "utf-8"))).toEqual({
      lightModel: "anthropic/claude-sonnet-4-6",
      lightThinking: "low",
    });
    expect(context.ui.notify).toHaveBeenCalledWith(
      "Light model initialized. Use /reload to refresh Agent guidance.",
      "info",
    );
    await lifecycle.get("session_shutdown")?.({}, context);
  });

  it("lets caller model and thinking select a light model for read-only Explore", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi as unknown as ExtensionAPI);
    const agent = tools.get("Agent");
    const model = { provider: "openai-codex", id: "gpt-5.6-sol", name: "Sol" };
    const context = makeCtx(cwd) as any;
    context.modelRegistry = {
      find: vi.fn(() => model),
      getAvailable: vi.fn(() => [model]),
      getAll: vi.fn(() => [model]),
    };

    await agent.execute(
      "explore-light",
      {
        prompt: "find files",
        description: "Find relevant files",
        subagent_type: "Explore",
        model: "openai-codex/gpt-5.6-sol",
        thinking: "low",
      },
      undefined,
      undefined,
      context,
    );

    expect(runAgent).toHaveBeenCalledWith(
      expect.anything(),
      "Explore",
      "find files",
      expect.objectContaining({
        model,
        thinkingLevel: "low",
        agentConfig: expect.objectContaining({
          builtinToolNames: ["read", "bash", "grep", "find", "ls"],
        }),
      }),
    );
    expect(vi.mocked(runAgent).mock.calls[0][3].agentConfig?.model).toBeUndefined();
    await lifecycle.get("session_shutdown")?.({}, context);
  });

  it("routes foreground and background Claude runs with raw model/config/trust", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi as unknown as ExtensionAPI);
    const agent = tools.get("Agent");

    const foreground = await agent.execute(
      "foreground",
      {
        prompt: "native work",
        description: "Run native work",
        subagent_type: "general-purpose",
        harness: "claude",
        model: "anthropic/sonnet",
        run_in_background: false,
      },
      undefined,
      undefined,
      makeCtx(cwd),
    );
    expect(textOf(foreground)).toContain("claude done");
    expect(claudeBackend.run).toHaveBeenLastCalledWith(
      expect.anything(),
      "general-purpose",
      "native work",
      expect.objectContaining({
        model: undefined,
        modelHint: "sonnet",
        trusted: true,
        agentConfig: expect.objectContaining({ name: "general-purpose" }),
      }),
    );

    vi.useFakeTimers();
    const background = await agent.execute(
      "background",
      {
        prompt: "native background",
        description: "Run native background",
        subagent_type: "general-purpose",
        harness: "claude",
        run_in_background: true,
      },
      undefined,
      undefined,
      makeCtx(cwd),
    );
    expect(textOf(background)).toContain("Harness: claude");
    expect(claudeBackend.run).toHaveBeenLastCalledWith(
      expect.anything(),
      "general-purpose",
      "native background",
      expect.objectContaining({ model: undefined, modelHint: undefined }),
    );
    await flush();
    await vi.advanceTimersByTimeAsync(200);
    expect(pi.sendMessage).toHaveBeenCalled();
    expect(pi.events.emit).toHaveBeenCalledWith(
      "subagents:created",
      expect.objectContaining({ harness: "claude", isBackground: true }),
    );
    expect(pi.events.emit).toHaveBeenCalledWith(
      "subagents:completed",
      expect.objectContaining({ harness: "claude" }),
    );
    await lifecycle.get("session_shutdown")?.({}, makeCtx(cwd));
  });

  it("routes Codex through ACP with native model and thinking controls", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi as unknown as ExtensionAPI);
    const agent = tools.get("Agent");

    const result = await agent.execute(
      "codex",
      {
        prompt: "native ACP work",
        description: "Run Codex work",
        subagent_type: "general-purpose",
        harness: "codex",
        model: "openai/gpt-5.4",
        thinking: "high",
        run_in_background: false,
      },
      undefined,
      undefined,
      makeCtx(cwd),
    );

    expect(textOf(result)).toContain("codex done");
    expect(codexBackend.run).toHaveBeenCalledWith(
      expect.anything(),
      "general-purpose",
      "native ACP work",
      expect.objectContaining({
        model: undefined,
        modelHint: "gpt-5.4",
        thinkingLevel: "high",
        trusted: true,
      }),
    );
    expect(runAgent).not.toHaveBeenCalled();
    expect(claudeBackend.run).not.toHaveBeenCalled();
    await lifecycle.get("session_shutdown")?.({}, makeCtx(cwd));
  });

  it("routes Agy through stream-json with native model and effort controls", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi as unknown as ExtensionAPI);
    const agent = tools.get("Agent");

    const result = await agent.execute(
      "agy",
      {
        prompt: "native Antigravity work",
        description: "Run Agy work",
        subagent_type: "general-purpose",
        harness: "agy",
        model: "agy/gemini-3-flash",
        thinking: "medium",
        run_in_background: false,
      },
      undefined,
      undefined,
      makeCtx(cwd),
    );

    expect(textOf(result)).toContain("agy done");
    expect(agyBackend.run).toHaveBeenCalledWith(
      expect.anything(),
      "general-purpose",
      "native Antigravity work",
      expect.objectContaining({
        model: undefined,
        modelHint: "gemini-3-flash",
        thinkingLevel: "medium",
        trusted: true,
        maxTurns: undefined,
      }),
    );
    expect(runAgent).not.toHaveBeenCalled();
    expect(claudeBackend.run).not.toHaveBeenCalled();
    expect(codexBackend.run).not.toHaveBeenCalled();
    await lifecycle.get("session_shutdown")?.({}, makeCtx(cwd));
  });

  it("normalizes cross-extension Codex spawns at the authoritative boundary", async () => {
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi as unknown as ExtensionAPI);
    const registry = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    const context = makeCtx(cwd);

    registry.spawn(pi, context, "general-purpose", "RPC native work", {
      description: "RPC Codex work",
      harness: "codex",
      model: "openai/gpt-5.4",
      thinking: "high",
      trusted: false,
      agentConfig: { harness: "pi" },
      modelHint: "forged",
    });
    await flush();

    expect(codexBackend.run).toHaveBeenCalledWith(
      expect.anything(),
      "general-purpose",
      "RPC native work",
      expect.objectContaining({
        model: undefined,
        modelHint: "gpt-5.4",
        thinkingLevel: "high",
        trusted: true,
        agentConfig: expect.objectContaining({ name: "general-purpose" }),
      }),
    );
    expect(() => registry.spawn(pi, context, "general-purpose", "bad", {
      description: "Bad harness",
      harness: "unknown",
    })).toThrow("Unknown subagent harness");
    await lifecycle.get("session_shutdown")?.({}, context);
  });

  it("opens `/agents` conversations with full-screen overlay options", async () => {
    const { pi, tools, commands, lifecycle } = makePi();
    subagentsExtension(pi as unknown as ExtensionAPI);
    const agent = tools.get("Agent");
    if (!agent) throw new Error("Agent tool was not registered");

    await agent.execute(
      "background",
      {
        prompt: "work",
        description: "Open conversation",
        subagent_type: "general-purpose",
        run_in_background: true,
      },
      undefined,
      undefined,
      makeCtx(cwd),
    );
    await flush();

    let selectCount = 0;
    let overlayOptions: unknown;
    type OverlayFactory = (
      tui: { terminal: { rows: number; columns: number }; requestRender(): void },
      theme: { fg(color: string, text: string): string; bold(text: string): string },
      keybindings: undefined,
      done: (result: undefined) => void,
    ) => { dispose?(): void };
    const commandCtx = makeCtx(cwd, true, {
      select: vi.fn(async (_title: string, options: string[]) => {
        selectCount++;
        if (selectCount === 1) return options.find(option => option.startsWith("Running agents ("));
        if (selectCount === 2) return options[0];
        return undefined;
      }),
      custom: vi.fn(async (factory: OverlayFactory, options: unknown) => {
        overlayOptions = options;
        const component = factory(
          { terminal: { rows: 40, columns: 120 }, requestRender: vi.fn() },
          { fg: (_color, text) => text, bold: text => text },
          undefined,
          () => {},
        );
        component.dispose?.();
        return undefined;
      }),
    });

    const command = commands.get("agents");
    if (!command) throw new Error("agents command was not registered");
    await command.handler("", commandCtx as unknown as ExtensionCommandContext);

    expect(overlayOptions).toEqual({
      overlay: true,
      overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
    });
    await lifecycle.get("session_shutdown")?.({}, makeCtx(cwd));
  });

  it("wires one global light model through `/agents` Settings", async () => {
    initTheme(undefined, false);
    const { pi, commands, lifecycle } = makePi();
    subagentsExtension(pi as unknown as ExtensionAPI);

    let selectCount = 0;
    let rendered = "";
    type SettingsFactory = (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
      done: (result: string | undefined) => void,
    ) => { render(width: number): string[]; handleInput?(data: string): void };
    const commandCtx = makeCtx(cwd, true, {
      select: vi.fn(async (_title: string, options: string[]) => {
        selectCount++;
        return selectCount === 1 ? options.find(option => option === "Settings") : undefined;
      }),
      custom: vi.fn(async (factory: SettingsFactory) => {
        const component = factory({}, {}, {}, () => {});
        rendered = component.render(160).join("\n");
        // maxConcurrentForeground adds one numeric row before the Light settings.
        for (let i = 0; i < 5; i++) component.handleInput?.("\x1b[B");
        component.handleInput?.("\r");
        component.handleInput?.("\x1b[B");
        component.handleInput?.("\r");
        return undefined;
      }),
    }) as unknown as ExtensionCommandContext & {
      modelRegistry: { getAvailable(): Array<{ provider: string; id: string }> };
    };
    commandCtx.modelRegistry = {
      getAvailable: () => [
        { provider: "openai-codex", id: "gpt-5.6-luna" },
        { provider: "zeta", id: "next" },
      ],
    };

    const command = commands.get("agents");
    if (!command) throw new Error("agents command was not registered");
    await command.handler("", commandCtx);

    expect(rendered).toContain("Light model");
    expect(rendered).not.toContain("Economy model");
    expect(rendered).not.toContain("Fast model");
    expect(rendered).toContain("Light thinking");
    expect(JSON.parse(readFileSync(join(agentDir, "subagents.json"), "utf-8"))).toEqual({
      lightModel: "zeta/next",
      lightThinking: "medium",
    });
    expect(JSON.parse(readFileSync(join(cwd, ".pi", "subagents.json"), "utf-8"))).not.toHaveProperty("lightModel");
    await lifecycle.get("session_shutdown")?.({}, makeCtx(cwd));
  });

  it("lets custom-agent frontmatter override the tool harness", async () => {
    writeFileSync(join(cwd, ".pi", "agents", "native.md"), `---
description: Native agent
harness: claude
model: anthropic/claude-opus-native
output_transcript: false
---

Use the configured prompt.`);
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi as unknown as ExtensionAPI);

    await tools.get("Agent").execute(
      "tool-call",
      {
        prompt: "work",
        description: "Do native work",
        subagent_type: "native",
        harness: "pi",
        model: "other/ignored",
      },
      undefined,
      undefined,
      makeCtx(cwd),
    );

    expect(claudeBackend.run).toHaveBeenCalledWith(
      expect.anything(),
      "native",
      "work",
      expect.objectContaining({ modelHint: "claude-opus-native" }),
    );
    expect(runAgent).not.toHaveBeenCalled();
    await lifecycle.get("session_shutdown")?.({}, makeCtx(cwd));
  });

  it("rejects unsupported, untrusted, and foreign-provider Claude calls before the backend", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi as unknown as ExtensionAPI);
    const agent = tools.get("Agent");
    const base = {
      prompt: "work",
      description: "Do native work",
      subagent_type: "general-purpose",
      harness: "claude",
    };

    for (const [field, value] of [
      ["schedule", "+1m"],
      ["resume", "agent-id"],
      ["isolation", "worktree"],
      ["inherit_context", true],
      ["isolated", true],
    ] as const) {
      const result = await agent.execute("tool-call", { ...base, [field]: value }, undefined, undefined, makeCtx(cwd));
      expect(textOf(result)).toContain("does not support");
    }

    const untrusted = await agent.execute("tool-call", base, undefined, undefined, makeCtx(cwd, false));
    expect(textOf(untrusted)).toContain("working directory to be trusted");

    const provider = await agent.execute(
      "tool-call",
      { ...base, model: "openai/gpt-5" },
      undefined,
      undefined,
      makeCtx(cwd),
    );
    expect(textOf(provider)).toContain("only accepts native model IDs");
    expect(claudeBackend.run).not.toHaveBeenCalled();
    await lifecycle.get("session_shutdown")?.({}, makeCtx(cwd));
  });

  it("rejects unsupported and invalid Codex options before ACP startup", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi as unknown as ExtensionAPI);
    const agent = tools.get("Agent");
    const base = {
      prompt: "work",
      description: "Do Codex work",
      subagent_type: "general-purpose",
      harness: "codex",
    };

    for (const [field, value] of [
      ["schedule", "+1m"],
      ["resume", "agent-id"],
      ["inherit_context", true],
      ["isolated", true],
      ["max_turns", 2],
    ] as const) {
      const result = await agent.execute("tool-call", { ...base, [field]: value }, undefined, undefined, makeCtx(cwd));
      expect(textOf(result)).toContain("does not support");
    }

    const thinking = await agent.execute(
      "thinking",
      { ...base, thinking: "minimal" },
      undefined,
      undefined,
      makeCtx(cwd),
    );
    expect(textOf(thinking)).toContain("supports low, medium, high, xhigh, or max");
    const untrusted = await agent.execute("untrusted", base, undefined, undefined, makeCtx(cwd, false));
    expect(textOf(untrusted)).toContain("working directory to be trusted");
    const provider = await agent.execute(
      "provider",
      { ...base, model: "anthropic/claude" },
      undefined,
      undefined,
      makeCtx(cwd),
    );
    expect(textOf(provider)).toContain("only accepts native model IDs");
    expect(codexBackend.run).not.toHaveBeenCalled();
    await lifecycle.get("session_shutdown")?.({}, makeCtx(cwd));
  });

  it("normalizes native harness aliases without consulting Pi models", () => {
    expect(resolveClaudeModelHint()).toBeUndefined();
    expect(resolveClaudeModelHint("sonnet")).toBe("sonnet");
    expect(resolveClaudeModelHint("anthropic/claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(() => resolveClaudeModelHint("google/gemini")).toThrow("only accepts native model IDs");
    expect(resolveCodexModelHint()).toBeUndefined();
    expect(resolveCodexModelHint("gpt-5.4")).toBe("gpt-5.4");
    expect(resolveCodexModelHint("openai/gpt-5.4")).toBe("gpt-5.4");
    expect(() => resolveCodexModelHint("anthropic/claude")).toThrow("only accepts native model IDs");
    expect(resolveAgyModelHint()).toBeUndefined();
    expect(resolveAgyModelHint("gemini-3-flash")).toBe("gemini-3-flash");
    expect(resolveAgyModelHint("agy/gemini-3-flash")).toBe("gemini-3-flash");
    expect(() => resolveAgyModelHint("google/gemini")).toThrow("only accepts native model IDs");
  });
});
