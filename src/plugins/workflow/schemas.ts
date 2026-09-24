// FILE: src/plugins/workflow/schemas.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Single source of truth for the five workflow tool argument schemas, their closed nested request structures, field descriptions, canonical enums/bounds, and the derived TypeScript argument types.
//   SCOPE: SDK tool.schema field maps for work_item_open, work_item_list, work_item_close, work_item_decide, and work_checkpoint consumed by the plugin registrations in index.ts, the owned-tool contracts in input-validation.ts, and tooling.ts. Closed nested objects (task items, execution descriptors, boundaries, typed task/checkpoint batches), canonical mode/reviewer/stage enums, and provided-plan source variants are declared here; a bound is published only where the field's owning domain validator actually enforces it, applied after the documented trim so surrounding whitespace never rejects a canonically valid value. Unbounded collections and paths stay uncapped. No tool may declare its arguments elsewhere, and no schema transform rewrites the input projection shape.
//   DEPENDS: [@opencode-ai/plugin, zod (types), src/lib/agent-tool-contract.ts (strictObject), src/lib/workflow-contract.ts (canonical enums and text bounds), src/plugins/workflow/delegated.ts (rationale/evidence bounds)]
//   LINKS: [M-WORKFLOW-TOOLING, M-PLUGIN-WORKFLOW, M-AGENT-TOOL-CONTRACT, M-WORKFLOW-CONTRACT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   workItemOpenArgs - Closed field map for the work_item_open tool registration.
//   workItemListArgs - Closed field map for the work_item_list tool registration.
//   workItemCloseArgs - Closed field map for the work_item_close tool registration.
//   workItemDecideArgs - Closed field map for the work_item_decide tool registration.
//   workCheckpointArgs - Closed field map for the work_checkpoint tool registration.
//   OpenArgs - work_item_open argument shape derived from the schema.
//   OpenItemInput - One closed work-item/task input entry.
//   OpenExecutionInput - Generic execution descriptor with a closed source union and boundary.
//   OpenCheckpointInput - Typed generic checkpoint contract entry.
//   ListArgs - work_item_list argument shape derived from the schema.
//   CloseArgs - work_item_close argument shape derived from the schema.
//   DecideArgs - work_item_decide argument shape derived from the schema.
//   CheckpointArgs - work_checkpoint argument shape derived from the schema.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-002 - Replaced opaque records/strings with closed nested structures, canonical enums, provided-plan source variants, typed task/checkpoint batches, delegated text bounds, and field descriptions; argument types remain derived from these schemas. Field descriptions state the action/decision scope enforced by the runtime matrix. Each published bound now mirrors its owning domain validator (boundedTextList counts/text, canonical bounded ids, delegated evidence/rationale limits) and is applied after trim; boundary/writeScope/scope paths and batch/reviewer/stage counts are unbounded because their owning validators are.]
// END_CHANGE_SUMMARY

import { tool } from "@opencode-ai/plugin";
import type { z } from "zod";
import { strictObject } from "../../lib/agent-tool-contract.js";
import {
  AUTHORITY_STAGES,
  REVIEWER_ROLES,
  WORKFLOW_ID_MAX_CHARS,
  WORKFLOW_TEXT_MAX_CHARS,
  WORKFLOW_TEXT_MAX_ITEMS,
  WORK_ITEM_MODES,
} from "../../lib/workflow-contract.js";
import {
  DELEGATED_EVIDENCE_MAX_CHARS,
  DELEGATED_EVIDENCE_MAX_REFS,
  DELEGATED_RATIONALE_MAX_CHARS,
} from "./delegated.js";

const schema = tool.schema;

/**
 * Bound helpers mirror the owning domain validator, and apply the documented
 * trim BEFORE the length bound so surrounding whitespace can never reject a
 * canonically valid value. Only fields whose owning validator actually enforces
 * one of these bounds use them; unbounded fields stay plain/trim-only strings.
 */
/** Required bounded text (goal, rationale); owning validator trims then bounds. */
const boundedText = () => schema.string().trim().min(1).max(WORKFLOW_TEXT_MAX_CHARS);

/** Required canonical workflow identity; owning validator trims then bounds to WORKFLOW_ID_MAX_CHARS. */
const boundedId = () => schema.string().trim().min(1).max(WORKFLOW_ID_MAX_CHARS);

/** Bounded evidence/verification reference (also the delegated recoveryId bound). */
const evidenceRef = () => schema.string().trim().min(1).max(DELEGATED_EVIDENCE_MAX_CHARS);

/** Required non-empty string with no owning length bound (trim only; ids, paths, and hashes). */
const plainNonEmpty = () => schema.string().trim().min(1);

// START_BLOCK_TASK_ITEM_SCHEMA
/**
 * Closed work-item/task entry shared by work_item_open batches and generic
 * work_checkpoint task amendments. Branch rules (standalone versus generic
 * mode requirements, reviewer sets, and native-binding conflicts) are enforced
 * by validateWorkflowToolInput; this shape only declares the closed fields.
 */
function taskItemSchema() {
  return strictObject({
    key: plainNonEmpty().describe(
      "Idempotency key for this work item within the session (trimmed; non-empty).",
    ),
    title: plainNonEmpty().describe("Human-readable work-item or task title (trimmed; non-empty)."),
    mode: schema
      .enum(WORK_ITEM_MODES)
      .describe(
        "Workflow intent: implementation/review_only for standalone items, delegated for generic task bindings.",
      ),
    requiredReviewers: schema
      .array(schema.enum(REVIEWER_ROLES))
      .max(REVIEWER_ROLES.length)
      .describe(
        `Explicit reviewer roles (at most ${REVIEWER_ROLES.length}). Standalone implementation/review_only require a non-empty unique set; delegated and generic tasks accept [] for no independent review.`,
      ),
    writeScope: schema
      .array(plainNonEmpty())
      .optional()
      .describe(
        "Workspace-relative exact file paths this item may write (unbounded count; each trimmed, non-empty, no trailing separator). Required and non-empty for delegated and generic tasks; forbidden for standalone implementation/review_only.",
      ),
    planRunId: plainNonEmpty()
      .optional()
      .describe("Native plan-run binding; delegated standalone only, paired with planTaskId."),
    planTaskId: plainNonEmpty()
      .optional()
      .describe("Native plan-task binding; delegated standalone only, paired with planRunId."),
    taskId: boundedId()
      .optional()
      .describe(
        `Generic task id (defaults to key on generic open/append; trimmed, at most ${WORKFLOW_ID_MAX_CHARS} characters).`,
      ),
    goal: boundedText()
      .optional()
      .describe("Generic task goal (defaults to title on generic open/append)."),
    acceptanceCriteria: schema
      .array(boundedText())
      .max(WORKFLOW_TEXT_MAX_ITEMS)
      .optional()
      .describe(
        `Generic task acceptance criterion texts (at most ${WORKFLOW_TEXT_MAX_ITEMS} entries of at most ${WORKFLOW_TEXT_MAX_CHARS} characters).`,
      ),
    verification: schema
      .array(boundedText())
      .max(WORKFLOW_TEXT_MAX_ITEMS)
      .optional()
      .describe(
        `Generic task verification command references (at most ${WORKFLOW_TEXT_MAX_ITEMS} entries of at most ${WORKFLOW_TEXT_MAX_CHARS} characters).`,
      ),
    dependsOn: schema
      .array(boundedId())
      .max(WORKFLOW_TEXT_MAX_ITEMS)
      .optional()
      .describe(
        `Generic task dependency ids that must be accepted first (at most ${WORKFLOW_TEXT_MAX_ITEMS} canonical ids).`,
      ),
    blockedBy: schema
      .array(boundedId())
      .max(WORKFLOW_TEXT_MAX_ITEMS)
      .optional()
      .describe(
        `Generic task checkpoint barrier ids that must pass first (at most ${WORKFLOW_TEXT_MAX_ITEMS} canonical ids).`,
      ),
  });
}
// END_BLOCK_TASK_ITEM_SCHEMA

// START_BLOCK_EXECUTION_SOURCE_SCHEMA
/** Closed conversation-scoped source variant of the generic execution descriptor. */
const conversationSourceSchema = strictObject({
  kind: schema.literal("conversation-scoped").describe("Requirements come from this conversation."),
});

/** Closed provided-plan source variant; native-package sources are not accepted here. */
const providedPlanSourceSchema = strictObject({
  kind: schema
    .literal("provided-plan")
    .describe("Requirements come from a provided plan document."),
  reference: boundedText().describe(
    `Bounded reference to the provided plan document (trimmed, at most ${WORKFLOW_TEXT_MAX_CHARS} characters).`,
  ),
  sha256: plainNonEmpty()
    .optional()
    .describe("Optional integrity hash of the referenced document; must be a non-empty string."),
});

/** Closed generic execution source union: conversation-scoped or provided-plan only. */
const executionSourceSchema = schema
  .union([conversationSourceSchema, providedPlanSourceSchema])
  .describe(
    "Execution source identity. Only conversation-scoped and provided-plan variants are accepted; native packages register through work_checkpoint register with a planPath.",
  );

/** Closed typed generic checkpoint contract entry for registration/amendment batches. */
const checkpointContractSchema = strictObject({
  checkpointId: boundedId().describe(
    `Bounded checkpoint identity (trimmed, at most ${WORKFLOW_ID_MAX_CHARS} characters).`,
  ),
  kind: schema.enum(["milestone", "final"]).describe("Checkpoint kind."),
  covers: schema
    .array(boundedId())
    .min(1)
    .max(WORKFLOW_TEXT_MAX_ITEMS)
    .describe(
      `Non-empty task ids covered by this checkpoint (at most ${WORKFLOW_TEXT_MAX_ITEMS} canonical ids).`,
    ),
  scope: schema
    .array(plainNonEmpty())
    .optional()
    .describe("Workspace-relative exact files under review (unbounded count); defaults to none."),
  requiredReviewers: schema
    .array(schema.enum(REVIEWER_ROLES))
    .min(1)
    .max(REVIEWER_ROLES.length)
    .describe("Non-empty canonical reviewer set; every role must pass."),
  acceptance: schema
    .array(boundedText())
    .max(WORKFLOW_TEXT_MAX_ITEMS)
    .optional()
    .describe(
      `Acceptance criterion texts (at most ${WORKFLOW_TEXT_MAX_ITEMS} bounded entries); defaults to none.`,
    ),
  verification: schema
    .array(boundedText())
    .max(WORKFLOW_TEXT_MAX_ITEMS)
    .optional()
    .describe(
      `Verification command references (at most ${WORKFLOW_TEXT_MAX_ITEMS} bounded entries); defaults to none.`,
    ),
  origin: schema
    .enum(["source", "user", "controller"])
    .describe("Obligation origin recorded with the checkpoint."),
  dependsOn: schema
    .array(boundedId())
    .max(WORKFLOW_TEXT_MAX_ITEMS)
    .optional()
    .describe(
      `Checkpoint ids that must pass first (at most ${WORKFLOW_TEXT_MAX_ITEMS} canonical ids); defaults to none.`,
    ),
});
// END_BLOCK_EXECUTION_SOURCE_SCHEMA

// START_BLOCK_OPEN_ARGS_SCHEMA
export const workItemOpenArgs = {
  items: schema
    .array(taskItemSchema())
    .min(1)
    .describe("Non-empty batch of work items or generic task bindings (unbounded count)."),
  execution: strictObject({
    executionKey: boundedId().describe(
      `Bounded identity of the generic execution to register (trimmed, at most ${WORKFLOW_ID_MAX_CHARS} characters).`,
    ),
    source: executionSourceSchema,
    goal: boundedText().describe("Bounded execution goal."),
    boundary: strictObject({
      files: schema
        .array(plainNonEmpty())
        .describe(
          "Normalized workspace-relative exact file paths of the execution boundary (unbounded count and length).",
        ),
      directories: schema
        .array(plainNonEmpty())
        .describe(
          "Workspace-relative directory subtrees of the execution boundary (unbounded count); one trailing separator is normalized away.",
        ),
    }).describe("Exact files plus named directory subtrees contained by this execution."),
    checkpoints: schema
      .array(checkpointContractSchema)
      .optional()
      .describe("Typed checkpoint contracts declared with the first task batch (unbounded count)."),
  })
    .optional()
    .describe(
      "Generic execution descriptor for registration; mutually exclusive with runId. Requires the trusted workspace root from the plugin context.",
    ),
  runId: plainNonEmpty()
    .optional()
    .describe("Existing generic execution to append to; mutually exclusive with execution."),
  amendmentId: boundedId()
    .optional()
    .describe(
      `Bounded amendment identity (trimmed, at most ${WORKFLOW_ID_MAX_CHARS} characters); required with runId appends.`,
    ),
  rationale: boundedText()
    .optional()
    .describe("Bounded amendment rationale; required with runId appends."),
};

const workItemOpenArgsObject = strictObject(workItemOpenArgs);

/** work_item_open argument shape, single-sourced from the schema. */
export type OpenArgs = z.infer<typeof workItemOpenArgsObject>;
/** One closed work-item/task entry of a work_item_open batch. */
export type OpenItemInput = OpenArgs["items"][number];
/** Generic execution descriptor of work_item_open. */
export type OpenExecutionInput = NonNullable<OpenArgs["execution"]>;
/** Typed checkpoint contract entry of the generic execution descriptor. */
export type OpenCheckpointInput = NonNullable<OpenExecutionInput["checkpoints"]>[number];
// END_BLOCK_OPEN_ARGS_SCHEMA

// START_BLOCK_LIST_AND_CLOSE_ARGS_SCHEMAS
export const workItemListArgs = {
  includeClosed: schema
    .boolean()
    .optional()
    .describe("Include closed work items in the listing; defaults to false."),
};

const workItemListArgsObject = strictObject(workItemListArgs);

/** work_item_list argument shape, single-sourced from the schema. */
export type ListArgs = z.infer<typeof workItemListArgsObject>;

export const workItemCloseArgs = {
  workItemId: boundedId().describe("Non-empty id of the work item to close."),
};

const workItemCloseArgsObject = strictObject(workItemCloseArgs);

/** work_item_close argument shape, single-sourced from the schema. */
export type CloseArgs = z.infer<typeof workItemCloseArgsObject>;
// END_BLOCK_LIST_AND_CLOSE_ARGS_SCHEMAS

// START_BLOCK_DECIDE_ARGS_SCHEMA
export const workItemDecideArgs = {
  workItemId: plainNonEmpty().describe("Non-empty id of the delegated work item (trimmed)."),
  attempt: schema
    .number()
    .int()
    .min(1)
    .describe("Positive integer attempt number the decision targets."),
  decision: schema
    .enum(["accept", "request_changes", "rework", "recover"])
    .describe("Controller decision family for this call."),
  rationale: schema
    .string()
    .trim()
    .min(1)
    .max(DELEGATED_RATIONALE_MAX_CHARS)
    .optional()
    .describe(
      `Bounded rationale (trimmed, at most ${DELEGATED_RATIONALE_MAX_CHARS} characters). Required non-empty for accept/request_changes; optional reason for rework.`,
    ),
  evidence: schema
    .array(evidenceRef())
    .max(DELEGATED_EVIDENCE_MAX_REFS)
    .optional()
    .describe(
      `Bounded evidence references (at most ${DELEGATED_EVIDENCE_MAX_REFS}). Required non-empty for accept/request_changes.`,
    ),
  concernsDisposition: schema
    .string()
    .trim()
    .min(1)
    .max(DELEGATED_RATIONALE_MAX_CHARS)
    .optional()
    .describe(
      "Bounded disposition of recorded concerns; required by the domain only when the terminal record demands it.",
    ),
  runId: plainNonEmpty()
    .optional()
    .describe("Failed-checkpoint run for rework, or authority-owning run for recover."),
  checkpointId: boundedId().optional().describe("Failed checkpoint id; required for rework."),
  diagnosis: schema
    .string()
    .trim()
    .min(1)
    .max(DELEGATED_RATIONALE_MAX_CHARS)
    .optional()
    .describe("Bounded recovery diagnosis; required non-empty for recover."),
  changedCondition: schema
    .string()
    .trim()
    .min(1)
    .max(DELEGATED_RATIONALE_MAX_CHARS)
    .optional()
    .describe("Bounded changed condition; required non-empty for recover."),
  verification: schema
    .array(evidenceRef())
    .max(DELEGATED_EVIDENCE_MAX_REFS)
    .optional()
    .describe(
      `Bounded verification references (at most ${DELEGATED_EVIDENCE_MAX_REFS}); required non-empty for recover.`,
    ),
  recoveryId: evidenceRef()
    .optional()
    .describe(
      `Stable recovery identity (trimmed, at most ${DELEGATED_EVIDENCE_MAX_CHARS} characters); required for recover.`,
    ),
  userMessageId: plainNonEmpty()
    .optional()
    .describe("Optional root-user authorization message id for recover."),
  authorityId: boundedId()
    .optional()
    .describe("Recorded advance authority funding recover; requires the owning runId."),
};

const workItemDecideArgsObject = strictObject(workItemDecideArgs);

/** work_item_decide argument shape, single-sourced from the schema. */
export type DecideArgs = z.infer<typeof workItemDecideArgsObject>;
// END_BLOCK_DECIDE_ARGS_SCHEMA

// START_BLOCK_CHECKPOINT_ARGS_SCHEMA
export const workCheckpointArgs = {
  action: schema
    .enum([
      "register",
      "start",
      "verify",
      "recover",
      "review",
      "bind",
      "complete",
      "amend",
      "authorize",
      "record_approval",
      "revoke_authority",
    ])
    .describe("Checkpoint/authority action to perform."),
  planPath: plainNonEmpty()
    .optional()
    .describe(
      "Workspace-relative approved native plan path (trimmed, non-empty); native register only, never combined with runId.",
    ),
  runId: plainNonEmpty()
    .optional()
    .describe(
      "Target execution run. Required for every action except native register with planPath.",
    ),
  checkpointId: boundedId()
    .optional()
    .describe(
      `Checkpoint id (trimmed, at most ${WORKFLOW_ID_MAX_CHARS} characters); required for start/verify/recover/review/bind.`,
    ),
  complete: schema.boolean().optional().describe("Seal a finished final checkpoint on verify."),
  diagnosis: schema
    .string()
    .trim()
    .min(1)
    .max(DELEGATED_RATIONALE_MAX_CHARS)
    .optional()
    .describe("Bounded recovery diagnosis; required non-empty for recover."),
  changedCondition: schema
    .string()
    .trim()
    .min(1)
    .max(DELEGATED_RATIONALE_MAX_CHARS)
    .optional()
    .describe("Bounded changed condition; required non-empty for recover."),
  verification: schema
    .array(evidenceRef())
    .max(DELEGATED_EVIDENCE_MAX_REFS)
    .optional()
    .describe(
      `Bounded verification references (at most ${DELEGATED_EVIDENCE_MAX_REFS}); required non-empty for recover and optional completion evidence for complete.`,
    ),
  recoveryId: evidenceRef()
    .optional()
    .describe(
      `Stable recovery identity (trimmed, at most ${DELEGATED_EVIDENCE_MAX_CHARS} characters); required for recover.`,
    ),
  userMessageId: plainNonEmpty()
    .optional()
    .describe(
      "Root-user authorization message id; native-package checkpoint recovery only, not generic recovery.",
    ),
  checkpoints: schema
    .array(checkpointContractSchema)
    .optional()
    .describe("Typed checkpoint contracts for generic register/amend batches (unbounded count)."),
  tasks: schema
    .array(taskItemSchema())
    .optional()
    .describe("Typed task items for generic register/amend batches (unbounded count)."),
  amendmentId: boundedId()
    .optional()
    .describe(
      `Bounded amendment identity (trimmed, at most ${WORKFLOW_ID_MAX_CHARS} characters); required for generic register/amend.`,
    ),
  rationale: schema
    .string()
    .trim()
    .min(1)
    .max(WORKFLOW_TEXT_MAX_CHARS)
    .optional()
    .describe(
      "Bounded rationale; required for generic register/amend, optional context for complete/revocation.",
    ),
  startFingerprint: plainNonEmpty()
    .optional()
    .describe("Optional expected start fingerprint for generic start."),
  reviewer: schema
    .enum(REVIEWER_ROLES)
    .optional()
    .describe("Optional canonical reviewer role for generic review/bind/verify."),
  authorityId: boundedId()
    .optional()
    .describe("Recorded advance authority for authorize/approval/revocation or recover."),
  messageId: boundedId()
    .optional()
    .describe("Eligible root-user authorization message id; required for authorize."),
  approvalId: boundedId()
    .optional()
    .describe("Bounded stage-approval identity; required for record_approval."),
  stage: schema
    .enum(AUTHORITY_STAGES)
    .optional()
    .describe("Authority stage being approved; required for record_approval."),
  stages: schema
    .array(schema.enum(AUTHORITY_STAGES))
    .optional()
    .describe(
      "Delegatable stages (unbounded count). Required non-empty for authorize; optional surviving-stage set for revoke_authority narrowing. Every entry must be canonical.",
    ),
  decisionScope: schema
    .string()
    .trim()
    .max(WORKFLOW_TEXT_MAX_CHARS)
    .optional()
    .describe(
      "Bounded decision scope recorded with an authority grant; authorize only. An explicitly empty value keeps the documented empty default.",
    ),
  fileBoundary: schema
    .array(plainNonEmpty())
    .optional()
    .describe("File boundary recorded with an authority grant (unbounded count); authorize only."),
  reservedStops: schema
    .array(schema.enum(AUTHORITY_STAGES))
    .optional()
    .describe(
      "Reserved lifecycle stops retained for explicit user action (unbounded count); every entry must be a canonical stage. authorize only; defaults to none.",
    ),
  artifactPath: plainNonEmpty()
    .optional()
    .describe("Approved artifact path; required for record_approval."),
  artifactSha256: plainNonEmpty()
    .optional()
    .describe("Approved artifact hash; required for record_approval."),
  revocationId: boundedId()
    .optional()
    .describe("Bounded revocation identity; required for revoke_authority."),
};

const workCheckpointArgsObject = strictObject(workCheckpointArgs);

/** work_checkpoint argument shape, single-sourced from the schema. */
export type CheckpointArgs = z.infer<typeof workCheckpointArgsObject>;
// END_BLOCK_CHECKPOINT_ARGS_SCHEMA
