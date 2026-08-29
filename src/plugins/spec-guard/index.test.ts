// FILE: src/plugins/spec-guard/index.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Hook-level deterministic tests for the spec-guard plugin: read annotation, archive silence, warn append, enforce failure on ERROR, and never blocking warning-only or clean writes.
//   SCOPE: Drive tool.execute.before/after with fabricated inputs and outputs through createSpecGuardPlugin with injected mode, cache, file reader, and log.
//   DEPENDS: [src/plugins/spec-guard/index.ts, src/lib/spec-lint-cache.ts]
//   LINKS: [M-PLUGIN-SPEC-GUARD, V-M-PLUGIN-SPEC-GUARD]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   VALID_SPEC - Minimal valid spec fixture.
//   BROKEN_SPEC - Spec fixture with an attribute violation.
//   Hooks - Plugin hook map type for direct hook invocation.
//   makePlugin - Builds plugin hooks with injected mode, files, cache, and log.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-SPEC-IDENTITY-LINT - Initial hook-level read/write annotation and enforcement tests.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SPEC_GUARD_VERDICT_TAG,
  createSpecGuardPlugin,
  isSpecGuardTargetPath,
  specGuardPathFromArgs,
  type SpecGuardMode,
} from "./index.js";
import { createSpecLintCache } from "../../lib/spec-lint-cache.js";

const VALID_SPEC = `<spec><status>draft</status><goal>g</goal><components><COMPONENT-A><name>A</name><responsibility>r</responsibility></COMPONENT-A></components></spec>`;
const BROKEN_SPEC = `<spec><goal status="oops">g</goal></spec>`;

type Hooks = NonNullable<Awaited<ReturnType<ReturnType<typeof createSpecGuardPlugin>>>>;

async function makePlugin(
  mode: SpecGuardMode,
  files: Record<string, string>,
): Promise<{ hooks: Hooks; logs: string[] }> {
  const logs: string[] = [];
  const cache = await createSpecLintCache({
    cacheRoot: join(await mkdtemp(join(tmpdir(), "spec-guard-")), "lint"),
  });
  const plugin = createSpecGuardPlugin({
    mode: () => mode,
    cache,
    readFile: async (path) => files[path],
    log: async (_level, message) => {
      logs.push(message);
    },
  });
  const hooks = (await plugin(
    {} as Parameters<ReturnType<typeof createSpecGuardPlugin>>[0],
  )) as Hooks;
  return { hooks, logs };
}

describe("path gating", () => {
  test("active spec-package artifacts are targets; archived and foreign paths are not", () => {
    expect(isSpecGuardTargetPath(".vvoc/specs/2026-08-29-cache/spec.xml")).toBe(true);
    expect(isSpecGuardTargetPath("proj/.vvoc/specs/2026-08-29-cache/plan.xml")).toBe(true);
    expect(isSpecGuardTargetPath(".vvoc/specs/2026-08-29-cache/design-context.xml")).toBe(true);
    expect(isSpecGuardTargetPath(".vvoc/specs/archive/2026-08-29-cache-1/spec.xml")).toBe(false);
    expect(isSpecGuardTargetPath("src/lib/spec-lint.ts")).toBe(false);
    expect(isSpecGuardTargetPath(".vvoc/specs/2026-08-29-cache/notes.txt")).toBe(false);
  });

  test("tool args path extraction covers known spellings", () => {
    expect(specGuardPathFromArgs({ filePath: "a.xml" })).toBe("a.xml");
    expect(specGuardPathFromArgs({ file_path: "a.xml" })).toBe("a.xml");
    expect(specGuardPathFromArgs({ path: "a.xml" })).toBe("a.xml");
    expect(specGuardPathFromArgs({})).toBeUndefined();
    expect(specGuardPathFromArgs(undefined)).toBeUndefined();
  });
});

describe("read annotation", () => {
  test("appends the lint verdict to reads of active artifacts in warn mode", async () => {
    const file = ".vvoc/specs/2026-08-29-cache/spec.xml";
    const { hooks } = await makePlugin("warn", { [file]: VALID_SPEC });
    const output = { title: "read", output: VALID_SPEC, metadata: {} };
    await hooks["tool.execute.after"]!(
      { tool: "read", sessionID: "s", callID: "c", args: { filePath: file } },
      output,
    );
    expect(output.output).toContain(SPEC_GUARD_VERDICT_TAG);
    expect(output.output).toContain("spec OK");
  });

  test("appends nothing for archived files or foreign paths", async () => {
    const { hooks } = await makePlugin("warn", {
      ".vvoc/specs/archive/2026-08-29-cache-1/spec.xml": VALID_SPEC,
    });
    const output = { title: "read", output: VALID_SPEC, metadata: {} };
    await hooks["tool.execute.after"]!(
      {
        tool: "read",
        sessionID: "s",
        callID: "c",
        args: { filePath: ".vvoc/specs/archive/2026-08-29-cache-1/spec.xml" },
      },
      output,
    );
    expect(output.output).toBe(VALID_SPEC);
    const foreign = { title: "read", output: "x", metadata: {} };
    await hooks["tool.execute.after"]!(
      { tool: "read", sessionID: "s", callID: "c", args: { filePath: "src/lib/x.ts" } },
      foreign,
    );
    expect(foreign.output).toBe("x");
  });

  test("annotation behavior is identical in enforce mode", async () => {
    const file = ".vvoc/specs/2026-08-29-cache/spec.xml";
    const { hooks } = await makePlugin("enforce", { [file]: VALID_SPEC });
    const output = { title: "read", output: VALID_SPEC, metadata: {} };
    await hooks["tool.execute.after"]!(
      { tool: "read", sessionID: "s", callID: "c", args: { filePath: file } },
      output,
    );
    expect(output.output).toContain("spec OK");
  });
});

describe("write validation", () => {
  test("enforce refuses a full-content write that would leave ERROR findings", async () => {
    const file = ".vvoc/specs/2026-08-29-cache/spec.xml";
    const { hooks } = await makePlugin("enforce", {});
    await expect(
      hooks["tool.execute.before"]!(
        { tool: "write", sessionID: "s", callID: "c" },
        { args: { filePath: file, content: BROKEN_SPEC } },
      ),
    ).rejects.toThrow(SPEC_GUARD_VERDICT_TAG);
  });

  test("enforce allows a clean full-content write", async () => {
    const file = ".vvoc/specs/2026-08-29-cache/spec.xml";
    const { hooks } = await makePlugin("enforce", {});
    await hooks["tool.execute.before"]!(
      { tool: "write", sessionID: "s", callID: "c" },
      { args: { filePath: file, content: VALID_SPEC } },
    );
  });

  test("warn mode never refuses a full-content write, even with ERROR findings", async () => {
    const file = ".vvoc/specs/2026-08-29-cache/spec.xml";
    const { hooks } = await makePlugin("warn", {});
    await hooks["tool.execute.before"]!(
      { tool: "write", sessionID: "s", callID: "c" },
      { args: { filePath: file, content: BROKEN_SPEC } },
    );
  });

  test("warn mode appends the verdict to edit results", async () => {
    const file = ".vvoc/specs/2026-08-29-cache/spec.xml";
    const { hooks } = await makePlugin("warn", { [file]: BROKEN_SPEC });
    const output = { title: "edit", output: "applied", metadata: {} };
    await hooks["tool.execute.after"]!(
      { tool: "edit", sessionID: "s", callID: "c", args: { filePath: file } },
      output,
    );
    expect(output.output).toContain("attr.forbidden");
  });

  test("enforce prefixes edit results whose file state contains ERROR findings", async () => {
    const file = ".vvoc/specs/2026-08-29-cache/spec.xml";
    const { hooks } = await makePlugin("enforce", { [file]: BROKEN_SPEC });
    const output = { title: "edit", output: "applied", metadata: {} };
    await hooks["tool.execute.after"]!(
      { tool: "edit", sessionID: "s", callID: "c", args: { filePath: file } },
      output,
    );
    expect(output.output).toContain("enforce");
    expect(output.output.startsWith(SPEC_GUARD_VERDICT_TAG)).toBe(true);
  });

  test("enforce appends a plain verdict when edit leaves a warning-only state", async () => {
    const planFile = ".vvoc/specs/2026-08-29-cache/plan.xml";
    const plan = `<plan><spec>missing-ref</spec><status>draft</status><tasks><WAVE-1><TASK-T-001><title>t</title><status>pending</status></TASK-T-001></WAVE-1></tasks></plan>`;
    const { hooks } = await makePlugin("enforce", { [planFile]: plan });
    const output = { title: "edit", output: "applied", metadata: {} };
    await hooks["tool.execute.after"]!(
      { tool: "edit", sessionID: "s", callID: "c", args: { filePath: planFile } },
      output,
    );
    expect(output.output).toContain("crossfile.spec_missing");
    expect(output.output.startsWith(SPEC_GUARD_VERDICT_TAG)).toBe(false);
  });

  test("draft incompleteness never triggers enforce refusal", async () => {
    const file = ".vvoc/specs/2026-08-29-cache/spec.xml";
    const emptyDraft = "<spec><status>draft</status><goal></goal><components></components></spec>";
    const { hooks } = await makePlugin("enforce", {});
    await hooks["tool.execute.before"]!(
      { tool: "write", sessionID: "s", callID: "c" },
      { args: { filePath: file, content: emptyDraft } },
    );
  });
});

describe("fail-open degradation", () => {
  test("a throwing file reader degrades to a warning verdict without breaking the tool", async () => {
    const file = ".vvoc/specs/2026-08-29-cache/spec.xml";
    const cache = await createSpecLintCache({
      cacheRoot: join(await mkdtemp(join(tmpdir(), "spec-guard-")), "lint"),
    });
    const logs: string[] = [];
    const plugin = createSpecGuardPlugin({
      mode: () => "enforce",
      cache,
      readFile: async () => {
        throw new Error("boom");
      },
      log: async (_level, message) => {
        logs.push(message);
      },
    });
    const hooks = (await plugin(
      {} as Parameters<ReturnType<typeof createSpecGuardPlugin>>[0],
    )) as Hooks;
    const output = { title: "edit", output: "applied", metadata: {} };
    await hooks["tool.execute.after"]!(
      { tool: "edit", sessionID: "s", callID: "c", args: { filePath: file } },
      output,
    );
    expect(output.output).toContain("spec_guard.unreadable");
  });

  test("unknown tools and missing args are ignored", async () => {
    const { hooks } = await makePlugin("warn", {});
    const output = { title: "bash", output: "ok", metadata: {} };
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "s", callID: "c", args: {} },
      output,
    );
    expect(output.output).toBe("ok");
  });
});
