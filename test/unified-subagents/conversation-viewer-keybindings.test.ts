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
const HOME = "\x1b[H";
const END = "\x1b[F";
const REMOVED_KEYS = [
  CTRL_P, CTRL_N,
  "\x1b[5~", "\x1b[6~", // Page Up/Down
  "\x1b[1;5H", "\x1b[1;5F", // Ctrl+Home/End
  "\x1b[1;5A", "\x1b[1;5B", // Ctrl+Up/Down
  "\x1b[1;3A", "\x1b[1;3B", // Alt+Up/Down
  "\x1b[1;2A", "\x1b[1;2B", // Shift+Up/Down
  "k", "j", "u", "d", "g", "G",
];

function createReboundKeybindings(): KeybindingsManager {
  return new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.up": "ctrl+p",
    "tui.select.down": "ctrl+n",
    "tui.select.pageUp": "u",
    "tui.select.pageDown": "d",
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

const keybindingCases = [
  undefined,
  new KeybindingsManager(TUI_KEYBINDINGS, {}),
  createReboundKeybindings(),
];

describe("viewer-keys", () => {
  it.each(keybindingCases)("uses only literal arrows regardless of navigation bindings (%#)", (manager) => {
    const keys = createViewerKeys(manager);
    expect(keys.scrollUp(UP)).toBe(true);
    expect(keys.scrollDown(DOWN)).toBe(true);
    expect(keys.scrollUp(DOWN)).toBe(false);
    expect(keys.scrollDown(UP)).toBe(false);
    for (const key of REMOVED_KEYS) {
      expect(keys.scrollUp(key), JSON.stringify(key)).toBe(false);
      expect(keys.scrollDown(key), JSON.stringify(key)).toBe(false);
    }
  });

  it("defaults tool expansion to Ctrl+O without a manager", () => {
    expect(createViewerKeys().toggleTools("\x0f")).toBe(true);
  });

  it("respects a custom tool-expansion binding", () => {
    const keys = createViewerKeys({
      matches: (data, id) => id === "app.tools.expand" && data === "\x05",
    });
    expect(keys.toggleTools("\x05")).toBe(true);
    expect(keys.toggleTools("\x0f")).toBe(false);
  });
});

describe("ConversationViewer navigation", () => {
  it.each(keybindingCases)("scrolls one line with arrows and clamps at the boundaries (%#)", (manager) => {
    const viewer = createViewer(manager);
    const bottom = scrollOffset(viewer);
    expect(bottom).toBeGreaterThan(0);

    viewer.handleInput(DOWN);
    expect(scrollOffset(viewer)).toBe(bottom);
    viewer.handleInput(UP);
    expect(scrollOffset(viewer)).toBe(bottom - 1);
    viewer.handleInput(DOWN);
    expect(scrollOffset(viewer)).toBe(bottom);
    viewer.handleInput(HOME);
    viewer.handleInput(UP);
    expect(scrollOffset(viewer)).toBe(0);
    viewer.handleInput(DOWN);
    expect(scrollOffset(viewer)).toBe(1);
  });

  it.each(keybindingCases)("jumps only with Home/End and updates auto-scroll (%#)", (manager) => {
    const viewer = createViewer(manager);
    const bottom = scrollOffset(viewer);
    viewer.handleInput(HOME);
    expect(scrollOffset(viewer)).toBe(0);
    expect((viewer as any).autoScroll).toBe(false);
    viewer.handleInput(END);
    expect(scrollOffset(viewer)).toBe(bottom);
    expect((viewer as any).autoScroll).toBe(true);
  });

  it.each(keybindingCases)("leaves removed navigation keys inert (%#)", (manager) => {
    const viewer = createViewer(manager);
    viewer.handleInput(HOME);
    viewer.handleInput(DOWN);
    for (const key of REMOVED_KEYS) {
      viewer.handleInput(key);
      expect(scrollOffset(viewer), JSON.stringify(key)).toBe(1);
      expect((viewer as any).autoScroll, JSON.stringify(key)).toBe(false);
    }
  });

  it("still toggles tools with a custom expansion binding", () => {
    const viewer = createViewer({
      matches: (data, id) => id === "app.tools.expand" && data === "\x05",
    });
    viewer.handleInput("\x0f");
    expect((viewer as any).toolsExpanded).toBe(false);
    viewer.handleInput("\x05");
    expect((viewer as any).toolsExpanded).toBe(true);
    viewer.handleInput("\x05");
    expect((viewer as any).toolsExpanded).toBe(false);
  });

  it.each(["darwin", "linux", "win32"])("shows the same navigation footer on %s", (platform) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...descriptor, value: platform });
    try {
      const footer = createViewer().render(120).at(-2)!;
      expect(footer).toContain("↑↓ lines · Home/End top/end · Esc close");
      expect(footer).not.toMatch(/pages|k\/j|g\/G|Alt\+|Ctrl\+↑/);
    } finally {
      Object.defineProperty(process, "platform", descriptor);
    }
  });
});
