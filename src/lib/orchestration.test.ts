// FILE: src/lib/orchestration.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify stable orchestration names, strict parsing, backward-compatible resolution, prompt isolation, and workflow capabilities.
//   SCOPE: Pure deterministic tests for src/lib/orchestration.ts.
//   DEPENDS: [bun:test, src/lib/orchestration.js]
//   LINKS: [M-ORCHESTRATION-PROFILES, V-M-ORCHESTRATION-PROFILES]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   [test scenarios] - Orchestration profile coverage is expressed through module-level tests.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-WORKFLOW-BOUNDED-RECOVERY-R1 - Added delegated-policy coverage distinguishing bounded recovery from session end and acceptance plus the native plan registration boundary.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_ORCHESTRATION_PROFILE,
  ORCHESTRATION_PROFILE_NAMES,
  createOrchestrationConfig,
  parseOrchestrationProfile,
  resolveOrchestrationPolicy,
} from "./orchestration.js";

// START_BLOCK_PROFILE_DOMAIN_TESTS
describe("orchestration profile domain", () => {
  test("uses stable profile names and balanced backward-compatible default", () => {
    expect(ORCHESTRATION_PROFILE_NAMES).toEqual([
      "single-session",
      "balanced",
      "orchestrated",
      "delegated",
    ]);
    expect(DEFAULT_ORCHESTRATION_PROFILE).toBe("balanced");
    expect(createOrchestrationConfig()).toEqual({ profile: "balanced" });
    expect(resolveOrchestrationPolicy({}).profile).toBe("balanced");
  });

  test("strictly parses supported values and rejects blank or unknown values", () => {
    expect(parseOrchestrationProfile(" single-session ", "test parse")).toBe("single-session");
    expect(parseOrchestrationProfile(" delegated ", "test parse")).toBe("delegated");

    for (const value of ["", "   ", "unknown", undefined]) {
      expect(() => parseOrchestrationProfile(value, "test parse")).toThrow("test parse");
      expect(() => parseOrchestrationProfile(value, "test parse")).toThrow("single-session");
      expect(() => parseOrchestrationProfile(value, "test parse")).toThrow("balanced");
      expect(() => parseOrchestrationProfile(value, "test parse")).toThrow("orchestrated");
      expect(() => parseOrchestrationProfile(value, "test parse")).toThrow("delegated");
    }
  });

  test("defaults only for an absent section and fails for an explicit incomplete section", () => {
    expect(createOrchestrationConfig(undefined)).toEqual({ profile: "balanced" });
    expect(() => createOrchestrationConfig({})).toThrow("invalid orchestration profile");
    expect(() => resolveOrchestrationPolicy({ orchestration: {} })).toThrow(
      "invalid orchestration profile",
    );
  });
});
// END_BLOCK_PROFILE_DOMAIN_TESTS

// START_BLOCK_CONCRETE_POLICY_TESTS
describe("resolved orchestration policies", () => {
  test("contains only active-profile instructions", () => {
    for (const profile of ORCHESTRATION_PROFILE_NAMES) {
      const policy = resolveOrchestrationPolicy({ orchestration: { profile } });
      expect(Object.isFrozen(policy)).toBe(true);

      for (const otherProfile of ORCHESTRATION_PROFILE_NAMES) {
        if (otherProfile !== profile) {
          expect(policy.controllerSystemContext).not.toContain(otherProfile);
        }
      }
    }
  });

  test("single-session keeps working context direct and preserves the reviewer exception", () => {
    const context = resolveOrchestrationPolicy({
      orchestration: { profile: "single-session" },
    }).controllerSystemContext;

    for (const activity of [
      "exploration",
      "investigation",
      "planning",
      "implementation",
      "verification",
    ]) {
      expect(context).toContain(activity);
    }
    expect(context).toContain("Do not delegate working context to subagents");
    expect(context).toContain("Independent reviewer subagents remain permitted");
    expect(context).toContain("validate every finding personally");
    expect(context).toMatch(/report findings and do not\s+fix them/);
  });

  test("maps profiles to workflow guidance without model inference", () => {
    expect(
      resolveOrchestrationPolicy({ orchestration: { profile: "single-session" } }).workflowGuidance,
    ).toBe("review-only");
    expect(
      resolveOrchestrationPolicy({
        orchestration: { profile: "balanced" },
        model: "ignored/provider-model",
      } as Parameters<typeof resolveOrchestrationPolicy>[0]).workflowGuidance,
    ).toBe("selective");
    expect(
      resolveOrchestrationPolicy({ orchestration: { profile: "orchestrated" } }).workflowGuidance,
    ).toBe("tracked");
    expect(
      resolveOrchestrationPolicy({ orchestration: { profile: "delegated" } }).workflowGuidance,
    ).toBe("delegated");
  });

  test("delegated keeps architecture, acceptance, and verification in the primary session", () => {
    const context = resolveOrchestrationPolicy({
      orchestration: { profile: "delegated" },
    }).controllerSystemContext;

    expect(context).toContain("Keep architecture, important code reading, task contracts");
    expect(context).toContain("Delegate source implementation, tests, runtime configuration");
    expect(context).toContain("One active implementation worker is the");
    expect(context).toContain("explicitly accept each completed attempt or request changes");
    expect(context).toContain("Spend independent review at declared plan checkpoints");
    expect(context).toContain("Do not write complete implementation");
    expect(context).toContain("do not bypass the delegation policy by rewriting source through");
    expect(context).toContain("planning artifacts under their");
    expect(context).toContain("execute verification commands");
  });

  test("delegated distinguishes bounded recovery from session end and acceptance", () => {
    const context = resolveOrchestrationPolicy({
      orchestration: { profile: "delegated" },
    }).controllerSystemContext;
    const normalized = context.replace(/\s+/g, " ");

    expect(context).toContain("workers, including small mechanical fixes");
    expect(normalized).toContain(
      "work_checkpoint registration accepts only its supported approved native plan package",
    );
    expect(normalized).toContain("foreign lifecycle plans are not");
    expect(normalized).toContain("diagnose a stopped or exhausted task");
    expect(normalized).toContain("through the session's supported recovery operation");
    expect(normalized).toContain(
      "never an unlimited retry and never a substitute for acceptance or review",
    );
    expect(normalized).toContain("A stop suspends");
    expect(normalized).toContain("it does not end the session");
  });
});
// END_BLOCK_CONCRETE_POLICY_TESTS
