// FILE: src/lib/managed-agents.test.ts
// VERSION: 0.4.0
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

  test("loads bundled implementer template with stable status protocol", async () => {
    const template = await loadManagedAgentPromptTemplate("implementer");
    expect(template).toStartWith("---\n");
    expect(template).toContain("You are the implementer subagent.");
    expect(template).toContain("Status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED");
    expect(template).toContain("stabilize a compact working state");
    expect(template).toContain("project-owned overlays");
    expect(template).toContain("Prefer semantically meaningful identifiers");
    expect(template).toContain("Do not make silent material assumptions");
    expect(template).toContain("reviewer feedback becomes conflicting, ambiguous, or repetitive");
  });

  test("loads bundled reviewer templates with stable status output", async () => {
    const specTemplate = await loadManagedAgentPromptTemplate("spec-reviewer");
    const codeTemplate = await loadManagedAgentPromptTemplate("code-reviewer");

    expect(specTemplate).toContain("Status: PASS | FAIL | NEEDS_CONTEXT");
    expect(specTemplate).toContain("[Missing|Extra|Wrong|Unproven]");
    expect(specTemplate).toContain("project-owned overlays");
    expect(specTemplate).toContain("Reuse canonical repository terms");
    expect(specTemplate).toContain("unstated material assumption");

    expect(codeTemplate).toContain("Status: PASS | FAIL");
    expect(codeTemplate).toContain(
      "Review only issues introduced by this change or left unresolved by it.",
    );
    expect(codeTemplate).toContain("project-owned overlays");
    expect(codeTemplate).toContain("Reuse canonical repository terms");
    expect(codeTemplate).toContain("Do not treat route or process choices as findings");
    expect(codeTemplate).toContain("If a concern lacks a concrete failure mode");
  });

  test("loads bundled investitagor template with investigation status protocol", async () => {
    const template = await loadManagedAgentPromptTemplate("investitagor");
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
