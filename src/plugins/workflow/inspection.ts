// FILE: src/plugins/workflow/inspection.ts
// VERSION: 1.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Own read-only same-session workflow inspection: bounded work-item/plan-run/execution serialization, one composed guidance helper, and getWorkflowInspection, extending work_item_list additively with authoritative native and generic executions plus the loaded package/contract identity while preserving items, planRuns, includeClosed, and bounded recovery excerpts.
//   SCOPE: Pure read-only projection only. No store mutation, no ensureNativeExecutions call, no recovery, no authority-message lookup, no private store dumps or raw authorization text. Reads current session records first and derives guidance from the same pure domain gates the real mutations consume.
//   DEPENDS: [src/plugins/workflow/state.ts, src/plugins/workflow/delegated.ts, src/plugins/workflow/execution.ts, src/plugins/workflow/checkpoints.ts, src/plugins/workflow/authority.ts, src/plugins/workflow/results.ts (types), src/lib/agent-tool-contract.ts]
//   LINKS: [M-WORKFLOW-TOOLING, M-WORKFLOW-DELEGATED, M-WORKFLOW-EXECUTION, M-WORKFLOW-CHECKPOINTS, M-WORKFLOW-AUTHORITY, M-AGENT-TOOL-CONTRACT, V-M-WORKFLOW-TOOLING]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   DelegatedGuidanceView - Gate-derived delegated next action, eligibility, blockers, and prerequisites.
//   WorkflowInspectionResult - Additive same-session work_item_list payload.
//   InspectionContext - Store data plus session id used to derive read-only inspection guidance.
//   getWorkflowContractIdentity - Bounded loaded contract identity from the accepted cross-plugin contract module.
//   deriveDelegatedGuidance - One composed guidance helper shared by list/open/failure/recovery responses.
//   serializeWorkItem - Read-only serialization of one work item with delegated budget/guidance.
//   getWorkflowInspection - Additive same-session work_item_list payload with items, planRuns, executions, and contract identity.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-004 - Read-only inspection owner. Correction cycle: all public nextAction surfaces share deriveDelegatedGuidance; native executions project authoritative current plan-run lifecycle/checkpoint generation/bound acceptance without ensureNativeExecutions; prerequisites are source/action-specific and truthful; concrete schema-derived DTOs replace opaque view records. Prior: new inspection owner.]
// END_CHANGE_SUMMARY

import {
  AGENT_TOOL_CONTRACT_REVISION,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  resolveToolContractReferencePath,
} from "../../lib/agent-tool-contract.js";
import {
  getReviewRound,
  listWorkItems,
  type WorkItemRecord,
  type WorkItemStore,
  type WorkItemStoreData,
} from "./state.js";
import {
  currentDelegatedAcceptance,
  delegatedOrdinaryLaunchGate,
  summarizeDelegatedProgress,
  type DelegatedNextAction,
} from "./delegated.js";
import {
  getExecutionView,
  isTaskLaunchableInStore,
  latestAttemptView,
  type WorkflowExecutionRecord,
} from "./execution.js";
import {
  checkpointBarrierUnsatisfied,
  findOverlappingInFlightReview,
  getDelegatedRunView,
  getNativeExecutionView,
} from "./checkpoints.js";
import { advanceUnitsAvailable, effectiveAuthorityStages } from "./authority.js";
import type {
  WorkflowContractIdentity,
  WorkflowDelegatedRunView,
  WorkflowExecutionView,
  WorkflowWorkItemView,
} from "./results.js";

/**
 * Gate-derived guidance for one delegated work item. `nextAction` always agrees
 * with the shared launch/decision gates; `blockers` names the exact gate reason
 * (with the offending task or checkpoint id) when an ordinary launch is blocked.
 */
export interface DelegatedGuidanceView {
  nextAction: DelegatedNextAction;
  launchEligible: boolean;
  blockers: string[];
  prerequisites: string[];
  requiresConcernsDisposition: boolean;
}

export interface WorkflowInspectionResult extends Record<string, unknown> {
  tool: "work_item_list";
  sessionId: string;
  includeClosed: boolean;
  items: WorkflowWorkItemView[];
  planRuns?: WorkflowDelegatedRunView[];
  executions?: WorkflowExecutionView[];
  contract: WorkflowContractIdentity;
}

/** Store context required to derive snapshot-level (not host-level) eligibility. */
export interface InspectionContext {
  data: WorkItemStoreData;
  sessionId: string;
}

// START_BLOCK_CONTRACT_IDENTITY
/**
 * Loaded package/revision identity from the accepted cross-plugin contract
 * module only. Never reads a global install, user config, or remote metadata.
 */
export function getWorkflowContractIdentity(): WorkflowContractIdentity {
  return {
    packageName: PACKAGE_NAME,
    packageVersion: PACKAGE_VERSION,
    toolContractRevision: AGENT_TOOL_CONTRACT_REVISION,
    referencePath: resolveToolContractReferencePath(),
  };
}
// END_BLOCK_CONTRACT_IDENTITY

// START_BLOCK_LAUNCH_BLOCKERS
function findBoundExecutionTask(
  data: WorkItemStoreData,
  sessionId: string,
  workItemId: string,
): { runId: string; taskId: string } | undefined {
  for (const execution of data.executions.values()) {
    if (execution.sessionId !== sessionId) continue;
    for (const binding of execution.tasks.values()) {
      if (binding.workItemId === workItemId) {
        return { runId: execution.runId, taskId: binding.taskId };
      }
    }
  }
  return undefined;
}

/**
 * Execution-level blockers for an ordinary implementer launch, derived from the
 * same checks the plugin launch hook and registry mutations consume: task
 * dependency/barrier/sealed/superseded/live/budget gates plus authoritative
 * native wave barriers and overlapping in-flight checkpoint reviews.
 */
function executionLaunchBlockers(record: WorkItemRecord, context: InspectionContext): string[] {
  if (!record.delegated) return [];
  const blockers: string[] = [];
  const bound = findBoundExecutionTask(context.data, context.sessionId, record.workItemId);
  if (bound) {
    const launchable = isTaskLaunchableInStore(context.data, {
      sessionId: context.sessionId,
      runId: bound.runId,
      taskId: bound.taskId,
    });
    if (!launchable.ok) blockers.push(`${launchable.reason}:${bound.taskId}`);
  }
  const planRunId = record.delegated.planRunId;
  if (!planRunId) return blockers;
  const run = context.data.planRuns.get(planRunId);
  if (!run || run.sessionId !== context.sessionId) return blockers;
  if (run.status === "sealed") {
    blockers.push(`EXECUTION_SEALED:${planRunId}`);
    return blockers;
  }
  const binding = [...run.tasks.values()].find((task) => task.workItemId === record.workItemId);
  const taskDefinition = binding
    ? run.definition.tasks.find((task) => task.taskId === binding.taskId)
    : undefined;
  if (taskDefinition) {
    const barrier = checkpointBarrierUnsatisfied(context.data, planRunId, taskDefinition.wave);
    if (barrier.ok) {
      for (const checkpointId of barrier.blockers) {
        blockers.push(`BARRIER_UNSATISFIED:${checkpointId}`);
      }
    }
  }
  const overlapping = findOverlappingInFlightReview(
    context.data,
    planRunId,
    record.delegated.writeScope,
  );
  if (overlapping) blockers.push(`OVERLAPPING_REVIEW:${overlapping}`);
  return blockers;
}
// END_BLOCK_LAUNCH_BLOCKERS

// START_BLOCK_GUIDANCE
interface DelegatedGuidanceOptions {
  record: WorkItemRecord;
  progress: ReturnType<typeof summarizeDelegatedProgress>;
  latest: ReturnType<typeof latestAttemptView>;
  context: InspectionContext;
}

/**
 * Build gate-derived guidance. Ordinary launches are downgraded to
 * `launch_blocked` whenever the real item-level or execution-level gate would
 * reject, so a caller can never see `launch_implementer` beside a blocker. This
 * is the single composed helper shared by inspection and every mutation/failure
 * response that reports a next action.
 */
export function deriveDelegatedGuidance(options: DelegatedGuidanceOptions): DelegatedGuidanceView {
  const { record, progress, latest, context } = options;
  let nextAction: DelegatedNextAction = progress.nextAction;
  const blockers: string[] = [];
  const prerequisites: string[] = [];
  const requiresConcernsDisposition =
    record.state === "awaiting_acceptance" && latest?.resultStatus === "DONE_WITH_CONCERNS";

  if (nextAction === "launch_implementer") {
    const gate = delegatedOrdinaryLaunchGate(record);
    if (!gate.ok) {
      blockers.push(`${gate.reason}:${record.workItemId}`);
    }
    blockers.push(...executionLaunchBlockers(record, context));
    if (blockers.length > 0) nextAction = "launch_blocked";
  }

  switch (nextAction) {
    case "launch_implementer":
      prerequisites.push(
        "the snapshot-level dependency/barrier/overlap gate currently accepts; actual launch still needs live host permission and context, which inspection does not assert",
      );
      break;
    case "launch_blocked":
      prerequisites.push(
        "clear the blocking dependency, checkpoint barrier, overlapping review, or sealed/superseded execution",
      );
      break;
    case "await_result":
      prerequisites.push("the in-flight attempt result for the current call");
      break;
    case "decide":
      prerequisites.push(
        `a controller accept/request_changes decision for attempt ${latest?.attempt ?? "(unknown)"}`,
      );
      if (requiresConcernsDisposition) {
        prerequisites.push(
          "an explicit concernsDisposition because the attempt completed DONE_WITH_CONCERNS",
        );
      }
      break;
    case "recover":
      prerequisites.push("a bounded recovery diagnosis, changed condition, and verification");
      break;
    case "recover_with_user_authorization":
      prerequisites.push(
        "a recorded eligible advance authority for this target, or a fresh root-user message; inspection does not verify future message provenance",
      );
      break;
    case "close":
      prerequisites.push("a ready_to_close item carrying a current acceptance");
      break;
    case "closed":
      break;
  }

  return {
    nextAction,
    launchEligible: nextAction === "launch_implementer" && blockers.length === 0,
    blockers,
    prerequisites,
    requiresConcernsDisposition,
  };
}
// END_BLOCK_GUIDANCE

// START_BLOCK_WORK_ITEM_SERIALIZATION
function serializeProgress(
  record: WorkItemRecord,
  nextAction: DelegatedNextAction,
): {
  attemptBudget: number;
  remainingAttempts: number;
  recoveryCount: number;
  autonomousGrantConsumed: boolean;
  reportRejectionCount: number;
  nextAction: DelegatedNextAction;
} {
  const progress = summarizeDelegatedProgress(record);
  return {
    attemptBudget: progress.attemptBudget,
    remainingAttempts: progress.remainingAttempts,
    recoveryCount: progress.recoveryGrants,
    autonomousGrantConsumed: progress.autonomousGrantConsumed,
    reportRejectionCount: progress.reportRejectedAttempts,
    nextAction,
  };
}

/**
 * Read-only serialization of one work item. Delegated budget/guidance derives
 * from shared pure gates; no private ledger body or authorization message text
 * is exposed. Store context is required for delegated items so snapshot-level
 * global gates are honored; non-delegated items are context-independent.
 */
export function serializeWorkItem(
  record: WorkItemRecord,
  context?: InspectionContext,
): WorkflowWorkItemView {
  const delegatedView = record.delegated;
  let nextAction: DelegatedNextAction = "launch_implementer";
  let guidance: DelegatedGuidanceView | undefined;
  if (delegatedView && context) {
    const progress = summarizeDelegatedProgress(record);
    guidance = deriveDelegatedGuidance({
      record,
      progress,
      latest: latestAttemptView(record),
      context,
    });
    nextAction = guidance.nextAction;
  } else if (delegatedView) {
    nextAction = summarizeDelegatedProgress(record).nextAction;
  }
  return {
    workItemId: record.workItemId,
    header: `VVOC_WORK_ITEM_ID: ${record.workItemId}`,
    key: record.key,
    title: record.title,
    mode: record.mode,
    requiredReviewers: [...record.requiredReviewers],
    state: record.state,
    specReviewCount: record.specReviewCount,
    codeReviewCount: record.codeReviewCount,
    reviewRound: getReviewRound(record),
    ...(record.currentRound ? { currentRound: record.currentRound } : {}),
    ...(record.resultExcerpt ? { resultExcerpt: record.resultExcerpt } : {}),
    completedReviewRoundCount: record.completedReviewRoundCount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.closedAt ? { closedAt: record.closedAt } : {}),
    ...(delegatedView
      ? {
          delegated: {
            writeScope: [...delegatedView.writeScope],
            ...(delegatedView.planRunId
              ? { planRunId: delegatedView.planRunId, planTaskId: delegatedView.planTaskId }
              : {}),
            attempts: delegatedView.attempts.length,
            inFlightAttempt: delegatedView.attempts.some(
              (attempt) => attempt.status === "in_flight",
            ),
            decisions: delegatedView.decisions.length,
            accepted: currentDelegatedAcceptance(record) !== undefined,
            acceptedAttempt: currentDelegatedAcceptance(record)?.attempt,
            reworkCount: delegatedView.reworkHistory.length,
            ...serializeProgress(record, nextAction),
            ...(latestAttemptView(record) ? { latestAttempt: latestAttemptView(record) } : {}),
            ...(guidance ? { guidance } : {}),
          },
        }
      : {}),
  };
}
// END_BLOCK_WORK_ITEM_SERIALIZATION

// START_BLOCK_AUTHORITY_PRECONDITIONS
/**
 * Bounded authority prerequisites for one execution. Exposes finite remaining
 * units, surviving stages, and reserved stops. It never claims that a recorded
 * ledger entry is live host authorization.
 */
function authorityPrerequisites(
  execution: WorkflowExecutionRecord,
): NonNullable<WorkflowExecutionView["authority"]> {
  return execution.authority.map((authority) => ({
    authorityId: authority.authorityId,
    availableUnits: advanceUnitsAvailable(authority, execution.reserveDebits),
    revoked: authority.revocations.some((revocation) => revocation.kind === "revoke"),
    stages: effectiveAuthorityStages(authority),
    reservedStops: [...authority.scope.reservedStops],
    prerequisites: [
      "acting on this authority requires live host permission and context; a recorded ledger entry is not current authorization",
    ],
  }));
}
// END_BLOCK_AUTHORITY_PRECONDITIONS

// START_BLOCK_EXECUTION_VIEWS
/**
 * Unified same-session execution views. Native plan runs are projected
 * authoritatively from the current plan-run lifecycle/checkpoints and current
 * bound acceptance (never from the one-time registry snapshot and never by
 * calling `ensureNativeExecutions`). Registry-native authority is merged when
 * present; generic executions follow. Run ids are unique across both sources.
 */
function buildExecutionViews(data: WorkItemStoreData, sessionId: string): WorkflowExecutionView[] {
  const views: WorkflowExecutionView[] = [];
  const seen = new Set<string>();
  for (const run of data.planRuns.values()) {
    if (run.sessionId !== sessionId) continue;
    const nativeView = getNativeExecutionView(data, run);
    const registry = data.executions.get(run.runId);
    const authority =
      registry && registry.source.kind === "native-package"
        ? authorityPrerequisites(registry)
        : undefined;
    views.push(authority && authority.length > 0 ? { ...nativeView, authority } : nativeView);
    seen.add(run.runId);
  }
  for (const execution of data.executions.values()) {
    if (execution.sessionId !== sessionId || seen.has(execution.runId)) continue;
    const view = getExecutionView(execution, data);
    const authority = authorityPrerequisites(execution);
    views.push(authority.length > 0 ? { ...view, authority } : view);
  }
  return views;
}
// END_BLOCK_EXECUTION_VIEWS

// START_CONTRACT: getWorkflowInspection
//   PURPOSE: Build the additive same-session work_item_list payload without mutating workflow state.
//   INPUTS: { store: WorkItemStore - backing store, sessionId: string - session scope, options?: { includeClosed?: boolean } - list behavior }
//   OUTPUTS: { WorkflowInspectionResult - items, optional planRuns/executions, and loaded contract identity }
//   SIDE_EFFECTS: [none]
//   LINKS: [M-WORKFLOW-TOOLING, M-WORKFLOW-EXECUTION, M-AGENT-TOOL-CONTRACT]
// END_CONTRACT: getWorkflowInspection
export function getWorkflowInspection(
  store: WorkItemStore,
  sessionId: string,
  options: { includeClosed?: boolean } = {},
): WorkflowInspectionResult {
  const includeClosed = options.includeClosed === true;
  const data = store.getStoreData();
  const context: InspectionContext = { data, sessionId };
  const records = listWorkItems(store, sessionId, { includeClosed });
  const planRuns = [...data.planRuns.values()]
    .filter((run) => run.sessionId === sessionId)
    .map((run) => getDelegatedRunView(data, run.runId))
    .filter((view): view is WorkflowDelegatedRunView => view !== undefined);
  const executions = buildExecutionViews(data, sessionId);
  return {
    tool: "work_item_list",
    sessionId,
    includeClosed,
    items: records.map((record) => serializeWorkItem(record, context)),
    ...(planRuns.length > 0 ? { planRuns } : {}),
    ...(executions.length > 0 ? { executions } : {}),
    contract: getWorkflowContractIdentity(),
  };
}
