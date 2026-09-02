import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { BackendRunOptions, SubagentSession } from "../../pi-toolkit-lib/unified-subagents/backend.js";
import { createCodexBackend } from "../../pi-toolkit-lib/unified-subagents/backends/codex.js";
import { DEFAULT_AGENTS } from "../../pi-toolkit-lib/unified-subagents/default-agents.js";
import type { AgentConfig } from "../../pi-toolkit-lib/unified-subagents/types.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-codex-acp.mjs", import.meta.url));
const ctx = { cwd: process.cwd(), getSystemPrompt: () => "parent system prompt" } as ExtensionContext;
const pi = {} as ExtensionAPI;

function spawnFixture(entry: string, cwd: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [entry], {
    cwd,
    env: { ...process.env, NO_BROWSER: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

function backend(spawnAdapter = spawnFixture) {
  return createCodexBackend({
    resolveAdapter: () => fixture,
    spawnAdapter,
    cancelTimeoutMs: 250,
  });
}

function options(overrides: Partial<BackendRunOptions> = {}): BackendRunOptions {
  return { pi, trusted: true, ...overrides };
}

describe("Codex ACP backend", () => {
  it("streams ACP text, thought, tools, usage, and native config", async () => {
    const onTextDelta = vi.fn();
    const onToolActivity = vi.fn();
    const onAssistantUsage = vi.fn();
    let session: SubagentSession | undefined;

    const result = await backend().run(ctx, "general-purpose", "do work", options({
      agentConfig: DEFAULT_AGENTS.get("general-purpose"),
      modelHint: "gpt-5.4-mini",
      thinkingLevel: "high",
      onTextDelta,
      onToolActivity,
      onAssistantUsage,
      onSessionCreated: created => { session = created; },
    }));

    expect(result.responseText).toBe("codex done (gpt-5.4-mini, high)");
    expect(result).toMatchObject({ aborted: false, steered: false, failure: undefined });
    expect(onTextDelta).toHaveBeenCalledWith(
      "codex done (gpt-5.4-mini, high)",
      "codex done (gpt-5.4-mini, high)",
    );
    expect(onToolActivity.mock.calls).toEqual([
      [{ type: "start", toolName: "read" }],
      [{ type: "end", toolName: "read" }],
    ]);
    expect(onAssistantUsage).toHaveBeenCalledWith({ input: 10, output: 5, cacheWrite: 2 });
    expect(session?.messages.map(message => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect(session?.getSessionStats()).toEqual({
      tokens: { input: 10, output: 5, cacheWrite: 2 },
      contextUsage: { percent: 50 },
    });
  });

  it("steers through the adapter extension only when injected into the active turn", async () => {
    let session: SubagentSession | undefined;
    let ready: (() => void) | undefined;
    const sawReady = new Promise<void>(resolve => { ready = resolve; });
    const run = backend().run(ctx, "general-purpose", "wait for steer", options({
      onSessionCreated: created => { session = created; },
      onTextDelta: (_delta, fullText) => {
        if (fullText.includes("ready")) ready?.();
      },
    }));

    await sawReady;
    await expect(session?.steer("fail steering")).rejects.toThrow("failed");
    expect(session?.messages.some(message => message.role === "user" && message.content === "fail steering")).toBe(false);
    await expect(session?.steer("late steering")).rejects.toThrow("active turn");
    expect(session?.messages.some(message => message.role === "user" && message.content === "late steering")).toBe(false);
    await session?.steer("change direction");
    const result = await run;

    expect(result.steered).toBe(true);
    expect(result.responseText).toContain("ready");
    expect(result.responseText).toContain("steered: change direction");
    expect(session?.messages.some(message => message.role === "user" && message.content === "change direction")).toBe(true);
  });

  it("passes parent-twin and worktree safety instructions through the Codex prompt", async () => {
    const result = await backend().run(ctx, "general-purpose", "do work", options({
      agentConfig: DEFAULT_AGENTS.get("general-purpose"),
      worktreeBase: "C:/parent/repo",
    }));

    expect(result.responseText).toContain("worktree-safe");
  });

  it("closes the ACP session before tearing down the adapter", async () => {
    let stderr = "";
    const result = await backend((entry, cwd) => {
      const child = spawnFixture(entry, cwd);
      child.stderr.on("data", chunk => { stderr += String(chunk); });
      return child;
    }).run(ctx, "general-purpose", "do work", options());

    expect(result.responseText).toContain("codex done");
    expect(stderr).toContain("session-close");
  });

  it("disposes a completed session without throwing", async () => {
    const result = await backend().run(ctx, "general-purpose", "do work", options());

    expect(() => result.session.dispose()).not.toThrow();
  });

  it("fails closed when the adapter cannot grant one-time permission", async () => {
    const result = await backend().run(ctx, "general-purpose", "permission always", options());
    const toolResult = result.session.messages.find(message => message.role === "toolResult");

    expect(toolResult?.role === "toolResult" && toolResult.isError).toBe(true);
  });

  it("does not submit a prompt when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await backend().run(ctx, "general-purpose", "must not run", options({ signal: controller.signal }));

    expect(result).toMatchObject({ responseText: "", aborted: true, steered: false });
    expect(result.session.messages.map(message => message.role)).toEqual(["user"]);
  });

  it("cancels an active ACP prompt", async () => {
    const controller = new AbortController();
    let waiting: (() => void) | undefined;
    const sawWaiting = new Promise<void>(resolve => { waiting = resolve; });
    const run = backend().run(ctx, "general-purpose", "wait for cancel", options({
      signal: controller.signal,
      onTextDelta: () => waiting?.(),
    }));

    await sawWaiting;
    controller.abort();
    const result = await run;

    expect(result.aborted).toBe(true);
    expect(result.responseText).toBe("waiting");
  });

  it("accepts omitted Pi capability fields but rejects explicit Pi selections", async () => {
    const implicitConfig: AgentConfig = {
      name: "native",
      description: "Native defaults",
      builtinToolNames: ["read", "bash", "edit", "write", "grep", "find", "ls"],
      extensions: true,
      skills: true,
      systemPrompt: "Use native Codex.",
      promptMode: "replace",
    };
    const result = await backend().run(ctx, "native", "do work", options({ agentConfig: implicitConfig }));
    expect(result.responseText).toContain("codex done");

    await expect(backend().run(ctx, "native", "do work", options({
      agentConfig: { ...implicitConfig, extensionsExplicit: true },
    }))).rejects.toThrow("extension/MCP tool selections");
    await expect(backend().run(ctx, "native", "do work", options({
      agentConfig: { ...implicitConfig, skillsExplicit: true },
    }))).rejects.toThrow("explicit Pi skill selections");
  });

  it("rejects untrusted runs and unsupported options before startup", async () => {
    const config = (overrides: Partial<AgentConfig>): AgentConfig => ({
      name: "restricted",
      description: "restricted",
      systemPrompt: "",
      promptMode: "replace",
      ...overrides,
    });

    await expect(backend().run(ctx, "general-purpose", "work", options({ trusted: false })))
      .rejects.toThrow("explicitly trusted");
    await expect(backend().run(ctx, "general-purpose", "work", options({ maxTurns: 2 })))
      .rejects.toThrow("does not support max turns");
    await expect(backend().run(ctx, "general-purpose", "work", options({ inheritContext: true })))
      .rejects.toThrow("inherited parent context");
    await expect(backend().run(ctx, "general-purpose", "work", options({ isolated: true })))
      .rejects.toThrow("hermetic isolation");
    await expect(backend().run(ctx, "general-purpose", "work", options({
      agentConfig: config({ builtinToolNames: ["read"] }),
    }))).rejects.toThrow("partial Pi `tools:` allowlists");
    await expect(backend().run(ctx, "general-purpose", "work", options({
      agentConfig: config({ disallowedTools: ["write"] }),
    }))).rejects.toThrow("does not support `disallowed_tools`");
    await expect(backend().run(ctx, "general-purpose", "work", options({
      agentConfig: config({ extSelectors: ["ext:foo"] }),
    }))).rejects.toThrow("extension/MCP tool selections");
    await expect(backend().run(ctx, "general-purpose", "work", options({
      agentConfig: config({ skills: ["review"] }),
    }))).rejects.toThrow("explicit Pi skill selections");
    await expect(backend().run(ctx, "general-purpose", "work", options({
      agentConfig: config({ memory: "project" }),
    }))).rejects.toThrow("Pi agent memory");
    await expect(backend().run(ctx, "general-purpose", "work", options({
      agentConfig: config({ persistSession: true }),
    }))).rejects.toThrow("Pi session persistence");
  });
});
