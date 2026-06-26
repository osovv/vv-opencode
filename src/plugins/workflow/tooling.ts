// FILE: src/plugins/workflow/tooling.ts
// VERSION: 0.2.0
// START_MODULE_CONTRACT
//   PURPOSE: Provide work-item tooling handlers that wrap explicit workflow state operations with structured protocol-friendly responses.
//   SCOPE: work_item_open, work_item_list, and work_item_close tool definitions, explicit open-contract validation, round metadata and bounded recovery excerpt serialization, and deterministic execution responses.
//   DEPENDS: [src/plugins/workflow/state.ts]
//   LINKS: [M-WORKFLOW-TOOLING]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   WorkflowToolContext - Minimal execution context required by workflow tools.
//   WorkflowToolDefinition - Deterministic tool definition shape with execute handler.
//   createWorkItemOpenTool - Creates work_item_open tool wrapper around explicit openWorkItem contract.
//   createWorkItemListTool - Creates work_item_list tool wrapper with mode, round metadata, and recovery excerpts.
//   createWorkItemCloseTool - Creates work_item_close tool wrapper with ready_to_close gating responses.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.2.1 - Exposed bounded result excerpts in work-item serialization for blocked and needs_context recovery.]
//   LAST_CHANGE: [v0.2.0 - Required explicit work-item mode and requiredReviewers, and exposed review-round metadata in list/open tool output.]
//   LAST_CHANGE: [v0.1.1 - Wired work_item_list includeClosed flag into state listing options.]
//   LAST_CHANGE: [v0.1.0 - Added workflow core tooling handlers for open/list/close operations with structured results and VVOC headers.]
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

export type WorkflowToolContext = {
  sessionId: string;
};

export type WorkflowToolDefinition<TArgs, TResult> = {
  name: string;
  description: string;
  execute: (args: TArgs, context: WorkflowToolContext, store?: WorkItemStore) => TResult;
};

type OpenInputItem = {
  key?: unknown;
  title?: unknown;
  mode?: unknown;
  requiredReviewers?: unknown;
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

function coerceNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isWorkItemMode(value: unknown): value is WorkItemMode {
  return value === "implementation" || value === "review_only";
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
      message: "INVALID_INPUT: mode must be implementation or review_only",
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
//   PURPOSE: Build work_item_list handler that returns current work items and explicit review-round metadata.
//   INPUTS: { store: WorkItemStore - workflow in-memory store }
//   OUTPUTS: { WorkflowToolDefinition<ListArgs, unknown> - executable tool definition }
//   SIDE_EFFECTS: [none]
//   LINKS: [M-WORKFLOW-TOOLING, M-WORKFLOW-STATE]
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
      return {
        tool: "work_item_list",
        sessionId: context.sessionId,
        includeClosed,
        items: records.map(serializeWorkItem),
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
