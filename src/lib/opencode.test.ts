import { describe, expect, test } from "bun:test";
import { parse } from "jsonc-parser";
import {
  OPENCODE_SCHEMA_URL,
  PACKAGE_NAME,
  ensurePackageConfigText,
  parseGuardianConfigText,
  renderGuardianConfig,
} from "./opencode.js";

describe("ensurePackageConfigText", () => {
  test("creates a new config when none exists", () => {
    const output = ensurePackageConfigText();
    const parsed = parse(output) as { $schema?: string; plugin?: string[] };

    expect(parsed.$schema).toBe(OPENCODE_SCHEMA_URL);
    expect(parsed.plugin).toEqual([PACKAGE_NAME]);
  });

  test("preserves comments while appending the plugin", () => {
    const input = `{
  // existing plugin comment
  "plugin": ["foo"]
}\n`;
    const output = ensurePackageConfigText(input);
    const parsed = parse(output) as { plugin?: string[] };

    expect(output).toContain("// existing plugin comment");
    expect(parsed.plugin).toEqual(["foo", PACKAGE_NAME]);
  });
});

describe("guardian config helpers", () => {
  test("round-trips managed guardian config values", () => {
    const output = renderGuardianConfig({
      model: "anthropic/claude-sonnet-4-5",
      variant: "high",
      timeoutMs: 12_345,
      approvalRiskThreshold: 55,
      reviewToastDurationMs: 6_789,
    });
    const parsed = parseGuardianConfigText(output, "test guardian config");

    expect(parsed).toEqual({
      model: "anthropic/claude-sonnet-4-5",
      variant: "high",
      timeoutMs: 12_345,
      approvalRiskThreshold: 55,
      reviewToastDurationMs: 6_789,
    });
  });
});
