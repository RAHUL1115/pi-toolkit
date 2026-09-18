/**
 * viewer-keys.ts — Scroll key matchers for the conversation viewer.
 *
 * Resolves `tui.select.*` through the user's keybindings when pi provides a
 * manager, falling back to the previous hardcoded keys otherwise. The viewer's
 * k/j line aliases and Alt+arrow page bindings always work alongside whatever is bound.
 */

import { type KeyId, matchesKey } from "@earendil-works/pi-tui";

/** Keybinding ids the viewer resolves. */
export type ViewerKeybinding =
  | "tui.select.up"
  | "tui.select.down"
  | "tui.select.pageUp"
  | "tui.select.pageDown"
  | "app.tools.expand";

/** Structural subset of pi-tui's `KeybindingsManager` (which satisfies it). */
export interface ViewerKeybindings {
  matches(data: string, keybinding: ViewerKeybinding): boolean;
}

export interface ViewerKeys {
  scrollUp(data: string): boolean;
  scrollDown(data: string): boolean;
  pageUp(data: string): boolean;
  pageDown(data: string): boolean;
  toggleTools(data: string): boolean;
}

export function createViewerKeys(keybindings?: ViewerKeybindings): ViewerKeys {
  const matches = (data: string, id: ViewerKeybinding, fallback: KeyId): boolean =>
    keybindings ? keybindings.matches(data, id) : matchesKey(data, fallback);
  return {
    scrollUp: (data) => matches(data, "tui.select.up", "up") || matchesKey(data, "k"),
    scrollDown: (data) => matches(data, "tui.select.down", "down") || matchesKey(data, "j"),
    pageUp: (data) => matchesKey(data, "alt+up") || matches(data, "tui.select.pageUp", "pageUp"),
    pageDown: (data) => matchesKey(data, "alt+down") || matches(data, "tui.select.pageDown", "pageDown"),
    toggleTools: (data) => matches(data, "app.tools.expand", "ctrl+o"),
  };
}
