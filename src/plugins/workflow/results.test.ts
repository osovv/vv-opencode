// FILE: src/plugins/workflow/results.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Contract coverage of the public workflow result layer: failure category classification and guidance, tokenized input failure preservation, host-context separation, normalization of top-level and batch failures, producer validation of real handler outputs, closed per-tool result schemas (accept/reject per variant), and truthful post-side-effect serialization fallback.
//   SCOPE: Result schemas, normalization, and serialization only; isolated in-memory stores and one synthetic delegated workspace; no host process, no real session data.
//   DEPENDS: [bun:test, src/plugins/workflow/results.ts, src/plugins/workflow/tooling.ts, src/plugins/workflow/delegated.ts, src/plugins/workflow/state.ts, src/plugins/workflow/checkpoint-io.ts]
//   LINKS: [M-WORKFLOW-TOOLING, M-AGENT-TOOL-CONTRACT, M-PLUGIN-WORKFLOW]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SESSION - Stable session identifier for result fixtures.
//   validateResult - Normalizing producer validation helper.
//   createdRoots - Disposable workspace roots removed after each test.
//   newStore - Fresh per-session workflow state store fixture.
//   context - Minimal recovery/context fixture carrying the session id.
//   runDelegatedAttempt - Drives one bound delegated attempt through launch, result, and acceptance.
//   planXml - Minimal approved delegated plan XML for loader fixtures.
//   makeNativeWorkspace - Synthetic approved delegated plan workspace.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-004 - Added work_item_list additive-contract coverage: required loaded identity, generic execution views, invented next-action rejection, and authority-stage enum rejection. Prior T-003: result-contract, category/guidance, producer-validation, and serialization coverage.]
// END_CHANGE_SUMMARY

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyDelegatedResult,
  beginDelegatedLaunch,
  decideDelegatedWorkItem,
} from "./delegated.js";
import { recordCheckpointReviewerLaunch, recordCheckpointReviewerResult } from "./checkpoints.js";
import { openWorkItem, createWorkItemStore, type WorkItemStore } from "./state.js";
import {
  createWorkCheckpointTool,
  createWorkItemCloseTool,
  createWorkItemDecideTool,
  createWorkItemListTool,
  createWorkItemOpenTool,
  type DelegatedControlOptions,
} from "./tooling.js";
import {
  categoryForWorkflowErrorCode,
  failureGuidance,
  finalizeWorkflowResult,
  MAX_FAILURE_FIELD_CHARS,
  MAX_FAILURE_MESSAGE_CHARS,
  normalizeWorkflowFailure,
  normalizeWorkflowResult,
  serializeWorkflowResult,
  validateWorkflowToolResult,
  WorkflowDiagnosticError,
  workflowHostContextFailure,
  workflowInputFailure,
  workflowInternalResultFailure,
  workflowToolResultSchema,
  workflowToolResultSchemas,
  type WorkflowToolResultMap,
  type WorkflowToolResultToolId,
} from "./results.js";
import {
  MAX_CONTRACT_ISSUES,
  MAX_ISSUE_MESSAGE_CHARS,
  MAX_ISSUE_PATH_CHARS,
  MAX_ISSUE_VALUE_CHARS,
} from "../../lib/agent-tool-contract.js";
import { loadApprovedDelegatedPlan } from "./checkpoint-io.js";

const SESSION = "session-results";

function validateResult(toolId: WorkflowToolResultToolId, value: unknown) {
  const result = validateWorkflowToolResult(toolId, value);
  if (!result.ok) {
    throw new Error(
      `schema rejected ${toolId}: ${result.issues.map((issue) => `${issue.path}: ${issue.message}`).join(" | ")}`,
    );
  }
}

const createdRoots: string[] = [];

afterEach(async () => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

function newStore(): WorkItemStore {
  return createWorkItemStore();
}

function context(): { sessionId: string; workspaceRoot?: string } {
  return { sessionId: SESSION, workspaceRoot: "/tmp/results-workspace" };
}

/** Drive a delegated attempt to a terminal status and return the attempt number. */
function runDelegatedAttempt(
  store: WorkItemStore,
  workItemId: string,
  callId: string,
  resultStatus: "DONE" | "DONE_WITH_CONCERNS" | "NEEDS_CONTEXT" | "BLOCKED",
): number {
  const launched = beginDelegatedLaunch(store, { sessionId: SESSION, workItemId, callId });
  if (!launched.ok) throw new Error(launched.message);
  const applied = applyDelegatedResult(store, {
    sessionId: SESSION,
    workItemId,
    callId,
    resultStatus,
  });
  if (!applied.ok) throw new Error(applied.message);
  return launched.attempt;
}

function planXml(): string {
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
  const root = await mkdtemp(join(tmpdir(), `vvoc-results-${prefix}-`));
  createdRoots.push(root);
  const pkgDir = join(root, ".vvoc", "specs", "2026-09-11-cache");
  await mkdir(pkgDir, { recursive: true });
  await mkdir(join(root, "src", "lib"), { recursive: true });
  await writeFile(
    join(pkgDir, "spec.xml"),
    `<spec><status>approved</status><goal>Store rows.</goal><architecture>Cache.</architecture><tech_stack>TS.</tech_stack><components><COMPONENT-CACHE-STORE><name>Cache Store</name><responsibility>Holds rows.</responsibility><depends_on></depends_on></COMPONENT-CACHE-STORE></components><data_flow>Rows flow.</data_flow><error_handling>Fail open.</error_handling><testing><strategy>Unit.</strategy><coverage>Paths.</coverage></testing><non_goals><non_goal>No persistence.</non_goal></non_goals></spec>`,
    "utf8",
  );
  await writeFile(join(pkgDir, "plan.xml"), planXml(), "utf8");
  await writeFile(join(root, "src", "lib", "cache-store.ts"), "export class CacheStore {}\n");
  await writeFile(join(root, "src", "lib", "cache-store.test.ts"), "test.todo();\n");
  return { root, planPath: join(pkgDir, "plan.xml") };
}

// START_BLOCK_CATEGORY_TESTS
describe("workflow failure categories and guidance", () => {
  test("classifies representative codes into stable categories", () => {
    expect(categoryForWorkflowErrorCode("INVALID_INPUT")).toBe("input");
    expect(categoryForWorkflowErrorCode("HOST_CONTEXT_UNAVAILABLE")).toBe("host_context");
    expect(categoryForWorkflowErrorCode("PLAN_LOAD_FAILED")).toBe("host_context");
    expect(categoryForWorkflowErrorCode("PERSISTENCE_FAILED")).toBe("persistence");
    expect(categoryForWorkflowErrorCode("RESULT_CONTRACT_INVALID")).toBe("internal");
    expect(categoryForWorkflowErrorCode("CONTROL_DENIED")).toBe("authorization");
    expect(categoryForWorkflowErrorCode("AUTHORITY_DENIED")).toBe("authorization");
    expect(categoryForWorkflowErrorCode("SESSION_MISMATCH")).toBe("authorization");
    expect(categoryForWorkflowErrorCode("WORK_ITEM_NOT_FOUND")).toBe("state");
    expect(categoryForWorkflowErrorCode("CONCERNS_DISPOSITION_REQUIRED")).toBe("state");
    expect(categoryForWorkflowErrorCode("SOME_UNKNOWN_CODE")).toBe("state");
  });

  test("guidance states an unmet prerequisite without granting recovery or promising freshness", () => {
    expect(failureGuidance("READY_TO_CLOSE_REQUIRED")?.prerequisite).toContain("reviews");
    expect(failureGuidance("CONCERNS_DISPOSITION_REQUIRED")?.prerequisite).toContain(
      "concernsDisposition",
    );
    expect(failureGuidance("AUTONOMOUS_GRANT_EXHAUSTED")?.prerequisite).toContain("authority");
    expect(failureGuidance("ATTEMPT_MISMATCH")?.nextAction).toContain("work_item_list");
    const guidance = failureGuidance("ATTEMPTS_EXHAUSTED");
    expect(guidance?.nextAction?.toLowerCase()).not.toContain("retry will");
    expect(failureGuidance("UNKNOWN_CODE")).toBeUndefined();
  });

  test("input and host-context failures are distinguishable and preserve issues", () => {
    const input = workflowInputFailure("work_item_open", SESSION, [
      { code: "missing_value", path: "items[0].mode", message: "required", expected: "mode" },
    ]);
    expect(input.errorCode).toBe("INVALID_INPUT");
    expect(input.category).toBe("input");
    expect(input.issues?.[0]?.path).toBe("items[0].mode");

    const host = workflowHostContextFailure(
      "work_item_open",
      SESSION,
      "execution registration requires the trusted workspace root from the plugin context",
    );
    expect(host.errorCode).toBe("HOST_CONTEXT_UNAVAILABLE");
    expect(host.category).toBe("host_context");
    // Host context is never misreported as a caller argument error.
    expect(host.message).not.toContain("INVALID_INPUT");
  });
});
// END_BLOCK_CATEGORY_TESTS

// START_BLOCK_NORMALIZE_SERIALIZE_TESTS
describe("normalization and serialization", () => {
  test("normalizes top-level and batch failures without mutating input", () => {
    const batch = {
      tool: "work_item_open",
      sessionId: SESSION,
      items: [
        { ok: true, workItemId: "wi-1" },
        { ok: false, errorCode: "WORK_ITEM_KEY_CONFLICT", message: "conflict" },
      ],
    };
    const normalized = normalizeWorkflowResult(batch) as {
      items: Array<Record<string, unknown>>;
    };
    expect(normalized.items[0]?.category).toBeUndefined();
    expect(normalized.items[1]?.category).toBe("state");
    expect((batch.items[1] as Record<string, unknown>).category).toBeUndefined();

    const failure = normalizeWorkflowFailure({
      errorCode: "READY_TO_CLOSE_REQUIRED",
      message: "READY_TO_CLOSE_REQUIRED: not ready",
    });
    expect(failure.category).toBe("state");
    expect(failure.prerequisite).toBeDefined();
  });

  test("serialization reports a bounded truthful outcome when stringify fails after a side effect", () => {
    const circular: Record<string, unknown> = { tool: "work_checkpoint", ok: true };
    circular.self = circular;
    const text = serializeWorkflowResult(circular, { outcome: "committed" });
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.errorCode).toBe("RESULT_SERIALIZATION_FAILED");
    expect(parsed.category).toBe("internal");
    expect(parsed.outcome).toBe("committed");
    expect(parsed.applied).toBe(true);
    expect(parsed.retrySafe).toBe(false);
    // Never presented as a pre-execution input rejection.
    expect(parsed.errorCode).not.toBe("INVALID_INPUT");
    expect(String(parsed.nextAction)).toContain("inspect");
    // Bounded: raw payload is not echoed.
    expect(JSON.stringify(parsed)).not.toContain("self");
  });

  test("an unknown outcome never asserts not applied, and not_applied asserts false", () => {
    const circular: Record<string, unknown> = { tool: "work_checkpoint", ok: true };
    circular.self = circular;
    const unknownParsed = JSON.parse(serializeWorkflowResult(circular, { outcome: "unknown" })) as {
      outcome: string;
      applied?: boolean;
    };
    expect(unknownParsed.outcome).toBe("unknown");
    expect("applied" in unknownParsed).toBe(false);

    const notAppliedParsed = JSON.parse(
      serializeWorkflowResult(circular, { outcome: "not_applied" }),
    ) as { outcome: string; applied?: boolean };
    expect(notAppliedParsed.outcome).toBe("not_applied");
    expect(notAppliedParsed.applied).toBe(false);

    const rolledBackParsed = JSON.parse(
      serializeWorkflowResult(circular, { outcome: "rolled_back" }),
    ) as { outcome: string; applied?: boolean };
    expect(rolledBackParsed.outcome).toBe("rolled_back");
    expect(rolledBackParsed.applied).toBe(false);
  });

  test("serialization leaves ordinary success bodies unchanged", () => {
    const text = serializeWorkflowResult({ tool: "work_item_list", ok: true, sessionId: SESSION });
    expect(JSON.parse(text)).toEqual({ tool: "work_item_list", ok: true, sessionId: SESSION });
  });

  test("exports a schema-derived per-tool DTO map, not just a generic envelope", () => {
    expect(Object.keys(workflowToolResultSchemas)).toEqual([
      "work_item_open",
      "work_item_list",
      "work_item_close",
      "work_item_decide",
      "work_checkpoint",
    ]);
    expect(workflowToolResultSchema("work_item_open")).toBe(
      workflowToolResultSchemas.work_item_open,
    );
    // The DTO map is a real schema-derived type, not a generic failure tail.
    type OpenDto = WorkflowToolResultMap["work_item_open"];
    const dto: OpenDto = finalizeWorkflowResult({
      tool: "work_item_open",
      sessionId: SESSION,
      ok: true,
      action: "register",
      runId: "run-1",
      reused: false,
      execution: {
        runId: "run-1",
        sessionId: SESSION,
        executionKey: "run-1",
        sourceKind: "conversation-scoped",
        goal: "Deliver.",
        state: "active",
        revision: 1,
        tasks: [],
        checkpoints: [],
      },
    });
    expect((dto as { ok?: boolean }).ok).toBe(true);
  });
});
// END_BLOCK_NORMALIZE_SERIALIZE_TESTS

// START_BLOCK_PRODUCER_TESTS
describe("real producer outputs validate against their closed schemas", () => {
  test("standalone open batch, per-item failure, list, and close", () => {
    const store = newStore();
    const openTool = createWorkItemOpenTool(store);
    const listTool = createWorkItemListTool(store);
    const closeTool = createWorkItemCloseTool(store);

    const batch = openTool.execute(
      {
        items: [
          { key: "a", title: "A", mode: "implementation", requiredReviewers: ["spec"] },
          { key: "b", title: "B", mode: "delegated", requiredReviewers: [], writeScope: ["a.ts"] },
        ],
      },
      context(),
    ) as Record<string, unknown>;
    validateResult("work_item_open", batch);

    // Per-item domain conflict after structural acceptance.
    const conflict = openTool.execute(
      {
        items: [{ key: "a", title: "Different", mode: "review_only", requiredReviewers: ["code"] }],
      },
      context(),
    ) as Record<string, unknown>;
    validateResult("work_item_open", conflict);
    expect((conflict.items as Array<{ errorCode?: string }>)[0]?.errorCode).toBe(
      "WORK_ITEM_KEY_CONFLICT",
    );

    const listed = listTool.execute({ includeClosed: false }, context()) as Record<string, unknown>;
    validateResult("work_item_list", listed);

    const closeFailure = closeTool.execute({ workItemId: "wi-1" }, context()) as Record<
      string,
      unknown
    >;
    validateResult("work_item_close", closeFailure);
    const serialized = JSON.parse(serializeWorkflowResult(closeFailure)) as {
      category: string;
      prerequisite?: string;
    };
    expect(serialized.category).toBe("state");
    expect(serialized.prerequisite).toBeDefined();
  });

  test("generic register, append, and host-context failure", () => {
    const store = newStore();
    const openTool = createWorkItemOpenTool(store);
    const registered = openTool.execute(
      {
        items: [
          {
            key: "g",
            title: "G",
            mode: "delegated",
            requiredReviewers: [],
            writeScope: ["src/lib/a.ts"],
            taskId: "T-100",
          },
        ],
        execution: {
          executionKey: "run-1",
          source: { kind: "conversation-scoped" },
          goal: "Deliver.",
          boundary: { files: ["src/lib/a.ts", "src/lib/b.ts"], directories: [] },
        },
      },
      context(),
    ) as Record<string, unknown>;
    validateResult("work_item_open", registered);
    expect(registered.ok).toBe(true);

    const runId = registered.runId as string;
    const appended = openTool.execute(
      {
        items: [
          {
            key: "g2",
            title: "G2",
            mode: "delegated",
            requiredReviewers: [],
            writeScope: ["src/lib/b.ts"],
            taskId: "T-101",
          },
        ],
        runId,
        amendmentId: "amend-1",
        rationale: "Append.",
      },
      context(),
    ) as Record<string, unknown>;
    validateResult("work_item_open", appended);
    expect(appended.action).toBe("amend");

    const missingRoot = openTool.execute(
      {
        items: [
          {
            key: "g3",
            title: "G3",
            mode: "delegated",
            requiredReviewers: [],
            writeScope: ["src/lib/c.ts"],
          },
        ],
        execution: {
          executionKey: "run-2",
          source: { kind: "conversation-scoped" },
          goal: "Deliver.",
          boundary: { files: ["src/lib/c.ts"], directories: [] },
        },
      },
      { sessionId: SESSION },
    ) as Record<string, unknown>;
    validateResult("work_item_open", missingRoot);
    expect(missingRoot.errorCode).toBe("HOST_CONTEXT_UNAVAILABLE");
    expect(missingRoot.category).toBe("host_context");
  });

  test("decide accept, recover, and their failures", async () => {
    const store = newStore();
    const decideTool = createWorkItemDecideTool(store, {});

    const opened = openWorkItem(store, {
      sessionId: SESSION,
      key: "del",
      title: "Delegated",
      mode: "delegated",
      requiredReviewers: [],
      writeScope: ["src/lib/a.ts"],
    });
    if (!opened.ok) throw new Error(opened.message);
    const workItemId = opened.record.workItemId;

    const acceptedAttempt = runDelegatedAttempt(store, workItemId, "call-1", "DONE");
    const accepted = (await decideTool.execute(
      {
        workItemId,
        attempt: acceptedAttempt,
        decision: "accept",
        rationale: "Verified.",
        evidence: ["bun test"],
      },
      context(),
    )) as Record<string, unknown>;
    validateResult("work_item_decide", accepted);
    expect(accepted.action).toBe("accept");

    const opened2 = openWorkItem(store, {
      sessionId: SESSION,
      key: "del2",
      title: "Delegated 2",
      mode: "delegated",
      requiredReviewers: [],
      writeScope: ["src/lib/b.ts"],
    });
    if (!opened2.ok) throw new Error(opened2.message);
    const workItemId2 = opened2.record.workItemId;
    const stoppedAttempt = runDelegatedAttempt(store, workItemId2, "call-2", "NEEDS_CONTEXT");
    const recovered = await decideTool.execute(
      {
        workItemId: workItemId2,
        attempt: stoppedAttempt,
        decision: "recover",
        recoveryId: "rec-1",
        diagnosis: "Stopped on an unanswered product question.",
        changedCondition: "The question is now answered in the packet.",
        verification: ["bun test"],
      },
      context(),
    );
    validateResult("work_item_decide", recovered);
    expect(recovered.action).toBe("recover");

    const wrongAttempt = (await decideTool.execute(
      {
        workItemId,
        attempt: 99,
        decision: "accept",
        rationale: "Verified.",
        evidence: ["bun test"],
      },
      context(),
    )) as Record<string, unknown>;
    validateResult("work_item_decide", wrongAttempt);
    expect(wrongAttempt.errorCode).toBe("INVALID_STATE");

    // Conditional concernsDisposition is a state prerequisite, not a caller
    // input error, and the serialized failure explains the operation family.
    const opened3 = openWorkItem(store, {
      sessionId: SESSION,
      key: "del3",
      title: "Delegated 3",
      mode: "delegated",
      requiredReviewers: [],
      writeScope: ["src/lib/c.ts"],
    });
    if (!opened3.ok) throw new Error(opened3.message);
    const workItemId3 = opened3.record.workItemId;
    const concernsAttempt = runDelegatedAttempt(store, workItemId3, "call-3", "DONE_WITH_CONCERNS");
    const missingDisposition = (await decideTool.execute(
      {
        workItemId: workItemId3,
        attempt: concernsAttempt,
        decision: "accept",
        rationale: "Accepted with concerns.",
        evidence: ["bun test"],
      },
      context(),
    )) as Record<string, unknown>;
    validateResult("work_item_decide", missingDisposition);
    expect(missingDisposition.errorCode).toBe("CONCERNS_DISPOSITION_REQUIRED");
    const serializedFailure = JSON.parse(serializeWorkflowResult(missingDisposition)) as {
      category: string;
      prerequisite?: string;
    };
    expect(serializedFailure.category).toBe("state");
    expect(String(serializedFailure.prerequisite)).toContain("concernsDisposition");
  });

  test("native register and generic amend checkpoint outputs", async () => {
    const store = newStore();
    const openTool = createWorkItemOpenTool(store);
    const checkpointTool = createWorkCheckpointTool(store, {});

    const { root, planPath } = await makeNativeWorkspace("native");
    const loadPlan = async (path: string, workspaceRoot: string) => {
      const loaded = await loadApprovedDelegatedPlan({ workspaceRoot, planPath: path });
      return loaded.ok ? loaded.plan : { loadError: `${loaded.code}: ${loaded.message}` };
    };
    const nativeRegister = await checkpointTool.execute({ action: "register", planPath }, {
      sessionId: SESSION,
      workspaceRoot: root,
      loadPlan,
    } as never);
    validateResult("work_checkpoint", nativeRegister);
    expect(nativeRegister.action).toBe("register");

    const genericRegister = openTool.execute(
      {
        items: [
          {
            key: "g",
            title: "G",
            mode: "delegated",
            requiredReviewers: [],
            writeScope: ["src/lib/a.ts"],
            taskId: "T-100",
          },
        ],
        execution: {
          executionKey: "run-generic",
          source: { kind: "conversation-scoped" },
          goal: "Deliver.",
          boundary: { files: ["src/lib/a.ts"], directories: [] },
        },
      },
      context(),
    ) as Record<string, unknown>;
    const runId = genericRegister.runId as string;
    const amend = await checkpointTool.execute(
      {
        action: "amend",
        runId,
        amendmentId: "amend-1",
        rationale: "Add a task.",
        tasks: [
          {
            key: "g2",
            title: "G2",
            mode: "delegated",
            requiredReviewers: [],
            writeScope: ["src/lib/a.ts"],
            taskId: "T-101",
          },
        ],
      },
      context(),
    );
    validateResult("work_checkpoint", amend);
    expect(amend.action).toBe("amend");

    const listTool = createWorkItemListTool(store);
    const listed = listTool.execute({ includeClosed: false }, context()) as Record<string, unknown>;
    validateResult("work_item_list", listed);
    expect(Array.isArray(listed.planRuns)).toBe(true);
  });

  test("native start, verify, and recover checkpoint outputs validate against their schemas", async () => {
    const store = newStore();
    const checkpointTool = createWorkCheckpointTool(store, {});
    const { root, planPath } = await makeNativeWorkspace("native-flow");
    const loadPlan = async (path: string, workspaceRoot: string) => {
      const loaded = await loadApprovedDelegatedPlan({ workspaceRoot, planPath: path });
      return loaded.ok ? loaded.plan : { loadError: `${loaded.code}: ${loaded.message}` };
    };
    const toolContext = { sessionId: SESSION, workspaceRoot: root, loadPlan } as never;

    const registered = (await checkpointTool.execute(
      { action: "register", planPath },
      toolContext,
    )) as Record<string, unknown>;
    validateResult("work_checkpoint", registered);
    const runId = registered.runId as string;

    // Accept the covered task the checkpoint prerequisite requires.
    const run = store.getStoreData().planRuns.get(runId);
    const taskWorkItemId = run?.tasks.get("T-001")?.workItemId;
    if (!taskWorkItemId) throw new Error("missing native task binding");
    const launched = beginDelegatedLaunch(store, {
      sessionId: SESSION,
      workItemId: taskWorkItemId,
      callId: "call-native-1",
    });
    if (!launched.ok) throw new Error(launched.message);
    const applied = applyDelegatedResult(store, {
      sessionId: SESSION,
      workItemId: taskWorkItemId,
      callId: "call-native-1",
      resultStatus: "DONE",
    });
    if (!applied.ok) throw new Error(applied.message);
    const decided = decideDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId: taskWorkItemId,
      attempt: launched.attempt,
      decision: "accept",
      rationale: "Task result matches the contract.",
      evidence: ["diff"],
    });
    if (!decided.ok) throw new Error(decided.message);

    const started = await checkpointTool.execute(
      { action: "start", runId, checkpointId: "CHECKPOINT-R-001" },
      toolContext,
    );
    validateResult("work_checkpoint", started);
    expect(started.action).toBe("start");

    const reviewer = (started as { reviewersToLaunch: string[] }).reviewersToLaunch[0];
    recordCheckpointReviewerLaunch(store, {
      runId,
      checkpointId: "CHECKPOINT-R-001",
      reviewer: reviewer as "spec" | "code",
      callId: "rv-native-1",
    });
    recordCheckpointReviewerResult(store, {
      runId,
      checkpointId: "CHECKPOINT-R-001",
      reviewer: reviewer as "spec" | "code",
      callId: "rv-native-1",
      status: "PASS",
    });
    const verified = await checkpointTool.execute(
      { action: "verify", runId, checkpointId: "CHECKPOINT-R-001" },
      toolContext,
    );
    validateResult("work_checkpoint", verified);
    expect(verified.action).toBe("verify");

    // Native non-authority recovery of a reviewer hard-stop: start the final
    // checkpoint, record a NEEDS_CONTEXT reviewer, verify (marks it stopped),
    // then recover through the real handler.
    const startedFinal = (await checkpointTool.execute(
      { action: "start", runId, checkpointId: "CHECKPOINT-R-002" },
      toolContext,
    )) as Record<string, unknown>;
    validateResult("work_checkpoint", startedFinal);
    expect(startedFinal.action).toBe("start");
    const finalReviewer = (startedFinal.reviewersToLaunch as string[])[0];
    recordCheckpointReviewerLaunch(store, {
      runId,
      checkpointId: "CHECKPOINT-R-002",
      reviewer: finalReviewer as "spec" | "code",
      callId: "rv-native-stop",
    });
    recordCheckpointReviewerResult(store, {
      runId,
      checkpointId: "CHECKPOINT-R-002",
      reviewer: finalReviewer as "spec" | "code",
      callId: "rv-native-stop",
      status: "NEEDS_CONTEXT",
    });
    const stopped = (await checkpointTool.execute(
      { action: "verify", runId, checkpointId: "CHECKPOINT-R-002" },
      toolContext,
    )) as Record<string, unknown>;
    validateResult("work_checkpoint", stopped);
    expect(stopped.outcome).toBe("stopped");

    const taskAttemptsBefore =
      store.getWorkItem(SESSION, taskWorkItemId)?.delegated?.attempts.length ?? 0;
    const recovered = (await checkpointTool.execute(
      {
        action: "recover",
        runId,
        checkpointId: "CHECKPOINT-R-002",
        recoveryId: "rec-native-1",
        diagnosis: "The spec reviewer needs a product decision.",
        changedCondition: "The decision is recorded in the review packet.",
        verification: ["bun test src/lib/cache-store.test.ts"],
      },
      toolContext,
    )) as Record<string, unknown>;
    validateResult("work_checkpoint", recovered);
    expect(recovered.action).toBe("recover");
    expect(recovered.kind).toBe("resume");
    expect(recovered.settledStoppedGeneration).toBe(1);
    expect(recovered.checkpointStatus).toBe("failed");
    const serializedRecover = JSON.parse(serializeWorkflowResult(recovered)) as {
      action: string;
      settledStoppedGeneration: number;
    };
    expect(serializedRecover.action).toBe("recover");
    expect(serializedRecover.settledStoppedGeneration).toBe(1);

    // The reducer settled the stopped generation without manufacturing budget
    // or resetting the checkpoint/attempt counters.
    const checkpoint = store
      .getStoreData()
      .planRuns.get(runId)!
      .checkpoints.get("CHECKPOINT-R-002")!;
    expect(checkpoint.status).toBe("failed");
    expect(checkpoint.lastOutcome).toBe("stopped");
    expect(checkpoint.currentReview).toBeUndefined();
    expect(checkpoint.attempts).toBe(1);
    expect(checkpoint.history.at(-1)).toMatchObject({ generation: 1, outcome: "stopped" });
    expect(checkpoint.recoveryHistory.at(-1)).toMatchObject({
      recoveryId: "rec-native-1",
      kind: "resume",
      targetGeneration: 1,
    });
    expect(store.getWorkItem(SESSION, taskWorkItemId)?.delegated?.attempts.length).toBe(
      taskAttemptsBefore,
    );

    // A subsequent start advances to generation 2 rather than resetting to 1.
    const restarted = (await checkpointTool.execute(
      { action: "start", runId, checkpointId: "CHECKPOINT-R-002" },
      toolContext,
    )) as Record<string, unknown>;
    validateResult("work_checkpoint", restarted);
    expect((restarted as { generation: number }).generation).toBe(2);
  });

  test("native user-authorized checkpoint recovery is a real producer result", async () => {
    const store = newStore();
    const checkpointTool = createWorkCheckpointTool(store, {
      lookupUserMessage: async (_sessionId, messageId) => ({
        id: messageId,
        role: "user",
        sessionID: SESSION,
        timeCreatedMs: Date.now() + 100_000,
      }),
    });
    const { root, planPath } = await makeNativeWorkspace("native-user");
    const loadPlan = async (path: string, workspaceRoot: string) => {
      const loaded = await loadApprovedDelegatedPlan({ workspaceRoot, planPath: path });
      return loaded.ok ? loaded.plan : { loadError: `${loaded.code}: ${loaded.message}` };
    };
    const toolContext = { sessionId: SESSION, workspaceRoot: root, loadPlan } as never;

    const registered = (await checkpointTool.execute(
      { action: "register", planPath },
      toolContext,
    )) as Record<string, unknown>;
    validateResult("work_checkpoint", registered);
    const runId = registered.runId as string;

    const run = store.getStoreData().planRuns.get(runId);
    const taskWorkItemId = run?.tasks.get("T-001")?.workItemId;
    if (!taskWorkItemId) throw new Error("missing native task binding");
    const launched = beginDelegatedLaunch(store, {
      sessionId: SESSION,
      workItemId: taskWorkItemId,
      callId: "call-native-user-1",
    });
    if (!launched.ok) throw new Error(launched.message);
    const applied = applyDelegatedResult(store, {
      sessionId: SESSION,
      workItemId: taskWorkItemId,
      callId: "call-native-user-1",
      resultStatus: "DONE",
    });
    if (!applied.ok) throw new Error(applied.message);
    const decided = decideDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId: taskWorkItemId,
      attempt: launched.attempt,
      decision: "accept",
      rationale: "Task result matches the contract.",
      evidence: ["diff"],
    });
    if (!decided.ok) throw new Error(decided.message);

    // Exhaust the milestone checkpoint's ordinary generations with real FAILs.
    for (const generation of [1, 2]) {
      const started = (await checkpointTool.execute(
        { action: "start", runId, checkpointId: "CHECKPOINT-R-001" },
        toolContext,
      )) as Record<string, unknown>;
      validateResult("work_checkpoint", started);
      if (started.ok !== true) throw new Error("checkpoint start failed");
      recordCheckpointReviewerLaunch(store, {
        runId,
        checkpointId: "CHECKPOINT-R-001",
        reviewer: "code",
        callId: `rv-native-user-${generation}`,
      });
      recordCheckpointReviewerResult(store, {
        runId,
        checkpointId: "CHECKPOINT-R-001",
        reviewer: "code",
        callId: `rv-native-user-${generation}`,
        status: "FAIL",
      });
      const verified = (await checkpointTool.execute(
        { action: "verify", runId, checkpointId: "CHECKPOINT-R-001" },
        toolContext,
      )) as Record<string, unknown>;
      validateResult("work_checkpoint", verified);
      expect(verified.outcome).toBe("failed");
    }
    const exhausted = store
      .getStoreData()
      .planRuns.get(runId)!
      .checkpoints.get("CHECKPOINT-R-001")!;
    expect(exhausted.status).toBe("failed");
    expect(exhausted.attempts).toBe(2);

    const recovered = (await checkpointTool.execute(
      {
        action: "recover",
        runId,
        checkpointId: "CHECKPOINT-R-001",
        recoveryId: "rec-native-user-1",
        diagnosis: "Both ordinary generations failed.",
        changedCondition: "The root user authorized one further generation.",
        verification: ["bun test src/lib/cache-store.test.ts"],
        userMessageId: "msg-native-user-1",
      },
      toolContext,
    )) as Record<string, unknown>;
    validateResult("work_checkpoint", recovered);
    expect(recovered.action).toBe("recover");
    expect(recovered.kind).toBe("user_grant");
    expect(recovered.checkpointStatus).toBe("failed");
    const serialized = JSON.parse(serializeWorkflowResult(recovered)) as { kind: string };
    expect(serialized.kind).toBe("user_grant");

    const settled = store.getStoreData().planRuns.get(runId)!.checkpoints.get("CHECKPOINT-R-001")!;
    expect(settled.recoveryHistory.at(-1)).toMatchObject({
      recoveryId: "rec-native-user-1",
      kind: "user_grant",
      userMessageId: "msg-native-user-1",
    });
  });

  test("generic authority outputs validate against their variants", async () => {
    const store = newStore();
    const openTool = createWorkItemOpenTool(store);
    const authoritySnapshot = {
      messageId: "msg-1",
      sessionId: SESSION,
      role: "user" as const,
      createdMs: 1,
      ignored: false,
      syntheticOnly: false,
      textParts: ["Authorize the implementation stage."],
    };
    const control: DelegatedControlOptions = {
      lookupAuthorityMessage: async () => authoritySnapshot,
    };
    const checkpointTool = createWorkCheckpointTool(store, control);

    const registered = openTool.execute(
      {
        items: [
          {
            key: "g",
            title: "G",
            mode: "delegated",
            requiredReviewers: [],
            writeScope: ["src/lib/a.ts"],
            taskId: "T-100",
          },
        ],
        execution: {
          executionKey: "run-auth",
          source: { kind: "conversation-scoped" },
          goal: "Deliver.",
          boundary: { files: ["src/lib/a.ts"], directories: [] },
        },
      },
      context(),
    ) as Record<string, unknown>;
    const runId = registered.runId as string;

    const authorize = await checkpointTool.execute(
      {
        action: "authorize",
        runId,
        authorityId: "auth-1",
        messageId: "msg-1",
        stages: ["implementation"],
      },
      context(),
    );
    validateResult("work_checkpoint", authorize);
    expect(authorize.action).toBe("authorize");

    const approval = await checkpointTool.execute(
      {
        action: "record_approval",
        runId,
        authorityId: "auth-1",
        approvalId: "appr-1",
        stage: "implementation",
        artifactPath: "src/lib/a.ts",
        artifactSha256: "abc",
      },
      context(),
    );
    validateResult("work_checkpoint", approval);
    expect(approval.action).toBe("record_approval");

    const revoke = await checkpointTool.execute(
      {
        action: "revoke_authority",
        runId,
        authorityId: "auth-1",
        revocationId: "revoke-1",
      },
      context(),
    );
    validateResult("work_checkpoint", revoke);
    expect(revoke.action).toBe("revoke_authority");
  });
});
// END_BLOCK_PRODUCER_TESTS

// START_BLOCK_STATE_DIAGNOSTIC_TESTS
describe("owned state failures expose current state, attempt, and prerequisite", () => {
  function openDelegated(store: WorkItemStore, key: string, writeScope: string) {
    const opened = openWorkItem(store, {
      sessionId: SESSION,
      key,
      title: key,
      mode: "delegated",
      requiredReviewers: [],
      writeScope: [writeScope],
    });
    if (!opened.ok) throw new Error(opened.message);
    return opened.record.workItemId;
  }

  function serializedFailure(value: Record<string, unknown>) {
    return JSON.parse(serializeWorkflowResult(value)) as {
      category: string;
      state?: string;
      attempt?: number;
      attemptStatus?: string;
      resultStatus?: string;
      attemptBudget?: number;
      remainingAttempts?: number;
      pendingReviewers?: string[];
      prerequisite?: string;
      nextAction?: string;
    };
  }

  test("a wrong attempt on awaiting_acceptance reports the current state and attempt", async () => {
    const store = newStore();
    const decideTool = createWorkItemDecideTool(store, {});
    const workItemId = openDelegated(store, "wrong-attempt", "src/lib/a.ts");
    runDelegatedAttempt(store, workItemId, "call-1", "DONE");

    const failure = (await decideTool.execute(
      {
        workItemId,
        attempt: 99,
        decision: "accept",
        rationale: "Verified.",
        evidence: ["bun test"],
      },
      context(),
    )) as Record<string, unknown>;
    validateResult("work_item_decide", failure);
    const parsed = serializedFailure(failure);
    expect(parsed.category).toBe("state");
    expect(parsed.state).toBe("awaiting_acceptance");
    expect(parsed.attempt).toBe(1);
    expect(parsed.attemptStatus).toBe("completed");
    expect(parsed.attemptBudget).toBe(2);
    expect(parsed.remainingAttempts).toBe(1);
    expect(String(parsed.prerequisite)).toContain("attempt");
  });

  test("required and unexpected concerns disposition are reported with the actual result status", async () => {
    const store = newStore();
    const decideTool = createWorkItemDecideTool(store, {});
    const concernsItem = openDelegated(store, "concerns", "src/lib/a.ts");
    runDelegatedAttempt(store, concernsItem, "call-c", "DONE_WITH_CONCERNS");
    const required = (await decideTool.execute(
      {
        workItemId: concernsItem,
        attempt: 1,
        decision: "accept",
        rationale: "Accepted.",
        evidence: ["bun test"],
      },
      context(),
    )) as Record<string, unknown>;
    validateResult("work_item_decide", required);
    const requiredParsed = serializedFailure(required);
    expect(requiredParsed.prerequisite).toContain("concernsDisposition");
    expect(requiredParsed.resultStatus).toBe("DONE_WITH_CONCERNS");

    const doneItem = openDelegated(store, "done", "src/lib/b.ts");
    runDelegatedAttempt(store, doneItem, "call-d", "DONE");
    const unexpected = (await decideTool.execute(
      {
        workItemId: doneItem,
        attempt: 1,
        decision: "accept",
        rationale: "Accepted.",
        evidence: ["bun test"],
        concernsDisposition: "No concerns recorded.",
      },
      context(),
    )) as Record<string, unknown>;
    validateResult("work_item_decide", unexpected);
    const unexpectedParsed = serializedFailure(unexpected);
    expect(unexpectedParsed.prerequisite).toContain("DONE_WITH_CONCERNS");
    expect(unexpectedParsed.resultStatus).toBe("DONE");
  });

  test("premature delegated close requires a controller acceptance", () => {
    const store = newStore();
    const closeTool = createWorkItemCloseTool(store);
    const workItemId = openDelegated(store, "premature-close", "src/lib/a.ts");
    const failure = closeTool.execute({ workItemId }, context()) as Record<string, unknown>;
    validateResult("work_item_close", failure);
    const parsed = serializedFailure(failure);
    expect(parsed.category).toBe("state");
    expect(parsed.state).toBeTruthy();
    expect(String(parsed.prerequisite).toLowerCase()).toContain("acceptance");
  });

  test("pending review close reports the pending reviewer set", () => {
    const store = newStore();
    const closeTool = createWorkItemCloseTool(store);
    const opened = openWorkItem(store, {
      sessionId: SESSION,
      key: "pending-review",
      title: "Pending review",
      mode: "review_only",
      requiredReviewers: ["spec"],
    });
    if (!opened.ok) throw new Error(opened.message);
    const failure = closeTool.execute(
      { workItemId: opened.record.workItemId },
      context(),
    ) as Record<string, unknown>;
    validateResult("work_item_close", failure);
    const parsed = serializedFailure(failure);
    expect(parsed.state).toBe("awaiting_reviews");
    expect(parsed.pendingReviewers).toEqual(["spec"]);
    expect(String(parsed.prerequisite)).toContain("review");
  });

  test("exhausted allowance guidance names the real budget and next action", () => {
    // Contract fixture for the exhausted-allowance family: the producer attaches
    // the live remaining budget, and finalization keeps the truthful guidance.
    const failure = finalizeWorkflowResult({
      tool: "work_item_decide",
      sessionId: SESSION,
      ok: false,
      errorCode: "ATTEMPTS_EXHAUSTED",
      message: "ATTEMPTS_EXHAUSTED: no attempts remain",
      state: "blocked",
      attempt: 2,
      attemptStatus: "completed",
      attemptBudget: 2,
      remainingAttempts: 0,
      nextAction: "recover",
    });
    const parsed = serializedFailure(failure);
    expect(parsed.category).toBe("state");
    expect(parsed.attemptBudget).toBe(2);
    expect(parsed.remainingAttempts).toBe(0);
    expect(parsed.nextAction).toBe("recover");
    expect(String(parsed.prerequisite)).toContain("recovery");
  });
});
// END_BLOCK_STATE_DIAGNOSTIC_TESTS

// START_BLOCK_BOUNDS_TESTS
describe("failure diagnostics are finitely bounded", () => {
  const HUGE = "x".repeat(100_000);

  test("normalization bounds message, issues, paths, and context fields", () => {
    const issues = Array.from({ length: 50 }, () => ({
      code: "invalid_value" as const,
      path: "p".repeat(500),
      message: HUGE,
      expected: HUGE,
      received: HUGE,
    }));
    const normalized = normalizeWorkflowFailure({
      errorCode: "INVALID_INPUT",
      message: HUGE,
      issues,
      state: HUGE,
      prerequisite: HUGE,
      nextAction: HUGE,
      runId: HUGE,
      existingWorkItemId: HUGE,
    });
    expect(normalized.message.length).toBeLessThanOrEqual(MAX_FAILURE_MESSAGE_CHARS);
    expect(normalized.issues?.length).toBeLessThanOrEqual(MAX_CONTRACT_ISSUES);
    for (const issue of normalized.issues ?? []) {
      expect(issue.path.length).toBeLessThanOrEqual(MAX_ISSUE_PATH_CHARS);
      expect(issue.message.length).toBeLessThanOrEqual(MAX_ISSUE_MESSAGE_CHARS);
      expect((issue.expected ?? "").length).toBeLessThanOrEqual(MAX_ISSUE_MESSAGE_CHARS);
      expect((issue.received ?? "").length).toBeLessThanOrEqual(MAX_ISSUE_VALUE_CHARS);
    }
    expect((normalized.state ?? "").length).toBeLessThanOrEqual(MAX_FAILURE_FIELD_CHARS);
    expect((normalized.prerequisite ?? "").length).toBeLessThanOrEqual(MAX_FAILURE_FIELD_CHARS);
    expect((normalized.nextAction ?? "").length).toBeLessThanOrEqual(MAX_FAILURE_FIELD_CHARS);
    expect((normalized.runId ?? "").length).toBeLessThanOrEqual(MAX_FAILURE_FIELD_CHARS);
    expect((normalized.existingWorkItemId ?? "").length).toBeLessThanOrEqual(
      MAX_FAILURE_FIELD_CHARS,
    );
    // The code/prefix survives truncation.
    expect(normalized.errorCode).toBe("INVALID_INPUT");
  });

  test("constructors and the thrown diagnostic bound their message", () => {
    const internal = workflowInternalResultFailure({
      tool: "work_checkpoint",
      message: HUGE,
      outcome: "not_applied",
    });
    expect(internal.message.length).toBeLessThanOrEqual(MAX_FAILURE_MESSAGE_CHARS);

    const host = workflowHostContextFailure("work_checkpoint", SESSION, HUGE);
    expect(host.message.length).toBeLessThanOrEqual(MAX_FAILURE_MESSAGE_CHARS);

    const input = workflowInputFailure("work_item_open", SESSION, [
      {
        code: "invalid_value",
        path: "p".repeat(500),
        message: HUGE,
        expected: HUGE,
        received: HUGE,
      },
    ]);
    expect(input.issues?.length).toBeLessThanOrEqual(MAX_CONTRACT_ISSUES);
    expect(input.issues?.[0]?.path.length).toBeLessThanOrEqual(MAX_ISSUE_PATH_CHARS);

    const diagnostic = new WorkflowDiagnosticError(
      "PERSISTENCE_FAILED",
      "persistence",
      `PERSISTENCE_FAILED: persisted state is invalid ${HUGE}`,
      "rolled_back",
    );
    expect(diagnostic.message.length).toBeLessThanOrEqual(MAX_FAILURE_MESSAGE_CHARS);
    expect(diagnostic.message.startsWith("PERSISTENCE_FAILED")).toBe(true);
    expect(diagnostic.code).toBe("PERSISTENCE_FAILED");
    expect(diagnostic.category).toBe("persistence");
    expect(diagnostic.outcome).toBe("rolled_back");
  });

  test("a raw oversized failure fails the wire schema; the finalized one passes", () => {
    const raw = {
      tool: "work_checkpoint",
      sessionId: SESSION,
      ok: false,
      errorCode: "RUN_NOT_FOUND",
      category: "state",
      message: HUGE,
    };
    expect(validateWorkflowToolResult("work_checkpoint", raw).ok).toBe(false);
    const finalized = finalizeWorkflowResult(raw);
    expect(validateWorkflowToolResult("work_checkpoint", finalized).ok).toBe(true);
    expect(JSON.parse(serializeWorkflowResult(finalized)).message.length).toBeLessThanOrEqual(
      MAX_FAILURE_MESSAGE_CHARS,
    );
  });
});
// END_BLOCK_BOUNDS_TESTS

// START_BLOCK_SCHEMA_VARIANT_TESTS
describe("closed result schemas accept each documented variant and reject drift", () => {
  const decideRecover = {
    tool: "work_item_decide",
    sessionId: SESSION,
    ok: true,
    action: "recover",
    workItemId: "wi-1",
    recoveryId: "rec-1",
    kind: "resume",
    attemptBudget: 2,
    remainingAttempts: 1,
    state: "awaiting_implementer",
    nextAction: "launch_implementer",
  };
  const checkpointVerifyNative = {
    tool: "work_checkpoint",
    sessionId: SESSION,
    ok: true,
    action: "verify",
    runId: "run-1",
    checkpointId: "C-1",
    outcome: "passed",
    snapshotCurrent: true,
  };
  const checkpointComplete = {
    tool: "work_checkpoint",
    sessionId: SESSION,
    runId: "run-1",
    ok: true,
    action: "complete",
    reviewStatus: "controller_accepted",
    execution: {
      runId: "run-1",
      sessionId: SESSION,
      executionKey: "run-1",
      sourceKind: "conversation-scoped",
      goal: "Deliver.",
      state: "sealed",
      revision: 3,
      tasks: [],
      checkpoints: [],
    },
  };
  const failure = {
    tool: "work_checkpoint",
    sessionId: SESSION,
    runId: "run-1",
    ok: false,
    errorCode: "EXECUTION_NOT_FOUND",
    message: "no execution run-1",
  };
  const openBatch = {
    tool: "work_item_open",
    sessionId: SESSION,
    items: [
      {
        ok: true,
        reused: false,
        workItemId: "wi-1",
        header: "VVOC_WORK_ITEM_ID: wi-1",
        key: "k",
        title: "T",
        mode: "implementation",
        requiredReviewers: ["spec"],
        state: "awaiting_reviews",
        specReviewCount: 0,
        codeReviewCount: 0,
        reviewRound: 0,
        completedReviewRoundCount: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
  const openRegister = {
    tool: "work_item_open",
    sessionId: SESSION,
    ok: true,
    action: "register",
    runId: "run-1",
    reused: false,
    execution: checkpointComplete.execution,
  };
  const decideRework = {
    tool: "work_item_decide",
    sessionId: SESSION,
    ok: true,
    action: "rework",
    workItemId: "wi-1",
    reworkId: "rw-1",
    grantedAttempts: 1,
    state: "awaiting_implementer",
  };
  const closeSuccess = {
    tool: "work_item_close",
    sessionId: SESSION,
    ok: true,
    workItemId: "wi-1",
    header: "VVOC_WORK_ITEM_ID: wi-1",
    state: "closed",
    closedAt: "2026-01-01T00:00:00.000Z",
  };
  const checkpointStart = {
    tool: "work_checkpoint",
    sessionId: SESSION,
    ok: true,
    action: "start",
    runId: "run-1",
    checkpointId: "C-1",
    generation: 1,
    reviewWorkItemId: "wi-2",
    header: "VVOC_WORK_ITEM_ID: wi-2",
    reviewersToLaunch: ["code"],
    coveredAttemptIds: ["wi-1"],
  };
  const checkpointReview = {
    tool: "work_checkpoint",
    sessionId: SESSION,
    ok: true,
    action: "review",
    runId: "run-1",
    checkpointId: "C-1",
    reviewer: "code",
    outcome: "passed",
    checkpointStatus: "passed",
  };
  const checkpointRecoverNative = {
    tool: "work_checkpoint",
    sessionId: SESSION,
    ok: true,
    action: "recover",
    runId: "run-1",
    checkpointId: "C-1",
    recoveryId: "rec-1",
    kind: "advance_grant",
    checkpointStatus: "in_review",
    generationBudget: 3,
    settledStoppedGeneration: 1,
    lastOutcome: "stopped",
  };
  const checkpointAuthorizeExtension = {
    tool: "work_checkpoint",
    sessionId: SESSION,
    runId: "run-1",
    ok: true,
    action: "authorize",
    authorityId: "auth-1",
    extensions: 1,
    availableUnits: 1,
  };

  test("accepts every documented checkpoint/decide/open/close variant", () => {
    validateResult("work_item_open", openBatch);
    validateResult("work_item_open", openRegister);
    validateResult("work_item_decide", decideRecover);
    validateResult("work_item_decide", decideRework);
    validateResult("work_item_close", closeSuccess);
    validateResult("work_checkpoint", checkpointVerifyNative);
    validateResult("work_checkpoint", checkpointComplete);
    validateResult("work_checkpoint", checkpointStart);
    validateResult("work_checkpoint", checkpointReview);
    validateResult("work_checkpoint", checkpointRecoverNative);
    validateResult("work_checkpoint", checkpointAuthorizeExtension);
    validateResult("work_checkpoint", finalizeWorkflowResult(failure));
  });

  test("a raw malformed producer failure is not repaired by validation", () => {
    // No category: validation must reject rather than silently normalize.
    const rawFailure = {
      tool: "work_checkpoint",
      sessionId: SESSION,
      ok: false,
      errorCode: "EXECUTION_NOT_FOUND",
      message: "no execution",
    };
    expect(validateWorkflowToolResult("work_checkpoint", rawFailure).ok).toBe(false);
    expect(
      validateWorkflowToolResult("work_checkpoint", finalizeWorkflowResult(rawFailure)).ok,
    ).toBe(true);
    // A failure tagged for another owned tool is rejected by the `tool` literal.
    const wrongTool = finalizeWorkflowResult({
      tool: "work_item_open",
      sessionId: SESSION,
      ok: false,
      errorCode: "EXECUTION_NOT_FOUND",
      message: "no execution",
    });
    expect(validateWorkflowToolResult("work_checkpoint", wrongTool).ok).toBe(false);
  });

  test("rejects a missing required member for every documented variant", () => {
    // An opaque record where a known execution view is required is not accepted.
    const opaqueExecution = { ...checkpointComplete, execution: { anything: true } };
    expect(validateWorkflowToolResult("work_checkpoint", opaqueExecution).ok).toBe(false);
    // Unknown top-level fields must not be silently accepted.
    const extra = { ...decideRecover, unexpected: true };
    expect(validateWorkflowToolResult("work_item_decide", extra).ok).toBe(false);

    const cases: Array<{
      toolId: WorkflowToolResultToolId;
      fixture: Record<string, unknown>;
      remove: string;
    }> = [
      { toolId: "work_item_open", fixture: openBatch, remove: "items" },
      { toolId: "work_item_open", fixture: openRegister, remove: "execution" },
      { toolId: "work_item_decide", fixture: decideRecover, remove: "nextAction" },
      { toolId: "work_item_decide", fixture: decideRework, remove: "reworkId" },
      { toolId: "work_item_close", fixture: closeSuccess, remove: "closedAt" },
      { toolId: "work_checkpoint", fixture: checkpointVerifyNative, remove: "snapshotCurrent" },
      { toolId: "work_checkpoint", fixture: checkpointComplete, remove: "execution" },
      { toolId: "work_checkpoint", fixture: checkpointStart, remove: "checkpointId" },
      { toolId: "work_checkpoint", fixture: checkpointReview, remove: "outcome" },
      { toolId: "work_checkpoint", fixture: checkpointRecoverNative, remove: "kind" },
      {
        toolId: "work_checkpoint",
        fixture: checkpointAuthorizeExtension,
        remove: "availableUnits",
      },
    ];
    for (const { toolId, fixture, remove } of cases) {
      const mutated = { ...fixture };
      delete mutated[remove];
      expect(validateWorkflowToolResult(toolId, mutated).ok).toBe(false);
    }
  });
});
// END_BLOCK_SCHEMA_VARIANT_TESTS

// START_BLOCK_INSPECTION_RESULT_TESTS
describe("work_item_list additive inspection schema", () => {
  test("accepts the loaded contract identity and generic execution views", () => {
    const store = newStore();
    const openTool = createWorkItemOpenTool(store);
    const registered = openTool.execute(
      {
        items: [
          {
            key: "inspection",
            title: "Inspection",
            mode: "delegated",
            requiredReviewers: [],
            writeScope: ["src/lib/a.ts"],
            taskId: "T-100",
          },
        ],
        execution: {
          executionKey: "inspection-run",
          source: { kind: "conversation-scoped" },
          goal: "Deliver.",
          boundary: { files: ["src/lib/a.ts"], directories: [] },
        },
      },
      context(),
    ) as Record<string, unknown>;
    expect(registered.ok).toBe(true);

    const listTool = createWorkItemListTool(store);
    const listed = listTool.execute({ includeClosed: false }, context()) as Record<string, unknown>;
    validateResult("work_item_list", listed);
    const contract = listed.contract as { packageVersion: string; toolContractRevision: string };
    expect(typeof contract.packageVersion).toBe("string");
    expect(contract.toolContractRevision).toBe("1");
    const executions = listed.executions as Array<{
      sourceKind: string;
      tasks: Array<{ status: string }>;
    }>;
    expect(executions).toHaveLength(1);
    expect(executions[0]!.sourceKind).toBe("conversation-scoped");
    expect(executions[0]!.tasks[0]!.status).toBe("pending");
  });

  test("rejects a list view that omits the loaded contract identity", () => {
    const store = newStore();
    const listTool = createWorkItemListTool(store);
    const listed = listTool.execute({ includeClosed: false }, context()) as Record<string, unknown>;
    validateResult("work_item_list", listed);
    const withoutContract = { ...listed };
    delete withoutContract.contract;
    expect(validateWorkflowToolResult("work_item_list", withoutContract).ok).toBe(false);
  });

  test("rejects an invented next action and an unknown authority stage", () => {
    const baseItem = {
      workItemId: "wi-1",
      header: "VVOC_WORK_ITEM_ID: wi-1",
      key: "k",
      title: "T",
      mode: "delegated",
      requiredReviewers: [],
      state: "open",
      specReviewCount: 0,
      codeReviewCount: 0,
      reviewRound: 0,
      completedReviewRoundCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      delegated: {
        writeScope: ["src/lib/a.ts"],
        attempts: 0,
        inFlightAttempt: false,
        decisions: 0,
        accepted: false,
        reworkCount: 0,
        attemptBudget: 2,
        remainingAttempts: 2,
        recoveryCount: 0,
        autonomousGrantConsumed: false,
        reportRejectionCount: 0,
        nextAction: "launch_implementer",
      },
    };
    const baseList = {
      tool: "work_item_list",
      sessionId: SESSION,
      includeClosed: false,
      items: [baseItem],
      contract: {
        packageName: "@osovv/vv-opencode",
        packageVersion: "1.0.0",
        toolContractRevision: "1",
        referencePath: "/pkg/templates/skills/vv-execute/references/tool-contracts.md",
      },
    };
    validateResult("work_item_list", baseList);

    const invented = {
      ...baseList,
      items: [{ ...baseItem, delegated: { ...baseItem.delegated, nextAction: "launch_now" } }],
    };
    expect(validateWorkflowToolResult("work_item_list", invented).ok).toBe(false);

    const execution = {
      runId: "run-1",
      sessionId: SESSION,
      executionKey: "k",
      sourceKind: "conversation-scoped",
      goal: "Deliver.",
      state: "active",
      revision: 1,
      tasks: [],
      checkpoints: [],
      authority: [
        {
          authorityId: "auth-1",
          availableUnits: 2,
          revoked: false,
          stages: ["verification"],
          reservedStops: [],
          prerequisites: ["host permission/context"],
        },
      ],
    };
    validateResult("work_item_list", { ...baseList, executions: [execution] });
    const bogusStage = {
      ...baseList,
      executions: [
        { ...execution, authority: [{ ...execution.authority[0]!, stages: ["made_up"] }] },
      ],
    };
    expect(validateWorkflowToolResult("work_item_list", bogusStage).ok).toBe(false);
  });

  test("accepts additive native checkpoint generation/outcome/eligibility fields", () => {
    const list = {
      tool: "work_item_list",
      sessionId: SESSION,
      includeClosed: false,
      items: [],
      executions: [
        {
          runId: "run-native",
          sessionId: SESSION,
          executionKey: "native:/p/plan.xml",
          sourceKind: "native-package",
          goal: "Native run.",
          state: "active",
          revision: 1,
          tasks: [],
          checkpoints: [
            {
              checkpointId: "CHECKPOINT-R-001",
              kind: "milestone",
              covers: ["T-001"],
              requiredReviewers: ["code"],
              status: "pending",
              attempts: 0,
              generationBudget: 2,
              remainingGenerations: 2,
              nextAction: "blocked",
              prerequisite:
                "PREREQUISITES_NOT_ACCEPTED: covered task T-001 has no accepted attempt",
              history: [
                { generation: 1, outcome: "stopped", completedAt: "2026-01-01T00:00:00.000Z" },
              ],
            },
          ],
        },
      ],
      contract: {
        packageName: "@osovv/vv-opencode",
        packageVersion: "1.0.0",
        toolContractRevision: "1",
        referencePath: "/pkg/templates/skills/vv-execute/references/tool-contracts.md",
      },
    };
    validateResult("work_item_list", list);
    const checkpoint = list.executions[0]!.checkpoints[0]!;
    const bogusNextAction = {
      ...list,
      executions: [
        { ...list.executions[0]!, checkpoints: [{ ...checkpoint, nextAction: "start_now" }] },
      ],
    };
    expect(validateWorkflowToolResult("work_item_list", bogusNextAction).ok).toBe(false);
    const bogusHistoryOutcome = {
      ...list,
      executions: [
        {
          ...list.executions[0]!,
          checkpoints: [
            {
              ...checkpoint,
              history: [
                { generation: 1, outcome: "made_up", completedAt: "2026-01-01T00:00:00.000Z" },
              ],
            },
          ],
        },
      ],
    };
    expect(validateWorkflowToolResult("work_item_list", bogusHistoryOutcome).ok).toBe(false);
  });
});
// END_BLOCK_INSPECTION_RESULT_TESTS
