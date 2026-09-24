// FILE: src/lib/agent-tool-catalog.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Own the pure nine-tool agent-tool catalog: one entry per vvoc-owned registered tool aggregating its descriptor contract, model-facing vocabularies, checked positive/negative operation fixtures, execute-time defaults, state/host prerequisites, conditional requirements, path kinds, result variants, representative errors, a deterministic generated reference renderer, a fixture runner over the actual exported validators/result schemas, and the recorded contract-size baseline.
//   SCOPE: Catalog aggregation and reference generation only. Imports descriptor modules (workflow input-validation/results, edit schemas, web schemas) and shared contract primitives; never imports plugin factories, config, stores, filesystem, network, or workflow state, so no catalog-to-runtime cycle exists. Fixtures are pure synthetic data validated through the owning runtime validators; the catalog grants no permission, state eligibility, or acceptance.
//   DEPENDS: [@opencode-ai/plugin, src/lib/agent-tool-contract.ts, src/plugins/workflow/input-validation.ts, src/plugins/workflow/results.ts, src/plugins/hashline-edit/schemas.ts, src/plugins/web-tools/schemas.ts, zod (types)]
//   LINKS: [M-AGENT-TOOL-CONTRACT, M-WORKFLOW-TOOLING, M-PLUGIN-HASHLINE-EDIT, M-PLUGIN-WEB-TOOLS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   CatalogOperation - One checked positive/negative input fixture with coverage metadata.
//   CatalogVocabulary - A model-facing closed vocabulary for one discriminated input field.
//   CatalogDefault - An execute-time default applied by a tool schema.
//   CatalogPathKind - Declared meaning and rules for one path argument.
//   CatalogResultVariant - One checked result-family fixture for a tool.
//   CatalogErrorExample - Representative failure diagnostic path/expectation.
//   CatalogValidationResult - Structural validation outcome exposed for fixture checks.
//   AgentToolCatalogEntry - Aggregated catalog entry for one owned tool.
//   CONTRACT_REFERENCE_PACKAGE_PATH - Package-relative path of the generated reference document.
//   CONTRACT_SIZE_BASELINE - Recorded pre-change contract-size baseline with provenance.
//   agentToolCatalog - The nine owned tool catalog entries.
//   AGENT_TOOL_CATALOG_TOOL_IDS - Sorted tool ids covered by the catalog.
//   catalogToolIds - Sorted tool ids covered by the catalog.
//   measureCatalogContractSize - Current description/input-schema UTF-8 byte measurement.
//   validateAgentToolCatalog - Run every catalog fixture through the actual validators/result schemas.
//   ResultBranchAncestor - Nested object-path requirement a result fixture must satisfy.
//   ResultBranchLocation - One union branch location with its fixture value path.
//   collectResultBranches - Enumerate nested discriminated-union branches in a result schema.
//   resultBranchGaps - Result-schema branches a single entry's fixtures do not cover.
//   resultCoverageGaps - Result-schema union branches not covered by any catalog fixture.
//   findOpaqueInputObjects - Arbitrary (non-closed) object/unconstrained nodes in a published input schema.
//   renderToolContractsReference - Deterministic Markdown reference generated from the catalog.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-008 correction r2 - Array-element traversal with finite-primitive (boolean/number) literal discriminators so batch item and nested provider families are coverage-checked; added the batch-failure fixture and the per-operation/branch negative fixtures for review_only, generic open paths, request_changes/rework, verify/review/bind/amend/record_approval/revoke_authority, delete/rename/replace/prepend, and every freshness/format branch. Prior: honest hashline text+metadata aggregate, nested provider coverage, closed-schema scanning, outcome-validated reference examples.]
// END_CHANGE_SUMMARY

import { tool } from "@opencode-ai/plugin";
import type { ZodRawShape, ZodType } from "zod";
import {
  AGENT_TOOL_CONTRACT_REVISION,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  type ContractIssue,
  type OwnedToolContract,
} from "./agent-tool-contract.js";
import {
  validateWorkflowToolInput,
  workflowToolContracts,
} from "../plugins/workflow/input-validation.js";
import { workflowToolResultSchemas } from "../plugins/workflow/results.js";
import {
  HASHLINE_EDIT_TOOL_ID,
  STR_REPLACE_EDITOR_TOOL_ID,
  hashlineEditContract,
  hashlineEditMetadataSchema,
  strReplaceEditorContract,
  strReplaceEditorResultSchema,
  validateHashlineEditToolInput,
  validateStrReplaceEditorToolInput,
} from "../plugins/hashline-edit/schemas.js";
import {
  WEB_FETCH_DEFAULT_TIMEOUT_SECONDS,
  WEB_SEARCH_DEFAULT_COUNT,
  WEB_FETCH_TOOL_ID,
  WEB_SEARCH_TOOL_ID,
  validateWebFetchToolInput,
  validateWebSearchToolInput,
  webFetchContract,
  webFetchResultSchema,
  webSearchContract,
  webSearchResultSchema,
} from "../plugins/web-tools/schemas.js";

// START_BLOCK_TYPES
/** One checked positive/negative input fixture with independent coverage metadata. */
export interface CatalogOperation {
  readonly id: string;
  readonly label: string;
  readonly expect: "accept" | "reject";
  readonly input: Record<string, unknown>;
  /** Vocabulary field path to value this operation positively covers. */
  readonly covers?: Readonly<Record<string, string>>;
  /** Independent negative-scenario tags (e.g. unknown_key, missing_required). */
  readonly tags?: readonly string[];
  /** State/host prerequisites the fixture does not itself establish. */
  readonly prerequisites?: readonly string[];
}

/** A model-facing closed vocabulary for one discriminated input field. */
export interface CatalogVocabulary {
  readonly field: string;
  readonly values: readonly string[];
}

/** An execute-time default applied by a tool schema. */
export interface CatalogDefault {
  readonly field: string;
  readonly value: unknown;
  readonly note: string;
}

/** Declared meaning and rules for one path argument. */
export interface CatalogPathKind {
  readonly field: string;
  readonly kind: "exact-file" | "directory-subtree" | "absolute-file" | "url";
  readonly rules: string;
}

/** One checked result-family fixture for a tool. */
export interface CatalogResultVariant {
  readonly id: string;
  readonly label: string;
  readonly fixture: unknown;
}

/** Representative failure diagnostic path/expectation. */
export interface CatalogErrorExample {
  readonly path: string;
  readonly expectation: string;
}

/** Structural validation outcome exposed for fixture checks. */
export interface CatalogValidationResult {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly issues?: readonly ContractIssue[];
}

/** Aggregated catalog entry for one owned tool. */
export interface AgentToolCatalogEntry {
  readonly toolId: string;
  readonly summary: string;
  readonly contract: OwnedToolContract<ZodRawShape>;
  readonly validate: (raw: unknown) => CatalogValidationResult;
  readonly resultSchema: ZodType;
  readonly vocabularies: readonly CatalogVocabulary[];
  readonly operations: readonly CatalogOperation[];
  readonly defaults: readonly CatalogDefault[];
  readonly prerequisites: readonly string[];
  readonly conditionals: readonly string[];
  readonly pathKinds: readonly CatalogPathKind[];
  readonly results: readonly CatalogResultVariant[];
  readonly errors: readonly CatalogErrorExample[];
  readonly normalization: readonly string[];
}
// END_BLOCK_TYPES

// START_BLOCK_SHARED_FIXTURES
/** Read-only execution view fixture shared by generic result families. */
function executionView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: "run-1",
    sessionId: "session-1",
    executionKey: "exec-1",
    sourceKind: "conversation-scoped",
    goal: "Deliver the scoped work.",
    state: "active",
    revision: 1,
    tasks: [],
    checkpoints: [],
    ...overrides,
  };
}

/** A minimal valid closed work-item input entry. */
function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "task-key",
    title: "Task title",
    mode: "implementation",
    requiredReviewers: ["spec"],
    ...overrides,
  };
}

function wrap(validation: {
  ok: boolean;
  data?: unknown;
  issues?: readonly ContractIssue[];
}): CatalogValidationResult {
  return validation.ok
    ? { ok: true, data: validation.data }
    : { ok: false, issues: validation.issues };
}
// END_BLOCK_SHARED_FIXTURES

// START_BLOCK_WORKFLOW_ENTRIES
const workflowEntries: AgentToolCatalogEntry[] = [
  {
    toolId: "work_item_open",
    summary:
      "Open one or more work items idempotently, or register/append generic execution tasks.",
    contract: workflowToolContracts[0]!,
    validate: (raw) => wrap(validateWorkflowToolInput("work_item_open", raw)),
    resultSchema: workflowToolResultSchemas.work_item_open,
    vocabularies: [
      { field: "items[].mode", values: ["implementation", "review_only", "delegated"] },
      { field: "execution.source.kind", values: ["conversation-scoped", "provided-plan"] },
    ],
    operations: [
      {
        id: "work_item_open:standalone-implementation",
        label: "standalone implementation with reviewers",
        expect: "accept",
        input: { items: [item()] },
        covers: { "items[].mode": "implementation" },
      },
      {
        id: "work_item_open:standalone-review-only",
        label: "standalone review_only with reviewers",
        expect: "accept",
        input: { items: [item({ mode: "review_only" })] },
        covers: { "items[].mode": "review_only" },
      },
      {
        id: "work_item_open:standalone-delegated",
        label: "standalone delegated with empty reviewers and a write scope",
        expect: "accept",
        input: {
          items: [
            item({
              mode: "delegated",
              requiredReviewers: [],
              writeScope: ["src/lib/a.ts"],
            }),
          ],
        },
        covers: { "items[].mode": "delegated" },
      },
      {
        id: "work_item_open:generic-register-conversation",
        label: "generic register from a conversation-scoped source",
        expect: "accept",
        input: {
          items: [
            item({
              mode: "delegated",
              requiredReviewers: [],
              writeScope: ["src/lib/a.ts"],
              taskId: "T-100",
            }),
          ],
          execution: {
            executionKey: "exec-1",
            source: { kind: "conversation-scoped" },
            goal: "Deliver the scoped work.",
            boundary: { files: ["src/lib/a.ts"], directories: ["src/lib/"] },
          },
        },
        covers: { "execution.source.kind": "conversation-scoped" },
        prerequisites: ["trusted workspace root from the plugin context"],
      },
      {
        id: "work_item_open:generic-register-provided-plan",
        label: "generic register from a provided plan reference",
        expect: "accept",
        input: {
          items: [
            item({
              mode: "delegated",
              requiredReviewers: [],
              writeScope: ["src/lib/a.ts"],
              taskId: "T-101",
            }),
          ],
          execution: {
            executionKey: "exec-2",
            source: { kind: "provided-plan", reference: "docs/plan.xml", sha256: "abc123" },
            goal: "Deliver the provided plan.",
            boundary: { files: ["src/lib/a.ts"], directories: [] },
          },
        },
        covers: { "execution.source.kind": "provided-plan" },
        prerequisites: ["trusted workspace root from the plugin context"],
      },
      {
        id: "work_item_open:generic-append",
        label: "append to an existing generic execution",
        expect: "accept",
        input: {
          items: [
            item({
              mode: "delegated",
              requiredReviewers: [],
              writeScope: ["src/lib/a.ts"],
              taskId: "T-102",
            }),
          ],
          runId: "run-existing",
          amendmentId: "amend-1",
          rationale: "Append the follow-up.",
        },
        prerequisites: ["existing generic execution runId"],
      },
      {
        id: "work_item_open:reject-unknown-key",
        label: "unknown nested item key is rejected",
        expect: "reject",
        input: { items: [item({ typo: true })] },
        tags: ["unknown_key"],
      },
      {
        id: "work_item_open:reject-unsupported-mode",
        label: "an unsupported item mode is rejected",
        expect: "reject",
        input: { items: [item({ mode: "review" })] },
        tags: ["invalid_value"],
      },
      {
        id: "work_item_open:reject-empty-items",
        label: "empty batch is rejected",
        expect: "reject",
        input: { items: [] },
        tags: ["missing_required"],
      },
      {
        id: "work_item_open:reject-empty-reviewers",
        label: "standalone implementation with empty reviewers is rejected",
        expect: "reject",
        input: { items: [item({ requiredReviewers: [] })] },
        tags: ["missing_required"],
      },
      {
        id: "work_item_open:reject-execution-and-runid",
        label: "execution and runId are mutually exclusive",
        expect: "reject",
        input: {
          items: [item({ mode: "delegated", requiredReviewers: [], writeScope: ["src/lib/a.ts"] })],
          runId: "run-1",
          execution: {
            executionKey: "exec-1",
            source: { kind: "conversation-scoped" },
            goal: "Deliver.",
            boundary: { files: ["src/lib/a.ts"], directories: [] },
          },
        },
        tags: ["conflict"],
      },
      {
        id: "work_item_open:reject-unsupported-source-kind",
        label: "native-package source kind is not accepted by the generic descriptor",
        expect: "reject",
        input: {
          items: [item({ mode: "delegated", requiredReviewers: [], writeScope: ["src/lib/a.ts"] })],
          execution: {
            executionKey: "exec-1",
            source: { kind: "native-package" },
            goal: "Deliver.",
            boundary: { files: ["src/lib/a.ts"], directories: [] },
          },
        },
        tags: ["invalid_value"],
      },
      {
        id: "work_item_open:reject-provided-plan-missing-reference",
        label: "provided plan without a reference is rejected",
        expect: "reject",
        input: {
          items: [item({ mode: "delegated", requiredReviewers: [], writeScope: ["src/lib/a.ts"] })],
          execution: {
            executionKey: "exec-1",
            source: { kind: "provided-plan" },
            goal: "Deliver.",
            boundary: { files: ["src/lib/a.ts"], directories: [] },
          },
        },
        tags: ["missing_required"],
      },
      {
        id: "work_item_open:reject-delegated-reviewers",
        label: "standalone delegated with reviewers is rejected",
        expect: "reject",
        input: {
          items: [
            item({ mode: "delegated", requiredReviewers: ["spec"], writeScope: ["src/lib/a.ts"] }),
          ],
        },
        tags: ["conflict"],
      },
      {
        id: "work_item_open:reject-review-only-empty-reviewers",
        label: "standalone review_only with empty reviewers is rejected",
        expect: "reject",
        input: { items: [item({ mode: "review_only", requiredReviewers: [] })] },
        tags: ["missing_required"],
      },
      {
        id: "work_item_open:reject-generic-register-missing-goal",
        label: "generic register from a conversation source without a goal is rejected",
        expect: "reject",
        input: {
          items: [item({ mode: "delegated", requiredReviewers: [], writeScope: ["src/lib/a.ts"] })],
          execution: {
            executionKey: "exec-1",
            source: { kind: "conversation-scoped" },
            goal: "   ",
            boundary: { files: ["src/lib/a.ts"], directories: [] },
          },
        },
        tags: ["missing_required"],
      },
      {
        id: "work_item_open:reject-generic-append-missing-amendment",
        label: "generic append without amendment context is rejected",
        expect: "reject",
        input: {
          items: [item({ mode: "delegated", requiredReviewers: [], writeScope: ["src/lib/a.ts"] })],
          runId: "run-existing",
        },
        tags: ["missing_required"],
      },
    ],
    defaults: [],
    prerequisites: [
      "trusted workspace root from the plugin context for every generic registration",
      "existing generic runId for appends",
    ],
    conditionals: [
      "execution and runId are mutually exclusive",
      "amendmentId and rationale are only valid with a runId append",
      "generic items require mode delegated and a non-empty write scope of exact files",
      "standalone implementation/review_only require a unique non-empty reviewer set and forbid writeScope",
    ],
    pathKinds: [
      {
        field: "items[].writeScope[]",
        kind: "exact-file",
        rules:
          "workspace-relative exact file paths; wildcards, traversal, absolute/home/drive paths, backslashes, and trailing separators are rejected",
      },
      {
        field: "execution.boundary.files[]",
        kind: "exact-file",
        rules: "workspace-relative exact file paths inside the execution boundary",
      },
      {
        field: "execution.boundary.directories[]",
        kind: "directory-subtree",
        rules: "workspace-relative directory subtrees; one trailing separator is normalized away",
      },
    ],
    results: [
      {
        id: "work_item_open:batch",
        label: "standalone batch envelope (per-item ok/failure, no top-level ok)",
        fixture: {
          tool: "work_item_open",
          sessionId: "session-1",
          items: [
            {
              ok: true,
              reused: false,
              workItemId: "wi-1",
              header: "VVOC_WORK_ITEM_ID: wi-1",
              key: "task-key",
              title: "Task title",
              mode: "implementation",
              requiredReviewers: ["spec"],
              state: "open",
              specReviewCount: 0,
              codeReviewCount: 0,
              reviewRound: 0,
              completedReviewRoundCount: 0,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
      },
      {
        id: "work_item_open:batch-failure",
        label: "standalone batch envelope with a per-item failure",
        fixture: {
          tool: "work_item_open",
          sessionId: "session-1",
          items: [
            {
              ok: false,
              errorCode: "ALREADY_OPEN",
              category: "state",
              message: "ALREADY_OPEN: work item is already open",
              existingWorkItemId: "wi-1",
              state: "open",
              prerequisite: "no open item with the same key",
              nextAction: "reuse the existing work item",
            },
          ],
        },
      },
      {
        id: "work_item_open:register",
        label: "generic execution registration",
        fixture: {
          tool: "work_item_open",
          sessionId: "session-1",
          ok: true,
          action: "register",
          runId: "run-1",
          reused: false,
          execution: executionView(),
        },
      },
      {
        id: "work_item_open:amend",
        label: "generic execution amendment",
        fixture: {
          tool: "work_item_open",
          sessionId: "session-1",
          ok: true,
          action: "amend",
          runId: "run-1",
          revision: 2,
          execution: executionView(),
        },
      },
      {
        id: "work_item_open:failure",
        label: "bounded owned failure",
        fixture: {
          tool: "work_item_open",
          sessionId: "session-1",
          ok: false,
          errorCode: "INVALID_INPUT",
          category: "input",
          message: "INVALID_INPUT: items[0].typo: unrecognized key",
        },
      },
    ],
    errors: [
      { path: "items[0].typo", expectation: "unknown nested item key is rejected with its path" },
      {
        path: "execution.source.reference",
        expectation: "provided plan without a reference names the source field",
      },
    ],
    normalization: [
      "documented trims are applied before bounds; unknown keys are never stripped",
      "reviewer and stage enums are canonical; unsupported values reject rather than filter",
    ],
  },
  {
    toolId: "work_item_list",
    summary:
      "List current-session work items, native plan runs, and generic executions with contract identity.",
    contract: workflowToolContracts[1]!,
    validate: (raw) => wrap(validateWorkflowToolInput("work_item_list", raw)),
    resultSchema: workflowToolResultSchemas.work_item_list,
    vocabularies: [],
    operations: [
      {
        id: "work_item_list:default",
        label: "list without includeClosed",
        expect: "accept",
        input: {},
      },
      {
        id: "work_item_list:include-closed",
        label: "list including closed items",
        expect: "accept",
        input: { includeClosed: true },
      },
      {
        id: "work_item_list:reject-unknown-key",
        label: "unknown key is rejected",
        expect: "reject",
        input: { includeClosed: false, extra: true },
        tags: ["unknown_key"],
      },
      {
        id: "work_item_list:reject-wrong-type",
        label: "non-boolean includeClosed is rejected",
        expect: "reject",
        input: { includeClosed: "true" },
        tags: ["invalid_value"],
      },
      {
        id: "work_item_list:reject-unknown-key-default",
        label: "unknown key without includeClosed is rejected",
        expect: "reject",
        input: { extra: true },
        tags: ["unknown_key"],
      },
      {
        id: "work_item_list:reject-unknown-key-include-closed",
        label: "unknown key with includeClosed true is rejected",
        expect: "reject",
        input: { includeClosed: true, extra: true },
        tags: ["unknown_key"],
      },
    ],
    defaults: [],
    prerequisites: ["same-session store hydration from the plugin context"],
    conditionals: ["includeClosed defaults to false and is optional"],
    pathKinds: [],
    results: [
      {
        id: "work_item_list:view",
        label: "inspection view with loaded contract identity",
        fixture: {
          tool: "work_item_list",
          sessionId: "session-1",
          includeClosed: false,
          items: [],
          contract: {
            packageName: PACKAGE_NAME,
            packageVersion: PACKAGE_VERSION,
            toolContractRevision: AGENT_TOOL_CONTRACT_REVISION,
            referencePath: "templates/skills/vv-execute/references/tool-contracts.md",
          },
        },
      },
      {
        id: "work_item_list:failure",
        label: "bounded owned failure",
        fixture: {
          tool: "work_item_list",
          sessionId: "session-1",
          ok: false,
          errorCode: "PERSISTENCE_FAILED",
          category: "persistence",
          message: "PERSISTENCE_FAILED: state could not be read",
        },
      },
    ],
    errors: [
      { path: "includeClosed", expectation: "a non-boolean value is rejected rather than coerced" },
    ],
    normalization: ["includeClosed is read strictly; foreign-session data is never exposed"],
  },
  {
    toolId: "work_item_close",
    summary:
      "Close a same-session work item once its reviews are complete and no concerns remain open.",
    contract: workflowToolContracts[2]!,
    validate: (raw) => wrap(validateWorkflowToolInput("work_item_close", raw)),
    resultSchema: workflowToolResultSchemas.work_item_close,
    vocabularies: [],
    operations: [
      {
        id: "work_item_close:close",
        label: "close a ready work item",
        expect: "accept",
        input: { workItemId: "wi-1" },
        prerequisites: ["work item is ready_to_close"],
      },
      {
        id: "work_item_close:reject-unknown-key",
        label: "unknown key is rejected",
        expect: "reject",
        input: { workItemId: "wi-1", extra: true },
        tags: ["unknown_key"],
      },
      {
        id: "work_item_close:reject-blank-id",
        label: "blank work item id is rejected",
        expect: "reject",
        input: { workItemId: "   " },
        tags: ["missing_required"],
      },
    ],
    defaults: [],
    prerequisites: ["same-session work item in ready_to_close state"],
    conditionals: ["open concerns or pending reviews refuse the close with the unmet prerequisite"],
    pathKinds: [],
    results: [
      {
        id: "work_item_close:success",
        label: "closed work item",
        fixture: {
          tool: "work_item_close",
          sessionId: "session-1",
          ok: true,
          workItemId: "wi-1",
          header: "VVOC_WORK_ITEM_ID: wi-1",
          state: "closed",
          closedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      {
        id: "work_item_close:failure",
        label: "bounded owned failure",
        fixture: {
          tool: "work_item_close",
          sessionId: "session-1",
          ok: false,
          errorCode: "READY_TO_CLOSE_REQUIRED",
          category: "state",
          message: "READY_TO_CLOSE_REQUIRED: pending reviews remain",
          state: "awaiting_reviews",
        },
      },
    ],
    errors: [
      { path: "workItemId", expectation: "blank ids are rejected before any state mutation" },
    ],
    normalization: ["the id is trimmed; unknown fields never reach the store"],
  },
  {
    toolId: "work_item_decide",
    summary:
      "Accept, request changes, authorize bounded rework, or recover a stopped delegated attempt.",
    contract: workflowToolContracts[3]!,
    validate: (raw) => wrap(validateWorkflowToolInput("work_item_decide", raw)),
    resultSchema: workflowToolResultSchemas.work_item_decide,
    vocabularies: [
      { field: "decision", values: ["accept", "request_changes", "rework", "recover"] },
    ],
    operations: [
      {
        id: "work_item_decide:accept",
        label: "accept a completed attempt with evidence",
        expect: "accept",
        input: {
          workItemId: "wi-1",
          attempt: 1,
          decision: "accept",
          rationale: "Verified against the acceptance criteria.",
          evidence: ["bun test"],
        },
        covers: { decision: "accept" },
        prerequisites: ["latest attempt is terminal and acceptance is applicable"],
      },
      {
        id: "work_item_decide:request-changes",
        label: "request changes with a concerns disposition",
        expect: "accept",
        input: {
          workItemId: "wi-1",
          attempt: 1,
          decision: "request_changes",
          rationale: "Fix the edge case.",
          evidence: ["review note"],
          concernsDisposition: "Resolved after rework.",
        },
        covers: { decision: "request_changes" },
      },
      {
        id: "work_item_decide:rework",
        label: "authorize rework from a failed checkpoint",
        expect: "accept",
        input: {
          workItemId: "wi-1",
          attempt: 1,
          decision: "rework",
          runId: "run-1",
          checkpointId: "C-1",
          rationale: "Checkpoint failed.",
        },
        covers: { decision: "rework" },
        prerequisites: ["a failed checkpoint bound to an accepted task"],
      },
      {
        id: "work_item_decide:recover",
        label: "recover a stopped unaccepted task",
        expect: "accept",
        input: {
          workItemId: "wi-1",
          attempt: 2,
          decision: "recover",
          recoveryId: "rec-1",
          diagnosis: "Both attempts stopped.",
          changedCondition: "Packet clarified.",
          verification: ["bun test"],
        },
        covers: { decision: "recover" },
        prerequisites: ["stable identity, bounded diagnosis, and state-specific authorization"],
      },
      {
        id: "work_item_decide:recover-authority",
        label: "recover funded by a recorded advance authority",
        expect: "accept",
        input: {
          workItemId: "wi-1",
          attempt: 2,
          decision: "recover",
          recoveryId: "rec-2",
          diagnosis: "Reserve advance.",
          changedCondition: "Authority recorded.",
          verification: ["bun test"],
          authorityId: "auth-1",
          runId: "run-1",
        },
        prerequisites: ["recorded advance authority on the owning run"],
      },
      {
        id: "work_item_decide:reject-unknown-key",
        label: "unknown key is rejected",
        expect: "reject",
        input: {
          workItemId: "wi-1",
          attempt: 1,
          decision: "accept",
          rationale: "ok",
          evidence: ["x"],
          typo: true,
        },
        tags: ["unknown_key"],
      },
      {
        id: "work_item_decide:reject-unsupported-decision",
        label: "an unsupported decision family is rejected",
        expect: "reject",
        input: { workItemId: "wi-1", attempt: 1, decision: "approve" },
        tags: ["invalid_value"],
      },
      {
        id: "work_item_decide:reject-missing-evidence",
        label: "accept without evidence is rejected",
        expect: "reject",
        input: { workItemId: "wi-1", attempt: 1, decision: "accept", rationale: "ok" },
        tags: ["missing_required"],
      },
      {
        id: "work_item_decide:reject-request-changes-missing-evidence",
        label: "request_changes without evidence is rejected",
        expect: "reject",
        input: { workItemId: "wi-1", attempt: 1, decision: "request_changes" },
        tags: ["missing_required"],
      },
      {
        id: "work_item_decide:reject-rework-missing-checkpoint",
        label: "rework without its failed-checkpoint binding is rejected",
        expect: "reject",
        input: { workItemId: "wi-1", attempt: 1, decision: "rework" },
        tags: ["missing_required"],
      },
      {
        id: "work_item_decide:reject-unconsumed-field",
        label: "a field for another decision is rejected, not ignored",
        expect: "reject",
        input: {
          workItemId: "wi-1",
          attempt: 1,
          decision: "accept",
          rationale: "ok",
          evidence: ["x"],
          recoveryId: "rec-1",
        },
        tags: ["conflict"],
      },
      {
        id: "work_item_decide:reject-runid-without-authority",
        label: "recover runId without authorityId is rejected",
        expect: "reject",
        input: {
          workItemId: "wi-1",
          attempt: 2,
          decision: "recover",
          runId: "run-1",
          recoveryId: "rec-1",
          diagnosis: "d",
          changedCondition: "c",
          verification: ["v"],
        },
        tags: ["conflict"],
      },
    ],
    defaults: [],
    prerequisites: [
      "latest completed attempt identity and terminal status",
      "recorded concerns disposition when the terminal record requires one",
    ],
    conditionals: [
      "accept/request_changes require balanced rationale and evidence",
      "rework requires its failed checkpoint binding",
      "recover requires recoveryId, diagnosis, changedCondition, and verification; runId only accompanies authorityId",
      "concernsDisposition is conditional on the recorded terminal status, not a caller-supplied status",
    ],
    pathKinds: [],
    results: [
      {
        id: "work_item_decide:accept-or-request-changes",
        label: "decision outcome (accept/request_changes)",
        fixture: {
          tool: "work_item_decide",
          sessionId: "session-1",
          ok: true,
          action: "accept",
          workItemId: "wi-1",
          attempt: 1,
          decisionId: "decision-1",
          state: "ready_to_close",
        },
      },
      {
        id: "work_item_decide:rework",
        label: "rework authorization outcome",
        fixture: {
          tool: "work_item_decide",
          sessionId: "session-1",
          ok: true,
          action: "rework",
          workItemId: "wi-1",
          reworkId: "rework-1",
          grantedAttempts: 1,
          state: "awaiting_implementer",
        },
      },
      {
        id: "work_item_decide:recover",
        label: "recovery outcome",
        fixture: {
          tool: "work_item_decide",
          sessionId: "session-1",
          ok: true,
          action: "recover",
          workItemId: "wi-1",
          recoveryId: "rec-1",
          kind: "resume",
          attemptBudget: 3,
          remainingAttempts: 2,
          state: "awaiting_implementer",
          nextAction: "launch_implementer",
        },
      },
      {
        id: "work_item_decide:failure",
        label: "bounded owned failure",
        fixture: {
          tool: "work_item_decide",
          sessionId: "session-1",
          ok: false,
          errorCode: "INVALID_ATTEMPT",
          category: "state",
          message: "INVALID_ATTEMPT: no completed attempt matches",
          attempt: 2,
          nextAction: "call work_item_list to read the latest attempt",
        },
      },
    ],
    errors: [
      { path: "evidence", expectation: "missing required evidence names the field" },
      {
        path: "runId",
        expectation: "runId without authorityId is a conflict, not silently dropped",
      },
    ],
    normalization: ["decision-scoped fields are rejected when another decision is selected"],
  },
  {
    toolId: "work_checkpoint",
    summary:
      "Register, start, verify, review, bind, amend, complete, or authorize/recover checkpoints and authority.",
    contract: workflowToolContracts[4]!,
    validate: (raw) => wrap(validateWorkflowToolInput("work_checkpoint", raw)),
    resultSchema: workflowToolResultSchemas.work_checkpoint,
    vocabularies: [
      {
        field: "action",
        values: [
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
        ],
      },
    ],
    operations: [
      {
        id: "work_checkpoint:register-native",
        label: "register an approved native plan package",
        expect: "accept",
        input: { action: "register", planPath: ".vvoc/specs/x/plan.xml" },
        covers: { action: "register" },
        prerequisites: ["approved native plan loader and trusted workspace root"],
      },
      {
        id: "work_checkpoint:register-generic",
        label: "generic register appends a task batch to an existing run",
        expect: "accept",
        input: {
          action: "register",
          runId: "run-1",
          amendmentId: "amend-1",
          rationale: "Append a task batch to the existing run.",
          tasks: [item({ mode: "delegated", requiredReviewers: [], writeScope: ["src/lib/a.ts"] })],
        },
        covers: { action: "register" },
        prerequisites: ["existing generic execution runId"],
      },
      {
        id: "work_checkpoint:start",
        label: "start a declared checkpoint generation",
        expect: "accept",
        input: { action: "start", runId: "run-1", checkpointId: "C-1" },
        covers: { action: "start" },
        prerequisites: ["covered tasks accepted and dependencies satisfied"],
      },
      {
        id: "work_checkpoint:verify",
        label: "verify a checkpoint and optionally seal",
        expect: "accept",
        input: { action: "verify", runId: "run-1", checkpointId: "C-1", complete: true },
        covers: { action: "verify" },
        prerequisites: ["linked reviewer records satisfy the checkpoint"],
      },
      {
        id: "work_checkpoint:recover",
        label: "recover a stopped or exhausted checkpoint",
        expect: "accept",
        input: {
          action: "recover",
          runId: "run-1",
          checkpointId: "C-1",
          recoveryId: "rec-1",
          diagnosis: "Generation stopped.",
          changedCondition: "Fresh reviewer assigned.",
          verification: ["bun test"],
        },
        covers: { action: "recover" },
      },
      {
        id: "work_checkpoint:review",
        label: "record a linked reviewer result",
        expect: "accept",
        input: { action: "review", runId: "run-1", checkpointId: "C-1", reviewer: "code" },
        covers: { action: "review" },
      },
      {
        id: "work_checkpoint:bind",
        label:
          "record the linked reviewer outcome for the generation (launch binding is a host hook)",
        expect: "accept",
        input: { action: "bind", runId: "run-1", checkpointId: "C-1" },
        covers: { action: "bind" },
      },
      {
        id: "work_checkpoint:complete",
        label: "seal an eligible completed execution",
        expect: "accept",
        input: { action: "complete", runId: "run-1", rationale: "All tasks accepted." },
        covers: { action: "complete" },
      },
      {
        id: "work_checkpoint:amend",
        label: "amend an execution with a new task batch",
        expect: "accept",
        input: {
          action: "amend",
          runId: "run-1",
          amendmentId: "amend-1",
          rationale: "Add coverage.",
        },
        covers: { action: "amend" },
      },
      {
        id: "work_checkpoint:authorize",
        label: "authorize delegatable stages and reserved stops",
        expect: "accept",
        input: {
          action: "authorize",
          runId: "run-1",
          authorityId: "auth-1",
          messageId: "msg-1",
          stages: ["implementation"],
          reservedStops: ["specification"],
        },
        covers: { action: "authorize" },
        prerequisites: ["eligible root-user authorization message"],
      },
      {
        id: "work_checkpoint:record-approval",
        label: "record a stage approval",
        expect: "accept",
        input: {
          action: "record_approval",
          runId: "run-1",
          authorityId: "auth-1",
          approvalId: "appr-1",
          stage: "implementation",
          artifactPath: "src/lib/a.ts",
          artifactSha256: "abc123",
        },
        covers: { action: "record_approval" },
      },
      {
        id: "work_checkpoint:revoke-authority",
        label: "revoke authority (narrow or full)",
        expect: "accept",
        input: {
          action: "revoke_authority",
          runId: "run-1",
          authorityId: "auth-1",
          revocationId: "revoke-1",
        },
        covers: { action: "revoke_authority" },
      },
      {
        id: "work_checkpoint:revoke-narrow",
        label: "narrow revocation keeps surviving stages",
        expect: "accept",
        input: {
          action: "revoke_authority",
          runId: "run-1",
          authorityId: "auth-1",
          revocationId: "revoke-2",
          stages: ["verification"],
          rationale: "Keep the final stage.",
        },
      },
      {
        id: "work_checkpoint:reject-unknown-key",
        label: "unknown key is rejected",
        expect: "reject",
        input: { action: "start", runId: "run-1", checkpointId: "C-1", nestedUnknown: { deep: 1 } },
        tags: ["unknown_key"],
      },
      {
        id: "work_checkpoint:reject-unsupported-action",
        label: "an unsupported checkpoint/authority action is rejected",
        expect: "reject",
        input: { action: "unknown_action" },
        tags: ["invalid_value"],
      },
      {
        id: "work_checkpoint:reject-start-missing-runid",
        label: "start without runId is rejected",
        expect: "reject",
        input: { action: "start", checkpointId: "C-1" },
        tags: ["missing_required"],
      },
      {
        id: "work_checkpoint:reject-register-both-routes",
        label: "register with planPath and runId is rejected",
        expect: "reject",
        input: { action: "register", planPath: ".vvoc/specs/x/plan.xml", runId: "run-1" },
        tags: ["conflict"],
      },
      {
        id: "work_checkpoint:reject-reserved-stop-typo",
        label: "a misspelled reserved stop rejects the whole authority operation",
        expect: "reject",
        input: {
          action: "authorize",
          runId: "run-1",
          authorityId: "auth-1",
          messageId: "msg-1",
          stages: ["implementation"],
          reservedStops: ["verificaton"],
        },
        tags: ["invalid_value"],
      },
      {
        id: "work_checkpoint:reject-unconsumed-action-field",
        label: "a field for another action is rejected",
        expect: "reject",
        input: { action: "complete", runId: "run-1", planPath: ".vvoc/specs/x/plan.xml" },
        tags: ["conflict"],
      },
      {
        id: "work_checkpoint:reject-recover-incomplete",
        label: "recover without its bounded fields is rejected",
        expect: "reject",
        input: { action: "recover", runId: "run-1", checkpointId: "C-1", recoveryId: "rec-1" },
        tags: ["missing_required"],
      },
      {
        id: "work_checkpoint:reject-verify-missing-checkpoint",
        label: "verify without a checkpoint id is rejected",
        expect: "reject",
        input: { action: "verify", runId: "run-1" },
        tags: ["missing_required"],
      },
      {
        id: "work_checkpoint:reject-review-missing-checkpoint",
        label: "review without a checkpoint id is rejected",
        expect: "reject",
        input: { action: "review", runId: "run-1" },
        tags: ["missing_required"],
      },
      {
        id: "work_checkpoint:reject-bind-missing-checkpoint",
        label: "bind without a checkpoint id is rejected",
        expect: "reject",
        input: { action: "bind", runId: "run-1" },
        tags: ["missing_required"],
      },
      {
        id: "work_checkpoint:reject-amend-missing-amendment",
        label: "amend without amendment context is rejected",
        expect: "reject",
        input: { action: "amend", runId: "run-1" },
        tags: ["missing_required"],
      },
      {
        id: "work_checkpoint:reject-record-approval-missing-approval",
        label: "record_approval without approval identity is rejected",
        expect: "reject",
        input: { action: "record_approval", runId: "run-1" },
        tags: ["missing_required"],
      },
      {
        id: "work_checkpoint:reject-revoke-authority-missing-revocation",
        label: "revoke_authority without revocation identity is rejected",
        expect: "reject",
        input: { action: "revoke_authority", runId: "run-1" },
        tags: ["missing_required"],
      },
    ],
    defaults: [],
    prerequisites: [
      "source (native planPath or generic runId) resolved before source-dependent validation",
      "eligible root-user authorization message for authorize",
    ],
    conditionals: [
      "native register uses planPath and rejects runId; generic register appends a task batch to an existing runId with amendmentId and rationale",
      "generic review, bind, and verify consume the linked reviewer items' recorded outcomes; the reviewer callID launch binding happens in the host hook, not through this action",
      "native verify with complete:true seals only an eligible final checkpoint; generic executions seal through the complete action",
      "work_checkpoint recover consumes userMessageId only for native-package checkpoints: a generic checkpoint recover rejects userMessageId (a stopped generation resumes cost-free, an exhausted one needs a recorded advance authorityId with its runId). work_item_decide recover accepts userMessageId for standalone, native, and generic execution tasks",
      "authorize/record_approval/revoke_authority validate every supplied stage/stop before any ledger write",
    ],
    pathKinds: [
      {
        field: "planPath",
        kind: "exact-file",
        rules: "workspace-relative approved native plan path; native register only",
      },
      {
        field: "fileBoundary[]",
        kind: "exact-file",
        rules: "workspace-relative exact files recorded with an authority grant",
      },
      {
        field: "artifactPath",
        kind: "exact-file",
        rules: "approved artifact path recorded with a stage approval",
      },
    ],
    results: [
      {
        id: "work_checkpoint:register",
        label: "registration/amendment summary",
        fixture: {
          tool: "work_checkpoint",
          sessionId: "session-1",
          ok: true,
          action: "register",
          runId: "run-1",
          reused: false,
          tasks: 1,
          checkpoints: 0,
        },
      },
      {
        id: "work_checkpoint:amend",
        label: "generic amendment view",
        fixture: {
          tool: "work_checkpoint",
          sessionId: "session-1",
          runId: "run-1",
          ok: true,
          action: "amend",
          revision: 2,
          execution: executionView(),
        },
      },
      {
        id: "work_checkpoint:start",
        label: "started generation with reviewers to launch",
        fixture: {
          tool: "work_checkpoint",
          sessionId: "session-1",
          ok: true,
          action: "start",
          runId: "run-1",
          checkpointId: "C-1",
          reviewWorkItemId: "wi-2",
          header: "VVOC_WORK_ITEM_ID: wi-2",
          reviewersToLaunch: ["code"],
        },
      },
      {
        id: "work_checkpoint:verify-native",
        label: "native verify outcome",
        fixture: {
          tool: "work_checkpoint",
          sessionId: "session-1",
          ok: true,
          action: "verify",
          runId: "run-1",
          checkpointId: "C-1",
          outcome: "passed",
          snapshotCurrent: true,
          sealedRun: true,
        },
      },
      {
        id: "work_checkpoint:review-bind-verify",
        label: "generic review/bind/verify outcome",
        fixture: {
          tool: "work_checkpoint",
          sessionId: "session-1",
          ok: true,
          action: "bind",
          runId: "run-1",
          checkpointId: "C-1",
          reviewer: "code",
          outcome: "in_progress",
          checkpointStatus: "in_review",
        },
      },
      {
        id: "work_checkpoint:recover",
        label: "checkpoint recovery outcome",
        fixture: {
          tool: "work_checkpoint",
          sessionId: "session-1",
          ok: true,
          action: "recover",
          runId: "run-1",
          checkpointId: "C-1",
          recoveryId: "rec-1",
          kind: "resume",
          checkpointStatus: "pending",
        },
      },
      {
        id: "work_checkpoint:complete",
        label: "sealed execution",
        fixture: {
          tool: "work_checkpoint",
          sessionId: "session-1",
          runId: "run-1",
          ok: true,
          action: "complete",
          reviewStatus: "independently_reviewed",
          execution: executionView({ state: "sealed" }),
        },
      },
      {
        id: "work_checkpoint:authorize",
        label: "authority grant/extension",
        fixture: {
          tool: "work_checkpoint",
          sessionId: "session-1",
          runId: "run-1",
          ok: true,
          action: "authorize",
          authorityId: "auth-1",
          reused: false,
          units: 3,
          availableUnits: 3,
        },
      },
      {
        id: "work_checkpoint:record-approval",
        label: "stage approval record",
        fixture: {
          tool: "work_checkpoint",
          sessionId: "session-1",
          runId: "run-1",
          ok: true,
          action: "record_approval",
          approvalId: "appr-1",
          stage: "implementation",
          provenance: "user_observed",
        },
      },
      {
        id: "work_checkpoint:revoke-authority",
        label: "authority revocation",
        fixture: {
          tool: "work_checkpoint",
          sessionId: "session-1",
          runId: "run-1",
          ok: true,
          action: "revoke_authority",
          authorityId: "auth-1",
          kind: "narrow",
          availableUnits: 2,
          stages: ["verification"],
        },
      },
      {
        id: "work_checkpoint:failure",
        label: "bounded owned failure",
        fixture: {
          tool: "work_checkpoint",
          sessionId: "session-1",
          ok: false,
          errorCode: "CHECKPOINT_NOT_FOUND",
          category: "state",
          message: "CHECKPOINT_NOT_FOUND: no checkpoint C-9 on the run",
          prerequisite: "a checkpoint bound to the target run",
        },
      },
    ],
    errors: [
      {
        path: "reservedStops[0]",
        expectation: "a misspelled stage rejects and never becomes a silent omission",
      },
      {
        path: "action",
        expectation: "a field consumed by another action is rejected, not ignored",
      },
    ],
    normalization: ["unknown action fields are rejected; no stage/stop is filtered out"],
  },
];
// END_BLOCK_WORKFLOW_ENTRIES

// START_BLOCK_EDIT_ENTRIES
/**
 * Honest aggregate of the two actual hashline_edit result surfaces: the registered
 * text/Error string return value and the separately published metadata envelope.
 * The metadata object is never presented as the registered return value. Composed
 * here from the existing descriptor schemas so no runtime producer changes.
 */
const hashlineEditResultSchema = tool.schema.union([
  tool.schema.string(),
  hashlineEditMetadataSchema,
]);

const editEntries: AgentToolCatalogEntry[] = [
  {
    toolId: HASHLINE_EDIT_TOOL_ID,
    summary:
      "Apply exact hash-anchored line edits, range replacements, boundary inserts, delete, or rename.",
    contract: hashlineEditContract,
    validate: validateHashlineEditToolInput,
    resultSchema: hashlineEditResultSchema,
    vocabularies: [
      { field: "edits[].op", values: ["replace", "replace_range", "append", "prepend"] },
    ],
    operations: [
      {
        id: "hashline_edit:replace",
        label: "replace one line at pos",
        expect: "accept",
        input: { filePath: "/tmp/a.ts", edits: [{ op: "replace", pos: "2#VK#ZZ", lines: ["x"] }] },
        covers: { "edits[].op": "replace" },
      },
      {
        id: "hashline_edit:replace-with-end",
        label: "replace with end is an inclusive range",
        expect: "accept",
        input: {
          filePath: "/tmp/a.ts",
          edits: [{ op: "replace", pos: "2#VK#ZZ", end: "3#MB#ZZ", lines: ["x"] }],
        },
      },
      {
        id: "hashline_edit:replace-range",
        label: "replace_range requires both anchors",
        expect: "accept",
        input: {
          filePath: "/tmp/a.ts",
          edits: [{ op: "replace_range", pos: "2#VK#ZZ", end: "3#MB#ZZ", lines: ["x"] }],
        },
        covers: { "edits[].op": "replace_range" },
      },
      {
        id: "hashline_edit:delete-lines-null",
        label: "deletion via lines null",
        expect: "accept",
        input: {
          filePath: "/tmp/a.ts",
          edits: [{ op: "replace_range", pos: "2#VK#ZZ", end: "3#MB#ZZ", lines: null }],
        },
      },
      {
        id: "hashline_edit:append-boundary",
        label: "append without an anchor inserts at the file boundary",
        expect: "accept",
        input: { filePath: "/tmp/a.ts", edits: [{ op: "append", lines: ["x"] }] },
        covers: { "edits[].op": "append" },
      },
      {
        id: "hashline_edit:prepend-end-fallback",
        label: "prepend with an end-anchor fallback",
        expect: "accept",
        input: { filePath: "/tmp/a.ts", edits: [{ op: "prepend", end: "3#MB#ZZ", lines: ["x"] }] },
        covers: { "edits[].op": "prepend" },
      },
      {
        id: "hashline_edit:delete-file",
        label: "delete mode with an empty edits list",
        expect: "accept",
        input: { filePath: "/tmp/a.ts", delete: true, edits: [] },
      },
      {
        id: "hashline_edit:rename",
        label: "rename after edits",
        expect: "accept",
        input: {
          filePath: "/tmp/a.ts",
          rename: "/tmp/b.ts",
          edits: [{ op: "append", lines: ["x"] }],
        },
      },
      {
        id: "hashline_edit:reject-unknown-nested-key",
        label: "unknown nested edit key is rejected",
        expect: "reject",
        input: { filePath: "/tmp/a.ts", edits: [{ op: "append", lines: ["x"], typo: 1 }] },
        tags: ["unknown_key"],
      },
      {
        id: "hashline_edit:reject-delete-rename",
        label: "delete and rename conflict",
        expect: "reject",
        input: { filePath: "/tmp/a.ts", delete: true, rename: "/tmp/b.ts", edits: [] },
        tags: ["conflict"],
      },
      {
        id: "hashline_edit:reject-replace-range-missing-end",
        label: "replace_range missing end is rejected",
        expect: "reject",
        input: {
          filePath: "/tmp/a.ts",
          edits: [{ op: "replace_range", pos: "2#VK#ZZ", lines: ["x"] }],
        },
        tags: ["missing_required"],
      },
      {
        id: "hashline_edit:reject-conflicting-insert-anchors",
        label: "append with conflicting pos/end anchors is rejected",
        expect: "reject",
        input: {
          filePath: "/tmp/a.ts",
          edits: [{ op: "append", pos: "2#VK#ZZ", end: "3#MB#ZZ", lines: ["x"] }],
        },
        tags: ["conflict"],
      },
      {
        id: "hashline_edit:reject-unsupported-op",
        label: "unsupported op is rejected",
        expect: "reject",
        input: { filePath: "/tmp/a.ts", edits: [{ op: "set_line", pos: "2#VK#ZZ", lines: ["x"] }] },
        tags: ["invalid_value"],
      },
      {
        id: "hashline_edit:reject-replace-missing-pos",
        label: "replace without a pos anchor is rejected",
        expect: "reject",
        input: { filePath: "/tmp/a.ts", edits: [{ op: "replace", lines: ["x"] }] },
        tags: ["missing_required"],
      },
      {
        id: "hashline_edit:reject-prepend-conflicting-anchors",
        label: "prepend with conflicting pos/end anchors is rejected",
        expect: "reject",
        input: {
          filePath: "/tmp/a.ts",
          edits: [{ op: "prepend", pos: "2#VK#ZZ", end: "3#MB#ZZ", lines: ["x"] }],
        },
        tags: ["conflict"],
      },
      {
        id: "hashline_edit:reject-delete-blank-path",
        label: "delete with a blank path is rejected",
        expect: "reject",
        input: { filePath: "", delete: true, edits: [] },
        tags: ["missing_required"],
      },
      {
        id: "hashline_edit:reject-rename-blank-path",
        label: "rename with a blank source path is rejected",
        expect: "reject",
        input: {
          filePath: "",
          rename: "/tmp/b.ts",
          edits: [{ op: "append", lines: ["x"] }],
        },
        tags: ["missing_required"],
      },
    ],
    defaults: [],
    prerequisites: [
      "absolute existing file path and current-file anchor validation",
      "model visibility for the routed edit tool",
    ],
    conditionals: [
      "replace requires pos; replace_range requires pos and end",
      "append/prepend accept one anchor or none; null/[] deletes for replace/replace_range",
      "delete requires an empty edits list and forbids rename",
    ],
    pathKinds: [
      {
        field: "filePath",
        kind: "absolute-file",
        rules: "absolute path; spaces inside the name are preserved",
      },
      {
        field: "rename",
        kind: "absolute-file",
        rules: "non-empty absolute destination path when provided",
      },
    ],
    results: [
      {
        id: "hashline_edit:text-success",
        label: "model-visible success text returned to the host",
        fixture: "Successfully applied 1 edit to /tmp/a.ts",
      },
      {
        id: "hashline_edit:text-error",
        label: "model-visible Error text for a rejected edit",
        fixture: "Error: hash mismatch - anchor 2#VK#ZZ not found in the current file",
      },
      {
        id: "hashline_edit:success-metadata",
        label: "separately published bounded success metadata with filediff",
        fixture: {
          filePath: "/tmp/a.ts",
          path: "/tmp/a.ts",
          file: "/tmp/a.ts",
          noopEdits: 0,
          deduplicatedEdits: 0,
          firstChangedLine: 2,
          editMode: "hashline_edit",
          providerID: "deepseek",
          modelID: "deepseek-v4-flash",
          filediff: {
            file: "/tmp/a.ts",
            path: "/tmp/a.ts",
            filePath: "/tmp/a.ts",
            before: "a\n",
            after: "b\n",
          },
        },
      },
    ],
    errors: [
      { path: "edits[0].typo", expectation: "unknown nested key names the edit index" },
      { path: "edits[0].end", expectation: "conflicting insert anchors name the offending field" },
    ],
    normalization: [
      "literal payloads are applied byte-for-byte; empty content is preserved",
      "current-file and stale-anchor checks remain authoritative after structural validation",
    ],
  },
  {
    toolId: STR_REPLACE_EDITOR_TOOL_ID,
    summary: "View, create, exactly replace, or insert into a file with the dsh command surface.",
    contract: strReplaceEditorContract,
    validate: validateStrReplaceEditorToolInput,
    resultSchema: strReplaceEditorResultSchema,
    vocabularies: [{ field: "command", values: ["view", "create", "str_replace", "insert"] }],
    operations: [
      {
        id: "str_replace_editor:view",
        label: "view with an end-of-file range",
        expect: "accept",
        input: { command: "view", path: "/tmp/a.ts", view_range: [2, -1] },
        covers: { command: "view" },
      },
      {
        id: "str_replace_editor:create",
        label: "create with an explicitly empty file_text",
        expect: "accept",
        input: { command: "create", path: "/tmp/a.ts", file_text: "" },
        covers: { command: "create" },
      },
      {
        id: "str_replace_editor:str-replace-explicit-empty",
        label: "str_replace with an explicit empty new_str (deletion)",
        expect: "accept",
        input: { command: "str_replace", path: "/tmp/a.ts", old_str: "x", new_str: "" },
        covers: { command: "str_replace" },
      },
      {
        id: "str_replace_editor:str-replace-omitted-new-str",
        label: "str_replace with an omitted new_str defaults to deletion",
        expect: "accept",
        input: { command: "str_replace", path: "/tmp/a.ts", old_str: "x" },
      },
      {
        id: "str_replace_editor:insert",
        label: "insert with an integer insert_line and empty new_str",
        expect: "accept",
        input: { command: "insert", path: "/tmp/a.ts", insert_line: 0, new_str: "" },
        covers: { command: "insert" },
      },
      {
        id: "str_replace_editor:reject-unknown-key",
        label: "unknown key is rejected",
        expect: "reject",
        input: { command: "view", path: "/tmp/a.ts", nested: { deep: 1 } },
        tags: ["unknown_key"],
      },
      {
        id: "str_replace_editor:reject-unsupported-command",
        label: "an unsupported command is rejected",
        expect: "reject",
        input: { command: "delete", path: "/tmp/a.ts" },
        tags: ["invalid_value"],
      },
      {
        id: "str_replace_editor:reject-unconsumed-field",
        label: "a field for another command is rejected",
        expect: "reject",
        input: { command: "view", path: "/tmp/a.ts", old_str: "x" },
        tags: ["conflict"],
      },
      {
        id: "str_replace_editor:reject-create-missing-file-text",
        label: "create without file_text is rejected",
        expect: "reject",
        input: { command: "create", path: "/tmp/a.ts" },
        tags: ["missing_required"],
      },
      {
        id: "str_replace_editor:reject-empty-old-str",
        label: "str_replace requires a non-empty old_str",
        expect: "reject",
        input: { command: "str_replace", path: "/tmp/a.ts", old_str: "", new_str: "x" },
        tags: ["invalid_value"],
      },
      {
        id: "str_replace_editor:reject-insert-missing-line",
        label: "insert without insert_line is rejected",
        expect: "reject",
        input: { command: "insert", path: "/tmp/a.ts", new_str: "x" },
        tags: ["missing_required"],
      },
      {
        id: "str_replace_editor:reject-view-range-shape",
        label: "view_range must be exactly two integers",
        expect: "reject",
        input: { command: "view", path: "/tmp/a.ts", view_range: [1] },
        tags: ["invalid_value"],
      },
      {
        id: "str_replace_editor:reject-view-range-order",
        label: "view_range end must be -1 or >= start",
        expect: "reject",
        input: { command: "view", path: "/tmp/a.ts", view_range: [3, 2] },
        tags: ["invalid_value"],
      },
    ],
    defaults: [],
    prerequisites: [
      "path existence and directory checks in the editor",
      "current-file freshness for str_replace and insert",
    ],
    conditionals: [
      "create requires file_text (explicit empty allowed)",
      "str_replace requires a non-empty old_str; omitted new_str deletes",
      "insert requires insert_line >= 0 and new_str; view_range length is exactly 2",
    ],
    pathKinds: [
      {
        field: "path",
        kind: "absolute-file",
        rules: "absolute file or directory path; non-empty",
      },
    ],
    results: [
      {
        id: "str_replace_editor:ok",
        label: "successful ok/output envelope",
        fixture: { ok: true, output: "done" },
      },
      {
        id: "str_replace_editor:error",
        label: "error envelope",
        fixture: { ok: false, error: "nope" },
      },
    ],
    errors: [
      { path: "path", expectation: "blank paths are rejected before any mutation" },
      { path: "view_range", expectation: "a non-two-element range is diagnosed" },
    ],
    normalization: ["model visibility is checked before the tool is used"],
  },
];
// END_BLOCK_EDIT_ENTRIES

// START_BLOCK_WEB_ENTRIES
const webEntries: AgentToolCatalogEntry[] = [
  {
    toolId: WEB_SEARCH_TOOL_ID,
    summary: "Search the configured provider and return ranked Markdown results.",
    contract: webSearchContract,
    validate: validateWebSearchToolInput,
    resultSchema: webSearchResultSchema,
    vocabularies: [{ field: "freshness", values: ["day", "week", "month", "year"] }],
    operations: [
      {
        id: "web_search:default-count",
        label: "query only applies the documented count default",
        expect: "accept",
        input: { query: "vvoc" },
      },
      {
        id: "web_search:freshness-day",
        label: "freshness day",
        expect: "accept",
        input: { query: "vvoc", freshness: "day" },
        covers: { freshness: "day" },
      },
      {
        id: "web_search:freshness-week",
        label: "freshness week",
        expect: "accept",
        input: { query: "vvoc", freshness: "week" },
        covers: { freshness: "week" },
      },
      {
        id: "web_search:freshness-month",
        label: "freshness month",
        expect: "accept",
        input: { query: "vvoc", freshness: "month" },
        covers: { freshness: "month" },
      },
      {
        id: "web_search:freshness-year",
        label: "freshness year",
        expect: "accept",
        input: { query: "vvoc", freshness: "year" },
        covers: { freshness: "year" },
      },
      {
        id: "web_search:max-count",
        label: "explicit integer count at the maximum",
        expect: "accept",
        input: { query: "vvoc", count: 20 },
      },
      {
        id: "web_search:reject-unknown-key",
        label: "unknown key is rejected",
        expect: "reject",
        input: { query: "vvoc", extra: true },
        tags: ["unknown_key"],
      },
      {
        id: "web_search:reject-count-low",
        label: "count below the minimum is rejected",
        expect: "reject",
        input: { query: "vvoc", count: 0 },
        tags: ["invalid_value"],
      },
      {
        id: "web_search:reject-count-high",
        label: "count above the maximum is rejected",
        expect: "reject",
        input: { query: "vvoc", count: 21 },
        tags: ["invalid_value"],
      },
      {
        id: "web_search:reject-fractional-count",
        label: "a fractional count is rejected, not coerced",
        expect: "reject",
        input: { query: "vvoc", count: 1.5 },
        tags: ["invalid_value"],
      },
      {
        id: "web_search:reject-string-count",
        label: "a string count is rejected, not coerced",
        expect: "reject",
        input: { query: "vvoc", count: "8" },
        tags: ["invalid_value"],
      },
      {
        id: "web_search:reject-unknown-freshness",
        label: "an unsupported freshness window is rejected",
        expect: "reject",
        input: { query: "vvoc", freshness: "hour" },
        tags: ["invalid_value"],
      },
      {
        id: "web_search:reject-freshness-day-invalid-count",
        label: "freshness day with an out-of-range count is rejected",
        expect: "reject",
        input: { query: "vvoc", freshness: "day", count: 0 },
        tags: ["invalid_value"],
      },
      {
        id: "web_search:reject-freshness-week-invalid-count",
        label: "freshness week with an out-of-range count is rejected",
        expect: "reject",
        input: { query: "vvoc", freshness: "week", count: 0 },
        tags: ["invalid_value"],
      },
      {
        id: "web_search:reject-freshness-month-invalid-count",
        label: "freshness month with an out-of-range count is rejected",
        expect: "reject",
        input: { query: "vvoc", freshness: "month", count: 0 },
        tags: ["invalid_value"],
      },
      {
        id: "web_search:reject-freshness-year-invalid-count",
        label: "freshness year with an out-of-range count is rejected",
        expect: "reject",
        input: { query: "vvoc", freshness: "year", count: 0 },
        tags: ["invalid_value"],
      },
      {
        id: "web_search:reject-credential",
        label: "credential or provider selection is not a caller argument",
        expect: "reject",
        input: { query: "vvoc", credential: "secret", provider: "brave" },
        tags: ["unknown_key"],
      },
    ],
    defaults: [
      { field: "count", value: WEB_SEARCH_DEFAULT_COUNT, note: "re-applied at execute time" },
    ],
    prerequisites: [
      "configured provider and permission prompt",
      "resolved credential (env or config) for non-native providers",
    ],
    conditionals: ["count is an integer 1..20; freshness is optional"],
    pathKinds: [],
    results: [
      {
        id: "web_search:exa",
        label: "ranked Markdown result from the Exa provider",
        fixture: {
          title: "web_search: vvoc",
          output: "# Results\n\n1. ...",
          metadata: { provider: "exa", resultCount: 2, credentialSource: "env" },
        },
      },
      {
        id: "web_search:brave",
        label: "ranked Markdown result from the Brave provider",
        fixture: {
          title: "web_search: vvoc",
          output: "# Results\n\n1. ...",
          metadata: { provider: "brave", resultCount: 3, credentialSource: "config" },
        },
      },
      {
        id: "web_search:zai",
        label: "ranked Markdown result from the regional Z.AI provider",
        fixture: {
          title: "web_search: vvoc",
          output: "# Results\n\n1. ...",
          metadata: {
            provider: "zai",
            region: "international",
            resultCount: 1,
            credentialSource: "env",
          },
        },
      },
    ],
    errors: [
      { path: "count", expectation: "an out-of-range count is rejected before dispatch" },
      { path: "credential", expectation: "unknown credential/provider fields are rejected" },
    ],
    normalization: [
      "the query text is preserved verbatim; provider/credential fields are never accepted",
    ],
  },
  {
    toolId: WEB_FETCH_TOOL_ID,
    summary: "Fetch a known HTTP(S) URL and return Markdown, text, HTML, or a media attachment.",
    contract: webFetchContract,
    validate: validateWebFetchToolInput,
    resultSchema: webFetchResultSchema,
    vocabularies: [{ field: "format", values: ["markdown", "text", "html"] }],
    operations: [
      {
        id: "web_fetch:default-format",
        label: "url only applies markdown and the timeout default",
        expect: "accept",
        input: { url: "https://example.test/page" },
        covers: { format: "markdown" },
      },
      {
        id: "web_fetch:format-text",
        label: "text format with a fractional positive timeout",
        expect: "accept",
        input: { url: "https://example.test/page", format: "text", timeout: 0.5 },
        covers: { format: "text" },
      },
      {
        id: "web_fetch:format-html",
        label: "html format at the timeout maximum",
        expect: "accept",
        input: { url: "https://example.test/page", format: "html", timeout: 120 },
        covers: { format: "html" },
      },
      {
        id: "web_fetch:reject-unknown-key",
        label: "unknown key is rejected",
        expect: "reject",
        input: { url: "https://example.test/page", extra: true },
        tags: ["unknown_key"],
      },
      {
        id: "web_fetch:reject-relative-url",
        label: "a relative URL is rejected",
        expect: "reject",
        input: { url: "/page" },
        tags: ["invalid_value"],
      },
      {
        id: "web_fetch:reject-file-scheme",
        label: "the file scheme is unsupported",
        expect: "reject",
        input: { url: "file:///tmp/secret" },
        tags: ["invalid_value"],
      },
      {
        id: "web_fetch:reject-data-scheme",
        label: "the data scheme is unsupported",
        expect: "reject",
        input: { url: "data:text/plain,hello" },
        tags: ["invalid_value"],
      },
      {
        id: "web_fetch:reject-unsupported-format",
        label: "an unsupported format is rejected",
        expect: "reject",
        input: { url: "https://example.test/page", format: "pdf" },
        tags: ["invalid_value"],
      },
      {
        id: "web_fetch:reject-markdown-invalid-timeout",
        label: "markdown with a non-positive timeout is rejected",
        expect: "reject",
        input: { url: "https://example.test/page", format: "markdown", timeout: 0 },
        tags: ["invalid_value"],
      },
      {
        id: "web_fetch:reject-text-invalid-timeout",
        label: "text with a non-positive timeout is rejected",
        expect: "reject",
        input: { url: "https://example.test/page", format: "text", timeout: 0 },
        tags: ["invalid_value"],
      },
      {
        id: "web_fetch:reject-html-invalid-timeout",
        label: "html with a non-positive timeout is rejected",
        expect: "reject",
        input: { url: "https://example.test/page", format: "html", timeout: 0 },
        tags: ["invalid_value"],
      },
      {
        id: "web_fetch:reject-zero-timeout",
        label: "a non-positive timeout is rejected",
        expect: "reject",
        input: { url: "https://example.test/page", timeout: 0 },
        tags: ["invalid_value"],
      },
      {
        id: "web_fetch:reject-string-timeout",
        label: "a string timeout is rejected, not coerced",
        expect: "reject",
        input: { url: "https://example.test/page", timeout: "30" },
        tags: ["invalid_value"],
      },
      {
        id: "web_fetch:reject-credential",
        label: "credential or provider selection is not a caller argument",
        expect: "reject",
        input: { url: "https://example.test/page", apiKey: "secret", provider: "spider" },
        tags: ["unknown_key"],
      },
    ],
    defaults: [
      { field: "format", value: "markdown", note: "re-applied at execute time" },
      {
        field: "timeout",
        value: WEB_FETCH_DEFAULT_TIMEOUT_SECONDS,
        note: "re-applied at execute time; positive and at most 120",
      },
    ],
    prerequisites: [
      "configured provider and permission prompt",
      "resolved credential for spider/zai providers",
    ],
    conditionals: ["format defaults to markdown; timeout is positive and at most 120"],
    pathKinds: [
      {
        field: "url",
        kind: "url",
        rules:
          "absolute http(s) URL; the URL is requested unchanged and never echoed in diagnostics",
      },
    ],
    results: [
      {
        id: "web_fetch:text-native",
        label: "native textual result envelope",
        fixture: {
          title: "web_fetch: https://example.test/page",
          output: "body",
          metadata: { provider: "native", format: "markdown", status: 200 },
        },
      },
      {
        id: "web_fetch:text-spider",
        label: "Spider textual result envelope with request timing",
        fixture: {
          title: "web_fetch: https://example.test/page",
          output: "body",
          metadata: {
            provider: "spider",
            format: "html",
            credentialSource: "env",
            status: 200,
            durationMs: 12,
          },
        },
      },
      {
        id: "web_fetch:text-zai",
        label: "regional Z.AI textual result envelope with reader metadata",
        fixture: {
          title: "web_fetch: https://example.test/page",
          output: "body",
          metadata: {
            provider: "zai",
            region: "china",
            format: "text",
            credentialSource: "config",
            status: 200,
            requestId: "req-1",
            model: "reader",
            created: 1,
            title: "Example",
          },
        },
      },
      {
        id: "web_fetch:media-native",
        label: "native media result envelope with a real attachment",
        fixture: {
          title: "web_fetch: https://example.test/image.png",
          output: "Fetched as an image/png attachment.",
          metadata: { provider: "native", format: "markdown", status: 200 },
          attachments: [{ type: "file", mime: "image/png", url: "data:image/png;base64,AA==" }],
        },
      },
      {
        id: "web_fetch:media-spider",
        label: "Spider media result envelope with request timing",
        fixture: {
          title: "web_fetch: https://example.test/image.png",
          output: "Fetched as an image/png attachment.",
          metadata: {
            provider: "spider",
            format: "markdown",
            credentialSource: "env",
            durationMs: 7,
          },
          attachments: [{ type: "file", mime: "image/png", url: "data:image/png;base64,AA==" }],
        },
      },
      {
        id: "web_fetch:media-zai",
        label: "regional Z.AI media result envelope with a real attachment",
        fixture: {
          title: "web_fetch: https://example.test/image.png",
          output: "Fetched as an image/png attachment.",
          metadata: {
            provider: "zai",
            region: "international",
            format: "markdown",
            credentialSource: "env",
          },
          attachments: [{ type: "file", mime: "image/png", url: "data:image/png;base64,AA==" }],
        },
      },
    ],
    errors: [
      { path: "url", expectation: "a non-http(s) URL is rejected without echoing the raw URL" },
      { path: "timeout", expectation: "an out-of-bounds timeout is rejected before dispatch" },
    ],
    normalization: [
      "document and binary content stay declared opaque; credentials are never accepted",
    ],
  },
];
// END_BLOCK_WEB_ENTRIES

// START_BLOCK_CATALOG
/** Package-relative path of the generated reference document. */
export const CONTRACT_REFERENCE_PACKAGE_PATH =
  "templates/skills/vv-execute/references/tool-contracts.md";

/**
 * Recorded pre-change contract-size baseline with provenance.
 * Measured once from the clean starting commit; future checks compare against the
 * catalog-derived current measurement rather than reading mutable git history.
 */
export const CONTRACT_SIZE_BASELINE = {
  provenance: {
    commit: "f4319f8",
    sdk: "@opencode-ai/plugin@1.18.2",
    method: "source-extraction" as const,
    detail:
      'UTF-8 byte sizes measured at the clean starting commit f4319f8 by extracting each owned tool\'s model-facing description string and projecting its pre-change registered argument map with the pinned SDK (io:"input"). This is a declaration/projection size, not a provider-exact token count and not a model-quality or model-effectiveness claim.',
    procedure:
      'Reproduce the baseline: `git show f4319f8:<tool-source> | extract the model-facing description`, then project each pre-change registered argument map with @opencode-ai/plugin@1.18.2 via tool.schema.toJSONSchema(schema, { io: "input" }) and sum Buffer.byteLength(value, "utf8"). "After" is the catalog-derived `measureCatalogContractSize()` value printed below as "Current model-facing size"; compare it to this baseline. Numbers reported are exact UTF-8 byte counts, never estimated token counts.',
  },
  before: {
    descriptionBytes: 8796,
    inputSchemaBytes: 6815,
  },
} as const;

/** The nine owned tool catalog entries in stable registration order. */
export const agentToolCatalog: readonly AgentToolCatalogEntry[] = [
  ...workflowEntries,
  ...editEntries,
  ...webEntries,
];

/** Sorted tool ids covered by the catalog. */
export const AGENT_TOOL_CATALOG_TOOL_IDS: readonly string[] = agentToolCatalog
  .map((entry) => entry.toolId)
  .sort();

/** Sorted tool ids covered by the catalog. */
export function catalogToolIds(): string[] {
  return [...AGENT_TOOL_CATALOG_TOOL_IDS];
}

/** Current description/input-schema UTF-8 byte measurement derived from the catalog. */
export function measureCatalogContractSize(
  entries: readonly AgentToolCatalogEntry[] = agentToolCatalog,
): {
  descriptionBytes: number;
  inputSchemaBytes: number;
  totalBytes: number;
} {
  let descriptionBytes = 0;
  let inputSchemaBytes = 0;
  for (const entry of entries) {
    descriptionBytes += Buffer.byteLength(entry.contract.description, "utf8");
    inputSchemaBytes += Buffer.byteLength(JSON.stringify(entry.contract.inputJsonSchema), "utf8");
  }
  return { descriptionBytes, inputSchemaBytes, totalBytes: descriptionBytes + inputSchemaBytes };
}
// END_BLOCK_CATALOG

// START_BLOCK_FIXTURE_RUNNER
function firstIssuePath(issues: readonly ContractIssue[] | undefined): string {
  const first = issues?.[0];
  return first ? first.path : "(root)";
}

/**
 * Run every catalog fixture through the actual exporting validator, and every
 * result-family fixture through the actual result schema. This is the shared
 * fixture gate used by both the catalog test and scripts/check-tool-contracts.ts.
 */
export function validateAgentToolCatalog(): { ok: boolean; failures: string[]; checked: number } {
  const failures: string[] = [];
  let checked = 0;
  for (const entry of agentToolCatalog) {
    for (const operation of entry.operations) {
      checked += 1;
      const result = entry.validate(operation.input);
      const expected = operation.expect === "accept";
      if (result.ok !== expected) {
        failures.push(
          `${operation.id}: expected ${operation.expect}, got ${result.ok ? "accept" : "reject"} at ${firstIssuePath(result.issues)}`,
        );
      }
    }
    for (const variant of entry.results) {
      checked += 1;
      const parsed = (
        entry.resultSchema as unknown as { safeParse: (v: unknown) => { success: boolean } }
      ).safeParse(variant.fixture);
      if (!parsed.success) {
        failures.push(
          `${entry.toolId}/${variant.id}: result fixture does not match the result schema`,
        );
      }
    }
  }
  return { ok: failures.length === 0, failures, checked };
}

/** One ancestor union option that a fixture must also satisfy for a nested branch. */
export interface ResultBranchAncestor {
  readonly valuePath: readonly string[];
  readonly schema: unknown;
}

/** One union branch location reachable from a result schema, with its fixture value path. */
export interface ResultBranchLocation {
  readonly path: string;
  readonly valuePath: readonly string[];
  readonly schema: unknown;
  readonly ancestors: readonly ResultBranchAncestor[];
}

/**
 * Enumerate every discriminated-union branch reachable from a result schema,
 * including unions nested inside object properties (provider metadata variants)
 * and their sub-branches. The `valuePath` is the property path into a fixture
 * value that this branch validates, so nested variants are checked materially
 * rather than only at the outer union.
 */
function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { safeParse?: unknown }).safeParse === "function"
  );
}

/** Sentinel path segment meaning "each element of the array at this position". */
const ARRAY_PATH_SEGMENT = "[]";

function zodLiteralValue(schema: unknown): string | number | boolean | undefined {
  if (!isSchemaObject(schema)) return undefined;
  const value = (schema as { value?: unknown }).value;
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : undefined;
}

function literalToken(value: string | number | boolean): string {
  return `${typeof value}:${String(value)}`;
}

/**
 * A nested union is a material result family only when at least two of its object
 * options are discriminated by distinct literal values on one property (for example
 * the provider metadata variants or a boolean `ok` batch item union).
 * Optional/nullable wrappers, enums, and type unions are not coverage families.
 */
function isDiscriminatedResultUnion(options: readonly unknown[]): boolean {
  const objectOptions = options.filter(isSchemaObject);
  if (objectOptions.length < 2) return false;
  const valuesByKey = new Map<string, Set<string>>();
  for (const option of objectOptions) {
    const shape = option.shape as Record<string, unknown> | undefined;
    if (!shape) continue;
    for (const [key, value] of Object.entries(shape)) {
      const literal = zodLiteralValue(value);
      if (literal === undefined) continue;
      if (!valuesByKey.has(key)) valuesByKey.set(key, new Set());
      valuesByKey.get(key)!.add(literalToken(literal));
    }
  }
  return [...valuesByKey.values()].some((values) => values.size >= 2);
}

export function collectResultBranches(schema: unknown): ResultBranchLocation[] {
  const branches: ResultBranchLocation[] = [];
  const visit = (
    node: unknown,
    nodePath: string,
    valuePath: readonly string[],
    isRootUnion: boolean,
    ancestors: readonly ResultBranchAncestor[],
    pathStack: ReadonlySet<unknown>,
  ): void => {
    if (typeof node !== "object" || node === null) return;
    // Self-referential schema nodes must not loop forever: skip a node already on
    // the current descent path rather than silently re-expanding it.
    if (pathStack.has(node)) return;
    const nextStack = new Set(pathStack).add(node);
    const candidate = node as {
      unwrap?: () => unknown;
      options?: readonly unknown[];
      shape?: Record<string, unknown>;
      element?: unknown;
    };
    // Discriminated unions and enums first, then closed objects, then arrays, then
    // optional/nullable/default wrappers (whose `unwrap` may also expose an inner
    // array/union and must not shadow the array context).
    if (Array.isArray(candidate.options)) {
      const options = candidate.options.filter(isSchemaObject);
      // Enum unions expose primitive options; they are vocabularies, not result branches.
      if (options.length < 2) return;
      if (isRootUnion || isDiscriminatedResultUnion(options)) {
        options.forEach((option, index) => {
          const branchPath = `${nodePath}.union[${index}]`;
          branches.push({ path: branchPath, valuePath, schema: option, ancestors });
          visit(
            option,
            branchPath,
            valuePath,
            false,
            [...ancestors, { valuePath, schema: option }],
            nextStack,
          );
        });
        return;
      }
      // Non-material nested union: keep descending so a deeper provider union is
      // still reachable, without claiming this wrapper as a coverage family.
      options.forEach((option, index) =>
        visit(option, `${nodePath}.option[${index}]`, valuePath, false, ancestors, nextStack),
      );
      return;
    }
    if (candidate.shape) {
      for (const [key, value] of Object.entries(candidate.shape)) {
        visit(value, `${nodePath}.${key}`, [...valuePath, key], false, ancestors, nextStack);
      }
      return;
    }
    // Array elements are descended with an array path segment so unions nested
    // inside list values (batch items, provider lists) are material families too.
    if (candidate.element !== undefined) {
      visit(
        candidate.element,
        `${nodePath}[]`,
        [...valuePath, ARRAY_PATH_SEGMENT],
        false,
        ancestors,
        nextStack,
      );
      return;
    }
    if (typeof candidate.unwrap === "function") {
      visit(candidate.unwrap(), nodePath, valuePath, isRootUnion, ancestors, nextStack);
    }
  };
  visit(schema, "(root)", [], true, [], new Set<unknown>());
  return branches;
}

/** Every value reachable through a path, fanning out across array elements. */
function resolvePathValues(value: unknown, path: readonly string[]): unknown[] {
  if (path.length === 0) return [value];
  const [head, ...rest] = path;
  if (head === ARRAY_PATH_SEGMENT) {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => resolvePathValues(item, rest));
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  return resolvePathValues((value as Record<string, unknown>)[head], rest);
}

function matchesAnyAncestor(fixture: unknown, ancestors: readonly ResultBranchAncestor[]): boolean {
  return ancestors.every((ancestor) =>
    resolvePathValues(fixture, ancestor.valuePath).some((target) => {
      if (target === undefined) return false;
      const schema = ancestor.schema as { safeParse?: (v: unknown) => { success: boolean } };
      return typeof schema.safeParse === "function" && schema.safeParse(target).success;
    }),
  );
}

/** Result-schema union branches a single catalog entry's fixtures do not cover. */
export function resultBranchGaps(entry: AgentToolCatalogEntry): string[] {
  const branches = collectResultBranches(entry.resultSchema);
  const covered = new Set<number>();
  for (const variant of entry.results) {
    branches.forEach((branch, index) => {
      if (!matchesAnyAncestor(variant.fixture, branch.ancestors)) return;
      const schema = branch.schema as { safeParse?: (v: unknown) => { success: boolean } };
      const matches = resolvePathValues(variant.fixture, branch.valuePath).some(
        (target) =>
          target !== undefined &&
          typeof schema.safeParse === "function" &&
          schema.safeParse(target).success,
      );
      if (matches) covered.add(index);
    });
  }
  const gaps: string[] = [];
  branches.forEach((branch, index) => {
    if (!covered.has(index)) {
      gaps.push(`${entry.toolId}: uncovered result branch ${branch.path}`);
    }
  });
  return gaps;
}

/** Result-schema union branches not covered by any catalog result fixture. */
export function resultCoverageGaps(
  entries: readonly AgentToolCatalogEntry[] = agentToolCatalog,
): string[] {
  return entries.flatMap((entry) => resultBranchGaps(entry));
}
// END_BLOCK_FIXTURE_RUNNER

// START_BLOCK_OPAQUE_SCAN
const OPAQUE_SCAN_KEYWORDS = [
  "type",
  "enum",
  "const",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "properties",
  "additionalProperties",
  "patternProperties",
  "propertyNames",
  "items",
  "prefixItems",
  "contains",
  "$ref",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isObjectLike(record: Record<string, unknown>): boolean {
  const typeValue = record.type;
  if (typeof typeValue === "string") return typeValue === "object";
  if (Array.isArray(typeValue)) return typeValue.includes("object");
  return record.properties !== undefined || record.additionalProperties !== undefined;
}

function resolveLocalRef(ref: unknown, root: unknown): unknown {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return undefined;
  const segments = ref
    .slice(2)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = root;
  for (const segment of segments) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Find arbitrary (non-closed) object or unconstrained nodes in a published input schema.
 * A node is opaque when it accepts an arbitrary value: an object that does not close
 * `additionalProperties` to false (including a missing `additionalProperties`), an empty
 * or keyword-free schema, a `true` schema, or an unresolvable `$ref`. Known object
 * properties, unions (`anyOf`/`oneOf`/`allOf`), array items, and resolvable local refs
 * are visited. Genuine opaque input regions are not permitted for public inputs; there is
 * no whole-tool exemption.
 */
export function findOpaqueInputObjects(
  schema: unknown,
  basePath = "(root)",
  root: unknown = schema,
  visiting: ReadonlySet<string> = new Set<string>(),
): string[] {
  const found: string[] = [];
  if (schema === true) {
    found.push(`${basePath}: unconstrained schema (true)`);
    return found;
  }
  if (schema === false || !isPlainObject(schema)) return found;

  if (typeof schema.$ref === "string") {
    if (visiting.has(schema.$ref)) return found;
    const resolved = resolveLocalRef(schema.$ref, root);
    if (resolved === undefined) {
      found.push(`${basePath}: unresolvable $ref "${schema.$ref}"`);
      return found;
    }
    const nextVisiting = new Set(visiting);
    nextVisiting.add(schema.$ref);
    found.push(...findOpaqueInputObjects(resolved, basePath, root, nextVisiting));
    return found;
  }

  const hasKeyword = OPAQUE_SCAN_KEYWORDS.some((keyword) => schema[keyword] !== undefined);
  if (!hasKeyword) {
    found.push(`${basePath}: unconstrained schema`);
    return found;
  }

  if (isObjectLike(schema)) {
    if (schema.additionalProperties !== false) {
      found.push(
        `${basePath}: open object (additionalProperties must be false${
          schema.additionalProperties === undefined ? "; none was declared" : ""
        })`,
      );
    }
    const properties = schema.properties;
    if (isPlainObject(properties)) {
      for (const [key, value] of Object.entries(properties)) {
        found.push(...findOpaqueInputObjects(value, `${basePath}.${key}`, root, visiting));
      }
    }
    const patternProperties = schema.patternProperties;
    if (isPlainObject(patternProperties)) {
      for (const [key, value] of Object.entries(patternProperties)) {
        found.push(...findOpaqueInputObjects(value, `${basePath}.pattern(${key})`, root, visiting));
      }
    }
  }

  for (const keyword of ["anyOf", "oneOf", "allOf", "prefixItems"] as const) {
    const branches = schema[keyword];
    if (Array.isArray(branches)) {
      branches.forEach((branch, index) =>
        found.push(
          ...findOpaqueInputObjects(branch, `${basePath}.${keyword}[${index}]`, root, visiting),
        ),
      );
    }
  }
  if (schema.items !== undefined) {
    if (Array.isArray(schema.items)) {
      schema.items.forEach((branch, index) =>
        found.push(
          ...findOpaqueInputObjects(branch, `${basePath}.items[${index}]`, root, visiting),
        ),
      );
    } else {
      found.push(...findOpaqueInputObjects(schema.items, `${basePath}[]`, root, visiting));
    }
  }
  return found;
}
// END_BLOCK_OPAQUE_SCAN

// START_BLOCK_REFERENCE
function schemaTypeLabel(schema: unknown): string {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return "unknown";
  const record = schema as Record<string, unknown>;
  if (Array.isArray(record.enum)) return `enum(${record.enum.join(" | ")})`;
  if (typeof record.type === "string") return record.type;
  if (Array.isArray(record.anyOf)) return "union";
  return "object";
}

/** Escape Markdown table cell content so prose pipes cannot break the table. */
function escapeTableCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

function topLevelFieldRows(entry: AgentToolCatalogEntry): string[] {
  const projection = entry.contract.inputJsonSchema as Record<string, unknown>;
  const properties = (projection.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((projection.required as readonly string[] | undefined) ?? []);
  const rows: string[] = [];
  for (const [name, fieldSchema] of Object.entries(properties)) {
    const description =
      typeof fieldSchema.description === "string"
        ? escapeTableCell(fieldSchema.description.replace(/\s+/g, " ").slice(0, 160))
        : "";
    rows.push(
      `| \`${escapeTableCell(name)}\` | ${escapeTableCell(schemaTypeLabel(fieldSchema))} | ${required.has(name) ? "yes" : "no"} | ${description} |`,
    );
  }
  return rows;
}

/** Render one checked example as a real multi-line JSON fenced block under its list item. */
function exampleBlock(operation: CatalogOperation, outcome: "accept" | "reject"): string[] {
  const lines: string[] = [];
  lines.push(`- \`${operation.id}\` (${outcome}):`);
  lines.push("  ```json");
  for (const jsonLine of JSON.stringify(operation.input, null, 2).split("\n")) {
    lines.push(`  ${jsonLine}`);
  }
  lines.push("  ```");
  return lines;
}

/**
 * Render the deterministic, on-demand tool-contracts reference from the catalog.
 * No timestamps, absolute paths, or environment values are embedded, so the
 * output is byte-stable and can be checked for currency by `bun run contracts:check`.
 * Each checked example's outcome is derived from running the actual validator, so
 * mislabeled metadata cannot be published as a passing example. `entries` is
 * injectable so self-tests can validate an isolated catalog without the global one.
 */
export function renderToolContractsReference(
  entries: readonly AgentToolCatalogEntry[] = agentToolCatalog,
): string {
  const size = measureCatalogContractSize(entries);
  const baseline = CONTRACT_SIZE_BASELINE;
  const lines: string[] = [];
  lines.push("# vvoc agent tool contracts");
  lines.push("");
  lines.push(
    "Generated from the pure tool catalog. Do not edit by hand; run `bun run contracts:generate`.",
  );
  lines.push("");
  lines.push(`- Package: \`${PACKAGE_NAME}@${PACKAGE_VERSION}\``);
  lines.push(`- Tool contract revision: \`${AGENT_TOOL_CONTRACT_REVISION}\``);
  lines.push(`- Reference path: \`${CONTRACT_REFERENCE_PACKAGE_PATH}\``);
  lines.push(
    `- Current model-facing size: descriptions ${size.descriptionBytes} bytes, published input schemas ${size.inputSchemaBytes} bytes`,
  );
  lines.push(
    `- Baseline (commit ${baseline.provenance.commit}, SDK ${baseline.provenance.sdk}, ${baseline.provenance.method}): descriptions ${baseline.before.descriptionBytes} bytes, projected input schemas ${baseline.before.inputSchemaBytes} bytes`,
  );
  lines.push("");
  lines.push(
    "> Schema acceptance is structural only. It is not authorization, not proof of evidence,",
  );
  lines.push("> not reviewer acceptance, and not permission for a workflow transition. A declared");
  lines.push(
    "> `writeScope` is an edit boundary, not a universal sandbox, and no tool here grants a",
  );
  lines.push("> state transition on its own.");
  lines.push("");
  lines.push("## Reading guide");
  lines.push("");
  lines.push(
    "This is an on-demand reference; load only the tool section you need rather than the whole manual. Each tool section lists a closed field table, closed vocabularies, execute-time defaults, state/host prerequisites, conditional requirements, declared path kinds, result families, representative failures, and checked accept/reject examples. Tool sections: " +
      entries.map((entry) => `\`${entry.toolId}\``).join(", ") +
      ".",
  );
  lines.push("");
  lines.push("## Tools");
  lines.push("");
  for (const entry of entries) {
    lines.push(`### \`${entry.toolId}\``);
    lines.push("");
    const firstDescriptionLine = entry.contract.description.split("\n")[0]?.trim() ?? "";
    const descriptionSummary =
      firstDescriptionLine.length > 240
        ? `${firstDescriptionLine.slice(0, 239)}…`
        : firstDescriptionLine;
    lines.push(`- Summary: ${entry.summary}`);
    lines.push(`- Description: ${descriptionSummary}`);
    lines.push("");
    lines.push("| field | type | required | description |");
    lines.push("| --- | --- | --- | --- |");
    for (const row of topLevelFieldRows(entry)) lines.push(row);
    lines.push("");
    if (entry.vocabularies.length > 0) {
      lines.push("Closed vocabularies:");
      for (const vocabulary of entry.vocabularies) {
        lines.push(`- \`${vocabulary.field}\`: ${vocabulary.values.join(" | ")}`);
      }
      lines.push("");
    }
    if (entry.defaults.length > 0) {
      lines.push("Execute-time defaults:");
      for (const entryDefault of entry.defaults) {
        lines.push(
          `- \`${entryDefault.field}\` = \`${JSON.stringify(entryDefault.value)}\` (${entryDefault.note})`,
        );
      }
      lines.push("");
    }
    if (entry.prerequisites.length > 0) {
      lines.push("State/host prerequisites:");
      for (const prerequisite of entry.prerequisites) lines.push(`- ${prerequisite}`);
      lines.push("");
    }
    if (entry.conditionals.length > 0) {
      lines.push("Conditional requirements:");
      for (const conditional of entry.conditionals) lines.push(`- ${conditional}`);
      lines.push("");
    }
    if (entry.pathKinds.length > 0) {
      lines.push("Path kinds:");
      for (const pathKind of entry.pathKinds) {
        lines.push(`- \`${pathKind.field}\` (${pathKind.kind}): ${pathKind.rules}`);
      }
      lines.push("");
    }
    lines.push("Result families:");
    for (const variant of entry.results) lines.push(`- \`${variant.id}\`: ${variant.label}`);
    lines.push("");
    if (entry.errors.length > 0) {
      lines.push("Representative failures:");
      for (const error of entry.errors) lines.push(`- \`${error.path}\`: ${error.expectation}`);
      lines.push("");
    }
    lines.push("Checked examples:");
    for (const operation of entry.operations) {
      const outcome = entry.validate(operation.input).ok ? "accept" : "reject";
      lines.push(...exampleBlock(operation, outcome));
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
// END_BLOCK_REFERENCE
