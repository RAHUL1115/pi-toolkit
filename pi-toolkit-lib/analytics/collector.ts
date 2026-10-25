import { digest, skillEvent, toolEvent } from "./normalize.js";
import { nestedParent, readSkillName, skillObservations } from "./skills.js";
import type { AnalyticsEvent, EventScope } from "./types.js";

type Call = { input: unknown; tool: string; root: string; parentId?: string; durationMs?: number; scope: EventScope };
/** Runtime-neutral observer. No model requests and no changes to tool arguments/results. */
export class AnalyticsCollector {
  private calls = new Map<string, Call>();
  // Descendants are normalized immediately (no raw result retention), then published with
  // the root result timestamp so flattened historical metadata has the exact same identity.
  private completed = new Map<string, Array<{ callId: string; event: AnalyticsEvent }>>();
  private buffered = 0;
  private scope: EventScope;
  incomplete = 0;
  constructor(scope: EventScope, private readonly emit: (event: AnalyticsEvent) => void) { this.scope = scope; }

  start(event: { toolCallId: string; toolName: string; args: unknown; parentToolCallId?: string }): void {
    if (this.calls.size >= 2048 && !this.calls.has(event.toolCallId)) {
      this.calls.delete(this.calls.keys().next().value!); this.incomplete++;
    }
    const prior = this.calls.get(event.toolCallId);
    const parent = event.parentToolCallId ? this.calls.get(event.parentToolCallId) : undefined;
    this.calls.set(event.toolCallId, { input: event.args, tool: event.toolName, parentId: event.parentToolCallId,
      root: parent?.root ?? event.parentToolCallId ?? event.toolCallId, scope: prior?.scope ?? parent?.scope ?? this.scope });
  }

  end(event: { toolCallId: string; toolName: string; parentToolCallId?: string; result: any; isError: boolean; durationMs?: number }): void {
    const call = this.calls.get(event.toolCallId);
    if (!event.parentToolCallId) {
      if (call) call.durationMs = event.durationMs;
      return;
    }
    const timestamp = Date.now();
    const normalized = toolEvent({ scope: call?.scope ?? this.unattributedScope(), callId: event.toolCallId, tool: event.toolName, timestamp,
      input: call?.input, parentId: event.parentToolCallId, durationMs: event.durationMs,
      content: event.result?.content, details: event.result?.details, isError: event.isError });
    if (this.buffered < 4096) {
      const root = call?.root ?? event.parentToolCallId;
      const list = this.completed.get(root) ?? [];
      list.push({ callId: event.toolCallId, event: normalized });
      this.completed.set(root, list); this.buffered++;
    } else this.incomplete++;
    this.readSkill(event.toolName, call?.input, event.isError, event.toolCallId, timestamp, call?.scope);
    this.calls.delete(event.toolCallId);
  }

  private publishNested(root: string, rootTimestamp: number): Set<string> {
    const published = new Set<string>();
    for (const child of this.completed.get(root) ?? []) {
      this.emit({ ...child.event, id: digest("nested", child.callId, rootTimestamp), rootTimestamp });
      published.add(child.callId); this.buffered--;
    }
    this.completed.delete(root);
    return published;
  }

  message(message: any): void {
    if (!message || !Number.isFinite(message.timestamp)) return;
    const timestamp = message.timestamp as number;
    if (message.role === "assistant") {
      if (message.stopReason === "pending") return;
      this.scope = { ...this.scope, provider: message.provider, model: message.model };
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part?.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string") {
          this.start({ toolCallId: part.id, toolName: part.name, args: part.arguments });
        }
      }
    } else if (message.role === "toolResult" && typeof message.toolCallId === "string" && typeof message.toolName === "string") {
      const call = this.calls.get(message.toolCallId);
      const scope = call?.scope ?? this.unattributedScope();
      this.emit(toolEvent({ scope, callId: message.toolCallId, tool: message.toolName, timestamp,
        input: call?.input, content: message.content, details: message.details, isError: message.isError === true,
        durationMs: call?.durationMs ?? message.durationMs, limited: !call }));
      this.readSkill(message.toolName, call?.input, message.isError === true, message.toolCallId, timestamp, call?.scope);
      const published = this.publishNested(message.toolCallId, timestamp);
      for (const child of Array.isArray(message.nestedCalls?.calls) ? message.nestedCalls.calls : []) {
        if (!child || typeof child.id !== "string" || typeof child.name !== "string" || published.has(child.id)) continue;
        this.emit(toolEvent({ scope, callId: child.id, parentId: nestedParent(message.toolCallId, child.id), tool: child.name,
          timestamp, input: child.arguments, content: [{ type: "text", text: typeof child.error === "string" ? child.error : "" }],
          isError: child.status === "error", unfinished: child.status === "unfinished", durationMs: child.durationMs, durationKind: "nested_elapsed", limited: true }));
        published.add(child.id);
      }
      this.calls.delete(message.toolCallId);
    } else {
      for (const observation of skillObservations(message)) {
        this.emit(skillEvent({ ...observation, scope: this.unattributedScope(), timestamp }));
      }
    }
  }

  private unattributedScope(): EventScope {
    const { provider: _provider, model: _model, ...scope } = this.scope;
    return scope;
  }

  private readSkill(tool: string, input: unknown, error: boolean, callId: string, timestamp: number, scope = this.unattributedScope()): void {
    const name = !error ? readSkillName(tool, input) : undefined;
    if (name) this.emit(skillEvent({ scope, timestamp, name, state: "loaded", identity: `read:${callId}:${timestamp}` }));
  }

  /** A graceful stop is observable; a hard process kill can still lose queued/in-flight work. */
  stop(): void {
    const timestamp = Date.now();
    for (const root of this.completed.keys()) this.publishNested(root, timestamp);
    for (const [callId, call] of this.calls) {
      this.emit(toolEvent({ scope: call.scope, callId, tool: call.tool, timestamp, input: call.input,
        parentId: call.parentId, isError: false, unfinished: true, limited: true }));
    }
    this.calls.clear();
  }
}

export function scopeFor(session: string, project: string): EventScope {
  return { session: digest(session), project: digest(project), source: "live", harnessVersion: "pi-toolkit/0.1.0" };
}
