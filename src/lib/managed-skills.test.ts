// FILE: src/lib/managed-skills.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify managed workflow skill discovery metadata, loaded behavior contracts, and scoped project/global lookup.
//   SCOPE: vv-execute metadata isolation, vv-execute explicit mode choice, vv-review findings-only routing, and managed skill lookup precedence.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, src/lib/managed-skills.ts, src/lib/vvoc-paths.ts]
//   LINKS: [M-CLI-MANAGED-SKILLS, V-M-CLI-MANAGED-SKILLS]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   managed workflow skill prompt tests - Verify discovery metadata and loaded workflow contracts.
//   managed skill lookup test - Verify project-over-global compatibility.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-PRESET-ORCHESTRATION-PROFILES - Added workflow skill visibility and lookup regression coverage.]
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
    for (const hiddenTerm of ["inline", "classic", "subagent-driven", "current-session"]) {
      expect(frontmatter).not.toContain(hiddenTerm);
    }

    expect(body).toContain("Supported modes:");
    expect(body).toContain("classic:");
    expect(body).toContain("inline:");
    expect(body).toContain("make the user explicitly choose an execution mode");
    expect(body).toContain("Do not mutate files until the execution mode is explicit");
    expect(body).toContain("If the user did not specify a mode, stop and ask them to choose");
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
