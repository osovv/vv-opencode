// FILE: src/lib/managed-skills.ts
// VERSION: 0.5.0
// START_MODULE_CONTRACT
//   PURPOSE: Describe vvoc-managed OpenCode skills and load them from bundled templates or scoped vvoc config roots.
//   SCOPE: Managed skill names, skill file path resolution, bundled template loading, and project/global skill lookup.
//   DEPENDS: [node:fs/promises, node:path, src/lib/vvoc-paths.ts]
//   LINKS: [M-CLI-MANAGED-SKILLS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   MANAGED_SKILL_NAMES - Canonical vvoc-managed skill names.
//   ManagedSkillName - Type for vvoc-managed skill names.
//   getManagedSkillFilePath - Resolves the skill file path inside a vvoc skills directory.
//   loadManagedSkillTemplate - Loads the bundled skill template for a managed skill.
//   loadManagedSkillText - Loads a managed skill from project or global vvoc config and errors if neither exists.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.5.0 - Initial module for managed skill file resolution and template loading.]
// END_CHANGE_SUMMARY

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getGlobalVvocDir, getProjectVvocDir, getVvocSkillsDir } from "./vvoc-paths.js";

export const MANAGED_SKILL_NAMES = ["vv-spec", "vv-plan", "vv-review"] as const;

export type ManagedSkillName = (typeof MANAGED_SKILL_NAMES)[number];

export function getManagedSkillFilePath(skillsDirPath: string, name: ManagedSkillName): string {
  return join(skillsDirPath, name, "SKILL.md");
}

export async function loadManagedSkillTemplate(name: ManagedSkillName): Promise<string> {
  const assetUrl = new URL(`../../templates/skills/${name}/SKILL.md`, import.meta.url);
  return readFile(assetUrl, "utf8");
}

export async function loadManagedSkillText(
  directory: string,
  name: ManagedSkillName,
): Promise<string> {
  const candidatePaths = [
    getManagedSkillFilePath(getVvocSkillsDir(getProjectVvocDir(directory)), name),
    getManagedSkillFilePath(getVvocSkillsDir(getGlobalVvocDir()), name),
  ];

  for (const candidatePath of candidatePaths) {
    try {
      return await readFile(candidatePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }

  throw new Error(
    `vvoc managed skill not found for ${name}. Run \`vvoc install\` or \`vvoc sync\`. Checked: ${candidatePaths.join(", ")}`,
  );
}
