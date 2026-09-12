// FILE: src/plugins/workflow/snapshots.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Conservative workspace-relative file-scope normalization and deterministic content fingerprints for delegated checkpoint review barriers.
//   SCOPE: Pure declared-path normalization against a trusted workspace root, filesystem-backed validation rejecting symlinks and unsupported entries, explicit absent-path representation, streaming SHA-256 content hashing with stability checks, and order-independent fingerprint serialization over covered acceptance attempts. No command execution, network access, or snapshot-copy directories.
//   DEPENDS: [node:crypto, node:fs, node:fs/promises, node:path, src/lib/workflow-contract.ts]
//   LINKS: [M-WORKFLOW-SNAPSHOTS, M-WORKFLOW-CHECKPOINTS, M-WORKFLOW-CONTRACT, V-M-WORKFLOW-SNAPSHOTS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   WorkflowScopeNormalizationError - Error codes returned by the pure scope normalizer.
//   NormalizeWorkflowScopeResult - Normalized relative path list or a rejection.
//   WorkflowSnapshotEntry - One declared path's observed status, content hash, size, and mode.
//   WorkflowSnapshot - Fingerprint plus the ordered entries it was computed from.
//   WorkflowSnapshotErrorCode - Error codes returned by snapshot capture.
//   CaptureWorkflowSnapshotInput - Trusted root, declared relative paths, and covered attempt ids.
//   CaptureWorkflowSnapshotResult - Captured snapshot or a rejection with a code and message.
//   areFileStatsConsistent - Internal coherence check between pre-read and post-read stats (exported for deterministic tests).
//   normalizeWorkflowScopePaths - Pure normalizer and validator for declared scope paths.
//   captureWorkflowSnapshot - Filesystem-backed deterministic fingerprint of the declared scope state.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-DELEGATED-WORKFLOW-ASTRA-PRESETS - Initial module: pure scope normalization plus streaming SHA-256 fingerprints with symlink/traversal rejection and explicit absent markers.]
// END_CHANGE_SUMMARY

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { normalizeDeclaredScopePath } from "../../lib/workflow-contract.js";

// START_BLOCK_SCOPE_TYPES
export type WorkflowScopeNormalizationError = "ROOT_MISMATCH" | "INVALID_PATH" | "DUPLICATE_PATH";

export type NormalizeWorkflowScopeResult =
  | { ok: true; paths: string[] }
  | { ok: false; code: WorkflowScopeNormalizationError; message: string };
// END_BLOCK_SCOPE_TYPES

// START_CONTRACT: normalizeWorkflowScopePaths
//   PURPOSE: Purely normalize and validate declared workspace-relative scope paths against a trusted absolute root.
//   INPUTS: { workspaceRoot: string - trusted absolute workspace root; declaredPaths: readonly string[] - declared relative paths }
//   OUTPUTS: { NormalizeWorkflowScopeResult - canonical unique relative path list or a rejection with a code }
//   SIDE_EFFECTS: None. No filesystem access; filesystem-backed checks happen in captureWorkflowSnapshot.
//   LINKS: [normalizeDeclaredScopePath, captureWorkflowSnapshot]
// END_CONTRACT: normalizeWorkflowScopePaths
export function normalizeWorkflowScopePaths(
  workspaceRoot: string,
  declaredPaths: readonly string[],
): NormalizeWorkflowScopeResult {
  if (typeof workspaceRoot !== "string" || !isAbsolute(workspaceRoot)) {
    return {
      ok: false,
      code: "ROOT_MISMATCH",
      message: `workspace root must be an absolute path, received: ${JSON.stringify(workspaceRoot)}`,
    };
  }

  const seen = new Set<string>();
  const paths: string[] = [];
  for (const declared of declaredPaths) {
    const normalized = normalizeDeclaredScopePath(declared);
    if (!normalized.ok) {
      return {
        ok: false,
        code: "INVALID_PATH",
        message: `declared scope path ${JSON.stringify(declared)} is malformed (${normalized.reason})`,
      };
    }
    if (seen.has(normalized.path)) {
      return {
        ok: false,
        code: "DUPLICATE_PATH",
        message: `declared scope path ${JSON.stringify(declared)} duplicates ${JSON.stringify(normalized.path)}`,
      };
    }
    seen.add(normalized.path);
    paths.push(normalized.path);
  }

  return { ok: true, paths };
}

// START_BLOCK_SNAPSHOT_TYPES
export interface WorkflowSnapshotEntry {
  /** Workspace-relative POSIX path as declared and normalized. */
  path: string;
  status: "file" | "absent";
  /** Hex SHA-256 of file content; present only for files. */
  contentSha256?: string;
  /** Byte size; present only for files. */
  size?: number;
  /** Permission bits (mode & 0o777); present only for files. */
  mode?: number;
}

export interface WorkflowSnapshot {
  /** Hex SHA-256 over the canonical serialization of all entries and covered attempts. */
  fingerprint: string;
  /** Entries sorted by path; absent paths are represented explicitly. */
  entries: WorkflowSnapshotEntry[];
}

export type WorkflowSnapshotErrorCode =
  | "ROOT_MISMATCH"
  | "INVALID_PATH"
  | "DUPLICATE_PATH"
  | "PATH_ESCAPES_ROOT"
  | "SYMLINK"
  | "UNSUPPORTED_ENTRY"
  | "READ_FAILED"
  | "CONCURRENT_MODIFICATION";

export interface CaptureWorkflowSnapshotInput {
  /** Trusted absolute workspace root (PluginInput/ToolContext directory or worktree). */
  workspaceRoot: string;
  /** Declared workspace-relative scope paths; absent files are represented explicitly. */
  declaredPaths: readonly string[];
  /** Stable accepted-attempt identities covered by the snapshot, in canonical sorted order. */
  coveredAttemptIds?: readonly string[];
}

export type CaptureWorkflowSnapshotResult =
  | { ok: true; snapshot: WorkflowSnapshot }
  | { ok: false; code: WorkflowSnapshotErrorCode; message: string };
// END_BLOCK_SNAPSHOT_TYPES

// START_BLOCK_STAT_CONSISTENCY
interface StableStatView {
  size: number;
  mtimeMs: number;
  ino: number;
}

/**
 * Coherence check between the pre-read and post-read stat of one file. Any
 * change in size, modification time, or inode identity means the streamed
 * bytes cannot be attributed to a single coherent file revision, so the
 * capture must fail instead of producing a plausible but wrong fingerprint.
 * Exported so deterministic tests can exercise the rejection directly.
 */
export function areFileStatsConsistent(before: StableStatView, after: StableStatView): boolean {
  return before.size === after.size && before.mtimeMs === after.mtimeMs && before.ino === after.ino;
}
// END_BLOCK_STAT_CONSISTENCY

// START_CONTRACT: captureWorkflowSnapshot
//   PURPOSE: Compute a deterministic fingerprint over the declared scope's current filesystem state and covered acceptance attempts.
//   INPUTS: { input: CaptureWorkflowSnapshotInput - trusted root, declared relative paths, optional covered attempt ids }
//   OUTPUTS: { Promise<CaptureWorkflowSnapshotResult> - snapshot with entries and fingerprint, or a coded rejection }
//   SIDE_EFFECTS: Reads declared files and directory metadata; never writes, executes commands, or touches the network.
//   LINKS: [normalizeWorkflowScopePaths, areFileStatsConsistent]
// END_CONTRACT: captureWorkflowSnapshot
export async function captureWorkflowSnapshot(
  input: CaptureWorkflowSnapshotInput,
): Promise<CaptureWorkflowSnapshotResult> {
  const normalized = normalizeWorkflowScopePaths(input.workspaceRoot, input.declaredPaths);
  if (!normalized.ok) return normalized;

  let realRoot: string;
  try {
    realRoot = await realpath(input.workspaceRoot);
  } catch (error) {
    return {
      ok: false,
      code: "ROOT_MISMATCH",
      message: `workspace root ${input.workspaceRoot} cannot be resolved: ${(error as Error).message}`,
    };
  }

  const rootStat = await lstat(realRoot).catch(() => null);
  if (!rootStat?.isDirectory()) {
    return {
      ok: false,
      code: "ROOT_MISMATCH",
      message: `workspace root ${input.workspaceRoot} is not a directory`,
    };
  }

  const entries: WorkflowSnapshotEntry[] = [];
  for (const relPath of normalized.paths) {
    // Reject symlinked or non-directory segments between the trusted root and
    // the declared file; a missing ancestor directory means the file is absent.
    const segments = relPath.split("/");
    let cursor = realRoot;
    let ancestorMissing = false;
    for (let i = 0; i < segments.length - 1; i++) {
      cursor = join(cursor, segments[i]);
      const stat = await lstat(cursor).catch(() => null);
      if (!stat) {
        ancestorMissing = true;
        break;
      }
      if (stat.isSymbolicLink()) {
        return {
          ok: false,
          code: "SYMLINK",
          message: `scope path ${relPath} traverses symlinked directory ${segments.slice(0, i + 1).join("/")}`,
        };
      }
      if (!stat.isDirectory()) {
        return {
          ok: false,
          code: "UNSUPPORTED_ENTRY",
          message: `scope path ${relPath} traverses non-directory entry ${segments.slice(0, i + 1).join("/")}`,
        };
      }
    }
    if (ancestorMissing) {
      entries.push({ path: relPath, status: "absent" });
      continue;
    }

    const target = join(realRoot, relPath);
    const containment = relative(realRoot, target);
    if (containment === "" || containment.startsWith("..") || isAbsolute(containment)) {
      return {
        ok: false,
        code: "PATH_ESCAPES_ROOT",
        message: `scope path ${relPath} resolves outside the workspace root`,
      };
    }

    let before: Awaited<ReturnType<typeof lstat>> | null = null;
    try {
      before = await lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return {
          ok: false,
          code: "READ_FAILED",
          message: `scope path ${relPath} could not be inspected: ${(error as Error).message}`,
        };
      }
    }
    if (!before) {
      entries.push({ path: relPath, status: "absent" });
      continue;
    }
    if (before.isSymbolicLink()) {
      return {
        ok: false,
        code: "SYMLINK",
        message: `scope path ${relPath} is a symbolic link`,
      };
    }
    if (!before.isFile()) {
      return {
        ok: false,
        code: "UNSUPPORTED_ENTRY",
        message: `scope path ${relPath} is not a regular file`,
      };
    }

    let contentSha: string;
    let byteCount: number;
    try {
      const hashed = await hashFileStream(target);
      contentSha = hashed.sha256;
      byteCount = hashed.bytes;
    } catch (error) {
      return {
        ok: false,
        code: "READ_FAILED",
        message: `scope path ${relPath} could not be read: ${(error as Error).message}`,
      };
    }

    const after = await lstat(target).catch(() => null);
    if (!after || !after.isFile()) {
      return {
        ok: false,
        code: "CONCURRENT_MODIFICATION",
        message: `scope path ${relPath} changed shape while being read`,
      };
    }
    const stable = areFileStatsConsistent(
      { size: before.size, mtimeMs: before.mtimeMs, ino: before.ino },
      { size: after.size, mtimeMs: after.mtimeMs, ino: after.ino },
    );
    if (!stable || byteCount !== before.size) {
      return {
        ok: false,
        code: "CONCURRENT_MODIFICATION",
        message: `scope path ${relPath} was modified while being read`,
      };
    }

    entries.push({
      path: relPath,
      status: "file",
      contentSha256: contentSha,
      size: before.size,
      mode: before.mode & 0o777,
    });
  }

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const attempts = [...(input.coveredAttemptIds ?? [])].sort();

  const hasher = createHash("sha256");
  hasher.update("vvoc-workflow-snapshot-v1\n");
  for (const attemptId of attempts) {
    hasher.update(`attempt\u0000${attemptId}\n`);
  }
  hasher.update("end-attempts\n");
  for (const entry of entries) {
    if (entry.status === "absent") {
      hasher.update(`${entry.path}\u0000absent\n`);
    } else {
      hasher.update(
        `${entry.path}\u0000file\u0000${(entry.mode ?? 0).toString(8).padStart(3, "0")}\u0000${entry.size}\u0000${entry.contentSha256}\n`,
      );
    }
  }

  return { ok: true, snapshot: { fingerprint: hasher.digest("hex"), entries } };
}

// START_BLOCK_STREAM_HASH
/** Stream one regular file through SHA-256 without buffering it fully in memory. */
async function hashFileStream(absolutePath: string): Promise<{ sha256: string; bytes: number }> {
  const hasher = createHash("sha256");
  let bytes = 0;
  const stream = createReadStream(absolutePath);
  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      hasher.update(buffer);
      bytes += buffer.byteLength;
    }
  } finally {
    stream.destroy();
  }
  return { sha256: hasher.digest("hex"), bytes };
}
// END_BLOCK_STREAM_HASH
