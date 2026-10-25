import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { classifyFailure, digest, safeName, skillEvent, toolEvent } from "../pi-toolkit-lib/analytics/normalize.js";
import type { FailureCategory, ToolObservation } from "../pi-toolkit-lib/analytics/types.js";

const scope = { session: "opaque-session", project: "opaque-project", source: "live" as const };
const observation: ToolObservation = {
  scope, callId: "call-1", tool: "bash", timestamp: 100, isError: false,
};
const text = (value: string) => [{ type: "text", text: value }];

describe("digest and safeName", () => {
  it("uses SHA-256 over deterministic JSON, preserving array order and part boundaries", () => {
    expect(digest("tool", "call", 100, "bash")).toBe(
      createHash("sha256").update(JSON.stringify(["tool", "call", 100, "bash"])).digest("hex"),
    );
    expect(digest({ b: 2, a: { z: 1, x: 2 } })).toBe(digest({ a: { x: 2, z: 1 }, b: 2 }));
    expect(digest([1, 2])).not.toBe(digest([2, 1]));
    expect(digest("ab", "c")).not.toBe(digest("a", "bc"));
    expect(digest(undefined)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("allows bounded identifiers, never cleans raw prose into identifiers", () => {
    expect(safeName("vendor/model-v1.2:fast_mode")).toBe("vendor/model-v1.2:fast_mode");
    expect(safeName("a".repeat(160))).toHaveLength(160);
    for (const value of [null, {}, 1, "", "a".repeat(161), "raw error text", "a\nb", "bash\n", "bash\r", "café", "/private/key", "../key", "a/../key", "https://host/key", "sk-secret", "ghp_secret"]) {
      expect(safeName(value)).toBe("unknown");
    }
    expect(safeName(null, "fallback")).toBe("fallback");
    expect(safeName(null, "unsafe fallback")).toBe("unknown");
  });
});

describe("failure classification", () => {
  const examples: [FailureCategory, string][] = [
    ["invalid_arguments", "Invalid arguments: missing foo"],
    ["path_not_found", "ENOENT: /private/customer/file"],
    ["edit_mismatch", "Could not find exact text in /private/file"],
    ["permission", "EACCES: permission denied"],
    ["authentication", "Unauthorized: invalid API key sk-secret"],
    ["rate_limit", "HTTP 429: too many requests"],
    ["network", "ECONNRESET: customer.internal"],
    ["timeout", "Operation timed out after 30 seconds"],
    ["dependency", "Cannot find module 'private-package'"],
    ["cancelled", "AbortError: cancelled by user"],
    ["runtime", "TypeError: privateValue is not a function"],
    ["unknown", "Something bad happened with customer secret"],
  ];
  it.each(examples)("recognizes %s only with error evidence", (category, message) => {
    const result = classifyFailure(message, true);
    expect(result?.category).toBe(category);
    expect(result?.confidence).toBe(category === "unknown" ? "low" : "high");
    expect(result?.rule).toMatch(/^[a-z_]+$/);
    expect(classifyFailure(message, false)).toBeUndefined();
  });

  it("distinguishes weak evidence from explicit timeout evidence", () => {
    expect(classifyFailure("timeout", true)).toEqual({ category: "timeout", confidence: "medium", rule: "timeout_reported" });
  });

  it("does not confuse successful prose, grep no-match, or test failures with agent errors", () => {
    for (const message of ["Error handling and timeout documentation", "0 errors, no timeout", "TypeError example", "All tests passed", "No matches found", "2 tests failed"]) {
      expect(classifyFailure(message, false)).toBeUndefined();
      expect(classifyFailure(message, false, 0)).toBeUndefined();
    }
    for (const message of ["No matches found", "2 tests failed", "TypeError in tested code", "timeout example"]) {
      expect(classifyFailure(message, false, 1)).toEqual({ category: "unknown", confidence: "low", rule: "command_nonzero_exit" });
    }
    for (const code of [NaN, Infinity, 1.5]) expect(classifyFailure("error", false, code)).toBeUndefined();
  });
});

describe("toolEvent", () => {
  it("has deterministic top-level identity independent of clone scope or source", () => {
    const live = toolEvent(observation);
    const history = toolEvent({ ...observation, scope: { ...scope, source: "history" } });
    const clone = toolEvent({ ...observation, scope: { ...scope, session: "clone", project: "other" } });
    expect(live.id).toBe(digest("tool", "call-1", 100, "bash"));
    expect(history.id).toBe(live.id);
    expect(clone.id).toBe(live.id);
    expect(history.evidence).toEqual(live.evidence);
    expect(toolEvent({ ...observation, timestamp: 101 }).id).not.toBe(live.id);
    expect(toolEvent({ ...observation, tool: "read" }).id).not.toBe(live.id);
    expect(live.inputHash).toBeUndefined();
  });

  it("uses root-timestamp nested identity independent of flattened parent metadata", () => {
    const nested = toolEvent({ ...observation, parentId: "parent", entryId: "entry", limited: true, rootTimestamp: 123 });
    expect(nested.id).toBe(digest("nested", "call-1", 123));
    expect(nested.parent).toBe(digest("parent"));
    expect(nested.evidence).toEqual({ call: digest("call-1"), entry: digest("entry") });
    expect(nested.limited).toBe(true);
    expect(toolEvent({ ...observation, parentId: "other", timestamp: 999, rootTimestamp: 123, scope: { ...scope, source: "history" } }).id).toBe(nested.id);
    expect(toolEvent({ ...observation, parentId: "parent", rootTimestamp: 124 }).id).not.toBe(nested.id);
  });

  it("extracts only structured integer exit codes, never numbers in output", () => {
    for (const details of [{ exitCode: 2 }, { exit_code: 2 }]) {
      const event = toolEvent({ ...observation, details });
      expect(event.exitCode).toBe(2);
      expect(event.status).toBe("ok");
      expect(event.failure?.rule).toBe("command_nonzero_exit");
    }
    for (const details of [{ exitCode: "2" }, { exitCode: Infinity }, { exit_code: NaN }, { exitCode: 1.5 }, { nested: { exitCode: 2 } }, null]) {
      const event = toolEvent({ ...observation, details, content: text("Process exited with code 2; exitCode: 7") });
      expect(event.exitCode).toBeUndefined();
      expect(event.failure).toBeUndefined();
    }
    expect(toolEvent({ ...observation, details: { exitCode: 0 } }).exitCode).toBe(0);
  });

  it("only reads content text blocks transiently, not arbitrary strings or details", () => {
    expect(toolEvent({ ...observation, isError: true, content: text("ENOENT private") }).failure?.category).toBe("path_not_found");
    for (const content of ["ENOENT", { text: "ENOENT" }, [{ type: "image", text: "ENOENT" }]]) {
      expect(toolEvent({ ...observation, isError: true, content, details: { error: "ENOENT" } }).failure?.category).toBe("unknown");
    }
  });

  it("prioritizes error status, tracks unfinished calls, and accepts only valid durations", () => {
    expect(toolEvent({ ...observation, unfinished: true }).status).toBe("unfinished");
    expect(toolEvent({ ...observation, unfinished: true, isError: true }).status).toBe("error");
    for (const durationMs of [-1, NaN, Infinity]) expect(toolEvent({ ...observation, durationMs }).durationMs).toBeUndefined();
    for (const durationMs of [0, 1.25]) expect(toolEvent({ ...observation, durationMs }).durationMs).toBe(durationMs);
  });

  it("does not persist arguments, text, paths, credentials, reasoning, or extra fields", () => {
    const event = toolEvent({
      ...observation, tool: "raw tool text", entryId: "private-entry", parentId: "private-parent",
      input: { path: "/private/customer/SKILL.md", token: "secret-token", reasoning: "private-reasoning" },
      content: text("TypeError secret-output"), isError: true,
      details: { error: "secret-error", exitCode: 1 },
      scope: { ...scope, provider: "secret provider", model: "/private/model", harnessVersion: "secret version" },
    });
    expect(event.tool).toBe("unknown");
    expect(event.provider).toBe("unknown");
    expect(event.model).toBe("unknown");
    expect(event.harnessVersion).toBe("unknown");
    expect(event.inputHash).toBe(digest({ token: "secret-token", reasoning: "private-reasoning", path: "/private/customer/SKILL.md" }));
    const stored = JSON.stringify(event);
    for (const secret of ["/private", "secret-", "private-entry", "private-parent", "raw tool", "TypeError", "reasoning"]) expect(stored).not.toContain(secret);
    expect(toolEvent({ ...observation, input: null }).inputHash).toBe(digest(null));
  });

  it("leaves successful SKILL.md read promotion to the collector", () => {
    const event = toolEvent({ ...observation, tool: "read", input: { path: "/skills/example/SKILL.md" }, content: text("private skill content") });
    expect(event.kind).toBe("tool");
    expect(event.skill).toBeUndefined();
    expect(event.skillHash).toBeUndefined();
  });
});

describe("skillEvent", () => {
  const skill = { scope, timestamp: 100, name: "example", state: "loaded" as const, identity: "skill-call" };
  it("uses source-independent identity and hashes only explicitly supplied content", () => {
    const live = skillEvent({ ...skill, content: "old skill version", entryId: "entry" });
    const history = skillEvent({ ...skill, timestamp: 999, scope: { ...scope, source: "history", session: "clone" } });
    expect(live.id).toBe(digest("skill", "skill-call", "example", "loaded"));
    expect(history.id).toBe(live.id);
    expect(live.skillHash).toBe(digest("old skill version"));
    expect(history).not.toHaveProperty("skillHash");
    expect(skillEvent({ ...skill, content: "" }).skillHash).toBe(digest(""));
    expect(live.evidence).toEqual({ entry: digest("entry") });
    expect(history.evidence).toEqual({});
    expect(skillEvent({ ...skill, state: "invoked" }).id).not.toBe(live.id);
    expect(skillEvent({ ...skill, identity: "other" }).id).not.toBe(live.id);
  });

  it("never stores raw skill content, paths, identities or unsafe names", () => {
    const event = skillEvent({ ...skill, name: "/private/SKILL.md", identity: "private-identity", content: "private instructions and credentials" });
    expect(event.skill).toBe("unknown");
    expect(JSON.stringify(event)).not.toContain("private");
    expect(event.skillState).toBe("loaded");
  });
});
