// FILE: src/plugins/model-roles/index.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Resolve vv-role references in supported OpenCode config model fields during plugin config hooks.
//   SCOPE: Canonical role-map loading, supported field traversal, role reference resolution, structured logging, and explicit failure surfaces.
//   DEPENDS: [@opencode-ai/plugin, node:fs/promises, src/lib/model-roles.ts, src/lib/vvoc-config.ts, src/lib/vvoc-paths.ts]
//   LINKS: [M-PLUGIN-MODEL-ROLES]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ModelRolesPlugin - Resolves vv-role:* references in root, agent, and command model fields at config-hook time.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Added startup config-hook role resolution for supported OpenCode model fields with explicit unknown-role and unsupported-target errors.]
// END_CHANGE_SUMMARY

import { type Config, type Plugin } from "@opencode-ai/plugin";
import { readFile } from "node:fs/promises";
import {
  isRoleReference,
  resolveRoleReference,
  type ModelRolesError,
  type ResolvedRoleSelection,
} from "../../lib/model-roles.js";
import { createDefaultVvocConfig, loadLenientVvocConfigText } from "../../lib/vvoc-config.js";
import { getGlobalVvocConfigPath } from "../../lib/vvoc-paths.js";
import { isPluginEnabled } from "../../lib/plugin-toggle-config.js";

type ModelRolesPluginErrorCode = "UNKNOWN_ROLE" | "INVALID_ROLE_ASSIGNMENT";

type ModelRolesPluginError = Error & {
  code: ModelRolesPluginErrorCode;
  fieldPath: string;
  roleRef?: string;
};

type ConfigShape = Config & {
  model?: unknown;
  small_model?: unknown;
  agent?: Record<string, unknown>;
  command?: Record<string, unknown>;
};

type MutableEntry = Record<string, unknown>;

// START_BLOCK_ERROR_UTILS
function createPluginError(options: {
  code: ModelRolesPluginErrorCode;
  fieldPath: string;
  roleRef?: string;
  message: string;
  cause?: unknown;
}): ModelRolesPluginError {
  const error = new Error(options.message) as ModelRolesPluginError;
  error.code = options.code;
  error.fieldPath = options.fieldPath;
  error.roleRef = options.roleRef;
  if (options.cause !== undefined) {
    (error as Error & { cause?: unknown }).cause = options.cause;
  }
  return error;
}

function toReason(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

function asModelRolesError(error: unknown): ModelRolesError | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const maybeError = error as Partial<ModelRolesError>;
  if (typeof maybeError.code !== "string") {
    return undefined;
  }

  return maybeError as ModelRolesError;
}
// END_BLOCK_ERROR_UTILS

// START_BLOCK_ROLE_MAP_LOADING
async function loadCanonicalRoleMap(): Promise<{
  roleMap: Record<string, string>;
  sources: string[];
  warningCount: number;
}> {
  const configPath = getGlobalVvocConfigPath();
  const text = await readFile(configPath, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  });

  if (!text) {
    return {
      roleMap: createDefaultVvocConfig().roles,
      sources: ["default"],
      warningCount: 0,
    };
  }

  const warnings: string[] = [];
  const config = loadLenientVvocConfigText(text, configPath, warnings);
  return {
    roleMap: config.roles,
    sources: [configPath],
    warningCount: warnings.length,
  };
}
// END_BLOCK_ROLE_MAP_LOADING

// START_BLOCK_RESOLVE_CONFIG_ROLE_REFERENCES
function resolveRoleSelectionOrThrow(
  roleRef: string,
  roleMap: Record<string, string>,
  fieldPath: string,
): ResolvedRoleSelection {
  try {
    return resolveRoleReference(roleRef, roleMap);
  } catch (error) {
    const modelRolesError = asModelRolesError(error);
    if (modelRolesError?.code === "UNKNOWN_ROLE") {
      throw createPluginError({
        code: "UNKNOWN_ROLE",
        fieldPath,
        roleRef,
        message: `UNKNOWN_ROLE: ${fieldPath} references an unknown role (${roleRef})`,
        cause: error,
      });
    }

    throw createPluginError({
      code: "INVALID_ROLE_ASSIGNMENT",
      fieldPath,
      roleRef,
      message: `INVALID_ROLE_ASSIGNMENT: ${fieldPath} resolved an invalid role assignment (${roleRef}): ${toReason(error)}`,
      cause: error,
    });
  }
}

function resolveRootField(
  config: ConfigShape,
  roleMap: Record<string, string>,
  fieldName: "model" | "small_model",
): { fieldPath: string; roleRef: string } | undefined {
  const value = config[fieldName];
  if (typeof value !== "string" || !isRoleReference(value)) {
    return undefined;
  }

  const fieldPath = fieldName;
  const resolved = resolveRoleSelectionOrThrow(value, roleMap, fieldPath);

  config[fieldName] = resolved.normalized;
  return { fieldPath, roleRef: value };
}

function resolveEntryModelField(
  parentName: "agent" | "command",
  entryName: string,
  entry: MutableEntry,
  roleMap: Record<string, string>,
): { fieldPath: string; roleRef: string } | undefined {
  const value = entry.model;
  if (typeof value !== "string" || !isRoleReference(value)) {
    return undefined;
  }

  const fieldPath = `${parentName}.${entryName}.model`;
  const resolved = resolveRoleSelectionOrThrow(value, roleMap, fieldPath);

  entry.model = resolved.normalized;

  return { fieldPath, roleRef: value };
}

function resolveNestedModelFields(
  config: ConfigShape,
  roleMap: Record<string, string>,
): Array<{ fieldPath: string; roleRef: string }> {
  const resolved: Array<{ fieldPath: string; roleRef: string }> = [];

  for (const parentName of ["agent", "command"] as const) {
    const parent = config[parentName];
    if (!parent || typeof parent !== "object" || Array.isArray(parent)) {
      continue;
    }

    for (const [entryName, entry] of Object.entries(parent as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }

      const result = resolveEntryModelField(parentName, entryName, entry as MutableEntry, roleMap);
      if (result) {
        resolved.push(result);
      }
    }
  }

  return resolved;
}
// END_BLOCK_RESOLVE_CONFIG_ROLE_REFERENCES

// START_BLOCK_PLUGIN_ENTRY
export const ModelRolesPlugin: Plugin = async ({ client }) => {
  if (!(await isPluginEnabled("model-roles"))) return {};
  return {
    config: async (config) => {
      const { roleMap, sources, warningCount } = await loadCanonicalRoleMap();

      await client.app.log({
        body: {
          service: "model-roles",
          level: "info",
          message: "[model-roles][config][BLOCK_RESOLVE_CONFIG_ROLE_REFERENCES] role map loaded",
          extra: {
            roleCount: Object.keys(roleMap).length,
            sources,
            warningCount,
          },
        },
      });

      const typedConfig = config as ConfigShape;

      try {
        const resolvedReferences: Array<{ fieldPath: string; roleRef: string }> = [];
        for (const fieldName of ["model", "small_model"] as const) {
          const result = resolveRootField(typedConfig, roleMap, fieldName);
          if (result) {
            resolvedReferences.push(result);
          }
        }

        resolvedReferences.push(...resolveNestedModelFields(typedConfig, roleMap));

        for (const resolved of resolvedReferences) {
          await client.app.log({
            body: {
              service: "model-roles",
              level: "info",
              message:
                "[model-roles][config][BLOCK_RESOLVE_CONFIG_ROLE_REFERENCES] role reference resolved",
              extra: {
                fieldPath: resolved.fieldPath,
                roleRef: resolved.roleRef,
              },
            },
          });
        }
      } catch (error) {
        const typedError = error as Partial<ModelRolesPluginError>;
        if (typedError?.code === "UNKNOWN_ROLE") {
          await client.app.log({
            body: {
              service: "model-roles",
              level: "error",
              message:
                "[model-roles][config][BLOCK_RESOLVE_CONFIG_ROLE_REFERENCES] unknown role reference",
              extra: {
                fieldPath: typedError.fieldPath,
                roleRef: typedError.roleRef,
              },
            },
          });
        }
        throw error;
      }
    },
  };
};
// END_BLOCK_PLUGIN_ENTRY
