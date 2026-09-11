// FILE: src/plugins/workflow/delegated.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Delegated work-item attempt ledger and explicit controller acceptance decisions with a checkpoint-authorized rework path.
//   SCOPE: Delegated attempt allocation bound to host callIDs, call-bound result application, bounded controller decisions (accept / request_changes with rationale, evidence, and concerns disposition), acceptance history with rework revocation, and the two-attempt budget extended only by authorized rework. Pure domain transitions over WorkItemStoreData; no tool, session, or filesystem authorization here.
//   DEPENDS: [src/plugins/workflow/protocol.ts (types), src/plugins/workflow/state.ts (types and shared helpers), src/plugins/workflow/transitions.ts]
//   LINKS: [M-WORKFLOW-DELEGATED, M-WORKFLOW-STATE, M-WORKFLOW-TRANSITIONS, M-WORKFLOW-CHECKPOINTS, V-M-WORKFLOW-DELEGATED]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   DELEGATED_BASE_ATTEMPTS - Initial controller-directed implementation attempt budget (initial plus one correction).
//   DELEGATED_RATIONALE_MAX_CHARS - Maximum accepted rationale length.
//   DELEGATED_EVIDENCE_MAX_CHARS - Maximum accepted single evidence-reference length.
//   DELEGATED_EVIDENCE_MAX_REFS - Maximum accepted evidence-reference count.
//   DelegatedImplementerStatus - Implementer result statuses recordable on an attempt.
//   DelegatedAttemptStatus - Attempt lifecycle statuses (in_flight, completed).
//   DelegatedAttempt - One host-callID-bound implementation attempt.
//   DelegatedDecisionRecord - One recorded controller decision bound to an attempt.
//   DelegatedAcceptanceRecord - One acceptance with optional later revocation.
//   DelegatedReworkRecord - One checkpoint-authorized rework event.
//   DelegatedWorkItemState - Full delegated-mode record extension.
//   DelegatedWriteScopeValidation - Result of validating declared write-scope text inputs.
//   BeginDelegatedLaunchInput - Delegated launch input with session, item, and host callID.
//   BeginDelegatedLaunchResult - Launch allocation outcome.
//   ApplyDelegatedResultInput - Call-bound delegated result payload.
//   ApplyDelegatedResultResult - Result application outcome.
//   DecideDelegatedWorkItemInput - Controller decision payload with attempt identity and bounded text.
//   DecideDelegatedWorkItemResult - Controller decision outcome.
//   ReworkDelegatedWorkItemInput - Checkpoint-authorized rework request.
//   ReworkDelegatedWorkItemResult - Authorized rework outcome.
//   delegatedAttemptBudget - Allowed attempt count given consumed attempts and rework history.
//   currentDelegatedAcceptance - Currently applicable acceptance for a record.
//   DelegatedDecisionInputValidation - Shape accepted by validateDelegatedDecisionInput.
//   validateDelegatedWriteScope - Validates declared write-scope text into canonical normalized paths.
//   validateDelegatedDecisionInput - Pure validation of decision text bounds.
//   beginDelegatedLaunch - Allocate and bind one implementation attempt to a host callID.
//   beginDelegatedLaunchInStore - Store-level delegated launch allocation.
//   revertInFlightDelegatedLaunches - Reclaim attempts orphaned by a process restart boundary.
//   applyDelegatedResult - Apply one implementer result to its matching in-flight attempt.
//   applyDelegatedResultInStore - Store-level delegated result application.
//   decideDelegatedWorkItem - Record an explicit controller accept/request_changes decision.
//   decideDelegatedWorkItemInStore - Store-level controller decision.
//   reworkDelegatedWorkItem - Reopen an accepted item under validated checkpoint-failure authorization.
//   reworkDelegatedWorkItemInStore - Store-level guarded rework reducer.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-DELEGATED-WORKFLOW-ASTRA-PRESETS - Initial module: callID-bound attempts, two-attempt budget, explicit acceptance decisions, and guarded rework.]
// END_CHANGE_SUMMARY

import type {
  WorkflowResultExcerpt,
  WorkItemRecord,
  WorkItemState,
  WorkItemStore,
  WorkItemStoreData,
} from "./state.js";
import { cloneRecord, createRecordLookupKey } from "./state.js";
import { getAllowedNextAgents } from "./transitions.js";
import { normalizeDeclaredScopePath } from "../../lib/spec-lint.js";

// START_BLOCK_DELEGATED_TYPES
export const DELEGATED_BASE_ATTEMPTS = 2;
export const DELEGATED_RATIONALE_MAX_CHARS = 2000;
export const DELEGATED_EVIDENCE_MAX_CHARS = 512;
export const DELEGATED_EVIDENCE_MAX_REFS = 8;

export type DelegatedImplementerStatus =
  | "DONE"
  | "DONE_WITH_CONCERNS"
  | "NEEDS_CONTEXT"
  | "BLOCKED";

export type DelegatedAttemptStatus = "in_flight" | "completed";

export interface DelegatedAttempt {
  attempt: number;
  callId: string;
  launchedAt: string;
  status: DelegatedAttemptStatus;
  resultStatus?: DelegatedImplementerStatus;
  resultExcerpt?: WorkflowResultExcerpt;
  completedAt?: string;
}

export interface DelegatedDecisionRecord {
  decisionId: string;
  attempt: number;
  decision: "accept" | "request_changes";
  decidedAt: string;
  rationale: string;
  evidence: string[];
  concernsDisposition?: string;
}

export interface DelegatedAcceptanceRecord {
  attempt: number;
  decisionId: string;
  acceptedAt: string;
  rationale: string;
  evidence: string[];
  concernsDisposition?: string;
  revokedAt?: string;
  revokedByReworkId?: string;
}

export interface DelegatedReworkRecord {
  reworkId: string;
  planRunId: string;
  authorizedByCheckpoint: string;
  reason: string;
  reworkedAt: string;
  revokedAcceptanceAttempt: number;
}

export interface DelegatedWorkItemState {
  writeScope: string[];
  planRunId?: string;
  planTaskId?: string;
  attempts: DelegatedAttempt[];
  decisions: DelegatedDecisionRecord[];
  acceptances: DelegatedAcceptanceRecord[];
  reworkHistory: DelegatedReworkRecord[];
}
// END_BLOCK_DELEGATED_TYPES

// START_BLOCK_DELEGATED_HELPERS
function toIsoNow(): string {
  return new Date().toISOString();
}

/** Allowed attempt count: the base budget plus one per authorized rework event. */
export function delegatedAttemptBudget(state: DelegatedWorkItemState): number {
  return DELEGATED_BASE_ATTEMPTS + state.reworkHistory.length;
}

/** Currently applicable acceptance for a record: the latest unrevoked acceptance. */
export function currentDelegatedAcceptance(
  record: WorkItemRecord,
): DelegatedAcceptanceRecord | undefined {
  if (!record.delegated) return undefined;
  return [...record.delegated.acceptances].reverse().find((acceptance) => !acceptance.revokedAt);
}

export interface DelegatedWriteScopeValidation {
  ok: boolean;
  message?: string;
  paths?: string[];
}

/** Validate declared write-scope text inputs into canonical normalized paths. */
export function validateDelegatedWriteScope(
  paths: readonly string[],
): DelegatedWriteScopeValidation {
  if (!Array.isArray(paths) || paths.length === 0) {
    return {
      ok: false,
      message: "writeScope must be a non-empty array of workspace-relative files",
    };
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const declared of paths) {
    const result = normalizeDeclaredScopePath(String(declared));
    if (!result.ok) {
      return {
        ok: false,
        message: `writeScope path ${JSON.stringify(String(declared))} is malformed (${result.reason})`,
      };
    }
    if (seen.has(result.path)) {
      return {
        ok: false,
        message: `writeScope path ${JSON.stringify(result.path)} is declared more than once`,
      };
    }
    seen.add(result.path);
    normalized.push(result.path);
  }
  return { ok: true, paths: normalized };
}

export interface DelegatedDecisionInputValidation {
  decision: "accept" | "request_changes";
  rationale: string;
  evidence: string[];
  concernsDisposition?: string;
}

/** Pure validation of decision text bounds shared by the tool layer and domain layer. */
export function validateDelegatedDecisionInput(
  input: DelegatedDecisionInputValidation,
): { ok: true } | { ok: false; message: string } {
  const rationale = typeof input.rationale === "string" ? input.rationale.trim() : "";
  if (rationale === "") {
    return { ok: false, message: "rationale must be a non-empty string" };
  }
  if (rationale.length > DELEGATED_RATIONALE_MAX_CHARS) {
    return { ok: false, message: `rationale exceeds ${DELEGATED_RATIONALE_MAX_CHARS} characters` };
  }
  if (!Array.isArray(input.evidence) || input.evidence.length === 0) {
    return { ok: false, message: "evidence must be a non-empty array of reference strings" };
  }
  if (input.evidence.length > DELEGATED_EVIDENCE_MAX_REFS) {
    return { ok: false, message: `evidence exceeds ${DELEGATED_EVIDENCE_MAX_REFS} references` };
  }
  for (const reference of input.evidence) {
    const normalized = typeof reference === "string" ? reference.trim() : "";
    if (normalized === "") {
      return { ok: false, message: "evidence references must be non-empty strings" };
    }
    if (normalized.length > DELEGATED_EVIDENCE_MAX_CHARS) {
      return {
        ok: false,
        message: `evidence reference exceeds ${DELEGATED_EVIDENCE_MAX_CHARS} characters`,
      };
    }
  }
  if (input.concernsDisposition !== undefined) {
    if (typeof input.concernsDisposition !== "string" || input.concernsDisposition.trim() === "") {
      return { ok: false, message: "concernsDisposition must be a non-empty string when provided" };
    }
    if (input.concernsDisposition.trim().length > DELEGATED_RATIONALE_MAX_CHARS) {
      return {
        ok: false,
        message: `concernsDisposition exceeds ${DELEGATED_RATIONALE_MAX_CHARS} characters`,
      };
    }
  }
  return { ok: true };
}
// END_BLOCK_DELEGATED_HELPERS

export type BeginDelegatedLaunchResult =
  | { ok: true; record: WorkItemRecord; attempt: number; callId: string }
  | {
      ok: false;
      errorCode:
        | "WORK_ITEM_NOT_FOUND"
        | "WORK_ITEM_ALREADY_CLOSED"
        | "WRONG_MODE"
        | "INVALID_STATE"
        | "ATTEMPT_IN_FLIGHT"
        | "ATTEMPTS_EXHAUSTED";
      message: string;
    };

export interface BeginDelegatedLaunchInput {
  sessionId: string;
  workItemId: string;
  callId: string;
}

function findRecord(
  store: WorkItemStoreData,
  sessionId: string,
  workItemId: string,
): WorkItemRecord | undefined {
  return store.records.get(createRecordLookupKey(sessionId, workItemId));
}

// START_CONTRACT: beginDelegatedLaunch
//   PURPOSE: Allocate one implementation attempt and bind it to the host tool-call identity.
//   INPUTS: { store: WorkItemStore - backing store, input: BeginDelegatedLaunchInput - session, item, and host callID }
//   OUTPUTS: { BeginDelegatedLaunchResult - allocated attempt or a coded rejection }
//   SIDE_EFFECTS: [Mutates the delegated attempt ledger for valid launches]
//   LINKS: [M-WORKFLOW-DELEGATED, M-WORKFLOW-STATE]
// END_CONTRACT: beginDelegatedLaunch
export function beginDelegatedLaunch(
  store: WorkItemStore,
  input: BeginDelegatedLaunchInput,
): BeginDelegatedLaunchResult {
  return beginDelegatedLaunchInStore(store.getStoreData(), input);
}

export function beginDelegatedLaunchInStore(
  store: WorkItemStoreData,
  input: BeginDelegatedLaunchInput,
): BeginDelegatedLaunchResult {
  const callId = input.callId?.trim() ?? "";
  if (!callId) {
    return { ok: false, errorCode: "INVALID_STATE", message: "callId must be a non-empty string" };
  }

  const existing = findRecord(store, input.sessionId, input.workItemId);
  if (!existing) {
    return {
      ok: false,
      errorCode: "WORK_ITEM_NOT_FOUND",
      message: `WORK_ITEM_NOT_FOUND: ${input.workItemId}`,
    };
  }
  if (existing.state === "closed") {
    return {
      ok: false,
      errorCode: "WORK_ITEM_ALREADY_CLOSED",
      message: `WORK_ITEM_ALREADY_CLOSED: ${input.workItemId} is already closed`,
    };
  }
  if (existing.mode !== "delegated" || !existing.delegated) {
    return {
      ok: false,
      errorCode: "WRONG_MODE",
      message: `WRONG_MODE: ${input.workItemId} is ${existing.mode}, not delegated`,
    };
  }
  if (!getAllowedNextAgents(existing).includes("vv-implementer")) {
    return {
      ok: false,
      errorCode: "INVALID_STATE",
      message: `INVALID_STATE: ${input.workItemId} is ${existing.state} and cannot start an implementation attempt`,
    };
  }

  const delegated = existing.delegated;
  if (delegated.attempts.some((attempt) => attempt.status === "in_flight")) {
    return {
      ok: false,
      errorCode: "ATTEMPT_IN_FLIGHT",
      message: `ATTEMPT_IN_FLIGHT: ${input.workItemId} already has an in-flight implementation attempt`,
    };
  }
  if (delegated.attempts.length >= delegatedAttemptBudget(delegated)) {
    return {
      ok: false,
      errorCode: "ATTEMPTS_EXHAUSTED",
      message: `ATTEMPTS_EXHAUSTED: ${input.workItemId} consumed ${delegated.attempts.length} of ${delegatedAttemptBudget(delegated)} allowed attempts; explicit recovery or checkpoint-authorized rework is required`,
    };
  }

  const attemptNumber = delegated.attempts.length + 1;
  const now = toIsoNow();
  const updated: WorkItemRecord = {
    ...existing,
    state: "awaiting_implementer",
    delegated: {
      ...delegated,
      attempts: [
        ...delegated.attempts,
        { attempt: attemptNumber, callId, launchedAt: now, status: "in_flight" },
      ],
    },
    updatedAt: now,
  };
  store.records.set(createRecordLookupKey(input.sessionId, input.workItemId), updated);

  return { ok: true, record: cloneRecord(updated), attempt: attemptNumber, callId };
}

export type ApplyDelegatedResultResult =
  | {
      ok: true;
      record: WorkItemRecord;
      fromState: WorkItemState;
      toState: WorkItemState;
      attempt: number;
      resultStatus: DelegatedImplementerStatus;
    }
  | {
      ok: false;
      errorCode:
        | "WORK_ITEM_NOT_FOUND"
        | "WORK_ITEM_ALREADY_CLOSED"
        | "WRONG_MODE"
        | "STALE_CALLBACK"
        | "INVALID_RESULT_STATUS";
      message: string;
    };

export interface ApplyDelegatedResultInput {
  sessionId: string;
  workItemId: string;
  callId: string;
  resultStatus: DelegatedImplementerStatus;
  resultExcerpt?: WorkflowResultExcerpt;
}

const DELEGATED_RESULT_STATUSES: ReadonlySet<string> = new Set([
  "DONE",
  "DONE_WITH_CONCERNS",
  "NEEDS_CONTEXT",
  "BLOCKED",
]);

// START_CONTRACT: applyDelegatedResult
//   PURPOSE: Apply one implementer result to its matching in-flight attempt and move DONE or DONE_WITH_CONCERNS to awaiting_acceptance.
//   INPUTS: { store: WorkItemStore - backing store, input: ApplyDelegatedResultInput - call-bound result payload }
//   OUTPUTS: { ApplyDelegatedResultResult - applied transition or a coded rejection including stale callbacks }
//   SIDE_EFFECTS: [Mutates the matching delegated attempt and the work-item state]
//   LINKS: [M-WORKFLOW-DELEGATED, M-WORKFLOW-STATE]
// END_CONTRACT: applyDelegatedResult
export function applyDelegatedResult(
  store: WorkItemStore,
  input: ApplyDelegatedResultInput,
): ApplyDelegatedResultResult {
  return applyDelegatedResultInStore(store.getStoreData(), input);
}

export function applyDelegatedResultInStore(
  store: WorkItemStoreData,
  input: ApplyDelegatedResultInput,
): ApplyDelegatedResultResult {
  const existing = findRecord(store, input.sessionId, input.workItemId);
  if (!existing) {
    return {
      ok: false,
      errorCode: "WORK_ITEM_NOT_FOUND",
      message: `WORK_ITEM_NOT_FOUND: no work item ${input.workItemId} for session ${input.sessionId}`,
    };
  }
  if (existing.state === "closed") {
    return {
      ok: false,
      errorCode: "WORK_ITEM_ALREADY_CLOSED",
      message: `WORK_ITEM_ALREADY_CLOSED: ${input.workItemId} is already closed`,
    };
  }
  if (existing.mode !== "delegated" || !existing.delegated) {
    return {
      ok: false,
      errorCode: "WRONG_MODE",
      message: `WRONG_MODE: ${input.workItemId} is ${existing.mode}, not delegated`,
    };
  }
  if (!DELEGATED_RESULT_STATUSES.has(input.resultStatus)) {
    return {
      ok: false,
      errorCode: "INVALID_RESULT_STATUS",
      message: `INVALID_RESULT_STATUS: ${String(input.resultStatus)} is not a delegated implementer status`,
    };
  }

  const inFlight = existing.delegated.attempts.find((attempt) => attempt.status === "in_flight");
  if (!inFlight || inFlight.callId !== input.callId) {
    return {
      ok: false,
      errorCode: "STALE_CALLBACK",
      message: `STALE_CALLBACK: ${input.callId} does not match the in-flight attempt ${inFlight ? inFlight.callId : "(none)"} for ${input.workItemId}`,
    };
  }

  const now = toIsoNow();
  const fromState = existing.state;
  const nextState: WorkItemState =
    input.resultStatus === "DONE" || input.resultStatus === "DONE_WITH_CONCERNS"
      ? "awaiting_acceptance"
      : input.resultStatus === "NEEDS_CONTEXT"
        ? "needs_context"
        : "blocked";

  const updated: WorkItemRecord = {
    ...existing,
    state: nextState,
    ...(input.resultExcerpt ? { resultExcerpt: input.resultExcerpt } : {}),
    delegated: {
      ...existing.delegated,
      attempts: existing.delegated.attempts.map((attempt) =>
        attempt.attempt === inFlight.attempt
          ? {
              ...attempt,
              status: "completed" as const,
              resultStatus: input.resultStatus,
              completedAt: now,
              ...(input.resultExcerpt ? { resultExcerpt: input.resultExcerpt } : {}),
            }
          : attempt,
      ),
    },
    updatedAt: now,
  };
  store.records.set(createRecordLookupKey(input.sessionId, input.workItemId), updated);

  return {
    ok: true,
    record: cloneRecord(updated),
    fromState,
    toState: nextState,
    attempt: inFlight.attempt,
    resultStatus: input.resultStatus,
  };
}

export type DecideDelegatedWorkItemResult =
  | {
      ok: true;
      record: WorkItemRecord;
      decision: "accept" | "request_changes";
      decisionId: string;
    }
  | {
      ok: false;
      errorCode:
        | "WORK_ITEM_NOT_FOUND"
        | "WORK_ITEM_ALREADY_CLOSED"
        | "WRONG_MODE"
        | "INVALID_STATE"
        | "INVALID_ATTEMPT"
        | "DUPLICATE_DECISION"
        | "CONCERNS_DISPOSITION_REQUIRED"
        | "UNEXPECTED_CONCERNS_DISPOSITION"
        | "INVALID_INPUT";
      message: string;
    };

export interface DecideDelegatedWorkItemInput {
  sessionId: string;
  workItemId: string;
  attempt: number;
  decision: "accept" | "request_changes";
  rationale: string;
  evidence: string[];
  concernsDisposition?: string;
}

// START_CONTRACT: decideDelegatedWorkItem
//   PURPOSE: Record an explicit controller accept or request_changes decision bound to the current completed attempt.
//   INPUTS: { store: WorkItemStore - backing store, input: DecideDelegatedWorkItemInput - decision payload with attempt identity and bounded text }
//   OUTPUTS: { DecideDelegatedWorkItemResult - applied decision or a coded rejection without mutation }
//   SIDE_EFFECTS: [Mutates decision history, acceptance state, and the work-item lifecycle state]
//   LINKS: [M-WORKFLOW-DELEGATED, M-WORKFLOW-STATE]
// END_CONTRACT: decideDelegatedWorkItem
export function decideDelegatedWorkItem(
  store: WorkItemStore,
  input: DecideDelegatedWorkItemInput,
): DecideDelegatedWorkItemResult {
  return decideDelegatedWorkItemInStore(store.getStoreData(), input);
}

export function decideDelegatedWorkItemInStore(
  store: WorkItemStoreData,
  input: DecideDelegatedWorkItemInput,
): DecideDelegatedWorkItemResult {
  if (input.decision !== "accept" && input.decision !== "request_changes") {
    return {
      ok: false,
      errorCode: "INVALID_INPUT",
      message: "INVALID_INPUT: decision must be accept or request_changes",
    };
  }
  const validation = validateDelegatedDecisionInput({
    decision: input.decision,
    rationale: input.rationale,
    evidence: input.evidence,
    concernsDisposition: input.concernsDisposition,
  });
  if (!validation.ok) {
    return {
      ok: false,
      errorCode: "INVALID_INPUT",
      message: `INVALID_INPUT: ${validation.message}`,
    };
  }
  if (!Number.isInteger(input.attempt) || input.attempt < 1) {
    return {
      ok: false,
      errorCode: "INVALID_INPUT",
      message: "INVALID_INPUT: attempt must be a positive integer",
    };
  }

  const existing = findRecord(store, input.sessionId, input.workItemId);
  if (!existing) {
    return {
      ok: false,
      errorCode: "WORK_ITEM_NOT_FOUND",
      message: `WORK_ITEM_NOT_FOUND: no work item ${input.workItemId} for session ${input.sessionId}`,
    };
  }
  if (existing.state === "closed") {
    return {
      ok: false,
      errorCode: "WORK_ITEM_ALREADY_CLOSED",
      message: `WORK_ITEM_ALREADY_CLOSED: ${input.workItemId} is already closed`,
    };
  }
  if (existing.mode !== "delegated" || !existing.delegated) {
    return {
      ok: false,
      errorCode: "WRONG_MODE",
      message: `WRONG_MODE: ${input.workItemId} is ${existing.mode}; only delegated items receive controller decisions`,
    };
  }
  if (existing.state !== "awaiting_acceptance") {
    return {
      ok: false,
      errorCode: "INVALID_STATE",
      message: `INVALID_STATE: ${input.workItemId} is ${existing.state}, not awaiting_acceptance`,
    };
  }

  const completed = [...existing.delegated.attempts]
    .filter((attempt) => attempt.status === "completed")
    .sort((left, right) => right.attempt - left.attempt)[0];
  if (!completed) {
    return {
      ok: false,
      errorCode: "INVALID_STATE",
      message: `INVALID_STATE: ${input.workItemId} has no completed attempt to decide`,
    };
  }
  if (completed.attempt !== input.attempt) {
    return {
      ok: false,
      errorCode: "INVALID_ATTEMPT",
      message: `INVALID_ATTEMPT: decision targets attempt ${input.attempt} but the current completed attempt is ${completed.attempt}`,
    };
  }
  if (existing.delegated.decisions.some((decision) => decision.attempt === input.attempt)) {
    return {
      ok: false,
      errorCode: "DUPLICATE_DECISION",
      message: `DUPLICATE_DECISION: attempt ${input.attempt} already received a controller decision`,
    };
  }

  const hasConcerns = completed.resultStatus === "DONE_WITH_CONCERNS";
  if (hasConcerns && input.concernsDisposition === undefined) {
    return {
      ok: false,
      errorCode: "CONCERNS_DISPOSITION_REQUIRED",
      message: `CONCERNS_DISPOSITION_REQUIRED: attempt ${input.attempt} completed DONE_WITH_CONCERNS and requires an explicit disposition`,
    };
  }
  if (!hasConcerns && input.concernsDisposition !== undefined) {
    return {
      ok: false,
      errorCode: "UNEXPECTED_CONCERNS_DISPOSITION",
      message: `UNEXPECTED_CONCERNS_DISPOSITION: attempt ${input.attempt} completed ${completed.resultStatus}, not DONE_WITH_CONCERNS`,
    };
  }

  const now = toIsoNow();
  const decisionId = `dec-${existing.workItemId}-a${input.attempt}`;
  const decision: DelegatedDecisionRecord = {
    decisionId,
    attempt: input.attempt,
    decision: input.decision,
    decidedAt: now,
    rationale: input.rationale.trim(),
    evidence: input.evidence.map((reference) => reference.trim()),
    ...(input.concernsDisposition !== undefined
      ? { concernsDisposition: input.concernsDisposition.trim() }
      : {}),
  };

  const nextState: WorkItemState =
    input.decision === "accept" ? "ready_to_close" : "awaiting_implementer";
  const updated: WorkItemRecord = {
    ...existing,
    state: nextState,
    delegated: {
      ...existing.delegated,
      decisions: [...existing.delegated.decisions, decision],
      ...(input.decision === "accept"
        ? {
            acceptances: [
              ...existing.delegated.acceptances,
              {
                attempt: input.attempt,
                decisionId,
                acceptedAt: now,
                rationale: input.rationale.trim(),
                evidence: input.evidence.map((reference) => reference.trim()),
                ...(input.concernsDisposition !== undefined
                  ? { concernsDisposition: input.concernsDisposition.trim() }
                  : {}),
              },
            ],
          }
        : {}),
    },
    updatedAt: now,
  };
  store.records.set(createRecordLookupKey(input.sessionId, input.workItemId), updated);

  return { ok: true, record: cloneRecord(updated), decision: input.decision, decisionId };
}

export type ReworkDelegatedWorkItemResult =
  | { ok: true; record: WorkItemRecord; reworkId: string; grantedAttempts: number }
  | {
      ok: false;
      errorCode:
        | "WORK_ITEM_NOT_FOUND"
        | "WRONG_MODE"
        | "INVALID_STATE"
        | "HARD_STOP_STATE"
        | "NOT_ACCEPTED"
        | "ALREADY_REWORKED"
        | "INVALID_INPUT";
      message: string;
    };

export interface ReworkDelegatedWorkItemInput {
  sessionId: string;
  workItemId: string;
  planRunId: string;
  failedCheckpointId: string;
  reason: string;
}

// START_CONTRACT: reworkDelegatedWorkItem
//   PURPOSE: Reopen an accepted delegated item under validated checkpoint-failure authorization without resetting attempt history.
//   INPUTS: { store: WorkItemStore - backing store, input: ReworkDelegatedWorkItemInput - checkpoint authorization payload }
//   OUTPUTS: { ReworkDelegatedWorkItemResult - reopened record with one extra granted attempt or a coded rejection }
//   SIDE_EFFECTS: [Revokes the current acceptance's applicability, records the rework event, and returns the item to awaiting_implementer]
//   LINKS: [M-WORKFLOW-DELEGATED, M-WORKFLOW-CHECKPOINTS]
// END_CONTRACT: reworkDelegatedWorkItem
export function reworkDelegatedWorkItem(
  store: WorkItemStore,
  input: ReworkDelegatedWorkItemInput,
): ReworkDelegatedWorkItemResult {
  return reworkDelegatedWorkItemInStore(store.getStoreData(), input);
}

export function reworkDelegatedWorkItemInStore(
  store: WorkItemStoreData,
  input: ReworkDelegatedWorkItemInput,
): ReworkDelegatedWorkItemResult {
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  const planRunId = typeof input.planRunId === "string" ? input.planRunId.trim() : "";
  const failedCheckpointId =
    typeof input.failedCheckpointId === "string" ? input.failedCheckpointId.trim() : "";
  if (!reason || reason.length > DELEGATED_RATIONALE_MAX_CHARS) {
    return {
      ok: false,
      errorCode: "INVALID_INPUT",
      message: `INVALID_INPUT: reason must be non-empty and at most ${DELEGATED_RATIONALE_MAX_CHARS} characters`,
    };
  }
  if (!planRunId || !failedCheckpointId) {
    return {
      ok: false,
      errorCode: "INVALID_INPUT",
      message: "INVALID_INPUT: planRunId and failedCheckpointId must be non-empty",
    };
  }

  const existing = findRecord(store, input.sessionId, input.workItemId);
  if (!existing) {
    return {
      ok: false,
      errorCode: "WORK_ITEM_NOT_FOUND",
      message: `WORK_ITEM_NOT_FOUND: no work item ${input.workItemId} for session ${input.sessionId}`,
    };
  }
  if (existing.mode !== "delegated" || !existing.delegated) {
    return {
      ok: false,
      errorCode: "WRONG_MODE",
      message: `WRONG_MODE: ${input.workItemId} is ${existing.mode}, not delegated`,
    };
  }
  if (existing.state === "needs_context" || existing.state === "blocked") {
    return {
      ok: false,
      errorCode: "HARD_STOP_STATE",
      message: `HARD_STOP_STATE: ${input.workItemId} is ${existing.state} and cannot be reopened by rework`,
    };
  }
  if (existing.state !== "ready_to_close" && existing.state !== "closed") {
    return {
      ok: false,
      errorCode: "INVALID_STATE",
      message: `INVALID_STATE: ${input.workItemId} is ${existing.state}; rework targets accepted items`,
    };
  }

  const delegated = existing.delegated;
  const current = currentDelegatedAcceptance(existing);
  if (!current || current.revokedAt) {
    return {
      ok: false,
      errorCode: "NOT_ACCEPTED",
      message: `NOT_ACCEPTED: ${input.workItemId} has no currently applicable acceptance to revoke`,
    };
  }
  if (
    delegated.reworkHistory.some((rework) => rework.authorizedByCheckpoint === failedCheckpointId)
  ) {
    return {
      ok: false,
      errorCode: "ALREADY_REWORKED",
      message: `ALREADY_REWORKED: checkpoint ${failedCheckpointId} already authorized one rework of ${input.workItemId}`,
    };
  }
  if (delegated.planRunId && delegated.planRunId !== planRunId) {
    return {
      ok: false,
      errorCode: "INVALID_INPUT",
      message: `INVALID_INPUT: ${input.workItemId} belongs to plan run ${delegated.planRunId}, not ${planRunId}`,
    };
  }

  const now = toIsoNow();
  const reworkId = `rw-${existing.workItemId}-${failedCheckpointId}`;
  const rework: DelegatedReworkRecord = {
    reworkId,
    planRunId,
    authorizedByCheckpoint: failedCheckpointId,
    reason,
    reworkedAt: now,
    revokedAcceptanceAttempt: current.attempt,
  };

  const updated: WorkItemRecord = {
    ...existing,
    state: "awaiting_implementer",
    closedAt: undefined,
    delegated: {
      ...delegated,
      reworkHistory: [...delegated.reworkHistory, rework],
      acceptances: delegated.acceptances.map((acceptance) =>
        acceptance === current
          ? { ...acceptance, revokedAt: now, revokedByReworkId: reworkId }
          : acceptance,
      ),
    },
    updatedAt: now,
  };
  store.records.set(createRecordLookupKey(input.sessionId, input.workItemId), updated);

  return {
    ok: true,
    record: cloneRecord(updated),
    reworkId,
    grantedAttempts: delegatedAttemptBudget(updated.delegated as DelegatedWorkItemState),
  };
}

// START_CONTRACT: revertInFlightDelegatedLaunches
//   PURPOSE: Reclaim delegated attempts that a process-restart boundary orphaned, restoring their items to a launchable state without consuming budget.
//   INPUTS: { store: WorkItemStoreData - hydrated store data, sessionId: string - owning session }
//   OUTPUTS: { { reverted: number; workItemIds: string[] } - reclaimed attempts and affected items }
//   SIDE_EFFECTS: [Removes never-completed in-flight attempts from the ledger and returns items to awaiting_implementer]
//   LINKS: [M-WORKFLOW-DELEGATED, M-WORKFLOW-PERSISTENCE, M-PLUGIN-WORKFLOW]
// END_CONTRACT: revertInFlightDelegatedLaunches
export function revertInFlightDelegatedLaunches(
  store: WorkItemStoreData,
  sessionId: string,
): { reverted: number; workItemIds: string[] } {
  const reverted: string[] = [];
  for (const [lookupKey, record] of store.records) {
    if (record.sessionId !== sessionId || record.mode !== "delegated" || !record.delegated)
      continue;
    const inFlight = record.delegated.attempts.filter((attempt) => attempt.status === "in_flight");
    if (inFlight.length === 0) continue;
    // Only the plugin's first store creation for a freshly hydrated session
    // calls this reclamation. A persisted in-flight attempt can never receive
    // its host callback after a restart, so reverting it (without consuming
    // budget — it never completed) is the only non-dead-end recovery. Items
    // stay hard-stopped when they are already blocked or needs_context.
    if (
      record.state === "needs_context" ||
      record.state === "blocked" ||
      record.state === "closed"
    ) {
      continue;
    }
    const attempts = record.delegated.attempts.filter((attempt) => attempt.status !== "in_flight");
    store.records.set(lookupKey, {
      ...record,
      state:
        attempts.length > 0 || record.delegated.decisions.length > 0
          ? "awaiting_implementer"
          : "open",
      delegated: {
        ...record.delegated,
        attempts,
      },
      updatedAt: toIsoNow(),
    });
    reverted.push(record.workItemId);
  }
  return { reverted: reverted.length, workItemIds: reverted };
}
