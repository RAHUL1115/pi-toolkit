import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { claudeBackend } from "./backends/claude.js";
import { codexBackend } from "./backends/codex.js";
import { piBackend } from "./backends/pi.js";
import type { AgentConfig, AgentHarness, EffectiveThinkingLevel } from "./types.js";
import type { LifetimeUsage } from "./usage.js";

/** The Pi-compatible session surface used outside backend runners. */
export interface SubagentSession {
  readonly messages: AgentSession["messages"];
  readonly model?: Model<any>;
  readonly thinkingLevel?: EffectiveThinkingLevel;
  readonly sessionManager?: { getSessionFile?(): string | undefined };
  readonly extensionRunner?: {
    hasHandlers?(event: string): boolean;
    emit(event: { type: "session_shutdown"; reason: "quit" }): Promise<unknown>;
  };
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  steer(message: string): Promise<void>;
  getSessionStats(): {
    tokens: { input: number; output: number; cacheWrite: number };
    contextUsage?: { percent: number | null };
  };
  dispose(): void;
}

export interface ToolActivity {
  type: "start" | "end";
  toolName: string;
}

export interface BackendRunOptions {
  pi: ExtensionAPI;
  /** Resolved agent definition; backends must not reach into UI state. */
  agentConfig?: AgentConfig;
  agentId?: string;
  model?: ExtensionContext["model"];
  maxTurns?: number;
  signal?: AbortSignal;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ModelThinkingLevel;
  /** Native backend model identifier; never coerced into a Pi Model. */
  modelHint?: string;
  /** Explicit trust decision enforced by backends that bypass permissions. */
  trusted?: boolean;
  cwd?: string;
  /** Parent checkout when cwd points to an isolated worktree. */
  worktreeBase?: string;
  configCwd?: string;
  /** Reopen a persisted Pi session. Ignored by native backends. */
  resumeSessionFile?: string;
  /** Nested Pi run; native backends ignore this marker. */
  nested?: boolean;
  onToolActivity?: (activity: ToolActivity) => void;
  onTextDelta?: (delta: string, fullText: string) => void;
  onSessionCreated?: (session: SubagentSession) => void;
  onTurnEnd?: (turnCount: number) => void;
  onAssistantUsage?: (usage: LifetimeUsage) => void;
  onCompaction?: (info: BackendCompactionInfo) => void;
}

export interface BackendCompactionInfo {
  reason: "manual" | "threshold" | "overflow";
  tokensBefore: number;
}

export interface BackendRunResult {
  responseText: string;
  session: SubagentSession;
  aborted: boolean;
  steered: boolean;
  failure?: string;
}

export interface BackendResumeOptions {
  onToolActivity?: (activity: ToolActivity) => void;
  onAssistantUsage?: (usage: LifetimeUsage) => void;
  onCompaction?: (info: BackendCompactionInfo) => void;
  signal?: AbortSignal;
}

export interface BackendResumeResult {
  text: string;
  failure?: string;
}

export interface SubagentBackend {
  readonly harness: AgentHarness;
  run(
    ctx: ExtensionContext,
    type: string,
    prompt: string,
    options: BackendRunOptions,
  ): Promise<BackendRunResult>;
  resume(
    session: SubagentSession,
    prompt: string,
    options?: BackendResumeOptions,
  ): Promise<BackendResumeResult>;
}

/** One local manifest maps harness IDs to adapters; upstream callers use only this seam. */
const BACKENDS: Readonly<Record<AgentHarness, SubagentBackend>> = {
  pi: piBackend,
  claude: claudeBackend,
  codex: codexBackend,
};

export function getBackend(harness: AgentHarness = "pi"): SubagentBackend {
  const backend = BACKENDS[harness];
  if (!backend) throw new Error(`Unknown subagent harness: "${String(harness)}".`);
  return backend;
}
