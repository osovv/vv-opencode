// FILE: src/plugins/telegram/commands.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Own the Telegram-facing interaction and command surface: manual permission and question prompts with an input gate, General control commands with a project picker and /sync, session-topic commands including the model picker, rename, message history with revert and fork, abort, runtime settings, and bounded inbound attachments.
//   SCOPE: Injectable native project, model, history, permission, and question surfaces; callback-data builders and parsing; per-topic interaction state with truthful closure; the custom-answer input gate consumed before prompt admission; per-topic merge windows with an injectable scheduler; attachment download with size and count caps; unknown-command fallbacks.
//   DEPENDS: [src/plugins/telegram/bot-api.ts, src/plugins/telegram/topology.ts, src/plugins/telegram/delivery.ts, src/plugins/telegram/sessions.ts, src/plugins/telegram/config.ts]
//   LINKS: [M-TELEGRAM-GATEWAY, M-TELEGRAM-DELIVERY, M-TELEGRAM-TOPICS, V-M-TELEGRAM-GATEWAY]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   NativeProjectSurface - Injectable native project listing and session creation.
//   NativeModelSurface - Injectable native model listing.
//   NativeHistorySurface - Injectable native message listing, revert, and fork.
//   NativePermissionSurface - Injectable native permission list and reply.
//   NativeQuestionSurface - Injectable native question reply.
//   permissionCallbackData - Pure callback-data builder for permission actions.
//   questionCallbackData - Pure callback-data builder for question options.
//   questionCustomCallbackData - Pure callback-data builder for the custom-answer action.
//   parseCallbackData - Pure callback-data parser shared by interactions and pickers.
//   TelegramInteractions - Permission and question prompts with the per-topic input gate.
//   TelegramCommands - Command dispatch for the General and session topics with pickers and attachments.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-TELEGRAM-BRIDGE-PLUGIN T-006/T-007 - Created the interactions layer with manual permission and question flows plus the custom-answer gate, and the command surface with project and model pickers, /sync, /status, rename, revert, fork, abort, settings, and bounded attachments.]
// END_CHANGE_SUMMARY

import type { TelegramCallbackQuery, TelegramTransport } from "./bot-api.js";
import { TelegramInputMerger } from "./delivery.js";
import type { TelegramDelivery } from "./delivery.js";
import type { SessionBridge } from "./sessions.js";
import type { NativePromptFile } from "./sessions.js";
import type { TelegramTopology } from "./topology.js";

/** Injectable native project listing and session creation. */
export interface NativeProjectSurface {
  listProjects(): Promise<readonly { readonly id: string; readonly directory: string }[]>;
  createSession(input: { readonly directory: string }): Promise<{ readonly id: string }>;
}

/** Injectable native model listing. */
export interface NativeModelSurface {
  listModels(): Promise<readonly { readonly providerID: string; readonly modelID: string }[]>;
}

/** Injectable native message listing, revert, and fork. */
export interface NativeHistorySurface {
  listUserMessages(input: {
    readonly sessionID: string;
  }): Promise<readonly { readonly messageID: string; readonly text: string }[]>;
  revert(input: { readonly sessionID: string; readonly messageID: string }): Promise<void>;
  fork(input: {
    readonly sessionID: string;
    readonly messageID: string;
  }): Promise<{ readonly id: string }>;
}

/** Injectable native permission list and reply. */
export interface NativePermissionSurface {
  listPending(input: {
    readonly sessionID: string;
  }): Promise<readonly { readonly requestID: string; readonly summary?: string }[]>;
  reply(input: {
    readonly sessionID: string;
    readonly requestID: string;
    readonly reply: "once" | "always" | "reject";
  }): Promise<void>;
}

/** Injectable native question reply. */
export interface NativeQuestionSurface {
  reply(input: {
    readonly sessionID: string;
    readonly questionID: string;
    readonly answer: string;
  }): Promise<void>;
}

// START_BLOCK_CALLBACK_DATA
const PERMISSION_PREFIX = "vvocp";
const QUESTION_PREFIX = "vvocq";
const QUESTION_CUSTOM_PREFIX = "vvocqc";

/** Pure callback-data builder for permission actions. */
export function permissionCallbackData(
  requestID: string,
  action: "once" | "always" | "reject",
): string {
  return `${PERMISSION_PREFIX}:${requestID}:${action}`;
}

/** Pure callback-data builder for question options. */
export function questionCallbackData(questionID: string, optionIndex: number): string {
  return `${QUESTION_PREFIX}:${questionID}:${optionIndex}`;
}

/** Pure callback-data builder for the custom-answer action. */
export function questionCustomCallbackData(questionID: string): string {
  return `${QUESTION_CUSTOM_PREFIX}:${questionID}`;
}

/** Pure callback-data parser shared by interactions and pickers. */
export function parseCallbackData(data: string):
  | {
      readonly kind: "permission";
      readonly id: string;
      readonly action: "once" | "always" | "reject";
    }
  | { readonly kind: "question"; readonly id: string; readonly optionIndex: number }
  | { readonly kind: "question-custom"; readonly id: string }
  | undefined {
  const parts = data.split(":");
  if (
    parts.length === 3 &&
    parts[0] === PERMISSION_PREFIX &&
    ["once", "always", "reject"].includes(parts[2])
  ) {
    return { kind: "permission", id: parts[1], action: parts[2] as "once" | "always" | "reject" };
  }
  if (parts.length === 3 && parts[0] === QUESTION_PREFIX && /^\d+$/.test(parts[2])) {
    return { kind: "question", id: parts[1], optionIndex: Number(parts[2]) };
  }
  if (parts.length === 2 && parts[0] === QUESTION_CUSTOM_PREFIX) {
    return { kind: "question-custom", id: parts[1] };
  }
  return undefined;
}
// END_BLOCK_CALLBACK_DATA

interface ActivePrompt {
  readonly kind: "permission" | "question";
  readonly sessionID: string;
  readonly id: string;
  readonly tgMessageId: number;
  readonly label: string;
  readonly options: readonly string[];
}

/**
 * Permission and question prompts. Every decision is manual: buttons call the
 * native surfaces, a failed reply keeps the prompt answerable with a warning,
 * and a prompt that disappears outside Telegram closes truthfully. Choosing the
 * custom answer opens the topic input gate so the next plain message becomes
 * the answer instead of a prompt.
 */
export class TelegramInteractions {
  readonly #transport: TelegramTransport;
  readonly #topology: TelegramTopology;
  readonly #permissions: NativePermissionSurface;
  readonly #questions: NativeQuestionSurface;
  readonly #prompts = new Map<number, ActivePrompt>();
  readonly #gates = new Map<
    number,
    { readonly kind: "custom"; readonly id: string; readonly sessionID: string }
  >();

  constructor(deps: {
    transport: TelegramTransport;
    topology: TelegramTopology;
    permissions: NativePermissionSurface;
    questions: NativeQuestionSurface;
  }) {
    this.#transport = deps.transport;
    this.#topology = deps.topology;
    this.#permissions = deps.permissions;
    this.#questions = deps.questions;
  }

  /** Whether a topic currently holds the input gate for a custom answer. */
  isGated(threadId: number): boolean {
    return this.#gates.has(threadId);
  }

  async onPermissionEvent(input: {
    readonly sessionID: string;
    readonly requestID: string | undefined;
    readonly phase: "requested" | "resolved";
    readonly summary: string | undefined;
  }): Promise<void> {
    const threadId = this.#topology.topicIdFor(input.sessionID);
    if (threadId === undefined) return;
    if (input.phase === "resolved") {
      await this.#closePrompt(threadId, "resolved outside Telegram");
      return;
    }
    if (input.requestID === undefined) return;
    const existing = this.#prompts.get(threadId);
    if (existing !== undefined && existing.id === input.requestID) return;
    const label = input.summary ?? "permission request";
    const sent = await this.#transport.sendMessage({
      threadId,
      text: `🔐 Permission required\n${label}`,
      replyMarkup: [
        [
          { text: "✅ Once", callbackData: permissionCallbackData(input.requestID, "once") },
          { text: "♾ Always", callbackData: permissionCallbackData(input.requestID, "always") },
          { text: "❌ Reject", callbackData: permissionCallbackData(input.requestID, "reject") },
        ],
      ],
    });
    this.#prompts.set(threadId, {
      kind: "permission",
      sessionID: input.sessionID,
      id: input.requestID,
      tgMessageId: sent.messageId,
      label,
      options: [],
    });
  }

  async onQuestionEvent(input: {
    readonly sessionID: string;
    readonly questionID: string | undefined;
    readonly phase: "requested" | "resolved";
    readonly prompt: string | undefined;
    readonly options: readonly string[];
  }): Promise<void> {
    const threadId = this.#topology.topicIdFor(input.sessionID);
    if (threadId === undefined) return;
    if (input.phase === "resolved") {
      await this.#closePrompt(threadId, "answered or cancelled outside Telegram");
      return;
    }
    if (input.questionID === undefined) return;
    const existing = this.#prompts.get(threadId);
    if (existing !== undefined && existing.id === input.questionID) return;
    const label = input.prompt ?? "question";
    const rows = input.options.map((option, index) => [
      {
        text: option.slice(0, 60),
        callbackData: questionCallbackData(input.questionID as string, index),
      },
    ]);
    rows.push([
      { text: "✍️ Custom answer", callbackData: questionCustomCallbackData(input.questionID) },
    ]);
    const sent = await this.#transport.sendMessage({
      threadId,
      text: `❓ ${label}`,
      replyMarkup: rows,
    });
    this.#prompts.set(threadId, {
      kind: "question",
      sessionID: input.sessionID,
      id: input.questionID,
      tgMessageId: sent.messageId,
      label,
      options: input.options,
    });
  }

  /** Handle one owner callback query routed here by the command layer. */
  async handleCallback(query: TelegramCallbackQuery): Promise<void> {
    if (query.data === undefined) return;
    const threadId = query.message?.message_thread_id;
    const prompt = threadId === undefined ? undefined : this.#prompts.get(threadId);
    try {
      const parsed = parseCallbackData(query.data);
      if (parsed === undefined || prompt === undefined) {
        await this.#transport.answerCallback(query.id, "stale prompt");
        return;
      }
      if (parsed.kind === "permission") {
        await this.#permissions.reply({
          sessionID: prompt.sessionID,
          requestID: parsed.id,
          reply: parsed.action,
        });
        await this.#transport.answerCallback(
          query.id,
          parsed.action === "reject" ? "rejected" : "allowed",
        );
        await this.#closePrompt(
          threadId as number,
          parsed.action === "reject" ? "❌ rejected" : `✅ ${parsed.action}`,
        );
        return;
      }
      if (parsed.kind === "question") {
        const option = prompt.options[parsed.optionIndex];
        if (option === undefined) {
          await this.#transport.answerCallback(query.id, "stale option");
          return;
        }
        await this.#questions.reply({
          sessionID: prompt.sessionID,
          questionID: parsed.id,
          answer: option,
        });
        await this.#transport.answerCallback(query.id, "answered");
        await this.#closePrompt(threadId as number, `✅ answered: ${option}`);
        return;
      }
      this.#gates.set(threadId as number, {
        kind: "custom",
        id: parsed.id,
        sessionID: prompt.sessionID,
      });
      await this.#transport.answerCallback(query.id, "type your answer");
      await this.#editPrompt(
        threadId as number,
        prompt,
        `${prompt.label}\n\n✍️ type your answer now (/cancel to abort)`,
      );
    } catch {
      await this.#transport.answerCallback(query.id, "⚠️ failed, try again");
    }
  }

  /** Consume a gated plain message as the custom answer; returns true when consumed. */
  async consumeGatedText(threadId: number, text: string): Promise<boolean> {
    const gate = this.#gates.get(threadId);
    const prompt = this.#prompts.get(threadId);
    if (gate === undefined) return false;
    this.#gates.delete(threadId);
    if (text.trim() === "/cancel") {
      if (prompt !== undefined) {
        await this.#editPrompt(threadId, prompt, `${prompt.label}\n\n⏹ custom answer cancelled`);
      }
      return true;
    }
    try {
      await this.#questions.reply({ sessionID: gate.sessionID, questionID: gate.id, answer: text });
      if (prompt !== undefined) {
        await this.#editPrompt(
          threadId,
          prompt,
          `${prompt.label}\n\n✅ answered: ${text.slice(0, 80)}`,
        );
      }
    } catch {
      this.#gates.set(threadId, gate);
      if (prompt !== undefined) {
        await this.#editPrompt(threadId, prompt, `${prompt.label}\n\n⚠️ answer failed, type again`);
      }
    }
    return true;
  }

  /** Re-render still-pending native permission prompts after a restart. */
  async resurfacePending(sessionIDs: readonly string[]): Promise<void> {
    for (const sessionID of sessionIDs) {
      const threadId = this.#topology.topicIdFor(sessionID);
      if (threadId === undefined) continue;
      const pending = await this.#permissions.listPending({ sessionID });
      for (const request of pending) {
        await this.onPermissionEvent({
          sessionID,
          requestID: request.requestID,
          phase: "requested",
          summary: request.summary,
        });
      }
    }
  }

  async #closePrompt(threadId: number, outcome: string): Promise<void> {
    const prompt = this.#prompts.get(threadId);
    this.#prompts.delete(threadId);
    this.#gates.delete(threadId);
    if (prompt === undefined) return;
    await this.#editPrompt(threadId, prompt, `${prompt.label}\n\n${outcome}`);
  }

  async #editPrompt(threadId: number, prompt: ActivePrompt, text: string): Promise<void> {
    try {
      await this.#transport.editMessageText({ messageId: prompt.tgMessageId, text });
    } catch {
      // Editing a prompt is best-effort; the native state stays truthful.
    }
  }
}

type Schedule = (fn: () => void, ms: number) => void;

/**
 * Command dispatch for the General and session topics. Plain text in a session
 * topic is consumed by the custom-answer gate first, then coalesced through the
 * per-topic merge window before admission as a prompt.
 */
export class TelegramCommands {
  readonly #transport: TelegramTransport;
  readonly #topology: TelegramTopology;
  readonly #delivery: TelegramDelivery;
  readonly #bridge: SessionBridge;
  readonly #interactions: TelegramInteractions;
  readonly #projects: NativeProjectSurface;
  readonly #models: NativeModelSurface;
  readonly #history: NativeHistorySurface;
  readonly #reads: {
    listSessions(): Promise<
      readonly {
        id: string;
        title: string | undefined;
        timeUpdatedMs: number;
        parentID: string | undefined;
      }[]
    >;
    activeSessionIds(): Promise<readonly string[]>;
  };
  readonly #clock: { now(): number };
  readonly #schedule: Schedule;
  readonly #mergers = new Map<number, TelegramInputMerger>();
  readonly #maxAttachmentBytes: number;
  readonly #maxAttachments: number;

  constructor(deps: {
    transport: TelegramTransport;
    topology: TelegramTopology;
    delivery: TelegramDelivery;
    bridge: SessionBridge;
    interactions: TelegramInteractions;
    projects: NativeProjectSurface;
    models: NativeModelSurface;
    history: NativeHistorySurface;
    reads: {
      listSessions(): Promise<
        readonly {
          id: string;
          title: string | undefined;
          timeUpdatedMs: number;
          parentID: string | undefined;
        }[]
      >;
      activeSessionIds(): Promise<readonly string[]>;
    };
    clock: { now(): number };
    schedule?: Schedule;
    maxAttachmentBytes?: number;
    maxAttachments?: number;
  }) {
    this.#transport = deps.transport;
    this.#topology = deps.topology;
    this.#delivery = deps.delivery;
    this.#bridge = deps.bridge;
    this.#interactions = deps.interactions;
    this.#projects = deps.projects;
    this.#models = deps.models;
    this.#history = deps.history;
    this.#reads = deps.reads;
    this.#clock = deps.clock;
    this.#schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.#maxAttachmentBytes = deps.maxAttachmentBytes ?? 8 * 1024 * 1024;
    this.#maxAttachments = deps.maxAttachments ?? 10;
  }

  /** Route one owner message; the caller has already verified the sender. */
  async handleMessage(input: {
    readonly threadId: number;
    readonly text: string | undefined;
    readonly attachments?: readonly {
      readonly fileId: string;
      readonly filename: string | undefined;
      readonly mimeType: string | undefined;
    }[];
  }): Promise<void> {
    const text = input.text?.trim() ?? "";
    if (text.startsWith("/")) {
      await this.#command(input.threadId, text);
      return;
    }
    const sessionID = this.#topology.sessionFor(input.threadId);
    if (sessionID === undefined) {
      if (text.length > 0) {
        await this.#delivery.sendTransient({
          threadId: input.threadId,
          text: "ℹ️ commands live in General; session topics take prompts",
        });
      }
      return;
    }
    if (text.length > 0 && (await this.#interactions.consumeGatedText(input.threadId, text)))
      return;

    if (input.attachments !== undefined && input.attachments.length > 0) {
      await this.#promptWithAttachments(sessionID, input.threadId, text, input.attachments);
      return;
    }
    if (text.length === 0) return;

    const merger = this.#mergerFor(input.threadId);
    merger.add(text, this.#clock.now());
    this.#schedule(() => {
      void this.#flushMerger(input.threadId, sessionID, true);
    }, this.#delivery.settings.mergeWindowMs + 50);
    if (merger.due(this.#clock.now())) {
      await this.#flushMerger(input.threadId, sessionID, false);
    }
  }

  /** Route one owner callback query to pickers or the interactions layer. */
  async handleCallback(query: TelegramCallbackQuery): Promise<void> {
    if (query.data === undefined) return;
    const threadId = query.message?.message_thread_id;
    if (threadId === undefined) return;
    if (query.data.startsWith("vvocnp:")) {
      await this.#pickProject(query, threadId, Number(query.data.slice("vvocnp:".length)));
      return;
    }
    if (query.data.startsWith("vvocm:")) {
      await this.#pickModel(query, threadId, query.data.slice("vvocm:".length));
      return;
    }
    if (query.data.startsWith("vvocmsg:")) {
      await this.#pickMessage(query, threadId, query.data.slice("vvocmsg:".length));
      return;
    }
    if (query.data.startsWith("vvocs:")) {
      await this.#toggleSetting(query, threadId, query.data.slice("vvocs:".length));
      return;
    }
    await this.#interactions.handleCallback(query);
  }

  async #command(threadId: number, raw: string): Promise<void> {
    const [command, ...rest] = raw.slice(1).split(/\s+/);
    const argument = rest.join(" ").trim();
    const body = command?.split("@")[0] ?? "";
    const sessionID = this.#topology.sessionFor(threadId);

    switch (body) {
      case "new": {
        if (threadId !== this.#topology.generalThreadId) {
          await this.#delivery.sendTransient({ threadId, text: "ℹ️ /new lives in General" });
          return;
        }
        await this.#startProjectPicker(threadId);
        return;
      }
      case "sync": {
        await this.#bridge.resync();
        const sessions = await this.#reads.listSessions();
        const running = new Set(await this.#reads.activeSessionIds());
        const active = sessions.filter(
          (session) =>
            running.has(session.id) ||
            this.#topology.isActive(session.id, {
              running: false,
              timeUpdatedMs: session.timeUpdatedMs,
            }),
        );
        const report = await this.#topology.reconcile(
          active.map((session) => ({
            sessionID: session.id,
            title: session.title ?? session.id,
            timeUpdatedMs: session.timeUpdatedMs,
            running: running.has(session.id),
          })),
        );
        await this.#delivery.sendTransient({
          threadId,
          text: `🔄 synced: ${report.created} created, ${report.closed} closed, ${report.reused} reused, ${report.failures} failed`,
        });
        return;
      }
      case "status": {
        const sessions = await this.#reads.listSessions();
        const running = new Set(await this.#reads.activeSessionIds());
        if (sessionID === undefined) {
          const lines = sessions
            .filter(
              (session) =>
                running.has(session.id) ||
                this.#topology.isActive(session.id, {
                  running: false,
                  timeUpdatedMs: session.timeUpdatedMs,
                }),
            )
            .map(
              (session) =>
                `${running.has(session.id) ? "⚙️" : "💤"} ${session.title ?? session.id}${this.#topology.topicIdFor(session.id) === undefined ? " (no topic)" : ""}`,
            );
          await this.#delivery.sendTransient({
            threadId,
            text: `📊 active sessions (${lines.length}):\n${lines.length > 0 ? lines.join("\n") : "none"}`,
          });
          return;
        }
        const session = sessions.find((entry) => entry.id === sessionID);
        await this.#delivery.sendTransient({
          threadId,
          text: `📊 ${session?.title ?? sessionID}\nstate: ${running.has(sessionID) ? "running" : "idle"}\nsession: ${sessionID}`,
        });
        return;
      }
      case "help": {
        await this.#delivery.sendTransient({
          threadId,
          text: [
            "General: /new, /sync, /status, /help, /settings",
            "Session topic: text = prompt, /model, /rename <title>, /messages, /abort",
            "Answers: buttons on prompts; ✍️ Custom then plain text (/cancel aborts)",
          ].join("\n"),
        });
        return;
      }
      case "settings": {
        const settings = this.#delivery.settings;
        await this.#transport.sendMessage({
          threadId,
          text: "⚙️ settings",
          replyMarkup: [
            [
              {
                text: `reasoning: ${settings.showReasoning ? "on" : "off"}`,
                callbackData: "vvocs:reasoning",
              },
              {
                text: `tool calls: ${settings.showToolCalls ? "on" : "off"}`,
                callbackData: "vvocs:tools",
              },
            ],
            [{ text: `format: ${settings.formatMode}`, callbackData: "vvocs:format" }],
          ],
        });
        return;
      }
      case "model": {
        if (sessionID === undefined) return;
        const models = await this.#models.listModels();
        const providers = [...new Set(models.map((model) => model.providerID))];
        await this.#transport.sendMessage({
          threadId,
          text: "🗂 pick a provider",
          replyMarkup: providers
            .slice(0, 20)
            .map((provider, index) => [{ text: provider, callbackData: `vvocm:prov:${index}` }]),
        });
        this.#providerCache.set(threadId, providers);
        this.#modelCache.set(threadId, models);
        return;
      }
      case "rename": {
        if (sessionID === undefined || argument.length === 0) return;
        const bounded = argument.slice(0, 120);
        await this.#topology.setStatus(sessionID, "none", bounded);
        await this.#bridge.adoptSession({ sessionID, title: bounded });
        await this.#delivery.sendTransient({ threadId, text: `✏️ renamed to ${bounded}` });
        return;
      }
      case "messages": {
        if (sessionID === undefined) return;
        const messages = await this.#history.listUserMessages({ sessionID });
        if (messages.length === 0) {
          await this.#delivery.sendTransient({ threadId, text: "📭 no user messages" });
          return;
        }
        this.#messageCache.set(
          threadId,
          messages.map((message) => ({ ...message })),
        );
        await this.#transport.sendMessage({
          threadId,
          text: "📜 pick a message",
          replyMarkup: messages.slice(0, 15).map((message, index) => [
            {
              text: message.text.slice(0, 48) || "(empty)",
              callbackData: `vvocmsg:open:${index}`,
            },
          ]),
        });
        return;
      }
      case "abort": {
        if (sessionID === undefined) return;
        await this.#bridge.abort(sessionID);
        await this.#delivery.sendTransient({ threadId, text: "⏹ aborted" });
        return;
      }
      default: {
        await this.#delivery.sendTransient({ threadId, text: `🤷 unknown command /${body}` });
      }
    }
  }

  readonly #providerCache = new Map<number, readonly string[]>();
  readonly #modelCache = new Map<number, readonly { providerID: string; modelID: string }[]>();
  readonly #messageCache = new Map<number, { messageID: string; text: string }[]>();

  async #startProjectPicker(threadId: number): Promise<void> {
    const projects = await this.#projects.listProjects();
    if (projects.length === 0) {
      await this.#delivery.sendTransient({ threadId, text: "📭 no known projects" });
      return;
    }
    this.#projectCache.set(
      threadId,
      projects.map((project) => ({ ...project })),
    );
    await this.#transport.sendMessage({
      threadId,
      text: "📁 pick a project",
      replyMarkup: projects.slice(0, 15).map((project, index) => [
        {
          text: project.directory.split("/").pop() ?? project.directory,
          callbackData: `vvocnp:${index}`,
        },
      ]),
    });
  }

  readonly #projectCache = new Map<number, readonly { id: string; directory: string }[]>();

  async #pickProject(query: TelegramCallbackQuery, threadId: number, index: number): Promise<void> {
    const project = this.#projectCache.get(threadId)?.[index];
    if (project === undefined) {
      await this.#transport.answerCallback(query.id, "stale picker");
      return;
    }
    const created = await this.#projects.createSession({ directory: project.directory });
    await this.#bridge.adoptSession({
      sessionID: created.id,
      title: project.directory.split("/").pop() ?? created.id,
    });
    await this.#transport.answerCallback(query.id, "session created");
    const topicId = this.#topology.topicIdFor(created.id);
    await this.#delivery.sendTransient({
      threadId,
      text: `✅ session created — continue in its topic (${topicId ?? "?"})`,
    });
  }

  async #pickModel(query: TelegramCallbackQuery, threadId: number, payload: string): Promise<void> {
    const sessionID = this.#topology.sessionFor(threadId);
    if (sessionID === undefined) return;
    const parts = payload.split(":");
    if (parts[0] === "prov") {
      const provider = this.#providerCache.get(threadId)?.[Number(parts[1])];
      const models = this.#modelCache
        .get(threadId)
        ?.filter((model) => model.providerID === provider);
      if (provider === undefined || models === undefined || models.length === 0) {
        await this.#transport.answerCallback(query.id, "stale picker");
        return;
      }
      await this.#transport.answerCallback(query.id, provider);
      await this.#transport.sendMessage({
        threadId,
        text: `🧠 models of ${provider}`,
        replyMarkup: models
          .slice(0, 20)
          .map((model, index) => [
            { text: model.modelID.slice(0, 48), callbackData: `vvocm:model:${index}` },
          ]),
      });
      this.#modelSelection.set(threadId, models);
      return;
    }
    if (parts[0] === "model") {
      const model = this.#modelSelection.get(threadId)?.[Number(parts[1])];
      if (model === undefined) {
        await this.#transport.answerCallback(query.id, "stale picker");
        return;
      }
      await this.#bridge.switchModel({ sessionID, model });
      await this.#transport.answerCallback(query.id, `switched to ${model.modelID}`);
      await this.#delivery.sendTransient({
        threadId,
        text: `🧠 model switched to ${model.providerID}/${model.modelID}`,
      });
      return;
    }
    await this.#transport.answerCallback(query.id, "unknown");
  }

  readonly #modelSelection = new Map<number, readonly { providerID: string; modelID: string }[]>();

  async #pickMessage(
    query: TelegramCallbackQuery,
    threadId: number,
    payload: string,
  ): Promise<void> {
    const sessionID = this.#topology.sessionFor(threadId);
    if (sessionID === undefined) return;
    const parts = payload.split(":");
    const message = this.#messageCache.get(threadId)?.[Number(parts[1])];
    if (parts[0] !== "open" && parts[0] !== "revert" && parts[0] !== "fork") return;
    if (parts[0] === "open") {
      if (message === undefined) {
        await this.#transport.answerCallback(query.id, "stale");
        return;
      }
      await this.#transport.answerCallback(query.id, "message");
      await this.#transport.sendMessage({
        threadId,
        text: message.text.slice(0, 3_000),
        replyMarkup: [
          [
            { text: "⏪ Revert here", callbackData: `vvocmsg:revert:${parts[1]}` },
            { text: "🌿 Fork here", callbackData: `vvocmsg:fork:${parts[1]}` },
          ],
        ],
      });
      return;
    }
    if (message === undefined) {
      await this.#transport.answerCallback(query.id, "stale");
      return;
    }
    if (parts[0] === "revert") {
      await this.#history.revert({ sessionID, messageID: message.messageID });
      await this.#transport.answerCallback(query.id, "reverted");
      await this.#delivery.sendTransient({ threadId, text: "⏪ session reverted" });
      return;
    }
    const forked = await this.#history.fork({ sessionID, messageID: message.messageID });
    await this.#bridge.adoptSession({
      sessionID: forked.id,
      title: `fork of ${sessionID.slice(-6)}`,
    });
    await this.#transport.answerCallback(query.id, "forked");
    await this.#delivery.sendTransient({ threadId, text: `🌿 forked session ${forked.id}` });
  }

  async #toggleSetting(query: TelegramCallbackQuery, threadId: number, key: string): Promise<void> {
    const settings = this.#delivery.settings;
    if (key === "reasoning") {
      await this.#delivery.updateSettings({ showReasoning: !settings.showReasoning });
    } else if (key === "tools") {
      await this.#delivery.updateSettings({ showToolCalls: !settings.showToolCalls });
    } else if (key === "format") {
      await this.#delivery.updateSettings({
        formatMode: settings.formatMode === "markdown" ? "raw" : "markdown",
      });
    } else {
      await this.#transport.answerCallback(query.id, "unknown setting");
      return;
    }
    await this.#transport.answerCallback(query.id, "updated");
    await this.#delivery.sendTransient({ threadId, text: "⚙️ setting updated" });
  }

  #mergerFor(threadId: number): TelegramInputMerger {
    let merger = this.#mergers.get(threadId);
    if (merger === undefined) {
      merger = new TelegramInputMerger(this.#delivery.settings.mergeWindowMs);
      this.#mergers.set(threadId, merger);
    }
    return merger;
  }

  async #flushMerger(threadId: number, sessionID: string, forced: boolean): Promise<void> {
    const merger = this.#mergers.get(threadId);
    if (merger === undefined) return;
    const text = forced ? merger.flush() : merger.take(this.#clock.now());
    if (text === null || text.trim().length === 0) return;
    await this.#bridge.promptFromTelegram({ sessionID, text });
  }

  async #promptWithAttachments(
    sessionID: string,
    threadId: number,
    caption: string,
    attachments: readonly {
      readonly fileId: string;
      readonly filename: string | undefined;
      readonly mimeType: string | undefined;
    }[],
  ): Promise<void> {
    if (attachments.length > this.#maxAttachments) {
      await this.#delivery.sendTransient({
        threadId,
        text: `⚠️ too many attachments (max ${this.#maxAttachments}); nothing sent`,
      });
      return;
    }
    const files: NativePromptFile[] = [];
    for (const attachment of attachments) {
      try {
        const bytes = await this.#transport.downloadFile(
          attachment.fileId,
          this.#maxAttachmentBytes,
        );
        files.push({
          filename: attachment.filename ?? `attachment-${files.length + 1}`,
          mimeType: attachment.mimeType ?? "application/octet-stream",
          base64: Buffer.from(bytes).toString("base64"),
        });
      } catch {
        await this.#delivery.sendTransient({
          threadId,
          text: `⚠️ attachment ${attachment.filename ?? attachment.fileId} exceeded the size cap and was rejected`,
        });
      }
    }
    if (files.length === 0) return;
    await this.#bridge.promptFromTelegram({
      sessionID,
      text: caption.length > 0 ? caption : `(see ${files.length} attachment(s))`,
      files,
    });
  }
}
