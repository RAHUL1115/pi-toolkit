# Native harness seam

## Goal

Keep `tintinweb/pi-subagents` easy to merge while this fork adds Claude Code, Codex, and Antigravity CLI. Upstream-owned orchestration should know as little as possible about native harness policy.

## Deep modules

- `src/harness-resolution.ts` is the policy module. Its single `resolveHarnessInvocation()` interface owns harness precedence, trust, feature validation, model routing, scope checks, RPC alias normalization, and UI invocation metadata.
- `src/backend.ts` is the execution seam. Its local manifest maps a resolved harness ID to a `SubagentBackend` adapter.
- `src/backends/*.ts` are adapters. They translate one native runtime into the shared `SubagentSession` interface.
- `src/agent-manager.ts` remains lifecycle-only: queueing, worktrees, transcripts, status, abort, and cleanup.

Call flow:

```text
Agent tool / RPC
  -> resolveHarnessInvocation()
  -> AgentManager
  -> getBackend()
  -> Pi / Claude / Codex / Agy adapter
  -> shared SubagentSession + BackendRunResult
```

## Patch-island rules

1. Put harness-specific policy in `harness-resolution.ts`, never inline in `index.ts`, RPC handlers, or the manager.
2. Put protocol/runtime translation in the adapter, never in the manager or UI.
3. Keep RPC transport policy-free; the authoritative top-level spawn hook resolves config and strips forged internal capabilities.
4. Add a harness in the local manifest (`AGENT_HARNESSES`, backend map, resolver policy, adapter). Avoid new conditionals across upstream files.
5. Keep adapter and resolver tests in new local files. Change upstream tests only for genuine shared-interface behavior.
6. Preserve Pi as the default path and keep adapter assertions as defense in depth.

## Upstream sync

Use a real merge from `upstream/master`; do not copy or cherry-pick upstream commits. Before merging, create a backup branch and stash tracked/untracked work. Conflicts should normally be limited to the small hooks in:

- `src/index.ts`: schema plus two resolver calls (Agent and external spawn)
- `src/agent-manager.ts`: backend dispatch and backend-neutral options
- `src/types.ts`: harness/invocation fields
- `src/custom-agents.ts`: harness parsing/default metadata

Resolve those hooks around the upstream behavior rather than taking either whole side. The resolver and adapters are fork-owned patch islands and should merge without conflict unless upstream creates files with the same names.

After every sync, verify:

```bash
npm run lint
npm run typecheck
npm run build
npx vitest run test/harness-resolution.test.ts test/harness-routing.test.ts test/backend.test.ts test/codex-backend.test.ts test/claude-backend.test.ts test/agy-backend.test.ts
npm test
```

Compare full-suite failures against the recorded Windows baseline; do not attribute path, symlink-permission, line-ending, or load-related timeout failures to a merge without reproducing them in isolation.
