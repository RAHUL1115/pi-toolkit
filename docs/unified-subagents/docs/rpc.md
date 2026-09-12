# Driving Toolkit subagents from another extension

This guide adapts the upstream v0.19 RPC documentation to Pi Toolkit's unified harness boundary. The public event names and protocol remain compatible; do not infer Toolkit behavior from upstream source line numbers.

## Transport and availability

RPC is an **in-process** request/reply protocol on `pi.events`, not a network service. Send a unique `requestId`. Replies arrive on `<request-channel>:reply:<requestId>` as `{ success: true, data? }` or `{ success: false, error }`.

| Channel | Purpose |
|---|---|
| `subagents:rpc:ping` | Returns protocol version `2` |
| `subagents:rpc:spawn` | Starts a detached top-level agent and returns its ID |
| `subagents:rpc:stop` | Stops a top-level agent |
| `subagents:rpc:consume` | Marks a settled top-level result as already delivered |

Handlers register on the first bound `session_start`, followed by `subagents:ready`. They do not advertise availability at extension factory time; filtered-out/child activations must not publish a phantom service. Shutdown unregisters handlers. A caller should use an availability timeout rather than wait indefinitely.

Protocol `2` does not guarantee every additive capability. Treat error replies as authoritative; do not infer support solely from the version.

## Spawn policy

The payload is `{ requestId, type, prompt, options }`. The top-level dispatcher resolves agent definitions and calls Toolkit's **same `resolveHarnessInvocation()` path as the Agent tool**. This is intentionally not a copy of upstream's Pi-only model resolver.

- Agent frontmatter controls harness/model precedence.
- Pi models use the existing registry and `scopeModels` checks. An out-of-scope caller choice fails; user-authored pins follow the existing warning policy.
- Native harness model IDs are not fed into Pi's model registry. Native trust and capability checks still apply.
- Pi, Claude Code, Codex, and Agy continue using their existing adapters.
- Existing worktree settings, isolation, inherited-context, and turn-limit rules are unchanged.

Use manager-style option names: `description`, `name`, `harness`, `model`, `maxTurns`, `thinkingLevel`, `isBackground`, `inheritContext`, `isolated`, `isolation`, and `cwd`. `isolated: true` strips Pi extensions/skills; `isolation: "worktree"` requests a Git worktree. They are not interchangeable. `cwd` must identify an existing absolute directory.

RPC spawns are detached. `isBackground: true` opts into the background concurrency pool; they must not be charged to the blocking foreground pool. Toolkit's resolver also understands established Agent-style aliases; prefer manager-style names for cross-extension code.

Internal ownership/session fields cannot be supplied to forge a nested or workflow child: `parentAgentId`, `workflowId`, `depth`, `maxSubagentDepth`, `configCwd`, `rootSessionId`, `resumeSessionFile`, `reclaim`, and `blocking` are sanitized at the top-level boundary. Activity/usage callbacks are installed by Toolkit, not trusted from callers. The live source contract is `SpawnOptions` plus `spawnTopLevel()` in `pi-toolkit-lib/unified-subagents/`.

## Ownership

`isTopLevelAgent()` excludes both nested children (`parentAgentId`) and workflow children (`workflowId`). That boundary applies to lists, handles, lifecycle notifications, registry lookups, stopping, and consuming results.

Workflow-owned agents belong to the run waiting on them. They are controlled from the workflow inspector, not through ordinary RPC. Their conversations open with `c` in that inspector. A Workflow is not a new RPC service: start orchestration through `SubagentWorkflow`, not through an undocumented event channel.

## Result consumption and notifications

When your extension has already delivered an agent result, emit `subagents:rpc:consume` to prevent duplicate completion delivery. Running or unknown agents cannot be consumed.

The safest sequence is synchronous consumption inside the `subagents:completed` handler. `pi.events` dispatch is synchronous, so the consumed flag is set before Toolkit decides whether to notify. Toolkit also cancels pending notifications and checks consumption again before sending, but consuming after delivery cannot undo the parent turn it triggered.

Steering/resuming a settled agent clears the prior consumption state: its next response still needs delivery. This mechanism does not suppress usage accounting.

## Manager registry

`globalThis[Symbol.for("pi-subagents:manager")]` provides an in-process integration handle:

| Member | Purpose |
|---|---|
| `waitForAll()` | Wait for owned work to finish; useful to headless shutdown |
| `hasRunning()` | Check pending work |
| `spawn(pi, ctx, type, prompt, options)` | Same sanitized top-level spawn boundary |
| `getRecord(id)` | Look up a top-level record; owned children are hidden |

The first root activation owns the slot. Child sessions must not overwrite it, and only its owner removes it at shutdown. Prefer RPC when its verbs suffice; the registry has no versioned reply envelope.

## Tests and references

Regression coverage lives under `test/unified-subagents/`: `cross-extension-rpc.test.ts`, `rpc-lifecycle-gating.test.ts`, `rpc-result-consumption.test.ts`, `harness-routing.test.ts`, `harness-resolution.test.ts`, `manager-registry-guard.test.ts`, and the workflow integration suites.

See [workflow orchestration](workflows.md), [the retained API examples](../README.md#cross-extension-rpc), and the [upstream port record](../upstream-v0.19-port.md). The upstream consumer [tintinweb/pi-tasks](https://github.com/tintinweb/pi-tasks) demonstrates the spawn/listen/consume pattern; its backend assumptions need not match Toolkit's native harnesses.
