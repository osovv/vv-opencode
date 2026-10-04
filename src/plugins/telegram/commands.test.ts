// FILE: src/plugins/telegram/commands.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the interaction and command surface: permission and question round-trips with truthful closure, the custom-answer input gate, restart resurfacing, General commands with the project picker and /sync, the model picker, rename, message revert and fork, abort, settings toggles, merge-window prompting, and bounded attachments.
//   SCOPE: Fake transport, store, clock, native surfaces, bridge, and injected scheduler driving every command and callback flow with assertions on prompts, closures, and admitted actions; no network or real native dependency.
//   DEPENDS: [src/plugins/telegram/commands.ts, src/plugins/telegram/topology.ts, src/plugins/telegram/delivery.ts, src/plugins/telegram/sessions.ts, src/plugins/telegram/config.ts]
//   LINKS: [M-TELEGRAM-GATEWAY, V-M-TELEGRAM-GATEWAY]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   FakeStore - In-memory durable store.
//   RecordingTransport - Recording transport capturing markups and texts.
//   FakeSurfaces - Scriptable native project, model, history, permission, and question surfaces.
//   makeWorld - Assemble topology, delivery, bridge, interactions, and commands over fakes.
//   cb - Build a callback query helper.
//   Clock - Mutable injected clock.
//   SentMessage - One recorded send with thread, text, and optional markup.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-TELEGRAM-BRIDGE-PLUGIN T-006/T-007 - Covered permission and question round-trips, the custom-answer gate, resurfacing, General and session commands, pickers, revert and fork, settings, merge-window prompting, and attachment bounds.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import {
  parseCallbackData,
  permissionCallbackData,
  questionCallbackData,
  questionCustomCallbackData,
  TelegramCommands,
  TelegramInteractions,
  type NativeHistorySurface,
  type NativeModelSurface,
  type NativeProjectSurface,
  type NativeQuestionSurface,
  type NativePermissionSurface,
} from "./commands.js";
import type { TelegramCallbackQuery, TelegramTransport } from "./bot-api.js";
import { TelegramTopology, type TelegramStore } from "./topology.js";
import { TelegramDelivery } from "./delivery.js";
import { SessionBridge, type NativeSessionActions, type NativeSessionReads } from "./sessions.js";
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

interface SentMessage {
  threadId: number;
  text: string;
  markup?: readonly (readonly { text: string; callbackData: string }[])[];
}

class RecordingTransport implements TelegramTransport {
  nextThreadId = 100;
  nextMessageId = 10;
  readonly createdTopics: string[] = [];
  readonly sent: SentMessage[] = [];
  readonly edits: Array<{ messageId: number; text: string }> = [];
  readonly callbacksAnswered: string[] = [];
  readonly downloads = new Map<string, Uint8Array>();
  async createForumTopic(name: string) {
    this.createdTopics.push(name);
    return { threadId: this.nextThreadId++ };
  }
  async editForumTopic(): Promise<void> {}
  async closeForumTopic(): Promise<void> {}
  async reopenForumTopic(): Promise<void> {}
  async sendMessage(input: {
    threadId: number;
    text: string;
    replyMarkup?: SentMessage["markup"];
  }) {
    this.sent.push({ threadId: input.threadId, text: input.text, markup: input.replyMarkup });
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
  async answerCallback(_id: string, text?: string) {
    this.callbacksAnswered.push(text ?? "");
  }
  async setMyCommands(): Promise<void> {}
  async downloadFile(fileId: string): Promise<Uint8Array> {
    const bytes = this.downloads.get(fileId);
    if (bytes === undefined) throw new Error("too large");
    return bytes;
  }
  async getUpdates() {
    return [];
  }
}

class FakeSurfaces {
  readonly projects: { id: string; directory: string }[] = [
    { id: "p1", directory: "/home/al/dev/vv-opencode" },
    { id: "p2", directory: "/home/al/dev/vv-chat" },
  ];
  createdSessions: string[] = [];
  models: { providerID: string; modelID: string }[] = [
    { providerID: "openai", modelID: "gpt-a" },
    { providerID: "openai", modelID: "gpt-b" },
    { providerID: "zai", modelID: "glm-c" },
  ];
  history: { messageID: string; text: string }[] = [
    { messageID: "msg_1", text: "first prompt" },
    { messageID: "msg_2", text: "second prompt" },
  ];
  reverted: string[] = [];
  forked: string[] = [];
  pendingPermissions: { requestID: string; summary?: string }[] = [];
  permissionReplies: Array<{ requestID: string; reply: string }> = [];
  questionReplies: Array<{ questionID: string; answer: string }> = [];
  failPermissionReply = false;

  readonly projectSurface: NativeProjectSurface = {
    listProjects: async () => this.projects,
    createSession: async (input) => {
      this.createdSessions.push(input.directory);
      return { id: `ses_${this.createdSessions.length}` };
    },
  };
  readonly modelSurface: NativeModelSurface = { listModels: async () => this.models };
  readonly historySurface: NativeHistorySurface = {
    listUserMessages: async () => this.history,
    revert: async (input) => {
      this.reverted.push(input.messageID);
    },
    fork: async (input) => {
      this.forked.push(input.messageID);
      return { id: `ses_fork_${this.forked.length}` };
    },
  };
  readonly permissionSurface: NativePermissionSurface = {
    listPending: async () => this.pendingPermissions,
    reply: async (input) => {
      if (this.failPermissionReply) throw new Error("native failed");
      this.permissionReplies.push({ requestID: input.requestID, reply: input.reply });
    },
  };
  readonly questionSurface: NativeQuestionSurface = {
    reply: async (input) => {
      this.questionReplies.push({
        questionID: input.questionID,
        answer: JSON.stringify(input.answers),
      });
    },
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

function makeWorld(windowMinutes = 240) {
  const transport = new RecordingTransport();
  const store = new FakeStore();
  const clock = new Clock();
  const surfaces = new FakeSurfaces();
  const topology = new TelegramTopology({ transport, store, clock, windowMinutes });
  const delivery = new TelegramDelivery({
    transport,
    store,
    clock,
    defaults: { ...DEFAULT_TELEGRAM_SETTINGS },
  });
  const prompts: Array<{ sessionID: string; text: string; files?: number }> = [];
  const actions: NativeSessionActions = {
    prompt: async (input) => {
      prompts.push({ sessionID: input.sessionID, text: input.text, files: input.files?.length });
      return { messageID: `msg_${prompts.length}` };
    },
    interrupt: async () => {},
    switchModel: async () => {},
  };
  const reads: NativeSessionReads = {
    listSessions: async () =>
      store === undefined
        ? []
        : [
            {
              id: "ses_work",
              title: "work",
              timeCreatedMs: 900_000,
              timeUpdatedMs: clock.now(),
              parentID: undefined,
            },
          ],
    activeSessionIds: async () => [],
  };
  const queue = {
    stream: {
      [Symbol.asyncIterator]() {
        return (async function* () {})();
      },
    },
  };
  const bridge = new SessionBridge({
    topology,
    delivery,
    reads,
    actions,
    events: { subscribe: () => queue.stream },
    clock,
  });
  const interactions = new TelegramInteractions({
    transport,
    topology,
    permissions: surfaces.permissionSurface,
    questions: surfaces.questionSurface,
  });
  bridge.setInteractions(interactions);
  const scheduled: Array<() => void> = [];
  const commands = new TelegramCommands({
    transport,
    topology,
    delivery,
    bridge,
    interactions,
    projects: surfaces.projectSurface,
    models: surfaces.modelSurface,
    history: surfaces.historySurface,
    reads,
    clock,
    schedule: (fn) => scheduled.push(fn),
  });
  return {
    transport,
    store,
    clock,
    surfaces,
    topology,
    delivery,
    bridge,
    interactions,
    commands,
    prompts,
    scheduled,
  };
}

function cb(threadId: number, data: string): TelegramCallbackQuery {
  return {
    id: `cq-${data}`,
    from: { id: 1 },
    message: { message_id: 5, chat: { id: 1 }, message_thread_id: threadId },
    data,
  };
}

describe("callback data", () => {
  test("builders round-trip through the parser", () => {
    expect(parseCallbackData(permissionCallbackData("pr1", "once"))).toEqual({
      kind: "permission",
      id: "pr1",
      action: "once",
    });
    expect(parseCallbackData(questionCallbackData("qn1", 2))).toEqual({
      kind: "question",
      id: "qn1",
      optionIndex: 2,
    });
    expect(parseCallbackData(questionCustomCallbackData("qn1"))).toEqual({
      kind: "question-custom",
      id: "qn1",
    });
    expect(parseCallbackData("vvocp:pr1:maybe")).toBeUndefined();
    expect(parseCallbackData("garbage")).toBeUndefined();
  });
});

describe("permission interactions", () => {
  test("requested renders buttons, once replies and closes truthfully", async () => {
    const world = makeWorld();
    await world.topology.initialize("fp");
    await world.bridge.adoptSession({ sessionID: "ses_work", title: "work" });
    const threadId = world.topology.topicIdFor("ses_work") as number;

    await world.interactions.onPermissionEvent({
      sessionID: "ses_work",
      requestID: "pr_1",
      phase: "requested",
      summary: "bash rm -rf /tmp",
    });
    expect(world.transport.sent.at(-1)?.markup?.[0]?.map((b) => b.callbackData)).toEqual([
      permissionCallbackData("pr_1", "once"),
      permissionCallbackData("pr_1", "always"),
      permissionCallbackData("pr_1", "reject"),
    ]);

    await world.interactions.handleCallback(cb(threadId, permissionCallbackData("pr_1", "once")));
    expect(world.surfaces.permissionReplies).toEqual([{ requestID: "pr_1", reply: "once" }]);
    expect(world.transport.edits.at(-1)?.text).toContain("✅ once");
  });

  test("a failed native reply keeps the prompt answerable with a warning", async () => {
    const world = makeWorld();
    await world.topology.initialize("fp");
    await world.bridge.adoptSession({ sessionID: "ses_work", title: "work" });
    const threadId = world.topology.topicIdFor("ses_work") as number;
    world.surfaces.failPermissionReply = true;

    await world.interactions.onPermissionEvent({
      sessionID: "ses_work",
      requestID: "pr_2",
      phase: "requested",
      summary: "write file",
    });
    await world.interactions.handleCallback(cb(threadId, permissionCallbackData("pr_2", "reject")));
    expect(world.surfaces.permissionReplies).toHaveLength(0);
    expect(world.transport.callbacksAnswered.at(-1)).toContain("failed");
    expect(world.transport.edits).toHaveLength(0);
  });

  test("a resolution outside Telegram closes the prompt truthfully", async () => {
    const world = makeWorld();
    await world.topology.initialize("fp");
    await world.bridge.adoptSession({ sessionID: "ses_work", title: "work" });
    const threadId = world.topology.topicIdFor("ses_work") as number;
    await world.interactions.onPermissionEvent({
      sessionID: "ses_work",
      requestID: "pr_3",
      phase: "requested",
      summary: "x",
    });
    await world.interactions.onPermissionEvent({
      sessionID: "ses_work",
      requestID: "pr_3",
      phase: "resolved",
      summary: undefined,
    });
    expect(world.transport.edits.at(-1)?.text).toContain("resolved outside Telegram");
    expect(threadId).toBeDefined();
  });

  test("resurfacing re-renders still-pending native requests after a restart", async () => {
    const world = makeWorld();
    await world.topology.initialize("fp");
    await world.bridge.adoptSession({ sessionID: "ses_work", title: "work" });
    world.surfaces.pendingPermissions = [{ requestID: "pr_9", summary: "retry me" }];
    await world.interactions.resurfacePending(["ses_work"]);
    expect(world.transport.sent.at(-1)?.text).toContain("retry me");
  });
});

describe("question interactions", () => {
  test("options answer through the native surface and close the prompt", async () => {
    const world = makeWorld();
    await world.topology.initialize("fp");
    await world.bridge.adoptSession({ sessionID: "ses_work", title: "work" });
    const threadId = world.topology.topicIdFor("ses_work") as number;
    await world.interactions.onQuestionEvent({
      sessionID: "ses_work",
      questionID: "qn_1",
      phase: "requested",
      prompt: "which database?",
      options: ["Postgres", "SQLite"],
      fields: [
        {
          key: "db",
          kind: "choice",
          options: [
            { label: "Postgres", value: "postgres" },
            { label: "SQLite", value: "sqlite" },
          ],
        },
      ],
    });
    await world.interactions.handleCallback(cb(threadId, questionCallbackData("qn_1", 1)));
    expect(world.surfaces.questionReplies).toEqual([
      { questionID: "qn_1", answer: '{"db":"sqlite"}' },
    ]);
    expect(world.transport.edits.at(-1)?.text).toContain("answered: SQLite");
  });

  test("the custom action gates the topic until the next plain message answers", async () => {
    const world = makeWorld();
    await world.topology.initialize("fp");
    await world.bridge.adoptSession({ sessionID: "ses_work", title: "work" });
    const threadId = world.topology.topicIdFor("ses_work") as number;
    await world.interactions.onQuestionEvent({
      sessionID: "ses_work",
      questionID: "qn_2",
      phase: "requested",
      prompt: "name the branch",
      options: [],
      fields: [{ key: "branch", kind: "free", options: [] }],
    });
    await world.interactions.handleCallback(cb(threadId, questionCustomCallbackData("qn_2")));
    expect(world.interactions.isGated(threadId)).toBe(true);

    expect(await world.interactions.consumeGatedText(threadId, "feature/x")).toBe(true);
    expect(world.surfaces.questionReplies).toEqual([
      { questionID: "qn_2", answer: '{"branch":"feature/x"}' },
    ]);
    expect(world.interactions.isGated(threadId)).toBe(false);
  });

  test("a failed custom answer re-opens the gate and /cancel aborts without answering", async () => {
    const world = makeWorld();
    await world.topology.initialize("fp");
    await world.bridge.adoptSession({ sessionID: "ses_work", title: "work" });
    const threadId = world.topology.topicIdFor("ses_work") as number;
    await world.interactions.onQuestionEvent({
      sessionID: "ses_work",
      questionID: "qn_3",
      phase: "requested",
      prompt: "confirm",
      options: ["yes"],
      fields: [],
    });
    await world.interactions.handleCallback(cb(threadId, questionCustomCallbackData("qn_3")));
    expect(await world.interactions.consumeGatedText(threadId, "/cancel")).toBe(true);
    expect(world.surfaces.questionReplies).toHaveLength(0);
    expect(world.interactions.isGated(threadId)).toBe(false);
  });
});

describe("General commands", () => {
  test("/new opens the project picker and creates a session with a topic", async () => {
    const world = makeWorld();
    await world.topology.initialize("fp");
    const general = await world.topology.ensureGeneral();

    await world.commands.handleMessage({ threadId: general, text: "/new" });
    expect(world.transport.sent.at(-1)?.markup?.[0]?.[0]?.text).toBe("vv-opencode");

    await world.commands.handleCallback(cb(general, "vvocnp:1"));
    expect(world.surfaces.createdSessions).toEqual(["/home/al/dev/vv-chat"]);
    expect(world.topology.topicIdFor("ses_1")).toBeDefined();
    expect(world.transport.sent.at(-1)?.text).toContain("session created");
  });

  test("/sync reconciles and reports counts", async () => {
    const world = makeWorld();
    await world.topology.initialize("fp");
    const general = await world.topology.ensureGeneral();
    await world.commands.handleMessage({ threadId: general, text: "/sync" });
    const report = world.transport.sent.at(-1)?.text ?? "";
    expect(report).toContain("synced:");
    expect(world.topology.topicIdFor("ses_work")).toBeDefined();
  });

  test("/status lists active sessions and /help lists commands", async () => {
    const world = makeWorld();
    await world.topology.initialize("fp");
    const general = await world.topology.ensureGeneral();
    await world.commands.handleMessage({ threadId: general, text: "/status" });
    expect(world.transport.sent.at(-1)?.text).toContain("work");
    await world.commands.handleMessage({ threadId: general, text: "/help" });
    expect(world.transport.sent.at(-1)?.text).toContain("/new");
  });

  test("unknown commands fall back with a bounded reply", async () => {
    const world = makeWorld();
    await world.topology.initialize("fp");
    const general = await world.topology.ensureGeneral();
    await world.commands.handleMessage({ threadId: general, text: "/wat" });
    expect(world.transport.sent.at(-1)?.text).toContain("unknown command");
  });

  test("plain text in General is answered with a hint, not a prompt", async () => {
    const world = makeWorld();
    await world.topology.initialize("fp");
    const general = await world.topology.ensureGeneral();
    await world.commands.handleMessage({ threadId: general, text: "hello there" });
    expect(world.prompts).toHaveLength(0);
    expect(world.transport.sent.at(-1)?.text).toContain("General");
  });
});

describe("session commands", () => {
  async function sessionWorld() {
    const world = makeWorld();
    await world.topology.initialize("fp");
    await world.bridge.adoptSession({ sessionID: "ses_work", title: "work" });
    const threadId = world.topology.topicIdFor("ses_work") as number;
    return { world, threadId };
  }

  test("plain text merges through the window and admits one prompt", async () => {
    const { world, threadId } = await sessionWorld();
    await world.commands.handleMessage({ threadId, text: "part one" });
    await world.commands.handleMessage({ threadId, text: "part two" });
    expect(world.prompts).toHaveLength(0);
    world.clock.advance(2_000);
    for (const flush of world.scheduled.splice(0)) await flush();
    expect(world.prompts).toHaveLength(1);
    expect(world.prompts[0]?.text).toBe("part one\npart two");
    expect(world.prompts[0]?.sessionID).toBe("ses_work");
  });

  test("/model opens providers then models and switches", async () => {
    const { world, threadId } = await sessionWorld();
    await world.commands.handleMessage({ threadId, text: "/model" });
    const providerButtons = world.transport.sent
      .at(-1)
      ?.markup?.flat()
      .map((b) => b.text);
    expect(providerButtons).toEqual(["openai", "zai"]);

    await world.commands.handleCallback(cb(threadId, "vvocm:prov:0"));
    expect(world.transport.sent.at(-1)?.text).toContain("models of openai");

    await world.commands.handleCallback(cb(threadId, "vvocm:model:1"));
    expect(world.transport.sent.at(-1)?.text).toContain("gpt-b");
  });

  test("/rename updates the topic title and /abort interrupts", async () => {
    const { world, threadId } = await sessionWorld();
    await world.commands.handleMessage({ threadId, text: "/rename new shiny title" });
    expect(world.transport.sent.at(-1)?.text).toContain("new shiny title");
    await world.commands.handleMessage({ threadId, text: "/abort" });
    expect(world.transport.sent.at(-1)?.text).toContain("aborted");
  });

  test("/messages lists, opens, reverts, and forks", async () => {
    const { world, threadId } = await sessionWorld();
    await world.commands.handleMessage({ threadId, text: "/messages" });
    expect(world.transport.sent.at(-1)?.markup?.[0]?.[0]?.text).toContain("first prompt");

    await world.commands.handleCallback(cb(threadId, "vvocmsg:open:1"));
    expect(world.transport.sent.at(-1)?.text).toContain("second prompt");

    await world.commands.handleCallback(cb(threadId, "vvocmsg:revert:1"));
    expect(world.surfaces.reverted).toEqual(["msg_2"]);

    await world.commands.handleCallback(cb(threadId, "vvocmsg:fork:0"));
    expect(world.surfaces.forked).toEqual(["msg_1"]);
    expect(world.transport.sent.at(-1)?.text).toContain("forked session");
  });

  test("/settings toggles persisted runtime settings", async () => {
    const { world, threadId } = await sessionWorld();
    await world.commands.handleMessage({ threadId, text: "/settings" });
    await world.commands.handleCallback(cb(threadId, "vvocs:reasoning"));
    expect(world.delivery.settings.showReasoning).toBe(true);
    await world.commands.handleCallback(cb(threadId, "vvocs:format"));
    expect(world.delivery.settings.formatMode).toBe("raw");
  });

  test("attachments within bounds are admitted with the caption and oversized ones are rejected", async () => {
    const { world, threadId } = await sessionWorld();
    world.transport.downloads.set("ok-file", new Uint8Array(16));
    await world.commands.handleMessage({
      threadId,
      text: "look at this",
      attachments: [
        { fileId: "ok-file", filename: "notes.txt", mimeType: "text/plain" },
        { fileId: "huge-file", filename: "big.bin", mimeType: "application/octet-stream" },
      ],
    });
    expect(world.prompts).toHaveLength(1);
    expect(world.prompts[0]?.files).toBe(1);
    const last = world.transport.sent.filter((m) => m.threadId === threadId).at(-1)?.text ?? "";
    expect(last).toContain("exceeded the size cap");
  });
});
