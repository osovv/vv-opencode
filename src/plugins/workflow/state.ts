// FILE: src/plugins/workflow/state.ts
// VERSION: 0.1.2
// START_MODULE_CONTRACT
//   PURPOSE: Manage in-memory workflow work-item state scoped by session with idempotent open semantics.
//   SCOPE: Session-scoped work-item storage, id generation, idempotent open-by-key, state transitions, review counters, and close/list/get operations.
//   DEPENDS: [src/plugins/workflow/protocol.ts]
//   LINKS: [M-WORKFLOW-STATE]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   WorkItemState - Allowed lifecycle states for a tracked work item.
//   WorkItemRecord - Canonical in-memory state record for a work item.
//   WorkItemStore - Store interface exposing deterministic workflow state operations.
//   OpenWorkItemResult - Structured open operation result with idempotency and conflict signaling.
//   CloseWorkItemResult - Structured close operation result.
//   TransitionWorkItemStateResult - Structured transition operation result.
//   createWorkItemStore - Creates a new in-memory store instance.
//   openWorkItem - Opens an item idempotently by (sessionId, key).
//   getWorkItem - Fetches an item by session and work-item id.
//   listWorkItems - Lists session items with optional closed inclusion.
//   closeWorkItem - Closes an existing open item.
//   transitionWorkItemState - Applies deterministic state transitions and increments review counters.
//   getReviewRound - Computes review round as max(specReviewCount, codeReviewCount).
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.2 - Required actor metadata for tracked transitions so reviewer counters cannot be bypassed by actor-less updates.]
//   LAST_CHANGE: [v0.1.1 - Enforced deterministic transition invariants with sticky hard-stop states and optional closed-item listing support.]
//   LAST_CHANGE: [v0.1.0 - Added session-scoped in-memory workflow state store with idempotent open, transitions, close/list/get, and review-round helpers.]
// END_CHANGE_SUMMARY

import type { TrackedAgentName } from "./protocol.js";

export type WorkItemState =
  | "open"
  | "awaiting_implementer"
  | "awaiting_spec_review"
  | "awaiting_code_review"
  | "needs_context"
  | "blocked"
  | "ready_to_close"
  | "closed";

export type WorkItemRecord = {
  sessionId: string;
  workItemId: string;
  key: string;
  title: string;
  state: WorkItemState;
  specReviewCount: number;
  codeReviewCount: number;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
};

export type OpenWorkItemResult =
  | {
      ok: true;
      reused: boolean;
      record: WorkItemRecord;
      header: string;
    }
  | {
      ok: false;
      errorCode: "WORK_ITEM_KEY_CONFLICT";
      message: string;
      existingWorkItemId: string;
    };

export type CloseWorkItemResult =
  | {
      ok: true;
      record: WorkItemRecord;
      header: string;
    }
  | {
      ok: false;
      errorCode: "WORK_ITEM_NOT_FOUND" | "WORK_ITEM_ALREADY_CLOSED";
      message: string;
    };

export type TransitionWorkItemStateResult =
  | {
      ok: true;
      record: WorkItemRecord;
    }
  | {
      ok: false;
      errorCode:
        | "WORK_ITEM_NOT_FOUND"
        | "WORK_ITEM_ALREADY_CLOSED"
        | "INVALID_STATE_TRANSITION"
        | "MISSING_TRANSITION_ACTOR";
      message: string;
    };

type WorkItemStoreData = {
  nextId: number;
  records: Map<string, WorkItemRecord>;
  keyIndexBySession: Map<string, Map<string, string>>;
};

export type WorkItemStore = {
  openWorkItem: (input: { sessionId: string; key: string; title: string }) => OpenWorkItemResult;
  getWorkItem: (sessionId: string, workItemId: string) => WorkItemRecord | undefined;
  listWorkItems: (sessionId: string, options?: { includeClosed?: boolean }) => WorkItemRecord[];
  closeWorkItem: (sessionId: string, workItemId: string) => CloseWorkItemResult;
  transitionWorkItemState: (input: {
    sessionId: string;
    workItemId: string;
    state: WorkItemState;
    actor?: TrackedAgentName;
  }) => TransitionWorkItemStateResult;
  getReviewRound: (record: Pick<WorkItemRecord, "specReviewCount" | "codeReviewCount">) => number;
};

function createRecordLookupKey(sessionId: string, workItemId: string): string {
  return `${sessionId}::${workItemId}`;
}

function cloneRecord(record: WorkItemRecord): WorkItemRecord {
  return {
    ...record,
  };
}

function createHeader(workItemId: string): string {
  return `VVOC_WORK_ITEM_ID: ${workItemId}`;
}

function toIsoNow(): string {
  return new Date().toISOString();
}

function openWorkItemInStore(
  store: WorkItemStoreData,
  input: { sessionId: string; key: string; title: string },
): OpenWorkItemResult {
  const sessionIndex =
    store.keyIndexBySession.get(input.sessionId) ??
    (() => {
      const index = new Map<string, string>();
      store.keyIndexBySession.set(input.sessionId, index);
      return index;
    })();

  const existingId = sessionIndex.get(input.key);
  if (existingId) {
    const existing = store.records.get(createRecordLookupKey(input.sessionId, existingId));
    if (!existing) {
      sessionIndex.delete(input.key);
    } else if (existing.title !== input.title) {
      return {
        ok: false,
        errorCode: "WORK_ITEM_KEY_CONFLICT",
        message: `WORK_ITEM_KEY_CONFLICT: key ${input.key} is already associated with a different title`,
        existingWorkItemId: existing.workItemId,
      };
    } else {
      return {
        ok: true,
        reused: true,
        record: cloneRecord(existing),
        header: createHeader(existing.workItemId),
      };
    }
  }

  const workItemId = `wi-${store.nextId}`;
  store.nextId += 1;
  const now = toIsoNow();
  const record: WorkItemRecord = {
    sessionId: input.sessionId,
    workItemId,
    key: input.key,
    title: input.title,
    state: "open",
    specReviewCount: 0,
    codeReviewCount: 0,
    createdAt: now,
    updatedAt: now,
  };

  sessionIndex.set(input.key, workItemId);
  store.records.set(createRecordLookupKey(input.sessionId, workItemId), record);

  return {
    ok: true,
    reused: false,
    record: cloneRecord(record),
    header: createHeader(workItemId),
  };
}

function getWorkItemInStore(
  store: WorkItemStoreData,
  sessionId: string,
  workItemId: string,
): WorkItemRecord | undefined {
  const record = store.records.get(createRecordLookupKey(sessionId, workItemId));
  return record ? cloneRecord(record) : undefined;
}

function isTransitionAllowed(fromState: WorkItemState, toState: WorkItemState): boolean {
  const allowed: Record<WorkItemState, WorkItemState[]> = {
    open: ["awaiting_spec_review", "needs_context", "blocked"],
    awaiting_implementer: ["awaiting_spec_review", "needs_context", "blocked"],
    awaiting_spec_review: ["awaiting_code_review", "awaiting_implementer", "needs_context"],
    awaiting_code_review: ["ready_to_close", "awaiting_implementer", "needs_context"],
    ready_to_close: [],
    needs_context: [],
    blocked: [],
    closed: [],
  };
  return allowed[fromState].includes(toState);
}

function getAllowedActorForState(state: WorkItemState): TrackedAgentName | undefined {
  if (state === "open" || state === "awaiting_implementer") {
    return "vv-implementer";
  }
  if (state === "awaiting_spec_review") {
    return "vv-spec-reviewer";
  }
  if (state === "awaiting_code_review") {
    return "vv-code-reviewer";
  }
  return undefined;
}

function listWorkItemsInStore(
  store: WorkItemStoreData,
  sessionId: string,
  options: { includeClosed?: boolean } = {},
): WorkItemRecord[] {
  const includeClosed = options.includeClosed === true;
  return [...store.records.values()]
    .filter(
      (record) => record.sessionId === sessionId && (includeClosed || record.state !== "closed"),
    )
    .sort((left, right) => {
      const leftNumber = Number(left.workItemId.slice("wi-".length));
      const rightNumber = Number(right.workItemId.slice("wi-".length));
      return leftNumber - rightNumber;
    })
    .map((record) => cloneRecord(record));
}

function closeWorkItemInStore(
  store: WorkItemStoreData,
  sessionId: string,
  workItemId: string,
): CloseWorkItemResult {
  const lookupKey = createRecordLookupKey(sessionId, workItemId);
  const existing = store.records.get(lookupKey);
  if (!existing) {
    return {
      ok: false,
      errorCode: "WORK_ITEM_NOT_FOUND",
      message: `WORK_ITEM_NOT_FOUND: no work item ${workItemId} for session ${sessionId}`,
    };
  }

  if (existing.state === "closed") {
    return {
      ok: false,
      errorCode: "WORK_ITEM_ALREADY_CLOSED",
      message: `WORK_ITEM_ALREADY_CLOSED: ${workItemId} is already closed`,
    };
  }

  const now = toIsoNow();
  const updated: WorkItemRecord = {
    ...existing,
    state: "closed",
    closedAt: now,
    updatedAt: now,
  };
  store.records.set(lookupKey, updated);

  return {
    ok: true,
    record: cloneRecord(updated),
    header: createHeader(workItemId),
  };
}

function transitionWorkItemStateInStore(
  store: WorkItemStoreData,
  input: {
    sessionId: string;
    workItemId: string;
    state: WorkItemState;
    actor?: TrackedAgentName;
  },
): TransitionWorkItemStateResult {
  const lookupKey = createRecordLookupKey(input.sessionId, input.workItemId);
  const existing = store.records.get(lookupKey);
  if (!existing) {
    return {
      ok: false,
      errorCode: "WORK_ITEM_NOT_FOUND",
      message: `WORK_ITEM_NOT_FOUND: no work item ${input.workItemId} for session ${input.sessionId}`,
    };
  }

  if (existing.state === "closed") {
    return {
      ok: false,
      errorCode: "WORK_ITEM_ALREADY_CLOSED",
      message: `WORK_ITEM_ALREADY_CLOSED: ${input.workItemId} is already closed`,
    };
  }

  const allowedActor = getAllowedActorForState(existing.state);
  if (allowedActor && !input.actor) {
    return {
      ok: false,
      errorCode: "MISSING_TRANSITION_ACTOR",
      message: `MISSING_TRANSITION_ACTOR: state ${existing.state} requires actor metadata`,
    };
  }

  if (input.actor && allowedActor && input.actor !== allowedActor) {
    return {
      ok: false,
      errorCode: "INVALID_STATE_TRANSITION",
      message: `INVALID_STATE_TRANSITION: actor ${input.actor} is not allowed for state ${existing.state}`,
    };
  }

  if (!isTransitionAllowed(existing.state, input.state)) {
    return {
      ok: false,
      errorCode: "INVALID_STATE_TRANSITION",
      message: `INVALID_STATE_TRANSITION: cannot transition from ${existing.state} to ${input.state}`,
    };
  }

  const updated: WorkItemRecord = {
    ...existing,
    state: input.state,
    updatedAt: toIsoNow(),
    specReviewCount:
      input.actor === "vv-spec-reviewer" ? existing.specReviewCount + 1 : existing.specReviewCount,
    codeReviewCount:
      input.actor === "vv-code-reviewer" ? existing.codeReviewCount + 1 : existing.codeReviewCount,
  };

  store.records.set(lookupKey, updated);

  return {
    ok: true,
    record: cloneRecord(updated),
  };
}

// START_CONTRACT: getReviewRound
//   PURPOSE: Compute deterministic review round from reviewer counters.
//   INPUTS: { record: Pick<WorkItemRecord, "specReviewCount" | "codeReviewCount"> - review counters }
//   OUTPUTS: { number - max(specReviewCount, codeReviewCount) }
//   SIDE_EFFECTS: [none]
//   LINKS: [M-WORKFLOW-STATE]
// END_CONTRACT: getReviewRound
export function getReviewRound(
  record: Pick<WorkItemRecord, "specReviewCount" | "codeReviewCount">,
): number {
  return Math.max(record.specReviewCount, record.codeReviewCount);
}

// START_CONTRACT: createWorkItemStore
//   PURPOSE: Create a session-scoped in-memory work-item store with deterministic operation behavior.
//   INPUTS: { none }
//   OUTPUTS: { WorkItemStore - operation surface for open/get/list/close/transition operations }
//   SIDE_EFFECTS: [none]
//   LINKS: [M-WORKFLOW-STATE]
// END_CONTRACT: createWorkItemStore
export function createWorkItemStore(): WorkItemStore {
  const data: WorkItemStoreData = {
    nextId: 1,
    records: new Map(),
    keyIndexBySession: new Map(),
  };

  return {
    openWorkItem: (input) => openWorkItemInStore(data, input),
    getWorkItem: (sessionId, workItemId) => getWorkItemInStore(data, sessionId, workItemId),
    listWorkItems: (sessionId, options) => listWorkItemsInStore(data, sessionId, options),
    closeWorkItem: (sessionId, workItemId) => closeWorkItemInStore(data, sessionId, workItemId),
    transitionWorkItemState: (input) => transitionWorkItemStateInStore(data, input),
    getReviewRound,
  };
}

// START_CONTRACT: openWorkItem
//   PURPOSE: Open a work item idempotently by (sessionId, key) while enforcing key/title consistency.
//   INPUTS: { store: WorkItemStoreData - backing store, input: { sessionId, key, title } - open parameters }
//   OUTPUTS: { OpenWorkItemResult - success with record/header or WORK_ITEM_KEY_CONFLICT }
//   SIDE_EFFECTS: [Mutates in-memory work-item store]
//   LINKS: [M-WORKFLOW-STATE]
// END_CONTRACT: openWorkItem
export function openWorkItem(
  store: WorkItemStore,
  input: { sessionId: string; key: string; title: string },
): OpenWorkItemResult {
  return store.openWorkItem(input);
}

// START_CONTRACT: getWorkItem
//   PURPOSE: Return a work item by session and work-item id.
//   INPUTS: { store: WorkItemStoreData - backing store, sessionId: string - session scope, workItemId: string - work item id }
//   OUTPUTS: { WorkItemRecord | undefined - matching record when present }
//   SIDE_EFFECTS: [none]
//   LINKS: [M-WORKFLOW-STATE]
// END_CONTRACT: getWorkItem
export function getWorkItem(
  store: WorkItemStore,
  sessionId: string,
  workItemId: string,
): WorkItemRecord | undefined {
  return store.getWorkItem(sessionId, workItemId);
}

// START_CONTRACT: listWorkItems
//   PURPOSE: List session work items with optional closed-item inclusion.
//   INPUTS: { store: WorkItemStoreData - backing store, sessionId: string - session scope, options?: { includeClosed?: boolean } - list behavior options }
//   OUTPUTS: { WorkItemRecord[] - records sorted by numeric work-item id }
//   SIDE_EFFECTS: [none]
//   LINKS: [M-WORKFLOW-STATE]
// END_CONTRACT: listWorkItems
export function listWorkItems(
  store: WorkItemStore,
  sessionId: string,
  options?: { includeClosed?: boolean },
): WorkItemRecord[] {
  return store.listWorkItems(sessionId, options);
}

// START_CONTRACT: closeWorkItem
//   PURPOSE: Close an existing open work item and stamp closedAt.
//   INPUTS: { store: WorkItemStoreData - backing store, sessionId: string - session scope, workItemId: string - target id }
//   OUTPUTS: { CloseWorkItemResult - success with updated record/header or failure code }
//   SIDE_EFFECTS: [Mutates in-memory work-item store]
//   LINKS: [M-WORKFLOW-STATE]
// END_CONTRACT: closeWorkItem
export function closeWorkItem(
  store: WorkItemStore,
  sessionId: string,
  workItemId: string,
): CloseWorkItemResult {
  return store.closeWorkItem(sessionId, workItemId);
}

// START_CONTRACT: transitionWorkItemState
//   PURPOSE: Update work-item state deterministically and maintain reviewer counters.
//   INPUTS: { store: WorkItemStoreData - backing store, input: { sessionId, workItemId, state, actor? } - transition payload }
//   OUTPUTS: { TransitionWorkItemStateResult - success with updated record or failure code }
//   SIDE_EFFECTS: [Mutates in-memory work-item store]
//   LINKS: [M-WORKFLOW-STATE]
// END_CONTRACT: transitionWorkItemState
// START_BLOCK_TRANSITION_STATE
export function transitionWorkItemState(
  store: WorkItemStore,
  input: {
    sessionId: string;
    workItemId: string;
    state: WorkItemState;
    actor?: TrackedAgentName;
  },
): TransitionWorkItemStateResult {
  return store.transitionWorkItemState(input);
}
// END_BLOCK_TRANSITION_STATE
