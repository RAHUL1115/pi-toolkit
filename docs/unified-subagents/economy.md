# Economy mode

Economy is on by default. `/economy off` leaves Pi's native read results unchanged; `/economy on` applies a **16 KiB content cap**. Switching sessions restores the enabled default. `/economy stats` reports the toggle state, reads shortened, bytes withheld, approximate input tokens avoided, and bulk-reader usage. There are no one-read permits; use `/economy off` and turn it back on when finished.

## Minimal read adapter

Pi's native reader remains responsible for reading files, images, range handling, errors, huge files and long-line behavior. Toolkit does not scan files, change read arguments, replace the native reader, rewrite codemode scripts, or launch agents automatically.

The installed SDK has no configurable native byte-limit option. Toolkit therefore uses a small `tool_result` adapter and Pi's own `truncateHead` helper to apply the smaller cap to returned text. Source content—not native continuation notices—is capped at 16 KiB. The existing 2000-line ceiling remains unchanged. Native-style continuation notices can add a small amount of overhead, just as they do with Pi's normal 50 KiB cap. Changed text and structured output are kept consistent for codemode.

No partial-line slicing, custom skipping rules, or separate large-file policies are added. Native first-line warnings and truncation behavior are retained; the adapter's matching notices reflect the lower threshold. Image attachments and native errors are unchanged. The adapter limits parent context output, not native file I/O or memory use.

The normal notices, such as `[Showing lines ...]`, are tool metadata, not file contents. They must not be copied into patches or treated as source. This is also explained in the system guidance, but instructions cannot guarantee an LLM will never confuse metadata and source.

## System guidance

Toolkit appends the same conditional reading guidance to the parent system prompt in both modes, without discarding existing instructions:

- Use `grep` and small `offset`/`limit` ranges for a known file and a narrow question.
- For investigation across large or multiple files, use `Agent` with `subagent_type: "bulk-reader"`, explicit paths and a precise question. Request relevant file:line ranges, relationships, short quotes and unread areas.
- Read referenced chunks directly when exact text is needed for editing or verification. Avoid duplicating delegated research or blindly paging through entire files.
- Reader findings are analysis, not an exact full read. If a task or skill requires a whole exact document, continue the required ranges or request `/economy off`; native limits still apply.

The guidance is byte-for-byte identical across on/off toggles; only the read-result cap changes. It describes both modes and tells the model to follow each result's actual limit/notice. This avoids toggle-driven system-prompt cache churn and mid-run guidance/cap mismatch. Other prompt changes and conversation growth can still affect provider caching. Guidance is not installed in reader child sessions.

## Bulk-reader is always available

The reserved `bulk-reader` profile is registered **regardless of Economy's on/off state**. It uses the configured light model with low thinking, a fresh context, read/grep/find/ls only, no extensions, skills, or nested agents. Missing light models fail rather than silently using the parent model. Custom agent files cannot override its read-only policy.

Findings are analysis, not exact source text. Parent-facing results, including verbose retrieval and failure text, retain the independent 8 KiB reader-result cap in both modes. Overflow is written to a local temporary artifact; the complete conversation remains in the agent UI and persisted session. Temporary artifacts are not automatically deleted by this extension.

## Read statistics

Counters accumulate since extension load, across on/off toggles and session switches; `/reload` resets them. Only reads actually shortened while Economy is on count. Bytes withheld compare the original native response with the returned response, including notice overhead. Estimated input tokens avoided use aggregate UTF-8 bytes divided by four; this is a per-read estimate, **not net savings or billing savings**. Later continuation reads can ingest the same withheld text, model tokenization varies, and provider cache pricing is not measured. Bulk-reader usage is reported separately rather than silently deducted from this estimate. Counters are shown in local UI notifications, not inserted into the system prompt.

## Separate upstream serialization issue

Nested rejected Errors can still appear as `reason: {}` in codemode output. This is tracked at [earendil-works/pi#10650](https://github.com/earendil-works/pi/issues/10650); Toolkit does not rewrite JavaScript or patch frozen globals to work around it. Until upstream addresses it, explicitly include `reason.message` when displaying rejected `Promise.allSettled` results.

Run `/reload` to activate local changes. This is a context-budget convenience, not a filesystem security sandbox: other tools and extensions can read files.
