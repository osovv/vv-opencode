// FILE: src/lib/opencode/inspection.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Native OpenCode host compatibility diagnostics and source-aware installation inspection.
//   SCOPE: opencode --version execution and native supported-window comparison, installation-state inspection across native OpenCode `plugins`/`agents`/`skills` and vvoc config files with modelIntent role-reference resolution, strict/effective layered-scope inspection with config-source attribution, and write-result formatting for CLI output.
//   DEPENDS: [node:path, src/lib/config-layers.ts, src/lib/model-roles.ts, src/lib/orchestration.ts, src/lib/vvoc-config.ts, src/lib/vvoc-paths.ts, src/lib/package.ts, src/lib/opencode/shared-utils.ts, src/lib/opencode/paths.ts, src/lib/opencode/plugin-registration.ts]
//   LINKS: [M-CLI-CONFIG, M-ORCHESTRATION-PROFILES]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   OpenCodeRuntimeInspection - Installed OpenCode version and supported-window snapshot.
//   InstallationInspection - Current native OpenCode package and vvoc installation status snapshot.
//   inspectOpenCodeRuntime - Reads the installed OpenCode version and evaluates the exact supported window.
//   assertSupportedOpenCodeRuntime - Fails closed on an unverifiable or out-of-window host before any write.
//   extractOpenCodeVersion - Extracts the first semantic version found in `opencode --version` output.
//   inspectInstallation - Reads current native OpenCode/vvoc installation state for status and doctor commands.
//   inspectInstallationForScope - Reads installation state using strict/effective layered source resolution.
//   describeWriteResult - Formats config write outcomes for CLI output.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-CLI-JSON-PIN-SYNC-R1 T-002 - Exposed the native cli.json TUI client pin with a server-pin mismatch warning in installation inspection.]
// END_CHANGE_SUMMARY

import { comparePluginPins } from "./cli-plugin-registration.js";
import { dirname, join } from "node:path";
import {
  readRawOpenCodeModelIntent,
  resolveOpenCodeConfigSource,
  resolveVvocConfigSource,
  type ConfigReadScope,
  type ConfigSource,
  type RawOpenCodeModelIntent,
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
import { getVvocSkillsDir } from "../vvoc-paths.js";
import {
  assertNativeOpenCodeDocument,
  parseObjectDocument,
  readOptionalText,
  readPluginEntries,
  type OpenCodePluginEntry,
  type WriteResult,
} from "./shared-utils.js";
import { resolvePaths, type ResolvedPaths } from "./paths.js";
import {
  isManagedPackageTarget,
  isSupportedOpenCodeVersion,
  SUPPORTED_OPENCODE_VERSION_RANGE,
} from "./plugin-registration.js";

export type OpenCodeRuntimeInspection = {
  version?: string;
  supportedRange: string;
  versionSupported?: boolean;
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
    plugins: OpenCodePluginEntry[];
  };
  /**
   * The combined native package is registered once in native `plugins`; whether
   * the live host advertises `features.tui` is inventory state and cannot be
   * verified from config alone, so it is reported as a config-derived
   * registration plus an explicit limit note.
   */
  tui: {
    registered: boolean;
    note: string;
  };
  /**
   * The native TUI client config pin. The TUI is a separate client process
   * whose cli.json may carry a second, host-migrated vvoc pin; mirror-only
   * sync keeps an existing managed entry equal to the server pin.
   */
  cli: {
    path: string;
    exists: boolean;
    parseError?: string;
    managedPin?: string;
    mismatch: boolean;
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

const TUI_REGISTRATION_NOTE =
  "TUI capability is advertised by the live native host plugin inventory; config inspection alone cannot confirm loadability.";

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
        supportedRange: SUPPORTED_OPENCODE_VERSION_RANGE,
        error: `opencode --version failed: ${detail}`,
      };
    }

    const version = extractOpenCodeVersion(`${result.stdout}\n${result.stderr}`);
    if (!version) {
      return {
        supportedRange: SUPPORTED_OPENCODE_VERSION_RANGE,
        error: "opencode --version did not return a semantic version",
      };
    }

    return {
      version,
      supportedRange: SUPPORTED_OPENCODE_VERSION_RANGE,
      versionSupported: isSupportedOpenCodeVersion(version),
    };
  } catch (error) {
    return {
      supportedRange: SUPPORTED_OPENCODE_VERSION_RANGE,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// END_BLOCK_INSPECT_OPENCODE_RUNTIME

// START_CONTRACT: assertSupportedOpenCodeRuntime
//   PURPOSE: Fail closed on an unverifiable or out-of-window OpenCode host before any runtime/TUI/vvoc/agent/skill write.
//   INPUTS: { inspect: () => Promise<OpenCodeRuntimeInspection> - Injectable runtime inspector for tests. }
//   OUTPUTS: { OpenCodeRuntimeInspection - The verified runtime snapshot when the host is in the supported window. }
//   SIDE_EFFECTS: Runs `opencode --version` through the default inspector; throws on failure or unsupported version.
//   LINKS: [fn-inspectOpenCodeRuntime, const-SUPPORTED_OPENCODE_VERSION_RANGE]
// END_CONTRACT: assertSupportedOpenCodeRuntime
export async function assertSupportedOpenCodeRuntime(
  inspect: () => Promise<OpenCodeRuntimeInspection> = inspectOpenCodeRuntime,
): Promise<OpenCodeRuntimeInspection> {
  const runtime = await inspect();
  if (runtime.error) {
    throw new Error(
      `OpenCode host is not verifiable: ${runtime.error}. vvoc requires ${SUPPORTED_OPENCODE_VERSION_RANGE}.`,
    );
  }
  if (runtime.versionSupported !== true) {
    throw new Error(
      `OpenCode ${runtime.version ?? "unknown"} is not supported. vvoc requires ${SUPPORTED_OPENCODE_VERSION_RANGE}.`,
    );
  }
  return runtime;
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

// START_BLOCK_INSPECT_INSTALLATION_STATE
export async function inspectInstallation(
  paths: ResolvedPaths,
  options: { runtime?: OpenCodeRuntimeInspection } = {},
): Promise<InstallationInspection> {
  const warnings: string[] = [];
  const problems: string[] = [];
  const runtime = options.runtime ?? {
    supportedRange: SUPPORTED_OPENCODE_VERSION_RANGE,
  };

  if (runtime.error) {
    problems.push(`OpenCode version unavailable: ${runtime.error}`);
  } else if (runtime.versionSupported === false) {
    problems.push(
      `OpenCode ${runtime.version ?? "unknown"} is not supported; vvoc requires ${runtime.supportedRange}`,
    );
  }

  if (paths.opencodeAlternatePaths.length > 0) {
    warnings.push(
      `multiple OpenCode config files exist: ${[paths.opencodeConfigPath, ...paths.opencodeAlternatePaths].join(", ")}`,
    );
  }

  const opencodeText = await readOptionalText(paths.opencodeConfigPath);
  let opencodeParseError: string | undefined;
  let plugins: OpenCodePluginEntry[] = [];
  let pluginConfigured = false;

  if (opencodeText) {
    try {
      const document = parseObjectDocument(opencodeText, paths.opencodeConfigPath);
      assertNativeOpenCodeDocument(document, paths.opencodeConfigPath, {
        configDir: dirname(paths.opencodeConfigPath),
      });
      plugins = readPluginEntries(document, paths.opencodeConfigPath);
      pluginConfigured = plugins.some((entry) =>
        isManagedPackageTarget(typeof entry === "string" ? entry : entry.package),
      );
    } catch (error) {
      opencodeParseError = error instanceof Error ? error.message : String(error);
      problems.push(opencodeParseError);
    }
  }

  const cliText = await readOptionalText(paths.cliConfigPath);
  const pinCompare = comparePluginPins(plugins, cliText);
  if (pinCompare.cliParseError !== undefined) {
    warnings.push(`cli.json could not be parsed: ${pinCompare.cliParseError}`);
  } else if (pinCompare.mismatch) {
    warnings.push(
      `TUI client pin in cli.json (${pinCompare.cliPin}) differs from the opencode.json pin (${pinCompare.serverPin}); run vvoc sync`,
    );
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
          await readRawOpenCodeModelIntent(paths.cwd).catch(() => undefined),
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
      registered: pluginConfigured,
      note: TUI_REGISTRATION_NOTE,
    },
    cli: {
      path: paths.cliConfigPath,
      exists: pinCompare.cliExists,
      ...(pinCompare.cliParseError === undefined ? {} : { parseError: pinCompare.cliParseError }),
      ...(pinCompare.cliPin === undefined ? {} : { managedPin: pinCompare.cliPin }),
      mismatch: pinCompare.mismatch,
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
    vvocSource: ConfigSource;
  }
> {
  const [opencodeSource, vvocSource, runtime] = await Promise.all([
    resolveOpenCodeConfigSource({
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
  const vvocConfigPath = vvocSource.path ?? fallbackPaths.vvocConfigPath;
  const opencodeBaseDir = dirname(opencodeConfigPath);
  const vvocBaseDir = dirname(vvocConfigPath);
  const scopedPaths: ResolvedPaths = {
    ...fallbackPaths,
    opencodeBaseDir,
    vvocBaseDir,
    opencodeConfigPath,
    vvocConfigPath,
    opencodeAlternatePaths: [],
    managedAgentsDirPath: join(opencodeBaseDir, "agents"),
    managedSkillsDirPath: getVvocSkillsDir(vvocBaseDir),
    opencodeSkillsDirPath: join(opencodeBaseDir, "skills"),
    vvocAgentsDirPath: join(vvocBaseDir, "agents"),
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
    case "deleted":
      message = `Deleted ${result.path}`;
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
  intent: RawOpenCodeModelIntent | undefined,
  roleMap: Record<string, string>,
): Array<{ fieldPath: string; roleRef: string; roleId: string }> {
  const unresolved: Array<{ fieldPath: string; roleRef: string; roleId: string }> = [];
  if (!intent) return unresolved;

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

  collectFromField("modelIntent.model", intent.model);
  collectFromField("modelIntent.smallModel", intent.smallModel);

  for (const [name, model] of Object.entries(intent.agents)) {
    collectFromField(`modelIntent.agents.${name}`, model);
  }
  for (const [name, model] of Object.entries(intent.commands)) {
    collectFromField(`modelIntent.commands.${name}`, model);
  }

  return unresolved;
}
// END_BLOCK_ROLE_REFERENCE_DIAGNOSTICS
