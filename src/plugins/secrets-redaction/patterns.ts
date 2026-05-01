// FILE: src/plugins/secrets-redaction/patterns.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Builds the internal pattern set from config — keywords, regex rules, and builtin patterns.
//   SCOPE: pattern parsing, normalization, deduplication
//   DEPENDS: node:crypto (for hashing)
//   LINKS: knowledge-graph://plugins/secrets-redaction
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   buildPatternSet - builds pattern set from config object
//   BUILTIN_PATTERNS - Map of 13 builtin pattern definitions
//   PatternRule - Individual pattern matching rule.
//   PatternSet - Group of related pattern rules.
//   PatternsConfig - Patterns configuration schema.
// END_MODULE_MAP
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.0.0 - Initial GRACE compliance: added missing CHANGE_SUMMARY.]
// END_CHANGE_SUMMARY

export interface PatternRule {
  pattern: RegExp;
  category: string;
}

export interface PatternSet {
  rules: PatternRule[];
  exclude: Set<string>;
}

export interface PatternsConfig {
  keywords?: Array<{ value: string; category?: string }>;
  regex?: Array<{ pattern: string; category: string }>;
  builtin?: string[];
  exclude?: string[];
}

const BUILTIN_PATTERNS: Map<string, { pattern: string; category: string }> = new Map([
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
    { pattern: "(?<![A-Za-z0-9])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9])", category: "BEARER_TOKEN" },
  ],
  ["bearer_dot", { pattern: "[A-Za-z0-9]{16,}\\.[A-Za-z0-9_-]{16,}", category: "BEARER_DOT" }],
  ["syn_key", { pattern: "syn_[A-Za-z0-9_-]{32,}", category: "SYN_KEY" }],
  [
    "hex_token",
    { pattern: "(?<![A-Za-z0-9])[a-fA-F0-9]{64}(?![A-Za-z0-9])", category: "HEX_TOKEN" },
  ],
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
  const flags = peeled ? `${defaultFlags}${peeled}` : defaultFlags;
  return new RegExp(raw, flags);
}

export function buildPatternSet(config: PatternsConfig): PatternSet {
  const rules: PatternRule[] = [];

  if (config.builtin) {
    for (const name of config.builtin) {
      const builtin = BUILTIN_PATTERNS.get(name);
      if (builtin) {
        rules.push({ pattern: buildRegex(builtin.pattern), category: builtin.category });
      }
    }
  }

  if (config.regex) {
    for (const { pattern, category } of config.regex) {
      rules.push({ pattern: buildRegex(pattern), category });
    }
  }

  if (config.keywords) {
    for (const { value, category = "KEYWORD" } of config.keywords) {
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      rules.push({ pattern: new RegExp(escaped, "gi"), category });
    }
  }

  const exclude = new Set<string>(config.exclude ?? []);

  return { rules, exclude };
}

export { BUILTIN_PATTERNS };
