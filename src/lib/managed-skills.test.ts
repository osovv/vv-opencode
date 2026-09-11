// FILE: src/lib/managed-skills.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify managed workflow skill discovery metadata, loaded behavior contracts, and scoped project/global lookup.
//   SCOPE: vv-execute metadata isolation, vv-execute explicit mode choice, vv-review findings-only routing, managed skill lookup precedence, and vvoc-usage-analytics template/reference coverage.
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
//   LAST_CHANGE: [C-DELEGATED-WORKFLOW-ASTRA-PRESETS - Added delegated vocabulary, control-tool, checkpoint, and linter-fixture coverage to the managed skill contract tests.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
