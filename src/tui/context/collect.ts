// FILE: src/tui/context/collect.ts
// VERSION: 2.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Collect bounded native session, agent, skill, model, MCP, and registered-tool data for the SELECTED session's current location and hand it to the pure analyzer.
//   SCOPE: Native tagged message normalization (timestamps, attachments, structured errors, partial token usage), selected-session location resolution and location-scoped catalogs, serving-location RPC inspection with reply-location verification, model-limit resolution, explicit unavailable states, and bounded warning capture.
//   DEPENDS: [@opencode/plugin/tui, src/runtime/context-inspection-contract.ts, src/tui/context/analyze.ts, src/tui/context/types.ts]
//   LINKS: [M-PLUGIN-CONTEXT-TUI, DF-CONTEXT-INSPECTION, V-M-PLUGIN-CONTEXT-TUI]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ContextLocationRef - Native location reference used for catalogs and the RPC.
//   ContextCollectionDependencies - Injectable native collection seam for focused tests.
//   normalizeNativeMessage - Normalize one native tagged SessionMessage.Info into the analyzer domain or undefined for non-content messages.
//   collectContextAnalysis - Read native state for the selected session's location, mark unavailable data explicitly, then invoke the pure analyzer.
//   createTuiCollectionDependencies - Production native collection dependencies bound to one TUI plugin context.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-008 attempt 2 - Resolved the selected session's current location for every catalog and the RPC, verified the reply location, preserved attachments/timestamps/structured errors, and kept partial token usage unknown field-by-field.]
// END_CHANGE_SUMMARY

import type { Plugin } from "@opencode/plugin/tui";
import {
  contextInspectionRpc,
  isContextInspectionResult,
  type ContextInspectionResult,
} from "../../runtime/context-inspection-contract.js";
import { analyzeContext } from "./analyze.js";
import type {
  ContextAgent,
  ContextAnalysis,
  ContextAttachment,
  ContextContent,
  ContextMcpServer,
  ContextMessage,
  ContextModel,
  ContextModelRef,
  ContextSkill,
  ContextTokenUsage,
} from "./types.js";

/** Native location reference used for catalogs and the RPC. */
export type ContextLocationRef = {
  directory: string;
  workspaceID?: string;
};

/** Injectable native collection seam for focused tests. */
export interface ContextCollectionDependencies {
  /** Current location of the selected session (falls back to the default location). */
  readSessionLocation(sessionID: string): ContextLocationRef;
  /** Active server-reported context, or undefined when the request failed. */
  readActiveMessages(sessionID: string): Promise<readonly unknown[] | undefined>;
  /** Full known message list used to detect a compaction cutoff. */
  readHistoryMessages(sessionID: string): readonly unknown[];
  readAgents(location: ContextLocationRef): readonly unknown[];
  readSkills(location: ContextLocationRef): readonly unknown[];
  readMcpServers(location: ContextLocationRef): readonly unknown[];
  readModels(location: ContextLocationRef): readonly unknown[];
  readSelectedModel(): ContextModelRef | undefined;
  /** Read-only registered catalog plus allowlisted policy via the native RPC. */
  inspect(
    sessionID: string,
    location: ContextLocationRef,
  ): Promise<ContextInspectionResult | undefined>;
}

// START_BLOCK_CONTEXT_COLLECTION
export async function collectContextAnalysis(
  sessionID: string,
  deps: ContextCollectionDependencies,
): Promise<ContextAnalysis> {
  const warnings: string[] = [];
  const location = deps.readSessionLocation(sessionID);
  const history = normalizeMessages(deps.readHistoryMessages(sessionID));
  const activeRaw = await deps.readActiveMessages(sessionID);
  let activeMessages: ContextMessage[];
  if (activeRaw === undefined) {
    warnings.push(
      "Active session context is unavailable; showing the last known message list instead.",
    );
    activeMessages = [...history];
  } else {
    activeMessages = normalizeMessages(activeRaw);
  }

  const agents = deps
    .readAgents(location)
    .map(normalizeAgent)
    .filter((agent): agent is ContextAgent => agent !== undefined);
  const skills = deps
    .readSkills(location)
    .map(normalizeSkill)
    .filter((skill): skill is ContextSkill => skill !== undefined);
  const mcpServers = deps
    .readMcpServers(location)
    .map(normalizeMcpServer)
    .filter((server): server is ContextMcpServer => server !== undefined);

  const selectedModel = resolveSelectedModel(deps, location);

  let inspection: ContextInspectionResult | undefined;
  try {
    inspection = await deps.inspect(sessionID, location);
  } catch (error) {
    warnings.push(`Registry inspection failed: ${boundedError(error)}`);
  }
  if (inspection === undefined) {
    warnings.push("Registered tool catalog and captured policy are unavailable for this session.");
  } else if (!locationMatches(inspection.location, location)) {
    // A reply for a different location must not be presented as this session's.
    warnings.push(
      "Registry inspection reply location did not match the requested session location.",
    );
    inspection = undefined;
  }
  const tools = inspection?.catalog?.tools ?? [];
  const toolCatalogStatus = inspection?.catalog?.status ?? "unavailable";
  if (inspection?.catalog !== undefined) {
    for (const warning of inspection.catalog.warnings) warnings.push(warning);
  }
  if (inspection?.policy?.status === "unavailable") {
    warnings.push(`Captured policy is unavailable: ${inspection.policy.error}`);
  }
  for (const warning of inspection?.warnings ?? []) warnings.push(warning);

  return analyzeContext({
    sessionID,
    activeMessages,
    historyMessages: history,
    agents,
    skills,
    tools,
    toolCatalogStatus,
    mcpServers,
    ...(selectedModel === undefined ? {} : { selectedModel }),
    warnings,
  });
}
// END_BLOCK_CONTEXT_COLLECTION

// START_BLOCK_MESSAGE_NORMALIZATION
/** Normalize a native message list, dropping non-content control messages. */
function normalizeMessages(messages: readonly unknown[]): ContextMessage[] {
  const normalized: ContextMessage[] = [];
  for (const message of messages) {
    const value = normalizeNativeMessage(message);
    if (value !== undefined) normalized.push(value);
  }
  return normalized;
}

/** Normalize one native tagged SessionMessage.Info into the analyzer domain. */
export function normalizeNativeMessage(raw: unknown): ContextMessage | undefined {
  if (!isRecord(raw)) return undefined;
  const id = readString(raw.id);
  if (id === undefined) return undefined;
  const createdAt = readCreatedAt(raw);
  const base = createdAt === undefined ? { id } : { id, createdAt };
  switch (raw.type) {
    case "user": {
      const agent = readString(raw.agent);
      const model = readModelRef(raw.model);
      const files = readAttachments(raw.files);
      return {
        ...base,
        kind: "user",
        text: readString(raw.text) ?? "",
        ...(agent === undefined ? {} : { agent }),
        ...(model === undefined ? {} : { model }),
        ...(files.length === 0 ? {} : { files }),
      };
    }
    case "synthetic": {
      const description = readString(raw.description);
      return {
        ...base,
        kind: "synthetic",
        text: readString(raw.text) ?? "",
        ...(description === undefined ? {} : { description }),
      };
    }
    case "system": {
      const description = readString(raw.description);
      return {
        ...base,
        kind: "system",
        text: readString(raw.text) ?? "",
        ...(description === undefined ? {} : { description }),
      };
    }
    case "skill":
      return {
        ...base,
        kind: "skill",
        name: readString(raw.name) ?? readString(raw.skill) ?? "skill",
        text: readString(raw.text) ?? "",
      };
    case "shell": {
      const output = readShellOutput(raw.output);
      return {
        ...base,
        kind: "shell",
        command: readString(raw.command) ?? "",
        ...(output === undefined ? {} : { output }),
      };
    }
    case "assistant":
      return normalizeAssistant(base, raw);
    case "compaction":
      return normalizeCompaction(base, raw);
    default:
      // agent.selected / model.selected / location.switched / idle carry no context payload.
      return undefined;
  }
}

function normalizeAssistant(
  base: { id: string; createdAt?: number },
  raw: Record<string, unknown>,
): ContextMessage | undefined {
  const model = readModelRef(raw.model);
  if (model === undefined) return undefined;
  const content: ContextContent[] = [];
  if (Array.isArray(raw.content)) {
    for (const item of raw.content) {
      const normalized = normalizeContent(item);
      if (normalized !== undefined) content.push(normalized);
    }
  }
  const tokens = readTokenUsage(raw.tokens);
  const error = readStructuredError(raw.error);
  return {
    ...base,
    kind: "assistant",
    agent: readString(raw.agent) ?? "unknown",
    model,
    content,
    ...(tokens === undefined ? {} : { tokens }),
    ...(error === undefined ? {} : { error }),
  };
}

function normalizeContent(raw: unknown): ContextContent | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.type === "text") {
    const text = readString(raw.text);
    return text === undefined ? undefined : { type: "text", text };
  }
  if (raw.type === "reasoning") {
    const text = readString(raw.text);
    return text === undefined ? undefined : { type: "reasoning", text };
  }
  if (raw.type === "tool") {
    const name = readString(raw.name);
    if (name === undefined) return undefined;
    const state = isRecord(raw.state) ? raw.state : undefined;
    const status = state?.status;
    return {
      type: "tool",
      id: readString(raw.id) ?? name,
      name,
      state:
        status === "completed" ||
        status === "error" ||
        status === "running" ||
        status === "streaming"
          ? status
          : "running",
      ...(state === undefined ? {} : { input: state.input }),
      ...(status === "completed" && state !== undefined
        ? { output: readToolContent(state.content) }
        : {}),
      ...(status === "error" && state !== undefined
        ? { error: readStructuredError(state.error) ?? state.error }
        : {}),
    };
  }
  return undefined;
}

function normalizeCompaction(
  base: { id: string; createdAt?: number },
  raw: Record<string, unknown>,
): ContextMessage {
  const status = raw.status;
  const tokens = readTokenUsage(raw.tokens);
  const error = readStructuredError(raw.error);
  return {
    ...base,
    kind: "compaction",
    status: status === "completed" || status === "failed" ? status : "running",
    summary: readString(raw.summary) ?? "",
    recent: readString(raw.recent) ?? "",
    ...(tokens === undefined ? {} : { tokens }),
    ...(error === undefined ? {} : { error }),
  };
}

/** Native structured errors are `{type, message, status?}`; render a bounded summary. */
function readStructuredError(value: unknown): string | undefined {
  if (typeof value === "string") return readString(value);
  if (!isRecord(value)) return undefined;
  const type = readString(value.type);
  const message = readString(value.message);
  if (type === undefined && message === undefined) return undefined;
  return [type, message].filter((part): part is string => part !== undefined).join(": ");
}

/** Normalize native user file attachments without carrying the raw base64 payload. */
function readAttachments(value: unknown): ContextAttachment[] {
  if (!Array.isArray(value)) return [];
  const attachments: ContextAttachment[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const mime = readString(item.mime);
    if (mime === undefined) continue;
    const name = readString(item.name);
    const source = isRecord(item.source) ? item.source : undefined;
    const sourceType = source === undefined ? undefined : readString(source.type);
    const sourceURI = source === undefined ? undefined : readString(source.uri);
    const data = typeof item.data === "string" ? item.data : undefined;
    // base64 length -> approximate decoded bytes; never carry the payload itself.
    const byteLength = data === undefined ? undefined : Math.floor((data.length * 3) / 4);
    attachments.push({
      mime,
      ...(name === undefined ? {} : { name }),
      ...(sourceType === undefined ? {} : { sourceType }),
      ...(sourceURI === undefined ? {} : { sourceURI }),
      ...(byteLength === undefined ? {} : { byteLength }),
    });
  }
  return attachments;
}

function readCreatedAt(raw: Record<string, unknown>): number | undefined {
  const time = isRecord(raw.time) ? raw.time : undefined;
  return time === undefined ? undefined : readFiniteNumber(time.created);
}
// END_BLOCK_MESSAGE_NORMALIZATION

// START_BLOCK_CATALOG_NORMALIZATION
function normalizeAgent(raw: unknown): ContextAgent | undefined {
  if (!isRecord(raw)) return undefined;
  const id = readString(raw.id);
  const name = readString(raw.name) ?? id;
  if (id === undefined && name === undefined) return undefined;
  const system = readString(raw.system);
  return {
    id: id ?? name!,
    name: name!,
    ...(system === undefined ? {} : { system }),
  };
}

function normalizeSkill(raw: unknown): ContextSkill | undefined {
  if (!isRecord(raw)) return undefined;
  const name = readString(raw.name) ?? readString(raw.id);
  if (name === undefined) return undefined;
  const description = readString(raw.description);
  return {
    id: readString(raw.id) ?? name,
    name,
    ...(description === undefined ? {} : { description }),
    path: readString(raw.path) ?? "",
  };
}

function normalizeMcpServer(raw: unknown): ContextMcpServer | undefined {
  if (!isRecord(raw)) return undefined;
  const name = readString(raw.name);
  if (name === undefined) return undefined;
  const status = isRecord(raw.status) ? readString(raw.status.status) : undefined;
  const error = isRecord(raw.status) ? readString(raw.status.error) : undefined;
  return {
    name,
    status:
      status === "connected" ||
      status === "pending" ||
      status === "disabled" ||
      status === "failed" ||
      status === "needs_auth"
        ? status
        : "disabled",
    ...(error === undefined ? {} : { error }),
  };
}
// END_BLOCK_CATALOG_NORMALIZATION

// START_BLOCK_SELECTED_MODEL
function resolveSelectedModel(
  deps: ContextCollectionDependencies,
  location: ContextLocationRef,
): ContextModel | undefined {
  const ref = deps.readSelectedModel();
  if (ref === undefined) return undefined;
  const info = findModel(deps.readModels(location), ref);
  const limit = isRecord(info) && isRecord(info.limit) ? info.limit : undefined;
  const contextLimit = readFiniteNumber(limit?.context);
  const outputLimit = readFiniteNumber(limit?.output);
  return {
    providerID: ref.providerID,
    modelID: ref.modelID,
    ...(ref.variant === undefined ? {} : { variant: ref.variant }),
    ...(isRecord(info) && readString(info.name) !== undefined
      ? { name: readString(info.name)! }
      : {}),
    ...(contextLimit === undefined ? {} : { contextLimit }),
    ...(outputLimit === undefined ? {} : { outputLimit }),
  };
}

function findModel(models: readonly unknown[], ref: ContextModelRef): unknown {
  for (const model of models) {
    if (!isRecord(model)) continue;
    if (readString(model.providerID) !== ref.providerID) continue;
    if (readString(model.modelID) === ref.modelID || readString(model.id) === ref.modelID)
      return model;
  }
  return undefined;
}
// END_BLOCK_SELECTED_MODEL

// START_BLOCK_PRODUCTION_DEPENDENCIES
/** Production native collection dependencies bound to one TUI plugin context. */
export function createTuiCollectionDependencies(
  ctx: Plugin.Context,
): ContextCollectionDependencies {
  const sessionLocation = (sessionID: string): ContextLocationRef => {
    const session = ctx.data.session.get(sessionID);
    const location = session?.location;
    if (location !== undefined && typeof location.directory === "string") {
      return { directory: location.directory };
    }
    return ctx.data.location.default();
  };
  return {
    readSessionLocation: sessionLocation,
    async readActiveMessages(sessionID) {
      try {
        const messages = await ctx.client.session.context({ sessionID });
        return Array.isArray(messages) ? messages : [];
      } catch {
        // A failed active-context read is unavailable, not empty.
        return undefined;
      }
    },
    readHistoryMessages: (sessionID) => ctx.data.session.message.list(sessionID),
    readAgents: (location) => ctx.data.location.agent.list(location) ?? [],
    readSkills: (location) => ctx.data.location.skill.list(location) ?? [],
    readMcpServers: (location) => ctx.data.location.mcp.server.list(location) ?? [],
    readModels: (location) => ctx.data.location.model.list(location) ?? [],
    readSelectedModel: () => {
      const current = ctx.ui.model.current();
      return current === undefined
        ? undefined
        : {
            providerID: current.providerID,
            modelID: current.modelID,
            ...(current.variant === undefined ? {} : { variant: current.variant }),
          };
    },
    async inspect(sessionID, location) {
      const result = await ctx.client
        .rpc(contextInspectionRpc)
        .inspect(
          { sessionID, includeCatalog: true },
          { location: { directory: location.directory } },
        );
      return isContextInspectionResult(result) ? result : undefined;
    },
  };
}
// END_BLOCK_PRODUCTION_DEPENDENCIES

function locationMatches(
  reply: { directory: string; workspaceID?: string },
  requested: ContextLocationRef,
): boolean {
  return reply.directory === requested.directory;
}

function readShellOutput(value: unknown): string | undefined {
  return isRecord(value) ? readString(value.output) : undefined;
}

function readToolContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const item of content) {
    if (isRecord(item) && item.type === "text") {
      const text = readString(item.text);
      if (text !== undefined) parts.push(text);
    }
  }
  return parts.length === 0 ? undefined : parts.join("\n");
}

/** Partial native token usage; unknown and non-finite fields stay undefined. */
function readTokenUsage(value: unknown): ContextTokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  const cache = isRecord(value.cache) ? value.cache : undefined;
  const usage: ContextTokenUsage = {
    ...(readFiniteNumber(value.input) === undefined
      ? {}
      : { input: readFiniteNumber(value.input) }),
    ...(readFiniteNumber(value.output) === undefined
      ? {}
      : { output: readFiniteNumber(value.output) }),
    ...(readFiniteNumber(value.reasoning) === undefined
      ? {}
      : { reasoning: readFiniteNumber(value.reasoning) }),
    ...(readFiniteNumber(cache?.read) === undefined
      ? {}
      : { cacheRead: readFiniteNumber(cache?.read) }),
    ...(readFiniteNumber(cache?.write) === undefined
      ? {}
      : { cacheWrite: readFiniteNumber(cache?.write) }),
  };
  return Object.keys(usage).length === 0 ? undefined : usage;
}

function readModelRef(value: unknown): ContextModelRef | undefined {
  if (!isRecord(value)) return undefined;
  const providerID = readString(value.providerID);
  const modelID = readString(value.id) ?? readString(value.modelID);
  if (providerID === undefined || modelID === undefined) return undefined;
  const variant = readString(value.variant);
  return { providerID, modelID, ...(variant === undefined ? {} : { variant }) };
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 160 ? `${message.slice(0, 157)}...` : message;
}
