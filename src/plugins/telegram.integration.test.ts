// FILE: src/plugins/telegram.integration.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Drive the assembled TelegramBridgePlugin through its public entry end to end: session creation through the General project picker, prompting and streaming in the session topic, a manual permission round trip, restart persistence without a second General topic, and toggle-disabled no-registration.
//   SCOPE: One fake plugin context with controllable event stream and poll transport carrying the whole flow across a simulated restart; injected native surfaces record every admitted action; no network, real token, or live model dependency.
//   DEPENDS: [src/plugins/telegram/index.ts, src/plugins/telegram/gateway.ts]
//   LINKS: [M-PLUGIN-TELEGRAM-BRIDGE, V-M-PLUGIN-TELEGRAM-BRIDGE]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   FakeStorage - In-memory plugin storage shared across the simulated restart.
//   WorldTransport - Recording transport with a controllable getUpdates queue.
//   WorldEventStream - Controllable async-iterable native event stream.
//   makeWorld - Assemble one shared context, native surfaces, and injectable deps.
//   start - Start the assembled plugin against the world and return its cleanup.
//   waitFor - Poll a predicate until it holds; load-tolerant settling.
//   WorldSent - One recorded send with its optional inline markup.
//   msg - Build an owner text update in a topic.
//   cbk - Build an owner callback query in a topic.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-TELEGRAM-BRIDGE-PLUGIN T-008 - Added the end-to-end integration coverage: create-through-picker, prompt streaming, permission round trip, restart persistence, and disabled-toggle registration.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { createTelegramBridgePlugin, type NativeClientLike } from "./telegram/index.js";
import { OFFSET_KEY } from "./telegram/gateway.js";
import type {
  TelegramCallbackQuery,
  TelegramTransport,
  TelegramUpdate,
} from "./telegram/bot-api.js";
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

interface WorldSent {
  threadId: number;
  text: string;
  markup?: readonly (readonly { text: string; callbackData: string }[])[];
}

class WorldTransport implements TelegramTransport {
  nextThreadId = 100;
  nextMessageId = 10;
  readonly createdTopics: string[] = [];
  readonly sent: WorldSent[] = [];
  readonly edits: Array<{ messageId: number; text: string }> = [];
  readonly downloads = new Map<string, Uint8Array>();
  readonly rich: Array<{ threadId: number; markdown: string }> = [];
  commandsRegistered = 0;
  private queue: TelegramUpdate[] = [];
  private waiters: Array<() => void> = [];
  private signal: AbortSignal | undefined;

  push(update: TelegramUpdate): void {
    this.queue.push(update);
    for (const wake of this.waiters.splice(0)) wake();
  }

  private async wait(): Promise<void> {
    if (this.queue.length > 0 || this.signal?.aborted) return;
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  async createForumTopic(name: string) {
    this.createdTopics.push(name);
    return { threadId: this.nextThreadId++ };
  }
  async editForumTopic(): Promise<void> {}
  async deleteForumTopic(): Promise<void> {}
  async sendMessage(input: { threadId: number; text: string; replyMarkup?: WorldSent["markup"] }) {
    this.sent.push({ threadId: input.threadId, text: input.text, markup: input.replyMarkup });
    return { messageId: this.nextMessageId++ };
  }
  async sendRich(input: { threadId: number; markdown: string }) {
    this.rich.push({ threadId: input.threadId, markdown: input.markdown });
    return { messageId: this.nextMessageId++ };
  }

  async sendDocument() {
    return { messageId: this.nextMessageId++ };
  }
  async editMessageText(input: { messageId: number; text: string }) {
    this.edits.push({ messageId: input.messageId, text: input.text });
  }
  async deleteMessage(): Promise<void> {}
  async sendDraft(): Promise<void> {}
  async answerCallback(): Promise<void> {}
  async setMyCommands(): Promise<void> {
    this.commandsRegistered += 1;
  }
  async downloadFile(fileId: string) {
    const bytes = this.downloads.get(fileId);
    if (bytes === undefined) throw new Error("too large");
    return bytes;
  }
  async getUpdates(input: { offset: number | null }, signal: AbortSignal) {
    this.signal = signal;
    void input;
    const wake = () => {
      for (const waiter of this.waiters.splice(0)) waiter();
    };
    signal.addEventListener("abort", wake, { once: true });
    try {
      await this.wait();
    } finally {
      signal.removeEventListener("abort", wake);
    }
    return this.queue.splice(0);
  }
}

class WorldEventStream {
  private queue: unknown[] = [];
  private closed = false;
  private abortSignal: AbortSignal | undefined;
  readonly handlers = new Array<() => void>();

  push(event: unknown): void {
    this.queue.push(event);
    for (const wake of this.handlers.splice(0)) wake();
  }

  close(): void {
    this.closed = true;
    for (const wake of this.handlers.splice(0)) wake();
  }

  subscribe(signal?: AbortSignal): AsyncIterable<unknown> {
    this.abortSignal = signal;
    signal?.addEventListener(
      "abort",
      () => {
        this.closed = true;
        for (const wake of this.handlers.splice(0)) wake();
      },
      { once: true },
    );
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<unknown> => ({
        next: async (): Promise<IteratorResult<unknown>> => {
          while (this.queue.length === 0 && !this.closed) {
            await new Promise<void>((resolve) => this.handlers.push(resolve));
          }
          const value = this.queue.shift();
          if (value === undefined) return { done: true, value: undefined };
          return { done: false, value };
        },
      }),
    };
  }
}

function makeWorld() {
  const storage = new FakeStorage();
  const transport = new WorldTransport();
  const events = new WorldEventStream();
  const prompts: Array<{
    sessionID: string;
    text: string;
    files?: { uri: string; name?: string }[];
  }> = [];
  const permissionReplies: Array<{ requestID: string; reply: string }> = [];
  const createdSessions: string[] = [];
  const client: NativeClientLike = {
    session: {
      list: async () => ({
        data: createdSessions.map((id, index) => ({
          id,
          title: `t-${id}`,
          time: { created: 900_000, updated: Date.now() + index },
          parentID: undefined,
        })),
      }),
      active: async () => ({}),
      fork: async () => ({ id: "ses_fork_1" }),
      form: { list: async () => ({ data: [] }), reply: async () => undefined },
      revert: { stage: async () => ({}), commit: async () => undefined },
    },
    message: { list: async () => ({ data: [] }) },
    project: {
      list: async () => ({ data: [{ id: "p1", directory: "/home/al/dev/vv-opencode" }] }),
    },
    permission: {
      list: async () => ({ data: [] }),
      reply: async (input: unknown) => {
        const record = input as { requestID: string; reply: string };
        permissionReplies.push({ requestID: record.requestID, reply: record.reply });
      },
    },
  };
  const ctx = {
    app: { world: true },
    location: { directory: "/home/al/dev/vv-opencode" },
    storage,
    event: { subscribe: (options?: { signal?: AbortSignal }) => events.subscribe(options?.signal) },
    session: {
      prompt: async (input: {
        sessionID: string;
        text: string;
        files?: { uri: string; name?: string }[];
      }) => {
        prompts.push({ sessionID: input.sessionID, text: input.text, files: input.files });
        return { info: { id: `msg_${prompts.length}` } };
      },
      interrupt: async () => undefined,
      switchModel: async () => undefined,
      create: async (input?: { location?: { directory: string } }) => {
        const id = `ses_${createdSessions.length + 1}`;
        createdSessions.push(id);
        void input;
        return { id };
      },
    },
    model: {
      list: async () => ({ data: [{ providerID: "openai", id: "gpt-x" }] }),
    },
  };
  let released = 0;
  const deps = {
    env: { TGTOKEN: "123:integration" },
    loadConfig: async (): Promise<{ plugins?: unknown; telegram?: unknown }> => ({
      plugins: { telegram: true },
      telegram: {
        botToken: "${TGTOKEN}",
        allowedUserIds: [42],
        settings: { mergeWindowMs: 0 },
      },
    }),
    createTransport: () => transport,
    acquireRuntime: async () => ({
      client: async () => client,
      release: async () => {
        released += 1;
      },
    }),
    log: () => undefined,
  };
  return {
    storage,
    transport,
    events,
    prompts,
    permissionReplies,
    createdSessions,
    ctx,
    deps,
    getReleased: () => released,
  };
}

async function start(world: ReturnType<typeof makeWorld>) {
  const plugin: Plugin.Plugin = createTelegramBridgePlugin(world.deps);
  const setup = (plugin as unknown as { setup: (ctx: unknown) => Promise<() => Promise<void>> })
    .setup;
  const cleanup = await setup(world.ctx);
  return { cleanup };
}

/** Poll a predicate until it holds or the deadline passes; load-tolerant settling. */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function msg(updateId: number, threadId: number, text: string): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      from: { id: 42 },
      chat: { id: 42 },
      date: Math.floor(Date.now() / 1000),
      message_thread_id: threadId,
      text,
    },
  };
}

function cbk(updateId: number, threadId: number, data: string): TelegramUpdate {
  const query: TelegramCallbackQuery = {
    id: `cq-${updateId}`,
    from: { id: 42 },
    message: { message_id: 1, chat: { id: 42 }, message_thread_id: threadId },
    data,
  };
  return { update_id: updateId, callback_query: query };
}

describe("telegram bridge integration", () => {
  test("create-through-picker, prompt, permission round trip, and restart persistence", async () => {
    const world = makeWorld();
    const { cleanup } = await start(world);
    await waitFor(() => world.transport.commandsRegistered === 1);

    expect(world.transport.createdTopics).toEqual(["General"]);
    const general = 100;

    world.transport.push(msg(1, general, "/new"));
    await waitFor(() =>
      world.transport.sent.some((entry) => entry.markup?.[0]?.[0]?.text === "vv-opencode"),
    );

    world.transport.push(cbk(2, general, "vvocnp:0"));
    await waitFor(() => world.createdSessions.length === 1);
    expect(world.createdSessions).toEqual(["ses_1"]);
    const sessionTopic = 101;
    expect(world.transport.createdTopics).toHaveLength(2);

    world.transport.push(msg(3, sessionTopic, "make it so"));
    await waitFor(() => world.prompts.length === 1);
    expect(world.prompts[0]?.sessionID).toBe("ses_1");
    expect(world.prompts[0]?.text).toBe("make it so");

    world.events.push({
      type: "permission.asked",
      data: { sessionID: "ses_1", id: "pr_int", action: "bash make test", resources: [] },
    });
    await waitFor(() =>
      world.transport.sent.some((entry) => entry.text.includes("bash make test")),
    );
    const prompt = world.transport.sent.find((entry) => entry.text.includes("bash make test"));
    expect(prompt?.markup?.[0]?.map((button) => button.callbackData)).toEqual([
      "vvocp:pr_int:once",
      "vvocp:pr_int:always",
      "vvocp:pr_int:reject",
    ]);

    world.transport.push(cbk(4, sessionTopic, "vvocp:pr_int:once"));
    await waitFor(() => world.permissionReplies.length === 1);
    expect(world.permissionReplies).toEqual([{ requestID: "pr_int", reply: "once" }]);

    expect(await world.storage.get(OFFSET_KEY)).toBe(4);

    await cleanup();
    world.events.close();

    // Simulated restart: same storage, same token, fresh plugin instance.
    const second = await start(world);
    await waitFor(() => world.transport.commandsRegistered === 2);
    expect(world.transport.createdTopics.filter((name) => name === "General")).toHaveLength(1);
    expect(world.transport.createdTopics).toHaveLength(2);
    await second.cleanup();
    world.events.close();
  });

  test("a disabled toggle registers nothing and starts no transport", async () => {
    const world = makeWorld();
    let transportCreated = 0;
    world.deps.createTransport = () => {
      transportCreated += 1;
      return world.transport;
    };
    world.deps.loadConfig = async (): Promise<{ plugins?: unknown; telegram?: unknown }> => ({
      plugins: { telegram: false },
    });
    const plugin: Plugin.Plugin = createTelegramBridgePlugin(world.deps);
    const setup = (plugin as unknown as { setup: (ctx: unknown) => Promise<() => void> }).setup;
    await setup(world.ctx);
    expect(transportCreated).toBe(0);
    expect(world.transport.createdTopics).toHaveLength(0);
  });
});
