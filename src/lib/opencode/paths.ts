// FILE: src/lib/opencode/paths.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Scope-aware path resolution for OpenCode runtime/TUI and vvoc config locations.
//   SCOPE: Global/project write-target resolution, managed agents/skills directory derivation, alternate config file discovery for opencode.json(c) and tui.json(c), and the Scope/ResolvedPaths contract shared by every config-mutating zone.
//   DEPENDS: [node:path, src/lib/config-layers.ts, src/lib/vvoc-paths.ts, src/lib/opencode/shared-utils.ts]
//   LINKS: [M-CLI-CONFIG, M-CONFIG-LAYERS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   Scope - Supported installation scopes for vvoc config writes.
//   ResolvedPaths - Scope-aware path bundle for OpenCode runtime/TUI and vvoc config locations.
//   resolvePaths - Resolves OpenCode runtime/TUI and vvoc config paths for global/project scopes.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-MODULE-SPLIT - Extracted path resolution and alternate-config discovery from the former src/lib/opencode.ts monolith into this zone module.]
// END_CHANGE_SUMMARY

import { join } from "node:path";
import { resolveConfigWriteTargets } from "../config-layers.js";
import { getConfigHome, getVvocAgentsDir, getVvocSkillsDir } from "../vvoc-paths.js";
import { readOptionalText } from "./shared-utils.js";

const OPENCODE_CONFIG_FILE_NAMES = ["opencode.json", "opencode.jsonc"] as const;
const OPENCODE_TUI_CONFIG_FILE_NAMES = ["tui.json", "tui.jsonc"] as const;

export type Scope = "global" | "project";

export type ResolvedPaths = {
  scope: Scope;
  cwd: string;
  configHome: string;
  projectRoot?: string;
  opencodeBaseDir: string;
  vvocBaseDir: string;
  vvocConfigPath: string;
  managedAgentsDirPath: string;
  managedSkillsDirPath: string;
  opencodeConfigPath: string;
  opencodeAlternatePaths: string[];
  opencodeTuiConfigPath: string;
  opencodeTuiAlternatePaths: string[];
};

// START_BLOCK_RESOLVE_CONFIG_PATHS
export async function resolvePaths(options: {
  scope: Scope;
  cwd: string;
  configDir?: string;
}): Promise<ResolvedPaths> {
  const targets = await resolveConfigWriteTargets(options);
  const configHome = getConfigHome(options.configDir);
  const managedAgentsDirPath = getVvocAgentsDir(targets.vvocBaseDir);
  const managedSkillsDirPath = getVvocSkillsDir(targets.vvocBaseDir);

  return {
    scope: options.scope,
    cwd: options.cwd,
    configHome,
    projectRoot: targets.projectRoot,
    opencodeBaseDir: targets.opencodeBaseDir,
    vvocBaseDir: targets.vvocBaseDir,
    vvocConfigPath: targets.vvocConfigPath,
    managedAgentsDirPath,
    managedSkillsDirPath,
    opencodeConfigPath: targets.opencodeConfigPath,
    opencodeAlternatePaths: await resolveOpenCodeAlternates(
      targets.opencodeBaseDir,
      targets.opencodeConfigPath,
    ),
    opencodeTuiConfigPath: targets.opencodeTuiConfigPath,
    opencodeTuiAlternatePaths: await resolveConfigAlternates(
      targets.opencodeBaseDir,
      targets.opencodeTuiConfigPath,
      OPENCODE_TUI_CONFIG_FILE_NAMES,
    ),
  };
}

async function resolveOpenCodeAlternates(
  opencodeBaseDir: string,
  selectedPath: string,
): Promise<string[]> {
  return resolveConfigAlternates(opencodeBaseDir, selectedPath, OPENCODE_CONFIG_FILE_NAMES);
}

async function resolveConfigAlternates(
  baseDir: string,
  selectedPath: string,
  fileNames: readonly string[],
): Promise<string[]> {
  const alternates: string[] = [];

  for (const candidate of fileNames.map((name) => join(baseDir, name))) {
    if (candidate !== selectedPath && (await readOptionalText(candidate)) !== undefined) {
      alternates.push(candidate);
    }
  }

  return alternates;
}
// END_BLOCK_RESOLVE_CONFIG_PATHS
