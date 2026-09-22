// FILE: src/plugins/workflow/schemas.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Single source of truth for the workflow tool argument schemas and their derived TypeScript argument types.
//   SCOPE: Zod field maps for work_item_open, work_item_list, work_item_close, work_item_decide, and work_checkpoint built on the plugin API schema instance (tool.schema), plus z.infer argument types consumed by tooling.ts and the plugin registrations in index.ts. Field names, optionality, enums, and bounds exactly match the previously inline schemas; no tool may declare its arguments elsewhere.
//   DEPENDS: [@opencode-ai/plugin]
//   LINKS: [M-WORKFLOW-TOOLING, M-PLUGIN-WORKFLOW]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   workItemOpenArgs - Field map for the work_item_open tool registration.
//   workItemListArgs - Field map for the work_item_list tool registration.
//   workItemCloseArgs - Field map for the work_item_close tool registration.
//   workItemDecideArgs - Field map for the work_item_decide tool registration.
//   workCheckpointArgs - Field map for the work_checkpoint tool registration.
//   OpenArgs - work_item_open argument shape derived from the schema.
//   ListArgs - work_item_list argument shape derived from the schema.
//   CloseArgs - work_item_close argument shape derived from the schema.
//   DecideArgs - work_item_decide argument shape derived from the schema.
//   CheckpointArgs - work_checkpoint argument shape derived from the schema.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-WORKFLOW-INDEX-REDUCE - Extracted the five inline tool argument schemas from index.ts and the locally redeclared argument types from tooling.ts into this single-sourced module; accepted shapes are unchanged.]
// END_CHANGE_SUMMARY

import { tool } from "@opencode-ai/plugin";
import type { z } from "zod";

const schema = tool.schema;

// START_BLOCK_OPEN_ARGS_SCHEMA
export const workItemOpenArgs = {
  items: schema.array(
    schema.object({
      key: schema.string(),
      title: schema.string(),
      mode: schema.string(),
      requiredReviewers: schema.array(schema.string()),
      writeScope: schema.array(schema.string()).optional(),
      planRunId: schema.string().optional(),
      planTaskId: schema.string().optional(),
      taskId: schema.string().optional(),
      goal: schema.string().optional(),
      acceptanceCriteria: schema.array(schema.string()).optional(),
      verification: schema.array(schema.string()).optional(),
      dependsOn: schema.array(schema.string()).optional(),
      blockedBy: schema.array(schema.string()).optional(),
    }),
  ),
  execution: schema
    .object({
      executionKey: schema.string(),
      source: schema.record(schema.string(), schema.unknown()),
      goal: schema.string(),
      boundary: schema.object({
        files: schema.array(schema.string()),
        directories: schema.array(schema.string()),
      }),
      checkpoints: schema.array(schema.record(schema.string(), schema.unknown())).optional(),
    })
    .optional(),
  runId: schema.string().optional(),
  amendmentId: schema.string().optional(),
  rationale: schema.string().optional(),
};

const workItemOpenArgsObject = schema.object(workItemOpenArgs);

/** work_item_open argument shape, single-sourced from the schema. */
export type OpenArgs = z.infer<typeof workItemOpenArgsObject>;
// END_BLOCK_OPEN_ARGS_SCHEMA

// START_BLOCK_LIST_AND_CLOSE_ARGS_SCHEMAS
export const workItemListArgs = {
  includeClosed: schema.boolean().optional(),
};

const workItemListArgsObject = schema.object(workItemListArgs);

/** work_item_list argument shape, single-sourced from the schema. */
export type ListArgs = z.infer<typeof workItemListArgsObject>;

export const workItemCloseArgs = {
  workItemId: schema.string(),
};

const workItemCloseArgsObject = schema.object(workItemCloseArgs);

/** work_item_close argument shape, single-sourced from the schema. */
export type CloseArgs = z.infer<typeof workItemCloseArgsObject>;
// END_BLOCK_LIST_AND_CLOSE_ARGS_SCHEMAS

// START_BLOCK_DECIDE_ARGS_SCHEMA
export const workItemDecideArgs = {
  workItemId: schema.string(),
  attempt: schema.number().int().min(1),
  decision: schema.enum(["accept", "request_changes", "rework", "recover"]),
  rationale: schema.string().optional(),
  evidence: schema.array(schema.string()).optional(),
  concernsDisposition: schema.string().optional(),
  runId: schema.string().optional(),
  checkpointId: schema.string().optional(),
  diagnosis: schema.string().optional(),
  changedCondition: schema.string().optional(),
  verification: schema.array(schema.string()).optional(),
  recoveryId: schema.string().optional(),
  userMessageId: schema.string().optional(),
  authorityId: schema.string().optional(),
};

const workItemDecideArgsObject = schema.object(workItemDecideArgs);

/** work_item_decide argument shape, single-sourced from the schema. */
export type DecideArgs = z.infer<typeof workItemDecideArgsObject>;
// END_BLOCK_DECIDE_ARGS_SCHEMA

// START_BLOCK_CHECKPOINT_ARGS_SCHEMA
export const workCheckpointArgs = {
  action: schema.enum([
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
  ]),
  planPath: schema.string().optional(),
  runId: schema.string().optional(),
  checkpointId: schema.string().optional(),
  complete: schema.boolean().optional(),
  diagnosis: schema.string().optional(),
  changedCondition: schema.string().optional(),
  verification: schema.array(schema.string()).optional(),
  recoveryId: schema.string().optional(),
  userMessageId: schema.string().optional(),
  checkpoints: schema.array(schema.record(schema.string(), schema.unknown())).optional(),
  tasks: schema.array(schema.record(schema.string(), schema.unknown())).optional(),
  amendmentId: schema.string().optional(),
  rationale: schema.string().optional(),
  startFingerprint: schema.string().optional(),
  reviewer: schema.string().optional(),
  authorityId: schema.string().optional(),
  messageId: schema.string().optional(),
  approvalId: schema.string().optional(),
  stage: schema.string().optional(),
  stages: schema.array(schema.string()).optional(),
  decisionScope: schema.string().optional(),
  fileBoundary: schema.array(schema.string()).optional(),
  reservedStops: schema.array(schema.string()).optional(),
  artifactPath: schema.string().optional(),
  artifactSha256: schema.string().optional(),
  revocationId: schema.string().optional(),
};

const workCheckpointArgsObject = schema.object(workCheckpointArgs);

/** work_checkpoint argument shape, single-sourced from the schema. */
export type CheckpointArgs = z.infer<typeof workCheckpointArgsObject>;
// END_BLOCK_CHECKPOINT_ARGS_SCHEMA
