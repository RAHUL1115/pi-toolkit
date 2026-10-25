import { posix } from "node:path";

export const isSkillName = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,127}$/i.test(value);

/** Only actual expansion wrappers, never the advertised catalog or embedded examples. */
export function skillObservations(message: any): Array<{ name: string; state: "loaded" | "invoked"; identity: string; content?: string }> {
  if (!Number.isFinite(message?.timestamp)) return [];
  const result: ReturnType<typeof skillObservations> = [];
  const system = message.role === "system";
  if (!system && message.role !== "user") return result;
  const texts: string[] = system ? [message.sections?.["pi-toolkit-active-skills"]].filter(t => typeof t === "string")
    : typeof message.content === "string" ? [message.content]
    : Array.isArray(message.content) ? message.content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text) : [];
  for (const text of texts) {
    if (!system) {
      const invoked = /^\s*\/skill:([a-z0-9][a-z0-9_-]{0,127})(?=\s|$)/i.exec(text);
      if (invoked) result.push({ name: invoked[1]!, state: "invoked", identity: `invoke:${message.timestamp}:${invoked[1]!}` });
    }
    const expression = system
      ? /(?:^|\n)<skill name="([a-z0-9][a-z0-9_-]{0,127})" location="[^"\n]+">\n([\s\S]*?)\n<\/skill>(?=\s|$)/gi
      : /^\s*<skill name="([a-z0-9][a-z0-9_-]{0,127})" location="[^"\n]+">\n([\s\S]*?)\n<\/skill>(?=\s|$)/gi;
    for (const match of text.matchAll(expression)) result.push({ name: match[1]!, state: "loaded", identity: `block:${message.timestamp}:${match[1]!}`, content: match[2]! });
  }
  return result;
}

export function readSkillName(tool: string, input: any): string | undefined {
  if (!["read", "functions.read"].includes(tool) || typeof input?.path !== "string") return undefined;
  const path = input.path.replace(/\\/g, "/");
  if (posix.basename(path) !== "SKILL.md") return undefined;
  const name = posix.basename(posix.dirname(path));
  return isSkillName(name) ? name : undefined;
}

/** Pi assigns nested ids <parent>/<n>. Reconstruct only when that contract is visible. */
export function nestedParent(root: string, child: string): string {
  const suffix = child.startsWith(`${root}/`) ? child.slice(root.length + 1) : "";
  return /^\d+(?:\/\d+)*$/.test(suffix) ? child.slice(0, child.lastIndexOf("/")) : root;
}
