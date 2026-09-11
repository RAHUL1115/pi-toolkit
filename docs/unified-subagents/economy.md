# Economy mode

`/economy on` opts into a parent-only `read` guard. It starts off and resets off when switching sessions. Reads requesting more than 16 KiB are blocked, not summarized. Small `offset` + `limit` ranges are permitted even in large files; offset alone means the remaining file. Native read errors remain native. Supported image signatures are exempt; this budgets text rather than image attachments.

After a block, either read a precise smaller range or call `Agent` with `subagent_type: "bulk-reader"`, explicit paths, and a precise question. The reserved built-in uses the configured light model with low thinking, a fresh context, read/grep/find/ls only, no extensions, skills, or nested agents. Missing light models fail rather than silently using the parent model. It is available even when other defaults are disabled; custom agent files cannot override it.

Findings are analysis, not exact source text. Parent-facing foreground and fetched results (including verbose retrieval and failure text) are limited to 8 KiB; overflow is written to a temporary local artifact. The complete conversation remains available in the agent UI and persisted session. Artifacts use the OS temporary directory and are not automatically deleted by this extension.

For exact reads, the user can grant `/economy allow <path>` for one next read of that canonical path, or `/economy off`. Off clears pending permits. Paths with spaces may be quoted. These are user commands, not agent-callable approval tools.

`/economy stats` reports guard counts and actual reported bulk-reader usage since extension activation, including failed runs. Counts are attempts, not estimated token savings. Existing subagent usage reporting remains unchanged.

This is an economy guard, not a filesystem security sandbox: other parent tools, file attachments, and extensions can read files. It does not route shell commands or implement a code-writing worker. No external application dependency is required.
