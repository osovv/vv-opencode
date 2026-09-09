// FILE: src/lib/env-substitution.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Substitute ${VAR} environment placeholders inside vvoc config string values.
//   SCOPE: Replace every ${VAR} occurrence with the process environment value and report referenced variables that are unset or empty.
//   DEPENDS: none
//   LINKS: [M-ENV-SUBSTITUTION, M-WEB-CONFIG, M-PLUGIN-SECRETS-REDACTION]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   EnvPlaceholderResolution - Substituted value plus names of referenced variables that resolve to nothing.
//   resolveEnvPlaceholders - Substitute every ${VAR} occurrence and report unset or empty references.
//   substituteEnvVars - Substitute every ${VAR} occurrence and return only the resulting string.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [direct fix - Extracted the secrets-redaction env placeholder substitution into a shared lib helper with missing-reference reporting for web apiKey resolution.]
// END_CHANGE_SUMMARY

/** Result of placeholder substitution. Missing names never include env values. */
export type EnvPlaceholderResolution = {
  /** Value with every ${VAR} occurrence replaced; unset or empty variables become empty strings. */
  value: string;
  /** Referenced variable names that are unset or empty, in first-reference order, deduplicated. */
  missing: string[];
};

// START_BLOCK_PLACEHOLDER_RESOLUTION
/**
 * Substitute every ${VAR} occurrence in value from env.
 * Variables that are unset or set to an empty string substitute as empty strings and are
 * reported by name so callers can emit credential-safe diagnostics.
 * Strings without placeholders are returned unchanged.
 */
export function resolveEnvPlaceholders(
  value: string,
  env: NodeJS.ProcessEnv,
): EnvPlaceholderResolution {
  const missing: string[] = [];
  const seen = new Set<string>();
  const substituted = value.replace(/\$\{([^}]+)\}/g, (_, varName: string) => {
    const replacement = env[varName];
    if (replacement === undefined || replacement === "") {
      if (!seen.has(varName)) {
        seen.add(varName);
        missing.push(varName);
      }
      return "";
    }
    return replacement;
  });
  return { value: substituted, missing };
}
// END_BLOCK_PLACEHOLDER_RESOLUTION

/** String-only convenience wrapper around resolveEnvPlaceholders. */
export function substituteEnvVars(value: string, env: NodeJS.ProcessEnv): string {
  return resolveEnvPlaceholders(value, env).value;
}
