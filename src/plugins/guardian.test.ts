// FILE: src/plugins/guardian.test.ts
// VERSION: 0.2.1
// START_MODULE_CONTRACT
//   PURPOSE: Verify Guardian plugin role-based runtime config and permission review fallback behavior.
//   SCOPE: Hidden subagent registration, built-in fast-role model resolution, initialization failure signaling, and review fallback behavior.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, src/lib/vvoc-config.ts, src/plugins/guardian/index.ts]
//   LINKS: [V-M-PLUGIN-GUARDIAN]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   GuardianPlugin config tests - Verify hidden subagent registration and fast-role model resolution.
//   GuardianPlugin failure tests - Verify fast-role resolution failures and manual fallback behavior.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.2.1 - Added regression coverage ensuring stale guardian model fields cannot override roles.fast defaults while env model overrides still can.]
//   LAST_CHANGE: [v0.2.0 - Added fast-role resolution, initialization failure, and manual fallback behavior coverage.]
//   LAST_CHANGE: [v0.1.0 - Added coverage for Guardian plugin config registration as a hidden subagent.]
// END_CHANGE_SUMMARY

import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultVvocConfig } from "../lib/vvoc-config.js";
import { GuardianPlugin } from "./guardian/index.js";

const tempDirs: string[] = [];
const previousConfigHome = process.env.XDG_CONFIG_HOME;
const previousPath = process.env.PATH;
const previousGuardianModelEnv = process.env.OPENCODE_GUARDIAN_MODEL;

afterEach(async () => {
  while (tempDirs.length > 0) {
    const path = tempDirs.pop();
    if (path) {
      await rm(path, { recursive: true, force: true });
    }
  }

  if (previousConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = previousConfigHome;
  }

  if (previousPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = previousPath;
  }

  if (previousGuardianModelEnv === undefined) {
    delete process.env.OPENCODE_GUARDIAN_MODEL;
  } else {
    process.env.OPENCODE_GUARDIAN_MODEL = previousGuardianModelEnv;
  }
});

async function setupGuardianWorkspace(options?: { roleFast?: string; guardianModel?: string }) {
  const roleFast = options?.roleFast ?? "openai/test-fast-model";
  const projectDir = await mkdtemp(join(tmpdir(), "vvoc-guardian-project-"));
  const configHome = await mkdtemp(join(tmpdir(), "vvoc-guardian-config-home-"));
  tempDirs.push(projectDir, configHome);

  await mkdir(join(projectDir, ".vvoc", "agents"), { recursive: true });
  await writeFile(
    join(projectDir, ".vvoc", "agents", "guardian.md"),
    "Custom guardian prompt.\n",
    "utf8",
  );

  await mkdir(join(configHome, "vvoc"), { recursive: true });
  const defaultConfig = createDefaultVvocConfig();
  await writeFile(
    join(configHome, "vvoc", "vvoc.json"),
    JSON.stringify(
      {
        ...defaultConfig,
        roles: {
          ...defaultConfig.roles,
          fast: roleFast,
        },
        guardian: {
          ...defaultConfig.guardian,
          ...(options?.guardianModel ? { model: options.guardianModel } : {}),
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  process.env.XDG_CONFIG_HOME = configHome;
  return { projectDir, configHome };
}

test("GuardianPlugin registers guardian as a hidden subagent with explicit two-step limit and fast-role model", async () => {
  const { projectDir } = await setupGuardianWorkspace();
  const logs: string[] = [];

  const plugin = await GuardianPlugin({
    client: {
      app: {
        log: async (input: { body: { message: string } }) => {
          logs.push(input.body.message);
          return undefined;
        },
      },
      session: {
        messages: async () => ({ data: [] }),
      },
      tui: {
        showToast: async () => undefined,
      },
      permission: {
        reply: async () => ({ data: true }),
      },
    } as never,
    project: {} as never,
    directory: projectDir,
    worktree: projectDir,
    serverUrl: new URL("http://localhost"),
    $: {} as never,
  });

  const config: Record<string, unknown> = {};
  await plugin.config?.(config as never);

  const guardian = (config.agent as Record<string, Record<string, unknown>>)?.guardian;
  expect(guardian?.mode).toBe("subagent");
  expect(guardian?.hidden).toBe(true);
  expect(guardian?.steps).toBe(2);
  expect(guardian?.prompt).toBe("Custom guardian prompt.");
  expect(guardian?.model).toBe("openai/test-fast-model");
  expect(logs).toContain(
    "[guardian][loadGuardianRuntimeConfig][BLOCK_LOAD_GUARDIAN_RUNTIME_CONFIG] guardian runtime config loaded",
  );
});

test("GuardianPlugin ignores stale guardian model fields in vvoc.json and keeps roles.fast as default", async () => {
  const { projectDir } = await setupGuardianWorkspace({
    roleFast: "openai/role-fast-model:role-variant",
    guardianModel: "legacy/stale-guardian-model",
  });

  const plugin = await GuardianPlugin({
    client: {
      app: {
        log: async () => undefined,
      },
      session: {
        messages: async () => ({ data: [] }),
      },
      tui: {
        showToast: async () => undefined,
      },
      permission: {
        reply: async () => ({ data: true }),
      },
    } as never,
    project: {} as never,
    directory: projectDir,
    worktree: projectDir,
    serverUrl: new URL("http://localhost"),
    $: {} as never,
  });

  const config: Record<string, unknown> = {};
  await plugin.config?.(config as never);

  const guardian = (config.agent as Record<string, Record<string, unknown>>)?.guardian;
  expect(guardian?.model).toBe("openai/role-fast-model:role-variant");
});

test("GuardianPlugin still allows env model override over the roles.fast default", async () => {
  const { projectDir } = await setupGuardianWorkspace({
    roleFast: "openai/role-fast-model",
  });

  process.env.OPENCODE_GUARDIAN_MODEL = "openai/env-guardian-model";

  const plugin = await GuardianPlugin({
    client: {
      app: {
        log: async () => undefined,
      },
      session: {
        messages: async () => ({ data: [] }),
      },
      tui: {
        showToast: async () => undefined,
      },
      permission: {
        reply: async () => ({ data: true }),
      },
    } as never,
    project: {} as never,
    directory: projectDir,
    worktree: projectDir,
    serverUrl: new URL("http://localhost"),
    $: {} as never,
  });

  const config: Record<string, unknown> = {};
  await plugin.config?.(config as never);

  const guardian = (config.agent as Record<string, Record<string, unknown>>)?.guardian;
  expect(guardian?.model).toBe("openai/env-guardian-model");
});

test("GuardianPlugin fails loudly when built-in fast role cannot resolve to a concrete model", async () => {
  const { projectDir } = await setupGuardianWorkspace({
    roleFast: "not-a-valid-model-selection",
  });

  await expect(
    GuardianPlugin({
      client: {
        app: {
          log: async () => undefined,
        },
      } as never,
      project: {} as never,
      directory: projectDir,
      worktree: projectDir,
      serverUrl: new URL("http://localhost"),
      $: {} as never,
    }),
  ).rejects.toMatchObject({
    code: "UNKNOWN_ROLE",
  });
});

test("Guardian review failures fall back to manual approval without auto-allow", async () => {
  const { projectDir } = await setupGuardianWorkspace();
  const logs: string[] = [];
  const permissionReplies: unknown[] = [];

  process.env.PATH = "";

  const plugin = await GuardianPlugin({
    client: {
      app: {
        log: async (input: { body: { message: string } }) => {
          logs.push(input.body.message);
          return undefined;
        },
      },
      session: {
        messages: async () => ({ data: [] }),
      },
      tui: {
        showToast: async () => undefined,
      },
      permission: {
        reply: async (input: unknown) => {
          permissionReplies.push(input);
          return { data: true };
        },
      },
    } as never,
    project: {} as never,
    directory: projectDir,
    worktree: projectDir,
    serverUrl: new URL("http://localhost"),
    $: {} as never,
  });

  await plugin.event?.({
    event: {
      type: "permission.asked",
      properties: {
        id: "perm_1",
        sessionID: "session_1",
        permission: "bash",
      },
    },
  } as never);

  expect(permissionReplies).toHaveLength(0);
  expect(logs).toContain(
    "[guardian][reviewPermissionRequest][BLOCK_REVIEW_PERMISSION_REQUEST] guardian review started",
  );
  expect(logs).toContain(
    "[guardian][reviewPermissionRequest][BLOCK_REVIEW_PERMISSION_REQUEST] guardian review completed",
  );
});
