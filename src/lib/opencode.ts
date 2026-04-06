import { applyEdits, format, modify, parse, type ParseError } from "jsonc-parser";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CLI_NAME = "vvoc";
export const PACKAGE_NAME = "@osovv/vv-opencode";
export const OPENCODE_SCHEMA_URL = "https://opencode.ai/config.json";

const DEFAULT_GLOBAL_CONFIG_DIR = join(homedir(), ".config", "opencode");
const MANAGED_MARKER = "Managed by vvoc";
const DEFAULT_GUARDIAN_TIMEOUT_MS = 90_000;
const DEFAULT_GUARDIAN_APPROVAL_RISK_THRESHOLD = 80;

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
  opencodeBaseDir: string;
  guardianBaseDir: string;
  opencodeConfigPath: string;
  opencodeAlternatePaths: string[];
  guardianConfigPath: string;
  guardianAlternatePaths: string[];
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
  warnings: string[];
  problems: string[];
};

export async function resolvePaths(options: {
  scope: Scope;
  cwd: string;
  configDir?: string;
}): Promise<ResolvedPaths> {
  const opencodeBaseDir = options.scope === "global"
    ? options.configDir ?? DEFAULT_GLOBAL_CONFIG_DIR
    : options.cwd;
  const guardianBaseDir = options.scope === "global"
    ? options.configDir ?? DEFAULT_GLOBAL_CONFIG_DIR
    : join(options.cwd, ".opencode");
  const opencodeSelection = await selectPrimaryPath([
    join(opencodeBaseDir, "opencode.json"),
    join(opencodeBaseDir, "opencode.jsonc"),
  ]);
  const guardianSelection = await selectPrimaryPath([
    join(guardianBaseDir, "guardian.jsonc"),
    join(guardianBaseDir, "guardian.json"),
  ]);

  return {
    scope: options.scope,
    cwd: options.cwd,
    opencodeBaseDir,
    guardianBaseDir,
    opencodeConfigPath: opencodeSelection.primary,
    opencodeAlternatePaths: opencodeSelection.alternates,
    guardianConfigPath: guardianSelection.primary,
    guardianAlternatePaths: guardianSelection.alternates,
  };
}

export function ensurePackageConfigText(text?: string): string {
  if (!text?.trim()) {
    return renderJson({
      $schema: OPENCODE_SCHEMA_URL,
      plugin: [PACKAGE_NAME],
    });
  }

  const document = parseObjectDocument(text, "OpenCode config");
  const currentPlugins = readPluginList(document, "OpenCode config");
  let nextText = text;

  if (!Object.hasOwn(document, "$schema")) {
    nextText = applyEdits(nextText, modify(nextText, ["$schema"], OPENCODE_SCHEMA_URL, {
      formattingOptions: JSON_FORMAT,
      getInsertionIndex: () => 0,
    }));
  }

  const nextPlugins = Array.from(new Set([...currentPlugins, PACKAGE_NAME]));
  if (nextPlugins.length !== currentPlugins.length) {
    nextText = applyEdits(nextText, modify(nextText, ["plugin"], nextPlugins, {
      formattingOptions: JSON_FORMAT,
    }));
  }

  return ensureTrailingNewline(applyEdits(nextText, format(nextText, undefined, JSON_FORMAT)));
}

export function parseGuardianConfigText(
  text: string,
  label: string,
): GuardianConfigOverrides {
  return normalizeGuardianOverrides(parseObjectDocument(text, label), label);
}

export function renderGuardianConfig(overrides: GuardianConfigOverrides = {}): string {
  const timeoutMs = overrides.timeoutMs ?? DEFAULT_GUARDIAN_TIMEOUT_MS;
  const approvalRiskThreshold = overrides.approvalRiskThreshold
    ?? DEFAULT_GUARDIAN_APPROVAL_RISK_THRESHOLD;
  const reviewToastDurationMs = overrides.reviewToastDurationMs ?? timeoutMs;
  const lines = [
    "// Managed by vvoc.",
    "// `vvoc sync` rewrites files with this marker while preserving current values.",
    "// Remove this header if you want to manage the file manually.",
    "",
    "{",
  ];

  if (overrides.model) {
    lines.push(`  \"model\": ${JSON.stringify(overrides.model)},`);
  } else {
    lines.push("  // \"model\": \"anthropic/claude-sonnet-4-5\",");
  }

  lines.push("");

  if (overrides.variant) {
    lines.push(`  \"variant\": ${JSON.stringify(overrides.variant)},`);
  } else {
    lines.push("  // \"variant\": \"high\",");
  }

  lines.push("");
  lines.push(`  \"timeoutMs\": ${timeoutMs},`);
  lines.push(`  \"approvalRiskThreshold\": ${approvalRiskThreshold},`);
  lines.push(`  \"reviewToastDurationMs\": ${reviewToastDurationMs}`);
  lines.push("}");

  return `${lines.join("\n")}\n`;
}

export async function ensurePackageInstalled(paths: ResolvedPaths): Promise<{
  path: string;
  changed: boolean;
}> {
  const currentText = await readOptionalText(paths.opencodeConfigPath);
  const nextText = ensurePackageConfigText(currentText);

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

  const nextText = renderGuardianConfig(parseGuardianConfigText(currentText, paths.guardianConfigPath));
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

  const opencodeText = await readOptionalText(paths.opencodeConfigPath);
  let opencodeParseError: string | undefined;
  let plugins: string[] = [];
  let pluginConfigured = false;

  if (opencodeText) {
    try {
      const document = parseObjectDocument(opencodeText, paths.opencodeConfigPath);
      plugins = readPluginList(document, paths.opencodeConfigPath);
      pluginConfigured = plugins.includes(PACKAGE_NAME);
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
    warnings,
    problems,
  };
}

export function describeWriteResult(result: WriteResult): string {
  switch (result.action) {
    case "created":
      return `Created ${result.path}`;
    case "updated":
      return `Updated ${result.path}`;
    case "kept":
      return `Kept ${result.path}`;
    case "skipped":
      return `Skipped ${result.path}${result.reason ? ` (${result.reason})` : ""}`;
  }
}

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
    throw new Error(`${label}: expected \"plugin\" to be an array of strings`);
  }
  return raw.slice();
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
    if (await readOptionalText(candidate) !== undefined) {
      existing.push(candidate);
    }
  }

  return {
    primary: existing[0] ?? candidates[0],
    alternates: existing.slice(1),
  };
}
