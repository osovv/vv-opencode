import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryPlugin } from "./memory.js";
import {
  deleteMemory,
  getMemory,
  listMemories,
  loadMemoryRuntimeConfig,
  putMemory,
  searchMemories,
  updateMemory,
} from "./memory-store.js";

describe("loadMemoryRuntimeConfig", () => {
  test("uses global and project vvoc config files", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-config-home-"));
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-memory-project-"));

    try {
      await mkdir(join(configHome, "vvoc"), { recursive: true });
      await mkdir(join(projectDir, ".vvoc"), { recursive: true });
      await writeFile(
        join(configHome, "vvoc", "memory.jsonc"),
        '{\n  "defaultSearchLimit": 4\n}\n',
        "utf8",
      );
      await writeFile(
        join(projectDir, ".vvoc", "memory.jsonc"),
        '{\n  "enabled": true,\n  "defaultSearchLimit": 2\n}\n',
        "utf8",
      );

      const previous = process.env.XDG_CONFIG_HOME;
      process.env.XDG_CONFIG_HOME = configHome;

      try {
        const memoryConfig = await loadMemoryRuntimeConfig(projectDir);

        expect(memoryConfig.enabled).toBe(true);
        expect(memoryConfig.defaultSearchLimit).toBe(2);
        expect(memoryConfig.storageRoot).toBe(join(projectDir, ".vvoc", "memory"));
        expect(memoryConfig.sources).toEqual([
          join(configHome, "vvoc", "memory.jsonc"),
          join(projectDir, ".vvoc", "memory.jsonc"),
        ]);
      } finally {
        if (previous === undefined) {
          delete process.env.XDG_CONFIG_HOME;
        } else {
          process.env.XDG_CONFIG_HOME = previous;
        }
      }
    } finally {
      await rm(configHome, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});

describe("memory store", () => {
  test("stores, searches, updates, lists, and deletes scoped memories", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-memory-store-"));

    try {
      const memoryConfig = await loadMemoryRuntimeConfig(projectDir);
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
        existsSync(join(memoryConfig.storageRoot, "project", `${projectMemory.id}.json`)),
      ).toBe(true);
      expect(
        existsSync(
          join(
            memoryConfig.storageRoot,
            "branch",
            encodeURIComponent("feature/memory-plugin"),
            `${branchMemory.id}.json`,
          ),
        ),
      ).toBe(true);
      expect(
        existsSync(
          join(memoryConfig.storageRoot, "session", "session-123", `${sessionMemory.id}.json`),
        ),
      ).toBe(true);
      expect(
        existsSync(join(memoryConfig.storageRoot, "shared", "team", `${sharedMemory.id}.json`)),
      ).toBe(true);

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

      const deleted = await deleteMemory(memoryConfig, sessionMemory.id);
      expect(deleted?.id).toBe(sessionMemory.id);
      expect(await getMemory(memoryConfig, sessionMemory.id)).toBeNull();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});

describe("MemoryPlugin", () => {
  test("registers explicit memory tools and reviewer agent", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-memory-plugin-"));

    try {
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
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
