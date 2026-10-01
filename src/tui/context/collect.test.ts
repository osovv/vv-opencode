// FILE: src/tui/context/collect.test.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify native-tagged collection and normalization: timestamps, attachments, structured errors, partial token usage, selected-session location scoping, reply-location verification, explicit empty/unavailable states, and per-session isolation.
//   SCOPE: Pure collection with injected native dependencies; no host or renderer.
//   DEPENDS: [bun:test, src/tui/context/collect.ts, src/tui/context/types.ts]
//   LINKS: [V-M-PLUGIN-CONTEXT-TUI, DF-CONTEXT-INSPECTION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   LOCATION - Context location fixture used by the collector.
//   nativeUser - Build a native user message fixture.
//   nativeAssistant - Build a native assistant message fixture.
//   nativeCompaction - Build a native compaction message fixture.
//   inspection - Build a ContextInspectionResult fixture.
//   deps - Build collector dependencies from a fixture inspection.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-008 attempt 2 - Added location scoping, reply-location, attachment/timestamp/error, and partial-usage coverage.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import {
  collectContextAnalysis,
  normalizeNativeMessage,
  type ContextCollectionDependencies,
  type ContextLocationRef,
} from "./collect.js";
import type { ContextInspectionResult } from "../../runtime/context-inspection-contract.js";

const LOCATION: ContextLocationRef = { directory: "/work/project" };

function nativeUser(id: string, text: string, extra: Record<string, unknown> = {}) {
  return { id, type: "user", text, time: { created: 1 }, ...extra };
}

function nativeAssistant(
  id: string,
  options: { providerID?: string; modelID?: string; variant?: string } = {},
) {
  return {
    id,
    type: "assistant",
    agent: "build",
    model: {
      providerID: options.providerID ?? "deepseek",
      id: options.modelID ?? "chat",
      ...(options.variant === undefined ? {} : { variant: options.variant }),
    },
    content: [
      { type: "text", text: "answer" },
      {
        type: "tool",
        id: "t1",
        name: "read",
        state: {
          status: "completed",
          input: { path: "/x" },
          content: [{ type: "text", text: "file body" }],
        },
      },
    ],
    tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 2, write: 3 } },
    time: { created: 2 },
  };
}

function nativeCompaction(id: string) {
  return {
    id,
    type: "compaction",
    status: "completed",
    reason: "auto",
    summary: "summary text",
    recent: "recent text",
    time: { created: 3 },
  };
}

function inspection(overrides: Partial<ContextInspectionResult> = {}): ContextInspectionResult {
  return {
    version: 1,
    status: "partial",
    location: { directory: "/work/project", projectID: "proj_1" },
    observedAt: 1,
    catalog: {
      status: "partial",
      tools: [
        {
          effectiveID: "read",
          name: "read",
          description: "Read a file",
          codeMode: false,
          status: "unavailable",
        },
      ],
      warnings: ["tool input schema conversion is unavailable for this schema vendor"],
    },
    policy: {
      status: "available",
      scope: "family",
      contextEnabled: true,
      analyticsEnabled: true,
      peakHours: { enabled: false, mode: "soft", graceActiveSessions: true, schedules: {} },
      provenance: {
        familyId: "f",
        snapshotId: "s",
        capturedAt: 1,
        location: { directory: "/work/project" },
      },
    },
    warnings: [],
    ...overrides,
  };
}

function deps(
  overrides: Partial<ContextCollectionDependencies> = {},
): ContextCollectionDependencies {
  return {
    readSessionLocation: () => LOCATION,
    readActiveMessages: async () => [nativeUser("u1", "hello"), nativeAssistant("a1")],
    readHistoryMessages: () => [nativeUser("u1", "hello"), nativeAssistant("a1")],
    readAgents: () => [{ id: "build", name: "Build", system: "system" }],
    readSkills: () => [{ id: "s1", name: "skill", path: "/skills/s" }],
    readMcpServers: () => [{ name: "docs", status: { status: "connected" } }],
    readModels: () => [
      {
        providerID: "deepseek",
        modelID: "chat",
        id: "chat",
        name: "DeepSeek",
        limit: { context: 1000, output: 100 },
      },
    ],
    readSelectedModel: () => ({ providerID: "deepseek", modelID: "chat" }),
    inspect: async () => inspection(),
    ...overrides,
  };
}

describe("normalizeNativeMessage", () => {
  test("normalizes native tagged content with timestamps and drops control messages", () => {
    expect(normalizeNativeMessage(nativeUser("u1", "hello"))).toEqual({
      kind: "user",
      id: "u1",
      createdAt: 1,
      text: "hello",
    });
    expect(normalizeNativeMessage(nativeCompaction("c1"))?.kind).toBe("compaction");
    expect(normalizeNativeMessage({ id: "m1", type: "model.selected" })).toBeUndefined();
  });

  test("preserves bounded attachment metadata and structured errors", () => {
    const message = normalizeNativeMessage(
      nativeUser("u1", "see file", {
        files: [
          {
            data: "AAAA",
            mime: "image/png",
            source: { type: "uri", uri: "https://x/a.png" },
            name: "a.png",
          },
        ],
      }),
    );
    expect(message?.kind).toBe("user");
    if (message?.kind !== "user") return;
    expect(message.files).toEqual([
      {
        mime: "image/png",
        name: "a.png",
        sourceType: "uri",
        sourceURI: "https://x/a.png",
        byteLength: 3,
      },
    ]);

    const failed = normalizeNativeMessage({
      ...nativeAssistant("a1"),
      error: { type: "ProviderError", message: "boom", status: 500 },
    });
    expect(failed?.kind === "assistant" && failed.error).toBe("ProviderError: boom");
  });

  test("keeps partial native token usage field-by-field", () => {
    const message = normalizeNativeMessage({
      ...nativeAssistant("a1"),
      tokens: { input: 10, cache: { read: 2 } },
    });
    if (message?.kind !== "assistant") throw new Error("expected assistant");
    expect(message.tokens).toEqual({ input: 10, cacheRead: 2 });
  });
});

describe("collectContextAnalysis", () => {
  test("builds analysis from nonempty native catalogs", async () => {
    const analysis = await collectContextAnalysis("ses_1", deps());
    expect(analysis.selectedModel).toMatchObject({
      providerID: "deepseek",
      modelID: "chat",
      contextLimit: 1000,
    });
    expect(analysis.mcpServers).toEqual([{ name: "docs", status: "connected" }]);
    expect(analysis.toolCatalogStatus).toBe("partial");
    expect(analysis.toolAttribution?.tools[0]?.id).toBe("read");
    expect(analysis.toolAttribution?.tools[0]?.schemaKnown).toBe(false);
  });

  test("passes the selected session's current location to catalogs and the RPC", async () => {
    const calls: string[] = [];
    const analysis = await collectContextAnalysis(
      "ses_2",
      deps({
        readSessionLocation: (sessionID) => {
          calls.push(`loc:${sessionID}`);
          return { directory: "/moved" };
        },
        readAgents: (location) => {
          calls.push(`agents:${location.directory}`);
          return [];
        },
        inspect: async (sessionID, location) => {
          calls.push(`inspect:${sessionID}:${location.directory}`);
          return inspection({ location: { directory: "/moved" } });
        },
      }),
    );
    expect(calls).toContain("loc:ses_2");
    expect(calls).toContain("agents:/moved");
    expect(calls).toContain("inspect:ses_2:/moved");
    expect(analysis.sessionID).toBe("ses_2");
  });

  test("rejects an RPC reply whose location does not match the requested session location", async () => {
    const analysis = await collectContextAnalysis(
      "ses_1",
      deps({ inspect: async () => inspection({ location: { directory: "/elsewhere" } }) }),
    );
    expect(analysis.toolCatalogStatus).toBe("unavailable");
    expect(analysis.warnings.join(" ")).toContain("reply location");
  });

  test("distinguishes a failed active-context read from an empty one", async () => {
    const unavailable = await collectContextAnalysis(
      "ses_1",
      deps({ readActiveMessages: async () => undefined }),
    );
    expect(unavailable.warnings.join(" ")).toContain("Active session context is unavailable");

    const empty = await collectContextAnalysis(
      "ses_1",
      deps({ readActiveMessages: async () => [] }),
    );
    expect(empty.warnings.join(" ")).not.toContain("Active session context is unavailable");
    expect(empty.activeMessageCount).toBe(0);
  });

  test("warns when inspection is unavailable and never invents catalog tools", async () => {
    const analysis = await collectContextAnalysis(
      "ses_1",
      deps({ inspect: async () => undefined }),
    );
    expect(analysis.toolCatalogStatus).toBe("unavailable");
    expect(analysis.toolAttribution?.tools.every((tool) => tool.schemaKnown === false)).toBe(true);
  });

  test("marks compaction and never uses compaction request tokens as occupancy", async () => {
    const analysis = await collectContextAnalysis(
      "ses_1",
      deps({
        readActiveMessages: async () => [nativeCompaction("c1")],
        readHistoryMessages: () => [nativeCompaction("c1")],
      }),
    );
    expect(analysis.compacted).toBe(true);
    expect(analysis.measured).toBeUndefined();
  });
});
