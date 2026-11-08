// FILE: src/runtime/auxiliary.test.ts
// VERSION: 3.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify settings-bound auxiliary title/generation behavior, family-rooted child creation, retained title content, recursion protection, and fail-closed unresolvable-settings refusal.
//   SCOPE: In-memory auxiliary session double assertions for title short-circuit, resolved model selection, retained message content, memoized children, and recursion guard; no native host.
//   DEPENDS: [bun:test, src/runtime/auxiliary.ts, src/runtime/session-settings.js, src/runtime/types.js, src/lib/vvoc-config.js]
//   LINKS: [M-NATIVE-RUNTIME, V-M-NATIVE-RUNTIME]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   FakeAuxiliarySession - In-memory AuxiliarySessionApi double.
//   makeView - Build a resolved family settings view fixture.
//   build - Wire the auxiliary service against the fake session and a view.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-SESSION-OWNED-SETTINGS T-002 - Rewired the suite onto the family settings view; qualification and snapshot variants are gone.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { createDefaultVvocConfig, type VvocConfig } from "../lib/vvoc-config.js";
import { createAuxiliaryService, primarySettingsSelection } from "./auxiliary.js";
import { SessionLineageError, type FamilySettingsView } from "./session-settings.js";
import type { AuxiliaryService, AuxiliarySessionApi, ModelSelection } from "./types.js";

class FakeAuxiliarySession implements AuxiliarySessionApi {
  readonly creates: Array<{
    parentID: string;
    locationDirectory: string;
    title: string;
    kind: "title" | "compaction" | "generate";
    role?: string;
    model: ModelSelection;
    agent?: string;
  }> = [];
  readonly switches: Array<{ sessionID: string; model: unknown }> = [];
  readonly generates: Array<{ sessionID: string; prompt: string }> = [];
  onGenerate: ((input: { sessionID: string; prompt: string }) => void) | undefined;

  async create(input: {
    parentID: string;
    locationDirectory: string;
    title: string;
    kind: "title" | "compaction" | "generate";
    role?: string;
    model: ModelSelection;
    agent?: string;
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

function makeView(
  familyId = "ses_root",
  roles: Record<string, string> = { default: "prov/m1" },
  roleModels: Record<string, { providerID: string; modelID: string }> = {
    default: { providerID: "prov", modelID: "m1" },
  },
): FamilySettingsView {
  return {
    familyId,
    locationDirectory: "/project",
    rootModel: { providerID: "prov", modelID: "m-native" },
    settings: {
      version: 1,
      roles,
      profile: "orchestrated",
      plugins: {},
    },
    vvoc: createDefaultVvocConfig() as VvocConfig,
    roleModels,
    source: "metadata",
    settingsId: "settings0",
  };
}

function build(
  session: FakeAuxiliarySession,
  view: FamilySettingsView | undefined,
): AuxiliaryService {
  return createAuxiliaryService({
    familyOf: async () => view?.familyId ?? "ses_unresolved",
    policy: async () => view,
    session,
    fallbackDirectory: "/runtime",
  });
}

describe("primarySettingsSelection", () => {
  test("prefers the default role, then the first role, then the root model", () => {
    expect(primarySettingsSelection(makeView())?.modelID).toBe("m1");
    const noDefault = makeView(
      "ses_root",
      { fast: "prov/m2" },
      {
        fast: { providerID: "prov", modelID: "m2" },
      },
    );
    expect(primarySettingsSelection(noDefault)?.modelID).toBe("m2");
    const empty = makeView("ses_root", {}, {});
    expect(primarySettingsSelection(empty)?.modelID).toBe("m-native");
  });
});

describe("createAuxiliaryService", () => {
  test("a host-supplied title result short-circuits generation", async () => {
    const session = new FakeAuxiliarySession();
    const service = build(session, makeView());
    expect(await service.title({ sessionID: "ses_root", result: "Host title" })).toBe("Host title");
    expect(session.creates).toHaveLength(0);
    expect(session.generates).toHaveLength(0);
  });

  test("unresolvable settings refuse auxiliary work without creating a session", async () => {
    const session = new FakeAuxiliarySession();
    const service = build(session, undefined);
    expect(await service.title({ sessionID: "ses_unresolved" })).toBeUndefined();
    await expect(
      service.generate({ sessionID: "ses_unresolved", kind: "generate", prompt: "x" }),
    ).rejects.toBeInstanceOf(SessionLineageError);
    expect(session.creates).toHaveLength(0);
  });

  test("bound title work creates a family-rooted child with the resolved role model and retains messages", async () => {
    const session = new FakeAuxiliarySession();
    const service = build(session, makeView());

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
        kind: "title",
        model: { providerID: "prov", modelID: "m1" },
      },
    ]);
    expect(session.switches).toEqual([
      { sessionID: "aux-1", model: { providerID: "prov", modelID: "m1" } },
    ]);
    // Retained title content is sent, never an empty prompt.
    expect(session.generates[0]?.prompt).toContain("fix the parser bug");
    expect(session.generates[0]?.prompt).toContain("on it");
  });

  test("a named role resolves its own selection, not the default", async () => {
    const session = new FakeAuxiliarySession();
    const view = makeView(
      "ses_root",
      { default: "prov/m1", fast: "prov/m-fast" },
      {
        default: { providerID: "prov", modelID: "m1" },
        fast: { providerID: "prov", modelID: "m-fast" },
      },
    );
    const service = build(session, view);
    expect(
      await service.generate({
        sessionID: "ses_root",
        kind: "generate",
        prompt: "x",
        role: "fast",
      }),
    ).toEqual({
      text: "text:aux-1",
    });
    expect(session.creates[0]?.model).toEqual({ providerID: "prov", modelID: "m-fast" });
  });

  test("reuses the child across kinds and guards re-entrant titles", async () => {
    const session = new FakeAuxiliarySession();
    const service = build(session, makeView());
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
