import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { singleLine, tokens, usageSnapshot, type UsageSnapshot, type UsageTheme } from "./usage-snapshot.js";

/** Compact icon groups with two-column outer padding; never distribute space. */
export function renderFooter(s: UsageSnapshot, width: number, theme: UsageTheme, meta: { folder?: string; branch?: string | null; tps?: number } = {}): string[] {
  const padding = Math.min(2, Math.floor(Math.max(0, width) / 2));
  const model = singleLine(s.model.slice(s.model.indexOf("/") + 1));
  const groups = [
    theme.fg("accent", `🤖 ${model}`),
    theme.fg("muted", `📁 ${singleLine(meta.folder ?? "")}`),
    ...(meta.branch ? [theme.fg("muted", `⎇ ${singleLine(meta.branch)}`)] : []),
    theme.fg((s.context?.percent ?? 0) >= 85 ? "warning" : "muted", `◔ ${s.context?.percent?.toFixed(1) ?? "?"}% [↑${tokens(s.input + s.cacheRead + s.cacheWrite)} ↓${tokens(s.output)}]`),
    theme.fg("text", `⚡ ${meta.tps != null && Number.isFinite(meta.tps) && meta.tps >= 0 ? meta.tps.toFixed(1) : "0.0"}`) + theme.fg("dim", "t/s"),
    theme.fg("text", `$ ${s.cost.toFixed(3)}${s.missingCosts ? "+?" : ""}`),
  ];
  return [" ".repeat(padding) + truncateToWidth(groups.join("  "), Math.max(0, width - padding * 2)) + " ".repeat(padding)];
}

export const backgroundStatus = (running: number) => running > 0 ? `bg tasks:${running}` : "";

export default function registerFooter(pi: ExtensionAPI) {
  let cleanup = () => {};
  let requestRender = () => {};
  let active = false;
  let firstOutput: number | undefined;
  let tps = 0;
  const resetGeneration = () => { active = false; firstOutput = undefined; };
  const reset = () => { resetGeneration(); tps = 0; requestRender(); };

  pi.on("message_start", (event) => {
    if (event.message.role !== "assistant") return;
    resetGeneration();
    active = true;
  });
  pi.on("message_update", (event) => {
    const e = event.assistantMessageEvent;
    // No chunk/character token estimates: observe only the first output delta.
    if (active && firstOutput === undefined &&
        (e.type === "text_delta" || e.type === "thinking_delta" || e.type === "toolcall_delta") && e.delta.length > 0) {
      firstOutput = performance.now();
    }
  });
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant" || !active) return;
    const seconds = firstOutput === undefined ? 0 : (performance.now() - firstOutput) / 1000;
    const output = event.message.usage?.output;
    // Final Pi/provider output usage over the observed stream interval. This is
    // a client-side estimate, not precise live decoding throughput (see README).
    const rate = seconds > 0 && output != null && output >= 0 ? output / seconds : NaN;
    if (Number.isFinite(rate)) tps = rate;
    resetGeneration();
    requestRender();
  });
  pi.on("model_select", reset);
  pi.on("session_tree", reset);
  pi.on("session_start", (_event, ctx) => {
    cleanup();
    reset();
    if (ctx.mode !== "tui") return;
    ctx.ui.setFooter((tui, theme, data) => {
      cleanup();
      const unsubscribe = data.onBranchChange(() => tui.requestRender());
      let disposed = false;
      const dispose = () => { if (!disposed) { disposed = true; unsubscribe(); requestRender = () => {}; } };
      cleanup = dispose;
      requestRender = () => tui.requestRender();
      return {
        invalidate() {},
        render: (width: number) => renderFooter(usageSnapshot(ctx), width, theme, { folder: basename(ctx.cwd || ctx.sessionManager.getCwd()), branch: data.getGitBranch(), tps }),
        dispose,
      };
    });
  });
  pi.on("session_shutdown", () => { cleanup(); reset(); });
}
