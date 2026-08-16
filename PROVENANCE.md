# Source provenance

This package is a local composition of user-owned workflow features and modified copies of third-party extensions. This file records their source lineage.

## Provenance map

| Pi Toolkit area | Provenance | Evidence |
|---|---|---|
| `pi-toolkit-lib/observability.ts` | Modified from `pi-observability` 1.3.2 | The npm 1.3.2 source has the same module structure and implementation. Local commands and branding were changed from `obs` to `ptk`. |
| `pi-toolkit-lib/lib/footer-engine/**` | Copied/modified from `pi-observability` 1.3.2 | Four of five TypeScript files are byte-identical to the npm 1.3.2 package; `segments.ts` changes the Git icon. |
| `pi-toolkit-lib/lib/storage/**` | Copied from `pi-observability` 1.3.2 | All six TypeScript files are byte-identical to the npm 1.3.2 package. |
| `pi-toolkit-lib/lib/settings/**` | Modified from `pi-observability` 1.3.2 | The same settings modules remain, with Pi Toolkit footer/path options and namespaced global-settings persistence added locally. |
| `pi-toolkit-lib/ask-user-question/**` | Copied/modified from `pi-askuserquestion` 1.0.0 | The component, schema, validation, and registration code were merged at upstream commit `e58609c9e9c8c4e8a0348c96eaad38dd7e6f0578`; registration now rejects every non-TUI mode explicitly. |
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

### pi-observability 1.3.2

- Repository: <https://github.com/imran-vz/pi-observability>
- npm: <https://www.npmjs.com/package/pi-observability/v/1.3.2>
- Source commit: [`ce79c5986b35822408767522ae00f44a49dddb76`](https://github.com/imran-vz/pi-observability/commit/ce79c5986b35822408767522ae00f44a49dddb76)
- License: MIT
- Local license copy: [`pi-toolkit-lib/LICENSE.pi-observability`](pi-toolkit-lib/LICENSE.pi-observability)

Comparison against the published 1.3.2 tarball found 19 corresponding TypeScript files: 10 byte-identical and 9 locally modified. The aggregate local delta is concentrated in branding/commands, footer controls, the branch icon, and moving footer configuration under `pi-toolkit.footer` in Pi's global settings.

The MIT notice is retained. Keep the notice and this attribution whenever distributing substantial portions of `pi-toolkit-lib`.

## Historical influence not copied into this package

### pi-tool-display 0.5.0

- Repository: <https://github.com/MasuRii/pi-tool-display>
- npm: <https://www.npmjs.com/package/pi-tool-display/v/0.5.0>
- Source commit: [`91cef7580078371f8dc49a8607222807ad6a424d`](https://github.com/MasuRii/pi-tool-display/commit/91cef7580078371f8dc49a8607222807ad6a424d)
- Author/license: MasuRii, MIT

Pi Toolkit's compact renderer replaced this separately installed package but does not contain its source based on the current comparison. A stale former configuration remains outside this package at `~/.pi/agent/extensions/pi-tool-display/config.json`; it is historical state, not loaded source.

## Reconstruction basis

The historical observability lineage above was reconstructed from current source, retained license files, published npm archives, Git metadata, and surviving Pi configuration. New integrations are recorded directly in this repository's Git history.
