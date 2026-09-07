import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
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

const DEFAULT_STOP_TIMEOUT_MS = 2_000;
const PREVIEW_MAX_LENGTH = 4_096;
const MAX_STREAM_LINE_LENGTH = 1_048_576;

type AgyEffort = "low" | "medium" | "high";
type AgySpawner = (executable: string, args: string[], cwd: string) => ChildProcessWithoutNullStreams;

export interface AgyBackendDependencies {
  resolveExecutable: () => string | undefined;
  spawnCli: AgySpawner;
  stopTimeoutMs: number;
}

export interface AgyExecutableResolutionOptions {
  platform?: NodeJS.Platform;
  pathValue?: string;
  homeDirectory?: string;
  localAppData?: string;
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

export function resolveAgyExecutable({
  platform = process.platform,
  pathValue = process.env.PATH ?? "",
  homeDirectory = homedir(),
  localAppData = process.env.LOCALAPPDATA,
  isExecutable: canExecute = isExecutable,
}: AgyExecutableResolutionOptions = {}): string | undefined {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (platform === "win32") {
    const localInstall = pathApi.join(localAppData ?? pathApi.join(homeDirectory, "AppData", "Local"), "agy", "bin", "agy.exe");
    if (canExecute(localInstall)) return localInstall;
  }

  const names = platform === "win32"
    ? ["agy.exe", "agy.cmd", "agy", "antigravity.exe", "antigravity.cmd", "antigravity"]
    : ["agy", "antigravity"];
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

let cachedAgyExecutable: string | null | undefined;

function resolveProductionExecutable(): string | undefined {
  if (cachedAgyExecutable !== undefined) return cachedAgyExecutable ?? undefined;
  cachedAgyExecutable = resolveAgyExecutable() ?? null;
  return cachedAgyExecutable ?? undefined;
}

function spawnAgy(executable: string, args: string[], cwd: string): ChildProcessWithoutNullStreams {
  return spawn(executable, args, {
    cwd,
    env: { ...process.env, NO_BROWSER: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
}

function forceKill(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32" && child.pid) {
      spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
    } else if (child.pid) {
      process.kill(-child.pid, "SIGKILL");
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    child.kill("SIGKILL");
  }
}

function count(value: unknown): number {
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

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function outputPreview(value: unknown): string {
  return typeof value === "string" ? singleLine(value) : safeJson(value);
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

function normalizedUsage(value: unknown): Usage {
  const usage = record(value);
  const input = count(usage?.input_tokens);
  const output = count(usage?.output_tokens);
  const cacheRead = count(usage?.cache_read_tokens);
  return {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    totalTokens: count(usage?.total_tokens) || input + output + cacheRead,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function agyPrompt(
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

function agyEffort(level: ModelThinkingLevel | undefined): AgyEffort | undefined {
  if (level === undefined) return undefined;
  if (level === "low" || level === "medium" || level === "high") return level;
  throw new Error("Agy thinking supports low, medium, or high.");
}

function assertSupportedAgentConfig(config: AgentConfig | undefined): "plan" | undefined {
  if (!config) return undefined;
  if (config.disallowedTools?.length) {
    throw new Error("Agy does not support Pi `disallowed_tools`; use Agy-native permissions instead.");
  }
  if (
    config.extSelectors?.length
    || Array.isArray(config.extensions)
    || (config.extensions === true && config.extensionsExplicit)
    || config.excludeExtensions?.length
  ) {
    throw new Error("Agy does not support Pi extension/MCP tool selections.");
  }
  if (Array.isArray(config.skills) || (config.skills === true && config.skillsExplicit)) {
    throw new Error("Agy does not support explicit Pi skill selections.");
  }
  if (config.memory) throw new Error("Agy does not support Pi agent memory.");
  if (config.persistSession === true || config.sessionDir) {
    throw new Error("Agy does not support Pi session persistence.");
  }
  if (config.allowedSubagents) {
    throw new Error("Agy does not support tracked nested `allowed_subagents` delegation.");
  }

  const tools = config.builtinToolNames;
  if (!tools) return undefined;
  const selected = new Set(tools);
  const hasFullScope = selected.size === BUILTIN_TOOL_NAMES.length
    && BUILTIN_TOOL_NAMES.every(name => selected.has(name));
  if (hasFullScope) return undefined;
  if (!selected.has("edit") && !selected.has("write")) return "plan";
  throw new Error("Agy supports either all Pi built-ins or a read-only tool profile through plan mode.");
}

function cliArgs(options: BackendRunOptions, mode: "plan" | undefined): string[] {
  return [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--print-timeout", "24h",
    "--dangerously-skip-permissions",
    "--disable-slash-commands",
    ...(options.modelHint ? ["--model", options.modelHint] : []),
    ...(options.thinkingLevel ? ["--effort", agyEffort(options.thinkingLevel)!] : []),
    "--mode", mode ?? "accept-edits",
  ];
}

function streamMessage(content: string): string {
  return `${JSON.stringify({ event: "user", message: { role: "user", content } })}\n`;
}

export function createAgyBackend(dependencies: AgyBackendDependencies): SubagentBackend {
  return {
    harness: "agy",
    async run(
      ctx: ExtensionContext,
      type: string,
      prompt: string,
      options: BackendRunOptions,
    ): Promise<BackendRunResult> {
      if (options.trusted !== true) {
        throw new Error("Agy backend requires an explicitly trusted project (trusted === true).");
      }
      if (options.maxTurns !== undefined) throw new Error("Agy backend does not support max turns.");
      if (options.inheritContext) throw new Error("Agy backend does not support inherited parent context.");

      const mode = assertSupportedAgentConfig(options.agentConfig);
      agyEffort(options.thinkingLevel);
      const executable = dependencies.resolveExecutable();
      if (!executable) throw new Error("Agy CLI was not found. Install it and ensure `agy` is on PATH.");

      const cwd = options.cwd ?? ctx.cwd;
      const child = dependencies.spawnCli(executable, cliArgs(options, mode), cwd);
      const messages: Message[] = [{ role: "user", content: prompt, timestamp: Date.now() }];
      const listeners = new Set<(event: AgentSessionEvent) => void>();
      const tools = new Map<number, { name: string; ended: boolean }>();
      const state = {
        active: true,
        aborted: false,
        disposed: false,
        steered: false,
        submittedTurns: 1,
        completedResults: 0,
        turnCount: 0,
        fullText: "",
        latestResponse: "",
        model: options.modelHint ?? "agy",
        tokens: { input: 0, output: 0, cacheWrite: 0 },
        liveAssistant: undefined as AssistantMessage | undefined,
        pendingToolResults: [] as ToolResultMessage[],
      };
      let stderr = "";
      let stdoutBuffer = "";
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-PREVIEW_MAX_LENGTH);
      });

      const emit = (event: AgentSessionEvent): void => {
        for (const listener of listeners) {
          try {
            listener(event);
          } catch {
            // A viewer listener must not terminate the stream pump.
          }
        }
      };

      const ensureAssistant = (): AssistantMessage => {
        if (state.liveAssistant) return state.liveAssistant;
        const assistant: AssistantMessage = {
          role: "assistant",
          content: [],
          api: "google-generative-ai",
          provider: "agy",
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

      const finishAssistant = (usageValue?: unknown): AssistantMessage | undefined => {
        const assistant = state.liveAssistant;
        if (!assistant) return undefined;
        state.liveAssistant = undefined;
        const usage = normalizedUsage(usageValue);
        assistant.usage = usage;
        state.tokens.input += usage.input;
        state.tokens.output += usage.output;
        if (usage.totalTokens > 0) {
          options.onAssistantUsage?.({ input: usage.input, output: usage.output, cacheWrite: 0 });
        }
        emit({ type: "message_end", message: assistant });
        emit({ type: "turn_end", message: assistant, toolResults: state.pendingToolResults });
        state.pendingToolResults = [];
        state.turnCount++;
        options.onTurnEnd?.(state.turnCount);
        return assistant;
      };

      const appendText = (delta: string): void => {
        const assistant = ensureAssistant();
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
      };

      const appendToolResult = (stepIndex: number, step: Record<string, unknown>): void => {
        const tracked = tools.get(stepIndex);
        const info = record(step.tool_info);
        const name = text(step.tool_name) ?? text(info?.name) ?? tracked?.name ?? "Tool";
        if (!tracked) options.onToolActivity?.({ type: "start", toolName: name });
        if (tracked?.ended) return;
        if (tracked) tracked.ended = true;

        const error = record(info?.error);
        const preview = outputPreview(info?.output ?? error?.message ?? info?.error);
        const result: ToolResultMessage = {
          role: "toolResult",
          toolCallId: `agy-${stepIndex}`,
          toolName: name,
          content: preview ? [{ type: "text", text: preview }] : [],
          details: { outputPreview: preview },
          isError: String(step.state).toUpperCase() === "ERROR" || error !== undefined,
          timestamp: Date.now(),
        };
        messages.push(result);
        state.pendingToolResults.push(result);
        emit({ type: "message_end", message: result });
        options.onToolActivity?.({ type: "end", toolName: name });
      };

      let resolveResult!: (result: BackendRunResult) => void;
      let rejectResult!: (error: Error) => void;
      const resultPromise = new Promise<BackendRunResult>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      });

      const settle = (result: Omit<BackendRunResult, "session" | "steered">): void => {
        if (settled) return;
        settled = true;
        state.active = false;
        finishAssistant();
        resolveResult({ ...result, session, steered: state.steered });
      };

      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        state.active = false;
        finishAssistant();
        const detail = stderr.trim();
        const message = boundedError(error);
        rejectResult(new Error(detail ? `${message}\n${detail}` : message));
      };

      const requestStop = (): void => {
        if (!state.active || state.aborted) return;
        state.aborted = true;
        child.stdin.end();
        child.kill();
        stopTimer = setTimeout(() => forceKill(child), dependencies.stopTimeoutMs);
      };

      const writePrompt = (content: string): Promise<void> => new Promise((resolve, reject) => {
        child.stdin.write(streamMessage(content), (error) => error ? reject(error) : resolve());
      });

      const session: SubagentSession = {
        messages,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async steer(content: string): Promise<void> {
          if (!state.active || child.stdin.destroyed || child.stdin.writableEnded) {
            throw new Error("Agy steering is only available while the stream session is active.");
          }
          await writePrompt(content);
          state.submittedTurns++;
          state.steered = true;
          const message: Message = { role: "user", content, timestamp: Date.now() };
          messages.push(message);
          emit({ type: "message_end", message });
        },
        getSessionStats() {
          return { tokens: { ...state.tokens }, contextUsage: { percent: null } };
        },
        dispose(): void {
          if (state.disposed) return;
          state.disposed = true;
          requestStop();
          listeners.clear();
        },
      };
      options.onSessionCreated?.(session);

      const handleStep = (step: Record<string, unknown>): void => {
        const stepType = text(step.step_type);
        const stepIndex = count(step.step_index);
        const stepState = String(step.state).toUpperCase();
        if (stepType === "agent_response") {
          const delta = text(step.text_delta);
          if (delta) appendText(delta);
          if (stepState === "DONE" || stepState === "ERROR") {
            ensureAssistant();
            finishAssistant(step.usage);
          }
          return;
        }
        if (stepType !== "tool" && !step.tool_info) return;
        const info = record(step.tool_info);
        const name = text(step.tool_name) ?? text(info?.name) ?? "Tool";
        if (stepState === "ACTIVE") {
          if (tools.has(stepIndex)) return;
          const assistant = ensureAssistant();
          const input = info?.parameters;
          const call: ToolCall = {
            type: "toolCall",
            id: `agy-${stepIndex}`,
            name,
            arguments: record(input) ?? (input === undefined ? {} : { preview: outputPreview(input) }),
          };
          assistant.content.push(call);
          assistant.stopReason = "toolUse";
          tools.set(stepIndex, { name, ended: false });
          options.onToolActivity?.({ type: "start", toolName: name });
          return;
        }
        if (stepState === "DONE" || stepState === "ERROR") {
          finishAssistant();
          appendToolResult(stepIndex, step);
        }
      };

      const handleLine = (line: string): void => {
        if (!line.trim()) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (error) {
          fail(new Error(`Agy emitted invalid stream JSON: ${boundedError(error)}`));
          return;
        }
        const event = record(parsed);
        if (!event) return;
        const eventName = text(event.event);
        if (eventName === "init") {
          const init = record(event.init);
          const advertisedModel = text(init?.model);
          if (advertisedModel) state.model = advertisedModel;
          return;
        }
        if (eventName === "step_update") {
          const step = record(event.step_update);
          if (step) handleStep(step);
          return;
        }
        if (eventName !== "result") return;

        const result = record(event.result);
        if (!result) {
          fail(new Error("Agy emitted a result event without a result payload."));
          return;
        }
        state.completedResults++;
        const response = text(result.response)?.trim() ?? "";
        if (response) state.latestResponse = response;
        if (state.completedResults < state.submittedTurns) return;
        const status = text(result.status)?.toUpperCase();
        const failure = status === "SUCCESS"
          ? undefined
          : (text(result.error) ?? response) || `Agy stopped with ${status ?? "an error"}.`;
        settle({
          responseText: state.latestResponse || state.fullText.trim(),
          aborted: state.aborted,
          ...(failure && !state.aborted ? { failure } : {}),
        });
      };

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdoutBuffer += chunk;
        if (stdoutBuffer.length > MAX_STREAM_LINE_LENGTH && !stdoutBuffer.includes("\n")) {
          fail(new Error("Agy emitted an oversized stream event."));
          requestStop();
          return;
        }
        let newline = stdoutBuffer.indexOf("\n");
        while (newline !== -1) {
          const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          if (line.length > MAX_STREAM_LINE_LENGTH) {
            fail(new Error("Agy emitted an oversized stream event."));
            requestStop();
            return;
          }
          handleLine(line);
          newline = stdoutBuffer.indexOf("\n");
        }
      });
      child.once("error", fail);
      child.once("exit", (code, signal) => {
        if (stopTimer) clearTimeout(stopTimer);
        if (stdoutBuffer.trim()) handleLine(stdoutBuffer.replace(/\r$/, ""));
        if (settled) return;
        if (state.aborted) {
          settle({ responseText: state.latestResponse || state.fullText.trim(), aborted: true });
        } else {
          fail(new Error(`Agy exited before a terminal result (code ${code ?? "null"}, signal ${signal ?? "none"}).`));
        }
      });

      const abort = () => requestStop();
      options.signal?.addEventListener("abort", abort, { once: true });
      try {
        if (options.signal?.aborted) {
          requestStop();
        } else {
          await writePrompt(agyPrompt(
            options.agentConfig,
            cwd,
            type,
            prompt,
            ctx.getSystemPrompt(),
            options.worktreeBase,
          ));
        }
        return await resultPromise;
      } finally {
        options.signal?.removeEventListener("abort", abort);
        if (stopTimer) clearTimeout(stopTimer);
        if (!child.stdin.writableEnded) child.stdin.end();
        if (child.exitCode === null && child.signalCode === null) {
          const exited = new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => {
              child.removeListener("exit", onExit);
              resolve(false);
            }, dependencies.stopTimeoutMs);
            const onExit = () => {
              clearTimeout(timer);
              resolve(true);
            };
            child.once("exit", onExit);
          });
          if (!await exited) forceKill(child);
        }
      }
    },
    async resume(): Promise<never> {
      throw new Error("Agy backend resume is unsupported in v1.");
    },
  };
}

export const agyBackend = createAgyBackend({
  resolveExecutable: resolveProductionExecutable,
  spawnCli: spawnAgy,
  stopTimeoutMs: DEFAULT_STOP_TIMEOUT_MS,
});
