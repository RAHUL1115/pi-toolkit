# Background-task UI and runtime comparison

Research snapshot: Claude Code 2.1.259 and the public repositories/commits linked below. “Verified” means documented by a primary source or observed directly in the cited source; recommendations are explicitly separated and are design judgments.

## Executive summary

`pi-toolkit` already has the important baseline: explicit and automatic backgrounding, `Ctrl+B`, session-scoped IDs, combined file-backed output, a live `/tasks` overlay, stop/delete controls, a footer count, and completion messages. Its biggest gaps are not cosmetic. Finished jobs and temporary logs have no retention policy, stop/delete does not wait for confirmed process exit, log growth is unbounded, and completion delivery is one-shot. After those are fixed, the highest-value UI work is to separate **stop** from **clear**, use stable human titles, make the selected preview scrollable/followable, and refresh from lifecycle/output events rather than rereading the log every second.

## Verified facts

### Current `pi-toolkit`

Sources: [`background-bash.ts`](../pi-toolkit-lib/background-bash.ts) and [`background-task-viewer.ts`](../pi-toolkit-lib/background-task-viewer.ts), corroborated by [`background-bash.test.ts`](../test/background-bash.test.ts).

- Naming is the whitespace-normalized command itself; IDs are process-local `bash-N` values. Rows show name, normalized status, elapsed time, and ID. The selected task shows only the last five ANSI-stripped lines.
- `/tasks` refreshes on a one-second interval. It has an eight-row maximum viewport and index-based selection, but no output scrolling, follow mode, filtering, sorting, expanded detail, or terminal-height calculation.
- `x` twice calls `delete`: a running process is stopped and immediately removed from the registry. There is no distinct “stop but retain” versus “clear finished” interaction.
- Output is combined stdout/stderr in a per-job temporary `output.log`. Reads are tail-truncated to Pi's default 50 KB/2,000-line limits, but the file itself has no size cap.
- Jobs, commands, child handles, and paths remain in memory until explicitly deleted. Delete does not unlink the log or temporary directory; finished jobs are not evicted.
- `stop()` sends a tree termination, waits a fixed 100 ms, then force-kills if no exit code has appeared. It does not await the child's `close` event. Shutdown uses the same path.
- Completion sends one `followUp` message with `triggerTurn: true`; the message deliberately omits command output and points to the file/`bash_output`. Deleting from the UI marks the job notified, so the agent is not told that the user stopped it.
- The viewer clears its one-second interval in `dispose()`, and foreground abort listeners and background timers are generally detached/cleared on settlement.

### Claude Code

Official documentation verifies that:

- Background Bash returns a task ID immediately; `Ctrl+B` moves a foreground Bash invocation into the background; output is written to a file; and shell tasks are cleaned up when Claude Code exits. If the *whole session* is backgrounded, its shell tasks are handed to that background session instead ([interactive mode](https://code.claude.com/docs/en/interactive-mode#background-bash-commands)).
- `/tasks` lists and stops background work. It is a unified view that includes shells and subagents, including completed subagents, and it can open immediately while Claude is responding ([tools reference](https://code.claude.com/docs/en/tools-reference#background-commands), [commands reference](https://code.claude.com/docs/en/commands)).
- Bash output is streamed to a working file; output over 5 GB terminates the command. Valid results have a roughly 30,000-character inline ceiling and can expose a session-file path for larger output; failures use a smaller bounded excerpt ([output limits](https://code.claude.com/docs/en/tools-reference#output-limits)).
- Reaching a timeout normally moves a parseable command to the background rather than killing it, with documented exceptions such as `sleep`, commands containing `git`, and unparseable compound commands ([background commands](https://code.claude.com/docs/en/tools-reference#background-commands)).

Local inspection of the installed `C:\Users\rahul\.local\bin\claude.exe` (2.1.259) additionally verifies that `/tasks` is a categorized **Background** dialog spanning shells, agents, monitors, MCP tasks, cloud/local agents, workflows, and completed work. Labels vary by task type: shell command, agent description, or remote-session title. The current public changelog verifies model/effort in subagent rows/details, user-stop notifications to Claude, fixes for large failure notifications, detached descendants surviving stops, and stale background resources ([CHANGELOG.md](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)). These binary-observed UI details are version-specific and are not a public API contract.

Do not conflate Claude's two persistence models: ordinary background **shell tasks** are session-owned and cleaned up on exit, while background **Claude sessions** run under a supervisor and persist conversation state on disk ([agent view](https://code.claude.com/docs/en/agent-view#how-background-sessions-are-hosted)).

### Public Pi implementations

| Implementation | Verified strengths | Relevant trade-offs |
|---|---|---|
| [taglia/dotfiles async-bash](https://github.com/taglia/dotfiles/tree/e4c2934f4f73e108bbf19bb940931169efa5e5c0/files/pi/agent/extensions/async-bash) | Separate `bash_async/status/output/kill` tools; per-task logs and manifest; restart restoration; PID start-time/command identity checks before signaling; event-driven completion; persisted “reported” flag; stall and soft-deadline wakeups with adaptive polling ([registry](https://github.com/taglia/dotfiles/blob/e4c2934f4f73e108bbf19bb940931169efa5e5c0/files/pi/agent/extensions/async-bash/registry.ts), [monitor](https://github.com/taglia/dotfiles/blob/e4c2934f4f73e108bbf19bb940931169efa5e5c0/files/pi/agent/extensions/async-bash/monitor.ts)). | Leaves built-in Bash unchanged and its `/tasks` is only a notification summary, not an interactive viewer. Persistence and monitoring add substantial machinery. |
| [sshkeda/pi-background-bash](https://github.com/sshkeda/pi-background-bash/tree/4948b7db3af931de1307dbcb52c48b48d3485b6c) | Keeps the normal Bash surface; explicit/immediate and timed backgrounding; stable sortable IDs; recorded PID/PGID, events, metadata, and logs; bounded in-context results with `pbb tail --full`; instance/session ownership and stale-owner visibility ([README](https://github.com/sshkeda/pi-background-bash/blob/4948b7db3af931de1307dbcb52c48b48d3485b6c/README.md), [extension](https://github.com/sshkeda/pi-background-bash/blob/4948b7db3af931de1307dbcb52c48b48d3485b6c/extensions/background-bash.ts)). | A separate PBB runner/CLI and `pi-lane` identity model are more infrastructure than `pi-toolkit` needs for a session-owned feature. |
| [PizzaPi background Bash](https://github.com/Pizzaface/PizzaPi/blob/62486cafc463c204c2739d14f2e1b6133a6df61e/packages/cli/src/extensions/background-bash.ts) | Requires a short task `title`; supports immediate, timed, shortcut, command, and web-triggered backgrounding; incremental output offsets; persists worker-local records; retries completion delivery until `message_start` acknowledges it; removes logs and timers on session cleanup. | Recovered jobs lose exit notification capability; records are PID-keyed and explicitly unbounded; Windows killing uses the PID rather than a process-tree primitive. |
| [aliou/pi-processes](https://github.com/aliou/pi-processes/tree/be30202d846bb7778f497fa470cc389d458de50f) | Rich `/ps`: event-driven list/output refresh, stable ID selection, live tail-follow that preserves manual scroll position, preview scrolling, filter/sort/search, pin/dock, kill, clear-finished, separate logs overlay, configurable limits, readiness/error/exit wakeups, and stdin writing ([README](https://github.com/aliou/pi-processes/blob/be30202d846bb7778f497fa470cc389d458de50f/README.md), [overview](https://github.com/aliou/pi-processes/blob/be30202d846bb7778f497fa470cc389d458de50f/extensions/processes/components/overview-component.ts)). | Much broader process-manager scope; README says Windows is unsupported. Its full UI would be excessive for a small task viewer. |
| [bluclawd background Bash](https://github.com/christophesamueldhp/bluclawd/tree/03f1a7056d5ff8b6327273af9aed17ceb1684abb/ext) | Small useful safeguards: 2 MB per-job in-memory output cap, explicit dropped-output notice, incremental reads, and eviction beyond 50 finished jobs ([registry](https://github.com/christophesamueldhp/bluclawd/blob/03f1a7056d5ff8b6327273af9aed17ceb1684abb/ext/_shared/background-bash.ts)). | `/tasks` is a static transcript snapshot rather than a live interactive panel; one shared incremental cursor means one reader consumes output for all readers. |

## Recommendations (design judgment)

### P0 — correctness, security, and bounded resources

1. **Make stop/delete/shutdown await termination.** Keep an exit/close promise per job. Send graceful tree termination, wait a documented grace period, force-kill, then wait for `close` (with a final bounded timeout) before reporting success or dropping the record. Close/error-handle the output stream in every path. The current 100 ms delay can report “stopped” before the process and descendants are demonstrably gone.
2. **Add an explicit retention policy.** Cap retained finished jobs and total log bytes; unlink logs and remove their temporary directories on clear/eviction/shutdown. Provide “clear finished” and optionally age-based cleanup. This addresses the current unbounded map and disk/privacy residue; bluclawd's 50-job cap is a reasonable simple precedent.
3. **Bound writes, not just reads.** Track bytes written and either rotate/truncate with a conspicuous dropped-output marker or terminate at a configurable ceiling. Catch `WriteStream` errors and transition the job to a diagnosable failure instead of risking an unhandled emitter error. Claude's 5 GB limit demonstrates that even file-backed output needs a hard ceiling.
4. **Sanitize every TUI field.** The preview strips VT sequences, but command-derived task names do not. Strip terminal escapes and unsafe control/bidirectional characters from names, errors, and status/detail text before rendering; preserve raw bytes only in the log. Treat logs as sensitive and avoid leaving them indefinitely.
5. **Make completion delivery observable and idempotent.** Give each completion a delivery ID and keep pending delivery state until a lifecycle event confirms the message landed, with a small retry cap. PizzaPi demonstrates the race and an acknowledgment pattern. Also send a bounded status event when the *user* stops a task in `/tasks`; Claude Code's changelog explicitly treats model awareness of user stops as important.

### P1 — task semantics and everyday UI

6. **Separate actions:** `x` = stop a running task and retain its final state/output; `c`/Delete = clear a finished task; `C` = clear all finished. Confirm only destructive clearing or force-stop. Never label “stop and erase” merely as “delete.”
7. **Add an optional short `title`/`description`.** Use it as the primary row label, with a sanitized/truncated command fallback. Put the full command, cwd, PID, start/end time, exit code, timeout, and log/truncation state in selected-task detail. This improves scanning and avoids putting token-bearing command text front-and-center; PizzaPi's required title is the strongest precedent.
8. **Use event-driven, throttled refresh.** Emit job-state and output-appended events. Re-render immediately on state/selection changes and throttle output paints (for example 50–100 ms). Remove the unconditional one-second file reread; retain a low-frequency clock only while running jobs need elapsed-time updates. Dispose every subscription/timer explicitly, as `pi-processes` does.
9. **Turn the preview into a small log viewer.** Start at the newest page, follow while at tail, preserve position after the user scrolls up, expose dropped/truncated counts, and support `J/K`, `g/G`, plus an “open/full output” action. Five unscrollable lines are insufficient for build/test diagnosis.
10. **Size to terminal height and select by ID.** Compute list/preview rows from `tui.terminal.rows`, degrade cleanly on small terminals, and preserve selection by task ID across refresh/deletion rather than by array index.
11. **Make model-facing reads incremental without harming UI.** Add `offset`/cursor metadata or `tail_lines`; default repeated agent reads to new output and keep the UI's tail reader independent. Do not use one global destructive cursor, because UI and agent reads would consume each other's data.

### P2 — only if task counts justify it

12. Add running/finished filters, status/start/name sorting, and name search; then consider pin/dock support. These are proven in `pi-processes`, but they are lower value than safe lifecycle and readable output.
13. Decide and document persistence rather than inheriting it accidentally. Claude parity supports the current session-owned/kill-on-exit policy. If restart survival is desired, persist metadata and read offsets atomically, verify process identity (PID plus start time/command or stronger) before signaling, mark unknown exits honestly, and never “restore” ownership from PID alone. Taglia's registry is the safer reference.

## Suggested minimal sequence

1. Exit promise + graceful/force/wait shutdown; stream error handling.
2. Finished-job/log caps and clear-finished cleanup.
3. Delivery acknowledgment/retry and user-stop notification.
4. Separate stop/clear controls, title field, selected detail.
5. Event-driven scrollable preview with independent output offsets.
6. Persistence or advanced filters only after usage shows they are needed.
