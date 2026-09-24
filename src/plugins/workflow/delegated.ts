// FILE: src/plugins/workflow/delegated.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Delegated work-item attempt ledger with bounded recovery, terminal report-rejection settlement, and explicit controller acceptance decisions with a checkpoint-authorized rework path.
//   SCOPE: Delegated attempt allocation bound to host callIDs with per-session callID uniqueness, call-bound result application, call-bound host-terminal launch failure recorded as a distinct failed attempt (bounded evidence, no budget refund, no state advance), bounded controller decisions (accept / request_changes with rationale, evidence, and concerns disposition), acceptance history with rework revocation, the two-attempt budget extended only by authorized rework or one-unit recovery grants, bounded recovery of stopped or exhausted unaccepted items (diagnosis, changed condition, verification references, stable recoveryId, optional root-user message authorization validated through a read-only lookup with replay protection), call-bound settlement of confirmed terminal protocol-invalid reports as report_rejected attempts with bounded diagnostics preserved substantive hard stops, and progress summaries exposing remaining budget and supported next actions. Pure domain transitions over WorkItemStoreData; no tool, session, or filesystem authorization here.
//   DEPENDS: [src/plugins/workflow/protocol.ts (types), src/plugins/workflow/state.ts (types and shared helpers), src/plugins/workflow/transitions.ts, src/lib/workflow-contract.ts]
//   LINKS: [M-WORKFLOW-DELEGATED, M-WORKFLOW-STATE, M-WORKFLOW-TRANSITIONS, M-WORKFLOW-CHECKPOINTS, M-WORKFLOW-CONTRACT, V-M-WORKFLOW-DELEGATED]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   DELEGATED_BASE_ATTEMPTS - Initial controller-directed implementation attempt budget (initial plus one correction).
//   DELEGATED_RATIONALE_MAX_CHARS - Maximum accepted rationale, diagnosis, and changed-condition length.
//   DELEGATED_EVIDENCE_MAX_CHARS - Maximum accepted single evidence/verification reference length.
//   DELEGATED_EVIDENCE_MAX_REFS - Maximum accepted evidence/verification reference count.
//   DELEGATED_RECOVERY_CODE_MAX_CHARS - Maximum accepted protocol error code stored in report rejections.
//   DelegatedImplementerStatus - Implementer result statuses recordable on an attempt.
//   DelegatedAttempt - One host-callID-bound implementation attempt.
//   DelegatedAttemptStatus - Attempt lifecycle statuses (in_flight, completed, failed, report_rejected).
//   DelegatedAttemptReportRejection - Bounded rejected-report record for a terminal protocol-invalid result.
//   DelegatedDecisionRecord - One recorded controller decision bound to an attempt.
//   DelegatedAcceptanceRecord - One acceptance with optional later revocation.
//   DelegatedReworkRecord - One checkpoint-authorized rework event.
//   DelegatedRecoveryKind - One recovery unit kind (resume, autonomous grant, user grant).
//   DelegatedRecoveryRecord - One bounded recovery event bound to its terminal target attempt.
//   DelegatedWorkItemState - Full delegated-mode record extension including recovery history.
//   DelegatedWriteScopeValidation - Result of validating declared write-scope text inputs.
//   DelegatedRecoveryInputValidation - Shape accepted by validateDelegatedRecoveryInput.
//   RecoveryUserMessageSnapshot - Identity and timing metadata of one candidate authorization message.
//   LookupRecoveryUserMessage - Read-only authorization message lookup bound to the plugin SDK.
//   RecoveryAuthorizationResult - Outcome of validating one root-user authorization reference.
//   DelegatedProgressSummary - Inspectable budget, stop, and rejected-report snapshot with next action.
//   DelegatedNextAction - Supported next action suggested by progress summaries.
//   BeginDelegatedLaunchInput - Delegated launch input with session, item, and host callID.
//   BeginDelegatedLaunchResult - Launch allocation outcome.
//   ApplyDelegatedResultInput - Call-bound delegated result payload.
//   ApplyDelegatedResultResult - Result application outcome.
//   DecideDelegatedWorkItemInput - Controller decision payload with attempt identity and bounded text.
//   DecideDelegatedWorkItemResult - Controller decision outcome.
//   ReworkDelegatedWorkItemInput - Checkpoint-authorized rework request.
//   ReworkDelegatedWorkItemResult - Authorized rework outcome.
//   RecoverDelegatedWorkItemInput - Bounded recovery request with optional user authorization.
//   RecoverDelegatedWorkItemResult - Recovery outcome with budget and kind, or a coded rejection.
//   ApplyDelegatedReportRejectionInput - Call-bound terminal report-rejection payload.
//   ApplyDelegatedReportRejectionResult - Report-rejection settlement outcome.
//   delegatedAttemptBudget - Allowed attempt count given consumed attempts, rework, and recovery grants.
//   delegatedRecoveryGrantCount - Number of budget-granting recovery entries in a history.
//   delegatedAutonomousGrantConsumed - Whether the single autonomous grant is already recorded.
//   currentDelegatedAcceptance - Currently applicable acceptance for a record.
//   DelegatedLaunchGateReason - Item-level ordinary launch rejection reasons.
//   DelegatedLaunchGate - Item-level ordinary launch decision shared by mutation and inspection.
//   delegatedOrdinaryLaunchGate - Pure item-level ordinary-implementer launch gate.
//   summarizeDelegatedProgress - Budget, terminal-state, and next-action summary for inspection.
//   DelegatedDecisionInputValidation - Shape accepted by validateDelegatedDecisionInput.
//   validateDelegatedWriteScope - Validates declared write-scope text into canonical normalized paths.
//   validateDelegatedDecisionInput - Pure validation of decision text bounds.
//   validateDelegatedRecoveryInput - Pure validation of recovery text bounds shared by tool and domain layers.
//   validateRecoveryUserAuthorization - Validates one authorization reference against its root-session message snapshot.
//   beginDelegatedLaunch - Allocate and bind one implementation attempt to a host callID.
//   beginDelegatedLaunchInStore - Store-level delegated launch allocation.
//   revertInFlightDelegatedLaunches - Reclaim attempts orphaned by a process restart boundary.
//   applyDelegatedResult - Apply one implementer result to its matching in-flight attempt.
//   applyDelegatedResultInStore - Store-level delegated result application.
//   ApplyDelegatedLaunchFailureInput - Call-bound host-terminal launch-failure payload.
//   ApplyDelegatedLaunchFailureResult - Host-terminal launch-failure outcome.
//   applyDelegatedLaunchFailure - Record a confirmed host-terminal launch failure on its matching in-flight attempt.
//   applyDelegatedLaunchFailureInStore - Store-level failed-attempt transition.
//   applyDelegatedReportRejection - Settle one confirmed terminal protocol-invalid report on its call-bound attempt.
//   applyDelegatedReportRejectionInStore - Store-level report-rejection settlement.
//   decideDelegatedWorkItem - Record an explicit controller accept/request_changes decision.
//   decideDelegatedWorkItemInStore - Store-level controller decision.
//   reworkDelegatedWorkItem - Reopen an accepted item under validated checkpoint-failure authorization.
//   reworkDelegatedWorkItemInStore - Store-level guarded rework reducer.
//   recoverDelegatedWorkItem - Resume or grant exactly one additional attempt for a stopped or exhausted unaccepted item.
//   recoverDelegatedWorkItemInStore - Store-level guarded recovery reducer.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-004 - Extracted the shared pure item-level ordinary-launch gate (delegatedOrdinaryLaunchGate) now consumed by beginDelegatedLaunchInStore and the read-only inspection guidance so a suggested launch can never disagree with the real mutation gate. Prior T-002: validateDelegatedWriteScope rejects non-string entries with their index instead of stringifying them into the declared scope.]
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
import { normalizeDeclaredScopePath } from "../../lib/workflow-contract.js";

// START_BLOCK_DELEGATED_TYPES
export const DELEGATED_BASE_ATTEMPTS = 2;
export const DELEGATED_RATIONALE_MAX_CHARS = 2000;
export const DELEGATED_EVIDENCE_MAX_CHARS = 512;
export const DELEGATED_EVIDENCE_MAX_REFS = 8;
export const DELEGATED_RECOVERY_CODE_MAX_CHARS = 128;

export type DelegatedImplementerStatus =
  | "DONE"
  | "DONE_WITH_CONCERNS"
  | "NEEDS_CONTEXT"
  | "BLOCKED";

export type DelegatedAttemptStatus = "in_flight" | "completed" | "failed" | "report_rejected";

/** Bounded rejected-report record for a confirmed terminal protocol-invalid result. */
export interface DelegatedAttemptReportRejection {
  protocolErrorCode: string;
  excerpt: WorkflowResultExcerpt;
  rejectedAt: string;
}

export interface DelegatedAttempt {
  attempt: number;
  callId: string;
  launchedAt: string;
  status: DelegatedAttemptStatus;
  resultStatus?: DelegatedImplementerStatus;
  resultExcerpt?: WorkflowResultExcerpt;
  /** Bounded host wrapper error for a confirmed host-terminal launch failure. */
  failureExcerpt?: WorkflowResultExcerpt;
  /** Terminal protocol-invalid report settlement with bounded diagnostics. */
  reportRejection?: DelegatedAttemptReportRejection;
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

export type DelegatedRecoveryKind = "resume" | "autonomous_grant" | "user_grant" | "advance_grant";

/**
 * One bounded recovery event. `resume` returns a stopped item to the launch
 * gate without manufacturing budget; grant kinds add exactly one attempt each
 * and stay replay-protected by recoveryId and userMessageId.
 */
export interface DelegatedRecoveryRecord {
  recoveryId: string;
  targetAttempt: number;
  kind: DelegatedRecoveryKind;
  diagnosis: string;
  changedCondition: string;
  verification: string[];
  recoveredAt: string;
  userMessageId?: string;
}

export interface DelegatedWorkItemState {
  writeScope: string[];
  planRunId?: string;
  planTaskId?: string;
  attempts: DelegatedAttempt[];
  decisions: DelegatedDecisionRecord[];
  acceptances: DelegatedAcceptanceRecord[];
  reworkHistory: DelegatedReworkRecord[];
  recoveryHistory: DelegatedRecoveryRecord[];
}
// END_BLOCK_DELEGATED_TYPES

// START_BLOCK_DELEGATED_HELPERS
function toIsoNow(): string {
  return new Date().toISOString();
}

/** Count of budget-granting recovery entries in a recovery history. */
export function delegatedRecoveryGrantCount(history: readonly DelegatedRecoveryRecord[]): number {
  return history.filter(
    (entry) =>
      entry.kind === "autonomous_grant" ||
      entry.kind === "user_grant" ||
      entry.kind === "advance_grant",
  ).length;
}

/** Allowed attempt count: base budget plus one per authorized rework or recovery grant. */
export function delegatedAttemptBudget(state: DelegatedWorkItemState): number {
  return (
    DELEGATED_BASE_ATTEMPTS +
    state.reworkHistory.length +
    delegatedRecoveryGrantCount(state.recoveryHistory)
  );
}

/** Whether the single autonomous recovery grant is already recorded for this item. */
export function delegatedAutonomousGrantConsumed(
  history: readonly DelegatedRecoveryRecord[],
): boolean {
  return history.some((entry) => entry.kind === "autonomous_grant");
}

// START_BLOCK_DELEGATED_LAUNCH_GATE
/** Item-level reasons an ordinary delegated implementer launch is rejected. */
export type DelegatedLaunchGateReason =
  | "WORK_ITEM_NOT_FOUND"
  | "WORK_ITEM_ALREADY_CLOSED"
  | "WRONG_MODE"
  | "INVALID_STATE"
  | "ATTEMPT_IN_FLIGHT"
  | "ATTEMPTS_EXHAUSTED";

/** Item-level ordinary-implementer launch decision shared by mutation and inspection. */
export interface DelegatedLaunchGate {
  ok: boolean;
  reason?: DelegatedLaunchGateReason;
  message?: string;
}

/**
 * Pure item-level ordinary-implementer launch gate. `beginDelegatedLaunchInStore`
 * consumes this so the real mutation and read-only inspection surface the same
 * coded rejection and message. It never reads a store beyond the supplied record.
 */
export function delegatedOrdinaryLaunchGate(record: WorkItemRecord): DelegatedLaunchGate {
  if (record.state === "closed") {
    return {
      ok: false,
      reason: "WORK_ITEM_ALREADY_CLOSED",
      message: `WORK_ITEM_ALREADY_CLOSED: ${record.workItemId} is already closed`,
    };
  }
  if (record.mode !== "delegated" || !record.delegated) {
    return {
      ok: false,
      reason: "WRONG_MODE",
      message: `WRONG_MODE: ${record.workItemId} is ${record.mode}, not delegated`,
    };
  }
  if (!getAllowedNextAgents(record).includes("vv-implementer")) {
    return {
      ok: false,
      reason: "INVALID_STATE",
      message: `INVALID_STATE: ${record.workItemId} is ${record.state} and cannot start an implementation attempt`,
    };
  }
  const delegated = record.delegated;
  if (delegated.attempts.some((attempt) => attempt.status === "in_flight")) {
    return {
      ok: false,
      reason: "ATTEMPT_IN_FLIGHT",
      message: `ATTEMPT_IN_FLIGHT: ${record.workItemId} already has an in-flight implementation attempt`,
    };
  }
  if (delegated.attempts.length >= delegatedAttemptBudget(delegated)) {
    return {
      ok: false,
      reason: "ATTEMPTS_EXHAUSTED",
      message: `ATTEMPTS_EXHAUSTED: ${record.workItemId} consumed ${delegated.attempts.length} of ${delegatedAttemptBudget(delegated)} allowed attempts; explicit recovery or checkpoint-authorized rework is required`,
    };
  }
  return { ok: true };
}
// END_BLOCK_DELEGATED_LAUNCH_GATE

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
  for (let index = 0; index < paths.length; index += 1) {
    const declared: unknown = paths[index];
    if (typeof declared !== "string") {
      return {
        ok: false,
        message: `writeScope entry at index ${index} must be a string`,
      };
    }
    const result = normalizeDeclaredScopePath(declared);
    if (!result.ok) {
      return {
        ok: false,
        message: `writeScope path ${JSON.stringify(declared)} is malformed (${result.reason})`,
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

export interface DelegatedRecoveryInputValidation {
  diagnosis: string;
  changedCondition: string;
  verification: string[];
  recoveryId: string;
}

/** Pure validation of bounded recovery text shared by the tool layer and domain layer. */
export function validateDelegatedRecoveryInput(
  input: DelegatedRecoveryInputValidation,
): { ok: true } | { ok: false; message: string } {
  const recoveryId = typeof input.recoveryId === "string" ? input.recoveryId.trim() : "";
  if (recoveryId === "") {
    return { ok: false, message: "recoveryId must be a non-empty string" };
  }
  if (recoveryId.length > DELEGATED_EVIDENCE_MAX_CHARS) {
    return { ok: false, message: `recoveryId exceeds ${DELEGATED_EVIDENCE_MAX_CHARS} characters` };
  }
  const diagnosis = typeof input.diagnosis === "string" ? input.diagnosis.trim() : "";
  if (diagnosis === "") {
    return { ok: false, message: "diagnosis must be a non-empty string" };
  }
  if (diagnosis.length > DELEGATED_RATIONALE_MAX_CHARS) {
    return { ok: false, message: `diagnosis exceeds ${DELEGATED_RATIONALE_MAX_CHARS} characters` };
  }
  const changedCondition =
    typeof input.changedCondition === "string" ? input.changedCondition.trim() : "";
  if (changedCondition === "") {
    return { ok: false, message: "changedCondition must be a non-empty string" };
  }
  if (changedCondition.length > DELEGATED_RATIONALE_MAX_CHARS) {
    return {
      ok: false,
      message: `changedCondition exceeds ${DELEGATED_RATIONALE_MAX_CHARS} characters`,
    };
  }
  if (!Array.isArray(input.verification) || input.verification.length === 0) {
    return { ok: false, message: "verification must be a non-empty array of reference strings" };
  }
  if (input.verification.length > DELEGATED_EVIDENCE_MAX_REFS) {
    return { ok: false, message: `verification exceeds ${DELEGATED_EVIDENCE_MAX_REFS} references` };
  }
  for (const reference of input.verification) {
    const normalized = typeof reference === "string" ? reference.trim() : "";
    if (normalized === "") {
      return { ok: false, message: "verification references must be non-empty strings" };
    }
    if (normalized.length > DELEGATED_EVIDENCE_MAX_CHARS) {
      return {
        ok: false,
        message: `verification reference exceeds ${DELEGATED_EVIDENCE_MAX_CHARS} characters`,
      };
    }
  }
  return { ok: true };
}

/**
 * Identity and timing metadata of one candidate authorization message. Only
 * these fields are retained from the SDK lookup; message bodies never enter
 * validation, persistence, or logs.
 */
export interface RecoveryUserMessageSnapshot {
  role?: string;
  sessionID?: string;
  id?: string;
  timeCreatedMs?: number;
}

/** Read-only authorization message lookup bound to the plugin SDK client. */
export type LookupRecoveryUserMessage = (
  sessionId: string,
  messageId: string,
) => Promise<RecoveryUserMessageSnapshot | undefined>;

export type RecoveryAuthorizationResult =
  | { ok: true; timeCreatedMs: number }
  | {
      ok: false;
      errorCode:
        | "AUTHORIZATION_LOOKUP_FAILED"
        | "AUTHORIZATION_NOT_FOUND"
        | "AUTHORIZATION_NOT_USER_MESSAGE"
        | "AUTHORIZATION_SESSION_MISMATCH"
        | "AUTHORIZATION_ID_MISMATCH"
        | "AUTHORIZATION_STALE";
      message: string;
    };

/**
 * Validate one authorization reference against its root-session message
 * snapshot. Provenance only: role, session identity, message identity, and a
 * creation timestamp at or after the relevant stop. This check never
 * interprets natural-language intent.
 */
export async function validateRecoveryUserAuthorization(input: {
  owningSessionId: string;
  userMessageId: string;
  requireAfterMs?: number;
  lookup: LookupRecoveryUserMessage;
}): Promise<RecoveryAuthorizationResult> {
  let snapshot: RecoveryUserMessageSnapshot | undefined;
  try {
    snapshot = await input.lookup(input.owningSessionId, input.userMessageId);
  } catch (error) {
    return {
      ok: false,
      errorCode: "AUTHORIZATION_LOOKUP_FAILED",
      message: `AUTHORIZATION_LOOKUP_FAILED: authorization message lookup failed: ${(error as Error).message}`,
    };
  }
  if (!snapshot) {
    return {
      ok: false,
      errorCode: "AUTHORIZATION_NOT_FOUND",
      message: `AUTHORIZATION_NOT_FOUND: no message ${input.userMessageId} is observable in session ${input.owningSessionId}`,
    };
  }
  if (snapshot.id !== undefined && snapshot.id !== input.userMessageId) {
    return {
      ok: false,
      errorCode: "AUTHORIZATION_ID_MISMATCH",
      message: `AUTHORIZATION_ID_MISMATCH: looked-up message ${snapshot.id} is not the referenced ${input.userMessageId}`,
    };
  }
  if (snapshot.role !== "user") {
    return {
      ok: false,
      errorCode: "AUTHORIZATION_NOT_USER_MESSAGE",
      message: `AUTHORIZATION_NOT_USER_MESSAGE: message ${input.userMessageId} has role ${snapshot.role ?? "(unknown)"} instead of user`,
    };
  }
  if (snapshot.sessionID !== input.owningSessionId) {
    return {
      ok: false,
      errorCode: "AUTHORIZATION_SESSION_MISMATCH",
      message: `AUTHORIZATION_SESSION_MISMATCH: message ${input.userMessageId} belongs to session ${snapshot.sessionID ?? "(unknown)"}, not ${input.owningSessionId}`,
    };
  }
  if (typeof snapshot.timeCreatedMs !== "number" || !Number.isFinite(snapshot.timeCreatedMs)) {
    return {
      ok: false,
      errorCode: "AUTHORIZATION_NOT_FOUND",
      message:
        "AUTHORIZATION_NOT_FOUND: authorization message is missing verifiable timing metadata",
    };
  }
  if (input.requireAfterMs !== undefined && snapshot.timeCreatedMs < input.requireAfterMs) {
    return {
      ok: false,
      errorCode: "AUTHORIZATION_STALE",
      message: `AUTHORIZATION_STALE: message ${input.userMessageId} predates the stop it must authorize`,
    };
  }
  return { ok: true, timeCreatedMs: snapshot.timeCreatedMs };
}

/** Terminal timestamp (epoch ms) of one attempt, or undefined when unknown. */
function terminalAttemptTimeMs(attempt: DelegatedAttempt): number | undefined {
  if (!attempt.completedAt) return undefined;
  const parsed = Date.parse(attempt.completedAt);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export type DelegatedNextAction =
  | "launch_implementer"
  | "await_result"
  | "decide"
  | "recover"
  | "recover_with_user_authorization"
  | "launch_blocked"
  | "close"
  | "closed";

export interface DelegatedProgressSummary {
  attemptsConsumed: number;
  attemptBudget: number;
  remainingAttempts: number;
  hasInFlightAttempt: boolean;
  recoveryGrants: number;
  autonomousGrantConsumed: boolean;
  reportRejectedAttempts: number;
  nextAction: DelegatedNextAction;
}

/**
 * Budget, terminal-state, and next-action summary for work-item inspection.
 * The next action never suggests an ordinary launch the same state rejects.
 */
export function summarizeDelegatedProgress(record: WorkItemRecord): DelegatedProgressSummary {
  const delegated = record.delegated;
  if (!delegated) {
    return {
      attemptsConsumed: 0,
      attemptBudget: 0,
      remainingAttempts: 0,
      hasInFlightAttempt: false,
      recoveryGrants: 0,
      autonomousGrantConsumed: false,
      reportRejectedAttempts: 0,
      nextAction: record.state === "closed" ? "closed" : "launch_implementer",
    };
  }
  const attemptsConsumed = delegated.attempts.length;
  const attemptBudget = delegatedAttemptBudget(delegated);
  const remainingAttempts = Math.max(0, attemptBudget - attemptsConsumed);
  const hasInFlightAttempt = delegated.attempts.some((attempt) => attempt.status === "in_flight");
  const recoveryGrants = delegatedRecoveryGrantCount(delegated.recoveryHistory);
  const autonomousGrantConsumed = delegatedAutonomousGrantConsumed(delegated.recoveryHistory);
  const reportRejectedAttempts = delegated.attempts.filter(
    (attempt) => attempt.status === "report_rejected",
  ).length;

  let nextAction: DelegatedNextAction;
  if (record.state === "closed") {
    nextAction = "closed";
  } else if (record.state === "ready_to_close") {
    nextAction = "close";
  } else if (record.state === "awaiting_acceptance") {
    nextAction = "decide";
  } else if (record.state === "blocked" || record.state === "needs_context") {
    nextAction =
      remainingAttempts > 0 || !autonomousGrantConsumed
        ? "recover"
        : "recover_with_user_authorization";
  } else if (hasInFlightAttempt) {
    // A live attempt rejects an ordinary launch with ATTEMPT_IN_FLIGHT; the
    // supported action is collecting its result, not launching again.
    nextAction = "await_result";
  } else if (remainingAttempts > 0) {
    nextAction = "launch_implementer";
  } else {
    nextAction = autonomousGrantConsumed ? "recover_with_user_authorization" : "recover";
  }
  return {
    attemptsConsumed,
    attemptBudget,
    remainingAttempts,
    hasInFlightAttempt,
    recoveryGrants,
    autonomousGrantConsumed,
    reportRejectedAttempts,
    nextAction,
  };
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
        | "ATTEMPTS_EXHAUSTED"
        | "CALL_ID_REUSED";
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

type DelegatedCallIdBinding =
  | { kind: "none" }
  | { kind: "unique"; record: WorkItemRecord; attempt: DelegatedAttempt; lookupKey: string }
  | { kind: "ambiguous" };

/**
 * Resolve the single delegated attempt that owns one host callID within a
 * parent session. Ambiguous pre-existing histories fail closed instead of
 * selecting one so an old event can never affect a newer attempt.
 */
function findDelegatedCallIdBinding(
  store: WorkItemStoreData,
  sessionId: string,
  callId: string,
): DelegatedCallIdBinding {
  const matches: Array<{ record: WorkItemRecord; attempt: DelegatedAttempt; lookupKey: string }> =
    [];
  for (const [lookupKey, record] of store.records) {
    if (record.sessionId !== sessionId || record.mode !== "delegated" || !record.delegated)
      continue;
    for (const attempt of record.delegated.attempts) {
      if (attempt.callId === callId) {
        matches.push({ record, attempt, lookupKey });
      }
    }
  }
  if (matches.length === 0) return { kind: "none" };
  if (matches.length > 1) return { kind: "ambiguous" };
  return { kind: "unique", ...matches[0]! };
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
  // Shared item-level gate: the same coded rejection the read-only inspection
  // guidance reports, so a suggested launch can never be accepted here.
  const gate = delegatedOrdinaryLaunchGate(existing);
  if (!gate.ok) {
    return {
      ok: false,
      errorCode: gate.reason as Exclude<DelegatedLaunchGateReason, "WORK_ITEM_NOT_FOUND">,
      message: gate.message ?? `INVALID_STATE: ${input.workItemId} cannot start an attempt`,
    };
  }
  const delegated = existing.delegated!;

  // A host callID is a single-shot identity within a parent session. Reusing it
  // for a new attempt — in this item or any other — would let a delayed event
  // from the old call affect the new attempt, so fail closed instead.
  const callIdBinding = findDelegatedCallIdBinding(store, input.sessionId, callId);
  if (callIdBinding.kind !== "none") {
    return {
      ok: false,
      errorCode: "CALL_ID_REUSED",
      message: `CALL_ID_REUSED: callID ${callId} is already bound to a delegated attempt in session ${input.sessionId}`,
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

export type ApplyDelegatedLaunchFailureResult =
  | {
      ok: true;
      record: WorkItemRecord;
      fromState: WorkItemState;
      toState: WorkItemState;
      attempt: number;
      consumedAttempts: number;
      attemptBudget: number;
      retryAllowed: boolean;
    }
  | {
      ok: false;
      errorCode:
        | "WORK_ITEM_NOT_FOUND"
        | "WORK_ITEM_ALREADY_CLOSED"
        | "WRONG_MODE"
        | "INVALID_STATE"
        | "AMBIGUOUS_CALL_ID"
        | "STALE_CALLBACK";
      message: string;
    };

export interface ApplyDelegatedLaunchFailureInput {
  sessionId: string;
  workItemId: string;
  callId: string;
  failureExcerpt: WorkflowResultExcerpt;
}

// START_CONTRACT: applyDelegatedLaunchFailure
//   PURPOSE: Record a confirmed host-terminal launch failure on its matching in-flight attempt without advancing the item lifecycle.
//   INPUTS: { store: WorkItemStore - backing store, input: ApplyDelegatedLaunchFailureInput - call-bound host wrapper error evidence }
//   OUTPUTS: { ApplyDelegatedLaunchFailureResult - failed attempt with remaining budget or a coded rejection }
//   SIDE_EFFECTS: [Marks the matching in-flight attempt failed and consumes one attempt from the existing budget]
//   LINKS: [M-WORKFLOW-DELEGATED, M-WORKFLOW-STATE]
// END_CONTRACT: applyDelegatedLaunchFailure
export function applyDelegatedLaunchFailure(
  store: WorkItemStore,
  input: ApplyDelegatedLaunchFailureInput,
): ApplyDelegatedLaunchFailureResult {
  return applyDelegatedLaunchFailureInStore(store.getStoreData(), input);
}

export function applyDelegatedLaunchFailureInStore(
  store: WorkItemStoreData,
  input: ApplyDelegatedLaunchFailureInput,
): ApplyDelegatedLaunchFailureResult {
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
  // A host-terminal launch failure is only meaningful while the item is still
  // waiting for its implementer. Any other lifecycle state means a different
  // transition got there first, so fail closed.
  if (existing.state !== "awaiting_implementer") {
    return {
      ok: false,
      errorCode: "INVALID_STATE",
      message: `INVALID_STATE: ${input.workItemId} is ${existing.state}, not awaiting_implementer`,
    };
  }

  const callIdBinding = findDelegatedCallIdBinding(store, input.sessionId, input.callId);
  if (callIdBinding.kind === "ambiguous") {
    return {
      ok: false,
      errorCode: "AMBIGUOUS_CALL_ID",
      message: `AMBIGUOUS_CALL_ID: callID ${input.callId} is bound to more than one delegated attempt in session ${input.sessionId}`,
    };
  }
  if (
    callIdBinding.kind === "unique" &&
    (callIdBinding.record.workItemId !== input.workItemId ||
      callIdBinding.record.sessionId !== input.sessionId)
  ) {
    return {
      ok: false,
      errorCode: "STALE_CALLBACK",
      message: `STALE_CALLBACK: ${input.callId} is bound to ${callIdBinding.record.workItemId}, not ${input.workItemId}`,
    };
  }

  const inFlight = existing.delegated.attempts.find(
    (attempt) => attempt.status === "in_flight" && attempt.callId === input.callId,
  );
  if (!inFlight) {
    return {
      ok: false,
      errorCode: "STALE_CALLBACK",
      message: `STALE_CALLBACK: ${input.callId} does not match an in-flight attempt for ${input.workItemId}`,
    };
  }

  const now = toIsoNow();
  const updated: WorkItemRecord = {
    ...existing,
    // Failed attempts never advance the lifecycle: the item stays waiting at
    // the launch gate so an explicit controller retry can consume the
    // remaining budget, and two failures naturally exhaust it.
    state: "awaiting_implementer",
    delegated: {
      ...existing.delegated,
      attempts: existing.delegated.attempts.map((attempt) =>
        attempt.attempt === inFlight.attempt
          ? {
              ...attempt,
              status: "failed" as const,
              failureExcerpt: input.failureExcerpt,
              completedAt: now,
            }
          : attempt,
      ),
    },
    updatedAt: now,
  };
  store.records.set(createRecordLookupKey(input.sessionId, input.workItemId), updated);

  const attemptBudget = delegatedAttemptBudget(updated.delegated as DelegatedWorkItemState);
  return {
    ok: true,
    record: cloneRecord(updated),
    fromState: existing.state,
    toState: "awaiting_implementer",
    attempt: inFlight.attempt,
    consumedAttempts: updated.delegated?.attempts.length ?? 0,
    attemptBudget,
    retryAllowed: (updated.delegated?.attempts.length ?? 0) < attemptBudget,
  };
}

export type ApplyDelegatedReportRejectionResult =
  | {
      ok: true;
      record: WorkItemRecord;
      attempt: number;
      observedHardStop?: "BLOCKED" | "NEEDS_CONTEXT";
      consumedAttempts: number;
      attemptBudget: number;
    }
  | {
      ok: false;
      errorCode:
        | "WORK_ITEM_NOT_FOUND"
        | "WORK_ITEM_ALREADY_CLOSED"
        | "WRONG_MODE"
        | "INVALID_INPUT"
        | "STALE_CALLBACK";
      message: string;
    };

export interface ApplyDelegatedReportRejectionInput {
  sessionId: string;
  workItemId: string;
  callId: string;
  protocolErrorCode: string;
  excerpt: WorkflowResultExcerpt;
  explicitHardStop?: "BLOCKED" | "NEEDS_CONTEXT";
}

// START_CONTRACT: applyDelegatedReportRejection
//   PURPOSE: Settle one confirmed terminal protocol-invalid report on its exact call-bound attempt as a completed execution with a rejected report.
//   INPUTS: { store: WorkItemStore - backing store, input: ApplyDelegatedReportRejectionInput - call-bound report rejection with bounded diagnostics }
//   OUTPUTS: { ApplyDelegatedReportRejectionResult - settled attempt and preserved hard-stop state, or a coded rejection without mutation }
//   SIDE_EFFECTS: [Marks the matching in-flight attempt report_rejected and consumes one attempt without fabricating DONE]
//   LINKS: [M-WORKFLOW-DELEGATED, M-WORKFLOW-STATE, M-WORKFLOW-REPAIR]
// END_CONTRACT: applyDelegatedReportRejection
export function applyDelegatedReportRejection(
  store: WorkItemStore,
  input: ApplyDelegatedReportRejectionInput,
): ApplyDelegatedReportRejectionResult {
  return applyDelegatedReportRejectionInStore(store.getStoreData(), input);
}

export function applyDelegatedReportRejectionInStore(
  store: WorkItemStoreData,
  input: ApplyDelegatedReportRejectionInput,
): ApplyDelegatedReportRejectionResult {
  const protocolErrorCode =
    typeof input.protocolErrorCode === "string" ? input.protocolErrorCode.trim() : "";
  if (!protocolErrorCode || protocolErrorCode.length > DELEGATED_RECOVERY_CODE_MAX_CHARS) {
    return {
      ok: false,
      errorCode: "INVALID_INPUT",
      message: `INVALID_INPUT: protocolErrorCode must be 1 to ${DELEGATED_RECOVERY_CODE_MAX_CHARS} characters`,
    };
  }
  if (
    input.explicitHardStop !== undefined &&
    input.explicitHardStop !== "BLOCKED" &&
    input.explicitHardStop !== "NEEDS_CONTEXT"
  ) {
    return {
      ok: false,
      errorCode: "INVALID_INPUT",
      message: "INVALID_INPUT: explicitHardStop must be BLOCKED, NEEDS_CONTEXT, or omitted",
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
      message: `WRONG_MODE: ${input.workItemId} is ${existing.mode}, not delegated`,
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
  const nextState: WorkItemState =
    input.explicitHardStop === "BLOCKED"
      ? "blocked"
      : input.explicitHardStop === "NEEDS_CONTEXT"
        ? "needs_context"
        : "awaiting_implementer";
  const updated: WorkItemRecord = {
    ...existing,
    // A confirmed terminal execution settles its attempt; a rejected report
    // never synthesizes DONE, so the item returns to the launch gate (or the
    // observed substantive hard-stop state) with the attempt consumed.
    state: nextState,
    ...(input.explicitHardStop ? { resultExcerpt: input.excerpt } : {}),
    delegated: {
      ...existing.delegated,
      attempts: existing.delegated.attempts.map((attempt) =>
        attempt.attempt === inFlight.attempt
          ? {
              ...attempt,
              status: "report_rejected" as const,
              reportRejection: {
                protocolErrorCode,
                excerpt: input.excerpt,
                rejectedAt: now,
              },
              completedAt: now,
            }
          : attempt,
      ),
    },
    updatedAt: now,
  };
  store.records.set(createRecordLookupKey(input.sessionId, input.workItemId), updated);

  const delegated = updated.delegated as DelegatedWorkItemState;
  const attemptBudget = delegatedAttemptBudget(delegated);
  return {
    ok: true,
    record: cloneRecord(updated),
    attempt: inFlight.attempt,
    ...(input.explicitHardStop ? { observedHardStop: input.explicitHardStop } : {}),
    consumedAttempts: delegated.attempts.length,
    attemptBudget,
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

export type RecoverDelegatedWorkItemResult =
  | {
      ok: true;
      record: WorkItemRecord;
      recoveryId: string;
      kind: DelegatedRecoveryKind;
      attemptBudget: number;
      remainingAttempts: number;
    }
  | {
      ok: false;
      errorCode:
        | "WORK_ITEM_NOT_FOUND"
        | "WORK_ITEM_ALREADY_CLOSED"
        | "WRONG_MODE"
        | "INVALID_INPUT"
        | "INVALID_TARGET_STATE"
        | "ATTEMPT_NOT_TERMINAL"
        | "ATTEMPT_MISMATCH"
        | "DUPLICATE_RECOVERY_ID"
        | "AUTONOMOUS_GRANT_EXHAUSTED"
        | "AUTHORIZATION_LOOKUP_FAILED"
        | "AUTHORIZATION_NOT_FOUND"
        | "AUTHORIZATION_NOT_USER_MESSAGE"
        | "AUTHORIZATION_SESSION_MISMATCH"
        | "AUTHORIZATION_ID_MISMATCH"
        | "AUTHORIZATION_STALE"
        | "AUTHORIZATION_REUSED";
      message: string;
    };

export interface RecoverDelegatedWorkItemInput {
  sessionId: string;
  workItemId: string;
  /** Must identify the latest terminal attempt of the target. */
  attempt: number;
  diagnosis: string;
  changedCondition: string;
  verification: string[];
  recoveryId: string;
  /** Fresh root-user message authorizing one further grant for this target. */
  userMessageId?: string;
  /** Read-only authorization lookup supplied by the tool layer. */
  lookupUserMessage?: LookupRecoveryUserMessage;
  /**
   * Set by the transaction layer after it has validated and reserved one
   * advance-authority unit for this exact recovery. It only authorizes the
   * one-unit grant; it is never acceptance and never satisfies a reviewer.
   */
  advanceGrantApproved?: boolean;
}

type DelegatedRecoveryErrorCode =
  | "WORK_ITEM_NOT_FOUND"
  | "WORK_ITEM_ALREADY_CLOSED"
  | "WRONG_MODE"
  | "INVALID_INPUT"
  | "INVALID_TARGET_STATE"
  | "ATTEMPT_NOT_TERMINAL"
  | "ATTEMPT_MISMATCH"
  | "DUPLICATE_RECOVERY_ID"
  | "AUTONOMOUS_GRANT_EXHAUSTED"
  | "AUTHORIZATION_LOOKUP_FAILED"
  | "AUTHORIZATION_NOT_FOUND"
  | "AUTHORIZATION_NOT_USER_MESSAGE"
  | "AUTHORIZATION_SESSION_MISMATCH"
  | "AUTHORIZATION_ID_MISMATCH"
  | "AUTHORIZATION_STALE"
  | "AUTHORIZATION_REUSED";

type DelegatedRecoveryPrecheck =
  | {
      ok: true;
      record: WorkItemRecord;
      target: DelegatedAttempt;
      needsGrant: boolean;
      autonomousAvailable: boolean;
    }
  | { ok: false; errorCode: DelegatedRecoveryErrorCode; message: string };

/**
 * Synchronous eligibility check for delegated recovery. Re-run after any
 * asynchronous authorization validation so a changed target state can never
 * be committed on stale evidence.
 */
function precheckDelegatedRecovery(
  store: WorkItemStoreData,
  input: RecoverDelegatedWorkItemInput,
): DelegatedRecoveryPrecheck {
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
  if (currentDelegatedAcceptance(existing)) {
    return {
      ok: false,
      errorCode: "INVALID_TARGET_STATE",
      message: `INVALID_TARGET_STATE: ${input.workItemId} is currently accepted; checkpoint-authorized rework is the path for accepted items, not recovery`,
    };
  }
  if (existing.delegated.attempts.some((attempt) => attempt.status === "in_flight")) {
    return {
      ok: false,
      errorCode: "INVALID_TARGET_STATE",
      message: `INVALID_TARGET_STATE: ${input.workItemId} has a live in-flight attempt; recovery never interrupts live work`,
    };
  }
  const isStop = existing.state === "blocked" || existing.state === "needs_context";
  const isExhausted =
    existing.state === "awaiting_implementer" &&
    existing.delegated.attempts.length >= delegatedAttemptBudget(existing.delegated);
  if (!isStop && !isExhausted) {
    return {
      ok: false,
      errorCode: "INVALID_TARGET_STATE",
      message: `INVALID_TARGET_STATE: ${input.workItemId} is ${existing.state} and is neither stopped nor out of implementation budget`,
    };
  }

  const target = existing.delegated.attempts[existing.delegated.attempts.length - 1];
  if (!target) {
    return {
      ok: false,
      errorCode: "INVALID_TARGET_STATE",
      message: `INVALID_TARGET_STATE: ${input.workItemId} has no terminal attempt to recover`,
    };
  }
  if (target.status === "in_flight") {
    return {
      ok: false,
      errorCode: "ATTEMPT_NOT_TERMINAL",
      message: `ATTEMPT_NOT_TERMINAL: attempt ${target.attempt} of ${input.workItemId} is still in flight`,
    };
  }
  if (target.attempt !== input.attempt) {
    return {
      ok: false,
      errorCode: "ATTEMPT_MISMATCH",
      message: `ATTEMPT_MISMATCH: recovery targets attempt ${input.attempt} but the latest terminal attempt is ${target.attempt}`,
    };
  }
  if (existing.delegated.recoveryHistory.some((entry) => entry.recoveryId === input.recoveryId)) {
    return {
      ok: false,
      errorCode: "DUPLICATE_RECOVERY_ID",
      message: `DUPLICATE_RECOVERY_ID: recoveryId ${input.recoveryId} is already recorded for ${input.workItemId}`,
    };
  }

  const remaining = delegatedAttemptBudget(existing.delegated) - existing.delegated.attempts.length;
  return {
    ok: true,
    record: existing,
    target,
    needsGrant: remaining <= 0,
    autonomousAvailable: !delegatedAutonomousGrantConsumed(existing.delegated.recoveryHistory),
  };
}

// START_CONTRACT: recoverDelegatedWorkItem
//   PURPOSE: Resume a stopped unaccepted item or grant exactly one additional attempt after exhaustion, preserving every prior outcome and decision.
//   INPUTS: { store: WorkItemStore - backing store, input: RecoverDelegatedWorkItemInput - bounded recovery payload with optional root-user authorization }
//   OUTPUTS: { RecoverDelegatedWorkItemResult - recorded recovery with updated budget or a coded rejection without mutation }
//   SIDE_EFFECTS: [Appends a recovery record, moves a stopped item back to awaiting_implementer, and may extend the attempt budget by exactly one]
//   LINKS: [M-WORKFLOW-DELEGATED, M-WORKFLOW-CHECKPOINTS, validateRecoveryUserAuthorization]
// END_CONTRACT: recoverDelegatedWorkItem
export async function recoverDelegatedWorkItem(
  store: WorkItemStore,
  input: RecoverDelegatedWorkItemInput,
): Promise<RecoverDelegatedWorkItemResult> {
  return recoverDelegatedWorkItemInStore(store.getStoreData(), input);
}

export async function recoverDelegatedWorkItemInStore(
  store: WorkItemStoreData,
  input: RecoverDelegatedWorkItemInput,
): Promise<RecoverDelegatedWorkItemResult> {
  const validation = validateDelegatedRecoveryInput({
    diagnosis: input.diagnosis,
    changedCondition: input.changedCondition,
    verification: input.verification,
    recoveryId: input.recoveryId,
  });
  if (!validation.ok) {
    return {
      ok: false,
      errorCode: "INVALID_INPUT",
      message: `INVALID_INPUT: ${validation.message}`,
    };
  }

  const precheck = precheckDelegatedRecovery(store, input);
  if (!precheck.ok) {
    return { ok: false, errorCode: precheck.errorCode, message: precheck.message };
  }

  const commitRecovery = (kind: DelegatedRecoveryKind): RecoverDelegatedWorkItemResult => {
    // Re-run the synchronous eligibility check immediately before committing
    // so an authorization await can never commit against a changed target.
    const fresh = precheckDelegatedRecovery(store, input);
    if (!fresh.ok) {
      return { ok: false, errorCode: fresh.errorCode, message: fresh.message };
    }
    const now = toIsoNow();
    const recovery: DelegatedRecoveryRecord = {
      recoveryId: input.recoveryId,
      targetAttempt: input.attempt,
      kind,
      diagnosis: input.diagnosis.trim(),
      changedCondition: input.changedCondition.trim(),
      verification: input.verification.map((reference) => reference.trim()),
      recoveredAt: now,
      ...(kind === "user_grant" && input.userMessageId
        ? { userMessageId: input.userMessageId }
        : {}),
    };
    const updated: WorkItemRecord = {
      ...fresh.record,
      // Recovery returns a stopped item to the launch gate; an exhausted item
      // is already there. Either way recovery never accepts or closes work.
      state: "awaiting_implementer",
      delegated: {
        ...fresh.record.delegated!,
        recoveryHistory: [...fresh.record.delegated!.recoveryHistory, recovery],
      },
      updatedAt: now,
    };
    store.records.set(createRecordLookupKey(input.sessionId, input.workItemId), updated);
    const delegated = updated.delegated as DelegatedWorkItemState;
    const attemptBudget = delegatedAttemptBudget(delegated);
    return {
      ok: true,
      record: cloneRecord(updated),
      recoveryId: input.recoveryId,
      kind,
      attemptBudget,
      remainingAttempts: Math.max(0, attemptBudget - delegated.attempts.length),
    };
  };

  if (!precheck.needsGrant) {
    return commitRecovery("resume");
  }

  if (input.userMessageId !== undefined) {
    const userMessageId = input.userMessageId.trim();
    if (!userMessageId) {
      return {
        ok: false,
        errorCode: "INVALID_INPUT",
        message: "INVALID_INPUT: userMessageId must be a non-empty string when provided",
      };
    }
    if (
      precheck.record.delegated?.recoveryHistory.some(
        (entry) => entry.userMessageId === userMessageId,
      )
    ) {
      return {
        ok: false,
        errorCode: "AUTHORIZATION_REUSED",
        message: `AUTHORIZATION_REUSED: message ${userMessageId} already authorized recovery of ${input.workItemId}; each message grants at most one unit per target`,
      };
    }
    if (typeof input.lookupUserMessage !== "function") {
      return {
        ok: false,
        errorCode: "AUTHORIZATION_LOOKUP_FAILED",
        message:
          "AUTHORIZATION_LOOKUP_FAILED: user-authorized recovery requires a read-only message lookup bound to the plugin context",
      };
    }
    const authorization = await validateRecoveryUserAuthorization({
      owningSessionId: input.sessionId,
      userMessageId,
      requireAfterMs: terminalAttemptTimeMs(precheck.target),
      lookup: input.lookupUserMessage,
    });
    if (!authorization.ok) {
      return { ok: false, errorCode: authorization.errorCode, message: authorization.message };
    }
    // The await above is an async boundary: re-verify non-reuse before commit
    // (the precheck inside commitRecovery covers the rest of the state).
    const fresh = findRecord(store, input.sessionId, input.workItemId);
    if (fresh?.delegated?.recoveryHistory.some((entry) => entry.userMessageId === userMessageId)) {
      return {
        ok: false,
        errorCode: "AUTHORIZATION_REUSED",
        message: `AUTHORIZATION_REUSED: message ${userMessageId} already authorized recovery of ${input.workItemId}`,
      };
    }
    return commitRecovery("user_grant");
  }

  if (precheck.autonomousAvailable) {
    return commitRecovery("autonomous_grant");
  }

  if (input.advanceGrantApproved === true) {
    // The transaction layer already validated the execution authority and
    // reserved exactly one unit for this recoveryId; record the grant kind.
    return commitRecovery("advance_grant");
  }

  return {
    ok: false,
    errorCode: "AUTONOMOUS_GRANT_EXHAUSTED",
    message: `AUTONOMOUS_GRANT_EXHAUSTED: the single autonomous recovery grant for ${input.workItemId} is consumed; one further unit requires a recorded advance authority or a fresh root-user message referenced by userMessageId`,
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
