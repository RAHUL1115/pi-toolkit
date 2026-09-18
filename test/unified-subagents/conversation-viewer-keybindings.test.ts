import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../../pi-toolkit-lib/unified-subagents/types.js";
import { ConversationViewer } from "../../pi-toolkit-lib/unified-subagents/ui/conversation-viewer.js";
import type { ViewerKeybindings } from "../../pi-toolkit-lib/unified-subagents/ui/viewer-keys.js";
import { createViewerKeys } from "../../pi-toolkit-lib/unified-subagents/ui/viewer-keys.js";

const CTRL_P = "\x10";
const CTRL_N = "\x0e";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const HOME = "\x1b[H";
const END = "\x1b[F";
const CTRL_HOME = "\x1b[1;5H";
const CTRL_END = "\x1b[1;5F";
const CTRL_UP = "\x1b[1;5A";
const CTRL_DOWN = "\x1b[1;5B";
const ALT_UP = "\x1b[1;3A";
const ALT_DOWN = "\x1b[1;3B";

function createEmacsKeybindings(): KeybindingsManager {
  return new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.up": ["up", "ctrl+p"],
    "tui.select.down": ["down", "ctrl+n"],
  });
}

function createViewer(keybindings?: ViewerKeybindings) {
  const tui = {
    terminal: { rows: 20, columns: 80 },
    requestRender: vi.fn(),
  } as any;
  const messages = Array.from({ length: 60 }, (_, i) => ({
    role: "user",
    content: `message ${i}`,
  }));
  const session = {
    messages,
    subscribe: vi.fn(() => vi.fn()),
  } as any;
  const record = {
    id: "test-1",
    type: "general-purpose",
    description: "test agent",
    status: "completed",
    toolUses: 0,
    startedAt: Date.now(),
  } as AgentRecord;
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as any;
  const viewer = new ConversationViewer(tui, session, record, undefined, theme, vi.fn(), undefined, keybindings);
  viewer.render(80); // sets lastInnerW and scrolls to bottom (autoScroll)
  return viewer;
}

function scrollOffset(viewer: ConversationViewer): number {
  return (viewer as any).scrollOffset;
}

describe("viewer-keys", () => {
  it("honors user keybindings when a manager is provided", () => {
    const keys = createViewerKeys(createEmacsKeybindings());
    expect(keys.scrollUp(CTRL_P)).toBe(true);
    expect(keys.scrollUp(UP)).toBe(true);
    expect(keys.scrollDown(CTRL_N)).toBe(true);
    expect(keys.scrollDown(DOWN)).toBe(true);
  });

  it("falls back to hardcoded defaults without a manager", () => {
    const keys = createViewerKeys();
    expect(keys.scrollUp(UP)).toBe(true);
    expect(keys.scrollUp(CTRL_P)).toBe(false);
    expect(keys.scrollDown(DOWN)).toBe(true);
    expect(keys.scrollDown(CTRL_N)).toBe(false);
    expect(keys.pageUp(PAGE_UP)).toBe(true);
    expect(keys.pageDown(PAGE_DOWN)).toBe(true);
    expect(keys.toggleTools("\x0f")).toBe(true);
  });

  it("respects a custom tool-expansion binding", () => {
    const keys = createViewerKeys({
      matches: (data, id) => id === "app.tools.expand" && data === "\x05",
    });
    expect(keys.toggleTools("\x05")).toBe(true);
    expect(keys.toggleTools("\x0f")).toBe(false);
  });

  it("keeps the k/j line aliases and Alt+arrow page bindings with and without a manager", () => {
    for (const keys of [createViewerKeys(), createViewerKeys(createEmacsKeybindings())]) {
      expect(keys.scrollUp("k")).toBe(true);
      expect(keys.scrollDown("j")).toBe(true);
      expect(keys.pageUp(ALT_UP)).toBe(true);
      expect(keys.pageDown(ALT_DOWN)).toBe(true);
    }
  });

  it("manager with no user overrides behaves like the hardcoded defaults", () => {
    const keys = createViewerKeys(new KeybindingsManager(TUI_KEYBINDINGS, {}));
    expect(keys.scrollUp(UP)).toBe(true);
    expect(keys.scrollDown(DOWN)).toBe(true);
    expect(keys.pageUp(PAGE_UP)).toBe(true);
    expect(keys.pageDown(PAGE_DOWN)).toBe(true);
    expect(keys.scrollUp(CTRL_P)).toBe(false);
    expect(keys.scrollDown(CTRL_N)).toBe(false);
  });

  it("respects rebinding that removes a default key", () => {
    const manager = new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.select.up": "ctrl+p",
    });
    const keys = createViewerKeys(manager);
    expect(keys.scrollUp(CTRL_P)).toBe(true);
    expect(keys.scrollUp(UP)).toBe(false);
  });
});

describe("ConversationViewer custom keybindings", () => {
  it("scrolls with ctrl+p/ctrl+n when bound to tui.select.up/down", () => {
    const viewer = createViewer(createEmacsKeybindings());
    const bottom = scrollOffset(viewer);
    expect(bottom).toBeGreaterThan(0);

    viewer.handleInput(CTRL_P);
    expect(scrollOffset(viewer)).toBe(bottom - 1);
    viewer.handleInput(CTRL_N);
    expect(scrollOffset(viewer)).toBe(bottom);
  });

  it("pages the internal transcript with Alt+Up/Down", () => {
    const viewer = createViewer(createEmacsKeybindings());
    const bottom = scrollOffset(viewer);
    const page = (viewer as any).viewportHeight();

    viewer.handleInput(ALT_UP);
    expect(scrollOffset(viewer)).toBe(bottom - page);
    viewer.handleInput(ALT_DOWN);
    expect(scrollOffset(viewer)).toBe(bottom);
  });

  it("keeps arrows and k/j working alongside custom bindings", () => {
    const viewer = createViewer(createEmacsKeybindings());
    const bottom = scrollOffset(viewer);

    viewer.handleInput(UP);
    viewer.handleInput("k");
    expect(scrollOffset(viewer)).toBe(bottom - 2);
    viewer.handleInput(DOWN);
    viewer.handleInput("j");
    expect(scrollOffset(viewer)).toBe(bottom);
  });

  it("treats ctrl+p/ctrl+n as unbound without a keybindings manager", () => {
    const viewer = createViewer();
    const bottom = scrollOffset(viewer);

    viewer.handleInput(CTRL_P);
    viewer.handleInput(CTRL_N);
    expect(scrollOffset(viewer)).toBe(bottom);
    viewer.handleInput(UP);
    expect(scrollOffset(viewer)).toBe(bottom - 1);
  });

  it.each([
    [CTRL_UP, CTRL_DOWN],
    [HOME, END],
    [CTRL_HOME, CTRL_END],
  ])("jumps directly to the transcript top and bottom", (top, bottom) => {
    const viewer = createViewer();
    const bottomOffset = scrollOffset(viewer);

    viewer.handleInput(top);
    expect(scrollOffset(viewer)).toBe(0);
    viewer.handleInput(bottom);
    expect(scrollOffset(viewer)).toBe(bottomOffset);
  });
});
