// FILE: src/plugins/workflow.execution.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Plugin-level integration coverage proving the three reachable execution paths (native-package, provided-plan, conversation-scoped) run through the common registry with real delegated launch/result/acceptance hooks, dynamic review obligations, honest completion, and fail-closed persistence.
//   SCOPE: In-memory plugin domain integration with synthetic fixtures; no live model, SDK, or filesystem persistence writes.
//   DEPENDS: [bun:test, src/plugins/workflow/state.ts, src/plugins/workflow/delegated.ts, src/plugins/workflow/execution.ts, src/plugins/workflow/authority.ts, src/plugins/workflow/transactions.ts]
//   LINKS: [M-PLUGIN-WORKFLOW, M-WORKFLOW-EXECUTION, M-WORKFLOW-AUTHORITY, V-M-PLUGIN-WORKFLOW]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SESSION - Stable session identifier for integration fixtures.
//   WORKSPACE - Stable absolute workspace root.
//   store - Fresh work-item store created before each test.
//   task - Builds a valid task contract.
//   acceptTask - Drives one delegated task through launch, DONE, and controller acceptance.
//   registerConversation - Registers a conversation-scoped execution with one task.
//   callSequence - Monotonic suffix that keeps delegated callIDs unique per session.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-WORKFLOW-PLAN-INDEPENDENCE - Initial three-path integration coverage.]
// END_CHANGE_SUMMARY

import { beforeEach, describe, expect, test } from "bun:test";
import type { WorkflowTaskContract } from "../lib/workflow-contract.js";
import {
  appendExecutionWorkInStore,
  completeExecutionInStore,
  ensureNativeExecutions,
  findExecution,
  recordGenericReviewerResultInStore,
  registerExecutionInStore,
  startGenericCheckpointInStore,
} from "./workflow/execution.js";
import {
  applyDelegatedResult,
  beginDelegatedLaunch,
  decideDelegatedWorkItem,
} from "./workflow/delegated.js";
import { createWorkItemStore, type WorkItemStore } from "./workflow/state.js";
import { WorkflowTransactionQueue, runWorkflowTransaction } from "./workflow/transactions.js";

const SESSION = "session-workflow-execution";
const WORKSPACE = "/tmp/vvoc-workflow-execution";

let store: WorkItemStore;

beforeEach(() => {
  store = createWorkItemStore();
});

function task(overrides: Partial<WorkflowTaskContract> = {}): WorkflowTaskContract {
  return {
    taskId: "T-100",
    title: "Task one",
    goal: "Deliver task one.",
    acceptanceCriteria: ["Task one works."],
    verification: ["bun test src/lib/a.test.ts"],
    writeScope: ["src/lib/a.ts"],
    dependsOn: [],
    blockedBy: [],
    requiredReviewers: [],
    ...overrides,
  };
}

let callSequence = 0;

function acceptTask(workItemId: string): void {
  callSequence += 1;
  const callId = `call-${workItemId}-${callSequence}`;
  const launched = beginDelegatedLaunch(store, { sessionId: SESSION, workItemId, callId });
  expect(launched.ok).toBe(true);
  const applied = applyDelegatedResult(store, {
    sessionId: SESSION,
    workItemId,
    callId,
    resultStatus: "DONE",
  });
  expect(applied.ok).toBe(true);
  const decided = decideDelegatedWorkItem(store, {
    sessionId: SESSION,
    workItemId,
    attempt: 1,
    decision: "accept",
    rationale: "Verified result.",
    evidence: ["bun test src/lib/a.test.ts"],
  });
  expect(decided.ok).toBe(true);
}

function registerConversation(executionKey: string, tasks: WorkflowTaskContract[] = [task()]) {
  return registerExecutionInStore(store.getStoreData(), {
    sessionId: SESSION,
    workspaceRoot: WORKSPACE,
    executionKey,
    source: { kind: "conversation-scoped" },
    goal: "Deliver the requested change.",
    boundary: { files: ["src/lib/a.ts", "src/lib/b.ts"], directories: [] },
    tasks: tasks.map((contract) => ({ contract })),
  });
}

describe("conversation-scoped path", () => {
  test("one task with no reviewer completes as controller_accepted", () => {
    const registered = registerConversation("no-review");
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const binding = registered.execution.tasks.get("T-100")!;
    acceptTask(binding.workItemId);
    const completed = completeExecutionInStore(store.getStoreData(), {
      sessionId: SESSION,
      runId: registered.runId,
      rationale: "Single task accepted.",
      evidence: ["bun test src/lib/a.test.ts"],
    });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.reviewStatus).toBe("controller_accepted");
    expect(completed.execution.state).toBe("sealed");
  });

  test("an assigned reviewer is enforced and reported as independent review", () => {
    const registered = registerConversation("with-review", [task({ requiredReviewers: ["code"] })]);
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const binding = registered.execution.tasks.get("T-100")!;
    acceptTask(binding.workItemId);

    const blocked = completeExecutionInStore(store.getStoreData(), {
      sessionId: SESSION,
      runId: registered.runId,
      rationale: "Premature.",
      evidence: [],
    });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.errorCode).toBe("EXECUTION_INCOMPLETE");

    const started = startGenericCheckpointInStore(store.getStoreData(), {
      sessionId: SESSION,
      runId: registered.runId,
      checkpointId: "review-T-100",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const inProgress = recordGenericReviewerResultInStore(store.getStoreData(), {
      sessionId: SESSION,
      runId: registered.runId,
      checkpointId: "review-T-100",
      reviewer: "code",
      status: "PASS",
    });
    expect(inProgress.ok).toBe(true);
    if (!inProgress.ok) return;
    expect(inProgress.outcome).toBe("passed");

    const completed = completeExecutionInStore(store.getStoreData(), {
      sessionId: SESSION,
      runId: registered.runId,
      rationale: "Reviewed and accepted.",
      evidence: ["bun test src/lib/a.test.ts"],
    });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.reviewStatus).toBe("independently_reviewed");
  });

  test("a failed reviewer keeps completion blocked even when authority remains available", () => {
    const registered = registerConversation("failed-review", [
      task({ requiredReviewers: ["code"] }),
    ]);
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const binding = registered.execution.tasks.get("T-100")!;
    acceptTask(binding.workItemId);
    startGenericCheckpointInStore(store.getStoreData(), {
      sessionId: SESSION,
      runId: registered.runId,
      checkpointId: "review-T-100",
    });
    const failed = recordGenericReviewerResultInStore(store.getStoreData(), {
      sessionId: SESSION,
      runId: registered.runId,
      checkpointId: "review-T-100",
      reviewer: "code",
      status: "FAIL",
    });
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    expect(failed.outcome).toBe("failed");
    const completed = completeExecutionInStore(store.getStoreData(), {
      sessionId: SESSION,
      runId: registered.runId,
      rationale: "Try to finish anyway.",
      evidence: [],
    });
    expect(completed.ok).toBe(false);
    if (completed.ok) return;
    expect(completed.errorCode).toBe("EXECUTION_INCOMPLETE");
  });

  test("a later task addition invalidates stale final review coverage", async () => {
    const registered = registerConversation("stale-final", [task()]);
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const binding = registered.execution.tasks.get("T-100")!;
    acceptTask(binding.workItemId);

    // Assign and pass a final checkpoint covering only the first task.
    const execution = findExecution(store.getStoreData(), registered.runId)!;
    execution.checkpoints.set("FINAL-1", {
      checkpointId: "FINAL-1",
      contract: {
        checkpointId: "FINAL-1",
        kind: "final",
        covers: ["T-100"],
        scope: ["src/lib/a.ts"],
        requiredReviewers: ["code"],
        acceptance: [],
        verification: [],
        origin: "controller",
        dependsOn: [],
      },
      revision: 1,
      status: "passed",
      attempts: 1,
      passedRevision: 1,
    });

    const appended = appendExecutionWorkInStore(store.getStoreData(), {
      sessionId: SESSION,
      runId: registered.runId,
      amendmentId: "amend-1",
      rationale: "Add a second task.",
      tasks: [{ contract: task({ taskId: "T-200", writeScope: ["src/lib/b.ts"] }) }],
    });
    expect(appended.ok).toBe(true);

    const secondBinding = findExecution(store.getStoreData(), registered.runId)!.tasks.get(
      "T-200",
    )!;
    acceptTask(secondBinding.workItemId);

    const completed = completeExecutionInStore(store.getStoreData(), {
      sessionId: SESSION,
      runId: registered.runId,
      rationale: "Finish with stale final coverage.",
      evidence: [],
    });
    expect(completed.ok).toBe(false);
    if (completed.ok) return;
    expect(completed.errorCode).toBe("EXECUTION_INCOMPLETE");
  });
});

describe("provided-plan path", () => {
  test("keeps the provided source as an opaque reference and completes normally", () => {
    const registered = registerExecutionInStore(store.getStoreData(), {
      sessionId: SESSION,
      workspaceRoot: WORKSPACE,
      executionKey: "provided-plan",
      source: { kind: "provided-plan", reference: "docs/checklist.md" },
      goal: "Deliver the checklist.",
      boundary: { files: ["src/lib/a.ts"], directories: [] },
      tasks: [{ contract: task() }],
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    expect(registered.execution.source).toEqual({
      kind: "provided-plan",
      reference: "docs/checklist.md",
    });
    acceptTask(registered.execution.tasks.get("T-100")!.workItemId);
    const completed = completeExecutionInStore(store.getStoreData(), {
      sessionId: SESSION,
      runId: registered.runId,
      rationale: "Checklist delivered.",
      evidence: [],
    });
    expect(completed.ok).toBe(true);
  });
});

describe("native-package compatibility", () => {
  test("existing native runs materialize without changing native run identity", () => {
    const data = store.getStoreData();
    const now = new Date().toISOString();
    data.planRuns.set("run-native-integration", {
      runId: "run-native-integration",
      sessionId: SESSION,
      planPath: "/workspace/.vvoc/specs/2026-01-01-native/plan.xml",
      specPath: "/workspace/.vvoc/specs/2026-01-01-native/spec.xml",
      workspaceRoot: WORKSPACE,
      planSha256: "plan-hash",
      specSha256: "spec-hash",
      definition: {
        mode: "delegated",
        waves: ["WAVE-1"],
        tasks: [
          {
            taskId: "T-001",
            taskElement: "TASK-T-001",
            wave: "WAVE-1",
            writeScope: ["src/lib/a.ts"],
          },
        ],
        checkpoints: [
          {
            checkpointId: "CHECKPOINT-R-001",
            kind: "final",
            afterWave: "WAVE-1",
            covers: ["T-001"],
            scope: ["src/lib/a.ts"],
            reviewers: ["code"],
            acceptance: [],
            verification: [],
          },
        ],
      },
      registeredAt: now,
      status: "active",
      tasks: new Map([["T-001", { taskId: "T-001", workItemId: "wi-native" }]]),
      checkpoints: new Map(),
    });

    ensureNativeExecutions(data);
    const execution = findExecution(data, "run-native-integration");
    expect(execution?.runId).toBe("run-native-integration");
    expect(execution?.source.kind).toBe("native-package");
    if (execution?.source.kind !== "native-package") return;
    expect(execution.source.planSha256).toBe("plan-hash");
    expect(execution.tasks.get("T-001")?.workItemId).toBe("wi-native");
  });
});

describe("atomic persistence boundary", () => {
  test("a failed persist publishes nothing and preserves prior state", async () => {
    const registered = registerConversation("tx-fail");
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const queue = new WorkflowTransactionQueue();
    const live = store.getStoreData();
    const before = live.records.size;

    const result = await runWorkflowTransaction({
      queue,
      sessionId: SESSION,
      getData: () => live,
      persist: async () => ({ ok: false, error: "simulated disk failure" }),
      operation: (staged) => {
        const execution = staged.executions.get(registered.runId)!;
        execution.state = "sealed";
        return { result: "sealed" };
      },
    });

    expect(result.ok).toBe(false);
    expect(live.records.size).toBe(before);
    expect(findExecution(live, registered.runId)?.state).toBe("active");
  });
});
