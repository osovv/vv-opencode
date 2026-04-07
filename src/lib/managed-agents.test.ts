// FILE: src/lib/managed-agents.test.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify vvoc-managed agent prompt template loading and scoped runtime lookup.
//   SCOPE: Bundled template reads, project-over-global prompt resolution, and missing prompt failures.
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
//   LAST_CHANGE: [v0.1.0 - Added scoped managed prompt tests for guardian and memory-reviewer runtime loading.]
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
    expect(template).toContain("You are performing a risk assessment of a coding-agent tool call.");
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
