// FILE: src/commands/role.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Manage canonical vvoc model role assignments in global vvoc.json.
//   SCOPE: List, set, and unset role assignments with built-in role protection and normalized model parsing.
//   DEPENDS: [citty, node:fs/promises, src/lib/model-roles.ts, src/lib/opencode.ts, src/lib/vvoc-config.ts]
//   LINKS: [M-CLI-ROLE, M-CLI-COMMANDS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - Role command group.
//   listConfiguredRoles - Returns role assignments with built-ins first.
//   setRoleAssignment - Writes a normalized role assignment to canonical global vvoc.json.
//   unsetRoleAssignment - Removes a custom role assignment from canonical global vvoc.json.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Added vvoc role list/set/unset over canonical v3 roles with built-in role protections.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import { writeFile } from "node:fs/promises";
import { BUILTIN_ROLE_NAMES, parseModelSelection } from "../lib/model-roles.js";
import { readVvocConfig, resolvePaths, syncVvocConfig } from "../lib/opencode.js";
import { renderVvocConfig, type VvocConfig } from "../lib/vvoc-config.js";

const ROLE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

const roleArg = {
  type: "positional" as const,
  required: true,
  description: "Role ID (lowercase letters, digits, and hyphens).",
};

const modelArg = {
  type: "positional" as const,
  required: true,
  description: "Model in provider/model format.",
};

const configDirArg = {
  type: "string" as const,
  description: "Override the global config home.",
};

type ListedRole = {
  roleId: string;
  model: string;
  builtIn: boolean;
};

type RoleWriteResult = {
  action: "updated" | "kept";
  path: string;
};

const roleList = defineCommand({
  meta: {
    name: "list",
    description: "List configured model roles.",
  },
  args: {
    "config-dir": configDirArg,
  },
  async run({ args }) {
    const { config } = await loadGlobalVvocConfig({ configDir: resolveConfigDir(args) });
    const listedRoles = listConfiguredRoles(config.roles);

    console.log("Roles (global):");
    for (const role of listedRoles) {
      console.log(`  ${role.roleId}: ${role.model}`);
    }
  },
});

const roleSet = defineCommand({
  meta: {
    name: "set",
    description: "Set a role assignment.",
  },
  args: {
    role: roleArg,
    model: modelArg,
    "config-dir": configDirArg,
  },
  async run({ args }) {
    const roleId = normalizeRoleId(args.role, "set");
    const modelSelection = parseModelSelection(
      asRequiredString(args.model, "set", "model"),
    ).normalized;
    const result = await setRoleAssignment(roleId, modelSelection, {
      configDir: resolveConfigDir(args),
    });

    console.log(`${result.action}: ${roleId} -> ${modelSelection} (${result.path})`);
  },
});

const roleUnset = defineCommand({
  meta: {
    name: "unset",
    description: "Remove a custom role assignment.",
  },
  args: {
    role: roleArg,
    "config-dir": configDirArg,
  },
  async run({ args }) {
    const roleId = normalizeRoleId(args.role, "unset");
    const result = await unsetRoleAssignment(roleId, {
      configDir: resolveConfigDir(args),
    });

    console.log(`${result.action}: ${roleId} (${result.path})`);
  },
});

export default defineCommand({
  meta: {
    name: "role",
    description: "Manage canonical model role assignments.",
  },
  subCommands: {
    list: roleList,
    set: roleSet,
    unset: roleUnset,
  },
});

export function listConfiguredRoles(roles: Record<string, string>): ListedRole[] {
  const listedRoles: ListedRole[] = [];

  for (const roleId of BUILTIN_ROLE_NAMES) {
    if (typeof roles[roleId] === "string") {
      listedRoles.push({ roleId, model: roles[roleId], builtIn: true });
    }
  }

  const customRoleIds = Object.keys(roles)
    .filter((roleId) => !BUILTIN_ROLE_NAMES.includes(roleId as (typeof BUILTIN_ROLE_NAMES)[number]))
    .sort((left, right) => left.localeCompare(right));

  for (const roleId of customRoleIds) {
    listedRoles.push({ roleId, model: roles[roleId], builtIn: false });
  }

  return listedRoles;
}

export async function setRoleAssignment(
  roleId: string,
  modelSelection: string,
  options: { cwd?: string; configDir?: string } = {},
): Promise<RoleWriteResult> {
  const normalizedRoleId = normalizeRoleId(roleId, "set");
  const normalizedModel = parseModelSelection(modelSelection).normalized;
  const { config, paths } = await loadGlobalVvocConfig(options);

  if (config.roles[normalizedRoleId] === normalizedModel) {
    return { action: "kept", path: paths.vvocConfigPath };
  }

  const nextConfig: VvocConfig = {
    ...config,
    roles: {
      ...config.roles,
      [normalizedRoleId]: normalizedModel,
    },
  };

  await writeFile(paths.vvocConfigPath, renderVvocConfig(nextConfig), "utf8");
  return { action: "updated", path: paths.vvocConfigPath };
}

export async function unsetRoleAssignment(
  roleId: string,
  options: { cwd?: string; configDir?: string } = {},
): Promise<RoleWriteResult> {
  const normalizedRoleId = normalizeRoleId(roleId, "unset");

  if (BUILTIN_ROLE_NAMES.includes(normalizedRoleId as (typeof BUILTIN_ROLE_NAMES)[number])) {
    throw new Error(`cannot unset built-in role: ${normalizedRoleId}`);
  }

  const { config, paths } = await loadGlobalVvocConfig(options);

  if (!Object.hasOwn(config.roles, normalizedRoleId)) {
    return { action: "kept", path: paths.vvocConfigPath };
  }

  const { [normalizedRoleId]: _removed, ...remainingRoles } = config.roles;
  const nextConfig: VvocConfig = {
    ...config,
    roles: remainingRoles,
  };

  await writeFile(paths.vvocConfigPath, renderVvocConfig(nextConfig), "utf8");
  return { action: "updated", path: paths.vvocConfigPath };
}

function normalizeRoleId(value: unknown, action: string): string {
  const roleId = asRequiredString(value, action, "role").trim();
  if (!ROLE_ID_PATTERN.test(roleId)) {
    throw new Error(
      `${action}: invalid role id \`${roleId}\`; expected lowercase letters, digits, and hyphens`,
    );
  }
  return roleId;
}

async function loadGlobalVvocConfig(options: { cwd?: string; configDir?: string }) {
  const paths = await resolvePaths({
    scope: "global",
    cwd: options.cwd ?? process.cwd(),
    configDir: options.configDir,
  });

  await syncVvocConfig(paths);

  const config = await readVvocConfig(paths);
  if (!config) {
    throw new Error(`failed to load vvoc config at ${paths.vvocConfigPath}`);
  }

  return { config, paths };
}

function asRequiredString(value: unknown, action: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${action}: ${field} is required`);
  }
  return value;
}

function resolveConfigDir(args: Record<string, unknown>): string | undefined {
  return typeof args["config-dir"] === "string" ? args["config-dir"] : undefined;
}
