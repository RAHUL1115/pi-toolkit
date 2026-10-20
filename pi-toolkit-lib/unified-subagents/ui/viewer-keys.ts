/**
 * viewer-keys.ts — Key matchers for the conversation viewer.
 *
 * Navigation uses literal arrows; only tool expansion resolves user keybindings.
 */

import { matchesKey } from "@earendil-works/pi-tui";

/** Keybinding id the viewer resolves. */
export type ViewerKeybinding = "app.tools.expand";

/** Structural subset of pi-tui's `KeybindingsManager` (which satisfies it). */
export interface ViewerKeybindings {
  matches(data: string, keybinding: ViewerKeybinding): boolean;
}

export interface ViewerKeys {
  scrollUp(data: string): boolean;
  scrollDown(data: string): boolean;
  toggleTools(data: string): boolean;
}

export function createViewerKeys(keybindings?: ViewerKeybindings): ViewerKeys {
  return {
    scrollUp: (data) => matchesKey(data, "up"),
    scrollDown: (data) => matchesKey(data, "down"),
    toggleTools: (data) => keybindings ? keybindings.matches(data, "app.tools.expand") : matchesKey(data, "ctrl+o"),
  };
}
