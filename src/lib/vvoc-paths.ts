// FILE: src/lib/vvoc-paths.ts
// VERSION: 0.4.0
// START_MODULE_CONTRACT
//   PURPOSE: Resolve global vvoc and OpenCode config/data roots from XDG conventions.
//   SCOPE: XDG config/data home lookup, canonical vvoc config path derivation, managed agent directory resolution, and deterministic project data directory naming.
//   DEPENDS: [node:os, node:path, node:crypto]
//   LINKS: [M-CLI-CONFIG, M-PLUGIN-MEMORY-STORE, M-PLUGIN-GUARDIAN]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   getConfigHome - Resolves the effective XDG config home.
//   getDataHome - Resolves the effective XDG data home.
//   getGlobalOpencodeDir - Resolves the global OpenCode config directory.
//   VVOC_CONFIG_FILE_NAME - Canonical vvoc config file name.
//   getGlobalVvocDir - Resolves the global vvoc config directory.
//   getGlobalVvocConfigPath - Resolves the canonical global vvoc config file path.
//   getVvocAgentsDir - Resolves the managed vvoc subagent prompt directory for a vvoc config root.
//   getGlobalVvocDataDir - Resolves the global vvoc data directory.
//   getGlobalVvocProjectDataDir - Resolves a deterministic per-project data directory inside the vvoc data root.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.4.0 - Removed project-local config path helpers now that vvoc manages global OpenCode and agent paths only.]
// END_CHANGE_SUMMARY

import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import crypto from "node:crypto";

export const VVOC_CONFIG_FILE_NAME = "vvoc.json";

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

export function getGlobalVvocConfigPath(configHomeOverride?: string): string {
  return join(getGlobalVvocDir(configHomeOverride), VVOC_CONFIG_FILE_NAME);
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

function sanitizeSegment(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
  return normalized || "project";
}
