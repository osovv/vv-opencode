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
import {
  createWorkCheckpointTool,
  createWorkItemDecideTool,
  createWorkItemOpenTool,
} from "./workflow/tooling.js";
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

    const reviewed = (await checkpointTool.execute(
      { action: "review", runId, checkpointId: "review-T-100", reviewer: "code", status: "PASS" },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    )) as Record<string, unknown>;
    expect(reviewed.ok).toBe(true);
    expect(reviewed.outcome).toBe("passed");

    const completed = (await checkpointTool.execute(
      { action: "complete", runId, rationale: "Tool-driven completion." },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    )) as Record<string, unknown>;
    expect(completed.ok).toBe(true);
    expect(completed.reviewStatus).toBe("independently_reviewed");

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
    await checkpointTool.execute(
      { action: "start", runId, checkpointId: "review-T-100" },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    );
    await checkpointTool.execute(
      { action: "review", runId, checkpointId: "review-T-100", reviewer: "code", status: "FAIL" },
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
    await checkpointTool.execute(
      { action: "start", runId, checkpointId: "review-T-100" },
      { sessionId: SESSION, workspaceRoot: WORKSPACE },
      store,
    );
    await checkpointTool.execute(
      { action: "review", runId, checkpointId: "review-T-100", reviewer: "code", status: "PASS" },
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
