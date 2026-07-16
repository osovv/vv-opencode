// FILE: src/tui/context/analyze.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Derive measured usage plus reconciled category, per-tool, and per-MCP active context attribution from observable OpenCode session data.
//   SCOPE: Compaction cutoff, provider usage baseline, context-limit percentages, skill/tool/message categorization, deterministic MCP ownership, explicit schema observability, residual unknown context, and sorted detail aggregates.
//   DEPENDS: [@opencode-ai/sdk/v2, src/tui/context/estimate.ts, src/tui/context/types.ts]
//   LINKS: [M-PLUGIN-CONTEXT-TUI, DF-CONTEXT-INSPECTION, V-M-PLUGIN-CONTEXT-TUI]
//   ROLE: CORE_LOGIC
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   analyzeContext - Produce the complete overview and detailed context analysis rendered by the TUI plugin.
//   selectActiveMessages - Keep only the latest compaction summary and subsequent turns.
//   createTokenMetric - Pair estimated tokens with a percentage only when a positive context limit exists.
//   sanitizeMcpName - Mirror OpenCode's MCP name sanitization contract.
//   classifyToolSource - Classify known tools and uniquely matched MCP prefixes without guessing.
//   ContextToolClassification - Source result plus explicit ambiguous MCP candidates.
//   compareToolUsage - Sort tool detail by combined total descending and ID ascending.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [DIRECT-FIX - Preserved unknown connected MCP schemas as unavailable rather than estimating them as zero.]
// END_CHANGE_SUMMARY

import type { AssistantMessage, Message, Part, UserMessage } from "@opencode-ai/sdk/v2";
import { estimateTextTokens, estimateValueTokens } from "./estimate.js";
import type {
  ContextAnalysis,
  ContextAnalysisInput,
  ContextCategory,
  ContextCategoryId,
  ContextMcpServer,
  ContextMcpUsage,
  ContextTokenMetric,
  ContextToolAttribution,
  ContextToolSource,
  ContextToolUsage,
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

const MAX_ATTRIBUTION_WARNINGS = 3;

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

type ToolUsageDraft = {
  id: string;
  schemaListed: boolean;
  schemaTokens: number;
  historyTokens: number;
  calls: number;
};

export type ContextToolClassification = {
  source: ContextToolSource;
  ambiguousServers?: string[];
};

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

  const toolDrafts = new Map<string, ToolUsageDraft>();
  for (const tool of input.tools) {
    const draft = getToolDraft(toolDrafts, tool.id);
    draft.schemaListed = true;
    draft.schemaTokens = estimateValueTokens({
      id: tool.id,
      description: tool.description,
      parameters: tool.parameters,
    });
  }

  const messageByID = new Map(activeMessages.map((message) => [message.id, message] as const));
  const toolPartsByCall = new Map<string, Extract<Part, { type: "tool" }>>();
  for (const part of activeParts) {
    if (part.type === "tool") {
      toolPartsByCall.set(`${part.tool}\u0000${part.callID}`, part);
      continue;
    }
    countPart(part, messageByID.get(part.messageID), counters);
  }

  for (const part of toolPartsByCall.values()) {
    const historyTokens = countToolPart(part, counters);
    const draft = getToolDraft(toolDrafts, part.tool);
    draft.calls += 1;
    draft.historyTokens += historyTokens;
  }

  const contextLimit = normalizeContextLimit(input.model?.contextLimit);
  const detail = buildToolAttribution(
    toolDrafts,
    input.mcpServers,
    contextLimit,
    input.mcpSchemaCatalogAvailable ?? false,
  );
  counters["builtin-tool-schemas"] =
    detail.attribution.reconciliation.schema.builtin.estimatedTokens;
  counters["vvoc-tool-schemas"] = detail.attribution.reconciliation.schema.vvoc.estimatedTokens;
  counters["external-tool-schemas"] =
    detail.attribution.reconciliation.schema.external.estimatedTokens;
  counters["tool-results"] = detail.attribution.reconciliation.history.toolResults.estimatedTokens;
  counters["loaded-skills"] =
    detail.attribution.reconciliation.history.loadedSkills.estimatedTokens;

  const categories = buildKnownCategories(counters, contextLimit);
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
      ...createTokenMetric(providerOnlyTokens, contextLimit),
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
    toolAttribution: detail.attribution,
    warnings: [...(input.warnings ?? []), ...detail.warnings],
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

export function sanitizeMcpName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function classifyToolSource(
  toolID: string,
  mcpServers: readonly ContextMcpServer[],
): ContextToolClassification {
  if (VVOC_TOOL_IDS.has(toolID)) return { source: { kind: "vvoc" } };
  if (BUILTIN_TOOL_IDS.has(toolID)) return { source: { kind: "builtin" } };

  const uniqueServers = new Map(mcpServers.map((server) => [server.name, server] as const));
  const candidates = [...uniqueServers.values()]
    .map((server) => ({ name: server.name, prefix: `${sanitizeMcpName(server.name)}_` }))
    .filter((candidate) => toolID.startsWith(candidate.prefix));

  if (candidates.length === 0) return { source: { kind: "other" } };

  const longestLength = Math.max(...candidates.map((candidate) => candidate.prefix.length));
  const longest = candidates
    .filter((candidate) => candidate.prefix.length === longestLength)
    .sort((left, right) => compareText(left.name, right.name));

  if (longest.length !== 1) {
    return {
      source: { kind: "other" },
      ambiguousServers: longest.map((candidate) => candidate.name),
    };
  }

  return { source: { kind: "mcp", server: longest[0]!.name } };
}

export function compareToolUsage(left: ContextToolUsage, right: ContextToolUsage): number {
  const totalDelta = right.total.estimatedTokens - left.total.estimatedTokens;
  return totalDelta || compareText(left.id, right.id);
}

function buildToolAttribution(
  drafts: ReadonlyMap<string, ToolUsageDraft>,
  mcpServers: readonly ContextMcpServer[],
  contextLimit: number | undefined,
  mcpSchemaCatalogAvailable: boolean,
): { attribution: ContextToolAttribution; warnings: string[] } {
  const serverByName = new Map(mcpServers.map((server) => [server.name, server] as const));
  const ambiguities = new Map<string, string[]>();
  const tools = [...drafts.values()]
    .map((draft): ContextToolUsage => {
      const classification = classifyToolSource(draft.id, mcpServers);
      if (classification.ambiguousServers) {
        ambiguities.set(draft.id, classification.ambiguousServers);
      }
      const server =
        classification.source.kind === "mcp"
          ? serverByName.get(classification.source.server)
          : undefined;
      const schema = resolveToolSchema(
        draft,
        classification.source,
        server,
        mcpSchemaCatalogAvailable,
      );
      return {
        id: draft.id,
        source: classification.source,
        calls: draft.calls,
        schemaKnown: schema.known,
        schema: createTokenMetric(schema.tokens, contextLimit),
        history: createTokenMetric(draft.historyTokens, contextLimit),
        total: createTokenMetric(schema.tokens + draft.historyTokens, contextLimit),
      };
    })
    .sort(compareToolUsage);

  const schemaBuiltin = sumTools(tools, (tool) => tool.source.kind === "builtin", "schema");
  const schemaVvoc = sumTools(tools, (tool) => tool.source.kind === "vvoc", "schema");
  const schemaExternal = sumTools(
    tools,
    (tool) => tool.source.kind === "mcp" || tool.source.kind === "other",
    "schema",
  );
  const historyToolResults = sumTools(tools, (tool) => tool.id !== "skill", "history");
  const historyLoadedSkills = sumTools(tools, (tool) => tool.id === "skill", "history");

  const uniqueServers = [...serverByName.values()];
  const mcpUsage = uniqueServers
    .map((server): ContextMcpUsage => {
      const serverTools = tools.filter(
        (tool) => tool.source.kind === "mcp" && tool.source.server === server.name,
      );
      const schemaKnown = server.status !== "connected" || mcpSchemaCatalogAvailable;
      const schemaTokens = schemaKnown ? sumTools(serverTools, () => true, "schema") : 0;
      const historyTokens = sumTools(serverTools, () => true, "history");
      return {
        ...server,
        toolCount: schemaKnown
          ? serverTools.filter((tool) => tool.schema.estimatedTokens > 0).length
          : undefined,
        schemaKnown,
        schema: createTokenMetric(schemaTokens, contextLimit),
        history: createTokenMetric(historyTokens, contextLimit),
        total: createTokenMetric(schemaTokens + historyTokens, contextLimit),
        tools: serverTools,
      };
    })
    .sort(compareMcpUsage);

  return {
    attribution: {
      tools,
      mcpServers: mcpUsage,
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
    },
    warnings: buildAmbiguityWarnings(ambiguities),
  };
}

function getToolDraft(drafts: Map<string, ToolUsageDraft>, id: string): ToolUsageDraft {
  const current = drafts.get(id);
  if (current) return current;
  const created = { id, schemaListed: false, schemaTokens: 0, historyTokens: 0, calls: 0 };
  drafts.set(id, created);
  return created;
}

function resolveToolSchema(
  draft: ToolUsageDraft,
  source: ContextToolSource,
  server: ContextMcpServer | undefined,
  mcpSchemaCatalogAvailable: boolean,
): { known: boolean; tokens: number } {
  if (source.kind !== "mcp") {
    return { known: draft.schemaListed, tokens: draft.schemaTokens };
  }
  if (!server) return { known: false, tokens: 0 };
  if (server.status !== "connected") return { known: true, tokens: 0 };
  if (!mcpSchemaCatalogAvailable) return { known: false, tokens: 0 };
  return { known: true, tokens: draft.schemaListed ? draft.schemaTokens : 0 };
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

function compareMcpUsage(left: ContextMcpUsage, right: ContextMcpUsage): number {
  const totalDelta = right.total.estimatedTokens - left.total.estimatedTokens;
  return totalDelta || compareText(left.name, right.name);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function buildAmbiguityWarnings(ambiguities: ReadonlyMap<string, readonly string[]>): string[] {
  const entries = [...ambiguities.entries()].sort(([left], [right]) => compareText(left, right));
  const visible =
    entries.length > MAX_ATTRIBUTION_WARNINGS
      ? entries.slice(0, MAX_ATTRIBUTION_WARNINGS - 1)
      : entries;
  const warnings = visible.map(([toolID, servers]) =>
    boundWarning(
      `MCP attribution ambiguous for "${toolID}": matches ${servers.join(", ")}; grouped under Other external/plugin.`,
    ),
  );
  if (entries.length > MAX_ATTRIBUTION_WARNINGS) {
    warnings.push(
      `MCP attribution ambiguous for ${entries.length - visible.length} additional tool IDs; grouped under Other external/plugin.`,
    );
  }
  return warnings;
}

function boundWarning(value: string): string {
  return value.length > 180 ? `${value.slice(0, 177)}...` : value;
}
// END_BLOCK_DETAILED_ATTRIBUTION

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
    default:
      return;
  }
}

function countToolPart(part: Extract<Part, { type: "tool" }>, counters: CategoryCounter): number {
  const state = part.state;
  const payload = {
    tool: part.tool,
    input: state.input,
    output: state.status === "completed" ? state.output : undefined,
    error: state.status === "error" ? state.error : undefined,
  };
  const target = part.tool === "skill" ? "loaded-skills" : "tool-results";
  const historyTokens = estimateValueTokens(payload);
  counters[target] += historyTokens;

  if (state.status === "completed") {
    for (const attachment of state.attachments ?? []) {
      counters.files += estimateValueTokens({
        filename: attachment.filename,
        mime: attachment.mime,
        source: attachment.source?.text.value,
      });
    }
  }
  return historyTokens;
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
function createMeasuredUsage(message: AssistantMessage, contextLimit: number | undefined) {
  const usedTokens = message.tokens.input + message.tokens.cache.read + message.tokens.output;
  const normalizedLimit = normalizeContextLimit(contextLimit);
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

function normalizeContextLimit(contextLimit: number | undefined): number | undefined {
  return contextLimit !== undefined && Number.isFinite(contextLimit) && contextLimit > 0
    ? contextLimit
    : undefined;
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
