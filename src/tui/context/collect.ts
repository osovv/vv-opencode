// FILE: src/tui/context/collect.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Collect bounded observable session, skill, agent, tool, model, and MCP data from the OpenCode TUI API.
//   SCOPE: Active session snapshots, safe SDK lookups, provider/model limit resolution, and bounded warning capture.
//   DEPENDS: [@opencode-ai/plugin/tui, @opencode-ai/sdk/v2, src/tui/context/analyze.ts, src/tui/context/types.ts]
//   LINKS: [M-PLUGIN-CONTEXT-TUI, DF-CONTEXT-INSPECTION, V-M-PLUGIN-CONTEXT-TUI]
//   ROLE: INTEGRATION
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   collectContextAnalysis - Read current TUI state and SDK catalogs, then invoke the pure analyzer.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-CONTEXT-TUI-PLUGIN - Added fail-soft OpenCode TUI context collection.]
// END_CHANGE_SUMMARY

import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { Agent, ToolListItem } from "@opencode-ai/sdk/v2";
import { analyzeContext } from "./analyze.js";
import type { ContextAnalysis, ContextSkill } from "./types.js";

// START_BLOCK_CONTEXT_COLLECTION
export async function collectContextAnalysis(
  api: TuiPluginApi,
  sessionID: string,
): Promise<ContextAnalysis> {
  const messages = [...api.state.session.messages(sessionID)];
  const parts = messages.flatMap((message) => [...api.state.part(message.id)]);
  const warnings: string[] = [];
  const directory = api.state.path.directory;
  const modelRef = resolveModelReference(messages);

  const [agents, skills, tools] = await Promise.all([
    readCatalog<Agent[]>("agents", () => api.client.app.agents({ directory }), [], warnings),
    readCatalog<ContextSkill[]>("skills", () => api.client.app.skills({ directory }), [], warnings),
    modelRef
      ? readCatalog<ToolListItem[]>(
          "tool schemas",
          () =>
            api.client.tool.list({
              directory,
              provider: modelRef.providerID,
              model: modelRef.modelID,
            }),
          [],
          warnings,
        )
      : Promise.resolve([]),
  ]);

  const provider = modelRef
    ? api.state.provider.find((candidate) => candidate.id === modelRef.providerID)
    : undefined;
  const model = modelRef ? provider?.models[modelRef.modelID] : undefined;

  return analyzeContext({
    sessionID,
    messages,
    parts,
    agents,
    skills,
    tools,
    mcpServers: api.state.mcp().map((server) => ({
      name: server.name,
      status: server.status,
      error: server.error,
    })),
    model: modelRef
      ? {
          providerID: modelRef.providerID,
          modelID: modelRef.modelID,
          name: model?.name,
          contextLimit: model?.limit.context,
          outputLimit: model?.limit.output,
        }
      : undefined,
    warnings,
  });
}
// END_BLOCK_CONTEXT_COLLECTION

type CatalogResponse<T> = Promise<{ data?: T; error?: unknown }>;

async function readCatalog<T>(
  label: string,
  load: () => CatalogResponse<T>,
  fallback: T,
  warnings: string[],
): Promise<T> {
  try {
    const response = await load();
    if (response.data !== undefined) return response.data;
    warnings.push(`${label}: unavailable`);
  } catch (error) {
    warnings.push(`${label}: ${boundedError(error)}`);
  }
  return fallback;
}

function resolveModelReference(messages: ReturnType<TuiPluginApi["state"]["session"]["messages"]>) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === "assistant") {
      return { providerID: message.providerID, modelID: message.modelID };
    }
    return message.model;
  }
  return undefined;
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 160 ? `${message.slice(0, 157)}...` : message;
}
