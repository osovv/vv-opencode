#!/usr/bin/env bun
// FILE: scripts/tui-local.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Build and launch the repository's local TUI export against existing OpenCode and vvoc configs without loading the published vv-opencode TUI package.
//   SCOPE: Local build execution, effective/project/global launch selection, temporary TUI config generation, XDG config isolation, OpenCode arg forwarding, and cleanup.
//   DEPENDS: [node:fs/promises, node:os, node:path, node:url, src/commands/launch.ts, src/lib/config-layers.ts, src/lib/opencode.ts]
//   LINKS: [M-RELEASE-AUTOMATION, VF-RELEASE-AUTOMATION]
//   ROLE: SCRIPT
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   LocalTuiArguments - Parsed local-launch scope and forwarded OpenCode arguments.
//   PreparedLocalTuiLaunch - Temporary config, command, and environment required for one local TUI run.
//   parseLocalTuiArguments - Removes the local --scope option while preserving OpenCode passthrough arguments.
//   renderLocalTuiConfig - Replaces the managed package entry with the local dist/tui.js file URL.
//   createLocalTuiEnvironment - Combines selected config paths with an isolated XDG config home and temporary TUI config.
//   prepareLocalTuiLaunch - Resolves normal launch sources and writes the temporary local TUI config.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [DIRECT-FIX - Added a non-mutating local pre-release TUI launch workflow.]
// END_CHANGE_SUMMARY

import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildLaunchPlan, type LaunchScope } from "../src/commands/launch.ts";
import { OPENCODE_TUI_CONFIG_ENV } from "../src/lib/config-layers.ts";
import { ensureTuiPackageConfigText } from "../src/lib/opencode.ts";

export type LocalTuiArguments = {
  scope: LaunchScope;
  passthroughArgs: string[];
};

export type PreparedLocalTuiLaunch = {
  command: string[];
  env: NodeJS.ProcessEnv;
  tempRoot: string;
  tuiConfigPath: string;
  pluginUrl: string;
  opencodeConfigPath?: string;
  vvocConfigPath?: string;
};

export function parseLocalTuiArguments(args: readonly string[]): LocalTuiArguments {
  let scope: LaunchScope = "effective";
  const passthroughArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") {
      passthroughArgs.push(...args.slice(index + 1));
      break;
    }
    if (arg === "--scope") {
      const value = args[index + 1];
      scope = parseScope(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--scope=")) {
      scope = parseScope(arg.slice("--scope=".length));
      continue;
    }
    passthroughArgs.push(arg);
  }

  return { scope, passthroughArgs };
}

export function renderLocalTuiConfig(currentText: string | undefined, pluginUrl: string): string {
  return ensureTuiPackageConfigText(currentText, pluginUrl);
}

export function createLocalTuiEnvironment(options: {
  baseEnv: NodeJS.ProcessEnv;
  launchEnv: Record<string, string>;
  isolatedConfigHome: string;
  tuiConfigPath: string;
}): NodeJS.ProcessEnv {
  return {
    ...options.baseEnv,
    ...options.launchEnv,
    XDG_CONFIG_HOME: options.isolatedConfigHome,
    [OPENCODE_TUI_CONFIG_ENV]: options.tuiConfigPath,
  };
}

export async function prepareLocalTuiLaunch(options: {
  repoRoot: string;
  cwd: string;
  scope: LaunchScope;
  passthroughArgs: string[];
  env: NodeJS.ProcessEnv;
}): Promise<PreparedLocalTuiLaunch> {
  const launch = await buildLaunchPlan({
    scope: options.scope,
    cwd: options.cwd,
    passthroughArgs: options.passthroughArgs,
    env: options.env,
  });
  const pluginPath = resolve(options.repoRoot, "dist", "tui.js");
  await access(pluginPath);

  const tempRoot = await mkdtemp(join(tmpdir(), "vvoc-local-tui-"));
  try {
    const sourcePath =
      launch.opencodeTuiSource.kind === "missing" ? undefined : launch.opencodeTuiSource.path;
    const currentText = sourcePath ? await readFile(sourcePath, "utf8") : undefined;
    const extension = sourcePath?.endsWith(".jsonc") ? "jsonc" : "json";
    const tuiConfigPath = join(tempRoot, "opencode", `tui.${extension}`);
    const pluginUrl = pathToFileURL(pluginPath).href;
    await mkdir(dirname(tuiConfigPath), { recursive: true });
    await writeFile(tuiConfigPath, renderLocalTuiConfig(currentText, pluginUrl), "utf8");

    return {
      command: launch.command,
      env: createLocalTuiEnvironment({
        baseEnv: options.env,
        launchEnv: launch.env,
        isolatedConfigHome: tempRoot,
        tuiConfigPath,
      }),
      tempRoot,
      tuiConfigPath,
      pluginUrl,
      opencodeConfigPath: launch.opencodeSource.path,
      vvocConfigPath: launch.vvocSource.path,
    };
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

function parseScope(value: string | undefined): LaunchScope {
  if (value === "effective" || value === "project" || value === "global") return value;
  throw new Error(
    `Invalid local TUI scope "${value ?? ""}"; expected effective, project, or global.`,
  );
}

async function runBuild(repoRoot: string): Promise<void> {
  const subprocess = Bun.spawn({
    cmd: ["bun", "run", "build"],
    cwd: repoRoot,
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await subprocess.exited;
  if (exitCode !== 0) throw new Error(`Local TUI build failed with exit code ${exitCode}.`);
}

async function main(): Promise<void> {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const args = parseLocalTuiArguments(process.argv.slice(2));
  await runBuild(repoRoot);
  const launch = await prepareLocalTuiLaunch({
    repoRoot,
    cwd: process.cwd(),
    scope: args.scope,
    passthroughArgs: args.passthroughArgs,
    env: process.env,
  });

  console.log(`Local TUI plugin: ${launch.pluginUrl}`);
  console.log(`Temporary TUI config: ${launch.tuiConfigPath}`);
  console.log(`OpenCode config: ${launch.opencodeConfigPath ?? "missing"}`);
  console.log(`vvoc config: ${launch.vvocConfigPath ?? "missing"}`);
  console.log("The temporary config is removed after OpenCode exits.");

  try {
    const subprocess = Bun.spawn({
      cmd: launch.command,
      cwd: process.cwd(),
      env: launch.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    process.exitCode = await subprocess.exited;
  } finally {
    await rm(launch.tempRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
