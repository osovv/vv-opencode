// FILE: src/plugins/secrets-redaction/index.test.ts
// VERSION: 1.2.0
// START_MODULE_CONTRACT
//   PURPOSE: Behavioral tests for the SecretsRedactionPlugin hook pipeline.
//   SCOPE: chat message redaction including configured web apiKey values, tool-part state redaction, text completion restore, and tool arg restore.
//   DEPENDS: bun:test, node:fs/promises, node:os, node:path, src/lib/config-layers.ts, index
//   LINKS: [M-PLUGIN-SECRETS-REDACTION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   EMAIL - Stable email secret fixture.
//   PLACEHOLDER_PATTERN - Expected redacted email placeholder shape.
//   tempDirs - Temporary plugin/config directories scheduled for cleanup.
//   previousConfigHome - Original XDG config home restored after tests.
//   createPlugin - Instantiate SecretsRedactionPlugin with isolated canonical config.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-UNIFIED-WEB-TOOLS - Covered exact-value redaction and deduplication for configured web apiKey fields.]
//   LAST_CHANGE: [v1.3.0 - Replaced the invalid info.state fixture with a real ToolPart.state fixture so the regression test proves tool inputs/outputs/errors are redacted.]
//   LAST_CHANGE: [C-CONTEXT-TUI-PLUGIN - Updated the PluginInput fixture for OpenCode 1.18.2 experimental workspace registration.]
//   LAST_CHANGE: [v1.2.0 - Reset the runtime vvoc config singleton between isolated plugin fixtures.]
//   LAST_CHANGE: [v1.1.0 - Switched test fixtures to the canonical vvoc.json config file and ignored legacy local config files.]
// END_CHANGE_SUMMARY

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetVvocConfigForTests } from "../../lib/config-layers.js";
import { createDefaultVvocConfig, type VvocConfig } from "../../lib/vvoc-config.js";
import { webApiKeyKeywordRules } from "./config.js";
import { SecretsRedactionPlugin } from "./index.js";

const EMAIL = "qa-redaction-check-884271@example.invalid";
const PLACEHOLDER_PATTERN = /__VVOC_SECRET_EMAIL_[0-9a-f]{12}__/;

const tempDirs: string[] = [];
const previousConfigHome = process.env.XDG_CONFIG_HOME;

afterEach(async () => {
  resetVvocConfigForTests();

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }

  if (previousConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = previousConfigHome;
  }
});

async function createPlugin(web?: VvocConfig["web"]) {
  resetVvocConfigForTests();
  const directory = await mkdtemp(join(tmpdir(), "vvoc-secrets-redaction-"));
  const configHome = await mkdtemp(join(tmpdir(), "vvoc-secrets-config-"));
  tempDirs.push(directory);
  tempDirs.push(configHome);

  process.env.XDG_CONFIG_HOME = configHome;
  await mkdir(join(configHome, "vvoc"), { recursive: true });

  await writeFile(join(directory, "secrets-redaction.config.json"), "not json");
  await writeFile(
    join(configHome, "vvoc", "vvoc.json"),
    JSON.stringify(
      {
        ...createDefaultVvocConfig(),
        ...(web ? { web } : {}),
        secretsRedaction: {
          secret: "test-secret-for-redaction",
          ttlMs: 0,
          maxMappings: 10000,
          patterns: {
            builtin: ["email"],
            keywords: [],
            regex: [],
            exclude: [],
          },
          debug: false,
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
    experimental_workspace: { register: () => undefined },
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

  test("redacts tool-part state payloads (inputs/outputs/errors) before the LLM request", async () => {
    const plugin = await createPlugin();
    const output = {
      messages: [
        {
          info: { role: "assistant" },
          parts: [
            {
              type: "tool",
              tool: "bash",
              state: {
                status: "completed",
                input: { command: `echo ${EMAIL}` },
                output: `result ${EMAIL}`,
                title: "run",
                metadata: { note: `meta ${EMAIL}` },
              },
            },
            {
              type: "tool",
              tool: "read",
              state: {
                status: "error",
                input: { filePath: "/x" },
                error: `failed ${EMAIL}`,
              },
            },
          ],
        },
      ],
    };

    await plugin["experimental.chat.messages.transform"]?.({} as never, output as never);

    const completed = output.messages[0]!.parts[0] as {
      state: { input: { command: string }; output: string; metadata: { note: string } };
    };
    const errored = output.messages[0]!.parts[1] as { state: { error: string } };

    expect(completed.state.input.command).not.toContain(EMAIL);
    expect(completed.state.input.command).toMatch(PLACEHOLDER_PATTERN);
    expect(completed.state.output).not.toContain(EMAIL);
    expect(completed.state.output).toMatch(PLACEHOLDER_PATTERN);
    expect(completed.state.metadata.note).toMatch(PLACEHOLDER_PATTERN);
    expect(errored.state.error).not.toContain(EMAIL);
    expect(errored.state.error).toMatch(PLACEHOLDER_PATTERN);
  });

  test("redacts configured web search and fetch apiKey values from message text", async () => {
    const searchKey = "configured-exa-key-123";
    const fetchKey = "configured-spider-key-456";
    const plugin = await createPlugin({
      search: { provider: "exa", apiKey: searchKey },
      fetch: { provider: "spider", apiKey: fetchKey },
    });
    const output = {
      messages: [
        {
          info: { role: "user" },
          parts: [{ type: "text", text: `search=${searchKey} fetch=${fetchKey}` }],
        },
      ],
    };

    await plugin["experimental.chat.messages.transform"]?.({} as never, output as never);
    const text = (output.messages[0]!.parts[0] as { text: string }).text;
    expect(text).not.toContain(searchKey);
    expect(text).not.toContain(fetchKey);
    expect(text.match(/__VVOC_SECRET_WEB_API_KEY_[0-9a-f]{12}__/g)).toHaveLength(2);
  });

  test("web apiKey rules skip absent and empty fields and deduplicate equal values", () => {
    const absent = createDefaultVvocConfig();
    expect(webApiKeyKeywordRules(absent)).toEqual([]);

    const duplicate = createDefaultVvocConfig();
    duplicate.web = {
      search: { apiKey: "same-key" },
      fetch: { apiKey: "same-key" },
    };
    expect(webApiKeyKeywordRules(duplicate)).toEqual([
      { value: "same-key", category: "WEB_API_KEY" },
    ]);

    const empty = createDefaultVvocConfig();
    empty.web = { search: { apiKey: "" }, fetch: {} };
    expect(webApiKeyKeywordRules(empty)).toEqual([]);
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
