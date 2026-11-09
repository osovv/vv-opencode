// FILE: src/plugins/secrets-redaction/patterns.ts
// VERSION: 1.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Builds the internal pattern set from config — keywords, regex rules, and builtin patterns.
//   SCOPE: pattern parsing, normalization, deduplication; capture-group (context-anchored) builtin
//          rules that redact only the credential span; keyword case sensitivity; exclude
//          normalization to a lowercased set
//   DEPENDS: node:crypto (for hashing)
//   LINKS: [M-PLUGIN-SECRETS-REDACTION]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   buildPatternSet - builds pattern set from config object
//   BUILTIN_PATTERNS - Map of 15 builtin pattern definitions (13 legacy opt-ins + bearer_auth + jwt)
//   PatternRule - Individual pattern matching rule.
//   PatternSet - Group of related pattern rules.
//   PatternsConfig - Patterns configuration schema.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [secrets reliability overhaul - Credentials-first defaults became two new context-scoped builtins (bearer_auth redacts only the token after a Bearer prefix via capture group; jwt matches compact JWS) while every legacy builtin keeps its exact prior semantics as an opt-in; keyword rules gained optional caseSensitive (default case-insensitive, unchanged) and the exclude set is lowercased at build so exclusion is genuinely case-insensitive.]
// END_CHANGE_SUMMARY

export interface PatternRule {
  pattern: RegExp;
  category: string;
  /**
   * 1-based capture group holding the credential when the pattern is
   * context-anchored (for example the token after a `Bearer ` prefix). When
   * set, only that group's span is redacted and the rest of the match text is
   * preserved verbatim.
   */
  group?: number;
}

export interface PatternSet {
  rules: PatternRule[];
  /** Lowercased values; exclusion compares lowercased matched values. */
  exclude: Set<string>;
}

export interface PatternsConfig {
  keywords?: Array<{ value: string; category?: string; caseSensitive?: boolean }>;
  regex?: Array<{ pattern: string; category: string }>;
  builtin?: string[];
  exclude?: string[];
}

/**
 * Built-in pattern registry. All 13 legacy names keep their exact prior
 * semantics and stay valid as opt-ins; `bearer_auth` and `jwt` are the
 * credential-oriented context-scoped patterns used by the default policy.
 * `group` marks a context-anchored pattern whose capture group 1 holds the
 * credential span.
 */
const BUILTIN_PATTERNS: Map<string, { pattern: string; category: string; group?: number }> =
  new Map([
    ["email", { pattern: "[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}", category: "EMAIL" }],
    [
      "uuid",
      {
        pattern:
          "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}",
        category: "UUID",
      },
    ],
    ["ipv4", { pattern: "(?:\\d{1,3}\\.){3}\\d{1,3}", category: "IPV4" }],
    ["mac", { pattern: "(?:[0-9a-f]{2}:){5}[0-9a-f]{2}", category: "MAC" }],
    ["openai_key", { pattern: "sk-[A-Za-z0-9_-]{32,}", category: "OPENAI_KEY" }],
    ["anthropic_key", { pattern: "sk-ant-[A-Za-z0-9_-]{32,}", category: "ANTHROPIC_KEY" }],
    [
      "github_token",
      { pattern: "(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_-]{36,}", category: "GITHUB_TOKEN" },
    ],
    ["aws_access_key", { pattern: "AKIA[0-9A-Z]{16}", category: "AWS_ACCESS_KEY" }],
    ["stripe_key", { pattern: "sk_live_[A-Za-z0-9]{24,}", category: "STRIPE_KEY" }],
    [
      "bearer_token",
      { pattern: "(?<![A-Za-z0-9])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9._-])", category: "BEARER_TOKEN" },
    ],
    ["bearer_dot", { pattern: "[A-Za-z0-9]{16,}\\.[A-Za-z0-9_-]{16,}", category: "BEARER_DOT" }],
    ["syn_key", { pattern: "syn_[A-Za-z0-9_-]{32,}", category: "SYN_KEY" }],
    [
      "hex_token",
      { pattern: "(?<![A-Za-z0-9])[a-fA-F0-9]{64}(?![A-Za-z0-9])", category: "HEX_TOKEN" },
    ],
    [
      "bearer_auth",
      {
        pattern: "(?:\\b[Bb]earer\\s+)([A-Za-z0-9._~+/=-]{20,})",
        category: "BEARER_AUTH",
        group: 1,
      },
    ],
    ["jwt", { pattern: "eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+", category: "JWT" }],
  ]);

function peelFlags(pattern: string): { pattern: string; flags: string } {
  const inlineFlags: string[] = [];
  let p = pattern;

  const iMatch = p.match(/^\(\?([a-z]+)\)/);
  if (iMatch) {
    const captured = iMatch[1];
    if (captured.includes("i")) inlineFlags.push("i");
    if (captured.includes("m")) inlineFlags.push("m");
    if (captured.includes("s")) inlineFlags.push("s");
    p = p.slice(iMatch[0].length);
  }

  return { pattern: p, flags: inlineFlags.join("") };
}

function buildRegex(pattern: string, defaultFlags = "gi"): RegExp {
  const { pattern: raw, flags: peeled } = peelFlags(pattern);
  const flags = [...new Set(`${defaultFlags}${peeled}`)].join("");
  return new RegExp(raw, flags);
}

export function buildPatternSet(config: PatternsConfig): PatternSet {
  const rules: PatternRule[] = [];

  if (config.builtin) {
    for (const name of config.builtin) {
      const builtin = BUILTIN_PATTERNS.get(name);
      if (builtin) {
        rules.push({
          pattern: buildRegex(builtin.pattern),
          category: builtin.category,
          group: builtin.group,
        });
      }
    }
  }

  if (config.regex) {
    for (const { pattern, category } of config.regex) {
      rules.push({ pattern: buildRegex(pattern), category });
    }
  }

  if (config.keywords) {
    for (const { value, category = "KEYWORD", caseSensitive = false } of config.keywords) {
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      rules.push({ pattern: new RegExp(escaped, caseSensitive ? "g" : "gi"), category });
    }
  }

  // The engine compares lowercased matched values; normalize here so exclusion
  // is genuinely case-insensitive regardless of how entries were authored.
  const exclude = new Set<string>((config.exclude ?? []).map((value) => value.toLowerCase()));

  return { rules, exclude };
}

export { BUILTIN_PATTERNS };
