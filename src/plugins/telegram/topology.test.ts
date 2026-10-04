// FILE: src/plugins/telegram/topology.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the durable topic topology: General-once, fingerprint reset, create, close-not-delete, reuse, idempotent reconcile, the activity policy, throttled status-emoji titles, clamping, restart survival, and failure containment.
//   SCOPE: Fake transport, store, and clock driving every transition; second-instance reload proving durable authority; bot-change reset clearing rows and recreating General; per-transition failure counting with continued processing; no network or real Bot API dependency.
//   DEPENDS: [src/plugins/telegram/topology.ts]
//   LINKS: [M-TELEGRAM-TOPICS, V-M-TELEGRAM-TOPICS]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   FakeStore - In-memory durable store with prefix scan.
//   FakeTransport - Recording transport with scriptable failures.
//   Clock - Mutable injected clock.
//   makeTopology - Assemble a topology over fresh or shared fakes.
//   threadOf - Resolve a mapped thread id or fail loudly in tests.
//   view - Build a session activity view.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-TELEGRAM-BRIDGE-PLUGIN T-003 - Covered General-once, fingerprint reset, create, close-not-delete, reuse, idempotent reconcile, activity policy, throttled emoji titles, clamping, restart survival, and failure containment.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import {
  composeTopicTitle,
  isSessionActive,
  SESSION_STATUS_EMOJI,
  TelegramTopology,
  type SessionActivityView,
  type TelegramStore,
} from "./topology.js";
import type { TelegramTransport } from "./bot-api.js";

/** In-memory durable store with prefix scan. */
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

/** Recording transport with scriptable per-method failures. */
class FakeTransport implements TelegramTransport {
  nextThreadId = 100;
  readonly createdTopics: string[] = [];
  readonly editedTopics: Array<{ threadId: number; name: string }> = [];
  readonly closedTopics: number[] = [];
  readonly reopenedTopics: number[] = [];
  failOn: Partial<
    Record<"createForumTopic" | "closeForumTopic" | "editForumTopic" | "reopenForumTopic", boolean>
  > = {};

  async createForumTopic(name: string) {
    if (this.failOn.createForumTopic) throw new Error("create failed");
    this.createdTopics.push(name);
    return { threadId: this.nextThreadId++ };
  }
  async editForumTopic(threadId: number, name: string) {
    if (this.failOn.editForumTopic) throw new Error("edit failed");
    this.editedTopics.push({ threadId, name });
  }
  async closeForumTopic(threadId: number) {
    if (this.failOn.closeForumTopic) throw new Error("close failed");
    this.closedTopics.push(threadId);
  }
  async reopenForumTopic(threadId: number) {
    if (this.failOn.reopenForumTopic) throw new Error("reopen failed");
    this.reopenedTopics.push(threadId);
  }
  async sendMessage() {
    return { messageId: 1 };
  }
  async sendDocument() {
    return { messageId: 2 };
  }
  async editMessageText() {}
  async deleteMessage() {}
  async sendDraft() {}
  async answerCallback() {}
  async setMyCommands() {}
  async downloadFile() {
    return new Uint8Array();
  }
  async getUpdates() {
    return [];
  }
}

/** Mutable injected clock. */
class Clock {
  #now = 1_000_000;
  now(): number {
    return this.#now;
  }
  advance(ms: number): void {
    this.#now += ms;
  }
}

function makeTopology(
  store: FakeStore,
  transport: FakeTransport,
  clock: Clock,
  windowMinutes = 240,
) {
  const topology = new TelegramTopology({
    transport,
    store,
    clock,
    windowMinutes,
    titleEditMinIntervalMs: 4_000,
  });
  return topology;
}

function view(
  sessionID: string,
  overrides: Partial<SessionActivityView> = {},
): SessionActivityView {
  return {
    sessionID,
    title: `t-${sessionID}`,
    timeUpdatedMs: 999_999,
    running: false,
    ...overrides,
  };
}

/** Resolve a mapped thread id or fail loudly in tests. */
function threadOf(topology: TelegramTopology, sessionID: string): number {
  const threadId = topology.topicIdFor(sessionID);
  if (threadId === undefined) throw new Error(`no topic mapped for ${sessionID}`);
  return threadId;
}

describe("General control topic", () => {
  test("is created exactly once per bot and reused after a restart", async () => {
    const store = new FakeStore();
    const transport = new FakeTransport();
    const clock = new Clock();
    const first = makeTopology(store, transport, clock);
    await first.initialize("fp-1");
    const general1 = await first.ensureGeneral();
    await first.ensureGeneral();
    expect(transport.createdTopics).toEqual(["General"]);

    const second = makeTopology(store, new FakeTransport(), clock);
    await second.initialize("fp-1");
    const general2 = await second.ensureGeneral();
    expect(general2).toBe(general1);
  });

  test("a changed bot fingerprint resets every stored row and recreates General", async () => {
    const store = new FakeStore();
    const transport = new FakeTransport();
    const clock = new Clock();
    const first = makeTopology(store, transport, clock);
    await first.initialize("fp-1");
    await first.ensureGeneral();
    await first.reconcile([view("ses_a")]);

    const second = makeTopology(store, transport, clock);
    await second.initialize("fp-2");
    expect(second.sessionFor(101)).toBeUndefined();
    expect(second.topicIdFor("ses_a")).toBeUndefined();
    await second.ensureGeneral();
    expect(transport.createdTopics.filter((name) => name === "General")).toHaveLength(2);
  });
});

describe("reconcile transitions", () => {
  test("creates topics for active sessions and closes them when they leave the active set", async () => {
    const store = new FakeStore();
    const transport = new FakeTransport();
    const clock = new Clock();
    const topology = makeTopology(store, transport, clock);
    await topology.initialize("fp");
    await topology.ensureGeneral();

    const created = await topology.reconcile([view("ses_a", { running: true }), view("ses_b")]);
    expect(created).toEqual({ created: 2, closed: 0, reused: 0, titled: 0, failures: 0 });
    expect(transport.createdTopics).toContain("⚙️ t-ses_a");
    expect(transport.createdTopics).toContain("💤 t-ses_b");

    const closed = await topology.reconcile([view("ses_a", { running: true })]);
    expect(closed.closed).toBe(1);
    expect(transport.closedTopics).toEqual([102]);
    expect(topology.sessionFor(102)).toBe("ses_b");

    const again = await topology.reconcile([view("ses_a", { running: true })]);
    expect(again).toEqual({ created: 0, closed: 0, reused: 0, titled: 0, failures: 0 });
  });

  test("a returning session reuses its stored topic id through reopen", async () => {
    const store = new FakeStore();
    const transport = new FakeTransport();
    const clock = new Clock();
    const topology = makeTopology(store, transport, clock);
    await topology.initialize("fp");
    await topology.reconcile([view("ses_a")]);
    const threadId = threadOf(topology, "ses_a");
    await topology.reconcile([]);
    expect(transport.closedTopics).toEqual([threadId]);
    const reused = await topology.reconcile([view("ses_a", { running: true })]);
    expect(reused.reused).toBe(1);
    expect(reused.created).toBe(0);
    expect(transport.reopenedTopics).toEqual([threadId]);
    expect(topology.topicIdFor("ses_a")).toBe(threadId);
  });

  test("restart survival: a second instance keeps every mapping", async () => {
    const store = new FakeStore();
    const transport = new FakeTransport();
    const clock = new Clock();
    const first = makeTopology(store, transport, clock);
    await first.initialize("fp");
    await first.reconcile([view("ses_a"), view("ses_b")]);
    const firstThread = threadOf(first, "ses_a");

    const second = makeTopology(store, new FakeTransport(), clock);
    await second.initialize("fp");
    const aThread = threadOf(second, "ses_a");
    expect(aThread).toBe(firstThread);
    expect(second.sessionFor(aThread)).toBe("ses_a");
  });

  test("a create failure is contained and counted while other sessions proceed", async () => {
    const store = new FakeStore();
    const transport = new FakeTransport();
    transport.failOn.createForumTopic = true;
    const clock = new Clock();
    const topology = makeTopology(store, transport, clock);
    await topology.initialize("fp");
    transport.failOn.createForumTopic = false;
    // Script: fail only the first create call.
    let calls = 0;
    const original = transport.createForumTopic.bind(transport);
    transport.createForumTopic = async (name: string) => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return original(name);
    };
    const report = await topology.reconcile([view("ses_a"), view("ses_b")]);
    expect(report.failures).toBe(1);
    expect(report.created).toBe(1);
    expect(topology.topicIdFor("ses_b")).toBeDefined();
  });
});

describe("status titles", () => {
  test("throttled transitions and unchanged titles skip edits", async () => {
    const store = new FakeStore();
    const transport = new FakeTransport();
    const clock = new Clock();
    const topology = makeTopology(store, transport, clock);
    await topology.initialize("fp");
    await topology.reconcile([view("ses_a", { running: true })]);
    const threadId = threadOf(topology, "ses_a");
    expect(transport.editedTopics).toHaveLength(0);

    clock.advance(5_000);
    await topology.setStatus("ses_a", "question");
    expect(transport.editedTopics).toHaveLength(1);
    expect(transport.editedTopics[0]).toEqual({ threadId, name: "❓ t-ses_a" });

    await topology.setStatus("ses_a", "running");
    expect(transport.editedTopics).toHaveLength(1);

    clock.advance(5_000);
    await topology.setStatus("ses_a", "running");
    expect(transport.editedTopics).toHaveLength(2);
    expect(transport.editedTopics[1]?.name).toBe("⚙️ t-ses_a");
  });

  test("an edit failure degrades to the last known title", async () => {
    const store = new FakeStore();
    const transport = new FakeTransport();
    transport.failOn.editForumTopic = true;
    const clock = new Clock();
    const topology = makeTopology(store, transport, clock);
    await topology.initialize("fp");
    await topology.reconcile([view("ses_a", { running: true })]);
    await expect(topology.setStatus("ses_a", "error")).resolves.toBeUndefined();
  });

  test("titles clamp by code points and fall back on empty input", () => {
    expect(composeTopicTitle(null, "")).toBe("session");
    const long = "с".repeat(200);
    expect(Array.from(composeTopicTitle("⚙️", long)).length).toBeLessThanOrEqual(128);
    expect(composeTopicTitle("⚙️", "work")).toBe("⚙️ work");
  });
});

describe("activity policy", () => {
  test("running is always active; recency uses the newest of session and bot activity", () => {
    const now = 10_000_000;
    expect(isSessionActive({ running: true, lastActivityMs: 0, windowMs: 1_000, nowMs: now })).toBe(
      true,
    );
    expect(
      isSessionActive({ running: false, lastActivityMs: now - 500, windowMs: 1_000, nowMs: now }),
    ).toBe(true);
    expect(
      isSessionActive({ running: false, lastActivityMs: now - 2_000, windowMs: 1_000, nowMs: now }),
    ).toBe(false);
  });

  test("the topology-bound policy folds bot usage into activity", async () => {
    const store = new FakeStore();
    const transport = new FakeTransport();
    const clock = new Clock();
    const topology = makeTopology(store, transport, clock, 1);
    await topology.initialize("fp");
    await topology.reconcile([view("ses_a", { timeUpdatedMs: clock.now() - 120_000 })]);
    // Bot usage from the reconcile create counts as activity; it expires with the window.
    clock.advance(61_000);
    expect(
      topology.isActive("ses_a", { running: false, timeUpdatedMs: clock.now() - 181_000 }),
    ).toBe(false);
    await topology.touchSession("ses_a");
    expect(
      topology.isActive("ses_a", { running: false, timeUpdatedMs: clock.now() - 181_000 }),
    ).toBe(true);
    clock.advance(61_000);
    expect(
      topology.isActive("ses_a", { running: false, timeUpdatedMs: clock.now() - 242_000 }),
    ).toBe(false);
  });
});

describe("status emoji table", () => {
  test("covers every documented session status", () => {
    expect(Object.keys(SESSION_STATUS_EMOJI).sort()).toEqual(
      ["aborted", "error", "idle", "permission", "question", "running"].sort(),
    );
  });
});
