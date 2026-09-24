// FILE: scripts/check-tool-contracts.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Prove the tool-contract completeness gate fails on independent mutations: a fake owned tool in a new plugin, a dynamic registration, a new schema-only or dispatcher-only action, a missing positive/negative/result fixture, an opaque known object, a changed default, and an altered generated reference; and that the real repository inputs pass.
//   SCOPE: Pure checker functions over in-memory source maps and catalog mutations; no repository source is written and no plugin factory is executed.
//   DEPENDS: [bun:test, scripts/check-tool-contracts, src/lib/agent-tool-catalog.ts]
//   LINKS: [M-AGENT-TOOL-CONTRACT, V-M-AGENT-TOOL-CONTRACT]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   repoRoot - Repository root used for the real-input checks.
//   realSources - Real plugin sources loaded once for the repository-input checks.
//   entryById - Catalog entry lookup that throws when a tool is missing.
//   source - Build an in-memory SourceFile for a path and content.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-008 - Initial self-mutation coverage for registration census, vocabularies, dispatch branches, fixtures, defaults, opaque structures, and reference currency.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_TOOL_CATALOG_TOOL_IDS,
  agentToolCatalog,
  renderToolContractsReference,
  type AgentToolCatalogEntry,
} from "../src/lib/agent-tool-catalog.js";
import {
  checkCatalogDefaults,
  checkClosedInputs,
  checkDispatchBranches,
  checkBranchNegatives,
  checkNegativeCoverage,
  checkOperationCoverage,
  checkVocabularyDeclarations,
  collectMemberLiterals,
  compareCatalogVocabularies,
  compareRegistrationCensus,
  extractToolRegistrations,
  loadPluginSources,
  referenceCurrencyFailure,
  resolvePluginEntryPoints,
  runToolContractCheck,
  validateCatalogResults,
  type SourceFile,
} from "./check-tool-contracts.ts";

const repoRoot = process.cwd();
const realSources = loadPluginSources(repoRoot);

function entryById(toolId: string): AgentToolCatalogEntry {
  const entry = agentToolCatalog.find((candidate) => candidate.toolId === toolId);
  if (!entry) throw new Error(`missing catalog entry ${toolId}`);
  return entry;
}

function source(path: string, content: string): SourceFile {
  return { path, content };
}

describe("registration census", () => {
  test("finds tool maps and fails on a fake tool in a new plugin", () => {
    const census = extractToolRegistrations([
      source(
        "src/plugins/new-plugin/index.ts",
        "export const NewPlugin = async () => ({ tool: { new_tool: { description: 'x', args: {}, execute: async () => '' } } });",
      ),
    ]);
    expect(census.toolIds).toEqual(["new_tool"]);
    const failures = compareRegistrationCensus(census, AGENT_TOOL_CATALOG_TOOL_IDS);
    expect(failures.some((failure) => failure.includes("new_tool"))).toBe(true);
  });

  test("fails closed on a dynamic registration in a plugin return object", () => {
    const census = extractToolRegistrations([
      source(
        "src/plugins/new-plugin/index.ts",
        "export const NewPlugin = async () => ({ tool: buildTools() });",
      ),
    ]);
    expect(census.dynamic.length).toBe(1);
    const failures = compareRegistrationCensus(census, AGENT_TOOL_CATALOG_TOOL_IDS);
    expect(failures.some((failure) => failure.includes("unclassified dynamic"))).toBe(true);
  });

  test("covers default-export, lowercase, computed, and aliased factory registrations", () => {
    const cases: Array<{ path: string; content: string; ids: string[] }> = [
      {
        path: "src/plugins/new-default/index.ts",
        content:
          "const registrations = makeTools(); export default async () => ({ tool: registrations });",
        ids: [],
      },
      {
        path: "src/plugins/new-default/index.ts",
        content: 'export default async () => ({ ["tool"]: { uncovered_tool: {} } });',
        ids: ["uncovered_tool"],
      },
      {
        path: "src/plugins/lowercase/index.ts",
        content: "export const plugin = async () => ({ tool: { low_tool: {} } });",
        ids: ["low_tool"],
      },
      {
        path: "src/plugins/alias/index.ts",
        content: "const make = async () => ({ tool: { alias_tool: {} } }); export default make;",
        ids: ["alias_tool"],
      },
      {
        path: "src/plugins/typed/index.ts",
        content:
          "export const TypedPlugin = async () => ({ tool: { typed_tool: {} } });",
        ids: ["typed_tool"],
      },
    ];
    for (const testCase of cases) {
      const census = extractToolRegistrations([source(testCase.path, testCase.content)]);
      expect(census.toolIds, testCase.content).toEqual(testCase.ids);
    }
    const dynamic = extractToolRegistrations([
      source(
        "src/plugins/new-default/index.ts",
        "const registrations = makeTools(); export default async () => ({ tool: registrations });",
      ),
    ]);
    expect(dynamic.dynamic.some((entry) => entry.includes("registrations"))).toBe(true);
    const failures = compareRegistrationCensus(dynamic, AGENT_TOOL_CATALOG_TOOL_IDS);
    expect(failures.some((failure) => failure.includes("unclassified dynamic"))).toBe(true);
  });

  test("ignores unrelated object fields named tool", () => {
    const census = extractToolRegistrations([
      source(
        "src/plugins/guardian/index.ts",
        "export const GuardianPlugin = async () => ({ event: async () => ({ related: { tool: event.tool } }) });",
      ),
    ]);
    expect(census.toolIds).toEqual([]);
    expect(census.dynamic).toEqual([]);
  });

  test("the real plugin sources register exactly the nine catalog tools", () => {
    const census = extractToolRegistrations(realSources);
    expect(census.toolIds).toEqual([...AGENT_TOOL_CATALOG_TOOL_IDS]);
    expect(census.dynamic).toEqual([]);
    expect(compareRegistrationCensus(census, AGENT_TOOL_CATALOG_TOOL_IDS)).toEqual([]);
  });
});

describe("schema and dispatcher branch coverage", () => {
  test("a schema-only new action is visible", () => {
    const reader = (key: string): readonly string[] | undefined =>
      key === "work_checkpoint.action"
        ? [...(entryById("work_checkpoint").vocabularies[0]?.values ?? []), "new_action"]
        : undefined;
    const failures = compareCatalogVocabularies(agentToolCatalog, reader);
    expect(failures.some((failure) => failure.includes("new_action"))).toBe(true);
  });

  test("a dispatcher-only new action is visible", () => {
    const fakeTooling = source(
      "src/plugins/workflow/tooling.ts",
      'function run(action: string) { switch (action) { case "start": return 1; case "new_action": return 2; } return 0; }',
    );
    const result = checkDispatchBranches(
      agentToolCatalog,
      [fakeTooling],
      [
        {
          vocabularyKey: "work_checkpoint.action",
          file: "src/plugins/workflow/tooling.ts",
          member: "action",
        },
      ],
    );
    expect(result.failures.some((failure) => failure.includes("new_action"))).toBe(true);
  });

  test("collectMemberLiterals extracts switch and equality literals for the member", () => {
    const literals = collectMemberLiterals(
      source(
        "x.ts",
        'function f(args) { if (args.decision === "rework") return 1; switch (args.action) { case "start": return 2; case "verify": return 3; } }',
      ),
      "action",
    );
    expect(literals).toEqual(["start", "verify"]);
  });

  test("the real dispatch sources declare only catalog branches", () => {
    const result = checkDispatchBranches(agentToolCatalog, realSources);
    expect(result.failures).toEqual([]);
    expect(result.literals.length).toBeGreaterThan(10);
  });
});

describe("fixture omissions and mutations", () => {
  test("a missing positive fixture fails coverage", () => {
    const entry = entryById("work_checkpoint");
    const mutated: AgentToolCatalogEntry = {
      ...entry,
      operations: entry.operations.filter((operation) => operation.covers?.action !== "recover"),
    };
    const failures = checkOperationCoverage([mutated]);
    expect(failures.some((failure) => failure.includes("action=recover"))).toBe(true);
  });

  test("a missing field-targeted negative fixture fails coverage", () => {
    const entry = entryById("web_search");
    const mutated: AgentToolCatalogEntry = {
      ...entry,
      operations: entry.operations.filter(
        (operation) => operation.id !== "web_search:reject-unknown-freshness",
      ),
    };
    const failures = checkNegativeCoverage([mutated]);
    expect(failures.some((failure) => failure.includes("freshness"))).toBe(true);

    const checkpoint = entryById("work_checkpoint");
    const withoutActionNegative: AgentToolCatalogEntry = {
      ...checkpoint,
      operations: checkpoint.operations.filter(
        (operation) => operation.id !== "work_checkpoint:reject-unsupported-action",
      ),
    };
    expect(
      checkNegativeCoverage([withoutActionNegative]).some((failure) =>
        failure.includes("action"),
      ),
    ).toBe(true);
  });

  test("a falsified covers claim fails operation coverage", () => {
    const entry = entryById("work_checkpoint");
    const mutated: AgentToolCatalogEntry = {
      ...entry,
      operations: entry.operations.map((operation) =>
        operation.covers?.action === "start"
          ? { ...operation, input: { action: "register", planPath: ".vvoc/specs/x/plan.xml" } }
          : operation,
      ),
    };
    const failures = checkOperationCoverage([mutated]);
    expect(failures.some((failure) => failure.includes("action=start"))).toBe(true);
  });

  test("a removed vocabulary declaration is detected against the registered reader", () => {
    const entry = entryById("work_checkpoint");
    const mutated: AgentToolCatalogEntry = {
      ...entry,
      vocabularies: [],
    };
    const failures = checkVocabularyDeclarations([mutated], ["work_checkpoint.action"]);
    expect(failures.some((failure) => failure.includes("work_checkpoint.action"))).toBe(true);
  });

  test("a missing nested result variant leaves its provider branch uncovered", () => {
    const entry = entryById("web_fetch");
    const mutated: AgentToolCatalogEntry = {
      ...entry,
      results: entry.results.filter((variant) => variant.id !== "web_fetch:text-zai"),
    };
    const failures = validateCatalogResults([mutated]);
    expect(failures.some((failure) => failure.includes("uncovered result branch"))).toBe(true);
  });

  test("a missing array-element batch family fails nested boolean-union coverage", () => {
    const entry = entryById("work_item_open");
    const mutated: AgentToolCatalogEntry = {
      ...entry,
      results: entry.results.filter((variant) => variant.id !== "work_item_open:batch-failure"),
    };
    const failures = validateCatalogResults([mutated]);
    expect(failures.some((failure) => failure.includes("items[].union[1]"))).toBe(true);
  });

  test("removing a branch's only negatives fails independently of reference staleness", async () => {
    const entries = agentToolCatalog.map((entry) =>
      entry.toolId === "work_checkpoint"
        ? {
            ...entry,
            operations: entry.operations.filter(
              (operation) => !(operation.expect === "reject" && operation.input.action === "recover"),
            ),
          }
        : entry,
    );
    const result = await runToolContractCheck({
      repoRoot,
      entries,
      referenceMarkdown: renderToolContractsReference(entries),
    });
    expect(result.ok).toBe(false);
    expect(result.failures.some((failure) => failure.includes("action=string:recover"))).toBe(true);
  });

  test("a new action with only a positive fixture fails branch coverage", () => {
    const base = entryById("work_checkpoint");
    const sealInput = { action: "seal" };
    const mutated: AgentToolCatalogEntry = {
      ...base,
      vocabularies: [
        { field: "action", values: [...(base.vocabularies[0]?.values ?? []), "seal"] },
      ],
      operations: [
        ...base.operations,
        {
          id: "work_checkpoint:seal",
          label: "seal (fictional new action)",
          expect: "accept",
          input: sealInput,
          covers: { action: "seal" },
        },
      ],
      // Fictional action is accepted by the stub validator so only the missing
      // negative can fail the branch; no real schema is modified.
      validate: (raw) =>
        (raw as { action?: string } | undefined)?.action === "seal"
          ? { ok: true, data: raw }
          : base.validate(raw),
    };
    const failures = checkBranchNegatives([mutated]);
    expect(failures.some((failure) => failure.includes("action=string:seal"))).toBe(true);
  });

  test("a falsified negative association is detected", () => {
    const base = entryById("work_checkpoint");
    const mutated: AgentToolCatalogEntry = {
      ...base,
      operations: base.operations.map((operation) =>
        operation.id === "work_checkpoint:reject-verify-missing-checkpoint"
          ? { ...operation, input: { action: "bind", runId: "run-1" } }
          : operation,
      ),
    };
    const failures = checkBranchNegatives([mutated]);
    expect(failures.some((failure) => failure.includes("action=string:verify"))).toBe(true);
  });

  test("per-branch negatives are complete for the real catalog", () => {
    expect(checkBranchNegatives(agentToolCatalog)).toEqual([]);
  });

  test("a changed default fails the default check", () => {
    const entry = entryById("web_search");
    const mutated: AgentToolCatalogEntry = {
      ...entry,
      defaults: [{ field: "count", value: 9, note: "tampered" }],
    };
    const failures = checkCatalogDefaults([mutated]);
    expect(failures.some((failure) => failure.includes("count"))).toBe(true);
  });

  test("an opaque known object fails the closed-input check", () => {
    const entry = entryById("work_item_close");
    const mutated: AgentToolCatalogEntry = {
      ...entry,
      contract: {
        ...entry.contract,
        inputJsonSchema: {
          type: "object",
          additionalProperties: false,
          properties: { known: { type: "object" } },
        },
      },
    };
    const failures = checkClosedInputs([mutated]);
    expect(failures.some((failure) => failure.includes("work_item_close"))).toBe(true);
  });

  test("an open known object and an empty property schema both fail the closed-input check", () => {
    const entry = entryById("work_item_close");
    const openObject: AgentToolCatalogEntry = {
      ...entry,
      contract: {
        ...entry.contract,
        inputJsonSchema: {
          type: "object",
          additionalProperties: true,
          properties: { known: { type: "string" } },
        },
      },
    };
    expect(checkClosedInputs([openObject]).some((failure) => failure.includes("open object"))).toBe(
      true,
    );
    const emptyPayload: AgentToolCatalogEntry = {
      ...entry,
      contract: {
        ...entry.contract,
        inputJsonSchema: {
          type: "object",
          additionalProperties: false,
          properties: { payload: {} },
        },
      },
    };
    expect(
      checkClosedInputs([emptyPayload]).some((failure) => failure.includes("unconstrained schema")),
    ).toBe(true);
  });

  test("an altered generated reference fails currency", () => {
    const failures = referenceCurrencyFailure(renderToolContractsReference(), "tampered\n");
    expect(failures.length).toBe(1);
    expect(failures[0]).toContain("contracts:generate");
  });
});

describe("full runner", () => {
  test("passes on the real repository inputs", async () => {
    const result = await runToolContractCheck({ repoRoot });
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.summary.tools).toBe(9);
    expect(result.summary.fixtures).toBeGreaterThan(90);
    expect(result.summary.resultVariants).toBeGreaterThan(25);
  });

  test("fails when a dispatcher branch is injected into a real source map", async () => {
    const files = realSources.map((file) =>
      file.path === "src/plugins/workflow/tooling.ts"
        ? source(
            file.path,
            `${file.content}\nfunction injected(action: string) { switch (action) { case "new_action": return 1; } return 0; }`,
          )
        : file,
    );
    const result = await runToolContractCheck({ repoRoot, files });
    expect(result.ok).toBe(false);
    expect(result.failures.some((failure) => failure.includes("new_action"))).toBe(true);
  });

  test("plugin export entry points resolve to existing sources", () => {
    const entries = resolvePluginEntryPoints(repoRoot);
    expect(entries.length).toBeGreaterThan(5);
    for (const entry of entries) {
      expect(existsSync(join(repoRoot, entry.sourcePath))).toBe(true);
    }
  });

  test("a package-exported entry outside src/plugins is discovered through its re-export barrel", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vvoc-census-"));
    try {
      await mkdir(join(dir, "src", "extra"), { recursive: true });
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
          exports: { "./plugins/extra": { import: "./dist/extra/index.js" } },
        }),
      );
      await writeFile(
        join(dir, "src", "extra", "index.ts"),
        'export { ExtraPlugin } from "./factory.js";\n',
      );
      await writeFile(
        join(dir, "src", "extra", "factory.ts"),
        "export const ExtraPlugin = async () => ({ tool: { extra_tool: {} } });\n",
      );
      const resolved = resolvePluginEntryPoints(dir);
      expect(resolved).toEqual([
        { subpath: "./plugins/extra", sourcePath: "src/extra/index.ts" },
      ]);
      const census = extractToolRegistrations(loadPluginSources(dir));
      expect(census.toolIds).toContain("extra_tool");
      const failures = compareRegistrationCensus(census, AGENT_TOOL_CATALOG_TOOL_IDS);
      expect(failures.some((failure) => failure.includes("extra_tool"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reference currency uses the injected catalog rather than the global one", async () => {
    const search = entryById("web_search");
    const mutated: AgentToolCatalogEntry = { ...search, summary: "injected-only summary" };
    const entries = agentToolCatalog.map((entry) =>
      entry.toolId === "web_search" ? mutated : entry,
    );
    const result = await runToolContractCheck({
      repoRoot,
      entries,
      referenceMarkdown: renderToolContractsReference(entries),
    });
    expect(result.failures).toEqual([]);
  });
});
