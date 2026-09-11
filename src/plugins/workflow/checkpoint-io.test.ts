// FILE: src/plugins/workflow/checkpoint-io.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Deterministic tests for loading and validating approved delegated plan packages from disk.
//   SCOPE: Trusted-root containment, archive rejection, lifecycle status checks, linked-spec resolution, full lint gating, typed extraction, and content hashes over temporary fixtures.
//   DEPENDS: [bun:test, node:fs/promises, node:path, src/plugins/workflow/checkpoint-io.ts]
//   LINKS: [M-WORKFLOW-CHECKPOINTS, V-M-WORKFLOW-CHECKPOINTS]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SPEC_CONTENT - Complete valid approved spec fixture.
//   PLAN_CONTENT - Complete valid approved delegated plan fixture.
//   createdRoots - Tracks temporary roots for cleanup after each test.
//   makeRoot - Creates an isolated temporary root.
//   buildPackage - Writes a spec/plan fixture package into an isolated temporary root.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-DELEGATED-WORKFLOW-ASTRA-PRESETS - Initial loader coverage: containment, archive, lifecycle, lint, and extraction.]
// END_CHANGE_SUMMARY

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentSha256, loadApprovedDelegatedPlan } from "./checkpoint-io.js";

const createdRoots: string[] = [];

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `vvoc-cpio-${prefix}-`));
  createdRoots.push(root);
  return root;
}

afterEach(async () => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

const SPEC_CONTENT = `<spec>
  <status>approved</status>
  <goal>Store cached analytics rows.</goal>
  <architecture>In-process cache in front of analytics queries.</architecture>
  <tech_stack>TypeScript, Bun.</tech_stack>
  <components>
    <COMPONENT-CACHE-STORE>
      <name>Cache Store</name>
      <responsibility>Holds bounded query results.</responsibility>
      <depends_on>ANALYTICS-READER</depends_on>
    </COMPONENT-CACHE-STORE>
    <COMPONENT-ANALYTICS-READER>
      <name>Analytics Reader</name>
      <responsibility>Reads raw analytics rows.</responsibility>
      <depends_on></depends_on>
    </COMPONENT-ANALYTICS-READER>
  </components>
  <data_flow>Rows flow from reader into the store.</data_flow>
  <error_handling>Fail open with a warning.</error_handling>
  <testing>
    <strategy>Table-driven unit tests.</strategy>
    <coverage>Hit and eviction paths.</coverage>
  </testing>
  <non_goals>
    <non_goal>No persistence across restarts.</non_goal>
  </non_goals>
</spec>`;

const PLAN_CONTENT = `<plan>
  <spec>spec.xml</spec>
  <created>2026-09-11</created>
  <status>approved</status>
  <meta>
    <summary>Add the store with delegated execution.</summary>
    <waves>2</waves>
    <affected_modules>src/lib/cache-store.ts</affected_modules>
    <complexity>low</complexity>
  </meta>
  <architecture>
    <COMPONENT-CACHE-STORE>
      <name>Cache Store</name>
      <purpose>Bounded in-memory store.</purpose>
      <file>
        <path>src/lib/cache-store.ts</path>
        <role>implementation</role>
      </file>
      <contract>get, set, clear.</contract>
      <depends_on>ANALYTICS-READER</depends_on>
    </COMPONENT-CACHE-STORE>
  </architecture>
  <tasks>
    <WAVE-1>
      <goal>Store core.</goal>
      <TASK-T-001>
        <title>Cache Store</title>
        <file>src/lib/cache-store.ts</file>
        <status>pending</status>
        <description>Implement the store.</description>
        <depends_on></depends_on>
        <acceptance>
          <criterion>get returns undefined for missing keys</criterion>
        </acceptance>
        <verification>
          <command>bun test src/lib/cache-store.test.ts</command>
        </verification>
        <write_scope>
          <file>src/lib/cache-store.ts</file>
          <file>src/lib/cache-store.test.ts</file>
        </write_scope>
      </TASK-T-001>
    </WAVE-1>
    <WAVE-2>
      <goal>Reader wiring.</goal>
      <TASK-T-002>
        <title>Reader wiring</title>
        <file>src/lib/analytics.ts</file>
        <status>pending</status>
        <description>Wire the reader to the store.</description>
        <depends_on>
          <task_id>T-001</task_id>
        </depends_on>
        <acceptance>
          <criterion>Reader uses the store</criterion>
        </acceptance>
        <verification>
          <command>bun test src/lib/analytics.test.ts</command>
        </verification>
        <write_scope>
          <file>src/lib/analytics.ts</file>
        </write_scope>
      </TASK-T-002>
    </WAVE-2>
  </tasks>
  <execution>
    <mode>delegated</mode>
    <review_checkpoints>
      <CHECKPOINT-R-001>
        <kind>milestone</kind>
        <after_wave>WAVE-1</after_wave>
        <covers>
          <task_id>T-001</task_id>
        </covers>
        <scope>
          <file>src/lib/cache-store.ts</file>
          <file>src/lib/cache-store.test.ts</file>
        </scope>
        <reviewers>
          <reviewer>code</reviewer>
        </reviewers>
        <acceptance>
          <criterion>Store contract reviewed</criterion>
        </acceptance>
        <verification>
          <command>bun test src/lib/cache-store.test.ts</command>
        </verification>
      </CHECKPOINT-R-001>
      <CHECKPOINT-R-002>
        <kind>final</kind>
        <after_wave>WAVE-2</after_wave>
        <covers>
          <task_id>T-001</task_id>
          <task_id>T-002</task_id>
        </covers>
        <scope>
          <file>src/lib/cache-store.ts</file>
          <file>src/lib/cache-store.test.ts</file>
          <file>src/lib/analytics.ts</file>
        </scope>
        <reviewers>
          <reviewer>spec</reviewer>
          <reviewer>code</reviewer>
        </reviewers>
        <acceptance>
          <criterion>Complete result reviewed</criterion>
        </acceptance>
        <verification>
          <command>bun test</command>
        </verification>
      </CHECKPOINT-R-002>
    </review_checkpoints>
  </execution>
</plan>`;

async function buildPackage(
  root: string,
  overrides: {
    specContent?: string;
    planContent?: string;
    specStatus?: string;
    planStatus?: string;
  } = {},
): Promise<string> {
  const spec = (overrides.specContent ?? SPEC_CONTENT).replace(
    "<status>approved</status>",
    `<status>${overrides.specStatus ?? "approved"}</status>`,
  );
  const plan = (overrides.planContent ?? PLAN_CONTENT)
    .replace("<spec>spec.xml</spec>", "<spec>./spec.xml</spec>")
    .replace("<status>approved</status>", `<status>${overrides.planStatus ?? "approved"}</status>`);
  await mkdir(join(root, ".vvoc", "specs", "2026-09-11-cache"), { recursive: true });
  await writeFile(join(root, ".vvoc", "specs", "2026-09-11-cache", "spec.xml"), spec, "utf8");
  await writeFile(join(root, ".vvoc", "specs", "2026-09-11-cache", "plan.xml"), plan, "utf8");
  await mkdir(join(root, "src", "lib"), { recursive: true });
  await writeFile(
    join(root, "src", "lib", "cache-store.ts"),
    "export class CacheStore {}\n",
    "utf8",
  );
  await writeFile(join(root, "src", "lib", "cache-store.test.ts"), "test.todo();\n", "utf8");
  await writeFile(join(root, "src", "lib", "analytics.ts"), "export const wired = true;\n", "utf8");
  return join(root, ".vvoc", "specs", "2026-09-11-cache", "plan.xml");
}

// START_BLOCK_LOADER_TESTS
describe("loadApprovedDelegatedPlan", () => {
  test("loads an approved delegated package with hashes and typed obligations", async () => {
    const root = await makeRoot("ok");
    const planPath = await buildPackage(root);
    const result = await loadApprovedDelegatedPlan({ workspaceRoot: root, planPath });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.planPath).toBe(planPath);
    expect(result.plan.specPath).toBe(join(root, ".vvoc", "specs", "2026-09-11-cache", "spec.xml"));
    expect(result.plan.planSha256).toBe(
      contentSha256(PLAN_CONTENT.replace("<spec>spec.xml</spec>", "<spec>./spec.xml</spec>")),
    );
    expect(result.plan.definition.tasks).toHaveLength(2);
    expect(result.plan.definition.checkpoints).toHaveLength(2);
    expect(result.plan.definition.checkpoints[1].kind).toBe("final");
  });

  test("accepts a workspace-relative plan path", async () => {
    const root = await makeRoot("relative");
    await buildPackage(root);
    const result = await loadApprovedDelegatedPlan({
      workspaceRoot: root,
      planPath: ".vvoc/specs/2026-09-11-cache/plan.xml",
    });
    expect(result.ok).toBe(true);
  });

  test("rejects root mismatches, escapes, missing files, and archives", async () => {
    const root = await makeRoot("reject");
    const planPath = await buildPackage(root);

    const relativeRoot = await loadApprovedDelegatedPlan({
      workspaceRoot: "relative/root",
      planPath,
    });
    expect(relativeRoot.ok).toBe(false);
    if (relativeRoot.ok) return;
    expect(relativeRoot.code).toBe("ROOT_MISMATCH");

    const escape = await loadApprovedDelegatedPlan({
      workspaceRoot: join(root, "src"),
      planPath,
    });
    expect(escape.ok).toBe(false);
    if (escape.ok) return;
    expect(escape.code).toBe("PATH_ESCAPE");

    const missing = await loadApprovedDelegatedPlan({
      workspaceRoot: root,
      planPath: join(root, ".vvoc", "specs", "2026-09-11-cache", "missing.xml"),
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.code).toBe("PLAN_NOT_FOUND");

    const archiveDir = join(root, ".vvoc", "specs", "archive", "2026-09-11-cache");
    await mkdir(archiveDir, { recursive: true });
    const { copyFile } = await import("node:fs/promises");
    await copyFile(planPath, join(archiveDir, "plan.xml"));
    await copyFile(
      join(root, ".vvoc", "specs", "2026-09-11-cache", "spec.xml"),
      join(archiveDir, "spec.xml"),
    );
    const archived = await loadApprovedDelegatedPlan({
      workspaceRoot: root,
      planPath: join(archiveDir, "plan.xml"),
    });
    expect(archived.ok).toBe(false);
    if (archived.ok) return;
    expect(archived.code).toBe("ARCHIVED_PLAN");
  });

  test("rejects non-approved lifecycle statuses and non-delegated modes", async () => {
    const draftRoot = await makeRoot("draft");
    const draftPath = await buildPackage(draftRoot, { planStatus: "draft" });
    const draft = await loadApprovedDelegatedPlan({
      workspaceRoot: draftRoot,
      planPath: draftPath,
    });
    expect(draft.ok).toBe(false);
    if (draft.ok) return;
    expect(draft.code).toBe("STATUS_NOT_APPROVED");

    const specDraftRoot = await makeRoot("specdraft");
    const specDraftPath = await buildPackage(specDraftRoot, { specStatus: "draft" });
    const specDraft = await loadApprovedDelegatedPlan({
      workspaceRoot: specDraftRoot,
      planPath: specDraftPath,
    });
    expect(specDraft.ok).toBe(false);
    if (specDraft.ok) return;
    expect(specDraft.code).toBe("SPEC_NOT_APPROVED");

    const classicRoot = await makeRoot("classic");
    const classicPath = await buildPackage(classicRoot, {
      planContent: PLAN_CONTENT.replace(
        /  <execution>[\s\S]*<\/execution>\n/,
        "  <execution>\n    <mode>classic</mode>\n  </execution>\n",
      ),
    });
    const classic = await loadApprovedDelegatedPlan({
      workspaceRoot: classicRoot,
      planPath: classicPath,
    });
    expect(classic.ok).toBe(false);
    if (classic.ok) return;
    expect(classic.code).toBe("NOT_DELEGATED");
  });

  test("rejects spec escapes and lint failures through the shared engine", async () => {
    const escapeRoot = await makeRoot("specescape");
    const escapePath = await buildPackage(escapeRoot, {
      planContent: PLAN_CONTENT.replace(
        "<spec>spec.xml</spec>",
        "<spec>../../../etc/spec.xml</spec>",
      ),
    });
    const escape = await loadApprovedDelegatedPlan({
      workspaceRoot: escapeRoot,
      planPath: escapePath,
    });
    expect(escape.ok).toBe(false);
    if (escape.ok) return;
    expect(escape.code === "SPEC_PATH_ESCAPE" || escape.code === "SPEC_MISSING").toBe(true);

    const lintRoot = await makeRoot("lintfail");
    const lintPath = await buildPackage(lintRoot, {
      planContent: PLAN_CONTENT.replace(
        "<after_wave>WAVE-1</after_wave>",
        "<after_wave>WAVE-9</after_wave>",
      ),
    });
    const lint = await loadApprovedDelegatedPlan({ workspaceRoot: lintRoot, planPath: lintPath });
    expect(lint.ok).toBe(false);
    if (lint.ok) return;
    expect(lint.code === "LINT_FAILED" || lint.code === "NOT_DELEGATED").toBe(true);
  });
});
// END_BLOCK_LOADER_TESTS
