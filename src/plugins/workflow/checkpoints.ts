// FILE: src/plugins/workflow/checkpoints.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Registered delegated plan runs with declared review checkpoints, generation-bound reviewer linkage, fingerprint-verified outcomes, rework authorization, and bounded checkpoint recovery.
//   SCOPE: Atomic plan-run registration binding canonical task ids to stable delegated work items, idempotent re-registration with explicit drift rejection, checkpoint start with prerequisite acceptance and fresh fingerprints through linked review_only work items, reviewer launch/result recording bound to the current generation, verify deriving passed/failed/stale/stopped outcomes from recorded results plus recomputed fingerprints and approval-input hashes, final complete sealing, failed-checkpoint rework authorization, bounded recovery of stopped or generation-exhausted checkpoints (settling a stopped generation as historical evidence and granting at most one additional generation per autonomous or replay-protected root-user-authorized unit), wave-barrier and overlapping-write gates, and read-only run views exposing generation budgets and supported next actions. No agent dispatch or command execution.
//   DEPENDS: [node:crypto, src/plugins/workflow/checkpoint-io.ts, src/plugins/workflow/delegated.ts, src/plugins/workflow/snapshots.ts, src/plugins/workflow/state.ts]
//   LINKS: [M-WORKFLOW-CHECKPOINTS, M-WORKFLOW-DELEGATED, M-WORKFLOW-SNAPSHOTS, M-WORKFLOW-STATE, M-SPEC-LINT, V-M-WORKFLOW-CHECKPOINTS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   MAX_CHECKPOINT_REVIEW_ATTEMPTS - Maximum ordinary review generations per checkpoint (initial plus one correction).
//   DelegatedReviewerOutcome - One reviewer's recorded outcome inside a generation.
//   DelegatedCheckpointReview - Current in-flight review generation state.
//   DelegatedCheckpointHistoryEntry - One settled generation outcome as historical evidence.
//   DelegatedCheckpointRecoveryRecord - One bounded checkpoint recovery event bound to its settled generation.
//   DelegatedRunCheckpoint - Registered checkpoint runtime state with recovery history.
//   DelegatedRunTask - Canonical task to work-item binding.
//   DelegatedPlanRun - Registered plan-run registry entry.
//   RegisterDelegatedPlanInput - Registration input carrying the loaded approved plan.
//   RegisterDelegatedPlanResult - Registration outcome including idempotent reuse.
//   StartDelegatedCheckpointInput - Checkpoint start input identities.
//   StartDelegatedCheckpointResult - Checkpoint start outcome with launch instructions.
//   RecordReviewerLaunchResult - Reviewer launch binding outcome.
//   RecordReviewerResultResult - Reviewer result recording outcome with round completeness.
//   VerifyDelegatedCheckpointInput - Verify request with optional final complete flag.
//   VerifyDelegatedCheckpointResult - Derived verify outcome and optional sealed completion.
//   AuthorizeReworkInput - Failed-checkpoint rework authorization request.
//   AuthorizeReworkResult - Rework authorization outcome delegating to the guarded reducer.
//   RecoverDelegatedCheckpointInput - Bounded checkpoint recovery request with optional user authorization.
//   RecoverDelegatedCheckpointResult - Checkpoint recovery outcome with generation budget, or a coded rejection.
//   checkpointRecoveryGrantCount - Number of budget-granting checkpoint recovery entries.
//   checkpointGenerationBudget - Allowed generation count given consumed generations and recovery grants.
//   checkpointAutonomousGrantConsumed - Whether the single autonomous checkpoint grant is already recorded.
//   cloneDelegatedPlanRun - Deep clone of one registered run for staged persistence commits.
//   checkpointBarrierUnsatisfied - Unsatisfied barriers blocking a wave's task launches.
//   findOverlappingInFlightReview - In-flight checkpoint scope overlap detection for declared writes.
//   getDelegatedRunView - Read-only run serialization for tooling output.
//   registerDelegatedPlan - Atomically register a validated approved delegated plan.
//   registerDelegatedPlanInStore - Store-level registration used by the plugin and tests.
//   startDelegatedCheckpoint - Start a due checkpoint generation with a fresh fingerprint.
//   startDelegatedCheckpointInStore - Store-level checkpoint start.
//   recordCheckpointReviewerLaunch - Bind one reviewer launch call to the current generation.
//   recordCheckpointReviewerLaunchInStore - Store-level reviewer launch binding.
//   recordCheckpointReviewerResult - Record one reviewer outcome for the current generation.
//   recordCheckpointReviewerResultInStore - Store-level reviewer result recording.
//   verifyDelegatedCheckpoint - Derive the checkpoint outcome from results and fresh fingerprints.
//   verifyDelegatedCheckpointInStore - Store-level verify used by the plugin and tests.
//   authorizeReworkFromFailedCheckpoint - Validate failed-checkpoint rework authorization.
//   authorizeReworkFromFailedCheckpointInStore - Store-level rework authorization.
//   recoverDelegatedCheckpoint - Resume a stopped generation or grant exactly one further generation after exhaustion.
//   recoverDelegatedCheckpointInStore - Store-level guarded checkpoint recovery reducer.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-WORKFLOW-BOUNDED-RECOVERY-R1 - Added bounded checkpoint recovery: stopped generations settle as historical stopped evidence, exhausted checkpoints may grant one further generation per autonomous or root-user-authorized unit, and run views expose generation budgets and next actions.]
// END_CHANGE_SUMMARY

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { DelegatedPlanDefinition, DelegatedReviewer } from "../../lib/spec-lint.js";
import { contentSha256, type LoadedDelegatedPlan } from "./checkpoint-io.js";
import { ensureNativeExecutions } from "./execution.js";
import {
  currentDelegatedAcceptance,
  reworkDelegatedWorkItem,
  validateDelegatedRecoveryInput,
  validateDelegatedWriteScope,
  validateRecoveryUserAuthorization,
  type DelegatedRecoveryKind,
  type LookupRecoveryUserMessage,
} from "./delegated.js";
import { captureWorkflowSnapshot } from "./snapshots.js";
import {
  cloneRecord,
  createRecordLookupKey,
  type WorkItemRecord,
  type WorkItemStore,
  type WorkItemStoreData,
} from "./state.js";

// START_BLOCK_REGISTRY_TYPES
export const MAX_CHECKPOINT_REVIEW_ATTEMPTS = 2;

export interface DelegatedReviewerOutcome {
  status: "PASS" | "FAIL" | "NEEDS_CONTEXT";
  recordedAt: string;
}

export interface DelegatedCheckpointReview {
  reviewWorkItemId: string;
  generation: number;
  startedAt: string;
  startFingerprint: string;
  coveredAttemptIds: string[];
  reviewerCallIds: Partial<Record<DelegatedReviewer, string>>;
  results: Partial<Record<DelegatedReviewer, DelegatedReviewerOutcome>>;
}

export interface DelegatedCheckpointHistoryEntry {
  generation: number;
  outcome: "passed" | "failed" | "stale" | "stopped";
  fingerprint: string;
  completedAt: string;
}

/**
 * One bounded checkpoint recovery event. `resume` settles a stopped
 * generation without manufacturing budget; grant kinds add exactly one
 * generation each and stay replay-protected by recoveryId and userMessageId.
 */
export interface DelegatedCheckpointRecoveryRecord {
  recoveryId: string;
  targetGeneration: number;
  kind: DelegatedRecoveryKind;
  diagnosis: string;
  changedCondition: string;
  verification: string[];
  recoveredAt: string;
  userMessageId?: string;
}

export interface DelegatedRunCheckpoint {
  checkpointId: string;
  kind: "milestone" | "final";
  afterWave: string;
  covers: string[];
  scope: string[];
  reviewers: DelegatedReviewer[];
  status: "pending" | "in_review" | "passed" | "failed";
  attempts: number;
  lastOutcome?: "passed" | "failed" | "stale" | "stopped" | "incomplete";
  currentReview?: DelegatedCheckpointReview;
  history: DelegatedCheckpointHistoryEntry[];
  recoveryHistory: DelegatedCheckpointRecoveryRecord[];
}

export interface DelegatedRunTask {
  taskId: string;
  workItemId: string;
}

export interface DelegatedPlanRun {
  runId: string;
  sessionId: string;
  planPath: string;
  specPath: string;
  workspaceRoot: string;
  planSha256: string;
  specSha256: string;
  definition: DelegatedPlanDefinition;
  registeredAt: string;
  status: "active" | "sealed";
  sealedAt?: string;
  finalCheckpointId?: string;
  tasks: Map<string, DelegatedRunTask>;
  checkpoints: Map<string, DelegatedRunCheckpoint>;
}
// END_BLOCK_REGISTRY_TYPES

// START_BLOCK_REGISTRY_HELPERS
function toIsoNow(): string {
  return new Date().toISOString();
}

function findRun(data: WorkItemStoreData, runId: string): DelegatedPlanRun | undefined {
  return data.planRuns.get(runId);
}

function findRecord(
  data: WorkItemStoreData,
  sessionId: string,
  workItemId: string,
): WorkItemRecord | undefined {
  return data.records.get(createRecordLookupKey(sessionId, workItemId));
}

function runIdFor(plan: LoadedDelegatedPlan): string {
  return `run-${createHash("sha256")
    .update(`${plan.planPath}\n${plan.planSha256}\n${plan.specSha256}`)
    .digest("hex")
    .slice(0, 16)}`;
}

function definitionsEqual(left: DelegatedPlanDefinition, right: DelegatedPlanDefinition): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cloneCheckpoint(checkpoint: DelegatedRunCheckpoint): DelegatedRunCheckpoint {
  return {
    ...checkpoint,
    covers: [...checkpoint.covers],
    scope: [...checkpoint.scope],
    reviewers: [...checkpoint.reviewers],
    history: checkpoint.history.map((entry) => ({ ...entry })),
    recoveryHistory: checkpoint.recoveryHistory.map((recovery) => ({
      ...recovery,
      verification: [...recovery.verification],
    })),
    ...(checkpoint.currentReview
      ? {
          currentReview: {
            ...checkpoint.currentReview,
            coveredAttemptIds: [...checkpoint.currentReview.coveredAttemptIds],
            reviewerCallIds: { ...checkpoint.currentReview.reviewerCallIds },
            results: { ...checkpoint.currentReview.results },
          },
        }
      : {}),
  };
}

/** Deep clone of one registered run for staged persistence commits. */
export function cloneDelegatedPlanRun(run: DelegatedPlanRun): DelegatedPlanRun {
  return cloneRun(run);
}

function cloneRun(run: DelegatedPlanRun): DelegatedPlanRun {
  return {
    ...run,
    tasks: new Map([...run.tasks].map(([taskId, task]) => [taskId, { ...task }])),
    checkpoints: new Map(
      [...run.checkpoints].map(([id, checkpoint]) => [id, cloneCheckpoint(checkpoint)]),
    ),
  };
}

/** Count of budget-granting checkpoint recovery entries. */
export function checkpointRecoveryGrantCount(
  history: readonly DelegatedCheckpointRecoveryRecord[],
): number {
  return history.filter((entry) => entry.kind === "autonomous_grant" || entry.kind === "user_grant")
    .length;
}

/** Allowed generation count: the ordinary maximum plus one per recovery grant. */
export function checkpointGenerationBudget(checkpoint: DelegatedRunCheckpoint): number {
  return MAX_CHECKPOINT_REVIEW_ATTEMPTS + checkpointRecoveryGrantCount(checkpoint.recoveryHistory);
}

/** Whether the single autonomous checkpoint grant is already recorded. */
export function checkpointAutonomousGrantConsumed(
  history: readonly DelegatedCheckpointRecoveryRecord[],
): boolean {
  return history.some((entry) => entry.kind === "autonomous_grant");
}

function waveIndexOf(run: DelegatedPlanRun, wave: string): number {
  return run.definition.waves.indexOf(wave);
}

/** Covered-attempt identities for the currently accepted attempts of covered tasks. */
function currentCoveredAttemptIds(
  data: WorkItemStoreData,
  run: DelegatedPlanRun,
  checkpoint: DelegatedRunCheckpoint,
): { ok: true; ids: string[] } | { ok: false; taskId: string } {
  const ids: string[] = [];
  for (const taskId of checkpoint.covers) {
    const task = run.tasks.get(taskId);
    if (!task) return { ok: false, taskId };
    const record = findRecord(data, run.sessionId, task.workItemId);
    const acceptance = record ? currentDelegatedAcceptance(record) : undefined;
    if (!acceptance) return { ok: false, taskId };
    ids.push(`${task.workItemId}#${acceptance.attempt}`);
  }
  return { ok: true, ids };
}
// END_BLOCK_REGISTRY_HELPERS

export type RegisterDelegatedPlanResult =
  | { ok: true; runId: string; reused: boolean; run: DelegatedPlanRun }
  | {
      ok: false;
      errorCode: "INVALID_INPUT" | "PLAN_DRIFT" | "TASK_BINDING_FAILED" | "SESSION_MISMATCH";
      message: string;
    };

export interface RegisterDelegatedPlanInput {
  sessionId: string;
  plan: LoadedDelegatedPlan;
}

// START_CONTRACT: registerDelegatedPlan
//   PURPOSE: Atomically register all declared tasks and checkpoints of a validated approved delegated plan without launching agents.
//   INPUTS: { store: WorkItemStore - backing store, input: RegisterDelegatedPlanInput - session and loaded approved plan }
//   OUTPUTS: { RegisterDelegatedPlanResult - created or idempotently reused run, or an explicit drift/binding rejection }
//   SIDE_EFFECTS: [Creates the registry entry and bound delegated work items; rolls back created items on failure]
//   LINKS: [M-WORKFLOW-CHECKPOINTS, M-WORKFLOW-DELEGATED, loadApprovedDelegatedPlan]
// END_CONTRACT: registerDelegatedPlan
export function registerDelegatedPlan(
  store: WorkItemStore,
  input: RegisterDelegatedPlanInput,
): RegisterDelegatedPlanResult {
  const result = registerDelegatedPlanInStore(store.getStoreData(), input);
  if (result.ok) {
    // Materialize the common execution registry view for existing native
    // consumers without altering native counters, hashes, or obligations.
    ensureNativeExecutions(store.getStoreData());
  }
  return result;
}

export function registerDelegatedPlanInStore(
  data: WorkItemStoreData,
  input: RegisterDelegatedPlanInput,
): RegisterDelegatedPlanResult {
  if (typeof input.sessionId !== "string" || input.sessionId.trim() === "") {
    return {
      ok: false,
      errorCode: "INVALID_INPUT",
      message: "sessionId must be a non-empty string",
    };
  }

  const runId = runIdFor(input.plan);
  const existing = findRun(data, runId);
  if (existing) {
    if (existing.sessionId !== input.sessionId) {
      return {
        ok: false,
        errorCode: "SESSION_MISMATCH",
        message: `run ${runId} belongs to session ${existing.sessionId}`,
      };
    }
    const identical =
      existing.planPath === input.plan.planPath &&
      existing.specPath === input.plan.specPath &&
      existing.workspaceRoot === input.plan.workspaceRoot &&
      existing.planSha256 === input.plan.planSha256 &&
      existing.specSha256 === input.plan.specSha256 &&
      definitionsEqual(existing.definition, input.plan.definition);
    if (!identical) {
      return {
        ok: false,
        errorCode: "PLAN_DRIFT",
        message: `run ${runId} was registered from different approved inputs; supersede or replan instead of resetting progress`,
      };
    }
    return { ok: true, runId, reused: true, run: cloneRun(existing) };
  }

  const samePlanPath = [...data.planRuns.values()].find(
    (run) => run.planPath === input.plan.planPath && run.sessionId === input.sessionId,
  );
  if (samePlanPath) {
    return {
      ok: false,
      errorCode: "PLAN_DRIFT",
      message: `plan ${input.plan.planPath} is already registered as run ${samePlanPath.runId} with different content; explicit plan amendment is required`,
    };
  }

  // Stage all bound delegated work items before committing the registry entry.
  // Write scopes are validated with the same normalizer the runtime snapshots
  // use, so a plan that reaches registration can never declare a scope the
  // snapshot normalizer or the persistence validator would reject later.
  const createdWorkItemIds: string[] = [];
  const tasks = new Map<string, DelegatedRunTask>();
  for (const task of input.plan.definition.tasks) {
    const key = `delegated-${runId}-${task.taskId}`;
    const scopeValidation = validateDelegatedWriteScope(task.writeScope);
    if (!scopeValidation.ok) {
      rollbackCreatedItems(data, input.sessionId, createdWorkItemIds);
      return {
        ok: false,
        errorCode: "TASK_BINDING_FAILED",
        message: `binding task ${task.taskId} failed: write scope rejected (${scopeValidation.message ?? "invalid scope"})`,
      };
    }
    const opened = openInStore(data, {
      sessionId: input.sessionId,
      key,
      title: `Delegated ${task.taskId}: ${task.taskElement}`,
      mode: "delegated",
      requiredReviewers: [],
      writeScope: scopeValidation.paths ?? [],
      planRunId: runId,
      planTaskId: task.taskId,
    });
    if (!opened || !opened.ok) {
      rollbackCreatedItems(data, input.sessionId, createdWorkItemIds);
      return {
        ok: false,
        errorCode: "TASK_BINDING_FAILED",
        message: `binding task ${task.taskId} failed: ${opened && !opened.ok ? opened.message : "unknown"}`,
      };
    }
    createdWorkItemIds.push(opened.record.workItemId);
    tasks.set(task.taskId, { taskId: task.taskId, workItemId: opened.record.workItemId });
  }

  const checkpoints = new Map<string, DelegatedRunCheckpoint>();
  for (const checkpoint of input.plan.definition.checkpoints) {
    checkpoints.set(checkpoint.checkpointId, {
      checkpointId: checkpoint.checkpointId,
      kind: checkpoint.kind,
      afterWave: checkpoint.afterWave,
      covers: [...checkpoint.covers],
      scope: [...checkpoint.scope],
      reviewers: [...checkpoint.reviewers],
      status: "pending",
      attempts: 0,
      history: [],
      recoveryHistory: [],
    });
  }

  const finalCheckpoint = input.plan.definition.checkpoints.find((c) => c.kind === "final");

  const run: DelegatedPlanRun = {
    runId,
    sessionId: input.sessionId,
    planPath: input.plan.planPath,
    specPath: input.plan.specPath,
    workspaceRoot: input.plan.workspaceRoot,
    planSha256: input.plan.planSha256,
    specSha256: input.plan.specSha256,
    definition: input.plan.definition,
    registeredAt: toIsoNow(),
    status: "active",
    ...(finalCheckpoint ? { finalCheckpointId: finalCheckpoint.checkpointId } : {}),
    tasks,
    checkpoints,
  };
  data.planRuns.set(runId, run);

  return { ok: true, runId, reused: false, run: cloneRun(run) };
}

function openInStore(
  data: WorkItemStoreData,
  input: Parameters<WorkItemStore["openWorkItem"]>[0],
): ReturnType<WorkItemStore["openWorkItem"]> {
  const sessionIndex =
    data.keyIndexBySession.get(input.sessionId) ??
    (() => {
      const index = new Map<string, string>();
      data.keyIndexBySession.set(input.sessionId, index);
      return index;
    })();

  const existingId = sessionIndex.get(input.key);
  if (existingId) {
    const existing = data.records.get(createRecordLookupKey(input.sessionId, existingId));
    if (existing) {
      const sameIntent =
        existing.title === input.title &&
        existing.mode === input.mode &&
        existing.delegated?.planRunId === input.planRunId &&
        existing.delegated?.planTaskId === input.planTaskId &&
        JSON.stringify(existing.delegated?.writeScope ?? []) ===
          JSON.stringify([...(input.writeScope ?? [])]);
      if (!sameIntent) {
        return {
          ok: false,
          errorCode: "WORK_ITEM_KEY_CONFLICT",
          message: `WORK_ITEM_KEY_CONFLICT: key ${input.key} is already associated with different workflow intent`,
          existingWorkItemId: existing.workItemId,
        };
      }
      return {
        ok: true,
        reused: true,
        record: cloneRecord(existing),
        header: `VVOC_WORK_ITEM_ID: ${existing.workItemId}`,
      };
    }
    sessionIndex.delete(input.key);
  }

  const workItemId = `wi-${data.nextId}`;
  data.nextId += 1;
  const now = toIsoNow();
  const record: WorkItemRecord = {
    sessionId: input.sessionId,
    workItemId,
    key: input.key,
    title: input.title,
    mode: input.mode,
    requiredReviewers: [],
    state: "open",
    delegated: {
      writeScope: [...(input.writeScope ?? [])],
      ...(input.planRunId && input.planTaskId
        ? { planRunId: input.planRunId, planTaskId: input.planTaskId }
        : {}),
      attempts: [],
      decisions: [],
      acceptances: [],
      reworkHistory: [],
      recoveryHistory: [],
    },
    completedReviewRoundCount: 0,
    specReviewCount: 0,
    codeReviewCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  sessionIndex.set(input.key, workItemId);
  data.records.set(createRecordLookupKey(input.sessionId, workItemId), record);
  return {
    ok: true,
    reused: false,
    record: cloneRecord(record),
    header: `VVOC_WORK_ITEM_ID: ${workItemId}`,
  };
}

function rollbackCreatedItems(
  data: WorkItemStoreData,
  sessionId: string,
  workItemIds: string[],
): void {
  for (const workItemId of workItemIds) {
    const record = data.records.get(createRecordLookupKey(sessionId, workItemId));
    if (!record) continue;
    if (record.state !== "open") continue; // never roll back items that progressed
    data.records.delete(createRecordLookupKey(sessionId, workItemId));
    const sessionIndex = data.keyIndexBySession.get(sessionId);
    if (sessionIndex?.get(record.key) === workItemId) {
      sessionIndex.delete(record.key);
    }
  }
}

export type StartDelegatedCheckpointResult =
  | {
      ok: true;
      checkpoint: DelegatedRunCheckpoint;
      reviewWorkItemId: string;
      header: string;
      reviewersToLaunch: DelegatedReviewer[];
      generation: number;
    }
  | {
      ok: false;
      errorCode:
        | "RUN_NOT_FOUND"
        | "SESSION_MISMATCH"
        | "CHECKPOINT_NOT_FOUND"
        | "RUN_SEALED"
        | "ALREADY_PASSED"
        | "ALREADY_IN_REVIEW"
        | "ATTEMPTS_EXHAUSTED"
        | "PREREQUISITES_NOT_ACCEPTED"
        | "OVERLAPPING_SCOPE"
        | "SNAPSHOT_FAILED";
      message: string;
    };

export interface StartDelegatedCheckpointInput {
  sessionId: string;
  runId: string;
  checkpointId: string;
}

// START_CONTRACT: startDelegatedCheckpoint
//   PURPOSE: Start a due checkpoint generation after prerequisite acceptance, capturing a fresh scope fingerprint and opening the declared reviewer set.
//   INPUTS: { store: WorkItemStore - backing store, input: StartDelegatedCheckpointInput - session, run, and checkpoint identity }
//   OUTPUTS: { StartDelegatedCheckpointResult - launch instructions for the linked review_only item or a coded rejection }
//   SIDE_EFFECTS: [Mutates checkpoint state and creates the linked review_only work item]
//   LINKS: [M-WORKFLOW-CHECKPOINTS, M-WORKFLOW-STATE, captureWorkflowSnapshot]
// END_CONTRACT: startDelegatedCheckpoint
export async function startDelegatedCheckpoint(
  store: WorkItemStore,
  input: StartDelegatedCheckpointInput,
): Promise<StartDelegatedCheckpointResult> {
  return startDelegatedCheckpointInStore(store.getStoreData(), input);
}

export async function startDelegatedCheckpointInStore(
  data: WorkItemStoreData,
  input: StartDelegatedCheckpointInput,
): Promise<StartDelegatedCheckpointResult> {
  const run = findRun(data, input.runId);
  if (!run) {
    return { ok: false, errorCode: "RUN_NOT_FOUND", message: `RUN_NOT_FOUND: ${input.runId}` };
  }
  if (run.sessionId !== input.sessionId) {
    return {
      ok: false,
      errorCode: "SESSION_MISMATCH",
      message: `SESSION_MISMATCH: run ${input.runId} belongs to session ${run.sessionId}`,
    };
  }
  if (run.status === "sealed") {
    return {
      ok: false,
      errorCode: "RUN_SEALED",
      message: `RUN_SEALED: run ${input.runId} is complete`,
    };
  }

  const checkpoint = run.checkpoints.get(input.checkpointId);
  if (!checkpoint) {
    return {
      ok: false,
      errorCode: "CHECKPOINT_NOT_FOUND",
      message: `CHECKPOINT_NOT_FOUND: ${input.checkpointId} is not declared in run ${input.runId}`,
    };
  }
  if (checkpoint.status === "passed") {
    return {
      ok: false,
      errorCode: "ALREADY_PASSED",
      message: `ALREADY_PASSED: ${input.checkpointId} passed at generation ${checkpoint.attempts}`,
    };
  }
  if (checkpoint.status === "in_review") {
    return {
      ok: false,
      errorCode: "ALREADY_IN_REVIEW",
      message: `ALREADY_IN_REVIEW: ${input.checkpointId} generation ${checkpoint.currentReview?.generation} is in flight`,
    };
  }
  if (checkpoint.attempts >= checkpointGenerationBudget(checkpoint)) {
    return {
      ok: false,
      errorCode: "ATTEMPTS_EXHAUSTED",
      message: `ATTEMPTS_EXHAUSTED: ${input.checkpointId} consumed ${checkpoint.attempts} of ${checkpointGenerationBudget(checkpoint)} allowed review generations; explicit recovery is required`,
    };
  }

  const covered = currentCoveredAttemptIds(data, run, checkpoint);
  if (!covered.ok) {
    return {
      ok: false,
      errorCode: "PREREQUISITES_NOT_ACCEPTED",
      message: `PREREQUISITES_NOT_ACCEPTED: covered task ${covered.taskId} has no currently accepted attempt`,
    };
  }

  const overlapping = [...run.checkpoints.values()].find(
    (other) =>
      other.checkpointId !== checkpoint.checkpointId &&
      other.status === "in_review" &&
      other.scope.some((file) => checkpoint.scope.includes(file)),
  );
  if (overlapping) {
    return {
      ok: false,
      errorCode: "OVERLAPPING_SCOPE",
      message: `OVERLAPPING_SCOPE: checkpoint ${overlapping.checkpointId} is in review and shares declared scope files`,
    };
  }

  const snapshot = await captureWorkflowSnapshot({
    workspaceRoot: run.workspaceRoot,
    declaredPaths: checkpoint.scope,
    coveredAttemptIds: covered.ids,
  });
  if (!snapshot.ok) {
    return {
      ok: false,
      errorCode: "SNAPSHOT_FAILED",
      message: `SNAPSHOT_FAILED: ${snapshot.message}`,
    };
  }

  const generation = checkpoint.attempts + 1;
  const now = toIsoNow();
  const reviewKey = `checkpoint-${input.runId}-${input.checkpointId}-g${generation}`;
  const reviewItem = openReviewItem(data, run.sessionId, reviewKey, checkpoint.reviewers);
  if (!reviewItem.ok) {
    return {
      ok: false,
      errorCode: "SNAPSHOT_FAILED",
      message: `failed to open linked review item: ${reviewItem.message}`,
    };
  }

  const updated: DelegatedRunCheckpoint = {
    ...checkpoint,
    status: "in_review",
    attempts: generation,
    lastOutcome: undefined,
    currentReview: {
      reviewWorkItemId: reviewItem.record.workItemId,
      generation,
      startedAt: now,
      startFingerprint: snapshot.snapshot.fingerprint,
      coveredAttemptIds: covered.ids,
      reviewerCallIds: {},
      results: {},
    },
  };
  run.checkpoints.set(input.checkpointId, updated);

  return {
    ok: true,
    checkpoint: cloneCheckpoint(updated),
    reviewWorkItemId: reviewItem.record.workItemId,
    header: reviewItem.header,
    reviewersToLaunch: [...updated.reviewers],
    generation,
  };
}

function openReviewItem(
  data: WorkItemStoreData,
  sessionId: string,
  key: string,
  reviewers: DelegatedReviewer[],
): { ok: true; record: WorkItemRecord; header: string } | { ok: false; message: string } {
  const sessionIndex =
    data.keyIndexBySession.get(sessionId) ??
    (() => {
      const index = new Map<string, string>();
      data.keyIndexBySession.set(sessionId, index);
      return index;
    })();

  const existingId = sessionIndex.get(key);
  if (existingId) {
    const existing = data.records.get(createRecordLookupKey(sessionId, existingId));
    if (existing) {
      return {
        ok: true,
        record: cloneRecord(existing),
        header: `VVOC_WORK_ITEM_ID: ${existing.workItemId}`,
      };
    }
    sessionIndex.delete(key);
  }

  const workItemId = `wi-${data.nextId}`;
  data.nextId += 1;
  const now = toIsoNow();
  const sortedReviewers = [...reviewers].sort((left, right) =>
    left === right ? 0 : left === "spec" ? -1 : 1,
  );
  const record: WorkItemRecord = {
    sessionId,
    workItemId,
    key,
    title: `Checkpoint review ${key}`,
    mode: "review_only",
    requiredReviewers: sortedReviewers,
    state: "awaiting_reviews",
    currentRound: {
      round: 1,
      requiredReviewers: sortedReviewers,
      pendingReviewers: sortedReviewers,
      inFlightReviewers: [],
      completedReviewers: [],
      results: {},
      status: "active",
      createdAt: now,
    },
    completedReviewRoundCount: 0,
    specReviewCount: 0,
    codeReviewCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  sessionIndex.set(key, workItemId);
  data.records.set(createRecordLookupKey(sessionId, workItemId), record);
  return { ok: true, record: cloneRecord(record), header: `VVOC_WORK_ITEM_ID: ${workItemId}` };
}

export type RecordReviewerLaunchResult =
  | { ok: true }
  | {
      ok: false;
      errorCode:
        | "RUN_NOT_FOUND"
        | "CHECKPOINT_NOT_FOUND"
        | "NOT_IN_REVIEW"
        | "REVIEWER_NOT_DECLARED"
        | "ALREADY_LAUNCHED"
        | "ALREADY_RECORDED";
      message: string;
    };

export type RecordReviewerResultResult =
  | { ok: true; roundComplete: boolean }
  | {
      ok: false;
      errorCode:
        | "RUN_NOT_FOUND"
        | "CHECKPOINT_NOT_FOUND"
        | "NOT_IN_REVIEW"
        | "REVIEWER_NOT_DECLARED"
        | "CALLBACK_MISMATCH"
        | "ALREADY_RECORDED";
      message: string;
    };

function resolveActiveReview(
  data: WorkItemStoreData,
  runId: string,
  checkpointId: string,
):
  | {
      ok: true;
      run: DelegatedPlanRun;
      checkpoint: DelegatedRunCheckpoint;
      review: DelegatedCheckpointReview;
    }
  | {
      ok: false;
      errorCode: "RUN_NOT_FOUND" | "CHECKPOINT_NOT_FOUND" | "NOT_IN_REVIEW";
      message: string;
    } {
  const run = findRun(data, runId);
  if (!run) {
    return { ok: false, errorCode: "RUN_NOT_FOUND", message: `RUN_NOT_FOUND: ${runId}` };
  }
  const checkpoint = run.checkpoints.get(checkpointId);
  if (!checkpoint) {
    return {
      ok: false,
      errorCode: "CHECKPOINT_NOT_FOUND",
      message: `CHECKPOINT_NOT_FOUND: ${checkpointId}`,
    };
  }
  if (checkpoint.status !== "in_review" || !checkpoint.currentReview) {
    return {
      ok: false,
      errorCode: "NOT_IN_REVIEW",
      message: `NOT_IN_REVIEW: ${checkpointId} is ${checkpoint.status}`,
    };
  }
  return { ok: true, run, checkpoint, review: checkpoint.currentReview };
}

// START_CONTRACT: recordCheckpointReviewerLaunch
//   PURPOSE: Bind one reviewer launch call identity to the current checkpoint generation.
//   INPUTS: { store: WorkItemStore - backing store, input: { runId, checkpointId, reviewer, callId } }
//   OUTPUTS: { RecordReviewerLaunchResult - binding outcome }
//   SIDE_EFFECTS: [Mutates the current generation's reviewer call map]
//   LINKS: [M-WORKFLOW-CHECKPOINTS, M-PLUGIN-WORKFLOW]
// END_CONTRACT: recordCheckpointReviewerLaunch
export function recordCheckpointReviewerLaunch(
  store: WorkItemStore,
  input: { runId: string; checkpointId: string; reviewer: DelegatedReviewer; callId: string },
): RecordReviewerLaunchResult {
  return recordCheckpointReviewerLaunchInStore(store.getStoreData(), input);
}

export function recordCheckpointReviewerLaunchInStore(
  data: WorkItemStoreData,
  input: { runId: string; checkpointId: string; reviewer: DelegatedReviewer; callId: string },
): RecordReviewerLaunchResult {
  const active = resolveActiveReview(data, input.runId, input.checkpointId);
  if (!active.ok) return active;
  if (!active.checkpoint.reviewers.includes(input.reviewer)) {
    return {
      ok: false,
      errorCode: "REVIEWER_NOT_DECLARED",
      message: `REVIEWER_NOT_DECLARED: ${input.reviewer} is not declared for ${input.checkpointId}`,
    };
  }
  if (active.review.reviewerCallIds[input.reviewer]) {
    return {
      ok: false,
      errorCode: "ALREADY_LAUNCHED",
      message: `ALREADY_LAUNCHED: ${input.reviewer} already launched for generation ${active.review.generation}`,
    };
  }
  if (active.review.results[input.reviewer]) {
    return {
      ok: false,
      errorCode: "ALREADY_RECORDED",
      message: `ALREADY_RECORDED: ${input.reviewer} already recorded a result`,
    };
  }
  const callId = input.callId?.trim() ?? "";
  if (!callId) {
    return {
      ok: false,
      errorCode: "REVIEWER_NOT_DECLARED",
      message: "callId must be a non-empty string",
    };
  }
  active.review.reviewerCallIds[input.reviewer] = callId;
  return { ok: true };
}

// START_CONTRACT: recordCheckpointReviewerResult
//   PURPOSE: Record one reviewer outcome for the current generation, rejecting stale or mismatched callbacks.
//   INPUTS: { store: WorkItemStore - backing store, input: { runId, checkpointId, reviewer, callId, status } }
//   OUTPUTS: { RecordReviewerResultResult - recording outcome and round completeness }
//   SIDE_EFFECTS: [Mutates the current generation's recorded results]
//   LINKS: [M-WORKFLOW-CHECKPOINTS, M-PLUGIN-WORKFLOW]
// END_CONTRACT: recordCheckpointReviewerResult
export function recordCheckpointReviewerResult(
  store: WorkItemStore,
  input: {
    runId: string;
    checkpointId: string;
    reviewer: DelegatedReviewer;
    callId?: string;
    status: "PASS" | "FAIL" | "NEEDS_CONTEXT";
  },
): RecordReviewerResultResult {
  return recordCheckpointReviewerResultInStore(store.getStoreData(), input);
}

export function recordCheckpointReviewerResultInStore(
  data: WorkItemStoreData,
  input: {
    runId: string;
    checkpointId: string;
    reviewer: DelegatedReviewer;
    callId?: string;
    status: "PASS" | "FAIL" | "NEEDS_CONTEXT";
  },
): RecordReviewerResultResult {
  const active = resolveActiveReview(data, input.runId, input.checkpointId);
  if (!active.ok) return active;
  if (!active.checkpoint.reviewers.includes(input.reviewer)) {
    return {
      ok: false,
      errorCode: "REVIEWER_NOT_DECLARED",
      message: `REVIEWER_NOT_DECLARED: ${input.reviewer} is not declared for ${input.checkpointId}`,
    };
  }
  if (active.review.results[input.reviewer]) {
    return {
      ok: false,
      errorCode: "ALREADY_RECORDED",
      message: `ALREADY_RECORDED: ${input.reviewer} already recorded a result for generation ${active.review.generation}`,
    };
  }
  const boundCallId = active.review.reviewerCallIds[input.reviewer];
  if (boundCallId && input.callId !== boundCallId) {
    return {
      ok: false,
      errorCode: "CALLBACK_MISMATCH",
      message: `CALLBACK_MISMATCH: ${input.reviewer} result call ${String(input.callId)} does not match launch call ${boundCallId}`,
    };
  }

  active.review.results[input.reviewer] = {
    status: input.status,
    recordedAt: toIsoNow(),
  };

  const roundComplete = active.checkpoint.reviewers.every(
    (reviewer) => active.review.results[reviewer] !== undefined,
  );
  return { ok: true, roundComplete };
}

export type VerifyDelegatedCheckpointResult =
  | {
      ok: true;
      checkpoint: DelegatedRunCheckpoint;
      outcome: "passed" | "failed" | "stale" | "stopped" | "incomplete" | "already-passed";
      snapshotCurrent: boolean;
      sealedRun?: boolean;
    }
  | {
      ok: false;
      errorCode:
        | "RUN_NOT_FOUND"
        | "CHECKPOINT_NOT_FOUND"
        | "FINAL_COMPLETE_ON_NON_FINAL"
        | "COMPLETE_REQUIREMENTS_UNMET"
        | "PLAN_DRIFT"
        | "SNAPSHOT_FAILED";
      message: string;
    };

export interface VerifyDelegatedCheckpointInput {
  sessionId: string;
  runId: string;
  checkpointId: string;
  /** Only permitted for the final checkpoint; seals the run when every completion condition passes. */
  complete?: boolean;
}

async function approvalInputsCurrent(run: DelegatedPlanRun): Promise<boolean> {
  try {
    const planContent = await readFile(run.planPath, "utf8");
    const specContent = await readFile(run.specPath, "utf8");
    return (
      contentSha256(planContent) === run.planSha256 && contentSha256(specContent) === run.specSha256
    );
  } catch {
    return false;
  }
}

// START_CONTRACT: verifyDelegatedCheckpoint
//   PURPOSE: Derive the checkpoint outcome from recorded reviewer results and freshly recomputed fingerprints and approval-input hashes.
//   INPUTS: { store: WorkItemStore - backing store, input: VerifyDelegatedCheckpointInput - verify request with optional final complete }
//   OUTPUTS: { VerifyDelegatedCheckpointResult - derived outcome and optional sealed completion, or a coded rejection }
//   SIDE_EFFECTS: [Settles generations and seals completed runs; read-only for already-passed checkpoints]
//   LINKS: [M-WORKFLOW-CHECKPOINTS, M-WORKFLOW-SNAPSHOTS, captureWorkflowSnapshot]
// END_CONTRACT: verifyDelegatedCheckpoint
export async function verifyDelegatedCheckpoint(
  store: WorkItemStore,
  input: VerifyDelegatedCheckpointInput,
): Promise<VerifyDelegatedCheckpointResult> {
  return verifyDelegatedCheckpointInStore(store.getStoreData(), input);
}

export async function verifyDelegatedCheckpointInStore(
  data: WorkItemStoreData,
  input: VerifyDelegatedCheckpointInput,
): Promise<VerifyDelegatedCheckpointResult> {
  const run = findRun(data, input.runId);
  if (!run) {
    return { ok: false, errorCode: "RUN_NOT_FOUND", message: `RUN_NOT_FOUND: ${input.runId}` };
  }
  const checkpoint = run.checkpoints.get(input.checkpointId);
  if (!checkpoint) {
    return {
      ok: false,
      errorCode: "CHECKPOINT_NOT_FOUND",
      message: `CHECKPOINT_NOT_FOUND: ${input.checkpointId}`,
    };
  }

  if (input.complete === true && checkpoint.kind !== "final") {
    return {
      ok: false,
      errorCode: "FINAL_COMPLETE_ON_NON_FINAL",
      message: `FINAL_COMPLETE_ON_NON_FINAL: complete is only permitted for the final checkpoint, not ${input.checkpointId}`,
    };
  }

  // Historical milestones stay passed; rechecking only reports snapshot currency.
  // A passed FINAL checkpoint may still seal its run through an explicit
  // complete request, provided completion conditions and approval inputs are
  // freshly satisfied (bounded rework stays possible before this succeeds).
  if (checkpoint.status === "passed") {
    if (input.complete === true) {
      if (checkpoint.kind !== "final") {
        return {
          ok: false,
          errorCode: "FINAL_COMPLETE_ON_NON_FINAL",
          message: `FINAL_COMPLETE_ON_NON_FINAL: complete is only permitted for the final checkpoint, not ${input.checkpointId}`,
        };
      }
      if (!(await approvalInputsCurrent(run))) {
        return {
          ok: false,
          errorCode: "PLAN_DRIFT",
          message: `PLAN_DRIFT: approved plan or spec content changed after registration of run ${input.runId}`,
        };
      }
      const coveredForCompletion = currentCoveredAttemptIds(data, run, checkpoint);
      if (!coveredForCompletion.ok) {
        return {
          ok: false,
          errorCode: "COMPLETE_REQUIREMENTS_UNMET",
          message: `COMPLETE_REQUIREMENTS_UNMET: covered task ${coveredForCompletion.taskId} lost its current acceptance`,
        };
      }
      const completion = evaluateRunCompletion(data, run, checkpoint);
      if (!completion.ok) {
        return { ok: false, errorCode: "COMPLETE_REQUIREMENTS_UNMET", message: completion.message };
      }
      run.status = "sealed";
      run.sealedAt = toIsoNow();
      return {
        ok: true,
        checkpoint: cloneCheckpoint(checkpoint),
        outcome: "passed",
        snapshotCurrent: true,
        sealedRun: true,
      };
    }
    const covered = currentCoveredAttemptIds(data, run, checkpoint);
    const coveredIds = covered.ok ? covered.ids : [];
    const snapshot = await captureWorkflowSnapshot({
      workspaceRoot: run.workspaceRoot,
      declaredPaths: checkpoint.scope,
      coveredAttemptIds: coveredIds,
    });
    if (!snapshot.ok) {
      return {
        ok: false,
        errorCode: "SNAPSHOT_FAILED",
        message: `SNAPSHOT_FAILED: ${snapshot.message}`,
      };
    }
    const historicalFingerprint = checkpoint.history[checkpoint.history.length - 1]?.fingerprint;
    return {
      ok: true,
      checkpoint: cloneCheckpoint(checkpoint),
      outcome: "already-passed",
      snapshotCurrent: snapshot.snapshot.fingerprint === historicalFingerprint,
    };
  }

  if (checkpoint.status !== "in_review" || !checkpoint.currentReview) {
    return {
      ok: false,
      errorCode: "COMPLETE_REQUIREMENTS_UNMET",
      message: `COMPLETE_REQUIREMENTS_UNMET: ${input.checkpointId} is ${checkpoint.status}; start it before verifying`,
    };
  }

  const review = checkpoint.currentReview;

  if (!(await approvalInputsCurrent(run))) {
    return {
      ok: false,
      errorCode: "PLAN_DRIFT",
      message: `PLAN_DRIFT: approved plan or spec content changed after registration of run ${input.runId}`,
    };
  }

  const covered = currentCoveredAttemptIds(data, run, checkpoint);
  if (!covered.ok) {
    return {
      ok: false,
      errorCode: "COMPLETE_REQUIREMENTS_UNMET",
      message: `COMPLETE_REQUIREMENTS_UNMET: covered task ${covered.taskId} lost its current acceptance`,
    };
  }

  const snapshot = await captureWorkflowSnapshot({
    workspaceRoot: run.workspaceRoot,
    declaredPaths: checkpoint.scope,
    coveredAttemptIds: covered.ids,
  });
  if (!snapshot.ok) {
    return {
      ok: false,
      errorCode: "SNAPSHOT_FAILED",
      message: `SNAPSHOT_FAILED: ${snapshot.message}`,
    };
  }
  const snapshotCurrent =
    snapshot.snapshot.fingerprint === review.startFingerprint &&
    JSON.stringify(covered.ids) === JSON.stringify(review.coveredAttemptIds);

  const anyNeedsContext = checkpoint.reviewers.some(
    (reviewer) => review.results[reviewer]?.status === "NEEDS_CONTEXT",
  );
  if (anyNeedsContext) {
    const updated: DelegatedRunCheckpoint = { ...checkpoint, lastOutcome: "stopped" };
    run.checkpoints.set(input.checkpointId, updated);
    return {
      ok: true,
      checkpoint: cloneCheckpoint(updated),
      outcome: "stopped",
      snapshotCurrent,
    };
  }

  const allRecorded = checkpoint.reviewers.every(
    (reviewer) => review.results[reviewer] !== undefined,
  );
  if (!allRecorded) {
    const updated: DelegatedRunCheckpoint = { ...checkpoint, lastOutcome: "incomplete" };
    run.checkpoints.set(input.checkpointId, updated);
    return {
      ok: true,
      checkpoint: cloneCheckpoint(updated),
      outcome: "incomplete",
      snapshotCurrent,
    };
  }

  const allPass = checkpoint.reviewers.every(
    (reviewer) => review.results[reviewer]?.status === "PASS",
  );
  const now = toIsoNow();

  if (!snapshotCurrent) {
    const settled: DelegatedRunCheckpoint = {
      ...checkpoint,
      status: "failed",
      lastOutcome: "stale",
      currentReview: undefined,
      history: [
        ...checkpoint.history,
        {
          generation: review.generation,
          outcome: "stale",
          fingerprint: snapshot.snapshot.fingerprint,
          completedAt: now,
        },
      ],
    };
    run.checkpoints.set(input.checkpointId, settled);
    return {
      ok: true,
      checkpoint: cloneCheckpoint(settled),
      outcome: "stale",
      snapshotCurrent: false,
    };
  }

  if (allPass) {
    const settled: DelegatedRunCheckpoint = {
      ...checkpoint,
      status: "passed",
      lastOutcome: "passed",
      currentReview: undefined,
      history: [
        ...checkpoint.history,
        {
          generation: review.generation,
          outcome: "passed",
          fingerprint: review.startFingerprint,
          completedAt: now,
        },
      ],
    };
    run.checkpoints.set(input.checkpointId, settled);

    if (input.complete === true) {
      const completion = evaluateRunCompletion(data, run, settled);
      if (!completion.ok) {
        return { ok: false, errorCode: "COMPLETE_REQUIREMENTS_UNMET", message: completion.message };
      }
      run.status = "sealed";
      run.sealedAt = now;
      return {
        ok: true,
        checkpoint: cloneCheckpoint(settled),
        outcome: "passed",
        snapshotCurrent: true,
        sealedRun: true,
      };
    }

    return {
      ok: true,
      checkpoint: cloneCheckpoint(settled),
      outcome: "passed",
      snapshotCurrent: true,
    };
  }

  const failed: DelegatedRunCheckpoint = {
    ...checkpoint,
    status: "failed",
    lastOutcome: "failed",
    currentReview: undefined,
    history: [
      ...checkpoint.history,
      {
        generation: review.generation,
        outcome: "failed",
        fingerprint: review.startFingerprint,
        completedAt: now,
      },
    ],
  };
  run.checkpoints.set(input.checkpointId, failed);
  return {
    ok: true,
    checkpoint: cloneCheckpoint(failed),
    outcome: "failed",
    snapshotCurrent: true,
  };
}

function evaluateRunCompletion(
  data: WorkItemStoreData,
  run: DelegatedPlanRun,
  finalCheckpoint: DelegatedRunCheckpoint,
): { ok: true } | { ok: false; message: string } {
  for (const task of run.definition.tasks) {
    const binding = run.tasks.get(task.taskId);
    if (!binding) {
      return { ok: false, message: `task ${task.taskId} has no bound work item` };
    }
    const record = findRecord(data, run.sessionId, binding.workItemId);
    const acceptance = record ? currentDelegatedAcceptance(record) : undefined;
    if (!acceptance) {
      return { ok: false, message: `task ${task.taskId} has no currently accepted attempt` };
    }
  }
  for (const checkpoint of run.checkpoints.values()) {
    if (checkpoint.checkpointId === finalCheckpoint.checkpointId) continue;
    if (checkpoint.status !== "passed") {
      return {
        ok: false,
        message: `milestone ${checkpoint.checkpointId} is ${checkpoint.status}, not passed`,
      };
    }
  }
  const coveredScope = new Set(run.definition.tasks.flatMap((task) => task.writeScope));
  for (const scopeFile of coveredScope) {
    if (!finalCheckpoint.scope.includes(scopeFile)) {
      return {
        ok: false,
        message: `final checkpoint scope does not cover declared write scope file ${scopeFile}`,
      };
    }
  }
  return { ok: true };
}

export type AuthorizeReworkResult =
  | { ok: true; reworkId: string; grantedAttempts: number }
  | {
      ok: false;
      errorCode:
        | "RUN_NOT_FOUND"
        | "SESSION_MISMATCH"
        | "CHECKPOINT_NOT_FOUND"
        | "RUN_SEALED"
        | "CHECKPOINT_NOT_FAILED"
        | "HARD_STOP_CHECKPOINT"
        | "TASK_NOT_COVERED"
        | "WORK_ITEM_NOT_BOUND"
        | "REWORK_REJECTED";
      message: string;
    };

export interface AuthorizeReworkInput {
  sessionId: string;
  runId: string;
  checkpointId: string;
  workItemId: string;
  reason: string;
}

// START_CONTRACT: authorizeReworkFromFailedCheckpoint
//   PURPOSE: Validate a failed-checkpoint rework authorization for a covered accepted task and apply the guarded rework reducer.
//   INPUTS: { store: WorkItemStore - backing store, input: AuthorizeReworkInput - run, checkpoint, work item, and bounded reason }
//   OUTPUTS: { AuthorizeReworkResult - applied rework or a coded rejection }
//   SIDE_EFFECTS: [Reopens the covered delegated item via reworkDelegatedWorkItem]
//   LINKS: [M-WORKFLOW-CHECKPOINTS, M-WORKFLOW-DELEGATED, reworkDelegatedWorkItem]
// END_CONTRACT: authorizeReworkFromFailedCheckpoint
export function authorizeReworkFromFailedCheckpoint(
  store: WorkItemStore,
  input: AuthorizeReworkInput,
): AuthorizeReworkResult {
  return authorizeReworkFromFailedCheckpointInStore(store.getStoreData(), input);
}

export function authorizeReworkFromFailedCheckpointInStore(
  data: WorkItemStoreData,
  input: AuthorizeReworkInput,
): AuthorizeReworkResult {
  const run = findRun(data, input.runId);
  if (!run) {
    return { ok: false, errorCode: "RUN_NOT_FOUND", message: `RUN_NOT_FOUND: ${input.runId}` };
  }
  if (run.sessionId !== input.sessionId) {
    return {
      ok: false,
      errorCode: "SESSION_MISMATCH",
      message: `SESSION_MISMATCH: run ${input.runId} belongs to session ${run.sessionId}`,
    };
  }
  if (run.status === "sealed") {
    return {
      ok: false,
      errorCode: "RUN_SEALED",
      message: `RUN_SEALED: run ${input.runId} is complete; rework requires a new change`,
    };
  }

  const checkpoint = run.checkpoints.get(input.checkpointId);
  if (!checkpoint) {
    return {
      ok: false,
      errorCode: "CHECKPOINT_NOT_FOUND",
      message: `CHECKPOINT_NOT_FOUND: ${input.checkpointId}`,
    };
  }
  if (checkpoint.status !== "failed") {
    return {
      ok: false,
      errorCode: "CHECKPOINT_NOT_FAILED",
      message: `CHECKPOINT_NOT_FAILED: ${input.checkpointId} is ${checkpoint.status}`,
    };
  }
  if (checkpoint.lastOutcome === "stopped") {
    return {
      ok: false,
      errorCode: "HARD_STOP_CHECKPOINT",
      message: `HARD_STOP_CHECKPOINT: ${input.checkpointId} stopped on NEEDS_CONTEXT; resolve the hard stop first`,
    };
  }

  const record = findRecord(data, input.sessionId, input.workItemId);
  if (!record || record.mode !== "delegated" || !record.delegated) {
    return {
      ok: false,
      errorCode: "WORK_ITEM_NOT_BOUND",
      message: `WORK_ITEM_NOT_BOUND: ${input.workItemId} is not a delegated work item`,
    };
  }
  if (record.delegated.planRunId !== input.runId || !record.delegated.planTaskId) {
    return {
      ok: false,
      errorCode: "WORK_ITEM_NOT_BOUND",
      message: `WORK_ITEM_NOT_BOUND: ${input.workItemId} is not bound to run ${input.runId}`,
    };
  }
  if (!checkpoint.covers.includes(record.delegated.planTaskId)) {
    return {
      ok: false,
      errorCode: "TASK_NOT_COVERED",
      message: `TASK_NOT_COVERED: ${input.checkpointId} does not cover task ${record.delegated.planTaskId}`,
    };
  }

  const reworked = reworkDelegatedWorkItem({ getStoreData: () => data } as WorkItemStore, {
    sessionId: input.sessionId,
    workItemId: input.workItemId,
    planRunId: input.runId,
    failedCheckpointId: input.checkpointId,
    reason: input.reason,
  });
  if (!reworked.ok) {
    return {
      ok: false,
      errorCode: "REWORK_REJECTED",
      message: `REWORK_REJECTED: ${reworked.message}`,
    };
  }
  return { ok: true, reworkId: reworked.reworkId, grantedAttempts: reworked.grantedAttempts };
}

// START_CONTRACT: recoverDelegatedCheckpoint
//   PURPOSE: Settle a stopped generation as historical evidence or grant exactly one further review generation after exhaustion, preserving covered tasks, reviewers, and history.
//   INPUTS: { store: WorkItemStore - backing store, input: RecoverDelegatedCheckpointInput - bounded recovery payload with optional root-user authorization }
//   OUTPUTS: { RecoverDelegatedCheckpointResult - recorded recovery with updated generation budget or a coded rejection without mutation }
//   SIDE_EFFECTS: [Appends a checkpoint recovery record, settles a stopped generation into history, and may extend the generation budget by exactly one]
//   LINKS: [M-WORKFLOW-CHECKPOINTS, M-WORKFLOW-DELEGATED, validateRecoveryUserAuthorization]
// END_CONTRACT: recoverDelegatedCheckpoint
// START_BLOCK_CHECKPOINT_RECOVERY
export type RecoverDelegatedCheckpointResult =
  | {
      ok: true;
      checkpoint: DelegatedRunCheckpoint;
      recoveryId: string;
      kind: DelegatedRecoveryKind;
      generationBudget: number;
      settledStoppedGeneration?: number;
    }
  | {
      ok: false;
      errorCode:
        | "RUN_NOT_FOUND"
        | "SESSION_MISMATCH"
        | "CHECKPOINT_NOT_FOUND"
        | "RUN_SEALED"
        | "ALREADY_PASSED"
        | "INVALID_TARGET_STATE"
        | "DUPLICATE_RECOVERY_ID"
        | "INVALID_INPUT"
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

export interface RecoverDelegatedCheckpointInput {
  sessionId: string;
  runId: string;
  checkpointId: string;
  diagnosis: string;
  changedCondition: string;
  verification: string[];
  recoveryId: string;
  /** Fresh root-user message authorizing one further generation for this target. */
  userMessageId?: string;
  /** Read-only authorization lookup supplied by the tool layer. */
  lookupUserMessage?: LookupRecoveryUserMessage;
}

type CheckpointRecoveryPrecheck =
  | {
      ok: true;
      checkpoint: DelegatedRunCheckpoint;
      stopped: boolean;
      needsGrant: boolean;
      autonomousAvailable: boolean;
      stopTimeMs?: number;
    }
  | {
      ok: false;
      errorCode: Extract<RecoverDelegatedCheckpointResult, { ok: false }>["errorCode"];
      message: string;
    };

/** Timestamp (epoch ms) of the most recent settled evidence in a checkpoint. */
function checkpointStopTimeMs(checkpoint: DelegatedRunCheckpoint): number | undefined {
  if (checkpoint.currentReview) {
    const recorded = Object.values(checkpoint.currentReview.results)
      .map((result) => (result ? Date.parse(result.recordedAt) : Number.NaN))
      .filter((value) => Number.isFinite(value));
    if (recorded.length > 0) return Math.max(...recorded);
  }
  const last = checkpoint.history[checkpoint.history.length - 1];
  if (last) {
    const parsed = Date.parse(last.completedAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Synchronous eligibility check for checkpoint recovery: a stopped generation
 * (NEEDS_CONTEXT settled nothing) or a generation-exhausted checkpoint. Live
 * reviews, pending checkpoints, and ordinary-budget failures are not
 * recoverable targets.
 */
function precheckCheckpointRecovery(
  data: WorkItemStoreData,
  input: RecoverDelegatedCheckpointInput,
): CheckpointRecoveryPrecheck {
  const run = findRun(data, input.runId);
  if (!run) {
    return { ok: false, errorCode: "RUN_NOT_FOUND", message: `RUN_NOT_FOUND: ${input.runId}` };
  }
  if (run.sessionId !== input.sessionId) {
    return {
      ok: false,
      errorCode: "SESSION_MISMATCH",
      message: `SESSION_MISMATCH: run ${input.runId} belongs to session ${run.sessionId}`,
    };
  }
  if (run.status === "sealed") {
    return {
      ok: false,
      errorCode: "RUN_SEALED",
      message: `RUN_SEALED: run ${input.runId} is complete; recovery requires a new change`,
    };
  }
  const checkpoint = run.checkpoints.get(input.checkpointId);
  if (!checkpoint) {
    return {
      ok: false,
      errorCode: "CHECKPOINT_NOT_FOUND",
      message: `CHECKPOINT_NOT_FOUND: ${input.checkpointId}`,
    };
  }
  if (checkpoint.status === "passed") {
    return {
      ok: false,
      errorCode: "ALREADY_PASSED",
      message: `ALREADY_PASSED: ${input.checkpointId} passed at generation ${checkpoint.attempts}`,
    };
  }

  const stopped =
    checkpoint.status === "in_review" &&
    checkpoint.lastOutcome === "stopped" &&
    checkpoint.currentReview !== undefined;
  const budget = checkpointGenerationBudget(checkpoint);
  const exhausted = checkpoint.status === "failed" && checkpoint.attempts >= budget;
  if (!stopped && !exhausted) {
    if (checkpoint.status === "in_review") {
      return {
        ok: false,
        errorCode: "INVALID_TARGET_STATE",
        message: `INVALID_TARGET_STATE: ${input.checkpointId} generation ${checkpoint.currentReview?.generation} is live; recovery never interrupts in-flight review work`,
      };
    }
    if (checkpoint.status === "failed") {
      return {
        ok: false,
        errorCode: "INVALID_TARGET_STATE",
        message: `INVALID_TARGET_STATE: ${input.checkpointId} still has ${budget - checkpoint.attempts} ordinary generation(s) available; start the next generation instead of recovering`,
      };
    }
    return {
      ok: false,
      errorCode: "INVALID_TARGET_STATE",
      message: `INVALID_TARGET_STATE: ${input.checkpointId} is ${checkpoint.status} and has nothing to recover`,
    };
  }
  if (checkpoint.recoveryHistory.some((entry) => entry.recoveryId === input.recoveryId)) {
    return {
      ok: false,
      errorCode: "DUPLICATE_RECOVERY_ID",
      message: `DUPLICATE_RECOVERY_ID: recoveryId ${input.recoveryId} is already recorded for ${input.checkpointId}`,
    };
  }

  return {
    ok: true,
    checkpoint,
    stopped,
    needsGrant: exhausted || checkpoint.attempts >= budget,
    autonomousAvailable: !checkpointAutonomousGrantConsumed(checkpoint.recoveryHistory),
    stopTimeMs: checkpointStopTimeMs(checkpoint),
  };
}

export async function recoverDelegatedCheckpoint(
  store: WorkItemStore,
  input: RecoverDelegatedCheckpointInput,
): Promise<RecoverDelegatedCheckpointResult> {
  return recoverDelegatedCheckpointInStore(store.getStoreData(), input);
}

export async function recoverDelegatedCheckpointInStore(
  data: WorkItemStoreData,
  input: RecoverDelegatedCheckpointInput,
): Promise<RecoverDelegatedCheckpointResult> {
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

  const precheck = precheckCheckpointRecovery(data, input);
  if (!precheck.ok) {
    return { ok: false, errorCode: precheck.errorCode, message: precheck.message };
  }

  const commitRecovery = (
    kind: DelegatedRecoveryKind,
    validatedMessageTimeMs?: number,
  ): RecoverDelegatedCheckpointResult => {
    // Re-run the synchronous eligibility check immediately before committing
    // so an authorization await can never commit against a changed target.
    const fresh = precheckCheckpointRecovery(data, input);
    if (!fresh.ok) {
      return { ok: false, errorCode: fresh.errorCode, message: fresh.message };
    }
    // The authorization message was timed against the pre-await stop; if the
    // target moved to a newer generation during the await, that timing no
    // longer authorizes this recovery.
    if (
      validatedMessageTimeMs !== undefined &&
      fresh.stopTimeMs !== undefined &&
      validatedMessageTimeMs < fresh.stopTimeMs
    ) {
      return {
        ok: false,
        errorCode: "AUTHORIZATION_STALE",
        message: `AUTHORIZATION_STALE: message ${String(input.userMessageId)} predates the stop it must authorize`,
      };
    }
    const now = toIsoNow();
    const stoppedReview = fresh.stopped ? fresh.checkpoint.currentReview : undefined;
    const recovery: DelegatedCheckpointRecoveryRecord = {
      recoveryId: input.recoveryId,
      targetGeneration: stoppedReview?.generation ?? fresh.checkpoint.attempts,
      kind,
      diagnosis: input.diagnosis.trim(),
      changedCondition: input.changedCondition.trim(),
      verification: input.verification.map((reference) => reference.trim()),
      recoveredAt: now,
      ...(kind === "user_grant" && input.userMessageId
        ? { userMessageId: input.userMessageId }
        : {}),
    };

    let updated: DelegatedRunCheckpoint;
    if (stoppedReview) {
      // Settle the stopped generation as historical stopped evidence. The
      // FAIL-less stop is not converted into a failure: rework stays locked
      // until a real failed generation exists.
      updated = {
        ...fresh.checkpoint,
        status: "failed",
        lastOutcome: "stopped",
        currentReview: undefined,
        history: [
          ...fresh.checkpoint.history,
          {
            generation: stoppedReview.generation,
            outcome: "stopped",
            fingerprint: stoppedReview.startFingerprint,
            completedAt: now,
          },
        ],
        recoveryHistory: [...fresh.checkpoint.recoveryHistory, recovery],
      };
    } else {
      updated = {
        ...fresh.checkpoint,
        recoveryHistory: [...fresh.checkpoint.recoveryHistory, recovery],
      };
    }
    findRun(data, input.runId)!.checkpoints.set(input.checkpointId, updated);

    const generationBudget = checkpointGenerationBudget(updated);
    return {
      ok: true,
      checkpoint: cloneCheckpoint(updated),
      recoveryId: input.recoveryId,
      kind,
      generationBudget,
      ...(stoppedReview ? { settledStoppedGeneration: stoppedReview.generation } : {}),
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
      precheck.checkpoint.recoveryHistory.some((entry) => entry.userMessageId === userMessageId)
    ) {
      return {
        ok: false,
        errorCode: "AUTHORIZATION_REUSED",
        message: `AUTHORIZATION_REUSED: message ${userMessageId} already authorized recovery of ${input.checkpointId}; each message grants at most one unit per target`,
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
      requireAfterMs: precheck.stopTimeMs,
      lookup: input.lookupUserMessage,
    });
    if (!authorization.ok) {
      return { ok: false, errorCode: authorization.errorCode, message: authorization.message };
    }
    // The await above is an async boundary: re-verify non-reuse before commit
    // (the precheck inside commitRecovery covers the rest of the state).
    const freshCheckpoint = findRun(data, input.runId)?.checkpoints.get(input.checkpointId);
    if (freshCheckpoint?.recoveryHistory.some((entry) => entry.userMessageId === userMessageId)) {
      return {
        ok: false,
        errorCode: "AUTHORIZATION_REUSED",
        message: `AUTHORIZATION_REUSED: message ${userMessageId} already authorized recovery of ${input.checkpointId}`,
      };
    }
    return commitRecovery("user_grant", authorization.timeCreatedMs);
  }

  if (precheck.autonomousAvailable) {
    return commitRecovery("autonomous_grant");
  }

  return {
    ok: false,
    errorCode: "AUTONOMOUS_GRANT_EXHAUSTED",
    message: `AUTONOMOUS_GRANT_EXHAUSTED: the single autonomous recovery grant for ${input.checkpointId} is consumed; one further generation requires a fresh root-user message referenced by userMessageId`,
  };
}
// END_BLOCK_CHECKPOINT_RECOVERY

// START_BLOCK_BARRIER_GATES
/** Unsatisfied checkpoint barriers blocking task launches for the given wave, in declaration order. */
export function checkpointBarrierUnsatisfied(
  data: WorkItemStoreData,
  runId: string,
  wave: string,
): { ok: true; blockers: string[] } | { ok: false; message: string } {
  const run = findRun(data, runId);
  if (!run) return { ok: false, message: `RUN_NOT_FOUND: ${runId}` };
  const waveIndex = waveIndexOf(run, wave);
  if (waveIndex < 0) return { ok: false, message: `wave ${wave} is not declared in run ${runId}` };

  const blockers: string[] = [];
  for (const checkpoint of run.checkpoints.values()) {
    if (checkpoint.kind !== "milestone") continue;
    const afterIndex = waveIndexOf(run, checkpoint.afterWave);
    if (afterIndex < waveIndex && checkpoint.status !== "passed") {
      blockers.push(checkpoint.checkpointId);
    }
  }
  return { ok: true, blockers };
}

/** In-flight checkpoint review whose scope intersects the declared write scope. */
export function findOverlappingInFlightReview(
  data: WorkItemStoreData,
  runId: string,
  writeScope: readonly string[],
): string | undefined {
  const run = findRun(data, runId);
  if (!run) return undefined;
  for (const checkpoint of run.checkpoints.values()) {
    if (checkpoint.status !== "in_review") continue;
    if (checkpoint.scope.some((file) => writeScope.includes(file))) {
      return checkpoint.checkpointId;
    }
  }
  return undefined;
}
// END_BLOCK_BARRIER_GATES

// START_BLOCK_RUN_VIEW
type CheckpointNextAction =
  | "start"
  | "collect_and_verify"
  | "start_next_generation"
  | "recover"
  | "recover_with_user_authorization"
  | "passed";

function checkpointNextAction(checkpoint: DelegatedRunCheckpoint): {
  generationBudget: number;
  remainingGenerations: number;
  nextAction: CheckpointNextAction;
} {
  const generationBudget = checkpointGenerationBudget(checkpoint);
  const remainingGenerations = Math.max(0, generationBudget - checkpoint.attempts);
  if (checkpoint.status === "passed") {
    return { generationBudget, remainingGenerations, nextAction: "passed" };
  }
  if (checkpoint.status === "in_review") {
    if (checkpoint.lastOutcome === "stopped") {
      // The linked review item is hard-stopped: re-running verify is a no-op,
      // so the supported action is bounded recovery, never collection.
      return { generationBudget, remainingGenerations, nextAction: "recover" };
    }
    return { generationBudget, remainingGenerations, nextAction: "collect_and_verify" };
  }
  if (checkpoint.status === "pending") {
    return { generationBudget, remainingGenerations, nextAction: "start" };
  }
  // Failed: suggest an ordinary next generation while budget remains, then
  // bounded recovery, then user-authorized recovery after the autonomous
  // grant is consumed. The suggestion never proposes a start the same state
  // would immediately reject.
  if (remainingGenerations > 0) {
    return { generationBudget, remainingGenerations, nextAction: "start_next_generation" };
  }
  const autonomousAvailable = !checkpointAutonomousGrantConsumed(checkpoint.recoveryHistory);
  return {
    generationBudget,
    remainingGenerations,
    nextAction: autonomousAvailable ? "recover" : "recover_with_user_authorization",
  };
}

/** Read-only run serialization for tooling output and persistence consumers. */
export function getDelegatedRunView(
  data: WorkItemStoreData,
  runId: string,
): Record<string, unknown> | undefined {
  const run = findRun(data, runId);
  if (!run) return undefined;
  return {
    runId: run.runId,
    sessionId: run.sessionId,
    planPath: run.planPath,
    specPath: run.specPath,
    workspaceRoot: run.workspaceRoot,
    status: run.status,
    registeredAt: run.registeredAt,
    ...(run.sealedAt ? { sealedAt: run.sealedAt } : {}),
    finalCheckpointId: run.finalCheckpointId,
    tasks: [...run.tasks.values()].map((task) => ({
      taskId: task.taskId,
      workItemId: task.workItemId,
    })),
    checkpoints: [...run.checkpoints.values()].map((checkpoint) => {
      const progress = checkpointNextAction(checkpoint);
      return {
        checkpointId: checkpoint.checkpointId,
        kind: checkpoint.kind,
        afterWave: checkpoint.afterWave,
        covers: checkpoint.covers,
        scope: checkpoint.scope,
        reviewers: checkpoint.reviewers,
        status: checkpoint.status,
        attempts: checkpoint.attempts,
        ...(checkpoint.lastOutcome ? { lastOutcome: checkpoint.lastOutcome } : {}),
        generationBudget: progress.generationBudget,
        remainingGenerations: progress.remainingGenerations,
        recoveryCount: checkpointRecoveryGrantCount(checkpoint.recoveryHistory),
        nextAction: progress.nextAction,
        ...(checkpoint.currentReview
          ? {
              currentReview: {
                reviewWorkItemId: checkpoint.currentReview.reviewWorkItemId,
                generation: checkpoint.currentReview.generation,
                coveredAttemptIds: checkpoint.currentReview.coveredAttemptIds,
                recordedReviewers: Object.keys(checkpoint.currentReview.results),
              },
            }
          : {}),
        history: checkpoint.history,
      };
    }),
  };
}
// END_BLOCK_RUN_VIEW
