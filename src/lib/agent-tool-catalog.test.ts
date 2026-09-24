// FILE: src/lib/agent-tool-catalog.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the nine-tool catalog surface: exact tool coverage, fixtures executed through the actual exported validators and result schemas, vocabulary coverage by positive operations, closed input schemas, execute-time defaults, deterministic reference generation, and recorded baseline provenance.
//   SCOPE: Pure catalog data and generated reference only; no plugin lifecycle, host process, store, or filesystem.
//   DEPENDS: [bun:test, src/lib/agent-tool-catalog.ts, src/plugins/workflow/input-validation.ts, src/plugins/hashline-edit/schemas.ts, src/plugins/web-tools/schemas.ts]
//   LINKS: [M-AGENT-TOOL-CONTRACT, V-M-AGENT-TOOL-CONTRACT]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   EXPECTED_TOOL_IDS - The nine owned tool ids the catalog must cover exactly.
//   [test scenarios] - Catalog coverage, fixture, and reference behavior is expressed through module-level tests.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-008 - Initial catalog coverage, real-validator fixture, closed-schema, reference-determinism, and baseline-provenance tests.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import {
  AGENT_TOOL_CATALOG_TOOL_IDS,
  CONTRACT_REFERENCE_PACKAGE_PATH,
  CONTRACT_SIZE_BASELINE,
  agentToolCatalog,
  collectResultBranches,
  findOpaqueInputObjects,
  measureCatalogContractSize,
  renderToolContractsReference,
  resultCoverageGaps,
  validateAgentToolCatalog,
} from "./agent-tool-catalog.js";
import { workflowToolContracts } from "../plugins/workflow/input-validation.js";
import { editToolContracts } from "../plugins/hashline-edit/schemas.js";
import { webToolContracts } from "../plugins/web-tools/schemas.js";

const EXPECTED_TOOL_IDS = [
  "hashline_edit",
  "str_replace_editor",
  "web_fetch",
  "web_search",
  "work_checkpoint",
  "work_item_close",
  "work_item_decide",
  "work_item_list",
  "work_item_open",
];

describe("catalog coverage", () => {
  test("covers exactly the nine owned tools", () => {
    expect(AGENT_TOOL_CATALOG_TOOL_IDS).toEqual(EXPECTED_TOOL_IDS);
    expect(agentToolCatalog.map((entry) => entry.toolId).sort()).toEqual(EXPECTED_TOOL_IDS);
  });

  test("every descriptor contract is represented exactly once", () => {
    const descriptorIds = [
      ...workflowToolContracts.map((contract) => contract.toolId),
      ...editToolContracts.map((contract) => contract.toolId),
      ...webToolContracts.map((contract) => contract.toolId),
    ].sort();
    expect(AGENT_TOOL_CATALOG_TOOL_IDS).toEqual(descriptorIds);
    for (const entry of agentToolCatalog) {
      const descriptor = [...workflowToolContracts, ...editToolContracts, ...webToolContracts].find(
        (contract) => contract.toolId === entry.toolId,
      );
      if (!descriptor) throw new Error(`no descriptor contract for ${entry.toolId}`);
      expect(entry.contract).toBe(descriptor);
      expect(entry.contract.description.length).toBeGreaterThan(0);
    }
  });
});

describe("fixtures executed through the actual validators and result schemas", () => {
  test("every positive and negative operation fixture agrees with its real validator", () => {
    const outcome = validateAgentToolCatalog();
    expect(outcome.failures).toEqual([]);
    expect(outcome.ok).toBe(true);
    expect(outcome.checked).toBeGreaterThan(100);
  });

  test("the validators are actually exercised, not just metadata inspected", () => {
    const open = agentToolCatalog.find((entry) => entry.toolId === "work_item_open");
    expect(open).toBeDefined();
    // A structurally invalid mutation of an accepted fixture must be rejected by
    // the same validator the fixture runner uses.
    expect(open?.validate({ items: [] }).ok).toBe(false);
    const search = agentToolCatalog.find((entry) => entry.toolId === "web_search");
    expect(search?.validate({ query: "vvoc", count: 0 }).ok).toBe(false);
  });

  test("every nested result-schema union branch has at least one catalog fixture", () => {
    expect(resultCoverageGaps()).toEqual([]);
  });

  test("removing one provider result family leaves its nested branch uncovered", () => {
    const fetch = agentToolCatalog.find((entry) => entry.toolId === "web_fetch");
    expect(fetch).toBeDefined();
    const withoutZai = {
      ...fetch!,
      results: fetch!.results.filter((variant) => variant.id !== "web_fetch:text-zai"),
    };
    expect(resultCoverageGaps([withoutZai]).some((gap) => gap.includes("metadata.union[2]"))).toBe(
      true,
    );
  });

  test("result branch traversal terminates on a self-referential schema", () => {
    const node = { safeParse: () => ({ success: false }), shape: {} } as {
      safeParse: () => { success: boolean };
      shape: Record<string, unknown>;
    };
    node.shape.self = node;
    expect(() => collectResultBranches(node)).not.toThrow();
    expect(collectResultBranches(node)).toEqual([]);
  });

  test("array-element item union is traversed and covered by both batch fixtures", () => {
    const open = agentToolCatalog.find((entry) => entry.toolId === "work_item_open");
    expect(open).toBeDefined();
    const resultIds = open!.results.map((variant) => variant.id);
    expect(resultIds).toContain("work_item_open:batch");
    expect(resultIds).toContain("work_item_open:batch-failure");
    expect(resultCoverageGaps()).toEqual([]);
  });

  test("hashline_edit result schema honestly separates text/Error delivery and metadata", () => {
    const hashline = agentToolCatalog.find((entry) => entry.toolId === "hashline_edit");
    expect(hashline).toBeDefined();
    const text = hashline!.results.find((variant) => variant.id === "hashline_edit:text-error");
    const metadata = hashline!.results.find(
      (variant) => variant.id === "hashline_edit:success-metadata",
    );
    const schema = hashline!.resultSchema as unknown as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(schema.safeParse(text?.fixture).success).toBe(true);
    expect(schema.safeParse(metadata?.fixture).success).toBe(true);
    // The metadata envelope is not accepted as the registered text return value.
    const textSchema = (hashline!.resultSchema as unknown as { options?: readonly unknown[] })
      .options?.[0] as { safeParse: (v: unknown) => { success: boolean } };
    expect(textSchema.safeParse(metadata?.fixture).success).toBe(false);
  });

  test("every declared vocabulary value is covered by a positive operation", () => {
    for (const entry of agentToolCatalog) {
      for (const vocabulary of entry.vocabularies) {
        for (const value of vocabulary.values) {
          const covered = entry.operations.some(
            (operation) =>
              operation.expect === "accept" && operation.covers?.[vocabulary.field] === value,
          );
          expect(
            covered,
            `${entry.toolId} ${vocabulary.field}=${value} has no positive fixture`,
          ).toBe(true);
        }
      }
    }
  });

  test("every tool has an unknown-key negative fixture", () => {
    for (const entry of agentToolCatalog) {
      const hasUnknownKey = entry.operations.some(
        (operation) => operation.expect === "reject" && operation.tags?.includes("unknown_key"),
      );
      expect(hasUnknownKey, `${entry.toolId} has no unknown_key fixture`).toBe(true);
    }
  });
});

describe("closed input schemas and defaults", () => {
  test("no published input schema exposes an arbitrary known object", () => {
    for (const entry of agentToolCatalog) {
      expect(findOpaqueInputObjects(entry.contract.inputJsonSchema), entry.toolId).toEqual([]);
    }
  });

  test("the opaque scanner rejects empty, open, union, array, and unresolved-ref nodes", () => {
    expect(
      findOpaqueInputObjects({
        type: "object",
        additionalProperties: false,
        properties: { payload: {} },
      }),
    ).toEqual(["(root).payload: unconstrained schema"]);
    expect(
      findOpaqueInputObjects({
        type: "object",
        properties: { known: {} },
        additionalProperties: true,
      }),
    ).toContain("(root): open object (additionalProperties must be false)");
    expect(
      findOpaqueInputObjects({
        type: "object",
        additionalProperties: false,
        properties: {
          branch: {
            anyOf: [
              { type: "string" },
              { type: "object", additionalProperties: false, properties: {} },
            ],
          },
        },
      }),
    ).toEqual([]);
    expect(
      findOpaqueInputObjects({
        type: "object",
        additionalProperties: false,
        properties: { list: { type: "array", items: {} } },
      }),
    ).toEqual(["(root).list[]: unconstrained schema"]);
    expect(
      findOpaqueInputObjects({
        type: "object",
        additionalProperties: false,
        properties: { ref: { $ref: "#/definitions/open" } },
        definitions: { open: { type: "object", properties: { a: { type: "string" } } } },
      }),
    ).toEqual(["(root).ref: open object (additionalProperties must be false; none was declared)"]);
    expect(
      findOpaqueInputObjects({
        type: "object",
        additionalProperties: false,
        properties: { ref: { $ref: "#/definitions/closed" } },
        definitions: {
          closed: {
            type: "object",
            additionalProperties: false,
            properties: { a: { type: "string" } },
          },
        },
      }),
    ).toEqual([]);
    expect(
      findOpaqueInputObjects({
        type: "object",
        additionalProperties: false,
        properties: { ref: { $ref: "#/definitions/missing" } },
      }),
    ).toEqual(['(root).ref: unresolvable $ref "#/definitions/missing"']);
  });

  test("declared defaults are applied by the actual validators", () => {
    const search = agentToolCatalog.find((entry) => entry.toolId === "web_search");
    const searchDefault = search?.defaults.find((entryDefault) => entryDefault.field === "count");
    expect(searchDefault?.value).toBe(8);
    const parsedSearch = search?.validate({ query: "vvoc" });
    expect(parsedSearch?.ok).toBe(true);
    expect((parsedSearch?.data as { count?: number } | undefined)?.count).toBe(8);

    const fetch = agentToolCatalog.find((entry) => entry.toolId === "web_fetch");
    const parsedFetch = fetch?.validate({ url: "https://example.test/page" });
    expect(parsedFetch?.ok).toBe(true);
    expect((parsedFetch?.data as { format?: string } | undefined)?.format).toBe("markdown");
    expect((parsedFetch?.data as { timeout?: number } | undefined)?.timeout).toBe(30);
  });
});

describe("generated reference and baseline", () => {
  test("the reference is deterministic and identifies the loaded contract", () => {
    const first = renderToolContractsReference();
    const second = renderToolContractsReference();
    expect(first).toBe(second);
    expect(first).toContain("Tool contract revision:");
    expect(first).toContain(CONTRACT_REFERENCE_PACKAGE_PATH);
    expect(first).toContain("not authorization");
    expect(first).toContain("not a universal sandbox");
    expect(first).not.toContain(process.cwd());
    // No fixed sample work-item instruction is published.
    expect(first).not.toContain("VVOC_WORK_ITEM_ID: wi-1");
    for (const entry of agentToolCatalog) {
      expect(first).toContain(`### \`${entry.toolId}\``);
    }
  });

  test("checked examples derive their outcome from the actual validator, not metadata labels", () => {
    const close = agentToolCatalog.find((entry) => entry.toolId === "work_item_close");
    expect(close).toBeDefined();
    const flipped = {
      ...close!,
      operations: close!.operations.map((operation) =>
        operation.id === "work_item_close:reject-unknown-key"
          ? { ...operation, expect: "accept" as const }
          : operation,
      ),
    };
    const reference = renderToolContractsReference([flipped]);
    // The validator rejects the fixture, so the rendered outcome is reject even
    // though the (tampered) metadata label claims accept.
    expect(reference).toContain("- `work_item_close:reject-unknown-key` (reject):");
  });

  test("the current measurement matches the catalog descriptions and schemas", () => {
    const size = measureCatalogContractSize();
    let descriptionBytes = 0;
    let inputSchemaBytes = 0;
    for (const entry of agentToolCatalog) {
      descriptionBytes += Buffer.byteLength(entry.contract.description, "utf8");
      inputSchemaBytes += Buffer.byteLength(JSON.stringify(entry.contract.inputJsonSchema), "utf8");
    }
    expect(size.descriptionBytes).toBe(descriptionBytes);
    expect(size.inputSchemaBytes).toBe(inputSchemaBytes);
    expect(size.totalBytes).toBe(descriptionBytes + inputSchemaBytes);
  });

  test("the baseline records provenance and compares against a stable measurement", () => {
    expect(CONTRACT_SIZE_BASELINE.provenance.method).toBe("source-extraction");
    expect(CONTRACT_SIZE_BASELINE.provenance.commit.length).toBeGreaterThan(0);
    expect(CONTRACT_SIZE_BASELINE.provenance.sdk).toContain("1.18.2");
    expect(CONTRACT_SIZE_BASELINE.before.descriptionBytes).toBeGreaterThan(0);
    expect(CONTRACT_SIZE_BASELINE.before.inputSchemaBytes).toBeGreaterThan(0);
    const reference = renderToolContractsReference();
    expect(reference).toContain(String(CONTRACT_SIZE_BASELINE.before.inputSchemaBytes));
    expect(reference).toContain(CONTRACT_SIZE_BASELINE.provenance.commit);
  });
});
