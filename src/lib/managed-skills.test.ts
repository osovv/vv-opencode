// FILE: src/lib/managed-skills.test.ts
// VERSION: 1.2.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify managed workflow skill discovery metadata, loaded behavior contracts with correctness obligations, and scoped project/global lookup.
//   SCOPE: vv-execute metadata isolation and explicit mode choice with evidence sufficiency, bounded recovery operations distinct from acceptance and rework, native plan registration boundaries, scoped re-review guidance, exact returned work-item identity in the execute/review dispatch steps, vv-spec ambiguity resolution and preserved properties, vv-plan preserved-property criteria, vv-review findings-only honest reporting, managed skill lookup precedence, vvoc-usage-analytics template/reference coverage, vv-design-principles template and reference catalog coverage, the vv-write-for-humans / vv-write-for-agents writing-skill contracts with consumer-safe language, banned-token, and volume gates, and vv-verification registration, decision workflow, six-reference anchors, and vv-spec/vv-plan verification-intent delivery.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, src/lib/managed-skills.ts, src/lib/vvoc-paths.ts]
//   LINKS: [M-CLI-MANAGED-SKILLS, V-M-CLI-MANAGED-SKILLS]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   splitFrontmatter - Separates managed skill discovery metadata from loaded instructions.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-WRITE-FOR-HUMANS-SKILL T-002, C-WRITE-FOR-AGENTS-SKILL T-002, C-VV-VERIFICATION-SKILL T-003 - Added writing-skill and vv-verification registration, frontmatter triggers, reference catalog and anchor assertions, bilingual pattern markers, the agents skill's banned-token and volume gates, and vv-spec/vv-plan verification-intent delivery.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  getManagedSkillFilePath,
  loadManagedSkillTemplate,
  loadManagedSkillText,
} from "./managed-skills.js";
import { getGlobalVvocDir, getProjectVvocDir, getVvocSkillsDir } from "./vvoc-paths.js";

function splitFrontmatter(template: string): { frontmatter: string; body: string } {
  const closing = template.indexOf("\n---\n", 4);
  if (!template.startsWith("---\n") || closing < 0) {
    throw new Error("managed skill template is missing YAML frontmatter");
  }
  return {
    frontmatter: template.slice(0, closing + 5),
    body: template.slice(closing + 5),
  };
}

describe("managed workflow skill prompts", () => {
  test("vv-execute hides mode names in discovery metadata but retains explicit choice after load", async () => {
    const template = await loadManagedSkillTemplate("vv-execute");
    const { frontmatter, body } = splitFrontmatter(template);

    expect(frontmatter).toContain("name: vv-execute");
    expect(frontmatter).toContain("choose an execution mode with the user");
    for (const hiddenTerm of [
      "inline",
      "classic",
      "delegated",
      "subagent-driven",
      "current-session",
    ]) {
      expect(frontmatter).not.toContain(hiddenTerm);
    }

    expect(body).toContain("Supported modes:");
    expect(body).toContain("classic:");
    expect(body).toContain("inline:");
    expect(body).toContain("delegated:");
    expect(body).toContain("make the user explicitly choose an execution mode");
    expect(body).toContain("Do not mutate files until the execution mode is explicit");
    expect(body).toContain("If the user did not specify a mode, stop and ask them to choose");
  });

  test("vv-execute carries correctness obligations across execution modes", async () => {
    const template = await loadManagedSkillTemplate("vv-execute");
    const { body } = splitFrontmatter(template);
    const normalized = body.replace(/\s+/g, " ");

    expect(body).not.toContain(
      "The implementer receives ONLY the task's contract + criteria + files",
    );
    expect(normalized).toContain(
      "The implementer receives the task's contract + criteria + files plus the material dependencies, affected consumers, and diagnostic scenarios the controller already knows",
    );
    expect(normalized).toContain(
      "&lt;dependencies&gt;...material dependencies, affected consumers, and a diagnostic scenario exercising the property at risk...&lt;/dependencies&gt;",
    );
    expect(normalized).toContain(
      "Does the check actually exercise the changed behavior at the level the risk arises, or is it a green general check that cannot reach the changed path?",
    );
    expect(normalized).toContain("Acceptance requires evidence sufficiency");
    expect(normalized).toContain(
      "never let a stated concern substitute for an unverified material condition of the change",
    );
    expect(normalized).toContain(
      "verification commands, and the material dependencies and diagnostic scenario the controller knows",
    );
  });

  test("vv-spec resolves ambiguity from evidence and captures preserved properties", async () => {
    const template = await loadManagedSkillTemplate("vv-spec");
    const { body } = splitFrontmatter(template);
    const normalized = body.replace(/\s+/g, " ");

    expect(body).not.toContain("If so, pick one interpretation and make it explicit.");
    expect(normalized).toContain(
      "Resolve repository-answerable engineering ambiguity from the established code and contracts",
    );
    expect(normalized).toContain(
      "a genuine business-semantics fork goes to the user as an explicit question — never silently pick a business interpretation",
    );
    expect(normalized).toContain(
      "capture the material properties that must be preserved — existing behavior, contracts, and consumers the change must not break",
    );
  });

  test("vv-plan criteria cover preserved properties and risk-level verification", async () => {
    const template = await loadManagedSkillTemplate("vv-plan");
    const { body } = splitFrontmatter(template);
    const normalized = body.replace(/\s+/g, " ");

    expect(body).toContain(
      "Criteria cover: success paths, failure paths, edge cases, boundary conditions, concurrency when relevant.",
    );
    expect(normalized).toContain(
      "Derive acceptance criteria and verification commands from the spec contract and the directly affected consumers, not from a preferred implementation",
    );
    expect(normalized).toContain(
      "Criteria cover the material properties that must be preserved and the interactions with the consumers the change touches",
    );
    expect(normalized).toContain("Choose verification at the level where the risk arises");
    expect(normalized).toContain(
      "do not present a general check that cannot reach the changed path as evidence for a material criterion",
    );
  });

  test("vv-execute reuses explicit intent, uses one mode vocabulary, and respects semantic roles", async () => {
    const template = await loadManagedSkillTemplate("vv-execute");
    const { body } = splitFrontmatter(template);

    expect(body).toContain("already stated explicitly is reused; do not ask for it again");
    expect(body).toContain("stop and ask for one explicit decision before any writes");
    expect(body).toContain("work_checkpoint");
    expect(body).toContain("work_item_decide");
    expect(body).toContain("awaiting_acceptance");
    expect(body).toContain("complete: true");
    expect(body).toContain("two-attempt budget");
    expect(body).toContain("decision rework");
    expect(body).toContain(
      "do not update approved plan XML task or lifecycle statuses during execution",
    );
    expect(body).not.toContain("Review tasks (spec-reviewer, code-reviewer) → smart role");
    expect(body).not.toContain(
      "Integration tasks (multi-file, coordination, state management) → smart role",
    );
    expect(body).toContain("do not suggest escalating to the smart model for routine work");
    expect(body).toContain("a closed review-only FAIL report is a findings result, never approval");
    expect(body).toContain("NEEDS_CONTEXT and BLOCKED from a worker are hard stops");
  });

  test("vv-execute separates bounded recovery from acceptance and rework", async () => {
    const template = await loadManagedSkillTemplate("vv-execute");
    const { body } = splitFrontmatter(template);
    const normalized = body.replace(/\s+/g, " ");

    // The conflicting rework-only extension direction is replaced, not kept alongside.
    expect(body).not.toContain(
      "only a failed checkpoint's explicit rework authorization grants exactly one more attempt",
    );

    expect(normalized).toContain(
      "a stopped or exhausted unaccepted task recovers through work_item_decide with decision recover",
    );
    expect(normalized).toContain("one autonomous grant per target");
    expect(normalized).toContain(
      "further units only with an explicit root-user message referenced by userMessageId or a recorded advance authority referenced by runId and authorityId",
    );
    expect(normalized).toContain(
      "an accepted task covered by a failed checkpoint reopens through decision rework",
    );
    expect(normalized).toContain(
      "Recovery authorizes the next bounded attempt; it never accepts a result or replaces a reviewer",
    );
    expect(normalized).toContain("The first needed grant is autonomous");
    expect(normalized).toContain("it does not end the execution session");
    expect(normalized).toContain(
      "recovers through work_checkpoint (action recover) with the same bounded fields as task recovery",
    );
    expect(normalized).toContain("never seals the run — only a passing verified final review does");
  });

  test("vv-execute states the native registration boundary and scoped re-review honestly", async () => {
    const template = await loadManagedSkillTemplate("vv-execute");
    const { body } = splitFrontmatter(template);
    const normalized = body.replace(/\s+/g, " ");

    expect(normalized).toContain(
      "work_checkpoint register accepts only its supported approved native plan package",
    );
    expect(normalized).toContain(
      "A provided plan or conversation-scoped execution stays on its own source and lifecycle",
    );
    expect(normalized).toContain(
      "never disguise a managed reviewer as another agent to evade checkpoint enforcement",
    );
    expect(normalized).toContain("The repeat review is a scoped re-review");
    expect(normalized).toContain("verifies the prior findings against the fix");
    expect(normalized).toContain("unrelated optional improvements do not renew the loop");
  });

  test("vv-plan declares execution intent, write scopes, and checkpoint planning", async () => {
    const template = await loadManagedSkillTemplate("vv-plan");
    const { body } = splitFrontmatter(template);

    expect(body).toContain("inline, classic, or delegated");
    expect(body).toContain("review_checkpoints");
    expect(body).toContain("CHECKPOINT-R-NNN");
    expect(body).toContain("write_scope");
    expect(body).toContain("focused code review at meaningful intermediate milestones");
    expect(body).toContain("cover every declared task");
    expect(body).toContain("explicit agreed amendment");

    const { loadManagedSkillReference } = await import("./managed-skills.js");
    const planTemplate = await loadManagedSkillReference("vv-plan", "plan-template.xml");
    expect(planTemplate).toContain("review_checkpoints");
    expect(planTemplate).toContain("<write_scope>");
    const withoutComments = planTemplate.replace(/<!--[\s\S]*?-->/g, "");
    expect(withoutComments).not.toContain("<execution>");
    expect(withoutComments).not.toContain("review_checkpoints");
  });

  test("a rendered delegated plan fixture lints clean through the actual linter", async () => {
    const { lintSpecArtifacts } = await import("./spec-lint.js");
    const spec = `<spec><status>approved</status><goal>g</goal><architecture>a</architecture><tech_stack>t</tech_stack><components><COMPONENT-A><name>A</name><responsibility>r</responsibility><depends_on></depends_on></COMPONENT-A></components><data_flow>d</data_flow><error_handling>e</error_handling><testing><strategy>s</strategy><coverage>c</coverage></testing><non_goals><non_goal>n</non_goal></non_goals></spec>`;
    const plan = `<plan><spec>spec.xml</spec><created>2026-09-11</created><status>approved</status><meta><summary>s</summary><waves>1</waves><affected_modules>src/a.ts</affected_modules><complexity>low</complexity></meta><architecture><COMPONENT-A><name>A</name><purpose>p</purpose><file><path>src/a.ts</path><role>implementation</role></file><contract>c</contract><depends_on></depends_on></COMPONENT-A></architecture><tasks><WAVE-1><goal>g</goal><TASK-T-001><title>t</title><file>src/a.ts</file><status>pending</status><description>d</description><depends_on></depends_on><acceptance><criterion>c</criterion></acceptance><verification><command>none</command></verification><write_scope><file>src/a.ts</file></write_scope></TASK-T-001></WAVE-1></tasks><execution><mode>delegated</mode><review_checkpoints><CHECKPOINT-R-001><kind>final</kind><after_wave>WAVE-1</after_wave><covers><task_id>T-001</task_id></covers><scope><file>src/a.ts</file></scope><reviewers><reviewer>code</reviewer></reviewers><acceptance><criterion>c</criterion></acceptance><verification><command>none</command></verification></CHECKPOINT-R-001></review_checkpoints></execution></plan>`;
    const verdicts = lintSpecArtifacts([
      { file: "spec.xml", content: spec },
      { file: "plan.xml", content: plan },
    ]);
    expect(verdicts.map((verdict) => verdict.ok)).toEqual([true, true]);
    expect(verdicts[1].findings).toEqual([]);
  });

  test("vv-review remains reviewer-based, findings-only, and never delegates to implementers", async () => {
    const template = await loadManagedSkillTemplate("vv-review");
    const { body } = splitFrontmatter(template);
    const normalized = body.replace(/\s+/g, " ");

    expect(body).toContain("review_only");
    expect(body).toContain("work_item_open");
    expect(body).toContain("vv-spec-reviewer");
    expect(body).toContain("vv-code-reviewer");
    expect(body).toContain("reviewer FAIL is a completed finding result");
    expect(body).toContain("Findings are the FINAL output");
    expect(body).toContain("do NOT implement fixes");
    expect(body).toContain("do NOT delegate to implementers");
    expect(body).toContain("never satisfies the checkpoint");
    expect(body).toContain("work_checkpoint verify");
    expect(normalized).toContain(
      '"no findings" means no defect was discovered within the reviewed scope, not a guarantee of correctness',
    );
    expect(normalized).toContain(
      "Note material verification gaps and what the review could not establish",
    );
    expect(normalized).toContain(
      "do not turn an empty findings list into a completion or correctness claim",
    );
  });

  test("vv-execute and vv-review use the exact returned work-item identity", async () => {
    const execute = await loadManagedSkillTemplate("vv-execute");
    const review = await loadManagedSkillTemplate("vv-review");
    const { body: executeBody } = splitFrontmatter(execute);
    const { body: reviewBody } = splitFrontmatter(review);

    for (const body of [executeBody, reviewBody]) {
      expect(body).not.toContain("VVOC_WORK_ITEM_ID: wi-1");
      expect(body).toContain("VVOC_WORK_ITEM_ID");
    }
    expect(executeBody).toContain("VVOC_WORK_ITEM_ID: wi-<n>");
    expect(executeBody).toContain("standalone item takes only");
    expect(executeBody).toContain("LAUNCH_REJECTED_INVALID_TRANSITION");
    expect(reviewBody).toContain("VVOC_WORK_ITEM_ID: wi-<n>");
    expect(reviewBody).toContain("REVIEW_ROUND_NOT_ACTIVE");
    expect(reviewBody).toContain("carry no route");
  });

  test("managed skill text lookup prefers project and falls back to global", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-managed-skill-home-"));
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-managed-skill-project-"));
    const previousConfigHome = process.env.XDG_CONFIG_HOME;

    try {
      process.env.XDG_CONFIG_HOME = configHome;
      const globalPath = getManagedSkillFilePath(
        getVvocSkillsDir(getGlobalVvocDir()),
        "vv-execute",
      );
      const projectPath = getManagedSkillFilePath(
        getVvocSkillsDir(getProjectVvocDir(projectDir)),
        "vv-execute",
      );
      await mkdir(dirname(globalPath), { recursive: true });
      await mkdir(dirname(projectPath), { recursive: true });
      await writeFile(globalPath, "Global execute skill.\n", "utf8");
      await writeFile(projectPath, "Project execute skill.\n", "utf8");

      expect(await loadManagedSkillText(projectDir, "vv-execute")).toBe("Project execute skill.\n");
      await rm(projectPath, { force: true });
      expect(await loadManagedSkillText(projectDir, "vv-execute")).toBe("Global execute skill.\n");
    } finally {
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
      await rm(configHome, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});

describe("vvoc-usage-analytics managed skill", () => {
  test("registers in MANAGED_SKILL_NAMES and loads a template with frontmatter", async () => {
    const { MANAGED_SKILL_NAMES } = await import("./managed-skills.js");
    expect(MANAGED_SKILL_NAMES).toContain("vvoc-usage-analytics");

    const template = await loadManagedSkillTemplate("vvoc-usage-analytics");
    const { frontmatter, body } = splitFrontmatter(template);
    expect(frontmatter).toContain("name: vvoc-usage-analytics");
    expect(frontmatter).toContain("cache hit rate");
    expect(body).toContain("mode=ro");
    expect(body).toContain("cacheRead / (cacheRead + cacheWrite + input)");
  });

  test("ships the opencode-db-queries reference", async () => {
    const { listManagedSkillReferenceNames, loadManagedSkillReference } =
      await import("./managed-skills.js");
    expect(await listManagedSkillReferenceNames("vvoc-usage-analytics")).toEqual([
      "opencode-db-queries.md",
    ]);
    const reference = await loadManagedSkillReference(
      "vvoc-usage-analytics",
      "opencode-db-queries.md",
    );
    expect(reference).toContain("mode=ro");
    expect(reference).toContain("step-finish");
    expect(reference).toContain("1.18.x");
  });
});

describe("vv-design-principles managed skill", () => {
  test("registers in MANAGED_SKILL_NAMES and loads a template with frontmatter", async () => {
    const { MANAGED_SKILL_NAMES } = await import("./managed-skills.js");
    expect(MANAGED_SKILL_NAMES).toContain("vv-design-principles");

    const template = await loadManagedSkillTemplate("vv-design-principles");
    const { frontmatter, body } = splitFrontmatter(template);
    expect(frontmatter).toContain("name: vv-design-principles");
    expect(frontmatter).toContain("subtractive AI-slop audit");
    expect(frontmatter).toContain("DESIGN.md");
    expect(body).toContain("references/slop-tells.md");
    expect(body).toContain("references/quality-floor.md");
    expect(body).toContain("references/design-md.md");
    expect(body).toContain("Fix by removal before addition");
  });

  test("ships the slop-tells, quality-floor, and design-md references", async () => {
    const { listManagedSkillReferenceNames, loadManagedSkillReference } =
      await import("./managed-skills.js");
    const names = await listManagedSkillReferenceNames("vv-design-principles");
    expect(names.sort()).toEqual(["design-md.md", "quality-floor.md", "slop-tells.md"]);

    const slopTells = await loadManagedSkillReference("vv-design-principles", "slop-tells.md");
    expect(slopTells).toContain("Dithering");
    expect(slopTells).toContain("eyebrow");
    expect(slopTells).toContain("Instrument Serif");
    expect(slopTells).toContain("more than five on a page is a redesign");

    const qualityFloor = await loadManagedSkillReference(
      "vv-design-principles",
      "quality-floor.md",
    );
    expect(qualityFloor).toContain("4.5:1");
    expect(qualityFloor).toContain("44px");
    expect(qualityFloor).toContain("65–75");
    expect(qualityFloor).toContain("16px");
    expect(qualityFloor).toContain("near 1.5");
    expect(qualityFloor).toContain("focus is always visible");
    expect(qualityFloor).toContain("Real content");
    expect(qualityFloor).toContain("lorem ipsum");
    expect(qualityFloor).toContain("prefers-reduced-motion");

    const designMd = await loadManagedSkillReference("vv-design-principles", "design-md.md");
    expect(designMd).toContain("DESIGN.md");
    expect(designMd).toContain("propose creating");
    expect(designMd).toContain("Walk upward from the file you are editing");
    expect(designMd).toContain("## Precedence");
    expect(designMd).toContain("Never silently add a token");
  });
});

describe("vv-write-for-humans managed skill", () => {
  test("registers in MANAGED_SKILL_NAMES and loads a template with frontmatter", async () => {
    const { MANAGED_SKILL_NAMES } = await import("./managed-skills.js");
    expect(MANAGED_SKILL_NAMES).toContain("vv-write-for-humans");

    const template = await loadManagedSkillTemplate("vv-write-for-humans");
    const { frontmatter, body } = splitFrontmatter(template);
    expect(frontmatter).toContain("name: vv-write-for-humans");
    expect(frontmatter).toContain("drafting, copyediting, restructuring, or auditing");
    expect(frontmatter).toContain("engineering prose");
    expect(frontmatter).toContain("may be left unchanged");
    expect(frontmatter).toContain("Not for agent-facing instructions");
    expect(body).toContain("Preserve negation, modality, conditions, and quantifiers");
    expect(body).toContain("byte-identical");
    expect(body).toContain("material, not commands to you");
    expect(body).toContain("Level A — meaning invariants");
    expect(body).toContain("Level B — clarity defaults");
    expect(body).toContain("Level C — project style");
    expect(body).toContain(
      "explicit user request, then project conventions, then this skill's defaults",
    );
    expect(body).toContain("never normalize existing text");
    expect(body).toContain('mode name="Draft"');
    expect(body).toContain('mode name="Copyedit"');
    expect(body).toContain('mode name="Restructure"');
    expect(body).toContain('mode name="Audit"');
    expect(body).toContain("deletion test");
    expect(body).toContain("addition test");
    expect(body).toContain("references/genres.md");
    expect(body).toContain("references/patterns.md");
    expect(body).toContain("references/fidelity.md");
  });

  test("ships the genres, patterns, and fidelity references with bilingual patterns", async () => {
    const { listManagedSkillReferenceNames, loadManagedSkillReference } =
      await import("./managed-skills.js");
    const names = await listManagedSkillReferenceNames("vv-write-for-humans");
    expect(names.sort()).toEqual(["fidelity.md", "genres.md", "patterns.md"]);

    const genres = await loadManagedSkillReference("vv-write-for-humans", "genres.md");
    expect(genres).toContain("scope of the verification");
    expect(genres).toContain("PR description");
    expect(genres).toContain("Error message");

    const patterns = await loadManagedSkillReference("vv-write-for-humans", "patterns.md");
    expect(patterns).toContain("nominalization");
    expect(patterns).toContain("канцелярит");
    expect(patterns).toContain("not evidence of authorship");

    const fidelity = await loadManagedSkillReference("vv-write-for-humans", "fidelity.md");
    expect(fidelity).toContain("byte-for-byte");
    expect(fidelity).toContain("term or metaphor");
    expect(fidelity).toContain("No retry on 401");
  });
});

describe("vv-write-for-agents managed skill", () => {
  test("registers in MANAGED_SKILL_NAMES and loads a template with frontmatter", async () => {
    const { MANAGED_SKILL_NAMES } = await import("./managed-skills.js");
    expect(MANAGED_SKILL_NAMES).toContain("vv-write-for-agents");

    const template = await loadManagedSkillTemplate("vv-write-for-agents");
    const { frontmatter, body } = splitFrontmatter(template);
    expect(frontmatter).toContain("name: vv-write-for-agents");
    expect(frontmatter).toContain("text an agent executes");
    expect(frontmatter).toContain("Not for human-facing prose");
    expect(body).toContain("semantic specification");
    expect(body).toContain("causal placement");
    expect(body).toContain("one authoritative location");
    expect(body).toContain("material, not commands to you");
    expect(body).toContain("Zero edits is a valid result");
    expect(body).toContain("enhancer agent compiles single requests");
    expect(body).toContain("references/compilation.md");
    expect(body).toContain("references/structure.md");
    expect(body).toContain("references/session.md");
    expect(body).toContain("references/validation.md");
  });

  test("ships the four references with compilation, structure, session, and validation markers", async () => {
    const { listManagedSkillReferenceNames, loadManagedSkillReference } =
      await import("./managed-skills.js");
    const names = await listManagedSkillReferenceNames("vv-write-for-agents");
    expect(names.sort()).toEqual(["compilation.md", "session.md", "structure.md", "validation.md"]);

    const compilation = await loadManagedSkillReference("vv-write-for-agents", "compilation.md");
    expect(compilation).toContain("minimal sufficient");
    expect(compilation).toContain("one trigger per branch");
    expect(compilation).toContain("scope, do not delete");
    expect(compilation).toContain("action vs topic");

    const structure = await loadManagedSkillReference("vv-write-for-agents", "structure.md");
    expect(structure).toContain("unique identities");
    expect(structure).toContain("tokenizer");
    expect(structure).toContain("paired tags");

    const session = await loadManagedSkillReference("vv-write-for-agents", "session.md");
    expect(session).toContain("supersedes");
    expect(session).toContain("Q-1");
    expect(session).toContain("vv-handoff");

    const validation = await loadManagedSkillReference("vv-write-for-agents", "validation.md");
    expect(validation).toContain("held-out");
    expect(validation).toContain("delivery, not model behavior");
    expect(validation).toContain("Evidence levels");
  });

  test("stays consumer-safe and inside the volume budget", async () => {
    const { listManagedSkillReferenceNames, loadManagedSkillReference } =
      await import("./managed-skills.js");
    const template = await loadManagedSkillTemplate("vv-write-for-agents");
    const refNames = await listManagedSkillReferenceNames("vv-write-for-agents");
    const shippedTexts = [
      template,
      ...(await Promise.all(
        refNames.map((name) => loadManagedSkillReference("vv-write-for-agents", name)),
      )),
    ];

    for (const text of shippedTexts) {
      expect(text).not.toMatch(/\.grace\b/);
      expect(text).not.toMatch(/\bgrace\s+(lint|status|module|file|verification|check|--)/);
      expect(text).not.toMatch(/\b[MV]-[A-Z]/);
      expect(text).not.toMatch(/\bGD-[A-Z]/);
    }

    const skillDirEntries = await readdir(
      new URL("../../templates/skills/vv-write-for-agents/", import.meta.url),
      { withFileTypes: true },
    );
    expect(skillDirEntries.map((entry) => entry.name).sort()).toEqual(["SKILL.md", "references"]);
    expect(refNames.length).toBeLessThanOrEqual(4);

    const refDirEntries = await readdir(
      new URL("../../templates/skills/vv-write-for-agents/references/", import.meta.url),
      { withFileTypes: true },
    );
    expect(refDirEntries.filter((entry) => entry.isDirectory())).toEqual([]);

    const lineCount = (text: string): number => text.replace(/\n$/, "").split("\n").length;
    const totalLines =
      lineCount(template) + shippedTexts.slice(1).reduce((sum, text) => sum + lineCount(text), 0);
    expect(lineCount(template)).toBeLessThanOrEqual(80);
    expect(totalLines).toBeLessThanOrEqual(420);
  });
});

describe("vv-verification managed skill", () => {
  test("registers in MANAGED_SKILL_NAMES and loads the decision workflow", async () => {
    const { MANAGED_SKILL_NAMES } = await import("./managed-skills.js");
    expect(MANAGED_SKILL_NAMES).toContain("vv-verification");

    const template = await loadManagedSkillTemplate("vv-verification");
    const { frontmatter, body } = splitFrontmatter(template);
    expect(frontmatter).toContain("name: vv-verification");
    expect(frontmatter).toContain("oracles");
    expect(frontmatter).toContain("formal verification");
    expect(body).toContain("evidence ledger");
    expect(body).toContain("VERIFICATION.md");
    expect(body).toContain("maintain-verification");
    expect(body).toContain("residual risk");
    expect(body).toContain("references/oracles.md");
  });

  test("ships exactly the six references with their stable anchors", async () => {
    const { listManagedSkillReferenceNames, loadManagedSkillReference } =
      await import("./managed-skills.js");
    const names = await listManagedSkillReferenceNames("vv-verification");
    expect(names.sort()).toEqual([
      "create-your-verification-stack.md",
      "evidence.md",
      "formal.md",
      "maintenance.md",
      "oracles.md",
      "strategy.md",
    ]);

    const anchors: Record<string, string[]> = {
      "strategy.md": ["## Test levels", "## CI split"],
      "oracles.md": ["## Oracle catalog", "## Selection matrix"],
      "evidence.md": ["## Evidence ledger", "## Confidence tiers"],
      "formal.md": ["## Tooling notes", "## Limits"],
      "maintenance.md": ["## Stale tests", "## Mutation testing and kill matrix"],
      "create-your-verification-stack.md": [
        "## Write VERIFICATION.md",
        "## Create the verification CLI",
        "## Generate the project skills",
        "## Register the skills",
        "## Never impose a framework",
      ],
    };
    for (const [file, expected] of Object.entries(anchors)) {
      const reference = await loadManagedSkillReference("vv-verification", file);
      for (const anchor of expected) expect(reference).toContain(anchor);
    }

    const bootstrap = await loadManagedSkillReference(
      "vv-verification",
      "create-your-verification-stack.md",
    );
    expect(bootstrap).toContain("only after the user approves");
    expect(bootstrap).toContain("Never edit user-owned configuration silently");
  });

  test("vv-spec and vv-plan deliver verification intent without new template elements", async () => {
    const { loadManagedSkillReference } = await import("./managed-skills.js");
    const spec = await loadManagedSkillTemplate("vv-spec");
    const plan = await loadManagedSkillTemplate("vv-plan");
    expect(spec).toContain("verification intent");
    expect(spec).toContain("residual risk");
    expect(plan).toContain("oracle");
    expect(plan).toContain("inspectable evidence");

    const specTemplate = await loadManagedSkillReference("vv-spec", "spec-template.xml");
    const planTemplate = await loadManagedSkillReference("vv-plan", "plan-template.xml");
    expect(specTemplate).toContain("<strategy>");
    expect(specTemplate).toContain("<coverage>");
    expect(specTemplate).not.toContain("verification_intent");
    expect(planTemplate).toContain("<acceptance>");
    expect(planTemplate).toContain("<verification>");
    expect(planTemplate).not.toContain("verification_intent");
  });
});

describe("vv-execute tool-contracts reference", () => {
  test("is discovered and loads the generated catalog reference verbatim", async () => {
    const { listManagedSkillReferenceNames, loadManagedSkillReference } =
      await import("./managed-skills.js");
    const names = await listManagedSkillReferenceNames("vv-execute");
    expect(names).toContain("tool-contracts.md");

    const reference = await loadManagedSkillReference("vv-execute", "tool-contracts.md");
    const { renderToolContractsReference } = await import("./agent-tool-catalog.js");
    expect(reference).toBe(renderToolContractsReference());
  });

  test("the loaded reference carries the built package identity and contract revision", async () => {
    const { loadManagedSkillReference, loadManagedSkillTemplate } =
      await import("./managed-skills.js");
    const reference = await loadManagedSkillReference("vv-execute", "tool-contracts.md");
    const { PACKAGE_NAME, PACKAGE_VERSION, AGENT_TOOL_CONTRACT_REVISION } =
      await import("./agent-tool-contract.js");
    expect(reference).toContain(PACKAGE_NAME);
    expect(reference).toContain(PACKAGE_VERSION);
    expect(reference).toContain(AGENT_TOOL_CONTRACT_REVISION);
    // The reference stays on demand: it is not inlined into the always-loaded skill text.
    const template = await loadManagedSkillTemplate("vv-execute");
    expect(template).not.toContain("## Tools");
  });
});
