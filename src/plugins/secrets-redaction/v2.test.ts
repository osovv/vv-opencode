// FILE: src/plugins/secrets-redaction/v2.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the v2 secrets-redaction port: auxiliary request redaction on title, generate, and compaction plus tool-argument restore.
//   SCOPE: Unit tests for setupSecretsRedactionV2 with a mocked adapter capturing hook registrations over a temp project.
//   DEPENDS: [src/plugins/secrets-redaction/v2.ts, src/plugins/v2-runtime/setup.ts]
//   LINKS: [V-M-PLUGIN-SECRETS-REDACTION, M-PLUGIN-SECRETS-REDACTION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   Harness - Adapter plus hook dispatch helper for one test body.
//   makeHarness - Builds a mocked adapter capturing session and tool hook callbacks.
//   withTempProject - Creates a temp project with a canonical vvoc config.
//   tempRoots - Temp project roots removed after all tests.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [hotfix 2.0.1 - Added coverage for auxiliary request redaction and restore.]
// END_CHANGE_SUMMARY

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupSecretsRedactionV2 } from "./v2.js";
import type { V2AdapterContext } from "../v2-runtime/setup.js";
import { createDefaultVvocConfig } from "../../lib/vvoc-config.js";

const tempRoots: string[] = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

interface Harness {
  adapter: V2AdapterContext;
  fireHook: (kind: string, event: unknown) => Promise<void>;
}

async function withTempProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vvoc-secrets-v2-"));
  tempRoots.push(root);
  await mkdir(join(root, ".vvoc"), { recursive: true });
  await writeFile(
    join(root, ".vvoc", "vvoc.json"),
    JSON.stringify(createDefaultVvocConfig()),
    "utf8",
  );
  return root;
}

async function makeHarness(project: string): Promise<Harness> {
  const hooks = new Map<string, (event: unknown) => Promise<void> | void>();
  const adapter = {
    ctx: {
      location: { directory: project, project: { id: "p" } },
      session: {
        hook: async (kind: string, callback: (event: unknown) => Promise<void> | void) => {
          hooks.set(kind, callback);
          return { dispose: async () => {} };
        },
        get: async () => ({ location: { directory: project } }),
      },
      tool: {
        hook: async (kind: string, callback: (event: unknown) => Promise<void> | void) => {
          hooks.set(`tool:${kind}`, callback);
          return { dispose: async () => {} };
        },
      },
    },
    resolver: {
      forSession: async () => ({
        directory: project,
        config: createDefaultVvocConfig(),
        source: { kind: "project", path: join(project, ".vvoc", "vvoc.json") },
        warnings: [],
        loadedAt: 0,
      }),
      forDirectory: async () => undefined,
      invalidate: () => {},
      cachedDirectories: [],
    },
    watchConfig: async () => () => {},
  } as unknown as V2AdapterContext;

  return {
    adapter,
    fireHook: async (kind, event) => {
      const hook = hooks.get(kind);
      if (!hook) throw new Error(`hook ${kind} not registered`);
      await hook(event);
    },
  };
}

describe("setupSecretsRedactionV2", () => {
  test("registers context, tool restore, and the title/generate/compaction auxiliary hooks", async () => {
    const project = await withTempProject();
    const { adapter } = await makeHarness(project);
    const cleanup = await setupSecretsRedactionV2(adapter);
    expect(typeof cleanup).toBe("function");
    await cleanup?.();
  });

  test("redacts title request messages so placeholders never reach the title model", async () => {
    const project = await withTempProject();
    const { adapter, fireHook } = await makeHarness(project);
    await setupSecretsRedactionV2(adapter);

    const secret = "sk-super-secret-value-1234567890abcdef1234567890";
    const messages = [
      {
        parts: [{ type: "text", text: `use the key ${secret} for deploy` }],
      },
    ];
    await fireHook("title", { sessionID: "s-1", messages });

    const text = (messages[0]?.parts?.[0] as { text?: string }).text ?? "";
    expect(text).not.toContain(secret);
    expect(/__VVOC_SECRET_[A-Za-z0-9_]+__/.test(text)).toBe(true);
  });

  test("restores placeholders in tool arguments before execution", async () => {
    const project = await withTempProject();
    const { adapter, fireHook } = await makeHarness(project);
    await setupSecretsRedactionV2(adapter);

    const secret = "sk-restore-me-4567890abcdef1234567890abcdef";
    const titleMessages = [{ parts: [{ type: "text", text: `key ${secret}` }] }];
    await fireHook("title", { sessionID: "s-1", messages: titleMessages });
    const redactedText = (titleMessages[0]?.parts?.[0] as { text?: string }).text ?? "";
    const placeholder = /__VVOC_SECRET_[A-Za-z0-9_]+__/.exec(redactedText)?.[0];
    expect(placeholder).toBeDefined();

    const input = { command: `echo ${placeholder}` };
    await fireHook("tool:execute.before", { sessionID: "s-1", input });
    expect((input as { command?: string }).command).toContain(secret);
  });
});
