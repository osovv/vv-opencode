// FILE: src/lib/config-layers.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify layered vvoc and OpenCode config source resolution.
//   SCOPE: Temp-dir coverage for project-root discovery, env/global/default/missing source kinds, and write target selection.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, src/lib/config-layers.ts]
//   LINKS: [M-CLI-CONFIG, V-M-CLI-CONFIG]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   config layer resolution tests - Verify source precedence, strict project lookup, and global/project root isolation.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Added deterministic temp-dir tests for layered config resolution.]
// END_CHANGE_SUMMARY

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  OPENCODE_CONFIG_ENV,
  VVOC_CONFIG_ENV,
  findNearestProjectConfigRoot,
  resolveConfigWriteTargets,
  resolveOpenCodeConfigSource,
  resolveProjectWriteRoot,
  resolveVvocConfigSource,
} from "./config-layers.js";
import { getProjectOpencodeDir, getProjectVvocConfigPath } from "./vvoc-paths.js";

const tempDirs: string[] = [];

afterEach(async () => {
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
});
