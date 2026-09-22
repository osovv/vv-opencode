// FILE: src/lib/opencode/inspection.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: OpenCode host compatibility diagnostics and source-aware installation inspection.
//   SCOPE: opencode --version execution and semantic-version TUI compatibility comparison, installation-state inspection across runtime/TUI/vvoc config files with role-reference resolution and orchestration profile, strict/effective layered-scope inspection with config-source attribution, and write-result formatting for CLI output.
//   DEPENDS: [node:path, src/lib/config-layers.ts, src/lib/model-roles.ts, src/lib/orchestration.ts, src/lib/vvoc-config.ts, src/lib/vvoc-paths.ts, src/lib/package.ts, src/lib/opencode/shared-utils.ts, src/lib/opencode/paths.ts, src/lib/opencode/plugin-registration.ts]
//   LINKS: [M-CLI-CONFIG, M-ORCHESTRATION-PROFILES]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   OpenCodeRuntimeInspection - Installed OpenCode version and TUI compatibility snapshot.
//   InstallationInspection - Current OpenCode runtime/TUI and vvoc installation status snapshot.
//   inspectOpenCodeRuntime - Reads the installed OpenCode version and evaluates TUI compatibility.
//   isTuiOpenCodeVersionCompatible - Compares an OpenCode version with the managed TUI minimum.
//   extractOpenCodeVersion - Extracts the first semantic version found in `opencode --version` output.
//   inspectInstallation - Reads current OpenCode/vvoc installation state for status and doctor commands.
//   inspectInstallationForScope - Reads installation state using strict/effective layered source resolution.
//   describeWriteResult - Formats config write outcomes for CLI output.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-MODULE-SPLIT - Extracted runtime inspection, installation inspection, role-reference diagnostics, and write-result formatting from the former src/lib/opencode.ts monolith into this zone module.]
// END_CHANGE_SUMMARY

import { dirname } from "node:path";
import {
  resolveOpenCodeConfigSource,
  resolveOpenCodeTuiConfigSource,
  resolveVvocConfigSource,
  type ConfigReadScope,
  type ConfigSource,
} from "../config-layers.js";
import { BUILTIN_ROLE_NAMES, ROLE_REFERENCE_PREFIX } from "../model-roles.js";
import { resolveOrchestrationPolicy, type OrchestrationProfile } from "../orchestration.js";
import {
  createDefaultVvocConfig,
  parseVersionedVvocConfigText,
  type GuardianConfig,
  type SecretsRedactionConfig,
} from "../vvoc-config.js";
import { PACKAGE_NAME } from "../package.js";
import { getVvocAgentsDir, getVvocSkillsDir } from "../vvoc-paths.js";
import { parseObjectDocument, readOptionalText, type WriteResult } from "./shared-utils.js";
import { resolvePaths, type ResolvedPaths } from "./paths.js";
import {
  isPackagePluginSpecifier,
  isTuiPackageSpecifier,
  MINIMUM_TUI_OPENCODE_VERSION,
  readPluginList,
  readTuiPluginList,
  readTuiPluginName,
  TUI_PACKAGE_SPECIFIER,
  type TuiPluginEntry,
} from "./plugin-registration.js";

export type OpenCodeRuntimeInspection = {
  version?: string;
  minimumTuiVersion: string;
  tuiCompatible?: boolean;
  error?: string;
};

export type InstallationInspection = {
  scope: ConfigReadScope;
  runtime: OpenCodeRuntimeInspection;
  opencode: {
    path: string;
    exists: boolean;
    alternates: string[];
    parseError?: string;
    pluginConfigured: boolean;
    plugins: string[];
  };
  tui: {
    path: string;
    exists: boolean;
    alternates: string[];
    parseError?: string;
    pluginConfigured: boolean;
    plugins: TuiPluginEntry[];
  };
  vvoc: {
    path: string;
    exists: boolean;
    parseError?: string;
    schema?: string;
    version?: number;
  };
  guardian: {
    config?: GuardianConfig;
  };
  secretsRedaction: {
    config?: SecretsRedactionConfig;
  };
  orchestration: {
    profile?: OrchestrationProfile;
  };
  roles: {
    assignments: Array<{ roleId: string; model: string; builtIn: boolean }>;
    unresolvedReferences: Array<{ fieldPath: string; roleRef: string; roleId: string }>;
  };
  warnings: string[];
  problems: string[];
};

// START_BLOCK_INSPECT_OPENCODE_RUNTIME
export async function inspectOpenCodeRuntime(
  run: () => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }> = runOpenCodeVersionCommand,
): Promise<OpenCodeRuntimeInspection> {
  try {
    const result = await run();
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
      return {
        minimumTuiVersion: MINIMUM_TUI_OPENCODE_VERSION,
        error: `opencode --version failed: ${detail}`,
      };
    }

    const version = extractOpenCodeVersion(`${result.stdout}\n${result.stderr}`);
    if (!version) {
      return {
        minimumTuiVersion: MINIMUM_TUI_OPENCODE_VERSION,
        error: "opencode --version did not return a semantic version",
      };
    }

    return {
      version,
      minimumTuiVersion: MINIMUM_TUI_OPENCODE_VERSION,
      tuiCompatible: isTuiOpenCodeVersionCompatible(version),
    };
  } catch (error) {
    return {
      minimumTuiVersion: MINIMUM_TUI_OPENCODE_VERSION,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function isTuiOpenCodeVersionCompatible(version: string): boolean {
  const current = parseSemanticVersion(version);
  const minimum = parseSemanticVersion(MINIMUM_TUI_OPENCODE_VERSION);
  if (!current || !minimum) return false;

  for (let index = 0; index < 3; index += 1) {
    const currentPart = current.parts[index] ?? 0;
    const minimumPart = minimum.parts[index] ?? 0;
    if (currentPart > minimumPart) return true;
    if (currentPart < minimumPart) return false;
  }

  return !current.prerelease || Boolean(minimum.prerelease);
}

async function runOpenCodeVersionCommand(): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const subprocess = Bun.spawn({
    cmd: ["opencode", "--version"],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** Extracts the first semantic version found in `opencode --version` output. */
export function extractOpenCodeVersion(output: string): string | undefined {
  const match = output.match(
    /(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=\s|$)/,
  );
  return match?.[1];
}

function parseSemanticVersion(
  value: string,
): { parts: [number, number, number]; prerelease?: string } | undefined {
  const match = value
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return undefined;
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4],
  };
}
// END_BLOCK_INSPECT_OPENCODE_RUNTIME

// START_BLOCK_INSPECT_INSTALLATION_STATE
export async function inspectInstallation(
  paths: ResolvedPaths,
  options: { runtime?: OpenCodeRuntimeInspection } = {},
): Promise<InstallationInspection> {
  const warnings: string[] = [];
  const problems: string[] = [];
  const runtime = options.runtime ?? {
    minimumTuiVersion: MINIMUM_TUI_OPENCODE_VERSION,
  };

  if (runtime.error) {
    problems.push(`OpenCode version unavailable: ${runtime.error}`);
  } else if (runtime.tuiCompatible === false) {
    problems.push(
      `OpenCode ${runtime.version ?? "unknown"} is incompatible with /context; ${runtime.minimumTuiVersion} or newer is required`,
    );
  }

  if (paths.opencodeAlternatePaths.length > 0) {
    warnings.push(
      `multiple OpenCode config files exist: ${[paths.opencodeConfigPath, ...paths.opencodeAlternatePaths].join(", ")}`,
    );
  }

  if (paths.opencodeTuiAlternatePaths.length > 0) {
    warnings.push(
      `multiple OpenCode TUI config files exist: ${[paths.opencodeTuiConfigPath, ...paths.opencodeTuiAlternatePaths].join(", ")}`,
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

  const tuiText = await readOptionalText(paths.opencodeTuiConfigPath);
  let tuiParseError: string | undefined;
  let tuiPlugins: TuiPluginEntry[] = [];
  let tuiPluginConfigured = false;

  if (tuiText) {
    try {
      const document = parseObjectDocument(tuiText, paths.opencodeTuiConfigPath);
      tuiPlugins = readTuiPluginList(document, paths.opencodeTuiConfigPath);
      tuiPluginConfigured = tuiPlugins.some((entry) =>
        isTuiPackageSpecifier(readTuiPluginName(entry)),
      );
    } catch (error) {
      tuiParseError = error instanceof Error ? error.message : String(error);
      problems.push(tuiParseError);
    }
  }

  const vvocText = await readOptionalText(paths.vvocConfigPath);
  let vvocParseError: string | undefined;
  let vvocConfig: ReturnType<typeof createDefaultVvocConfig> | undefined;
  let vvocSourceSchema: string | undefined;
  let vvocSourceVersion: number | undefined;
  let roleAssignments: Array<{ roleId: string; model: string; builtIn: boolean }> = [];

  if (vvocText) {
    try {
      const parsedConfig = parseVersionedVvocConfigText(vvocText, paths.vvocConfigPath);
      vvocConfig = parsedConfig.config;
      vvocSourceSchema = parsedConfig.sourceSchema;
      vvocSourceVersion = parsedConfig.sourceVersion;
      roleAssignments = listRoleAssignments(vvocConfig.roles);
    } catch (error) {
      vvocParseError = error instanceof Error ? error.message : String(error);
      problems.push(vvocParseError);
    }
  }

  const unresolvedRoleReferences =
    opencodeText && !opencodeParseError
      ? collectUnresolvedRoleReferences(
          opencodeText,
          paths.opencodeConfigPath,
          vvocConfig?.roles ?? {},
        )
      : [];

  for (const unresolved of unresolvedRoleReferences) {
    problems.push(
      `unresolved role reference at ${unresolved.fieldPath}: ${unresolved.roleRef} (missing role: ${unresolved.roleId})`,
    );
  }

  if (!pluginConfigured) {
    problems.push(`${PACKAGE_NAME} is not configured in ${paths.opencodeConfigPath}`);
  }
  if (!tuiPluginConfigured) {
    problems.push(`${TUI_PACKAGE_SPECIFIER} is not configured in ${paths.opencodeTuiConfigPath}`);
  }
  if (!vvocText) {
    problems.push(`vvoc config is missing at ${paths.vvocConfigPath}`);
  }

  return {
    scope: paths.scope,
    runtime,
    opencode: {
      path: paths.opencodeConfigPath,
      exists: Boolean(opencodeText),
      alternates: paths.opencodeAlternatePaths,
      parseError: opencodeParseError,
      pluginConfigured,
      plugins,
    },
    tui: {
      path: paths.opencodeTuiConfigPath,
      exists: Boolean(tuiText),
      alternates: paths.opencodeTuiAlternatePaths,
      parseError: tuiParseError,
      pluginConfigured: tuiPluginConfigured,
      plugins: tuiPlugins,
    },
    vvoc: {
      path: paths.vvocConfigPath,
      exists: Boolean(vvocText),
      parseError: vvocParseError,
      schema: vvocSourceSchema,
      version: vvocSourceVersion,
    },
    guardian: {
      config: vvocConfig?.guardian,
    },
    secretsRedaction: {
      config: vvocConfig?.secretsRedaction,
    },
    orchestration: {
      profile: vvocConfig ? resolveOrchestrationPolicy(vvocConfig).profile : undefined,
    },
    roles: {
      assignments: roleAssignments,
      unresolvedReferences: unresolvedRoleReferences,
    },
    warnings,
    problems,
  };
}

export async function inspectInstallationForScope(options: {
  scope: ConfigReadScope;
  cwd: string;
  configDir?: string;
  inspectRuntime?: () => Promise<OpenCodeRuntimeInspection>;
}): Promise<
  InstallationInspection & {
    opencodeSource: ConfigSource;
    opencodeTuiSource: ConfigSource;
    vvocSource: ConfigSource;
  }
> {
  const [opencodeSource, opencodeTuiSource, vvocSource, runtime] = await Promise.all([
    resolveOpenCodeConfigSource({
      scope: options.scope,
      cwd: options.cwd,
      configDir: options.configDir,
    }),
    resolveOpenCodeTuiConfigSource({
      scope: options.scope,
      cwd: options.cwd,
      configDir: options.configDir,
    }),
    resolveVvocConfigSource({
      scope: options.scope,
      cwd: options.cwd,
      configDir: options.configDir,
      allowDefault: options.scope === "effective",
    }),
    (options.inspectRuntime ?? inspectOpenCodeRuntime)(),
  ]);

  if (options.scope === "project") {
    const missingSource = [opencodeSource, vvocSource].find((source) => source.kind === "missing");
    if (missingSource) {
      throw new Error(
        missingSource.reason ?? "project config missing; run vvoc install --scope project",
      );
    }
  }

  const fallbackPaths = await resolvePaths({
    scope: options.scope === "global" ? "global" : "project",
    cwd: options.cwd,
    configDir: options.configDir,
  });
  const opencodeConfigPath = opencodeSource.path ?? fallbackPaths.opencodeConfigPath;
  const opencodeTuiConfigPath = opencodeTuiSource.path ?? fallbackPaths.opencodeTuiConfigPath;
  const vvocConfigPath = vvocSource.path ?? fallbackPaths.vvocConfigPath;
  const scopedPaths: ResolvedPaths = {
    ...fallbackPaths,
    opencodeBaseDir: dirname(opencodeConfigPath),
    vvocBaseDir: dirname(vvocConfigPath),
    opencodeConfigPath,
    opencodeTuiConfigPath,
    vvocConfigPath,
    opencodeAlternatePaths: [],
    opencodeTuiAlternatePaths: [],
    managedAgentsDirPath: getVvocAgentsDir(dirname(vvocConfigPath)),
    managedSkillsDirPath: getVvocSkillsDir(dirname(vvocConfigPath)),
  };

  const inspection = await inspectInstallation(scopedPaths, { runtime });
  return {
    ...inspection,
    orchestration: {
      profile:
        inspection.orchestration.profile ??
        (vvocSource.kind === "default"
          ? resolveOrchestrationPolicy(createDefaultVvocConfig()).profile
          : undefined),
    },
    scope: options.scope,
    opencodeSource,
    opencodeTuiSource,
    vvocSource,
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

// START_BLOCK_ROLE_REFERENCE_DIAGNOSTICS
function listRoleAssignments(roles: Record<string, string>): Array<{
  roleId: string;
  model: string;
  builtIn: boolean;
}> {
  const listed: Array<{ roleId: string; model: string; builtIn: boolean }> = [];

  for (const roleId of BUILTIN_ROLE_NAMES) {
    if (typeof roles[roleId] === "string") {
      listed.push({ roleId, model: roles[roleId], builtIn: true });
    }
  }

  const customRoleIds = Object.keys(roles)
    .filter((roleId) => !BUILTIN_ROLE_NAMES.includes(roleId as (typeof BUILTIN_ROLE_NAMES)[number]))
    .sort((left, right) => left.localeCompare(right));

  for (const roleId of customRoleIds) {
    listed.push({ roleId, model: roles[roleId], builtIn: false });
  }

  return listed;
}

function collectUnresolvedRoleReferences(
  opencodeText: string,
  label: string,
  roleMap: Record<string, string>,
): Array<{ fieldPath: string; roleRef: string; roleId: string }> {
  const document = parseObjectDocument(opencodeText, label);
  const unresolved: Array<{ fieldPath: string; roleRef: string; roleId: string }> = [];

  const collectFromField = (fieldPath: string, value: unknown) => {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim();
    if (!trimmed.startsWith(ROLE_REFERENCE_PREFIX)) {
      return;
    }

    const roleId = trimmed.slice(ROLE_REFERENCE_PREFIX.length).trim();
    if (!roleId || !Object.hasOwn(roleMap, roleId)) {
      unresolved.push({ fieldPath, roleRef: trimmed, roleId: roleId || "<missing>" });
    }
  };

  collectFromField("model", document.model);
  collectFromField("small_model", document.small_model);

  for (const parentName of ["agent", "command"] as const) {
    const parent = document[parentName];
    if (!parent || typeof parent !== "object" || Array.isArray(parent)) {
      continue;
    }

    for (const [entryName, entry] of Object.entries(parent as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      collectFromField(
        `${parentName}.${entryName}.model`,
        (entry as Record<string, unknown>).model,
      );
    }
  }

  return unresolved;
}
// END_BLOCK_ROLE_REFERENCE_DIAGNOSTICS
