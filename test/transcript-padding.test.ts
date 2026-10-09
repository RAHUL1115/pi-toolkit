import { describe, expect, it, vi } from "vitest";
import { AssistantMessageComponent, InteractiveMode, UserMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { runInChildSessionContext } from "../pi-toolkit-lib/unified-subagents/child-context.js";
import { installTranscriptPadding, registerTranscriptPadding, TOOLKIT_OUTPUT_PADDING_X } from "../pi-toolkit-lib/transcript-padding.js";

class Container {
	children: any[] = [];
	addChild(child: any) { this.children.push(child); return child; }
}
class Message {
	outputPad: number;
	calls = 0;
	constructor(padding: number) { this.outputPad = padding; }
	setOutputPad(padding: number) { this.outputPad = padding; this.calls++; }
}
class ThemedText {
	paddingX: number;
	build = () => "notice";
	invalidations = 0;
	constructor(padding: number) { this.paddingX = padding; }
	setPaddingX(padding: number) { this.paddingX = padding; this.invalidate(); }
	invalidate() { this.invalidations++; }
}
function fixture(raw = 0) {
	// A fresh prototype per test, just as distinct hosts have separate identities.
	class Host {
		outputPad = raw;
		chatContainer = new Container();
		pendingMessagesContainer = new Container();
		settings = { outputPad: raw };
		applyCalls = 0;
		applyRuntimeSettings() { this.applyCalls++; this.outputPad = this.settings.outputPad; }
		changeSetting(padding: number) {
			this.settings.outputPad = padding;
			this.outputPad = padding;
			for (const container of [this.chatContainer, this.pendingMessagesContainer]) {
				for (const child of container.children) child.setOutputPad?.(padding);
			}
		}
	}
	return { Host, host: new Host() };
}

describe("transcript padding", () => {
	it.each([0, 1])("renders real native messages with native %i, on/off and narrow wrapping", (raw) => {
		initTheme("dark", false);
		const { Host, host } = fixture(raw);
		const text = "alpha beta gamma delta epsilon zeta eta theta";
		const assistant = { role: "assistant", content: [{ type: "text", text }], api: "openai-completions",
			provider: "openai", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
				totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop", timestamp: 0 } as const;
		const user = new UserMessageComponent(text, undefined, raw);
		const response = new AssistantMessageComponent(assistant as any, false, undefined, undefined, raw);
		host.chatContainer.addChild(user);
		host.pendingMessagesContainer.addChild(response);
		const cleanup = installTranscriptPadding(Host.prototype, true);
		host.applyRuntimeSettings();
		for (const width of [12, 40]) {
			for (const [actual, expected] of [[user, new UserMessageComponent(text, undefined, 1)],
				[response, new AssistantMessageComponent(assistant as any, false, undefined, undefined, 1)]] as const) {
				const lines = actual.render(width);
				expect(lines.map(stripAnsi)).toEqual(expected.render(width).map(stripAnsi));
				expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			}
		}
		host.changeSetting(0);
		cleanup();
		for (const width of [12, 40]) {
			expect(user.render(width).map(stripAnsi)).toEqual(new UserMessageComponent(text, undefined, 0).render(width).map(stripAnsi));
			expect(response.render(width).map(stripAnsi)).toEqual(new AssistantMessageComponent(assistant as any, false, undefined, undefined, 0).render(width).map(stripAnsi));
		}
	});

	it("skips child-session registration without acquiring ownership or a shutdown callback", async () => {
		const pi = { on: vi.fn() };
		registerTranscriptPadding(pi as any, true);
		const hook = InteractiveMode.prototype.applyRuntimeSettings;
		await runInChildSessionContext(async () => { registerTranscriptPadding(pi as any, false); });
		expect(pi.on).toHaveBeenCalledTimes(1);
		expect(InteractiveMode.prototype.applyRuntimeSettings).toBe(hook);
		await pi.on.mock.calls[0][1]();
	});

	it.each([0, 1])("ignores native %i while enabled without rewriting settings", (raw) => {
		const { Host, host } = fixture(raw);
		const cleanup = installTranscriptPadding(Host.prototype, true);
		host.applyRuntimeSettings();
		expect(host.outputPad).toBe(TOOLKIT_OUTPUT_PADDING_X);
		expect(host.settings).toEqual({ outputPad: raw });
		cleanup();
		expect(host.outputPad).toBe(raw);
	});

	it("covers history, pending, streaming, tools and future messages, but not nested or unrelated UI", () => {
		const { Host, host } = fixture();
		const history = host.chatContainer.addChild(new Message(0));
		const pending = host.pendingMessagesContainer.addChild(new Message(0));
		const notice = host.chatContainer.addChild(new ThemedText(0));
		const nested = new ThemedText(0);
		host.chatContainer.addChild({ children: [nested] });
		const editor = new ThemedText(0);
		const cleanup = installTranscriptPadding(Host.prototype, true);
		host.applyRuntimeSettings();
		const streaming = host.chatContainer.addChild(new Message(host.outputPad));
		const tool = host.chatContainer.addChild(new Message(host.outputPad));
		const futurePending = host.pendingMessagesContainer.addChild(new Message(host.outputPad));
		const futureNotice = host.chatContainer.addChild(new ThemedText(host.outputPad));
		for (const message of [history, pending, streaming, tool, futurePending]) {
			expect(message.outputPad).toBe(1);
			message.setOutputPad(0);
			expect(message.outputPad).toBe(1);
		}
		notice.setPaddingX(0);
		futureNotice.setPaddingX(0);
		expect(notice.paddingX).toBe(1);
		expect(futureNotice.paddingX).toBe(1);
		expect(nested.paddingX).toBe(0);
		expect(editor.paddingX).toBe(0);
		cleanup();
		for (const message of [history, pending, streaming, tool, futurePending]) expect(message.outputPad).toBe(0);
		expect(notice.paddingX).toBe(0);
		expect(futureNotice.paddingX).toBe(0);
		expect(Object.hasOwn(history, "setOutputPad")).toBe(false);
		expect(Object.hasOwn(host.chatContainer, "addChild")).toBe(false);
	});

	it("restores history and future notices to the latest host native setting", () => {
		const { Host, host } = fixture(0);
		const historyNotice = host.chatContainer.addChild(new ThemedText(0));
		const cleanup = installTranscriptPadding(Host.prototype, true);
		host.applyRuntimeSettings();
		const notice = host.chatContainer.addChild(new ThemedText(host.outputPad));
		host.changeSetting(1);
		cleanup();
		expect(notice.paddingX).toBe(1);
		expect(historyNotice.paddingX).toBe(1);
	});

	it("remembers live settings and restores original descriptors on disable", () => {
		const { Host, host } = fixture(1);
		const originalDescriptor = Object.getOwnPropertyDescriptor(host, "outputPad");
		const child = host.chatContainer.addChild(new Message(1));
		const cleanup = installTranscriptPadding(Host.prototype, true);
		host.applyRuntimeSettings();
		host.changeSetting(0);
		expect(host.settings.outputPad).toBe(0);
		expect(host.outputPad).toBe(1);
		expect(child.outputPad).toBe(1);
		const offCleanup = installTranscriptPadding(Host.prototype, false);
		expect(host.outputPad).toBe(0);
		expect(child.outputPad).toBe(0);
		expect(Object.getOwnPropertyDescriptor(host, "outputPad")).toEqual({ ...originalDescriptor, value: 0 });
		cleanup(); // Stale shutdown cannot disable the new registration.
		host.changeSetting(1);
		expect(child.outputPad).toBe(1);
		offCleanup();
	});

	it("enables in the factory before replay and does not stack through two reload cycles", () => {
		const { Host, host } = fixture();
		const initialCleanup = installTranscriptPadding(Host.prototype, false);
		const hook = Host.prototype.applyRuntimeSettings;
		host.applyRuntimeSettings();
		let previous = initialCleanup;
		for (let cycle = 0; cycle < 2; cycle++) {
			const cleanup = installTranscriptPadding(Host.prototype, true);
			previous();
			expect(host.outputPad).toBe(1);
			const replay = host.chatContainer.addChild(new Message(host.outputPad));
			const calls = replay.calls;
			replay.setOutputPad(0);
			expect(replay.calls).toBe(calls + 1);
			expect(Host.prototype.applyRuntimeSettings).toBe(hook);
			host.applyRuntimeSettings();
			expect(host.applyCalls).toBe(cycle + 2);
			previous = cleanup;
		}
		previous();
		expect(host.outputPad).toBe(0);
		for (const child of host.chatContainer.children) {
			expect(child.outputPad).toBe(0);
			expect(child.setOutputPad).toBe(Message.prototype.setOutputPad);
		}
	});

	it.each(["container", "field", "lockedContainer"])("fails closed for malformed runtime: %s", (shape) => {
		const { Host, host } = fixture();
		const child = host.chatContainer.addChild(new Message(0));
		if (shape === "container") (host as any).pendingMessagesContainer = { children: [] };
		if (shape === "field") Object.defineProperty(host, "outputPad", { configurable: false, value: 0 });
		if (shape === "lockedContainer") Object.preventExtensions(host.pendingMessagesContainer);
		const before = Object.getOwnPropertyDescriptors(host);
		const cleanup = installTranscriptPadding(Host.prototype, true);
		host.applyRuntimeSettings();
		expect(Object.getOwnPropertyDescriptors(host)).toEqual({ ...before, applyCalls: { ...before.applyCalls, value: 1 } });
		expect(child.outputPad).toBe(0);
		expect(child.setOutputPad).toBe(Message.prototype.setOutputPad);
		expect(host.chatContainer.addChild).toBe(Container.prototype.addChild);
		cleanup();
	});

	it("restores latest native values when the active host changes", () => {
		const { Host, host } = fixture();
		const cleanup = installTranscriptPadding(Host.prototype, true);
		host.applyRuntimeSettings();
		const second = new Host();
		second.applyRuntimeSettings();
		expect(host.outputPad).toBe(0);
		expect(second.outputPad).toBe(1);
		cleanup();
		expect(second.outputPad).toBe(0);
	});

	it("registers shutdown cleanup using the package-root InteractiveMode identity", async () => {
		const callbacks: Array<() => Promise<void>> = [];
		const pi = { on: vi.fn((_event, callback) => callbacks.push(callback)) };
		registerTranscriptPadding(pi as any, true);
		const hook = InteractiveMode.prototype.applyRuntimeSettings;
		registerTranscriptPadding(pi as any, true);
		expect(InteractiveMode.prototype.applyRuntimeSettings).toBe(hook);
		expect(pi.on.mock.calls.map(([event]) => event)).toEqual(["session_shutdown", "session_shutdown"]);
		await callbacks[0]();
		await callbacks[1]();
	});
});
