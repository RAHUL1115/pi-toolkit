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
| Usage dashboard | `usage*.ts` | Toolkit UI and read-only accounting; Pi owns the footer |
| Local analytics | `analytics/` | Opt-in event collection/import/reporting; no accounting, model calls, or automatic harness edits |

`goals-upstream.d.ts` describes the upstream generated TypeScript entrypoint for the compiler; it does not replace Goal's runtime. Goal commands, limits, settings, and persistence retain upstream behavior.

**Composition is not yet a unified scheduler or settings system.** Goal, subagents/workflows, and background Bash retain separate ownership and stopping rules. Goal does not automatically turn every request into autonomous work, own every child process, or enforce a shared dollar budget. Upstream's cooperative workflow-mutex guarantees should not be generalized to all Toolkit features or to an uncharacterized runtime.

Hermes Memory and the MCP adapter are separate extension packages, not Toolkit dependencies. Herdr is not part of Toolkit. Disabling a local extension is a personal installation change, not a repository-level uninstall of its data or services.

## Controls and consent

- `/ptk`: Toolkit workflow toggles.
- `/agents`: direct agent activity list.
- `/agents-options`: agent definitions, schedules, settings, and **Workflows** inspector.
- `/tasks`: background process manager.
- `/goal`: Goal manager/settings; `/goal <objective>` starts explicit Goal mode.
- `/economy on|off|stats`: default-on 16 KiB read-content cap; off leaves native reads unchanged. Conditional reading guidance stays identical across toggles, and bulk-reader is available in both modes.
- `/ptk-usage`: rolling usage dashboard.
- `/ptk-analytics status|enable|disable|import|report`: [local analytics](analytics.md), failure categories and review-only proposals. Collection is opt-in; enable/disable affects other running processes after reload.

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
| Usage | Native session ledger scan and live UI snapshots | No additional persistent accounting store |
| Analytics | Agent-directory `analytics/config.json`, event segments, import/health metadata and reports | Local opt-in observations; separate from usage accounting and Toolkit workflow settings |

`/ptk` does not merge or edit the Goal/subagent stores. Goal menu saves apply immediately; manual Goal settings edits apply at session start or `/reload`. Toolkit leaves Pi's built-in footer unchanged; Goal publishes its `goal` status through Pi's native extension status API.

## Migration checklist

1. Install Toolkit and its locked dependencies; use Pi 1.3.0 as the current tested baseline.
2. Inspect `pi list` and global/project Pi package and explicit extension declarations.
3. Remove standalone `npm:@narumitw/pi-goal` declarations and any separately loaded unified-subagent entrypoint once Toolkit is installed. Avoid loading both copies through `pi -e` or another discovery path.
4. Preserve `pi-goal.json`, agent definitions, subagent settings, and session files. No state deletion is required. An installed but unregistered npm package is not the same as an actively loaded extension.
5. Keep unrelated packages such as Hermes Memory and MCP Adapter unless deliberately migrating them too.
6. Reload Pi, then check `/goal`, `/agents`, `/agents-options`, and `/tasks`. Reload stops Toolkit's current background tasks; finish or intentionally stop them first.

Toolkit's package entrypoint does not automatically remove standalone registrations. New Pi sessions do not inherit another session's Goal merely because they use the same working directory.

## Tool reliability guidance

Toolkit adds a fixed **Tool reliability policy** to the system prompt on every `before_agent_start`, including background/custom-message turns. It covers path discovery, schema-aware arguments, exact edits, evidence-based bounded recovery, project-pinned dependencies, safe timeout handling, nested failure status, and verification. The source of truth is `pi-toolkit-lib/tool-reliability.ts`.

The policy uses the named `pi-toolkit-tool-reliability` section in normal sessions and appends once when another extension forces an opaque prompt. Its text does not depend on analytics, counters, compact rendering, or economy mode. It applies to sessions that load Toolkit; it does not inject extensions into isolated children or configure external harnesses. It is model guidance, not a retry engine, permission boundary, or fix for tool implementation defects. No commands are intercepted and no automatic retries, installs, or analytics-driven prompt rewrites are introduced.

Reload Toolkit to activate changed guidance for the next agent run. Finish or intentionally stop active background tasks before `/reload`.

## Pi 1.3 compatibility

Toolkit's development Pi packages are pinned together to 1.3.0; host-provided Pi packages remain wildcard peers as recommended by Pi's package contract. Older host versions are not the current verification baseline.

- Grouped `codemode` output uses the native rendering-only resolver. It does not replace codemode execution, schemas, exposure, or loadout preparation.
- Economy guidance and active dollar skills use named `systemPromptOptions.sections`, preserving Pi's structured prompt replay and incremental tool/loadout updates. If another extension explicitly forces an opaque prompt, Toolkit appends to that prompt instead. Clearing skills removes the active-skill section.
- `before_agent_start` now also runs for idle custom-message turns. Instruction injection applies to both trigger kinds; it does not assume that every event has a user `prompt`.
- A child-owned inline `tool_call` policy enforces subagent scope for both model-issued calls and nested `ctx.executeTool()` calls, independently of user extension filters. Reconciliation preserves deferred/codemode exposure and `defaultActive: false`; explicit activation of allowed optional tools still works. An active-tool list alone is not an execution boundary. Extension loading and tool scoping are not an operating-system sandbox.
- Child SDK sessions do not automatically acquire the CLI's built-in MCP, codemode, or tool-search extensions. Toolkit does not silently enable these capabilities as part of this baseline update.

The integration scripts can also run against an installed Pi rather than the local development dependencies:

```bash
export PI_CODING_AGENT_HOST_ENTRY=/absolute/path/to/pi-coding-agent/dist/index.js
node test/grouped-tools.mjs
node test/economy-integration.mjs
```

The grouped-renderer script exercises the real loader/resolver chain and startup theme validation. The economy script checks native/structured read results, nested codemode calls, both run-trigger kinds, and incremental system-prompt sections. These are automated SDK/rendering checks, not a claim that every interactive TUI path has been manually exercised.

## Maintenance and verification

- [README development loop](../README.md#development): native SDK imports, serialized integration tests, focused selections, and full checks.
- [Provenance](../PROVENANCE.md): dependency versus vendored-source ownership and licenses.
- [Current subagent port record](unified-subagents/upstream-v0.19-port.md) and [machine-readable checkpoint](unified-subagents/UPSTREAM.json): use these for the next upstream comparison.
- [Imported guide](unified-subagents/README.md): retained snapshot; use current Toolkit paths and commands instead of historical standalone installation instructions.

Closer integration should build on these boundaries deliberately. Shared settings, lifecycle/cancellation ownership, model policy, and accounting are separate design decisions—not behavior already guaranteed by putting registrars in one file.
