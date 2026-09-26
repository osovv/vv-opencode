// FILE: src/plugins/model-roles/v2.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Resolve vv-role model references through OpenCode v2 replayable agent and model transforms with config-file-driven hot reload.
//   SCOPE: v2 setup only: load the canonical role map for the plugin-load location, rewrite role-referenced agent models inside the agent transform, apply role-referenced top-level model and small_model selections through the model transform default and the built-in title agent, pin each session's model to its role-resolved selection on the first prompt (probe-verified v2 mechanism), watch the project vvoc config and reload both domains on change, and fail closed per reference with a logged error instead of breaking the server.
//   DEPENDS: [@opencode/plugin, src/lib/config-layers.ts, src/lib/model-roles.ts, src/lib/plugin-toggle-config.ts, src/plugins/v2-runtime/setup.ts]
//   LINKS: [M-PLUGIN-MODEL-ROLES, V-M-PLUGIN-MODEL-ROLES, M-MODEL-ROLES, M-PLUGIN-V2-RUNTIME]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   setupModelRolesV2 - Register the role-resolving agent and model transforms with hot reload for one OpenCode v2 plugin context.
//   RoleResolutionState - Captured, replayable inputs for the transforms: role map, default-model reference, and title-model reference.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-MIGRATION T-006 - Ported role resolution onto v2 transforms with restart-free preset switching.]
// END_CHANGE_SUMMARY

import type { Plugin as V2Plugin } from "@opencode/plugin";
import type { V2AdapterContext } from "../v2-runtime/setup.js";
import { loadVvocConfigForRead } from "../../lib/config-layers.js";
import {
  isRoleReference,
  parseModelSelection,
  resolveRoleReference,
} from "../../lib/model-roles.js";
import { isVvocPluginEnabled } from "../../lib/plugin-toggle-config.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// START_BLOCK_ROLE_RESOLUTION_STATE
/**
 * Captured transform inputs. Transforms must stay synchronous and replayable,
 * so every external read happens before registration and is refreshed by the
 * config watcher through domain reload().
 */
export interface RoleResolutionState {
  roleMap: Record<string, string>;
  defaultModelReference: string | undefined;
  titleModelReference: string | undefined;
  /** Raw-config agent model references that v2 normalization strips from the registry. */
  agentRoleReferences: Record<string, string>;
}

interface OpenCodeConfigShape {
  model?: unknown;
  small_model?: unknown;
  agent?: unknown;
  agents?: unknown;
}
// END_BLOCK_ROLE_RESOLUTION_STATE

// START_BLOCK_LOAD_ROLE_RESOLUTION_STATE
/**
 * Load the role map and the raw OpenCode config model references for one
 * location. Unknown roles or unreadable files degrade to an empty state with
 * a logged warning so the transforms stay registered and inert.
 */
async function loadRoleResolutionState(directory: string): Promise<RoleResolutionState> {
  try {
    const read = await loadVvocConfigForRead({
      cwd: directory,
      scope: "effective",
      allowDefault: true,
    });
    if (!isVvocPluginEnabled(read.config, "model-roles")) {
      return {
        roleMap: {},
        defaultModelReference: undefined,
        titleModelReference: undefined,
        agentRoleReferences: {},
      };
    }
    const roleMap: Record<string, string> = {};
    const roles = (read.config as { roles?: unknown }).roles;
    if (roles && typeof roles === "object" && !Array.isArray(roles)) {
      for (const [role, selection] of Object.entries(roles as Record<string, unknown>)) {
        if (typeof selection === "string" && selection.trim()) {
          roleMap[role] = selection.trim();
        }
      }
    }

    let defaultModelReference: string | undefined;
    let titleModelReference: string | undefined;
    const agentRoleReferences: Record<string, string> = {};
    const projectRoot = read.source.rootDir ?? directory;
    for (const name of ["opencode.json", "opencode.jsonc"] as const) {
      let text: string | undefined;
      try {
        text = await readFile(join(projectRoot, name), "utf8");
      } catch {
        continue;
      }
      try {
        const parsed = JSON.parse(text.replace(/^\s*\/\/.*$/gm, "")) as OpenCodeConfigShape;
        if (typeof parsed.model === "string" && isRoleReference(parsed.model)) {
          defaultModelReference = parsed.model;
        }
        if (typeof parsed.small_model === "string" && isRoleReference(parsed.small_model)) {
          titleModelReference = parsed.small_model;
        }
        const agentMaps = [parsed.agent, parsed.agents];
        for (const agentMap of agentMaps) {
          if (!agentMap || typeof agentMap !== "object" || Array.isArray(agentMap)) continue;
          for (const [agentName, entry] of Object.entries(agentMap as Record<string, unknown>)) {
            const model = (entry as { model?: unknown } | undefined)?.model;
            if (typeof model === "string" && isRoleReference(model)) {
              agentRoleReferences[agentName] = model;
            }
          }
        }
        break;
      } catch {
        // Unreadable project config leaves the references unset.
      }
    }

    return { roleMap, defaultModelReference, titleModelReference, agentRoleReferences };
  } catch (error) {
    console.warn(`[vvoc][model-roles] state load failed for ${directory}: ${String(error)}`);
    return {
      roleMap: {},
      defaultModelReference: undefined,
      titleModelReference: undefined,
      agentRoleReferences: {},
    };
  }
}
// END_BLOCK_LOAD_ROLE_RESOLUTION_STATE

// START_BLOCK_RESOLVE_REFERENCE
/**
 * Resolve one role reference against the captured role map, failing closed
 * with a logged error that leaves the caller's field untouched.
 */
function resolveReferenceOrLog(
  reference: string,
  roleMap: Record<string, string>,
  fieldPath: string,
): string | undefined {
  try {
    return resolveRoleReference(reference, roleMap).normalized;
  } catch (error) {
    console.error(
      `[vvoc][model-roles] ${fieldPath} references an invalid role (${reference}): ${String(error)}`,
    );
    return undefined;
  }
}
// END_BLOCK_RESOLVE_REFERENCE

// START_BLOCK_APPLY_AGENT_MODEL
/**
 * Apply one resolved provider/model selection to an agent draft in the v2
 * Agent.Info object shape. The editor schema rejects plain string models, so
 * the selection is parsed and assigned as { providerID, id } with an optional
 * variant suffix split from the model id.
 */
function applyAgentModel(draft: { model?: unknown }, selection: string, fieldPath: string): void {
  try {
    const parsed = parseModelSelection(selection);
    const variantMatch = /^(.+)#(.+)$/.exec(parsed.model);
    (draft as { model?: unknown }).model = variantMatch
      ? { providerID: parsed.provider, id: variantMatch[1], variant: variantMatch[2] }
      : { providerID: parsed.provider, id: parsed.model };
  } catch (error) {
    console.error(
      `[vvoc][model-roles] ${fieldPath} resolved an unparseable model (${selection}): ${String(error)}`,
    );
  }
}
// END_BLOCK_APPLY_AGENT_MODEL

// START_BLOCK_SETUP_MODEL_ROLES_V2
/**
 * Register the role-resolving transforms on the v2 runtime.
 *
 * The v1 startup config hook becomes two replayable transforms plus a config
 * watcher: agent transforms rewrite every role-referenced agent model, the
 * model transform applies role-referenced default and title selections read
 * from the raw project config, and vvoc.json changes reload both domains so
 * preset switching takes effect without restarting the shared server.
 */
export async function setupModelRolesV2(
  adapter: V2AdapterContext,
): Promise<V2Plugin.Cleanup | void> {
  const directory = adapter.ctx.location.directory;
  const state: RoleResolutionState = await loadRoleResolutionState(directory);

  const agentRegistration = await adapter.ctx.agent.transform((editor) => {
    for (const agent of editor.list()) {
      const agentId = String(agent.id);
      const rawReference = state.agentRoleReferences[agentId];
      if (rawReference) {
        const resolved = resolveReferenceOrLog(
          rawReference,
          state.roleMap,
          `agent.${agentId}.model`,
        );
        if (resolved) {
          editor.update(agentId, (draft) => {
            applyAgentModel(draft, resolved, `agent.${agentId}.model`);
          });
          continue;
        }
      }

      const model = (agent as { model?: unknown }).model;
      if (typeof model !== "string" || !isRoleReference(model)) continue;
      const resolved = resolveReferenceOrLog(model, state.roleMap, `agent.${agentId}.model`);
      if (!resolved) continue;
      editor.update(agentId, (draft) => {
        applyAgentModel(draft, resolved, `agent.${agentId}.model`);
      });
    }

    if (state.titleModelReference) {
      const title = editor.list().find((agent) => String(agent.id) === "title");
      if (title) {
        const resolved = resolveReferenceOrLog(
          state.titleModelReference,
          state.roleMap,
          "small_model",
        );
        if (resolved) {
          editor.update(String(title.id), (draft) => {
            applyAgentModel(draft, resolved, "small_model");
          });
        }
      }
    }
  });

  const modelRegistration = await adapter.ctx.model.transform((editor) => {
    if (!state.defaultModelReference) return;
    const resolved = resolveReferenceOrLog(state.defaultModelReference, state.roleMap, "model");
    if (!resolved) return;
    const [providerID, modelID] = resolved.split("/");
    if (!providerID || !modelID) {
      console.error(`[vvoc][model-roles] resolved model is not provider/model shaped: ${resolved}`);
      return;
    }
    editor.default.set(providerID, modelID);
  });

  // START_BLOCK_PROMPT_MODEL_APPLICATION
  // Probe-verified on OpenCode v2.0.18: external plugin agent transforms write
  // a plugin-host registry that config-defined agents and session model
  // selection do not read, so role references also apply through the prompt
  // hook: the first prompt of a session pins that session's model to the
  // role-resolved selection, which both restores the v1 behavior and anchors
  // long-running sessions to the preset they started with. Later prompts keep
  // the pinned selection; new sessions resolve against the current role map,
  // which the config watcher refreshes without a server restart.
  const appliedSessions = new Set<string>();
  const promptRegistration = await adapter.ctx.session.hook("prompt", async (event) => {
    try {
      const sessionID = String(event.sessionID);
      if (appliedSessions.has(sessionID)) return;
      const session = await adapter.ctx.session.get({ sessionID });
      const agent = (session as { agent?: unknown } | undefined)?.agent;
      if (typeof agent !== "string" || !agent) return;
      const reference = state.agentRoleReferences[agent];
      if (!reference) return;
      const resolved = resolveReferenceOrLog(reference, state.roleMap, `agent.${agent}.model`);
      if (!resolved) return;
      const parsed = parseModelSelection(resolved);
      const variantMatch = /^(.+)#(.+)$/.exec(parsed.model);
      await adapter.ctx.session.switchModel({
        sessionID: event.sessionID,
        model: {
          providerID: parsed.provider,
          id: variantMatch ? variantMatch[1] : parsed.model,
          ...(variantMatch ? { variant: variantMatch[2] } : {}),
        },
      });
      appliedSessions.add(sessionID);
    } catch (error) {
      console.warn(`[vvoc][model-roles] prompt model application failed: ${String(error)}`);
    }
  });
  // END_BLOCK_PROMPT_MODEL_APPLICATION

  const stopWatch = await adapter.watchConfig(directory, () => {
    void (async () => {
      const fresh = await loadRoleResolutionState(directory);
      state.roleMap = fresh.roleMap;
      state.defaultModelReference = fresh.defaultModelReference;
      state.titleModelReference = fresh.titleModelReference;
      state.agentRoleReferences = fresh.agentRoleReferences;
      try {
        await adapter.ctx.agent.reload();
        await adapter.ctx.model.reload();
      } catch (error) {
        console.warn(`[vvoc][model-roles] reload after config change failed: ${String(error)}`);
      }
    })();
  });

  return async () => {
    stopWatch();
    await promptRegistration.dispose();
    await agentRegistration.dispose();
    await modelRegistration.dispose();
    await modelRegistration.dispose();
  };
}
// END_BLOCK_SETUP_MODEL_ROLES_V2
