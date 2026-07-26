// FILE: src/plugins/web-tools/config.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Resolve the optional vvoc web section into concrete provider choices and credentials for the web tools plugin.
//   SCOPE: Provider defaults, credential resolution with environment precedence over config apiKey fields, credential source reporting, and a best-effort git-tracked project-config warning helper.
//   DEPENDS: [src/lib/config-layers.ts, src/lib/vvoc-config.ts, node:path]
//   LINKS: [M-WEB-CONFIG, M-PLUGIN-WEB-TOOLS, M-CLI-CONFIG]
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
//   LAST_CHANGE: [v1.0.0 - Initial runtime web config and credential resolver for the unified web tools plugin.]
// END_CHANGE_SUMMARY

import { basename, dirname } from "node:path";
import type { ConfigSource, VvocConfigSnapshot } from "../../lib/config-layers.js";
import type { VvocWebConfig } from "../../lib/vvoc-config.js";

/** A resolved credential. The value must never be logged or printed. */
export type WebProviderCredential = {
  value: string;
  source: "env" | "config";
};

export type ResolvedWebSearchConfig = {
  provider: "exa" | "brave";
  /** Environment variable consulted first for this provider. */
  envVar: "EXA_API_KEY" | "BRAVE_API_KEY";
  /** Config field path consulted second, used in actionable errors. */
  configField: "web.search.apiKey";
  /** Absent when neither source provides a value; services fail at execution time. */
  credential?: WebProviderCredential;
};

export type ResolvedWebFetchConfig = {
  provider: "native" | "spider";
  envVar?: "SPIDER_API_KEY";
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

const SEARCH_ENV_VARS = { exa: "EXA_API_KEY", brave: "BRAVE_API_KEY" } as const;

// START_BLOCK_CREDENTIAL_RESOLUTION
function resolveCredential(
  envValue: string | undefined,
  configValue: string | undefined,
): WebProviderCredential | undefined {
  if (typeof envValue === "string" && envValue.length > 0) {
    return { value: envValue, source: "env" };
  }
  if (typeof configValue === "string" && configValue.length > 0) {
    return { value: configValue, source: "config" };
  }
  return undefined;
}
// END_BLOCK_CREDENTIAL_RESOLUTION

// START_CONTRACT: resolveWebRuntimeConfig
//   PURPOSE: Resolve providers and credentials from the startup vvoc snapshot.
//   INPUTS: { loaded: vvoc snapshot subset with config, source, warnings; env: process environment override }
//   OUTPUTS: { ResolvedWebConfig - providers default to exa and native; environment wins over config apiKey }
//   SIDE_EFFECTS: none; missing credentials are not resolution-time errors
//   LINKS: M-PLUGIN-WEB-TOOLS
// END_CONTRACT: resolveWebRuntimeConfig
export function resolveWebRuntimeConfig(
  loaded: Pick<VvocConfigSnapshot, "config" | "source" | "warnings">,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedWebConfig {
  const web: VvocWebConfig | undefined = loaded.config.web;
  const searchProvider = web?.search?.provider ?? "exa";
  const fetchProvider = web?.fetch?.provider ?? "native";

  const searchEnvVar = SEARCH_ENV_VARS[searchProvider];
  const search: ResolvedWebSearchConfig = {
    provider: searchProvider,
    envVar: searchEnvVar,
    configField: "web.search.apiKey",
    credential: resolveCredential(env[searchEnvVar], web?.search?.apiKey),
  };

  const fetch: ResolvedWebFetchConfig =
    fetchProvider === "spider"
      ? {
          provider: "spider",
          envVar: "SPIDER_API_KEY",
          configField: "web.fetch.apiKey",
          credential: resolveCredential(env.SPIDER_API_KEY, web?.fetch?.apiKey),
        }
      : { provider: "native" };

  return { search, fetch, warnings: [...loaded.warnings] };
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
