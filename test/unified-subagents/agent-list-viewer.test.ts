import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import { AgentListViewer } from "../../pi-toolkit-lib/unified-subagents/ui/agent-list-viewer.js";
import type { AgentRecord } from "../../pi-toolkit-lib/unified-subagents/types.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const records = [
  { id: "first", type: "Explore", description: "same", status: "completed", startedAt: 0, completedAt: 1000 },
  { id: "second", type: "Explore", description: "same", status: "running", startedAt: 0 },
] as AgentRecord[];

it("renders a boxed agent list and selects the actual row, even with identical labels", () => {
  const done = vi.fn();
  const tui = { requestRender: vi.fn() };
  const viewer = new AgentListViewer(tui as any, () => records, theme, done);
  const lines = viewer.render(50);
  expect(lines[0]).toMatch(/^╭─+╮$/);
  expect(lines.at(-1)).toMatch(/^╰─+╯$/);
  expect(lines.some(line => line.includes("1 running · 2 total"))).toBe(true);
  expect(lines.every(line => visibleWidth(line) <= 50)).toBe(true);
  viewer.handleInput("\x1b[B");
  viewer.handleInput("\r");
  expect(done).toHaveBeenCalledWith(records[1]);
});

it("keeps the empty panel open until dismissed", () => {
  const done = vi.fn();
  const viewer = new AgentListViewer({ requestRender: vi.fn() } as any, () => [], theme, done);
  expect(viewer.render(32).some(line => line.includes("No agents in this session."))).toBe(true);
  viewer.handleInput("\r");
  expect(done).not.toHaveBeenCalled();
  viewer.handleInput("\x1b");
  expect(done).toHaveBeenCalledWith(undefined);
});
