// FILE: src/tui/context/types.ts
// VERSION: 2.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Define native-tagged context domain types for the collector, analyzer, and tabbed view, replacing V1 SDK message/part shapes with the pinned native SessionMessage.Info vocabulary.
//   SCOPE: Normalized native messages/content/attachments/token usage, agents/skills/MCP servers, tool rows, selected-vs-history model metadata, explicit measured/estimated token metrics with unknown-when-absent semantics, timestamped compaction state, and analysis input/output types.
//   DEPENDS: [src/runtime/context-inspection-contract.ts]
//   LINKS: [M-PLUGIN-CONTEXT-TUI, DF-CONTEXT-INSPECTION, V-M-PLUGIN-CONTEXT-TUI]
//   ROLE: TYPES
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ContextModelRef - provider/model/variant reference.
//   ContextTokenUsage - Native reported token counts with per-field unknown semantics (reasoning and cache read/write included).
//   ContextAttachment - Bounded native file-attachment metadata (never the raw base64 payload).
//   ContextContent - Native assistant content: text, reasoning, or tool call.
//   ContextMessage - Timestamped normalized native tagged message (user/synthetic/system/skill/shell/assistant/compaction).
//   ContextAgent - Native agent catalog entry with its system prompt.
//   ContextSkill - Native skill catalog entry.
//   ContextMcpStatus - Native MCP status union.
//   ContextMcpServer - Native MCP server name/status and optional error.
//   ContextModel - Selected or history-attributed model metadata and limits.
//   ContextToolCatalogStatus - Whether the registered catalog was complete, partial, unavailable, or not requested.
//   ContextAnalysisInput - Raw bounded native data accepted by the pure analyzer.
//   ContextCategoryId - Stable overview category identifiers for the observed context only.
//   ContextTokenMetric - Estimated token count and optional model-context percentage.
//   ContextCategory - One estimated context category row.
//   ContextToolSource - Deterministic built-in, vvoc, or other ownership (never a guessed MCP link).
//   ContextToolUsage - Per-tool observable schema and active-history attribution.
//   ContextToolAttribution - Sorted detailed tool, external, and reconciliation model.
//   ContextCompactionRelation - Whether reported usage is before, after, or unrelated to the latest completed compaction.
//   ContextMeasuredUsage - Latest provider-reported usage with explicit model/compaction attribution and unknown-when-absent fields.
//   ContextAnalysis - Measured usage, observed-context categories, separate registered-catalog budget, tool attribution, model attribution, warnings, and metadata rendered by the dialog.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-008 attempt 3 - Aligned measured usage with the pinned native contextUsage sum of all five token fields and removed the redundant separate step total.]
// END_CHANGE_SUMMARY

import type { ContextInspectionTool } from "../../runtime/context-inspection-contract.js";

/** provider/model/variant reference. */
export type ContextModelRef = {
  providerID: string;
  modelID: string;
  variant?: string;
};

/**
 * Native reported token counts. A field is `undefined` when the host did not
 * report a usable number, so a missing total is never presented as zero.
 */
export type ContextTokenUsage = {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

/** Bounded native file-attachment metadata; the raw base64 payload is never carried. */
export type ContextAttachment = {
  name?: string;
  mime: string;
  sourceType?: string;
  sourceURI?: string;
  /** Approximate decoded byte length derived from the base64 payload length. */
  byteLength?: number;
};

type ContextMessageBase = {
  id: string;
  /** Native `time.created` epoch milliseconds when the host reported it. */
  createdAt?: number;
};

/** Native assistant content: text, reasoning, or tool call. */
export type ContextContent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool";
      id: string;
      name: string;
      state: "streaming" | "running" | "completed" | "error";
      input?: unknown;
      output?: unknown;
      error?: unknown;
    };

/** Timestamped normalized native tagged message. */
export type ContextMessage =
  | (ContextMessageBase & {
      kind: "user";
      text: string;
      agent?: string;
      model?: ContextModelRef;
      files?: readonly ContextAttachment[];
    })
  | (ContextMessageBase & { kind: "synthetic"; text: string; description?: string })
  | (ContextMessageBase & { kind: "system"; text: string; description?: string })
  | (ContextMessageBase & { kind: "skill"; name: string; text: string })
  | (ContextMessageBase & { kind: "shell"; command: string; output?: string })
  | (ContextMessageBase & {
      kind: "assistant";
      agent: string;
      model: ContextModelRef;
      content: ContextContent[];
      tokens?: ContextTokenUsage;
      /** Structured native error rendered as a bounded `type: message` summary. */
      error?: string;
    })
  | (ContextMessageBase & {
      kind: "compaction";
      status: "running" | "completed" | "failed";
      summary: string;
      recent: string;
      /** Tokens the compaction REQUEST consumed; never the resulting context size. */
      tokens?: ContextTokenUsage;
      error?: string;
    });

/** Native agent catalog entry with its system prompt. */
export type ContextAgent = {
  id: string;
  name: string;
  system?: string;
};

/** Native skill catalog entry. */
export type ContextSkill = {
  id: string;
  name: string;
  description?: string;
  path: string;
};

/** Native MCP status union. */
export type ContextMcpStatus = "connected" | "pending" | "disabled" | "failed" | "needs_auth";

/** Native MCP server name/status and optional error. */
export type ContextMcpServer = {
  name: string;
  status: ContextMcpStatus;
  error?: string;
};

/** Selected or history-attributed model metadata and limits. */
export type ContextModel = {
  providerID: string;
  modelID: string;
  variant?: string;
  name?: string;
  /** Undefined means the limit is unknown, never zero. */
  contextLimit?: number;
  outputLimit?: number;
};

/** Whether the registered catalog was complete, partial, unavailable, or not requested. */
export type ContextToolCatalogStatus = "complete" | "partial" | "unavailable" | "unrequested";

/** Raw bounded native data accepted by the pure analyzer. */
export type ContextAnalysisInput = {
  sessionID: string;
  /** Active history reported by the server's session context endpoint (post-compaction). */
  activeMessages: readonly ContextMessage[];
  /** Full known message list, used to detect that a compaction cutoff occurred. */
  historyMessages: readonly ContextMessage[];
  agents: readonly ContextAgent[];
  skills: readonly ContextSkill[];
  tools: readonly ContextInspectionTool[];
  toolCatalogStatus: ContextToolCatalogStatus;
  mcpServers: readonly ContextMcpServer[];
  /** Selected model from the TUI, which may differ from the history-attributed model. */
  selectedModel?: ContextModel;
  warnings?: readonly string[];
};

/**
 * Stable overview category identifiers for the OBSERVED context only. The
 * registered tool catalog is reported separately as a budget and never counted
 * as current observed context.
 */
export type ContextCategoryId =
  | "system"
  | "skill-catalog"
  | "loaded-skills"
  | "user-messages"
  | "assistant-messages"
  | "tool-results"
  | "files"
  | "compacted-summary"
  | "provider-only";

/** Estimated token count and optional model-context percentage. */
export type ContextTokenMetric = {
  estimatedTokens: number;
  percent?: number;
};

/** One estimated context category row. */
export type ContextCategory = ContextTokenMetric & {
  id: ContextCategoryId;
  label: string;
  detail?: string;
  source: "estimated" | "provider-residual";
};

/** Deterministic built-in, vvoc, or other ownership (never a guessed MCP link). */
export type ContextToolSource =
  | { kind: "builtin" }
  | { kind: "vvoc" }
  | { kind: "other"; namespace?: string };

/** Per-tool observable schema and active-history attribution. */
export type ContextToolUsage = {
  id: string;
  source: ContextToolSource;
  codeMode: boolean;
  calls: number;
  schemaKnown: boolean;
  schema: ContextTokenMetric;
  history: ContextTokenMetric;
  total: ContextTokenMetric;
};

/** Sorted detailed tool, external, and reconciliation model. */
export type ContextToolAttribution = {
  tools: ContextToolUsage[];
  otherTools: ContextToolUsage[];
  reconciliation: {
    schema: {
      builtin: ContextTokenMetric;
      vvoc: ContextTokenMetric;
      external: ContextTokenMetric;
      total: ContextTokenMetric;
    };
    history: {
      toolResults: ContextTokenMetric;
      loadedSkills: ContextTokenMetric;
      total: ContextTokenMetric;
    };
  };
};

/** Whether reported usage is before, after, or unrelated to the latest completed compaction. */
export type ContextCompactionRelation = "before" | "after" | "none";

/** Latest provider-reported usage with explicit model/compaction attribution. */
export type ContextMeasuredUsage = {
  /**
   * Native context usage: `input + output + reasoning + cache.read + cache.write`
   * when all five are known (pinned `tui/src/util/session.ts` `contextUsage`).
   */
  usedTokens?: number;
  contextLimit?: number;
  remainingTokens?: number;
  percentUsed?: number;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  /** The model the usage was reported for, which may differ from the selected model. */
  model: ContextModelRef;
  /** Native message creation time of the usage report when available. */
  reportedAt?: number;
  /** Temporal relation to the latest completed compaction in the active context. */
  compactionRelation: ContextCompactionRelation;
  /** False when the reported model/variant differs from the selected model/variant. */
  matchesSelectedModel: boolean;
  /** Honest one-line description of what the numbers represent. */
  label: string;
};

/** Measured usage, observed categories, separate catalog budget, tool attribution, and warnings. */
export type ContextAnalysis = {
  sessionID: string;
  selectedModel?: ContextModel;
  historyModel?: ContextModel;
  agent?: string;
  measured?: ContextMeasuredUsage;
  categories: ContextCategory[];
  /** Estimated observed-context subtotal (never includes registered catalog schemas). */
  estimatedKnownTokens: number;
  estimatedTotalTokens: number;
  estimationDriftTokens: number;
  /** Registered-catalog schema budget kept explicitly separate from observed context. */
  catalogSchemaBudget?: ContextTokenMetric;
  compacted: boolean;
  compactionCutoffId?: string;
  activeMessageCount: number;
  totalMessageCount: number;
  mcpServers: ContextMcpServer[];
  toolCatalogStatus: ContextToolCatalogStatus;
  toolAttribution?: ContextToolAttribution;
  warnings: string[];
};
