// FILE: src/lib/opencode/paths.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Scope-aware native path resolution for OpenCode config, discovered agents/skills, and vvoc config locations.
//   SCOPE: Global/project write-target resolution, native agents/skills directory derivation, alternate config file discovery for opencode.json(c), and the Scope/ResolvedPaths contract shared by every config-mutating zone.
//   DEPENDS: [node:path, src/lib/config-layers.ts, src/lib/vvoc-paths.ts, src/lib/opencode/shared-utils.ts]
//   LINKS: [M-CLI-CONFIG, M-CONFIG-LAYERS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   Scope - Supported installation scopes for vvoc config writes.
//   ResolvedPaths - Scope-aware path bundle for native OpenCode config and vvoc locations.
//   resolvePaths - Resolves native OpenCode config/discovery and vvoc config paths for global/project scopes.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-007 - Replaced the dedicated tui.json(c) paths with native agents/ and skills/ discovery directories.]
// END_CHANGE_SUMMARY

import { join } from "node:path";
import { resolveConfigWriteTargets } from "../config-layers.js";
import { getConfigHome, getVvocSkillsDir } from "../vvoc-paths.js";
import { readOptionalText } from "./shared-utils.js";

const OPENCODE_CONFIG_FILE_NAMES = ["opencode.json", "opencode.jsonc"] as const;

export type Scope = "global" | "project";

export type ResolvedPaths = {
  scope: Scope;
  cwd: string;
  configHome: string;
  projectRoot?: string;
  opencodeBaseDir: string;
  vvocBaseDir: string;
  vvocConfigPath: string;
  /** Native discovered agent markdown directory: `<configRoot>/agents/**`. */
  managedAgentsDirPath: string;
  /** vvoc-owned skills source directory materialized from bundled templates. */
  managedSkillsDirPath: string;
  /** vvoc-owned agent prompt directory (`.vvoc/agents`) used by managed prompt loaders. */
  vvocAgentsDirPath: string;
  /** Native discovered skills directory: `<configRoot>/skills/**`. */
  opencodeSkillsDirPath: string;
  opencodeConfigPath: string;
  opencodeAlternatePaths: string[];
};

// START_BLOCK_RESOLVE_CONFIG_PATHS
export async function resolvePaths(options: {
  scope: Scope;
  cwd: string;
  configDir?: string;
}): Promise<ResolvedPaths> {
  const targets = await resolveConfigWriteTargets(options);
  const configHome = getConfigHome(options.configDir);
  const managedAgentsDirPath = join(targets.opencodeBaseDir, "agents");
  const managedSkillsDirPath = getVvocSkillsDir(targets.vvocBaseDir);
  const opencodeSkillsDirPath = join(targets.opencodeBaseDir, "skills");
  const vvocAgentsDirPath = join(targets.vvocBaseDir, "agents");

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
    opencodeSkillsDirPath,
    vvocAgentsDirPath,
    opencodeConfigPath: targets.opencodeConfigPath,
    opencodeAlternatePaths: await resolveOpenCodeAlternates(
      targets.opencodeBaseDir,
      targets.opencodeConfigPath,
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
