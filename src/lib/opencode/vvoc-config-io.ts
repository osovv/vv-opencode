// FILE: src/lib/opencode/vvoc-config-io.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Strict scoped IO for the canonical vvoc.json config document.
//   SCOPE: Read the canonical vvoc.json when present, create/refresh it with materialized plugin-owned entries (hashline-edit routing, tool-history-compaction, peak-hours, spec-guard), rewrite it preserving valid current values, and merge or replace the guardian section.
//   DEPENDS: [src/lib/vvoc-config.ts, src/lib/plugin-toggle-config.ts, src/lib/opencode/shared-utils.ts, src/lib/opencode/paths.ts]
//   LINKS: [M-CLI-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   readVvocConfig - Loads the canonical vvoc.json document when present.
//   installVvocConfig - Creates or refreshes the canonical vvoc.json document.
//   syncVvocConfig - Rewrites the canonical vvoc.json document while preserving valid current values.
//   writeGuardianConfig - Writes the guardian section into the canonical vvoc.json document.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-MODULE-SPLIT - Extracted canonical vvoc.json IO from the former src/lib/opencode.ts monolith into this zone module.]
// END_CHANGE_SUMMARY

import {
  createDefaultVvocConfig,
  createGuardianConfig,
  parseVvocConfigText,
  type GuardianConfigOverrides,
  type VvocConfig,
} from "../vvoc-config.js";
import {
  materializeHashlineEditEntry,
  materializeToolHistoryCompactionEntry,
  materializePeakHoursEntry,
  materializeSpecGuardEntry,
} from "../plugin-toggle-config.js";
import { readOptionalText, writeResolvedVvocConfig, type WriteResult } from "./shared-utils.js";
import type { ResolvedPaths } from "./paths.js";

// START_BLOCK_VVOC_CONFIG_IO
export async function readVvocConfig(
  paths: Pick<ResolvedPaths, "vvocConfigPath">,
): Promise<VvocConfig | undefined> {
  const currentText = await readOptionalText(paths.vvocConfigPath);
  return currentText ? parseVvocConfigText(currentText, paths.vvocConfigPath) : undefined;
}

export async function installVvocConfig(
  paths: Pick<ResolvedPaths, "vvocConfigPath">,
): Promise<WriteResult> {
  return syncVvocConfig(paths);
}

export async function syncVvocConfig(
  paths: Pick<ResolvedPaths, "vvocConfigPath">,
): Promise<WriteResult> {
  const currentText = await readOptionalText(paths.vvocConfigPath);
  const nextConfig = currentText
    ? parseVvocConfigText(currentText, paths.vvocConfigPath)
    : createDefaultVvocConfig();
  nextConfig.plugins["hashline-edit"] = materializeHashlineEditEntry(
    nextConfig.plugins["hashline-edit"],
  );
  nextConfig.plugins["tool-history-compaction"] = materializeToolHistoryCompactionEntry(
    nextConfig.plugins["tool-history-compaction"],
  );
  nextConfig.plugins["peak-hours"] = materializePeakHoursEntry(nextConfig.plugins["peak-hours"]);
  nextConfig.plugins["spec-guard"] = materializeSpecGuardEntry(nextConfig.plugins["spec-guard"]);
  return writeResolvedVvocConfig(paths.vvocConfigPath, currentText, nextConfig);
}

export async function writeGuardianConfig(
  paths: Pick<ResolvedPaths, "vvocConfigPath">,
  overrides: GuardianConfigOverrides,
  options: { merge?: boolean } = {},
): Promise<WriteResult> {
  const currentText = await readOptionalText(paths.vvocConfigPath);
  const currentConfig = currentText
    ? parseVvocConfigText(currentText, paths.vvocConfigPath)
    : createDefaultVvocConfig();
  const nextConfig: VvocConfig = {
    ...currentConfig,
    guardian: options.merge
      ? createGuardianConfig({ ...currentConfig.guardian, ...overrides })
      : createGuardianConfig(overrides),
  };

  return writeResolvedVvocConfig(paths.vvocConfigPath, currentText, nextConfig);
}
// END_BLOCK_VVOC_CONFIG_IO
