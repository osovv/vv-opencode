// FILE: src/plugins/web-tools/config.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Resolve the optional vvoc web section into concrete provider choices, explicit Z.AI regions, and credentials for the web tools plugin.
//   SCOPE: Provider defaults, fail-closed Z.AI region resolution, credential resolution with environment precedence over config apiKey fields including ${VAR} placeholder substitution with unset-reference warnings, credential source reporting, and a best-effort git-tracked project-config warning helper.
//   DEPENDS: [src/lib/config-layers.ts, src/lib/vvoc-config.ts, src/lib/env-substitution.ts, node:path]
//   LINKS: [M-WEB-CONFIG, M-PLUGIN-WEB-TOOLS, M-CLI-CONFIG, M-ENV-SUBSTITUTION]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   WebProviderCredential - Resolved credential value plus its source (env or config).
//   ResolvedWebSearchConfig - Resolved search provider, credential locations, and credential.
//   ResolvedWebFetchConfig - Resolved fetch provider, credential locations, and credential.
//   ResolvedWebConfig - Resolved search and fetch configuration plus non-fatal warnings.
//   CommandRunner - Injectable command runner used by the git-tracked warning helper.
//   resolveWebRuntimeConfig - Resolves providers and credentials from a vvoc snapshot and environment.
//   warnIfSecretBearingProjectConfigTracked - Best-effort warning when a tracked project config stores an apiKey.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [direct fix - Resolved ${VAR} env placeholders in web apiKey fields and warned on unset references instead of sending literal placeholder credentials.]
// END_CHANGE_SUMMARY

import { basename, dirname } from "node:path";
import type { ConfigSource, VvocConfigSnapshot } from "../../lib/config-layers.js";
import { resolveEnvPlaceholders } from "../../lib/env-substitution.js";
import type { VvocWebConfig, VvocWebRegion } from "../../lib/vvoc-config.js";

/** A resolved credential. The value must never be logged or printed. */
export type WebProviderCredential = {
  value: string;
  source: "env" | "config";
};

export type ResolvedWebSearchConfig =
  | {
      provider: "exa" | "brave";
      envVar: "EXA_API_KEY" | "BRAVE_API_KEY";
      configField: "web.search.apiKey";
      credential?: WebProviderCredential;
    }
  | {
      provider: "zai";
      region: VvocWebRegion;
      envVar: "ZAI_API_KEY";
      configField: "web.search.apiKey";
      credential?: WebProviderCredential;
    };

export type ResolvedWebFetchConfig = {
  provider: "native" | "spider" | "zai";
  region?: VvocWebRegion;
  envVar?: "SPIDER_API_KEY" | "ZAI_API_KEY";
  configField?: "web.fetch.apiKey";
  credential?: WebProviderCredential;
};

export type ResolvedWebConfig = {
  search: ResolvedWebSearchConfig;
  fetch: ResolvedWebFetchConfig;
  /** Non-fatal diagnostics safe to display; never contain key values. */
  warnings: string[];
};

/** Injectable command runner for testability. Returns the process exit status. */
export type CommandRunner = (cmd: string[], cwd: string) => { status: number };

const SEARCH_ENV_VARS = {
  exa: "EXA_API_KEY",
  brave: "BRAVE_API_KEY",
  zai: "ZAI_API_KEY",
} as const;

// START_BLOCK_CREDENTIAL_RESOLUTION
/**
 * Resolve one credential with canonical-env-over-config precedence.
 * Config values support ${VAR} placeholders resolved from env; placeholders referencing
 * unset or empty variables produce a value-free warning naming the config field and the
 * missing variable names. A config value that substitutes to an empty string yields no
 * credential. The warning never contains credential values.
 */
function resolveCredential(
  envValue: string | undefined,
  configValue: string | undefined,
  env: NodeJS.ProcessEnv,
  configField: string,
): { credential?: WebProviderCredential; warning?: string } {
  if (typeof envValue === "string" && envValue.length > 0) {
    return { credential: { value: envValue, source: "env" } };
  }
  if (typeof configValue !== "string" || configValue.length === 0) {
    return {};
  }
  const resolved = resolveEnvPlaceholders(configValue, env);
  if (resolved.missing.length > 0) {
    return {
      credential:
        resolved.value.length > 0 ? { value: resolved.value, source: "config" } : undefined,
      warning:
        `${configField} references unset or empty environment variable(s): ` +
        `${resolved.missing.join(", ")}; set them in the OpenCode process environment ` +
        "or provide a literal apiKey",
    };
  }
  if (resolved.value.length === 0) {
    return {};
  }
  return { credential: { value: resolved.value, source: "config" } };
}

function requireZaiRegion(value: unknown, field: string): VvocWebRegion {
  if (value === "international" || value === "china") {
    return value;
  }
  throw new Error(`${field} is required when provider is zai`);
}
// END_BLOCK_CREDENTIAL_RESOLUTION

// START_CONTRACT: resolveWebRuntimeConfig
//   PURPOSE: Resolve providers and credentials from the startup vvoc snapshot.
//   INPUTS: { loaded: vvoc snapshot subset with config, source, warnings; env: process environment override }
//   OUTPUTS: { ResolvedWebConfig - providers default to exa and native; environment wins over config apiKey; config apiKey ${VAR} placeholders substitute from env and unset references add value-free warnings }
//   SIDE_EFFECTS: none; missing credentials are not resolution-time errors
//   LINKS: M-PLUGIN-WEB-TOOLS, M-ENV-SUBSTITUTION
// END_CONTRACT: resolveWebRuntimeConfig
export function resolveWebRuntimeConfig(
  loaded: Pick<VvocConfigSnapshot, "config" | "source" | "warnings">,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedWebConfig {
  const web: VvocWebConfig | undefined = loaded.config.web;
  const searchProvider = web?.search?.provider ?? "exa";
  const fetchProvider = web?.fetch?.provider ?? "native";
  const warnings: string[] = [...loaded.warnings];

  const searchCredential = resolveCredential(
    env[SEARCH_ENV_VARS[searchProvider]],
    web?.search?.apiKey,
    env,
    "web.search.apiKey",
  );
  if (searchCredential.warning) {
    warnings.push(searchCredential.warning);
  }

  const search: ResolvedWebSearchConfig =
    searchProvider === "zai"
      ? {
          provider: "zai",
          region: requireZaiRegion(web?.search?.region, "web.search.region"),
          envVar: "ZAI_API_KEY",
          configField: "web.search.apiKey",
          credential: searchCredential.credential,
        }
      : {
          provider: searchProvider,
          envVar: SEARCH_ENV_VARS[searchProvider],
          configField: "web.search.apiKey",
          credential: searchCredential.credential,
        };

  const fetchCredential =
    fetchProvider === "native"
      ? {}
      : resolveCredential(
          env[fetchProvider === "zai" ? "ZAI_API_KEY" : "SPIDER_API_KEY"],
          web?.fetch?.apiKey,
          env,
          "web.fetch.apiKey",
        );
  if (fetchCredential.warning) {
    warnings.push(fetchCredential.warning);
  }

  const fetch: ResolvedWebFetchConfig =
    fetchProvider === "zai"
      ? {
          provider: "zai",
          region: requireZaiRegion(web?.fetch?.region, "web.fetch.region"),
          envVar: "ZAI_API_KEY",
          configField: "web.fetch.apiKey",
          credential: fetchCredential.credential,
        }
      : fetchProvider === "spider"
        ? {
            provider: "spider",
            envVar: "SPIDER_API_KEY",
            configField: "web.fetch.apiKey",
            credential: fetchCredential.credential,
          }
        : { provider: "native" };

  return { search, fetch, warnings };
}

// START_BLOCK_GIT_TRACKED_WARNING
function defaultCommandRunner(cmd: string[], cwd: string): { status: number } {
  try {
    const proc = Bun.spawnSync(cmd, { cwd, stdout: "ignore", stderr: "ignore" });
    return { status: proc.exitCode };
  } catch {
    return { status: 1 };
  }
}

/**
 * Best-effort warning when a project-layer vvoc config file that stores an apiKey is tracked by git.
 * Returns a warning that names the file, or undefined when there is nothing to warn about.
 * Never includes the key value. Git failures are swallowed and produce no warning.
 */
export function warnIfSecretBearingProjectConfigTracked(
  input: Pick<VvocConfigSnapshot, "config" | "source">,
  run: CommandRunner = defaultCommandRunner,
): string | undefined {
  const source: ConfigSource = input.source;
  if (source.kind !== "project") {
    return undefined;
  }
  const hasApiKey = Boolean(input.config.web?.search?.apiKey || input.config.web?.fetch?.apiKey);
  if (!hasApiKey) {
    return undefined;
  }
  const configPath = source.path;
  if (!configPath) {
    return undefined;
  }

  let status = 1;
  try {
    status = run(
      ["git", "ls-files", "--error-unmatch", basename(configPath)],
      dirname(configPath),
    ).status;
  } catch {
    return undefined;
  }
  if (status !== 0) {
    return undefined;
  }

  return (
    `vvoc config ${configPath} stores a web apiKey and is tracked by git; ` +
    "consider moving the key to the global layer or an environment variable."
  );
}
// END_BLOCK_GIT_TRACKED_WARNING
