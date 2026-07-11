// FILE: src/commands/orchestration.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Show and set scoped orchestration profiles with effective source and restart diagnostics.
//   SCOPE: Global/project/effective reads, global/project conservative writes, strict profile parsing, canonical bootstrap, and CLI output.
//   DEPENDS: [citty, node:fs/promises, node:path, src/lib/config-layers.ts, src/lib/opencode.ts, src/lib/orchestration.ts, src/lib/vvoc-config.ts]
//   LINKS: [M-CLI-ORCHESTRATION, M-ORCHESTRATION-PROFILES, M-CONFIG-LAYERS, M-CLI-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - Orchestration show/set command group.
//   OrchestrationWriteResult - Result returned by a scoped profile write.
//   showOrchestrationProfile - Resolves one profile and selected source without mutation.
//   setOrchestrationProfile - Conservatively writes one explicit root profile.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-PRESET-ORCHESTRATION-PROFILES - Added scoped orchestration profile reads, writes, validation, and restart output.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  loadVvocConfigForRead,
  type ConfigReadScope,
  type ConfigSource,
  type ConfigWriteScope,
} from "../lib/config-layers.js";
import { resolvePaths } from "../lib/opencode.js";
import {
  ORCHESTRATION_PROFILE_NAMES,
  parseOrchestrationProfile,
  resolveOrchestrationPolicy,
  type OrchestrationProfile,
} from "../lib/orchestration.js";
import {
  createDefaultVvocConfig,
  renderVvocConfig,
  validateVvocConfigDocument,
  type VvocConfig,
} from "../lib/vvoc-config.js";

/** Result returned by a scoped orchestration profile write. */
export type OrchestrationWriteResult = {
  action: "updated" | "kept";
  profile: OrchestrationProfile;
  path: string;
};

const configDirArg = {
  type: "string" as const,
  description: "Override the global config home used for vvoc/.",
};

const showCommand = defineCommand({
  meta: {
    name: "show",
    description: "Show the resolved orchestration profile and selected source.",
  },
  args: {
    scope: {
      type: "enum",
      options: ["global", "project", "effective"],
      default: "effective",
      description: "Read global, project-local, or effective layered config.",
    },
    "config-dir": configDirArg,
  },
  async run({ args }) {
    const result = await showOrchestrationProfile({
      cwd: process.cwd(),
      configDir: resolveConfigDir(args),
      scope: resolveReadScope(args.scope),
    });
    console.log(`Orchestration profile: ${result.profile}`);
    console.log(`Source: ${formatSource(result.source)}`);
  },
});

const setCommand = defineCommand({
  meta: {
    name: "set",
    description: "Set an explicit orchestration profile.",
  },
  args: {
    profile: {
      type: "positional",
      required: true,
      description: `Profile (${ORCHESTRATION_PROFILE_NAMES.join(", ")}).`,
    },
    scope: {
      type: "enum",
      options: ["global", "project"],
      default: "global",
      description: "Write global or project-local vvoc config.",
    },
    "config-dir": configDirArg,
  },
  async run({ args }) {
    const profile = parseOrchestrationProfile(args.profile, "orchestration set");
    const result = await setOrchestrationProfile(profile, {
      cwd: process.cwd(),
      configDir: resolveConfigDir(args),
      scope: resolveWriteScope(args.scope),
    });
    console.log(`${result.action}: orchestration profile ${result.profile}`);
    console.log(`Target: ${result.path}`);
    if (result.action === "updated") {
      console.log("Restart OpenCode to apply the changed orchestration profile.");
    }
  },
});

export default defineCommand({
  meta: {
    name: "orchestration",
    description: "Show or set the vv-controller orchestration profile.",
  },
  subCommands: {
    show: showCommand,
    set: setCommand,
  },
});

/** Reads one resolved profile and selected source without mutation. */
export async function showOrchestrationProfile(
  options: {
    cwd?: string;
    configDir?: string;
    scope?: ConfigReadScope;
  } = {},
): Promise<{ profile: OrchestrationProfile; source: ConfigSource }> {
  const { config, source } = await loadVvocConfigForRead({
    scope: options.scope ?? "effective",
    cwd: options.cwd ?? process.cwd(),
    configDir: options.configDir,
    allowDefault: true,
  });
  return {
    profile: resolveOrchestrationPolicy(config).profile,
    source,
  };
}

/** Writes one explicit profile to global or project vvoc.json. */
export async function setOrchestrationProfile(
  profile: OrchestrationProfile,
  options: { cwd?: string; configDir?: string; scope?: ConfigWriteScope } = {},
): Promise<OrchestrationWriteResult> {
  const normalizedProfile = parseOrchestrationProfile(profile, "orchestration set");
  const scope = assertWriteScope(options.scope ?? "global");
  const paths = await resolvePaths({
    scope,
    cwd: options.cwd ?? process.cwd(),
    configDir: options.configDir,
  });
  const currentText = await readOptionalText(paths.vvocConfigPath);

  if (currentText === undefined) {
    const config = createDefaultVvocConfig();
    config.orchestration = { profile: normalizedProfile };
    await mkdir(dirname(paths.vvocConfigPath), { recursive: true });
    await writeFile(paths.vvocConfigPath, renderVvocConfig(config), "utf8");
    return { action: "updated", profile: normalizedProfile, path: paths.vvocConfigPath };
  }

  const config = parseRawVvocConfigText(currentText, paths.vvocConfigPath);
  if (config.orchestration?.profile === normalizedProfile) {
    return { action: "kept", profile: normalizedProfile, path: paths.vvocConfigPath };
  }

  const nextConfig: VvocConfig = {
    ...config,
    orchestration: { profile: normalizedProfile },
  };
  await writeFile(paths.vvocConfigPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  return { action: "updated", profile: normalizedProfile, path: paths.vvocConfigPath };
}

function parseRawVvocConfigText(text: string, label: string): VvocConfig {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label}: invalid JSON`);
  }
  const errors = validateVvocConfigDocument(value);
  if (errors.length > 0) throw new Error(`${label}: ${errors.join("; ")}`);
  return value as VvocConfig;
}

async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function assertWriteScope(scope: ConfigWriteScope): ConfigWriteScope {
  if (scope !== "global" && scope !== "project") {
    throw new Error("orchestration set supports --scope global or --scope project, not effective");
  }
  return scope;
}

function resolveReadScope(value: unknown): ConfigReadScope {
  return value === "global" || value === "project" ? value : "effective";
}

function resolveWriteScope(value: unknown): ConfigWriteScope {
  if (value === "effective") {
    throw new Error("orchestration set supports --scope global or --scope project, not effective");
  }
  return value === "project" ? "project" : "global";
}

function resolveConfigDir(args: Record<string, unknown>): string | undefined {
  return typeof args["config-dir"] === "string" ? args["config-dir"] : undefined;
}

function formatSource(source: ConfigSource): string {
  return `${source.kind}${source.path ? ` ${source.path}` : ""}`;
}
