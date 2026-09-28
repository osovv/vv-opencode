// FILE: src/runtime/context-inspection.test.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the v2 context-inspection contract projections and the read-only server handler: strict versioned decoding, value-free errors, meaningful-capture validation, current-location session checks, bounded schedules, Schema-owned Effect conversion, and canary-free payloads.
//   SCOPE: Pure projection/decoder tests plus fake structural contexts; no live host, no RPC transport.
//   DEPENDS: [bun:test, @opencode/schema/token-usage, src/runtime/context-inspection.ts, src/runtime/context-inspection-contract.ts]
//   LINKS: [V-M-NATIVE-RUNTIME, V-M-PLUGIN-CONTEXT-TUI, DF-CONTEXT-INSPECTION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   LOCALS: makeContext, makeRuntime, toolRow, baseCapture, canary
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-008 attempt 2 - Added strict-decoder, value-free-error canary, location-match, meaningful-capture, schedule-bound, and Effect-conversion coverage.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { TokenUsage } from "@opencode/schema/token-usage";
import {
  CONTEXT_INSPECTION_RPC_ID,
  CONTEXT_INSPECTION_VERSION,
  contextInspectionRpc,
  inspectionErrorCode,
  isContextInspectionResult,
  projectContextInspectionPolicy,
  projectContextInspectionTool,
} from "./context-inspection-contract.js";
import {
  createContextInspectionHandler,
  loadSchemaOwnedVendorConverter,
  type ContextInspectionServerContext,
  type ContextInspectionServerRuntime,
} from "./context-inspection.js";
import type { RuntimeLocation } from "./types.js";

const CANARY = "CANARY_SECRET_do_not_leak_1234";

const LOCATION = {
  directory: "/work/project",
  project: { id: "proj_1", directory: "/work/project", canonical: "/work/project" },
} as unknown as RuntimeLocation;

type ToolRow = Record<string, unknown>;

function toolRow(overrides: ToolRow = {}): ToolRow {
  return {
    id: "read",
    name: "read",
    description: "Read a file",
    input: { type: "object", properties: { path: { type: "string" } } },
    options: { codemode: false },
    ...overrides,
  };
}

function makeContext(options: {
  toolList?: () => Promise<readonly unknown[]>;
  session?: (input: { sessionID: string }) => Promise<unknown>;
}): ContextInspectionServerContext {
  return {
    location: LOCATION,
    rpc: { register: async () => ({ dispose: () => undefined }) },
    tool: { list: options.toolList ?? (async () => []) },
    session: {
      get:
        options.session ??
        (async () => ({ projectID: "proj_1", location: { directory: "/work/project" } })),
    },
  };
}

function makeRuntime(options: {
  policy?: (sessionID: string) => Promise<unknown>;
  currentConfig?: () => unknown;
}): ContextInspectionServerRuntime {
  return {
    policy: options.policy ?? (async () => undefined),
    currentConfig: options.currentConfig ?? (() => undefined),
    now: () => 1_700_000_000_000,
  };
}

const SAFE_PLUGINS = {
  context: true,
  analytics: true,
  "peak-hours": {
    enabled: true,
    mode: "hard",
    graceActiveSessions: false,
    schedules: {
      deepseek: {
        mode: "soft",
        windows: [{ start: "01:00", end: "04:00", tz: "UTC", days: [1, 2] }],
      },
    },
  },
};

function baseCapture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    familyId: "fam_1",
    snapshotId: "snap_1",
    integrity: "sha256:deadbeef",
    capturedAt: 42,
    location: { directory: "/moved/worktree", projectID: "proj_1", workspaceID: "ws_1" },
    vvoc: {
      plugins: SAFE_PLUGINS,
      roles: { default: "secret-role" },
      secretsRedaction: { secret: "top-secret" },
    },
    modelSettings: [{ providerID: "p", modelID: "m", body: { secret: "leak" } }],
    rawIntent: { model: "p/m" },
    ...overrides,
  };
}

describe("context inspection contract", () => {
  test("exposes a versioned RPC identity and validates its own definition", () => {
    expect(CONTEXT_INSPECTION_RPC_ID).toBe("vvoc.context-inspection.v1");
    expect(CONTEXT_INSPECTION_VERSION).toBe(1);
    expect(Object.keys(contextInspectionRpc.methods)).toEqual(["inspect"]);
    expect(contextInspectionRpc.events).toEqual({});
  });

  test("projects only the allowlisted policy fields and drops sensitive capture values", () => {
    const projected = projectContextInspectionPolicy({ plugins: SAFE_PLUGINS });
    expect(projected.contextEnabled).toBe(true);
    expect(projected.analyticsEnabled).toBe(true);
    expect(projected.complete).toBe(true);
    expect(projected.peakHours).toEqual({
      enabled: true,
      mode: "hard",
      graceActiveSessions: false,
      schedules: {
        deepseek: {
          mode: "soft",
          windows: [{ start: "01:00", end: "04:00", tz: "UTC", days: [1, 2] }],
        },
      },
    });
    expect(JSON.stringify(projected)).not.toContain("apiKey");
  });

  test("preserves per-provider schedule mode and does not silently truncate windows", () => {
    const windows = Array.from({ length: 70 }, (_, index) => ({
      start: `0${index % 10}:00`,
      end: "23:00",
      extra: "drop-me",
    }));
    const projected = projectContextInspectionPolicy({
      plugins: { "peak-hours": { enabled: true, schedules: { big: { mode: "hard", windows } } } },
    });
    expect(projected.complete).toBe(false);
    expect(projected.warnings.length).toBeGreaterThan(0);
  });

  test("defaults absent plugin toggles to enabled and honors explicit disable", () => {
    expect(projectContextInspectionPolicy(undefined).contextEnabled).toBe(true);
    expect(projectContextInspectionPolicy({ plugins: { context: false } }).contextEnabled).toBe(
      false,
    );
  });

  test("projects a plain JSON Schema tool row without inventing fields", () => {
    const projected = projectContextInspectionTool(
      toolRow({ options: { namespace: "vvoc", codemode: true } }),
    );
    expect(projected?.tool).toEqual({
      effectiveID: "read",
      name: "read",
      description: "Read a file",
      namespace: "vvoc",
      codeMode: true,
      inputJSONSchema: { type: "object", properties: { path: { type: "string" } } },
      status: "registered",
    });
  });

  test("refuses a Standard Schema vendor without a converter instead of treating it as JSON Schema", () => {
    const standard = {
      "~standard": {
        version: 1,
        vendor: "effect-ish",
        validate: (value: unknown) => ({ value }),
      },
    };
    const projected = projectContextInspectionTool(toolRow({ input: standard }));
    expect(projected?.tool.status).toBe("unavailable");
    expect(projected?.tool.inputJSONSchema).toBeUndefined();
  });

  test("uses a Standard JSON Schema converter when the vendor provides one", () => {
    const standard = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value: unknown) => ({ value }),
        jsonSchema: {
          input: () => ({ type: "object", properties: { q: { type: "string" } } }),
          output: () => ({}),
        },
      },
    };
    const projected = projectContextInspectionTool(toolRow({ input: standard }));
    expect(projected?.tool.status).toBe("registered");
    expect(projected?.tool.inputJSONSchema).toEqual({
      type: "object",
      properties: { q: { type: "string" } },
    });
  });

  test("converts a known Effect Schema through the injected Schema-owned converter", async () => {
    const convert = await loadSchemaOwnedVendorConverter();
    expect(convert).toBeDefined();
    const converted = convert!(TokenUsage.Info);
    expect(converted).toBeDefined();
    const projected = projectContextInspectionTool(toolRow({ input: TokenUsage.Info }), convert);
    expect(projected?.tool.status).toBe("registered");
    expect(projected?.tool.inputJSONSchema).toBeDefined();
  });

  test("refuses an oversized schema instead of truncating it into invalid JSON", () => {
    const huge = {
      type: "object",
      properties: { blob: { type: "string", description: "x".repeat(40_000) } },
    };
    const projected = projectContextInspectionTool(toolRow({ input: huge }));
    expect(projected?.tool.status).toBe("unavailable");
  });

  test("maps inspection stages to stable value-free error codes", () => {
    expect(inspectionErrorCode("catalog")).toBe("tool_catalog_unavailable");
    expect(inspectionErrorCode("session-location")).toBe("session_location_mismatch");
    expect(inspectionErrorCode("preview")).toBe("current_config_unavailable");
  });
});

describe("strict result decoder", () => {
  function validResult(): Record<string, unknown> {
    return {
      version: 1,
      status: "partial",
      location: { directory: "/work/project", projectID: "proj_1" },
      observedAt: 1,
      policy: { status: "unavailable", scope: "family", error: "policy_capture_missing" },
      warnings: [],
    };
  }

  test("accepts a well-formed versioned result", () => {
    expect(isContextInspectionResult(validResult())).toBe(true);
  });

  test("rejects a missing version, wrong types, and spoofed policy combinations", () => {
    const { version, ...withoutVersion } = validResult();
    void version;
    expect(isContextInspectionResult(withoutVersion)).toBe(false);

    expect(isContextInspectionResult({ ...validResult(), status: "maybe" })).toBe(false);
    expect(
      isContextInspectionResult({
        ...validResult(),
        policy: {
          status: "available",
          scope: "family",
          contextEnabled: true,
          analyticsEnabled: true,
          peakHours: {},
        },
      }),
    ).toBe(false);
    expect(
      isContextInspectionResult({
        ...validResult(),
        policy: {
          status: "preview",
          scope: "current-runtime",
          contextEnabled: true,
          analyticsEnabled: true,
          peakHours: { enabled: true, mode: "soft", graceActiveSessions: true, schedules: {} },
          provenance: {
            familyId: "f",
            snapshotId: "s",
            capturedAt: 1,
            location: { directory: "/x" },
          },
        },
      }),
    ).toBe(false);
  });
});

describe("context inspection RPC registration ownership", () => {
  test("stacked registrations are last-owner-wins and disposal removes only the owned registration", async () => {
    // Model the native core/rpc.ts registration stack: later registrations for
    // one id win, and disposing one removes only that entry.
    type Handler = (input: unknown) => Promise<unknown>;
    const stack: Array<{ id: string; handler: Handler; disposed: boolean }> = [];
    const registrar = {
      async register(definition: { id: string }, handlers: Record<string, Handler>) {
        const entry = { id: definition.id, handler: handlers.inspect!, disposed: false };
        stack.push(entry);
        return {
          dispose() {
            entry.disposed = true;
            const index = stack.indexOf(entry);
            if (index >= 0) stack.splice(index, 1);
          },
        };
      },
    };
    const { registerContextInspectionRpc } = await import("./context-inspection.js");
    const top = await registerContextInspectionRpc(
      { ...makeContext({}), rpc: registrar as never },
      makeRuntime({ currentConfig: () => ({ vvoc: { plugins: SAFE_PLUGINS } }) }),
    );
    const bottom = await registerContextInspectionRpc(
      { ...makeContext({}), rpc: registrar as never },
      makeRuntime({ currentConfig: () => ({ vvoc: { plugins: SAFE_PLUGINS } }) }),
    );
    expect(stack).toHaveLength(2);
    const active = stack.at(-1)!;
    await expect(active.handler({})).resolves.toMatchObject({ version: 1 });
    await top.dispose();
    expect(stack).toHaveLength(1);
    await expect(stack[0]!.handler({})).resolves.toMatchObject({ version: 1 });
    await bottom.dispose();
    expect(stack).toHaveLength(0);
  });
});

describe("context inspection handler", () => {
  test("returns a complete catalog and preview policy when no session is supplied", async () => {
    const handler = createContextInspectionHandler(
      makeContext({ toolList: async () => [toolRow(), toolRow({ id: "glob", name: "glob" })] }),
      makeRuntime({ currentConfig: () => ({ vvoc: { plugins: SAFE_PLUGINS } }) }),
    );
    const result = await handler({});
    expect(result.version).toBe(1);
    expect(result.status).toBe("complete");
    expect(result.catalog?.tools.map((tool) => tool.effectiveID)).toEqual(["read", "glob"]);
    expect(result.policy?.status).toBe("preview");
    expect(isContextInspectionResult(result)).toBe(true);
  });

  test("marks the catalog unavailable when tool.list fails and never echoes the raw error", async () => {
    const handler = createContextInspectionHandler(
      makeContext({
        toolList: async () => {
          throw new Error(CANARY);
        },
      }),
      makeRuntime({ currentConfig: () => ({ vvoc: { plugins: SAFE_PLUGINS } }) }),
    );
    const result = await handler({});
    expect(result.catalog?.status).toBe("unavailable");
    expect(result.status).toBe("partial");
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(result.warnings.join(" ")).toContain("tool_catalog_unavailable");
  });

  test("returns the captured family policy with provenance and no raw capture fields", async () => {
    const handler = createContextInspectionHandler(
      makeContext({ toolList: async () => [] }),
      makeRuntime({ policy: async () => baseCapture() }),
    );
    const result = await handler({ sessionID: "ses_1" });
    expect(result.policy).toMatchObject({
      status: "available",
      scope: "family",
      contextEnabled: true,
      provenance: { familyId: "fam_1", snapshotId: "snap_1", capturedAt: 42 },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("top-secret");
    expect(serialized).not.toContain("secret-role");
    expect(serialized).not.toContain("leak");
  });

  test("treats an arbitrary capture object as invalid, never as enabled defaults", async () => {
    const handler = createContextInspectionHandler(
      makeContext({}),
      makeRuntime({ policy: async () => ({}) }),
    );
    const result = await handler({ sessionID: "ses_1" });
    expect(result.policy).toEqual({
      status: "unavailable",
      scope: "family",
      error: "policy_capture_invalid",
    });
  });

  test("reports an unbound session as unavailable instead of falling back to current config", async () => {
    const handler = createContextInspectionHandler(
      makeContext({}),
      makeRuntime({
        policy: async () => undefined,
        currentConfig: () => ({ vvoc: { plugins: SAFE_PLUGINS } }),
      }),
    );
    const result = await handler({ sessionID: "ses_unbound" });
    expect(result.policy).toEqual({
      status: "unavailable",
      scope: "family",
      error: "policy_capture_missing",
    });
  });

  test("rejects a session that does not belong to the serving project", async () => {
    const handler = createContextInspectionHandler(
      makeContext({
        session: async () => ({ projectID: "other", location: { directory: "/work/project" } }),
      }),
      makeRuntime({ policy: async () => baseCapture() }),
    );
    const result = await handler({ sessionID: "ses_foreign" });
    expect(result.policy).toEqual({
      status: "unavailable",
      scope: "family",
      error: "session_location_mismatch",
    });
  });

  test("rejects a same-project session whose current directory differs from the serving location", async () => {
    const handler = createContextInspectionHandler(
      makeContext({
        session: async () => ({ projectID: "proj_1", location: { directory: "/other/dir" } }),
      }),
      makeRuntime({ policy: async () => baseCapture() }),
    );
    const result = await handler({ sessionID: "ses_moved" });
    expect(result.policy).toEqual({
      status: "unavailable",
      scope: "family",
      error: "session_location_mismatch",
    });
  });

  test("uses a value-free code when the session lookup throws", async () => {
    const handler = createContextInspectionHandler(
      makeContext({
        session: async () => {
          throw new Error(CANARY);
        },
      }),
      makeRuntime({}),
    );
    const result = await handler({ sessionID: "ses_missing" });
    expect(result.policy).toEqual({
      status: "unavailable",
      scope: "family",
      error: "session_lookup_failed",
    });
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  test("uses a value-free code when the policy lookup throws", async () => {
    const handler = createContextInspectionHandler(
      makeContext({}),
      makeRuntime({
        policy: async () => {
          throw new Error(CANARY);
        },
      }),
    );
    const result = await handler({ sessionID: "ses_1" });
    expect(result.policy).toEqual({
      status: "unavailable",
      scope: "family",
      error: "policy_lookup_failed",
    });
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  test("rejects an undefined current config instead of defaulting to all-enabled", async () => {
    const handler = createContextInspectionHandler(
      makeContext({}),
      makeRuntime({ currentConfig: () => undefined }),
    );
    const result = await handler({});
    expect(result.policy).toEqual({
      status: "unavailable",
      scope: "current-runtime",
      error: "current_config_unavailable",
    });
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  test("never leaks a current-config canary into the preview payload", async () => {
    const handler = createContextInspectionHandler(
      makeContext({}),
      makeRuntime({
        currentConfig: () => ({
          vvoc: { plugins: SAFE_PLUGINS, secretsRedaction: { secret: CANARY } },
        }),
      }),
    );
    const result = await handler({});
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  test("omits the catalog when includeCatalog is false", async () => {
    const handler = createContextInspectionHandler(
      makeContext({ toolList: async () => [toolRow()] }),
      makeRuntime({ currentConfig: () => ({ vvoc: { plugins: SAFE_PLUGINS } }) }),
    );
    const result = await handler({ includeCatalog: false });
    expect(result.catalog).toBeUndefined();
  });
});
