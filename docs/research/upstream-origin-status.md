# Upstream origin status

_Status checked 2026-08-12 against fresh clones and GitHub/npm metadata. “After baseline” means the exclusive Git range `baseline..origin/main`._

## Executive result

Both references are already at their upstream default-branch tips. There are **zero upstream commits after either baseline**, hence no upstream code/API/compatibility delta to sync or port now.

| Origin | Local/reference baseline | Upstream default head | Commits after baseline | Latest release/tag |
|---|---|---|---:|---|
| `imran-vz/pi-observability` | [`ce79c5986b35822408767522ae00f44a49dddb76`](https://github.com/imran-vz/pi-observability/commit/ce79c5986b35822408767522ae00f44a49dddb76), 2026-07-23 12:08:09 +05:30; package 1.3.2 | same commit on `main` | **0** ([empty comparison](https://github.com/imran-vz/pi-observability/compare/ce79c5986b35822408767522ae00f44a49dddb76...main)) | Latest Git tag and npm release: [`v1.3.2`](https://github.com/imran-vz/pi-observability/tree/v1.3.2), tagged 2026-07-23 06:38:10Z and [published to npm](https://www.npmjs.com/package/pi-observability/v/1.3.2) 2026-07-23 06:41:19Z. Latest **GitHub Release object** is older: [`v1.3.1`](https://github.com/imran-vz/pi-observability/releases/tag/v1.3.1), published 2026-05-26 15:46:53Z; no GitHub Release was created for `v1.3.2` ([release list](https://api.github.com/repos/imran-vz/pi-observability/releases)). |
| `ghoseb/pi-askuserquestion` | Installed checkout [`e58609c9e9c8c4e8a0348c96eaad38dd7e6f0578`](https://github.com/ghoseb/pi-askuserquestion/commit/e58609c9e9c8c4e8a0348c96eaad38dd7e6f0578), 2026-05-29 11:34:02 +05:30 | same commit on `main` | **0** ([empty comparison](https://github.com/ghoseb/pi-askuserquestion/compare/e58609c9e9c8c4e8a0348c96eaad38dd7e6f0578...main)) | No Git tags ([tags API](https://api.github.com/repos/ghoseb/pi-askuserquestion/tags)), no GitHub Releases ([releases API](https://api.github.com/repos/ghoseb/pi-askuserquestion/releases)), and no npm package. HEAD's manifest still says `1.0.0` ([source](https://github.com/ghoseb/pi-askuserquestion/blob/e58609c9e9c8c4e8a0348c96eaad38dd7e6f0578/package.json)). |

The installed `pi-askuserquestion` tracked worktree is identical to its HEAD; it has one pre-existing untracked `package-lock.json`. No fetch, checkout, install, or write was performed in that installed origin.

## Changes and relevance

### 1. `pi-observability`

**Commits since PTK baseline:** none. The complete range `ce79c598..origin/main` is empty (ahead/behind `0/0`). Therefore there are no post-baseline material source, API, dependency, or Pi-compatibility changes to enumerate.

For context only—these changes are **already inside** the 1.3.2 baseline:

- [`095a82203185e8b75a8132e089b53a2482eabae4`](https://github.com/imran-vz/pi-observability/commit/095a82203185e8b75a8132e089b53a2482eabae4), 2026-07-23 12:07:54 +05:30, gave concurrent history writes unique PID/UUID temp names, retried `ENOENT`, cleaned failed temp files, and prevented shutdown history errors from escaping.
- [`ce79c5986b35822408767522ae00f44a49dddb76`](https://github.com/imran-vz/pi-observability/commit/ce79c5986b35822408767522ae00f44a49dddb76), 2026-07-23 12:08:09 +05:30, only bumped the manifest to 1.3.2 ([manifest](https://github.com/imran-vz/pi-observability/blob/ce79c5986b35822408767522ae00f44a49dddb76/package.json)).

PTK already contains the concurrent-write fix in `pi-toolkit-lib/lib/storage/file-backend.ts`. A semantic diff against upstream 1.3.2 shows PTK-owned changes elsewhere: `/obs*` became `/ptk*`; footer enable/path state moved into namespaced global settings with locking; the settings UI gained those controls; and the branch glyph changed. This confirms `pi-toolkit-lib` is a **modified derivative**, not a pristine vendor tree (see [`PROVENANCE.md`](../../PROVENANCE.md)).

**Pi 0.84.1:** safe as-is; no update is needed. A fresh upstream 1.3.2 clone passed its typecheck, lint, and format checks after installing exact `@earendil-works/*@0.84.1` packages. A temporary copy of PTK's modified observability subtree also typechecked against those exact packages. Pi 0.84.1 is the current installed/released package ([release](https://github.com/earendil-works/pi/releases/tag/v0.84.1), [manifest](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/package.json)).

### 2. `pi-askuserquestion`

**Commits since installed baseline:** none. The range `e58609c9..origin/main` is empty (ahead/behind `0/0`), so there are no post-baseline behavior, schema, TUI API, or dependency changes.

The current baseline commit itself—not a later update—contains two relevant changes ([diff](https://github.com/ghoseb/pi-askuserquestion/commit/e58609c9e9c8c4e8a0348c96eaad38dd7e6f0578)):

1. imports/peer dependencies migrated from `@mariozechner/*` and `@sinclair/typebox` to `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`;
2. clearing a previously confirmed single-select free-text answer now un-confirms the question, with a regression test.

**Pi 0.84.1:** safe and relevant in its current separate installation. Against exact `@earendil-works/pi-coding-agent@0.84.1`, `pi-tui@0.84.1`, and Pi's `typebox@1.3.7`, the source typechecked, all **109 tests passed**, and upstream's Biome/duplication/Knip checks passed. This is compile/unit evidence; no live registration or interactive TUI state was changed during the check.

One future-vendoring caveat: the repository README says MIT ([source](https://github.com/ghoseb/pi-askuserquestion/blob/e58609c9e9c8c4e8a0348c96eaad38dd7e6f0578/README.md#license)), but the repository has no `LICENSE` file, its package manifest has no `license` field, and GitHub reports no detected license ([repository metadata](https://api.github.com/repos/ghoseb/pi-askuserquestion)). Obtain/retain an explicit license text before redistributing a vendor snapshot.

## Recommendation and boundary

1. **Do nothing now:** both baselines equal upstream `main`; there is no update to apply.
2. **Keep `pi-askuserquestion` separately installed and registered.** Do not register a future PTK vendor copy or merge it into PTK runtime code. If an audit/offline copy is desired, create a **pristine read-only vendor snapshot** pinned to `e58609c9...`, with provenance and license clarification; it is reference material only.
3. **Treat PTK observability differently.** A **pristine read-only vendor snapshot** means an untouched copy at an exact upstream hash, stored separately for comparison. It must not overwrite `pi-toolkit-lib`. A **selected port into PTK-owned modified observability** means reviewing a future upstream commit and manually transplanting only the relevant semantic change while preserving PTK command names, global-settings namespace/locking, footer controls, glyph, and integration tests. There is currently nothing to port.
4. On a future check, first advance the pristine reference and inspect `old-baseline..new-head`; only then decide whether any individual observability commit merits a PTK port.

## Reproduction commands

Run in Git Bash/compatible shell. All installs and writes below are confined to temporary clones/copies.

```bash
TMP="$(cygpath -u "$TEMP")/pi-upstream-origin-research-clean"
rm -rf "$TMP"
mkdir -p "$TMP"
git -c core.autocrlf=false clone https://github.com/imran-vz/pi-observability.git "$TMP/pi-observability"
git -c core.autocrlf=false clone https://github.com/ghoseb/pi-askuserquestion.git "$TMP/pi-askuserquestion"

# Default heads, dates, and exact commit ranges
git -C "$TMP/pi-observability" symbolic-ref refs/remotes/origin/HEAD
git -C "$TMP/pi-observability" show -s --format='%H %aI %s' origin/main
git -C "$TMP/pi-observability" rev-list --count ce79c5986b35822408767522ae00f44a49dddb76..origin/main
git -C "$TMP/pi-observability" tag --sort=-version:refname --format='%(refname:short) %(creatordate:iso-strict) %(*objectname)'

git -C "$TMP/pi-askuserquestion" symbolic-ref refs/remotes/origin/HEAD
git -C "$TMP/pi-askuserquestion" show -s --format='%H %aI %s' origin/main
git -C "$TMP/pi-askuserquestion" rev-list --count e58609c9e9c8c4e8a0348c96eaad38dd7e6f0578..origin/main
git -C "$TMP/pi-askuserquestion" tag

# Read-only inspection of the installed ask-user origin
git -C "$HOME/.pi/agent/git/github.com/ghoseb/pi-askuserquestion" rev-parse HEAD
git -C "$HOME/.pi/agent/git/github.com/ghoseb/pi-askuserquestion" status --porcelain=v1
git -C "$HOME/.pi/agent/git/github.com/ghoseb/pi-askuserquestion" diff --quiet

# Release/tag/package metadata
gh api repos/imran-vz/pi-observability/releases
gh api repos/imran-vz/pi-observability/tags
gh api repos/ghoseb/pi-askuserquestion/releases
gh api repos/ghoseb/pi-askuserquestion/tags
npm view pi-observability version dist-tags time repository --json
npm view pi-askuserquestion version   # expected E404: not published

# Upstream observability with Pi 0.84.1
cd "$TMP/pi-observability"
npm install --no-save --ignore-scripts \
  @earendil-works/pi-ai@0.84.1 \
  @earendil-works/pi-coding-agent@0.84.1 \
  @earendil-works/pi-tui@0.84.1 typescript@5.9.3
npm run check

# Upstream ask-user with Pi 0.84.1 and Pi's TypeBox version
cd "$TMP/pi-askuserquestion"
npm install --ignore-scripts
npm install --no-save --ignore-scripts \
  @earendil-works/pi-coding-agent@0.84.1 \
  @earendil-works/pi-tui@0.84.1 typebox@1.3.7 typescript@5.9.3
npx tsc --noEmit --module nodenext --moduleResolution nodenext \
  --target es2022 --allowImportingTsExtensions --skipLibCheck src/*.ts
npm test
npm run check

# Inspect PTK's semantic divergence without modifying it
UP="$TMP/pi-observability/extensions"
PTK="C:/Users/rahul/dev/pi_extension/pi-toolkit/pi-toolkit-lib"
git diff --no-index --ignore-space-at-eol -- "$UP" "$PTK" || true

# Typecheck a temporary copy of PTK's modified observability against Pi 0.84.1
CHECK="$TMP/pi-toolkit-observability-check"
mkdir -p "$CHECK"
cp -R "$PTK" "$CHECK/pi-toolkit-lib"
cp "C:/Users/rahul/dev/pi_extension/pi-toolkit/package.json" "$CHECK/package.json"
cd "$CHECK"
npm install --no-save --ignore-scripts \
  @earendil-works/pi-ai@0.84.1 \
  @earendil-works/pi-coding-agent@0.84.1 \
  @earendil-works/pi-tui@0.84.1 proper-lockfile@4.1.2 \
  @types/proper-lockfile@4.1.4 typescript@5.9.3
npx tsc --noEmit --module nodenext --moduleResolution nodenext \
  --target es2022 --esModuleInterop --skipLibCheck \
  pi-toolkit-lib/observability.ts pi-toolkit-lib/lib/footer-engine/*.ts \
  pi-toolkit-lib/lib/settings/*.ts pi-toolkit-lib/lib/storage/*.ts
```
