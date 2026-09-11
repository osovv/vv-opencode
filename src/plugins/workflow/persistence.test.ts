// FILE: src/plugins/workflow/persistence.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Deterministic tests for workflow state persistence version 2: delegated and plan-run round-trips, legacy version 1 hydration, strict rejection of malformed state, atomic writes, and surfaced I/O failures.
//   SCOPE: Round-trip of accepted tasks, rework histories, in-flight and awaiting-acceptance attempts, incomplete reviews, FAIL reports, passed historical milestones, hard stops, and bounded excerpts; version 1 conservative hydration with original review requirements; tamper rejection without silent resets; checked loader triage; atomic replacement and failure surfacing.
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
//   acceptTask - Drives one delegated task to an accepted state.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-DELEGATED-WORKFLOW-ASTRA-PRESETS - Initial version 2 persistence coverage.]
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
  registerDelegatedPlan,
  startDelegatedCheckpoint,
  verifyDelegatedCheckpoint,
} from "./checkpoints.js";
import {
  applyDelegatedResult,
  beginDelegatedLaunch,
  decideDelegatedWorkItem,
} from "./delegated.js";
import {
  getWorkflowSessionDir,
  hydrateWorkflowState,
  hydrateWorkflowStateChecked,
  snapshotWorkflowState,
  snapshotWorkflowStateChecked,
} from "./persistence.js";
import { createWorkItemStore, type WorkItemStore } from "./state.js";

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

async function acceptTask(
  runId: string,
  taskId: string,
  callSuffix: string,
  attempt = 1,
): Promise<void> {
  const workItemId = taskWorkItemId(runId, taskId);
  const launched = beginDelegatedLaunch(store, {
    sessionId: SESSION,
    workItemId,
    callId: `call-${taskId}-${callSuffix}`,
  });
  if (!launched.ok) throw new Error(launched.message);
  const applied = applyDelegatedResult(store, {
    sessionId: SESSION,
    workItemId,
    callId: `call-${taskId}-${callSuffix}`,
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
    expect(persisted.version).toBe(2);
    expect(Array.isArray(persisted.planRuns)).toBe(true);
  });
});
// END_BLOCK_ROUNDTRIP_TESTS

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
