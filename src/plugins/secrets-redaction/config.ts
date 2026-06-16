// FILE: src/plugins/secrets-redaction/config.ts
// VERSION: 1.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Load and normalize secrets-redaction settings from the effective vvoc config source with environment variable substitution.
//   SCOPE: effective vvoc config lookup, env substitution, fallback defaults
//   DEPENDS: src/lib/config-layers.ts, src/lib/vvoc-config.ts
//   LINKS: knowledge-graph://plugins/secrets-redaction
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   DEFAULT_CONFIG - Default secrets-redaction section used when vvoc.json is missing or incomplete
//   loadConfig - loads and returns normalized config
//   getConfigCandidates - returns the effective vvoc.json path candidate when one is selected
//   SecretsRedactionConfig - Secrets redaction configuration type.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.2.0 - Loaded secrets-redaction config from the effective vvoc source.]
//   LAST_CHANGE: [v1.1.0 - Switched secrets-redaction config loading to the canonical vvoc.json file.]
// END_CHANGE_SUMMARY

import {
  loadEffectiveVvocConfigForRuntime,
  resolveVvocConfigSource,
} from "../../lib/config-layers.js";
import {
  createDefaultSecretsRedactionConfig,
  type SecretsRedactionConfig,
} from "../../lib/vvoc-config.js";
import { generateFallbackSecret } from "./session.js";

export type { SecretsRedactionConfig };

export const DEFAULT_CONFIG: SecretsRedactionConfig = createDefaultSecretsRedactionConfig();

function substituteEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, varName) => {
    return process.env[varName] ?? "";
  });
}

export async function getConfigCandidates(directory: string): Promise<string[]> {
  const source = await resolveVvocConfigSource({
    scope: "effective",
    cwd: directory,
    allowDefault: false,
  });
  return source.path ? [source.path] : [];
}

export async function loadConfig(directory: string): Promise<{
  config: SecretsRedactionConfig;
  path: string | null;
  warnings: string[];
}> {
  const loaded = await loadEffectiveVvocConfigForRuntime({ cwd: directory });
  const warnings = [...loaded.warnings];
  let finalSecret = substituteEnvVars(loaded.config.secretsRedaction.secret);

  if (!finalSecret) {
    finalSecret = generateFallbackSecret();
    warnings.push(
      `No VVOC_SECRET env var set - using random fallback secret. Secrets will not be reversible across restarts.`,
    );
  }

  if (loaded.source.kind !== "default") {
    return {
      config: { ...loaded.config.secretsRedaction, secret: finalSecret },
      path: loaded.source.path ?? null,
      warnings,
    };
  }

  warnings.push(`No vvoc config found - using secrets-redaction defaults with a random secret.`);

  return {
    config: { ...DEFAULT_CONFIG, secret: finalSecret },
    path: null,
    warnings,
  };
}
