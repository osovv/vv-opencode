// FILE: src/plugins/workflow/authority.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Deterministic pure-contract tests for bounded advance authority: root-user eligibility, shared three-unit reserve accounting, replay/duplicate rejection, finite extension, narrowing/revocation, and truthful reserved-stage provenance.
//   SCOPE: Pure authority domain only; no runtime, SDK, or persistence access.
//   DEPENDS: [bun:test, src/plugins/workflow/authority.ts, src/lib/workflow-contract.ts]
//   LINKS: [M-WORKFLOW-AUTHORITY]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SESSION - Stable session identifier for authority fixtures.
//   scope - Delegatable scope with publication reserved.
//   message - Builds an eligible root-user message snapshot.
//   codeOf - Extracts the rejection code from a union result for assertions.
//   grant - Grants one valid authority record with its message claim map.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-WORKFLOW-PLAN-INDEPENDENCE - Initial authority coverage.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import type { WorkflowAuthorityRecord, WorkflowMessageClaim } from "../../lib/workflow-contract.js";
import {
  ADVANCE_RECOVERY_RESERVE,
  advanceUnitsAvailable,
  effectiveAuthorityStages,
  extendAdvanceAuthority,
  grantAdvanceAuthority,
  narrowAdvanceAuthority,
  proposeReserveDebit,
  proposeStageApproval,
  revokeAdvanceAuthority,
  validateAuthorityMessage,
  type AuthorityMessageSnapshot,
} from "./authority.js";

const SESSION = "session-authority";

const scope = {
  stages: ["specification", "planning", "implementation", "verification"] as const,
  decisionScope: "Finish the authorized prototype without intermediate questions.",
  fileBoundary: ["src/lib/a.ts"],
  reservedStops: ["specification"] as const,
};

function message(overrides: Partial<AuthorityMessageSnapshot> = {}): AuthorityMessageSnapshot {
  return {
    messageId: "msg-1",
    sessionId: SESSION,
    role: "user",
    createdMs: 1_000,
    ignored: false,
    syntheticOnly: false,
    textParts: ["finish autonomously"],
    ...overrides,
  };
}

function grant(
  overrides: { authorityId?: string; runId?: string; snapshot?: AuthorityMessageSnapshot } = {},
) {
  const claims = new Map<string, WorkflowMessageClaim>();
  const result = grantAdvanceAuthority({
    authorityId: overrides.authorityId ?? "auth-1",
    runId: overrides.runId ?? "run-1",
    sessionId: SESSION,
    message: overrides.snapshot ?? message(),
    scope: {
      stages: [...scope.stages],
      decisionScope: scope.decisionScope,
      fileBoundary: [...scope.fileBoundary],
      reservedStops: [...scope.reservedStops],
    },
    existingAuthorities: [],
    messageClaims: claims,
    nowMs: 1_500,
  });
  if (!result.ok) throw new Error(result.message);
  return { record: result.value.record, claims };
}

function codeOf(result: { ok: boolean }): string | undefined {
  return result.ok ? undefined : (result as { code?: string }).code;
}

describe("root-user message eligibility", () => {
  test("accepts an observable eligible root-user message", () => {
    expect(validateAuthorityMessage(message(), SESSION).ok).toBe(true);
  });

  test("rejects foreign sessions, assistant, ignored, synthetic-only, and empty messages", () => {
    expect(codeOf(validateAuthorityMessage(message({ sessionId: "other" }), SESSION))).toBe(
      "FOREIGN_SESSION",
    );
    expect(codeOf(validateAuthorityMessage(message({ role: "assistant" }), SESSION))).toBe(
      "ASSISTANT_MESSAGE",
    );
    expect(codeOf(validateAuthorityMessage(message({ ignored: true }), SESSION))).toBe(
      "IGNORED_MESSAGE",
    );
    expect(codeOf(validateAuthorityMessage(message({ syntheticOnly: true }), SESSION))).toBe(
      "SYNTHETIC_ONLY",
    );
    expect(codeOf(validateAuthorityMessage(message({ textParts: ["  "] }), SESSION))).toBe(
      "EMPTY_MESSAGE",
    );
    expect(codeOf(validateAuthorityMessage(message({ messageId: "" }), SESSION))).toBe(
      "MISSING_IDENTITY",
    );
  });
});

describe("shared finite reserve", () => {
  test("grants three units shared across two task targets and a checkpoint", () => {
    const { record } = grant();
    expect(record.initialUnits).toBe(ADVANCE_RECOVERY_RESERVE);
    const debits = [];
    for (const [recoveryId, targetKind, targetId] of [
      ["rec-1", "task", "T-100"],
      ["rec-2", "task", "T-200"],
      ["rec-3", "checkpoint", "C-100"],
    ] as const) {
      const debit = proposeReserveDebit({
        authority: record,
        debits,
        recoveryId,
        targetKind,
        targetId,
        nowMs: 2_000,
      });
      expect(debit.ok).toBe(true);
      if (debit.ok) debits.push(debit.value);
    }
    expect(advanceUnitsAvailable(record, debits)).toBe(0);
    const fourth = proposeReserveDebit({
      authority: record,
      debits,
      recoveryId: "rec-4",
      targetKind: "task",
      targetId: "T-300",
      nowMs: 2_100,
    });
    expect(fourth.ok).toBe(false);
    if (fourth.ok) return;
    expect(fourth.code).toBe("RESERVE_EXHAUSTED");
  });

  test("rejects a duplicate recovery id without double-debiting", () => {
    const { record } = grant();
    const first = proposeReserveDebit({
      authority: record,
      debits: [],
      recoveryId: "rec-dup",
      targetKind: "task",
      targetId: "T-100",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = proposeReserveDebit({
      authority: record,
      debits: [first.value],
      recoveryId: "rec-dup",
      targetKind: "task",
      targetId: "T-200",
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("DUPLICATE_DEBIT");
  });

  test("rejects duplicate initial registration and exact replay across execution keys", () => {
    const { record } = grant();
    const claims = new Map<string, WorkflowMessageClaim>();
    const duplicate = grantAdvanceAuthority({
      authorityId: "auth-1",
      runId: "run-1",
      sessionId: SESSION,
      message: message({ messageId: "msg-other" }),
      scope: {
        stages: ["implementation"],
        decisionScope: "x",
        fileBoundary: [],
        reservedStops: [],
      },
      existingAuthorities: [record],
      messageClaims: claims,
    });
    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) return;
    expect(duplicate.code).toBe("DUPLICATE_GRANT");

    // The originating message cannot fund a different execution under a new key.
    const replay = grantAdvanceAuthority({
      authorityId: "auth-2",
      runId: "run-2",
      sessionId: SESSION,
      message: message(),
      scope: {
        stages: ["implementation"],
        decisionScope: "x",
        fileBoundary: [],
        reservedStops: [],
      },
      existingAuthorities: [],
      messageClaims: grant().claims,
    });
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.code).toBe("MESSAGE_REPLAY");
  });
});

describe("extension, narrowing, and revocation", () => {
  test("extends by three units only from a newer eligible instruction", () => {
    const { record, claims } = grant();
    const stale = extendAdvanceAuthority({
      authority: record,
      extensionId: "ext-stale",
      sessionId: SESSION,
      message: message({ messageId: "msg-old", createdMs: 900 }),
      messageClaims: claims,
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.code).toBe("STALE_EXTENSION");

    const fresh = extendAdvanceAuthority({
      authority: record,
      extensionId: "ext-1",
      sessionId: SESSION,
      message: message({ messageId: "msg-new", createdMs: 5_000 }),
      messageClaims: claims,
      nowMs: 5_100,
    });
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.value.units).toBe(ADVANCE_RECOVERY_RESERVE);
    expect(advanceUnitsAvailable({ ...record, extensions: [fresh.value] }, [])).toBe(6);
  });

  test("narrowing keeps surviving-stage credits while revocation disables all future credits", () => {
    const { record } = grant();
    const debit = proposeReserveDebit({
      authority: record,
      debits: [],
      recoveryId: "rec-1",
      targetKind: "task",
      targetId: "T-100",
      stage: "implementation",
    });
    expect(debit.ok).toBe(true);
    if (!debit.ok) return;
    const narrowed = narrowAdvanceAuthority({
      authority: record,
      revocationId: "narrow-1",
      reason: "Narrow to implementation only.",
      narrowedStages: ["implementation"],
    });
    expect(narrowed.ok).toBe(true);
    if (!narrowed.ok) return;
    expect(narrowed.value.kind).toBe("narrow");
    const narrowedRecord: WorkflowAuthorityRecord = { ...record, revocations: [narrowed.value] };
    // Narrowing does not forfeit surviving-stage credits (2 remain after one debit).
    expect(advanceUnitsAvailable(narrowedRecord, [debit.value])).toBe(2);
    expect(effectiveAuthorityStages(narrowedRecord)).toEqual(["implementation"]);
    const inScope = proposeReserveDebit({
      authority: narrowedRecord,
      debits: [debit.value],
      recoveryId: "rec-2",
      targetKind: "checkpoint",
      targetId: "C-100",
      stage: "implementation",
    });
    expect(inScope.ok).toBe(true);
    const outOfScope = proposeReserveDebit({
      authority: narrowedRecord,
      debits: [debit.value],
      recoveryId: "rec-3",
      targetKind: "task",
      targetId: "T-200",
      stage: "specification",
    });
    expect(outOfScope.ok).toBe(false);
    if (outOfScope.ok) return;
    expect(outOfScope.code).toBe("STAGE_NOT_DELEGATED");

    const revoked = revokeAdvanceAuthority({
      authority: record,
      revocationId: "revoke-1",
      reason: "User revoked autonomy.",
    });
    expect(revoked.ok).toBe(true);
    if (!revoked.ok) return;
    expect(revoked.value.kind).toBe("revoke");
    expect(advanceUnitsAvailable({ ...record, revocations: [revoked.value] }, [debit.value])).toBe(
      0,
    );
    expect(
      revokeAdvanceAuthority({
        authority: { ...record, revocations: [revoked.value] },
        revocationId: "revoke-2",
        reason: "again",
      }).ok,
    ).toBe(false);
  });

  test("rejects a second initial grant for the same execution under a new authority id", () => {
    const { record } = grant();
    const second = grantAdvanceAuthority({
      authorityId: "auth-2",
      runId: "run-1",
      sessionId: SESSION,
      message: message({ messageId: "msg-second", createdMs: 2_000 }),
      scope: {
        stages: ["implementation"],
        decisionScope: "second",
        fileBoundary: [],
        reservedStops: [],
      },
      existingAuthorities: [record],
      messageClaims: new Map(),
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("DUPLICATE_GRANT");
  });
});

describe("stage-approval provenance", () => {
  test("allows a delegated stage while a reserved stage is denied", () => {
    const { record } = grant();
    const implementation = proposeStageApproval({
      authority: record,
      approvalId: "appr-1",
      stage: "implementation",
      artifactPath: "src/lib/a.ts",
      artifactSha256: "hash",
      provenance: "controller_delegated",
    });
    expect(implementation.ok).toBe(true);
    if (!implementation.ok) return;
    expect(implementation.value.provenance).toBe("controller_delegated");

    const specification = proposeStageApproval({
      authority: record,
      approvalId: "appr-2",
      stage: "specification",
      artifactPath: ".vvoc/specs/x/spec.xml",
      artifactSha256: "hash",
      provenance: "controller_delegated",
    });
    expect(specification.ok).toBe(false);
    if (specification.ok) return;
    expect(specification.code).toBe("STAGE_RESERVED");

    const publication = proposeStageApproval({
      authority: record,
      approvalId: "appr-3",
      stage: "publication" as never,
      artifactPath: "package",
      artifactSha256: "hash",
      provenance: "controller_delegated",
    });
    expect(publication.ok).toBe(false);
  });

  test("denies approval from a revoked authority", () => {
    const { record } = grant();
    const revoked = revokeAdvanceAuthority({
      authority: record,
      revocationId: "revoke-1",
      reason: "Revoked.",
    });
    if (!revoked.ok) throw new Error("setup");
    const approval = proposeStageApproval({
      authority: { ...record, revocations: [revoked.value] },
      approvalId: "appr-1",
      stage: "implementation",
      artifactPath: "src/lib/a.ts",
      artifactSha256: "hash",
      provenance: "controller_delegated",
    });
    expect(approval.ok).toBe(false);
  });
});
