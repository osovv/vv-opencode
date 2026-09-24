// FILE: src/lib/workflow-contract.test.ts
// VERSION: 1.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Deterministic tests for the dependency-free common workflow contract: canonical enums, declared-path normalization, explicit reviewer sets, execution boundary containment (including boundary-reporting containment failures), bounded task/checkpoint validation, exact-reference acyclic graph validation, and native definition adaptation.
//   SCOPE: Pure contract fixtures only; no filesystem, SDK, or persistence access.
//   DEPENDS: [src/lib/workflow-contract.ts]
//   LINKS: [M-WORKFLOW-CONTRACT]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   baseBoundary - Shared boundary fixture for containment and graph tests.
//   task - Builds a valid task contract with overridable fields.
//   checkpoint - Builds a valid checkpoint contract with overridable fields.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-002 - Added canonical enum coverage and OUT_OF_BOUNDARY offending-scope-plus-boundary reporting assertions.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import {
  AUTHORITY_STAGES,
  REVIEWER_ROLES,
  WORK_ITEM_MODES,
  normalizeDeclaredDirectoryPath,
  normalizeDeclaredScopePath,
  normalizeReviewerSet,
  taskContractsFromNativeDefinition,
  checkpointContractsFromNativeDefinition,
  validateExecutionBoundary,
  validateWorkflowCheckpointContract,
  validateWorkflowContractGraph,
  validateWorkflowTaskContract,
  type WorkflowCheckpointContract,
  type WorkflowExecutionBoundary,
  type WorkflowTaskContract,
  type NativePlanMetadata,
} from "./workflow-contract.js";

const baseBoundary: WorkflowExecutionBoundary = {
  files: ["src/lib/a.ts", "src/lib/b.ts"],
  directories: ["src/plugins/workflow"],
};

function task(overrides: Partial<WorkflowTaskContract> = {}): WorkflowTaskContract {
  return {
    taskId: "T-100",
    title: "Task one",
    goal: "Deliver task one.",
    acceptanceCriteria: ["Task one works."],
    verification: ["bun test src/lib/a.test.ts"],
    writeScope: ["src/lib/a.ts"],
    dependsOn: [],
    blockedBy: [],
    requiredReviewers: [],
    ...overrides,
  };
}

function checkpoint(
  overrides: Partial<WorkflowCheckpointContract> = {},
): WorkflowCheckpointContract {
  return {
    checkpointId: "C-100",
    kind: "milestone",
    covers: ["T-100"],
    scope: ["src/lib/a.ts"],
    requiredReviewers: ["code"],
    acceptance: ["Reviewed."],
    verification: ["bun test src/lib/a.test.ts"],
    origin: "controller",
    dependsOn: [],
    ...overrides,
  };
}

describe("canonical enum constants", () => {
  test("exposes the canonical work-item modes, reviewer roles, and authority stages", () => {
    expect([...WORK_ITEM_MODES]).toEqual(["implementation", "review_only", "delegated"]);
    expect([...REVIEWER_ROLES]).toEqual(["spec", "code"]);
    expect([...AUTHORITY_STAGES]).toEqual([
      "specification",
      "planning",
      "implementation",
      "verification",
    ]);
  });
});

describe("declared path normalization", () => {
  test("normalizes an explicit relative file path and trims surrounding space", () => {
    expect(normalizeDeclaredScopePath(" src/lib/a.ts ")).toEqual({
      ok: true,
      path: "src/lib/a.ts",
    });
  });

  test("rejects traversal, absolute, wildcard, and control-character paths", () => {
    for (const bad of ["../a.ts", "/abs/a.ts", "src/*.ts", "src/../a.ts", "", "src//a.ts"]) {
      expect(normalizeDeclaredScopePath(bad).ok).toBe(false);
    }
  });

  test("allows exactly one trailing separator for directory subtrees", () => {
    expect(normalizeDeclaredDirectoryPath("src/plugins/workflow/")).toEqual({
      ok: true,
      path: "src/plugins/workflow",
    });
    expect(normalizeDeclaredDirectoryPath("src/plugins/workflow//").ok).toBe(false);
  });
});

describe("explicit reviewer normalization", () => {
  test("preserves an explicit empty set but rejects absent or malformed sets", () => {
    expect(normalizeReviewerSet([])).toEqual([]);
    expect(normalizeReviewerSet(["code", "spec"])).toEqual(["spec", "code"]);
    expect(normalizeReviewerSet(undefined)).toBeUndefined();
    expect(normalizeReviewerSet(["code", "code"])).toBeUndefined();
    expect(normalizeReviewerSet(["code", "other"])).toBeUndefined();
    expect(normalizeReviewerSet("code")).toBeUndefined();
  });
});

describe("execution boundary validation", () => {
  test("normalizes unique exact files and directory subtrees", () => {
    const result = validateExecutionBoundary({
      files: [" src/lib/a.ts "],
      directories: ["src/plugins/workflow/"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      files: ["src/lib/a.ts"],
      directories: ["src/plugins/workflow"],
    });
  });

  test("rejects duplicate, malformed, and empty boundaries", () => {
    expect(validateExecutionBoundary({ files: ["src/a.ts", "src/a.ts"] }).ok).toBe(false);
    expect(validateExecutionBoundary({ files: ["../a.ts"] }).ok).toBe(false);
    expect(validateExecutionBoundary({ files: [], directories: [] }).ok).toBe(false);
  });
});

describe("task and checkpoint contract validation", () => {
  test("accepts a bounded generic task with an explicit empty reviewer set", () => {
    const result = validateWorkflowTaskContract({
      taskId: "T-100",
      title: "Task one",
      goal: "Deliver task one.",
      acceptanceCriteria: ["Task one works."],
      verification: [],
      writeScope: ["src/lib/a.ts"],
      dependsOn: [],
      blockedBy: [],
      requiredReviewers: [],
    });
    expect(result.ok).toBe(true);
  });

  test("rejects a task whose requiredReviewers is absent or malformed", () => {
    const missing = validateWorkflowTaskContract({
      taskId: "T-100",
      title: "Task one",
      goal: "Deliver task one.",
      acceptanceCriteria: [],
      verification: [],
      writeScope: ["src/lib/a.ts"],
      dependsOn: [],
      blockedBy: [],
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.problems.map((problem) => problem.code)).toContain("MISSING_REVIEWERS");

    const malformed = validateWorkflowTaskContract({
      taskId: "T-100",
      title: "Task one",
      goal: "Deliver task one.",
      acceptanceCriteria: [],
      verification: [],
      writeScope: ["src/lib/a.ts"],
      dependsOn: [],
      blockedBy: [],
      requiredReviewers: ["spec", "spec"],
    });
    expect(malformed.ok).toBe(false);
  });

  test("requires a non-empty reviewer set on an assigned checkpoint", () => {
    const empty = validateWorkflowCheckpointContract({
      checkpointId: "C-100",
      kind: "final",
      covers: ["T-100"],
      scope: ["src/lib/a.ts"],
      requiredReviewers: [],
      acceptance: [],
      verification: [],
      origin: "controller",
      dependsOn: [],
    });
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.problems.map((problem) => problem.code)).toContain("INVALID_REVIEWERS");
  });
});

describe("contract graph validation", () => {
  test("accepts a valid acyclic graph inside the boundary", () => {
    const result = validateWorkflowContractGraph({
      tasks: [
        task(),
        task({ taskId: "T-200", dependsOn: ["T-100"], writeScope: ["src/lib/b.ts"] }),
      ],
      checkpoints: [checkpoint({ covers: ["T-100", "T-200"] })],
      boundary: baseBoundary,
    });
    expect(result.ok).toBe(true);
  });

  test("rejects unknown references and out-of-boundary writes", () => {
    const result = validateWorkflowContractGraph({
      tasks: [
        task({ dependsOn: ["T-999"] }),
        task({ taskId: "T-300", writeScope: ["src/elsewhere/c.ts"] }),
      ],
      checkpoints: [checkpoint({ covers: ["T-404"] })],
      boundary: baseBoundary,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const codes = result.problems.map((problem) => problem.code);
    expect(codes).toContain("UNKNOWN_REFERENCE");
    expect(codes).toContain("OUT_OF_BOUNDARY");
  });

  test("reports the offending scope together with the applicable declared boundary", () => {
    const result = validateWorkflowContractGraph({
      tasks: [task({ writeScope: ["src/elsewhere/c.ts"] })],
      checkpoints: [],
      boundary: baseBoundary,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const boundaryProblem = result.problems.find((problem) => problem.code === "OUT_OF_BOUNDARY");
    expect(boundaryProblem).toBeDefined();
    expect(boundaryProblem?.message).toContain("src/elsewhere/c.ts");
    expect(boundaryProblem?.message).toContain("src/lib/a.ts");
    expect(boundaryProblem?.message).toContain("src/plugins/workflow");
  });

  test("rejects duplicate identities and dependency cycles", () => {
    const duplicate = validateWorkflowContractGraph({
      tasks: [task(), task()],
      checkpoints: [],
      boundary: baseBoundary,
    });
    expect(duplicate.ok).toBe(false);

    const cyclic = validateWorkflowContractGraph({
      tasks: [
        task({ taskId: "T-100", dependsOn: ["T-200"] }),
        task({ taskId: "T-200", dependsOn: ["T-100"] }),
      ],
      checkpoints: [],
      boundary: baseBoundary,
    });
    expect(cyclic.ok).toBe(false);
    if (cyclic.ok) return;
    expect(cyclic.problems.map((problem) => problem.code)).toContain("CYCLIC_DEPENDENCY");
  });
});

describe("native definition adaptation", () => {
  const nativeDefinition: NativePlanMetadata = {
    mode: "delegated",
    waves: ["WAVE-1", "WAVE-2"],
    tasks: [
      {
        taskId: "T-001",
        taskElement: "TASK-T-001",
        wave: "WAVE-1",
        writeScope: ["src/lib/a.ts"],
        title: "Build A",
        acceptance: ["A works."],
        verification: ["bun test src/lib/a.test.ts"],
      },
      {
        taskId: "T-002",
        taskElement: "TASK-T-002",
        wave: "WAVE-2",
        writeScope: ["src/lib/b.ts"],
        title: "Wire B",
        acceptance: ["B uses A."],
        verification: ["bun test src/lib/b.test.ts"],
        dependsOn: ["T-001"],
      },
    ],
    checkpoints: [
      {
        checkpointId: "CHECKPOINT-R-001",
        kind: "final",
        afterWave: "WAVE-2",
        covers: ["T-001", "T-002"],
        scope: ["src/lib/a.ts", "src/lib/b.ts"],
        reviewers: ["spec", "code"],
        acceptance: ["Complete result reviewed."],
        verification: ["bun test"],
      },
    ],
  };

  test("lifts title, acceptance, verification, and dependency text from the native definition", () => {
    const tasks = taskContractsFromNativeDefinition(nativeDefinition);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({
      taskId: "T-001",
      title: "Build A",
      acceptanceCriteria: ["A works."],
      verification: ["bun test src/lib/a.test.ts"],
      requiredReviewers: [],
    });
    expect(tasks[1].dependsOn).toEqual(["T-001"]);
  });

  test("adapts native checkpoints with source origin and reviewers", () => {
    const checkpoints = checkpointContractsFromNativeDefinition(nativeDefinition);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({
      checkpointId: "CHECKPOINT-R-001",
      kind: "final",
      covers: ["T-001", "T-002"],
      requiredReviewers: ["spec", "code"],
      origin: "source",
    });
  });
});
