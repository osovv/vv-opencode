// FILE: src/plugins/workflow/execution.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Deterministic tests for the common execution registry: source-independent registration, idempotent reuse, source-switch rejection, atomic batch amendments, exact adoption, native compatibility migration, replacement/split lineage with inherited budgets, and read-only views.
//   SCOPE: In-memory registry behavior only; no filesystem persistence or SDK access.
//   DEPENDS: [bun:test, src/plugins/workflow/execution.ts, src/plugins/workflow/state.ts, src/plugins/workflow/delegated.ts]
//   LINKS: [M-WORKFLOW-EXECUTION, M-WORKFLOW-CONTRACT]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SESSION - Stable session identifier for execution fixtures.
//   WORKSPACE - Stable absolute workspace root for execution fixtures.
//   store - Fresh work-item store created before each test.
//   task - Builds a valid task contract with overridable fields.
//   register - Registers a conversation-scoped execution with one task.
//   acceptSequence - Monotonic suffix that keeps delegated acceptance callIDs unique.
//   driveToAccepted - Drives one delegated task through launch, DONE, and controller acceptance.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-WORKFLOW-PLAN-INDEPENDENCE - Initial execution registry coverage.]
// END_CHANGE_SUMMARY

import { beforeEach, describe, expect, test } from "bun:test";
import type { WorkflowTaskContract } from "../../lib/workflow-contract.js";
import {
  applyDelegatedResultInStore,
  beginDelegatedLaunchInStore,
  decideDelegatedWorkItemInStore,
  delegatedAttemptBudget,
} from "./delegated.js";
import {
  appendExecutionWorkInStore,
  completeExecutionInStore,
  ensureNativeExecutions,
  findExecution,
  findExecutionByKey,
  getExecutionView,
  isTaskLaunchableInStore,
  recordGenericReviewerResultInStore,
  registerExecutionInStore,
  splitExecutionTaskInStore,
  startGenericCheckpointInStore,
} from "./execution.js";
import { createWorkItemStore, type WorkItemStore } from "./state.js";

const SESSION = "session-execution";
const WORKSPACE = "/tmp/vvoc-execution-workspace";

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

function register(executionKey: string, tasks: WorkflowTaskContract[] = [task()]) {
  const data = store.getStoreData();
  return registerExecutionInStore(data, {
    sessionId: SESSION,
    workspaceRoot: WORKSPACE,
    executionKey,
    source: { kind: "conversation-scoped" },
    goal: "Deliver the requested change.",
    boundary: { files: ["src/lib/a.ts", "src/lib/b.ts"], directories: [] },
    tasks: tasks.map((contract) => ({ contract })),
  });
}

let acceptSequence = 0;

function driveToAccepted(workItemId: string): void {
  acceptSequence += 1;
  const callId = `call-accept-${workItemId}-${acceptSequence}`;
  const data = store.getStoreData();
  const launched = beginDelegatedLaunchInStore(data, { sessionId: SESSION, workItemId, callId });
  expect(launched.ok).toBe(true);
  const applied = applyDelegatedResultInStore(data, {
    sessionId: SESSION,
    workItemId,
    callId,
    resultStatus: "DONE",
  });
  expect(applied.ok).toBe(true);
  const decided = decideDelegatedWorkItemInStore(data, {
    sessionId: SESSION,
    workItemId,
    attempt: 1,
    decision: "accept",
    rationale: "Accepted.",
    evidence: ["bun test src/lib/a.test.ts"],
  });
  expect(decided.ok).toBe(true);
}

describe("execution registration", () => {
  test("registers a conversation-scoped execution with a bound delegated task", () => {
    const result = register("proto");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reused).toBe(false);
    expect(result.execution.state).toBe("active");
    expect(result.execution.revision).toBe(1);
    const binding = result.execution.tasks.get("T-100");
    expect(binding?.status).toBe("pending");
    expect(binding?.workItemId).toBeTruthy();
  });

  test("is idempotent for the same key and source", () => {
    const first = register("idem");
    const second = register("idem");
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.runId).toBe(first.runId);
    expect(second.reused).toBe(true);
  });

  test("rejects a source switch under the same execution key", () => {
    expect(register("switch").ok).toBe(true);
    const data = store.getStoreData();
    const switched = registerExecutionInStore(data, {
      sessionId: SESSION,
      workspaceRoot: WORKSPACE,
      executionKey: "switch",
      source: { kind: "provided-plan", reference: "docs/checklist.md" },
      goal: "Deliver the requested change.",
      boundary: { files: ["src/lib/a.ts"], directories: [] },
      tasks: [{ contract: task() }],
    });
    expect(switched.ok).toBe(false);
    if (switched.ok) return;
    expect(switched.errorCode).toBe("SOURCE_SWITCH");
  });

  test("registers a deterministic single-task checkpoint for a non-empty reviewer set", () => {
    const result = register("reviewed", [task({ requiredReviewers: ["code"] })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const checkpoint = result.execution.checkpoints.get("review-T-100");
    expect(checkpoint?.contract.requiredReviewers).toEqual(["code"]);
    expect(checkpoint?.contract.covers).toEqual(["T-100"]);
  });

  test("registers a provided-plan source without converting or executing it", () => {
    const data = store.getStoreData();
    const result = registerExecutionInStore(data, {
      sessionId: SESSION,
      workspaceRoot: WORKSPACE,
      executionKey: "provided",
      source: { kind: "provided-plan", reference: "docs/checklist.md" },
      goal: "Deliver the checklist.",
      boundary: { files: ["src/lib/a.ts"], directories: [] },
      tasks: [{ contract: task() }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.execution.source.kind).toBe("provided-plan");
  });
});

describe("execution amendments", () => {
  test("appends a second task without replaying or losing prior acceptance", () => {
    const registered = register("append");
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const data = store.getStoreData();
    const firstWorkItemId = registered.execution.tasks.get("T-100")!.workItemId;
    const record = data.records.get(`${SESSION}::${firstWorkItemId}`)!;
    record.state = "closed";
    record.delegated = {
      ...record.delegated!,
      acceptances: [
        {
          attempt: 1,
          decisionId: "decision-1",
          acceptedAt: new Date().toISOString(),
          rationale: "Accepted.",
          evidence: ["bun test"],
        },
      ],
    };

    const appended = appendExecutionWorkInStore(data, {
      sessionId: SESSION,
      runId: registered.runId,
      amendmentId: "amend-1",
      rationale: "Add wiring task.",
      tasks: [
        {
          contract: task({
            taskId: "T-200",
            writeScope: ["src/lib/b.ts"],
            dependsOn: ["T-100"],
          }),
        },
      ],
    });
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    expect(appended.revision).toBe(2);
    expect(appended.execution.tasks.has("T-200")).toBe(true);
    const preserved = data.records.get(`${SESSION}::${firstWorkItemId}`)!;
    expect(preserved.delegated?.acceptances).toHaveLength(1);
    expect(appended.execution.lineage.at(-1)?.kind).toBe("amendment");
  });

  test("rolls back the entire batch when a dependency cycle is declared", () => {
    const registered = register("cycle");
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const data = store.getStoreData();
    const before = data.records.size;
    const appended = appendExecutionWorkInStore(data, {
      sessionId: SESSION,
      runId: registered.runId,
      amendmentId: "amend-cycle",
      rationale: "Bad batch.",
      tasks: [
        { contract: task({ taskId: "T-201", writeScope: ["src/lib/b.ts"], dependsOn: ["T-202"] }) },
        { contract: task({ taskId: "T-202", writeScope: ["src/lib/b.ts"], dependsOn: ["T-201"] }) },
      ],
    });
    expect(appended.ok).toBe(false);
    if (appended.ok) return;
    expect(appended.errorCode).toBe("CYCLIC_DEPENDENCY");
    expect(data.records.size).toBe(before);
    expect(findExecution(data, registered.runId)!.tasks.has("T-201")).toBe(false);
  });

  test("rejects additions to a sealed execution", () => {
    const registered = register("sealed");
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const execution = findExecution(store.getStoreData(), registered.runId)!;
    execution.state = "sealed";
    const appended = appendExecutionWorkInStore(store.getStoreData(), {
      sessionId: SESSION,
      runId: registered.runId,
      amendmentId: "amend-sealed",
      rationale: "Too late.",
      tasks: [{ contract: task({ taskId: "T-300", writeScope: ["src/lib/b.ts"] }) }],
    });
    expect(appended.ok).toBe(false);
    if (appended.ok) return;
    expect(appended.errorCode).toBe("EXECUTION_SEALED");
  });

  test("rejects a new checkpoint that retroactively covers a launched task", () => {
    const registered = register("barrier");
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const data = store.getStoreData();
    const binding = findExecution(data, registered.runId)!.tasks.get("T-100")!;
    binding.status = "launched";
    const appended = appendExecutionWorkInStore(data, {
      sessionId: SESSION,
      runId: registered.runId,
      amendmentId: "amend-barrier",
      rationale: "Late review.",
      checkpoints: [
        {
          checkpointId: "C-100",
          kind: "milestone",
          covers: ["T-100"],
          scope: ["src/lib/a.ts"],
          requiredReviewers: ["code"],
          acceptance: [],
          verification: [],
          origin: "controller",
          dependsOn: [],
        },
      ],
    });
    expect(appended.ok).toBe(false);
    if (appended.ok) return;
    expect(appended.errorCode).toBe("RETROACTIVE_BARRIER");
  });
});

describe("exact adoption", () => {
  test("adopts a compatible unbound work item without resetting its counters", () => {
    const opened = store.openWorkItem({
      sessionId: SESSION,
      key: "standalone-task",
      title: "Standalone",
      mode: "delegated",
      requiredReviewers: [],
      writeScope: ["src/lib/a.ts"],
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const data = store.getStoreData();
    const before = data.records.size;
    const result = registerExecutionInStore(data, {
      sessionId: SESSION,
      workspaceRoot: WORKSPACE,
      executionKey: "adopt",
      source: { kind: "conversation-scoped" },
      goal: "Adopt existing work.",
      boundary: { files: ["src/lib/a.ts"], directories: [] },
      tasks: [{ contract: task(), workItemId: opened.record.workItemId }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.execution.tasks.get("T-100")?.workItemId).toBe(opened.record.workItemId);
    expect(data.records.size).toBe(before);
  });

  test("rejects adoption when the declared scope does not match", () => {
    const opened = store.openWorkItem({
      sessionId: SESSION,
      key: "standalone-mismatch",
      title: "Standalone",
      mode: "delegated",
      requiredReviewers: [],
      writeScope: ["src/lib/b.ts"],
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const result = registerExecutionInStore(store.getStoreData(), {
      sessionId: SESSION,
      workspaceRoot: WORKSPACE,
      executionKey: "adopt-mismatch",
      source: { kind: "conversation-scoped" },
      goal: "Adopt existing work.",
      boundary: { files: ["src/lib/a.ts"], directories: [] },
      tasks: [{ contract: task(), workItemId: opened.record.workItemId }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe("ADOPTION_MISMATCH");
  });
});

describe("native compatibility migration", () => {
  test("materializes a registry entry for an existing native run with the same run id", () => {
    const data = store.getStoreData();
    const now = new Date().toISOString();
    data.planRuns.set("run-native-1", {
      runId: "run-native-1",
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
            title: "Native task",
            acceptance: ["Native acceptance"],
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
            acceptance: ["Reviewed"],
            verification: ["bun test"],
          },
        ],
      },
      registeredAt: now,
      status: "active",
      tasks: new Map([["T-001", { taskId: "T-001", workItemId: "wi-native" }]]),
      checkpoints: new Map(),
    });

    ensureNativeExecutions(data);
    const execution = findExecution(data, "run-native-1");
    expect(execution?.source.kind).toBe("native-package");
    expect(execution?.tasks.get("T-001")?.workItemId).toBe("wi-native");
    expect(execution?.tasks.get("T-001")?.contract.acceptanceCriteria).toEqual([
      "Native acceptance",
    ]);

    // Native executions never accept the generic append path.
    const appended = appendExecutionWorkInStore(data, {
      sessionId: SESSION,
      runId: "run-native-1",
      amendmentId: "native-append",
      rationale: "Attempt generic append onto a native run.",
      tasks: [{ contract: task({ taskId: "T-300", writeScope: ["src/lib/a.ts"] }) }],
    });
    expect(appended.ok).toBe(false);
    if (appended.ok) return;
    expect(appended.errorCode).toBe("NATIVE_REPLACEMENT");
  });
});

describe("replacement and split lineage", () => {
  test("splits an exhausted task without granting the descendants fresh attempts", () => {
    const registered = register("split");
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const data = store.getStoreData();
    const parentBinding = registered.execution.tasks.get("T-100")!;
    const parentRecord = data.records.get(`${SESSION}::${parentBinding.workItemId}`)!;
    const now = new Date().toISOString();
    parentRecord.delegated = {
      ...parentRecord.delegated!,
      attempts: [
        {
          attempt: 1,
          callId: "call-1",
          launchedAt: now,
          status: "completed",
          resultStatus: "BLOCKED",
          completedAt: now,
        },
        {
          attempt: 2,
          callId: "call-2",
          launchedAt: now,
          status: "completed",
          resultStatus: "BLOCKED",
          completedAt: now,
        },
      ],
    };

    const split = splitExecutionTaskInStore(data, {
      sessionId: SESSION,
      runId: registered.runId,
      parentTaskId: "T-100",
      amendmentId: "split-1",
      rationale: "Split the exhausted task.",
      children: [task({ taskId: "T-101" }), task({ taskId: "T-102" })],
    });
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(split.childTaskIds).toEqual(["T-101", "T-102"]);
    expect(split.execution.tasks.get("T-100")?.status).toBe("superseded");
    expect(split.execution.tasks.get("T-100")?.supersededBy).toEqual(["T-101", "T-102"]);
    expect(split.execution.lineage.at(-1)?.kind).toBe("split");

    for (const childId of split.childTaskIds) {
      const childBinding = split.execution.tasks.get(childId)!;
      const childRecord = data.records.get(`${SESSION}::${childBinding.workItemId}`)!;
      expect(childRecord.delegated?.attempts).toHaveLength(2);
      expect(delegatedAttemptBudget(childRecord.delegated!)).toBe(2);
      const launch = beginDelegatedLaunchInStore(data, {
        sessionId: SESSION,
        workItemId: childBinding.workItemId,
        callId: `call-new-${childId}`,
      });
      expect(launch.ok).toBe(false);
      if (launch.ok) return;
      expect(launch.errorCode).toBe("ATTEMPTS_EXHAUSTED");
    }
  });

  test("rejects a split that drops a parent acceptance criterion", () => {
    const registered = register("split-drop");
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const split = splitExecutionTaskInStore(store.getStoreData(), {
      sessionId: SESSION,
      runId: registered.runId,
      parentTaskId: "T-100",
      amendmentId: "split-drop-1",
      rationale: "Drop a criterion.",
      children: [task({ taskId: "T-101", acceptanceCriteria: ["Something else."] })],
    });
    expect(split.ok).toBe(false);
    if (split.ok) return;
    expect(split.errorCode).toBe("CRITERIA_NOT_PRESERVED");
  });
});

describe("read-only execution views", () => {
  test("exposes source kind, task status, and obligations", () => {
    const registered = register("view", [task({ requiredReviewers: ["spec", "code"] })]);
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const view = getExecutionView(registered.execution);
    expect(view.sourceKind).toBe("conversation-scoped");
    expect(view.tasks[0]).toMatchObject({ taskId: "T-100", status: "pending" });
    expect(view.checkpoints[0]?.requiredReviewers).toEqual(["spec", "code"]);
  });

  test("findExecutionByKey resolves the registered execution", () => {
    const registered = register("by-key");
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    expect(findExecutionByKey(store.getStoreData(), SESSION, "by-key")?.runId).toBe(
      registered.runId,
    );
  });
});

describe("atomicity and guard regressions", () => {
  test("append rolls back work items created before a mid-batch binding failure", () => {
    const registered = register("partial-append");
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const data = store.getStoreData();
    // Pre-occupy the key the second appended task will use with a conflicting intent.
    const occupied = store.openWorkItem({
      sessionId: SESSION,
      key: "exec:partial-append:task:T-201",
      title: "Conflicting intent",
      mode: "delegated",
      requiredReviewers: [],
      writeScope: ["src/lib/a.ts"],
    });
    expect(occupied.ok).toBe(true);

    const appended = appendExecutionWorkInStore(data, {
      sessionId: SESSION,
      runId: registered.runId,
      amendmentId: "amend-partial",
      rationale: "Half-valid batch.",
      tasks: [
        { contract: task({ taskId: "T-200", writeScope: ["src/lib/a.ts"] }) },
        { contract: task({ taskId: "T-201", writeScope: ["src/lib/a.ts"] }) },
      ],
    });
    expect(appended.ok).toBe(false);
    if (appended.ok) return;
    expect(appended.errorCode).toBe("TASK_BINDING_FAILED");
    const execution = findExecution(data, registered.runId)!;
    expect(execution.tasks.has("T-200")).toBe(false);
    expect(
      [...data.records.values()].some((record) => record.key === "exec:partial-append:task:T-200"),
    ).toBe(false);
  });

  test("rejects adopting the same work item for two tasks", () => {
    const opened = store.openWorkItem({
      sessionId: SESSION,
      key: "shared-adoption",
      title: "Shared",
      mode: "delegated",
      requiredReviewers: [],
      writeScope: ["src/lib/a.ts"],
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const result = registerExecutionInStore(store.getStoreData(), {
      sessionId: SESSION,
      workspaceRoot: WORKSPACE,
      executionKey: "shared-adoption-run",
      source: { kind: "conversation-scoped" },
      goal: "Adopt once.",
      boundary: { files: ["src/lib/a.ts"], directories: [] },
      tasks: [
        { contract: task({ taskId: "T-100" }), workItemId: opened.record.workItemId },
        { contract: task({ taskId: "T-200" }), workItemId: opened.record.workItemId },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe("DUPLICATE_ID");
  });

  test("split preserves the parent aggregate remaining budget", () => {
    const registered = register("split-aggregate");
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const data = store.getStoreData();
    const parentBinding = registered.execution.tasks.get("T-100")!;
    const parentRecord = data.records.get(`${SESSION}::${parentBinding.workItemId}`)!;
    const now = new Date().toISOString();
    parentRecord.delegated = {
      ...parentRecord.delegated!,
      attempts: [
        {
          attempt: 1,
          callId: "call-parent-1",
          launchedAt: now,
          status: "completed",
          resultStatus: "BLOCKED",
          completedAt: now,
        },
      ],
    };

    const split = splitExecutionTaskInStore(data, {
      sessionId: SESSION,
      runId: registered.runId,
      parentTaskId: "T-100",
      amendmentId: "split-aggregate-1",
      rationale: "Split with one remaining attempt.",
      children: [task({ taskId: "T-101" }), task({ taskId: "T-102" })],
    });
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    let aggregateRemaining = 0;
    for (const childId of split.childTaskIds) {
      const childBinding = split.execution.tasks.get(childId)!;
      const childRecord = data.records.get(`${SESSION}::${childBinding.workItemId}`)!;
      aggregateRemaining +=
        delegatedAttemptBudget(childRecord.delegated!) - childRecord.delegated!.attempts.length;
    }
    expect(aggregateRemaining).toBe(1);
  });

  test("split rejects descendants outside the boundary or with unknown references", () => {
    const registered = register("split-graph");
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const outside = splitExecutionTaskInStore(store.getStoreData(), {
      sessionId: SESSION,
      runId: registered.runId,
      parentTaskId: "T-100",
      amendmentId: "split-graph-1",
      rationale: "Escape the boundary.",
      children: [task({ taskId: "T-101", writeScope: ["src/lib/a.ts", "src/elsewhere/c.ts"] })],
    });
    expect(outside.ok).toBe(false);
    if (outside.ok) return;
    expect(outside.errorCode).toBe("OUT_OF_BOUNDARY");

    const unknown = splitExecutionTaskInStore(store.getStoreData(), {
      sessionId: SESSION,
      runId: registered.runId,
      parentTaskId: "T-100",
      amendmentId: "split-graph-2",
      rationale: "Unknown dependency.",
      children: [task({ taskId: "T-102", dependsOn: ["T-DOES-NOT-EXIST"] })],
    });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.errorCode).toBe("UNKNOWN_REFERENCE");
  });

  test("a generic checkpoint cannot be restarted while in flight or after passing", () => {
    const registered = register("checkpoint-guard", [task({ requiredReviewers: ["code"] })]);
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const binding = registered.execution.tasks.get("T-100")!;
    driveToAccepted(binding.workItemId);
    const data = store.getStoreData();

    const first = startGenericCheckpointInStore(data, {
      sessionId: SESSION,
      runId: registered.runId,
      checkpointId: "review-T-100",
    });
    expect(first.ok).toBe(true);
    const second = startGenericCheckpointInStore(data, {
      sessionId: SESSION,
      runId: registered.runId,
      checkpointId: "review-T-100",
    });
    expect(second.ok).toBe(false);

    const result = recordGenericReviewerResultInStore(data, {
      sessionId: SESSION,
      runId: registered.runId,
      checkpointId: "review-T-100",
      reviewer: "code",
      status: "PASS",
    });
    expect(result.ok).toBe(true);
    const afterPass = startGenericCheckpointInStore(data, {
      sessionId: SESSION,
      runId: registered.runId,
      checkpointId: "review-T-100",
    });
    expect(afterPass.ok).toBe(false);
  });

  test("accepts a native-package source with filesystem paths", () => {
    const result = registerExecutionInStore(store.getStoreData(), {
      sessionId: SESSION,
      workspaceRoot: WORKSPACE,
      executionKey: "native-path",
      source: {
        kind: "native-package",
        planPath: `${WORKSPACE}/.vvoc/specs/2026-01-01-native/plan.xml`,
        specPath: `${WORKSPACE}/.vvoc/specs/2026-01-01-native/spec.xml`,
        planSha256: "plan-hash",
        specSha256: "spec-hash",
        definition: { mode: "delegated", waves: [], tasks: [], checkpoints: [] },
      },
      goal: "Native source.",
      boundary: { files: ["src/lib/a.ts"], directories: [] },
      tasks: [{ contract: task() }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.execution.source.kind).toBe("native-package");
  });

  test("registration reuse rejects a divergent contract under the same key", () => {
    expect(register("reuse-divergent").ok).toBe(true);
    const data = store.getStoreData();
    const divergent = registerExecutionInStore(data, {
      sessionId: SESSION,
      workspaceRoot: WORKSPACE,
      executionKey: "reuse-divergent",
      source: { kind: "conversation-scoped" },
      goal: "A different goal.",
      boundary: { files: ["src/lib/a.ts", "src/lib/b.ts"], directories: [] },
      tasks: [{ contract: task() }],
    });
    expect(divergent.ok).toBe(false);
    if (divergent.ok) return;
    expect(divergent.errorCode).toBe("EXECUTION_KEY_CONFLICT");
  });

  test("task launchability respects declared dependencies", () => {
    const registered = register("launchability", [
      task({ taskId: "T-100" }),
      task({ taskId: "T-200", writeScope: ["src/lib/b.ts"], dependsOn: ["T-100"] }),
    ]);
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const data = store.getStoreData();
    const blocked = isTaskLaunchableInStore(data, {
      sessionId: SESSION,
      runId: registered.runId,
      taskId: "T-200",
    });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.reason).toBe("DEPENDENCIES_UNMET");

    driveToAccepted(registered.execution.tasks.get("T-100")!.workItemId);
    const ready = isTaskLaunchableInStore(data, {
      sessionId: SESSION,
      runId: registered.runId,
      taskId: "T-200",
    });
    expect(ready.ok).toBe(true);
  });

  test("completion requires every active task accepted", () => {
    const registered = register("complete-guard", [
      task({ taskId: "T-100" }),
      task({ taskId: "T-200", writeScope: ["src/lib/b.ts"] }),
    ]);
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const data = store.getStoreData();
    driveToAccepted(registered.execution.tasks.get("T-100")!.workItemId);
    const completed = completeExecutionInStore(data, {
      sessionId: SESSION,
      runId: registered.runId,
      rationale: "Only one task accepted.",
      evidence: [],
    });
    expect(completed.ok).toBe(false);
    if (completed.ok) return;
    expect(completed.errorCode).toBe("EXECUTION_INCOMPLETE");
  });
});
