import { Editor, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { BackgroundTaskController, BackgroundTaskItem } from "../../pi-toolkit-lib/background-task-viewer.js";
import type { AgentManager } from "../../pi-toolkit-lib/unified-subagents/agent-manager.js";
import { registerAgents } from "../../pi-toolkit-lib/unified-subagents/agent-types.js";
import type { AgentConfig, AgentRecord } from "../../pi-toolkit-lib/unified-subagents/types.js";
import { type AgentActivity, getDisplayName } from "../../pi-toolkit-lib/unified-subagents/ui/agent-widget.js";
import { FleetList, type FleetUICtx, formatFleetElapsed, formatFleetTokens } from "../../pi-toolkit-lib/unified-subagents/ui/fleet-list.js";

// ---- Key sequences (see node_modules/@earendil-works/pi-tui/dist/keys.js) ----
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const ESC = "\x1b";
const ENTER = "\r";
const CTRL_B = "\x02";
// Kitty-protocol key-RELEASE for ↓ (event type 3) — listeners receive these too.
const DOWN_RELEASE = "\x1b[1;1:3B";

const theme = {
  fg: (c: string, s: string) => `<${c}>${s}</${c}>`,
  bg: (c: string, s: string) => `<${c}>${s}</${c}>`,
  bold: (s: string) => `*${s}*`,
};

/** An agent that renders as a badge — no default agent configures a color. */
const BADGED_TYPE = "colored-reviewer";
const PURPLE_BACKGROUND = "\u001b[48;2;130;125;189m";
const BADGED_CONFIG: AgentConfig = {
  name: BADGED_TYPE,
  displayName: "Code Reviewer",
  color: "purple",
  description: "Reviews code",
  extensions: false,
  skills: false,
  systemPrompt: "Review code.",
  promptMode: "replace",
};

/**
 * Visible text of a rendered row: ANSI stripped, along with this theme's fake
 * `<color>` / `*bold*` markers — all three stand in for zero-width escapes.
 */
function plain(row: string): string {
  return row.replace(/\u001b\[[0-9;]*m/g, "").replace(/<\/?[a-zA-Z]+>|\*/g, "");
}

/** A no-op session so a record is "openable" by default (the list hides session-less agents). */
const FAKE_SESSION = { subscribe: () => () => {}, messages: [] };

function makeTask(over: Partial<BackgroundTaskItem> = {}): BackgroundTaskItem {
  return {
    id: "bash-1",
    title: "Run tests",
    command: "npm test",
    status: "running",
    startedAt: Date.now(),
    ...over,
  };
}

function makeRecord(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "a1",
    type: "general-purpose",
    harness: "pi",
    description: "Sleep then report 1",
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
    session: FAKE_SESSION as any,
    lifetimeUsage: { input: 13100, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...over,
  } as AgentRecord;
}

/** Fake manager exposing only what FleetList touches. */
function fakeManager(agents: AgentRecord[]): AgentManager {
  return {
    listAgents: () => agents,
    abort: () => true,
    steer: vi.fn(() => true),
    backgroundForeground: vi.fn(() => {
      const record = agents.find(agent => agent.status === "running" && agent.isBackground === false);
      if (record) record.isBackground = true;
      return record;
    }),
  } as unknown as AgentManager;
}

interface Harness {
  fleet: FleetList;
  ui: FleetUICtx;
  manager: AgentManager;
  tasks: BackgroundTaskController;
  /** The overlay component (a real ConversationViewer) once one is opened. */
  overlayComponent: () => { handleInput(data: string): void; render?(width: number): string[] } | undefined;
  /** Feed a key to the registered input handler; returns the consume result. */
  press: (data: string) => { consume?: boolean } | undefined;
  /** Render the currently-registered below-editor widget at the given width. */
  render: (width?: number) => string[];
  setEditorText: (t: string) => void;
  /** Whether an overlay has been opened. */
  overlayOpened: () => boolean;
  /** Whether the most recently opened overlay's `done` was invoked (closed). */
  overlayClosed: () => boolean;
  /** Options passed to the most recently opened overlay. */
  overlayOptions: () => unknown;
  /** The fake `tui` handed to the widget factory; tests set `focusedComponent` on it. */
  widgetTui: { requestRender(): void; focusedComponent?: unknown };
}

function harness(
  agents: AgentRecord[],
  activity: Map<string, AgentActivity> = new Map(),
  taskItems: BackgroundTaskItem[] = [],
): Harness {
  let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
  let widgetFactory: ((tui: any, theme: any) => { render(w: number): string[] }) | undefined;
  let editorText = "";
  let opened = false;
  let closed = false;
  let overlayComponent: { handleInput(data: string): void; render?(width: number): string[] } | undefined;
  let openedOverlayOptions: unknown;
  const fakeTui = { requestRender: () => {}, terminal: { columns: 120, rows: 40 } };

  const ui: FleetUICtx = {
    setWidget: (_key, content) => { widgetFactory = content as any; },
    onTerminalInput: (h) => { inputHandler = h; return () => { inputHandler = undefined; }; },
    getEditorText: () => editorText,
    notify: () => {},
    custom: ((factory: any, options: unknown) => {
      opened = true;
      openedOverlayOptions = options;
      return new Promise<undefined>((resolve) => {
        const done = (r: undefined) => { closed = true; resolve(r); };
        // Construct the overlay component so the controller wires viewerClose,
        // and keep it so tests can drive the real ConversationViewer's input.
        overlayComponent = factory(fakeTui, theme, undefined, done);
      });
    }) as FleetUICtx["custom"],
  };

  const manager = fakeManager(agents);
  const tasks: BackgroundTaskController = {
    list: () => taskItems,
    output: () => "task output",
    stop: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    clearFinished: vi.fn(async () => {}),
  };
  const fleet = new FleetList(manager, activity, undefined, tasks);
  fleet.setUICtx(ui);
  fleet.update();

  return {
    fleet,
    ui,
    manager,
    tasks,
    overlayComponent: () => overlayComponent,
    press: (data) => inputHandler?.(data),
    render: (width = 120) => (widgetFactory ? widgetFactory(fakeTui, theme).render(width) : []),
    setEditorText: (t) => { editorText = t; },
    overlayOpened: () => opened,
    overlayClosed: () => closed,
    overlayOptions: () => openedOverlayOptions,
    widgetTui: fakeTui,
  };
}

function enterRows(h: Harness): void {
  h.press(DOWN);
  h.press(DOWN);
}

describe("formatFleetElapsed", () => {
  it("renders integer seconds (no decimal, no suffix)", () => {
    expect(formatFleetElapsed(0)).toBe("0s");
    expect(formatFleetElapsed(11_000)).toBe("11s");
    expect(formatFleetElapsed(11_400)).toBe("11s");
    expect(formatFleetElapsed(11_600)).toBe("12s");
  });
  it("floors negatives to 0s", () => {
    expect(formatFleetElapsed(-500)).toBe("0s");
  });
});

describe("formatFleetTokens", () => {
  it("prefixes a down-arrow and uses plural 'tokens'", () => {
    expect(formatFleetTokens(13_100)).toBe("↓ 13.1k tokens");
    expect(formatFleetTokens(950)).toBe("↓ 950 tokens");
    expect(formatFleetTokens(1_200_000)).toBe("↓ 1.2M tokens");
  });
});

describe("FleetList navigation", () => {
  it("does not register a widget when there are no agents", () => {
    const h = harness([]);
    expect(h.render()).toEqual([]);
  });

  it("hides nested child records from the coordinator fleet", () => {
    const h = harness([
      makeRecord({ id: "top", description: "top-level" }),
      makeRecord({ id: "nested", description: "nested-child", parentAgentId: "top" }),
    ]);
    enterRows(h);
    const output = h.render().join("\n");
    expect(output).toContain("top-level");
    expect(output).not.toContain("nested-child");
  });

  it("focuses tabs first and expands rows on a second ↓ even with one category", () => {
    const h = harness([makeRecord()]);
    expect(h.press(DOWN)).toEqual({ consume: true });
    expect(h.render().some(l => l.includes("↓ enter"))).toBe(true);
    expect(h.render().join("\n")).not.toContain("Sleep then report 1");
    expect(h.press(DOWN)).toEqual({ consume: true });
    expect(h.render().some(l => l.includes("enter view"))).toBe(true);
    expect(h.render().join("\n")).toContain("<accent>●</accent>");
  });

  it("does not activate on ←", () => {
    const h = harness([makeRecord()]);
    expect(h.press(LEFT)).toBeUndefined();
  });

  it("uses a tab level when tasks and agents are both running", () => {
    const h = harness([makeRecord()], new Map(), [makeTask()]);
    h.press(DOWN);
    expect(h.render(240).join("\n")).toContain("←→ switch");
    expect(h.render(240).join("\n")).toContain("<selectedBg>*<accent> Agents 1 </accent>");
    expect(h.press(LEFT)).toEqual({ consume: true });
    expect(h.render(240).join("\n")).toContain("<selectedBg>*<accent> Tasks 1 </accent>");
    h.press(DOWN);
    expect(h.render(240).find(line => line.includes("Run tests"))).toContain("●");
  });

  it("switches tabs with ←/→ while row navigation is active", () => {
    const h = harness([makeRecord()], new Map(), [makeTask()]);
    h.press(DOWN); // tabs, Agents selected
    h.press(DOWN); // agent rows
    expect(h.press(LEFT)).toEqual({ consume: true });
    expect(h.render().find(line => line.includes("Run tests"))).toContain("●");
    expect(h.press(RIGHT)).toEqual({ consume: true });
    const output = h.render().join("\n");
    expect(output).toContain("<selectedBg>*<text> Agents 1 </text>");
    expect(output).toContain("<accent>●</accent>");
  });

  it("collapses inactive rows to gray counters and keeps expanded rows tight", () => {
    const h = harness([makeRecord()], new Map(), [makeTask()]);
    const collapsed = h.render(240);
    expect(collapsed[0]).toContain("<selectedBg><muted> Tasks 1 </muted></selectedBg>");
    expect(collapsed[0]).toContain("<selectedBg><muted> Agents 1 </muted></selectedBg>");
    expect(collapsed[0]).toContain("↓ to manage");
    expect(collapsed).toHaveLength(2);

    enterRows(h);
    const expanded = h.render(240);
    expect(expanded[0]).toContain("<selectedBg>*<text> Agents 1 </text>");
    expect(expanded[1]).toContain("Sleep then report 1");
    expect(expanded.at(-1)).toBe("");
    expect(expanded.join("\n")).not.toContain("[Tasks");
  });

  it("shows only categories with running work", () => {
    const completed = makeTask({ status: "exited", exitCode: 0 });
    const output = harness([makeRecord({ status: "completed" })], new Map(), [completed]).render();
    expect(output).toEqual([]);
  });

  it("does NOT activate when the prompt is non-empty (typing is preserved)", () => {
    const h = harness([makeRecord()]);
    h.setEditorText("hello");
    expect(h.press(DOWN)).toBeUndefined();
  });

  it("ignores key-release events so one tap moves exactly one row", () => {
    const h = harness([
      makeRecord({ id: "a1", description: "one" }),
      makeRecord({ id: "a2", description: "two" }),
    ]);
    h.press(DOWN);          // activate tab
    h.press(DOWN_RELEASE);  // release half of the SAME tap — must be a no-op
    expect(h.render().some(l => l.includes("one"))).toBe(false);
    h.press(DOWN);          // enter first row
    h.press(DOWN_RELEASE);
    expect(h.render().find(l => l.includes("one"))).toContain("●");
    expect(h.render().find(l => l.includes("two"))).toContain("○");
  });

  it("renders the whole selected row in the theme's primary text color (#230)", () => {
    const h = harness([
      makeRecord({ id: "a1", description: "one" }),
      makeRecord({ id: "a2", description: "two" }),
    ]);
    enterRows(h);
    const selected = h.render().find(l => l.includes("one"))!;
    // Selection marker keeps accent color; row content uses primary text color.
    expect(selected).toContain("<accent>●</accent>");
    expect(selected).toContain("<text>one</text>");
    expect(selected).toContain("<text>[thinking]</text>");
    expect(selected).toMatch(/<text>↓ [\d.]+k? token · \d+s<\/text>/);
    // Agent display name rendered with the text token too (this type has no badge).
    expect(selected).toContain(`<text>${getDisplayName("general-purpose")}</text>`);
    // Inactive rows keep the muted/dim treatment.
    const unselected = h.render().find(l => l.includes("two"))!;
    expect(unselected).toContain("<dim>○</dim>");
    expect(unselected).toContain("<dim>[thinking]</dim>");
    expect(unselected).toMatch(/<dim>↓ [\d.]+k? token · \d+s<\/dim>/);
    expect(unselected).not.toContain("<text>");
  });

  it("keeps a color badge on the selected row, bolded, without shifting it (#230)", () => {
    registerAgents(new Map([[BADGED_TYPE, BADGED_CONFIG]]));
    try {
      const h = harness([
        makeRecord({ id: "a1", type: BADGED_TYPE, description: "one" }),
        makeRecord({ id: "a2", type: BADGED_TYPE, description: "two" }),
      ]);
      enterRows(h);
      h.press(DOWN); // select a2, leaving a1 unselected
      const before = h.render().find(l => l.includes("one"))!;
      expect(before).toContain(`${PURPLE_BACKGROUND}`);
      expect(before).toContain(` ${BADGED_CONFIG.displayName} `);

      h.press(UP); // select a1
      const selected = h.render().find(l => l.includes("one"))!;
      // Selection bolds the badge rather than repainting it (Claude Code's FleetView) …
      expect(selected).toContain(PURPLE_BACKGROUND);
      expect(selected).toContain(`* ${BADGED_CONFIG.displayName} *`);
      expect(selected).not.toContain(`<text>${BADGED_CONFIG.displayName}`);
      // … so the description stays in the same column as when unselected.
      expect(plain(selected).indexOf("one")).toBe(plain(before).indexOf("one"));
    } finally {
      registerAgents(new Map());
    }
  });

  it("moves selection down/up and clamps at the ends", () => {
    const agents = [
      makeRecord({ id: "a1", description: "one" }),
      makeRecord({ id: "a2", description: "two" }),
    ];
    const h = harness(agents);
    enterRows(h);
    expect(h.render().find(l => l.includes("one"))).toContain("●");
    h.press(DOWN); // → a2
    h.press(DOWN); // clamp at a2
    expect(h.render().find(l => l.includes("two"))).toContain("●");
    expect(h.render().find(l => l.includes("one"))).toContain("○");
  });

  it("↑ from the first row collapses to tabs, then ↑ returns to the editor", () => {
    const h = harness([makeRecord()]);
    enterRows(h);
    expect(h.press(UP)).toEqual({ consume: true });
    expect(h.render().some(l => l.includes("Sleep then report 1"))).toBe(false);
    expect(h.render().some(l => l.includes("↓ enter"))).toBe(true);
    expect(h.press(UP)).toEqual({ consume: true });
    expect(h.render().some(l => l.includes("↓ to manage"))).toBe(true);
  });

  it("↑ from the first row returns to tabs when both categories exist", () => {
    const h = harness([makeRecord()], new Map(), [makeTask()]);
    h.press(DOWN); // tabs
    h.press(DOWN); // agent row
    expect(h.press(UP)).toEqual({ consume: true });
    expect(h.render(240).some(l => l.includes("←→ switch"))).toBe(true);
  });

  it("Esc deactivates", () => {
    const h = harness([makeRecord()]);
    h.press(DOWN);
    expect(h.press(ESC)).toEqual({ consume: true });
    expect(h.render().some(l => l.includes("↓ to manage"))).toBe(true);
  });

  it("passes non-nav keys through and cancels navigation", () => {
    const h = harness([makeRecord()]);
    h.press(DOWN);
    expect(h.press("z")).toBeUndefined();
    expect(h.render().some(l => l.includes("↓ to manage"))).toBe(true);
  });

  it("backgrounds a running foreground agent with Ctrl+B", () => {
    const record = makeRecord({ isBackground: false });
    const h = harness([record]);

    expect(h.press(CTRL_B)).toEqual({ consume: true });
    expect(h.manager.backgroundForeground).toHaveBeenCalledOnce();
    expect(record.isBackground).toBe(true);
  });

  it("leaves Ctrl+B to the editor when no foreground agent can be backgrounded", () => {
    const h = harness([makeRecord({ isBackground: true })]);
    expect(h.press(CTRL_B)).toBeUndefined();
  });

  it("keeps Ctrl+B backgrounding available when FleetView is disabled", () => {
    const h = harness([makeRecord({ isBackground: false })]);
    h.fleet.setEnabled(false);

    expect(h.press(CTRL_B)).toEqual({ consume: true });
    expect(h.render()).toEqual([]);
  });

  it("ignores all FleetView input while disabled and hides the widget", () => {
    const h = harness([makeRecord()]);
    h.fleet.setEnabled(false);
    expect(h.press(DOWN)).toBeUndefined();
    expect(h.render()).toEqual([]);
  });

  it("re-arms the refresh timer when the list is re-shown (toggle off→on)", () => {
    vi.useFakeTimers();
    try {
      const agents = [makeRecord({ id: "a1" })];
      const listAgents = vi.fn(() => agents);
      const manager = { listAgents, abort: () => true } as unknown as AgentManager;
      const fleet = new FleetList(manager, new Map());
      fleet.setUICtx({
        setWidget: () => {}, onTerminalInput: () => () => {}, getEditorText: () => "",
        notify: () => {}, custom: (() => new Promise<undefined>(() => {})) as FleetUICtx["custom"],
      });
      fleet.update();          // shows list, arms the timer
      fleet.setEnabled(false); // hides, clears the timer
      fleet.setEnabled(true);  // re-shows — must re-arm the timer
      const before = listAgents.mock.calls.length;
      vi.advanceTimersByTime(1100); // a tick should fire and re-read the roster
      expect(listAgents.mock.calls.length).toBeGreaterThan(before);
      fleet.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("FleetList vs other focused components (#123)", () => {
  // pi dispatches terminal input to extension listeners BEFORE the focused
  // component (pi-tui TUI.handleInput), and ctx.ui.select/confirm/input swap
  // the prompt editor out of the editor container while getEditorText() still
  // reads the detached (empty) editor. So while another component owns the
  // keyboard — another extension's selector (rpiv-ask-user-question), pi's own
  // menus, our /agents settings — the list must not consume its keys.

  /** A minimal real Editor — what pi focuses at the prompt (CustomEditor extends it). */
  function realEditor(): Editor {
    const fakeTui = { requestRender: () => {} };
    const theme = { borderColor: (s: string) => s, selectList: {} };
    return new Editor(fakeTui as any, theme as any);
  }

  /** Hand the fleet list its `tui` (happens on first widget render in pi) with the given focus. */
  function focusInHarness(h: Harness, focused: unknown): void {
    h.widgetTui.focusedComponent = focused;
    h.render();
  }

  it("does not steal ↓ from a focused selector (activation)", () => {
    const h = harness([makeRecord()]);
    focusInHarness(h, { kind: "selector" }); // e.g. ExtensionSelectorComponent
    expect(h.press(DOWN)).toBeUndefined(); // must flow through to the selector
  });

  it("does not steal Ctrl+B from a focused selector", () => {
    const h = harness([makeRecord({ isBackground: false })]);
    focusInHarness(h, { kind: "selector" });

    expect(h.press(CTRL_B)).toBeUndefined();
    expect(h.manager.backgroundForeground).not.toHaveBeenCalled();
  });

  it("does not steal navigation keys from a selector opened while the list was active", () => {
    const h = harness([makeRecord()]);
    focusInHarness(h, realEditor());
    expect(h.press(DOWN)).toEqual({ consume: true }); // activate at the prompt
    focusInHarness(h, { kind: "selector" });          // a dialog takes focus
    expect(h.press(DOWN)).toBeUndefined();
    expect(h.press(ENTER)).toBeUndefined();
    expect(h.press(ESC)).toBeUndefined();
    // and the list dropped back to its inactive hint
    expect(h.render().some(l => l.includes("↓ to manage"))).toBe(true);
  });

  it("still activates when the prompt editor has focus", () => {
    const h = harness([makeRecord()]);
    focusInHarness(h, realEditor());
    expect(h.press(DOWN)).toEqual({ consume: true });
  });

  it("assumes the editor when focus is unknowable (no tui yet / nothing focused)", () => {
    const h = harness([makeRecord()]);
    // No render yet → the list has never seen a tui: activation must still work.
    expect(h.press(DOWN)).toEqual({ consume: true });
  });
});

describe("FleetList rendering", () => {
  it("renders an agent tab and rows with type, description and right-aligned stats", () => {
    const h = harness([makeRecord({ description: "Sleep then report 1" })]);
    enterRows(h);
    const lines = h.render(240);
    expect(lines[0]).toContain("enter view");
    expect(lines.join("\n")).toContain("Agents 1");
    expect(lines.join("\n")).not.toContain("main");
    const agentLine = lines.find(l => l.includes("Sleep then report 1"))!;
    expect(agentLine).toContain("●");
    expect(agentLine).toContain(getDisplayName("general-purpose"));
    expect(agentLine).toContain("[thinking]");
    expect(agentLine).not.toContain("(pi)");
    expect(agentLine).not.toContain("(claude)");
    expect(agentLine).toContain("↓ 13.1k token");
    expect(agentLine).toMatch(/↓ .* · \d+s/);
  });

  it("tags native harness rows while preserving right-aligned stats", () => {
    const h = harness([
      makeRecord({ id: "pi", description: "pi row" }),
      makeRecord({ id: "claude", harness: "claude", description: "claude row" }),
      makeRecord({ id: "codex", harness: "codex", description: "codex row" }),
    ]);
    enterRows(h);
    const lines = h.render(120);
    const piLine = lines.find(l => l.includes("pi row"))!;
    const claudeLine = lines.find(l => l.includes("claude row"))!;
    const codexLine = lines.find(l => l.includes("codex row"))!;

    expect(piLine).not.toContain("(pi)");
    expect(piLine).not.toContain("(claude)");
    expect(piLine).not.toContain("(codex)");
    expect(claudeLine).toContain("(claude)");
    expect(codexLine).toContain("(codex)");
    expect(claudeLine).toMatch(/↓ .* · \d+s/);
    expect(codexLine).toMatch(/↓ .* · \d+s/);
  });

  it("shows live status, tool use, context, elapsed time, and current activity on one line", () => {
    const activity = new Map<string, AgentActivity>([["a1", {
      activeTools: new Map([["bash-1", "bash"]]),
      toolUses: 3,
      responseText: "",
      turnCount: 2,
      session: {
        getSessionStats: () => ({
          tokens: { input: 10_000, output: 3_100, cacheWrite: 0 },
          contextUsage: { percent: 73 },
        }),
      } as any,
    }]]);
    const h = harness([makeRecord()], activity);
    enterRows(h);
    const lines = h.render(200);
    const summary = lines.find(line => line.includes("Sleep then report 1"))!;
    expect(summary).toContain("[running command]");
    expect(summary).toContain("3 tool uses · ↓ 13.1k token");
    expect(summary).toContain("<warning>73%</warning>");
    expect(summary).toMatch(/ · \d+s/);
    expect(lines).toHaveLength(3);
  });

  it("orders agents earliest-launched first (top)", () => {
    const agents = [
      makeRecord({ id: "new", description: "newest", startedAt: 2000 }),
      makeRecord({ id: "old", description: "oldest", startedAt: 1000 }),
    ];
    const h = harness(agents);
    enterRows(h);
    const lines = h.render(240);
    const oldIdx = lines.findIndex(l => l.includes("oldest"));
    const newIdx = lines.findIndex(l => l.includes("newest"));
    expect(oldIdx).toBeGreaterThanOrEqual(0);
    expect(oldIdx).toBeLessThan(newIdx); // earliest sits above the later one
  });

  it("shows pending agents before their session is available", () => {
    const agents = [
      makeRecord({ id: "live", description: "running one" }),
      makeRecord({ id: "pending", description: "queued one", status: "queued", session: undefined }),
    ];
    const h = harness(agents);
    enterRows(h);
    const lines = h.render();
    expect(lines.some(l => l.includes("running one"))).toBe(true);
    expect(lines.some(l => l.includes("queued one"))).toBe(true);
  });

  it("collapses overflow into a '↓ N more' indicator", () => {
    const agents = Array.from({ length: 8 }, (_, i) =>
      makeRecord({ id: `a${i}`, description: `report ${i}` }));
    const h = harness(agents);
    enterRows(h);
    const lines = h.render(120);
    // 8 agents, cap 5 visible → "↓ 3 more"
    expect(lines.some(l => l.includes("↓ 3 more"))).toBe(true);
  });

  it("never emits a line wider than the terminal (guards wrap-induced flicker)", () => {
    const agents = Array.from({ length: 8 }, (_, i) =>
      makeRecord({ id: `a${i}`, description: `a very long agent description number ${i} that keeps going` }));
    const h = harness(agents);
    enterRows(h);
    for (const w of [4, 8, 12, 20, 40, 80, 200]) {
      for (const line of h.render(w)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(w);
      }
    }
  });

  it("windows the visible agents so the selection stays on screen", () => {
    const agents = Array.from({ length: 8 }, (_, i) =>
      makeRecord({ id: `a${i}`, description: `report ${i}` }));
    const h = harness(agents);
    enterRows(h);
    for (let i = 1; i < 8; i++) h.press(DOWN);
    const lines = h.render(120);
    expect(lines.find(l => l.includes("report 7"))).toContain("●");
    expect(lines.some(l => l.includes("↑"))).toBe(true); // hidden-above indicator
  });
});

describe("FleetList detail lifecycle", () => {
  it.each(["pi", "claude", "codex"] as const)("Enter opens a %s agent in the full-screen viewer", (agentHarness) => {
    const h = harness([makeRecord({ harness: agentHarness })]);
    enterRows(h);
    h.press(ENTER);

    expect(h.overlayOpened()).toBe(true);
    expect(h.overlayOptions()).toEqual({
      overlay: true,
      overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
    });
  });

  it("Enter opens the task viewer focused on the selected task", () => {
    const tasks = [makeTask({ id: "bash-1", title: "first" }), makeTask({ id: "bash-2", title: "second" })];
    const h = harness([], new Map(), tasks);
    enterRows(h);
    h.press(DOWN); // second task
    h.press(ENTER);

    expect(h.overlayOpened()).toBe(true);
    expect(h.overlayOptions()).toBeUndefined();
    expect(h.overlayComponent()?.render?.(100).join("\n")).toContain("bash-2 · 1-1/1");
  });

  it("Esc from an agent viewer returns to the originating agent list", async () => {
    const h = harness([makeRecord({ id: "a1", description: "one" })]);
    enterRows(h);
    h.press(ENTER);

    h.overlayComponent()?.handleInput(ESC);
    await Promise.resolve();

    expect(h.render().some(l => l.includes("enter view"))).toBe(true);
    expect(h.render().find(l => l.includes("one"))).toContain("●");
  });

  it("Esc from a task viewer returns to the originating task list", async () => {
    const h = harness([], new Map(), [makeTask({ title: "first" }), makeTask({ id: "bash-2", title: "second" })]);
    enterRows(h);
    h.press(DOWN);
    h.press(ENTER);

    h.overlayComponent()?.handleInput(ESC);
    await Promise.resolve();

    expect(h.render().some(l => l.includes("enter view"))).toBe(true);
    expect(h.render().find(l => l.includes("second"))).toContain("●");
  });

  it("wires the viewer's steer composer to manager.steer with the agent id", () => {
    const agents = [makeRecord({ id: "live", description: "the one" })];
    const h = harness(agents);
    enterRows(h);
    h.press(ENTER);

    const viewer = h.overlayComponent();
    expect(viewer).toBeDefined();
    viewer!.handleInput("\r");
    for (const ch of "go left") viewer!.handleInput(ch);
    viewer!.handleInput("\r");

    expect(h.manager.steer).toHaveBeenCalledWith("live", "go left");
  });

  it("keeps an open agent viewer alive after the agent finishes", () => {
    const agents = [makeRecord({ id: "live", description: "the one" })];
    const h = harness(agents);
    enterRows(h);
    h.press(ENTER);
    expect(h.overlayOpened()).toBe(true);

    agents[0] = makeRecord({ id: "live", description: "the one", status: "completed", completedAt: Date.now() });
    h.fleet.onAgentFinished("live");
    expect(h.overlayClosed()).toBe(false);
    expect(h.render()).toEqual([]);
  });
});

describe("FleetList cost display", () => {
  const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };

  function row(showCost: boolean, cost: number, activity?: Map<string, AgentActivity>): string {
    const record = makeRecord({ lifetimeUsage: { input: 13100, output: 0, cacheWrite: 0, cost } });
    const fleet = new FleetList(fakeManager([record]), activity ?? new Map(), () => showCost);
    let factory: any;
    fleet.setUICtx({
      setWidget: (_k: string, c: any) => { factory = c; },
      onTerminalInput: () => () => {},
      getEditorText: () => "",
      notify: () => {},
      custom: (() => new Promise(() => {})) as any,
    } as any);
    fleet.update();
    fleet.handleKey(DOWN);
    fleet.handleKey(DOWN);
    return factory({ requestRender: () => {}, terminal: { columns: 120, rows: 40 } }, theme).render(120).join("\n");
  }

  it("appends the cost after the token count when enabled", () => {
    const out = row(true, 0.0042);
    expect(out).toContain("13.1k token");
    expect(out).toContain("~$0.0042");
  });

  it("shows no cost when disabled, and none for an unpriced model", () => {
    expect(row(false, 0.0042)).not.toContain("$");
    expect(row(true, 0)).not.toContain("$");
  });

  it("reads the record, so the figures do not change when the agent finishes", () => {
    // Spend used to come from the live activity tracker while an agent ran and
    // from its record once the tracker was deleted. The two disagree: only the
    // record carries a nested child's spend (nested-tools folds it into every
    // ancestor), so the number jumped upward at completion.
    // The stale shape on purpose: an activity entry carrying figures of its own
    // is what the old fallback preferred, so a row that still renders the
    // record's numbers proves the tracker is no longer consulted for spend.
    const tracked = new Map<string, AgentActivity>([["a1", {
      activeTools: new Map(), toolUses: 0, responseText: "", turnCount: 1,
      lifetimeUsage: { input: 1, output: 1, cacheWrite: 0, cost: 0.9 },
    } as unknown as AgentActivity]]);

    expect(row(true, 0.0042, tracked)).toBe(row(true, 0.0042));
  });
});
