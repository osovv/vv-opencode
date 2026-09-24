// FILE: src/plugins/workflow/input-validation.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Deterministic unit coverage of validateWorkflowToolInput across the approved workflow branch matrix: standalone/generic item rules, execution source variants, closed nested shapes, decision and checkpoint action requirements, and authority stage/stop validation with precise tokenized paths.
//   SCOPE: Pure structural and branch validation over synthetic argument maps; no store, SDK session, filesystem, or persistence access.
//   DEPENDS: [bun:test, src/plugins/workflow/input-validation.ts, src/lib/agent-tool-contract.ts]
//   LINKS: [M-WORKFLOW-TOOLING, M-AGENT-TOOL-CONTRACT]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   issuesOf - Extracts the bounded issue list from a failed validation result.
//   pathsOf - Extracts issue paths from a failed validation result.
//   messagesOf - Renders a failed validation result as one formatted message.
//   expectReject - Asserts failure and returns the formatted message.
//   standaloneOpen - Builds a structurally valid standalone work_item_open request.
//   genericItem - Builds a structurally valid generic task item.
//   genericOpen - Builds a valid generic registration request.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-002 - Initial mandatory diagnostic coverage for workflow tool input validation, extended with the action/decision field matrix, field-specific blank rejection with trim-before-bound, precise indexed boundary paths, published diagnostic bounds, shared generic task branch coverage for work_checkpoint register/amend tasks, and owning-validator bound-parity positives/negatives that prove no invented caps.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import type { ContractIssue } from "../../lib/agent-tool-contract.js";
import {
  MAX_ISSUE_MESSAGE_CHARS,
  MAX_ISSUE_PATH_CHARS,
  formatContractIssues,
} from "../../lib/agent-tool-contract.js";
import { WORKFLOW_ID_MAX_CHARS } from "../../lib/workflow-contract.js";
import {
  WORKFLOW_TOOL_DESCRIPTIONS,
  WORKFLOW_TOOL_IDS,
  assertWorkflowToolInput,
  isWorkflowToolId,
  validateWorkflowToolInput,
} from "./input-validation.js";

function issuesOf(result: {
  ok: boolean;
  issues?: readonly ContractIssue[];
}): readonly ContractIssue[] {
  if (result.ok) throw new Error("expected validation failure");
  return result.issues ?? [];
}

function pathsOf(result: { ok: boolean; issues?: readonly ContractIssue[] }): string[] {
  return issuesOf(result).map((issue) => issue.path);
}

function messagesOf(result: { ok: boolean; issues?: readonly ContractIssue[] }): string {
  return formatContractIssues(issuesOf(result));
}

function expectReject(
  toolId: (typeof WORKFLOW_TOOL_IDS)[number],
  args: unknown,
): { paths: string[]; message: string } {
  const result = validateWorkflowToolInput(toolId, args);
  expect(result.ok).toBe(false);
  return { paths: pathsOf(result), message: messagesOf(result) };
}

function standaloneOpen(
  item: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { items: [{ key: "k", title: "Title", ...item }], ...extra };
}

function genericItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "gk",
    title: "Generic task",
    mode: "delegated",
    requiredReviewers: [],
    writeScope: ["src/lib/a.ts"],
    taskId: "T-100",
    ...overrides,
  };
}

function genericOpen(
  item: Record<string, unknown>,
  execution: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    items: [item],
    execution: {
      executionKey: "run-1",
      source: { kind: "conversation-scoped" },
      goal: "Deliver the change.",
      boundary: { files: ["src/lib/a.ts"], directories: [] },
      ...execution,
    },
  };
}

describe("tool identity and descriptions", () => {
  test("recognizes exactly the five owned workflow tools", () => {
    expect(WORKFLOW_TOOL_IDS).toEqual([
      "work_item_open",
      "work_item_list",
      "work_item_close",
      "work_item_decide",
      "work_checkpoint",
    ]);
    expect(isWorkflowToolId("work_item_open")).toBe(true);
    expect(isWorkflowToolId("task")).toBe(false);
    expect(isWorkflowToolId(undefined)).toBe(false);
    for (const toolId of WORKFLOW_TOOL_IDS) {
      expect(WORKFLOW_TOOL_DESCRIPTIONS[toolId].length).toBeGreaterThan(0);
    }
  });
});

describe("work_item_open standalone branches", () => {
  test("accepts implementation, review_only, and delegated standalone items", () => {
    expect(
      validateWorkflowToolInput(
        "work_item_open",
        standaloneOpen({ mode: "implementation", requiredReviewers: ["spec", "code"] }),
      ).ok,
    ).toBe(true);
    expect(
      validateWorkflowToolInput(
        "work_item_open",
        standaloneOpen({ mode: "review_only", requiredReviewers: ["code"] }),
      ).ok,
    ).toBe(true);
    expect(
      validateWorkflowToolInput(
        "work_item_open",
        standaloneOpen({
          mode: "delegated",
          requiredReviewers: [],
          writeScope: ["src/lib/a.ts"],
        }),
      ).ok,
    ).toBe(true);
    expect(
      validateWorkflowToolInput(
        "work_item_open",
        standaloneOpen({
          mode: "delegated",
          requiredReviewers: [],
          writeScope: ["src/lib/a.ts"],
          planRunId: "run-native",
          planTaskId: "T-001",
        }),
      ).ok,
    ).toBe(true);
  });

  test("missing versus empty reviewer arrays follow the mode rules", () => {
    const missing = expectReject("work_item_open", standaloneOpen({ mode: "implementation" }));
    expect(missing.paths).toContain("items[0].requiredReviewers");

    const emptyStandalone = expectReject(
      "work_item_open",
      standaloneOpen({ mode: "review_only", requiredReviewers: [] }),
    );
    expect(emptyStandalone.paths).toContain("items[0].requiredReviewers");

    // Delegated: missing is structural, explicit empty is the documented form.
    const delegatedMissing = expectReject(
      "work_item_open",
      standaloneOpen({ mode: "delegated", writeScope: ["src/lib/a.ts"] }),
    );
    expect(delegatedMissing.paths).toContain("items[0].requiredReviewers");

    const delegatedNonEmpty = expectReject(
      "work_item_open",
      standaloneOpen({
        mode: "delegated",
        requiredReviewers: ["code"],
        writeScope: ["src/lib/a.ts"],
      }),
    );
    expect(delegatedNonEmpty.paths).toContain("items[0].requiredReviewers");

    expect(
      validateWorkflowToolInput(
        "work_item_open",
        standaloneOpen({ mode: "delegated", requiredReviewers: [], writeScope: ["src/a.ts"] }),
      ).ok,
    ).toBe(true);
  });

  test("standalone items reject generic task fields and delegated bindings by mode", () => {
    const genericField = expectReject(
      "work_item_open",
      standaloneOpen({ mode: "implementation", requiredReviewers: ["spec"], taskId: "T-1" }),
    );
    expect(genericField.paths).toContain("items[0].taskId");

    const scopeOnImplementation = expectReject(
      "work_item_open",
      standaloneOpen({
        mode: "implementation",
        requiredReviewers: ["spec"],
        writeScope: ["src/a.ts"],
      }),
    );
    expect(scopeOnImplementation.paths).toContain("items[0].writeScope");

    const halfBinding = expectReject(
      "work_item_open",
      standaloneOpen({
        mode: "delegated",
        requiredReviewers: [],
        writeScope: ["src/a.ts"],
        planRunId: "run-native",
      }),
    );
    expect(halfBinding.paths).toContain("items[0].planTaskId");
  });

  test("file trailing separators are rejected while directory separators normalize", () => {
    const trailingFile = expectReject(
      "work_item_open",
      standaloneOpen({
        mode: "delegated",
        requiredReviewers: [],
        writeScope: ["src/lib/"],
      }),
    );
    expect(trailingFile.paths).toContain("items[0].writeScope[0]");
    expect(trailingFile.message).toContain("empty path segment");

    expect(
      validateWorkflowToolInput(
        "work_item_open",
        genericOpen(genericItem(), {
          boundary: { files: [], directories: ["src/plugins/workflow/"] },
        }),
      ).ok,
    ).toBe(true);

    const trailingBoundaryFile = expectReject(
      "work_item_open",
      genericOpen(genericItem(), {
        boundary: { files: ["src/lib/"], directories: [] },
      }),
    );
    expect(trailingBoundaryFile.message).toContain("boundary.files");
  });
});

describe("work_item_open generic branches", () => {
  test("execution and runId are mutually exclusive and append requires amendment context", () => {
    expect(validateWorkflowToolInput("work_item_open", genericOpen(genericItem())).ok).toBe(true);

    const conflicting = expectReject("work_item_open", {
      ...genericOpen(genericItem()),
      runId: "run-existing",
    });
    expect(conflicting.paths).toContain("execution");

    const appendMissing = expectReject("work_item_open", {
      items: [genericItem()],
      runId: "run-existing",
    });
    expect(appendMissing.paths).toContain("amendmentId");
    expect(appendMissing.paths).toContain("rationale");

    const orphanAmendment = expectReject("work_item_open", {
      items: [genericItem()],
      amendmentId: "amend-1",
      rationale: "why",
    });
    expect(orphanAmendment.paths).toContain("amendmentId");

    // Registration must not silently drop append-only amendment context.
    const executionWithAmendment = expectReject("work_item_open", {
      ...genericOpen(genericItem()),
      amendmentId: "amend-1",
      rationale: "why",
    });
    expect(executionWithAmendment.paths).toContain("amendmentId");
    expect(executionWithAmendment.paths).toContain("rationale");

    expect(
      validateWorkflowToolInput("work_item_open", {
        items: [genericItem()],
        runId: "run-existing",
        amendmentId: "amend-1",
        rationale: "Add a follow-up task.",
      }).ok,
    ).toBe(true);
  });

  test("generic reviewer-positive path accepts empty and non-empty task reviewers", () => {
    expect(
      validateWorkflowToolInput(
        "work_item_open",
        genericOpen(genericItem({ requiredReviewers: [] })),
      ).ok,
    ).toBe(true);
    expect(
      validateWorkflowToolInput(
        "work_item_open",
        genericOpen(genericItem({ requiredReviewers: ["code"] })),
      ).ok,
    ).toBe(true);
    const duplicate = expectReject(
      "work_item_open",
      genericOpen(genericItem({ requiredReviewers: ["code", "code"] })),
    );
    expect(duplicate.paths).toContain("items[0].requiredReviewers");
  });

  test("conflicting generic mode and native bindings are rejected, not ignored", () => {
    const wrongMode = expectReject(
      "work_item_open",
      genericOpen(genericItem({ mode: "implementation" })),
    );
    expect(wrongMode.paths).toContain("items[0].mode");

    const nativeBinding = expectReject(
      "work_item_open",
      genericOpen(genericItem({ planRunId: "run-native", planTaskId: "T-001" })),
    );
    expect(nativeBinding.paths).toContain("items[0].planRunId");

    const missingScope = expectReject(
      "work_item_open",
      genericOpen(
        genericItem({
          writeScope: undefined,
        }),
      ),
    );
    expect(missingScope.paths).toContain("items[0].writeScope");
  });

  test("execution sources: conversation rejected, provided-plan reference and sha256 typed", () => {
    const conversation = expectReject(
      "work_item_open",
      genericOpen(genericItem(), { source: { kind: "conversation" } }),
    );
    expect(conversation.paths.some((path) => path.includes("source"))).toBe(true);
    expect(conversation.message).toContain("conversation-scoped");

    const missingReference = expectReject(
      "work_item_open",
      genericOpen(genericItem(), { source: { kind: "provided-plan" } }),
    );
    expect(missingReference.paths).toContain("execution.source.reference");

    const numericSha = expectReject(
      "work_item_open",
      genericOpen(genericItem(), {
        source: { kind: "provided-plan", reference: "docs/plan.md", sha256: 123 },
      }),
    );
    expect(numericSha.paths).toContain("execution.source.sha256");

    const nativeSource = expectReject(
      "work_item_open",
      genericOpen(genericItem(), {
        source: { kind: "native-package", planPath: "p", specPath: "s" },
      }),
    );
    expect(nativeSource.paths.some((path) => path.includes("source"))).toBe(true);

    expect(
      validateWorkflowToolInput(
        "work_item_open",
        genericOpen(genericItem(), {
          source: { kind: "provided-plan", reference: "docs/plan.md", sha256: "abc123" },
        }),
      ).ok,
    ).toBe(true);
  });

  test("numeric path elements and nested unknown keys are rejected with indices", () => {
    const numericPath = expectReject(
      "work_item_open",
      genericOpen(genericItem(), {
        boundary: { files: [123], directories: [] },
      }),
    );
    expect(numericPath.paths).toContain("execution.boundary.files[0]");

    const unknownNested = expectReject(
      "work_item_open",
      genericOpen(genericItem({ unexpected: true })),
    );
    expect(unknownNested.paths).toContain("items[0].unexpected");

    const unknownCheckpointKey = expectReject(
      "work_item_open",
      genericOpen(genericItem(), {
        checkpoints: [
          {
            checkpointId: "C-1",
            kind: "milestone",
            covers: ["T-100"],
            requiredReviewers: ["code"],
            origin: "controller",
            mystery: 1,
          },
        ],
      }),
    );
    expect(unknownCheckpointKey.paths).toContain("execution.checkpoints[0].mystery");

    const unknownTopLevel = expectReject("work_item_open", {
      ...genericOpen(genericItem()),
      unexpectedRoot: true,
    });
    expect(unknownTopLevel.paths).toContain("unexpectedRoot");
  });
});

describe("work_item_decide branches", () => {
  const base = { workItemId: "wi-1", attempt: 1 };

  test("accept and request_changes require bounded rationale and evidence", () => {
    const missing = expectReject("work_item_decide", {
      ...base,
      decision: "accept",
    });
    expect(missing.paths).toContain("rationale");
    expect(missing.paths).toContain("evidence");

    const emptyEvidence = expectReject("work_item_decide", {
      ...base,
      decision: "request_changes",
      rationale: "Needs work.",
      evidence: [],
    });
    expect(emptyEvidence.paths).toContain("evidence");

    const blankRationale = expectReject("work_item_decide", {
      ...base,
      decision: "accept",
      rationale: "   ",
      evidence: ["bun test"],
    });
    expect(blankRationale.paths).toContain("rationale");

    expect(
      validateWorkflowToolInput("work_item_decide", {
        ...base,
        decision: "accept",
        rationale: "Verified.",
        evidence: ["bun test"],
      }).ok,
    ).toBe(true);
  });

  test("rework binds its failed checkpoint and recover requires the bounded recovery fields", () => {
    const rework = expectReject("work_item_decide", { ...base, decision: "rework" });
    expect(rework.paths).toContain("runId");
    expect(rework.paths).toContain("checkpointId");

    const recover = expectReject("work_item_decide", {
      ...base,
      decision: "recover",
      recoveryId: "rec-1",
    });
    expect(recover.paths).toContain("diagnosis");
    expect(recover.paths).toContain("changedCondition");
    expect(recover.paths).toContain("verification");

    const authorityWithoutRun = expectReject("work_item_decide", {
      ...base,
      decision: "recover",
      recoveryId: "rec-1",
      diagnosis: "Stopped.",
      changedCondition: "Gate changed.",
      verification: ["bun test"],
      authorityId: "auth-1",
    });
    expect(authorityWithoutRun.paths).toContain("runId");

    expect(
      validateWorkflowToolInput("work_item_decide", {
        ...base,
        decision: "recover",
        recoveryId: "rec-1",
        diagnosis: "Stopped.",
        changedCondition: "Gate changed.",
        verification: ["bun test"],
      }).ok,
    ).toBe(true);
  });

  test("attempt and concernsDisposition bounds are structural", () => {
    const attempt = expectReject("work_item_decide", {
      ...base,
      attempt: 0,
      decision: "accept",
      rationale: "ok",
      evidence: ["x"],
    });
    expect(attempt.paths).toContain("attempt");

    const blankDisposition = expectReject("work_item_decide", {
      ...base,
      decision: "accept",
      rationale: "ok",
      evidence: ["x"],
      concernsDisposition: " ",
    });
    expect(blankDisposition.paths).toContain("concernsDisposition");
  });
});

describe("work_checkpoint branches", () => {
  test("native register and generic register routes are exclusive", () => {
    const both = expectReject("work_checkpoint", {
      action: "register",
      planPath: ".vvoc/specs/x/plan.xml",
      runId: "run-1",
    });
    expect(both.paths).toContain("runId");

    const genericWithoutRun = expectReject("work_checkpoint", { action: "register" });
    expect(genericWithoutRun.paths).toContain("runId");

    const genericWithoutContext = expectReject("work_checkpoint", {
      action: "register",
      runId: "run-1",
    });
    expect(genericWithoutContext.paths).toContain("amendmentId");
    expect(genericWithoutContext.paths).toContain("rationale");

    expect(
      validateWorkflowToolInput("work_checkpoint", {
        action: "register",
        planPath: ".vvoc/specs/x/plan.xml",
      }).ok,
    ).toBe(true);
  });

  test("source-specific action fields are required with precise paths", () => {
    const start = expectReject("work_checkpoint", { action: "start", runId: "run-1" });
    expect(start.paths).toContain("checkpointId");

    const review = expectReject("work_checkpoint", { action: "review", runId: "run-1" });
    expect(review.paths).toContain("checkpointId");

    const recover = expectReject("work_checkpoint", {
      action: "recover",
      runId: "run-1",
      checkpointId: "C-1",
    });
    expect(recover.paths).toContain("recoveryId");
    expect(recover.paths).toContain("diagnosis");
    expect(recover.paths).toContain("verification");
  });

  test("authority stage and reserved-stop vocabularies reject with precise indices", () => {
    const typoStops = expectReject("work_checkpoint", {
      action: "authorize",
      runId: "run-1",
      authorityId: "auth-1",
      messageId: "msg-1",
      stages: ["implementation"],
      reservedStops: ["verificaton"],
    });
    expect(typoStops.paths).toContain("reservedStops[0]");
    expect(typoStops.message).toContain("reservedStops[0]");

    const mixedStages = expectReject("work_checkpoint", {
      action: "authorize",
      runId: "run-1",
      authorityId: "auth-1",
      messageId: "msg-1",
      stages: ["implementation", "publication"],
    });
    expect(mixedStages.paths).toContain("stages[1]");

    const missingStages = expectReject("work_checkpoint", {
      action: "authorize",
      runId: "run-1",
      authorityId: "auth-1",
      messageId: "msg-1",
    });
    expect(missingStages.paths).toContain("stages");

    const approvalStage = expectReject("work_checkpoint", {
      action: "record_approval",
      runId: "run-1",
      authorityId: "auth-1",
      approvalId: "appr-1",
      artifactPath: "src/a.ts",
      artifactSha256: "abc",
    });
    expect(approvalStage.paths).toContain("stage");

    const revokeStages = expectReject("work_checkpoint", {
      action: "revoke_authority",
      runId: "run-1",
      authorityId: "auth-1",
      revocationId: "revoke-1",
      stages: ["verification", "bogus"],
    });
    expect(revokeStages.paths).toContain("stages[1]");

    expect(
      validateWorkflowToolInput("work_checkpoint", {
        action: "authorize",
        runId: "run-1",
        authorityId: "auth-1",
        messageId: "msg-1",
        stages: ["implementation"],
        reservedStops: ["specification"],
      }).ok,
    ).toBe(true);
    // Absent reserved stops keep the documented default.
    expect(
      validateWorkflowToolInput("work_checkpoint", {
        action: "revoke_authority",
        runId: "run-1",
        authorityId: "auth-1",
        revocationId: "revoke-1",
      }).ok,
    ).toBe(true);
  });

  test("checkpoint register/amend tasks obey the generic task branch rules with tasks[i] paths", () => {
    const invalidMode = expectReject("work_checkpoint", {
      action: "amend",
      runId: "run-1",
      amendmentId: "amend-1",
      rationale: "Append a task.",
      tasks: [
        {
          key: "b",
          title: "B",
          mode: "implementation",
          requiredReviewers: [],
          writeScope: ["b.ts"],
        },
      ],
    });
    expect(invalidMode.paths).toContain("tasks[0].mode");

    const nativeBindings = expectReject("work_checkpoint", {
      action: "amend",
      runId: "run-1",
      amendmentId: "amend-1",
      rationale: "Append a task.",
      tasks: [
        {
          key: "b",
          title: "B",
          mode: "delegated",
          requiredReviewers: [],
          writeScope: ["b.ts"],
          planRunId: "native-run",
          planTaskId: "native-task",
        },
      ],
    });
    expect(nativeBindings.paths).toContain("tasks[0].planRunId");

    const missingScope = expectReject("work_checkpoint", {
      action: "register",
      runId: "run-1",
      amendmentId: "amend-1",
      rationale: "Register a task.",
      tasks: [{ key: "b", title: "B", mode: "delegated", requiredReviewers: [] }],
    });
    expect(missingScope.paths).toContain("tasks[0].writeScope");

    const invalidScope = expectReject("work_checkpoint", {
      action: "amend",
      runId: "run-1",
      amendmentId: "amend-1",
      rationale: "Append a task.",
      tasks: [
        { key: "b", title: "B", mode: "delegated", requiredReviewers: [], writeScope: ["b/"] },
      ],
    });
    expect(invalidScope.paths).toContain("tasks[0].writeScope[0]");

    const duplicateReviewers = expectReject("work_checkpoint", {
      action: "amend",
      runId: "run-1",
      amendmentId: "amend-1",
      rationale: "Append a task.",
      tasks: [
        {
          key: "b",
          title: "B",
          mode: "delegated",
          requiredReviewers: ["code", "code"],
          writeScope: ["b.ts"],
        },
      ],
    });
    expect(duplicateReviewers.paths).toContain("tasks[0].requiredReviewers");

    // Positive: explicit empty and non-empty generic reviewer sets both pass.
    expect(
      validateWorkflowToolInput("work_checkpoint", {
        action: "amend",
        runId: "run-1",
        amendmentId: "amend-1",
        rationale: "Append tasks.",
        tasks: [
          { key: "b", title: "B", mode: "delegated", requiredReviewers: [], writeScope: ["b.ts"] },
          {
            key: "c",
            title: "C",
            mode: "delegated",
            requiredReviewers: ["code"],
            writeScope: ["c.ts"],
          },
        ],
      }).ok,
    ).toBe(true);
  });

  test("generic checkpoint batches use closed nested shapes", () => {
    const unknownTaskKey = expectReject("work_checkpoint", {
      action: "amend",
      runId: "run-1",
      amendmentId: "amend-1",
      rationale: "Add checkpoint coverage.",
      tasks: [
        {
          key: "tk",
          title: "Task",
          mode: "delegated",
          requiredReviewers: [],
          writeScope: ["src/a.ts"],
          bogus: 1,
        },
      ],
    });
    expect(unknownTaskKey.paths).toContain("tasks[0].bogus");

    expect(
      validateWorkflowToolInput("work_checkpoint", {
        action: "amend",
        runId: "run-1",
        amendmentId: "amend-1",
        rationale: "Add checkpoint coverage.",
        tasks: [
          {
            key: "tk",
            title: "Task",
            mode: "delegated",
            requiredReviewers: ["code"],
            writeScope: ["src/a.ts"],
          },
        ],
        checkpoints: [
          {
            checkpointId: "C-1",
            kind: "final",
            covers: ["tk"],
            requiredReviewers: ["spec"],
            origin: "controller",
          },
        ],
      }).ok,
    ).toBe(true);
  });
});

describe("action and decision field matrix (recognized-field conflicts)", () => {
  test("work_checkpoint rejects fields not consumed by the selected action", () => {
    const completeStops = expectReject("work_checkpoint", {
      action: "complete",
      runId: "run-1",
      reservedStops: ["verification"],
    });
    expect(completeStops.paths).toContain("reservedStops");

    const startPlan = expectReject("work_checkpoint", {
      action: "start",
      runId: "run-1",
      checkpointId: "C-1",
      planPath: "ignored.xml",
    });
    expect(startPlan.paths).toContain("planPath");

    const authorizeCheckpoint = expectReject("work_checkpoint", {
      action: "authorize",
      runId: "run-1",
      authorityId: "auth-1",
      messageId: "msg-1",
      stages: ["implementation"],
      checkpointId: "C-1",
    });
    expect(authorizeCheckpoint.paths).toContain("checkpointId");

    const verifyFingerprint = expectReject("work_checkpoint", {
      action: "verify",
      runId: "run-1",
      checkpointId: "C-1",
      startFingerprint: "abc",
    });
    expect(verifyFingerprint.paths).toContain("startFingerprint");

    const completeReviewer = expectReject("work_checkpoint", {
      action: "complete",
      runId: "run-1",
      reviewer: "code",
    });
    expect(completeReviewer.paths).toContain("reviewer");
  });

  test("native planPath registration rejects generic amendment fields instead of ignoring them", () => {
    const nativeAmendment = expectReject("work_checkpoint", {
      action: "register",
      planPath: ".vvoc/specs/x/plan.xml",
      amendmentId: "amend-1",
      rationale: "Append a task.",
    });
    expect(nativeAmendment.paths).toContain("amendmentId");
    expect(nativeAmendment.paths).toContain("rationale");

    const nativeTasks = expectReject("work_checkpoint", {
      action: "register",
      planPath: ".vvoc/specs/x/plan.xml",
      tasks: [
        {
          key: "tk",
          title: "Task",
          mode: "delegated",
          requiredReviewers: [],
          writeScope: ["src/a.ts"],
        },
      ],
    });
    expect(nativeTasks.paths).toContain("tasks");
  });

  test("supported fields on their own action remain accepted", () => {
    expect(
      validateWorkflowToolInput("work_checkpoint", {
        action: "complete",
        runId: "run-1",
        rationale: "Done.",
        verification: ["bun test"],
      }).ok,
    ).toBe(true);
    expect(
      validateWorkflowToolInput("work_checkpoint", {
        action: "verify",
        runId: "run-1",
        checkpointId: "C-1",
        complete: true,
        reviewer: "code",
      }).ok,
    ).toBe(true);
    expect(
      validateWorkflowToolInput("work_checkpoint", {
        action: "recover",
        runId: "run-1",
        checkpointId: "C-1",
        recoveryId: "rec-1",
        diagnosis: "Stopped.",
        changedCondition: "Gate changed.",
        verification: ["bun test"],
        authorityId: "auth-1",
      }).ok,
    ).toBe(true);
  });

  test("work_item_decide rejects fields not consumed by the selected decision", () => {
    const acceptRecovery = expectReject("work_item_decide", {
      workItemId: "wi-1",
      attempt: 1,
      decision: "accept",
      rationale: "checked",
      evidence: ["test"],
      recoveryId: "ignored-recovery",
    });
    expect(acceptRecovery.paths).toContain("recoveryId");

    const acceptRun = expectReject("work_item_decide", {
      workItemId: "wi-1",
      attempt: 1,
      decision: "accept",
      rationale: "checked",
      evidence: ["test"],
      runId: "run-1",
    });
    expect(acceptRun.paths).toContain("runId");

    const acceptDiagnosis = expectReject("work_item_decide", {
      workItemId: "wi-1",
      attempt: 1,
      decision: "accept",
      rationale: "checked",
      evidence: ["test"],
      diagnosis: "ignored",
    });
    expect(acceptDiagnosis.paths).toContain("diagnosis");

    const reworkEvidence = expectReject("work_item_decide", {
      workItemId: "wi-1",
      attempt: 1,
      decision: "rework",
      runId: "run-1",
      checkpointId: "C-1",
      evidence: ["ignored"],
    });
    expect(reworkEvidence.paths).toContain("evidence");

    const recoverRationale = expectReject("work_item_decide", {
      workItemId: "wi-1",
      attempt: 2,
      decision: "recover",
      recoveryId: "rec-1",
      diagnosis: "Stopped.",
      changedCondition: "Gate changed.",
      verification: ["bun test"],
      rationale: "ignored",
    });
    expect(recoverRationale.paths).toContain("rationale");

    const recoverDisposition = expectReject("work_item_decide", {
      workItemId: "wi-1",
      attempt: 2,
      decision: "recover",
      recoveryId: "rec-1",
      diagnosis: "Stopped.",
      changedCondition: "Gate changed.",
      verification: ["bun test"],
      concernsDisposition: "ignored",
    });
    expect(recoverDisposition.paths).toContain("concernsDisposition");

    // runId is only consumed by recover together with an authorityId.
    const recoverRunOnly = expectReject("work_item_decide", {
      workItemId: "wi-1",
      attempt: 2,
      decision: "recover",
      recoveryId: "rec-1",
      diagnosis: "Stopped.",
      changedCondition: "Gate changed.",
      verification: ["bun test"],
      runId: "run-1",
    });
    expect(recoverRunOnly.paths).toContain("runId");

    expect(
      validateWorkflowToolInput("work_item_decide", {
        workItemId: "wi-1",
        attempt: 2,
        decision: "recover",
        recoveryId: "rec-1",
        diagnosis: "Stopped.",
        changedCondition: "Gate changed.",
        verification: ["bun test"],
        authorityId: "auth-1",
        runId: "run-1",
      }).ok,
    ).toBe(true);
  });
});

describe("whitespace and omission normalization", () => {
  test("an empty-after-trim batch member rejects the entire structural batch", () => {
    const result = expectReject("work_item_open", {
      items: [
        { key: "a", title: "a", mode: "review_only", requiredReviewers: ["code"] },
        { key: "   ", title: "bad", mode: "review_only", requiredReviewers: ["code"] },
      ],
    });
    expect(result.paths).toContain("items[1].key");
    expect(result.paths.some((path) => path.startsWith("items[0]"))).toBe(false);
  });

  test("supplied blank optional values are rejected, not treated as absent", () => {
    const blankRunId = expectReject("work_item_open", {
      items: [genericItem()],
      runId: "   ",
      amendmentId: "amend-1",
      rationale: "why",
    });
    expect(blankRunId.paths).toContain("runId");

    const blankRationale = expectReject("work_item_decide", {
      workItemId: "wi-1",
      attempt: 1,
      decision: "rework",
      runId: "run-1",
      checkpointId: "C-1",
      rationale: "   ",
    });
    expect(blankRationale.paths).toContain("rationale");

    const blankFingerprint = expectReject("work_checkpoint", {
      action: "start",
      runId: "run-1",
      checkpointId: "C-1",
      startFingerprint: "  ",
    });
    expect(blankFingerprint.paths).toContain("startFingerprint");
  });

  test("blank provided-plan reference/sha256 and nested task/checkpoint fields are rejected", () => {
    const blankReference = expectReject(
      "work_item_open",
      genericOpen(genericItem(), { source: { kind: "provided-plan", reference: "   " } }),
    );
    expect(blankReference.paths).toContain("execution.source.reference");

    const blankSha = expectReject(
      "work_item_open",
      genericOpen(genericItem(), {
        source: { kind: "provided-plan", reference: "docs/p.md", sha256: "  " },
      }),
    );
    expect(blankSha.paths).toContain("execution.source.sha256");

    const blankCriterion = expectReject(
      "work_item_open",
      genericOpen(genericItem({ acceptanceCriteria: ["Task works.", "  "] })),
    );
    expect(blankCriterion.paths).toContain("items[0].acceptanceCriteria[1]");

    const blankCover = expectReject(
      "work_item_open",
      genericOpen(genericItem(), {
        checkpoints: [
          {
            checkpointId: "C-1",
            kind: "milestone",
            covers: ["  "],
            requiredReviewers: ["code"],
            origin: "controller",
          },
        ],
      }),
    );
    expect(blankCover.paths).toContain("execution.checkpoints[0].covers[0]");
  });
});

describe("bounded, precisely indexed diagnostics", () => {
  test("boundary failures carry the indexed file/directory path and empty boundaries the boundary path", () => {
    const trailingFile = expectReject(
      "work_item_open",
      genericOpen(genericItem(), { boundary: { files: ["src/lib/"], directories: [] } }),
    );
    expect(trailingFile.paths).toContain("execution.boundary.files[0]");

    const badDirectory = expectReject(
      "work_item_open",
      genericOpen(genericItem(), { boundary: { files: [], directories: ["/abs/"] } }),
    );
    expect(badDirectory.paths).toContain("execution.boundary.directories[0]");

    const emptyBoundary = expectReject(
      "work_item_open",
      genericOpen(genericItem(), { boundary: { files: [], directories: [] } }),
    );
    expect(emptyBoundary.paths).toContain("execution.boundary");
  });

  test("branch issue paths and messages stay within the published bounds", () => {
    const longPath = "x".repeat(5000);
    const result = validateWorkflowToolInput(
      "work_item_open",
      standaloneOpen({
        mode: "delegated",
        requiredReviewers: [],
        writeScope: [`/${longPath}`],
      }),
    );
    const issues = issuesOf(result);
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.message.length).toBeLessThanOrEqual(MAX_ISSUE_MESSAGE_CHARS);
      expect(issue.path.length).toBeLessThanOrEqual(MAX_ISSUE_PATH_CHARS);
    }
  });
});

describe("owning-validator bound parity (no invented caps)", () => {
  test("accepts large boundaries, batches, long paths, and delegated recovery ids", () => {
    const longPath = `src/${"a".repeat(2100)}.ts`;
    expect(
      validateWorkflowToolInput(
        "work_item_open",
        genericOpen(genericItem(), {
          boundary: { files: [longPath], directories: [] },
        }),
      ).ok,
    ).toBe(true);

    const boundaryFiles = Array.from({ length: 85 }, (_, index) => `src/dir/f${index}.ts`);
    const writeScope = Array.from({ length: 85 }, (_, index) => `src/dir/g${index}.ts`);
    expect(
      validateWorkflowToolInput(
        "work_item_open",
        genericOpen(genericItem({ writeScope }), {
          boundary: { files: [...boundaryFiles, ...writeScope], directories: [] },
        }),
      ).ok,
    ).toBe(true);

    const standaloneItems = Array.from({ length: 65 }, (_, index) => ({
      key: `s-${index}`,
      title: `S ${index}`,
      mode: "review_only",
      requiredReviewers: ["code"],
    }));
    expect(validateWorkflowToolInput("work_item_open", { items: standaloneItems }).ok).toBe(true);

    const genericTasks = Array.from({ length: 65 }, (_, index) => ({
      key: `t-${index}`,
      title: `T ${index}`,
      mode: "delegated",
      requiredReviewers: [],
      writeScope: ["src/a.ts"],
      taskId: `T-${index}`,
    }));
    expect(
      validateWorkflowToolInput("work_checkpoint", {
        action: "amend",
        runId: "run-1",
        amendmentId: "amend-1",
        rationale: "Large batch.",
        tasks: genericTasks,
      }).ok,
    ).toBe(true);

    expect(
      validateWorkflowToolInput("work_item_decide", {
        workItemId: "wi-1",
        attempt: 1,
        decision: "recover",
        recoveryId: "r".repeat(200),
        diagnosis: "Stopped.",
        changedCondition: "Gate changed.",
        verification: ["bun test"],
      }).ok,
    ).toBe(true);
  });

  test("trims before the canonical bound so surrounding whitespace cannot reject a valid id", () => {
    const idAtBound = `T${"a".repeat(WORKFLOW_ID_MAX_CHARS - 1)}`;
    expect(idAtBound.length).toBe(WORKFLOW_ID_MAX_CHARS);
    expect(
      validateWorkflowToolInput(
        "work_item_open",
        genericOpen(genericItem({ taskId: `  ${idAtBound}  ` })),
      ).ok,
    ).toBe(true);
  });

  test("invalid boundaries and genuinely bounded fields reject with precise paths", () => {
    const traversal = expectReject(
      "work_item_open",
      genericOpen(genericItem(), { boundary: { files: ["src/../x"], directories: [] } }),
    );
    expect(traversal.paths).toContain("execution.boundary.files[0]");

    const numeric = expectReject(
      "work_item_open",
      genericOpen(genericItem(), { boundary: { files: [7], directories: [] } }),
    );
    expect(numeric.paths).toContain("execution.boundary.files[0]");

    const unknownBoundary = expectReject(
      "work_item_open",
      genericOpen(genericItem(), { boundary: { files: ["src/a.ts"], directories: [], extra: 1 } }),
    );
    expect(unknownBoundary.paths).toContain("execution.boundary.extra");

    const longTaskId = expectReject(
      "work_item_open",
      genericOpen(genericItem({ taskId: `T${"a".repeat(WORKFLOW_ID_MAX_CHARS)}` })),
    );
    expect(longTaskId.paths).toContain("items[0].taskId");

    const tooManyEvidence = expectReject("work_item_decide", {
      workItemId: "wi-1",
      attempt: 1,
      decision: "accept",
      rationale: "ok",
      evidence: Array.from({ length: 9 }, (_, index) => `e-${index}`),
    });
    expect(tooManyEvidence.paths).toContain("evidence");

    const longRationale = expectReject("work_item_decide", {
      workItemId: "wi-1",
      attempt: 1,
      decision: "accept",
      rationale: "r".repeat(2001),
      evidence: ["e"],
    });
    expect(longRationale.paths).toContain("rationale");
  });
});

describe("simple tools and guard", () => {
  test("list and close validate their closed shapes", () => {
    expect(validateWorkflowToolInput("work_item_list", {}).ok).toBe(true);
    expect(validateWorkflowToolInput("work_item_list", { includeClosed: true }).ok).toBe(true);
    const badList = expectReject("work_item_list", { includeClosed: "yes" });
    expect(badList.paths).toContain("includeClosed");

    expect(validateWorkflowToolInput("work_item_close", { workItemId: "wi-1" }).ok).toBe(true);
    const blankClose = expectReject("work_item_close", { workItemId: "   " });
    expect(blankClose.paths).toContain("workItemId");

    expect(expectReject("work_item_close", { unexpected: true }).paths).toContain("unexpected");
  });

  test("assertWorkflowToolInput throws ContractInputError with bounded issues", () => {
    expect(() =>
      assertWorkflowToolInput("work_item_open", standaloneOpen({ mode: "review_only" })),
    ).toThrowError("INVALID_INPUT");
    try {
      assertWorkflowToolInput("work_checkpoint", { action: "start" });
      throw new Error("expected ContractInputError");
    } catch (error) {
      const typed = error as { name?: string; code?: string; issues?: readonly ContractIssue[] };
      expect(typed.name).toBe("ContractInputError");
      expect(typed.code).toBe("INVALID_INPUT");
      expect((typed.issues ?? []).some((issue) => issue.path === "runId")).toBe(true);
    }
  });
});
