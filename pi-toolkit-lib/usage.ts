import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { estimatedCost, singleLine, tokens, type UsageTheme } from "./usage-snapshot.js";
import { scanUsageHistory, WINDOWS, type HistoryReport } from "./usage-history.js";

type UsagePanelTheme = UsageTheme & Pick<Theme, "bg">;

function columns(left: string, right: string, width: number): string {
  return left + " ".repeat(Math.max(2, width - visibleWidth(left) - visibleWidth(right))) + right;
}

/** Shares use known recorded cost only; a zero denominator displays 0.0%. */
export const usageShare = (part: number, total: number) => `${(total > 0 ? part / total * 100 : 0).toFixed(1)}%`;

function modelLines(s: HistoryReport["windows"][number], width: number, theme: UsageTheme): string[] {
  const heading = theme.fg("accent", theme.bold("Models"));
  if (!s.byModel.length) return ["", heading, theme.fg("muted", "No usage in this period.")];
  const rows = s.byModel.map(b => [
    singleLine(b.model ?? "Unattributed"), tokens(b.total), usageShare(b.total, s.total),
    `$${b.cost.toFixed(3)}${b.missingCosts ? "+?" : ""}`, usageShare(b.cost, s.cost),
  ]);
  const headers = ["Model", "Tokens", "Token %", "Cost", "Cost %"];
  const sizes = headers.map((h, i) => Math.max(visibleWidth(h), ...rows.map(r => visibleWidth(r[i]!))));
  const numericWidth = sizes.slice(1).reduce((a, b) => a + b, 0) + 8;
  const labelWidth = Math.min(28, sizes[0]!, width - numericWidth);
  if (labelWidth < 8) {
    return ["", heading, ...rows.flatMap(row => [
      theme.fg("text", truncateToWidth(row[0]!, width)),
      ...row.slice(1).map((value, i) => theme.fg("muted", `${headers[i + 1]}  `) + theme.fg("text", value)), "",
    ])];
  }
  sizes[0] = labelWidth;
  const format = (row: string[]) => row.map((cell, i) => {
    const text = truncateToWidth(cell, sizes[i]!);
    const gap = " ".repeat(Math.max(0, sizes[i]! - visibleWidth(text)));
    return i ? gap + text : text + gap;
  }).join("  ");
  return ["", heading, theme.fg("muted", format(headers)), ...rows.map(row => theme.fg("text", format(row)))];
}

export function renderUsage(report: HistoryReport, tab: number, width: number, theme: UsageTheme, details = false): string[] {
  if (width <= 0) return [];
  const s = report.windows[tab]!;
  const metric = (label: string, value: string) => theme.fg("muted", label.padEnd(18)) + theme.fg("text", value);
  const value = (label: string, n: number) => metric(label, tokens(n));
  const summary = [theme.bold(metric("Total tokens", tokens(s.total))), metric("Estimated cost", estimatedCost(s))];
  const lines = [
    ...summary, "",
    value("Input", s.input + s.cacheRead + s.cacheWrite),
    value("  Uncached", s.input), value("  Cached reads", s.cacheRead),
    ...(s.cacheWrite ? [value("  Cache writes", s.cacheWrite)] : []),
    value("Output", s.output),
    ...modelLines(s, width, theme),
    ...(details ? [
    "",
    theme.fg("accent", theme.bold("Details")),
    `Rolling last ${WINDOWS[tab]! * 24} hours · all projects`,
    theme.fg("dim", `As of ${new Date(report.now).toISOString()} (UTC)`),
    `Uncached input: ${s.input.toLocaleString("en-US")} tokens`,
    ...(s.reasoning === undefined ? [] : [`Reasoning  ${s.reasoning.toLocaleString("en-US")} (reported subset, included in output)`]),
    theme.fg("muted", "Recorded Pi estimates, not a bill. Zero may mean unknown pricing; no independent pricing."),
    theme.fg("muted", "Token % includes input, output and caches. Cost % uses known estimates only; zero denominators show 0.0%. +? marks missing cost."),
    theme.fg("muted", "Unattributed includes aggregate tool/summary usage and messages without reliable provider/model."),
    ...s.byModel.map(b => theme.fg("dim", b.model === null ? "Unattributed: no reliable model provenance" : `${singleLine(b.model)}: ${singleLine(b.provider!)}/${singleLine(b.model)}`)),
    ...(s.missingCosts ? [theme.fg("warning", `${s.missingCosts} usage record(s) lack cost; estimate is incomplete.`)] : []),
    ...(report.partial || report.skipped || report.invalid ? [theme.fg("warning", `Partial coverage: ${report.skipped} unreadable/oversized/unsupported files; ${report.invalid} malformed records. Scan may have reached its limit. Reopen to rescan.`)] : []),
    "",
    theme.fg("muted", "Includes compaction and finalized nested tool usage, not retained copies or extension telemetry."),
    theme.fg("muted", "Unreported/pending nested work is unavailable. Independently saved child ledgers cannot be reconciled with aggregate tool usage without provenance."),
    theme.fg("dim", `${report.files} ledger files scanned; ${report.duplicates} copied entries deduplicated. Legacy v1 files are skipped, never migrated.`),
    ] : []),
  ];
  return new Text(lines.join("\n"), 0, 0).render(width).map(line => truncateToWidth(line, width));
}

export function usagePanel(report: HistoryReport, tui: { terminal: { rows: number }; requestRender(): void }, theme: UsagePanelTheme, done: () => void) {
  let tab = 0;
  let details = false;
  let offset = 0;
  let maxOffset = 0;
  let pageSize = 1;
  return {
    invalidate() {},
    render(width: number) {
      // Leave two terminal rows for Pi's surrounding UI. Collapse decoration before content.
      const height = Math.max(0, Math.floor(tui.terminal.rows) - 2);
      width = Math.max(0, Math.floor(width));
      if (!width || !height) return [];
      const s = report.windows[tab]!;
      const incomplete = report.partial || report.skipped || report.invalid || s.missingCosts;
      const warning = theme.fg("warning", "Incomplete data" + (width >= 46 ? " · d details / reopen to rescan" : ""));
      const framed = width >= 4 && height >= 6;
      const padding = framed && width >= 10 ? 2 : 0;
      const inner = width - (framed ? 2 + padding * 2 : 0);
      const tabs = WINDOWS.map((days, i) => {
        const label = inner < 27 ? `${days}d` : `${days} ${days === 1 ? "day" : "days"}`;
        return theme.bg(i === tab ? "searchMatchBg" : "customMessageBg", i === tab
          ? theme.fg("searchMatchText", theme.bold(` ${label} `)) : theme.fg("muted", ` ${label} `));
      }).join("  ");
      const roomy = height >= 18;
      const header = roomy
        ? ["", theme.bold(theme.fg("accent", "Usage")), theme.fg("dim", `All projects · last ${WINDOWS[tab]! * 24}h`), "", tabs, ""]
        : [tabs];
      const footer = theme.fg("dim", inner >= 60 ? "←/→/Tab period · ↑↓/PgUp/PgDn scroll · d details · Esc close"
        : inner >= 38 ? columns("←/→/Tab period · d details", "Esc close", inner) : "Esc close · ←/→/Tab · d");
      if (!framed) {
        return [...(incomplete ? [warning] : []), tabs, footer].slice(0, height).map(line => truncateToWidth(line, width, ""));
      }
      const pinned = [...(incomplete ? [warning] : []), ...(roomy ? [""] : []), footer, ...(roomy ? [""] : [])];
      const lines = renderUsage(report, tab, inner, theme, details);
      pageSize = Math.max(0, height - 2 - header.length - pinned.length);
      maxOffset = Math.max(0, lines.length - pageSize);
      offset = Math.min(offset, maxOffset);
      const edge = (left: string, right: string) => theme.fg("dim", left + "─".repeat(width - 2) + right);
      const row = (line: string) => {
        const text = truncateToWidth(line, inner, "");
        return theme.fg("dim", "│") + " ".repeat(padding) + text + " ".repeat(inner - visibleWidth(text) + padding) + theme.fg("dim", "│");
      };
      return [edge("╭", "╮"), ...[...header, ...lines.slice(offset, offset + pageSize), ...pinned].map(row), edge("╰", "╯")];
    },
    handleInput(data: string) {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) { done(); return; }
      if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) { tab = (tab + 1) % WINDOWS.length; offset = 0; }
      else if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) { tab = (tab + WINDOWS.length - 1) % WINDOWS.length; offset = 0; }
      else if (matchesKey(data, "d")) { details = !details; offset = 0; }
      else if (matchesKey(data, Key.down)) offset = Math.min(maxOffset, offset + 1);
      else if (matchesKey(data, Key.up)) offset = Math.max(0, offset - 1);
      else if (matchesKey(data, Key.pageDown)) offset = Math.min(maxOffset, offset + pageSize);
      else if (matchesKey(data, Key.pageUp)) offset = Math.max(0, offset - pageSize);
      else return;
      tui.requestRender();
    },
  };
}

export default function registerUsage(pi: ExtensionAPI) {
  let cancel = () => {};
  pi.on("session_shutdown", () => cancel());
  pi.registerCommand("ptk-usage", {
    description: "Show rolling 1/7/30-day usage across Pi sessions in tabs",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("/ptk-usage requires TUI mode.", "info"); return; }
      cancel();
      const controller = new AbortController();
      const cleanup = () => controller.abort();
      let doneUI: (() => void) | undefined;
      let closed = false;
      const close = () => { if (closed) return; closed = true; cleanup(); doneUI?.(); };
      cancel = close;
      try {
        await ctx.ui.custom<void>((tui, theme, _keys, done) => {
          let panel: ReturnType<typeof usagePanel> | undefined;
          let error = false;
          doneUI = done;
          void scanUsageHistory(ctx.sessionManager, controller.signal).then(report => {
            if (controller.signal.aborted) return;
            panel = usagePanel(report, tui, theme, close);
            tui.requestRender();
          }).catch(() => { if (!controller.signal.aborted) { error = true; tui.requestRender(); } });
          return {
            dispose: cleanup,
            invalidate() { panel?.invalidate(); },
            render(width: number) { return panel ? panel.render(width) : width > 0 ? [truncateToWidth(error ? "Could not read usage. Esc to close; reopen to retry." : "Reading local Pi ledgers (up to 30s)... Esc to cancel", width)] : []; },
            handleInput(data: string) {
              if (panel) panel.handleInput(data);
              else if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) close();
            },
          };
        });
      } finally { cleanup(); if (cancel === close) cancel = () => {}; }
    },
  });
}
