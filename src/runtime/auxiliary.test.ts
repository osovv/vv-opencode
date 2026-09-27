// FILE: src/runtime/auxiliary.test.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify snapshot-bound auxiliary title/generation behavior, verified-lineage child creation, retained title content, recursion protection, and fail-closed unbound refusal.
//   SCOPE: In-memory auxiliary session double assertions for title short-circuit, bound model selection, retained message content, memoized children, and recursion guard; no native host.
//   DEPENDS: [bun:test, src/runtime/auxiliary.ts, src/runtime/types.ts]
//   LINKS: [M-NATIVE-RUNTIME, V-M-NATIVE-RUNTIME]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   FakeAuxiliarySession - In-memory AuxiliarySessionApi double.
//   makeCapture - Build a bound family capture fixture.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-002 - Verified lineage children and retained title content coverage.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { createDefaultVvocConfig } from "../lib/vvoc-config.js";
import { createAuxiliaryService } from "./auxiliary.js";
import {
  SnapshotUnboundError,
  type AuxiliaryService,
  type AuxiliarySessionApi,
  type FamilyCapture,
} from "./types.js";

class FakeAuxiliarySession implements AuxiliarySessionApi {
  readonly creates: Array<{
    parentID: string;
    locationDirectory: string;
    title: string;
    model?: unknown;
  }> = [];
  readonly switches: Array<{ sessionID: string; model: unknown }> = [];
  readonly generates: Array<{ sessionID: string; prompt: string }> = [];
  onGenerate: ((input: { sessionID: string; prompt: string }) => void) | undefined;

  async create(input: {
    parentID: string;
    locationDirectory: string;
    title: string;
    model?: unknown;
  }) {
    this.creates.push(input);
    return { sessionID: `aux-${this.creates.length}` };
  }
  async switchModel(input: { sessionID: string; model: unknown }) {
    this.switches.push(input);
  }
  async generate(input: { sessionID: string; prompt: string }) {
    this.generates.push(input);
    this.onGenerate?.(input);
    return { text: `text:${input.sessionID}` };
  }
}

function makeCapture(familyId = "ses_root"): FamilyCapture {
  return {
    schemaVersion: 1,
    snapshotId: "snap",
    integrity: "integrity",
    familyId,
    capturedAt: 1,
    location: { directory: "/project", projectID: "proj", canonical: "/project" },
    roles: { default: "prov/m1" },
    roleModels: { default: { providerID: "prov", modelID: "m1" } },
    agents: [],
    variants: [
      { id: "snap.m1", providerID: "prov", modelID: "m1", body: { thinking: { type: "enabled" } } },
    ],
    modelSettings: [],
    vvoc: createDefaultVvocConfig(),
    intent: { mode: "implicit", source: "config" },
  };
}

function build(
  session: FakeAuxiliarySession,
  capture: FamilyCapture | undefined,
): AuxiliaryService {
  return createAuxiliaryService({
    familyOf: async () => capture?.familyId ?? "ses_unbound",
    policy: async () => capture,
    session,
  });
}

describe("createAuxiliaryService", () => {
  test("a host-supplied title result short-circuits generation", async () => {
    const session = new FakeAuxiliarySession();
    const service = build(session, makeCapture());
    expect(await service.title({ sessionID: "ses_root", result: "Host title" })).toBe("Host title");
    expect(session.creates).toHaveLength(0);
    expect(session.generates).toHaveLength(0);
  });

  test("an unbound family refuses auxiliary work without creating a session", async () => {
    const session = new FakeAuxiliarySession();
    const service = build(session, undefined);
    expect(await service.title({ sessionID: "ses_unbound" })).toBeUndefined();
    await expect(
      service.generate({ sessionID: "ses_unbound", kind: "generate", prompt: "x" }),
    ).rejects.toBeInstanceOf(SnapshotUnboundError);
    expect(session.creates).toHaveLength(0);
  });

  test("bound title work creates a lineage child, activates the qualified variant, and retains messages", async () => {
    const session = new FakeAuxiliarySession();
    const service = build(session, makeCapture());

    expect(
      await service.title({
        sessionID: "ses_root",
        messages: [
          { role: "user", text: "fix the parser bug" },
          { role: "assistant", text: "on it" },
        ],
      }),
    ).toBe("text:aux-1");

    expect(session.creates).toEqual([
      {
        parentID: "ses_root",
        locationDirectory: "/project",
        title: "vvoc title",
        model: { providerID: "prov", modelID: "m1", variant: "snap.m1" },
      },
    ]);
    expect(session.switches).toEqual([
      { sessionID: "aux-1", model: { providerID: "prov", modelID: "m1", variant: "snap.m1" } },
    ]);
    // Retained title content is sent, never an empty prompt.
    expect(session.generates[0]?.prompt).toContain("fix the parser bug");
    expect(session.generates[0]?.prompt).toContain("on it");
  });

  test("reuses the bound child across kinds and guards re-entrant titles", async () => {
    const session = new FakeAuxiliarySession();
    const service = build(session, makeCapture());
    let reentrant: string | undefined;
    session.onGenerate = () => {
      void service.title({ sessionID: "ses_root" }).then((value) => {
        reentrant = value;
      });
    };

    const generated = await service.generate({
      sessionID: "ses_root",
      kind: "generate",
      prompt: "x",
    });
    expect(generated).toEqual({ text: "text:aux-1" });
    expect(session.creates).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reentrant).toBeUndefined();
  });
});
