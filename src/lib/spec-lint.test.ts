// FILE: src/lib/spec-lint.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Deterministic tests for the spec-package lint engine: strict parsing, template contracts, identity rules, references, lifecycle severity, cross-file subset checks, and layout checks.
//   SCOPE: Fixture-driven coverage of every declared rule plus clean runs over the shipped reference templates.
//   DEPENDS: [src/lib/spec-lint.ts]
//   LINKS: [M-SPEC-LINT]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   templatesDir - Resolved path to the shipped skill templates directory.
//   validSpec - Complete valid approved spec fixture with component identity.
//   validPlan - Complete valid approved plan fixture mirroring the spec components.
//   validDesignContext - Complete valid design-context fixture.
//   lintOne - Lint a single fixture artifact through lintSpecArtifacts.
//   rules - Extract rule ids from a verdict for containment assertions.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-SPEC-IDENTITY-LINT - Initial fixture corpus for every engine rule and the shipped templates.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LINT_VERSION,
  isSpecArchivePath,
  lintSpecArtifacts,
  parseSpecXml,
  type SpecLintVerdict,
} from "./spec-lint.js";

// START_BLOCK_FIXTURES
const templatesDir = join(import.meta.dir, "../../templates/skills");

const validSpec = `<spec>
  <status>approved</status>
  <goal>Store cached analytics rows.</goal>
  <architecture>In-process cache in front of analytics queries.</architecture>
  <tech_stack>TypeScript, Bun.</tech_stack>
  <components>
    <COMPONENT-CACHE-STORE>
      <name>Cache Store</name>
      <responsibility>Holds bounded query results.</responsibility>
      <depends_on>ANALYTICS-READER</depends_on>
    </COMPONENT-CACHE-STORE>
    <COMPONENT-ANALYTICS-READER>
      <name>Analytics Reader</name>
      <responsibility>Reads raw analytics rows.</responsibility>
      <depends_on></depends_on>
    </COMPONENT-ANALYTICS-READER>
  </components>
  <data_flow>Rows flow from reader into the store.</data_flow>
  <error_handling>Fail open with a warning.</error_handling>
  <testing>
    <strategy>Table-driven unit tests.</strategy>
    <coverage>Hit and eviction paths.</coverage>
  </testing>
  <non_goals>
    <non_goal>No persistence across restarts.</non_goal>
  </non_goals>
</spec>`;

const validPlan = `<plan>
  <spec>.vvoc/specs/2026-08-29-cache/spec.xml</spec>
  <design_context></design_context>
  <created>2026-08-29</created>
  <status>approved</status>
  <meta>
    <summary>Add the cache store.</summary>
    <waves>1</waves>
    <affected_modules>src/lib/cache-store.ts</affected_modules>
    <complexity>low</complexity>
  </meta>
  <architecture>
    <COMPONENT-CACHE-STORE>
      <name>Cache Store</name>
      <purpose>Bounded in-memory store.</purpose>
      <file>
        <path>src/lib/cache-store.ts</path>
        <role>implementation</role>
      </file>
      <contract>get, set, clear.</contract>
      <depends_on>ANALYTICS-READER</depends_on>
    </COMPONENT-CACHE-STORE>
  </architecture>
  <tasks>
    <WAVE-1>
      <goal>Store core.</goal>
      <TASK-T-001>
        <title>Cache Store</title>
        <file>src/lib/cache-store.ts</file>
        <status>pending</status>
        <description>Implement the store.</description>
        <depends_on></depends_on>
        <snippet><![CDATA[
export class CacheStore {}
]]></snippet>
        <acceptance>
          <criterion>get returns undefined for missing keys</criterion>
        </acceptance>
        <verification>
          <command>bun test src/lib/cache-store.test.ts</command>
        </verification>
      </TASK-T-001>
    </WAVE-1>
  </tasks>
</plan>`;

const validDesignContext = `<design-context>
  <decisions>
    <decision>
      <topic>Eviction</topic>
      <choice>LRU</choice>
      <rationale>Predictable.</rationale>
      <alternatives_considered>
        <alternative>
          <name>FIFO</name>
          <reason_rejected>Protects wrong entries.</reason_rejected>
        </alternative>
      </alternatives_considered>
    </decision>
  </decisions>
  <assumptions>
    <assumption>
      <statement>Queries repeat often.</statement>
      <confidence>medium</confidence>
      <fragile_if>Workloads become unique per request.</fragile_if>
    </assumption>
  </assumptions>
  <deferred>
    <deferred_decision>
      <decision>Persistence layer</decision>
      <why_deferred>Out of scope for v1.</why_deferred>
      <revisit_trigger>Restart data loss hurts users.</revisit_trigger>
    </deferred_decision>
  </deferred>
  <scenarios>
    <scenario>
      <name>Cold start</name>
      <context>Empty store.</context>
      <implications>First query is slow.</implications>
    </scenario>
  </scenarios>
  <external_constraints>
    <constraint>
      <source>Bun runtime</source>
      <impact>No Node-specific APIs.</impact>
    </constraint>
  </external_constraints>
</design-context>`;

function lintOne(content: string, file = "spec.xml"): SpecLintVerdict {
  return lintSpecArtifacts([{ file, content }])[0];
}

function rules(verdict: SpecLintVerdict): string[] {
  return verdict.findings.map((f) => f.rule);
}
// END_BLOCK_FIXTURES

// START_BLOCK_PARSE_TESTS
describe("parseSpecXml strict well-formedness", () => {
  test("valid document with entities, comments, and CDATA parses clean", () => {
    const r = parseSpecXml(
      "<spec><!-- note --><goal>a &lt; b &amp; c</goal><data><![CDATA[x < y]]></data></spec>",
      "spec.xml",
    );
    expect(r.findings).toEqual([]);
    expect(r.root?.name).toBe("spec");
    // The tokenizer delivers raw (undecoded) text slices; rules match on trimmed raw text.
    expect(r.root?.children[0]?.text).toBe("a &lt; b &amp; c");
    expect(r.root?.children[1]?.cdataCount).toBe(1);
  });

  test("unclosed element reports xml.unclosed with its line", () => {
    const r = parseSpecXml("<spec>\n  <goal>x\n</spec>", "spec.xml");
    expect(r.findings).toEqual([expect.objectContaining({ rule: "xml.unclosed", line: 2 })]);
  });

  test("mismatched closing tag reports xml.mismatched-close", () => {
    const r = parseSpecXml("<spec><goal>x</span></goal></spec>", "spec.xml");
    expect(
      rules({ version: 1, file: "spec.xml", kind: "spec", ok: false, findings: r.findings }),
    ).toContain("xml.mismatched-close");
  });

  test("closing tag closing a nested element implicitly reports xml.unclosed for the skipped elements", () => {
    const r = parseSpecXml("<spec><components><COMPONENT-A></spec>", "spec.xml");
    const found = r.findings.map((f) => f.rule);
    expect(found).toContain("xml.unclosed");
    expect(found.filter((x) => x === "xml.unclosed").length).toBe(2);
  });

  test("stray top-level text reports xml.stray-text", () => {
    const r = parseSpecXml("junk<spec></spec>", "spec.xml");
    expect(r.findings.map((f) => f.rule)).toContain("xml.stray-text");
  });

  test("element after root reports xml.content-after-root", () => {
    const r = parseSpecXml("<spec></spec><extra/>", "spec.xml");
    expect(r.findings.map((f) => f.rule)).toContain("xml.content-after-root");
  });

  test("two roots report content after root for the second", () => {
    const r = parseSpecXml("<spec></spec><spec></spec>", "spec.xml");
    expect(r.findings.map((f) => f.rule)).toContain("xml.content-after-root");
  });

  test("any attribute reports attr.forbidden", () => {
    const r = parseSpecXml('<spec><goal status="draft">x</goal></spec>', "spec.xml");
    expect(r.findings).toEqual([expect.objectContaining({ rule: "attr.forbidden", line: 1 })]);
  });
});
// END_BLOCK_PARSE_TESTS

// START_BLOCK_SPEC_RULE_TESTS
describe("spec rules", () => {
  test("valid approved spec lints clean", () => {
    const v = lintOne(validSpec, ".vvoc/specs/2026-08-29-cache/spec.xml");
    expect(v.ok).toBe(true);
    expect(v.kind).toBe("spec");
    expect(v.version).toBe(LINT_VERSION);
  });

  test("element outside the template contract reports element.unknown", () => {
    const v = lintOne("<spec><status>draft</status><risk>none</risk></spec>");
    expect(rules(v)).toContain("element.unknown");
    expect(v.ok).toBe(false);
  });

  test("generic component element from the old format reports identity.pattern", () => {
    const v = lintOne(
      "<spec><status>draft</status><components><component><name>x</name></component></components></spec>",
    );
    expect(rules(v)).toContain("identity.pattern");
  });

  test("lowercase component slug reports identity.pattern", () => {
    const v = lintOne(
      "<spec><status>draft</status><components><COMPONENT-cache><name>x</name></COMPONENT-cache></components></spec>",
    );
    expect(rules(v)).toContain("identity.pattern");
  });

  test("duplicate component identity reports identity.duplicate", () => {
    const v = lintOne(
      "<spec><status>draft</status><components><COMPONENT-A><name>x</name></COMPONENT-A><COMPONENT-A><name>y</name></COMPONENT-A></components></spec>",
    );
    expect(rules(v)).toContain("identity.duplicate");
  });

  test("dangling depends_on slug reports ref.dangling", () => {
    const v = lintOne(
      "<spec><status>draft</status><components><COMPONENT-A><name>x</name><depends_on>NOPE</depends_on></COMPONENT-A></components></spec>",
    );
    expect(rules(v)).toContain("ref.dangling");
    expect(v.ok).toBe(false);
  });

  test("unknown lifecycle status reports lifecycle.status", () => {
    const v = lintOne("<spec><status>banana</status></spec>");
    expect(rules(v)).toContain("lifecycle.status");
  });

  test("draft documents tolerate empty sections without errors", () => {
    const v = lintOne(
      "<spec><status>draft</status><goal></goal><components></components></spec>",
      ".vvoc/specs/2026-08-29-x/spec.xml",
    );
    expect(v.ok).toBe(true);
    expect(rules(v)).not.toContain("lifecycle.required");
  });

  test("approved documents with empty sections report lifecycle.required", () => {
    const v = lintOne(
      "<spec><status>approved</status><goal></goal><components></components><testing><strategy></strategy><coverage>ok</coverage></testing></spec>",
      ".vvoc/specs/2026-08-29-x/spec.xml",
    );
    const required = v.findings.filter((f) => f.rule === "lifecycle.required");
    expect(required.length).toBeGreaterThanOrEqual(3);
    expect(v.ok).toBe(false);
  });

  test("unknown root element reports element.root with kind unknown", () => {
    const v = lintOne("<banana></banana>");
    expect(v.kind).toBe("unknown");
    expect(rules(v)).toContain("element.root");
  });
});
// END_BLOCK_SPEC_RULE_TESTS

// START_BLOCK_PLAN_RULE_TESTS
describe("plan rules", () => {
  const specFile = ".vvoc/specs/2026-08-29-cache/spec.xml";

  test("valid plan lints clean against its spec", () => {
    const verdicts = lintSpecArtifacts([
      { file: specFile, content: validSpec },
      { file: ".vvoc/specs/2026-08-29-cache/plan.xml", content: validPlan },
    ]);
    const plan = verdicts[1];
    expect(plan.kind).toBe("plan");
    expect(plan.findings).toEqual([]);
    expect(plan.ok).toBe(true);
  });

  test("plan component absent from spec reports crossfile.plan_component", () => {
    const plan = validPlan
      .replace(
        "<COMPONENT-CACHE-STORE>",
        "<COMPONENT-SECRET-STORE>\n      <name>Secret Store</name>",
      )
      .replace("</COMPONENT-CACHE-STORE>", "</COMPONENT-SECRET-STORE>")
      .replace("<depends_on>ANALYTICS-READER</depends_on>", "");
    const verdicts = lintSpecArtifacts([
      { file: specFile, content: validSpec },
      { file: ".vvoc/specs/2026-08-29-cache/plan.xml", content: plan },
    ]);
    expect(verdicts[1].findings.map((f) => f.rule)).toContain("crossfile.plan_component");
    expect(verdicts[1].ok).toBe(false);
  });

  test("plan without its spec input yields a warning and stays ok", () => {
    const v = lintOne(validPlan, ".vvoc/specs/2026-08-29-cache/plan.xml");
    expect(v.ok).toBe(true);
    expect(v.findings.map((f) => f.rule)).toContain("crossfile.spec_missing");
    expect(v.findings[0].severity).toBe("warning");
  });

  test("generic wave and task elements report identity.pattern", () => {
    const plan = validPlan
      .replace("<WAVE-1>", "<wave>")
      .replace("</WAVE-1>", "</wave>")
      .replace("<TASK-T-001>", "<task>")
      .replace("</TASK-T-001>", "</task>");
    const v = lintOne(plan, ".vvoc/specs/2026-08-29-cache/plan.xml");
    expect(v.findings.map((f) => f.rule)).toContain("identity.pattern");
  });

  test("dangling task_id reference reports ref.dangling", () => {
    const plan = validPlan.replace(
      "<depends_on></depends_on>",
      "<depends_on><task_id>T-999</task_id></depends_on>",
    );
    const verdicts = lintSpecArtifacts([
      { file: specFile, content: validSpec },
      { file: ".vvoc/specs/2026-08-29-cache/plan.xml", content: plan },
    ]);
    expect(verdicts[1].findings.map((f) => f.rule)).toContain("ref.dangling");
  });

  test("unknown task status reports lifecycle.task_status", () => {
    const plan = validPlan.replace("<status>pending</status>", "<status>banana</status>");
    const verdicts = lintSpecArtifacts([
      { file: specFile, content: validSpec },
      { file: ".vvoc/specs/2026-08-29-cache/plan.xml", content: plan },
    ]);
    expect(verdicts[1].findings.map((f) => f.rule)).toContain("lifecycle.task_status");
  });

  test("non-empty snippet without CDATA reports snippet.cdata", () => {
    const plan = validPlan.replace(
      "<snippet><![CDATA[\nexport class CacheStore {}\n]]></snippet>",
      "<snippet>export class CacheStore {}</snippet>",
    );
    const v = lintOne(plan, ".vvoc/specs/2026-08-29-cache/plan.xml");
    expect(v.findings.map((f) => f.rule)).toContain("snippet.cdata");
  });

  test("draft plan tolerates empty task titles; approved plan reports them", () => {
    const draftPlan = validPlan
      .replace("<status>approved</status>", "<status>draft</status>")
      .replace("<title>Cache Store</title>", "<title></title>");
    const draft = lintOne(draftPlan, ".vvoc/specs/2026-08-29-cache/plan.xml");
    expect(draft.findings.map((f) => f.rule)).not.toContain("lifecycle.required");

    const verdicts = lintSpecArtifacts([
      { file: specFile, content: validSpec },
      {
        file: ".vvoc/specs/2026-08-29-cache/plan.xml",
        content: validPlan.replace("<title>Cache Store</title>", "<title></title>"),
      },
    ]);
    expect(verdicts[1].findings.map((f) => f.rule)).toContain("lifecycle.required");
    expect(verdicts[1].ok).toBe(false);
  });
});
// END_BLOCK_PLAN_RULE_TESTS

// START_BLOCK_DESIGN_CONTEXT_TESTS
describe("design-context rules", () => {
  test("valid design context lints clean", () => {
    const v = lintOne(validDesignContext, ".vvoc/specs/2026-08-29-cache/design-context.xml");
    expect(v.ok).toBe(true);
    expect(v.kind).toBe("design-context");
  });

  test("old anonymous item element reports element.unknown and points at deferred_decision", () => {
    const v = lintOne(
      "<design-context><deferred><item><decision>x</decision></item></deferred></design-context>",
    );
    expect(v.findings).toEqual([expect.objectContaining({ rule: "element.unknown", line: 1 })]);
  });
});
// END_BLOCK_DESIGN_CONTEXT_TESTS

// START_BLOCK_LAYOUT_TESTS
describe("package layout and archive detection", () => {
  test("malformed package id reports layout.package_id", () => {
    const v = lintOne(validSpec, ".vvoc/specs/cache/spec.xml");
    expect(v.findings.map((f) => f.rule)).toContain("layout.package_id");
  });

  test("timestamped package id reports layout.package_id", () => {
    const v = lintOne(validSpec, ".vvoc/specs/2026-08-29T10-00-00-cache/spec.xml");
    expect(v.findings.map((f) => f.rule)).toContain("layout.package_id");
  });

  test("reserved slug reports layout.reserved_slug", () => {
    const v = lintOne(validSpec, ".vvoc/specs/2026-08-29-archive/spec.xml");
    expect(v.findings.map((f) => f.rule)).toContain("layout.reserved_slug");
  });

  test("foreign paths skip layout checks", () => {
    const v = lintOne(validSpec, "/tmp/fixture/spec.xml");
    expect(v.findings.map((f) => f.rule)).not.toContain("layout.package_id");
    expect(v.ok).toBe(true);
  });

  test("archive detection recognizes archive segments", () => {
    expect(isSpecArchivePath(".vvoc/specs/archive/2026-08-29-x-1/spec.xml")).toBe(true);
    expect(isSpecArchivePath(".vvoc/specs/2026-08-29-x/spec.xml")).toBe(false);
  });
});
// END_BLOCK_LAYOUT_TESTS

// START_BLOCK_TEMPLATE_TESTS
describe("shipped reference templates lint clean", () => {
  test("spec-template.xml", () => {
    const content = readFileSync(
      join(templatesDir, "vv-spec/references/spec-template.xml"),
      "utf8",
    );
    const v = lintOne(content, ".vvoc/specs/2026-08-29-format-ref/spec.xml");
    expect(v.ok).toBe(true);
    expect(v.findings).toEqual([]);
  });

  test("plan-template.xml", () => {
    const content = readFileSync(
      join(templatesDir, "vv-plan/references/plan-template.xml"),
      "utf8",
    );
    const v = lintOne(content, ".vvoc/specs/2026-08-29-format-ref/plan.xml");
    expect(v.ok).toBe(true);
  });

  test("design-context-template.xml", () => {
    const content = readFileSync(
      join(templatesDir, "vv-spec/references/design-context-template.xml"),
      "utf8",
    );
    const v = lintOne(content, ".vvoc/specs/2026-08-29-format-ref/design-context.xml");
    expect(v.ok).toBe(true);
    expect(v.findings).toEqual([]);
  });
});
// END_BLOCK_TEMPLATE_TESTS
