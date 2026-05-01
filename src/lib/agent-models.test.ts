// FILE: src/lib/agent-models.test.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify agent-models constants, type guards, model parsing, and formatting helpers.
//   SCOPE: Deterministic assertions for SPECIAL_AGENT_NAMES, OPENCODE_DEFAULT_MODEL_TARGETS, CONFIGURABLE_OPENCODE_AGENTS, SUPPORTED_MODEL_TARGET_NAMES, type guards, parseModelTargetName, parseModelArg, normalizeModelTargetOverride, and formatAgentModel.
//   DEPENDS: [src/lib/agent-models.ts, bun:test]
//   LINKS: [M-CLI-AGENT-MODELS]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   (tests) - Deterministic assertions for agent-models exports.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Initial GRACE compliance: added test coverage for all exports.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import {
  SPECIAL_AGENT_NAMES,
  OPENCODE_DEFAULT_MODEL_TARGETS,
  CONFIGURABLE_OPENCODE_PRIMARY_AGENTS,
  CONFIGURABLE_OPENCODE_SUBAGENTS,
  CONFIGURABLE_OPENCODE_AGENTS,
  SUPPORTED_MODEL_TARGET_NAMES,
  MODEL_TARGET_NAME_CHOICES,
  isSpecialAgentName,
  isOpenCodeDefaultModelTargetName,
  isConfigurableOpenCodeSubagentName,
  isConfigurableOpenCodeAgentName,
  parseModelTargetName,
  parseModelArg,
  normalizeModelTargetOverride,
  formatAgentModel,
} from "./agent-models.js";

describe("agent-models constants", () => {
  test("SPECIAL_AGENT_NAMES contains guardian", () => {
    expect(SPECIAL_AGENT_NAMES).toEqual(["guardian"]);
  });

  test("OPENCODE_DEFAULT_MODEL_TARGETS lists top-level model fields", () => {
    expect(OPENCODE_DEFAULT_MODEL_TARGETS).toEqual(["default", "small-model"]);
  });

  test("CONFIGURABLE_OPENCODE_PRIMARY_AGENTS lists primary agent names", () => {
    expect(CONFIGURABLE_OPENCODE_PRIMARY_AGENTS).toEqual(["build", "plan"]);
  });

  test("CONFIGURABLE_OPENCODE_SUBAGENTS lists subagent names", () => {
    expect(CONFIGURABLE_OPENCODE_SUBAGENTS).toEqual(["general", "explore"]);
  });

  test("CONFIGURABLE_OPENCODE_AGENTS merges primary and subagents", () => {
    expect(CONFIGURABLE_OPENCODE_AGENTS).toEqual(["build", "plan", "general", "explore"]);
  });

  test("SUPPORTED_MODEL_TARGET_NAMES contains all known targets", () => {
    expect(SUPPORTED_MODEL_TARGET_NAMES).toContain("guardian");
    expect(SUPPORTED_MODEL_TARGET_NAMES).toContain("default");
    expect(SUPPORTED_MODEL_TARGET_NAMES).toContain("small-model");
    expect(SUPPORTED_MODEL_TARGET_NAMES).toContain("build");
    expect(SUPPORTED_MODEL_TARGET_NAMES).toContain("plan");
    expect(SUPPORTED_MODEL_TARGET_NAMES).toContain("general");
    expect(SUPPORTED_MODEL_TARGET_NAMES).toContain("explore");
  });

  test("MODEL_TARGET_NAME_CHOICES is a non-empty comma-joined string", () => {
    expect(typeof MODEL_TARGET_NAME_CHOICES).toBe("string");
    expect(MODEL_TARGET_NAME_CHOICES.length).toBeGreaterThan(0);
    expect(MODEL_TARGET_NAME_CHOICES).toContain(",");
  });
});

describe("type guards", () => {
  test("isSpecialAgentName returns true for guardian", () => {
    expect(isSpecialAgentName("guardian")).toBe(true);
  });

  test("isSpecialAgentName returns false for non-special names", () => {
    expect(isSpecialAgentName("default")).toBe(false);
    expect(isSpecialAgentName("unknown")).toBe(false);
  });

  test("isOpenCodeDefaultModelTargetName returns true for default", () => {
    expect(isOpenCodeDefaultModelTargetName("default")).toBe(true);
  });

  test("isOpenCodeDefaultModelTargetName returns true for small-model", () => {
    expect(isOpenCodeDefaultModelTargetName("small-model")).toBe(true);
  });

  test("isOpenCodeDefaultModelTargetName returns false for non-default targets", () => {
    expect(isOpenCodeDefaultModelTargetName("build")).toBe(false);
  });

  test("isConfigurableOpenCodeSubagentName returns true for general and explore", () => {
    expect(isConfigurableOpenCodeSubagentName("general")).toBe(true);
    expect(isConfigurableOpenCodeSubagentName("explore")).toBe(true);
  });

  test("isConfigurableOpenCodeSubagentName returns false for primary agents", () => {
    expect(isConfigurableOpenCodeSubagentName("build")).toBe(false);
  });

  test("isConfigurableOpenCodeAgentName returns true for all configurable agents", () => {
    expect(isConfigurableOpenCodeAgentName("build")).toBe(true);
    expect(isConfigurableOpenCodeAgentName("plan")).toBe(true);
    expect(isConfigurableOpenCodeAgentName("general")).toBe(true);
    expect(isConfigurableOpenCodeAgentName("explore")).toBe(true);
  });

  test("isConfigurableOpenCodeAgentName returns false for non-configurable names", () => {
    expect(isConfigurableOpenCodeAgentName("guardian")).toBe(false);
    expect(isConfigurableOpenCodeAgentName("default")).toBe(false);
  });
});

describe("parseModelTargetName", () => {
  test("returns a known target name unchanged", () => {
    expect(parseModelTargetName("default", "test")).toBe("default");
    expect(parseModelTargetName("guardian", "test")).toBe("guardian");
    expect(parseModelTargetName("build", "test")).toBe("build");
  });

  test("throws for unknown target name", () => {
    expect(() => parseModelTargetName("unknown-target", "test")).toThrow();
  });

  test("throws for empty string", () => {
    expect(() => parseModelTargetName("", "test")).toThrow();
    expect(() => parseModelTargetName("  ", "test")).toThrow();
  });

  test("throws for non-string value", () => {
    expect(() => parseModelTargetName(null, "test")).toThrow();
    expect(() => parseModelTargetName(undefined, "test")).toThrow();
    expect(() => parseModelTargetName(123, "test")).toThrow();
  });
});

describe("parseModelArg", () => {
  test("returns valid provider/model string unchanged", () => {
    expect(parseModelArg("openai/gpt-4", "test")).toBe("openai/gpt-4");
    expect(parseModelArg("anthropic/claude-3", "test")).toBe("anthropic/claude-3");
  });

  test("throws for missing forward slash", () => {
    expect(() => parseModelArg("justamodel", "test")).toThrow("provider/model");
    expect(() => parseModelArg("no-slash-here", "test")).toThrow("provider/model");
  });

  test("throws for empty string", () => {
    expect(() => parseModelArg("", "test")).toThrow("model argument required");
    expect(() => parseModelArg("  ", "test")).toThrow();
  });

  test("throws for non-string value", () => {
    expect(() => parseModelArg(null, "test")).toThrow();
    expect(() => parseModelArg(undefined, "test")).toThrow();
  });
});

describe("normalizeModelTargetOverride", () => {
  test("delegates to parseModelArg and returns validated model", () => {
    expect(normalizeModelTargetOverride("default", "openai/gpt-4", "test")).toBe("openai/gpt-4");
    expect(normalizeModelTargetOverride("build", "anthropic/claude-3", "test")).toBe(
      "anthropic/claude-3",
    );
  });

  test("throws for invalid model format", () => {
    expect(() => normalizeModelTargetOverride("default", "bad-format", "test")).toThrow();
  });

  test("throws for missing model value", () => {
    expect(() => normalizeModelTargetOverride("default", "", "test")).toThrow();
  });
});

describe("formatAgentModel", () => {
  test("returns 'default' when model is undefined", () => {
    expect(formatAgentModel()).toBe("default");
  });

  test("returns 'default' when model is empty string", () => {
    expect(formatAgentModel("")).toBe("default");
  });

  test("returns model string unchanged when provided", () => {
    expect(formatAgentModel("openai/gpt-4")).toBe("openai/gpt-4");
    expect(formatAgentModel("anthropic/claude-3-opus")).toBe("anthropic/claude-3-opus");
  });
});
