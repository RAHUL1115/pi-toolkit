import {
  type Options as ClaudeSdkOptions,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendRunOptions, SubagentSession } from "../../pi-toolkit-lib/unified-subagents/backend.js";
import { CLAUDE_THINKING_BUDGETS, createClaudeBackend } from "../../pi-toolkit-lib/unified-subagents/backends/claude.js";
import type { AgentConfig } from "../../pi-toolkit-lib/unified-subagents/types.js";

type FakeStep = { result: IteratorResult<SDKMessage> } | { error: Error };

class FakeQuery implements AsyncIterable<SDKMessage> {
  private pending: FakeStep[] = [];
  private waiters: Array<{
    resolve: (result: IteratorResult<SDKMessage>) => void;
    reject: (error: Error) => void;
  }> = [];
  interrupt = vi.fn<() => Promise<{ still_queued: string[] } | undefined>>(async () => undefined);
  close = vi.fn(() => this.end());

  push(message: unknown): void {
    this.deliver({ result: { value: message as SDKMessage, done: false } });
  }

  fail(error: Error): void {
    this.deliver({ error });
  }

  end(): void {
    this.deliver({ result: { value: undefined, done: true } });
  }

  private deliver(step: FakeStep): void {
    const waiter = this.waiters.shift();
    if (!waiter) {
      this.pending.push(step);
    } else if ("error" in step) {
      waiter.reject(step.error);
    } else {
      waiter.resolve(step.result);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        const pending = this.pending.shift();
        if (pending) {
          return "error" in pending ? Promise.reject(pending.error) : Promise.resolve(pending.result);
        }
        return new Promise<IteratorResult<SDKMessage>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}

const ctx = { cwd: "C:\\work" } as ExtensionContext;
const pi = {} as ExtensionAPI;

function assistant(
  content: unknown[],
  usage = {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 20,
    cache_creation_input_tokens: 3,
  },
  parentToolUseId: string | null = null,
): SDKMessage {
  return {
    type: "assistant",
    parent_tool_use_id: parentToolUseId,
    uuid: "00000000-0000-4000-8000-000000000001",
    session_id: "session",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-test",
      content,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage,
    },
  } as unknown as SDKMessage;
}

function result(
  subtype: "success" | "error_during_execution",
  overrides: Record<string, unknown> = {},
): SDKMessage {
  return {
    type: "result",
    subtype,
    result: subtype === "success" ? "SDK result" : undefined,
    errors: subtype === "success" ? undefined : ["execution failed"],
    stop_reason: null,
    modelUsage: {},
    usage: { input_tokens: 999_999, output_tokens: 999_999 },
    ...overrides,
  } as unknown as SDKMessage;
}

function streamText(text: string, parentToolUseId: string | null = null): SDKMessage {
  return {
    type: "stream_event",
    parent_tool_use_id: parentToolUseId,
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  } as unknown as SDKMessage;
}

function setup(interruptTimeoutMs = 2_000) {
  const fake = new FakeQuery();
  let queryParams: Parameters<typeof sdkQuery>[0] | undefined;
  const query = vi.fn((params: Parameters<typeof sdkQuery>[0]) => {
    queryParams = params;
    return fake as unknown as Query;
  });
  const resolveExecutable = vi.fn(() => "C:\\bin\\claude.exe");
  const backend = createClaudeBackend({ query, resolveExecutable, interruptTimeoutMs });
  return { backend, fake, query, resolveExecutable, getQueryParams: () => queryParams };
}

function runOptions(overrides: Partial<BackendRunOptions> = {}): BackendRunOptions {
  return { pi, trusted: true, ...overrides };
}

function agentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "test-agent",
    description: "test",
    builtinToolNames: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    extensions: true,
    skills: true,
    systemPrompt: "",
    promptMode: "append",
    ...overrides,
  };
}

async function nextInput(params: Parameters<typeof sdkQuery>[0]): Promise<SDKUserMessage> {
  if (typeof params.prompt === "string") throw new Error("Expected streaming input");
  const next = await params.prompt[Symbol.asyncIterator]().next();
  if (next.done) throw new Error("Input ended unexpectedly");
  return next.value;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Claude backend", () => {
  it("submits one streaming query with the required native options", async () => {
    const { backend, fake, query, resolveExecutable, getQueryParams } = setup();
    let session: SubagentSession | undefined;
    const run = backend.run(ctx, "general-purpose", "initial prompt", runOptions({
      cwd: "C:\\target",
      modelHint: "claude-opus-native",
      thinkingLevel: "xhigh",
      maxTurns: 7,
      onSessionCreated: (created) => { session = created; },
    }));

    expect(query).toHaveBeenCalledOnce();
    expect(resolveExecutable).toHaveBeenCalledOnce();
    expect(session?.messages).toHaveLength(1);
    const params = getQueryParams();
    if (!params) throw new Error("query was not called");
    expect(await nextInput(params)).toMatchObject({
      type: "user",
      message: { role: "user", content: "initial prompt" },
      parent_tool_use_id: null,
    });
    expect(params.options).toMatchObject({
      cwd: "C:\\target",
      includePartialMessages: true,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: `Environment: cwd=C:\\target; platform=${process.platform}\nActive agent: general-purpose`,
      },
      allowedTools: ["Read", "Bash", "Edit", "Write", "Grep", "Glob"],
      disallowedTools: ["Agent", "Task"],
      pathToClaudeCodeExecutable: "C:\\bin\\claude.exe",
      model: "claude-opus-native",
      maxThinkingTokens: 32_000,
      maxTurns: 7,
    } satisfies Partial<ClaudeSdkOptions>);

    fake.push(result("success"));
    await expect(run).resolves.toMatchObject({ responseText: "SDK result", aborted: false });
  });

  it("builds append/replace prompts and maps allow/deny tool configuration", async () => {
    const appended = setup();
    const appendRun = appended.backend.run(ctx, "reviewer", "prompt", runOptions({
      agentConfig: agentConfig({
        systemPrompt: "Review carefully.",
        builtinToolNames: ["read", "bash", "grep", "find", "ls"],
        disallowedTools: ["bash", "ext:ignored/tool"],
      }),
    }));
    expect(appended.getQueryParams()?.options).toMatchObject({
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: `Review carefully.\n\nEnvironment: cwd=C:\\work; platform=${process.platform}\nActive agent: reviewer`,
      },
      allowedTools: ["Read", "Bash", "Grep", "Glob"],
      disallowedTools: ["Agent", "Task", "Bash"],
    });
    appended.fake.push(result("success"));
    await appendRun;

    const replaced = setup();
    const replaceRun = replaced.backend.run(ctx, "writer", "prompt", runOptions({
      agentConfig: agentConfig({
        promptMode: "replace",
        systemPrompt: "Write only requested files.",
        builtinToolNames: ["read", "edit", "write"],
      }),
    }));
    expect(replaced.getQueryParams()?.options).toMatchObject({
      systemPrompt: `Write only requested files.\n\nEnvironment: cwd=C:\\work; platform=${process.platform}\nActive agent: writer`,
      allowedTools: ["Read", "Edit", "Write"],
      disallowedTools: ["Agent", "Task"],
    });
    replaced.fake.push(result("success"));
    await replaceRun;
  });

  it("enforces trust before calling the SDK", async () => {
    const { backend, query } = setup();
    await expect(backend.run(ctx, "general-purpose", "prompt", runOptions({ trusted: false })))
      .rejects.toThrow("explicitly trusted");
    expect(query).not.toHaveBeenCalled();
  });

  it("maps every thinking level and leaves an omitted level at the Claude default", () => {
    expect(CLAUDE_THINKING_BUDGETS).toEqual({
      off: 0,
      minimal: 1_024,
      low: 4_096,
      medium: 10_000,
      high: 16_000,
      xhigh: 32_000,
      max: 63_999,
    });
  });

  it("keeps partial text live and replaces it with the final assistant message", async () => {
    const { backend, fake } = setup();
    const deltas: Array<[string, string]> = [];
    const events: string[] = [];
    let session: SubagentSession | undefined;
    const run = backend.run(ctx, "general-purpose", "prompt", runOptions({
      onTextDelta: (delta, full) => deltas.push([delta, full]),
      onSessionCreated: (created) => {
        session = created;
        created.subscribe((event) => events.push(event.type));
      },
    }));

    fake.push(streamText("hel"));
    fake.push(streamText("lo"));
    await vi.waitFor(() => expect(session?.messages).toHaveLength(2));
    expect(session?.messages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
    });

    fake.push(assistant([{ type: "text", text: "hello" }]));
    fake.push(result("success", { result: "" }));
    const completed = await run;

    expect(completed.responseText).toBe("hello");
    expect(session?.messages).toHaveLength(2);
    expect(deltas).toEqual([["hel", "hel"], ["lo", "hello"]]);
    expect(events).toContain("message_update");
    expect(events).toContain("message_end");
    expect(events).toContain("turn_end");
  });

  it("normalizes thinking, redacted thinking, tool calls, and correlated results", async () => {
    const { backend, fake } = setup();
    const activity: string[] = [];
    let session: SubagentSession | undefined;
    const run = backend.run(ctx, "general-purpose", "prompt", runOptions({
      onSessionCreated: (created) => { session = created; },
      onToolActivity: ({ type, toolName }) => activity.push(`${type}:${toolName}`),
    }));

    fake.push(assistant([
      { type: "thinking", thinking: "reason", signature: "sig" },
      { type: "redacted_thinking", data: "opaque" },
      { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "a\n b" } },
    ]));
    fake.push({
      type: "user",
      parent_tool_use_id: null,
      uuid: "00000000-0000-4000-8000-000000000002",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool-1", content: "line 1\nline 2", is_error: false },
          { type: "text", text: "external follow-up" },
        ],
      },
    });
    fake.push(result("success"));
    await run;

    expect(session?.messages[1]).toMatchObject({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reason", thinkingSignature: "sig" },
        { type: "thinking", thinking: "", thinkingSignature: "opaque", redacted: true },
        { type: "toolCall", id: "tool-1", name: "Read", arguments: { preview: "{\"file_path\":\"a\\n b\"}" } },
      ],
    });
    expect(session?.messages[2]).toMatchObject({
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "Read",
      content: [{ type: "text", text: "line 1 line 2" }],
    });
    expect(session?.messages[3]).toMatchObject({ role: "user", content: "external follow-up" });
    expect(activity).toEqual(["start:Read", "end:Read"]);
  });

  it("ignores every sidechain message", async () => {
    const { backend, fake } = setup();
    let session: SubagentSession | undefined;
    const run = backend.run(ctx, "general-purpose", "prompt", runOptions({
      onSessionCreated: (created) => { session = created; },
    }));

    fake.push(streamText("hidden", "parent"));
    fake.push(assistant([{ type: "text", text: "hidden" }], undefined, "parent"));
    fake.push({
      type: "user",
      parent_tool_use_id: "parent",
      message: { role: "user", content: "hidden" },
    });
    fake.push(assistant([{ type: "text", text: "visible" }]));
    fake.push(result("success", { result: "visible" }));
    await run;

    expect(session?.messages).toHaveLength(2);
    expect(JSON.stringify(session?.messages)).not.toContain("hidden");
  });

  it("reports per-assistant usage and uses only assistant usage for occupancy", async () => {
    const { backend, fake } = setup();
    const usages: Array<{ input: number; output: number; cacheWrite: number }> = [];
    let session: SubagentSession | undefined;
    const run = backend.run(ctx, "general-purpose", "prompt", runOptions({
      onAssistantUsage: (usage) => usages.push(usage),
      onSessionCreated: (created) => { session = created; },
    }));

    fake.push(assistant([{ type: "text", text: "answer" }], {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 20,
    }));
    fake.push(result("success", {
      modelUsage: { "claude-test": { contextWindow: 1_000 } },
      usage: { input_tokens: 900_000, output_tokens: 900_000 },
    }));
    await run;

    expect(usages).toEqual([{ input: 100, output: 10, cacheWrite: 20 }]);
    expect(session?.getSessionStats()).toEqual({
      tokens: { input: 100, output: 10, cacheWrite: 20 },
      contextUsage: { percent: 18 },
    });
  });

  it("returns partial text and a failure for SDK errors and pump exits", async () => {
    const sdkError = setup();
    const errorRun = sdkError.backend.run(ctx, "general-purpose", "prompt", runOptions());
    sdkError.fake.push(assistant([{ type: "text", text: "partial" }]));
    sdkError.fake.push(result("error_during_execution"));
    await expect(errorRun).resolves.toMatchObject({ responseText: "partial", failure: "execution failed", aborted: false });

    const pumpFailure = setup();
    const failureRun = pumpFailure.backend.run(ctx, "general-purpose", "prompt", runOptions());
    pumpFailure.fake.push(streamText("unfinished"));
    pumpFailure.fake.fail(new Error("pump exploded"));
    await expect(failureRun).resolves.toMatchObject({
      responseText: "unfinished",
      failure: "pump exploded",
      aborted: false,
    });
  });

  it("steers through the same input stream and rejects steering after settlement", async () => {
    const { backend, fake, getQueryParams } = setup();
    let session: SubagentSession | undefined;
    const run = backend.run(ctx, "general-purpose", "prompt", runOptions({
      onSessionCreated: (created) => { session = created; },
    }));
    const params = getQueryParams();
    if (!params || !session) throw new Error("session was not created");
    await nextInput(params);

    await session.steer("change direction");
    expect(await nextInput(params)).toMatchObject({ message: { content: "change direction" } });
    expect(session.messages.at(-1)).toMatchObject({ role: "user", content: "change direction" });

    fake.push(result("success"));
    await expect(run).resolves.toMatchObject({ steered: true });
    await expect(session.steer("too late")).rejects.toThrow("only available while");
  });

  it("force-closes on an interrupt receipt containing submitted queued input", async () => {
    const { backend, fake, getQueryParams } = setup(10_000);
    const controller = new AbortController();
    const run = backend.run(ctx, "general-purpose", "prompt", runOptions({ signal: controller.signal }));
    const params = getQueryParams();
    if (!params) throw new Error("query was not called");
    const initial = await nextInput(params);
    fake.interrupt.mockResolvedValue({ still_queued: [initial.uuid ?? ""] });

    controller.abort();
    await expect(run).resolves.toMatchObject({ aborted: true });
    expect(fake.interrupt).toHaveBeenCalledOnce();
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("uses the bounded interrupt fallback and disposes idempotently", async () => {
    vi.useFakeTimers();
    const fallback = setup(25);
    fallback.fake.interrupt.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const run = fallback.backend.run(ctx, "general-purpose", "prompt", runOptions({ signal: controller.signal }));
    controller.abort();
    await vi.advanceTimersByTimeAsync(25);
    await expect(run).resolves.toMatchObject({ aborted: true });
    expect(fallback.fake.close).toHaveBeenCalledOnce();

    vi.useRealTimers();
    const disposal = setup();
    let session: SubagentSession | undefined;
    const disposedRun = disposal.backend.run(ctx, "general-purpose", "prompt", runOptions({
      onSessionCreated: (created) => { session = created; },
    }));
    session?.dispose();
    session?.dispose();
    await expect(disposedRun).resolves.toMatchObject({ aborted: true });
    expect(disposal.getQueryParams()?.options?.abortController?.signal.aborted).toBe(true);
    expect(disposal.fake.close).toHaveBeenCalledOnce();
  });

  it("rejects resume clearly", async () => {
    const { backend } = setup();
    await expect(backend.resume({} as SubagentSession, "continue")).rejects.toThrow("unsupported in v1");
  });
});
