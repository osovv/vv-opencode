// FILE: src/plugins/tool-history-compaction.saved-output.test.ts
// VERSION: 0.2.0
// START_MODULE_CONTRACT
//   PURPOSE: Test the disk-backed recovery of pruned tool outputs: deterministic path derivation, write-once idempotence, content fidelity, and failure fallback.
//   SCOPE: savedOutputDir, savedOutputPath, savePrunedOutputOnce over a temp data home.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, src/plugins/tool-history-compaction/saved-output.ts]
//   LINKS: [V-M-PLUGIN-TOOL-HISTORY-COMPACTION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   makeTempHome - Module-local temp XDG data home fixture/helper.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.2.0 - Initial saved-output recovery tests.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  savedOutputDir,
  savedOutputPath,
  savePrunedOutputOnce,
} from "./tool-history-compaction/saved-output.js";

const makeTempHome = async (): Promise<string> => mkdtemp(join(tmpdir(), "vvoc-tool-output-"));

describe("savedOutputPath", () => {
  test("derives a deterministic path per callID under the data home", () => {
    const home = "/tmp/vvoc-home";
    expect(savedOutputPath("call-42", home)).toBe(join(savedOutputDir(home), "tool-call-42.txt"));
  });

  test("sanitizes unsafe callID characters", () => {
    const home = "/tmp/vvoc-home";
    expect(savedOutputPath("call/../evil", home)).toBe(
      join(savedOutputDir(home), "tool-call____evil.txt"),
    );
  });

  test("falls back to unknown when callID sanitizes to empty", () => {
    const home = "/tmp/vvoc-home";
    expect(savedOutputPath("///", home)).toBe(join(savedOutputDir(home), "tool-unknown.txt"));
  });
});

describe("savePrunedOutputOnce", () => {
  test("writes the full output once and returns its path", async () => {
    const home = await makeTempHome();
    try {
      const full = "a".repeat(5000);
      const path = savePrunedOutputOnce(full, "call-write-1", home);
      expect(path).toBe(savedOutputPath("call-write-1", home));
      expect(await readFile(path!, "utf8")).toBe(full);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("does not overwrite an existing file (write-once idempotence)", async () => {
    const home = await makeTempHome();
    try {
      const first = savePrunedOutputOnce("first-content", "call-write-2", home);
      const second = savePrunedOutputOnce("second-content", "call-write-2", home);
      expect(second).toBe(first);
      expect(await readFile(first!, "utf8")).toBe("first-content");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("returns undefined for empty output or empty callID", async () => {
    const home = await makeTempHome();
    try {
      expect(savePrunedOutputOnce("", "call-empty", home)).toBeUndefined();
      expect(savePrunedOutputOnce("content", "", home)).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
