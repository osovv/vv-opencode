// FILE: src/plugins/system-context-injection/index.ts
// VERSION: 0.6.0
// START_MODULE_CONTRACT
//   PURPOSE: Inject universal primary guidance, including correctness obligations and evidence discipline for behavior changes, and one startup-resolved concrete orchestration policy into vv-controller without polluting subagent prompts.
//   SCOPE: Universal instructions with correctness obligations, material-assumption discipline, settled-conclusion reopen triggers, false-premise handling, and pressure-versus-evidence distinction; vv-controller policy selection; explore-worker guidance; known subagent filtering; startup vvoc snapshot use; custom subagent tracking; and chat.message injection.
//   DEPENDS: [@opencode-ai/plugin, src/lib/config-layers.ts, src/lib/managed-agents.ts, src/lib/orchestration.ts, src/lib/vvoc-paths.ts, src/plugins/v2-runtime/index.ts]
//   LINKS: [M-PLUGIN-SYSTEM-CONTEXT-INJECTION, M-ORCHESTRATION-PROFILES, M-CLI-MANAGED-AGENTS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SystemContextInjectionPlugin - Injects reusable system guidance into primary sessions while skipping known subagents.
//   default - Dual subpath entrypoint: v2 setup() seam plus v1 server() delegating to the named factory.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-MIGRATION T-001 - Added the dual subpath entrypoint so the plugin loads under OpenCode v1 via server() and v2 via setup(). Prior: DIRECT-FIX refine-thinking-discipline - Added settled-evidence reopen triggers, false-premise handling, pressure-versus-evidence distinction, and test-results-as-evidence wording, while preserving material-assumption discipline, repository-answerable question resolution, and honest uncertainty.]
// END_CHANGE_SUMMARY

import { type Config, type Plugin } from "@opencode-ai/plugin";
import { loadVvocConfig } from "../../lib/config-layers.js";
import { resolveOrchestrationPolicy } from "../../lib/orchestration.js";
import { isVvocPluginEnabled } from "../../lib/plugin-toggle-config.js";
import { existsSync } from "node:fs";
import {
  createKnownSubagentSet,
  getSystemContextsForAgent,
  shouldInjectForAgent,
} from "./agent-contexts.js";
import {
  getGlobalOpencodeSkillsDir,
  getProjectVvocDir,
  getVvocSkillsDir,
} from "../../lib/vvoc-paths.js";

// START_BLOCK_V1_ONLY_HELPERS
type AgentConfigShape = {
  mode?: unknown;
};

function syncConfiguredSubagents(config: Config, knownSubagents: Set<string>): void {
  for (const [name, definition] of Object.entries(config.agent ?? {})) {
    if ((definition as AgentConfigShape | undefined)?.mode === "subagent") {
      knownSubagents.add(name);
    }
  }
}

// START_BLOCK_SYSTEM_CONTEXT_FORMATTING
function hasInjectedContext(existingSystem: string | undefined, context: string): boolean {
  return typeof existingSystem === "string" && existingSystem.includes(context);
}

function appendSystemContexts(
  existingSystem: string | undefined,
  contexts: readonly string[],
): string {
  const parts: string[] = [];

  if (typeof existingSystem === "string" && existingSystem.trim()) {
    parts.push(existingSystem.trim());
  }

  for (const context of contexts) {
    if (!hasInjectedContext(existingSystem, context)) {
      parts.push(context);
    }
  }

  return parts.join("\n\n");
}
// END_BLOCK_SYSTEM_CONTEXT_FORMATTING
// END_BLOCK_V1_ONLY_HELPERS

// START_BLOCK_PLUGIN_ENTRY
export const SystemContextInjectionPlugin: Plugin = async ({ directory }) => {
  const vvoc = await loadVvocConfig({ cwd: directory });
  if (!isVvocPluginEnabled(vvoc.config, "system-context-injection")) return {};
  const policy = resolveOrchestrationPolicy(vvoc.config);
  const knownSubagents = createKnownSubagentSet();
  const projectRoot = vvoc.source.rootDir ?? directory;

  return {
    config: async (config) => {
      syncConfiguredSubagents(config, knownSubagents);
      const configRecord = config as Record<string, unknown>;
      const skills = (configRecord.skills ?? {}) as Record<string, unknown>;
      const skillsPaths = (skills.paths ?? []) as string[];
      const shouldAvoidGlobalSkills = vvoc.source.kind === "project" || vvoc.source.kind === "env";

      if (!shouldAvoidGlobalSkills) {
        // Register the global OpenCode skills directory — vvoc sync creates a symlink there
        const opencodeSkillsDir = getGlobalOpencodeSkillsDir();
        if (!skillsPaths.includes(opencodeSkillsDir)) {
          skills.paths = [...skillsPaths, opencodeSkillsDir];
          configRecord.skills = skills;
        }
      }

      // Register project-local skills dir when it exists
      const projectSkillsDir = getVvocSkillsDir(getProjectVvocDir(projectRoot));
      const currentPaths = (skills.paths ?? []) as string[];
      if (
        vvoc.source.kind !== "default" &&
        existsSync(projectSkillsDir) &&
        !currentPaths.includes(projectSkillsDir)
      ) {
        skills.paths = [...currentPaths, projectSkillsDir];
        configRecord.skills = skills;
      }
    },
    "chat.message": async (_input, output) => {
      if (!shouldInjectForAgent(output.message.agent, knownSubagents)) {
        return;
      }

      output.message.system = appendSystemContexts(
        output.message.system,
        getSystemContextsForAgent(output.message.agent, policy),
      );
    },
  };
};
// END_BLOCK_PLUGIN_ENTRY

// START_BLOCK_DUAL_SUBPATH_ENTRY
import { defineDualPlugin } from "../v2-runtime/index.js";
import { createV2Adapter } from "../v2-runtime/setup.js";
import { setupSystemContextInjectionV2 } from "./v2.js";

export default defineDualPlugin({
  id: "vvoc.system-context-injection",
  v1: SystemContextInjectionPlugin,
  v2: (ctx) => setupSystemContextInjectionV2(createV2Adapter(ctx)),
});
// END_BLOCK_DUAL_SUBPATH_ENTRY
