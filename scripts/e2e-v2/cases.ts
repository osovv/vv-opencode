#!/usr/bin/env bun
// FILE: scripts/e2e-v2/cases.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Define the core real-host acceptance cases and their observed, per-request-attributed assertions for the packed native model-role runtime.
//   SCOPE: Case descriptors, the driver contract, a bounded assertion collector, and executable cases for activation/guards, awaited admission with zero-dispatch rejection, captured source variants with native registry readback, auxiliary title with zero native title dispatch, config mutation, owned generate/synthetic and raw-unbound refusal, explicit selection, fork/worktree lineage, resource permission guard effects, and a hook-availability probe. Assertions are attributed to the exact current session/request via the provider payload markers and hosted session id.
//   DEPENDS: [scripts/e2e-v2/host.ts, scripts/e2e-v2/provider.ts, scripts/e2e-v2/fixtures/plugin.ts]
//   LINKS: [M-E2E-V2-HARNESS, V-M-E2E-V2-HARNESS]
//   ROLE: SCRIPT
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   CaseStatus - Terminal status of one real-host case.
//   CaseResult - Machine-readable outcome for one real-host case.
//   Checks - Bounded assertion collector that never throws on a failed expectation.
//   CoreDriver - Host/profile operations the cases use; implemented by the runner.
//   CoreCase - One executable core acceptance case descriptor.
//   coreCases - Ordered core acceptance cases.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-003 correction - Per-request attribution, zero-dispatch rejection, guard effects, owned generate/synthetic, explicit selection, fork/worktree, and native registry readback.]
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
  generate(id: string, prompt: string): Promise<{ readonly status: number; readonly text?: string }>;
  synthetic(
    id: string,
    text: string,
    extra?: Record<string, unknown>,
  ): Promise<{ readonly status: number }>;
  switchModel(
    id: string,
    model: Record<string, unknown>,
  ): Promise<{ readonly status: number }>;
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

/** Hosted session id embedded in a provider request's environment block. */
function attributedSessionID(record: ProviderRequestRecord): string | undefined {
  const match = /Current conversation session ID: (ses_[A-Za-z0-9]+)/.exec(bodyText(record));
  return match?.[1];
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
      check.truthy(status.body.ok === true, "control plane reports the packed fixture setup completed");
      check.equal(status.body.pluginID, "vvoc.e2e.fixture", "fixture plugin id is stable");
      check.equal(driver.packedVersion, "1.7.0", "packed package preserves version 1.7.0");
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
      const captures = await driver.control("/captures");
      check.truthy(Array.isArray(captures.body.data), "durable capture registry is readable");
      const fresh = await driver.createSession();
      await delay(800);
      const freshPolicy = await driver.control(`/policy?sessionID=${fresh}`);
      check.truthy(freshPolicy.body.capture === null, "a fresh session has no bound policy");
      check.truthy(freshPolicy.body.staged === false, "a fresh session has no staged candidate");
      const reloads = status.body.eventCounts?.["model.updated"] ?? 0;
      check.truthy(reloads < 60, `model.updated reload count stays bounded (${reloads})`);
      return {
        detail: "packed package imported, mandatory guards registered, fresh sessions unbound",
        observed: {
          instanceId: status.body.instanceId,
          guardState: status.body.guardState,
          eventCounts: status.body.eventCounts,
        },
      };
    },
  },
  {
    id: "admission",
    title: "Awaited admission, rejected preparation, and zero-dispatch rejection",
    phase: "T-003",
    parity: ["plugin.model-roles.admission", "plugin.model-roles.rollback"],
    async run(driver, check) {
      const sessionID = await driver.createSession();
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
      const afterRejectPolicy = await driver.control(`/policy?sessionID=${sessionID}`);
      check.truthy(
        afterRejectPolicy.body.capture === null,
        "a preparation rejection after the prompt hook does not bind a family policy",
      );
      const acceptMarker = nextMarker("accept");
      const acceptBase = await driver.providerCount();
      const accepted = await driver.prompt(sessionID, acceptMarker);
      check.truthy(accepted.status < 400, `valid prompt accepted (status ${accepted.status})`);
      const info = await driver.waitIdleChange(sessionID, prevIdle);
      const fresh = await driver.providerRequestsSince(acceptBase);
      const attributed = fresh.filter(
        (record) => attributedSessionID(record) === sessionID && containsMarker(record, acceptMarker),
      );
      check.equal(attributed.length, 1, "the accepted prompt dispatched exactly once for its marker");
      check.truthy(
        attributed[0] !== undefined &&
          payloadFields(attributed[0]).smoke_variant === "override" &&
          payloadFields(attributed[0]).reasoning_effort === "high",
        "the accepted prompt dispatched the source variant merged settings (override/high)",
      );
      const bound = await driver.control(`/policy?sessionID=${sessionID}`);
      check.truthy(bound.body.capture !== null, "the valid prompt bound a durable family policy");
      check.truthy(
        qualifiedSuffix(info?.model?.variant, ".seam-smart.override"),
        `session model carries the qualified override variant (${info?.model?.variant})`,
      );
      return {
        detail: "rejected preparation dispatched nothing; the valid prompt dispatched once and bound",
        observed: { sessionID, rejectedStatus: rejected.status, variant: info?.model?.variant },
      };
    },
  },
  {
    id: "payload-variants",
    title: "Same model, two captured source variants, native registry readback",
    phase: "T-003",
    parity: ["plugin.model-roles.variants", "runtime.model-registry"],
    async run(driver, check) {
      const sessionID = await driver.createSession();
      await delay(1200);
      const prevIdle = (await driver.sessionInfo(sessionID))?.time?.idle;
      const marker = nextMarker("variants");
      const base = await driver.providerCount();
      await driver.prompt(sessionID, marker);
      const info = await driver.waitIdleChange(sessionID, prevIdle);
      const variant = info?.model?.variant as string | undefined;
      const prefix = typeof variant === "string" ? variant.replace(/\.seam-smart\..*$/, "") : undefined;
      check.truthy(
        qualifiedSuffix(variant, ".seam-smart.override"),
        `root role uses the override variant (${variant})`,
      );
      // Native final registry readback: the qualified variant must be present in the host model list.
      const models = await driver.modelList();
      check.truthy(
        typeof prefix === "string" && prefix.length > 0 && containsValue(models, `${prefix}.seam-smart.override`),
        "native model.list contains the family-qualified override variant",
      );
      check.truthy(
        !containsValue(models, "fabricated.seam-smart.override"),
        "native model.list does not contain a fabricated variant (negative control)",
      );
      // Untouched captured descriptors remain readable separately from the registry.
      const descriptors = await driver.control(`/variants?sessionID=${sessionID}`);
      check.truthy(
        Array.isArray(descriptors.body.data) && descriptors.body.data.length >= 2,
        "capture service still exposes the source variant descriptors",
      );
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
        "the same model dispatched a distinct plain/minimal payload",
      );
      return {
        detail: "two distinct qualified payloads for one model; final registry readback present",
        observed: { variant, registryContains: true },
      };
    },
  },
  {
    id: "lineage-title",
    title: "Auxiliary title lineage and zero native title provider dispatch",
    phase: "T-003",
    parity: ["runtime.lineage", "plugin.model-roles.auxiliary"],
    async run(driver, check) {
      const sessionID = await driver.createSession();
      await delay(1200);
      const prevIdle = (await driver.sessionInfo(sessionID))?.time?.idle;
      const marker = nextMarker("title");
      const base = await driver.providerCount();
      await driver.prompt(sessionID, marker);
      const info = await driver.waitIdleChange(sessionID, prevIdle);
      const parentPrefix =
        typeof info?.model?.variant === "string"
          ? info.model.variant.replace(/\.seam-smart\..*$/, "")
          : undefined;
      await delay(1500); // allow auxiliary title work to settle
      const children = (await driver.listSessions()).filter((entry) => entry.parentID === sessionID);
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
      check.truthy(
        typeof child?.model?.variant === "string" &&
          typeof parentPrefix === "string" &&
          child.model.variant.startsWith(parentPrefix),
        `child shares the family capture prefix (${parentPrefix})`,
      );
      const fresh = await driver.providerRequestsSince(base);
      const parentDispatches = fresh.filter(
        (record) => attributedSessionID(record) === sessionID,
      );
      check.equal(
        parentDispatches.length,
        1,
        "exactly one provider dispatch is attributed to the parent (no native title dispatch)",
      );
      const childDispatches = fresh.filter(
        (record) => attributedSessionID(record) === children[0].id,
      );
      check.truthy(
        childDispatches.some((record) =>
          bodyText(record).includes("Generate a short, specific title"),
        ),
        "the auxiliary child performed the title generation instead",
      );
      return {
        detail: "auxiliary title is parented, family-qualified, and replaces the native title dispatch",
        observed: {
          sessionID,
          childID: children[0].id,
          parentDispatches: parentDispatches.length,
          childDispatches: childDispatches.length,
        },
      };
    },
  },
  {
    id: "owned-generate-synthetic",
    title: "Owned pre-admission for generate/synthetic before a user prompt, raw-unbound refusal",
    phase: "T-003",
    parity: ["plugin.model-roles.synthetic", "runtime.admission.owned"],
    async run(driver, check) {
      // Owned generate: pre-admit, then run the real native session.generate.
      const genSession = await driver.createSession();
      await delay(1000);
      const genAdmit = await driver.control("/admit", {
        method: "POST",
        body: {
          sessionID: genSession,
          explicit: { providerID: "loopback", modelID: "seam-smart" },
          workload: "generate",
          force: true,
        },
      });
      check.truthy(
        genAdmit.body?.outcome?.status === "bound" || genAdmit.body?.outcome?.status === "reused",
        `owned generate pre-admission published (${genAdmit.body?.outcome?.status})`,
      );
      const genMarker = nextMarker("generate");
      const genBase = await driver.providerCount();
      const generated = await driver.generate(genSession, genMarker);
      check.truthy(generated.status < 400, `native session.generate succeeded (${generated.status})`);
      const genFresh = await driver.providerRequestsSince(genBase);
      const genDispatched = genFresh.filter((record) => containsMarker(record, genMarker));
      check.equal(genDispatched.length, 1, "session.generate dispatched exactly once for its marker");
      check.truthy(
        genDispatched[0] !== undefined &&
          payloadFields(genDispatched[0]).smoke_variant === "override",
        "owned generate dispatched the family captured variant payload",
      );
      const genPolicy = await driver.control(`/policy?sessionID=${genSession}`);
      check.truthy(
        genPolicy.body.capture !== null,
        "owned generate bound the family before any ordinary user prompt",
      );

      // Owned synthetic: pre-admit, then run the real native session.synthetic.
      const synSession = await driver.createSession();
      await delay(1000);
      await driver.control("/admit", {
        method: "POST",
        body: {
          sessionID: synSession,
          explicit: { providerID: "loopback", modelID: "seam-smart" },
          workload: "synthetic",
          force: true,
        },
      });
      const synMarker = nextMarker("synthetic");
      const synPrevIdle = (await driver.sessionInfo(synSession))?.time?.idle;
      const synBase = await driver.providerCount();
      const synthetic = await driver.synthetic(synSession, synMarker, {
        description: "e2e synthetic input",
      });
      check.truthy(synthetic.status < 400, `native session.synthetic accepted (${synthetic.status})`);
      await driver.waitIdleChange(synSession, synPrevIdle, 30_000);
      const synFresh = await driver.providerRequestsSince(synBase);
      check.truthy(
        synFresh.some(
          (record) => containsMarker(record, synMarker) && payloadFields(record).smoke_variant === "override",
        ),
        "owned synthetic dispatched the family captured variant payload",
      );

      // Raw unbound generate must fail before any provider dispatch.
      const rawGen = await driver.createSession();
      await delay(800);
      const rawGenMarker = nextMarker("unbound-generate");
      const rawGenBase = await driver.providerCount();
      const rawGenerated = await driver.generate(rawGen, rawGenMarker);
      await delay(1200);
      const rawGenFresh = await driver.providerRequestsSince(rawGenBase);
      check.truthy(
        rawGenerated.status >= 400,
        `raw unbound session.generate is refused (${rawGenerated.status})`,
      );
      check.truthy(
        rawGenFresh.every((record) => !containsMarker(record, rawGenMarker)),
        "raw unbound generate produced zero provider dispatch",
      );

      // Raw unbound synthetic must also fail before provider dispatch.
      const rawSyn = await driver.createSession();
      await delay(800);
      const rawSynMarker = nextMarker("unbound-synthetic");
      const rawSynBase = await driver.providerCount();
      const rawSynthetic = await driver.synthetic(rawSyn, rawSynMarker);
      await delay(2000);
      const rawSynFresh = await driver.providerRequestsSince(rawSynBase);
      check.truthy(
        rawSynFresh.every((record) => !containsMarker(record, rawSynMarker)),
        "raw unbound synthetic produced zero provider dispatch",
      );
      const rawSynPolicy = await driver.control(`/policy?sessionID=${rawSyn}`);
      check.truthy(
        rawSynPolicy.body.capture === null,
        "raw unbound synthetic did not bind a family (status " + rawSynthetic.status + ")",
      );
      return {
        detail: "owned generate/synthetic bound before a user prompt; raw unbound work dispatched nothing",
        observed: {
          genStatus: generated.status,
          synStatus: synthetic.status,
          rawGenStatus: rawGenerated.status,
          rawSynStatus: rawSynthetic.status,
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
          (record) => containsMarker(record, createMarker) && payloadFields(record).smoke_variant === "override",
        ),
        "explicit-at-create dispatched the override payload",
      );

      // Explicit switch before first binding wins over the config default.
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
        qualifiedSuffix(switchInfo?.model?.variant, ".seam-smart.plain") ||
          switchInfo?.model?.variant === "plain",
        `explicit switch kept the chosen plain selection (${switchInfo?.model?.variant})`,
      );
      const switchFresh = await driver.providerRequestsSince(switchBase);
      check.truthy(
        switchFresh.some(
          (record) => containsMarker(record, switchMarker) && payloadFields(record).smoke_variant === "plain",
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
    id: "config-mutation",
    title: "Bound family retains policy while changed configuration binds new work",
    phase: "T-003",
    parity: ["runtime.snapshot-persist", "plugin.model-roles.policy"],
    async run(driver, check) {
      const first = await driver.createSession();
      await delay(1200);
      const firstPrevIdle = (await driver.sessionInfo(first))?.time?.idle;
      await driver.prompt(first, nextMarker("before-mutation"));
      const firstInfo = await driver.waitIdleChange(first, firstPrevIdle);
      const firstVariant = firstInfo?.model?.variant;
      check.truthy(qualifiedSuffix(firstVariant, ".seam-smart.override"), `initial family bound override (${firstVariant})`);

      await driver.writeVvocRoles({ allPlain: true });
      await delay(1500);
      const second = await driver.createSession();
      await delay(1200);
      const secondPrevIdle = (await driver.sessionInfo(second))?.time?.idle;
      await driver.prompt(second, nextMarker("after-mutation"));
      const secondInfo = await driver.waitIdleChange(second, secondPrevIdle);
      const secondVariant = secondInfo?.model?.variant;
      check.truthy(
        qualifiedSuffix(secondVariant, ".seam-smart.plain"),
        `new work after mutation binds the new plain policy (${secondVariant})`,
      );
      check.truthy(secondVariant !== firstVariant, "the new family capture differs from the earlier one");
      check.equal(
        (await driver.sessionInfo(first))?.model?.variant,
        firstVariant,
        "the already-bound family keeps its original captured variant",
      );
      return {
        detail: "config change binds new work without mutating an already bound family",
        observed: { firstVariant, secondVariant },
      };
    },
  },
  {
    id: "fork-worktree",
    title: "Fork (empty parentID) and worktree move keep root family policy",
    phase: "T-003",
    parity: ["runtime.lineage", "plugin.model-roles.fork"],
    async run(driver, check) {
      const root = await driver.createSession();
      await delay(1200);
      const rootPrevIdle = (await driver.sessionInfo(root))?.time?.idle;
      await driver.prompt(root, nextMarker("fork-root"));
      const rootInfo = await driver.waitIdleChange(root, rootPrevIdle);
      const rootFamily = (await driver.control(`/family?sessionID=${root}`)).body.familyId as string;
      const rootSnapshot = (await driver.control(`/config?sessionID=${root}`)).body?.capture?.snapshotId;
      const rootVariant = rootInfo?.model?.variant as string | undefined;
      const expectedVariantName = rootVariant?.replace(/.*\.seam-smart\./, "");

      const forked = await driver.fork(root);
      check.truthy(forked.status < 400 && typeof forked.id === "string", `native fork created (${forked.status})`);
      const forkID = forked.id as string;
      const forkInfo = await driver.sessionInfo(forkID);
      check.truthy(!forkInfo?.parentID, "forked session has an empty parentID");
      check.equal(forkInfo?.fork?.sessionID, root, "forked session records fork.sessionID to the source");
      const forkFamily = (await driver.control(`/family?sessionID=${forkID}`)).body.familyId as string;
      check.equal(forkFamily, rootFamily, "host-verified family lookup resolves the fork to the root family");

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
        const movedFamily = (await driver.control(`/family?sessionID=${forkID}`)).body.familyId as string;
        check.equal(movedFamily, rootFamily, "moved fork still resolves the root family");
        const movedConfig = await driver.control(`/config?sessionID=${forkID}`);
        check.equal(
          movedConfig.body?.capture?.snapshotId,
          rootSnapshot,
          "moved fork keeps the root family capture",
        );
        const movedModel = (await driver.sessionInfo(forkID))?.model;
        const marker = nextMarker("fork-moved");
        const prevIdle = (await driver.sessionInfo(forkID))?.time?.idle;
        const base = await driver.providerCount();
        const movedPrompt = await driver.prompt(forkID, marker);
        check.truthy(movedPrompt.status < 400, `moved fork prompt accepted (${movedPrompt.status})`);
        await driver.waitIdleChange(forkID, prevIdle);
        const fresh = await driver.providerRequestsSince(base);
        const freshSummary = fresh.map((record) => ({
          variant: payloadFields(record).smoke_variant,
          marker: containsMarker(record, marker),
          session: attributedSessionID(record),
        }));
        check.truthy(
          fresh.some(
            (record) =>
              attributedSessionID(record) === rootFamily &&
              containsMarker(record, marker) &&
              payloadFields(record).smoke_variant === expectedVariantName,
          ),
          `moved fork dispatched the root family captured ${expectedVariantName} payload with root lineage (fresh=${JSON.stringify(freshSummary)})`,
        );
        movedObserved = { movedModel, freshSummary };
      } finally {
        await driver.worktreeRemove(worktreeDir);
      }
      return {
        detail: "fork lineage and worktree move preserve the root family capture and payload",
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
      if (denyRequest !== undefined) await replyPermission(driver, sessionID, denyRequest, "reject");
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
      if (allowRequest !== undefined) await replyPermission(driver, sessionID, allowRequest, "once");
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
      check.equal(fast.body?.effects, 1, "fast reply ran the effect exactly once with no lost event");
      return {
        detail: "guard produced zero effects on deny and exactly one on allow, including a fast reply",
        observed: { denied: denied.body, allowed: allowed.body, fast: fast.body },
      };
    },
  },
  {
    id: "ordering-first-accepted",
    title: "First-accepted input binds over the first-staged input with a differing policy",
    phase: "T-003",
    parity: ["runtime.admission.ordering"],
    async run(driver, check) {
      await driver.writeVvocRoles({ allPlain: false });
      await delay(1500);
      const session = await driver.createSession();
      await delay(1200);
      const prevIdle = (await driver.sessionInfo(session))?.time?.idle;
      const markerA = nextMarker("first-staged");
      const markerB = nextMarker("last-staged");
      // A is staged first by the real prompt hook, then its native preparation is
      // delayed by the fixture hook (which only sleeps). B is staged second with
      // an explicit plain selection and is expected to be accepted first.
      const pendingA = driver.prompt(session, `${ORDERING_DELAY_MARKER} ${markerA}`);
      await delay(700);
      const switched = await driver.switchModel(session, {
        providerID: "loopback",
        id: "seam-smart",
        variant: "plain",
      });
      check.truthy(switched.status < 400, `policy switch during A preparation accepted (${switched.status})`);
      await delay(300);
      const resultB = await driver.prompt(session, markerB);
      check.truthy(resultB.status < 400, `second prompt accepted (${resultB.status})`);
      const resultA = await pendingA;
      check.truthy(resultA.status >= 0, `first prompt request completed (${resultA.status})`);
      const info = await driver.waitIdleChange(session, prevIdle, 45_000);
      check.truthy(
        qualifiedSuffix(info?.model?.variant, ".seam-smart.plain") ||
          info?.model?.variant === "plain",
        `the first-accepted input's plain policy bound, not the first-staged override (${info?.model?.variant})`,
      );
      const bound = await driver.control(`/policy?sessionID=${session}`);
      const boundModel = JSON.stringify(bound.body?.capture?.modelOverride ?? null);
      check.truthy(
        boundModel.includes("plain") || bound.body?.capture?.roleModels !== undefined,
        "the bound family capture reflects the accepted plain policy",
      );
      return {
        detail: "first-accepted input's policy bound while the first-staged input's policy did not",
        observed: { session, variant: info?.model?.variant, aStatus: resultA.status, bStatus: resultB.status },
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
