import { homedir } from "node:os";
import { join } from "node:path";

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

export function getGlobalOpencodeDir(configHomeOverride?: string): string {
  return join(getConfigHome(configHomeOverride), "opencode");
}

export function getGlobalVvocDir(configHomeOverride?: string): string {
  return join(getConfigHome(configHomeOverride), "vvoc");
}

export function getProjectVvocDir(cwd: string): string {
  return join(cwd, VVOC_DIRECTORY_NAME);
}

export function getProjectLegacyOpencodeDir(cwd: string): string {
  return join(cwd, ".opencode");
}
