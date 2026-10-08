import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
	Editor, Input, KeybindingsManager, TUI_KEYBINDINGS, getKeybindings, setKeybindings,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installWordDeleteAlias, maintainWordDeleteAlias } from "../pi-toolkit-lib/editor-keybindings.js";

const ACTION = "tui.editor.deleteWordBackward";
const CTRL_W = "\x17";
const CTRL_BACKSPACE = "\x1b[127;5u";
const theme = {
	borderColor: (text: string) => text,
	selectList: {
		selectedPrefix: (text: string) => text,
		selectedText: (text: string) => text,
		description: (text: string) => text,
		scrollInfo: (text: string) => text,
		noMatch: (text: string) => text,
	},
};

let previous: KeybindingsManager;
let manager: KeybindingsManager;
beforeEach(() => {
	previous = getKeybindings();
	manager = new KeybindingsManager(TUI_KEYBINDINGS);
	setKeybindings(manager);
	for (const name of ["WT_SESSION", "SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"]) vi.stubEnv(name, "");
});
afterEach(() => {
	setKeybindings(previous);
	vi.unstubAllEnvs();
});

function editor(): Editor {
	return new Editor({ requestRender: vi.fn() } as any, theme);
}

const cases = [
	{ text: "hello world", setup: [] },
	{ text: "hello world", setup: ["\x1b[D", "\x1b[D"] },
	{ text: "hello world", setup: ["\x01"] },
	{ text: "hello   ", setup: [] },
	{ text: "hello, world!", setup: [] },
	{ text: "hello\nworld", setup: [] },
	{ text: "hello\nworld", setup: ["\x01"] },
	{ text: "", setup: [] },
];

describe("Ctrl+Backspace word-delete alias", () => {
	it("survives Pi reloading user bindings after session_start", () => {
		let beforeInput: (() => undefined) | undefined;
		const unsubscribe = vi.fn();
		const cleanup = maintainWordDeleteAlias(manager, (handler) => {
			beforeInput = handler;
			return unsubscribe;
		});
		// InteractiveMode.handleReload calls keybindings.reload AFTER session_start.
		manager.setUserBindings({ "tui.editor.cursorLeft": "left" });
		expect(manager.matches(CTRL_BACKSPACE, ACTION)).toBe(false);
		expect(beforeInput?.()).toBeUndefined(); // listener does not consume or rewrite input
		const input = new Input();
		input.setValue("hello world");
		input.handleInput("\x05");
		input.handleInput(CTRL_BACKSPACE);
		expect(input.getValue()).toBe("hello ");
		cleanup();
		expect(unsubscribe).toHaveBeenCalledOnce();
		expect(manager.getUserBindings()).toEqual({ "tui.editor.cursorLeft": "left" });
	});
	it("adds an alias without replacing Ctrl+W or Alt+Backspace", () => {
		const restore = installWordDeleteAlias(manager);
		expect(manager.getKeys(ACTION)).toEqual(["ctrl+w", "alt+backspace", "ctrl+backspace"]);
		expect(manager.matches(CTRL_W, ACTION)).toBe(true);
		expect(manager.matches("\x1b\x7f", ACTION)).toBe(true);
		restore();
		expect(manager.getUserBindings()).toEqual({});
	});

	it.each(cases)("matches built-in deletion and yank/undo for $text / $setup", ({ text, setup }) => {
		installWordDeleteAlias(manager);
		const actual = editor();
		const reference = editor();
		for (const e of [actual, reference]) {
			e.setText(text);
			for (const key of setup) e.handleInput(key);
		}
		actual.handleInput(CTRL_BACKSPACE);
		reference.handleInput(CTRL_W);
		expect(actual.getText()).toBe(reference.getText());
		expect(actual.getCursor()).toEqual(reference.getCursor());
		for (const key of ["\x19", "\x1f"]) { // built-in yank and undo
			actual.handleInput(key);
			reference.handleInput(key);
			expect(actual.getText()).toBe(reference.getText());
			expect(actual.getCursor()).toEqual(reference.getCursor());
		}
	});

	it("works through CustomEditor and in shared single-line inputs", () => {
		installWordDeleteAlias(manager);
		const main = new CustomEditor({ requestRender: vi.fn() } as any, theme, manager);
		main.setText("hello world");
		main.handleInput(CTRL_BACKSPACE);
		expect(main.getText()).toBe("hello ");
		const input = new Input();
		input.setValue("hello world");
		input.handleInput("\x05"); // Input.setValue preserves the initial cursor at zero.
		input.handleInput(CTRL_BACKSPACE);
		expect(input.getValue()).toBe("hello ");
	});

	it.each(["\x1b[127;5u", "\x1b[127;5:1u", "\x1b[27;5;127~"])(
		"handles explicit terminal encoding %j", (sequence) => {
			installWordDeleteAlias(manager);
			const e = editor();
			e.setText("hello world");
			e.handleInput(sequence);
			expect(e.getText()).toBe("hello ");
		},
	);

	it.each(["\x7f", "\x08", "\x1b[127u"])("keeps plain Backspace %j character-only", (sequence) => {
		installWordDeleteAlias(manager);
		const e = editor();
		e.setText("hello world");
		e.handleInput(sequence);
		expect(e.getText()).toBe("hello worl");
	});

	it("supports Windows Terminal legacy Ctrl+Backspace without changing DEL", () => {
		vi.stubEnv("WT_SESSION", "test-session");
		installWordDeleteAlias(manager);
		const e = editor();
		e.setText("hello world");
		e.handleInput("\x08");
		expect(e.getText()).toBe("hello ");
		e.setText("hello world");
		e.handleInput("\x7f");
		expect(e.getText()).toBe("hello worl");
	});

	it("does not reinterpret raw Backspace over SSH", () => {
		vi.stubEnv("WT_SESSION", "test-session");
		vi.stubEnv("SSH_CONNECTION", "test-connection");
		installWordDeleteAlias(manager);
		expect(manager.matches("\x08", ACTION)).toBe(false);
	});

	it("preserves custom bindings and restores them on cleanup", () => {
		manager.setUserBindings({ [ACTION]: "ctrl+d" });
		const restore = installWordDeleteAlias(manager);
		expect(manager.getKeys(ACTION)).toEqual(["ctrl+d", "ctrl+backspace"]);
		manager.setUserBindings({ ...manager.getUserBindings(), "tui.editor.cursorLeft": "left" });
		restore();
		expect(manager.getUserBindings()).toEqual({ [ACTION]: "ctrl+d", "tui.editor.cursorLeft": "left" });
	});

	it("respects explicit disablement and other user assignments", () => {
		manager.setUserBindings({ [ACTION]: [] });
		installWordDeleteAlias(manager)();
		expect(manager.getKeys(ACTION)).toEqual([]);
		manager.setUserBindings({ "tui.editor.deleteCharBackward": "ctrl+backspace" });
		installWordDeleteAlias(manager)();
		expect(manager.getKeys(ACTION)).not.toContain("ctrl+backspace");
	});

	it("is idempotent and leaves later word-delete changes alone", () => {
		const restore = installWordDeleteAlias(manager);
		installWordDeleteAlias(manager)();
		expect(manager.getKeys(ACTION).filter((key) => key === "ctrl+backspace")).toHaveLength(1);
		manager.setUserBindings({ [ACTION]: "alt+w" });
		restore();
		expect(manager.getUserBindings()).toEqual({ [ACTION]: "alt+w" });
	});

	it("retains an alias already configured by the user", () => {
		manager.setUserBindings({ [ACTION]: ["ctrl+w", "ctrl+backspace"] });
		installWordDeleteAlias(manager)();
		expect(manager.getKeys(ACTION)).toEqual(["ctrl+w", "ctrl+backspace"]);
	});
});
