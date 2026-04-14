// FILE: src/commands/preset.ts
// VERSION: 0.3.0
// START_MODULE_CONTRACT
//   PURPOSE: List, show, and apply declarative named model-target presets from canonical vvoc.json.
//   SCOPE: Canonical preset lookup, preset rendering, scope-aware preset application, and per-target summary output through existing vvoc and OpenCode write paths.
//   DEPENDS: [citty, src/lib/agent-models.ts, src/lib/managed-agents.ts, src/lib/opencode.ts, src/lib/vvoc-config.ts]
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
//   applyPreset - Applies a preset through the existing vvoc/OpenCode write helpers.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.3.0 - Added variant-aware OpenCode agent preset application while keeping top-level default model fields plain.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import {
  formatAgentModel,
  isConfigurableOpenCodeAgentName,
  isOpenCodeDefaultModelTargetName,
  isSpecialAgentName,
  normalizeModelTargetOverride,
  parseGuardianStyleModelArg,
  parseOpenCodeAgentModelArg,
  type OpenCodeDefaultModelTargetName,
  type SupportedModelTargetName,
} from "../lib/agent-models.js";
import { isManagedOpenCodeAgentName } from "../lib/managed-agents.js";
import {
  describeWriteResult,
  installManagedAgentPrompts,
  readVvocConfig,
  resolvePaths,
  type OpenCodeDefaultModelKey,
  type Scope,
  type WriteResult,
  writeGuardianConfig,
  writeOpenCodeDefaultModel,
  writeManagedAgentModel,
  writeMemoryConfig,
  writeOpenCodeAgentModel,
} from "../lib/opencode.js";
import { type VvocPreset, type VvocPresets } from "../lib/vvoc-config.js";

type ListedPreset = {
  name: string;
  preset: VvocPreset;
};

type AppliedPresetChange = {
  targetName: SupportedModelTargetName;
  model: string;
  result: WriteResult;
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

const scopeArg = {
  type: "enum" as const,
  options: ["global", "project"],
  default: "global",
  description: "Write global or project OpenCode config.",
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
    scope: scopeArg,
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
  options: { cwd?: string; configDir?: string; scope?: Scope } = {},
): Promise<{ name: string; preset: VvocPreset; changes: AppliedPresetChange[] }> {
  const paths = await resolvePaths({
    scope: options.scope ?? "global",
    cwd: options.cwd ?? process.cwd(),
    configDir: options.configDir,
  });
  const presets = await readConfiguredPresets({
    cwd: options.cwd ?? process.cwd(),
    configDir: options.configDir,
  });
  const resolved = resolvePreset(presetName, presets);
  const entries = Object.entries(resolved.preset.agents) as Array<
    [SupportedModelTargetName, string]
  >;

  if (entries.some(([targetName]) => isManagedOpenCodeAgentName(targetName))) {
    await installManagedAgentPrompts(paths, { force: false });
  }

  const changes: AppliedPresetChange[] = [];

  for (const [targetName, configuredValue] of entries) {
    const normalizedValue = normalizeModelTargetOverride(
      targetName,
      configuredValue,
      `preset ${resolved.name} ${targetName}`,
    );

    if (targetName === "guardian") {
      const { model, variant } = parseGuardianStyleModelArg(
        normalizedValue,
        `preset ${resolved.name}`,
      );
      const result = await writeGuardianConfig(paths, { model, variant }, { merge: true });
      changes.push({ targetName, model: formatAgentModel(model, variant), result });
      continue;
    }

    if (targetName === "memory-reviewer") {
      const { model, variant } = parseGuardianStyleModelArg(
        normalizedValue,
        `preset ${resolved.name}`,
      );
      const result = await writeMemoryConfig(
        paths,
        { reviewerModel: model, reviewerVariant: variant },
        { merge: true },
      );
      changes.push({ targetName, model: formatAgentModel(model, variant), result });
      continue;
    }

    if (isOpenCodeDefaultModelTargetName(targetName)) {
      const result = await writeOpenCodeDefaultModel(paths, resolveDefaultModelKey(targetName), {
        model: normalizedValue,
        ensureEntry: true,
      });
      changes.push({ targetName, model: normalizedValue, result });
      continue;
    }

    if (isConfigurableOpenCodeAgentName(targetName)) {
      const { model, variant } = parseOpenCodeAgentModelArg(
        normalizedValue,
        `preset ${resolved.name}`,
      );
      const result = await writeOpenCodeAgentModel(paths, targetName, {
        model,
        variant,
        ensureEntry: true,
      });
      changes.push({ targetName, model: formatAgentModel(model, variant), result });
      continue;
    }

    if (isManagedOpenCodeAgentName(targetName)) {
      const { model, variant } = parseOpenCodeAgentModelArg(
        normalizedValue,
        `preset ${resolved.name}`,
      );
      const result = await writeManagedAgentModel(paths, targetName, {
        model,
        variant,
        ensureEntry: true,
      });
      changes.push({ targetName, model: formatAgentModel(model, variant), result });
      continue;
    }

    if (isSpecialAgentName(targetName)) {
      throw new Error(`unsupported preset target: ${targetName}`);
    }
  }

  return { name: resolved.name, preset: resolved.preset, changes };
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
      const targetCount = Object.keys(preset.agents).length;
      console.log(`  ${name}${description} (${targetCount} target${targetCount === 1 ? "" : "s"})`);
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

  const scope = resolveScope(args.scope);
  const applied = await applyPreset(command, {
    cwd: process.cwd(),
    configDir,
    scope,
  });

  console.log(`Applied preset ${applied.name} (${scope}):`);
  for (const change of applied.changes) {
    console.log(`  ${change.targetName}: ${describeWriteResult(change.result)} (${change.model})`);
  }
}

async function readConfiguredPresets(
  options: { cwd?: string; configDir?: string } = {},
): Promise<VvocPresets> {
  const paths = await resolvePaths({
    scope: "global",
    cwd: options.cwd ?? process.cwd(),
    configDir: options.configDir,
  });
  const config = await readVvocConfig(paths);

  if (!config) {
    throw new Error(
      `vvoc config is missing at ${paths.vvocConfigPath}. Run \`vvoc install\` or \`vvoc sync\`.`,
    );
  }

  return config.presets;
}

function resolveScope(value: unknown): Scope {
  return value === "project" ? "project" : "global";
}

function resolveDefaultModelKey(
  targetName: OpenCodeDefaultModelTargetName,
): OpenCodeDefaultModelKey {
  return targetName === "default" ? "model" : "small_model";
}
