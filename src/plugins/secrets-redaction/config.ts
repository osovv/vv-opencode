// FILE: src/plugins/secrets-redaction/config.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Loads and validates secrets-redaction config from file system with environment variable substitution.
//   SCOPE: config file lookup, env substitution, default values
//   DEPENDS: node:fs/promises, node:path
//   LINKS: knowledge-graph://plugins/secrets-redaction
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   loadConfig - loads and returns normalized config
//   getConfigCandidates - returns ordered candidate paths
// END_MODULE_MAP

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { generateFallbackSecret } from "./session.js";

export interface SecretsRedactionConfig {
  enabled: boolean;
  secret: string;
  ttlMs: number;
  maxMappings: number;
  patterns: {
    keywords: Array<{ value: string; category?: string }>;
    regex: Array<{ pattern: string; category: string }>;
    builtin: string[];
    exclude: string[];
  };
  debug?: boolean;
}

export const DEFAULT_CONFIG: SecretsRedactionConfig = {
  enabled: true,
  secret: "",
  ttlMs: 3_600_000,
  maxMappings: 10_000,
  patterns: {
    keywords: [],
    regex: [],
    builtin: ["email", "china_phone", "china_id", "uuid", "ipv4", "mac"],
    exclude: [],
  },
  debug: false,
};

const CONFIG_FILE_NAMES = ["secrets-redaction.config.json", "secrets-redaction.config.jsonc"];

function substituteEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, varName) => {
    return process.env[varName] ?? "";
  });
}

function deepClone<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(deepClone) as unknown as T;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = deepClone(v);
  }
  return result as T;
}

function mergeConfig(
  base: SecretsRedactionConfig,
  override: Partial<SecretsRedactionConfig>,
): SecretsRedactionConfig {
  const result = deepClone(base);

  if (override.enabled !== undefined) result.enabled = override.enabled;
  if (override.secret !== undefined) result.secret = override.secret;
  if (override.ttlMs !== undefined) result.ttlMs = override.ttlMs;
  if (override.maxMappings !== undefined) result.maxMappings = override.maxMappings;
  if (override.debug !== undefined) result.debug = override.debug;

  if (override.patterns) {
    if (override.patterns.keywords) result.patterns!.keywords = override.patterns.keywords;
    if (override.patterns.regex) result.patterns!.regex = override.patterns.regex;
    if (override.patterns.builtin) result.patterns!.builtin = override.patterns.builtin;
    if (override.patterns.exclude) result.patterns!.exclude = override.patterns.exclude;
  }

  return result;
}

function parseJsonc(content: string): Record<string, unknown> {
  content = content.replace(/\/\/.*$/gm, "");
  content = content.replace(/\/\*[\s\S]*?\*\//g, "");
  return JSON.parse(content) as Record<string, unknown>;
}

function configFromJson(json: Record<string, unknown>): Partial<SecretsRedactionConfig> {
  const result: Partial<SecretsRedactionConfig> = {};

  if (json.enabled !== undefined) result.enabled = Boolean(json.enabled);
  if (json.secret !== undefined && typeof json.secret === "string") result.secret = json.secret;
  if (json.ttlMs !== undefined) result.ttlMs = Number(json.ttlMs);
  if (json.maxMappings !== undefined) result.maxMappings = Number(json.maxMappings);
  if (json.debug !== undefined) result.debug = Boolean(json.debug);

  if (json.patterns && typeof json.patterns === "object") {
    const p = json.patterns as Record<string, unknown>;
    result.patterns = {
      keywords: [],
      regex: [],
      builtin: [],
      exclude: [],
    };

    if (Array.isArray(p.keywords))
      result.patterns.keywords = p.keywords as SecretsRedactionConfig["patterns"]["keywords"];
    if (Array.isArray(p.regex))
      result.patterns.regex = p.regex as SecretsRedactionConfig["patterns"]["regex"];
    if (Array.isArray(p.builtin)) result.patterns.builtin = p.builtin as string[];
    if (Array.isArray(p.exclude)) result.patterns.exclude = p.exclude as string[];
  }

  return result;
}

export function getConfigCandidates(directory: string): string[] {
  const candidates: string[] = [];

  const envPath = process.env.OPENCODE_SECRETS_REDACTION_CONFIG;
  if (envPath) candidates.push(envPath);

  for (const name of CONFIG_FILE_NAMES) {
    candidates.push(join(directory, name));
    candidates.push(join(directory, ".opencode", name));
    candidates.push(join(directory, ".vvoc", name));
  }

  const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config");
  for (const name of CONFIG_FILE_NAMES) {
    candidates.push(join(xdgConfig, "opencode", name));
    candidates.push(join(xdgConfig, "vvoc", name));
  }

  return candidates;
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
      const json = parseJsonc(content);
      const partial = configFromJson(json);

      let finalSecret = partial.secret ?? DEFAULT_CONFIG.secret;
      if (finalSecret) {
        finalSecret = substituteEnvVars(finalSecret);
      }

      if (!finalSecret) {
        finalSecret = generateFallbackSecret();
        warnings.push(
          `No VVOC_SECRET env var set — using random fallback secret. Secrets won't be reversible across restarts.`,
        );
      }

      const merged = mergeConfig(DEFAULT_CONFIG, { ...partial, secret: finalSecret });

      return { config: merged, path: candidate, warnings };
    } catch {
      // file not found or parse error — continue
    }
  }

  const fallbackSecret = generateFallbackSecret();
  warnings.push(`No secrets-redaction config found — using defaults with random secret.`);
  warnings.push(
    `Set VVOC_SECRET env var and create $XDG_CONFIG_HOME/vvoc/secrets-redaction.config.json for persistent redaction.`,
  );

  return {
    config: { ...DEFAULT_CONFIG, secret: fallbackSecret },
    path: null,
    warnings,
  };
}
