// FILE: src/lib/vvoc-paths.ts
// VERSION: 0.2.6
// START_MODULE_CONTRACT
//   PURPOSE: Resolve vvoc and OpenCode config/data roots from XDG and project-local conventions.
//   SCOPE: XDG config/data home lookup, vvoc root derivation, managed agent directory resolution, and deterministic project data directory naming.
//   DEPENDS: [node:os, node:path, node:crypto]
//   LINKS: [M-CLI-CONFIG, M-PLUGIN-MEMORY-STORE, M-PLUGIN-GUARDIAN]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   VVOC_DIRECTORY_NAME - Project-local vvoc directory name.
//   getConfigHome - Resolves the effective XDG config home.
//   getDataHome - Resolves the effective XDG data home.
//   getGlobalOpencodeDir - Resolves the global OpenCode config directory.
//   getGlobalVvocDir - Resolves the global vvoc config directory.
//   getVvocAgentsDir - Resolves the managed vvoc subagent prompt directory for a vvoc config root.
//   getGlobalVvocDataDir - Resolves the global vvoc data directory.
//   getGlobalVvocProjectDataDir - Resolves a deterministic per-project data directory inside the vvoc data root.
//   getProjectVvocDir - Resolves the project-local vvoc config directory.
//   getProjectLegacyOpencodeDir - Resolves the old project-local OpenCode directory path.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.2.6 - Added a shared helper for managed vvoc subagent prompt directories.]
// END_CHANGE_SUMMARY

import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import crypto from "node:crypto";

export const VVOC_DIRECTORY_NAME = ".vvoc";

export function getConfigHome(configHomeOverride?: string): string {
  if (typeof configHomeOverride === "string" && configHomeOverride.trim()) {
    return configHomeOverride.trim();
  }

  if (typeof process.env.XDG_CONFIG_HOME === "string" && process.env.XDG_CONFIG_HOME.trim()) {
    return process.env.XDG_CONFIG_HOME.trim();
  }

  return join(homedir(), ".config");
}

export function getDataHome(dataHomeOverride?: string): string {
  if (typeof dataHomeOverride === "string" && dataHomeOverride.trim()) {
    return dataHomeOverride.trim();
  }

  if (typeof process.env.XDG_DATA_HOME === "string" && process.env.XDG_DATA_HOME.trim()) {
    return process.env.XDG_DATA_HOME.trim();
  }

  return join(homedir(), ".local", "share");
}

export function getGlobalOpencodeDir(configHomeOverride?: string): string {
  return join(getConfigHome(configHomeOverride), "opencode");
}

export function getGlobalVvocDir(configHomeOverride?: string): string {
  return join(getConfigHome(configHomeOverride), "vvoc");
}

export function getVvocAgentsDir(vvocDir: string): string {
  return join(vvocDir, "agents");
}

export function getGlobalVvocDataDir(dataHomeOverride?: string): string {
  return join(getDataHome(dataHomeOverride), "vvoc");
}

export function getGlobalVvocProjectDataDir(cwd: string, dataHomeOverride?: string): string {
  const resolved = resolve(cwd);
  const name = sanitizeSegment(basename(resolved) || "project");
  const hash = crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 12);
  return join(getGlobalVvocDataDir(dataHomeOverride), "projects", `${name}-${hash}`);
}

export function getProjectVvocDir(cwd: string): string {
  return join(cwd, VVOC_DIRECTORY_NAME);
}

export function getProjectLegacyOpencodeDir(cwd: string): string {
  return join(cwd, ".opencode");
}

function sanitizeSegment(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
  return normalized || "project";
}
