// FILE: src/plugins/workflow/persistence.ts
// VERSION: 0.4.0
// START_MODULE_CONTRACT
//   PURPOSE: Hydrate and snapshot work-item workflow state from/to per-session JSON
//     files under $XDG_DATA_HOME/vvoc/workflow/<sessionId>/workflow-state.json.
//   SCOPE: Read/write WorkItemStoreData (nextId, records, keyIndexBySession,
//     planRuns, executions, messageClaims) as serializable JSON. Version 4
//     snapshots additionally persist the common execution registry and
//     session-wide root-message claims. Version 3 snapshots persist
//     delegated and checkpoint recovery histories with replay-protected
//     authorization references, recovery-aware attempt and generation budgets,
//     and report_rejected attempts carrying bounded rejected-report evidence
//     through an atomic temporary-file replacement. Version 2 files hydrate
//     conservatively with empty recovery histories and unchanged budgets;
//     version 1 files hydrate as legacy records with an empty plan-run
//     registry. Existing native plan runs materialize a compatibility
//     execution registry entry without inventing authority. Neither ever
//     synthesizes acceptance, approval, or recovery.
//     Strict validation rejects malformed or contradictory new state instead of
//     silently restarting a run. A checked loader distinguishes missing, valid,
//     and invalid state and surfaces I/O failures.
//   DEPENDS: [node:fs, node:fs/promises, node:path, src/lib/vvoc-paths.ts,
//     src/lib/workflow-contract.ts,
//     src/plugins/workflow/checkpoints.ts (types), src/plugins/workflow/delegated.ts,
//     src/plugins/workflow/execution.ts, src/plugins/workflow/state.ts]
//   LINKS: M-WORKFLOW-PERSISTENCE, M-CONFIG-LAYERS, M-WORKFLOW-STATE, M-WORKFLOW-DELEGATED, M-WORKFLOW-CHECKPOINTS, M-WORKFLOW-EXECUTION, M-WORKFLOW-CONTRACT, V-M-WORKFLOW-PERSISTENCE
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   PERSISTED_WORKFLOW_STATE_VERSION - Current persisted snapshot version.
//   PersistedWorkflowState - JSON-serializable shape of a per-session workflow state.
//   SerializedDelegatedPlanRun - JSON form of one registered plan run.
//   SerializedWorkflowExecution - JSON form of one common execution registry entry.
//   HydratedWorkflowStateResult - Missing/valid/invalid triage returned by the checked loader.
//   SnapshotWorkflowStateResult - Write outcome returned by the checked snapshot path.
//   getWorkflowSessionDir - Resolve per-session directory path.
//   hydrateWorkflowState - Legacy nullable hydrate kept for compatibility.
//   hydrateWorkflowStateChecked - Checked loader distinguishing missing, valid, and invalid state.
//   snapshotWorkflowState - Legacy fire-and-forget snapshot kept for compatibility.
//   snapshotWorkflowStateChecked - Atomic temporary-file replacement snapshot surfacing failures.
//   deleteWorkflowSessionDir - Remove per-session workflow directory on session delete.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-WORKFLOW-PLAN-INDEPENDENCE - Version 4 persists the common execution registry and session-wide message claims while explicitly migrating v1/v2/v3 without clearing recovery, rejected-report, or stopped-generation history.]
// END_CHANGE_SUMMARY

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { getGlobalVvocDataDir } from "../../lib/vvoc-paths.js";
import { normalizeDeclaredScopePath } from "../../lib/workflow-contract.js";
import type { WorkflowMessageClaim } from "../../lib/workflow-contract.js";
import type {
  WorkflowCheckpointBinding,
  WorkflowExecutionRecord,
  WorkflowTaskBinding,
} from "./execution.js";
import { ensureNativeExecutions } from "./execution.js";
import type {
  DelegatedAcceptanceRecord,
  DelegatedAttempt,
  DelegatedDecisionRecord,
  DelegatedRecoveryRecord,
  DelegatedReworkRecord,
  DelegatedWorkItemState,
} from "./delegated.js";
import {
  DELEGATED_BASE_ATTEMPTS,
  DELEGATED_EVIDENCE_MAX_CHARS,
  DELEGATED_EVIDENCE_MAX_REFS,
  DELEGATED_RATIONALE_MAX_CHARS,
  DELEGATED_RECOVERY_CODE_MAX_CHARS,
  delegatedRecoveryGrantCount,
} from "./delegated.js";
import type {
  DelegatedCheckpointHistoryEntry,
  DelegatedCheckpointRecoveryRecord,
  DelegatedCheckpointReview,
  DelegatedPlanRun,
  DelegatedRunCheckpoint,
} from "./checkpoints.js";
import { MAX_CHECKPOINT_REVIEW_ATTEMPTS, checkpointRecoveryGrantCount } from "./checkpoints.js";
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
export const PERSISTED_WORKFLOW_STATE_VERSION = 4;

/** Version at which delegated/checkpoint recovery histories and report rejections were introduced. */
const RECOVERY_STATE_VERSION = 3;

/**
 * JSON-serializable shape of a per-session workflow state. Version 1 legacy
 * files lack planRuns; version 2 files carry delegated and plan-run state
 * without recovery histories; version 3 files additionally carry recovery
 * histories and report-rejected attempts; version 4 adds the common execution
 * registry together with session-wide message claims.
 */
export type PersistedWorkflowState = {
  version: 1 | 2 | 3 | 4;
  updatedAt: string;
  sessionId: string;
  nextId: number;
  /** WorkItemRecord[] sorted by creation order. */
  records: WorkItemRecord[];
  /** key -> workItemId lookup for idempotent open-by-key. */
  keyIndex: Record<string, string>;
  /** Version 2 and later: registered delegated plan runs. */
  planRuns?: SerializedDelegatedPlanRun[];
  /** Version 4 and later: common execution registry entries. */
  executions?: SerializedWorkflowExecution[];
  /** Version 4 and later: session-wide root-message claims preventing replay. */
  messageClaims?: WorkflowMessageClaim[];
};

/** JSON form of one registered plan run with maps flattened to arrays. */
export type SerializedDelegatedPlanRun = Omit<DelegatedPlanRun, "tasks" | "checkpoints"> & {
  tasks: Array<{ taskId: string; workItemId: string }>;
  checkpoints: DelegatedRunCheckpoint[];
};

/** JSON form of one common execution with maps flattened to arrays. */
export type SerializedWorkflowExecution = Omit<WorkflowExecutionRecord, "tasks" | "checkpoints"> & {
  tasks: Array<[string, WorkflowTaskBinding]>;
  checkpoints: Array<[string, WorkflowCheckpointBinding]>;
};

export type HydratedWorkflowStateResult =
  | { status: "missing" }
  | { status: "valid"; data: WorkItemStoreData }
  | { status: "invalid"; errors: string[] };

export type SnapshotWorkflowStateResult = { ok: true } | { ok: false; error: string };
// END_BLOCK_SERIALIZATION_TYPES

const VALID_STATES: ReadonlySet<WorkItemState> = new Set([
  "open",
  "awaiting_implementer",
  "awaiting_reviews",
  "awaiting_acceptance",
  "needs_context",
  "blocked",
  "ready_to_close",
  "closed",
]);

const DELEGATED_RESULT_STATUSES: ReadonlySet<string> = new Set([
  "DONE",
  "DONE_WITH_CONCERNS",
  "NEEDS_CONTEXT",
  "BLOCKED",
]);

const CHECKPOINT_OUTCOMES: ReadonlySet<string> = new Set(["passed", "failed", "stale", "stopped"]);
const LAST_OUTCOMES: ReadonlySet<string> = new Set([
  "passed",
  "failed",
  "stale",
  "stopped",
  "incomplete",
]);
const RECOVERY_KINDS: ReadonlySet<string> = new Set([
  "resume",
  "autonomous_grant",
  "user_grant",
  "advance_grant",
]);
const TERMINAL_ATTEMPT_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "report_rejected",
]);

function isWorkItemMode(value: unknown): value is WorkItemMode {
  return value === "implementation" || value === "review_only" || value === "delegated";
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

function isValidScopeList(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") return false;
    const normalized = normalizeDeclaredScopePath(entry);
    if (!normalized.ok || normalized.path !== entry) return false;
    if (seen.has(entry)) return false;
    seen.add(entry);
  }
  return true;
}

function validateDelegatedText(
  value: unknown,
  maxChars: number,
  label: string,
  errors: string[],
): value is string {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${label} must be a non-empty string`);
    return false;
  }
  if (value.trim().length > maxChars) {
    errors.push(`${label} exceeds ${maxChars} characters`);
    return false;
  }
  return true;
}

function validateBoundedEvidence(
  value: unknown,
  label: string,
  errors: string[],
): value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > DELEGATED_EVIDENCE_MAX_REFS) {
    errors.push(`${label} must contain 1 to ${DELEGATED_EVIDENCE_MAX_REFS} references`);
    return false;
  }
  for (const reference of value) {
    if (typeof reference !== "string" || reference.trim() === "") {
      errors.push(`${label} references must be non-empty strings`);
      return false;
    }
    if (reference.trim().length > DELEGATED_EVIDENCE_MAX_CHARS) {
      errors.push(`${label} references exceed ${DELEGATED_EVIDENCE_MAX_CHARS} characters`);
      return false;
    }
  }
  return true;
}

/** Validate the delegated-mode record extension; returns every contradiction found. */
function validateDelegatedState(
  record: WorkItemRecord,
  sessionId: string,
  version: number,
  errors: string[],
): void {
  const delegated = record.delegated as DelegatedWorkItemState | undefined;
  if (!delegated || typeof delegated !== "object") {
    errors.push(`${record.workItemId}: delegated records require a delegated state object`);
    return;
  }
  if (record.requiredReviewers.length !== 0) {
    errors.push(
      `${record.workItemId}: delegated records must persist an empty requiredReviewers array`,
    );
  }
  if ((delegated.planRunId === undefined) !== (delegated.planTaskId === undefined)) {
    errors.push(
      `${record.workItemId}: planRunId and planTaskId must be persisted together or absent`,
    );
  }
  if (!isValidScopeList(delegated.writeScope)) {
    errors.push(
      `${record.workItemId}: delegated writeScope must be a non-empty canonical path list`,
    );
  }

  const attempts = delegated.attempts;
  if (!Array.isArray(attempts)) {
    errors.push(`${record.workItemId}: delegated attempts must be an array`);
    return;
  }
  let inFlight = 0;
  attempts.forEach((attempt: DelegatedAttempt, index: number) => {
    if (attempt.attempt !== index + 1) {
      errors.push(`${record.workItemId}: delegated attempts must sequence 1..n contiguously`);
    }
    if (typeof attempt.callId !== "string" || attempt.callId === "") {
      errors.push(`${record.workItemId}: attempt ${attempt.attempt} requires a bound callId`);
    }
    if (attempt.status === "in_flight") {
      inFlight += 1;
      if (
        attempt.resultStatus !== undefined ||
        attempt.completedAt !== undefined ||
        attempt.failureExcerpt !== undefined ||
        attempt.reportRejection !== undefined
      ) {
        errors.push(
          `${record.workItemId}: in-flight attempt ${attempt.attempt} must not carry a result`,
        );
      }
    } else if (attempt.status === "completed") {
      if (!DELEGATED_RESULT_STATUSES.has(attempt.resultStatus as string)) {
        errors.push(
          `${record.workItemId}: completed attempt ${attempt.attempt} lacks a valid resultStatus`,
        );
      }
      if (typeof attempt.completedAt !== "string") {
        errors.push(
          `${record.workItemId}: completed attempt ${attempt.attempt} requires completedAt`,
        );
      }
      if (attempt.failureExcerpt !== undefined || attempt.reportRejection !== undefined) {
        errors.push(
          `${record.workItemId}: completed attempt ${attempt.attempt} must not carry failure or rejection evidence`,
        );
      }
    } else if (attempt.status === "failed") {
      if (typeof attempt.completedAt !== "string") {
        errors.push(`${record.workItemId}: failed attempt ${attempt.attempt} requires completedAt`);
      }
      if (attempt.resultStatus !== undefined || attempt.reportRejection !== undefined) {
        errors.push(
          `${record.workItemId}: failed attempt ${attempt.attempt} must not carry a result or rejection`,
        );
      }
      if (
        attempt.failureExcerpt === undefined ||
        !isWorkflowResultExcerpt(attempt.failureExcerpt)
      ) {
        errors.push(
          `${record.workItemId}: failed attempt ${attempt.attempt} requires a bounded failure excerpt`,
        );
      }
    } else if (attempt.status === "report_rejected") {
      if (version < RECOVERY_STATE_VERSION) {
        errors.push(
          `${record.workItemId}: report_rejected attempts require persisted version ${RECOVERY_STATE_VERSION}`,
        );
      }
      if (typeof attempt.completedAt !== "string") {
        errors.push(
          `${record.workItemId}: report_rejected attempt ${attempt.attempt} requires completedAt`,
        );
      }
      if (attempt.resultStatus !== undefined || attempt.failureExcerpt !== undefined) {
        errors.push(
          `${record.workItemId}: report_rejected attempt ${attempt.attempt} must not carry a synthesized result`,
        );
      }
      const rejection = attempt.reportRejection;
      if (
        !rejection ||
        typeof rejection !== "object" ||
        typeof rejection.protocolErrorCode !== "string" ||
        rejection.protocolErrorCode.trim() === "" ||
        rejection.protocolErrorCode.length > DELEGATED_RECOVERY_CODE_MAX_CHARS ||
        typeof rejection.rejectedAt !== "string" ||
        !isWorkflowResultExcerpt(rejection.excerpt)
      ) {
        errors.push(
          `${record.workItemId}: report_rejected attempt ${attempt.attempt} requires a bounded rejection record`,
        );
      }
    } else {
      errors.push(
        `${record.workItemId}: attempt ${attempt.attempt} has invalid status ${attempt.status}`,
      );
    }
    if (
      attempt.resultExcerpt !== undefined &&
      (attempt.status !== "completed" || !isWorkflowResultExcerpt(attempt.resultExcerpt))
    ) {
      errors.push(`${record.workItemId}: attempt ${attempt.attempt} carries a malformed excerpt`);
    }
  });
  if (inFlight > 1) {
    errors.push(`${record.workItemId}: at most one delegated attempt may be in flight`);
  }
  if (
    delegated.reworkHistory.some(
      (rework: DelegatedReworkRecord) => !rework.reworkId || !rework.authorizedByCheckpoint,
    )
  ) {
    errors.push(
      `${record.workItemId}: rework history entries require ids and checkpoint authorization`,
    );
  }

  const recoveryHistory = delegated.recoveryHistory;
  if (!Array.isArray(recoveryHistory)) {
    if (version >= RECOVERY_STATE_VERSION) {
      errors.push(`${record.workItemId}: version 3 delegated records require a recovery history`);
    }
  } else if (recoveryHistory.length > 0 && version < RECOVERY_STATE_VERSION) {
    errors.push(
      `${record.workItemId}: recovery history requires persisted version ${RECOVERY_STATE_VERSION}`,
    );
  } else {
    const recoveryIds = new Set<string>();
    const userMessageIds = new Set<string>();
    let autonomousGrants = 0;
    for (const recovery of recoveryHistory as DelegatedRecoveryRecord[]) {
      if (!recovery.recoveryId || recoveryIds.has(recovery.recoveryId)) {
        errors.push(
          `${record.workItemId}: recovery entries require unique non-empty recoveryId values`,
        );
      }
      recoveryIds.add(recovery.recoveryId ?? "");
      if (!RECOVERY_KINDS.has(recovery.kind)) {
        errors.push(`${record.workItemId}: recovery ${recovery.recoveryId} has an invalid kind`);
      }
      if (recovery.kind === "autonomous_grant") {
        autonomousGrants += 1;
      }
      if (recovery.kind === "user_grant") {
        if (typeof recovery.userMessageId !== "string" || recovery.userMessageId === "") {
          errors.push(
            `${record.workItemId}: user-grant recovery ${recovery.recoveryId} requires its authorizing message id`,
          );
        } else if (userMessageIds.has(recovery.userMessageId)) {
          errors.push(
            `${record.workItemId}: message ${recovery.userMessageId} authorized more than one recovery unit`,
          );
        } else {
          userMessageIds.add(recovery.userMessageId);
        }
      } else if (recovery.userMessageId !== undefined) {
        errors.push(
          `${record.workItemId}: non-user recovery ${recovery.recoveryId} must not persist an authorization reference`,
        );
      }
      if (
        !Number.isInteger(recovery.targetAttempt) ||
        recovery.targetAttempt < 1 ||
        recovery.targetAttempt > attempts.length ||
        !TERMINAL_ATTEMPT_STATUSES.has(attempts[recovery.targetAttempt - 1]?.status ?? "")
      ) {
        errors.push(
          `${record.workItemId}: recovery ${recovery.recoveryId} targets a non-terminal attempt`,
        );
      }
      validateDelegatedText(
        recovery.diagnosis,
        DELEGATED_RATIONALE_MAX_CHARS,
        `${record.workItemId}: recovery ${recovery.recoveryId} diagnosis`,
        errors,
      );
      validateDelegatedText(
        recovery.changedCondition,
        DELEGATED_RATIONALE_MAX_CHARS,
        `${record.workItemId}: recovery ${recovery.recoveryId} changedCondition`,
        errors,
      );
      validateBoundedEvidence(
        recovery.verification,
        `${record.workItemId}: recovery ${recovery.recoveryId} verification`,
        errors,
      );
    }
    if (autonomousGrants > 1) {
      errors.push(
        `${record.workItemId}: at most one autonomous recovery grant may be recorded per item`,
      );
    }
  }
  if (
    attempts.length >
    DELEGATED_BASE_ATTEMPTS +
      delegated.reworkHistory.length +
      delegatedRecoveryGrantCount(delegated.recoveryHistory ?? [])
  ) {
    errors.push(
      `${record.workItemId}: attempts exceed the base budget plus authorized rework and recovery grants`,
    );
  }

  const decisions = delegated.decisions;
  if (!Array.isArray(decisions)) {
    errors.push(`${record.workItemId}: delegated decisions must be an array`);
    return;
  }
  const decidedAttempts = new Set<number>();
  for (const decision of decisions as DelegatedDecisionRecord[]) {
    if (decision.decision !== "accept" && decision.decision !== "request_changes") {
      errors.push(
        `${record.workItemId}: decision ${decision.decisionId} has an invalid decision value`,
      );
      continue;
    }
    if (decision.decisionId !== `dec-${record.workItemId}-a${decision.attempt}`) {
      errors.push(
        `${record.workItemId}: decision id ${decision.decisionId} does not match its attempt`,
      );
    }
    if (decidedAttempts.has(decision.attempt)) {
      errors.push(`${record.workItemId}: attempt ${decision.attempt} has more than one decision`);
    }
    decidedAttempts.add(decision.attempt);
    if (
      !attempts.some(
        (attempt) => attempt.attempt === decision.attempt && attempt.status === "completed",
      )
    ) {
      errors.push(
        `${record.workItemId}: decision ${decision.decisionId} targets a non-completed attempt`,
      );
    }
    validateDelegatedText(
      decision.rationale,
      DELEGATED_RATIONALE_MAX_CHARS,
      `${record.workItemId}: decision ${decision.decisionId} rationale`,
      errors,
    );
    validateBoundedEvidence(
      decision.evidence,
      `${record.workItemId}: decision ${decision.decisionId} evidence`,
      errors,
    );
    if (decision.concernsDisposition !== undefined) {
      validateDelegatedText(
        decision.concernsDisposition,
        DELEGATED_RATIONALE_MAX_CHARS,
        `${record.workItemId}: decision ${decision.decisionId} concernsDisposition`,
        errors,
      );
    }
  }

  const acceptances = delegated.acceptances;
  if (!Array.isArray(acceptances)) {
    errors.push(`${record.workItemId}: delegated acceptances must be an array`);
    return;
  }
  const reworkIds = new Set(
    (delegated.reworkHistory as DelegatedReworkRecord[]).map((rework) => rework.reworkId),
  );
  const currentAcceptance = [...(acceptances as DelegatedAcceptanceRecord[])]
    .reverse()
    .find((acceptance) => !acceptance.revokedAt);
  for (const acceptance of acceptances as DelegatedAcceptanceRecord[]) {
    const matchingDecision = (decisions as DelegatedDecisionRecord[]).find(
      (decision) => decision.decisionId === acceptance.decisionId && decision.decision === "accept",
    );
    if (!matchingDecision) {
      errors.push(
        `${record.workItemId}: acceptance ${acceptance.decisionId} has no matching accept decision`,
      );
    }
    if (
      acceptance.revokedAt !== undefined &&
      (acceptance.revokedByReworkId === undefined || !reworkIds.has(acceptance.revokedByReworkId))
    ) {
      errors.push(
        `${record.workItemId}: revoked acceptance ${acceptance.decisionId} references an unknown rework`,
      );
    }
    if (acceptance.concernsDisposition !== undefined) {
      validateDelegatedText(
        acceptance.concernsDisposition,
        DELEGATED_RATIONALE_MAX_CHARS,
        `${record.workItemId}: acceptance ${acceptance.decisionId} concernsDisposition`,
        errors,
      );
    }
  }

  const latestCompleted = [...attempts]
    .filter((attempt) => attempt.status === "completed")
    .sort((left, right) => right.attempt - left.attempt)[0];
  if (record.state === "awaiting_acceptance") {
    if (!latestCompleted) {
      errors.push(`${record.workItemId}: awaiting_acceptance without a completed attempt`);
    } else if (decidedAttempts.has(latestCompleted.attempt)) {
      errors.push(
        `${record.workItemId}: awaiting_acceptance but the latest attempt already has a decision`,
      );
    }
  }
  if (record.state === "ready_to_close" && !currentAcceptance) {
    errors.push(`${record.workItemId}: ready_to_close without a currently applicable acceptance`);
  }
  if (sessionId !== record.sessionId) {
    errors.push(`${record.workItemId}: record session mismatch`);
  }
}

function isWorkItemRecord(
  value: unknown,
  sessionId: string,
  version: number,
  errors: string[],
): value is WorkItemRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as WorkItemRecord;
  const baseValid =
    record.sessionId === sessionId &&
    typeof record.workItemId === "string" &&
    typeof record.key === "string" &&
    typeof record.title === "string" &&
    isWorkItemMode(record.mode) &&
    Array.isArray(record.requiredReviewers) &&
    record.requiredReviewers.every(isReviewerRole) &&
    VALID_STATES.has(record.state) &&
    Number.isInteger(record.completedReviewRoundCount) &&
    Number.isInteger(record.specReviewCount) &&
    Number.isInteger(record.codeReviewCount) &&
    (record.resultExcerpt === undefined || isWorkflowResultExcerpt(record.resultExcerpt)) &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string" &&
    (record.currentRound === undefined || isReviewRound(record.currentRound));

  if (!baseValid) return false;

  if (record.mode === "delegated") {
    const recordErrors: string[] = [];
    validateDelegatedState(record, sessionId, version, recordErrors);
    errors.push(...recordErrors);
    return recordErrors.length === 0;
  }

  if (record.requiredReviewers.length === 0) {
    errors.push(`${record.workItemId}: ${record.mode} records require non-empty requiredReviewers`);
    return false;
  }
  if (record.delegated !== undefined) {
    errors.push(
      `${record.workItemId}: delegated state on a ${record.mode} record is contradictory`,
    );
    return false;
  }
  return true;
}

function validatePlanRun(
  run: unknown,
  recordsById: Map<string, WorkItemRecord>,
  sessionId: string,
  version: number,
  errors: string[],
): run is SerializedDelegatedPlanRun {
  if (!run || typeof run !== "object") {
    errors.push("plan run entries must be objects");
    return false;
  }
  const candidate = run as SerializedDelegatedPlanRun;
  if (typeof candidate.runId !== "string" || candidate.runId === "") {
    errors.push("plan run requires a runId");
    return false;
  }
  if (candidate.sessionId !== sessionId) {
    errors.push(`plan run ${candidate.runId} belongs to another session`);
    return false;
  }
  if (typeof candidate.planPath !== "string" || typeof candidate.specPath !== "string") {
    errors.push(`plan run ${candidate.runId} requires canonical plan and spec paths`);
    return false;
  }
  if (!Array.isArray(candidate.tasks) || !Array.isArray(candidate.checkpoints)) {
    errors.push(`plan run ${candidate.runId} requires task and checkpoint arrays`);
    return false;
  }
  if (!candidate.definition || candidate.definition.mode !== "delegated") {
    errors.push(`plan run ${candidate.runId} requires its delegated definition`);
    return false;
  }
  if (candidate.status !== "active" && candidate.status !== "sealed") {
    errors.push(`plan run ${candidate.runId} has invalid status ${candidate.status}`);
    return false;
  }
  if (candidate.status === "sealed" && typeof candidate.sealedAt !== "string") {
    errors.push(`plan run ${candidate.runId} is sealed without sealedAt`);
    return false;
  }

  const taskIds = new Set<string>();
  for (const task of candidate.tasks) {
    if (typeof task.taskId !== "string" || typeof task.workItemId !== "string") {
      errors.push(`plan run ${candidate.runId} has a malformed task binding`);
      continue;
    }
    if (taskIds.has(task.taskId)) {
      errors.push(`plan run ${candidate.runId} binds task ${task.taskId} twice`);
    }
    taskIds.add(task.taskId);
    const record = recordsById.get(task.workItemId);
    if (
      !record ||
      record.mode !== "delegated" ||
      record.delegated?.planRunId !== candidate.runId ||
      record.delegated?.planTaskId !== task.taskId
    ) {
      errors.push(
        `plan run ${candidate.runId} task ${task.taskId} is not bound to work item ${task.workItemId}`,
      );
    }
  }

  const checkpointIds = new Set<string>();
  for (const checkpoint of candidate.checkpoints) {
    if (
      typeof checkpoint.checkpointId !== "string" ||
      !checkpointIds.add(checkpoint.checkpointId)
    ) {
      errors.push(`plan run ${candidate.runId} has duplicate or malformed checkpoint ids`);
      continue;
    }
    if (checkpoint.kind !== "milestone" && checkpoint.kind !== "final") {
      errors.push(`checkpoint ${checkpoint.checkpointId} has invalid kind ${checkpoint.kind}`);
    }
    if (
      !Array.isArray(checkpoint.reviewers) ||
      checkpoint.reviewers.length === 0 ||
      !checkpoint.reviewers.every(isReviewerRole)
    ) {
      errors.push(
        `checkpoint ${checkpoint.checkpointId} requires a non-empty spec/code reviewer set`,
      );
    }
    if (!["pending", "in_review", "passed", "failed"].includes(checkpoint.status as string)) {
      errors.push(`checkpoint ${checkpoint.checkpointId} has invalid status ${checkpoint.status}`);
    }
    if (checkpoint.lastOutcome !== undefined && !LAST_OUTCOMES.has(checkpoint.lastOutcome)) {
      errors.push(
        `checkpoint ${checkpoint.checkpointId} has invalid lastOutcome ${checkpoint.lastOutcome}`,
      );
    }
    const history = checkpoint.history;
    if (!Array.isArray(history)) {
      errors.push(`checkpoint ${checkpoint.checkpointId} requires a history array`);
      continue;
    }
    for (const entry of history as DelegatedCheckpointHistoryEntry[]) {
      if (!CHECKPOINT_OUTCOMES.has(entry.outcome)) {
        errors.push(
          `checkpoint ${checkpoint.checkpointId} history has invalid outcome ${entry.outcome}`,
        );
      }
      if (entry.outcome === "stopped" && version < RECOVERY_STATE_VERSION) {
        errors.push(
          `checkpoint ${checkpoint.checkpointId} stopped history requires persisted version ${RECOVERY_STATE_VERSION}`,
        );
      }
      if (typeof entry.generation !== "number" || typeof entry.fingerprint !== "string") {
        errors.push(`checkpoint ${checkpoint.checkpointId} history entry is malformed`);
      }
    }

    const recoveryHistory = checkpoint.recoveryHistory;
    if (!Array.isArray(recoveryHistory)) {
      if (version >= RECOVERY_STATE_VERSION) {
        errors.push(
          `checkpoint ${checkpoint.checkpointId} requires a recovery history at persisted version ${RECOVERY_STATE_VERSION}`,
        );
      }
    } else if (recoveryHistory.length > 0 && version < RECOVERY_STATE_VERSION) {
      errors.push(
        `checkpoint ${checkpoint.checkpointId} recovery history requires persisted version ${RECOVERY_STATE_VERSION}`,
      );
    } else {
      const recoveryIds = new Set<string>();
      const userMessageIds = new Set<string>();
      let autonomousGrants = 0;
      for (const recovery of recoveryHistory as DelegatedCheckpointRecoveryRecord[]) {
        if (!recovery.recoveryId || recoveryIds.has(recovery.recoveryId)) {
          errors.push(
            `checkpoint ${checkpoint.checkpointId} recovery entries require unique non-empty recoveryId values`,
          );
        }
        recoveryIds.add(recovery.recoveryId ?? "");
        if (!RECOVERY_KINDS.has(recovery.kind)) {
          errors.push(
            `checkpoint ${checkpoint.checkpointId} recovery ${recovery.recoveryId} has an invalid kind`,
          );
        }
        if (recovery.kind === "autonomous_grant") {
          autonomousGrants += 1;
        }
        if (recovery.kind === "user_grant") {
          if (typeof recovery.userMessageId !== "string" || recovery.userMessageId === "") {
            errors.push(
              `checkpoint ${checkpoint.checkpointId} user-grant recovery ${recovery.recoveryId} requires its authorizing message id`,
            );
          } else if (userMessageIds.has(recovery.userMessageId)) {
            errors.push(
              `checkpoint ${checkpoint.checkpointId} message ${recovery.userMessageId} authorized more than one recovery unit`,
            );
          } else {
            userMessageIds.add(recovery.userMessageId);
          }
        } else if (recovery.userMessageId !== undefined) {
          errors.push(
            `checkpoint ${checkpoint.checkpointId} non-user recovery ${recovery.recoveryId} must not persist an authorization reference`,
          );
        }
        if (
          !Number.isInteger(recovery.targetGeneration) ||
          recovery.targetGeneration < 1 ||
          recovery.targetGeneration > checkpoint.attempts
        ) {
          errors.push(
            `checkpoint ${checkpoint.checkpointId} recovery ${recovery.recoveryId} targets an unknown generation`,
          );
        }
        validateDelegatedText(
          recovery.diagnosis,
          DELEGATED_RATIONALE_MAX_CHARS,
          `checkpoint ${checkpoint.checkpointId} recovery ${recovery.recoveryId} diagnosis`,
          errors,
        );
        validateDelegatedText(
          recovery.changedCondition,
          DELEGATED_RATIONALE_MAX_CHARS,
          `checkpoint ${checkpoint.checkpointId} recovery ${recovery.recoveryId} changedCondition`,
          errors,
        );
        validateBoundedEvidence(
          recovery.verification,
          `checkpoint ${checkpoint.checkpointId} recovery ${recovery.recoveryId} verification`,
          errors,
        );
      }
      if (autonomousGrants > 1) {
        errors.push(
          `checkpoint ${checkpoint.checkpointId} has more than one autonomous recovery grant`,
        );
      }
      if (
        checkpoint.attempts >
        MAX_CHECKPOINT_REVIEW_ATTEMPTS + checkpointRecoveryGrantCount(recoveryHistory)
      ) {
        errors.push(
          `checkpoint ${checkpoint.checkpointId} generations exceed the ordinary budget plus recovery grants`,
        );
      }
    }
    const review = checkpoint.currentReview as DelegatedCheckpointReview | undefined;
    if (checkpoint.status === "in_review") {
      if (
        !review ||
        review.generation !== checkpoint.attempts ||
        review.generation !== history.length + 1
      ) {
        errors.push(
          `checkpoint ${checkpoint.checkpointId} in_review without a consistent current generation`,
        );
      } else {
        for (const reviewer of Object.keys(review.results ?? {})) {
          if (!checkpoint.reviewers.includes(reviewer as ReviewerRole)) {
            errors.push(
              `checkpoint ${checkpoint.checkpointId} recorded an undeclared reviewer ${reviewer}`,
            );
          }
        }
        if (
          Object.keys(review.reviewerCallIds ?? {}).some(
            (reviewer) => !checkpoint.reviewers.includes(reviewer as ReviewerRole),
          )
        ) {
          errors.push(`checkpoint ${checkpoint.checkpointId} bound an undeclared reviewer call`);
        }
      }
    } else if (review !== undefined) {
      errors.push(
        `checkpoint ${checkpoint.checkpointId} is ${checkpoint.status} but still carries a current review`,
      );
    }
    if (checkpoint.status === "passed" && history[history.length - 1]?.outcome !== "passed") {
      errors.push(`checkpoint ${checkpoint.checkpointId} passed without a passing history entry`);
    }
    if (
      checkpoint.status === "failed" &&
      !["failed", "stale", "stopped"].includes(history[history.length - 1]?.outcome ?? "")
    ) {
      errors.push(`checkpoint ${checkpoint.checkpointId} failed without a failing history entry`);
    }
    if (checkpoint.attempts !== history.length + (checkpoint.status === "in_review" ? 1 : 0)) {
      errors.push(`checkpoint ${checkpoint.checkpointId} attempts do not match its generations`);
    }
  }

  const finals = candidate.checkpoints.filter((checkpoint) => checkpoint.kind === "final");
  if (finals.length !== 1) {
    errors.push(`plan run ${candidate.runId} must persist exactly one final checkpoint`);
  } else if (candidate.status === "sealed" && finals[0].status !== "passed") {
    errors.push(`plan run ${candidate.runId} is sealed without a passed final checkpoint`);
  }

  return errors.length === 0;
}

function serializePlanRun(run: DelegatedPlanRun): SerializedDelegatedPlanRun {
  return {
    ...run,
    tasks: [...run.tasks.values()],
    checkpoints: [...run.checkpoints.values()],
  };
}

// START_BLOCK_EXECUTION_SERIALIZATION
function serializeWorkflowExecution(
  execution: WorkflowExecutionRecord,
): SerializedWorkflowExecution {
  return {
    ...execution,
    tasks: [...execution.tasks.entries()],
    checkpoints: [...execution.checkpoints.entries()],
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function validateWorkflowExecution(
  candidate: SerializedWorkflowExecution,
  sessionId: string,
  errors: string[],
): boolean {
  const before = errors.length;
  if (!isNonEmptyString(candidate.runId)) errors.push("execution requires a runId");
  if (candidate.sessionId !== sessionId) {
    errors.push(`execution ${candidate.runId} belongs to another session`);
  }
  if (!isNonEmptyString(candidate.workspaceRoot)) {
    errors.push(`execution ${candidate.runId} requires a workspaceRoot`);
  }
  if (!isNonEmptyString(candidate.executionKey)) {
    errors.push(`execution ${candidate.runId} requires an executionKey`);
  }
  if (!isNonEmptyString(candidate.goal)) {
    errors.push(`execution ${candidate.runId} requires a goal`);
  }
  if (
    candidate.state !== "preparing" &&
    candidate.state !== "active" &&
    candidate.state !== "sealed"
  ) {
    errors.push(`execution ${candidate.runId} has invalid state ${String(candidate.state)}`);
  }
  if (!Number.isInteger(candidate.revision) || candidate.revision < 1) {
    errors.push(`execution ${candidate.runId} requires a positive revision`);
  }
  if (!candidate.source || typeof candidate.source !== "object") {
    errors.push(`execution ${candidate.runId} requires a source`);
  } else if (
    candidate.source.kind !== "native-package" &&
    candidate.source.kind !== "provided-plan" &&
    candidate.source.kind !== "conversation-scoped"
  ) {
    errors.push(`execution ${candidate.runId} has an invalid source kind`);
  }
  if (
    !candidate.boundary ||
    !Array.isArray(candidate.boundary.files) ||
    !Array.isArray(candidate.boundary.directories)
  ) {
    errors.push(`execution ${candidate.runId} requires a boundary with files and directories`);
  }
  if (!Array.isArray(candidate.tasks) || candidate.tasks.length === 0) {
    errors.push(`execution ${candidate.runId} requires at least one task binding`);
  } else {
    const ids = new Set<string>();
    for (const [taskId, binding] of candidate.tasks) {
      if (ids.has(taskId)) errors.push(`execution ${candidate.runId} repeats task ${taskId}`);
      ids.add(taskId);
      if (!binding || binding.taskId !== taskId) {
        errors.push(`execution ${candidate.runId} task ${taskId} binding mismatch`);
      }
    }
  }
  if (!Array.isArray(candidate.checkpoints)) {
    errors.push(`execution ${candidate.runId} requires a checkpoints array`);
  }
  if (!Array.isArray(candidate.lineage)) {
    errors.push(`execution ${candidate.runId} requires a lineage array`);
  }
  if (!Array.isArray(candidate.authority) || !Array.isArray(candidate.stageApprovals)) {
    errors.push(`execution ${candidate.runId} requires authority and stageApprovals arrays`);
  }
  if (!Array.isArray(candidate.reserveDebits)) {
    errors.push(`execution ${candidate.runId} requires a reserveDebits array`);
  }
  return errors.length === before;
}
// END_BLOCK_EXECUTION_SERIALIZATION

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

// START_CONTRACT: hydrateWorkflowStateChecked
//   PURPOSE: Read and validate the per-session workflow state, distinguishing missing, valid, and invalid files and surfacing I/O failures.
//   INPUTS: { sessionId: string - OpenCode session identifier }
//   OUTPUTS: { HydratedWorkflowStateResult - missing, validated store data, or collected validation errors }
//   SIDE_EFFECTS: [Reads workflow-state.json; never writes and never throws]
//   LINKS: [M-WORKFLOW-PERSISTENCE, M-WORKFLOW-STATE]
// END_CONTRACT: hydrateWorkflowStateChecked
export function hydrateWorkflowStateChecked(sessionId: string): HydratedWorkflowStateResult {
  const filePath = getWorkflowStatePath(sessionId);
  let raw: string;
  try {
    if (!existsSync(filePath)) {
      return { status: "missing" };
    }
    raw = readFileSync(filePath, "utf-8");
  } catch (error) {
    return {
      status: "invalid",
      errors: [`workflow state could not be read: ${(error as Error).message}`],
    };
  }

  let parsed: PersistedWorkflowState;
  try {
    parsed = JSON.parse(raw) as PersistedWorkflowState;
  } catch (error) {
    return {
      status: "invalid",
      errors: [`workflow state is not valid JSON: ${(error as Error).message}`],
    };
  }

  if (
    parsed.version !== 1 &&
    parsed.version !== 2 &&
    parsed.version !== RECOVERY_STATE_VERSION &&
    parsed.version !== PERSISTED_WORKFLOW_STATE_VERSION
  ) {
    return {
      status: "invalid",
      errors: [`unsupported persisted version ${String(parsed.version)}`],
    };
  }
  if (!Array.isArray(parsed.records)) {
    return { status: "invalid", errors: ["persisted records must be an array"] };
  }
  const version = parsed.version;

  const errors: string[] = [];
  const records = new Map<string, WorkItemRecord>();
  for (const record of parsed.records) {
    const recordErrors: string[] = [];
    if (!isWorkItemRecord(record, sessionId, version, recordErrors)) {
      errors.push(
        ...(recordErrors.length > 0
          ? recordErrors
          : [
              `record ${String((record as { workItemId?: string })?.workItemId ?? "(unknown)")} failed base validation`,
            ]),
      );
      continue;
    }
    // Versions 1 and 2 never carried recovery histories: hydrate them
    // conservatively with empty histories rather than inferring grants, so
    // their original budgets stay unchanged.
    if (record.mode === "delegated" && record.delegated && version < RECOVERY_STATE_VERSION) {
      record.delegated = { ...record.delegated, recoveryHistory: [] };
    }
    records.set(`${sessionId}::${record.workItemId}`, record);
  }

  const keyIndex = new Map<string, string>();
  for (const [key, workItemId] of Object.entries(parsed.keyIndex ?? {})) {
    keyIndex.set(key, workItemId);
  }
  const keyIndexBySession = new Map<string, Map<string, string>>();
  keyIndexBySession.set(sessionId, keyIndex);

  const planRuns = new Map<string, DelegatedPlanRun>();
  if (version >= 2) {
    if (!Array.isArray(parsed.planRuns)) {
      return { status: "invalid", errors: ["version 2 state requires a planRuns array"] };
    }
    const recordsByBareId = new Map<string, WorkItemRecord>(
      [...records.values()].map((record) => [record.workItemId, record] as const),
    );
    for (const serialized of parsed.planRuns) {
      const runErrors: string[] = [];
      if (!validatePlanRun(serialized, recordsByBareId, sessionId, version, runErrors)) {
        errors.push(...runErrors);
        continue;
      }
      const run: DelegatedPlanRun = {
        ...serialized,
        tasks: new Map(serialized.tasks.map((task) => [task.taskId, task])),
        checkpoints: new Map(
          serialized.checkpoints.map((checkpoint) => {
            const hydrated =
              version < RECOVERY_STATE_VERSION
                ? { ...checkpoint, recoveryHistory: checkpoint.recoveryHistory ?? [] }
                : checkpoint;
            return [hydrated.checkpointId, hydrated];
          }),
        ),
      };
      planRuns.set(run.runId, run);
    }
  }

  const executions = new Map<string, WorkflowExecutionRecord>();
  const messageClaims = new Map<string, WorkflowMessageClaim>();
  if (version >= PERSISTED_WORKFLOW_STATE_VERSION) {
    if (!Array.isArray(parsed.executions)) {
      return { status: "invalid", errors: ["version 4 state requires an executions array"] };
    }
    for (const serialized of parsed.executions) {
      const executionErrors: string[] = [];
      if (!validateWorkflowExecution(serialized, sessionId, executionErrors)) {
        errors.push(...executionErrors);
        continue;
      }
      executions.set(serialized.runId, {
        ...serialized,
        tasks: new Map(serialized.tasks),
        checkpoints: new Map(serialized.checkpoints),
      });
    }
    for (const claim of parsed.messageClaims ?? []) {
      if (!isNonEmptyString(claim?.messageId) || !isNonEmptyString(claim?.runId)) {
        errors.push("message claims require messageId and runId");
        continue;
      }
      if (messageClaims.has(claim.messageId)) {
        errors.push(`message ${claim.messageId} is claimed more than once`);
        continue;
      }
      messageClaims.set(claim.messageId, claim);
    }
  }

  if (errors.length > 0) {
    return { status: "invalid", errors };
  }

  const data: WorkItemStoreData = {
    nextId: typeof parsed.nextId === "number" ? parsed.nextId : records.size + 1,
    records,
    keyIndexBySession,
    planRuns,
    executions,
    messageClaims,
  };
  // Materialize compatibility registry entries for existing native plan runs
  // that predate the common registry; this never invents authority or alters
  // native counters.
  ensureNativeExecutions(data);
  return { status: "valid", data };
}

// START_CONTRACT: hydrateWorkflowState
//   PURPOSE: Legacy nullable hydrate kept for compatibility with existing callers.
//   INPUTS: { sessionId: string - OpenCode session identifier }
//   OUTPUTS: { WorkItemStoreData | null - restored store data or null when missing/invalid }
//   SIDE_EFFECTS: [none]
//   LINKS: [M-WORKFLOW-PERSISTENCE, hydrateWorkflowStateChecked]
// END_CONTRACT: hydrateWorkflowState
export function hydrateWorkflowState(sessionId: string): WorkItemStoreData | null {
  const result = hydrateWorkflowStateChecked(sessionId);
  return result.status === "valid" ? result.data : null;
}

// START_CONTRACT: snapshotWorkflowStateChecked
//   PURPOSE: Persist WorkItemStoreData through an atomic temporary-file replacement, surfacing failures.
//   INPUTS: { sessionId: string - session scope, data: WorkItemStoreData - store snapshot }
//   OUTPUTS: { SnapshotWorkflowStateResult - write outcome with the failure reason }
//   SIDE_EFFECTS: [Writes workflow-state.json via a temporary file and rename]
//   LINKS: [M-WORKFLOW-PERSISTENCE]
// END_CONTRACT: snapshotWorkflowStateChecked
export function snapshotWorkflowStateChecked(
  sessionId: string,
  data: WorkItemStoreData,
): SnapshotWorkflowStateResult {
  try {
    const dir = getWorkflowSessionDir(sessionId);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const records: WorkItemRecord[] = [];
    for (const record of data.records.values()) {
      if (record.sessionId === sessionId) {
        records.push(record);
      }
    }

    const sessionKeyIndex = data.keyIndexBySession.get(sessionId);
    const keyIndex: Record<string, string> = {};
    if (sessionKeyIndex) {
      for (const [key, workItemId] of sessionKeyIndex) {
        keyIndex[key] = workItemId;
      }
    }

    const planRuns: SerializedDelegatedPlanRun[] = [];
    for (const run of data.planRuns.values()) {
      if (run.sessionId === sessionId) {
        planRuns.push(serializePlanRun(run));
      }
    }

    const executions: SerializedWorkflowExecution[] = [];
    const sessionRunIds = new Set<string>();
    for (const execution of data.executions.values()) {
      if (execution.sessionId === sessionId) {
        executions.push(serializeWorkflowExecution(execution));
        sessionRunIds.add(execution.runId);
      }
    }
    const messageClaims: WorkflowMessageClaim[] = [];
    for (const claim of data.messageClaims.values()) {
      if (sessionRunIds.has(claim.runId)) messageClaims.push(claim);
    }

    const persisted: PersistedWorkflowState = {
      // Version 4 adds the common execution registry and session-wide message
      // claims on top of version 3's recovery histories and report rejections.
      version: PERSISTED_WORKFLOW_STATE_VERSION,
      updatedAt: new Date().toISOString(),
      sessionId,
      nextId: data.nextId,
      records,
      keyIndex,
      planRuns,
      executions,
      messageClaims,
    };

    const targetPath = getWorkflowStatePath(sessionId);
    const temporaryPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(temporaryPath, JSON.stringify(persisted, null, 2), "utf-8");
    renameSync(temporaryPath, targetPath);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

// START_CONTRACT: snapshotWorkflowState
//   PURPOSE: Legacy fire-and-forget snapshot kept for compatibility with existing callers.
//   INPUTS: { sessionId: string, data: WorkItemStoreData }
//   OUTPUTS: { void }
//   SIDE_EFFECTS: [Delegates to snapshotWorkflowStateChecked and swallows failures]
//   LINKS: [M-WORKFLOW-PERSISTENCE, snapshotWorkflowStateChecked]
// END_CONTRACT: snapshotWorkflowState
export function snapshotWorkflowState(sessionId: string, data: WorkItemStoreData): void {
  void snapshotWorkflowStateChecked(sessionId, data);
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
