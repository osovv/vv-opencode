// FILE: src/plugins/secrets-redaction/patterns.test.ts
// VERSION: 1.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Tests for buildPatternSet and builtin patterns
//   SCOPE: pattern building, regex normalization
//   DEPENDS: patterns
//   LINKS: [M-PLUGIN-SECRETS-REDACTION, V-M-PLUGIN-SECRETS-REDACTION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   [test scenarios] - Secret-pattern coverage is expressed through module-level tests.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [secrets reliability overhaul - Covered the two new context-scoped builtins (bearer_auth group isolation, jwt shape) with identifier/UUID/dated-slug counterexamples, keyword caseSensitive semantics, case-insensitive exclude normalization, and the 15-name registry invariant (13 legacy opt-ins preserved).]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { buildPatternSet, BUILTIN_PATTERNS } from "./patterns.js";

describe("BUILTIN_PATTERNS", () => {
  test("keeps all 13 legacy builtin patterns valid as opt-ins", () => {
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
    expect(names.length).toBe(15);
  });

  test("adds the credential-first context-scoped builtins", () => {
    expect(BUILTIN_PATTERNS.get("bearer_auth")).toBeDefined();
    expect(BUILTIN_PATTERNS.get("bearer_auth")!.group).toBe(1);
    expect(BUILTIN_PATTERNS.get("jwt")).toBeDefined();
    expect(BUILTIN_PATTERNS.get("jwt")!.group).toBeUndefined();
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

  test("bearer_token does NOT match long .md filenames", () => {
    const keyBuiltin = BUILTIN_PATTERNS.get("bearer_token")!;
    const regex = new RegExp(keyBuiltin.pattern, "i");
    // 32+ char filename with .md extension should NOT trigger bearer_token
    expect(regex.test("batch-form-migration-requirements.md")).toBe(false);
    expect(regex.test("very-long-planning-document-name-here-123.md")).toBe(false);
    // But bare long tokens still match
    expect(regex.test("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")).toBe(true);
    expect(regex.test("abcdefghijklmnopqrstuvwxyz123456")).toBe(true);
  });

  test("bearer_auth matches a Bearer credential and isolates the token in group 1", () => {
    const builtin = BUILTIN_PATTERNS.get("bearer_auth")!;
    const regex = new RegExp(builtin.pattern, "di");
    const match = regex.exec("Authorization: Bearer abc123def456ghi789jkl012");
    expect(match).not.toBeNull();
    expect(match![1]).toBe("abc123def456ghi789jkl012");
    expect(match![0]).toBe("Bearer abc123def456ghi789jkl012");
    expect(match!.indices![1]).toBeDefined();
  });

  test("bearer_auth matches lowercase bearer and url-safe token alphabets", () => {
    const builtin = BUILTIN_PATTERNS.get("bearer_auth")!;
    const regex = new RegExp(builtin.pattern, "i");
    expect(regex.test("bearer abc123def456ghi789jkl012")).toBe(true);
    expect(regex.test("Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6-JmQ")).toBe(true);
    expect(regex.test("Bearer base64+slash_equal-abc20+")).toBe(true);
  });

  test("bearer_auth does NOT match ordinary long identifiers without a Bearer context", () => {
    const builtin = BUILTIN_PATTERNS.get("bearer_auth")!;
    const regex = new RegExp(builtin.pattern, "i");
    expect(regex.test("tool-output-redaction-and-truncated-results")).toBe(false);
    expect(regex.test("M-PLUGIN-SYSTEM-CONTEXT-INJECTION")).toBe(false);
    expect(regex.test("APPLICATIONINSIGHTS_CONNECTION_STRING")).toBe(false);
    expect(regex.test("2026-11-09-meeting-notes-and-agenda")).toBe(false);
    expect(regex.test("550e8400-e29b-41d4-a716-446655440000")).toBe(false);
  });

  test("jwt matches compact JWS tokens only", () => {
    const builtin = BUILTIN_PATTERNS.get("jwt")!;
    const regex = new RegExp(builtin.pattern, "i");
    expect(
      regex.test("token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4"),
    ).toBe(true);
    // Ordinary identifiers, directories and UUIDs never look like a JWS.
    expect(regex.test("M-PLUGIN-SYSTEM-CONTEXT-INJECTION")).toBe(false);
    expect(regex.test("550e8400-e29b-41d4-a716-446655440000")).toBe(false);
    expect(regex.test("2026-11-09-meeting-notes-and-agenda")).toBe(false);
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

  test("loads the credential-first opt-ins bearer_auth and jwt with group metadata", () => {
    const ps = buildPatternSet({ builtin: ["bearer_auth", "jwt"] });
    expect(ps.rules).toHaveLength(2);
    expect(ps.rules[0]!.category).toBe("BEARER_AUTH");
    expect(ps.rules[0]!.group).toBe(1);
    expect(ps.rules[1]!.category).toBe("JWT");
    expect(ps.rules[1]!.group).toBeUndefined();
  });

  test("keyword rules are case-insensitive unless caseSensitive is set", () => {
    const insensitive = buildPatternSet({ keywords: [{ value: "ApiKeyAbc" }] });
    expect(insensitive.rules[0]!.pattern.test("the apikeyabc value")).toBe(true);

    const sensitive = buildPatternSet({
      keywords: [{ value: "ApiKeyAbc", category: "WEB_API_KEY", caseSensitive: true }],
    });
    expect(sensitive.rules[0]!.pattern.test("the ApiKeyAbc value")).toBe(true);
    expect(sensitive.rules[0]!.pattern.test("the apikeyabc value")).toBe(false);
  });

  test("exclude entries are matched case-insensitively", () => {
    const ps = buildPatternSet({
      builtin: ["email"],
      exclude: ["TEST@EXAMPLE.INVALID"],
    });
    expect(ps.exclude.has("test@example.invalid")).toBe(true);
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
