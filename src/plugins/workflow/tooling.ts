// FILE: src/plugins/workflow/tooling.ts
// VERSION: 0.1.1
// START_MODULE_CONTRACT
//   PURPOSE: Provide work-item tooling handlers that wrap workflow state operations with structured protocol-friendly responses.
//   SCOPE: work_item_open, work_item_list, and work_item_close tool definitions and deterministic execution responses.
//   DEPENDS: [src/plugins/workflow/state.ts]
//   LINKS: [M-WORKFLOW-TOOLING]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   WorkflowToolContext - Minimal execution context required by workflow tools.
//   WorkflowToolDefinition - Deterministic tool definition shape with execute handler.
//   createWorkItemOpenTool - Creates work_item_open tool wrapper around openWorkItem.
//   createWorkItemListTool - Creates work_item_list tool wrapper around listWorkItems.
//   createWorkItemCloseTool - Creates work_item_close tool wrapper around closeWorkItem.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.1 - Wired work_item_list includeClosed flag into state listing options.]
//   LAST_CHANGE: [v0.1.0 - Added workflow core tooling handlers for open/list/close operations with structured results and VVOC headers.]
// END_CHANGE_SUMMARY

import {
  closeWorkItem,
  getReviewRound,
  listWorkItems,
  openWorkItem,
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
  key: string;
  title: string;
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

// START_CONTRACT: createWorkItemOpenTool
//   PURPOSE: Build work_item_open handler that supports deterministic batch idempotent open operations.
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
    description: "Open one or more workflow work items idempotently.",
    execute: (args, context, overrideStore) => {
      const inputItems = Array.isArray(args.items) ? args.items : [];

      const results = inputItems.map((item) => {
        const key = coerceNonEmptyString(item.key);
        const title = coerceNonEmptyString(item.title);
        if (!key || !title) {
          return {
            ok: false,
            errorCode: "INVALID_INPUT",
            message: "INVALID_INPUT: key and title must be non-empty strings",
          };
        }

        const opened = openWorkItem(overrideStore ?? store, {
          sessionId: context.sessionId,
          key,
          title,
        });

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
          state: opened.record.state,
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
//   PURPOSE: Build work_item_list handler that returns current work items and review metadata.
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
        items: records.map((record) => ({
          workItemId: record.workItemId,
          header: `VVOC_WORK_ITEM_ID: ${record.workItemId}`,
          key: record.key,
          title: record.title,
          state: record.state,
          specReviewCount: record.specReviewCount,
          codeReviewCount: record.codeReviewCount,
          reviewRound: getReviewRound(record),
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        })),
      };
    },
  };
}

// START_CONTRACT: createWorkItemCloseTool
//   PURPOSE: Build work_item_close handler that closes an existing work item.
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
    description: "Close a workflow work item by id.",
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
