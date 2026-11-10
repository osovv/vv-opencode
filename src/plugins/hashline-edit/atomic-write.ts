// FILE: src/plugins/hashline-edit/atomic-write.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Publish str_replace_editor UTF-8 writes through a unique staging file in the target directory instead of truncating and rewriting the destination in place.
//   SCOPE: Symlink-resolving atomic replacement with ordinary mode and POSIX ownership preservation, read-only, special-mode and multi-hardlink refusal, actionable ownership errors, pre-publication change and cancellation checks, byte-verified staged payloads, exclusive create publication, and cleanup after partial staging failures. No cross-process compare-and-swap or crash-durability guarantee.
//   DEPENDS: [node:crypto, node:fs, node:fs/promises, node:path, src/plugins/hashline-edit/target-lock.ts]
//   LINKS: [M-PLUGIN-HASHLINE-EDIT, V-M-PLUGIN-HASHLINE-EDIT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   AtomicWriteIo - Injectable filesystem operations used by the staging publisher.
//   AtomicWriteStat - Minimal target metadata required for safe publication.
//   nodeAtomicWriteIo - Default node:fs/promises-backed operation set; tests may wrap it for fault injection.
//   writeUtf8FileAtomically - Replace an existing file through a verified staging file and atomic rename.
//   createUtf8FileExclusively - Create a new file through a verified staging file without overwriting a racing creator.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [Direct fix - Publish byte-verified UTF-8 atomically with metadata preservation, pre-commit cancellation and change checks, partial-write cleanup, and exclusive create.]
// END_CHANGE_SUMMARY

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  chown,
  link,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { throwIfAborted } from "./target-lock.js";

// START_BLOCK_TYPES
export interface AtomicWriteStat {
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
}

/** Injectable filesystem surface; production uses the node:fs/promises-backed default. */
export interface AtomicWriteIo {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<AtomicWriteStat>;
  access(path: string, mode: number): Promise<void>;
  readFile(path: string): Promise<Buffer>;
  writeFile(
    path: string,
    data: Uint8Array,
    options: { flag: "wx"; mode: number; signal?: AbortSignal },
  ): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  chown(path: string, uid: number, gid: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  link(existingPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
}
// END_BLOCK_TYPES

// START_BLOCK_DEFAULT_IO
export const nodeAtomicWriteIo: AtomicWriteIo = {
  realpath: (path) => realpath(path),
  async stat(path) {
    const info = await stat(path);
    return { mode: info.mode, nlink: info.nlink, uid: info.uid, gid: info.gid };
  },
  access: (path, mode) => access(path, mode),
  readFile: (path) => readFile(path),
  async writeFile(path, data, options) {
    await writeFile(path, data, options);
  },
  chmod: (path, mode) => chmod(path, mode),
  async chown(path, uid, gid) {
    // Windows has no POSIX uid/gid; native ACL preservation is not implemented here.
    if (process.platform !== "win32") await chown(path, uid, gid);
  },
  rename: (from, to) => rename(from, to),
  link: (existingPath, newPath) => link(existingPath, newPath),
  unlink: (path) => unlink(path),
};
// END_BLOCK_DEFAULT_IO

// START_BLOCK_HELPERS
function ioFailure(message: string, code: string, cause?: unknown): NodeJS.ErrnoException {
  const error = new Error(message, { cause }) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code
  );
}

async function removeQuietly(io: AtomicWriteIo, path: string): Promise<void> {
  try {
    await io.unlink(path);
  } catch {
    // The staging file may already be published or never created.
  }
}

function stagingPath(target: string): string {
  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
  return join(dirname(target), `.${basename(target)}.vvoc-${suffix}.tmp`);
}

/**
 * Write the exact UTF-8 bytes to a unique staging file and read them back
 * before publication. The caller owns cleanup of the returned path.
 */
async function stageVerifiedBytes(
  io: AtomicWriteIo,
  target: string,
  bytes: Uint8Array,
  createMode: number,
  chmodTo?: number,
  owner?: { uid: number; gid: number },
  signal?: AbortSignal,
): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    throwIfAborted(signal);
    const temp = stagingPath(target);
    try {
      await io.writeFile(temp, bytes, { flag: "wx", mode: createMode, signal });
    } catch (error) {
      if (isErrno(error, "EEXIST")) continue;
      await removeQuietly(io, temp);
      throw error;
    }
    try {
      throwIfAborted(signal);
      if (owner !== undefined) {
        try {
          await io.chown(temp, owner.uid, owner.gid);
        } catch (error) {
          throw ioFailure(
            `Refusing to atomically replace ${target}: cannot preserve POSIX ownership (uid ${owner.uid}, gid ${owner.gid}). The original file is unchanged.`,
            "EOWNERSHIP",
            error,
          );
        }
      }
      if (chmodTo !== undefined) {
        await io.chmod(temp, chmodTo);
      }
      const staged = await io.readFile(temp);
      if (Buffer.compare(staged, bytes) !== 0) {
        throw ioFailure(
          `Refusing to publish ${target}: the staged UTF-8 bytes did not verify.`,
          "EIO",
        );
      }
      return temp;
    } catch (error) {
      await removeQuietly(io, temp);
      throw error;
    }
  }
  throw ioFailure(`Could not allocate a unique staging file for ${target}.`, "EEXIST");
}

async function resolveParentRealpath(io: AtomicWriteIo, path: string): Promise<string> {
  const parent = dirname(path);
  try {
    return await io.realpath(parent);
  } catch {
    return parent;
  }
}
// END_BLOCK_HELPERS

// START_BLOCK_PUBLICATION
/**
 * Replace `path` through a verified staging file. The canonical target (after
 * resolving symlinks) is replaced so a symlink itself is never turned into a
 * regular file. Ordinary modes and POSIX ownership are preserved; read-only targets and targets
 * with special mode bits or multiple hard links are refused rather than silently
 * changing their semantics or restoring privilege bits cleared by an in-place write.
 *
 * `expectedText` is the content the editor read for this command. Checking it
 * immediately before publication detects an external change cheaply; it is not
 * a universal compare-and-swap against other processes.
 */
export async function writeUtf8FileAtomically(
  path: string,
  content: string,
  options: { expectedText?: string; signal?: AbortSignal; io?: AtomicWriteIo } = {},
): Promise<void> {
  throwIfAborted(options.signal);
  const io = options.io ?? nodeAtomicWriteIo;
  const bytes = Buffer.from(content, "utf8");
  const target = await io.realpath(path);
  const info = await io.stat(target);

  if ((info.mode & 0o222) === 0) {
    throw ioFailure(`Refusing to write ${path}: the file is not writable.`, "EACCES");
  }
  await io.access(target, constants.W_OK);

  if ((info.mode & 0o7000) !== 0) {
    throw ioFailure(
      `Refusing to atomically replace ${path}: setuid, setgid, or sticky mode bits require an ownership-preserving in-place editor.`,
      "ESPECIALMODE",
    );
  }

  if (info.nlink > 1) {
    throw ioFailure(
      `Refusing to atomically replace ${path}: the file has ${info.nlink} hard links.`,
      "EHARDLINK",
    );
  }

  const mode = info.mode & 0o777;
  const temp = await stageVerifiedBytes(io, target, bytes, 0o600, mode, info, options.signal);
  try {
    if (options.expectedText !== undefined) {
      const current = await io.readFile(target);
      if (!current.equals(Buffer.from(options.expectedText, "utf8"))) {
        throw ioFailure(
          `Refusing to edit ${path}: the file changed after it was read. Run view again before editing.`,
          "ECONCURRENT",
        );
      }
    }
    throwIfAborted(options.signal);
    await io.rename(temp, target);
  } catch (error) {
    await removeQuietly(io, temp);
    throw error;
  }
}

/**
 * Create `path` through a verified staging file and publish with a no-replace
 * hard link. Returns false when any creator (including a racing one) already
 * owns the directory entry, without overwriting it.
 */
export async function createUtf8FileExclusively(
  path: string,
  content: string,
  options: { signal?: AbortSignal; io?: AtomicWriteIo } = {},
): Promise<boolean> {
  throwIfAborted(options.signal);
  const io = options.io ?? nodeAtomicWriteIo;
  const bytes = Buffer.from(content, "utf8");
  const target = join(await resolveParentRealpath(io, path), basename(path));
  const temp = await stageVerifiedBytes(
    io,
    target,
    bytes,
    0o666,
    undefined,
    undefined,
    options.signal,
  );
  try {
    throwIfAborted(options.signal);
    await io.link(temp, target);
    return true;
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      return false;
    }
    throw error;
  } finally {
    await removeQuietly(io, temp);
  }
}
// END_BLOCK_PUBLICATION
