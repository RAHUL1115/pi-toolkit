import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveAgentInvocationConfig } from "./invocation-config.js";
import { describeModel, resolveModel } from "./model-resolver.js";
import { checkModelScope } from "./model-scope.js";
import type {
  AgentConfig,
  AgentHarness,
  AgentInvocation,
  IsolationMode,
  ThinkingLevel,
} from "./types.js";
import { isAgentHarness } from "./types.js";

export interface HarnessInvocationParams {
  harness?: unknown;
  model?: unknown;
  thinking?: string;
  thinkingLevel?: string;
  max_turns?: number;
  maxTurns?: number;
  run_in_background?: boolean;
  isBackground?: boolean;
  inherit_context?: boolean;
  inheritContext?: boolean;
  isolated?: boolean;
  isolation?: unknown;
  cwd?: unknown;
}

export interface HarnessResolution {
  harness: AgentHarness;
  model?: Model<any>;
  modelHint?: string;
  trusted?: boolean;
  maxTurns?: number;
  thinking?: ThinkingLevel;
  inheritContext: boolean;
  runInBackground: boolean;
  isolated: boolean;
  isolation?: IsolationMode;
  cwd?: unknown;
  invocation: AgentInvocation;
  warnings: string[];
}

interface ResolveHarnessInvocationInput {
  ctx: Pick<ExtensionContext, "cwd" | "model" | "modelRegistry" | "isProjectTrusted">;
  config?: AgentConfig;
  params: HarnessInvocationParams;
  operation?: "spawn" | "resume" | "schedule";
  resumeHarness?: AgentHarness;
  agentLabel: string;
  scopeCwd?: string;
  worktreeAllowed?: boolean;
  defaultRunInBackground?: boolean;
}

/** Normalize a native-backend model ID without consulting Pi's model registry. */
function resolveNativeModelHint(
  input: string | undefined,
  harness: "Claude" | "Codex",
  provider: "anthropic" | "openai",
): string | undefined {
  if (!input) return undefined;
  const slash = input.indexOf("/");
  if (slash === -1) return input;
  const actualProvider = input.slice(0, slash).toLowerCase();
  const model = input.slice(slash + 1);
  if (actualProvider !== provider) {
    throw new Error(`${harness} harness only accepts native model IDs or the "${provider}/" prefix, not "${actualProvider}/".`);
  }
  if (!model) throw new Error(`${harness} harness model cannot be empty after the ${provider}/ prefix.`);
  return model;
}

export function resolveClaudeModelHint(input?: string): string | undefined {
  return resolveNativeModelHint(input, "Claude", "anthropic");
}

export function resolveCodexModelHint(input?: string): string | undefined {
  return resolveNativeModelHint(input, "Codex", "openai");
}

/**
 * Resolve one authoritative harness plan for Agent-tool and external spawn paths.
 * Frontmatter and resumed-session choices win over caller hints. Policy errors are
 * user-safe; callers choose whether to return them as tool text or RPC failures.
 */
export function resolveHarnessInvocation({
  ctx,
  config,
  params,
  operation = "spawn",
  resumeHarness,
  agentLabel,
  scopeCwd = ctx.cwd,
  worktreeAllowed = true,
  defaultRunInBackground = false,
}: ResolveHarnessInvocationInput): HarnessResolution {
  const rawHarness = params.harness;
  if (rawHarness !== undefined && !isAgentHarness(rawHarness)) {
    throw new Error(`Unknown subagent harness: "${String(rawHarness)}".`);
  }

  const resolved = resolveAgentInvocationConfig(config, {
    harness: rawHarness,
    model: typeof params.model === "string" ? params.model : undefined,
    thinking: params.thinkingLevel ?? params.thinking,
    max_turns: params.maxTurns ?? params.max_turns,
    run_in_background: params.isBackground ?? params.run_in_background,
    inherit_context: params.inheritContext ?? params.inherit_context,
    isolated: params.isolated,
    isolation: params.isolation,
  }, { worktreeAllowed, defaultRunInBackground });
  const harness = resumeHarness ?? resolved.harness;
  const nativeName = harness === "claude" ? "Claude" : "Codex ACP";

  if (harness !== "pi") {
    if (operation === "schedule") throw new Error(`${nativeName} harness does not support schedule.`);
    if (operation === "resume") throw new Error(`${nativeName} harness does not support resume.`);
    if (resolved.inheritContext) throw new Error(`${nativeName} harness does not support inherited parent context.`);
    if (resolved.isolated) throw new Error(`${nativeName} harness does not support hermetic isolation.`);
    if (harness === "claude" && resolved.isolation) {
      throw new Error("Claude harness v1 does not support worktree isolation.");
    }
    if (harness === "codex" && resolved.maxTurns !== undefined) {
      throw new Error("Codex ACP harness does not support max turns.");
    }
    if (harness === "codex" && (String(resolved.thinking) === "off" || resolved.thinking === "minimal")) {
      throw new Error("Codex ACP thinking supports low, medium, high, xhigh, or max.");
    }
    if (!ctx.isProjectTrusted()) {
      throw new Error(`${nativeName} harness requires the current working directory to be trusted. Use /trust, then retry.`);
    }
  }

  let model = harness === "pi" ? ctx.model : undefined;
  let modelHint: string | undefined;
  const warnings: string[] = [];
  if (harness === "pi") {
    if (resolved.modelInput) {
      const candidate = resolveModel(resolved.modelInput, ctx.modelRegistry);
      if (typeof candidate === "string") {
        if (resolved.modelFromParams) throw new Error(candidate);
      } else {
        model = candidate;
      }
    } else if (params.model && typeof params.model === "object") {
      model = params.model as Model<any>;
    }

    const scope = checkModelScope({
      model,
      cwd: scopeCwd,
      modelRegistry: ctx.modelRegistry,
      callerSupplied: resolved.modelFromParams || (config?.model == null && params.model != null),
      agentLabel,
      modelInput: resolved.modelInput,
    });
    if (scope.kind === "error") throw new Error(scope.message);
    if (scope.kind === "warn") warnings.push(scope.message);
  } else {
    if (params.model && typeof params.model !== "string" && !config?.model) {
      throw new Error(`${nativeName} harness requires a native model ID string, not a Pi Model object.`);
    }
    modelHint = harness === "claude"
      ? resolveClaudeModelHint(resolved.modelInput)
      : resolveCodexModelHint(resolved.modelInput);
  }

  const described = harness === "pi" && model
    ? describeModel(model)
    : { modelName: modelHint, modelId: modelHint ? `${harness === "claude" ? "anthropic" : "openai"}/${modelHint}` : undefined };
  const askedModel = ((asked: string | undefined) => {
    if (!asked || harness !== "pi") return asked;
    const requested = resolveModel(asked, ctx.modelRegistry);
    if (typeof requested === "string") return asked;
    return requested.provider === model?.provider && requested.id === model?.id ? undefined : asked;
  })(resolved.overridden?.model);
  return {
    harness,
    model,
    modelHint,
    trusted: harness === "pi" ? undefined : true,
    maxTurns: harness === "codex" ? undefined : resolved.maxTurns,
    thinking: resolved.thinking,
    inheritContext: resolved.inheritContext,
    runInBackground: resolved.runInBackground,
    isolated: resolved.isolated,
    isolation: resolved.isolation,
    cwd: params.cwd,
    invocation: {
      harness,
      modelName: described.modelName,
      modelId: described.modelId,
      thinking: resolved.thinking,
      requestedThinking: resolved.overridden?.thinking,
      requestedModel: askedModel,
      maxTurns: resolved.maxTurns,
      isolated: resolved.isolated,
      inheritContext: resolved.inheritContext,
      runInBackground: resolved.runInBackground,
      isolation: resolved.isolation,
    },
    warnings,
  };
}
