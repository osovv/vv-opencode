// FILE: scripts/check-tool-contracts-host.test.ts
// VERSION: 1.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify pure host-runner helpers for both routes: environment allowlist, host version gating, owned-root cleanup, fail-closed journal/stdout/harness parsing, probe and full-matrix observation evaluation, exact built-descriptor projection comparison, cohort/wire-definition normalization, composing-wrapper generation, isolated config builders, evidence lifecycle helpers, fingerprint drift, and compatibility-evidence assembly.
//   SCOPE: Pure helper tests with an injected synthetic built-contract context only; the live routes run via `bun scripts/check-tool-contracts-host.ts --probe` and `bun run contracts:host`.
//   DEPENDS: [bun:test, scripts/check-tool-contracts-host, src/lib/vvoc-config.ts]
//   LINKS: [M-AGENT-TOOL-CONTRACT]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   PATHS - Fixed synthetic HOME/XDG/OpenCode/tmp paths used by environment-builder assertions.
//   PACKAGE_IDENTITY - Expected `name@version#revision` identity string for report assertions.
//   goodObservations - Fixture observations that should pass every mandatory probe assertion.
//   EvaluationInput - Observed session-result payload without the derived pass/fail/case fields.
//   SYNTHETIC_TOOL_IDS - Three representative owned tool ids used by the synthetic built context.
//   syntheticDescriptor - Synthetic built descriptor used to exercise projection comparison.
//   syntheticBuilt - Synthetic built-contract context injected into evaluation tests.
//   BUILT - Shared default synthetic built-contract context.
//   observedDefinition - Normalized model-visible definition derived from a synthetic descriptor.
//   unitSpec - Minimal full-matrix session spec used to isolate evaluation assertions.
//   defaultJournal - Synthetic harness journal containing owned producer verdicts.
//   defaultToolParts - Synthetic host tool_use parts derived from a session spec's steps.
//   unitResult - Minimal observed session result matching unitSpec.
//   realpathSafe - Resolve a path with realpath, falling back to the input on failure.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-009 recovery attempt3 - Added dependency-closure and pinned-manifest tests: cycle/re-export discovery termination on owned tmp fixtures, `.js`→`.ts` and raw-query resolution, real-repo closure now including the previously omitted behavior-critical workflow/hashline/web files without an exact-N count, specifier extraction, tmp fingerprint drift for changed helper/schema/package, and matching/absent/mismatched @opencode-ai manifest gating. Prior correction: synthetic built-context evaluation, exact projection drift, hidden-editor, loaded-identity, owned semantics, malformed-body, evidence lifecycle, and fingerprint drift.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  AGENT_TOOL_CONTRACT_REVISION,
  PACKAGE_NAME,
  PACKAGE_VERSION,
} from "../src/lib/agent-tool-contract.ts";
import { parseVvocConfigText } from "../src/lib/vvoc-config.ts";
import {
  ALLOWED_ENV_KEYS,
  CLOSURE_ROOTS,
  CONTRACTS_HOST_EVIDENCE_VERSION,
  EXTRA_FINGERPRINT_PATHS,
  HOST_COHORTS,
  MINIMUM_SUPPORTED_HOST_VERSION,
  OWNED_TOOL_IDS,
  PROBE_CALL_SCRIPT,
  PROBE_SCRATCH_PARENT,
  PROBE_TOOL_ID,
  SUPPORTED_LIVE_HOST_VERSION,
  SYNTHETIC_EXA_API_KEY,
  TOOL_CONTRACT_REFERENCE_SUFFIX,
  assignedRunId,
  assignedWorkItemId,
  buildCohortHostConfig,
  buildHostEvidenceDocument,
  buildHostVvocConfig,
  buildProbeEnv,
  buildUnexercisedMatrix,
  checkPinnedManifests,
  cleanupProbeRoot,
  collectLocalImportClosure,
  compareProjection,
  countToolResults,
  describeDefinition,
  evaluateHostSession,
  evaluateProbeObservations,
  extractRelativeSpecifiers,
  fingerprintAll,
  fingerprintDrift,
  flattenAnthropicText,
  flattenOpenAIText,
  formatProbeReport,
  generateHostHarnessPluginSource,
  generateProbePluginSource,
  hostSessionSpecs,
  invalidateEvidence,
  isChildRequest,
  isOwnedProbeRoot,
  isSupportedLiveHostVersion,
  normalizeAnthropicDefinitions,
  normalizeOpenAIDefinitions,
  parseHarnessJournalText,
  parseHostVersion,
  parseJournalText,
  parseRunStdout,
  readManifestVersion,
  readPinnedExpectations,
  resolveEvidenceTarget,
  subsetMatch,
  uniqueSorted,
  writeEvidenceIfAllowed,
  type BuiltContractContext,
  type BuiltToolDescriptor,
  type HarnessJournalEntry,
  type HostSessionResult,
  type HostSessionSpec,
  type NormalizedToolDefinition,
  type ProbeObservations,
  type ToolUsePart,
} from "./check-tool-contracts-host.ts";

const PATHS = {
  home: "/tmp/probe/home",
  xdgConfig: "/tmp/probe/xdg-config",
  xdgData: "/tmp/probe/xdg-data",
  xdgCache: "/tmp/probe/xdg-cache",
  opencodeConfig: "/tmp/probe/harness/opencode.json",
  tmp: "/tmp/probe/tmp",
};

const PACKAGE_IDENTITY = `${PACKAGE_NAME}@${PACKAGE_VERSION}#${AGENT_TOOL_CONTRACT_REVISION}`;

function goodObservations(): ProbeObservations {
  const parameters = {
    type: "object",
    properties: {
      label: { type: "string", description: "Echo label" },
      mode: { type: "string", enum: ["quiet", "loud"], description: "Echo mode" },
      nested: {
        type: "object",
        properties: { depth: { type: "integer" } },
        additionalProperties: false,
        description: "Nested options",
      },
    },
    required: ["label"],
    additionalProperties: false,
  };
  return {
    hostVersion: SUPPORTED_LIVE_HOST_VERSION,
    outbound: [
      {
        model: "probe-mini",
        messages: [
          { role: "system", content: "You are opencode" },
          { role: "user", content: "hi" },
          { role: "assistant", content: "" },
          { role: "tool", content: '{"ok":true,"parsed":{"mode":"quiet"}}' },
          { role: "tool", content: "INVALID_INPUT: unexpected: unrecognized key" },
          { role: "tool", content: "INVALID_INPUT: nested.tpyo: unrecognized key" },
          { role: "tool", content: "INVALID_INPUT: nested.depth: expected number" },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: PROBE_TOOL_ID,
              description:
                "VVOC contract feasibility probe tool for host boundary checks. Echo label",
              parameters,
            },
          },
        ],
      },
    ],
    toolParts: [
      {
        type: "tool",
        tool: PROBE_TOOL_ID,
        callID: "call_valid_default",
        state: { status: "completed", input: { label: "alpha" }, output: '{"mode":"quiet"}' },
      },
      {
        type: "tool",
        tool: PROBE_TOOL_ID,
        callID: "call_unknown_top",
        state: {
          status: "error",
          error: 'INVALID_INPUT: unexpected: unrecognized key "unexpected"',
        },
      },
      {
        type: "tool",
        tool: PROBE_TOOL_ID,
        callID: "call_nested_typo",
        state: { status: "error", error: "INVALID_INPUT: nested.tpyo: unrecognized key" },
      },
      {
        type: "tool",
        tool: PROBE_TOOL_ID,
        callID: "call_malformed_nested",
        state: { status: "error", error: "INVALID_INPUT: nested.depth: expected number" },
      },
    ],
    journal: [
      {
        kind: "exec",
        callID: "call_valid_default",
        rawArgs: { label: "alpha" },
        parsed: { label: "alpha", mode: "quiet" },
      },
      { kind: "reject", callID: "call_unknown_top", error: "INVALID_INPUT: unexpected" },
      { kind: "reject", callID: "call_nested_typo", error: "INVALID_INPUT: nested.tpyo" },
      { kind: "reject", callID: "call_malformed_nested", error: "INVALID_INPUT: nested.depth" },
    ],
    finalToolResultMessages: [
      '{"ok":true}',
      "INVALID_INPUT: unexpected",
      "INVALID_INPUT: nested.tpyo",
      "INVALID_INPUT: nested.depth",
    ],
    childEnvKeys: [...ALLOWED_ENV_KEYS],
    evidenceErrors: [],
    packageIdentity: PACKAGE_IDENTITY,
  };
}

describe("environment isolation helpers", () => {
  test("forwards only allowlisted keys and pins isolation including default plugins", () => {
    const env = buildProbeEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/user",
        OPENAI_API_KEY: "sk-secret",
        ANTHROPIC_API_KEY: "sk-ant",
        OPENCODE_AUTH_CONTENT: "{}",
        UNRELATED: "x",
        ...Object.fromEntries(ALLOWED_ENV_KEYS.map((key) => [key, `v-${key}`])),
      },
      PATHS,
    );
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENCODE_AUTH_CONTENT).toBeUndefined();
    expect(env.UNRELATED).toBeUndefined();
    expect(env.HOME).toBe(PATHS.home);
    expect(env.XDG_CONFIG_HOME).toBe(PATHS.xdgConfig);
    expect(env.XDG_DATA_HOME).toBe(PATHS.xdgData);
    expect(env.XDG_CACHE_HOME).toBe(PATHS.xdgCache);
    expect(env.OPENCODE_CONFIG).toBe(PATHS.opencodeConfig);
    expect(env.OPENCODE_DISABLE_MODELS_FETCH).toBe("1");
    expect(env.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBe("1");
    expect(env.OPENCODE_DISABLE_DEFAULT_PLUGINS).toBe("1");
    expect(
      Object.keys(env).every((key) => (ALLOWED_ENV_KEYS as readonly string[]).includes(key)),
    ).toBe(true);
  });

  test("allowlist never contains provider credential keys", () => {
    expect(ALLOWED_ENV_KEYS.some((key) => key.includes("API_KEY"))).toBe(false);
    expect(ALLOWED_ENV_KEYS).not.toContain("OPENCODE_AUTH_CONTENT");
    expect(ALLOWED_ENV_KEYS).not.toContain("OPENAI_API_KEY");
    expect(ALLOWED_ENV_KEYS).toContain("OPENCODE_DISABLE_DEFAULT_PLUGINS");
  });

  test("default scratch parent is under session /tmp/opencode policy", () => {
    expect(PROBE_SCRATCH_PARENT.startsWith("/tmp/opencode")).toBe(true);
  });
});

describe("host version gating", () => {
  test("parses and authorizes only the live host version", () => {
    expect(parseHostVersion("1.18.32\n")).toBe("1.18.32");
    expect(parseHostVersion("opencode 1.18.2")).toBe("1.18.2");
    expect(parseHostVersion("nope")).toBeNull();
    expect(isSupportedLiveHostVersion(SUPPORTED_LIVE_HOST_VERSION)).toBe(true);
    expect(isSupportedLiveHostVersion(MINIMUM_SUPPORTED_HOST_VERSION)).toBe(false);
    expect(isSupportedLiveHostVersion(null)).toBe(false);
    expect(isSupportedLiveHostVersion("1.19.0")).toBe(false);
  });
});

describe("owned-root cleanup safety", () => {
  test("ownership predicate requires strict containment under scratch parent", async () => {
    const base = await mkdtemp(join(await realpathSafe(tmpdir()), "vvoc-own-"));
    try {
      const owned = join(base, "tool-contracts-host-abc");
      await mkdir(owned, { recursive: true });
      expect(isOwnedProbeRoot(owned, base)).toBe(true);
      expect(isOwnedProbeRoot(base, base)).toBe(false);
      expect(isOwnedProbeRoot(join(base, ".."), base)).toBe(false);
      expect(isOwnedProbeRoot("/tmp", base)).toBe(false);
      expect(isOwnedProbeRoot(PROBE_SCRATCH_PARENT, PROBE_SCRATCH_PARENT)).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("cleanup deletes only owned root and preserves sibling sentinel (normal path)", async () => {
    const base = await mkdtemp(join(await realpathSafe(tmpdir()), "vvoc-cleanup-"));
    try {
      const sibling = join(base, "sibling-run");
      await mkdir(sibling, { recursive: true });
      const sentinelPath = join(sibling, "sentinel.txt");
      await writeFile(sentinelPath, "keep-me");
      const owned = await mkdtemp(join(base, "tool-contracts-host-"));
      await writeFile(join(owned, "owned.txt"), "owned");
      await cleanupProbeRoot(owned, base, false);
      expect(existsSync(owned)).toBe(false);
      expect(await readFile(sentinelPath, "utf8")).toBe("keep-me");
      expect(existsSync(base)).toBe(true);
      const remaining = await readdir(base);
      expect(remaining).toContain("sibling-run");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("cleanup on error path still preserves siblings and never deletes parent", async () => {
    const base = await mkdtemp(join(await realpathSafe(tmpdir()), "vvoc-err-"));
    try {
      const sibling = join(base, "unrelated");
      await mkdir(sibling, { recursive: true });
      await writeFile(join(sibling, "keep.txt"), "ok");
      const owned = await mkdtemp(join(base, "tool-contracts-host-"));
      // Simulate error-path cleanup (same call as finally).
      await cleanupProbeRoot(owned, base, false);
      expect(existsSync(owned)).toBe(false);
      expect(existsSync(join(sibling, "keep.txt"))).toBe(true);
      expect(existsSync(base)).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("refuses to delete the scratch parent or unrelated paths", async () => {
    const base = await mkdtemp(join(await realpathSafe(tmpdir()), "vvoc-refuse-"));
    try {
      await writeFile(join(base, "parent-marker.txt"), "parent");
      await cleanupProbeRoot(base, base, false);
      expect(existsSync(join(base, "parent-marker.txt"))).toBe(true);
      await cleanupProbeRoot("/tmp", base, false);
      expect(existsSync("/tmp")).toBe(true);
      const outside = join(base, "..", "outside-owned");
      await cleanupProbeRoot(outside, base, false);
      expect(existsSync(base)).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("keep retains only the owned root without broadening access", async () => {
    const base = await mkdtemp(join(await realpathSafe(tmpdir()), "vvoc-keep-"));
    try {
      const sibling = join(base, "sibling");
      await mkdir(sibling, { recursive: true });
      const owned = await mkdtemp(join(base, "tool-contracts-host-"));
      await writeFile(join(owned, "data.txt"), "retained");
      await cleanupProbeRoot(owned, base, true);
      expect(existsSync(join(owned, "data.txt"))).toBe(true);
      expect(existsSync(join(sibling))).toBe(true);
      // keep must not delete parent either
      expect(existsSync(base)).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("fail-closed evidence parsing", () => {
  test("parseJournalText accepts well-formed records with callID", () => {
    const result = parseJournalText(
      [
        JSON.stringify({
          kind: "exec",
          callID: "call_valid_default",
          rawArgs: { label: "a" },
          parsed: { label: "a", mode: "quiet" },
        }),
        JSON.stringify({
          kind: "reject",
          callID: "call_unknown_top",
          error: "INVALID_INPUT: unexpected",
        }),
        "",
      ].join("\n"),
    );
    expect(result.errors).toEqual([]);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toMatchObject({ kind: "exec", callID: "call_valid_default" });
  });

  test("parseJournalText fails closed on malformed JSON instead of dropping it", () => {
    const result = parseJournalText(
      `${JSON.stringify({ kind: "exec", rawArgs: {}, parsed: {} })}\n{"kind":"broken\n`,
    );
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("invalid JSON");
    expect(result.entries).toHaveLength(1);
  });

  test("parseJournalText fails closed on truncated/structurally invalid mandatory records", () => {
    const missingParsed = parseJournalText(`${JSON.stringify({ kind: "exec", rawArgs: {} })}\n`);
    expect(missingParsed.errors[0]).toContain("exec record missing rawArgs/parsed");
    const badReject = parseJournalText(`${JSON.stringify({ kind: "reject" })}\n`);
    expect(badReject.errors[0]).toContain("reject record missing error");
    const unknownKind = parseJournalText(`${JSON.stringify({ kind: "other" })}\n`);
    expect(unknownKind.errors[0]).toContain("unknown journal kind");
    const notObject = parseJournalText(`[1,2,3]\n`);
    expect(notObject.errors[0]).toContain("expected object record");
  });

  test("parseRunStdout accepts non-JSON host chatter as legitimate non-result events", () => {
    const result = parseRunStdout(
      [
        '{"type":"step_start","part":{}}',
        "some log line",
        '{"type":"text","part":{"type":"text","text":"ok"}}',
        "",
      ].join("\n"),
    );
    expect(result.errors).toEqual([]);
    expect(result.events).toHaveLength(2);
  });

  test("parseRunStdout fails closed on malformed JSON host records", () => {
    const result = parseRunStdout('{"type":"tool_use","part":\n');
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("malformed JSON host record");
  });

  test("parseRunStdout fails closed on tool_use events missing mandatory part/state", () => {
    const missingPart = parseRunStdout('{"type":"tool_use"}\n');
    expect(missingPart.errors[0]).toContain("malformed tool_use part");
    const missingState = parseRunStdout('{"type":"tool_use","part":{"tool":"t","callID":"c"}}\n');
    expect(missingState.errors[0]).toContain("malformed tool_use part");
    const good = parseRunStdout(
      '{"type":"tool_use","part":{"tool":"t","callID":"c","state":{"status":"error","error":"e"}}}\n',
    );
    expect(good.errors).toEqual([]);
    expect(good.events).toHaveLength(1);
  });

  test("malformed mandatory evidence cannot yield a passing evaluation", () => {
    const obs = goodObservations();
    obs.evidenceErrors = ["journal line 2: invalid JSON"];
    const evaluation = evaluateProbeObservations(obs);
    expect(evaluation.failed.some((item) => item.includes("evidence:"))).toBe(true);
    expect(evaluation.failed.length).toBeGreaterThan(0);
  });
});

describe("probe observation evaluation", () => {
  test("passes on the good fixture", () => {
    const evaluation = evaluateProbeObservations(goodObservations());
    expect(evaluation.failed).toEqual([]);
    expect(evaluation.passed.length).toBeGreaterThan(15);
  });

  test("fails when outbound definition loses enum, closed root, or label description", () => {
    const obs = goodObservations();
    const entry = obs.outbound[0]?.tools?.[0];
    if (!entry?.function) throw new Error("fixture missing function tool");
    const parameters = entry.function.parameters as Record<string, unknown>;
    const properties = parameters.properties as Record<string, Record<string, unknown>>;
    delete properties.mode;
    parameters.additionalProperties = true;
    if (properties.label) properties.label.description = "wrong";
    const evaluation = evaluateProbeObservations(obs);
    expect(evaluation.failed.some((item) => item.includes("enum"))).toBe(true);
    expect(evaluation.failed.some((item) => item.includes("closes unknown keys"))).toBe(true);
    expect(evaluation.failed.some((item) => item.includes("published label description"))).toBe(
      true,
    );
  });

  test("fails when rejected calls still executed", () => {
    const obs = goodObservations();
    obs.journal = [
      ...obs.journal,
      {
        kind: "exec",
        callID: "call_unknown_top",
        rawArgs: { label: "alpha", unexpected: "x" },
        parsed: {},
      },
    ];
    const evaluation = evaluateProbeObservations(obs);
    expect(
      evaluation.failed.some(
        (item) => item.includes("exactly one execution") || item.includes("no execute side effect"),
      ),
    ).toBe(true);
  });

  test("fails when a mandatory diagnostic call does not error or lacks exact path", () => {
    const obs = goodObservations();
    const nested = obs.toolParts.find((part) => part.callID === "call_nested_typo");
    if (nested?.state) nested.state.status = "completed";
    const evaluation = evaluateProbeObservations(obs);
    expect(evaluation.failed.some((item) => item.includes("call_nested_typo"))).toBe(true);

    const obs2 = goodObservations();
    const nested2 = obs2.toolParts.find((part) => part.callID === "call_nested_typo");
    if (nested2?.state) nested2.state.error = "INVALID_INPUT: something else";
    const evaluation2 = evaluateProbeObservations(obs2);
    expect(
      evaluation2.failed.some((item) => item.includes("exact actionable path nested.tpyo")),
    ).toBe(true);
  });

  test("fails when default was injected into raw forwarded args", () => {
    const obs = goodObservations();
    const exec = obs.journal.find((entry) => entry.kind === "exec");
    if (exec && exec.kind === "exec") {
      (exec.rawArgs as Record<string, unknown>).mode = "quiet";
    }
    const evaluation = evaluateProbeObservations(obs);
    expect(evaluation.failed.some((item) => item.includes("original raw args"))).toBe(true);
  });

  test("fails when provider credential keys leak or default plugins stay enabled", () => {
    const obs = goodObservations();
    obs.childEnvKeys = [...obs.childEnvKeys, "OPENAI_API_KEY"];
    const evaluation = evaluateProbeObservations(obs);
    expect(evaluation.failed.some((item) => item.includes("credential"))).toBe(true);

    const obs2 = goodObservations();
    obs2.childEnvKeys = obs2.childEnvKeys.filter(
      (key) => key !== "OPENCODE_DISABLE_DEFAULT_PLUGINS",
    );
    const evaluation2 = evaluateProbeObservations(obs2);
    expect(evaluation2.failed.some((item) => item.includes("default plugins"))).toBe(true);
  });

  test("fails when package identity is missing or wrong", () => {
    const obs = goodObservations();
    obs.packageIdentity = "unknown";
    const evaluation = evaluateProbeObservations(obs);
    expect(evaluation.failed.some((item) => item.includes("package identity"))).toBe(true);
  });
});

describe("report formatting", () => {
  test("lists package identity, unexercised rows, and never claims them as passed", () => {
    const matrix = buildUnexercisedMatrix();
    expect(matrix.length).toBeGreaterThan(0);
    expect(matrix.join("\n")).toContain(MINIMUM_SUPPORTED_HOST_VERSION);
    expect(matrix.join("\n")).toContain("compatibility-evidence.json");
    const evaluation = evaluateProbeObservations(goodObservations());
    const report = formatProbeReport(evaluation, goodObservations());
    expect(report).toContain("unexercised:");
    expect(report).toContain("PASS");
    expect(report).toContain(`packageIdentity=${PACKAGE_IDENTITY}`);
    expect(report).toContain(AGENT_TOOL_CONTRACT_REVISION);
    expect(report).not.toContain("compatibility-evidence.json written");
    expect(report.split("\n").length).toBeLessThan(200);
  });

  test("includes failures when observations do not pass", () => {
    const obs = goodObservations();
    obs.hostVersion = "1.0.0";
    const evaluation = evaluateProbeObservations(obs);
    const report = formatProbeReport(evaluation, obs);
    expect(report).toContain("FAIL");
    expect(report).toContain("failed=");
  });
});

describe("probe plugin generation", () => {
  test("emits a plugin that imports the real contract helper and registers the probe tool", () => {
    const source = generateProbePluginSource({
      contractModuleUrl: "file:///repo/src/lib/agent-tool-contract.ts",
      journalPath: "/tmp/journal.jsonl",
    });
    expect(source).toContain("file:///repo/src/lib/agent-tool-contract.ts");
    expect(source).toContain("createToolDefinitionAdapter");
    expect(source).toContain("createPreExecuteGuard");
    expect(source).toContain("parseOwnedToolArgs");
    expect(source).toContain("ownedToolResult");
    expect(source).toContain("callID: context.callID");
    expect(source).toContain("callID: input.callID");
    expect(source).toContain(PROBE_TOOL_ID);
    expect(source).toContain('"tool.definition"');
    expect(source).toContain('"tool.execute.before"');
    expect(source).not.toContain("workflow-contract");
    expect(source).not.toContain("agent-tool-catalog");
  });
});

describe("call script shape", () => {
  test("covers mandatory diagnostic scenarios in order with exact paths", () => {
    expect(PROBE_CALL_SCRIPT.map((call) => call.id)).toEqual([
      "call_valid_default",
      "call_unknown_top",
      "call_nested_typo",
      "call_malformed_nested",
    ]);
    const first = PROBE_CALL_SCRIPT[0];
    expect(first.args).toEqual({ label: "alpha" });
    expect("expectErrorSubstring" in first).toBe(false);
    const unknownTop = PROBE_CALL_SCRIPT[1];
    expect("expectErrorPath" in unknownTop && unknownTop.expectErrorPath).toBe("unexpected");
    const nestedTypo = PROBE_CALL_SCRIPT[2];
    expect("expectErrorPath" in nestedTypo && nestedTypo.expectErrorPath).toBe("nested.tpyo");
    const malformed = PROBE_CALL_SCRIPT[3];
    expect("expectErrorPath" in malformed && malformed.expectErrorPath).toBe("nested.depth");
  });
});

// START_BLOCK_FULL_MATRIX_TESTS
type EvaluationInput = Omit<HostSessionResult, "passed" | "failed" | "cases">;

const SYNTHETIC_TOOL_IDS = ["web_search", "web_fetch", "work_checkpoint"] as const;

function syntheticDescriptor(toolId: string): BuiltToolDescriptor {
  const properties: Record<string, unknown> = {};
  if (toolId === "web_search") {
    properties.count = { type: "integer", minimum: 1, maximum: 20, default: 8 };
  }
  if (toolId === "web_fetch") {
    properties.timeout = { type: "integer", minimum: 1, maximum: 120, default: 30 };
  }
  if (toolId === "work_checkpoint") {
    properties.action = {
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
    };
  }
  return {
    toolId,
    description: `${toolId} description`,
    inputJsonSchema: { type: "object", properties, additionalProperties: false },
  };
}

function syntheticBuilt(overrides: Partial<BuiltContractContext> = {}): BuiltContractContext {
  return {
    origin: "synthetic",
    identity: {
      name: PACKAGE_NAME,
      version: PACKAGE_VERSION,
      revision: AGENT_TOOL_CONTRACT_REVISION,
    },
    descriptors: SYNTHETIC_TOOL_IDS.map(syntheticDescriptor),
    searchDefaultCount: 8,
    fetchDefaultTimeoutSeconds: 30,
    validateWorkflowResult: () => ({ ok: true }),
    validateHashlineMetadata: () => ({ ok: true }),
    validateStrEditorMetadata: () => ({ ok: true }),
    validateWebResult: () => ({ ok: true }),
    ...overrides,
  };
}

const BUILT = syntheticBuilt();

function observedDefinition(toolId: string): NormalizedToolDefinition {
  const descriptor = syntheticDescriptor(toolId);
  return {
    name: descriptor.toolId,
    description: descriptor.description,
    parameters: descriptor.inputJsonSchema,
  };
}

function unitSpec(overrides: Partial<HostSessionSpec> = {}): HostSessionSpec {
  return {
    id: "unit",
    cohortId: HOST_COHORTS[0]!.id,
    prompt: "",
    workspaceFiles: {},
    steps: [
      {
        id: "ok",
        tool: "web_search",
        expect: "completed",
        buildArgs: () => ({}),
        outputIncludes: ["ok"],
      },
    ],
    expectCleanWorkflowState: false,
    expectNoWebDispatch: false,
    unchangedFiles: [],
    expectedToolNames: [...SYNTHETIC_TOOL_IDS],
    visibleEditorTool: "str_replace_editor",
    expectSearchDefaultCount: false,
    doneText: "",
    ...overrides,
  };
}

function defaultJournal(spec: HostSessionSpec): HarnessJournalEntry[] {
  const entries: HarnessJournalEntry[] = [];
  for (const step of spec.steps) {
    if (step.expect === "completed") {
      entries.push({
        kind: "exec",
        tool: step.tool,
        callID: `call-${step.id}`,
        args: {},
        producerContract: "ok",
        ownedResult: {
          title: "t",
          output: "ok",
          metadata: {},
          attachments: [{ type: "file", mime: "image/png", url: "data:image/png;base64,AA==" }],
        },
      });
    } else if ((step.rejectionLevel ?? "hook") === "hook") {
      entries.push({
        kind: "reject",
        tool: step.tool,
        callID: `call-${step.id}`,
        error: `INVALID_INPUT: ${step.expectDiagnostic?.path ?? ""}`,
      });
    }
  }
  return entries;
}

function defaultToolParts(
  spec: HostSessionSpec,
  outputByStep: Record<string, string> = {},
  errorByStep: Record<string, string> = {},
): ToolUsePart[] {
  return spec.steps.map((step) => ({
    tool: step.tool,
    callID: `call-${step.id}`,
    state:
      step.expect === "completed"
        ? { status: "completed", output: outputByStep[step.id] ?? "ok" }
        : {
            status: "error",
            error: errorByStep[step.id] ?? `INVALID_INPUT: ${step.expectDiagnostic?.path ?? ""}`,
          },
  }));
}

function unitResult(
  spec: HostSessionSpec,
  overrides: Partial<EvaluationInput> = {},
): EvaluationInput {
  return {
    spec,
    cohort: HOST_COHORTS[0]!,
    exitCode: 0,
    sessionId: "ses-unit",
    definitions: spec.expectedToolNames.map(observedDefinition),
    provider: {
      modelRequests: 1,
      modelRequestsWithTools: 1,
      webSearchRequests: 0,
      webFetchRequests: 0,
    },
    journal: { exec: 0, reject: 0, pluginErrors: [] },
    state: { exists: false, records: 0, executions: 0, itemStates: [] },
    workspaceFiles: [],
    filesBefore: [],
    fileHashes: {},
    fileContents: {},
    toolParts: defaultToolParts(spec),
    journalEntries: defaultJournal(spec),
    webSearchBodies: [],
    childEnvKeys: [],
    isolationIssues: [],
    stdoutErrors: [],
    stderrTail: "",
    ...overrides,
  };
}

describe("full host matrix cohort definitions", () => {
  test("defines an OpenAI-compatible and an Anthropic transport with distinct editor cohorts", () => {
    expect(HOST_COHORTS.map((cohort) => cohort.transport)).toEqual([
      "openai-chat-completions",
      "anthropic-messages",
    ]);
    expect(HOST_COHORTS[0]!.editorTool).toBe("str_replace_editor");
    expect(HOST_COHORTS[1]!.editorTool).toBe("hashline_edit");
    expect(HOST_COHORTS[0]!.providerNpm).toBe("@ai-sdk/openai-compatible");
    expect(HOST_COHORTS[1]!.providerNpm).toBe("@ai-sdk/anthropic");
    expect(HOST_COHORTS[0]!.loweringRoute).toContain("no branch");
  });

  test("four sessions cover the whole nine-tool union without forcing hidden tools", () => {
    const specs = hostSessionSpecs();
    expect(specs.map((spec) => spec.id)).toEqual([
      "openai-positive",
      "openai-negative",
      "anthropic-positive",
      "anthropic-negative",
    ]);
    const union = new Set(specs.flatMap((spec) => spec.expectedToolNames));
    expect([...union].sort()).toEqual([...OWNED_TOOL_IDS].sort());
    expect(specs[0]!.expectedToolNames).toContain("str_replace_editor");
    expect(specs[0]!.expectedToolNames).not.toContain("hashline_edit");
    expect(specs[2]!.expectedToolNames).toContain("hashline_edit");
    expect(specs[2]!.expectedToolNames).not.toContain("str_replace_editor");
    expect(specs[0]!.visibleEditorTool).toBe("str_replace_editor");
    expect(specs[2]!.visibleEditorTool).toBe("hashline_edit");
  });

  test("negative sessions require clean workflow state and no web dispatch", () => {
    for (const spec of hostSessionSpecs().filter((entry) => entry.id.endsWith("negative"))) {
      expect(spec.expectCleanWorkflowState).toBe(true);
      expect(spec.expectNoWebDispatch).toBe(true);
      expect(spec.unchangedFiles.length).toBeGreaterThan(0);
    }
  });

  test("negative diagnostics demand the exact source and reserved-stop paths", () => {
    const negative = hostSessionSpecs().find((spec) => spec.id === "openai-negative")!;
    const source = negative.steps.find((step) => step.id === "reject-bad-source-kind")!;
    expect(source.expectDiagnostic?.path).toBe("execution.source.kind");
    const reserved = negative.steps.find((step) => step.id === "reject-reserved-stop-typo")!;
    expect(reserved.expectDiagnostic?.path).toBe("reservedStops[0]");
  });
});

describe("wire definition normalization", () => {
  test("normalizes OpenAI function and legacy flat definitions", () => {
    const definitions = normalizeOpenAIDefinitions({
      tools: [
        {
          type: "function",
          function: { name: "a", description: "desc", parameters: { type: "object" } },
        },
        { name: "b", description: "flat", parameters: { type: "object" } },
      ],
    });
    expect(definitions.map((definition) => definition.name)).toEqual(["a", "b"]);
    expect(definitions[0]!.parameters).toEqual({ type: "object" });
    expect(definitions[1]!.description).toBe("flat");
  });

  test("normalizes Anthropic input_schema definitions", () => {
    const definitions = normalizeAnthropicDefinitions({
      tools: [
        {
          name: "a",
          description: "desc",
          input_schema: { type: "object", additionalProperties: false },
        },
      ],
    });
    expect(definitions[0]!.name).toBe("a");
    expect(definitions[0]!.parameters.additionalProperties).toBe(false);
  });
});

describe("conversation parsing helpers", () => {
  test("flattens tool results and counts steps for both transports", () => {
    const openai = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "" },
      { role: "tool", content: '{"workItemId": "wi-7"}' },
    ];
    expect(countToolResults("openai-chat-completions", openai)).toBe(1);
    expect(flattenOpenAIText(openai)).toContain("wi-7");

    const anthropic = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "user", content: [{ type: "tool_result", content: '{"runId": "run-3"}' }] },
    ];
    expect(countToolResults("anthropic-messages", anthropic)).toBe(1);
    expect(flattenAnthropicText(anthropic)).toContain("run-3");
  });

  test("detects a scripted child assignment only in user messages", () => {
    const child = [
      { role: "user", content: "VVOC_WORK_ITEM_ID: wi-1\n<assignment>go</assignment>" },
    ];
    expect(isChildRequest("openai-chat-completions", child)).toBe(true);
    const parent = [
      {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { arguments: "<assignment>go</assignment>" } }],
      },
    ];
    expect(isChildRequest("openai-chat-completions", parent)).toBe(false);
  });

  test("extracts assigned identities from a transcript", () => {
    const text = '{"workItemId": "wi-9", "runId": "run-4"}';
    expect(assignedWorkItemId(text)).toBe("wi-9");
    expect(assignedRunId(text)).toBe("run-4");
  });
});

describe("harness journal parsing", () => {
  test("fails closed on malformed or incomplete records", () => {
    const good = parseHarnessJournalText(
      `${JSON.stringify({
        kind: "exec",
        tool: "web_search",
        callID: "c1",
        args: {},
        producerContract: "ok",
        ownedResult: { output: "x" },
      })}\n`,
    );
    expect(good.errors).toEqual([]);
    expect(good.entries[0]).toMatchObject({
      kind: "exec",
      tool: "web_search",
      producerContract: "ok",
    });

    expect(parseHarnessJournalText('{"kind":"exec"}\n').errors[0]).toContain(
      "unknown or malformed",
    );
    expect(parseHarnessJournalText('{"kind":"reject","tool":"x"}\n').errors[0]).toContain(
      "missing error",
    );
    expect(parseHarnessJournalText("{oops\n").errors[0]).toContain("invalid JSON");
  });
});

describe("exact projection comparison", () => {
  test("accepts a definition identical to the built descriptor", () => {
    const descriptor = syntheticDescriptor("web_search");
    const observed = observedDefinition("web_search");
    expect(compareProjection(observed, descriptor)).toEqual({ ok: true });
  });

  test("self-mutations fail: dropped description, nested enum, changed bound", () => {
    const descriptor = syntheticDescriptor("web_search");
    const base = observedDefinition("web_search");

    const droppedDescription = { ...base, description: "wrong" };
    expect(compareProjection(droppedDescription, descriptor).ok).toBe(false);
    expect(compareProjection(droppedDescription, descriptor).detail).toContain("description");

    const parameters = JSON.parse(JSON.stringify(base.parameters)) as {
      properties: Record<string, Record<string, unknown>>;
    };
    parameters.properties.count = { type: "integer", minimum: 1, maximum: 99, default: 8 };
    expect(compareProjection({ ...base, parameters }, descriptor).detail).toContain(
      "properties.count.maximum",
    );

    const nested = JSON.parse(JSON.stringify(base.parameters)) as {
      properties: Record<string, unknown>;
    };
    nested.properties.added = { type: "object", additionalProperties: false };
    expect(compareProjection({ ...base, parameters: nested }, descriptor).ok).toBe(false);
  });

  test("fails on a drifted nested enum", () => {
    const descriptor: BuiltToolDescriptor = {
      toolId: "nested_enum",
      description: "nested",
      inputJsonSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          inner: {
            type: "object",
            additionalProperties: false,
            properties: { mode: { enum: ["quiet", "loud"] } },
          },
        },
      },
    };
    const observed: NormalizedToolDefinition = {
      name: "nested_enum",
      description: "nested",
      parameters: JSON.parse(JSON.stringify(descriptor.inputJsonSchema)) as Record<string, unknown>,
    };
    expect(compareProjection(observed, descriptor).ok).toBe(true);
    const parameters = observed.parameters as {
      properties: { inner: { properties: { mode: { enum: string[] } } } };
    };
    parameters.properties.inner.properties.mode.enum = ["quiet"];
    const drifted = compareProjection(observed, descriptor);
    expect(drifted.ok).toBe(false);
    expect(drifted.detail).toContain("properties.inner.properties.mode.enum");
  });

  test("subsetMatch validates owned success semantics", () => {
    expect(
      subsetMatch({ ok: true, action: "accept", extra: 1 }, { ok: true, action: "accept" }),
    ).toBe(true);
    expect(subsetMatch({ ok: false }, { ok: true })).toBe(false);
    expect(subsetMatch({ items: [{ ok: true }] }, { items: [{ ok: true }] })).toBe(true);
    expect(subsetMatch({ items: [] }, { items: [{ ok: true }] })).toBe(false);
  });
});

describe("host session evaluation", () => {
  test("passes a well-formed positive observation", () => {
    const evaluation = evaluateHostSession(unitResult(unitSpec()), BUILT);
    expect(evaluation.failed).toEqual([]);
    expect(evaluation.cases[0]?.ok).toBe(true);
    expect(evaluation.cases[0]?.producerContract).toBe("ok");
  });

  test("fails when a scripted step has no host tool result", () => {
    const evaluation = evaluateHostSession(unitResult(unitSpec(), { toolParts: [] }), BUILT);
    expect(evaluation.failed.some((label) => label.includes("no host tool result"))).toBe(true);
  });

  test("fails a completed owned step with a malformed host body", () => {
    const missingOutput = evaluateHostSession(
      unitResult(unitSpec(), {
        toolParts: [{ tool: "web_search", callID: "call-ok", state: { status: "completed" } }],
      }),
      BUILT,
    );
    expect(missingOutput.failed.some((label) => label.includes("no owned output body"))).toBe(true);

    const noJournal = evaluateHostSession(unitResult(unitSpec(), { journalEntries: [] }), BUILT);
    expect(noJournal.failed.some((label) => label.includes("was journaled"))).toBe(true);

    const verdictFailed = evaluateHostSession(
      unitResult(unitSpec(), {
        journalEntries: [
          {
            kind: "exec",
            tool: "web_search",
            callID: "call-ok",
            args: {},
            producerContract: "failed",
          },
        ],
      }),
      BUILT,
    );
    expect(
      verdictFailed.failed.some((label) => label.includes("dist-schema verdict was failed")),
    ).toBe(true);

    const verdictMissing = evaluateHostSession(
      unitResult(unitSpec(), {
        journalEntries: [{ kind: "exec", tool: "web_search", callID: "call-ok", args: {} }],
      }),
      BUILT,
    );
    expect(verdictMissing.failed.some((label) => label.includes("verdict was missing"))).toBe(true);
  });

  test("fails when the built result validator rejects the owned payload", () => {
    const built = syntheticBuilt({ validateWebResult: () => ({ ok: false, detail: "bad web" }) });
    const evaluation = evaluateHostSession(unitResult(unitSpec()), built);
    expect(evaluation.failed.some((label) => label.includes("built web result contract"))).toBe(
      true,
    );
    expect(evaluation.cases[0]?.producerContract).toBe("failed");
  });

  test("fails a hook rejection that still executed", () => {
    const spec = unitSpec({
      steps: [
        {
          id: "rej",
          tool: "work_item_open",
          expect: "error",
          rejectionLevel: "hook",
          expectDiagnostic: { code: "INVALID_INPUT", path: "items[0].tpyo" },
          buildArgs: () => ({}),
        },
      ],
      expectedToolNames: ["web_search", "web_fetch", "work_checkpoint"],
      expectCleanWorkflowState: true,
    });
    const good = unitResult(spec);
    expect(evaluateHostSession(good, BUILT).failed).toEqual([]);

    const executed = unitResult(spec, {
      journalEntries: [
        ...good.journalEntries,
        { kind: "exec", tool: "work_item_open", callID: "call-rej", args: {} },
      ],
    });
    expect(
      evaluateHostSession(executed, BUILT).failed.some((label) => label.includes("execute ran")),
    ).toBe(true);
  });

  test("fails a rejection missing its exact actionable path", () => {
    const spec = unitSpec({
      steps: [
        {
          id: "rej",
          tool: "work_item_open",
          expect: "error",
          rejectionLevel: "hook",
          expectDiagnostic: { code: "INVALID_INPUT", path: "execution.source.kind" },
          buildArgs: () => ({}),
        },
      ],
      expectCleanWorkflowState: true,
    });
    const evaluation = evaluateHostSession(
      unitResult(spec, {
        toolParts: defaultToolParts(spec, {}, { rej: "INVALID_INPUT: execution.source" }),
      }),
      BUILT,
    );
    expect(evaluation.failed.some((label) => label.includes("actionable path"))).toBe(true);
  });

  test("fails when a rejected session still dispatched a provider request", () => {
    const spec = unitSpec({ expectCleanWorkflowState: true, expectNoWebDispatch: true });
    const evaluation = evaluateHostSession(
      unitResult(spec, {
        provider: {
          modelRequests: 1,
          modelRequestsWithTools: 1,
          webSearchRequests: 0,
          webFetchRequests: 2,
        },
      }),
      BUILT,
    );
    expect(evaluation.failed.some((label) => label.includes("dispatched no fetch request"))).toBe(
      true,
    );
  });

  test("checks the documented default count actually reached the provider", () => {
    const spec = unitSpec({ expectSearchDefaultCount: true });
    const wrong = evaluateHostSession(
      unitResult(spec, { webSearchBodies: ['{"numResults":3}'] }),
      BUILT,
    );
    expect(wrong.failed.some((label) => label.includes("default count"))).toBe(true);
    const right = evaluateHostSession(
      unitResult(spec, { webSearchBodies: ['{"numResults":8}'] }),
      BUILT,
    );
    expect(right.failed).toEqual([]);
  });

  test("fails when clean-state, counters, or unchanged-file expectations do not hold", () => {
    const spec = unitSpec({
      expectCleanWorkflowState: true,
      unchangedFiles: ["src/kept.txt"],
    });
    const evaluation = evaluateHostSession(
      unitResult(spec, {
        state: { exists: true, records: 1, executions: 0, itemStates: [] },
        fileHashes: { "before:src/kept.txt": "aaa", "src/kept.txt": "bbb" },
      }),
      BUILT,
    );
    expect(evaluation.failed.some((label) => label.includes("no workflow records"))).toBe(true);
    expect(evaluation.failed.some((label) => label.includes("unchanged"))).toBe(true);
  });

  test("checks positive workflow counters and expected states", () => {
    const spec = unitSpec({
      expectWorkflowState: { records: 1, executions: 0, itemStates: ["closed"] },
    });
    const good = evaluateHostSession(
      unitResult(spec, {
        state: { exists: true, records: 1, executions: 0, itemStates: ["closed"] },
      }),
      BUILT,
    );
    expect(good.failed).toEqual([]);
    const bad = evaluateHostSession(
      unitResult(spec, { state: { exists: true, records: 2, executions: 0, itemStates: [] } }),
      BUILT,
    );
    expect(bad.failed.some((label) => label.includes("record count"))).toBe(true);
    expect(bad.failed.some((label) => label.includes("state closed"))).toBe(true);
  });

  test("checks expected positive file content", () => {
    const spec = unitSpec({ expectFileContent: { "src/edit.txt": "gamma" } });
    const good = evaluateHostSession(
      unitResult(spec, { fileContents: { "src/edit.txt": "beta\ngamma" } }),
      BUILT,
    );
    expect(good.failed).toEqual([]);
    const bad = evaluateHostSession(
      unitResult(spec, { fileContents: { "src/edit.txt": "beta" } }),
      BUILT,
    );
    expect(bad.failed.some((label) => label.includes("content contains"))).toBe(true);
  });

  test("validates owned success semantics via expectJson", () => {
    const spec = unitSpec({
      steps: [
        {
          id: "decide",
          tool: "work_item_decide",
          expect: "completed",
          buildArgs: () => ({}),
          expectJson: { ok: true, action: "accept" },
        },
      ],
      expectedToolNames: ["web_search", "web_fetch", "work_checkpoint"],
    });
    const good = evaluateHostSession(
      unitResult(spec, {
        toolParts: defaultToolParts(spec, {
          decide: '{"ok":true,"action":"accept","state":"ready_to_close"}',
        }),
      }),
      BUILT,
    );
    expect(good.failed).toEqual([]);
    const bad = evaluateHostSession(
      unitResult(spec, {
        toolParts: defaultToolParts(spec, { decide: '{"ok":false,"action":"accept"}' }),
      }),
      BUILT,
    );
    expect(bad.failed.some((label) => label.includes("owned success semantics"))).toBe(true);
  });

  test("verifies a journaled media attachment MIME", () => {
    const spec = unitSpec({
      steps: [
        {
          id: "media",
          tool: "web_fetch",
          expect: "completed",
          buildArgs: () => ({}),
          expectAttachmentMime: "image/png",
        },
      ],
    });
    expect(evaluateHostSession(unitResult(spec), BUILT).failed).toEqual([]);
    const bad = evaluateHostSession(
      unitResult(spec, {
        journalEntries: [
          {
            kind: "exec",
            tool: "web_fetch",
            callID: "call-media",
            args: {},
            producerContract: "ok",
            ownedResult: {},
          },
        ],
      }),
      BUILT,
    );
    expect(bad.failed.some((label) => label.includes("attachment"))).toBe(true);
  });

  test("self-mutations drop a description, change a nested enum/bound, or omit a tool", () => {
    const base = unitResult(unitSpec());

    const dropped = {
      ...base,
      definitions: base.definitions.map((definition) =>
        definition.name === "web_search" ? { ...definition, description: "drifted" } : definition,
      ),
    };
    expect(
      evaluateHostSession(dropped, BUILT).failed.some((label) => label.includes("description")),
    ).toBe(true);

    const changedBound = {
      ...base,
      definitions: base.definitions.map((definition) =>
        definition.name === "web_fetch"
          ? {
              ...definition,
              parameters: {
                ...definition.parameters,
                properties: { timeout: { type: "integer", default: 30 } },
              },
            }
          : definition,
      ),
    };
    expect(
      evaluateHostSession(changedBound, BUILT).failed.some((label) => label.includes("drift")),
    ).toBe(true);

    const omitted = {
      ...base,
      definitions: base.definitions.filter((definition) => definition.name !== "web_fetch"),
    };
    expect(
      evaluateHostSession(omitted, BUILT).failed.some((label) => label.includes("missing")),
    ).toBe(true);
  });

  test("fails when the hidden editor tool is exposed", () => {
    const base = unitResult(unitSpec());
    const exposed = {
      ...base,
      definitions: [
        ...base.definitions,
        { name: "hashline_edit", description: "x", parameters: {} },
      ],
    };
    expect(
      evaluateHostSession(exposed, BUILT).failed.some((label) => label.includes("hidden editor")),
    ).toBe(true);
  });

  test("checks the loaded package identity reported by work_item_list", () => {
    const spec = unitSpec({
      steps: [
        {
          id: "list",
          tool: "work_item_list",
          expect: "completed",
          buildArgs: () => ({}),
          outputIncludes: ["items"],
        },
      ],
    });
    const contract = {
      packageName: PACKAGE_NAME,
      packageVersion: PACKAGE_VERSION,
      toolContractRevision: AGENT_TOOL_CONTRACT_REVISION,
      referencePath: `/repo/${TOOL_CONTRACT_REFERENCE_SUFFIX}`,
    };
    const good = evaluateHostSession(
      unitResult(spec, {
        toolParts: defaultToolParts(spec, {
          list: JSON.stringify({ tool: "work_item_list", items: [], contract }),
        }),
      }),
      BUILT,
    );
    expect(good.failed).toEqual([]);
    const bad = evaluateHostSession(
      unitResult(spec, {
        toolParts: defaultToolParts(spec, {
          list: JSON.stringify({
            tool: "work_item_list",
            items: [],
            contract: { ...contract, packageVersion: "0.0.0" },
          }),
        }),
      }),
      BUILT,
    );
    expect(bad.failed.some((label) => label.includes("built package identity"))).toBe(true);
  });

  test("fails when isolation issues were observed", () => {
    const evaluation = evaluateHostSession(
      unitResult(unitSpec(), {
        isolationIssues: ["OPENAI_API_KEY is not inside the owned scratch root"],
      }),
      BUILT,
    );
    expect(evaluation.failed.some((label) => label.includes("isolation"))).toBe(true);
  });
});

describe("host harness generation and isolation", () => {
  test("wrapper imports built dist plugins and dist schema validators, hashes payloads, and denies egress", () => {
    const source = generateHostHarnessPluginSource({
      workflowPluginUrl: "file:///repo/dist/plugins/workflow/index.js",
      hashlinePluginUrl: "file:///repo/dist/plugins/hashline-edit/index.js",
      webPluginUrl: "file:///repo/dist/plugins/web-tools/index.js",
      workflowResultsUrl: "file:///repo/dist/plugins/workflow/results.js",
      hashlineSchemasUrl: "file:///repo/dist/plugins/hashline-edit/schemas.js",
      webSchemasUrl: "file:///repo/dist/plugins/web-tools/schemas.js",
      journalPath: "/tmp/journal.jsonl",
      loopbackOrigin: "http://127.0.0.1:4321",
    });
    expect(source).toContain("file:///repo/dist/plugins/workflow/index.js");
    expect(source).toContain("file:///repo/dist/plugins/workflow/results.js");
    expect(source).toContain("file:///repo/dist/plugins/hashline-edit/schemas.js");
    expect(source).toContain("file:///repo/dist/plugins/web-tools/schemas.js");
    expect(source).toContain("api.exa.ai");
    expect(source).toContain("VVOC_EGRESS_DENIED");
    expect(source).toContain('redirect: "manual"');
    expect(source).toContain("...original");
    expect(source).toContain("validateOwnedResult");
    expect(source).toContain("metadataReport");
    expect(source).toContain("outputSha256");
    expect(source).toContain("urlSha256");
    expect(source).not.toContain("urlPrefix: typeof");
    expect(source).not.toContain("src/plugins/workflow/index.ts");
  });

  test("builds an isolated project vvoc config with only a synthetic Exa credential", () => {
    const text = buildHostVvocConfig();
    const parsed = parseVvocConfigText(text, "host vvoc");
    expect(parsed.web?.search?.provider).toBe("exa");
    expect(parsed.web?.search?.apiKey).toBe(SYNTHETIC_EXA_API_KEY);
    expect(text).not.toContain("ANTHROPIC_API_KEY");
  });

  test("builds a cohort config with synthetic primary and child agents only", () => {
    const config = JSON.parse(
      buildCohortHostConfig(HOST_COHORTS[1]!, { port: 5555, pluginUrl: "file:///plugin.ts" }),
    ) as {
      provider: Record<string, { npm: string; options: { baseURL: string } }>;
      agent: Record<string, { mode: string }>;
      plugin: string[];
    };
    expect(config.provider["vvoc-probe-anthropic"]?.npm).toBe("@ai-sdk/anthropic");
    expect(config.provider["vvoc-probe-anthropic"]?.options.baseURL).toBe(
      "http://127.0.0.1:5555/v1",
    );
    expect(Object.keys(config.agent).sort()).toEqual(["vv-controller", "vv-implementer"]);
    expect(config.agent["vv-implementer"]?.mode).toBe("subagent");
    expect(config.plugin).toEqual(["file:///plugin.ts"]);
  });
});

describe("evidence lifecycle", () => {
  test("requires the existing active change bundle and never recreates it", async () => {
    const base = await mkdtemp(join(await realpathSafe(tmpdir()), "vvoc-evidence-"));
    try {
      expect(resolveEvidenceTarget(base).ok).toBe(false);
      await mkdir(join(base, ".grace/changes/active/C-AGENT-TOOL-CONTRACTS"), { recursive: true });
      const target = resolveEvidenceTarget(base);
      expect(target.ok).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("invalidates prior passing evidence", async () => {
    const base = await mkdtemp(join(await realpathSafe(tmpdir()), "vvoc-invalidate-"));
    try {
      const path = join(base, "compatibility-evidence.json");
      await writeFile(path, "{}");
      await invalidateEvidence(path);
      expect(existsSync(path)).toBe(false);
      await invalidateEvidence(path);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("refuses to write on failures, oversize, or a missing target", async () => {
    const base = await mkdtemp(join(await realpathSafe(tmpdir()), "vvoc-write-"));
    try {
      const parent = join(base, "bundle");
      await mkdir(parent, { recursive: true });
      const target = { ok: true as const, path: join(parent, "evidence.json") };
      expect(
        (await writeEvidenceIfAllowed(target, "{}", { failureCount: 1, maxBytes: 100 })).ok,
      ).toBe(false);
      expect(
        (await writeEvidenceIfAllowed(target, "x".repeat(20), { failureCount: 0, maxBytes: 5 })).ok,
      ).toBe(false);
      expect(existsSync(target.path)).toBe(false);
      const written = await writeEvidenceIfAllowed(target, "{}\n", {
        failureCount: 0,
        maxBytes: 100,
      });
      expect(written.ok).toBe(true);
      expect(existsSync(target.path)).toBe(true);
      const missing = await writeEvidenceIfAllowed({ ok: false, reason: "missing bundle" }, "{}", {
        failureCount: 0,
        maxBytes: 100,
      });
      expect(missing.ok).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("fingerprint drift and manifest gates", () => {
  test("fingerprintAll reports missing expected paths instead of dropping them", async () => {
    const base = await mkdtemp(join(await realpathSafe(tmpdir()), "vvoc-fingerprint-"));
    try {
      await mkdir(join(base, "dist"), { recursive: true });
      await writeFile(join(base, "dist/a.js"), "a");
      const result = await fingerprintAll(base, ["dist/a.js", "dist/missing.js", "src/x.ts"]);
      expect(result.entries.map((entry) => entry.path)).toEqual(["dist/a.js"]);
      expect(result.missing).toEqual(["dist/missing.js", "src/x.ts"]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("fingerprintDrift detects changed, added, and removed paths", () => {
    const before = [
      { path: "a", sha256: "1", bytes: 1 },
      { path: "b", sha256: "2", bytes: 2 },
    ];
    const after = [
      { path: "a", sha256: "9", bytes: 1 },
      { path: "c", sha256: "3", bytes: 3 },
    ];
    expect(fingerprintDrift(before, after)).toEqual(["a", "b", "c"]);
  });

  test("detects a changed helper, schema, or package in tmp fingerprint inputs", async () => {
    const base = await mkdtemp(join(await realpathSafe(tmpdir()), "vvoc-drift-"));
    try {
      await mkdir(join(base, "dist"), { recursive: true });
      await mkdir(join(base, "src"), { recursive: true });
      await writeFile(join(base, "dist/a.js"), "a");
      await writeFile(join(base, "src/a.ts"), "a");
      await writeFile(join(base, "package.json"), '{"name":"x"}');
      const paths = ["dist/a.js", "src/a.ts", "package.json"];
      const before = await fingerprintAll(base, paths);
      await writeFile(join(base, "src/a.ts"), "changed helper");
      const afterSource = await fingerprintAll(base, paths);
      expect(fingerprintDrift(before.entries, afterSource.entries)).toEqual(["src/a.ts"]);
      await writeFile(join(base, "package.json"), '{"name":"x","version":"9"}');
      const afterPackage = await fingerprintAll(base, paths);
      expect(fingerprintDrift(afterSource.entries, afterPackage.entries)).toEqual(["package.json"]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("readPinnedExpectations and checkPinnedManifests require real matching versions", async () => {
    const base = await mkdtemp(join(await realpathSafe(tmpdir()), "vvoc-pinned-"));
    try {
      await mkdir(join(base, "node_modules/@opencode-ai/plugin"), { recursive: true });
      await mkdir(join(base, "node_modules/@opencode-ai/sdk"), { recursive: true });
      await writeFile(
        join(base, "package.json"),
        JSON.stringify({
          dependencies: { "@opencode-ai/plugin": "1.18.2", "@opencode-ai/sdk": "1.18.2" },
        }),
      );
      await writeFile(
        join(base, "node_modules/@opencode-ai/plugin/package.json"),
        '{"version":"1.18.2"}',
      );
      await writeFile(
        join(base, "node_modules/@opencode-ai/sdk/package.json"),
        '{"version":"1.18.2"}',
      );
      const expectations = readPinnedExpectations(base);
      expect(expectations.ok).toBe(true);
      if (!expectations.ok) return;
      expect(expectations.pluginSdk).toBe("1.18.2");
      expect(checkPinnedManifests(base, expectations).ok).toBe(true);

      await writeFile(join(base, "node_modules/@opencode-ai/sdk/package.json"), "{}");
      expect(readManifestVersion(base, "node_modules/@opencode-ai/sdk/package.json")).toBeNull();
      expect(checkPinnedManifests(base, expectations).ok).toBe(false);

      await writeFile(
        join(base, "node_modules/@opencode-ai/sdk/package.json"),
        '{"version":"1.17.0"}',
      );
      const mismatch = checkPinnedManifests(base, expectations);
      expect(mismatch.ok).toBe(false);
      if (!mismatch.ok) expect(mismatch.reason).toContain("does not match pinned");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("a missing pinned manifest fails instead of recording a null-version green row", async () => {
    const base = await mkdtemp(join(await realpathSafe(tmpdir()), "vvoc-pinned-missing-"));
    try {
      await writeFile(
        join(base, "package.json"),
        JSON.stringify({
          dependencies: { "@opencode-ai/plugin": "1.18.2", "@opencode-ai/sdk": "1.18.2" },
        }),
      );
      const expectations = readPinnedExpectations(base);
      expect(expectations.ok).toBe(true);
      if (!expectations.ok) return;
      expect(checkPinnedManifests(base, expectations).ok).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("describeDefinition records bounded projection digests", () => {
    const summary = describeDefinition(observedDefinition("web_search"));
    expect(summary.projectionSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(summary.descriptionSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(summary.propertyCount).toBe(1);
  });
});

describe("local dependency closure discovery", () => {
  test("follows re-exports and cycles, terminates, and pairs dist with src", async () => {
    const base = await mkdtemp(join(await realpathSafe(tmpdir()), "vvoc-closure-"));
    try {
      await mkdir(join(base, "dist"), { recursive: true });
      await mkdir(join(base, "src"), { recursive: true });
      await writeFile(join(base, "dist/a.js"), 'export { b } from "./b.js";\nimport "./b.js";\n');
      await writeFile(join(base, "dist/b.js"), 'export { c } from "./c.js";\n');
      await writeFile(join(base, "dist/c.js"), 'import "./a.js";\nexport const c = 1;\n');
      await writeFile(join(base, "dist/unreachable.js"), "export {};\n");
      await writeFile(join(base, "src/a.ts"), "export const a = 1;\n");
      const closure = collectLocalImportClosure(base, ["dist/a.js"]);
      expect(closure.paths).toEqual(["dist/a.js", "dist/b.js", "dist/c.js", "src/a.ts"]);
      expect(closure.paths).not.toContain("dist/unreachable.js");
      expect(closure.unresolved).toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("resolves .js imports to .ts sources and strips raw queries", async () => {
    const base = await mkdtemp(join(await realpathSafe(tmpdir()), "vvoc-closure-src-"));
    try {
      await mkdir(join(base, "src"), { recursive: true });
      await writeFile(
        join(base, "src/index.ts"),
        'import { x } from "./helper.js";\nimport raw from "./doc.md?raw";\nexport const y = x;\n',
      );
      await writeFile(join(base, "src/helper.ts"), "export const x = 1;\n");
      await writeFile(join(base, "src/doc.md"), "# doc\n");
      const closure = collectLocalImportClosure(base, ["src/index.ts"]);
      expect(closure.paths).toContain("src/helper.ts");
      expect(closure.paths).toContain("src/doc.md");
      expect(closure.unresolved).toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("real repository closure includes previously omitted behavior-critical files", () => {
    const repoRoot = resolve(import.meta.dir, "..");
    const sourceRoots = [
      "src/plugins/workflow/index.ts",
      "src/plugins/hashline-edit/index.ts",
      "src/plugins/web-tools/index.ts",
      "src/lib/agent-tool-catalog.ts",
      "src/lib/agent-tool-contract.ts",
    ];
    if (!sourceRoots.every((root) => existsSync(join(repoRoot, root)))) return;
    const closure = collectLocalImportClosure(repoRoot, sourceRoots);
    const known = [
      "src/plugins/workflow/schemas.ts",
      "src/plugins/workflow/tooling.ts",
      "src/plugins/workflow/authorization.ts",
      "src/plugins/workflow/recovery.ts",
      "src/plugins/workflow/transactions.ts",
      "src/plugins/workflow/protocol.ts",
      "src/plugins/workflow/repair.ts",
      "src/lib/workflow-contract.ts",
      "src/plugins/hashline-edit/normalize-edits.ts",
      "src/plugins/hashline-edit/str-replace-editor.ts",
      "src/plugins/hashline-edit/edit-operations.ts",
      "src/plugins/hashline-edit/validation.ts",
      "src/plugins/hashline-edit/session-state.ts",
      "src/plugins/web-tools/search-service.ts",
      "src/plugins/web-tools/fetch-service.ts",
      "src/plugins/web-tools/http.ts",
      "src/plugins/web-tools/providers/exa.ts",
    ];
    for (const path of known) expect(closure.paths).toContain(path);
    expect(closure.paths.length).toBeGreaterThan(known.length);
    expect(closure.unresolved).toEqual([]);
  });

  test("extractRelativeSpecifiers finds static, side-effect, and dynamic relative imports", () => {
    const specs = extractRelativeSpecifiers(
      'import { a } from "./a.js";\nimport "./side.js";\nconst b = await import("./b.js");\nimport x from "pkg";\n',
    );
    expect(specs.sort()).toEqual(["./a.js", "./b.js", "./side.js"]);
  });

  test("closure roots and extra material paths are declared and de-duplicated", () => {
    expect(CLOSURE_ROOTS.length).toBeGreaterThan(0);
    expect(EXTRA_FINGERPRINT_PATHS).toContain("package.json");
    expect(EXTRA_FINGERPRINT_PATHS).toContain("scripts/check-tool-contracts-host.ts");
    expect(uniqueSorted(["b", "a", "a"])).toEqual(["a", "b"]);
  });
});

describe("compatibility evidence document", () => {
  function evidenceSession(overrides: Partial<HostSessionResult> = {}): HostSessionResult {
    const spec = unitSpec();
    const base = unitResult(spec);
    return {
      ...base,
      passed: ["ok"],
      failed: [],
      cases: [
        {
          id: "ok",
          tool: "web_search",
          expect: "completed",
          observedStatus: "completed",
          producerContract: "ok",
          ok: true,
        },
      ],
      definitions: OWNED_TOOL_IDS.map((id) => observedDefinition(id)),
      ...overrides,
    } as HostSessionResult;
  }

  test("records observed coverage, isolation, projections, and digests", () => {
    const document = buildHostEvidenceDocument({
      generatedAt: "2026-01-01T00:00:00.000Z",
      hostVersion: SUPPORTED_LIVE_HOST_VERSION,
      bunVersion: "1.3.8",
      command: "bun run contracts:host",
      scratchParent: PROBE_SCRATCH_PARENT,
      identity: BUILT.identity,
      pinned: {
        pluginSdk: "1.18.2",
        sdk: "1.18.2",
        pinnedPluginSdk: "1.18.2",
        pinnedSdk: "1.18.2",
      },
      fingerprintMeta: {
        closureRoots: CLOSURE_ROOTS,
        closureCaveat: "conservative closure",
        addedDeps: [],
        removedDeps: [],
        unresolved: [],
      },
      sessions: [evidenceSession()],
      artifacts: [{ path: "dist/x.js", sha256: "abc", bytes: 1 }],
      sources: [{ path: "src/x.ts", sha256: "def", bytes: 2 }],
      assets: [{ path: "templates/x.md", sha256: "ghi", bytes: 3 }],
      fingerprintsBefore: [{ path: "dist/x.js", sha256: "abc", bytes: 1 }],
      fingerprintsAfter: [{ path: "dist/x.js", sha256: "abc", bytes: 1 }],
      coverageFailures: [],
    });
    expect(document.version).toBe(CONTRACTS_HOST_EVIDENCE_VERSION);
    const coverage = document.coverage as { allOwnedToolsObserved: boolean; caseCount: number };
    expect(coverage.allOwnedToolsObserved).toBe(true);
    expect(coverage.caseCount).toBe(1);
    const isolation = document.isolation as { inheritedProviderCredentials: boolean };
    expect(isolation.inheritedProviderCredentials).toBe(false);
    expect((document.cohorts as { projections: unknown[] }[])[0]!.projections.length).toBe(9);
    const fingerprints = document.fingerprints as {
      drift: string[];
      addedDeps: string[];
      removedDeps: string[];
      unresolved: string[];
    };
    expect(fingerprints.drift).toEqual([]);
    expect(fingerprints.addedDeps).toEqual([]);
    expect(fingerprints.removedDeps).toEqual([]);
    expect(fingerprints.unresolved).toEqual([]);
    expect(document.pinned).toEqual({
      pluginSdk: "1.18.2",
      sdk: "1.18.2",
      pinnedPluginSdk: "1.18.2",
      pinnedSdk: "1.18.2",
    });
    expect(document.failures).toEqual([]);
  });

  test("reports missing owned tools and declared coverage failures", () => {
    const document = buildHostEvidenceDocument({
      generatedAt: "2026-01-01T00:00:00.000Z",
      hostVersion: SUPPORTED_LIVE_HOST_VERSION,
      bunVersion: "1.3.8",
      command: "bun run contracts:host",
      scratchParent: PROBE_SCRATCH_PARENT,
      identity: BUILT.identity,
      pinned: {
        pluginSdk: "1.18.2",
        sdk: "1.18.2",
        pinnedPluginSdk: "1.18.2",
        pinnedSdk: "1.18.2",
      },
      fingerprintMeta: {
        closureRoots: CLOSURE_ROOTS,
        closureCaveat: "conservative closure",
        addedDeps: [],
        removedDeps: [],
        unresolved: [],
      },
      sessions: [evidenceSession({ definitions: [observedDefinition("web_search")] })],
      artifacts: [],
      sources: [],
      assets: [],
      fingerprintsBefore: [],
      fingerprintsAfter: [],
      coverageFailures: ["owned tool work_item_open was never observed on any cohort wire"],
    });
    expect((document.coverage as { allOwnedToolsObserved: boolean }).allOwnedToolsObserved).toBe(
      false,
    );
    expect((document.failures as string[]).length).toBe(1);
  });
});
// END_BLOCK_FULL_MATRIX_TESTS

async function realpathSafe(path: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}
