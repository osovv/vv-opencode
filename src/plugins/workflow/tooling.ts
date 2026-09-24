// FILE: src/plugins/workflow/tooling.ts
// VERSION: 0.6.0
// START_MODULE_CONTRACT
//   PURPOSE: Provide work-item tooling handlers that wrap explicit workflow state operations with structured protocol-friendly responses under strict branch-aware input validation.
//   SCOPE: work_item_open, work_item_list, and work_item_close tool definitions with standalone/generic open validation and mode-specific serialization including recovery-aware progress summaries; generic execution registration/append through an optional execution descriptor or runId with typed sources, boundaries, tasks, and checkpoints; work_item_decide and work_checkpoint control-tool definitions wrapping delegated decisions, native plan registration, checkpoint start/verify, failed-checkpoint rework authorization, bounded recover for stopped or exhausted targets with optional root-user message authorization through a read-only lookup, and the generic (non-native) checkpoint, completion, amendment, advance-authority, stage-approval, and revocation actions. Every handler validates raw arguments through validateWorkflowToolInput before dispatch or mutation and then consumes the parsed canonical values; provided-plan references/hashes are trimmed so source identity stays idempotent, run session ownership is resolved before any source-specific diagnostic or action discrimination, source-dependent known fields are rejected only after an owned run's source is resolved, authority replay/extension compares the supplied scope against the recorded scope, and unknown runs fail as lookup failures rather than missing native-only fields. Tool argument shapes are single-sourced from src/plugins/workflow/schemas.ts.
//   DEPENDS: [src/plugins/workflow/checkpoint-io.ts, src/plugins/workflow/checkpoints.ts, src/plugins/workflow/delegated.ts, src/plugins/workflow/execution.ts, src/plugins/workflow/authority.ts, src/plugins/workflow/input-validation.ts, src/plugins/workflow/schemas.ts, src/plugins/workflow/results.ts, src/lib/agent-tool-contract.ts, src/lib/workflow-contract.ts, src/plugins/workflow/state.ts]
//   LINKS: M-WORKFLOW-TOOLING, M-WORKFLOW-DELEGATED, M-WORKFLOW-CHECKPOINTS, M-WORKFLOW-EXECUTION, M-WORKFLOW-AUTHORITY, M-WORKFLOW-CONTRACT, M-AGENT-TOOL-CONTRACT, M-PLUGIN-WORKFLOW
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   WorkflowToolContext - Minimal execution context required by workflow tools.
//   WorkflowToolDefinition - Deterministic tool definition shape with an optionally async execute handler.
//   DelegatedControlOptions - Optional read-only authorization lookup bound to the plugin SDK client.
//   createWorkItemOpenTool - Creates work_item_open tool wrapper around explicit openWorkItem contract including standalone delegated tasks and generic execution registration/append.
//   createWorkItemListTool - Creates work_item_list tool wrapper returning the additive read-only inspection payload (items, plan runs, executions, loaded contract identity).
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
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-004 - work_item_list delegates to the read-only inspection owner; every handler that reports a delegated next action (open, failure context, recovery) now composes the same deriveDelegatedGuidance as the list so responses cannot contradict it, and generic register/amend plus checkpoint amend/complete execution views pass live store data so task status derives from current acceptance. Prior T-003: every handler result is finalized so failures carry a stable category. A missing trusted workspace root/plan loader/authorization lookup is a distinct host_context failure instead of INVALID_INPUT.]
// END_CHANGE_SUMMARY

import {
  closeWorkItem,
  openWorkItem,
  type OpenWorkItemInput,
  type WorkItemRecord,
  type WorkItemStore,
  type WorkItemStoreData,
} from "./state.js";
import {
  authorizeReworkFromFailedCheckpoint,
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
  latestAttemptView,
  recordGenericReviewerResultInStore,
  recoverGenericCheckpointInStore,
  putAuthorityInStore,
  registerExecutionInStore,
  startGenericCheckpointInStore,
} from "./execution.js";
import {
  advanceUnitsAvailable,
  authorityScopeDifferences,
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
  WorkflowAuthorityScope,
  WorkflowExecutionSource,
  WorkflowReserveDebit,
  WorkflowReviewer,
  WorkflowTaskContract,
  WorkflowCheckpointContract,
} from "../../lib/workflow-contract.js";
import {
  validateExecutionBoundary,
  validateWorkflowCheckpointContract,
} from "../../lib/workflow-contract.js";
import { type ContractIssue } from "../../lib/agent-tool-contract.js";
import { WORKFLOW_TOOL_DESCRIPTIONS, validateWorkflowToolInput } from "./input-validation.js";
import { getWorkflowInspection, deriveDelegatedGuidance, serializeWorkItem } from "./inspection.js";
import {
  finalizeWorkflowResult,
  workflowHostContextFailure,
  workflowInputFailure,
  type WorkflowFailureResult,
} from "./results.js";
import type {
  CheckpointArgs,
  CloseArgs,
  DecideArgs,
  ListArgs,
  OpenExecutionInput,
  OpenItemInput,
} from "./schemas.js";

// Argument shapes are single-sourced with the plugin registrations in index.ts
// through the schemas module; re-export them here for existing importers.
export type { CheckpointArgs, DecideArgs } from "./schemas.js";

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

/**
 * work_item_open wrapper input. Deliberately looser than the registered
 * schema shape in schemas.ts: this wrapper is the defensive validator for
 * partially-shaped caller input, so item and descriptor fields stay unknown
 * here and are rejected by validateWorkflowToolInput before any dispatch.
 */
type OpenToolInput = {
  items: unknown;
  /** Generic execution descriptor; mutually exclusive with runId. */
  execution?: unknown;
  /** Append tasks to an existing generic execution. */
  runId?: unknown;
  amendmentId?: unknown;
  rationale?: unknown;
};

function coerceNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function invalidInput(
  tool: string,
  sessionId: string,
  issues: readonly ContractIssue[],
): WorkflowFailureResult {
  // Preserve the exact bounded tokenized issues; the early execute.before hook
  // throws the same ContractInputError form, so hook and handler agree.
  return workflowInputFailure(tool, sessionId, issues);
}

/** A missing trusted workspace root/plan loader/authorization lookup is host context, not caller input. */
function hostContextInvalid(
  tool: string,
  sessionId: string,
  message: string,
): WorkflowFailureResult {
  return workflowHostContextFailure(tool, sessionId, message);
}

// START_BLOCK_RESULT_FINALIZATION
/**
 * Finalize one handler result so failures carry a stable category, bounded
 * prerequisite, and (where owned state is known) concrete current-state,
 * attempt, status, and budget context. Batch item failures are finalized too.
 */
function withFinalizedResult<TArgs>(
  definition: WorkflowToolDefinition<TArgs, Record<string, unknown>>,
): WorkflowToolDefinition<TArgs, Record<string, unknown>> {
  const execute = definition.execute;
  return {
    ...definition,
    execute: (args, context, store) => finalizeWorkflowResult(execute(args, context, store)),
  };
}

/** Async variant of `withFinalizedResult` for control tools. */
function withFinalizedAsyncResult<TArgs>(
  definition: WorkflowToolDefinition<TArgs, Promise<Record<string, unknown>>>,
): WorkflowToolDefinition<TArgs, Promise<Record<string, unknown>>> {
  const execute = definition.execute;
  return {
    ...definition,
    async execute(args, context, store) {
      return finalizeWorkflowResult(await execute(args, context, store));
    },
  };
}

/**
 * Compose the shared delegated guidance for one owned record so every response
 * that reports a next action (list, open, failure, recovery) uses the same
 * snapshot-level gates and can never contradict the list view.
 */
function delegatedGuidanceFor(store: WorkItemStore, sessionId: string, record: WorkItemRecord) {
  return deriveDelegatedGuidance({
    record,
    progress: summarizeDelegatedProgress(record),
    latest: latestAttemptView(record),
    context: { data: store.getStoreData(), sessionId },
  });
}

/**
 * Bounded current-state context for an owned same-session work-item failure.
 * Read only after access checks; it never dumps the private store or foreign
 * records, and it is composed from existing eligibility helpers.
 */
function ownedWorkItemFailureContext(
  store: WorkItemStore,
  sessionId: string,
  workItemId: string,
  errorCode: string,
): Partial<WorkflowFailureResult> {
  const record = store.getWorkItem(sessionId, workItemId);
  if (!record) return {};
  const context: {
    state?: string;
    attempt?: number;
    attemptStatus?: string;
    resultStatus?: string;
    attemptBudget?: number;
    remainingAttempts?: number;
    recoveryCount?: number;
    pendingReviewers?: string[];
    prerequisite?: string;
    nextAction?: string;
  } = { state: record.state };
  if (record.currentRound) {
    context.pendingReviewers = [...record.currentRound.pendingReviewers];
  }
  if (record.delegated) {
    const progress = summarizeDelegatedProgress(record);
    const guidance = delegatedGuidanceFor(store, sessionId, record);
    context.attemptBudget = progress.attemptBudget;
    context.remainingAttempts = progress.remainingAttempts;
    context.recoveryCount = progress.recoveryGrants;
    context.nextAction = guidance.nextAction;
    if (guidance.nextAction === "launch_blocked" && guidance.prerequisites.length > 0) {
      context.prerequisite = guidance.prerequisites[0];
    }
    const attempts = record.delegated.attempts;
    const latest = attempts.length > 0 ? attempts[attempts.length - 1] : undefined;
    if (latest) {
      context.attempt = latest.attempt;
      context.attemptStatus = latest.status;
      if (latest.resultStatus !== undefined) context.resultStatus = latest.resultStatus;
    }
  }
  const prerequisite = ownedPrerequisite(record, errorCode);
  if (prerequisite !== undefined && context.prerequisite === undefined) {
    context.prerequisite = prerequisite;
  }
  return context;
}

/**
 * Real unmet prerequisite for the record's current state and the failure code.
 * Family-specific codes keep their precise condition; otherwise the current
 * owned state determines the prerequisite.
 */
function ownedPrerequisite(record: WorkItemRecord, errorCode: string): string | undefined {
  switch (errorCode) {
    case "CONCERNS_DISPOSITION_REQUIRED":
      return "an explicit concernsDisposition for the DONE_WITH_CONCERNS attempt";
    case "UNEXPECTED_CONCERNS_DISPOSITION":
      return "an attempt that completed DONE_WITH_CONCERNS";
    case "INVALID_ATTEMPT":
    case "ATTEMPT_MISMATCH":
      return "the current completed attempt number for this work item";
    case "ATTEMPT_NOT_TERMINAL":
      return "a terminal targeted attempt";
    case "ATTEMPTS_EXHAUSTED":
      return "an explicit recovery grant or checkpoint-authorized rework";
    case "AUTONOMOUS_GRANT_EXHAUSTED":
      return "a recorded advance authority or a fresh root-user message";
    default:
      break;
  }
  if (record.delegated) {
    if (record.state === "ready_to_close") return undefined;
    if (record.state === "awaiting_acceptance") {
      return "a controller accept/request_changes decision for the current completed attempt";
    }
    if (record.state === "blocked" || record.state === "needs_context") {
      return "a bounded recovery (or an authorized advance) for the stopped attempt";
    }
    if (record.currentRound && record.currentRound.pendingReviewers.length > 0) {
      return "a completed review round from every required reviewer";
    }
    if (currentDelegatedAcceptance(record) === undefined) {
      return "a current controller acceptance for the latest completed attempt";
    }
    return "a current controller decision, recovery, or rework authorization for this delegated item";
  }
  if (
    record.state === "awaiting_reviews" ||
    (record.currentRound && record.currentRound.pendingReviewers.length > 0)
  ) {
    return "a completed review round from every required reviewer";
  }
  return undefined;
}
// END_BLOCK_RESULT_FINALIZATION

// START_BLOCK_GENERIC_NORMALIZATION
/** Normalize one structurally validated generic task item into a bounded task contract. */
function normalizeTaskContract(
  item: OpenItemInput,
): { ok: true; contract: WorkflowTaskContract } | { ok: false; message: string } {
  const taskId = coerceNonEmptyString(item.taskId) ?? coerceNonEmptyString(item.key);
  const title = coerceNonEmptyString(item.title) ?? taskId;
  if (!taskId || !title) {
    return { ok: false, message: "each task item requires a non-empty taskId (or key) and title" };
  }
  // Structural validation guarantees an explicit unique spec/code reviewer array.
  const reviewers = item.requiredReviewers as WorkflowReviewer[];
  return {
    ok: true,
    contract: {
      taskId,
      title,
      goal: coerceNonEmptyString(item.goal) ?? title,
      acceptanceCriteria: [...(item.acceptanceCriteria ?? [])],
      verification: [...(item.verification ?? [])],
      writeScope: [...(item.writeScope ?? [])],
      dependsOn: [...(item.dependsOn ?? [])],
      blockedBy: [...(item.blockedBy ?? [])],
      requiredReviewers: [...reviewers],
    },
  };
}

/** Convert typed checkpoint inputs into validated common checkpoint contracts. */
function normalizeCheckpointInputContracts(
  raw: readonly unknown[] | undefined,
): { ok: true; contracts: WorkflowCheckpointContract[] } | { ok: false; message: string } {
  const contracts: WorkflowCheckpointContract[] = [];
  for (const entry of raw ?? []) {
    const validated = validateWorkflowCheckpointContract(entry);
    if (!validated.ok) {
      return {
        ok: false,
        message: validated.problems.map((problem) => problem.message).join("; "),
      };
    }
    contracts.push(validated.value);
  }
  return { ok: true, contracts };
}

function taskContractsFromItems(
  items: readonly OpenItemInput[],
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

/**
 * Field-specific canonicalization of a structurally validated generic source.
 * Only the documented provided-plan reference and optional hash are trimmed, so
 * a canonical and a whitespace-varied valid call keep the same source identity
 * and idempotency. Native bindings and workflow identities are never rewritten.
 */
function canonicalizeExecutionSource(
  source: OpenExecutionInput["source"],
): WorkflowExecutionSource {
  if (source.kind === "conversation-scoped") return { kind: "conversation-scoped" };
  return {
    kind: "provided-plan",
    reference: source.reference.trim(),
    ...(source.sha256 !== undefined ? { sha256: source.sha256.trim() } : {}),
  };
}
// END_BLOCK_GENERIC_NORMALIZATION

/** Map a structurally validated standalone item into explicit openWorkItem input. */
function normalizeOpenInputItem(
  item: OpenItemInput,
  sessionId: string,
):
  | { ok: true; input: OpenWorkItemInput }
  | { ok: false; errorCode: "INVALID_INPUT"; message: string } {
  const key = item.key.trim();
  const title = item.title.trim();
  if (!key || !title) {
    return {
      ok: false,
      errorCode: "INVALID_INPUT",
      message: "INVALID_INPUT: key and title must be non-empty strings",
    };
  }

  if (item.mode === "delegated") {
    return {
      ok: true,
      input: {
        sessionId,
        key,
        title,
        mode: "delegated",
        requiredReviewers: [],
        writeScope: [...(item.writeScope ?? [])],
        ...(item.planRunId && item.planTaskId
          ? { planRunId: item.planRunId, planTaskId: item.planTaskId }
          : {}),
      },
    };
  }

  const requiredReviewers = [...item.requiredReviewers].sort((left, right) => {
    if (left === right) return 0;
    return left === "spec" ? -1 : 1;
  });
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

// START_CONTRACT: createWorkItemOpenTool
//   PURPOSE: Build work_item_open handler that supports deterministic batch idempotent open operations with explicit workflow intent under whole-request structural validation.
//   INPUTS: { store: WorkItemStore - workflow in-memory store }
//   OUTPUTS: { WorkflowToolDefinition<OpenToolInput, unknown> - executable tool definition }
//   SIDE_EFFECTS: [Mutates in-memory work-item store through open operations only after structural validation passes]
//   LINKS: [M-WORKFLOW-TOOLING, M-WORKFLOW-STATE, validateWorkflowToolInput]
// END_CONTRACT: createWorkItemOpenTool
export function createWorkItemOpenTool(
  store: WorkItemStore,
): WorkflowToolDefinition<OpenToolInput, Record<string, unknown>> {
  return withFinalizedResult({
    name: "work_item_open",
    description: WORKFLOW_TOOL_DESCRIPTIONS.work_item_open,
    execute: (args, context, overrideStore) => {
      const validation = validateWorkflowToolInput("work_item_open", args);
      if (!validation.ok) {
        return invalidInput("work_item_open", context.sessionId, validation.issues);
      }
      const parsed = validation.data;
      const inputItems = parsed.items;

      if (parsed.execution !== undefined || parsed.runId !== undefined) {
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

        if (parsed.execution !== undefined) {
          const descriptor = parsed.execution;
          const workspaceRoot = coerceNonEmptyString(context.workspaceRoot);
          if (!workspaceRoot) {
            return hostContextInvalid(
              "work_item_open",
              context.sessionId,
              "execution registration requires the trusted workspace root from the plugin context",
            );
          }
          const boundary = validateExecutionBoundary(descriptor.boundary);
          if (!boundary.ok) {
            return {
              tool: "work_item_open",
              sessionId: context.sessionId,
              ok: false,
              errorCode: "INVALID_INPUT",
              message: `INVALID_INPUT: ${boundary.problems.map((problem) => problem.message).join("; ")}`,
            };
          }
          const checkpointContracts = normalizeCheckpointInputContracts(descriptor.checkpoints);
          if (!checkpointContracts.ok) {
            return {
              tool: "work_item_open",
              sessionId: context.sessionId,
              ok: false,
              errorCode: "INVALID_INPUT",
              message: `INVALID_INPUT: ${checkpointContracts.message}`,
            };
          }
          const registered = registerExecutionInStore(data, {
            sessionId: context.sessionId,
            workspaceRoot,
            executionKey: descriptor.executionKey.trim(),
            source: canonicalizeExecutionSource(descriptor.source),
            goal: descriptor.goal.trim(),
            boundary: boundary.value,
            tasks: contracts.contracts.map((contract) => ({ contract })),
            checkpoints: checkpointContracts.contracts,
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
            execution: getExecutionView(registered.execution, data),
          };
        }

        const runId = parsed.runId!.trim();
        const amendmentId = parsed.amendmentId!.trim();
        const rationale = parsed.rationale!;
        const appended = appendExecutionWorkInStore(data, {
          sessionId: context.sessionId,
          runId,
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
          runId,
          revision: appended.revision,
          execution: getExecutionView(appended.execution, data),
        };
      }

      // Structural validation already accepted every item; remaining per-item
      // failures are domain outcomes (idempotency conflicts, state rules).
      const results = inputItems.map((item) => {
        const normalized = normalizeOpenInputItem(item, context.sessionId);
        if (!normalized.ok) {
          return {
            ok: false,
            errorCode: normalized.errorCode,
            message: normalized.message,
          };
        }

        const targetStore = overrideStore ?? store;
        const opened = openWorkItem(targetStore, normalized.input);
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
          ...serializeWorkItem(opened.record, {
            data: targetStore.getStoreData(),
            sessionId: context.sessionId,
          }),
        };
      });

      return {
        tool: "work_item_open",
        sessionId: context.sessionId,
        items: results,
      };
    },
  });
}

// START_CONTRACT: createWorkItemListTool
//   PURPOSE: Build work_item_list handler that returns current work items, explicit review-round metadata, registered plan runs, generic/native execution views, and loaded contract identity.
//   INPUTS: { store: WorkItemStore - workflow in-memory store }
//   OUTPUTS: { WorkflowToolDefinition<ListArgs, unknown> - executable tool definition }
//   SIDE_EFFECTS: [none]
//   LINKS: [M-WORKFLOW-TOOLING, M-WORKFLOW-STATE, M-WORKFLOW-CHECKPOINTS, M-WORKFLOW-EXECUTION]
// END_CONTRACT: createWorkItemListTool
export function createWorkItemListTool(
  store: WorkItemStore,
): WorkflowToolDefinition<ListArgs, Record<string, unknown>> {
  return withFinalizedResult({
    name: "work_item_list",
    description: WORKFLOW_TOOL_DESCRIPTIONS.work_item_list,
    execute: (args, context, overrideStore) => {
      const validation = validateWorkflowToolInput("work_item_list", args);
      if (!validation.ok) {
        return invalidInput("work_item_list", context.sessionId, validation.issues);
      }
      const s = overrideStore ?? store;
      const includeClosed = validation.data.includeClosed === true;
      return getWorkflowInspection(s, context.sessionId, { includeClosed });
    },
  });
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
  return withFinalizedResult({
    name: "work_item_close",
    description: WORKFLOW_TOOL_DESCRIPTIONS.work_item_close,
    execute: (args, context, overrideStore) => {
      const validation = validateWorkflowToolInput("work_item_close", args);
      if (!validation.ok) {
        return invalidInput("work_item_close", context.sessionId, validation.issues);
      }
      const s = overrideStore ?? store;
      const workItemId = validation.data.workItemId.trim();

      const closed = closeWorkItem(s, context.sessionId, workItemId);
      if (!closed.ok) {
        return {
          tool: "work_item_close",
          sessionId: context.sessionId,
          ok: false,
          errorCode: closed.errorCode,
          message: closed.message,
          ...ownedWorkItemFailureContext(s, context.sessionId, workItemId, closed.errorCode),
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
  });
}

// START_CONTRACT: createWorkItemDecideTool
//   PURPOSE: Build work_item_decide handler wrapping explicit controller acceptance, change requests, checkpoint-authorized rework, and bounded recovery under branch-aware input validation.
//   INPUTS: { store: WorkItemStore - workflow in-memory store, options?: DelegatedControlOptions - optional read-only authorization lookup }
//   OUTPUTS: { WorkflowToolDefinition<DecideArgs, Promise<Record<string, unknown>>> - async executable control tool definition }
//   SIDE_EFFECTS: [Mutates delegated work-item state through the domain layer only after structural validation]
//   LINKS: [M-WORKFLOW-TOOLING, M-WORKFLOW-DELEGATED, M-WORKFLOW-CHECKPOINTS, validateWorkflowToolInput]
// END_CONTRACT: createWorkItemDecideTool
export function createWorkItemDecideTool(
  store: WorkItemStore,
  options?: DelegatedControlOptions,
): WorkflowToolDefinition<DecideArgs, Promise<Record<string, unknown>>> {
  return withFinalizedAsyncResult({
    name: "work_item_decide",
    description: WORKFLOW_TOOL_DESCRIPTIONS.work_item_decide,
    async execute(args, context, overrideStore) {
      const validation = validateWorkflowToolInput("work_item_decide", args);
      if (!validation.ok) {
        return invalidInput("work_item_decide", context.sessionId, validation.issues);
      }
      const parsed = validation.data;
      const s = overrideStore ?? store;
      const workItemId = parsed.workItemId.trim();
      const decision = parsed.decision;
      const rationale = parsed.rationale ?? "";
      const evidence = [...(parsed.evidence ?? [])];

      if (decision === "rework") {
        const runId = parsed.runId!.trim();
        const checkpointId = parsed.checkpointId!.trim();
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
            ...ownedWorkItemFailureContext(s, context.sessionId, workItemId, reworked.errorCode),
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
        const recoveryId = parsed.recoveryId!.trim();
        const diagnosis = parsed.diagnosis!;
        const changedCondition = parsed.changedCondition!;
        const verification = [...(parsed.verification ?? [])];
        const userMessageId = parsed.userMessageId?.trim();
        const authorityId = parsed.authorityId?.trim();
        let advanceGrantApproved = false;
        let advanceRunId: string | undefined;
        if (authorityId) {
          advanceRunId = parsed.runId?.trim();
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
          attempt: parsed.attempt,
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
            ...ownedWorkItemFailureContext(s, context.sessionId, workItemId, recovered.errorCode),
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
              ...ownedWorkItemFailureContext(
                s,
                context.sessionId,
                workItemId,
                proposed?.code ?? "RESERVE_EXHAUSTED",
              ),
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
              ...ownedWorkItemFailureContext(s, context.sessionId, workItemId, stored.errorCode),
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
          nextAction: delegatedGuidanceFor(s, context.sessionId, recovered.record).nextAction,
        };
      }

      const concernsDisposition = parsed.concernsDisposition;
      const decided = decideDelegatedWorkItem(s, {
        sessionId: context.sessionId,
        workItemId,
        attempt: parsed.attempt,
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
          ...ownedWorkItemFailureContext(s, context.sessionId, workItemId, decided.errorCode),
        };
      }
      return {
        tool: "work_item_decide",
        sessionId: context.sessionId,
        ok: true,
        action: decision,
        workItemId,
        attempt: parsed.attempt,
        decisionId: decided.decisionId,
        state: decided.record.state,
      };
    },
  });
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
  const amendmentId = args.amendmentId?.trim();
  const rationale = args.rationale?.trim();

  switch (args.action) {
    case "register":
    case "amend": {
      // Branch validation guarantees runId, amendmentId, and rationale for
      // generic register/amend; tasks/checkpoints arrive as typed closed shapes.
      const items = args.tasks ?? [];
      const contracts =
        items.length > 0 ? taskContractsFromItems(items) : { ok: true as const, contracts: [] };
      if (!contracts.ok) {
        return { ...base, ok: false, errorCode: "INVALID_INPUT", message: contracts.message };
      }
      const checkpointContracts = normalizeCheckpointInputContracts(args.checkpoints);
      if (!checkpointContracts.ok) {
        return {
          ...base,
          ok: false,
          errorCode: "INVALID_INPUT",
          message: `INVALID_INPUT: ${checkpointContracts.message}`,
        };
      }
      const appended = appendExecutionWorkInStore(data, {
        sessionId,
        runId,
        amendmentId: amendmentId!,
        rationale: rationale!,
        tasks: contracts.contracts.map((contract) => ({ contract })),
        checkpoints: checkpointContracts.contracts,
      });
      if (!appended.ok) {
        return { ...base, ok: false, errorCode: appended.errorCode, message: appended.message };
      }
      return {
        ...base,
        ok: true,
        action: "amend",
        revision: appended.revision,
        execution: getExecutionView(appended.execution, data),
      };
    }

    case "start": {
      const checkpointId = args.checkpointId!.trim();
      const startFingerprint = args.startFingerprint?.trim();
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
      const checkpointId = args.checkpointId!.trim();
      const reviewer = args.reviewer;
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
      const checkpointId = args.checkpointId!.trim();
      const recoveryId = args.recoveryId!.trim();
      const diagnosis = args.diagnosis!;
      const changedCondition = args.changedCondition!;
      const verification = [...(args.verification ?? [])];
      const authorityId = args.authorityId?.trim();
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
        rationale: rationale || "Generic execution completed with controller acceptance.",
        evidence: [...(args.verification ?? [])],
      });
      if (!completed.ok) {
        return { ...base, ok: false, errorCode: completed.errorCode, message: completed.message };
      }
      return {
        ...base,
        ok: true,
        action: "complete",
        reviewStatus: completed.reviewStatus,
        execution: getExecutionView(completed.execution, data),
      };
    }

    case "authorize": {
      const authorityId = args.authorityId!.trim();
      const messageId = args.messageId!.trim();
      const stages = [...(args.stages ?? [])];
      if (!authorityId || !messageId || stages.length === 0) {
        return {
          ...base,
          ok: false,
          errorCode: "INVALID_INPUT",
          message: "authorize requires authorityId, messageId, and explicit stages",
        };
      }
      const suppliedScope: WorkflowAuthorityScope = {
        stages,
        decisionScope: (args.decisionScope ?? "").trim(),
        fileBoundary: [...(args.fileBoundary ?? [])],
        reservedStops: [...(args.reservedStops ?? [])],
      };
      const lookup = options.control?.lookupAuthorityMessage;
      if (!lookup) {
        return hostContextInvalid(
          "work_checkpoint",
          sessionId,
          "authorize requires the SDK-backed authorization lookup from the plugin context",
        );
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
        // Idempotent reuse and finite extension never silently accept a
        // supplied scope that contradicts the recorded scope.
        const scopeDifferences = authorityScopeDifferences(suppliedScope, existingAuthority.scope);
        if (scopeDifferences.length > 0) {
          return {
            ...base,
            ok: false,
            errorCode: "INVALID_INPUT",
            message: `INVALID_INPUT: supplied scope differs from the recorded scope for authority ${authorityId} (${scopeDifferences.join(", ")}); scope changes are unsupported on replay or extension`,
          };
        }
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
        scope: suppliedScope,
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
      const authorityId = args.authorityId!.trim();
      const approvalId = args.approvalId!.trim();
      const stage = args.stage;
      const artifactPath = args.artifactPath!.trim();
      const artifactSha256 = args.artifactSha256!.trim();
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
      const authorityId = args.authorityId!.trim();
      const revocationId = args.revocationId!.trim();
      const authority = execution.authority.find((entry) => entry.authorityId === authorityId);
      if (!authority || !revocationId) {
        return {
          ...base,
          ok: false,
          errorCode: "INVALID_INPUT",
          message: "revoke_authority requires a recorded authorityId and a revocationId",
        };
      }
      // Supplied stages were validated as canonical values before any lookup;
      // absent or empty stages keep the documented full-revocation default.
      const narrowedStages = args.stages;
      const reason = args.rationale?.trim();
      const revoked =
        narrowedStages === undefined || narrowedStages.length === 0
          ? revokeAdvanceAuthority({
              authority,
              revocationId,
              reason: reason || "revoked",
            })
          : narrowAdvanceAuthority({
              authority,
              revocationId,
              reason: reason || "narrowed",
              narrowedStages: [...narrowedStages],
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
//   PURPOSE: Build work_checkpoint handler wrapping plan registration, checkpoint start, fingerprint-verified outcomes, and bounded checkpoint recovery under branch-aware input validation with source-resolved run routing.
//   INPUTS: { store: WorkItemStore - workflow in-memory store, options?: DelegatedControlOptions - optional read-only authorization lookup }
//   OUTPUTS: { WorkflowToolDefinition<CheckpointArgs, Promise<Record<string, unknown>>> - async executable control tool definition }
//   SIDE_EFFECTS: [Registers plan runs and mutates checkpoint state through the domain layer only after structural validation]
//   LINKS: [M-WORKFLOW-TOOLING, M-WORKFLOW-CHECKPOINTS, M-WORKFLOW-DELEGATED, validateWorkflowToolInput]
// END_CONTRACT: createWorkCheckpointTool
export function createWorkCheckpointTool(
  store: WorkItemStore,
  options?: DelegatedControlOptions,
): WorkflowToolDefinition<CheckpointArgs, Promise<Record<string, unknown>>> {
  return withFinalizedAsyncResult({
    name: "work_checkpoint",
    description: WORKFLOW_TOOL_DESCRIPTIONS.work_checkpoint,
    async execute(args, context, overrideStore) {
      const validation = validateWorkflowToolInput("work_checkpoint", args);
      if (!validation.ok) {
        return invalidInput("work_checkpoint", context.sessionId, validation.issues);
      }
      const parsed = validation.data;
      const s = overrideStore ?? store;
      const action = parsed.action;
      if (action === "register" && parsed.planPath !== undefined) {
        const planPath = parsed.planPath.trim();
        const workspaceRoot = coerceNonEmptyString(
          (context as WorkCheckpointExecuteContext).workspaceRoot,
        );
        if (!workspaceRoot) {
          return hostContextInvalid(
            "work_checkpoint",
            context.sessionId,
            "register requires the trusted workspace root from the plugin context",
          );
        }
        if (!planPath) {
          return {
            tool: "work_checkpoint",
            sessionId: context.sessionId,
            ok: false,
            errorCode: "INVALID_INPUT",
            message: "INVALID_INPUT: planPath must be a non-empty string",
          };
        }
        const load = (context as WorkCheckpointExecuteContext).loadPlan;
        if (typeof load !== "function") {
          return hostContextInvalid(
            "work_checkpoint",
            context.sessionId,
            "register requires a plan loader bound to the plugin context",
          );
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

      const runId = parsed.runId?.trim();
      if (runId) {
        const data = s.getStoreData();
        const execution = findExecution(data, runId);
        const planRun = data.planRuns.get(runId);
        // Resolve session ownership before any source-specific diagnostic or
        // generic/native action discrimination. Both the common execution
        // registry and the legacy/native planRun fallback are guarded, so a
        // foreign caller cannot infer the run's source (or which fields an
        // action consumes) from which error it receives.
        const knownOwnerSessionId = execution?.sessionId ?? planRun?.sessionId;
        if (knownOwnerSessionId !== undefined && knownOwnerSessionId !== context.sessionId) {
          return {
            tool: "work_checkpoint",
            sessionId: context.sessionId,
            ok: false,
            errorCode: "SESSION_MISMATCH",
            message: "run belongs to another session",
          };
        }
        // Authority actions apply to any execution, including native runs;
        // generic-only actions stay on non-native executions.
        const authorityAction =
          action === "authorize" || action === "record_approval" || action === "revoke_authority";
        const genericOnlyAction =
          action === "register" ||
          action === "amend" ||
          action === "review" ||
          action === "bind" ||
          action === "complete";
        const nativeRun =
          execution?.source.kind === "native-package" ||
          (execution === undefined && planRun !== undefined);

        if (genericOnlyAction && nativeRun) {
          return {
            tool: "work_checkpoint",
            sessionId: context.sessionId,
            ok: false,
            errorCode: "INVALID_INPUT",
            message: `INVALID_INPUT: action ${action} is not supported for native-package run ${runId}`,
          };
        }
        // Source-dependent known fields: only reject them for an owned run whose
        // source is known, so an unknown run stays a lookup failure rather than
        // a fabricated native-argument error.
        if (nativeRun) {
          if (action === "start" && parsed.startFingerprint !== undefined) {
            return invalidInput("work_checkpoint", context.sessionId, [
              {
                code: "invalid_value",
                path: "startFingerprint",
                message: "startFingerprint is only consumed by a generic checkpoint start",
                expected: "omit startFingerprint for a native-package run",
              },
            ]);
          }
          if (action === "verify" && parsed.reviewer !== undefined) {
            return invalidInput("work_checkpoint", context.sessionId, [
              {
                code: "invalid_value",
                path: "reviewer",
                message:
                  "reviewer is only consumed by generic review/bind/verify; a native verify seals through complete",
                expected: "omit reviewer for a native-package run",
              },
            ]);
          }
        } else if (execution !== undefined) {
          if (action === "verify" && parsed.complete !== undefined) {
            return invalidInput("work_checkpoint", context.sessionId, [
              {
                code: "invalid_value",
                path: "complete",
                message:
                  "complete only seals a native-package final checkpoint; generic verify records linked reviewer outcomes",
                expected: "omit complete for a generic execution",
              },
            ]);
          }
          if (action === "recover" && parsed.userMessageId !== undefined) {
            return invalidInput("work_checkpoint", context.sessionId, [
              {
                code: "invalid_value",
                path: "userMessageId",
                message:
                  "generic checkpoint recovery is authorized by an advance authority; a root-user message is only consumed by native-package checkpoint recovery",
                expected: "authorityId for generic checkpoint recovery",
              },
            ]);
          }
        }
        // Resolve the known run source before source-specific checks. Unknown
        // runs reach executeGenericCheckpoint (or the native domain below) and
        // are reported as lookup failures, never as missing native-only fields.
        if (
          authorityAction ||
          genericOnlyAction ||
          (execution !== undefined && execution.source.kind !== "native-package")
        ) {
          return executeGenericCheckpoint({
            data,
            sessionId: context.sessionId,
            runId,
            args: parsed,
            ...(options ? { control: options } : {}),
          });
        }
      }

      const checkpointId = parsed.checkpointId?.trim();
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
          ...(parsed.complete === true ? { complete: true } : {}),
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
        const recoveryId = parsed.recoveryId!.trim();
        const diagnosis = parsed.diagnosis!;
        const changedCondition = parsed.changedCondition!;
        const verification = [...(parsed.verification ?? [])];
        const userMessageId = parsed.userMessageId?.trim();
        const authorityId = parsed.authorityId?.trim();
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
  });
}
