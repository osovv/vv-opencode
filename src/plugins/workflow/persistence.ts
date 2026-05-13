// FILE: src/plugins/workflow/persistence.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Hydrate and snapshot work-item workflow state from/to per-session JSON
//     files under $XDG_DATA_HOME/vvoc/workflow/<sessionId>/workflow-state.json.
//   SCOPE: Read/write WorkItemStoreData (nextId, records, keyIndexBySession) as
//     serializable JSON. Directory auto-creation on snapshot. Safe null return on
//     missing or corrupt files.
//   DEPENDS: [node:fs, node:path, src/lib/vvoc-paths.ts, src/plugins/workflow/state.ts]
//   LINKS: [M-WORKFLOW-PERSISTENCE]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   PersistedWorkflowState - JSON-serializable shape of a per-session workflow state.
//   getWorkflowSessionDir - Resolve per-session directory path.
//   hydrateWorkflowState - Read and parse per-session workflow-state.json.
//   snapshotWorkflowState - Write per-session workflow-state.json.
//   deleteWorkflowSessionDir - Remove per-session workflow directory on session delete.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Initial implementation of per-session hydrate/snapshot.]
// END_CHANGE_SUMMARY

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { getGlobalVvocDataDir } from "../../lib/vvoc-paths.js";
import type { WorkItemRecord, WorkItemStoreData } from "./state.js";

// START_BLOCK_SERIALIZATION_TYPES
/**
 * JSON-serializable shape of a per-session workflow state.
 * Maps are converted to plain objects for JSON compatibility.
 */
export type PersistedWorkflowState = {
  version: 1;
  updatedAt: string;
  sessionId: string;
  nextId: number;
  /** WorkItemRecord[] sorted by creation order. */
  records: WorkItemRecord[];
  /** key -> workItemId lookup for idempotent open-by-key. */
  keyIndex: Record<string, string>;
};
// END_BLOCK_SERIALIZATION_TYPES

/**
 * Resolve the per-session workflow data directory.
 * Path: $XDG_DATA_HOME/vvoc/workflow/<sessionId>/
 */
export function getWorkflowSessionDir(sessionId: string): string {
  return join(getGlobalVvocDataDir(), "workflow", sessionId);
}

/**
 * Resolve the per-session workflow-state.json file path.
 */
function getWorkflowStatePath(sessionId: string): string {
  return join(getWorkflowSessionDir(sessionId), "workflow-state.json");
}

// START_CONTRACT: hydrateWorkflowState
//   PURPOSE: Read and parse the per-session workflow-state.json, returning a
//     WorkItemStoreData suitable for restoring an in-memory store. Returns null
//     when the file is missing or corrupt. Never throws.
//   INPUTS: { sessionId: string - OpenCode session identifier }
//   OUTPUTS: { WorkItemStoreData | null - restored store data or null }
//   SIDE_EFFECTS: [none]
//   LINKS: [M-WORKFLOW-PERSISTENCE]
// END_CONTRACT: hydrateWorkflowState
export function hydrateWorkflowState(sessionId: string): WorkItemStoreData | null {
  try {
    const filePath = getWorkflowStatePath(sessionId);
    if (!existsSync(filePath)) {
      return null;
    }

    const raw = readFileSync(filePath, "utf-8");
    const parsed: PersistedWorkflowState = JSON.parse(raw);

    // Validate minimal expected shape
    if (parsed.version !== 1 || !Array.isArray(parsed.records)) {
      return null;
    }

    // Reconstruct Maps from serialized arrays
    const records = new Map<string, WorkItemRecord>();
    for (const record of parsed.records) {
      const lookupKey = `${sessionId}::${record.workItemId}`;
      records.set(lookupKey, record);
    }

    const keyIndex = new Map<string, string>();
    for (const [key, workItemId] of Object.entries(parsed.keyIndex ?? {})) {
      keyIndex.set(key, workItemId);
    }

    const keyIndexBySession = new Map<string, Map<string, string>>();
    keyIndexBySession.set(sessionId, keyIndex);

    return {
      nextId: parsed.nextId,
      records,
      keyIndexBySession,
    };
  } catch {
    // Corrupt file, missing permissions, etc. — start fresh
    return null;
  }
}

// START_CONTRACT: snapshotWorkflowState
//   PURPOSE: Serialize WorkItemStoreData to a per-session JSON file. Creates the
//     session directory if it does not exist. Logs warnings on write failure but
//     never throws so in-memory operations continue.
//   INPUTS: {
//     sessionId: string - OpenCode session identifier,
//     data: WorkItemStoreData - current in-memory store data
//   }
//   OUTPUTS: { void }
//   SIDE_EFFECTS: [Writes JSON file to $XDG_DATA_HOME/vvoc/workflow/<sessionId>/workflow-state.json]
//   LINKS: [M-WORKFLOW-PERSISTENCE]
// END_CONTRACT: snapshotWorkflowState
export function snapshotWorkflowState(sessionId: string, data: WorkItemStoreData): void {
  try {
    const dir = getWorkflowSessionDir(sessionId);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Convert records Map to array
    const records: WorkItemRecord[] = [];
    for (const record of data.records.values()) {
      if (record.sessionId === sessionId) {
        records.push(record);
      }
    }

    // Convert keyIndex for this session to plain object
    const sessionKeyIndex = data.keyIndexBySession.get(sessionId);
    const keyIndex: Record<string, string> = {};
    if (sessionKeyIndex) {
      for (const [key, workItemId] of sessionKeyIndex) {
        keyIndex[key] = workItemId;
      }
    }

    const persisted: PersistedWorkflowState = {
      version: 1,
      updatedAt: new Date().toISOString(),
      sessionId,
      nextId: data.nextId,
      records,
      keyIndex,
    };

    writeFileSync(getWorkflowStatePath(sessionId), JSON.stringify(persisted, null, 2), "utf-8");
  } catch {
    // Write failure — warn but do not block in-memory operations
    // The caller (index.ts) will log this via client.app.log
  }
}

// START_CONTRACT: deleteWorkflowSessionDir
//   PURPOSE: Remove the per-session workflow data directory. No-op if it does
//     not exist. Never throws.
//   INPUTS: { sessionId: string - OpenCode session identifier }
//   OUTPUTS: { Promise<void> }
//   SIDE_EFFECTS: [Deletes per-session directory and files]
//   LINKS: [M-WORKFLOW-PERSISTENCE]
// END_CONTRACT: deleteWorkflowSessionDir
export async function deleteWorkflowSessionDir(sessionId: string): Promise<void> {
  try {
    const dir = getWorkflowSessionDir(sessionId);
    if (existsSync(dir)) {
      await rm(dir, { recursive: true, force: true });
    }
  } catch {
    // Cleanup failure — warn but do not block
  }
}
