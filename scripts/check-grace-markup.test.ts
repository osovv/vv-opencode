// FILE: scripts/check-grace-markup.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify deterministic expected-file and semantic-block validation for repository-owned GRACE markup.
//   SCOPE: Valid fixtures, explicit exceptions, missing blocks, malformed hash prefixes, and LAST_CHANGE cardinality failures.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, scripts/check-grace-markup.ts]
//   LINKS: M-RELEASE-AUTOMATION, V-M-RELEASE-AUTOMATION
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   validGovernedFile - Build a minimal valid governed TypeScript fixture.
//   createFixtureRoot - Create the default src/scripts layout and explicit exception files.
//   writeGoverned - Write one governed fixture file with parent directories.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-GRACE-INTEGRITY-AND-COVERAGE-REMEDIATION - Added fixture coverage for missing, malformed, duplicated, and explicitly exempt markup.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { collectGraceMarkupIssues } from "./check-grace-markup.js";

function validGovernedFile(path: string): string {
  return [
    `// FILE: ${path}`,
    "// VERSION: 1.0.0",
    "// START_MODULE_CONTRACT",
    "//   PURPOSE: Test fixture.",
    "//   SCOPE: Test fixture.",
    "//   DEPENDS: [none]",
    "//   LINKS: [M-TEST]",
    "//   ROLE: TEST",
    "//   MAP_MODE: NONE",
    "// END_MODULE_CONTRACT",
    "//",
    "// START_MODULE_MAP",
    "// END_MODULE_MAP",
    "//",
    "// START_CHANGE_SUMMARY",
    "//   LAST_CHANGE: [TEST - Current fixture behavior.]",
    "// END_CHANGE_SUMMARY",
    "",
    "export {};",
    "",
  ].join("\n");
}

async function createFixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vvoc-grace-markup-"));
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "src", "plugins", "workflow"), { recursive: true });
  await writeFile(join(root, "src", "env.d.ts"), 'declare module "*.md?raw";\n', "utf8");
  await writeFile(
    join(root, "src", "plugins", "workflow", "system-instruction.md"),
    "<workflow_protocol>raw</workflow_protocol>\n",
    "utf8",
  );
  return root;
}

async function writeGoverned(root: string, path: string, content = validGovernedFile(path)) {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

describe("collectGraceMarkupIssues", () => {
  test("accepts valid governed files and explicit raw/declaration exceptions", async () => {
    const root = await createFixtureRoot();
    try {
      await writeGoverned(root, "src/example.ts");
      await writeGoverned(root, "scripts/example.ts");
      expect(collectGraceMarkupIssues(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports new TypeScript files without required module blocks", async () => {
    const root = await createFixtureRoot();
    try {
      await writeGoverned(root, "src/uncovered.ts", "export const uncovered = true;\n");
      const issues = collectGraceMarkupIssues(root);
      expect(issues.some((issue) => issue.code === "MISSING_FILE_HEADER")).toBe(true);
      expect(issues.filter((issue) => issue.code === "MISSING_MARKER")).toHaveLength(6);
      expect(issues.some((issue) => issue.code === "MISSING_LAST_CHANGE")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("detects embedded hashline prefixes around semantic anchors", async () => {
    const root = await createFixtureRoot();
    try {
      const path = "src/prefixed.ts";
      await writeGoverned(
        root,
        path,
        validGovernedFile(path).replace(
          "// START_MODULE_CONTRACT",
          "// HN#KY|// START_MODULE_CONTRACT",
        ),
      );
      const issues = collectGraceMarkupIssues(root);
      expect(issues.some((issue) => issue.code === "MALFORMED_HASH_PREFIX")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires exactly one LAST_CHANGE entry", async () => {
    const root = await createFixtureRoot();
    try {
      const duplicatePath = "src/duplicate.ts";
      await writeGoverned(
        root,
        duplicatePath,
        validGovernedFile(duplicatePath).replace(
          "// END_CHANGE_SUMMARY",
          "//   LAST_CHANGE: [TEST - Older fixture behavior.]\n// END_CHANGE_SUMMARY",
        ),
      );
      const missingPath = "scripts/missing.ts";
      await writeGoverned(
        root,
        missingPath,
        validGovernedFile(missingPath).replace(
          "//   LAST_CHANGE: [TEST - Current fixture behavior.]\n",
          "",
        ),
      );
      const issues = collectGraceMarkupIssues(root);
      expect(issues.some((issue) => issue.code === "DUPLICATE_LAST_CHANGE")).toBe(true);
      expect(issues.some((issue) => issue.code === "MISSING_LAST_CHANGE")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports a documented exception when it disappears", async () => {
    const root = await createFixtureRoot();
    try {
      await rm(join(root, "src", "env.d.ts"));
      expect(collectGraceMarkupIssues(root)).toContainEqual({
        path: "src/env.d.ts",
        code: "MISSING_EXPECTED_FILE",
        message: "documented GRACE markup exception does not exist",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
