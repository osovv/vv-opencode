// FILE: src/plugins/workflow.test.ts
// VERSION: 0.4.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify workflow core modules and WorkflowPlugin integration behavior.
//   SCOPE: Protocol parsing, result excerpts, bounded continuation guidance and host-permission preservation, explicit work-item contracts, mode-aware launch validation, review aggregation, profile-compatible guidance, persistence, and primary-only tooling.
//   DEPENDS: [bun:test, node:fs, node:path, @opencode-ai/sdk, @opencode-ai/sdk/v2/types, src/lib/config-layers.ts, src/lib/orchestration.ts, src/lib/vvoc-config.ts, src/plugins/workflow/protocol.ts, src/plugins/workflow/repair.ts, src/plugins/workflow/state.ts, src/plugins/workflow/transitions.ts, src/plugins/workflow/tooling.ts, src/plugins/workflow/index.ts, src/plugins/workflow/persistence.ts]
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
//   LAST_CHANGE: [direct fix bounded result continuation - Added SDK-derived prompt/permission fixtures and coverage that the truthful-status continuation prompt, a later ordinary child prompt, and explicit malformed hard-stop suppression all preserve persistent permissions without session mutations.]
// END_CHANGE_SUMMARY

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AssistantMessage,
  OpencodeClient,
  SessionPromptErrors,
  SessionPromptResponses,
  TextPart,
} from "@opencode-ai/sdk";
import type { PermissionRule } from "@opencode-ai/sdk/v2/types";
import { resetVvocConfigForTests } from "../lib/config-layers.js";
import type { OrchestrationProfile } from "../lib/orchestration.js";
import { createDefaultVvocConfig, renderVvocConfig } from "../lib/vvoc-config.js";
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
import {
  attemptTrackedResultRepair,
  buildTrackedResultRepairPrompt,
  hasExplicitHardStopStatus,
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

  test("host permission double replaces persistent rules when prompt tools is nonempty", async () => {
    const host = createHostPermissionDouble({
      rules: [
        { permission: "edit", action: "ask", pattern: "src/**" },
        { permission: "bash", action: "deny", pattern: "*" },
      ],
    });

    await host.client.session.prompt({
      path: { id: "ses_old_defect" },
      body: {
        tools: { edit: false, write: false },
        parts: [{ type: "text", text: "Old defect probe." }],
      },
    });

    expect(host.getRules()).toEqual([
      { permission: "edit", action: "deny", pattern: "*" },
      { permission: "write", action: "deny", pattern: "*" },
    ]);
  });

  test("continuation and a later ordinary child prompt preserve persistent permissions", async () => {
    const persistentRules: PermissionRule[] = [
      { permission: "edit", action: "ask", pattern: "src/plugins/**" },
      { permission: "bash", action: "deny", pattern: "rm *" },
      { permission: "read", action: "allow", pattern: "*" },
      { permission: "webfetch", action: "allow", pattern: "*" },
      { permission: "work_item_decide", action: "deny", pattern: "*" },
    ];
    const host = createHostPermissionDouble({
      rules: persistentRules,
      promptResult: () => ({
        data: sessionPromptResponse(
          "ses_same_child",
          `VVOC_WORK_ITEM_ID: wi-1\nVVOC_STATUS: DONE\nVVOC_ROUTE: change_with_review\n\nFinished the original task.`,
        ),
      }),
    });

    const repairOptions = {
      client: host.client as never,
      directory: "/tmp/project",
      taskId: "ses_same_child",
      agent: "vv-implementer" as const,
      workItemId: "wi-1",
      malformedOutput: "I have started implementing; tests are next.",
      parseErrorCode: "UNEXPECTED_TOP_BLOCK_LINE" as const,
      parseErrorMessage: "UNEXPECTED_TOP_BLOCK_LINE: strict top block contains a non-protocol line",
    };

    expect(host.getRules()).toEqual(persistentRules);

    const continued = await attemptTrackedResultRepair(repairOptions);
    expect(continued).toContain("VVOC_STATUS: DONE");
    const continuationCall = host.calls[0];
    expect(continuationCall?.path.id).toBe("ses_same_child");
    expect(continuationCall?.body?.agent).toBe("vv-implementer");
    expect(continuationCall?.body?.tools).toBeUndefined();
    expect(continuationCall?.body !== undefined && "tools" in continuationCall.body).toBe(false);
    expect(host.getRules()).toEqual(persistentRules);

    // A later ORDINARY prompt to the same child carries a normal work prompt
    // with no repair system instruction and no tools override.
    await host.client.session.prompt({
      path: { id: "ses_same_child" },
      body: {
        agent: "vv-implementer",
        parts: [{ type: "text", text: "Continue the original assignment." }],
      },
    });
    const ordinaryCall = host.calls[1];
    expect(ordinaryCall?.path.id).toBe("ses_same_child");
    expect(ordinaryCall?.body?.agent).toBe("vv-implementer");
    expect(ordinaryCall?.body?.system).toBeUndefined();
    expect(ordinaryCall?.body?.tools).toBeUndefined();
    expect(ordinaryCall?.body !== undefined && "tools" in ordinaryCall.body).toBe(false);

    expect(host.calls).toHaveLength(2);
    expect(host.getRules()).toEqual(persistentRules);
    // Normal repository permissions remain available and inherited deny rules stay effective.
    expect(host.getRules()).toContainEqual({ permission: "read", action: "allow", pattern: "*" });
    expect(host.getRules()).toContainEqual({
      permission: "edit",
      action: "ask",
      pattern: "src/plugins/**",
    });
    expect(host.getRules()).toContainEqual({
      permission: "work_item_decide",
      action: "deny",
      pattern: "*",
    });
    expect(host.mutationCalls).toEqual({ create: 0, fork: 0, update: 0, restore: 0 });
  });

  test("continuation failures do not mutate persistent permissions", async () => {
    const persistentRules: PermissionRule[] = [
      { permission: "edit", action: "allow", pattern: "src/**" },
      { permission: "bash", action: "ask", pattern: "*" },
    ];
    const repairOptions = (client: unknown) => ({
      client: client as never,
      directory: "/tmp/project",
      taskId: "ses_same_child",
      agent: "vv-implementer" as const,
      workItemId: "wi-1",
      malformedOutput: "plain progress",
      parseErrorCode: "MISSING_ROUTE" as const,
      parseErrorMessage: "MISSING_ROUTE: vv-implementer output must include VVOC_ROUTE",
    });

    const errorHost = createHostPermissionDouble({
      rules: persistentRules,
      promptResult: () => ({
        data: undefined,
        error: { name: "BadRequest", data: { message: "rejected" } },
      }),
    });
    expect(await attemptTrackedResultRepair(repairOptions(errorHost.client))).toBeUndefined();

    const throwHost = createHostPermissionDouble({
      rules: persistentRules,
      promptResult: () => {
        throw new Error("aborted");
      },
    });
    expect(await attemptTrackedResultRepair(repairOptions(throwHost.client))).toBeUndefined();

    expect(errorHost.getRules()).toEqual(persistentRules);
    expect(throwHost.getRules()).toEqual(persistentRules);
    expect(errorHost.mutationCalls).toEqual({ create: 0, fork: 0, update: 0, restore: 0 });
    expect(throwHost.mutationCalls).toEqual({ create: 0, fork: 0, update: 0, restore: 0 });
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
  test("work_item_open requires explicit mode and requiredReviewers", () => {
    const store = createWorkItemStore();
    const openTool = createWorkItemOpenTool(store);
    const invalid = openTool.execute(
      { items: [{ key: "invalid", title: "Invalid" }] },
      { sessionId: SESSION_ID },
    ) as { items: Array<{ ok: boolean; errorCode?: string }> };
    expect(invalid.items[0]?.ok).toBe(false);
    expect(invalid.items[0]?.errorCode).toBe("INVALID_INPUT");

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

type WorkflowPluginHarness = {
  plugin: Awaited<ReturnType<typeof WorkflowPlugin>>;
  logs: string[];
  promptCalls: SessionPromptCall[];
};

type PromptScriptEntry = string | { error: string } | { throws: string };

function writeWorkflowProfile(profile: OrchestrationProfile): void {
  const configHome = process.env.XDG_CONFIG_HOME;
  if (!configHome) throw new Error("XDG_CONFIG_HOME required for workflow test");
  const config = createDefaultVvocConfig();
  config.orchestration = { profile };
  const configDir = join(configHome, "vvoc");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "vvoc.json"), renderVvocConfig(config), "utf8");
}

function createWorkflowPluginHarness(
  profile?: OrchestrationProfile,
  options?: { promptResponses?: PromptScriptEntry[] },
): Promise<WorkflowPluginHarness> {
  if (profile) writeWorkflowProfile(profile);
  const logs: string[] = [];
  const promptCalls: SessionPromptCall[] = [];
  const pendingPromptResponses = [...(options?.promptResponses ?? [])];
  return WorkflowPlugin({
    client: {
      app: {
        log: async (payload: { body?: { message?: string } }) => {
          const message = payload.body?.message;
          if (typeof message === "string") logs.push(message);
        },
      },
      session: {
        prompt: async (call: SessionPromptCall): Promise<SessionPromptConsumedResult> => {
          promptCalls.push(call);
          const entry = pendingPromptResponses.shift();
          if (entry === undefined) {
            return {
              data: undefined,
              error: { name: "BadRequest", data: { message: "prompt unavailable" } },
            };
          }
          if (typeof entry === "string") {
            return { data: sessionPromptResponse(call.path.id, entry) };
          }
          if ("throws" in entry) {
            throw new Error(entry.throws);
          }
          return {
            data: undefined,
            error: { name: "BadRequest", data: { message: entry.error } },
          };
        },
      },
    } as never,
    project: {} as never,
    directory: "/tmp/project",
    worktree: "/tmp/project",
    experimental_workspace: { register: () => undefined },
    serverUrl: new URL("http://localhost"),
    $: {} as never,
  }).then((plugin) => ({ plugin, logs, promptCalls }));
}

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

    await expect(
      finishPluginTask(plugin, sessionID, "code", "vv-code-reviewer", workItemId, "PASS"),
    ).rejects.toThrow("RESULT_HARD_STOP: needs_context");
    listed = await listPluginItems(plugin, sessionID);
    expect(listed.items[0]?.state).toBe("needs_context");
  });

  test("implementer BLOCKED hard stop includes and lists result excerpt", async () => {
    const { plugin } = await createWorkflowPluginHarness();
    const sessionID = "session-implementer-blocked-excerpt";
    const workItemId = await openPluginWorkItem(plugin, sessionID, "implementation", ["spec"]);

    await launchPluginTask(plugin, sessionID, "impl", "vv-implementer", workItemId);
    await expect(
      finishPluginTask(
        plugin,
        sessionID,
        "impl",
        "vv-implementer",
        workItemId,
        "BLOCKED",
        "Blocked because the target API contract is missing.",
      ),
    ).rejects.toThrow("Blocked because the target API contract is missing.");

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
    await expect(
      finishPluginTaskWithRawOutput(
        plugin,
        sessionID,
        "spec",
        "vv-spec-reviewer",
        workItemId,
        wrapTaskResult(
          "ses_repair_missing_blank",
          `VVOC_WORK_ITEM_ID: ${workItemId}\nVVOC_STATUS: FAIL\nFindings from reviewer`,
        ),
      ),
    ).rejects.toThrow("Findings from reviewer");
    await expect(
      finishPluginTaskWithRawOutput(
        plugin,
        sessionID,
        "spec-second-attempt",
        "vv-spec-reviewer",
        workItemId,
        wrapTaskResult(
          "ses_repair_missing_blank",
          `VVOC_WORK_ITEM_ID: ${workItemId}\nVVOC_STATUS: FAIL\nFindings from reviewer`,
        ),
      ),
    ).rejects.toThrow("RESULT_PROTOCOL_ERROR");
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
    expect(call?.path.id).toBe("ses_continuation_child");
    expect(call?.body?.agent).toBe("vv-implementer");
    expect(call?.body?.tools).toBeUndefined();
    expect(call?.body !== undefined && "tools" in call.body).toBe(false);
    expect(firstPromptText(call)).toContain(
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
    expect(promptCalls[0]?.path.id).toBe("ses_element_child");
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
    await expect(
      finishPluginTask(
        plugin,
        hardStopSession,
        "impl",
        "vv-implementer",
        hardStopItem,
        "BLOCKED",
        "Valid hard stop body.",
      ),
    ).rejects.toThrow("RESULT_HARD_STOP");

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
      await expect(
        finishPluginTaskWithRawOutput(
          plugin,
          testCase.sessionID,
          "impl",
          "vv-implementer",
          workItemId,
          testCase.raw(workItemId),
        ),
      ).rejects.toThrow(testCase.excerpt);
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
      await expect(
        finishPluginTaskWithRawOutput(
          plugin,
          testCase.sessionID,
          "impl",
          "vv-implementer",
          workItemId,
          wrapTaskResult(`ses_${testCase.sessionID}`, testCase.excerpt),
        ),
      ).rejects.toThrow(testCase.excerpt);
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
      await expect(
        finishPluginTaskWithRawOutput(
          plugin,
          testCase.sessionID,
          "impl",
          "vv-implementer",
          workItemId,
          wrapTaskResult(
            `ses_${testCase.sessionID}`,
            "Original progress before invalid continuation.",
          ),
        ),
      ).rejects.toThrow("RESULT_PROTOCOL_ERROR");
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

    await expect(
      finishPluginTaskWithRawOutput(
        plugin,
        sessionID,
        "impl",
        "vv-implementer",
        workItemId,
        wrapTaskResult("ses_continue_hard_stop", "plain progress without a protocol header"),
      ),
    ).rejects.toThrow("RESULT_HARD_STOP");

    expect(promptCalls).toHaveLength(1);
    const listed = await listPluginItems(plugin, sessionID);
    expect(listed.items[0]?.state).toBe("needs_context");
  });

  test("state application errors include parsed result excerpt", async () => {
    const { plugin } = await createWorkflowPluginHarness();
    const sessionID = "session-state-error-excerpt";
    const workItemId = await openPluginWorkItem(plugin, sessionID, "review_only", ["spec"]);

    await expect(
      finishPluginTask(
        plugin,
        sessionID,
        "spec-without-launch",
        "vv-spec-reviewer",
        workItemId,
        "PASS",
        "Parsed body should survive state rejection.",
      ),
    ).rejects.toThrow("Parsed body should survive state rejection.");
    await expect(
      finishPluginTask(
        plugin,
        sessionID,
        "spec-without-launch-again",
        "vv-spec-reviewer",
        workItemId,
        "PASS",
        "Parsed body should survive state rejection.",
      ),
    ).rejects.toThrow("REVIEWER_NOT_IN_FLIGHT");
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

    await expect(
      finishPluginTask(
        plugin,
        sessionID,
        "code",
        "vv-code-reviewer",
        workItemId,
        "PASS",
        "Code review has no additional concerns.",
      ),
    ).rejects.toThrow("Need schema ownership decision before review can pass.");

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

async function openAndLaunchImplementer(
  plugin: Awaited<ReturnType<typeof WorkflowPlugin>>,
  sessionID: string,
): Promise<string> {
  const workItemId = await openPluginWorkItem(plugin, sessionID, "implementation", ["spec"]);
  await launchPluginTask(plugin, sessionID, "impl", "vv-implementer", workItemId);
  return workItemId;
}

async function finishPluginTask(
  plugin: Awaited<ReturnType<typeof WorkflowPlugin>>,
  sessionID: string,
  callPrefix: string,
  subagentType: "vv-implementer" | "vv-spec-reviewer" | "vv-code-reviewer",
  workItemId: string,
  status: ParsedResultBlock["status"],
  body = "Done.",
): Promise<void> {
  const route = subagentType === "vv-implementer" ? "\nVVOC_ROUTE: change_with_review" : "";
  await finishPluginTaskWithRawOutput(
    plugin,
    sessionID,
    callPrefix,
    subagentType,
    workItemId,
    `VVOC_WORK_ITEM_ID: ${workItemId}\nVVOC_STATUS: ${status}${route}\n\n${body}`,
  );
}

async function finishPluginTaskWithRawOutput(
  plugin: Awaited<ReturnType<typeof WorkflowPlugin>>,
  sessionID: string,
  callPrefix: string,
  subagentType: "vv-implementer" | "vv-spec-reviewer" | "vv-code-reviewer",
  workItemId: string,
  output: string,
): Promise<void> {
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
      output,
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

type SessionPromptCall = Parameters<OpencodeClient["session"]["prompt"]>[0];
type SessionPromptResponse = SessionPromptResponses[keyof SessionPromptResponses];
type SessionPromptError = SessionPromptErrors[keyof SessionPromptErrors];
type SessionPromptConsumedResult =
  | { data: SessionPromptResponse; error?: undefined }
  | { data?: undefined; error: SessionPromptError };

function assistantMessage(sessionID: string): AssistantMessage {
  return {
    id: `msg_${sessionID}`,
    sessionID,
    role: "assistant",
    time: { created: 1 },
    parentID: `msg_parent_${sessionID}`,
    modelID: "deepseek-flash",
    providerID: "deepseek",
    mode: "build",
    path: { cwd: "/tmp/project", root: "/tmp/project" },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
}

function textPart(sessionID: string, text: string): TextPart {
  return {
    id: `part_${sessionID}`,
    sessionID,
    messageID: `msg_${sessionID}`,
    type: "text",
    text,
  };
}

function sessionPromptResponse(sessionID: string, text: string): SessionPromptResponse {
  return { info: assistantMessage(sessionID), parts: [textPart(sessionID, text)] };
}

function firstPromptText(call: SessionPromptCall | undefined): string | undefined {
  const part = call?.body?.parts?.[0];
  return part && part.type === "text" ? part.text : undefined;
}

type SessionPromptMutation = "create" | "fork" | "update" | "restore";

type HostPermissionDouble = {
  client: {
    app: { log: (payload: unknown) => Promise<void> };
    session: {
      prompt: (call: SessionPromptCall) => Promise<SessionPromptConsumedResult>;
      create: () => Promise<never>;
      fork: () => Promise<never>;
      update: () => Promise<never>;
      restore: () => Promise<never>;
    };
  };
  calls: SessionPromptCall[];
  mutationCalls: Record<SessionPromptMutation, number>;
  getRules: () => PermissionRule[];
};

/**
 * Deterministic double for the confirmed OpenCode host semantics: a nonempty
 * prompt body `tools` object is materialized into {permission, action,
 * pattern: "*"} rules and replaces the complete persisted session permission
 * ruleset, while an omitted `tools` key leaves the persisted rules untouched.
 * It also counts session mutation APIs so a test can prove none were called.
 */
function createHostPermissionDouble(options: {
  rules: PermissionRule[];
  promptResult?: (call: SessionPromptCall) => SessionPromptConsumedResult;
}): HostPermissionDouble {
  let rules = options.rules.map((rule) => ({ ...rule }));
  const calls: SessionPromptCall[] = [];
  const mutationCalls: Record<SessionPromptMutation, number> = {
    create: 0,
    fork: 0,
    update: 0,
    restore: 0,
  };
  const recordMutation = (name: SessionPromptMutation) => async (): Promise<never> => {
    mutationCalls[name] += 1;
    throw new Error(`unexpected session.${name} call`);
  };
  return {
    client: {
      app: { log: async () => undefined },
      session: {
        prompt: async (call: SessionPromptCall): Promise<SessionPromptConsumedResult> => {
          calls.push(call);
          const tools = call.body?.tools;
          if (tools && Object.keys(tools).length > 0) {
            rules = Object.entries(tools).map(([permission, enabled]) => ({
              permission,
              action: enabled ? ("allow" as const) : ("deny" as const),
              pattern: "*",
            }));
          }
          if (options.promptResult) {
            return options.promptResult(call);
          }
          return {
            data: undefined,
            error: { name: "BadRequest", data: { message: "prompt unavailable" } },
          };
        },
        create: recordMutation("create"),
        fork: recordMutation("fork"),
        update: recordMutation("update"),
        restore: recordMutation("restore"),
      },
    },
    calls,
    mutationCalls,
    getRules: () => rules.map((rule) => ({ ...rule })),
  };
}
