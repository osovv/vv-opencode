// FILE: src/lib/config-layers.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Resolve vvoc, OpenCode runtime, and OpenCode TUI config layers for global, project, and effective scopes.
//   SCOPE: Env override handling, ancestor project-root discovery, project write-root selection, global fallback paths, dedicated TUI config selection, singleton runtime vvoc loading, and source metadata.
//   DEPENDS: [node:fs/promises, node:path, src/lib/vvoc-config.ts, src/lib/vvoc-paths.ts]
//   LINKS: [M-CONFIG-LAYERS, M-CLI-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   VVOC_CONFIG_ENV - Environment variable name for explicit vvoc config selection.
//   OPENCODE_CONFIG_ENV - Environment variable name for explicit OpenCode config selection.
//   OPENCODE_TUI_CONFIG_ENV - Environment variable name for explicit OpenCode TUI config selection.
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
//   resolveOpenCodeTuiConfigSource - Resolves OpenCode TUI source metadata for global, project, or effective reads.
//   resolveConfigWriteTargets - Returns canonical global or project write paths.
//   loadVvocConfigForRead - Loads vvoc config for CLI read/list/show commands without creating files.
//   VvocConfigSnapshot - Immutable runtime vvoc config snapshot plus source metadata.
//   RawOpenCodeModelIntent - Raw root/small_model/agent/command model intent from OpenCode config.
//   readRawOpenCodeModelIntent - Conservatively read raw OpenCode model intent before native normalization.
//   loadVvocConfig - Singleton effective vvoc config load for runtime plugins.
//   loadEffectiveVvocConfig - Uncached effective vvoc config load for multi-location native hosts.
//   loadEffectiveVvocConfigForRuntime - Backward-compatible alias for loadVvocConfig.
//   resetVvocConfigForTests - Clears the runtime singleton for deterministic tests.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-002 - Added an uncached effective loader and a conservative raw OpenCode model-intent reader.]
// END_CHANGE_SUMMARY

import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
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
export const OPENCODE_TUI_CONFIG_ENV = "OPENCODE_TUI_CONFIG";

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

/**
 * Raw OpenCode model intent before native normalization. Native config parsing
 * strips `vv-role:` strings and resolves agents to model refs, so the plugin has
 * to read the raw document to preserve custom agent/command/root/small_model intent.
 */
export type RawOpenCodeModelIntent = {
  readonly model?: string;
  readonly smallModel?: string;
  readonly agents: Readonly<Record<string, string>>;
  readonly commands: Readonly<Record<string, string>>;
  readonly sourcePath?: string;
};

export type ProjectConfigRoot = {
  rootDir: string;
  vvocConfigPath?: string;
  opencodeConfigPath?: string;
  opencodeTuiConfigPath?: string;
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
  opencodeTuiConfigPath: string;
  vvocConfigPath: string;
};

const OPENCODE_CONFIG_FILE_NAMES = ["opencode.json", "opencode.jsonc"] as const;
const OPENCODE_TUI_CONFIG_FILE_NAMES = ["tui.json", "tui.jsonc"] as const;

// START_BLOCK_PROJECT_LAYER_DISCOVERY
export async function findNearestProjectConfigRoot(
  cwd: string,
): Promise<ProjectConfigRoot | undefined> {
  let currentDir = resolve(cwd);

  while (true) {
    const vvocConfigPath = getProjectVvocConfigPath(currentDir);
    const opencodeConfigPath = await findExistingProjectOpenCodeConfigPath(currentDir);
    const opencodeTuiConfigPath = await findExistingProjectOpenCodeTuiConfigPath(currentDir);
    const hasVvocConfig = await pathExists(vvocConfigPath);

    if (hasVvocConfig || opencodeConfigPath || opencodeTuiConfigPath) {
      return {
        rootDir: currentDir,
        vvocConfigPath: hasVvocConfig ? vvocConfigPath : undefined,
        opencodeConfigPath,
        opencodeTuiConfigPath,
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

export async function resolveOpenCodeTuiConfigSource(
  options: ConfigLayerOptions & { scope: ConfigReadScope },
): Promise<ConfigSource> {
  if (options.scope === "global") {
    return resolveGlobalOpenCodeTuiSource(options.configDir);
  }

  if (options.scope === "project") {
    return resolveProjectOpenCodeTuiSource(options.cwd);
  }

  const envSource = readEnvConfigSource(options.env, OPENCODE_TUI_CONFIG_ENV);
  if (envSource) {
    return envSource;
  }

  const projectSource = await resolveProjectOpenCodeTuiSource(options.cwd);
  if (projectSource.kind === "project") {
    return projectSource;
  }

  return resolveGlobalOpenCodeTuiSource(options.configDir);
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
      opencodeTuiConfigPath: await selectExistingPath(
        OPENCODE_TUI_CONFIG_FILE_NAMES.map((name) => join(opencodeBaseDir, name)),
      ),
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
    opencodeTuiConfigPath:
      (await findExistingProjectOpenCodeTuiConfigPath(projectRoot)) ??
      join(opencodeBaseDir, "tui.json"),
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

/**
 * Load the effective vvoc config without the startup singleton. Native hosts
 * serve several locations in one process, so a keyed cache would reject the
 * second project; the snapshot engine resolves policy per directory instead.
 */
export function loadEffectiveVvocConfig(
  options: LoadVvocConfigOptions = {},
): Promise<VvocConfigSnapshot> {
  const cwd = resolve(options.cwd ?? process.cwd());
  return _doLoadVvocConfig(options, {
    cwd,
    configDir: normalizeOptionalSignatureValue(options.configDir),
  });
}

// START_BLOCK_RAW_OPENCODE_INTENT
function collectRawModelEntries(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const model = (entry as Record<string, unknown>).model;
    if (typeof model === "string") entries[name] = model;
  }
  return entries;
}

/**
 * Conservatively read the raw effective OpenCode config so custom agent and
 * command model intent (including `vv-role:` strings) survives native
 * normalization. Invalid or missing documents yield undefined so callers can
 * fall back to native state; the reader never throws on user config.
 */
export async function readRawOpenCodeModelIntent(
  cwd: string,
): Promise<RawOpenCodeModelIntent | undefined> {
  let source: ConfigSource;
  try {
    source = await resolveOpenCodeConfigSource({ scope: "effective", cwd });
  } catch {
    return undefined;
  }
  if (source.path === undefined) return undefined;
  let text: string;
  try {
    text = await readFile(source.path, "utf8");
  } catch {
    return undefined;
  }
  const errors: ParseError[] = [];
  const document: unknown = parseJsonc(text, errors, {
    allowTrailingComma: true,
    allowEmptyContent: true,
  });
  if (errors.length > 0 || !document || typeof document !== "object" || Array.isArray(document)) {
    return undefined;
  }
  const record = document as Record<string, unknown>;
  const agents = collectRawModelEntries(record.agent);
  const commands = collectRawModelEntries(record.command);
  if (agents === undefined || commands === undefined) return undefined;
  return {
    ...(typeof record.model === "string" ? { model: record.model } : {}),
    ...(typeof record.small_model === "string" ? { smallModel: record.small_model } : {}),
    agents,
    commands,
    sourcePath: source.path,
  };
}
// END_BLOCK_RAW_OPENCODE_INTENT

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

async function resolveProjectOpenCodeTuiSource(cwd: string): Promise<ConfigSource> {
  const root = await findNearestProjectConfigRoot(cwd);
  if (root?.opencodeTuiConfigPath) {
    return { kind: "project", path: root.opencodeTuiConfigPath, rootDir: root.rootDir };
  }

  return {
    kind: "missing",
    path: root ? join(getProjectOpencodeDir(root.rootDir), "tui.json") : undefined,
    rootDir: root?.rootDir,
    reason: "project OpenCode TUI config missing; run vvoc install --scope project",
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

async function resolveGlobalOpenCodeTuiSource(configDir?: string): Promise<ConfigSource> {
  const baseDir = getGlobalOpencodeDir(configDir);
  const path = await findExistingOpenCodeTuiConfigPath(baseDir);
  return path
    ? { kind: "global", path }
    : {
        kind: "missing",
        path: join(baseDir, "tui.json"),
        reason: "global OpenCode TUI config missing",
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

async function findExistingProjectOpenCodeTuiConfigPath(
  projectRoot: string,
): Promise<string | undefined> {
  return findExistingOpenCodeTuiConfigPath(getProjectOpencodeDir(projectRoot));
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

async function findExistingOpenCodeTuiConfigPath(baseDir: string): Promise<string | undefined> {
  for (const name of OPENCODE_TUI_CONFIG_FILE_NAMES) {
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
