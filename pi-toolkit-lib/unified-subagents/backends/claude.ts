import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  type Options as ClaudeSdkOptions,
  type Query,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AssistantMessage,
  Message,
  ModelThinkingLevel,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";
import type { AgentSessionEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BackendRunOptions, BackendRunResult, SubagentBackend, SubagentSession } from "../backend.js";
import type { AgentConfig } from "../types.js";

const CLAUDE_CONTEXT_WINDOW = 200_000;
const DEFAULT_INTERRUPT_TIMEOUT_MS = 2_000;
const PREVIEW_MAX_LENGTH = 4_096;

const CLAUDE_TOOL_NAMES: Record<string, string> = {
  read: "Read",
  bash: "Bash",
  edit: "Edit",
  write: "Write",
  grep: "Grep",
  find: "Glob",
  ls: "Bash",
};

export const CLAUDE_THINKING_BUDGETS = {
  off: 0,
  minimal: 1_024,
  low: 4_096,
  medium: 10_000,
  high: 16_000,
  xhigh: 32_000,
  max: 63_999,
} satisfies Record<ModelThinkingLevel, number>;

type ClaudeQueryFunction = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: ClaudeSdkOptions }) => Query;
type ExecutableResolver = () => string | undefined;

export interface ClaudeBackendDependencies {
  query: ClaudeQueryFunction;
  resolveExecutable: ExecutableResolver;
  interruptTimeoutMs: number;
}

export interface ClaudeExecutableResolutionOptions {
  platform?: NodeJS.Platform;
  pathValue?: string;
  homeDirectory?: string;
  isExecutable?: (file: string) => boolean;
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** @internal Testable, side-effect-free apart from the injected executable check. */
export function resolveClaudeExecutable({
  platform = process.platform,
  pathValue = process.env.PATH ?? "",
  homeDirectory = homedir(),
  isExecutable: canExecute = isExecutable,
}: ClaudeExecutableResolutionOptions = {}): string | undefined {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (platform === "win32") {
    const userInstall = pathApi.join(homeDirectory, ".local", "bin", "claude.exe");
    if (canExecute(userInstall)) return userInstall;
  }

  const names = platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
  const delimiter = platform === "win32" ? ";" : ":";
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = pathApi.join(directory, name);
      if (canExecute(candidate)) return candidate;
    }
  }
  return undefined;
}

let cachedClaudeExecutable: string | null | undefined;

function resolveProductionExecutable(): string | undefined {
  if (cachedClaudeExecutable !== undefined) return cachedClaudeExecutable ?? undefined;
  cachedClaudeExecutable = resolveClaudeExecutable() ?? null;
  return cachedClaudeExecutable ?? undefined;
}

class ClaudeInput implements AsyncIterable<SDKUserMessage> {
  private pending: SDKUserMessage[] = [];
  private waiter: ((result: IteratorResult<SDKUserMessage>) => void) | undefined;
  private closed = false;

  push(text: string): SDKUserMessage | undefined {
    if (this.closed) return undefined;
    const message: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      uuid: randomUUID(),
    };
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = undefined;
      waiter({ value: message, done: false });
    } else {
      this.pending.push(message);
    }
    return message;
  }

  clear(): void {
    this.pending = [];
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.({ value: undefined, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      const message = this.pending.shift();
      if (message) {
        yield message;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
        this.waiter = resolve;
      });
      if (next.done) return;
      yield next.value;
    }
  }
}

function count(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, PREVIEW_MAX_LENGTH);
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, PREVIEW_MAX_LENGTH);
}

function safeJson(value: unknown): string {
  try {
    return singleLine(JSON.stringify(value) ?? "");
  } catch {
    return "";
  }
}

function outputPreview(value: unknown): string {
  if (typeof value === "string") return singleLine(value);
  if (Array.isArray(value)) {
    const text = value.flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const record = part as { type?: unknown; text?: unknown };
      return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
    }).join(" ");
    return singleLine(text) || safeJson(value);
  }
  return safeJson(value);
}

function timestamp(value?: string): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function normalizedUsage(message: SDKAssistantMessage): Usage {
  const usage = message.message.usage;
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  const cacheRead = count(usage.cache_read_input_tokens);
  const cacheWrite = count(usage.cache_creation_input_tokens);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistantContent(message: SDKAssistantMessage): Array<TextContent | ThinkingContent | ToolCall> {
  const content: Array<TextContent | ThinkingContent | ToolCall> = [];
  for (const block of message.message.content) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "thinking") {
      content.push({ type: "thinking", thinking: block.thinking, thinkingSignature: block.signature });
    } else if (block.type === "redacted_thinking") {
      content.push({ type: "thinking", thinking: "", thinkingSignature: block.data, redacted: true });
    } else if (block.type === "tool_use") {
      const preview = safeJson(block.input);
      content.push({
        type: "toolCall",
        id: block.id,
        name: block.name,
        arguments: preview ? { preview } : {},
      });
    }
  }
  return content;
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function userText(content: SDKUserMessage["message"]["content"]): string {
  if (typeof content === "string") return content;
  return content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
}

function contextOccupancy(message: SDKAssistantMessage): number {
  const usage = message.message.usage;
  return count(usage.input_tokens)
    + count(usage.cache_read_input_tokens)
    + count(usage.cache_creation_input_tokens)
    + count(usage.output_tokens);
}

function resultContextWindow(result: SDKResultMessage, model: string | undefined): number | undefined {
  return (model ? result.modelUsage[model]?.contextWindow : undefined)
    ?? Object.values(result.modelUsage)[0]?.contextWindow;
}

function resultFailure(result: Exclude<SDKResultMessage, { subtype: "success" }>): string {
  return boundedError(
    result.errors.filter((error) => error.trim()).join("\n")
      || result.stop_reason
      || `Claude Code ended with ${result.subtype}`,
  );
}

function mappedTools(names: string[] | undefined): string[] {
  return [...new Set((names ?? Object.keys(CLAUDE_TOOL_NAMES)).flatMap((name) => {
    const mapped = CLAUDE_TOOL_NAMES[name];
    return mapped ? [mapped] : [];
  }))];
}

function claudeSystemPrompt(
  config: AgentConfig | undefined,
  cwd: string,
  type: string,
): ClaudeSdkOptions["systemPrompt"] {
  const environment = `Environment: cwd=${cwd}; platform=${process.platform}\nActive agent: ${type}`;
  const custom = config?.systemPrompt.trim();
  const appended = custom ? `${custom}\n\n${environment}` : environment;
  return config?.promptMode === "replace"
    ? appended
    : { type: "preset", preset: "claude_code", append: appended };
}

/** @internal Factory used by unit tests and later backend selection wiring. */
export function createClaudeBackend(dependencies: ClaudeBackendDependencies): SubagentBackend {
  return {
    harness: "claude",
    async run(
      ctx: ExtensionContext,
      type: string,
      prompt: string,
      options: BackendRunOptions,
    ): Promise<BackendRunResult> {
      if (options.trusted !== true) {
        throw new Error("Claude backend requires an explicitly trusted project (trusted === true).");
      }

      const input = new ClaudeInput();
      const abortController = new AbortController();
      const messages: Message[] = [];
      const listeners = new Set<(event: AgentSessionEvent) => void>();
      const toolNames = new Map<string, string>();
      const submittedUuids = new Set<string>();
      const state = {
        active: true,
        abortRequested: false,
        closed: false,
        disposed: false,
        steered: false,
        turnCount: 0,
        liveAssistantIndex: undefined as number | undefined,
        liveText: "",
        latestModel: options.modelHint,
        occupancy: 0,
        contextWindow: CLAUDE_CONTEXT_WINDOW,
        tokens: { input: 0, output: 0, cacheWrite: 0 },
        pendingAssistant: undefined as AssistantMessage | undefined,
        pendingToolResults: [] as ToolResultMessage[],
      };

      const executable = dependencies.resolveExecutable();
      const thinkingBudget = options.thinkingLevel === undefined
        ? undefined
        : CLAUDE_THINKING_BUDGETS[options.thinkingLevel];
      const config = options.agentConfig;
      const disallowedTools = [...new Set([
        "Agent",
        "Task",
        ...mappedTools(config?.disallowedTools ?? []),
      ])];
      const sdkOptions: ClaudeSdkOptions = {
        cwd: options.cwd ?? ctx.cwd,
        includePartialMessages: true,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        systemPrompt: claudeSystemPrompt(config, options.cwd ?? ctx.cwd, type),
        allowedTools: mappedTools(config?.builtinToolNames),
        disallowedTools,
        abortController,
        ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
        ...(options.modelHint ? { model: options.modelHint } : {}),
        ...(thinkingBudget !== undefined ? { maxThinkingTokens: thinkingBudget } : {}),
        ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
      };

      const initial = input.push(prompt);
      if (!initial?.uuid) throw new Error("Claude backend could not submit the initial prompt.");
      submittedUuids.add(initial.uuid);
      messages.push({ role: "user", content: prompt, timestamp: Date.now() });

      const nativeQuery = dependencies.query({ prompt: input, options: sdkOptions });
      let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
      let interruptPromise: Promise<void> | undefined;
      let settled = false;
      let resolveRun: (result: BackendRunResult) => void;
      const runResult = new Promise<BackendRunResult>((resolve) => {
        resolveRun = resolve;
      });

      const emit = (event: AgentSessionEvent): void => {
        for (const listener of listeners) {
          try {
            listener(event);
          } catch {
            // A viewer listener must not terminate the SDK pump.
          }
        }
      };

      const appendMessage = (message: Message): void => {
        messages.push(message);
        emit({ type: "message_end", message });
      };

      const latestText = (): string => {
        if (state.liveText) return state.liveText.trim();
        for (let index = messages.length - 1; index >= 0; index--) {
          const message = messages[index];
          if (message.role === "assistant") {
            const text = assistantText(message);
            if (text) return text;
          }
        }
        return "";
      };

      const flushTurn = (): void => {
        const assistant = state.pendingAssistant;
        if (!assistant) return;
        emit({ type: "turn_end", message: assistant, toolResults: state.pendingToolResults });
        state.pendingAssistant = undefined;
        state.pendingToolResults = [];
        state.turnCount++;
        options.onTurnEnd?.(state.turnCount);
      };

      let session: SubagentSession;
      const settle = (result: Omit<BackendRunResult, "session" | "steered">): void => {
        if (settled) return;
        settled = true;
        state.active = false;
        if (fallbackTimer) clearTimeout(fallbackTimer);
        options.signal?.removeEventListener("abort", requestInterrupt);
        flushTurn();
        input.clear();
        input.end();
        resolveRun({ ...result, session, steered: state.steered });
      };

      const forceClose = (): void => {
        if (state.closed) return;
        settle({ responseText: latestText(), aborted: true });
        state.closed = true;
        input.clear();
        input.end();
        abortController.abort();
        nativeQuery.close();
      };

      const requestInterrupt = (): void => {
        if (!state.active || interruptPromise) return;
        state.abortRequested = true;
        fallbackTimer = setTimeout(forceClose, dependencies.interruptTimeoutMs);
        interruptPromise = nativeQuery.interrupt().then((receipt) => {
          const hasSubmittedQueuedMessage = receipt?.still_queued?.some((uuid) => submittedUuids.has(uuid));
          if (hasSubmittedQueuedMessage) forceClose();
        }).catch(() => {
          // The bounded fallback owns forced cleanup and settlement.
        });
      };

      session = {
        messages,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async steer(text: string): Promise<void> {
          if (!state.active || state.closed) {
            throw new Error("Claude steering is only available while the session is active.");
          }
          const message = input.push(text);
          if (!message?.uuid) throw new Error("Claude session is closed and cannot accept steering.");
          submittedUuids.add(message.uuid);
          state.steered = true;
          appendMessage({ role: "user", content: text, timestamp: Date.now() });
        },
        getSessionStats() {
          return {
            tokens: { ...state.tokens },
            contextUsage: {
              percent: state.contextWindow > 0
                ? Math.min(100, (state.occupancy / state.contextWindow) * 100)
                : null,
            },
          };
        },
        dispose(): void {
          if (state.disposed) return;
          state.disposed = true;
          if (state.active) settle({ responseText: latestText(), aborted: true });
          state.closed = true;
          input.clear();
          input.end();
          abortController.abort();
          nativeQuery.close();
          listeners.clear();
        },
      };

      options.onSessionCreated?.(session);
      if (options.signal) {
        options.signal.addEventListener("abort", requestInterrupt, { once: true });
        if (options.signal.aborted) requestInterrupt();
      }

      const handleStreamEvent = (message: Extract<SDKMessage, { type: "stream_event" }>): void => {
        if (message.parent_tool_use_id !== null || message.event.type !== "content_block_delta") return;
        const delta = message.event.delta;
        if (delta.type !== "text_delta" && delta.type !== "thinking_delta") return;

        let assistant: AssistantMessage;
        if (state.liveAssistantIndex === undefined) {
          flushTurn();
          assistant = {
            role: "assistant",
            content: [],
            api: "anthropic-messages",
            provider: "anthropic",
            model: state.latestModel ?? "claude",
            usage: emptyUsage(),
            stopReason: "stop",
            timestamp: Date.now(),
          };
          state.liveAssistantIndex = messages.push(assistant) - 1;
          emit({ type: "message_start", message: assistant });
        } else {
          const live = messages[state.liveAssistantIndex];
          if (live.role !== "assistant") return;
          assistant = live;
        }

        if (delta.type === "text_delta") {
          const last = assistant.content.at(-1);
          const contentIndex = last?.type === "text"
            ? assistant.content.length - 1
            : assistant.content.push({ type: "text", text: "" }) - 1;
          const content = assistant.content[contentIndex];
          if (content.type !== "text") return;
          content.text += delta.text;
          state.liveText += delta.text;
          options.onTextDelta?.(delta.text, state.liveText);
          emit({
            type: "message_update",
            message: assistant,
            assistantMessageEvent: { type: "text_delta", contentIndex, delta: delta.text, partial: assistant },
          });
        } else {
          const last = assistant.content.at(-1);
          const contentIndex = last?.type === "thinking"
            ? assistant.content.length - 1
            : assistant.content.push({ type: "thinking", thinking: "" }) - 1;
          const content = assistant.content[contentIndex];
          if (content.type !== "thinking") return;
          content.thinking += delta.thinking;
          emit({
            type: "message_update",
            message: assistant,
            assistantMessageEvent: { type: "thinking_delta", contentIndex, delta: delta.thinking, partial: assistant },
          });
        }
      };

      const handleAssistant = (message: SDKAssistantMessage): void => {
        if (message.parent_tool_use_id !== null) return;
        flushTurn();
        state.latestModel = message.message.model;
        const usage = normalizedUsage(message);
        const normalized: AssistantMessage = {
          role: "assistant",
          content: assistantContent(message),
          api: "anthropic-messages",
          provider: "anthropic",
          model: message.message.model,
          responseId: message.message.id,
          usage,
          stopReason: message.aborted
            ? "aborted"
            : message.error
              ? "error"
              : message.message.stop_reason === "tool_use"
                ? "toolUse"
                : message.message.stop_reason === "max_tokens"
                  ? "length"
                  : "stop",
          ...(message.error ? { errorMessage: message.error } : {}),
          timestamp: timestamp(message.timestamp),
        };

        if (state.liveAssistantIndex === undefined) {
          messages.push(normalized);
        } else {
          messages[state.liveAssistantIndex] = normalized;
        }
        state.liveAssistantIndex = undefined;
        state.liveText = "";
        emit({ type: "message_end", message: normalized });
        state.pendingAssistant = normalized;

        state.tokens.input += usage.input;
        state.tokens.output += usage.output;
        state.tokens.cacheWrite += usage.cacheWrite;
        state.occupancy = contextOccupancy(message);
        options.onAssistantUsage?.({ input: usage.input, output: usage.output, cacheWrite: usage.cacheWrite });

        for (const block of message.message.content) {
          if (block.type !== "tool_use") continue;
          toolNames.set(block.id, block.name);
          options.onToolActivity?.({ type: "start", toolName: block.name });
        }
      };

      const handleUser = (message: SDKUserMessage): void => {
        if (message.parent_tool_use_id !== null) return;
        const content = message.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type !== "tool_result") continue;
            const toolName = toolNames.get(block.tool_use_id) ?? "Tool";
            toolNames.delete(block.tool_use_id);
            const preview = outputPreview(block.content);
            const normalized: ToolResultMessage = {
              role: "toolResult",
              toolCallId: block.tool_use_id,
              toolName,
              content: preview ? [{ type: "text", text: preview }] : [],
              details: { outputPreview: preview },
              isError: block.is_error ?? false,
              timestamp: timestamp(message.timestamp),
            };
            appendMessage(normalized);
            state.pendingToolResults.push(normalized);
            options.onToolActivity?.({ type: "end", toolName });
          }
        }

        const text = userText(content).trim();
        if (text && (!message.uuid || !submittedUuids.has(message.uuid))) {
          appendMessage({ role: "user", content: text, timestamp: timestamp(message.timestamp) });
        }
      };

      const handleResult = (result: SDKResultMessage): void => {
        const contextWindow = resultContextWindow(result, state.latestModel);
        if (contextWindow !== undefined && contextWindow > 0) state.contextWindow = contextWindow;
        if (state.abortRequested) {
          settle({ responseText: latestText(), aborted: true });
        } else if (result.subtype === "success") {
          settle({ responseText: result.result.trim() || latestText(), aborted: false });
        } else {
          settle({ responseText: latestText(), aborted: false, failure: resultFailure(result) });
        }
      };

      const handleMessage = (message: SDKMessage): void => {
        if (state.closed) return;
        if (message.type === "stream_event") handleStreamEvent(message);
        else if (message.type === "assistant") handleAssistant(message);
        else if (message.type === "user") handleUser(message);
        else if (message.type === "result") handleResult(message);
      };

      void (async () => {
        let failure: string | undefined;
        try {
          for await (const message of nativeQuery) handleMessage(message);
        } catch (error) {
          if (!state.closed && !abortController.signal.aborted) failure = boundedError(error);
        } finally {
          if (!settled) {
            settle({
              responseText: latestText(),
              aborted: state.abortRequested,
              ...(state.abortRequested
                ? {}
                : { failure: failure ?? "Claude Code query ended unexpectedly." }),
            });
          }
          state.closed = true;
        }
      })();

      return runResult;
    },
    async resume(): Promise<never> {
      throw new Error("Claude backend resume is unsupported in v1.");
    },
  };
}

export const claudeBackend = createClaudeBackend({
  query: sdkQuery,
  resolveExecutable: resolveProductionExecutable,
  interruptTimeoutMs: DEFAULT_INTERRUPT_TIMEOUT_MS,
});
