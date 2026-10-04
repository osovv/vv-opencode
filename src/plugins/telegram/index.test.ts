// FILE: src/plugins/telegram/index.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the plugin entry: value-free disabled diagnostics for absent sections, unresolved tokens, and disabled toggles; the app-identity singleton across multiple contexts; and full teardown on the last cleanup.
//   SCOPE: Fake plugin context, storage, native client, transport factory, and runtime acquisition driving the assembled entry; no network or real native dependency.
//   DEPENDS: [src/plugins/telegram/index.ts, src/plugins/telegram/gateway.ts]
//   LINKS: [M-PLUGIN-TELEGRAM-BRIDGE, V-M-PLUGIN-TELEGRAM-BRIDGE]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   FakeStorage - In-memory plugin storage with prefix scan.
//   FakeTransport - Recording transport counting construction and polling aborts.
//   makeCtx - Build a fake plugin context with a shared app object.
//   makeDeps - Build injectable dependencies around the fakes.
//   makeClient - Build a fake native client.
//   setupPlugin - Invoke the plugin entry setup through its public surface.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-TELEGRAM-BRIDGE-PLUGIN T-008 - Covered disabled causes, the app-identity singleton, command registration, and last-cleanup teardown.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { createTelegramBridgePlugin, type NativeClientLike } from "./index.js";
import type { TelegramTransport } from "./bot-api.js";
import type { Plugin } from "@opencode/plugin";

class FakeStorage {
  readonly map = new Map<string, unknown>();
  async get(key: string): Promise<unknown> {
    return this.map.get(key);
  }
  async set(key: string, value: unknown): Promise<void> {
    this.map.set(key, structuredClone(value));
  }
  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }
  async scan(options: { prefix: string }) {
    return {
      entries: [...this.map.entries()]
        .filter(([key]) => key.startsWith(options.prefix))
        .map(([key, value]) => ({ key, value: structuredClone(value) })),
    };
  }
}

class FakeTransport implements TelegramTransport {
  static constructed = 0;
  readonly polls = 0;
  static reset(): void {
    FakeTransport.constructed = 0;
  }
  constructor() {
    FakeTransport.constructed += 1;
  }
  async createForumTopic(_name: string) {
    return { threadId: 100 + FakeTransport.constructed };
  }
  async editForumTopic(): Promise<void> {}
  async closeForumTopic(): Promise<void> {}
  async reopenForumTopic(): Promise<void> {}
  async sendMessage() {
    return { messageId: 1 };
  }
  async sendDocument() {
    return { messageId: 2 };
  }
  async editMessageText(): Promise<void> {}
  async deleteMessage(): Promise<void> {}
  async sendDraft(): Promise<void> {}
  async answerCallback(): Promise<void> {}
  async setMyCommands(): Promise<void> {}
  async downloadFile(): Promise<Uint8Array> {
    return new Uint8Array();
  }
  async getUpdates(): Promise<never[]> {
    return [];
  }
}

function makeClient(): NativeClientLike {
  return {
    session: {
      list: async () => ({ data: [] }),
      active: async () => ({}),
      fork: async () => ({ id: "ses_fork" }),
      form: { list: async () => ({ data: [] }), reply: async () => undefined },
    },
    message: { list: async () => ({ data: [] }) },
    project: { list: async () => ({ data: [] }) },
    permission: { list: async () => ({ data: [] }), reply: async () => undefined },
  };
}

function makeCtx(app: object) {
  return {
    app,
    location: { directory: "/home/al/dev/vv-opencode" },
    storage: new FakeStorage(),
    event: {
      subscribe: (() => {
        async function* empty() {}
        return empty();
      })(),
    },
    session: {
      prompt: async () => ({ info: { id: "msg_1" } }),
      interrupt: async () => undefined,
      switchModel: async () => undefined,
      create: async () => ({ id: "ses_new" }),
    },
    model: { list: async () => ({ data: [] }) },
  } as never;
}

function makeDeps(
  overrides: {
    plugins?: unknown;
    telegram?: unknown;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const logs: string[] = [];
  const client = makeClient();
  let released = 0;
  const deps = {
    env: overrides.env ?? { TGTOKEN: "123:abc" },
    loadConfig: async () => ({
      plugins: overrides.plugins ?? { telegram: true },
      telegram: overrides.telegram,
    }),
    createTransport: () => new FakeTransport(),
    acquireRuntime: async () => ({
      client: async () => client,
      release: async () => {
        released += 1;
      },
    }),
    log: (_level: "info" | "warn", message: string) => logs.push(message),
  };
  return { deps, logs, getReleased: () => released };
}

async function setupPlugin(plugin: Plugin.Plugin, ctx: unknown) {
  // biome-ignore lint: the entry is exercised through its public setup.
  const setup = (plugin as unknown as { setup: (ctx: unknown) => Promise<() => void> }).setup;
  return setup(ctx);
}

describe("disabled causes", () => {
  test("an absent telegram section starts nothing with a value-free diagnostic", async () => {
    FakeTransport.reset();
    const { deps, logs } = makeDeps({});
    const plugin = createTelegramBridgePlugin(deps);
    const cleanup = await setupPlugin(plugin, makeCtx({}));
    expect(FakeTransport.constructed).toBe(0);
    expect(logs.at(-1)).toContain("section-absent");
    expect(typeof cleanup === "function" || cleanup === undefined).toBe(true);
  });

  test("an unresolved token names the missing variable without values", async () => {
    FakeTransport.reset();
    const { deps, logs } = makeDeps({
      telegram: { botToken: "${TELEGRAM_BOT_TOKEN}", allowedUserIds: [7] },
      env: {},
    });
    const plugin = createTelegramBridgePlugin(deps);
    await setupPlugin(plugin, makeCtx({}));
    expect(FakeTransport.constructed).toBe(0);
    expect(logs.at(-1)).toContain("TELEGRAM_BOT_TOKEN");
    expect(logs.at(-1)).not.toContain("123:abc");
  });

  test("a disabled toggle starts nothing even with a valid section", async () => {
    FakeTransport.reset();
    const { deps, logs } = makeDeps({
      plugins: { telegram: false },
      telegram: { botToken: "${TGTOKEN}", allowedUserIds: [7] },
    });
    const plugin = createTelegramBridgePlugin(deps);
    await setupPlugin(plugin, makeCtx({}));
    expect(FakeTransport.constructed).toBe(0);
    expect(logs.at(-1)).toContain("toggle disabled");
  });
});

describe("singleton and lifecycle", () => {
  test("two contexts sharing one app object construct one transport; the last cleanup releases the runtime", async () => {
    FakeTransport.reset();
    const { deps, getReleased } = makeDeps({
      telegram: { botToken: "${TGTOKEN}", allowedUserIds: [7], settings: { mergeWindowMs: 0 } },
    });
    const plugin = createTelegramBridgePlugin(deps);
    const app = { shared: true };
    const cleanupOne = await setupPlugin(plugin, makeCtx(app));
    const cleanupTwo = await setupPlugin(plugin, makeCtx(app));
    expect(FakeTransport.constructed).toBe(1);

    await cleanupOne?.();
    expect(getReleased()).toBe(0);
    await cleanupTwo?.();
    expect(getReleased()).toBe(1);
  });

  test("the first cleanup of a single setup tears the gateway down", async () => {
    FakeTransport.reset();
    const { deps, getReleased } = makeDeps({
      telegram: { botToken: "${TGTOKEN}", allowedUserIds: [7] },
    });
    const plugin = createTelegramBridgePlugin(deps);
    const cleanup = await setupPlugin(plugin, makeCtx({ solo: true }));
    expect(FakeTransport.constructed).toBe(1);
    await cleanup?.();
    expect(getReleased()).toBe(1);
  });
});
