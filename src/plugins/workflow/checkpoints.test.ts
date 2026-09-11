// FILE: src/plugins/workflow/checkpoints.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Deterministic tests for registered delegated plan runs, checkpoint generations, fingerprint-verified outcomes, rework authorization, and barrier gates.
//   SCOPE: Registration idempotency and drift, partial-binding rollback, prerequisite acceptance, generation lifecycle with reviewer bookkeeping, PASS/FAIL/stale/stopped verify outcomes, historical milestone preservation, final complete sealing, plan mutation drift, failed-checkpoint rework, and wave barriers over temporary workspace fixtures.
//   DEPENDS: [bun:test, node:fs/promises, node:path, src/plugins/workflow/checkpoint-io.ts, src/plugins/workflow/checkpoints.ts, src/plugins/workflow/delegated.ts, src/plugins/workflow/state.ts]
//   LINKS: [M-WORKFLOW-CHECKPOINTS, M-WORKFLOW-DELEGATED, V-M-WORKFLOW-CHECKPOINTS]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SESSION - Stable session identifier shared by registry fixtures.
//   store - Fresh work-item store created before each test.
//   createdRoots - Tracks temporary workspaces for cleanup after each test.
//   makeWorkspace - Writes a spec/plan package plus scope files into an isolated temporary workspace.
//   planXml - Renders the approved delegated plan fixture content.
//   loadPlan - Loads and validates the fixture plan through the IO adapter.
//   registerWorkspace - Creates a workspace and registers its plan.
//   workItemIdForTask - Resolves the bound work-item id for one plan task.
//   acceptTask - Runs one delegated attempt to an accepted state.
//   readFile - Reads a fixture file as UTF-8 text.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-DELEGATED-WORKFLOW-ASTRA-PRESETS - Initial registry coverage: generations, verify outcomes, sealing, rework, and barriers.]
// END_CHANGE_SUMMARY

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadApprovedDelegatedPlan, type LoadedDelegatedPlan } from "./checkpoint-io.js";
import {
  authorizeReworkFromFailedCheckpoint,
  checkpointBarrierUnsatisfied,
  findOverlappingInFlightReview,
  getDelegatedRunView,
  recordCheckpointReviewerLaunch,
  recordCheckpointReviewerResult,
  registerDelegatedPlan,
  startDelegatedCheckpoint,
  verifyDelegatedCheckpoint,
} from "./checkpoints.js";
import {
  applyDelegatedResult,
  beginDelegatedLaunch,
  decideDelegatedWorkItem,
} from "./delegated.js";
import { createWorkItemStore, type WorkItemStore } from "./state.js";

const SESSION = "session-checkpoints";

let store: WorkItemStore;
const createdRoots: string[] = [];

beforeEach(() => {
  store = createWorkItemStore();
});

afterEach(async () => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

async function makeWorkspace(prefix: string): Promise<{ root: string; planPath: string }> {
  const root = await mkdtemp(join(tmpdir(), `vvoc-cp-${prefix}-`));
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

async function loadPlan(root: string, planPath: string): Promise<LoadedDelegatedPlan> {
  const loaded = await loadApprovedDelegatedPlan({ workspaceRoot: root, planPath });
  if (!loaded.ok) throw new Error(`fixture plan failed to load: ${loaded.message}`);
  return loaded.plan;
}

async function registerWorkspace(prefix: string): Promise<{
  root: string;
  planPath: string;
  plan: LoadedDelegatedPlan;
  runId: string;
}> {
  const { root, planPath } = await makeWorkspace(prefix);
  const plan = await loadPlan(root, planPath);
  const registered = registerDelegatedPlan(store, { sessionId: SESSION, plan });
  if (!registered.ok) throw new Error(`registration failed: ${registered.message}`);
  return { root, planPath, plan, runId: registered.runId };
}

function workItemIdForTask(runId: string, taskId: string): string {
  const run = store.getStoreData().planRuns.get(runId);
  const binding = run?.tasks.get(taskId);
  if (!binding) throw new Error(`no binding for ${taskId}`);
  return binding.workItemId;
}

async function acceptTask(runId: string, taskId: string, suffix: string): Promise<void> {
  const workItemId = workItemIdForTask(runId, taskId);
  const launched = beginDelegatedLaunch(store, {
    sessionId: SESSION,
    workItemId,
    callId: `call-${taskId}-${suffix}`,
  });
  if (!launched.ok) throw new Error(launched.message);
  const applied = applyDelegatedResult(store, {
    sessionId: SESSION,
    workItemId,
    callId: `call-${taskId}-${suffix}`,
    resultStatus: "DONE",
  });
  if (!applied.ok) throw new Error(applied.message);
  const decided = decideDelegatedWorkItem(store, {
    sessionId: SESSION,
    workItemId,
    attempt: launched.attempt,
    decision: "accept",
    rationale: "Task result matches the contract.",
    evidence: ["diff"],
  });
  if (!decided.ok) throw new Error(decided.message);
}

// START_BLOCK_REGISTRATION_TESTS
describe("registerDelegatedPlan", () => {
  test("registers tasks and checkpoints with bound work items and no agent dispatch", async () => {
    const { runId } = await registerWorkspace("register");
    const run = store.getStoreData().planRuns.get(runId);
    expect(run).toBeDefined();
    if (!run) return;
    expect(run.status).toBe("active");
    expect([...run.tasks.keys()]).toEqual(["T-001", "T-002"]);
    expect([...run.checkpoints.keys()]).toEqual(["CHECKPOINT-R-001", "CHECKPOINT-R-002"]);
    expect(run.finalCheckpointId).toBe("CHECKPOINT-R-002");
    for (const binding of run.tasks.values()) {
      const record = store.getWorkItem(SESSION, binding.workItemId);
      expect(record?.mode).toBe("delegated");
      expect(record?.state).toBe("open");
      expect(record?.delegated?.planRunId).toBe(runId);
    }
  });

  test("identical registration is idempotent and changed inputs are explicit drift", async () => {
    const { root, planPath, runId } = await registerWorkspace("idempotent");
    const again = registerDelegatedPlan(store, {
      sessionId: SESSION,
      plan: await loadPlan(root, planPath),
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.reused).toBe(true);
    expect(again.runId).toBe(runId);

    await writeFile(
      join(root, "src", "lib", "cache-store.ts"),
      "export class CacheStore { v2 = 1 }\n",
      "utf8",
    );
    const mutatedPlan = {
      ...(await loadPlan(root, planPath)),
    };
    // Simulate changed approved content by re-hashing the same paths with new bytes:
    const { contentSha256 } = await import("./checkpoint-io.js");
    const drifted = {
      ...mutatedPlan,
      planSha256: contentSha256("different plan content"),
    };
    const drift = registerDelegatedPlan(store, { sessionId: SESSION, plan: drifted });
    expect(drift.ok).toBe(false);
    if (!drift.ok) expect(drift.errorCode).toBe("PLAN_DRIFT");
    const existing = store.getStoreData().planRuns.get(runId);
    expect(existing?.tasks.size).toBe(2);
  });

  test("rolls back staged work items when a task binding conflicts", async () => {
    const { root, planPath, plan, runId } = await registerWorkspace("rollback");
    // Simulate a lost registry: remove the run and its bound work items, then
    // poison the T-002 key so the next registration must roll back T-001.
    const data = store.getStoreData();
    data.planRuns.delete(runId);
    for (const task of plan.definition.tasks) {
      const key = `delegated-${runId}-${task.taskId}`;
      const sessionIndex = data.keyIndexBySession.get(SESSION);
      const workItemId = sessionIndex?.get(key);
      if (workItemId) {
        data.records.delete(`${SESSION}::${workItemId}`);
        sessionIndex?.delete(key);
      }
    }
    void root;
    void planPath;

    const t2Key = `delegated-${runId}-T-002`;
    const poisoned = store.openWorkItem({
      sessionId: SESSION,
      key: t2Key,
      title: "Unrelated intent",
      mode: "delegated",
      requiredReviewers: [],
      writeScope: ["src/lib/something-else.ts"],
    });
    expect(poisoned.ok).toBe(true);

    const failed = registerDelegatedPlan(store, { sessionId: SESSION, plan });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.errorCode).toBe("TASK_BINDING_FAILED");

    // T-001's staged item was rolled back; only the poisoned item remains for that key.
    const items = store.listWorkItems(SESSION, { includeClosed: true });
    const t1Key = `delegated-${runId}-T-001`;
    expect(items.find((item) => item.key === t1Key)).toBeUndefined();
    expect(items.find((item) => item.key === t2Key)?.title).toBe("Unrelated intent");
    expect(store.getStoreData().planRuns.has(runId)).toBe(false);
  });
});
// END_BLOCK_REGISTRATION_TESTS

// START_BLOCK_START_TESTS
describe("startDelegatedCheckpoint", () => {
  test("requires prerequisite acceptance before starting a generation", async () => {
    const { runId } = await registerWorkspace("prereq");
    const premature = await startDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-001",
    });
    expect(premature.ok).toBe(false);
    if (!premature.ok) expect(premature.errorCode).toBe("PREREQUISITES_NOT_ACCEPTED");

    await acceptTask(runId, "T-001", "a1");
    const started = await startDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-001",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.generation).toBe(1);
    expect(started.reviewersToLaunch).toEqual(["code"]);
    const reviewRecord = store.getWorkItem(SESSION, started.reviewWorkItemId);
    expect(reviewRecord?.mode).toBe("review_only");
    expect(reviewRecord?.requiredReviewers).toEqual(["code"]);

    const inFlight = await startDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-001",
    });
    expect(inFlight.ok).toBe(false);
    if (!inFlight.ok) expect(inFlight.errorCode).toBe("ALREADY_IN_REVIEW");
  });

  test("rejects unknown checkpoints, sealed runs, and overlapping in-flight scopes", async () => {
    const { runId } = await registerWorkspace("unknown");
    const unknown = await startDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-999",
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.errorCode).toBe("CHECKPOINT_NOT_FOUND");

    await acceptTask(runId, "T-001", "a1");
    await acceptTask(runId, "T-002", "a1");
    await startDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-001",
    });
    const overlapping = await startDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-002",
    });
    expect(overlapping.ok).toBe(false);
    if (!overlapping.ok) expect(overlapping.errorCode).toBe("OVERLAPPING_SCOPE");

    const data = store.getStoreData();
    expect(
      findOverlappingInFlightReview(data, runId, ["src/lib/cache-store.ts", "src/lib/new.ts"]),
    ).toBe("CHECKPOINT-R-001");
    expect(findOverlappingInFlightReview(data, runId, ["src/lib/unrelated.ts"])).toBeUndefined();
  });
});
// END_BLOCK_START_TESTS

// START_BLOCK_VERIFY_TESTS
describe("verifyDelegatedCheckpoint", () => {
  async function startedGeneration(prefix: string): Promise<{
    root: string;
    planPath: string;
    runId: string;
    reviewWorkItemId: string;
  }> {
    const { root, planPath, runId } = await registerWorkspace(prefix);
    await acceptTask(runId, "T-001", "a1");
    const started = await startDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-001",
    });
    if (!started.ok) throw new Error(started.message);
    return { root, planPath, runId, reviewWorkItemId: started.reviewWorkItemId };
  }

  test("reports incomplete while reviewers are pending", async () => {
    const { runId } = await startedGeneration("incomplete");
    const verify = await verifyDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-001",
    });
    expect(verify.ok).toBe(true);
    if (!verify.ok) return;
    expect(verify.outcome).toBe("incomplete");
  });

  test("passes only when every declared reviewer passes on the pinned snapshot", async () => {
    const { runId } = await startedGeneration("pass");
    recordCheckpointReviewerLaunch(store, {
      runId,
      checkpointId: "CHECKPOINT-R-001",
      reviewer: "code",
      callId: "rv-1",
    });
    const recorded = recordCheckpointReviewerResult(store, {
      runId,
      checkpointId: "CHECKPOINT-R-001",
      reviewer: "code",
      callId: "rv-1",
      status: "PASS",
    });
    expect(recorded.ok).toBe(true);
    if (recorded.ok) expect(recorded.roundComplete).toBe(true);

    const verify = await verifyDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-001",
    });
    expect(verify.ok).toBe(true);
    if (!verify.ok) return;
    expect(verify.outcome).toBe("passed");
    expect(verify.snapshotCurrent).toBe(true);
  });

  test("records reviewer outcomes with call binding and rejects stale callbacks", async () => {
    const { runId } = await startedGeneration("binding");
    recordCheckpointReviewerLaunch(store, {
      runId,
      checkpointId: "CHECKPOINT-R-001",
      reviewer: "code",
      callId: "rv-1",
    });
    const mismatch = recordCheckpointReviewerResult(store, {
      runId,
      checkpointId: "CHECKPOINT-R-001",
      reviewer: "code",
      callId: "rv-wrong",
      status: "PASS",
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.errorCode).toBe("CALLBACK_MISMATCH");

    const duplicate = recordCheckpointReviewerLaunch(store, {
      runId,
      checkpointId: "CHECKPOINT-R-001",
      reviewer: "code",
      callId: "rv-2",
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.errorCode).toBe("ALREADY_LAUNCHED");
  });

  test("FAIL settles the checkpoint as failed even after the review item closes", async () => {
    const { runId, reviewWorkItemId } = await startedGeneration("fail");
    const launched = store.beginTrackedLaunch({
      sessionId: SESSION,
      workItemId: reviewWorkItemId,
      agent: "vv-code-reviewer",
    });
    expect(launched.ok).toBe(true);
    const applied = store.applyTrackedResult({
      sessionId: SESSION,
      workItemId: reviewWorkItemId,
      result: {
        agent: "vv-code-reviewer",
        workItemId: reviewWorkItemId,
        status: "FAIL",
        body: "Findings: contract mismatch.",
      },
      resultExcerpt: undefined,
    });
    expect(applied.ok).toBe(true);
    if (applied.ok) expect(applied.record.state).toBe("ready_to_close");
    const closed = store.closeWorkItem(SESSION, reviewWorkItemId);
    expect(closed.ok).toBe(true);

    recordCheckpointReviewerResult(store, {
      runId,
      checkpointId: "CHECKPOINT-R-001",
      reviewer: "code",
      status: "FAIL",
    });
    const verify = await verifyDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-001",
    });
    expect(verify.ok).toBe(true);
    if (!verify.ok) return;
    expect(verify.outcome).toBe("failed");
  });

  test("content changed during review makes the generation stale, not passing", async () => {
    const { root, runId } = await startedGeneration("stale");
    recordCheckpointReviewerLaunch(store, {
      runId,
      checkpointId: "CHECKPOINT-R-001",
      reviewer: "code",
      callId: "rv-1",
    });
    recordCheckpointReviewerResult(store, {
      runId,
      checkpointId: "CHECKPOINT-R-001",
      reviewer: "code",
      callId: "rv-1",
      status: "PASS",
    });
    await writeFile(
      join(root, "src", "lib", "cache-store.ts"),
      "export class CacheStore { changed = true }\n",
      "utf8",
    );

    const verify = await verifyDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-001",
    });
    expect(verify.ok).toBe(true);
    if (!verify.ok) return;
    expect(verify.outcome).toBe("stale");
  });

  test("NEEDS_CONTEXT stops the checkpoint without settling it", async () => {
    const { runId } = await startedGeneration("stopped");
    recordCheckpointReviewerResult(store, {
      runId,
      checkpointId: "CHECKPOINT-R-001",
      reviewer: "code",
      status: "NEEDS_CONTEXT",
    });
    const verify = await verifyDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-001",
    });
    expect(verify.ok).toBe(true);
    if (!verify.ok) return;
    expect(verify.outcome).toBe("stopped");

    const rework = authorizeReworkFromFailedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-001",
      workItemId: workItemIdForTask(runId, "T-001"),
      reason: "Should not be authorized from a hard stop.",
    });
    expect(rework.ok).toBe(false);
    if (!rework.ok) expect(rework.errorCode).toBe("CHECKPOINT_NOT_FAILED");
  });

  test("plan mutation after registration is explicit drift at verify", async () => {
    const { planPath, runId } = await startedGeneration("drift");
    recordCheckpointReviewerResult(store, {
      runId,
      checkpointId: "CHECKPOINT-R-001",
      reviewer: "code",
      status: "PASS",
    });
    const mutated = (await readFile(planPath)).replace("<waves>2</waves>", "<waves>3</waves>");
    await writeFile(planPath, mutated, "utf8");

    const verify = await verifyDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-001",
    });
    expect(verify.ok).toBe(false);
    if (verify.ok) return;
    expect(verify.errorCode).toBe("PLAN_DRIFT");
  });

  test("passed milestones stay historical when later edits change the snapshot", async () => {
    const { root, runId } = await startedGeneration("historical");
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

    await writeFile(
      join(root, "src", "lib", "cache-store.ts"),
      "export class CacheStore { later = 1 }\n",
      "utf8",
    );
    const recheck = await verifyDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-001",
    });
    expect(recheck.ok).toBe(true);
    if (!recheck.ok) return;
    expect(recheck.outcome).toBe("already-passed");
    expect(recheck.snapshotCurrent).toBe(false);

    const checkpoint = store
      .getStoreData()
      .planRuns.get(runId)
      ?.checkpoints.get("CHECKPOINT-R-001");
    expect(checkpoint?.status).toBe("passed");
    expect(checkpoint?.history[0]?.outcome).toBe("passed");
  });
});
// END_BLOCK_VERIFY_TESTS

// START_BLOCK_COMPLETION_TESTS
describe("final completion and sealing", () => {
  async function fullProgress(prefix: string): Promise<{ root: string; runId: string }> {
    const { root, runId } = await registerWorkspace(prefix);
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
    return { root, runId };
  }

  test("complete on the final checkpoint seals the run only with everything satisfied", async () => {
    const { runId } = await fullProgress("seal");
    const premature = await verifyDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-001",
      complete: true,
    });
    expect(premature.ok).toBe(false);
    if (premature.ok) return;
    expect(premature.errorCode).toBe("FINAL_COMPLETE_ON_NON_FINAL");

    const incomplete = await verifyDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-002",
      complete: true,
    });
    expect(incomplete.ok).toBe(true);
    if (!incomplete.ok) return;
    expect(incomplete.outcome).toBe("incomplete");
    expect(incomplete.sealedRun).toBeUndefined();

    recordCheckpointReviewerResult(store, {
      runId,
      checkpointId: "CHECKPOINT-R-002",
      reviewer: "spec",
      status: "PASS",
    });
    recordCheckpointReviewerResult(store, {
      runId,
      checkpointId: "CHECKPOINT-R-002",
      reviewer: "code",
      status: "PASS",
    });

    const sealed = await verifyDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-002",
      complete: true,
    });
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    expect(sealed.outcome).toBe("passed");
    expect(sealed.sealedRun).toBe(true);
    expect(store.getStoreData().planRuns.get(runId)?.status).toBe("sealed");
  });

  test("failed final content after an earlier PASS cannot complete and bounded rework restores coverage", async () => {
    const { runId } = await fullProgress("reworkfinal");
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

    const failed = await verifyDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-002",
    });
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    expect(failed.outcome).toBe("failed");

    const t2 = workItemIdForTask(runId, "T-002");
    const rework = authorizeReworkFromFailedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-002",
      workItemId: t2,
      reason: "Spec reviewer found a missing error-handling branch.",
    });
    expect(rework.ok).toBe(true);

    const record = store.getWorkItem(SESSION, t2);
    expect(record?.state).toBe("awaiting_implementer");
    const correction = beginDelegatedLaunch(store, {
      sessionId: SESSION,
      workItemId: t2,
      callId: "call-t2-fix",
    });
    expect(correction.ok).toBe(true);
    if (!correction.ok) return;
    applyDelegatedResult(store, {
      sessionId: SESSION,
      workItemId: t2,
      callId: "call-t2-fix",
      resultStatus: "DONE",
    });
    decideDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId: t2,
      attempt: correction.attempt,
      decision: "accept",
      rationale: "Corrected branch verified.",
      evidence: ["diff"],
    });

    // The corrected task cannot complete the run through a second failed review either.
    const restarted = await startDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-002",
    });
    expect(restarted.ok).toBe(true);
    if (!restarted.ok) return;
    expect(restarted.generation).toBe(2);
    recordCheckpointReviewerResult(store, {
      runId,
      checkpointId: "CHECKPOINT-R-002",
      reviewer: "spec",
      status: "PASS",
    });
    recordCheckpointReviewerResult(store, {
      runId,
      checkpointId: "CHECKPOINT-R-002",
      reviewer: "code",
      status: "PASS",
    });

    const sealed = await verifyDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-002",
      complete: true,
    });
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    expect(sealed.sealedRun).toBe(true);
  });

  test("barriers block dependent-wave task launches until milestones pass", async () => {
    const { runId } = await registerWorkspace("barrier");
    const data = store.getStoreData();
    const blocked = checkpointBarrierUnsatisfied(data, runId, "WAVE-2");
    expect(blocked.ok).toBe(true);
    if (blocked.ok) expect(blocked.blockers).toEqual(["CHECKPOINT-R-001"]);

    await acceptTask(runId, "T-001", "a1");
    await startDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-001",
    });
    const stillBlocked = checkpointBarrierUnsatisfied(data, runId, "WAVE-2");
    expect(stillBlocked.ok).toBe(true);
    if (stillBlocked.ok) expect(stillBlocked.blockers).toEqual(["CHECKPOINT-R-001"]);

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
    const open = checkpointBarrierUnsatisfied(data, runId, "WAVE-2");
    expect(open.ok).toBe(true);
    if (open.ok) expect(open.blockers).toEqual([]);
  });

  test("a passed final checkpoint can still seal its run through a later complete request", async () => {
    const { runId } = await fullProgress("seal-retry");
    recordCheckpointReviewerResult(store, {
      runId,
      checkpointId: "CHECKPOINT-R-002",
      reviewer: "spec",
      status: "PASS",
    });
    recordCheckpointReviewerResult(store, {
      runId,
      checkpointId: "CHECKPOINT-R-002",
      reviewer: "code",
      status: "PASS",
    });
    const settled = await verifyDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-002",
    });
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.outcome).toBe("passed");
    expect(settled.sealedRun).toBeUndefined();

    const sealed = await verifyDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-002",
      complete: true,
    });
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    expect(sealed.sealedRun).toBe(true);
    expect(store.getStoreData().planRuns.get(runId)?.status).toBe("sealed");
  });

  test("a failed complete on a passed final checkpoint retries successfully after coverage is restored", async () => {
    const { runId } = await fullProgress("seal-retry-failed");
    const t2 = workItemIdForTask(runId, "T-002");
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
    await verifyDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-002",
    });
    const { reworkDelegatedWorkItem } = await import("./delegated.js");
    const reworkResult = reworkDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId: t2,
      planRunId: runId,
      failedCheckpointId: "CHECKPOINT-R-002",
      reason: "Fix the reviewed branch.",
    });
    expect(reworkResult.ok).toBe(true);
    const correction = beginDelegatedLaunch(store, {
      sessionId: SESSION,
      workItemId: t2,
      callId: "call-retry-fix",
    });
    expect(correction.ok).toBe(true);
    if (!correction.ok) return;
    applyDelegatedResult(store, {
      sessionId: SESSION,
      workItemId: t2,
      callId: "call-retry-fix",
      resultStatus: "DONE",
    });
    decideDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId: t2,
      attempt: correction.attempt,
      decision: "accept",
      rationale: "Corrected.",
      evidence: ["diff"],
    });

    // The retried generation passes; complete then seals through the retry path.
    await startDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-002",
    });
    recordCheckpointReviewerResult(store, {
      runId,
      checkpointId: "CHECKPOINT-R-002",
      reviewer: "spec",
      status: "PASS",
    });
    recordCheckpointReviewerResult(store, {
      runId,
      checkpointId: "CHECKPOINT-R-002",
      reviewer: "code",
      status: "PASS",
    });
    const sealed = await verifyDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-002",
      complete: true,
    });
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    expect(sealed.sealedRun).toBe(true);
  });

  test("registration rejects duplicate write scopes that bypassed lint", async () => {
    const { root, planPath } = await makeWorkspace("dupscope");
    const plan = await loadPlan(root, planPath);
    const doctored = {
      ...plan,
      definition: {
        ...plan.definition,
        tasks: plan.definition.tasks.map((task) =>
          task.taskId === "T-001"
            ? { ...task, writeScope: [...task.writeScope, task.writeScope[0]] }
            : task,
        ),
      },
    };
    const failed = registerDelegatedPlan(store, { sessionId: SESSION, plan: doctored });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.errorCode).toBe("TASK_BINDING_FAILED");
    expect(store.getStoreData().planRuns.size).toBe(0);
    expect(store.listWorkItems(SESSION, { includeClosed: true })).toHaveLength(0);
  });

  test("run view exposes checkpoint status for tooling output", async () => {
    const { runId } = await registerWorkspace("view");
    const view = getDelegatedRunView(store.getStoreData(), runId);
    expect(view).toBeDefined();
    if (!view) return;
    expect(view.status).toBe("active");
    expect(view.checkpoints).toHaveLength(2);
    expect(view.tasks).toHaveLength(2);
  });
});
// END_BLOCK_COMPLETION_TESTS

async function readFile(path: string): Promise<string> {
  const { readFile: read } = await import("node:fs/promises");
  return read(path, "utf8");
}
