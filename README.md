# pi-toolkit

A local Pi extension that combines workflow improvements, compact tool rendering, skill shortcuts, editor enhancements, and a fixed single-line footer and rolling usage dashboard.

## Features

| Area | Custom behavior |
|---|---|
| Tool rendering | Groups consecutive built-in tool calls with collapsed, preview, and expanded layouts |
| Background tasks | Adds Claude Code-style background execution, `Ctrl+B` detachment, completion notifications, and a `/tasks` manager |
| Unified subagents | Runs Pi, Claude Code, and Codex subagents through one `Agent` tool, shared FleetView, steering, results, schedules, and transcripts |
| Transcript | Adds Codex-style activity markers to user, assistant, thinking, and tool content |
| Session titles | Refreshes the session name after each turn using an available lightweight model |
| Skills | Adds persistent `$skill-name` activation, fuzzy autocomplete, and lazy prompt loading |
| User questions | Adds a structured `ask_user_question` tool with single-select, multi-select, and free-text answers |
| Context control | Adds an explicit-only `context_tool` tool for normal compaction or an opt-in blank chat |
| Paste handling | Repeating a collapsed long paste expands it inline for editing |
| Windows editor | Makes `Ctrl+Backspace` delete the previous word in supported terminals |
| Footer | Fixed model, folder, Git branch, context/input/output, estimated generation TPS, and session cost |
| Usage | Rolling 1-day, 7-day, and 30-day usage tabs |

## Install

```bash
cd C:/Users/rahul/dev/pi_extension/pi-toolkit
npm install
pi install C:/Users/rahul/dev/pi_extension/pi-toolkit
```

Pi references this local checkout. After changing the source or `pi-toolkit.json`, run:

```text
/reload
```

`/ptk` reloads Pi automatically after workflow settings change. The footer has no settings or toggles.

## Commands

| Command | Purpose |
|---|---|
| `/ptk` | Configure workflow feature toggles |
| `/ptk-usage` | Rolling 1-day, 7-day, and 30-day usage tabs across Pi sessions |
| `/tasks` | View, stop, and clear background tasks |
| `/agents` | Manage agents, schedules, running jobs, and unified-subagent settings |

The old `/ptk-settings` and `/ptk-workflow-settings` names are intentionally removed.

## Keybindings

| Key | Behavior |
|---|---|
| `Ctrl+O` | Toggle grouped tool output between collapsed and fully expanded |
| `Alt+O` | Cycle the collapsed layout: `one line` → `list` → `normal` |
| `Ctrl+B` | Detach a blocking foreground agent first; otherwise detach foreground Bash |
| `Ctrl+Backspace` | Delete the previous word on supported Windows terminals when enabled |

`Ctrl+O` uses Pi's configurable `app.tools.expand` action. `Alt+O` is currently fixed by the extension and remains distinguishable from `Ctrl+O` without terminal-specific configuration.

## Grouped tool rendering

When **Compact tools** is enabled, the toolkit replaces the rendering of these Pi built-ins while preserving their normal execution:

- `read`
- `bash`
- `edit`
- `write`
- `grep`
- `find`
- `ls`

Custom and unsupported tools keep their normal renderer and break the current group.

### Group boundaries

Consecutive supported calls are rendered as one block. Tool-only assistant turns may merge across their tool results. A group ends when Pi encounters:

- a user message
- non-empty assistant narration
- non-empty thinking
- an unsupported or custom tool

Empty text or thinking does not break a group. Existing groups are reconstructed when a session is loaded, compacted, or navigated.

### Collapsed layouts

#### `one line`

Only aggregate counts are shown:

```text
• tools 2 read · 1 bash
```

#### `list` (default)

Shows aggregate counts plus each call's target and status:

```text
• tools 1 read · 1 bash
  ├ read README.md 120 lines
  └ bash npm test 1 line
```

Long subjects collapse whitespace and are truncated to 80 characters.

#### `normal`

Shows each call in a status-colored block with a bounded output preview:

- `read`: first 10 lines, hidden count, last 10 lines
- all other supported tools: first 2 lines, hidden count, last 2 lines
- `edit`: colored added, removed, and context diff lines
- `write`: preview of the content supplied to the tool

Output bodies remain hidden while any call in the group is still running.

### Expanded layout

`Ctrl+O` displays the complete output body for every call, with a separate status-colored block per tool. `Alt+O` cycles `one line` → `list` → `normal` only while the group is collapsed; it has no effect while output is expanded.

### Status summaries

| State/tool | Summary |
|---|---|
| Running | `…` |
| Failed | `failed` |
| `edit` | Added and removed line counts |
| `write` | Input content line count |
| Other output | Result line count |
| Empty output | `done` |

The renderer follows Pi's global `outputPad` setting.

## Background tasks

The toolkit extends Pi's existing `bash` tool with optional `run_in_background` and `title` fields while preserving Pi's built-in output handling and rendering. Titles are limited to 80 characters.

```json
{
  "command": "npm run dev",
  "title": "Dev server",
  "run_in_background": true
}
```

Commands run in the foreground by default. If one is still running after 60 seconds, the toolkit automatically moves it into the background; `Ctrl+B` does the same immediately and preserves its title. Its Bash tool call returns with a session-local task ID such as `bash-1` while the process continues, streaming combined stdout/stderr directly to a temporary log rather than retaining it in session context. Explicit titles name `/tasks` rows; a sanitized, whitespace-normalized command is the fallback. While any are running, the below-editor activity surface exposes a Tasks tab; the fixed footer does not add background-task counts.

Open `/tasks` for the live task list and selected task's five-line output window. Use Up/Down to select a task, `J`/`K` to scroll output one line, Shift+Up/Down to move one page, and Alt+Up/Down to jump to the top or resume following the tail. Page Up/Page Down and `g`/`G` remain aliases. Selection follows the task ID when the list changes. Destructive actions require the same key twice: `x x` stops a running task but retains its record and output, `c c` or Delete twice clears a selected finished task, and `C C` clears all finished tasks. Duplicate asynchronous actions are ignored while one is pending. The agent can also use:

| Tool | Purpose |
|---|---|
| `bash_output` | Read current status and the last 2,000 lines or 50KB of output |
| `bash_jobs` | List tasks started in the current Pi session |
| `bash_stop` | Stop a task and its child process tree |

The existing `timeout` argument remains available and terminates the process tree when reached. Stop, timeout, and shutdown use the same idempotent flow: POSIX sends graceful tree termination before a forced fallback; Windows force-terminates the tree because it has no reliable equivalent for arbitrary console processes. Both paths confirm process exit and log-stream flush. A stop is not reported as successful when exit cannot be confirmed.

Per-job logs are capped at 2 MiB by default. Once full, the file records a limit marker, the process continues, dropped bytes are counted, and `bash_output` keeps returning the recent bounded tail. At most 50 finished tasks are retained by default; eviction, clearing, and shutdown remove their temporary directories. Foreground jobs that never detach remove their temporary directory after settlement. `/tasks` refreshes from manager list/output events, throttles output paints to roughly 100 ms, and runs its one-second elapsed clock only while work is active. Task labels and preview output strip terminal control and bidirectional-control characters.

When a background task exits, fails, is stopped, or times out, the toolkit sends only its final status and temporary log path to the main agent as a follow-up notification and triggers the next turn. Output enters context only when the agent explicitly calls `bash_output`, which remains bounded to 2,000 lines or 50KB. Active tasks are stopped and all task temp directories are removed during reload, session replacement, and orderly Pi shutdown. Task state is intentionally in-memory and does not survive a restart.

The shared activity surface appears only while background tasks are running or top-level agents are running/queued. While inactive it stays collapsed to the available filled, muted count tabs (`Tasks N` and/or `Agents N`). Down always focuses the tabs—even when only one category exists—and a second Down expands and enters the selected list. Left/Right switches categories from either the tabs or rows. Up from the first row collapses back to the tabs; Up again or Esc returns to the editor. Enter opens the selected agent conversation or `/tasks` focused on the selected task; closing that detail view returns to its Activity list while it still has active rows, otherwise to the remaining Activity tab or editor. Its terminal-input handler runs before editor shortcuts, so `Ctrl+B` detaches a blocking foreground agent when one exists and consumes the key; otherwise it passes through to the background-task shortcut.

## Unified subagents

The toolkit's sole extension entrypoint privately registers the unified-subagent module. It preserves the established `Agent`, `get_subagent_result`, and `steer_subagent` tools, `/agents` UI, FleetView, schedules, child-session protection, persisted transcripts, output files, and `subagents:*` extension interfaces. The `Agent` tool selects a Pi, Claude Code, or Codex harness through its `harness` argument or agent frontmatter.

An unqualified fresh `Agent` call starts in the foreground and automatically moves to the background after 300 seconds if still running. `run_in_background: true` detaches immediately; `false` keeps the call foreground until completion. `Ctrl+B` can detach a foreground run sooner.

FleetView now provides the shared live activity surface: the legacy `Agents` widget above the editor is always suppressed, while the below-editor tabs combine running tasks with running/queued agents without showing completed items. Agent rows show tool uses, turn/token/context usage, elapsed time, and current activity; task rows show their title, ID, and elapsed time. Disabling FleetView hides the shared surface rather than restoring the legacy widget. Final `Agent` tool results and session records remain unchanged. The full-screen conversation viewer pairs calls with compact status rows, keeps failures visible, and uses Pi's `app.tools.expand` action (`Ctrl+O` by default) to toggle successful result details. It caches finalized transcript history, rebuilds only the streaming tail, and coalesces delta paints so long sessions stay responsive without changing compaction behavior. Line/page scrolling honors configured `tui.select.*` bindings, with `K`/`J` and Shift+Up/Down retained as aliases. Home/Ctrl+Home/Alt+Up jump to the top; End/Ctrl+End/Alt+Down jump to the bottom. `Ctrl+O` follows `app.tools.expand`, and Esc/Ctrl+C/`q` closes. Zed intercepts Shift+Up/Down for terminal scrollback by default, so its terminal keymap must send those sequences to Pi; see the Zed note in the full guide.

Project agent definitions remain in `.pi/agents/*.md`; project settings remain in `.pi/subagents.json`, with global settings under Pi's normal agent directory. Existing identifiers and persisted data formats are unchanged by the consolidation.

The complete imported user guide, architecture notes, examples, changelog, and upstream attribution are retained at [`docs/unified-subagents/README.md`](docs/unified-subagents/README.md). Source provenance is recorded in [`PROVENANCE.md`](PROVENANCE.md).

## Transcript markers

When the installed Pi version supports Markdown transformers, the toolkit adds display-only activity markers:

| Marker | Content |
|---|---|
| `›` | User input |
| `•` | Assistant narration and completed responses |
| `◦` | Thinking |
| `│` | Wrapped tool-call text |
| `└` | Tool output boundary |

Markers do not modify stored messages or model context. User and assistant markers use the theme accent color; the thinking marker uses the same dim color as thinking text. User, assistant, and thinking blocks reserve a two-column gutter: the first line contains the marker and a space, while wrapped lines and nested Markdown continue beneath the content with two leading spaces. If visible thinking, narration, or tool activity occurs after an input, the toolkit places a thin, dim, full-width horizontal line immediately before the completed response; direct responses have no line. Abort and response-error statuses use `× ` in the same gutter; informational Pi status lines reserve the gutter with two spaces and no marker. Consecutive thinking summaries remain in one activity block without blank lines; toolkit rendering removes bold and italic emphasis and uses dim text.

The toolkit editor owns a fixed one-column input padding instead of inheriting Pi's `editorPaddingX` value. This toolkit padding is not configurable and does not modify Pi's `editorPaddingX` or `outputPad` settings.

## Dollar skills

When **Dollar skills** is enabled, submit a line containing only skill selectors to activate them and immediately start an agent turn:

```text
$ponytail $tdd
```

That turn asks the model to follow the newly active skill instructions, and the active set also applies to subsequent requests until cleared. `$` lists available skills without invoking the model, and `/skills-clear` clears the active set. Unknown selectors produce a warning without invoking the model. A selector mixed into a normal request is left untouched so the loader never silently discards prompt text; use a separate activation line first.

At each `before_agent_start`, the toolkit reads every active skill file, strips YAML frontmatter, and appends labelled skill blocks to that turn's system prompt. Reads are lazy, so edits take effect on the next request without `/reload`. A failed or empty read is reported and skipped without injecting partial content.

The active set is stored as branch-local custom session entries and restored from the latest entry on the active branch. Resume, fork, and tree navigation therefore follow conversation state rather than a global setting.

The TUI autocomplete provider:

- triggers on `$` at the start of input or after whitespace
- searches Pi commands whose source is `skill`
- uses subsequence matching with prefix, consecutive-character, and early-match ranking
- shows skill descriptions
- returns at most 20 suggestions

Pi's native `disable-model-invocation: true` behavior is preserved: those skills are absent from the default model-visible skill list. They are injected only after explicit `$skill-name` activation (or native `/skill:skill-name` invocation).

## Ask user questions

The `ask_user_question` tool lets the agent pause for structured clarification in TUI mode. It supports one to four questions, two to four choices per question, single- and multi-select answers, custom free-text answers, tabbed navigation, and a final review screen.

Outside TUI mode, the tool returns an explanatory error and disables itself for the session.

## Compact context

The `context_tool` tool is available to the model but may run only when the latest user message explicitly contains its exact name, `context_tool`. This guard prevents proactive compaction.

By default it performs ordinary Pi compaction in the current session without overrides, so Pi's configured model, summary prompt, `reserveTokens`, and `keepRecentTokens` behavior remain unchanged. Its fields are:

- `next_prompt` (required): non-empty prompt submitted automatically after compaction
- `custom_instructions` (optional): focus Pi's compaction summary
- `new` (optional, default `false`): when `true`, skip compaction, start a blank child session, and submit `next_prompt` there

With `new: true`, no old context is transferred into the new chat. The new session remains a standalone entry in the session picker rather than appearing as a child. Both operations record an invisible `pi-toolkit:context-tool` custom entry for inspection without changing session-list presentation or LLM context. An empty or whitespace-only `next_prompt` rejects the tool without compacting or creating a session.

## Automatic session titles

When **Automatic session titles** is enabled, the toolkit refreshes the current session name after every completed turn without blocking the main conversation. It uses the first available scoped model whose name contains Luna, Mini, Haiku, Flash, Lite, or Small; Luna is preferred. If no lightweight model is available, title generation is skipped silently.

Generated titles survive resume and may continue changing with the conversation. A title set manually with `/name` is never overwritten. Model, authentication, timeout, or network failures do not affect the main turn.

## Repeat-paste expansion

Pi normally replaces a sufficiently large paste with a marker such as:

```text
[paste #1 +50 lines]
```

The toolkit preserves that compact first paste and shows this contextual hint below the editor:

```text
Paste the same content again to expand it inline
```

Immediately paste the exact same content again to replace the marker with the complete, editable text inside the TUI. The repeated paste does not duplicate the content.

Repeat expansion is available only while the editor text and cursor remain unchanged. The hint disappears after:

- the paste is expanded
- text is edited
- the cursor moves
- editor content is replaced or cleared
- the session shuts down

If there is a break before the repeated paste, Pi handles it as a separate paste marker.

## Windows `Ctrl+Backspace`

When enabled, the toolkit maps the `0x08` sequence emitted by supported Windows terminals to Pi's previous-word deletion action (`Ctrl+W`).

It activates only on native Windows when either condition is detected:

- VS Code terminal: `TERM_PROGRAM=vscode`
- Windows Terminal: `WT_SESSION` is present

It has no effect on other platforms or terminals.

## Workflow settings

Open `/ptk` in TUI mode:

| Setting | Values | Default |
|---|---|---|
| Automatic session titles | `on`, `off` | `on` |
| Compact tools | `on`, `off` | `on` |
| Dollar skills | `on`, `off` | `on` |
| Ctrl+Backspace word delete | `on`, `off` | `on` |

Changes are written immediately to `pi-toolkit.json`. Closing the settings screen after a change reloads Pi. The collapsed tool layout is intentionally absent from `/ptk`; use `Alt+O` to cycle it.

Current configuration:

```json
{
  "autoSessionTitles": true,
  "compactTools": true,
  "ctrlBackspace": true,
  "dollarSkills": true,
  "toolView": "list"
}
```

`toolView` persists the last layout selected with `Alt+O`; it is not edited through `/ptk`. The legacy stored value `"compact"` is interpreted as `"one line"`.

## Fixed footer

One line replaces Pi's footer in TUI mode (illustrative values):

```text
  🤖 gpt-6-astra  📁 rahul  ⎇ main  ◔ 36.8% [↑12.4k ↓2.1k]  ⚡ 87.4t/s  $ 0.127
```

Groups have two spaces between them and two spaces of outer padding, without distributing spare width. Folder is the runtime cwd basename; branch is omitted when unavailable. Context/input/output form one group. Context uses one decimal and warning color at 85%. Only the TPS suffix `t/s` is dim; its number uses normal text color. Narrow terminals clip the right end safely, preserving outer padding (reduced only below four columns). Native branch subscriptions are cleaned up on replacement/shutdown; there are no timers, shell polling, settings, or toggles.

Input (`↑`) is total session input: uncached input + cache reads + cache writes. Output (`↓`) includes reported reasoning, not added again. Both use the existing authoritative usage snapshot across all branches, compacted messages, summary usage and finalized nested tool usage; `/ptk-usage` accounting is unchanged. Cost is the same Pi/provider session estimate, rounded to three decimals, with `+?` retained for missing cost; it is not a subscription bill.

TPS is a **client-observed generation estimate**, not precise live decoding speed. It always appears, starting at `0.0t/s`, then divides final assistant `usage.output` by monotonic elapsed time from the first nonempty text, thinking, or tool-call delta to assistant message completion. This interval excludes initial request latency but includes streaming/network/extension overhead; buffered or hidden reasoning can distort it. No chunks, bytes, or characters are counted as tokens. A new assistant generation keeps the last valid measurement while streaming; missing/invalid output usage, no observed delta, or a nonpositive interval also retain it. A valid measured zero replaces the prior value. Model changes, tree navigation, session switches, and reloads reset TPS to `0.0t/s`; historical speed is not reconstructed. The completed result excludes subsequent tool waits and child-agent output.

## Rolling usage tabs

`/ptk-usage` defaults to **1 day**, with distinct **7 days** and **30 days** tabs. These mean the rolling last **24/168/720 hours across projects**, not calendar days. Left/Right or Tab switches periods; Up/Down and PageUp/PageDown scroll; Escape/Enter closes. The tab row and key hints remain visible. Reopen to refresh the snapshot; changing tabs never rescans.

The read-only scan uses native Pi session JSONL under Pi's agent sessions directory, plus the active custom session directory/file and completed in-memory entries. Message timestamps determine inclusion; summary entries use their ISO timestamps. The cutoff is a fixed UTC instant. All branches, compacted messages, compaction/branch-summary usage, and finalized `toolResult.usage` count. Reasoning is a reported subset of output, not an additional token total. Retained context copies, `obs-turn`, notifications, and nested tool details are not accounting sources.

Native fork/clone copies are deduplicated by stable entry ID, timestamp and payload hash, not the short ID alone. Unreported/pending nested work is unavailable. **An independently saved child ledger and its parent's aggregated tool usage lack shared provenance, so their overlap cannot be reliably reconciled.** No model/provider-name heuristic hides custom models or guesses whether a native ledger is a test; non-session telemetry is rejected.

Pi 0.84.2 has no public cross-session usage API. `SessionManager.list/listAll` build search previews without cancellation/pagination; `open` loads synchronously and may migrate files. Instead, the local UI scans the documented format once, sequentially, with cancellation and limits: 30 seconds, 512 MiB total, 10,000 files, 64 MiB per file. Malformed records, inaccessible/oversized files, unsupported legacy v1 sessions and budget exhaustion show partial-coverage warnings. Files are never migrated or changed. Custom session directories not associated with the active runtime are not discoverable.

Costs are recorded Pi/provider estimates, not subscription bills. Missing costs show `+?`; zero may also represent unknown catalog pricing. No new pricing table, model call, persistent tracker, or accounting cache is used. Session content stays local and is never injected into the conversation.

## Persistence

| Data | Location |
|---|---|
| Workflow settings | `pi-toolkit.json` beside `index.ts` |
| Generated-title provenance | `pi-toolkit:auto-title` custom entries in the Pi session file |
| Active dollar skills | `pi-toolkit:skill-loader` custom entries on the active session branch |

The footer and usage modules have no persistent state. Obsolete `pi-toolkit.footer` settings, `~/.pi/agent/observability/` files, and existing `obs-turn` entries are left untouched and ignored; there is no migration or deletion of user data. The old `/ptk-obs` and `/ptk-footer-settings` commands are removed.

## Compatibility and limitations

- Most workflow, editor, settings, and dashboard features require TUI mode.
- Only the seven listed built-in tools participate in grouped rendering.
- `Alt+O` is not currently configurable through Pi keybindings.
- Repeat-paste expansion relies on Pi editor internals and may require adjustment after upstream editor changes.
- Transcript markers are skipped on Pi versions without Markdown-transformer support.
- The custom footer replaces information shown only by Pi's stock footer or other footer implementations.
- Background tasks are session-scoped; a force-killed Pi process can bypass orderly process and temporary-log cleanup.

## Development

Run the regression test:

```bash
npm test
```

The tests cover grouped rendering, collapsed layouts, expansion, previews, diff colors, session reconstruction, bounded background-task execution and retention, confirmed stop/clear behavior, scroll/follow refresh, titles, automatic and `Ctrl+B` detachment, completion notifications, cleanup, repeat-paste behavior, command registration, persistent/lazy skill loading, fuzzy skill completion, automatic session titles, compact-context handoff, and the interactive question component.

## Provenance

The workflow, grouped-tool, skill, editor, integration, and replacement footer/usage modules are locally owned. The removed observability implementation was derived from `pi-observability` 1.3.2; its historical attribution and MIT notice are retained. The ask-user-question subtree is derived from `pi-askuserquestion` 1.0.0 under the MIT License.

See:

- [`PROVENANCE.md`](PROVENANCE.md)
- [`pi-toolkit-lib/LICENSE.pi-observability`](pi-toolkit-lib/LICENSE.pi-observability)
- [`pi-toolkit-lib/LICENSE.pi-askuserquestion`](pi-toolkit-lib/LICENSE.pi-askuserquestion)
