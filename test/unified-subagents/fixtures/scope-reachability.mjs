import { writeFileSync } from "node:fs";
import { join } from "node:path";

export default function (pi) {
  const parameters = { type: "object", properties: {} };
  const tool = (name, exposure = "direct", defaultActive) => ({
    name, label: name, description: name, parameters, exposure, defaultActive,
    execute: async (_id, _args, _signal, _update, ctx) => {
      writeFileSync(join(ctx.cwd, name), "executed");
      return { content: [{ type: "text", text: name }], details: {} };
    },
  });
  for (const exposure of ["direct", "model-only", "codemode", "deferred", "hidden"]) {
    pi.registerTool(tool(`scope_${exposure}`, exposure));
  }
  pi.registerTool(tool("scope_inactive", "direct", false));
  pi.registerTool(tool("tool_search", "model-only", false));
  pi.registerTool(tool("scope_excluded", "deferred"));
  pi.registerTool({
    ...tool("scope_driver", "model-only"),
    execute: async (_id, _args, _signal, _update, ctx) => {
      const allowed = await ctx.executeTool("scope_deferred", {});
      const denied = await ctx.executeTool("scope_excluded", {});
      // A late direct tool should appear next turn; a late deferred tool should not.
      pi.registerTool(tool("scope_late"));
      pi.registerTool(tool("scope_late_deferred", "deferred"));
      pi.registerTool(tool("scope_late_excluded", "deferred"));
      pi.setActiveTools([...pi.getActiveTools(), "scope_excluded", "scope_inactive", "tool_search"]);
      return { content: [{ type: "text", text: JSON.stringify({ allowed, denied }) }], details: { allowed, denied } };
    },
  });
}
