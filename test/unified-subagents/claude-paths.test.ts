import { describe, expect, it, vi } from "vitest";
import { resolveClaudeExecutable } from "../../pi-toolkit-lib/unified-subagents/backends/claude.js";

const windowsHome = "C:\\Users\\test";
const fixedWindowsPath = `${windowsHome}\\.local\\bin\\claude.exe`;

describe("Claude executable resolution", () => {
  it("prefers the exact Windows user install before PATH", () => {
    const seen: string[] = [];
    const resolved = resolveClaudeExecutable({
      platform: "win32",
      pathValue: "C:\\first;C:\\second",
      homeDirectory: windowsHome,
      isExecutable: (file) => {
        seen.push(file);
        return file === fixedWindowsPath || file === "C:\\first\\claude.exe";
      },
    });

    expect(resolved).toBe(fixedWindowsPath);
    expect(seen).toEqual([fixedWindowsPath]);
  });

  it("checks Windows PATH directories and names in order", () => {
    const seen: string[] = [];
    const resolved = resolveClaudeExecutable({
      platform: "win32",
      pathValue: "C:\\first;D:\\second",
      homeDirectory: windowsHome,
      isExecutable: (file) => {
        seen.push(file);
        return file === "D:\\second\\claude.cmd";
      },
    });

    expect(resolved).toBe("D:\\second\\claude.cmd");
    expect(seen).toEqual([
      fixedWindowsPath,
      "C:\\first\\claude.exe",
      "C:\\first\\claude.cmd",
      "C:\\first\\claude",
      "D:\\second\\claude.exe",
      "D:\\second\\claude.cmd",
    ]);
  });

  it("omits the path when no executable is available", () => {
    const check = vi.fn(() => false);
    expect(resolveClaudeExecutable({
      platform: "win32",
      pathValue: "C:\\missing",
      homeDirectory: windowsHome,
      isExecutable: check,
    })).toBeUndefined();
    expect(check).toHaveBeenCalled();
  });

  it("uses the platform PATH delimiter outside Windows", () => {
    expect(resolveClaudeExecutable({
      platform: "linux",
      pathValue: "/first:/second",
      isExecutable: (file) => file === "/second/claude",
    })).toBe("/second/claude");
  });
});
