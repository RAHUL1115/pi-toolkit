/** End-to-end loading and toggling of ordinary UTF-8 BOM agent files. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { disableInContent, enableInContent } from "../../pi-toolkit-lib/unified-subagents/agent-file-toggle.js";
import { loadCustomAgents } from "../../pi-toolkit-lib/unified-subagents/custom-agents.js";

const BOM = "\uFEFF";
const AGENT = `${BOM}---
description: 代码审查员
tools: none
model: anthropic/claude-haiku-4-5
---

你是一位资深的代码审查员。请仔细检查代码。`;

describe("BOM-prefixed agent files", () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  let originalAgentDir: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-bom-"));
    originalHome = process.env.HOME;
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = tmpDir;
    delete process.env.PI_CODING_AGENT_DIR;
  });

  afterEach(() => {
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeAgent(name: string, content: string): string {
    const dir = join(tmpDir, ".agents", "agents");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${name}.md`);
    writeFileSync(path, content, "utf-8");
    return path;
  }

  it("loads all fields and keeps YAML out of the prompt", () => {
    writeAgent("审查员", AGENT);
    const agent = loadCustomAgents(tmpDir).get("审查员");

    expect(agent?.description).toBe("代码审查员");
    expect(agent?.model).toBe("anthropic/claude-haiku-4-5");
    expect(agent?.systemPrompt).toBe("你是一位资深的代码审查员。请仔细检查代码。");
    expect(agent?.systemPrompt).not.toContain("---");
  });

  it("honors tools: none instead of granting defaults", () => {
    writeAgent("审查员", AGENT);
    expect(loadCustomAgents(tmpDir).get("审查员")?.builtinToolNames).toEqual([]);
  });

  it("preserves BOM and CRLF through a disable/enable round trip", () => {
    const crlf = `${BOM}---\r\ndescription: 代码审查员\r\ntools: none\r\n---\r\n\r\n你是审查员。\r\n`;
    const path = writeAgent("审查员", crlf);

    expect(loadCustomAgents(tmpDir).get("审查员")?.description).toBe("代码审查员");
    const disabled = disableInContent(readFileSync(path, "utf-8"));
    expect(disabled.outcome).toBe("disabled");
    expect(disabled.content.startsWith(BOM)).toBe(true);
    expect(/[^\r]\n/.test(disabled.content)).toBe(false);
    expect(enableInContent(disabled.content).content).toBe(crlf);
  });

  it("does not invent frontmatter for a BOM-prefixed body", () => {
    const source = `${BOM}没有前置数据。\n`;
    expect(disableInContent(source)).toEqual({ content: source, outcome: "no-frontmatter" });
  });

  it("loads disabled state and returns the file byte-identical after re-enable", () => {
    const path = writeAgent("审查员", AGENT);
    writeFileSync(path, disableInContent(readFileSync(path, "utf-8")).content, "utf-8");
    expect(loadCustomAgents(tmpDir).get("审查员")?.enabled).toBe(false);
    expect(readFileSync(path, "utf-8").startsWith(BOM)).toBe(true);

    writeFileSync(path, enableInContent(readFileSync(path, "utf-8")).content, "utf-8");
    expect(loadCustomAgents(tmpDir).get("审查员")?.enabled).not.toBe(false);
    expect(readFileSync(path, "utf-8")).toBe(AGENT);
  });
});
