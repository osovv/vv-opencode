// FILE: src/plugins/telegram/gateway.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the polling gateway: persisted offset advancement after dispatch, owner allowlist, stale-update dropping, album grouping, and bounded error backoff with recovery.
//   SCOPE: Pure grouper and staleness predicates plus a scriptable poll transport driving the live loop with injected sleep; no network dependency.
//   DEPENDS: [src/plugins/telegram/gateway.ts]
//   LINKS: [M-TELEGRAM-GATEWAY, V-M-TELEGRAM-GATEWAY]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   FakeStore - In-memory durable store.
//   PollTransport - Scriptable getUpdates transport with abort-aware waiting and recorded requests.
//   makeGateway - Assemble a gateway over injectable fakes.
//   photoUpdate - Build a photo update carrying a media group id.
//   textUpdate - Build a text message update.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-TELEGRAM-BRIDGE-PLUGIN T-008 - Covered offset persistence, owner filtering, stale dropping, album grouping, and backoff recovery.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import {
  groupAlbums,
  isStaleUpdate,
  OFFSET_KEY,
  TelegramGateway,
  type TelegramOwnerMessage,
} from "./gateway.js";
import type { TelegramTransport, TelegramUpdate } from "./bot-api.js";
import type { TelegramStore } from "./topology.js";

class FakeStore implements TelegramStore {
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
  async scan(prefix: string) {
    return [...this.map.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value: structuredClone(value) }));
  }
}

/** Scriptable getUpdates transport with abort-aware waiting and recorded requests. */
class PollTransport implements TelegramTransport {
  readonly queue: TelegramUpdate[][] = [];
  readonly offsets: Array<number | null> = [];
  failNext = false;
  #waiters: Array<() => void> = [];
  #aborted = false;

  pushBatch(updates: TelegramUpdate[]): void {
    this.queue.push(updates);
    for (const wake of this.#waiters.splice(0)) wake();
  }

  abort(): void {
    this.#aborted = true;
    for (const wake of this.#waiters.splice(0)) wake();
  }

  async createForumTopic(): Promise<{ threadId: number }> {
    throw new Error("unused");
  }
  async editForumTopic(): Promise<void> {}
  async deleteForumTopic(): Promise<void> {}
  async sendMessage(): Promise<{ messageId: number }> {
    return { messageId: 1 };
  }
  async sendRich(): Promise<{ messageId: number }> {
    return { messageId: 3 };
  }
  async sendDocument(): Promise<{ messageId: number }> {
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
  async getUpdates(
    input: { offset: number | null },
    signal: AbortSignal,
  ): Promise<readonly TelegramUpdate[]> {
    this.offsets.push(input.offset);
    if (this.failNext) {
      this.failNext = false;
      throw new Error("transient network failure");
    }
    const wake = () => {
      for (const waiter of this.#waiters.splice(0)) waiter();
    };
    signal.addEventListener("abort", wake, { once: true });
    try {
      while (this.queue.length === 0 && !signal.aborted && !this.#aborted) {
        await new Promise<void>((resolve) => this.#waiters.push(resolve));
      }
    } finally {
      signal.removeEventListener("abort", wake);
    }
    return this.queue.shift() ?? [];
  }
}

function textUpdate(
  updateId: number,
  fromId: number,
  threadId: number,
  text: string,
  date?: number,
): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      from: { id: fromId },
      chat: { id: fromId },
      date,
      message_thread_id: threadId,
      text,
    },
  };
}

function photoUpdate(
  updateId: number,
  fromId: number,
  threadId: number,
  group: string,
): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      from: { id: fromId },
      chat: { id: fromId },
      date: Math.floor(Date.now() / 1000),
      message_thread_id: threadId,
      photo: [{ file_id: `f${updateId}`, width: 1, height: 1 }],
      media_group_id: group,
      caption: undefined,
    },
  };
}

function makeGateway(
  transport: PollTransport,
  store: FakeStore,
  dispatched: TelegramOwnerMessage[],
  sleeps: number[],
  ownerIds: readonly number[] = [7],
) {
  return new TelegramGateway({
    transport,
    store,
    ownerIds,
    dispatch: {
      handleMessage: async (input) => {
        dispatched.push(input);
      },
      handleCallback: async () => {},
    },
    clock: { now: () => Date.now() },
    log: () => undefined,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
}

describe("pure predicates", () => {
  test("groupAlbums merges consecutive photos of one group and keeps others intact", () => {
    const entries = groupAlbums([
      photoUpdate(1, 7, 5, "a"),
      photoUpdate(2, 7, 5, "a"),
      textUpdate(3, 7, 5, "hi"),
      photoUpdate(4, 7, 5, "b"),
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual(["album", "message", "album"]);
    expect(entries[0]?.album).toHaveLength(2);
    expect(entries[2]?.album).toHaveLength(1);
  });

  test("isStaleUpdate drops messages older than the grace window", () => {
    const now = 10_000_000;
    const fresh = { date: Math.floor(now / 1000) - 10 } as never;
    const old = { date: Math.floor(now / 1000) - 3600 } as never;
    expect(isStaleUpdate(fresh, now)).toBe(false);
    expect(isStaleUpdate(old, now)).toBe(true);
    expect(isStaleUpdate({} as never, now)).toBe(false);
  });
});

describe("gateway loop", () => {
  test("dispatches owner messages, persists the offset after each update, and resumes from it", async () => {
    const transport = new PollTransport();
    const store = new FakeStore();
    const dispatched: TelegramOwnerMessage[] = [];
    const gateway = makeGateway(transport, store, dispatched, []);
    const run = gateway.start();

    transport.pushBatch([textUpdate(11, 7, 3, "one"), textUpdate(12, 7, 3, "two")]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dispatched.map((entry) => entry.text)).toEqual(["one", "two"]);
    expect(await store.get(OFFSET_KEY)).toBe(12);
    expect(transport.offsets.at(-1)).toBe(13);

    await gateway.stop();
    transport.abort();
    await run.catch(() => undefined);
  });

  test("drops non-owner and stale updates while still acknowledging them", async () => {
    const transport = new PollTransport();
    const store = new FakeStore();
    const dispatched: TelegramOwnerMessage[] = [];
    const logs: string[] = [];
    const gateway = new TelegramGateway({
      transport,
      store,
      ownerIds: [7],
      dispatch: {
        handleMessage: async (input) => {
          dispatched.push(input);
        },
        handleCallback: async () => {},
      },
      clock: { now: () => 10_000_000 },
      log: (_level, message) => logs.push(message),
      sleep: async () => {},
    });
    const run = gateway.start();
    const staleDate = Math.floor(10_000_000 / 1000) - 3600;
    transport.pushBatch([
      textUpdate(21, 99, 3, "intruder"),
      textUpdate(22, 7, 3, "old", staleDate),
      textUpdate(23, 7, 3, "fresh"),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dispatched.map((entry) => entry.text)).toEqual(["fresh"]);
    expect(await store.get(OFFSET_KEY)).toBe(23);
    expect(logs.some((line) => line.includes("non-owner"))).toBe(true);
    expect(logs.some((line) => line.includes("stale"))).toBe(true);

    await gateway.stop();
    transport.abort();
    await run.catch(() => undefined);
  });

  test("an album arrives as one dispatch with all attachments", async () => {
    const transport = new PollTransport();
    const store = new FakeStore();
    const dispatched: TelegramOwnerMessage[] = [];
    const gateway = makeGateway(transport, store, dispatched, []);
    const run = gateway.start();

    transport.pushBatch([photoUpdate(31, 7, 4, "g1"), photoUpdate(32, 7, 4, "g1")]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.attachments.map((file) => file.fileId)).toEqual(["f31", "f32"]);
    expect(await store.get(OFFSET_KEY)).toBe(32);

    await gateway.stop();
    transport.abort();
    await run.catch(() => undefined);
  });

  test("a transient poll failure backs off once and recovers", async () => {
    const transport = new PollTransport();
    const store = new FakeStore();
    const dispatched: TelegramOwnerMessage[] = [];
    const sleeps: number[] = [];
    const gateway = makeGateway(transport, store, dispatched, sleeps);
    const run = gateway.start();

    transport.failNext = true;
    transport.pushBatch([textUpdate(41, 7, 3, "after failure")]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sleeps.length).toBeGreaterThanOrEqual(1);
    expect(dispatched.map((entry) => entry.text)).toEqual(["after failure"]);

    await gateway.stop();
    transport.abort();
    await run.catch(() => undefined);
  });

  test("dispatch failures are contained and the offset still advances", async () => {
    const transport = new PollTransport();
    const store = new FakeStore();
    let calls = 0;
    const gateway = new TelegramGateway({
      transport,
      store,
      ownerIds: [7],
      dispatch: {
        handleMessage: async () => {
          calls += 1;
          if (calls === 1) throw new Error("handler boom");
        },
        handleCallback: async () => {},
      },
      clock: { now: () => Date.now() },
      log: () => undefined,
      sleep: async () => {},
    });
    const run = gateway.start();
    transport.pushBatch([textUpdate(51, 7, 3, "boom"), textUpdate(52, 7, 3, "ok")]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(2);
    expect(await store.get(OFFSET_KEY)).toBe(52);

    await gateway.stop();
    transport.abort();
    await run.catch(() => undefined);
  });
});
