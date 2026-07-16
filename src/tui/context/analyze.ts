// FILE: src/tui/context/analyze.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Derive a measured-versus-estimated active context breakdown from observable OpenCode session data.
//   SCOPE: Compaction cutoff, provider usage baseline, model capacity, skill/tool/message categorization, residual unknown context, and MCP summary preservation.
//   DEPENDS: [@opencode-ai/sdk/v2, src/tui/context/estimate.ts, src/tui/context/types.ts]
//   LINKS: [M-PLUGIN-CONTEXT-TUI, DF-CONTEXT-INSPECTION, V-M-PLUGIN-CONTEXT-TUI]
//   ROLE: CORE_LOGIC
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   analyzeContext - Produce the complete context analysis rendered by the TUI plugin.
//   selectActiveMessages - Keep only the latest compaction summary and subsequent turns.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-CONTEXT-TUI-PLUGIN - Added honest active-context categorization and provider residual accounting.]
// END_CHANGE_SUMMARY

import type {
  AssistantMessage,
  Message,
  Part,
  ToolListItem,
  UserMessage,
} from "@opencode-ai/sdk/v2";
import { estimateTextTokens, estimateValueTokens } from "./estimate.js";
import type {
  ContextAnalysis,
  ContextAnalysisInput,
  ContextCategory,
  ContextCategoryId,
} from "./types.js";

const BUILTIN_TOOL_IDS = new Set([
  "bash",
  "glob",
  "grep",
  "list",
  "read",
  "question",
  "skill",
  "task",
  "todowrite",
  "webfetch",
  "write",
]);

const VVOC_TOOL_IDS = new Set(["edit", "work_item_open", "work_item_list", "work_item_close"]);

const CATEGORY_LABELS: Record<ContextCategoryId, string> = {
  system: "Agent/system instructions",
  "skill-catalog": "Skill catalog",
  "loaded-skills": "Loaded skill results",
  "builtin-tool-schemas": "Built-in tool schemas",
  "vvoc-tool-schemas": "vvoc tool schemas",
  "external-tool-schemas": "External/plugin/MCP schemas",
  "user-messages": "User messages",
  "assistant-messages": "Assistant messages",
  "tool-results": "Tool calls and results",
  files: "Files and attachments",
  "compacted-summary": "Compacted summary",
  "provider-only": "Unknown/provider-only",
};

type CategoryCounter = Record<Exclude<ContextCategoryId, "provider-only">, number>;

// START_BLOCK_CONTEXT_ANALYSIS
export function analyzeContext(input: ContextAnalysisInput): ContextAnalysis {
  const activeMessages = selectActiveMessages(input.messages);
  const activeMessageIDs = new Set(activeMessages.map((message) => message.id));
  const activeParts = input.parts.filter((part) => activeMessageIDs.has(part.messageID));
  const latestAssistant = findLatestAssistant(activeMessages);
  const latestUser = findLatestUser(activeMessages);
  const currentAgent = latestAssistant?.agent ?? latestUser?.agent;
  const counters = createCategoryCounter();

  const agentPrompt = input.agents.find((agent) => agent.name === currentAgent)?.prompt;
  counters.system += estimateTextTokens(agentPrompt);
  counters.system += estimateTextTokens(latestUser?.system);

  for (const skill of input.skills) {
    counters["skill-catalog"] += estimateValueTokens({
      name: skill.name,
      description: skill.description,
      location: skill.location,
    });
  }

  for (const tool of input.tools) {
    counters[classifyToolSchema(tool)] += estimateValueTokens({
      id: tool.id,
      description: tool.description,
      parameters: tool.parameters,
    });
  }

  const messageByID = new Map(activeMessages.map((message) => [message.id, message] as const));
  for (const part of activeParts) {
    countPart(part, messageByID.get(part.messageID), counters);
  }

  const categories = buildKnownCategories(counters);
  const estimatedKnownTokens = categories.reduce(
    (total, category) => total + category.estimatedTokens,
    0,
  );
  const measured = latestAssistant
    ? createMeasuredUsage(latestAssistant, input.model?.contextLimit)
    : undefined;
  const providerOnlyTokens = measured ? Math.max(0, measured.usedTokens - estimatedKnownTokens) : 0;
  const estimationDriftTokens = measured
    ? Math.max(0, estimatedKnownTokens - measured.usedTokens)
    : 0;

  if (providerOnlyTokens > 0) {
    categories.push({
      id: "provider-only",
      label: CATEGORY_LABELS["provider-only"],
      estimatedTokens: providerOnlyTokens,
      detail: "Measured provider usage not attributable through public TUI/SDK data",
      source: "provider-residual",
    });
  }

  return {
    sessionID: input.sessionID,
    agent: currentAgent,
    model: input.model,
    measured,
    categories,
    estimatedKnownTokens,
    estimatedTotalTokens: estimatedKnownTokens + providerOnlyTokens,
    estimationDriftTokens,
    compacted: activeMessages.length < input.messages.length,
    activeMessageCount: activeMessages.length,
    mcpServers: [...input.mcpServers],
    warnings: [...(input.warnings ?? [])],
  };
}

export function selectActiveMessages(messages: readonly Message[]): readonly Message[] {
  let summaryIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && message.summary === true) {
      summaryIndex = index;
      break;
    }
  }
  return summaryIndex >= 0 ? messages.slice(summaryIndex) : messages;
}
// END_BLOCK_CONTEXT_ANALYSIS

// START_BLOCK_CATEGORY_COUNTING
function createCategoryCounter(): CategoryCounter {
  return {
    system: 0,
    "skill-catalog": 0,
    "loaded-skills": 0,
    "builtin-tool-schemas": 0,
    "vvoc-tool-schemas": 0,
    "external-tool-schemas": 0,
    "user-messages": 0,
    "assistant-messages": 0,
    "tool-results": 0,
    files: 0,
    "compacted-summary": 0,
  };
}

function classifyToolSchema(
  tool: ToolListItem,
): "builtin-tool-schemas" | "vvoc-tool-schemas" | "external-tool-schemas" {
  if (VVOC_TOOL_IDS.has(tool.id)) return "vvoc-tool-schemas";
  if (BUILTIN_TOOL_IDS.has(tool.id)) return "builtin-tool-schemas";
  return "external-tool-schemas";
}

function countPart(part: Part, message: Message | undefined, counters: CategoryCounter): void {
  switch (part.type) {
    case "text": {
      if (part.ignored) return;
      if (message?.role === "user") {
        counters["user-messages"] += estimateTextTokens(part.text);
      } else if (message?.role === "assistant" && message.summary) {
        counters["compacted-summary"] += estimateTextTokens(part.text);
      } else {
        counters["assistant-messages"] += estimateTextTokens(part.text);
      }
      return;
    }
    case "reasoning":
      counters["assistant-messages"] += estimateTextTokens(part.text);
      return;
    case "subtask":
      counters["assistant-messages"] += estimateValueTokens({
        prompt: part.prompt,
        description: part.description,
        agent: part.agent,
      });
      return;
    case "agent":
      counters["user-messages"] += estimateValueTokens({
        name: part.name,
        source: part.source?.value,
      });
      return;
    case "file":
      counters.files += estimateValueTokens({
        filename: part.filename,
        mime: part.mime,
        source: part.source?.text.value,
        url: part.url.startsWith("data:") ? undefined : part.url,
      });
      return;
    case "tool":
      countToolPart(part, counters);
      return;
    default:
      return;
  }
}

function countToolPart(part: Extract<Part, { type: "tool" }>, counters: CategoryCounter): void {
  const state = part.state;
  const payload = {
    tool: part.tool,
    input: state.input,
    output: state.status === "completed" ? state.output : undefined,
    error: state.status === "error" ? state.error : undefined,
  };
  const target = part.tool === "skill" ? "loaded-skills" : "tool-results";
  counters[target] += estimateValueTokens(payload);

  if (state.status === "completed") {
    for (const attachment of state.attachments ?? []) {
      counters.files += estimateValueTokens({
        filename: attachment.filename,
        mime: attachment.mime,
        source: attachment.source?.text.value,
      });
    }
  }
}

function buildKnownCategories(counters: CategoryCounter): ContextCategory[] {
  return (Object.entries(counters) as Array<[keyof CategoryCounter, number]>)
    .filter(([, estimatedTokens]) => estimatedTokens > 0)
    .map(([id, estimatedTokens]) => ({
      id,
      label: CATEGORY_LABELS[id],
      estimatedTokens,
      source: "estimated" as const,
    }));
}
// END_BLOCK_CATEGORY_COUNTING

// START_BLOCK_MEASURED_USAGE
function createMeasuredUsage(message: AssistantMessage, contextLimit: number | undefined) {
  const usedTokens = message.tokens.input + message.tokens.cache.read + message.tokens.output;
  const normalizedLimit = contextLimit && contextLimit > 0 ? contextLimit : undefined;
  return {
    usedTokens,
    contextLimit: normalizedLimit,
    remainingTokens:
      normalizedLimit === undefined ? undefined : Math.max(0, normalizedLimit - usedTokens),
    percentUsed: normalizedLimit === undefined ? undefined : (usedTokens / normalizedLimit) * 100,
    inputTokens: message.tokens.input,
    cacheReadTokens: message.tokens.cache.read,
    outputTokens: message.tokens.output,
  };
}

function findLatestAssistant(messages: readonly Message[]): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

function findLatestUser(messages: readonly Message[]): UserMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message;
  }
  return undefined;
}
// END_BLOCK_MEASURED_USAGE
