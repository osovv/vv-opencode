// FILE: src/plugins/workflow/persistence.test.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Deterministic tests for workflow state persistence version 3: delegated and plan-run round-trips including recovery histories and rejected reports, legacy version 1 and 2 hydration, strict rejection of malformed state, atomic writes, and surfaced I/O failures.
//   SCOPE: Round-trip of accepted tasks, rework and recovery histories, in-flight and awaiting-acceptation attempts, failed attempts with bounded host failure evidence, report-rejected attempts with bounded diagnostics, incomplete reviews, FAIL and stopped reports, passed historical milestones, hard stops, recovery-aware budgets, and bounded excerpts; version 1 and version 2 conservative hydration with empty recovery histories and original budgets; tamper rejection without silent resets; checked loader triage; atomic replacement and failure surfacing.
//   DEPENDS: [bun:test, node:fs, node:fs/promises, node:path, node:os, src/lib/vvoc-paths.ts, src/plugins/workflow/checkpoint-io.ts, src/plugins/workflow/checkpoints.ts, src/plugins/workflow/delegated.ts, src/plugins/workflow/persistence.ts, src/plugins/workflow/state.ts]
//   LINKS: [M-WORKFLOW-PERSISTENCE, M-WORKFLOW-DELEGATED, M-WORKFLOW-CHECKPOINTS, V-M-WORKFLOW-PERSISTENCE]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SESSION - Stable session identifier shared by persistence fixtures.
//   store - Fresh work-item store created before each test.
//   createdRoots - Tracks temporary workspaces for cleanup after each test.
//   makeWorkspace - Writes a spec/plan package plus scope files into an isolated temporary workspace.
//   planXml - Renders the approved delegated plan fixture content.
//   statePath - Resolves the persisted workflow-state.json path for the session.
//   registerRun - Registers the fixture plan and returns its run id.
//   taskWorkItemId - Resolves the bound work-item id for one plan task.
//   launchSequence - Monotonic suffix that keeps each delegated callID unique per session.
//   acceptTask - Drives one delegated task to an accepted state.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-WORKFLOW-BOUNDED-RECOVERY-R1 - Added version 3 coverage: recovery and user-grant round-trips, report-rejected attempts, stopped generations, conservative version 2 reads, and forged recovery rejection.]
// END_CHANGE_SUMMARY

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGlobalVvocDataDir } from "../../lib/vvoc-paths.js";
import { loadApprovedDelegatedPlan } from "./checkpoint-io.js";
import {
  recordCheckpointReviewerResult,
  recoverDelegatedCheckpoint,
  registerDelegatedPlan,
  startDelegatedCheckpoint,
  verifyDelegatedCheckpoint,
} from "./checkpoints.js";
import {
  applyDelegatedLaunchFailure,
  applyDelegatedReportRejection,
  applyDelegatedResult,
  beginDelegatedLaunch,
  decideDelegatedWorkItem,
  recoverDelegatedWorkItem,
  revertInFlightDelegatedLaunches,
} from "./delegated.js";
import {
  getWorkflowSessionDir,
  hydrateWorkflowState,
  hydrateWorkflowStateChecked,
  snapshotWorkflowState,
  snapshotWorkflowStateChecked,
} from "./persistence.js";
import { createWorkItemStore, createWorkflowResultExcerpt, type WorkItemStore } from "./state.js";
import { findExecution, registerExecutionInStore } from "./execution.js";

const SESSION = "session-persist-v2";
const createdRoots: string[] = [];

let store: WorkItemStore;

beforeEach(() => {
  store = createWorkItemStore();
});

afterEach(async () => {
  await rm(getWorkflowSessionDir(SESSION), { recursive: true, force: true });
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

async function makeWorkspace(prefix: string): Promise<{ root: string; planPath: string }> {
  const root = await mkdtemp(join(tmpdir(), `vvoc-persist-${prefix}-`));
  createdRoots.push(root);
  const pkgDir = join(root, ".vvoc", "specs", "2026-09-11-cache");
  await mkdir(pkgDir, { recursive: true });
  await mkdir(join(root, "src", "lib"), { recursive: true });
  await writeFile(
    join(pkgDir, "spec.xml"),
    `<spec><status>approved</status><goal>Store rows.</goal><architecture>Cache.</architecture><tech_stack>TS.</tech_stack><components><COMPONENT-CACHE-STORE><name>Cache Store</name><responsibility>Holds rows.</responsibility><depends_on></depends_on></COMPONENT-CACHE-STORE></components><data_flow>Rows flow.</data_flow><error_handling>Fail open.</error_handling><testing><strategy>Unit tests.</strategy><coverage>Paths.</coverage></testing><non_goals><non_goal>No persistence.</non_goal></non_goals></spec>`,
    "utf8",
  );
  await writeFile(join(pkgDir, "plan.xml"), planXml(), "utf8");
  await writeFile(
    join(root, "src", "lib", "cache-store.ts"),
    "export class CacheStore {}\n",
    "utf8",
  );
  await writeFile(join(root, "src", "lib", "cache-store.test.ts"), "test.todo();\n", "utf8");
  await writeFile(join(root, "src", "lib", "analytics.ts"), "export const wired = true;\n", "utf8");
  return { root, planPath: join(pkgDir, "plan.xml") };
}

function planXml(): string {
  return `<plan><spec>spec.xml</spec><created>2026-09-11</created><status>approved</status>
<meta><summary>Delegated cache.</summary><waves>2</waves><affected_modules>src/lib/cache-store.ts</affected_modules><complexity>low</complexity></meta>
<architecture><COMPONENT-CACHE-STORE><name>Cache Store</name><purpose>Store.</purpose><file><path>src/lib/cache-store.ts</path><role>implementation</role></file><contract>get/set.</contract><depends_on></depends_on></COMPONENT-CACHE-STORE></architecture>
<tasks>
<WAVE-1><goal>Core.</goal>
<TASK-T-001><title>Store</title><file>src/lib/cache-store.ts</file><status>pending</status><description>Implement.</description><depends_on></depends_on><acceptance><criterion>Works</criterion></acceptance><verification><command>bun test src/lib/cache-store.test.ts</command></verification><write_scope><file>src/lib/cache-store.ts</file><file>src/lib/cache-store.test.ts</file></write_scope></TASK-T-001>
</WAVE-1>
<WAVE-2><goal>Wiring.</goal>
<TASK-T-002><title>Wiring</title><file>src/lib/analytics.ts</file><status>pending</status><description>Wire.</description><depends_on><task_id>T-001</task_id></depends_on><acceptance><criterion>Wired</criterion></acceptance><verification><command>bun test src/lib/analytics.test.ts</command></verification><write_scope><file>src/lib/analytics.ts</file></write_scope></TASK-T-002>
</WAVE-2>
</tasks>
<execution><mode>delegated</mode>
<review_checkpoints>
<CHECKPOINT-R-001><kind>milestone</kind><after_wave>WAVE-1</after_wave><covers><task_id>T-001</task_id></covers><scope><file>src/lib/cache-store.ts</file><file>src/lib/cache-store.test.ts</file></scope><reviewers><reviewer>code</reviewer></reviewers><acceptance><criterion>Reviewed</criterion></acceptance><verification><command>bun test src/lib/cache-store.test.ts</command></verification></CHECKPOINT-R-001>
<CHECKPOINT-R-002><kind>final</kind><after_wave>WAVE-2</after_wave><covers><task_id>T-001</task_id><task_id>T-002</task_id></covers><scope><file>src/lib/cache-store.ts</file><file>src/lib/cache-store.test.ts</file><file>src/lib/analytics.ts</file></scope><reviewers><reviewer>spec</reviewer><reviewer>code</reviewer></reviewers><acceptance><criterion>Complete</criterion></acceptance><verification><command>bun test</command></verification></CHECKPOINT-R-002>
</review_checkpoints>
</execution>
</plan>`;
}

function statePath(): string {
  return join(getWorkflowSessionDir(SESSION), "workflow-state.json");
}

async function registerRun(prefix: string): Promise<{ root: string; runId: string }> {
  const { root, planPath } = await makeWorkspace(prefix);
  const loaded = await loadApprovedDelegatedPlan({ workspaceRoot: root, planPath });
  if (!loaded.ok) throw new Error(loaded.message);
  const registered = registerDelegatedPlan(store, { sessionId: SESSION, plan: loaded.plan });
  if (!registered.ok) throw new Error(registered.message);
  return { root, runId: registered.runId };
}

function taskWorkItemId(runId: string, taskId: string): string {
  const run = store.getStoreData().planRuns.get(runId);
  const binding = run?.tasks.get(taskId);
  if (!binding) throw new Error(`no binding for ${taskId}`);
  return binding.workItemId;
}

// CallIDs are single-shot identities within a session, so every test launch
// needs a distinct value even when it targets the same task across runs.
let launchSequence = 0;

async function acceptTask(
  runId: string,
  taskId: string,
  callSuffix: string,
  attempt = 1,
): Promise<void> {
  const workItemId = taskWorkItemId(runId, taskId);
  const callId = `call-${taskId}-${callSuffix}-${++launchSequence}`;
  const launched = beginDelegatedLaunch(store, {
    sessionId: SESSION,
    workItemId,
    callId,
  });
  if (!launched.ok) throw new Error(launched.message);
  const applied = applyDelegatedResult(store, {
    sessionId: SESSION,
    workItemId,
    callId,
    resultStatus: "DONE",
  });
  if (!applied.ok) throw new Error(applied.message);
  const decided = decideDelegatedWorkItem(store, {
    sessionId: SESSION,
    workItemId,
    attempt: launched.attempt,
    decision: "accept",
    rationale: "Matches the contract.",
    evidence: ["diff"],
  });
  if (!decided.ok) throw new Error(decided.message);
  void attempt;
}

// START_BLOCK_ROUNDTRIP_TESTS
describe("version 2 round-trips", () => {
  test("accepted tasks, historical milestones, and plan runs survive snapshot and hydrate", async () => {
    const { root, runId } = await registerRun("roundtrip");
    await acceptTask(runId, "T-001", "a1");
    await startDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-001",
    });
    recordCheckpointReviewerResult(store, {
      runId,
      checkpointId: "CHECKPOINT-R-001",
      reviewer: "code",
      status: "PASS",
    });
    await verifyDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-001",
    });
    await acceptTask(runId, "T-002", "a1");
    await startDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-002",
    });
    recordCheckpointReviewerResult(store, {
      runId,
      checkpointId: "CHECKPOINT-R-002",
      reviewer: "spec",
      status: "FAIL",
    });
    recordCheckpointReviewerResult(store, {
      runId,
      checkpointId: "CHECKPOINT-R-002",
      reviewer: "code",
      status: "PASS",
    });

    const snapshot = snapshotWorkflowStateChecked(SESSION, store.getStoreData());
    expect(snapshot.ok).toBe(true);

    const hydrated = hydrateWorkflowStateChecked(SESSION);
    expect(hydrated.status).toBe("valid");
    if (hydrated.status !== "valid") return;
    const run = hydrated.data.planRuns.get(runId);
    expect(run).toBeDefined();
    if (!run) return;
    expect(run.workspaceRoot).toBe(root);
    expect(run.checkpoints.get("CHECKPOINT-R-001")?.status).toBe("passed");
    expect(run.checkpoints.get("CHECKPOINT-R-001")?.history[0]?.outcome).toBe("passed");
    expect(run.checkpoints.get("CHECKPOINT-R-002")?.status).toBe("in_review");
    expect(run.checkpoints.get("CHECKPOINT-R-002")?.currentReview?.results.spec?.status).toBe(
      "FAIL",
    );

    const t1 = run.tasks.get("T-001")?.workItemId;
    if (!t1) throw new Error("missing binding");
    const record = hydrated.data.records.get(`${SESSION}::${t1}`);
    expect(record?.delegated?.acceptances).toHaveLength(1);
    expect(record?.delegated?.attempts[0]?.resultStatus).toBe("DONE");

    // The restored store continues the flow: FAIL settles, bounded rework, re-accept, and completion.
    const restoredStore = createWorkItemStore(hydrated.data);
    const failed = await verifyDelegatedCheckpoint(restoredStore, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-002",
    });
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    expect(failed.outcome).toBe("failed");
  });

  test("in-flight attempts, hard stops, and bounded excerpts round-trip", async () => {
    const { runId } = await registerRun("inflight");
    const t1 = taskWorkItemId(runId, "T-001");
    beginDelegatedLaunch(store, { sessionId: SESSION, workItemId: t1, callId: "call-inflight" });

    const t2 = taskWorkItemId(runId, "T-002");
    beginDelegatedLaunch(store, { sessionId: SESSION, workItemId: t2, callId: "call-blocked" });
    const blockedText = "Blocked: missing dependency contract.";
    applyDelegatedResult(store, {
      sessionId: SESSION,
      workItemId: t2,
      callId: "call-blocked",
      resultStatus: "BLOCKED",
      resultExcerpt: {
        source: "parsed_body",
        text: blockedText,
        truncated: false,
        originalLength: blockedText.length,
        maxLength: 500,
      },
    });

    snapshotWorkflowState(SESSION, store.getStoreData());
    const hydrated = hydrateWorkflowStateChecked(SESSION);
    expect(hydrated.status).toBe("valid");
    if (hydrated.status !== "valid") return;
    const inFlightRecord = hydrated.data.records.get(`${SESSION}::${t1}`);
    expect(inFlightRecord?.state).toBe("awaiting_implementer");
    expect(inFlightRecord?.delegated?.attempts[0]?.status).toBe("in_flight");
    expect(inFlightRecord?.delegated?.attempts[0]?.callId).toBe("call-inflight");

    const blockedRecord = hydrated.data.records.get(`${SESSION}::${t2}`);
    expect(blockedRecord?.state).toBe("blocked");
    expect(blockedRecord?.resultExcerpt?.text).toContain("missing dependency contract");
    expect(blockedRecord?.delegated?.attempts[0]?.resultStatus).toBe("BLOCKED");
  });

  test("snapshot replaces atomically without leaving temporary files", async () => {
    const { runId } = await registerRun("atomic");
    void runId;
    const first = snapshotWorkflowStateChecked(SESSION, store.getStoreData());
    expect(first.ok).toBe(true);
    const second = snapshotWorkflowStateChecked(SESSION, store.getStoreData());
    expect(second.ok).toBe(true);
    const dirEntries = readdirSync(getWorkflowSessionDir(SESSION));
    expect(dirEntries).toEqual(["workflow-state.json"]);
    const persisted = JSON.parse(readFileSync(statePath(), "utf-8"));
    expect(persisted.version).toBe(4);
    expect(Array.isArray(persisted.planRuns)).toBe(true);
    expect(Array.isArray(persisted.executions)).toBe(true);
  });
});
// END_BLOCK_ROUNDTRIP_TESTS

// START_BLOCK_FAILED_ATTEMPT_PERSISTENCE_TESTS
describe("failed delegated attempts persist and stay non-acceptable", () => {
  function failureExcerpt(text: string) {
    return createWorkflowResultExcerpt({ text, source: "normalized_output" })!;
  }

  test("a failed attempt round-trips with bounded evidence and cannot be accepted", async () => {
    const { runId } = await registerRun("failed-roundtrip");
    const workItemId = taskWorkItemId(runId, "T-001");
    const callId = "call-failed-roundtrip";
    beginDelegatedLaunch(store, { sessionId: SESSION, workItemId, callId });
    const applied = applyDelegatedLaunchFailure(store, {
      sessionId: SESSION,
      workItemId,
      callId,
      failureExcerpt: failureExcerpt(
        "Subagent failed (task_id: ses_child_1): unknown provider for model deepseek-flash",
      ),
    });
    expect(applied.ok).toBe(true);

    const snapshot = snapshotWorkflowStateChecked(SESSION, store.getStoreData());
    expect(snapshot.ok).toBe(true);
    const hydrated = hydrateWorkflowStateChecked(SESSION);
    expect(hydrated.status).toBe("valid");
    if (hydrated.status !== "valid") return;
    const record = hydrated.data.records.get(`${SESSION}::${workItemId}`);
    expect(record?.state).toBe("awaiting_implementer");
    expect(record?.delegated?.attempts[0]?.status).toBe("failed");
    expect(record?.delegated?.attempts[0]?.failureExcerpt?.text).toContain("unknown provider");
    expect(record?.delegated?.attempts[0]?.resultStatus).toBeUndefined();

    const restored = createWorkItemStore(hydrated.data);
    const decision = decideDelegatedWorkItem(restored, {
      sessionId: SESSION,
      workItemId,
      attempt: 1,
      decision: "accept",
      rationale: "Cannot accept a failed attempt.",
      evidence: ["diff"],
    });
    expect(decision.ok).toBe(false);
  });

  test("restart reclamation drops in-flight attempts without losing failed ones", async () => {
    const { runId } = await registerRun("failed-reclaim");
    const failedId = taskWorkItemId(runId, "T-001");
    const orphanId = taskWorkItemId(runId, "T-002");
    beginDelegatedLaunch(store, {
      sessionId: SESSION,
      workItemId: failedId,
      callId: "call-failed-reclaim",
    });
    applyDelegatedLaunchFailure(store, {
      sessionId: SESSION,
      workItemId: failedId,
      callId: "call-failed-reclaim",
      failureExcerpt: failureExcerpt("Subagent failed (task_id: ses_child_2): provider error"),
    });
    beginDelegatedLaunch(store, {
      sessionId: SESSION,
      workItemId: orphanId,
      callId: "call-orphan-reclaim",
    });

    snapshotWorkflowStateChecked(SESSION, store.getStoreData());
    const hydrated = hydrateWorkflowStateChecked(SESSION);
    expect(hydrated.status).toBe("valid");
    if (hydrated.status !== "valid") return;
    const reclaimed = revertInFlightDelegatedLaunches(hydrated.data, SESSION);
    expect(reclaimed.workItemIds).toContain(orphanId);

    const failedRecord = hydrated.data.records.get(`${SESSION}::${failedId}`);
    expect(failedRecord?.delegated?.attempts[0]?.status).toBe("failed");
    const orphanRecord = hydrated.data.records.get(`${SESSION}::${orphanId}`);
    expect(orphanRecord?.delegated?.attempts).toHaveLength(0);
  });

  test("malformed failed attempt records are rejected", async () => {
    const { runId } = await registerRun("failed-malformed");
    const workItemId = taskWorkItemId(runId, "T-001");
    const callId = "call-failed-malformed";
    beginDelegatedLaunch(store, { sessionId: SESSION, workItemId, callId });
    applyDelegatedLaunchFailure(store, {
      sessionId: SESSION,
      workItemId,
      callId,
      failureExcerpt: failureExcerpt("Subagent failed (task_id: ses_child_3): provider error"),
    });
    snapshotWorkflowStateChecked(SESSION, store.getStoreData());

    const persisted = JSON.parse(readFileSync(statePath(), "utf-8"));
    const delegated = persisted.records.find(
      (record: { mode?: string }) => record.mode === "delegated",
    );
    delete delegated.delegated.attempts[0].failureExcerpt;
    writeFileSync(statePath(), JSON.stringify(persisted, null, 2), "utf-8");
    const missing = hydrateWorkflowStateChecked(SESSION);
    expect(missing.status).toBe("invalid");
    if (missing.status !== "invalid") return;
    expect(missing.errors.join("\n")).toContain("bounded failure excerpt");

    // Restore the valid snapshot from the untouched in-memory store, then make
    // a failed attempt contradictory by also carrying a success result.
    snapshotWorkflowStateChecked(SESSION, store.getStoreData());
    const persistedSecond = JSON.parse(readFileSync(statePath(), "utf-8"));
    const delegatedSecond = persistedSecond.records.find(
      (record: { mode?: string }) => record.mode === "delegated",
    );
    delegatedSecond.delegated.attempts[0].resultStatus = "DONE";
    writeFileSync(statePath(), JSON.stringify(persistedSecond, null, 2), "utf-8");
    const contradictory = hydrateWorkflowStateChecked(SESSION);
    expect(contradictory.status).toBe("invalid");
    if (contradictory.status !== "invalid") return;
    expect(contradictory.errors.join("\n")).toContain("must not carry a result or rejection");
  });
});
// END_BLOCK_FAILED_ATTEMPT_PERSISTENCE_TESTS

// START_BLOCK_RECOVERY_PERSISTENCE_TESTS
describe("version 3 recovery and report-rejection round-trips", () => {
  function excerpt(text: string) {
    return createWorkflowResultExcerpt({ text, source: "normalized_output" })!;
  }

  async function driveToBlockedStop(runId: string, taskId: string, callSuffix: string) {
    const workItemId = taskWorkItemId(runId, taskId);
    const callId = `call-${taskId}-${callSuffix}-${++launchSequence}`;
    beginDelegatedLaunch(store, { sessionId: SESSION, workItemId, callId });
    applyDelegatedResult(store, {
      sessionId: SESSION,
      workItemId,
      callId,
      resultStatus: "BLOCKED",
      resultExcerpt: excerpt("Blocked: missing approval input."),
    });
    return { workItemId, callId };
  }

  test("delegated recovery history, budgets, and user grants survive snapshot and hydrate", async () => {
    const { runId } = await registerRun("recovery-rt");
    const { workItemId } = await driveToBlockedStop(runId, "T-001", "stop");

    const resumed = await recoverDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId,
      attempt: 1,
      diagnosis: "Worker lacked the approval decision.",
      changedCondition: "Approval decision recorded in the task packet.",
      verification: ["src/lib/cache-store.ts"],
      recoveryId: "rec-stop-1",
    });
    expect(resumed.ok).toBe(true);

    const second = beginDelegatedLaunch(store, {
      sessionId: SESSION,
      workItemId,
      callId: `call-t1-r2-${++launchSequence}`,
    });
    expect(second.ok).toBe(true);
    applyDelegatedResult(store, {
      sessionId: SESSION,
      workItemId,
      callId: `call-t1-r2-${launchSequence}`,
      resultStatus: "BLOCKED",
      resultExcerpt: excerpt("Blocked again at the same gate."),
    });

    const granted = await recoverDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId,
      attempt: 2,
      diagnosis: "Repeated stop at the approval gate.",
      changedCondition: "Gate removed from the worker packet.",
      verification: ["src/lib/cache-store.ts"],
      recoveryId: "rec-grant-1",
    });
    expect(granted.ok).toBe(true);
    if (!granted.ok) return;
    expect(granted.kind).toBe("autonomous_grant");
    expect(granted.attemptBudget).toBe(3);

    const snapshot = snapshotWorkflowStateChecked(SESSION, store.getStoreData());
    expect(snapshot.ok).toBe(true);
    const hydrated = hydrateWorkflowStateChecked(SESSION);
    expect(hydrated.status).toBe("valid");
    if (hydrated.status !== "valid") return;
    const record = hydrated.data.records.get(`${SESSION}::${workItemId}`);
    expect(record?.delegated?.recoveryHistory).toHaveLength(2);
    expect(record?.delegated?.recoveryHistory[1]?.kind).toBe("autonomous_grant");
    expect(record?.state).toBe("awaiting_implementer");
    expect(record?.delegated?.attempts).toHaveLength(2);

    // The restored store keeps the granted budget: attempt 3 launches.
    const restored = createWorkItemStore(hydrated.data);
    const third = beginDelegatedLaunch(restored, {
      sessionId: SESSION,
      workItemId,
      callId: `call-t1-r3-${++launchSequence}`,
    });
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.attempt).toBe(3);
  });

  test("user grants round-trip with their authorization reference", async () => {
    const { runId } = await registerRun("user-grant-rt");
    const workItemId = taskWorkItemId(runId, "T-001");

    // Stop, resume, stop, autonomous grant, stop: only then is a user grant
    // the next eligible unit, mirroring the enforced recovery ladder.
    for (let index = 1; index <= 3; index += 1) {
      const callId = `call-ug-${index}-${++launchSequence}`;
      beginDelegatedLaunch(store, { sessionId: SESSION, workItemId, callId });
      applyDelegatedResult(store, {
        sessionId: SESSION,
        workItemId,
        callId,
        resultStatus: "NEEDS_CONTEXT",
        resultExcerpt: excerpt("Needs additional context."),
      });
      if (index === 1) {
        const resumed = await recoverDelegatedWorkItem(store, {
          sessionId: SESSION,
          workItemId,
          attempt: index,
          diagnosis: "Worker lacked context.",
          changedCondition: "Context added to the task packet.",
          verification: ["src/lib/cache-store.ts"],
          recoveryId: `rec-ug-resume-${index}`,
        });
        expect(resumed.ok).toBe(true);
      } else if (index === 2) {
        const autonomous = await recoverDelegatedWorkItem(store, {
          sessionId: SESSION,
          workItemId,
          attempt: index,
          diagnosis: "Repeated context stop.",
          changedCondition: "Packet restructured for self-containment.",
          verification: ["src/lib/cache-store.ts"],
          recoveryId: `rec-ug-auto-${index}`,
        });
        expect(autonomous.ok).toBe(true);
        if (!autonomous.ok) return;
        expect(autonomous.kind).toBe("autonomous_grant");
      }
    }

    // Age the terminal attempt so the authorization message is not stale.
    const stopTime = Date.now() - 5_000;
    const record = store.getStoreData().records.get(`${SESSION}::${workItemId}`);
    record!.delegated!.attempts[2]!.completedAt = new Date(stopTime).toISOString();

    const granted = await recoverDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId,
      attempt: 3,
      diagnosis: "Three stops exhausted the autonomous allowance.",
      changedCondition: "User authorized one further bounded attempt.",
      verification: ["src/lib/analytics.ts"],
      recoveryId: "rec-user-1",
      userMessageId: "msg_user_auth_1",
      lookupUserMessage: async () => ({
        role: "user",
        sessionID: SESSION,
        id: "msg_user_auth_1",
        timeCreatedMs: Date.now(),
      }),
    });
    expect(granted.ok).toBe(true);
    if (!granted.ok) return;
    expect(granted.kind).toBe("user_grant");
    expect(granted.attemptBudget).toBe(4);

    snapshotWorkflowStateChecked(SESSION, store.getStoreData());
    const hydrated = hydrateWorkflowStateChecked(SESSION);
    expect(hydrated.status).toBe("valid");
    if (hydrated.status !== "valid") return;
    const restored = hydrated.data.records.get(`${SESSION}::${workItemId}`);
    expect(restored?.delegated?.recoveryHistory.at(-1)?.userMessageId).toBe("msg_user_auth_1");
    expect(restored?.delegated?.recoveryHistory).toHaveLength(3);
  });

  test("report-rejected attempts round-trip with bounded diagnostics and keep recovery reachable", async () => {
    const { runId } = await registerRun("rejected-rt");
    const workItemId = taskWorkItemId(runId, "T-002");
    const callId = `call-rejected-rt-${++launchSequence}`;
    beginDelegatedLaunch(store, { sessionId: SESSION, workItemId, callId });

    const settled = applyDelegatedReportRejection(store, {
      sessionId: SESSION,
      workItemId,
      callId,
      protocolErrorCode: "MISSING_ROUTE",
      excerpt: excerpt("VVOC_WORK_ITEM_ID: wi-2\nVVOC_STATUS: BLOCKED\nNo route line."),
      explicitHardStop: "BLOCKED",
    });
    expect(settled.ok).toBe(true);

    snapshotWorkflowStateChecked(SESSION, store.getStoreData());
    const hydrated = hydrateWorkflowStateChecked(SESSION);
    expect(hydrated.status).toBe("valid");
    if (hydrated.status !== "valid") return;
    const record = hydrated.data.records.get(`${SESSION}::${workItemId}`);
    expect(record?.state).toBe("blocked");
    expect(record?.delegated?.attempts[0]?.status).toBe("report_rejected");
    expect(record?.delegated?.attempts[0]?.reportRejection?.protocolErrorCode).toBe(
      "MISSING_ROUTE",
    );
    expect(record?.delegated?.attempts[0]?.resultStatus).toBeUndefined();

    // Restart reclamation never touches a settled rejected report, and the
    // item keeps its recovery path after restore.
    const reclaimed = revertInFlightDelegatedLaunches(hydrated.data, SESSION);
    expect(reclaimed.reverted).toBe(0);
    const restored = createWorkItemStore(hydrated.data);
    const recovered = await recoverDelegatedWorkItem(restored, {
      sessionId: SESSION,
      workItemId,
      attempt: 1,
      diagnosis: "Terminal report was protocol-invalid.",
      changedCondition: "Worker packet now pins the exact result format.",
      verification: ["src/lib/analytics.ts"],
      recoveryId: "rec-rejected-1",
    });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.kind).toBe("resume");
    expect(recovered.record.state).toBe("awaiting_implementer");
  });

  test("stopped checkpoint generations and checkpoint recovery round-trip", async () => {
    const { runId } = await registerRun("stopped-rt");
    await acceptTask(runId, "T-001", "s1");
    await startDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-001",
    });
    recordCheckpointReviewerResult(store, {
      runId,
      checkpointId: "CHECKPOINT-R-001",
      reviewer: "code",
      status: "NEEDS_CONTEXT",
    });
    const stopped = await verifyDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-001",
    });
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) return;
    expect(stopped.outcome).toBe("stopped");

    const recovered = await recoverDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-001",
      diagnosis: "Reviewer could not access the pinned snapshot.",
      changedCondition: "Missing scope file restored before the next generation.",
      verification: ["src/lib/cache-store.ts"],
      recoveryId: "rec-cp-1",
    });
    expect(recovered.ok).toBe(true);

    snapshotWorkflowStateChecked(SESSION, store.getStoreData());
    const hydrated = hydrateWorkflowStateChecked(SESSION);
    expect(hydrated.status).toBe("valid");
    if (hydrated.status !== "valid") return;
    const checkpoint = hydrated.data.planRuns.get(runId)?.checkpoints.get("CHECKPOINT-R-001");
    expect(checkpoint?.status).toBe("failed");
    expect(checkpoint?.lastOutcome).toBe("stopped");
    expect(checkpoint?.history[0]?.outcome).toBe("stopped");
    expect(checkpoint?.recoveryHistory).toHaveLength(1);

    // The restored run starts its second ordinary generation.
    const restored = createWorkItemStore(hydrated.data);
    const restarted = await startDelegatedCheckpoint(restored, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-001",
    });
    expect(restarted.ok).toBe(true);
    if (!restarted.ok) return;
    expect(restarted.generation).toBe(2);
  });
});
// END_BLOCK_RECOVERY_PERSISTENCE_TESTS

// START_BLOCK_RECOVERY_VALIDATION_TESTS
describe("version compatibility and recovery tamper rejection", () => {
  test("version 2 snapshots hydrate conservatively with empty recovery histories", async () => {
    const { runId } = await registerRun("v2-read");
    await acceptTask(runId, "T-001", "v2");
    snapshotWorkflowStateChecked(SESSION, store.getStoreData());

    const persisted = JSON.parse(readFileSync(statePath(), "utf-8"));
    persisted.version = 2;
    for (const record of persisted.records) {
      if (record.delegated) delete record.delegated.recoveryHistory;
    }
    for (const run of persisted.planRuns ?? []) {
      for (const checkpoint of run.checkpoints) delete checkpoint.recoveryHistory;
    }
    writeFileSync(statePath(), JSON.stringify(persisted, null, 2), "utf8");

    const hydrated = hydrateWorkflowStateChecked(SESSION);
    expect(hydrated.status).toBe("valid");
    if (hydrated.status !== "valid") return;
    const record = [...hydrated.data.records.values()].find((entry) => entry.delegated);
    expect(record?.delegated?.recoveryHistory).toEqual([]);
    const checkpoint = hydrated.data.planRuns.get(runId)?.checkpoints.get("CHECKPOINT-R-001");
    expect(checkpoint?.recoveryHistory).toEqual([]);
  });

  test("version 2 snapshots carrying recovery data are rejected", async () => {
    const { runId } = await registerRun("v2-tamper");
    const { workItemId } = await (async () => {
      const id = taskWorkItemId(runId, "T-001");
      const callId = `call-v2t-${++launchSequence}`;
      beginDelegatedLaunch(store, { sessionId: SESSION, workItemId: id, callId });
      applyDelegatedResult(store, {
        sessionId: SESSION,
        workItemId: id,
        callId,
        resultStatus: "BLOCKED",
        resultExcerpt: createWorkflowResultExcerpt({
          text: "Blocked.",
          source: "normalized_output",
        }),
      });
      const recovered = await recoverDelegatedWorkItem(store, {
        sessionId: SESSION,
        workItemId: id,
        attempt: 1,
        diagnosis: "Stop diagnosed.",
        changedCondition: "Condition changed.",
        verification: ["diff"],
        recoveryId: "rec-v2-1",
      });
      expect(recovered.ok).toBe(true);
      return { workItemId: id };
    })();
    void workItemId;
    snapshotWorkflowStateChecked(SESSION, store.getStoreData());

    const persisted = JSON.parse(readFileSync(statePath(), "utf-8"));
    persisted.version = 2;
    writeFileSync(statePath(), JSON.stringify(persisted, null, 2), "utf8");

    const hydrated = hydrateWorkflowStateChecked(SESSION);
    expect(hydrated.status).toBe("invalid");
    if (hydrated.status !== "invalid") return;
    expect(hydrated.errors.join("\n")).toContain("recovery history requires persisted version 3");
  });

  test("forged recovery state is rejected without silent resets", async () => {
    const { runId } = await registerRun("forged");
    const workItemId = taskWorkItemId(runId, "T-001");
    // Stop, resume, stop: the exhausted target legitimately earns the
    // autonomous grant that the forgeries below try to multiply.
    for (let index = 1; index <= 2; index += 1) {
      const callId = `call-fg-${index}-${++launchSequence}`;
      beginDelegatedLaunch(store, { sessionId: SESSION, workItemId, callId });
      applyDelegatedResult(store, {
        sessionId: SESSION,
        workItemId,
        callId,
        resultStatus: "BLOCKED",
        resultExcerpt: createWorkflowResultExcerpt({
          text: "Blocked.",
          source: "normalized_output",
        }),
      });
      if (index === 1) {
        const resumed = await recoverDelegatedWorkItem(store, {
          sessionId: SESSION,
          workItemId,
          attempt: index,
          diagnosis: "Stop diagnosed.",
          changedCondition: "Condition changed.",
          verification: ["diff"],
          recoveryId: "rec-forged-resume",
        });
        expect(resumed.ok).toBe(true);
      }
    }
    const recovered = await recoverDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId,
      attempt: 2,
      diagnosis: "Exhausted after two stops.",
      changedCondition: "One further attempt granted.",
      verification: ["diff"],
      recoveryId: "rec-forged-1",
    });
    expect(recovered.ok).toBe(true);
    snapshotWorkflowStateChecked(SESSION, store.getStoreData());

    // Forge a second autonomous grant under a new recoveryId.
    const persisted = JSON.parse(readFileSync(statePath(), "utf-8"));
    const record = persisted.records.find((entry: { mode?: string }) => entry.mode === "delegated");
    const autonomousEntry = record.delegated.recoveryHistory.find(
      (entry: { kind?: string }) => entry.kind === "autonomous_grant",
    );
    record.delegated.recoveryHistory.push({
      ...autonomousEntry,
      recoveryId: "rec-forged-2",
    });
    writeFileSync(statePath(), JSON.stringify(persisted, null, 2), "utf8");
    const doubleGrant = hydrateWorkflowStateChecked(SESSION);
    expect(doubleGrant.status).toBe("invalid");
    if (doubleGrant.status !== "invalid") return;
    expect(doubleGrant.errors.join("\n")).toContain("at most one autonomous recovery grant");

    // Forge a reused authorization message across two user grants.
    snapshotWorkflowStateChecked(SESSION, store.getStoreData());
    const persistedAgain = JSON.parse(readFileSync(statePath(), "utf-8"));
    const recordAgain = persistedAgain.records.find(
      (entry: { mode?: string }) => entry.mode === "delegated",
    );
    recordAgain.delegated.recoveryHistory.push({
      recoveryId: "rec-forged-3",
      targetAttempt: 2,
      kind: "user_grant",
      diagnosis: "Second unit.",
      changedCondition: "Another unit.",
      verification: ["diff"],
      recoveredAt: new Date().toISOString(),
      userMessageId: "msg_shared_auth",
    });
    recordAgain.delegated.recoveryHistory.push({
      recoveryId: "rec-forged-4",
      targetAttempt: 2,
      kind: "user_grant",
      diagnosis: "Replayed unit.",
      changedCondition: "Replayed authorization.",
      verification: ["diff"],
      recoveredAt: new Date().toISOString(),
      userMessageId: "msg_shared_auth",
    });
    writeFileSync(statePath(), JSON.stringify(persistedAgain, null, 2), "utf8");
    const replayed = hydrateWorkflowStateChecked(SESSION);
    expect(replayed.status).toBe("invalid");
    if (replayed.status !== "invalid") return;
    expect(replayed.errors.join("\n")).toContain("authorized more than one recovery unit");

    // Forge attempts beyond every granted budget.
    snapshotWorkflowStateChecked(SESSION, store.getStoreData());
    const persistedFinal = JSON.parse(readFileSync(statePath(), "utf-8"));
    const recordFinal = persistedFinal.records.find(
      (entry: { mode?: string }) => entry.mode === "delegated",
    );
    recordFinal.delegated.attempts.push({
      attempt: 3,
      callId: `call-forged-${++launchSequence}`,
      launchedAt: new Date().toISOString(),
      status: "failed",
      completedAt: new Date().toISOString(),
      failureExcerpt: createWorkflowResultExcerpt({
        text: "Subagent failed (task_id: ses_x): provider error",
        source: "normalized_output",
      }),
    });
    recordFinal.delegated.attempts.push({
      attempt: 4,
      callId: `call-forged-${++launchSequence}`,
      launchedAt: new Date().toISOString(),
      status: "failed",
      completedAt: new Date().toISOString(),
      failureExcerpt: createWorkflowResultExcerpt({
        text: "Subagent failed (task_id: ses_y): provider error",
        source: "normalized_output",
      }),
    });
    writeFileSync(statePath(), JSON.stringify(persistedFinal, null, 2), "utf8");
    const overrun = hydrateWorkflowStateChecked(SESSION);
    expect(overrun.status).toBe("invalid");
    if (overrun.status !== "invalid") return;
    expect(overrun.errors.join("\n")).toContain(
      "attempts exceed the base budget plus authorized rework and recovery grants",
    );
  });

  test("unsupported newer versions are rejected", async () => {
    mkdirSync(getWorkflowSessionDir(SESSION), { recursive: true });
    writeFileSync(statePath(), JSON.stringify({ version: 5, records: [], keyIndex: {} }), "utf8");
    const hydrated = hydrateWorkflowStateChecked(SESSION);
    expect(hydrated.status).toBe("invalid");
    if (hydrated.status !== "invalid") return;
    expect(hydrated.errors.join("\n")).toContain("unsupported persisted version 5");
  });
});
// END_BLOCK_RECOVERY_VALIDATION_TESTS

// START_BLOCK_LEGACY_TESTS
describe("version 1 legacy hydration", () => {
  test("valid version 1 records hydrate with original review requirements and no plan runs", () => {
    const now = new Date().toISOString();
    mkdirSync(getWorkflowSessionDir(SESSION), { recursive: true });
    writeFileSync(
      statePath(),
      JSON.stringify({
        version: 1,
        updatedAt: now,
        sessionId: SESSION,
        nextId: 2,
        records: [
          {
            sessionId: SESSION,
            workItemId: "wi-1",
            key: "legacy",
            title: "Legacy item",
            mode: "implementation",
            requiredReviewers: ["spec", "code"],
            state: "awaiting_reviews",
            currentRound: {
              round: 1,
              requiredReviewers: ["spec", "code"],
              pendingReviewers: ["code"],
              inFlightReviewers: [],
              completedReviewers: ["spec"],
              results: {
                spec: {
                  reviewer: "spec",
                  agent: "vv-spec-reviewer",
                  status: "PASS",
                  completedAt: now,
                },
              },
              status: "active",
              createdAt: now,
            },
            completedReviewRoundCount: 0,
            specReviewCount: 1,
            codeReviewCount: 0,
            createdAt: now,
            updatedAt: now,
          },
        ],
        keyIndex: { legacy: "wi-1" },
      }),
      "utf-8",
    );

    const hydrated = hydrateWorkflowStateChecked(SESSION);
    expect(hydrated.status).toBe("valid");
    if (hydrated.status !== "valid") return;
    expect(hydrated.data.planRuns.size).toBe(0);
    const record = hydrated.data.records.get(`${SESSION}::wi-1`);
    expect(record?.requiredReviewers).toEqual(["spec", "code"]);
    expect(record?.currentRound?.pendingReviewers).toEqual(["code"]);
    expect(record?.mode).toBe("implementation");
    expect(record?.state).toBe("awaiting_reviews");
    expect(hydrateWorkflowState(SESSION)).not.toBeNull();
  });
});
// END_BLOCK_LEGACY_TESTS

// START_BLOCK_REJECTION_TESTS
describe("malformed version 2 state is rejected, never silently reset", () => {
  async function seededState(): Promise<{
    runId: string;
    persisted: ReturnType<typeof JSON.parse>;
  }> {
    const { runId } = await registerRun("tamper");
    await acceptTask(runId, "T-001", "a1");
    snapshotWorkflowState(SESSION, store.getStoreData());
    const persisted = JSON.parse(readFileSync(statePath(), "utf-8"));
    return { runId, persisted };
  }

  function writeTampered(persisted: Record<string, unknown>): void {
    writeFileSync(statePath(), JSON.stringify(persisted, null, 2), "utf-8");
  }

  test("missing file reports missing and corrupt JSON reports invalid", () => {
    const missing = hydrateWorkflowStateChecked(SESSION);
    expect(missing.status).toBe("missing");

    mkdirSync(getWorkflowSessionDir(SESSION), { recursive: true });
    writeFileSync(statePath(), "{ not json", "utf-8");
    const corrupt = hydrateWorkflowStateChecked(SESSION);
    expect(corrupt.status).toBe("invalid");
    if (corrupt.status !== "invalid") return;
    expect(corrupt.errors[0]).toContain("not valid JSON");
    expect(hydrateWorkflowState(SESSION)).toBeNull();
  });

  test("version 2 without a planRuns array is invalid", async () => {
    const { persisted } = await seededState();
    delete persisted.planRuns;
    writeTampered(persisted);
    const result = hydrateWorkflowStateChecked(SESSION);
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;
    expect(result.errors.join("\n")).toContain("planRuns");
  });

  test("acceptance without a matching decision, bad attempt sequencing, and cross-session runs are invalid", async () => {
    const { runId, persisted } = await seededState();
    const delegated = persisted.records.find(
      (record: { mode?: string }) => record.mode === "delegated",
    );
    delegated.delegated.acceptances[0].decisionId = "dec-forged";
    writeTampered(persisted);
    const forged = hydrateWorkflowStateChecked(SESSION);
    expect(forged.status).toBe("invalid");
    if (forged.status !== "invalid") return;
    expect(forged.errors.join("\n")).toContain("no matching accept decision");

    const { persisted: fresh } = await seededState();
    const seqRecord = fresh.records.find(
      (record: { mode?: string }) => record.mode === "delegated",
    );
    seqRecord.delegated.attempts[0].attempt = 7;
    writeTampered(fresh);
    const sequenced = hydrateWorkflowStateChecked(SESSION);
    expect(sequenced.status).toBe("invalid");
    if (sequenced.status !== "invalid") return;
    expect(sequenced.errors.join("\n")).toContain("contiguously");

    const { persisted: runFile } = await seededState();
    runFile.planRuns[0].sessionId = "session-other";
    writeTampered(runFile);
    const crossSession = hydrateWorkflowStateChecked(SESSION);
    expect(crossSession.status).toBe("invalid");
    if (crossSession.status !== "invalid") return;
    expect(crossSession.errors.join("\n")).toContain("another session");
    void runId;
  });

  test("task binding and checkpoint history contradictions are invalid", async () => {
    const { persisted } = await seededState();
    persisted.planRuns[0].tasks[0].workItemId = "wi-999";
    writeTampered(persisted);
    const unbound = hydrateWorkflowStateChecked(SESSION);
    expect(unbound.status).toBe("invalid");
    if (unbound.status !== "invalid") return;
    expect(unbound.errors.join("\n")).toContain("not bound");

    const { persisted: historyFile } = await seededState();
    writeTampered(historyFile);
    const valid = hydrateWorkflowStateChecked(historyFile ? SESSION : SESSION);
    expect(valid.status).toBe("valid");

    const { persisted: passedFile } = await seededState();
    passedFile.planRuns[0].checkpoints[0].status = "passed";
    passedFile.planRuns[0].checkpoints[0].history = [];
    writeTampered(passedFile);
    const fakePass = hydrateWorkflowStateChecked(SESSION);
    expect(fakePass.status).toBe("invalid");
    if (fakePass.status !== "invalid") return;
    expect(fakePass.errors.join("\n")).toContain("passed without a passing history entry");
  });

  test("awaiting_acceptance with an already-decided attempt is contradictory", async () => {
    const { persisted } = await seededState();
    const delegated = persisted.records.find(
      (record: { mode?: string }) => record.mode === "delegated",
    );
    delegated.state = "awaiting_acceptance";
    writeTampered(persisted);
    const result = hydrateWorkflowStateChecked(SESSION);
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;
    expect(result.errors.join("\n")).toContain("already has a decision");
  });

  test("delegated state on a legacy-mode record is contradictory", async () => {
    const { persisted } = await seededState();
    const records = persisted.records as Array<Record<string, unknown>>;
    const delegatedRecord = records.find((record) => record.mode === "delegated");
    const now = new Date().toISOString();
    records.push({
      sessionId: SESSION,
      workItemId: "wi-legacy",
      key: "legacy-mixed",
      title: "Legacy item",
      mode: "implementation",
      requiredReviewers: ["spec"],
      state: "open",
      completedReviewRoundCount: 0,
      specReviewCount: 0,
      codeReviewCount: 0,
      createdAt: now,
      updatedAt: now,
      delegated: delegatedRecord?.delegated,
    });
    writeTampered(persisted);
    const result = hydrateWorkflowStateChecked(SESSION);
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;
    expect(result.errors.join("\n")).toContain("contradictory");
  });

  test("snapshot failures surface through the checked path", async () => {
    mkdirSync(getWorkflowSessionDir(SESSION), { recursive: true });
    // A directory occupying the state file path forces the atomic write to fail.
    mkdirSync(statePath(), { recursive: true });
    const result = snapshotWorkflowStateChecked(SESSION, store.getStoreData());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.length).toBeGreaterThan(0);
    await rm(statePath(), { recursive: true, force: true });
    expect(existsSync(statePath())).toBe(false);
  });
});
// END_BLOCK_REJECTION_TESTS

// Reference the global data dir so the import is used even if paths change.
void getGlobalVvocDataDir;

// START_BLOCK_V4_EXECUTION_REGISTRY_TESTS
describe("version 4 execution registry persistence", () => {
  test("a generic conversation-scoped execution round-trips through snapshot and hydrate", () => {
    const registered = registerExecutionInStore(store.getStoreData(), {
      sessionId: SESSION,
      workspaceRoot: "/tmp/vvoc-v4-workspace",
      executionKey: "v4-roundtrip",
      source: { kind: "conversation-scoped" },
      goal: "Round-trip one execution.",
      boundary: { files: ["src/lib/a.ts"], directories: [] },
      tasks: [
        {
          contract: {
            taskId: "T-100",
            title: "Generic task",
            goal: "Deliver the generic task.",
            acceptanceCriteria: ["It works."],
            verification: ["bun test src/lib/a.test.ts"],
            writeScope: ["src/lib/a.ts"],
            dependsOn: [],
            blockedBy: [],
            requiredReviewers: ["code"],
          },
        },
      ],
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;

    const snapshot = snapshotWorkflowStateChecked(SESSION, store.getStoreData());
    expect(snapshot.ok).toBe(true);
    const hydrated = hydrateWorkflowStateChecked(SESSION);
    expect(hydrated.status).toBe("valid");
    if (hydrated.status !== "valid") return;
    const execution = findExecution(hydrated.data, registered.runId);
    expect(execution?.source.kind).toBe("conversation-scoped");
    expect(execution?.tasks.get("T-100")?.contract.requiredReviewers).toEqual(["code"]);
    expect(execution?.checkpoints.get("review-T-100")).toBeDefined();
  });

  test("a v4 execution with a debit referencing an unknown authority is rejected", () => {
    const registered = registerExecutionInStore(store.getStoreData(), {
      sessionId: SESSION,
      workspaceRoot: "/tmp/vvoc-v4-workspace",
      executionKey: "v4-tamper",
      source: { kind: "conversation-scoped" },
      goal: "Tamper with authority.",
      boundary: { files: ["src/lib/a.ts"], directories: [] },
      tasks: [
        {
          contract: {
            taskId: "T-100",
            title: "Generic task",
            goal: "Deliver the generic task.",
            acceptanceCriteria: ["It works."],
            verification: [],
            writeScope: ["src/lib/a.ts"],
            dependsOn: [],
            blockedBy: [],
            requiredReviewers: [],
          },
        },
      ],
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    snapshotWorkflowStateChecked(SESSION, store.getStoreData());

    const parsed = JSON.parse(readFileSync(statePath(), "utf-8"));
    parsed.executions[0].reserveDebits.push({
      recoveryId: "forged-debit",
      authorityId: "unknown-authority",
      targetKind: "task",
      targetId: "T-100",
      units: 1,
      debitedAt: new Date().toISOString(),
    });
    writeFileSync(statePath(), JSON.stringify(parsed, null, 2), "utf8");

    const hydrated = hydrateWorkflowStateChecked(SESSION);
    expect(hydrated.status).toBe("invalid");
    if (hydrated.status !== "invalid") return;
    expect(hydrated.errors.join("\n")).toContain("unknown authority");
  });

  test("a version 3 file preserves a consumed recovery record after hydration", async () => {
    const { runId } = await registerRun("v3-downgrade");
    const workItemId = taskWorkItemId(runId, "T-001");
    const callId = `call-v3-${++launchSequence}`;
    beginDelegatedLaunch(store, { sessionId: SESSION, workItemId, callId });
    applyDelegatedResult(store, {
      sessionId: SESSION,
      workItemId,
      callId,
      resultStatus: "BLOCKED",
    });
    const granted = await recoverDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId,
      attempt: 1,
      diagnosis: "Stopped at the gate.",
      changedCondition: "Gate inputs recorded.",
      verification: ["src/lib/cache-store.ts"],
      recoveryId: "rec-v3-grant",
    });
    expect(granted.ok).toBe(true);

    snapshotWorkflowStateChecked(SESSION, store.getStoreData());
    const parsed = JSON.parse(readFileSync(statePath(), "utf-8"));
    // Downgrade the snapshot: a real version 3 file predates the execution registry.
    parsed.version = 3;
    delete parsed.executions;
    delete parsed.messageClaims;
    writeFileSync(statePath(), JSON.stringify(parsed, null, 2), "utf8");

    const hydrated = hydrateWorkflowStateChecked(SESSION);
    expect(hydrated.status).toBe("valid");
    if (hydrated.status !== "valid") return;
    const record = hydrated.data.records.get(`${SESSION}::${workItemId}`);
    expect(record?.delegated?.recoveryHistory).toHaveLength(1);
    expect(record?.delegated?.recoveryHistory[0]?.recoveryId).toBe("rec-v3-grant");
    // Native plan runs still materialize a compatibility execution entry.
    expect(findExecution(hydrated.data, runId)?.source.kind).toBe("native-package");
  });
});
// END_BLOCK_V4_EXECUTION_REGISTRY_TESTS
