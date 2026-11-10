// FILE: src/plugins/hashline-edit/atomic-write.test.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify atomic UTF-8 publication safety for str_replace_editor: exact bytes, preserved mode and ownership, symlink preservation, read-only, special-mode and hardlink refusal, change detection, cancellation, exclusive create, and staging cleanup.
//   SCOPE: Real temporary files plus deterministic partial-write, corrupt-staging, ownership, cancellation, competing-write, and publication fault injection.
//   DEPENDS: [bun:test, node:fs, node:fs/promises, node:os, node:path, src/plugins/hashline-edit/atomic-write.ts]
//   LINKS: [M-PLUGIN-HASHLINE-EDIT, V-M-PLUGIN-HASHLINE-EDIT]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   directories - Temporary directories removed after every test.
//   withTempDir - Create an isolated temporary directory and remove it after the test body.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [Direct fix - Cover byte-exact staged publication, metadata preservation, cancellation before commit, competing writers, and cleanup after partial writes.]
// END_CHANGE_SUMMARY

import { afterEach, describe, expect, test } from "bun:test";
import {
  lstat,
  link,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createUtf8FileExclusively,
  nodeAtomicWriteIo,
  type AtomicWriteIo,
  writeUtf8FileAtomically,
} from "./atomic-write.js";

const directories: string[] = [];

async function withTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vvoc-atomic-write-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  while (directories.length > 0) {
    await rm(directories.pop()!, { recursive: true, force: true });
  }
});

describe("writeUtf8FileAtomically", () => {
  test("publishes exact bytes and preserves the ordinary file mode", async () => {
    const directory = await withTempDir();
    const filePath = join(directory, "sample.txt");
    const content = "\uFEFFone\r\ntwo\r\n\u{1F600}\n";
    await writeFile(filePath, "old\n", "utf8");
    await chmod(filePath, 0o640);
    const before = await stat(filePath);

    await writeUtf8FileAtomically(filePath, content, { expectedText: "old\n" });

    expect(Buffer.compare(await readFile(filePath), Buffer.from(content, "utf8"))).toBe(0);
    expect((await stat(filePath)).mode & 0o777).toBe(0o640);
    expect((await stat(filePath)).uid).toBe(before.uid);
    expect((await stat(filePath)).gid).toBe(before.gid);
    expect((await readdir(directory)).sort()).toEqual(["sample.txt"]);
  });

  test("preserves a symlink and replaces its target", async () => {
    const directory = await withTempDir();
    const target = join(directory, "target.txt");
    const alias = join(directory, "alias.txt");
    await writeFile(target, "alpha\n", "utf8");
    await symlink(target, alias);

    await writeUtf8FileAtomically(alias, "omega\n", { expectedText: "alpha\n" });

    expect((await lstat(alias)).isSymbolicLink()).toBe(true);
    expect(await readFile(alias, "utf8")).toBe("omega\n");
    expect(await readFile(target, "utf8")).toBe("omega\n");
  });

  test("refuses to atomically replace a file with multiple hard links", async () => {
    const directory = await withTempDir();
    const filePath = join(directory, "linked.txt");
    const second = join(directory, "second.txt");
    await writeFile(filePath, "alpha\n", "utf8");
    await link(filePath, second);

    await expect(writeUtf8FileAtomically(filePath, "omega\n")).rejects.toThrow(/hard links/);
    expect(await readFile(filePath, "utf8")).toBe("alpha\n");
    expect(await readFile(second, "utf8")).toBe("alpha\n");
    expect((await readdir(directory)).sort()).toEqual(["linked.txt", "second.txt"]);
  });

  test.each([0o1000, 0o2000, 0o4000])(
    "refuses special mode bits %o without modifying the file",
    async (special) => {
      const directory = await withTempDir();
      const filePath = join(directory, "special.txt");
      await writeFile(filePath, "alpha\n", "utf8");
      // Inject stat bits: Bun 1.3.8 chmod itself discards these flags, whereas
      // existing files and Node stat may carry them. No privileged fixture is needed.
      const io: AtomicWriteIo = {
        ...nodeAtomicWriteIo,
        async stat(path) {
          const info = await nodeAtomicWriteIo.stat(path);
          return { ...info, mode: info.mode | special };
        },
      };
      await expect(writeUtf8FileAtomically(filePath, "omega\n", { io })).rejects.toThrow(
        /setuid, setgid, or sticky/,
      );
      expect(await readFile(filePath, "utf8")).toBe("alpha\n");
      expect(await readdir(directory)).toEqual(["special.txt"]);
    },
  );

  test("refuses a read-only target instead of bypassing mode with rename", async () => {
    if (process.getuid?.() === 0) {
      return;
    }
    const directory = await withTempDir();
    const filePath = join(directory, "readonly.txt");
    await writeFile(filePath, "alpha\n", "utf8");
    await chmod(filePath, 0o444);
    try {
      await expect(writeUtf8FileAtomically(filePath, "omega\n")).rejects.toThrow(/not writable/);
      expect(await readFile(filePath, "utf8")).toBe("alpha\n");
      expect((await readdir(directory)).sort()).toEqual(["readonly.txt"]);
    } finally {
      await chmod(filePath, 0o644);
    }
  });

  test("fails closed when the target changed since the editor read it", async () => {
    const directory = await withTempDir();
    const filePath = join(directory, "changed.txt");
    await writeFile(filePath, "alpha\n", "utf8");

    await expect(
      writeUtf8FileAtomically(filePath, "omega\n", { expectedText: "other\n" }),
    ).rejects.toThrow(/changed after it was read/);
    expect(await readFile(filePath, "utf8")).toBe("alpha\n");
  });

  test("cleans the staging file when publication fails", async () => {
    const directory = await withTempDir();
    const filePath = join(directory, "sample.txt");
    await writeFile(filePath, "alpha\n", "utf8");
    const failingIo: AtomicWriteIo = {
      ...nodeAtomicWriteIo,
      async rename() {
        throw new Error("injected rename failure");
      },
    };

    await expect(writeUtf8FileAtomically(filePath, "omega\n", { io: failingIo })).rejects.toThrow(
      "injected rename failure",
    );
    expect(await readFile(filePath, "utf8")).toBe("alpha\n");
    expect((await readdir(directory)).sort()).toEqual(["sample.txt"]);
  });

  test("cleans a partially written staging file without touching the destination", async () => {
    const directory = await withTempDir();
    const filePath = join(directory, "sample.txt");
    await writeFile(filePath, "alpha\n", "utf8");
    const failingIo: AtomicWriteIo = {
      ...nodeAtomicWriteIo,
      async writeFile(path, data, options) {
        await nodeAtomicWriteIo.writeFile(path, data.subarray(0, 2), options);
        throw Object.assign(new Error("injected partial write"), { code: "ENOSPC" });
      },
    };

    await expect(writeUtf8FileAtomically(filePath, "omega\n", { io: failingIo })).rejects.toThrow(
      "injected partial write",
    );
    expect(await readFile(filePath, "utf8")).toBe("alpha\n");
    expect(await readdir(directory)).toEqual(["sample.txt"]);
  });

  test("refuses corrupted staged bytes before publication", async () => {
    const directory = await withTempDir();
    const filePath = join(directory, "sample.txt");
    await writeFile(filePath, "alpha\n", "utf8");
    const corruptingIo: AtomicWriteIo = {
      ...nodeAtomicWriteIo,
      async writeFile(path, data, options) {
        await nodeAtomicWriteIo.writeFile(path, Buffer.concat([data, Buffer.from([0])]), options);
      },
    };

    await expect(
      writeUtf8FileAtomically(filePath, "omega\n", { io: corruptingIo }),
    ).rejects.toThrow(/did not verify/);
    expect(await readFile(filePath, "utf8")).toBe("alpha\n");
    expect(await readdir(directory)).toEqual(["sample.txt"]);
  });

  test("rechecks cancellation after staging and before publication", async () => {
    const directory = await withTempDir();
    const filePath = join(directory, "sample.txt");
    await writeFile(filePath, "alpha\n", "utf8");
    const controller = new AbortController();
    const cancellingIo: AtomicWriteIo = {
      ...nodeAtomicWriteIo,
      async writeFile(path, data, options) {
        await nodeAtomicWriteIo.writeFile(path, data, options);
        controller.abort();
      },
    };

    await expect(
      writeUtf8FileAtomically(filePath, "omega\n", {
        io: cancellingIo,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(await readFile(filePath, "utf8")).toBe("alpha\n");
    expect(await readdir(directory)).toEqual(["sample.txt"]);
  });

  test("detects an external update made while staging", async () => {
    const directory = await withTempDir();
    const filePath = join(directory, "sample.txt");
    await writeFile(filePath, "alpha\n", "utf8");
    const competingIo: AtomicWriteIo = {
      ...nodeAtomicWriteIo,
      async writeFile(path, data, options) {
        await nodeAtomicWriteIo.writeFile(path, data, options);
        await writeFile(filePath, "competitor\n", "utf8");
      },
    };

    await expect(
      writeUtf8FileAtomically(filePath, "omega\n", {
        io: competingIo,
        expectedText: "alpha\n",
      }),
    ).rejects.toThrow(/changed after it was read/);
    expect(await readFile(filePath, "utf8")).toBe("competitor\n");
    expect(await readdir(directory)).toEqual(["sample.txt"]);
  });

  test("fails closed if staging cannot preserve the destination ownership", async () => {
    const directory = await withTempDir();
    const filePath = join(directory, "sample.txt");
    await writeFile(filePath, "alpha\n", "utf8");
    const owner = await stat(filePath);
    let attempted = false;
    const failingIo: AtomicWriteIo = {
      ...nodeAtomicWriteIo,
      async stat(path) {
        return { ...(await nodeAtomicWriteIo.stat(path)), uid: owner.uid + 1, gid: owner.gid + 1 };
      },
      async chown(_path, uid, gid) {
        attempted = true;
        expect(uid).toBe(owner.uid + 1);
        expect(gid).toBe(owner.gid + 1);
        throw new Error("injected ownership refusal");
      },
    };

    await expect(
      writeUtf8FileAtomically(filePath, "omega\n", { io: failingIo }),
    ).rejects.toMatchObject({
      code: "EOWNERSHIP",
      message: expect.stringContaining("cannot preserve POSIX ownership"),
      cause: expect.objectContaining({ message: "injected ownership refusal" }),
    });
    expect(attempted).toBe(true);
    expect(await readFile(filePath, "utf8")).toBe("alpha\n");
    expect(await readdir(directory)).toEqual(["sample.txt"]);
  });
});

describe("createUtf8FileExclusively", () => {
  test("cancellation during staging does not publish a new file", async () => {
    const directory = await withTempDir();
    const filePath = join(directory, "created.txt");
    const controller = new AbortController();
    const cancellingIo: AtomicWriteIo = {
      ...nodeAtomicWriteIo,
      async writeFile(path, data, options) {
        await nodeAtomicWriteIo.writeFile(path, data, options);
        controller.abort();
      },
    };

    await expect(
      createUtf8FileExclusively(filePath, "ours\n", {
        io: cancellingIo,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(await readdir(directory)).toEqual([]);
  });

  test("preserves a competing creator that wins during staging", async () => {
    const directory = await withTempDir();
    const filePath = join(directory, "created.txt");
    const competingIo: AtomicWriteIo = {
      ...nodeAtomicWriteIo,
      async link(from, to) {
        await writeFile(to, "competitor\n", { flag: "wx" });
        await nodeAtomicWriteIo.link(from, to);
      },
    };

    expect(await createUtf8FileExclusively(filePath, "ours\n", { io: competingIo })).toBe(false);
    expect(await readFile(filePath, "utf8")).toBe("competitor\n");
    expect(await readdir(directory)).toEqual(["created.txt"]);
  });

  test("creates once and refuses an existing or racing creator without overwriting", async () => {
    const directory = await withTempDir();
    const filePath = join(directory, "created.txt");

    expect(await createUtf8FileExclusively(filePath, "first\n")).toBe(true);
    expect(await createUtf8FileExclusively(filePath, "second\n")).toBe(false);
    expect(await readFile(filePath, "utf8")).toBe("first\n");
    expect((await readdir(directory)).sort()).toEqual(["created.txt"]);
  });

  test("does not replace an existing symlink", async () => {
    const directory = await withTempDir();
    const target = join(directory, "target.txt");
    const alias = join(directory, "alias.txt");
    await writeFile(target, "alpha\n", "utf8");
    await symlink(target, alias);

    expect(await createUtf8FileExclusively(alias, "omega\n")).toBe(false);
    expect((await lstat(alias)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe("alpha\n");
  });
});
