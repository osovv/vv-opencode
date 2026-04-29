// FILE: src/lib/managed-agents.test.ts
// VERSION: 0.5.1
// START_MODULE_CONTRACT
//   PURPOSE: Verify vvoc-managed agent prompt template loading and scoped runtime lookup.
//   SCOPE: Bundled template reads, primary/subagent template metadata checks, project-over-global prompt resolution, and missing prompt failures.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, src/lib/managed-agents.ts, src/lib/vvoc-paths.ts]
//   LINKS: [V-M-CLI-CONFIG]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   managed prompt lookup tests - Verify bundled template loading plus project/global runtime prompt resolution.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.5.1 - Rejected ambiguous plain `Status:` prompt lines for tracked agents so strict workflow protocol fields stay unambiguous.]
//   LAST_CHANGE: [v0.5.0 - Added prompt-template coverage for vv-controller, vv-analyst, and vv-architect.]
//   LAST_CHANGE: [v0.4.1 - Updated tracked-agent template coverage for vv-* naming and strict top-block workflow protocol requirements.]
//   LAST_CHANGE: [v0.4.0 - Expanded prompt-template coverage for rerouting, working-state externalization, semantic continuity, assumptions, anti-drift, and project-overlay hooks.]
//   LAST_CHANGE: [v0.3.0 - Expanded prompt-template coverage for stable enhancer schema, shared status outputs, and investigation/report protocols.]
//   LAST_CHANGE: [v0.2.2 - Added coverage requiring the enhancer to emit the final XML prompt in English.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getManagedAgentPromptPath,
  loadManagedAgentPromptTemplate,
  loadManagedAgentPromptText,
} from "./managed-agents.js";
import { getGlobalVvocDir, getProjectVvocDir, getVvocAgentsDir } from "./vvoc-paths.js";

describe("managed agent prompts", () => {
  test("loads bundled guardian template", async () => {
    const template = await loadManagedAgentPromptTemplate("guardian");
    expect(template).toStartWith("---\n");
    expect(template).toContain("mode: subagent");
    expect(template).toContain("hidden: true");
    expect(template).toContain("You are performing a risk assessment of a coding-agent tool call.");
  });

  test("loads bundled enhancer template", async () => {
    const template = await loadManagedAgentPromptTemplate("enhancer");
    expect(template).toStartWith("---\n");
    expect(template).toContain("mode: primary");
    expect(template).toContain("You are the enhancer agent.");
    expect(template).toContain("The final XML prompt must always be written in English.");
    expect(template).toContain("<task_type>");
    expect(template).toContain("<execution_mode>");
    expect(template).toContain("<constraint_1>");
    expect(template).toContain("<verification_check_1>");
    expect(template).toContain("<current_unknowns>");
    expect(template).toContain("<reroute_if>");
    expect(template).toContain("<project_overlays>");
    expect(template).toContain("Do not use repeated identical child tags.");
    expect(template).toContain("Reuse stable domain terms");
    expect(template).toContain("Do not invent project overlays");
  });

  test("loads bundled vv-controller template with route and workflow guidance", async () => {
    const template = await loadManagedAgentPromptTemplate("vv-controller");
    expect(template).toStartWith("---\n");
    expect(template).toContain("mode: primary");
    expect(template).toContain("You are the vv-controller primary agent.");
    expect(template).toContain("direct_change");
    expect(template).toContain("change_with_review");
    expect(template).toContain("large_feature");
    expect(template).toContain("VVOC_WORK_ITEM_ID: wi-N");
    expect(template).toContain("Do not implement before approval");
    expect(template).toContain("Match the user's language");
  });

  test("loads bundled analyst and architect templates with plan-file permissions", async () => {
    const analystTemplate = await loadManagedAgentPromptTemplate("vv-analyst");
    const architectTemplate = await loadManagedAgentPromptTemplate("vv-architect");

    expect(analystTemplate).toContain("mode: subagent");
    expect(analystTemplate).toContain(".vvoc/plans/**");
    expect(analystTemplate).toContain("Status: READY | NEEDS_CONTEXT");
    expect(analystTemplate).toContain("Acceptance criteria:");
    expect(analystTemplate).toContain("Plan artifact: path or none");

    expect(architectTemplate).toContain("mode: subagent");
    expect(architectTemplate).toContain(".vvoc/plans/**");
    expect(architectTemplate).toContain("Implementation waves:");
    expect(architectTemplate).toContain("Verification gates:");
    expect(architectTemplate).toContain("User approval checkpoint:");
  });

  test("loads bundled vv-implementer template with strict top-block protocol", async () => {
    const template = await loadManagedAgentPromptTemplate("vv-implementer");
    expect(template).toStartWith("---\n");
    expect(template).toContain("You are the vv-implementer subagent.");
    expect(template).toContain("VVOC_WORK_ITEM_ID: wi-1");
    expect(template).toContain("VVOC_STATUS: DONE");
    expect(template).toContain("VVOC_ROUTE: change_with_review");
    expect(template).toContain(
      "Allowed `VVOC_STATUS` values: `DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED`",
    );
    expect(template).not.toContain("Status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED");
    expect(template).toContain("stabilize a compact working state");
    expect(template).toContain("project-owned overlays");
    expect(template).toContain("Prefer semantically meaningful identifiers");
    expect(template).toContain("Do not make silent material assumptions");
    expect(template).toContain("reviewer feedback becomes conflicting, ambiguous, or repetitive");
  });

  test("loads bundled vv-reviewer templates with strict top-block protocol", async () => {
    const specTemplate = await loadManagedAgentPromptTemplate("vv-spec-reviewer");
    const codeTemplate = await loadManagedAgentPromptTemplate("vv-code-reviewer");

    expect(specTemplate).toContain("VVOC_WORK_ITEM_ID: wi-1");
    expect(specTemplate).toContain("VVOC_STATUS: PASS");
    expect(specTemplate).toContain("Allowed `VVOC_STATUS` values: `PASS | FAIL | NEEDS_CONTEXT`");
    expect(specTemplate).not.toContain("Status: PASS | FAIL | NEEDS_CONTEXT");
    expect(specTemplate).toContain("[Missing|Extra|Wrong|Unproven]");
    expect(specTemplate).toContain("project-owned overlays");
    expect(specTemplate).toContain("Reuse canonical repository terms");
    expect(specTemplate).toContain("unstated material assumption");

    expect(codeTemplate).toContain("VVOC_WORK_ITEM_ID: wi-1");
    expect(codeTemplate).toContain("VVOC_STATUS: PASS");
    expect(codeTemplate).toContain("Allowed `VVOC_STATUS` values: `PASS | FAIL | NEEDS_CONTEXT`");
    expect(codeTemplate).not.toContain("Status: PASS | FAIL | NEEDS_CONTEXT");
    expect(codeTemplate).toContain(
      "Review only issues introduced by this change or left unresolved by it.",
    );
    expect(codeTemplate).toContain("project-owned overlays");
    expect(codeTemplate).toContain("Reuse canonical repository terms");
    expect(codeTemplate).toContain("Do not treat route or process choices as findings");
    expect(codeTemplate).toContain("If a concern lacks a concrete failure mode");
  });

  test("loads bundled investigator template with investigation status protocol", async () => {
    const template = await loadManagedAgentPromptTemplate("investigator");
    expect(template).toContain("Status: REPRODUCED | PARTIAL | NOT_REPRODUCED | NEEDS_CONTEXT");
    expect(template).toContain("Recommended route:");
    expect(template).toContain("project-owned overlays");
    expect(template).toContain("Assumptions / missing evidence:");
    expect(template).toContain("Likely root cause:");
    expect(template).toContain("Next best step:");
  });

  test("prefers project managed prompt over global prompt", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-managed-prompt-home-"));
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-managed-prompt-project-"));
    const previousConfigHome = process.env.XDG_CONFIG_HOME;

    try {
      process.env.XDG_CONFIG_HOME = configHome;

      const globalAgentsDir = getVvocAgentsDir(getGlobalVvocDir());
      const projectAgentsDir = getVvocAgentsDir(getProjectVvocDir(projectDir));
      await mkdir(globalAgentsDir, { recursive: true });
      await mkdir(projectAgentsDir, { recursive: true });
      await writeFile(
        getManagedAgentPromptPath(globalAgentsDir, "guardian"),
        "Global guardian prompt.\n",
        "utf8",
      );
      await writeFile(
        getManagedAgentPromptPath(projectAgentsDir, "guardian"),
        "Project guardian prompt.\n",
        "utf8",
      );

      expect(await loadManagedAgentPromptText(projectDir, "guardian")).toBe(
        "Project guardian prompt.\n",
      );
    } finally {
      if (previousConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousConfigHome;
      }
      await rm(configHome, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("falls back to global managed prompt when project prompt is missing", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-managed-prompt-home-"));
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-managed-prompt-project-"));
    const previousConfigHome = process.env.XDG_CONFIG_HOME;

    try {
      process.env.XDG_CONFIG_HOME = configHome;

      const globalAgentsDir = getVvocAgentsDir(getGlobalVvocDir());
      await mkdir(globalAgentsDir, { recursive: true });
      await writeFile(
        getManagedAgentPromptPath(globalAgentsDir, "memory-reviewer"),
        "Global memory reviewer prompt.\n",
        "utf8",
      );

      expect(await loadManagedAgentPromptText(projectDir, "memory-reviewer")).toBe(
        "Global memory reviewer prompt.\n",
      );
    } finally {
      if (previousConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousConfigHome;
      }
      await rm(configHome, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
