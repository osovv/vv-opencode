// FILE: src/lib/config-layers.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Resolve vvoc and OpenCode config layers for global, project, and effective scopes.
//   SCOPE: Env override handling, ancestor project-root discovery, project write-root selection, global fallback paths, singleton runtime vvoc loading, and source metadata.
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
//   ConfigWriteTargets - Resolved global or project write target paths.
//   ProjectConfigRoot - Nearest project config layer metadata.
//   ConfigLayerOptions - Common layered config resolution inputs.
//   LoadVvocConfigOptions - Optional runtime config inputs accepted by loadVvocConfig.
//   findNearestProjectConfigRoot - Finds the closest ancestor with .vvoc/vvoc.json or .opencode/opencode.json(c).
//   resolveProjectWriteRoot - Selects the project root that project-scope mutations write to.
//   resolveProjectOpenCodeConfigPath - Selects the canonical project .opencode/opencode.json(c) path.
//   resolveVvocConfigSource - Resolves vvoc source metadata for global, project, or effective reads.
//   resolveOpenCodeConfigSource - Resolves OpenCode source metadata for global, project, or effective reads.
//   resolveConfigWriteTargets - Returns canonical global or project write paths.
//   loadVvocConfigForRead - Loads vvoc config for CLI read/list/show commands without creating files.
//   VvocConfigSnapshot - Immutable runtime vvoc config snapshot plus source metadata.
//   loadVvocConfig - Singleton effective vvoc config load for runtime plugins.
//   loadEffectiveVvocConfigForRuntime - Backward-compatible alias for loadVvocConfig.
//   resetVvocConfigForTests - Clears the runtime singleton for deterministic tests.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.1.0 - Replaced keyed runtime memoization with a single loadVvocConfig startup promise shared by all plugins.]
//   LAST_CHANGE: [v1.0.1 - Memoized loadEffectiveVvocConfigForRuntime to eliminate redundant ancestor discovery across multiple plugins during startup.]
//   LAST_CHANGE: [v1.0.0 - Added layered config source discovery, write target resolution, and runtime vvoc loading.]
// END_CHANGE_SUMMARY

import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createDefaultVvocConfig, parseVvocConfigText, type VvocConfig } from "./vvoc-config.js";
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

export type VvocConfigSnapshot = Readonly<{
  config: VvocConfig;
  source: ConfigSource;
  warnings: readonly string[];
  loadedAt: string;
}>;

export type LoadVvocConfigOptions = Partial<ConfigLayerOptions>;

type RuntimeVvocConfigSignature = Readonly<{
  cwd: string;
  configDir?: string;
  vvocConfigEnv?: string;
  xdgConfigHome?: string;
}>;

let runtimeConfigPromise: Promise<VvocConfigSnapshot> | undefined;
let runtimeConfigSignature: RuntimeVvocConfigSignature | undefined;

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

export function loadVvocConfig(options: LoadVvocConfigOptions = {}): Promise<VvocConfigSnapshot> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const signature = createRuntimeSignature(options, cwd);
  if (runtimeConfigPromise) {
    assertSameRuntimeSignature(runtimeConfigSignature, signature);
    return runtimeConfigPromise;
  }

  runtimeConfigSignature = signature;
  runtimeConfigPromise = _doLoadVvocConfig(options, signature);
  return runtimeConfigPromise;
}

export function loadEffectiveVvocConfigForRuntime(
  options: LoadVvocConfigOptions = {},
): Promise<VvocConfigSnapshot> {
  return loadVvocConfig(options);
}

export function resetVvocConfigForTests(): void {
  runtimeConfigPromise = undefined;
  runtimeConfigSignature = undefined;
}

async function _doLoadVvocConfig(
  options: LoadVvocConfigOptions,
  signature: RuntimeVvocConfigSignature,
): Promise<VvocConfigSnapshot> {
  const source = await resolveVvocConfigSource({
    scope: "effective",
    allowDefault: true,
    cwd: signature.cwd,
    configDir: signature.configDir,
    env: options.env,
  });

  if (source.kind === "default") {
    return freezeSnapshot({
      config: createDefaultVvocConfig(),
      source,
      warnings: [],
      loadedAt: new Date().toISOString(),
    });
  }

  if (!source.path) {
    throw new Error(`selected vvoc config source has no path (${source.kind})`);
  }

  const text = await readFile(source.path, "utf8");
  return freezeSnapshot({
    config: parseVvocConfigText(text, source.path),
    source,
    warnings: [],
    loadedAt: new Date().toISOString(),
  });
}
// END_BLOCK_RUNTIME_VVOC_LOADING

function createRuntimeSignature(
  options: LoadVvocConfigOptions,
  cwd: string,
): RuntimeVvocConfigSignature {
  return compactSignature({
    cwd,
    configDir: normalizeOptionalSignatureValue(options.configDir),
    vvocConfigEnv: normalizeOptionalSignatureValue(
      readRuntimeEnvValue(options.env, VVOC_CONFIG_ENV),
    ),
    xdgConfigHome: normalizeOptionalSignatureValue(process.env.XDG_CONFIG_HOME),
  });
}

function readRuntimeEnvValue(env: NodeJS.ProcessEnv | undefined, key: string): string | undefined {
  return env ? env[key] : process.env[key];
}

function normalizeOptionalSignatureValue(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function compactSignature(signature: RuntimeVvocConfigSignature): RuntimeVvocConfigSignature {
  return Object.fromEntries(
    Object.entries(signature).filter(([, value]) => value !== undefined),
  ) as RuntimeVvocConfigSignature;
}

function assertSameRuntimeSignature(
  existing: RuntimeVvocConfigSignature | undefined,
  next: RuntimeVvocConfigSignature,
): void {
  if (existing && JSON.stringify(existing) === JSON.stringify(next)) {
    return;
  }

  throw new Error(
    [
      "VVOC_CONFIG_ALREADY_LOADED: loadVvocConfig was already initialized with a different runtime source.",
      `existing=${JSON.stringify(existing)}`,
      `next=${JSON.stringify(next)}`,
    ].join(" "),
  );
}

function freezeSnapshot(snapshot: {
  config: VvocConfig;
  source: ConfigSource;
  warnings: string[];
  loadedAt: string;
}): VvocConfigSnapshot {
  return deepFreeze(snapshot) as VvocConfigSnapshot;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object") {
    return value;
  }

  for (const propertyValue of Object.values(value as Record<string, unknown>)) {
    deepFreeze(propertyValue);
  }

  return Object.freeze(value);
}

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
