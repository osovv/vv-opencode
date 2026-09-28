// FILE: src/plugins/tool-history-compaction.integration.test.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the native ToolHistoryCompactionPlugin contract: unconditional context-hook registration, per-bound-family capture gating, native message compaction, unknown/disabled no-op, and cleanup.
//   SCOPE: Native-boundary tests with an injected shared-runtime seam, a recording native session hook, native @opencode/ai messages, and lifecycle release.
//   DEPENDS: [bun:test, @opencode/ai, src/lib/vvoc-config.ts, src/plugins/tool-history-compaction/index.ts, src/plugins/tool-history-compaction/prune.ts]
//   LINKS: [M-PLUGIN-TOOL-HISTORY-COMPACTION, V-M-PLUGIN-TOOL-HISTORY-COMPACTION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   captureFor - Builds a fake family capture from a vvoc config.
//   createHarness - Builds a native plugin harness with an injected runtime seam.
//   createToolMessage - Builds a native message carrying one textual tool result.
//   outputOf - Reads a native tool result text value back out.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-006 - Rewrote the V1 experimental transform integration tests over native session context hooks and captured policy.]
// END_CHANGE_SUMMARY

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Message, ToolCallPart, ToolResultPart, type ContentPart } from "@opencode/ai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultVvocConfig, type VvocConfig } from "../lib/vvoc-config.js";
import { createToolHistoryCompactionPlugin } from "./tool-history-compaction/index.js";
import { PRUNE_MARKER } from "./tool-history-compaction/prune.js";

const previousDataHome = process.env.XDG_DATA_HOME;
let scratchDataHome = "";

beforeAll(() => {
  scratchDataHome = mkdtempSync(join(tmpdir(), "vvoc-thc-it-data-"));
  process.env.XDG_DATA_HOME = scratchDataHome;
});

afterAll(() => {
  if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousDataHome;
  if (scratchDataHome) rmSync(scratchDataHome, { recursive: true, force: true });
});

type NativeContextEvent = {
  sessionID: string;
  agent?: string;
  system?: unknown[];
  messages: Message[];
};
type SessionHandler = (event: NativeContextEvent) => Promise<void> | void;

function configFor(entry: unknown): VvocConfig {
  const config = createDefaultVvocConfig();
  config.plugins = { ...config.plugins, "tool-history-compaction": entry as never };
  return config;
}

async function createHarness(
  config: VvocConfig,
  options: {
    policy?: "enabled" | "unknown";
    resolve?: (sessionID: string) => { familyId: string; vvoc: VvocConfig } | undefined;
    clientThrows?: boolean;
    /** Stored session-context messages returned by the authenticated client. */
    sessionContextMessages?: unknown[];
  } = {},
) {
  const policy = options.policy ?? "enabled";
  const hooks = new Map<string, SessionHandler>();
  let released = false;
  const capture = { familyId: "fam-1", vvoc: config };
  const fakeRuntime = {
    snapshots: {
      configFor: async (sessionID: string) => {
        if (options.resolve !== undefined) return options.resolve(sessionID);
        return policy === "unknown" ? undefined : capture;
      },
      accept: async () => ({ status: "unbound" }),
    },
    client: async () => {
      if (options.clientThrows) throw new Error("client unavailable");
      return { session: { context: async () => options.sessionContextMessages ?? [] } };
    },
    release: async () => {
      released = true;
    },
  };
  const fakeContext = {
    location: {
      directory: "/tmp/project",
      project: { id: "proj", directory: "/tmp/project", canonical: "/tmp/project" },
    },
    session: {
      hook: async (name: string, callback: SessionHandler) => {
        hooks.set(name, callback);
        return { dispose: async () => undefined };
      },
    },
  };
  const plugin = createToolHistoryCompactionPlugin({
    acquireRuntime: async () => fakeRuntime as never,
    log: () => undefined,
  });
  const cleanup = (await plugin.setup(fakeContext as never)) as () => Promise<void>;
  const runContext = async (messages: Message[], sessionID = "s1") => {
    const handler = hooks.get("context");
    if (handler === undefined) throw new Error("no context hook registered");
    const event: NativeContextEvent = { sessionID, agent: "build", messages };
    await handler(event);
    return event;
  };
  return { hooks, runContext, isReleased: () => released, cleanup };
}

let seq = 0;
function createToolMessage(
  tool: string,
  output: string,
  input: Record<string, unknown> = {},
  id = `m${seq}`,
): Message {
  seq += 1;
  const callId = `call-${seq}`;
  const content: ContentPart[] = [];
  // The native read tool needs its call input to recover the covered file.
  if (tool === "read") content.push(ToolCallPart.make({ id: callId, name: tool, input }));
  content.push(ToolResultPart.make({ id: callId, name: tool, result: output, resultType: "text" }));
  return Message.make({ id, role: "assistant", content });
}

function outputOf(message: Message): unknown {
  for (const part of message.content) {
    if (part.type === "tool-result") return (part.result as { value?: unknown }).value;
  }
  return undefined;
}

function inputOf(message: Message): unknown {
  for (const part of message.content) {
    if (part.type === "tool-call") return part.input;
  }
  return undefined;
}

const BIG = "y".repeat(10_000);
const LONG_READ = "1: alpha\n2: beta " + "z".repeat(3000);

describe("ToolHistoryCompactionPlugin", () => {
  test("registers the context hook unconditionally, even when the capture is disabled", async () => {
    const enabled = await createHarness(configFor({ enabled: true }));
    expect(enabled.hooks.has("context")).toBe(true);
    const disabled = await createHarness(configFor(false));
    expect(disabled.hooks.has("context")).toBe(true);
  });

  test("compacts only the in-memory native messages for an enabled capture", async () => {
    const harness = await createHarness(
      configFor({
        enabled: true,
        protectLastCalls: 0,
        protectRecentMessages: 0,
        savePrunedOutput: false,
      }),
    );
    const oldRead = createToolMessage("read", LONG_READ, { path: "/repo/lib.ts" }, "m-old");
    const oldBash = createToolMessage("bash", BIG, {}, "m-mid");
    const recent = createToolMessage("bash", "recent", {}, "m-recent");

    const inputBefore = JSON.stringify(inputOf(oldBash));
    const idsBefore = oldBash.content.map((part) =>
      part.type === "tool-call" || part.type === "tool-result" ? part.id : undefined,
    );
    await harness.runContext([oldRead, oldBash, recent]);

    expect(outputOf(recent)).toBe("recent");
    expect(outputOf(oldBash)).toContain(PRUNE_MARKER);
    expect(outputOf(oldRead)).toBe("[Read /repo/lib.ts, lines 1-2]");
    expect(JSON.stringify(inputOf(oldBash))).toBe(inputBefore);
    expect(
      oldBash.content.map((part) =>
        part.type === "tool-call" || part.type === "tool-result" ? part.id : undefined,
      ),
    ).toEqual(idsBefore);
  });

  test("custom captured config from the family drives behavior (readSlim off)", async () => {
    const harness = await createHarness(
      configFor({
        enabled: true,
        readSlim: false,
        protectLastCalls: 0,
        protectRecentMessages: 0,
        savePrunedOutput: false,
      }),
    );
    const oldRead = createToolMessage(
      "read",
      "1: alpha\n2: beta " + "z".repeat(6000),
      { path: "/repo/lib.ts" },
      "m-old",
    );
    const recent = createToolMessage("bash", "recent", {}, "m-recent");
    await harness.runContext([oldRead, recent]);

    const output = outputOf(oldRead) as string;
    expect(output.startsWith("[Read ")).toBe(false);
    expect(output).toContain(PRUNE_MARKER);
  });

  test("a disabled capture compacts nothing", async () => {
    const harness = await createHarness(configFor(false));
    const message = createToolMessage("bash", BIG, {}, "m-old");
    await harness.runContext([message]);
    expect(outputOf(message)).toBe(BIG);
  });

  test("an unknown family policy compacts nothing (no invented policy)", async () => {
    const harness = await createHarness(configFor({ enabled: true }), { policy: "unknown" });
    const message = createToolMessage("bash", BIG, {}, "m-old");
    await harness.runContext([message]);
    expect(outputOf(message)).toBe(BIG);
  });

  test("mixed captured families compact only the enabled family", async () => {
    const enabled = configFor({
      enabled: true,
      protectLastCalls: 0,
      protectRecentMessages: 0,
      savePrunedOutput: false,
    });
    const disabled = configFor(false);
    const harness = await createHarness(enabled, {
      resolve: (sessionID) =>
        sessionID === "s-enabled"
          ? { familyId: "fam-a", vvoc: enabled }
          : { familyId: "fam-b", vvoc: disabled },
    });
    const enabledMessage = createToolMessage("bash", BIG, {}, "m-a");
    const disabledMessage = createToolMessage("bash", BIG, {}, "m-b");
    // A newer companion message keeps the huge result outside the always-protected newest slot.
    await harness.runContext(
      [enabledMessage, createToolMessage("bash", "recent-a", {}, "m-ra")],
      "s-enabled",
    );
    await harness.runContext(
      [disabledMessage, createToolMessage("bash", "recent-b", {}, "m-rb")],
      "s-disabled",
    );

    expect(outputOf(enabledMessage)).toContain(PRUNE_MARKER);
    expect(outputOf(disabledMessage)).toBe(BIG);
  });

  test("a message-time acquisition failure still compacts using array-position ordering", async () => {
    const harness = await createHarness(
      configFor({
        enabled: true,
        protectLastCalls: 0,
        protectRecentMessages: 0,
        savePrunedOutput: false,
      }),
      { clientThrows: true },
    );
    const old = createToolMessage("bash", BIG, {}, "m-old");
    const recent = createToolMessage("bash", "recent", {}, "m-recent");
    await harness.runContext([old, recent]);
    expect(outputOf(old)).toContain(PRUNE_MARKER);
    expect(outputOf(recent)).toBe("recent");
  });

  test("authenticated stored-message recency correlates the window by source id, not array position", async () => {
    // Array order puts the OLDER source last; only real stored times can protect
    // the newest logical source. This exercises the default fetchMessageTimes path
    // with an encoded numeric session.context envelope.
    const harness = await createHarness(
      configFor({
        enabled: true,
        protectLastCalls: 0,
        protectRecentMessages: 1,
        savePrunedOutput: false,
      }),
      {
        sessionContextMessages: [
          { id: "m-new", time: { created: 9000 } },
          { id: "m-old", time: { created: 1000 } },
        ],
      },
    );
    const newer = createToolMessage("bash", BIG, {}, "m-new");
    const older = createToolMessage("bash", BIG, {}, "m-old");
    await harness.runContext([newer, older]);

    expect(outputOf(newer)).toBe(BIG);
    expect(outputOf(older)).toContain(PRUNE_MARKER);
  });

  test("cleanup disposes the hook and releases the shared runtime", async () => {
    const harness = await createHarness(configFor({ enabled: true }));
    expect(harness.isReleased()).toBe(false);
    await harness.cleanup();
    expect(harness.isReleased()).toBe(true);
  });
});
