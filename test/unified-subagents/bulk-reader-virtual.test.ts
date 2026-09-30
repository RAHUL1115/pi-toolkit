import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { AssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { registerLiteVirtualModel } from "../../pi-toolkit-lib/session-title.js";
import { registerAgents } from "../../pi-toolkit-lib/unified-subagents/agent-types.js";
import { runAgent } from "../../pi-toolkit-lib/unified-subagents/agent-runner.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

it("routes the isolated bulk reader through ptk/lite without loading child extensions", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ptk-bulk-virtual-"));
  writeFileSync(join(cwd, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = cwd;
  const faux = registerFauxProvider({ provider: "ptk-bulk-test", models: [{ id: "test-luna", contextWindow: 200_000 }] });
  let parent: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let child: Awaited<ReturnType<typeof runAgent>>["session"] | undefined;
  try {
    registerAgents(new Map());
    const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
    const physical = faux.getModel();
    runtime.registerProvider(physical.provider, { apiKey: "faux", api: physical.api, models: [{ ...physical, name: "Test Luna" }] });
    const routed = vi.spyOn(runtime, "resolveModel");
    // Only the network transport is scripted; session, auth and virtual routing are real.
    const streamed = vi.spyOn(runtime, "streamSimple").mockImplementation(model => {
      expect(model.provider).toBe(physical.provider);
      expect(model.id).toBe(physical.id);
      const message = { ...fauxAssistantMessage("Inspected safely through Lite."), provider: model.provider, model: model.id, api: model.api };
      const stream = new AssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message }); stream.end(); });
      return stream;
    });
    let ctx: any;
    const loader = new DefaultResourceLoader({
      cwd, agentDir: cwd, noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true,
      extensionFactories: [pi => {
        registerLiteVirtualModel(pi);
        pi.on("session_start", (_event, context) => { ctx = context; });
      }],
    });
    await loader.reload();
    ({ session: parent } = await createAgentSession({
      cwd, agentDir: cwd, resourceLoader: loader, modelRuntime: runtime,
      model: runtime.getModel(physical.provider, physical.id), tools: [],
      sessionManager: SessionManager.inMemory(cwd), settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    }));
    await parent.bindExtensions({});
    expect(ctx.modelRegistry.runtime).toBe(runtime);
    const alias = runtime.getModel("ptk", "lite")!;
    expect(alias.api).toBe("pi-virtual");
    vi.spyOn(runtime, "getAvailableSnapshot").mockReturnValue([runtime.getModel(physical.provider, physical.id)!, alias]);
    const result = await runAgent(ctx, "bulk-reader", "Inspect the supplied question without modifying files.", { persistSession: false });
    child = result.session;
    expect(result.failure).toBeUndefined();
    expect(result.responseText).toBe("Inspected safely through Lite.");
    expect(routed).toHaveBeenCalledWith(expect.objectContaining({ provider: "ptk", id: "lite" }), expect.any(Array), expect.objectContaining({ reason: "user", thinkingLevel: "low" }));
    expect(streamed).toHaveBeenCalledOnce();
    expect(child.model?.provider).toBe("ptk");
    expect(child.model?.id).toBe("lite");
    expect(child.resourceLoader.getExtensions().extensions).toEqual([]);
    expect(child.getActiveToolNames().sort()).toEqual(["find", "grep", "ls", "read"]);
    expect(child.messages.find(message => message.role === "assistant")).toMatchObject({ provider: physical.provider, model: physical.id });
  } finally {
    child?.dispose(); parent?.dispose(); faux.unregister(); vi.restoreAllMocks();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30_000);
