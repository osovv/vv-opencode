// FILE: src/plugins/workflow/tooling.ts
// VERSION: 0.4.0
// START_MODULE_CONTRACT
//   PURPOSE: Provide work-item tooling handlers that wrap explicit workflow state operations with structured protocol-friendly responses.
//   SCOPE: work_item_open, work_item_list, and work_item_close tool definitions with delegated-mode open validation and mode-specific serialization including recovery-aware progress summaries; generic execution registration/append through an optional execution descriptor or runId; work_item_decide and work_checkpoint control-tool definitions wrapping delegated decisions, native plan registration, checkpoint start/verify, failed-checkpoint rework authorization, bounded recover for stopped or exhausted targets with optional root-user message authorization through a read-only lookup, and the generic (non-native) checkpoint, completion, amendment, advance-authority, stage-approval, and revocation actions.
//   DEPENDS: [src/plugins/workflow/checkpoint-io.ts, src/plugins/workflow/checkpoints.ts, src/plugins/workflow/delegated.ts, src/plugins/workflow/execution.ts, src/plugins/workflow/authority.ts, src/lib/workflow-contract.ts, src/plugins/workflow/state.ts]
//   LINKS: M-WORKFLOW-TOOLING, M-WORKFLOW-DELEGATED, M-WORKFLOW-CHECKPOINTS, M-WORKFLOW-EXECUTION, M-WORKFLOW-AUTHORITY, M-PLUGIN-WORKFLOW
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   WorkflowToolContext - Minimal execution context required by workflow tools.
//   WorkflowToolDefinition - Deterministic tool definition shape with an optionally async execute handler.
//   DelegatedControlOptions - Optional read-only authorization lookup bound to the plugin SDK client.
//   createWorkItemOpenTool - Creates work_item_open tool wrapper around explicit openWorkItem contract including standalone delegated tasks.
//   createWorkItemListTool - Creates work_item_list tool wrapper with mode, round metadata, delegated acceptance and recovery state, and registered plan runs.
//   createWorkItemCloseTool - Creates work_item_close tool wrapper with ready_to_close gating responses.
//   createWorkItemDecideTool - Creates work_item_decide control wrapper around decideDelegatedWorkItem, rework authorization, and bounded recovery.
//   createWorkCheckpointTool - Creates work_checkpoint control wrapper around plan registration, checkpoint start, verify, checkpoint recovery, and generic checkpoint/completion/amendment/authority actions.
//   DelegatedControlOptions - Optional read-only authorization lookups bound to the plugin SDK client.
//   DecideArgs - work_item_decide tool argument shape.
//   CheckpointArgs - work_checkpoint tool argument shape.
//   WorkCheckpointRegisterInput - Register-action input discriminator.
//   WorkCheckpointInput - work_checkpoint action input union.
//   WorkCheckpointExecuteContext - Extended execution context carrying the trusted workspace root and plan loader.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-WORKFLOW-PLAN-INDEPENDENCE - Added generic execution registration/append through work_item_open and generic checkpoint, completion, amendment, advance-authority, stage-approval, and revocation actions through work_checkpoint, plus the SDK-backed authority-message lookup seam.]
// END_CHANGE_SUMMARY

import {
  closeWorkItem,
  getReviewRound,
  listWorkItems,
  openWorkItem,
  type OpenWorkItemInput,
  type ReviewerRole,
  type WorkItemMode,
  type WorkItemRecord,
  type WorkItemStore,
  type WorkItemStoreData,
} from "./state.js";
import {
  authorizeReworkFromFailedCheckpoint,
  getDelegatedRunView,
  recoverDelegatedCheckpoint,
  registerDelegatedPlan,
  startDelegatedCheckpoint,
  verifyDelegatedCheckpoint,
} from "./checkpoints.js";
import {
  currentDelegatedAcceptance,
  decideDelegatedWorkItem,
  recoverDelegatedWorkItem,
  summarizeDelegatedProgress,
  type LookupRecoveryUserMessage,
} from "./delegated.js";
import {
  addAuthorityInStore,
  addReserveDebitInStore,
  addStageApprovalInStore,
  appendExecutionWorkInStore,
  completeExecutionInStore,
  findExecution,
  getExecutionView,
  recordGenericReviewerResultInStore,
  recoverGenericCheckpointInStore,
  putAuthorityInStore,
  registerExecutionInStore,
  startGenericCheckpointInStore,
} from "./execution.js";
import {
  advanceUnitsAvailable,
  effectiveAuthorityStages,
  extendAdvanceAuthority,
  grantAdvanceAuthority,
  proposeReserveDebit,
  proposeStageApproval,
  revokeAdvanceAuthority,
  narrowAdvanceAuthority,
  type AuthorityMessageSnapshot,
} from "./authority.js";
import type { LoadedDelegatedPlan } from "./checkpoint-io.js";
import type {
  WorkflowAuthorityStage,
  WorkflowExecutionBoundary,
  WorkflowExecutionSource,
  WorkflowReserveDebit,
  WorkflowReviewer,
  WorkflowTaskContract,
} from "../../lib/workflow-contract.js";

export type WorkflowToolContext = {
  sessionId: string;
  /** Trusted absolute workspace root; required for generic execution registration. */
  workspaceRoot?: string;
};

export type WorkflowToolDefinition<TArgs, TResult> = {
  name: string;
  description: string;
  execute: (args: TArgs, context: WorkflowToolContext, store?: WorkItemStore) => TResult;
};

/** Optional read-only authorization lookup bound to the plugin SDK client. */
export interface DelegatedControlOptions {
  lookupUserMessage?: LookupRecoveryUserMessage;
  /** Resolve one root-user message snapshot for advance-authority provenance. */
  lookupAuthorityMessage?: (input: {
    sessionId: string;
    runId: string;
    messageId: string;
  }) => Promise<AuthorityMessageSnapshot | undefined>;
}

type OpenInputItem = {
  key?: unknown;
  title?: unknown;
  mode?: unknown;
  requiredReviewers?: unknown;
  writeScope?: unknown;
  planRunId?: unknown;
  planTaskId?: unknown;
  /** Generic execution task-contract fields. */
  taskId?: unknown;
  goal?: unknown;
  acceptanceCriteria?: unknown;
  verification?: unknown;
  dependsOn?: unknown;
  blockedBy?: unknown;
};

type OpenArgs = {
  items: OpenInputItem[];
  /** Generic execution descriptor; mutually exclusive with runId. */
  execution?: unknown;
  /** Append tasks to an existing generic execution. */
  runId?: unknown;
  amendmentId?: unknown;
  rationale?: unknown;
};

type ListArgs = {
  includeClosed?: boolean;
};

type CloseArgs = {
  workItemId: string;
};

export type DecideArgs = {
  workItemId: string;
  attempt: number;
  decision: "accept" | "request_changes" | "rework" | "recover";
  /** Required for accept, request_changes, and rework; unused by recover. */
  rationale?: string;
  /** Required for accept and request_changes; unused by rework and recover. */
  evidence?: string[];
  concernsDisposition?: string;
  runId?: string;
  checkpointId?: string;
  /** Recover-only bounded diagnosis, changed condition, and verification references. */
  diagnosis?: string;
  changedCondition?: string;
  verification?: string[];
  recoveryId?: string;
  /** Recover-only fresh root-user message authorizing one further unit. */
  userMessageId?: string;
  /** Recover-only recorded advance authority authorizing one further unit. */
  authorityId?: string;
};

export type CheckpointArgs = {
  action:
    | "register"
    | "start"
    | "verify"
    | "recover"
    | "review"
    | "bind"
    | "complete"
    | "amend"
    | "authorize"
    | "record_approval"
    | "revoke_authority";
  planPath?: string;
  runId?: string;
  checkpointId?: string;
  complete?: boolean;
  /** Recover-only bounded diagnosis, changed condition, and verification references. */
  diagnosis?: string;
  changedCondition?: string;
  verification?: string[];
  recoveryId?: string;
  /** Recover-only fresh root-user message authorizing one further generation. */
  userMessageId?: string;
  /** Generic checkpoint append/registration payloads. */
  checkpoints?: unknown;
  tasks?: unknown;
  amendmentId?: string;
  rationale?: string;
  startFingerprint?: string;
  /** Generic reviewer result recording (status is read from the linked round). */
  reviewer?: string;
  /** Advance authority inputs. */
  authorityId?: string;
  messageId?: string;
  approvalId?: string;
  stage?: string;
  artifactPath?: string;
  artifactSha256?: string;
  revocationId?: string;
  /** Authority scope inputs. */
  stages?: unknown;
  decisionScope?: string;
  fileBoundary?: unknown;
  reservedStops?: unknown;
};

function coerceNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isWorkItemMode(value: unknown): value is WorkItemMode {
  return value === "implementation" || value === "review_only" || value === "delegated";
}

function isReviewerRole(value: unknown): value is ReviewerRole {
  return value === "spec" || value === "code";
}

function canonicalizeReviewers(value: unknown): ReviewerRole[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (!value.every(isReviewerRole)) return undefined;
  const unique = new Set(value);
  if (unique.size !== value.length) return undefined;
  return [...value].sort((left, right) => {
    if (left === right) return 0;
    return left === "spec" ? -1 : 1;
  });
}

// START_BLOCK_GENERIC_NORMALIZATION
function isWorkflowReviewer(value: unknown): value is WorkflowReviewer {
  return value === "spec" || value === "code";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

/** Normalize one tool item into a bounded generic task contract. */
function normalizeTaskContract(
  item: OpenInputItem,
): { ok: true; contract: WorkflowTaskContract } | { ok: false; message: string } {
  const taskId = coerceNonEmptyString(item.taskId) ?? coerceNonEmptyString(item.key);
  const title = coerceNonEmptyString(item.title) ?? taskId;
  if (!taskId || !title) {
    return { ok: false, message: "each task item requires a non-empty taskId (or key) and title" };
  }
  if (!Array.isArray(item.requiredReviewers)) {
    return {
      ok: false,
      message:
        "requiredReviewers must be declared explicitly for each task (use [] for no independent review)",
    };
  }
  const reviewers = item.requiredReviewers;
  if (!reviewers.every(isWorkflowReviewer) || new Set(reviewers).size !== reviewers.length) {
    return { ok: false, message: "requiredReviewers must be a unique spec/code array" };
  }
  return {
    ok: true,
    contract: {
      taskId,
      title,
      goal: coerceNonEmptyString(item.goal) ?? title,
      acceptanceCriteria: stringList(item.acceptanceCriteria),
      verification: stringList(item.verification),
      writeScope: stringList(item.writeScope),
      dependsOn: stringList(item.dependsOn),
      blockedBy: stringList(item.blockedBy),
      requiredReviewers: [...(reviewers as WorkflowReviewer[])],
    },
  };
}

function normalizeExecutionSource(raw: unknown): WorkflowExecutionSource | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const candidate = raw as Record<string, unknown>;
  if (candidate.kind === "conversation-scoped") return { kind: "conversation-scoped" };
  if (candidate.kind === "provided-plan") {
    const reference = coerceNonEmptyString(candidate.reference);
    if (!reference) return undefined;
    const sha256 = coerceNonEmptyString(candidate.sha256);
    return { kind: "provided-plan", reference, ...(sha256 ? { sha256 } : {}) };
  }
  // Native packages must register through work_checkpoint register with a
  // planPath; the generic descriptor never fabricates a native source.
  return undefined;
}

function normalizeBoundary(raw: unknown): WorkflowExecutionBoundary | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const candidate = raw as Record<string, unknown>;
  const files = stringList(candidate.files);
  const directories = stringList(candidate.directories);
  if (files.length === 0 && directories.length === 0) return undefined;
  return { files, directories };
}

function normalizeCheckpointContracts(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [];
}

function taskContractsFromItems(
  items: OpenInputItem[],
): { ok: true; contracts: WorkflowTaskContract[] } | { ok: false; message: string } {
  const contracts: WorkflowTaskContract[] = [];
  for (const item of items) {
    const normalized = normalizeTaskContract(item);
    if (!normalized.ok) return { ok: false, message: normalized.message };
    contracts.push(normalized.contract);
  }
  if (contracts.length === 0) {
    return { ok: false, message: "at least one task item is required" };
  }
  return { ok: true, contracts };
}
// END_BLOCK_GENERIC_NORMALIZATION

function normalizeOpenInputItem(
  item: OpenInputItem,
  sessionId: string,
):
  | { ok: true; input: OpenWorkItemInput }
  | { ok: false; errorCode: "INVALID_INPUT"; message: string } {
  const key = coerceNonEmptyString(item.key);
  const title = coerceNonEmptyString(item.title);
  if (!key || !title) {
    return {
      ok: false,
      errorCode: "INVALID_INPUT",
      message: "INVALID_INPUT: key and title must be non-empty strings",
    };
  }
  if (!isWorkItemMode(item.mode)) {
    return {
      ok: false,
      errorCode: "INVALID_INPUT",
      message: "INVALID_INPUT: mode must be implementation, review_only, or delegated",
    };
  }

  if (item.mode === "delegated") {
    const reviewers = Array.isArray(item.requiredReviewers) ? item.requiredReviewers : [];
    if (reviewers.length !== 0) {
      return {
        ok: false,
        errorCode: "INVALID_INPUT",
        message:
          "INVALID_INPUT: delegated mode requires an explicitly empty requiredReviewers array",
      };
    }
    const writeScope = Array.isArray(item.writeScope) ? item.writeScope.map(String) : [];
    if (writeScope.length === 0) {
      return {
        ok: false,
        errorCode: "INVALID_INPUT",
        message:
          "INVALID_INPUT: delegated mode requires a non-empty writeScope of workspace-relative files",
      };
    }
    const planRunId = coerceNonEmptyString(item.planRunId);
    const planTaskId = coerceNonEmptyString(item.planTaskId);
    if ((planRunId === undefined) !== (planTaskId === undefined)) {
      return {
        ok: false,
        errorCode: "INVALID_INPUT",
        message: "INVALID_INPUT: planRunId and planTaskId must be provided together",
      };
    }
    return {
      ok: true,
      input: {
        sessionId,
        key,
        title,
        mode: "delegated",
        requiredReviewers: [],
        writeScope,
        ...(planRunId && planTaskId ? { planRunId, planTaskId } : {}),
      },
    };
  }

  const requiredReviewers = canonicalizeReviewers(item.requiredReviewers);
  if (!requiredReviewers) {
    return {
      ok: false,
      errorCode: "INVALID_INPUT",
      message:
        "INVALID_INPUT: requiredReviewers must be a non-empty array containing unique spec/code reviewers",
    };
  }
  if (
    item.writeScope !== undefined ||
    item.planRunId !== undefined ||
    item.planTaskId !== undefined
  ) {
    return {
      ok: false,
      errorCode: "INVALID_INPUT",
      message: `INVALID_INPUT: writeScope and plan bindings are only valid for delegated mode, not ${item.mode}`,
    };
  }

  return {
    ok: true,
    input: {
      sessionId,
      key,
      title,
      mode: item.mode,
      requiredReviewers,
    },
  };
}

function serializeWorkItem(record: WorkItemRecord): Record<string, unknown> {
  return {
    workItemId: record.workItemId,
    header: `VVOC_WORK_ITEM_ID: ${record.workItemId}`,
    key: record.key,
    title: record.title,
    mode: record.mode,
    requiredReviewers: record.requiredReviewers,
    state: record.state,
    specReviewCount: record.specReviewCount,
    codeReviewCount: record.codeReviewCount,
    reviewRound: getReviewRound(record),
    currentRound: record.currentRound,
    ...(record.resultExcerpt ? { resultExcerpt: record.resultExcerpt } : {}),
    completedReviewRoundCount: record.completedReviewRoundCount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.closedAt ? { closedAt: record.closedAt } : {}),
    ...(record.delegated
      ? {
          delegated: {
            writeScope: record.delegated.writeScope,
            ...(record.delegated.planRunId
              ? { planRunId: record.delegated.planRunId, planTaskId: record.delegated.planTaskId }
              : {}),
            attempts: record.delegated.attempts.length,
            inFlightAttempt: record.delegated.attempts.some(
              (attempt) => attempt.status === "in_flight",
            ),
            decisions: record.delegated.decisions.length,
            accepted: currentDelegatedAcceptance(record) !== undefined,
            acceptedAttempt: currentDelegatedAcceptance(record)?.attempt,
            reworkCount: record.delegated.reworkHistory.length,
            ...serializeProgress(record),
          },
        }
      : {}),
  };
}

/** Recovery-aware progress fields shared by work-item serialization. */
function serializeProgress(record: WorkItemRecord): Record<string, unknown> {
  const progress = summarizeDelegatedProgress(record);
  return {
    attemptBudget: progress.attemptBudget,
    remainingAttempts: progress.remainingAttempts,
    recoveryCount: progress.recoveryGrants,
    autonomousGrantConsumed: progress.autonomousGrantConsumed,
    reportRejectionCount: progress.reportRejectedAttempts,
    nextAction: progress.nextAction,
  };
}

// START_CONTRACT: createWorkItemOpenTool
//   PURPOSE: Build work_item_open handler that supports deterministic batch idempotent open operations with explicit workflow intent.
//   INPUTS: { store: WorkItemStore - workflow in-memory store }
//   OUTPUTS: { WorkflowToolDefinition<OpenArgs, unknown> - executable tool definition }
//   SIDE_EFFECTS: [Mutates in-memory work-item store through open operations]
//   LINKS: [M-WORKFLOW-TOOLING, M-WORKFLOW-STATE]
// END_CONTRACT: createWorkItemOpenTool
export function createWorkItemOpenTool(
  store: WorkItemStore,
): WorkflowToolDefinition<OpenArgs, Record<string, unknown>> {
  return {
    name: "work_item_open",
    description:
      "Open one or more workflow work items idempotently with explicit mode and requiredReviewers.",
    execute: (args, context, overrideStore) => {
      const inputItems = Array.isArray(args.items) ? args.items : [];
      const runIdArg = coerceNonEmptyString(args.runId);
      const executionArg = args.execution;
      if (executionArg !== undefined && runIdArg !== undefined) {
        return {
          tool: "work_item_open",
          sessionId: context.sessionId,
          ok: false,
          errorCode: "INVALID_INPUT",
          message: "INVALID_INPUT: execution and runId are mutually exclusive",
        };
      }

      if (executionArg !== undefined || runIdArg !== undefined) {
        const s = overrideStore ?? store;
        const data = s.getStoreData();
        const contracts = taskContractsFromItems(inputItems);
        if (!contracts.ok) {
          return {
            tool: "work_item_open",
            sessionId: context.sessionId,
            ok: false,
            errorCode: "INVALID_INPUT",
            message: `INVALID_INPUT: ${contracts.message}`,
          };
        }

        if (executionArg !== undefined) {
          const descriptor =
            executionArg !== null && typeof executionArg === "object"
              ? (executionArg as Record<string, unknown>)
              : {};
          const executionKey = coerceNonEmptyString(descriptor.executionKey);
          const source = normalizeExecutionSource(descriptor.source);
          const boundary = normalizeBoundary(descriptor.boundary);
          const goal = coerceNonEmptyString(descriptor.goal);
          const workspaceRoot = coerceNonEmptyString(context.workspaceRoot);
          if (!executionKey || !source || !boundary || !goal || !workspaceRoot) {
            return {
              tool: "work_item_open",
              sessionId: context.sessionId,
              ok: false,
              errorCode: "INVALID_INPUT",
              message:
                "INVALID_INPUT: execution requires executionKey, source, goal, boundary, and the trusted workspace root",
            };
          }
          const registered = registerExecutionInStore(data, {
            sessionId: context.sessionId,
            workspaceRoot,
            executionKey,
            source,
            goal,
            boundary,
            tasks: contracts.contracts.map((contract) => ({ contract })),
            checkpoints: normalizeCheckpointContracts(descriptor.checkpoints) as never,
          });
          if (!registered.ok) {
            return {
              tool: "work_item_open",
              sessionId: context.sessionId,
              ok: false,
              errorCode: registered.errorCode,
              message: registered.message,
            };
          }
          return {
            tool: "work_item_open",
            sessionId: context.sessionId,
            ok: true,
            action: "register",
            runId: registered.runId,
            reused: registered.reused,
            execution: getExecutionView(registered.execution),
          };
        }

        const amendmentId = coerceNonEmptyString(args.amendmentId);
        const rationale = coerceNonEmptyString(args.rationale);
        if (!runIdArg || !amendmentId || !rationale) {
          return {
            tool: "work_item_open",
            sessionId: context.sessionId,
            ok: false,
            errorCode: "INVALID_INPUT",
            message: "INVALID_INPUT: runId append requires amendmentId and rationale",
          };
        }
        const appended = appendExecutionWorkInStore(data, {
          sessionId: context.sessionId,
          runId: runIdArg,
          amendmentId,
          rationale,
          tasks: contracts.contracts.map((contract) => ({ contract })),
        });
        if (!appended.ok) {
          return {
            tool: "work_item_open",
            sessionId: context.sessionId,
            ok: false,
            errorCode: appended.errorCode,
            message: appended.message,
          };
        }
        return {
          tool: "work_item_open",
          sessionId: context.sessionId,
          ok: true,
          action: "amend",
          runId: runIdArg,
          revision: appended.revision,
          execution: getExecutionView(appended.execution),
        };
      }

      const results = inputItems.map((item) => {
        const normalized = normalizeOpenInputItem(item, context.sessionId);
        if (!normalized.ok) {
          return {
            ok: false,
            errorCode: normalized.errorCode,
            message: normalized.message,
          };
        }

        const opened = openWorkItem(overrideStore ?? store, normalized.input);
        if (!opened.ok) {
          return {
            ok: false,
            errorCode: opened.errorCode,
            message: opened.message,
            existingWorkItemId: opened.existingWorkItemId,
          };
        }

        return {
          ok: true,
          reused: opened.reused,
          workItemId: opened.record.workItemId,
          header: opened.header,
          ...serializeWorkItem(opened.record),
        };
      });

      return {
        tool: "work_item_open",
        sessionId: context.sessionId,
        items: results,
      };
    },
  };
}

// START_CONTRACT: createWorkItemListTool
//   PURPOSE: Build work_item_list handler that returns current work items, explicit review-round metadata, and registered plan runs.
//   INPUTS: { store: WorkItemStore - workflow in-memory store }
//   OUTPUTS: { WorkflowToolDefinition<ListArgs, unknown> - executable tool definition }
//   SIDE_EFFECTS: [none]
//   LINKS: [M-WORKFLOW-TOOLING, M-WORKFLOW-STATE, M-WORKFLOW-CHECKPOINTS]
// END_CONTRACT: createWorkItemListTool
export function createWorkItemListTool(
  store: WorkItemStore,
): WorkflowToolDefinition<ListArgs, Record<string, unknown>> {
  return {
    name: "work_item_list",
    description: "List workflow work items for the current session.",
    execute: (args, context, overrideStore) => {
      const s = overrideStore ?? store;
      const includeClosed = args.includeClosed === true;
      const records = listWorkItems(s, context.sessionId, { includeClosed });
      const data = s.getStoreData();
      const planRuns = [...data.planRuns.values()]
        .filter((run) => run.sessionId === context.sessionId)
        .map((run) => getDelegatedRunView(data, run.runId))
        .filter((view): view is Record<string, unknown> => view !== undefined);
      return {
        tool: "work_item_list",
        sessionId: context.sessionId,
        includeClosed,
        items: records.map(serializeWorkItem),
        ...(planRuns.length > 0 ? { planRuns } : {}),
      };
    },
  };
}

// START_CONTRACT: createWorkItemCloseTool
//   PURPOSE: Build work_item_close handler that closes a ready_to_close work item.
//   INPUTS: { store: WorkItemStore - workflow in-memory store }
//   OUTPUTS: { WorkflowToolDefinition<CloseArgs, unknown> - executable tool definition }
//   SIDE_EFFECTS: [Mutates in-memory work-item store through close operations]
//   LINKS: [M-WORKFLOW-TOOLING, M-WORKFLOW-STATE]
// END_CONTRACT: createWorkItemCloseTool
export function createWorkItemCloseTool(
  store: WorkItemStore,
): WorkflowToolDefinition<CloseArgs, Record<string, unknown>> {
  return {
    name: "work_item_close",
    description: "Close a workflow work item by id when it is ready_to_close.",
    execute: (args, context, overrideStore) => {
      const s = overrideStore ?? store;
      const workItemId = coerceNonEmptyString(args.workItemId);
      if (!workItemId) {
        return {
          tool: "work_item_close",
          sessionId: context.sessionId,
          ok: false,
          errorCode: "INVALID_INPUT",
          message: "INVALID_INPUT: workItemId must be a non-empty string",
        };
      }

      const closed = closeWorkItem(s, context.sessionId, workItemId);
      if (!closed.ok) {
        return {
          tool: "work_item_close",
          sessionId: context.sessionId,
          ok: false,
          errorCode: closed.errorCode,
          message: closed.message,
        };
      }

      return {
        tool: "work_item_close",
        sessionId: context.sessionId,
        ok: true,
        workItemId: closed.record.workItemId,
        header: closed.header,
        state: closed.record.state,
        closedAt: closed.record.closedAt,
      };
    },
  };
}

// START_CONTRACT: createWorkItemDecideTool
//   PURPOSE: Build work_item_decide handler wrapping explicit controller acceptance, change requests, checkpoint-authorized rework, and bounded recovery.
//   INPUTS: { store: WorkItemStore - workflow in-memory store, options?: DelegatedControlOptions - optional read-only authorization lookup }
//   OUTPUTS: { WorkflowToolDefinition<DecideArgs, Promise<Record<string, unknown>>> - async executable control tool definition }
//   SIDE_EFFECTS: [Mutates delegated work-item state through the domain layer]
//   LINKS: [M-WORKFLOW-TOOLING, M-WORKFLOW-DELEGATED, M-WORKFLOW-CHECKPOINTS]
// END_CONTRACT: createWorkItemDecideTool
export function createWorkItemDecideTool(
  store: WorkItemStore,
  options?: DelegatedControlOptions,
): WorkflowToolDefinition<DecideArgs, Promise<Record<string, unknown>>> {
  return {
    name: "work_item_decide",
    description:
      "Accept or request changes for the current completed delegated attempt, authorize bounded rework of an accepted task from a failed checkpoint, or recover a stopped or exhausted unaccepted task with a bounded diagnosis and changed condition.",
    async execute(args, context, overrideStore) {
      const s = overrideStore ?? store;
      const workItemId = coerceNonEmptyString(args.workItemId);
      const decision = args.decision;
      const rationale = typeof args.rationale === "string" ? args.rationale : "";
      const evidence = Array.isArray(args.evidence) ? args.evidence.map(String) : [];

      if (!workItemId || typeof args.attempt !== "number" || !Number.isInteger(args.attempt)) {
        return {
          tool: "work_item_decide",
          sessionId: context.sessionId,
          ok: false,
          errorCode: "INVALID_INPUT",
          message: "INVALID_INPUT: workItemId and a positive integer attempt are required",
        };
      }

      if (decision === "rework") {
        const runId = coerceNonEmptyString(args.runId);
        const checkpointId = coerceNonEmptyString(args.checkpointId);
        if (!runId || !checkpointId) {
          return {
            tool: "work_item_decide",
            sessionId: context.sessionId,
            ok: false,
            errorCode: "INVALID_INPUT",
            message:
              "INVALID_INPUT: rework requires runId and checkpointId of the failed checkpoint",
          };
        }
        const reworked = authorizeReworkFromFailedCheckpoint(s, {
          sessionId: context.sessionId,
          workItemId,
          runId,
          checkpointId,
          reason: rationale,
        });
        if (!reworked.ok) {
          return {
            tool: "work_item_decide",
            sessionId: context.sessionId,
            ok: false,
            errorCode: reworked.errorCode,
            message: reworked.message,
          };
        }
        return {
          tool: "work_item_decide",
          sessionId: context.sessionId,
          ok: true,
          action: "rework",
          workItemId,
          reworkId: reworked.reworkId,
          grantedAttempts: reworked.grantedAttempts,
          state: s.getWorkItem(context.sessionId, workItemId)?.state,
        };
      }

      if (decision === "recover") {
        const recoveryId = coerceNonEmptyString(args.recoveryId);
        const diagnosis = typeof args.diagnosis === "string" ? args.diagnosis : "";
        const changedCondition =
          typeof args.changedCondition === "string" ? args.changedCondition : "";
        const verification = Array.isArray(args.verification) ? args.verification.map(String) : [];
        const userMessageId = coerceNonEmptyString(args.userMessageId);
        const authorityId = coerceNonEmptyString(args.authorityId);
        if (!recoveryId) {
          return {
            tool: "work_item_decide",
            sessionId: context.sessionId,
            ok: false,
            errorCode: "INVALID_INPUT",
            message:
              "INVALID_INPUT: recover requires a stable recoveryId, diagnosis, changedCondition, and verification references",
          };
        }
        let advanceGrantApproved = false;
        let advanceRunId: string | undefined;
        if (authorityId) {
          advanceRunId = coerceNonEmptyString(args.runId);
          if (!advanceRunId) {
            return {
              tool: "work_item_decide",
              sessionId: context.sessionId,
              ok: false,
              errorCode: "INVALID_INPUT",
              message: "INVALID_INPUT: authorityId recovery requires the owning runId",
            };
          }
          const execution = findExecution(s.getStoreData(), advanceRunId);
          const authority = execution?.authority.find((entry) => entry.authorityId === authorityId);
          if (!execution || !authority) {
            return {
              tool: "work_item_decide",
              sessionId: context.sessionId,
              ok: false,
              errorCode: "AUTHORITY_NOT_FOUND",
              message: `AUTHORITY_NOT_FOUND: no recorded authority ${authorityId} for ${advanceRunId}`,
            };
          }
          // Scope binding: the recovered item must be a task of the execution
          // whose reserve funds the recovery.
          if (![...execution.tasks.values()].some((task) => task.workItemId === workItemId)) {
            return {
              tool: "work_item_decide",
              sessionId: context.sessionId,
              ok: false,
              errorCode: "INVALID_INPUT",
              message: `INVALID_INPUT: work item ${workItemId} is not a task of execution ${advanceRunId}`,
            };
          }
          const proposed = proposeReserveDebit({
            authority,
            debits: execution.reserveDebits,
            recoveryId,
            targetKind: "task",
            targetId: workItemId,
          });
          // A failed proposal only means no advance unit is available; the
          // recovery may still be a cost-free resume or use an ordinary
          // allowance, so let the domain reducer decide.
          advanceGrantApproved = proposed.ok;
        }
        const recovered = await recoverDelegatedWorkItem(s, {
          sessionId: context.sessionId,
          workItemId,
          attempt: args.attempt,
          diagnosis,
          changedCondition,
          verification,
          recoveryId,
          ...(advanceGrantApproved ? { advanceGrantApproved: true } : {}),
          ...(userMessageId !== undefined
            ? { userMessageId, lookupUserMessage: options?.lookupUserMessage }
            : {}),
        });
        if (!recovered.ok) {
          return {
            tool: "work_item_decide",
            sessionId: context.sessionId,
            ok: false,
            errorCode: recovered.errorCode,
            message: recovered.message,
          };
        }
        if (recovered.kind === "advance_grant" && advanceRunId !== undefined) {
          const execution = findExecution(s.getStoreData(), advanceRunId);
          const authority = execution?.authority.find((entry) => entry.authorityId === authorityId);
          const proposed = authority
            ? proposeReserveDebit({
                authority,
                debits: execution?.reserveDebits ?? [],
                recoveryId,
                targetKind: "task",
                targetId: workItemId,
              })
            : undefined;
          if (!proposed?.ok) {
            return {
              tool: "work_item_decide",
              sessionId: context.sessionId,
              ok: false,
              errorCode: proposed?.code ?? "RESERVE_EXHAUSTED",
              message:
                proposed?.message ?? "advance recovery debit could not be recorded with the grant",
            };
          }
          const stored = addReserveDebitInStore(s.getStoreData(), {
            sessionId: context.sessionId,
            runId: advanceRunId,
            debit: proposed.value,
          });
          if (!stored.ok) {
            return {
              tool: "work_item_decide",
              sessionId: context.sessionId,
              ok: false,
              errorCode: stored.errorCode,
              message: stored.message,
            };
          }
        }
        return {
          tool: "work_item_decide",
          sessionId: context.sessionId,
          ok: true,
          action: "recover",
          workItemId,
          recoveryId: recovered.recoveryId,
          kind: recovered.kind,
          attemptBudget: recovered.attemptBudget,
          remainingAttempts: recovered.remainingAttempts,
          state: recovered.record.state,
          nextAction: summarizeDelegatedProgress(recovered.record).nextAction,
        };
      }

      if (decision !== "accept" && decision !== "request_changes") {
        return {
          tool: "work_item_decide",
          sessionId: context.sessionId,
          ok: false,
          errorCode: "INVALID_INPUT",
          message: "INVALID_INPUT: decision must be accept, request_changes, rework, or recover",
        };
      }

      const concernsDisposition =
        typeof args.concernsDisposition === "string" ? args.concernsDisposition : undefined;
      const decided = decideDelegatedWorkItem(s, {
        sessionId: context.sessionId,
        workItemId,
        attempt: args.attempt,
        decision,
        rationale,
        evidence,
        ...(concernsDisposition !== undefined ? { concernsDisposition } : {}),
      });
      if (!decided.ok) {
        return {
          tool: "work_item_decide",
          sessionId: context.sessionId,
          ok: false,
          errorCode: decided.errorCode,
          message: decided.message,
        };
      }
      return {
        tool: "work_item_decide",
        sessionId: context.sessionId,
        ok: true,
        action: decision,
        workItemId,
        attempt: args.attempt,
        decisionId: decided.decisionId,
        state: decided.record.state,
      };
    },
  };
}

export interface WorkCheckpointRegisterInput {
  action: "register";
  planPath: string;
}

export type WorkCheckpointInput =
  | WorkCheckpointRegisterInput
  | { action: "start"; runId: string; checkpointId: string }
  | { action: "verify"; runId: string; checkpointId: string; complete?: boolean }
  | {
      action: "recover";
      runId: string;
      checkpointId: string;
      diagnosis: string;
      changedCondition: string;
      verification: string[];
      recoveryId: string;
      userMessageId?: string;
    };

export type WorkCheckpointExecuteContext = WorkflowToolContext & {
  /** Trusted absolute workspace root used for plan loading and snapshots. */
  workspaceRoot: string;
  /** Loads the approved delegated plan package for register actions. */
  loadPlan: (
    planPath: string,
    workspaceRoot: string,
  ) => Promise<LoadedDelegatedPlan | { loadError: string }>;
};

// START_CONTRACT: executeGenericCheckpoint
//   PURPOSE: Execute one generic (non-native) checkpoint/authority action against the common execution registry.
//   INPUTS: { data, sessionId, runId, args, control? }
//   OUTPUTS: { Promise<Record<string, unknown>> - structured tool result }
//   SIDE_EFFECTS: [Mutates the common execution registry and may consult the SDK-backed authority lookup]
//   LINKS: [M-WORKFLOW-TOOLING, M-WORKFLOW-EXECUTION, M-WORKFLOW-AUTHORITY]
// END_CONTRACT: executeGenericCheckpoint
async function executeGenericCheckpoint(options: {
  data: WorkItemStoreData;
  sessionId: string;
  runId: string;
  args: CheckpointArgs;
  control?: DelegatedControlOptions;
}): Promise<Record<string, unknown>> {
  const { data, sessionId, runId, args } = options;
  const base: Record<string, unknown> = { tool: "work_checkpoint", sessionId, runId };
  const execution = findExecution(data, runId);
  if (!execution) {
    return {
      ...base,
      ok: false,
      errorCode: "EXECUTION_NOT_FOUND",
      message: `no execution ${runId}`,
    };
  }
  if (execution.sessionId !== sessionId) {
    return {
      ...base,
      ok: false,
      errorCode: "SESSION_MISMATCH",
      message: "execution belongs to another session",
    };
  }
  const amendmentId = coerceNonEmptyString(args.amendmentId);
  const rationale = coerceNonEmptyString(args.rationale);

  switch (args.action) {
    case "register":
    case "amend": {
      if (!amendmentId || !rationale) {
        return {
          ...base,
          ok: false,
          errorCode: "INVALID_INPUT",
          message: "generic register/amend requires amendmentId and rationale",
        };
      }
      const items = Array.isArray(args.tasks) ? (args.tasks as OpenInputItem[]) : [];
      const contracts =
        items.length > 0 ? taskContractsFromItems(items) : { ok: true as const, contracts: [] };
      if (!contracts.ok) {
        return { ...base, ok: false, errorCode: "INVALID_INPUT", message: contracts.message };
      }
      const appended = appendExecutionWorkInStore(data, {
        sessionId,
        runId,
        amendmentId,
        rationale,
        tasks: contracts.contracts.map((contract) => ({ contract })),
        checkpoints: normalizeCheckpointContracts(args.checkpoints) as never,
      });
      if (!appended.ok) {
        return { ...base, ok: false, errorCode: appended.errorCode, message: appended.message };
      }
      return {
        ...base,
        ok: true,
        action: "amend",
        revision: appended.revision,
        execution: getExecutionView(appended.execution),
      };
    }

    case "start": {
      const checkpointId = coerceNonEmptyString(args.checkpointId);
      if (!checkpointId) {
        return {
          ...base,
          ok: false,
          errorCode: "INVALID_INPUT",
          message: "start requires checkpointId",
        };
      }
      const startFingerprint = coerceNonEmptyString(args.startFingerprint);
      const started = startGenericCheckpointInStore(data, {
        sessionId,
        runId,
        checkpointId,
        ...(startFingerprint ? { startFingerprint } : {}),
      });
      if (!started.ok) {
        return { ...base, ok: false, errorCode: started.errorCode, message: started.message };
      }
      return {
        ...base,
        ok: true,
        action: "start",
        checkpointId,
        generation: started.checkpoint.currentReview?.generation,
        reviewWorkItemId: started.reviewWorkItemId,
        header: started.header,
        reviewersToLaunch: started.reviewers,
        coveredAttemptIds: started.coveredAttemptIds,
      };
    }

    case "review":
    case "bind":
    case "verify": {
      const checkpointId = coerceNonEmptyString(args.checkpointId);
      if (!checkpointId) {
        return {
          ...base,
          ok: false,
          errorCode: "INVALID_INPUT",
          message: "checkpointId is required",
        };
      }
      const reviewer = coerceNonEmptyString(args.reviewer);
      if (reviewer !== undefined && reviewer !== "spec" && reviewer !== "code") {
        return {
          ...base,
          ok: false,
          errorCode: "INVALID_INPUT",
          message: "reviewer must be spec or code",
        };
      }
      // The reviewer status is read from the linked review_only work item's
      // recorded round; callers cannot assert a reviewer outcome directly.
      const recorded = recordGenericReviewerResultInStore(data, {
        sessionId,
        runId,
        checkpointId,
        ...(reviewer ? { reviewer } : {}),
      });
      if (!recorded.ok) {
        return { ...base, ok: false, errorCode: recorded.errorCode, message: recorded.message };
      }
      return {
        ...base,
        ok: true,
        action: args.action,
        checkpointId,
        ...(reviewer ? { reviewer } : {}),
        outcome: recorded.outcome,
        checkpointStatus: recorded.checkpoint.status,
      };
    }

    case "recover": {
      const checkpointId = coerceNonEmptyString(args.checkpointId);
      const recoveryId = coerceNonEmptyString(args.recoveryId);
      const diagnosis = typeof args.diagnosis === "string" ? args.diagnosis : "";
      const changedCondition =
        typeof args.changedCondition === "string" ? args.changedCondition : "";
      const verification = stringList(args.verification);
      const authorityId = coerceNonEmptyString(args.authorityId);
      if (!checkpointId || !recoveryId) {
        return {
          ...base,
          ok: false,
          errorCode: "INVALID_INPUT",
          message: "generic checkpoint recovery requires checkpointId and recoveryId",
        };
      }
      const checkpointBinding = execution.checkpoints.get(checkpointId);
      const stopped = checkpointBinding?.stoppedAtGeneration !== undefined;
      // Validate and reserve the advance unit BEFORE mutating the checkpoint,
      // so a failed debit can never leave a granted generation behind.
      let reservedDebit: WorkflowReserveDebit | undefined;
      if (!stopped) {
        if (!authorityId) {
          return {
            ...base,
            ok: false,
            errorCode: "INVALID_INPUT",
            message: "an exhausted generic checkpoint requires an authorityId to recover",
          };
        }
        const authority = execution.authority.find((entry) => entry.authorityId === authorityId);
        if (!authority) {
          return {
            ...base,
            ok: false,
            errorCode: "AUTHORITY_NOT_FOUND",
            message: `AUTHORITY_NOT_FOUND: no recorded authority ${authorityId}`,
          };
        }
        const proposed = proposeReserveDebit({
          authority,
          debits: execution.reserveDebits,
          recoveryId,
          targetKind: "checkpoint",
          targetId: checkpointId,
        });
        if (!proposed.ok) {
          return { ...base, ok: false, errorCode: proposed.code, message: proposed.message };
        }
        reservedDebit = proposed.value;
      }
      const recovered = recoverGenericCheckpointInStore(data, {
        sessionId,
        runId,
        checkpointId,
        recoveryId,
        diagnosis,
        changedCondition,
        verification,
        authorityGrant: reservedDebit !== undefined,
      });
      if (!recovered.ok) {
        return { ...base, ok: false, errorCode: recovered.errorCode, message: recovered.message };
      }
      if (recovered.kind === "advance_grant" && reservedDebit) {
        const stored = addReserveDebitInStore(data, {
          sessionId,
          runId,
          debit: reservedDebit,
        });
        if (!stored.ok) {
          return { ...base, ok: false, errorCode: stored.errorCode, message: stored.message };
        }
      }
      return {
        ...base,
        ok: true,
        action: "recover",
        checkpointId,
        recoveryId,
        kind: recovered.kind,
        checkpointStatus: recovered.checkpoint.status,
      };
    }

    case "complete": {
      const completed = completeExecutionInStore(data, {
        sessionId,
        runId,
        rationale: rationale ?? "Generic execution completed with controller acceptance.",
        evidence: stringList(args.verification),
      });
      if (!completed.ok) {
        return { ...base, ok: false, errorCode: completed.errorCode, message: completed.message };
      }
      return {
        ...base,
        ok: true,
        action: "complete",
        reviewStatus: completed.reviewStatus,
        execution: getExecutionView(completed.execution),
      };
    }

    case "authorize": {
      const authorityId = coerceNonEmptyString(args.authorityId);
      const messageId = coerceNonEmptyString(args.messageId);
      const stagesArg = Array.isArray(args.stages) ? args.stages : [];
      const stages = stagesArg.filter(
        (stage): stage is WorkflowAuthorityStage =>
          stage === "specification" ||
          stage === "planning" ||
          stage === "implementation" ||
          stage === "verification",
      );
      if (!authorityId || !messageId || stages.length === 0) {
        return {
          ...base,
          ok: false,
          errorCode: "INVALID_INPUT",
          message: "authorize requires authorityId, messageId, and explicit stages",
        };
      }
      const lookup = options.control?.lookupAuthorityMessage;
      if (!lookup) {
        return {
          ...base,
          ok: false,
          errorCode: "INVALID_INPUT",
          message: "authorize requires the SDK-backed authorization lookup",
        };
      }
      const message = await lookup({ sessionId, runId, messageId });
      if (!message) {
        return {
          ...base,
          ok: false,
          errorCode: "AUTHORITY_DENIED",
          message:
            "authorization message could not be verified as an eligible root-user instruction",
        };
      }
      const existingAuthority = execution.authority.find(
        (entry) => entry.authorityId === authorityId,
      );
      if (existingAuthority) {
        if (existingAuthority.grantedByMessageId === messageId) {
          // Idempotent replay of the originating registration.
          return {
            ...base,
            ok: true,
            action: "authorize",
            authorityId,
            reused: true,
            units: existingAuthority.initialUnits,
            availableUnits: advanceUnitsAvailable(existingAuthority, execution.reserveDebits),
          };
        }
        const extended = extendAdvanceAuthority({
          authority: existingAuthority,
          extensionId: `ext-${messageId}`,
          sessionId,
          message,
          messageClaims: data.messageClaims,
        });
        if (!extended.ok) {
          return { ...base, ok: false, errorCode: extended.code, message: extended.message };
        }
        const updated = {
          ...existingAuthority,
          extensions: [...existingAuthority.extensions, extended.value],
        };
        const storedExtension = putAuthorityInStore(data, { sessionId, runId, authority: updated });
        if (!storedExtension.ok) {
          return {
            ...base,
            ok: false,
            errorCode: storedExtension.errorCode,
            message: storedExtension.message,
          };
        }
        return {
          ...base,
          ok: true,
          action: "authorize",
          authorityId,
          extensions: updated.extensions.length,
          availableUnits: advanceUnitsAvailable(updated, execution.reserveDebits),
        };
      }
      const granted = grantAdvanceAuthority({
        authorityId,
        runId,
        sessionId,
        message,
        scope: {
          stages,
          decisionScope: coerceNonEmptyString(args.decisionScope) ?? "",
          fileBoundary: stringList(args.fileBoundary),
          reservedStops: stringList(args.reservedStops).filter(
            (stage): stage is WorkflowAuthorityStage =>
              stage === "specification" ||
              stage === "planning" ||
              stage === "implementation" ||
              stage === "verification",
          ),
        },
        existingAuthorities: execution.authority,
        messageClaims: data.messageClaims,
      });
      if (!granted.ok) {
        return { ...base, ok: false, errorCode: granted.code, message: granted.message };
      }
      const stored = addAuthorityInStore(data, {
        sessionId,
        runId,
        authority: granted.value.record,
        claim: granted.value.claim,
      });
      if (!stored.ok) {
        return { ...base, ok: false, errorCode: stored.errorCode, message: stored.message };
      }
      return {
        ...base,
        ok: true,
        action: "authorize",
        authorityId,
        units: granted.value.record.initialUnits,
        availableUnits: advanceUnitsAvailable(granted.value.record, []),
      };
    }

    case "record_approval": {
      const authorityId = coerceNonEmptyString(args.authorityId);
      const approvalId = coerceNonEmptyString(args.approvalId);
      const stage = coerceNonEmptyString(args.stage) as WorkflowAuthorityStage | undefined;
      const artifactPath = coerceNonEmptyString(args.artifactPath);
      const artifactSha256 = coerceNonEmptyString(args.artifactSha256);
      const authority = execution.authority.find((entry) => entry.authorityId === authorityId);
      if (!authority || !approvalId || !stage || !artifactPath || !artifactSha256) {
        return {
          ...base,
          ok: false,
          errorCode: "INVALID_INPUT",
          message:
            "record_approval requires a recorded authorityId, approvalId, stage, artifactPath, and artifactSha256",
        };
      }
      const approval = proposeStageApproval({
        authority,
        approvalId,
        stage,
        artifactPath,
        artifactSha256,
        provenance: "controller_delegated",
      });
      if (!approval.ok) {
        return { ...base, ok: false, errorCode: approval.code, message: approval.message };
      }
      const stored = addStageApprovalInStore(data, {
        sessionId,
        runId,
        approval: approval.value,
      });
      if (!stored.ok) {
        return { ...base, ok: false, errorCode: stored.errorCode, message: stored.message };
      }
      return {
        ...base,
        ok: true,
        action: "record_approval",
        approvalId,
        stage,
        provenance: approval.value.provenance,
      };
    }

    case "revoke_authority": {
      const authorityId = coerceNonEmptyString(args.authorityId);
      const revocationId = coerceNonEmptyString(args.revocationId);
      const authority = execution.authority.find((entry) => entry.authorityId === authorityId);
      if (!authority || !revocationId) {
        return {
          ...base,
          ok: false,
          errorCode: "INVALID_INPUT",
          message: "revoke_authority requires a recorded authorityId and a revocationId",
        };
      }
      const stagesArg = Array.isArray(args.stages) ? args.stages : undefined;
      const revoked =
        stagesArg === undefined || stagesArg.length === 0
          ? revokeAdvanceAuthority({
              authority,
              revocationId,
              reason: coerceNonEmptyString(args.rationale) ?? "revoked",
            })
          : narrowAdvanceAuthority({
              authority,
              revocationId,
              reason: coerceNonEmptyString(args.rationale) ?? "narrowed",
              narrowedStages: stagesArg.filter(
                (stage): stage is WorkflowAuthorityStage =>
                  stage === "specification" ||
                  stage === "planning" ||
                  stage === "implementation" ||
                  stage === "verification",
              ),
            });
      if (!revoked.ok) {
        return { ...base, ok: false, errorCode: revoked.code, message: revoked.message };
      }
      const updated = {
        ...authority,
        revocations: [...authority.revocations, revoked.value],
      };
      const stored = putAuthorityInStore(data, { sessionId, runId, authority: updated });
      if (!stored.ok) {
        return { ...base, ok: false, errorCode: stored.errorCode, message: stored.message };
      }
      return {
        ...base,
        ok: true,
        action: "revoke_authority",
        authorityId,
        kind: revoked.value.kind,
        availableUnits: advanceUnitsAvailable(
          updated,
          data.executions.get(runId)?.reserveDebits ?? [],
        ),
        stages: effectiveAuthorityStages(updated),
      };
    }

    default:
      return {
        ...base,
        ok: false,
        errorCode: "INVALID_INPUT",
        message: `unsupported generic checkpoint action ${String(args.action)}`,
      };
  }
}

// START_CONTRACT: createWorkCheckpointTool
//   PURPOSE: Build work_checkpoint handler wrapping plan registration, checkpoint start, fingerprint-verified outcomes, and bounded checkpoint recovery.
//   INPUTS: { store: WorkItemStore - workflow in-memory store, options?: DelegatedControlOptions - optional read-only authorization lookup }
//   OUTPUTS: { WorkflowToolDefinition<CheckpointArgs, Promise<Record<string, unknown>>> - async executable control tool definition }
//   SIDE_EFFECTS: [Registers plan runs and mutates checkpoint state through the domain layer]
//   LINKS: [M-WORKFLOW-TOOLING, M-WORKFLOW-CHECKPOINTS, M-WORKFLOW-DELEGATED]
// END_CONTRACT: createWorkCheckpointTool
export function createWorkCheckpointTool(
  store: WorkItemStore,
  options?: DelegatedControlOptions,
): WorkflowToolDefinition<CheckpointArgs, Promise<Record<string, unknown>>> {
  return {
    name: "work_checkpoint",
    description:
      "Register an approved delegated plan, start a declared review checkpoint, verify checkpoint outcomes, or recover a stopped or generation-exhausted checkpoint; verify with complete: true seals a finished final checkpoint.",
    async execute(args, context, overrideStore) {
      const s = overrideStore ?? store;
      const action = args.action;
      if (action === "register" && coerceNonEmptyString(args.planPath)) {
        const planPath = coerceNonEmptyString(args.planPath)!;
        const workspaceRoot = coerceNonEmptyString(
          (context as WorkCheckpointExecuteContext).workspaceRoot,
        );
        if (!planPath || !workspaceRoot) {
          return {
            tool: "work_checkpoint",
            sessionId: context.sessionId,
            ok: false,
            errorCode: "INVALID_INPUT",
            message: "INVALID_INPUT: register requires a planPath and the trusted workspace root",
          };
        }
        const load = (context as WorkCheckpointExecuteContext).loadPlan;
        if (typeof load !== "function") {
          return {
            tool: "work_checkpoint",
            sessionId: context.sessionId,
            ok: false,
            errorCode: "INVALID_INPUT",
            message: "INVALID_INPUT: register requires a plan loader bound to the plugin context",
          };
        }
        const loaded = await load(planPath, workspaceRoot);
        if ("loadError" in loaded) {
          return {
            tool: "work_checkpoint",
            sessionId: context.sessionId,
            ok: false,
            errorCode: "PLAN_LOAD_FAILED",
            message: loaded.loadError,
          };
        }
        const registered = registerDelegatedPlan(s, {
          sessionId: context.sessionId,
          plan: loaded,
        });
        if (!registered.ok) {
          return {
            tool: "work_checkpoint",
            sessionId: context.sessionId,
            ok: false,
            errorCode: registered.errorCode,
            message: registered.message,
          };
        }
        return {
          tool: "work_checkpoint",
          sessionId: context.sessionId,
          ok: true,
          action: "register",
          runId: registered.runId,
          reused: registered.reused,
          tasks: registered.run.tasks.size,
          checkpoints: registered.run.checkpoints.size,
        };
      }

      const genericRunId = coerceNonEmptyString(args.runId);
      if (genericRunId) {
        const data = s.getStoreData();
        const execution = findExecution(data, genericRunId);
        // Authority actions apply to any execution, including native runs;
        // other generic actions stay on non-native executions.
        const authorityAction =
          action === "authorize" || action === "record_approval" || action === "revoke_authority";
        if (execution && (execution.source.kind !== "native-package" || authorityAction)) {
          return executeGenericCheckpoint({
            data,
            sessionId: context.sessionId,
            runId: genericRunId,
            args,
            ...(options ? { control: options } : {}),
          });
        }
      }

      const runId = coerceNonEmptyString(args.runId);
      const checkpointId = coerceNonEmptyString(args.checkpointId);
      if (!runId || !checkpointId) {
        return {
          tool: "work_checkpoint",
          sessionId: context.sessionId,
          ok: false,
          errorCode: "INVALID_INPUT",
          message: "INVALID_INPUT: start and verify require runId and checkpointId",
        };
      }

      if (action === "start") {
        const started = await startDelegatedCheckpoint(s, {
          sessionId: context.sessionId,
          runId,
          checkpointId,
        });
        if (!started.ok) {
          return {
            tool: "work_checkpoint",
            sessionId: context.sessionId,
            ok: false,
            errorCode: started.errorCode,
            message: started.message,
          };
        }
        return {
          tool: "work_checkpoint",
          sessionId: context.sessionId,
          ok: true,
          action: "start",
          runId,
          checkpointId,
          generation: started.generation,
          reviewWorkItemId: started.reviewWorkItemId,
          header: started.header,
          reviewersToLaunch: started.reviewersToLaunch,
        };
      }

      if (action === "verify") {
        const verified = await verifyDelegatedCheckpoint(s, {
          sessionId: context.sessionId,
          runId,
          checkpointId,
          ...(args.complete === true ? { complete: true } : {}),
        });
        if (!verified.ok) {
          return {
            tool: "work_checkpoint",
            sessionId: context.sessionId,
            ok: false,
            errorCode: verified.errorCode,
            message: verified.message,
          };
        }
        return {
          tool: "work_checkpoint",
          sessionId: context.sessionId,
          ok: true,
          action: "verify",
          runId,
          checkpointId,
          outcome: verified.outcome,
          snapshotCurrent: verified.snapshotCurrent,
          ...(verified.sealedRun !== undefined ? { sealedRun: verified.sealedRun } : {}),
        };
      }

      if (action === "recover") {
        const recoveryId = coerceNonEmptyString(args.recoveryId);
        const diagnosis = typeof args.diagnosis === "string" ? args.diagnosis : "";
        const changedCondition =
          typeof args.changedCondition === "string" ? args.changedCondition : "";
        const verification = Array.isArray(args.verification) ? args.verification.map(String) : [];
        const userMessageId = coerceNonEmptyString(args.userMessageId);
        if (!recoveryId) {
          return {
            tool: "work_checkpoint",
            sessionId: context.sessionId,
            ok: false,
            errorCode: "INVALID_INPUT",
            message:
              "INVALID_INPUT: recover requires a stable recoveryId, diagnosis, changedCondition, and verification references",
          };
        }
        const authorityId = coerceNonEmptyString(args.authorityId);
        let advanceGrantApproved = false;
        if (authorityId) {
          const execution = findExecution(s.getStoreData(), runId);
          const authority = execution?.authority.find((entry) => entry.authorityId === authorityId);
          if (!execution || !authority) {
            return {
              tool: "work_checkpoint",
              sessionId: context.sessionId,
              ok: false,
              errorCode: "AUTHORITY_NOT_FOUND",
              message: `AUTHORITY_NOT_FOUND: no recorded authority ${authorityId} for ${runId}`,
            };
          }
          const proposed = proposeReserveDebit({
            authority,
            debits: execution.reserveDebits,
            recoveryId,
            targetKind: "checkpoint",
            targetId: checkpointId,
          });
          // A failed proposal only means no advance unit is available; the
          // recovery may still be a cost-free resume or an ordinary grant.
          advanceGrantApproved = proposed.ok;
        }
        const recovered = await recoverDelegatedCheckpoint(s, {
          sessionId: context.sessionId,
          runId,
          checkpointId,
          diagnosis,
          changedCondition,
          verification,
          recoveryId,
          ...(advanceGrantApproved ? { advanceGrantApproved: true } : {}),
          ...(userMessageId !== undefined
            ? { userMessageId, lookupUserMessage: options?.lookupUserMessage }
            : {}),
        });
        if (!recovered.ok) {
          return {
            tool: "work_checkpoint",
            sessionId: context.sessionId,
            ok: false,
            errorCode: recovered.errorCode,
            message: recovered.message,
          };
        }
        if (recovered.kind === "advance_grant" && authorityId) {
          const execution = findExecution(s.getStoreData(), runId);
          const authority = execution?.authority.find((entry) => entry.authorityId === authorityId);
          const proposed = authority
            ? proposeReserveDebit({
                authority,
                debits: execution?.reserveDebits ?? [],
                recoveryId,
                targetKind: "checkpoint",
                targetId: checkpointId,
              })
            : undefined;
          if (!proposed?.ok) {
            return {
              tool: "work_checkpoint",
              sessionId: context.sessionId,
              ok: false,
              errorCode: proposed?.code ?? "RESERVE_EXHAUSTED",
              message:
                proposed?.message ?? "advance checkpoint recovery debit could not be recorded",
            };
          }
          const stored = addReserveDebitInStore(s.getStoreData(), {
            sessionId: context.sessionId,
            runId,
            debit: proposed.value,
          });
          if (!stored.ok) {
            return {
              tool: "work_checkpoint",
              sessionId: context.sessionId,
              ok: false,
              errorCode: stored.errorCode,
              message: stored.message,
            };
          }
        }
        return {
          tool: "work_checkpoint",
          sessionId: context.sessionId,
          ok: true,
          action: "recover",
          runId,
          checkpointId,
          recoveryId: recovered.recoveryId,
          kind: recovered.kind,
          generationBudget: recovered.generationBudget,
          ...(recovered.settledStoppedGeneration !== undefined
            ? { settledStoppedGeneration: recovered.settledStoppedGeneration }
            : {}),
          checkpointStatus: recovered.checkpoint.status,
          lastOutcome: recovered.checkpoint.lastOutcome,
        };
      }

      return {
        tool: "work_checkpoint",
        sessionId: context.sessionId,
        ok: false,
        errorCode: "INVALID_INPUT",
        message: "INVALID_INPUT: action must be register, start, verify, or recover",
      };
    },
  };
}
