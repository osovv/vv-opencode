// FILE: src/plugins/workflow.integration.test.ts
// VERSION: 0.4.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify workflow core modules and WorkflowPlugin integration behavior.
//   SCOPE: Protocol parsing, result excerpts, bounded continuation guidance and host-permission preservation, canonical result-status/identity agreement across orchestration profiles, explicit work-item contracts, mode-aware launch validation, review aggregation, profile-compatible guidance, persistence, and primary-only tooling.
//   DEPENDS: [bun:test, node:fs, node:path, @opencode-ai/sdk/v2/types, zod, src/lib/config-layers.ts, src/lib/orchestration.ts, src/lib/vvoc-config.ts, src/plugins/workflow/protocol.ts, src/plugins/workflow/repair.ts, src/plugins/workflow/state.ts, src/plugins/workflow/transitions.ts, src/plugins/workflow/tooling.ts, src/plugins/workflow/index.ts, src/plugins/workflow/persistence.ts]
//   LINKS: [M-WORKFLOW-PROTOCOL, M-WORKFLOW-REPAIR, M-WORKFLOW-STATE, M-WORKFLOW-TRANSITIONS, M-WORKFLOW-TOOLING, M-PLUGIN-WORKFLOW, M-ORCHESTRATION-PROFILES, M-WORKFLOW-PERSISTENCE, V-M-WORKFLOW-PROTOCOL, V-M-WORKFLOW-REPAIR, V-M-WORKFLOW-STATE, V-M-WORKFLOW-TRANSITIONS, V-M-WORKFLOW-TOOLING, V-M-PLUGIN-WORKFLOW, V-M-WORKFLOW-PERSISTENCE]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ListedPluginItems - Parsed work_item_list payload used by plugin integration tests.
//   SESSION_ID - Stable session identifier shared by workflow fixtures.
//   WorkflowPluginHarness - Captured workflow plugin hooks, logs, and recorded prompt calls for one fixture.
//   createToolContext - Builds a workflow tool execution context.
//   createWorkflowPluginHarness - Creates an isolated workflow plugin harness with optional scripted continuation responses.
//   finishPluginTask - Completes a tracked plugin task with a strict result block.
//   finishPluginTaskWithRawOutput - Completes a tracked plugin task with raw output.
//   launchPluginTask - Launches one tracked task through plugin hooks.
//   listPluginItems - Lists and parses plugin work items.
//   openItem - Opens one work item against an in-memory store.
//   openPluginWorkItem - Opens one work item through the plugin tool.
//   openAndLaunchImplementer - Opens an implementation item and launches one vv-implementer task.
//   parseToolJson - Parses structured workflow tool output.
//   previousConfigHome - Preserves the caller's config-home environment for cleanup.
//   result - Builds a strict tracked result block.
//   wrapTaskElement - Wraps tracked output in an OpenCode task-element envelope.
//   wrapTaskResult - Wraps tracked output in an OpenCode task-result envelope.
//   writeWorkflowProfile - Writes an isolated workflow orchestration profile.
//   SessionPromptCall - SDK-derived session.prompt request accepted by the host-contract double.
//   SessionPromptResponse - SDK-derived session.prompt response with a valid assistant message and text part.
//   SessionPromptError - SDK-derived session.prompt error consumed by continuation.
//   SessionPromptConsumedResult - Narrowed SDK session.prompt data/error boundary consumed by continuation.
//   SessionPromptMutation - Session mutation API names tracked by the host-contract double.
//   HostPermissionDouble - Captured host-contract double client, recorded calls, mutation counts, and persisted rules.
//   PromptScriptEntry - Scripted harness continuation outcome: text response, error, or thrown failure.
//   assistantMessage - Builds a valid SDK AssistantMessage fixture for one session.
//   textPart - Builds a valid SDK TextPart response fixture.
//   sessionPromptResponse - Builds a valid SDK session.prompt response fixture.
//   firstPromptText - Extracts the first text-part input from a recorded prompt call.
//   createHostPermissionDouble - Models the confirmed host rule-replacement semantics for prompt `tools` and counts session mutations.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-004 attempt 5 - Extended the gated real-host smoke with a full tracked launch/malformed/continuation/DONE scenario and a readiness-gated backed-off startup that waits for the real app agent/model registry before session create, reusing scripts/e2e-v2/host.ts helpers read-only via dynamic import.]
// END_CHANGE_SUMMARY

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { PermissionRule } from "@opencode-ai/sdk/v2/types";
import { z } from "zod";
import { loadVvocConfig, resetVvocConfigForTests } from "../lib/config-layers.js";
import type { OrchestrationProfile } from "../lib/orchestration.js";
import { createDefaultVvocConfig, renderVvocConfig } from "../lib/vvoc-config.js";
import { createWorkflowPlugin } from "./workflow/index.js";
import { ContractInputError } from "../lib/agent-tool-contract.js";
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
import {
  attemptTrackedResultRepair,
  buildTrackedResultRepairPrompt,
  hasExplicitHardStopStatus,
  isTrackedResultRepairEligible,
  unwrapResumableTaskResult,
} from "./workflow/repair.js";
import {
  applyTrackedResult,
  beginTrackedLaunch,
  closeWorkItem,
  createWorkflowResultExcerpt,
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

// Capture the workflow diagnostic sink's structured console lines (the native
// App is metadata-only) so tests can assert on them like the former host logs.
const workflowLogs: string[] = [];
const originalConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  const line = args.filter((arg): arg is string => typeof arg === "string").join(" ");
  const match = /^\[workflow\]\[\w+\]\s+(.*?)(?:\s+\{[\s\S]*\})?$/.exec(line);
  if (match) workflowLogs.push(match[1]);
  originalConsoleError(...args);
};

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
    body: "",
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
    expect(parsed.value.body).toBe("Implemented all requested changes.");
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

  test("strict parsing diagnoses missing blank line before body text", () => {
    const parsed = parseResultBlock({
      agent: "vv-spec-reviewer",
      output: "VVOC_WORK_ITEM_ID: wi-1\nVVOC_STATUS: FAIL\nFindings\n- Something failed",
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe("MISSING_BODY_SEPARATOR");
    expect(parsed.error.message).toContain("required blank line");
    expect(parsed.error.message).toContain("Offending line: `Findings`");
    expect(parsed.error.message).toContain("Correct shape:");
    expect(parsed.error.message).toContain("VVOC_WORK_ITEM_ID: wi-1\nVVOC_STATUS: FAIL");
    expect(parsed.error.message).not.toContain("non-protocol line");
  });

  test("strict parsing accepts every canonical terminal status with a real assigned id", () => {
    const store = createWorkItemStore();
    expect(
      openWorkItem(store, {
        sessionId: SESSION_ID,
        key: "assigned-first",
        title: "First",
        mode: "implementation",
        requiredReviewers: ["spec"],
      }).ok,
    ).toBe(true);
    const assigned = openWorkItem(store, {
      sessionId: SESSION_ID,
      key: "assigned-second",
      title: "Second",
      mode: "implementation",
      requiredReviewers: ["spec"],
    });
    expect(assigned.ok).toBe(true);
    if (!assigned.ok) return;

    const assignedId = assigned.record.workItemId;
    expect(assignedId).not.toBe("wi-1");
    expect(assigned.header).toBe(`VVOC_WORK_ITEM_ID: ${assignedId}`);

    const header = parseWorkItemHeader(`${assigned.header}\n<assignment>goal</assignment>`);
    expect(header.ok).toBe(true);
    if (header.ok) expect(header.value).toBe(assignedId);

    for (const status of ["DONE", "DONE_WITH_CONCERNS", "NEEDS_CONTEXT", "BLOCKED"] as const) {
      const parsed = parseResultBlock({
        agent: "vv-implementer",
        output: `VVOC_WORK_ITEM_ID: ${assignedId}\nVVOC_STATUS: ${status}\nVVOC_ROUTE: change_with_review\n\nChanged: done`,
        expectedWorkItemId: assignedId,
      });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.value.status).toBe(status);
      expect(parsed.value.route).toBe("change_with_review");
      expect(parsed.value.body).toBe("Changed: done");
    }

    for (const [agent, statuses] of [
      ["vv-spec-reviewer", ["PASS", "FAIL", "NEEDS_CONTEXT"]],
      ["vv-code-reviewer", ["PASS", "FAIL", "NEEDS_CONTEXT"]],
    ] as const) {
      for (const status of statuses) {
        const parsed = parseResultBlock({
          agent,
          output: `VVOC_WORK_ITEM_ID: ${assignedId}\nVVOC_STATUS: ${status}\n\nFindings: none`,
          expectedWorkItemId: assignedId,
        });
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) continue;
        expect(parsed.value.status).toBe(status);
        expect(parsed.value.route).toBeUndefined();
      }
    }
  });

  test("wrong identity is a mismatch and is never relabeled to the assigned id", () => {
    const assignedId = "wi-7";
    const wrongIdentity = {
      agent: "vv-implementer" as const,
      output: "VVOC_WORK_ITEM_ID: wi-1\nVVOC_STATUS: DONE\nVVOC_ROUTE: change_with_review\n\nbody",
    };
    const mismatch = parseResultBlock({ ...wrongIdentity, expectedWorkItemId: assignedId });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.error.code).toBe("WORK_ITEM_MISMATCH");
      expect(mismatch.error.message).toContain("wi-1");
      expect(mismatch.error.message).toContain(assignedId);
    }

    // The block is never silently relabeled: without an expected id it still
    // reports the identity it actually names.
    const named = parseResultBlock(wrongIdentity);
    expect(named.ok).toBe(true);
    if (named.ok) expect(named.value.workItemId).toBe("wi-1");

    const duplicate = parseResultBlock({
      agent: "vv-implementer",
      output: `VVOC_WORK_ITEM_ID: ${assignedId}\nVVOC_STATUS: DONE\nVVOC_STATUS: BLOCKED\nVVOC_ROUTE: change_with_review\n\nbody`,
      expectedWorkItemId: assignedId,
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.code).toBe("DUPLICATE_TOP_BLOCK_FIELD");

    const missingSeparator = parseResultBlock({
      agent: "vv-spec-reviewer",
      output: `VVOC_WORK_ITEM_ID: ${assignedId}\nVVOC_STATUS: FAIL\nFindings without a blank line`,
      expectedWorkItemId: assignedId,
    });
    expect(missingSeparator.ok).toBe(false);
    if (!missingSeparator.ok) {
      expect(missingSeparator.error.code).toBe("MISSING_BODY_SEPARATOR");
    }
  });

  test("bounded repair eligibility stays limited to safe syntax errors", () => {
    for (const code of [
      "MISSING_STATUS",
      "MISSING_ROUTE",
      "UNEXPECTED_TOP_BLOCK_LINE",
      "MISSING_BODY_SEPARATOR",
    ] as const) {
      expect(isTrackedResultRepairEligible(code)).toBe(true);
    }
    for (const code of [
      "WORK_ITEM_MISMATCH",
      "DUPLICATE_TOP_BLOCK_FIELD",
      "MISSING_WORK_ITEM_ID",
      "MALFORMED_WORK_ITEM_HEADER",
      "MISSING_WORK_ITEM_HEADER",
      "UNKNOWN_STATUS",
      "STATUS_NOT_ALLOWED",
    ] as const) {
      expect(isTrackedResultRepairEligible(code)).toBe(false);
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

  test("repair prompt tells agents to move body text below a blank line", () => {
    const prompt = buildTrackedResultRepairPrompt({
      agent: "vv-spec-reviewer",
      workItemId: "wi-1",
      malformedOutput: "VVOC_WORK_ITEM_ID: wi-1\nVVOC_STATUS: FAIL\nFindings",
      parseErrorCode: "MISSING_BODY_SEPARATOR",
      parseErrorMessage: "MISSING_BODY_SEPARATOR: strict top block contains body text",
    });

    expect(prompt).toContain(
      "Move all findings, questions, or result body text below a blank line",
    );
    expect(prompt).toContain("Preserve the same work item identity");
    expect(prompt).toContain("truthfully reflects the result after this continuation");
    expect(prompt).toContain("If the honest outcome is BLOCKED or NEEDS_CONTEXT");
    expect(prompt).toContain(
      "VVOC_WORK_ITEM_ID: wi-1\nVVOC_STATUS: <truthful status>\n\n<brief result handoff>",
    );
    expect(prompt).toContain(
      "Begin the corrected response with the protocol block on the first line",
    );
    expect(prompt).not.toContain("same VVOC_STATUS");
  });

  test("continuation prompt permits bounded same-session work without tool denial", () => {
    const prompt = buildTrackedResultRepairPrompt({
      agent: "vv-implementer",
      workItemId: "wi-1",
      malformedOutput: "I have started implementing; tests are next.",
      parseErrorCode: "UNEXPECTED_TOP_BLOCK_LINE",
      parseErrorMessage: "UNEXPECTED_TOP_BLOCK_LINE: strict top block contains a non-protocol line",
    });

    expect(prompt).toContain("bounded continuation in the same session");
    expect(prompt).toContain("currently permitted tools");
    expect(prompt).toContain("original assignment, role, and write scope");
    expect(prompt).toContain("without repeating completed work");
    expect(prompt).toContain("BLOCKED or NEEDS_CONTEXT");
    expect(prompt).not.toContain("Do not call tools");
    expect(prompt).not.toContain("do not perform implementation or review");
    expect(prompt).not.toContain("Repair only the response format");
    expect(prompt).not.toContain("Keep the same underlying outcome");
  });

  test("continuation prompt does not freeze a missing or outdated status or route", () => {
    const prompt = buildTrackedResultRepairPrompt({
      agent: "vv-implementer",
      workItemId: "wi-1",
      malformedOutput: "VVOC_WORK_ITEM_ID: wi-1\nFindings: blocked on a missing API contract.",
      parseErrorCode: "MISSING_STATUS",
      parseErrorMessage: "MISSING_STATUS: strict top block must include VVOC_STATUS",
    });

    expect(prompt).toContain("do not freeze a missing or outdated status from before it");
    expect(prompt).toContain("report that status explicitly in the corrected response");
    expect(prompt).toContain("VVOC_STATUS: <truthful status>");
    expect(prompt).toContain("VVOC_ROUTE: <route consistent with the original assignment>");
    expect(prompt).not.toContain("<existing route>");
    expect(prompt).not.toContain("same VVOC_STATUS");
  });

  test("explicit malformed hard-stop status lines are detected for suppression", () => {
    expect(hasExplicitHardStopStatus("VVOC_STATUS: BLOCKED")).toBe(true);
    expect(
      hasExplicitHardStopStatus(
        "preamble\nVVOC_WORK_ITEM_ID: wi-1\nVVOC_STATUS: NEEDS_CONTEXT\nbody without separator",
      ),
    ).toBe(true);
    expect(hasExplicitHardStopStatus("VVOC_STATUS: DONE")).toBe(false);
    expect(hasExplicitHardStopStatus("The worker was blocked by a missing API contract.")).toBe(
      false,
    );
  });

  test("native continuation prompt carries no tool, agent, or system override", async () => {
    const host = createNativeRepairDouble({
      rules: [
        { permission: "edit", action: "ask", pattern: "src/**" },
        { permission: "bash", action: "deny", pattern: "*" },
      ],
    });

    await attemptTrackedResultRepair({
      client: host.client,
      sessionId: "ses_old_defect",
      agent: "vv-implementer",
      workItemId: "wi-1",
      malformedOutput: "Old defect probe.",
      parseErrorCode: "UNEXPECTED_TOP_BLOCK_LINE",
      parseErrorMessage: "UNEXPECTED_TOP_BLOCK_LINE",
    });

    expect(host.calls).toHaveLength(1);
    expect(Object.keys(host.calls[0] ?? {}).sort()).toEqual(["sessionID", "text"]);
    expect(Object.keys(host.client.session).sort()).toEqual(["prompt", "wait"]);
  });

  test("continuation returns the corrected native assistant text", async () => {
    const persistentRules: PermissionRule[] = [
      { permission: "edit", action: "ask", pattern: "src/plugins/**" },
      { permission: "bash", action: "deny", pattern: "rm *" },
      { permission: "read", action: "allow", pattern: "*" },
      { permission: "webfetch", action: "allow", pattern: "*" },
      { permission: "work_item_decide", action: "deny", pattern: "*" },
    ];
    const host = createNativeRepairDouble({
      rules: persistentRules,
      promptResult: () => ({
        text: `VVOC_WORK_ITEM_ID: wi-1\nVVOC_STATUS: DONE\nVVOC_ROUTE: change_with_review\n\nFinished the original task.`,
      }),
    });

    expect(host.getRules()).toEqual(persistentRules);

    const continued = await attemptTrackedResultRepair({
      client: host.client,
      sessionId: "ses_same_child",
      agent: "vv-implementer",
      workItemId: "wi-1",
      malformedOutput: "I have started implementing; tests are next.",
      parseErrorCode: "UNEXPECTED_TOP_BLOCK_LINE",
      parseErrorMessage: "UNEXPECTED_TOP_BLOCK_LINE: strict top block contains a non-protocol line",
    });
    expect(continued).toContain("VVOC_STATUS: DONE");
    const continuationCall = host.calls[0];
    expect(continuationCall?.sessionID).toBe("ses_same_child");
    // Native prompt carries only the child id and the continuation text; no
    // tool, agent, system, or model override is ever sent.
    expect(Object.keys(continuationCall ?? {}).sort()).toEqual(["sessionID", "text"]);
    expect(continuationCall?.text).toContain("VVOC_WORK_ITEM_ID: wi-1");
    expect(host.getRules()).toEqual(persistentRules);
  });

  test("continuation failures return undefined without mutating persistent permissions", async () => {
    const persistentRules: PermissionRule[] = [
      { permission: "edit", action: "allow", pattern: "src/**" },
      { permission: "bash", action: "ask", pattern: "*" },
    ];
    const repairOptions = (client: NativeRepairDouble["client"]) => ({
      client,
      sessionId: "ses_same_child",
      agent: "vv-implementer" as const,
      workItemId: "wi-1",
      malformedOutput: "plain progress",
      parseErrorCode: "MISSING_ROUTE" as const,
      parseErrorMessage: "MISSING_ROUTE: vv-implementer output must include VVOC_ROUTE",
    });

    const errorHost = createNativeRepairDouble({
      rules: persistentRules,
      promptResult: () => ({ throws: "rejected" }),
    });
    expect(await attemptTrackedResultRepair(repairOptions(errorHost.client))).toBeUndefined();

    const throwHost = createNativeRepairDouble({
      rules: persistentRules,
      promptResult: () => ({ throws: "aborted" }),
    });
    expect(await attemptTrackedResultRepair(repairOptions(throwHost.client))).toBeUndefined();

    expect(errorHost.getRules()).toEqual(persistentRules);
    expect(throwHost.getRules()).toEqual(persistentRules);
    expect(hostMutationSurface(errorHost.client.session)).toEqual(["prompt", "wait"]);
    expect(hostMutationSurface(throwHost.client.session)).toEqual(["prompt", "wait"]);
  });

  const repairOptions = (client: NativeRepairDouble["client"]) => ({
    client,
    sessionId: "ses_same_child",
    agent: "vv-implementer" as const,
    workItemId: "wi-1",
    malformedOutput: "plain progress",
    parseErrorCode: "MISSING_ROUTE" as const,
    parseErrorMessage: "MISSING_ROUTE: vv-implementer output must include VVOC_ROUTE",
  });

  test("an old valid terminal result is never accepted as a continuation", async () => {
    const oldValid = {
      id: "msg_old_done",
      type: "assistant",
      content: [
        {
          type: "text",
          text: `VVOC_WORK_ITEM_ID: wi-1\nVVOC_STATUS: DONE\nVVOC_ROUTE: change_with_review\n\nOld valid report.`,
        },
      ],
      time: { created: 100, completed: 101 },
    };
    const double = createNativeRepairDouble({
      rules: [],
      existingMessages: [oldValid],
      // The continuation produced no new terminal message.
      promptResult: () => undefined,
    });
    expect(await attemptTrackedResultRepair(repairOptions(double.client))).toBeUndefined();
    expect(double.calls).toHaveLength(1);
  });

  test("a continuation terminal error carrying text is not a corrected result", async () => {
    const double = createNativeRepairDouble({
      rules: [],
      promptResult: () => ({
        text: `VVOC_WORK_ITEM_ID: wi-1\nVVOC_STATUS: DONE\nVVOC_ROUTE: change_with_review\n\nText with error.`,
        error: "aborted",
      }),
    });
    expect(await attemptTrackedResultRepair(repairOptions(double.client))).toBeUndefined();
  });

  test("malformed API results and absent acceptance timestamps fail closed", async () => {
    const invalidList = createNativeRepairDouble({ rules: [], listInvalid: true });
    expect(await attemptTrackedResultRepair(repairOptions(invalidList.client))).toBeUndefined();

    const badAccepted = createNativeRepairDouble({
      rules: [],
      acceptedCreated: 0,
      promptResult: () => ({ text: "corrected" }),
    });
    expect(await attemptTrackedResultRepair(repairOptions(badAccepted.client))).toBeUndefined();
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

  test("result excerpts are bounded and stored on hard-stop and reviewer results", () => {
    const excerpt = createWorkflowResultExcerpt({
      text: "0123456789abcdef",
      source: "parsed_body",
      maxLength: 10,
    });
    expect(excerpt).toEqual({
      source: "parsed_body",
      text: "0123456789",
      truncated: true,
      originalLength: 16,
      maxLength: 10,
    });

    const { store: implementationStore } = openItem({ mode: "implementation" });
    expect(
      beginTrackedLaunch(implementationStore, {
        sessionId: SESSION_ID,
        workItemId: "wi-1",
        agent: "vv-implementer",
      }).ok,
    ).toBe(true);
    const blocked = applyTrackedResult(implementationStore, {
      sessionId: SESSION_ID,
      workItemId: "wi-1",
      result: result("vv-implementer", "BLOCKED"),
      resultExcerpt: excerpt,
    });
    expect(blocked.ok).toBe(true);
    if (!blocked.ok) return;
    expect(blocked.record.state).toBe("blocked");
    expect(blocked.record.resultExcerpt?.truncated).toBe(true);

    const { store: reviewStore } = openItem({ mode: "review_only", requiredReviewers: ["spec"] });
    expect(
      beginTrackedLaunch(reviewStore, {
        sessionId: SESSION_ID,
        workItemId: "wi-1",
        agent: "vv-spec-reviewer",
      }).ok,
    ).toBe(true);
    const needsContext = applyTrackedResult(reviewStore, {
      sessionId: SESSION_ID,
      workItemId: "wi-1",
      result: result("vv-spec-reviewer", "NEEDS_CONTEXT"),
      resultExcerpt: excerpt,
    });
    expect(needsContext.ok).toBe(true);
    if (!needsContext.ok) return;
    expect(needsContext.record.currentRound?.results.spec?.resultExcerpt?.text).toBe("0123456789");
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
  test("work_item_open rejects a whole request structurally before any item opens", () => {
    const store = createWorkItemStore();
    const openTool = createWorkItemOpenTool(store);
    // Missing mode/reviewers is structural: the complete request is rejected
    // and the store stays unchanged (AC-10 whole-request structural rejection).
    const invalid = openTool.execute(
      { items: [{ key: "invalid", title: "Invalid" }] },
      { sessionId: SESSION_ID },
    ) as { ok?: boolean; errorCode?: string; items?: Array<{ ok: boolean }> };
    expect(invalid.ok).toBe(false);
    expect(invalid.errorCode).toBe("INVALID_INPUT");
    expect(invalid.items).toBeUndefined();
    expect(store.getStoreData().records.size).toBe(0);

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

  test("work_item_list exposes implementer and reviewer recovery excerpts", () => {
    const excerpt = createWorkflowResultExcerpt({
      text: "Need product decision before continuing.",
      source: "parsed_body",
    });
    const implementationStore = createWorkItemStore();
    const implementationListTool = createWorkItemListTool(implementationStore);
    const opened = openWorkItem(implementationStore, {
      sessionId: SESSION_ID,
      key: "blocked",
      title: "Blocked",
      mode: "implementation",
      requiredReviewers: ["spec"],
    });
    expect(opened.ok).toBe(true);
    expect(
      beginTrackedLaunch(implementationStore, {
        sessionId: SESSION_ID,
        workItemId: "wi-1",
        agent: "vv-implementer",
      }).ok,
    ).toBe(true);
    applyTrackedResult(implementationStore, {
      sessionId: SESSION_ID,
      workItemId: "wi-1",
      result: result("vv-implementer", "NEEDS_CONTEXT"),
      resultExcerpt: excerpt,
    });
    const implementationListed = implementationListTool.execute(
      { includeClosed: false },
      { sessionId: SESSION_ID },
    ) as { items: Array<{ resultExcerpt?: { text: string } }> };
    expect(implementationListed.items[0]?.resultExcerpt?.text).toBe(
      "Need product decision before continuing.",
    );

    const reviewStore = createWorkItemStore();
    const reviewListTool = createWorkItemListTool(reviewStore);
    openWorkItem(reviewStore, {
      sessionId: SESSION_ID,
      key: "review-needs-context",
      title: "Review needs context",
      mode: "review_only",
      requiredReviewers: ["spec"],
    });
    expect(
      beginTrackedLaunch(reviewStore, {
        sessionId: SESSION_ID,
        workItemId: "wi-1",
        agent: "vv-spec-reviewer",
      }).ok,
    ).toBe(true);
    applyTrackedResult(reviewStore, {
      sessionId: SESSION_ID,
      workItemId: "wi-1",
      result: result("vv-spec-reviewer", "NEEDS_CONTEXT"),
      resultExcerpt: excerpt,
    });
    const reviewListed = reviewListTool.execute(
      { includeClosed: false },
      { sessionId: SESSION_ID },
    ) as {
      items: Array<{ currentRound?: { results: { spec?: { resultExcerpt?: { text: string } } } } }>;
    };
    expect(reviewListed.items[0]?.currentRound?.results.spec?.resultExcerpt?.text).toBe(
      "Need product decision before continuing.",
    );
  });
});

// START_BLOCK_CONTRACT_DIAGNOSTICS
describe("workflow tool contract diagnostics (registered schemas, hooks, wrappers)", () => {
  async function catchHookError(
    plugin: NativeWorkflowHarnessPlugin,
    tool: string,
    args: unknown,
    sessionID: string,
  ): Promise<unknown> {
    try {
      await plugin["tool.execute.before"]?.(
        { tool, sessionID, callID: `contract-${tool}` } as never,
        { args } as never,
      );
      return undefined;
    } catch (error) {
      return error;
    }
  }

  test("tool.execute.before rejects owned structural and branch failures without touching task hooks", async () => {
    const { plugin } = await createWorkflowPluginHarness();
    const sessionID = "session-contract-hook";
    await deleteWorkflowSessionDir(sessionID);

    const structural = await catchHookError(
      plugin,
      "work_item_open",
      { items: [{ key: "k", title: "T" }] },
      sessionID,
    );
    expect(structural).toBeInstanceOf(ContractInputError);
    expect(String((structural as Error).message)).toContain("items[0].mode");

    const branch = await catchHookError(
      plugin,
      "work_checkpoint",
      {
        action: "authorize",
        runId: "run-1",
        authorityId: "auth-1",
        messageId: "msg-1",
        stages: ["implementation"],
        reservedStops: ["verificaton"],
      },
      sessionID,
    );
    expect(branch).toBeInstanceOf(ContractInputError);
    expect(String((branch as Error).message)).toContain("reservedStops[0]");

    // Valid owned args and non-owned non-task tools pass the hook untouched.
    await plugin["tool.execute.before"]?.(
      { tool: "work_item_list", sessionID, callID: "contract-list" } as never,
      { args: {} } as never,
    );
    await plugin["tool.execute.before"]?.(
      { tool: "str_replace_editor", sessionID, callID: "contract-edit" } as never,
      { args: { anything: true } } as never,
    );
    // The task-launch hook path still runs for untracked subagents.
    await plugin["tool.execute.before"]?.(
      { tool: "task", sessionID, callID: "contract-task" } as never,
      { args: { subagent_type: "general", prompt: "explore" } } as never,
    );
    await deleteWorkflowSessionDir(sessionID);
  });

  test("native tool registration publishes the strict closed input schema", async () => {
    const { plugin } = await createWorkflowPluginHarness();
    const tool = plugin.tool["work_item_open"] as unknown as { input: unknown } | undefined;
    expect(tool).toBeDefined();
    const schema = tool?.input as { safeParse: (value: unknown) => { success: boolean } };
    // The published schema rejects unknown keys (strict object).
    expect(schema.safeParse({ items: [], unexpected: true }).success).toBe(false);
    expect(
      schema.safeParse({
        items: [{ key: "k", title: "t", mode: "delegated", requiredReviewers: [] }],
      }).success,
    ).toBe(true);
    const jsonSchema = z.toJSONSchema(schema as never, { io: "input" }) as Record<string, unknown>;
    expect(jsonSchema.additionalProperties).toBe(false);
    expect(JSON.stringify(jsonSchema)).toContain("conversation-scoped");
  });

  test("wrapper rejects source, binding, path, and unknown-key failures with the whole store unchanged", async () => {
    const { plugin } = await createWorkflowPluginHarness();
    const sessionID = "session-contract-wrapper";
    await deleteWorkflowSessionDir(sessionID);
    const context = createToolContext(sessionID);

    const genericItem = {
      key: "gk",
      title: "Generic task",
      mode: "delegated",
      requiredReviewers: ["code"],
      writeScope: ["src/lib/a.ts"],
      taskId: "T-100",
    };
    const execution = {
      executionKey: "contract-run",
      source: { kind: "conversation-scoped" },
      goal: "Deliver the contract checks.",
      boundary: { files: ["src/lib/a.ts"], directories: [] },
    };
    const rejections: Array<{ args: Record<string, unknown>; expect: string }> = [
      {
        args: {
          items: [genericItem],
          execution: { ...execution, source: { kind: "conversation" } },
        },
        expect: "conversation-scoped",
      },
      {
        args: {
          items: [genericItem],
          execution: { ...execution, source: { kind: "provided-plan" } },
        },
        expect: "execution.source.reference",
      },
      {
        args: {
          items: [genericItem],
          execution: {
            ...execution,
            source: { kind: "provided-plan", reference: "docs/p.md", sha256: 42 },
          },
        },
        expect: "execution.source.sha256",
      },
      {
        args: {
          items: [{ ...genericItem, unexpectedTaskKey: true }],
          execution,
        },
        expect: "items[0].unexpectedTaskKey",
      },
      {
        args: { items: [{ ...genericItem, mode: "implementation" }], execution },
        expect: "items[0].mode",
      },
      {
        args: {
          items: [{ ...genericItem, planRunId: "native-run", planTaskId: "T-001" }],
          execution,
        },
        expect: "items[0].planRunId",
      },
      {
        args: {
          items: [genericItem],
          execution: {
            ...execution,
            boundary: { files: [99], directories: [] },
          },
        },
        expect: "execution.boundary.files[0]",
      },
      {
        args: {
          items: [genericItem],
          execution: {
            ...execution,
            boundary: { files: ["src/lib/"], directories: [] },
          },
        },
        expect: "boundary.files",
      },
    ];

    const beforeList = parseToolJson<{ items: unknown[] }>(
      (await plugin.tool?.work_item_list?.execute(
        { includeClosed: false },
        context as never,
      )) as string,
    );
    expect(beforeList.items).toHaveLength(0);

    for (const rejection of rejections) {
      const raw = await plugin.tool?.work_item_open?.execute(
        rejection.args as never,
        context as never,
      );
      const parsed = parseToolJson<{ ok?: boolean; errorCode?: string; message?: string }>(
        raw as string,
      );
      expect(parsed.ok).toBe(false);
      expect(parsed.errorCode).toBe("INVALID_INPUT");
      expect(String(parsed.message)).toContain(rejection.expect);
    }

    // Whole-request structural rejection after an earlier valid batch item:
    // nothing from the batch reaches the store.
    const partialBatch = await plugin.tool?.work_item_open?.execute(
      {
        items: [
          {
            key: "valid-first",
            title: "Valid",
            mode: "implementation",
            requiredReviewers: ["spec"],
          },
          { key: "invalid-second", title: "Invalid" },
        ],
      } as never,
      context as never,
    );
    const partial = parseToolJson<{ ok?: boolean; errorCode?: string }>(partialBatch as string);
    expect(partial.ok).toBe(false);
    expect(partial.errorCode).toBe("INVALID_INPUT");

    const afterList = parseToolJson<{ items: unknown[] }>(
      (await plugin.tool?.work_item_list?.execute(
        { includeClosed: false },
        context as never,
      )) as string,
    );
    expect(afterList.items).toHaveLength(0);

    // After structural acceptance, domain conflicts stay per-item.
    const first = parseToolJson<{ items: Array<{ ok: boolean }> }>(
      (await plugin.tool?.work_item_open?.execute(
        {
          items: [
            {
              key: "conflict-key",
              title: "First",
              mode: "implementation",
              requiredReviewers: ["spec"],
            },
          ],
        } as never,
        context as never,
      )) as string,
    );
    expect(first.items[0]?.ok).toBe(true);
    const conflict = parseToolJson<{ items: Array<{ ok: boolean; errorCode?: string }> }>(
      (await plugin.tool?.work_item_open?.execute(
        {
          items: [
            {
              key: "conflict-key",
              title: "Different intent",
              mode: "review_only",
              requiredReviewers: ["code"],
            },
          ],
        } as never,
        context as never,
      )) as string,
    );
    expect(conflict.items[0]?.ok).toBe(false);
    expect(conflict.items[0]?.errorCode).toBe("WORK_ITEM_KEY_CONFLICT");

    await deleteWorkflowSessionDir(sessionID);
  });

  test("standalone delegated missing versus empty reviewers and file/directory trailing separators through the wrapper", async () => {
    const { plugin } = await createWorkflowPluginHarness();
    const sessionID = "session-contract-delegated";
    await deleteWorkflowSessionDir(sessionID);
    const context = createToolContext(sessionID);

    const missingReviewers = parseToolJson<{ ok?: boolean; message?: string }>(
      (await plugin.tool?.work_item_open?.execute(
        {
          items: [
            { key: "del-missing", title: "Delegated", mode: "delegated", writeScope: ["src/a.ts"] },
          ],
        } as never,
        context as never,
      )) as string,
    );
    expect(missingReviewers.ok).toBe(false);
    expect(String(missingReviewers.message)).toContain("items[0].requiredReviewers");

    const trailingFile = parseToolJson<{ ok?: boolean; message?: string }>(
      (await plugin.tool?.work_item_open?.execute(
        {
          items: [
            {
              key: "del-trailing",
              title: "Delegated",
              mode: "delegated",
              requiredReviewers: [],
              writeScope: ["src/lib/"],
            },
          ],
        } as never,
        context as never,
      )) as string,
    );
    expect(trailingFile.ok).toBe(false);
    expect(String(trailingFile.message)).toContain("items[0].writeScope[0]");

    // Generic reviewer-positive path with a directory trailing separator in the
    // boundary normalizes and opens successfully.
    const reviewerPositive = parseToolJson<{ ok?: boolean; runId?: string }>(
      (await plugin.tool?.work_item_open?.execute(
        {
          items: [
            {
              key: "del-empty",
              title: "Delegated empty",
              mode: "delegated",
              requiredReviewers: [],
              writeScope: ["src/lib/a.ts"],
            },
            {
              key: "reviewed-task",
              title: "Reviewed task",
              mode: "delegated",
              requiredReviewers: ["code"],
              writeScope: ["src/lib/b.ts"],
              taskId: "T-REVIEW",
            },
          ],
          execution: {
            executionKey: "reviewer-positive",
            source: { kind: "conversation-scoped" },
            goal: "Exercise the reviewer-positive generic path.",
            boundary: { files: ["src/lib/a.ts", "src/lib/b.ts"], directories: ["src/lib/"] },
          },
        } as never,
        context as never,
      )) as string,
    );
    expect(reviewerPositive.ok).toBe(true);
    expect(reviewerPositive.runId).toBeTruthy();

    await deleteWorkflowSessionDir(sessionID);
  });

  test("registered hooks and wrappers reject conflicting fields and blank batch members", async () => {
    const { plugin } = await createWorkflowPluginHarness();
    const sessionID = "session-contract-matrix";
    await deleteWorkflowSessionDir(sessionID);
    const context = createToolContext(sessionID);

    const hookCheckpoint = await catchHookError(
      plugin,
      "work_checkpoint",
      { action: "complete", runId: "run-1", reservedStops: ["verification"] },
      sessionID,
    );
    expect(hookCheckpoint).toBeInstanceOf(ContractInputError);
    expect(String((hookCheckpoint as Error).message)).toContain("reservedStops");

    const hookDecide = await catchHookError(
      plugin,
      "work_item_decide",
      {
        workItemId: "wi-1",
        attempt: 1,
        decision: "accept",
        rationale: "checked",
        evidence: ["test"],
        recoveryId: "ignored-recovery",
      },
      sessionID,
    );
    expect(hookDecide).toBeInstanceOf(ContractInputError);
    expect(String((hookDecide as Error).message)).toContain("recoveryId");

    // Wrapper path: a blank-after-trim batch member rejects the whole request
    // before the first item opens.
    const raw = await plugin.tool?.work_item_open?.execute(
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
      } as never,
      context as never,
    );
    const parsed = parseToolJson<{ ok?: boolean; message?: string }>(raw as string);
    expect(parsed.ok).toBe(false);
    expect(String(parsed.message)).toContain("items[1].key");

    const listed = parseToolJson<{ items: unknown[] }>(
      (await plugin.tool?.work_item_list?.execute(
        { includeClosed: false },
        context as never,
      )) as string,
    );
    expect(listed.items).toHaveLength(0);

    await deleteWorkflowSessionDir(sessionID);
  });
});
// END_BLOCK_CONTRACT_DIAGNOSTICS

type WorkflowPluginHarness = {
  plugin: NativeWorkflowHarnessPlugin;
  logs: string[];
  promptCalls: Array<{ sessionID: string; text: string }>;
  messages: Map<string, unknown[]>;
  sessionViews: Map<string, Record<string, unknown>>;
  emit: (event: unknown) => void;
};

type PromptScriptEntry = string | { error: string } | { throws: string };

// START_BLOCK_NATIVE_WORKFLOW_FIXTURE
/**
 * Native fixture for the workflow plugin. It builds a native `Plugin.Context`,
 * runs the real `WorkflowPlugin.setup`, and captures the native tool editor,
 * tool hooks, session hooks and event stream. `plugin.tool[name].execute` is the
 * actual registered native tool; the `tool.execute.before`/`after` and
 * `chat.message` members are thin native-event adapters so existing test bodies
 * keep driving the real plugin through native registrations.
 */
type NativeWorkflowHarnessPlugin = {
  tool: Record<
    string,
    { name: string; execute: (input: unknown, context: unknown) => Promise<unknown> } | undefined
  >;
  "tool.execute.before": (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: unknown },
  ) => Promise<void>;
  "tool.execute.after": (
    input: { tool: string; sessionID: string; callID: string; args: unknown },
    output: { title?: string; output: unknown; metadata?: unknown },
  ) => Promise<void>;
  "chat.message": (
    input: unknown,
    output: { message: { agent?: string; sessionID?: string; system?: string } },
  ) => Promise<void>;
};

class NativeEventQueue {
  private readonly events: unknown[] = [];
  private waiter: (() => void) | undefined;

  push(event: unknown): void {
    this.events.push(event);
    this.waiter?.();
    this.waiter = undefined;
  }

  drain(): AsyncIterable<unknown> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<unknown> => ({
        next: () => {
          const next = this.events.shift();
          if (next !== undefined) return Promise.resolve({ done: false as const, value: next });
          return new Promise((resolve) => {
            this.waiter = () => {
              const value = this.events.shift();
              resolve(
                value === undefined
                  ? { done: true as const, value: undefined }
                  : { done: false as const, value },
              );
            };
          });
        },
        return: () => Promise.resolve({ done: true as const, value: undefined }),
      }),
    };
  }
}

function deriveSubagentChildId(output: string): string | undefined {
  const element = /^<task\s+id="([^"]+)"/m.exec(output);
  if (element) return element[1];
  const header = /^task_id:\s+(\S+)/m.exec(output);
  if (header) return header[1];
  return undefined;
}

function writeWorkflowProfile(profile: OrchestrationProfile): void {
  const configHome = process.env.XDG_CONFIG_HOME;
  if (!configHome) throw new Error("XDG_CONFIG_HOME required for workflow test");
  const config = createDefaultVvocConfig();
  config.orchestration = { profile };
  const configDir = join(configHome, "vvoc");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "vvoc.json"), renderVvocConfig(config), "utf8");
}

type NativeToolInfo = {
  name: string;
  execute: (input: unknown, context: unknown) => Promise<unknown>;
};

type NativeFakeToolEditor = {
  list: () => NativeToolInfo[];
  get: (id: string) => NativeToolInfo | undefined;
  namespace: () => void;
  add: (tool: NativeToolInfo) => void;
  update: () => void;
  remove: (id: string) => void;
};

async function createWorkflowPluginHarness(
  profile?: OrchestrationProfile,
  options?: {
    promptResponses?: PromptScriptEntry[];
    sessions?: Record<string, Record<string, unknown>>;
    captures?: Record<string, { vvoc: ReturnType<typeof createDefaultVvocConfig> }>;
  },
): Promise<WorkflowPluginHarness> {
  if (profile) writeWorkflowProfile(profile);
  const logs: string[] = workflowLogs;
  workflowLogs.length = 0;
  const promptCalls: Array<{ sessionID: string; text: string }> = [];
  const messages = new Map<string, unknown[]>();
  const sessionViews = new Map<string, Record<string, unknown>>(
    Object.entries(options?.sessions ?? {}),
  );
  const pendingPromptResponses = [...(options?.promptResponses ?? [])];
  let messageCounter = 0;
  const queue = new NativeEventQueue();
  const tools = new Map<
    string,
    { name: string; execute: (input: unknown, context: unknown) => Promise<unknown> }
  >();
  const beforeHooks: Array<(event: Record<string, unknown>) => unknown> = [];
  const afterHooks: Array<(event: Record<string, unknown>) => unknown> = [];
  const contextHooks: Array<(event: Record<string, unknown>) => unknown> = [];

  const rootSession = (sessionID: string): Record<string, unknown> =>
    sessionViews.get(sessionID) ?? {
      id: sessionID,
      location: { directory: "/tmp/project" },
      time: { created: 1 },
    };

  const messageTime = (message: unknown): number => {
    if (typeof message !== "object" || message === null) return 0;
    const time = (message as { time?: { created?: unknown } }).time;
    return typeof time?.created === "number" ? time.created : 0;
  };

  const fakeClient = {
    session: {
      get: async ({ sessionID }: { sessionID: string }) => rootSession(sessionID),
      context: async ({ sessionID }: { sessionID: string }) => messages.get(sessionID) ?? [],
      message: {
        get: async ({ sessionID, messageID }: { sessionID: string; messageID: string }) =>
          (messages.get(sessionID) ?? []).find(
            (message) =>
              typeof message === "object" &&
              message !== null &&
              (message as { id?: unknown }).id === messageID,
          ),
      },
      active: async () => ({}),
      inbox: { list: async () => [] },
      prompt: async (input: { sessionID: string; text: string }) => {
        promptCalls.push({ sessionID: input.sessionID, text: input.text });
        const entry = pendingPromptResponses.shift();
        if (typeof entry === "object" && entry !== null && "throws" in entry) {
          throw new Error(entry.throws);
        }
        if (typeof entry === "string") {
          const created = Date.now();
          messageCounter += 1;
          messages.set(input.sessionID, [
            ...(messages.get(input.sessionID) ?? []),
            {
              id: `msg_cont_${messageCounter}`,
              type: "assistant",
              content: [{ type: "text", text: entry }],
              time: { created, completed: created + 1 },
            },
          ]);
        }
        return {
          id: `msg_prompt_${input.sessionID}`,
          sessionID: input.sessionID,
          time: { created: Date.now() },
        };
      },
      wait: async () => undefined,
      interrupt: async () => undefined,
      hook: async (_name: string, callback: (event: Record<string, unknown>) => unknown) => {
        contextHooks.push(callback);
        return { dispose: async () => undefined };
      },
    },
    message: {
      list: async (input: {
        sessionID: string;
        order?: "asc" | "desc";
        limit?: number;
        type?: string;
      }) => {
        let data = [...(messages.get(input.sessionID) ?? [])];
        if (input.type !== undefined) {
          data = data.filter((message) => (message as { type?: unknown }).type === input.type);
        }
        data.sort((left, right) =>
          input.order === "desc"
            ? messageTime(right) - messageTime(left)
            : messageTime(left) - messageTime(right),
        );
        if (input.limit !== undefined) data = data.slice(0, input.limit);
        return { data, cursor: {} };
      },
    },
  };

  const loaded = await loadVvocConfig({ cwd: "/tmp/project" });
  const captures = options?.captures ?? {};
  const defaultCapture = { vvoc: loaded.config };
  const fakeRuntime = {
    snapshots: {
      // Tests explicitly bind a fixture policy per session; absence is only
      // used by the disabled/unbound regression and fails closed in production.
      configFor: async (sessionID: string) => captures[sessionID] ?? defaultCapture,
      accept: async () => ({ status: "unbound" }),
    },
    client: async () => fakeClient,
    effectiveConfig: () => ({ vvoc: loaded.config }),
    release: async () => undefined,
  };

  const editor = {
    list: () => [...tools.values()],
    get: (id: string) => tools.get(id),
    namespace: () => undefined,
    add: (tool: {
      name: string;
      execute: (input: unknown, context: unknown) => Promise<unknown>;
    }) => {
      tools.set(tool.name, tool);
    },
    update: () => undefined,
    remove: (id: string) => {
      tools.delete(id);
    },
  };

  const ctx = {
    location: {
      directory: "/tmp/project",
      project: { id: "proj", directory: "/tmp/project", canonical: "/tmp/project" },
    },
    tool: {
      transform: async (callback: (editor: NativeFakeToolEditor) => void) => {
        callback(editor);
        return { dispose: async () => undefined };
      },
      hook: async (name: string, callback: (event: Record<string, unknown>) => unknown) => {
        if (name === "execute.before") beforeHooks.push(callback);
        else if (name === "execute.after") afterHooks.push(callback);
        return { dispose: async () => undefined };
      },
      list: async () => [],
      reload: async () => undefined,
    },
    session: {
      hook: async (_name: string, callback: (event: Record<string, unknown>) => unknown) => {
        contextHooks.push(callback);
        return { dispose: async () => undefined };
      },
    },
    event: { subscribe: () => queue.drain() },
    rpc: { register: async () => ({ dispose: async () => undefined }) },
  };

  await createWorkflowPlugin({ acquireRuntime: async () => fakeRuntime as never }).setup(
    ctx as never,
  );

  const plugin: NativeWorkflowHarnessPlugin = {
    tool: new Proxy(
      {},
      {
        get: (_target, property: string) => tools.get(property),
      },
    ) as NativeWorkflowHarnessPlugin["tool"],
    "tool.execute.before": async (input, output) => {
      // Native tool name is `subagent`; tests use the V1 `task` name.
      const toolName = input.tool === "task" ? "subagent" : input.tool;
      const args = (output.args ?? {}) as Record<string, unknown>;
      const nativeInput =
        toolName === "subagent"
          ? {
              agent: args.subagent_type,
              description: args.description,
              prompt: args.prompt,
              ...(args.task_id === undefined ? {} : { sessionID: args.task_id }),
              ...(args.background === undefined ? {} : { background: args.background }),
              ...(args.model === undefined ? {} : { model: args.model }),
            }
          : args;
      const event: Record<string, unknown> = {
        tool: toolName,
        sessionID: input.sessionID,
        agent: "vv-controller",
        messageID: "message-1",
        id: input.callID,
        input: nativeInput,
      };
      for (const hook of beforeHooks) await hook(event);
      output.args = event.input;
    },
    "tool.execute.after": async (input, output) => {
      const toolName = input.tool === "task" ? "subagent" : input.tool;
      const rawArgs = (input.args ?? {}) as Record<string, unknown>;
      const nativeInput = {
        agent: rawArgs.subagent_type,
        description: rawArgs.description,
        prompt: rawArgs.prompt,
        ...(rawArgs.task_id === undefined ? {} : { sessionID: rawArgs.task_id }),
        ...(rawArgs.background === undefined ? {} : { background: rawArgs.background }),
      };
      const outputText = typeof output.output === "string" ? output.output : "";
      const childSessionId = deriveSubagentChildId(outputText) ?? `ses_${input.callID}_child`;
      const event: Record<string, unknown> = {
        tool: toolName,
        sessionID: input.sessionID,
        agent: "vv-controller",
        messageID: "message-1",
        id: input.callID,
        input: nativeInput,
        status: "completed",
        result: {
          output: { sessionID: childSessionId, status: "completed", output: outputText },
          content: `<subagent sessionID="${childSessionId}" state="completed">\n${outputText}\n</subagent>`,
          metadata: output.metadata ?? {},
        },
      };
      for (const hook of afterHooks) await hook(event);
      const result = event.result as { output?: unknown; metadata?: unknown };
      // Native execute.after cannot fail; the workflow surfaces diagnostics by
      // rewriting the completed native result. The fixture returns that text.
      output.output = result.output;
      output.metadata = result.metadata;
    },
    "chat.message": async (_input, output) => {
      const existing = output.message.system ?? "";
      const toolNames = [
        "work_item_open",
        "work_item_list",
        "work_item_close",
        "work_item_decide",
        "work_checkpoint",
      ];
      const tools: Record<string, unknown> = {};
      for (const name of toolNames) tools[name] = { description: name, input: {} };
      const event: Record<string, unknown> = {
        sessionID: output.message.sessionID ?? "session",
        agent: output.message.agent,
        model: {},
        system: existing.trim() === "" ? [] : [{ type: "text", text: existing }],
        messages: [],
        options: {},
        tools,
      };
      for (const hook of contextHooks) await hook(event);
      output.message.system = (event.system as Array<{ text: string }>)
        .map((part) => part.text)
        .join("\n\n");
      (output as { tools?: Record<string, unknown> }).tools = tools;
    },
  };

  return {
    plugin,
    logs,
    promptCalls,
    messages,
    sessionViews,
    emit: (event) => queue.push(event),
  };
}
// END_BLOCK_NATIVE_WORKFLOW_FIXTURE

describe("workflow plugin integration", () => {
  beforeEach(async () => {
    resetVvocConfigForTests();
    process.env.XDG_CONFIG_HOME = `/tmp/vvoc-workflow-empty-config-${process.pid}`;
    rmSync(process.env.XDG_CONFIG_HOME, { recursive: true, force: true });

    for (const sessionID of [
      "session-review-only-double-fail",
      "session-needs-context-inflight",
      "session-round-limit",
      "session-implementer-blocked-excerpt",
      "session-protocol-error-excerpt",
      "session-state-error-excerpt",
      "session-reviewer-needs-context-excerpt",
      "session-guidance",
      "session-tool-denied",
      "session-protocol-continuation",
      "session-protocol-continuation-element",
      "session-protocol-continuation-hard-stop-result",
      "session-hard-stop-missing-blank",
      "session-hard-stop-preamble",
      "session-hard-stop-element",
      "session-continuation-rejected",
      "session-continuation-thrown",
      "session-continuation-malformed",
      "session-continuation-empty",
      "session-continuation-mismatch",
      "session-continuation-bad-status",
      "session-continuation-missing-route",
      "session-valid-result",
      "session-valid-hard-stop",
    ]) {
      await deleteWorkflowSessionDir(sessionID);
    }
  });

  afterEach(async () => {
    resetVvocConfigForTests();
    rmSync(`/tmp/vvoc-workflow-empty-config-${process.pid}`, { recursive: true, force: true });

    if (previousConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previousConfigHome;
    }

    for (const sessionID of [
      "session-review-only-double-fail",
      "session-needs-context-inflight",
      "session-round-limit",
      "session-implementer-blocked-excerpt",
      "session-protocol-error-excerpt",
      "session-state-error-excerpt",
      "session-reviewer-needs-context-excerpt",
      "session-guidance",
      "session-tool-denied",
      "session-protocol-continuation",
      "session-protocol-continuation-element",
      "session-protocol-continuation-hard-stop-result",
      "session-hard-stop-missing-blank",
      "session-hard-stop-preamble",
      "session-hard-stop-element",
      "session-continuation-rejected",
      "session-continuation-thrown",
      "session-continuation-malformed",
      "session-continuation-empty",
      "session-continuation-mismatch",
      "session-continuation-bad-status",
      "session-continuation-missing-route",
      "session-valid-result",
      "session-valid-hard-stop",
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

    const aggregateHardStop = await finishPluginTask(
      plugin,
      sessionID,
      "code",
      "vv-code-reviewer",
      workItemId,
      "PASS",
    );
    expect(aggregateHardStop).toContain("RESULT_HARD_STOP: needs_context");
    listed = await listPluginItems(plugin, sessionID);
    expect(listed.items[0]?.state).toBe("needs_context");
  });

  test("implementer BLOCKED hard stop includes and lists result excerpt", async () => {
    const { plugin } = await createWorkflowPluginHarness();
    const sessionID = "session-implementer-blocked-excerpt";
    const workItemId = await openPluginWorkItem(plugin, sessionID, "implementation", ["spec"]);

    await launchPluginTask(plugin, sessionID, "impl", "vv-implementer", workItemId);
    const blocked = await finishPluginTask(
      plugin,
      sessionID,
      "impl",
      "vv-implementer",
      workItemId,
      "BLOCKED",
      "Blocked because the target API contract is missing.",
    );
    expect(blocked).toContain("Blocked because the target API contract is missing.");

    const listed = await listPluginItems(plugin, sessionID);
    expect(listed.items[0]?.state).toBe("blocked");
    expect(listed.items[0]?.resultExcerpt?.source).toBe("parsed_body");
    expect(listed.items[0]?.resultExcerpt?.text).toBe(
      "Blocked because the target API contract is missing.",
    );
  });

  test("protocol errors include original normalized output excerpt", async () => {
    const { plugin } = await createWorkflowPluginHarness();
    const sessionID = "session-protocol-error-excerpt";
    const workItemId = await openPluginWorkItem(plugin, sessionID, "review_only", ["spec"]);

    await launchPluginTask(plugin, sessionID, "spec", "vv-spec-reviewer", workItemId);
    const excerpt = await finishPluginTaskWithRawOutput(
      plugin,
      sessionID,
      "spec",
      "vv-spec-reviewer",
      workItemId,
      wrapTaskResult(
        "ses_repair_missing_blank",
        `VVOC_WORK_ITEM_ID: ${workItemId}\nVVOC_STATUS: FAIL\nFindings from reviewer`,
      ),
    );
    expect(excerpt).toContain("Findings from reviewer");
    const protocol = await finishPluginTaskWithRawOutput(
      plugin,
      sessionID,
      "spec-second-attempt",
      "vv-spec-reviewer",
      workItemId,
      wrapTaskResult(
        "ses_repair_missing_blank",
        `VVOC_WORK_ITEM_ID: ${workItemId}\nVVOC_STATUS: FAIL\nFindings from reviewer`,
      ),
    );
    expect(protocol).toContain("RESULT_PROTOCOL_ERROR");
  });

  test("incomplete wrapped output continues the same child once and applies the corrected result", async () => {
    const { plugin, promptCalls, logs } = await createWorkflowPluginHarness(undefined, {
      promptResponses: [
        `VVOC_WORK_ITEM_ID: wi-1\nVVOC_STATUS: DONE\nVVOC_ROUTE: change_with_review\n\nFinished the original task and reran its checks.`,
      ],
    });
    const sessionID = "session-protocol-continuation";
    const workItemId = await openPluginWorkItem(plugin, sessionID, "implementation", ["spec"]);

    await launchPluginTask(plugin, sessionID, "impl", "vv-implementer", workItemId);
    await finishPluginTaskWithRawOutput(
      plugin,
      sessionID,
      "impl",
      "vv-implementer",
      workItemId,
      wrapTaskResult(
        "ses_continuation_child",
        "I have started implementing; I still need to run the focused tests.",
      ),
    );

    expect(promptCalls).toHaveLength(1);
    const call = promptCalls[0];
    expect(call?.sessionID).toBe("ses_continuation_child");
    expect(Object.keys(call ?? {}).sort()).toEqual(["sessionID", "text"]);
    expect(call?.text).toContain(
      "I have started implementing; I still need to run the focused tests.",
    );
    expect(logs).toContain(
      "[workflow][resultParsing][BLOCK_PARSE_RESULT] bounded continuation attempted",
    );

    const listed = await listPluginItems(plugin, sessionID);
    expect(listed.items[0]?.state).toBe("awaiting_reviews");
    expect(listed.items[0]?.currentRound).toBeDefined();
    expect(logs).toContain("[workflow][resultParsing][BLOCK_PARSE_RESULT] result parsed");
  });

  test("task-element wrapped output also continues the same child once", async () => {
    const { plugin, promptCalls } = await createWorkflowPluginHarness(undefined, {
      promptResponses: [
        `VVOC_WORK_ITEM_ID: wi-1\nVVOC_STATUS: DONE\nVVOC_ROUTE: change_with_review\n\nCompleted via element continuation.`,
      ],
    });
    const sessionID = "session-protocol-continuation-element";
    const workItemId = await openPluginWorkItem(plugin, sessionID, "implementation", ["spec"]);
    await launchPluginTask(plugin, sessionID, "impl", "vv-implementer", workItemId);
    await finishPluginTaskWithRawOutput(
      plugin,
      sessionID,
      "impl",
      "vv-implementer",
      workItemId,
      wrapTaskElement("ses_element_child", "Plain progress without a protocol header."),
    );

    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0]?.sessionID).toBe("ses_element_child");
    const listed = await listPluginItems(plugin, sessionID);
    expect(listed.items[0]?.state).toBe("awaiting_reviews");
  });

  test("valid tracked results and valid hard stops never continue the child", async () => {
    const { plugin, promptCalls } = await createWorkflowPluginHarness();

    const resultSession = "session-valid-result";
    const resultItem = await openAndLaunchImplementer(plugin, resultSession);
    await finishPluginTask(plugin, resultSession, "impl", "vv-implementer", resultItem, "DONE");
    expect((await listPluginItems(plugin, resultSession)).items[0]?.state).toBe("awaiting_reviews");

    const hardStopSession = "session-valid-hard-stop";
    const hardStopItem = await openAndLaunchImplementer(plugin, hardStopSession);
    const validHardStop = await finishPluginTask(
      plugin,
      hardStopSession,
      "impl",
      "vv-implementer",
      hardStopItem,
      "BLOCKED",
      "Valid hard stop body.",
    );
    expect(validHardStop).toContain("RESULT_HARD_STOP");

    expect(promptCalls).toHaveLength(0);
  });

  test("malformed explicit hard-stop statuses never continue the child", async () => {
    const { plugin, promptCalls } = await createWorkflowPluginHarness();
    const cases: Array<{
      sessionID: string;
      raw: (workItemId: string) => string;
      excerpt: string;
    }> = [
      {
        sessionID: "session-hard-stop-missing-blank",
        raw: (workItemId) =>
          wrapTaskResult(
            "ses_hard_stop_missing_blank",
            `VVOC_WORK_ITEM_ID: ${workItemId}\nVVOC_STATUS: BLOCKED\nNeed a product decision.`,
          ),
        excerpt: "Need a product decision.",
      },
      {
        sessionID: "session-hard-stop-preamble",
        raw: (workItemId) =>
          wrapTaskResult(
            "ses_hard_stop_preamble",
            `Preamble before the header\nVVOC_WORK_ITEM_ID: ${workItemId}\nVVOC_STATUS: NEEDS_CONTEXT\nNeed more context.`,
          ),
        excerpt: "Need more context.",
      },
      {
        sessionID: "session-hard-stop-element",
        raw: (workItemId) =>
          wrapTaskElement(
            "ses_hard_stop_element",
            `VVOC_WORK_ITEM_ID: ${workItemId}\nVVOC_STATUS: BLOCKED\nBlocked on the missing API.`,
          ),
        excerpt: "Blocked on the missing API.",
      },
    ];

    for (const testCase of cases) {
      const workItemId = await openAndLaunchImplementer(plugin, testCase.sessionID);
      const diagnostic = await finishPluginTaskWithRawOutput(
        plugin,
        testCase.sessionID,
        "impl",
        "vv-implementer",
        workItemId,
        testCase.raw(workItemId),
      );
      expect(diagnostic).toContain(testCase.excerpt);
      expect(promptCalls).toHaveLength(0);
    }
  });

  test("rejected, thrown, malformed, and empty continuations are not retried", async () => {
    const cases: Array<{ sessionID: string; entry: PromptScriptEntry; excerpt: string }> = [
      {
        sessionID: "session-continuation-rejected",
        entry: { error: "rejected continuation" },
        excerpt: "Original excerpt for rejected continuation.",
      },
      {
        sessionID: "session-continuation-thrown",
        entry: { throws: "continuation aborted" },
        excerpt: "Original excerpt for thrown continuation.",
      },
      {
        sessionID: "session-continuation-malformed",
        entry: "still malformed without a protocol header",
        excerpt: "Original excerpt for malformed continuation.",
      },
      {
        sessionID: "session-continuation-empty",
        entry: "",
        excerpt: "Original excerpt for empty continuation.",
      },
    ];

    for (const testCase of cases) {
      const { plugin, promptCalls } = await createWorkflowPluginHarness(undefined, {
        promptResponses: [testCase.entry],
      });
      const workItemId = await openAndLaunchImplementer(plugin, testCase.sessionID);
      const diagnostic = await finishPluginTaskWithRawOutput(
        plugin,
        testCase.sessionID,
        "impl",
        "vv-implementer",
        workItemId,
        wrapTaskResult(`ses_${testCase.sessionID}`, testCase.excerpt),
      );
      expect(diagnostic).toContain(testCase.excerpt);
      expect(promptCalls).toHaveLength(1);
    }
  });

  test("invalid continuation identities or statuses fail strict parsing without a second call", async () => {
    const cases: Array<{ sessionID: string; text: string }> = [
      {
        sessionID: "session-continuation-mismatch",
        text: `VVOC_WORK_ITEM_ID: wi-999\nVVOC_STATUS: DONE\nVVOC_ROUTE: change_with_review\n\nWrong item.`,
      },
      {
        sessionID: "session-continuation-bad-status",
        text: `VVOC_WORK_ITEM_ID: wi-1\nVVOC_STATUS: NONSENSE\nVVOC_ROUTE: change_with_review\n\nBad status.`,
      },
      {
        sessionID: "session-continuation-missing-route",
        text: `VVOC_WORK_ITEM_ID: wi-1\nVVOC_STATUS: DONE\n\nMissing route.`,
      },
    ];

    for (const testCase of cases) {
      const { plugin, promptCalls } = await createWorkflowPluginHarness(undefined, {
        promptResponses: [testCase.text],
      });
      const workItemId = await openAndLaunchImplementer(plugin, testCase.sessionID);
      const diagnostic = await finishPluginTaskWithRawOutput(
        plugin,
        testCase.sessionID,
        "impl",
        "vv-implementer",
        workItemId,
        wrapTaskResult(
          `ses_${testCase.sessionID}`,
          "Original progress before invalid continuation.",
        ),
      );
      expect(diagnostic).toContain("RESULT_PROTOCOL_ERROR");
      expect(promptCalls).toHaveLength(1);
    }
  });

  test("a continuation that yields a valid hard stop is handled without a second call", async () => {
    const { plugin, promptCalls } = await createWorkflowPluginHarness(undefined, {
      promptResponses: [
        `VVOC_WORK_ITEM_ID: wi-1\nVVOC_STATUS: NEEDS_CONTEXT\nVVOC_ROUTE: change_with_review\n\nNeed a product decision before continuing.`,
      ],
    });
    const sessionID = "session-protocol-continuation-hard-stop-result";
    const workItemId = await openPluginWorkItem(plugin, sessionID, "implementation", ["spec"]);
    await launchPluginTask(plugin, sessionID, "impl", "vv-implementer", workItemId);

    const hardStopDiagnostic = await finishPluginTaskWithRawOutput(
      plugin,
      sessionID,
      "impl",
      "vv-implementer",
      workItemId,
      wrapTaskResult("ses_continue_hard_stop", "plain progress without a protocol header"),
    );
    expect(hardStopDiagnostic).toContain("RESULT_HARD_STOP");

    expect(promptCalls).toHaveLength(1);
    const listed = await listPluginItems(plugin, sessionID);
    expect(listed.items[0]?.state).toBe("needs_context");
  });

  test("state application errors include parsed result excerpt", async () => {
    const { plugin } = await createWorkflowPluginHarness();
    const sessionID = "session-state-error-excerpt";
    const workItemId = await openPluginWorkItem(plugin, sessionID, "review_only", ["spec"]);

    const stateError = await finishPluginTask(
      plugin,
      sessionID,
      "spec-without-launch",
      "vv-spec-reviewer",
      workItemId,
      "PASS",
      "Parsed body should survive state rejection.",
    );
    expect(stateError).toContain("Parsed body should survive state rejection.");
    const notInFlight = await finishPluginTask(
      plugin,
      sessionID,
      "spec-without-launch-again",
      "vv-spec-reviewer",
      workItemId,
      "PASS",
      "Parsed body should survive state rejection.",
    );
    expect(notInFlight).toContain("REVIEWER_NOT_IN_FLIGHT");
  });

  test("reviewer NEEDS_CONTEXT hard stop uses needs-context reviewer excerpt", async () => {
    const { plugin } = await createWorkflowPluginHarness();
    const sessionID = "session-reviewer-needs-context-excerpt";
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
      "Need schema ownership decision before review can pass.",
    );

    const reviewerHardStop = await finishPluginTask(
      plugin,
      sessionID,
      "code",
      "vv-code-reviewer",
      workItemId,
      "PASS",
      "Code review has no additional concerns.",
    );
    expect(reviewerHardStop).toContain("Need schema ownership decision before review can pass.");

    const listed = await listPluginItems(plugin, sessionID);
    expect(listed.items[0]?.state).toBe("needs_context");
    expect(listed.items[0]?.currentRound?.results.spec?.resultExcerpt?.text).toBe(
      "Need schema ownership decision before review can pass.",
    );
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
    const normalized = (output.message.system ?? "").replace(/\s+/g, " ");
    expect(normalized).toContain("work_item_open");
    expect(normalized).toContain("Selective delegation is available but never mandatory");
    expect(normalized).toContain("bounded explore");
    expect(normalized).toContain("mechanical vv-implementer");
    expect(normalized).not.toContain("Implementation loop:");

    const deniedOutput = { message: { agent: "build", system: "base" } } as {
      message: { agent: string; system?: string };
    };
    await plugin["chat.message"]?.({} as never, deniedOutput as never);
    expect(deniedOutput.message.system).toBe("base");
  });

  test("single-session guidance exposes review-only mechanics without implementation loops", async () => {
    const { plugin } = await createWorkflowPluginHarness("single-session");
    const output = { message: { agent: "vv-controller", system: "base" } } as {
      message: { agent: string; system?: string };
    };

    await plugin["chat.message"]?.({} as never, output as never);
    const systemText = output.message.system ?? "";
    const normalized = systemText.replace(/\s+/g, " ");

    expect(normalized).toContain('mode "review_only"');
    expect(normalized).toContain("Use one review round by default");
    expect(normalized).toContain("personally validate every finding");
    expect(normalized).toContain("Reviewer FAIL is a completed finding result");
    expect(normalized).toContain("not a route to vv-implementer");
    expect(normalized).toContain("report findings and stop before fixes");
    expect(systemText).not.toContain("Implementation loop:");
    expect(systemText).not.toContain("Selective delegation");
  });

  test("orchestrated guidance preserves the full tracked protocol source", async () => {
    const { plugin } = await createWorkflowPluginHarness("orchestrated");
    const output = { message: { agent: "vv-controller", system: "base" } } as {
      message: { agent: string; system?: string };
    };

    await plugin["chat.message"]?.({} as never, output as never);
    const systemText = output.message.system ?? "";

    expect(systemText).toContain("For tracked subagents");
    expect(systemText).toContain("Implementation loop:");
    expect(systemText).toContain("requiredReviewers");
    expect(systemText).toContain("do not route review-only failures to `vv-implementer`");
    expect(systemText).not.toContain("Selective delegation is available");
  });

  test("a bound family keeps its captured profile while new work sees the changed policy", async () => {
    resetVvocConfigForTests();
    const captured = createDefaultVvocConfig();
    captured.orchestration = { profile: "orchestrated" };
    const { plugin } = await createWorkflowPluginHarness("single-session", {
      captures: { "session-bound": { vvoc: captured } },
    });

    const bound = {
      message: { agent: "vv-controller", sessionID: "session-bound", system: "base" },
    } as {
      message: { agent: string; sessionID: string; system?: string };
    };
    await plugin["chat.message"]?.({} as never, bound as never);
    expect(bound.message.system).toContain("Implementation loop:");

    // An unbound session resolves the current effective config, not the capture.
    const fresh = {
      message: { agent: "vv-controller", sessionID: "session-new", system: "base" },
    } as {
      message: { agent: string; sessionID: string; system?: string };
    };
    await plugin["chat.message"]?.({} as never, fresh as never);
    expect(fresh.message.system).not.toContain("Implementation loop:");
    expect(fresh.message.system).toContain("review_only");
  });

  test("a family with the workflow toggle disabled hides tools, guidance, and denies execution", async () => {
    resetVvocConfigForTests();
    const disabled = createDefaultVvocConfig();
    disabled.plugins = { ...disabled.plugins, workflow: false };
    const { plugin } = await createWorkflowPluginHarness("single-session", {
      captures: { "session-disabled": { vvoc: disabled } },
    });

    const output = {
      message: { agent: "vv-controller", sessionID: "session-disabled", system: "base" },
    } as {
      message: { agent: string; sessionID: string; system?: string };
      tools?: Record<string, unknown>;
    };
    await plugin["chat.message"]?.({} as never, output as never);
    expect(output.message.system).toBe("base");
    expect(output.tools?.work_item_open).toBeUndefined();
    expect(output.tools?.work_checkpoint).toBeUndefined();

    await expect(
      plugin.tool?.work_item_list?.execute(
        { includeClosed: false },
        createToolContext("session-disabled") as never,
      ),
    ).rejects.toThrow("FAMILY_DISABLED");
  });

  test("every orchestration profile exposes the shared tracked result protocol guidance", async () => {
    for (const profile of ["single-session", "balanced", "orchestrated", "delegated"] as const) {
      resetVvocConfigForTests();
      const { plugin } = await createWorkflowPluginHarness(profile);
      const output = { message: { agent: "vv-controller", system: "base" } } as {
        message: { agent: string; system?: string };
      };

      await plugin["chat.message"]?.({} as never, output as never);
      const normalized = (output.message.system ?? "").replace(/\s+/g, " ");

      expect(normalized).toContain("VVOC_WORK_ITEM_ID");
      expect(normalized).toContain("work-item mismatch");
      expect(normalized).toContain("no preface");
      expect(normalized).toContain("blank line and the body");
      expect(normalized).toContain("work_item_list");
      expect(normalized).toContain("contract.referencePath");
      for (const status of [
        "DONE",
        "DONE_WITH_CONCERNS",
        "NEEDS_CONTEXT",
        "BLOCKED",
        "PASS",
        "FAIL",
      ]) {
        expect(normalized).toContain(status);
      }
    }
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

  test("snapshot and hydrate preserve optional result excerpts", () => {
    const store = createWorkItemStore();
    const opened = openWorkItem(store, {
      sessionId: PERSIST_SESSION_ID,
      key: "review-excerpt",
      title: "Review Excerpt",
      mode: "review_only",
      requiredReviewers: ["spec"],
    });
    expect(opened.ok).toBe(true);
    expect(
      beginTrackedLaunch(store, {
        sessionId: PERSIST_SESSION_ID,
        workItemId: "wi-1",
        agent: "vv-spec-reviewer",
      }).ok,
    ).toBe(true);
    const excerpt = createWorkflowResultExcerpt({
      text: "Need persisted recovery context.",
      source: "parsed_body",
    });
    const applied = applyTrackedResult(store, {
      sessionId: PERSIST_SESSION_ID,
      workItemId: "wi-1",
      result: result("vv-spec-reviewer", "NEEDS_CONTEXT"),
      resultExcerpt: excerpt,
    });
    expect(applied.ok).toBe(true);

    snapshotWorkflowState(PERSIST_SESSION_ID, store.getStoreData());
    const hydrated = hydrateWorkflowState(PERSIST_SESSION_ID);
    expect(hydrated).not.toBeNull();
    const hydratedStore = createWorkItemStore(hydrated);
    const records = listWorkItems(hydratedStore, PERSIST_SESSION_ID);
    expect(records[0]?.currentRound?.results.spec?.resultExcerpt?.text).toBe(
      "Need persisted recovery context.",
    );
  });

  test("hydrate rejects corrupt persisted excerpt metadata", () => {
    const store = createWorkItemStore();
    const opened = openWorkItem(store, {
      sessionId: PERSIST_SESSION_ID,
      key: "corrupt-excerpt",
      title: "Corrupt Excerpt",
      mode: "implementation",
      requiredReviewers: ["spec"],
    });
    expect(opened.ok).toBe(true);
    expect(
      beginTrackedLaunch(store, {
        sessionId: PERSIST_SESSION_ID,
        workItemId: "wi-1",
        agent: "vv-implementer",
      }).ok,
    ).toBe(true);
    const excerpt = createWorkflowResultExcerpt({
      text: "Valid before corruption.",
      source: "parsed_body",
    });
    const applied = applyTrackedResult(store, {
      sessionId: PERSIST_SESSION_ID,
      workItemId: "wi-1",
      result: result("vv-implementer", "BLOCKED"),
      resultExcerpt: excerpt,
    });
    expect(applied.ok).toBe(true);

    snapshotWorkflowState(PERSIST_SESSION_ID, store.getStoreData());
    const statePath = join(getWorkflowSessionDir(PERSIST_SESSION_ID), "workflow-state.json");
    const persisted = JSON.parse(readFileSync(statePath, "utf-8"));
    persisted.records[0].resultExcerpt.originalLength = 999;
    writeFileSync(statePath, JSON.stringify(persisted, null, 2), "utf-8");

    expect(hydrateWorkflowState(PERSIST_SESSION_ID)).toBeNull();
  });

  test("hydrate rejects incomplete records that omit explicit intent", () => {
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
              key: "incomplete",
              title: "Incomplete",
              state: "open",
              specReviewCount: 0,
              codeReviewCount: 0,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
          keyIndex: { incomplete: "wi-1" },
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
    resultExcerpt?: {
      source: string;
      text: string;
      truncated: boolean;
    };
    currentRound?: {
      inFlightReviewers: string[];
      results: {
        spec?: { status: string; resultExcerpt?: { text: string } };
        code?: { status: string; resultExcerpt?: { text: string } };
      };
    };
  }>;
};

async function openPluginWorkItem(
  plugin: NativeWorkflowHarnessPlugin,
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
  plugin: NativeWorkflowHarnessPlugin,
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

async function openAndLaunchImplementer(
  plugin: NativeWorkflowHarnessPlugin,
  sessionID: string,
): Promise<string> {
  const workItemId = await openPluginWorkItem(plugin, sessionID, "implementation", ["spec"]);
  await launchPluginTask(plugin, sessionID, "impl", "vv-implementer", workItemId);
  return workItemId;
}

async function finishPluginTask(
  plugin: NativeWorkflowHarnessPlugin,
  sessionID: string,
  callPrefix: string,
  subagentType: "vv-implementer" | "vv-spec-reviewer" | "vv-code-reviewer",
  workItemId: string,
  status: ParsedResultBlock["status"],
  body = "Done.",
): Promise<string> {
  const route = subagentType === "vv-implementer" ? "\nVVOC_ROUTE: change_with_review" : "";
  return finishPluginTaskWithRawOutput(
    plugin,
    sessionID,
    callPrefix,
    subagentType,
    workItemId,
    `VVOC_WORK_ITEM_ID: ${workItemId}\nVVOC_STATUS: ${status}${route}\n\n${body}`,
  );
}

async function finishPluginTaskWithRawOutput(
  plugin: NativeWorkflowHarnessPlugin,
  sessionID: string,
  callPrefix: string,
  subagentType: "vv-implementer" | "vv-spec-reviewer" | "vv-code-reviewer",
  workItemId: string,
  output: string,
): Promise<string> {
  const sink = {
    title: "task",
    output: output as unknown,
    metadata: {} as unknown,
  };
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
    sink as never,
  );
  const final = sink.output;
  if (typeof final === "string") return final;
  if (final && typeof final === "object" && "output" in final) {
    const inner = (final as { output?: unknown }).output;
    if (typeof inner === "string") return inner;
  }
  return "";
}

async function listPluginItems(
  plugin: NativeWorkflowHarnessPlugin,
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

function parseToolJson<T>(value: unknown): T {
  const text =
    typeof value === "string"
      ? value
      : value &&
          typeof value === "object" &&
          typeof (value as { output?: unknown }).output === "string"
        ? (value as { output: string }).output
        : "{}";
  return JSON.parse(text) as T;
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

function wrapTaskElement(taskId: string, innerResult: string): string {
  return [
    `<task id="${taskId}" state="completed">`,
    "",
    "<task_result>",
    innerResult,
    "</task_result>",
    "</task>",
  ].join("\n");
}

// START_BLOCK_NATIVE_REPAIR_FIXTURE
type NativeRepairCall = { sessionID: string; text: string };

type NativeRepairDouble = {
  client: {
    session: {
      prompt: (input: NativeRepairCall) => Promise<unknown>;
      wait: (input: { sessionID: string }) => Promise<void>;
    };
    message: {
      list: (input: {
        sessionID: string;
        order?: "asc" | "desc";
        limit?: number;
        type?: string;
      }) => Promise<unknown>;
    };
  };
  calls: NativeRepairCall[];
  getRules: () => PermissionRule[];
};

/** Native session surface keys exposed to the repair boundary. */
function hostMutationSurface(sessionKeys: object): string[] {
  return Object.keys(sessionKeys).sort();
}

/**
 * Native double for one same-child continuation: it records the native prompt,
 * optionally appends the corrected assistant message the continuation retrieves
 * (created at/after the accepted prompt), and exposes only prompt/wait plus the
 * full-client message list so a test can prove no child creation is reachable.
 */
function createNativeRepairDouble(options: {
  rules: PermissionRule[];
  promptResult?: (
    input: NativeRepairCall,
  ) => { text?: string; error?: string } | { throws: string } | undefined;
  acceptedCreated?: number;
  listInvalid?: boolean;
  existingMessages?: unknown[];
}): NativeRepairDouble {
  const rules = options.rules.map((rule) => ({ ...rule }));
  const calls: NativeRepairCall[] = [];
  const childMessages = new Map<string, unknown[]>();
  let messageCounter = 0;
  const acceptedCreated = options.acceptedCreated ?? Date.now();
  return {
    client: {
      session: {
        prompt: async (input: NativeRepairCall): Promise<unknown> => {
          calls.push(input);
          const outcome = options.promptResult?.(input);
          if (outcome && "throws" in outcome) throw new Error(outcome.throws);
          if (outcome && "text" in outcome && outcome.text !== undefined) {
            messageCounter += 1;
            childMessages.set(input.sessionID, [
              ...(childMessages.get(input.sessionID) ?? []),
              {
                id: `msg_cont_${messageCounter}`,
                type: "assistant",
                content: [{ type: "text", text: outcome.text }],
                ...(outcome.error === undefined
                  ? {}
                  : { error: { type: "aborted", message: outcome.error } }),
                time: { created: acceptedCreated + 1, completed: acceptedCreated + 2 },
              },
            ]);
          }
          return {
            id: `msg_prompt_${input.sessionID}`,
            sessionID: input.sessionID,
            time: { created: acceptedCreated },
          };
        },
        wait: async () => undefined,
      },
      message: {
        list: async (input: {
          sessionID: string;
          order?: "asc" | "desc";
          limit?: number;
          type?: string;
        }) => {
          if (options.listInvalid === true) return undefined;
          let data = [
            ...(options.existingMessages ?? []),
            ...(childMessages.get(input.sessionID) ?? []),
          ];
          if (input.type !== undefined) {
            data = data.filter((message) => (message as { type?: unknown }).type === input.type);
          }
          return { data, cursor: {} };
        },
      },
    },
    calls,
    getRules: () => rules.map((rule) => ({ ...rule })),
  };
}
// END_BLOCK_NATIVE_REPAIR_FIXTURE

// START_BLOCK_REAL_HOST_WORKFLOW_SMOKE
/**
 * Optional isolated real-host workflow smoke. Runs only when VVOC_E2E_V2_HOST
 * points at the pinned OpenCode 2.0.18 binary; otherwise it is skipped. It loads
 * the ACTUAL built WorkflowPlugin on the pinned host, drives real tool execution
 * through a loopback provider, and asserts the results the provider received.
 *
 * Isolation, owned scratch/processes, allow-listed env, free ports, the loopback
 * guard, service registration wait and the authenticated bounded HTTP client are
 * reused READ-ONLY from scripts/e2e-v2/host.ts via a runtime dynamic import, so
 * the in-scope test never duplicates (or weakens) that safety surface.
 */
const REAL_WORKFLOW_HOST = process.env.VVOC_E2E_V2_HOST;
const workflowSmokeDescribe = REAL_WORKFLOW_HOST ? describe : describe.skip;

type E2eHostModule = {
  createOwnedScratch(base: string): Promise<{ dir: string; base: string; markerPath: string }>;
  removeOwnedScratch(scratch: unknown): Promise<void>;
  waitForRegisteredService(input: { servicePath: string; timeoutMs?: number }): Promise<string>;
  createNativeApi(input: {
    baseUrl: string;
    password: string;
    directory: string;
    timeoutMs?: number;
  }): (
    path: string,
    init?: RequestInit,
  ) => Promise<{ status: number; body: unknown; text: string }>;
  assertLoopbackHttpUrl(raw: string, label?: string): URL;
  buildHostEnv(
    base: Record<string, string>,
    extra?: Record<string, string | undefined>,
  ): Record<string, string>;
  OwnedProcesses: new () => {
    spawn(
      command: string,
      args: readonly string[],
      options?: { cwd?: string; env?: Record<string, string> },
    ): unknown;
    stopAll(signal?: NodeJS.Signals, timeoutMs?: number): Promise<void>;
  };
};

let e2eHostPromise: Promise<E2eHostModule> | undefined;
const loadE2eHost = (): Promise<E2eHostModule> =>
  (e2eHostPromise ??= import(
    new URL("../../scripts/e2e-v2/host.ts", import.meta.url).href
  ) as Promise<E2eHostModule>);

async function getFreePort(): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolvePromise(port));
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

workflowSmokeDescribe("real OpenCode 2.0.18 workflow smoke (actual built plugin)", () => {
  type Started = {
    api: (
      path: string,
      init?: RequestInit,
    ) => Promise<{ status: number; body: unknown; text: string }>;
    sessionID: string;
    promptAt: number;
    providerTrace: string;
    project: string;
    stop: () => Promise<void>;
  };

  async function startWorkflowHost(options: {
    providerScript: (port: number, tracePath: string) => string;
    promptText: string;
  }): Promise<Started> {
    const helpers = await loadE2eHost();
    const scratch = await helpers.createOwnedScratch(
      process.env.VVOC_E2E_SCRATCH ?? "/tmp/opencode",
    );
    const root = scratch.dir;
    for (const sub of [
      "project",
      "project/.vvoc",
      "trace",
      "home",
      "cfg",
      "data",
      "state",
      "cache",
      "plugin",
    ]) {
      mkdirSync(join(root, sub), { recursive: true });
    }
    const procs = new helpers.OwnedProcesses();
    const providerPort = await getFreePort();
    const hostPort = await getFreePort();
    const providerTrace = join(root, "trace", "provider.jsonl");
    const hostLog = join(root, "trace", "host.log");
    const providerOrigin = `http://127.0.0.1:${providerPort}`;
    helpers.assertLoopbackHttpUrl(providerOrigin, "smoke provider origin");
    const env = helpers.buildHostEnv(process.env as Record<string, string>, {
      PATH: process.env.PATH,
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: join(root, "cfg"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_CACHE_HOME: join(root, "cache"),
      LOOPBACK_API_KEY: "smoke-key",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
    });
    const distPlugin = join(import.meta.dir, "..", "..", "dist", "plugins", "workflow", "index.js");
    const project = join(root, "project");

    let stopped = false;
    const stop = async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      await procs.stopAll();
      await helpers.removeOwnedScratch(scratch);
    };

    try {
      writeFileSync(
        join(root, "provider.ts"),
        options.providerScript(providerPort, providerTrace),
        "utf8",
      );
      procs.spawn(process.execPath, [join(root, "provider.ts")], { env });
      // The provider must be positively listening before the host dispatches to it.
      let listening = false;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          await fetch(providerOrigin, { method: "HEAD", signal: AbortSignal.timeout(500) });
          listening = true;
          break;
        } catch {
          await sleep(100);
        }
      }
      if (!listening) throw new Error("loopback provider did not start listening");

      writeFileSync(
        join(root, "plugin", "package.json"),
        JSON.stringify({ name: "vvoc-workflow-smoke-plugin", private: true, version: "0.0.0" }),
        "utf8",
      );
      writeFileSync(
        join(root, "plugin", "index.ts"),
        `import p from ${JSON.stringify(distPlugin)};\nexport default p;\n`,
        "utf8",
      );
      writeFileSync(
        join(project, "opencode.json"),
        JSON.stringify({
          model: "loopback/seam-smart",
          default_agent: "vv-controller",
          agents: {
            "vv-controller": {
              model: "loopback/seam-smart",
              mode: "primary",
              permissions: [{ action: "*", resource: "*", effect: "allow" }],
            },
            "vv-implementer": {
              model: "loopback/seam-smart",
              mode: "subagent",
              permissions: [{ action: "*", resource: "*", effect: "allow" }],
            },
          },
          providers: {
            loopback: {
              name: "Smoke Loopback",
              package: "@opencode/ai/providers/openai-compatible",
              env: ["LOOPBACK_API_KEY"],
              settings: { baseURL: `${providerOrigin}/v1`, provider: "loopback" },
              models: { "seam-smart": { name: "Smoke Smart" } },
            },
          },
          plugins: [{ package: join(root, "plugin") }],
        }),
        "utf8",
      );
      const vvocConfig = createDefaultVvocConfig();
      vvocConfig.orchestration = { profile: "orchestrated" };
      writeFileSync(join(project, ".vvoc", "vvoc.json"), renderVvocConfig(vvocConfig), "utf8");

      procs.spawn(
        REAL_WORKFLOW_HOST as string,
        [
          "serve",
          "--service",
          "--hostname",
          "127.0.0.1",
          "--port",
          String(hostPort),
          "--log-level",
          "error",
        ],
        { env },
      );
      const servicePath = join(root, "state", "opencode", "service.json");
      const password = await helpers.waitForRegisteredService({ servicePath, timeoutMs: 30_000 });
      const api = helpers.createNativeApi({
        baseUrl: `http://127.0.0.1:${hostPort}`,
        password,
        directory: project,
      });

      // Service registration is NOT final app/agent/model readiness for this
      // location. Wait until the real app answers and the required agent and
      // model are registered for THIS directory before creating a session.
      let agentReady = false;
      let modelReady = false;
      const readyDeadline = Date.now() + 45_000;
      for (;;) {
        if (!agentReady) {
          const agents = await api("/api/agent").catch(() => undefined);
          agentReady = agents?.status === 200 && agents.text.includes("vv-controller");
        }
        if (!modelReady) {
          const models = await api("/api/model").catch(() => undefined);
          modelReady = models?.status === 200 && models.text.includes("seam-smart");
        }
        if (agentReady && modelReady) break;
        if (Date.now() > readyDeadline) {
          throw new Error(
            `host app/agent/model registry not ready (agent=${agentReady} model=${modelReady})`,
          );
        }
        await sleep(250);
      }

      const created = await api("/api/session", {
        method: "POST",
        body: JSON.stringify({ location: { directory: project }, agent: "vv-controller" }),
      });
      if (created.status >= 400) {
        throw new Error(`session create failed: ${created.status} ${created.text.slice(0, 400)}`);
      }
      const createdID =
        typeof created.body === "object" && created.body !== null
          ? (created.body as { data?: { id?: unknown } }).data?.id
          : undefined;
      if (typeof createdID !== "string") {
        throw new Error(
          `session create returned no id: ${created.status} ${created.text.slice(0, 400)}`,
        );
      }
      const promptAt = Date.now();
      const prompted = await api(`/api/session/${createdID}/prompt`, {
        method: "POST",
        body: JSON.stringify({ text: options.promptText }),
      });
      if (prompted.status >= 400) {
        throw new Error(`session prompt failed: ${prompted.status} ${prompted.text.slice(0, 400)}`);
      }

      // Actual changed terminal evidence: a NEW idle message created at/after the
      // accepted prompt, never a stale idle timestamp or a timeout fallthrough.
      const terminalDeadline = Date.now() + 90_000;
      for (;;) {
        const context = await api(`/api/session/${createdID}/context`).catch(() => undefined);
        const data =
          context && typeof context.body === "object" && context.body !== null
            ? (context.body as { data?: unknown }).data
            : undefined;
        const reached = Array.isArray(data)
          ? data.some(
              (message) =>
                typeof message === "object" &&
                message !== null &&
                (message as { type?: unknown }).type === "idle" &&
                typeof (message as { time?: { created?: unknown } }).time?.created === "number" &&
                ((message as { time: { created: number } }).time.created as number) >= promptAt,
            )
          : false;
        if (reached) break;
        if (Date.now() > terminalDeadline) {
          throw new Error(`session ${createdID} did not reach a fresh terminal state`);
        }
        await sleep(400);
      }
      void hostLog;

      return {
        api,
        sessionID: createdID,
        promptAt,
        providerTrace,
        project,
        stop,
      };
    } catch (error) {
      await stop();
      throw error;
    }
  }

  function providerTraceLines(tracePath: string): Array<{
    event?: string;
    kind?: string;
    tools?: string[];
    messages?: unknown;
    stream?: boolean;
  }> {
    return readFileSync(tracePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parsed = JSON.parse(line) as {
          event?: string;
          kind?: string;
          tools?: string[];
          messages?: unknown;
          stream?: boolean;
        };
        return { ...parsed, tools: parsed.tools ?? [], messages: parsed.messages ?? [] };
      });
  }

  test("registers the workflow tools and executes work_item_open/list through the real host", async () => {
    const started = await startWorkflowHost({
      providerScript: (port, tracePath) =>
        `import { appendFileSync, mkdirSync } from "node:fs";\n` +
        `import { dirname } from "node:path";\n` +
        `const trace = ${JSON.stringify(tracePath)};\n` +
        `const stamp = (r) => { mkdirSync(dirname(trace), { recursive: true }); appendFileSync(trace, JSON.stringify({ at: Date.now(), ...r }) + "\\n"); };\n` +
        `const chunk = (model, delta, finish) => "data: " + JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }] }) + "\\n\\n";\n` +
        `const sseText = (model, text) => chunk(model, { role: "assistant" }, null) + chunk(model, { content: text }, null) + chunk(model, {}, "stop") + "data: [DONE]\\n\\n";\n` +
        `const sseTool = (model, name, args) => chunk(model, { role: "assistant", tool_calls: [{ index: 0, id: "call_" + name, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, null) + chunk(model, {}, "tool_calls") + "data: [DONE]\\n\\n";\n` +
        `const respond = (body, model, plan) => body?.stream ? new Response(plan.sse, { headers: { "content-type": "text/event-stream" } }) : Response.json({ id: "c", object: "chat.completion", created: 1, model, choices: [{ index: 0, message: plan.message, finish_reason: plan.finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });\n` +
        `const textPlan = (model, text) => ({ sse: sseText(model, text), message: { role: "assistant", content: text }, finish: "stop" });\n` +
        `const toolPlan = (model, name, args) => ({ sse: sseTool(model, name, args), message: { role: "assistant", tool_calls: [{ id: "call_" + name, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish: "tool_calls" });\n` +
        `Bun.serve({ hostname: "127.0.0.1", port: ${port}, async fetch(request) {\n` +
        `  const body = await request.clone().json().catch(() => ({}));\n` +
        `  const model = body?.model ?? "unknown";\n` +
        `  const calls = (body?.messages ?? []).filter((m) => m?.role === "assistant" && Array.isArray(m.tool_calls)).length;\n` +
        `  stamp({ event: "provider.request", stream: body?.stream, tools: (body?.tools ?? []).map((t) => t?.function?.name), messages: body?.messages });\n` +
        `  if (calls === 0) return respond(body, model, toolPlan(model, "work_item_open", { items: [{ key: "k", title: "Smoke Item", mode: "delegated", requiredReviewers: [], writeScope: ["src/a.ts"] }] }));\n` +
        `  if (calls === 1) return respond(body, model, toolPlan(model, "work_item_list", { includeClosed: true }));\n` +
        `  return respond(body, model, textPlan(model, "smoke-done"));\n` +
        `} });\n`,
      promptText: "open then list the work item",
    });
    try {
      const requests = providerTraceLines(started.providerTrace).filter(
        (line) => line.event === "provider.request",
      );
      expect(requests.length).toBeGreaterThan(0);
      const offered = new Set(requests.flatMap((request) => request.tools ?? []));
      expect(offered.has("work_item_open")).toBe(true);
      expect(offered.has("work_item_list")).toBe(true);
      const openResult = requests.find((line) =>
        JSON.stringify(line.messages).includes("workItemId"),
      );
      expect(openResult).toBeTruthy();
      const openText = JSON.stringify(openResult?.messages);
      expect(openText).toContain("workItemId");
      expect(openText).toContain("Smoke Item");
      const listResult = requests.find(
        (line) =>
          JSON.stringify(line.messages).includes("work_item_list") &&
          JSON.stringify(line.messages).includes("includeClosed"),
      );
      expect(listResult).toBeTruthy();
    } finally {
      await started.stop();
    }
  }, 180000);

  test("runs a tracked delegated launch, one same-child continuation, and settles awaiting_acceptance", async () => {
    const started = await startWorkflowHost({
      providerScript: (port, tracePath) =>
        `import { appendFileSync, mkdirSync } from "node:fs";\n` +
        `import { dirname } from "node:path";\n` +
        `const trace = ${JSON.stringify(tracePath)};\n` +
        `const stamp = (r) => { mkdirSync(dirname(trace), { recursive: true }); appendFileSync(trace, JSON.stringify({ at: Date.now(), ...r }) + "\\n"); };\n` +
        `const chunk = (model, delta, finish) => "data: " + JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }] }) + "\\n\\n";\n` +
        `const sseText = (model, text) => chunk(model, { role: "assistant" }, null) + chunk(model, { content: text }, null) + chunk(model, {}, "stop") + "data: [DONE]\\n\\n";\n` +
        `const sseTool = (model, name, args) => chunk(model, { role: "assistant", tool_calls: [{ index: 0, id: "call_" + name, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, null) + chunk(model, {}, "tool_calls") + "data: [DONE]\\n\\n";\n` +
        `const respond = (body, model, plan) => body?.stream ? new Response(plan.sse, { headers: { "content-type": "text/event-stream" } }) : Response.json({ id: "c", object: "chat.completion", created: 1, model, choices: [{ index: 0, message: plan.message, finish_reason: plan.finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });\n` +
        `const textPlan = (model, text) => ({ sse: sseText(model, text), message: { role: "assistant", content: text }, finish: "stop" });\n` +
        `const toolPlan = (model, name, args) => ({ sse: sseTool(model, name, args), message: { role: "assistant", tool_calls: [{ id: "call_" + name, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish: "tool_calls" });\n` +
        `const hasTool = (messages, name) => messages.some((m) => m?.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.some((t) => t?.function?.name === name));\n` +
        `const assistantTexts = (messages) => messages.filter((m) => m?.role === "assistant" && !Array.isArray(m.tool_calls));\n` +
        `const systemText = (messages) => { const sys = messages.find((m) => m?.role === "system"); return typeof sys?.content === "string" ? sys.content : ""; };\n` +
        `const firstMatch = (messages, re) => { const m = re.exec(JSON.stringify(messages)); return m ? m[1] : undefined; };\n` +
        `Bun.serve({ hostname: "127.0.0.1", port: ${port}, async fetch(request) {\n` +
        `  const body = await request.clone().json().catch(() => ({}));\n` +
        `  const model = body?.model ?? "unknown";\n` +
        `  const messages = body?.messages ?? [];\n` +
        `  const sys = systemText(messages);\n` +
        `  const kind = sys.includes("<workflow_protocol>") ? "root" : JSON.stringify(messages).includes("You are a subagent spawned by another session") ? "child" : "other";\n` +
        `  stamp({ event: "provider.request", kind, model, messages });\n` +
        `  if (kind === "root") {\n` +
        `    if (!hasTool(messages, "work_item_open")) return respond(body, model, toolPlan(model, "work_item_open", { items: [{ key: "k", title: "Smoke Task", mode: "delegated", requiredReviewers: [], writeScope: ["src/a.ts"] }] }));\n` +
        `    if (!hasTool(messages, "subagent")) {\n` +
        `      const id = firstMatch(messages, /VVOC_WORK_ITEM_ID: (wi-[0-9]+)/);\n` +
        `      return respond(body, model, toolPlan(model, "subagent", { agent: "vv-implementer", description: "Smoke child", prompt: "VVOC_WORK_ITEM_ID: " + id + "\\n<assignment>Report the smoke task.</assignment>" }));\n` +
        `    }\n` +
        `    if (!hasTool(messages, "work_item_list")) return respond(body, model, toolPlan(model, "work_item_list", { includeClosed: false }));\n` +
        `    return respond(body, model, textPlan(model, "root-done"));\n` +
        `  }\n` +
        `  if (kind === "child") {\n` +
        `    if (assistantTexts(messages).length === 0) return respond(body, model, textPlan(model, "I have started the smoke task but have not finished it."));\n` +
        `    const id = firstMatch(messages, /VVOC_WORK_ITEM_ID: ([A-Za-z0-9_-]+)/);\n` +
        `    return respond(body, model, textPlan(model, "VVOC_WORK_ITEM_ID: " + id + "\\nVVOC_STATUS: DONE\\nVVOC_ROUTE: change_with_review\\n\\nChild finished.\\n"));\n` +
        `  }\n` +
        `  return respond(body, model, textPlan(model, "title"));\n` +
        `} });\n`,
      promptText: "open, launch the tracked child, then list",
    });
    try {
      const lines = providerTraceLines(started.providerTrace);
      const childRequests = lines.filter(
        (line) => line.event === "provider.request" && line.kind === "child",
      );
      expect(childRequests.length).toBeGreaterThanOrEqual(2);
      const childSessionIDs = new Set(
        childRequests.flatMap((line) => {
          const match = /<env>[\s\S]*?Current conversation session ID: (ses_[A-Za-z0-9]+)/.exec(
            JSON.stringify(line.messages),
          );
          return match ? [match[1]] : [];
        }),
      );
      expect(childSessionIDs.size).toBe(1);
      const childID = [...childSessionIDs][0];
      expect(childID).toBeDefined();
      const rootRequests = lines.filter(
        (line) => line.event === "provider.request" && line.kind === "root",
      );
      const listRequest = rootRequests.find((line) =>
        JSON.stringify(line.messages).includes("awaiting_acceptance"),
      );
      expect(listRequest).toBeTruthy();
      const listText = JSON.stringify(listRequest?.messages).replace(/\\"/g, '"');
      expect(listText).toContain('"attempts": 1');
      expect(listText).toContain('"accepted": false');
      expect(listText).toContain('"resultStatus": "DONE"');
      const subagentRoot = rootRequests.find((line) =>
        JSON.stringify(line.messages).includes("<subagent sessionID="),
      );
      expect(JSON.stringify(subagentRoot?.messages)).toContain(childID as string);
    } finally {
      await started.stop();
    }
  }, 240000);
});
// END_BLOCK_REAL_HOST_WORKFLOW_SMOKE
