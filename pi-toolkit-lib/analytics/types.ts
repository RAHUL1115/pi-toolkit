/** Privacy-minimized, versioned analytics. Never persist raw arguments, outputs, prompts or reasoning. */
export type FailureCategory = "invalid_arguments" | "path_not_found" | "edit_mismatch" | "permission" | "authentication" | "rate_limit" | "network" | "timeout" | "dependency" | "cancelled" | "runtime" | "unknown";
export interface Failure {
  category: FailureCategory;
  confidence: "high" | "medium" | "low";
  /** Fixed classifier rule, never the original error text. */
  rule: string;
}
export interface EventScope {
  session: string;
  project: string;
  source: "live" | "history";
  provider?: string;
  model?: string;
  harnessVersion?: string;
}
export interface AnalyticsEvent extends EventScope {
  v: 1;
  id: string;
  timestamp: number;
  kind: "tool" | "skill";
  /** Opaque evidence pointers, not source content. */
  evidence: { call?: string; entry?: string };
  tool?: string;
  parent?: string;
  /** Digest of original arguments, used only for exact-repeat grouping. */
  inputHash?: string;
  status?: "ok" | "error" | "unfinished";
  durationMs?: number;
  durationKind?: "execution" | "nested_elapsed";
  /** Root result timestamp disambiguates reused tool IDs across independent sessions. */
  rootTimestamp?: number;
  failure?: Failure;
  /** Underlying command failure is distinct from tool transport success. */
  exitCode?: number;
  skill?: string;
  skillState?: "loaded" | "invoked";
  skillHash?: string;
  /** Nested history metadata may be incomplete and lacks original results. */
  limited?: boolean;
}
export interface ToolObservation {
  scope: EventScope;
  callId: string;
  tool: string;
  timestamp: number;
  input?: unknown;
  content?: unknown;
  details?: unknown;
  isError: boolean;
  durationMs?: number;
  durationKind?: "execution" | "nested_elapsed";
  rootTimestamp?: number;
  parentId?: string;
  entryId?: string;
  unfinished?: boolean;
  limited?: boolean;
}
export interface SkillObservation {
  scope: EventScope;
  timestamp: number;
  name: string;
  state: "loaded" | "invoked";
  identity: string;
  content?: string;
  entryId?: string;
}
export interface ImportStats {
  files: number;
  bytes: number;
  events: number;
  invalid: number;
  skipped: number;
  duplicates: number;
  partial: boolean;
  reasons: string[];
}
