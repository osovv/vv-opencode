// FILE: src/plugins/workflow.test.ts
// VERSION: 0.3.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify workflow core modules and WorkflowPlugin integration behavior.
//   SCOPE: Protocol success/failure parsing scenarios, session-scoped work-item store behavior, deterministic transition policy, work_item_open/list/close wrappers, tracked launch/result hook behavior, and primary-only workflow guidance injection.
//   DEPENDS: [bun:test, src/plugins/workflow/protocol.ts, src/plugins/workflow/state.ts, src/plugins/workflow/transitions.ts, src/plugins/workflow/tooling.ts, src/plugins/workflow/index.ts]
//   LINKS: [V-M-WORKFLOW-PROTOCOL, V-M-WORKFLOW-STATE, V-M-WORKFLOW-TRANSITIONS, V-M-WORKFLOW-TOOLING, V-M-PLUGIN-WORKFLOW]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   protocol tests - Verify strict top-block parsing, header parsing, and status validation.
//   state tests - Verify session-scoped idempotent open, conflict handling, close behavior, and review-round computation.
//   transition tests - Verify deterministic next-state rules, launch allowances, and round-limit checks.
//   tooling tests - Verify structured responses from work_item_open, work_item_list, and work_item_close wrappers.
//   workflow plugin tests - Verify task launch validation, result parsing/transitions, hard-stop and loop-gate behavior, and primary-only guidance injection.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.3.0 - Added coverage for review-only workflows starting fresh work items with reviewer subagents.]
//   LAST_CHANGE: [v0.2.1 - Added coverage ensuring helper primary agent enhancer does not receive workflow protocol guidance injection.]
//   LAST_CHANGE: [v0.2.0 - Added WorkflowPlugin integration coverage for tracked launch/result hooks, loop-gate enforcement, protocol errors, and primary-only guidance injection.]
//   LAST_CHANGE: [v0.1.2 - Added coverage for duplicate top-block field rejection and missing transition actor rejection.]
//   LAST_CHANGE: [v0.1.1 - Added strict top-block, case-sensitive status, deterministic transition guard, sticky hard-stop, and includeClosed coverage.]
//   LAST_CHANGE: [v0.1.0 - Added shared workflow core coverage for protocol, state, transitions, and tooling modules.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import {
  parseResultBlock,
  parseWorkItemHeader,
  validateStatusForAgent,
} from "./workflow/protocol.js";
import {
  closeWorkItem,
  createWorkItemStore,
  getReviewRound,
  listWorkItems,
  openWorkItem,
  transitionWorkItemState,
} from "./workflow/state.js";
import {
  MAX_REVIEW_ROUNDS,
  getAllowedNextAgent,
  getNextState,
  isAllowedTransition,
  shouldBlockRound,
} from "./workflow/transitions.js";
import {
  createWorkItemCloseTool,
  createWorkItemListTool,
  createWorkItemOpenTool,
} from "./workflow/tooling.js";
import { WorkflowPlugin } from "./workflow/index.js";

describe("workflow protocol", () => {
  test("parseResultBlock extracts implementer fields from strict top block", () => {
    const parsed = parseResultBlock({
      agent: "vv-implementer",
      output: `VVOC_WORK_ITEM_ID: wi-1\nVVOC_STATUS: DONE\nVVOC_ROUTE: change_with_review\n\nImplemented all requested changes.`,
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

  test("validateStatusForAgent rejects lowercase or mixed-case status values", () => {
    const lowercase = validateStatusForAgent("vv-spec-reviewer", "pass");
    expect(lowercase.ok).toBe(false);
    if (!lowercase.ok) {
      expect(lowercase.error.code).toBe("UNKNOWN_STATUS");
    }

    const mixedCase = validateStatusForAgent("vv-implementer", "Done");
    expect(mixedCase.ok).toBe(false);
    if (!mixedCase.ok) {
      expect(mixedCase.error.code).toBe("UNKNOWN_STATUS");
    }
  });

  test("parseWorkItemHeader extracts work-item id from the first meaningful line", () => {
    const parsed = parseWorkItemHeader("\n  VVOC_WORK_ITEM_ID: wi-2\nPlease proceed.");

    expect(parsed).toEqual({
      ok: true,
      value: "wi-2",
    });
  });

  test("parseWorkItemHeader rejects malformed header lines", () => {
    const parsed = parseWorkItemHeader("VVOC_WORK_ITEM_ID: item-2\nbody");

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe("MALFORMED_WORK_ITEM_HEADER");
  });

  test("parseResultBlock returns protocol errors for missing fields, unknown statuses, and mismatches", () => {
    const missingId = parseResultBlock({
      agent: "vv-spec-reviewer",
      output: "VVOC_STATUS: PASS\n\nDone.",
    });
    expect(missingId.ok).toBe(false);
    if (!missingId.ok) {
      expect(missingId.error.code).toBe("MISSING_WORK_ITEM_ID");
    }

    const missingStatus = parseResultBlock({
      agent: "vv-spec-reviewer",
      output: "VVOC_WORK_ITEM_ID: wi-1\n\nPASS in prose only",
    });
    expect(missingStatus.ok).toBe(false);
    if (!missingStatus.ok) {
      expect(missingStatus.error.code).toBe("MISSING_STATUS");
    }

    const unknownStatus = parseResultBlock({
      agent: "vv-spec-reviewer",
      output: "VVOC_WORK_ITEM_ID: wi-1\nVVOC_STATUS: MAYBE\n\nreviewed",
    });
    expect(unknownStatus.ok).toBe(false);
    if (!unknownStatus.ok) {
      expect(unknownStatus.error.code).toBe("UNKNOWN_STATUS");
    }

    const mismatch = parseResultBlock({
      agent: "vv-spec-reviewer",
      output: "VVOC_WORK_ITEM_ID: wi-2\nVVOC_STATUS: PASS\n\nreviewed",
      expectedWorkItemId: "wi-1",
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.error.code).toBe("WORK_ITEM_MISMATCH");
    }
  });

  test("parseResultBlock does not guess status from prose outside strict top block", () => {
    const parsed = parseResultBlock({
      agent: "vv-spec-reviewer",
      output: "VVOC_WORK_ITEM_ID: wi-1\n\nI think status is PASS.",
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe("MISSING_STATUS");
    }
  });

  test("parseResultBlock rejects extra non-protocol lines inside strict top block", () => {
    const parsed = parseResultBlock({
      agent: "vv-spec-reviewer",
      output: "VVOC_WORK_ITEM_ID: wi-1\nnote: not a protocol field\nVVOC_STATUS: PASS\n\nreviewed",
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe("UNEXPECTED_TOP_BLOCK_LINE");
    }
  });

  test("parseResultBlock rejects duplicate protocol fields in strict top block", () => {
    const parsed = parseResultBlock({
      agent: "vv-spec-reviewer",
      output: "VVOC_WORK_ITEM_ID: wi-1\nVVOC_STATUS: PASS\nVVOC_STATUS: FAIL\n\nreviewed",
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe("DUPLICATE_TOP_BLOCK_FIELD");
    }
  });
});

describe("workflow state", () => {
  test("openWorkItem creates wi-1 header and supports idempotent open plus conflict handling", () => {
    const store = createWorkItemStore();

    const first = openWorkItem(store, {
      sessionId: "session-a",
      key: "WI-WAVE1-WORKFLOW-CORE",
      title: "Workflow core",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.record.workItemId).toBe("wi-1");
    expect(first.header).toBe("VVOC_WORK_ITEM_ID: wi-1");
    expect(first.reused).toBe(false);

    const second = openWorkItem(store, {
      sessionId: "session-a",
      key: "WI-WAVE1-WORKFLOW-CORE",
      title: "Workflow core",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.reused).toBe(true);
    expect(second.record.workItemId).toBe("wi-1");

    const conflict = openWorkItem(store, {
      sessionId: "session-a",
      key: "WI-WAVE1-WORKFLOW-CORE",
      title: "Different title",
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.errorCode).toBe("WORK_ITEM_KEY_CONFLICT");
    }
  });

  test("state is scoped per session", () => {
    const store = createWorkItemStore();
    const openedA = openWorkItem(store, {
      sessionId: "session-a",
      key: "work-key",
      title: "Same title",
    });
    const openedB = openWorkItem(store, {
      sessionId: "session-b",
      key: "work-key",
      title: "Same title",
    });

    expect(openedA.ok).toBe(true);
    expect(openedB.ok).toBe(true);
    if (openedA.ok && openedB.ok) {
      expect(openedA.record.workItemId).toBe("wi-1");
      expect(openedB.record.workItemId).toBe("wi-2");
    }
    expect(listWorkItems(store, "session-a")).toHaveLength(1);
    expect(listWorkItems(store, "session-b")).toHaveLength(1);
  });

  test("listWorkItems returns current open item states and counters", () => {
    const store = createWorkItemStore();
    const opened = openWorkItem(store, {
      sessionId: "session-a",
      key: "workflow-core",
      title: "Workflow core",
    });
    if (!opened.ok) return;

    transitionWorkItemState(store, {
      sessionId: "session-a",
      workItemId: opened.record.workItemId,
      state: "awaiting_spec_review",
      actor: "vv-implementer",
    });

    transitionWorkItemState(store, {
      sessionId: "session-a",
      workItemId: opened.record.workItemId,
      state: "awaiting_code_review",
      actor: "vv-spec-reviewer",
    });

    const items = listWorkItems(store, "session-a");
    expect(items).toHaveLength(1);
    expect(items[0]?.state).toBe("awaiting_code_review");
    expect(items[0]?.specReviewCount).toBe(1);
    expect(items[0]?.codeReviewCount).toBe(0);
  });

  test("transitionWorkItemState rejects invalid transitions without mutating state", () => {
    const store = createWorkItemStore();
    const opened = openWorkItem(store, {
      sessionId: "session-a",
      key: "workflow-core",
      title: "Workflow core",
    });
    if (!opened.ok) return;

    const attempted = transitionWorkItemState(store, {
      sessionId: "session-a",
      workItemId: opened.record.workItemId,
      state: "ready_to_close",
      actor: "vv-spec-reviewer",
    });

    expect(attempted.ok).toBe(false);
    if (!attempted.ok) {
      expect(attempted.errorCode).toBe("INVALID_STATE_TRANSITION");
    }

    const current = listWorkItems(store, "session-a")[0];
    expect(current?.state).toBe("open");
    expect(current?.specReviewCount).toBe(0);
    expect(current?.codeReviewCount).toBe(0);
  });

  test("hard-stop states remain sticky under transition attempts", () => {
    const store = createWorkItemStore();
    const opened = openWorkItem(store, {
      sessionId: "session-a",
      key: "workflow-core",
      title: "Workflow core",
    });
    if (!opened.ok) return;

    const toNeedsContext = transitionWorkItemState(store, {
      sessionId: "session-a",
      workItemId: opened.record.workItemId,
      state: "needs_context",
      actor: "vv-implementer",
    });
    expect(toNeedsContext.ok).toBe(true);

    const escapeAttempt = transitionWorkItemState(store, {
      sessionId: "session-a",
      workItemId: opened.record.workItemId,
      state: "awaiting_implementer",
    });
    expect(escapeAttempt.ok).toBe(false);
    if (!escapeAttempt.ok) {
      expect(escapeAttempt.errorCode).toBe("INVALID_STATE_TRANSITION");
    }

    const current = listWorkItems(store, "session-a")[0];
    expect(current?.state).toBe("needs_context");
  });

  test("transitionWorkItemState rejects missing actor metadata for tracked transitions", () => {
    const store = createWorkItemStore();
    const opened = openWorkItem(store, {
      sessionId: "session-a",
      key: "workflow-core",
      title: "Workflow core",
    });
    if (!opened.ok) return;

    const attempted = transitionWorkItemState(store, {
      sessionId: "session-a",
      workItemId: opened.record.workItemId,
      state: "awaiting_spec_review",
    });

    expect(attempted.ok).toBe(false);
    if (!attempted.ok) {
      expect(attempted.errorCode).toBe("MISSING_TRANSITION_ACTOR");
    }

    const current = listWorkItems(store, "session-a")[0];
    expect(current?.state).toBe("open");
  });

  test("closeWorkItem closes an open item and rejects missing/already-closed items", () => {
    const store = createWorkItemStore();
    const opened = openWorkItem(store, {
      sessionId: "session-a",
      key: "workflow-core",
      title: "Workflow core",
    });
    if (!opened.ok) return;

    const closed = closeWorkItem(store, "session-a", opened.record.workItemId);
    expect(closed.ok).toBe(true);
    if (closed.ok) {
      expect(closed.record.state).toBe("closed");
      expect(typeof closed.record.closedAt).toBe("string");
    }

    const notFound = closeWorkItem(store, "session-a", "wi-999");
    expect(notFound.ok).toBe(false);
    if (!notFound.ok) {
      expect(notFound.errorCode).toBe("WORK_ITEM_NOT_FOUND");
    }

    const alreadyClosed = closeWorkItem(store, "session-a", opened.record.workItemId);
    expect(alreadyClosed.ok).toBe(false);
    if (!alreadyClosed.ok) {
      expect(alreadyClosed.errorCode).toBe("WORK_ITEM_ALREADY_CLOSED");
    }
  });

  test("getReviewRound returns max(specReviewCount, codeReviewCount)", () => {
    expect(getReviewRound({ specReviewCount: 1, codeReviewCount: 0 })).toBe(1);
    expect(getReviewRound({ specReviewCount: 1, codeReviewCount: 2 })).toBe(2);
  });

  test("fresh work items can transition from review-only reviewer outcomes", () => {
    const store = createWorkItemStore();
    const opened = openWorkItem(store, {
      sessionId: "session-review-only",
      key: "review-only",
      title: "Review only",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const transitioned = transitionWorkItemState(store, {
      sessionId: "session-review-only",
      workItemId: opened.record.workItemId,
      state: "ready_to_close",
      actor: "vv-code-reviewer",
    });

    expect(transitioned.ok).toBe(true);
    if (!transitioned.ok) return;
    expect(transitioned.record.state).toBe("ready_to_close");
    expect(transitioned.record.codeReviewCount).toBe(1);
  });
});

describe("workflow transitions", () => {
  test("open and awaiting_implementer allow vv-implementer", () => {
    expect(getAllowedNextAgent("open")).toBe("vv-implementer");
    expect(getAllowedNextAgent("awaiting_implementer")).toBe("vv-implementer");
    expect(isAllowedTransition("open", "vv-implementer")).toBe(true);
    expect(isAllowedTransition("open", "vv-spec-reviewer")).toBe(true);
    expect(isAllowedTransition("open", "vv-code-reviewer")).toBe(true);
  });

  test("implements deterministic next-state mappings", () => {
    expect(
      getNextState("open", {
        agent: "vv-implementer",
        workItemId: "wi-1",
        status: "DONE",
        route: "change_with_review",
      }),
    ).toBe("awaiting_spec_review");

    expect(
      getNextState("open", {
        agent: "vv-implementer",
        workItemId: "wi-1",
        status: "DONE_WITH_CONCERNS",
        route: "change_with_review",
      }),
    ).toBe("awaiting_spec_review");

    expect(
      getNextState("awaiting_spec_review", {
        agent: "vv-spec-reviewer",
        workItemId: "wi-1",
        status: "PASS",
      }),
    ).toBe("awaiting_code_review");

    expect(
      getNextState("awaiting_code_review", {
        agent: "vv-code-reviewer",
        workItemId: "wi-1",
        status: "PASS",
      }),
    ).toBe("ready_to_close");

    expect(
      getNextState("awaiting_spec_review", {
        agent: "vv-spec-reviewer",
        workItemId: "wi-1",
        status: "FAIL",
      }),
    ).toBe("awaiting_implementer");

    expect(
      getNextState("open", {
        agent: "vv-code-reviewer",
        workItemId: "wi-1",
        status: "PASS",
      }),
    ).toBe("ready_to_close");

    expect(
      getNextState("open", {
        agent: "vv-spec-reviewer",
        workItemId: "wi-1",
        status: "PASS",
      }),
    ).toBe("awaiting_code_review");

    expect(
      getNextState("awaiting_code_review", {
        agent: "vv-code-reviewer",
        workItemId: "wi-1",
        status: "FAIL",
      }),
    ).toBe("awaiting_implementer");

    expect(
      getNextState("open", {
        agent: "vv-implementer",
        workItemId: "wi-1",
        status: "NEEDS_CONTEXT",
        route: "change_with_review",
      }),
    ).toBe("needs_context");

    expect(
      getNextState("open", {
        agent: "vv-implementer",
        workItemId: "wi-1",
        status: "BLOCKED",
        route: "change_with_review",
      }),
    ).toBe("blocked");
  });

  test("shouldBlockRound enforces review loop gate before round 3", () => {
    expect(MAX_REVIEW_ROUNDS).toBe(2);
    expect(shouldBlockRound(1)).toBe(false);
    expect(shouldBlockRound(2)).toBe(false);
    expect(shouldBlockRound(3)).toBe(true);
  });
});

describe("workflow tooling", () => {
  test("work_item_open supports batch open and returns VVOC_WORK_ITEM_ID headers", () => {
    const store = createWorkItemStore();
    const tool = createWorkItemOpenTool(store);
    const result = tool.execute(
      {
        items: [
          { key: "work-1", title: "Title 1" },
          { key: "work-2", title: "Title 2" },
        ],
      },
      { sessionId: "session-a" },
    ) as {
      items: Array<{ ok: boolean; workItemId?: string; header?: string }>;
    };

    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.ok).toBe(true);
    expect(result.items[0]?.workItemId).toBe("wi-1");
    expect(result.items[0]?.header).toBe("VVOC_WORK_ITEM_ID: wi-1");
    expect(result.items[1]?.workItemId).toBe("wi-2");
  });

  test("work_item_list returns open items with state counters and review round", () => {
    const store = createWorkItemStore();
    const openTool = createWorkItemOpenTool(store);
    openTool.execute({ items: [{ key: "work-1", title: "Title 1" }] }, { sessionId: "session-a" });

    transitionWorkItemState(store, {
      sessionId: "session-a",
      workItemId: "wi-1",
      state: "awaiting_spec_review",
      actor: "vv-implementer",
    });

    transitionWorkItemState(store, {
      sessionId: "session-a",
      workItemId: "wi-1",
      state: "awaiting_code_review",
      actor: "vv-spec-reviewer",
    });

    const listTool = createWorkItemListTool(store);
    const listed = listTool.execute({ includeClosed: false }, { sessionId: "session-a" }) as {
      items: Array<{
        workItemId: string;
        state: string;
        reviewRound: number;
        specReviewCount: number;
      }>;
    };

    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.workItemId).toBe("wi-1");
    expect(listed.items[0]?.state).toBe("awaiting_code_review");
    expect(listed.items[0]?.specReviewCount).toBe(1);
    expect(listed.items[0]?.reviewRound).toBe(1);
  });

  test("work_item_list respects includeClosed flag", () => {
    const store = createWorkItemStore();
    const openTool = createWorkItemOpenTool(store);
    openTool.execute({ items: [{ key: "work-1", title: "Title 1" }] }, { sessionId: "session-a" });

    const closeTool = createWorkItemCloseTool(store);
    closeTool.execute({ workItemId: "wi-1" }, { sessionId: "session-a" });

    const listTool = createWorkItemListTool(store);
    const withoutClosed = listTool.execute(
      { includeClosed: false },
      { sessionId: "session-a" },
    ) as { items: Array<{ workItemId: string }> };
    expect(withoutClosed.items).toHaveLength(0);

    const withClosed = listTool.execute({ includeClosed: true }, { sessionId: "session-a" }) as {
      items: Array<{ workItemId: string; state: string }>;
    };
    expect(withClosed.items).toHaveLength(1);
    expect(withClosed.items[0]?.workItemId).toBe("wi-1");
    expect(withClosed.items[0]?.state).toBe("closed");
  });

  test("work_item_close closes the specified work item and confirms", () => {
    const store = createWorkItemStore();
    const openTool = createWorkItemOpenTool(store);
    openTool.execute({ items: [{ key: "work-1", title: "Title 1" }] }, { sessionId: "session-a" });

    const closeTool = createWorkItemCloseTool(store);
    const closed = closeTool.execute({ workItemId: "wi-1" }, { sessionId: "session-a" }) as {
      ok: boolean;
      state?: string;
      header?: string;
    };

    expect(closed.ok).toBe(true);
    expect(closed.state).toBe("closed");
    expect(closed.header).toBe("VVOC_WORK_ITEM_ID: wi-1");
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
          if (typeof message === "string") {
            logs.push(message);
          }
        },
      },
    } as never,
    project: {} as never,
    directory: "/tmp/project",
    worktree: "/tmp/project",
    serverUrl: new URL("http://localhost"),
    $: {} as never,
  }).then((plugin) => ({ plugin, logs }));
}

function createToolContext(sessionID: string, agent = "build") {
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

describe("workflow plugin integration", () => {
  test("untracked task launches pass through before/after hooks", async () => {
    const { plugin } = await createWorkflowPluginHarness();

    await expect(
      plugin["tool.execute.before"]?.(
        {
          tool: "task",
          sessionID: "session-untracked",
          callID: "call-untracked",
        } as never,
        {
          args: {
            subagent_type: "investigator",
            prompt: "no workflow header required for untracked agent",
          },
        } as never,
      ),
    ).resolves.toBeUndefined();

    await expect(
      plugin["tool.execute.after"]?.(
        {
          tool: "task",
          sessionID: "session-untracked",
          callID: "call-untracked",
          args: {
            subagent_type: "investigator",
            prompt: "no workflow header required for untracked agent",
          },
        } as never,
        {
          title: "task",
          output: "plain free-form output",
          metadata: {},
        } as never,
      ),
    ).resolves.toBeUndefined();
  });

  test("tracked launch rejects missing headers", async () => {
    const { plugin } = await createWorkflowPluginHarness();

    await expect(
      plugin["tool.execute.before"]?.(
        {
          tool: "task",
          sessionID: "session-missing-header",
          callID: "call-missing-header",
        } as never,
        {
          args: {
            subagent_type: "vv-implementer",
            prompt: "Implement task without workflow header",
          },
        } as never,
      ),
    ).rejects.toThrow("LAUNCH_REJECTED_MISSING_HEADER");
  });

  test("tracked launch rejects unknown work item and wrong next agent", async () => {
    const { plugin } = await createWorkflowPluginHarness();

    await expect(
      plugin["tool.execute.before"]?.(
        {
          tool: "task",
          sessionID: "session-invalid-launch",
          callID: "call-unknown-work-item",
        } as never,
        {
          args: {
            subagent_type: "vv-implementer",
            prompt: "VVOC_WORK_ITEM_ID: wi-999\nImplement this",
          },
        } as never,
      ),
    ).rejects.toThrow("LAUNCH_REJECTED_UNKNOWN_WORK_ITEM");

    const openOutput = await plugin.tool?.work_item_open?.execute(
      {
        items: [{ key: "WI-INVALID-NEXT-AGENT", title: "Invalid next agent" }],
      },
      createToolContext("session-invalid-launch") as never,
    );
    const opened = parseToolJson<{ items: Array<{ workItemId?: string; ok: boolean }> }>(
      openOutput ?? "{}",
    );
    const workItemId = opened.items[0]?.workItemId;
    expect(workItemId).toBe("wi-1");

    await plugin["tool.execute.before"]?.(
      {
        tool: "task",
        sessionID: "session-invalid-launch",
        callID: "call-impl-before-wrong-agent",
      } as never,
      {
        args: {
          subagent_type: "vv-implementer",
          prompt: `VVOC_WORK_ITEM_ID: ${workItemId}\nImplement first`,
        },
      } as never,
    );
    await plugin["tool.execute.after"]?.(
      {
        tool: "task",
        sessionID: "session-invalid-launch",
        callID: "call-impl-before-wrong-agent",
        args: {
          subagent_type: "vv-implementer",
          prompt: `VVOC_WORK_ITEM_ID: ${workItemId}\nImplement first`,
        },
      } as never,
      {
        title: "task",
        output: `VVOC_WORK_ITEM_ID: ${workItemId}\nVVOC_STATUS: DONE\nVVOC_ROUTE: change_with_review\n\nDone.`,
        metadata: {},
      } as never,
    );

    await expect(
      plugin["tool.execute.before"]?.(
        {
          tool: "task",
          sessionID: "session-invalid-launch",
          callID: "call-wrong-agent",
        } as never,
        {
          args: {
            subagent_type: "vv-code-reviewer",
            prompt: `VVOC_WORK_ITEM_ID: ${workItemId}\nReview code too early`,
          },
        } as never,
      ),
    ).rejects.toThrow("LAUNCH_REJECTED_INVALID_TRANSITION");
  });

  test("happy path transitions to ready_to_close", async () => {
    const { plugin, logs } = await createWorkflowPluginHarness();
    const sessionID = "session-happy";

    const openedRaw = await plugin.tool?.work_item_open?.execute(
      {
        items: [{ key: "WI-HAPPY", title: "Happy path" }],
      },
      createToolContext(sessionID) as never,
    );
    const opened = parseToolJson<{ items: Array<{ workItemId: string }> }>(openedRaw ?? "{}");
    const workItemId = opened.items[0]?.workItemId;

    await plugin["tool.execute.before"]?.(
      {
        tool: "task",
        sessionID,
        callID: "call-impl",
      } as never,
      {
        args: {
          subagent_type: "vv-implementer",
          prompt: `VVOC_WORK_ITEM_ID: ${workItemId}\nImplement`,
        },
      } as never,
    );
    await plugin["tool.execute.after"]?.(
      {
        tool: "task",
        sessionID,
        callID: "call-impl",
        args: {
          subagent_type: "vv-implementer",
          prompt: `VVOC_WORK_ITEM_ID: ${workItemId}\nImplement`,
        },
      } as never,
      {
        title: "task",
        output: `VVOC_WORK_ITEM_ID: ${workItemId}\nVVOC_STATUS: DONE\nVVOC_ROUTE: change_with_review\n\nDone.`,
        metadata: {},
      } as never,
    );

    await plugin["tool.execute.before"]?.(
      {
        tool: "task",
        sessionID,
        callID: "call-spec",
      } as never,
      {
        args: {
          subagent_type: "vv-spec-reviewer",
          prompt: `VVOC_WORK_ITEM_ID: ${workItemId}\nReview spec`,
        },
      } as never,
    );
    await plugin["tool.execute.after"]?.(
      {
        tool: "task",
        sessionID,
        callID: "call-spec",
        args: {
          subagent_type: "vv-spec-reviewer",
          prompt: `VVOC_WORK_ITEM_ID: ${workItemId}\nReview spec`,
        },
      } as never,
      {
        title: "task",
        output: `VVOC_WORK_ITEM_ID: ${workItemId}\nVVOC_STATUS: PASS\n\nSpec pass.`,
        metadata: {},
      } as never,
    );

    await plugin["tool.execute.before"]?.(
      {
        tool: "task",
        sessionID,
        callID: "call-code",
      } as never,
      {
        args: {
          subagent_type: "vv-code-reviewer",
          prompt: `VVOC_WORK_ITEM_ID: ${workItemId}\nReview code`,
        },
      } as never,
    );
    await plugin["tool.execute.after"]?.(
      {
        tool: "task",
        sessionID,
        callID: "call-code",
        args: {
          subagent_type: "vv-code-reviewer",
          prompt: `VVOC_WORK_ITEM_ID: ${workItemId}\nReview code`,
        },
      } as never,
      {
        title: "task",
        output: `VVOC_WORK_ITEM_ID: ${workItemId}\nVVOC_STATUS: PASS\n\nCode pass.`,
        metadata: {},
      } as never,
    );

    const listedRaw = await plugin.tool?.work_item_list?.execute(
      { includeClosed: false },
      createToolContext(sessionID) as never,
    );
    const listed = parseToolJson<{
      items: Array<{ workItemId: string; state: string; reviewRound: number }>;
    }>(listedRaw ?? "{}");
    expect(listed.items[0]?.workItemId).toBe(workItemId);
    expect(listed.items[0]?.state).toBe("ready_to_close");
    expect(listed.items[0]?.reviewRound).toBe(1);

    expect(logs).toContain("[workflow][launchValidation][BLOCK_VALIDATE_LAUNCH] launch validated");
    expect(logs).toContain("[workflow][resultParsing][BLOCK_PARSE_RESULT] result parsed");
    expect(logs).toContain(
      "[workflow][stateTransition][BLOCK_TRANSITION_STATE] state transitioned",
    );
    expect(logs).toContain("[workflow][loopGate][BLOCK_CHECK_ROUND_LIMIT] round limit check");
  });

  test("review FAIL routes back to awaiting_implementer", async () => {
    const { plugin } = await createWorkflowPluginHarness();
    const sessionID = "session-fail-route";

    const openedRaw = await plugin.tool?.work_item_open?.execute(
      { items: [{ key: "WI-FAIL-PATH", title: "Fail path" }] },
      createToolContext(sessionID) as never,
    );
    const opened = parseToolJson<{ items: Array<{ workItemId: string }> }>(openedRaw ?? "{}");
    const workItemId = opened.items[0]?.workItemId;

    await plugin["tool.execute.before"]?.(
      { tool: "task", sessionID, callID: "call-fail-impl" } as never,
      {
        args: {
          subagent_type: "vv-implementer",
          prompt: `VVOC_WORK_ITEM_ID: ${workItemId}\nImplement`,
        },
      } as never,
    );
    await plugin["tool.execute.after"]?.(
      {
        tool: "task",
        sessionID,
        callID: "call-fail-impl",
        args: {
          subagent_type: "vv-implementer",
          prompt: `VVOC_WORK_ITEM_ID: ${workItemId}\nImplement`,
        },
      } as never,
      {
        title: "task",
        output: `VVOC_WORK_ITEM_ID: ${workItemId}\nVVOC_STATUS: DONE\nVVOC_ROUTE: change_with_review\n\nDone.`,
        metadata: {},
      } as never,
    );

    await plugin["tool.execute.before"]?.(
      { tool: "task", sessionID, callID: "call-fail-spec" } as never,
      {
        args: {
          subagent_type: "vv-spec-reviewer",
          prompt: `VVOC_WORK_ITEM_ID: ${workItemId}\nSpec review`,
        },
      } as never,
    );
    await plugin["tool.execute.after"]?.(
      {
        tool: "task",
        sessionID,
        callID: "call-fail-spec",
        args: {
          subagent_type: "vv-spec-reviewer",
          prompt: `VVOC_WORK_ITEM_ID: ${workItemId}\nSpec review`,
        },
      } as never,
      {
        title: "task",
        output: `VVOC_WORK_ITEM_ID: ${workItemId}\nVVOC_STATUS: FAIL\n\nNeeds fixes.`,
        metadata: {},
      } as never,
    );

    const listedRaw = await plugin.tool?.work_item_list?.execute(
      { includeClosed: false },
      createToolContext(sessionID) as never,
    );
    const listed = parseToolJson<{ items: Array<{ state: string; reviewRound: number }> }>(
      listedRaw ?? "{}",
    );
    expect(listed.items[0]?.state).toBe("awaiting_implementer");
    expect(listed.items[0]?.reviewRound).toBe(1);
  });

  test("NEEDS_CONTEXT result hard-stops after transition", async () => {
    const { plugin } = await createWorkflowPluginHarness();
    const sessionID = "session-hard-stop";

    const openedRaw = await plugin.tool?.work_item_open?.execute(
      { items: [{ key: "WI-HARD-STOP", title: "Hard stop" }] },
      createToolContext(sessionID) as never,
    );
    const opened = parseToolJson<{ items: Array<{ workItemId: string }> }>(openedRaw ?? "{}");
    const workItemId = opened.items[0]?.workItemId;

    await plugin["tool.execute.before"]?.(
      { tool: "task", sessionID, callID: "call-hard-stop-impl" } as never,
      {
        args: {
          subagent_type: "vv-implementer",
          prompt: `VVOC_WORK_ITEM_ID: ${workItemId}\nImplement`,
        },
      } as never,
    );

    await expect(
      plugin["tool.execute.after"]?.(
        {
          tool: "task",
          sessionID,
          callID: "call-hard-stop-impl",
          args: {
            subagent_type: "vv-implementer",
            prompt: `VVOC_WORK_ITEM_ID: ${workItemId}\nImplement`,
          },
        } as never,
        {
          title: "task",
          output: `VVOC_WORK_ITEM_ID: ${workItemId}\nVVOC_STATUS: NEEDS_CONTEXT\nVVOC_ROUTE: change_with_review\n\nNeed context.`,
          metadata: {},
        } as never,
      ),
    ).rejects.toThrow("RESULT_HARD_STOP");

    const listedRaw = await plugin.tool?.work_item_list?.execute(
      { includeClosed: false },
      createToolContext(sessionID) as never,
    );
    const listed = parseToolJson<{ items: Array<{ state: string }> }>(listedRaw ?? "{}");
    expect(listed.items[0]?.state).toBe("needs_context");
  });

  test("loop gate blocks before entering round 3", async () => {
    const { plugin } = await createWorkflowPluginHarness();
    const sessionID = "session-loop-gate";

    const openedRaw = await plugin.tool?.work_item_open?.execute(
      { items: [{ key: "WI-ROUND-LIMIT", title: "Round limit" }] },
      createToolContext(sessionID) as never,
    );
    const opened = parseToolJson<{ items: Array<{ workItemId: string }> }>(openedRaw ?? "{}");
    const workItemId = opened.items[0]?.workItemId;

    const runPass = async (prefix: string) => {
      await plugin["tool.execute.before"]?.(
        { tool: "task", sessionID, callID: `${prefix}-impl` } as never,
        {
          args: {
            subagent_type: "vv-implementer",
            prompt: `VVOC_WORK_ITEM_ID: ${workItemId}\nImplement`,
          },
        } as never,
      );
      await plugin["tool.execute.after"]?.(
        {
          tool: "task",
          sessionID,
          callID: `${prefix}-impl`,
          args: {
            subagent_type: "vv-implementer",
            prompt: `VVOC_WORK_ITEM_ID: ${workItemId}\nImplement`,
          },
        } as never,
        {
          title: "task",
          output: `VVOC_WORK_ITEM_ID: ${workItemId}\nVVOC_STATUS: DONE\nVVOC_ROUTE: change_with_review\n\nDone.`,
          metadata: {},
        } as never,
      );

      await plugin["tool.execute.before"]?.(
        { tool: "task", sessionID, callID: `${prefix}-spec` } as never,
        {
          args: {
            subagent_type: "vv-spec-reviewer",
            prompt: `VVOC_WORK_ITEM_ID: ${workItemId}\nSpec review`,
          },
        } as never,
      );
      await plugin["tool.execute.after"]?.(
        {
          tool: "task",
          sessionID,
          callID: `${prefix}-spec`,
          args: {
            subagent_type: "vv-spec-reviewer",
            prompt: `VVOC_WORK_ITEM_ID: ${workItemId}\nSpec review`,
          },
        } as never,
        {
          title: "task",
          output: `VVOC_WORK_ITEM_ID: ${workItemId}\nVVOC_STATUS: PASS\n\nSpec pass.`,
          metadata: {},
        } as never,
      );

      await plugin["tool.execute.before"]?.(
        { tool: "task", sessionID, callID: `${prefix}-code` } as never,
        {
          args: {
            subagent_type: "vv-code-reviewer",
            prompt: `VVOC_WORK_ITEM_ID: ${workItemId}\nCode review`,
          },
        } as never,
      );
      await plugin["tool.execute.after"]?.(
        {
          tool: "task",
          sessionID,
          callID: `${prefix}-code`,
          args: {
            subagent_type: "vv-code-reviewer",
            prompt: `VVOC_WORK_ITEM_ID: ${workItemId}\nCode review`,
          },
        } as never,
        {
          title: "task",
          output: `VVOC_WORK_ITEM_ID: ${workItemId}\nVVOC_STATUS: FAIL\n\nNeeds more changes.`,
          metadata: {},
        } as never,
      );
    };

    await runPass("round-1");
    await runPass("round-2");

    await expect(
      plugin["tool.execute.before"]?.(
        { tool: "task", sessionID, callID: "round-3-impl" } as never,
        {
          args: {
            subagent_type: "vv-implementer",
            prompt: `VVOC_WORK_ITEM_ID: ${workItemId}\nImplement`,
          },
        } as never,
      ),
    ).rejects.toThrow("LAUNCH_REJECTED_ROUND_LIMIT");
  });

  test("malformed tracked result raises protocol error", async () => {
    const { plugin, logs } = await createWorkflowPluginHarness();
    const sessionID = "session-protocol-error";

    const openedRaw = await plugin.tool?.work_item_open?.execute(
      { items: [{ key: "WI-PROTOCOL", title: "Protocol error" }] },
      createToolContext(sessionID) as never,
    );
    const opened = parseToolJson<{ items: Array<{ workItemId: string }> }>(openedRaw ?? "{}");
    const workItemId = opened.items[0]?.workItemId;

    await plugin["tool.execute.before"]?.(
      { tool: "task", sessionID, callID: "call-protocol" } as never,
      {
        args: {
          subagent_type: "vv-implementer",
          prompt: `VVOC_WORK_ITEM_ID: ${workItemId}\nImplement`,
        },
      } as never,
    );

    await expect(
      plugin["tool.execute.after"]?.(
        {
          tool: "task",
          sessionID,
          callID: "call-protocol",
          args: {
            subagent_type: "vv-implementer",
            prompt: `VVOC_WORK_ITEM_ID: ${workItemId}\nImplement`,
          },
        } as never,
        {
          title: "task",
          output: `VVOC_WORK_ITEM_ID: ${workItemId}\nVVOC_ROUTE: change_with_review\n\nMissing status.`,
          metadata: {},
        } as never,
      ),
    ).rejects.toThrow("RESULT_PROTOCOL_ERROR");

    expect(logs).toContain("[workflow][resultParsing][BLOCK_PARSE_RESULT] protocol error");
  });

  test("guidance injects for primary sessions only", async () => {
    const { plugin } = await createWorkflowPluginHarness();

    await plugin.config?.({
      agent: {
        "custom-reviewer": {
          mode: "subagent",
        },
      },
    } as never);

    const primaryOutput = {
      message: {
        agent: "build",
        system: undefined as string | undefined,
      },
      parts: [],
    };
    await plugin["chat.message"]?.(
      {
        sessionID: "session-guidance",
        agent: "build",
      } as never,
      primaryOutput as never,
    );

    expect(primaryOutput.message.system).toContain("<workflow_protocol>");
    expect(primaryOutput.message.system).toContain("work_item_open");
    expect(primaryOutput.message.system).toContain("VVOC_WORK_ITEM_ID");

    const enhancerOutput = {
      message: {
        agent: "enhancer",
        system: undefined as string | undefined,
      },
      parts: [],
    };
    await plugin["chat.message"]?.(
      {
        sessionID: "session-guidance",
        agent: "enhancer",
      } as never,
      enhancerOutput as never,
    );
    expect(enhancerOutput.message.system).toBeUndefined();

    const trackedOutput = {
      message: {
        agent: "vv-implementer",
        system: undefined as string | undefined,
      },
      parts: [],
    };
    await plugin["chat.message"]?.(
      {
        sessionID: "session-guidance",
        agent: "vv-implementer",
      } as never,
      trackedOutput as never,
    );
    expect(trackedOutput.message.system).toBeUndefined();

    const configuredSubagentOutput = {
      message: {
        agent: "custom-reviewer",
        system: undefined as string | undefined,
      },
      parts: [],
    };
    await plugin["chat.message"]?.(
      {
        sessionID: "session-guidance",
        agent: "custom-reviewer",
      } as never,
      configuredSubagentOutput as never,
    );
    expect(configuredSubagentOutput.message.system).toBeUndefined();
  });
});
