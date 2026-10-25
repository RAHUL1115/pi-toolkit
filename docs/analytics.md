# Local analytics and evidence-backed improvements

Pi Toolkit can collect **local, privacy-minimized tool/skill observations**, import existing Pi JSONL history, and generate review-only improvement proposals. This is observability, not model training, automatic skill rewriting, or a Harness² integration.

## Quick start

In Pi after installing/reloading Toolkit:

```text
/ptk-analytics enable
/ptk-analytics import
/ptk-analytics report
/ptk-analytics status
/ptk-analytics disable
```

Collection defaults **off** for a fresh installation. `enable` starts it in the current session and saves consent for future/reloaded Toolkit sessions. Other already-running processes need `/reload` to pick up a changed setting. `PI_TOOLKIT_ANALYTICS=0` is an unconditional per-process off switch. No collection starts merely by importing the extension module.

`import` reads original ledgers under Pi's configured agent directory (`~/.pi/agent/sessions` by default); it never opens/migrates sessions with SessionManager or changes their contents. It works independently of live collection consent, because it is an explicit command. Custom session directories must be imported explicitly through the CLI. No automatic startup scan or model request is performed.

`report` saves `latest-report.md` and `latest-report.json` under `~/.pi/agent/analytics` (or the configured Pi agent directory). The command prints the report location and basic counts; the CLI can print the full report. The Markdown and JSON reports contain the same metrics and evidence references.

### CLI

From the Toolkit checkout:

```bash
npm run build
npm run analytics -- status
npm run analytics -- enable
npm run analytics -- import
npm run analytics -- report
npm run analytics -- report --days 7 --json
npm run analytics -- import --sessions /explicit/custom/session-directory
npm run analytics -- import --max-files 50000 --max-bytes 2147483648 --timeout-ms 120000
npm run analytics -- report --out /explicit/path/analytics.md
npm run analytics -- evidence FULL_EVENT_HASH
```

`--store PATH` selects a separate analytics store; it does not change the live extension's default store. CLI import exits `2` when coverage is partial, `1` on an operational/argument error, and `0` on a complete scan. Partial imports retain the observations successfully read; re-importing fills gaps without duplicating known event IDs. Reports include import coverage records rather than presenting a bounded scan as a complete history.

`evidence FULL_EVENT_HASH` performs a separate bounded, read-only history lookup and prints the original ledger filename and line number for manual review. It does not print the source content or store its path in analytics. It may not find live-only/unfinished observations or sources outside the selected `--sessions` root; use the import budget flags if coverage is partial.

`--project HASH` filters a report by the exact opaque project identifier in stored events; `--days N` is a rolling window. No task success rate is computed: tool results are not task acceptance tests.

## Stored information and privacy

Version 1 uses small **append-only JSONL segments**, not SQLite: no native database dependency or database work in a tool hook. Segments rotate at 16 MiB, and each writer has a separate file, so simultaneous Pi processes do not interleave records. Reports deduplicate deterministic event IDs across live collection, repeated imports, and native fork/clone copies.

Stored observations include:

- Tool name, timestamp, status, recorded duration and timing kind when available, provider/model identifiers when attributable, and a Toolkit harness-version marker for live observations. Historical nested elapsed durations include hooks/queueing and are kept separate from execution-time averages.
- Digests of session/project identifiers, original tool arguments, call IDs and historical entry IDs. These are **pseudonymous**, not anonymous; digests of predictable inputs can be guessed.
- A fixed rule-based failure category, confidence and classifier-rule label. The original error is inspected transiently but **not copied into analytics**.
- Structured command exit codes when the tool supplies them; these are separate from tool transport errors.
- Skill names, observed loading/invocation state, and an instruction digest only where the actual expanded instructions were observed. Current filesystem content is never used to invent historical skill versions. A successful `SKILL.md` read is loading evidence, not proof the entire file was read or its instructions followed.

**Not stored:** raw prompts, command/script arguments, file paths or contents, tool outputs, original error text, credentials, reasoning/thinking, images, or full transcripts. Arguments are digested, not copied. Analytics makes no network/model requests. Source session ledgers may already contain all of that sensitive material; this extension does not redact or delete them.

The store directory is private (`0700`), records/metadata are `0600`, and symlink stores/files/ancestors are refused. Use real paths rather than symlink aliases for custom roots. Non-regular files (including FIFOs) are rejected without blocking. These are local hygiene protections, **not an operating-system sandbox or protection from other code running as your user**. Reports and event records whitelist schema fields rather than exporting arbitrary tool details. The historical importer refuses symlink paths and unsupported ledger versions.

Disable collection before deleting its store. Removing `analytics` deletes analytics and its opt-in setting, not original sessions; do not delete the sessions directory. Other live collectors may recreate files until stopped/reloaded. There is no automatic retention deletion in this initial version.

## Failure and recovery semantics

Categories cover argument validation, missing paths, edit mismatches, authentication, permission, rate limits, network, timeouts, missing dependencies, cancellation, runtime exceptions and unknown failures. Rules are intentionally conservative hypotheses, not causal diagnosis. One tool error may contain multiple symptoms; the first matching rule wins.

A successful tool containing the word “error” is not a failure. A nonzero command exit is reported separately: grep no-match and intentionally red tests can be expected. Permission denials and cancellation are not automatically agent mistakes. An operational failure does not imply the user's task failed, and a successful tool does not imply it passed.

An **exact repeat** means the same tool/input digest within the same recorded session/parent context and 15 minutes. An error followed by the same-input successful call is labeled a **later-success signal**, not verified recovery: branch switches, task changes and external fixes may intervene. Changed-argument/alternative-tool recovery is not inferred in version 1.

Parent and nested attempts are shown separately; they are not independent incidents. Native nested-call metadata is bounded and may omit arguments/results. These events are marked limited. Pi tools using `ctx.executeTool()` are observable live; arbitrary child processes and external Claude/Codex harness internals are not automatically instrumented. Pi SDK subagents that do not load Toolkit are likewise not live-collected; saved child ledgers can be explicitly imported if available. No new cross-process parent/task correlation is claimed.

## Skills: observation is not effectiveness

- Successful reads of `SKILL.md` count as loading observations.
- Actual expanded native `/skill:name` or Toolkit dollar-skill instruction blocks count as loads.
- Explicit raw `/skill:name` and historical dollar activation-state additions count as invocations. Native expansion can replace the slash text before persistence, so invocation evidence is not always retained.
- The advertised available-skill list and prose merely naming a skill do not count as loads.

Repeated actual expansions can produce multiple observations. Counts are not unique users/tasks, skill adherence scores, or causal effectiveness rankings. Historical hashes are normally unavailable. Full historical snapshots of tool definitions/extensions are not reconstructed; the recorded model information is kept when paired with an actual assistant tool call.

## Coverage and reliability

Historical import defaults: 10,000 files, 512 MiB total input, 64 MiB per file, 1 MiB per line, 30 seconds, directory depth 3, 250,000 distinct events, and bounded outstanding call inputs. Unsupported files/versions, malformed/truncated lines, cancellation, limits and missing roots are explicitly marked partial. Oversized lines are discarded in bounded chunks, never buffered without limit. Original records remain readable even when a compaction summary exists; summaries are not treated as reconstructed tool history.

Report reads are capped at 20,000 store files, 256 MiB total, 32 MiB per segment, and 500,000 unique observations. Hitting a cap is explicit. Re-import deduplication uses the readable store snapshot; if that snapshot is partial, the import is also labeled partial. Large installations may eventually justify an indexed database instead of increasing memory caps.

Live hooks queue at most 2,048 records, defer disk IO, and never return a gating/transformation result. Up to 4,096 already-normalized nested observations wait for their root result: IDs use the child call ID plus the root's durable timestamp, so flattened historical grandchildren deduplicate correctly without conflating reused IDs in other sessions. Immediate parent links are reconstructed from Pi's `<parent>/<n>` ID contract where available; otherwise historical linkage falls back to the root. Storage failures/drop counters are retained in health metadata when possible, and shown in status/coverage. Bounded pending-call state can lose argument attribution; final observations still record limited metadata. Graceful shutdown flushes records and marks outstanding calls unfinished; a hard process kill can lose pending/in-flight work. This is not an audit-grade exactly-once delivery guarantee.

No token or cost totals are added here. `/ptk-usage` remains the accounting surface and already documents the uncertainty around independently saved child ledgers and parent aggregate usage.

## Improvement workflow and Harness²

A supported category needs at least three observed tool errors before a deterministic proposal is produced. Each proposal includes evidence event IDs, a narrow hypothesis and an explicit validation plan. Cancellation, permission/authentication denials, unknown exceptions and nonzero command exits do not trigger blanket automatic fixes.

Proposals are **not applied**. They never create skills/memories, edit instructions, relax guardrails, install packages, or run the original commands again. Logs/tool outputs are untrusted evidence, not instructions.

To promote a proposal manually:

1. Review the original evidence and choose one narrow change.
2. Reproduce it in a disposable workspace with minimal credentials and restricted network.
3. Compare a fixed-model baseline against the candidate over repeated trials and held-out tasks.
4. Use executable task acceptance tests. Check correctness, safety, cost and latency—not just fewer errors.
5. Retain the baseline on a tie or uncertainty; approve/version a winning change and keep rollback.

[Harness²](https://github.com/google-research/harness2) supplies a related propose–probe–compose optimization method, but ships no Pi adapter or analytics importer. A full adapter and independent evaluation are separate future work. Its default executor/selection behavior should not be copied into the live personal environment. This implementation borrows the evidence-backed review loop, not the research executors, and makes no transferred performance claim.

## Verification

```bash
npm exec -- vitest run test/analytics-normalize.test.ts test/analytics-history.test.ts test/analytics.test.ts
node test/analytics-integration.mjs
npm run typecheck
npm run lint
npm run build
npm test
```

Tests use synthetic temporary ledgers and stores. They cover privacy/schema boundaries, failure classification, source immutability, timing/nested metadata, clone/import deduplication, skills, bounds, cancellation, concurrent writers, permissions, command wiring, and conservative proposal semantics. No external model calls are needed.
