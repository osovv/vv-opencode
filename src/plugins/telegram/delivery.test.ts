// FILE: src/plugins/telegram/delivery.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the delivery layer: draft streaming and edit fallback, durable exactly-once finals with boot-drain, mirror dedupe, the adaptive throttle, merge-window coalescing, persisted settings, code-as-file rendering, and failure containment.
//   SCOPE: Fake transport, store, and clock driving streaming turns, final delivery, restart reload, outbox drain with and without mirrors, send failures with one bounded notice, pure splitting, throttle, and quote helpers; no network dependency.
//   DEPENDS: [src/plugins/telegram/delivery.ts, src/plugins/telegram/config.ts]
//   LINKS: [M-TELEGRAM-DELIVERY, V-M-TELEGRAM-DELIVERY]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   FakeStore - In-memory durable store with prefix scan.
//   FakeTransport - Recording transport with scriptable failures.
//   Clock - Mutable injected clock.
//   DEFAULTS - Fixed delivery settings for tests.
//   makeDelivery - Assemble delivery over injectable fakes.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-TELEGRAM-BRIDGE-PLUGIN T-004 - Covered draft and edit-fallback streaming, exactly-once finals across restart with pending drain, mirror dedupe, adaptive throttle, merge window, settings persistence, code-as-file, and failure containment.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import {
  formatUserQuote,
  nextStreamDelayMs,
  OUTBOX_KEY,
  splitFinal,
  TelegramDelivery,
  TelegramInputMerger,
} from "./delivery.js";
import type { TelegramStore } from "./topology.js";
import { TelegramUnsupportedError, type TelegramTransport as Transport } from "./bot-api.js";
import { DEFAULT_TELEGRAM_SETTINGS } from "./config.js";

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

class FakeTransport implements Transport {
  nextMessageId = 10;
  readonly sent: Array<{ threadId: number; text: string; messageId: number }> = [];
  readonly edits: Array<{ messageId: number; text: string }> = [];
  readonly drafts: Array<{ threadId: number; draftId: number; text: string }> = [];
  readonly documents: Array<{ threadId: number; filename: string }> = [];
  readonly deleted: number[] = [];
  draftsSupported = true;
  failSends = false;

  async createForumTopic(): Promise<{ threadId: number }> {
    throw new Error("unused");
  }
  async editForumTopic(): Promise<void> {}
  async deleteForumTopic(): Promise<void> {}
  async sendMessage(input: { threadId: number; text: string }) {
    if (this.failSends) throw new Error("send failed");
    const messageId = this.nextMessageId++;
    this.sent.push({ threadId: input.threadId, text: input.text, messageId });
    return { messageId };
  }
  async sendRich(input: { threadId: number; markdown: string }) {
    if (this.failSends) throw new Error("send failed");
    const messageId = this.nextMessageId++;
    this.sent.push({ threadId: input.threadId, text: input.markdown, messageId });
    return { messageId };
  }
  async sendDocument(input: {
    threadId: number;
    filename: string;
  }): Promise<{ messageId: number }> {
    if (this.failSends) throw new Error("send failed");
    this.documents.push({ threadId: input.threadId, filename: input.filename });
    return { messageId: this.nextMessageId++ };
  }
  async editMessageText(_input: { messageId: number; text: string }): Promise<void> {
    this.edits.push({ messageId: _input.messageId, text: _input.text });
  }
  async deleteMessage(messageId: number): Promise<void> {
    this.deleted.push(messageId);
  }
  async sendDraft(input: { threadId: number; draftId: number; text: string }) {
    if (!this.draftsSupported) {
      throw new TelegramUnsupportedError("sendMessageDraft");
    }
    this.drafts.push({ threadId: input.threadId, draftId: input.draftId, text: input.text });
  }
  async answerCallback(): Promise<void> {}
  async setMyCommands(): Promise<void> {}
  async downloadFile(): Promise<Uint8Array> {
    return new Uint8Array();
  }
  async getUpdates(): Promise<never[]> {
    return [];
  }
}

class Clock {
  #now = 1_000_000;
  now(): number {
    return this.#now;
  }
  advance(ms: number): void {
    this.#now += ms;
  }
}

const DEFAULTS = { ...DEFAULT_TELEGRAM_SETTINGS };

function makeDelivery(
  transport: FakeTransport,
  store: FakeStore,
  clock: Clock,
  notices: string[] = [],
) {
  const delivery = new TelegramDelivery({
    transport,
    store,
    clock,
    defaults: { ...DEFAULTS },
    onNotice: (_threadId, text) => notices.push(text),
  });
  return delivery;
}

describe("pure helpers", () => {
  test("splitFinal keeps small fences and extracts oversized code into files", () => {
    const small = splitFinal("before\n```ts\nconst a = 1;\n```\nafter", 100);
    expect(small.files).toHaveLength(0);
    expect(small.text).toContain("const a = 1;");

    const bigCode = "x".repeat(5 * 1024);
    const big = splitFinal(`intro\n\`\`\`python\n${bigCode}\n\`\`\`\noutro`, 4);
    expect(big.files).toHaveLength(1);
    expect(big.files[0]?.filename).toBe("code-1.python");
    expect(big.text).toContain("[code attached as code-1.python]");
    expect(big.text).not.toContain(bigCode);
  });

  test("nextStreamDelayMs slows over the turn lifetime", () => {
    expect(nextStreamDelayMs(1_000)).toBe(1_000);
    expect(nextStreamDelayMs(90_000)).toBe(2_000);
    expect(nextStreamDelayMs(300_000)).toBe(5_000);
    expect(nextStreamDelayMs(700_000)).toBe(10_000);
  });

  test("formatUserQuote marks voice and plain quotes", () => {
    expect(formatUserQuote("fix it", false)).toBe("👤 fix it");
    expect(formatUserQuote("note", true)).toBe("🎙 note");
    expect(formatUserQuote("", false)).toBe("👤 (empty)");
  });
});

describe("merge window", () => {
  test("joins texts collected within a fixed window opened on the first text", () => {
    const merger = new TelegramInputMerger(1_500);
    expect(merger.due(0)).toBe(false);
    merger.add("part one", 1_000);
    merger.add("part two", 2_400);
    expect(merger.due(2_499)).toBe(false);
    expect(merger.take(2_499)).toBeNull();
    expect(merger.take(2_500)).toBe("part one\npart two");
    expect(merger.flush()).toBeNull();
  });

  test("flush forces the join regardless of the window", () => {
    const merger = new TelegramInputMerger(60_000);
    merger.add("a", 1);
    merger.add("b", 2);
    expect(merger.flush()).toBe("a\nb");
  });
});

describe("settings persistence", () => {
  test("defaults seed on first run and patches survive a restart", async () => {
    const transport = new FakeTransport();
    const store = new FakeStore();
    const clock = new Clock();
    const first = makeDelivery(transport, store, clock);
    await first.initialize();
    expect(first.settings).toEqual({ ...DEFAULTS });

    await first.updateSettings({ showReasoning: false, formatMode: "raw" });
    const second = makeDelivery(new FakeTransport(), store, clock);
    await second.initialize();
    expect(second.settings.showReasoning).toBe(false);
    expect(second.settings.formatMode).toBe("raw");
    expect(second.settings.showToolCalls).toBe(true);
  });
});

describe("finals", () => {
  test("deliver exactly once per native message id and mirror the result", async () => {
    const transport = new FakeTransport();
    const store = new FakeStore();
    const clock = new Clock();
    const delivery = makeDelivery(transport, store, clock);
    await delivery.initialize();

    const first = await delivery.deliverFinal({
      threadId: 7,
      nativeMessageId: "msg_a",
      text: "answer",
    });
    expect(first.delivered).toBe(true);
    expect(first.tgMessageId).toBe(10);

    const second = await delivery.deliverFinal({
      threadId: 7,
      nativeMessageId: "msg_a",
      text: "answer",
    });
    expect(second.delivered).toBe(false);
    expect(second.tgMessageId).toBe(10);
    expect(transport.sent).toHaveLength(1);
    expect(((await store.get(OUTBOX_KEY)) as unknown[]).length ?? 0).toBe(0);
  });

  test("markdown finals deliver through the native rich send, raw finals stay plain", async () => {
    const transport = new FakeTransport();
    const store = new FakeStore();
    const clock = new Clock();
    const delivery = makeDelivery(transport, store, clock);
    await delivery.initialize();

    const rich = await delivery.deliverFinal({
      threadId: 6,
      nativeMessageId: "msg_rich",
      text: "## Heading\n\n**bold**",
    });
    expect(rich.delivered).toBe(true);
    // The rich send records into the same sent log with the markdown payload.
    expect(transport.sent).toEqual([
      { threadId: 6, text: "## Heading\n\n**bold**", messageId: 10 },
    ]);

    await delivery.updateSettings({ formatMode: "raw" });
    const plain = await delivery.deliverFinal({
      threadId: 6,
      nativeMessageId: "msg_plain",
      text: "plain text",
    });
    expect(plain.delivered).toBe(true);
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent.at(-1)?.text).toBe("plain text");
  });

  test("a failed send keeps the record pending with one notice and a later drain delivers it", async () => {
    const transport = new FakeTransport();
    const store = new FakeStore();
    const clock = new Clock();
    const notices: string[] = [];
    const delivery = makeDelivery(transport, store, clock, notices);
    await delivery.initialize();

    transport.failSends = true;
    const failed = await delivery.deliverFinal({
      threadId: 3,
      nativeMessageId: "msg_b",
      text: "reply",
    });
    expect(failed.delivered).toBe(false);
    expect(notices).toHaveLength(1);
    const pending = (await store.get(OUTBOX_KEY)) as unknown[];
    expect(pending).toHaveLength(1);

    transport.failSends = false;
    const drained = await delivery.drainPendingFinals();
    expect(drained.delivered).toBe(1);
    expect(transport.sent).toHaveLength(1);
    expect(((await store.get(OUTBOX_KEY)) as unknown[]).length ?? 0).toBe(0);
  });

  test("boot drain skips records whose mirrors already exist", async () => {
    const transport = new FakeTransport();
    const store = new FakeStore();
    const clock = new Clock();
    const first = makeDelivery(transport, store, clock);
    await first.initialize();
    await first.deliverFinal({ threadId: 5, nativeMessageId: "msg_c", text: "done" });
    expect(transport.sent).toHaveLength(1);

    // Simulate a crash before the outbox removal: restore one pending record.
    await store.set(OUTBOX_KEY, [
      { id: "recovered-1", threadId: 5, nativeMessageId: "msg_c", text: "done", attempts: 0 },
    ]);
    const second = makeDelivery(transport, store, clock);
    await second.initialize();
    const drained = await second.drainPendingFinals();
    expect(drained.skipped).toBe(1);
    expect(drained.delivered).toBe(0);
    expect(transport.sent).toHaveLength(1);
  });

  test("code blocks over the configured cap are delivered as documents", async () => {
    const transport = new FakeTransport();
    const store = new FakeStore();
    const clock = new Clock();
    const delivery = makeDelivery(transport, store, clock);
    await delivery.initialize();
    await delivery.updateSettings({ codeFileMaxKb: 1 });

    const big = "y".repeat(2 * 1024);
    const result = await delivery.deliverFinal({
      threadId: 9,
      nativeMessageId: "msg_d",
      text: `summary\n\`\`\`ts\n${big}\n\`\`\``,
    });
    expect(result.delivered).toBe(true);
    expect(transport.documents.map((doc) => doc.filename)).toEqual(["code-1.ts"]);
    expect(transport.sent[0]?.text).toContain("code-1.ts");
  });
});

describe("streaming", () => {
  test("draft streaming uses one stable draft id and throttles by the adaptive schedule", async () => {
    const transport = new FakeTransport();
    const store = new FakeStore();
    const clock = new Clock();
    const delivery = makeDelivery(transport, store, clock);
    await delivery.initialize();

    delivery.beginTurn({ threadId: 2, draftId: 777 });
    expect(await delivery.streamText(2, "part")).toBe(true);
    expect(await delivery.streamText(2, "part more")).toBe(false);
    clock.advance(1_100);
    expect(await delivery.streamText(2, "part more")).toBe(true);
    expect(transport.drafts).toHaveLength(2);
    expect(new Set(transport.drafts.map((draft) => draft.draftId))).toEqual(new Set([777]));
    await delivery.endTurn(2);
    expect(transport.deleted).toHaveLength(0);
  });

  test("unsupported drafts fall back to a placeholder plus throttled edits, removed at turn end", async () => {
    const transport = new FakeTransport();
    transport.draftsSupported = false;
    const store = new FakeStore();
    const clock = new Clock();
    const delivery = makeDelivery(transport, store, clock);
    await delivery.initialize();

    delivery.beginTurn({ threadId: 4, draftId: 12 });
    expect(await delivery.streamText(4, "alpha")).toBe(true);
    expect(transport.sent).toHaveLength(1);
    expect(await delivery.streamText(4, "beta")).toBe(false);
    clock.advance(1_100);
    expect(await delivery.streamText(4, "beta")).toBe(true);
    expect(transport.edits).toHaveLength(1);
    await delivery.endTurn(4);
    expect(transport.deleted).toEqual([transport.sent[0]?.messageId]);
  });

  test("streaming an unknown turn is a no-op", async () => {
    const delivery = makeDelivery(new FakeTransport(), new FakeStore(), new Clock());
    await delivery.initialize();
    expect(await delivery.streamText(99, "x")).toBe(false);
    await expect(delivery.endTurn(99)).resolves.toBeUndefined();
  });
});

describe("forgetThread", () => {
  test("purges mirrors and outbox records for the deleted topic only", async () => {
    const transport = new FakeTransport();
    const store = new FakeStore();
    const clock = new Clock();
    const delivery = makeDelivery(transport, store, clock);
    await delivery.initialize();

    await delivery.deliverFinal({ threadId: 7, nativeMessageId: "msg_a", text: "one" });
    await delivery.deliverFinal({ threadId: 8, nativeMessageId: "msg_b", text: "two" });
    expect(delivery.mirrorOf("msg_a")).toBeDefined();

    transport.failSends = true;
    await delivery.deliverFinal({ threadId: 7, nativeMessageId: "msg_pending", text: "queued" });

    await delivery.forgetThread(7);

    expect(delivery.mirrorOf("msg_a")).toBeUndefined();
    expect(delivery.mirrorOf("msg_b")).toBeDefined();
    expect([...store.map.keys()].some((key) => key.endsWith("msg_a"))).toBe(false);
    expect([...store.map.keys()].some((key) => key.endsWith("msg_b"))).toBe(true);
    expect(JSON.stringify(store.map.get("telegram/v1/outbox") ?? [])).not.toContain("msg_pending");
  });
});
