// FILE: src/lib/rebind-request.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Persist and read one-shot, project-directory-scoped rebind requests written by the CLI and consumed lazily by the running snapshot service.
//   SCOPE: Marker naming, atomic write, best-effort listing with TTL pruning, removal, strict decoding, and matching by project directory plus optional session. No config mutation, no credential values.
//   DEPENDS: [node:fs/promises, node:path, src/lib/vvoc-paths.ts]
//   LINKS: [M-CLI-PRESET, M-CLI-PLUGIN-TOGGLE, M-CLI-ROLE, M-NATIVE-RUNTIME]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   REBIND_REQUEST_DIR_NAME - Directory name holding pending rebind request markers.
//   REBIND_REQUEST_TTL_MS - Age after which an unapplied marker is pruned and ignored.
//   RebindRequest - One project-directory-scoped rebind request marker.
//   writeRebindRequest - Atomically write a rebind request marker and return it.
//   requestRebind - Write a marker only when the force flag is set.
//   listRebindRequests - List live markers, pruning malformed or expired ones.
//   removeRebindRequest - Remove one marker by id.
//   rebindRequestMatches - True when a marker targets the given directory and optional session.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-SNAPSHOT-ANCHORING-REDESIGN T-006 - Added the project-directory-scoped rebind request marker shared by the CLI force flags and the lazy runtime consumer.]
// END_CHANGE_SUMMARY

import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { getGlobalVvocDataDir } from "./vvoc-paths.js";

/** Directory name (inside the vvoc data dir) holding pending rebind request markers. */
export const REBIND_REQUEST_DIR_NAME = "rebind";

/** Age after which an unapplied marker is pruned and ignored, so stale requests cannot surprise a later session. */
export const REBIND_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

/** One project-directory-scoped rebind request written by the CLI and consumed lazily by the runtime. */
export interface RebindRequest {
  readonly id: string;
  readonly requestedAt: number;
  readonly directory: string;
  readonly sessionId?: string;
}

function requestsDir(dataDir?: string): string {
  return join(dataDir ?? getGlobalVvocDataDir(), REBIND_REQUEST_DIR_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function decodeRebindRequest(text: string): RebindRequest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== "string" ||
    typeof value.requestedAt !== "number" ||
    typeof value.directory !== "string"
  ) {
    return undefined;
  }
  if (value.sessionId !== undefined && typeof value.sessionId !== "string") return undefined;
  return {
    id: value.id,
    requestedAt: value.requestedAt,
    directory: value.directory,
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
  };
}

/** Atomically write a project-directory-scoped rebind request marker. */
export async function writeRebindRequest(input: {
  readonly directory: string;
  readonly sessionId?: string | undefined;
  readonly dataDir?: string | undefined;
  readonly now?: number | undefined;
}): Promise<RebindRequest> {
  const requestedAt = input.now ?? Date.now();
  const id = `${requestedAt}-${randomBytes(4).toString("hex")}`;
  const sessionId = input.sessionId?.trim();
  const request: RebindRequest = {
    id,
    requestedAt,
    directory: resolve(input.directory),
    ...(sessionId === undefined || sessionId === "" ? {} : { sessionId }),
  };
  const dir = requestsDir(input.dataDir);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${id}.json`);
  const temporary = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, JSON.stringify(request), { mode: 0o600 });
  await rename(temporary, path);
  return request;
}

/** Write a marker only when `force` is set; return it, or undefined when no rebind was requested. */
export async function requestRebind(input: {
  readonly force: boolean;
  readonly directory: string;
  readonly sessionId?: string | undefined;
  readonly dataDir?: string | undefined;
  readonly now?: number | undefined;
}): Promise<RebindRequest | undefined> {
  if (!input.force) return undefined;
  return writeRebindRequest(input);
}

/** List live markers, pruning malformed and expired files so requests stay one-shot and bounded. */
export async function listRebindRequests(
  options: {
    readonly dataDir?: string | undefined;
    readonly now?: number | undefined;
    readonly ttlMs?: number | undefined;
  } = {},
): Promise<readonly RebindRequest[]> {
  const dir = requestsDir(options.dataDir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const now = options.now ?? Date.now();
  const ttl = options.ttlMs ?? REBIND_REQUEST_TTL_MS;
  const live: RebindRequest[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const request = decodeRebindRequest(text);
    if (request === undefined || now - request.requestedAt > ttl) {
      await rm(path, { force: true }).catch(() => undefined);
      continue;
    }
    live.push(request);
  }
  return live;
}

/** Remove one marker by id; used when a request is explicitly consumed. */
export async function removeRebindRequest(
  id: string,
  options: { readonly dataDir?: string | undefined } = {},
): Promise<void> {
  await rm(join(requestsDir(options.dataDir), `${id}.json`), { force: true });
}

/** True when a marker targets the given project directory and, when set, the given session. */
export function rebindRequestMatches(
  request: RebindRequest,
  input: { readonly directory: string; readonly sessionId?: string | undefined },
): boolean {
  if (resolve(input.directory) !== resolve(request.directory)) return false;
  if (request.sessionId !== undefined && request.sessionId !== input.sessionId) return false;
  return true;
}
