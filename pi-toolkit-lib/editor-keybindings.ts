import { type KeybindingsManager, type KeyId } from "@earendil-works/pi-tui";

const WORD_DELETE = "tui.editor.deleteWordBackward";
const CTRL_BACKSPACE: KeyId = "ctrl+backspace";

type InputListener = (handler: () => undefined) => () => void;

/** Own the runtime alias and input listener for one TUI session. */
export function maintainWordDeleteAlias(keybindings: KeybindingsManager, listen: InputListener): () => void {
	let restore = installWordDeleteAlias(keybindings);
	const unsubscribe = listen(() => {
		// Pi reloads keybindings after session_start. Repair before dispatching input
		// so both the main editor and dialog Input components see the alias.
		if (!keybindings.getKeys(WORD_DELETE).includes(CTRL_BACKSPACE)) {
			restore();
			restore = installWordDeleteAlias(keybindings);
		}
		return undefined;
	});
	return () => {
		unsubscribe();
		restore();
	};
}

/** Add a session-only alias using Pi's existing action and terminal decoder. */
export function installWordDeleteAlias(keybindings: KeybindingsManager): () => void {
	const original = keybindings.getUserBindings()[WORD_DELETE];
	const keys = keybindings.getKeys(WORD_DELETE);
	// Respect an explicitly disabled action or an already configured alias.
	if (keys.length === 0 || keys.includes(CTRL_BACKSPACE)) return () => {};
	// An explicit user assignment to another action wins over Toolkit's default.
	const reserved = Object.entries(keybindings.getUserBindings()).some(([action, value]) =>
		action !== WORD_DELETE && (Array.isArray(value) ? value : [value]).includes(CTRL_BACKSPACE));
	if (reserved) return () => {};

	const installed = [...keys, CTRL_BACKSPACE];
	keybindings.setUserBindings({ ...keybindings.getUserBindings(), [WORD_DELETE]: installed });
	return () => {
		const current = keybindings.getUserBindings();
		const value = current[WORD_DELETE];
		// Don't undo changes made by the user or another extension while active.
		if (!Array.isArray(value) || value.length !== installed.length
			|| value.some((key, index) => key !== installed[index])) return;
		const restored = { ...current };
		if (original === undefined) delete restored[WORD_DELETE];
		else restored[WORD_DELETE] = original;
		keybindings.setUserBindings(restored);
	};
}
