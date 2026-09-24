// FILE: src/plugins/workflow/results.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Own the concrete public workflow result contracts: failure category taxonomy and classification, bounded failure DTOs with preserved tokenized issues and state/prerequisite guidance, closed result schemas and types for every owned workflow response family (standalone batch, generic mutation, list views, close, decide, checkpoint/authority actions, and failures), producer/test result validation, and production serialization with a truthful post-side-effect failure fallback.
//   SCOPE: Pure result/response shape ownership only. No store lookup, no state eligibility, no permission decisions, no mutation, no persistence. Serialization never throws after a side effect and never parses free-form messages to recover paths or state.
//   DEPENDS: [@opencode-ai/plugin (tool.schema), zod (types), src/lib/agent-tool-contract.ts]
//   LINKS: [M-WORKFLOW-TOOLING, M-AGENT-TOOL-CONTRACT, M-PLUGIN-WORKFLOW]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   WORKFLOW_FAILURE_CATEGORIES - Stable failure categories distinguishing input/state/authorization/host_context/persistence/internal.
//   WorkflowFailureCategory - Union of the stable failure categories.
//   WORKFLOW_MUTATION_OUTCOMES - Truthful post-side-effect mutation outcome vocabulary.
//   WorkflowMutationOutcome - Union of the mutation outcome vocabulary.
//   MAX_FAILURE_MESSAGE_CHARS - Documented finite top-level failure message allowance.
//   MAX_FAILURE_FIELD_CHARS - Documented finite bound for failure context/identity fields.
//   WorkflowFailure - Bounded, enumerated public failure DTO with category, issues, and typed state/attempt/budget context.
//   WorkflowFailureResult - Record-compatible alias for the bounded failure DTO.
//   boundContractIssues - Bound a failure issue list to the shared finite limits.
//   categoryForWorkflowErrorCode - Classify an existing workflow error code into a stable failure category.
//   failureGuidance - Bounded prerequisite/next-action guidance for a known state/authority failure family.
//   normalizeWorkflowFailure - Add category/guidance to one failure object without mutating it.
//   normalizeWorkflowResult - Add category/guidance to failure results (including batch items) without mutating input.
//   finalizeWorkflowResult - Producer-side finalization wrapper over normalizeWorkflowResult.
//   workflowFailureSchema - Closed schema for the generic public failure envelope.
//   workflowInputFailure - Bounded caller-input failure carrying tokenized issues (agrees with the early hook).
//   workflowHostContextFailure - Trusted-host-context failure that is not a caller argument error.
//   workflowInternalResultFailure - Internal result-contract/serialization failure with observed outcome metadata.
//   WorkflowDiagnosticError - Thrown owned diagnostic carrying a stable code, category, and optional outcome.
//   serializeWorkflowResult - Serialize a public workflow result with a truthful post-side-effect fallback.
//   validateWorkflowToolResult - Producer/test validation of one owned workflow tool result (no repair).
//   workflowToolResultSchema - Closed result schema for one owned workflow tool id, preserving its inferred type.
//   workflowToolResultSchemas - Exported closed per-tool result schema map.
//   WorkflowToolResultToolId - Union of the five owned workflow tool ids with result schemas.
//   WorkflowToolResultMap - Schema-derived per-tool result DTO map.
//   WorkflowContractIdentity - Loaded package/revision/reference identity carried by work_item_list.contract.
//   WorkflowExecutionView - Read-only execution view DTO.
//   WorkflowDelegatedRunView - Read-only native plan-run view DTO.
//   WorkflowWorkItemView - Read-only work-item view DTO with delegated budget and guidance.
//   WorkflowInspectionView - Additive work_item_list inspection DTO.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-004 - Added the additive work_item_list inspection contract: loaded package/contract identity, generic/native execution views with derived task status, checkpoint generation/outcome/current-obligation detail, delegated latest-attempt and gate-derived guidance, and the launch_blocked next action. Prior T-003: concrete public workflow result contracts with failure categories, preserved tokenized issues, typed state/attempt/budget context, closed per-tool schemas/views, producer-side finalization, and truthful post-side-effect serialization.]
// END_CHANGE_SUMMARY

import { tool } from "@opencode-ai/plugin";
import type { z } from "zod";
import {
  MAX_CONTRACT_ISSUES,
  MAX_ISSUE_MESSAGE_CHARS,
  MAX_ISSUE_PATH_CHARS,
  MAX_ISSUE_VALUE_CHARS,
  type ContractIssue,
  type ContractIssueCode,
  formatContractIssues,
  toContractIssues,
} from "../../lib/agent-tool-contract.js";
import { AUTHORITY_STAGES, REVIEWER_ROLES, WORK_ITEM_MODES } from "../../lib/workflow-contract.js";

/**
 * Documented finite bounds for failure diagnostics only. Success payloads,
 * history, scope files, and batch arrays are never bounded here.
 */
export const MAX_FAILURE_MESSAGE_CHARS = MAX_ISSUE_MESSAGE_CHARS * (MAX_CONTRACT_ISSUES + 1);
export const MAX_FAILURE_FIELD_CHARS = MAX_ISSUE_MESSAGE_CHARS;

// START_BLOCK_CATEGORIES
/** Stable failure categories. Unrecognized owned codes classify as `state`. */
export const WORKFLOW_FAILURE_CATEGORIES = [
  "input",
  "state",
  "authorization",
  "host_context",
  "persistence",
  "internal",
] as const;

export type WorkflowFailureCategory = (typeof WORKFLOW_FAILURE_CATEGORIES)[number];

/** Truthful post-side-effect outcome vocabulary; keep claims to what was observed. */
export const WORKFLOW_MUTATION_OUTCOMES = [
  "committed",
  "not_applied",
  "rolled_back",
  "unknown",
] as const;

export type WorkflowMutationOutcome = (typeof WORKFLOW_MUTATION_OUTCOMES)[number];

const INPUT_ERROR_CODES = new Set(["INVALID_INPUT"]);
const HOST_CONTEXT_ERROR_CODES = new Set(["HOST_CONTEXT_UNAVAILABLE", "PLAN_LOAD_FAILED"]);
const PERSISTENCE_ERROR_CODES = new Set(["PERSISTENCE_FAILED", "SNAPSHOT_FAILED"]);
const INTERNAL_ERROR_CODES = new Set(["RESULT_CONTRACT_INVALID", "RESULT_SERIALIZATION_FAILED"]);
// Authorization covers access denial, session/run ownership, and recorded
// authority eligibility/provenance. Domain state (attempts, reviews, budgets,
// checkpoints, bindings) stays `state`; genuine caller-input rejection stays
// `input`, and missing host context stays `host_context`.
const AUTHORIZATION_ERROR_CODES = new Set([
  "CONTROL_DENIED",
  "WORKFLOW_TOOL_DENIED",
  "SESSION_MISMATCH",
  "AUTHORITY_DENIED",
  "AUTHORITY_NOT_FOUND",
  "AUTHORITY_REVOKED",
  "AUTHORIZATION_LOOKUP_FAILED",
  "AUTHORIZATION_NOT_FOUND",
  "AUTHORIZATION_SESSION_MISMATCH",
  "AUTHORIZATION_NOT_USER_MESSAGE",
  "AUTHORIZATION_ID_MISMATCH",
  "AUTHORIZATION_REUSED",
  "AUTHORIZATION_STALE",
  "FOREIGN_SESSION",
  "ASSISTANT_MESSAGE",
  "IGNORED_MESSAGE",
  "SYNTHETIC_ONLY",
  "MISSING_IDENTITY",
  "EMPTY_MESSAGE",
  "MESSAGE_REPLAY",
  "STALE_EXTENSION",
  "DUPLICATE_GRANT",
  "DUPLICATE_DEBIT",
  "RESERVE_EXHAUSTED",
  "SCOPE_NOT_PRESERVED",
]);

/** Classify an existing workflow error code into a stable failure category. */
export function categoryForWorkflowErrorCode(errorCode: string): WorkflowFailureCategory {
  if (INPUT_ERROR_CODES.has(errorCode)) return "input";
  if (HOST_CONTEXT_ERROR_CODES.has(errorCode)) return "host_context";
  if (PERSISTENCE_ERROR_CODES.has(errorCode)) return "persistence";
  if (INTERNAL_ERROR_CODES.has(errorCode)) return "internal";
  if (AUTHORIZATION_ERROR_CODES.has(errorCode)) return "authorization";
  return "state";
}
// END_BLOCK_CATEGORIES

// START_BLOCK_GUIDANCE
interface WorkflowFailureGuidance {
  readonly prerequisite?: string;
  readonly nextAction?: string;
}

/**
 * Bounded prerequisite/next-step guidance for the state and authority families
 * that need it. Guidance describes the unmet prerequisite and a safe inspection
 * step; it never accepts work, grants recovery, resets identity/counters, or
 * promises that a retry will remain valid after concurrent state changes.
 */
const FAILURE_GUIDANCE: Record<string, WorkflowFailureGuidance> = {
  WORK_ITEM_NOT_FOUND: {
    prerequisite: "an existing same-session work item for the supplied id",
    nextAction: "call work_item_list to read the current work item ids",
  },
  WORK_ITEM_ALREADY_CLOSED: {
    prerequisite: "a work item that is not closed",
  },
  READY_TO_CLOSE_REQUIRED: {
    prerequisite: "all assigned reviews complete and no open concerns for this item",
    nextAction: "call work_item_list to inspect pending reviews or concerns",
  },
  WRONG_MODE: {
    prerequisite: "a work item of the mode this operation targets",
    nextAction: "call work_item_list to confirm the item mode",
  },
  INVALID_STATE: {
    prerequisite: "the work item in the state this operation requires",
    nextAction: "call work_item_list to read the current state",
  },
  INVALID_ATTEMPT: {
    prerequisite: "the current completed attempt number for this work item",
    nextAction: "call work_item_list to read the latest attempt",
  },
  ATTEMPT_MISMATCH: {
    prerequisite: "the latest terminal attempt number for this work item",
    nextAction: "call work_item_list to read the latest attempt",
  },
  ATTEMPT_NOT_TERMINAL: {
    prerequisite: "a terminal targeted attempt",
  },
  ATTEMPT_IN_FLIGHT: {
    prerequisite: "no in-flight attempt for this work item",
    nextAction: "collect the in-flight attempt result before launching again",
  },
  ATTEMPTS_EXHAUSTED: {
    prerequisite: "an explicit recovery grant or checkpoint-authorized rework",
    nextAction: "inspect the item with work_item_list before choosing a recovery path",
  },
  AUTONOMOUS_GRANT_EXHAUSTED: {
    prerequisite: "a recorded advance authority or a fresh root-user message",
    nextAction: "inspect available authority and budgets with work_item_list",
  },
  CONCERNS_DISPOSITION_REQUIRED: {
    prerequisite: "an explicit concernsDisposition for a DONE_WITH_CONCERNS attempt",
  },
  UNEXPECTED_CONCERNS_DISPOSITION: {
    prerequisite: "an attempt that completed DONE_WITH_CONCERNS",
    nextAction: "inspect the latest attempt status with work_item_list",
  },
  REVIEW_ROUND_NOT_ACTIVE: {
    prerequisite: "an active review round for this item",
    nextAction: "inspect review state with work_item_list",
  },
  REVIEW_ROUND_NEEDS_CONTEXT: {
    prerequisite: "resolved reviewer NEEDS_CONTEXT before another review round",
    nextAction: "inspect review state with work_item_list",
  },
  REVIEWER_NOT_REQUIRED: {
    prerequisite: "a reviewer role assigned to the active round",
  },
  REVIEWER_NOT_IN_FLIGHT: {
    prerequisite: "a launched reviewer for the active round",
  },
  REVIEWER_ALREADY_COMPLETED: {
    prerequisite: "an outstanding reviewer result",
  },
  REVIEWER_ALREADY_IN_FLIGHT: {
    prerequisite: "a reviewer that has not already launched",
  },
  AUTHORITY_NOT_FOUND: {
    prerequisite: "a recorded authority matching the supplied authorityId for the owned run",
    nextAction: "inspect the owned execution and its authority with work_item_list",
  },
  AUTHORITY_DENIED: {
    prerequisite: "a verified eligible root-user instruction",
  },
  AUTHORITY_REVOKED: {
    prerequisite: "an authority that has not been revoked",
  },
  RESERVE_EXHAUSTED: {
    prerequisite: "a remaining advance unit on the recorded authority",
    nextAction: "inspect the authority budget with work_item_list",
  },
  CHECKPOINT_NOT_FOUND: {
    prerequisite: "a checkpoint bound to the target run",
    nextAction: "inspect run checkpoints with work_item_list",
  },
  CHECKPOINT_NOT_FAILED: {
    prerequisite: "a failed checkpoint for rework authorization",
  },
  RUN_NOT_FOUND: {
    prerequisite: "an existing owned plan run",
    nextAction: "call work_item_list to read the current plan runs",
  },
  EXECUTION_NOT_FOUND: {
    prerequisite: "an existing owned generic execution",
    nextAction: "call work_item_list to read the current executions",
  },
  EXECUTION_SEALED: {
    prerequisite: "an execution that is not sealed",
    nextAction: "inspect execution status with work_item_list",
  },
  EXECUTION_INCOMPLETE: {
    prerequisite: "accepted covered tasks before the checkpoint may start",
    nextAction: "inspect task acceptance with work_item_list",
  },
  UNKNOWN_REFERENCE: {
    prerequisite: "a referenced task/checkpoint present in the target run",
    nextAction: "inspect the run with work_item_list",
  },
  TASK_NOT_FOUND: {
    prerequisite: "a task present in the target execution",
  },
  STALE_CALLBACK: {
    prerequisite: "a callback matching the current in-flight attempt",
  },
  NOT_ACCEPTED: {
    prerequisite: "a currently applicable acceptance",
  },
  PREREQUISITES_NOT_ACCEPTED: {
    prerequisite: "accepted dependency tasks",
    nextAction: "inspect dependency status with work_item_list",
  },
};

/** Bounded prerequisite/next-action guidance for a known failure family. */
export function failureGuidance(errorCode: string): WorkflowFailureGuidance | undefined {
  return FAILURE_GUIDANCE[errorCode];
}
// END_BLOCK_GUIDANCE

// START_BLOCK_FAILURE_DTO
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCategory(value: unknown): value is WorkflowFailureCategory {
  return (
    typeof value === "string" && (WORKFLOW_FAILURE_CATEGORIES as readonly string[]).includes(value)
  );
}

function isOutcome(value: unknown): value is WorkflowMutationOutcome {
  return (
    typeof value === "string" && (WORKFLOW_MUTATION_OUTCOMES as readonly string[]).includes(value)
  );
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** Bound one failure string to a finite documented length without throwing. */
function boundText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Bound failure issues to the shared finite contract limits. Called by every
 * failure constructor and by normalization so a caller cannot smuggle an
 * unbounded issue list or oversized path/message into a public failure.
 */
export function boundContractIssues(issues: readonly ContractIssue[]): readonly ContractIssue[] {
  return issues.slice(0, MAX_CONTRACT_ISSUES).map((issue) => ({
    code: issue.code,
    path: boundText(issue.path, MAX_ISSUE_PATH_CHARS),
    message: boundText(issue.message, MAX_ISSUE_MESSAGE_CHARS),
    ...(issue.expected !== undefined
      ? { expected: boundText(issue.expected, MAX_ISSUE_MESSAGE_CHARS) }
      : {}),
    ...(issue.received !== undefined
      ? { received: boundText(issue.received, MAX_ISSUE_VALUE_CHARS) }
      : {}),
  }));
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

const CONTRACT_ISSUE_CODE_SET = new Set<string>([
  "unrecognized_keys",
  "invalid_value",
  "invalid_type",
  "invalid_format",
  "too_small",
  "too_big",
  "missing_value",
  "invalid_union",
  "custom",
]);

function asIssues(value: unknown): readonly ContractIssue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return boundContractIssues(
    value.filter(isRecord).map((entry) => ({
      code: (typeof entry.code === "string" && CONTRACT_ISSUE_CODE_SET.has(entry.code)
        ? entry.code
        : "custom") as ContractIssueCode,
      path: typeof entry.path === "string" ? entry.path : "(root)",
      message: typeof entry.message === "string" ? entry.message : "invalid value",
      ...(typeof entry.expected === "string" ? { expected: entry.expected } : {}),
      ...(typeof entry.received === "string" ? { received: entry.received } : {}),
    })),
  );
}

/**
 * Enumerated bounded public failure. `applied` is only asserted for known
 * outcomes: omitted for `unknown` so an unknown outcome can never be read as
 * "not applied".
 */
export interface WorkflowFailure {
  readonly ok: false;
  readonly tool?: string;
  readonly sessionId?: string;
  readonly errorCode: string;
  readonly category: WorkflowFailureCategory;
  readonly message: string;
  readonly issues?: readonly ContractIssue[];
  readonly state?: string;
  readonly attempt?: number;
  readonly attemptStatus?: string;
  readonly resultStatus?: string;
  readonly attemptBudget?: number;
  readonly remainingAttempts?: number;
  readonly recoveryCount?: number;
  readonly pendingReviewers?: readonly string[];
  readonly prerequisite?: string;
  readonly nextAction?: string;
  readonly outcome?: WorkflowMutationOutcome;
  readonly applied?: boolean;
  readonly retrySafe?: boolean;
  readonly existingWorkItemId?: string;
  readonly runId?: string;
}

/**
 * Record-compatible failure result for positions declared as
 * `Record<string, unknown>`. The known fields are enumerated on
 * `WorkflowFailure`; this alias only makes the bounded DTO storable in the
 * generic result channel.
 */
export type WorkflowFailureResult = WorkflowFailure & Record<string, unknown>;

/**
 * Truthful `applied` for a known outcome. `unknown` returns undefined so a
 * caller can never read an unobserved mutation as not applied.
 */
function appliedForOutcome(outcome: WorkflowMutationOutcome | undefined): boolean | undefined {
  if (outcome === "committed") return true;
  if (outcome === "not_applied" || outcome === "rolled_back") return false;
  return undefined;
}

/**
 * Add a stable category and bounded guidance to one failure object without
 * mutating it or parsing its message text. Existing errorCode and message are
 * preserved; explicit caller-supplied category/guidance/context wins.
 */
export function normalizeWorkflowFailure(failure: Record<string, unknown>): WorkflowFailureResult {
  const errorCode = boundText(
    asString(failure.errorCode) ?? "UNKNOWN_FAILURE",
    MAX_FAILURE_FIELD_CHARS,
  );
  const category = isCategory(failure.category)
    ? failure.category
    : categoryForWorkflowErrorCode(errorCode);
  const guidance = failureGuidance(errorCode);
  const message = boundText(asString(failure.message) ?? errorCode, MAX_FAILURE_MESSAGE_CHARS);
  const outcome = isOutcome(failure.outcome) ? failure.outcome : undefined;
  const applied =
    typeof failure.applied === "boolean" ? failure.applied : appliedForOutcome(outcome);
  const tool = asString(failure.tool);
  const sessionId = asString(failure.sessionId);
  const issues = asIssues(failure.issues);
  const state = asString(failure.state);
  const attempt = asNumber(failure.attempt);
  const attemptStatus = asString(failure.attemptStatus);
  const resultStatus = asString(failure.resultStatus);
  const attemptBudget = asNumber(failure.attemptBudget);
  const remainingAttempts = asNumber(failure.remainingAttempts);
  const recoveryCount = asNumber(failure.recoveryCount);
  const pendingReviewers = asStringArray(failure.pendingReviewers);
  const prerequisite = asString(failure.prerequisite);
  const nextAction = asString(failure.nextAction);
  const existingWorkItemId = asString(failure.existingWorkItemId);
  const runId = asString(failure.runId);
  return {
    ok: false,
    errorCode,
    category,
    message,
    ...(tool !== undefined ? { tool: boundText(tool, MAX_FAILURE_FIELD_CHARS) } : {}),
    ...(sessionId !== undefined
      ? { sessionId: boundText(sessionId, MAX_FAILURE_FIELD_CHARS) }
      : {}),
    ...(issues !== undefined ? { issues } : {}),
    ...(state !== undefined ? { state: boundText(state, MAX_FAILURE_FIELD_CHARS) } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(attemptStatus !== undefined
      ? { attemptStatus: boundText(attemptStatus, MAX_FAILURE_FIELD_CHARS) }
      : {}),
    ...(resultStatus !== undefined
      ? { resultStatus: boundText(resultStatus, MAX_FAILURE_FIELD_CHARS) }
      : {}),
    ...(attemptBudget !== undefined ? { attemptBudget } : {}),
    ...(remainingAttempts !== undefined ? { remainingAttempts } : {}),
    ...(recoveryCount !== undefined ? { recoveryCount } : {}),
    ...(pendingReviewers !== undefined
      ? {
          pendingReviewers: pendingReviewers.map((entry) =>
            boundText(entry, MAX_FAILURE_FIELD_CHARS),
          ),
        }
      : {}),
    ...(prerequisite !== undefined
      ? { prerequisite: boundText(prerequisite, MAX_FAILURE_FIELD_CHARS) }
      : guidance?.prerequisite !== undefined
        ? { prerequisite: guidance.prerequisite }
        : {}),
    ...(nextAction !== undefined
      ? { nextAction: boundText(nextAction, MAX_FAILURE_FIELD_CHARS) }
      : guidance?.nextAction !== undefined
        ? { nextAction: guidance.nextAction }
        : {}),
    ...(outcome !== undefined ? { outcome } : {}),
    ...(applied !== undefined ? { applied } : {}),
    ...(typeof failure.retrySafe === "boolean" ? { retrySafe: failure.retrySafe } : {}),
    ...(existingWorkItemId !== undefined
      ? { existingWorkItemId: boundText(existingWorkItemId, MAX_FAILURE_FIELD_CHARS) }
      : {}),
    ...(runId !== undefined ? { runId: boundText(runId, MAX_FAILURE_FIELD_CHARS) } : {}),
  };
}

/**
 * Normalize a public workflow result for output: failure envelopes (top-level
 * and batch items) gain category/guidance, everything else is returned as-is.
 * Input is never mutated. This is the producer-side representation step;
 * `validateWorkflowToolResult` validates without repair.
 */
export function normalizeWorkflowResult(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeWorkflowResult);
  }
  if (!isRecord(value)) {
    return value;
  }
  if (value.ok === false && typeof value.errorCode === "string") {
    return normalizeWorkflowFailure(value);
  }
  if (Array.isArray(value.items)) {
    return { ...value, items: value.items.map(normalizeWorkflowResult) };
  }
  return value;
}

/** Producer-side finalization: typed identity wrapper around `normalizeWorkflowResult`. */
export function finalizeWorkflowResult<T>(value: T): T {
  return normalizeWorkflowResult(value) as T;
}

/** Bounded caller-input failure carrying the exact tokenized issues. */
export function workflowInputFailure(
  toolId: string,
  sessionId: string,
  issues: readonly ContractIssue[],
): WorkflowFailureResult {
  return {
    tool: boundText(toolId, MAX_FAILURE_FIELD_CHARS),
    sessionId: boundText(sessionId, MAX_FAILURE_FIELD_CHARS),
    ok: false,
    errorCode: "INVALID_INPUT",
    category: "input",
    message: formatContractIssues(issues),
    issues: boundContractIssues(issues),
  };
}

/**
 * Trusted-host-context failure: a missing workspace root, plan loader, or
 * authorization lookup is not a caller argument error.
 */
export function workflowHostContextFailure(
  toolId: string,
  sessionId: string,
  message: string,
): WorkflowFailureResult {
  return {
    tool: boundText(toolId, MAX_FAILURE_FIELD_CHARS),
    sessionId: boundText(sessionId, MAX_FAILURE_FIELD_CHARS),
    ok: false,
    errorCode: "HOST_CONTEXT_UNAVAILABLE",
    category: "host_context",
    message: boundText(message, MAX_FAILURE_MESSAGE_CHARS),
  };
}

/**
 * Internal result-contract/serialization failure with the observed outcome.
 * Never reported as caller input and never invites an unqualified replay. An
 * `unknown` outcome omits `applied` entirely.
 */
export function workflowInternalResultFailure(options: {
  tool: string;
  sessionId?: string;
  message: string;
  outcome: WorkflowMutationOutcome;
}): WorkflowFailureResult {
  const applied = appliedForOutcome(options.outcome);
  return {
    tool: boundText(options.tool, MAX_FAILURE_FIELD_CHARS),
    ...(options.sessionId !== undefined
      ? { sessionId: boundText(options.sessionId, MAX_FAILURE_FIELD_CHARS) }
      : {}),
    ok: false,
    errorCode: "RESULT_CONTRACT_INVALID",
    category: "internal",
    message: boundText(options.message, MAX_FAILURE_MESSAGE_CHARS),
    outcome: options.outcome,
    ...(applied !== undefined ? { applied } : {}),
    retrySafe: false,
    nextAction:
      "inspect current workflow state with work_item_list before retrying; a reporting failure does not prove the mutation was skipped",
  };
}

/**
 * Thrown owned diagnostic carrying a stable code and category. The message is
 * bounded for failure diagnostics while preserving its leading code/prefix.
 */
export class WorkflowDiagnosticError extends Error {
  readonly code: string;
  readonly category: WorkflowFailureCategory;
  readonly outcome?: WorkflowMutationOutcome;

  constructor(
    code: string,
    category: WorkflowFailureCategory,
    message: string,
    outcome?: WorkflowMutationOutcome,
  ) {
    super(boundText(message, MAX_FAILURE_MESSAGE_CHARS));
    this.name = "WorkflowDiagnosticError";
    this.code = boundText(code, MAX_FAILURE_FIELD_CHARS);
    this.category = category;
    this.outcome = outcome;
  }
}
// END_BLOCK_FAILURE_DTO

// START_BLOCK_SCHEMAS
const schema = tool.schema;

const WORK_ITEM_STATES = [
  "open",
  "awaiting_implementer",
  "awaiting_reviews",
  "awaiting_acceptance",
  "needs_context",
  "blocked",
  "ready_to_close",
  "closed",
] as const;

const DELEGATED_NEXT_ACTIONS = [
  "launch_implementer",
  "await_result",
  "decide",
  "recover",
  "recover_with_user_authorization",
  "launch_blocked",
  "close",
  "closed",
] as const;

const RECOVERY_KINDS = ["resume", "autonomous_grant", "user_grant", "advance_grant"] as const;

const EXECUTION_SOURCE_KINDS = ["native-package", "conversation-scoped", "provided-plan"] as const;

const EXECUTION_STATES = ["preparing", "active", "sealed"] as const;

const TASK_STATUSES = ["pending", "launched", "accepted", "superseded"] as const;

const REVIEWER_RESULT_STATUSES = ["PASS", "FAIL", "NEEDS_CONTEXT"] as const;

const REVIEWER_AGENTS = ["vv-spec-reviewer", "vv-code-reviewer"] as const;

const CHECKPOINT_KINDS = ["milestone", "final"] as const;

const CHECKPOINT_STATUSES = ["pending", "in_review", "passed", "failed"] as const;

const CHECKPOINT_OUTCOMES = ["passed", "failed", "stale", "stopped", "incomplete"] as const;

const CHECKPOINT_HISTORY_OUTCOMES = ["passed", "failed", "stale", "stopped"] as const;

const CHECKPOINT_NEXT_ACTIONS = [
  "start",
  "collect_and_verify",
  "start_next_generation",
  "recover",
  "recover_with_user_authorization",
  "passed",
  "blocked",
] as const;

const CHECKPOINT_VERIFY_OUTCOMES = [
  "passed",
  "failed",
  "stale",
  "stopped",
  "incomplete",
  "already-passed",
] as const;

const GENERIC_REVIEW_OUTCOMES = ["in_progress", "passed", "failed", "stopped"] as const;

const AUTHORITY_PROVENANCE = ["controller_delegated", "user_observed", "unspecified"] as const;

const REVOCATION_KINDS = ["narrow", "revoke"] as const;

const REVIEW_ROUND_STATUSES = ["active", "completed"] as const;

const CONTRACT_ISSUE_CODES = [
  "unrecognized_keys",
  "invalid_value",
  "invalid_type",
  "invalid_format",
  "too_small",
  "too_big",
  "missing_value",
  "invalid_union",
  "custom",
] as const satisfies readonly ContractIssueCode[];

const contractIssueSchema = schema.strictObject({
  code: schema.enum(CONTRACT_ISSUE_CODES),
  path: schema.string().max(MAX_ISSUE_PATH_CHARS),
  message: schema.string().max(MAX_ISSUE_MESSAGE_CHARS),
  expected: schema.string().max(MAX_ISSUE_MESSAGE_CHARS).optional(),
  received: schema.string().max(MAX_ISSUE_VALUE_CHARS).optional(),
});

// START_BLOCK_FAILURE_SCHEMA
/** Enumerated failure tail shared by the generic and per-tool failure schemas. */
const failureTailShape = {
  sessionId: schema.string().max(MAX_FAILURE_FIELD_CHARS).optional(),
  ok: schema.literal(false),
  errorCode: schema.string().max(MAX_FAILURE_FIELD_CHARS),
  category: schema.enum(WORKFLOW_FAILURE_CATEGORIES),
  message: schema.string().max(MAX_FAILURE_MESSAGE_CHARS),
  issues: schema.array(contractIssueSchema).max(MAX_CONTRACT_ISSUES).optional(),
  state: schema.string().max(MAX_FAILURE_FIELD_CHARS).optional(),
  attempt: schema.number().optional(),
  attemptStatus: schema.string().max(MAX_FAILURE_FIELD_CHARS).optional(),
  resultStatus: schema.string().max(MAX_FAILURE_FIELD_CHARS).optional(),
  attemptBudget: schema.number().optional(),
  remainingAttempts: schema.number().optional(),
  recoveryCount: schema.number().optional(),
  pendingReviewers: schema.array(schema.string().max(MAX_FAILURE_FIELD_CHARS)).optional(),
  prerequisite: schema.string().max(MAX_FAILURE_FIELD_CHARS).optional(),
  nextAction: schema.string().max(MAX_FAILURE_FIELD_CHARS).optional(),
  outcome: schema.enum(WORKFLOW_MUTATION_OUTCOMES).optional(),
  applied: schema.boolean().optional(),
  retrySafe: schema.boolean().optional(),
  existingWorkItemId: schema.string().max(MAX_FAILURE_FIELD_CHARS).optional(),
  runId: schema.string().max(MAX_FAILURE_FIELD_CHARS).optional(),
} as const;

/** Generic failure schema; `tool` stays open so any owned tool can be validated. */
export const workflowFailureSchema = schema.strictObject({
  tool: schema.string(),
  ...failureTailShape,
});

/** Per-tool failure schema whose `tool` literal rejects a failure tagged for another tool. */
function failureSchemaFor(toolId: string) {
  return schema.strictObject({ tool: schema.literal(toolId), ...failureTailShape });
}
// END_BLOCK_FAILURE_SCHEMA

const resultExcerptSchema = schema.strictObject({
  source: schema.enum(["parsed_body", "normalized_output"]),
  text: schema.string(),
  truncated: schema.boolean(),
  originalLength: schema.number(),
  maxLength: schema.number(),
});

const reviewRoundResultSchema = schema.strictObject({
  reviewer: schema.enum(REVIEWER_ROLES),
  agent: schema.enum(REVIEWER_AGENTS),
  status: schema.enum(REVIEWER_RESULT_STATUSES),
  completedAt: schema.string(),
  resultExcerpt: resultExcerptSchema.optional(),
});

const reviewRoundSchema = schema.strictObject({
  round: schema.number(),
  requiredReviewers: schema.array(schema.enum(REVIEWER_ROLES)),
  pendingReviewers: schema.array(schema.enum(REVIEWER_ROLES)),
  inFlightReviewers: schema.array(schema.enum(REVIEWER_ROLES)),
  completedReviewers: schema.array(schema.enum(REVIEWER_ROLES)),
  results: schema.strictObject({
    spec: reviewRoundResultSchema.optional(),
    code: reviewRoundResultSchema.optional(),
  }),
  status: schema.enum(REVIEW_ROUND_STATUSES),
  createdAt: schema.string(),
  completedAt: schema.string().optional(),
});

const delegatedAttemptViewSchema = schema.strictObject({
  attempt: schema.number(),
  status: schema.enum(["in_flight", "completed", "failed", "report_rejected"]),
  resultStatus: schema.enum(["DONE", "DONE_WITH_CONCERNS", "NEEDS_CONTEXT", "BLOCKED"]).optional(),
  completedAt: schema.string().optional(),
  reportRejected: schema.boolean(),
});

const delegatedGuidanceViewSchema = schema.strictObject({
  nextAction: schema.enum(DELEGATED_NEXT_ACTIONS),
  launchEligible: schema.boolean(),
  blockers: schema.array(schema.string()),
  prerequisites: schema.array(schema.string()),
  requiresConcernsDisposition: schema.boolean(),
});

const delegatedWorkItemViewSchema = schema.strictObject({
  writeScope: schema.array(schema.string()),
  planRunId: schema.string().optional(),
  planTaskId: schema.string().optional(),
  attempts: schema.number(),
  inFlightAttempt: schema.boolean(),
  decisions: schema.number(),
  accepted: schema.boolean(),
  acceptedAttempt: schema.number().optional(),
  reworkCount: schema.number(),
  attemptBudget: schema.number(),
  remainingAttempts: schema.number(),
  recoveryCount: schema.number(),
  autonomousGrantConsumed: schema.boolean(),
  reportRejectionCount: schema.number(),
  nextAction: schema.enum(DELEGATED_NEXT_ACTIONS),
  latestAttempt: delegatedAttemptViewSchema.optional(),
  guidance: delegatedGuidanceViewSchema.optional(),
});

const workItemViewSchema = schema.strictObject({
  workItemId: schema.string(),
  header: schema.string(),
  key: schema.string(),
  title: schema.string(),
  mode: schema.enum(WORK_ITEM_MODES),
  requiredReviewers: schema.array(schema.enum(REVIEWER_ROLES)),
  state: schema.enum(WORK_ITEM_STATES),
  specReviewCount: schema.number(),
  codeReviewCount: schema.number(),
  reviewRound: schema.number(),
  currentRound: reviewRoundSchema.optional(),
  resultExcerpt: resultExcerptSchema.optional(),
  completedReviewRoundCount: schema.number(),
  createdAt: schema.string(),
  updatedAt: schema.string(),
  closedAt: schema.string().optional(),
  delegated: delegatedWorkItemViewSchema.optional(),
});

const executionTaskViewSchema = schema.strictObject({
  taskId: schema.string(),
  workItemId: schema.string(),
  status: schema.enum(TASK_STATUSES),
  requiredReviewers: schema.array(schema.enum(REVIEWER_ROLES)),
  dependsOn: schema.array(schema.string()),
  blockedBy: schema.array(schema.string()),
  latestAttempt: delegatedAttemptViewSchema.optional(),
});

const executionCheckpointReviewStateSchema = schema.strictObject({
  reviewWorkItemId: schema.string(),
  generation: schema.number(),
  coveredAttemptIds: schema.array(schema.string()),
  recordedReviewers: schema.array(schema.string()),
});

const executionCheckpointHistorySchema = schema.strictObject({
  generation: schema.number(),
  outcome: schema.enum(CHECKPOINT_HISTORY_OUTCOMES),
  completedAt: schema.string(),
});

const executionCheckpointViewSchema = schema.strictObject({
  checkpointId: schema.string(),
  kind: schema.enum(CHECKPOINT_KINDS),
  covers: schema.array(schema.string()),
  requiredReviewers: schema.array(schema.enum(REVIEWER_ROLES)),
  status: schema.string().optional(),
  reviewWorkItemId: schema.string().optional(),
  generation: schema.number().optional(),
  recoveryCount: schema.number().optional(),
  attempts: schema.number().optional(),
  generationBudget: schema.number().optional(),
  remainingGenerations: schema.number().optional(),
  lastOutcome: schema.enum(CHECKPOINT_OUTCOMES).optional(),
  nextAction: schema.enum(CHECKPOINT_NEXT_ACTIONS).optional(),
  prerequisite: schema.string().optional(),
  currentReview: executionCheckpointReviewStateSchema.optional(),
  history: schema.array(executionCheckpointHistorySchema).optional(),
});

const executionAuthorityViewSchema = schema.strictObject({
  authorityId: schema.string(),
  availableUnits: schema.number(),
  revoked: schema.boolean(),
  stages: schema.array(schema.enum(AUTHORITY_STAGES)),
  reservedStops: schema.array(schema.enum(AUTHORITY_STAGES)),
  prerequisites: schema.array(schema.string()),
});

const executionViewSchema = schema.strictObject({
  runId: schema.string(),
  sessionId: schema.string(),
  executionKey: schema.string(),
  sourceKind: schema.enum(EXECUTION_SOURCE_KINDS),
  goal: schema.string(),
  state: schema.enum(EXECUTION_STATES),
  revision: schema.number(),
  tasks: schema.array(executionTaskViewSchema),
  checkpoints: schema.array(executionCheckpointViewSchema),
  authority: schema.array(executionAuthorityViewSchema).optional(),
});

const delegatedRunTaskViewSchema = schema.strictObject({
  taskId: schema.string(),
  workItemId: schema.string(),
});

const delegatedRunCheckpointViewSchema = schema.strictObject({
  checkpointId: schema.string(),
  kind: schema.enum(CHECKPOINT_KINDS),
  afterWave: schema.string(),
  covers: schema.array(schema.string()),
  scope: schema.array(schema.string()),
  reviewers: schema.array(schema.enum(REVIEWER_ROLES)),
  status: schema.enum(CHECKPOINT_STATUSES),
  attempts: schema.number(),
  lastOutcome: schema.enum(CHECKPOINT_OUTCOMES).optional(),
  generationBudget: schema.number(),
  remainingGenerations: schema.number(),
  recoveryCount: schema.number(),
  nextAction: schema.enum(CHECKPOINT_NEXT_ACTIONS),
  prerequisite: schema.string().optional(),
  currentReview: schema
    .strictObject({
      reviewWorkItemId: schema.string(),
      generation: schema.number(),
      coveredAttemptIds: schema.array(schema.string()),
      recordedReviewers: schema.array(schema.string()),
    })
    .optional(),
  history: schema.array(
    schema.strictObject({
      generation: schema.number(),
      outcome: schema.enum(CHECKPOINT_HISTORY_OUTCOMES),
      fingerprint: schema.string(),
      completedAt: schema.string(),
    }),
  ),
});

const delegatedRunViewSchema = schema.strictObject({
  runId: schema.string(),
  sessionId: schema.string(),
  planPath: schema.string(),
  specPath: schema.string(),
  workspaceRoot: schema.string(),
  status: schema.enum(["active", "sealed"]),
  registeredAt: schema.string(),
  sealedAt: schema.string().optional(),
  finalCheckpointId: schema.string().optional(),
  tasks: schema.array(delegatedRunTaskViewSchema),
  checkpoints: schema.array(delegatedRunCheckpointViewSchema),
});
// END_BLOCK_SCHEMAS

// START_BLOCK_TOOL_RESULT_SCHEMAS
const openItemFailureSchema = schema.strictObject({
  ok: schema.literal(false),
  errorCode: schema.string().max(MAX_FAILURE_FIELD_CHARS),
  category: schema.enum(WORKFLOW_FAILURE_CATEGORIES).optional(),
  message: schema.string().max(MAX_FAILURE_MESSAGE_CHARS),
  existingWorkItemId: schema.string().max(MAX_FAILURE_FIELD_CHARS).optional(),
  state: schema.string().max(MAX_FAILURE_FIELD_CHARS).optional(),
  prerequisite: schema.string().max(MAX_FAILURE_FIELD_CHARS).optional(),
  nextAction: schema.string().max(MAX_FAILURE_FIELD_CHARS).optional(),
});

const openItemSuccessSchema = schema.strictObject({
  ok: schema.literal(true),
  reused: schema.boolean(),
  workItemId: schema.string(),
  header: schema.string(),
  key: schema.string(),
  title: schema.string(),
  mode: schema.enum(WORK_ITEM_MODES),
  requiredReviewers: schema.array(schema.enum(REVIEWER_ROLES)),
  state: schema.enum(WORK_ITEM_STATES),
  specReviewCount: schema.number(),
  codeReviewCount: schema.number(),
  reviewRound: schema.number(),
  currentRound: reviewRoundSchema.optional(),
  resultExcerpt: resultExcerptSchema.optional(),
  completedReviewRoundCount: schema.number(),
  createdAt: schema.string(),
  updatedAt: schema.string(),
  closedAt: schema.string().optional(),
  delegated: delegatedWorkItemViewSchema.optional(),
});

const workItemOpenBatchSchema = schema.strictObject({
  tool: schema.literal("work_item_open"),
  sessionId: schema.string(),
  items: schema.array(schema.union([openItemSuccessSchema, openItemFailureSchema])),
});

const workItemOpenRegisterSchema = schema.strictObject({
  tool: schema.literal("work_item_open"),
  sessionId: schema.string(),
  ok: schema.literal(true),
  action: schema.literal("register"),
  runId: schema.string(),
  reused: schema.boolean(),
  execution: executionViewSchema,
});

const workItemOpenAmendSchema = schema.strictObject({
  tool: schema.literal("work_item_open"),
  sessionId: schema.string(),
  ok: schema.literal(true),
  action: schema.literal("amend"),
  runId: schema.string(),
  revision: schema.number(),
  execution: executionViewSchema,
});

const workflowContractIdentitySchema = schema.strictObject({
  packageName: schema.string(),
  packageVersion: schema.string(),
  toolContractRevision: schema.string(),
  referencePath: schema.string(),
});

const workItemListViewSchema = schema.strictObject({
  tool: schema.literal("work_item_list"),
  sessionId: schema.string(),
  includeClosed: schema.boolean(),
  items: schema.array(workItemViewSchema),
  planRuns: schema.array(delegatedRunViewSchema).optional(),
  executions: schema.array(executionViewSchema).optional(),
  contract: workflowContractIdentitySchema,
});

const workItemCloseSuccessSchema = schema.strictObject({
  tool: schema.literal("work_item_close"),
  sessionId: schema.string(),
  ok: schema.literal(true),
  workItemId: schema.string(),
  header: schema.string(),
  state: schema.enum(WORK_ITEM_STATES),
  closedAt: schema.string(),
});

const decideReworkSuccessSchema = schema.strictObject({
  tool: schema.literal("work_item_decide"),
  sessionId: schema.string(),
  ok: schema.literal(true),
  action: schema.literal("rework"),
  workItemId: schema.string(),
  reworkId: schema.string(),
  grantedAttempts: schema.number(),
  state: schema.enum(WORK_ITEM_STATES).optional(),
});

const decideRecoverSuccessSchema = schema.strictObject({
  tool: schema.literal("work_item_decide"),
  sessionId: schema.string(),
  ok: schema.literal(true),
  action: schema.literal("recover"),
  workItemId: schema.string(),
  recoveryId: schema.string(),
  kind: schema.enum(RECOVERY_KINDS),
  attemptBudget: schema.number(),
  remainingAttempts: schema.number(),
  state: schema.enum(WORK_ITEM_STATES),
  nextAction: schema.enum(DELEGATED_NEXT_ACTIONS),
});

const decideDecisionSuccessSchema = schema.strictObject({
  tool: schema.literal("work_item_decide"),
  sessionId: schema.string(),
  ok: schema.literal(true),
  action: schema.enum(["accept", "request_changes"]),
  workItemId: schema.string(),
  attempt: schema.number(),
  decisionId: schema.string(),
  state: schema.enum(WORK_ITEM_STATES),
});

const checkpointRegisterSuccessSchema = schema.strictObject({
  tool: schema.literal("work_checkpoint"),
  sessionId: schema.string(),
  ok: schema.literal(true),
  action: schema.literal("register"),
  runId: schema.string(),
  reused: schema.boolean(),
  tasks: schema.number(),
  checkpoints: schema.number(),
});

const checkpointStartSuccessSchema = schema.strictObject({
  tool: schema.literal("work_checkpoint"),
  sessionId: schema.string(),
  ok: schema.literal(true),
  action: schema.literal("start"),
  runId: schema.string(),
  checkpointId: schema.string(),
  generation: schema.number().optional(),
  reviewWorkItemId: schema.string(),
  header: schema.string(),
  reviewersToLaunch: schema.array(schema.enum(REVIEWER_ROLES)),
  coveredAttemptIds: schema.array(schema.string()).optional(),
});

const checkpointVerifyNativeSuccessSchema = schema.strictObject({
  tool: schema.literal("work_checkpoint"),
  sessionId: schema.string(),
  ok: schema.literal(true),
  action: schema.literal("verify"),
  runId: schema.string(),
  checkpointId: schema.string(),
  outcome: schema.enum(CHECKPOINT_VERIFY_OUTCOMES),
  snapshotCurrent: schema.boolean(),
  sealedRun: schema.boolean().optional(),
});

const checkpointReviewSuccessSchema = schema.strictObject({
  tool: schema.literal("work_checkpoint"),
  sessionId: schema.string(),
  ok: schema.literal(true),
  action: schema.enum(["review", "bind", "verify"]),
  runId: schema.string(),
  checkpointId: schema.string(),
  reviewer: schema.enum(REVIEWER_ROLES).optional(),
  outcome: schema.enum(GENERIC_REVIEW_OUTCOMES),
  checkpointStatus: schema.enum(CHECKPOINT_STATUSES),
});

const checkpointRecoverSuccessSchema = schema.strictObject({
  tool: schema.literal("work_checkpoint"),
  sessionId: schema.string(),
  ok: schema.literal(true),
  action: schema.literal("recover"),
  runId: schema.string(),
  checkpointId: schema.string(),
  recoveryId: schema.string(),
  kind: schema.enum(RECOVERY_KINDS),
  checkpointStatus: schema.enum(CHECKPOINT_STATUSES),
  generationBudget: schema.number().optional(),
  settledStoppedGeneration: schema.number().optional(),
  lastOutcome: schema.enum(CHECKPOINT_OUTCOMES).optional(),
});

const checkpointAmendSuccessSchema = schema.strictObject({
  tool: schema.literal("work_checkpoint"),
  sessionId: schema.string(),
  runId: schema.string(),
  ok: schema.literal(true),
  action: schema.literal("amend"),
  revision: schema.number(),
  execution: executionViewSchema,
});

const checkpointCompleteSuccessSchema = schema.strictObject({
  tool: schema.literal("work_checkpoint"),
  sessionId: schema.string(),
  runId: schema.string(),
  ok: schema.literal(true),
  action: schema.literal("complete"),
  reviewStatus: schema.enum(["controller_accepted", "independently_reviewed"]),
  execution: executionViewSchema,
});

const checkpointAuthorizeSuccessSchema = schema.strictObject({
  tool: schema.literal("work_checkpoint"),
  sessionId: schema.string(),
  runId: schema.string(),
  ok: schema.literal(true),
  action: schema.literal("authorize"),
  authorityId: schema.string(),
  reused: schema.boolean().optional(),
  units: schema.number().optional(),
  extensions: schema.number().optional(),
  availableUnits: schema.number(),
});

const checkpointRecordApprovalSuccessSchema = schema.strictObject({
  tool: schema.literal("work_checkpoint"),
  sessionId: schema.string(),
  runId: schema.string(),
  ok: schema.literal(true),
  action: schema.literal("record_approval"),
  approvalId: schema.string(),
  stage: schema.enum(AUTHORITY_STAGES),
  provenance: schema.enum(AUTHORITY_PROVENANCE),
});

const checkpointRevokeSuccessSchema = schema.strictObject({
  tool: schema.literal("work_checkpoint"),
  sessionId: schema.string(),
  runId: schema.string(),
  ok: schema.literal(true),
  action: schema.literal("revoke_authority"),
  authorityId: schema.string(),
  kind: schema.enum(REVOCATION_KINDS),
  availableUnits: schema.number(),
  stages: schema.array(schema.enum(AUTHORITY_STAGES)),
});

const workItemOpenResultSchema = schema.union([
  workItemOpenBatchSchema,
  workItemOpenRegisterSchema,
  workItemOpenAmendSchema,
  failureSchemaFor("work_item_open"),
]);

const workItemListResultSchema = schema.union([
  workItemListViewSchema,
  failureSchemaFor("work_item_list"),
]);

const workItemCloseResultSchema = schema.union([
  workItemCloseSuccessSchema,
  failureSchemaFor("work_item_close"),
]);

const workItemDecideResultSchema = schema.union([
  decideReworkSuccessSchema,
  decideRecoverSuccessSchema,
  decideDecisionSuccessSchema,
  failureSchemaFor("work_item_decide"),
]);

const workCheckpointResultSchema = schema.union([
  checkpointRegisterSuccessSchema,
  checkpointStartSuccessSchema,
  checkpointVerifyNativeSuccessSchema,
  checkpointReviewSuccessSchema,
  checkpointRecoverSuccessSchema,
  checkpointAmendSuccessSchema,
  checkpointCompleteSuccessSchema,
  checkpointAuthorizeSuccessSchema,
  checkpointRecordApprovalSuccessSchema,
  checkpointRevokeSuccessSchema,
  failureSchemaFor("work_checkpoint"),
]);

/** Closed per-tool result schema map; exported for inspection/catalog consumers. */
export const workflowToolResultSchemas = {
  work_item_open: workItemOpenResultSchema,
  work_item_list: workItemListResultSchema,
  work_item_close: workItemCloseResultSchema,
  work_item_decide: workItemDecideResultSchema,
  work_checkpoint: workCheckpointResultSchema,
} as const;

export type WorkflowToolResultToolId = keyof typeof workflowToolResultSchemas;

/** Schema-derived per-tool result DTO map for future inspection/catalog consumers. */
export type WorkflowToolResultMap = {
  [K in WorkflowToolResultToolId]: z.infer<(typeof workflowToolResultSchemas)[K]>;
};

/** Bounded loaded-identity view returned by work_item_list.contract. */
export type WorkflowContractIdentity = z.infer<typeof workflowContractIdentitySchema>;

/** Read-only execution view shared by generic register/amend/complete and inspection. */
export type WorkflowExecutionView = z.infer<typeof executionViewSchema>;

/** Read-only native plan-run view kept alongside the unified execution view. */
export type WorkflowDelegatedRunView = z.infer<typeof delegatedRunViewSchema>;

/** Read-only work-item view, including delegated budget/guidance, returned by work_item_list.items. */
export type WorkflowWorkItemView = z.infer<typeof workItemViewSchema>;

/** Additive work_item_list inspection payload. */
export type WorkflowInspectionView = z.infer<typeof workItemListViewSchema>;

/** Closed result schema for one owned workflow tool id, preserving its inferred type. */
export function workflowToolResultSchema<K extends WorkflowToolResultToolId>(
  toolId: K,
): (typeof workflowToolResultSchemas)[K] {
  return workflowToolResultSchemas[toolId];
}

/**
 * Producer/test validation of one owned workflow tool result against its
 * closed schema. It does not normalize or repair failures first: a malformed
 * producer representation fails rather than being made compliant. Producers
 * apply `finalizeWorkflowResult` before this is used on their output.
 * Never call this as a throw-after-side-effect execute wrapper.
 */
export function validateWorkflowToolResult(
  toolId: WorkflowToolResultToolId,
  value: unknown,
): { ok: true } | { ok: false; issues: readonly ContractIssue[] } {
  const schemaForTool = workflowToolResultSchemas[toolId] as unknown as z.ZodType;
  const result = schemaForTool.safeParse(value);
  if (result.success) {
    return { ok: true };
  }
  // Reuse the bounded issue formatter from the shared contract primitives.
  return { ok: false, issues: toContractIssues(result.error) };
}
// END_BLOCK_TOOL_RESULT_SCHEMAS

// START_BLOCK_SERIALIZATION
/**
 * Serialize a public workflow result. Producers finalize category/guidance
 * before this point, so this is a pure presentation step (no silent repair). If
 * serialization itself fails after execution, produce a bounded truthful
 * internal error carrying the observed outcome instead of throwing raw or
 * inviting an unqualified replay. An `unknown` outcome omits `applied`.
 */
export function serializeWorkflowResult(
  value: Record<string, unknown>,
  options?: { outcome?: WorkflowMutationOutcome },
): string {
  try {
    const text = JSON.stringify(value, null, 2);
    return text === undefined ? "null" : text;
  } catch {
    const tool = typeof value.tool === "string" ? value.tool : "workflow";
    const outcome = options?.outcome ?? "unknown";
    const applied = appliedForOutcome(outcome);
    const fallback = {
      tool,
      ok: false,
      errorCode: "RESULT_SERIALIZATION_FAILED",
      category: "internal",
      message:
        "the workflow result could not be serialized after execution; the mutation outcome must be inspected, not assumed",
      outcome,
      ...(applied !== undefined ? { applied } : {}),
      retrySafe: false,
      nextAction:
        "inspect current workflow state with work_item_list before retrying; a reporting failure does not prove the mutation was skipped",
    };
    return JSON.stringify(fallback, null, 2);
  }
}
// END_BLOCK_SERIALIZATION
