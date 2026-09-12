// FILE: src/plugins/workflow/tooling.ts
// VERSION: 0.4.0
// START_MODULE_CONTRACT
//   PURPOSE: Provide work-item tooling handlers that wrap explicit workflow state operations with structured protocol-friendly responses.
//   SCOPE: work_item_open, work_item_list, and work_item_close tool definitions with delegated-mode open validation and mode-specific serialization including recovery-aware progress summaries; work_item_decide and work_checkpoint control-tool definitions wrapping delegated decisions, plan registration, checkpoint start/verify, failed-checkpoint rework authorization, and bounded recover for stopped or exhausted targets with optional root-user message authorization through a read-only lookup.
//   DEPENDS: [src/plugins/workflow/checkpoint-io.ts, src/plugins/workflow/checkpoints.ts, src/plugins/workflow/delegated.ts, src/plugins/workflow/state.ts]
//   LINKS: M-WORKFLOW-TOOLING, M-WORKFLOW-DELEGATED, M-WORKFLOW-CHECKPOINTS, M-PLUGIN-WORKFLOW
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
//   createWorkCheckpointTool - Creates work_checkpoint control wrapper around plan registration, checkpoint start, verify, and checkpoint recovery.
//   DecideArgs - work_item_decide tool argument shape.
//   CheckpointArgs - work_checkpoint tool argument shape.
//   WorkCheckpointRegisterInput - Register-action input discriminator.
//   WorkCheckpointInput - work_checkpoint action input union.
//   WorkCheckpointExecuteContext - Extended execution context carrying the trusted workspace root and plan loader.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-WORKFLOW-BOUNDED-RECOVERY-R1 - Added decision recover and work_checkpoint action recover with bounded recovery text, stable recoveryId, optional userMessageId authorization, and recovery-aware inspection output.]
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
import type { LoadedDelegatedPlan } from "./checkpoint-io.js";

export type WorkflowToolContext = {
  sessionId: string;
};

export type WorkflowToolDefinition<TArgs, TResult> = {
  name: string;
  description: string;
  execute: (args: TArgs, context: WorkflowToolContext, store?: WorkItemStore) => TResult;
};

/** Optional read-only authorization lookup bound to the plugin SDK client. */
export interface DelegatedControlOptions {
  lookupUserMessage?: LookupRecoveryUserMessage;
}

type OpenInputItem = {
  key?: unknown;
  title?: unknown;
  mode?: unknown;
  requiredReviewers?: unknown;
  writeScope?: unknown;
  planRunId?: unknown;
  planTaskId?: unknown;
};

type OpenArgs = {
  items: OpenInputItem[];
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
};

export type CheckpointArgs = {
  action: "register" | "start" | "verify" | "recover";
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
        const recovered = await recoverDelegatedWorkItem(s, {
          sessionId: context.sessionId,
          workItemId,
          attempt: args.attempt,
          diagnosis,
          changedCondition,
          verification,
          recoveryId,
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
      if (action === "register") {
        const planPath = coerceNonEmptyString(args.planPath);
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
        const recovered = await recoverDelegatedCheckpoint(s, {
          sessionId: context.sessionId,
          runId,
          checkpointId,
          diagnosis,
          changedCondition,
          verification,
          recoveryId,
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
