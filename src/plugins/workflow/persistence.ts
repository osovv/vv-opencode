// FILE: src/plugins/workflow/persistence.ts
// VERSION: 0.2.1
// START_MODULE_CONTRACT
//   PURPOSE: Hydrate and snapshot work-item workflow state from/to per-session JSON
//     files under $XDG_DATA_HOME/vvoc/workflow/<sessionId>/workflow-state.json.
//   SCOPE: Read/write WorkItemStoreData (nextId, records, keyIndexBySession) as
//     serializable JSON, including explicit work-item mode, review-round fields,
//     and optional bounded result excerpts.
//     Directory auto-creation on snapshot. Safe null return on missing, corrupt,
//     or incomplete persisted files.
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
//   LAST_CHANGE: [v0.2.2 - Validated optional bounded result excerpts during workflow state hydrate and snapshot round-trips.]
//   LAST_CHANGE: [v0.2.1 - Reworded persisted-state validation as corrupt/incomplete data handling while keeping fail-closed hydrate behavior.]
//   LAST_CHANGE: [v0.2.0 - Validated explicit workflow intent and review-round fields during hydrate so incomplete records fail closed.]
//   LAST_CHANGE: [v0.1.0 - Initial implementation of per-session hydrate/snapshot.]
// END_CHANGE_SUMMARY

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { getGlobalVvocDataDir } from "../../lib/vvoc-paths.js";
import type {
  ReviewerRole,
  ReviewRound,
  ReviewRoundResult,
  WorkflowResultExcerpt,
  WorkItemMode,
  WorkItemRecord,
  WorkItemState,
  WorkItemStoreData,
} from "./state.js";

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

const VALID_STATES: ReadonlySet<WorkItemState> = new Set([
  "open",
  "awaiting_implementer",
  "awaiting_reviews",
  "needs_context",
  "blocked",
  "ready_to_close",
  "closed",
]);

function isWorkItemMode(value: unknown): value is WorkItemMode {
  return value === "implementation" || value === "review_only";
}

function isReviewerRole(value: unknown): value is ReviewerRole {
  return value === "spec" || value === "code";
}

function isWorkflowResultExcerpt(value: unknown): value is WorkflowResultExcerpt {
  if (!value || typeof value !== "object") return false;
  const excerpt = value as WorkflowResultExcerpt;
  const hasValidLengthMetadata = excerpt.truncated
    ? excerpt.originalLength > excerpt.maxLength && excerpt.text.length === excerpt.maxLength
    : excerpt.originalLength === excerpt.text.length && excerpt.text.length <= excerpt.maxLength;
  return (
    (excerpt.source === "parsed_body" || excerpt.source === "normalized_output") &&
    typeof excerpt.text === "string" &&
    typeof excerpt.truncated === "boolean" &&
    Number.isInteger(excerpt.originalLength) &&
    Number.isInteger(excerpt.maxLength) &&
    excerpt.maxLength > 0 &&
    hasValidLengthMetadata
  );
}

function isReviewRoundResult(value: unknown): value is ReviewRoundResult {
  if (!value || typeof value !== "object") return false;
  const result = value as ReviewRoundResult;
  return (
    isReviewerRole(result.reviewer) &&
    (result.agent === "vv-spec-reviewer" || result.agent === "vv-code-reviewer") &&
    (result.status === "PASS" || result.status === "FAIL" || result.status === "NEEDS_CONTEXT") &&
    typeof result.completedAt === "string" &&
    (result.resultExcerpt === undefined || isWorkflowResultExcerpt(result.resultExcerpt))
  );
}

function isReviewRound(value: unknown): value is ReviewRound {
  if (!value || typeof value !== "object") return false;
  const round = value as ReviewRound;
  return (
    Number.isInteger(round.round) &&
    Array.isArray(round.requiredReviewers) &&
    round.requiredReviewers.every(isReviewerRole) &&
    Array.isArray(round.pendingReviewers) &&
    round.pendingReviewers.every(isReviewerRole) &&
    Array.isArray(round.inFlightReviewers) &&
    round.inFlightReviewers.every(isReviewerRole) &&
    Array.isArray(round.completedReviewers) &&
    round.completedReviewers.every(isReviewerRole) &&
    !!round.results &&
    typeof round.results === "object" &&
    (round.results.spec === undefined || isReviewRoundResult(round.results.spec)) &&
    (round.results.code === undefined || isReviewRoundResult(round.results.code)) &&
    (round.status === "active" || round.status === "completed") &&
    typeof round.createdAt === "string"
  );
}

function isWorkItemRecord(value: unknown, sessionId: string): value is WorkItemRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as WorkItemRecord;
  return (
    record.sessionId === sessionId &&
    typeof record.workItemId === "string" &&
    typeof record.key === "string" &&
    typeof record.title === "string" &&
    isWorkItemMode(record.mode) &&
    Array.isArray(record.requiredReviewers) &&
    record.requiredReviewers.length > 0 &&
    record.requiredReviewers.every(isReviewerRole) &&
    VALID_STATES.has(record.state) &&
    Number.isInteger(record.completedReviewRoundCount) &&
    Number.isInteger(record.specReviewCount) &&
    Number.isInteger(record.codeReviewCount) &&
    (record.resultExcerpt === undefined || isWorkflowResultExcerpt(record.resultExcerpt)) &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string" &&
    (record.currentRound === undefined || isReviewRound(record.currentRound))
  );
}

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
//     when the file is missing, corrupt, or incomplete. Never throws.
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

    if (!parsed.records.every((record) => isWorkItemRecord(record, sessionId))) {
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
//   INPUTS: { sessionId: string, data: WorkItemStoreData }
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
