// FILE: src/plugins/workflow/delegated.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Deterministic tests for delegated work-item attempts and explicit controller acceptance decisions.
//   SCOPE: Delegated open validation, callID-bound attempt allocation and results, two-attempt budgets, accept/request_changes decisions with concerns disposition, wrong-attempt and duplicate rejections, guarded checkpoint-authorized rework, and legacy-mode isolation.
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
//   LAST_CHANGE: [C-DELEGATED-WORKFLOW-ASTRA-PRESETS - Initial delegated-mode domain coverage including rework and legacy isolation.]
// END_CHANGE_SUMMARY

import { beforeEach, describe, expect, test } from "bun:test";
import { createWorkItemStore, type WorkItemStore } from "./state.js";
import {
  applyDelegatedResult,
  beginDelegatedLaunch,
  currentDelegatedAcceptance,
  decideDelegatedWorkItem,
  reworkDelegatedWorkItem,
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
