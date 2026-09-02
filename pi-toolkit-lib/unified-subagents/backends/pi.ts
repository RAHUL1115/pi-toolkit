import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { resumeAgent, runAgent } from "../agent-runner.js";
import type { SubagentBackend } from "../backend.js";

/** Native Pi backend; execution and events remain owned by agent-runner. */
export const piBackend: SubagentBackend = {
  harness: "pi",
  run: (ctx, type, prompt, options) => runAgent(ctx, type, prompt, options),
  resume: (session, prompt, options) => resumeAgent(session as AgentSession, prompt, options),
};
