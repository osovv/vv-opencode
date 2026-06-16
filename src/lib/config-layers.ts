// FILE: src/lib/config-layers.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Resolve vvoc and OpenCode config layers for global, project, and effective scopes.
//   SCOPE: Env override handling, ancestor project-root discovery, project write-root selection, global fallback paths, runtime vvoc loading, and source metadata.
//   DEPENDS: [node:fs/promises, node:path, src/lib/vvoc-config.ts, src/lib/vvoc-paths.ts]
//   LINKS: [M-CONFIG-LAYERS, M-CLI-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   VVOC_CONFIG_ENV - Environment variable name for explicit vvoc config selection.
//   OPENCODE_CONFIG_ENV - Environment variable name for explicit OpenCode config selection.
//   ConfigWriteScope - Supported write scopes for mutating commands.
//   ConfigReadScope - Supported read scopes for list/show/diagnostic commands.
//   ConfigSourceKind - Source kind labels for selected config sources.
//   ConfigSource - Metadata describing a selected config source.
//   ProjectConfigRoot - Nearest project config layer metadata.
//   ConfigLayerOptions - Common layered config resolution inputs.
//   findNearestProjectConfigRoot - Finds the closest ancestor with .vvoc/vvoc.json or .opencode/opencode.json(c).
//   resolveProjectWriteRoot - Selects the project root that project-scope mutations write to.
//   resolveProjectOpenCodeConfigPath - Selects the canonical project .opencode/opencode.json(c) path.
//   resolveVvocConfigSource - Resolves vvoc source metadata for global, project, or effective reads.
//   resolveOpenCodeConfigSource - Resolves OpenCode source metadata for global, project, or effective reads.
//   resolveConfigWriteTargets - Returns canonical global or project write paths.
//   loadVvocConfigForRead - Loads vvoc config for CLI read/list/show commands without creating files.
//   loadEffectiveVvocConfigForRuntime - Loads the effective vvoc config for runtime plugins.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Added layered config source discovery, write target resolution, and runtime vvoc loading.]
// END_CHANGE_SUMMARY

import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  createDefaultVvocConfig,
  loadLenientVvocConfigText,
  parseVvocConfigText,
  type VvocConfig,
} from "./vvoc-config.js";
import {
  getGlobalOpencodeDir,
  getGlobalVvocConfigPath,
  getGlobalVvocDir,
  getProjectOpencodeDir,
  getProjectVvocConfigPath,
} from "./vvoc-paths.js";

export const VVOC_CONFIG_ENV = "VVOC_CONFIG";
export const OPENCODE_CONFIG_ENV = "OPENCODE_CONFIG";

export type ConfigWriteScope = "global" | "project";
export type ConfigReadScope = ConfigWriteScope | "effective";
export type ConfigSourceKind = "env" | "project" | "global" | "default" | "missing";

export type ConfigSource = {
  kind: ConfigSourceKind;
  path?: string;
  rootDir?: string;
  reason?: string;
};

export type ProjectConfigRoot = {
  rootDir: string;
  vvocConfigPath?: string;
  opencodeConfigPath?: string;
};

export type ConfigLayerOptions = {
  cwd: string;
  configDir?: string;
  env?: NodeJS.ProcessEnv;
};

export type ConfigWriteTargets = {
  scope: ConfigWriteScope;
  projectRoot?: string;
  opencodeBaseDir: string;
  vvocBaseDir: string;
  opencodeConfigPath: string;
  vvocConfigPath: string;
};

const OPENCODE_CONFIG_FILE_NAMES = ["opencode.json", "opencode.jsonc"] as const;

// START_BLOCK_PROJECT_LAYER_DISCOVERY
export async function findNearestProjectConfigRoot(
  cwd: string,
): Promise<ProjectConfigRoot | undefined> {
  let currentDir = resolve(cwd);

  while (true) {
    const vvocConfigPath = getProjectVvocConfigPath(currentDir);
    const opencodeConfigPath = await findExistingProjectOpenCodeConfigPath(currentDir);
    const hasVvocConfig = await pathExists(vvocConfigPath);

    if (hasVvocConfig || opencodeConfigPath) {
      return {
        rootDir: currentDir,
        vvocConfigPath: hasVvocConfig ? vvocConfigPath : undefined,
        opencodeConfigPath,
      };
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return undefined;
    }
    currentDir = parentDir;
  }
}

export async function resolveProjectWriteRoot(cwd: string): Promise<string> {
  return (await findNearestProjectConfigRoot(cwd))?.rootDir ?? resolve(cwd);
}

export async function resolveProjectOpenCodeConfigPath(projectRoot: string): Promise<string> {
  return (
    (await findExistingProjectOpenCodeConfigPath(projectRoot)) ??
    join(getProjectOpencodeDir(projectRoot), "opencode.json")
  );
}
// END_BLOCK_PROJECT_LAYER_DISCOVERY

// START_BLOCK_SOURCE_RESOLUTION
export async function resolveVvocConfigSource(
  options: ConfigLayerOptions & { scope: ConfigReadScope; allowDefault: boolean },
): Promise<ConfigSource> {
  if (options.scope === "global") {
    return resolveGlobalVvocSource(options.configDir);
  }

  if (options.scope === "project") {
    return resolveProjectVvocSource(options.cwd);
  }

  const envSource = readEnvConfigSource(options.env, VVOC_CONFIG_ENV);
  if (envSource) {
    return envSource;
  }

  const projectSource = await resolveProjectVvocSource(options.cwd);
  if (projectSource.kind === "project") {
    return projectSource;
  }

  const globalSource = await resolveGlobalVvocSource(options.configDir);
  if (globalSource.kind === "global") {
    return globalSource;
  }

  if (options.allowDefault) {
    return { kind: "default", reason: "no vvoc config found" };
  }

  return globalSource.kind === "missing" ? globalSource : projectSource;
}

export async function resolveOpenCodeConfigSource(
  options: ConfigLayerOptions & { scope: ConfigReadScope },
): Promise<ConfigSource> {
  if (options.scope === "global") {
    return resolveGlobalOpenCodeSource(options.configDir);
  }

  if (options.scope === "project") {
    return resolveProjectOpenCodeSource(options.cwd);
  }

  const envSource = readEnvConfigSource(options.env, OPENCODE_CONFIG_ENV);
  if (envSource) {
    return envSource;
  }

  const projectSource = await resolveProjectOpenCodeSource(options.cwd);
  if (projectSource.kind === "project") {
    return projectSource;
  }

  return resolveGlobalOpenCodeSource(options.configDir);
}

export async function resolveConfigWriteTargets(
  options: ConfigLayerOptions & { scope: ConfigWriteScope },
): Promise<ConfigWriteTargets> {
  if (options.scope === "global") {
    const opencodeBaseDir = getGlobalOpencodeDir(options.configDir);
    const opencodeConfigPath = await selectExistingPath(
      OPENCODE_CONFIG_FILE_NAMES.map((name) => join(opencodeBaseDir, name)),
    );
    return {
      scope: "global",
      opencodeBaseDir,
      vvocBaseDir: getGlobalVvocDir(options.configDir),
      opencodeConfigPath,
      vvocConfigPath: getGlobalVvocConfigPath(options.configDir),
    };
  }

  const projectRoot = await resolveProjectWriteRoot(options.cwd);
  const opencodeBaseDir = getProjectOpencodeDir(projectRoot);
  return {
    scope: "project",
    projectRoot,
    opencodeBaseDir,
    vvocBaseDir: dirname(getProjectVvocConfigPath(projectRoot)),
    opencodeConfigPath: await resolveProjectOpenCodeConfigPath(projectRoot),
    vvocConfigPath: getProjectVvocConfigPath(projectRoot),
  };
}
// END_BLOCK_SOURCE_RESOLUTION

// START_BLOCK_RUNTIME_VVOC_LOADING
export async function loadVvocConfigForRead(
  options: ConfigLayerOptions & { scope: ConfigReadScope; allowDefault: boolean },
): Promise<{ config: VvocConfig; source: ConfigSource; warnings: string[] }> {
  const source = await resolveVvocConfigSource(options);
  if (
    source.kind === "default" ||
    (source.kind === "missing" && options.scope === "global" && options.allowDefault)
  ) {
    return {
      config: createDefaultVvocConfig(),
      source: { kind: "default", reason: source.reason },
      warnings: [],
    };
  }

  if (source.kind === "missing") {
    throw new Error(
      source.reason ?? `vvoc config missing${source.path ? ` at ${source.path}` : ""}`,
    );
  }

  if (!source.path) {
    throw new Error(`selected vvoc config source has no path (${source.kind})`);
  }

  return {
    config: parseVvocConfigText(await readFile(source.path, "utf8"), source.path),
    source,
    warnings: [],
  };
}

export async function loadEffectiveVvocConfigForRuntime(
  options: Partial<ConfigLayerOptions> = {},
): Promise<{ config: VvocConfig; source: ConfigSource; warnings: string[] }> {
  const source = await resolveVvocConfigSource({
    scope: "effective",
    allowDefault: true,
    cwd: options.cwd ?? process.cwd(),
    configDir: options.configDir,
    env: options.env,
  });

  if (source.kind === "default") {
    return { config: createDefaultVvocConfig(), source, warnings: [] };
  }

  if (!source.path) {
    throw new Error(`selected vvoc config source has no path (${source.kind})`);
  }

  const text = await readFile(source.path, "utf8");
  if (source.kind === "env" || source.kind === "project") {
    return { config: parseVvocConfigText(text, source.path), source, warnings: [] };
  }

  const warnings: string[] = [];
  const config = loadLenientVvocConfigText(text, source.path, warnings);
  return { config, source, warnings };
}
// END_BLOCK_RUNTIME_VVOC_LOADING

async function resolveProjectVvocSource(cwd: string): Promise<ConfigSource> {
  const root = await findNearestProjectConfigRoot(cwd);
  if (root?.vvocConfigPath) {
    return { kind: "project", path: root.vvocConfigPath, rootDir: root.rootDir };
  }

  return {
    kind: "missing",
    reason: "project vvoc config missing; run vvoc install --scope project",
  };
}

async function resolveProjectOpenCodeSource(cwd: string): Promise<ConfigSource> {
  const root = await findNearestProjectConfigRoot(cwd);
  if (root?.opencodeConfigPath) {
    return { kind: "project", path: root.opencodeConfigPath, rootDir: root.rootDir };
  }

  return {
    kind: "missing",
    reason: "project OpenCode config missing; run vvoc install --scope project",
  };
}

async function resolveGlobalVvocSource(configDir?: string): Promise<ConfigSource> {
  const path = getGlobalVvocConfigPath(configDir);
  return (await pathExists(path))
    ? { kind: "global", path }
    : { kind: "missing", path, reason: "global vvoc config missing" };
}

async function resolveGlobalOpenCodeSource(configDir?: string): Promise<ConfigSource> {
  const baseDir = getGlobalOpencodeDir(configDir);
  const path = await findExistingOpenCodeConfigPath(baseDir);
  return path
    ? { kind: "global", path }
    : {
        kind: "missing",
        path: join(baseDir, "opencode.json"),
        reason: "global OpenCode config missing",
      };
}

function readEnvConfigSource(
  env: NodeJS.ProcessEnv | undefined,
  name: string,
): ConfigSource | undefined {
  const value = env ? env[name] : process.env[name];
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  return { kind: "env", path: resolve(value.trim()), reason: name };
}

async function findExistingProjectOpenCodeConfigPath(
  projectRoot: string,
): Promise<string | undefined> {
  return findExistingOpenCodeConfigPath(getProjectOpencodeDir(projectRoot));
}

async function findExistingOpenCodeConfigPath(baseDir: string): Promise<string | undefined> {
  for (const name of OPENCODE_CONFIG_FILE_NAMES) {
    const candidate = join(baseDir, name);
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function selectExistingPath(candidates: string[]): Promise<string> {
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
