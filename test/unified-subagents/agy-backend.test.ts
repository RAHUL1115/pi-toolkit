import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { BackendRunOptions, SubagentSession } from "../../pi-toolkit-lib/unified-subagents/backend.js";
import {
  createAgyBackend,
  resolveAgyExecutable,
} from "../../pi-toolkit-lib/unified-subagents/backends/agy.js";
import { DEFAULT_AGENTS } from "../../pi-toolkit-lib/unified-subagents/default-agents.js";
import type { AgentConfig } from "../../pi-toolkit-lib/unified-subagents/types.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-agy.mjs", import.meta.url));
const ctx = { cwd: process.cwd(), getSystemPrompt: () => "parent system prompt" } as ExtensionContext;
const pi = {} as ExtensionAPI;

function spawnFixture(_executable: string, args: string[], cwd: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [fixture, ...args], {
    cwd,
    env: { ...process.env, NO_BROWSER: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

function backend() {
  return createAgyBackend({
    resolveExecutable: () => fixture,
    spawnCli: spawnFixture,
    stopTimeoutMs: 250,
  });
}

function options(overrides: Partial<BackendRunOptions> = {}): BackendRunOptions {
  return { pi, trusted: true, ...overrides };
}

const config = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  name: "agy-test",
  description: "Agy test",
  systemPrompt: "Use Agy.",
  promptMode: "replace",
  ...overrides,
});

describe("Agy backend", () => {
  it("streams text, tools, usage, and native options", async () => {
    const onTextDelta = vi.fn();
    const onToolActivity = vi.fn();
    const onAssistantUsage = vi.fn();
    let session: SubagentSession | undefined;

    const result = await backend().run(ctx, "general-purpose", "do work", options({
      agentConfig: DEFAULT_AGENTS.get("general-purpose"),
      modelHint: "gemini-3-flash",
      thinkingLevel: "high",
      onTextDelta,
      onToolActivity,
      onAssistantUsage,
      onSessionCreated: created => { session = created; },
    }));

    expect(result).toMatchObject({
      responseText: "agy done (gemini-3-flash, high, accept-edits)",
      aborted: false,
      steered: false,
    });
    expect(onTextDelta).toHaveBeenCalledWith(
      "agy done (gemini-3-flash, high, accept-edits)",
      "agy done (gemini-3-flash, high, accept-edits)",
    );
    expect(onToolActivity.mock.calls).toEqual([
      [{ type: "start", toolName: "read_file" }],
      [{ type: "end", toolName: "read_file" }],
    ]);
    expect(onAssistantUsage).toHaveBeenCalledWith({ input: 10, output: 5, cacheWrite: 0 });
    expect(session?.messages.map(message => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect(session?.getSessionStats()).toEqual({
      tokens: { input: 10, output: 5, cacheWrite: 0 },
      contextUsage: { percent: null },
    });
  });

  it("queues steering on the same stream-json conversation", async () => {
    let session: SubagentSession | undefined;
    let ready!: () => void;
    const sawReady = new Promise<void>(resolve => { ready = resolve; });
    const run = backend().run(ctx, "general-purpose", "wait for steer", options({
      onSessionCreated: created => { session = created; },
      onTextDelta: (_delta, fullText) => {
        if (fullText.includes("ready")) ready();
      },
    }));

    await sawReady;
    await session?.steer("change direction");
    const result = await run;

    expect(result).toMatchObject({ responseText: "steered: change direction", steered: true });
    expect(session?.messages.some(message => message.role === "user" && message.content === "change direction")).toBe(true);
  });

  it("stops an active Agy process on abort", async () => {
    const controller = new AbortController();
    let waiting!: () => void;
    const sawWaiting = new Promise<void>(resolve => { waiting = resolve; });
    const run = backend().run(ctx, "general-purpose", "wait for cancel", options({
      signal: controller.signal,
      onTextDelta: () => waiting(),
    }));

    await sawWaiting;
    controller.abort();
    const result = await run;

    expect(result).toMatchObject({ responseText: "waiting", aborted: true, steered: false });
  });

  it("maps read-only agents to plan mode", async () => {
    const result = await backend().run(ctx, "reviewer", "do work", options({
      agentConfig: config({ builtinToolNames: ["read", "bash", "grep", "find", "ls"] }),
    }));

    expect(result.responseText).toContain("plan");
  });

  it("rejects unsafe or unsupported native options", async () => {
    await expect(backend().run(ctx, "general-purpose", "work", options({ trusted: false })))
      .rejects.toThrow("explicitly trusted");
    await expect(backend().run(ctx, "general-purpose", "work", options({ maxTurns: 2 })))
      .rejects.toThrow("max turns");
    await expect(backend().run(ctx, "general-purpose", "work", options({ inheritContext: true })))
      .rejects.toThrow("inherited parent context");
    await expect(backend().run(ctx, "general-purpose", "work", options({ thinkingLevel: "xhigh" })))
      .rejects.toThrow("low, medium, or high");
    await expect(backend().run(ctx, "general-purpose", "work", options({
      agentConfig: config({ builtinToolNames: ["read", "edit"] }),
    }))).rejects.toThrow("read-only tool profile");
    await expect(backend().run(ctx, "general-purpose", "work", options({
      agentConfig: config({ extensions: ["foo"], extensionsExplicit: true }),
    }))).rejects.toThrow("extension/MCP tool selections");
  });

  it("finds the standard Windows install before PATH", () => {
    const checked: string[] = [];
    const result = resolveAgyExecutable({
      platform: "win32",
      homeDirectory: "C:\\Users\\test",
      localAppData: "C:\\Users\\test\\AppData\\Local",
      pathValue: "C:\\bin",
      isExecutable: file => {
        checked.push(file);
        return file.endsWith("AppData\\Local\\agy\\bin\\agy.exe");
      },
    });

    expect(result).toBe("C:\\Users\\test\\AppData\\Local\\agy\\bin\\agy.exe");
    expect(checked).toHaveLength(1);
  });
});
