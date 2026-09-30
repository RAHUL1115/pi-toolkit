# Retained third-party extension update check

> **Historical report, not the current integration baseline.** The findings below describe the assessment target/date recorded here. Toolkit has since integrated Workflow, Markdown previews, BOM handling, and foreground concurrency through a selective v0.19 port. For current ownership and migration, read [the integration map](../integration.md); for upstream comparisons, use [UPSTREAM.json](../unified-subagents/UPSTREAM.json) and [the port record](../unified-subagents/upstream-v0.19-port.md). The port record also corrects the malformed full `e955e29…` SHA recorded in this report. No fresh upstream check is implied by this documentation update.

**Checked:** 2026-09-12T06:33:03Z  
**Assessment target:** Pi Toolkit [`e9954e1292821cc6487e2a28df4617777138063e`](https://github.com/RAHUL1115/pi-toolkit/tree/e9954e1292821cc6487e2a28df4617777138063e)  
**Scope:** retained Ask User Question and unified-subagents code only. Observability is excluded.

## Executive result

| Retained code | Current upstream default-branch head | Retained/represented point | Status |
|---|---|---|---|
| `ghoseb/pi-askuserquestion` | `main` = [`e58609c9e9c8e8a0348c96eaad38dd7e6f0578`](https://github.com/ghoseb/pi-askuserquestion/commit/e58609c9e9c8e8a0348c96eaad38dd7e6f0578) ([API](https://api.github.com/repos/ghoseb/pi-askuserquestion/commits/main)) | Same commit | Current; zero upstream changes |
| `RAHUL1115/pi-unified-subagents` | `main` = [`a4c1005f4733169cd529402597e685bccfc35080`](https://github.com/RAHUL1115/pi-unified-subagents/commit/a4c1005f4733169cd529402597e685bccfc35080) ([API](https://api.github.com/repos/RAHUL1115/pi-unified-subagents/commits/main)) | `4b581fa99dc13f1a4295f2935cdf0205a0ab9443` | One commit behind, but the commit only retires the standalone package |
| `tintinweb/pi-subagents` lineage | `master` = [`e955e29fb98aacb17f7c993f2458039bbac93bb7`](https://github.com/tintinweb/pi-subagents/commit/e955e29fb98aacb17f7c993f2458039bbac93bb7) ([API](https://api.github.com/repos/tintinweb/pi-subagents/commits/master)) | Exact history represented through `92422a4bf3c3813e01e24c73fa14234dc4ce3b28` | 20 upstream commits after the represented point; selective review warranted, not a bulk sync |

The Ask User Question hash supplied for this check, `e58609c9e9c4e8a0348c96eaad38dd7e6f0578`, [does not resolve](https://api.github.com/repos/ghoseb/pi-askuserquestion/commits/e58609c9e9c4e8a0348c96eaad38dd7e6f0578). The valid hash recorded in [`PROVENANCE.md`](../../PROVENANCE.md) differs at that nibble: `...e9c8...`.

## 1. Ask User Question

The valid retained commit is still the exact `main` tip. The repository exposes no releases, and the [baseline-to-main comparison](https://api.github.com/repos/ghoseb/pi-askuserquestion/compare/e58609c9e9c8e8a0348c96eaad38dd7e6f0578...main) has no newer commits.

**Recommended action:** no action. Keep the existing retained snapshot and provenance unchanged, apart from correcting the malformed hash wherever it appears outside `PROVENANCE.md`.

## 2. `RAHUL1115/pi-unified-subagents`

The [baseline-to-main comparison](https://api.github.com/repos/RAHUL1115/pi-unified-subagents/compare/4b581fa99dc13f1a4295f2935cdf0205a0ab9443...main) contains exactly one commit, [`a4c1005`](https://api.github.com/repos/RAHUL1115/pi-unified-subagents/commits/a4c1005f4733169cd529402597e685bccfc35080). It deliberately disables the old entrypoint, adds `src/deprecated.ts`, and emits a migration warning directing users to Pi Toolkit. It contains no retained runtime improvement.

**Recommended action:** do not port the retirement shim into its migration target. Treat the standalone repository as retired and continue tracking substantive lineage at `tintinweb/pi-subagents`.

## 3. Exact `tintinweb/pi-subagents` content represented by `4b581fa`

This determination does not rely on similarly named commits across diverged repositories. The [`4b581fa` commit object](https://api.github.com/repos/RAHUL1115/pi-unified-subagents/commits/4b581fa99dc13f1a4295f2935cdf0205a0ab9443) has `92422a4bf3c3813e01e24c73fa14234dc4ce3b28` as its second parent—the exact tintinweb commit object. Therefore it represents tintinweb history through `92422a4`.

The [`v0.18.0` (`3f9d35c`) to `92422a4` comparison](https://api.github.com/repos/tintinweb/pi-subagents/compare/3f9d35cd078d18a141eb5a6d8f4fc5010d756280...92422a4bf3c3813e01e24c73fa14234dc4ce3b28) contains exactly these four post-release commits, all already represented:

- [`c73e968`](https://github.com/tintinweb/pi-subagents/commit/c73e968e47056187e90851f02518cb8c14f47090): close the conversation viewer on Ctrl+C.
- [`7e695f3`](https://github.com/tintinweb/pi-subagents/commit/7e695f3e2c523874b4246c64140b12f5912f6b3b): changelog only.
- [`a9db27b`](https://github.com/tintinweb/pi-subagents/commit/a9db27b8f114ea1029cbe5f547b386813e8d6228): cross-extension `subagents:rpc:consume`.
- [`92422a4`](https://github.com/tintinweb/pi-subagents/commit/92422a4bf3c3813e01e24c73fa14234dc4ce3b28): display the model and thinking level actually used.

## 4. Material changes after `92422a4`

The [full `92422a4...master` comparison](https://api.github.com/repos/tintinweb/pi-subagents/compare/92422a4bf3c3813e01e24c73fa14234dc4ce3b28...master) reports 20 commits. The latest release is [`v0.19.0`](https://github.com/tintinweb/pi-subagents/releases/tag/v0.19.0), tagged at `4f572eaa04c09d3dbc16e4a5f13a16b295e84e14`; `master` has three subsequent commits.

Material runtime changes are:

1. **Viewer Markdown, larger tool results, and BOM-safe frontmatter** — [`917853c`](https://github.com/tintinweb/pi-subagents/commit/917853c2f702d45007c93a53d0a696d280297924) adds Markdown rendering, raises expanded result display from 500 to 16,000 characters, and strips a UTF-8 BOM before parsing agent frontmatter.
2. **Independent foreground concurrency** — [`e56085d`](https://github.com/tintinweb/pi-subagents/commit/e56085dbb4baa23fa9338417030be3840014552b) adds `maxConcurrentForeground` and a separate foreground queue/pool.
3. **RPC model-scope enforcement** — [`084d177`](https://github.com/tintinweb/pi-subagents/commit/084d177cfa71a9ce75da5dc69c505b4adbef32b4) closes the `scopeModels` bypass in RPC/programmatic spawns.
4. **Deterministic Workflow subsystem** — [`221df02`](https://github.com/tintinweb/pi-subagents/commit/221df02323c6b6350ea8474579e0ee0f6cc84cea) adds the Workflow tool, run/checkpoint/resume/recovery machinery, structured output, and extensive tests. Its [manifest](https://raw.githubusercontent.com/tintinweb/pi-subagents/221df02323c6b6350ea8474579e0ee0f6cc84cea/package.json) raises the Pi peer floor to `>=0.84.0` and adds `typebox`.
5. **Viewer and workflow follow-ups** — [`3d91023`](https://github.com/tintinweb/pi-subagents/commit/3d91023268a5897b5b92f08aeabd4630666deb47) bounds conversation-viewer render cost and improves truncation notices; [`e955e29`](https://github.com/tintinweb/pi-subagents/commit/e955e29fb98aacb17f7c993f2458039bbac93bb7) recognizes lowercase `workflow` as a foreign workflow-tool collision.

The other comparison entries are documentation, changelog/release metadata, packaging/lint configuration, or test-only commits; they do not add retained runtime behavior.

## 5. Relevance and port safety for Pi Toolkit

| Upstream change | Current Toolkit state | Assessment |
|---|---|---|
| BOM-safe frontmatter | Toolkit still passes raw file text to `parseFrontmatter` in [`custom-agents.ts`](../../pi-toolkit-lib/unified-subagents/custom-agents.ts), while [`agent-file-toggle.ts`](../../pi-toolkit-lib/unified-subagents/agent-file-toggle.ts) and its test explicitly treat BOM-prefixed files as having no frontmatter. | **Relevant, small, and safe as a manual port.** Normalize BOM consistently on load and toggle paths and update focused tests. Do not cherry-pick the whole upstream commit because its viewer portion targets different code. |
| Viewer Markdown / 16k output | Toolkit's [`conversation-viewer.ts`](../../pi-toolkit-lib/unified-subagents/ui/conversation-viewer.ts) is substantially customized (tool pairing, cached rendering, activity UI) and still truncates results at 500 characters. | **Useful but not patch-safe.** If wanted, manually adapt only the rendering behavior and include the `3d91023` bounded-render follow-up. Preserve Toolkit's cache/throttle behavior and validate large-output performance. |
| RPC `scopeModels` fix | Toolkit routes RPC through `spawnTopLevel`/`spawnResolved` and the shared [`resolveHarnessInvocation`](../../pi-toolkit-lib/unified-subagents/harness-resolution.ts), which calls [`checkModelScope`](../../pi-toolkit-lib/unified-subagents/model-scope.ts) for Pi models. | **Already represented semantically.** No code port; add an RPC regression test during future maintenance if desired. |
| Foreground concurrency | Toolkit intentionally lets foreground runs bypass the background pool and supports foreground-to-background transitions in [`agent-manager.ts`](../../pi-toolkit-lib/unified-subagents/agent-manager.ts). | **Potentially relevant, high-conflict.** Defer unless a concrete local-model/resource-control need appears; implementing it requires a Toolkit-native queue design and transition tests. |
| Workflow subsystem | Toolkit currently supports Pi `>=0.81.0` in [`package.json`](../../package.json), has its own task/background/context integrations, and has no Workflow subsystem. | **Large product feature, not a maintenance port.** It would raise compatibility requirements and add overlapping orchestration/state surfaces. Consider only under a separate design decision; if adopted, include all follow-up fixes through `e955e29`. |

**Recommended action for the tintinweb lineage:** do not merge or bulk-sync. Plan one narrow, manually adapted BOM/frontmatter fix; treat RPC scope enforcement as already integrated; defer Markdown, foreground pooling, and Workflow unless separately prioritized.

## Method and limits

Default branches and heads were resolved from GitHub repository/commit APIs; release/tag and compare APIs established exact ranges. Patch/source inspection was used for applicability, and the exact second-parent identity of `4b581fa` established represented tintinweb history without assuming cross-repository ancestry. No dependency update, installation, merge, port, or implementation edit was performed.
