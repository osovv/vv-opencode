// FILE: src/tui/policy.test.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the selection-keyed policy controller quarantines a previous selection's snapshot, discards stale replies, publishes explicit unavailable snapshots, and exposes safe predicates.
//   SCOPE: Pure controller and predicate tests with deferred fetches; no host or renderer.
//   DEPENDS: [bun:test, src/tui/policy.ts, src/runtime/context-inspection-contract.ts]
//   LINKS: [V-M-PLUGIN-CONTEXT-TUI, DF-CONTEXT-INSPECTION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   LOCALS: policy, deferred
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-008 attempt 2 - Added selection-key quarantine and stale-reply coverage.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import type { ContextInspectionPolicy } from "../runtime/context-inspection-contract.js";
import {
  createPolicyController,
  createRpcPolicyFetch,
  isResolvedPolicy,
  policyAnalyticsEnabled,
  policyContextEnabled,
  policyContextSuppressed,
  policyPeakHours,
  policyUnavailableReason,
} from "./policy.js";

type PolicyInput = {
  scope?: "family" | "current-runtime";
  contextEnabled?: boolean;
  analyticsEnabled?: boolean;
};

function policy(overrides: PolicyInput = {}): ContextInspectionPolicy {
  return {
    status: "available",
    scope: "family",
    contextEnabled: true,
    analyticsEnabled: true,
    peakHours: { enabled: true, mode: "soft", graceActiveSessions: true, schedules: {} },
    provenance: { familyId: "f", snapshotId: "s", capturedAt: 1, location: { directory: "/x" } },
    ...overrides,
  } as ContextInspectionPolicy;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("createPolicyController", () => {
  test("quarantines the previous selection immediately and discards its stale reply", async () => {
    const first = deferred<ContextInspectionPolicy | undefined>();
    const second = deferred<ContextInspectionPolicy | undefined>();
    const controller = createPolicyController((selection) =>
      selection.sessionID === "ses_old" ? first.promise : second.promise,
    );

    const oldRefresh = controller.refresh({ sessionID: "ses_old", directory: "/a" });
    const newRefresh = controller.refresh({ sessionID: "ses_new", directory: "/b" });
    // The new selection quarantines the old one before its own reply lands.
    expect(controller.current()?.status).toBe("loading");

    second.resolve(policy({ contextEnabled: false }));
    await newRefresh;
    expect(controller.current()).toMatchObject({ contextEnabled: false });

    first.resolve(policy({ contextEnabled: true }));
    await oldRefresh;
    expect(controller.current()).toMatchObject({ contextEnabled: false });
  });

  test("treats a location-only move with the same session id as a new selection", async () => {
    const controller = createPolicyController(async () => policy());
    await controller.refresh({ sessionID: "ses_1", directory: "/a" });
    expect(controller.current()?.status).toBe("available");
    const move = controller.refresh({ sessionID: "ses_1", directory: "/b" });
    expect(controller.current()?.status).toBe("loading");
    await move;
    expect(controller.current()?.status).toBe("available");
  });

  test("turns a rejected fetch into an explicit unavailable snapshot", async () => {
    const controller = createPolicyController(async () => {
      throw new Error("rpc unavailable");
    });
    await controller.refresh({ sessionID: "ses_1", directory: "/a" });
    expect(controller.current()).toEqual({
      status: "unavailable",
      scope: "family",
      error: "inspection_internal_error",
    });
  });

  test("publishes to subscribers and stops after dispose", async () => {
    const controller = createPolicyController(async () => policy());
    const seen: Array<string | undefined> = [];
    controller.subscribe((snapshot) => seen.push(snapshot?.status));
    await controller.refresh({ sessionID: "ses_1", directory: "/a" });
    expect(seen).toEqual(["loading", "available"]);
    controller.dispose();
    await controller.refresh({ sessionID: "ses_1", directory: "/a" });
    expect(seen).toEqual(["loading", "available"]);
  });
});

describe("createRpcPolicyFetch", () => {
  const result = (directory: string) => ({
    version: 1,
    status: "complete",
    location: { directory, projectID: "p" },
    observedAt: 1,
    policy: {
      status: "available",
      scope: "family",
      contextEnabled: true,
      analyticsEnabled: true,
      peakHours: { enabled: false, mode: "soft", graceActiveSessions: true, schedules: {} },
      provenance: {
        familyId: "f",
        snapshotId: "s",
        capturedAt: 1,
        location: { directory: "/moved" },
      },
    },
    warnings: [],
  });

  test("rejects a reply whose serving location does not match the selected directory", async () => {
    const fetchPolicy = createRpcPolicyFetch(async (_input, options) => {
      // The reply is for a different serving location than requested.
      expect(options.location.directory).toBe("/selected");
      return result("/other");
    });
    expect(await fetchPolicy({ sessionID: "ses_1", directory: "/selected" })).toBeUndefined();
  });

  test("accepts a reply for the requested selected directory even when the capture origin moved", async () => {
    const fetchPolicy = createRpcPolicyFetch(async () => result("/selected"));
    const policy = await fetchPolicy({ sessionID: "ses_1", directory: "/selected" });
    expect(policy?.status).toBe("available");
    if (policy?.status !== "available") return;
    expect(policy.provenance.location.directory).toBe("/moved");
  });

  test("rejects a malformed reply and requests no catalog", async () => {
    const seen: Array<{ includeCatalog?: boolean }> = [];
    const fetchPolicy = createRpcPolicyFetch(async (input) => {
      seen.push({
        ...(input.includeCatalog === undefined ? {} : { includeCatalog: input.includeCatalog }),
      });
      return { not: "a result" };
    });
    expect(await fetchPolicy({ directory: "/selected" })).toBeUndefined();
    expect(seen).toEqual([{ includeCatalog: false }]);
  });
});

describe("policy predicates", () => {
  test("loading and unavailable snapshots do not suppress the context command", () => {
    const unavailable: ContextInspectionPolicy = {
      status: "unavailable",
      scope: "family",
      error: "policy_capture_missing",
    };
    expect(isResolvedPolicy(unavailable)).toBe(true);
    expect(policyContextSuppressed(undefined)).toBe(false);
    expect(policyContextSuppressed({ status: "loading", scope: "family" })).toBe(false);
    expect(policyContextSuppressed(unavailable)).toBe(false);
    expect(policyContextEnabled(unavailable)).toBe(false);
    expect(policyUnavailableReason(unavailable)).toBe("policy_capture_missing");
  });

  test("only an explicit disable suppresses the context command", () => {
    expect(policyContextSuppressed(policy({ contextEnabled: false }))).toBe(true);
    expect(policyContextEnabled(policy())).toBe(true);
  });

  test("loading suppresses analytics/peak effects and a preview exposes peak hours", () => {
    expect(policyAnalyticsEnabled({ status: "loading", scope: "family" })).toBe(false);
    expect(policyPeakHours({ status: "loading", scope: "family" })).toBeUndefined();
    const preview: ContextInspectionPolicy = {
      status: "preview",
      scope: "current-runtime",
      contextEnabled: true,
      analyticsEnabled: false,
      peakHours: { enabled: true, mode: "hard", graceActiveSessions: false, schedules: {} },
    };
    expect(policyContextEnabled(preview)).toBe(true);
    expect(policyAnalyticsEnabled(preview)).toBe(false);
    expect(policyPeakHours(preview)?.mode).toBe("hard");
  });
});
