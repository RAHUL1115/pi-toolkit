# pi-toolkit

A local Pi extension that combines workflow improvements, compact tool rendering, skill shortcuts, editor enhancements, and an observability footer/dashboard.

## Features

| Area | Custom behavior |
|---|---|
| Tool rendering | Groups consecutive built-in tool calls with collapsed, preview, and expanded layouts |
| Transcript | Adds Codex-style activity markers to user, assistant, thinking, and tool content |
| Session titles | Refreshes the session name after each turn using an available lightweight model |
| Skills | Adds `$skill-name` autocomplete and prompt expansion |
| User questions | Adds a structured `ask_user_question` tool with single-select, multi-select, and free-text answers |
| Paste handling | Repeating a collapsed long paste expands it inline for editing |
| Windows editor | Makes `Ctrl+Backspace` delete the previous word in supported terminals |
| Footer | Shows model, runtime, path, Git, context, tokens, TPS, and cost |
| Observability | Provides a session dashboard, per-turn metrics, TPS summaries, and history |

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

`/ptk` reloads Pi automatically after workflow settings change. Footer settings apply immediately.

## Commands

| Command | Purpose |
|---|---|
| `/ptk` | Configure workflow feature toggles |
| `/ptk-footer-settings` | Configure the footer, segments, presets, path display, and context thresholds |
| `/ptk-obs` | Open the observability dashboard |

The old `/ptk-settings` and `/ptk-workflow-settings` names are intentionally removed.

## Keybindings

| Key | Behavior |
|---|---|
| `Ctrl+O` | Toggle grouped tool output between collapsed and fully expanded |
| `Alt+O` | Cycle the collapsed layout: `one line` → `list` → `normal` |
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

When **Dollar skills** is enabled, skills can be referenced directly in a prompt:

```text
$ponytail make this implementation smaller
```

Multiple skills may be referenced in one prompt. Recognized `$skill-name` tokens are replaced with instructions to load or follow the matching Pi skill. Unknown `$name` tokens are left unchanged.

The TUI autocomplete provider:

- triggers on `$` at the start of input or after whitespace
- searches Pi commands whose source is `skill`
- ranks prefix matches first
- shows skill descriptions
- returns at most 20 suggestions

A leading standard `/skill:skill-name` command is also handled by the same workflow.

## Ask user questions

The `ask_user_question` tool lets the agent pause for structured clarification in TUI mode. It supports one to four questions, two to four choices per question, single- and multi-select answers, custom free-text answers, tabbed navigation, and a final review screen.

Outside TUI mode, the tool returns an explanatory error and disables itself for the session.

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

## Observability footer

The toolkit footer replaces Pi's default footer when enabled. It can show:

- model and thinking level
- observed fast/priority service tier
- session runtime
- current folder or full working path
- Git branch and textual diff counts
- context usage bar, percentage, and token counts
- completed-turn input/output tokens
- live or last-turn TPS
- estimated session cost

When the content does not fit on one line, the footer falls back to two truncated lines.

### Metric behavior

- **Git diff:** polls `git diff --numstat` every second; binary and untracked-file counts are not included.
- **Context zones:** colors context usage using the configured expert and warning thresholds.
- **Live TPS:** estimates streaming throughput from message-update chunks.
- **Turn TPS:** divides output tokens by turn duration.
- **Cost and tokens:** depend on usage reported by the active provider.
- **Fast mode:** shown only after a supported OpenAI response reports a priority/fast service tier.

## Footer settings

Open `/ptk-footer-settings` to change settings immediately.

### General settings

| Setting | Default |
|---|---|
| Pi Toolkit Footer | `true` |
| Full Working Path | `false` |
| Layout Preset | `standard` |
| Expert Zone Threshold | `70` |
| Warning Zone Threshold | `85` |

The expert threshold is always kept less than or equal to the warning threshold.

### Presets

| Preset | Intended layout |
|---|---|
| `minimal` | Model and compact context information |
| `standard` | Model, runtime, path, Git, context, tokens, and cost |
| `verbose` | Every segment, including TPS |
| `performance` | Model, context percentage/counts, TPS, and cost |

Applying a preset updates all segment toggles. Individual segments can still be changed afterward.

### Segment toggles

- Model & Thinking
- Runtime
- Working Directory
- Git Branch & Diff
- Context Usage
  - Progress Bar
  - Percentage
  - Used / Total
- Session Tokens
- TPS
- Cost

The context child toggles have no visible effect while the Context Usage master toggle is off.

### Threshold choices

- Expert: `60`, `65`, `70`, `75`, `80`
- Warning: `75`, `80`, `85`, `90`, `95`

## Observability dashboard

`/ptk-obs` opens a TUI dashboard containing:

- runtime, working directory, branch, model, and service tier
- total input/output tokens and estimated cost
- per-turn input, output, duration, TPS, cost, and model
- the latest 10 persisted session summaries

Close the dashboard with `Escape`, `Enter`, or `Space`.

## End-of-run TPS summary

After an agent run, the toolkit displays a summary containing TPS, output/input/cache tokens, total tokens, and elapsed time. This summary is independent of the footer-enabled and footer-TPS settings.

## Persistence

| Data | Location |
|---|---|
| Workflow settings | `pi-toolkit.json` beside `index.ts` |
| Generated-title provenance | `pi-toolkit:auto-title` custom entries in the Pi session file |
| Footer settings | `pi-toolkit.footer` in `~/.pi/agent/settings.json` |
| Session history | `~/.pi/agent/observability/history.jsonl` |
| Per-turn observability | `obs-turn` custom entries in the Pi session file |

Only the latest 10 cross-session summaries are retained. History is finalized during orderly session shutdown.

Legacy footer settings under `~/.pi/agent/observability/settings.json` are migrated into Pi's namespaced global settings and then removed.

## Compatibility and limitations

- Most workflow, editor, settings, and dashboard features require TUI mode.
- Only the seven listed built-in tools participate in grouped rendering.
- `Ctrl+Shift+O` is not currently configurable through Pi keybindings.
- Repeat-paste expansion relies on Pi editor internals and may require adjustment after upstream editor changes.
- Transcript markers are skipped on Pi versions without Markdown-transformer support.
- The custom footer replaces information shown only by Pi's stock footer or other footer implementations.
- Session history may miss the final run if Pi is force-killed without shutdown.

## Development

Run the regression test:

```bash
npm test
```

The tests cover grouped rendering, collapsed layouts, expansion, previews, diff colors, session reconstruction, repeat-paste behavior, command registration, automatic session titles, and the interactive question component.

## Provenance

The workflow, grouped-tool, skill, editor, and integration features are locally owned. The observability/footer subtree is a modified derivative of `pi-observability` 1.3.2, and the ask-user-question subtree is derived from `pi-askuserquestion` 1.0.0; both are under the MIT License.

See:

- [`PROVENANCE.md`](PROVENANCE.md)
- [`pi-toolkit-lib/LICENSE.pi-observability`](pi-toolkit-lib/LICENSE.pi-observability)
- [`pi-toolkit-lib/LICENSE.pi-askuserquestion`](pi-toolkit-lib/LICENSE.pi-askuserquestion)
