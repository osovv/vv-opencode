// FILE: src/commands/lint.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Deterministic tests for the vvoc lint command: exit codes, flags, per-class error reporting, archive handling, and clean runs over the shipped templates.
//   SCOPE: Temp-package fixtures driven through runLint, computeLintExitCode, renderLintReport, and collectLintTargets.
//   DEPENDS: [src/commands/lint.ts]
//   LINKS: [M-CLI-COMMANDS, V-M-CLI-COMMANDS]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   VALID_SPEC - Complete valid approved spec fixture.
//   VALID_PLAN - Complete valid approved plan fixture.
//   makeSpecsTree - Creates a temp specs tree with valid, broken, and archived packages.
//   optionsFor - Builds LintCommandOptions with no-cache defaults.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-SPEC-IDENTITY-LINT - Initial target resolution, exit-code, flag, archive, and template tests.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectLintTargets,
  computeLintExitCode,
  renderLintReport,
  runLint,
  type LintCommandOptions,
} from "./lint.js";

const VALID_SPEC = `<spec>
  <status>approved</status>
  <goal>Store cached analytics rows.</goal>
  <architecture>In-process cache.</architecture>
  <tech_stack>TypeScript.</tech_stack>
  <components>
    <COMPONENT-CACHE-STORE>
      <name>Cache Store</name>
      <responsibility>Holds results.</responsibility>
      <depends_on></depends_on>
    </COMPONENT-CACHE-STORE>
  </components>
  <data_flow>Rows flow in.</data_flow>
  <error_handling>Fail open.</error_handling>
  <testing><strategy>Unit tests.</strategy><coverage>Paths.</coverage></testing>
  <non_goals><non_goal>No persistence.</non_goal></non_goals>
</spec>`;

const VALID_PLAN = `<plan>
  <spec>spec.xml</spec>
  <created>2026-08-29</created>
  <status>approved</status>
  <meta><summary>Add cache.</summary><waves>1</waves><affected_modules>src/lib/c.ts</affected_modules><complexity>low</complexity></meta>
  <architecture>
    <COMPONENT-CACHE-STORE>
      <name>Cache Store</name>
      <purpose>Store.</purpose>
      <file><path>src/lib/c.ts</path><role>implementation</role></file>
      <contract>get/set.</contract>
      <depends_on></depends_on>
    </COMPONENT-CACHE-STORE>
  </architecture>
  <tasks>
    <WAVE-1>
      <goal>Core.</goal>
      <TASK-T-001>
        <title>Store</title>
        <file>src/lib/c.ts</file>
        <status>pending</status>
        <description>Implement.</description>
        <depends_on></depends_on>
        <snippet><![CDATA[class C {}]]></snippet>
        <acceptance><criterion>works</criterion></acceptance>
        <verification><command>bun test c</command></verification>
      </TASK-T-001>
    </WAVE-1>
  </tasks>
</plan>`;

async function makeSpecsTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vvoc-lint-cmd-"));
  const good = join(root, "specs", "2026-08-29-cache");
  const bad = join(root, "specs", "2026-08-29-broken");
  const archived = join(root, "specs", "archive", "2026-08-01-old-1");
  await mkdir(good, { recursive: true });
  await mkdir(bad, { recursive: true });
  await mkdir(archived, { recursive: true });
  await writeFile(join(good, "spec.xml"), VALID_SPEC, "utf8");
  await writeFile(join(good, "plan.xml"), VALID_PLAN, "utf8");
  await writeFile(
    join(bad, "spec.xml"),
    `<spec><status>approved</status><goal>g</goal><components><component><name>x</name></component></components></spec>`,
    "utf8",
  );
  await writeFile(join(archived, "spec.xml"), "<spec><status>applied</status></spec>", "utf8");
  return root;
}

function optionsFor(
  target: string,
  overrides: Partial<LintCommandOptions> = {},
): LintCommandOptions {
  return { target, includeArchive: false, strict: false, noCache: true, ...overrides };
}

describe("collectLintTargets", () => {
  test("groups a specs tree by package and skips archive by default", async () => {
    const root = await makeSpecsTree();
    try {
      const { groups, skippedArchived } = await collectLintTargets(join(root, "specs"), false);
      expect(groups.length).toBe(2);
      expect(skippedArchived).toBe(1);
      const withArchive = await collectLintTargets(join(root, "specs"), true);
      expect(withArchive.skippedArchived).toBe(0);
      expect(withArchive.groups.length).toBe(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a plan file target pulls in its sibling spec", async () => {
    const root = await makeSpecsTree();
    try {
      const { groups } = await collectLintTargets(
        join(root, "specs", "2026-08-29-cache", "plan.xml"),
        false,
      );
      expect(groups.length).toBe(1);
      expect(groups[0]!.files.length).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects non-artifact and missing targets", async () => {
    await expect(collectLintTargets("/nonexistent/path", false)).rejects.toThrow("not found");
    const root = await makeSpecsTree();
    try {
      const notes = join(root, "specs", "2026-08-29-cache", "notes.txt");
      await writeFile(notes, "not an artifact", "utf8");
      await expect(collectLintTargets(notes, false)).rejects.toThrow("not a spec-package artifact");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("runLint and exit codes", () => {
  test("a valid package exits zero with per-artifact OK lines", async () => {
    const root = await makeSpecsTree();
    const cacheRoot = join(root, "cache");
    try {
      const result = await runLint(optionsFor(join(root, "specs", "2026-08-29-cache")), cacheRoot);
      expect(computeLintExitCode(result, false)).toBe(0);
      const report = renderLintReport(result, false);
      expect(report).toContain("spec.xml: OK");
      expect(report).toContain("plan.xml: OK");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a broken package exits one with the specific rule and line", async () => {
    const root = await makeSpecsTree();
    const cacheRoot = join(root, "cache");
    try {
      const result = await runLint(optionsFor(join(root, "specs", "2026-08-29-broken")), cacheRoot);
      expect(computeLintExitCode(result, false)).toBe(1);
      const report = renderLintReport(result, false);
      expect(report).toContain("identity.pattern");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("tree runs skip archive with a visible count and --archive includes it", async () => {
    const root = await makeSpecsTree();
    const cacheRoot = join(root, "cache");
    try {
      const skip = await runLint(optionsFor(join(root, "specs")), cacheRoot);
      expect(skip.skippedArchived).toBe(1);
      expect(renderLintReport(skip, false)).toContain("Skipped 1 archived artifact(s)");

      const include = await runLint(
        optionsFor(join(root, "specs"), { includeArchive: true }),
        join(root, "cache2"),
      );
      expect(include.skippedArchived).toBe(0);
      expect(computeLintExitCode(include, false)).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("strict escalates warnings to exit failure", async () => {
    const root = await makeSpecsTree();
    const warnOnly = join(root, "specs", "2026-08-29-warnonly");
    await mkdir(warnOnly, { recursive: true });
    // A draft plan without its spec in the run yields exactly one warning.
    await writeFile(
      join(warnOnly, "plan.xml"),
      VALID_PLAN.replace("<spec>spec.xml</spec>", "<spec>spec.xml</spec>"),
      "utf8",
    );
    try {
      const warnRun = await runLint(
        optionsFor(join(warnOnly, "plan.xml"), { strict: true }),
        join(root, "cache3"),
      );
      expect(computeLintExitCode(warnRun, false)).toBe(0);
      expect(computeLintExitCode(warnRun, true)).toBe(1);
      expect(renderLintReport(warnRun, true)).toContain("crossfile.spec_missing");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("cache hits are reported on a second unchanged run", async () => {
    const root = await makeSpecsTree();
    const cacheRoot = join(root, "cache");
    try {
      const first = await runLint(
        {
          target: join(root, "specs", "2026-08-29-cache"),
          includeArchive: false,
          strict: false,
          noCache: false,
        },
        cacheRoot,
      );
      expect(first.packages[0]!.artifacts.every((a) => !a.cached)).toBe(true);
      const second = await runLint(
        {
          target: join(root, "specs", "2026-08-29-cache"),
          includeArchive: false,
          strict: false,
          noCache: false,
        },
        cacheRoot,
      );
      expect(second.packages[0]!.artifacts.every((a) => a.cached)).toBe(true);
      expect(computeLintExitCode(second, false)).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("editing the spec invalidates the cached plan verdict", async () => {
    const root = await makeSpecsTree();
    const cacheRoot = join(root, "cache");
    const pkg = join(root, "specs", "2026-08-29-cache");
    try {
      const opts = { target: pkg, includeArchive: false, strict: false, noCache: false };
      await runLint(opts, cacheRoot);
      await writeFile(
        join(pkg, "spec.xml"),
        VALID_SPEC.replace("Store cached analytics rows.", "Store rows differently."),
        "utf8",
      );
      const after = await runLint(opts, cacheRoot);
      expect(after.packages[0]!.artifacts.every((a) => !a.cached)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("shipped reference templates lint clean through the command", () => {
  test("the three template skeletons report OK via a package run", async () => {
    const root = await mkdtemp(join(tmpdir(), "vvoc-lint-tpl-"));
    const pkg = join(root, "2026-08-29-format-ref");
    await mkdir(pkg, { recursive: true });
    const templates = join(import.meta.dir, "../../templates/skills");
    const { copyFile } = await import("node:fs/promises");
    await copyFile(join(templates, "vv-spec/references/spec-template.xml"), join(pkg, "spec.xml"));
    await copyFile(join(templates, "vv-plan/references/plan-template.xml"), join(pkg, "plan.xml"));
    await copyFile(
      join(templates, "vv-spec/references/design-context-template.xml"),
      join(pkg, "design-context.xml"),
    );
    try {
      const result = await runLint(optionsFor(pkg), join(root, "cache"));
      expect(computeLintExitCode(result, false)).toBe(0);
      const report = renderLintReport(result, false);
      expect(report).toContain("spec.xml: OK");
      expect(report).toContain("plan.xml");
      expect(report).toContain("design-context.xml: OK");
      expect(await readFile(join(pkg, "spec.xml"), "utf8")).toContain("COMPONENT-EXAMPLE");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
