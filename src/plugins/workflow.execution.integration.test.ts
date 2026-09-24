// FILE: src/plugins/workflow.execution.integration.test.ts
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
//   recordTrackedReviewer - Drives a linked review_only work item through the tracked launch/result pipeline.
//   registerConversation - Registers a conversation-scoped execution with one task.
//   callSequence - Monotonic suffix that keeps delegated callIDs unique per session.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-003 - Direct-handler generic outputs (open register, checkpoint start/review/complete/authorize exact replay and extension/approval/full and narrowed revocation/recover resume/restart/verify, native authority authorize) are now asserted against the closed result schemas. Earlier T-002 correction added direct-handler input-contract regressions, conflicting recognized-field and blank-batch rejection, generic checkpoint task-batch validation, source-dependent field rejection, session-ownership-first refusal, provided-plan canonicalization/idempotency, and large valid boundary/batch acceptance.]
// END_CHANGE_SUMMARY

import { beforeEach, describe, expect, test } from "bun:test";
import type { WorkflowTaskContract } from "../lib/workflow-contract.js";
import {
  appendExecutionWorkInStore,
  completeExecutionInStore,
  ensureNativeExecutions,
  findExecution,
  isTaskLaunchableInStore,
  recordGenericReviewerResultInStore,
  registerExecutionInStore,
  startGenericCheckpointInStore,
} from "./workflow/execution.js";
import { advanceUnitsAvailable, effectiveAuthorityStages } from "./workflow/authority.js";
import {
  applyDelegatedResult,
  beginDelegatedLaunch,
  decideDelegatedWorkItem,
} from "./workflow/delegated.js";
import { createWorkItemStore, type WorkItemStore } from "./workflow/state.js";
import { WorkflowTransactionQueue, runWorkflowTransaction } from "./workflow/transactions.js";
import {
  createWorkCheckpointTool,
  createWorkItemDecideTool,
  createWorkItemOpenTool,
} from "./workflow/tooling.js";
import { validateWorkflowToolResult } from "./workflow/results.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadManagedSkillTemplate, type ManagedSkillName } from "../lib/managed-skills.js";
import { resolveOrchestrationPolicy } from "../lib/orchestration.js";

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

/** Drive a linked review_only work item through the tracked launch/result pipeline. */
function recordTrackedReviewer(
  reviewWorkItemId: string,
  reviewer: "spec" | "code",
  status: "PASS" | "FAIL" | "NEEDS_CONTEXT",
): void {
  const agent = reviewer === "spec" ? "vv-spec-reviewer" : "vv-code-reviewer";
  callSequence += 1;
  const launched = store.beginTrackedLaunch({
    sessionId: SESSION,
    workItemId: reviewWorkItemId,
    agent,
  });
  expect(launched.ok).toBe(true);
  const applied = store.applyTrackedResult({
    sessionId: SESSION,
    workItemId: reviewWorkItemId,
    result: { agent, workItemId: reviewWorkItemId, status, route: "review", body: "reviewed" },
  });
  expect(applied.ok).toBe(true);
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
    recordTrackedReviewer(started.reviewWorkItemId, "code", "PASS");

    const inProgress = recordGenericReviewerResultInStore(store.getStoreData(), {
      sessionId: SESSION,
      runId: registered.runId,
      checkpointId: "review-T-100",
      reviewer: "code",
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
    const started = startGenericCheckpointInStore(store.getStoreData(), {
      sessionId: SESSION,
      runId: registered.runId,
      checkpointId: "review-T-100",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    recordTrackedReviewer(started.reviewWorkItemId, "code", "FAIL");
    const failed = recordGenericReviewerResultInStore(store.getStoreData(), {
      sessionId: SESSION,
      runId: registered.runId,
      checkpointId: "review-T-100",
      reviewer: "code",
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

describe("tool-layer reachability", () => {
  test("generic execution starts, reviews, and completes through work_item_open and work_checkpoint", async () => {
    const openTool = createWorkItemOpenTool(store);
    const opened = openTool.execute(
      {
        items: [
          {
            key: "tool-task",
            title: "Tool task",
            mode: "delegated",
            taskId: "T-100",
            requiredReviewers: ["code"],
            writeScope: ["src/lib/a.ts"],
            acceptanceCriteria: ["Task one works."],
            verification: ["bun test src/lib/a.test.ts"],
          },
        ],
        execution: {
          executionKey: "tool-run",
          source: { kind: "conversation-scoped" },
          goal: "Run through tools.",
          boundary: { files: ["src/lib/a.ts"], directories: [] },
        },
      },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    ) as Record<string, unknown>;
    expect(opened.ok).toBe(true);
    const runId = String(opened.runId);
    const view = opened.execution as {
      tasks: Array<{ taskId: string; workItemId: string }>;
    };
    const binding = view.tasks.find((entry) => entry.taskId === "T-100")!;
    expect(validateWorkflowToolResult("work_item_open", opened).ok).toBe(true);
    acceptTask(binding.workItemId);

    const checkpointTool = createWorkCheckpointTool(store, {
      lookupAuthorityMessage: async () => ({
        messageId: "msg-authorize",
        sessionId: SESSION,
        role: "user",
        createdMs: 1_000,
        ignored: false,
        syntheticOnly: false,
        textParts: ["finish autonomously"],
      }),
    });

    const started = (await checkpointTool.execute(
      { action: "start", runId, checkpointId: "review-T-100" },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    )) as Record<string, unknown>;
    expect(started.ok).toBe(true);
    expect(started.reviewersToLaunch).toEqual(["code"]);
    expect(validateWorkflowToolResult("work_checkpoint", started).ok).toBe(true);
    recordTrackedReviewer(String(started.reviewWorkItemId), "code", "PASS");

    const reviewed = (await checkpointTool.execute(
      { action: "review", runId, checkpointId: "review-T-100", reviewer: "code" },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    )) as Record<string, unknown>;
    expect(reviewed.ok).toBe(true);
    expect(reviewed.outcome).toBe("passed");
    expect(validateWorkflowToolResult("work_checkpoint", reviewed).ok).toBe(true);

    const completed = (await checkpointTool.execute(
      { action: "complete", runId, rationale: "Tool-driven completion." },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    )) as Record<string, unknown>;
    expect(completed.ok).toBe(true);
    expect(completed.reviewStatus).toBe("independently_reviewed");
    expect(validateWorkflowToolResult("work_checkpoint", completed).ok).toBe(true);

    // Authority and stage approval are reachable and persisted on the execution.
    const authorized = (await checkpointTool.execute(
      {
        action: "authorize",
        runId,
        authorityId: "auth-tool",
        messageId: "msg-authorize",
        stages: ["implementation"],
        decisionScope: "finish the prototype",
      },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    )) as Record<string, unknown>;
    expect(authorized.ok).toBe(true);
    expect(authorized.units).toBe(3);
    expect(validateWorkflowToolResult("work_checkpoint", authorized).ok).toBe(true);
    const execution = findExecution(store.getStoreData(), runId)!;
    expect(execution.authority).toHaveLength(1);
    expect(store.getStoreData().messageClaims.get("msg-authorize")?.runId).toBe(runId);

    const replay = (await checkpointTool.execute(
      {
        action: "authorize",
        runId,
        authorityId: "auth-tool",
        messageId: "msg-authorize",
        stages: ["implementation"],
        decisionScope: "finish the prototype",
      },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    )) as Record<string, unknown>;
    expect(replay.ok).toBe(true);
    expect(replay.reused).toBe(true);
    expect(validateWorkflowToolResult("work_checkpoint", replay).ok).toBe(true);
    expect(findExecution(store.getStoreData(), runId)!.authority).toHaveLength(1);

    const approval = (await checkpointTool.execute(
      {
        action: "record_approval",
        runId,
        authorityId: "auth-tool",
        approvalId: "appr-tool",
        stage: "implementation",
        artifactPath: "src/lib/a.ts",
        artifactSha256: "hash",
      },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    )) as Record<string, unknown>;
    expect(approval.ok).toBe(true);
    expect(approval.provenance).toBe("controller_delegated");
    expect(validateWorkflowToolResult("work_checkpoint", approval).ok).toBe(true);

    const revoked = (await checkpointTool.execute(
      {
        action: "revoke_authority",
        runId,
        authorityId: "auth-tool",
        revocationId: "revoke-tool",
      },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    )) as Record<string, unknown>;
    expect(revoked.ok).toBe(true);
    expect(revoked.kind).toBe("revoke");
    expect(revoked.availableUnits).toBe(0);
    expect(validateWorkflowToolResult("work_checkpoint", revoked).ok).toBe(true);
  });

  test("a failed generic review blocks tool-driven completion", async () => {
    const openTool = createWorkItemOpenTool(store);
    const opened = openTool.execute(
      {
        items: [
          {
            key: "tool-fail-task",
            title: "Tool fail task",
            mode: "delegated",
            taskId: "T-100",
            requiredReviewers: ["code"],
            writeScope: ["src/lib/a.ts"],
            acceptanceCriteria: ["Task one works."],
          },
        ],
        execution: {
          executionKey: "tool-fail-run",
          source: { kind: "provided-plan", reference: "docs/checklist.md" },
          goal: "Run through tools.",
          boundary: { files: ["src/lib/a.ts"], directories: [] },
        },
      },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    ) as Record<string, unknown>;
    expect(opened.ok).toBe(true);
    const runId = String(opened.runId);
    const view = opened.execution as { tasks: Array<{ taskId: string; workItemId: string }> };
    acceptTask(view.tasks.find((entry) => entry.taskId === "T-100")!.workItemId);

    const checkpointTool = createWorkCheckpointTool(store);
    const started = (await checkpointTool.execute(
      { action: "start", runId, checkpointId: "review-T-100" },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    )) as Record<string, unknown>;
    recordTrackedReviewer(String(started.reviewWorkItemId), "code", "FAIL");
    await checkpointTool.execute(
      { action: "review", runId, checkpointId: "review-T-100", reviewer: "code" },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    );
    const completed = (await checkpointTool.execute(
      { action: "complete", runId, rationale: "Try anyway." },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    )) as Record<string, unknown>;
    expect(completed.ok).toBe(false);
    expect(completed.errorCode).toBe("EXECUTION_INCOMPLETE");
  });

  test("mixed review coverage is reported as controller_accepted, not independent review", async () => {
    const openTool = createWorkItemOpenTool(store);
    const opened = openTool.execute(
      {
        items: [
          {
            key: "mixed-reviewed",
            title: "Reviewed task",
            mode: "delegated",
            taskId: "T-100",
            requiredReviewers: ["code"],
            writeScope: ["src/lib/a.ts"],
            acceptanceCriteria: ["Reviewed task works."],
          },
          {
            key: "mixed-unreviewed",
            title: "Unreviewed task",
            mode: "delegated",
            taskId: "T-200",
            requiredReviewers: [],
            writeScope: ["src/lib/b.ts"],
            acceptanceCriteria: ["Unreviewed task works."],
          },
        ],
        execution: {
          executionKey: "mixed-run",
          source: { kind: "conversation-scoped" },
          goal: "Mixed coverage.",
          boundary: { files: ["src/lib/a.ts", "src/lib/b.ts"], directories: [] },
        },
      },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    ) as Record<string, unknown>;
    expect(opened.ok).toBe(true);
    const runId = String(opened.runId);
    const view = opened.execution as { tasks: Array<{ taskId: string; workItemId: string }> };
    for (const entry of view.tasks) acceptTask(entry.workItemId);

    const checkpointTool = createWorkCheckpointTool(store);
    const started = (await checkpointTool.execute(
      { action: "start", runId, checkpointId: "review-T-100" },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    )) as Record<string, unknown>;
    recordTrackedReviewer(String(started.reviewWorkItemId), "code", "PASS");
    await checkpointTool.execute(
      { action: "review", runId, checkpointId: "review-T-100", reviewer: "code" },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    );
    const completed = (await checkpointTool.execute(
      { action: "complete", runId, rationale: "Finish with partial review coverage." },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    )) as Record<string, unknown>;
    expect(completed.ok).toBe(true);
    expect(completed.reviewStatus).toBe("controller_accepted");
  });

  test("a generic review cannot be settled from an asserted status", async () => {
    const openTool = createWorkItemOpenTool(store);
    const opened = openTool.execute(
      {
        items: [
          {
            key: "assert-task",
            title: "Assert task",
            mode: "delegated",
            taskId: "T-100",
            requiredReviewers: ["code"],
            writeScope: ["src/lib/a.ts"],
            acceptanceCriteria: ["Task works."],
          },
        ],
        execution: {
          executionKey: "assert-run",
          source: { kind: "conversation-scoped" },
          goal: "Reject asserted review.",
          boundary: { files: ["src/lib/a.ts"], directories: [] },
        },
      },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    ) as Record<string, unknown>;
    expect(opened.ok).toBe(true);
    const runId = String(opened.runId);
    const view = opened.execution as { tasks: Array<{ taskId: string; workItemId: string }> };
    acceptTask(view.tasks.find((entry) => entry.taskId === "T-100")!.workItemId);

    const checkpointTool = createWorkCheckpointTool(store);
    const started = (await checkpointTool.execute(
      { action: "start", runId, checkpointId: "review-T-100" },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    )) as Record<string, unknown>;
    expect(started.ok).toBe(true);
    // No reviewer result was recorded on the linked review work item, so an
    // asserted status must not settle the generation.
    const asserted = (await checkpointTool.execute(
      { action: "review", runId, checkpointId: "review-T-100", reviewer: "code" },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    )) as Record<string, unknown>;
    expect(asserted.ok).toBe(false);
    expect(asserted.errorCode).toBe("INVALID_INPUT");
  });

  test("a reviewer NEEDS_CONTEXT settles as a recoverable stop, not a consumed generation", async () => {
    const openTool = createWorkItemOpenTool(store);
    const opened = openTool.execute(
      {
        items: [
          {
            key: "needs-context-task",
            title: "Needs context task",
            mode: "delegated",
            taskId: "T-100",
            requiredReviewers: ["spec", "code"],
            writeScope: ["src/lib/a.ts"],
            acceptanceCriteria: ["Task works."],
          },
        ],
        execution: {
          executionKey: "needs-context-run",
          source: { kind: "conversation-scoped" },
          goal: "Stop on reviewer NEEDS_CONTEXT.",
          boundary: { files: ["src/lib/a.ts"], directories: [] },
        },
      },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    ) as Record<string, unknown>;
    expect(opened.ok).toBe(true);
    const runId = String(opened.runId);
    const view = opened.execution as { tasks: Array<{ taskId: string; workItemId: string }> };
    acceptTask(view.tasks.find((entry) => entry.taskId === "T-100")!.workItemId);

    const checkpointTool = createWorkCheckpointTool(store);
    const started = (await checkpointTool.execute(
      { action: "start", runId, checkpointId: "review-T-100" },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    )) as Record<string, unknown>;
    expect(started.ok).toBe(true);
    recordTrackedReviewer(String(started.reviewWorkItemId), "spec", "NEEDS_CONTEXT");

    const stopped = (await checkpointTool.execute(
      { action: "review", runId, checkpointId: "review-T-100", reviewer: "spec" },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    )) as Record<string, unknown>;
    expect(stopped.ok).toBe(true);
    expect(stopped.outcome).toBe("stopped");

    const restartWhileStopped = (await checkpointTool.execute(
      { action: "start", runId, checkpointId: "review-T-100" },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    )) as Record<string, unknown>;
    expect(restartWhileStopped.ok).toBe(false);

    // A stopped generation recovers cost-free, without an authority unit.
    const resumed = (await checkpointTool.execute(
      {
        action: "recover",
        runId,
        checkpointId: "review-T-100",
        recoveryId: "needs-context-recover",
        diagnosis: "Reviewer requested context.",
        changedCondition: "Context added to the review packet.",
        verification: ["src/lib/a.ts"],
      },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    )) as Record<string, unknown>;
    expect(resumed.ok).toBe(true);
    expect(resumed.kind).toBe("resume");
    expect(validateWorkflowToolResult("work_checkpoint", resumed).ok).toBe(true);

    const restarted = (await checkpointTool.execute(
      { action: "start", runId, checkpointId: "review-T-100" },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    )) as Record<string, unknown>;
    expect(restarted.ok).toBe(true);
    // The resumed generation must use a fresh review work item and be able to
    // pass with real reviewer results.
    expect(restarted.reviewWorkItemId).not.toBe(started.reviewWorkItemId);
    expect(validateWorkflowToolResult("work_checkpoint", restarted).ok).toBe(true);
    recordTrackedReviewer(String(restarted.reviewWorkItemId), "spec", "PASS");
    recordTrackedReviewer(String(restarted.reviewWorkItemId), "code", "PASS");
    const settled = (await checkpointTool.execute(
      { action: "verify", runId, checkpointId: "review-T-100" },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    )) as Record<string, unknown>;
    expect(settled.ok).toBe(true);
    expect(settled.outcome).toBe("passed");
    expect(validateWorkflowToolResult("work_checkpoint", settled).ok).toBe(true);
  });

  test("authority actions are reachable for a native-package execution", async () => {
    const data = store.getStoreData();
    const now = new Date().toISOString();
    data.planRuns.set("run-native-auth", {
      runId: "run-native-auth",
      sessionId: SESSION,
      planPath: `${WORKSPACE}/.vvoc/specs/2026-01-01-native/plan.xml`,
      specPath: `${WORKSPACE}/.vvoc/specs/2026-01-01-native/spec.xml`,
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

    const checkpointTool = createWorkCheckpointTool(store, {
      lookupAuthorityMessage: async () => ({
        messageId: "msg-native",
        sessionId: SESSION,
        role: "user",
        createdMs: 2_000,
        ignored: false,
        syntheticOnly: false,
        textParts: ["finish"],
      }),
    });
    const authorized = (await checkpointTool.execute(
      {
        action: "authorize",
        runId: "run-native-auth",
        authorityId: "auth-native",
        messageId: "msg-native",
        stages: ["implementation"],
        decisionScope: "finish",
      },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    )) as Record<string, unknown>;
    expect(authorized.ok).toBe(true);
    expect(findExecution(store.getStoreData(), "run-native-auth")?.authority).toHaveLength(1);
    expect(validateWorkflowToolResult("work_checkpoint", authorized).ok).toBe(true);
  });

  test("an exhausted generic checkpoint recovers under a recorded advance unit", async () => {
    const openTool = createWorkItemOpenTool(store);
    const opened = openTool.execute(
      {
        items: [
          {
            key: "checkpoint-advance",
            title: "Checkpoint advance",
            mode: "delegated",
            taskId: "T-100",
            requiredReviewers: ["code"],
            writeScope: ["src/lib/a.ts"],
            acceptanceCriteria: ["Task works."],
          },
        ],
        execution: {
          executionKey: "checkpoint-advance-run",
          source: { kind: "conversation-scoped" },
          goal: "Exhaust the checkpoint.",
          boundary: { files: ["src/lib/a.ts"], directories: [] },
        },
      },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    ) as Record<string, unknown>;
    expect(opened.ok).toBe(true);
    const runId = String(opened.runId);
    const view = opened.execution as { tasks: Array<{ taskId: string; workItemId: string }> };
    acceptTask(view.tasks.find((entry) => entry.taskId === "T-100")!.workItemId);

    const checkpointTool = createWorkCheckpointTool(store, {
      lookupAuthorityMessage: async () => ({
        messageId: "msg-cp",
        sessionId: SESSION,
        role: "user",
        createdMs: 1_000,
        ignored: false,
        syntheticOnly: false,
        textParts: ["finish"],
      }),
    });
    for (let generation = 0; generation < 2; generation += 1) {
      const started = (await checkpointTool.execute(
        { action: "start", runId, checkpointId: "review-T-100" },
        { sessionId: SESSION, workspaceRoot: WORKSPACE },
        store,
      )) as Record<string, unknown>;
      expect(started.ok).toBe(true);
      recordTrackedReviewer(String(started.reviewWorkItemId), "code", "FAIL");
      await checkpointTool.execute(
        { action: "review", runId, checkpointId: "review-T-100", reviewer: "code" },
        { sessionId: SESSION, workspaceRoot: WORKSPACE },
        store,
      );
    }
    await checkpointTool.execute(
      {
        action: "authorize",
        runId,
        authorityId: "auth-cp",
        messageId: "msg-cp",
        stages: ["verification"],
        decisionScope: "finish",
      },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    );
    const recovered = (await checkpointTool.execute(
      {
        action: "recover",
        runId,
        checkpointId: "review-T-100",
        recoveryId: "cp-recover",
        diagnosis: "Both ordinary generations failed.",
        changedCondition: "Coverage narrowed to the changed file.",
        verification: ["src/lib/a.ts"],
        authorityId: "auth-cp",
      },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    )) as Record<string, unknown>;
    expect(recovered.ok).toBe(true);
    expect(recovered.kind).toBe("advance_grant");
    const execution = findExecution(store.getStoreData(), runId)!;
    expect(execution.reserveDebits).toHaveLength(1);
    expect(execution.reserveDebits[0]?.targetKind).toBe("checkpoint");
  });

  test("a pre-stop advance authority grants one bounded continuation through the decide tool", async () => {
    const openTool = createWorkItemOpenTool(store);
    const opened = openTool.execute(
      {
        items: [
          {
            key: "advance-task",
            title: "Advance task",
            mode: "delegated",
            taskId: "T-100",
            requiredReviewers: [],
            writeScope: ["src/lib/a.ts"],
            acceptanceCriteria: ["Task one works."],
          },
        ],
        execution: {
          executionKey: "advance-run",
          source: { kind: "conversation-scoped" },
          goal: "Exercise advance recovery.",
          boundary: { files: ["src/lib/a.ts"], directories: [] },
        },
      },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    ) as Record<string, unknown>;
    expect(opened.ok).toBe(true);
    const runId = String(opened.runId);
    const view = opened.execution as { tasks: Array<{ taskId: string; workItemId: string }> };
    const workItemId = view.tasks.find((entry) => entry.taskId === "T-100")!.workItemId;

    const checkpointTool = createWorkCheckpointTool(store, {
      lookupAuthorityMessage: async () => ({
        messageId: "msg-prepare",
        sessionId: SESSION,
        role: "user",
        createdMs: 1_000,
        ignored: false,
        syntheticOnly: false,
        textParts: ["finish autonomously"],
      }),
    });
    // Grant authority BEFORE the later stop.
    const authorized = (await checkpointTool.execute(
      {
        action: "authorize",
        runId,
        authorityId: "auth-prepare",
        messageId: "msg-prepare",
        stages: ["implementation", "verification"],
        decisionScope: "finish the bounded prototype",
      },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    )) as Record<string, unknown>;
    expect(authorized.ok).toBe(true);

    const blockTask = (callId: string): number => {
      callSequence += 1;
      const launched = beginDelegatedLaunch(store, { sessionId: SESSION, workItemId, callId });
      expect(launched.ok).toBe(true);
      const applied = applyDelegatedResult(store, {
        sessionId: SESSION,
        workItemId,
        callId,
        resultStatus: "BLOCKED",
      });
      expect(applied.ok).toBe(true);
      return applied.ok ? applied.attempt : 0;
    };
    const decideTool = createWorkItemDecideTool(store);
    const recover = (attempt: number, recoveryId: string) =>
      decideTool.execute(
        {
          workItemId,
          attempt,
          decision: "recover",
          diagnosis: "Stopped at the gate.",
          changedCondition: "Gate inputs recorded.",
          verification: ["src/lib/a.ts"],
          recoveryId,
        },
        { sessionId: SESSION },
        store,
      ) as Promise<Record<string, unknown>>;

    const attempt1 = blockTask("advance-call-1");
    expect((await recover(attempt1, "advance-rec-resume")).kind).toBe("resume");
    const attempt2 = blockTask("advance-call-2");
    expect((await recover(attempt2, "advance-rec-auto")).kind).toBe("autonomous_grant");
    const attempt3 = blockTask("advance-call-3");

    const advanced = (await decideTool.execute(
      {
        workItemId,
        attempt: attempt3,
        decision: "recover",
        diagnosis: "Stopped after ordinary allowances were exhausted.",
        changedCondition: "Recorded pre-stop authority covers one continuation.",
        verification: ["src/lib/a.ts"],
        recoveryId: "advance-rec-unit",
        runId,
        authorityId: "auth-prepare",
      },
      { sessionId: SESSION },
      store,
    )) as Record<string, unknown>;
    expect(advanced.ok).toBe(true);
    expect(advanced.kind).toBe("advance_grant");
    expect(advanced.attemptBudget).toBe(4);

    const execution = findExecution(store.getStoreData(), runId)!;
    expect(execution.reserveDebits).toHaveLength(1);
    expect(execution.reserveDebits[0]?.recoveryId).toBe("advance-rec-unit");

    // The same authority cannot fund a second unit after revocation.
    const revoked = (await checkpointTool.execute(
      {
        action: "revoke_authority",
        runId,
        authorityId: "auth-prepare",
        revocationId: "advance-revoke",
      },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    )) as Record<string, unknown>;
    expect(revoked.ok).toBe(true);
    expect(revoked.availableUnits).toBe(0);
  });
});

// START_BLOCK_CONTRACT_REGRESSIONS
describe("workflow input contract regressions (direct handlers)", () => {
  function openGeneric(
    overrides: { items?: unknown[]; execution?: Record<string, unknown> } = {},
  ): Record<string, unknown> {
    const openTool = createWorkItemOpenTool(store);
    return openTool.execute(
      {
        items: overrides.items ?? [
          {
            key: "contract-task",
            title: "Contract task",
            mode: "delegated",
            requiredReviewers: [],
            writeScope: ["src/lib/a.ts"],
            taskId: "T-100",
            acceptanceCriteria: ["Task works."],
          },
        ],
        execution: overrides.execution ?? {
          executionKey: "contract-run",
          source: { kind: "conversation-scoped" },
          goal: "Exercise input contracts.",
          boundary: { files: ["src/lib/a.ts"], directories: [] },
        },
      },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    ) as Record<string, unknown>;
  }

  function authoritySnapshot(runId: string): Record<string, unknown> {
    const execution = findExecution(store.getStoreData(), runId)!;
    const authority = execution.authority[0];
    return {
      authorityCount: execution.authority.length,
      extensions: authority?.extensions.length ?? 0,
      revocations: authority?.revocations.length ?? 0,
      initialUnits: authority?.initialUnits ?? 0,
      availableUnits: authority ? advanceUnitsAvailable(authority, execution.reserveDebits) : 0,
      stages: authority ? effectiveAuthorityStages(authority) : [],
      reserveDebits: execution.reserveDebits.length,
      stageApprovals: execution.stageApprovals.length,
      claims: store.getStoreData().messageClaims.size,
      records: store.getStoreData().records.size,
    };
  }

  test("whole-request structural rejection leaves the store unchanged and domain conflicts stay per-item", () => {
    const before = store.getStoreData().records.size;
    const partial = openGeneric({
      items: [
        {
          key: "valid-item",
          title: "Valid item",
          mode: "implementation",
          requiredReviewers: ["spec"],
        },
        { key: "invalid-item", title: "Invalid item" },
      ],
    });
    expect(partial.ok).toBe(false);
    expect(partial.errorCode).toBe("INVALID_INPUT");
    expect(store.getStoreData().records.size).toBe(before);
    expect(store.getStoreData().executions.size).toBe(0);

    const conversation = openGeneric({
      execution: {
        executionKey: "source-kind",
        source: { kind: "conversation" },
        goal: "Wrong source kind.",
        boundary: { files: ["src/lib/a.ts"], directories: [] },
      },
    });
    expect(conversation.ok).toBe(false);
    expect(String(conversation.message)).toContain("conversation-scoped");
    expect(store.getStoreData().executions.size).toBe(0);

    const numericSha = openGeneric({
      execution: {
        executionKey: "source-sha",
        source: { kind: "provided-plan", reference: "docs/p.md", sha256: 5 },
        goal: "Numeric sha.",
        boundary: { files: ["src/lib/a.ts"], directories: [] },
      },
    });
    expect(numericSha.ok).toBe(false);
    expect(String(numericSha.message)).toContain("execution.source.sha256");
    expect(store.getStoreData().executions.size).toBe(0);

    // After structural acceptance, a standalone domain conflict remains per-item.
    const openTool = createWorkItemOpenTool(store);
    const first = openTool.execute(
      {
        items: [
          { key: "per-item", title: "First", mode: "implementation", requiredReviewers: ["spec"] },
        ],
      },
      { sessionId: SESSION },
      store,
    ) as { items: Array<{ ok: boolean }> };
    expect(first.items[0]?.ok).toBe(true);
    const conflicted = openTool.execute(
      {
        items: [
          { key: "per-item", title: "Second", mode: "review_only", requiredReviewers: ["code"] },
        ],
      },
      { sessionId: SESSION },
      store,
    ) as { items: Array<{ ok: boolean; errorCode?: string }> };
    expect(conflicted.items[0]?.ok).toBe(false);
    expect(conflicted.items[0]?.errorCode).toBe("WORK_ITEM_KEY_CONFLICT");
  });

  test("OUT_OF_BOUNDARY reports the offending scope with the applicable boundary and mutates nothing", () => {
    const beforeRecords = store.getStoreData().records.size;
    const result = openGeneric({
      execution: {
        executionKey: "out-of-boundary",
        source: { kind: "conversation-scoped" },
        goal: "Reach outside the boundary.",
        boundary: { files: ["src/lib/b.ts", "src/lib/c.ts"], directories: ["src/plugins/"] },
      },
      items: [
        {
          key: "oob-task",
          title: "Outside task",
          mode: "delegated",
          requiredReviewers: [],
          writeScope: ["src/elsewhere/d.ts"],
          taskId: "T-OOB",
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("OUT_OF_BOUNDARY");
    expect(String(result.message)).toContain("src/elsewhere/d.ts");
    expect(String(result.message)).toContain("src/lib/b.ts");
    expect(String(result.message)).toContain("src/plugins");
    expect(store.getStoreData().records.size).toBe(beforeRecords);
    expect(store.getStoreData().executions.size).toBe(0);
  });

  test("generic register and amend mutations stay atomic on domain rejection", async () => {
    const registered = openGeneric({});
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const runId = String(registered.runId);
    const executionBefore = findExecution(store.getStoreData(), runId)!;
    const revisionBefore = executionBefore.revision;
    const tasksBefore = executionBefore.tasks.size;

    const checkpointTool = createWorkCheckpointTool(store);
    const badAmend = (await checkpointTool.execute(
      {
        action: "amend",
        runId,
        amendmentId: "amend-oob",
        rationale: "Add an out-of-boundary task.",
        tasks: [
          {
            key: "amend-oob",
            title: "Amend outside",
            mode: "delegated",
            requiredReviewers: [],
            writeScope: ["src/elsewhere/e.ts"],
            taskId: "T-OOB-2",
          },
        ],
      },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    )) as Record<string, unknown>;
    expect(badAmend.ok).toBe(false);
    expect(badAmend.errorCode).toBe("OUT_OF_BOUNDARY");
    const executionAfter = findExecution(store.getStoreData(), runId)!;
    expect(executionAfter.revision).toBe(revisionBefore);
    expect(executionAfter.tasks.size).toBe(tasksBefore);

    const badCheckpointAmend = (await checkpointTool.execute(
      {
        action: "amend",
        runId,
        amendmentId: "amend-cp",
        rationale: "Add an empty-covers checkpoint.",
        checkpoints: [
          {
            checkpointId: "C-EMPTY",
            kind: "final",
            covers: [],
            requiredReviewers: ["code"],
            origin: "controller",
          },
        ],
      },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    )) as Record<string, unknown>;
    expect(badCheckpointAmend.ok).toBe(false);
    const executionFinal = findExecution(store.getStoreData(), runId)!;
    expect(executionFinal.revision).toBe(revisionBefore);
    expect(executionFinal.checkpoints.has("C-EMPTY")).toBe(false);
  });

  test("unknown generic runs fail as lookup failures, never as missing native-only fields", async () => {
    const checkpointTool = createWorkCheckpointTool(store);
    for (const args of [
      { action: "review", runId: "run-unknown", checkpointId: "C-1" },
      { action: "complete", runId: "run-unknown" },
      {
        action: "authorize",
        runId: "run-unknown",
        authorityId: "auth-1",
        messageId: "msg-1",
        stages: ["implementation"],
      },
    ] as const) {
      const result = (await checkpointTool.execute(
        args as never,
        { sessionId: SESSION, workspaceRoot: WORKSPACE },
        store,
      )) as Record<string, unknown>;
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("EXECUTION_NOT_FOUND");
      expect(String(result.message)).toContain("run-unknown");
      expect(String(result.message)).not.toContain("start and verify");
      expect(String(result.message)).not.toContain("planPath");
      expect(String(result.message)).not.toContain("register requires");
    }
  });

  test("recognized fields conflicting with the selected action/decision reject before any handler mutation", async () => {
    const checkpointTool = createWorkCheckpointTool(store);
    const decideTool = createWorkItemDecideTool(store);
    const recordsBefore = store.getStoreData().records.size;
    const executionsBefore = store.getStoreData().executions.size;

    const completeStops = (await checkpointTool.execute(
      { action: "complete", runId: "run-missing", reservedStops: ["verification"] } as never,
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    )) as Record<string, unknown>;
    expect(completeStops.ok).toBe(false);
    expect(completeStops.errorCode).toBe("INVALID_INPUT");
    expect(String(completeStops.message)).toContain("reservedStops");

    const startPlan = (await checkpointTool.execute(
      {
        action: "start",
        runId: "run-missing",
        checkpointId: "C-1",
        planPath: "ignored.xml",
      } as never,
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    )) as Record<string, unknown>;
    expect(startPlan.ok).toBe(false);
    expect(String(startPlan.message)).toContain("planPath");

    const acceptRecovery = (await decideTool.execute(
      {
        workItemId: "wi-1",
        attempt: 1,
        decision: "accept",
        rationale: "checked",
        evidence: ["test"],
        recoveryId: "ignored-recovery",
      } as never,
      { sessionId: SESSION },
      store,
    )) as Record<string, unknown>;
    expect(acceptRecovery.ok).toBe(false);
    expect(String(acceptRecovery.message)).toContain("recoveryId");

    expect(store.getStoreData().records.size).toBe(recordsBefore);
    expect(store.getStoreData().executions.size).toBe(executionsBefore);
  });

  test("a blank-after-trim batch member rejects the whole handler call before item1 opens", () => {
    const openTool = createWorkItemOpenTool(store);
    const before = store.getStoreData().records.size;
    const result = openTool.execute(
      {
        items: [
          {
            key: "blank-first",
            title: "First",
            mode: "implementation",
            requiredReviewers: ["spec"],
          },
          { key: "   ", title: "Blank", mode: "review_only", requiredReviewers: ["code"] },
        ],
      },
      { sessionId: SESSION },
      store,
    ) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("INVALID_INPUT");
    expect(String(result.message)).toContain("items[1].key");
    expect(store.getStoreData().records.size).toBe(before);
  });

  test("generic checkpoint task batches are branch-validated before any mutation", async () => {
    const registered = openGeneric({});
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const runId = String(registered.runId);
    const before = findExecution(store.getStoreData(), runId)!;
    const revisionBefore = before.revision;
    const tasksBefore = before.tasks.size;

    const checkpointTool = createWorkCheckpointTool(store);
    const mixed = (await checkpointTool.execute(
      {
        action: "amend",
        runId,
        amendmentId: "amend-mixed",
        rationale: "Mixed generic task batch.",
        tasks: [
          {
            key: "ok-task",
            title: "Ok",
            mode: "delegated",
            requiredReviewers: [],
            writeScope: ["src/lib/a.ts"],
            taskId: "T-OK",
          },
          {
            key: "bad-task",
            title: "Bad",
            mode: "implementation",
            requiredReviewers: [],
            writeScope: ["src/lib/a.ts"],
            planRunId: "native-run",
            planTaskId: "native-task",
          },
        ],
      } as never,
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    )) as Record<string, unknown>;
    expect(mixed.ok).toBe(false);
    expect(mixed.errorCode).toBe("INVALID_INPUT");
    expect(String(mixed.message)).toContain("tasks[1].mode");
    const after = findExecution(store.getStoreData(), runId)!;
    expect(after.revision).toBe(revisionBefore);
    expect(after.tasks.size).toBe(tasksBefore);
    expect(after.tasks.has("T-OK")).toBe(false);
  });

  test("source-dependent known fields reject before mutation and unknown runs stay lookup failures", async () => {
    const data = store.getStoreData();
    const now = new Date().toISOString();
    const nativeRun = "run-native-contract";
    data.planRuns.set(nativeRun, {
      runId: nativeRun,
      sessionId: SESSION,
      planPath: "/workspace/.vvoc/specs/native/plan.xml",
      specPath: "/workspace/.vvoc/specs/native/spec.xml",
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

    const checkpointTool = createWorkCheckpointTool(store);
    const context = { sessionId: SESSION, workspaceRoot: WORKSPACE };
    const nativeTasksBefore = findExecution(store.getStoreData(), nativeRun)!.tasks.size;

    const nativeStartFingerprint = (await checkpointTool.execute(
      {
        action: "start",
        runId: nativeRun,
        checkpointId: "CHECKPOINT-R-001",
        startFingerprint: "abc",
      } as never,
      context,
      store,
    )) as Record<string, unknown>;
    expect(nativeStartFingerprint.ok).toBe(false);
    expect(String(nativeStartFingerprint.message)).toContain("startFingerprint");

    const nativeVerifyReviewer = (await checkpointTool.execute(
      {
        action: "verify",
        runId: nativeRun,
        checkpointId: "CHECKPOINT-R-001",
        reviewer: "code",
      } as never,
      context,
      store,
    )) as Record<string, unknown>;
    expect(nativeVerifyReviewer.ok).toBe(false);
    expect(String(nativeVerifyReviewer.message)).toContain("reviewer");
    expect(findExecution(store.getStoreData(), nativeRun)!.tasks.size).toBe(nativeTasksBefore);

    const registered = openGeneric({});
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const runId = String(registered.runId);
    const revisionBefore = findExecution(store.getStoreData(), runId)!.revision;

    for (const complete of [true, false]) {
      const genericVerifyComplete = (await checkpointTool.execute(
        { action: "verify", runId, checkpointId: "review-T-100", complete } as never,
        context,
        store,
      )) as Record<string, unknown>;
      expect(genericVerifyComplete.ok).toBe(false);
      expect(String(genericVerifyComplete.message)).toContain("complete");
    }

    const genericRecoverMessage = (await checkpointTool.execute(
      {
        action: "recover",
        runId,
        checkpointId: "review-T-100",
        recoveryId: "rec-source",
        diagnosis: "Both generations failed.",
        changedCondition: "Narrowed coverage.",
        verification: ["src/lib/a.ts"],
        userMessageId: "msg-1",
      } as never,
      context,
      store,
    )) as Record<string, unknown>;
    expect(genericRecoverMessage.ok).toBe(false);
    expect(String(genericRecoverMessage.message)).toContain("userMessageId");
    expect(findExecution(store.getStoreData(), runId)!.revision).toBe(revisionBefore);

    // An unknown run stays a lookup failure, never invented native arguments.
    const unknownStart = (await checkpointTool.execute(
      {
        action: "start",
        runId: "run-unknown",
        checkpointId: "C-1",
        startFingerprint: "abc",
      } as never,
      context,
      store,
    )) as Record<string, unknown>;
    expect(unknownStart.ok).toBe(false);
    expect(String(unknownStart.message)).not.toContain("startFingerprint");
  });

  test("run session ownership is enforced before any source-specific diagnostic", async () => {
    const registered = openGeneric({});
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const genericRunId = String(registered.runId);
    const genericBefore = findExecution(store.getStoreData(), genericRunId)!;
    const revisionBefore = genericBefore.revision;
    const tasksBefore = genericBefore.tasks.size;

    const checkpointTool = createWorkCheckpointTool(store);
    const foreign = { sessionId: "session-foreign", workspaceRoot: WORKSPACE };
    const owned = { sessionId: SESSION, workspaceRoot: WORKSPACE };
    const assertForeignRefusal = (result: Record<string, unknown>): void => {
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("SESSION_MISMATCH");
      const message = String(result.message);
      expect(message).not.toContain("complete");
      expect(message).not.toContain("startFingerprint");
      expect(message).not.toContain("userMessageId");
      expect(message).not.toContain("reviewer");
      expect(message).not.toContain("generic");
      expect(message).not.toContain("native-package");
      expect(message).not.toContain(SESSION);
    };

    const foreignGenericCalls: Array<Record<string, unknown>> = [
      { action: "verify", runId: genericRunId, checkpointId: "review-T-100" },
      { action: "verify", runId: genericRunId, checkpointId: "review-T-100", complete: true },
      { action: "verify", runId: genericRunId, checkpointId: "review-T-100", complete: false },
      { action: "start", runId: genericRunId, checkpointId: "review-T-100" },
      {
        action: "start",
        runId: genericRunId,
        checkpointId: "review-T-100",
        startFingerprint: "abc",
      },
      {
        action: "recover",
        runId: genericRunId,
        checkpointId: "review-T-100",
        recoveryId: "rec-foreign",
        diagnosis: "d",
        changedCondition: "c",
        verification: ["v"],
        userMessageId: "msg-1",
      },
      {
        action: "authorize",
        runId: genericRunId,
        authorityId: "auth-1",
        messageId: "msg-1",
        stages: ["implementation"],
      },
    ];
    const recordsBeforeGenericRefusals = store.getStoreData().records.size;
    const executionsBeforeGenericRefusals = store.getStoreData().executions.size;
    for (const args of foreignGenericCalls) {
      assertForeignRefusal(
        (await checkpointTool.execute(args as never, foreign, store)) as Record<string, unknown>,
      );
    }
    expect(store.getStoreData().records.size).toBe(recordsBeforeGenericRefusals);
    expect(store.getStoreData().executions.size).toBe(executionsBeforeGenericRefusals);

    // Native/legacy shapes are guarded the same way, without native provenance.
    const data = store.getStoreData();
    const now = new Date().toISOString();
    const nativeRun = "run-native-ownership";
    data.planRuns.set(nativeRun, {
      runId: nativeRun,
      sessionId: SESSION,
      planPath: "/workspace/.vvoc/specs/native/plan.xml",
      specPath: "/workspace/.vvoc/specs/native/spec.xml",
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
    const recordsAfterSetup = store.getStoreData().records.size;
    const executionsAfterSetup = store.getStoreData().executions.size;

    const foreignNativeCalls: Array<Record<string, unknown>> = [
      { action: "start", runId: nativeRun, checkpointId: "CHECKPOINT-R-001" },
      {
        action: "start",
        runId: nativeRun,
        checkpointId: "CHECKPOINT-R-001",
        startFingerprint: "abc",
      },
      { action: "verify", runId: nativeRun, checkpointId: "CHECKPOINT-R-001" },
      {
        action: "verify",
        runId: nativeRun,
        checkpointId: "CHECKPOINT-R-001",
        reviewer: "code",
      },
      { action: "review", runId: nativeRun, checkpointId: "CHECKPOINT-R-001" },
      { action: "complete", runId: nativeRun },
    ];
    for (const args of foreignNativeCalls) {
      assertForeignRefusal(
        (await checkpointTool.execute(args as never, foreign, store)) as Record<string, unknown>,
      );
    }

    // Legacy/native fallback with a planRun but no materialized execution.
    const fallbackStore = createWorkItemStore();
    const fallbackData = fallbackStore.getStoreData();
    fallbackData.planRuns.set("run-legacy-ownership", {
      runId: "run-legacy-ownership",
      sessionId: SESSION,
      planPath: "/workspace/.vvoc/specs/legacy/plan.xml",
      specPath: "/workspace/.vvoc/specs/legacy/spec.xml",
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
        checkpoints: [],
      },
      registeredAt: now,
      status: "active",
      tasks: new Map([["T-001", { taskId: "T-001", workItemId: "wi-legacy" }]]),
      checkpoints: new Map(),
    });
    assertForeignRefusal(
      (await createWorkCheckpointTool(fallbackStore).execute(
        {
          action: "start",
          runId: "run-legacy-ownership",
          checkpointId: "CHECKPOINT-R-001",
          startFingerprint: "abc",
        } as never,
        foreign,
        fallbackStore,
      )) as Record<string, unknown>,
    );

    // Unknown runs stay lookup failures, not ownership refusals.
    const unknown = (await checkpointTool.execute(
      { action: "verify", runId: "run-unknown", checkpointId: "C-1", complete: true } as never,
      foreign,
      store,
    )) as Record<string, unknown>;
    expect(unknown.ok).toBe(false);
    expect(unknown.errorCode).toBe("RUN_NOT_FOUND");
    expect(String(unknown.message)).not.toContain("complete");

    // Owned runs keep their same-session source-specific diagnostics.
    const ownedGenericComplete = (await checkpointTool.execute(
      {
        action: "verify",
        runId: genericRunId,
        checkpointId: "review-T-100",
        complete: true,
      } as never,
      owned,
      store,
    )) as Record<string, unknown>;
    expect(ownedGenericComplete.errorCode).toBe("INVALID_INPUT");
    expect(String(ownedGenericComplete.message)).toContain("complete");

    const ownedNativeFingerprint = (await checkpointTool.execute(
      {
        action: "start",
        runId: nativeRun,
        checkpointId: "CHECKPOINT-R-001",
        startFingerprint: "abc",
      } as never,
      owned,
      store,
    )) as Record<string, unknown>;
    expect(ownedNativeFingerprint.errorCode).toBe("INVALID_INPUT");
    expect(String(ownedNativeFingerprint.message)).toContain("startFingerprint");

    const ownedNativeReviewer = (await checkpointTool.execute(
      {
        action: "verify",
        runId: nativeRun,
        checkpointId: "CHECKPOINT-R-001",
        reviewer: "code",
      } as never,
      owned,
      store,
    )) as Record<string, unknown>;
    expect(ownedNativeReviewer.errorCode).toBe("INVALID_INPUT");
    expect(String(ownedNativeReviewer.message)).toContain("reviewer");

    const ownedNativeGenericOnly = (await checkpointTool.execute(
      { action: "review", runId: nativeRun, checkpointId: "CHECKPOINT-R-001" } as never,
      owned,
      store,
    )) as Record<string, unknown>;
    expect(ownedNativeGenericOnly.errorCode).toBe("INVALID_INPUT");
    expect(String(ownedNativeGenericOnly.message)).toContain("native-package");

    // No ownership refusal mutated records, tasks, executions, or revision.
    expect(store.getStoreData().records.size).toBe(recordsAfterSetup);
    expect(store.getStoreData().executions.size).toBe(executionsAfterSetup);
    const genericAfter = findExecution(store.getStoreData(), genericRunId)!;
    expect(genericAfter.revision).toBe(revisionBefore);
    expect(genericAfter.tasks.size).toBe(tasksBefore);
    expect(findExecution(store.getStoreData(), nativeRun)!.tasks.size).toBe(1);
  });

  test("provided-plan source canonicalization preserves identity and idempotency", () => {
    const openTool = createWorkItemOpenTool(store);
    const items = [
      {
        key: "src-task",
        title: "Src",
        mode: "delegated",
        requiredReviewers: [],
        writeScope: ["src/lib/a.ts"],
        taskId: "T-SRC",
      },
    ];
    const first = openTool.execute(
      {
        items,
        execution: {
          executionKey: "source-idem",
          source: { kind: "provided-plan", reference: " docs/plan.md ", sha256: " abc " },
          goal: "Canonicalize.",
          boundary: { files: ["src/lib/a.ts"], directories: ["src/lib/"] },
        },
      },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    ) as Record<string, unknown>;
    expect(first.ok).toBe(true);
    const runId = String(first.runId);
    expect(findExecution(store.getStoreData(), runId)!.source).toEqual({
      kind: "provided-plan",
      reference: "docs/plan.md",
      sha256: "abc",
    });

    const second = openTool.execute(
      {
        items,
        execution: {
          executionKey: "source-idem",
          source: { kind: "provided-plan", reference: "docs/plan.md", sha256: "abc" },
          goal: "Canonicalize.",
          boundary: { files: ["src/lib/a.ts"], directories: ["src/lib"] },
        },
      },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    ) as Record<string, unknown>;
    expect(second.ok).toBe(true);
    expect(second.reused).toBe(true);
    expect(second.runId).toBe(runId);
  });

  test("large valid boundaries and batches are accepted at the handler layer", () => {
    const openTool = createWorkItemOpenTool(store);
    const longPath = `src/${"a".repeat(2100)}.ts`;
    const files = [...Array.from({ length: 85 }, (_, index) => `src/dir/f${index}.ts`), longPath];
    const registered = openTool.execute(
      {
        items: files.map((file, index) => ({
          key: `bulk-${index}`,
          title: `Bulk ${index}`,
          mode: "delegated",
          requiredReviewers: [],
          writeScope: [file],
          taskId: `T-BULK-${index}`,
        })),
        execution: {
          executionKey: "bulk-run",
          source: { kind: "conversation-scoped" },
          goal: "Large boundary and batch.",
          boundary: { files, directories: [] },
        },
      },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    ) as Record<string, unknown>;
    expect(registered.ok).toBe(true);
    expect(findExecution(store.getStoreData(), String(registered.runId))!.tasks.size).toBe(
      files.length,
    );

    const standaloneItems = Array.from({ length: 70 }, (_, index) => ({
      key: `standalone-${index}`,
      title: `Standalone ${index}`,
      mode: "review_only" as const,
      requiredReviewers: ["code" as const],
    }));
    const opened = openTool.execute({ items: standaloneItems }, { sessionId: SESSION }, store) as {
      items: Array<{ ok: boolean }>;
    };
    expect(opened.items).toHaveLength(70);
    expect(opened.items.every((item) => item.ok)).toBe(true);
  });

  test("invalid boundaries reject at the handler layer with no mutation", () => {
    const openTool = createWorkItemOpenTool(store);
    const beforeExecutions = store.getStoreData().executions.size;
    const invalid = openTool.execute(
      {
        items: [
          {
            key: "bad-boundary",
            title: "Bad boundary",
            mode: "delegated",
            requiredReviewers: [],
            writeScope: ["src/a.ts"],
            taskId: "T-BAD",
          },
        ],
        execution: {
          executionKey: "bad-boundary",
          source: { kind: "conversation-scoped" },
          goal: "Invalid boundary.",
          boundary: { files: ["src/../escape.ts"], directories: [] },
        },
      },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    ) as Record<string, unknown>;
    expect(invalid.ok).toBe(false);
    expect(invalid.errorCode).toBe("INVALID_INPUT");
    expect(String(invalid.message)).toContain("execution.boundary.files[0]");
    expect(store.getStoreData().executions.size).toBe(beforeExecutions);
  });

  test("invalid authority stages/stops never reach the lookup, ledger, reserve, or eligibility", async () => {
    const registered = openGeneric({});
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const runId = String(registered.runId);
    const execution = findExecution(store.getStoreData(), runId)!;
    const workItemId = [...execution.tasks.values()][0]!.workItemId;

    let lookupCalls = 0;
    const checkpointTool = createWorkCheckpointTool(store, {
      lookupAuthorityMessage: async () => {
        lookupCalls += 1;
        return {
          messageId: "msg-authority",
          sessionId: SESSION,
          role: "user",
          createdMs: 1_000,
          ignored: false,
          syntheticOnly: false,
          textParts: ["finish autonomously"],
        };
      },
    });
    const context = { sessionId: SESSION, workspaceRoot: WORKSPACE };

    const emptySnapshot = authoritySnapshot(runId);
    expect(emptySnapshot.authorityCount).toBe(0);

    // Grant-time rejections: typo stop and mixed valid/invalid stages.
    const typoGrant = (await checkpointTool.execute(
      {
        action: "authorize",
        runId,
        authorityId: "auth-contract",
        messageId: "msg-authority",
        stages: ["implementation"],
        decisionScope: "finish",
        reservedStops: ["verificaton"],
      } as never,
      context,
      store,
    )) as Record<string, unknown>;
    expect(typoGrant.ok).toBe(false);
    expect(typoGrant.errorCode).toBe("INVALID_INPUT");
    expect(String(typoGrant.message)).toContain("reservedStops[0]");
    expect(lookupCalls).toBe(0);

    const mixedGrant = (await checkpointTool.execute(
      {
        action: "authorize",
        runId,
        authorityId: "auth-contract",
        messageId: "msg-authority",
        stages: ["implementation", "bogus-stage"],
        decisionScope: "finish",
      } as never,
      context,
      store,
    )) as Record<string, unknown>;
    expect(mixedGrant.ok).toBe(false);
    expect(String(mixedGrant.message)).toContain("stages[1]");
    expect(lookupCalls).toBe(0);
    expect(authoritySnapshot(runId)).toEqual(emptySnapshot);

    // Valid grant (positive control baseline for the later replay/extension).
    const granted = (await checkpointTool.execute(
      {
        action: "authorize",
        runId,
        authorityId: "auth-contract",
        messageId: "msg-authority",
        stages: ["implementation"],
        decisionScope: "finish",
        reservedStops: ["specification"],
      },
      context,
      store,
    )) as Record<string, unknown>;
    expect(granted.ok).toBe(true);
    expect(granted.units).toBe(3);
    expect(validateWorkflowToolResult("work_checkpoint", granted).ok).toBe(true);
    expect(lookupCalls).toBe(1);
    const grantedSnapshot = authoritySnapshot(runId);
    expect(grantedSnapshot.authorityCount).toBe(1);
    expect(grantedSnapshot.availableUnits).toBe(3);
    expect(grantedSnapshot.claims).toBe(1);

    // Exact replay is the positive control.
    const replay = (await checkpointTool.execute(
      {
        action: "authorize",
        runId,
        authorityId: "auth-contract",
        messageId: "msg-authority",
        stages: ["implementation"],
        decisionScope: "finish",
        reservedStops: ["specification"],
      },
      context,
      store,
    )) as Record<string, unknown>;
    expect(replay.ok).toBe(true);
    expect(replay.reused).toBe(true);
    expect(validateWorkflowToolResult("work_checkpoint", replay).ok).toBe(true);
    expect(authoritySnapshot(runId)).toEqual(grantedSnapshot);

    // Replay with an invalid stop/stage set is rejected before lookup.
    const callsBeforeInvalidReplay = lookupCalls;
    const invalidReplay = (await checkpointTool.execute(
      {
        action: "authorize",
        runId,
        authorityId: "auth-contract",
        messageId: "msg-authority",
        stages: ["implementation", "planning"],
        decisionScope: "finish",
        reservedStops: ["verificaton"],
      } as never,
      context,
      store,
    )) as Record<string, unknown>;
    expect(invalidReplay.ok).toBe(false);
    expect(String(invalidReplay.message)).toContain("reservedStops[0]");
    expect(lookupCalls).toBe(callsBeforeInvalidReplay);
    expect(authoritySnapshot(runId)).toEqual(grantedSnapshot);

    // Scope contradiction on replay: valid enums but a changed reserved stop.
    const contradictingReplay = (await checkpointTool.execute(
      {
        action: "authorize",
        runId,
        authorityId: "auth-contract",
        messageId: "msg-authority",
        stages: ["implementation"],
        decisionScope: "finish",
        reservedStops: [],
      },
      context,
      store,
    )) as Record<string, unknown>;
    expect(contradictingReplay.ok).toBe(false);
    expect(String(contradictingReplay.message)).toContain("reservedStops");
    expect(authoritySnapshot(runId)).toEqual(grantedSnapshot);

    // Finite extension with the identical recorded scope is the positive control.
    const extensionTool = createWorkCheckpointTool(store, {
      lookupAuthorityMessage: async () => ({
        messageId: "msg-extension",
        sessionId: SESSION,
        role: "user",
        createdMs: 5_000,
        ignored: false,
        syntheticOnly: false,
        textParts: ["extend the same scope"],
      }),
    });
    const extended = (await extensionTool.execute(
      {
        action: "authorize",
        runId,
        authorityId: "auth-contract",
        messageId: "msg-extension",
        stages: ["implementation"],
        decisionScope: "finish",
        reservedStops: ["specification"],
      },
      context,
      store,
    )) as Record<string, unknown>;
    expect(extended.ok).toBe(true);
    const extendedSnapshot = authoritySnapshot(runId);
    expect(extendedSnapshot.extensions).toBe(1);
    expect(extendedSnapshot.availableUnits).toBe(6);
    expect(validateWorkflowToolResult("work_checkpoint", extended).ok).toBe(true);

    // A valid-but-changed supplied scope cannot be ignored on the extension path.
    const changedScopeExtension = (await extensionTool.execute(
      {
        action: "authorize",
        runId,
        authorityId: "auth-contract",
        messageId: "msg-extension-3",
        stages: ["implementation", "verification"],
        decisionScope: "finish",
        reservedStops: ["specification"],
      } as never,
      context,
      store,
    )) as Record<string, unknown>;
    expect(changedScopeExtension.ok).toBe(false);
    expect(String(changedScopeExtension.message)).toContain("stages");
    expect(authoritySnapshot(runId)).toEqual(extendedSnapshot);

    // Mixed stages on the extension path never claim a message or extend.
    const invalidExtension = (await extensionTool.execute(
      {
        action: "authorize",
        runId,
        authorityId: "auth-contract",
        messageId: "msg-extension-2",
        stages: ["implementation", "bogus-stage"],
        decisionScope: "finish",
      } as never,
      context,
      store,
    )) as Record<string, unknown>;
    expect(invalidExtension.ok).toBe(false);
    expect(String(invalidExtension.message)).toContain("stages[1]");
    expect(authoritySnapshot(runId)).toEqual(extendedSnapshot);
    expect(store.getStoreData().messageClaims.has("msg-extension-2")).toBe(false);

    // Launch eligibility and attempt state remain untouched by rejected authority calls.
    const launchable = isTaskLaunchableInStore(store.getStoreData(), {
      sessionId: SESSION,
      runId,
      taskId: "T-100",
    });
    expect(launchable.ok).toBe(true);
    const record = store.getStoreData().records.get(`${SESSION}::${workItemId}`);
    expect(record?.delegated?.attempts ?? []).toHaveLength(0);

    // Approval with an invalid stage never records an approval or reaches lookup.
    const invalidApproval = (await checkpointTool.execute(
      {
        action: "record_approval",
        runId,
        authorityId: "auth-contract",
        approvalId: "appr-contract",
        stage: "publication",
        artifactPath: "src/lib/a.ts",
        artifactSha256: "hash",
      } as never,
      context,
      store,
    )) as Record<string, unknown>;
    expect(invalidApproval.ok).toBe(false);
    expect(String(invalidApproval.message)).toContain("stage");
    expect(findExecution(store.getStoreData(), runId)!.stageApprovals).toHaveLength(0);

    // Valid approval is retained as the positive control for stage semantics.
    const approval = (await checkpointTool.execute(
      {
        action: "record_approval",
        runId,
        authorityId: "auth-contract",
        approvalId: "appr-contract",
        stage: "implementation",
        artifactPath: "src/lib/a.ts",
        artifactSha256: "hash",
      },
      context,
      store,
    )) as Record<string, unknown>;
    expect(approval.ok).toBe(true);
    expect(findExecution(store.getStoreData(), runId)!.stageApprovals).toHaveLength(1);
    expect(validateWorkflowToolResult("work_checkpoint", approval).ok).toBe(true);
    const afterApproval = authoritySnapshot(runId);
    expect(afterApproval.reserveDebits).toBe(0);
    expect(afterApproval.revocations).toBe(0);

    // Revoke with mixed valid/invalid narrowing stages changes nothing.
    const invalidRevoke = (await checkpointTool.execute(
      {
        action: "revoke_authority",
        runId,
        authorityId: "auth-contract",
        revocationId: "revoke-contract",
        stages: ["verification", "bogus-stage"],
      } as never,
      context,
      store,
    )) as Record<string, unknown>;
    expect(invalidRevoke.ok).toBe(false);
    expect(String(invalidRevoke.message)).toContain("stages[1]");
    expect(authoritySnapshot(runId)).toEqual(afterApproval);

    // Valid replay after all rejected attempts still reflects the recorded scope.
    const finalReplay = (await checkpointTool.execute(
      {
        action: "authorize",
        runId,
        authorityId: "auth-contract",
        messageId: "msg-authority",
        stages: ["implementation"],
        decisionScope: "finish",
        reservedStops: ["specification"],
      },
      context,
      store,
    )) as Record<string, unknown>;
    expect(finalReplay.ok).toBe(true);
    expect(finalReplay.reused).toBe(true);
    expect(validateWorkflowToolResult("work_checkpoint", finalReplay).ok).toBe(true);

    // A valid narrowing revocation is a distinct concrete variant.
    const narrowed = (await checkpointTool.execute(
      {
        action: "revoke_authority",
        runId,
        authorityId: "auth-contract",
        revocationId: "revoke-contract-narrow",
        stages: ["implementation"],
      },
      context,
      store,
    )) as Record<string, unknown>;
    expect(narrowed.ok).toBe(true);
    expect(narrowed.kind).toBe("narrow");
    expect(validateWorkflowToolResult("work_checkpoint", narrowed).ok).toBe(true);
  });
});
// END_BLOCK_CONTRACT_REGRESSIONS

// START_BLOCK_INSTRUCTION_AUDIT
// Deterministic instruction-delivery audit over the assembled primary guidance,
// discovery metadata, and loaded skill bodies. It asserts that the delivered
// rules enable each planned scenario and that conflicting old directions are
// gone. It is an instruction contract check, never a measurement of model
// behavior or compliance.
describe("instruction scenario audit", () => {
  const templatesDir = join(import.meta.dir, "../../templates");

  async function skillBody(name: ManagedSkillName): Promise<string> {
    const template = await loadManagedSkillTemplate(name);
    const match = template.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
    return (match ? match[1] : template).replace(/\s+/g, " ");
  }

  test("controller guidance separates ownership, source, and authority and drops the universal gate", () => {
    const controller = readFileSync(join(templatesDir, "agents/vv-controller.md"), "utf8").replace(
      /\s+/g,
      " ",
    );
    expect(controller).toContain("<source_and_authority>");
    expect(controller).not.toContain("<large_feature_gate>");
    expect(controller).toContain("not a universal prerequisite");
    expect(controller).toContain("do not install a universal final-review pair");
    expect(controller).toContain("Honor explicitly delegated autonomy");
  });

  test("native skill discovery marks the specialized package boundary", async () => {
    const spec = await loadManagedSkillTemplate("vv-spec");
    expect(spec).toContain("Use when the user explicitly selects the native spec-package workflow");
    expect(spec).not.toContain("Use BEFORE any implementation or planning");
    const plan = await loadManagedSkillTemplate("vv-plan");
    expect(plan).toContain("recorded delegated authority");
    const execute = await skillBody("vv-execute");
    expect(execute).toContain(
      "A provided plan or conversation-scoped execution stays on its own source",
    );
    expect(execute).toContain("advance authority");
    const review = await skillBody("vv-review");
    expect(review).toContain("findings");
  });

  test("profile policies carry source and authority guidance without leaking other profiles", () => {
    const delegated = resolveOrchestrationPolicy({
      orchestration: { profile: "delegated" },
    }).controllerSystemContext.replace(/\s+/g, " ");
    expect(delegated).toContain(
      "work_checkpoint register accepts only its supported approved native package",
    );
    expect(delegated).toContain(
      "provided plan or conversation-scoped run registers through work_item_open",
    );
    expect(delegated).toContain("recorded advance authority");
    const single = resolveOrchestrationPolicy({
      orchestration: { profile: "single-session" },
    }).controllerSystemContext.replace(/\s+/g, " ");
    expect(single).not.toContain("work_item_open with an execution descriptor");
  });

  test("scenario enabling rules are present for no-files, reserved-stop, and publication-bound runs", async () => {
    const controller = readFileSync(join(templatesDir, "agents/vv-controller.md"), "utf8");
    // Discussion/review requests must not become implementation; reserved stops stay binding.
    expect(controller).toContain("user-reserved stops");
    expect(controller).toContain("host permissions");
    // Provided-plan and conversation-scoped sources need no native package.
    expect(controller).toContain("do not invent a native package");
    // Review-only requests remain findings rather than implementation.
    const review = await skillBody("vv-review");
    expect(review).toContain("findings");
  });
});
// END_BLOCK_INSTRUCTION_AUDIT
