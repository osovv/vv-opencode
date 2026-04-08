// FILE: src/plugins/memory/memory.ts
// VERSION: 0.2.6
// START_MODULE_CONTRACT
//   PURPOSE: Register explicit vvoc memory tools and the report-only memory reviewer agent.
//   SCOPE: Memory reviewer agent config, managed prompt loading, scope resolution, memory tool execution, proactive system instruction injection, and plugin initialization logging.
//   DEPENDS: [@opencode-ai/plugin, src/lib/managed-agents.ts, src/plugins/memory-store.ts]
//   LINKS: [M-PLUGIN-MEMORY, M-PLUGIN-MEMORY-STORE]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   MemoryPlugin - Registers explicit memory tools, proactive system guidance, and the memory-reviewer subagent.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.2.6 - Switched memory-reviewer to vvoc-managed prompt files with no bundled runtime fallback.]
// END_CHANGE_SUMMARY

import { type Config, type Plugin, tool } from "@opencode-ai/plugin";
import { loadManagedAgentPromptText } from "../../lib/managed-agents.js";
import {
  deleteMemory,
  getDefaultProjectScopeKey,
  getDefaultSearchLimit,
  getDefaultSharedScopeKey,
  getMemory,
  listMemories,
  loadMemoryRuntimeConfig,
  normalizeReadScopeType,
  normalizeWriteScopeType,
  putMemory,
  resolveBranchScopeKey,
  searchMemories,
  updateMemory,
  type MemoryEntry,
  type MemoryRuntimeConfig,
  type MemoryScope,
} from "../memory-store.js";
import systemInstructionTemplate from "./system-instruction.md?raw";

const MEMORY_REVIEW_AGENT = "memory-reviewer";
const z = tool.schema;

const MEMORY_SYSTEM_INSTRUCTION = systemInstructionTemplate.trim();

// START_BLOCK_REVIEWER_AGENT_CONFIGURATION
function createMemoryReviewerToolsConfig(): Record<string, boolean> {
  return {
    bash: false,
    edit: false,
    write: false,
    read: false,
    list: false,
    glob: false,
    grep: false,
    task: false,
    webfetch: false,
    websearch: false,
    codesearch: false,
    lsp: false,
    skill: false,
    todoread: false,
    todowrite: false,
    memory_search: true,
    memory_get: true,
    memory_list: true,
    memory_put: false,
    memory_update: false,
    memory_delete: false,
  };
}

function installMemoryReviewerAgent(
  config: Config,
  reviewerPrompt: string,
  reviewerModel?: string,
  reviewerVariant?: string,
): void {
  config.agent ??= {};
  config.agent[MEMORY_REVIEW_AGENT] = {
    mode: "subagent",
    description:
      "Reviews stored vvoc memory and suggests cleanup actions without modifying entries.",
    prompt: reviewerPrompt.trim(),
    permission: {
      edit: "deny",
      webfetch: "deny",
      bash: {
        "*": "deny",
      },
    },
    tools: createMemoryReviewerToolsConfig(),
    ...(reviewerModel ? { model: reviewerModel } : {}),
    ...(reviewerVariant ? { variant: reviewerVariant } : {}),
  } as never;
}
// END_BLOCK_REVIEWER_AGENT_CONFIGURATION

// START_BLOCK_SCOPE_RESOLUTION
function resolveWriteScope(
  scopeType: unknown,
  scopeKey: unknown,
  sessionID: string,
  directory: string,
): MemoryScope {
  const normalizedType = normalizeWriteScopeType(scopeType) ?? "project";

  if (normalizedType === "project") {
    return { scopeType: "project", scopeKey: getDefaultProjectScopeKey() };
  }
  if (normalizedType === "shared") {
    return {
      scopeType: "shared",
      scopeKey:
        typeof scopeKey === "string" && scopeKey.trim()
          ? scopeKey.trim()
          : getDefaultSharedScopeKey(),
    };
  }
  if (normalizedType === "session") {
    return {
      scopeType: "session",
      scopeKey: typeof scopeKey === "string" && scopeKey.trim() ? scopeKey.trim() : sessionID,
    };
  }

  return {
    scopeType: "branch",
    scopeKey:
      typeof scopeKey === "string" && scopeKey.trim()
        ? scopeKey.trim()
        : resolveBranchScopeKey(directory),
  };
}

function getRelevantScopes(sessionID: string, directory: string): MemoryScope[] {
  return [
    resolveWriteScope("session", undefined, sessionID, directory),
    resolveWriteScope("branch", undefined, sessionID, directory),
    resolveWriteScope("project", undefined, sessionID, directory),
    resolveWriteScope("shared", undefined, sessionID, directory),
  ];
}

function resolveReadScopes(
  scopeType: unknown,
  scopeKey: unknown,
  sessionID: string,
  directory: string,
): MemoryScope[] | undefined {
  const normalizedType = normalizeReadScopeType(scopeType);
  if (!normalizedType) {
    return getRelevantScopes(sessionID, directory);
  }
  if (normalizedType === "all") {
    return undefined;
  }

  return [resolveWriteScope(normalizedType, scopeKey, sessionID, directory)];
}
// END_BLOCK_SCOPE_RESOLUTION

// START_BLOCK_MEMORY_OUTPUT_FORMATTING
function formatMemoryEntry(entry: MemoryEntry): string {
  return `- ${entry.id} [${entry.scope_type}:${entry.scope_key}] [${entry.kind}] ${entry.text}`;
}

function formatMemoryEntries(entries: MemoryEntry[]): string {
  return entries.map(formatMemoryEntry).join("\n");
}

function formatMemoryDetails(entry: MemoryEntry): string {
  return JSON.stringify(entry, null, 2);
}

function getMemoryMetadataTitle(action: string, count?: number): string {
  if (typeof count === "number") {
    return `${action} (${count})`;
  }
  return action;
}

function getMemoryConfigWarningLines(memoryConfig: MemoryRuntimeConfig): string[] {
  return memoryConfig.warnings.map((warning) => `- ${warning}`);
}

// END_BLOCK_MEMORY_OUTPUT_FORMATTING

// START_BLOCK_VALIDATE_MEMORY_ENABLED
function assertEnabled(memoryConfig: MemoryRuntimeConfig): void {
  if (!memoryConfig.enabled) {
    throw new Error("vvoc memory is disabled in vvoc.json");
  }
}
// END_BLOCK_VALIDATE_MEMORY_ENABLED

export const MemoryPlugin: Plugin = async ({ client, directory }) => {
  // START_BLOCK_INITIALIZE_MEMORY_PLUGIN
  const memoryConfig = await loadMemoryRuntimeConfig(directory);

  await client.app.log({
    body: {
      service: "memory",
      level: "info",
      message: "memory plugin initialized",
      extra: {
        enabled: memoryConfig.enabled,
        projectStorageRoot: memoryConfig.projectStorageRoot,
        sharedStorageRoot: memoryConfig.sharedStorageRoot,
        defaultSearchLimit: memoryConfig.defaultSearchLimit,
        configSources: memoryConfig.sources,
        configWarnings: memoryConfig.warnings,
      },
    },
  });

  if (!memoryConfig.enabled) {
    return {};
  }

  const metadataWarnings = getMemoryConfigWarningLines(memoryConfig);
  const memoryReviewerPrompt = await loadManagedAgentPromptText(directory, MEMORY_REVIEW_AGENT);
  // END_BLOCK_INITIALIZE_MEMORY_PLUGIN

  return {
    config: async (config) => {
      installMemoryReviewerAgent(
        config,
        memoryReviewerPrompt,
        memoryConfig.reviewerModel,
        memoryConfig.reviewerVariant,
      );
    },
    "experimental.chat.system.transform": async (_input, output) => {
      if (!output.system.includes(MEMORY_SYSTEM_INSTRUCTION)) {
        output.system.push(MEMORY_SYSTEM_INSTRUCTION);
      }
    },
    tool: {
      // START_BLOCK_REGISTER_MEMORY_READ_TOOLS
      memory_search: tool({
        description:
          "Search explicit persistent vvoc memory. Shared scope is global across projects, and session/branch/project scopes are local to the current project. Memory is never preloaded into the prompt.",
        args: {
          query: z.string(),
          scopeType: z.enum(["session", "branch", "project", "shared", "all"]).optional(),
          scopeKey: z.string().optional(),
          kind: z.string().optional(),
          limit: z.number().int().positive().optional(),
        },
        async execute(args, context) {
          assertEnabled(memoryConfig);
          const results = await searchMemories(memoryConfig, args.query, {
            scopes: resolveReadScopes(
              args.scopeType,
              args.scopeKey,
              context.sessionID,
              context.worktree,
            ),
            kind: args.kind,
            limit: args.limit ?? getDefaultSearchLimit(memoryConfig),
          });

          context.metadata({
            title: getMemoryMetadataTitle("Memory Search", results.length),
            metadata: { count: results.length },
          });

          if (results.length === 0) {
            return metadataWarnings.length > 0
              ? [`No matching memory entries found.`, "", ...metadataWarnings].join("\n")
              : "No matching memory entries found.";
          }

          return metadataWarnings.length > 0
            ? [formatMemoryEntries(results), "", "Warnings:", ...metadataWarnings].join("\n")
            : formatMemoryEntries(results);
        },
      }),
      memory_get: tool({
        description: "Load a single explicit memory entry by id from vvoc memory storage.",
        args: {
          id: z.string(),
        },
        async execute(args, context) {
          assertEnabled(memoryConfig);
          const entry = await getMemory(memoryConfig, args.id);
          if (!entry) {
            throw new Error(`Memory not found: ${args.id}`);
          }

          context.metadata({
            title: getMemoryMetadataTitle("Memory Get"),
            metadata: { id: entry.id },
          });

          return formatMemoryDetails(entry);
        },
      }),
      // END_BLOCK_REGISTER_MEMORY_READ_TOOLS
      // START_BLOCK_REGISTER_MEMORY_MUTATION_TOOLS
      memory_put: tool({
        description:
          "Create a new explicit memory entry in session, branch, project, or shared scope. Shared scope is global across projects. Use this deliberately for durable facts, preferences, or procedures.",
        args: {
          text: z.string(),
          kind: z.string().optional(),
          scopeType: z.enum(["session", "branch", "project", "shared"]).optional(),
          scopeKey: z.string().optional(),
          tags: z.array(z.string()).optional(),
          meta: z.record(z.string(), z.unknown()).optional(),
        },
        async execute(args, context) {
          assertEnabled(memoryConfig);
          const scope = resolveWriteScope(
            args.scopeType,
            args.scopeKey,
            context.sessionID,
            context.worktree,
          );
          const entry = await putMemory(memoryConfig, {
            scope_type: scope.scopeType,
            scope_key: scope.scopeKey,
            kind: args.kind,
            text: args.text,
            tags: args.tags,
            meta: args.meta,
          });

          context.metadata({
            title: getMemoryMetadataTitle("Memory Put"),
            metadata: { id: entry.id, scopeType: entry.scope_type, scopeKey: entry.scope_key },
          });

          return `Stored memory ${entry.id}`;
        },
      }),
      memory_update: tool({
        description: "Update an existing explicit memory entry by id.",
        args: {
          id: z.string(),
          text: z.string().optional(),
          kind: z.string().optional(),
          tags: z.array(z.string()).optional(),
          meta: z.record(z.string(), z.unknown()).optional(),
        },
        async execute(args, context) {
          assertEnabled(memoryConfig);
          if (
            args.text === undefined &&
            args.kind === undefined &&
            args.tags === undefined &&
            args.meta === undefined
          ) {
            throw new Error("memory_update requires at least one field to change");
          }

          const entry = await updateMemory(memoryConfig, args.id, {
            text: args.text,
            kind: args.kind,
            tags: args.tags,
            meta: args.meta,
          });
          if (!entry) {
            throw new Error(`Memory not found: ${args.id}`);
          }

          context.metadata({
            title: getMemoryMetadataTitle("Memory Update"),
            metadata: { id: entry.id },
          });

          return `Updated memory ${entry.id}`;
        },
      }),
      memory_delete: tool({
        description: "Delete an explicit memory entry by id.",
        args: {
          id: z.string(),
        },
        async execute(args, context) {
          assertEnabled(memoryConfig);
          const entry = await deleteMemory(memoryConfig, args.id);
          if (!entry) {
            throw new Error(`Memory not found: ${args.id}`);
          }

          context.metadata({
            title: getMemoryMetadataTitle("Memory Delete"),
            metadata: { id: entry.id },
          });

          return `Deleted memory ${entry.id}`;
        },
      }),
      // END_BLOCK_REGISTER_MEMORY_MUTATION_TOOLS
      // START_BLOCK_REGISTER_MEMORY_LIST_TOOL
      memory_list: tool({
        description:
          "List explicit persistent memory entries across session, branch, project, or shared scopes. Shared scope is global across projects. Memory is never preloaded into the prompt.",
        args: {
          scopeType: z.enum(["session", "branch", "project", "shared", "all"]).optional(),
          scopeKey: z.string().optional(),
          kind: z.string().optional(),
          limit: z.number().int().positive().optional(),
        },
        async execute(args, context) {
          assertEnabled(memoryConfig);
          const results = await listMemories(memoryConfig, {
            scopes: resolveReadScopes(
              args.scopeType,
              args.scopeKey,
              context.sessionID,
              context.worktree,
            ),
            kind: args.kind,
            limit: args.limit ?? getDefaultSearchLimit(memoryConfig),
          });

          context.metadata({
            title: getMemoryMetadataTitle("Memory List", results.length),
            metadata: { count: results.length },
          });

          return results.length > 0 ? formatMemoryEntries(results) : "No memory entries found.";
        },
      }),
      // END_BLOCK_REGISTER_MEMORY_LIST_TOOL
    },
  };
};
