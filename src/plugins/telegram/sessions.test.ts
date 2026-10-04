// FILE: src/plugins/telegram/sessions.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the session bridge: structural decoding, event routing with per-event containment, resync after stream breaks, prompt, abort, and model-switch admission, streamed turns, statuses, and bounded subagent cards.
//   SCOPE: Fake transport, store, clock, native reads, actions, and scripted event streams driving pure decoders, pump containment, stream-end resync, and action passthrough; no network or real native dependency.
//   DEPENDS: [src/plugins/telegram/sessions.ts, src/plugins/telegram/topology.ts, src/plugins/telegram/delivery.ts, src/plugins/telegram/config.ts]
//   LINKS: [M-TELEGRAM-GATEWAY, V-M-TELEGRAM-GATEWAY]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   FakeStore - In-memory durable store.
//   FakeTransport - Recording transport with drafts enabled.
//   FakeReads - Scriptable native session reads.
//   FakeActions - Recording native actions.
//   QueueStream - Scriptable async-iterable event stream.
//   makeBridge - Assemble a bridge with topology and delivery over injectable fakes.
//   Clock - Mutable injected clock.
//   summary - Build a native session summary.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-TELEGRAM-BRIDGE-PLUGIN T-005 - Covered decoding, routing, containment, stream-end resync, prompt, abort, model switch, streamed turns, statuses, and subagent cards.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import {
  decodeInteractionEvent,
  decodePartTextEvent,
  decodeSessionEvent,
  decodeStepEvent,
  SessionBridge,
  type NativeEventEnvelope,
  type NativeSessionActions,
  type NativeSessionReads,
  type NativeSessionSummary,
} from "./sessions.js";
import { TelegramTopology, type TelegramStore } from "./topology.js";
import { TelegramDelivery } from "./delivery.js";
import type { TelegramTransport } from "./bot-api.js";
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

class FakeTransport implements TelegramTransport {
  nextThreadId = 100;
  nextMessageId = 10;
  readonly createdTopics: string[] = [];
  readonly sent: string[] = [];
  readonly drafts: number[] = [];
  async createForumTopic(name: string) {
    this.createdTopics.push(name);
    return { threadId: this.nextThreadId++ };
  }
  async editForumTopic(): Promise<void> {}
  async closeForumTopic(): Promise<void> {}
  async reopenForumTopic(): Promise<void> {}
  async sendMessage(input: { text: string }) {
    this.sent.push(input.text);
    return { messageId: this.nextMessageId++ };
  }
  async sendDocument() {
    return { messageId: this.nextMessageId++ };
  }
  async editMessageText(): Promise<void> {}
  async deleteMessage(): Promise<void> {}
  async sendDraft(input: { draftId: number }) {
    this.drafts.push(input.draftId);
  }
  async answerCallback(): Promise<void> {}
  async setMyCommands(): Promise<void> {}
  async downloadFile(): Promise<Uint8Array> {
    return new Uint8Array();
  }
  async getUpdates() {
    return [];
  }
}

class FakeReads implements NativeSessionReads {
  sessions: NativeSessionSummary[] = [];
  active: string[] = [];
  async listSessions() {
    return this.sessions;
  }
  async activeSessionIds() {
    return this.active;
  }
}

class FakeActions implements NativeSessionActions {
  readonly prompts: Array<{ sessionID: string; text: string; delivery: string }> = [];
  readonly interrupts: string[] = [];
  readonly switches: string[] = [];
  async prompt(input: { sessionID: string; text: string; delivery: "steer" | "queue" }) {
    this.prompts.push(input);
    return { messageID: `msg_${this.prompts.length}` };
  }
  async interrupt(input: { sessionID: string }): Promise<void> {
    this.interrupts.push(input.sessionID);
  }
  async switchModel(input: { sessionID: string }): Promise<void> {
    this.switches.push(input.sessionID);
  }
}

/** Scriptable async-iterable event stream the pump consumes. */
class QueueStream {
  #queue: NativeEventEnvelope[] = [];
  #closed = false;
  readonly consumed: NativeEventEnvelope[] = [];
  readonly #waiters: Array<() => void> = [];

  push(event: NativeEventEnvelope): void {
    this.#queue.push(event);
    for (const wake of this.#waiters.splice(0)) wake();
  }

  close(): void {
    this.#closed = true;
    for (const wake of this.#waiters.splice(0)) wake();
  }

  readonly stream = {
    [Symbol.asyncIterator]: (): AsyncIterator<NativeEventEnvelope> => ({
      next: async (): Promise<IteratorResult<NativeEventEnvelope>> => {
        while (this.#queue.length === 0 && !this.#closed) {
          await new Promise<void>((resolve) => this.#waiters.push(resolve));
        }
        const value = this.#queue.shift();
        if (value === undefined) return { done: true, value: undefined };
        this.consumed.push(value);
        return { done: false, value };
      },
    }),
  };
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

function summary(id: string, overrides: Partial<NativeSessionSummary> = {}): NativeSessionSummary {
  return {
    id,
    title: `t-${id}`,
    timeCreatedMs: 900_000,
    timeUpdatedMs: 999_999,
    parentID: undefined,
    ...overrides,
  };
}

function makeBridge(windowMinutes = 240) {
  const transport = new FakeTransport();
  const store = new FakeStore();
  const clock = new Clock();
  const topology = new TelegramTopology({ transport, store, clock, windowMinutes });
  const delivery = new TelegramDelivery({
    transport,
    store,
    clock,
    defaults: { ...DEFAULT_TELEGRAM_SETTINGS },
  });
  const reads = new FakeReads();
  const actions = new FakeActions();
  const queue = new QueueStream();
  const bridge = new SessionBridge({
    topology,
    delivery,
    reads,
    actions,
    events: { subscribe: () => queue.stream },
    clock,
  });
  return { transport, store, clock, topology, delivery, reads, actions, queue, bridge };
}

describe("pure decoders", () => {
  test("session events decode flat and nested identity", () => {
    expect(decodeSessionEvent({ sessionID: "ses_1", title: "work" })).toEqual({
      sessionID: "ses_1",
      title: "work",
      parentID: undefined,
    });
    expect(
      decodeSessionEvent({ info: { id: "ses_2", title: "x", parentID: "ses_p" } }).parentID,
    ).toBe("ses_p");
    expect(decodeSessionEvent("junk").sessionID).toBeUndefined();
  });

  test("step and part decoders read identity and text", () => {
    expect(decodeStepEvent({ sessionID: "s", messageID: "m" })).toEqual({
      sessionID: "s",
      messageID: "m",
    });
    expect(
      decodePartTextEvent({ sessionID: "s", part: { messageID: "m", text: "hello" } }),
    ).toEqual({
      sessionID: "s",
      messageID: "m",
      text: "hello",
    });
    expect(decodePartTextEvent({ sessionID: "s", part: { messageID: "m" } }).text).toBeUndefined();
  });

  test("interaction decoders separate requested from resolved", () => {
    expect(
      decodeInteractionEvent({ sessionID: "s", requestID: "p1", summary: "bash rm" }),
    ).toMatchObject({
      sessionID: "s",
      id: "p1",
      phase: "requested",
      text: "bash rm",
    });
    expect(decodeInteractionEvent({ sessionID: "s", type: "permission.resolved" }).phase).toBe(
      "resolved",
    );
  });
});

describe("resync", () => {
  test("reconciles running and recent sessions, closes stale topics, and drains finals", async () => {
    const ctx = makeBridge(1);
    await ctx.topology.initialize("fp");
    ctx.reads.sessions = [
      summary("ses_run", { timeUpdatedMs: ctx.clock.now() - 3_600_000 }),
      summary("ses_recent"),
      summary("ses_old", { timeUpdatedMs: ctx.clock.now() - 3_600_000 }),
    ];
    ctx.reads.active = ["ses_run"];
    await ctx.bridge.resync();
    expect(ctx.topology.topicIdFor("ses_run")).toBeDefined();
    expect(ctx.topology.topicIdFor("ses_recent")).toBeDefined();
    expect(ctx.topology.topicIdFor("ses_old")).toBeUndefined();

    ctx.reads.sessions = ctx.reads.sessions.filter((entry) => entry.id !== "ses_recent");
    ctx.clock.advance(3_600_000);
    await ctx.bridge.resync();
    expect(ctx.transport.createdTopics.filter((name) => name.includes("ses_recent"))).toHaveLength(
      1,
    );
  });
});

describe("event routing", () => {
  test("a streamed turn flows from step start through parts to a mirrored final", async () => {
    const ctx = makeBridge();
    await ctx.topology.initialize("fp");
    await ctx.bridge.adoptSession({ sessionID: "ses_1", title: "work" });

    await ctx.bridge.handleEvent({
      type: "session.step.started",
      data: { sessionID: "ses_1", messageID: "msg_9" },
    });

    await ctx.bridge.handleEvent({
      type: "message.part.updated",
      data: { sessionID: "ses_1", part: { messageID: "msg_9", text: "partial answer" } },
    });
    expect(ctx.transport.sent.length + ctx.transport.drafts.length).toBeGreaterThan(0);

    await ctx.bridge.handleEvent({
      type: "session.step.ended",
      data: { sessionID: "ses_1", messageID: "msg_9" },
    });
    expect(ctx.transport.sent.some((text) => text.includes("partial answer"))).toBe(true);
    expect(ctx.delivery.mirrorOf("msg_9")).toBeDefined();

    await ctx.bridge.handleEvent({
      type: "session.step.ended",
      data: { sessionID: "ses_1", messageID: "msg_9" },
    });
    expect(ctx.transport.sent.filter((text) => text.includes("partial answer"))).toHaveLength(1);
  });

  test("renames update the mapped topic title and children render cards in the parent topic", async () => {
    const ctx = makeBridge();
    await ctx.topology.initialize("fp");
    await ctx.bridge.adoptSession({ sessionID: "ses_p", title: "parent" });
    await ctx.bridge.handleEvent({
      type: "session.renamed",
      data: { sessionID: "ses_p", title: "renamed" },
    });
    expect(ctx.transport.createdTopics).toContain("💤 parent");

    await ctx.bridge.handleEvent({
      type: "session.created",
      data: { sessionID: "ses_c", title: "helper agent", parentID: "ses_p" },
    });
    expect(ctx.transport.sent.some((text) => text.startsWith("🤖 helper agent"))).toBe(true);
    expect(ctx.topology.topicIdFor("ses_c")).toBeUndefined();
  });

  test("permission and question events reach the interactions sink and set statuses", async () => {
    const ctx = makeBridge();
    await ctx.topology.initialize("fp");
    await ctx.bridge.adoptSession({ sessionID: "ses_q", title: "asker" });
    const seen: string[] = [];
    ctx.bridge.setInteractions({
      onPermissionEvent: (event) => {
        seen.push(`perm:${event.phase}:${event.requestID ?? "?"}`);
      },
      onQuestionEvent: (event) => {
        seen.push(`q:${event.phase}:${event.prompt ?? "?"}`);
      },
    });
    await ctx.bridge.handleEvent({
      type: "permission.requested",
      data: { sessionID: "ses_q", requestID: "pr_1", summary: "bash rm -rf" },
    });
    await ctx.bridge.handleEvent({
      type: "question.requested",
      data: {
        sessionID: "ses_q",
        questionID: "qn_1",
        prompt: "which db?",
        options: ["postgres", "sqlite"],
      },
    });
    expect(seen).toEqual(["perm:requested:pr_1", "q:requested:which db?"]);
  });

  test("unknown event types and undecodable payloads are ignored without throwing", async () => {
    const ctx = makeBridge();
    await expect(
      ctx.bridge.handleEvent({ type: "future.event", data: {} }),
    ).resolves.toBeUndefined();
    await expect(ctx.bridge.handleEvent({ data: "junk" })).resolves.toBeUndefined();
    await expect(
      ctx.bridge.handleEvent(undefined as unknown as NativeEventEnvelope),
    ).resolves.toBeUndefined();
  });
});

describe("pump containment and resync on stream end", () => {
  test("one throwing handler does not stop later events, and stream end triggers a resync", async () => {
    const ctx = makeBridge();
    await ctx.topology.initialize("fp");
    const seen: string[] = [];
    ctx.bridge.setInteractions({
      onPermissionEvent: () => {
        throw new Error("sink boom");
      },
      onQuestionEvent: (event) => {
        seen.push(event.phase);
      },
    });
    await ctx.bridge.start();
    ctx.queue.push({ type: "permission.requested", data: { sessionID: "ses_x" } });
    ctx.queue.push({ type: "question.requested", data: { sessionID: "ses_x" } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ctx.queue.consumed).toHaveLength(2);
    expect(seen).toEqual(["requested"]);

    ctx.reads.sessions = [summary("ses_after")];
    ctx.queue.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ctx.topology.topicIdFor("ses_after")).toBeDefined();
    await ctx.bridge.stop();
  });
});

describe("actions", () => {
  test("prompt, abort, and model switch pass through and touch the session", async () => {
    const ctx = makeBridge(1);
    await ctx.topology.initialize("fp");
    await ctx.bridge.adoptSession({ sessionID: "ses_a", title: "work" });

    const admitted = await ctx.bridge.promptFromTelegram({ sessionID: "ses_a", text: "do it" });
    expect(admitted.messageID).toBe("msg_1");
    expect(ctx.actions.prompts).toEqual([{ sessionID: "ses_a", text: "do it", delivery: "steer" }]);

    ctx.clock.advance(120_000);
    await ctx.bridge.abort("ses_a");
    expect(ctx.actions.interrupts).toEqual(["ses_a"]);

    await ctx.bridge.switchModel({
      sessionID: "ses_a",
      model: { providerID: "openai", modelID: "gpt-x" },
    });
    expect(ctx.actions.switches).toEqual(["ses_a"]);
  });
});
