// FILE: src/plugins/telegram/sessions.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Bridge native OpenCode sessions to Telegram topics: route live events to owning topics, rebuild the active set from native reads on startup and after any stream break, admit prompts and aborts, apply model switches, stream assistant turns, and render subagent cards.
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
//   decodePartTextEvent - Pure decoder for streamed assistant text parts.
//   decodeInteractionEvent - Pure decoder for permission and question lifecycle facts.
//   SessionBridge - Event pump, resync, prompt and abort admission, and status routing.
//   NativePromptFile - File attachment admitted into a native prompt.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-TELEGRAM-BRIDGE-PLUGIN T-005 - Created the session bridge with structural event decoding, per-event containment, resync after stream breaks, prompt, abort, and model-switch admission, streamed turns, and bounded subagent cards.]
// END_CHANGE_SUMMARY

import type { TelegramDelivery } from "./delivery.js";
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
    messageID: readString(record.messageID) ?? readString(record.id),
  };
}

/** Pure decoder for streamed assistant text parts. */
export function decodePartTextEvent(data: unknown): {
  readonly sessionID: string | undefined;
  readonly messageID: string | undefined;
  readonly text: string | undefined;
} {
  const record = asRecord(data) ?? {};
  const part = asRecord(record.part);
  return {
    sessionID: readString(record.sessionID),
    messageID:
      readString(record.messageID) ?? (part === undefined ? undefined : readString(part.messageID)),
    text: part === undefined ? undefined : readString(part.text),
  };
}

/** Pure decoder for permission and question lifecycle facts. */
export function decodeInteractionEvent(data: unknown): {
  readonly sessionID: string | undefined;
  readonly id: string | undefined;
  readonly phase: "requested" | "resolved";
  readonly text: string | undefined;
  readonly options: readonly string[];
} {
  const record = asRecord(data) ?? {};
  const type = readString(record.type);
  const resolved =
    type?.endsWith("resolved") === true ||
    type?.endsWith("updated") === true ||
    readString(record.status)?.length !== undefined;
  return {
    sessionID: readString(record.sessionID),
    id: readString(record.requestID) ?? readString(record.id) ?? readString(record.questionID),
    phase: resolved ? "resolved" : "requested",
    text: readString(record.summary) ?? readString(record.prompt) ?? readString(record.text),
    options: Array.isArray(record.options)
      ? record.options.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
}
// END_BLOCK_DECODERS

interface TurnState {
  readonly draftId: number;
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

    if (type === "session.step.started") {
      const decoded = decodeStepEvent(data);
      if (decoded.sessionID === undefined) return;
      if (this.#topology.topicIdFor(decoded.sessionID) === undefined) return;
      this.#draftSeq += 1;
      this.#turns.set(decoded.sessionID, { draftId: 500_000 + this.#draftSeq, buffer: "" });
      const threadId = this.#topology.topicIdFor(decoded.sessionID);
      if (threadId !== undefined)
        this.#delivery.beginTurn({ threadId, draftId: 500_000 + this.#draftSeq });
      await this.#applyStatus(decoded.sessionID, "running");
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
          nativeMessageId: decoded.messageID ?? `${decoded.sessionID}:${this.#clock.now()}`,
          text: turn.buffer,
        });
      }
      if (threadId !== undefined) await this.#delivery.endTurn(threadId);
      this.#turns.delete(decoded.sessionID);
      await this.#applyStatus(decoded.sessionID, type === "session.step.failed" ? "error" : "idle");
      return;
    }

    if (type === "message.updated" || type === "message.part.updated") {
      const decoded = decodePartTextEvent(data);
      if (decoded.sessionID === undefined || decoded.text === undefined) return;
      const turn = this.#turns.get(decoded.sessionID);
      const threadId = this.#topology.topicIdFor(decoded.sessionID);
      if (turn === undefined || threadId === undefined) return;
      turn.buffer = decoded.text;
      await this.#delivery.streamText(threadId, decoded.text);
      return;
    }

    if (type.startsWith("permission.")) {
      const decoded = decodeInteractionEvent(data);
      if (decoded.sessionID === undefined) return;
      await this.#interactions?.onPermissionEvent({
        sessionID: decoded.sessionID,
        requestID: decoded.id,
        phase: decoded.phase,
        summary: decoded.text,
      });
      if (decoded.phase === "requested") {
        await this.#applyStatus(decoded.sessionID, "permission");
      }
      return;
    }

    if (type.startsWith("question.")) {
      const decoded = decodeInteractionEvent(data);
      if (decoded.sessionID === undefined) return;
      await this.#interactions?.onQuestionEvent({
        sessionID: decoded.sessionID,
        questionID: decoded.id,
        phase: decoded.phase,
        prompt: decoded.text,
        options: decoded.options,
      });
      if (decoded.phase === "requested") {
        await this.#applyStatus(decoded.sessionID, "question");
      }
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
