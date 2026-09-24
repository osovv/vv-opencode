// FILE: src/plugins/workflow/transactions.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Deterministic tests for the atomic per-session transaction boundary: staged cloning, per-session serialization, fail-closed persistence, and synchronous publish after commit.
//   SCOPE: Pure transaction behavior with injected persistence; no real filesystem or SDK access.
//   DEPENDS: [bun:test, src/plugins/workflow/transactions.ts, src/plugins/workflow/state.ts]
//   LINKS: [M-PLUGIN-WORKFLOW, M-WORKFLOW-PERSISTENCE]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SESSION - Stable session identifier for transaction fixtures.
//   addStandaloneItem - Opens one standalone work item for staged-mutation fixtures.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-003 - Added staged-result guard coverage proving a rejected producer result persists/publishes nothing, leaves committed ledgers unchanged, and preserves queue serialization.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { createWorkItemStore, openWorkItemInStore } from "./state.js";
import {
  runWorkflowTransaction,
  WorkflowTransactionQueue,
  type WorkflowPersist,
} from "./transactions.js";

const SESSION = "session-transactions";

function addStandaloneItem(store: ReturnType<typeof createWorkItemStore>, key: string): void {
  const opened = store.openWorkItem({
    sessionId: SESSION,
    key,
    title: key,
    mode: "implementation",
    requiredReviewers: ["code"],
  });
  expect(opened.ok).toBe(true);
}

describe("workflow transactions", () => {
  test("does not mutate live state before persistence succeeds", async () => {
    const store = createWorkItemStore();
    const queue = new WorkflowTransactionQueue();
    const live = store.getStoreData();

    const result = await runWorkflowTransaction({
      queue,
      sessionId: SESSION,
      getData: () => live,
      persist: async () => {
        // During persistence the live store must still be untouched.
        expect(live.records.size).toBe(0);
        return { ok: true };
      },
      operation: (staged) => {
        const opened = openWorkItemInStore(staged, {
          sessionId: SESSION,
          key: "staged",
          title: "staged",
          mode: "implementation",
          requiredReviewers: ["code"],
        });
        expect(opened.ok).toBe(true);
        return { result: opened.ok ? opened.record.workItemId : "failed" };
      },
    });

    expect(result).toEqual({ ok: true, result: "wi-1" });
    expect(store.getWorkItem(SESSION, "wi-1")).toBeDefined();
  });

  test("fails closed and keeps the previous committed state when persistence fails", async () => {
    const store = createWorkItemStore();
    addStandaloneItem(store, "existing");
    const queue = new WorkflowTransactionQueue();
    const live = store.getStoreData();
    const before = live.records.size;
    let persistedStagedRecords = 0;

    const result = await runWorkflowTransaction({
      queue,
      sessionId: SESSION,
      getData: () => live,
      persist: async (_sessionId, staged) => {
        persistedStagedRecords = staged.records.size;
        return { ok: false, error: "disk full" };
      },
      operation: (staged) => {
        // Stage an extra record on the clone only.
        const template = [...staged.records.values()][0];
        staged.records.set(`${SESSION}::wi-999`, { ...template, workItemId: "wi-999" });
        return { result: "should-not-commit" };
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("disk full");
    expect(persistedStagedRecords).toBe(before + 1);
    expect(live.records.size).toBe(before);
    expect(store.getWorkItem(SESSION, "wi-999")).toBeUndefined();
  });

  test("runs queued operations for the same session strictly in order", async () => {
    const store = createWorkItemStore();
    const queue = new WorkflowTransactionQueue();
    const live = store.getStoreData();
    const order: number[] = [];

    const persist: WorkflowPersist = async () => {
      await Promise.resolve();
      return { ok: true };
    };

    const first = runWorkflowTransaction({
      queue,
      sessionId: SESSION,
      getData: () => live,
      persist,
      operation: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(1);
        return { result: 1 };
      },
    });
    const second = runWorkflowTransaction({
      queue,
      sessionId: SESSION,
      getData: () => live,
      persist,
      operation: () => {
        order.push(2);
        return { result: 2 };
      },
    });

    await Promise.all([first, second]);
    expect(order).toEqual([1, 2]);
  });

  test("aborts and publishes nothing when live state changes during the operation", async () => {
    const store = createWorkItemStore();
    addStandaloneItem(store, "existing");
    const queue = new WorkflowTransactionQueue();
    const live = store.getStoreData();
    const before = live.records.size;

    const result = await runWorkflowTransaction({
      queue,
      sessionId: SESSION,
      getData: () => live,
      persist: async () => ({ ok: true }),
      operation: (_staged) => {
        // Simulate a concurrent reducer that bypasses the store wrappers by
        // mutating live data directly (e.g. a hook-driven settlement).
        const template = [...live.records.values()][0]!;
        live.records.set(`${SESSION}::wi-99`, { ...template, workItemId: "wi-99" });
        return { result: "stale-clone" };
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("concurrent workflow mutation");
    // The concurrent mutation is preserved and the stale clone was not published.
    expect(live.records.size).toBe(before + 1);
    expect(live.records.get(`${SESSION}::wi-99`)).toBeDefined();
  });

  test("applies a custom commit callback instead of the staged snapshot when provided", async () => {
    const store = createWorkItemStore();
    addStandaloneItem(store, "custom");
    const queue = new WorkflowTransactionQueue();
    const live = store.getStoreData();
    const existing = live.records.get(`${SESSION}::wi-1`)!;

    const result = await runWorkflowTransaction({
      queue,
      sessionId: SESSION,
      getData: () => live,
      persist: async () => ({ ok: true }),
      operation: () => ({
        result: "ok",
        commit: (target) => {
          target.records.set(`${SESSION}::wi-1`, { ...existing, title: "committed title" });
        },
      }),
    });

    expect(result.ok).toBe(true);
    expect(store.getWorkItem(SESSION, "wi-1")?.title).toBe("committed title");
  });

  test("a rejected staged result persists and publishes nothing and preserves the queue", async () => {
    const store = createWorkItemStore();
    addStandaloneItem(store, "existing");
    const queue = new WorkflowTransactionQueue();
    const live = store.getStoreData();
    live.messageClaims.set("msg-1", {
      messageId: "msg-1",
      runId: "run-1",
      authorityId: "auth-1",
      claimedAt: "2026-01-01T00:00:00.000Z",
    });
    const beforeRecords = live.records.size;
    const beforeClaims = live.messageClaims.size;
    const beforeExecutions = live.executions.size;
    let persisted = false;
    let persistSawInvalid = false;

    const result = await runWorkflowTransaction({
      queue,
      sessionId: SESSION,
      getData: () => live,
      persist: async () => {
        persisted = true;
        persistSawInvalid = live.records.has(`${SESSION}::wi-999`);
        return { ok: true };
      },
      operation: (staged) => {
        const template = [...staged.records.values()][0]!;
        staged.records.set(`${SESSION}::wi-999`, { ...template, workItemId: "wi-999" });
        return { result: "would-publish" };
      },
      guardStagedResult: () => ({ ok: false, error: "RESULT_CONTRACT_INVALID: injected" }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.invalidResult).toBe(true);
    // The staged clone never reached persistence or live state, and every
    // committed ledger stayed exactly as it was.
    expect(persisted).toBe(false);
    expect(persistSawInvalid).toBe(false);
    expect(live.records.size).toBe(beforeRecords);
    expect(store.getWorkItem(SESSION, "wi-999")).toBeUndefined();
    expect(live.messageClaims.size).toBe(beforeClaims);
    expect(live.executions.size).toBe(beforeExecutions);

    // The per-session queue is still usable after a rejected staged result.
    const next = await runWorkflowTransaction({
      queue,
      sessionId: SESSION,
      getData: () => live,
      persist: async () => ({ ok: true }),
      operation: () => ({ result: "after" }),
      guardStagedResult: () => ({ ok: true }),
    });
    expect(next).toEqual({ ok: true, result: "after" });
  });
});
