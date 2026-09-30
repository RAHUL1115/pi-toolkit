import { afterEach, expect, it, vi } from "vitest";
import { registerUnifiedSubagents } from "../../pi-toolkit-lib/unified-subagents/index.js";
import { ctx, hermeticDir, makePi } from "./helpers/boot-extension.js";

const fixture = hermeticDir();
afterEach(() => {
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
});
afterEach(() => fixture.restore());

it("routes /agents to activity and /agents-options to management", async () => {
  const { pi, commands } = makePi();
  registerUnifiedSubagents(pi);
  const select = vi.fn(async () => undefined);
  const custom = vi.fn(async (factory) => {
    const viewer = factory({ requestRender: vi.fn() }, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, undefined, vi.fn());
    const lines = viewer.render(60);
    expect(lines[0]).toMatch(/^╭─+╮$/);
    expect(lines.some((line: string) => line.includes("No agents in this session."))).toBe(true);
    expect(lines.at(-1)).toMatch(/^╰─+╯$/);
    return undefined;
  });
  const notify = vi.fn();
  const commandCtx = ctx({ ui: { select, custom, notify } });

  expect([...commands.keys()].filter(name => name.startsWith("agent"))).toEqual(["agents", "agents-options"]);
  await commands.get("agents").handler("", commandCtx);
  expect(notify).not.toHaveBeenCalled();
  expect(custom).toHaveBeenCalledOnce();
  expect(select).not.toHaveBeenCalled();

  await commands.get("agents-options").handler("", commandCtx);
  expect(select).toHaveBeenCalledOnce();
  expect(select.mock.calls[0][0]).toBe("Agents");
  expect(select.mock.calls[0][1]).toContain("Settings");
});
