// FILE: src/plugins/secrets-redaction/config.ts
// VERSION: 1.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Resolve secrets-redaction settings from the shared startup vvoc config snapshot with environment variable substitution.
//   SCOPE: startup vvoc config snapshot consumption, env substitution, fallback defaults
//   DEPENDS: src/lib/config-layers.ts, src/lib/vvoc-config.ts
//   LINKS: knowledge-graph://plugins/secrets-redaction
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   DEFAULT_CONFIG - Default secrets-redaction section used when vvoc.json is missing or incomplete
//   resolveSecretsRedactionRuntimeConfig - returns normalized config from a loaded vvoc config snapshot
//   loadConfig - backward-compatible wrapper around loadVvocConfig plus resolveSecretsRedactionRuntimeConfig
//   getConfigCandidates - returns the effective vvoc.json path candidate when one is selected
//   SecretsRedactionConfig - Secrets redaction configuration type.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.3.0 - Resolved secrets-redaction settings from the shared startup vvoc config snapshot.]
//   LAST_CHANGE: [v1.2.0 - Loaded secrets-redaction config from the effective vvoc source.]
//   LAST_CHANGE: [v1.1.0 - Switched secrets-redaction config loading to the canonical vvoc.json file.]
// END_CHANGE_SUMMARY

import {
  loadVvocConfig,
  resolveVvocConfigSource,
  type VvocConfigSnapshot,
} from "../../lib/config-layers.js";
import {
  createDefaultSecretsRedactionConfig,
  type SecretsRedactionConfig,
} from "../../lib/vvoc-config.js";
import { generateFallbackSecret } from "./session.js";

export type { SecretsRedactionConfig };

export const DEFAULT_CONFIG: SecretsRedactionConfig = createDefaultSecretsRedactionConfig();

function substituteEnvVars(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, varName) => {
    return env[varName] ?? "";
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

export function resolveSecretsRedactionRuntimeConfig(
  loaded: Pick<VvocConfigSnapshot, "config" | "source" | "warnings">,
  env: NodeJS.ProcessEnv = process.env,
): {
  config: SecretsRedactionConfig;
  path: string | null;
  warnings: string[];
} {
  const warnings = [...loaded.warnings];
  let finalSecret = substituteEnvVars(loaded.config.secretsRedaction.secret, env);

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

export async function loadConfig(
  directory: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  config: SecretsRedactionConfig;
  path: string | null;
  warnings: string[];
}> {
  return resolveSecretsRedactionRuntimeConfig(await loadVvocConfig({ cwd: directory }), env);
}
