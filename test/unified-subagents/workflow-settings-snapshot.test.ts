import { describe, expect, it } from "vitest";
import { workflowSettingSnapshot } from "../../pi-toolkit-lib/unified-subagents/index.js";

describe("workflow settings snapshot", () => {
  it("does not persist the implicit enabled default or an automatic collision stand-down", () => {
    expect(workflowSettingSnapshot(false, true)).toBeUndefined();
    expect(workflowSettingSnapshot(false, false)).toBeUndefined();
  });

  it("preserves an explicit user choice", () => {
    expect(workflowSettingSnapshot(true, true)).toBe(true);
    expect(workflowSettingSnapshot(true, false)).toBe(false);
  });
});
