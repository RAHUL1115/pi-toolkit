# Terminal title and attention signaling in coding-agent CLIs

**Conclusion:** Pi can implement a Claude/Codex-style working/idle title safely with an extension, and can identify action-required states created by extension UI prompts. Pi cannot currently identify every core permission/input wait through one public extension event, so a title must not claim universal action-required coverage. Pi already has a separate, opt-in OSC 9;4 progress facility; an extension should not compete with it.

## Do not conflate the three surfaces

| Surface | Mechanism | Meaning |
|---|---|---|
| Tab/window title | Usually OSC 0 (`ESC ] 0 ; title BEL`; OSC 1/2 are variants) | Persistent, low-urgency identity or state text |
| Terminal/taskbar progress | ConEmu OSC 9;4 | Running, determinate, warning, or error progress where supported |
| Notification | OSC 9/99/777, BEL, or an OS API | An out-of-band request for attention |

Windows Terminal explicitly treats OSC 9;4 as progress, showing it in the tab header and Windows taskbar. Its states are hidden (`0`), determinate (`1`), error (`2`), indeterminate (`3`), and warning (`4`). This is independent of the tab title.[^wt-progress] Windows Terminal normally accepts application-controlled titles, but a profile with `suppressApplicationTitle: true` deliberately decouples the visible tab title from the application's title.[^wt-title]

## Upstream behavior

### Claude Code 2.1.258

Claude Code's documented settings expose two independent controls:

- `terminalTitleFromRename` controls whether `/rename` and `--name` alter the terminal title.[^claude-settings]
- `terminalProgressBarEnabled` controls OSC 9;4 progress during long operations.[^claude-settings]

The packaged Linux x64 binary chooses a title from, in order, a renamed session, an AI session title, agent/Haiku-generated titles, then `Claude Code`; it also recognizes `CLAUDE_CODE_DISABLE_TERMINAL_TITLE`. Its progress helper reports `indeterminate` while the response is loading or tools remain in progress, `completed` afterward, and clears its status on component cleanup. Notifications are a third path: Claude's official terminal documentation says the built-in notification is used when input is needed and recommends a `Notification` hook or terminal bell where desktop notifications do not work.[^claude-terminal]

**Evidence limit.** Claude Code does not publish this application source in readable form. The preceding implementation details come from Anthropic's versioned `@anthropic-ai/claude-code-linux-x64@2.1.258` package (SHA-256 `704f1334ac65d3e89e1c6c1d7663293ad786a6166afdb71b5075337df630f976`), whose embedded JavaScript is minified.[^claude-package] The package contains OSC title, OSC 9;4, OSC 9/99/777, and BEL paths, but the exact lifecycle-to-title and action-required mapping is not clear enough to state more strongly. In particular, the evidence does **not** establish that Claude's title itself is a complete action-required indicator.

### OpenAI Codex CLI

At inspected commit `a0dcfe2`, Codex defaults the title to `activity` plus `project-name`. While MCP startup or a task is active, `activity` is a braille spinner advanced every 100 ms. If the active bottom-pane view reports that it needs action, the title instead blinks once per second between `[ ! ] Action Required` and `[ . ] Action Required`.[^codex-status]

Codex writes OSC 0 only when stdout is a terminal. Before writing it strips controls and misleading invisible/bidi characters, collapses whitespace, limits the title to 240 characters, and avoids duplicate writes.[^codex-title] On `App::drop`, it clears the title it managed. It does not try to restore the prior shell title because reading/restoring it is not portable.[^codex-cleanup]

Notifications remain separate: Codex selects OSC 9 or BEL, suppresses `Unfocused` notifications while the terminal is focused, and DCS-wraps OSC 9 for tmux.[^codex-notify] No OSC 9;4 implementation exists in this inspected Codex TUI source; its animated title is not taskbar progress.

## What Pi exposes

Pi 0.84.4 already contains almost all required primitives:

- `ctx.ui.setTitle(title)` delegates to the TUI terminal's `setTitle`, which emits OSC 0.[^pi-title]
- The official `titlebar-spinner.ts` starts an 80 ms title spinner on `agent_start`, restores a stable base title on `agent_settled`, and stops the timer again on `session_shutdown`.[^pi-spinner]
- `agent_settled` explicitly means no automatic retry, compaction, or queued continuation remains. It is therefore the correct idle boundary; `agent_end` is too early.[^pi-events]
- `ui_prompt_start` and `ui_prompt_end` bracket blocking user-facing prompts created through extension UI (`select`, `confirm`, `input`, `editor`, and `custom`).[^pi-events]
- Pi's separate `terminal.showTerminalProgress` option emits OSC `9;4;3` while a turn or compaction is active, refreshes it every second, and emits `9;4;0` to clear it.[^pi-progress]
- Pi's official notification example waits for `agent_settled` and independently chooses OSC 777, Kitty OSC 99, or a Windows toast.[^pi-notify]

Thus a Pi extension can maintain this state machine:

1. **Base/idle:** `π - <session> - <cwd>`.
2. **Working:** set a sanitized spinner title on `agent_start` and remember `working = true`.
3. **Action required:** stop the spinner and set `Action required - …` on `ui_prompt_start`.
4. **Resume:** on `ui_prompt_end`, return to working if the run is still active; otherwise use the base title.
5. **Settled/shutdown:** set `working = false`, clear every interval, and restore the base title on both `agent_settled` and `session_shutdown`.

This exactly covers extension-owned blocking prompts. It does not cover every prompt internal to Pi because the public event API has no single universal “core is awaiting permission/input” event. Adding such an event upstream would be required for Codex-equivalent coverage.

## Safety and portability recommendations

- **Use `ctx.ui.setTitle()`**, not `process.stdout.write`, for titles. Raw output can disturb interactive TUI rendering; in noninteractive modes Pi also takes over ordinary stdout to protect structured output.[^pi-output]
- **Sanitize dynamic text:** remove C0/C1 controls (especially ESC, BEL, ST), bidi/invisible formatting, normalize whitespace, and cap length. Pi's low-level title method interpolates the supplied string and does not sanitize it; Codex's policy is a suitable model.
- **Rate-limit and deduplicate.** Roughly 10 updates/second is enough. Clear intervals in both settlement and shutdown paths.
- **Do not emit OSC 9;4 from the extension** when Pi's built-in progress option may own it. Title, progress, and notifications need separate ownership and cleanup.
- **Do not promise title restoration.** Terminals provide no portable title readback. Restore Pi's known base title or clear only the title the extension owns.
- **Expect terminal variance.** OSC 0 is common, not universal; Windows Terminal may suppress it. OSC 9;4 is less portable and should degrade to no progress indication.
- **Handle tmux explicitly.** tmux may consume or rename title state; disable automatic renaming when stable names matter (`setw -g automatic-rename off`). Arbitrary outer-terminal sequences such as notifications and OSC 9;4 require DCS passthrough and, since tmux 3.3, `allow-passthrough on`.[^tmux] Claude's own docs recommend that setting for notifications and progress.[^claude-terminal] Pi's current title/progress writers do not add tmux DCS wrapping.

[^wt-progress]: Microsoft, [Tutorial: Set the progress bar in Windows Terminal](https://learn.microsoft.com/en-us/windows/terminal/tutorials/progress-bar-sequences).
[^wt-title]: Microsoft, [Tutorial: Configure tab titles in Windows Terminal](https://learn.microsoft.com/en-us/windows/terminal/tutorials/tab-title).
[^claude-settings]: Anthropic, [Claude Code settings reference](https://code.claude.com/docs/en/settings-reference#terminalprogressbarenabled) (`terminalProgressBarEnabled`; see also [`terminalTitleFromRename`](https://code.claude.com/docs/en/settings-reference#terminaltitlefromrename)).
[^claude-terminal]: Anthropic, [Configure terminal notifications and tmux](https://code.claude.com/docs/en/terminal-config#configure-notifications).
[^claude-package]: Anthropic, [`@anthropic-ai/claude-code-linux-x64` 2.1.258 registry record](https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/2.1.258).
[^codex-status]: OpenAI Codex, [`status_surfaces.rs` at `a0dcfe2`](https://github.com/openai/codex/blob/a0dcfe2ada3f5bbd5059a34c0fc6fac244741a67/codex-rs/tui/src/chatwidget/status_surfaces.rs#L27-L41), including [action-required selection and animation](https://github.com/openai/codex/blob/a0dcfe2ada3f5bbd5059a34c0fc6fac244741a67/codex-rs/tui/src/chatwidget/status_surfaces.rs#L320-L399).
[^codex-title]: OpenAI Codex, [`terminal_title.rs`](https://github.com/openai/codex/blob/a0dcfe2ada3f5bbd5059a34c0fc6fac244741a67/codex-rs/tui/src/terminal_title.rs#L1-L145).
[^codex-cleanup]: OpenAI Codex, [`App::drop`](https://github.com/openai/codex/blob/a0dcfe2ada3f5bbd5059a34c0fc6fac244741a67/codex-rs/tui/src/app.rs#L1014-L1019) and [managed-title clearing](https://github.com/openai/codex/blob/a0dcfe2ada3f5bbd5059a34c0fc6fac244741a67/codex-rs/tui/src/chatwidget/status_surfaces.rs#L229-L242).
[^codex-notify]: OpenAI Codex, [backend selection](https://github.com/openai/codex/blob/a0dcfe2ada3f5bbd5059a34c0fc6fac244741a67/codex-rs/tui/src/notifications/mod.rs#L17-L53), [focus gating](https://github.com/openai/codex/blob/a0dcfe2ada3f5bbd5059a34c0fc6fac244741a67/codex-rs/tui/src/tui.rs#L783-L801), and [tmux OSC 9 wrapping](https://github.com/openai/codex/blob/a0dcfe2ada3f5bbd5059a34c0fc6fac244741a67/codex-rs/tui/src/notifications/osc9.rs#L9-L53).
[^pi-title]: Pi v0.84.4, [extension UI delegation](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L2458-L2466) and [OSC 0 writer](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/tui/src/terminal.ts#L526-L529).
[^pi-spinner]: Pi v0.84.4, official [`titlebar-spinner.ts`](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/coding-agent/examples/extensions/titlebar-spinner.ts#L19-L58).
[^pi-events]: Pi v0.84.4, [extension lifecycle event definitions](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/coding-agent/src/core/extensions/types.ts#L718-L759).
[^pi-progress]: Pi v0.84.4, [turn/compaction lifecycle calls](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L3195-L3417) and [OSC 9;4 implementation/cleanup](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/tui/src/terminal.ts#L531-L554).
[^pi-notify]: Pi v0.84.4, official [`notify.ts`](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/coding-agent/examples/extensions/notify.ts#L1-L56).
[^pi-output]: Pi v0.84.4, [noninteractive takeover](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/coding-agent/src/main.ts#L634-L637) and [`output-guard.ts`](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/coding-agent/src/core/output-guard.ts#L45-L82).
[^tmux]: tmux, [FAQ: passthrough escape sequences](https://github.com/tmux/tmux/wiki/FAQ#what-is-the-passthrough-escape-sequence-and-how-do-i-use-it) and [`tmux(1)` options](https://github.com/tmux/tmux/blob/9fa390aee696f7c3886bc9146e4051cbbe9593cb/tmux.1).
