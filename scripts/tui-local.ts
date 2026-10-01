#!/usr/bin/env bun
// FILE: scripts/tui-local.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Build and launch a local native TUI export against existing OpenCode/vvoc configs by pointing the native cli.json plugin list at a local package directory forwarder.
//   SCOPE: Local build execution, effective/project/global launch selection, local plugin-directory forwarder generation, isolated XDG config home with a merged cli.json, OpenCode arg forwarding, and cleanup. It never edits live user configuration.
//   DEPENDS: [node:fs/promises, node:os, node:path, node:url, jsonc-parser, src/commands/launch.ts, src/lib/vvoc-paths.ts]
//   LINKS: [M-RELEASE-AUTOMATION, VF-RELEASE-AUTOMATION]
//   ROLE: SCRIPT
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   LocalTuiArguments - Parsed local-launch scope and forwarded OpenCode arguments.
//   PreparedLocalTuiLaunch - Temporary cli.json, plugin forwarder, command, and environment for one local TUI run.
//   parseLocalTuiArguments - Removes the local --scope option while preserving OpenCode passthrough arguments.
//   renderLocalCliConfig - Merges the local plugin directory into an existing cli.json while preserving unrelated settings and comments.
//   createLocalTuiEnvironment - Combines selected config paths with an isolated XDG config home.
//   prepareLocalTuiLaunch - Resolves normal launch sources, writes the forwarder and temporary cli.json.
//   parseScope - Validates the local launch scope option.
//   runBuild - Builds the local package before launch.
//   main - Runs the isolated local TUI launch workflow.
//   isManagedVvocEntry - True when a cli.json plugin entry targets the vvoc package.
//   isRecord - Narrow a value to a plain record.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-008 - Replaced the removed V1 tui.json/opencodeTuiSource flow with the native cli.json plugin directory forwarder.]
// END_CHANGE_SUMMARY

import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyEdits, modify, parse } from "jsonc-parser";
import { buildLaunchPlan, type LaunchScope } from "../src/commands/launch.ts";
import { getGlobalOpencodeDir } from "../src/lib/vvoc-paths.ts";

export type LocalTuiArguments = {
  scope: LaunchScope;
  passthroughArgs: string[];
};

export type PreparedLocalTuiLaunch = {
  command: string[];
  env: NodeJS.ProcessEnv;
  tempRoot: string;
  cliConfigPath: string;
  pluginDir: string;
  pluginSpec: string;
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

/**
 * Merge the local plugin directory specifier into the existing cli.json plugin
 * list, dropping any previously managed vvoc entry, and preserve comments and
 * unrelated settings the user already has.
 */
export function renderLocalCliConfig(currentText: string | undefined, pluginSpec: string): string {
  const text = currentText !== undefined && currentText.trim().length > 0 ? currentText : "{}\n";
  const existing = parse(text) as unknown;
  const plugins =
    isRecord(existing) && Array.isArray(existing.plugins) ? existing.plugins : [];
  const filtered = plugins.filter((entry) => !isManagedVvocEntry(entry));
  const edits = modify(text, ["plugins"], [...filtered, pluginSpec], {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  return applyEdits(text, edits);
}

export function createLocalTuiEnvironment(options: {
  baseEnv: NodeJS.ProcessEnv;
  launchEnv: Record<string, string>;
  isolatedConfigHome: string;
}): NodeJS.ProcessEnv {
  return {
    ...options.baseEnv,
    ...options.launchEnv,
    XDG_CONFIG_HOME: options.isolatedConfigHome,
  };
}

export async function prepareLocalTuiLaunch(options: {
  repoRoot: string;
  cwd: string;
  scope: LaunchScope;
  passthroughArgs: string[];
  env: NodeJS.ProcessEnv;
  configHome?: string | undefined;
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
    // A native local plugin target must be a directory exposing a `tui` entry.
    const pluginDir = join(tempRoot, "plugin");
    await mkdir(pluginDir, { recursive: true });
    const forwarded = pathToFileURL(pluginPath).href;
    await writeFile(
      join(pluginDir, "tui.js"),
      `export * from ${JSON.stringify(forwarded)};\nexport { default } from ${JSON.stringify(forwarded)};\n`,
      "utf8",
    );

    const configHome = options.configHome ?? options.env.XDG_CONFIG_HOME;
    const sourceCliPath = join(
      configHome === undefined ? getGlobalOpencodeDir() : getGlobalOpencodeDir(configHome),
      "cli.json",
    );
    const currentText = await readFile(sourceCliPath, "utf8").catch(() => undefined);
    const pluginSpec = pathToFileURL(pluginDir).href;
    const cliConfigPath = join(tempRoot, "opencode", "cli.json");
    await mkdir(dirname(cliConfigPath), { recursive: true });
    await writeFile(cliConfigPath, renderLocalCliConfig(currentText, pluginSpec), "utf8");

    return {
      command: launch.command,
      env: createLocalTuiEnvironment({
        baseEnv: options.env,
        launchEnv: launch.env,
        isolatedConfigHome: tempRoot,
      }),
      tempRoot,
      cliConfigPath,
      pluginDir,
      pluginSpec,
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

  console.log(`Local TUI plugin directory: ${launch.pluginDir}`);
  console.log(`Temporary cli.json: ${launch.cliConfigPath}`);
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

function isManagedVvocEntry(entry: unknown): boolean {
  const value =
    typeof entry === "string"
      ? entry
      : isRecord(entry) && typeof entry.package === "string"
        ? entry.package
        : "";
  return value.includes("@osovv/vv-opencode");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
