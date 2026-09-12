# Upstream v0.19 port record

## Update baseline

- Repository: <https://github.com/tintinweb/pi-subagents>
- Previous represented-through commit: `92422a4bf3c3813e01e24c73fa14234dc4ce3b28`.
- New represented-through commit: `e955e29c51b7a6cce37e1108cd2d6c57a77e151c`.
- Release: `v0.19.0`, resolving to `4f572eaa04c09d3dbc16e4a5f13a16b295e84e14`.
- Range: 20 upstream commits, 119 changed upstream files.
- Machine-readable record: [UPSTREAM.json](UPSTREAM.json).

The full SHA previously written as `e955e29fb98aacb17f7c993f2458039bbac93bb7` was incorrect. The value above was verified against upstream Git objects and `git ls-remote`.

This is a **selective source port**, not a Git merge of the independent upstream repository. Toolkit's package version remains `0.1.0`; it is not the upstream version or the next comparison baseline. The historical `pi-unified-subagents` consolidation snapshot remains part of the provenance, not the current upstream checkpoint.

## Port map

Paths below are relative to `pi-toolkit-lib/unified-subagents/` unless stated otherwise.

| Upstream change | Toolkit integration |
|---|---|
| `917853c`: Markdown viewer, 16K output, BOM frontmatter | Adapted `ui/conversation-viewer.ts`, `custom-agents.ts`, `agent-file-toggle.ts`; retains local result pairing, navigation and caches |
| `723349f`: performance suite | `test/unified-subagents/perf/`, shared fixtures, `bench` and `bench:ab` scripts; local import paths and Windows process/junction support |
| `e56085d`: foreground concurrency | Separate opt-in manager pool and settings; retains live foreground-to-background transfer |
| `084d177`: RPC model scope | Existing `resolveHarnessInvocation()` remains authoritative; regression coverage rather than a competing Pi-only resolver |
| `221df02`: Workflow | `workflow/**`, `structured-output.ts`, workflow cards/dialog/menu, private registrar, Pi runner/backend fields, worktree/startup lifecycle, prompt and transcript helpers |
| `3d91023`: bounded rendering | Applied together with Markdown, not left as a later optional optimization |
| `4f572ea`: release lint fix | Included in the imported v0.19 source |
| `e955e29`: lowercase tool collision | Auto mode also stands down for foreign lowercase `workflow` |
| Release/documentation commits | Updated local guides/changelog, workflow examples, Pi peer floor, provenance and this ledger |

Source mapping:

- Upstream `src/**` → Toolkit `pi-toolkit-lib/unified-subagents/**`.
- Upstream `test/**` → Toolkit `test/unified-subagents/**`, adapted rather than replacing local suites.
- Upstream workflow examples → `examples/workflows/**`.
- Upstream workflow/RPC guides → `docs/unified-subagents/docs/**`, corrected for Toolkit behavior.

## Local behavior retained

- Sole public extension entrypoint `index.ts`; unified subagents remains a private registrar.
- Pi, Claude Code, Codex ACP, and Agy backend adapters and native model/trust/capability checks.
- Authoritative agent-file harness/model precedence and Pi model scope.
- Existing foreground-first execution, five-minute automatic detachment, manual `Ctrl+B`, background queueing and result delivery.
- Nested delegation, schedules, resume, custom cwd/worktree subdirectory mapping, transcripts, steering and cancellation.
- Shared Tasks/Agents Activity surface, suppressed legacy above-editor widget, paired tool results and return navigation.
- Existing usage accounting and Economy isolated bulk reader, bounded results, one-shot exact-read permits and local savings reporting.

Workflow children use the same harness resolver. Plain calls can use native harnesses selected by agent definitions or `agent(..., { harness })`, with definition pins taking precedence; schema output and child resume require Pi. Unsupported capabilities fail explicitly rather than silently changing harness. Owned children are hidden from top-level handles, RPC/lifecycle/UI surfaces and concurrency pools; the workflow controls and reports them.

## Deliberately not copied wholesale

- Upstream package identity, standalone entrypoint, branding and independent Git history.
- Upstream `AGENTS.md`, CI configuration, and publishing-only `.npmignore` changes. Toolkit is a private local package with its own commands and architecture.
- Upstream legacy widget behavior that would undo Toolkit's shared Activity design.
- Upstream Pi-only spawn resolution that would bypass Toolkit's native adapters or frontmatter policy.
- Historical documentation source line numbers or upstream-only behavioral claims where Toolkit differs.

These exclusions concern packaging, integration and local equivalents, not omission of the requested Workflow feature set.

## Verification

Final verification on Windows, with source frozen during the last regression run:

| Gate | Result |
|---|---|
| `npm run typecheck` and `npm run build` | Passed |
| `PI_E2E_LIVE=0 npm test -- --reporter=verbose` | Passed: grouped-tool renderer plus 126 Vitest files, 2,404 tests passed, 21 skipped; no failures or unhandled errors |
| Changed-file Biome check | Passed: 107 files checked, no fixes applied; protected pre-existing Economy edits excluded |
| Full repository lint | Two pre-existing errors remain in `pi-toolkit-lib/usage-history.ts:130` (`noImplicitAnyLet`) and `test/usage-history.test.ts:25` (`useIterableCallbackReturn`), alongside existing warnings/configuration notices; neither error-bearing file changed in this port |
| Whitespace and documentation | `git diff --check` passed; 43 local documentation links verified |
| Benchmarks | All 38 cases in four files passed; two-round viewer A/B completed |
| `npm pack --dry-run --json` | 281 files inspected, including the worker source, structured-output code, provenance and all six Workflow example assets; no publish/install |

The full offline run includes faux-model Workflow and nested print-mode E2E tests, native-harness dispatch/capability checks, foreground/background queues and detachment, worktree precedence, once-only usage accounting, and Workflow session-reset checks. Live-provider tests were not enabled. Performance timings are observations, not machine-independent pass/fail thresholds.

Shutdown regressions cover awaited, bounded Git pruning (preventing Windows temporary-directory locks) and disposal of both concurrency pools: a late completion from the old session cannot release a replacement session's slot. Workflow continuations are fenced across session replacement and worker/child-session settlement is bounded.

The earlier apparent Vitest startup hang reproduced as slow cold Pi dependency transformation: a normal baseline run spent about 42 seconds importing and under a second testing. A pure worker probe passed in 250 ms, and externalized warm Pi imports were much faster. The production test configuration and per-test timeouts were not relaxed to conceal failures.

Pre-existing uncommitted Economy source/tests/docs and the research report were copied into the integration worktree for combined verification, but are excluded from the upstream integration commit. Their original bytes must remain unchanged in the main checkout.

### Benchmark observations

The four-file suite executed all 38 benchmarks. The viewer A/B harness completed two alternating rounds against Toolkit `e9954e1292821cc6487e2a28df4617777138063e`, using identical benchmark sources in both trees. Fastest-round medians (this machine only):

| Viewer path | Baseline | Port |
|---|---:|---:|
| Warm default, 50 messages | 825.70 µs | 296.00 µs |
| Warm default, 5,000 messages | 859.30 µs | 271.95 µs |
| Cold open + first frame, 50 messages | 9.092 ms | 3.651 ms |
| Cold open + first frame, 500 messages | 78.887 ms | 36.034 ms |

The older tree has no Markdown setting; its default/off labels both exercise its existing renderer. These are end-to-end synthetic fixture observations, not an isolated measurement of Markdown overhead or a machine-independent speed guarantee. Cold samples construct fresh viewers over prebuilt transcripts; a wrapping viewer pool would contaminate cold samples with cached frames. Activity fixtures open the actual agent rows rather than benchmarking a collapsed tab strip. None of these timings measures Economy effectiveness or net token savings.

## Next upstream check

Read `UPSTREAM.json.importedThrough`; compare that exact commit to the verified upstream branch head. For example, in a separate upstream clone:

```bash
git fetch origin master
git log --oneline e955e29c51b7a6cce37e1108cd2d6c57a77e151c..origin/master
git diff --stat e955e29c51b7a6cce37e1108cd2d6c57a77e151c..origin/master
```

If upstream rewrites history and the checkpoint is not an ancestor, stop treating a range count as an update list and compare trees/history explicitly. Verify full SHAs from Git before writing reports. Review new changes against both upstream's previous tree and Toolkit's current code; never replace the customized source directory wholesale. Update `UPSTREAM.json`, `PROVENANCE.md`, and this port history with the next verified integration.
