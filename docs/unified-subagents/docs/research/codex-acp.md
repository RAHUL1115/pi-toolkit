# Codex CLI over ACP

_Checked 2026-07-28. Published adapter: `@agentclientprotocol/codex-acp@1.1.7`; installed Codex CLI: `0.145.0`._

## Conclusion

OpenAI's `codex` CLI still has no native ACP mode. [`agentclientprotocol/codex-acp`](https://github.com/agentclientprotocol/codex-acp) is a separate translation subprocess: ACP JSON-RPC/stdio on the client side, Codex `app-server` on the child side ([README](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/README.md#readme), [entry point](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/src/index.ts#L61-L150)). It is suitable for embedding, but support belongs to this adapter, not the official `@openai/codex` CLI.

## Install and invoke

**Recommended/current npm path:**

```text
npx -y @agentclientprotocol/codex-acp@1.1.7
# or
npm install -g @agentclientprotocol/codex-acp@1.1.7
codex-acp
```

No arguments starts the stdio ACP server; `codex-acp --version` prints the adapter version. `codex-acp login ...` and `codex-acp cli ...` run its login helper and bundled Codex CLI respectively ([dispatch](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/src/index.ts#L31-L59)). The npm executable is `dist/index.js`; dependencies include ACP SDK `^1.3.0` and Codex `^0.145.0` ([package](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/package.json#L6-L10), [dependencies](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/package.json#L65-L71)). It normally launches that packaged Codex dependency; override only with:

```text
CODEX_PATH=/path/to/codex npx -y @agentclientprotocol/codex-acp@1.1.7
```

([installation](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/README.md#installation), [Codex spawn](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/src/CodexJsonRpcConnection.ts#L15-L29)).

**Standalone binaries:** source scripts can compile Linux/macOS/Windows x64 and arm64 executables with Bun and zip them ([scripts](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/package.json#L21-L34), [build instructions](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/readme-dev.md#build-binaries)). However, the current [v1.1.7 release](https://github.com/agentclientprotocol/codex-acp/releases/tag/v1.1.7) has **no binary assets**, and the current release workflow publishes npm then creates an empty GitHub release ([workflow](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/.github/workflows/publish.yml)). The last release with six platform archives is old [v0.0.38](https://github.com/agentclientprotocol/codex-acp/releases/tag/v0.0.38); do not treat those as current 1.1.7 binaries. A locally built standalone adapter needs a separate Codex executable via `CODEX_PATH`.

## ACP compatibility

The published package uses the stable SDK entry point and returns `acp.PROTOCOL_VERSION`; a live Windows initialization returned **protocol version 1**. It advertises:

- `session/new`, `session/prompt`, `session/cancel` plus load, resume, list, close, delete, and additional directories;
- embedded-context and image prompts (not audio);
- command/stdio and HTTP MCP servers; SSE is false;
- authentication/logout and provider capabilities;
- non-standard steering via `_meta.steering.supported: true`.

See the exact [initialize response](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/src/CodexAcpServer.ts#L207-L253) and [registered methods](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/src/index.ts#L129-L150). This is ACP **v1**, not the draft ACP v2 API. Messages are standard newline-delimited ACP JSON-RPC on stdin/stdout.

## Behavior mapping

### Models and thinking

Codex `model/list` supplies available models. Standard ACP `session/set_config_option` exposes separate `model` and `reasoning_effort` selectors; changing model retains the current effort when supported, otherwise uses that model's default ([config handling](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/src/CodexAcpServer.ts#L735-L837), [option shapes](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/src/ModelConfigOption.ts)). A legacy extension, `session/set_model`, uses composite IDs such as `gpt-5.2[high]` ([extension](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/src/AcpExtensions.ts#L10-L42), [ID format](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/src/ModelId.ts)). Selection is applied on each Codex `turn/start` as `model` and `effort`.

Only reasoning that Codex emits is forwarded. Summary/text deltas become ACP `agent_thought_chunk`; completed reasoning is a fallback when no deltas arrived ([event mapping](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/src/CodexEventHandler.ts#L177-L182), [thought conversion](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/src/CodexEventHandler.ts#L292-L314), [completion fallback](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/src/CodexEventHandler.ts#L392-L439)). Turns request `summary: "auto"`, except API-key sessions or models with only `none` reasoning use `summary: "none"` ([prompt settings](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/src/CodexAcpServer.ts#L1963-L1993), [turn mapping](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/src/CodexAcpClient.ts#L684-L713)).

### Sessions, load, and resume

The ACP session ID is the Codex thread ID. `session/new` maps to `thread/start`. Both `session/resume` and `session/load` call `thread/resume`, but **load additionally calls `thread/read(includeTurns: true)` and replays history as ACP updates; resume does not replay** ([client mapping](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/src/CodexAcpClient.ts#L329-L405), [load versus resume](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/src/CodexAcpServer.ts#L524-L560)). `session/close` interrupts an active turn, unsubscribes, and clears local adapter state. Despite its ACP name, `session/delete` currently maps to Codex `thread/archive`, not hard deletion ([close/delete mapping](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/src/CodexAcpClient.ts#L408-L418)).

### Steering

Steering is an adapter extension, not a stable ACP v1 method:

```json
{"jsonrpc":"2.0","id":9,"method":"_session/steering","params":{"sessionId":"<thread-id>","prompt":[{"type":"text","text":"Change direction"}]}}
```

If a turn is active, the adapter calls Codex `turn/steer`; if the turn ended or no turn exists, it waits for prompt cleanup and starts a new turn. Results are `injected`, `startedNewTurn`, or `failed`. Concurrent steers are serialized FIFO per session ([types](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/src/AcpExtensions.ts#L87-L106), [semantics](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/src/CodexAcpServer.ts#L880-L1073), [queue](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/src/SteeringQueue.ts), [working client example](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/examples/steering.ts)).

### Cancellation

ACP `session/cancel` is a notification. Unknown/no-current-turn cancellation is a no-op; otherwise the adapter waits for a pending turn ID if necessary and sends Codex `turn/interrupt`. An interrupted prompt returns `stopReason: "cancelled"` and emits `*Conversation interrupted*` as an ACP update ([interrupt logic](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/src/CodexAcpServer.ts#L1705-L1843), [prompt result and cancel handler](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/src/CodexAcpServer.ts#L2011-L2131)). JSON-RPC request cancellation is also honored through the SDK `AbortSignal`, including before a turn starts.

### Permissions

The selected mode determines Codex sandbox/approval policy: `read-only` and `agent` use `on-request`; `agent-full-access` uses `never` plus danger-full-access ([presets](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/src/AgentMode.ts#L20-L70)). Codex command, file-edit, and general network/filesystem requests become ACP `session/request_permission` calls. Options preserve allow-once, allow-for-session, reject, command-policy amendment, and network-policy amendment semantics. Cancelled/failed/stale requests fail closed ([mapping](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/src/CodexApprovalHandler.ts#L61-L112), [options and response conversion](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/src/CodexApprovalHandler.ts#L114-L346)). MCP tool approvals use ACP elicitation when the client advertises it, otherwise `session/request_permission`, with once/session/always scopes ([MCP approval paths](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/src/CodexElicitationHandler.ts#L253-L268), [dispatch](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/src/CodexElicitationHandler.ts#L325-L363)).

## Windows status

**Works through npm on this Windows x64 host:** Node 24 ran `npx -y @agentclientprotocol/codex-acp@1.1.7 --version`, and a real stdio ACP `initialize` returned adapter 1.1.7/protocol 1 with the capabilities above. Source explicitly handles Windows command spawning and custom `CODEX_PATH` shell invocation ([adapter spawn](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/src/CodexJsonRpcConnection.ts#L15-L29), [CLI passthrough](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/src/CodexCli.ts#L18-L31)) and has Windows x64/arm64 build targets.

Caveats: Windows development requires the Visual C++ redistributable, with exit code `3221225781` translated to that diagnosis ([guide](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/readme-dev.md#develop-on-windows), [error handling](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/src/CodexAcpServer.ts#L2105-L2117)). Current CI and E2E jobs run only on Ubuntu ([CI](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/.github/workflows/ci.yml), [E2E](https://github.com/agentclientprotocol/codex-acp/blob/v1.1.7/.github/workflows/e2e.yml)), and v1.1.7 publishes no Windows binary asset. Use the npm package on Windows rather than the obsolete v0.0.38 archive.
