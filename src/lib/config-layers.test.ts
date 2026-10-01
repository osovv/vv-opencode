// FILE: src/lib/config-layers.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify layered vvoc, OpenCode runtime, and OpenCode TUI config source resolution.
//   SCOPE: Temp-dir coverage for project-root discovery, env/global/default/missing source kinds, dedicated TUI paths, write target selection, and singleton runtime config loading.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, src/lib/config-layers.ts, src/lib/vvoc-config.ts]
//   LINKS: [M-CONFIG-LAYERS, V-M-CONFIG-LAYERS]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   createTempRoot - Creates an isolated temporary project root.
//   tempDirs - Tracks temporary roots for cleanup.
//   touch - Creates a fixture file and parent directories.
//   writeValidVvocConfig - Writes a canonical valid vvoc fixture.
//   restoreEnv - Restores an environment variable after a test, deleting it when previously unset.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-CONTEXT-TUI-PLUGIN - Added dedicated global/project/effective TUI config resolution coverage.]
// END_CHANGE_SUMMARY

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  OPENCODE_CONFIG_ENV,
  VVOC_CONFIG_ENV,
  findNearestProjectConfigRoot,
  loadEffectiveVvocConfig,
  loadVvocConfig,
  readRawOpenCodeModelIntent,
  resolveConfigWriteTargets,
  resolveOpenCodeConfigSource,
  resolveProjectWriteRoot,
  resolveVvocConfigSource,
  resetVvocConfigForTests,
} from "./config-layers.js";
import { getProjectOpencodeDir, getProjectVvocConfigPath } from "./vvoc-paths.js";
import { createDefaultVvocConfig } from "./vvoc-config.js";

const tempDirs: string[] = [];

afterEach(async () => {
  resetVvocConfigForTests();

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

async function touch(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "{}\n", "utf8");
}

async function writeValidVvocConfig(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(createDefaultVvocConfig(), null, 2), "utf8");
}

describe("config layer resolution", () => {
  test("findNearestProjectConfigRoot returns the closest ancestor containing .vvoc/vvoc.json", async () => {
    const grandparent = await createTempRoot("vvoc-layer-grandparent-");
    const parent = join(grandparent, "parent");
    const child = join(parent, "child");
    await mkdir(child, { recursive: true });
    await touch(getProjectVvocConfigPath(grandparent));
    await touch(getProjectVvocConfigPath(parent));

    const root = await findNearestProjectConfigRoot(child);

    expect(root?.rootDir).toBe(parent);
    expect(root?.vvocConfigPath).toBe(getProjectVvocConfigPath(parent));
  });

  test("findNearestProjectConfigRoot returns a root discovered by .opencode/opencode.json", async () => {
    const projectDir = await createTempRoot("vvoc-layer-opencode-root-");
    const child = join(projectDir, "packages", "app");
    await mkdir(child, { recursive: true });
    await touch(join(projectDir, ".opencode", "opencode.json"));

    const root = await findNearestProjectConfigRoot(child);

    expect(root?.rootDir).toBe(projectDir);
    expect(root?.opencodeConfigPath).toBe(join(projectDir, ".opencode", "opencode.json"));
  });

  test("project OpenCode config uses .opencode and ignores root opencode.json", async () => {
    const projectDir = await createTempRoot("vvoc-layer-ignore-root-opencode-");
    await touch(join(projectDir, "opencode.json"));
    await touch(join(projectDir, ".opencode", "opencode.json"));

    const source = await resolveOpenCodeConfigSource({ scope: "project", cwd: projectDir });

    expect(source.kind).toBe("project");
    expect(source.path).toBe(join(projectDir, ".opencode", "opencode.json"));
  });

  test("findNearestProjectConfigRoot ignores root-level opencode.json and opencode.jsonc", async () => {
    const projectDir = await createTempRoot("vvoc-layer-legacy-root-");
    await touch(join(projectDir, "opencode.json"));
    await touch(join(projectDir, "opencode.jsonc"));

    await expect(findNearestProjectConfigRoot(projectDir)).resolves.toBeUndefined();
  });

  test("resolveProjectWriteRoot returns cwd when no local project layer exists", async () => {
    const projectDir = await createTempRoot("vvoc-layer-write-root-");

    await expect(resolveProjectWriteRoot(projectDir)).resolves.toBe(projectDir);
  });

  test("effective vvoc source honors VVOC_CONFIG before project and global", async () => {
    const projectDir = await createTempRoot("vvoc-layer-env-project-");
    const configHome = await createTempRoot("vvoc-layer-env-global-");
    const envConfig = join(await createTempRoot("vvoc-layer-env-selected-"), "vvoc.json");
    await touch(getProjectVvocConfigPath(projectDir));
    await touch(join(configHome, "vvoc", "vvoc.json"));
    await touch(envConfig);

    const source = await resolveVvocConfigSource({
      scope: "effective",
      allowDefault: true,
      cwd: projectDir,
      configDir: configHome,
      env: { [VVOC_CONFIG_ENV]: envConfig },
    });

    expect(source.kind).toBe("env");
    expect(source.path).toBe(envConfig);
  });

  test("effective OpenCode source honors OPENCODE_CONFIG before project and global", async () => {
    const projectDir = await createTempRoot("vvoc-layer-opencode-env-project-");
    const configHome = await createTempRoot("vvoc-layer-opencode-env-global-");
    const envConfig = join(
      await createTempRoot("vvoc-layer-opencode-env-selected-"),
      "opencode.json",
    );
    await touch(join(projectDir, ".opencode", "opencode.json"));
    await touch(join(configHome, "opencode", "opencode.json"));
    await touch(envConfig);

    const source = await resolveOpenCodeConfigSource({
      scope: "effective",
      cwd: projectDir,
      configDir: configHome,
      env: { [OPENCODE_CONFIG_ENV]: envConfig },
    });

    expect(source.kind).toBe("env");
    expect(source.path).toBe(envConfig);
  });

  test("--config-dir affects only global source paths and not project discovery", async () => {
    const projectDir = await createTempRoot("vvoc-layer-config-dir-project-");
    const configHome = await createTempRoot("vvoc-layer-config-dir-global-");
    await touch(getProjectVvocConfigPath(projectDir));
    await touch(join(configHome, "vvoc", "vvoc.json"));

    const projectSource = await resolveVvocConfigSource({
      scope: "project",
      allowDefault: false,
      cwd: projectDir,
      configDir: configHome,
    });
    const globalSource = await resolveVvocConfigSource({
      scope: "global",
      allowDefault: false,
      cwd: projectDir,
      configDir: configHome,
    });

    expect(projectSource.path).toBe(getProjectVvocConfigPath(projectDir));
    expect(globalSource.path).toBe(join(configHome, "vvoc", "vvoc.json"));
  });

  test("source kinds cover project, global, default, and missing", async () => {
    const projectDir = await createTempRoot("vvoc-layer-kinds-project-");
    const emptyDir = await createTempRoot("vvoc-layer-kinds-empty-");
    const configHome = await createTempRoot("vvoc-layer-kinds-global-");
    await touch(getProjectVvocConfigPath(projectDir));
    await touch(join(configHome, "vvoc", "vvoc.json"));

    await expect(
      resolveVvocConfigSource({ scope: "project", allowDefault: false, cwd: projectDir }),
    ).resolves.toMatchObject({ kind: "project" });
    await expect(
      resolveVvocConfigSource({
        scope: "global",
        allowDefault: false,
        cwd: emptyDir,
        configDir: configHome,
      }),
    ).resolves.toMatchObject({ kind: "global" });
    await expect(
      resolveVvocConfigSource({
        scope: "effective",
        allowDefault: true,
        cwd: emptyDir,
        configDir: emptyDir,
        env: {},
      }),
    ).resolves.toMatchObject({ kind: "default" });
    await expect(
      resolveOpenCodeConfigSource({ scope: "project", cwd: emptyDir }),
    ).resolves.toMatchObject({ kind: "missing" });
  });

  test("project write targets use .opencode and .vvoc under separate temp roots", async () => {
    const projectDir = await createTempRoot("vvoc-layer-write-target-project-");
    const configHome = await createTempRoot("vvoc-layer-write-target-global-");

    const targets = await resolveConfigWriteTargets({
      scope: "project",
      cwd: projectDir,
      configDir: configHome,
    });

    expect(targets.projectRoot).toBe(projectDir);
    expect(targets.opencodeBaseDir).toBe(getProjectOpencodeDir(projectDir));
    expect(targets.opencodeConfigPath).toBe(join(projectDir, ".opencode", "opencode.json"));
    expect(targets.vvocConfigPath).toBe(join(projectDir, ".vvoc", "vvoc.json"));
  });

  test("loadVvocConfig returns the same startup promise for repeated runtime calls", async () => {
    const projectDir = await createTempRoot("vvoc-layer-runtime-project-");
    const configHome = await createTempRoot("vvoc-layer-runtime-global-");
    await writeValidVvocConfig(join(configHome, "vvoc", "vvoc.json"));

    const first = loadVvocConfig({ cwd: projectDir, configDir: configHome });
    const second = loadVvocConfig({ cwd: projectDir, configDir: configHome });

    expect(second).toBe(first);
    await expect(first).resolves.toMatchObject({ source: { kind: "global" } });
  });

  test("loadVvocConfig rejects conflicting runtime initialization options", async () => {
    const firstDir = await createTempRoot("vvoc-layer-runtime-first-");
    const secondDir = await createTempRoot("vvoc-layer-runtime-second-");
    const configHome = await createTempRoot("vvoc-layer-runtime-conflict-home-");

    const first = loadVvocConfig({ cwd: firstDir, configDir: configHome });

    expect(() => loadVvocConfig({ cwd: secondDir, configDir: configHome })).toThrow(
      "VVOC_CONFIG_ALREADY_LOADED",
    );
    await expect(first).resolves.toMatchObject({ source: { kind: "default" } });
  });

  test("readRawOpenCodeModelIntent preserves raw role and literal intent before normalization", async () => {
    const projectDir = await createTempRoot("vvoc-layer-raw-intent-");
    const emptyHome = await createTempRoot("vvoc-layer-raw-intent-home-");
    const prevXdg = process.env.XDG_CONFIG_HOME;
    const prevDir = process.env.OPENCODE_CONFIG_DIR;
    const prevExplicit = process.env.OPENCODE_CONFIG;
    const prevContent = process.env.OPENCODE_CONFIG_CONTENT;
    process.env.XDG_CONFIG_HOME = emptyHome;
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.OPENCODE_CONFIG;
    delete process.env.OPENCODE_CONFIG_CONTENT;
    try {
      await mkdir(join(projectDir, ".opencode"), { recursive: true });
      await writeFile(
        join(projectDir, ".opencode", "opencode.json"),
        JSON.stringify(
          {
            model: "prov/root-literal",
            agents: {
              explore: { model: "prov/explore-literal" },
            },
            plugins: [
              {
                package: "@osovv/vv-opencode@1.7.0",
                options: {
                  modelIntent: {
                    model: "vv-role:default",
                    smallModel: "prov/small",
                    agents: { build: "vv-role:smart" },
                    commands: { deploy: "vv-role:reviewer" },
                  },
                },
              },
            ],
          },
          null,
          2,
        ),
        "utf8",
      );

      const intent = await readRawOpenCodeModelIntent(projectDir);
      expect(intent?.model).toBe("prov/root-literal");
      expect(intent?.smallModel).toBe("prov/small");
      expect(intent?.agents).toEqual({
        build: "vv-role:smart",
        explore: "prov/explore-literal",
      });
      expect(intent?.commands).toEqual({ deploy: "vv-role:reviewer" });
      expect(intent?.sourcePath).toBe(join(projectDir, ".opencode", "opencode.json"));
    } finally {
      restoreEnv("XDG_CONFIG_HOME", prevXdg);
      restoreEnv("OPENCODE_CONFIG_DIR", prevDir);
      restoreEnv("OPENCODE_CONFIG", prevExplicit);
      restoreEnv("OPENCODE_CONFIG_CONTENT", prevContent);
    }
  });

  test("readRawOpenCodeModelIntent ignores invalid documents instead of throwing", async () => {
    const projectDir = await createTempRoot("vvoc-layer-raw-invalid-");
    const emptyHome = await createTempRoot("vvoc-layer-raw-invalid-home-");
    const prevXdg = process.env.XDG_CONFIG_HOME;
    const prevDir = process.env.OPENCODE_CONFIG_DIR;
    const prevExplicit = process.env.OPENCODE_CONFIG;
    const prevContent = process.env.OPENCODE_CONFIG_CONTENT;
    try {
      process.env.XDG_CONFIG_HOME = emptyHome;
      delete process.env.OPENCODE_CONFIG_DIR;
      delete process.env.OPENCODE_CONFIG;
      delete process.env.OPENCODE_CONFIG_CONTENT;
      await mkdir(join(projectDir, ".opencode"), { recursive: true });
      await writeFile(join(projectDir, ".opencode", "opencode.json"), "{ not json", "utf8");
      await expect(readRawOpenCodeModelIntent(projectDir)).resolves.toBeUndefined();
    } finally {
      restoreEnv("XDG_CONFIG_HOME", prevXdg);
      restoreEnv("OPENCODE_CONFIG_DIR", prevDir);
      restoreEnv("OPENCODE_CONFIG", prevExplicit);
      restoreEnv("OPENCODE_CONFIG_CONTENT", prevContent);
    }
  });

  test("loadEffectiveVvocConfig resolves each location without the singleton conflict", async () => {
    const firstDir = await createTempRoot("vvoc-layer-effective-first-");
    const secondDir = await createTempRoot("vvoc-layer-effective-second-");
    await writeValidVvocConfig(getProjectVvocConfigPath(firstDir));
    await writeValidVvocConfig(getProjectVvocConfigPath(secondDir));

    const first = await loadEffectiveVvocConfig({ cwd: firstDir, env: {} });
    const second = await loadEffectiveVvocConfig({ cwd: secondDir, env: {} });

    expect(first.source.path).toBe(getProjectVvocConfigPath(firstDir));
    expect(second.source.path).toBe(getProjectVvocConfigPath(secondDir));
  });
});

describe("getCacheHome", () => {
  test("respects an explicit override, then XDG_CACHE_HOME, then the home fallback", async () => {
    const { getCacheHome } = await import("./vvoc-paths.js");
    expect(getCacheHome("/custom/cache")).toBe("/custom/cache");
    const prev = process.env.XDG_CACHE_HOME;
    try {
      process.env.XDG_CACHE_HOME = "/xdg/cache";
      expect(getCacheHome()).toBe("/xdg/cache");
      delete process.env.XDG_CACHE_HOME;
      expect(getCacheHome()).toBe(join(homedir(), ".cache"));
    } finally {
      if (prev === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = prev;
    }
  });
});

describe("native layered model intent", () => {
  test("keeps a global role envelope when a project document only sets an unrelated field", async () => {
    const globalHome = await createTempRoot("vvoc-intent-global-");
    const projectDir = await createTempRoot("vvoc-intent-project-");
    const prevXdg = process.env.XDG_CONFIG_HOME;
    const prevDir = process.env.OPENCODE_CONFIG_DIR;
    const prevExplicit = process.env.OPENCODE_CONFIG;
    const prevContent = process.env.OPENCODE_CONFIG_CONTENT;
    try {
      delete process.env.OPENCODE_CONFIG_DIR;
      delete process.env.OPENCODE_CONFIG;
      delete process.env.OPENCODE_CONFIG_CONTENT;
      process.env.XDG_CONFIG_HOME = globalHome;
      await mkdir(join(globalHome, "opencode"), { recursive: true });
      await writeFile(
        join(globalHome, "opencode", "opencode.json"),
        JSON.stringify(
          {
            plugins: [
              {
                package: "@osovv/vv-opencode@1.7.0",
                options: {
                  modelIntent: {
                    model: "vv-role:default",
                    smallModel: "vv-role:fast",
                    agents: { build: "vv-role:smart" },
                  },
                },
              },
            ],
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );
      await mkdir(join(projectDir, ".opencode"), { recursive: true });
      await writeFile(
        join(projectDir, ".opencode", "opencode.json"),
        JSON.stringify({ shell: "sh" }, null, 2) + "\n",
        "utf8",
      );

      const intent = await readRawOpenCodeModelIntent(projectDir);
      expect(intent?.model).toBe("vv-role:default");
      expect(intent?.smallModel).toBe("vv-role:fast");
      expect(intent?.agents).toEqual({ build: "vv-role:smart" });
      expect(intent?.sourcePath).toBe(join(projectDir, ".opencode", "opencode.json"));
    } finally {
      restoreEnv("XDG_CONFIG_HOME", prevXdg);
      restoreEnv("OPENCODE_CONFIG_DIR", prevDir);
      restoreEnv("OPENCODE_CONFIG", prevExplicit);
      restoreEnv("OPENCODE_CONFIG_CONTENT", prevContent);
    }
  });

  test("higher-precedence native explicit selections win, including struct variants", async () => {
    const globalHome = await createTempRoot("vvoc-intent-prec-global-");
    const projectDir = await createTempRoot("vvoc-intent-prec-project-");
    const prevXdg = process.env.XDG_CONFIG_HOME;
    const prevDir = process.env.OPENCODE_CONFIG_DIR;
    const prevContent = process.env.OPENCODE_CONFIG_CONTENT;
    try {
      delete process.env.OPENCODE_CONFIG_DIR;
      delete process.env.OPENCODE_CONFIG_CONTENT;
      process.env.XDG_CONFIG_HOME = globalHome;
      await mkdir(join(globalHome, "opencode"), { recursive: true });
      await writeFile(
        join(globalHome, "opencode", "opencode.json"),
        JSON.stringify(
          {
            model: "openai/gpt-5.6-terra#high",
            plugins: [
              {
                package: "@osovv/vv-opencode@1.7.0",
                options: { modelIntent: { model: "vv-role:default" } },
              },
            ],
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );
      await mkdir(join(projectDir, ".opencode"), { recursive: true });
      await writeFile(
        join(projectDir, ".opencode", "opencode.json"),
        JSON.stringify(
          {
            model: { providerID: "openai", model: "gpt-5.6-sol", variant: "xhigh" },
            agents: { build: { model: "zai-coding-plan/glm-5.3#max" } },
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );

      const intent = await readRawOpenCodeModelIntent(projectDir);
      expect(intent?.model).toBe("openai/gpt-5.6-sol#xhigh");
      expect(intent?.agents).toEqual({ build: "zai-coding-plan/glm-5.3#max" });
    } finally {
      restoreEnv("XDG_CONFIG_HOME", prevXdg);
      restoreEnv("OPENCODE_CONFIG_DIR", prevDir);
      restoreEnv("OPENCODE_CONFIG_CONTENT", prevContent);
    }
  });

  test("OPENCODE_CONFIG_DIR replaces the global root and OPENCODE_CONFIG adds a document", async () => {
    const replacementRoot = await createTempRoot("vvoc-intent-replace-");
    const explicitDir = await createTempRoot("vvoc-intent-explicit-");
    const projectDir = await createTempRoot("vvoc-intent-explicit-project-");
    const prevDir = process.env.OPENCODE_CONFIG_DIR;
    const prevExplicit = process.env.OPENCODE_CONFIG;
    const prevXdg = process.env.XDG_CONFIG_HOME;
    const prevContent = process.env.OPENCODE_CONFIG_CONTENT;
    try {
      process.env.XDG_CONFIG_HOME = replacementRoot;
      process.env.OPENCODE_CONFIG_DIR = replacementRoot;
      delete process.env.OPENCODE_CONFIG_CONTENT;
      await writeFile(
        join(replacementRoot, "opencode.json"),
        JSON.stringify({
          plugins: [
            { package: "vv-opencode", options: { modelIntent: { model: "vv-role:default" } } },
          ],
        }) + "\n",
        "utf8",
      );
      const explicitPath = join(explicitDir, "explicit.json");
      await writeFile(
        explicitPath,
        JSON.stringify({ model: "openai/gpt-6-luna#low" }) + "\n",
        "utf8",
      );
      process.env.OPENCODE_CONFIG = explicitPath;

      const intent = await readRawOpenCodeModelIntent(projectDir);
      expect(intent?.model).toBe("openai/gpt-6-luna#low");
    } finally {
      restoreEnv("OPENCODE_CONFIG_DIR", prevDir);
      restoreEnv("OPENCODE_CONFIG", prevExplicit);
      restoreEnv("XDG_CONFIG_HOME", prevXdg);
      restoreEnv("OPENCODE_CONFIG_CONTENT", prevContent);
    }
  });

  test("reads the global envelope from the native OPENCODE_CONFIG_DIR root", async () => {
    const nativeRoot = await createTempRoot("vvoc-intent-nativeroot-");
    const projectDir = await createTempRoot("vvoc-intent-nativeroot-project-");
    const prevDir = process.env.OPENCODE_CONFIG_DIR;
    const prevContent = process.env.OPENCODE_CONFIG_CONTENT;
    try {
      delete process.env.OPENCODE_CONFIG_CONTENT;
      process.env.OPENCODE_CONFIG_DIR = nativeRoot;
      await writeFile(
        join(nativeRoot, "opencode.json"),
        JSON.stringify({
          plugins: [
            {
              package: "@osovv/vv-opencode@1.7.0",
              options: { modelIntent: { model: "vv-role:smart" } },
            },
          ],
        }) + "\n",
        "utf8",
      );
      const intent = await readRawOpenCodeModelIntent(projectDir);
      expect(intent?.model).toBe("vv-role:smart");
      expect(intent?.sourcePath).toBe(join(nativeRoot, "opencode.json"));
    } finally {
      restoreEnv("OPENCODE_CONFIG_DIR", prevDir);
      restoreEnv("OPENCODE_CONFIG_CONTENT", prevContent);
    }
  });

  test("rejects malformed vvoc-owned modelIntent instead of silently falling back", async () => {
    const projectDir = await createTempRoot("vvoc-intent-malformed-");
    await mkdir(join(projectDir, ".opencode"), { recursive: true });
    await writeFile(
      join(projectDir, ".opencode", "opencode.json"),
      JSON.stringify({
        plugins: [
          { package: "@osovv/vv-opencode@1.7.0", options: { modelIntent: "not-an-object" } },
        ],
      }) + "\n",
      "utf8",
    );

    await expect(readRawOpenCodeModelIntent(projectDir)).rejects.toThrow(
      "modelIntent must be an object",
    );
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
