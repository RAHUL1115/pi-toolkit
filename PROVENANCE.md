# Source provenance

This package is a local composition of user-owned workflow features and modified copies of third-party extensions. This file records their source lineage.

## Provenance map

| Pi Toolkit area | Provenance | Evidence |
|---|---|---|
| `pi-toolkit-lib/footer.ts`, `usage.ts`, `usage-snapshot.ts`, `usage-history.ts` | User-owned replacement | Independent single-line footer and rolling-usage tab registrars, shared ledger formatting, and a bounded read-only native session scanner. |
| Removed `observability.ts` and `lib/{footer-engine,storage,settings}/**` | Historical derivative of `pi-observability` 1.3.2 | Former source matched npm 1.3.2 with local branding, footer controls, Git icon, and settings changes. Replaced rather than updated; historical notice retained. |
| `pi-toolkit-lib/ask-user-question/**` | Copied/modified from `pi-askuserquestion` 1.0.0 | The component, schema, validation, and registration code were merged at upstream commit `e58609c9e9c8c4e8a0348c96eaad38dd7e6f0578`; registration now rejects every non-TUI mode explicitly. |
| `pi-toolkit-lib/unified-subagents/**` | Copied/modified from local `pi-unified-subagents` snapshot `4b581fa99dc13f1a4295f2935cdf0205a0ab9443` | The complete source was moved under Pi Toolkit and its default factory became a private registrar invoked by the sole package entrypoint. Tests and documentation are retained under `test/unified-subagents/**` and `docs/unified-subagents/**`. |
| Compact grouped built-in rendering in `index.ts` | User-owned replacement for `pi-tool-display`; not a source copy | It serves a similar purpose, but a normalized token comparison found no shared 12-token code sequence with `pi-tool-display` 0.5.0. It uses Pi's exported built-in tool factories and a separate grouping design. |
| `$skill` autocomplete/loading in `index.ts` | User-owned local workflow feature | No third-party source marker, package dependency, or matching source tree was found. |
| Windows `Ctrl+Backspace` normalization in `index.ts` | User-owned feature consolidated from the former local `pi-ctrl-backspace` extension | The implementation translates VS Code/Windows Terminal `0x08` input to Pi's delete-word key and is independent of the observability code. |
| Package entry point, workflow settings, README, and `pi-toolkit.json` | User-owned integration layer | These compose the feature areas into `pi-toolkit@0.1.0`. |

## Third-party source retained in this package

### pi-askuserquestion 1.0.0

- Repository: <https://github.com/ghoseb/pi-askuserquestion>
- Source commit: [`e58609c9e9c8c4e8a0348c96eaad38dd7e6f0578`](https://github.com/ghoseb/pi-askuserquestion/commit/e58609c9e9c8c4e8a0348c96eaad38dd7e6f0578)
- Author/license: Baishampayan Ghose, MIT
- Local license copy: [`pi-toolkit-lib/LICENSE.pi-askuserquestion`](pi-toolkit-lib/LICENSE.pi-askuserquestion)

The upstream component, schema, uniqueness validation, and tool registration are retained. Pi Toolkit changes only the registration export name, integration path, and non-TUI guard. The upstream component regression suite is retained under `test/ask-user-question.test.ts`.

### pi-observability 1.3.2 (historical, implementation removed)

- Repository: <https://github.com/imran-vz/pi-observability>
- npm: <https://www.npmjs.com/package/pi-observability/v/1.3.2>
- Source commit: [`ce79c5986b35822408767522ae00f44a49dddb76`](https://github.com/imran-vz/pi-observability/commit/ce79c5986b35822408767522ae00f44a49dddb76)
- License: MIT
- Local license copy: [`pi-toolkit-lib/LICENSE.pi-observability`](pi-toolkit-lib/LICENSE.pi-observability)

Before replacement, comparison against the published 1.3.2 tarball found 19 corresponding TypeScript files: 10 byte-identical and 9 locally modified. The historical local delta was concentrated in branding/commands, footer controls, the branch icon, and moving footer configuration under `pi-toolkit.footer` in Pi's global settings. Those exclusively owned modules have now been removed. Old settings and history files on users' disks are preserved but no longer consumed.

The MIT notice is retained. Keep the notice and this attribution whenever distributing substantial portions of `pi-toolkit-lib`.

### pi-unified-subagents snapshot 4b581fa

- Local repository: <https://github.com/RAHUL1115/pi-unified-subagents>
- Consolidated snapshot: [`4b581fa99dc13f1a4295f2935cdf0205a0ab9443`](https://github.com/RAHUL1115/pi-unified-subagents/commit/4b581fa99dc13f1a4295f2935cdf0205a0ab9443)
- Upstream repository: <https://github.com/tintinweb/pi-subagents>
- Original upstream baseline: `92422a4bf3c3813e01e24c73fa14234dc4ce3b28` (`v0.18.0` plus four subsequent commits)
- Upstream represented through: [`e955e29c51b7a6cce37e1108cd2d6c57a77e151c`](https://github.com/tintinweb/pi-subagents/commit/e955e29c51b7a6cce37e1108cd2d6c57a77e151c) (`v0.19.0` plus follow-up fixes), selectively ported rather than merged
- Machine-readable update baseline: [`docs/unified-subagents/UPSTREAM.json`](docs/unified-subagents/UPSTREAM.json)
- Port mapping and retained local behavior: [`docs/unified-subagents/upstream-v0.19-port.md`](docs/unified-subagents/upstream-v0.19-port.md)
- Author/license: tintinweb and contributors, MIT
- Local license copy: [`pi-toolkit-lib/LICENSE.pi-unified-subagents`](pi-toolkit-lib/LICENSE.pi-unified-subagents)
- Retained documentation snapshot: [`docs/unified-subagents/README.md`](docs/unified-subagents/README.md)

The source is retained as one internal module tree. Its tool names (`Agent`, `get_subagent_result`, and `steer_subagent`), `subagents:*` event/RPC names, `Symbol.for("pi-subagents:manager")` manager handle, `.pi/agents` and `.pi/subagents.json` conventions, child-session guard, output-transcript behavior, and persisted settings remain compatible. Pi Toolkit has since added local integration changes: a shared Tasks/Agents Activity view, permanent suppression of the legacy above-editor widget, task-detail return navigation, compact paired tool results, and unified conversation-viewer navigation. Git history records those post-snapshot changes. The v0.19 port adds Workflow orchestration, BOM-safe frontmatter, bounded Markdown previews, and foreground concurrency without replacing the local backend seam, Economy behavior, or shared Activity UI. Future upstream checks must compare from `UPSTREAM.json.importedThrough`, not from the historical standalone snapshot or the Toolkit package version.

## Historical influence not copied into this package

### pi-tool-display 0.5.0

- Repository: <https://github.com/MasuRii/pi-tool-display>
- npm: <https://www.npmjs.com/package/pi-tool-display/v/0.5.0>
- Source commit: [`91cef7580078371f8dc49a8607222807ad6a424d`](https://github.com/MasuRii/pi-tool-display/commit/91cef7580078371f8dc49a8607222807ad6a424d)
- Author/license: MasuRii, MIT

Pi Toolkit's compact renderer replaced this separately installed package but does not contain its source based on the current comparison. A stale former configuration remains outside this package at `~/.pi/agent/extensions/pi-tool-display/config.json`; it is historical state, not loaded source.

## Reconstruction basis

The historical observability lineage above was reconstructed from current source, retained license files, published npm archives, Git metadata, and surviving Pi configuration. New integrations are recorded directly in this repository's Git history.
