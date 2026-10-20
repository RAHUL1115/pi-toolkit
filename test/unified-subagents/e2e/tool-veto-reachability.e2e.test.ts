/** Exercise real model calls and ctx.executeTool through Pi 1.3's public events. */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, fauxProvider } from "@earendil-works/pi-ai/compat";
import { runAgent } from "../../../pi-toolkit-lib/unified-subagents/agent-runner.js";
import { registerAgents } from "../../../pi-toolkit-lib/unified-subagents/agent-types.js";
import type { AgentConfig } from "../../../pi-toolkit-lib/unified-subagents/types.js";


vi.setConfig({ testTimeout: 30_000 });
const FIXTURE = fileURLToPath(new URL("../fixtures/scope-reachability.mjs", import.meta.url));

it("guards direct and nested calls, preserves exposure and live scope across resumed turns", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "scope-reachability-"));
  const faux = fauxProvider({ provider: "scope-faux", tokensPerSecond: Infinity });
  let session: any;
  try {
    registerAgents(new Map([["scope", {
      name: "scope", description: "scope", builtinToolNames: [],
      extensions: [FIXTURE], skills: false, persistSession: false,
      extSelectors: ["tool_search", "scope_driver", "scope_direct", "scope_model-only", "scope_codemode", "scope_deferred", "scope_hidden", "scope_inactive", "scope_late", "scope_late_deferred"].map(name => `ext:scope-reachability.mjs/${name}`),
      systemPrompt: "Test tools.", promptMode: "replace", inheritContext: false,
      runInBackground: false, isolated: false,
    } as AgentConfig]]));
    const model = faux.getModel();
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(faux.provider);
    await runtime.setRuntimeApiKey("scope-faux", "test-only");
    const modelRegistry: any = {
      runtime,
      find: () => model, getAll: () => [model], getAvailable: () => [model],
      hasConfiguredAuth: () => true, isUsingOAuth: () => false,
      getApiKeyAndHeaders: async () => ({ apiKey: "faux", headers: {} }),
      registerProvider: () => {}, unregisterProvider: () => {},
    };
    const call = (name: string) => fauxAssistantMessage(fauxToolCall(name, {}), { stopReason: "toolUse" });
    faux.setResponses([call("scope_driver"), fauxAssistantMessage("done")]);
    let initial: string[] = [];
    const result = await runAgent({ cwd, model, modelRegistry, getSystemPrompt: () => "parent" } as any, "scope", "go", {
      pi: { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as any,
      model,
      onSessionCreated: s => {
        session = s;
        initial = s.getActiveToolNames();
        // The parent runtime owns the in-memory faux provider; no network.
      },
    });
    expect(faux.state.callCount).toBe(2);
    expect(existsSync(join(cwd, "scope_deferred"))).toBe(true);
    expect(existsSync(join(cwd, "scope_excluded"))).toBe(false);
    expect(initial).toEqual(expect.arrayContaining(["scope_driver", "scope_direct", "scope_model-only"]));
    for (const name of ["tool_search", "scope_codemode", "scope_deferred", "scope_hidden", "scope_inactive", "scope_excluded"]) expect(initial).not.toContain(name);
    expect(session.getActiveToolNames()).toContain("scope_late");
    expect(session.getActiveToolNames()).not.toContain("scope_late_deferred");
    // Explicit activation of an allowed optional tool survives reconciliation.
    expect(session.getActiveToolNames()).toContain("scope_inactive");
    expect(session.getActiveToolNames()).toContain("tool_search");
    expect(session.getActiveToolNames()).not.toContain("scope_excluded");
    const driverResult = session.messages.find((m: any) => m.role === "toolResult" && m.toolName === "scope_driver");
    expect(driverResult.isError).not.toBe(true);
    expect(driverResult.details.denied.isError).toBe(true);
    expect(result).toBeDefined();

    // Resume the same session after runAgent's subscriptions have been cleaned up.
    faux.setResponses([call("scope_late_excluded"), call("scope_late"), fauxAssistantMessage("resumed")]);
    session.setActiveToolsByName([...session.getActiveToolNames(), "scope_late_excluded"]);
    await session.prompt("resume");
    expect(faux.state.callCount).toBe(5);
    expect(existsSync(join(cwd, "scope_excluded"))).toBe(false);
    expect(existsSync(join(cwd, "scope_late_excluded"))).toBe(false);
    expect(existsSync(join(cwd, "scope_late"))).toBe(true);
    expect(session.getActiveToolNames()).not.toContain("scope_excluded");
  } finally {
    session?.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
});
