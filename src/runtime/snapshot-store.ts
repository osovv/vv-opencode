// FILE: src/runtime/snapshot-store.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Persist durable per-family policy captures and staged admission candidates under the vvoc data directory with atomic writes, project-scoped isolation, integrity verification, and fail-closed reads.
//   SCOPE: File-backed SnapshotStore implementation, project-scoped snapshot root resolution, atomic write/rename, candidate staging files, family listing, content-integrity recomputation, deep-frozen immutable reads, and strict shape validation that rejects corrupt or foreign state. No admission logic, no native client, no host mutation.
//   DEPENDS: [node:crypto, node:fs/promises, node:path, src/runtime/types.ts, src/lib/vvoc-paths.ts]
//   LINKS: [M-NATIVE-RUNTIME, V-M-NATIVE-RUNTIME]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SNAPSHOT_STORE_DIR_NAME - Directory name holding vvoc family snapshots inside the vvoc data dir.
//   FileSnapshotStoreOptions - Project scope and optional data-dir override for the file store.
//   createFileSnapshotStore - Build a durable file-backed SnapshotStore for one project scope.
//   snapshotScopeDirName - Stable, collision-free directory name for one project scope.
//   familyCaptureIntegrity - Recompute the behavior-relevant content digest of a capture.
//   decodeFamilyCapture - Strictly validate and integrity-check a persisted family capture.
//   decodeStagedCandidate - Strictly validate a persisted staged candidate.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-002 - Exclude capturedAt from the behavior integrity projection so unchanged restaging keeps one stable revision and snapshot id.]
// END_CHANGE_SUMMARY

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseVvocConfigText } from "../lib/vvoc-config.js";
import { getGlobalVvocDataDir } from "../lib/vvoc-paths.js";
import {
  SnapshotStoreError,
  type FamilyCapture,
  type SnapshotStore,
  type StagedCandidate,
} from "./types.js";

/** Directory name holding vvoc family snapshots inside the vvoc data dir. */
export const SNAPSHOT_STORE_DIR_NAME = "snapshots";

/** Project scope and optional data-dir override for the file store. */
export interface FileSnapshotStoreOptions {
  /**
   * Project scope key (project id). Family captures live under one project so a
   * moved worktree still resolves its root while another project cannot read it.
   */
  readonly scopeKey: string;
  /** Override the vvoc data dir root; defaults to `$XDG_DATA_HOME/vvoc`. */
  readonly dataDir?: string | undefined;
}

/** Stable, collision-free directory name for one project scope. */
export function snapshotScopeDirName(scopeKey: string): string {
  return createHash("sha256").update(scopeKey).digest("hex").slice(0, 32);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Behavior-relevant projection used for integrity. Generated variant ids and the
 * snapshot id are excluded so the digest is stable and recomputable while still
 * covering every policy, native overlay, and source variant that changes payload.
 */
function integrityProjection(capture: FamilyCapture): string {
  return JSON.stringify({
    familyId: capture.familyId,
    // `capturedAt` is an observation timestamp, never behavior: excluding it keeps
    // the digest (and snapshot id) stable across unchanged restaging so a repeat
    // admission is idempotent instead of creating a new revision.
    location: capture.location,
    roles: capture.roles,
    roleModels: capture.roleModels,
    agents: capture.agents,
    variants: [...capture.variants]
      .map((variant) => ({
        providerID: variant.providerID,
        modelID: variant.modelID,
        sourceVariant: variant.sourceVariant ?? null,
        settings: variant.settings ?? null,
        body: variant.body ?? null,
        headers: variant.headers ?? null,
      }))
      .sort((left, right) =>
        `${left.providerID}/${left.modelID}/${left.sourceVariant}`.localeCompare(
          `${right.providerID}/${right.modelID}/${right.sourceVariant}`,
        ),
      ),
    modelSettings: capture.modelSettings,
    vvoc: capture.vvoc,
    rawIntent: capture.rawIntent ?? null,
    rootSelection: capture.rootSelection ?? null,
    modelOverride: capture.modelOverride ?? null,
    intent: capture.intent,
  });
}

/** Recompute the behavior-relevant content digest of a capture. */
export function familyCaptureIntegrity(capture: FamilyCapture): string {
  return createHash("sha256").update(integrityProjection(capture)).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return Object.freeze(value);
}

function decodeSelection(value: unknown): FamilyCapture["roleModels"][string] | undefined {
  if (!isRecord(value)) return undefined;
  const { providerID, modelID, variant } = value;
  if (typeof providerID !== "string" || typeof modelID !== "string") return undefined;
  if (variant !== undefined && typeof variant !== "string") return undefined;
  return { providerID, modelID, ...(variant === undefined ? {} : { variant }) };
}

function decodeSelections(
  value: unknown,
): Record<string, FamilyCapture["roleModels"][string]> | undefined {
  if (!isRecord(value)) return undefined;
  const decoded: Record<string, FamilyCapture["roleModels"][string]> = {};
  for (const [key, entry] of Object.entries(value)) {
    const selection = decodeSelection(entry);
    if (selection === undefined) return undefined;
    decoded[key] = selection;
  }
  return decoded;
}

function decodeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const decoded: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") return undefined;
    decoded[key] = entry;
  }
  return decoded;
}

function decodeVariants(value: unknown): FamilyCapture["variants"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const decoded: Array<FamilyCapture["variants"][number]> = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.id !== "string") return undefined;
    if (typeof entry.providerID !== "string" || typeof entry.modelID !== "string") return undefined;
    if (entry.sourceVariant !== undefined && typeof entry.sourceVariant !== "string") {
      return undefined;
    }
    const recorded: {
      id: string;
      providerID: string;
      modelID: string;
      sourceVariant?: string;
      settings?: Readonly<Record<string, unknown>>;
      body?: Readonly<Record<string, unknown>>;
      headers?: Readonly<Record<string, string>>;
    } = { id: entry.id, providerID: entry.providerID, modelID: entry.modelID };
    if (entry.sourceVariant !== undefined) recorded.sourceVariant = entry.sourceVariant;
    if (entry.settings !== undefined) {
      if (!isRecord(entry.settings)) return undefined;
      recorded.settings = entry.settings;
    }
    if (entry.body !== undefined) {
      if (!isRecord(entry.body)) return undefined;
      recorded.body = entry.body;
    }
    if (entry.headers !== undefined) {
      const headers = decodeStringRecord(entry.headers);
      if (headers === undefined) return undefined;
      recorded.headers = headers;
    }
    decoded.push(recorded);
  }
  return decoded;
}

function decodeModelSettings(value: unknown): FamilyCapture["modelSettings"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const decoded: Array<FamilyCapture["modelSettings"][number]> = [];
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    const selection = decodeSelection(entry);
    if (selection === undefined) return undefined;
    const recorded: {
      providerID: string;
      modelID: string;
      variant?: string;
      settings?: Readonly<Record<string, unknown>>;
      body?: Readonly<Record<string, unknown>>;
      headers?: Readonly<Record<string, string>>;
    } = selection;
    if (entry.settings !== undefined) {
      if (!isRecord(entry.settings)) return undefined;
      recorded.settings = entry.settings;
    }
    if (entry.body !== undefined) {
      if (!isRecord(entry.body)) return undefined;
      recorded.body = entry.body;
    }
    if (entry.headers !== undefined) {
      const headers = decodeStringRecord(entry.headers);
      if (headers === undefined) return undefined;
      recorded.headers = headers;
    }
    decoded.push(recorded);
  }
  return decoded;
}

function decodeRawIntent(value: unknown): FamilyCapture["rawIntent"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  if (value.model !== undefined && typeof value.model !== "string") return undefined;
  if (value.smallModel !== undefined && typeof value.smallModel !== "string") return undefined;
  if (value.sourcePath !== undefined && typeof value.sourcePath !== "string") return undefined;
  const agents = decodeStringRecord(value.agents);
  const commands = decodeStringRecord(value.commands);
  if (agents === undefined || commands === undefined) return undefined;
  return {
    ...(value.model === undefined ? {} : { model: value.model }),
    ...(value.smallModel === undefined ? {} : { smallModel: value.smallModel }),
    agents,
    commands,
    ...(value.sourcePath === undefined ? {} : { sourcePath: value.sourcePath }),
  };
}

function decodeAgents(value: unknown): FamilyCapture["agents"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const decoded: Array<FamilyCapture["agents"][number]> = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.agentID !== "string") return undefined;
    if (entry.role !== undefined && typeof entry.role !== "string") return undefined;
    const selection = entry.selection === undefined ? undefined : decodeSelection(entry.selection);
    if (entry.selection !== undefined && selection === undefined) return undefined;
    decoded.push({
      agentID: entry.agentID,
      ...(entry.role === undefined ? {} : { role: entry.role }),
      ...(selection === undefined ? {} : { selection }),
    });
  }
  return decoded;
}

function decodeIntent(value: unknown): FamilyCapture["intent"] | undefined {
  if (!isRecord(value)) return undefined;
  const { mode, source, roleRef, literal } = value;
  if (mode !== "explicit" && mode !== "implicit" && mode !== "staged") return undefined;
  if (source !== "config" && source !== "switch" && source !== "watcher" && source !== "preset") {
    return undefined;
  }
  if (roleRef !== undefined && typeof roleRef !== "string") return undefined;
  const decodedLiteral = literal === undefined ? undefined : decodeSelection(literal);
  if (literal !== undefined && decodedLiteral === undefined) return undefined;
  return {
    mode,
    source,
    ...(roleRef === undefined ? {} : { roleRef }),
    ...(decodedLiteral === undefined ? {} : { literal: decodedLiteral }),
  };
}

function decodeIdentity(value: unknown): FamilyCapture["location"] | undefined {
  if (!isRecord(value)) return undefined;
  const { directory, workspaceID, projectID, canonical } = value;
  if (
    typeof directory !== "string" ||
    typeof projectID !== "string" ||
    typeof canonical !== "string" ||
    (workspaceID !== undefined && typeof workspaceID !== "string")
  ) {
    return undefined;
  }
  return { directory, ...(workspaceID === undefined ? {} : { workspaceID }), projectID, canonical };
}

/** Strictly validate and integrity-check a persisted family capture. */
export function decodeFamilyCapture(value: unknown): FamilyCapture | undefined {
  if (!isRecord(value)) return undefined;
  if (value.schemaVersion !== 1) return undefined;
  if (typeof value.snapshotId !== "string" || typeof value.integrity !== "string") return undefined;
  if (typeof value.familyId !== "string") return undefined;
  if (typeof value.capturedAt !== "number" || !Number.isFinite(value.capturedAt)) return undefined;
  const location = decodeIdentity(value.location);
  if (location === undefined) return undefined;
  const roles = decodeStringRecord(value.roles);
  if (roles === undefined) return undefined;
  const roleModels = decodeSelections(value.roleModels);
  if (roleModels === undefined) return undefined;
  const agents = decodeAgents(value.agents);
  if (agents === undefined) return undefined;
  const variants = decodeVariants(value.variants);
  if (variants === undefined) return undefined;
  const modelSettings = decodeModelSettings(value.modelSettings);
  if (modelSettings === undefined) return undefined;
  if (!isRecord(value.vvoc)) return undefined;
  let vvoc;
  try {
    // Re-validate the captured document with the canonical strict parser; never trust raw bytes.
    vvoc = parseVvocConfigText(JSON.stringify(value.vvoc), `snapshot:${value.familyId}`);
  } catch {
    return undefined;
  }
  const rawIntent = decodeRawIntent(value.rawIntent);
  if (value.rawIntent !== undefined && rawIntent === undefined) return undefined;
  const intent = decodeIntent(value.intent);
  if (intent === undefined) return undefined;
  const modelOverride =
    value.modelOverride === undefined ? undefined : decodeSelection(value.modelOverride);
  if (value.modelOverride !== undefined && modelOverride === undefined) return undefined;
  const rootSelection =
    value.rootSelection === undefined ? undefined : decodeSelection(value.rootSelection);
  if (value.rootSelection !== undefined && rootSelection === undefined) return undefined;

  const decoded: FamilyCapture = deepFreeze({
    schemaVersion: 1,
    snapshotId: value.snapshotId,
    integrity: value.integrity,
    familyId: value.familyId,
    capturedAt: value.capturedAt,
    location,
    roles,
    roleModels,
    agents,
    variants,
    modelSettings,
    vvoc,
    ...(rawIntent === undefined ? {} : { rawIntent }),
    ...(rootSelection === undefined ? {} : { rootSelection }),
    ...(modelOverride === undefined ? {} : { modelOverride }),
    intent,
  });

  // A mismatch means the persisted state is stale, tampered, or from an incompatible version.
  if (familyCaptureIntegrity(decoded) !== decoded.integrity) return undefined;
  return decoded;
}

/** Strictly validate a persisted staged candidate. */
export function decodeStagedCandidate(value: unknown): StagedCandidate | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.familyId !== "string" || typeof value.sessionID !== "string") return undefined;
  if (typeof value.stagedAt !== "number" || !Number.isFinite(value.stagedAt)) return undefined;
  if (typeof value.revision !== "string") return undefined;
  const selection = decodeSelection(value.selection);
  if (selection === undefined) return undefined;
  const before = value.before === undefined ? undefined : decodeSelection(value.before);
  if (value.before !== undefined && before === undefined) return undefined;
  const capture = decodeFamilyCapture(value.capture);
  if (capture === undefined) return undefined;
  return deepFreeze({
    familyId: value.familyId,
    sessionID: value.sessionID,
    stagedAt: value.stagedAt,
    revision: value.revision,
    selection,
    ...(before === undefined ? {} : { before }),
    capture,
  });
}

// START_BLOCK_FILE_STORE
/** Build a durable file-backed SnapshotStore for one project scope. */
export function createFileSnapshotStore(options: FileSnapshotStoreOptions): SnapshotStore {
  const baseDir = join(
    options.dataDir ?? getGlobalVvocDataDir(),
    SNAPSHOT_STORE_DIR_NAME,
    snapshotScopeDirName(options.scopeKey),
  );

  const capturePath = (familyId: string) => join(baseDir, `${encodeURIComponent(familyId)}.json`);
  const candidatePath = (familyId: string) =>
    join(baseDir, `${encodeURIComponent(familyId)}.candidate.json`);
  const markerPath = (familyId: string) =>
    join(baseDir, `${encodeURIComponent(familyId)}.bound.json`);

  async function readJson(path: string): Promise<unknown | undefined> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new SnapshotStoreError(`Snapshot state could not be read at ${path}.`, {
        cause: error,
      });
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new SnapshotStoreError(`Snapshot state at ${path} is not valid JSON.`, {
        cause: error,
      });
    }
  }

  async function writeAtomic(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    try {
      await writeFile(temp, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true });
      throw new SnapshotStoreError(`Snapshot state could not be written at ${path}.`, {
        cause: error,
      });
    }
  }

  return {
    async read(familyId) {
      const raw = await readJson(capturePath(familyId));
      if (raw === undefined) return undefined;
      const capture = decodeFamilyCapture(raw);
      if (capture === undefined) {
        throw new SnapshotStoreError(
          `Snapshot state for family ${familyId} is invalid; refusing to adopt current configuration.`,
        );
      }
      return capture;
    },
    async write(familyId, capture) {
      await writeAtomic(capturePath(familyId), capture);
    },
    async remove(familyId) {
      await rm(capturePath(familyId), { force: true });
    },
    async readCandidate(familyId) {
      const raw = await readJson(candidatePath(familyId));
      if (raw === undefined) return undefined;
      const candidate = decodeStagedCandidate(raw);
      if (candidate === undefined) {
        throw new SnapshotStoreError(
          `Staged admission candidate for family ${familyId} is invalid.`,
        );
      }
      return candidate;
    },
    async writeCandidate(candidate) {
      await writeAtomic(candidatePath(candidate.familyId), candidate);
    },
    async removeCandidate(familyId) {
      await rm(candidatePath(familyId), { force: true });
    },
    async readMarker(familyId) {
      const raw = await readJson(markerPath(familyId));
      return raw !== undefined;
    },
    async writeMarker(familyId) {
      await writeAtomic(markerPath(familyId), { bound: true });
    },
    async removeMarker(familyId) {
      await rm(markerPath(familyId), { force: true });
    },
    async list() {
      let entries: string[];
      try {
        entries = await readdir(baseDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw new SnapshotStoreError(`Snapshot directory could not be listed at ${baseDir}.`, {
          cause: error,
        });
      }
      const familyIds: string[] = [];
      for (const entry of entries) {
        if (
          !entry.endsWith(".json") ||
          entry.endsWith(".candidate.json") ||
          entry.endsWith(".bound.json")
        )
          continue;
        familyIds.push(decodeURIComponent(entry.slice(0, -".json".length)));
      }
      return familyIds;
    },
  };
}
// END_BLOCK_FILE_STORE
