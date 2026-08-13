import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
const extensionRoot = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), ".pi-toolkit-test-"));
const cleanup = () => rmSync(extensionRoot, { recursive: true, force: true });
process.on("exit", cleanup);
cpSync(join(sourceRoot, "index.ts"), join(extensionRoot, "index.ts"));
cpSync(join(sourceRoot, "pi-toolkit-lib"), join(extensionRoot, "pi-toolkit-lib"), { recursive: true });
writeFileSync(join(extensionRoot, "pi-toolkit.json"), JSON.stringify({
	compactTools: true,
	ctrlBackspace: true,
	dollarSkills: true,
}, null, 2));

const codingAgentEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { loadExtensions } = await import(new URL("./core/extensions/loader.js", codingAgentEntry));
const { initTheme } = await import(new URL("./modes/interactive/theme/theme.js", codingAgentEntry));
const { ToolExecutionComponent } = await import(new URL("./modes/interactive/components/tool-execution.js", codingAgentEntry));
const extensionPath = join(extensionRoot, "index.ts");

initTheme("dark");
const { extensions, errors } = await loadExtensions([extensionPath], extensionRoot);
assert.deepEqual(errors, []);

const extension = extensions[0];
const starts = extension.handlers.get("session_start");
const updates = extension.handlers.get("message_update");
const ends = extension.handlers.get("message_end");
let editorFactory;
let expanded = false;
const ui = {
	getToolsExpanded: () => expanded,
	setToolsExpanded: (value) => { expanded = value; },
	getEditorComponent: () => undefined,
	setEditorComponent: (factory) => { editorFactory = factory; },
};
const sessionManager = { buildSessionContext: () => ({ messages: [] }) };
await starts[1]({}, { ui, sessionManager });
await starts[2]({}, { mode: "tui", ui });

const toolCall = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
const output = (prefix, count = 20) => Array.from(
	{ length: count },
	(_, index) => `${prefix} line ${String(index + 1).padStart(2, "0")}`,
).join("\n");

const readArgs = { path: "demo.txt" };
const bashArgs = { command: "generate output" };
const writeArgs = { path: "written.txt", content: output("write") };
await updates[1]({ message: { role: "assistant", content: [
	toolCall("read-1", "read", readArgs),
	toolCall("bash-1", "bash", bashArgs),
	toolCall("write-1", "write", writeArgs),
] } });

const theme = { fg: (_color, text) => text, bold: (text) => text };
const states = { "read-1": {}, "bash-1": {}, "write-1": {} };
const invalidations = { "read-1": 0, "bash-1": 0, "write-1": 0 };
const context = (id, args, lastComponent) => ({
	args,
	toolCallId: id,
	invalidate: () => { invalidations[id]++; },
	lastComponent,
	state: states[id],
	cwd: extensionRoot,
	executionStarted: true,
	argsComplete: true,
	isPartial: false,
	expanded,
	showImages: true,
	isError: false,
});
const definition = (name) => extension.tools.get(name).definition;
const read = definition("read");
const bash = definition("bash");
const write = definition("write");
const find = definition("find");
const leader = read.renderCall(readArgs, theme, context("read-1", readArgs));
const bashFollower = bash.renderCall(bashArgs, theme, context("bash-1", bashArgs));
const writeFollower = write.renderCall(writeArgs, theme, context("write-1", writeArgs));
const rendered = () => leader.render(120).map((line) => line.trimEnd()).join("\n");

assert.match(rendered(), /read demo\.txt/);
assert.match(rendered(), /bash generate output/);
assert.match(rendered(), /write written\.txt/);
assert.doesNotMatch(rendered(), /read line 01/);
read.renderResult(
	{ content: [{ type: "text", text: output("read") }], details: {} },
	{ expanded, isPartial: false }, theme, context("read-1", readArgs),
);
bash.renderResult(
	{ content: [{ type: "text", text: output("bash") }], details: {} },
	{ expanded, isPartial: false }, theme, context("bash-1", bashArgs),
);
write.renderResult(
	{ content: [{ type: "text", text: "Successfully wrote file" }], details: {} },
	{ expanded, isPartial: false }, theme, context("write-1", writeArgs),
);
assert.deepEqual(bashFollower.render(120), []);
assert.deepEqual(writeFollower.render(120), []);
assert.match(rendered(), /tools 1 read · 1 bash · 1 write/);
assert.match(rendered(), /read demo\.txt/);
assert.match(rendered(), /bash generate output/);
assert.match(rendered(), /write written\.txt/);
assert.doesNotMatch(rendered(), /read line 01/);

const editor = editorFactory({ requestRender() {} }, {}, {
	matches: (data, action) => data === "\x0f" && action === "app.tools.expand",
});
editor.handleInput("\x0f");
assert.equal(expanded, false);
assert.match(rendered(), /^ tools 1 read · 1 bash · 1 write/m);
assert.match(
	rendered(),
	/   read line 01\n   read line 02\n   \.\.\. \(16 more lines\)\n   read line 19\n   read line 20\n\n ├ bash/,
);
assert.doesNotMatch(rendered(), /read line 03/);
assert.match(
	rendered(),
	/   bash line 01\n   bash line 02\n   \.\.\. \(16 more lines\)\n   bash line 19\n   bash line 20\n\n └ write/,
);
assert.doesNotMatch(rendered(), /bash line 03/);
assert.match(
	rendered(),
	/   write line 01\n   write line 02\n   \.\.\. \(16 more lines\)\n   write line 19\n   write line 20/,
);
assert.doesNotMatch(rendered(), /write line 03/);

editor.handleInput("\x0f");
assert.equal(expanded, true);
assert.match(rendered(), /read line 20/);
assert.match(rendered(), /bash line 01/);
assert.match(rendered(), /write line 20/);
editor.handleInput("\x0f");
assert.equal(expanded, false);
assert.doesNotMatch(rendered(), /read line 01/);

await ends[0]({ message: { role: "assistant", content: [
	toolCall("read-1", "read", readArgs),
	toolCall("bash-1", "bash", bashArgs),
	toolCall("write-1", "write", writeArgs),
] } });
const bash2Args = { command: "second turn" };
states["bash-2"] = {};
invalidations["bash-2"] = 0;
const continued = bash.renderCall(bash2Args, theme, context("bash-2", bash2Args));
assert.notEqual(continued.render(120).join("").trim(), "");
await updates[1]({ message: { role: "assistant", content: [
	{ type: "thinking", thinking: "" },
	toolCall("bash-2", "bash", bash2Args),
] } });
bash.renderResult(
	{ content: [{ type: "text", text: "second turn output" }], details: {} },
	{ expanded, isPartial: false }, theme, context("bash-2", bash2Args),
);
assert.equal(continued.render(120).join("").trim(), "");
assert.match(rendered(), /tools 1 read · 2 bash · 1 write/);

await ends[0]({ message: { role: "assistant", content: [toolCall("bash-2", "bash", bash2Args)] } });
const bash3Args = { command: "after thinking" };
await updates[1]({ message: { role: "assistant", content: [
	{ type: "thinking", thinking: "visible separator" },
	toolCall("bash-3", "bash", bash3Args),
] } });
states["bash-3"] = {};
invalidations["bash-3"] = 0;
const separated = bash.renderCall(bash3Args, theme, context("bash-3", bash3Args));
assert.notDeepEqual(separated.render(120), []);
assert.doesNotMatch(rendered(), /3 bash/);
await ends[0]({ message: { role: "user", content: "parallel boundary" } });

const parallel = Array.from({ length: 4 }, (_, index) => ({
	id: `parallel-${index + 1}`,
	args: { command: `parallel command ${index + 1}` },
}));
const singletonRows = parallel.map(({ id, args }) => {
	states[id] = {};
	invalidations[id] = 0;
	return bash.renderCall(args, theme, context(id, args));
});
for (const row of singletonRows) assert.notEqual(row.render(120).join("").trim(), "");
await updates[1]({ message: { role: "assistant", content: parallel.map(({ id, args }) =>
	toolCall(id, "bash", args)) } });
assert.notEqual(singletonRows[0].render(120).join("").trim(), "");
for (const row of singletonRows.slice(1)) assert.equal(row.render(120).join("").trim(), "");

await ends[0]({ message: { role: "user", content: "race boundary" } });
const raceFindArgs = { pattern: "*.ts" };
const raceReadArgs = { path: "race.txt" };
await ends[0]({ message: { role: "assistant", content: [
	toolCall("race-find", "find", raceFindArgs),
] } });
states["race-find"] = {};
invalidations["race-find"] = 0;
const raceLeader = find.renderCall(raceFindArgs, theme, context("race-find", raceFindArgs));
states["race-read"] = {};
invalidations["race-read"] = 0;
const raceFollower = read.renderCall(raceReadArgs, theme, context("race-read", raceReadArgs));
await updates[1]({ message: { role: "assistant", content: [
	toolCall("race-read", "read", raceReadArgs),
] } });
assert.match(raceLeader.render(120).join("\n"), /tools 1 find · 1 read/);
assert.equal(raceFollower.render(120).join("").trim(), "");

await ends[0]({ message: { role: "user", content: "mutable boundary" } });
const mutableAArgs = { command: "mutable A" };
const mutableBArgs = { command: "mutable B" };
states["mutable-a"] = {};
states["mutable-b"] = {};
invalidations["mutable-a"] = 0;
invalidations["mutable-b"] = 0;
const mutableA = bash.renderCall(mutableAArgs, theme, context("mutable-a", mutableAArgs));
const mutableB = bash.renderCall(mutableBArgs, theme, context("mutable-b", mutableBArgs));
await updates[1]({ message: { role: "assistant", content: [
	{ type: "thinking", thinking: "" },
	toolCall("mutable-a", "bash", mutableAArgs),
	toolCall("mutable-b", "bash", mutableBArgs),
] } });
assert.match(mutableA.render(120).join("\n"), /tools 2 bash/);
await updates[1]({ message: { role: "assistant", content: [
	{ type: "thinking", thinking: "became visible" },
	toolCall("mutable-a", "bash", mutableAArgs),
	toolCall("mutable-b", "bash", mutableBArgs),
] } });
assert.match(mutableA.render(120).join("\n"), /tools 2 bash/);
assert.doesNotMatch(raceLeader.render(120).join("\n"), /mutable/);

const replayMessages = [
	{ role: "assistant", content: [toolCall("replay-find", "find", { pattern: "*.ts" })] },
	{ role: "toolResult", toolCallId: "replay-find", toolName: "find", content: [{ type: "text", text: "a.ts" }], details: {}, isError: false },
	{ role: "assistant", content: [{ type: "thinking", thinking: "" }, toolCall("replay-read", "read", { path: "a.ts" })] },
	{ role: "toolResult", toolCallId: "replay-read", toolName: "read", content: [{ type: "text", text: "line" }], details: {}, isError: false },
];
await starts[1]({}, {
	ui,
	sessionManager: { buildSessionContext: () => ({ messages: replayMessages }) },
});
states["replay-find"] = {};
states["replay-read"] = {};
invalidations["replay-find"] = 0;
invalidations["replay-read"] = 0;
const replayLeader = find.renderCall({ pattern: "*.ts" }, theme, context("replay-find", { pattern: "*.ts" }));
const replayFollower = read.renderCall({ path: "a.ts" }, theme, context("replay-read", { path: "a.ts" }));
assert.match(replayLeader.render(120).join("\n"), /tools 1 find · 1 read/);
assert.equal(replayFollower.render(120).join("").trim(), "");

await ends[0]({ message: { role: "user", content: "real component boundary" } });
const realArgs = { command: "single real component" };
const realComponent = new ToolExecutionComponent(
	"bash",
	"real-bash",
	realArgs,
	{},
	bash,
	{ requestRender() {} },
	extensionRoot,
);
for (let index = 0; index < 10; index++) realComponent.updateArgs(realArgs);
realComponent.updateResult({
	content: [{ type: "text", text: "Command exited with code 1" }],
	isError: true,
});
const realRendered = realComponent.render(120).join("\n");
assert.equal(realRendered.match(/single real component/g)?.length ?? 0, 1, realRendered);
assert.equal(realRendered.match(/failed/g)?.length ?? 0, 1, realRendered);

cleanup();
console.log("grouped tool renderer verified");
