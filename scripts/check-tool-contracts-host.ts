#!/usr/bin/env bun
// FILE: scripts/check-tool-contracts-host.ts
// VERSION: 1.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Run the REAL installed OpenCode host contract checks: the minimal --probe feasibility boundary against a loopback OpenAI-compatible responder, and the default full nine-tool matrix against built dist plugins on isolated OpenAI-compatible and Anthropic-compatible responders.
//   SCOPE: Isolated disposable harnesses under session scratch, allowlisted child environment, a composing wrapper importing the built dist WorkflowPlugin/HashlineEditPlugin/WebToolsPlugin, loopback OpenAI/Anthropic/Exa/web-fetch responders, outbound definition capture, scripted accept/reject calls with side-effect journaling, fail-closed evidence parsing, and observed compatibility-evidence.json generation on full pass only. No real provider traffic, no host patching, no recursive parent deletes.
//   DEPENDS: [node:fs, node:path, node:crypto, node:child_process, src/lib/agent-tool-contract.ts (probe identity), src/lib/vvoc-config.ts (isolated config), dist/lib/agent-tool-contract.js, dist/lib/agent-tool-catalog.js, dist/plugins/workflow/{index,results,input-validation}.js, dist/plugins/hashline-edit/{index,schemas}.js, dist/plugins/web-tools/{index,schemas}.js]
//   LINKS: [M-AGENT-TOOL-CONTRACT]
//   ROLE: SCRIPT
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SUPPORTED_LIVE_HOST_VERSION - Live host version this probe is authorized to exercise.
//   MINIMUM_SUPPORTED_HOST_VERSION - Oldest SDK-supported host (fixture floor; not live-tested here).
//   PROBE_TOOL_ID - Owned synthetic tool id registered by the local probe plugin.
//   PROBE_SCRATCH_PARENT - Default session scratch parent under /tmp/opencode (not owned; never recursively deleted).
//   ALLOWED_ENV_KEYS - Allowlist of environment keys forwarded to the host child process.
//   PROBE_CALL_SCRIPT - Deterministic tool-call arguments issued by the loopback responder.
//   buildProbeEnv - Construct the isolated child environment from an allowlist.
//   parseHostVersion - Extract a semver-like version from `opencode --version` output.
//   isSupportedLiveHostVersion - Whether the installed host matches the authorized live version.
//   isOwnedProbeRoot - Containment/ownership predicate for mkdtemp roots under the scratch parent.
//   cleanupProbeRoot - Delete only an owned mkdtemp root (never the parent); no-op with keep.
//   JournalParseResult - Fail-closed journal parse result with bounded errors.
//   parseJournalText - Fail-closed journal JSONL parser with bounded malformed-record diagnostics.
//   RunStdoutParseResult - Fail-closed host stdout parse result with bounded errors.
//   parseRunStdout - Fail-closed host stdout parser distinguishing non-JSON chatter from broken records.
//   OpenAIFunctionTool - OpenAI chat-completions function tool entry (name/description/parameters).
//   OpenAIToolEntry - Outbound tools[] entry (function or legacy flat form).
//   OutboundMessage - Outbound chat message fragment captured from the loopback responder.
//   OutboundRequest - Full outbound chat-completions request body.
//   JournalEntry - Probe plugin journal record (exec or reject, with callID correlation).
//   ToolUsePart - Host tool_use event part shape.
//   RunEvent - One parsed host --format json stdout event.
//   ProbeObservations - Collected live observations for evaluation.
//   ProbeEvaluation - Passed/failed assertion labels.
//   probeToolEntry - Find the probe tool entry in a captured outbound request.
//   probeToolDescription - Read the probe tool description from a wire entry (function or legacy form).
//   probeToolParameters - Read the probe tool parameter object from a wire entry.
//   toolErrorMessage - Extract the string error from a tool_use part's state.
//   evaluateProbeObservations - Assert outbound definitions, defaults, rejections, and per-call side-effect isolation.
//   buildUnexercisedMatrix - Explicit rows this probe does not cover.
//   formatProbeReport - Bounded human-readable probe report including package identity/revision.
//   ResponderHandle - Loopback responder handle with captured requests and stop().
//   sseBody - Serialize OpenAI SSE data payloads with a terminal [DONE].
//   chunkBase - Common OpenAI chat-completion chunk envelope fields.
//   streamTextResponse - OpenAI SSE response streaming a single text turn.
//   streamToolCallResponse - OpenAI SSE response streaming a probe tool call.
//   startLoopbackResponder - Start the deterministic OpenAI-compatible SSE responder.
//   generateProbePluginSource - Emit the local plugin that imports the real contract helper.
//   buildHostConfig - Serialize the isolated OpenCode config for the probe host child.
//   runCommand - Spawn a bounded child command capturing stdout/stderr with a kill timeout.
//   collectToolParts - Extract tool_use parts from parsed host events.
//   collectFinalToolMessages - Last-request tool result message contents from captured requests.
//   probePathsFor - Derive the disposable probe HOME/XDG/tmp/workspace/harness paths.
//   runProbe - Full isolated live probe; returns a process exit code.
//   symlinkSafe - Recreate a directory symlink (shares node_modules into the harness).
//   CONTRACTS_HOST_EVIDENCE_VERSION - Version of the bounded compatibility-evidence document schema.
//   HOST_EVIDENCE_RELATIVE_PATH - Repository-relative path observed host evidence is written to.
//   HOST_EVIDENCE_MAX_BYTES - Hard cap on the serialized evidence document so payloads stay bounded.
//   SYNTHETIC_EXA_API_KEY - Synthetic Exa credential injected through the isolated project vvoc config.
//   SYNTHETIC_PROVIDER_KEY - Synthetic provider key written into the isolated OpenCode config.
//   OWNED_TOOL_IDS - The nine vvoc-owned tools the cohort union must expose.
//   PROVENANCE_SOURCES - Provenance URLs the derived provider-lowering fixtures and matrix are based on.
//   CohortDefinition - One transport/cohort definition exercised by the live matrix.
//   HOST_COHORTS - The two exercised transports: SDK-compatible OpenAI and Anthropic messages.
//   NormalizedToolDefinition - Provider-neutral model-visible tool definition.
//   CapturedWebRequest - One captured provider HTTP request (model or synthetic web provider).
//   HostSessionContext - Workspace and loopback port for one isolated session's scripted calls.
//   HostToolStep - One scripted tool call and its expected outcome assertions.
//   BuiltToolDescriptor - Built descriptor (description + published input schema) for one owned tool.
//   BuiltContractContext - Identity, descriptors, defaults, and result validators loaded from dist.
//   HostSessionSpec - One isolated session: scripted steps plus side-effect expectations.
//   HostCaseRecord - Per-case outcome recorded in the compatibility evidence.
//   WORKFLOW_RESULT_TOOL_IDS - Owned workflow tool ids whose JSON output has a built producer schema.
//   HostSessionResult - Full observed result for one isolated session.
//   sha256Text - Hex SHA-256 of a string.
//   fingerprintFile - Path/sha256/byte fingerprint for an existing file; null when missing.
//   firstMatch - First capture group of a bounded regex, or the empty string.
//   assignedWorkItemId - Extract the assigned work-item id from an accumulated transcript.
//   assignedRunId - Extract the assigned generic execution run id from an accumulated transcript.
//   WireMessage - Minimal provider message shape for transcript flattening.
//   flattenOpenAIText - Flatten an OpenAI-style message list into searchable text.
//   flattenAnthropicText - Flatten an Anthropic-style message list into searchable text.
//   isChildRequest - Whether any user message carries the scripted subagent assignment marker.
//   countToolResults - Count completed tool results on the parent conversation.
//   normalizeOpenAIDefinitions - Normalize OpenAI function/legacy wire definitions.
//   normalizeAnthropicDefinitions - Normalize Anthropic input_schema wire definitions.
//   HarnessJournalEntry - Composing-wrapper observation journal record.
//   parseHarnessJournalText - Fail-closed composing-wrapper journal parser.
//   HostResponder - Cohort loopback responder handle with captured model/web observations.
//   exaSearchFixture - Deterministic 8-result Exa response envelope matching the adapter contract.
//   PNG_BYTES - Minimal PNG signature bytes returned by the synthetic media endpoint.
//   openAISse - Serialize an OpenAI SSE response body.
//   openAITextResponse - OpenAI SSE response streaming a text turn.
//   openAIToolCallResponse - OpenAI SSE response streaming a scripted tool call.
//   anthropicSse - Serialize an Anthropic SSE event stream.
//   anthropicTextResponse - Anthropic SSE response streaming a text turn.
//   anthropicToolCallResponse - Anthropic SSE response streaming a scripted tool_use block.
//   HostPlan - Scripted steps plus child report and completion text for one responder.
//   startHostResponder - Start the cohort loopback responder (model + Exa + web fetch).
//   generateHostHarnessPluginSource - Emit the composing wrapper importing built dist plugins.
//   buildCohortHostConfig - Build the isolated cohort OpenCode config with synthetic agents.
//   buildHostVvocConfig - Build the isolated project vvoc config with a synthetic Exa credential.
//   CHILD_REPORT - Synthetic tracked child result body bound to an assigned work-item id.
//   openAIPositiveSpec - The positive OpenAI-compatible cohort session spec.
//   openAINegativeSpec - The negative OpenAI-compatible cohort session spec.
//   anthropicPositiveSpec - The positive Anthropic-messages cohort session spec.
//   anthropicNegativeSpec - The negative Anthropic-messages cohort session spec.
//   hostSessionSpecs - The four isolated sessions of the bounded live matrix.
//   sessionCheck - Build a pass/fail accumulator closure.
//   listWorkspaceFiles - Recursively list workspace files (bounded) for side-effect comparison.
//   stateSummary - Summarize the isolated persisted workflow state for side-effect checks.
//   firstDifference - First structural difference path between two JSON values.
//   compareProjection - Exact observed-vs-built projection comparison with a bounded drift path.
//   subsetMatch - Deep subset match for owned success semantics.
//   TOOL_CONTRACT_REFERENCE_SUFFIX - Reference asset suffix the loaded identity must resolve within the package.
//   evaluateHostSession - Evaluate one session against built descriptors/identity; failures stop the gate.
//   runHostSession - Run one isolated session against a loopback responder; returns its observed result.
//   CLOSURE_ROOTS - Built plugin/catalog/identity roots the local closure is derived from.
//   EXTRA_FINGERPRINT_PATHS - Package/manifest, instruction/reference, and T009 fixture paths.
//   FingerprintEntry - Path/sha256/bytes fingerprint row.
//   extractRelativeSpecifiers - Relative import/export/dynamic specifiers in a module.
//   resolveLocalSpecifier - Resolve a relative import, mapping an absent `.js` to its `.ts`/`.tsx`.
//   LocalClosure - Dependency-closure paths plus unresolved relative imports.
//   collectLocalImportClosure - Conservative local import/re-export closure with src pairing.
//   uniqueSorted - Deterministic de-duplication of fingerprint paths.
//   fingerprintAll - Fingerprint every expected path; missing expected files are hard failures.
//   fingerprintDrift - Detect mid-run material drift between before/after snapshots.
//   PinnedExpectations - Result of reading the exact @opencode-ai pins from package.json.
//   readPinnedExpectations - Read the exact @opencode-ai versions pinned by package.json.
//   readManifestVersion - Read an installed manifest version; null when missing/invalid.
//   PinnedManifestCheck - Result of matching installed @opencode-ai manifest versions to the pin.
//   checkPinnedManifests - Require installed @opencode-ai versions to match the pin.
//   resolveEvidenceTarget - Require the approved active bundle directory to already exist.
//   invalidateEvidence - Remove prior owned passing evidence so a stale pass cannot mislead.
//   writeEvidenceIfAllowed - Write evidence only on a valid target, no failures, and within cap.
//   describeDefinition - Bounded per-tool projection/description digest summary.
//   buildHostEvidenceDocument - Assemble the bounded versioned compatibility-evidence document.
//   loadBuiltContractContext - Import identity/descriptors/result validators from compiled dist.
//   runContractsHost - Run the full live matrix and write evidence only on full pass.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-009 recovery attempt3 - Replaced the hand-picked fingerprint lists with a derived local import/re-export closure from the three built plugin roots plus the built catalog/identity modules (dist modules paired with src counterparts, extra package/manifest/instruction/T009 fixture paths, re-discovered after the run so added or removed deps cannot vanish, unresolved imports fail nonzero), required both installed @opencode-ai manifests to carry valid versions matching the package pin instead of a null green row, and kept every prior exact-projection/dist-producer/isolation/evidence-invalidation behavior. Prior correction: dist-loaded validators/descriptors/identity, pre-host-metadata owned result validation, exact projection comparison, projection digests, observed child-env isolation, before/after drift detection, evidence invalidation, existing-active-bundle requirement, and host version exit-code check.]
// END_CHANGE_SUMMARY

import { mkdir, mkdtemp, readdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  AGENT_TOOL_CONTRACT_REVISION,
  PACKAGE_NAME,
  PACKAGE_VERSION,
} from "../src/lib/agent-tool-contract.ts";
import { createDefaultVvocConfig, renderVvocConfig } from "../src/lib/vvoc-config.ts";

// START_BLOCK_PROBE_CONSTANTS
/** Live host version this probe exercises (honest single-version claim). */
export const SUPPORTED_LIVE_HOST_VERSION = "1.18.32";
/** Oldest host version supported by the package engines field; not live-tested by this probe. */
export const MINIMUM_SUPPORTED_HOST_VERSION = "1.18.2";
/** Owned synthetic tool id used only inside the disposable probe harness. */
export const PROBE_TOOL_ID = "vvoc_probe_contract";
/**
 * Default session scratch parent. This parent is NOT owned: cleanup never recursively deletes it.
 * Only mkdtemp roots strictly inside this parent are eligible for deletion.
 */
export const PROBE_SCRATCH_PARENT = "/tmp/opencode/tool-contracts-host";

/**
 * Environment keys allowed into the isolated host child.
 * Secrets, user config pins, and provider credentials are intentionally absent.
 */
export const ALLOWED_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "OPENCODE_CONFIG",
  "OPENCODE_DISABLE_MODELS_FETCH",
  "OPENCODE_DISABLE_EXTERNAL_SKILLS",
  "OPENCODE_DISABLE_PROJECT_CONFIG",
  "OPENCODE_DISABLE_SHARE",
  "OPENCODE_DISABLE_AUTOUPDATE",
  "OPENCODE_DISABLE_LSP_DOWNLOAD",
  "OPENCODE_DISABLE_CLAUDE_CODE_PROMPT",
  "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS",
  "OPENCODE_DISABLE_DEFAULT_PLUGINS",
  "OPENCODE_PRINT_LOGS",
  "OPENCODE_LOG_LEVEL",
  "LANG",
  "LC_ALL",
] as const;

/** Deterministic scripted calls: one accepted default case, then mandatory diagnostic rejects. */
export const PROBE_CALL_SCRIPT = [
  { id: "call_valid_default", args: { label: "alpha" } },
  {
    id: "call_unknown_top",
    args: { label: "alpha", unexpected: "nope" },
    expectErrorSubstring: "unexpected",
    expectErrorPath: "unexpected",
  },
  {
    id: "call_nested_typo",
    args: { label: "alpha", nested: { tpyo: 1 } },
    expectErrorSubstring: "tpyo",
    expectErrorPath: "nested.tpyo",
  },
  {
    id: "call_malformed_nested",
    args: { label: "alpha", nested: { depth: "deep" } },
    expectErrorSubstring: "depth",
    expectErrorPath: "nested.depth",
  },
] as const;
// END_BLOCK_PROBE_CONSTANTS

// START_BLOCK_PURE_HELPERS
/** Build the isolated child environment from the allowlist only. */
export function buildProbeEnv(
  base: Record<string, string | undefined>,
  paths: {
    home: string;
    xdgConfig: string;
    xdgData: string;
    xdgCache: string;
    opencodeConfig: string;
    tmp: string;
  },
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ALLOWED_ENV_KEYS) {
    const value = base[key];
    if (value !== undefined && value !== "") env[key] = value;
  }
  env.HOME = paths.home;
  env.XDG_CONFIG_HOME = paths.xdgConfig;
  env.XDG_DATA_HOME = paths.xdgData;
  env.XDG_CACHE_HOME = paths.xdgCache;
  env.TMPDIR = paths.tmp;
  env.OPENCODE_CONFIG = paths.opencodeConfig;
  env.OPENCODE_DISABLE_MODELS_FETCH = "1";
  env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "1";
  env.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
  env.OPENCODE_DISABLE_SHARE = "1";
  env.OPENCODE_DISABLE_AUTOUPDATE = "1";
  env.OPENCODE_DISABLE_LSP_DOWNLOAD = "1";
  env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT = "1";
  env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = "1";
  env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "1";
  env.OPENCODE_PRINT_LOGS = "1";
  env.OPENCODE_LOG_LEVEL = "WARN";
  return env;
}

/** Extract a version string from `opencode --version` output. */
export function parseHostVersion(output: string): string | null {
  const match = /(\d+\.\d+\.\d+)/.exec(output);
  return match ? match[1] : null;
}

/** True only for the authorized live host version. */
export function isSupportedLiveHostVersion(version: string | null): boolean {
  return version === SUPPORTED_LIVE_HOST_VERSION;
}

/**
 * Ownership/containment boundary: root must be a strict descendant of the scratch parent.
 * root === parent or any path outside the parent is never owned.
 */
export function isOwnedProbeRoot(root: string, scratchParent: string): boolean {
  const owned = resolve(root);
  const parent = resolve(scratchParent);
  return owned !== parent && owned.startsWith(parent + sep);
}

/**
 * Delete only an owned mkdtemp root. Never recursively deletes the scratch parent
 * (which may contain sibling runs or unrelated user temp data).
 * `keep` retains only the owned root and does not broaden access.
 */
export async function cleanupProbeRoot(
  root: string,
  scratchParent: string,
  keep?: boolean,
): Promise<void> {
  if (keep) return;
  if (!isOwnedProbeRoot(root, scratchParent)) {
    console.error(`refusing to delete non-owned probe path: ${root}`);
    return;
  }
  await rm(root, { recursive: true, force: true });
}

export type JournalParseResult = {
  entries: JournalEntry[];
  errors: string[];
};

/**
 * Fail-closed journal JSONL parser.
 * Malformed JSON or structurally invalid mandatory records become bounded errors —
 * never silently dropped so a run can pass with missing evidence.
 */
export function parseJournalText(text: string): JournalParseResult {
  const entries: JournalEntry[] = [];
  const errors: string[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim()) continue;
    const label = `journal line ${index + 1}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      errors.push(`${label}: invalid JSON`);
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      errors.push(`${label}: expected object record`);
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if (record.kind === "exec") {
      if (!("rawArgs" in record) || !("parsed" in record)) {
        errors.push(`${label}: exec record missing rawArgs/parsed`);
        continue;
      }
      entries.push({
        kind: "exec",
        rawArgs: record.rawArgs,
        parsed: record.parsed,
        ...(typeof record.callID === "string" ? { callID: record.callID } : {}),
      });
      continue;
    }
    if (record.kind === "reject") {
      if (typeof record.error !== "string" || record.error.length === 0) {
        errors.push(`${label}: reject record missing error string`);
        continue;
      }
      entries.push({
        kind: "reject",
        error: record.error,
        ...(typeof record.callID === "string" ? { callID: record.callID } : {}),
      });
      continue;
    }
    errors.push(`${label}: unknown journal kind`);
  }
  return { entries, errors };
}

export type RunStdoutParseResult = {
  events: RunEvent[];
  errors: string[];
};

/**
 * Fail-closed host `--format json` stdout parser.
 * Lines that look like JSON must parse and, when they are tool_use events,
 * must carry a complete part/state. Non-JSON chatter is a legitimate non-result
 * host event and is ignored; broken JSON records are not.
 */
export function parseRunStdout(stdout: string): RunStdoutParseResult {
  const events: RunEvent[] = [];
  const errors: string[] = [];
  const lines = stdout.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim()) continue;
    const trimmed = line.trimStart();
    const looksLikeJson =
      trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith('"');
    if (!looksLikeJson) {
      // Legitimate non-result host chatter (logs, banners).
      continue;
    }
    const label = `host stdout line ${index + 1}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      errors.push(`${label}: malformed JSON host record`);
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      errors.push(`${label}: expected object event`);
      continue;
    }
    const event = parsed as RunEvent;
    if (event.type === "tool_use") {
      const part = event.part;
      if (
        !part ||
        typeof part !== "object" ||
        typeof part.tool !== "string" ||
        typeof part.callID !== "string" ||
        !part.state ||
        typeof part.state.status !== "string"
      ) {
        errors.push(`${label}: malformed tool_use part`);
        continue;
      }
    }
    events.push(event);
  }
  return { events, errors };
}
// END_BLOCK_PURE_HELPERS

// START_BLOCK_REPORT
/** OpenAI chat-completions function tool (name/description/parameters). */
export type OpenAIFunctionTool = {
  name: string;
  description?: string;
  parameters?: unknown;
};

/** Outbound tools[] entry: function-calling form or legacy flat form. */
export type OpenAIToolEntry = {
  type?: string;
  function?: OpenAIFunctionTool;
  name?: string;
  description?: string;
  parameters?: unknown;
};

export type OutboundMessage = {
  role?: string;
  content?: unknown;
  tool_calls?: unknown;
};

export type OutboundRequest = {
  model?: string;
  messages?: OutboundMessage[];
  tools?: OpenAIToolEntry[];
  stream?: boolean;
};

export type JournalEntry =
  | { kind: "exec"; rawArgs: unknown; parsed: unknown; callID?: string }
  | { kind: "reject"; error: string; callID?: string };

export type ToolUsePart = {
  type?: string;
  tool?: string;
  callID?: string;
  state?: {
    status?: string;
    input?: unknown;
    output?: string;
    error?: string;
  };
};

export type RunEvent = { type?: string; part?: ToolUsePart };

export type ProbeObservations = {
  hostVersion: string | null;
  outbound: OutboundRequest[];
  toolParts: ToolUsePart[];
  journal: JournalEntry[];
  finalToolResultMessages: string[];
  childEnvKeys: string[];
  evidenceErrors: string[];
  packageIdentity: string;
};

export type ProbeEvaluation = {
  passed: string[];
  failed: string[];
};

function probeToolEntry(request: OutboundRequest): OpenAIToolEntry | undefined {
  return (request.tools ?? []).find(
    (entry) => (entry.function?.name ?? entry.name) === PROBE_TOOL_ID,
  );
}

function probeToolDescription(entry: OpenAIToolEntry | undefined): string {
  return entry?.function?.description ?? entry?.description ?? "";
}

function probeToolParameters(
  entry: OpenAIToolEntry | undefined,
): Record<string, unknown> | undefined {
  const parameters = entry?.function?.parameters ?? entry?.parameters;
  if (typeof parameters === "object" && parameters !== null && !Array.isArray(parameters)) {
    return parameters as Record<string, unknown>;
  }
  return undefined;
}

function toolErrorMessage(part: ToolUsePart | undefined): string {
  const error = part?.state?.error;
  return typeof error === "string" ? error : "";
}

/** Assert every mandatory T-001 live-host observation; failures are nonzero-stop conditions. */
export function evaluateProbeObservations(obs: ProbeObservations): ProbeEvaluation {
  const passed: string[] = [];
  const failed: string[] = [];
  const check = (ok: boolean, label: string) => {
    if (ok) passed.push(label);
    else failed.push(label);
  };

  for (const evidenceError of obs.evidenceErrors) {
    check(false, `evidence: ${evidenceError}`);
  }

  check(
    isSupportedLiveHostVersion(obs.hostVersion),
    `live host version is ${SUPPORTED_LIVE_HOST_VERSION}`,
  );
  check(
    obs.packageIdentity === `${PACKAGE_NAME}@${PACKAGE_VERSION}#${AGENT_TOOL_CONTRACT_REVISION}`,
    "report package identity and contract revision recorded",
  );

  const withProbeTool = obs.outbound.find((request) => probeToolEntry(request) !== undefined);
  const probeTool = probeToolEntry(withProbeTool ?? { tools: [] });
  const parameters = probeToolParameters(probeTool);
  const properties = (parameters?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const description = probeToolDescription(probeTool);

  check(Boolean(parameters), "outbound definition includes probe tool");
  check(
    description.includes("Echo label") || description.includes("contract"),
    "outbound definition retains required tool description",
  );
  check(parameters?.additionalProperties === false, "outbound root schema closes unknown keys");
  check(Array.isArray((properties.mode as { enum?: unknown })?.enum), "outbound mode retains enum");
  check(
    JSON.stringify((properties.mode as { enum?: unknown })?.enum) ===
      JSON.stringify(["quiet", "loud"]),
    "outbound enum values are quiet|loud",
  );
  check(
    properties.label?.description === "Echo label",
    "outbound published label description retained",
  );
  const nested = properties.nested as Record<string, unknown> | undefined;
  check(
    Boolean(nested) &&
      nested?.type === "object" &&
      nested?.additionalProperties === false &&
      Boolean((nested?.properties as Record<string, unknown> | undefined)?.depth),
    "outbound nested shape retained with closed object",
  );

  const byCall = new Map<string, ToolUsePart>();
  for (const part of obs.toolParts) {
    if (part.tool === PROBE_TOOL_ID && part.callID) byCall.set(part.callID, part);
  }

  const valid = byCall.get("call_valid_default");
  check(valid?.state?.status === "completed", "valid call omitting default completes");
  const validOutput = valid?.state?.output ?? "";
  check(validOutput.includes('"mode":"quiet"'), "executed result applies intended default mode");

  const execEntries = obs.journal.filter((entry) => entry.kind === "exec");
  check(execEntries.length === 1, "exactly one execution side effect");
  const execEntry = execEntries[0];
  if (execEntry?.kind === "exec") {
    check(
      execEntry.callID === "call_valid_default",
      "execution correlated to the valid default call",
    );
    const raw = execEntry.rawArgs;
    const rawRecord =
      typeof raw === "object" && raw !== null && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    check(!("mode" in rawRecord), "host forwarded original raw args without injected default mode");
    check(
      !("nested" in rawRecord),
      "host forwarded original raw args without injected nested default",
    );
    const parsedRecord =
      typeof execEntry.parsed === "object" && execEntry.parsed !== null
        ? (execEntry.parsed as Record<string, unknown>)
        : {};
    check(parsedRecord.mode === "quiet", "direct-execute parse materializes default for execute");
  }

  const rejectCalls = PROBE_CALL_SCRIPT.filter((call) => "expectErrorPath" in call);
  for (const call of rejectCalls) {
    const part = byCall.get(call.id);
    check(part?.state?.status === "error", `${call.id} rejected as host tool error`);
    const errorText = toolErrorMessage(part);
    check(
      errorText.includes("INVALID_INPUT") && errorText.includes(call.expectErrorSubstring),
      `${call.id} presents actionable bounded diagnostic`,
    );
    check(
      errorText.includes(call.expectErrorPath),
      `${call.id} diagnostic includes exact actionable path ${call.expectErrorPath}`,
    );
    const executedForCall = obs.journal.some(
      (entry) => entry.kind === "exec" && entry.callID === call.id,
    );
    check(!executedForCall, `${call.id} caused no execute side effect`);
    const rejectedForCall = obs.journal.some(
      (entry) => entry.kind === "reject" && entry.callID === call.id,
    );
    check(rejectedForCall, `${call.id} recorded as guard reject before execute`);
  }

  const rejectEntries = obs.journal.filter((entry) => entry.kind === "reject");
  check(
    rejectEntries.length === rejectCalls.length,
    "guard rejected each invalid call before execute",
  );

  const presentation = obs.finalToolResultMessages.join("\n");
  check(
    presentation.includes("INVALID_INPUT"),
    "host-originated error presentation reaches model transcript",
  );
  check(presentation.includes("unexpected"), "unknown top-level diagnostic presented to model");
  check(presentation.includes("tpyo"), "nested typo diagnostic presented to model");
  check(presentation.includes("depth"), "malformed nested diagnostic presented to model");

  const forbiddenEnv = obs.childEnvKeys.filter((key) =>
    /^(OPENAI|ANTHROPIC|GROK|XAI|GEMINI|GOOGLE)_.*KEY$|^OPENCODE_AUTH_CONTENT$/.test(key),
  );
  check(forbiddenEnv.length === 0, "child env contains no provider credential keys");
  check(
    obs.childEnvKeys.includes("OPENCODE_DISABLE_DEFAULT_PLUGINS"),
    "child env disables host default plugins",
  );

  return { passed, failed };
}

/** Rows this feasibility probe intentionally does not cover. */
export function buildUnexercisedMatrix(): string[] {
  return [
    `OpenCode ${MINIMUM_SUPPORTED_HOST_VERSION} live binary (not available; minimum covered by derived fixtures only)`,
    "Anthropic-compatible loopback responder (deferred to full contracts:host runner)",
    "Google/Gemini schema-normalization live path (fixture-only in later task)",
    "Remote paid-provider/model acceptance (never exercised)",
    "Full nine-tool workflow/edit/web scenario matrix (later task)",
    "compatibility-evidence.json recording (later task)",
  ];
}

/** Render a bounded probe report; never claims unexercised rows passed. */
export function formatProbeReport(evaluation: ProbeEvaluation, obs: ProbeObservations): string {
  const lines: string[] = [];
  lines.push("vvoc tool-contract host probe report");
  lines.push(
    `hostVersion=${obs.hostVersion ?? "unknown"} authorized=${SUPPORTED_LIVE_HOST_VERSION}`,
  );
  lines.push(`packageIdentity=${obs.packageIdentity}`);
  lines.push(`contractTool=${PROBE_TOOL_ID}`);
  lines.push(`childEnvKeys=${[...obs.childEnvKeys].sort().join(",")}`);
  lines.push(`passed=${evaluation.passed.length} failed=${evaluation.failed.length}`);
  for (const item of evaluation.passed) lines.push(`  PASS ${item}`);
  for (const item of evaluation.failed) lines.push(`  FAIL ${item}`);
  lines.push("unexercised:");
  for (const row of buildUnexercisedMatrix()) lines.push(`  - ${row}`);
  return lines.join("\n");
}
// END_BLOCK_REPORT

// START_BLOCK_RESPONDER
type ResponderHandle = {
  port: number;
  requests: OutboundRequest[];
  stop: () => Promise<void>;
};

function sseBody(payloads: unknown[]): string {
  return `${payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join("")}data: [DONE]\n\n`;
}

function chunkBase(id: string, created: number) {
  return { id, object: "chat.completion.chunk", created, model: "probe-mini" };
}

function streamTextResponse(id: string, text: string): Response {
  const created = Math.floor(Date.now() / 1000);
  return new Response(
    sseBody([
      {
        ...chunkBase(id, created),
        choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
      },
      {
        ...chunkBase(id, created),
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ]),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function streamToolCallResponse(id: string, callId: string, args: unknown): Response {
  const created = Math.floor(Date.now() / 1000);
  const argsJson = JSON.stringify(args);
  return new Response(
    sseBody([
      {
        ...chunkBase(id, created),
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: callId,
                  type: "function",
                  function: { name: PROBE_TOOL_ID, arguments: "" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        ...chunkBase(id, created),
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: argsJson } }] },
            finish_reason: null,
          },
        ],
      },
      {
        ...chunkBase(id, created),
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ]),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** Start the deterministic loopback OpenAI-compatible SSE responder. */
export async function startLoopbackResponder(): Promise<ResponderHandle> {
  const requests: OutboundRequest[] = [];
  let sequence = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      const body = (await request.json()) as OutboundRequest;
      sequence += 1;
      requests.push(body);
      const id = `chatcmpl-${sequence}`;
      const messages = body.messages ?? [];
      const isTitle = messages.some(
        (message) =>
          typeof message.content === "string" && message.content.includes("title generator"),
      );
      if (isTitle) {
        return streamTextResponse(id, "VVOC Probe");
      }
      const toolNames = (body.tools ?? []).map((entry) => entry.function?.name ?? entry.name ?? "");
      const priorToolResults = messages.filter((message) => message.role === "tool").length;
      if (toolNames.includes(PROBE_TOOL_ID)) {
        if (priorToolResults < PROBE_CALL_SCRIPT.length) {
          const call = PROBE_CALL_SCRIPT[priorToolResults];
          return streamToolCallResponse(id, call.id, call.args);
        }
        return streamTextResponse(id, "PROBE_DONE");
      }
      return streamTextResponse(id, "PROBE_DONE");
    },
  });
  return {
    port: server.port ?? 0,
    requests,
    stop: async () => {
      server.stop(true);
    },
  };
}
// END_BLOCK_RESPONDER

// START_BLOCK_PROBE_PLUGIN
/** Generate the disposable local plugin that imports the real contract helper. */
export function generateProbePluginSource(options: {
  contractModuleUrl: string;
  journalPath: string;
}): string {
  return `import { tool } from "@opencode-ai/plugin";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  AGENT_TOOL_CONTRACT_REVISION,
  createPreExecuteGuard,
  createToolDefinitionAdapter,
  defineOwnedToolContract,
  ownedToolResult,
  parseOwnedToolArgs,
  strictObject,
} from ${JSON.stringify(options.contractModuleUrl)};

const schema = tool.schema;
const journalPath = ${JSON.stringify(options.journalPath)};

async function journal(entry) {
  await mkdir(dirname(journalPath), { recursive: true });
  await appendFile(journalPath, JSON.stringify(entry) + "\\n");
}

const contract = defineOwnedToolContract({
  toolId: ${JSON.stringify(PROBE_TOOL_ID)},
  description: "VVOC contract feasibility probe tool for host boundary checks.",
  registeredArgs: {
    label: schema.string().describe("Echo label"),
    mode: schema.enum(["quiet", "loud"]).default("quiet").describe("Echo mode"),
    nested: strictObject({
      depth: schema.number().int().min(0).default(0).optional().describe("Nested depth"),
    })
      .optional()
      .describe("Nested options"),
  },
  examples: [
    { operation: "echo", label: "accept omitting default", expect: "accept", input: { label: "alpha" } },
  ],
});

const definitionAdapter = createToolDefinitionAdapter([contract]);
const preExecuteGuard = createPreExecuteGuard([contract]);

const probeTool = {
  description: contract.description,
  args: contract.registeredArgs,
  execute: async (rawArgs, context) => {
    const parsed = parseOwnedToolArgs(contract, rawArgs);
    await journal({ kind: "exec", callID: context.callID, rawArgs, parsed });
    return ownedToolResult(
      JSON.stringify({ ok: true, revision: AGENT_TOOL_CONTRACT_REVISION, parsed }),
      { title: "probe" },
    );
  },
};

export const ProbePlugin = async () => ({
  tool: { [contract.toolId]: probeTool },
  "tool.definition": definitionAdapter,
  "tool.execute.before": async (input, output) => {
    try {
      await preExecuteGuard(input, output);
    } catch (error) {
      await journal({
        kind: "reject",
        callID: input.callID,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});
`;
}

function buildHostConfig(input: { port: number; pluginUrl: string }): string {
  return `${JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      provider: {
        probe: {
          npm: "@ai-sdk/openai-compatible",
          name: "VVOC Probe Local",
          options: {
            baseURL: `http://127.0.0.1:${input.port}/v1`,
            apiKey: "vvoc-probe-key",
          },
          models: { "probe-mini": { name: "Probe Mini" } },
        },
      },
      model: "probe/probe-mini",
      small_model: "probe/probe-mini",
      plugin: [input.pluginUrl],
      permission: { "*": "allow" },
      autoupdate: false,
      share: "disabled",
      autoshare: false,
      lsp: false,
    },
    null,
    2,
  )}\n`;
}
// END_BLOCK_PROBE_PLUGIN

// START_BLOCK_RUN_PROBE
function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 4_000_000) stdout = stdout.slice(-4_000_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 2_000_000) stderr = stderr.slice(-2_000_000);
    });
    child.on("close", (code) => {
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
    child.on("error", (error) => {
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code: 1, stdout, stderr: `${stderr}\n${String(error)}` });
    });
  });
}

function collectToolParts(events: RunEvent[]): ToolUsePart[] {
  const parts: ToolUsePart[] = [];
  for (const event of events) {
    if (event.type === "tool_use" && event.part?.tool) parts.push(event.part);
  }
  return parts;
}

function collectFinalToolMessages(requests: OutboundRequest[]): string[] {
  const lastWithTools = [...requests]
    .reverse()
    .find((request) => (request.messages ?? []).some((message) => message.role === "tool"));
  if (!lastWithTools) return [];
  return (lastWithTools.messages ?? [])
    .filter((message) => message.role === "tool")
    .map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    );
}

async function probePathsFor(root: string) {
  return {
    home: join(root, "home"),
    xdgConfig: join(root, "xdg-config"),
    xdgData: join(root, "xdg-data"),
    xdgCache: join(root, "xdg-cache"),
    tmp: join(root, "tmp"),
    workspace: join(root, "workspace"),
    harness: join(root, "harness"),
  };
}

/**
 * Run the full isolated live probe. Returns 0 only when every mandatory observation passes.
 * Cleanup uses try/finally and deletes only mkdtemp-owned roots under the session scratch parent.
 */
export async function runProbe(options?: { keep?: boolean; timeoutMs?: number }): Promise<number> {
  const repoRoot = resolve(new URL("..", import.meta.url).pathname);
  const contractModulePath = join(repoRoot, "src/lib/agent-tool-contract.ts");
  if (!existsSync(contractModulePath)) {
    console.error(`missing contract module: ${contractModulePath}`);
    return 1;
  }

  const scratchParent = process.env.VVOC_PROBE_TMP ?? PROBE_SCRATCH_PARENT;
  await mkdir(scratchParent, { recursive: true });

  // Isolated version probe: never inherits private HOME/config/history.
  let versionRoot: string | undefined;
  try {
    versionRoot = await mkdtemp(join(scratchParent, "version-"));
    const versionPaths = await probePathsFor(versionRoot);
    await mkdir(versionPaths.home, { recursive: true });
    await mkdir(versionPaths.xdgConfig, { recursive: true });
    await mkdir(versionPaths.xdgData, { recursive: true });
    await mkdir(versionPaths.xdgCache, { recursive: true });
    await mkdir(versionPaths.tmp, { recursive: true });
    const versionEnv = buildProbeEnv(process.env as Record<string, string | undefined>, {
      home: versionPaths.home,
      xdgConfig: versionPaths.xdgConfig,
      xdgData: versionPaths.xdgData,
      xdgCache: versionPaths.xdgCache,
      opencodeConfig: join(versionPaths.harness, "opencode.json"),
      tmp: versionPaths.tmp,
    });
    const versionResult = await runCommand("opencode", ["--version"], {
      cwd: versionPaths.home,
      env: versionEnv,
      timeoutMs: 15_000,
    });
    if (versionResult.code !== 0) {
      console.error(`opencode --version failed with code ${versionResult.code}`);
      return 1;
    }
    const hostVersion = parseHostVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
    if (!isSupportedLiveHostVersion(hostVersion)) {
      console.error(
        `unsupported or unavailable host: got ${hostVersion ?? "unknown"}, need ${SUPPORTED_LIVE_HOST_VERSION}`,
      );
      return 1;
    }
  } finally {
    if (versionRoot) await cleanupProbeRoot(versionRoot, scratchParent, false);
  }

  const packageIdentity = `${PACKAGE_NAME}@${PACKAGE_VERSION}#${AGENT_TOOL_CONTRACT_REVISION}`;
  let root: string | undefined;
  let responder: ResponderHandle | undefined;
  let exitCode = 1;

  try {
    root = await mkdtemp(join(scratchParent, "tool-contracts-host-"));
    const paths = await probePathsFor(root);
    for (const directory of Object.values(paths)) await mkdir(directory, { recursive: true });

    const nodeModulesLink = join(paths.harness, "node_modules");
    await symlinkSafe(join(repoRoot, "node_modules"), nodeModulesLink);

    const journalPath = join(root, "journal.jsonl");
    const pluginPath = join(paths.harness, "probe-plugin.ts");
    await writeFile(
      pluginPath,
      generateProbePluginSource({
        contractModuleUrl: pathToFileURL(contractModulePath).href,
        journalPath,
      }),
      "utf8",
    );

    responder = await startLoopbackResponder();
    const configPath = join(paths.harness, "opencode.json");
    await writeFile(
      configPath,
      buildHostConfig({ port: responder.port, pluginUrl: pathToFileURL(pluginPath).href }),
      "utf8",
    );

    const childEnv = buildProbeEnv(process.env as Record<string, string | undefined>, {
      home: paths.home,
      xdgConfig: paths.xdgConfig,
      xdgData: paths.xdgData,
      xdgCache: paths.xdgCache,
      opencodeConfig: configPath,
      tmp: paths.tmp,
    });

    const run = await runCommand(
      "opencode",
      ["run", "--format", "json", "Exercise the vvoc probe contract tool now."],
      {
        cwd: paths.workspace,
        env: childEnv,
        timeoutMs: options?.timeoutMs ?? 90_000,
      },
    );
    if (run.code !== 0) {
      console.error(`opencode run failed with code ${run.code}`);
      console.error(run.stderr.slice(0, 2000));
      exitCode = 1;
      return exitCode;
    }

    const stdoutParse = parseRunStdout(run.stdout);
    const journalParse = existsSync(journalPath)
      ? parseJournalText(await readFile(journalPath, "utf8"))
      : { entries: [], errors: ["journal file missing after successful run"] };

    const evidenceErrors = [...stdoutParse.errors, ...journalParse.errors];
    const obs: ProbeObservations = {
      hostVersion: SUPPORTED_LIVE_HOST_VERSION,
      outbound: responder.requests,
      toolParts: collectToolParts(stdoutParse.events),
      journal: journalParse.entries,
      finalToolResultMessages: collectFinalToolMessages(responder.requests),
      childEnvKeys: Object.keys(childEnv),
      evidenceErrors,
      packageIdentity,
    };
    const evaluation = evaluateProbeObservations(obs);
    console.log(formatProbeReport(evaluation, obs));
    exitCode = evaluation.failed.length > 0 ? 1 : 0;
    return exitCode;
  } catch (error) {
    console.error(`probe failed: ${error instanceof Error ? error.message : String(error)}`);
    exitCode = 1;
    return exitCode;
  } finally {
    try {
      if (responder) await responder.stop();
    } finally {
      if (root) await cleanupProbeRoot(root, scratchParent, options?.keep);
    }
  }
}

async function symlinkSafe(target: string, linkPath: string): Promise<void> {
  try {
    await rm(linkPath, { force: true });
  } catch {
    // ignore missing link
  }
  const { symlink } = await import("node:fs/promises");
  await symlink(target, linkPath, "dir");
}
// END_BLOCK_RUN_PROBE

// START_BLOCK_FULL_MATRIX_CONSTANTS
/** Version of the bounded compatibility-evidence document schema. */
export const CONTRACTS_HOST_EVIDENCE_VERSION = 1;
/** Repository-relative path observed host evidence is written to. */
export const HOST_EVIDENCE_RELATIVE_PATH =
  ".grace/changes/active/C-AGENT-TOOL-CONTRACTS/compatibility-evidence.json";
/** Hard cap on the serialized evidence document so payloads stay bounded. */
export const HOST_EVIDENCE_MAX_BYTES = 512 * 1024;
/** Synthetic Exa credential injected through the isolated project vvoc config (never a real key). */
export const SYNTHETIC_EXA_API_KEY = "vvoc-synthetic-exa-key";
/** Synthetic provider key written into the isolated OpenCode config (never inherited). */
export const SYNTHETIC_PROVIDER_KEY = "vvoc-synthetic-provider-key";
/** The nine vvoc-owned tools the union of the exercised cohorts must expose. */
export const OWNED_TOOL_IDS = [
  "work_item_open",
  "work_item_list",
  "work_item_close",
  "work_item_decide",
  "work_checkpoint",
  "hashline_edit",
  "str_replace_editor",
  "web_search",
  "web_fetch",
] as const;
/** Provenance URLs the derived provider-lowering fixtures and this matrix are based on. */
export const PROVENANCE_SOURCES = [
  {
    id: "host-registry-v1.18.2",
    url: "https://raw.githubusercontent.com/anomalyco/opencode/v1.18.2/packages/opencode/src/tool/registry.ts",
  },
  {
    id: "host-registry-v1.18.32",
    url: "https://raw.githubusercontent.com/anomalyco/opencode/v1.18.32/packages/opencode/src/tool/registry.ts",
  },
  {
    id: "host-session-tools-v1.18.2",
    url: "https://raw.githubusercontent.com/anomalyco/opencode/v1.18.2/packages/opencode/src/session/tools.ts",
  },
  {
    id: "host-provider-transform-v1.18.2",
    url: "https://raw.githubusercontent.com/anomalyco/opencode/v1.18.2/packages/opencode/src/provider/transform.ts",
  },
] as const;

/** One transport/cohort definition exercised by the live matrix. */
export type CohortDefinition = {
  readonly id: string;
  readonly transport: "openai-chat-completions" | "anthropic-messages";
  readonly providerNpm: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly editorTool: "str_replace_editor" | "hashline_edit";
  readonly endpointSuffix: string;
  /** The pinned provider schema route this transport actually takes. */
  readonly loweringRoute: string;
};

/** The two cohorts: an SDK-compatible OpenAI transport and the Anthropic messages transport. */
export const HOST_COHORTS: readonly CohortDefinition[] = [
  {
    id: "openai-compatible-strreplace",
    transport: "openai-chat-completions",
    providerNpm: "@ai-sdk/openai-compatible",
    providerId: "vvoc-probe-openai",
    modelId: "vvoc-deepseek-probe",
    editorTool: "str_replace_editor",
    endpointSuffix: "/chat/completions",
    loweringRoute:
      "provider/transform.ts schema(): no branch for @ai-sdk/openai-compatible, so no OpenAI sanitizeOpenAISchema lowering; published bounds are forwarded verbatim",
  },
  {
    id: "anthropic-messages-hashline",
    transport: "anthropic-messages",
    providerNpm: "@ai-sdk/anthropic",
    providerId: "vvoc-probe-anthropic",
    modelId: "vvoc-probe-alpha",
    editorTool: "hashline_edit",
    endpointSuffix: "/messages",
    loweringRoute:
      "anthropic SDK serializes tools as input_schema; provider/transform.ts has no anthropic schema branch, so the published schema is forwarded",
  },
];
// END_BLOCK_FULL_MATRIX_CONSTANTS

// START_BLOCK_FULL_MATRIX_TYPES
/** Normalized model-visible tool definition regardless of provider wire shape. */
export type NormalizedToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

/** One captured provider HTTP request (model or synthetic web provider). */
export type CapturedWebRequest = { url: string; method: string; body?: string };

/** Live observations for one isolated session. */
export type HostSessionContext = { workspace: string; port: number };

/** One scripted tool call issued by a loopback responder on behalf of the fake model. */
export type HostToolStep = {
  id: string;
  tool: string;
  buildArgs: (accumulatedText: string, context: HostSessionContext) => Record<string, unknown>;
  expect: "completed" | "error";
  /** Hook rejections never reach the handler; execute rejections do. */
  rejectionLevel?: "hook" | "execute";
  /** The mandatory diagnostic must name this code and tokenized path. */
  expectDiagnostic?: { code?: string; path?: string };
  /** Substrings the completed output must contain. */
  outputIncludes?: readonly string[];
  /** Parsed completed output must contain this deep subset (owned success semantics). */
  expectJson?: Record<string, unknown>;
  /** A completed call whose journaled result must carry this attachment MIME. */
  expectAttachmentMime?: string;
};

/** Built owned-tool descriptor loaded from the compiled dist package under test. */
export type BuiltToolDescriptor = {
  toolId: string;
  description: string;
  inputJsonSchema: Record<string, unknown>;
};

/**
 * Built contract context: identity, descriptors, and result validators loaded
 * from the actual compiled dist modules under test. Pure unit tests inject a
 * synthetic context; the live runner always loads dist.
 */
export type BuiltContractContext = {
  origin: "dist" | "synthetic";
  identity: { name: string; version: string; revision: string };
  descriptors: readonly BuiltToolDescriptor[];
  searchDefaultCount: number;
  fetchDefaultTimeoutSeconds: number;
  validateWorkflowResult: (tool: string, value: unknown) => { ok: boolean; detail?: string };
  validateHashlineMetadata: (value: unknown) => { ok: boolean; detail?: string };
  validateStrEditorMetadata: (value: unknown) => { ok: boolean; detail?: string };
  validateWebResult: (tool: string, value: unknown) => { ok: boolean; detail?: string };
};

/** One isolated host session: a scripted conversation plus its side-effect expectations. */
export type HostSessionSpec = {
  id: string;
  cohortId: string;
  prompt: string;
  workspaceFiles: Record<string, string>;
  steps: readonly HostToolStep[];
  /** A negative session must leave no workflow records/executions behind. */
  expectCleanWorkflowState: boolean;
  /** A negative session must dispatch zero synthetic web-provider requests. */
  expectNoWebDispatch: boolean;
  /** Files whose content must be identical before and after the run. */
  unchangedFiles: readonly string[];
  /** The exact union of tools the cohort's model must be able to see. */
  expectedToolNames: readonly string[];
  /** Owned editor tool this cohort must expose; the other editor must stay hidden. */
  visibleEditorTool: "str_replace_editor" | "hashline_edit";
  /** A completed web_search must have sent the documented default count to the provider. */
  expectSearchDefaultCount: boolean;
  /** Files whose post-run content must contain the given substring. */
  expectFileContent?: Record<string, string>;
  /** Persisted workflow counts/item states required after a positive run. */
  expectWorkflowState?: { records?: number; executions?: number; itemStates?: readonly string[] };
  doneText: string;
};

/** Per-case outcome recorded in the compatibility evidence. */
export type HostCaseRecord = {
  id: string;
  tool: string;
  expect: "completed" | "error";
  observedStatus: string;
  diagnosticPath?: string;
  rejectionLevel?: "hook" | "execute";
  /** Whether a completed owned workflow output validated against the built producer schema. */
  producerContract?: "ok" | "failed" | "not-applicable";
  ok: boolean;
};

/** Owned workflow tool ids whose public JSON output has a built producer result schema. */
const WORKFLOW_RESULT_TOOL_IDS = new Set<string>([
  "work_item_open",
  "work_item_list",
  "work_item_close",
  "work_item_decide",
  "work_checkpoint",
]);

/** Full observed result for one isolated session. */
export type HostSessionResult = {
  spec: HostSessionSpec;
  cohort: CohortDefinition;
  exitCode: number;
  sessionId: string | null;
  passed: string[];
  failed: string[];
  cases: HostCaseRecord[];
  definitions: NormalizedToolDefinition[];
  provider: {
    modelRequests: number;
    modelRequestsWithTools: number;
    webSearchRequests: number;
    webFetchRequests: number;
  };
  journal: { exec: number; reject: number; pluginErrors: string[] };
  state: {
    exists: boolean;
    records: number;
    executions: number;
    itemStates: string[];
  };
  workspaceFiles: string[];
  filesBefore: string[];
  fileHashes: Record<string, string>;
  fileContents: Record<string, string>;
  toolParts: ToolUsePart[];
  journalEntries: HarnessJournalEntry[];
  webSearchBodies: string[];
  childEnvKeys: string[];
  isolationIssues: string[];
  stdoutErrors: string[];
  stderrTail: string;
};
// END_BLOCK_FULL_MATRIX_TYPES

// START_BLOCK_FULL_MATRIX_HELPERS
function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function fingerprintFile(
  path: string,
): Promise<{ path: string; sha256: string; bytes: number } | null> {
  if (!existsSync(path)) return null;
  try {
    const text = await readFile(path, "utf8");
    return { path, sha256: sha256Text(text), bytes: Buffer.byteLength(text, "utf8") };
  } catch {
    return null;
  }
}

/** First capture group of a bounded regex, or the empty string. */
export function firstMatch(text: string, matcher: RegExp): string {
  const match = matcher.exec(text);
  return match?.[1] ?? "";
}

/** Extract the assigned work-item id from an accumulated conversation transcript. */
export function assignedWorkItemId(text: string): string {
  return firstMatch(text, /"workItemId":\s*"([^"]+)"/);
}

/** Extract the assigned generic execution run id from an accumulated transcript. */
export function assignedRunId(text: string): string {
  return firstMatch(text, /"runId":\s*"([^"]+)"/);
}

type WireMessage = { role?: string; content?: unknown; tool_calls?: unknown };

/** Flatten an OpenAI-style message list into searchable text (including tool results). */
export function flattenOpenAIText(messages: readonly WireMessage[]): string {
  const out: string[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      out.push(message.content);
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        const text = (part as { text?: unknown })?.text;
        if (typeof text === "string") out.push(text);
      }
    }
  }
  return out.join("\n");
}

/** Flatten an Anthropic-style message list into searchable text (including tool results). */
export function flattenAnthropicText(messages: readonly WireMessage[]): string {
  const out: string[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      out.push(message.content);
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const typed = part as { type?: unknown; text?: unknown; content?: unknown };
      if (typed.type === "text" && typeof typed.text === "string") out.push(typed.text);
      if (typed.type === "tool_result") {
        if (typeof typed.content === "string") out.push(typed.content);
        else if (Array.isArray(typed.content)) out.push(JSON.stringify(typed.content));
      }
    }
  }
  return out.join("\n");
}

/** Whether any user message carries the scripted subagent assignment marker. */
export function isChildRequest(
  transport: CohortDefinition["transport"],
  messages: readonly WireMessage[],
): boolean {
  for (const message of messages) {
    if (message.role !== "user") continue;
    if (typeof message.content === "string") {
      if (message.content.includes("<assignment>")) return true;
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const text = (part as { text?: unknown })?.text;
      if (typeof text === "string" && text.includes("<assignment>")) return true;
    }
  }
  return false;
}

/** Count completed tool results on the parent conversation (child sessions are excluded upstream). */
export function countToolResults(
  transport: CohortDefinition["transport"],
  messages: readonly WireMessage[],
): number {
  if (transport === "openai-chat-completions") {
    return messages.filter((message) => message.role === "tool").length;
  }
  let count = 0;
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    if (message.content.some((part) => (part as { type?: unknown })?.type === "tool_result"))
      count += 1;
  }
  return count;
}

/** Normalize the OpenAI wire tool definitions published to the model. */
export function normalizeOpenAIDefinitions(
  body: Record<string, unknown>,
): NormalizedToolDefinition[] {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const out: NormalizedToolDefinition[] = [];
  for (const entry of tools) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const fn =
      typeof record.function === "object" && record.function !== null
        ? (record.function as Record<string, unknown>)
        : record;
    const name = typeof fn.name === "string" ? fn.name : "";
    if (!name) continue;
    const parameters =
      typeof fn.parameters === "object" && fn.parameters !== null && !Array.isArray(fn.parameters)
        ? (fn.parameters as Record<string, unknown>)
        : {};
    out.push({
      name,
      description: typeof fn.description === "string" ? fn.description : "",
      parameters,
    });
  }
  return out;
}

/** Normalize the Anthropic wire tool definitions (input_schema) published to the model. */
export function normalizeAnthropicDefinitions(
  body: Record<string, unknown>,
): NormalizedToolDefinition[] {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const out: NormalizedToolDefinition[] = [];
  for (const entry of tools) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "";
    if (!name) continue;
    const parameters =
      typeof record.input_schema === "object" && record.input_schema !== null
        ? (record.input_schema as Record<string, unknown>)
        : {};
    out.push({
      name,
      description: typeof record.description === "string" ? record.description : "",
      parameters,
    });
  }
  return out;
}
// END_BLOCK_FULL_MATRIX_HELPERS

// START_BLOCK_FULL_MATRIX_JOURNAL
/** Harness journal entry recorded by the composing wrapper inside the isolated host process. */
export type HarnessJournalEntry =
  | {
      kind: "exec";
      tool: string;
      callID?: string;
      args: unknown;
      /** Wrapper's dist-schema verdict on the owned result before host-added metadata. */
      producerContract?: "ok" | "failed" | "not-applicable";
      producerDetail?: string;
      summary?: Record<string, unknown>;
      /** Bounded, shape-faithful owned result used for runner-side re-validation. */
      ownedResult?: Record<string, unknown>;
      /** Captured context.metadata report for edit tools. */
      metadataReport?: unknown;
    }
  | { kind: "exec_error"; tool: string; callID?: string; error: string }
  | { kind: "reject"; tool: string; callID?: string; error: string }
  | { kind: "plugin_error"; error: string };

/**
 * Fail-closed parser for the composing-wrapper journal.
 * Mandatory records that do not match the expected shape become bounded errors,
 * never silently dropped so a session can pass without side-effect evidence.
 */
export function parseHarnessJournalText(text: string): {
  entries: HarnessJournalEntry[];
  errors: string[];
} {
  const entries: HarnessJournalEntry[] = [];
  const errors: string[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim()) continue;
    const label = `harness journal line ${index + 1}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      errors.push(`${label}: invalid JSON`);
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      errors.push(`${label}: expected object record`);
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if (record.kind === "exec" && typeof record.tool === "string") {
      const producerContract =
        record.producerContract === "ok" ||
        record.producerContract === "failed" ||
        record.producerContract === "not-applicable"
          ? record.producerContract
          : undefined;
      entries.push({
        kind: "exec",
        tool: record.tool,
        ...(typeof record.callID === "string" ? { callID: record.callID } : {}),
        args: record.args,
        ...(typeof record.summary === "object" && record.summary !== null
          ? { summary: record.summary as Record<string, unknown> }
          : {}),
        ...(producerContract ? { producerContract } : {}),
        ...(typeof record.producerDetail === "string"
          ? { producerDetail: record.producerDetail }
          : {}),
        ...(typeof record.ownedResult === "object" && record.ownedResult !== null
          ? { ownedResult: record.ownedResult as Record<string, unknown> }
          : {}),
        ...("metadataReport" in record ? { metadataReport: record.metadataReport } : {}),
      });
      continue;
    }
    if (
      (record.kind === "exec_error" || record.kind === "reject") &&
      typeof record.tool === "string"
    ) {
      if (typeof record.error !== "string" || record.error.length === 0) {
        errors.push(`${label}: ${record.kind} record missing error string`);
        continue;
      }
      entries.push({
        kind: record.kind,
        tool: record.tool,
        ...(typeof record.callID === "string" ? { callID: record.callID } : {}),
        error: record.error,
      });
      continue;
    }
    if (record.kind === "plugin_error" && typeof record.error === "string") {
      entries.push({ kind: "plugin_error", error: record.error });
      continue;
    }
    errors.push(`${label}: unknown or malformed journal kind`);
  }
  return { entries, errors };
}
// END_BLOCK_FULL_MATRIX_JOURNAL

// START_BLOCK_FULL_MATRIX_RESPONDER
type HostResponder = {
  port: number;
  modelRequests: number;
  modelRequestsWithTools: number;
  definitions: NormalizedToolDefinition[];
  webSearchRequests: CapturedWebRequest[];
  webFetchRequests: CapturedWebRequest[];
  stop: () => Promise<void>;
};

/** Deterministic 8-result Exa response envelope matching the adapter's parse contract. */
function exaSearchFixture(): string {
  const results = Array.from({ length: 8 }, (_, index) => ({
    title: `Result ${index + 1}`,
    url: `https://example.test/r${index + 1}`,
    highlights: [`Snippet ${index + 1}`],
    publishedDate: "2026-01-0" + String((index % 9) + 1),
  }));
  return JSON.stringify({ results });
}

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

function openAISse(payloads: unknown[]): Response {
  return new Response(
    `${payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

function openAITextResponse(id: string, text: string): Response {
  return openAISse([
    {
      id,
      object: "chat.completion.chunk",
      created: 1,
      model: "probe",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    },
    {
      id,
      object: "chat.completion.chunk",
      created: 1,
      model: "probe",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ]);
}

function openAIToolCallResponse(id: string, callID: string, tool: string, args: unknown): Response {
  return openAISse([
    {
      id,
      object: "chat.completion.chunk",
      created: 1,
      model: "probe",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: callID,
                type: "function",
                function: { name: tool, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id,
      object: "chat.completion.chunk",
      created: 1,
      model: "probe",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
  ]);
}

function anthropicSse(events: [string, unknown][]): Response {
  return new Response(
    events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
}

function anthropicTextResponse(text: string): Response {
  return anthropicSse([
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg-host",
          type: "message",
          role: "assistant",
          model: "probe",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ],
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ]);
}

function anthropicToolCallResponse(callID: string, tool: string, args: unknown): Response {
  const partial = JSON.stringify(args);
  return anthropicSse([
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg-host",
          type: "message",
          role: "assistant",
          model: "probe",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ],
    [
      "content_block_start",
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: callID, name: tool, input: {} },
      },
    ],
    [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: partial },
      },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ]);
}

export type HostPlan = {
  steps: readonly HostToolStep[];
  childReport: (workItemId: string) => string;
  doneText: string;
};

/**
 * Start the deterministic loopback responder for one cohort.
 * It answers the provider model endpoint, the redirected synthetic Exa search,
 * and the synthetic web-fetch/media endpoints, and records every request.
 */
export async function startHostResponder(
  cohort: CohortDefinition,
  plan: HostPlan,
  context: HostSessionContext,
): Promise<HostResponder> {
  const webSearchRequests: CapturedWebRequest[] = [];
  const webFetchRequests: CapturedWebRequest[] = [];
  let modelRequests = 0;
  let modelRequestsWithTools = 0;
  let capturedDefinitions: NormalizedToolDefinition[] | undefined;

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/exa/search") {
        const body = await request.text();
        webSearchRequests.push({ url: request.url, method: "POST", body });
        return new Response(exaSearchFixture(), {
          headers: { "content-type": "application/json" },
        });
      }
      if (request.method === "GET" && url.pathname === "/fetch/text") {
        webFetchRequests.push({ url: request.url, method: "GET" });
        return new Response(
          "<html><body><h1>Heading One</h1><p>Body text from the synthetic page.</p></body></html>",
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      if (request.method === "GET" && url.pathname === "/fetch/media.png") {
        webFetchRequests.push({ url: request.url, method: "GET" });
        return new Response(PNG_BYTES, { headers: { "content-type": "image/png" } });
      }
      if (request.method !== "POST") return new Response("not found", { status: 404 });

      const expected =
        cohort.transport === "openai-chat-completions"
          ? url.pathname.endsWith("/chat/completions")
          : url.pathname.endsWith("/messages");
      if (!expected) return new Response("not found", { status: 404 });

      const body = (await request.json()) as Record<string, unknown>;
      modelRequests += 1;
      const messages = (Array.isArray(body.messages) ? body.messages : []) as WireMessage[];
      const tools = Array.isArray(body.tools) ? body.tools : [];
      if (tools.length > 0) {
        modelRequestsWithTools += 1;
        if (!capturedDefinitions) {
          capturedDefinitions =
            cohort.transport === "openai-chat-completions"
              ? normalizeOpenAIDefinitions(body)
              : normalizeAnthropicDefinitions(body);
        }
      }
      const id = `host-${modelRequests}`;

      const flatten =
        cohort.transport === "openai-chat-completions" ? flattenOpenAIText : flattenAnthropicText;
      if (isChildRequest(cohort.transport, messages)) {
        const childId = firstMatch(flatten(messages), /VVOC_WORK_ITEM_ID:\s*(\S+)/);
        const report = plan.childReport(childId);
        return cohort.transport === "openai-chat-completions"
          ? openAITextResponse(id, report)
          : anthropicTextResponse(report);
      }
      if (tools.length === 0) {
        return cohort.transport === "openai-chat-completions"
          ? openAITextResponse(id, "VVOC Host Matrix")
          : anthropicTextResponse("VVOC Host Matrix");
      }
      const results = countToolResults(cohort.transport, messages);
      if (results < plan.steps.length) {
        const step = plan.steps[results]!;
        const args = step.buildArgs(flatten(messages), context);
        const callID = `call-${step.id}`;
        return cohort.transport === "openai-chat-completions"
          ? openAIToolCallResponse(id, callID, step.tool, args)
          : anthropicToolCallResponse(callID, step.tool, args);
      }
      return cohort.transport === "openai-chat-completions"
        ? openAITextResponse(id, plan.doneText)
        : anthropicTextResponse(plan.doneText);
    },
  });
  context.port = server.port ?? 0;
  return {
    port: context.port,
    get modelRequests() {
      return modelRequests;
    },
    get modelRequestsWithTools() {
      return modelRequestsWithTools;
    },
    get definitions() {
      return capturedDefinitions ?? [];
    },
    webSearchRequests,
    webFetchRequests,
    stop: async () => {
      server.stop(true);
    },
  };
}
// END_BLOCK_FULL_MATRIX_RESPONDER

// START_BLOCK_FULL_MATRIX_WRAPPER
/**
 * Generate the disposable composing wrapper plugin.
 * It imports the real built dist plugin factories via local file URLs, merges
 * their hooks, and only adds observation journaling and the loopback transport
 * fixture redirect — it never replaces a registered handler.
 */
export function generateHostHarnessPluginSource(options: {
  workflowPluginUrl: string;
  hashlinePluginUrl: string;
  webPluginUrl: string;
  workflowResultsUrl: string;
  hashlineSchemasUrl: string;
  webSchemasUrl: string;
  journalPath: string;
  loopbackOrigin: string;
}): string {
  return `import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

const LOOPBACK = ${JSON.stringify(options.loopbackOrigin)};
const EXA_PREFIX = "https://api.exa.ai/";
const JOURNAL = ${JSON.stringify(options.journalPath)};
const WORKFLOW_TOOLS = new Set([
  "work_item_open",
  "work_item_list",
  "work_item_close",
  "work_item_decide",
  "work_checkpoint",
]);

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async function (input, init) {
  let raw;
  if (typeof input === "string") raw = input;
  else if (input instanceof URL) raw = input.href;
  else raw = input.url;
  let target;
  try {
    target = new URL(raw);
  } catch {
    throw new Error("VVOC_EGRESS_DENIED: malformed url");
  }
  // Redirects are never followed automatically: a loopback fixture that returns a
  // 3xx Location must not be able to bounce the request to an external origin.
  const safeInit = Object.assign({}, init, { redirect: "manual" });
  if (target.hostname === "127.0.0.1" || target.hostname === "localhost" || target.hostname === "::1") {
    return realFetch(input, safeInit);
  }
  if (raw.startsWith(EXA_PREFIX)) {
    return realFetch(LOOPBACK + "/exa" + target.pathname + target.search, safeInit);
  }
  throw new Error("VVOC_EGRESS_DENIED: " + target.origin);
};

async function journal(entry) {
  await mkdir(dirname(JOURNAL), { recursive: true });
  await appendFile(JOURNAL, JSON.stringify(entry) + "\\n");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function boundedString(value, cap) {
  if (typeof value !== "string") return undefined;
  return {
    value: value.slice(0, cap),
    bytes: Buffer.byteLength(value, "utf8"),
    sha256: sha256(value),
    bounded: value.length > cap,
  };
}

/** Summarize a validated owned result for the journal; opaque payloads are hashed, never faked. */
function summarize(result) {
  if (typeof result === "string") {
    const output = boundedString(result, 1500);
    return { outputPrefix: output && output.value, outputBytes: output && output.bytes, outputSha256: output && output.sha256 };
  }
  if (!result || typeof result !== "object") return {};
  const out = {};
  if (typeof result.output === "string") {
    const output = boundedString(result.output, 1500);
    out.outputPrefix = output && output.value;
    out.outputBytes = output && output.bytes;
    out.outputSha256 = output && output.sha256;
  }
  if (typeof result.title === "string") out.title = result.title.slice(0, 200);
  if (result.metadata !== undefined) out.metadata = result.metadata;
  if (Array.isArray(result.attachments)) {
    out.attachments = result.attachments.map(function (a) {
      const url = a && typeof a.url === "string" ? boundedString(a.url, 48) : undefined;
      return {
        type: a && a.type,
        mime: a && a.mime,
        filename: a && a.filename,
        urlPrefix: url && url.value,
        urlBytes: url && url.bytes,
        urlSha256: url && url.sha256,
        urlBounded: url ? url.bounded : undefined,
      };
    });
  }
  return out;
}

/** Shape-faithful bounded copy of the owned result for runner-side schema re-validation. */
function boundedOwnedResult(result) {
  if (typeof result === "string") return { output: result.slice(0, 4000) };
  if (!result || typeof result !== "object") return {};
  const out = {};
  if (typeof result.title === "string") out.title = result.title;
  if (typeof result.output === "string") out.output = result.output.slice(0, 4000);
  if (result.metadata !== undefined) out.metadata = result.metadata;
  if (Array.isArray(result.attachments)) {
    out.attachments = result.attachments.map(function (a) {
      const attachment = { type: a && a.type, mime: a && a.mime, url: typeof (a && a.url) === "string" ? a.url : "" };
      if (a && a.filename !== undefined) attachment.filename = a.filename;
      return attachment;
    });
  }
  return out;
}

const workflow = await import(${JSON.stringify(options.workflowPluginUrl)});
const hashline = await import(${JSON.stringify(options.hashlinePluginUrl)});
const web = await import(${JSON.stringify(options.webPluginUrl)});
const workflowResults = await import(${JSON.stringify(options.workflowResultsUrl)});
const hashlineSchemas = await import(${JSON.stringify(options.hashlineSchemasUrl)});
const webSchemas = await import(${JSON.stringify(options.webSchemasUrl)});
const factories = [workflow.WorkflowPlugin, hashline.HashlineEditPlugin, web.WebToolsPlugin];

function ownedOutput(result) {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && typeof result.output === "string") return result.output;
  return undefined;
}

/**
 * Validate the owned result before the host adds its own metadata, using the
 * compiled dist producer schemas. Never throws: a failure is journaled and the
 * actual result is passed through unchanged so the gate fails truthfully.
 */
function validateOwnedResult(tool, result, metadataReport) {
  if (WORKFLOW_TOOLS.has(tool)) {
    const text = ownedOutput(result);
    if (text === undefined) return { status: "failed", detail: "no owned workflow output string" };
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { status: "failed", detail: "owned workflow output is not JSON" };
    }
    const outcome = workflowResults.validateWorkflowToolResult(tool, parsed);
    return outcome.ok ? { status: "ok" } : { status: "failed", detail: "workflow result contract failed" };
  }
  if (tool === "hashline_edit") {
    if (!metadataReport) return { status: "failed", detail: "no metadata report captured" };
    return hashlineSchemas.hashlineEditMetadataSchema.safeParse(metadataReport.metadata).success
      ? { status: "ok" }
      : { status: "failed", detail: "hashline metadata contract failed" };
  }
  if (tool === "str_replace_editor") {
    if (!metadataReport) {
      return typeof result === "string" && result.length > 0
        ? { status: "ok", detail: "read-only text result" }
        : { status: "failed", detail: "str editor produced no result" };
    }
    return hashlineSchemas.strReplaceEditorMetadataSchema.safeParse(metadataReport.metadata).success
      ? { status: "ok" }
      : { status: "failed", detail: "str editor metadata contract failed" };
  }
  if (tool === "web_search") {
    return webSchemas.webSearchResultSchema.safeParse(result).success
      ? { status: "ok" }
      : { status: "failed", detail: "web_search result contract failed" };
  }
  if (tool === "web_fetch") {
    return webSchemas.webFetchResultSchema.safeParse(result).success
      ? { status: "ok" }
      : { status: "failed", detail: "web_fetch result contract failed" };
  }
  return { status: "not-applicable" };
}

export const VvocHostHarnessPlugin = async function (input) {
  const hooksList = [];
  for (const factory of factories) {
    try {
      hooksList.push(await factory(input));
    } catch (error) {
      await journal({
        kind: "plugin_error",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  const tool = {};
  for (const hooks of hooksList) {
    if (!hooks || !hooks.tool) continue;
    for (const id of Object.keys(hooks.tool)) {
      const original = hooks.tool[id];
      tool[id] = {
        ...original,
        execute: async function (args, context) {
          let metadataReport;
          let wrappedContext = context;
          if (context && typeof context.metadata === "function") {
            wrappedContext = Object.create(context);
            wrappedContext.metadata = async function (report) {
              metadataReport = report;
              return context.metadata(report);
            };
          }
          try {
            const result = await original.execute(args, wrappedContext);
            const verdict = validateOwnedResult(id, result, metadataReport);
            await journal({
              kind: "exec",
              tool: id,
              callID: context && context.callID,
              args: args,
              producerContract: verdict.status,
              producerDetail: verdict.detail,
              summary: summarize(result),
              ownedResult: boundedOwnedResult(result),
              metadataReport: metadataReport && metadataReport.metadata,
            });
            return result;
          } catch (error) {
            await journal({
              kind: "exec_error",
              tool: id,
              callID: context && context.callID,
              error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        },
      };
    }
  }

  const composed = { tool: tool };
  const keys = new Set();
  for (const hooks of hooksList) {
    if (!hooks) continue;
    for (const key of Object.keys(hooks)) keys.add(key);
  }
  for (const key of keys) {
    if (key === "tool") continue;
    const fns = [];
    for (const hooks of hooksList) {
      if (hooks && typeof hooks[key] === "function") fns.push(hooks[key]);
    }
    if (fns.length === 0) continue;
    if (key === "tool.execute.before") {
      composed[key] = async function (input, output) {
        for (const fn of fns) {
          try {
            await fn(input, output);
          } catch (error) {
            await journal({
              kind: "reject",
              tool: input && input.tool,
              callID: input && input.callID,
              error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        }
      };
    } else {
      composed[key] = async function (first, second) {
        for (const fn of fns) await fn(first, second);
      };
    }
  }
  return composed;
};
`;
}

/** Build the isolated OpenCode config for one cohort with synthetic agents only. */
export function buildCohortHostConfig(
  cohort: CohortDefinition,
  input: { port: number; pluginUrl: string },
): string {
  const model = `${cohort.providerId}/${cohort.modelId}`;
  return `${JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      provider: {
        [cohort.providerId]: {
          npm: cohort.providerNpm,
          name: "VVOC Local Probe",
          options: {
            baseURL: `http://127.0.0.1:${input.port}/v1`,
            apiKey: SYNTHETIC_PROVIDER_KEY,
          },
          models: { [cohort.modelId]: { name: "VVOC Probe Model" } },
        },
      },
      model,
      small_model: model,
      plugin: [input.pluginUrl],
      agent: {
        "vv-controller": {
          description: "Synthetic vv-controller for the isolated host contract matrix.",
          mode: "primary",
          model,
        },
        "vv-implementer": {
          description: "Synthetic vv-implementer child used by the isolated host contract matrix.",
          mode: "subagent",
          model,
        },
      },
      permission: { "*": "allow" },
      autoupdate: false,
      share: "disabled",
      autoshare: false,
      lsp: false,
    },
    null,
    2,
  )}\n`;
}

/** Build the isolated project vvoc config carrying only a synthetic Exa credential. */
export function buildHostVvocConfig(): string {
  const config = createDefaultVvocConfig();
  config.web = {
    search: { provider: "exa", apiKey: SYNTHETIC_EXA_API_KEY },
    fetch: { provider: "native" },
  };
  return renderVvocConfig(config);
}
// END_BLOCK_FULL_MATRIX_WRAPPER

// START_BLOCK_FULL_MATRIX_SPECS
const CHILD_REPORT = (workItemId: string): string =>
  `VVOC_WORK_ITEM_ID: ${workItemId}\nVVOC_STATUS: DONE\nVVOC_ROUTE: change_with_review\n\nSynthetic noop child body; no repository changes were made.`;

/** The positive OpenAI-compatible cohort: full delegated workflow plus edit write/view. */
function openAIPositiveSpec(): HostSessionSpec {
  return {
    id: "openai-positive",
    cohortId: HOST_COHORTS[0]!.id,
    prompt: "Execute the vvoc host contract positive matrix.",
    workspaceFiles: { "src/impl.ts": "export const impl = 0;\n" },
    steps: [
      {
        id: "open-delegated",
        tool: "work_item_open",
        expect: "completed",
        buildArgs: () => ({
          items: [
            {
              key: "k-impl",
              title: "Implement the scoped change",
              mode: "delegated",
              requiredReviewers: [],
              writeScope: ["src/impl.ts"],
            },
          ],
        }),
        outputIncludes: ['"tool": "work_item_open"', '"ok": true', '"workItemId": "wi-'],
        expectJson: { tool: "work_item_open", items: [{ ok: true }] },
      },
      {
        id: "launch-implementer",
        tool: "task",
        expect: "completed",
        buildArgs: (text) => ({
          description: "Delegated implementation",
          subagent_type: "vv-implementer",
          prompt: `VVOC_WORK_ITEM_ID: ${assignedWorkItemId(text)}\n<assignment>Apply the scoped change.</assignment>`,
        }),
        outputIncludes: ["VVOC_STATUS: DONE"],
      },
      {
        id: "accept",
        tool: "work_item_decide",
        expect: "completed",
        buildArgs: (text) => ({
          workItemId: assignedWorkItemId(text),
          attempt: 1,
          decision: "accept",
          rationale: "Verified the delegated implementation and tests.",
          evidence: ["src/impl.ts"],
        }),
        outputIncludes: ['"action": "accept"', '"state": "ready_to_close"'],
        expectJson: { ok: true, action: "accept", state: "ready_to_close" },
      },
      {
        id: "close",
        tool: "work_item_close",
        expect: "completed",
        buildArgs: (text) => ({ workItemId: assignedWorkItemId(text) }),
        outputIncludes: ['"state": "closed"'],
        expectJson: { ok: true, state: "closed" },
      },
      {
        id: "list-closed",
        tool: "work_item_list",
        expect: "completed",
        buildArgs: () => ({ includeClosed: true }),
        outputIncludes: ['"state": "closed"'],
        expectJson: { tool: "work_item_list", includeClosed: true },
      },
      {
        id: "open-generic",
        tool: "work_item_open",
        expect: "completed",
        buildArgs: () => ({
          items: [
            {
              key: "k-gen",
              title: "Generic execution task",
              mode: "delegated",
              requiredReviewers: [],
              writeScope: ["src/gen.ts"],
              taskId: "T-200",
            },
          ],
          execution: {
            executionKey: "exec-host-1",
            source: { kind: "conversation-scoped" },
            goal: "Deliver the generic execution.",
            boundary: { files: ["src/gen.ts", "src/gen2.ts"], directories: [] },
          },
        }),
        outputIncludes: ['"action": "register"', '"runId": "run-'],
        expectJson: { ok: true, action: "register" },
      },
      {
        id: "checkpoint-amend",
        tool: "work_checkpoint",
        expect: "completed",
        buildArgs: (text) => ({
          action: "amend",
          runId: assignedRunId(text),
          amendmentId: "amend-1",
          rationale: "Append the follow-up generic task.",
          tasks: [
            {
              key: "k-gen-2",
              title: "Generic follow-up task",
              mode: "delegated",
              requiredReviewers: [],
              writeScope: ["src/gen2.ts"],
              taskId: "T-201",
            },
          ],
        }),
        outputIncludes: ['"action": "amend"'],
        expectJson: { ok: true, action: "amend" },
      },
      {
        id: "str-create",
        tool: "str_replace_editor",
        expect: "completed",
        buildArgs: (_text, context) => ({
          command: "create",
          path: join(context.workspace, "src/created.txt"),
          file_text: "hello from host matrix\n",
        }),
      },
      {
        id: "str-view",
        tool: "str_replace_editor",
        expect: "completed",
        buildArgs: (_text, context) => ({
          command: "view",
          path: join(context.workspace, "src/created.txt"),
        }),
        outputIncludes: ["hello from host matrix"],
      },
    ],
    expectCleanWorkflowState: false,
    expectNoWebDispatch: false,
    unchangedFiles: [],
    expectedToolNames: [
      "work_item_open",
      "work_item_list",
      "work_item_close",
      "work_item_decide",
      "work_checkpoint",
      "str_replace_editor",
      "web_search",
      "web_fetch",
    ],
    visibleEditorTool: "str_replace_editor",
    expectSearchDefaultCount: false,
    expectFileContent: { "src/created.txt": "hello from host matrix" },
    expectWorkflowState: { records: 3, executions: 1, itemStates: ["closed"] },
    doneText: "VVOC_HOST_OPENAI_POSITIVE_DONE",
  };
}

/** The negative OpenAI-compatible cohort: structural rejections with no side effects. */
function openAINegativeSpec(): HostSessionSpec {
  return {
    id: "openai-negative",
    cohortId: HOST_COHORTS[0]!.id,
    prompt: "Execute the vvoc host contract rejection matrix.",
    workspaceFiles: { "src/kept.txt": "unchanged\n" },
    steps: [
      {
        id: "reject-bad-source-kind",
        tool: "work_item_open",
        expect: "error",
        rejectionLevel: "hook",
        expectDiagnostic: { code: "INVALID_INPUT", path: "execution.source.kind" },
        buildArgs: () => ({
          items: [
            {
              key: "k1",
              title: "Bad source",
              mode: "delegated",
              requiredReviewers: [],
              writeScope: ["src/a.ts"],
            },
          ],
          execution: {
            executionKey: "exec-bad",
            source: { kind: "conversation" },
            goal: "Bad source kind.",
            boundary: { files: ["src/a.ts"], directories: [] },
          },
        }),
      },
      {
        id: "reject-nested-unknown",
        tool: "work_item_open",
        expect: "error",
        rejectionLevel: "hook",
        expectDiagnostic: { code: "INVALID_INPUT", path: "items[0].tpyo" },
        buildArgs: () => ({
          items: [
            {
              key: "k2",
              title: "Unknown nested field",
              mode: "delegated",
              requiredReviewers: [],
              writeScope: ["src/a.ts"],
              tpyo: true,
            },
          ],
        }),
      },
      {
        id: "reject-checkpoint-nested-unknown",
        tool: "work_checkpoint",
        expect: "error",
        rejectionLevel: "hook",
        expectDiagnostic: { code: "INVALID_INPUT", path: "tasks[0].tpyo" },
        buildArgs: () => ({
          action: "amend",
          runId: "run-missing",
          amendmentId: "amend-x",
          rationale: "Unknown nested checkpoint task field.",
          tasks: [
            {
              key: "k",
              title: "Unknown nested task field",
              mode: "delegated",
              requiredReviewers: [],
              writeScope: ["src/a.ts"],
              tpyo: true,
            },
          ],
        }),
      },
      {
        id: "reject-reserved-stop-typo",
        tool: "work_checkpoint",
        expect: "error",
        rejectionLevel: "hook",
        expectDiagnostic: { code: "INVALID_INPUT", path: "reservedStops[0]" },
        buildArgs: () => ({
          action: "authorize",
          runId: "run-missing",
          authorityId: "auth-1",
          messageId: "msg-1",
          stages: ["implementation"],
          reservedStops: ["verificaton"],
        }),
      },
      {
        id: "reject-str-missing-old",
        tool: "str_replace_editor",
        expect: "error",
        rejectionLevel: "hook",
        expectDiagnostic: { code: "INVALID_INPUT", path: "old_str" },
        buildArgs: (_text, context) => ({
          command: "str_replace",
          path: join(context.workspace, "src/kept.txt"),
        }),
      },
    ],
    expectCleanWorkflowState: true,
    expectNoWebDispatch: true,
    unchangedFiles: ["src/kept.txt"],
    expectedToolNames: [
      "work_item_open",
      "work_item_list",
      "work_item_close",
      "work_item_decide",
      "work_checkpoint",
      "str_replace_editor",
      "web_search",
      "web_fetch",
    ],
    visibleEditorTool: "str_replace_editor",
    expectSearchDefaultCount: false,
    doneText: "VVOC_HOST_OPENAI_NEGATIVE_DONE",
  };
}

/** The positive Anthropic cohort: workflow open/list, hashline write, and web search/fetch/media. */
function anthropicPositiveSpec(): HostSessionSpec {
  return {
    id: "anthropic-positive",
    cohortId: HOST_COHORTS[1]!.id,
    prompt: "Execute the vvoc host contract positive matrix.",
    workspaceFiles: { "src/edit.txt": "alpha\nbeta\n" },
    steps: [
      {
        id: "open-implementation",
        tool: "work_item_open",
        expect: "completed",
        buildArgs: () => ({
          items: [
            {
              key: "k-impl",
              title: "Review the surfaced contract",
              mode: "implementation",
              requiredReviewers: ["spec"],
            },
          ],
        }),
        outputIncludes: ['"ok": true'],
        expectJson: { tool: "work_item_open", items: [{ ok: true }] },
      },
      {
        id: "list-open",
        tool: "work_item_list",
        expect: "completed",
        buildArgs: () => ({}),
        outputIncludes: ['"items"'],
        expectJson: { tool: "work_item_list", includeClosed: false },
      },
      {
        id: "hashline-append",
        tool: "hashline_edit",
        expect: "completed",
        buildArgs: (_text, context) => ({
          filePath: join(context.workspace, "src/edit.txt"),
          edits: [{ op: "append", lines: ["gamma"] }],
        }),
      },
      {
        id: "hashline-view",
        tool: "read",
        expect: "completed",
        buildArgs: (_text, context) => ({ filePath: join(context.workspace, "src/edit.txt") }),
        outputIncludes: ["|gamma"],
      },
      {
        id: "web-search-default",
        tool: "web_search",
        expect: "completed",
        buildArgs: () => ({ query: "vvoc host matrix default count" }),
        outputIncludes: ["Result 8"],
      },
      {
        id: "web-fetch-text",
        tool: "web_fetch",
        expect: "completed",
        buildArgs: (_text, context) => ({ url: `http://127.0.0.1:${context.port}/fetch/text` }),
        outputIncludes: ["Heading One"],
      },
      {
        id: "web-fetch-media",
        tool: "web_fetch",
        expect: "completed",
        buildArgs: (_text, context) => ({
          url: `http://127.0.0.1:${context.port}/fetch/media.png`,
        }),
        expectAttachmentMime: "image/png",
      },
    ],
    expectCleanWorkflowState: false,
    expectNoWebDispatch: false,
    unchangedFiles: [],
    expectedToolNames: [
      "work_item_open",
      "work_item_list",
      "work_item_close",
      "work_item_decide",
      "work_checkpoint",
      "hashline_edit",
      "web_search",
      "web_fetch",
    ],
    visibleEditorTool: "hashline_edit",
    expectSearchDefaultCount: true,
    expectFileContent: { "src/edit.txt": "gamma" },
    expectWorkflowState: { records: 1, executions: 0 },
    doneText: "VVOC_HOST_ANTHROPIC_POSITIVE_DONE",
  };
}

/** The negative Anthropic cohort: invalid web/edit inputs with no dispatch or file change. */
function anthropicNegativeSpec(): HostSessionSpec {
  return {
    id: "anthropic-negative",
    cohortId: HOST_COHORTS[1]!.id,
    prompt: "Execute the vvoc host contract rejection matrix.",
    workspaceFiles: { "src/kept.txt": "unchanged\n" },
    steps: [
      {
        id: "reject-web-count",
        tool: "web_search",
        expect: "error",
        rejectionLevel: "hook",
        expectDiagnostic: { code: "INVALID_INPUT", path: "count" },
        buildArgs: () => ({ query: "vvoc", count: 99 }),
      },
      {
        id: "reject-web-format",
        tool: "web_fetch",
        expect: "error",
        rejectionLevel: "hook",
        expectDiagnostic: { code: "INVALID_INPUT", path: "format" },
        buildArgs: (_text, context) => ({
          url: `http://127.0.0.1:${context.port}/fetch/text`,
          format: "pdf",
        }),
      },
      {
        id: "reject-web-timeout",
        tool: "web_fetch",
        expect: "error",
        rejectionLevel: "hook",
        expectDiagnostic: { code: "INVALID_INPUT", path: "timeout" },
        buildArgs: (_text, context) => ({
          url: `http://127.0.0.1:${context.port}/fetch/text`,
          timeout: 0,
        }),
      },
      {
        id: "reject-hashline-op",
        tool: "hashline_edit",
        expect: "error",
        rejectionLevel: "hook",
        expectDiagnostic: { code: "INVALID_INPUT", path: "edits[0].op" },
        buildArgs: (_text, context) => ({
          filePath: join(context.workspace, "src/kept.txt"),
          edits: [{ op: "frobnicate", lines: ["x"] }],
        }),
      },
      {
        id: "reject-hashline-unknown",
        tool: "hashline_edit",
        expect: "error",
        rejectionLevel: "hook",
        expectDiagnostic: { code: "INVALID_INPUT", path: "edits[0].tpyo" },
        buildArgs: (_text, context) => ({
          filePath: join(context.workspace, "src/kept.txt"),
          edits: [{ op: "append", lines: ["x"], tpyo: 1 }],
        }),
      },
    ],
    expectCleanWorkflowState: true,
    expectNoWebDispatch: true,
    unchangedFiles: ["src/kept.txt"],
    expectedToolNames: [
      "work_item_open",
      "work_item_list",
      "work_item_close",
      "work_item_decide",
      "work_checkpoint",
      "hashline_edit",
      "web_search",
      "web_fetch",
    ],
    visibleEditorTool: "hashline_edit",
    expectSearchDefaultCount: false,
    doneText: "VVOC_HOST_ANTHROPIC_NEGATIVE_DONE",
  };
}

/** All four isolated sessions that make up the bounded live matrix, in execution order. */
export function hostSessionSpecs(): HostSessionSpec[] {
  return [
    openAIPositiveSpec(),
    openAINegativeSpec(),
    anthropicPositiveSpec(),
    anthropicNegativeSpec(),
  ];
}
// END_BLOCK_FULL_MATRIX_SPECS

// START_BLOCK_FULL_MATRIX_EVALUATION
function sessionCheck(passed: string[], failed: string[]) {
  return (ok: boolean, label: string) => {
    if (ok) passed.push(label);
    else failed.push(label);
  };
}

/** Recursively list workspace files (bounded) for side-effect comparison. */
async function listWorkspaceFiles(root: string, prefix = "", depth = 0): Promise<string[]> {
  if (depth > 6) return [];
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(join(root, prefix), { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(`${relative}/`);
      out.push(...(await listWorkspaceFiles(root, relative, depth + 1)));
    } else {
      out.push(relative);
    }
    if (out.length > 400) return out;
  }
  return out;
}

async function stateSummary(
  xdgData: string,
  sessionId: string | null,
): Promise<{ exists: boolean; records: number; executions: number; itemStates: string[] }> {
  const path = sessionId ? join(xdgData, "vvoc", "workflow", sessionId, "workflow-state.json") : "";
  if (!path || !existsSync(path))
    return { exists: false, records: 0, executions: 0, itemStates: [] };
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      records?: unknown;
      executions?: unknown;
    };
    const records = Array.isArray(parsed.records) ? parsed.records : [];
    const itemStates: string[] = [];
    for (const record of records) {
      const state = (record as { state?: unknown })?.state;
      if (typeof state === "string") itemStates.push(state);
    }
    return {
      exists: true,
      records: records.length,
      executions: Array.isArray(parsed.executions) ? parsed.executions.length : 0,
      itemStates,
    };
  } catch {
    return { exists: true, records: -1, executions: -1, itemStates: [] };
  }
}

/** First structural difference path between two JSON values, bounded to one path. */
export function firstDifference(left: unknown, right: unknown, path = ""): string | undefined {
  if (left === right) return undefined;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return path || "(root)";
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return path || "(root)";
    }
    for (let index = 0; index < left.length; index += 1) {
      const difference = firstDifference(left[index], right[index], `${path}[${index}]`);
      if (difference) return difference;
    }
    return undefined;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
  for (const key of keys) {
    const difference = firstDifference(
      leftRecord[key],
      rightRecord[key],
      path ? `${path}.${key}` : key,
    );
    if (difference) return difference;
  }
  return undefined;
}

/**
 * Compare an observed model-visible definition against the built descriptor.
 * The exercised transports take no OpenAI sanitization, so the wire schema must
 * equal the published contract exactly; any unknown drift is a hard failure and
 * is never normalized away.
 */
export function compareProjection(
  observed: NormalizedToolDefinition,
  expected: BuiltToolDescriptor,
): { ok: boolean; detail?: string } {
  if (observed.description !== expected.description) {
    return { ok: false, detail: "description drift" };
  }
  const difference = firstDifference(observed.parameters, expected.inputJsonSchema);
  return difference ? { ok: false, detail: `schema drift at ${difference}` } : { ok: true };
}

/** Deep subset match used for owned success semantics (`ok`/`action`/`state`). */
export function subsetMatch(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== "object") return actual === expected;
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, index) => subsetMatch(actual[index], item))
    );
  }
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
  const actualRecord = actual as Record<string, unknown>;
  return Object.entries(expected as Record<string, unknown>).every(
    ([key, value]) => key in actualRecord && subsetMatch(actualRecord[key], value),
  );
}

/** Reference asset path suffix the loaded identity must resolve within the package. */
export const TOOL_CONTRACT_REFERENCE_SUFFIX =
  "templates/skills/vv-execute/references/tool-contracts.md";

/** Evaluate all observed evidence for one isolated session; every failure is a nonzero-stop condition. */
export function evaluateHostSession(
  result: Omit<HostSessionResult, "passed" | "failed" | "cases">,
  built: BuiltContractContext,
): { passed: string[]; failed: string[]; cases: HostCaseRecord[] } {
  const passed: string[] = [];
  const failed: string[] = [];
  const check = sessionCheck(passed, failed);
  const cases: HostCaseRecord[] = [];
  const descriptorById = new Map(
    built.descriptors.map((descriptor) => [descriptor.toolId, descriptor]),
  );

  check(result.exitCode === 0, `session ${result.spec.id} host process exited 0`);
  check(
    result.stdoutErrors.length === 0,
    `session ${result.spec.id} host stdout parsed without malformed records`,
  );
  check(
    result.journal.pluginErrors.length === 0,
    `session ${result.spec.id} all dist plugin factories loaded`,
  );
  check(
    result.isolationIssues.length === 0,
    `session ${result.spec.id} child isolation settings held`,
  );
  for (const error of result.stdoutErrors) check(false, `stdout: ${error}`);
  for (const error of result.journal.pluginErrors) check(false, `plugin: ${error}`);
  for (const issue of result.isolationIssues) check(false, `${result.spec.id}: ${issue}`);

  const partByCall = new Map<string, ToolUsePart>();
  const execByCall = new Map<string, { kind: "exec" } & HarnessJournalEntry>();
  const rejectByCall = new Set<string>();
  for (const entry of result.journalEntries) {
    if (entry.kind === "exec" && entry.callID) execByCall.set(entry.callID, entry);
    if (entry.kind === "reject" && entry.callID) rejectByCall.add(entry.callID);
  }
  for (const part of result.toolParts) {
    if (part.callID) partByCall.set(part.callID, part);
  }

  for (const step of result.spec.steps) {
    const callID = `call-${step.id}`;
    const part = partByCall.get(callID);
    const executed = execByCall.get(callID);
    const observedStatus = part?.state?.status ?? "missing";
    const errorText = typeof part?.state?.error === "string" ? part.state.error : "";
    const outputText = typeof part?.state?.output === "string" ? part.state.output : "";
    let producerContract: HostCaseRecord["producerContract"] = "not-applicable";
    let ok = true;
    const fail = (label: string) => {
      ok = false;
      check(false, `session ${result.spec.id} ${step.id}: ${label}`);
    };
    if (!part) {
      fail("no host tool result was observed");
    } else if (step.expect === "completed") {
      if (observedStatus !== "completed") fail(`expected completed, observed ${observedStatus}`);
      if (!outputText) fail("completed host result carried no owned output body");
      for (const marker of step.outputIncludes ?? []) {
        if (!outputText.includes(marker)) fail(`output missing marker ${JSON.stringify(marker)}`);
      }
      if (step.expectJson) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(outputText);
        } catch {
          fail("completed output is not JSON despite expected owned semantics");
        }
        if (parsed !== undefined && !subsetMatch(parsed, step.expectJson)) {
          fail(`owned success semantics drift: expected ${JSON.stringify(step.expectJson)}`);
        }
      }
      if (WORKFLOW_RESULT_TOOL_IDS.has(step.tool)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(outputText);
        } catch {
          parsed = undefined;
        }
        if (parsed === undefined) {
          fail("owned workflow output is not JSON");
        } else {
          const outcome = built.validateWorkflowResult(step.tool, parsed);
          producerContract = outcome.ok ? "ok" : "failed";
          if (!outcome.ok) fail(`built workflow result contract failed: ${outcome.detail ?? ""}`);
        }
      }
      const ownedTool = (OWNED_TOOL_IDS as readonly string[]).includes(step.tool);
      if (ownedTool) {
        if (executed?.kind !== "exec") {
          fail("no owned result was journaled before host-added metadata");
          producerContract = "failed";
        } else {
          if (executed.producerContract !== "ok") {
            fail(
              `wrapper dist-schema verdict was ${executed.producerContract ?? "missing"} (${executed.producerDetail ?? ""})`,
            );
            producerContract = "failed";
          } else {
            producerContract = "ok";
          }
          if (step.tool === "web_search" || step.tool === "web_fetch") {
            const revalidated = built.validateWebResult(step.tool, executed.ownedResult);
            producerContract = revalidated.ok ? "ok" : "failed";
            if (!revalidated.ok)
              fail(`built web result contract failed: ${revalidated.detail ?? ""}`);
          }
          if (step.tool === "hashline_edit" && executed.metadataReport !== undefined) {
            const revalidated = built.validateHashlineMetadata(executed.metadataReport);
            producerContract = revalidated.ok ? "ok" : "failed";
            if (!revalidated.ok)
              fail(`built hashline metadata contract failed: ${revalidated.detail ?? ""}`);
          }
          if (step.tool === "str_replace_editor" && executed.metadataReport !== undefined) {
            const revalidated = built.validateStrEditorMetadata(executed.metadataReport);
            producerContract = revalidated.ok ? "ok" : "failed";
            if (!revalidated.ok)
              fail(`built str editor metadata contract failed: ${revalidated.detail ?? ""}`);
          }
          if (step.expectAttachmentMime) {
            const attachments = Array.isArray(executed.ownedResult?.attachments)
              ? (executed.ownedResult?.attachments as { mime?: unknown }[])
              : [];
            if (!attachments.some((attachment) => attachment.mime === step.expectAttachmentMime)) {
              fail(`journaled result missing ${step.expectAttachmentMime} attachment`);
            }
          }
        }
      }
    } else {
      if (observedStatus !== "error") fail(`expected error, observed ${observedStatus}`);
      if (step.expectDiagnostic?.code && !errorText.includes(step.expectDiagnostic.code)) {
        fail(`diagnostic missing code ${step.expectDiagnostic.code}`);
      }
      if (step.expectDiagnostic?.path && !errorText.includes(step.expectDiagnostic.path)) {
        fail(`diagnostic missing actionable path ${step.expectDiagnostic.path}`);
      }
      if ((step.rejectionLevel ?? "hook") === "hook") {
        if (execByCall.has(callID)) fail("execute ran despite a pre-execute rejection");
        if (!rejectByCall.has(callID)) fail("no guard rejection was journaled before execute");
      }
    }
    cases.push({
      id: step.id,
      tool: step.tool,
      expect: step.expect,
      observedStatus,
      ...(step.expectDiagnostic?.path ? { diagnosticPath: step.expectDiagnostic.path } : {}),
      ...(step.rejectionLevel ? { rejectionLevel: step.rejectionLevel } : {}),
      producerContract,
      ok,
    });
    if (ok) check(true, `session ${result.spec.id} case ${step.id} (${step.tool})`);
  }

  // Exact model-visible projection: every owned definition must equal the built
  // descriptor under the known no-lowering route; only the cohort's editor is visible.
  const definitionNames = result.definitions.map((definition) => definition.name);
  for (const name of result.spec.expectedToolNames) {
    const observed = result.definitions.find((definition) => definition.name === name);
    if (!observed) {
      check(false, `session ${result.spec.id} wire definition ${name} missing`);
      continue;
    }
    const expected = descriptorById.get(name);
    if (!expected) {
      check(false, `session ${result.spec.id} built descriptor ${name} missing`);
      continue;
    }
    const projection = compareProjection(observed, expected);
    check(
      projection.ok,
      `session ${result.spec.id} ${name} exact projection (${projection.detail ?? "match"})`,
    );
    if (!projection.ok) check(false, `session ${result.spec.id} ${name}: ${projection.detail}`);
  }
  const hiddenEditor =
    result.spec.visibleEditorTool === "hashline_edit" ? "str_replace_editor" : "hashline_edit";
  check(
    !definitionNames.includes(hiddenEditor),
    `session ${result.spec.id} hidden editor ${hiddenEditor} is not exposed`,
  );

  // Loaded package identity observed through work_item_list must match built identity.
  const listStep = result.spec.steps.find(
    (step) => step.tool === "work_item_list" && step.expect === "completed",
  );
  if (listStep) {
    const listPart = partByCall.get(`call-${listStep.id}`);
    const listOutput = typeof listPart?.state?.output === "string" ? listPart.state.output : "";
    try {
      const parsed = JSON.parse(listOutput) as { contract?: Record<string, unknown> };
      const contract = parsed.contract ?? {};
      check(
        contract.packageName === built.identity.name &&
          contract.packageVersion === built.identity.version &&
          contract.toolContractRevision === built.identity.revision,
        `session ${result.spec.id} work_item_list reports the built package identity`,
      );
      check(
        typeof contract.referencePath === "string" &&
          contract.referencePath.endsWith(TOOL_CONTRACT_REFERENCE_SUFFIX),
        `session ${result.spec.id} work_item_list resolves the packaged reference path`,
      );
    } catch {
      check(false, `session ${result.spec.id} work_item_list output is not JSON`);
    }
  }

  if (result.spec.expectSearchDefaultCount) {
    check(
      result.webSearchBodies.some((body) => {
        try {
          return (
            (JSON.parse(body) as { numResults?: unknown }).numResults === built.searchDefaultCount
          );
        } catch {
          return false;
        }
      }),
      `session ${result.spec.id} web_search sent the documented default count to the provider`,
    );
  }

  if (result.spec.expectCleanWorkflowState) {
    check(
      !result.state.exists || (result.state.records === 0 && result.state.executions === 0),
      `session ${result.spec.id} left no workflow records or executions behind`,
    );
  }
  if (result.spec.expectWorkflowState) {
    const expected = result.spec.expectWorkflowState;
    if (expected.records !== undefined) {
      check(
        result.state.records === expected.records,
        `session ${result.spec.id} workflow record count is ${expected.records}`,
      );
    }
    if (expected.executions !== undefined) {
      check(
        result.state.executions === expected.executions,
        `session ${result.spec.id} workflow execution count is ${expected.executions}`,
      );
    }
    for (const state of expected.itemStates ?? []) {
      check(
        result.state.itemStates.includes(state),
        `session ${result.spec.id} workflow reached state ${state}`,
      );
    }
  }
  if (result.spec.expectNoWebDispatch) {
    check(
      result.provider.webSearchRequests === 0,
      `session ${result.spec.id} dispatched no search request`,
    );
    check(
      result.provider.webFetchRequests === 0,
      `session ${result.spec.id} dispatched no fetch request`,
    );
  }
  for (const file of result.spec.unchangedFiles) {
    check(
      result.fileHashes[file] !== undefined &&
        result.fileHashes[file] === result.fileHashes[`before:${file}`],
      `session ${result.spec.id} file ${file} unchanged after rejected calls`,
    );
  }
  for (const [file, expected] of Object.entries(result.spec.expectFileContent ?? {})) {
    check(
      (result.fileContents[file] ?? "").includes(expected),
      `session ${result.spec.id} file ${file} content contains ${JSON.stringify(expected)}`,
    );
  }
  if (result.spec.unchangedFiles.length > 0) {
    const before = new Set(result.filesBefore);
    const added = result.workspaceFiles.filter((entry) => !before.has(entry));
    check(added.length === 0, `session ${result.spec.id} rejected calls added no workspace files`);
    for (const entry of added)
      check(false, `${result.spec.id}: unexpected workspace entry ${entry}`);
  }
  const rejectedCalls = result.spec.steps.filter((step) => step.expect === "error");
  const journalRejects = result.journalEntries.filter((entry) => entry.kind === "reject").length;
  check(
    journalRejects >= rejectedCalls.length,
    `session ${result.spec.id} journaled a guard rejection for every rejected call`,
  );
  return { passed, failed, cases };
}
// END_BLOCK_FULL_MATRIX_EVALUATION

// START_BLOCK_FULL_MATRIX_SESSION
async function runHostSession(
  spec: HostSessionSpec,
  built: BuiltContractContext,
  scratchParent: string,
  options: { keep?: boolean; timeoutMs?: number },
): Promise<HostSessionResult> {
  const cohort = HOST_COHORTS.find((entry) => entry.id === spec.cohortId);
  if (!cohort) throw new Error(`unknown cohort ${spec.cohortId}`);
  const repoRoot = resolve(new URL("..", import.meta.url).pathname);
  const root = await mkdtemp(join(scratchParent, `matrix-${spec.id}-`));
  const paths = {
    home: join(root, "home"),
    xdgConfig: join(root, "xdg-config"),
    xdgData: join(root, "xdg-data"),
    xdgCache: join(root, "xdg-cache"),
    tmp: join(root, "tmp"),
    workspace: join(root, "workspace"),
    harness: join(root, "harness"),
  };
  const context: HostSessionContext = { workspace: paths.workspace, port: 0 };
  let responder: HostResponder | undefined;
  try {
    for (const directory of Object.values(paths)) await mkdir(directory, { recursive: true });
    for (const [relative, content] of Object.entries(spec.workspaceFiles)) {
      const absolute = join(paths.workspace, relative);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, content, "utf8");
    }
    await mkdir(join(paths.workspace, ".vvoc"), { recursive: true });
    await writeFile(join(paths.workspace, ".vvoc", "vvoc.json"), buildHostVvocConfig(), "utf8");
    await symlinkSafe(join(repoRoot, "node_modules"), join(paths.harness, "node_modules"));

    const filesBefore = await listWorkspaceFiles(paths.workspace);
    const hashesBefore: Record<string, string> = {};
    for (const file of spec.unchangedFiles) {
      const absolute = join(paths.workspace, file);
      hashesBefore[`before:${file}`] = existsSync(absolute)
        ? sha256Text(await readFile(absolute, "utf8"))
        : "";
    }

    const plan: HostPlan = {
      steps: spec.steps,
      childReport: (workItemId) => CHILD_REPORT(workItemId),
      doneText: spec.doneText,
    };
    responder = await startHostResponder(cohort, plan, context);

    const journalPath = join(root, "harness-journal.jsonl");
    const pluginPath = join(paths.harness, "host-harness-plugin.ts");
    await writeFile(
      pluginPath,
      generateHostHarnessPluginSource({
        workflowPluginUrl: pathToFileURL(join(repoRoot, "dist/plugins/workflow/index.js")).href,
        hashlinePluginUrl: pathToFileURL(join(repoRoot, "dist/plugins/hashline-edit/index.js"))
          .href,
        webPluginUrl: pathToFileURL(join(repoRoot, "dist/plugins/web-tools/index.js")).href,
        workflowResultsUrl: pathToFileURL(join(repoRoot, "dist/plugins/workflow/results.js")).href,
        hashlineSchemasUrl: pathToFileURL(join(repoRoot, "dist/plugins/hashline-edit/schemas.js"))
          .href,
        webSchemasUrl: pathToFileURL(join(repoRoot, "dist/plugins/web-tools/schemas.js")).href,
        journalPath,
        loopbackOrigin: `http://127.0.0.1:${context.port}`,
      }),
      "utf8",
    );
    const configPath = join(paths.harness, "opencode.json");
    await writeFile(
      configPath,
      buildCohortHostConfig(cohort, {
        port: context.port,
        pluginUrl: pathToFileURL(pluginPath).href,
      }),
      "utf8",
    );

    const childEnv = buildProbeEnv(process.env as Record<string, string | undefined>, {
      home: paths.home,
      xdgConfig: paths.xdgConfig,
      xdgData: paths.xdgData,
      xdgCache: paths.xdgCache,
      opencodeConfig: configPath,
      tmp: paths.tmp,
    });

    const isolationIssues: string[] = [];
    const credentialPattern =
      /^(OPENAI|ANTHROPIC|GROK|XAI|GEMINI|GOOGLE|EXA|BRAVE|ZAI)_.*KEY$|^OPENCODE_AUTH_CONTENT$/;
    for (const key of Object.keys(childEnv)) {
      if (credentialPattern.test(key))
        isolationIssues.push(`credential key present in child env: ${key}`);
    }
    for (const key of [
      "HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
      "TMPDIR",
      "OPENCODE_CONFIG",
    ]) {
      const value = childEnv[key];
      if (!value || !value.startsWith(`${root}${sep}`)) {
        isolationIssues.push(`${key} is not inside the owned scratch root`);
      }
    }

    const run = await runCommand(
      "opencode",
      ["run", "--format", "json", "--agent", "vv-controller", spec.prompt],
      {
        cwd: paths.workspace,
        env: childEnv,
        timeoutMs: options.timeoutMs ?? 150_000,
      },
    );

    const stdoutParse = parseRunStdout(run.stdout);
    const journalParse = existsSync(journalPath)
      ? parseHarnessJournalText(await readFile(journalPath, "utf8"))
      : {
          entries: [] as HarnessJournalEntry[],
          errors: ["harness journal file missing after the run"],
        };
    const sessionId =
      ((stdoutParse.events as { sessionID?: unknown }[]).find(
        (event) => typeof event.sessionID === "string",
      )?.sessionID as string | undefined) ?? null;
    const state = await stateSummary(paths.xdgData, sessionId);
    const filesAfter = await listWorkspaceFiles(paths.workspace);
    const fileHashes: Record<string, string> = { ...hashesBefore };
    for (const file of spec.unchangedFiles) {
      const absolute = join(paths.workspace, file);
      fileHashes[file] = existsSync(absolute) ? sha256Text(await readFile(absolute, "utf8")) : "";
    }
    const fileContents: Record<string, string> = {};
    for (const file of Object.keys(spec.expectFileContent ?? {})) {
      const absolute = join(paths.workspace, file);
      fileContents[file] = existsSync(absolute) ? await readFile(absolute, "utf8") : "";
    }

    const partial = {
      spec,
      cohort,
      exitCode: run.code,
      sessionId,
      definitions: responder.definitions,
      provider: {
        modelRequests: responder.modelRequests,
        modelRequestsWithTools: responder.modelRequestsWithTools,
        webSearchRequests: responder.webSearchRequests.length,
        webFetchRequests: responder.webFetchRequests.length,
      },
      journal: {
        exec: journalParse.entries.filter((entry) => entry.kind === "exec").length,
        reject: journalParse.entries.filter((entry) => entry.kind === "reject").length,
        pluginErrors: journalParse.entries
          .filter(
            (entry): entry is { kind: "plugin_error"; error: string } =>
              entry.kind === "plugin_error",
          )
          .map((entry) => entry.error),
      },
      state,
      workspaceFiles: filesAfter,
      fileHashes,
      fileContents,
      toolParts: stdoutParse.events
        .filter((event) => event.type === "tool_use" && event.part?.tool)
        .map((event) => event.part!),
      journalEntries: journalParse.entries,
      webSearchBodies: responder.webSearchRequests.map((request) => request.body ?? ""),
      childEnvKeys: Object.keys(childEnv),
      isolationIssues,
      stdoutErrors: [...stdoutParse.errors, ...journalParse.errors],
      stderrTail: run.stderr.slice(-4000),
      filesBefore,
    } as Omit<HostSessionResult, "passed" | "failed" | "cases">;

    const evaluation = evaluateHostSession(partial, built);
    return { ...partial, ...evaluation, workspaceFiles: filesAfter };
  } finally {
    try {
      if (responder) await responder.stop();
    } finally {
      await cleanupProbeRoot(root, scratchParent, options.keep);
    }
  }
}
// END_BLOCK_FULL_MATRIX_SESSION

// START_BLOCK_FULL_MATRIX_ORCHESTRATION
/**
 * Roots of the local import closure: the three built plugin entry points plus the
 * built catalog/identity modules the runner loads. The closure is derived from
 * these roots at run time, never from a hand-picked file list.
 */
export const CLOSURE_ROOTS: readonly string[] = [
  "dist/plugins/workflow/index.js",
  "dist/plugins/hashline-edit/index.js",
  "dist/plugins/web-tools/index.js",
  "dist/lib/agent-tool-catalog.js",
  "dist/lib/agent-tool-contract.js",
];

/**
 * Extra material paths outside the import closure: package identity and pinned
 * manifests, packaged instruction/reference assets, and the T009 runner and
 * provenance fixture files. Together with the derived closure this is a
 * conservative superset of the exercised implementation, not an exact runtime
 * closure claim. Subsequent edits to these files are caught by fingerprinting.
 */
export const EXTRA_FINGERPRINT_PATHS: readonly string[] = [
  "package.json",
  "node_modules/@opencode-ai/plugin/package.json",
  "node_modules/@opencode-ai/sdk/package.json",
  "templates/skills/vv-execute/references/tool-contracts.md",
  "src/plugins/workflow/system-instruction.md",
  "scripts/check-tool-contracts-host.ts",
  "scripts/check-tool-contracts-host.test.ts",
  "src/lib/agent-tool-host.test.ts",
];

export type FingerprintEntry = { path: string; sha256: string; bytes: number };

/** Relative specifiers from static import/export `from` and dynamic `import()` forms. */
export function extractRelativeSpecifiers(text: string): string[] {
  const specifiers = new Set<string>();
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s+["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier && specifier.startsWith(".")) specifiers.add(specifier);
    }
  }
  return [...specifiers];
}

function resolveLocalSpecifier(fromAbsolute: string, specifier: string): string | undefined {
  // Bun raw imports carry a `?raw` (or similar) query; resolve the underlying file.
  const clean = specifier.split("?")[0] ?? specifier;
  const base = resolve(dirname(fromAbsolute), clean);
  if (existsSync(base)) return base;
  if (base.endsWith(".js")) {
    const stub = base.slice(0, -3);
    if (existsSync(`${stub}.ts`)) return `${stub}.ts`;
    if (existsSync(`${stub}.tsx`)) return `${stub}.tsx`;
  }
  return undefined;
}

export type LocalClosure = {
  paths: string[];
  /** Relative imports from a discovered module that could not be resolved on disk. */
  unresolved: string[];
};

/**
 * Conservative local import/re-export dependency closure from the given roots.
 * Only relative specifiers are followed (bare packages and node_modules are
 * never walked); `.js` imports resolve to their `.ts`/`.tsx` source when the
 * built file is absent; every discovered dist module is paired with its src
 * counterpart when both exist. Cycles terminate through the visited set.
 */
export function collectLocalImportClosure(
  repoRoot: string,
  roots: readonly string[],
): LocalClosure {
  const visited = new Set<string>();
  const unresolved = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) {
    const absolute = resolve(repoRoot, root);
    if (existsSync(absolute)) queue.push(relative(repoRoot, absolute));
  }
  while (queue.length > 0) {
    const relativePath = queue.shift()!;
    if (visited.has(relativePath)) continue;
    visited.add(relativePath);
    let text: string;
    try {
      text = readFileSync(resolve(repoRoot, relativePath), "utf8");
    } catch {
      continue;
    }
    for (const specifier of extractRelativeSpecifiers(text)) {
      const resolved = resolveLocalSpecifier(resolve(repoRoot, relativePath), specifier);
      if (!resolved) {
        unresolved.add(`${relativePath} -> ${specifier}`);
        continue;
      }
      const resolvedRelative = relative(repoRoot, resolved);
      if (resolvedRelative.startsWith("..")) continue;
      queue.push(resolvedRelative);
    }
  }
  const discovered = [...visited];
  for (const path of discovered) {
    if (path.startsWith("dist/") && path.endsWith(".js")) {
      const source = `src/${path.slice("dist/".length, -3)}.ts`;
      if (existsSync(join(repoRoot, source))) visited.add(source);
      const sourceTsx = `src/${path.slice("dist/".length, -3)}.tsx`;
      if (existsSync(join(repoRoot, sourceTsx))) visited.add(sourceTsx);
    } else if (path.startsWith("src/") && path.endsWith(".ts")) {
      const built = `dist/${path.slice("src/".length, -3)}.js`;
      if (existsSync(join(repoRoot, built))) visited.add(built);
    } else if (path.startsWith("src/") && path.endsWith(".tsx")) {
      const built = `dist/${path.slice("src/".length, -4)}.js`;
      if (existsSync(join(repoRoot, built))) visited.add(built);
    }
  }
  return { paths: [...visited].sort(), unresolved: [...unresolved].sort() };
}

/** De-duplicate and sort paths deterministically. */
export function uniqueSorted(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort();
}

/** Fingerprint every expected path; a missing expected file is a hard failure, never filtered out. */
export async function fingerprintAll(
  repoRoot: string,
  paths: readonly string[],
): Promise<{ entries: FingerprintEntry[]; missing: string[] }> {
  const entries: FingerprintEntry[] = [];
  const missing: string[] = [];
  for (const relative of paths) {
    const fingerprint = await fingerprintFile(join(repoRoot, relative));
    if (!fingerprint) {
      missing.push(relative);
      continue;
    }
    entries.push({ path: relative, sha256: fingerprint.sha256, bytes: fingerprint.bytes });
  }
  return { entries, missing };
}

/** Compare two fingerprint sets and return the paths that drifted mid-run. */
export function fingerprintDrift(
  before: readonly FingerprintEntry[],
  after: readonly FingerprintEntry[],
): string[] {
  const beforeByPath = new Map(before.map((entry) => [entry.path, entry.sha256]));
  const afterByPath = new Map(after.map((entry) => [entry.path, entry.sha256]));
  const drift: string[] = [];
  for (const [path, digest] of beforeByPath) {
    if (afterByPath.get(path) !== digest) drift.push(path);
  }
  for (const path of afterByPath.keys()) {
    if (!beforeByPath.has(path)) drift.push(path);
  }
  return drift.sort();
}

export type PinnedExpectations =
  | { ok: true; pluginSdk: string; sdk: string }
  | { ok: false; reason: string };

/** Read the exact @opencode-ai versions the package manifest pins. */
export function readPinnedExpectations(repoRoot: string): PinnedExpectations {
  const path = join(repoRoot, "package.json");
  if (!existsSync(path)) return { ok: false, reason: "package.json is missing" };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      dependencies?: Record<string, unknown>;
    };
    const pluginSdk = parsed.dependencies?.["@opencode-ai/plugin"];
    const sdk = parsed.dependencies?.["@opencode-ai/sdk"];
    if (typeof pluginSdk !== "string" || typeof sdk !== "string") {
      return {
        ok: false,
        reason: "package.json does not pin @opencode-ai/plugin and @opencode-ai/sdk",
      };
    }
    if (!/^\d+\.\d+\.\d+/.test(pluginSdk) || !/^\d+\.\d+\.\d+/.test(sdk)) {
      return { ok: false, reason: "package.json @opencode-ai pins are not exact versions" };
    }
    return { ok: true, pluginSdk, sdk };
  } catch {
    return { ok: false, reason: "package.json is not valid JSON" };
  }
}

/** Read an installed package manifest version; null when missing or invalid. */
export function readManifestVersion(repoRoot: string, relative: string): string | null {
  const path = join(repoRoot, relative);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim() !== ""
      ? parsed.version
      : null;
  } catch {
    return null;
  }
}

export type PinnedManifestCheck =
  | { ok: true; pluginSdk: string; sdk: string }
  | { ok: false; reason: string };

/**
 * Require both installed @opencode-ai manifests to carry a valid version that
 * matches the project pin; a missing or null version is a hard failure, never a
 * silent green row.
 */
export function checkPinnedManifests(
  repoRoot: string,
  expectations: { pluginSdk: string; sdk: string },
): PinnedManifestCheck {
  const pluginSdk = readManifestVersion(repoRoot, "node_modules/@opencode-ai/plugin/package.json");
  const sdk = readManifestVersion(repoRoot, "node_modules/@opencode-ai/sdk/package.json");
  if (!pluginSdk) {
    return { ok: false, reason: "installed @opencode-ai/plugin manifest has no valid version" };
  }
  if (!sdk)
    return { ok: false, reason: "installed @opencode-ai/sdk manifest has no valid version" };
  if (pluginSdk !== expectations.pluginSdk) {
    return {
      ok: false,
      reason: `installed @opencode-ai/plugin ${pluginSdk} does not match pinned ${expectations.pluginSdk}`,
    };
  }
  if (sdk !== expectations.sdk) {
    return {
      ok: false,
      reason: `installed @opencode-ai/sdk ${sdk} does not match pinned ${expectations.sdk}`,
    };
  }
  return { ok: true, pluginSdk, sdk };
}

/** Resolve the evidence target, requiring the approved active change bundle to already exist. */
export function resolveEvidenceTarget(
  repoRoot: string,
): { ok: true; path: string } | { ok: false; reason: string } {
  const path = join(repoRoot, HOST_EVIDENCE_RELATIVE_PATH);
  const parent = dirname(path);
  if (!existsSync(parent)) {
    return {
      ok: false,
      reason: `active change bundle directory is missing: ${HOST_EVIDENCE_RELATIVE_PATH} (not recreating it)`,
    };
  }
  return { ok: true, path };
}

/** Remove any prior owned passing evidence so a stale pass can never mislead. */
export async function invalidateEvidence(path: string): Promise<void> {
  if (existsSync(path)) await rm(path, { force: true });
}

/**
 * Write observed evidence only when the target was valid, no assertions failed,
 * and the bounded size cap holds. Never creates the change bundle directory.
 */
export async function writeEvidenceIfAllowed(
  target: { ok: true; path: string } | { ok: false; reason: string },
  serialized: string,
  options: { failureCount: number; maxBytes: number },
): Promise<{ ok: boolean; reason?: string; bytes?: number }> {
  if (!target.ok) return { ok: false, reason: target.reason };
  if (options.failureCount > 0) return { ok: false, reason: "observed failures present" };
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > options.maxBytes)
    return { ok: false, reason: "evidence exceeded the bounded size cap" };
  await writeFile(target.path, serialized, "utf8");
  return { ok: true, bytes };
}

/** Bounded projection summary of one observed owned definition. */
export function describeDefinition(definition: NormalizedToolDefinition): Record<string, unknown> {
  const properties = (definition.parameters.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const enumFields: string[] = [];
  const closedObjectProps: string[] = [];
  for (const [key, value] of Object.entries(properties)) {
    if (Array.isArray(value.enum)) enumFields.push(key);
    if (value.type === "object" && value.additionalProperties === false)
      closedObjectProps.push(key);
  }
  return {
    name: definition.name,
    descriptionChars: definition.description.length,
    descriptionSha256: sha256Text(definition.description),
    projectionSha256: sha256Text(JSON.stringify(definition.parameters)),
    propertyCount: Object.keys(properties).length,
    required: definition.parameters.required ?? [],
    enumFields,
    closedObjectProps,
  };
}

/** Assemble the bounded, versioned compatibility-evidence document from observed results only. */
export function buildHostEvidenceDocument(input: {
  generatedAt: string;
  hostVersion: string;
  bunVersion: string;
  command: string;
  scratchParent: string;
  identity: BuiltContractContext["identity"];
  pinned: {
    pluginSdk: string;
    sdk: string;
    pinnedPluginSdk: string;
    pinnedSdk: string;
  };
  fingerprintMeta: {
    closureRoots: readonly string[];
    closureCaveat: string;
    addedDeps: readonly string[];
    removedDeps: readonly string[];
    unresolved: readonly string[];
  };
  sessions: HostSessionResult[];
  artifacts: { path: string; sha256: string; bytes: number }[];
  sources: { path: string; sha256: string; bytes: number }[];
  assets: { path: string; sha256: string; bytes: number }[];
  fingerprintsBefore: readonly FingerprintEntry[];
  fingerprintsAfter: readonly FingerprintEntry[];
  coverageFailures: string[];
}): Record<string, unknown> {
  const cohorts = input.sessions.map((session) => ({
    sessionId: session.spec.id,
    cohortId: session.cohort.id,
    transport: session.cohort.transport,
    providerNpm: session.cohort.providerNpm,
    modelId: session.cohort.modelId,
    editorTool: session.cohort.editorTool,
    loweringRoute: session.cohort.loweringRoute,
    hostExitCode: session.exitCode,
    passed: session.passed.length,
    failed: session.failed.length,
    failures: session.failed,
    cases: session.cases,
    definitionNames: session.definitions.map((definition) => definition.name).sort(),
    projections: session.definitions
      .filter((definition) => (OWNED_TOOL_IDS as readonly string[]).includes(definition.name))
      .map((definition) => describeDefinition(definition)),
    providerRequests: session.provider,
    sideEffects: {
      execJournalEntries: session.journal.exec,
      rejectJournalEntries: session.journal.reject,
      pluginErrors: session.journal.pluginErrors,
      workflowState: {
        exists: session.state.exists,
        records: session.state.records,
        executions: session.state.executions,
        itemStates: session.state.itemStates,
      },
    },
    workspaceFiles: session.workspaceFiles,
    childEnvKeys: session.childEnvKeys,
  }));
  const observedChildEnvKeys = [
    ...new Set(input.sessions.flatMap((session) => session.childEnvKeys)),
  ].sort();
  const credentialPattern =
    /^(OPENAI|ANTHROPIC|GROK|XAI|GEMINI|GOOGLE|EXA|BRAVE|ZAI)_.*KEY$|^OPENCODE_AUTH_CONTENT$/;
  const inheritedProviderCredentials = observedChildEnvKeys.some((key) =>
    credentialPattern.test(key),
  );
  const failures = [
    ...input.sessions.flatMap((session) =>
      session.failed.map((label) => `${session.spec.id}: ${label}`),
    ),
    ...input.coverageFailures,
  ];
  const coverage = [
    ...new Set(input.sessions.flatMap((session) => session.definitions.map((d) => d.name))),
  ].sort();
  const caseDigest = sha256Text(JSON.stringify(cohorts.map((cohort) => cohort.cases)));
  return {
    version: CONTRACTS_HOST_EVIDENCE_VERSION,
    kind: "vvoc-tool-contract-host-compatibility",
    generatedAt: input.generatedAt,
    command: input.command,
    host: { opencodeVersion: input.hostVersion, bunVersion: input.bunVersion },
    package: {
      name: input.identity.name,
      version: input.identity.version,
      contractRevision: input.identity.revision,
    },
    pinned: input.pinned,
    isolation: {
      scratchParent: input.scratchParent,
      observedChildEnvKeys,
      syntheticProviderKey: true,
      syntheticExaCredential: true,
      inheritedProviderCredentials,
      childEnvCredentialKeys: observedChildEnvKeys.filter((key) => credentialPattern.test(key)),
      projectConfig: "workspace/.vvoc/vvoc.json (synthetic Exa credential only)",
    },
    coverage: {
      ownedToolIds: [...OWNED_TOOL_IDS],
      observedDefinitionNames: coverage,
      allOwnedToolsObserved: OWNED_TOOL_IDS.every((id) => coverage.includes(id)),
      coverageFailures: input.coverageFailures,
      caseCount: input.sessions.reduce((total, session) => total + session.cases.length, 0),
      caseDigest,
    },
    artifacts: input.artifacts,
    sources: input.sources,
    assets: input.assets,
    fingerprints: {
      closureRoots: input.fingerprintMeta.closureRoots,
      closureCaveat: input.fingerprintMeta.closureCaveat,
      before: input.fingerprintsBefore,
      after: input.fingerprintsAfter,
      drift: fingerprintDrift(input.fingerprintsBefore, input.fingerprintsAfter),
      addedDeps: input.fingerprintMeta.addedDeps,
      removedDeps: input.fingerprintMeta.removedDeps,
      unresolved: input.fingerprintMeta.unresolved,
    },
    provenanceUrls: PROVENANCE_SOURCES,
    cohorts,
    unexercised: [
      `OpenCode ${MINIMUM_SUPPORTED_HOST_VERSION} live binary (minimum contract covered by derived registry fixtures only)`,
      "Real OpenAI (@ai-sdk/openai) schema lowering: the live openai-compatible route takes no sanitizeOpenAISchema branch; const-to-enum and dropped bounds are covered by derived fixtures only",
      "Google/Gemini schema normalization: derived fixture only, no live Google transport",
      "Remote paid-provider/model acceptance, model quality, and token accounting (never exercised)",
      "work_checkpoint start/verify/review/bind/complete and work_item_decide rework/recover live branches",
      "Native-package plan registration and native checkpoint lifecycle",
    ],
    failures,
  };
}

/** Load identity, descriptors, and result validators from the compiled dist package under test. */
export async function loadBuiltContractContext(repoRoot: string): Promise<BuiltContractContext> {
  const distUrl = (relative: string) => pathToFileURL(join(repoRoot, relative)).href;
  const identityModule = (await import(distUrl("dist/lib/agent-tool-contract.js"))) as {
    PACKAGE_NAME: string;
    PACKAGE_VERSION: string;
    AGENT_TOOL_CONTRACT_REVISION: string;
  };
  const catalogModule = (await import(distUrl("dist/lib/agent-tool-catalog.js"))) as {
    agentToolCatalog: readonly {
      toolId: string;
      contract: { description: string; inputJsonSchema: Record<string, unknown> };
    }[];
  };
  const workflowResults = (await import(distUrl("dist/plugins/workflow/results.js"))) as {
    validateWorkflowToolResult: (tool: string, value: unknown) => { ok: boolean; issues?: unknown };
  };
  const hashlineSchemas = (await import(distUrl("dist/plugins/hashline-edit/schemas.js"))) as {
    hashlineEditMetadataSchema: { safeParse: (value: unknown) => { success: boolean } };
    strReplaceEditorMetadataSchema: { safeParse: (value: unknown) => { success: boolean } };
  };
  const webSchemas = (await import(distUrl("dist/plugins/web-tools/schemas.js"))) as {
    webSearchResultSchema: { safeParse: (value: unknown) => { success: boolean } };
    webFetchResultSchema: { safeParse: (value: unknown) => { success: boolean } };
    WEB_SEARCH_DEFAULT_COUNT: number;
    WEB_FETCH_DEFAULT_TIMEOUT_SECONDS: number;
  };
  return {
    origin: "dist",
    identity: {
      name: identityModule.PACKAGE_NAME,
      version: identityModule.PACKAGE_VERSION,
      revision: identityModule.AGENT_TOOL_CONTRACT_REVISION,
    },
    descriptors: catalogModule.agentToolCatalog.map((entry) => ({
      toolId: entry.toolId,
      description: entry.contract.description,
      inputJsonSchema: entry.contract.inputJsonSchema,
    })),
    searchDefaultCount: webSchemas.WEB_SEARCH_DEFAULT_COUNT,
    fetchDefaultTimeoutSeconds: webSchemas.WEB_FETCH_DEFAULT_TIMEOUT_SECONDS,
    validateWorkflowResult: (tool, value) => {
      const outcome = workflowResults.validateWorkflowToolResult(tool, value);
      return outcome.ok ? { ok: true } : { ok: false, detail: "workflow result contract failed" };
    },
    validateHashlineMetadata: (value) =>
      hashlineSchemas.hashlineEditMetadataSchema.safeParse(value).success
        ? { ok: true }
        : { ok: false, detail: "hashline metadata contract failed" },
    validateStrEditorMetadata: (value) =>
      hashlineSchemas.strReplaceEditorMetadataSchema.safeParse(value).success
        ? { ok: true }
        : { ok: false, detail: "str editor metadata contract failed" },
    validateWebResult: (tool, value) => {
      const schema =
        tool === "web_search" ? webSchemas.webSearchResultSchema : webSchemas.webFetchResultSchema;
      return schema.safeParse(value).success
        ? { ok: true }
        : { ok: false, detail: `${tool} result contract failed` };
    },
  };
}

/**
 * Run the full bounded live contract matrix against the built package on the
 * installed OpenCode host, then write observed compatibility evidence when (and
 * only when) every case passes. Prior owned passing evidence is invalidated at
 * the start and on any failure; the active change bundle is never recreated.
 */
export async function runContractsHost(options?: {
  keep?: boolean;
  timeoutMs?: number;
}): Promise<number> {
  const repoRoot = resolve(new URL("..", import.meta.url).pathname);
  const target = resolveEvidenceTarget(repoRoot);
  if (!target.ok) {
    console.error(target.reason);
    return 1;
  }
  await invalidateEvidence(target.path);

  // Pinned third-party versions must be real and match the package pin; a
  // missing/null manifest version is a hard failure, never a silent green row.
  const expectations = readPinnedExpectations(repoRoot);
  if (!expectations.ok) {
    console.error(`pinned dependency check failed: ${expectations.reason}`);
    return 1;
  }
  const pinned = checkPinnedManifests(repoRoot, expectations);
  if (!pinned.ok) {
    console.error(`pinned dependency check failed: ${pinned.reason}`);
    return 1;
  }

  // Derive the local import/re-export closure from the real roots before running.
  const beforeClosure = collectLocalImportClosure(repoRoot, CLOSURE_ROOTS);
  const beforePaths = uniqueSorted([...beforeClosure.paths, ...EXTRA_FINGERPRINT_PATHS]);
  const beforeFingerprints = await fingerprintAll(repoRoot, beforePaths);
  if (beforeFingerprints.missing.length > 0) {
    console.error(
      `missing material fingerprint path(s): ${beforeFingerprints.missing.join(", ")}; run 'bun run build' before 'bun run contracts:host'`,
    );
    return 1;
  }

  const scratchParent = process.env.VVOC_PROBE_TMP ?? PROBE_SCRATCH_PARENT;
  await mkdir(scratchParent, { recursive: true });

  try {
    let versionRoot: string | undefined;
    let hostVersion: string | null = null;
    try {
      versionRoot = await mkdtemp(join(scratchParent, "version-"));
      const versionPaths = await probePathsFor(versionRoot);
      for (const directory of Object.values(versionPaths))
        await mkdir(directory, { recursive: true });
      const versionEnv = buildProbeEnv(process.env as Record<string, string | undefined>, {
        home: versionPaths.home,
        xdgConfig: versionPaths.xdgConfig,
        xdgData: versionPaths.xdgData,
        xdgCache: versionPaths.xdgCache,
        opencodeConfig: join(versionPaths.harness, "opencode.json"),
        tmp: versionPaths.tmp,
      });
      const versionResult = await runCommand("opencode", ["--version"], {
        cwd: versionPaths.home,
        env: versionEnv,
        timeoutMs: 15_000,
      });
      if (versionResult.code !== 0) {
        console.error(`opencode --version exited ${versionResult.code}`);
        return 1;
      }
      hostVersion = parseHostVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
    } finally {
      if (versionRoot) await cleanupProbeRoot(versionRoot, scratchParent, false);
    }
    if (!isSupportedLiveHostVersion(hostVersion)) {
      console.error(
        `unsupported or unavailable host: got ${hostVersion ?? "unknown"}, need ${SUPPORTED_LIVE_HOST_VERSION}`,
      );
      return 1;
    }

    const built = await loadBuiltContractContext(repoRoot);
    const sessions: HostSessionResult[] = [];
    for (const spec of hostSessionSpecs()) {
      const result = await runHostSession(spec, built, scratchParent, {
        keep: options?.keep,
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });
      sessions.push(result);
      console.log(
        `${spec.id}: passed=${result.passed.length} failed=${result.failed.length} definitions=${result.definitions.length}`,
      );
      for (const label of result.failed) console.log(`  FAIL ${label}`);
    }

    // Re-discover after the run so added or deleted dependencies cannot vanish.
    const afterClosure = collectLocalImportClosure(repoRoot, CLOSURE_ROOTS);
    const afterPaths = uniqueSorted([...afterClosure.paths, ...EXTRA_FINGERPRINT_PATHS]);
    const afterFingerprints = await fingerprintAll(repoRoot, afterPaths);
    if (afterFingerprints.missing.length > 0) {
      console.error(
        `material path(s) disappeared mid-run: ${afterFingerprints.missing.join(", ")}`,
      );
      return 1;
    }
    const beforeSet = new Set(beforeClosure.paths);
    const afterSet = new Set(afterClosure.paths);
    const addedDeps = afterClosure.paths.filter((path) => !beforeSet.has(path));
    const removedDeps = beforeClosure.paths.filter((path) => !afterSet.has(path));
    const unresolved = uniqueSorted([...beforeClosure.unresolved, ...afterClosure.unresolved]);
    const drift = uniqueSorted(
      fingerprintDrift(beforeFingerprints.entries, afterFingerprints.entries),
    );
    if (unresolved.length > 0) {
      console.error(`unresolved local imports in fingerprint closure: ${unresolved.join(", ")}`);
      return 1;
    }

    const coverage = new Set(sessions.flatMap((session) => session.definitions.map((d) => d.name)));
    const coverageFailures = OWNED_TOOL_IDS.filter((id) => !coverage.has(id)).map(
      (id) => `owned tool ${id} was never observed on any cohort wire`,
    );

    const document = buildHostEvidenceDocument({
      generatedAt: new Date().toISOString(),
      hostVersion: hostVersion ?? "unknown",
      bunVersion: process.versions.bun ?? "unknown",
      command: "bun run contracts:host",
      scratchParent,
      identity: built.identity,
      pinned: {
        pluginSdk: pinned.pluginSdk,
        sdk: pinned.sdk,
        pinnedPluginSdk: expectations.pluginSdk,
        pinnedSdk: expectations.sdk,
      },
      fingerprintMeta: {
        closureRoots: CLOSURE_ROOTS,
        closureCaveat:
          "Conservative local import/re-export closure from the three built plugin roots plus the built catalog/identity modules, paired with src counterparts and extra material paths; not an exact runtime graph.",
        addedDeps,
        removedDeps,
        unresolved,
      },
      sessions,
      artifacts: beforeFingerprints.entries.filter((entry) => entry.path.startsWith("dist/")),
      sources: beforeFingerprints.entries.filter((entry) => entry.path.startsWith("src/")),
      assets: beforeFingerprints.entries.filter(
        (entry) => !entry.path.startsWith("dist/") && !entry.path.startsWith("src/"),
      ),
      fingerprintsBefore: beforeFingerprints.entries,
      fingerprintsAfter: afterFingerprints.entries,
      coverageFailures,
    });
    const failures = sessions.flatMap((session) => session.failed);
    const gateFailures =
      failures.length +
      coverageFailures.length +
      drift.length +
      addedDeps.length +
      removedDeps.length;
    if (drift.length > 0) {
      console.error(`material implementation drifted mid-run: ${drift.join(", ")}`);
    }
    if (addedDeps.length > 0 || removedDeps.length > 0) {
      console.error(
        `fingerprint closure changed mid-run: +${addedDeps.length} -${removedDeps.length} (${[...addedDeps, ...removedDeps].join(", ")})`,
      );
    }
    if (gateFailures > 0) {
      console.error(`contracts:host failed ${gateFailures} assertion(s); evidence not written`);
      return 1;
    }
    const result = await writeEvidenceIfAllowed(target, `${JSON.stringify(document, null, 2)}\n`, {
      failureCount: gateFailures,
      maxBytes: HOST_EVIDENCE_MAX_BYTES,
    });
    if (!result.ok) {
      console.error(`contracts:host did not write evidence: ${result.reason}`);
      return 1;
    }
    console.log(
      `contracts:host passed; wrote ${HOST_EVIDENCE_RELATIVE_PATH} (${result.bytes} bytes)`,
    );
    return 0;
  } catch (error) {
    await invalidateEvidence(target.path);
    console.error(
      `contracts:host aborted: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}
// END_BLOCK_FULL_MATRIX_ORCHESTRATION

if (import.meta.main) {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== "--probe" && arg !== "--keep");
  if (unknown.length > 0) {
    console.error("usage: bun scripts/check-tool-contracts-host.ts [--probe] [--keep]");
    process.exitCode = 1;
  } else if (args.includes("--probe")) {
    process.exitCode = await runProbe({ keep: args.includes("--keep") });
  } else {
    process.exitCode = await runContractsHost({ keep: args.includes("--keep") });
  }
}
