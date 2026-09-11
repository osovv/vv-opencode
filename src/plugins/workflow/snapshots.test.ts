// FILE: src/plugins/workflow/snapshots.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Deterministic filesystem-backed tests for delegated checkpoint scope normalization and snapshot fingerprints.
//   SCOPE: Pure path rejections, order-independent stable fingerprints, sensitivity to content/creation/deletion/mode/attempt changes, insensitivity to mtime and unrelated files, symlink and unsupported-entry rejection, root mismatches, and stat-coherence rejection.
//   DEPENDS: [bun:test, node:fs/promises, node:path, src/plugins/workflow/snapshots.ts]
//   LINKS: [M-WORKFLOW-SNAPSHOTS, V-M-WORKFLOW-SNAPSHOTS]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   createdRoots - Tracks temporary roots for cleanup after each test.
//   makeRoot - Creates an isolated temporary workspace root.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-DELEGATED-WORKFLOW-ASTRA-PRESETS - Initial coverage: normalization rejections, fingerprint sensitivity matrix, and filesystem hostility cases.]
// END_CHANGE_SUMMARY

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  areFileStatsConsistent,
  captureWorkflowSnapshot,
  normalizeWorkflowScopePaths,
} from "./snapshots.js";

const createdRoots: string[] = [];

async function makeRoot(prefix: string): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), `vvoc-snapshots-${prefix}-`));
  createdRoots.push(root);
  return root;
}

afterEach(async () => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

// START_BLOCK_NORMALIZER_TESTS
describe("normalizeWorkflowScopePaths", () => {
  test("requires an absolute trusted root", () => {
    const result = normalizeWorkflowScopePaths("relative/root", ["src/a.ts"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ROOT_MISMATCH");
  });

  test("rejects malformed declared paths", () => {
    for (const bad of ["/abs.ts", "../up.ts", "wild*.ts", "a\\b.ts", "", "a//b.ts"]) {
      const result = normalizeWorkflowScopePaths("/tmp/root", [bad]);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("INVALID_PATH");
    }
  });

  test("rejects duplicate path aliases", () => {
    const result = normalizeWorkflowScopePaths("/tmp/root", ["src/a.ts", "src/a.ts"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("DUPLICATE_PATH");
  });

  test("normalizes whitespace and preserves canonical relative form", () => {
    const result = normalizeWorkflowScopePaths("/tmp/root", [" src/a.ts ", "src/b.ts"]);
    expect(result).toEqual({ ok: true, paths: ["src/a.ts", "src/b.ts"] });
  });
});
// END_BLOCK_NORMALIZER_TESTS

// START_BLOCK_FINGERPRINT_TESTS
describe("captureWorkflowSnapshot fingerprints", () => {
  test("stable across captures and order-independent for equivalent declarations", async () => {
    const root = await makeRoot("stable");
    await writeFile(join(root, "a.ts"), "alpha\n", "utf8");
    await writeFile(join(root, "b.ts"), "beta\n", "utf8");

    const first = await captureWorkflowSnapshot({
      workspaceRoot: root,
      declaredPaths: ["a.ts", "b.ts"],
      coveredAttemptIds: ["WI-1#1"],
    });
    const second = await captureWorkflowSnapshot({
      workspaceRoot: root,
      declaredPaths: ["b.ts", "a.ts"],
      coveredAttemptIds: ["WI-1#1"],
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.snapshot.fingerprint).toBe(first.snapshot.fingerprint);
    expect(first.snapshot.entries.map((e) => e.path)).toEqual(["a.ts", "b.ts"]);
  });

  test("content edits change the fingerprint; reverting restores it", async () => {
    const root = await makeRoot("content");
    const target = join(root, "a.ts");
    await writeFile(target, "one\n", "utf8");
    const before = await captureWorkflowSnapshot({ workspaceRoot: root, declaredPaths: ["a.ts"] });
    await writeFile(target, "two\n", "utf8");
    const changed = await captureWorkflowSnapshot({ workspaceRoot: root, declaredPaths: ["a.ts"] });
    await writeFile(target, "one\n", "utf8");
    const restored = await captureWorkflowSnapshot({
      workspaceRoot: root,
      declaredPaths: ["a.ts"],
    });

    expect(before.ok && changed.ok && restored.ok).toBe(true);
    if (!before.ok || !changed.ok || !restored.ok) return;
    expect(changed.snapshot.fingerprint).not.toBe(before.snapshot.fingerprint);
    expect(restored.snapshot.fingerprint).toBe(before.snapshot.fingerprint);
  });

  test("creation and deletion of declared absent paths change the fingerprint", async () => {
    const root = await makeRoot("absent");
    const target = join(root, "new.ts");
    const absent = await captureWorkflowSnapshot({
      workspaceRoot: root,
      declaredPaths: ["new.ts"],
    });
    expect(absent.ok).toBe(true);
    if (!absent.ok) return;
    expect(absent.snapshot.entries[0].status).toBe("absent");

    await writeFile(target, "created\n", "utf8");
    const created = await captureWorkflowSnapshot({
      workspaceRoot: root,
      declaredPaths: ["new.ts"],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.snapshot.entries[0].status).toBe("file");
    expect(created.snapshot.fingerprint).not.toBe(absent.snapshot.fingerprint);

    await rm(target);
    const deleted = await captureWorkflowSnapshot({
      workspaceRoot: root,
      declaredPaths: ["new.ts"],
    });
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.snapshot.fingerprint).toBe(absent.snapshot.fingerprint);
  });

  test("permission changes matter; mtime-only changes do not", async () => {
    const root = await makeRoot("mode");
    const target = join(root, "run.sh");
    await writeFile(target, "#!/bin/sh\n", "utf8");
    await chmod(target, 0o644);

    const plain = await captureWorkflowSnapshot({ workspaceRoot: root, declaredPaths: ["run.sh"] });
    await chmod(target, 0o755);
    const executable = await captureWorkflowSnapshot({
      workspaceRoot: root,
      declaredPaths: ["run.sh"],
    });
    await chmod(target, 0o644);
    const reverted = await captureWorkflowSnapshot({
      workspaceRoot: root,
      declaredPaths: ["run.sh"],
    });
    const future = new Date(Date.now() + 60_000);
    await utimes(target, future, future);
    const touched = await captureWorkflowSnapshot({
      workspaceRoot: root,
      declaredPaths: ["run.sh"],
    });

    expect(plain.ok && executable.ok && reverted.ok && touched.ok).toBe(true);
    if (!plain.ok || !executable.ok || !reverted.ok || !touched.ok) return;
    expect(executable.snapshot.fingerprint).not.toBe(plain.snapshot.fingerprint);
    expect(reverted.snapshot.fingerprint).toBe(plain.snapshot.fingerprint);
    expect(touched.snapshot.fingerprint).toBe(plain.snapshot.fingerprint);
  });

  test("unrelated files and covered attempts do not leak into other captures", async () => {
    const root = await makeRoot("unrelated");
    await writeFile(join(root, "watched.ts"), "watched\n", "utf8");
    await writeFile(join(root, "unrelated.ts"), "noise\n", "utf8");

    const base = await captureWorkflowSnapshot({
      workspaceRoot: root,
      declaredPaths: ["watched.ts"],
      coveredAttemptIds: ["WI-1#1"],
    });
    await writeFile(join(root, "unrelated.ts"), "changed noise\n", "utf8");
    const afterNoise = await captureWorkflowSnapshot({
      workspaceRoot: root,
      declaredPaths: ["watched.ts"],
      coveredAttemptIds: ["WI-1#1"],
    });
    const otherAttempt = await captureWorkflowSnapshot({
      workspaceRoot: root,
      declaredPaths: ["watched.ts"],
      coveredAttemptIds: ["WI-1#2"],
    });

    expect(base.ok && afterNoise.ok && otherAttempt.ok).toBe(true);
    if (!base.ok || !afterNoise.ok || !otherAttempt.ok) return;
    expect(afterNoise.snapshot.fingerprint).toBe(base.snapshot.fingerprint);
    expect(otherAttempt.snapshot.fingerprint).not.toBe(base.snapshot.fingerprint);
  });
});
// END_BLOCK_FINGERPRINT_TESTS

// START_BLOCK_HOSTILITY_TESTS
describe("captureWorkflowSnapshot filesystem hostility", () => {
  test("rejects symlinked files and symlinked ancestor directories", async () => {
    const root = await makeRoot("symlink");
    await writeFile(join(root, "real.ts"), "real\n", "utf8");
    await symlink(join(root, "real.ts"), join(root, "link.ts"));
    await mkdir(join(root, "pkg"));
    await writeFile(join(root, "pkg", "inner.ts"), "inner\n", "utf8");
    await symlink(join(root, "pkg"), join(root, "pkg-link"));

    const fileLink = await captureWorkflowSnapshot({
      workspaceRoot: root,
      declaredPaths: ["link.ts"],
    });
    expect(fileLink.ok).toBe(false);
    if (fileLink.ok) return;
    expect(fileLink.code).toBe("SYMLINK");

    const dirLink = await captureWorkflowSnapshot({
      workspaceRoot: root,
      declaredPaths: ["pkg-link/inner.ts"],
    });
    expect(dirLink.ok).toBe(false);
    if (dirLink.ok) return;
    expect(dirLink.code).toBe("SYMLINK");
  });

  test("rejects directories and paths traversing regular files", async () => {
    const root = await makeRoot("nonsfile");
    await mkdir(join(root, "adir"));
    await writeFile(join(root, "plain.ts"), "plain\n", "utf8");

    const directory = await captureWorkflowSnapshot({
      workspaceRoot: root,
      declaredPaths: ["adir"],
    });
    expect(directory.ok).toBe(false);
    if (directory.ok) return;
    expect(directory.code).toBe("UNSUPPORTED_ENTRY");

    const throughFile = await captureWorkflowSnapshot({
      workspaceRoot: root,
      declaredPaths: ["plain.ts/nested.ts"],
    });
    expect(throughFile.ok).toBe(false);
    if (throughFile.ok) return;
    expect(throughFile.code).toBe("UNSUPPORTED_ENTRY");
  });

  test("rejects missing roots and roots that are files", async () => {
    const missing = await captureWorkflowSnapshot({
      workspaceRoot: join(tmpdir(), "vvoc-snapshots-does-not-exist"),
      declaredPaths: ["a.ts"],
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.code).toBe("ROOT_MISMATCH");

    const root = await makeRoot("rootfile");
    const fileTarget = join(root, "not-a-root");
    await writeFile(fileTarget, "x", "utf8");
    const fileRoot = await captureWorkflowSnapshot({
      workspaceRoot: fileTarget,
      declaredPaths: ["a.ts"],
    });
    expect(fileRoot.ok).toBe(false);
    if (fileRoot.ok) return;
    expect(fileRoot.code).toBe("ROOT_MISMATCH");
  });

  test("rejects unreadable files for non-root callers", async () => {
    if (process.getuid?.() === 0) {
      return;
    }
    const root = await makeRoot("unreadable");
    const target = join(root, "secret.ts");
    await writeFile(target, "secret\n", "utf8");
    await chmod(target, 0o000);
    try {
      const result = await captureWorkflowSnapshot({
        workspaceRoot: root,
        declaredPaths: ["secret.ts"],
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("READ_FAILED");
    } finally {
      await chmod(target, 0o644);
    }
  });

  test("stat coherence rejects observed concurrent modification", () => {
    expect(
      areFileStatsConsistent({ size: 3, mtimeMs: 1, ino: 10 }, { size: 3, mtimeMs: 1, ino: 10 }),
    ).toBe(true);
    expect(
      areFileStatsConsistent({ size: 3, mtimeMs: 1, ino: 10 }, { size: 4, mtimeMs: 1, ino: 10 }),
    ).toBe(false);
    expect(
      areFileStatsConsistent({ size: 3, mtimeMs: 1, ino: 10 }, { size: 3, mtimeMs: 2, ino: 10 }),
    ).toBe(false);
    expect(
      areFileStatsConsistent({ size: 3, mtimeMs: 1, ino: 10 }, { size: 3, mtimeMs: 1, ino: 11 }),
    ).toBe(false);
  });
});
// END_BLOCK_HOSTILITY_TESTS
