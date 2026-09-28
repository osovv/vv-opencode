// FILE: src/lib/config-layers.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Resolve vvoc and native OpenCode config layers for global, project, and effective scopes.
//   SCOPE: Env override handling, ancestor project-root discovery, project write-root selection, global fallback paths, singleton runtime vvoc loading, native modelIntent intent extraction, and source metadata.
//   DEPENDS: [node:fs/promises, node:path, src/lib/vvoc-config.ts, src/lib/vvoc-paths.ts, src/lib/package.ts]
//   LINKS: [M-CONFIG-LAYERS, M-CLI-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   VVOC_CONFIG_ENV - Environment variable name for explicit vvoc config selection.
//   OPENCODE_CONFIG_ENV - Environment variable name for explicit OpenCode config selection.
//   OPENCODE_CONFIG_DIR_ENV - Native environment variable that replaces the global OpenCode root.
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
//   MODEL_INTENT_OPTION_KEY - Option key on the vvoc plugins entry carrying role intent.
//   RawOpenCodeModelIntent - Raw root/agent/command model intent from the native modelIntent envelope.
//   normalizeNativeModelSelection - Normalizes a native model selection string or struct to provider/model#variant.
//   readRawOpenCodeModelIntent - Conservatively read layered native model intent before native normalization.
//   loadVvocConfig - Singleton effective vvoc config load for runtime plugins.
//   loadEffectiveVvocConfig - Uncached effective vvoc config load for multi-location native hosts.
//   loadEffectiveVvocConfigForRuntime - Backward-compatible alias for loadVvocConfig.
//   resetVvocConfigForTests - Clears the runtime singleton for deterministic tests.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-007 - Removed the dedicated TUI config layer and re-pointed the raw intent reader at the native vvoc plugins modelIntent envelope.]
// END_CHANGE_SUMMARY

import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { createDefaultVvocConfig, parseVvocConfigText, type VvocConfig } from "./vvoc-config.js";
import { PACKAGE_NAME } from "./package.js";
import {
  getGlobalOpencodeDir,
  getGlobalVvocConfigPath,
  getGlobalVvocDir,
  getProjectOpencodeDir,
  getProjectVvocConfigPath,
} from "./vvoc-paths.js";

export const VVOC_CONFIG_ENV = "VVOC_CONFIG";
export const OPENCODE_CONFIG_ENV = "OPENCODE_CONFIG";
export const OPENCODE_CONFIG_DIR_ENV = "OPENCODE_CONFIG_DIR";

/** Option key on the vvoc `plugins` entry that carries custom/root/command role intent. */
export const MODEL_INTENT_OPTION_KEY = "modelIntent";

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
/** Normalizes a native model selection string or struct into `provider/model#variant`. */
export function normalizeNativeModelSelection(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.providerID !== "string" || typeof record.model !== "string") return undefined;
  const provider = record.providerID.trim();
  const model = record.model.trim();
  if (!provider || !model) return undefined;
  const variant = typeof record.variant === "string" ? record.variant.trim() : "";
  return variant ? `${provider}/${model}#${variant}` : `${provider}/${model}`;
}

function readEnvelopeString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label}: modelIntent value must be a non-empty string`);
  }
  return value.trim();
}

function readEnvelopeMap(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}: modelIntent map must be an object`);
  }
  const entries: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`${label}: modelIntent.${name} must be a non-empty string`);
    }
    entries[name] = entry.trim();
  }
  return entries;
}

/** Reads the vvoc-owned modelIntent envelope strictly, validating its own shape. */
function readModelIntentEnvelopeStrict(
  document: Record<string, unknown>,
  label: string,
): {
  model?: string;
  smallModel?: string;
  agents: Record<string, string>;
  commands: Record<string, string>;
} {
  const plugins = document.plugins;
  if (!Array.isArray(plugins)) return { agents: {}, commands: {} };
  for (const entry of plugins) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const packageName = record.package;
    if (typeof packageName !== "string" || !isManagedPackageName(packageName)) continue;
    const options = record.options;
    if (options === undefined) continue;
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new Error(`${label}: plugins options must be an object`);
    }
    const envelope = (options as Record<string, unknown>)[MODEL_INTENT_OPTION_KEY];
    if (envelope === undefined) continue;
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
      throw new Error(`${label}: plugins options.${MODEL_INTENT_OPTION_KEY} must be an object`);
    }
    const env = envelope as Record<string, unknown>;
    const intentLabel = `${label}: ${MODEL_INTENT_OPTION_KEY}`;
    return {
      model: readEnvelopeString(env.model, `${intentLabel}.model`),
      smallModel: readEnvelopeString(env.smallModel, `${intentLabel}.smallModel`),
      agents: readEnvelopeMap(env.agents, `${intentLabel}.agents`),
      commands: readEnvelopeMap(env.commands, `${intentLabel}.commands`),
    };
  }
  return { agents: {}, commands: {} };
}

function collectNativeAgentSelections(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const selection = normalizeNativeModelSelection((entry as Record<string, unknown>).model);
    if (selection !== undefined) entries[name] = selection;
  }
  return entries;
}

function isManagedPackageName(value: string): boolean {
  return (
    value === PACKAGE_NAME ||
    value.startsWith(`${PACKAGE_NAME}@`) ||
    value === `${PACKAGE_NAME}/tui` ||
    (value.startsWith(`${PACKAGE_NAME}@`) && value.endsWith("/tui"))
  );
}

type IntentLayer = {
  model?: string;
  smallModel?: string;
  agents: Record<string, string>;
  commands: Record<string, string>;
};

function mergeIntentLayer(target: IntentLayer, layer: IntentLayer): void {
  if (layer.model !== undefined) target.model = layer.model;
  if (layer.smallModel !== undefined) target.smallModel = layer.smallModel;
  Object.assign(target.agents, layer.agents);
  Object.assign(target.commands, layer.commands);
}

function layerFromDocument(document: Record<string, unknown>, label: string): IntentLayer {
  const envelope = readModelIntentEnvelopeStrict(document, label);
  const nativeAgents = collectNativeAgentSelections(document.agents);
  const nativeCommands = collectNativeAgentSelections(document.commands);
  // A native explicit literal in the same document wins over role intent.
  const nativeModel = normalizeNativeModelSelection(document.model);
  return {
    ...(nativeModel !== undefined
      ? { model: nativeModel }
      : envelope.model !== undefined
        ? { model: envelope.model }
        : {}),
    ...(envelope.smallModel !== undefined ? { smallModel: envelope.smallModel } : {}),
    agents: { ...envelope.agents, ...nativeAgents },
    commands: { ...envelope.commands, ...nativeCommands },
  };
}

async function readJsoncDocument(path: string): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
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
  return document as Record<string, unknown>;
}

/** Files loaded from one directory in native name order (jsonc ranks above json). */
async function configFilesInDirectory(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const name of OPENCODE_CONFIG_FILE_NAMES) {
    const candidate = join(directory, name);
    if (await pathExists(candidate)) files.push(candidate);
  }
  return files;
}

/**
 * Ordered native config candidates lowest-to-highest precedence, mirroring the
 * pinned host (core/config/discovery.ts, core/config.ts): global root (replaced
 * by OPENCODE_CONFIG_DIR), explicit OPENCODE_CONFIG document, ancestor direct
 * files, ancestor `.opencode` directories, then OPENCODE_CONFIG_CONTENT.
 */
async function collectNativeIntentCandidates(cwd: string): Promise<string[]> {
  // OPENCODE_CONFIG_DIR replaces the native global root; otherwise XDG config
  // home plus opencode. The global root must not re-enter through the ancestor
  // walk (mirrors the pinned host's ConfigDiscovery.visible filter).
  const globalRoot = resolve(getGlobalOpencodeDir());
  const seen = new Set<string>();
  const candidates: string[] = [];
  const push = async (path: string): Promise<void> => {
    if (seen.has(path)) return;
    seen.add(path);
    candidates.push(path);
  };

  for (const file of await configFilesInDirectory(globalRoot)) await push(file);

  const explicit = process.env.OPENCODE_CONFIG?.trim();
  if (explicit) {
    const explicitPath = resolve(explicit);
    if (await pathExists(explicitPath)) await push(explicitPath);
  }

  const ancestors: string[] = [];
  let current = resolve(cwd);
  while (true) {
    ancestors.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const rootToNearest = [...ancestors].reverse();

  for (const directory of rootToNearest) {
    if (directory === globalRoot) continue;
    for (const file of await configFilesInDirectory(directory)) await push(file);
  }
  for (const directory of rootToNearest) {
    if (directory === globalRoot) continue;
    for (const file of await configFilesInDirectory(join(directory, ".opencode"))) await push(file);
  }

  return candidates;
}

/**
 * Reads the layered native effective model intent so a vvoc role envelope in a
 * lower-precedence document is not lost because a higher-precedence document
 * exists with an unrelated setting. Native higher-precedence explicit
 * selections win. Malformed vvoc-owned intent fails loudly instead of silently
 * falling back; unrelated malformed documents are skipped.
 */
export async function readRawOpenCodeModelIntent(
  cwd: string,
): Promise<RawOpenCodeModelIntent | undefined> {
  let candidates: string[];
  try {
    candidates = await collectNativeIntentCandidates(cwd);
  } catch {
    return undefined;
  }

  const merged: IntentLayer = { agents: {}, commands: {} };
  let sourcePath: string | undefined;
  let sawDocument = false;

  for (const path of candidates) {
    const document = await readJsoncDocument(path);
    if (document === undefined) continue;
    sawDocument = true;
    const layer = layerFromDocument(document, path);
    mergeIntentLayer(merged, layer);
    sourcePath = path;
  }

  const content = process.env.OPENCODE_CONFIG_CONTENT;
  if (typeof content === "string" && content.trim()) {
    const errors: ParseError[] = [];
    const parsed: unknown = parseJsonc(content, errors, {
      allowTrailingComma: true,
      allowEmptyContent: true,
    });
    if (errors.length === 0 && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const layer = layerFromDocument(parsed as Record<string, unknown>, "OPENCODE_CONFIG_CONTENT");
      mergeIntentLayer(merged, layer);
      sourcePath = "OPENCODE_CONFIG_CONTENT";
    }
  }

  if (!sawDocument && sourcePath === undefined) return undefined;

  return {
    ...(merged.model === undefined ? {} : { model: merged.model }),
    ...(merged.smallModel === undefined ? {} : { smallModel: merged.smallModel }),
    agents: merged.agents,
    commands: merged.commands,
    ...(sourcePath === undefined ? {} : { sourcePath }),
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function selectExistingPath(candidates: string[]): Promise<string> {
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}
