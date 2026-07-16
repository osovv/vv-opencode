// FILE: src/tui/context/types.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Define bounded input and output shapes for the context TUI collector, detailed analyzer, and tabbed view.
//   SCOPE: Context categories, reusable token metrics, per-tool and per-MCP attribution, model metadata, warnings, and analysis input/output types.
//   DEPENDS: [@opencode-ai/sdk/v2]
//   LINKS: [M-PLUGIN-CONTEXT-TUI, V-M-PLUGIN-CONTEXT-TUI]
//   ROLE: TYPES
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ContextSkill - Observable skill catalog entry.
//   ContextMcpStatus - Canonical MCP status values exposed by OpenCode.
//   ContextMcpServer - MCP name/status snapshot exposed by the TUI state.
//   ContextModel - Current provider/model metadata and limits.
//   ContextAnalysisInput - Raw bounded data accepted by the pure analyzer.
//   ContextCategoryId - Stable overview category identifiers.
//   ContextTokenMetric - Estimated token count and optional model-context percentage.
//   ContextCategory - One estimated context category row.
//   ContextToolSource - Deterministic built-in, vvoc, MCP, or other tool ownership.
//   ContextToolUsage - Per-tool current schema and active-history attribution.
//   ContextMcpUsage - Per-server aggregate with nested attributed tools.
//   ContextToolReconciliation - Detailed schema and history subtotals aligned with overview categories.
//   ContextToolAttribution - Sorted detailed tool, MCP, other, and reconciliation model.
//   ContextMeasuredUsage - Latest provider-reported usage and model-capacity values.
//   ContextAnalysis - Measured usage, estimated categories, detailed attribution, warnings, and metadata rendered by the dialog.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-CONTEXT-TUI-DETAILED-ATTRIBUTION - Added reusable metrics and detailed tool/MCP attribution shapes.]
// END_CHANGE_SUMMARY

import type { Agent, Message, Part, ToolListItem } from "@opencode-ai/sdk/v2";

export type ContextSkill = {
  name: string;
  description?: string;
  location: string;
  content: string;
};

export type ContextMcpStatus =
  | "connected"
  | "disabled"
  | "failed"
  | "needs_auth"
  | "needs_client_registration";

export type ContextMcpServer = {
  name: string;
  status: ContextMcpStatus;
  error?: string;
};

export type ContextModel = {
  providerID: string;
  modelID: string;
  name?: string;
  contextLimit?: number;
  outputLimit?: number;
};

export type ContextAnalysisInput = {
  sessionID: string;
  messages: readonly Message[];
  parts: readonly Part[];
  agents: readonly Agent[];
  skills: readonly ContextSkill[];
  tools: readonly ToolListItem[];
  mcpServers: readonly ContextMcpServer[];
  model?: ContextModel;
  warnings?: readonly string[];
};

export type ContextCategoryId =
  | "system"
  | "skill-catalog"
  | "loaded-skills"
  | "builtin-tool-schemas"
  | "vvoc-tool-schemas"
  | "external-tool-schemas"
  | "user-messages"
  | "assistant-messages"
  | "tool-results"
  | "files"
  | "compacted-summary"
  | "provider-only";

export type ContextTokenMetric = {
  estimatedTokens: number;
  percent?: number;
};

export type ContextCategory = ContextTokenMetric & {
  id: ContextCategoryId;
  label: string;
  detail?: string;
  source: "estimated" | "provider-residual";
};

export type ContextToolSource =
  | { kind: "builtin" }
  | { kind: "vvoc" }
  | { kind: "mcp"; server: string }
  | { kind: "other" };

export type ContextToolUsage = {
  id: string;
  source: ContextToolSource;
  calls: number;
  schema: ContextTokenMetric;
  history: ContextTokenMetric;
  total: ContextTokenMetric;
};

export type ContextMcpUsage = ContextMcpServer & {
  toolCount: number;
  schema: ContextTokenMetric;
  history: ContextTokenMetric;
  total: ContextTokenMetric;
  tools: ContextToolUsage[];
};

export type ContextToolReconciliation = {
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

export type ContextToolAttribution = {
  tools: ContextToolUsage[];
  mcpServers: ContextMcpUsage[];
  otherTools: ContextToolUsage[];
  reconciliation: ContextToolReconciliation;
};

export type ContextMeasuredUsage = {
  usedTokens: number;
  contextLimit?: number;
  remainingTokens?: number;
  percentUsed?: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
};

export type ContextAnalysis = {
  sessionID: string;
  agent?: string;
  model?: ContextModel;
  measured?: ContextMeasuredUsage;
  categories: ContextCategory[];
  estimatedKnownTokens: number;
  estimatedTotalTokens: number;
  estimationDriftTokens: number;
  compacted: boolean;
  activeMessageCount: number;
  mcpServers: ContextMcpServer[];
  toolAttribution?: ContextToolAttribution;
  warnings: string[];
};
