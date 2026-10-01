// FILE: src/plugins/guardian.integration.test.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Native-boundary tests for the Guardian permission review: denied/explicit-allow preservation, low/high/invalid verdict handling, missing family deferral, per-family policy switching, the captured fast-role auxiliary inference payload, and lifecycle teardown.
//   SCOPE: Drive the native permission.evaluate handler through an injected review seam with pinned native event shapes; verify plugin setup registers an evaluate hook and releases the shared runtime on cleanup.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, src/plugins/guardian/index.ts]
//   LINKS: [M-PLUGIN-GUARDIAN, V-M-PLUGIN-GUARDIAN, M-NATIVE-RUNTIME]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   tempDirs - Tracks temporary harness roots for cleanup.
//   makeEvent - Build a native permission.evaluate event fixture.
//   policy - Builds a Guardian review policy fixture.
//   Harness - Guardian handler test harness surface.
//   createHarness - Build handler dependencies with recording history/inference/log.
//   verdict - Serialize a risk assessment verdict.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-005 - Rewrote V1 agent-config/permission.reply/subprocess tests as native permission.evaluate handler tests with an injected auxiliary inference seam.]
// END_CHANGE_SUMMARY

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGuardianEvaluateHandler,
  createGuardianPlugin,
  type GuardianPermissionEvaluation,
  type GuardianReviewDependencies,
  type GuardianReviewPolicy,
} from "./guardian/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function makeEvent(
  overrides: Partial<GuardianPermissionEvaluation> = {},
): GuardianPermissionEvaluation {
  return {
    sessionID: "s1",
    agent: "vv-build",
    action: "bash",
    resources: ["rm -rf /tmp/x"],
    metadata: { tool: "bash" },
    source: { type: "tool", messageID: "m1", id: "c1" },
    effect: "ask",
    ...overrides,
  };
}

function policy(threshold: number, familyId = "fam-1"): GuardianReviewPolicy {
  return {
    familyId,
    config: {
      timeoutMs: 5_000,
      approvalRiskThreshold: threshold,
      reviewToastDurationMs: 4_000,
      sources: [],
      warnings: [],
    },
    prompt: "Guardian policy prompt.",
  };
}

interface Harness {
  deps: GuardianReviewDependencies;
  readonly inferCalls: Array<{
    sessionID: string;
    prompt: string;
    role: string;
    timeoutMs: number;
  }>;
  readonly logs: Array<{ level: string; message: string }>;
  setVerdict(text: string | undefined): void;
  setPolicy(p: GuardianReviewPolicy | undefined): void;
  setInferError(error: Error | undefined): void;
}

function createHarness(initial?: GuardianReviewPolicy): Harness {
  const inferCalls: Harness["inferCalls"] = [];
  const logs: Harness["logs"] = [];
  let currentPolicy = initial;
  let verdict: string | undefined = undefined;
  let inferError: Error | undefined;

  const deps: GuardianReviewDependencies = {
    async policyFor() {
      return currentPolicy;
    },
    async history() {
      return { lines: ["[1] user: do a thing", "[2] tool: bash echoed hello"] };
    },
    async infer(input) {
      inferCalls.push(input);
      if (inferError) throw inferError;
      return verdict;
    },
    log(event) {
      logs.push({ level: event.level, message: event.message });
    },
  };

  return {
    deps,
    inferCalls,
    logs,
    setVerdict(text) {
      verdict = text;
    },
    setPolicy(p) {
      currentPolicy = p;
    },
    setInferError(error) {
      inferError = error;
    },
  };
}

function verdict(riskLevel: string, riskScore: number): string {
  return JSON.stringify({ risk_level: riskLevel, risk_score: riskScore, rationale: "assessed" });
}

describe("Guardian native permission evaluate", () => {
  test("never overrides an explicit deny or an existing allow", async () => {
    const harness = createHarness(policy(50));
    harness.setVerdict(verdict("low", 1));
    const handler = createGuardianEvaluateHandler(harness.deps);

    const denied = makeEvent({ effect: "deny" });
    await handler(denied);
    expect(denied.effect).toBe("deny");

    const allowed = makeEvent({ effect: "allow" });
    await handler(allowed);
    expect(allowed.effect).toBe("allow");
    expect(harness.inferCalls).toEqual([]);
  });

  test("auto-approves only a bounded low-risk verdict below the captured threshold", async () => {
    const harness = createHarness(policy(50));
    harness.setVerdict(verdict("low", 10));
    const handler = createGuardianEvaluateHandler(harness.deps);

    const event = makeEvent();
    await handler(event);
    expect(event.effect).toBe("allow");
    expect(harness.logs.some((entry) => entry.message.includes("auto-approved"))).toBe(true);
  });

  test("defers a high risk level even when the score is low", async () => {
    const harness = createHarness(policy(50));
    harness.setVerdict(verdict("high", 1));
    const handler = createGuardianEvaluateHandler(harness.deps);

    const event = makeEvent();
    await handler(event);
    expect(event.effect).toBe("ask");
  });

  test("defers a low risk level whose score is at or above the threshold", async () => {
    const harness = createHarness(policy(50));
    harness.setVerdict(verdict("low", 75));
    const handler = createGuardianEvaluateHandler(harness.deps);

    const event = makeEvent();
    await handler(event);
    expect(event.effect).toBe("ask");
  });

  test("defers invalid or incomplete verdicts; never allows", async () => {
    const harness = createHarness(policy(90));
    const handler = createGuardianEvaluateHandler(harness.deps);

    for (const invalid of [
      "not json at all",
      JSON.stringify({ risk_level: "low" }),
      JSON.stringify({ risk_score: 1, rationale: "" }),
      JSON.stringify({ risk_level: "low", risk_score: "1", rationale: "x" }),
    ]) {
      harness.setVerdict(invalid);
      const event = makeEvent();
      await handler(event);
      expect(event.effect).toBe("ask");
    }
  });

  test("defers when inference fails or produces no output", async () => {
    const harness = createHarness(policy(50));
    const handler = createGuardianEvaluateHandler(harness.deps);

    harness.setInferError(new Error("auxiliary unavailable"));
    const failing = makeEvent();
    await handler(failing);
    expect(failing.effect).toBe("ask");
    expect(harness.logs.some((entry) => entry.level === "error")).toBe(true);

    harness.setInferError(undefined);
    harness.setVerdict(undefined);
    const empty = makeEvent();
    await handler(empty);
    expect(empty.effect).toBe("ask");
  });

  test("defers when no family policy is bound and never infers", async () => {
    const harness = createHarness(undefined);
    harness.setVerdict(verdict("low", 1));
    const handler = createGuardianEvaluateHandler(harness.deps);

    const event = makeEvent();
    await handler(event);
    expect(event.effect).toBe("ask");
    expect(harness.inferCalls).toEqual([]);
  });

  test("uses the captured fast role and actual action/resources/source in the payload", async () => {
    const harness = createHarness(policy(50));
    harness.setVerdict(verdict("low", 5));
    const handler = createGuardianEvaluateHandler(harness.deps);

    const event = makeEvent({
      action: "edit",
      resources: ["/repo/src/a.ts"],
      source: { type: "tool", messageID: "m9", id: "c9" },
    });
    await handler(event);

    expect(harness.inferCalls).toHaveLength(1);
    const call = harness.inferCalls[0]!;
    expect(call.role).toBe("fast");
    expect(call.sessionID).toBe("s1");
    expect(call.timeoutMs).toBe(5_000);
    expect(call.prompt).toContain("edit");
    expect(call.prompt).toContain("/repo/src/a.ts");
    expect(call.prompt).toContain("m9");
  });

  test("applies each session's own captured threshold (policy switch old/new)", async () => {
    const harness = createHarness(policy(20, "old-family"));
    harness.setVerdict(verdict("low", 30));
    const handler = createGuardianEvaluateHandler(harness.deps);

    const strict = makeEvent({ sessionID: "old" });
    await handler(strict);
    expect(strict.effect).toBe("ask");

    harness.setPolicy(policy(80, "new-family"));
    const relaxed = makeEvent({ sessionID: "new" });
    await handler(relaxed);
    expect(relaxed.effect).toBe("allow");
  });

  test("setup registers evaluate and tears down the runtime registration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-guardian-"));
    tempDirs.push(directory);
    let disposed = false;
    let released = false;
    let hookName: string | undefined;
    const fakeRuntime = {
      snapshots: {
        configFor: async () => undefined,
        accept: async () => ({ status: "unbound" }),
      },
      client: async () => ({ session: { context: async () => [] } }),
      auxiliary: { generate: async () => ({ text: "{}" }) },
      permissions: {},
      effectiveConfig: () => ({ vvoc: {} }),
      release: async () => {
        released = true;
      },
    };
    const plugin = createGuardianPlugin({
      acquireRuntime: async () => fakeRuntime as never,
    });
    const cleanup = await plugin.setup({
      location: { directory, project: { id: "proj", directory, canonical: directory } },
      permission: {
        hook: async (name: string) => {
          hookName = name;
          return {
            dispose: async () => {
              disposed = true;
            },
          };
        },
      },
    } as never);

    expect(hookName).toBe("evaluate");
    await cleanup?.();
    expect(disposed).toBe(true);
    expect(released).toBe(true);
  });
});
