# Background-task UI and runtime comparison

Research snapshot: Claude Code 2.1.259 and the public repositories/commits linked below. “Verified” means documented by a primary source or observed directly in the cited source; recommendations are explicitly separated and are design judgments.

## Executive summary

`pi-toolkit` now covers the strongest session-owned baseline: explicit and automatic backgrounding, `Ctrl+B`, optional human titles, bounded file-backed output, confirmed process-tree termination, separate stop/clear actions, retained-job cleanup, event-driven refresh, a scrollable/following `/tasks` preview, and a shared below-editor Tasks/Agents activity navigator. The main remaining correctness gap is one-shot completion delivery. The remaining UI gaps are selected-task metadata, terminal-height sizing, incremental model reads, and higher-volume filtering/search.

## Verified facts

### Current `pi-toolkit`

Sources: [`background-bash.ts`](../pi-toolkit-lib/background-bash.ts) and [`background-task-viewer.ts`](../pi-toolkit-lib/background-task-viewer.ts), corroborated by [`background-bash.test.ts`](../test/background-bash.test.ts).

- Tasks accept an optional sanitized 80-character `title`; the normalized command is the fallback. IDs remain process-local `bash-N` values.
- The below-editor activity surface shows filled tabs only for running Tasks and running/queued top-level Agents. It stays collapsed to muted counters until Down focuses the tabs and a second Down expands the selected rows, even with one category. Left/Right switches categories from tabs or rows; Enter opens `/tasks` focused on that task or the selected agent conversation.
- `/tasks` selects by stable task ID with Up/Down. Its five-line output window uses `J`/`K` for lines, Shift+Up/Down for pages, and Alt+Up/Down for top/tail; Page Up/Page Down and `g`/`G` remain aliases.
- `x x` stops and retains a running task. `c c` or Delete twice clears one finished task; `C C` clears all finished tasks. Duplicate asynchronous actions are suppressed.
- Output is combined stdout/stderr in a per-job temporary `output.log`, capped at 2 MiB by default with a visible limit marker. Dropped bytes are counted while the process continues, and a separate bounded memory tail keeps model-facing reads current within Pi's 50 KB/2,000-line limits.
- At most 50 finished jobs are retained by default. Clear, eviction, foreground settlement, and shutdown remove the corresponding temporary directories.
- Stop, timeout, and shutdown share one idempotent termination path. POSIX uses graceful process-tree termination before a forced fallback; Windows force-terminates the tree. Both confirm process exit, drain inherited output pipes through an idle grace, and flush the log stream.
- Manager list/output events drive viewer refresh; output paints are throttled to 100 ms. The one-second clock updates elapsed time only while a task is running, and all timers/subscriptions are disposed.
- Completion still sends one unacknowledged `followUp` message with `triggerTurn: true`; this remains the primary reliability gap.

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

### P0 — remaining correctness

1. **Make completion delivery observable and idempotent.** Give each completion a delivery ID and keep pending delivery state until a lifecycle event confirms the message landed, with a small retry cap. PizzaPi demonstrates the race and an acknowledgment pattern. Also send a bounded status event when the *user* stops a task in `/tasks`; Claude Code's changelog explicitly treats model awareness of user stops as important.

### P1 — remaining everyday UI

2. **Add selected-task details.** Show the full command, cwd, PID, start/end time, exit code, timeout, and log/drop state without crowding the list row.
3. **Size to terminal height.** Compute list/preview rows from `tui.terminal.rows` and degrade cleanly on small terminals instead of using a fixed eight-task viewport.
4. **Make model-facing reads incremental without harming UI.** Add `offset`/cursor metadata or `tail_lines`; default repeated agent reads to new output and keep the UI's reader independent. Do not use one global destructive cursor, because UI and agent reads would consume each other's data.
5. **Offer an open/full-output action.** The preview now scrolls within the bounded model-facing tail; a separate full retained-log view would improve long build/test diagnosis.

### P2 — only if task counts justify it

6. Add running/finished filters, status/start/name sorting, and name search; then consider pin/dock support. These are proven in `pi-processes`, but they are lower value than safe lifecycle and readable output.
7. Decide and document persistence rather than inheriting it accidentally. Claude parity supports the current session-owned/kill-on-exit policy. If restart survival is desired, persist metadata and read offsets atomically, verify process identity (PID plus start time/command or stronger) before signaling, mark unknown exits honestly, and never “restore” ownership from PID alone. Taglia's registry is the safer reference.

## Suggested remaining sequence

1. Delivery acknowledgment/retry and user-stop notification.
2. Selected-task detail and terminal-height sizing.
3. Independent incremental model/UI output reads and a full-log view.
4. Persistence or advanced filters only after usage shows they are needed.
