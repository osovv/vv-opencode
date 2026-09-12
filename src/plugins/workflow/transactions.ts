// FILE: src/plugins/workflow/transactions.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Serialize workflow mutations per session and commit them atomically: clone the latest committed store inside the serialization boundary, stage every change on the clone, persist atomically, and only then synchronously publish the new live state.
//   SCOPE: Per-session promise queue, deep store-data cloning, injected/atomic persistence, synchronous publish of committed state, and fail-closed behavior when persistence fails. No work scheduling, task dispatch, or authority semantics of its own.
//   DEPENDS: [src/plugins/workflow/state.ts, src/plugins/workflow/checkpoints.ts, src/plugins/workflow/execution.ts, src/plugins/workflow/persistence.ts]
//   LINKS: [M-PLUGIN-WORKFLOW, M-WORKFLOW-STATE, M-WORKFLOW-PERSISTENCE, M-WORKFLOW-EXECUTION, V-M-PLUGIN-WORKFLOW]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   WorkflowPersistResult - Persistence outcome surfaced by an injected or default commit path.
//   WorkflowPersist - Persistence callback used by the transaction boundary.
//   WorkflowMutation - Staged result plus an optional synchronous publish step.
//   WorkflowTransactionResult - Committed result or a fail-closed persistence error.
//   WorkflowTransactionQueue - Per-session serial queue for mutating workflow operations.
//   cloneWorkItemStoreData - Deep clone of workflow store data for staging.
//   publishWorkItemStoreData - Synchronously replace live store data with committed staged data.
//   runWorkflowTransaction - Serialize, stage, persist, and publish one mutation per session.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-WORKFLOW-PLAN-INDEPENDENCE - Initial atomic per-session transaction boundary.]
// END_CHANGE_SUMMARY

import { cloneDelegatedPlanRun } from "./checkpoints.js";
import { cloneWorkflowExecution } from "./execution.js";
import { snapshotWorkflowStateChecked } from "./persistence.js";
import { cloneRecord, type WorkItemStoreData } from "./state.js";

export type WorkflowPersistResult = { ok: true } | { ok: false; error: string };

/** Persistence callback used by the transaction boundary. */
export type WorkflowPersist = (
  sessionId: string,
  data: WorkItemStoreData,
) => WorkflowPersistResult | Promise<WorkflowPersistResult>;

/** Staged result plus an optional synchronous publish step. */
export interface WorkflowMutation<T> {
  result: T;
  /**
   * Optional synchronous publish applied to the live data after persistence
   * succeeds. When omitted, the committed staged snapshot replaces live state.
   */
  commit?: (live: WorkItemStoreData) => void;
  /**
   * When true the staged mutation is discarded without persisting or
   * publishing; used for validation failures so nothing reaches disk.
   */
  skipPersist?: boolean;
}

export type WorkflowTransactionResult<T> = { ok: true; result: T } | { ok: false; error: string };

/** Deep clone of workflow store data so an operation cannot mutate live state before commit. */
export function cloneWorkItemStoreData(data: WorkItemStoreData): WorkItemStoreData {
  return {
    nextId: data.nextId,
    records: new Map([...data.records].map(([key, record]) => [key, cloneRecord(record)])),
    keyIndexBySession: new Map(
      [...data.keyIndexBySession].map(([sessionId, index]) => [sessionId, new Map(index)]),
    ),
    planRuns: new Map(
      [...data.planRuns].map(([runId, run]) => [runId, cloneDelegatedPlanRun(run)]),
    ),
    executions: new Map(
      [...data.executions].map(([runId, execution]) => [runId, cloneWorkflowExecution(execution)]),
    ),
    messageClaims: new Map([...data.messageClaims].map(([id, claim]) => [id, { ...claim }])),
  };
}

/** Synchronously replace live store data with committed staged data in place. */
export function publishWorkItemStoreData(live: WorkItemStoreData, staged: WorkItemStoreData): void {
  live.nextId = staged.nextId;
  live.records.clear();
  for (const [key, record] of staged.records) live.records.set(key, record);
  live.keyIndexBySession.clear();
  for (const [sessionId, index] of staged.keyIndexBySession) {
    live.keyIndexBySession.set(sessionId, new Map(index));
  }
  live.planRuns.clear();
  for (const [runId, run] of staged.planRuns) live.planRuns.set(runId, run);
  live.executions.clear();
  for (const [runId, execution] of staged.executions) live.executions.set(runId, execution);
  live.messageClaims.clear();
  for (const [id, claim] of staged.messageClaims) live.messageClaims.set(id, claim);
}

/** Per-session serial queue for mutating workflow operations. */
export class WorkflowTransactionQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  /** Run one task after every previously queued task for the same session completed. */
  run<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const tail = this.tails.get(sessionId) ?? Promise.resolve();
    const next = tail.then(task, task);
    this.tails.set(
      sessionId,
      next.catch(() => undefined),
    );
    return next;
  }
}

// START_CONTRACT: runWorkflowTransaction
//   PURPOSE: Serialize, stage, persist, and synchronously publish one workflow mutation.
//   INPUTS: { options: queue, sessionId, getData, persist?, operation }
//   OUTPUTS: { Promise<WorkflowTransactionResult<T>> - committed result or a fail-closed persistence error }
//   SIDE_EFFECTS: [Persists the staged snapshot; publishes live state only after persistence succeeds]
//   LINKS: [M-PLUGIN-WORKFLOW, M-WORKFLOW-PERSISTENCE]
// END_CONTRACT: runWorkflowTransaction
export async function runWorkflowTransaction<T>(options: {
  queue: WorkflowTransactionQueue;
  sessionId: string;
  getData: () => WorkItemStoreData;
  persist?: WorkflowPersist;
  operation: (staged: WorkItemStoreData) => WorkflowMutation<T> | Promise<WorkflowMutation<T>>;
}): Promise<WorkflowTransactionResult<T>> {
  const { queue, sessionId, getData } = options;
  return queue.run(sessionId, async () => {
    const staged = cloneWorkItemStoreData(getData());
    const mutation = await options.operation(staged);
    if (mutation.skipPersist === true) {
      // Validation failed: persist nothing and publish nothing.
      return { ok: true, result: mutation.result };
    }
    const persist = options.persist ?? snapshotWorkflowStateChecked;
    const persisted = await persist(sessionId, staged);
    if (!persisted.ok) {
      // Fail closed: the previous committed state stays observable and no
      // staged acceptance, obligation, or authority leaks into live state.
      return { ok: false, error: persisted.error };
    }
    const live = getData();
    if (mutation.commit) {
      mutation.commit(live);
    } else {
      publishWorkItemStoreData(live, staged);
    }
    return { ok: true, result: mutation.result };
  });
}
