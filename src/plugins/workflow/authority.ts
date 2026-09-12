// FILE: src/plugins/workflow/authority.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Bounded advance-execution authority and truthful stage-approval provenance: root-user message eligibility, one finite shared recovery reserve, explicit extension, fail-safe narrowing/revocation, replay/duplicate protection, one-unit reserve consumption, and controller-delegated versus user-observed stage records.
//   SCOPE: Pure validation outcomes and proposed ledger transitions over authority records, session-wide message claims, and reserve debits. No native XML parsing, SDK transport, task dispatch, filesystem writes, or persistence. Runtime integration belongs to the plugin transaction layer.
//   DEPENDS: [src/lib/workflow-contract.ts]
//   LINKS: [M-WORKFLOW-AUTHORITY, M-WORKFLOW-CONTRACT, M-WORKFLOW-EXECUTION, V-M-WORKFLOW-AUTHORITY]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ADVANCE_RECOVERY_RESERVE - Initial and per-extension advance recovery units shared by one authorized execution.
//   AuthorityMessageSnapshot - Observable identity, timing, and eligibility metadata of one candidate root-user message.
//   AuthorityValidationErrorCode - Coded reasons an authority operation is rejected.
//   AuthorityOperationResult - Success value or a coded rejection.
//   validateAuthorityMessage - Pure eligibility check for one candidate root-user instruction.
//   grantAdvanceAuthority - Initial grant recording the finite reserve and its message claim.
//   extendAdvanceAuthority - Explicit finite extension from a new eligible instruction.
//   advanceUnitsGranted - Total granted units across the initial reserve and extensions.
//   advanceUnitsConsumed - Debits consumed against one authority.
//   advanceUnitsAvailable - Remaining usable units after debits and full revocation.
//   effectiveAuthorityStages - Surviving delegatable stages after narrowing revocations.
//   proposeReserveDebit - Propose one immutable one-unit reserve consumption for an exact target.
//   narrowAdvanceAuthority - Fail-safe scope reduction that cannot restore consumed units.
//   revokeAdvanceAuthority - Revoke future and unlaunched credits without erasing history.
//   proposeStageApproval - Record a truthful controller_delegated stage approval when authority covers the stage.
//   isStageReserved - Whether a stage remains reserved for explicit user action.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-WORKFLOW-PLAN-INDEPENDENCE - Initial bounded advance-authority domain with a shared three-unit reserve, replay protection, and truthful stage provenance.]
// END_CHANGE_SUMMARY

import {
  isBoundedWorkflowId,
  WORKFLOW_TEXT_MAX_CHARS,
  type WorkflowAuthorityExtension,
  type WorkflowAuthorityProvenance,
  type WorkflowAuthorityRecord,
  type WorkflowAuthorityRevocation,
  type WorkflowAuthorityScope,
  type WorkflowAuthorityStage,
  type WorkflowMessageClaim,
  type WorkflowReserveDebit,
  type WorkflowStageApproval,
} from "../../lib/workflow-contract.js";

// START_BLOCK_AUTHORITY_CONSTANTS
/** Initial and per-extension advance recovery units shared by one authorized execution. */
export const ADVANCE_RECOVERY_RESERVE = 3;

const AUTHORITY_STAGES: ReadonlySet<string> = new Set([
  "specification",
  "planning",
  "implementation",
  "verification",
]);
// END_BLOCK_AUTHORITY_CONSTANTS

export type AuthorityValidationErrorCode =
  | "MISSING_IDENTITY"
  | "FOREIGN_SESSION"
  | "ASSISTANT_MESSAGE"
  | "SYNTHETIC_ONLY"
  | "IGNORED_MESSAGE"
  | "EMPTY_MESSAGE"
  | "MESSAGE_REPLAY"
  | "DUPLICATE_GRANT"
  | "AUTHORITY_NOT_FOUND"
  | "AUTHORITY_REVOKED"
  | "STALE_EXTENSION"
  | "RESERVE_EXHAUSTED"
  | "DUPLICATE_DEBIT"
  | "STAGE_NOT_DELEGATED"
  | "STAGE_RESERVED"
  | "INVALID_INPUT";

export type AuthorityOperationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: AuthorityValidationErrorCode; message: string };

/** Observable identity, timing, and eligibility metadata of one candidate root-user message. */
export interface AuthorityMessageSnapshot {
  messageId: string;
  sessionId: string;
  /** Message author role as reported by the pinned SDK response. */
  role: "user" | "assistant";
  createdMs: number;
  ignored: boolean;
  /** True when the message contains only synthetic/placeholder user text. */
  syntheticOnly: boolean;
  textParts: string[];
}

/** Pure eligibility check for one candidate root-user instruction. */
export function validateAuthorityMessage(
  message: AuthorityMessageSnapshot,
  sessionId: string,
): AuthorityOperationResult<true> {
  if (message === null || typeof message !== "object" || !isBoundedWorkflowId(message.messageId)) {
    return {
      ok: false,
      code: "MISSING_IDENTITY",
      message: "authorization message identity is missing",
    };
  }
  if (message.sessionId !== sessionId) {
    return {
      ok: false,
      code: "FOREIGN_SESSION",
      message: "authorization message belongs to another session",
    };
  }
  if (message.role !== "user") {
    return {
      ok: false,
      code: "ASSISTANT_MESSAGE",
      message: "only a root-user instruction can grant authority",
    };
  }
  if (message.ignored) {
    return {
      ok: false,
      code: "IGNORED_MESSAGE",
      message: "ignored messages cannot grant authority",
    };
  }
  if (message.syntheticOnly) {
    return {
      ok: false,
      code: "SYNTHETIC_ONLY",
      message: "synthetic-only messages cannot grant authority",
    };
  }
  if (!Number.isFinite(message.createdMs) || message.createdMs <= 0) {
    return {
      ok: false,
      code: "MISSING_IDENTITY",
      message: "authorization message has no finite creation time",
    };
  }
  const hasText = Array.isArray(message.textParts)
    ? message.textParts.some((part) => typeof part === "string" && part.trim() !== "")
    : false;
  if (!hasText) {
    return {
      ok: false,
      code: "EMPTY_MESSAGE",
      message: "authorization message has no usable user text",
    };
  }
  return { ok: true, value: true };
}

function validScope(scope: WorkflowAuthorityScope, problems: string[]): void {
  if (!Array.isArray(scope.stages) || scope.stages.some((stage) => !AUTHORITY_STAGES.has(stage))) {
    problems.push(
      "scope.stages must be a subset of specification/planning/implementation/verification",
    );
  }
  if (
    typeof scope.decisionScope !== "string" ||
    scope.decisionScope.trim().length > WORKFLOW_TEXT_MAX_CHARS
  ) {
    problems.push("scope.decisionScope must be a bounded text description");
  }
  if (!Array.isArray(scope.fileBoundary)) {
    problems.push("scope.fileBoundary must be an array");
  }
  if (
    !Array.isArray(scope.reservedStops) ||
    scope.reservedStops.some((stage) => !AUTHORITY_STAGES.has(stage))
  ) {
    problems.push("scope.reservedStops must be a subset of the delegatable stages");
  }
}

function claimMessage(
  message: AuthorityMessageSnapshot,
  runId: string,
  authorityId: string,
  claims: Map<string, WorkflowMessageClaim>,
  nowMs: number,
): AuthorityOperationResult<WorkflowMessageClaim> {
  const existing = claims.get(message.messageId);
  if (existing) {
    // Idempotent reuse for the same execution authority, replay rejection else.
    if (existing.runId === runId && existing.authorityId === authorityId) {
      return { ok: true, value: existing };
    }
    return {
      ok: false,
      code: "MESSAGE_REPLAY",
      message: `message ${message.messageId} already funded authority for another operation`,
    };
  }
  const claim: WorkflowMessageClaim = {
    messageId: message.messageId,
    runId,
    authorityId,
    claimedAt: new Date(nowMs).toISOString(),
  };
  claims.set(message.messageId, claim);
  return { ok: true, value: claim };
}

/**
 * Initial grant recording the finite shared reserve. Creating the same
 * authority again is idempotent only for an identical claim; a different
 * authority for the same execution, or a replayed message under another
 * execution, is rejected without manufacturing a new reserve.
 */
export function grantAdvanceAuthority(input: {
  authorityId: string;
  runId: string;
  sessionId: string;
  message: AuthorityMessageSnapshot;
  scope: WorkflowAuthorityScope;
  existingAuthorities: readonly WorkflowAuthorityRecord[];
  messageClaims: Map<string, WorkflowMessageClaim>;
  nowMs?: number;
}): AuthorityOperationResult<{ record: WorkflowAuthorityRecord; claim: WorkflowMessageClaim }> {
  if (!isBoundedWorkflowId(input.authorityId) || !isBoundedWorkflowId(input.runId)) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "authorityId and runId must be bounded identities",
    };
  }
  const eligibility = validateAuthorityMessage(input.message, input.sessionId);
  if (!eligibility.ok) return eligibility;
  const problems: string[] = [];
  validScope(input.scope, problems);
  if (problems.length > 0) {
    return { ok: false, code: "INVALID_INPUT", message: problems.join("; ") };
  }

  const existingForId = input.existingAuthorities.filter(
    (authority) => authority.authorityId === input.authorityId,
  );
  if (existingForId.length > 0) {
    const existing = existingForId[0];
    if (
      existing.grantedByMessageId === input.message.messageId &&
      existing.rootSessionId === input.sessionId &&
      existing.runId === input.runId
    ) {
      const claim = input.messageClaims.get(input.message.messageId);
      if (claim) return { ok: true, value: { record: existing, claim } };
    }
    return {
      ok: false,
      code: "DUPLICATE_GRANT",
      message: `authority ${input.authorityId} is already registered`,
    };
  }
  // A second initial grant for the same execution — even under a new
  // authorityId or a different message — must not mint another reserve.
  if (input.existingAuthorities.some((authority) => authority.runId === input.runId)) {
    return {
      ok: false,
      code: "DUPLICATE_GRANT",
      message: `execution ${input.runId} already has a recorded advance authority`,
    };
  }

  const nowMs = input.nowMs ?? input.message.createdMs;
  const claimResult = claimMessage(
    input.message,
    input.runId,
    input.authorityId,
    input.messageClaims,
    nowMs,
  );
  if (!claimResult.ok) return claimResult;

  const record: WorkflowAuthorityRecord = {
    authorityId: input.authorityId,
    runId: input.runId,
    rootSessionId: input.sessionId,
    grantedByMessageId: input.message.messageId,
    messageCreatedMs: input.message.createdMs,
    scope: normalizeScope(input.scope),
    initialUnits: ADVANCE_RECOVERY_RESERVE,
    extensions: [],
    revocations: [],
    createdAt: new Date(nowMs).toISOString(),
  };
  return { ok: true, value: { record, claim: claimResult.value } };
}

function normalizeScope(scope: WorkflowAuthorityScope): WorkflowAuthorityScope {
  return {
    stages: [...scope.stages],
    decisionScope: scope.decisionScope.trim(),
    fileBoundary: [...scope.fileBoundary],
    reservedStops: [...scope.reservedStops],
  };
}

/** Total granted units across the initial reserve and extensions. */
export function advanceUnitsGranted(authority: WorkflowAuthorityRecord): number {
  return (
    authority.initialUnits +
    authority.extensions.reduce((sum, extension) => sum + extension.units, 0)
  );
}

/** Debits consumed against one authority. */
export function advanceUnitsConsumed(
  authority: WorkflowAuthorityRecord,
  debits: readonly WorkflowReserveDebit[],
): number {
  return debits
    .filter((debit) => debit.authorityId === authority.authorityId)
    .reduce((sum, debit) => sum + debit.units, 0);
}

/** Remaining usable units after debits; a full revocation disables all future use. */
export function advanceUnitsAvailable(
  authority: WorkflowAuthorityRecord,
  debits: readonly WorkflowReserveDebit[],
): number {
  if (authority.revocations.some((revocation) => revocation.kind === "revoke")) return 0;
  return Math.max(0, advanceUnitsGranted(authority) - advanceUnitsConsumed(authority, debits));
}

/** Surviving delegatable stages after applying every narrowing revocation. */
export function effectiveAuthorityStages(
  authority: WorkflowAuthorityRecord,
): WorkflowAuthorityStage[] {
  let stages = [...authority.scope.stages];
  for (const revocation of authority.revocations) {
    if (revocation.kind === "narrow" && revocation.narrowedStages) {
      const surviving = revocation.narrowedStages;
      stages = stages.filter((stage) => surviving.includes(stage));
    }
  }
  return stages;
}

/** Explicit finite extension bound to a new eligible instruction after the extended authority event. */
export function extendAdvanceAuthority(input: {
  authority: WorkflowAuthorityRecord;
  extensionId: string;
  sessionId: string;
  message: AuthorityMessageSnapshot;
  messageClaims: Map<string, WorkflowMessageClaim>;
  nowMs?: number;
}): AuthorityOperationResult<WorkflowAuthorityExtension> {
  const { authority } = input;
  if (!isBoundedWorkflowId(input.extensionId)) {
    return { ok: false, code: "INVALID_INPUT", message: "extensionId must be a bounded identity" };
  }
  const eligibility = validateAuthorityMessage(input.message, input.sessionId);
  if (!eligibility.ok) return eligibility;
  const latestEventMs = Math.max(
    authority.messageCreatedMs,
    ...authority.extensions.map((extension) => extension.messageCreatedMs),
  );
  if (input.message.createdMs <= latestEventMs) {
    return {
      ok: false,
      code: "STALE_EXTENSION",
      message:
        "extension requires a new eligible instruction newer than the authority event it extends",
    };
  }
  if (authority.revocations.some((revocation) => revocation.kind === "revoke")) {
    return {
      ok: false,
      code: "AUTHORITY_REVOKED",
      message: `authority ${authority.authorityId} is revoked`,
    };
  }
  const nowMs = input.nowMs ?? input.message.createdMs;
  const claim = claimMessage(
    input.message,
    authority.authorityId,
    authority.authorityId,
    input.messageClaims,
    nowMs,
  );
  if (!claim.ok) return claim;
  return {
    ok: true,
    value: {
      extensionId: input.extensionId,
      messageId: input.message.messageId,
      messageCreatedMs: input.message.createdMs,
      units: ADVANCE_RECOVERY_RESERVE,
      createdAt: new Date(nowMs).toISOString(),
    },
  };
}

/** Propose one immutable one-unit reserve consumption for an exact target. */
export function proposeReserveDebit(input: {
  authority: WorkflowAuthorityRecord;
  debits: readonly WorkflowReserveDebit[];
  recoveryId: string;
  targetKind: "task" | "checkpoint";
  targetId: string;
  stage?: WorkflowAuthorityStage;
  nowMs?: number;
}): AuthorityOperationResult<WorkflowReserveDebit> {
  if (!isBoundedWorkflowId(input.recoveryId) || !isBoundedWorkflowId(input.targetId)) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "recoveryId and targetId must be bounded identities",
    };
  }
  if (input.debits.some((debit) => debit.recoveryId === input.recoveryId)) {
    return {
      ok: false,
      code: "DUPLICATE_DEBIT",
      message: `recovery ${input.recoveryId} already consumed a reserve unit`,
    };
  }
  if (input.authority.revocations.some((revocation) => revocation.kind === "revoke")) {
    return {
      ok: false,
      code: "AUTHORITY_REVOKED",
      message: `authority ${input.authority.authorityId} is revoked`,
    };
  }
  if (
    input.stage !== undefined &&
    !effectiveAuthorityStages(input.authority).includes(input.stage)
  ) {
    return {
      ok: false,
      code: "STAGE_NOT_DELEGATED",
      message: `${input.stage} is outside the surviving authority scope`,
    };
  }
  if (advanceUnitsAvailable(input.authority, input.debits) < 1) {
    return {
      ok: false,
      code: "RESERVE_EXHAUSTED",
      message: `authority ${input.authority.authorityId} has no remaining reserve units`,
    };
  }
  return {
    ok: true,
    value: {
      recoveryId: input.recoveryId,
      authorityId: input.authority.authorityId,
      targetKind: input.targetKind,
      targetId: input.targetId,
      units: 1,
      debitedAt: new Date(input.nowMs ?? Date.now()).toISOString(),
    },
  };
}

/** Fail-safe narrowing that cannot restore consumed units or broaden the scope. */
export function narrowAdvanceAuthority(input: {
  authority: WorkflowAuthorityRecord;
  revocationId: string;
  reason: string;
  narrowedStages?: WorkflowAuthorityStage[];
  nowMs?: number;
}): AuthorityOperationResult<WorkflowAuthorityRevocation> {
  if (!isBoundedWorkflowId(input.revocationId)) {
    return { ok: false, code: "INVALID_INPUT", message: "revocationId must be a bounded identity" };
  }
  if (input.authority.revocations.length > 0) {
    return {
      ok: false,
      code: "AUTHORITY_REVOKED",
      message: "authority is already revoked or narrowed",
    };
  }
  const surviving = input.narrowedStages ?? input.authority.scope.stages;
  const subset = surviving.every((stage) => input.authority.scope.stages.includes(stage));
  if (!subset) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "narrowing may only remove stages already covered by the authority",
    };
  }
  return {
    ok: true,
    value: {
      revocationId: input.revocationId,
      kind: "narrow",
      reason: input.reason.trim() || "narrowed",
      narrowedStages: [...surviving],
      revokedAt: new Date(input.nowMs ?? Date.now()).toISOString(),
    },
  };
}

/** Revoke future and unlaunched credits without erasing history. */
export function revokeAdvanceAuthority(input: {
  authority: WorkflowAuthorityRecord;
  revocationId: string;
  reason: string;
  nowMs?: number;
}): AuthorityOperationResult<WorkflowAuthorityRevocation> {
  if (!isBoundedWorkflowId(input.revocationId)) {
    return { ok: false, code: "INVALID_INPUT", message: "revocationId must be a bounded identity" };
  }
  if (input.authority.revocations.some((revocation) => revocation.kind === "revoke")) {
    return {
      ok: false,
      code: "AUTHORITY_REVOKED",
      message: "authority is already revoked",
    };
  }
  return {
    ok: true,
    value: {
      revocationId: input.revocationId,
      kind: "revoke",
      reason: input.reason.trim() || "revoked",
      revokedAt: new Date(input.nowMs ?? Date.now()).toISOString(),
    },
  };
}

/** Whether a stage remains reserved for explicit user action. */
export function isStageReserved(
  scope: WorkflowAuthorityScope,
  stage: WorkflowAuthorityStage,
): boolean {
  return scope.reservedStops.includes(stage);
}

/** Record a truthful controller_delegated stage approval when authority covers the stage. */
export function proposeStageApproval(input: {
  authority: WorkflowAuthorityRecord;
  approvalId: string;
  stage: WorkflowAuthorityStage;
  artifactPath: string;
  artifactSha256: string;
  provenance: WorkflowAuthorityProvenance;
  nowMs?: number;
}): AuthorityOperationResult<WorkflowStageApproval> {
  if (!isBoundedWorkflowId(input.approvalId)) {
    return { ok: false, code: "INVALID_INPUT", message: "approvalId must be a bounded identity" };
  }
  if (input.authority.revocations.some((revocation) => revocation.kind === "revoke")) {
    return {
      ok: false,
      code: "AUTHORITY_REVOKED",
      message: `authority ${input.authority.authorityId} is revoked`,
    };
  }
  if (!effectiveAuthorityStages(input.authority).includes(input.stage)) {
    return {
      ok: false,
      code: "STAGE_NOT_DELEGATED",
      message: `authority does not cover the ${input.stage} stage`,
    };
  }
  if (isStageReserved(input.authority.scope, input.stage)) {
    return {
      ok: false,
      code: "STAGE_RESERVED",
      message: `${input.stage} remains reserved for explicit user action`,
    };
  }
  if (
    typeof input.artifactPath !== "string" ||
    input.artifactPath.trim() === "" ||
    typeof input.artifactSha256 !== "string" ||
    input.artifactSha256.trim() === ""
  ) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "stage approval requires the approved artifact path and hash",
    };
  }
  return {
    ok: true,
    value: {
      approvalId: input.approvalId,
      authorityId: input.authority.authorityId,
      stage: input.stage,
      artifactPath: input.artifactPath,
      artifactSha256: input.artifactSha256,
      provenance: input.provenance,
      recordedAt: new Date(input.nowMs ?? Date.now()).toISOString(),
    },
  };
}
