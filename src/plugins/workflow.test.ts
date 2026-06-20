// FILE: src/plugins/workflow.test.ts
// VERSION: 0.4.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify workflow core modules and WorkflowPlugin integration behavior.
//   SCOPE: Protocol parsing, resumable task wrapper unwrapping, explicit work-item open contract, mode-aware launch validation, collect-all review-round aggregation, tooling responses, plugin hooks, persistence round-trips, and primary-only guidance injection.
//   DEPENDS: [bun:test, node:fs, node:path, src/lib/config-layers.ts, src/plugins/workflow/protocol.ts, src/plugins/workflow/repair.ts, src/plugins/workflow/state.ts, src/plugins/workflow/transitions.ts, src/plugins/workflow/tooling.ts, src/plugins/workflow/index.ts, src/plugins/workflow/persistence.ts]
//   LINKS: [M-WORKFLOW-PROTOCOL, M-WORKFLOW-REPAIR, M-WORKFLOW-STATE, M-WORKFLOW-TRANSITIONS, M-WORKFLOW-TOOLING, M-PLUGIN-WORKFLOW, M-WORKFLOW-PERSISTENCE]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   protocol tests - Verify strict top-block parsing, header parsing, and status validation.
//   repair tests - Verify recognized OpenCode task envelopes unwrap before parsing.
//   state tests - Verify explicit intent, launch tracking, collect-all aggregation, and close gating.
//   transition tests - Verify mode-aware launch allowances and aggregate round resolution.
//   tooling tests - Verify explicit work_item_open/list/close structured responses.
//   workflow plugin tests - Verify task launch/result hooks, parallel reviewers, hard-stop timing, round limits, and primary-only guidance.
//   persistence tests - Verify explicit state hydrate/snapshot behavior and legacy rejection.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.5.0 - Reset the runtime vvoc config singleton between workflow plugin fixtures.]
//   LAST_CHANGE: [v0.4.0 - Reworked workflow tests around explicit work-item intent, awaiting_reviews, and collect-all parallel reviewer rounds.]
//   LAST_CHANGE: [v0.3.8 - Added persistence tests for hydrate/snapshot round-trip, corrupt JSON handling, session cleanup, and store hydration on creation.]
//   LAST_CHANGE: [v0.3.7 - Added coverage that workflow guidance and tracked launches accept header-first assignment prompts with lightweight XML-like tagged bodies.]
//   LAST_CHANGE: [v0.3.6 - Added coverage that duplicate strict top-block fields inside resumable task wrappers fail closed without same-session repair.]
//   LAST_CHANGE: [v0.3.5 - Added coverage for one-shot same-session repair of malformed tracked results in resumable OpenCode task envelopes.]
//   LAST_CHANGE: [v0.3.4 - Added coverage that recognized task-result wrappers with non-whitespace suffix text are not unwrapped.]
//   LAST_CHANGE: [v0.3.3 - Added coverage that loose task_id/task_result wrappers without OpenCode resume metadata are not unwrapped.]
//   LAST_CHANGE: [v0.3.2 - Added coverage that foreign `<task_result>` text without an OpenCode task envelope is not unwrapped.]
//   LAST_CHANGE: [v0.3.1 - Added regression coverage for tracked result parsing from OpenCode task output wrappers.]
//   LAST_CHANGE: [v0.3.0 - Added coverage for review-only workflows starting fresh work items with reviewer subagents.]
//   LAST_CHANGE: [v0.2.1 - Added coverage ensuring helper primary agent enhancer does not receive workflow protocol guidance injection.]
//   LAST_CHANGE: [v0.2.0 - Added WorkflowPlugin integration coverage for tracked launch/result hooks, loop-gate enforcement, protocol errors, and primary-only guidance injection.]
//   LAST_CHANGE: [v0.1.2 - Added coverage for duplicate top-block field rejection and missing transition actor rejection.]
//   LAST_CHANGE: [v0.1.1 - Added strict top-block, case-sensitive status, deterministic transition guard, sticky hard-stop, and includeClosed coverage.]
//   LAST_CHANGE: [v0.1.0 - Added shared workflow core coverage for protocol, state, transitions, and tooling modules.]
// END_CHANGE_SUMMARY

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resetVvocConfigForTests } from "../lib/config-layers.js";
import { WorkflowPlugin } from "./workflow/index.js";
import {
  deleteWorkflowSessionDir,
  getWorkflowSessionDir,
  hydrateWorkflowState,
  snapshotWorkflowState,
} from "./workflow/persistence.js";
import {
  parseResultBlock,
  parseWorkItemHeader,
  validateStatusForAgent,
  type ParsedResultBlock,
} from "./workflow/protocol.js";
import { unwrapResumableTaskResult } from "./workflow/repair.js";
import {
  applyTrackedResult,
  beginTrackedLaunch,
  closeWorkItem,
  createWorkItemStore,
  listWorkItems,
  openWorkItem,
  type ReviewerRole,
  type WorkItemMode,
} from "./workflow/state.js";
import {
  getAllowedNextAgents,
  getAttemptedImplementationRound,
  isAllowedTransition,
  resolveCompletedRoundState,
  shouldBlockRound,
} from "./workflow/transitions.js";
import {
  createWorkItemCloseTool,
  createWorkItemListTool,
  createWorkItemOpenTool,
} from "./workflow/tooling.js";

const previousConfigHome = process.env.XDG_CONFIG_HOME;
const SESSION_ID = "session-workflow-explicit";

function openItem(options: {
  mode: WorkItemMode;
  requiredReviewers?: ReviewerRole[];
  sessionId?: string;
  key?: string;
  title?: string;
}) {
  const store = createWorkItemStore();
  const opened = openWorkItem(store, {
    sessionId: options.sessionId ?? SESSION_ID,
    key: options.key ?? `${options.mode}-item`,
    title: options.title ?? `${options.mode} item`,
    mode: options.mode,
    requiredReviewers: options.requiredReviewers ?? ["spec", "code"],
  });
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw new Error(opened.message);
  return { store, opened };
}

function result(
  agent: ParsedResultBlock["agent"],
  status: ParsedResultBlock["status"],
  workItemId = "wi-1",
): ParsedResultBlock {
  return {
    agent,
    workItemId,
    status,
    ...(agent === "vv-implementer" ? { route: "change_with_review" } : {}),
  };
}

describe("workflow protocol", () => {
  test("parseResultBlock extracts implementer fields from strict top block", () => {
    const parsed = parseResultBlock({
      agent: "vv-implementer",
      output: `VVOC_WORK_ITEM_ID: wi-1
VVOC_STATUS: DONE
VVOC_ROUTE: change_with_review

Implemented all requested changes.`,
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.workItemId).toBe("wi-1");
    expect(parsed.value.status).toBe("DONE");
    expect(parsed.value.route).toBe("change_with_review");
  });

  test("validateStatusForAgent accepts configured statuses per tracked agent", () => {
    expect(validateStatusForAgent("vv-spec-reviewer", "PASS").ok).toBe(true);
    expect(validateStatusForAgent("vv-code-reviewer", "PASS").ok).toBe(true);
    expect(validateStatusForAgent("vv-implementer", "DONE").ok).toBe(true);
    expect(validateStatusForAgent("vv-implementer", "DONE_WITH_CONCERNS").ok).toBe(true);
    expect(validateStatusForAgent("vv-implementer", "NEEDS_CONTEXT").ok).toBe(true);
    expect(validateStatusForAgent("vv-implementer", "BLOCKED").ok).toBe(true);
  });

  test("strict parsing rejects malformed statuses, headers, and duplicate fields", () => {
    expect(validateStatusForAgent("vv-spec-reviewer", "pass").ok).toBe(false);
    expect(parseWorkItemHeader("VVOC_WORK_ITEM_ID: item-2\nbody").ok).toBe(false);

    const duplicate = parseResultBlock({
      agent: "vv-spec-reviewer",
      output: "VVOC_WORK_ITEM_ID: wi-1\nVVOC_STATUS: PASS\nVVOC_STATUS: FAIL\n\nreviewed",
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.error.code).toBe("DUPLICATE_TOP_BLOCK_FIELD");
    }
  });
});

describe("workflow repair", () => {
  test("unwrapResumableTaskResult extracts inner text only from recognized resumable task envelopes", () => {
    const wrapped = unwrapResumableTaskResult(
      wrapTaskResult("ses_repair", "VVOC_WORK_ITEM_ID: wi-1\nVVOC_STATUS: PASS\n\nReviewed."),
    );
    expect(wrapped.envelope?.taskId).toBe("ses_repair");
    expect(wrapped.normalizedOutput).toBe(
      "VVOC_WORK_ITEM_ID: wi-1\nVVOC_STATUS: PASS\n\nReviewed.",
    );

    const foreign = unwrapResumableTaskResult("task_id: fake\n<task_result>\nPASS\n</task_result>");
    expect(foreign.envelope).toBeUndefined();
    expect(foreign.normalizedOutput).toBe("task_id: fake\n<task_result>\nPASS\n</task_result>");
  });
});

describe("workflow state", () => {
  test("openWorkItem stores explicit implementation and review_only intent", () => {
    const implementation = openItem({ mode: "implementation", key: "impl" }).opened.record;
    expect(implementation.state).toBe("open");
    expect(implementation.mode).toBe("implementation");
    expect(implementation.requiredReviewers).toEqual(["spec", "code"]);
    expect(implementation.currentRound).toBeUndefined();

    const reviewOnly = openItem({ mode: "review_only", key: "review" }).opened.record;
    expect(reviewOnly.state).toBe("awaiting_reviews");
    expect(reviewOnly.mode).toBe("review_only");
    expect(reviewOnly.currentRound?.round).toBe(1);
    expect(reviewOnly.currentRound?.pendingReviewers).toEqual(["spec", "code"]);
  });

  test("openWorkItem reuses exact explicit intent and rejects conflicting intent", () => {
    const store = createWorkItemStore();
    const first = openWorkItem(store, {
      sessionId: SESSION_ID,
      key: "same",
      title: "Same",
      mode: "implementation",
      requiredReviewers: ["spec", "code"],
    });
    const second = openWorkItem(store, {
      sessionId: SESSION_ID,
      key: "same",
      title: "Same",
      mode: "implementation",
      requiredReviewers: ["spec", "code"],
    });
    const conflict = openWorkItem(store, {
      sessionId: SESSION_ID,
      key: "same",
      title: "Same",
      mode: "review_only",
      requiredReviewers: ["spec", "code"],
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.reused).toBe(true);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.errorCode).toBe("WORK_ITEM_KEY_CONFLICT");
  });

  test("review_only collect-all allows parallel spec and code FAIL results", () => {
    const { store } = openItem({ mode: "review_only" });

    expect(
      beginTrackedLaunch(store, {
        sessionId: SESSION_ID,
        workItemId: "wi-1",
        agent: "vv-spec-reviewer",
      }).ok,
    ).toBe(true);
    expect(
      beginTrackedLaunch(store, {
        sessionId: SESSION_ID,
        workItemId: "wi-1",
        agent: "vv-code-reviewer",
      }).ok,
    ).toBe(true);

    const specFail = applyTrackedResult(store, {
      sessionId: SESSION_ID,
      workItemId: "wi-1",
      result: result("vv-spec-reviewer", "FAIL"),
    });
    expect(specFail.ok).toBe(true);
    if (!specFail.ok) return;
    expect(specFail.record.state).toBe("awaiting_reviews");
    expect(specFail.record.currentRound?.completedReviewers).toEqual(["spec"]);
    expect(specFail.record.currentRound?.inFlightReviewers).toEqual(["code"]);

    const codeFail = applyTrackedResult(store, {
      sessionId: SESSION_ID,
      workItemId: "wi-1",
      result: result("vv-code-reviewer", "FAIL"),
    });
    expect(codeFail.ok).toBe(true);
    if (!codeFail.ok) return;
    expect(codeFail.record.state).toBe("ready_to_close");
    expect(codeFail.record.currentRound?.results.spec?.status).toBe("FAIL");
    expect(codeFail.record.currentRound?.results.code?.status).toBe("FAIL");
  });

  test("implementation collect-all returns to implementer only after full FAIL round completes", () => {
    const { store } = openItem({ mode: "implementation" });
    expect(
      beginTrackedLaunch(store, {
        sessionId: SESSION_ID,
        workItemId: "wi-1",
        agent: "vv-implementer",
      }).ok,
    ).toBe(true);
    const implemented = applyTrackedResult(store, {
      sessionId: SESSION_ID,
      workItemId: "wi-1",
      result: result("vv-implementer", "DONE"),
    });
    expect(implemented.ok).toBe(true);
    if (!implemented.ok) return;
    expect(implemented.record.state).toBe("awaiting_reviews");

    expect(
      beginTrackedLaunch(store, {
        sessionId: SESSION_ID,
        workItemId: "wi-1",
        agent: "vv-spec-reviewer",
      }).ok,
    ).toBe(true);
    expect(
      beginTrackedLaunch(store, {
        sessionId: SESSION_ID,
        workItemId: "wi-1",
        agent: "vv-code-reviewer",
      }).ok,
    ).toBe(true);
    const specFail = applyTrackedResult(store, {
      sessionId: SESSION_ID,
      workItemId: "wi-1",
      result: result("vv-spec-reviewer", "FAIL"),
    });
    expect(specFail.ok).toBe(true);
    if (!specFail.ok) return;
    expect(specFail.record.state).toBe("awaiting_reviews");

    const codePass = applyTrackedResult(store, {
      sessionId: SESSION_ID,
      workItemId: "wi-1",
      result: result("vv-code-reviewer", "PASS"),
    });
    expect(codePass.ok).toBe(true);
    if (!codePass.ok) return;
    expect(codePass.record.state).toBe("awaiting_implementer");
    expect(codePass.record.completedReviewRoundCount).toBe(1);
  });

  test("NEEDS_CONTEXT rejects new launches but waits for already in-flight reviewers", () => {
    const { store } = openItem({ mode: "review_only" });
    expect(
      beginTrackedLaunch(store, {
        sessionId: SESSION_ID,
        workItemId: "wi-1",
        agent: "vv-spec-reviewer",
      }).ok,
    ).toBe(true);
    expect(
      beginTrackedLaunch(store, {
        sessionId: SESSION_ID,
        workItemId: "wi-1",
        agent: "vv-code-reviewer",
      }).ok,
    ).toBe(true);

    const needsContext = applyTrackedResult(store, {
      sessionId: SESSION_ID,
      workItemId: "wi-1",
      result: result("vv-spec-reviewer", "NEEDS_CONTEXT"),
    });
    expect(needsContext.ok).toBe(true);
    if (!needsContext.ok) return;
    expect(needsContext.record.state).toBe("awaiting_reviews");
    expect(getAllowedNextAgents(needsContext.record)).toEqual([]);

    const codePass = applyTrackedResult(store, {
      sessionId: SESSION_ID,
      workItemId: "wi-1",
      result: result("vv-code-reviewer", "PASS"),
    });
    expect(codePass.ok).toBe(true);
    if (!codePass.ok) return;
    expect(codePass.record.state).toBe("needs_context");
  });

  test("duplicate launches, duplicate results, and results without in-flight launch are rejected", () => {
    const { store } = openItem({ mode: "review_only" });
    const firstLaunch = beginTrackedLaunch(store, {
      sessionId: SESSION_ID,
      workItemId: "wi-1",
      agent: "vv-spec-reviewer",
    });
    const duplicateLaunch = beginTrackedLaunch(store, {
      sessionId: SESSION_ID,
      workItemId: "wi-1",
      agent: "vv-spec-reviewer",
    });
    expect(firstLaunch.ok).toBe(true);
    expect(duplicateLaunch.ok).toBe(false);
    if (!duplicateLaunch.ok) expect(duplicateLaunch.errorCode).toBe("REVIEWER_ALREADY_IN_FLIGHT");

    const unlaunchedCode = applyTrackedResult(store, {
      sessionId: SESSION_ID,
      workItemId: "wi-1",
      result: result("vv-code-reviewer", "PASS"),
    });
    expect(unlaunchedCode.ok).toBe(false);
    if (!unlaunchedCode.ok) expect(unlaunchedCode.errorCode).toBe("REVIEWER_NOT_IN_FLIGHT");

    const specPass = applyTrackedResult(store, {
      sessionId: SESSION_ID,
      workItemId: "wi-1",
      result: result("vv-spec-reviewer", "PASS"),
    });
    const duplicateResult = applyTrackedResult(store, {
      sessionId: SESSION_ID,
      workItemId: "wi-1",
      result: result("vv-spec-reviewer", "PASS"),
    });
    expect(specPass.ok).toBe(true);
    expect(duplicateResult.ok).toBe(false);
    if (!duplicateResult.ok) expect(duplicateResult.errorCode).toBe("REVIEWER_ALREADY_COMPLETED");
  });

  test("closeWorkItem succeeds only from ready_to_close", () => {
    const { store } = openItem({ mode: "review_only", requiredReviewers: ["spec"] });
    const earlyClose = closeWorkItem(store, SESSION_ID, "wi-1");
    expect(earlyClose.ok).toBe(false);
    if (!earlyClose.ok) expect(earlyClose.errorCode).toBe("READY_TO_CLOSE_REQUIRED");

    expect(
      beginTrackedLaunch(store, {
        sessionId: SESSION_ID,
        workItemId: "wi-1",
        agent: "vv-spec-reviewer",
      }).ok,
    ).toBe(true);
    const applied = applyTrackedResult(store, {
      sessionId: SESSION_ID,
      workItemId: "wi-1",
      result: result("vv-spec-reviewer", "PASS"),
    });
    expect(applied.ok).toBe(true);
    const closed = closeWorkItem(store, SESSION_ID, "wi-1");
    expect(closed.ok).toBe(true);
    if (closed.ok) expect(closed.record.state).toBe("closed");
  });
});

describe("workflow transitions", () => {
  test("getAllowedNextAgents is mode-aware and round-aware", () => {
    const implementation = openItem({ mode: "implementation" }).opened.record;
    expect(getAllowedNextAgents(implementation)).toEqual(["vv-implementer"]);
    expect(isAllowedTransition(implementation, "vv-implementer")).toBe(true);
    expect(getAttemptedImplementationRound(implementation)).toBe(1);

    const reviewOnly = openItem({ mode: "review_only" }).opened.record;
    expect(getAllowedNextAgents(reviewOnly)).toEqual(["vv-spec-reviewer", "vv-code-reviewer"]);
    expect(isAllowedTransition(reviewOnly, "vv-implementer")).toBe(false);
    expect(shouldBlockRound(3)).toBe(true);
  });

  test("resolveCompletedRoundState distinguishes implementation and review_only FAIL", () => {
    const implementation = openItem({ mode: "implementation" }).opened.record;
    const reviewOnly = openItem({ mode: "review_only" }).opened.record;
    const failRound = {
      round: 1,
      requiredReviewers: ["spec"] as ReviewerRole[],
      pendingReviewers: [],
      inFlightReviewers: [],
      completedReviewers: ["spec"] as ReviewerRole[],
      results: {
        spec: {
          reviewer: "spec" as const,
          agent: "vv-spec-reviewer" as const,
          status: "FAIL" as const,
          completedAt: new Date().toISOString(),
        },
      },
      status: "completed" as const,
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };

    expect(resolveCompletedRoundState(implementation, failRound)).toBe("awaiting_implementer");
    expect(resolveCompletedRoundState(reviewOnly, failRound)).toBe("ready_to_close");
  });
});

describe("workflow tooling", () => {
  test("work_item_open requires explicit mode and requiredReviewers", () => {
    const store = createWorkItemStore();
    const openTool = createWorkItemOpenTool(store);
    const legacy = openTool.execute(
      { items: [{ key: "legacy", title: "Legacy" }] },
      { sessionId: SESSION_ID },
    ) as { items: Array<{ ok: boolean; errorCode?: string }> };
    expect(legacy.items[0]?.ok).toBe(false);
    expect(legacy.items[0]?.errorCode).toBe("INVALID_INPUT");

    const opened = openTool.execute(
      {
        items: [
          {
            key: "review",
            title: "Review",
            mode: "review_only",
            requiredReviewers: ["code", "spec"],
          },
        ],
      },
      { sessionId: SESSION_ID },
    ) as { items: Array<{ ok: boolean; state?: string; requiredReviewers?: string[] }> };
    expect(opened.items[0]?.ok).toBe(true);
    expect(opened.items[0]?.state).toBe("awaiting_reviews");
    expect(opened.items[0]?.requiredReviewers).toEqual(["spec", "code"]);
  });

  test("work_item_list exposes round metadata and work_item_close surfaces close gating", () => {
    const store = createWorkItemStore();
    const openTool = createWorkItemOpenTool(store);
    const listTool = createWorkItemListTool(store);
    const closeTool = createWorkItemCloseTool(store);
    openTool.execute(
      { items: [{ key: "r", title: "R", mode: "review_only", requiredReviewers: ["spec"] }] },
      { sessionId: SESSION_ID },
    );
    const listed = listTool.execute({ includeClosed: false }, { sessionId: SESSION_ID }) as {
      items: Array<{ currentRound?: { pendingReviewers: string[] }; mode: string }>;
    };
    expect(listed.items[0]?.mode).toBe("review_only");
    expect(listed.items[0]?.currentRound?.pendingReviewers).toEqual(["spec"]);

    const close = closeTool.execute({ workItemId: "wi-1" }, { sessionId: SESSION_ID }) as {
      ok: boolean;
      errorCode?: string;
    };
    expect(close.ok).toBe(false);
    expect(close.errorCode).toBe("READY_TO_CLOSE_REQUIRED");
  });
});

type WorkflowPluginHarness = {
  plugin: Awaited<ReturnType<typeof WorkflowPlugin>>;
  logs: string[];
};

function createWorkflowPluginHarness(): Promise<WorkflowPluginHarness> {
  const logs: string[] = [];
  return WorkflowPlugin({
    client: {
      app: {
        log: async (payload: { body?: { message?: string } }) => {
          const message = payload.body?.message;
          if (typeof message === "string") logs.push(message);
        },
      },
      session: {
        prompt: async () => ({ data: undefined, error: { message: "prompt unavailable" } }),
      },
    } as never,
    project: {} as never,
    directory: "/tmp/project",
    worktree: "/tmp/project",
    serverUrl: new URL("http://localhost"),
    $: {} as never,
  }).then((plugin) => ({ plugin, logs }));
}

describe("workflow plugin integration", () => {
  beforeEach(async () => {
    resetVvocConfigForTests();
    process.env.XDG_CONFIG_HOME = `/tmp/vvoc-workflow-empty-config-${process.pid}`;

    for (const sessionID of [
      "session-review-only-double-fail",
      "session-needs-context-inflight",
      "session-round-limit",
      "session-guidance",
      "session-tool-denied",
    ]) {
      await deleteWorkflowSessionDir(sessionID);
    }
  });

  afterEach(async () => {
    resetVvocConfigForTests();

    if (previousConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previousConfigHome;
    }

    for (const sessionID of [
      "session-review-only-double-fail",
      "session-needs-context-inflight",
      "session-round-limit",
      "session-guidance",
      "session-tool-denied",
    ]) {
      await deleteWorkflowSessionDir(sessionID);
    }
  });

  test("review_only parallel spec and code reviewers can both return FAIL", async () => {
    const { plugin } = await createWorkflowPluginHarness();
    const sessionID = "session-review-only-double-fail";
    const workItemId = await openPluginWorkItem(plugin, sessionID, "review_only", ["spec", "code"]);

    await launchPluginTask(plugin, sessionID, "spec", "vv-spec-reviewer", workItemId);
    await launchPluginTask(plugin, sessionID, "code", "vv-code-reviewer", workItemId);

    await finishPluginTask(plugin, sessionID, "spec", "vv-spec-reviewer", workItemId, "FAIL");
    let listed = await listPluginItems(plugin, sessionID);
    expect(listed.items[0]?.state).toBe("awaiting_reviews");
    expect(listed.items[0]?.currentRound?.results.spec?.status).toBe("FAIL");
    expect(listed.items[0]?.currentRound?.inFlightReviewers).toEqual(["code"]);

    await finishPluginTask(plugin, sessionID, "code", "vv-code-reviewer", workItemId, "FAIL");
    listed = await listPluginItems(plugin, sessionID);
    expect(listed.items[0]?.state).toBe("ready_to_close");
    expect(listed.items[0]?.currentRound?.results.code?.status).toBe("FAIL");
  });

  test("reviewer NEEDS_CONTEXT waits for in-flight reviewer before aggregate hard stop", async () => {
    const { plugin } = await createWorkflowPluginHarness();
    const sessionID = "session-needs-context-inflight";
    const workItemId = await openPluginWorkItem(plugin, sessionID, "review_only", ["spec", "code"]);

    await launchPluginTask(plugin, sessionID, "spec", "vv-spec-reviewer", workItemId);
    await launchPluginTask(plugin, sessionID, "code", "vv-code-reviewer", workItemId);

    await finishPluginTask(
      plugin,
      sessionID,
      "spec",
      "vv-spec-reviewer",
      workItemId,
      "NEEDS_CONTEXT",
    );
    let listed = await listPluginItems(plugin, sessionID);
    expect(listed.items[0]?.state).toBe("awaiting_reviews");

    await expect(
      finishPluginTask(plugin, sessionID, "code", "vv-code-reviewer", workItemId, "PASS"),
    ).rejects.toThrow("RESULT_HARD_STOP: needs_context");
    listed = await listPluginItems(plugin, sessionID);
    expect(listed.items[0]?.state).toBe("needs_context");
  });

  test("round limit applies to implementation retries only", async () => {
    const { plugin } = await createWorkflowPluginHarness();
    const sessionID = "session-round-limit";
    const workItemId = await openPluginWorkItem(plugin, sessionID, "implementation", ["spec"]);

    for (const round of [1, 2]) {
      await launchPluginTask(plugin, sessionID, `impl-${round}`, "vv-implementer", workItemId);
      await finishPluginTask(
        plugin,
        sessionID,
        `impl-${round}`,
        "vv-implementer",
        workItemId,
        "DONE",
      );
      await launchPluginTask(plugin, sessionID, `spec-${round}`, "vv-spec-reviewer", workItemId);
      await finishPluginTask(
        plugin,
        sessionID,
        `spec-${round}`,
        "vv-spec-reviewer",
        workItemId,
        "FAIL",
      );
    }

    await expect(
      launchPluginTask(plugin, sessionID, "impl-3", "vv-implementer", workItemId),
    ).rejects.toThrow("LAUNCH_REJECTED_ROUND_LIMIT");
  });

  test("workflow tools and guidance are restricted to vv-controller", async () => {
    const { plugin } = await createWorkflowPluginHarness();
    await expect(
      plugin.tool?.work_item_open?.execute(
        {
          items: [
            {
              key: "denied",
              title: "Denied",
              mode: "review_only",
              requiredReviewers: ["spec"],
            },
          ],
        },
        createToolContext("session-tool-denied", "build") as never,
      ),
    ).rejects.toThrow("WORKFLOW_TOOL_DENIED");

    const output = { message: { agent: "vv-controller", system: "base" } } as {
      message: { agent: string; system?: string };
    };
    await plugin["chat.message"]?.({} as never, output as never);
    expect(output.message.system).toContain("work_item_open");
    expect(output.message.system).toContain("requiredReviewers");
  });
});

describe("workflow persistence", () => {
  const PERSIST_SESSION_ID = "ses_test_explicit_workflow";
  let originalDataHome: string | undefined;
  let tmpDir: string;

  beforeEach(() => {
    originalDataHome = process.env.XDG_DATA_HOME;
    tmpDir = import.meta.dirname ?? "/tmp";
    process.env.XDG_DATA_HOME = tmpDir;
  });

  afterEach(async () => {
    await deleteWorkflowSessionDir(PERSIST_SESSION_ID);
    if (originalDataHome !== undefined) {
      process.env.XDG_DATA_HOME = originalDataHome;
    } else {
      delete process.env.XDG_DATA_HOME;
    }
  });

  test("snapshot and hydrate preserve explicit mode and round metadata", () => {
    const store = createWorkItemStore();
    const opened = openWorkItem(store, {
      sessionId: PERSIST_SESSION_ID,
      key: "review",
      title: "Review",
      mode: "review_only",
      requiredReviewers: ["spec", "code"],
    });
    expect(opened.ok).toBe(true);
    expect(
      beginTrackedLaunch(store, {
        sessionId: PERSIST_SESSION_ID,
        workItemId: "wi-1",
        agent: "vv-spec-reviewer",
      }).ok,
    ).toBe(true);

    snapshotWorkflowState(PERSIST_SESSION_ID, store.getStoreData());
    const hydrated = hydrateWorkflowState(PERSIST_SESSION_ID);
    expect(hydrated).not.toBeNull();

    const hydratedStore = createWorkItemStore(hydrated);
    const records = listWorkItems(hydratedStore, PERSIST_SESSION_ID);
    expect(records[0]?.mode).toBe("review_only");
    expect(records[0]?.currentRound?.inFlightReviewers).toEqual(["spec"]);
  });

  test("hydrate rejects legacy records that omit explicit intent", () => {
    mkdirSync(getWorkflowSessionDir(PERSIST_SESSION_ID), { recursive: true });
    writeFileSync(
      join(getWorkflowSessionDir(PERSIST_SESSION_ID), "workflow-state.json"),
      JSON.stringify(
        {
          version: 1,
          updatedAt: new Date().toISOString(),
          sessionId: PERSIST_SESSION_ID,
          nextId: 2,
          records: [
            {
              sessionId: PERSIST_SESSION_ID,
              workItemId: "wi-1",
              key: "legacy",
              title: "Legacy",
              state: "open",
              specReviewCount: 0,
              codeReviewCount: 0,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
          keyIndex: { legacy: "wi-1" },
        },
        null,
        2,
      ),
      "utf-8",
    );
    expect(hydrateWorkflowState(PERSIST_SESSION_ID)).toBeNull();
  });

  test("hydrate handles corrupt JSON and delete removes session data", async () => {
    mkdirSync(getWorkflowSessionDir(PERSIST_SESSION_ID), { recursive: true });
    writeFileSync(
      join(getWorkflowSessionDir(PERSIST_SESSION_ID), "workflow-state.json"),
      "{ not valid json }",
      "utf-8",
    );
    expect(hydrateWorkflowState(PERSIST_SESSION_ID)).toBeNull();

    snapshotWorkflowState(PERSIST_SESSION_ID, createWorkItemStore().getStoreData());
    expect(existsSync(getWorkflowSessionDir(PERSIST_SESSION_ID))).toBe(true);
    await deleteWorkflowSessionDir(PERSIST_SESSION_ID);
    expect(existsSync(getWorkflowSessionDir(PERSIST_SESSION_ID))).toBe(false);
  });
});

type ListedPluginItems = {
  items: Array<{
    state: string;
    currentRound?: {
      inFlightReviewers: string[];
      results: {
        spec?: { status: string };
        code?: { status: string };
      };
    };
  }>;
};

async function openPluginWorkItem(
  plugin: Awaited<ReturnType<typeof WorkflowPlugin>>,
  sessionID: string,
  mode: WorkItemMode,
  requiredReviewers: ReviewerRole[],
): Promise<string> {
  const openedRaw = await plugin.tool?.work_item_open?.execute(
    { items: [{ key: `${sessionID}-item`, title: "Item", mode, requiredReviewers }] },
    createToolContext(sessionID) as never,
  );
  const opened = parseToolJson<{ items: Array<{ workItemId: string }> }>(openedRaw ?? "{}");
  const workItemId = opened.items[0]?.workItemId;
  if (!workItemId) throw new Error("missing work item id");
  return workItemId;
}

async function launchPluginTask(
  plugin: Awaited<ReturnType<typeof WorkflowPlugin>>,
  sessionID: string,
  callPrefix: string,
  subagentType: "vv-implementer" | "vv-spec-reviewer" | "vv-code-reviewer",
  workItemId: string,
): Promise<void> {
  await plugin["tool.execute.before"]?.(
    { tool: "task", sessionID, callID: `${callPrefix}-before` } as never,
    {
      args: {
        subagent_type: subagentType,
        prompt: `VVOC_WORK_ITEM_ID: ${workItemId}\n<assignment>Run tracked task</assignment>`,
      },
    } as never,
  );
}

async function finishPluginTask(
  plugin: Awaited<ReturnType<typeof WorkflowPlugin>>,
  sessionID: string,
  callPrefix: string,
  subagentType: "vv-implementer" | "vv-spec-reviewer" | "vv-code-reviewer",
  workItemId: string,
  status: ParsedResultBlock["status"],
): Promise<void> {
  const route = subagentType === "vv-implementer" ? "\nVVOC_ROUTE: change_with_review" : "";
  await plugin["tool.execute.after"]?.(
    {
      tool: "task",
      sessionID,
      callID: `${callPrefix}-after`,
      args: {
        subagent_type: subagentType,
        prompt: `VVOC_WORK_ITEM_ID: ${workItemId}\n<assignment>Run tracked task</assignment>`,
      },
    } as never,
    {
      title: "task",
      output: `VVOC_WORK_ITEM_ID: ${workItemId}\nVVOC_STATUS: ${status}${route}\n\nDone.`,
      metadata: {},
    } as never,
  );
}

async function listPluginItems(
  plugin: Awaited<ReturnType<typeof WorkflowPlugin>>,
  sessionID: string,
): Promise<ListedPluginItems> {
  const listedRaw = await plugin.tool?.work_item_list?.execute(
    { includeClosed: false },
    createToolContext(sessionID) as never,
  );
  return parseToolJson<ListedPluginItems>(listedRaw ?? "{}");
}

function createToolContext(sessionID: string, agent = "vv-controller") {
  return {
    sessionID,
    messageID: "message-1",
    agent,
    directory: "/tmp/project",
    worktree: "/tmp/project",
    abort: new AbortController().signal,
    metadata: () => undefined,
    ask: async () => undefined,
  };
}

function parseToolJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function wrapTaskResult(taskId: string, innerResult: string): string {
  return [
    `task_id: ${taskId} (for resuming to continue this task if needed)`,
    "",
    "<task_result>",
    innerResult,
    "</task_result>",
  ].join("\n");
}
