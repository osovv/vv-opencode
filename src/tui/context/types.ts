// FILE: src/tui/context/types.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Define bounded input and output shapes for the context TUI collector, analyzer, and view.
//   SCOPE: Context categories, model metadata, MCP status summaries, warnings, and analysis input/output types.
//   DEPENDS: [@opencode-ai/sdk/v2]
//   LINKS: [M-PLUGIN-CONTEXT-TUI, V-M-PLUGIN-CONTEXT-TUI]
//   ROLE: TYPES
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ContextSkill - Observable skill catalog entry.
//   ContextMcpServer - MCP name/status snapshot exposed by the TUI state.
//   ContextModel - Current provider/model metadata and limits.
//   ContextAnalysisInput - Raw bounded data accepted by the pure analyzer.
//   ContextCategory - One estimated context category row.
//   ContextAnalysis - Measured usage, estimated categories, warnings, and metadata rendered by the dialog.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-CONTEXT-TUI-PLUGIN - Added shared context-inspection domain types.]
// END_CHANGE_SUMMARY

import type { Agent, Message, Part, ToolListItem } from "@opencode-ai/sdk/v2";

export type ContextSkill = {
  name: string;
  description?: string;
  location: string;
  content: string;
};

export type ContextMcpServer = {
  name: string;
  status: string;
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

export type ContextCategory = {
  id: ContextCategoryId;
  label: string;
  estimatedTokens: number;
  detail?: string;
  source: "estimated" | "provider-residual";
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
  warnings: string[];
};
