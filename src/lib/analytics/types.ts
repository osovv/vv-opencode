// FILE: src/lib/analytics/types.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Define the canonical analytics record and metric types shared by the store, metrics, server plugin, CLI, and TUI indicator.
//   SCOPE: Usage/session persistence record shapes, grouping keys, grouped metric aggregation shape, and indicator token counters.
//   DEPENDS: [none]
//   LINKS: [M-ANALYTICS-STORE, M-ANALYTICS-METRICS, M-PLUGIN-ANALYTICS, M-CLI-ANALYTICS, M-TUI-ANALYTICS-INDICATOR]
//   ROLE: TYPES
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   UsageTokens - Token counters for one completed model step.
//   UsageRecord - One persisted native model-step observation deduped by partID last-write-wins.
//   SessionRecord - Latest known session metadata deduped by sessionID last-write-wins.
//   AnalyticsRecord - Union of persistable analytics record kinds.
//   AnalyticsGroupKey - Grouping keys supported by the analytics CLI.
//   GroupedMetrics - Aggregated metrics for one group with nullable hit rate.
//   IndicatorTokens - Rolling per-session sums used by the live TUI indicator.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-006 - Clarified that partID carries the durable native session.step.ended event id; the record shape and dedupe contract are unchanged.]
// END_CHANGE_SUMMARY

/** Token counters for one completed model step. All values are non-negative integers. */
export type UsageTokens = {
  /** Fresh (uncached) input tokens reported by the provider. */
  input: number;
  /** Output tokens as reported by the provider. */
  output: number;
  /** Reasoning tokens reported separately by the provider. */
  reasoning: number;
  /** Tokens served from the provider prompt cache. */
  cacheRead: number;
  /** Tokens written into the provider prompt cache this step. */
  cacheWrite: number;
};

/**
 * One persisted native model-step observation. Readers dedupe by partID
 * last-write-wins; the native analytics plugin carries the durable
 * `session.step.ended` event id here (the stable step identity replacing the V1
 * step-finish part id), so historical `prt_*` and current `evt_*` records stay
 * mutually exclusive and readable.
 */
export type UsageRecord = {
  kind: "usage";
  /** ISO timestamp of the observation (event delivery time, UTC). */
  ts: string;
  projectID: string;
  projectDirectory: string;
  sessionID: string;
  messageID: string;
  partID: string;
  providerID: string;
  modelID: string;
  agent: string;
  tokens: UsageTokens;
  /** Cost recorded by OpenCode for the step; 0 when unrecorded. */
  cost: number;
  vvocVersion: string;
  /** Best-effort OpenCode version; "unknown" when unresolved. */
  opencodeVersion: string;
};

/** Latest known session metadata. Readers dedupe by sessionID last-write-wins. */
export type SessionRecord = {
  kind: "session";
  ts: string;
  sessionID: string;
  projectID: string;
  title: string;
};

export type AnalyticsRecord = UsageRecord | SessionRecord;

/** Grouping keys supported by `vvoc analytics cache-hit-rate --group-by`. */
export type AnalyticsGroupKey =
  | "session"
  | "day"
  | "week"
  | "month"
  | "model"
  | "provider"
  | "project"
  | "vvoc"
  | "opencode";

/** Aggregated metrics for one group. hitRate is null when no eligible steps exist. */
export type GroupedMetrics = {
  key: string;
  steps: number;
  eligibleSteps: number;
  /** eligibleSteps / steps; 0 when steps === 0. */
  coverage: number;
  /** Token-weighted cache hit rate over eligible steps; null when eligibleSteps === 0. */
  hitRate: number | null;
  cacheRead: number;
  cacheWrite: number;
  input: number;
  output: number;
  reasoning: number;
};

/** Rolling per-session sums used by the live TUI indicator. */
export type IndicatorTokens = {
  steps: number;
  eligibleSteps: number;
  cacheRead: number;
  cacheWrite: number;
  input: number;
};
