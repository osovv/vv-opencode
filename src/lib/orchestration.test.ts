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
//   profile domain tests - Stable names, absent-section fallback, and strict explicit parsing.
//   concrete policy tests - Active-only controller text, reviewer exception, and workflow capability mapping.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-PRESET-ORCHESTRATION-PROFILES - Added focused regression coverage for the orchestration profile domain.]
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
    expect(ORCHESTRATION_PROFILE_NAMES).toEqual(["single-session", "balanced", "orchestrated"]);
    expect(DEFAULT_ORCHESTRATION_PROFILE).toBe("balanced");
    expect(createOrchestrationConfig()).toEqual({ profile: "balanced" });
    expect(resolveOrchestrationPolicy({}).profile).toBe("balanced");
  });

  test("strictly parses supported values and rejects blank or unknown values", () => {
    expect(parseOrchestrationProfile(" single-session ", "test parse")).toBe("single-session");

    for (const value of ["", "   ", "unknown", undefined]) {
      expect(() => parseOrchestrationProfile(value, "test parse")).toThrow("test parse");
      expect(() => parseOrchestrationProfile(value, "test parse")).toThrow("single-session");
      expect(() => parseOrchestrationProfile(value, "test parse")).toThrow("balanced");
      expect(() => parseOrchestrationProfile(value, "test parse")).toThrow("orchestrated");
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
  });
});
// END_BLOCK_CONCRETE_POLICY_TESTS
