// FILE: src/plugins/workflow/execution.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: One durable execution registry for native-package, provided-plan, and conversation-scoped runs with immutable source identity, incremental append-only task/checkpoint contracts, exact-reference validation, explicit replacement/split lineage, and shared budget carry-over.
//   SCOPE: Deterministic run identity, source-switch rejection, atomic batch registration and append with full validation before any record is published, exact adoption of compatible unbound work items, quiescent-task replacement/split with aggregate criteria/scope preservation and inherited attempt/rework/recovery budget, native plan-run compatibility migration, sealing, and read-only run views. Domain review generation, authority, and SDK transport live in sibling modules.
//   DEPENDS: [node:crypto, node:path, src/lib/workflow-contract.ts, src/plugins/workflow/state.ts]
//   LINKS: [M-WORKFLOW-EXECUTION, M-WORKFLOW-CONTRACT, M-WORKFLOW-STATE, M-WORKFLOW-DELEGATED, V-M-WORKFLOW-EXECUTION]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   WorkflowTaskBinding - One registered task contract bound to its work item with lineage and status.
//   WorkflowTaskStatus - Lifecycle of one task binding.
//   WorkflowCheckpointReviewerOutcome - One reviewer's recorded outcome inside a generation.
//   WorkflowCheckpointReviewState - Current in-flight generic review generation state.
//   WorkflowCheckpointHistoryEntry - One settled generic generation outcome.
//   WorkflowCheckpointRecoveryEntry - One recorded generic checkpoint exhaustion recovery.
//   WorkflowCheckpointBinding - One registered checkpoint contract bound to its execution revision.
//   WorkflowExecutionRecord - Authoritative registry entry for one common execution.
//   RegisterExecutionTaskInput - One task contract plus an optional exact unbound work item to adopt.
//   RegisterExecutionInput - Generic registration payload for one execution and its first batch.
//   RegisterExecutionResult - Registration outcome with idempotent reuse or a coded rejection.
//   AppendExecutionWorkInput - Append-only amendment of tasks and checkpoints.
//   AppendExecutionWorkResult - Amendment outcome with the new revision or a coded rejection.
//   AdoptWorkItemsInput - Exact adoption of existing compatible unbound work items.
//   AdoptWorkItemsResult - Adoption outcome with the bound identities or a coded rejection.
//   SplitExecutionTaskInput - Replacement/split of one quiescent unaccepted task.
//   SplitExecutionTaskResult - Replacement outcome with descendant identities or a coded rejection.
//   ExecutionMutationErrorCode - Coded rejection families for registry mutations.
//   deriveExecutionRunId - Deterministic common run identity from session, key, and source.
//   deriveTaskStatus - Derive current task lifecycle status from the bound work-item record.
//   cloneWorkflowExecution - Deep clone of one execution record for staged commits.
//   findExecution - Look up one execution by run id.
//   findExecutionByKey - Look up one execution by session and stable execution key.
//   ensureNativeExecutions - Compatibility view that materializes registry entries for existing native runs.
//   registerExecutionInStore - Atomically register or idempotently reuse one execution and its first batch.
//   appendExecutionWorkInStore - Append validated tasks/checkpoints without replaying accepted work.
//   adoptWorkItemsInStore - Bind exact compatible unbound work items without resetting counters.
//   splitExecutionTaskInStore - Replace one quiescent unaccepted task with explicit descendants sharing its budget.
//   sealExecutionInStore - Seal a completed execution against implicit reopening.
//   getExecutionView - Read-only serialization of one execution for tooling output.
//   GENERIC_CHECKPOINT_GENERATIONS - Ordinary generic checkpoint generations before authorized recovery.
//   StartGenericCheckpointResult - Generic checkpoint start outcome.
//   RecordGenericReviewerResultResult - Generic reviewer result recording outcome.
//   CompleteExecutionErrorCode - Completion rejection families.
//   CompleteExecutionResult - Completion outcome with honest review status.
//   startGenericCheckpointInStore - Start one generic checkpoint generation after covered tasks are accepted.
//   recordGenericReviewerResultInStore - Record one reviewer outcome and settle the generation.
//   recoverGenericCheckpointInStore - Grant one exhaustion-recovery generation under a recorded advance unit.
//   isTaskLaunchableInStore - Whether sealed/superseded/live/budget state, declared dependencies, and barriers allow a task launch.
//   latestAttemptView - Bounded latest-attempt projection for execution and inspection views.
//   completeExecutionInStore - Complete a generic execution when all tasks and obligations hold.
//   registerExecution - Store-surface registration wrapper.
//   appendExecutionWork - Store-surface amendment wrapper.
//   adoptWorkItems - Store-surface adoption wrapper.
//   splitExecutionTask - Store-surface replacement/split wrapper.
//   delegatedAttemptBudget - Re-exported budget helper for inherited lineage budgets.
//   addAuthorityInStore - Persist one advance-authority record and message claim.
//   addStageApprovalInStore - Persist one recorded stage approval.
//   addReserveDebitInStore - Persist one advance-reserve debit.
//   putAuthorityInStore - Replace or append one authority record.
//   ExecutionMutationErrorCode - Coded rejection families for registry mutations.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-004 - getExecutionView derives current task status from the bound work-item record (accepted/closed included) instead of a stale binding status and exposes latest-attempt plus checkpoint generation/outcome detail; isTaskLaunchableInStore now also rejects sealed executions, superseded tasks, live attempts, and exhausted ordinary budgets so the read-only inspection guidance and the real launch gate agree. Prior C-WORKFLOW-PLAN-INDEPENDENCE: initial common execution registry.]
// END_CHANGE_SUMMARY

import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  isBoundedWorkflowId,
  taskContractsFromNativeDefinition,
  checkpointContractsFromNativeDefinition,
  validateExecutionBoundary,
  validateWorkflowCheckpointContract,
  validateWorkflowContractGraph,
  validateWorkflowTaskContract,
  WORKFLOW_TEXT_MAX_CHARS,
  type WorkflowAuthorityRecord,
  type WorkflowCheckpointContract,
  type WorkflowExecutionBoundary,
  type WorkflowExecutionSource,
  type WorkflowExecutionState,
  type WorkflowLineageEntry,
  type WorkflowMessageClaim,
  type WorkflowObligationOrigin,
  type WorkflowReserveDebit,
  type WorkflowReviewer,
  type WorkflowStageApproval,
  type WorkflowTaskContract,
} from "../../lib/workflow-contract.js";
import { nativeExecutionSource } from "./checkpoint-io.js";
import {
  delegatedAttemptBudget,
  type DelegatedAttemptStatus,
  type DelegatedImplementerStatus,
  type DelegatedWorkItemState,
} from "./delegated.js";
import type { WorkflowExecutionView } from "./results.js";
import {
  createRecordLookupKey,
  openWorkItemInStore,
  type WorkItemRecord,
  type WorkItemStore,
  type WorkItemStoreData,
} from "./state.js";

// START_BLOCK_EXECUTION_TYPES
export type WorkflowTaskStatus = "pending" | "launched" | "accepted" | "superseded";

export interface WorkflowTaskBinding {
  taskId: string;
  workItemId: string;
  contract: WorkflowTaskContract;
  origin: WorkflowObligationOrigin;
  revision: number;
  status: WorkflowTaskStatus;
  parentTaskId?: string;
  supersededBy?: string[];
}

export interface WorkflowCheckpointReviewerOutcome {
  status: "PASS" | "FAIL" | "NEEDS_CONTEXT";
  recordedAt: string;
}

export interface WorkflowCheckpointReviewState {
  reviewWorkItemId: string;
  generation: number;
  startedAt: string;
  startFingerprint: string;
  coveredAttemptIds: string[];
  results: Partial<Record<WorkflowReviewer, WorkflowCheckpointReviewerOutcome>>;
}

export interface WorkflowCheckpointHistoryEntry {
  generation: number;
  outcome: "passed" | "failed" | "stale" | "stopped";
  fingerprint: string;
  completedAt: string;
}

export interface WorkflowCheckpointRecoveryEntry {
  recoveryId: string;
  kind: "resume" | "advance_grant";
  diagnosis: string;
  changedCondition: string;
  verification: string[];
  recoveredAt: string;
}

export interface WorkflowCheckpointBinding {
  checkpointId: string;
  contract: WorkflowCheckpointContract;
  revision: number;
  parentCheckpointId?: string;
  /** Generic review generation state; native bindings leave this unset. */
  status?: "pending" | "in_review" | "passed" | "failed";
  attempts?: number;
  passedRevision?: number;
  /** Monotonic count of started generations (including stopped ones). */
  starts?: number;
  /** Set when a reviewer NEEDS_CONTEXT settled the generation as a recoverable stop. */
  stoppedAtGeneration?: number;
  currentReview?: WorkflowCheckpointReviewState;
  history?: WorkflowCheckpointHistoryEntry[];
  recoveryHistory?: WorkflowCheckpointRecoveryEntry[];
}

export interface WorkflowExecutionRecord {
  runId: string;
  sessionId: string;
  workspaceRoot: string;
  executionKey: string;
  source: WorkflowExecutionSource;
  goal: string;
  boundary: WorkflowExecutionBoundary;
  revision: number;
  state: WorkflowExecutionState;
  createdAt: string;
  updatedAt: string;
  sealedAt?: string;
  tasks: Map<string, WorkflowTaskBinding>;
  checkpoints: Map<string, WorkflowCheckpointBinding>;
  lineage: WorkflowLineageEntry[];
  authority: WorkflowAuthorityRecord[];
  stageApprovals: WorkflowStageApproval[];
  reserveDebits: WorkflowReserveDebit[];
}

export type ExecutionMutationErrorCode =
  | "INVALID_INPUT"
  | "EXECUTION_NOT_FOUND"
  | "SESSION_MISMATCH"
  | "SOURCE_SWITCH"
  | "EXECUTION_KEY_CONFLICT"
  | "UNKNOWN_REFERENCE"
  | "DUPLICATE_ID"
  | "CYCLIC_DEPENDENCY"
  | "OUT_OF_BOUNDARY"
  | "EXECUTION_SEALED"
  | "RETROACTIVE_BARRIER"
  | "TASK_NOT_FOUND"
  | "TASK_NOT_QUIESCENT"
  | "TASK_ALREADY_ACCEPTED"
  | "TASK_SUPERSEDED"
  | "NATIVE_REPLACEMENT"
  | "CRITERIA_NOT_PRESERVED"
  | "SCOPE_NOT_PRESERVED"
  | "ADOPTION_MISMATCH"
  | "WORK_ITEM_NOT_FOUND"
  | "WORK_ITEM_ALREADY_BOUND"
  | "TASK_BINDING_FAILED";
// END_BLOCK_EXECUTION_TYPES

// START_BLOCK_EXECUTION_HELPERS
function toIsoNow(): string {
  return new Date().toISOString();
}

function cloneTaskBinding(binding: WorkflowTaskBinding): WorkflowTaskBinding {
  return {
    ...binding,
    contract: {
      ...binding.contract,
      acceptanceCriteria: [...binding.contract.acceptanceCriteria],
      verification: [...binding.contract.verification],
      writeScope: [...binding.contract.writeScope],
      dependsOn: [...binding.contract.dependsOn],
      blockedBy: [...binding.contract.blockedBy],
      requiredReviewers: [...binding.contract.requiredReviewers],
    },
    ...(binding.supersededBy ? { supersededBy: [...binding.supersededBy] } : {}),
  };
}

function cloneCheckpointBinding(binding: WorkflowCheckpointBinding): WorkflowCheckpointBinding {
  return {
    ...binding,
    contract: {
      ...binding.contract,
      covers: [...binding.contract.covers],
      scope: [...binding.contract.scope],
      requiredReviewers: [...binding.contract.requiredReviewers],
      acceptance: [...binding.contract.acceptance],
      verification: [...binding.contract.verification],
      dependsOn: [...binding.contract.dependsOn],
    },
    ...(binding.currentReview
      ? {
          currentReview: {
            ...binding.currentReview,
            coveredAttemptIds: [...binding.currentReview.coveredAttemptIds],
            results: { ...binding.currentReview.results },
          },
        }
      : {}),
    ...(binding.history ? { history: binding.history.map((entry) => ({ ...entry })) } : {}),
    ...(binding.recoveryHistory
      ? {
          recoveryHistory: binding.recoveryHistory.map((entry) => ({
            ...entry,
            verification: [...entry.verification],
          })),
        }
      : {}),
  };
}

/** Deep clone of one execution record for staged persistence commits. */
export function cloneWorkflowExecution(
  execution: WorkflowExecutionRecord,
): WorkflowExecutionRecord {
  return {
    ...execution,
    boundary: {
      files: [...execution.boundary.files],
      directories: [...execution.boundary.directories],
    },
    tasks: new Map([...execution.tasks].map(([id, binding]) => [id, cloneTaskBinding(binding)])),
    checkpoints: new Map(
      [...execution.checkpoints].map(([id, binding]) => [id, cloneCheckpointBinding(binding)]),
    ),
    lineage: execution.lineage.map((entry) => ({
      ...entry,
      childTaskIds: [...entry.childTaskIds],
    })),
    authority: execution.authority.map((record) => ({
      ...record,
      scope: {
        ...record.scope,
        stages: [...record.scope.stages],
        fileBoundary: [...record.scope.fileBoundary],
        reservedStops: [...record.scope.reservedStops],
      },
      extensions: record.extensions.map((extension) => ({ ...extension })),
      revocations: record.revocations.map((revocation) => ({
        ...revocation,
        ...(revocation.narrowedStages ? { narrowedStages: [...revocation.narrowedStages] } : {}),
      })),
    })),
    stageApprovals: execution.stageApprovals.map((approval) => ({ ...approval })),
    reserveDebits: execution.reserveDebits.map((debit) => ({ ...debit })),
  };
}

function sourceIdentityOf(source: WorkflowExecutionSource): string {
  switch (source.kind) {
    case "native-package":
      return `native\u0000${source.planPath}\u0000${source.planSha256}\u0000${source.specSha256}`;
    case "provided-plan":
      return `provided\u0000${source.reference}\u0000${source.sha256 ?? ""}`;
    case "conversation-scoped":
      return "conversation-scoped";
  }
}

/** Deterministic common run identity from session, stable execution key, and source identity. */
export function deriveExecutionRunId(
  sessionId: string,
  executionKey: string,
  source: WorkflowExecutionSource,
): string {
  return `run-${createHash("sha256")
    .update(`${sessionId}\n${executionKey}\n${sourceIdentityOf(source)}`)
    .digest("hex")
    .slice(0, 16)}`;
}

/** Look up one execution by run id. */
export function findExecution(
  data: WorkItemStoreData,
  runId: string,
): WorkflowExecutionRecord | undefined {
  return data.executions.get(runId);
}

/** Look up one execution by session and stable execution key. */
export function findExecutionByKey(
  data: WorkItemStoreData,
  sessionId: string,
  executionKey: string,
): WorkflowExecutionRecord | undefined {
  for (const execution of data.executions.values()) {
    if (execution.sessionId === sessionId && execution.executionKey === executionKey) {
      return execution;
    }
  }
  return undefined;
}

function findRecord(
  data: WorkItemStoreData,
  sessionId: string,
  workItemId: string,
): WorkItemRecord | undefined {
  return data.records.get(createRecordLookupKey(sessionId, workItemId));
}

function workItemKey(executionKey: string, taskId: string): string {
  return `exec:${executionKey}:task:${taskId}`;
}

function autoCheckpoint(task: WorkflowTaskContract): WorkflowCheckpointContract {
  return {
    checkpointId: `review-${task.taskId}`,
    kind: "milestone",
    covers: [task.taskId],
    scope: [...task.writeScope],
    requiredReviewers: [...task.requiredReviewers],
    acceptance: [...task.acceptanceCriteria],
    verification: [...task.verification],
    origin: "controller",
    dependsOn: [],
  };
}

/** Remove work items created during a failed staged batch so nothing is published. */
function rollbackCreatedWorkItems(
  data: WorkItemStoreData,
  sessionId: string,
  createdKeys: readonly string[],
): void {
  const index = data.keyIndexBySession.get(sessionId);
  for (const key of createdKeys) {
    const workItemId = index?.get(key);
    if (!workItemId) continue;
    index?.delete(key);
    data.records.delete(createRecordLookupKey(sessionId, workItemId));
  }
}

function bindingIsBoundElsewhere(
  data: WorkItemStoreData,
  sessionId: string,
  workItemId: string,
  runId: string,
): boolean {
  for (const execution of data.executions.values()) {
    if (execution.runId === runId) continue;
    for (const binding of execution.tasks.values()) {
      if (binding.workItemId === workItemId && execution.sessionId === sessionId) return true;
    }
  }
  for (const run of data.planRuns.values()) {
    if (run.sessionId !== sessionId) continue;
    for (const task of run.tasks.values()) {
      if (task.workItemId === workItemId) return true;
    }
  }
  return false;
}

/** Derive current task status from the bound work-item record (acceptance, live attempt, closure). */
export function deriveTaskStatus(
  record: WorkItemRecord | undefined,
): WorkflowTaskStatus | undefined {
  if (!record) return undefined;
  const delegated = record.delegated;
  if (!delegated) return undefined;
  if (record.state === "closed") return "accepted";
  const accepted = delegated.acceptances.some((acceptance) => !acceptance.revokedAt);
  if (accepted) return "accepted";
  if (delegated.attempts.some((attempt) => attempt.status === "in_flight")) return "launched";
  return "pending";
}

/** Bounded latest-attempt projection shared by execution and inspection views. */
export function latestAttemptView(record: WorkItemRecord | undefined):
  | {
      attempt: number;
      status: DelegatedAttemptStatus;
      resultStatus?: DelegatedImplementerStatus;
      completedAt?: string;
      reportRejected: boolean;
    }
  | undefined {
  const attempts = record?.delegated?.attempts;
  if (!attempts || attempts.length === 0) return undefined;
  const latest = attempts[attempts.length - 1]!;
  return {
    attempt: latest.attempt,
    status: latest.status,
    ...(latest.resultStatus !== undefined ? { resultStatus: latest.resultStatus } : {}),
    ...(latest.completedAt !== undefined ? { completedAt: latest.completedAt } : {}),
    reportRejected: latest.status === "report_rejected",
  };
}
// END_BLOCK_EXECUTION_HELPERS

// START_BLOCK_EXECUTION_INPUTS
export interface RegisterExecutionTaskInput {
  contract: WorkflowTaskContract;
  /** Optional exact existing compatible unbound work item to adopt instead of creating one. */
  workItemId?: string;
}

export interface RegisterExecutionInput {
  sessionId: string;
  workspaceRoot: string;
  executionKey: string;
  source: WorkflowExecutionSource;
  goal: string;
  boundary: WorkflowExecutionBoundary;
  tasks: RegisterExecutionTaskInput[];
  checkpoints?: WorkflowCheckpointContract[];
}

export type RegisterExecutionResult =
  | { ok: true; runId: string; reused: boolean; execution: WorkflowExecutionRecord }
  | { ok: false; errorCode: ExecutionMutationErrorCode; message: string };

export interface AppendExecutionWorkInput {
  sessionId: string;
  runId: string;
  amendmentId: string;
  rationale: string;
  tasks?: RegisterExecutionTaskInput[];
  checkpoints?: WorkflowCheckpointContract[];
}

export type AppendExecutionWorkResult =
  | { ok: true; revision: number; execution: WorkflowExecutionRecord }
  | { ok: false; errorCode: ExecutionMutationErrorCode; message: string };

export interface AdoptWorkItemsInput {
  sessionId: string;
  runId: string;
  workItems: Array<{ workItemId: string; taskId: string }>;
}

export type AdoptWorkItemsResult =
  | { ok: true; execution: WorkflowExecutionRecord }
  | { ok: false; errorCode: ExecutionMutationErrorCode; message: string };

export interface SplitExecutionTaskInput {
  sessionId: string;
  runId: string;
  parentTaskId: string;
  amendmentId: string;
  rationale: string;
  children: WorkflowTaskContract[];
}

export type SplitExecutionTaskResult =
  | { ok: true; childTaskIds: string[]; execution: WorkflowExecutionRecord }
  | { ok: false; errorCode: ExecutionMutationErrorCode; message: string };
// END_BLOCK_EXECUTION_INPUTS

// START_BLOCK_SOURCE_VALIDATION
function validateSource(
  source: WorkflowExecutionSource,
): { ok: true } | { ok: false; message: string } {
  if (source === null || typeof source !== "object") {
    return { ok: false, message: "source must be an object" };
  }
  switch (source.kind) {
    case "native-package":
      if (
        typeof source.planPath !== "string" ||
        source.planPath.trim() === "" ||
        typeof source.specPath !== "string" ||
        source.specPath.trim() === "" ||
        typeof source.planSha256 !== "string" ||
        source.planSha256.trim() === "" ||
        typeof source.specSha256 !== "string" ||
        source.specSha256.trim() === ""
      ) {
        return { ok: false, message: "native-package source requires plan/spec paths and hashes" };
      }
      return { ok: true };
    case "provided-plan":
      if (
        typeof source.reference !== "string" ||
        source.reference.trim() === "" ||
        source.reference.trim().length > WORKFLOW_TEXT_MAX_CHARS
      ) {
        return { ok: false, message: "provided-plan source requires a bounded reference" };
      }
      if (
        source.sha256 !== undefined &&
        (typeof source.sha256 !== "string" || source.sha256.trim() === "")
      ) {
        return {
          ok: false,
          message: "provided-plan sha256 must be a non-empty string when present",
        };
      }
      return { ok: true };
    case "conversation-scoped":
      return { ok: true };
    default:
      return {
        ok: false,
        message: "source.kind must be native-package, provided-plan, or conversation-scoped",
      };
  }
}
// END_BLOCK_SOURCE_VALIDATION

// START_CONTRACT: registerExecutionInStore
//   PURPOSE: Atomically register a common execution and its first task/checkpoint batch without launching agents.
//   INPUTS: { data: WorkItemStoreData - backing store data, input: RegisterExecutionInput - validated registration payload }
//   OUTPUTS: { RegisterExecutionResult - created/reused execution or a coded rejection }
//   SIDE_EFFECTS: [Creates execution registry entry and delegated work items; nothing is published when validation fails]
//   LINKS: [M-WORKFLOW-EXECUTION, validateWorkflowContractGraph, openWorkItemInStore]
// END_CONTRACT: registerExecutionInStore
export function registerExecutionInStore(
  data: WorkItemStoreData,
  input: RegisterExecutionInput,
): RegisterExecutionResult {
  if (typeof input.sessionId !== "string" || input.sessionId.trim() === "") {
    return {
      ok: false,
      errorCode: "INVALID_INPUT",
      message: "sessionId must be a non-empty string",
    };
  }
  if (typeof input.workspaceRoot !== "string" || !isAbsolute(input.workspaceRoot)) {
    return {
      ok: false,
      errorCode: "INVALID_INPUT",
      message: "workspaceRoot must be an absolute path",
    };
  }
  if (!isBoundedWorkflowId(input.executionKey)) {
    return {
      ok: false,
      errorCode: "INVALID_INPUT",
      message: "executionKey must be a bounded identity",
    };
  }
  const goal = typeof input.goal === "string" ? input.goal.trim() : "";
  if (goal === "" || goal.length > WORKFLOW_TEXT_MAX_CHARS) {
    return { ok: false, errorCode: "INVALID_INPUT", message: "goal must be bounded and non-empty" };
  }
  const sourceCheck = validateSource(input.source);
  if (!sourceCheck.ok) {
    return { ok: false, errorCode: "INVALID_INPUT", message: sourceCheck.message };
  }
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
    return {
      ok: false,
      errorCode: "INVALID_INPUT",
      message: "at least one task contract is required",
    };
  }

  const boundaryCheck = validateExecutionBoundary(input.boundary);
  if (!boundaryCheck.ok) {
    return {
      ok: false,
      errorCode: "INVALID_INPUT",
      message: boundaryCheck.problems.map((problem) => problem.message).join("; "),
    };
  }
  const boundary = boundaryCheck.value;

  const tasks: WorkflowTaskContract[] = [];
  for (const entry of input.tasks) {
    const validated = validateWorkflowTaskContract(entry.contract);
    if (!validated.ok) {
      return {
        ok: false,
        errorCode: "INVALID_INPUT",
        message: validated.problems.map((problem) => problem.message).join("; "),
      };
    }
    tasks.push(validated.value);
  }

  const checkpoints: WorkflowCheckpointContract[] = [];
  for (const entry of input.checkpoints ?? []) {
    const validated = validateWorkflowCheckpointContract(entry);
    if (!validated.ok) {
      return {
        ok: false,
        errorCode: "INVALID_INPUT",
        message: validated.problems.map((problem) => problem.message).join("; "),
      };
    }
    checkpoints.push(validated.value);
  }
  for (const task of tasks) {
    if (task.requiredReviewers.length > 0) checkpoints.push(autoCheckpoint(task));
  }

  const graph = validateWorkflowContractGraph({ tasks, checkpoints, boundary });
  if (!graph.ok) {
    const first = graph.problems[0];
    return {
      ok: false,
      errorCode: graphErrorCode(first.code),
      message: graph.problems.map((problem) => problem.message).join("; "),
    };
  }

  const existing = findExecutionByKey(data, input.sessionId, input.executionKey);
  if (existing) {
    if (sourceIdentityOf(existing.source) !== sourceIdentityOf(input.source)) {
      return {
        ok: false,
        errorCode: "SOURCE_SWITCH",
        message: `execution key ${input.executionKey} is already bound to ${existing.source.kind} source`,
      };
    }
    const sameTasks =
      existing.tasks.size === tasks.length &&
      tasks.every((task) => {
        const binding = existing.tasks.get(task.taskId);
        return binding !== undefined && JSON.stringify(binding.contract) === JSON.stringify(task);
      });
    const sameBoundary = JSON.stringify(existing.boundary) === JSON.stringify(boundary);
    if (existing.goal !== goal || !sameTasks || !sameBoundary) {
      return {
        ok: false,
        errorCode: "EXECUTION_KEY_CONFLICT",
        message: `execution key ${input.executionKey} is already registered with a different contract`,
      };
    }
    return {
      ok: true,
      runId: existing.runId,
      reused: true,
      execution: cloneWorkflowExecution(existing),
    };
  }

  const runId = deriveExecutionRunId(input.sessionId, input.executionKey, input.source);
  const now = toIsoNow();
  const execution: WorkflowExecutionRecord = {
    runId,
    sessionId: input.sessionId,
    workspaceRoot: input.workspaceRoot,
    executionKey: input.executionKey,
    source: input.source,
    goal,
    boundary,
    revision: 1,
    state: "preparing",
    createdAt: now,
    updatedAt: now,
    tasks: new Map(),
    checkpoints: new Map(),
    lineage: [
      {
        lineageId: `lineage-${runId}-initial`,
        kind: "initial",
        amendmentId: "initial",
        childTaskIds: tasks.map((task) => task.taskId),
        previousRevision: 0,
        newRevision: 1,
        rationale: "Initial registration",
        createdAt: now,
      },
    ],
    authority: [],
    stageApprovals: [],
    reserveDebits: [],
  };

  const stagedBindings: WorkflowTaskBinding[] = [];
  const createdKeys: string[] = [];
  const adoptedWorkItemIds = new Set<string>();
  const failRegister = (
    errorCode: ExecutionMutationErrorCode,
    message: string,
  ): RegisterExecutionResult => {
    rollbackCreatedWorkItems(data, input.sessionId, createdKeys);
    return { ok: false, errorCode, message };
  };
  for (let index = 0; index < tasks.length; index++) {
    const task = tasks[index];
    const requestedWorkItemId = input.tasks[index]?.workItemId;
    if (requestedWorkItemId !== undefined) {
      if (adoptedWorkItemIds.has(requestedWorkItemId)) {
        return failRegister(
          "DUPLICATE_ID",
          `work item ${requestedWorkItemId} is adopted for more than one task`,
        );
      }
      adoptedWorkItemIds.add(requestedWorkItemId);
      const record = findRecord(data, input.sessionId, requestedWorkItemId);
      if (!record) {
        return failRegister(
          "WORK_ITEM_NOT_FOUND",
          `no work item ${requestedWorkItemId} to adopt for task ${task.taskId}`,
        );
      }
      if (record.mode !== "delegated" || !record.delegated) {
        return failRegister("ADOPTION_MISMATCH", `${requestedWorkItemId} is not delegated work`);
      }
      if (bindingIsBoundElsewhere(data, input.sessionId, requestedWorkItemId, runId)) {
        return failRegister(
          "WORK_ITEM_ALREADY_BOUND",
          `${requestedWorkItemId} is already bound to another execution`,
        );
      }
      if (
        JSON.stringify([...record.delegated.writeScope].sort()) !==
        JSON.stringify([...task.writeScope].sort())
      ) {
        return failRegister(
          "ADOPTION_MISMATCH",
          `${requestedWorkItemId} write scope does not match task ${task.taskId}`,
        );
      }
      stagedBindings.push({
        taskId: task.taskId,
        workItemId: requestedWorkItemId,
        contract: task,
        origin: "controller",
        revision: 1,
        status: deriveTaskStatus(record) ?? "pending",
      });
      continue;
    }
    const created = openWorkItemInStore(data, {
      sessionId: input.sessionId,
      key: workItemKey(input.executionKey, task.taskId),
      title: task.title,
      mode: "delegated",
      requiredReviewers: [],
      writeScope: task.writeScope,
    });
    if (!created.ok) {
      return failRegister("TASK_BINDING_FAILED", created.message);
    }
    createdKeys.push(workItemKey(input.executionKey, task.taskId));
    stagedBindings.push({
      taskId: task.taskId,
      workItemId: created.record.workItemId,
      contract: task,
      origin: "controller",
      revision: 1,
      status: "pending",
    });
  }
  // Publish all bindings only after every item was created or adopted.
  for (const binding of stagedBindings) execution.tasks.set(binding.taskId, binding);
  for (const checkpoint of checkpoints) {
    execution.checkpoints.set(checkpoint.checkpointId, {
      checkpointId: checkpoint.checkpointId,
      contract: checkpoint,
      revision: 1,
    });
  }

  // All validation and item creation succeeded; publish the registry entry.
  execution.state = "active";
  data.executions.set(runId, execution);

  return { ok: true, runId, reused: false, execution: cloneWorkflowExecution(execution) };
}

function graphErrorCode(code: string): ExecutionMutationErrorCode {
  switch (code) {
    case "DUPLICATE_ID":
      return "DUPLICATE_ID";
    case "UNKNOWN_REFERENCE":
      return "UNKNOWN_REFERENCE";
    case "CYCLIC_DEPENDENCY":
      return "CYCLIC_DEPENDENCY";
    case "OUT_OF_BOUNDARY":
      return "OUT_OF_BOUNDARY";
    case "SELF_REFERENCE":
      return "CYCLIC_DEPENDENCY";
    default:
      return "INVALID_INPUT";
  }
}
// START_CONTRACT: appendExecutionWorkInStore
//   PURPOSE: Append validated dependency-ready tasks/checkpoints without replaying accepted work or installing retroactive barriers.
//   INPUTS: { data: WorkItemStoreData - backing store data, input: AppendExecutionWorkInput - amendment payload }
//   OUTPUTS: { AppendExecutionWorkResult - new revision or a coded rejection }
//   SIDE_EFFECTS: [Creates work items and mutates the execution registry only after full batch validation]
//   LINKS: [M-WORKFLOW-EXECUTION]
// END_CONTRACT: appendExecutionWorkInStore
export function appendExecutionWorkInStore(
  data: WorkItemStoreData,
  input: AppendExecutionWorkInput,
): AppendExecutionWorkResult {
  const foundExecution = findExecution(data, input.runId);
  // Mutate a clone so staged transactions and accidental callers never mutate
  // shared live state before the snapshot is persisted.
  const execution = foundExecution ? cloneWorkflowExecution(foundExecution) : undefined;
  if (!execution) {
    return { ok: false, errorCode: "EXECUTION_NOT_FOUND", message: `no execution ${input.runId}` };
  }
  if (execution.sessionId !== input.sessionId) {
    return {
      ok: false,
      errorCode: "SESSION_MISMATCH",
      message: "execution belongs to another session",
    };
  }
  if (execution.state === "sealed") {
    return {
      ok: false,
      errorCode: "EXECUTION_SEALED",
      message: `execution ${input.runId} is sealed`,
    };
  }
  if (execution.source.kind === "native-package") {
    return {
      ok: false,
      errorCode: "NATIVE_REPLACEMENT",
      message: "native structural amendments require the native source lifecycle",
    };
  }
  if (!isBoundedWorkflowId(input.amendmentId)) {
    return {
      ok: false,
      errorCode: "INVALID_INPUT",
      message: "amendmentId must be a bounded identity",
    };
  }
  const rationale = typeof input.rationale === "string" ? input.rationale.trim() : "";
  if (rationale === "" || rationale.length > WORKFLOW_TEXT_MAX_CHARS) {
    return {
      ok: false,
      errorCode: "INVALID_INPUT",
      message: "rationale must be bounded and non-empty",
    };
  }

  const newTasks: WorkflowTaskContract[] = [];
  for (const entry of input.tasks ?? []) {
    const validated = validateWorkflowTaskContract(entry.contract);
    if (!validated.ok) {
      return {
        ok: false,
        errorCode: "INVALID_INPUT",
        message: validated.problems.map((problem) => problem.message).join("; "),
      };
    }
    newTasks.push(validated.value);
  }
  const newCheckpoints: WorkflowCheckpointContract[] = [];
  for (const entry of input.checkpoints ?? []) {
    const validated = validateWorkflowCheckpointContract(entry);
    if (!validated.ok) {
      return {
        ok: false,
        errorCode: "INVALID_INPUT",
        message: validated.problems.map((problem) => problem.message).join("; "),
      };
    }
    newCheckpoints.push(validated.value);
  }
  for (const task of newTasks) {
    if (task.requiredReviewers.length > 0) newCheckpoints.push(autoCheckpoint(task));
  }
  if (newTasks.length === 0 && newCheckpoints.length === 0) {
    return { ok: false, errorCode: "INVALID_INPUT", message: "amendment declares no additions" };
  }

  const existingTasks = [...execution.tasks.values()].map((binding) => binding.contract);
  const existingCheckpoints = [...execution.checkpoints.values()].map(
    (binding) => binding.contract,
  );

  const combinedTasks = [...existingTasks, ...newTasks];
  const combinedCheckpoints = [...existingCheckpoints, ...newCheckpoints];

  for (const task of newTasks) {
    if (execution.tasks.has(task.taskId)) {
      return {
        ok: false,
        errorCode: "DUPLICATE_ID",
        message: `task ${task.taskId} already exists in ${input.runId}`,
      };
    }
  }
  for (const checkpoint of newCheckpoints) {
    if (execution.checkpoints.has(checkpoint.checkpointId)) {
      return {
        ok: false,
        errorCode: "DUPLICATE_ID",
        message: `checkpoint ${checkpoint.checkpointId} already exists in ${input.runId}`,
      };
    }
    for (const covered of checkpoint.covers) {
      const binding = execution.tasks.get(covered);
      if (binding && (binding.status === "launched" || binding.status === "accepted")) {
        return {
          ok: false,
          errorCode: "RETROACTIVE_BARRIER",
          message: `new checkpoint ${checkpoint.checkpointId} cannot retroactively cover ${binding.status} task ${covered}`,
        };
      }
    }
  }
  for (const task of newTasks) {
    for (const barrier of task.blockedBy) {
      if (
        execution.checkpoints.has(barrier) &&
        !newCheckpoints.some((c) => c.checkpointId === barrier)
      ) {
        return {
          ok: false,
          errorCode: "RETROACTIVE_BARRIER",
          message: `new task ${task.taskId} cannot be blocked by pre-existing checkpoint ${barrier}`,
        };
      }
    }
  }

  const graph = validateWorkflowContractGraph({
    tasks: combinedTasks,
    checkpoints: combinedCheckpoints,
    boundary: execution.boundary,
  });
  if (!graph.ok) {
    return {
      ok: false,
      errorCode: graphErrorCode(graph.problems[0].code),
      message: graph.problems.map((problem) => problem.message).join("; "),
    };
  }

  const revision = execution.revision + 1;
  const now = toIsoNow();
  const stagedTaskBindings: WorkflowTaskBinding[] = [];
  const createdKeys: string[] = [];
  for (const task of newTasks) {
    const created = openWorkItemInStore(data, {
      sessionId: execution.sessionId,
      key: workItemKey(execution.executionKey, task.taskId),
      title: task.title,
      mode: "delegated",
      requiredReviewers: [],
      writeScope: task.writeScope,
    });
    if (!created.ok) {
      rollbackCreatedWorkItems(data, execution.sessionId, createdKeys);
      return { ok: false, errorCode: "TASK_BINDING_FAILED", message: created.message };
    }
    createdKeys.push(workItemKey(execution.executionKey, task.taskId));
    stagedTaskBindings.push({
      taskId: task.taskId,
      workItemId: created.record.workItemId,
      contract: task,
      origin: "controller",
      revision,
      status: "pending",
    });
  }
  // Publish the batch only after every work item was created.
  for (const binding of stagedTaskBindings) execution.tasks.set(binding.taskId, binding);
  for (const checkpoint of newCheckpoints) {
    execution.checkpoints.set(checkpoint.checkpointId, {
      checkpointId: checkpoint.checkpointId,
      contract: checkpoint,
      revision,
    });
  }
  execution.revision = revision;
  execution.updatedAt = now;
  execution.lineage.push({
    lineageId: `lineage-${execution.runId}-${input.amendmentId}`,
    kind: "amendment",
    amendmentId: input.amendmentId,
    childTaskIds: newTasks.map((task) => task.taskId),
    previousRevision: revision - 1,
    newRevision: revision,
    rationale,
    createdAt: now,
  });
  data.executions.set(execution.runId, execution);

  return { ok: true, revision, execution: cloneWorkflowExecution(execution) };
}
// START_CONTRACT: adoptWorkItemsInStore
//   PURPOSE: Bind exact compatible unbound standalone work items into an execution without resetting counters or history.
//   INPUTS: { data: WorkItemStoreData - backing store data, input: AdoptWorkItemsInput - run and exact work item/task pairs }
//   OUTPUTS: { AdoptWorkItemsResult - updated execution or a coded rejection }
//   SIDE_EFFECTS: [Rebinds existing task bindings to the supplied work items]
//   LINKS: [M-WORKFLOW-EXECUTION]
// END_CONTRACT: adoptWorkItemsInStore
export function adoptWorkItemsInStore(
  data: WorkItemStoreData,
  input: AdoptWorkItemsInput,
): AdoptWorkItemsResult {
  const foundExecution = findExecution(data, input.runId);
  // Mutate a clone so staged transactions and accidental callers never mutate
  // shared live state before the snapshot is persisted.
  const execution = foundExecution ? cloneWorkflowExecution(foundExecution) : undefined;
  if (!execution) {
    return { ok: false, errorCode: "EXECUTION_NOT_FOUND", message: `no execution ${input.runId}` };
  }
  if (execution.sessionId !== input.sessionId) {
    return {
      ok: false,
      errorCode: "SESSION_MISMATCH",
      message: "execution belongs to another session",
    };
  }
  if (execution.state === "sealed") {
    return {
      ok: false,
      errorCode: "EXECUTION_SEALED",
      message: `execution ${input.runId} is sealed`,
    };
  }
  if (!Array.isArray(input.workItems) || input.workItems.length === 0) {
    return {
      ok: false,
      errorCode: "INVALID_INPUT",
      message: "at least one work item binding is required",
    };
  }

  const seenTaskIds = new Set<string>();
  const seenWorkItemIds = new Set<string>();
  for (const entry of input.workItems) {
    const binding = execution.tasks.get(entry.taskId);
    if (!binding) {
      return {
        ok: false,
        errorCode: "TASK_NOT_FOUND",
        message: `no task ${entry.taskId} in ${input.runId}`,
      };
    }
    if (seenTaskIds.has(entry.taskId) || seenWorkItemIds.has(entry.workItemId)) {
      return {
        ok: false,
        errorCode: "DUPLICATE_ID",
        message: `adoption batch repeats ${entry.taskId} or ${entry.workItemId}`,
      };
    }
    seenTaskIds.add(entry.taskId);
    seenWorkItemIds.add(entry.workItemId);
    for (const other of execution.tasks.values()) {
      if (other.workItemId === entry.workItemId && other.taskId !== entry.taskId) {
        return {
          ok: false,
          errorCode: "DUPLICATE_ID",
          message: `work item ${entry.workItemId} is already bound to task ${other.taskId}`,
        };
      }
    }
    const record = findRecord(data, execution.sessionId, entry.workItemId);
    if (!record) {
      return {
        ok: false,
        errorCode: "WORK_ITEM_NOT_FOUND",
        message: `no work item ${entry.workItemId}`,
      };
    }
    if (record.mode !== "delegated" || !record.delegated) {
      return {
        ok: false,
        errorCode: "ADOPTION_MISMATCH",
        message: `${entry.workItemId} is not delegated work`,
      };
    }
    if (bindingIsBoundElsewhere(data, execution.sessionId, entry.workItemId, execution.runId)) {
      return {
        ok: false,
        errorCode: "WORK_ITEM_ALREADY_BOUND",
        message: `${entry.workItemId} is already bound to another execution`,
      };
    }
    const declared = [...record.delegated.writeScope].sort();
    const expected = [...binding.contract.writeScope].sort();
    if (JSON.stringify(declared) !== JSON.stringify(expected)) {
      return {
        ok: false,
        errorCode: "ADOPTION_MISMATCH",
        message: `${entry.workItemId} write scope does not match task ${entry.taskId}`,
      };
    }
    if (record.sessionId !== execution.sessionId) {
      return {
        ok: false,
        errorCode: "SESSION_MISMATCH",
        message: `${entry.workItemId} belongs to another session`,
      };
    }
  }

  for (const entry of input.workItems) {
    const binding = execution.tasks.get(entry.taskId);
    if (!binding) continue;
    const record = findRecord(data, execution.sessionId, entry.workItemId);
    execution.tasks.set(entry.taskId, {
      ...binding,
      workItemId: entry.workItemId,
      status: deriveTaskStatus(record) ?? binding.status,
    });
  }
  execution.updatedAt = toIsoNow();
  data.executions.set(execution.runId, execution);
  return { ok: true, execution: cloneWorkflowExecution(execution) };
}
// START_CONTRACT: splitExecutionTaskInStore
//   PURPOSE: Replace one quiescent unaccepted generic task with explicit descendants that preserve aggregate criteria/scope and share the parent budget.
//   INPUTS: { data: WorkItemStoreData - backing store data, input: SplitExecutionTaskInput - parent identity and descendant contracts }
//   OUTPUTS: { SplitExecutionTaskResult - descendant ids or a coded rejection }
//   SIDE_EFFECTS: [Marks the parent superseded, creates descendant work items inheriting consumed budget, rewires explicit dependents]
//   LINKS: [M-WORKFLOW-EXECUTION, delegatedAttemptBudget]
// END_CONTRACT: splitExecutionTaskInStore
export function splitExecutionTaskInStore(
  data: WorkItemStoreData,
  input: SplitExecutionTaskInput,
): SplitExecutionTaskResult {
  const foundExecution = findExecution(data, input.runId);
  // Mutate a clone so staged transactions and accidental callers never mutate
  // shared live state before the snapshot is persisted.
  const execution = foundExecution ? cloneWorkflowExecution(foundExecution) : undefined;
  if (!execution) {
    return { ok: false, errorCode: "EXECUTION_NOT_FOUND", message: `no execution ${input.runId}` };
  }
  if (execution.sessionId !== input.sessionId) {
    return {
      ok: false,
      errorCode: "SESSION_MISMATCH",
      message: "execution belongs to another session",
    };
  }
  if (execution.state === "sealed") {
    return {
      ok: false,
      errorCode: "EXECUTION_SEALED",
      message: `execution ${input.runId} is sealed`,
    };
  }
  if (execution.source.kind === "native-package") {
    return {
      ok: false,
      errorCode: "NATIVE_REPLACEMENT",
      message: "native structural amendments require the native source lifecycle",
    };
  }
  const parent = execution.tasks.get(input.parentTaskId);
  if (!parent) {
    return { ok: false, errorCode: "TASK_NOT_FOUND", message: `no task ${input.parentTaskId}` };
  }
  if (parent.supersededBy) {
    return {
      ok: false,
      errorCode: "TASK_SUPERSEDED",
      message: `task ${input.parentTaskId} is already superseded`,
    };
  }
  if (parent.status === "accepted") {
    return {
      ok: false,
      errorCode: "TASK_ALREADY_ACCEPTED",
      message: `task ${input.parentTaskId} is accepted`,
    };
  }
  if (parent.status === "launched") {
    return {
      ok: false,
      errorCode: "TASK_NOT_QUIESCENT",
      message: `task ${input.parentTaskId} is launched`,
    };
  }

  const children: WorkflowTaskContract[] = [];
  for (const child of input.children ?? []) {
    const validated = validateWorkflowTaskContract(child);
    if (!validated.ok) {
      return {
        ok: false,
        errorCode: "INVALID_INPUT",
        message: validated.problems.map((problem) => problem.message).join("; "),
      };
    }
    if (execution.tasks.has(validated.value.taskId)) {
      return {
        ok: false,
        errorCode: "DUPLICATE_ID",
        message: `descendant ${validated.value.taskId} already exists`,
      };
    }
    children.push(validated.value);
  }
  if (children.length === 0) {
    return { ok: false, errorCode: "INVALID_INPUT", message: "split declares no descendants" };
  }
  if (!isBoundedWorkflowId(input.amendmentId)) {
    return {
      ok: false,
      errorCode: "INVALID_INPUT",
      message: "amendmentId must be a bounded identity",
    };
  }
  const splitRationale = typeof input.rationale === "string" ? input.rationale.trim() : "";
  if (splitRationale === "" || splitRationale.length > WORKFLOW_TEXT_MAX_CHARS) {
    return {
      ok: false,
      errorCode: "INVALID_INPUT",
      message: "rationale must be bounded and non-empty",
    };
  }

  const childCriteria = new Set(children.flatMap((child) => child.acceptanceCriteria));
  for (const criterion of parent.contract.acceptanceCriteria) {
    if (!childCriteria.has(criterion)) {
      return {
        ok: false,
        errorCode: "CRITERIA_NOT_PRESERVED",
        message: `descendants do not retain parent criterion ${JSON.stringify(criterion)}`,
      };
    }
  }
  const childScope = new Set(children.flatMap((child) => child.writeScope));
  for (const file of parent.contract.writeScope) {
    if (!childScope.has(file)) {
      return {
        ok: false,
        errorCode: "SCOPE_NOT_PRESERVED",
        message: `descendants do not cover parent write scope ${JSON.stringify(file)}`,
      };
    }
  }

  const now = toIsoNow();
  const revision = execution.revision + 1;
  const parentRecord = findRecord(data, execution.sessionId, parent.workItemId);
  if (!parentRecord) {
    return {
      ok: false,
      errorCode: "WORK_ITEM_NOT_FOUND",
      message: `missing parent work item ${parent.workItemId}`,
    };
  }
  const parentLedger: DelegatedWorkItemState | undefined = parentRecord.delegated;
  // Share the parent's remaining allowance across descendants: the aggregate
  // remaining attempts across children never exceeds the parent's remaining
  // attempts, so a split is not a fresh allowance per child.
  const parentRemaining = parentLedger
    ? Math.max(0, delegatedAttemptBudget(parentLedger) - parentLedger.attempts.length)
    : 0;
  const grantedRemaining = Math.min(parentRemaining, children.length);

  const childIds: string[] = [];
  const stagedTaskBindings: WorkflowTaskBinding[] = [];
  const createdKeys: string[] = [];
  let childIndex = 0;
  for (const child of children) {
    const carriedAttempts = Math.max(0, 2 - (childIndex < grantedRemaining ? 1 : 0));
    childIndex += 1;
    const created = openWorkItemInStore(data, {
      sessionId: execution.sessionId,
      key: workItemKey(execution.executionKey, child.taskId),
      title: child.title,
      mode: "delegated",
      requiredReviewers: [],
      writeScope: child.writeScope,
    });
    if (!created.ok) {
      rollbackCreatedWorkItems(data, execution.sessionId, createdKeys);
      return { ok: false, errorCode: "TASK_BINDING_FAILED", message: created.message };
    }
    createdKeys.push(workItemKey(execution.executionKey, child.taskId));
    const lookup = createRecordLookupKey(execution.sessionId, created.record.workItemId);
    const stored = data.records.get(lookup);
    if (stored) {
      // Descendants inherit only the parent's consumed attempt count as
      // historical carried attempts. Decisions, acceptances, rework grants,
      // and recovery grants are not copied, so no child gains a fresh budget.
      data.records.set(lookup, {
        ...stored,
        delegated: {
          writeScope: [...child.writeScope],
          attempts: Array.from({ length: carriedAttempts }, (_, attemptIndex) => ({
            attempt: attemptIndex + 1,
            callId: `carried-${execution.runId}-${child.taskId}-${attemptIndex + 1}`,
            launchedAt: now,
            status: "completed" as const,
            resultStatus: "BLOCKED" as const,
            completedAt: now,
          })),
          decisions: [],
          acceptances: [],
          reworkHistory: [],
          recoveryHistory: [],
        },
      });
    }
    childIds.push(child.taskId);
    stagedTaskBindings.push({
      taskId: child.taskId,
      workItemId: created.record.workItemId,
      contract: child,
      origin: "controller",
      revision,
      status: "pending",
      parentTaskId: parent.taskId,
    });
  }

  // Build the post-split graph and validate it before committing: children may
  // not reference unknown tasks, create cycles, or leave the boundary.
  const rewiredDependents: WorkflowTaskBinding[] = [];
  for (const [taskId, binding] of execution.tasks) {
    if (taskId === parent.taskId) continue;
    if (!binding.contract.dependsOn.includes(parent.taskId)) continue;
    const dependsOn = binding.contract.dependsOn.flatMap((dependency) =>
      dependency === parent.taskId ? childIds : [dependency],
    );
    rewiredDependents.push({
      ...binding,
      contract: { ...binding.contract, dependsOn: [...new Set(dependsOn)] },
    });
  }
  const combinedTasks = [
    ...[...execution.tasks.values()]
      .filter((binding) => binding.taskId !== parent.taskId)
      .map(
        (binding) =>
          rewiredDependents.find((entry) => entry.taskId === binding.taskId)?.contract ??
          binding.contract,
      ),
    ...children,
  ];
  const combinedCheckpoints = [...execution.checkpoints.values()].map(
    (checkpoint) => checkpoint.contract,
  );
  const graph = validateWorkflowContractGraph({
    tasks: combinedTasks,
    checkpoints: combinedCheckpoints,
    boundary: execution.boundary,
  });
  if (!graph.ok) {
    rollbackCreatedWorkItems(data, execution.sessionId, createdKeys);
    return {
      ok: false,
      errorCode: graphErrorCode(graph.problems[0].code),
      message: graph.problems.map((problem) => problem.message).join("; "),
    };
  }

  for (const binding of stagedTaskBindings) execution.tasks.set(binding.taskId, binding);
  execution.tasks.set(parent.taskId, {
    ...parent,
    status: "superseded",
    supersededBy: childIds,
    revision,
  });
  for (const binding of rewiredDependents) execution.tasks.set(binding.taskId, binding);

  execution.revision = revision;
  execution.updatedAt = now;
  execution.lineage.push({
    lineageId: `lineage-${execution.runId}-${input.amendmentId}`,
    kind: "split",
    amendmentId: input.amendmentId,
    parentTaskId: parent.taskId,
    childTaskIds: childIds,
    previousRevision: revision - 1,
    newRevision: revision,
    rationale: splitRationale,
    createdAt: now,
  });
  data.executions.set(execution.runId, execution);

  return { ok: true, childTaskIds: childIds, execution: cloneWorkflowExecution(execution) };
}
// START_CONTRACT: sealExecutionInStore
//   PURPOSE: Seal an execution so later additions and implicit reopening are rejected.
//   INPUTS: { data: WorkItemStoreData - backing store data, input: { sessionId, runId } - target identity }
//   OUTPUTS: { { ok: true; execution } | { ok: false; errorCode; message } - sealing outcome }
//   SIDE_EFFECTS: [Mutates the execution lifecycle state]
//   LINKS: [M-WORKFLOW-EXECUTION]
// END_CONTRACT: sealExecutionInStore
export function sealExecutionInStore(
  data: WorkItemStoreData,
  input: { sessionId: string; runId: string },
):
  | { ok: true; execution: WorkflowExecutionRecord }
  | { ok: false; errorCode: ExecutionMutationErrorCode; message: string } {
  const foundExecution = findExecution(data, input.runId);
  // Mutate a clone so staged transactions and accidental callers never mutate
  // shared live state before the snapshot is persisted.
  const execution = foundExecution ? cloneWorkflowExecution(foundExecution) : undefined;
  if (!execution) {
    return { ok: false, errorCode: "EXECUTION_NOT_FOUND", message: `no execution ${input.runId}` };
  }
  if (execution.sessionId !== input.sessionId) {
    return {
      ok: false,
      errorCode: "SESSION_MISMATCH",
      message: "execution belongs to another session",
    };
  }
  execution.state = "sealed";
  execution.sealedAt = toIsoNow();
  execution.updatedAt = execution.sealedAt;
  data.executions.set(execution.runId, execution);
  return { ok: true, execution: cloneWorkflowExecution(execution) };
}
// START_CONTRACT: ensureNativeExecutions
//   PURPOSE: Materialize registry entries for existing native plan runs without inventing authority or altering native counters.
//   INPUTS: { data: WorkItemStoreData - backing store data }
//   OUTPUTS: { void - registry entries are added for native runs that lack one }
//   SIDE_EFFECTS: [Adds compatibility execution records derived from existing native runs]
//   LINKS: [M-WORKFLOW-EXECUTION, nativeExecutionSource]
// END_CONTRACT: ensureNativeExecutions
export function ensureNativeExecutions(data: WorkItemStoreData): void {
  for (const run of data.planRuns.values()) {
    if (data.executions.has(run.runId)) continue;
    const tasks = taskContractsFromNativeDefinition(run.definition);
    const checkpoints = checkpointContractsFromNativeDefinition(run.definition);
    const execution: WorkflowExecutionRecord = {
      runId: run.runId,
      sessionId: run.sessionId,
      workspaceRoot: run.workspaceRoot,
      executionKey: `native:${run.planPath}`,
      source: nativeExecutionSource(run),
      goal: `Native approved plan run ${run.runId}`,
      boundary: {
        files: [...new Set(tasks.flatMap((task) => task.writeScope))],
        directories: [],
      },
      revision: 1,
      state: run.status === "sealed" ? "sealed" : "active",
      createdAt: run.registeredAt,
      updatedAt: run.registeredAt,
      tasks: new Map(
        tasks.map((task) => [
          task.taskId,
          {
            taskId: task.taskId,
            workItemId: run.tasks.get(task.taskId)?.workItemId ?? "",
            contract: task,
            origin: "source" as const,
            revision: 1,
            status: "pending" as const,
          },
        ]),
      ),
      checkpoints: new Map(
        checkpoints.map((checkpoint) => [
          checkpoint.checkpointId,
          { checkpointId: checkpoint.checkpointId, contract: checkpoint, revision: 1 },
        ]),
      ),
      lineage: [],
      authority: [],
      stageApprovals: [],
      reserveDebits: [],
    };
    data.executions.set(run.runId, execution);
  }
}
// START_CONTRACT: getExecutionView
//   PURPOSE: Serialize one execution into a stable read-only view for tooling output.
//   INPUTS: { execution: WorkflowExecutionRecord - registry entry, data?: WorkItemStoreData - optional store data for deriving current task acceptance }
//   OUTPUTS: { WorkflowExecutionView - plain serializable view including budget-relevant status and checkpoint generation detail }
//   SIDE_EFFECTS: [none]
//   LINKS: [M-WORKFLOW-EXECUTION, M-WORKFLOW-DELEGATED]
// END_CONTRACT: getExecutionView
export function getExecutionView(
  execution: WorkflowExecutionRecord,
  data?: WorkItemStoreData,
): WorkflowExecutionView {
  // For native runs the plan run is the authoritative lifecycle source; the
  // one-time materialized registry state can stay active after the run seals.
  const nativeRun =
    execution.source.kind === "native-package" ? data?.planRuns.get(execution.runId) : undefined;
  return {
    runId: execution.runId,
    sessionId: execution.sessionId,
    executionKey: execution.executionKey,
    sourceKind: execution.source.kind,
    goal: execution.goal,
    state: nativeRun ? (nativeRun.status === "sealed" ? "sealed" : "active") : execution.state,
    revision: execution.revision,
    tasks: [...execution.tasks.values()].map((binding) => {
      const record = data ? findRecord(data, execution.sessionId, binding.workItemId) : undefined;
      const derivedStatus =
        binding.status === "superseded"
          ? "superseded"
          : ((record ? deriveTaskStatus(record) : undefined) ?? binding.status);
      const latestAttempt = record ? latestAttemptView(record) : undefined;
      return {
        taskId: binding.taskId,
        workItemId: binding.workItemId,
        status: derivedStatus,
        requiredReviewers: [...binding.contract.requiredReviewers],
        dependsOn: [...binding.contract.dependsOn],
        blockedBy: [...binding.contract.blockedBy],
        ...(latestAttempt ? { latestAttempt } : {}),
      };
    }),
    checkpoints: [...execution.checkpoints.values()].map((binding) => {
      const history = binding.history?.map((entry) => ({
        generation: entry.generation,
        outcome: entry.outcome,
        completedAt: entry.completedAt,
      }));
      const lastOutcome =
        history && history.length > 0 ? history[history.length - 1]!.outcome : undefined;
      const advanceGrants = (binding.recoveryHistory ?? []).filter(
        (entry) => entry.kind === "advance_grant",
      ).length;
      const remainingGenerations =
        binding.attempts === undefined
          ? undefined
          : Math.max(0, GENERIC_CHECKPOINT_GENERATIONS + advanceGrants - binding.attempts);
      return {
        checkpointId: binding.checkpointId,
        kind: binding.contract.kind,
        covers: [...binding.contract.covers],
        requiredReviewers: [...binding.contract.requiredReviewers],
        ...(binding.status ? { status: binding.status } : {}),
        ...(binding.currentReview
          ? {
              reviewWorkItemId: binding.currentReview.reviewWorkItemId,
              generation: binding.currentReview.generation,
            }
          : {}),
        ...(binding.recoveryHistory ? { recoveryCount: binding.recoveryHistory.length } : {}),
        ...(binding.attempts !== undefined ? { attempts: binding.attempts } : {}),
        ...(remainingGenerations !== undefined ? { remainingGenerations } : {}),
        ...(lastOutcome !== undefined ? { lastOutcome } : {}),
        ...(binding.currentReview
          ? {
              currentReview: {
                reviewWorkItemId: binding.currentReview.reviewWorkItemId,
                generation: binding.currentReview.generation,
                coveredAttemptIds: [...binding.currentReview.coveredAttemptIds],
                recordedReviewers: Object.keys(binding.currentReview.results),
              },
            }
          : {}),
        ...(history ? { history } : {}),
      };
    }),
  };
}
// START_BLOCK_EXECUTION_PUBLIC_WRAPPERS
/** Register one execution through the store surface used by the plugin and tests. */
export function registerExecution(
  store: WorkItemStore,
  input: RegisterExecutionInput,
): RegisterExecutionResult {
  return registerExecutionInStore(store.getStoreData(), input);
}

/** Append validated work through the store surface. */
export function appendExecutionWork(
  store: WorkItemStore,
  input: AppendExecutionWorkInput,
): AppendExecutionWorkResult {
  return appendExecutionWorkInStore(store.getStoreData(), input);
}

/** Adopt exact compatible unbound work items through the store surface. */
export function adoptWorkItems(
  store: WorkItemStore,
  input: AdoptWorkItemsInput,
): AdoptWorkItemsResult {
  return adoptWorkItemsInStore(store.getStoreData(), input);
}

/** Split one quiescent task through the store surface. */
export function splitExecutionTask(
  store: WorkItemStore,
  input: SplitExecutionTaskInput,
): SplitExecutionTaskResult {
  return splitExecutionTaskInStore(store.getStoreData(), input);
}
// END_BLOCK_EXECUTION_PUBLIC_WRAPPERS

// START_BLOCK_GENERIC_REVIEWS
/** Ordinary generic checkpoint generations before an authorized recovery is required. */
export const GENERIC_CHECKPOINT_GENERATIONS = 2;

export type CompleteExecutionErrorCode = ExecutionMutationErrorCode | "EXECUTION_INCOMPLETE";

export type CompleteExecutionResult =
  | {
      ok: true;
      reviewStatus: "controller_accepted" | "independently_reviewed";
      execution: WorkflowExecutionRecord;
    }
  | { ok: false; errorCode: CompleteExecutionErrorCode; message: string };

function isTaskAccepted(
  data: WorkItemStoreData,
  execution: WorkflowExecutionRecord,
  taskId: string,
): boolean {
  const binding = execution.tasks.get(taskId);
  if (!binding) return false;
  const record = findRecord(data, execution.sessionId, binding.workItemId);
  if (!record?.delegated) return false;
  return record.delegated.acceptances.some((acceptance) => !acceptance.revokedAt);
}

function coveredAttemptIds(
  data: WorkItemStoreData,
  execution: WorkflowExecutionRecord,
  checkpoint: WorkflowCheckpointBinding,
): string[] {
  const ids: string[] = [];
  for (const taskId of checkpoint.contract.covers) {
    const binding = execution.tasks.get(taskId);
    if (!binding) continue;
    const record = findRecord(data, execution.sessionId, binding.workItemId);
    const acceptance = record?.delegated?.acceptances.find((entry) => !entry.revokedAt);
    if (acceptance) ids.push(`${binding.workItemId}#${acceptance.attempt}`);
  }
  return ids;
}

function findCheckpoint(
  execution: WorkflowExecutionRecord,
  checkpointId: string,
): WorkflowCheckpointBinding | undefined {
  return execution.checkpoints.get(checkpointId);
}

export type StartGenericCheckpointResult =
  | {
      ok: true;
      checkpoint: WorkflowCheckpointBinding;
      reviewers: WorkflowReviewer[];
      coveredAttemptIds: string[];
      reviewWorkItemId: string;
      header: string;
    }
  | { ok: false; errorCode: ExecutionMutationErrorCode | "EXECUTION_INCOMPLETE"; message: string };

/**
 * Start one generic checkpoint generation after every covered task is accepted.
 * The caller supplies the freshly captured fingerprint (the runtime captures a
 * real filesystem snapshot; pure domain tests may pass a deterministic token).
 */
export function startGenericCheckpointInStore(
  data: WorkItemStoreData,
  input: {
    sessionId: string;
    runId: string;
    checkpointId: string;
    startFingerprint?: string;
  },
): StartGenericCheckpointResult {
  const foundExecution = findExecution(data, input.runId);
  // Mutate a clone so staged transactions and accidental callers never mutate
  // shared live state before the snapshot is persisted.
  const execution = foundExecution ? cloneWorkflowExecution(foundExecution) : undefined;
  if (!execution) {
    return { ok: false, errorCode: "EXECUTION_NOT_FOUND", message: `no execution ${input.runId}` };
  }
  if (execution.sessionId !== input.sessionId) {
    return {
      ok: false,
      errorCode: "SESSION_MISMATCH",
      message: "execution belongs to another session",
    };
  }
  if (execution.state === "sealed") {
    return {
      ok: false,
      errorCode: "EXECUTION_SEALED",
      message: `execution ${input.runId} is sealed`,
    };
  }
  const checkpoint = findCheckpoint(execution, input.checkpointId);
  if (!checkpoint) {
    return {
      ok: false,
      errorCode: "UNKNOWN_REFERENCE",
      message: `no checkpoint ${input.checkpointId} in ${input.runId}`,
    };
  }
  if (checkpoint.contract.requiredReviewers.length === 0) {
    return {
      ok: false,
      errorCode: "INVALID_INPUT",
      message: "an assigned checkpoint requires a non-empty reviewer set",
    };
  }
  if (checkpoint.currentReview) {
    return {
      ok: false,
      errorCode: "INVALID_INPUT",
      message: `checkpoint ${input.checkpointId} already has an in-flight review generation`,
    };
  }
  if (checkpoint.status === "passed") {
    return {
      ok: false,
      errorCode: "INVALID_INPUT",
      message: `checkpoint ${input.checkpointId} already passed; re-review requires an explicit amendment or recovery`,
    };
  }
  if (checkpoint.stoppedAtGeneration !== undefined) {
    return {
      ok: false,
      errorCode: "INVALID_INPUT",
      message: `checkpoint ${input.checkpointId} is stopped after a reviewer NEEDS_CONTEXT; recover it before starting again`,
    };
  }
  const advanceGrants = (checkpoint.recoveryHistory ?? []).filter(
    (entry) => entry.kind === "advance_grant",
  ).length;
  if ((checkpoint.attempts ?? 0) >= GENERIC_CHECKPOINT_GENERATIONS + advanceGrants) {
    return {
      ok: false,
      errorCode: "INVALID_INPUT",
      message: `checkpoint ${input.checkpointId} exhausted its ordinary generations; explicit recovery is required`,
    };
  }
  for (const taskId of checkpoint.contract.covers) {
    if (!execution.tasks.has(taskId)) {
      return {
        ok: false,
        errorCode: "UNKNOWN_REFERENCE",
        message: `checkpoint ${input.checkpointId} covers unknown task ${taskId}`,
      };
    }
    if (!isTaskAccepted(data, execution, taskId)) {
      return {
        ok: false,
        errorCode: "EXECUTION_INCOMPLETE",
        message: `checkpoint ${input.checkpointId} requires accepted task ${taskId} before it may start`,
      };
    }
  }
  const covered = coveredAttemptIds(data, execution, checkpoint);
  // Every start gets a fresh monotonic generation identity so a resumed
  // generation never reuses the stopped review work item.
  const generation = (checkpoint.starts ?? 0) + 1;
  // Open a real review_only work item so reviewer results are recorded through
  // the tracked launch/result pipeline and bound to this generation by exact
  // work-item identity rather than asserted by the controller.
  const opened = openWorkItemInStore(data, {
    sessionId: input.sessionId,
    key: `exec:${execution.executionKey}:review:${input.checkpointId}:${generation}`,
    title: `Review ${input.checkpointId} (generation ${generation})`,
    mode: "review_only",
    requiredReviewers: [...checkpoint.contract.requiredReviewers],
  });
  if (!opened.ok) {
    return { ok: false, errorCode: "TASK_BINDING_FAILED", message: opened.message };
  }
  const reviewWorkItemId = opened.record.workItemId;
  const updated: WorkflowCheckpointBinding = {
    ...checkpoint,
    status: "in_review",
    starts: generation,
    currentReview: {
      reviewWorkItemId,
      generation,
      startedAt: toIsoNow(),
      startFingerprint:
        input.startFingerprint ?? `generic:${execution.revision}:${covered.join(",")}`,
      coveredAttemptIds: covered,
      results: {},
    },
  };
  execution.checkpoints.set(input.checkpointId, updated);
  execution.updatedAt = toIsoNow();
  data.executions.set(execution.runId, execution);
  return {
    ok: true,
    checkpoint: cloneCheckpointBinding(updated),
    reviewers: [...checkpoint.contract.requiredReviewers],
    coveredAttemptIds: covered,
    reviewWorkItemId,
    header: opened.header,
  };
}

export type RecordGenericReviewerResultResult =
  | {
      ok: true;
      outcome: "in_progress" | "passed" | "failed" | "stopped";
      checkpoint: WorkflowCheckpointBinding;
    }
  | { ok: false; errorCode: ExecutionMutationErrorCode; message: string };

/** Record one generic reviewer outcome and settle the generation when all reviewers reported. */
export function recordGenericReviewerResultInStore(
  data: WorkItemStoreData,
  input: {
    sessionId: string;
    runId: string;
    checkpointId: string;
    /** Omit to settle every required reviewer that has a recorded result. */
    reviewer?: WorkflowReviewer;
  },
): RecordGenericReviewerResultResult {
  const foundExecution = findExecution(data, input.runId);
  // Mutate a clone so staged transactions and accidental callers never mutate
  // shared live state before the snapshot is persisted.
  const execution = foundExecution ? cloneWorkflowExecution(foundExecution) : undefined;
  if (!execution) {
    return { ok: false, errorCode: "EXECUTION_NOT_FOUND", message: `no execution ${input.runId}` };
  }
  if (execution.sessionId !== input.sessionId) {
    return {
      ok: false,
      errorCode: "SESSION_MISMATCH",
      message: "execution belongs to another session",
    };
  }
  const checkpoint = findCheckpoint(execution, input.checkpointId);
  const review = checkpoint?.currentReview;
  if (!checkpoint || !review) {
    return {
      ok: false,
      errorCode: "INVALID_INPUT",
      message: "no in-flight generic review generation",
    };
  }
  const reviewRecord = findRecord(data, input.sessionId, review.reviewWorkItemId);
  if (!reviewRecord?.currentRound) {
    return {
      ok: false,
      errorCode: "INVALID_INPUT",
      message: `no linked review round ${review.reviewWorkItemId}`,
    };
  }
  const targets = input.reviewer ? [input.reviewer] : [...checkpoint.contract.requiredReviewers];
  for (const reviewer of targets) {
    if (!checkpoint.contract.requiredReviewers.includes(reviewer)) {
      return {
        ok: false,
        errorCode: "INVALID_INPUT",
        message: `${reviewer} is not required for checkpoint ${input.checkpointId}`,
      };
    }
    if (review.results[reviewer]) continue;
    // The status is read from the linked review_only work item's recorded
    // reviewer result; a caller cannot assert a reviewer outcome directly.
    const recorded = reviewRecord.currentRound.results[reviewer];
    if (!recorded) {
      if (input.reviewer) {
        return {
          ok: false,
          errorCode: "INVALID_INPUT",
          message: `${reviewer} has no recorded reviewer result on ${review.reviewWorkItemId}`,
        };
      }
      continue;
    }
    review.results[reviewer] = {
      status: recorded.status,
      recordedAt: recorded.completedAt,
    };
  }

  const allReported = checkpoint.contract.requiredReviewers.every(
    (reviewer) => review.results[reviewer] !== undefined,
  );

  // A reviewer NEEDS_CONTEXT is a hard stop, not a failed generation: settle it
  // as a recoverable "stopped" outcome without consuming a generation, matching
  // the native checkpoint semantics.
  const hasNeedsContext = checkpoint.contract.requiredReviewers.some(
    (reviewer) => review.results[reviewer]?.status === "NEEDS_CONTEXT",
  );
  if (hasNeedsContext) {
    const history = [...(checkpoint.history ?? [])];
    history.push({
      generation: review.generation,
      outcome: "stopped",
      fingerprint: review.startFingerprint,
      completedAt: toIsoNow(),
    });
    const stopped: WorkflowCheckpointBinding = {
      ...checkpoint,
      status: "failed",
      stoppedAtGeneration: review.generation,
      currentReview: undefined,
      history,
    };
    execution.checkpoints.set(input.checkpointId, stopped);
    execution.updatedAt = toIsoNow();
    data.executions.set(execution.runId, execution);
    return {
      ok: true,
      outcome: "stopped",
      checkpoint: cloneCheckpointBinding(stopped),
    };
  }

  if (!allReported) {
    execution.updatedAt = toIsoNow();
    data.executions.set(execution.runId, execution);
    return { ok: true, outcome: "in_progress", checkpoint: cloneCheckpointBinding(checkpoint) };
  }

  const passed = checkpoint.contract.requiredReviewers.every(
    (reviewer) => review.results[reviewer]?.status === "PASS",
  );
  const history = [...(checkpoint.history ?? [])];
  history.push({
    generation: review.generation,
    outcome: passed ? "passed" : "failed",
    fingerprint: review.startFingerprint,
    completedAt: toIsoNow(),
  });
  const settled: WorkflowCheckpointBinding = {
    ...checkpoint,
    status: passed ? "passed" : "failed",
    attempts: (checkpoint.attempts ?? 0) + 1,
    ...(passed ? { passedRevision: execution.revision } : {}),
    currentReview: undefined,
    history,
  };
  execution.checkpoints.set(input.checkpointId, settled);
  execution.updatedAt = toIsoNow();
  data.executions.set(execution.runId, execution);
  return {
    ok: true,
    outcome: passed ? "passed" : "failed",
    checkpoint: cloneCheckpointBinding(settled),
  };
}

/** Recover a stopped generic checkpoint (cost-free resume) or one exhausted generation under a recorded advance unit. */
export function recoverGenericCheckpointInStore(
  data: WorkItemStoreData,
  input: {
    sessionId: string;
    runId: string;
    checkpointId: string;
    recoveryId: string;
    diagnosis: string;
    changedCondition: string;
    verification: string[];
    /** True only when the transaction layer reserved one advance unit. */
    authorityGrant?: boolean;
  },
):
  | { ok: true; checkpoint: WorkflowCheckpointBinding; kind: "resume" | "advance_grant" }
  | { ok: false; errorCode: ExecutionMutationErrorCode; message: string } {
  const found = findExecution(data, input.runId);
  const execution = found ? cloneWorkflowExecution(found) : undefined;
  if (!execution) {
    return { ok: false, errorCode: "EXECUTION_NOT_FOUND", message: `no execution ${input.runId}` };
  }
  if (execution.sessionId !== input.sessionId) {
    return {
      ok: false,
      errorCode: "SESSION_MISMATCH",
      message: "execution belongs to another session",
    };
  }
  if (execution.state === "sealed") {
    return {
      ok: false,
      errorCode: "EXECUTION_SEALED",
      message: `execution ${input.runId} is sealed`,
    };
  }
  const checkpoint = findCheckpoint(execution, input.checkpointId);
  if (!checkpoint) {
    return {
      ok: false,
      errorCode: "UNKNOWN_REFERENCE",
      message: `no checkpoint ${input.checkpointId} in ${input.runId}`,
    };
  }
  if (checkpoint.currentReview) {
    return {
      ok: false,
      errorCode: "INVALID_INPUT",
      message: `checkpoint ${input.checkpointId} has an in-flight review generation`,
    };
  }
  const recoveryHistory = checkpoint.recoveryHistory ?? [];
  if (recoveryHistory.some((entry) => entry.recoveryId === input.recoveryId)) {
    return {
      ok: false,
      errorCode: "DUPLICATE_ID",
      message: `recovery ${input.recoveryId} is already recorded for ${input.checkpointId}`,
    };
  }
  const stopped = checkpoint.stoppedAtGeneration !== undefined;
  const advanceGrants = recoveryHistory.filter((entry) => entry.kind === "advance_grant").length;
  const budget = GENERIC_CHECKPOINT_GENERATIONS + advanceGrants;
  if (!stopped && (checkpoint.attempts ?? 0) < budget) {
    return {
      ok: false,
      errorCode: "INVALID_INPUT",
      message: `checkpoint ${input.checkpointId} is not exhausted; ordinary generations remain`,
    };
  }
  if (!stopped && input.authorityGrant !== true) {
    return {
      ok: false,
      errorCode: "INVALID_INPUT",
      message: `checkpoint ${input.checkpointId} requires one advance-authority unit to recover`,
    };
  }
  const kind: "resume" | "advance_grant" = stopped ? "resume" : "advance_grant";
  const updated: WorkflowCheckpointBinding = {
    ...checkpoint,
    ...(stopped ? { stoppedAtGeneration: undefined } : {}),
    recoveryHistory: [
      ...recoveryHistory,
      {
        recoveryId: input.recoveryId,
        kind,
        diagnosis: input.diagnosis.trim(),
        changedCondition: input.changedCondition.trim(),
        verification: input.verification.map((entry) => entry.trim()),
        recoveredAt: toIsoNow(),
      },
    ],
  };
  execution.checkpoints.set(input.checkpointId, updated);
  execution.updatedAt = toIsoNow();
  data.executions.set(execution.runId, execution);
  return { ok: true, checkpoint: cloneCheckpointBinding(updated), kind };
}

/** Whether a task's declared dependencies and barriers currently allow launch. */
export function isTaskLaunchableInStore(
  data: WorkItemStoreData,
  input: { sessionId: string; runId: string; taskId: string },
):
  | { ok: true }
  | {
      ok: false;
      reason:
        | "TASK_NOT_FOUND"
        | "EXECUTION_SEALED"
        | "TASK_SUPERSEDED"
        | "ATTEMPT_IN_FLIGHT"
        | "ATTEMPTS_EXHAUSTED"
        | "DEPENDENCIES_UNMET"
        | "BARRIER_UNSATISFIED";
      message: string;
    } {
  const foundExecution = findExecution(data, input.runId);
  // Mutate a clone so staged transactions and accidental callers never mutate
  // shared live state before the snapshot is persisted.
  const execution = foundExecution ? cloneWorkflowExecution(foundExecution) : undefined;
  if (!execution || execution.sessionId !== input.sessionId) {
    return { ok: false, reason: "TASK_NOT_FOUND", message: `no execution ${input.runId}` };
  }
  if (execution.state === "sealed") {
    return {
      ok: false,
      reason: "EXECUTION_SEALED",
      message: `execution ${input.runId} is sealed`,
    };
  }
  // The native plan run is the authoritative seal source: the one-time
  // materialized registry can stay "active" after the run itself seals.
  if (execution.source.kind === "native-package") {
    const nativeRun = data.planRuns.get(execution.runId);
    if (nativeRun?.status === "sealed") {
      return {
        ok: false,
        reason: "EXECUTION_SEALED",
        message: `execution ${input.runId} is sealed`,
      };
    }
  }
  const binding = execution.tasks.get(input.taskId);
  if (!binding) {
    return { ok: false, reason: "TASK_NOT_FOUND", message: `no task ${input.taskId}` };
  }
  if (binding.status === "superseded") {
    return {
      ok: false,
      reason: "TASK_SUPERSEDED",
      message: `task ${input.taskId} was replaced and cannot launch`,
    };
  }
  // Ordinary launch budget/live-attempt status derives from the bound work-item
  // record, matching the delegated launch gate the mutation would apply.
  const record = findRecord(data, execution.sessionId, binding.workItemId);
  if (record?.delegated) {
    if (record.delegated.attempts.some((attempt) => attempt.status === "in_flight")) {
      return {
        ok: false,
        reason: "ATTEMPT_IN_FLIGHT",
        message: `ATTEMPT_IN_FLIGHT: task ${input.taskId} already has an in-flight implementation attempt`,
      };
    }
    if (
      record.state !== "closed" &&
      record.delegated.attempts.length >= delegatedAttemptBudget(record.delegated)
    ) {
      return {
        ok: false,
        reason: "ATTEMPTS_EXHAUSTED",
        message: `ATTEMPTS_EXHAUSTED: task ${input.taskId} consumed all ordinary implementation attempts; explicit recovery or rework is required`,
      };
    }
  }
  for (const dependency of binding.contract.dependsOn) {
    if (!isTaskAccepted(data, execution, dependency)) {
      return {
        ok: false,
        reason: "DEPENDENCIES_UNMET",
        message: `task ${input.taskId} waits on unaccepted task ${dependency}`,
      };
    }
  }
  for (const barrier of binding.contract.blockedBy) {
    const checkpoint = findCheckpoint(execution, barrier);
    if (!checkpoint || checkpoint.status !== "passed") {
      return {
        ok: false,
        reason: "BARRIER_UNSATISFIED",
        message: `task ${input.taskId} waits on unpassed checkpoint ${barrier}`,
      };
    }
  }
  return { ok: true };
}

/**
 * Complete a generic execution only when every active task is currently
 * accepted and every assigned review barrier passed for the current contract
 * revision. No final checkpoint is required when none was assigned.
 */
export function completeExecutionInStore(
  data: WorkItemStoreData,
  input: { sessionId: string; runId: string; rationale: string; evidence: string[] },
): CompleteExecutionResult {
  const foundExecution = findExecution(data, input.runId);
  // Mutate a clone so staged transactions and accidental callers never mutate
  // shared live state before the snapshot is persisted.
  const execution = foundExecution ? cloneWorkflowExecution(foundExecution) : undefined;
  if (!execution) {
    return { ok: false, errorCode: "EXECUTION_NOT_FOUND", message: `no execution ${input.runId}` };
  }
  if (execution.sessionId !== input.sessionId) {
    return {
      ok: false,
      errorCode: "SESSION_MISMATCH",
      message: "execution belongs to another session",
    };
  }
  if (execution.state === "sealed") {
    return {
      ok: false,
      errorCode: "EXECUTION_SEALED",
      message: `execution ${input.runId} is sealed`,
    };
  }
  if (typeof input.rationale !== "string" || input.rationale.trim() === "") {
    return {
      ok: false,
      errorCode: "INVALID_INPUT",
      message: "completion requires a non-empty rationale",
    };
  }

  const activeTasks = [...execution.tasks.values()].filter(
    (binding) => binding.status !== "superseded",
  );
  for (const binding of activeTasks) {
    if (!isTaskAccepted(data, execution, binding.taskId)) {
      return {
        ok: false,
        errorCode: "EXECUTION_INCOMPLETE",
        message: `task ${binding.taskId} is not accepted`,
      };
    }
  }

  for (const checkpoint of execution.checkpoints.values()) {
    if (checkpoint.status !== "passed") {
      return {
        ok: false,
        errorCode: "EXECUTION_INCOMPLETE",
        message: `assigned checkpoint ${checkpoint.checkpointId} has not passed`,
      };
    }
  }

  const finalCheckpoints = [...execution.checkpoints.values()].filter(
    (checkpoint) => checkpoint.contract.kind === "final",
  );
  for (const finalCheckpoint of finalCheckpoints) {
    if (finalCheckpoint.passedRevision !== execution.revision) {
      return {
        ok: false,
        errorCode: "EXECUTION_INCOMPLETE",
        message: `final checkpoint ${finalCheckpoint.checkpointId} does not cover the current revision ${execution.revision}`,
      };
    }
    for (const binding of activeTasks) {
      if (!finalCheckpoint.contract.covers.includes(binding.taskId)) {
        return {
          ok: false,
          errorCode: "EXECUTION_INCOMPLETE",
          message: `final checkpoint ${finalCheckpoint.checkpointId} does not cover current task ${binding.taskId}`,
        };
      }
      for (const file of binding.contract.writeScope) {
        if (!finalCheckpoint.contract.scope.includes(file)) {
          return {
            ok: false,
            errorCode: "EXECUTION_INCOMPLETE",
            message: `final checkpoint ${finalCheckpoint.checkpointId} does not cover current scope ${file}`,
          };
        }
      }
    }
  }

  const sealed = sealExecutionInStore(data, { sessionId: input.sessionId, runId: input.runId });
  if (!sealed.ok) return { ok: false, errorCode: sealed.errorCode, message: sealed.message };
  const passedCheckpoints = [...sealed.execution.checkpoints.values()].filter(
    (checkpoint) => checkpoint.status === "passed",
  );
  const activeBindings = [...sealed.execution.tasks.values()].filter(
    (binding) => binding.status !== "superseded",
  );
  // Independent review is claimed only when every active task is covered by a
  // passed checkpoint; mixed or partial coverage is controller-accepted.
  const reviewStatus =
    activeBindings.length > 0 &&
    passedCheckpoints.length > 0 &&
    activeBindings.every((binding) =>
      passedCheckpoints.some((checkpoint) => checkpoint.contract.covers.includes(binding.taskId)),
    )
      ? "independently_reviewed"
      : "controller_accepted";
  return { ok: true, reviewStatus, execution: sealed.execution };
}
// END_BLOCK_GENERIC_REVIEWS

// START_BLOCK_AUTHORITY_PERSISTENCE
function mutateExecution(
  data: WorkItemStoreData,
  sessionId: string,
  runId: string,
  mutate: (
    execution: WorkflowExecutionRecord,
  ) => { ok: true } | { ok: false; errorCode: ExecutionMutationErrorCode; message: string },
):
  | { ok: true; execution: WorkflowExecutionRecord }
  | { ok: false; errorCode: ExecutionMutationErrorCode; message: string } {
  const found = findExecution(data, runId);
  if (!found) {
    return { ok: false, errorCode: "EXECUTION_NOT_FOUND", message: `no execution ${runId}` };
  }
  if (found.sessionId !== sessionId) {
    return {
      ok: false,
      errorCode: "SESSION_MISMATCH",
      message: "execution belongs to another session",
    };
  }
  const execution = cloneWorkflowExecution(found);
  const applied = mutate(execution);
  if (!applied.ok) return applied;
  execution.updatedAt = toIsoNow();
  data.executions.set(execution.runId, execution);
  return { ok: true, execution };
}

/** Persist one advance-authority record and its session-wide message claim atomically. */
export function addAuthorityInStore(
  data: WorkItemStoreData,
  input: {
    sessionId: string;
    runId: string;
    authority: WorkflowAuthorityRecord;
    claim: WorkflowMessageClaim;
  },
):
  | { ok: true; execution: WorkflowExecutionRecord }
  | { ok: false; errorCode: ExecutionMutationErrorCode; message: string } {
  return mutateExecution(data, input.sessionId, input.runId, (execution) => {
    if (execution.authority.some((entry) => entry.authorityId === input.authority.authorityId)) {
      return {
        ok: false,
        errorCode: "DUPLICATE_ID",
        message: `authority ${input.authority.authorityId} already recorded`,
      };
    }
    execution.authority.push(input.authority);
    data.messageClaims.set(input.claim.messageId, input.claim);
    return { ok: true };
  });
}

/** Persist one recorded stage approval on its execution. */
export function addStageApprovalInStore(
  data: WorkItemStoreData,
  input: { sessionId: string; runId: string; approval: WorkflowStageApproval },
):
  | { ok: true; execution: WorkflowExecutionRecord }
  | { ok: false; errorCode: ExecutionMutationErrorCode; message: string } {
  return mutateExecution(data, input.sessionId, input.runId, (execution) => {
    if (execution.stageApprovals.some((entry) => entry.approvalId === input.approval.approvalId)) {
      return {
        ok: false,
        errorCode: "DUPLICATE_ID",
        message: `approval ${input.approval.approvalId} already recorded`,
      };
    }
    execution.stageApprovals.push(input.approval);
    return { ok: true };
  });
}

/** Persist one reserve debit on its execution. */
export function addReserveDebitInStore(
  data: WorkItemStoreData,
  input: { sessionId: string; runId: string; debit: WorkflowReserveDebit },
):
  | { ok: true; execution: WorkflowExecutionRecord }
  | { ok: false; errorCode: ExecutionMutationErrorCode; message: string } {
  return mutateExecution(data, input.sessionId, input.runId, (execution) => {
    if (execution.reserveDebits.some((entry) => entry.recoveryId === input.debit.recoveryId)) {
      return {
        ok: false,
        errorCode: "DUPLICATE_ID",
        message: `reserve debit ${input.debit.recoveryId} already recorded`,
      };
    }
    execution.reserveDebits.push(input.debit);
    return { ok: true };
  });
}

/** Replace or append one authority record, preserving its reserve history. */
export function putAuthorityInStore(
  data: WorkItemStoreData,
  input: { sessionId: string; runId: string; authority: WorkflowAuthorityRecord },
):
  | { ok: true; execution: WorkflowExecutionRecord }
  | { ok: false; errorCode: ExecutionMutationErrorCode; message: string } {
  return mutateExecution(data, input.sessionId, input.runId, (execution) => {
    const index = execution.authority.findIndex(
      (entry) => entry.authorityId === input.authority.authorityId,
    );
    if (index >= 0) {
      execution.authority[index] = input.authority;
    } else {
      execution.authority.push(input.authority);
    }
    return { ok: true };
  });
}
// END_BLOCK_AUTHORITY_PERSISTENCE

// Re-exported helper so review/completion modules can reason about inherited
// budgets without importing delegated.ts directly.
export { delegatedAttemptBudget };
