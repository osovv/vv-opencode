// FILE: src/plugins/secrets-redaction/index.test.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Native-boundary behavioral tests for the SecretsRedactionPlugin handlers: context redaction including configured and placeholder-resolved web apiKey values, tool-part payload redaction, http.response stream restoration, tool-input restoration, strict per-family disabled/unknown policy behavior, and per-native-session WebSocket framing lifecycle (handshake discard, abandoned-stream isolation, same-family session independence, production hook registration).
//   SCOPE: Invoke the native hook handlers with pinned message/system/stream shapes through createSecretsRedactionRegistration with an injected strict family policy resolver; pure web apiKey rule tests are retained.
//   DEPENDS: bun:test, src/lib/vvoc-config.ts, src/plugins/secrets-redaction/config.ts, src/plugins/secrets-redaction/index.ts
//   LINKS: [M-PLUGIN-SECRETS-REDACTION, V-M-PLUGIN-SECRETS-REDACTION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   EMAIL - Stable email secret fixture.
//   PLACEHOLDER_PATTERN - Expected redacted email placeholder shape.
//   makeRegistration - Build native handlers with an injected family policy resolution.
//   createSecretsRedactionPlugin - Plugin factory under test for production hook registration.
//   REAL_HOST - Pinned host binary from VVOC_E2E_V2_HOST; the gated smoke is skipped when unset.
//   realHostDescribe - describe when a real host is configured, describe.skip otherwise.
//   ContextPart - Context message content part fixture.
//   ContextMessage - Context message fixture.
//   PolicyMode - Enabled/disabled/unknown policy mode for the fixture.
//   SMOKE_SECRET - Real-host smoke sentinel secret.
//   SMOKE_HMAC - Real-host smoke placeholder HMAC secret.
//   Scenario - Running real-host scenario handle.
//   startScenario - Boot an isolated real-host scenario with a scripted provider.
//   reserveFreePort - Reserve a free loopback port.
//   smokePlaceholder - Deterministic smoke placeholder for the sentinel.
//   assistantText - Extract the persisted assistant text from context entries.
//   distPlugin - Resolve a built plugin subpath.
//   prompt - Send one smoke prompt to a scenario session.
//   firstPlaceholder - Produce one redacted placeholder through the handlers.
//   secretsVvoc - Build a vvoc config with the smoke secrets settings.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE MID-REPAIR-2 - Added per-native-session WebSocket framing regressions: a handshake discards a terminal-less SSE stream and abandoned partial carries so later JSON frames restore, a >512-session same-family fan-out never evicts an active carry, two same-family sessions keep independent framing while sharing mappings, and production setup's registered handshake/receive callbacks are invoked through an abort/retry with every hook disposer observed.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createDefaultVvocConfig,
  renderVvocConfig,
  type VvocConfig,
} from "../../lib/vvoc-config.js";
import { resolveSecretsRedactionRuntimeConfig, webApiKeyKeywordRules } from "./config.js";
import {
  createSecretsRedactionPlugin,
  createSecretsRedactionRegistration,
  type SecretsRedactionRegistration,
} from "./index.js";

const EMAIL = "qa-redaction-check-884271@example.invalid";
const PLACEHOLDER_PATTERN = /__VVOC_SECRET_EMAIL_[0-9a-f]{12}__/;

interface ContextPart {
  type?: string;
  text?: string;
  input?: unknown;
  result?: { type?: string; value?: unknown };
  metadata?: unknown;
}
interface ContextMessage {
  role?: string;
  content: ContextPart[];
}

function secretsVvoc(web?: VvocConfig["web"], disabled = false): VvocConfig {
  const config = createDefaultVvocConfig();
  if (web !== undefined) config.web = web;
  if (disabled) config.plugins = { ...config.plugins, "secrets-redaction": false };
  config.secretsRedaction = {
    secret: "test-secret-for-redaction",
    ttlMs: 0,
    maxMappings: 10000,
    patterns: { builtin: ["email"], keywords: [], regex: [], exclude: [] },
    debug: false,
  };
  return config;
}

type PolicyMode = "enabled" | "disabled" | "unknown";

function makeRegistration(
  web?: VvocConfig["web"],
  mode: PolicyMode = "enabled",
  familyKey: (sessionID: string) => string = (sessionID) => `family-${sessionID}`,
): SecretsRedactionRegistration {
  const vvoc = secretsVvoc(web, mode === "disabled");
  const resolved = resolveSecretsRedactionRuntimeConfig({
    config: vvoc,
    source: { kind: "default" },
    warnings: [],
  });
  return createSecretsRedactionRegistration({
    configFor: async (sessionID) => {
      if (mode === "unknown") return undefined;
      if (mode === "disabled") return "disabled";
      return { key: familyKey(sessionID), config: resolved.config };
    },
    log: () => undefined,
  });
}

async function firstPlaceholder(registration: SecretsRedactionRegistration): Promise<string> {
  const messages: ContextMessage[] = [
    { role: "user", content: [{ type: "text", text: `x ${EMAIL}` }] },
  ];
  await registration.handlers.context({ sessionID: "s1", messages });
  return messages[0]!.content[0]!.text!.match(PLACEHOLDER_PATTERN)![0];
}

describe("SecretsRedactionPlugin", () => {
  test("redacts user text and reasoning parts before the LLM request", async () => {
    const registration = makeRegistration();
    const messages: ContextMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: `Primary secret: ${EMAIL}` },
          { type: "reasoning", text: `Reasoning secret: ${EMAIL}` },
        ],
      },
    ];

    await registration.handlers.context({ sessionID: "s1", messages });

    expect(messages[0]!.content[0]!.text).not.toContain(EMAIL);
    expect(messages[0]!.content[0]!.text).toMatch(PLACEHOLDER_PATTERN);
    expect(messages[0]!.content[1]!.text).not.toContain(EMAIL);
    expect(messages[0]!.content[1]!.text).toMatch(PLACEHOLDER_PATTERN);
  });

  test("redacts native system text and tool-call/tool-result payloads before the request", async () => {
    const registration = makeRegistration();
    const system = [{ type: "text", text: `system ${EMAIL}` }];
    const messages: ContextMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", input: { command: `echo ${EMAIL}` } },
          { type: "tool-result", result: { type: "text", value: `result ${EMAIL}` } },
          { type: "tool-result", result: { type: "json", value: { note: EMAIL } } },
        ],
      },
    ];

    await registration.handlers.context({ sessionID: "s1", system, messages });

    expect(system[0]!.text).not.toContain(EMAIL);
    expect(system[0]!.text).toMatch(PLACEHOLDER_PATTERN);
    const call = messages[0]!.content[0]!.input as { command: string };
    expect(call.command).not.toContain(EMAIL);
    expect(call.command).toMatch(PLACEHOLDER_PATTERN);
    expect(String(messages[0]!.content[1]!.result!.value)).not.toContain(EMAIL);
    expect(String(messages[0]!.content[1]!.result!.value)).toMatch(PLACEHOLDER_PATTERN);
    expect(JSON.stringify(messages[0]!.content[2]!.result!.value)).not.toContain(EMAIL);
  });

  test("preserves media and opaque content parts unchanged", async () => {
    const registration = makeRegistration();
    const opaque = { type: "media", media: { uri: `data:x,${EMAIL}`, mime: "image/png" } };
    const messages: ContextMessage[] = [{ role: "assistant", content: [opaque] }];
    await registration.handlers.context({ sessionID: "s1", messages });
    expect((messages[0]!.content[0] as { media: { uri: string } }).media.uri).toContain(EMAIL);
  });

  test("redacts configured web search and fetch apiKey values from message text", async () => {
    const searchKey = "configured-exa-key-123";
    const fetchKey = "configured-spider-key-456";
    const registration = makeRegistration({
      search: { provider: "exa", apiKey: searchKey },
      fetch: { provider: "spider", apiKey: fetchKey },
    });
    const messages: ContextMessage[] = [
      { role: "user", content: [{ type: "text", text: `search=${searchKey} fetch=${fetchKey}` }] },
    ];

    await registration.handlers.context({ sessionID: "s1", messages });
    const text = messages[0]!.content[0]!.text!;
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

  test("web apiKey rules resolve ${VAR} placeholders from the environment", () => {
    const config = createDefaultVvocConfig();
    config.web = {
      search: { apiKey: "${VVOC_TEST_SEARCH_KEY}" },
      fetch: { apiKey: "${VVOC_TEST_UNSET_KEY}" },
    };
    expect(webApiKeyKeywordRules(config, { VVOC_TEST_SEARCH_KEY: "resolved-search-key" })).toEqual([
      { value: "resolved-search-key", category: "WEB_API_KEY" },
    ]);
  });

  test("redacts the resolved value of a placeholder web apiKey, not the placeholder text", async () => {
    const realKey = "resolved-placeholder-key-789";
    process.env.VVOC_TEST_WEB_PLACEHOLDER_KEY = realKey;
    try {
      const vvoc = secretsVvoc({
        search: { provider: "exa", apiKey: "${VVOC_TEST_WEB_PLACEHOLDER_KEY}" },
      });
      const resolved = resolveSecretsRedactionRuntimeConfig({
        config: vvoc,
        source: { kind: "default" },
        warnings: [],
      });
      const registration = createSecretsRedactionRegistration({
        configFor: async () => ({ key: "fam", config: resolved.config }),
        log: () => undefined,
      });
      const messages: ContextMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: `key=${realKey} raw=\${VVOC_TEST_WEB_PLACEHOLDER_KEY}` }],
        },
      ];

      await registration.handlers.context({ sessionID: "s1", messages });
      const text = messages[0]!.content[0]!.text!;
      expect(text).not.toContain(realKey);
      expect(text).toContain("${VVOC_TEST_WEB_PLACEHOLDER_KEY}");
      expect(text).toMatch(/__VVOC_SECRET_WEB_API_KEY_[0-9a-f]{12}__/);
    } finally {
      delete process.env.VVOC_TEST_WEB_PLACEHOLDER_KEY;
    }
  });

  test("restores placeholders in a completed streaming response", async () => {
    const registration = makeRegistration();
    const placeholder = await firstPlaceholder(registration);
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: `Only the secret is ${placeholder}.` } }] })}\n\n`;
    const event = {
      sessionID: "s1",
      response: new Response(sse, { headers: { "content-type": "text/event-stream" } }),
    };

    await registration.handlers.httpResponse(event);

    const text = await event.response.text();
    expect(text).toContain(EMAIL);
    expect(text).not.toContain(placeholder);
  });

  test("restores placeholders in native tool arguments before execution", async () => {
    const registration = makeRegistration();
    const placeholder = await firstPlaceholder(registration);
    const event = {
      sessionID: "s1",
      tool: "bash",
      input: { command: `echo ${placeholder}`, nested: { value: placeholder } },
    };

    await registration.handlers.toolBefore(event);

    expect((event.input as { command: string }).command).toContain(EMAIL);
    expect((event.input as { nested: { value: string } }).nested.value).toBe(EMAIL);
  });

  test("a disabled captured family leaves requests and tool inputs untouched", async () => {
    const registration = makeRegistration(undefined, "disabled");
    const messages: ContextMessage[] = [
      { role: "user", content: [{ type: "text", text: `x ${EMAIL}` }] },
    ];
    await registration.handlers.context({ sessionID: "s1", messages });
    expect(messages[0]!.content[0]!.text).toBe(`x ${EMAIL}`);

    const input = { command: `echo ${EMAIL}` };
    await registration.handlers.toolBefore({ sessionID: "s1", tool: "bash", input });
    expect(input.command).toBe(`echo ${EMAIL}`);
  });

  test("an unknown family policy blocks provider-bound redaction instead of emitting unredacted data", async () => {
    const registration = makeRegistration(undefined, "unknown");
    const messages: ContextMessage[] = [
      { role: "user", content: [{ type: "text", text: `x ${EMAIL}` }] },
    ];
    await expect(registration.handlers.context({ sessionID: "s1", messages })).rejects.toThrow(
      "SECRETS_POLICY_UNBOUND",
    );
    expect(messages[0]!.content[0]!.text).toBe(`x ${EMAIL}`);

    const input = { command: `echo ${EMAIL}` };
    await registration.handlers.toolBefore({ sessionID: "s1", tool: "bash", input });
    expect(input.command).toBe(`echo ${EMAIL}`);
  });
});

describe("SecretsRedactionPlugin WebSocket framing lifecycle", () => {
  test("a new handshake discards a terminal-less SSE stream so later JSON frames restore", async () => {
    const registration = makeRegistration();
    const placeholder = await firstPlaceholder(registration);

    // Begin SSE-over-WS and end it without [DONE] or a global terminal frame.
    await registration.handlers.wsHandshake({ sessionID: "s1" });
    await registration.handlers.wsReceive({
      sessionID: "s1",
      frame: `data: ${JSON.stringify({
        choices: [
          { delta: { content: `abandoned ${placeholder.slice(0, 8)}` }, finish_reason: null },
        ],
      })}\n`,
    });

    // A later model call crosses a new handshake before its frames arrive.
    await registration.handlers.wsHandshake({ sessionID: "s1" });
    const frame = JSON.stringify({
      choices: [{ delta: { content: `restored ${placeholder}` }, finish_reason: null }],
    });
    const first = { sessionID: "s1", frame };
    const second = { sessionID: "s1", frame };
    await registration.handlers.wsReceive(first);
    await registration.handlers.wsReceive(second);

    expect(first.frame.length).toBeGreaterThan(0);
    expect(second.frame.length).toBeGreaterThan(0);
    expect(first.frame).toContain(EMAIL);
    expect(second.frame).toContain(EMAIL);
    expect(first.frame).not.toContain("__VVOC_SECRET_");
    expect(second.frame).not.toContain("__VVOC_SECRET_");
  });

  test("an abandoned partial plain-text carry does not contaminate the next request", async () => {
    const registration = makeRegistration();
    const placeholder = await firstPlaceholder(registration);

    await registration.handlers.wsHandshake({ sessionID: "s1" });
    await registration.handlers.wsReceive({
      sessionID: "s1",
      frame: `held ${placeholder.slice(0, 10)}`,
    });
    await registration.handlers.wsHandshake({ sessionID: "s1" });

    const next = { sessionID: "s1", frame: `next ${placeholder} done` };
    await registration.handlers.wsReceive(next);

    expect(next.frame).toBe(`next ${EMAIL} done`);
  });

  test("an abandoned partial JSON lane carry does not contaminate the next request", async () => {
    const registration = makeRegistration();
    const placeholder = await firstPlaceholder(registration);

    await registration.handlers.wsHandshake({ sessionID: "s1" });
    await registration.handlers.wsReceive({
      sessionID: "s1",
      frame: JSON.stringify({
        choices: [{ delta: { content: `cut ${placeholder.slice(0, 9)}` }, finish_reason: null }],
      }),
    });
    await registration.handlers.wsHandshake({ sessionID: "s1" });

    const next = {
      sessionID: "s1",
      frame: JSON.stringify({
        choices: [{ delta: { content: placeholder }, finish_reason: null }],
      }),
    };
    await registration.handlers.wsReceive(next);

    const parsed = JSON.parse(next.frame) as {
      choices: Array<{ delta: { content: string } }>;
    };
    expect(parsed.choices[0]!.delta.content).toBe(EMAIL);
  });

  test("two same-family sessions keep independent framing while sharing mappings", async () => {
    const registration = makeRegistration(undefined, "enabled", () => "family-shared");
    // The placeholder is created through s1 but the family map is shared with s2.
    const placeholder = await firstPlaceholder(registration);

    await registration.handlers.wsHandshake({ sessionID: "s1" });
    await registration.handlers.wsReceive({
      sessionID: "s1",
      frame: `data: ${JSON.stringify({
        choices: [{ delta: { content: `s1 ${placeholder.slice(0, 8)}` }, finish_reason: null }],
      })}\n`,
    });
    await registration.handlers.wsHandshake({ sessionID: "s2" });
    await registration.handlers.wsReceive({
      sessionID: "s2",
      frame: `s2 ${placeholder.slice(0, 10)}`,
    });

    // Resetting s1 must not disturb s2's pending carry.
    await registration.handlers.wsHandshake({ sessionID: "s1" });
    const s1Next = {
      sessionID: "s1",
      frame: JSON.stringify({
        choices: [{ delta: { content: `s1 done ${placeholder}` }, finish_reason: null }],
      }),
    };
    await registration.handlers.wsReceive(s1Next);
    const s2Next = { sessionID: "s2", frame: `${placeholder.slice(10)} done` };
    await registration.handlers.wsReceive(s2Next);

    expect(s1Next.frame).toContain(EMAIL);
    expect(s1Next.frame).not.toContain("__VVOC_SECRET_");
    expect(s2Next.frame).toBe(`${EMAIL} done`);
  });

  test("a fan-out of many unrelated same-family sessions never evicts an active carry", async () => {
    const registration = makeRegistration(undefined, "enabled", () => "family-shared");
    const placeholder = await firstPlaceholder(registration);

    // The active session holds an incomplete placeholder carry.
    await registration.handlers.wsHandshake({ sessionID: "active" });
    const opened = { sessionID: "active", frame: placeholder.slice(0, 10) };
    await registration.handlers.wsReceive(opened);

    // Hundreds of unrelated same-family sessions each consume their own framing
    // state. None of them may reset or evict the active session's carry.
    for (let index = 0; index < 512; index += 1) {
      const sessionID = `unrelated-${index}`;
      await registration.handlers.wsHandshake({ sessionID });
      await registration.handlers.wsReceive({ sessionID, frame: "unrelated" });
    }

    const completed = { sessionID: "active", frame: placeholder.slice(10) };
    await registration.handlers.wsReceive(completed);

    // The first session's carry survived the fan-out and completed its placeholder.
    expect(completed.frame).toBe(EMAIL);
  });
});

describe("SecretsRedactionPlugin registration", () => {
  test("registered socket callbacks run the abort/retry handshake reset and every hook disposes", async () => {
    type HookCallback = (event: Record<string, unknown>) => unknown;
    const capture = { familyId: "family-shared", vvoc: secretsVvoc() };
    const sessionHooks = new Map<string, HookCallback>();
    const disposed: string[] = [];
    let released = false;
    const fakeRuntime = {
      snapshots: {
        configFor: async () => capture,
        accept: async () => ({ status: "unbound" }),
      },
      release: async () => {
        released = true;
      },
    };
    const fakeContext = {
      session: {
        hook: async (name: string, callback: HookCallback) => {
          sessionHooks.set(name, callback);
          return { dispose: async () => void disposed.push(`session:${name}`) };
        },
      },
      tool: {
        hook: async (name: string, _callback: HookCallback) => ({
          dispose: async () => void disposed.push(`tool:${name}`),
        }),
      },
    };
    const plugin = createSecretsRedactionPlugin({
      acquireRuntime: async () => fakeRuntime as never,
      log: () => undefined,
    });

    const cleanup = await plugin.setup(fakeContext as never);

    const context = sessionHooks.get("context");
    const handshake = sessionHooks.get("experimental.ws.handshake");
    const receive = sessionHooks.get("experimental.ws.receive");
    expect(typeof context).toBe("function");
    expect(typeof handshake).toBe("function");
    expect(typeof receive).toBe("function");

    // Produce the placeholder through the registered redaction callback.
    const messages: ContextMessage[] = [
      { role: "user", content: [{ type: "text", text: `x ${EMAIL}` }] },
    ];
    await context!({ sessionID: "s1", messages });
    const placeholder = messages[0]!.content[0]!.text!.match(PLACEHOLDER_PATTERN)![0];

    // An abandoned SSE attempt, then a retry crosses a fresh handshake.
    await handshake!({ sessionID: "s1" });
    await receive!({
      sessionID: "s1",
      frame: `data: ${JSON.stringify({
        choices: [
          { delta: { content: `abandoned ${placeholder.slice(0, 8)}` }, finish_reason: null },
        ],
      })}\n`,
    });
    await handshake!({ sessionID: "s1" });
    const retry = {
      sessionID: "s1",
      frame: JSON.stringify({
        choices: [{ delta: { content: `retry ${placeholder}` }, finish_reason: null }],
      }),
    };
    await receive!(retry);

    // The registered handshake reset must let the retry's JSON frame restore.
    expect(retry.frame.length).toBeGreaterThan(0);
    expect(retry.frame).toContain(EMAIL);
    expect(retry.frame).not.toContain("__VVOC_SECRET_");
    expect(released).toBe(false);

    await cleanup?.();
    expect([...disposed].sort()).toEqual(
      [
        "session:compaction",
        "session:context",
        "session:experimental.ws.handshake",
        "session:experimental.ws.receive",
        "session:generate",
        "session:http.response",
        "session:title",
        "tool:execute.before",
      ].sort(),
    );
    expect(released).toBe(true);
  });
});

// START_BLOCK_REAL_HOST_SMOKE
/**
 * Optional isolated real-host smoke. Runs only when `VVOC_E2E_V2_HOST` points
 * at the pinned OpenCode 2.0.18 binary; otherwise it is skipped. The aggregate
 * scenario loads ONE composite plugin that calls the actual built
 * ModelRolesPlugin.setup(ctx) and SecretsRedactionPlugin.setup(ctx) on the same
 * ctx, proving redact -> split restore, the auxiliary title path, and explicit
 * disabled redaction. A second scenario loads them as separate subpath packages
 * to reproduce the distinct-context behavior for T009 (core files are read-only
 * here).
 */
const REAL_HOST = process.env.VVOC_E2E_V2_HOST;
const realHostDescribe = REAL_HOST ? describe : describe.skip;
const SMOKE_SECRET = "smoke-redaction-original-secret";
const SMOKE_HMAC = "smoke-redaction-hmac-secret";

function smokePlaceholder(): string {
  const hash12 = createHmac("sha256", SMOKE_HMAC).update(SMOKE_SECRET).digest("hex").slice(0, 12);
  return `__VVOC_SECRET_SMOKE_${hash12}__`;
}

function reserveFreePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const free = probe.port;
  probe.stop(true);
  if (free === undefined) throw new Error("could not reserve a loopback port");
  return free;
}

interface Scenario {
  readonly root: string;
  readonly project: string;
  readonly tracePath: string;
  readonly hostLogPath: string;
  readonly api: (path: string, init?: RequestInit) => Promise<{ status: number; body?: unknown }>;
  readonly createSession: () => Promise<string>;
  readonly waitForTurn: (sessionID: string) => Promise<Array<Record<string, unknown>>>;
  readonly setSecretsDisabled: () => Promise<void>;
  stop: () => void;
}

async function startScenario(
  pluginPackages: Array<{ name: string; source: string }>,
): Promise<Scenario> {
  const root = join(
    process.env.VVOC_E2E_SCRATCH ?? "/tmp/opencode",
    `vvoc-t005-secrets-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await rm(root, { recursive: true, force: true });
  const project = join(root, "project");
  await mkdir(join(project, ".vvoc"), { recursive: true });
  for (const dir of ["home", "cfg", "data", "state", "cache"]) {
    await mkdir(join(root, dir), { recursive: true });
  }
  const port = reserveFreePort();
  const hostPort = reserveFreePort();
  const tracePath = join(root, "provider.jsonl");
  const placeholder = smokePlaceholder();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const url = new URL(request.url);
      const bodyText = await request.clone().text();
      appendFileSync(tracePath, `${bodyText}\n`, "utf8");
      if (url.pathname.endsWith("/models")) {
        return Response.json({
          object: "list",
          data: [
            {
              id: "seam-smart",
              object: "model",
              created: 1,
              owned_by: "loopback",
              name: "Seam Smart",
              context_window: 128000,
              max_output_tokens: 8192,
            },
          ],
        });
      }
      if (url.pathname.endsWith("/chat/completions")) {
        const body = JSON.parse(bodyText) as { model?: string };
        const half = Math.ceil(placeholder.length / 2);
        const chunk = (delta: Record<string, unknown>, finish: string | null) =>
          `data: ${JSON.stringify({
            id: "c",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`;
        const usage = `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: body.model, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`;
        return new Response(
          `${chunk({ role: "assistant" }, null)}${chunk({ content: placeholder.slice(0, half) }, null)}${chunk({ content: placeholder.slice(half) }, null)}${chunk({}, "stop")}${usage}data: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });

  const pluginEntries: Array<{ package: string }> = [];
  for (const pluginPackage of pluginPackages) {
    const dir = join(root, pluginPackage.name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: `vvoc-t005-${pluginPackage.name}`, private: true, version: "0.0.0" }),
      "utf8",
    );
    await writeFile(join(dir, "index.ts"), pluginPackage.source, "utf8");
    pluginEntries.push({ package: dir });
  }
  await writeFile(
    join(project, "opencode.json"),
    JSON.stringify({
      model: "loopback/seam-smart",
      providers: {
        loopback: {
          name: "Smoke Loopback",
          package: "@opencode/ai/providers/openai-compatible",
          env: ["LOOPBACK_API_KEY"],
          settings: { baseURL: `http://127.0.0.1:${port}/v1`, provider: "loopback" },
          models: { "seam-smart": { name: "Seam Smart" } },
        },
      },
      plugins: pluginEntries,
    }),
    "utf8",
  );
  const writeVvoc = async (disableSecrets: boolean) => {
    const vvoc = createDefaultVvocConfig();
    vvoc.roles = {
      ...vvoc.roles,
      default: "loopback/seam-smart",
      smart: "loopback/seam-smart",
      fast: "loopback/seam-smart",
      reviewer: "loopback/seam-smart",
    };
    if (disableSecrets) vvoc.plugins = { ...vvoc.plugins, "secrets-redaction": false };
    vvoc.secretsRedaction = {
      secret: SMOKE_HMAC,
      ttlMs: 0,
      maxMappings: 10000,
      patterns: {
        builtin: [],
        keywords: [{ value: SMOKE_SECRET, category: "SMOKE" }],
        regex: [],
        exclude: [],
      },
      debug: false,
    };
    await writeFile(join(project, ".vvoc", "vvoc.json"), renderVvocConfig(vvoc), "utf8");
  };
  await writeVvoc(false);

  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "cfg"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    LOOPBACK_API_KEY: "smoke-key",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
  };
  const host = Bun.spawn(
    [
      REAL_HOST as string,
      "serve",
      "--service",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(hostPort),
      "--log-level",
      "error",
    ],
    { env, stdout: "ignore", stderr: "pipe" },
  );
  let hostStderr = "";
  void new Response(host.stderr as ReadableStream).text().then((text) => {
    hostStderr = text;
  });
  const servicePath = join(root, "state", "opencode", "service.json");
  let password: string | undefined;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      password = (JSON.parse(await readFile(servicePath, "utf8")) as { password?: string })
        .password;
      if (password) break;
    } catch {
      /* not registered yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!password) throw new Error(`host did not register; stderr: ${hostStderr}`);
  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  const api = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`http://127.0.0.1:${hostPort}${path}`, {
      ...init,
      headers: {
        authorization: auth,
        "content-type": "application/json",
        "x-opencode-directory": project,
        ...init.headers,
      },
    });
    return { status: response.status, body: await response.json().catch(() => undefined) };
  };
  const createSession = async (): Promise<string> => {
    const created = (await api("/api/session", {
      method: "POST",
      body: JSON.stringify({ location: { directory: project } }),
    })) as { body?: { data?: { id?: string } } };
    const id = created.body?.data?.id;
    if (!id) throw new Error("session create failed");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return id;
  };
  const waitForTurn = async (sessionID: string): Promise<Array<Record<string, unknown>>> => {
    const deadline = Date.now() + 25000;
    for (;;) {
      const context = (await api(`/api/session/${sessionID}/context`)) as {
        body?: { data?: Array<Record<string, unknown>> };
      };
      const entries = context.body?.data ?? [];
      if (entries.some((entry) => entry.type === "idle")) return entries;
      if (Date.now() > deadline) return entries;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  };
  return {
    root,
    project,
    tracePath,
    hostLogPath: join(root, "data", "opencode", "log", "opencode.log"),
    api,
    createSession,
    waitForTurn,
    setSecretsDisabled: () => writeVvoc(true),
    stop: () => {
      host.kill("SIGTERM");
      server.stop(true);
    },
  };
}

async function prompt(scenario: Scenario, sessionID: string): Promise<void> {
  const response = await scenario.api(`/api/session/${sessionID}/prompt`, {
    method: "POST",
    body: JSON.stringify({ text: `please protect ${SMOKE_SECRET} carefully` }),
  });
  if (response.status >= 400) throw new Error(`prompt failed: ${response.status}`);
}

function assistantText(entries: Array<Record<string, unknown>>): string {
  const assistant = entries.find((entry) => entry.type === "assistant");
  return JSON.stringify(assistant?.content ?? "");
}

const distPlugin = (name: string) =>
  join(import.meta.dir, "..", "..", "..", "dist", "plugins", name, "index.js");

realHostDescribe("real OpenCode 2.0.18 host smoke (built secrets-redaction)", () => {
  test("same-context composite: redact -> split restore, title, and disabled redaction", async () => {
    const scenario = await startScenario([
      {
        name: "composite",
        source:
          `import modelRoles from "${distPlugin("model-roles")}";\n` +
          `import secrets from "${distPlugin("secrets-redaction")}";\n` +
          `export default { id: "vvoc.t005.composite", async setup(ctx) {\n` +
          `  const cleanups = [];\n` +
          `  const roles = await modelRoles.setup(ctx);\n` +
          `  if (roles) cleanups.push(roles);\n` +
          `  const secret = await secrets.setup(ctx);\n` +
          `  if (secret) cleanups.push(secret);\n` +
          `  return async () => { for (const cleanup of cleanups.reverse()) await cleanup(); };\n` +
          `} };\n`,
      },
    ]);
    try {
      const sessionID = await scenario.createSession();
      await prompt(scenario, sessionID);
      const entries = await scenario.waitForTurn(sessionID);
      expect(entries.find((entry) => entry.type === "idle")?.outcome).toBe("succeeded");

      const trace = await readFile(scenario.tracePath, "utf8").catch(() => "");
      expect(trace).toContain(smokePlaceholder());
      expect(trace).not.toContain(SMOKE_SECRET);
      expect(assistantText(entries)).toContain(SMOKE_SECRET);

      const listed = (await scenario.api(
        `/api/session?location[directory]=${encodeURIComponent(scenario.project)}`,
      )) as { body?: { data?: Array<{ id: string; parentID?: string; title?: string }> } };
      const sessions = listed.body?.data ?? [];
      expect(sessions.some((entry) => entry.parentID === sessionID)).toBe(true);
      expect(sessions.find((entry) => entry.id === sessionID)?.title).toBe(SMOKE_SECRET);

      // An explicitly disabled captured policy performs no redaction or restoration.
      await scenario.setSecretsDisabled();
      const traceBefore = (await readFile(scenario.tracePath, "utf8").catch(() => "")).length;
      const disabledSession = await scenario.createSession();
      await prompt(scenario, disabledSession);
      const disabledEntries = await scenario.waitForTurn(disabledSession);
      expect(disabledEntries.find((entry) => entry.type === "idle")?.outcome).toBe("succeeded");
      const disabledTrace = (await readFile(scenario.tracePath, "utf8").catch(() => "")).slice(
        traceBefore,
      );
      expect(disabledTrace).toContain(SMOKE_SECRET);
      expect(disabledTrace).not.toContain(smokePlaceholder());
      expect(assistantText(disabledEntries)).not.toContain(SMOKE_SECRET);
    } finally {
      scenario.stop();
      await rm(scenario.root, { recursive: true, force: true });
    }
  }, 120_000);

  test("distinct-context subpath registration (secrets-first): preserves core failure evidence for T009", async () => {
    // Distinct Plugin.Context objects (separately registered subpath packages)
    // are the not-yet-reconciled T009 aggregate mode. Registration order matters:
    // secrets-before-model-roles reproduces the failure; the same-context
    // composite above succeeds. Core snapshot-service keying is read-only here.
    const scenario = await startScenario([
      {
        name: "secrets",
        source: `import p from "${distPlugin("secrets-redaction")}";\nexport default p;\n`,
      },
      {
        name: "roles",
        source: `import p from "${distPlugin("model-roles")}";\nexport default p;\n`,
      },
    ]);
    try {
      const sessionID = await scenario.createSession();
      await prompt(scenario, sessionID);
      const entries = await scenario.waitForTurn(sessionID);
      expect(entries.find((entry) => entry.type === "idle")?.outcome).toBe("failed");
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const hostLog = await readFile(scenario.hostLogPath, "utf8").catch(() => "");
      expect(hostLog).toContain("SnapshotAdmissionError");
      expect(hostLog).toContain("does not match the captured family selection");
    } finally {
      scenario.stop();
      await rm(scenario.root, { recursive: true, force: true });
    }
  }, 120_000);
});
// END_BLOCK_REAL_HOST_SMOKE
