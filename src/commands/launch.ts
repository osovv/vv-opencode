// FILE: src/commands/launch.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Launch OpenCode with deterministic vvoc and native OpenCode config layer environment variables.
//   SCOPE: Scope parsing, OpenCode/vvoc config source selection, subprocess env construction, arg forwarding, stdio forwarding, and exit-code preservation.
//   DEPENDS: [citty, src/lib/config-layers.ts]
//   LINKS: [M-CLI-COMMANDS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   LaunchScope - Supported launch source selection scopes.
//   LaunchPlan - Testable OpenCode command and environment plan.
//   buildLaunchPlan - Builds the opencode command and env overrides without spawning.
//   runLaunch - Runs opencode from a launch plan and returns its exit code.
//   default - Launch command definition for vvoc.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-007 - Added a fail-closed native host window preflight before spawning OpenCode.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import { dirname } from "node:path";
import { getGlobalOpencodeDir } from "../lib/vvoc-paths.js";
import {
  OPENCODE_CONFIG_DIR_ENV,
  OPENCODE_CONFIG_ENV,
  VVOC_CONFIG_ENV,
  resolveOpenCodeConfigSource,
  resolveVvocConfigSource,
  type ConfigSource,
} from "../lib/config-layers.js";
import { assertSupportedOpenCodeRuntime, type OpenCodeRuntimeInspection } from "../lib/opencode.js";

export type LaunchScope = "effective" | "project" | "global";

export type LaunchPlan = {
  command: string[];
  env: Record<string, string>;
  opencodeSource: ConfigSource;
  vvocSource: ConfigSource;
};

const launchScopeArg = {
  type: "enum" as const,
  options: ["effective", "project", "global"],
  default: "effective",
  description: "Launch with effective, project-local, or global config paths.",
};

export async function buildLaunchPlan(options: {
  scope: LaunchScope;
  cwd: string;
  configDir?: string;
  passthroughArgs: string[];
  env?: NodeJS.ProcessEnv;
}): Promise<LaunchPlan> {
  const [opencodeSource, vvocSource] = await Promise.all([
    resolveOpenCodeConfigSource({
      scope: options.scope,
      cwd: options.cwd,
      configDir: options.configDir,
      env: options.env,
    }),
    resolveVvocConfigSource({
      scope: options.scope,
      cwd: options.cwd,
      configDir: options.configDir,
      env: options.env,
      allowDefault: false,
    }),
  ]);

  if (options.scope === "project") {
    const missing = [opencodeSource, vvocSource].find((source) => source.kind === "missing");
    if (missing) {
      throw new Error(missing.reason ?? "project config missing; run vvoc install --scope project");
    }
  }

  if (!opencodeSource.path) {
    throw new Error(
      "OpenCode config source has no path; run vvoc install --scope project or vvoc install",
    );
  }
  if (!vvocSource.path) {
    throw new Error(
      "vvoc config source has no path; run vvoc install --scope project or vvoc install",
    );
  }

  const env: Record<string, string> = {
    [OPENCODE_CONFIG_ENV]: opencodeSource.path,
    [VVOC_CONFIG_ENV]: vvocSource.path,
  };
  // OPENCODE_CONFIG only adds a document; arrange the native discovery root so
  // generated sibling agents/skills under a custom or alt-XDG global config are
  // still discovered. Project scope keeps the native default global root.
  if (options.scope === "global") {
    env[OPENCODE_CONFIG_DIR_ENV] = getGlobalOpencodeDir(options.configDir);
  } else if (opencodeSource.kind === "global" && opencodeSource.path !== undefined) {
    env[OPENCODE_CONFIG_DIR_ENV] = dirname(opencodeSource.path);
  }

  return {
    command: ["opencode", ...options.passthroughArgs],
    env,
    opencodeSource,
    vvocSource,
  };
}

export async function runLaunch(options: {
  scope: LaunchScope;
  cwd: string;
  configDir?: string;
  passthroughArgs: string[];
  spawn?: (plan: LaunchPlan) => Promise<number>;
  inspectRuntime?: () => Promise<OpenCodeRuntimeInspection>;
}): Promise<number> {
  // Preflight: refuse to launch against an unverifiable or out-of-window host.
  await assertSupportedOpenCodeRuntime(options.inspectRuntime);
  const plan = await buildLaunchPlan(options);
  if (options.spawn) {
    return options.spawn(plan);
  }

  const subprocess = Bun.spawn({
    cmd: plan.command,
    cwd: options.cwd,
    env: { ...process.env, ...plan.env },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return subprocess.exited;
}

export default defineCommand({
  meta: {
    name: "launch",
    description: "Launch OpenCode with deterministic vvoc/OpenCode config sources.",
  },
  args: {
    scope: launchScopeArg,
    "config-dir": {
      type: "string",
      description: "Override the global config home used for opencode/ and vvoc/.",
    },
  },
  async run({ args }) {
    const configDir = typeof args["config-dir"] === "string" ? args["config-dir"] : undefined;
    const passthroughArgs = readPassthroughArgs(args);
    const exitCode = await runLaunch({
      scope: resolveLaunchScope(args.scope),
      cwd: process.cwd(),
      configDir,
      passthroughArgs,
    });
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  },
});

function resolveLaunchScope(value: unknown): LaunchScope {
  return value === "project" || value === "global" ? value : "effective";
}

function readPassthroughArgs(args: Record<string, unknown>): string[] {
  const raw = args._;
  if (Array.isArray(raw)) {
    return raw.filter((entry): entry is string => typeof entry === "string");
  }
  if (typeof raw === "string" && raw.trim()) {
    return [raw];
  }
  return [];
}
