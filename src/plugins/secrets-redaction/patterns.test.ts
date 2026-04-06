// FILE: src/plugins/secrets-redaction/patterns.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Tests for buildPatternSet and builtin patterns
//   SCOPE: pattern building, regex normalization
//   DEPENDS: patterns
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT

import { describe, expect, test } from "bun:test";
import { buildPatternSet, BUILTIN_PATTERNS } from "./patterns.js";

describe("BUILTIN_PATTERNS", () => {
  test("has all 13 expected builtin patterns", () => {
    const names = Array.from(BUILTIN_PATTERNS.keys());
    expect(names).toContain("email");
    expect(names).toContain("uuid");
    expect(names).toContain("ipv4");
    expect(names).toContain("mac");
    expect(names).toContain("openai_key");
    expect(names).toContain("anthropic_key");
    expect(names).toContain("github_token");
    expect(names).toContain("aws_access_key");
    expect(names).toContain("stripe_key");
    expect(names).toContain("bearer_token");
    expect(names).toContain("bearer_dot");
    expect(names).toContain("syn_key");
    expect(names).toContain("hex_token");
    expect(names.length).toBe(13);
  });

  test("email pattern matches standard emails", () => {
    const emailBuiltin = BUILTIN_PATTERNS.get("email")!;
    const regex = new RegExp(emailBuiltin.pattern, "i");
    expect(regex.test("user@example.com")).toBe(true);
    expect(regex.test("test.email+tag@sub.domain.org")).toBe(true);
    expect(regex.test("user123@domain.co.uk")).toBe(true);
  });

  test("uuid pattern matches standard UUIDs", () => {
    const uuidBuiltin = BUILTIN_PATTERNS.get("uuid")!;
    const regex = new RegExp(uuidBuiltin.pattern, "i");
    expect(regex.test("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(regex.test("6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe(true);
  });

  test("ipv4 pattern matches IP addresses", () => {
    const ipv4Builtin = BUILTIN_PATTERNS.get("ipv4")!;
    const regex = new RegExp(ipv4Builtin.pattern, "i");
    expect(regex.test("192.168.1.1")).toBe(true);
    expect(regex.test("10.0.0.255")).toBe(true);
    expect(regex.test("255.255.255.255")).toBe(true);
  });

  test("mac pattern matches MAC addresses", () => {
    const macBuiltin = BUILTIN_PATTERNS.get("mac")!;
    const regex = new RegExp(macBuiltin.pattern, "i");
    expect(regex.test("00:1a:2b:3c:4d:5e")).toBe(true);
    expect(regex.test("FF:FF:FF:FF:FF:FF")).toBe(true);
  });

  test("openai_key pattern matches OpenAI API keys", () => {
    const keyBuiltin = BUILTIN_PATTERNS.get("openai_key")!;
    const regex = new RegExp(keyBuiltin.pattern, "i");
    expect(regex.test("sk-1234567890abcdefghijklmnopqrstuvwxyz")).toBe(true);
    expect(regex.test("sk-proj-1234567890abcdefghijklmnopqrstu")).toBe(true);
  });

  test("github_token pattern matches GitHub tokens", () => {
    const keyBuiltin = BUILTIN_PATTERNS.get("github_token")!;
    const regex = new RegExp(keyBuiltin.pattern, "i");
    expect(regex.test("ghp_1234567890abcdefghijklmnopqrstuvwxyz")).toBe(true);
    expect(regex.test("gho_1234567890abcdefghijklmnopqrstuvwxyz")).toBe(true);
    expect(regex.test("ghu_1234567890abcdefghijklmnopqrstuvwxyz")).toBe(true);
  });

  test("aws_access_key pattern matches AWS access key IDs", () => {
    const keyBuiltin = BUILTIN_PATTERNS.get("aws_access_key")!;
    const regex = new RegExp(keyBuiltin.pattern, "i");
    expect(regex.test("AKIAIOSFODNN7EXAMPLE")).toBe(true);
    expect(regex.test("AKIAJ7XXXXXXXXXXXXXXX")).toBe(true);
  });

  test("stripe_key pattern matches Stripe live keys", () => {
    const keyBuiltin = BUILTIN_PATTERNS.get("stripe_key")!;
    expect(keyBuiltin.pattern).toBe("sk_live_[A-Za-z0-9]{24,}");
  });

  test("bearer_token pattern matches generic bearer tokens", () => {
    const keyBuiltin = BUILTIN_PATTERNS.get("bearer_token")!;
    const regex = new RegExp(keyBuiltin.pattern, "i");
    expect(regex.test("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")).toBe(true);
    expect(regex.test("abcdefghijklmnopqrstuvwxyz123456")).toBe(true);
  });
});

describe("buildPatternSet", () => {
  test("returns empty rules and exclude set for empty config", () => {
    const ps = buildPatternSet({});
    expect(ps.rules).toHaveLength(0);
    expect(ps.exclude.size).toBe(0);
  });

  test("loads all 13 builtins by default", () => {
    const ps = buildPatternSet({
      builtin: [
        "email",
        "uuid",
        "ipv4",
        "mac",
        "openai_key",
        "anthropic_key",
        "github_token",
        "aws_access_key",
        "stripe_key",
        "bearer_token",
        "bearer_dot",
        "syn_key",
        "hex_token",
      ],
    });
    expect(ps.rules).toHaveLength(13);
  });

  test("loads only specified builtins", () => {
    const ps = buildPatternSet({ builtin: ["email", "uuid"] });
    expect(ps.rules).toHaveLength(2);
  });

  test("loads custom regex patterns", () => {
    const ps = buildPatternSet({
      regex: [
        { pattern: "sk-[A-Za-z0-9]{48}", category: "OPENAI_KEY" },
        { pattern: "ghp_[A-Za-z0-9]+", category: "GITHUB_TOKEN" },
      ],
    });
    expect(ps.rules).toHaveLength(2);
    expect(ps.rules[0].category).toBe("OPENAI_KEY");
    expect(ps.rules[1].category).toBe("GITHUB_TOKEN");
  });

  test("loads custom keywords", () => {
    const ps = buildPatternSet({
      keywords: [
        { value: "my-api-key", category: "CUSTOM_KEY" },
        { value: "secret-token", category: "CUSTOM_SECRET" },
      ],
    });
    expect(ps.rules).toHaveLength(2);
    expect(ps.rules[0].category).toBe("CUSTOM_KEY");
    expect(ps.rules[1].category).toBe("CUSTOM_SECRET");
  });

  test("keywords default to KEYWORD category", () => {
    const ps = buildPatternSet({
      keywords: [{ value: "some-value" }],
    });
    expect(ps.rules[0].category).toBe("KEYWORD");
  });

  test("loads exclude list", () => {
    const ps = buildPatternSet({
      builtin: ["email"],
      exclude: ["test@example.com", "localhost"],
    });
    expect(ps.exclude.size).toBe(2);
    expect(ps.exclude.has("test@example.com")).toBe(true);
    expect(ps.exclude.has("localhost")).toBe(true);
  });

  test("combines builtins, regex, and keywords", () => {
    const ps = buildPatternSet({
      builtin: ["email"],
      regex: [{ pattern: "sk-[A-Za-z0-9]+", category: "OPENAI" }],
      keywords: [{ value: "my-key", category: "CUSTOM" }],
    });
    expect(ps.rules).toHaveLength(3);
  });

  test("ignores unknown builtin names", () => {
    const ps = buildPatternSet({ builtin: ["email", "unknown_pattern", "uuid"] });
    expect(ps.rules).toHaveLength(2);
  });
});
