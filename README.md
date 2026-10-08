# pi-toolkit

A local Pi extension that combines session Goals, unified subagents and workflows, background Bash, compact tool rendering, skill shortcuts, editor enhancements, and a rolling usage dashboard.

Toolkit loads through **one extension entrypoint**, `index.ts`. Goals and unified subagents are internal registrations, not separately installed extensions. The current development and regression-test baseline is **Pi 0.99.1**.

- [Commands](#commands) and [configuration](#workflow-settings)
- [Integration architecture, settings ownership, and migration](docs/integration.md)
- [Source provenance](PROVENANCE.md)

## Features

| Area | Custom behavior |
|---|---|
| Tool rendering | Groups consecutive built-in tool calls with collapsed, preview, and expanded layouts |
| Background tasks | Adds Claude Code-style background execution, `Ctrl+B` detachment, completion notifications, and a `/tasks` manager |
| Unified subagents | Runs Pi, Claude Code, Codex, and Agy subagents through one `Agent` tool, shared Activity view, steering, results, schedules, and transcripts |
| Subagent workflows | Deterministic script orchestration with checkpoints, structured output, validation gates, and a workflow inspector |
| Transcript | Adds Codex-style activity markers to user, assistant, thinking, and tool content |
| Session titles | Refreshes the session name after each turn using an available lightweight model |
| Skills | Adds persistent `$skill-name` activation, fuzzy autocomplete, and lazy prompt loading |
| User questions | Adds a structured `ask_user_question` tool with single-select, multi-select, and free-text answers |
| Context control | Adds an explicit-only `context_tool` tool for normal compaction or an opt-in blank chat |
| Goals | Integrates upstream pi-goal for session-scoped objectives, settled-idle continuation, safety limits, completion, blocking, and external waiting |
| Paste handling | Repeating a collapsed long paste expands it inline for editing |
| Footer | Fixed model, folder, Git branch, context/input/output, estimated generation TPS, and session cost; Goal status appears first when present |
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

`/ptk` reloads Pi automatically after workflow settings change. Toolkit leaves Pi's built-in footer unchanged.

If migrating from standalone Goal or unified-subagent extensions, remove their old package/extension registrations before reloading. Keep their settings and session data. See the [migration checklist](docs/integration.md#migration-checklist); installing Toolkit does not automatically rewrite Pi's package list.

## Commands

| Command | Purpose |
|---|---|
| `/ptk` | Configure workflow features and the `ptk/lite` model |
| `/ptk-usage` | Rolling 1-day, 7-day, and 30-day usage tabs across Pi sessions |
| `/tasks` | View, stop, and clear background tasks |
| `/agents` | View running and completed agents |
| `/agents-options` | Manage agent types, schedules, running jobs, and settings |
| `/goal` | Manage a session goal; start with `/goal <objective>`, or use `status`, `pause`, `resume`, `edit`, and `clear` |
| `/economy on\|off\|stats` | Toggle the 16 KiB read-content cap; inspect reads shortened, bytes withheld, estimated tokens avoided, and bulk-reader usage. Guidance stays cache-stable and bulk-reader stays available in both modes. |
| `/skills-clear` | Clear the active dollar-skill set |

`/agents` opens the activity list directly. Agent types, schedules, settings, and the workflow inspector are under `/agents-options`; they are not submenus of `/agents`.

### Model-visible tools

| Area | Tools |
|---|---|
| Delegation | `Agent`, `get_subagent_result`, `steer_subagent` |
| Workflow orchestration | `SubagentWorkflow` — use only with explicit user opt-in |
| Background Bash | Extended `bash`, `bash_output`, `bash_jobs`, `bash_stop` |
| Goals | `goal_complete`, `goal_blocked`, `goal_wait` |
| Clarification and context | `ask_user_question`, `context_tool` |

Tool visibility is not permission to activate Goal mode, compact proactively, or start a multi-agent workflow. Each tool retains its own consent and safety contract.

The old `/ptk-settings` and `/ptk-workflow-settings` names are intentionally removed.

## Goals

Toolkit registers the pinned [@narumitw/pi-goal](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-goal) runtime (MIT) internally; it is a dependency, not a second Pi extension entrypoint. Remove its standalone `npm:@narumitw/pi-goal` package declaration from Pi settings when switching to Toolkit's integration, otherwise both copies register the same tools and lifecycle handlers. Keep `~/.pi/agent/pi-goal.json` and your session files: settings and `goal-state` persistence retain their upstream format.

Use `/goal <objective>` to activate Goal mode. `/goal` opens its manager and settings; `/goal --tokens 100k <objective>` adds an optional cumulative assistant-token budget. Default safety limits remain 25 automatic responses and 3 no-progress responses. Goals can trigger repeated paid model turns; token budgets and response limits are not dollar-cost caps.

`goal_complete`, `goal_blocked`, and `goal_wait` retain upstream evidence, active-goal, stale-id, and safety checks. Merely exposing these tools does not activate Goal mode. Child sessions created by Toolkit's subagent runner or mention clone do not register Goal commands, tools, or continuation handlers. Goal status is published through Pi's native extension status API.

## Keybindings

| Key | Behavior |
|---|---|
| `Ctrl+O` | Toggle grouped tool output between collapsed and fully expanded |
| `Ctrl+Q` | Cycle the collapsed layout: `one line` → `list` → `normal` (same on Mac and Windows) |
| `Ctrl+B` | Detach a running foreground agent, or foreground Bash when no agent can be detached |

`Ctrl+O` uses Pi's configurable `app.tools.expand` action. Toolkit uses **Ctrl+Q** for layout cycling on every platform, without Option/Meta or function-key configuration. The former Alt+O and F6 layout bindings are removed. With Compact tools enabled, Ctrl+Q takes precedence over Pi's default Windows/WSL follow-up shortcut; it cycles the layout instead of queuing a message.

Toolkit viewer navigation also has modifier-free aliases on all platforms: **k/j** scroll lines, **u/d** scroll pages, and **g/G** jump to the top/end. In `/tasks`, Up/Down still selects tasks; k/j scrolls only the selected task's output. In the agent conversation viewer, these aliases apply only outside the steering composer, where letters remain normal text.

### Delete the previous word

Toolkit adds **Ctrl+Backspace** to Pi's existing `tui.editor.deleteWordBackward` action while a TUI session is active. **Ctrl+W** and **Alt+Backspace** remain available by default. The alias works in the main editor and standard Pi `Input`/`Editor` fields, including extension composers that use those components. It uses Pi's normal word boundaries, yank and undo behavior; no keybindings file is rewritten. Explicitly disabling the action or assigning Ctrl+Backspace to another action in your user keybindings takes precedence.

On macOS, Control+Delete is Control+Backspace on a keyboard whose backspace key is labeled Delete. The terminal must report the Control modifier separately (Kitty/CSI-u or xterm modifyOtherKeys); if it sends the same bytes for plain Backspace and Ctrl+Backspace, Toolkit cannot safely distinguish them. Configure the terminal to send `ESC [ 127 ; 5 u`, or map the chord to Ctrl+W. Pi also recognizes Windows Terminal's legacy Ctrl+Backspace byte (`0x08`) locally; over SSH it is treated as plain Backspace to avoid ambiguity. Plain Backspace remains character deletion. This is a Pi shortcut, not an OS-wide remapping for unrelated apps, and it does not override non-editing contexts such as the session picker's existing Ctrl+Backspace action.

Run `/reload` to activate this change in an already running Pi session.

### Recommended Pi cursor keybindings

Pi defaults `Ctrl+B` to cursor-left, which conflicts with Toolkit's agent and Bash backgrounding shortcut. To reserve `Ctrl+B` for Toolkit and keep single-character cursor movement consistent in both directions, merge these entries into `~/.pi/agent/keybindings.json`:

```json
{
  "tui.editor.cursorLeft": "left",
  "tui.editor.cursorRight": "right"
}
```

This makes single-character movement arrow-only, removing Pi's `Ctrl+B` and `Ctrl+F` cursor bindings. Run `/reload` after changing the file. Toolkit does not automatically rewrite your Pi keybindings file; the word-delete alias above is session-only.

## Grouped tool rendering

When **Compact tools** is enabled, the toolkit replaces the rendering of these Pi built-ins while preserving their normal execution:

- `read`
- `bash`
- `edit`
- `write`
- `grep`
- `find`
- `ls`

Toolkit's `bash_output` and `bash_stop` also participate in the group, using their task ID as the target. `bash_jobs` and other custom/unsupported tools keep their normal renderer and break the current group. Task-tool execution and output bounds are unchanged.

### Group boundaries

Consecutive supported calls are rendered as one block. Tool-only assistant turns may merge across their tool results. A group ends when Pi encounters:

- a user message
- non-empty assistant narration
- non-empty thinking
- an unsupported tool (including custom tools other than `bash_output` and `bash_stop`)

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

Commands run in the foreground by default. If one is still running after 60 seconds, the toolkit automatically moves it into the background; `Ctrl+B` does the same immediately and preserves its title. Its Bash tool call returns with a session-local task ID such as `bash-1` while the process continues, streaming combined stdout/stderr directly to a temporary log rather than retaining it in session context. Explicit titles name `/tasks` rows; a sanitized, whitespace-normalized command is the fallback. While any are running, the below-editor activity surface exposes a Tasks tab; Toolkit does not customize Pi's footer.

Open `/tasks` for the live task list and selected task's five-line output window. Use Up/Down to select a task, Ctrl+Alt+Up/Down to scroll output one line, Alt+Up/Down to move one page, and Ctrl+Up/Down to jump to the top or resume following the tail. Modifier-free `k`/`j` scroll output lines, `u`/`d` scroll pages, and `g`/`G` jump to top/tail; Mac hints show these keys. Page Up/Page Down and Home/End also remain aliases. Selection follows the task ID when the list changes. Destructive actions require the same key twice: `x x` stops a running task but retains its record and output, `c c` or Delete twice clears a selected finished task, and `C C` clears all finished tasks. Duplicate asynchronous actions are ignored while one is pending. The agent can also use:

| Tool | Purpose |
|---|---|
| `bash_output` | Read current status and the last 2,000 lines or 50KB of output |
| `bash_jobs` | List tasks started in the current Pi session |
| `bash_stop` | Stop a task and its child process tree |

The optional `timeout` is the first review deadline, not an automatic kill: a direct, tool-free light-model call receives only the command, elapsed time, bounded recent output, output growth, and review/extension history. It may recommend 1–3,600 more seconds up to three times; a stop recommendation, malformed or unavailable model response, or exhausted review budget terminates the process tree. Without `timeout`, there is no deadline. Stop, timeout, and shutdown use the same idempotent termination flow: POSIX sends graceful tree termination before a forced fallback; Windows force-terminates the tree because it has no reliable equivalent for arbitrary console processes. Both paths confirm process exit and log-stream flush. A stop is not reported as successful when exit cannot be confirmed.

Per-job logs are capped at 2 MiB by default. Once full, the file records a limit marker, the process continues, dropped bytes are counted, and `bash_output` keeps returning the recent bounded tail. At most 50 finished tasks are retained by default; eviction, clearing, and shutdown remove their temporary directories. Foreground jobs that never detach remove their temporary directory after settlement. `/tasks` refreshes from manager list/output events, throttles output paints to roughly 100 ms, and runs its one-second elapsed clock only while work is active. Task labels and preview output strip terminal control and bidirectional-control characters.

When a background task exits, fails, is stopped, or times out, the toolkit sends a short two-line follow-up with its task ID, title, final status/exit code, and a reminder to call `bash_output` only when needed; it triggers the next turn. The temporary log path stays in message metadata rather than the notification text. The TUI renders a single muted, width-truncated line such as `bg bash-1 · done · Build`; nonzero exits retain their status/exit code. Output enters context only when the agent explicitly calls `bash_output`, which remains bounded to 2,000 lines or 50KB. Active tasks are stopped and all task temp directories are removed during reload, session replacement, and orderly Pi shutdown. Task state is intentionally in-memory and does not survive a restart.

The shared activity surface appears only while background tasks are running or top-level agents are running/queued. While inactive it stays collapsed to the available filled, muted count tabs (`Tasks N` and/or `Agents N`). Down always focuses the tabs—even when only one category exists—and a second Down expands and enters the selected list. Left/Right switches categories from either the tabs or rows. Up from the first row collapses back to the tabs; Up again or Esc returns to the editor. Enter opens the selected agent conversation or `/tasks` focused on the selected task; closing that detail view returns to its Activity list while it still has active rows, otherwise to the remaining Activity tab or editor. Its terminal-input handler runs before editor shortcuts, so `Ctrl+B` detaches a blocking foreground agent when one exists and consumes the key; otherwise it passes through to the background-task shortcut.

## Unified subagents

The toolkit's sole extension entrypoint privately registers the unified-subagent module. It preserves the established `Agent`, `get_subagent_result`, and `steer_subagent` tools, `/agents` UI, FleetView, schedules, child-session protection, persisted transcripts, output files, and `subagents:*` extension interfaces. The `Agent` tool selects a Pi, Claude Code, Codex, or Agy harness through its `harness` argument or agent frontmatter.

An unqualified fresh `Agent` call starts in the foreground and automatically moves to the background after 300 seconds if still running. `run_in_background: true` detaches immediately; `false` keeps the call foreground until completion. `Ctrl+B` can detach a foreground run sooner.

FleetView now provides the shared live activity surface: the legacy `Agents` widget above the editor is always suppressed, while the below-editor tabs combine running tasks with running/queued agents without showing completed items. Agent rows show tool uses, turn/token/context usage, elapsed time, and current activity; task rows show their title, ID, and elapsed time. Disabling FleetView hides the shared surface rather than restoring the legacy widget. Final `Agent` tool results and session records remain unchanged. The full-screen conversation viewer pairs calls with compact status rows, keeps failures visible, and uses Pi's `app.tools.expand` action (`Ctrl+O` by default) to toggle successful result details. It caches finalized transcript history, rebuilds only the streaming tail, and coalesces delta paints so long sessions stay responsive without changing compaction behavior. Line/page scrolling honors configured `tui.select.*` bindings. Up/Down (plus `K`/`J`) scroll one line, Alt+Up/Down scroll one page, and Ctrl+Up/Down jump to the top/bottom. Page Up/Page Down and Home/End remain aliases. `Ctrl+O` follows `app.tools.expand`, and Esc/Ctrl+C/`q` closes.

The v0.19 upstream integration adds [`SubagentWorkflow`](docs/unified-subagents/docs/workflows.md): saved or generated JavaScript can coordinate agents, validate structured results, run test gates, and replay an unchanged journal prefix. Workflow rows live in the existing Agents Activity tab; `/agents-options → Workflows` opens their inspector. Agent-file harness/model policy still applies, and unsupported native-harness schema/resume requests fail explicitly. Workflows default to auto-enabled, standing down when a foreign `Workflow`, `workflow`, or `SubagentWorkflow` tool exists.

The viewer renders assistant Markdown by default; `m` cycles `off / assistant / all`, persisted as `viewerMarkdown`. Expanded tool results are bounded at 16,000 characters, without changing stored transcripts. `maxConcurrentForeground` adds an optional independent blocking-agent limit (`0` means unlimited); auto-detachment still moves the same live child into background accounting. BOM-prefixed agent files are parsed correctly.

The imported subagent baseline originally required Pi `>=0.84.0`; the complete Toolkit integration is currently developed and tested against Pi **0.99.1**. Older upstream requirements are not a verification claim for all current Toolkit features. The exact upstream update baseline is tracked in [`docs/unified-subagents/UPSTREAM.json`](docs/unified-subagents/UPSTREAM.json); see the [port record](docs/unified-subagents/upstream-v0.19-port.md) before the next upstream comparison.

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

When **Automatic session titles** is enabled, the toolkit refreshes the current session name after every completed turn without blocking the main conversation. With a model scope, it resolves the Lite preference within that scope: Auto selects a lightweight physical model, while a manual pin is used only if it is in scope. Without a scope, it prefers the `ptk/lite` virtual model and falls back to the physical selector when the alias is unavailable. Auto selection matches whole tokens in model IDs/names in this order: Luna, Mini, Haiku, Flash, Lite, Small, then chooses the highest numeric version within the first matching family; virtual models are excluded. If no matching physical model is available, title generation is skipped or its optional request fails silently.

### Reusable light-model alias

`ptk/lite` is registered independently of the automatic-title toggle on Pi versions with virtual-model support. Configure its target in **`/ptk` → Lite model**, using the searchable picker. **Auto** (the default) dynamically selects the newest available physical model within the preferred lightweight family. The settings row and Auto picker option display its resolved `provider/modelId` (or indicate that no model is available). Choosing an exact `provider/modelId` pins the alias to that physical model, even when newer versions appear. Select Auto again to restore dynamic selection. Virtual models—including `ptk/lite` itself—are excluded from targets. An unavailable manual pin produces an error instead of silently falling back; optional title generation and Bash reviews may skip their request. The alias is not a new provider, credential, or promise of a particular price. **Lite reasoning effort** in `/ptk` sets the default to Off, Low, or Medium (Low by default). Direct Toolkit metadata calls use this default; explicit interactive Pi or subagent thinking selections remain authoritative. Continuations and retries retain their previous/failed route and effort rather than switching mid-request. Background Bash deadline reviews prefer this alias when available. The reserved read-only `bulk-reader` also uses `ptk/lite`, including when child extensions are disabled. Other subagent types retain their own light-model and harness settings; this is not yet one unified model-policy setting.

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

## Workflow settings

Open `/ptk` in TUI mode:

| Setting | Values | Default |
|---|---|---|
| Lite model | `Auto` (shows resolved model), exact physical `provider/modelId` | `Auto` |
| Lite reasoning effort | `off`, `low`, `medium` | `low` |
| Automatic session titles | `on`, `off` | `on` |
| Compact tools | `on`, `off` | `on` |
| Dollar skills | `on`, `off` | `on` |

Changes are written immediately to `pi-toolkit.json`. Closing the settings screen after a change reloads Pi. The collapsed tool layout is intentionally absent from `/ptk`; use Ctrl+Q to cycle it.

Current configuration:

```json
{
  "autoSessionTitles": true,
  "compactTools": true,
  "dollarSkills": true,
  "toolView": "list"
}
```

`liteReasoning` persists the default reasoning effort; existing configurations without this key use `low`.

`liteModel` is absent in Auto mode. Manual selection persists an exact ID, for example `"liteModel": "openai/gpt-5.6-luna"`, and is not automatically upgraded. This setting controls `ptk/lite`; the separate `/agents` Light model setting still controls other subagent recommendations.

`toolView` persists the last layout selected with Ctrl+Q; it is not edited through `/ptk`. The legacy stored value `"compact"` is interpreted as `"one line"`.

## Footer

Toolkit uses Pi's built-in footer without replacing it. Goal continues publishing its status through Pi's native extension status API. Background-task activity remains in the below-editor activity surface, and `/ptk-usage` remains available for rolling usage details.

## Rolling usage tabs

`/ptk-usage` defaults to **1 day**, with distinct **7 days** and **30 days** tabs. These mean the rolling last **24/168/720 hours across projects**, not calendar days. Left/Right or Tab switches periods; Up/Down and PageUp/PageDown scroll; Escape/Enter closes. The tab row and key hints remain visible. Reopen to refresh the snapshot; changing tabs never rescans.

The read-only scan uses native Pi session JSONL under Pi's agent sessions directory, plus the active custom session directory/file and completed in-memory entries. Message timestamps determine inclusion; summary entries use their ISO timestamps. The cutoff is a fixed UTC instant. All branches, compacted messages, compaction/branch-summary usage, and finalized `toolResult.usage` count. Reasoning is a reported subset of output, not an additional token total. Retained context copies, `obs-turn`, notifications, and nested tool details are not accounting sources.

Native fork/clone copies are deduplicated by stable entry ID, timestamp and payload hash, not the short ID alone. Unreported/pending nested work is unavailable. **An independently saved child ledger and its parent's aggregated tool usage lack shared provenance, so their overlap cannot be reliably reconciled.** No model/provider-name heuristic hides custom models or guesses whether a native ledger is a test; non-session telemetry is rejected.

The dashboard reads native session JSONL directly rather than opening sessions through `SessionManager.open`, which can load or migrate them. The local UI scans the documented format once, sequentially, with cancellation and limits: 30 seconds, 512 MiB total, 10,000 files, 64 MiB per file. Malformed records, inaccessible/oversized files, unsupported legacy v1 sessions and budget exhaustion show partial-coverage warnings. Files are never migrated or changed. Custom session directories not associated with the active runtime are not discoverable.

Costs are recorded Pi/provider estimates, not subscription bills. Missing costs show `+?`; zero may also represent unknown catalog pricing. No new pricing table, model call, persistent tracker, or accounting cache is used. Session content stays local and is never injected into the conversation.

## Persistence

| Data | Location |
|---|---|
| Workflow settings | `pi-toolkit.json` beside `index.ts` |
| Generated-title provenance | `pi-toolkit:auto-title` custom entries in the Pi session file |
| Active dollar skills | `pi-toolkit:skill-loader` custom entries on the active session branch |
| Goal settings | `<getAgentDir()>/pi-goal.json`, normally `~/.pi/agent/pi-goal.json` |
| Goal state | Upstream `goal-state` custom entries in the current Pi session |
| Agent definitions | `.pi/agents/*.md` (project), `<getAgentDir()>/agents/*.md` (global) |
| Subagent settings | `.pi/subagents.json` (project), `<getAgentDir()>/subagents.json` (global) |
| Background tasks | In-memory task records and temporary output files; not restart-persistent |

These stores remain separate. `/ptk` does not edit Goal or subagent settings. See [settings ownership](docs/integration.md#settings-and-state-ownership) for the integration boundaries.

The usage module has no persistent state. Obsolete `pi-toolkit.footer` settings, `~/.pi/agent/observability/` files, and existing `obs-turn` entries are left untouched and ignored; there is no migration or deletion of user data. The old `/ptk-obs` and `/ptk-footer-settings` commands are removed.

## Compatibility and limitations

- Most workflow, editor, settings, and dashboard features require TUI mode.
- Grouped rendering supports the seven listed built-ins plus `bash_output` and `bash_stop`; `bash_jobs` remains separate.
- The Ctrl+Q layout shortcut is not currently configurable through Pi keybindings.
- Repeat-paste expansion relies on Pi editor internals and may require adjustment after upstream editor changes.
- Transcript markers are skipped on Pi versions without Markdown-transformer support.
- Background tasks are session-scoped; a force-killed Pi process can bypass orderly process and temporary-log cleanup.

## Development

Use the checkout's installed tools and lockfile:

```bash
npm ci
npm run lint
npm run typecheck
npm run build
npm test
```

`npm test` runs the real grouped-renderer check followed by the full Vitest suite. For a focused iteration, run from the repository directory:

```bash
npm exec -- vitest run test/goals.test.ts test/usage.test.ts
```

Additional scripts: `npm run test:e2e` targets `test/unified-subagents/e2e` (not every print-mode test); `npm run test:coverage` collects coverage; `npm run bench` and `npm run bench:ab` run performance measurements. Live-provider checks require their own explicit opt-in.

Pi SDK dependencies are externalized so tests and recursively loaded child sessions share native provider registries without repeatedly transforming the SDK. Keep file serialization: nested sessions and Windows worktree cleanup can become unstable under indiscriminate parallelism. A measured full offline run passed **129 files / 2,425 tests**, with **21 skipped**, in about **450 seconds**, versus about **904 seconds** with blanket SDK inlining. These are machine-specific observations, not time guarantees; use at least a ten-minute watchdog for the full suite. Smaller selections are preferable during iteration.

The tests cover grouped rendering, collapsed layouts, expansion, previews, diff colors, session reconstruction, bounded background-task execution and retention, confirmed stop/clear behavior, scroll/follow refresh, titles, automatic and `Ctrl+B` detachment, completion notifications, cleanup, repeat-paste behavior, command registration, persistent/lazy skill loading, fuzzy skill completion, automatic session titles, compact-context handoff, and the interactive question component. Goal tests additionally cover ordinary turns remaining inactive, stale/inactive completion rejection, completion persistence/clearing, child-session exclusion, and native status updates.

## Provenance

The workflow, grouped-tool, skill, editor, integration, and usage modules are locally owned. The removed observability implementation was derived from `pi-observability` 1.3.2; its historical attribution and MIT notice are retained. The ask-user-question subtree is derived from `pi-askuserquestion` 1.0.0 under the MIT License. Unified subagents is a selectively ported internal source tree. Goals uses the pinned MIT-licensed `@narumitw/pi-goal` 0.54.8 runtime dependency rather than a vendored copy.

See:

- [`PROVENANCE.md`](PROVENANCE.md)
- [`pi-toolkit-lib/LICENSE.pi-observability`](pi-toolkit-lib/LICENSE.pi-observability)
- [`pi-toolkit-lib/LICENSE.pi-askuserquestion`](pi-toolkit-lib/LICENSE.pi-askuserquestion)
