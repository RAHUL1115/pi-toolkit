import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { Readable, Writable } from "node:stream";
import type {
  ToolCall as AcpToolCall,
  ToolCallUpdate as AcpToolCallUpdate,
  ActiveSession,
  ClientConnection,
  ClientContext,
  PromptResponse,
  RequestPermissionRequest,
  SessionConfigOption,
  SessionUpdate,
  StopReason,
} from "@agentclientprotocol/sdk";
import * as acp from "@agentclientprotocol/sdk";
import type {
  AssistantMessage,
  Message,
  ModelThinkingLevel,
  ToolCall,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";
import type { AgentSessionEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BUILTIN_TOOL_NAMES } from "../agent-types.js";
import type { BackendRunOptions, BackendRunResult, SubagentBackend, SubagentSession } from "../backend.js";
import type { AgentConfig } from "../types.js";

const DEFAULT_CANCEL_TIMEOUT_MS = 2_000;
const PREVIEW_MAX_LENGTH = 4_096;
const moduleRequire = createRequire(import.meta.url);

type CodexReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
type AdapterSpawner = (entry: string, cwd: string) => ChildProcessWithoutNullStreams;

export interface CodexBackendDependencies {
  resolveAdapter: () => string;
  spawnAdapter: AdapterSpawner;
  cancelTimeoutMs: number;
}

export function resolveCodexAdapter(): string {
  return moduleRequire.resolve("@agentclientprotocol/codex-acp");
}

function spawnCodexAdapter(entry: string, cwd: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [entry], {
    cwd,
    env: {
      ...process.env,
      INITIAL_AGENT_MODE: "agent",
      NO_BROWSER: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
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

function outputPreview(update: AcpToolCallUpdate): string {
  if (update.rawOutput !== undefined) return safeJson(update.rawOutput);
  if (!update.content) return "";
  const text = update.content.flatMap((part) => {
    if (part.type !== "content" || part.content.type !== "text") return [];
    return [part.content.text];
  }).join(" ");
  return singleLine(text) || safeJson(update.content);
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

function normalizedUsage(response: PromptResponse): Usage {
  const input = count(response.usage?.inputTokens);
  const output = count(response.usage?.outputTokens);
  const cacheRead = count(response.usage?.cachedReadTokens);
  const cacheWrite = count(response.usage?.cachedWriteTokens);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function codexPrompt(
  config: AgentConfig | undefined,
  cwd: string,
  type: string,
  prompt: string,
  parentSystemPrompt: string,
  worktreeBase?: string,
): string {
  const custom = config?.systemPrompt.trim();
  const instructions = config?.promptMode === "append"
    ? [parentSystemPrompt.trim(), custom].filter(Boolean).join("\n\n")
    : custom;
  const worktree = worktreeBase
    ? `<worktree_isolation>\nYour working directory is an isolated git worktree copy of ${worktreeBase}.\nWork only inside ${cwd} — never in ${worktreeBase}, even if other instructions name that path.\n</worktree_isolation>`
    : undefined;
  return [
    instructions ? `<agent_instructions>\n${instructions}\n</agent_instructions>` : undefined,
    `<active_agent name="${type}"/>`,
    `<environment>\nWorking directory: ${cwd}\nPlatform: ${process.platform}\n</environment>`,
    worktree,
    `<task>\n${prompt}\n</task>`,
  ].filter((part): part is string => part !== undefined).join("\n\n");
}

function splitModelHint(modelHint: string | undefined): {
  model?: string;
  effort?: CodexReasoningEffort;
} {
  if (!modelHint) return {};
  const match = modelHint.match(/^(.*)\[(low|medium|high|xhigh|max|ultra)\]$/);
  if (!match) return { model: modelHint };
  return { model: match[1], effort: match[2] as CodexReasoningEffort };
}

function reasoningEffort(level: ModelThinkingLevel | undefined): CodexReasoningEffort | undefined {
  if (level === undefined) return undefined;
  if (level === "off" || level === "minimal") {
    throw new Error("Codex ACP thinking supports low, medium, high, xhigh, or max.");
  }
  return level;
}

function selectValues(option: SessionConfigOption): string[] {
  if (option.type !== "select") return [];
  return option.options.flatMap((entry) => "options" in entry ? entry.options.map((item) => item.value) : [entry.value]);
}

async function setConfigOption(
  context: ClientContext,
  session: ActiveSession,
  options: SessionConfigOption[],
  category: "model" | "thought_level",
  value: string | undefined,
): Promise<SessionConfigOption[]> {
  if (!value) return options;
  const option = options.find(
    (entry) => entry.category === category || entry.id === (category === "thought_level" ? "reasoning_effort" : category),
  );
  if (!option || option.type !== "select") {
    throw new Error(`Codex ACP adapter did not expose a ${category} session option.`);
  }
  const available = selectValues(option);
  if (!available.includes(value)) {
    throw new Error(`Codex ACP ${option.name} does not support "${value}". Available: ${available.join(", ")}.`);
  }
  const response = await context.request(acp.methods.agent.session.setConfigOption, {
    sessionId: session.sessionId,
    configId: option.id,
    value,
  });
  return response.configOptions;
}

function assertSupportedAgentConfig(config: AgentConfig | undefined): void {
  if (!config) return;
  if (config.disallowedTools?.length) {
    throw new Error("Codex ACP does not support `disallowed_tools`; use Codex-native sandboxing instead.");
  }
  if (
    config.extSelectors?.length
    || Array.isArray(config.extensions)
    || (config.extensions === true && config.extensionsExplicit)
    || config.excludeExtensions?.length
  ) {
    throw new Error("Codex ACP does not support Pi extension/MCP tool selections.");
  }
  if (Array.isArray(config.skills) || (config.skills === true && config.skillsExplicit)) {
    throw new Error("Codex ACP does not support explicit Pi skill selections.");
  }
  if (config.memory) {
    throw new Error("Codex ACP does not support Pi agent memory.");
  }
  if (config.persistSession === true || config.sessionDir) {
    throw new Error("Codex ACP does not support Pi session persistence.");
  }
  if (config.allowedSubagents) {
    throw new Error("Codex ACP does not support tracked nested `allowed_subagents` delegation.");
  }

  const tools = config.builtinToolNames;
  if (!tools) return;
  const selected = new Set(tools);
  const hasFullScope = selected.size === BUILTIN_TOOL_NAMES.length
    && BUILTIN_TOOL_NAMES.every((name) => selected.has(name));
  if (!hasFullScope) {
    throw new Error("Codex ACP does not support partial Pi `tools:` allowlists; omit `tools:` or select all built-ins.");
  }
}

function permissionDecision(params: RequestPermissionRequest) {
  const selected = params.options.find((option) => option.kind === "allow_once");
  return {
    outcome: selected
      ? { outcome: "selected" as const, optionId: selected.optionId }
      : { outcome: "cancelled" as const },
  };
}

function failureForStop(reason: StopReason): string | undefined {
  return reason === "end_turn" ? undefined : `Codex stopped with ${reason}.`;
}

/** ACP-backed Codex runner. */
export function createCodexBackend(dependencies: CodexBackendDependencies): SubagentBackend {
  return {
    harness: "codex",
    async run(
      ctx: ExtensionContext,
      type: string,
      prompt: string,
      options: BackendRunOptions,
    ): Promise<BackendRunResult> {
      if (options.trusted !== true) {
        throw new Error("Codex backend requires an explicitly trusted project (trusted === true).");
      }
      if (options.maxTurns !== undefined) {
        throw new Error("Codex ACP backend does not support max turns.");
      }
      if (options.inheritContext) {
        throw new Error("Codex ACP backend does not support inherited parent context.");
      }
      if (options.isolated) {
        throw new Error("Codex ACP backend does not support hermetic isolation.");
      }
      assertSupportedAgentConfig(options.agentConfig);

      const cwd = options.cwd ?? ctx.cwd;
      const child = dependencies.spawnAdapter(dependencies.resolveAdapter(), cwd);
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-PREVIEW_MAX_LENGTH);
      });

      const messages: Message[] = [{ role: "user", content: prompt, timestamp: Date.now() }];
      const listeners = new Set<(event: AgentSessionEvent) => void>();
      const tools = new Map<string, { name: string; ended: boolean }>();
      const toolResults: ToolResultMessage[] = [];
      const state = {
        active: true,
        abortRequested: false,
        disposed: false,
        steered: false,
        completedPrompts: 0,
        fullText: "",
        model: options.modelHint ?? "codex",
        tokens: { input: 0, output: 0, cacheWrite: 0 },
        contextPercent: null as number | null,
        liveAssistant: undefined as AssistantMessage | undefined,
        lastAssistant: undefined as AssistantMessage | undefined,
      };

      const emit = (event: AgentSessionEvent): void => {
        for (const listener of listeners) {
          try {
            listener(event);
          } catch {
            // A viewer listener must not terminate the ACP pump.
          }
        }
      };

      const appendMessage = (message: Message): void => {
        messages.push(message);
        emit({ type: "message_end", message });
      };

      const ensureAssistant = (): AssistantMessage => {
        if (state.liveAssistant) return state.liveAssistant;
        const assistant: AssistantMessage = {
          role: "assistant",
          content: [],
          api: "openai-responses",
          provider: "openai",
          model: state.model,
          usage: emptyUsage(),
          stopReason: "stop",
          timestamp: Date.now(),
        };
        state.liveAssistant = assistant;
        messages.push(assistant);
        emit({ type: "message_start", message: assistant });
        return assistant;
      };

      const finishAssistant = (): AssistantMessage | undefined => {
        const assistant = state.liveAssistant;
        if (!assistant) return undefined;
        state.liveAssistant = undefined;
        state.lastAssistant = assistant;
        emit({ type: "message_end", message: assistant });
        return assistant;
      };

      const appendChunk = (kind: "text" | "thinking", delta: string): void => {
        const assistant = ensureAssistant();
        if (kind === "text") {
          const last = assistant.content.at(-1);
          const contentIndex = last?.type === "text"
            ? assistant.content.length - 1
            : assistant.content.push({ type: "text", text: "" }) - 1;
          const content = assistant.content[contentIndex];
          if (content.type !== "text") return;
          content.text += delta;
          state.fullText += delta;
          options.onTextDelta?.(delta, state.fullText);
          emit({
            type: "message_update",
            message: assistant,
            assistantMessageEvent: { type: "text_delta", contentIndex, delta, partial: assistant },
          });
          return;
        }

        const last = assistant.content.at(-1);
        const contentIndex = last?.type === "thinking"
          ? assistant.content.length - 1
          : assistant.content.push({ type: "thinking", thinking: "" }) - 1;
        const content = assistant.content[contentIndex];
        if (content.type !== "thinking") return;
        content.thinking += delta;
        emit({
          type: "message_update",
          message: assistant,
          assistantMessageEvent: { type: "thinking_delta", contentIndex, delta, partial: assistant },
        });
      };

      const handleToolCall = (update: AcpToolCall): void => {
        const assistant = ensureAssistant();
        const name = update.name ?? update.title ?? update.kind ?? "Tool";
        const preview = safeJson(update.rawInput);
        const toolCall: ToolCall = {
          type: "toolCall",
          id: update.toolCallId,
          name,
          arguments: preview ? { preview } : {},
        };
        assistant.content.push(toolCall);
        tools.set(update.toolCallId, { name, ended: false });
        options.onToolActivity?.({ type: "start", toolName: name });
      };

      const handleToolUpdate = (update: AcpToolCallUpdate): void => {
        const existing = tools.get(update.toolCallId);
        const name = update.name ?? update.title ?? existing?.name ?? update.kind ?? "Tool";
        if (!existing) {
          tools.set(update.toolCallId, { name, ended: false });
          options.onToolActivity?.({ type: "start", toolName: name });
        }
        if (update.status !== "completed" && update.status !== "failed") return;
        const tracked = tools.get(update.toolCallId);
        if (tracked?.ended) return;
        if (tracked) tracked.ended = true;

        finishAssistant();
        const preview = outputPreview(update);
        const result: ToolResultMessage = {
          role: "toolResult",
          toolCallId: update.toolCallId,
          toolName: name,
          content: preview ? [{ type: "text", text: preview }] : [],
          details: { outputPreview: preview },
          isError: update.status === "failed",
          timestamp: Date.now(),
        };
        toolResults.push(result);
        appendMessage(result);
        options.onToolActivity?.({ type: "end", toolName: name });
      };

      const handleUpdate = (update: SessionUpdate): void => {
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          appendChunk("text", update.content.text);
        } else if (update.sessionUpdate === "agent_thought_chunk" && update.content.type === "text") {
          appendChunk("thinking", update.content.text);
        } else if (update.sessionUpdate === "tool_call") {
          handleToolCall(update);
        } else if (update.sessionUpdate === "tool_call_update") {
          handleToolUpdate(update);
        } else if (update.sessionUpdate === "usage_update") {
          state.contextPercent = update.size > 0 ? Math.min(100, (update.used / update.size) * 100) : null;
        }
      };

      const app = acp.client({ name: "pi-unified-subagents" })
        .onRequest(acp.methods.client.session.requestPermission, ({ params }) => permissionDecision(params));
      const stream = acp.ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      );
      let connection: ClientConnection | undefined;
      let activeSession: ActiveSession | undefined;
      let context: ClientContext | undefined;
      let cancelTimer: ReturnType<typeof setTimeout> | undefined;
      let supportsSessionClose = false;
      let transportClosed = false;
      let shutdownPromise: Promise<void> | undefined;

      const waitForExit = (timeoutMs: number): Promise<boolean> => {
        if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
        return new Promise((resolve) => {
          const onExit = () => { clearTimeout(timer); resolve(true); };
          const timer = setTimeout(() => {
            child.removeListener("exit", onExit);
            resolve(false);
          }, timeoutMs);
          child.once("exit", onExit);
        });
      };

      const closeTransport = (): void => {
        if (transportClosed) return;
        transportClosed = true;
        state.active = false;
        if (cancelTimer) clearTimeout(cancelTimer);
        activeSession?.dispose();
        connection?.close();
        child.stdin.end();
      };

      const shutdown = (): Promise<void> => {
        shutdownPromise ??= (async () => {
          state.active = false;
          if (!transportClosed && context && activeSession && supportsSessionClose) {
            try {
              await context.request(acp.methods.agent.session.close, { sessionId: activeSession.sessionId });
            } catch {
              // Fall through to transport/process teardown.
            }
          }
          closeTransport();
          if (await waitForExit(dependencies.cancelTimeoutMs)) return;
          if (!child.killed) child.kill();
          await waitForExit(dependencies.cancelTimeoutMs);
        })();
        return shutdownPromise;
      };

      const requestCancel = (): void => {
        if (!state.active || state.abortRequested) return;
        state.abortRequested = true;
        if (context && activeSession) {
          void context.notify(acp.methods.agent.session.cancel, { sessionId: activeSession.sessionId }).catch(() => {});
        }
        cancelTimer = setTimeout(closeTransport, dependencies.cancelTimeoutMs);
      };

      let session: SubagentSession | undefined;
      try {
        connection = app.connect(stream);
        context = connection.agent;
        const initializeResponse = await context.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: "pi-unified-subagents", version: "0.1.0" },
        });
        supportsSessionClose = initializeResponse.agentCapabilities?.sessionCapabilities?.close != null;
        activeSession = await context.buildSession(cwd).start();

        const parsedModel = splitModelHint(options.modelHint);
        const effort = reasoningEffort(options.thinkingLevel) ?? parsedModel.effort;
        let configOptions = activeSession.newSessionResponse.configOptions ?? [];
        configOptions = await setConfigOption(context, activeSession, configOptions, "model", parsedModel.model);
        await setConfigOption(context, activeSession, configOptions, "thought_level", effort);
        state.model = parsedModel.model ?? state.model;

        session = {
          messages,
          subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          async steer(text: string): Promise<void> {
            if (!state.active || !activeSession || !context) {
              throw new Error("Codex steering is only available while the ACP session is active.");
            }
            const result = await context.request<
              { outcome: "injected" | "startedNewTurn" | "failed" },
              { sessionId: string; prompt: Array<{ type: "text"; text: string }> }
            >(
              "_session/steering",
              { sessionId: activeSession.sessionId, prompt: [{ type: "text", text }] },
            );
            if (result.outcome === "failed") {
              throw new Error("Codex ACP steering failed.");
            }
            if (result.outcome === "startedNewTurn") {
              await context.notify(acp.methods.agent.session.cancel, { sessionId: activeSession.sessionId }).catch(() => {});
              throw new Error("Codex steering missed the active turn; the late turn was cancelled.");
            }
            state.steered = true;
            appendMessage({ role: "user", content: text, timestamp: Date.now() });
          },
          getSessionStats() {
            return {
              tokens: { ...state.tokens },
              contextUsage: { percent: state.contextPercent },
            };
          },
          dispose(): void {
            if (state.disposed) return;
            state.disposed = true;
            requestCancel();
            closeTransport();
            listeners.clear();
          },
        };
        options.onSessionCreated?.(session);

        if (options.signal) {
          options.signal.addEventListener("abort", requestCancel, { once: true });
          if (options.signal.aborted) requestCancel();
        }
        if (state.abortRequested) {
          return {
            responseText: "",
            session,
            aborted: true,
            steered: false,
          };
        }

        void activeSession.prompt(codexPrompt(
          options.agentConfig,
          cwd,
          type,
          prompt,
          ctx.getSystemPrompt(),
          options.worktreeBase,
        )).catch(() => {
          // nextUpdate reports protocol failures through the main pump.
        });
        let finalResponse: PromptResponse | undefined;
        while (state.active && activeSession) {
          const message = await activeSession.nextUpdate();
          if (message.kind === "session_update") {
            handleUpdate(message.update);
            continue;
          }
          state.completedPrompts++;
          finalResponse = message.response;
          options.onTurnEnd?.(state.completedPrompts);
          break;
        }

        const assistant = finishAssistant() ?? state.lastAssistant;
        if (finalResponse) {
          const usage = normalizedUsage(finalResponse);
          state.tokens.input += usage.input;
          state.tokens.output += usage.output;
          state.tokens.cacheWrite += usage.cacheWrite;
          if (assistant) assistant.usage = usage;
          if (usage.totalTokens > 0) {
            options.onAssistantUsage?.({ input: usage.input, output: usage.output, cacheWrite: usage.cacheWrite });
          }
        }
        if (assistant) emit({ type: "turn_end", message: assistant, toolResults });

        const stopReason = finalResponse?.stopReason;
        return {
          responseText: state.fullText.trim(),
          session,
          aborted: state.abortRequested,
          steered: state.steered,
          ...(stopReason && !state.abortRequested
            ? { failure: failureForStop(stopReason) }
            : {}),
        };
      } catch (error) {
        if (state.abortRequested && session) {
          finishAssistant();
          return {
            responseText: state.fullText.trim(),
            session,
            aborted: true,
            steered: state.steered,
          };
        }
        const detail = stderr.trim();
        const message = boundedError(error);
        throw new Error(detail ? `${message}\n${detail}` : message);
      } finally {
        options.signal?.removeEventListener("abort", requestCancel);
        await shutdown();
      }
    },
    async resume(): Promise<never> {
      throw new Error("Codex ACP backend resume is unsupported in v1.");
    },
  };
}

export const codexBackend = createCodexBackend({
  resolveAdapter: resolveCodexAdapter,
  spawnAdapter: spawnCodexAdapter,
  cancelTimeoutMs: DEFAULT_CANCEL_TIMEOUT_MS,
});
