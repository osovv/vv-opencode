// FILE: src/plugins/telegram/sessions.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Bridge native OpenCode sessions to Telegram topics over the real V2 event vocabulary: route session, step, text-delta, inbox, tool, execution, permission, and form events to owning topics, rebuild the active set from native reads on startup and after any stream break, admit prompts and aborts, apply model switches, stream assistant turns from text deltas, echo admitted user prompts as quoted messages, and render subagent cards.
//   SCOPE: Injectable native read, action, and event-stream boundaries; structural decoding without casting for session lifecycle, step, part-text, permission, question, and child-session events; per-event failure containment; status transitions through the throttled topology titles; resync driving topology reconcile and delivery drain; bounded child-session cards in the parent topic.
//   DEPENDS: [src/plugins/telegram/topology.ts, src/plugins/telegram/delivery.ts]
//   LINKS: [M-TELEGRAM-GATEWAY, M-TELEGRAM-TOPICS, M-TELEGRAM-DELIVERY, V-M-TELEGRAM-GATEWAY]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   NativeSessionSummary - Structural native session facts the bridge reads.
//   NativeEventEnvelope - Structural native event envelope the pump consumes.
//   NativeSessionReads - Injectable native session read boundary.
//   NativeSessionActions - Injectable native prompt, interrupt, and model-switch boundary.
//   NativeEventStream - Injectable live event subscription boundary.
//   BridgeInteractions - Sink the interactions layer registers for permission and question events.
//   decodeSessionEvent - Pure decoder for session lifecycle facts.
//   decodeStepEvent - Pure decoder for step start, end, and failure facts.
//   decodeTextStreamEvent - Pure decoder for streamed assistant text deltas and completed text parts.
//   decodeInboxEvent - Pure decoder for inbox admission of user prompts.
//   decodeToolCallEvent - Pure decoder for tool call starts.
//   decodePermissionEvent - Pure decoder for permission lifecycle facts.
//   DecodedFormFieldOption - One decoded form field option.
//   DecodedFormField - One decoded form field of the kinds the bridge can answer.
//   decodeFormEvent - Pure decoder for form lifecycle facts.
//   SessionBridge - Event pump, resync, prompt and abort admission, and status routing.
//   NativePromptFile - File attachment admitted into a native prompt.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [DIRECT-FIX - Rewrote event routing onto the real V2 vocabulary: session.text.delta/ended streaming, session.inbox.enqueued/delivered user-prompt echo, session.execution statuses, session.tool.called transients, and permission.asked plus form.created interactions.]
// END_CHANGE_SUMMARY

import type { TelegramDelivery } from "./delivery.js";
import { formatUserQuote } from "./delivery.js";
import type { SessionActivityView, TelegramTopology } from "./topology.js";
import type { SessionStatus } from "./topology.js";

/** Structural native session facts the bridge reads. */
export interface NativeSessionSummary {
  readonly id: string;
  readonly title: string | undefined;
  readonly timeCreatedMs: number;
  readonly timeUpdatedMs: number;
  readonly parentID: string | undefined;
}

/** Structural native event envelope the pump consumes. */
export interface NativeEventEnvelope {
  readonly type?: unknown;
  readonly data?: unknown;
}

/** Injectable native session read boundary. */
export interface NativeSessionReads {
  listSessions(): Promise<readonly NativeSessionSummary[]>;
  activeSessionIds(): Promise<readonly string[]>;
}

/** File attachment admitted into a native prompt. */
export interface NativePromptFile {
  readonly filename: string;
  readonly mimeType: string;
  readonly base64: string;
}

/** Injectable native prompt, interrupt, and model-switch boundary. */
export interface NativeSessionActions {
  prompt(input: {
    readonly sessionID: string;
    readonly text: string;
    readonly delivery: "steer" | "queue";
    readonly files?: readonly NativePromptFile[];
  }): Promise<{ readonly messageID: string }>;
  interrupt(input: { readonly sessionID: string }): Promise<void>;
  switchModel(input: {
    readonly sessionID: string;
    readonly model: { readonly providerID: string; readonly modelID: string };
  }): Promise<void>;
}

/** Injectable live event subscription boundary. */
export interface NativeEventStream {
  subscribe(signal?: AbortSignal): AsyncIterable<NativeEventEnvelope>;
}

/** Sink the interactions layer registers for permission and question events. */
export interface BridgeInteractions {
  onPermissionEvent(input: {
    readonly sessionID: string;
    readonly requestID: string | undefined;
    readonly phase: "requested" | "resolved";
    readonly summary: string | undefined;
  }): void | Promise<void>;
  onQuestionEvent(input: {
    readonly sessionID: string;
    readonly questionID: string | undefined;
    readonly phase: "requested" | "resolved";
    readonly prompt: string | undefined;
    readonly options: readonly string[];
    readonly fields: readonly DecodedFormField[];
  }): void | Promise<void>;
}

// START_BLOCK_DECODERS
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readStrings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** Pure decoder for session lifecycle facts. */
export function decodeSessionEvent(data: unknown): {
  readonly sessionID: string | undefined;
  readonly title: string | undefined;
  readonly parentID: string | undefined;
} {
  const record = asRecord(data) ?? {};
  const nested = asRecord(record.info) ?? record;
  return {
    sessionID: readString(record.sessionID) ?? readString(nested.id),
    title: readString(record.title) ?? readString(nested.title),
    parentID: readString(record.parentID) ?? readString(nested.parentID),
  };
}

/** Pure decoder for step start, end, and failure facts. */
export function decodeStepEvent(data: unknown): {
  readonly sessionID: string | undefined;
  readonly messageID: string | undefined;
} {
  const record = asRecord(data) ?? {};
  return {
    sessionID: readString(record.sessionID),
    messageID:
      readString(record.assistantMessageID) ??
      readString(record.messageID) ??
      readString(record.id),
  };
}

/** Pure decoder for streamed assistant text deltas and completed text parts. */
export function decodeTextStreamEvent(data: unknown): {
  readonly sessionID: string | undefined;
  readonly assistantMessageID: string | undefined;
  readonly delta: string | undefined;
  readonly text: string | undefined;
} {
  const record = asRecord(data) ?? {};
  return {
    sessionID: readString(record.sessionID),
    assistantMessageID: readString(record.assistantMessageID),
    delta: typeof record.delta === "string" ? record.delta : undefined,
    text: typeof record.text === "string" ? record.text : undefined,
  };
}

/** Pure decoder for inbox admission: queued user input and its delivery into the session. */
export function decodeInboxEvent(data: unknown): {
  readonly inboxID: string | undefined;
  readonly sessionID: string | undefined;
  readonly text: string | undefined;
} {
  const record = asRecord(data) ?? {};
  const item = asRecord(record.item);
  const payload = asRecord(item?.payload);
  return {
    inboxID: readString(record.inboxID),
    sessionID:
      readString(record.sessionID) ?? (item === undefined ? undefined : readString(item.sessionID)),
    text: payload === undefined ? undefined : readString(payload.text),
  };
}

/** Pure decoder for tool call starts: name plus a bounded argument summary. */
export function decodeToolCallEvent(data: unknown): {
  readonly sessionID: string | undefined;
  readonly name: string | undefined;
  readonly argumentSummary: string | undefined;
} {
  const record = asRecord(data) ?? {};
  const input = asRecord(record.input) ?? {};
  let summary: string | undefined;
  try {
    const json = JSON.stringify(input);
    summary = json === "{}" ? undefined : json.length > 90 ? `${json.slice(0, 90)}…` : json;
  } catch {
    summary = undefined;
  }
  return {
    sessionID: readString(record.sessionID),
    name: readString(record.name),
    argumentSummary: summary,
  };
}

/** Pure decoder for permission lifecycle facts over the native permission.asked shape. */
export function decodePermissionEvent(data: unknown): {
  readonly sessionID: string | undefined;
  readonly requestID: string | undefined;
  readonly phase: "asked" | "replied";
  readonly summary: string | undefined;
} {
  const record = asRecord(data) ?? {};
  const resources = readStrings(record.resources);
  const action = readString(record.action) ?? readString(record.permission);
  return {
    sessionID: readString(record.sessionID),
    requestID: readString(record.id) ?? readString(record.requestID),
    phase: readString(record.reply) === undefined ? "asked" : "replied",
    summary: [action, ...resources].filter((part) => part !== undefined).join(" ") || undefined,
  };
}

/** One decoded form field option. */
export interface DecodedFormFieldOption {
  readonly label: string;
  readonly value: string;
}

/** One decoded form field of the kinds the bridge can answer. */
export interface DecodedFormField {
  readonly key: string;
  readonly kind: "choice" | "boolean" | "free";
  readonly question: string;
  readonly options: readonly DecodedFormFieldOption[];
  readonly custom: boolean;
}

/** Pure decoder for form lifecycle facts over the native form.created shape. */
export function decodeFormEvent(data: unknown): {
  readonly sessionID: string | undefined;
  readonly formID: string | undefined;
  readonly phase: "created" | "settled";
  readonly title: string | undefined;
  readonly fields: readonly DecodedFormField[];
} {
  const record = asRecord(data) ?? {};
  const form = asRecord(record.form) ?? record;
  const rawFields = Array.isArray(form.fields) ? form.fields : [];
  const fields: DecodedFormField[] = [];
  for (const entry of rawFields) {
    const field = asRecord(entry);
    const key = readString(field?.key);
    if (field === undefined || key === undefined) continue;
    const options: DecodedFormFieldOption[] = [];
    for (const rawOption of Array.isArray(field.options) ? field.options : []) {
      const option = asRecord(rawOption);
      const label = readString(option?.label) ?? readString(option?.value);
      if (option === undefined || label === undefined) continue;
      options.push({ label, value: readString(option?.value) ?? label });
    }
    const kind: DecodedFormField["kind"] =
      field.type === "boolean" ? "boolean" : options.length > 0 ? "choice" : "free";
    const question =
      readString(field.title) ?? readString(field.description) ?? readString(form.title) ?? key;
    fields.push({ key, kind, question, options, custom: field.custom === true || kind === "free" });
  }
  return {
    sessionID: readString(form.sessionID) ?? readString(record.sessionID),
    formID: readString(form.id) ?? readString(record.id),
    phase:
      readString(record.answers) !== undefined || record.answers === null ? "settled" : "created",
    title: readString(form.title),
    fields,
  };
}
// END_BLOCK_DECODERS

interface TurnState {
  readonly draftId: number;
  readonly assistantMessageID: string;
  buffer: string;
}

/**
 * Session bridge. The pump consumes the live-only native event stream with
 * per-event containment; a stream end always triggers a resync that rebuilds the
 * active set from native reads, reconciles topics, and drains pending finals,
 * so a missed live event can never leave a permanently stale topic set. Child
 * sessions render as bounded cards in the parent topic and never get topics.
 */
export class SessionBridge {
  readonly #topology: TelegramTopology;
  readonly #delivery: TelegramDelivery;
  readonly #reads: NativeSessionReads;
  readonly #actions: NativeSessionActions;
  readonly #events: NativeEventStream;
  readonly #clock: { now(): number };
  readonly #log: (level: "warn", message: string) => void;
  #interactions: BridgeInteractions | undefined;
  #abort: AbortController | undefined;
  #pump: Promise<void> | undefined;
  #statuses = new Map<string, SessionStatus>();
  #turns = new Map<string, TurnState>();
  readonly #inboxTexts = new Map<string, string>();
  #draftSeq = 0;

  constructor(deps: {
    topology: TelegramTopology;
    delivery: TelegramDelivery;
    reads: NativeSessionReads;
    actions: NativeSessionActions;
    events: NativeEventStream;
    clock: { now(): number };
    log?: (level: "warn", message: string) => void;
  }) {
    this.#topology = deps.topology;
    this.#delivery = deps.delivery;
    this.#reads = deps.reads;
    this.#actions = deps.actions;
    this.#events = deps.events;
    this.#clock = deps.clock;
    this.#log = deps.log ?? (() => undefined);
  }

  /** Register the permission and question sink; optional because the interactions layer is wired later. */
  setInteractions(interactions: BridgeInteractions | undefined): void {
    this.#interactions = interactions;
  }

  /** Start the event pump after an initial resync. */
  async start(): Promise<void> {
    await this.resync();
    this.#abort = new AbortController();
    const signal = this.#abort.signal;
    this.#pump = (async () => {
      try {
        for await (const event of this.#events.subscribe(signal)) {
          if (signal.aborted) break;
          try {
            await this.handleEvent(event);
          } catch (error) {
            this.#log(
              "warn",
              `event handling contained: ${error instanceof Error ? error.name : typeof error}`,
            );
          }
        }
      } catch {
        // The stream is live-only; falling out always triggers a resync below.
      }
      if (!signal.aborted) await this.resync();
    })();
  }

  /** Stop the pump; the returned promise settles when the loop exits. */
  async stop(): Promise<void> {
    this.#abort?.abort();
    await this.#pump?.catch(() => undefined);
    this.#pump = undefined;
    this.#abort = undefined;
  }

  /** Rebuild the active set from native reads, reconcile topics, refresh statuses, and drain finals. */
  async resync(): Promise<void> {
    const [sessions, activeIds] = await Promise.all([
      this.#reads.listSessions(),
      this.#reads.activeSessionIds(),
    ]);
    const running = new Set(activeIds);
    const views: SessionActivityView[] = [];
    for (const session of sessions) {
      const isRunning = running.has(session.id);
      if (
        !isRunning &&
        !this.#topology.isActive(session.id, {
          running: false,
          timeUpdatedMs: session.timeUpdatedMs,
        })
      ) {
        continue;
      }
      views.push({
        sessionID: session.id,
        title: session.title ?? session.id,
        timeUpdatedMs: session.timeUpdatedMs,
        running: isRunning,
      });
    }
    await this.#topology.reconcile(views);
    for (const view of views) {
      if (view.running) await this.#applyStatus(view.sessionID, "running", view.title);
    }
    await this.#delivery.drainPendingFinals();
  }

  /** Admit an owner prompt; bot usage advances the activity timestamp. */
  async promptFromTelegram(input: {
    readonly sessionID: string;
    readonly text: string;
    readonly delivery?: "steer" | "queue";
    readonly files?: readonly NativePromptFile[];
  }): Promise<{ readonly messageID: string }> {
    const admitted = await this.#actions.prompt({
      sessionID: input.sessionID,
      text: input.text,
      delivery: input.delivery ?? "steer",
      ...(input.files === undefined || input.files.length === 0 ? {} : { files: input.files }),
    });
    await this.#topology.touchSession(input.sessionID);
    await this.#applyStatus(input.sessionID, "running");
    return admitted;
  }

  /** Interrupt a session and mark it aborted. */
  async abort(sessionID: string): Promise<void> {
    await this.#actions.interrupt({ sessionID });
    await this.#applyStatus(sessionID, "aborted");
  }

  /** Switch the session model and reflect it in the topic lane. */
  async switchModel(input: {
    readonly sessionID: string;
    readonly model: { readonly providerID: string; readonly modelID: string };
  }): Promise<void> {
    await this.#actions.switchModel(input);
    await this.#topology.touchSession(input.sessionID);
  }

  /** Create a session topic explicitly for a session adopted through the bot. */
  async adoptSession(input: {
    readonly sessionID: string;
    readonly title: string;
  }): Promise<number> {
    const threadId = await this.#topology.openTopicForSession(input.sessionID, input.title);
    await this.#topology.touchSession(input.sessionID);
    return threadId;
  }

  async #applyStatus(sessionID: string, status: SessionStatus, title?: string): Promise<void> {
    if (this.#statuses.get(sessionID) === status && title === undefined) return;
    this.#statuses.set(sessionID, status);
    await this.#topology.setStatus(sessionID, status, title);
  }

  /** Route one decoded event; unknown types and undecodable envelopes are ignored silently. */
  async handleEvent(event: NativeEventEnvelope): Promise<void> {
    if (typeof event !== "object" || event === null) return;
    const type = readString(event.type);
    if (type === undefined) return;
    const data = event.data;

    if (type === "session.created" || type === "session.updated" || type === "session.renamed") {
      const decoded = decodeSessionEvent(data);
      if (decoded.sessionID === undefined) return;
      if (decoded.parentID !== undefined) {
        await this.#renderChildCard(
          decoded.parentID,
          decoded.sessionID,
          decoded.title ?? "subagent",
        );
        return;
      }
      if (this.#topology.topicIdFor(decoded.sessionID) !== undefined) {
        const status = this.#statuses.get(decoded.sessionID) ?? "idle";
        await this.#applyStatus(decoded.sessionID, status, decoded.title);
      }
      return;
    }

    if (type === "session.execution.started") {
      const decoded = decodeStepEvent(data);
      if (decoded.sessionID === undefined) return;
      await this.#applyStatus(decoded.sessionID, "running");
      return;
    }

    if (
      type === "session.execution.succeeded" ||
      type === "session.execution.interrupted" ||
      type === "session.execution.failed"
    ) {
      const decoded = decodeStepEvent(data);
      if (decoded.sessionID === undefined) return;
      await this.#applyStatus(
        decoded.sessionID,
        type === "session.execution.interrupted"
          ? "aborted"
          : type === "session.execution.failed"
            ? "error"
            : "idle",
      );
      return;
    }

    if (type === "session.step.started") {
      const decoded = decodeStepEvent(data);
      if (decoded.sessionID === undefined || decoded.messageID === undefined) return;
      if (this.#topology.topicIdFor(decoded.sessionID) === undefined) return;
      this.#draftSeq += 1;
      this.#turns.set(decoded.sessionID, {
        draftId: 500_000 + this.#draftSeq,
        assistantMessageID: decoded.messageID,
        buffer: "",
      });
      const threadId = this.#topology.topicIdFor(decoded.sessionID);
      if (threadId !== undefined)
        this.#delivery.beginTurn({ threadId, draftId: 500_000 + this.#draftSeq });
      return;
    }

    if (type === "session.step.ended" || type === "session.step.failed") {
      const decoded = decodeStepEvent(data);
      if (decoded.sessionID === undefined) return;
      const turn = this.#turns.get(decoded.sessionID);
      const threadId = this.#topology.topicIdFor(decoded.sessionID);
      if (turn !== undefined && threadId !== undefined && turn.buffer.trim().length > 0) {
        await this.#delivery.deliverFinal({
          threadId,
          nativeMessageId: turn.assistantMessageID,
          text: turn.buffer,
        });
      }
      if (threadId !== undefined) await this.#delivery.endTurn(threadId);
      this.#turns.delete(decoded.sessionID);
      return;
    }

    if (type === "session.text.delta" || type === "session.text.ended") {
      const decoded = decodeTextStreamEvent(data);
      if (decoded.sessionID === undefined || decoded.assistantMessageID === undefined) return;
      const turn = this.#turns.get(decoded.sessionID);
      const threadId = this.#topology.topicIdFor(decoded.sessionID);
      if (turn === undefined || threadId === undefined) return;
      if (decoded.text !== undefined) {
        turn.buffer = decoded.text;
      } else if (decoded.delta !== undefined) {
        turn.buffer += decoded.delta;
      }
      await this.#delivery.streamText(threadId, turn.buffer);
      return;
    }

    if (type === "session.reasoning.ended") {
      // Reasoning stays hidden unless the owner turned it on; when shown it lands as one line.
      const decoded = decodeTextStreamEvent(data);
      if (!this.#delivery.settings.showReasoning) return;
      if (decoded.sessionID === undefined || decoded.text === undefined) return;
      const threadId = this.#topology.topicIdFor(decoded.sessionID);
      if (threadId === undefined) return;
      await this.#delivery.sendTransient({
        threadId,
        text: `💭 ${decoded.text.length > 400 ? `${decoded.text.slice(0, 400)}…` : decoded.text}`,
      });
      return;
    }

    if (type === "session.inbox.enqueued") {
      const decoded = decodeInboxEvent(data);
      if (decoded.inboxID === undefined || decoded.text === undefined) return;
      this.#inboxTexts.set(decoded.inboxID, decoded.text);
      return;
    }

    if (type === "session.inbox.delivered") {
      const decoded = decodeInboxEvent(data);
      if (decoded.inboxID === undefined) return;
      const text = this.#inboxTexts.get(decoded.inboxID) ?? decoded.text;
      this.#inboxTexts.delete(decoded.inboxID);
      if (decoded.sessionID === undefined || text === undefined) return;
      const threadId = this.#topology.topicIdFor(decoded.sessionID);
      if (threadId === undefined) return;
      await this.#delivery.deliverFinal({
        threadId,
        nativeMessageId: decoded.inboxID,
        text: formatUserQuote(text, false),
        role: "user",
      });
      await this.#topology.touchSession(decoded.sessionID);
      return;
    }

    if (type === "session.tool.called") {
      const decoded = decodeToolCallEvent(data);
      if (!this.#delivery.settings.showToolCalls) return;
      if (decoded.sessionID === undefined || decoded.name === undefined) return;
      const threadId = this.#topology.topicIdFor(decoded.sessionID);
      if (threadId === undefined) return;
      const args = decoded.argumentSummary === undefined ? "" : ` ${decoded.argumentSummary}`;
      await this.#delivery.sendTransient({ threadId, text: `🔧 ${decoded.name}${args}` });
      return;
    }

    if (type === "permission.asked" || type === "permission.replied") {
      const decoded = decodePermissionEvent(data);
      if (decoded.sessionID === undefined) return;
      await this.#interactions?.onPermissionEvent({
        sessionID: decoded.sessionID,
        requestID: decoded.requestID,
        phase: decoded.phase === "asked" ? "requested" : "resolved",
        summary: decoded.summary,
      });
      if (decoded.phase === "asked") {
        await this.#applyStatus(decoded.sessionID, "permission");
      } else {
        await this.#applyStatus(decoded.sessionID, "running");
      }
      return;
    }

    if (type === "form.created") {
      const decoded = decodeFormEvent(data);
      if (decoded.sessionID === undefined || decoded.formID === undefined) return;
      const first = decoded.fields[0];
      await this.#interactions?.onQuestionEvent({
        sessionID: decoded.sessionID,
        questionID: decoded.formID,
        phase: "requested",
        prompt: first?.question ?? decoded.title ?? "question",
        options: first?.kind === "choice" ? first.options.map((option) => option.label) : [],
        fields: decoded.fields,
      });
      await this.#applyStatus(decoded.sessionID, "question");
      return;
    }

    if (type === "form.replied" || type === "form.cancelled") {
      const decoded = decodeFormEvent(data);
      if (decoded.sessionID === undefined || decoded.formID === undefined) return;
      await this.#interactions?.onQuestionEvent({
        sessionID: decoded.sessionID,
        questionID: decoded.formID,
        phase: "resolved",
        prompt: undefined,
        options: [],
        fields: [],
      });
      await this.#applyStatus(decoded.sessionID, "running");
      return;
    }
  }

  async #renderChildCard(parentID: string, childID: string, title: string): Promise<void> {
    const threadId = this.#topology.topicIdFor(parentID);
    if (threadId === undefined) return;
    const bounded = title.length > 80 ? `${title.slice(0, 80)}…` : title;
    await this.#delivery.sendTransient({ threadId, text: `🤖 ${bounded} (${childID.slice(-6)})` });
  }
}
