// FILE: scripts/release-summary.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify release summary helper behavior without external OpenCode or LLM calls.
//   SCOPE: Option parsing, prompt/config construction, git output parsing, OpenCode JSONL parsing, envelope validation, changelog injection, retry behavior, and latest changelog summary checks.
//   DEPENDS: [bun:test, scripts/release-summary]
//   LINKS: [M-RELEASE-AUTOMATION, VF-RELEASE-AUTOMATION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   makeTextEvent - Builds a JSONL text event fixture.
//   makeRunner - Builds an injected OpenCode runner fixture.
//   option parsing tests - Validate defaults and env overrides.
//   output parsing tests - Validate JSONL success and failure classes.
//   summary validation tests - Validate XML-like envelope and prose rules.
//   retry tests - Validate retry exhaustion and non-retryable ENOENT behavior.
// END_MODULE_MAP

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RELEASE_SUMMARY_MODEL,
  DEFAULT_RELEASE_SUMMARY_TIMEOUT_MS,
  RELEASE_SUMMARY_MAX_ATTEMPTS,
  buildReleaseSummaryAgentConfig,
  buildReleaseSummaryPrompt,
  collectReleaseCommitMetadata,
  extractSummaryEnvelope,
  generateReleaseSummaryWithRetries,
  injectSummaryIntoChangelogEntry,
  parseOpencodeRunJsonOutput,
  resolveReleaseSummaryOptions,
  validateLatestChangelogSummary,
  validateReleaseSummary,
  type OpencodeRunRequest,
  type OpencodeRunResult,
  type OpencodeRunner,
  type ReleaseSummaryOptions,
  type ReleaseSummaryPromptInput,
} from "./release-summary.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Builds one OpenCode text event line for parser fixtures. */
function makeTextEvent(text: string): string {
  return JSON.stringify({ type: "text", part: { type: "text", text } });
}

/** Builds an injected runner that returns results in call order. */
function makeRunner(results: OpencodeRunResult[]): OpencodeRunner {
  let index = 0;
  return (_req: OpencodeRunRequest): OpencodeRunResult => {
    const r = results[index] ?? results[results.length - 1];
    index++;
    return r!;
  };
}

function successRunResult(stdout: string): OpencodeRunResult {
  return { status: 0, stdout, stderr: "" };
}

function failRunResult(status: number, stderr: string): OpencodeRunResult {
  return { status, stdout: "", stderr };
}

function timeoutRunResult(): OpencodeRunResult {
  return { status: null, stdout: "", stderr: "", timedOut: true };
}

function enoentRunResult(): OpencodeRunResult {
  return { status: null, stdout: "", stderr: "", errorCode: "ENOENT" };
}

function samplePromptInput(overrides?: Partial<ReleaseSummaryPromptInput>): ReleaseSummaryPromptInput {
  return {
    version: "1.2.3",
    changelogEntry: `## <small>1.2.3 (2026-06-13)</small>\n\n* feat: add new feature\n* fix: resolve a bug`,
    commits: [
      {
        hash: "abc1234",
        subject: "feat: add new feature",
        body: "This adds a long-awaited feature for users.",
        diff: "diff --git a/src/feature.ts b/src/feature.ts\n+export const enabled = true;",
      },
      {
        hash: "def5678",
        subject: "fix: resolve a bug",
        body: "",
        diff: "diff --git a/src/bug.ts b/src/bug.ts\n-return false;\n+return true;",
      },
    ],
    ...overrides,
  };
}

function validSummaryXml(summary: string): string {
  return `<summary>\n${summary}\n</summary>`;
}

// ---------------------------------------------------------------------------
// resolveReleaseSummaryOptions
// ---------------------------------------------------------------------------

describe("resolveReleaseSummaryOptions", () => {
  test("uses defaults when env overrides are absent", () => {
    expect(resolveReleaseSummaryOptions({})).toEqual({
      model: DEFAULT_RELEASE_SUMMARY_MODEL,
      timeoutMs: DEFAULT_RELEASE_SUMMARY_TIMEOUT_MS,
    } satisfies ReleaseSummaryOptions);
  });

  test("uses VVOC_RELEASE_SUMMARY_MODEL when set", () => {
    const options = resolveReleaseSummaryOptions({ VVOC_RELEASE_SUMMARY_MODEL: "anthropic/claude-sonnet" });
    expect(options.model).toBe("anthropic/claude-sonnet");
    expect(options.timeoutMs).toBe(DEFAULT_RELEASE_SUMMARY_TIMEOUT_MS);
  });

  test("uses VVOC_RELEASE_SUMMARY_TIMEOUT_MS when set", () => {
    const options = resolveReleaseSummaryOptions({ VVOC_RELEASE_SUMMARY_TIMEOUT_MS: "60000" });
    expect(options.timeoutMs).toBe(60000);
    expect(options.model).toBe(DEFAULT_RELEASE_SUMMARY_MODEL);
  });

  test("throws for VVOC_RELEASE_SUMMARY_TIMEOUT_MS zero", () => {
    expect(() => resolveReleaseSummaryOptions({ VVOC_RELEASE_SUMMARY_TIMEOUT_MS: "0" })).toThrow(
      /positive integer/,
    );
  });

  test("throws for VVOC_RELEASE_SUMMARY_TIMEOUT_MS negative", () => {
    expect(() => resolveReleaseSummaryOptions({ VVOC_RELEASE_SUMMARY_TIMEOUT_MS: "-1" })).toThrow(
      /positive integer/,
    );
  });

  test("throws for VVOC_RELEASE_SUMMARY_TIMEOUT_MS non-integer", () => {
    expect(() => resolveReleaseSummaryOptions({ VVOC_RELEASE_SUMMARY_TIMEOUT_MS: "1.5" })).toThrow(
      /positive integer/,
    );
  });

  test("throws for VVOC_RELEASE_SUMMARY_TIMEOUT_MS non-number", () => {
    expect(() => resolveReleaseSummaryOptions({ VVOC_RELEASE_SUMMARY_TIMEOUT_MS: "foo" })).toThrow(
      /positive integer/,
    );
  });

  test("ignores empty string VVOC_RELEASE_SUMMARY_TIMEOUT_MS", () => {
    const options = resolveReleaseSummaryOptions({ VVOC_RELEASE_SUMMARY_TIMEOUT_MS: "" });
    expect(options.timeoutMs).toBe(DEFAULT_RELEASE_SUMMARY_TIMEOUT_MS);
  });
});

// ---------------------------------------------------------------------------
// buildReleaseSummaryAgentConfig
// ---------------------------------------------------------------------------

describe("buildReleaseSummaryAgentConfig", () => {
  test("returns valid JSON with restricted agent config", () => {
    const config = buildReleaseSummaryAgentConfig("test/model");
    const parsed = JSON.parse(config);
    const agent = parsed.agent["release-summary"];
    expect(agent.description).toContain("release changelog summaries");
    expect(agent.mode).toBe("primary");
    expect(agent.model).toBe("test/model");
    expect(agent.steps).toBe(1);
    expect(agent.permission["*"]).toBe("deny");
    expect(agent.prompt).toContain("<summary>");
  });
});

// ---------------------------------------------------------------------------
// buildReleaseSummaryPrompt
// ---------------------------------------------------------------------------

describe("buildReleaseSummaryPrompt", () => {
  test("includes version and changelog entry", () => {
    const prompt = buildReleaseSummaryPrompt(samplePromptInput());
    expect(prompt).toContain("1.2.3");
    expect(prompt).toContain("feat: add new feature");
  });

  test("includes commit hashes and subjects", () => {
    const prompt = buildReleaseSummaryPrompt(samplePromptInput());
    expect(prompt).toContain("abc1234");
    expect(prompt).toContain("feat: add new feature");
    expect(prompt).toContain("def5678");
  });

  test("includes commit bodies", () => {
    const prompt = buildReleaseSummaryPrompt(samplePromptInput());
    expect(prompt).toContain("long-awaited feature");
  });

  test("includes full commit diffs", () => {
    const prompt = buildReleaseSummaryPrompt(samplePromptInput());
    expect(prompt).toContain("Commits and full diffs in this release");
    expect(prompt).toContain("diff --git a/src/feature.ts b/src/feature.ts");
    expect(prompt).toContain("+export const enabled = true;");
    expect(prompt).toContain("diff --git a/src/bug.ts b/src/bug.ts");
  });

  test("instructs model not to invent facts outside provided diffs", () => {
    const prompt = buildReleaseSummaryPrompt(samplePromptInput());
    expect(prompt).toContain("Use only the changelog entry, commit metadata, and full commit diffs");
    expect(prompt).toContain("Do NOT invent status names");
  });

  test("instructs XML-like envelope format", () => {
    const prompt = buildReleaseSummaryPrompt(samplePromptInput());
    expect(prompt).toContain("<summary>");
    expect(prompt).toContain("</summary>");
  });

  test("instructs model to avoid AI wording in changelog summary", () => {
    const prompt = buildReleaseSummaryPrompt(samplePromptInput());
    expect(prompt).toContain("Do NOT mention AI");
    expect(prompt).toContain("without the AI label");
  });

  test("requires English summary", () => {
    const prompt = buildReleaseSummaryPrompt(samplePromptInput());
    expect(prompt).toMatch(/English/);
  });
});

// ---------------------------------------------------------------------------
// collectReleaseCommitMetadata
// ---------------------------------------------------------------------------

describe("collectReleaseCommitMetadata", () => {
  test("uses git describe range when tag exists", () => {
    const calls: string[] = [];
    const capture = (cmd: string, args: string[], _msg: string): string => {
      calls.push(`${cmd} ${args.join(" ")}`);
      if (cmd === "git" && args[0] === "describe") return "v1.2.2\n";
      if (cmd === "git" && args[0] === "log") {
        return `aaaa1111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaafeat: add feature\nbody line\n---GITLOG---\n`;
      }
      return "";
    };
    const commits = collectReleaseCommitMetadata(capture);
    expect(calls).toContain("git describe --tags --abbrev=0");
    expect(calls).toContain("git log v1.2.2..HEAD --format=%H%s%n%b%n---GITLOG---");
    expect(commits.length).toBe(1);
    expect(commits[0]!.hash).toBe("aaaa111");
    expect(commits[0]!.subject).toBe("feat: add feature");
    expect(commits[0]!.body).toBe("body line");
  });

  test("falls back to HEAD when git describe throws", () => {
    const calls: string[] = [];
    const capture = (cmd: string, args: string[], _msg: string): string => {
      calls.push(`${cmd} ${args.join(" ")}`);
      if (cmd === "git" && args[0] === "describe") throw new Error("no tag");
      if (cmd === "git" && args[0] === "log") return `bbbb2222aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaachore: update\n\n---GITLOG---\n`;
      return "";
    };
    const commits = collectReleaseCommitMetadata(capture);
    expect(calls).toContain("git log HEAD --format=%H%s%n%b%n---GITLOG---");
    expect(commits.length).toBe(1);
    expect(commits[0]!.hash).toBe("bbbb222");
  });

  test("returns empty array for empty log", () => {
    const capture = (_cmd: string, _args: string[], _msg: string): string => {
      if (_cmd === "git" && _args[0] === "describe") return "v1.0.0\n";
      return "";
    };
    const commits = collectReleaseCommitMetadata(capture);
    expect(commits.length).toBe(0);
  });

  test("attaches full patch diff for each commit", () => {
    const fullHash = "c".repeat(40);
    const calls: string[] = [];
    const capture = (cmd: string, args: string[], _msg: string): string => {
      calls.push(`${cmd} ${args.join(" ")}`);
      if (cmd === "git" && args[0] === "describe") return "v1.2.2\n";
      if (cmd === "git" && args[0] === "log") {
        return `${fullHash}feat: add grounded summary context\n\n---GITLOG---\n`;
      }
      if (cmd === "git" && args[0] === "show") {
        return "diff --git a/scripts/release-summary.ts b/scripts/release-summary.ts\n+full diff context\n";
      }
      return "";
    };
    const commits = collectReleaseCommitMetadata(capture);
    expect(calls).toContain(`git show --format= --patch --find-renames ${fullHash}`);
    expect(commits[0]!.diff).toContain("diff --git a/scripts/release-summary.ts");
    expect(commits[0]!.diff).toContain("+full diff context");
  });
});

// ---------------------------------------------------------------------------
// parseOpencodeRunJsonOutput
// ---------------------------------------------------------------------------

describe("parseOpencodeRunJsonOutput", () => {
  test("accumulates text events into success", () => {
    const r = parseOpencodeRunJsonOutput(
      [
        makeTextEvent("<summary>\nThis release "),
        makeTextEvent("adds new features.\n</summary>"),
      ].join("\n"),
    );
    expect(r.ok).toBe(true);
  });

  test("fails for empty stdout", () => {
    const result = parseOpencodeRunJsonOutput("");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(true);
  });

  test("fails for invalid JSONL", () => {
    const result = parseOpencodeRunJsonOutput("not-json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.reason).toContain("Invalid JSONL");
    }
  });

  test("fails for tool_use events", () => {
    const line = JSON.stringify({ type: "tool_use", part: { type: "tool_use", tool: "read" } });
    const result = parseOpencodeRunJsonOutput(line);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.reason).toContain("tool");
    }
  });

  test("fails for error events", () => {
    const line = JSON.stringify({ type: "error", message: "something broke" });
    const result = parseOpencodeRunJsonOutput(line);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.reason).toContain("error");
    }
  });

  test("fails when text does not start with <summary>", () => {
    const stdout = JSON.stringify({ type: "text", part: { type: "text", text: "No envelope here" } });
    const result = parseOpencodeRunJsonOutput(stdout);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("Summary envelope is invalid");
  });
});

// ---------------------------------------------------------------------------
// extractSummaryEnvelope
// ---------------------------------------------------------------------------

describe("extractSummaryEnvelope", () => {
  test("extracts valid summary envelope", () => {
    const result = extractSummaryEnvelope(validSummaryXml("A new release with important fixes."));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.summary).toBe("A new release with important fixes.");
  });

  test("extracts single-line summary envelope", () => {
    const result = extractSummaryEnvelope("<summary>A concise release summary.</summary>");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.summary).toBe("A concise release summary.");
  });

  test("rejects text before envelope", () => {
    const result = extractSummaryEnvelope(`Some intro text\n${validSummaryXml("Content")}`);
    expect(result.ok).toBe(false);
  });

  test("rejects text after envelope", () => {
    const result = extractSummaryEnvelope(`${validSummaryXml("Content")}\nExtra text`);
    expect(result.ok).toBe(false);
  });

  test("rejects empty envelope", () => {
    const result = extractSummaryEnvelope("<summary>\n\n</summary>");
    expect(result.ok).toBe(false);
  });

  test("rejects multiple summary tags", () => {
    const result = extractSummaryEnvelope(`${validSummaryXml("A")}\n\n${validSummaryXml("B")}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("Multiple");
  });

  test("rejects missing closing tag", () => {
    const result = extractSummaryEnvelope("<summary>\nSome text");
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateReleaseSummary
// ---------------------------------------------------------------------------

describe("validateReleaseSummary", () => {
  test("accepts valid summary", () => {
    const result = validateReleaseSummary("This release fixes bugs and adds features.");
    expect(result.ok).toBe(true);
  });

  test("rejects empty summary", () => {
    const result = validateReleaseSummary("");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("empty");
  });

  test("rejects fenced code blocks", () => {
    const result = validateReleaseSummary("Text with ```code``` inside.");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("code blocks");
  });

  test("rejects markdown headings", () => {
    const result = validateReleaseSummary("# Heading in summary");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("headings");
  });

  test("rejects AI generation mentions", () => {
    const result = validateReleaseSummary("This summary was generated by AI.");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("AI");
  });

  test("accepts legitimate standalone model wording", () => {
    const result = validateReleaseSummary("This release introduces a clearer configuration model for maintainers.");
    expect(result.ok).toBe(true);
  });

  test("rejects LLM mentions", () => {
    const result = validateReleaseSummary("The LLM generated this summary.");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("AI");
  });

  test("rejects excessive length", () => {
    const longText = "a".repeat(2001);
    const result = validateReleaseSummary(longText);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("exceeds");
  });
});

// ---------------------------------------------------------------------------
// injectSummaryIntoChangelogEntry
// ---------------------------------------------------------------------------

describe("injectSummaryIntoChangelogEntry", () => {
  test("inserts summary after header", () => {
    const entry = `## <small>1.2.3 (2026-06-13)</small>\n\n* feat: new feature\n* fix: bug`;
    const result = injectSummaryIntoChangelogEntry(entry, "Great release.");
    expect(result).toContain("### Summary");
    expect(result).toContain("Great release.");
    // The summary should appear before the feature list
    const summaryIndex = result.indexOf("### Summary");
    const featIndex = result.indexOf("* feat:");
    expect(summaryIndex).toBeLessThan(featIndex);
    // The header should still be first
    expect(result).toMatch(/^## <small>1.2.3/);
  });

  test("preserves conventional commit details after summary", () => {
    const entry = `## <small>1.2.3 (2026-06-13)</small>\n\n* feat: new feature\n* fix: bug`;
    const result = injectSummaryIntoChangelogEntry(entry, "Summary text.");
    expect(result).toContain("* feat: new feature");
    expect(result).toContain("* fix: bug");
  });

  test("returns unchanged for entry without header", () => {
    const entry = "* feat: stray item";
    const result = injectSummaryIntoChangelogEntry(entry, "Summary.");
    expect(result).toBe(entry);
  });
});

// ---------------------------------------------------------------------------
// validateLatestChangelogSummary
// ---------------------------------------------------------------------------

describe("validateLatestChangelogSummary", () => {
  test("passes when latest entry has a valid summary", () => {
    const changelog =
      `## <small>1.2.3 (2026-06-13)</small>\n\n### Summary\n\nThis release makes upgrades clearer and safer.\n\n* feat: new`;
    expect(validateLatestChangelogSummary(changelog).ok).toBe(true);
  });

  test("fails when latest entry has no summary", () => {
    const changelog = `## <small>1.2.3 (2026-06-13)</small>\n\n* feat: new`;
    const result = validateLatestChangelogSummary(changelog);
    expect(result.ok).toBe(false);
  });

  test("ignores older missing summaries", () => {
    const changelog =
      `## <small>1.2.0 (2026-06-13)</small>\n\n### Summary\n\nA clear summary.\n\n* feat: new\n\n## <small>1.1.0 (2026-06-01)</small>\n\n* fix: old`;
    expect(validateLatestChangelogSummary(changelog).ok).toBe(true);
  });

  test("fails when latest summary has fenced code", () => {
    const changelog =
      `## <small>1.2.0 (2026-06-13)</small>\n\n### Summary\n\nCode: \`\`\`js\nx\`\`\`\n\n* feat: new`;
    expect(validateLatestChangelogSummary(changelog).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// generateReleaseSummaryWithRetries
// ---------------------------------------------------------------------------

describe("generateReleaseSummaryWithRetries", () => {
  test("returns summary on first success", () => {
    const stdout = validSummaryXml("Release adds features.");
    const runner = makeRunner([successRunResult(JSON.stringify({ type: "text", part: { type: "text", text: stdout } }))]);
    const result = generateReleaseSummaryWithRetries(
      runner,
      samplePromptInput(),
      { model: "test/model", timeoutMs: 120_000 },
      () => {},
    );
    expect(result).toBe("Release adds features.");
  });

  test("succeeds after one retryable failure", () => {
    const stdout = validSummaryXml("Release adds features.");
    const runner = makeRunner([
      failRunResult(1, "error"),
      successRunResult(JSON.stringify({ type: "text", part: { type: "text", text: stdout } })),
    ]);
    const result = generateReleaseSummaryWithRetries(
      runner,
      samplePromptInput(),
      { model: "test/model", timeoutMs: 120_000 },
      () => {},
    );
    expect(result).toBe("Release adds features.");
  });

  test("throws after three failures (retry exhaustion)", () => {
    const runner = makeRunner([
      failRunResult(1, "err1"),
      failRunResult(1, "err2"),
      failRunResult(1, "err3"),
    ]);
    expect(() =>
      generateReleaseSummaryWithRetries(
        runner,
        samplePromptInput(),
        { model: "test/model", timeoutMs: 120_000 },
        () => {},
      ),
    ).toThrow(/failed after 3 attempts/);
  });

  test("throws immediately on ENOENT", () => {
    const runner = makeRunner([enoentRunResult()]);
    expect(() =>
      generateReleaseSummaryWithRetries(
        runner,
        samplePromptInput(),
        { model: "test/model", timeoutMs: 120_000 },
        () => {},
      ),
    ).toThrow(/opencode binary not found/);
  });

  test("retries on timeout", () => {
    const stdout = validSummaryXml("Fixed after timeout.");
    const runner = makeRunner([
      timeoutRunResult(),
      successRunResult(JSON.stringify({ type: "text", part: { type: "text", text: stdout } })),
    ]);
    let sleeps = 0;
    const result = generateReleaseSummaryWithRetries(
      runner,
      samplePromptInput(),
      { model: "test/model", timeoutMs: 120_000 },
      () => { sleeps++; },
    );
    expect(result).toBe("Fixed after timeout.");
    expect(sleeps).toBe(1);
  });

  test("retries on invalid JSONL output", () => {
    const stdout = validSummaryXml("Fixed after bad JSON.");
    const runner = makeRunner([
      successRunResult("not-json"),
      successRunResult(JSON.stringify({ type: "text", part: { type: "text", text: stdout } })),
    ]);
    const result = generateReleaseSummaryWithRetries(
      runner,
      samplePromptInput(),
      { model: "test/model", timeoutMs: 120_000 },
      () => {},
    );
    expect(result).toBe("Fixed after bad JSON.");
  });
});
