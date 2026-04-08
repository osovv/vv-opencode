// FILE: src/plugins/secrets-redaction/index.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Behavioral tests for the SecretsRedactionPlugin hook pipeline.
//   SCOPE: chat message redaction, assistant state redaction, text completion restore, and tool arg restore.
//   DEPENDS: bun:test, node:fs/promises, node:os, node:path, index
//   LINKS: knowledge-graph://plugins/secrets-redaction
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SecretsRedactionPlugin hook tests - Verify redaction and restore behavior across the actual plugin hooks.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Added plugin-level hook coverage for redaction before LLM requests and restore before responses/tools.]
// END_CHANGE_SUMMARY

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretsRedactionPlugin } from "./index.js";

const EMAIL = "qa-redaction-check-884271@example.invalid";
const PLACEHOLDER_PATTERN = /__VVOC_SECRET_EMAIL_[0-9a-f]{12}__/;

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function createPlugin() {
  const directory = await mkdtemp(join(tmpdir(), "vvoc-secrets-redaction-"));
  tempDirs.push(directory);

  await writeFile(
    join(directory, "secrets-redaction.config.json"),
    JSON.stringify(
      {
        enabled: true,
        secret: "test-secret-for-redaction",
        ttlMs: 0,
        patterns: {
          builtin: ["email"],
          keywords: [],
          regex: [],
          exclude: [],
        },
      },
      null,
      2,
    ),
  );

  return SecretsRedactionPlugin({
    client: {
      app: {
        log: async () => {},
      },
    } as never,
    project: {} as never,
    directory,
    worktree: directory,
    serverUrl: new URL("http://localhost"),
    $: {} as never,
  });
}

describe("SecretsRedactionPlugin", () => {
  test("redacts user text and reasoning parts before the LLM request", async () => {
    const plugin = await createPlugin();
    const output = {
      messages: [
        {
          info: { role: "user" },
          parts: [
            { type: "text", text: `Primary secret: ${EMAIL}` },
            { type: "reasoning", text: `Reasoning secret: ${EMAIL}` },
          ],
        },
      ],
    };

    await plugin["experimental.chat.messages.transform"]?.({} as never, output as never);

    const textPart = output.messages[0]!.parts[0] as { text: string };
    const reasoningPart = output.messages[0]!.parts[1] as { text: string };

    expect(textPart.text).not.toContain(EMAIL);
    expect(textPart.text).toMatch(PLACEHOLDER_PATTERN);
    expect(reasoningPart.text).not.toContain(EMAIL);
    expect(reasoningPart.text).toMatch(PLACEHOLDER_PATTERN);
  });

  test("redacts assistant state payloads before the LLM request", async () => {
    const plugin = await createPlugin();
    const output = {
      messages: [
        {
          info: {
            role: "assistant",
            state: {
              input: { prompt: `input ${EMAIL}` },
              output: { text: `output ${EMAIL}` },
              error: { message: `error ${EMAIL}` },
              raw: { payload: `raw ${EMAIL}` },
            },
          },
          parts: [],
        },
      ],
    };

    await plugin["experimental.chat.messages.transform"]?.({} as never, output as never);

    const state = output.messages[0]!.info.state as Record<string, Record<string, string>>;

    expect(state.input.prompt).toMatch(PLACEHOLDER_PATTERN);
    expect(state.output.text).toMatch(PLACEHOLDER_PATTERN);
    expect(state.error.message).toMatch(PLACEHOLDER_PATTERN);
    expect(state.raw.payload).toMatch(PLACEHOLDER_PATTERN);
  });

  test("restores placeholders in assistant text completion output", async () => {
    const plugin = await createPlugin();
    const messagesOutput = {
      messages: [
        {
          info: { role: "user" },
          parts: [{ type: "text", text: `Primary secret: ${EMAIL}` }],
        },
      ],
    };

    await plugin["experimental.chat.messages.transform"]?.({} as never, messagesOutput as never);

    const placeholder = (messagesOutput.messages[0]!.parts[0] as { text: string }).text.match(
      PLACEHOLDER_PATTERN,
    )?.[0];

    expect(placeholder).toBeDefined();

    const completionOutput = {
      text: `Only the secret is ${placeholder}.`,
    };

    await plugin["experimental.text.complete"]?.({} as never, completionOutput as never);

    expect(completionOutput.text).toContain(EMAIL);
    expect(completionOutput.text).not.toContain(placeholder!);
  });

  test("restores placeholders in tool arguments before execution", async () => {
    const plugin = await createPlugin();
    const messagesOutput = {
      messages: [
        {
          info: { role: "user" },
          parts: [{ type: "text", text: `Primary secret: ${EMAIL}` }],
        },
      ],
    };

    await plugin["experimental.chat.messages.transform"]?.({} as never, messagesOutput as never);

    const placeholder = (messagesOutput.messages[0]!.parts[0] as { text: string }).text.match(
      PLACEHOLDER_PATTERN,
    )?.[0];

    expect(placeholder).toBeDefined();

    const toolOutput = {
      args: {
        command: `echo ${placeholder}`,
        nested: {
          value: placeholder,
        },
      },
    };

    await plugin["tool.execute.before"]?.({ tool: "bash" } as never, toolOutput as never);

    expect(toolOutput.args.command).toContain(EMAIL);
    expect(toolOutput.args.nested.value).toBe(EMAIL);
  });
});
