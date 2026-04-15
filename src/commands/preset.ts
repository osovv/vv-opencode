// FILE: src/commands/preset.ts
// VERSION: 0.4.2
// START_MODULE_CONTRACT
//   PURPOSE: List, show, and apply declarative named role presets from canonical vvoc.json.
//   SCOPE: Canonical preset lookup, preset rendering, and role-only preset application against canonical vvoc.json.
//   DEPENDS: [citty, node:fs/promises, src/lib/model-roles.ts, src/lib/opencode.ts, src/lib/vvoc-config.ts]
//   LINKS: [M-CLI-PRESET, M-CLI-CONFIG, M-CLI-COMMANDS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - Preset command group for vvoc.
//   listConfiguredPresets - Returns configured presets in deterministic name order.
//   resolvePreset - Validates a preset name and returns the matching preset.
//   formatPreset - Renders a preset object as JSON for CLI output.
//   applyPreset - Applies a preset by updating only listed canonical role assignments.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.4.0 - Switched preset application to canonical role-only writes and removed legacy scope/OpenCode target mutation behavior.]
//   LAST_CHANGE: [v0.4.1 - Stopped preset flows from running sync rewrites; now bootstrap vvoc.json only when missing and keep existing config sections untouched unless listed roles change.]
//   LAST_CHANGE: [v0.4.2 - Switched existing-file preset flows to strict raw vvoc.json validation and role-only document mutation without preset reseeding side effects.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseModelSelection } from "../lib/model-roles.js";
import { resolvePaths } from "../lib/opencode.js";
import {
  createDefaultVvocConfig,
  renderVvocConfig,
  validateVvocConfigDocument,
  type VvocConfig,
  type VvocPreset,
  type VvocPresets,
} from "../lib/vvoc-config.js";

type ListedPreset = {
  name: string;
  preset: VvocPreset;
};

type AppliedPresetChange = {
  roleId: string;
  model: string;
  action: "updated" | "kept";
};

const commandArg = {
  type: "positional" as const,
  required: false,
  description: "Preset name or one of: list, show.",
};

const presetArg = {
  type: "positional" as const,
  required: false,
  description: "Preset name for `show`.",
};

const configDirArg = {
  type: "string" as const,
  description: "Override the global config home.",
};

export default defineCommand({
  meta: {
    name: "preset",
    description: "List, show, or apply named agent presets from vvoc.json.",
  },
  args: {
    command: commandArg,
    preset: presetArg,
    "config-dir": configDirArg,
  },
  async run({ args }) {
    await runPresetCommand(args);
  },
});

export function listConfiguredPresets(presets: VvocPresets): ListedPreset[] {
  return Object.entries(presets)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, preset]) => ({ name, preset }));
}

export function resolvePreset(
  name: string,
  presets: VvocPresets,
): { name: string; preset: VvocPreset } {
  const presetName = name.trim();
  if (!presetName) {
    throw new Error("preset name required");
  }

  const preset = presets[presetName];
  if (preset) {
    return { name: presetName, preset };
  }

  const available = listConfiguredPresets(presets)
    .map((entry) => entry.name)
    .join(", ");
  throw new Error(`unknown preset: ${presetName}. Available presets: ${available || "<none>"}`);
}

export function formatPreset(_name: string, preset: VvocPreset): string {
  return `${JSON.stringify(preset, null, 2)}\n`;
}

export async function applyPreset(
  presetName: string,
  options: { cwd?: string; configDir?: string } = {},
): Promise<{ name: string; preset: VvocPreset; changes: AppliedPresetChange[]; path: string }> {
  const { config, paths } = await loadGlobalVvocConfig(options);
  const resolved = resolvePreset(presetName, config.presets);
  const entries = Object.entries(resolved.preset.agents);
  const nextRoles: Record<string, string> = { ...config.roles };
  const changes: AppliedPresetChange[] = [];

  for (const [rawRoleId, rawModelSelection] of entries) {
    const roleId = normalizeRoleId(rawRoleId, `preset ${resolved.name}`);
    const model = parseModelSelection(
      normalizePresetModelSelection(rawModelSelection, `preset ${resolved.name} role ${roleId}`),
    ).normalized;
    const action: "updated" | "kept" = nextRoles[roleId] === model ? "kept" : "updated";
    nextRoles[roleId] = model;
    changes.push({ roleId, model, action });
  }

  if (changes.some((change) => change.action === "updated")) {
    const nextConfig = {
      ...config,
      roles: nextRoles,
    };
    await writeFile(paths.vvocConfigPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  }

  return { name: resolved.name, preset: resolved.preset, changes, path: paths.vvocConfigPath };
}

async function listPresets(
  options: { cwd?: string; configDir?: string } = {},
): Promise<ListedPreset[]> {
  return listConfiguredPresets(await readConfiguredPresets(options));
}

async function runPresetCommand(args: Record<string, unknown>): Promise<void> {
  const command = typeof args.command === "string" ? args.command.trim() : "";
  const presetName = typeof args.preset === "string" ? args.preset.trim() : "";
  const configDir = typeof args["config-dir"] === "string" ? args["config-dir"] : undefined;

  if (!command || command === "list") {
    if (presetName) {
      throw new Error(`unexpected extra argument for \`vvoc preset list\`: ${presetName}`);
    }

    const presets = await listPresets({ cwd: process.cwd(), configDir });

    if (presets.length === 0) {
      console.log("No presets configured.");
      return;
    }

    console.log("Available presets:");
    for (const { name, preset } of presets) {
      const description = preset.description ? ` - ${preset.description}` : "";
      const roleCount = Object.keys(preset.agents).length;
      console.log(`  ${name}${description} (${roleCount} role${roleCount === 1 ? "" : "s"})`);
    }
    return;
  }

  if (command === "show") {
    if (!presetName) {
      throw new Error("preset name required for `vvoc preset show <name>`");
    }

    const presets = await readConfiguredPresets({ cwd: process.cwd(), configDir });
    const resolved = resolvePreset(presetName, presets);
    process.stdout.write(formatPreset(resolved.name, resolved.preset));
    return;
  }

  if (presetName) {
    throw new Error(`unexpected extra argument for \`vvoc preset <name>\`: ${presetName}`);
  }

  const applied = await applyPreset(command, {
    cwd: process.cwd(),
    configDir,
  });

  console.log(`Applied preset ${applied.name}:`);
  for (const change of applied.changes) {
    console.log(`  ${change.roleId}: ${change.action} (${change.model})`);
  }
}

async function readConfiguredPresets(
  options: { cwd?: string; configDir?: string } = {},
): Promise<VvocPresets> {
  const { config } = await loadGlobalVvocConfig(options);
  return config.presets;
}

async function loadGlobalVvocConfig(options: { cwd?: string; configDir?: string }) {
  const paths = await resolvePaths({
    scope: "global",
    cwd: options.cwd ?? process.cwd(),
    configDir: options.configDir,
  });

  try {
    const text = await readFile(paths.vvocConfigPath, "utf8");
    return {
      config: parseRawVvocConfigText(text, paths.vvocConfigPath),
      paths,
    };
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  const defaultConfig = createDefaultVvocConfig();
  await mkdir(dirname(paths.vvocConfigPath), { recursive: true });
  await writeFile(paths.vvocConfigPath, renderVvocConfig(defaultConfig), "utf8");
  return { config: defaultConfig, paths };
}

function parseRawVvocConfigText(text: string, label: string): VvocConfig {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label}: invalid JSON`);
  }

  const errors = validateVvocConfigDocument(value);
  if (errors.length > 0) {
    throw new Error(`${label}: ${errors.join("; ")}`);
  }

  return value as VvocConfig;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function normalizeRoleId(roleId: string, context: string): string {
  const normalized = roleId.trim();
  if (!/^[a-z][a-z0-9-]*$/.test(normalized)) {
    throw new Error(
      `${context}: invalid role id \`${roleId}\`; expected lowercase letters, digits, and hyphens`,
    );
  }
  return normalized;
}

function normalizePresetModelSelection(value: unknown, context: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${context}: model selection is required`);
  }
  return value;
}
