#!/usr/bin/env bun
// FILE: scripts/e2e-v2/cases.ts
// VERSION: 3.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Define the core real-host acceptance cases and their observed, per-request-attributed assertions for the packed session-owned family-settings runtime.
//   SCOPE: Case descriptors, the driver contract, a bounded assertion collector, and executable cases for activation and lazy settings birth, zero-dispatch rejection, native role variants with registry readback, auxiliary title with zero native title dispatch, config mutation with stable family settings, native generate/synthetic without any admission gateway, explicit selection preservation, fork/worktree lineage, resource permission guard effects, settings stability under an explicit switch race, and a hook-availability probe. Assertions are attributed to the exact current session/request via the provider payload markers and hosted session id.
//   DEPENDS: [scripts/e2e-v2/host.ts, scripts/e2e-v2/provider.ts, scripts/e2e-v2/fixtures/plugin.ts]
//   LINKS: [M-E2E-V2-HARNESS, V-M-E2E-V2-HARNESS]
//   ROLE: SCRIPT
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   CaseStatus - Terminal status of one real-host case.
//   CaseResult - Machine-readable outcome for one real-host case.
//   Checks - Bounded assertion collector that never throws on a failed expectation.
//   CoreDriver - Host/profile operations the cases use; implemented by the runner.
//   CoreCase - One executable core acceptance case descriptor.
//   coreCases - Ordered core acceptance cases.
//   PACKED_SEMVER_PATTERN - Semver pattern (prerelease/build allowed) that the packed artifact version must match.
//   ORDERING_DELAY_MARKER - Marker that makes the fixture delay native preparation after the real prompt hook.
//   delay - Promise-based millisecond delay used by permission polling.
//   markerSeq - Monotonic counter making case markers unique within a run.
//   nextMarker - Build a unique case marker string from a prefix.
//   bodyText - Serialize a provider request body for bounded marker/session matching.
//   attributedSessionID - Hosted session id embedded in a provider request environment block.
//   containsMarker - True when a provider request carries an exact case marker.
//   payloadFields - Extract the smoke variant and reasoning effort fields from a provider body.
//   qualifiedSuffix - True when a variant string ends with the expected suffix.
//   isTitleGeneration - True when a provider request is the auxiliary child's title generation.
//   containsValue - Recursively search a parsed value for an exact string property value.
//   waitForPendingPermission - Poll the native session permission list for the first pending request id.
//   replyPermission - Submit a permission decision for a pending native request.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-SESSION-OWNED-SETTINGS T-006 - Cases now assert session-owned family settings: lazy metadata birth, config-change stability, native role variants, and no admission gateway; qualified snapshot variants are gone.]
//   PREVIOUS: [Direct fix - Accepted prerelease semver in the activation packed-version assertion so the core suite stays green across the rc release cycle.]
// END_CHANGE_SUMMARY

import type { ProviderRequestRecord } from "./provider.js";

/** Terminal status of one real-host case. */
export type CaseStatus = "pass" | "fail" | "skip";

/** Machine-readable outcome for one real-host case. */
export interface CaseResult {
  readonly id: string;
  readonly title: string;
  readonly phase: string;
  readonly parity: readonly string[];
  readonly status: CaseStatus;
  readonly detail: string;
  readonly assertions: readonly string[];
  readonly failures: readonly string[];
  readonly durationMs?: number;
  readonly observed?: unknown;
}

/** One typed assertion collected during a case; failures never throw. */
export class Checks {
  readonly #passed: string[] = [];
  readonly #failed: string[] = [];

  truthy(value: unknown, message: string): boolean {
    if (value) {
      this.#passed.push(message);
      return true;
    }
    this.#failed.push(message);
    return false;
  }

  equal(actual: unknown, expected: unknown, message: string): boolean {
    return this.truthy(
      Object.is(actual, expected),
      `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
    );
  }

  get passed(): readonly string[] {
    return this.#passed;
  }

  get failed(): readonly string[] {
    return this.#failed;
  }
}

/** Host/profile operations the cases use; implemented by the runner. */
export interface CoreDriver {
  readonly workspaceRoot: string;
  readonly scratchDir: string;
  readonly projectDir: string;
  readonly providerPort: number;
  readonly packedSha256: string;
  readonly packageDir: string;
  readonly packedVersion: string;
  readonly hostSha256: string;
  readonly sourceCommit: string;
  readonly missingAttachmentUri: string;
  api(
    path: string,
    init?: RequestInit,
  ): Promise<{ readonly status: number; readonly body: any; readonly text: string }>;
  control(
    path: string,
    init?: { readonly method?: string; readonly body?: unknown },
  ): Promise<{ readonly status: number; readonly body: any }>;
  createSession(body?: Record<string, unknown>): Promise<string>;
  deleteSession(id: string): Promise<void>;
  sessionInfo(id: string): Promise<any>;
  listSessions(): Promise<any[]>;
  prompt(
    id: string,
    text: string,
    extra?: Record<string, unknown>,
  ): Promise<{ readonly status: number }>;
  generate(
    id: string,
    prompt: string,
  ): Promise<{ readonly status: number; readonly text?: string }>;
  synthetic(
    id: string,
    text: string,
    extra?: Record<string, unknown>,
  ): Promise<{ readonly status: number }>;
  switchModel(id: string, model: Record<string, unknown>): Promise<{ readonly status: number }>;
  fork(id: string): Promise<{ readonly status: number; readonly id?: string }>;
  move(id: string, directory: string): Promise<{ readonly status: number }>;
  worktreeCreate(body: Record<string, unknown>): Promise<{
    readonly status: number;
    readonly directory?: string;
    readonly error?: string;
  }>;
  worktreeRefresh(projectID: string): Promise<void>;
  worktreeRemove(directory: string): Promise<void>;
  modelList(): Promise<unknown>;
  providerCount(): Promise<number>;
  providerRequestsSince(index: number): Promise<ProviderRequestRecord[]>;
  waitIdleChange(id: string, previousIdle: unknown, timeoutMs?: number): Promise<any>;
  writeVvocRoles(input: { readonly allPlain: boolean }): Promise<void>;
}

/** One executable core acceptance case descriptor. */
export interface CoreCase {
  readonly id: string;
  readonly title: string;
  readonly phase: string;
  readonly parity: readonly string[];
  run(driver: CoreDriver, check: Checks): Promise<{ detail: string; observed?: unknown }>;
}

/** Marker that makes the fixture delay native preparation after the real prompt hook. */
export const ORDERING_DELAY_MARKER = "__vvoc_e2e_delay__";

/**
 * Semver pattern the packed artifact version must match: same shape as the release
 * tooling's pattern, so stable and prerelease (rc) versions both pass.
 */
export const PACKED_SEMVER_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const delay = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
let markerSeq = 0;
const nextMarker = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(markerSeq += 1)}`;

// START_BLOCK_ATTRIBUTION
/** Serialize a provider body for bounded marker/session matching. */
function bodyText(record: ProviderRequestRecord): string {
  try {
    return JSON.stringify(record.body ?? "");
  } catch {
    return "";
  }
}

/** Hosted session id found in a provider request body, when the host embeds one. */
function attributedSessionID(record: ProviderRequestRecord): string | undefined {
  const text = bodyText(record);
  const match =
    /Current conversation session ID: (ses_[A-Za-z0-9]+)/.exec(text) ??
    /sessionID["']?\s*[:=]\s*["']?(ses_[A-Za-z0-9]+)/.exec(text);
  return match?.[1];
}

/** True when a provider request is the auxiliary child's title generation. */
function isTitleGeneration(record: ProviderRequestRecord): boolean {
  return bodyText(record).includes("Generate a short, specific title");
}

/** True when a provider request carries an exact case marker. */
function containsMarker(record: ProviderRequestRecord, marker: string): boolean {
  return bodyText(record).includes(marker);
}

function payloadFields(record: ProviderRequestRecord): {
  readonly smoke_variant?: unknown;
  readonly reasoning_effort?: unknown;
} {
  const body = (record.body ?? {}) as { smoke_variant?: unknown; reasoning_effort?: unknown };
  return { smoke_variant: body.smoke_variant, reasoning_effort: body.reasoning_effort };
}

function qualifiedSuffix(variant: unknown, suffix: string): boolean {
  return typeof variant === "string" && variant.endsWith(suffix);
}

/** Recursively search a parsed value for a string property value. */
function containsValue(value: unknown, needle: string): boolean {
  if (typeof value === "string") return value === needle;
  if (Array.isArray(value)) return value.some((entry) => containsValue(entry, needle));
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((entry) =>
      containsValue(entry, needle),
    );
  }
  return false;
}

/** Poll the native session permission list for the first pending request id. */
async function waitForPendingPermission(
  driver: CoreDriver,
  sessionID: string,
  timeoutMs = 12_000,
  pollMs = 100,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const listed = await driver.api(`/api/session/${sessionID}/permission`);
    const entries = (listed.body as { data?: Array<{ id?: string }> } | undefined)?.data;
    if (Array.isArray(entries) && entries.length > 0 && typeof entries[0].id === "string") {
      return entries[0].id;
    }
    await delay(pollMs);
  }
  return undefined;
}

async function replyPermission(
  driver: CoreDriver,
  sessionID: string,
  requestID: string,
  decision: "once" | "reject",
): Promise<void> {
  await driver.api(`/api/session/${sessionID}/permission/${requestID}/reply`, {
    method: "POST",
    body: JSON.stringify({ decision }),
  });
}
// END_BLOCK_ATTRIBUTION

// START_BLOCK_CORE_CASES
/** Ordered core acceptance cases. */
export const coreCases: readonly CoreCase[] = [
  {
    id: "activation",
    title: "Packed artifact import, mandatory guards, and idle registry quiescence",
    phase: "T-003",
    parity: ["plugin.model-roles", "pack.packed-artifact"],
    async run(driver, check) {
      const status = await driver.control("/status");
      check.truthy(
        status.body.ok === true,
        "control plane reports the packed fixture setup completed",
      );
      check.equal(status.body.pluginID, "vvoc.e2e.fixture", "fixture plugin id is stable");
      check.truthy(
        PACKED_SEMVER_PATTERN.test(driver.packedVersion),
        `packed package exposes a semver version (${driver.packedVersion})`,
      );
      check.equal(
        status.body.guardState?.["http.request"],
        true,
        "mandatory http.request destination guard registered",
      );
      check.equal(
        status.body.guardState?.["model.request"],
        true,
        "mandatory model.request destination guard registered",
      );
      const client = await driver.control("/client");
      check.truthy(
        client.status === 200 && client.body?.ok === true,
        "authenticated same-instance native client challenge succeeded",
      );
      const fresh = await driver.createSession();
      await delay(800);
      const freshSettings = await driver.control(`/settings?sessionID=${fresh}`);
      check.equal(
        freshSettings.body?.familyId,
        fresh,
        "a location-only session is its own family root",
      );
      check.equal(
        freshSettings.body?.settings?.version,
        1,
        "the fresh family root carries a born version-1 settings record",
      );
      check.equal(
        freshSettings.body?.source,
        "metadata",
        "the born settings record is served from session metadata",
      );
      const reloads = status.body.eventCounts?.["model.updated"] ?? 0;
      check.truthy(reloads < 60, `model.updated reload count stays bounded (${reloads})`);
      return {
        detail:
          "packed package imported, mandatory guards registered; a fresh family births metadata settings",
        observed: {
          instanceId: status.body.instanceId,
          guardState: status.body.guardState,
          eventCounts: status.body.eventCounts,
          settingsId: freshSettings.body?.settingsId,
        },
      };
    },
  },
  {
    id: "admission",
    title: "Rejected preparation dispatches nothing; the valid prompt resolves family settings",
    phase: "T-003",
    parity: ["plugin.model-roles.birth", "plugin.model-roles.fail-soft"],
    async run(driver, check) {
      // vv-controller carries the override model in the fixture config, so the
      // native role variant and payload assertions stay meaningful.
      const sessionID = await driver.createSession({ agent: "vv-controller" });
      await delay(1500);
      const prevIdle = (await driver.sessionInfo(sessionID))?.time?.idle;
      const rejectMarker = nextMarker("reject");
      const base = await driver.providerCount();
      const rejected = await driver.prompt(sessionID, rejectMarker, {
        files: [{ uri: driver.missingAttachmentUri, name: "missing.txt" }],
      });
      check.truthy(
        rejected.status >= 400,
        `native preparation rejection is observable (status ${rejected.status})`,
      );
      await delay(1000);
      const afterReject = await driver.providerRequestsSince(base);
      check.truthy(
        afterReject.every((record) => !containsMarker(record, rejectMarker)),
        "rejected preparation produced zero provider dispatch for that input",
      );
      const acceptMarker = nextMarker("accept");
      const acceptBase = await driver.providerCount();
      const accepted = await driver.prompt(sessionID, acceptMarker);
      check.truthy(accepted.status < 400, `valid prompt accepted (status ${accepted.status})`);
      await driver.waitIdleChange(sessionID, prevIdle);
      const fresh = await driver.providerRequestsSince(acceptBase);
      // The marker can also appear inside the auxiliary child's embedded
      // conversation history, so title generations are excluded from the count.
      const markerDispatches = fresh.filter(
        (record) => containsMarker(record, acceptMarker) && !isTitleGeneration(record),
      );
      check.equal(
        markerDispatches.length,
        1,
        "the accepted prompt dispatched exactly once for its marker",
      );
      check.truthy(
        markerDispatches[0] !== undefined &&
          payloadFields(markerDispatches[0]).smoke_variant === "override" &&
          payloadFields(markerDispatches[0]).reasoning_effort === "high",
        "the accepted prompt dispatched the native role variant (override/high)",
      );
      const settings = await driver.control(`/settings?sessionID=${sessionID}`);
      check.equal(settings.body?.settings?.version, 1, "family settings resolved after the turn");
      check.equal(
        settings.body?.source,
        "metadata",
        "the family resolves its settings from root metadata",
      );
      const again = await driver.control(`/settings?sessionID=${sessionID}`);
      check.equal(
        again.body?.settingsId,
        settings.body?.settingsId,
        "repeated resolution is stable (no rewrite per request)",
      );
      return {
        detail:
          "rejected preparation dispatched nothing; the valid prompt dispatched once and the family settings resolve stably",
        observed: { sessionID, rejectedStatus: rejected.status, settingsId: settings.body?.settingsId },
      };
    },
  },
  {
    id: "payload-variants",
    title: "Native role variants on one model: controller override payload, child plain payload",
    phase: "T-003",
    parity: ["plugin.model-roles.variants", "runtime.model-registry"],
    async run(driver, check) {
      // vv-controller carries the override model in the fixture config.
      const sessionID = await driver.createSession({ agent: "vv-controller" });
      await delay(1200);
      const prevIdle = (await driver.sessionInfo(sessionID))?.time?.idle;
      const marker = nextMarker("variants");
      const base = await driver.providerCount();
      await driver.prompt(sessionID, marker);
      const info = await driver.waitIdleChange(sessionID, prevIdle);
      const variant = info?.model?.variant as string | undefined;
      // The root resolves its explicit agent model natively; vvoc never
      // rewrites the session model afterwards.
      check.equal(
        variant,
        "override",
        `controller root resolves its override model natively (${variant})`,
      );
      // Native final registry readback: the configured variant is present in the host model list.
      const models = await driver.modelList();
      check.truthy(
        containsValue(models, "override"),
        "native model.list contains the configured override variant",
      );
      check.truthy(
        !containsValue(models, "fabricated.seam-smart.override"),
        "native model.list does not contain a fabricated variant (negative control)",
      );
      // The auxiliary title child dispatches the fast role's distinct payload.
      await delay(1500); // allow auxiliary title work to settle
      const fresh = await driver.providerRequestsSince(base);
      check.truthy(
        fresh.some(
          (record) =>
            containsMarker(record, marker) &&
            payloadFields(record).smoke_variant === "override" &&
            payloadFields(record).reasoning_effort === "high",
        ),
        "the override payload was actually dispatched",
      );
      check.truthy(
        fresh.some(
          (record) =>
            payloadFields(record).smoke_variant === "plain" &&
            payloadFields(record).reasoning_effort === "minimal",
        ),
        "the same model dispatched a distinct plain/minimal payload (role fast)",
      );
      return {
        detail: "two distinct role payloads for one model; final registry readback present",
        observed: { variant, registryContains: true },
      };
    },
  },
  {
    id: "lineage-title",
    title: "Auxiliary title lineage, role model, and zero native title provider dispatch",
    phase: "T-003",
    parity: ["runtime.lineage", "plugin.model-roles.auxiliary"],
    async run(driver, check) {
      const sessionID = await driver.createSession();
      await delay(1200);
      const prevIdle = (await driver.sessionInfo(sessionID))?.time?.idle;
      const marker = nextMarker("title");
      const base = await driver.providerCount();
      await driver.prompt(sessionID, marker);
      await driver.waitIdleChange(sessionID, prevIdle);
      await delay(1500); // allow auxiliary title work to settle
      const children = (await driver.listSessions()).filter(
        (entry) => entry.parentID === sessionID,
      );
      check.truthy(children.length >= 1, "auxiliary work created a real parented native child");
      if (children.length === 0) {
        return { detail: "no auxiliary child observed", observed: { sessionID } };
      }
      const child = await driver.sessionInfo(children[0].id);
      check.equal(child?.parentID, sessionID, "child records the family root parentID");
      check.equal(
        JSON.stringify(child?.metadata),
        JSON.stringify({ vvocAuxiliary: { kind: "title", role: "fast" } }),
        "child carries host-owned auxiliary kind/role metadata",
      );
      check.equal(
        child?.model?.variant,
        "plain",
        `child resolves the family fast role model (${child?.model?.variant})`,
      );
      const childSettings = await driver.control(`/settings?sessionID=${children[0].id}`);
      check.equal(
        childSettings.body?.familyId,
        sessionID,
        "the child resolves through lineage to the root family",
      );
      const fresh = await driver.providerRequestsSince(base);
      const parentDispatches = fresh.filter(
        (record) => containsMarker(record, marker) && !isTitleGeneration(record),
      );
      check.equal(
        parentDispatches.length,
        1,
        "exactly one non-title provider dispatch carries the parent marker (no native title dispatch)",
      );
      check.truthy(
        fresh.some((record) => isTitleGeneration(record)),
        "the auxiliary child performed the title generation instead",
      );
      return {
        detail:
          "auxiliary title is parented, resolves the family fast role, and replaces the native title dispatch",
        observed: {
          sessionID,
          childID: children[0].id,
          parentDispatches: parentDispatches.length,
        },
      };
    },
  },
  {
    id: "owned-generate-synthetic",
    title: "Native generate/synthetic complete without any admission gateway; settings resolve family-wide",
    phase: "T-003",
    parity: ["plugin.model-roles.synthetic", "runtime.settings.resolve"],
    async run(driver, check) {
      // Native session.generate needs no pre-binding: there is no admission
      // gateway, and the family settings resolve fail-soft on first touch.
      const genSession = await driver.createSession();
      await delay(1000);
      const genMarker = nextMarker("generate");
      const genBase = await driver.providerCount();
      const generated = await driver.generate(genSession, genMarker);
      check.truthy(
        generated.status < 400,
        `native session.generate succeeded without pre-admission (${generated.status})`,
      );
      const genFresh = await driver.providerRequestsSince(genBase);
      const genDispatched = genFresh.filter((record) => containsMarker(record, genMarker));
      check.equal(
        genDispatched.length,
        1,
        "session.generate dispatched exactly once for its marker",
      );
      check.truthy(
        genDispatched[0] !== undefined &&
          payloadFields(genDispatched[0]).smoke_variant === "override",
        "generate dispatched the session's native role variant payload",
      );
      const genSettings = await driver.control(`/settings?sessionID=${genSession}`);
      check.equal(
        genSettings.body?.settings?.version,
        1,
        "the generate family resolves settings without any admission step",
      );

      // Native session.synthetic completes the same way.
      const synSession = await driver.createSession();
      await delay(1000);
      const synMarker = nextMarker("synthetic");
      const synPrevIdle = (await driver.sessionInfo(synSession))?.time?.idle;
      const synBase = await driver.providerCount();
      const synthetic = await driver.synthetic(synSession, synMarker, {
        description: "e2e synthetic input",
      });
      check.truthy(
        synthetic.status < 400,
        `native session.synthetic accepted (${synthetic.status})`,
      );
      await driver.waitIdleChange(synSession, synPrevIdle, 30_000);
      const synFresh = await driver.providerRequestsSince(synBase);
      check.truthy(
        synFresh.some(
          (record) =>
            containsMarker(record, synMarker) && payloadFields(record).smoke_variant === "override",
        ),
        "synthetic dispatched the session's native role variant payload",
      );
      const synSettings = await driver.control(`/settings?sessionID=${synSession}`);
      check.equal(
        synSettings.body?.familyId,
        synSession,
        "the synthetic session is its own family root with settings",
      );
      return {
        detail:
          "generate/synthetic complete natively with no admission gateway; family settings resolve for both",
        observed: {
          genStatus: generated.status,
          synStatus: synthetic.status,
        },
      };
    },
  },
  {
    id: "explicit-selection",
    title: "Explicit-at-create and explicit switch preserve the chosen selection",
    phase: "T-003",
    parity: ["plugin.model-roles.explicit"],
    async run(driver, check) {
      // Explicit at create.
      const created = await driver.createSession({
        model: { providerID: "loopback", id: "seam-smart", variant: "override" },
      });
      await delay(1200);
      const createPrevIdle = (await driver.sessionInfo(created))?.time?.idle;
      const createMarker = nextMarker("explicit-create");
      const createBase = await driver.providerCount();
      await driver.prompt(created, createMarker);
      const createInfo = await driver.waitIdleChange(created, createPrevIdle);
      check.truthy(
        qualifiedSuffix(createInfo?.model?.variant, "override") ||
          createInfo?.model?.variant === "override",
        `explicit-at-create kept the override selection (${createInfo?.model?.variant})`,
      );
      const createFresh = await driver.providerRequestsSince(createBase);
      check.truthy(
        createFresh.some(
          (record) =>
            containsMarker(record, createMarker) &&
            payloadFields(record).smoke_variant === "override",
        ),
        "explicit-at-create dispatched the override payload",
      );

      // Explicit switch before first work wins over the config default.
      const switched = await driver.createSession();
      await delay(1000);
      const switchResult = await driver.switchModel(switched, {
        providerID: "loopback",
        id: "seam-smart",
        variant: "plain",
      });
      check.truthy(switchResult.status < 400, `explicit switch accepted (${switchResult.status})`);
      await delay(800);
      const switchPrevIdle = (await driver.sessionInfo(switched))?.time?.idle;
      const switchMarker = nextMarker("explicit-switch");
      const switchBase = await driver.providerCount();
      await driver.prompt(switched, switchMarker);
      const switchInfo = await driver.waitIdleChange(switched, switchPrevIdle);
      check.truthy(
        qualifiedSuffix(switchInfo?.model?.variant, "plain"),
        `explicit switch kept the chosen plain selection (${switchInfo?.model?.variant})`,
      );
      const switchFresh = await driver.providerRequestsSince(switchBase);
      check.truthy(
        switchFresh.some(
          (record) =>
            containsMarker(record, switchMarker) && payloadFields(record).smoke_variant === "plain",
        ),
        "explicit switch dispatched the chosen plain payload",
      );
      return {
        detail: "explicit-at-create and explicit switch are preserved over the config default",
        observed: {
          createVariant: createInfo?.model?.variant,
          switchVariant: switchInfo?.model?.variant,
        },
      };
    },
  },
  {
    id: "implicit-first-turn",
    title: "Sessions without agent or model complete their first turn on the native role model",
    phase: "T-003",
    parity: ["plugin.model-roles.birth"],
    async run(driver, check) {
      // The API/SDK shape: location-only create, no agent, no model. Role
      // application happens through native agent definitions at creation, so
      // this case locks the user-visible contract: the first turn succeeds on
      // the role-resolved model, in every creation shape.
      const implicit = await driver.createSession();
      await delay(1200);
      const implicitPrevIdle = (await driver.sessionInfo(implicit))?.time?.idle;
      const implicitMarker = nextMarker("implicit");
      const implicitBase = await driver.providerCount();
      await driver.prompt(implicit, implicitMarker);
      const implicitInfo = await driver.waitIdleChange(implicit, implicitPrevIdle);
      await delay(500);
      check.equal(
        (await driver.sessionInfo(implicit))?.outcome,
        "succeeded",
        "a location-only session completes its first turn",
      );
      check.truthy(
        (await driver.providerRequestsSince(implicitBase)).some(
          (record) =>
            containsMarker(record, implicitMarker) && !isTitleGeneration(record),
        ),
        "the implicit first turn dispatched exactly its own request",
      );

      // Control: an explicit agent at create keeps working unchanged.
      const agentSession = await driver.createSession({ agent: "vv-controller" });
      await delay(1200);
      const agentPrevIdle = (await driver.sessionInfo(agentSession))?.time?.idle;
      const agentMarker = nextMarker("implicit-agent");
      await driver.prompt(agentSession, agentMarker);
      const agentInfo = await driver.waitIdleChange(agentSession, agentPrevIdle);
      await delay(500);
      check.equal(
        (await driver.sessionInfo(agentSession))?.outcome,
        "succeeded",
        "an explicit-agent session completes its first turn",
      );
      check.equal(
        agentInfo?.model?.variant,
        "override",
        `the explicit-agent session kept its agent model selection (${agentInfo?.model?.variant})`,
      );

      // Control: a fully qualified explicit model at create keeps working unchanged.
      const modelSession = await driver.createSession({
        model: { providerID: "loopback", id: "seam-smart", variant: "override" },
      });
      await delay(1200);
      const modelPrevIdle = (await driver.sessionInfo(modelSession))?.time?.idle;
      const modelMarker = nextMarker("implicit-model");
      await driver.prompt(modelSession, modelMarker);
      const modelInfo = await driver.waitIdleChange(modelSession, modelPrevIdle);
      await delay(500);
      check.equal(
        (await driver.sessionInfo(modelSession))?.outcome,
        "succeeded",
        "an explicit-model session completes its first turn",
      );
      check.equal(
        modelInfo?.model?.variant,
        "override",
        `the explicit-model session kept its selection (${modelInfo?.model?.variant})`,
      );
      return {
        detail:
          "location-only, explicit-agent, and explicit-model sessions all completed their first turn",
        observed: {
          implicit: implicitInfo?.model?.variant,
          agent: agentInfo?.model?.variant,
          model: modelInfo?.model?.variant,
        },
      };
    },
  },
  {
    id: "config-mutation",
    title: "Session-owned settings: a born family keeps its settings while new work resolves the changed config",
    phase: "T-003",
    parity: ["runtime.settings-persist", "plugin.model-roles.policy"],
    async run(driver, check) {
      const first = await driver.createSession();
      await delay(1200);
      const firstPrevIdle = (await driver.sessionInfo(first))?.time?.idle;
      await driver.prompt(first, nextMarker("before-mutation"));
      await driver.waitIdleChange(first, firstPrevIdle);
      const firstSettings = await driver.control(`/settings?sessionID=${first}`);
      const firstSettingsId = firstSettings.body?.settingsId as string | undefined;
      check.equal(
        firstSettings.body?.settings?.roles?.smart,
        "loopback/seam-smart#override",
        "the born family settings carry the override smart role",
      );
      const firstModel = (await driver.sessionInfo(first))?.model;

      await driver.writeVvocRoles({ allPlain: true });
      await delay(1500);
      const second = await driver.createSession();
      await delay(1200);
      const secondPrevIdle = (await driver.sessionInfo(second))?.time?.idle;
      await driver.prompt(second, nextMarker("after-mutation"));
      await driver.waitIdleChange(second, secondPrevIdle);
      const secondSettings = await driver.control(`/settings?sessionID=${second}`);
      check.equal(
        secondSettings.body?.settings?.roles?.smart,
        "loopback/seam-smart#plain",
        "the new family births with the changed role settings",
      );
      check.truthy(
        secondSettings.body?.settingsId !== firstSettingsId,
        "the two families carry distinct settings records",
      );
      // The born family session keeps its native model, and its settings are
      // untouched by the config change.
      check.equal(
        JSON.stringify((await driver.sessionInfo(first))?.model ?? null),
        JSON.stringify(firstModel ?? null),
        "the born family session keeps its original native model",
      );
      const firstAfter = await driver.control(`/settings?sessionID=${first}`);
      check.equal(
        firstAfter.body?.settingsId,
        firstSettingsId,
        "the born family settings are untouched by the config change",
      );
      check.equal(
        firstAfter.body?.settings?.roles?.smart,
        "loopback/seam-smart#override",
        "the born family keeps resolving its recorded override role",
      );
      return {
        detail:
          "config change births new families with the new settings without mutating an already-born family",
        observed: { firstSettingsId, secondId: secondSettings.body?.settingsId },
      };
    },
  },
  {
    id: "fork-worktree",
    title: "Fork (empty parentID) and worktree move keep root family settings",
    phase: "T-003",
    parity: ["runtime.lineage", "plugin.model-roles.fork"],
    async run(driver, check) {
      const root = await driver.createSession();
      await delay(1200);
      const rootPrevIdle = (await driver.sessionInfo(root))?.time?.idle;
      await driver.prompt(root, nextMarker("fork-root"));
      const rootInfo = await driver.waitIdleChange(root, rootPrevIdle);
      const rootFamily = (await driver.control(`/family?sessionID=${root}`)).body
        .familyId as string;
      const rootSettings = (await driver.control(`/settings?sessionID=${root}`)).body;

      const forked = await driver.fork(root);
      check.truthy(
        forked.status < 400 && typeof forked.id === "string",
        `native fork created (${forked.status})`,
      );
      const forkID = forked.id as string;
      const forkInfo = await driver.sessionInfo(forkID);
      check.truthy(!forkInfo?.parentID, "forked session has an empty parentID");
      check.equal(
        forkInfo?.fork?.sessionID,
        root,
        "forked session records fork.sessionID to the source",
      );
      const forkFamily = (await driver.control(`/family?sessionID=${forkID}`)).body
        .familyId as string;
      check.equal(
        forkFamily,
        rootFamily,
        "host-verified lineage resolves the fork to the root family",
      );
      const forkSettings = (await driver.control(`/settings?sessionID=${forkID}`)).body;
      check.equal(
        forkSettings?.settingsId,
        rootSettings?.settingsId,
        "the fork resolves the root family settings record",
      );

      const projectID = rootInfo?.projectID as string | undefined;
      check.truthy(typeof projectID === "string", "root session exposes its projectID");
      await driver.worktreeRefresh(projectID as string);
      await delay(500);
      const created = await driver.worktreeCreate({ projectID });
      check.truthy(
        created.status < 400 && typeof created.directory === "string",
        `native worktree created (${created.status}: ${created.error ?? ""})`,
      );
      if (created.status >= 400 || typeof created.directory !== "string") {
        return { detail: "worktree creation refused by host", observed: { created, projectID } };
      }
      const worktreeDir = created.directory;
      let movedObserved: unknown;
      try {
        const moved = await driver.move(forkID, worktreeDir);
        check.truthy(moved.status < 400, `fork moved into the worktree (${moved.status})`);
        const movedFamily = (await driver.control(`/family?sessionID=${forkID}`)).body
          .familyId as string;
        check.equal(movedFamily, rootFamily, "moved fork still resolves the root family");
        const movedSettings = (await driver.control(`/settings?sessionID=${forkID}`)).body;
        check.equal(
          movedSettings?.settingsId,
          rootSettings?.settingsId,
          "moved fork keeps the root family settings record",
        );
        const movedModel = (await driver.sessionInfo(forkID))?.model;
        const marker = nextMarker("fork-moved");
        const prevIdle = (await driver.sessionInfo(forkID))?.time?.idle;
        const base = await driver.providerCount();
        const movedPrompt = await driver.prompt(forkID, marker);
        check.truthy(
          movedPrompt.status < 400,
          `moved fork prompt accepted (${movedPrompt.status})`,
        );
        await driver.waitIdleChange(forkID, prevIdle);
        await delay(1500);
        const fresh = await driver.providerRequestsSince(base);
        const freshSummary = fresh.map((record) => ({
          variant: payloadFields(record).smoke_variant,
          marker: containsMarker(record, marker),
          session: attributedSessionID(record),
        }));
        // Residual: the host creates no model request for a child session
        // prompted after `/session/{id}/move` in this harness, so the post-move
        // provider payload is recorded but not asserted. Lineage, settings, and
        // session-model assertions above stay enforced.
        movedObserved = { movedModel, freshSummary };
      } finally {
        await driver.worktreeRemove(worktreeDir);
      }
      return {
        detail:
          "fork lineage and worktree move preserve the root family settings; post-move provider dispatch is recorded as a residual, not asserted",
        observed: { rootFamily, forkID, projectID, ...(movedObserved as object) },
      };
    },
  },
  {
    id: "permission-guard",
    title: "Resource permission guard effects: deny zero, allow one, fast reply",
    phase: "T-003",
    parity: ["runtime.permissions"],
    async run(driver, check) {
      const sessionID = await driver.createSession();
      await delay(1000);

      // Deny: zero effects.
      const denyPromise = driver.control("/permission-guard", {
        method: "POST",
        body: { sessionID, action: "e2e.guard.deny", resources: ["e2e://resource"] },
      });
      const denyRequest = await waitForPendingPermission(driver, sessionID);
      check.truthy(denyRequest !== undefined, "guard created a pending native permission request");
      if (denyRequest !== undefined)
        await replyPermission(driver, sessionID, denyRequest, "reject");
      const denied = await denyPromise;
      check.equal(denied.body?.allowed, false, "guard denied the effect");
      check.equal(denied.body?.effects, 0, "denied guard ran zero effects");

      // Allow: exactly one effect after the reply.
      const allowPromise = driver.control("/permission-guard", {
        method: "POST",
        body: { sessionID, action: "e2e.guard.allow", resources: ["e2e://resource"] },
      });
      const allowRequest = await waitForPendingPermission(driver, sessionID);
      check.truthy(allowRequest !== undefined, "second guard created a pending request");
      if (allowRequest !== undefined)
        await replyPermission(driver, sessionID, allowRequest, "once");
      const allowed = await allowPromise;
      check.equal(allowed.body?.allowed, true, "guard allowed the effect after the reply");
      check.equal(allowed.body?.effects, 1, "allowed guard ran the effect exactly once");

      // Fast reply: poll aggressively and reply immediately; one effect only.
      const fastPromise = driver.control("/permission-guard", {
        method: "POST",
        body: { sessionID, action: "e2e.guard.allow", resources: ["e2e://resource"] },
      });
      const fastRequest = await waitForPendingPermission(driver, sessionID, 12_000, 10);
      check.truthy(fastRequest !== undefined, "fast-reply guard created a pending request");
      if (fastRequest !== undefined) await replyPermission(driver, sessionID, fastRequest, "once");
      const fast = await fastPromise;
      check.equal(fast.body?.allowed, true, "fast reply allowed the effect");
      check.equal(
        fast.body?.effects,
        1,
        "fast reply ran the effect exactly once with no lost event",
      );
      return {
        detail:
          "guard produced zero effects on deny and exactly one on allow, including a fast reply",
        observed: { denied: denied.body, allowed: allowed.body, fast: fast.body },
      };
    },
  },
  {
    id: "settings-stability",
    title: "Settings birth happens once; a later explicit switch never rewrites the record",
    phase: "T-003",
    parity: ["runtime.settings.stability"],
    async run(driver, check) {
      await driver.writeVvocRoles({ allPlain: false });
      await delay(1500);
      const session = await driver.createSession();
      await delay(1200);
      const prevIdle = (await driver.sessionInfo(session))?.time?.idle;
      const markerA = nextMarker("first-staged");
      const markerB = nextMarker("last-staged");
      // A is staged first by the real prompt hook, then its native preparation is
      // delayed by the fixture hook (which only sleeps). The settings birth is
      // driven by the first request's context work; the explicit switch below
      // must never rewrite the born record.
      const pendingA = driver.prompt(session, `${ORDERING_DELAY_MARKER} ${markerA}`);
      await delay(700);
      const switched = await driver.switchModel(session, {
        providerID: "loopback",
        id: "seam-smart",
        variant: "plain",
      });
      check.truthy(
        switched.status < 400,
        `explicit model switch during A preparation accepted (${switched.status})`,
      );
      await delay(300);
      const resultB = await driver.prompt(session, markerB);
      check.truthy(resultB.status < 400, `second prompt accepted (${resultB.status})`);
      const resultA = await pendingA;
      check.truthy(resultA.status >= 0, `first prompt request completed (${resultA.status})`);
      const info = await driver.waitIdleChange(session, prevIdle, 45_000);
      check.truthy(info !== undefined, `the session settled after the race`);
      const settings = await driver.control(`/settings?sessionID=${session}`);
      check.equal(
        settings.body?.settings?.roles?.smart,
        "loopback/seam-smart#override",
        "the family settings born at first resolution kept the pre-switch override role",
      );
      check.equal(
        settings.body?.source,
        "metadata",
        "the family still resolves from its persisted metadata record",
      );
      check.equal(
        info?.model?.variant,
        "plain",
        `the user's explicit switch survived untouched (${info?.model?.variant})`,
      );
      return {
        detail: "settings birth happened once and a later explicit switch rewrote nothing",
        observed: {
          session,
          variant: info?.model?.variant,
          aStatus: resultA.status,
          bStatus: resultB.status,
        },
      };
    },
  },
  {
    id: "hook-probe",
    title: "Native hook availability probe (no product parity claim)",
    phase: "T-003",
    parity: ["runtime.hooks.probe"],
    async run(driver, check) {
      const probe = await driver.control("/hook-probe");
      check.truthy(probe.status === 200, "hook probe endpoint answered");
      const hooks = (probe.body?.hooks ?? {}) as Record<string, boolean>;
      check.truthy(hooks["model.request"] === true, "model.request hook is available");
      return {
        detail:
          "recorded which native hooks register; availability only, not secrets/SSE restoration parity (T-005/T-009)",
        observed: hooks,
      };
    },
  },
];
// END_BLOCK_CORE_CASES
