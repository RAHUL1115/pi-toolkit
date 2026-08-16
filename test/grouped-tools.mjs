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
	autoSessionTitles: true,
	compactTools: true,
	ctrlBackspace: true,
	dollarSkills: true,
}, null, 2));

const codingAgentEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { loadExtensions } = await import(new URL("./core/extensions/loader.js", codingAgentEntry));
const { getMarkdownTheme, initTheme, theme: globalTheme } = await import(new URL("./modes/interactive/theme/theme.js", codingAgentEntry));
const { ToolExecutionComponent } = await import(new URL("./modes/interactive/components/tool-execution.js", codingAgentEntry));
const { Markdown } = await import("@earendil-works/pi-tui");
const extensionPath = join(extensionRoot, "index.ts");

initTheme("dark");
const { extensions, errors } = await loadExtensions([extensionPath], extensionRoot);
assert.deepEqual(errors, []);

const extension = extensions[0];
assert(extension.commands.has("ptk-obs"));
assert(extension.commands.has("ptk"));
assert.equal(extension.handlers.get("agent_end")?.length, 2, "automatic titles add one agent_end handler when enabled");
assert(extension.tools.has("ask_user_question"));
const askUserQuestion = extension.tools.get("ask_user_question").definition;
const duplicateQuestion = "Choose a runtime?";
const invalidQuestionResult = await askUserQuestion.execute(
	"ask-invalid",
	{ questions: [
		{ question: duplicateQuestion, header: "Runtime", options: [{ label: "Node" }, { label: "Deno" }], multiSelect: false },
		{ question: duplicateQuestion, header: "Again", options: [{ label: "Node" }, { label: "Bun" }], multiSelect: false },
	] },
	undefined,
	undefined,
	{ mode: "tui" },
);
assert.match(invalidQuestionResult.content[0].text, /Duplicate question/);
assert(!extension.commands.has("ptk-settings"));
assert(!extension.commands.has("ptk-workflow-settings"));
const transformMarkdown = extension.markdownTransformer;
assert.equal(typeof transformMarkdown, "function");
const ansiPattern = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const renderMarkdown = (markdown, messageType, availableWidth = 120) => {
	const transformed = transformMarkdown(markdown, { isStreaming: false, availableWidth, messageType });
	return new Markdown(transformed, 0, 0, getMarkdownTheme())
		.render(availableWidth)
		.map((line) => line.replace(ansiPattern, "").trimEnd());
};
assert.deepEqual(renderMarkdown("hello", "user"), ["› hello"]);
const accentUser = transformMarkdown("hello", { isStreaming: false, availableWidth: 120, messageType: "user" });
assert(new Markdown(accentUser, 0, 0, getMarkdownTheme()).render(120)[0].startsWith(globalTheme.getFgAnsi("mdListBullet")));
assert.deepEqual(renderMarkdown("thinking", "assistant-thinking"), ["◦ thinking"]);
const transformedThinking = transformMarkdown("**Inspecting**", {
	isStreaming: false,
	availableWidth: 120,
	messageType: "assistant-thinking",
});
assert.doesNotMatch(transformedThinking, /\*\*/);
const renderedThinking = new Markdown(transformedThinking, 0, 0, getMarkdownTheme()).render(120)[0];
assert(renderedThinking.startsWith(globalTheme.getFgAnsi("dim")));
const dimThinking = globalTheme.fg("thinkingText", "thinking");
assert(dimThinking.startsWith(globalTheme.getFgAnsi("dim")));
assert.equal(globalTheme.italic(dimThinking), dimThinking);
assert.deepEqual(
	renderMarkdown("**Inspecting**\n\n**Reviewing**\n\n**Planning**", "assistant-thinking"),
	["◦ Inspecting", "  Reviewing", "  Planning"],
);
assert.deepEqual(
	renderMarkdown("**Inspecting**\n\nSupporting detail", "assistant-thinking"),
	["◦ Inspecting", "", "  Supporting detail"],
);
assert.deepEqual(renderMarkdown("answer", "assistant"), ["• answer"]);
const accentAssistant = transformMarkdown("answer", { isStreaming: false, availableWidth: 120, messageType: "assistant" });
assert(new Markdown(accentAssistant, 0, 0, getMarkdownTheme()).render(120)[0].startsWith(globalTheme.getFgAnsi("mdListBullet")));
assert.deepEqual(renderMarkdown("• literal bullet", "assistant"), ["• • literal bullet"]);
const hangingBlock = renderMarkdown([
	"The visible thinking block was:",
	"",
	"> A brief progress summary that wraps across the narrow transcript width.",
	"",
	"The explanation also wraps and stays aligned with the content column.",
].join("\n"), "assistant", 42);
assert(hangingBlock[0].startsWith("• "));
assert(hangingBlock.some((line) => line.startsWith("  │ ")));
assert(hangingBlock.slice(1).filter(Boolean).every((line) => line.startsWith("  ")));
assert.equal(globalTheme.fg("error", "Operation aborted").replace(ansiPattern, ""), "× Operation aborted");
const statusHarness = {
	showStatus(message) { return globalTheme.fg("dim", message).replace(ansiPattern, ""); },
};
assert.equal(statusHarness.showStatus("Reloaded resources"), " Reloaded resources");
const starts = extension.handlers.get("session_start");
const updates = extension.handlers.get("message_update");
const ends = extension.handlers.get("message_end");
await ends[1]({ message: {
	role: "assistant",
	content: [{ type: "text", text: "working" }, { type: "toolCall", id: "call-1", name: "read", arguments: {} }],
	stopReason: "toolUse",
} });
assert.deepEqual(renderMarkdown("working", "assistant"), ["• working"]);
await ends[1]({ message: {
	role: "assistant",
	content: [{ type: "text", text: "completed answer" }],
	stopReason: "stop",
} });
const separatedMarkdown = transformMarkdown("completed answer", {
	isStreaming: false,
	availableWidth: 120,
	messageType: "assistant",
});
assert(separatedMarkdown.startsWith(globalTheme.getFgAnsi("dim")));
const separatedAnswer = renderMarkdown("completed answer", "assistant", 120);
assert.equal(separatedAnswer[0], "─".repeat(120));
assert.equal(separatedAnswer.at(-1), "• completed answer");
await ends[1]({ message: { role: "user", content: [{ type: "text", text: "direct question" }] } });
await ends[1]({ message: {
	role: "assistant",
	content: [{ type: "text", text: "direct answer" }],
	stopReason: "stop",
} });
assert.deepEqual(renderMarkdown("direct answer", "assistant"), ["• direct answer"]);
await ends[1]({ message: { role: "user", content: [{ type: "text", text: "thinking question" }] } });
await ends[1]({ message: {
	role: "assistant",
	content: [{ type: "thinking", thinking: "work" }, { type: "text", text: "thoughtful answer" }],
	stopReason: "stop",
} });
assert(renderMarkdown("thoughtful answer", "assistant", 42)[0].startsWith("─"));
await starts[3]({}, { sessionManager: { buildSessionContext: () => ({ messages: [
	{ role: "user", content: [{ type: "text", text: "restored question" }] },
	{ role: "assistant", content: [{ type: "thinking", thinking: "work" }, { type: "toolCall", id: "call-2", name: "read", arguments: {} }], stopReason: "toolUse" },
	{ role: "toolResult", toolCallId: "call-2", toolName: "read", content: [{ type: "text", text: "result" }] },
	{ role: "assistant", content: [{ type: "text", text: "restored answer" }], stopReason: "stop" },
] }) } });
const restoredAnswer = renderMarkdown("restored answer", "assistant", 42);
assert(restoredAnswer[0].startsWith("─"));
assert.equal(restoredAnswer.at(-1), "• restored answer");
let editorFactory;
let expanded = false;
const notifications = [];
const widgets = new Map();
const ui = {
	getToolsExpanded: () => expanded,
	setToolsExpanded: (value) => { expanded = value; },
	notify: (message) => { notifications.push(message); },
	setWidget: (key, content) => { if (content === undefined) widgets.delete(key); else widgets.set(key, content); },
	getEditorComponent: () => undefined,
	setEditorComponent: (factory) => { editorFactory = factory; },
};
const sessionManager = { buildSessionContext: () => ({ messages: [] }) };
await starts[1]({}, { ui, sessionManager });
await starts[2]({}, { mode: "tui", ui });

const toolCall = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
const output = (prefix, count = 30) => Array.from(
	{ length: count },
	(_, index) => `${prefix} line ${String(index + 1).padStart(2, "0")}`,
).join("\n");

const readArgs = { path: "demo.txt" };
const bashArgs = { command: "generate output with a deliberately long set of arguments that wraps onto another visual line" };
const writeArgs = { path: "written.txt", content: output("write") };
await updates[1]({ message: { role: "assistant", content: [
	toolCall("read-1", "read", readArgs),
	toolCall("bash-1", "bash", bashArgs),
	toolCall("write-1", "write", writeArgs),
] } });

const foregrounds = [];
const theme = {
	fg: (color, text) => { foregrounds.push({ color, text }); return text; },
	bg: (_color, text) => text,
	bold: (text) => text,
};
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
const edit = definition("edit");
const write = definition("write");
const find = definition("find");
const leader = read.renderCall(readArgs, theme, context("read-1", readArgs));
const bashFollower = bash.renderCall(bashArgs, theme, context("bash-1", bashArgs));
const writeFollower = write.renderCall(writeArgs, theme, context("write-1", writeArgs));
const rendered = (width = 120) => {
	const lines = leader.render(width).map((line) => line.trimEnd());
	const outputPad = lines[0]?.startsWith(" ") ? 1 : 0;
	return lines.map((line) => outputPad && line.startsWith(" ") ? line.slice(1) : line).join("\n");
};
const leaderBlocks = () => leader.children[0]?.children ?? [];
const leaderHasBackground = () => leaderBlocks()[0]?.hasBackground ?? false;
const individualBackgrounds = () => leaderBlocks().filter((block) => block.hasBackground);

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
assert.equal(leaderHasBackground(), false);

expanded = true;
read.renderCall(readArgs, theme, context("read-1", readArgs, leader));
assert.match(rendered(), /read line 11/);
assert.equal(individualBackgrounds().length, 3);
expanded = false;
read.renderCall(readArgs, theme, context("read-1", readArgs, leader));
assert.doesNotMatch(rendered(), /read line 01/);
assert.equal(leaderHasBackground(), false);

const editor = editorFactory({ requestRender() {} }, {}, {
	matches: (data, action) => data === "\x0f" && action === "app.tools.expand",
});
assert.equal(editor.getPaddingX(), 1);
editor.setPaddingX(0);
assert.equal(editor.getPaddingX(), 1);
const longPaste = Array.from({ length: 11 }, (_, index) => `editable line ${index + 1}`).join("\n");
const pasteInput = `\x1b[200~${longPaste}\x1b[201~`;
editor.handleInput(pasteInput);
assert.match(editor.getText(), /^\[paste #1 \+11 lines\]$/);
assert.deepEqual(widgets.get("ptk-paste-hint"), ["Paste the same content again to expand it inline"]);
editor.handleInput(pasteInput);
assert.equal(editor.getText(), longPaste);
assert.equal(widgets.has("ptk-paste-hint"), false);
editor.handleInput("!");
assert.equal(editor.getText(), `${longPaste}!`);
editor.setText("");
editor.handleInput(pasteInput);
assert.equal(widgets.has("ptk-paste-hint"), true);
editor.handleInput("x");
assert.equal(widgets.has("ptk-paste-hint"), false);
editor.handleInput(pasteInput);
assert.match(editor.getText(), /^\[paste #1 \+11 lines\]x\[paste #2 \+11 lines\]$/);
assert.equal(widgets.has("ptk-paste-hint"), true);
editor.setText("");
assert.equal(widgets.has("ptk-paste-hint"), false);
editor.handleInput(pasteInput);
assert.equal(widgets.has("ptk-paste-hint"), true);
editor.handleInput("\x1b[D");
assert.equal(widgets.has("ptk-paste-hint"), false);
editor.setText("");

const cycleCollapsedKey = "\x1bo";
editor.handleInput(cycleCollapsedKey);
assert.equal(expanded, false);
assert.equal(notifications.at(-1), "Collapsed tool view: normal");
assert.equal(leaderBlocks().length, 1);
assert.equal(leaderHasBackground(), true);
assert.match(rendered(), /^• read demo\.txt 30 lines/m);
assert.match(
	rendered(),
	/  └ read line 01\n    read line 02[\s\S]*    read line 10\n    \.\.\. \(10 more lines\)\n    read line 21[\s\S]*    read line 30\n\n• bash/,
);
assert.doesNotMatch(rendered(), /read line 11/);
assert.match(rendered(), /  └ bash line 01\n    bash line 02\n    \.\.\. \(26 more lines\)\n    bash line 29\n    bash line 30/);
assert.doesNotMatch(rendered(), /bash line 03/);
assert.match(rendered(), /  └ write line 01\n    write line 02\n    \.\.\. \(26 more lines\)\n    write line 29\n    write line 30/);
assert.doesNotMatch(rendered(), /write line 03/);

assert.match(rendered(50), /\n  │ /);
editor.handleInput("\x0f");
assert.equal(expanded, true);
assert.equal(leaderHasBackground(), true);
assert.equal(individualBackgrounds().length, 3);
assert.match(rendered(), /read line 11/);
assert.match(rendered(), /bash line 30/);
assert.match(rendered(), /write line 30/);
editor.handleInput(cycleCollapsedKey);
assert.equal(expanded, true);
assert.equal(notifications.at(-1), "Collapsed tool view: normal");
assert.equal(individualBackgrounds().length, 3);
editor.handleInput("\x0f");
assert.equal(expanded, false);
assert.match(rendered(), /read line 01/);
editor.handleInput(cycleCollapsedKey);
assert.equal(notifications.at(-1), "Collapsed tool view: one line");
assert.match(rendered(), /• tools 1 read · 1 bash · 1 write/);
assert.doesNotMatch(rendered(), /demo\.txt|read line 01/);
editor.handleInput(cycleCollapsedKey);
assert.equal(notifications.at(-1), "Collapsed tool view: list");
assert.match(rendered(), /demo\.txt/);
assert.doesNotMatch(rendered(), /read line 01/);
editor.handleInput(cycleCollapsedKey);
assert.equal(notifications.at(-1), "Collapsed tool view: normal");
assert.match(rendered(), /read line 01/);

await ends[0]({ message: { role: "user", content: "diff color boundary" } });
const editArgs = { path: "colored.ts", edits: [{ oldText: "old", newText: "new" }] };
const editDiff = [
	"-1 old",
	"+1 new",
	...Array.from({ length: 26 }, (_, index) => ` ${index + 2} same`),
	"-29 tail-old",
	"+30 tail-new",
].join("\n");
states["edit-color"] = {};
invalidations["edit-color"] = 0;
const editLeader = edit.renderCall(editArgs, theme, context("edit-color", editArgs));
edit.renderResult(
	{ content: [{ type: "text", text: "Successfully replaced 1 block" }], details: { diff: editDiff } },
	{ expanded, isPartial: false }, theme, context("edit-color", editArgs),
);
foregrounds.length = 0;
editLeader.render(120);
assert(foregrounds.some(({ color, text }) => color === "toolDiffRemoved" && text.includes("-1 old")));
assert(foregrounds.some(({ color, text }) => color === "toolDiffAdded" && text.includes("+1 new")));
assert(foregrounds.some(({ color, text }) => color === "toolDiffContext" && text.includes("26 more lines")));
const editRendered = editLeader.render(120).join("\n");
assert.match(editRendered, /-1 old[\s\S]*\+1 new[\s\S]*\.\.\. \(26 more lines\)[\s\S]*-29 tail-old[\s\S]*\+30 tail-new/);
assert.doesNotMatch(editRendered, / 2 same/);
editor.handleInput(cycleCollapsedKey);
assert.equal(expanded, false);
assert.equal(notifications.at(-1), "Collapsed tool view: one line");
await ends[0]({ message: { role: "user", content: "end diff color test" } });

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
editor.handleInput(cycleCollapsedKey);
assert.equal(notifications.at(-1), "Collapsed tool view: list");

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

writeFileSync(join(extensionRoot, "pi-toolkit.json"), JSON.stringify({
	autoSessionTitles: false,
	compactTools: true,
	toolView: "compact",
	ctrlBackspace: true,
	dollarSkills: true,
}, null, 2));
const { extensions: oneLineExtensions, errors: oneLineErrors } = await loadExtensions([extensionPath], extensionRoot);
assert.deepEqual(oneLineErrors, []);
const oneLineExtension = oneLineExtensions[0];
assert.equal(oneLineExtension.handlers.get("agent_end")?.length, 1, "automatic titles register no handler when disabled");
const oneLineStarts = oneLineExtension.handlers.get("session_start");
const oneLineUpdates = oneLineExtension.handlers.get("message_update");
await oneLineStarts[1]({}, {
	ui: { getToolsExpanded: () => false },
	sessionManager: { buildSessionContext: () => ({ messages: [] }) },
});
await oneLineUpdates[1]({ message: { role: "assistant", content: [
	toolCall("one-line-read", "read", { path: "one-line.txt" }),
	toolCall("one-line-bash", "bash", { command: "echo one-line" }),
] } });
const oneLineStates = { "one-line-read": {}, "one-line-bash": {} };
const oneLineContext = (id, args) => ({
	...context(id, args),
	state: oneLineStates[id],
	invalidate() {},
});
const oneLineRead = oneLineExtension.tools.get("read").definition;
const oneLineBash = oneLineExtension.tools.get("bash").definition;
const oneLineLeader = oneLineRead.renderCall({ path: "one-line.txt" }, theme, oneLineContext("one-line-read", { path: "one-line.txt" }));
oneLineBash.renderCall({ command: "echo one-line" }, theme, oneLineContext("one-line-bash", { command: "echo one-line" }));
const oneLineRendered = oneLineLeader.render(120).join("\n");
assert.match(oneLineRendered, /• tools 1 read · 1 bash/);
assert.doesNotMatch(oneLineRendered, /one-line\.txt|echo one-line/);

cleanup();
console.log("grouped tool renderer verified");
