#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const sessionId = "fake-codex-session";
const selected = { model: "gpt-5.4", reasoning_effort: "medium" };
let cancelCurrent;
let steerCurrent;

const configOptions = () => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: selected.model,
    options: [
      { value: "gpt-5.4", name: "GPT-5.4" },
      { value: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
    ],
  },
  {
    id: "reasoning_effort",
    name: "Reasoning effort",
    category: "thought_level",
    type: "select",
    currentValue: selected.reasoning_effort,
    options: (selected.model === "gpt-5.4-mini"
      ? ["high", "xhigh"]
      : ["low", "medium"]
    ).map(value => ({ value, name: value })),
  },
];

const app = acp.agent({ name: "fake-codex-acp" })
  .onRequest(acp.methods.agent.initialize, ({ params }) => ({
    protocolVersion: params.protocolVersion,
    agentInfo: { name: "fake-codex-acp", version: "1.0.0" },
    agentCapabilities: { sessionCapabilities: { close: {} } },
    _meta: { steering: { supported: true } },
  }))
  .onRequest(acp.methods.agent.session.new, () => ({
    sessionId,
    configOptions: configOptions(),
  }))
  .onRequest(acp.methods.agent.session.setConfigOption, ({ params }) => {
    if (params.configId === "model" && typeof params.value === "string") selected.model = params.value;
    if (params.configId === "reasoning_effort" && typeof params.value === "string") {
      selected.reasoning_effort = params.value;
    }
    return { configOptions: configOptions() };
  })
  .onRequest(acp.methods.agent.session.close, () => {
    process.stderr.write("session-close\n");
    return {};
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const text = params.prompt.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
    if (text.includes("wait for cancel")) {
      await client.notify(acp.methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "waiting" } },
      });
      await new Promise(resolve => { cancelCurrent = resolve; });
      return { stopReason: "cancelled" };
    }
    if (text.includes("wait for steer")) {
      await client.notify(acp.methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ready" } },
      });
      await new Promise(resolve => { steerCurrent = resolve; });
      return { stopReason: "end_turn" };
    }

    await client.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } },
    });
    await client.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Read file",
        name: "read",
        kind: "read",
        status: "in_progress",
        rawInput: { path: "README.md" },
      },
    });
    const permission = await client.request(acp.methods.client.session.requestPermission, {
      sessionId,
      toolCall: { toolCallId: "tool-1", title: "Read file", kind: "read", status: "in_progress" },
      options: text.includes("permission always")
        ? [{ optionId: "always", name: "Allow always", kind: "allow_always" }]
        : [
            { optionId: "allow", name: "Allow once", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
    });
    await client.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: permission.outcome.outcome === "selected" ? "completed" : "failed",
        rawOutput: { ok: permission.outcome.outcome === "selected" },
      },
    });
    await client.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: text.includes("<worktree_isolation>")
            ? `worktree-safe (${selected.model}, ${selected.reasoning_effort})`
            : `codex done (${selected.model}, ${selected.reasoning_effort})`,
        },
      },
    });
    await client.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "usage_update", used: 50, size: 100 },
    });
    return {
      stopReason: "end_turn",
      usage: { totalTokens: 15, inputTokens: 10, outputTokens: 5, cachedWriteTokens: 2 },
    };
  })
  .onRequest("_session/steering", value => value, async ({ params, client }) => {
    const steerText = params.prompt[0]?.text ?? "";
    if (steerText === "fail steering") return { outcome: "failed" };
    if (steerText === "late steering") return { outcome: "startedNewTurn" };
    await client.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `steered: ${steerText}` },
      },
    });
    steerCurrent?.();
    steerCurrent = undefined;
    return { outcome: "injected" };
  })
  .onNotification(acp.methods.agent.session.cancel, () => {
    cancelCurrent?.();
    cancelCurrent = undefined;
  });

const connection = app.connect(
  acp.ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin),
  ),
);
await connection.closed;
