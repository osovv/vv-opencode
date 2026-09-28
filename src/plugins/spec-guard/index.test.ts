// FILE: src/plugins/spec-guard/index.test.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Native-boundary tests for the spec-guard plugin: read annotation, archive silence, warn append, enforce failure on ERROR, and never blocking warning-only or clean writes, driven through the native tool hook event shapes.
//   SCOPE: Invoke the native execute.before/after handlers with pinned tool event/result shapes through createSpecGuardHandlers with injected mode, cache, file reader, and log.
//   DEPENDS: [src/plugins/spec-guard/index.ts, src/lib/spec-lint-cache.ts]
//   LINKS: [M-PLUGIN-SPEC-GUARD, V-M-PLUGIN-SPEC-GUARD]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   VALID_SPEC - Minimal valid spec fixture.
//   BROKEN_SPEC - Spec fixture with an attribute violation.
//   SpecGuardModeLike - Mode union accepted by the fixture.
//   makeHandlers - Builds native hook handlers with injected mode, files, cache, and log.
//   readEvent - Builds a native completed read event carrying a mutable result.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-005 - Rewrote V1 hook-map tests as native execute.before/after event tests with native Tool.Result content shapes.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SPEC_GUARD_VERDICT_TAG,
  createSpecGuardHandlers,
  isSpecGuardTargetPath,
  specGuardPathFromArgs,
  type SpecGuardAfterEvent,
  type SpecGuardBeforeEvent,
  type SpecGuardHandlers,
  type SpecGuardMode,
} from "./index.js";
import { createSpecLintCache } from "../../lib/spec-lint-cache.js";

const VALID_SPEC = `<spec><status>draft</status><goal>g</goal><components><COMPONENT-A><name>A</name><responsibility>r</responsibility></COMPONENT-A></components></spec>`;
const BROKEN_SPEC = `<spec><goal status="oops">g</goal></spec>`;

type SpecGuardModeLike = SpecGuardMode | "off" | "unknown";

async function makeHandlers(
  mode: SpecGuardModeLike,
  files: Record<string, string>,
): Promise<{ handlers: SpecGuardHandlers; logs: string[] }> {
  const logs: string[] = [];
  const cache = await createSpecLintCache({
    cacheRoot: join(await mkdtemp(join(tmpdir(), "spec-guard-")), "lint"),
  });
  const handlers = createSpecGuardHandlers({
    modeFor: async () => mode,
    cache,
    readFile: async (path) => files[path],
    log: async (_level, message) => {
      logs.push(message);
    },
  });
  return { handlers, logs };
}

function readEvent(file: string, result: { content: string }): SpecGuardAfterEvent {
  return {
    tool: "read",
    sessionID: "s",
    input: { path: file },
    status: "completed",
    result,
  };
}

function editEvent(file: string, result: { content: string }): SpecGuardAfterEvent {
  return {
    tool: "edit",
    sessionID: "s",
    input: { path: file },
    status: "completed",
    result,
  };
}

function writeBefore(file: string, content: string): SpecGuardBeforeEvent {
  return { tool: "write", sessionID: "s", input: { path: file, content } };
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

  test("tool input path extraction covers native and legacy spellings", () => {
    expect(specGuardPathFromArgs({ filePath: "a.xml" })).toBe("a.xml");
    expect(specGuardPathFromArgs({ file_path: "a.xml" })).toBe("a.xml");
    expect(specGuardPathFromArgs({ path: "a.xml" })).toBe("a.xml");
    expect(specGuardPathFromArgs({})).toBeUndefined();
    expect(specGuardPathFromArgs(undefined)).toBeUndefined();
  });
});

describe("read annotation", () => {
  test("appends the lint verdict to native read results of active artifacts in warn mode", async () => {
    const file = ".vvoc/specs/2026-08-29-cache/spec.xml";
    const { handlers } = await makeHandlers("warn", { [file]: VALID_SPEC });
    const result = { content: VALID_SPEC };
    await handlers.after(readEvent(file, result));
    expect(result.content).toContain(SPEC_GUARD_VERDICT_TAG);
    expect(result.content).toContain("spec OK");
  });

  test("derives the read verdict from the file on disk, not the tool rendering", async () => {
    const file = ".vvoc/specs/2026-08-29-cache/spec.xml";
    const { handlers } = await makeHandlers("warn", { [file]: VALID_SPEC });
    // The pinned read tool renders line-number prefixes; the verdict must
    // describe the artifact, never the rendering.
    const rendered = `1: <spec>\n2:   <status>draft</status>`;
    const result = { content: rendered };
    await handlers.after(readEvent(file, result));
    expect(result.content).toContain("spec OK");
    expect(result.content).not.toContain("xml.content-after-root");
  });

  test("appends nothing for archived files or foreign paths", async () => {
    const { handlers } = await makeHandlers("warn", {
      ".vvoc/specs/archive/2026-08-29-cache-1/spec.xml": VALID_SPEC,
    });
    const archived = { content: VALID_SPEC };
    await handlers.after(readEvent(".vvoc/specs/archive/2026-08-29-cache-1/spec.xml", archived));
    expect(archived.content).toBe(VALID_SPEC);
    const foreign = { content: "x" };
    await handlers.after(readEvent("src/lib/x.ts", foreign));
    expect(foreign.content).toBe("x");
  });

  test("annotation behavior is identical in enforce mode", async () => {
    const file = ".vvoc/specs/2026-08-29-cache/spec.xml";
    const { handlers } = await makeHandlers("enforce", { [file]: VALID_SPEC });
    const result = { content: VALID_SPEC };
    await handlers.after(readEvent(file, result));
    expect(result.content).toContain("spec OK");
  });
});

describe("write validation", () => {
  test("enforce refuses a full-content write that would leave ERROR findings", async () => {
    const file = ".vvoc/specs/2026-08-29-cache/spec.xml";
    const { handlers } = await makeHandlers("enforce", {});
    await expect(handlers.before(writeBefore(file, BROKEN_SPEC))).rejects.toThrow(
      SPEC_GUARD_VERDICT_TAG,
    );
  });

  test("enforce allows a clean full-content write", async () => {
    const file = ".vvoc/specs/2026-08-29-cache/spec.xml";
    const { handlers } = await makeHandlers("enforce", {});
    await handlers.before(writeBefore(file, VALID_SPEC));
  });

  test("warn mode never refuses a full-content write, even with ERROR findings", async () => {
    const file = ".vvoc/specs/2026-08-29-cache/spec.xml";
    const { handlers } = await makeHandlers("warn", {});
    await handlers.before(writeBefore(file, BROKEN_SPEC));
  });

  test("warn mode appends the verdict to native edit results", async () => {
    const file = ".vvoc/specs/2026-08-29-cache/spec.xml";
    const { handlers } = await makeHandlers("warn", { [file]: BROKEN_SPEC });
    const result = { content: "applied" };
    await handlers.after(editEvent(file, result));
    expect(result.content).toContain("attr.forbidden");
  });

  test("enforce prefixes edit results whose file state contains ERROR findings", async () => {
    const file = ".vvoc/specs/2026-08-29-cache/spec.xml";
    const { handlers } = await makeHandlers("enforce", { [file]: BROKEN_SPEC });
    const result = { content: "applied" };
    await handlers.after(editEvent(file, result));
    expect(result.content).toContain("enforce");
    expect(result.content.startsWith(SPEC_GUARD_VERDICT_TAG)).toBe(true);
  });

  test("enforce appends a plain verdict when edit leaves a warning-only state", async () => {
    const planFile = ".vvoc/specs/2026-08-29-cache/plan.xml";
    const plan = `<plan><spec>missing-ref</spec><status>draft</status><tasks><WAVE-1><TASK-T-001><title>t</title><status>pending</status></TASK-T-001></WAVE-1></tasks></plan>`;
    const { handlers } = await makeHandlers("enforce", { [planFile]: plan });
    const result = { content: "applied" };
    await handlers.after(editEvent(planFile, result));
    expect(result.content).toContain("crossfile.spec_missing");
    expect(result.content.startsWith(SPEC_GUARD_VERDICT_TAG)).toBe(false);
  });

  test("draft incompleteness never triggers enforce refusal", async () => {
    const file = ".vvoc/specs/2026-08-29-cache/spec.xml";
    const emptyDraft = "<spec><status>draft</status><goal></goal><components></components></spec>";
    const { handlers } = await makeHandlers("enforce", {});
    await handlers.before(writeBefore(file, emptyDraft));
  });
});

describe("fail-open degradation", () => {
  test("a throwing file reader degrades to a warning verdict without breaking the tool", async () => {
    const file = ".vvoc/specs/2026-08-29-cache/spec.xml";
    const cache = await createSpecLintCache({
      cacheRoot: join(await mkdtemp(join(tmpdir(), "spec-guard-")), "lint"),
    });
    const handlers = createSpecGuardHandlers({
      modeFor: async () => "enforce",
      cache,
      readFile: async () => {
        throw new Error("boom");
      },
      log: async () => {},
    });
    const result = { content: "applied" };
    await handlers.after(editEvent(file, result));
    expect(result.content).toContain("spec_guard.unreadable");
  });

  test("unknown tools and missing inputs are ignored", async () => {
    const { handlers } = await makeHandlers("warn", {});
    const result = { content: "ok" };
    await handlers.after({
      tool: "bash",
      sessionID: "s",
      input: {},
      status: "completed",
      result,
    });
    expect(result.content).toBe("ok");
  });

  test("an off mode leaves every tool untouched", async () => {
    const file = ".vvoc/specs/2026-08-29-cache/spec.xml";
    const { handlers } = await makeHandlers("off", { [file]: BROKEN_SPEC });
    const result = { content: "applied" };
    await handlers.after(editEvent(file, result));
    expect(result.content).toBe("applied");
    await handlers.before(writeBefore(file, BROKEN_SPEC));
  });

  test("an unknown family policy refuses protected mutation and handoff", async () => {
    const file = ".vvoc/specs/2026-08-29-cache/spec.xml";
    const { handlers } = await makeHandlers("unknown", { [file]: VALID_SPEC });
    await expect(handlers.before(writeBefore(file, VALID_SPEC))).rejects.toThrow(/unknown-policy/);
    const result = { content: VALID_SPEC };
    await expect(handlers.after(readEvent(file, result))).rejects.toThrow(/unknown-policy/);
    expect(result.content).toBe(VALID_SPEC);
  });

  test("an unknown family policy leaves non-target paths untouched", async () => {
    const { handlers } = await makeHandlers("unknown", {});
    const result = { content: "ok" };
    await handlers.after(readEvent("src/lib/x.ts", result));
    expect(result.content).toBe("ok");
    await handlers.before({
      tool: "write",
      sessionID: "s",
      input: { path: "src/lib/x.ts", content: "x" },
    });
  });
});
