import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Optional run against the installed host SDK and its structured output:
// PI_CODING_AGENT_HOST_ENTRY=/absolute/path/to/pi-coding-agent/dist/index.js node test/economy-integration.mjs
const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
const entry = process.env.PI_CODING_AGENT_HOST_ENTRY ?? import.meta.resolve("@earendil-works/pi-coding-agent");
const codingAgentEntry = entry.startsWith("file:") ? new URL(entry) : pathToFileURL(entry);
const sdk = await import(codingAgentEntry);
const { loadExtensions } = await import(new URL("./core/extensions/loader.js", codingAgentEntry));
const { buildSystemPrompt } = await import(new URL("./core/system-prompt.js", codingAgentEntry));
const require = createRequire(codingAgentEntry);
function dependency(name) {
	const root = require.resolve.paths(name).map((path) => join(path, name, "dist"))
		.find((path) => existsSync(join(path, "index.js")));
	assert(root, `SDK dependency ${name} found`);
	return root;
}
const { runToolCall } = await import(pathToFileURL(join(dependency("@earendil-works/pi-agent-core"), "index.js")));
const codemodeRoot = dependency("@earendil-works/pi-codemode");
const { CodemodeSandbox } = await import(pathToFileURL(join(codemodeRoot, "index.js")));
const textOf = (result) => result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");

for (const compactTools of [true, false]) {
	const root = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), ".economy-integration-"));
	try {
		cpSync(join(sourceRoot, "index.ts"), join(root, "index.ts"));
		cpSync(join(sourceRoot, "pi-toolkit-lib"), join(root, "pi-toolkit-lib"), { recursive: true });
		writeFileSync(join(root, "pi-toolkit.json"), JSON.stringify({ compactTools, autoSessionTitles: false, dollarSkills: false }));
		writeFileSync(join(root, "large.txt"), Array.from({ length: 3000 }, (_, i) => `row ${i + 1} ${"é".repeat(40)}`).join("\n"));
		writeFileSync(join(root, "long-line.txt"), "x".repeat(20000));
		const nearCap = Array.from({ length: 160 }, () => "x".repeat(101));
		nearCap[159] += "x".repeat(44);
		writeFileSync(join(root, "near-cap.txt"), nearCap.join("\n") + "\nNEXT_SOURCE_LINE");
		const { extensions, runtime, errors } = await loadExtensions([join(root, "index.ts")], root);
		assert.deepEqual(errors, []);
		const extension = extensions[0];
		// Economy doesn't override read: the compact renderer alone registers it.
		assert.equal(extension.tools.has("read"), compactTools);
		const runner = new sdk.ExtensionRunner(extensions, runtime, root, sdk.SessionManager.inMemory(root), {});
		const hookErrors = [];
		runner.onError((error) => hookErrors.push(error));
		const promptResult = await runner.emitBeforeAgentStart("Inspect related files", undefined, { forceSystemPrompt: "Existing instructions", cwd: root });
		const systemPrompt = buildSystemPrompt(promptResult.systemPromptOptions);
		assert(systemPrompt.startsWith("Existing instructions"));
		assert(systemPrompt.includes("Economy reading policy"));
		assert(systemPrompt.includes('subagent_type="bulk-reader"'));
		assert(systemPrompt.includes("not file content"));
		const definition = extension.tools.get("read")?.definition ?? sdk.createReadToolDefinition(root);
		const read = sdk.wrapRegisteredTool({ definition, extensionPath: join(root, "index.ts") }, runner);
		let sequence = 0;
		let preparedArgs;
		const invoke = (args) => {
			const toolCall = { type: "toolCall", id: `read-${++sequence}`, name: "read", arguments: args };
			return runToolCall(toolCall, {
				tools: [read],
				assistantMessage: { role: "assistant", content: [toolCall] },
				context: { systemPrompt: "", messages: [], tools: [read] },
				beforeToolCall: async ({ toolCall, args }) => {
					const verdict = await runner.emitToolCall({ type: "tool_call", toolCallId: toolCall.id, toolName: "read", input: args });
					preparedArgs = { ...args }; // No economy argument mutation.
					return verdict;
				},
				afterToolCall: ({ toolCall, args, result, isError }) => runner.emitToolResult({
					...result, type: "tool_result", toolCallId: toolCall.id, toolName: "read", input: args, isError,
				}),
			});
		};
		const response = await invoke({ path: "large.txt" });
		assert.equal(response.isError, false);
		assert.deepEqual(preparedArgs, { path: "large.txt" }, "economy leaves native read arguments unchanged");
		const text = textOf(response.result);
		assert.equal(response.result.content.length, 1);
		assert(Buffer.byteLength(text.split("\n\n[Showing lines")[0]) <= 16384);
		assert(text.startsWith("row 1 "));
		assert.match(text, /16\.0KB economy limit/);
		if ("structuredContent" in response.result) assert.equal(response.result.structuredContent, text);
		const sandbox = new CodemodeSandbox({ tools: [{
			name: "read",
			execute: async (args) => {
				const outcome = await invoke(args);
				if (outcome.isError) throw new Error(outcome.result.content[0].text);
				return outcome.result.structuredContent ?? outcome.result.content[0].text;
			},
		}] });
		try {
			// No source transformation. Routine capped reads are fulfilled, not rejected.
			const code = 'const results = await Promise.allSettled([tools.read({path:"large.txt"}), tools.read({path:"large.txt",offset:500,limit:500})]); text(results); return results;';
			const event = { type: "tool_call", toolName: "codemode", toolCallId: "batch", input: { code } };
			await runner.emitToolCall(event);
			assert.equal(event.input.code, code, "economy never rewrites codemode source");
			const batch = await sandbox.execute(code);
			assert.equal(batch.ok, true);
			for (const result of batch.value) {
				assert.equal(result.status, "fulfilled");
				assert(Buffer.byteLength(result.value.split("\n\n[Showing lines")[0]) <= 16384);
			}
			assert(batch.value[1].value.startsWith("row 500 "));
		} finally {
			await sandbox.close();
		}
		const near = await invoke({ path: "near-cap.txt", limit: 160 });
		assert.equal(near.isError, false);
		assert(textOf(near.result).includes("offset=161"), "native footer does not count as a source line");
		assert.equal(textOf((await invoke({ path: "near-cap.txt", offset: 161 })).result), "NEXT_SOURCE_LINE");
		const long = await invoke({ path: "long-line.txt" });
		assert.equal(long.isError, false, "native-style read warnings aren't economy blocks");
		assert.match(long.result.content[0].text, /Line 1 is/);
		assert.match(long.result.content[0].text, /exceeds 16\.0KB limit/);
		assert.equal((await invoke({ path: "missing.txt" })).isError, true);
		const agentDefinition = extension.tools.get("Agent").definition;
		await extension.commands.get("economy").handler("off", runner.createCommandContext());
		assert.equal(extension.tools.get("Agent").definition, agentDefinition, "economy toggle never disables agent registration");
		const off = await invoke({ path: "large.txt" });
		const native = await definition.execute("native", { path: "large.txt" }, undefined, undefined, runner.createToolContext("native"));
		assert.equal(textOf(off.result), textOf(native));
		assert.equal(off.result.structuredContent, native.structuredContent);
		const offPrompt = await runner.emitBeforeAgentStart("Read files", undefined, { forceSystemPrompt: "Existing instructions", cwd: root });
		assert.equal(buildSystemPrompt(offPrompt.systemPromptOptions), systemPrompt, "economy off preserves the exact system prompt");
		await extension.commands.get("economy").handler("on", runner.createCommandContext());
		const onPrompt = await runner.emitBeforeAgentStart("Read files", undefined, { forceSystemPrompt: "Existing instructions", cwd: root });
		assert.equal(buildSystemPrompt(onPrompt.systemPromptOptions), systemPrompt, "economy on preserves the exact system prompt");
		assert(textOf((await invoke({ path: "large.txt" })).result).includes("16.0KB economy limit"));
		assert.deepEqual(hookErrors, [], "real extension dispatcher didn't swallow hook failures");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
console.log("Minimal economy result adapter + unchanged native inputs/codemode verified, compact tools on/off.");
