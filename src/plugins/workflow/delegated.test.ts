// FILE: src/plugins/workflow/delegated.test.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Deterministic tests for delegated work-item attempts, bounded recovery, report-rejection settlement, and explicit controller acceptance decisions.
//   SCOPE: Delegated open validation, callID-bound attempt allocation and results, two-attempt budgets, accept/request_changes decisions with concerns disposition, wrong-attempt and duplicate rejections, guarded checkpoint-authorized rework, recovery resume and one-unit grants with autonomous and replay-protected root-user authorization, terminal report-rejection settlement preserving hard stops, recovery and rework interaction, and legacy-mode isolation.
//   DEPENDS: [bun:test, src/plugins/workflow/delegated.ts, src/plugins/workflow/state.ts]
//   LINKS: [M-WORKFLOW-DELEGATED, M-WORKFLOW-STATE, V-M-WORKFLOW-DELEGATED]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SESSION - Stable session identifier shared by delegated domain fixtures.
//   store - Fresh work-item store created before each test.
//   openDelegated - Opens one delegated work item with default fixture fields.
//   runAttempt - Launches and completes one delegated attempt.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-002 - Added write-scope validation coverage proving non-string entries are rejected with their index instead of stringified.]
// END_CHANGE_SUMMARY

import { beforeEach, describe, expect, test } from "bun:test";
import { createWorkItemStore, createWorkflowResultExcerpt, type WorkItemStore } from "./state.js";
import {
  applyDelegatedLaunchFailure,
  applyDelegatedReportRejection,
  applyDelegatedResult,
  beginDelegatedLaunch,
  currentDelegatedAcceptance,
  decideDelegatedWorkItem,
  recoverDelegatedWorkItem,
  reworkDelegatedWorkItem,
  summarizeDelegatedProgress,
  validateDelegatedWriteScope,
  type RecoveryUserMessageSnapshot,
} from "./delegated.js";

const SESSION = "session-delegated";

let store: WorkItemStore;

beforeEach(() => {
  store = createWorkItemStore();
});

function openDelegated(overrides: Record<string, unknown> = {}) {
  return store.openWorkItem({
    sessionId: SESSION,
    key: "delegated-task",
    title: "Delegated task",
    mode: "delegated",
    requiredReviewers: [],
    writeScope: ["src/lib/feature.ts"],
    ...overrides,
  } as never);
}

function runAttempt(
  workItemId: string,
  callId: string,
  resultStatus: "DONE" | "DONE_WITH_CONCERNS" | "NEEDS_CONTEXT" | "BLOCKED",
  attempt?: number,
) {
  const launched = beginDelegatedLaunch(store, { sessionId: SESSION, workItemId, callId });
  if (!launched.ok) return launched;
  return applyDelegatedResult(store, {
    sessionId: SESSION,
    workItemId,
    callId,
    resultStatus,
    ...(attempt !== undefined ? {} : {}),
  });
}

// START_BLOCK_OPEN_TESTS
describe("delegated work-item open validation", () => {
  test("opens with an explicitly empty reviewer array and a declared write scope", () => {
    const opened = openDelegated();
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.record.mode).toBe("delegated");
    expect(opened.record.requiredReviewers).toEqual([]);
    expect(opened.record.state).toBe("open");
    expect(opened.record.delegated?.writeScope).toEqual(["src/lib/feature.ts"]);
    expect(opened.record.delegated?.attempts).toEqual([]);
  });

  test("rejects non-empty reviewers, malformed scopes, and half plan bindings", () => {
    const withReviewers = openDelegated({ requiredReviewers: ["spec"] });
    expect(withReviewers.ok).toBe(false);
    if (!withReviewers.ok) expect(withReviewers.errorCode).toBe("INVALID_INPUT");

    const malformedScope = openDelegated({ writeScope: ["../escape.ts"] });
    expect(malformedScope.ok).toBe(false);

    const duplicateScope = openDelegated({ writeScope: ["a.ts", "a.ts"] });
    expect(duplicateScope.ok).toBe(false);

    const halfPlan = openDelegated({ planRunId: "run-1" });
    expect(halfPlan.ok).toBe(false);
  });

  test("write-scope validation rejects non-string entries with their index instead of stringifying", () => {
    const valid = validateDelegatedWriteScope(["src/lib/feature.ts"]);
    expect(valid.ok).toBe(true);
    if (valid.ok) expect(valid.paths).toEqual(["src/lib/feature.ts"]);

    const nonString = validateDelegatedWriteScope([123 as never, "src/lib/feature.ts"]);
    expect(nonString.ok).toBe(false);
    if (!nonString.ok) {
      expect(nonString.message).toContain("index 0");
      expect(nonString.message).toContain("string");
    }

    // Stringification is gone: a previously coerced numeric entry can never
    // become a declared scope path.
    const opened = openDelegated({ writeScope: [123 as never] });
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.message).toContain("must be strings");
  });

  test("rejects delegated fields on legacy modes and keeps their reviewer requirements", () => {
    const mixed = store.openWorkItem({
      sessionId: SESSION,
      key: "legacy-mixed",
      title: "Legacy",
      mode: "implementation",
      requiredReviewers: ["spec"],
      writeScope: ["src/lib/x.ts"],
    } as never);
    expect(mixed.ok).toBe(false);
    if (!mixed.ok) expect(mixed.errorCode).toBe("INVALID_INPUT");

    const emptyReviewers = store.openWorkItem({
      sessionId: SESSION,
      key: "legacy-empty",
      title: "Legacy",
      mode: "implementation",
      requiredReviewers: [],
    });
    expect(emptyReviewers.ok).toBe(false);
    if (!emptyReviewers.ok) {
      expect(emptyReviewers.message).toContain("non-empty canonical set");
    }
  });

  test("reuses by key for identical intent and conflicts on a different write scope", () => {
    const first = openDelegated();
    expect(first.ok).toBe(true);
    const reused = openDelegated();
    expect(reused.ok).toBe(true);
    if (!reused.ok) return;
    expect(reused.reused).toBe(true);

    const conflicted = openDelegated({ writeScope: ["src/lib/other.ts"] });
    expect(conflicted.ok).toBe(false);
    if (!conflicted.ok) expect(conflicted.errorCode).toBe("WORK_ITEM_KEY_CONFLICT");
  });
});
// END_BLOCK_OPEN_TESTS

// START_BLOCK_ATTEMPT_TESTS
describe("delegated attempts and call-bound results", () => {
  test("allocates attempt one bound to the host call and moves DONE to awaiting_acceptance", () => {
    const opened = openDelegated();
    if (!opened.ok) throw new Error("open failed");

    const launched = beginDelegatedLaunch(store, {
      sessionId: SESSION,
      workItemId: opened.record.workItemId,
      callId: "call-1",
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    expect(launched.attempt).toBe(1);
    expect(launched.record.state).toBe("awaiting_implementer");

    const blocked = beginDelegatedLaunch(store, {
      sessionId: SESSION,
      workItemId: opened.record.workItemId,
      callId: "call-2",
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.errorCode).toBe("ATTEMPT_IN_FLIGHT");

    const applied = applyDelegatedResult(store, {
      sessionId: SESSION,
      workItemId: opened.record.workItemId,
      callId: "call-1",
      resultStatus: "DONE",
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.toState).toBe("awaiting_acceptance");
    expect(applied.attempt).toBe(1);
  });

  test("rejects stale call ids, invalid statuses, and legacy-mode results", () => {
    const opened = openDelegated();
    if (!opened.ok) throw new Error("open failed");
    beginDelegatedLaunch(store, {
      sessionId: SESSION,
      workItemId: opened.record.workItemId,
      callId: "call-1",
    });

    const stale = applyDelegatedResult(store, {
      sessionId: SESSION,
      workItemId: opened.record.workItemId,
      callId: "call-stale",
      resultStatus: "DONE",
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.errorCode).toBe("STALE_CALLBACK");

    const invalid = applyDelegatedResult(store, {
      sessionId: SESSION,
      workItemId: opened.record.workItemId,
      callId: "call-1",
      resultStatus: "PASS" as never,
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.errorCode).toBe("INVALID_RESULT_STATUS");

    const legacy = store.openWorkItem({
      sessionId: SESSION,
      key: "legacy-impl",
      title: "Legacy",
      mode: "implementation",
      requiredReviewers: ["spec"],
    });
    expect(legacy.ok).toBe(true);
    if (legacy.ok) {
      const legacyResult = applyDelegatedResult(store, {
        sessionId: SESSION,
        workItemId: legacy.record.workItemId,
        callId: "call-9",
        resultStatus: "DONE",
      });
      expect(legacyResult.ok).toBe(false);
      if (!legacyResult.ok) expect(legacyResult.errorCode).toBe("WRONG_MODE");
    }
  });

  test("keeps hard stops hard and retains DONE_WITH_CONCERNS excerpts", () => {
    const needsContext = openDelegated({ key: "needs-context" });
    const blocked = openDelegated({ key: "blocked-item" });
    const concerns = openDelegated({ key: "with-concerns" });
    if (!needsContext.ok || !blocked.ok || !concerns.ok) throw new Error("open failed");

    const nc = runAttempt(needsContext.record.workItemId, "call-nc", "NEEDS_CONTEXT");
    expect(nc.ok).toBe(true);
    if (nc.ok) expect(nc.toState).toBe("needs_context");

    const bl = runAttempt(blocked.record.workItemId, "call-bl", "BLOCKED");
    expect(bl.ok).toBe(true);
    if (bl.ok) expect(bl.toState).toBe("blocked");

    const co = runAttempt(concerns.record.workItemId, "call-co", "DONE_WITH_CONCERNS");
    expect(co.ok).toBe(true);
    if (co.ok) {
      expect(co.toState).toBe("awaiting_acceptance");
      const record = store.getWorkItem(SESSION, concerns.record.workItemId);
      expect(record?.delegated?.attempts[0]?.resultStatus).toBe("DONE_WITH_CONCERNS");
    }
  });
});
// END_BLOCK_ATTEMPT_TESTS

// START_BLOCK_DECISION_TESTS
describe("controller decisions", () => {
  test("accept records acceptance distinctly from reviewer PASS and reaches ready_to_close", () => {
    const opened = openDelegated();
    if (!opened.ok) throw new Error("open failed");
    const workItemId = opened.record.workItemId;
    runAttempt(workItemId, "call-1", "DONE");

    const accepted = decideDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId,
      attempt: 1,
      decision: "accept",
      rationale: "Read the diff; matches the task contract.",
      evidence: ["src/lib/feature.ts", "bun test src/lib/feature.test.ts"],
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.record.state).toBe("ready_to_close");
    expect(accepted.record.delegated?.acceptances).toHaveLength(1);
    expect(accepted.record.delegated?.acceptances[0]).toMatchObject({
      attempt: 1,
      rationale: "Read the diff; matches the task contract.",
    });
    expect(accepted.record.specReviewCount).toBe(0);
    expect(accepted.record.codeReviewCount).toBe(0);
    expect(accepted.record.requiredReviewers).toEqual([]);

    const closed = store.closeWorkItem(SESSION, workItemId);
    expect(closed.ok).toBe(true);
  });

  test("request_changes returns the completed attempt to the implementation path", () => {
    const opened = openDelegated();
    if (!opened.ok) throw new Error("open failed");
    const workItemId = opened.record.workItemId;
    runAttempt(workItemId, "call-1", "DONE");

    const changed = decideDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId,
      attempt: 1,
      decision: "request_changes",
      rationale: "Missing test for the empty-input branch.",
      evidence: ["src/lib/feature.test.ts"],
    });
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.record.state).toBe("awaiting_implementer");
    expect(changed.record.delegated?.acceptances).toEqual([]);

    const second = beginDelegatedLaunch(store, {
      sessionId: SESSION,
      workItemId,
      callId: "call-2",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.attempt).toBe(2);
    applyDelegatedResult(store, {
      sessionId: SESSION,
      workItemId,
      callId: "call-2",
      resultStatus: "DONE",
    });

    // A second correction decision is legal, but it consumes the last base attempt.
    const secondChange = decideDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId,
      attempt: 2,
      decision: "request_changes",
      rationale: "Still missing the edge case.",
      evidence: ["src/lib/feature.test.ts"],
    });
    expect(secondChange.ok).toBe(true);
    if (!secondChange.ok) return;
    expect(secondChange.record.state).toBe("awaiting_implementer");

    const third = beginDelegatedLaunch(store, { sessionId: SESSION, workItemId, callId: "call-3" });
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.errorCode).toBe("ATTEMPTS_EXHAUSTED");
  });

  test("rejects wrong attempts, duplicates, premature decisions, and wrong modes", () => {
    const opened = openDelegated();
    if (!opened.ok) throw new Error("open failed");
    const workItemId = opened.record.workItemId;

    const premature = decideDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId,
      attempt: 1,
      decision: "accept",
      rationale: "Too early.",
      evidence: ["diff"],
    });
    expect(premature.ok).toBe(false);
    if (!premature.ok) expect(premature.errorCode).toBe("INVALID_STATE");

    runAttempt(workItemId, "call-1", "DONE");

    const wrongAttempt = decideDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId,
      attempt: 2,
      decision: "accept",
      rationale: "Wrong attempt.",
      evidence: ["diff"],
    });
    expect(wrongAttempt.ok).toBe(false);
    if (!wrongAttempt.ok) expect(wrongAttempt.errorCode).toBe("INVALID_ATTEMPT");

    const accepted = decideDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId,
      attempt: 1,
      decision: "accept",
      rationale: "Fine.",
      evidence: ["diff"],
    });
    expect(accepted.ok).toBe(true);

    const duplicate = decideDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId,
      attempt: 1,
      decision: "accept",
      rationale: "Again.",
      evidence: ["diff"],
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.errorCode).toBe("INVALID_STATE");
  });

  test("enforces concerns disposition and text bounds", () => {
    const opened = openDelegated();
    if (!opened.ok) throw new Error("open failed");
    const workItemId = opened.record.workItemId;
    runAttempt(workItemId, "call-1", "DONE_WITH_CONCERNS");

    const missing = decideDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId,
      attempt: 1,
      decision: "accept",
      rationale: "Accepting with concerns.",
      evidence: ["diff"],
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errorCode).toBe("CONCERNS_DISPOSITION_REQUIRED");

    const accepted = decideDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId,
      attempt: 1,
      decision: "accept",
      rationale: "Accepting with concerns.",
      evidence: ["diff"],
      concernsDisposition: "Concern is limited to logging; acceptable for this milestone.",
    });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.record.delegated?.acceptances[0]?.concernsDisposition).toContain("logging");
    }

    const plain = openDelegated({ key: "plain-done" });
    if (!plain.ok) throw new Error("open failed");
    runAttempt(plain.record.workItemId, "call-p", "DONE");
    const unexpected = decideDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId: plain.record.workItemId,
      attempt: 1,
      decision: "accept",
      rationale: "Fine.",
      evidence: ["diff"],
      concernsDisposition: "Not needed.",
    });
    expect(unexpected.ok).toBe(false);
    if (!unexpected.ok) expect(unexpected.errorCode).toBe("UNEXPECTED_CONCERNS_DISPOSITION");

    const badRationale = decideDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId: plain.record.workItemId,
      attempt: 1,
      decision: "accept",
      rationale: "  ",
      evidence: ["diff"],
    });
    expect(badRationale.ok).toBe(false);

    const tooManyRefs = decideDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId: plain.record.workItemId,
      attempt: 1,
      decision: "accept",
      rationale: "Fine.",
      evidence: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
    });
    expect(tooManyRefs.ok).toBe(false);
  });

  test("legacy implementation items cannot be completed by controller acceptance", () => {
    const legacy = store.openWorkItem({
      sessionId: SESSION,
      key: "legacy-item",
      title: "Legacy",
      mode: "implementation",
      requiredReviewers: ["spec"],
    });
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) return;

    const rejected = decideDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId: legacy.record.workItemId,
      attempt: 1,
      decision: "accept",
      rationale: "Trying to shortcut.",
      evidence: ["diff"],
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.errorCode).toBe("WRONG_MODE");
  });
});
// END_BLOCK_DECISION_TESTS

// START_BLOCK_REWORK_TESTS
describe("checkpoint-authorized rework", () => {
  function acceptedItem(key: string): string {
    const opened = openDelegated({ key });
    if (!opened.ok) throw new Error("open failed");
    const workItemId = opened.record.workItemId;
    runAttempt(workItemId, `call-${key}-1`, "DONE");
    const decided = decideDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId,
      attempt: 1,
      decision: "accept",
      rationale: "Accepted.",
      evidence: ["diff"],
    });
    if (!decided.ok) throw new Error("accept failed");
    return workItemId;
  }

  test("reopens an accepted item, preserves history, and grants exactly one attempt", () => {
    const workItemId = acceptedItem("rework-me");
    const reworked = reworkDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId,
      planRunId: "run-1",
      failedCheckpointId: "CHECKPOINT-R-001",
      reason: "Code review found a contract violation in the accepted diff.",
    });
    expect(reworked.ok).toBe(true);
    if (!reworked.ok) return;
    expect(reworked.record.state).toBe("awaiting_implementer");
    expect(reworked.grantedAttempts).toBe(3);
    expect(reworked.record.delegated?.reworkHistory).toHaveLength(1);
    expect(reworked.record.delegated?.acceptances).toHaveLength(1);
    expect(reworked.record.delegated?.acceptances[0]?.revokedAt).toBeDefined();
    expect(currentDelegatedAcceptance(reworked.record)).toBeUndefined();
    expect(reworked.record.delegated?.attempts).toHaveLength(1);

    const third = beginDelegatedLaunch(store, {
      sessionId: SESSION,
      workItemId,
      callId: "call-rw-1",
    });
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.attempt).toBe(2);
  });

  test("rework of a closed accepted item is possible while its plan run is unfinished", () => {
    const workItemId = acceptedItem("closed-rework");
    const closed = store.closeWorkItem(SESSION, workItemId);
    expect(closed.ok).toBe(true);

    const reworked = reworkDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId,
      planRunId: "run-1",
      failedCheckpointId: "CHECKPOINT-R-002",
      reason: "Final checkpoint failed on the accepted result.",
    });
    expect(reworked.ok).toBe(true);
    if (reworked.ok) {
      expect(reworked.record.state).toBe("awaiting_implementer");
      expect(reworked.record.closedAt).toBeUndefined();
    }
  });

  test("rejects duplicate rework, hard stops, and non-accepted items", () => {
    const workItemId = acceptedItem("dup-rework");
    const first = reworkDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId,
      planRunId: "run-1",
      failedCheckpointId: "CHECKPOINT-R-001",
      reason: "First failure.",
    });
    expect(first.ok).toBe(true);

    // The rework attempt completes and is accepted again before the same
    // checkpoint tries to authorize a second rework of the same item.
    runAttempt(workItemId, "call-rw", "DONE");
    const reAccepted = decideDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId,
      attempt: 2,
      decision: "accept",
      rationale: "Corrected result accepted.",
      evidence: ["diff"],
    });
    expect(reAccepted.ok).toBe(true);

    const duplicate = reworkDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId,
      planRunId: "run-1",
      failedCheckpointId: "CHECKPOINT-R-001",
      reason: "Duplicate authorization.",
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.errorCode).toBe("ALREADY_REWORKED");

    const hardStop = openDelegated({ key: "hard-stop" });
    if (!hardStop.ok) throw new Error("open failed");
    runAttempt(hardStop.record.workItemId, "call-hs", "NEEDS_CONTEXT");
    const reopened = reworkDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId: hardStop.record.workItemId,
      planRunId: "run-1",
      failedCheckpointId: "CHECKPOINT-R-001",
      reason: "Cannot reopen hard stops.",
    });
    expect(reopened.ok).toBe(false);
    if (!reopened.ok) expect(reopened.errorCode).toBe("HARD_STOP_STATE");

    const notAccepted = openDelegated({ key: "not-accepted" });
    if (!notAccepted.ok) throw new Error("open failed");
    runAttempt(notAccepted.record.workItemId, "call-na", "DONE");
    const noAcceptance = reworkDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId: notAccepted.record.workItemId,
      planRunId: "run-1",
      failedCheckpointId: "CHECKPOINT-R-001",
      reason: "Nothing accepted yet.",
    });
    expect(noAcceptance.ok).toBe(false);
    if (!noAcceptance.ok) expect(noAcceptance.errorCode).toBe("INVALID_STATE");
  });
});
// END_BLOCK_REWORK_TESTS

// START_BLOCK_FAILED_ATTEMPT_TESTS
describe("confirmed host-terminal launch failures", () => {
  function failAttempt(workItemId: string, callId: string, text?: string) {
    return applyDelegatedLaunchFailure(store, {
      sessionId: SESSION,
      workItemId,
      callId,
      failureExcerpt: createWorkflowResultExcerpt({
        text:
          text ??
          "Subagent failed (task_id: ses_child_1): unknown provider for model deepseek-flash",
        source: "normalized_output",
      })!,
    });
  }

  test("records a failed attempt, consumes one attempt, and keeps the item retryable", () => {
    const opened = openDelegated();
    if (!opened.ok) throw new Error("open failed");
    const workItemId = opened.record.workItemId;
    beginDelegatedLaunch(store, { sessionId: SESSION, workItemId, callId: "call-fail-1" });

    const failed = failAttempt(workItemId, "call-fail-1");
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    expect(failed.toState).toBe("awaiting_implementer");
    expect(failed.attempt).toBe(1);
    expect(failed.consumedAttempts).toBe(1);
    expect(failed.attemptBudget).toBe(2);
    expect(failed.retryAllowed).toBe(true);

    const record = store.getWorkItem(SESSION, workItemId);
    expect(record?.state).toBe("awaiting_implementer");
    expect(record?.delegated?.attempts[0]?.status).toBe("failed");
    expect(record?.delegated?.attempts[0]?.failureExcerpt?.text).toContain("unknown provider");
    expect(record?.delegated?.attempts[0]?.completedAt).toBeDefined();
    expect(record?.delegated?.attempts[0]?.resultStatus).toBeUndefined();

    const retry = beginDelegatedLaunch(store, {
      sessionId: SESSION,
      workItemId,
      callId: "call-fail-2",
    });
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.attempt).toBe(2);
  });

  test("two failures exhaust the normal budget without authorizing acceptance", () => {
    const opened = openDelegated();
    if (!opened.ok) throw new Error("open failed");
    const workItemId = opened.record.workItemId;
    beginDelegatedLaunch(store, { sessionId: SESSION, workItemId, callId: "call-two-1" });
    failAttempt(workItemId, "call-two-1");
    beginDelegatedLaunch(store, { sessionId: SESSION, workItemId, callId: "call-two-2" });
    const second = failAttempt(workItemId, "call-two-2");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.retryAllowed).toBe(false);

    const third = beginDelegatedLaunch(store, {
      sessionId: SESSION,
      workItemId,
      callId: "call-two-3",
    });
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.errorCode).toBe("ATTEMPTS_EXHAUSTED");

    const decision = decideDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId,
      attempt: 1,
      decision: "accept",
      rationale: "Accept a failed attempt.",
      evidence: ["diff"],
    });
    expect(decision.ok).toBe(false);
    expect(store.getWorkItem(SESSION, workItemId)?.state).toBe("awaiting_implementer");
  });

  test("rejects reused callIDs across attempts and items and stale failures", () => {
    const first = openDelegated({ key: "reuse-first" });
    const second = openDelegated({ key: "reuse-second" });
    if (!first.ok || !second.ok) throw new Error("open failed");
    const firstId = first.record.workItemId;
    const secondId = second.record.workItemId;

    beginDelegatedLaunch(store, { sessionId: SESSION, workItemId: firstId, callId: "call-reuse" });
    failAttempt(firstId, "call-reuse");

    const sameItem = beginDelegatedLaunch(store, {
      sessionId: SESSION,
      workItemId: firstId,
      callId: "call-reuse",
    });
    expect(sameItem.ok).toBe(false);
    if (!sameItem.ok) expect(sameItem.errorCode).toBe("CALL_ID_REUSED");

    const crossItem = beginDelegatedLaunch(store, {
      sessionId: SESSION,
      workItemId: secondId,
      callId: "call-reuse",
    });
    expect(crossItem.ok).toBe(false);
    if (!crossItem.ok) expect(crossItem.errorCode).toBe("CALL_ID_REUSED");

    beginDelegatedLaunch(store, {
      sessionId: SESSION,
      workItemId: secondId,
      callId: "call-second",
    });
    const stale = failAttempt(secondId, "call-unknown");
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.errorCode).toBe("STALE_CALLBACK");
  });

  test("ambiguous pre-existing callID histories fail closed", () => {
    const first = openDelegated({ key: "amb-first" });
    const second = openDelegated({ key: "amb-second" });
    if (!first.ok || !second.ok) throw new Error("open failed");
    const firstId = first.record.workItemId;
    const secondId = second.record.workItemId;
    beginDelegatedLaunch(store, { sessionId: SESSION, workItemId: firstId, callId: "call-amb" });

    // Simulate a pre-existing persisted history that bound the same callID to
    // a second item before the uniqueness guard existed.
    const data = store.getStoreData();
    const lookupKey = `${SESSION}::${secondId}`;
    const record = data.records.get(lookupKey);
    if (!record?.delegated) throw new Error("missing delegated record");
    data.records.set(lookupKey, {
      ...record,
      delegated: {
        ...record.delegated,
        attempts: [
          {
            attempt: 1,
            callId: "call-amb",
            launchedAt: new Date().toISOString(),
            status: "in_flight",
          },
        ],
      },
    });

    const ambiguous = failAttempt(firstId, "call-amb");
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) expect(ambiguous.errorCode).toBe("AMBIGUOUS_CALL_ID");
    expect(store.getWorkItem(SESSION, firstId)?.delegated?.attempts[0]?.status).toBe("in_flight");
  });

  test("a failure against a no-longer-waiting item is refused without mutation", () => {
    const opened = openDelegated({ key: "wrong-state" });
    if (!opened.ok) throw new Error("open failed");
    const workItemId = opened.record.workItemId;
    beginDelegatedLaunch(store, { sessionId: SESSION, workItemId, callId: "call-ws" });
    applyDelegatedResult(store, {
      sessionId: SESSION,
      workItemId,
      callId: "call-ws",
      resultStatus: "DONE",
    });

    const refused = failAttempt(workItemId, "call-ws");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.errorCode).toBe("INVALID_STATE");
    expect(store.getWorkItem(SESSION, workItemId)?.state).toBe("awaiting_acceptance");
  });
});
// END_BLOCK_FAILED_ATTEMPT_TESTS

// START_BLOCK_RECOVERY_TESTS
describe("bounded recovery of stopped or exhausted items", () => {
  function recoveryInput(workItemId: string, attempt: number, recoveryId: string) {
    return {
      sessionId: SESSION,
      workItemId,
      attempt,
      diagnosis: "Missing approval decision reached the worker packet.",
      changedCondition: "Approval decision recorded before redispatch.",
      verification: ["src/lib/feature.ts"],
      recoveryId,
    };
  }

  test("two rejected attempts stay unaccepted, block a third launch, and recovery grants exactly one attempt", async () => {
    const opened = openDelegated({ key: "exhausted" });
    if (!opened.ok) throw new Error("open failed");
    const workItemId = opened.record.workItemId;

    const first = runAttempt(workItemId, "call-ex-1", "DONE");
    expect(first.ok).toBe(true);
    const rejectedFirst = decideDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId,
      attempt: 1,
      decision: "request_changes",
      rationale: "Missing branch handling.",
      evidence: ["diff"],
    });
    expect(rejectedFirst.ok).toBe(true);

    const second = runAttempt(workItemId, "call-ex-2", "DONE");
    expect(second.ok).toBe(true);
    const rejectedSecond = decideDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId,
      attempt: 2,
      decision: "request_changes",
      rationale: "Still missing the same branch.",
      evidence: ["diff"],
    });
    expect(rejectedSecond.ok).toBe(true);
    expect(currentDelegatedAcceptance(store.getWorkItem(SESSION, workItemId)!)).toBeUndefined();

    const third = beginDelegatedLaunch(store, {
      sessionId: SESSION,
      workItemId,
      callId: "call-ex-3",
    });
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.errorCode).toBe("ATTEMPTS_EXHAUSTED");

    const recovered = await recoverDelegatedWorkItem(
      store,
      recoveryInput(workItemId, 2, "rec-ex-1"),
    );
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.kind).toBe("autonomous_grant");
    expect(recovered.attemptBudget).toBe(3);
    expect(recovered.remainingAttempts).toBe(1);
    // History is preserved: both decisions remain recorded facts.
    expect(store.getWorkItem(SESSION, workItemId)?.delegated?.decisions).toHaveLength(2);
    expect(store.getWorkItem(SESSION, workItemId)?.delegated?.attempts).toHaveLength(2);

    const relaunched = beginDelegatedLaunch(store, {
      sessionId: SESSION,
      workItemId,
      callId: "call-ex-3",
    });
    expect(relaunched.ok).toBe(true);
    if (!relaunched.ok) return;
    expect(relaunched.attempt).toBe(3);

    const fourth = beginDelegatedLaunch(store, {
      sessionId: SESSION,
      workItemId,
      callId: "call-ex-4",
    });
    expect(fourth.ok).toBe(false);
  });

  test("a stop with ordinary budget remaining resumes without manufacturing budget", async () => {
    const opened = openDelegated({ key: "stopped" });
    if (!opened.ok) throw new Error("open failed");
    const workItemId = opened.record.workItemId;

    const stopped = runAttempt(workItemId, "call-st-1", "BLOCKED");
    expect(stopped.ok).toBe(true);
    expect(store.getWorkItem(SESSION, workItemId)?.state).toBe("blocked");

    // Launching directly from the stop stays refused before recovery.
    const direct = beginDelegatedLaunch(store, {
      sessionId: SESSION,
      workItemId,
      callId: "call-st-2",
    });
    expect(direct.ok).toBe(false);
    if (!direct.ok) expect(direct.errorCode).toBe("INVALID_STATE");

    const recovered = await recoverDelegatedWorkItem(
      store,
      recoveryInput(workItemId, 1, "rec-st-1"),
    );
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.kind).toBe("resume");
    expect(recovered.attemptBudget).toBe(2);
    expect(recovered.remainingAttempts).toBe(1);
    expect(recovered.record.state).toBe("awaiting_implementer");
    // The stop stays a historical fact with its bounded evidence.
    expect(recovered.record.delegated?.attempts[0]?.resultStatus).toBe("BLOCKED");
    const withExcerpt = store.getWorkItem(SESSION, workItemId);
    expect(withExcerpt?.delegated?.attempts[0]?.resultExcerpt ?? withExcerpt?.resultExcerpt).toBe(
      undefined,
    );
  });

  test("the second autonomous grant is denied regardless of recoveryId; a fresh user message grants one more and replays are refused", async () => {
    const opened = openDelegated({ key: "grants" });
    if (!opened.ok) throw new Error("open failed");
    const workItemId = opened.record.workItemId;

    // Ladder: stop, resume, stop, autonomous grant, stop — then denials and
    // the user-authorized extension.
    runAttempt(workItemId, "call-gr-1", "BLOCKED");
    const resumed = await recoverDelegatedWorkItem(
      store,
      recoveryInput(workItemId, 1, "rec-gr-resume"),
    );
    expect(resumed.ok).toBe(true);
    runAttempt(workItemId, "call-gr-2", "BLOCKED");
    const granted = await recoverDelegatedWorkItem(
      store,
      recoveryInput(workItemId, 2, "rec-gr-auto"),
    );
    expect(granted.ok).toBe(true);
    if (!granted.ok) return;

    runAttempt(workItemId, "call-gr-3", "BLOCKED");

    const denied = await recoverDelegatedWorkItem(
      store,
      recoveryInput(workItemId, 3, "rec-gr-other-key"),
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.errorCode).toBe("AUTONOMOUS_GRANT_EXHAUSTED");
    // The denial changed nothing.
    expect(store.getWorkItem(SESSION, workItemId)?.delegated?.recoveryHistory).toHaveLength(2);

    const stopTime = Date.now() - 10_000;
    store
      .getStoreData()
      .records.get(`${SESSION}::${workItemId}`)!.delegated!.attempts[2]!.completedAt = new Date(
      stopTime,
    ).toISOString();

    const lookupMessages = new Map<string, RecoveryUserMessageSnapshot>();
    const lookup = async (_sessionId: string, messageId: string) => lookupMessages.get(messageId);
    const userGrant = await recoverDelegatedWorkItem(store, {
      ...recoveryInput(workItemId, 3, "rec-gr-user"),
      userMessageId: "msg_auth_1",
      lookupUserMessage: lookup,
    });
    expect(userGrant.ok).toBe(false);
    if (!userGrant.ok) expect(userGrant.errorCode).toBe("AUTHORIZATION_NOT_FOUND");

    lookupMessages.set("msg_auth_1", {
      role: "assistant",
      sessionID: SESSION,
      id: "msg_auth_1",
      timeCreatedMs: Date.now(),
    });
    const assistantAuth = await recoverDelegatedWorkItem(store, {
      ...recoveryInput(workItemId, 3, "rec-gr-user"),
      userMessageId: "msg_auth_1",
      lookupUserMessage: lookup,
    });
    expect(assistantAuth.ok).toBe(false);
    if (!assistantAuth.ok) {
      expect(assistantAuth.errorCode).toBe("AUTHORIZATION_NOT_USER_MESSAGE");
    }

    lookupMessages.set("msg_auth_1", {
      role: "user",
      sessionID: "ses_other_session",
      id: "msg_auth_1",
      timeCreatedMs: Date.now(),
    });
    const foreignAuth = await recoverDelegatedWorkItem(store, {
      ...recoveryInput(workItemId, 3, "rec-gr-user"),
      userMessageId: "msg_auth_1",
      lookupUserMessage: lookup,
    });
    expect(foreignAuth.ok).toBe(false);
    if (!foreignAuth.ok) {
      expect(foreignAuth.errorCode).toBe("AUTHORIZATION_SESSION_MISMATCH");
    }

    lookupMessages.set("msg_auth_1", {
      role: "user",
      sessionID: SESSION,
      id: "msg_auth_1",
      timeCreatedMs: stopTime - 60_000,
    });
    const staleAuth = await recoverDelegatedWorkItem(store, {
      ...recoveryInput(workItemId, 3, "rec-gr-user"),
      userMessageId: "msg_auth_1",
      lookupUserMessage: lookup,
    });
    expect(staleAuth.ok).toBe(false);
    if (!staleAuth.ok) expect(staleAuth.errorCode).toBe("AUTHORIZATION_STALE");

    lookupMessages.set("msg_auth_1", {
      role: "user",
      sessionID: SESSION,
      id: "msg_auth_1",
      timeCreatedMs: Date.now(),
    });
    const authorized = await recoverDelegatedWorkItem(store, {
      ...recoveryInput(workItemId, 3, "rec-gr-user"),
      userMessageId: "msg_auth_1",
      lookupUserMessage: lookup,
    });
    expect(authorized.ok).toBe(true);
    if (!authorized.ok) return;
    expect(authorized.kind).toBe("user_grant");
    expect(authorized.attemptBudget).toBe(4);

    runAttempt(workItemId, "call-gr-4", "BLOCKED");
    const replayed = await recoverDelegatedWorkItem(store, {
      ...recoveryInput(workItemId, 4, "rec-gr-user-2"),
      userMessageId: "msg_auth_1",
      lookupUserMessage: lookup,
    });
    expect(replayed.ok).toBe(false);
    if (!replayed.ok) expect(replayed.errorCode).toBe("AUTHORIZATION_REUSED");

    const freshMessage = await recoverDelegatedWorkItem(store, {
      ...recoveryInput(workItemId, 4, "rec-gr-user-3"),
      userMessageId: "msg_auth_2",
      lookupUserMessage: lookup,
    });
    expect(freshMessage.ok).toBe(false);
    if (!freshMessage.ok) expect(freshMessage.errorCode).toBe("AUTHORIZATION_NOT_FOUND");
  });

  test("recovery targets are validated: live attempts, wrong attempts, decided items, accepted items, and duplicate ids", async () => {
    const opened = openDelegated({ key: "targets" });
    if (!opened.ok) throw new Error("open failed");
    const workItemId = opened.record.workItemId;

    beginDelegatedLaunch(store, { sessionId: SESSION, workItemId, callId: "call-tg-live" });
    const live = await recoverDelegatedWorkItem(store, recoveryInput(workItemId, 1, "rec-tg-1"));
    expect(live.ok).toBe(false);
    if (!live.ok) expect(live.errorCode).toBe("INVALID_TARGET_STATE");

    applyDelegatedResult(store, {
      sessionId: SESSION,
      workItemId,
      callId: "call-tg-live",
      resultStatus: "DONE",
    });
    const decided = await recoverDelegatedWorkItem(store, recoveryInput(workItemId, 1, "rec-tg-2"));
    expect(decided.ok).toBe(false);
    if (!decided.ok) expect(decided.errorCode).toBe("INVALID_TARGET_STATE");

    decideDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId,
      attempt: 1,
      decision: "accept",
      rationale: "Accepted for rework interaction checks.",
      evidence: ["diff"],
    });
    const accepted = await recoverDelegatedWorkItem(
      store,
      recoveryInput(workItemId, 1, "rec-tg-3"),
    );
    expect(accepted.ok).toBe(false);
    if (!accepted.ok) expect(accepted.errorCode).toBe("INVALID_TARGET_STATE");

    // A wrong attempt number on a genuinely exhausted item is a mismatch.
    const exhaustedItem = openDelegated({ key: "targets-exhausted" });
    if (!exhaustedItem.ok) throw new Error("open failed");
    const exhaustedId = exhaustedItem.record.workItemId;
    for (const callId of ["call-tg-e1", "call-tg-e2"]) {
      runAttempt(exhaustedId, callId, "DONE");
      decideDelegatedWorkItem(store, {
        sessionId: SESSION,
        workItemId: exhaustedId,
        attempt: callId.endsWith("e1") ? 1 : 2,
        decision: "request_changes",
        rationale: "Rejected to exhaust the ordinary budget.",
        evidence: ["diff"],
      });
    }
    const wrongAttempt = await recoverDelegatedWorkItem(
      store,
      recoveryInput(exhaustedId, 7, "rec-tg-4"),
    );
    expect(wrongAttempt.ok).toBe(false);
    if (!wrongAttempt.ok) expect(wrongAttempt.errorCode).toBe("ATTEMPT_MISMATCH");

    const matched = await recoverDelegatedWorkItem(
      store,
      recoveryInput(exhaustedId, 2, "rec-tg-4b"),
    );
    expect(matched.ok).toBe(true);
    if (matched.ok) expect(matched.kind).toBe("autonomous_grant");

    // A reused recoveryId is refused on the next eligible stop.
    runAttempt(exhaustedId, "call-tg-e3", "BLOCKED");
    const duplicate = await recoverDelegatedWorkItem(
      store,
      recoveryInput(exhaustedId, 3, "rec-tg-4b"),
    );
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.errorCode).toBe("DUPLICATE_RECOVERY_ID");

    // Open-state item with no attempts has nothing to recover.
    const fresh = openDelegated({ key: "fresh-target" });
    if (!fresh.ok) throw new Error("open failed");
    const nothing = await recoverDelegatedWorkItem(
      store,
      recoveryInput(fresh.record.workItemId, 1, "rec-tg-5"),
    );
    expect(nothing.ok).toBe(false);
    if (!nothing.ok) expect(nothing.errorCode).toBe("INVALID_TARGET_STATE");

    // Bounded text is enforced.
    const bounded = await recoverDelegatedWorkItem(store, {
      ...recoveryInput(workItemId, 2, "rec-tg-6"),
      diagnosis: "",
    });
    expect(bounded.ok).toBe(false);
    if (!bounded.ok) expect(bounded.errorCode).toBe("INVALID_INPUT");
  });

  test("recovery cannot reset rework identity and rework cannot consume recovery grants", async () => {
    const opened = openDelegated({ key: "interplay" });
    if (!opened.ok) throw new Error("open failed");
    const workItemId = opened.record.workItemId;

    runAttempt(workItemId, "call-ip-1", "BLOCKED");
    const resumed = await recoverDelegatedWorkItem(store, recoveryInput(workItemId, 1, "rec-ip-1"));
    expect(resumed.ok).toBe(true);
    runAttempt(workItemId, "call-ip-2", "DONE");
    decideDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId,
      attempt: 2,
      decision: "accept",
      rationale: "Accepted for the interplay fixture.",
      evidence: ["diff"],
    });
    reworkDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId,
      planRunId: "run-ip",
      failedCheckpointId: "cp-ip-1",
      reason: "First checkpoint failure.",
    });
    // While unaccepted, replaying the rework is a state rejection.
    const reworkWhileOpen = reworkDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId,
      planRunId: "run-ip",
      failedCheckpointId: "cp-ip-1",
      reason: "Replaying while not accepted.",
    });
    expect(reworkWhileOpen.ok).toBe(false);
    if (!reworkWhileOpen.ok) expect(reworkWhileOpen.errorCode).toBe("INVALID_STATE");

    runAttempt(workItemId, "call-ip-3", "DONE");
    decideDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId,
      attempt: 3,
      decision: "accept",
      rationale: "Corrected after the first rework.",
      evidence: ["diff"],
    });
    // Re-accepting does not reset rework identity: the same checkpoint cannot
    // authorize a second rework.
    const reworkAgain = reworkDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId,
      planRunId: "run-ip",
      failedCheckpointId: "cp-ip-1",
      reason: "Replaying the same checkpoint.",
    });
    expect(reworkAgain.ok).toBe(false);
    if (!reworkAgain.ok) expect(reworkAgain.errorCode).toBe("ALREADY_REWORKED");

    reworkDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId,
      planRunId: "run-ip",
      failedCheckpointId: "cp-ip-2",
      reason: "Second checkpoint failure.",
    });
    runAttempt(workItemId, "call-ip-4", "BLOCKED");
    const afterRework = await recoverDelegatedWorkItem(
      store,
      recoveryInput(workItemId, 4, "rec-ip-2"),
    );
    expect(afterRework.ok).toBe(true);
    if (!afterRework.ok) return;
    // Two rework grants fund attempts 3 and 4; the recovery grant adds one
    // unit without touching rework identity.
    expect(afterRework.kind).toBe("autonomous_grant");
    expect(afterRework.attemptBudget).toBe(5);

    const progress = summarizeDelegatedProgress(store.getWorkItem(SESSION, workItemId)!);
    expect(progress.attemptsConsumed).toBe(4);
    expect(progress.attemptBudget).toBe(5);
    expect(progress.remainingAttempts).toBe(1);
    expect(progress.autonomousGrantConsumed).toBe(true);
    expect(progress.recoveryGrants).toBe(1);
    expect(progress.nextAction).toBe("launch_implementer");
  });
});
// END_BLOCK_RECOVERY_TESTS

// START_BLOCK_REPORT_REJECTION_TESTS
describe("terminal report-rejection settlement", () => {
  function rejectionExcerpt(text: string) {
    return createWorkflowResultExcerpt({ text, source: "normalized_output" })!;
  }

  test("settles a call-bound in-flight attempt as report_rejected without fabricating DONE", () => {
    const opened = openDelegated({ key: "report-rejected" });
    if (!opened.ok) throw new Error("open failed");
    const workItemId = opened.record.workItemId;
    beginDelegatedLaunch(store, { sessionId: SESSION, workItemId, callId: "call-rr-1" });

    const settled = applyDelegatedReportRejection(store, {
      sessionId: SESSION,
      workItemId,
      callId: "call-rr-1",
      protocolErrorCode: "MISSING_STATUS",
      excerpt: rejectionExcerpt("Plain prose without a protocol header."),
    });
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.attempt).toBe(1);
    expect(settled.observedHardStop).toBeUndefined();
    expect(settled.consumedAttempts).toBe(1);
    expect(settled.attemptBudget).toBe(2);

    const record = store.getWorkItem(SESSION, workItemId)!;
    expect(record.state).toBe("awaiting_implementer");
    expect(record.delegated?.attempts[0]?.status).toBe("report_rejected");
    expect(record.delegated?.attempts[0]?.resultStatus).toBeUndefined();
    expect(record.delegated?.attempts[0]?.reportRejection?.protocolErrorCode).toBe(
      "MISSING_STATUS",
    );

    const decision = decideDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId,
      attempt: 1,
      decision: "accept",
      rationale: "A rejected report is not acceptable.",
      evidence: ["diff"],
    });
    expect(decision.ok).toBe(false);

    const progress = summarizeDelegatedProgress(record);
    expect(progress.reportRejectedAttempts).toBe(1);
    expect(progress.nextAction).toBe("launch_implementer");
  });

  test("an explicit hard stop inside malformed output is preserved, not continued", async () => {
    const opened = openDelegated({ key: "rejected-stop" });
    if (!opened.ok) throw new Error("open failed");
    const workItemId = opened.record.workItemId;
    beginDelegatedLaunch(store, { sessionId: SESSION, workItemId, callId: "call-rr-2" });

    const settled = applyDelegatedReportRejection(store, {
      sessionId: SESSION,
      workItemId,
      callId: "call-rr-2",
      protocolErrorCode: "MISSING_ROUTE",
      excerpt: rejectionExcerpt(
        "VVOC_WORK_ITEM_ID: wi-1\nVVOC_STATUS: BLOCKED\nBlocked at the missing approval gate.",
      ),
      explicitHardStop: "BLOCKED",
    });
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.observedHardStop).toBe("BLOCKED");

    const record = store.getWorkItem(SESSION, workItemId)!;
    expect(record.state).toBe("blocked");
    expect(record.resultExcerpt?.text).toContain("missing approval gate");

    const progress = summarizeDelegatedProgress(record);
    expect(progress.nextAction).toBe("recover");

    const recovered = await recoverDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId,
      attempt: 1,
      diagnosis: "Blocked on a missing approval decision.",
      changedCondition: "Decision recorded before redispatch.",
      verification: ["src/lib/feature.ts"],
      recoveryId: "rec-rr-1",
    });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.kind).toBe("resume");
    expect(recovered.record.state).toBe("awaiting_implementer");
  });

  test("stale callbacks and unknown calls never mutate the live attempt", () => {
    const opened = openDelegated({ key: "rejected-stale" });
    if (!opened.ok) throw new Error("open failed");
    const workItemId = opened.record.workItemId;
    beginDelegatedLaunch(store, { sessionId: SESSION, workItemId, callId: "call-rr-live" });

    const stale = applyDelegatedReportRejection(store, {
      sessionId: SESSION,
      workItemId,
      callId: "call-rr-other",
      protocolErrorCode: "MISSING_STATUS",
      excerpt: rejectionExcerpt("Mismatched call."),
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.errorCode).toBe("STALE_CALLBACK");

    const record = store.getWorkItem(SESSION, workItemId)!;
    expect(record.delegated?.attempts[0]?.status).toBe("in_flight");
    expect(record.state).toBe("awaiting_implementer");
  });

  test("a throwing authorization lookup fails closed as a lookup failure", async () => {
    const opened = openDelegated({ key: "lookup-failure" });
    if (!opened.ok) throw new Error("open failed");
    const workItemId = opened.record.workItemId;
    runAttempt(workItemId, "call-lf-1", "BLOCKED");
    await recoverDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId,
      attempt: 1,
      diagnosis: "Worker lacked the approval decision.",
      changedCondition: "Approval decision recorded before redispatch.",
      verification: ["src/lib/feature.ts"],
      recoveryId: "rec-lf-resume",
    });
    runAttempt(workItemId, "call-lf-2", "BLOCKED");

    const failed = await recoverDelegatedWorkItem(store, {
      sessionId: SESSION,
      workItemId,
      attempt: 2,
      diagnosis: "Repeated stop with the session service down.",
      changedCondition: "Waiting for a durable authorization lookup.",
      verification: ["src/lib/feature.ts"],
      recoveryId: "rec-lf-user",
      userMessageId: "msg_transport_down",
      lookupUserMessage: async () => {
        throw new Error("session service unavailable");
      },
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.errorCode).toBe("AUTHORIZATION_LOOKUP_FAILED");
    // The denial changed no counters or state.
    expect(store.getWorkItem(SESSION, workItemId)?.delegated?.recoveryHistory).toHaveLength(1);
  });

  test("an in-flight attempt suggests awaiting the result, never a rejected launch", () => {
    const opened = openDelegated({ key: "in-flight-progress" });
    if (!opened.ok) throw new Error("open failed");
    const workItemId = opened.record.workItemId;
    beginDelegatedLaunch(store, { sessionId: SESSION, workItemId, callId: "call-ifp-1" });

    const progress = summarizeDelegatedProgress(store.getWorkItem(SESSION, workItemId)!);
    expect(progress.hasInFlightAttempt).toBe(true);
    expect(progress.nextAction).toBe("await_result");
    // The same state rejects an ordinary launch.
    const rejected = beginDelegatedLaunch(store, {
      sessionId: SESSION,
      workItemId,
      callId: "call-ifp-2",
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.errorCode).toBe("ATTEMPT_IN_FLIGHT");
  });
});
// END_BLOCK_REPORT_REJECTION_TESTS
