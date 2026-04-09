// FILE: src/plugins/memory.test.ts
// VERSION: 0.3.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify vvoc memory runtime config, scope semantics, and plugin registration behavior.
//   SCOPE: Canonical memory config loading, config round-trips, cross-project shared scope visibility, CRUD/search behavior, and plugin-level system instruction/reviewer prompt setup.
//   DEPENDS: [bun:test, node:fs, node:fs/promises, node:os, node:path, src/plugins/memory.ts, src/plugins/memory-store.ts]
//   LINKS: [V-M-PLUGIN-MEMORY-STORE, V-M-PLUGIN-MEMORY]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   loadMemoryRuntimeConfig tests - Verify config merge and storage root derivation.
//   memory store tests - Verify local/shared scope storage semantics and CRUD/search behavior.
//   MemoryPlugin tests - Verify tool registration, reviewer setup, and proactive system instruction injection.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.3.0 - Updated memory config coverage for the canonical vvoc.json file.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MemoryPlugin } from "./memory/index.js";
import { VVOC_CONFIG_SCHEMA_URL } from "../lib/vvoc-config.js";
import {
  deleteMemory,
  getMemory,
  listMemories,
  loadMemoryRuntimeConfig,
  parseMemoryConfigText,
  putMemory,
  renderMemoryConfig,
  searchMemories,
  updateMemory,
} from "./memory-store.js";

describe("loadMemoryRuntimeConfig", () => {
  test("uses the canonical global vvoc config file and ignores legacy project config files", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-config-home-"));
    const dataHome = await mkdtemp(join(tmpdir(), "vvoc-data-home-"));
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-memory-project-"));

    try {
      await mkdir(join(configHome, "vvoc"), { recursive: true });
      await mkdir(join(projectDir, ".vvoc"), { recursive: true });
      await writeFile(
        join(configHome, "vvoc", "vvoc.json"),
        JSON.stringify(
          {
            $schema: VVOC_CONFIG_SCHEMA_URL,
            version: 1,
            guardian: {
              timeoutMs: 90000,
              approvalRiskThreshold: 80,
              reviewToastDurationMs: 90000,
            },
            memory: {
              enabled: true,
              defaultSearchLimit: 4,
            },
            secretsRedaction: {
              enabled: true,
              secret: "${VVOC_SECRET}",
              ttlMs: 3600000,
              maxMappings: 10000,
              patterns: {
                keywords: [],
                regex: [],
                builtin: ["email"],
                exclude: [],
              },
              debug: false,
            },
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeFile(
        join(projectDir, ".vvoc", "memory.jsonc"),
        '{\n  "enabled": true,\n  "defaultSearchLimit": 2\n}\n',
        "utf8",
      );

      const previousConfigHome = process.env.XDG_CONFIG_HOME;
      const previousDataHome = process.env.XDG_DATA_HOME;
      process.env.XDG_CONFIG_HOME = configHome;
      process.env.XDG_DATA_HOME = dataHome;

      try {
        const memoryConfig = await loadMemoryRuntimeConfig(projectDir);

        expect(memoryConfig.enabled).toBe(true);
        expect(memoryConfig.defaultSearchLimit).toBe(4);
        expect(memoryConfig.projectStorageRoot).toContain(join(dataHome, "vvoc", "projects"));
        expect(memoryConfig.projectStorageRoot).toContain("vvoc-memory-project-");
        expect(memoryConfig.projectStorageRoot.endsWith("/memory")).toBe(true);
        expect(memoryConfig.sharedStorageRoot).toBe(join(dataHome, "vvoc", "memory"));
        expect(memoryConfig.sources).toEqual([join(configHome, "vvoc", "vvoc.json")]);
      } finally {
        if (previousConfigHome === undefined) {
          delete process.env.XDG_CONFIG_HOME;
        } else {
          process.env.XDG_CONFIG_HOME = previousConfigHome;
        }

        if (previousDataHome === undefined) {
          delete process.env.XDG_DATA_HOME;
        } else {
          process.env.XDG_DATA_HOME = previousDataHome;
        }
      }
    } finally {
      await rm(configHome, { recursive: true, force: true });
      await rm(dataHome, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("round-trips managed memory config values", () => {
    const output = renderMemoryConfig({
      enabled: false,
      defaultSearchLimit: 12,
    });
    const parsed = parseMemoryConfigText(output, "test memory config");

    expect(parsed).toEqual({
      enabled: false,
      defaultSearchLimit: 12,
    });
  });
});

describe("memory store", () => {
  test("stores local scopes per project and shared scope globally", async () => {
    const dataHome = await mkdtemp(join(tmpdir(), "vvoc-memory-data-"));
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-memory-store-a-"));
    const otherProjectDir = await mkdtemp(join(tmpdir(), "vvoc-memory-store-b-"));
    const previousDataHome = process.env.XDG_DATA_HOME;

    try {
      process.env.XDG_DATA_HOME = dataHome;

      const memoryConfig = await loadMemoryRuntimeConfig(projectDir);
      const otherMemoryConfig = await loadMemoryRuntimeConfig(otherProjectDir);

      const projectMemory = await putMemory(memoryConfig, {
        scope_type: "project",
        scope_key: "project",
        kind: "preference",
        text: "Prefer explicit memory tools for durable facts.",
        tags: ["memory", "facts"],
      });
      const branchMemory = await putMemory(memoryConfig, {
        scope_type: "branch",
        scope_key: "feature/memory-plugin",
        kind: "procedural",
        text: "Keep branch-specific memory entries short.",
        tags: ["branch", "memory"],
      });
      const sessionMemory = await putMemory(memoryConfig, {
        scope_type: "session",
        scope_key: "session-123",
        kind: "note",
        text: "Investigating explicit memory UX.",
        tags: ["session"],
      });
      const sharedMemory = await putMemory(memoryConfig, {
        scope_type: "shared",
        scope_key: "team",
        kind: "decision",
        text: "Memory stays explicit and never injects stored entries into prompts.",
        tags: ["policy", "memory"],
      });

      expect(
        existsSync(join(memoryConfig.projectStorageRoot, "project", `${projectMemory.id}.json`)),
      ).toBe(true);
      expect(
        existsSync(
          join(
            memoryConfig.projectStorageRoot,
            "branch",
            encodeURIComponent("feature/memory-plugin"),
            `${branchMemory.id}.json`,
          ),
        ),
      ).toBe(true);
      expect(
        existsSync(
          join(
            memoryConfig.projectStorageRoot,
            "session",
            "session-123",
            `${sessionMemory.id}.json`,
          ),
        ),
      ).toBe(true);
      expect(
        existsSync(
          join(memoryConfig.sharedStorageRoot, "shared", "team", `${sharedMemory.id}.json`),
        ),
      ).toBe(true);

      expect(otherMemoryConfig.sharedStorageRoot).toBe(memoryConfig.sharedStorageRoot);
      expect(otherMemoryConfig.projectStorageRoot).not.toBe(memoryConfig.projectStorageRoot);

      const branchResults = await searchMemories(memoryConfig, "branch-specific memory", {
        scopes: [{ scopeType: "branch", scopeKey: "feature/memory-plugin" }],
        limit: 5,
      });
      expect(branchResults[0]?.id).toBe(branchMemory.id);

      const loaded = await getMemory(memoryConfig, projectMemory.id);
      expect(loaded?.text).toBe(projectMemory.text);

      const updated = await updateMemory(memoryConfig, projectMemory.id, {
        text: "Prefer explicit memory tools for durable facts and preferences.",
        tags: ["memory", "facts", "preferences"],
      });
      expect(updated?.text).toContain("preferences");

      const listed = await listMemories(memoryConfig, {
        scopes: [{ scopeType: "shared", scopeKey: "team" }],
        limit: 5,
      });
      expect(listed).toHaveLength(1);
      expect(listed[0]?.id).toBe(sharedMemory.id);

      const sharedFromOtherProject = await listMemories(otherMemoryConfig, {
        scopes: [{ scopeType: "shared", scopeKey: "team" }],
        limit: 5,
      });
      expect(sharedFromOtherProject).toHaveLength(1);
      expect(sharedFromOtherProject[0]?.id).toBe(sharedMemory.id);

      const projectFromOtherProject = await listMemories(otherMemoryConfig, {
        scopes: [{ scopeType: "project", scopeKey: "project" }],
        limit: 5,
      });
      expect(projectFromOtherProject).toHaveLength(0);

      const ignoredLegacySharedPath = join(
        memoryConfig.projectStorageRoot,
        "shared",
        "team",
        "mem_legacy.json",
      );
      await mkdir(dirname(ignoredLegacySharedPath), { recursive: true });
      await writeFile(
        ignoredLegacySharedPath,
        JSON.stringify({
          id: "mem_legacy",
          scope_type: "shared",
          scope_key: "team",
          kind: "decision",
          text: "old project-local shared entry",
          tags: [],
          meta: {},
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
        "utf8",
      );

      const sharedAfterLegacyWrite = await listMemories(memoryConfig, {
        scopes: [{ scopeType: "shared", scopeKey: "team" }],
        limit: 10,
      });
      expect(sharedAfterLegacyWrite.map((entry) => entry.id)).toEqual([sharedMemory.id]);

      const deleted = await deleteMemory(memoryConfig, sessionMemory.id);
      expect(deleted?.id).toBe(sessionMemory.id);
      expect(await getMemory(memoryConfig, sessionMemory.id)).toBeNull();
    } finally {
      if (previousDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousDataHome;
      }
      await rm(dataHome, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
      await rm(otherProjectDir, { recursive: true, force: true });
    }
  });
});

describe("MemoryPlugin", () => {
  test("fails when managed memory-reviewer prompt is missing", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-memory-config-home-"));
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-memory-plugin-missing-"));
    const previousConfigHome = process.env.XDG_CONFIG_HOME;

    try {
      process.env.XDG_CONFIG_HOME = configHome;

      await expect(
        MemoryPlugin({
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
      ).rejects.toThrow("vvoc managed prompt not found for memory-reviewer");
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

  test("registers explicit memory tools and reviewer agent", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-memory-config-home-"));
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-memory-plugin-"));
    const previousConfigHome = process.env.XDG_CONFIG_HOME;

    try {
      process.env.XDG_CONFIG_HOME = configHome;
      await mkdir(join(configHome, "vvoc", "agents"), { recursive: true });
      await writeFile(
        join(configHome, "vvoc", "agents", "memory-reviewer.md"),
        "Custom global memory reviewer prompt.\n",
        "utf8",
      );

      const plugin = await MemoryPlugin({
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
      });

      expect(plugin.tool).toBeDefined();
      expect(Object.keys(plugin.tool ?? {})).toEqual([
        "memory_search",
        "memory_get",
        "memory_put",
        "memory_update",
        "memory_delete",
        "memory_list",
      ]);

      const config: Record<string, unknown> = {};
      await plugin.config?.(config as never);

      expect((config.agent as Record<string, { mode?: string }>)?.["memory-reviewer"]?.mode).toBe(
        "subagent",
      );
      expect(
        (config.agent as Record<string, { steps?: number }>)?.["memory-reviewer"]?.steps,
      ).toBeUndefined();
      expect(
        (config.agent as Record<string, { prompt?: string }>)?.["memory-reviewer"]?.prompt,
      ).toBe("Custom global memory reviewer prompt.");

      const system = { system: ["base system prompt"] };
      await plugin["experimental.chat.system.transform"]?.(
        {
          sessionID: "session-1",
          model: {} as never,
        },
        system,
      );

      expect(system.system).toContain("base system prompt");
      expect(system.system.join("\n\n")).toContain(
        "vvoc explicit memory is available in this workspace.",
      );
      expect(system.system.join("\n\n")).toContain("memory_search, memory_list, or memory_get");
      expect(system.system.join("\n\n")).toContain(
        "memory_put if your current role and available tools permit it",
      );
      expect(system.system.join("\n\n")).toContain(
        "Use shared scope for reusable facts that should be visible across projects.",
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
