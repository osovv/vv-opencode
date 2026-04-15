// FILE: src/commands/role.test.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Tests for M-CLI-ROLE - canonical role list/set/unset behavior.
//   SCOPE: Built-in list ordering, role ID/model normalization, built-in unset protection, config bootstrap, and custom role removal.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, src/commands/role.ts, src/lib/opencode.ts]
//   LINKS: [V-M-CLI-ROLE]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   Test suite for canonical role command helpers.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Added coverage for role list/set/unset and built-in role protections.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listConfiguredRoles, setRoleAssignment, unsetRoleAssignment } from "./role.js";
import { readVvocConfig, resolvePaths } from "../lib/opencode.js";

describe("role helpers", () => {
  test("listConfiguredRoles shows built-ins first in deterministic order", () => {
    const listed = listConfiguredRoles({
      team: "openai/gpt-5.4",
      smart: "openai/gpt-5.4",
      default: "openai/gpt-5.4",
      vision: "openai/gpt-4.1",
      custom: "anthropic/claude-sonnet-4-5",
      fast: "openai/gpt-5.4-mini",
    });

    expect(listed.map((entry) => entry.roleId)).toEqual([
      "default",
      "smart",
      "fast",
      "vision",
      "custom",
      "team",
    ]);
  });

  test("setRoleAssignment bootstraps canonical vvoc config and normalizes model selections", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-role-config-"));
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-role-project-"));

    try {
      await setRoleAssignment("team-review", "openai/gpt-5.4:xhigh", {
        cwd: projectDir,
        configDir: configHome,
      });

      const globalPaths = await resolvePaths({
        scope: "global",
        cwd: projectDir,
        configDir: configHome,
      });
      const projectPaths = await resolvePaths({
        scope: "project",
        cwd: projectDir,
        configDir: configHome,
      });

      const config = await readVvocConfig(globalPaths);
      expect(config?.roles["team-review"]).toBe("openai/gpt-5.4:xhigh");

      await expect(access(projectPaths.opencodeConfigPath, fsConstants.F_OK)).rejects.toBeDefined();
    } finally {
      await rm(configHome, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("unsetRoleAssignment rejects built-in role IDs", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-role-builtins-"));

    try {
      await expect(unsetRoleAssignment("default", { configDir: configHome })).rejects.toThrow(
        "cannot unset built-in role: default",
      );
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("unsetRoleAssignment removes only custom role IDs", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-role-unset-"));

    try {
      await setRoleAssignment("team-review", "openai/gpt-5.4", { configDir: configHome });
      await unsetRoleAssignment("team-review", { configDir: configHome });

      const paths = await resolvePaths({
        scope: "global",
        cwd: process.cwd(),
        configDir: configHome,
      });
      const config = await readVvocConfig(paths);

      expect(config?.roles["team-review"]).toBeUndefined();
      expect(config?.roles.default).toBeDefined();
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("setRoleAssignment validates role id syntax", async () => {
    await expect(setRoleAssignment("Team", "openai/gpt-5.4")).rejects.toThrow(
      "set: invalid role id",
    );
  });
});
