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
