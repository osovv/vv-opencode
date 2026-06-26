// FILE: src/plugins/workflow/state.ts
// VERSION: 0.3.0
// START_MODULE_CONTRACT
//   PURPOSE: Manage session-scoped workflow work-item state with explicit workflow intent, bounded result excerpts, and collect-all review rounds.
//   SCOPE: Session-scoped storage, id generation, idempotent open-by-key, explicit mode/reviewer metadata, bounded recovery excerpts, launch-time in-flight tracking, result-time round aggregation, close gating, and review-round helpers.
//   DEPENDS: [src/plugins/workflow/protocol.ts, src/plugins/workflow/transitions.ts]
//   LINKS: [M-WORKFLOW-STATE]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   WORK_ITEM_MODES - Canonical workflow intent values accepted by work_item_open.
//   WorkItemMode - Explicit workflow intent stored on each work item.
//   REVIEWER_ROLES - Canonical reviewer role IDs accepted by work_item_open.
//   ReviewerRole - Domain reviewer role IDs accepted by work_item_open.
//   ReviewerAgentName - Tracked reviewer subagent names mapped from reviewer roles.
//   ReviewerResultStatus - Reviewer result statuses that participate in round aggregation.
//   RESULT_EXCERPT_MAX_CHARS - Single deterministic maximum for bounded result excerpts.
//   WorkflowResultExcerpt - Bounded recovery excerpt captured from parsed body or normalized output.
//   createWorkflowResultExcerpt - Creates deterministic bounded result excerpts.
//   ReviewRoundResult - Stored result payload for one reviewer in a review round.
//   ReviewRound - Explicit current-round reviewer progress and results.
//   WorkItemState - Allowed lifecycle states for a tracked work item.
//   WorkItemRecord - Canonical in-memory and persisted state record for a work item.
//   OpenWorkItemInput - Required input fields for idempotent work-item creation.
//   OpenWorkItemResult - Success or validation result returned by work-item creation.
//   CloseWorkItemResult - Success or validation result returned by work-item close.
//   LaunchWorkItemErrorCode - Launch-time validation error codes for tracked agents.
//   BeginTrackedLaunchResult - Success or validation result returned when marking a tracked launch in flight.
//   TrackedResultStateErrorCode - Result-time state validation error codes for tracked outputs.
//   ApplyTrackedResultResult - Success or validation result returned when applying tracked output.
//   WorkItemStoreData - Snapshot shape used by workflow persistence.
//   WorkItemStore - Store interface exposing open, launch, result, list, close, and snapshot operations.
//   createWorkItemStore - Creates a new scoped in-memory work-item store.
//   openWorkItem - Creates or returns an existing work item by idempotency key.
//   beginTrackedLaunch - Validates tracked launch and marks reviewers in flight.
//   applyTrackedResult - Applies parsed tracked output and aggregates review rounds.
//   getWorkItem - Retrieves a work item by ID.
//   listWorkItems - Lists session work items with optional closed inclusion.
//   closeWorkItem - Closes only ready_to_close work items.
//   getReviewRound - Computes visible review round from current or completed round state.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.3.1 - Added bounded result excerpts to implementer hard-stop state and reviewer round results.]
//   LAST_CHANGE: [v0.3.0 - Replaced inferred sequential reviewer states with explicit work-item mode, reviewer intent, in-flight tracking, and collect-all review-round aggregation.]
//   LAST_CHANGE: [v0.2.0 - Allowed fresh review-only work items to transition directly from reviewer outcomes.]
//   LAST_CHANGE: [v0.1.2 - Required actor metadata for tracked transitions so reviewer counters cannot be bypassed by actor-less updates.]
//   LAST_CHANGE: [v0.1.1 - Enforced deterministic transition invariants with sticky hard-stop states and optional closed-item listing support.]
//   LAST_CHANGE: [v0.1.0 - Added session-scoped in-memory workflow state store with idempotent open, transitions, close/list/get, and review-round helpers.]
// END_CHANGE_SUMMARY

import type { ParsedResultBlock, TrackedAgentName } from "./protocol.js";
import {
  getAllowedNextAgents,
  getReviewerRoleForAgent,
  hasNeedsContextResult,
  isRoundSettled,
  resolveCompletedRoundState,
} from "./transitions.js";

export const WORK_ITEM_MODES = ["implementation", "review_only"] as const;
export type WorkItemMode = (typeof WORK_ITEM_MODES)[number];

export const REVIEWER_ROLES = ["spec", "code"] as const;
export type ReviewerRole = (typeof REVIEWER_ROLES)[number];

export type ReviewerAgentName = "vv-spec-reviewer" | "vv-code-reviewer";
export type ReviewerResultStatus = "PASS" | "FAIL" | "NEEDS_CONTEXT";

export const RESULT_EXCERPT_MAX_CHARS = 500;

export type WorkflowResultExcerptSource = "parsed_body" | "normalized_output";

export type WorkflowResultExcerpt = {
  source: WorkflowResultExcerptSource;
  text: string;
  truncated: boolean;
  originalLength: number;
  maxLength: number;
};

export type ReviewRoundResult = {
  reviewer: ReviewerRole;
  agent: ReviewerAgentName;
  status: ReviewerResultStatus;
  completedAt: string;
  resultExcerpt?: WorkflowResultExcerpt;
};

export type ReviewRound = {
  round: number;
  requiredReviewers: ReviewerRole[];
  pendingReviewers: ReviewerRole[];
  inFlightReviewers: ReviewerRole[];
  completedReviewers: ReviewerRole[];
  results: Partial<Record<ReviewerRole, ReviewRoundResult>>;
  status: "active" | "completed";
  createdAt: string;
  completedAt?: string;
};

export type WorkItemState =
  | "open"
  | "awaiting_implementer"
  | "awaiting_reviews"
  | "needs_context"
  | "blocked"
  | "ready_to_close"
  | "closed";

export type WorkItemRecord = {
  sessionId: string;
  workItemId: string;
  key: string;
  title: string;
  mode: WorkItemMode;
  requiredReviewers: ReviewerRole[];
  state: WorkItemState;
  currentRound?: ReviewRound;
  completedReviewRoundCount: number;
  specReviewCount: number;
  codeReviewCount: number;
  resultExcerpt?: WorkflowResultExcerpt;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
};

export type OpenWorkItemInput = {
  sessionId: string;
  key: string;
  title: string;
  mode: WorkItemMode;
  requiredReviewers: ReviewerRole[];
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
      errorCode: "INVALID_INPUT" | "WORK_ITEM_KEY_CONFLICT";
      message: string;
      existingWorkItemId?: string;
    };

export type CloseWorkItemResult =
  | {
      ok: true;
      record: WorkItemRecord;
      header: string;
    }
  | {
      ok: false;
      errorCode: "WORK_ITEM_NOT_FOUND" | "WORK_ITEM_ALREADY_CLOSED" | "READY_TO_CLOSE_REQUIRED";
      message: string;
    };

export type LaunchWorkItemErrorCode =
  | "WORK_ITEM_NOT_FOUND"
  | "WORK_ITEM_ALREADY_CLOSED"
  | "INVALID_NEXT_AGENT"
  | "REVIEW_ROUND_NOT_ACTIVE"
  | "REVIEWER_NOT_REQUIRED"
  | "REVIEWER_ALREADY_IN_FLIGHT"
  | "REVIEWER_ALREADY_COMPLETED"
  | "REVIEW_ROUND_NEEDS_CONTEXT";

export type BeginTrackedLaunchResult =
  | {
      ok: true;
      record: WorkItemRecord;
      reviewer?: ReviewerRole;
      reviewRound: number;
    }
  | {
      ok: false;
      errorCode: LaunchWorkItemErrorCode;
      message: string;
      allowedAgents: TrackedAgentName[];
    };

export type TrackedResultStateErrorCode =
  | "WORK_ITEM_NOT_FOUND"
  | "WORK_ITEM_ALREADY_CLOSED"
  | "INVALID_RESULT_AGENT"
  | "REVIEW_ROUND_NOT_ACTIVE"
  | "REVIEWER_NOT_REQUIRED"
  | "REVIEWER_NOT_IN_FLIGHT"
  | "REVIEWER_ALREADY_COMPLETED";

export type ApplyTrackedResultResult =
  | {
      ok: true;
      record: WorkItemRecord;
      fromState: WorkItemState;
      toState: WorkItemState;
      aggregateComplete: boolean;
    }
  | {
      ok: false;
      errorCode: TrackedResultStateErrorCode;
      message: string;
    };

export type WorkItemStoreData = {
  nextId: number;
  records: Map<string, WorkItemRecord>;
  keyIndexBySession: Map<string, Map<string, string>>;
};

export type WorkItemStore = {
  openWorkItem: (input: OpenWorkItemInput) => OpenWorkItemResult;
  beginTrackedLaunch: (input: {
    sessionId: string;
    workItemId: string;
    agent: TrackedAgentName;
  }) => BeginTrackedLaunchResult;
  applyTrackedResult: (input: {
    sessionId: string;
    workItemId: string;
    result: ParsedResultBlock;
    resultExcerpt?: WorkflowResultExcerpt;
  }) => ApplyTrackedResultResult;
  getWorkItem: (sessionId: string, workItemId: string) => WorkItemRecord | undefined;
  listWorkItems: (sessionId: string, options?: { includeClosed?: boolean }) => WorkItemRecord[];
  closeWorkItem: (sessionId: string, workItemId: string) => CloseWorkItemResult;
  getReviewRound: (
    record: Pick<WorkItemRecord, "completedReviewRoundCount" | "currentRound">,
  ) => number;
  /** Expose internal store data for persistence snapshotting. */
  getStoreData: () => WorkItemStoreData;
};

function createRecordLookupKey(sessionId: string, workItemId: string): string {
  return `${sessionId}::${workItemId}`;
}

function cloneExcerpt(excerpt: WorkflowResultExcerpt): WorkflowResultExcerpt {
  return { ...excerpt };
}

function cloneRoundResult(result: ReviewRoundResult): ReviewRoundResult {
  return {
    ...result,
    ...(result.resultExcerpt ? { resultExcerpt: cloneExcerpt(result.resultExcerpt) } : {}),
  };
}

function cloneRoundResults(
  results: Partial<Record<ReviewerRole, ReviewRoundResult>>,
): Partial<Record<ReviewerRole, ReviewRoundResult>> {
  return {
    ...(results.spec ? { spec: cloneRoundResult(results.spec) } : {}),
    ...(results.code ? { code: cloneRoundResult(results.code) } : {}),
  };
}

function cloneRound(round: ReviewRound): ReviewRound {
  return {
    ...round,
    requiredReviewers: [...round.requiredReviewers],
    pendingReviewers: [...round.pendingReviewers],
    inFlightReviewers: [...round.inFlightReviewers],
    completedReviewers: [...round.completedReviewers],
    results: cloneRoundResults(round.results),
  };
}

function cloneRecord(record: WorkItemRecord): WorkItemRecord {
  return {
    ...record,
    requiredReviewers: [...record.requiredReviewers],
    ...(record.currentRound ? { currentRound: cloneRound(record.currentRound) } : {}),
    ...(record.resultExcerpt ? { resultExcerpt: cloneExcerpt(record.resultExcerpt) } : {}),
  };
}

// START_CONTRACT: createWorkflowResultExcerpt
//   PURPOSE: Create a deterministic bounded recovery excerpt from tracked result text.
//   INPUTS: { text?: string - candidate text, source: WorkflowResultExcerptSource - origin of candidate text, maxLength?: number - optional deterministic cap for tests }
//   OUTPUTS: { WorkflowResultExcerpt | undefined - bounded excerpt with truncation metadata, or undefined when text is empty }
//   SIDE_EFFECTS: [none]
//   LINKS: [M-WORKFLOW-STATE]
// END_CONTRACT: createWorkflowResultExcerpt
export function createWorkflowResultExcerpt(options: {
  text?: string;
  source: WorkflowResultExcerptSource;
  maxLength?: number;
}): WorkflowResultExcerpt | undefined {
  const normalized = (options.text ?? "").replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return undefined;
  }

  const maxLength = Math.max(1, Math.floor(options.maxLength ?? RESULT_EXCERPT_MAX_CHARS));
  const truncated = normalized.length > maxLength;
  return {
    source: options.source,
    text: truncated ? normalized.slice(0, maxLength) : normalized,
    truncated,
    originalLength: normalized.length,
    maxLength,
  };
}

function createHeader(workItemId: string): string {
  return `VVOC_WORK_ITEM_ID: ${workItemId}`;
}

function toIsoNow(): string {
  return new Date().toISOString();
}

function isReviewerRole(value: unknown): value is ReviewerRole {
  return value === "spec" || value === "code";
}

function canonicalizeReviewers(value: readonly ReviewerRole[]): ReviewerRole[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (!value.every(isReviewerRole)) return undefined;
  const unique = new Set(value);
  if (unique.size !== value.length) return undefined;
  return [...value].sort((left, right) => {
    if (left === right) return 0;
    return left === "spec" ? -1 : 1;
  });
}

function sameReviewerSet(left: readonly ReviewerRole[], right: readonly ReviewerRole[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function createReviewRound(
  requiredReviewers: ReviewerRole[],
  round: number,
  now: string,
): ReviewRound {
  return {
    round,
    requiredReviewers: [...requiredReviewers],
    pendingReviewers: [...requiredReviewers],
    inFlightReviewers: [],
    completedReviewers: [],
    results: {},
    status: "active",
    createdAt: now,
  };
}

function createLaunchError(
  record: WorkItemRecord | undefined,
  errorCode: LaunchWorkItemErrorCode,
  message: string,
): BeginTrackedLaunchResult {
  return {
    ok: false,
    errorCode,
    message,
    allowedAgents: record ? getAllowedNextAgents(record) : [],
  };
}

function openWorkItemInStore(
  store: WorkItemStoreData,
  input: OpenWorkItemInput,
): OpenWorkItemResult {
  const requiredReviewers = canonicalizeReviewers(input.requiredReviewers);
  if (!requiredReviewers) {
    return {
      ok: false,
      errorCode: "INVALID_INPUT",
      message:
        "INVALID_INPUT: requiredReviewers must be a non-empty canonical set of spec/code reviewers",
    };
  }

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
    } else if (
      existing.title !== input.title ||
      existing.mode !== input.mode ||
      !sameReviewerSet(existing.requiredReviewers, requiredReviewers)
    ) {
      return {
        ok: false,
        errorCode: "WORK_ITEM_KEY_CONFLICT",
        message: `WORK_ITEM_KEY_CONFLICT: key ${input.key} is already associated with different workflow intent`,
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
    mode: input.mode,
    requiredReviewers,
    state: input.mode === "review_only" ? "awaiting_reviews" : "open",
    ...(input.mode === "review_only"
      ? { currentRound: createReviewRound(requiredReviewers, 1, now) }
      : {}),
    completedReviewRoundCount: 0,
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

  if (existing.state !== "ready_to_close") {
    return {
      ok: false,
      errorCode: "READY_TO_CLOSE_REQUIRED",
      message: `READY_TO_CLOSE_REQUIRED: ${workItemId} is ${existing.state} and cannot be closed`,
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

function beginTrackedLaunchInStore(
  store: WorkItemStoreData,
  input: { sessionId: string; workItemId: string; agent: TrackedAgentName },
): BeginTrackedLaunchResult {
  const lookupKey = createRecordLookupKey(input.sessionId, input.workItemId);
  const existing = store.records.get(lookupKey);
  if (!existing) {
    return createLaunchError(
      undefined,
      "WORK_ITEM_NOT_FOUND",
      `WORK_ITEM_NOT_FOUND: ${input.workItemId}`,
    );
  }
  if (existing.state === "closed") {
    return createLaunchError(
      existing,
      "WORK_ITEM_ALREADY_CLOSED",
      `WORK_ITEM_ALREADY_CLOSED: ${input.workItemId} is already closed`,
    );
  }

  const role = getReviewerRoleForAgent(input.agent);
  if (!role) {
    if (!getAllowedNextAgents(existing).includes(input.agent)) {
      return createLaunchError(
        existing,
        "INVALID_NEXT_AGENT",
        `INVALID_NEXT_AGENT: ${input.agent} is not allowed for ${existing.state}`,
      );
    }
    return {
      ok: true,
      record: cloneRecord(existing),
      reviewRound: getReviewRound(existing),
    };
  }

  const round = existing.currentRound;
  if (existing.state !== "awaiting_reviews" || !round || round.status !== "active") {
    return createLaunchError(
      existing,
      "REVIEW_ROUND_NOT_ACTIVE",
      `REVIEW_ROUND_NOT_ACTIVE: ${input.workItemId} has no active review round`,
    );
  }
  if (!round.requiredReviewers.includes(role)) {
    return createLaunchError(
      existing,
      "REVIEWER_NOT_REQUIRED",
      `REVIEWER_NOT_REQUIRED: ${role} is not required for ${input.workItemId}`,
    );
  }
  if (hasNeedsContextResult(round)) {
    return createLaunchError(
      existing,
      "REVIEW_ROUND_NEEDS_CONTEXT",
      `REVIEW_ROUND_NEEDS_CONTEXT: ${input.workItemId} is waiting for in-flight reviewers after NEEDS_CONTEXT`,
    );
  }
  if (round.inFlightReviewers.includes(role)) {
    return createLaunchError(
      existing,
      "REVIEWER_ALREADY_IN_FLIGHT",
      `REVIEWER_ALREADY_IN_FLIGHT: ${role} is already in flight for ${input.workItemId}`,
    );
  }
  if (round.completedReviewers.includes(role)) {
    return createLaunchError(
      existing,
      "REVIEWER_ALREADY_COMPLETED",
      `REVIEWER_ALREADY_COMPLETED: ${role} already completed for ${input.workItemId}`,
    );
  }
  if (!round.pendingReviewers.includes(role)) {
    return createLaunchError(
      existing,
      "INVALID_NEXT_AGENT",
      `INVALID_NEXT_AGENT: ${role} is not pending for ${input.workItemId}`,
    );
  }

  const updatedRound: ReviewRound = {
    ...round,
    pendingReviewers: round.pendingReviewers.filter((reviewer) => reviewer !== role),
    inFlightReviewers: [...round.inFlightReviewers, role],
  };
  const updated: WorkItemRecord = {
    ...existing,
    currentRound: updatedRound,
    updatedAt: toIsoNow(),
  };
  store.records.set(lookupKey, updated);

  return {
    ok: true,
    record: cloneRecord(updated),
    reviewer: role,
    reviewRound: updatedRound.round,
  };
}

function applyImplementerResult(
  existing: WorkItemRecord,
  result: ParsedResultBlock,
  now: string,
  resultExcerpt: WorkflowResultExcerpt | undefined,
): WorkItemRecord {
  if (result.status === "DONE" || result.status === "DONE_WITH_CONCERNS") {
    return {
      ...existing,
      state: "awaiting_reviews",
      currentRound: createReviewRound(
        existing.requiredReviewers,
        existing.completedReviewRoundCount + 1,
        now,
      ),
      updatedAt: now,
    };
  }
  if (result.status === "NEEDS_CONTEXT") {
    return {
      ...existing,
      state: "needs_context",
      ...(resultExcerpt ? { resultExcerpt } : {}),
      updatedAt: now,
    };
  }
  return {
    ...existing,
    state: "blocked",
    ...(resultExcerpt ? { resultExcerpt } : {}),
    updatedAt: now,
  };
}

type ApplyTrackedResultFailure = Extract<ApplyTrackedResultResult, { ok: false }>;

function applyReviewerResult(
  existing: WorkItemRecord,
  role: ReviewerRole,
  result: ParsedResultBlock,
  now: string,
  resultExcerpt: WorkflowResultExcerpt | undefined,
): ApplyTrackedResultFailure | WorkItemRecord {
  const round = existing.currentRound;
  if (existing.state !== "awaiting_reviews" || !round || round.status !== "active") {
    return {
      ok: false,
      errorCode: "REVIEW_ROUND_NOT_ACTIVE",
      message: `REVIEW_ROUND_NOT_ACTIVE: ${existing.workItemId} has no active review round`,
    };
  }
  if (!round.requiredReviewers.includes(role)) {
    return {
      ok: false,
      errorCode: "REVIEWER_NOT_REQUIRED",
      message: `REVIEWER_NOT_REQUIRED: ${role} is not required for ${existing.workItemId}`,
    };
  }
  if (round.completedReviewers.includes(role) || round.results[role]) {
    return {
      ok: false,
      errorCode: "REVIEWER_ALREADY_COMPLETED",
      message: `REVIEWER_ALREADY_COMPLETED: ${role} already completed for ${existing.workItemId}`,
    };
  }
  if (!round.inFlightReviewers.includes(role)) {
    return {
      ok: false,
      errorCode: "REVIEWER_NOT_IN_FLIGHT",
      message: `REVIEWER_NOT_IN_FLIGHT: ${role} was not in flight for ${existing.workItemId}`,
    };
  }

  const status = result.status as ReviewerResultStatus;
  const reviewerResult: ReviewRoundResult = {
    reviewer: role,
    agent: result.agent as ReviewerAgentName,
    status,
    completedAt: now,
    ...(resultExcerpt ? { resultExcerpt } : {}),
  };
  let updatedRound: ReviewRound = {
    ...round,
    inFlightReviewers: round.inFlightReviewers.filter((reviewer) => reviewer !== role),
    completedReviewers: [...round.completedReviewers, role],
    results: {
      ...round.results,
      [role]: reviewerResult,
    },
  };

  const aggregateComplete = isRoundSettled(updatedRound);
  const nextState = aggregateComplete
    ? resolveCompletedRoundState(existing, updatedRound)
    : "awaiting_reviews";
  if (aggregateComplete) {
    updatedRound = {
      ...updatedRound,
      status: "completed",
      completedAt: now,
    };
  }

  return {
    ...existing,
    state: nextState,
    currentRound: updatedRound,
    completedReviewRoundCount: aggregateComplete
      ? Math.max(existing.completedReviewRoundCount, updatedRound.round)
      : existing.completedReviewRoundCount,
    specReviewCount: role === "spec" ? existing.specReviewCount + 1 : existing.specReviewCount,
    codeReviewCount: role === "code" ? existing.codeReviewCount + 1 : existing.codeReviewCount,
    updatedAt: now,
  };
}

function applyTrackedResultInStore(
  store: WorkItemStoreData,
  input: {
    sessionId: string;
    workItemId: string;
    result: ParsedResultBlock;
    resultExcerpt?: WorkflowResultExcerpt;
  },
): ApplyTrackedResultResult {
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

  const now = toIsoNow();
  const fromState = existing.state;
  let updated: WorkItemRecord | ApplyTrackedResultResult;
  const role = getReviewerRoleForAgent(input.result.agent);
  if (!role) {
    if (
      existing.mode !== "implementation" ||
      (existing.state !== "open" && existing.state !== "awaiting_implementer")
    ) {
      return {
        ok: false,
        errorCode: "INVALID_RESULT_AGENT",
        message: `INVALID_RESULT_AGENT: ${input.result.agent} cannot produce a result for ${existing.state}`,
      };
    }
    updated = applyImplementerResult(existing, input.result, now, input.resultExcerpt);
  } else {
    updated = applyReviewerResult(existing, role, input.result, now, input.resultExcerpt);
  }

  if ("ok" in updated && updated.ok === false) {
    return updated;
  }

  store.records.set(lookupKey, updated);
  return {
    ok: true,
    record: cloneRecord(updated),
    fromState,
    toState: updated.state,
    aggregateComplete:
      role !== undefined &&
      updated.currentRound?.status === "completed" &&
      fromState === "awaiting_reviews",
  };
}

// START_CONTRACT: getReviewRound
//   PURPOSE: Compute visible review round from current explicit round or completed round count.
//   INPUTS: { record: Pick<WorkItemRecord, "completedReviewRoundCount" | "currentRound"> - review-round metadata }
//   OUTPUTS: { number - current active/completed round number or completed round count }
//   SIDE_EFFECTS: [none]
//   LINKS: [M-WORKFLOW-STATE]
// END_CONTRACT: getReviewRound
export function getReviewRound(
  record: Pick<WorkItemRecord, "completedReviewRoundCount" | "currentRound">,
): number {
  return record.currentRound?.round ?? record.completedReviewRoundCount;
}

// START_CONTRACT: createWorkItemStore
//   PURPOSE: Create a session-scoped in-memory work-item store, optionally hydrated from persisted data.
//   INPUTS: { hydrateData?: WorkItemStoreData | null - optional persisted store data to restore }
//   OUTPUTS: { WorkItemStore - operation surface for open/get/list/close/launch/result operations }
//   SIDE_EFFECTS: [none]
//   LINKS: [M-WORKFLOW-STATE, M-WORKFLOW-PERSISTENCE]
// END_CONTRACT: createWorkItemStore
export function createWorkItemStore(hydrateData?: WorkItemStoreData | null): WorkItemStore {
  const data: WorkItemStoreData = hydrateData
    ? {
        nextId: hydrateData.nextId,
        records: new Map(hydrateData.records),
        keyIndexBySession: new Map(hydrateData.keyIndexBySession),
      }
    : {
        nextId: 1,
        records: new Map(),
        keyIndexBySession: new Map(),
      };

  return {
    openWorkItem: (input) => openWorkItemInStore(data, input),
    beginTrackedLaunch: (input) => beginTrackedLaunchInStore(data, input),
    applyTrackedResult: (input) => applyTrackedResultInStore(data, input),
    getWorkItem: (sessionId, workItemId) => getWorkItemInStore(data, sessionId, workItemId),
    listWorkItems: (sessionId, options) => listWorkItemsInStore(data, sessionId, options),
    closeWorkItem: (sessionId, workItemId) => closeWorkItemInStore(data, sessionId, workItemId),
    getReviewRound,
    getStoreData: () => data,
  };
}

// START_CONTRACT: openWorkItem
//   PURPOSE: Open a work item idempotently by (sessionId, key) while enforcing explicit workflow intent consistency.
//   INPUTS: { store: WorkItemStore - backing store, input: OpenWorkItemInput - open parameters with mode and requiredReviewers }
//   OUTPUTS: { OpenWorkItemResult - success with record/header or deterministic failure }
//   SIDE_EFFECTS: [Mutates in-memory work-item store]
//   LINKS: [M-WORKFLOW-STATE]
// END_CONTRACT: openWorkItem
export function openWorkItem(store: WorkItemStore, input: OpenWorkItemInput): OpenWorkItemResult {
  return store.openWorkItem(input);
}

// START_CONTRACT: beginTrackedLaunch
//   PURPOSE: Validate a tracked launch and mark reviewer launches in flight for the current round.
//   INPUTS: { store: WorkItemStore - backing store, input: { sessionId, workItemId, agent } - launch payload }
//   OUTPUTS: { BeginTrackedLaunchResult - success with updated record or launch rejection }
//   SIDE_EFFECTS: [Mutates in-memory work-item store for reviewer launches]
//   LINKS: [M-WORKFLOW-STATE, M-WORKFLOW-TRANSITIONS]
// END_CONTRACT: beginTrackedLaunch
export function beginTrackedLaunch(
  store: WorkItemStore,
  input: { sessionId: string; workItemId: string; agent: TrackedAgentName },
): BeginTrackedLaunchResult {
  return store.beginTrackedLaunch(input);
}

// START_CONTRACT: applyTrackedResult
//   PURPOSE: Apply parsed tracked output, update explicit review rounds, and aggregate lifecycle state when rounds settle.
//   INPUTS: { store: WorkItemStore - backing store, input: { sessionId, workItemId, result } - parsed result payload }
//   OUTPUTS: { ApplyTrackedResultResult - success with updated record or result-state failure }
//   SIDE_EFFECTS: [Mutates in-memory work-item store]
//   LINKS: [M-WORKFLOW-STATE, M-WORKFLOW-TRANSITIONS]
// END_CONTRACT: applyTrackedResult
export function applyTrackedResult(
  store: WorkItemStore,
  input: {
    sessionId: string;
    workItemId: string;
    result: ParsedResultBlock;
    resultExcerpt?: WorkflowResultExcerpt;
  },
): ApplyTrackedResultResult {
  return store.applyTrackedResult(input);
}

// START_CONTRACT: getWorkItem
//   PURPOSE: Return a work item by session and work-item id.
//   INPUTS: { store: WorkItemStore - backing store, sessionId: string - session scope, workItemId: string - work item id }
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
//   INPUTS: { store: WorkItemStore - backing store, sessionId: string - session scope, options?: { includeClosed?: boolean } - list behavior options }
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
//   PURPOSE: Close an existing ready_to_close work item and stamp closedAt.
//   INPUTS: { store: WorkItemStore - backing store, sessionId: string - session scope, workItemId: string - target id }
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
