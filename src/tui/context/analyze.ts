// FILE: src/tui/context/analyze.ts
// VERSION: 2.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Derive honest measured usage plus reconciled observed-context and per-tool attribution from native tagged session data, keeping the registered catalog budget separate.
//   SCOPE: Native compaction cutoff via message order/timestamps, provider-reported usage with per-field unknown semantics and explicit model/variant + compaction relation, context-limit percentages, skill/tool/message/attachment categorization, deterministic non-guessing tool ownership, residual unknown context, and sorted detail aggregates. Unknown limits and missing usage stay unknown rather than zero.
//   DEPENDS: [src/tui/context/estimate.ts, src/tui/context/types.ts]
//   LINKS: [M-PLUGIN-CONTEXT-TUI, DF-CONTEXT-INSPECTION, V-M-PLUGIN-CONTEXT-TUI]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   analyzeContext - Produce the overview and detailed native context analysis rendered by the TUI plugin.
//   createTokenMetric - Pair estimated tokens with a percentage only when a positive context limit exists.
//   classifyToolSource - Classify known native built-in/vvoc tools and leave everything else explicitly unattributed.
//   compareToolUsage - Sort tool detail by combined total descending and ID ascending.
//   findCompactionCutoff - Latest completed compaction message with its active-context index.
//   sameModelRef - True when two provider/model/variant references refer to the same real selection.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-008 attempt 3 - Measured usage now matches the pinned native contextUsage sum of all five token fields (input+output+reasoning+cacheRead+cacheWrite).]
// END_CHANGE_SUMMARY

import { estimateTextTokens, estimateValueTokens } from "./estimate.js";
import type {
  ContextAnalysis,
  ContextAnalysisInput,
  ContextCategory,
  ContextCategoryId,
  ContextCompactionRelation,
  ContextContent,
  ContextMeasuredUsage,
  ContextMessage,
  ContextModel,
  ContextModelRef,
  ContextTokenMetric,
  ContextToolAttribution,
  ContextToolSource,
  ContextToolUsage,
} from "./types.js";

/**
 * Native built-in tool names (core/src/tool/plugin/*). Unknown tools are never
 * classified as built-in; they stay explicitly unattributed.
 */
const BUILTIN_TOOL_IDS = new Set([
  "read",
  "write",
  "edit",
  "patch",
  "glob",
  "grep",
  "shell",
  "subagent",
  "webfetch",
  "websearch",
  "question",
  "skill",
  "execute",
  "list_mcp_resources",
  "read_mcp_resource",
  "opencode",
  "models",
  "session_move",
  "session_rename",
]);

const VVOC_TOOL_IDS = new Set([
  "web_search",
  "web_fetch",
  "work_item_open",
  "work_item_list",
  "work_item_close",
  "work_item_decide",
  "work_checkpoint",
]);

const CATEGORY_LABELS: Record<ContextCategoryId, string> = {
  system: "Agent/system instructions",
  "skill-catalog": "Skill catalog",
  "loaded-skills": "Loaded skill results",
  "user-messages": "User messages",
  "assistant-messages": "Assistant messages",
  "tool-results": "Tool calls and results",
  files: "Files and attachments",
  "compacted-summary": "Compacted summary",
  "provider-only": "Unknown/provider-only",
};

type CategoryCounter = Record<Exclude<ContextCategoryId, "provider-only">, number>;

type ToolUsageDraft = {
  id: string;
  source: ContextToolSource;
  codeMode: boolean;
  schemaListed: boolean;
  schemaTokens: number;
  historyTokens: number;
  calls: number;
};

// START_BLOCK_CONTEXT_ANALYSIS
export function analyzeContext(input: ContextAnalysisInput): ContextAnalysis {
  const compaction = findCompactionCutoff(input.activeMessages);
  const compacted =
    compaction !== undefined ||
    (input.historyMessages.length > 0 &&
      input.activeMessages.length < input.historyMessages.length);
  const latestAssistant = findLatestAssistant(input.activeMessages);
  const latestUser = findLatestUser(input.activeMessages);
  const currentAgent = latestAssistant?.agent ?? latestUser?.agent;
  const counters = createCategoryCounter();

  // Native agents carry both an id and a display name; message.agent is the id.
  const agentPrompt = input.agents.find((agent) => agent.id === currentAgent)?.system;
  counters.system += estimateTextTokens(agentPrompt);

  for (const skill of input.skills) {
    counters["skill-catalog"] += estimateValueTokens({
      name: skill.name,
      description: skill.description,
      path: skill.path,
    });
  }

  // Registered catalog schemas are a budget for the Tools tab, never part of
  // the observed-context subtotal. They are collected here and kept separate.
  const toolDrafts = new Map<string, ToolUsageDraft>();
  let catalogSchemaBudget = 0;
  for (const tool of input.tools) {
    const draft = getToolDraft(toolDrafts, tool.effectiveID, tool);
    draft.schemaListed = tool.status === "registered";
    if (tool.status === "registered") {
      const tokens = estimateValueTokens({
        id: tool.effectiveID,
        description: tool.description,
        namespace: tool.namespace,
        parameters: tool.inputJSONSchema,
      });
      draft.schemaTokens = tokens;
      catalogSchemaBudget += tokens;
    }
  }

  for (const message of input.activeMessages) {
    countMessage(message, counters, toolDrafts);
  }

  // Unknown limits stay unknown; only the selected model's configured limit may
  // be applied, and only to usage attributed to that exact model/variant.
  const contextLimit = normalizeContextLimit(input.selectedModel?.contextLimit);
  const attribution = buildToolAttribution(toolDrafts, contextLimit);
  counters["tool-results"] = attribution.reconciliation.history.toolResults.estimatedTokens;
  counters["loaded-skills"] = attribution.reconciliation.history.loadedSkills.estimatedTokens;

  const categories = buildKnownCategories(counters, contextLimit);
  const estimatedKnownTokens = categories.reduce(
    (total, category) => total + category.estimatedTokens,
    0,
  );
  const measured = latestAssistant
    ? createMeasuredUsage(latestAssistant, input.activeMessages, input.selectedModel, contextLimit)
    : undefined;
  const providerOnlyTokens =
    measured?.usedTokens === undefined
      ? 0
      : Math.max(0, measured.usedTokens - estimatedKnownTokens);
  const estimationDriftTokens =
    measured?.usedTokens === undefined
      ? 0
      : Math.max(0, estimatedKnownTokens - measured.usedTokens);

  if (providerOnlyTokens > 0) {
    categories.push({
      id: "provider-only",
      label: CATEGORY_LABELS["provider-only"],
      ...createTokenMetric(providerOnlyTokens, contextLimit),
      detail: "Measured provider usage not attributable through observable native data",
      source: "provider-residual",
    });
  }

  return {
    sessionID: input.sessionID,
    selectedModel: input.selectedModel,
    historyModel: latestAssistant === undefined ? undefined : modelFromRef(latestAssistant.model),
    agent: currentAgent,
    measured,
    categories,
    estimatedKnownTokens,
    estimatedTotalTokens: estimatedKnownTokens + providerOnlyTokens,
    estimationDriftTokens,
    ...(input.tools.length === 0
      ? {}
      : { catalogSchemaBudget: createTokenMetric(catalogSchemaBudget, contextLimit) }),
    compacted,
    ...(compaction === undefined ? {} : { compactionCutoffId: compaction.message.id }),
    activeMessageCount: input.activeMessages.length,
    totalMessageCount: input.historyMessages.length,
    mcpServers: [...input.mcpServers],
    toolCatalogStatus: input.toolCatalogStatus,
    toolAttribution: attribution,
    warnings: [...(input.warnings ?? []), ...buildCatalogWarnings(input)],
  };
}
// END_BLOCK_CONTEXT_ANALYSIS

// START_BLOCK_DETAILED_ATTRIBUTION
export function createTokenMetric(
  estimatedTokens: number,
  contextLimit: number | undefined,
): ContextTokenMetric {
  const tokens = Number.isFinite(estimatedTokens) ? Math.max(0, estimatedTokens) : 0;
  const limit = normalizeContextLimit(contextLimit);
  if (limit === undefined) return { estimatedTokens: tokens };
  return { estimatedTokens: tokens, percent: (tokens / limit) * 100 };
}

/**
 * Classify known native built-in and vvoc tools; every other tool is left
 * explicitly unattributed. The registered namespace is a hint only and is never
 * treated as authoritative MCP server provenance.
 */
export function classifyToolSource(tool: {
  effectiveID: string;
  name: string;
  namespace?: string;
}): ContextToolSource {
  const id = tool.effectiveID.toLowerCase();
  const name = tool.name.toLowerCase();
  if (VVOC_TOOL_IDS.has(id) || VVOC_TOOL_IDS.has(name)) return { kind: "vvoc" };
  if (BUILTIN_TOOL_IDS.has(id) || BUILTIN_TOOL_IDS.has(name)) return { kind: "builtin" };
  return tool.namespace === undefined
    ? { kind: "other" }
    : { kind: "other", namespace: tool.namespace };
}

export function compareToolUsage(left: ContextToolUsage, right: ContextToolUsage): number {
  const totalDelta = right.total.estimatedTokens - left.total.estimatedTokens;
  return totalDelta || compareText(left.id, right.id);
}

/** Latest completed compaction message with its active-context index. */
export function findCompactionCutoff(
  messages: readonly ContextMessage[],
):
  | { readonly message: Extract<ContextMessage, { kind: "compaction" }>; readonly index: number }
  | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.kind === "compaction" && message.status === "completed") {
      return { message, index };
    }
  }
  return undefined;
}

function buildToolAttribution(
  drafts: ReadonlyMap<string, ToolUsageDraft>,
  contextLimit: number | undefined,
): ContextToolAttribution {
  const tools = [...drafts.values()]
    .map((draft): ContextToolUsage => {
      // Per-row schema availability: a partial catalog does not make a row whose
      // own schema converted unknown.
      const schemaKnown = draft.schemaListed;
      return {
        id: draft.id,
        source: draft.source,
        codeMode: draft.codeMode,
        calls: draft.calls,
        schemaKnown,
        schema: createTokenMetric(schemaKnown ? draft.schemaTokens : 0, contextLimit),
        history: createTokenMetric(draft.historyTokens, contextLimit),
        total: createTokenMetric(
          (schemaKnown ? draft.schemaTokens : 0) + draft.historyTokens,
          contextLimit,
        ),
      };
    })
    .sort(compareToolUsage);

  const schemaBuiltin = sumTools(tools, (tool) => tool.source.kind === "builtin", "schema");
  const schemaVvoc = sumTools(tools, (tool) => tool.source.kind === "vvoc", "schema");
  const schemaExternal = sumTools(tools, (tool) => tool.source.kind === "other", "schema");
  const historyToolResults = sumTools(tools, (tool) => tool.id !== "skill", "history");
  const historyLoadedSkills = sumTools(tools, (tool) => tool.id === "skill", "history");

  return {
    tools,
    otherTools: tools.filter((tool) => tool.source.kind === "other"),
    reconciliation: {
      schema: {
        builtin: createTokenMetric(schemaBuiltin, contextLimit),
        vvoc: createTokenMetric(schemaVvoc, contextLimit),
        external: createTokenMetric(schemaExternal, contextLimit),
        total: createTokenMetric(schemaBuiltin + schemaVvoc + schemaExternal, contextLimit),
      },
      history: {
        toolResults: createTokenMetric(historyToolResults, contextLimit),
        loadedSkills: createTokenMetric(historyLoadedSkills, contextLimit),
        total: createTokenMetric(historyToolResults + historyLoadedSkills, contextLimit),
      },
    },
  };
}

function getToolDraft(
  drafts: Map<string, ToolUsageDraft>,
  id: string,
  tool: { effectiveID: string; name: string; namespace?: string; codeMode: boolean },
): ToolUsageDraft {
  const current = drafts.get(id);
  if (current) return current;
  const created: ToolUsageDraft = {
    id,
    source: classifyToolSource(tool),
    codeMode: tool.codeMode,
    schemaListed: false,
    schemaTokens: 0,
    historyTokens: 0,
    calls: 0,
  };
  drafts.set(id, created);
  return created;
}

function sumTools(
  tools: readonly ContextToolUsage[],
  include: (tool: ContextToolUsage) => boolean,
  metric: "schema" | "history",
): number {
  return tools.reduce(
    (total, tool) => total + (include(tool) ? tool[metric].estimatedTokens : 0),
    0,
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function buildCatalogWarnings(input: ContextAnalysisInput): string[] {
  if (input.toolCatalogStatus === "unavailable") {
    return [
      "Registered tool catalog is unavailable; tool schemas and code-mode intent are unknown.",
    ];
  }
  if (input.toolCatalogStatus === "partial") {
    return [
      "Registered tool catalog is incomplete; unavailable schemas are shown as unknown, not zero.",
    ];
  }
  return [];
}
// END_BLOCK_DETAILED_ATTRIBUTION

// START_BLOCK_CATEGORY_COUNTING
function createCategoryCounter(): CategoryCounter {
  return {
    system: 0,
    "skill-catalog": 0,
    "loaded-skills": 0,
    "user-messages": 0,
    "assistant-messages": 0,
    "tool-results": 0,
    files: 0,
    "compacted-summary": 0,
  };
}

function countMessage(
  message: ContextMessage,
  counters: CategoryCounter,
  drafts: Map<string, ToolUsageDraft>,
): void {
  switch (message.kind) {
    case "user":
      counters["user-messages"] += estimateTextTokens(message.text);
      for (const attachment of message.files ?? []) {
        counters.files += estimateValueTokens({
          name: attachment.name,
          mime: attachment.mime,
          sourceType: attachment.sourceType,
          sourceURI: attachment.sourceURI,
          byteLength: attachment.byteLength,
        });
      }
      return;
    case "synthetic":
      counters["user-messages"] += estimateValueTokens({
        text: message.text,
        description: message.description,
      });
      return;
    case "system":
      counters.system += estimateValueTokens({
        text: message.text,
        description: message.description,
      });
      return;
    case "skill":
      counters["loaded-skills"] += estimateValueTokens({ name: message.name, text: message.text });
      return;
    case "shell":
      counters["tool-results"] += estimateValueTokens({
        command: message.command,
        output: message.output,
      });
      return;
    case "compaction":
      counters["compacted-summary"] += estimateValueTokens({
        summary: message.summary,
        recent: message.recent,
      });
      return;
    case "assistant":
      countAssistant(message, counters, drafts);
      return;
    default:
      return;
  }
}

function countAssistant(
  message: Extract<ContextMessage, { kind: "assistant" }>,
  counters: CategoryCounter,
  drafts: Map<string, ToolUsageDraft>,
): void {
  for (const content of message.content) {
    if (content.type === "text" || content.type === "reasoning") {
      counters["assistant-messages"] += estimateTextTokens(content.text);
      continue;
    }
    const historyTokens = estimateValueTokens(toolPayload(content));
    const draft = getToolDraft(drafts, content.name, {
      effectiveID: content.name,
      name: content.name,
      codeMode: false,
    });
    draft.calls += 1;
    draft.historyTokens += historyTokens;
    const target = content.name === "skill" ? "loaded-skills" : "tool-results";
    counters[target] += historyTokens;
  }
}

function toolPayload(content: Extract<ContextContent, { type: "tool" }>): unknown {
  return {
    tool: content.name,
    input: content.input,
    output: content.state === "completed" ? content.output : undefined,
    error: content.state === "error" ? content.error : undefined,
  };
}

function buildKnownCategories(
  counters: CategoryCounter,
  contextLimit: number | undefined,
): ContextCategory[] {
  return (Object.entries(counters) as Array<[keyof CategoryCounter, number]>)
    .filter(([, estimatedTokens]) => estimatedTokens > 0)
    .map(([id, estimatedTokens]) => ({
      id,
      label: CATEGORY_LABELS[id],
      ...createTokenMetric(estimatedTokens, contextLimit),
      source: "estimated" as const,
    }));
}
// END_BLOCK_CATEGORY_COUNTING

// START_BLOCK_MEASURED_USAGE
function createMeasuredUsage(
  message: Extract<ContextMessage, { kind: "assistant" }>,
  activeMessages: readonly ContextMessage[],
  selectedModel: ContextModel | undefined,
  contextLimit: number | undefined,
): ContextMeasuredUsage | undefined {
  const tokens = message.tokens;
  // Absent or entirely malformed usage stays unknown; a report with at least one
  // usable field is surfaced with the unknown fields left undefined.
  if (tokens === undefined) return undefined;
  const input = tokens.input;
  const cacheRead = tokens.cacheRead;
  const cacheWrite = tokens.cacheWrite;
  const output = tokens.output;
  const reasoning = tokens.reasoning;
  if ([input, cacheRead, cacheWrite, output, reasoning].every((value) => value === undefined)) {
    return undefined;
  }

  // Pinned native `contextUsage` sums ALL five token fields and ignores a
  // non-positive total; missing fields stay unknown.
  const usedTokens = sumKnown([input, output, reasoning, cacheRead, cacheWrite]);
  if (usedTokens !== undefined && usedTokens <= 0) return undefined;
  const matchesSelectedModel =
    selectedModel !== undefined && sameModelRef(message.model, selectedModel);
  const normalizedLimit = matchesSelectedModel ? normalizeContextLimit(contextLimit) : undefined;
  const relation = compactionRelation(message, activeMessages);

  return {
    ...(usedTokens === undefined ? {} : { usedTokens }),
    ...(normalizedLimit === undefined ? {} : { contextLimit: normalizedLimit }),
    ...(normalizedLimit === undefined || usedTokens === undefined
      ? {}
      : { remainingTokens: Math.max(0, normalizedLimit - usedTokens) }),
    ...(normalizedLimit === undefined || usedTokens === undefined
      ? {}
      : { percentUsed: (usedTokens / normalizedLimit) * 100 }),
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
    model: message.model,
    ...(message.createdAt === undefined ? {} : { reportedAt: message.createdAt }),
    compactionRelation: relation,
    matchesSelectedModel,
    label: measuredLabel(message, matchesSelectedModel, relation),
  };
}

/** Temporal relation of a usage report to the latest completed compaction in the active context. */
function compactionRelation(
  message: Extract<ContextMessage, { kind: "assistant" }>,
  activeMessages: readonly ContextMessage[],
): ContextCompactionRelation {
  const compaction = findCompactionCutoff(activeMessages);
  if (compaction === undefined) return "none";
  const messageIndex = activeMessages.indexOf(message);
  if (messageIndex >= 0) return messageIndex > compaction.index ? "after" : "before";
  if (message.createdAt !== undefined && compaction.message.createdAt !== undefined) {
    return message.createdAt >= compaction.message.createdAt ? "after" : "before";
  }
  return "none";
}

function measuredLabel(
  message: Extract<ContextMessage, { kind: "assistant" }>,
  matchesSelectedModel: boolean,
  relation: ContextCompactionRelation,
): string {
  const model = `${message.model.providerID}/${message.model.modelID}${
    message.model.variant === undefined ? "" : `#${message.model.variant}`
  }`;
  if (!matchesSelectedModel) {
    return `Latest provider-reported step usage for ${model}, which differs from the selected model; not current occupancy.`;
  }
  if (relation === "before") {
    return "Reported before the most recent compaction; not the resulting post-compaction occupancy.";
  }
  return "Latest provider-reported step usage for the selected model.";
}

/** True when two provider/model/variant references refer to the same real selection. */
export function sameModelRef(left: ContextModelRef, right: ContextModelRef): boolean {
  return (
    left.providerID === right.providerID &&
    left.modelID === right.modelID &&
    (left.variant ?? undefined) === (right.variant ?? undefined)
  );
}

function sumKnown(values: readonly (number | undefined)[]): number | undefined {
  let total = 0;
  for (const value of values) {
    if (value === undefined || !Number.isFinite(value)) return undefined;
    total += value;
  }
  return total;
}

function modelFromRef(ref: ContextModelRef): ContextModel {
  return {
    providerID: ref.providerID,
    modelID: ref.modelID,
    ...(ref.variant === undefined ? {} : { variant: ref.variant }),
  };
}

function normalizeContextLimit(contextLimit: number | undefined): number | undefined {
  return contextLimit !== undefined && Number.isFinite(contextLimit) && contextLimit > 0
    ? contextLimit
    : undefined;
}

function findLatestAssistant(
  messages: readonly ContextMessage[],
): Extract<ContextMessage, { kind: "assistant" }> | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.kind === "assistant") return message;
  }
  return undefined;
}

function findLatestUser(
  messages: readonly ContextMessage[],
): Extract<ContextMessage, { kind: "user" }> | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.kind === "user") return message;
  }
  return undefined;
}
// END_BLOCK_MEASURED_USAGE
