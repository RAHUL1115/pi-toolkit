import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Real extension loader/dispatcher + real filesystem tools. No provider/model calls.
// Optional: PI_CODING_AGENT_HOST_ENTRY=/installed/pi/dist/index.js node test/analytics-integration.mjs
const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
const root = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), ".analytics-integration-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
try {
  mkdirSync(process.env.PI_CODING_AGENT_DIR);
  const entry = process.env.PI_CODING_AGENT_HOST_ENTRY ?? import.meta.resolve("@earendil-works/pi-coding-agent");
  const url = entry.startsWith("file:") ? new URL(entry) : pathToFileURL(entry);
  const sdk = await import(url);
  const { loadExtensions } = await import(new URL("./core/extensions/loader.js", url));
  const require = createRequire(url);
  const core = require.resolve.paths("@earendil-works/pi-agent-core").map(path => join(path, "@earendil-works/pi-agent-core/dist/index.js")).find(existsSync);
  assert(core, "host SDK agent-core found");
  const { runToolCall } = await import(pathToFileURL(core));
  const { extensions, runtime, errors } = await loadExtensions([join(sourceRoot, "pi-toolkit-lib/analytics/register.ts")], root);
  assert.deepEqual(errors, []);
  assert.equal(extensions.length, 1);
  const manager = sdk.SessionManager.inMemory(root);
  const runner = new sdk.ExtensionRunner(extensions, runtime, root, manager, {});
  const hookErrors = [];
  runner.onError(error => hookErrors.push(error));
  const command = extensions[0].commands.get("ptk-analytics");
  assert(command);
  await runner.emit({ type: "session_start", reason: "startup" });
  const store = join(process.env.PI_CODING_AGENT_DIR, "analytics");
  assert.deepEqual(readdirSync(process.env.PI_CODING_AGENT_DIR), []);
  await command.handler("enable", runner.createCommandContext());
  mkdirSync(join(root, "tdd"));
  writeFileSync(join(root, "tdd/SKILL.md"), "---\nname: tdd\n---\nprivate fixture body");
  const read = sdk.wrapRegisteredTool({ definition: sdk.createReadToolDefinition(root), extensionPath: "fixture" }, runner);
  let n = 0;
  for (const path of ["missing.txt", "tdd/SKILL.md"]) {
    const call = { type: "toolCall", id: `read-${++n}`, name: "read", arguments: { path } };
    const assistant = { role: "assistant", timestamp: n * 10, stopReason: "toolUse", provider: "fixture", model: "no-network", content: [call] };
    await runner.emitMessageEnd({ type: "message_end", message: assistant });
    await runner.emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
    const outcome = await runToolCall(call, { tools: [read], assistantMessage: assistant,
      context: { systemPrompt: "", messages: [], tools: [read] },
      beforeToolCall: ({ args }) => runner.emitToolCall({ type: "tool_call", toolCallId: call.id, toolName: "read", input: args }),
      afterToolCall: ({ args, result, isError }) => runner.emitToolResult({ ...result, type: "tool_result", toolCallId: call.id, toolName: "read", input: args, isError }),
    });
    assert.equal(outcome.isError, n === 1);
    await runner.emit({ type: "tool_execution_end", toolCallId: call.id, toolName: "read", result: outcome.result, isError: outcome.isError, durationMs: outcome.durationMs });
    await runner.emitMessageEnd({ type: "message_end", message: { role: "toolResult", toolCallId: call.id, toolName: "read", timestamp: n * 10 + 1, content: outcome.result.content, details: outcome.result.details, isError: outcome.isError } });
  }
  await runner.emit({ type: "agent_settled" });
  await command.handler("report", runner.createCommandContext());
  const report = JSON.parse(readFileSync(join(store, "latest-report.json"), "utf8"));
  assert.equal(report.totals.toolCalls, 2);
  assert.equal(report.totals.toolErrors, 1);
  assert.equal(report.bySkill[0].skill, "tdd");
  const records = readdirSync(store).filter(name => name.endsWith(".jsonl")).map(name => readFileSync(join(store, name), "utf8")).join("");
  assert(!records.includes("private fixture body"));
  assert(!records.includes("missing.txt"));
  assert(!records.includes(root));
  await runner.emit({ type: "session_shutdown", reason: "quit" });
  assert.deepEqual(hookErrors, []);
  console.log("Analytics real loader/dispatch + filesystem error/skill capture verified (no model calls).");
} finally {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
}
