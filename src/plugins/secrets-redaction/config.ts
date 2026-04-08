// FILE: src/plugins/secrets-redaction/config.ts
// VERSION: 1.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Load and normalize secrets-redaction settings from the canonical vvoc.json file with environment variable substitution.
//   SCOPE: canonical vvoc config lookup, env substitution, fallback defaults
//   DEPENDS: node:fs/promises, src/lib/vvoc-config.ts, src/lib/vvoc-paths.ts
//   LINKS: knowledge-graph://plugins/secrets-redaction
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   DEFAULT_CONFIG - Default secrets-redaction section used when vvoc.json is missing or incomplete
//   loadConfig - loads and returns normalized config
//   getConfigCandidates - returns the canonical vvoc.json path candidate
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.1.0 - Switched secrets-redaction config loading to the canonical vvoc.json file.]
// END_CHANGE_SUMMARY

import { readFile } from "node:fs/promises";
import {
  createDefaultSecretsRedactionConfig,
  loadLenientVvocConfigText,
  type SecretsRedactionConfig,
} from "../../lib/vvoc-config.js";
import { getGlobalVvocConfigPath } from "../../lib/vvoc-paths.js";
import { generateFallbackSecret } from "./session.js";

export type { SecretsRedactionConfig };

export const DEFAULT_CONFIG: SecretsRedactionConfig = createDefaultSecretsRedactionConfig();

function substituteEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, varName) => {
    return process.env[varName] ?? "";
  });
}

export function getConfigCandidates(_directory: string): string[] {
  return [getGlobalVvocConfigPath()];
}

export async function loadConfig(directory: string): Promise<{
  config: SecretsRedactionConfig;
  path: string | null;
  warnings: string[];
}> {
  const candidates = getConfigCandidates(directory);
  const warnings: string[] = [];

  for (const candidate of candidates) {
    try {
      const content = await readFile(candidate, "utf-8");
      const vvocConfig = loadLenientVvocConfigText(content, candidate, warnings);
      let finalSecret = substituteEnvVars(vvocConfig.secretsRedaction.secret);

      if (!finalSecret) {
        finalSecret = generateFallbackSecret();
        warnings.push(
          `No VVOC_SECRET env var set - using random fallback secret. Secrets will not be reversible across restarts.`,
        );
      }

      return {
        config: {
          ...vvocConfig.secretsRedaction,
          secret: finalSecret,
        },
        path: candidate,
        warnings,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }

  const fallbackSecret = generateFallbackSecret();
  warnings.push(`No vvoc config found - using secrets-redaction defaults with a random secret.`);
  warnings.push(
    `Run vvoc sync to create ${getGlobalVvocConfigPath()} and set VVOC_SECRET for persistent redaction.`,
  );

  return {
    config: { ...DEFAULT_CONFIG, secret: fallbackSecret },
    path: null,
    warnings,
  };
}
