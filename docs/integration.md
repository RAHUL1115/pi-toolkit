# Toolkit integration map

This is the current local integration guide. Start with the [Toolkit README](../README.md) for installation and commands. Imported upstream guides and historical research are reference material, not instructions to reinstall standalone extensions.

## One entrypoint, distinct runtimes

`package.json` declares only `./index.ts` as a Pi extension. It composes:

| Area | Registration/source | Ownership |
|---|---|---|
| Workflow toggles, editor, transcript markers, grouped rendering | `index.ts` | Toolkit integration layer |
| Background Bash and task manager | `pi-toolkit-lib/background-bash.ts` | Toolkit; session-local processes and logs |
| Delegation, schedules, Activity, workflow orchestration | `pi-toolkit-lib/unified-subagents/` | Internal, selectively ported source tree |
| Goals | `pi-toolkit-lib/goals.ts` | Thin adapter calling pinned `@narumitw/pi-goal` 0.54.8 |
| Questions and context handoff | `ask-user-question/`, `compact-context.ts` | Internal registrars |
| Light-model alias and automatic titles | `session-title.ts` | Toolkit registers `ptk/lite`; titles are optional |
| Footer and usage | `footer.ts`, `usage*.ts` | Toolkit UI and read-only accounting |

`goals-upstream.d.ts` describes the upstream generated TypeScript entrypoint for the compiler; it does not replace Goal's runtime. Goal commands, limits, settings, and persistence retain upstream behavior.

**Composition is not yet a unified scheduler or settings system.** Goal, subagents/workflows, and background Bash retain separate ownership and stopping rules. Goal does not automatically turn every request into autonomous work, own every child process, or enforce a shared dollar budget. Upstream's cooperative workflow-mutex guarantees should not be generalized to all Toolkit features or to an uncharacterized runtime.

Hermes Memory and the MCP adapter are separate extension packages, not Toolkit dependencies. Herdr is not part of Toolkit. Disabling a local extension is a personal installation change, not a repository-level uninstall of its data or services.

## Controls and consent

- `/ptk`: Toolkit workflow toggles.
- `/agents`: direct agent activity list.
- `/agents-options`: agent definitions, schedules, settings, and **Workflows** inspector.
- `/tasks`: background process manager.
- `/goal`: Goal manager/settings; `/goal <objective>` starts explicit Goal mode.
- `/economy on|off|stats|allow <path>`: optional large-read guard and one-read permits.
- `/ptk-usage`: rolling usage dashboard.

The `Agent` tool is ordinary delegation. `SubagentWorkflow` requires explicit user opt-in. `context_tool` requires its exact name in the latest user request. Goal tools being visible does not mean Goal mode is active: completion, blocking, and waiting require the current Goal contract and matching ID.

A background process or agent does not by itself mean the Goal has entered external-wait state. `goal_wait` is for work with an arranged wake event or safety deadline, not a substitute for checking unfinished work.

## Parent and child boundaries

Toolkit's async-local child-construction marker prevents unified-subagent and Goal registration from recursively creating managers or autonomous loops. Mention clones also use this boundary. Goal commands, tools, and continuation handlers are not registered in those child sessions.

The reserved `bulk-reader` is Pi-only, read-only (`read`, `grep`, `find`, `ls`), isolated, and does not inherit parent context or load extensions/skills. It uses the parent's registered `ptk/lite` virtual model/runtime, so alias routing does not require enabling child extensions. Its findings are summaries, not an exact full-file read; parent results remain bounded.

The alias selects available physical models by whole-token hints: Luna, Mini, Haiku, Flash, Lite, Small. It excludes other virtual models and retains continuation/retry routes. Bulk-reader callers cannot replace its reserved model/harness/isolation policy. Other subagent types retain their separate light-model and harness settings.

## Settings and state ownership

Paths use Pi's configured agent directory, normally `~/.pi/agent`.

| Owner | Settings/state | Lifetime |
|---|---|---|
| Pi | Agent-directory `settings.json` package/extension declarations | Installation configuration |
| Toolkit | `pi-toolkit.json` beside `index.ts` | Workflow toggles and collapsed layout |
| Goal | Agent-directory `pi-goal.json` | Limits and default-off managed-run RPC |
| Goal | `goal-state` session entries | Session objective, progress, safety/wait state |
| Subagents | Project `.pi/subagents.json`, global `subagents.json` | Harness/model, scheduling and UI policy |
| Agent types | Project `.pi/agents/*.md`, global `agents/*.md` | Custom definitions |
| Titles/skills | `pi-toolkit:auto-title`, `pi-toolkit:skill-loader` session entries | Generated-title provenance and branch-local skill activation |
| Background Bash | In-memory records and temporary logs | Current runtime; orderly reload/shutdown stops tasks |
| Usage/footer | Native session ledger scan and live UI snapshots | No additional persistent accounting store |

`/ptk` does not merge or edit the Goal/subagent stores. Goal menu saves apply immediately; manual Goal settings edits apply at session start or `/reload`. The footer displays upstream's `goal` status key first, not an arbitrary aggregation of every extension's status.

## Migration checklist

1. Install Toolkit and its locked dependencies; use Pi 0.99.1 as the current tested baseline.
2. Inspect `pi list` and global/project Pi package and explicit extension declarations.
3. Remove standalone `npm:@narumitw/pi-goal` declarations and any separately loaded unified-subagent entrypoint once Toolkit is installed. Avoid loading both copies through `pi -e` or another discovery path.
4. Preserve `pi-goal.json`, agent definitions, subagent settings, and session files. No state deletion is required. An installed but unregistered npm package is not the same as an actively loaded extension.
5. Keep unrelated packages such as Hermes Memory and MCP Adapter unless deliberately migrating them too.
6. Reload Pi, then check `/goal`, `/agents`, `/agents-options`, and `/tasks`. Reload stops Toolkit's current background tasks; finish or intentionally stop them first.

Toolkit's package entrypoint does not automatically remove standalone registrations. New Pi sessions do not inherit another session's Goal merely because they use the same working directory.

## Maintenance and verification

- [README development loop](../README.md#development): native SDK imports, serialized integration tests, focused selections, and full checks.
- [Provenance](../PROVENANCE.md): dependency versus vendored-source ownership and licenses.
- [Current subagent port record](unified-subagents/upstream-v0.19-port.md) and [machine-readable checkpoint](unified-subagents/UPSTREAM.json): use these for the next upstream comparison.
- [Imported guide](unified-subagents/README.md): retained snapshot; use current Toolkit paths and commands instead of historical standalone installation instructions.

Closer integration should build on these boundaries deliberately. Shared settings, lifecycle/cancellation ownership, model policy, and accounting are separate design decisions—not behavior already guaranteed by putting registrars in one file.
