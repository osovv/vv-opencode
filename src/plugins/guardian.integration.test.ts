// FILE: src/plugins/guardian.integration.test.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Native-boundary tests for the Guardian permission review: denied/explicit-allow preservation, low/high/invalid verdict handling, missing family deferral, per-family policy switching, the captured fast-role auxiliary inference payload, the optional System One backend with shadow and fail-closed behavior, and lifecycle teardown.
//   SCOPE: Drive the native permission.evaluate handler through an injected review seam with pinned native event shapes; verify plugin setup registers an evaluate hook, resolves provider availability, and releases the shared runtime on cleanup.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, src/plugins/guardian/index.ts, src/lib/systemone.ts]
//   LINKS: [M-PLUGIN-GUARDIAN, V-M-PLUGIN-GUARDIAN, M-NATIVE-RUNTIME, M-SYSTEMONE-PROVIDER]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   tempDirs - Tracks temporary harness roots for cleanup.
//   makeEvent - Build a native permission.evaluate event fixture.
//   policy - Builds a Guardian review policy fixture.
//   Harness - Guardian handler test harness surface.
//   createHarness - Build handler dependencies with recording history/inference/log and an injectable transport.
//   verdict - Serialize a risk assessment verdict.
//   systemoneTransport - Build a System One transport returning fixed noul and score answers.
//   SYSTEMONE_CONNECTION - Fixed System One connection fixture.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-SYSTEMONE-DECISION-BACKEND T-004 - Added System One backend, shadow, and provider-availability coverage over the injected seam.]
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
  type GuardianRuntimeConfig,
} from "./guardian/index.js";
import type { SystemOneTransport } from "../lib/systemone.js";

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

function policy(
  threshold: number,
  familyId = "fam-1",
  overrides: Partial<GuardianRuntimeConfig> = {},
): GuardianReviewPolicy {
  return {
    familyId,
    config: {
      timeoutMs: 5_000,
      approvalRiskThreshold: threshold,
      reviewToastDurationMs: 4_000,
      decisionBackend: "fast",
      systemoneShadow: false,
      systemoneLowRiskThreshold: 0.95,
      sources: [],
      warnings: [],
      ...overrides,
    },
    prompt: "Guardian policy prompt.",
  };
}

const SYSTEMONE_CONNECTION = {
  baseUrl: "http://localhost:8790",
  model: "example",
  timeoutMs: 50,
  maxRetries: 0,
};

function systemoneTransport(noul: number, score: number): SystemOneTransport {
  return async () => ({
    status: 200,
    body: JSON.stringify({
      model: "example",
      answers: {
        low_risk: { type: "noul", noul },
        risk: { type: "score", score, probabilities: {} },
      },
    }),
  });
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
  setTransport(transport: SystemOneTransport | undefined): void;
}

function createHarness(initial?: GuardianReviewPolicy): Harness {
  const inferCalls: Harness["inferCalls"] = [];
  const logs: Harness["logs"] = [];
  let currentPolicy = initial;
  let verdict: string | undefined = undefined;
  let inferError: Error | undefined;
  let transport: SystemOneTransport | undefined;

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
    get transport() {
      return transport;
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
    setTransport(next) {
      transport = next;
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

  test("systemone backend derives the assessment and auto-approves a low-risk answer", async () => {
    const harness = createHarness(
      policy(80, "fam-s1", {
        decisionBackend: "systemone",
        systemoneLowRiskThreshold: 0.95,
        systemone: SYSTEMONE_CONNECTION,
      }),
    );
    harness.setTransport(systemoneTransport(0.99, 0));
    const handler = createGuardianEvaluateHandler(harness.deps);

    const event = makeEvent();
    await handler(event);
    expect(event.effect).toBe("allow");
    expect(harness.inferCalls).toEqual([]);
  });

  test("systemone backend defers when the low-risk probability misses the gate", async () => {
    const harness = createHarness(
      policy(80, "fam-s2", {
        decisionBackend: "systemone",
        systemoneLowRiskThreshold: 0.95,
        systemone: SYSTEMONE_CONNECTION,
      }),
    );
    harness.setTransport(systemoneTransport(0.5, 0));
    const handler = createGuardianEvaluateHandler(harness.deps);

    const event = makeEvent();
    await handler(event);
    expect(event.effect).toBe("ask");
  });

  test("systemone backend defers when the score reaches the approval threshold", async () => {
    const harness = createHarness(
      policy(80, "fam-s3", {
        decisionBackend: "systemone",
        systemoneLowRiskThreshold: 0.95,
        systemone: SYSTEMONE_CONNECTION,
      }),
    );
    harness.setTransport(systemoneTransport(0.99, 4));
    const handler = createGuardianEvaluateHandler(harness.deps);

    const event = makeEvent();
    await handler(event);
    expect(event.effect).toBe("ask");
  });

  test("systemone backend defers on provider failure or a malformed answer and never falls through to fast", async () => {
    const failing = createHarness(
      policy(80, "fam-s4", {
        decisionBackend: "systemone",
        systemone: SYSTEMONE_CONNECTION,
      }),
    );
    failing.setTransport(async () => {
      throw new Error("provider down");
    });
    const handler = createGuardianEvaluateHandler(failing.deps);
    const event = makeEvent();
    await handler(event);
    expect(event.effect).toBe("ask");
    expect(failing.inferCalls).toEqual([]);

    const malformed = createHarness(
      policy(80, "fam-s5", {
        decisionBackend: "systemone",
        systemone: SYSTEMONE_CONNECTION,
      }),
    );
    malformed.setTransport(async () => ({
      status: 200,
      body: JSON.stringify({ answers: { low_risk: { type: "noul", noul: 0.99 } } }),
    }));
    const second = makeEvent();
    await createGuardianEvaluateHandler(malformed.deps)(second);
    expect(second.effect).toBe("ask");
  });

  test("shadow mode keeps the fast backend authoritative and logs a comparison", async () => {
    const harness = createHarness(
      policy(80, "fam-shadow", {
        decisionBackend: "fast",
        systemoneShadow: true,
        systemone: SYSTEMONE_CONNECTION,
      }),
    );
    harness.setVerdict(verdict("low", 1));
    harness.setTransport(systemoneTransport(0.1, 4));
    const handler = createGuardianEvaluateHandler(harness.deps);

    const event = makeEvent();
    await handler(event);
    expect(event.effect).toBe("allow");
    expect(harness.inferCalls).toHaveLength(1);
    expect(harness.logs.some((entry) => entry.message.includes("shadow comparison"))).toBe(true);
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

  function providerVvoc(plugins: Record<string, unknown>): Record<string, unknown> {
    return {
      $schema: "test",
      version: 3,
      roles: {
        default: "openai/gpt-6-luna#low",
        smart: "openai/gpt-6-luna#low",
        fast: "openai/gpt-6-luna#low",
        reviewer: "openai/gpt-6-luna#low",
      },
      guardian: {
        timeoutMs: 1_000,
        approvalRiskThreshold: 80,
        reviewToastDurationMs: 1_000,
        decisionBackend: "systemone",
        systemone: { shadow: false, lowRiskThreshold: 0.95 },
      },
      secretsRedaction: {},
      presets: {},
      plugins,
      systemone: {
        enabled: true,
        baseUrl: "http://127.0.0.1:9",
        model: "example",
        apiKey: "${VVOC_TEST_MISSING_KEY}",
        timeoutMs: 50,
        maxRetries: 0,
      },
    };
  }

  async function runProviderHook(
    vvoc: Record<string, unknown>,
  ): Promise<GuardianPermissionEvaluation> {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-guardian-provider-"));
    tempDirs.push(directory);
    let evaluate: ((event: GuardianPermissionEvaluation) => Promise<void>) | undefined;
    const fakeRuntime = {
      snapshots: {
        configFor: async () => ({ familyId: "fam-provider", vvoc }),
        accept: async () => ({ status: "bound" }),
      },
      client: async () => ({ session: { context: async () => [] } }),
      auxiliary: {
        generate: async () => ({ text: verdict("low", 1) }),
      },
      permissions: {},
      effectiveConfig: () => ({ vvoc }),
      release: async () => {},
    };
    const plugin = createGuardianPlugin({ acquireRuntime: async () => fakeRuntime as never });
    await plugin.setup({
      location: { directory, project: { id: "p", directory, canonical: directory } },
      permission: {
        hook: async (_name: string, cb: (event: GuardianPermissionEvaluation) => Promise<void>) => {
          evaluate = cb;
          return { dispose: async () => {} };
        },
      },
    } as never);
    const event = makeEvent();
    await evaluate?.(event);
    return event;
  }

  test("an unresolved systemone apiKey disables the provider and keeps the fast backend", async () => {
    delete process.env.VVOC_TEST_MISSING_KEY;
    const event = await runProviderHook(providerVvoc({ guardian: true, systemone: true }));
    expect(event.effect).toBe("allow");
  });

  test("the systemone plugin toggle off forces the fast backend", async () => {
    process.env.VVOC_TEST_MISSING_KEY = "resolved-key";
    try {
      const event = await runProviderHook(providerVvoc({ guardian: true, systemone: false }));
      expect(event.effect).toBe("allow");
    } finally {
      delete process.env.VVOC_TEST_MISSING_KEY;
    }
  });
});
