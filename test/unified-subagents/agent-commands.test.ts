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
  const notify = vi.fn();
  const commandCtx = ctx({ ui: { select, notify } });

  expect([...commands.keys()].filter(name => name.startsWith("agent"))).toEqual(["agents", "agents-options"]);
  await commands.get("agents").handler("", commandCtx);
  expect(notify).toHaveBeenCalledWith("No agents.", "info");
  expect(select).not.toHaveBeenCalled();

  await commands.get("agents-options").handler("", commandCtx);
  expect(select).toHaveBeenCalledOnce();
  expect(select.mock.calls[0][0]).toBe("Agents");
  expect(select.mock.calls[0][1]).toContain("Settings");
});
