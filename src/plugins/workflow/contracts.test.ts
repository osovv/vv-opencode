// FILE: src/plugins/workflow/contracts.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Contract coverage of the five registered workflow tool definitions: model-facing JSON Schema projection (closed roots, canonical enums, field descriptions, concrete source/task/checkpoint structures), SDK-shaped schema acceptance/rejection over the registered argument maps, and operation-branch accept/reject fixtures through the actual contracts.
//   SCOPE: Contract schemas and projections only; no store mutation, plugin lifecycle, or host process.
//   DEPENDS: [bun:test, @opencode-ai/plugin (tool.schema), src/plugins/workflow/input-validation.ts, src/plugins/workflow/schemas.ts, src/lib/agent-tool-contract.ts]
//   LINKS: [M-WORKFLOW-TOOLING, M-AGENT-TOOL-CONTRACT, M-PLUGIN-WORKFLOW]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   contractBy - Contract lookup helper for one workflow tool.
//   projectionOf - Input-mode JSON Schema projection for one workflow tool.
//   propertiesOf - Narrow a projection to its properties record.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-002 - Initial contract-projection and operation-branch fixture coverage for the five workflow tools, plus assertions that bounded fields publish only their true owning-validator bounds and omit invented caps on unbounded collections/paths/ids, and that registered schemas accept large valid boundaries/batches.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { tool } from "@opencode-ai/plugin";
import {
  getWorkflowToolContract,
  validateWorkflowToolInput,
  workflowToolContracts,
} from "./input-validation.js";
import {
  workCheckpointArgs,
  workItemCloseArgs,
  workItemDecideArgs,
  workItemListArgs,
  workItemOpenArgs,
} from "./schemas.js";
import type { WorkflowToolId } from "./input-validation.js";
import { WORKFLOW_ID_MAX_CHARS, WORKFLOW_TEXT_MAX_ITEMS } from "../../lib/workflow-contract.js";
import { DELEGATED_EVIDENCE_MAX_CHARS, DELEGATED_EVIDENCE_MAX_REFS } from "./delegated.js";

function contractBy(toolId: WorkflowToolId) {
  return getWorkflowToolContract(toolId);
}

function projectionOf(toolId: WorkflowToolId): Record<string, unknown> {
  return contractBy(toolId).inputJsonSchema;
}

function propertiesOf(projection: Record<string, unknown>): Record<string, unknown> {
  const properties = projection.properties;
  if (!properties || typeof properties !== "object") {
    throw new Error("projection has no properties");
  }
  return properties as Record<string, unknown>;
}

describe("registered argument maps match the pinned SDK shape", () => {
  test("each registered shape parses a valid fixture through the SDK schema instance", () => {
    const fixtures: Record<WorkflowToolId, Record<string, unknown>> = {
      work_item_open: {
        items: [
          {
            key: "k",
            title: "T",
            mode: "implementation",
            requiredReviewers: ["spec"],
          },
        ],
      },
      work_item_list: {},
      work_item_close: { workItemId: "wi-1" },
      work_item_decide: {
        workItemId: "wi-1",
        attempt: 1,
        decision: "accept",
        rationale: "Verified.",
        evidence: ["bun test"],
      },
      work_checkpoint: {
        action: "start",
        runId: "run-1",
        checkpointId: "C-1",
      },
    };
    const shapes: Record<WorkflowToolId, Record<string, unknown>> = {
      work_item_open: workItemOpenArgs,
      work_item_list: workItemListArgs,
      work_item_close: workItemCloseArgs,
      work_item_decide: workItemDecideArgs,
      work_checkpoint: workCheckpointArgs,
    };
    for (const toolId of Object.keys(fixtures) as WorkflowToolId[]) {
      const registered = tool.schema.object(shapes[toolId] as never);
      const parsed = registered.safeParse(fixtures[toolId]);
      expect(parsed.success).toBe(true);
    }
  });
});

describe("model-facing JSON Schema projection", () => {
  test("every contract projects a closed root object with field descriptions", () => {
    for (const toolId of [
      "work_item_open",
      "work_item_list",
      "work_item_close",
      "work_item_decide",
      "work_checkpoint",
    ] as const) {
      const projection = projectionOf(toolId);
      expect(projection.type).toBe("object");
      expect(projection.additionalProperties).toBe(false);
      const properties = propertiesOf(projection);
      expect(Object.keys(properties).length).toBeGreaterThan(0);
    }
  });

  test("work_item_open projects closed nested items, canonical enums, and a concrete source union", () => {
    const properties = propertiesOf(projectionOf("work_item_open"));
    const items = properties.items as { type: string; items: Record<string, unknown> };
    expect(items.type).toBe("array");
    expect(items.items.additionalProperties).toBe(false);
    const itemProps = items.items.properties as Record<string, unknown>;
    expect(itemProps.mode).toMatchObject({
      enum: ["implementation", "review_only", "delegated"],
    });
    expect(itemProps.requiredReviewers).toMatchObject({
      type: "array",
      items: { enum: ["spec", "code"] },
    });
    expect(typeof itemProps.key).toBe("object");
    expect(itemProps).toHaveProperty("writeScope");

    const execution = properties.execution as { properties: Record<string, unknown> };
    const source = execution.properties.source as Record<string, unknown>;
    expect(JSON.stringify(source)).not.toContain("record");
    expect(JSON.stringify(source)).not.toContain("unknown");
    expect(JSON.stringify(source)).toContain("conversation-scoped");
    expect(JSON.stringify(source)).toContain("provided-plan");
    expect(JSON.stringify(source)).not.toContain("native-package");
    const checkpoints = execution.properties.checkpoints as {
      items: { additionalProperties: boolean; properties: Record<string, unknown> };
    };
    expect(checkpoints.items.additionalProperties).toBe(false);
    expect(checkpoints.items.properties).toHaveProperty("checkpointId");
    expect(checkpoints.items.properties).toHaveProperty("requiredReviewers");
    const description = itemProps.mode as { description?: string };
    expect(typeof description.description).toBe("string");
  });

  test("work_item_decide and work_checkpoint project closed decision/action vocabularies", () => {
    const decideProps = propertiesOf(projectionOf("work_item_decide"));
    expect(decideProps.decision).toMatchObject({
      enum: ["accept", "request_changes", "rework", "recover"],
    });
    expect(decideProps.attempt).toMatchObject({ minimum: 1 });

    const checkpointProps = propertiesOf(projectionOf("work_checkpoint"));
    expect(checkpointProps.action).toMatchObject({
      enum: [
        "register",
        "start",
        "verify",
        "recover",
        "review",
        "bind",
        "complete",
        "amend",
        "authorize",
        "record_approval",
        "revoke_authority",
      ],
    });
    expect(checkpointProps.stage).toMatchObject({
      enum: ["specification", "planning", "implementation", "verification"],
    });
    expect(checkpointProps.reservedStops).toMatchObject({
      type: "array",
      items: { enum: ["specification", "planning", "implementation", "verification"] },
    });
    const tasks = checkpointProps.tasks as {
      items: { additionalProperties: boolean; properties: Record<string, unknown> };
    };
    expect(tasks.items.additionalProperties).toBe(false);
    expect(tasks.items.properties).toHaveProperty("taskId");
    expect(JSON.stringify(checkpointProps.tasks)).not.toContain("unknown");
    expect(JSON.stringify(checkpointProps.checkpoints)).not.toContain("unknown");
  });

  test("bounded fields publish true owning-validator bounds and omit invented ones", () => {
    type Bound = { maxLength?: number; maxItems?: number; items?: Bound };
    const checkpointProps = propertiesOf(projectionOf("work_checkpoint")) as Record<string, Bound>;

    // True bounds: checkpointId (isBoundedWorkflowId), recoveryId (delegated
    // recovery 512), verification references (8), stages unbounded.
    expect(checkpointProps.checkpointId.maxLength).toBe(WORKFLOW_ID_MAX_CHARS);
    expect(checkpointProps.recoveryId.maxLength).toBe(DELEGATED_EVIDENCE_MAX_CHARS);
    expect(checkpointProps.verification.maxItems).toBe(DELEGATED_EVIDENCE_MAX_REFS);
    // Invented bounds removed: no cap where the owning validator has none.
    expect(checkpointProps.stages.maxItems).toBeUndefined();
    expect(checkpointProps.reservedStops.maxItems).toBeUndefined();
    expect(checkpointProps.tasks.maxItems).toBeUndefined();
    expect(checkpointProps.checkpoints.maxItems).toBeUndefined();
    expect(checkpointProps.fileBoundary.maxItems).toBeUndefined();
    expect(checkpointProps.fileBoundary.items?.maxLength).toBeUndefined();
    expect(checkpointProps.planPath.maxLength).toBeUndefined();
    expect(checkpointProps.artifactPath.maxLength).toBeUndefined();
    expect(checkpointProps.userMessageId.maxLength).toBeUndefined();

    const openProps = propertiesOf(projectionOf("work_item_open")) as Record<string, Bound>;
    const executionProps = (openProps.execution as unknown as { properties: Record<string, Bound> })
      .properties;
    expect(executionProps.executionKey.maxLength).toBe(WORKFLOW_ID_MAX_CHARS);
    const boundaryProps = (
      executionProps.boundary as unknown as { properties: Record<string, Bound> }
    ).properties;
    expect(boundaryProps.files.maxItems).toBeUndefined();
    expect(boundaryProps.files.items?.maxLength).toBeUndefined();
    expect(boundaryProps.directories.maxItems).toBeUndefined();
    expect((executionProps.checkpoints as Bound).maxItems).toBeUndefined();
    expect(openProps.items.maxItems).toBeUndefined();

    const taskProps = (
      openProps.items as unknown as { items: { properties: Record<string, Bound> } }
    ).items.properties;
    expect(taskProps.taskId.maxLength).toBe(WORKFLOW_ID_MAX_CHARS);
    expect(taskProps.key.maxLength).toBeUndefined();
    expect(taskProps.title.maxLength).toBeUndefined();
    expect(taskProps.planRunId.maxLength).toBeUndefined();
    expect(taskProps.planTaskId.maxLength).toBeUndefined();
    expect(taskProps.writeScope.maxItems).toBeUndefined();
    expect(taskProps.writeScope.items?.maxLength).toBeUndefined();
    expect(taskProps.acceptanceCriteria.maxItems).toBe(WORKFLOW_TEXT_MAX_ITEMS);
    expect(taskProps.acceptanceCriteria.items?.maxLength).toBeGreaterThan(0);
    expect(taskProps.dependsOn.maxItems).toBe(WORKFLOW_TEXT_MAX_ITEMS);
    expect(taskProps.dependsOn.items?.maxLength).toBe(WORKFLOW_ID_MAX_CHARS);

    const decideProps = propertiesOf(projectionOf("work_item_decide")) as Record<string, Bound>;
    expect(decideProps.workItemId.maxLength).toBeUndefined();
    expect(decideProps.runId.maxLength).toBeUndefined();
    expect(decideProps.recoveryId.maxLength).toBe(DELEGATED_EVIDENCE_MAX_CHARS);
    expect(decideProps.evidence.maxItems).toBe(DELEGATED_EVIDENCE_MAX_REFS);

    const sourceProps = executionProps.source as unknown as {
      anyOf?: Array<{ properties?: Record<string, Bound> }>;
    };
    const providedPlan = sourceProps.anyOf?.find((branch) =>
      Object.prototype.hasOwnProperty.call(branch.properties ?? {}, "reference"),
    );
    expect(providedPlan?.properties?.sha256?.maxLength).toBeUndefined();
  });

  test("registered schemas accept large valid boundaries and batches", () => {
    const files = Array.from({ length: 85 }, (_, index) => `src/f${index}.ts`);
    const open = contractBy("work_item_open").safeParse({
      items: [
        {
          key: "a",
          title: "A",
          mode: "delegated",
          requiredReviewers: [],
          writeScope: files,
          taskId: "T-A",
        },
      ],
      execution: {
        executionKey: "run-x",
        source: { kind: "conversation-scoped" },
        goal: "Large boundary.",
        boundary: { files, directories: [] },
      },
    });
    expect(open.success).toBe(true);

    const tasks = Array.from({ length: 70 }, (_, index) => ({
      key: `t-${index}`,
      title: `T ${index}`,
      mode: "delegated",
      requiredReviewers: [],
      writeScope: ["src/a.ts"],
      taskId: `T-${index}`,
    }));
    const amendment = contractBy("work_checkpoint").safeParse({
      action: "amend",
      runId: "run-1",
      amendmentId: "amend-1",
      rationale: "Large batch.",
      tasks,
    });
    expect(amendment.success).toBe(true);
  });

  test("work_item_list and work_item_close project their closed fields", () => {
    const listProps = propertiesOf(projectionOf("work_item_list"));
    expect(listProps).toHaveProperty("includeClosed");
    const closeProps = propertiesOf(projectionOf("work_item_close"));
    expect(closeProps).toHaveProperty("workItemId");
  });
});

describe("operation-branch fixtures through the actual contracts", () => {
  test("positive and negative fixture for every open branch", () => {
    const accepts: Array<Record<string, unknown>> = [
      {
        items: [
          { key: "a", title: "A", mode: "implementation", requiredReviewers: ["spec", "code"] },
        ],
      },
      {
        items: [
          {
            key: "b",
            title: "B",
            mode: "delegated",
            requiredReviewers: [],
            writeScope: ["src/lib/a.ts"],
          },
        ],
      },
      {
        items: [
          {
            key: "g",
            title: "G",
            mode: "delegated",
            requiredReviewers: ["code"],
            writeScope: ["src/lib/a.ts"],
            taskId: "T-100",
          },
        ],
        execution: {
          executionKey: "run-1",
          source: { kind: "conversation-scoped" },
          goal: "Deliver.",
          boundary: { files: ["src/lib/a.ts"], directories: ["src/lib/"] },
        },
      },
      {
        items: [
          {
            key: "g2",
            title: "G2",
            mode: "delegated",
            requiredReviewers: [],
            writeScope: ["src/lib/a.ts"],
          },
        ],
        runId: "run-existing",
        amendmentId: "amend-1",
        rationale: "Append the follow-up.",
      },
    ];
    for (const fixture of accepts) {
      expect(validateWorkflowToolInput("work_item_open", fixture).ok).toBe(true);
    }

    const rejects: Array<Record<string, unknown>> = [
      { items: [] },
      { items: [{ key: "x", title: "X" }] },
      {
        items: [{ key: "x", title: "X", mode: "implementation", requiredReviewers: [] }],
      },
      {
        items: [{ key: "x", title: "X", mode: "delegated", requiredReviewers: [] }],
      },
      {
        items: [{ key: "x", title: "X", mode: "implementation", requiredReviewers: ["spec"] }],
        amendmentId: "amend-1",
        rationale: "no run",
      },
      {
        items: [{ key: "x", title: "X", mode: "implementation", requiredReviewers: ["spec"] }],
        execution: {
          executionKey: "run-1",
          source: { kind: "conversation" },
          goal: "Deliver.",
          boundary: { files: ["src/lib/a.ts"], directories: [] },
        },
      },
      {
        items: [{ key: "x", title: "X", mode: "implementation", requiredReviewers: ["spec"] }],
        execution: {
          executionKey: "run-1",
          source: { kind: "provided-plan" },
          goal: "Deliver.",
          boundary: { files: ["src/lib/a.ts"], directories: [] },
        },
      },
      {
        items: [{ key: "x", title: "X", mode: "implementation", requiredReviewers: ["spec"] }],
        execution: {
          executionKey: "run-1",
          source: { kind: "provided-plan", reference: "docs/p.md", sha256: 7 },
          goal: "Deliver.",
          boundary: { files: ["src/lib/a.ts"], directories: [] },
        },
      },
    ];
    for (const fixture of rejects) {
      const result = validateWorkflowToolInput("work_item_open", fixture);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  test("positive and negative fixture for every decide decision and checkpoint action", () => {
    const decides: Array<Record<string, unknown>> = [
      {
        workItemId: "wi-1",
        attempt: 1,
        decision: "accept",
        rationale: "Looks good.",
        evidence: ["bun test"],
      },
      {
        workItemId: "wi-1",
        attempt: 1,
        decision: "request_changes",
        rationale: "Fix the edge case.",
        evidence: ["review note"],
        concernsDisposition: "Resolved after rework.",
      },
      {
        workItemId: "wi-1",
        attempt: 1,
        decision: "rework",
        runId: "run-1",
        checkpointId: "C-1",
        rationale: "Checkpoint failed.",
      },
      {
        workItemId: "wi-1",
        attempt: 2,
        decision: "recover",
        recoveryId: "rec-1",
        diagnosis: "Both attempts stopped.",
        changedCondition: "Packet clarified.",
        verification: ["bun test"],
      },
    ];
    for (const fixture of decides) {
      expect(validateWorkflowToolInput("work_item_decide", fixture).ok).toBe(true);
    }
    expect(
      validateWorkflowToolInput("work_item_decide", {
        workItemId: "wi-1",
        attempt: 1,
        decision: "accept",
        rationale: "ok",
      }).ok,
    ).toBe(false);

    const actions: Array<Record<string, unknown>> = [
      { action: "register", planPath: ".vvoc/specs/x/plan.xml" },
      { action: "start", runId: "run-1", checkpointId: "C-1" },
      { action: "verify", runId: "run-1", checkpointId: "C-1", complete: true },
      {
        action: "recover",
        runId: "run-1",
        checkpointId: "C-1",
        recoveryId: "rec-1",
        diagnosis: "d",
        changedCondition: "c",
        verification: ["v"],
      },
      { action: "review", runId: "run-1", checkpointId: "C-1", reviewer: "code" },
      { action: "bind", runId: "run-1", checkpointId: "C-1" },
      { action: "complete", runId: "run-1", rationale: "Done." },
      {
        action: "amend",
        runId: "run-1",
        amendmentId: "amend-1",
        rationale: "Add coverage.",
      },
      {
        action: "authorize",
        runId: "run-1",
        authorityId: "auth-1",
        messageId: "msg-1",
        stages: ["implementation"],
        reservedStops: ["specification"],
      },
      {
        action: "record_approval",
        runId: "run-1",
        authorityId: "auth-1",
        approvalId: "appr-1",
        stage: "implementation",
        artifactPath: "src/lib/a.ts",
        artifactSha256: "abc",
      },
      {
        action: "revoke_authority",
        runId: "run-1",
        authorityId: "auth-1",
        revocationId: "revoke-1",
      },
    ];
    for (const fixture of actions) {
      expect(validateWorkflowToolInput("work_checkpoint", fixture).ok).toBe(true);
    }

    const actionRejects: Array<Record<string, unknown>> = [
      { action: "start" },
      { action: "register" },
      { action: "authorize", runId: "run-1", authorityId: "a", messageId: "m" },
      {
        action: "authorize",
        runId: "run-1",
        authorityId: "a",
        messageId: "m",
        stages: ["implementation"],
        reservedStops: ["verificaton"],
      },
      { action: "recover", runId: "run-1", checkpointId: "C-1", recoveryId: "r" },
    ];
    for (const fixture of actionRejects) {
      expect(validateWorkflowToolInput("work_checkpoint", fixture).ok).toBe(false);
    }
  });

  test("contracts reject unknown nested keys without filtering them", () => {
    const open = contractBy("work_item_open").safeParse({
      items: [
        {
          key: "k",
          title: "T",
          mode: "implementation",
          requiredReviewers: ["spec"],
          typo: true,
        },
      ],
    });
    expect(open.success).toBe(false);
    if (open.success) return;
    expect(open.issues.some((issue) => issue.path === "items[0].typo")).toBe(true);

    const checkpoint = contractBy("work_checkpoint").safeParse({
      action: "start",
      runId: "run-1",
      checkpointId: "C-1",
      nestedUnknown: { deep: 1 },
    });
    expect(checkpoint.success).toBe(false);
    if (checkpoint.success) return;
    expect(checkpoint.issues.some((issue) => issue.path === "nestedUnknown")).toBe(true);
  });

  test("workflowToolContracts covers exactly the five registered tools", () => {
    expect(workflowToolContracts.map((contract) => contract.toolId)).toEqual([
      "work_item_open",
      "work_item_list",
      "work_item_close",
      "work_item_decide",
      "work_checkpoint",
    ]);
    for (const contract of workflowToolContracts) {
      expect(contract.description.length).toBeGreaterThan(0);
      expect(contract.registeredArgs).toBeTypeOf("object");
    }
  });
});
