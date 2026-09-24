// FILE: src/plugins/workflow/inspection.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Deterministic tests for read-only same-session workflow inspection: additive work_item_list items/planRuns/executions and loaded identity, gate-derived delegated guidance that agrees with the real launch/decision mutations, derived current task status, bounded authority prerequisites, foreign-session filtering, and zero read-side mutation.
//   SCOPE: In-memory workflow store only; no persistence files, SDK access, provider calls, or filesystem workspace writes. Native plan runs are synthetic fixtures.
//   DEPENDS: [bun:test, src/plugins/workflow/inspection.ts, src/plugins/workflow/state.ts, src/plugins/workflow/delegated.ts, src/plugins/workflow/execution.ts, src/plugins/workflow/results.ts, src/lib/agent-tool-contract.ts]
//   LINKS: [M-WORKFLOW-TOOLING, M-WORKFLOW-EXECUTION, M-WORKFLOW-DELEGATED, M-AGENT-TOOL-CONTRACT, V-M-WORKFLOW-TOOLING]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SESSION - Stable owned session identifier for inspection fixtures.
//   FOREIGN_SESSION - Stable foreign session identifier used for filtering checks.
//   WORKSPACE - Stable absolute workspace root for generic execution fixtures.
//   store - Fresh work-item store created before each test.
//   createdRoots - Disposable workspace roots removed after each test.
//   dataOf - Store data accessor.
//   task - Builds a valid task contract with overridable fields.
//   checkpoint - Builds a valid checkpoint contract with overridable fields.
//   register - Registers a conversation-scoped execution with the supplied tasks/checkpoints.
//   acceptSequence - Monotonic counter keeping acceptance callIDs unique within a test.
//   driveToAccepted - Drives one bound delegated task through launch, DONE, and controller acceptance.
//   normalize - Recursively normalize a value for deep no-mutation comparison.
//   fingerprint - Deep, map-aware snapshot of the full store for no-mutation checks.
//   listItem - Read one work item from the inspection list payload.
//   nativeRunFixture - Synthetic typed native plan run used for native barrier/overlap inspection.
//   nativePlanXml - Minimal approved native plan XML for real loader flows.
//   makeNativeWorkspace - Synthetic approved native plan workspace for real loader flows.
//   acceptBoundTask - Drives one bound delegated item through launch, DONE, and acceptance.
//   nativeCheckpoint - Reads one checkpoint from the unified executions view.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-004 - Correction cycle: cross-response guidance agreement (list/open/failure/recovery), authoritative native register/start/review/verify/recover/seal projection with stale-registry and legacy no-registry cases, blocked native checkpoint start guidance, authoritative sealed launch gate, hydration, and foreign filtering. Prior: initial inspection coverage.]
// END_CHANGE_SUMMARY

import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  WorkflowCheckpointContract,
  WorkflowTaskContract,
  WorkflowAuthorityRecord,
} from "../../lib/workflow-contract.js";
import {
  AGENT_TOOL_CONTRACT_REVISION,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  resolveToolContractReferencePath,
} from "../../lib/agent-tool-contract.js";
import {
  applyDelegatedResultInStore,
  beginDelegatedLaunchInStore,
  decideDelegatedWorkItemInStore,
  recoverDelegatedWorkItemInStore,
} from "./delegated.js";
import {
  getExecutionView,
  isTaskLaunchableInStore,
  registerExecutionInStore,
  sealExecutionInStore,
  splitExecutionTaskInStore,
  type RegisterExecutionResult,
} from "./execution.js";
import {
  checkpointBarrierUnsatisfied,
  checkpointStartGate,
  findOverlappingInFlightReview,
  recordCheckpointReviewerLaunch,
  recordCheckpointReviewerResult,
  recoverDelegatedCheckpoint,
  registerDelegatedPlan,
  registerDelegatedPlanInStore,
  startDelegatedCheckpoint,
  verifyDelegatedCheckpoint,
  type DelegatedPlanRun,
  type DelegatedRunCheckpoint,
} from "./checkpoints.js";
import { loadApprovedDelegatedPlan } from "./checkpoint-io.js";
import { getWorkflowInspection, serializeWorkItem } from "./inspection.js";
import { validateWorkflowToolResult } from "./results.js";
import {
  createWorkItemCloseTool,
  createWorkItemDecideTool,
  createWorkItemListTool,
} from "./tooling.js";
import { createRecordLookupKey, createWorkItemStore, type WorkItemStore } from "./state.js";

const SESSION = "session-inspection";
const FOREIGN_SESSION = "session-inspection-foreign";
const WORKSPACE = "/tmp/vvoc-inspection-workspace";

let store: WorkItemStore;

const createdRoots: string[] = [];

beforeEach(() => {
  store = createWorkItemStore();
});

afterEach(() => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function dataOf() {
  return store.getStoreData();
}

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

function checkpoint(
  overrides: Partial<WorkflowCheckpointContract> = {},
): WorkflowCheckpointContract {
  return {
    checkpointId: "CP-1",
    kind: "milestone",
    covers: ["T-100"],
    scope: ["src/lib/a.ts"],
    requiredReviewers: ["code"],
    acceptance: ["Reviewed."],
    verification: ["bun test src/lib/a.test.ts"],
    origin: "source",
    dependsOn: [],
    ...overrides,
  };
}

function register(
  executionKey: string,
  tasks: WorkflowTaskContract[] = [task()],
  checkpoints: WorkflowCheckpointContract[] = [],
): RegisterExecutionResult {
  return registerExecutionInStore(dataOf(), {
    sessionId: SESSION,
    workspaceRoot: WORKSPACE,
    executionKey,
    source: { kind: "conversation-scoped" },
    goal: "Deliver the requested change.",
    boundary: { files: ["src/lib/a.ts", "src/lib/b.ts"], directories: [] },
    tasks: tasks.map((contract) => ({ contract })),
    checkpoints,
  });
}

let acceptSequence = 0;

function driveToAccepted(workItemId: string): void {
  acceptSequence += 1;
  const callId = `call-accept-${workItemId}-${acceptSequence}`;
  const data = dataOf();
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

/** Map-aware deep snapshot so no nested Map, counter, or ledger change is hidden. */
function normalize(value: unknown): unknown {
  if (value instanceof Map) {
    return [...value.entries()]
      .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
      .map(([key, entry]) => [key, normalize(entry)]);
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)]),
    );
  }
  return value;
}

function fingerprint(): string {
  return JSON.stringify(normalize(dataOf()));
}

function listItem(workItemId: string, includeClosed = true) {
  const listed = getWorkflowInspection(store, SESSION, { includeClosed });
  const item = listed.items.find((entry) => entry.workItemId === workItemId) as
    | {
        state: string;
        delegated?: {
          nextAction: string;
          latestAttempt?: {
            attempt: number;
            status: string;
            resultStatus?: string;
            reportRejected?: boolean;
          };
          guidance?: {
            nextAction: string;
            launchEligible: boolean;
            blockers: string[];
            prerequisites: string[];
            requiresConcernsDisposition: boolean;
          };
        };
      }
    | undefined;
  return { listed, item };
}

function nativeRunFixture(
  runId: string,
  checkpointStatus: DelegatedRunCheckpoint,
): DelegatedPlanRun {
  const now = new Date().toISOString();
  return {
    runId,
    sessionId: SESSION,
    planPath: `/workspace/.vvoc/specs/2026-01-01-${runId}/plan.xml`,
    specPath: `/workspace/.vvoc/specs/2026-01-01-${runId}/spec.xml`,
    workspaceRoot: WORKSPACE,
    planSha256: "plan-hash",
    specSha256: "spec-hash",
    definition: {
      mode: "delegated",
      waves: ["WAVE-0", "WAVE-1"],
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
      checkpoints: [],
    },
    registeredAt: now,
    status: "active",
    tasks: new Map(),
    checkpoints: new Map([[checkpointStatus.checkpointId, checkpointStatus]]),
  };
}

function nativePlanXml(): string {
  return `<plan><spec>spec.xml</spec><created>2026-09-11</created><status>approved</status>
<meta><summary>Delegated cache.</summary><waves>1</waves><affected_modules>src/lib/cache-store.ts</affected_modules><complexity>low</complexity></meta>
<architecture><COMPONENT-CACHE-STORE><name>Cache Store</name><purpose>Store.</purpose><file><path>src/lib/cache-store.ts</path><role>implementation</role></file><contract>get/set.</contract><depends_on></depends_on></COMPONENT-CACHE-STORE></architecture>
<tasks>
<WAVE-1><goal>Core.</goal>
<TASK-T-001><title>Store</title><file>src/lib/cache-store.ts</file><status>pending</status><description>Implement.</description><depends_on></depends_on><acceptance><criterion>Works</criterion></acceptance><verification><command>bun test src/lib/cache-store.test.ts</command></verification><write_scope><file>src/lib/cache-store.ts</file><file>src/lib/cache-store.test.ts</file></write_scope></TASK-T-001>
</WAVE-1>
</tasks>
<execution><mode>delegated</mode>
<review_checkpoints>
<CHECKPOINT-R-001><kind>milestone</kind><after_wave>WAVE-1</after_wave><covers><task_id>T-001</task_id></covers><scope><file>src/lib/cache-store.ts</file><file>src/lib/cache-store.test.ts</file></scope><reviewers><reviewer>code</reviewer></reviewers><acceptance><criterion>Reviewed</criterion></acceptance><verification><command>bun test src/lib/cache-store.test.ts</command></verification></CHECKPOINT-R-001>
<CHECKPOINT-R-002><kind>final</kind><after_wave>WAVE-1</after_wave><covers><task_id>T-001</task_id></covers><scope><file>src/lib/cache-store.ts</file><file>src/lib/cache-store.test.ts</file></scope><reviewers><reviewer>spec</reviewer><reviewer>code</reviewer></reviewers><acceptance><criterion>Complete</criterion></acceptance><verification><command>bun test</command></verification></CHECKPOINT-R-002>
</review_checkpoints>
</execution>
</plan>`;
}

/** Synthetic approved native plan workspace; no real repository files. */
async function makeNativeWorkspace(prefix: string): Promise<{ root: string; planPath: string }> {
  const root = mkdtempSync(join(tmpdir(), `vvoc-inspect-${prefix}-`));
  createdRoots.push(root);
  const pkgDir = join(root, ".vvoc", "specs", "2026-09-11-cache");
  mkdirSync(pkgDir, { recursive: true });
  mkdirSync(join(root, "src", "lib"), { recursive: true });
  writeFileSync(
    join(pkgDir, "spec.xml"),
    `<spec><status>approved</status><goal>Store rows.</goal><architecture>Cache.</architecture><tech_stack>TS.</tech_stack><components><COMPONENT-CACHE-STORE><name>Cache Store</name><responsibility>Holds rows.</responsibility><depends_on></depends_on></COMPONENT-CACHE-STORE></components><data_flow>Rows flow.</data_flow><error_handling>Fail open.</error_handling><testing><strategy>Unit.</strategy><coverage>Paths.</coverage></testing><non_goals><non_goal>No persistence.</non_goal></non_goals></spec>`,
    "utf8",
  );
  writeFileSync(join(pkgDir, "plan.xml"), nativePlanXml(), "utf8");
  writeFileSync(join(root, "src", "lib", "cache-store.ts"), "export class CacheStore {}\n");
  writeFileSync(join(root, "src", "lib", "cache-store.test.ts"), "test.todo();\n");
  return { root, planPath: join(pkgDir, "plan.xml") };
}

/** Drive one bound delegated work item through launch, DONE, and acceptance. */
function acceptBoundTask(workItemId: string, suffix: string): void {
  const data = dataOf();
  const callId = `call-native-${suffix}`;
  expect(beginDelegatedLaunchInStore(data, { sessionId: SESSION, workItemId, callId }).ok).toBe(
    true,
  );
  expect(
    applyDelegatedResultInStore(data, {
      sessionId: SESSION,
      workItemId,
      callId,
      resultStatus: "DONE",
    }).ok,
  ).toBe(true);
  expect(
    decideDelegatedWorkItemInStore(data, {
      sessionId: SESSION,
      workItemId,
      attempt: 1,
      decision: "accept",
      rationale: "Accepted for the checkpoint.",
      evidence: ["bun test src/lib/cache-store.test.ts"],
    }).ok,
  ).toBe(true);
}

function nativeCheckpoint(
  runId: string,
  checkpointId: string,
  listed: ReturnType<typeof getWorkflowInspection>,
) {
  const execution = listed.executions!.find((entry) => entry.runId === runId)!;
  return execution.checkpoints.find((entry) => entry.checkpointId === checkpointId)!;
}

describe("loaded contract identity", () => {
  test("work_item_list reports the cached loaded identity and package-resolved reference path", () => {
    const listed = getWorkflowInspection(store, SESSION);
    expect(listed.contract.packageName).toBe(PACKAGE_NAME);
    expect(listed.contract.packageVersion).toBe(PACKAGE_VERSION);
    expect(listed.contract.toolContractRevision).toBe(AGENT_TOOL_CONTRACT_REVISION);
    expect(listed.contract.referencePath).toBe(resolveToolContractReferencePath());
    expect(
      listed.contract.referencePath.endsWith(
        "templates/skills/vv-execute/references/tool-contracts.md",
      ),
    ).toBe(true);

    const repoVersion = (
      JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
        version: string;
      }
    ).version;
    expect(listed.contract.packageVersion).toBe(repoVersion);
    expect(validateWorkflowToolResult("work_item_list", listed).ok).toBe(true);
  });

  test("identity stays cached and stable despite unrelated temp package and config changes", () => {
    const before = getWorkflowInspection(store, SESSION).contract;
    const tempDir = mkdtempSync(join(tmpdir(), "vvoc-inspection-"));
    const previousCwd = process.cwd();
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    try {
      writeFileSync(join(tempDir, "package.json"), JSON.stringify({ version: "9.9.9-decoy" }));
      process.chdir(tempDir);
      process.env.XDG_CONFIG_HOME = tempDir;
      const after = getWorkflowInspection(store, SESSION).contract;
      expect(after).toEqual(before);
      expect(after.packageVersion).not.toBe("9.9.9-decoy");
    } finally {
      process.chdir(previousCwd);
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("additive work_item_list payload", () => {
  test("preserves items without inventing planRuns or executions", () => {
    store.openWorkItem({
      sessionId: SESSION,
      key: "impl",
      title: "Implementation",
      mode: "implementation",
      requiredReviewers: ["spec"],
    });
    const listed = getWorkflowInspection(store, SESSION);
    expect(listed.items).toHaveLength(1);
    expect(listed.planRuns).toBeUndefined();
    expect(listed.executions).toBeUndefined();
    expect(validateWorkflowToolResult("work_item_list", listed).ok).toBe(true);
  });

  test("includeClosed keeps exact existing closed-item semantics", () => {
    const opened = store.openWorkItem({
      sessionId: SESSION,
      key: "closed",
      title: "Closed item",
      mode: "review_only",
      requiredReviewers: ["code"],
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const record = dataOf().records.get(createRecordLookupKey(SESSION, opened.record.workItemId))!;
    record.state = "closed";
    record.closedAt = new Date().toISOString();

    expect(getWorkflowInspection(store, SESSION, { includeClosed: false }).items).toHaveLength(0);
    expect(getWorkflowInspection(store, SESSION, { includeClosed: true }).items).toHaveLength(1);
  });

  test("lists a generic execution additively and lets a controller recover identities", () => {
    const registered = register("inspect-generic");
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const listed = getWorkflowInspection(store, SESSION);
    expect(listed.planRuns).toBeUndefined();
    expect(listed.executions).toHaveLength(1);
    const execution = listed.executions![0] as {
      runId: string;
      sourceKind: string;
      tasks: Array<{ taskId: string; workItemId: string; status: string }>;
    };
    expect(execution.runId).toBe(registered.runId);
    expect(execution.sourceKind).toBe("conversation-scoped");
    expect(execution.tasks[0]!.taskId).toBe("T-100");
    expect(execution.tasks[0]!.workItemId).toBe(
      registered.execution.tasks.get("T-100")!.workItemId,
    );
    expect(validateWorkflowToolResult("work_item_list", listed).ok).toBe(true);
  });

  test("filters foreign-session items, runs, and executions before details", () => {
    register("owned-run");
    registerExecutionInStore(dataOf(), {
      sessionId: FOREIGN_SESSION,
      workspaceRoot: WORKSPACE,
      executionKey: "foreign-run",
      source: { kind: "conversation-scoped" },
      goal: "Foreign.",
      boundary: { files: ["src/lib/a.ts"], directories: [] },
      tasks: [{ contract: task({ taskId: "T-900" }) }],
    });
    store.openWorkItem({
      sessionId: FOREIGN_SESSION,
      key: "foreign",
      title: "Foreign item",
      mode: "implementation",
      requiredReviewers: ["spec"],
    });
    const listed = getWorkflowInspection(store, SESSION);
    expect(listed.items.some((entry) => entry.title === "Foreign item")).toBe(false);
    expect(listed.executions).toHaveLength(1);
    expect(listed.executions![0]!.sessionId).toBe(SESSION);
  });

  test("never exposes raw store maps or authorization message text", () => {
    register("no-dump");
    const text = JSON.stringify(getWorkflowInspection(store, SESSION));
    expect(text).not.toContain("keyIndexBySession");
    expect(text).not.toContain("messageClaims");
    expect(text).not.toContain("grantedByMessageId");
    expect(text).not.toContain('"records"');
  });
});

describe("delegated guidance agrees with its real mutation gate", () => {
  test("awaiting_acceptance DONE exposes the exact attempt and decides with the public data", () => {
    const registered = register("guidance-done");
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const workItemId = registered.execution.tasks.get("T-100")!.workItemId;
    const callId = "call-guidance-done";
    expect(
      beginDelegatedLaunchInStore(dataOf(), { sessionId: SESSION, workItemId, callId }).ok,
    ).toBe(true);
    expect(
      applyDelegatedResultInStore(dataOf(), {
        sessionId: SESSION,
        workItemId,
        callId,
        resultStatus: "DONE",
      }).ok,
    ).toBe(true);

    const { item } = listItem(workItemId);
    expect(item?.state).toBe("awaiting_acceptance");
    expect(item?.delegated?.latestAttempt).toMatchObject({
      attempt: 1,
      status: "completed",
      resultStatus: "DONE",
      reportRejected: false,
    });
    expect(item?.delegated?.guidance?.nextAction).toBe("decide");
    expect(item?.delegated?.guidance?.requiresConcernsDisposition).toBe(false);
    expect(item?.delegated?.nextAction).toBe("decide");

    // Context-loss reconstruction: decide using only the public list payload.
    const attempt = item?.delegated?.latestAttempt?.attempt ?? 0;
    const decided = decideDelegatedWorkItemInStore(dataOf(), {
      sessionId: SESSION,
      workItemId,
      attempt,
      decision: "accept",
      rationale: "Public-data decision.",
      evidence: ["bun test src/lib/a.test.ts"],
    });
    expect(decided.ok).toBe(true);
  });

  test("awaiting_acceptance DONE_WITH_CONCERNS requires the conditional disposition", () => {
    const registered = register("guidance-concerns");
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const workItemId = registered.execution.tasks.get("T-100")!.workItemId;
    const callId = "call-guidance-concerns";
    expect(
      beginDelegatedLaunchInStore(dataOf(), { sessionId: SESSION, workItemId, callId }).ok,
    ).toBe(true);
    expect(
      applyDelegatedResultInStore(dataOf(), {
        sessionId: SESSION,
        workItemId,
        callId,
        resultStatus: "DONE_WITH_CONCERNS",
      }).ok,
    ).toBe(true);

    const { item } = listItem(workItemId);
    expect(item?.delegated?.guidance?.requiresConcernsDisposition).toBe(true);
    expect(item?.delegated?.guidance?.prerequisites.join(" ")).toContain("concernsDisposition");

    const withoutDisposition = decideDelegatedWorkItemInStore(dataOf(), {
      sessionId: SESSION,
      workItemId,
      attempt: 1,
      decision: "accept",
      rationale: "Missing disposition.",
      evidence: ["bun test src/lib/a.test.ts"],
    });
    expect(withoutDisposition.ok).toBe(false);
    if (withoutDisposition.ok) return;
    expect(withoutDisposition.errorCode).toBe("CONCERNS_DISPOSITION_REQUIRED");
  });

  test("live attempt reports await_result and the real launch rejects ATTEMPT_IN_FLIGHT", () => {
    const registered = register("guidance-live");
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const workItemId = registered.execution.tasks.get("T-100")!.workItemId;
    expect(
      beginDelegatedLaunchInStore(dataOf(), {
        sessionId: SESSION,
        workItemId,
        callId: "call-guidance-live",
      }).ok,
    ).toBe(true);

    const { item } = listItem(workItemId);
    expect(item?.delegated?.guidance?.nextAction).toBe("await_result");
    expect(item?.delegated?.guidance?.launchEligible).toBe(false);

    const before = fingerprint();
    const rejected = beginDelegatedLaunchInStore(dataOf(), {
      sessionId: SESSION,
      workItemId,
      callId: "call-guidance-live-2",
    });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.errorCode).toBe("ATTEMPT_IN_FLIGHT");
    expect(fingerprint()).toBe(before);
  });

  test("exhausted ordinary budget suggests recover and the real launch rejects ATTEMPTS_EXHAUSTED", () => {
    store.openWorkItem({
      sessionId: SESSION,
      key: "exhausted",
      title: "Exhausted",
      mode: "delegated",
      requiredReviewers: [],
      writeScope: ["src/lib/a.ts"],
    });
    const workItemId = "wi-1";
    for (const [callId, decision] of [
      ["call-1", "request_changes"],
      ["call-2", "request_changes"],
    ] as const) {
      expect(
        beginDelegatedLaunchInStore(dataOf(), { sessionId: SESSION, workItemId, callId }).ok,
      ).toBe(true);
      expect(
        applyDelegatedResultInStore(dataOf(), {
          sessionId: SESSION,
          workItemId,
          callId,
          resultStatus: "DONE",
        }).ok,
      ).toBe(true);
      const item = listItem(workItemId).item!;
      const attempt = item.delegated?.latestAttempt?.attempt ?? 0;
      expect(
        decideDelegatedWorkItemInStore(dataOf(), {
          sessionId: SESSION,
          workItemId,
          attempt,
          decision,
          rationale: "Correction requested.",
          evidence: ["bun test src/lib/a.test.ts"],
        }).ok,
      ).toBe(true);
    }

    const { item } = listItem(workItemId);
    expect(item?.delegated?.guidance?.nextAction).toBe("recover");
    const rejected = beginDelegatedLaunchInStore(dataOf(), {
      sessionId: SESSION,
      workItemId,
      callId: "call-3",
    });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.errorCode).toBe("ATTEMPTS_EXHAUSTED");
  });

  test("consumed autonomous grant points at user-authorized recovery and the real call rejects", async () => {
    store.openWorkItem({
      sessionId: SESSION,
      key: "autonomous",
      title: "Autonomous",
      mode: "delegated",
      requiredReviewers: [],
      writeScope: ["src/lib/a.ts"],
    });
    const workItemId = "wi-1";
    const launchBlocked = (callId: string) => {
      expect(
        beginDelegatedLaunchInStore(dataOf(), { sessionId: SESSION, workItemId, callId }).ok,
      ).toBe(true);
      expect(
        applyDelegatedResultInStore(dataOf(), {
          sessionId: SESSION,
          workItemId,
          callId,
          resultStatus: "BLOCKED",
        }).ok,
      ).toBe(true);
    };

    // Attempt 1 stops; a resume recovery costs no grant and no budget.
    launchBlocked("call-a");
    const resumed = await recoverDelegatedWorkItemInStore(dataOf(), {
      sessionId: SESSION,
      workItemId,
      attempt: 1,
      diagnosis: "Stopped.",
      changedCondition: "Context restored.",
      verification: ["bun test src/lib/a.test.ts"],
      recoveryId: "rec-1",
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.kind).toBe("resume");

    // Attempt 2 exhausts the base budget; the autonomous grant adds attempt 3.
    launchBlocked("call-b");
    const granted = await recoverDelegatedWorkItemInStore(dataOf(), {
      sessionId: SESSION,
      workItemId,
      attempt: 2,
      diagnosis: "Exhausted.",
      changedCondition: "One grant.",
      verification: ["bun test src/lib/a.test.ts"],
      recoveryId: "rec-2",
    });
    expect(granted.ok).toBe(true);
    if (!granted.ok) return;
    expect(granted.kind).toBe("autonomous_grant");

    // Attempt 3 exhausts the granted budget with the autonomous grant consumed.
    launchBlocked("call-c");
    const { item } = listItem(workItemId);
    expect(item?.delegated?.guidance?.nextAction).toBe("recover_with_user_authorization");
    expect(item?.delegated?.guidance?.prerequisites.join(" ")).toContain("provenance");
    expect(item?.delegated?.guidance?.prerequisites.join(" ")).toContain("advance authority");

    const before = fingerprint();
    const rejected = await recoverDelegatedWorkItemInStore(dataOf(), {
      sessionId: SESSION,
      workItemId,
      attempt: 3,
      diagnosis: "Still stopped.",
      changedCondition: "Nothing changed.",
      verification: ["bun test src/lib/a.test.ts"],
      recoveryId: "rec-3",
    });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.errorCode).toBe("AUTONOMOUS_GRANT_EXHAUSTED");
    expect(fingerprint()).toBe(before);
  });
});

describe("execution-level guidance agrees with the launch gate", () => {
  test("blocked dependency reports launch_blocked and the gate rejects DEPENDENCIES_UNMET", () => {
    const registered = register("dependency", [
      task({ taskId: "T-100" }),
      task({ taskId: "T-200", writeScope: ["src/lib/b.ts"], dependsOn: ["T-100"] }),
    ]);
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const workItemId = registered.execution.tasks.get("T-200")!.workItemId;
    const { item } = listItem(workItemId);
    expect(item?.delegated?.guidance?.nextAction).toBe("launch_blocked");
    expect(item?.delegated?.guidance?.blockers).toContain("DEPENDENCIES_UNMET:T-200");
    expect(item?.delegated?.guidance?.launchEligible).toBe(false);

    const gate = isTaskLaunchableInStore(dataOf(), {
      sessionId: SESSION,
      runId: registered.runId,
      taskId: "T-200",
    });
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.reason).toBe("DEPENDENCIES_UNMET");
  });

  test("unpassed checkpoint reports launch_blocked and the gate rejects BARRIER_UNSATISFIED", () => {
    const registered = register(
      "barrier",
      [task({ taskId: "T-300", blockedBy: ["CP-1"] })],
      [checkpoint({ checkpointId: "CP-1", covers: ["T-300"] })],
    );
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const workItemId = registered.execution.tasks.get("T-300")!.workItemId;
    const { item } = listItem(workItemId);
    expect(item?.delegated?.guidance?.blockers).toContain("BARRIER_UNSATISFIED:T-300");
    const gate = isTaskLaunchableInStore(dataOf(), {
      sessionId: SESSION,
      runId: registered.runId,
      taskId: "T-300",
    });
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.reason).toBe("BARRIER_UNSATISFIED");
  });

  test("replaced task reports launch_blocked and the gate rejects TASK_SUPERSEDED", () => {
    const registered = register("superseded", [task({ taskId: "T-400" })]);
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const workItemId = registered.execution.tasks.get("T-400")!.workItemId;
    const split = splitExecutionTaskInStore(dataOf(), {
      sessionId: SESSION,
      runId: registered.runId,
      parentTaskId: "T-400",
      amendmentId: "split-1",
      rationale: "Replace.",
      children: [task({ taskId: "T-401" })],
    });
    expect(split.ok).toBe(true);

    const { item } = listItem(workItemId);
    expect(item?.delegated?.guidance?.blockers).toContain("TASK_SUPERSEDED:T-400");
    const gate = isTaskLaunchableInStore(dataOf(), {
      sessionId: SESSION,
      runId: registered.runId,
      taskId: "T-400",
    });
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.reason).toBe("TASK_SUPERSEDED");
  });

  test("sealed execution reports the sealed blocker and derived view state", () => {
    const registered = register("sealed", [task({ taskId: "T-500" })]);
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    expect(sealExecutionInStore(dataOf(), { sessionId: SESSION, runId: registered.runId }).ok).toBe(
      true,
    );
    const workItemId = registered.execution.tasks.get("T-500")!.workItemId;
    const { item, listed } = listItem(workItemId);
    expect(item?.delegated?.guidance?.blockers).toContain("EXECUTION_SEALED:T-500");
    expect((listed.executions![0] as { state: string }).state).toBe("sealed");
    const gate = isTaskLaunchableInStore(dataOf(), {
      sessionId: SESSION,
      runId: registered.runId,
      taskId: "T-500",
    });
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.reason).toBe("EXECUTION_SEALED");
  });

  test("native overlapping in-flight review reports the exact checkpoint and the gate agrees", () => {
    const run = nativeRunFixture("run-native-overlap", {
      checkpointId: "CP-OVERLAP",
      kind: "milestone",
      afterWave: "WAVE-1",
      covers: ["T-001"],
      scope: ["src/lib/a.ts"],
      reviewers: ["code"],
      status: "in_review",
      attempts: 1,
      history: [],
      recoveryHistory: [],
    });
    dataOf().planRuns.set(run.runId, run);
    const opened = store.openWorkItem({
      sessionId: SESSION,
      key: "native-overlap",
      title: "Native bound",
      mode: "delegated",
      requiredReviewers: [],
      writeScope: ["src/lib/a.ts"],
      planRunId: run.runId,
      planTaskId: "T-001",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    run.tasks.set("T-001", { taskId: "T-001", workItemId: opened.record.workItemId });

    const { item } = listItem(opened.record.workItemId);
    expect(item?.delegated?.guidance?.nextAction).toBe("launch_blocked");
    expect(item?.delegated?.guidance?.blockers).toContain("OVERLAPPING_REVIEW:CP-OVERLAP");
    expect(findOverlappingInFlightReview(dataOf(), run.runId, ["src/lib/a.ts"])).toBe("CP-OVERLAP");
  });

  test("native unsatisfied wave barrier reports the exact checkpoint and the gate agrees", () => {
    const run = nativeRunFixture("run-native-barrier", {
      checkpointId: "CP-BARRIER",
      kind: "milestone",
      afterWave: "WAVE-0",
      covers: ["T-001"],
      scope: ["src/lib/a.ts"],
      reviewers: ["code"],
      status: "pending",
      attempts: 0,
      history: [],
      recoveryHistory: [],
    });
    dataOf().planRuns.set(run.runId, run);
    const opened = store.openWorkItem({
      sessionId: SESSION,
      key: "native-barrier",
      title: "Native barrier",
      mode: "delegated",
      requiredReviewers: [],
      writeScope: ["src/lib/a.ts"],
      planRunId: run.runId,
      planTaskId: "T-001",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    run.tasks.set("T-001", { taskId: "T-001", workItemId: opened.record.workItemId });

    const { item } = listItem(opened.record.workItemId);
    expect(item?.delegated?.guidance?.blockers).toContain("BARRIER_UNSATISFIED:CP-BARRIER");
    const barrier = checkpointBarrierUnsatisfied(dataOf(), run.runId, "WAVE-1");
    expect(barrier.ok).toBe(true);
    if (!barrier.ok) return;
    expect(barrier.blockers).toContain("CP-BARRIER");
  });

  test("accepted task status derives from the current record, not the stale binding status", () => {
    const registered = register("derived-status", [task({ taskId: "T-600" })]);
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const workItemId = registered.execution.tasks.get("T-600")!.workItemId;
    const data = dataOf();
    driveToAccepted(workItemId);
    const stored = data.executions.get(registered.runId)!;
    expect(stored.tasks.get("T-600")!.status).toBe("pending");
    expect(getExecutionView(stored).tasks[0]!.status).toBe("pending");
    expect(getExecutionView(stored, data).tasks[0]!.status).toBe("accepted");
    const listed = getWorkflowInspection(store, SESSION);
    expect((listed.executions![0] as { tasks: Array<{ status: string }> }).tasks[0]!.status).toBe(
      "accepted",
    );
  });
});

describe("authority prerequisites and reserved stages", () => {
  test("exposes finite remaining units, surviving stages, reserved stops, and provenance prerequisites", () => {
    const registered = register("authority", [task({ taskId: "T-700" })]);
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const now = new Date().toISOString();
    const authority: WorkflowAuthorityRecord = {
      authorityId: "auth-1",
      runId: registered.runId,
      rootSessionId: SESSION,
      grantedByMessageId: "msg-1",
      messageCreatedMs: Date.parse(now),
      scope: {
        stages: ["verification"],
        decisionScope: "recovery",
        fileBoundary: [],
        reservedStops: ["planning"],
      },
      initialUnits: 3,
      extensions: [],
      revocations: [],
      createdAt: now,
    };
    const execution = dataOf().executions.get(registered.runId)!;
    execution.authority.push(authority);
    execution.reserveDebits.push({
      recoveryId: "rec-auth-1",
      authorityId: "auth-1",
      targetKind: "checkpoint",
      targetId: "CP-1",
      units: 1,
      debitedAt: now,
    });

    const listed = getWorkflowInspection(store, SESSION);
    const view = listed.executions![0] as {
      authority: Array<{
        authorityId: string;
        availableUnits: number;
        revoked: boolean;
        stages: string[];
        reservedStops: string[];
        prerequisites: string[];
      }>;
    };
    expect(view.authority).toHaveLength(1);
    expect(view.authority[0]!.availableUnits).toBe(2);
    expect(view.authority[0]!.stages).toEqual(["verification"]);
    expect(view.authority[0]!.reservedStops).toEqual(["planning"]);
    expect(view.authority[0]!.prerequisites.join(" ")).toContain("host permission");
    expect(view.authority[0]!.prerequisites.join(" ")).not.toContain("fingerprint");

    execution.authority[0]!.revocations.push({
      revocationId: "rev-1",
      kind: "revoke",
      reason: "Revoked.",
      revokedAt: now,
    });
    const revoked = getWorkflowInspection(store, SESSION).executions![0] as {
      authority: Array<{ availableUnits: number; revoked: boolean }>;
    };
    expect(revoked.authority[0]!.availableUnits).toBe(0);
    expect(revoked.authority[0]!.revoked).toBe(true);
    expect(
      validateWorkflowToolResult("work_item_list", getWorkflowInspection(store, SESSION)).ok,
    ).toBe(true);
  });

  test("stale/failed generic checkpoint outcomes remain visible", () => {
    const registered = register(
      "checkpoint-history",
      [task({ taskId: "T-800" })],
      [checkpoint({ checkpointId: "CP-2", covers: ["T-800"] })],
    );
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const execution = dataOf().executions.get(registered.runId)!;
    const binding = execution.checkpoints.get("CP-2")!;
    binding.attempts = 2;
    binding.status = "failed";
    binding.recoveryHistory = [
      {
        recoveryId: "rec-cp-1",
        kind: "advance_grant",
        diagnosis: "Retry.",
        changedCondition: "Fixed.",
        verification: ["bun test src/lib/a.test.ts"],
        recoveredAt: new Date().toISOString(),
      },
    ];
    binding.history = [
      {
        generation: 1,
        outcome: "failed",
        fingerprint: "fp-1",
        completedAt: new Date().toISOString(),
      },
      {
        generation: 2,
        outcome: "stale",
        fingerprint: "fp-2",
        completedAt: new Date().toISOString(),
      },
    ];
    const listed = getWorkflowInspection(store, SESSION);
    const view = listed.executions![0] as {
      checkpoints: Array<{
        lastOutcome?: string;
        history?: Array<{ outcome: string }>;
        remainingGenerations?: number;
      }>;
    };
    expect(view.checkpoints[0]!.lastOutcome).toBe("stale");
    expect(view.checkpoints[0]!.history?.map((entry) => entry.outcome)).toEqual([
      "failed",
      "stale",
    ]);
    expect(view.checkpoints[0]!.remainingGenerations).toBe(1);
  });
});

describe("read-only invariants", () => {
  test("linked executions keep a closed work-item identity recoverable after close", () => {
    const registered = register("closed-identity", [task({ taskId: "T-960" })]);
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const workItemId = registered.execution.tasks.get("T-960")!.workItemId;
    driveToAccepted(workItemId);
    const closed = store.closeWorkItem(SESSION, workItemId);
    expect(closed.ok).toBe(true);

    const listed = getWorkflowInspection(store, SESSION, { includeClosed: false });
    expect(listed.items).toHaveLength(0);
    const execution = listed.executions![0] as {
      tasks: Array<{ taskId: string; workItemId: string; status: string }>;
    };
    expect(execution.tasks[0]!.workItemId).toBe(workItemId);
    expect(execution.tasks[0]!.status).toBe("accepted");
  });

  test("a report_rejected latest attempt stays visible as rejected", () => {
    store.openWorkItem({
      sessionId: SESSION,
      key: "report-rejected",
      title: "Rejected",
      mode: "delegated",
      requiredReviewers: [],
      writeScope: ["src/lib/a.ts"],
    });
    const record = dataOf().records.get(createRecordLookupKey(SESSION, "wi-1"))!;
    const now = new Date().toISOString();
    record.delegated!.attempts.push({
      attempt: 1,
      callId: "call-rejected",
      launchedAt: now,
      status: "report_rejected",
      completedAt: now,
      reportRejection: {
        protocolErrorCode: "MISSING_BODY_SEPARATOR",
        excerpt: {
          source: "parsed_body",
          text: "bad report",
          truncated: false,
          originalLength: 10,
          maxLength: 500,
        },
        rejectedAt: now,
      },
    });
    const { item } = listItem("wi-1");
    expect(item?.delegated?.latestAttempt?.status).toBe("report_rejected");
    expect(item?.delegated?.latestAttempt?.reportRejected).toBe(true);
  });

  test("repeated inspection keeps the exact store fingerprint unchanged", () => {
    const registered = register("readonly", [task({ taskId: "T-900" })]);
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const workItemId = registered.execution.tasks.get("T-900")!.workItemId;
    expect(
      beginDelegatedLaunchInStore(dataOf(), { sessionId: SESSION, workItemId, callId: "call-ro" })
        .ok,
    ).toBe(true);
    const before = fingerprint();
    getWorkflowInspection(store, SESSION, { includeClosed: true });
    getWorkflowInspection(store, SESSION, { includeClosed: true });
    serializeWorkItem(dataOf().records.get(createRecordLookupKey(SESSION, workItemId))!);
    expect(fingerprint()).toBe(before);
  });

  test("hydrated store data inspects without a snapshot migration", () => {
    const registered = register("hydration", [task({ taskId: "T-950" })]);
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const hydrated = createWorkItemStore(dataOf());
    const listed = getWorkflowInspection(hydrated, SESSION);
    expect(listed.executions).toHaveLength(1);
    expect(listed.items).toHaveLength(1);
    expect(validateWorkflowToolResult("work_item_list", listed).ok).toBe(true);
  });
});

describe("guidance agreement across every public nextAction surface", () => {
  test("a dependency-blocked task reports launch_blocked in the list and the close failure", () => {
    const registered = register("guidance-agree", [
      task({ taskId: "T-100" }),
      task({ taskId: "T-200", writeScope: ["src/lib/b.ts"], dependsOn: ["T-100"] }),
    ]);
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const workItemId = registered.execution.tasks.get("T-200")!.workItemId;

    const listTool = createWorkItemListTool(store);
    const listed = listTool.execute({ includeClosed: false }, { sessionId: SESSION }) as {
      items: Array<{
        workItemId: string;
        delegated?: {
          nextAction: string;
          guidance?: { nextAction: string; blockers: string[]; launchEligible: boolean };
        };
      }>;
    };
    const listedItem = listed.items.find((entry) => entry.workItemId === workItemId)!;
    expect(listedItem.delegated?.nextAction).toBe("launch_blocked");
    expect(listedItem.delegated?.guidance?.blockers).toContain("DEPENDENCIES_UNMET:T-200");
    expect(listedItem.delegated?.guidance?.launchEligible).toBe(false);

    const closeTool = createWorkItemCloseTool(store);
    const failed = closeTool.execute({ workItemId }, { sessionId: SESSION }) as {
      ok: boolean;
      errorCode: string;
      nextAction?: string;
      prerequisite?: string;
    };
    expect(failed.ok).toBe(false);
    expect(failed.errorCode).toBe("READY_TO_CLOSE_REQUIRED");
    expect(failed.nextAction).toBe(listedItem.delegated?.nextAction);
    expect(failed.nextAction).toBe("launch_blocked");
    expect(failed.prerequisite).toContain("dependency");
  });

  test("recovery into an execution whose dependency still blocks launch keeps launch_blocked", async () => {
    const registered = register("guidance-recover", [
      task({ taskId: "T-100" }),
      task({ taskId: "T-200", writeScope: ["src/lib/b.ts"], dependsOn: ["T-100"] }),
    ]);
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const workItemId = registered.execution.tasks.get("T-200")!.workItemId;

    const callId = "call-recover-dep";
    expect(
      beginDelegatedLaunchInStore(dataOf(), { sessionId: SESSION, workItemId, callId }).ok,
    ).toBe(true);
    expect(
      applyDelegatedResultInStore(dataOf(), {
        sessionId: SESSION,
        workItemId,
        callId,
        resultStatus: "BLOCKED",
      }).ok,
    ).toBe(true);

    const decideTool = createWorkItemDecideTool(store);
    const recovered = (await decideTool.execute(
      {
        workItemId,
        decision: "recover",
        attempt: 1,
        diagnosis: "Context restored.",
        changedCondition: "Fresh context.",
        verification: ["bun test src/lib/a.test.ts"],
        recoveryId: "rec-dep-1",
      },
      { sessionId: SESSION },
    )) as { ok: boolean; nextAction?: string };

    expect(recovered.ok).toBe(true);
    expect(recovered.nextAction).toBe("launch_blocked");
    const listed = getWorkflowInspection(store, SESSION);
    const item = listed.items.find((entry) => entry.workItemId === workItemId)! as {
      delegated?: { nextAction: string };
    };
    expect(item.delegated?.nextAction).toBe("launch_blocked");
  });
});

describe("authoritative native execution projection", () => {
  test("register/accept/start/review/verify/recover/seal reflects current native state", async () => {
    const { root, planPath } = await makeNativeWorkspace("native-flow");
    const loaded = await loadApprovedDelegatedPlan({ workspaceRoot: root, planPath });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const registered = registerDelegatedPlan(store, { sessionId: SESSION, plan: loaded.plan });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const runId = registered.runId;
    const run = dataOf().planRuns.get(runId)!;
    const taskWorkItemId = run.tasks.get("T-001")!.workItemId;

    acceptBoundTask(taskWorkItemId, "flow");
    let listed = getWorkflowInspection(store, SESSION);
    let execution = listed.executions!.find((entry) => entry.runId === runId)!;
    expect(execution.tasks[0]!.status).toBe("accepted");
    expect(nativeCheckpoint(runId, "CHECKPOINT-R-001", listed).nextAction).toBe("start");

    const started = await startDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-001",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    listed = getWorkflowInspection(store, SESSION);
    let cp = nativeCheckpoint(runId, "CHECKPOINT-R-001", listed);
    expect(cp.status).toBe("in_review");
    expect(cp.nextAction).toBe("collect_and_verify");
    expect(cp.currentReview?.reviewWorkItemId).toBe(started.reviewWorkItemId);

    expect(
      recordCheckpointReviewerLaunch(store, {
        runId,
        checkpointId: "CHECKPOINT-R-001",
        reviewer: "code",
        callId: "rc-1",
      }).ok,
    ).toBe(true);
    expect(
      recordCheckpointReviewerResult(store, {
        runId,
        checkpointId: "CHECKPOINT-R-001",
        reviewer: "code",
        callId: "rc-1",
        status: "NEEDS_CONTEXT",
      }).ok,
    ).toBe(true);
    const stopped = await verifyDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-001",
    });
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) return;
    expect(stopped.outcome).toBe("stopped");
    listed = getWorkflowInspection(store, SESSION);
    cp = nativeCheckpoint(runId, "CHECKPOINT-R-001", listed);
    expect(cp.nextAction).toBe("recover");

    const recovered = await recoverDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-001",
      diagnosis: "Reviewer stopped.",
      changedCondition: "Context restored.",
      verification: ["bun test src/lib/cache-store.test.ts"],
      recoveryId: "rec-1",
    });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.kind).toBe("resume");
    listed = getWorkflowInspection(store, SESSION);
    cp = nativeCheckpoint(runId, "CHECKPOINT-R-001", listed);
    expect(cp.status).toBe("failed");
    expect(cp.lastOutcome).toBe("stopped");
    expect(cp.history?.length).toBe(1);
    expect(cp.nextAction).toBe("start_next_generation");

    await startDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-001",
    });
    recordCheckpointReviewerLaunch(store, {
      runId,
      checkpointId: "CHECKPOINT-R-001",
      reviewer: "code",
      callId: "rc-2",
    });
    recordCheckpointReviewerResult(store, {
      runId,
      checkpointId: "CHECKPOINT-R-001",
      reviewer: "code",
      callId: "rc-2",
      status: "PASS",
    });
    const passed = await verifyDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-001",
    });
    expect(passed.ok).toBe(true);
    if (!passed.ok) return;
    expect(passed.outcome).toBe("passed");
    listed = getWorkflowInspection(store, SESSION);
    cp = nativeCheckpoint(runId, "CHECKPOINT-R-001", listed);
    expect(cp.status).toBe("passed");
    expect(cp.nextAction).toBe("passed");
    expect(cp.history?.length).toBe(2);

    await startDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-002",
    });
    for (const reviewer of ["spec", "code"] as const) {
      recordCheckpointReviewerLaunch(store, {
        runId,
        checkpointId: "CHECKPOINT-R-002",
        reviewer,
        callId: `rc-final-${reviewer}`,
      });
      recordCheckpointReviewerResult(store, {
        runId,
        checkpointId: "CHECKPOINT-R-002",
        reviewer,
        callId: `rc-final-${reviewer}`,
        status: "PASS",
      });
    }
    const sealed = await verifyDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-002",
      complete: true,
    });
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    expect(sealed.sealedRun).toBe(true);

    // The materialized registry stays stale-active; the authoritative view reads the run.
    expect(dataOf().executions.get(runId)!.state).toBe("active");
    listed = getWorkflowInspection(store, SESSION);
    execution = listed.executions!.find((entry) => entry.runId === runId)!;
    expect(execution.state).toBe("sealed");
    expect(execution.tasks[0]!.status).toBe("accepted");
    // The legacy planRuns view and the unified executions view agree by runId.
    const legacy = listed.planRuns!.find((entry) => entry.runId === runId)!;
    expect(legacy.status).toBe("sealed");
    const legacyFinal = legacy.checkpoints.find(
      (entry) => entry.checkpointId === "CHECKPOINT-R-002",
    )!;
    const unifiedFinal = execution.checkpoints.find(
      (entry) => entry.checkpointId === "CHECKPOINT-R-002",
    )!;
    expect(unifiedFinal.nextAction).toBe(legacyFinal.nextAction);
    expect(unifiedFinal.status).toBe(legacyFinal.status);
    expect(validateWorkflowToolResult("work_item_list", listed).ok).toBe(true);
  });

  test("legacy native run without a materialized registry is projected read-only", async () => {
    const { root, planPath } = await makeNativeWorkspace("native-legacy");
    const loaded = await loadApprovedDelegatedPlan({ workspaceRoot: root, planPath });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const registered = registerDelegatedPlanInStore(dataOf(), {
      sessionId: SESSION,
      plan: loaded.plan,
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const runId = registered.runId;
    expect(dataOf().executions.has(runId)).toBe(false);

    const before = fingerprint();
    const listed = getWorkflowInspection(store, SESSION);
    const execution = listed.executions!.find((entry) => entry.runId === runId)!;
    expect(execution.sourceKind).toBe("native-package");
    expect(execution.state).toBe("active");
    expect(execution.tasks[0]!.workItemId).toBe(registered.run.tasks.get("T-001")!.workItemId);
    // Inspection never materializes a registry entry or mutates the store.
    expect(dataOf().executions.has(runId)).toBe(false);
    expect(fingerprint()).toBe(before);
  });

  test("native checkpoint start guidance is blocked until the covered task is accepted", async () => {
    const { root, planPath } = await makeNativeWorkspace("native-blocked");
    const loaded = await loadApprovedDelegatedPlan({ workspaceRoot: root, planPath });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const registered = registerDelegatedPlan(store, { sessionId: SESSION, plan: loaded.plan });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const runId = registered.runId;
    const run = dataOf().planRuns.get(runId)!;
    const checkpoint = run.checkpoints.get("CHECKPOINT-R-001")!;

    const listed = getWorkflowInspection(store, SESSION);
    const cp = nativeCheckpoint(runId, "CHECKPOINT-R-001", listed);
    expect(cp.nextAction).toBe("blocked");
    expect(cp.prerequisite).toContain("covered task");
    const gate = checkpointStartGate(dataOf(), run, checkpoint);
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.reason).toBe("PREREQUISITES_NOT_ACCEPTED");
    const started = await startDelegatedCheckpoint(store, {
      sessionId: SESSION,
      runId,
      checkpointId: "CHECKPOINT-R-001",
    });
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.errorCode).toBe("PREREQUISITES_NOT_ACCEPTED");
  });

  test("authoritative native sealed status blocks the shared launch gate and guidance", async () => {
    const { root, planPath } = await makeNativeWorkspace("native-sealed");
    const loaded = await loadApprovedDelegatedPlan({ workspaceRoot: root, planPath });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const registered = registerDelegatedPlan(store, { sessionId: SESSION, plan: loaded.plan });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const runId = registered.runId;
    const run = dataOf().planRuns.get(runId)!;
    run.status = "sealed";
    run.sealedAt = new Date().toISOString();
    expect(dataOf().executions.get(runId)!.state).toBe("active");

    const taskWorkItemId = run.tasks.get("T-001")!.workItemId;
    const listed = getWorkflowInspection(store, SESSION);
    const item = listed.items.find((entry) => entry.workItemId === taskWorkItemId)! as {
      delegated?: { nextAction: string; guidance?: { blockers: string[] } };
    };
    expect(item.delegated?.nextAction).toBe("launch_blocked");
    expect(item.delegated?.guidance?.blockers).toContain(`EXECUTION_SEALED:${runId}`);
    const gate = isTaskLaunchableInStore(dataOf(), {
      sessionId: SESSION,
      runId,
      taskId: "T-001",
    });
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.reason).toBe("EXECUTION_SEALED");
    expect(getExecutionView(dataOf().executions.get(runId)!, dataOf()).state).toBe("sealed");
  });

  test("hydrated native state inspects without a snapshot migration", async () => {
    const { root, planPath } = await makeNativeWorkspace("native-hydrated");
    const loaded = await loadApprovedDelegatedPlan({ workspaceRoot: root, planPath });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const registered = registerDelegatedPlanInStore(dataOf(), {
      sessionId: SESSION,
      plan: loaded.plan,
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const taskWorkItemId = registered.run.tasks.get("T-001")!.workItemId;
    acceptBoundTask(taskWorkItemId, "hydrated");

    const hydrated = createWorkItemStore(dataOf());
    const listed = getWorkflowInspection(hydrated, SESSION);
    const execution = listed.executions!.find((entry) => entry.runId === registered.runId)!;
    expect(execution.tasks[0]!.status).toBe("accepted");
    expect(validateWorkflowToolResult("work_item_list", listed).ok).toBe(true);
  });

  test("foreign-session native runs are filtered before details", async () => {
    const { root, planPath } = await makeNativeWorkspace("native-foreign");
    const loaded = await loadApprovedDelegatedPlan({ workspaceRoot: root, planPath });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const foreign = registerDelegatedPlanInStore(dataOf(), {
      sessionId: FOREIGN_SESSION,
      plan: loaded.plan,
    });
    expect(foreign.ok).toBe(true);
    if (!foreign.ok) return;
    const listed = getWorkflowInspection(store, SESSION);
    expect(listed.executions ?? []).toHaveLength(0);
    expect(listed.planRuns ?? []).toHaveLength(0);
  });
});
