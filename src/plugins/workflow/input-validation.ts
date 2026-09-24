// FILE: src/plugins/workflow/input-validation.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Own strict branch-aware runtime input validation for all five vvoc workflow tools: owned-tool contracts over the registered argument maps, canonical standalone/generic/checkpoint/decision/authority branch rules, an args-only allowed/required field matrix for every action and decision, whitespace/omission normalization, and the exported validateWorkflowToolInput entry shared by the tool.execute.before hook and every direct handler.
//   SCOPE: Structural full-object parsing (unknown keys, enums, owning-validator bounds, closed nested shapes), documented trim with field-specific blank rejection from the contract schema, plus args-only branch conditions from the approved workflow branch matrix: execution/runId exclusivity, standalone versus generic item rules, source variants, action-specific required fields, recognized-field conflicts with the selected action/decision, bounded decision/recovery fields, and authority stage/stop validity. No store lookup, no state eligibility, no permission decisions, no filesystem or SDK session access.
//   DEPENDS: [src/lib/agent-tool-contract.ts, src/lib/workflow-contract.ts, src/plugins/workflow/schemas.ts]
//   LINKS: [M-WORKFLOW-TOOLING, M-AGENT-TOOL-CONTRACT, M-WORKFLOW-CONTRACT, M-PLUGIN-WORKFLOW]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   WORKFLOW_TOOL_IDS - Canonical ids of the five vvoc-owned workflow tools.
//   WorkflowToolId - Union of the five workflow tool ids.
//   isWorkflowToolId - Whether a value names an owned workflow tool.
//   WORKFLOW_TOOL_DESCRIPTIONS - Canonical public descriptions shared by registrations and contracts.
//   WorkflowToolInputMap - Schema-derived argument type per workflow tool id.
//   WorkflowToolValidation - Successful parsed arguments or bounded structural/branch issues.
//   validateWorkflowToolInput - Strict structural plus branch validation for one workflow tool call.
//   assertWorkflowToolInput - Throwing guard mirroring the owned pre-execute contract, including branch rules.
//   workflowToolContracts - Owned-tool contracts for the five workflow tools.
//   getWorkflowToolContract - Contract lookup by tool id.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-002 - Initial branch-aware workflow tool input validation with exported validateWorkflowToolInput, owned contracts, and canonical descriptions; correction cycle adds an args-only action/decision field matrix, bounded branch diagnostics with precise indexed boundary paths, and shared generic task branch validation for both work_item_open items and work_checkpoint register/amend tasks. Field-specific trims/bounds now live in the contract schema so no blanket recursive string rejection is applied.]
// END_CHANGE_SUMMARY

import type { ZodRawShape } from "zod";
import {
  ContractInputError,
  MAX_CONTRACT_ISSUES,
  MAX_ISSUE_MESSAGE_CHARS,
  MAX_ISSUE_PATH_CHARS,
  MAX_ISSUE_VALUE_CHARS,
  defineOwnedToolContract,
  formatIssuePath,
  summarizeReceivedValue,
  type ContractIssue,
  type OwnedToolContract,
} from "../../lib/agent-tool-contract.js";
import {
  normalizeDeclaredScopePath,
  validateExecutionBoundary,
} from "../../lib/workflow-contract.js";
import {
  workCheckpointArgs,
  workItemCloseArgs,
  workItemDecideArgs,
  workItemListArgs,
  workItemOpenArgs,
  type CheckpointArgs,
  type CloseArgs,
  type DecideArgs,
  type ListArgs,
  type OpenArgs,
} from "./schemas.js";

// START_BLOCK_TOOL_IDS
/** Canonical ids of the five vvoc-owned workflow tools. */
export const WORKFLOW_TOOL_IDS = [
  "work_item_open",
  "work_item_list",
  "work_item_close",
  "work_item_decide",
  "work_checkpoint",
] as const;

/** Union of the five workflow tool ids. */
export type WorkflowToolId = (typeof WORKFLOW_TOOL_IDS)[number];

/** Whether a value names an owned workflow tool. */
export function isWorkflowToolId(value: unknown): value is WorkflowToolId {
  return typeof value === "string" && (WORKFLOW_TOOL_IDS as readonly string[]).includes(value);
}

/** Canonical public descriptions shared by registrations and contracts. */
export const WORKFLOW_TOOL_DESCRIPTIONS = {
  work_item_open:
    "Open one or more workflow work items idempotently with explicit mode and requiredReviewers.",
  work_item_list: "List workflow work items for the current session.",
  work_item_close: "Close a workflow work item by id when it is ready_to_close.",
  work_item_decide:
    "Accept or request changes for the current completed delegated attempt, authorize bounded rework of an accepted task from a failed checkpoint, or recover a stopped or exhausted unaccepted task with a bounded diagnosis and changed condition.",
  work_checkpoint:
    "Register an approved delegated plan, start a declared review checkpoint, verify checkpoint outcomes, or recover a stopped or generation-exhausted checkpoint; verify with complete: true seals a finished final checkpoint.",
} as const satisfies Record<WorkflowToolId, string>;
// END_BLOCK_TOOL_IDS

// START_BLOCK_CONTRACTS
/** Schema-derived argument type per workflow tool id (defaults applied). */
export interface WorkflowToolInputMap {
  work_item_open: OpenArgs;
  work_item_list: ListArgs;
  work_item_close: CloseArgs;
  work_item_decide: DecideArgs;
  work_checkpoint: CheckpointArgs;
}

const contracts = {
  work_item_open: defineOwnedToolContract({
    toolId: "work_item_open",
    description: WORKFLOW_TOOL_DESCRIPTIONS.work_item_open,
    registeredArgs: workItemOpenArgs,
  }),
  work_item_list: defineOwnedToolContract({
    toolId: "work_item_list",
    description: WORKFLOW_TOOL_DESCRIPTIONS.work_item_list,
    registeredArgs: workItemListArgs,
  }),
  work_item_close: defineOwnedToolContract({
    toolId: "work_item_close",
    description: WORKFLOW_TOOL_DESCRIPTIONS.work_item_close,
    registeredArgs: workItemCloseArgs,
  }),
  work_item_decide: defineOwnedToolContract({
    toolId: "work_item_decide",
    description: WORKFLOW_TOOL_DESCRIPTIONS.work_item_decide,
    registeredArgs: workItemDecideArgs,
  }),
  work_checkpoint: defineOwnedToolContract({
    toolId: "work_checkpoint",
    description: WORKFLOW_TOOL_DESCRIPTIONS.work_checkpoint,
    registeredArgs: workCheckpointArgs,
  }),
} as const;

/** Owned-tool contracts for the five workflow tools. */
export const workflowToolContracts: readonly OwnedToolContract<ZodRawShape>[] = [
  contracts.work_item_open,
  contracts.work_item_list,
  contracts.work_item_close,
  contracts.work_item_decide,
  contracts.work_checkpoint,
];

/** Contract lookup by tool id. */
export function getWorkflowToolContract(toolId: WorkflowToolId): OwnedToolContract<ZodRawShape> {
  return contracts[toolId];
}

/** Successful parsed arguments or bounded structural/branch issues. */
export type WorkflowToolValidation<TToolId extends WorkflowToolId> =
  | { ok: true; data: WorkflowToolInputMap[TToolId] }
  | { ok: false; issues: readonly ContractIssue[] };
// END_BLOCK_CONTRACTS

// START_BLOCK_BRANCH_ISSUES
function truncateChars(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** Bound one branch-level issue so every claimed-bounded diagnostic is finite. */
function boundedIssue(issue: ContractIssue): ContractIssue {
  return {
    code: issue.code,
    path: truncateChars(issue.path, MAX_ISSUE_PATH_CHARS),
    message: truncateChars(issue.message, MAX_ISSUE_MESSAGE_CHARS),
    ...(issue.expected !== undefined
      ? { expected: truncateChars(issue.expected, MAX_ISSUE_MESSAGE_CHARS) }
      : {}),
    ...(issue.received !== undefined
      ? { received: truncateChars(issue.received, MAX_ISSUE_VALUE_CHARS) }
      : {}),
  };
}

function pushIssue(issues: ContractIssue[], issue: ContractIssue): void {
  if (issues.length >= MAX_CONTRACT_ISSUES) return;
  issues.push(boundedIssue(issue));
}

function missingIssue(
  issues: ContractIssue[],
  path: readonly (string | number)[],
  message: string,
  expected: string,
): void {
  pushIssue(issues, {
    code: "missing_value",
    path: formatIssuePath(path),
    message,
    expected,
  });
}

function conflictIssue(
  issues: ContractIssue[],
  path: readonly (string | number)[],
  message: string,
  expected: string,
): void {
  pushIssue(issues, {
    code: "invalid_value",
    path: formatIssuePath(path),
    message,
    expected,
  });
}

function requireNonEmpty(
  issues: ContractIssue[],
  value: string | undefined,
  path: readonly (string | number)[],
  label: string,
): void {
  if (value === undefined || value.trim() === "") {
    missingIssue(issues, path, `${label} must be a non-empty string`, `a non-empty ${label}`);
  }
}

function requireNonEmptyList(
  issues: ContractIssue[],
  values: readonly string[] | undefined,
  path: readonly (string | number)[],
  label: string,
): void {
  if (values === undefined || values.length === 0) {
    missingIssue(issues, path, `${label} must be a non-empty array`, `at least one ${label} entry`);
    return;
  }
  values.forEach((entry, index) => {
    if (entry.trim() === "") {
      missingIssue(
        issues,
        [...path, index],
        `${label} entries must be non-empty strings`,
        `a non-empty ${label} entry`,
      );
    }
  });
}
// END_BLOCK_BRANCH_ISSUES

// START_BLOCK_OPEN_BRANCHES
const GENERIC_TASK_FIELDS = [
  "taskId",
  "goal",
  "acceptanceCriteria",
  "verification",
  "dependsOn",
  "blockedBy",
] as const;

function validateDeclaredFileList(
  issues: ContractIssue[],
  entries: readonly string[],
  path: readonly (string | number)[],
): void {
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const normalized = normalizeDeclaredScopePath(entry);
    if (!normalized.ok) {
      conflictIssue(
        issues,
        [...path, index],
        `path ${summarizeReceivedValue(entry)} is malformed (${normalized.reason})`,
        "a workspace-relative exact file path without traversal, wildcards, or trailing separators",
      );
      return;
    }
    if (seen.has(normalized.path)) {
      conflictIssue(
        issues,
        [...path, index],
        `path ${summarizeReceivedValue(normalized.path)} is declared more than once`,
        "unique file paths",
      );
      return;
    }
    seen.add(normalized.path);
  });
}

/**
 * Validate one task/work-item entry against its mode. `base` is the exact token
 * path to the entry (`["items", i]` for work_item_open, `["tasks", i]` for
 * work_checkpoint register/amend) so both entry routes share the same rules and
 * report their own indexed paths.
 */
function validateOpenItemBranch(
  issues: ContractIssue[],
  item: OpenArgs["items"][number],
  base: readonly (string | number)[],
  generic: boolean,
): void {
  if (generic) {
    if (item.mode !== "delegated") {
      conflictIssue(
        issues,
        [...base, "mode"],
        "generic open/append items require mode delegated",
        '"delegated"',
      );
    }
    if (item.planRunId !== undefined || item.planTaskId !== undefined) {
      conflictIssue(
        issues,
        [...base, "planRunId"],
        "native plan bindings conflict with generic open/append items",
        "no planRunId/planTaskId on generic tasks",
      );
    }
    if (item.writeScope === undefined || item.writeScope.length === 0) {
      missingIssue(
        issues,
        [...base, "writeScope"],
        "generic tasks require a non-empty writeScope of workspace-relative files",
        "at least one workspace-relative file path",
      );
    } else {
      validateDeclaredFileList(issues, item.writeScope, [...base, "writeScope"]);
    }
    if (new Set(item.requiredReviewers).size !== item.requiredReviewers.length) {
      conflictIssue(
        issues,
        [...base, "requiredReviewers"],
        "requiredReviewers must be a unique spec/code array",
        "unique canonical reviewer roles",
      );
    }
    return;
  }

  for (const field of GENERIC_TASK_FIELDS) {
    if (item[field] !== undefined) {
      conflictIssue(
        issues,
        [...base, field],
        `${field} is a generic task field and conflicts with standalone work_item_open items`,
        "generic task fields only on execution/runId open or work_checkpoint amendments",
      );
    }
  }

  if (item.mode === "delegated") {
    if (item.requiredReviewers.length !== 0) {
      conflictIssue(
        issues,
        [...base, "requiredReviewers"],
        "delegated mode requires an explicitly empty requiredReviewers array",
        "[]",
      );
    }
    if (item.writeScope === undefined || item.writeScope.length === 0) {
      missingIssue(
        issues,
        [...base, "writeScope"],
        "delegated mode requires a non-empty writeScope of workspace-relative files",
        "at least one workspace-relative file path",
      );
    } else {
      validateDeclaredFileList(issues, item.writeScope, [...base, "writeScope"]);
    }
    if ((item.planRunId === undefined) !== (item.planTaskId === undefined)) {
      const offending = item.planRunId === undefined ? "planRunId" : "planTaskId";
      conflictIssue(
        issues,
        [...base, offending],
        "planRunId and planTaskId must be provided together",
        "both native plan bindings or neither",
      );
    }
    return;
  }

  // standalone implementation / review_only
  if (item.requiredReviewers.length === 0) {
    missingIssue(
      issues,
      [...base, "requiredReviewers"],
      "standalone implementation/review_only require a non-empty unique reviewer set",
      "at least one canonical spec/code reviewer",
    );
  } else if (new Set(item.requiredReviewers).size !== item.requiredReviewers.length) {
    conflictIssue(
      issues,
      [...base, "requiredReviewers"],
      "requiredReviewers must be a unique spec/code array",
      "unique canonical reviewer roles",
    );
  }
  if (item.writeScope !== undefined) {
    conflictIssue(
      issues,
      [...base, "writeScope"],
      `writeScope is only valid for delegated mode, not ${item.mode}`,
      "no writeScope on standalone implementation/review_only items",
    );
  }
  if (item.planRunId !== undefined || item.planTaskId !== undefined) {
    const offending = item.planRunId !== undefined ? "planRunId" : "planTaskId";
    conflictIssue(
      issues,
      [...base, offending],
      `plan bindings are only valid for delegated mode, not ${item.mode}`,
      "no plan bindings on standalone implementation/review_only items",
    );
  }
}

function validateOpenBranches(issues: ContractIssue[], data: OpenArgs): void {
  const hasExecution = data.execution !== undefined;
  const hasRunId = data.runId !== undefined;
  if (hasExecution && hasRunId) {
    conflictIssue(
      issues,
      ["execution"],
      "execution and runId are mutually exclusive",
      "exactly one of execution (register) or runId (append)",
    );
  }
  if (hasExecution) {
    // Amendment context belongs to runId appends only; a registration must not
    // silently drop supplied append-only fields.
    for (const field of ["amendmentId", "rationale"] as const) {
      if (data[field] !== undefined) {
        conflictIssue(
          issues,
          [field],
          `${field} is append-only amendment context and conflicts with execution registration`,
          "runId with amendment context instead of execution",
        );
      }
    }
  }
  if (!hasExecution && !hasRunId) {
    if (data.amendmentId !== undefined || data.rationale !== undefined) {
      conflictIssue(
        issues,
        ["amendmentId"],
        "amendmentId and rationale are only valid with runId appends",
        "runId with amendment context",
      );
    }
  }

  const generic = hasExecution || hasRunId;
  data.items.forEach((item, index) =>
    validateOpenItemBranch(issues, item, ["items", index], generic),
  );

  if (data.execution) {
    const boundary = validateExecutionBoundary(data.execution.boundary);
    if (!boundary.ok) {
      for (const problem of boundary.problems) {
        pushIssue(issues, {
          code: problem.code === "EMPTY_BOUNDARY" ? "missing_value" : "invalid_value",
          // The pure boundary validator supplies the indexed file/directory path;
          // never reconstruct it by parsing the prose message.
          path: formatIssuePath(["execution", ...(problem.path ?? ["boundary"])]),
          message: problem.message,
          expected: "normalized non-empty exact files or directory subtrees",
        });
      }
    }
  }
  if (hasRunId) {
    requireNonEmpty(issues, data.runId, ["runId"], "runId");
    requireNonEmpty(issues, data.amendmentId, ["amendmentId"], "amendmentId");
    requireNonEmpty(issues, data.rationale, ["rationale"], "rationale");
  }
}
// END_BLOCK_OPEN_BRANCHES

// START_BLOCK_DECIDE_BRANCHES
/**
 * Args-only field matrix for work_item_decide, derived from the fields each
 * decision branch actually consumes. A recognized field supplied for a
 * different decision is rejected instead of being silently ignored.
 */
const DECIDE_DECISION_FIELDS: Record<DecideArgs["decision"], readonly string[]> = {
  accept: ["workItemId", "attempt", "decision", "rationale", "evidence", "concernsDisposition"],
  request_changes: [
    "workItemId",
    "attempt",
    "decision",
    "rationale",
    "evidence",
    "concernsDisposition",
  ],
  rework: ["workItemId", "attempt", "decision", "runId", "checkpointId", "rationale"],
  recover: [
    "workItemId",
    "attempt",
    "decision",
    "recoveryId",
    "diagnosis",
    "changedCondition",
    "verification",
    "userMessageId",
    "authorityId",
    "runId",
  ],
};

function validateDecideFieldMatrix(issues: ContractIssue[], data: DecideArgs): void {
  const allowed = new Set(DECIDE_DECISION_FIELDS[data.decision]);
  for (const key of Object.keys(data)) {
    const value = (data as Record<string, unknown>)[key];
    if (value === undefined || allowed.has(key)) continue;
    conflictIssue(
      issues,
      [key],
      `${key} is not consumed by decision ${data.decision}`,
      `only ${[...allowed].join(", ")}`,
    );
  }
}

function validateDecideBranches(issues: ContractIssue[], data: DecideArgs): void {
  validateDecideFieldMatrix(issues, data);
  requireNonEmpty(issues, data.workItemId, ["workItemId"], "workItemId");
  if (data.concernsDisposition !== undefined && data.concernsDisposition.trim() === "") {
    missingIssue(
      issues,
      ["concernsDisposition"],
      "concernsDisposition must be a non-empty string when provided",
      "a non-empty concerns disposition",
    );
  }

  if (data.decision === "accept" || data.decision === "request_changes") {
    requireNonEmpty(issues, data.rationale, ["rationale"], "rationale");
    requireNonEmptyList(issues, data.evidence, ["evidence"], "evidence");
    return;
  }
  if (data.decision === "rework") {
    requireNonEmpty(issues, data.runId, ["runId"], "runId");
    requireNonEmpty(issues, data.checkpointId, ["checkpointId"], "checkpointId");
    return;
  }

  // recover
  requireNonEmpty(issues, data.recoveryId, ["recoveryId"], "recoveryId");
  requireNonEmpty(issues, data.diagnosis, ["diagnosis"], "diagnosis");
  requireNonEmpty(issues, data.changedCondition, ["changedCondition"], "changedCondition");
  requireNonEmptyList(issues, data.verification, ["verification"], "verification");
  if (data.authorityId !== undefined) {
    requireNonEmpty(issues, data.runId, ["runId"], "runId");
  } else if (data.runId !== undefined) {
    // runId is only consumed by recover when it owns the advance authority;
    // without authorityId it would be silently ignored.
    conflictIssue(
      issues,
      ["runId"],
      "runId is only consumed by recover together with an authorityId",
      "authorityId with its owning runId, or neither",
    );
  }
}
// END_BLOCK_DECIDE_BRANCHES

// START_BLOCK_CHECKPOINT_BRANCHES
/**
 * Args-only allowed-field matrix for work_checkpoint, derived from the fields
 * each action branch (native and generic) actually consumes. A recognized field
 * supplied for a different action is rejected instead of being silently ignored;
 * fields that are only valid on one source variant stay allowed here and are
 * resolved by the source lookup in tooling.ts.
 */
const CHECKPOINT_ACTION_FIELDS: Record<CheckpointArgs["action"], readonly string[]> = {
  register: ["planPath", "runId", "amendmentId", "rationale", "tasks", "checkpoints"],
  start: ["runId", "checkpointId", "startFingerprint"],
  verify: ["runId", "checkpointId", "complete", "reviewer"],
  recover: [
    "runId",
    "checkpointId",
    "recoveryId",
    "diagnosis",
    "changedCondition",
    "verification",
    "userMessageId",
    "authorityId",
  ],
  review: ["runId", "checkpointId", "reviewer"],
  bind: ["runId", "checkpointId", "reviewer"],
  complete: ["runId", "rationale", "verification"],
  amend: ["runId", "amendmentId", "rationale", "tasks", "checkpoints"],
  authorize: [
    "runId",
    "authorityId",
    "messageId",
    "stages",
    "decisionScope",
    "fileBoundary",
    "reservedStops",
  ],
  record_approval: [
    "runId",
    "authorityId",
    "approvalId",
    "stage",
    "artifactPath",
    "artifactSha256",
  ],
  revoke_authority: ["runId", "authorityId", "revocationId", "stages", "rationale"],
};

function validateCheckpointFieldMatrix(issues: ContractIssue[], data: CheckpointArgs): void {
  const allowed = new Set(CHECKPOINT_ACTION_FIELDS[data.action]);
  for (const key of Object.keys(data)) {
    if (key === "action") continue;
    const value = (data as Record<string, unknown>)[key];
    if (value === undefined || allowed.has(key)) continue;
    conflictIssue(
      issues,
      [key],
      `${key} is not consumed by action ${data.action}`,
      `only ${[...allowed].join(", ")}`,
    );
  }
}

function validateCheckpointBranches(issues: ContractIssue[], data: CheckpointArgs): void {
  validateCheckpointFieldMatrix(issues, data);
  const hasPlanPath = data.planPath !== undefined;
  const hasRunId = data.runId !== undefined;
  const action = data.action;

  // Generic register/amend tasks obey the same branch rules as work_item_open
  // generic items; without this they reached the store with a conflicting mode
  // or native bindings silently erased.
  if ((action === "register" || action === "amend") && hasRunId && data.tasks !== undefined) {
    data.tasks.forEach((task, index) =>
      validateOpenItemBranch(issues, task, ["tasks", index], true),
    );
  }

  if (action === "register") {
    if (hasPlanPath && hasRunId) {
      conflictIssue(
        issues,
        ["runId"],
        "register accepts either planPath (native package) or runId (generic amend context), not both",
        "exactly one registration route",
      );
    }
    if (hasPlanPath) {
      // Native package registration loads the plan itself; generic task and
      // amendment fields are not consumed and must not be silently ignored.
      for (const field of ["amendmentId", "rationale", "tasks", "checkpoints"] as const) {
        if (data[field] !== undefined) {
          conflictIssue(
            issues,
            [field],
            `${field} is generic register/amend context and conflicts with native planPath registration`,
            "no generic registration fields with planPath",
          );
        }
      }
    }
    if (!hasPlanPath) {
      if (!hasRunId) {
        missingIssue(
          issues,
          ["runId"],
          "generic register requires the target runId of an existing execution",
          "the existing execution runId",
        );
      }
      requireNonEmpty(issues, data.amendmentId, ["amendmentId"], "amendmentId");
      requireNonEmpty(issues, data.rationale, ["rationale"], "rationale");
    }
  } else if (!hasRunId) {
    missingIssue(
      issues,
      ["runId"],
      `action ${action} requires the target runId`,
      "the target execution runId",
    );
  }

  switch (action) {
    case "start":
    case "verify":
    case "review":
    case "bind":
      requireNonEmpty(issues, data.checkpointId, ["checkpointId"], "checkpointId");
      return;
    case "recover":
      requireNonEmpty(issues, data.runId, ["runId"], "runId");
      requireNonEmpty(issues, data.checkpointId, ["checkpointId"], "checkpointId");
      requireNonEmpty(issues, data.recoveryId, ["recoveryId"], "recoveryId");
      requireNonEmpty(issues, data.diagnosis, ["diagnosis"], "diagnosis");
      requireNonEmpty(issues, data.changedCondition, ["changedCondition"], "changedCondition");
      requireNonEmptyList(issues, data.verification, ["verification"], "verification");
      return;
    case "amend":
      requireNonEmpty(issues, data.runId, ["runId"], "runId");
      requireNonEmpty(issues, data.amendmentId, ["amendmentId"], "amendmentId");
      requireNonEmpty(issues, data.rationale, ["rationale"], "rationale");
      return;
    case "complete":
      return;
    case "authorize":
      requireNonEmpty(issues, data.authorityId, ["authorityId"], "authorityId");
      requireNonEmpty(issues, data.messageId, ["messageId"], "messageId");
      if (data.stages === undefined || data.stages.length === 0) {
        missingIssue(
          issues,
          ["stages"],
          "authorize requires explicit delegatable stages",
          "at least one canonical authority stage",
        );
      }
      return;
    case "record_approval":
      requireNonEmpty(issues, data.authorityId, ["authorityId"], "authorityId");
      requireNonEmpty(issues, data.approvalId, ["approvalId"], "approvalId");
      if (data.stage === undefined) {
        missingIssue(
          issues,
          ["stage"],
          "record_approval requires an authority stage",
          "a canonical authority stage",
        );
      }
      requireNonEmpty(issues, data.artifactPath, ["artifactPath"], "artifactPath");
      requireNonEmpty(issues, data.artifactSha256, ["artifactSha256"], "artifactSha256");
      return;
    case "revoke_authority":
      requireNonEmpty(issues, data.authorityId, ["authorityId"], "authorityId");
      requireNonEmpty(issues, data.revocationId, ["revocationId"], "revocationId");
      return;
    default:
      return;
  }
}
// END_BLOCK_CHECKPOINT_BRANCHES

// START_BLOCK_VALIDATE_ENTRY
/**
 * Strict structural plus branch validation for one workflow tool call.
 * Unknown keys, enums, and nested shapes fail first; empty-after-trim supplied
 * values fail next for the whole request; then the args-only branch matrix
 * enforces required fields and rejects recognized fields that conflict with the
 * selected action or decision. Every issue carries a bounded tokenized path.
 * The result never mutates the input and never confers state/permission eligibility.
 */
export function validateWorkflowToolInput<TToolId extends WorkflowToolId>(
  toolId: TToolId,
  rawArgs: unknown,
): WorkflowToolValidation<TToolId> {
  const contract = contracts[toolId];
  // The contract schema already applies the documented trim and rejects a
  // supplied blank on every field whose owning validator requires non-empty
  // (whole-request structural rejection before any item opens). Empty content
  // that is a documented default (decisionScope) stays representable.
  const parsed = contract.safeParse(rawArgs);
  if (!parsed.success) {
    return { ok: false, issues: parsed.issues };
  }

  const issues: ContractIssue[] = [];
  switch (toolId) {
    case "work_item_open":
      validateOpenBranches(issues, parsed.data as OpenArgs);
      break;
    case "work_item_list":
      break;
    case "work_item_close":
      requireNonEmpty(issues, (parsed.data as CloseArgs).workItemId, ["workItemId"], "workItemId");
      break;
    case "work_item_decide":
      validateDecideBranches(issues, parsed.data as DecideArgs);
      break;
    case "work_checkpoint":
      validateCheckpointBranches(issues, parsed.data as CheckpointArgs);
      break;
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, data: parsed.data as WorkflowToolInputMap[TToolId] };
}

/** Throwing guard mirroring the owned pre-execute contract, including branch rules. */
export function assertWorkflowToolInput(toolId: WorkflowToolId, rawArgs: unknown): void {
  const result = validateWorkflowToolInput(toolId, rawArgs);
  if (!result.ok) {
    throw new ContractInputError(toolId, result.issues);
  }
}
// END_BLOCK_VALIDATE_ENTRY
