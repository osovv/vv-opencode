// FILE: src/lib/opencode.ts
// VERSION: 0.2.5
// START_MODULE_CONTRACT
//   PURPOSE: Manage OpenCode plugin registration and vvoc-owned config files.
//   SCOPE: Scope-aware path resolution, pinned plugin writes, Guardian/Memory config rendering and sync, and installation inspection.
//   DEPENDS: [jsonc-parser, node:fs/promises, node:path, src/lib/package.ts, src/lib/vvoc-paths.ts, src/plugins/memory-store.ts]
//   LINKS: [M-CLI-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   CLI_NAME - Canonical vvoc CLI binary name.
//   PACKAGE_NAME - Canonical vvoc npm package name.
//   OPENCODE_SCHEMA_URL - OpenCode config schema URL.
//   Scope - Supported installation scopes for vvoc config writes.
//   ResolvedPaths - Scope-aware path bundle for OpenCode and vvoc config locations.
//   GuardianConfigOverrides - Guardian config override shape parsed from managed JSONC.
//   WriteResult - Result shape returned by managed config write operations.
//   InstallationInspection - Current OpenCode and vvoc installation status snapshot.
//   resolvePaths - Resolves OpenCode and vvoc config paths for global/project scopes.
//   ensurePackageConfigText - Ensures OpenCode config contains the pinned vvoc plugin specifier.
//   parseGuardianConfigText - Parses Guardian config JSONC into typed overrides.
//   renderGuardianConfig - Renders managed Guardian config JSONC.
//   ensurePackageInstalled - Writes the pinned vvoc plugin specifier into OpenCode config.
//   installGuardianConfig - Creates or preserves managed Guardian config.
//   syncGuardianConfig - Rewrites managed Guardian config while preserving current values.
//   writeGuardianConfig - Writes explicit Guardian overrides to managed config.
//   installMemoryConfig - Creates or preserves managed Memory config.
//   syncMemoryConfig - Rewrites managed Memory config while preserving current values.
//   inspectInstallation - Reads current OpenCode/vvoc installation state for status and doctor commands.
//   describeWriteResult - Formats config write outcomes for CLI output.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.2.5 - Added GRACE runtime markup and symbol-accurate export mapping for OpenCode/vvoc config helpers.]
// END_CHANGE_SUMMARY

import { applyEdits, format, modify, parse, type ParseError } from "jsonc-parser";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  parseMemoryConfigText,
  renderMemoryConfig,
  type MemoryConfigOverrides,
} from "../plugins/memory-store.js";
import { getPinnedPackageSpecifier, PACKAGE_NAME } from "./package.js";
import {
  getConfigHome,
  getGlobalOpencodeDir,
  getGlobalVvocDir,
  getProjectVvocDir,
} from "./vvoc-paths.js";

export const CLI_NAME = "vvoc";
export { PACKAGE_NAME };
export const OPENCODE_SCHEMA_URL = "https://opencode.ai/config.json";
const MANAGED_MARKER = "Managed by vvoc";
const DEFAULT_GUARDIAN_TIMEOUT_MS = 90_000;
const DEFAULT_GUARDIAN_APPROVAL_RISK_THRESHOLD = 80;
const GUARDIAN_CONFIG_FILE_NAMES = ["guardian.jsonc", "guardian.json"] as const;
const MEMORY_CONFIG_FILE_NAMES = ["memory.jsonc", "memory.json"] as const;
const OPENCODE_CONFIG_FILE_NAMES = ["opencode.json", "opencode.jsonc"] as const;
const SECRETS_REDACTION_CONFIG_FILE_NAMES = [
  "secrets-redaction.config.json",
  "secrets-redaction.config.jsonc",
] as const;

const JSON_FORMAT = {
  insertSpaces: true,
  tabSize: 2,
  eol: "\n",
} as const;

type JsonObject = Record<string, unknown>;

export type Scope = "global" | "project";

export type ResolvedPaths = {
  scope: Scope;
  cwd: string;
  configHome: string;
  opencodeBaseDir: string;
  vvocBaseDir: string;
  opencodeConfigPath: string;
  opencodeAlternatePaths: string[];
  guardianConfigPath: string;
  guardianAlternatePaths: string[];
  memoryConfigPath: string;
  memoryConfigAlternates: string[];
  secretsRedactionConfigPath: string;
  secretsRedactionConfigAlternates: string[];
};

export type GuardianConfigOverrides = {
  model?: string;
  variant?: string;
  timeoutMs?: number;
  approvalRiskThreshold?: number;
  reviewToastDurationMs?: number;
};

export type WriteResult = {
  action: "created" | "updated" | "kept" | "skipped";
  path: string;
  reason?: string;
};

export type InstallationInspection = {
  scope: Scope;
  opencode: {
    path: string;
    exists: boolean;
    alternates: string[];
    parseError?: string;
    pluginConfigured: boolean;
    plugins: string[];
  };
  guardian: {
    path: string;
    exists: boolean;
    alternates: string[];
    managed: boolean;
    parseError?: string;
    overrides?: GuardianConfigOverrides;
  };
  memory: {
    path: string;
    exists: boolean;
    alternates: string[];
    managed: boolean;
    parseError?: string;
    overrides?: MemoryConfigOverrides;
  };
  secretsRedaction: {
    path: string;
    exists: boolean;
    alternates: string[];
    managed: boolean;
    parseError?: string;
  };
  warnings: string[];
  problems: string[];
};

// START_BLOCK_RESOLVE_CONFIG_PATHS
export async function resolvePaths(options: {
  scope: Scope;
  cwd: string;
  configDir?: string;
}): Promise<ResolvedPaths> {
  const configHome = getConfigHome(options.configDir);
  const opencodeBaseDir =
    options.scope === "global" ? getGlobalOpencodeDir(options.configDir) : options.cwd;
  const vvocBaseDir =
    options.scope === "global"
      ? getGlobalVvocDir(options.configDir)
      : getProjectVvocDir(options.cwd);
  const opencodeSelection = await selectPrimaryPath(
    OPENCODE_CONFIG_FILE_NAMES.map((name) => join(opencodeBaseDir, name)),
  );
  const guardianSelection = await selectPrimaryPath(
    GUARDIAN_CONFIG_FILE_NAMES.map((name) => join(vvocBaseDir, name)),
  );
  const memorySelection = await selectPrimaryPath(
    MEMORY_CONFIG_FILE_NAMES.map((name) => join(vvocBaseDir, name)),
  );
  const secretsRedactionSelection = await selectPrimaryPath(
    SECRETS_REDACTION_CONFIG_FILE_NAMES.map((name) => join(vvocBaseDir, name)),
  );

  return {
    scope: options.scope,
    cwd: options.cwd,
    configHome,
    opencodeBaseDir,
    vvocBaseDir,
    opencodeConfigPath: opencodeSelection.primary,
    opencodeAlternatePaths: opencodeSelection.alternates,
    guardianConfigPath: guardianSelection.primary,
    guardianAlternatePaths: guardianSelection.alternates,
    memoryConfigPath: memorySelection.primary,
    memoryConfigAlternates: memorySelection.alternates,
    secretsRedactionConfigPath: secretsRedactionSelection.primary,
    secretsRedactionConfigAlternates: secretsRedactionSelection.alternates,
  };
}
// END_BLOCK_RESOLVE_CONFIG_PATHS

// START_BLOCK_ENSURE_OPENCODE_PLUGIN_CONFIG
export function ensurePackageConfigText(
  text: string | undefined,
  packageSpecifier = PACKAGE_NAME,
): string {
  if (!text?.trim()) {
    return renderJson({
      $schema: OPENCODE_SCHEMA_URL,
      plugin: [packageSpecifier],
    });
  }

  const document = parseObjectDocument(text, "OpenCode config");
  const currentPlugins = readPluginList(document, "OpenCode config");
  let nextText = text;

  if (!Object.hasOwn(document, "$schema")) {
    nextText = applyEdits(
      nextText,
      modify(nextText, ["$schema"], OPENCODE_SCHEMA_URL, {
        formattingOptions: JSON_FORMAT,
        getInsertionIndex: () => 0,
      }),
    );
  }

  const nextPlugins = normalizePluginList(currentPlugins, packageSpecifier);
  if (JSON.stringify(nextPlugins) !== JSON.stringify(currentPlugins)) {
    nextText = applyEdits(
      nextText,
      modify(nextText, ["plugin"], nextPlugins, {
        formattingOptions: JSON_FORMAT,
      }),
    );
  }

  return ensureTrailingNewline(applyEdits(nextText, format(nextText, undefined, JSON_FORMAT)));
}
// END_BLOCK_ENSURE_OPENCODE_PLUGIN_CONFIG

export function parseGuardianConfigText(text: string, label: string): GuardianConfigOverrides {
  return normalizeGuardianOverrides(parseObjectDocument(text, label), label);
}

// START_BLOCK_RENDER_GUARDIAN_CONFIG
export function renderGuardianConfig(overrides: GuardianConfigOverrides = {}): string {
  const timeoutMs = overrides.timeoutMs ?? DEFAULT_GUARDIAN_TIMEOUT_MS;
  const approvalRiskThreshold =
    overrides.approvalRiskThreshold ?? DEFAULT_GUARDIAN_APPROVAL_RISK_THRESHOLD;
  const reviewToastDurationMs = overrides.reviewToastDurationMs ?? timeoutMs;
  const lines = [
    "// Managed by vvoc.",
    "// `vvoc sync` rewrites files with this marker while preserving current values.",
    "// Remove this header if you want to manage the file manually.",
    "",
    "{",
  ];

  if (overrides.model) {
    lines.push(`  "model": ${JSON.stringify(overrides.model)},`);
  } else {
    lines.push('  // "model": "anthropic/claude-sonnet-4-5",');
  }

  lines.push("");

  if (overrides.variant) {
    lines.push(`  "variant": ${JSON.stringify(overrides.variant)},`);
  } else {
    lines.push('  // "variant": "high",');
  }

  lines.push("");
  lines.push(`  "timeoutMs": ${timeoutMs},`);
  lines.push(`  "approvalRiskThreshold": ${approvalRiskThreshold},`);
  lines.push(`  "reviewToastDurationMs": ${reviewToastDurationMs}`);
  lines.push("}");

  return `${lines.join("\n")}\n`;
}
// END_BLOCK_RENDER_GUARDIAN_CONFIG

// START_BLOCK_INSTALL_PACKAGE_AND_GUARDIAN_CONFIG
export async function ensurePackageInstalled(paths: ResolvedPaths): Promise<{
  path: string;
  changed: boolean;
}> {
  const currentText = await readOptionalText(paths.opencodeConfigPath);
  const nextText = ensurePackageConfigText(currentText, await getPinnedPackageSpecifier());

  if (currentText === nextText) {
    return { path: paths.opencodeConfigPath, changed: false };
  }

  await writeText(paths.opencodeConfigPath, nextText);
  return { path: paths.opencodeConfigPath, changed: true };
}

export async function installGuardianConfig(
  paths: ResolvedPaths,
  options: { force: boolean },
): Promise<WriteResult> {
  const currentText = await readOptionalText(paths.guardianConfigPath);
  if (!currentText) {
    await writeText(paths.guardianConfigPath, renderGuardianConfig());
    return { action: "created", path: paths.guardianConfigPath };
  }

  if (!options.force) {
    if (!isManagedFile(currentText)) {
      return {
        action: "skipped",
        path: paths.guardianConfigPath,
        reason: "existing file is not managed by vvoc",
      };
    }
    return { action: "kept", path: paths.guardianConfigPath };
  }

  return syncGuardianConfig(paths, options);
}

export async function syncGuardianConfig(
  paths: ResolvedPaths,
  options: { force: boolean },
): Promise<WriteResult> {
  const currentText = await readOptionalText(paths.guardianConfigPath);
  if (!currentText) {
    await writeText(paths.guardianConfigPath, renderGuardianConfig());
    return { action: "created", path: paths.guardianConfigPath };
  }

  if (!options.force && !isManagedFile(currentText)) {
    return {
      action: "skipped",
      path: paths.guardianConfigPath,
      reason: "existing file is not managed by vvoc",
    };
  }

  const nextText = renderGuardianConfig(
    parseGuardianConfigText(currentText, paths.guardianConfigPath),
  );
  if (currentText === nextText) {
    return { action: "kept", path: paths.guardianConfigPath };
  }

  await writeText(paths.guardianConfigPath, nextText);
  return { action: "updated", path: paths.guardianConfigPath };
}

export async function writeGuardianConfig(
  paths: ResolvedPaths,
  overrides: GuardianConfigOverrides,
  options: { force: boolean },
): Promise<WriteResult> {
  const currentText = await readOptionalText(paths.guardianConfigPath);
  if (currentText && !options.force && !isManagedFile(currentText)) {
    return {
      action: "skipped",
      path: paths.guardianConfigPath,
      reason: "existing file is not managed by vvoc",
    };
  }

  const nextText = renderGuardianConfig(overrides);
  if (currentText === nextText) {
    return { action: "kept", path: paths.guardianConfigPath };
  }

  await writeText(paths.guardianConfigPath, nextText);
  return {
    action: currentText ? "updated" : "created",
    path: paths.guardianConfigPath,
  };
}
// END_BLOCK_INSTALL_PACKAGE_AND_GUARDIAN_CONFIG

// START_BLOCK_INSTALL_MEMORY_CONFIG
export async function installMemoryConfig(
  paths: ResolvedPaths,
  options: { force: boolean },
): Promise<WriteResult> {
  const currentText = await readOptionalText(paths.memoryConfigPath);
  if (!currentText) {
    await writeText(paths.memoryConfigPath, renderMemoryConfig());
    return { action: "created", path: paths.memoryConfigPath };
  }

  if (!options.force) {
    if (!isManagedFile(currentText)) {
      return {
        action: "skipped",
        path: paths.memoryConfigPath,
        reason: "existing file is not managed by vvoc",
      };
    }
    return { action: "kept", path: paths.memoryConfigPath };
  }

  return syncMemoryConfig(paths, options);
}

export async function syncMemoryConfig(
  paths: ResolvedPaths,
  options: { force: boolean },
): Promise<WriteResult> {
  const currentText = await readOptionalText(paths.memoryConfigPath);
  if (!currentText) {
    await writeText(paths.memoryConfigPath, renderMemoryConfig());
    return { action: "created", path: paths.memoryConfigPath };
  }

  if (!options.force && !isManagedFile(currentText)) {
    return {
      action: "skipped",
      path: paths.memoryConfigPath,
      reason: "existing file is not managed by vvoc",
    };
  }

  const nextText = renderMemoryConfig(parseMemoryConfigText(currentText, paths.memoryConfigPath));
  if (currentText === nextText) {
    return { action: "kept", path: paths.memoryConfigPath };
  }

  await writeText(paths.memoryConfigPath, nextText);
  return { action: "updated", path: paths.memoryConfigPath };
}
// END_BLOCK_INSTALL_MEMORY_CONFIG

// START_BLOCK_INSTALL_SECRETS_REDACTION_CONFIG
export function renderSecretsRedactionConfig(): string {
  const lines = [
    "// Managed by vvoc.",
    "// `vvoc sync` rewrites files with this marker while preserving current values.",
    "// Remove this header if you want to manage the file manually.",
    "",
    "{",
    '  "enabled": true,',
    '  "secret": "${VVOC_SECRET}",',
    '  "ttlMs": 3600000,',
    '  "maxMappings": 10000,',
    '  "patterns": {',
    '    "keywords": [],',
    '    "regex": [],',
    '    "builtin": ["email", "uuid", "ipv4", "mac"],',
    '    "exclude": []',
    "  },",
    '  "debug": false',
    "}",
  ];
  return `${lines.join("\n")}\n`;
}

export function parseSecretsRedactionConfigText(
  text: string,
  _filePath: string,
): Record<string, unknown> {
  const errors: ParseError[] = [];
  const result = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new Error(`parse error at offset ${errors[0].offset}`);
  }
  if (typeof result !== "object" || result === null) {
    throw new Error("root must be an object");
  }
  return result as Record<string, unknown>;
}

export async function installSecretsRedactionConfig(
  paths: ResolvedPaths,
  options: { force: boolean },
): Promise<WriteResult> {
  const currentText = await readOptionalText(paths.secretsRedactionConfigPath);
  if (!currentText) {
    await writeText(paths.secretsRedactionConfigPath, renderSecretsRedactionConfig());
    return { action: "created", path: paths.secretsRedactionConfigPath };
  }

  if (!options.force) {
    if (!isManagedFile(currentText)) {
      return {
        action: "skipped",
        path: paths.secretsRedactionConfigPath,
        reason: "existing file is not managed by vvoc",
      };
    }
    return { action: "kept", path: paths.secretsRedactionConfigPath };
  }

  return syncSecretsRedactionConfig(paths, options);
}

export async function syncSecretsRedactionConfig(
  paths: ResolvedPaths,
  options: { force: boolean },
): Promise<WriteResult> {
  const currentText = await readOptionalText(paths.secretsRedactionConfigPath);
  if (!currentText) {
    await writeText(paths.secretsRedactionConfigPath, renderSecretsRedactionConfig());
    return { action: "created", path: paths.secretsRedactionConfigPath };
  }

  if (!options.force && !isManagedFile(currentText)) {
    return {
      action: "skipped",
      path: paths.secretsRedactionConfigPath,
      reason: "existing file is not managed by vvoc",
    };
  }

  const nextText = renderSecretsRedactionConfig();
  if (currentText === nextText) {
    return { action: "kept", path: paths.secretsRedactionConfigPath };
  }

  await writeText(paths.secretsRedactionConfigPath, nextText);
  return { action: "updated", path: paths.secretsRedactionConfigPath };
}
// END_BLOCK_INSTALL_SECRETS_REDACTION_CONFIG

// START_BLOCK_INSPECT_INSTALLATION_STATE
export async function inspectInstallation(paths: ResolvedPaths): Promise<InstallationInspection> {
  const warnings: string[] = [];
  const problems: string[] = [];

  if (paths.opencodeAlternatePaths.length > 0) {
    warnings.push(
      `multiple OpenCode config files exist: ${[paths.opencodeConfigPath, ...paths.opencodeAlternatePaths].join(", ")}`,
    );
  }
  if (paths.guardianAlternatePaths.length > 0) {
    warnings.push(
      `multiple Guardian config files exist: ${[paths.guardianConfigPath, ...paths.guardianAlternatePaths].join(", ")}`,
    );
  }
  if (paths.memoryConfigAlternates.length > 0) {
    warnings.push(
      `multiple Memory config files exist: ${[paths.memoryConfigPath, ...paths.memoryConfigAlternates].join(", ")}`,
    );
  }
  if (paths.secretsRedactionConfigAlternates.length > 0) {
    warnings.push(
      `multiple SecretsRedaction config files exist: ${[paths.secretsRedactionConfigPath, ...paths.secretsRedactionConfigAlternates].join(", ")}`,
    );
  }

  const opencodeText = await readOptionalText(paths.opencodeConfigPath);
  let opencodeParseError: string | undefined;
  let plugins: string[] = [];
  let pluginConfigured = false;

  if (opencodeText) {
    try {
      const document = parseObjectDocument(opencodeText, paths.opencodeConfigPath);
      plugins = readPluginList(document, paths.opencodeConfigPath);
      pluginConfigured = plugins.some(isPackagePluginSpecifier);
    } catch (error) {
      opencodeParseError = error instanceof Error ? error.message : String(error);
      problems.push(opencodeParseError);
    }
  }

  const guardianText = await readOptionalText(paths.guardianConfigPath);
  let guardianParseError: string | undefined;
  let guardianOverrides: GuardianConfigOverrides | undefined;
  const guardianManaged = guardianText ? isManagedFile(guardianText) : false;

  if (guardianText) {
    try {
      guardianOverrides = parseGuardianConfigText(guardianText, paths.guardianConfigPath);
    } catch (error) {
      guardianParseError = error instanceof Error ? error.message : String(error);
      problems.push(guardianParseError);
    }
  }

  const memoryText = await readOptionalText(paths.memoryConfigPath);
  let memoryParseError: string | undefined;
  let memoryOverrides: MemoryConfigOverrides | undefined;
  const memoryManaged = memoryText ? isManagedFile(memoryText) : false;

  if (memoryText) {
    try {
      memoryOverrides = parseMemoryConfigText(memoryText, paths.memoryConfigPath);
    } catch (error) {
      memoryParseError = error instanceof Error ? error.message : String(error);
      problems.push(memoryParseError);
    }
  }

  const secretsRedactionText = await readOptionalText(paths.secretsRedactionConfigPath);
  let secretsRedactionParseError: string | undefined;
  const secretsRedactionManaged = secretsRedactionText
    ? isManagedFile(secretsRedactionText)
    : false;

  if (secretsRedactionText) {
    try {
      parseSecretsRedactionConfigText(secretsRedactionText, paths.secretsRedactionConfigPath);
    } catch (error) {
      secretsRedactionParseError = error instanceof Error ? error.message : String(error);
      problems.push(secretsRedactionParseError);
    }
  }

  if (!pluginConfigured) {
    problems.push(`${PACKAGE_NAME} is not configured in ${paths.opencodeConfigPath}`);
  }

  return {
    scope: paths.scope,
    opencode: {
      path: paths.opencodeConfigPath,
      exists: Boolean(opencodeText),
      alternates: paths.opencodeAlternatePaths,
      parseError: opencodeParseError,
      pluginConfigured,
      plugins,
    },
    guardian: {
      path: paths.guardianConfigPath,
      exists: Boolean(guardianText),
      alternates: paths.guardianAlternatePaths,
      managed: guardianManaged,
      parseError: guardianParseError,
      overrides: guardianOverrides,
    },
    memory: {
      path: paths.memoryConfigPath,
      exists: Boolean(memoryText),
      alternates: paths.memoryConfigAlternates,
      managed: memoryManaged,
      parseError: memoryParseError,
      overrides: memoryOverrides,
    },
    secretsRedaction: {
      path: paths.secretsRedactionConfigPath,
      exists: Boolean(secretsRedactionText),
      alternates: paths.secretsRedactionConfigAlternates,
      managed: secretsRedactionManaged,
      parseError: secretsRedactionParseError,
    },
    warnings,
    problems,
  };
}
// END_BLOCK_INSPECT_INSTALLATION_STATE

export function describeWriteResult(result: WriteResult): string {
  let message = "";

  switch (result.action) {
    case "created":
      message = `Created ${result.path}`;
      break;
    case "updated":
      message = `Updated ${result.path}`;
      break;
    case "kept":
      message = `Kept ${result.path}`;
      break;
    case "skipped":
      message = `Skipped ${result.path}`;
      break;
  }

  return result.reason ? `${message} (${result.reason})` : message;
}

// START_BLOCK_PARSE_AND_NORMALIZE_CONFIG_VALUES
function parseObjectDocument(text: string, label: string): JsonObject {
  const errors: ParseError[] = [];
  const value = parse(text, errors, {
    allowEmptyContent: false,
    allowTrailingComma: true,
    disallowComments: false,
  }) as unknown;

  if (errors.length > 0) {
    throw new Error(`${label}: failed to parse JSONC (${errors.length} error(s))`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}: expected a top-level object`);
  }

  return value as JsonObject;
}

function readPluginList(document: JsonObject, label: string): string[] {
  const raw = document.plugin;
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label}: expected "plugin" to be an array of strings`);
  }
  return raw.slice();
}

function normalizePluginList(currentPlugins: string[], packageSpecifier: string): string[] {
  const nextPlugins: string[] = [];
  const seen = new Set<string>();
  let insertedPackage = false;

  const push = (value: string) => {
    if (!seen.has(value)) {
      seen.add(value);
      nextPlugins.push(value);
    }
  };

  for (const plugin of currentPlugins) {
    if (isPackagePluginSpecifier(plugin)) {
      if (!insertedPackage) {
        push(packageSpecifier);
        insertedPackage = true;
      }
      continue;
    }

    push(plugin);
  }

  if (!insertedPackage) {
    push(packageSpecifier);
  }

  return nextPlugins;
}

function isPackagePluginSpecifier(value: string): boolean {
  return value === PACKAGE_NAME || value.startsWith(`${PACKAGE_NAME}@`);
}

function normalizeGuardianOverrides(raw: unknown, label: string): GuardianConfigOverrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${label}: expected a top-level object`);
  }

  const record = raw as Record<string, unknown>;
  const overrides: GuardianConfigOverrides = {};

  if (Object.hasOwn(record, "model")) {
    overrides.model = readNonEmptyString(record.model, `${label}: model`);
  }
  if (Object.hasOwn(record, "variant")) {
    overrides.variant = readNonEmptyString(record.variant, `${label}: variant`);
  }
  if (Object.hasOwn(record, "timeoutMs")) {
    overrides.timeoutMs = readPositiveInteger(record.timeoutMs, `${label}: timeoutMs`);
  }
  if (Object.hasOwn(record, "approvalRiskThreshold")) {
    overrides.approvalRiskThreshold = readThreshold(
      record.approvalRiskThreshold,
      `${label}: approvalRiskThreshold`,
    );
  }
  if (Object.hasOwn(record, "reviewToastDurationMs")) {
    overrides.reviewToastDurationMs = readPositiveInteger(
      record.reviewToastDurationMs,
      `${label}: reviewToastDurationMs`,
    );
  }

  return overrides;
}

function readNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label}: expected a non-empty string`);
  }
  return value.trim();
}

function readPositiveInteger(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  throw new Error(`${label}: expected a positive integer`);
}

function readThreshold(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(100, Math.round(value)));
  }
  throw new Error(`${label}: expected a number between 0 and 100`);
}
// END_BLOCK_PARSE_AND_NORMALIZE_CONFIG_VALUES

// START_BLOCK_FILESYSTEM_HELPERS
function isManagedFile(text: string): boolean {
  return text.includes(MANAGED_MARKER);
}

function renderJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

async function selectPrimaryPath(candidates: string[]): Promise<{
  primary: string;
  alternates: string[];
}> {
  const existing: string[] = [];

  for (const candidate of candidates) {
    if ((await readOptionalText(candidate)) !== undefined) {
      existing.push(candidate);
    }
  }

  return {
    primary: existing[0] ?? candidates[0],
    alternates: existing.slice(1),
  };
}
// END_BLOCK_FILESYSTEM_HELPERS
