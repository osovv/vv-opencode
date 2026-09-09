// FILE: src/plugins/secrets-redaction/config.ts
// VERSION: 1.4.0
// START_MODULE_CONTRACT
//   PURPOSE: Resolve secrets-redaction settings from the shared startup vvoc config snapshot with environment variable substitution.
//   SCOPE: startup vvoc config snapshot consumption, env substitution, fallback defaults, and exact-value web apiKey keyword rules built from placeholder-resolved values
//   DEPENDS: src/lib/config-layers.ts, src/lib/vvoc-config.ts, src/lib/env-substitution.ts
//   LINKS: [M-PLUGIN-SECRETS-REDACTION, M-ENV-SUBSTITUTION]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   DEFAULT_CONFIG - Default secrets-redaction section used when vvoc.json is missing or incomplete
//   webApiKeyKeywordRules - returns deduplicated exact-value rules for configured web apiKey fields with ${VAR} placeholders resolved
//   resolveSecretsRedactionRuntimeConfig - returns normalized config from a loaded vvoc config snapshot
//   loadConfig - backward-compatible wrapper around loadVvocConfig plus resolveSecretsRedactionRuntimeConfig
//   getConfigCandidates - returns the effective vvoc.json path candidate when one is selected
//   SecretsRedactionConfig - Secrets redaction configuration type.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [direct fix - Built web apiKey redaction rules from placeholder-resolved values via the shared env substitution helper.]
// END_CHANGE_SUMMARY

import {
  loadVvocConfig,
  resolveVvocConfigSource,
  type VvocConfigSnapshot,
} from "../../lib/config-layers.js";
import { substituteEnvVars } from "../../lib/env-substitution.js";
import {
  createDefaultSecretsRedactionConfig,
  type SecretsRedactionConfig,
  type VvocConfig,
} from "../../lib/vvoc-config.js";
import { generateFallbackSecret } from "./session.js";

export type { SecretsRedactionConfig };

export const DEFAULT_CONFIG: SecretsRedactionConfig = createDefaultSecretsRedactionConfig();

/**
 * Exact-value keyword rules for configured web apiKey fields with ${VAR} placeholders
 * resolved from env. Canonical environment credentials are excluded because they never
 * appear in config. Values that resolve to an empty string are skipped.
 */
export function webApiKeyKeywordRules(
  config: VvocConfig,
  env: NodeJS.ProcessEnv = process.env,
): Array<{ value: string; category: "WEB_API_KEY" }> {
  const rules: Array<{ value: string; category: "WEB_API_KEY" }> = [];
  const seen = new Set<string>();
  for (const rawValue of [config.web?.search?.apiKey, config.web?.fetch?.apiKey]) {
    if (typeof rawValue !== "string" || rawValue.length === 0) {
      continue;
    }
    const value = substituteEnvVars(rawValue, env);
    if (value.length === 0 || seen.has(value)) {
      continue;
    }
    seen.add(value);
    rules.push({ value, category: "WEB_API_KEY" });
  }
  return rules;
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
  const configured = loaded.config.secretsRedaction;
  const keywordValues = new Set(configured.patterns.keywords.map((rule) => rule.value));
  const webKeywords = webApiKeyKeywordRules(loaded.config, env).filter(
    (rule) => !keywordValues.has(rule.value),
  );
  const configWithWebKeys: SecretsRedactionConfig = {
    ...configured,
    patterns: {
      ...configured.patterns,
      keywords: [...configured.patterns.keywords, ...webKeywords],
    },
  };

  if (!finalSecret) {
    finalSecret = generateFallbackSecret();
    warnings.push(
      `No VVOC_SECRET env var set - using random fallback secret. Secrets will not be reversible across restarts.`,
    );
  }

  if (loaded.source.kind !== "default") {
    return {
      config: { ...configWithWebKeys, secret: finalSecret },
      path: loaded.source.path ?? null,
      warnings,
    };
  }

  warnings.push(`No vvoc config found - using secrets-redaction defaults with a random secret.`);

  return {
    config: { ...configWithWebKeys, secret: finalSecret },
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
