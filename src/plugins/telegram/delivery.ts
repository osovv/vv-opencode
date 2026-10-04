// FILE: src/plugins/telegram/delivery.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Own message delivery for the Telegram bridge: the durable mirror map, durable pending finals with boot-drain exactly-once semantics, draft streaming with a send-then-edit fallback, the adaptive stream throttle, the owner input merge window, persisted runtime settings, and final rendering including code-as-file extraction.
//   SCOPE: Injectable transport, store, clock, and notice boundaries; versioned storage keys for mirrors, the bounded outbox, and settings; pure splitting, throttle-schedule, merge-window, and user-quote helpers; per-message failure containment with one bounded notice per pending record.
//   DEPENDS: [src/plugins/telegram/bot-api.ts, src/plugins/telegram/config.ts, src/plugins/telegram/topology.ts]
//   LINKS: [M-TELEGRAM-DELIVERY, M-TELEGRAM-BOT-API, M-TELEGRAM-TOPICS, V-M-TELEGRAM-DELIVERY]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   MIRROR_PREFIX - Storage key prefix for message mirror rows.
//   OUTBOX_KEY - Storage key holding the bounded pending-finals queue.
//   SETTINGS_KEY - Storage key holding persisted runtime settings.
//   MAX_PENDING_FINALS - Hard cap on queued finals; the oldest entry drops beyond it.
//   STREAM_DELAY_STEPS - Adaptive throttle schedule: elapsed-time brackets to edit intervals.
//   DeliverySettings - Persisted runtime settings shape.
//   PendingFinal - Durable final record with attempt counting.
//   MirrorRow - Persisted native-to-Telegram message mirror row.
//   SplitFinal - Pure rendering result: remaining text plus extracted code files.
//   splitFinal - Extract oversized fenced code blocks into bounded file documents.
//   nextStreamDelayMs - Pure adaptive throttle interval for streamed edits.
//   formatUserQuote - Pure owner-quote projection for echoed prompts.
//   TelegramInputMerger - Fixed-window owner-text coalescer with due/take semantics.
//   TelegramDelivery - Delivery bound to injectable transport, store, and clock.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-TELEGRAM-BRIDGE-PLUGIN T-004 - Created the mirror-based delivery layer with draft streaming, edit fallback, durable exactly-once finals with boot-drain, adaptive throttle, merge window, persisted settings, and code-as-file rendering.]
// END_CHANGE_SUMMARY

import type { TelegramTransport } from "./bot-api.js";
import type { TelegramRuntimeSettings } from "./config.js";
import type { TelegramStore } from "./topology.js";
import { TelegramUnsupportedError } from "./bot-api.js";

/** Storage key prefix for message mirror rows. */
export const MIRROR_PREFIX = "telegram/v1/mirror/";

/** Storage key holding the bounded pending-finals queue. */
export const OUTBOX_KEY = "telegram/v1/outbox";

/** Storage key holding persisted runtime settings. */
export const SETTINGS_KEY = "telegram/v1/settings";

/** Hard cap on queued finals; the oldest entry drops beyond it. */
export const MAX_PENDING_FINALS = 500;

/** Adaptive throttle schedule: elapsed-time brackets to streamed-edit intervals. */
export const STREAM_DELAY_STEPS = [
  { withinMs: 60_000, delayMs: 1_000 },
  { withinMs: 180_000, delayMs: 2_000 },
  { withinMs: 600_000, delayMs: 5_000 },
] as const;

/** Persisted runtime settings shape. */
export type DeliverySettings = TelegramRuntimeSettings;

/** Durable final record with attempt counting for bounded notices. */
export interface PendingFinal {
  readonly id: string;
  readonly threadId: number;
  readonly nativeMessageId: string;
  readonly text: string;
  readonly role: "assistant" | "user";
  attempts: number;
}

/** Persisted native-to-Telegram message mirror row. */
export interface MirrorRow {
  readonly threadId: number;
  readonly tgMessageId: number;
  readonly role: "assistant" | "user";
}

/** Pure rendering result: remaining text plus extracted code files. */
export interface SplitFinal {
  readonly text: string;
  readonly files: readonly { readonly filename: string; readonly content: string }[];
}

// START_BLOCK_PURE_HELPERS
/** Extract fenced code blocks larger than the cap into bounded file documents. */
export function splitFinal(text: string, codeFileMaxKb: number): SplitFinal {
  const maxChars = codeFileMaxKb * 1024;
  const files: { filename: string; content: string }[] = [];
  let fileIndex = 0;
  const parts: string[] = [];
  const fence = /```([^\n`]*)\n([\s\S]*?)```/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text)) !== null) {
    parts.push(text.slice(cursor, match.index));
    const info = match[1]?.trim() ?? "";
    const code = match[2] ?? "";
    if (code.length > maxChars) {
      fileIndex += 1;
      const ext = info.length > 0 && /^[\w.+-]{1,10}$/.test(info) ? `.${info}` : ".txt";
      files.push({ filename: `code-${fileIndex}${ext}`, content: code });
      parts.push(`[code attached as code-${fileIndex}${ext}]`);
    } else {
      parts.push(match[0]);
    }
    cursor = match.index + match[0].length;
  }
  parts.push(text.slice(cursor));
  return { text: parts.join("").trim(), files };
}

/** Pure adaptive throttle interval for streamed edits over a turn's lifetime. */
export function nextStreamDelayMs(elapsedMs: number): number {
  for (const step of STREAM_DELAY_STEPS) {
    if (elapsedMs < step.withinMs) return step.delayMs;
  }
  return 10_000;
}

/** Pure owner-quote projection for echoed prompts. */
export function formatUserQuote(text: string, voice: boolean): string {
  const marker = voice ? "🎙" : "👤";
  const body = text.trim().length > 0 ? text.trim() : "(empty)";
  return `${marker} ${body}`;
}
// END_BLOCK_PURE_HELPERS

/** Fixed-window owner-text coalescer: the window opens on the first text and take() joins everything collected. */
export class TelegramInputMerger {
  readonly #windowMs: number;
  #openedAtMs: number | null = null;
  #buffer: string[] = [];

  constructor(windowMs: number) {
    this.#windowMs = windowMs;
  }

  add(text: string, nowMs: number): void {
    if (this.#openedAtMs === null) this.#openedAtMs = nowMs;
    this.#buffer.push(text);
  }

  due(nowMs: number): boolean {
    if (this.#openedAtMs === null) return false;
    return nowMs - this.#openedAtMs >= this.#windowMs;
  }

  /** Join and clear the buffer when due; otherwise return null. */
  take(nowMs: number): string | null {
    if (!this.due(nowMs)) return null;
    const joined = this.#buffer.join("\n");
    this.#buffer = [];
    this.#openedAtMs = null;
    return joined;
  }

  /** Force-join and clear regardless of the window. */
  flush(): string | null {
    if (this.#buffer.length === 0) return null;
    const joined = this.#buffer.join("\n");
    this.#buffer = [];
    this.#openedAtMs = null;
    return joined;
  }
}

interface StreamState {
  readonly draftId: number;
  readonly turnStartMs: number;
  placeholderMessageId: number | undefined;
  draftsDisabled: boolean;
  lastEditMs: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeMirror(value: unknown): MirrorRow | undefined {
  if (!isPlainObject(value)) return undefined;
  const threadId = value.threadId;
  const tgMessageId = value.tgMessageId;
  const role = value.role;
  if (typeof threadId !== "number" || typeof tgMessageId !== "number") return undefined;
  if (role !== "assistant" && role !== "user") return undefined;
  return { threadId, tgMessageId, role };
}

function decodePending(value: unknown): PendingFinal | undefined {
  if (!isPlainObject(value)) return undefined;
  const id = value.id;
  const threadId = value.threadId;
  const nativeMessageId = value.nativeMessageId;
  const text = value.text;
  const role = value.role;
  const attempts = value.attempts;
  if (
    typeof id !== "string" ||
    typeof threadId !== "number" ||
    typeof nativeMessageId !== "string" ||
    typeof text !== "string"
  ) {
    return undefined;
  }
  return {
    id,
    threadId,
    nativeMessageId,
    text,
    role: role === "user" ? "user" : "assistant",
    attempts: typeof attempts === "number" ? attempts : 0,
  };
}

function decodeSettings(value: unknown, fallback: DeliverySettings): DeliverySettings {
  if (!isPlainObject(value)) return fallback;
  return {
    showReasoning: value.showReasoning === true,
    showToolCalls: value.showToolCalls === true,
    formatMode: value.formatMode === "raw" ? "raw" : "markdown",
    codeFileMaxKb:
      typeof value.codeFileMaxKb === "number" && value.codeFileMaxKb > 0
        ? value.codeFileMaxKb
        : fallback.codeFileMaxKb,
    mergeWindowMs:
      typeof value.mergeWindowMs === "number" && value.mergeWindowMs >= 0
        ? value.mergeWindowMs
        : fallback.mergeWindowMs,
  };
}

/**
 * Delivery bound to injectable transport, store, and clock. Finals are durable:
 * a record is enqueued before the send, the mirror is written after it, and the
 * boot drain delivers records without mirrors exactly once per restart attempt.
 * Streaming uses drafts with a stable per-turn id and falls back to a
 * send-placeholder plus throttled edits once the transport reports drafts
 * unsupported. Every failure is contained per message with one bounded notice
 * per pending record.
 */
export class TelegramDelivery {
  readonly #transport: TelegramTransport;
  readonly #store: TelegramStore;
  readonly #clock: { now(): number };
  readonly #onNotice: (threadId: number, text: string) => void;
  readonly #defaults: DeliverySettings;
  readonly #mirrors = new Map<string, MirrorRow>();
  readonly #streams = new Map<number, StreamState>();
  #settings: DeliverySettings;
  #seq = 0;

  constructor(deps: {
    transport: TelegramTransport;
    store: TelegramStore;
    clock: { now(): number };
    defaults: DeliverySettings;
    onNotice?: (threadId: number, text: string) => void;
  }) {
    this.#transport = deps.transport;
    this.#store = deps.store;
    this.#clock = deps.clock;
    this.#defaults = deps.defaults;
    this.#onNotice = deps.onNotice ?? (() => undefined);
    this.#settings = deps.defaults;
  }

  /** Load persisted settings and mirrors; seeds settings on first run. */
  async initialize(): Promise<void> {
    const stored = await this.#store.get(SETTINGS_KEY);
    this.#settings = decodeSettings(stored, this.#defaults);
    await this.#store.set(SETTINGS_KEY, this.#settings);
    for (const entry of await this.#store.scan(MIRROR_PREFIX)) {
      const row = decodeMirror(entry.value);
      const nativeMessageId = entry.key.slice(MIRROR_PREFIX.length);
      if (row !== undefined && nativeMessageId.length > 0) {
        this.#mirrors.set(nativeMessageId, row);
      }
    }
  }

  get settings(): DeliverySettings {
    return this.#settings;
  }

  /** Merge and persist a settings patch. */
  async updateSettings(patch: Partial<DeliverySettings>): Promise<DeliverySettings> {
    this.#settings = { ...this.#settings, ...patch };
    await this.#store.set(SETTINGS_KEY, this.#settings);
    return this.#settings;
  }

  /** Mirror row for a native message id, if delivered before. */
  mirrorOf(nativeMessageId: string): MirrorRow | undefined {
    return this.#mirrors.get(nativeMessageId);
  }

  async #readOutbox(): Promise<PendingFinal[]> {
    const stored = await this.#store.get(OUTBOX_KEY);
    if (!Array.isArray(stored)) return [];
    return stored.map(decodePending).filter((entry): entry is PendingFinal => entry !== undefined);
  }

  async #writeOutbox(records: readonly PendingFinal[]): Promise<void> {
    const bounded =
      records.length > MAX_PENDING_FINALS
        ? records.slice(records.length - MAX_PENDING_FINALS)
        : records;
    await this.#store.set(OUTBOX_KEY, bounded);
  }

  /** Deliver a final message exactly once per native message id. */
  async deliverFinal(input: {
    readonly threadId: number;
    readonly nativeMessageId: string;
    readonly text: string;
    readonly role?: "assistant" | "user";
  }): Promise<{ readonly delivered: boolean; readonly tgMessageId: number | undefined }> {
    const existing = this.#mirrors.get(input.nativeMessageId);
    if (existing !== undefined) return { delivered: false, tgMessageId: existing.tgMessageId };
    const records = await this.#readOutbox();
    if (records.some((record) => record.nativeMessageId === input.nativeMessageId)) {
      return { delivered: false, tgMessageId: undefined };
    }
    this.#seq += 1;
    const record: PendingFinal = {
      id: `${this.#clock.now()}-${this.#seq}`,
      threadId: input.threadId,
      nativeMessageId: input.nativeMessageId,
      text: input.text,
      role: input.role ?? "assistant",
      attempts: 0,
    };
    await this.#writeOutbox([...records, record]);
    return this.#sendPending(record);
  }

  async #sendPending(
    record: PendingFinal,
  ): Promise<{ readonly delivered: boolean; readonly tgMessageId: number | undefined }> {
    try {
      const rendered = splitFinal(record.text, this.#settings.codeFileMaxKb);
      let lastTgMessageId: number | undefined;
      if (rendered.text.length > 0) {
        lastTgMessageId = (
          await this.#transport.sendMessage({ threadId: record.threadId, text: rendered.text })
        ).messageId;
      }
      for (const file of rendered.files) {
        const sent = await this.#transport.sendDocument({
          threadId: record.threadId,
          filename: file.filename,
          content: new TextEncoder().encode(file.content),
        });
        lastTgMessageId ??= sent.messageId;
      }
      if (lastTgMessageId === undefined) {
        throw new Error("final carried no renderable content");
      }
      const row: MirrorRow = {
        threadId: record.threadId,
        tgMessageId: lastTgMessageId,
        role: record.role,
      };
      this.#mirrors.set(record.nativeMessageId, row);
      await this.#store.set(MIRROR_PREFIX + record.nativeMessageId, row);
      const remaining = (await this.#readOutbox()).filter((entry) => entry.id !== record.id);
      await this.#writeOutbox(remaining);
      return { delivered: true, tgMessageId: lastTgMessageId };
    } catch {
      record.attempts += 1;
      if (record.attempts === 1) {
        this.#onNotice(record.threadId, "⚠️ delivery failed; the reply is queued and will retry");
      }
      const records = await this.#readOutbox();
      const patched = records.map((entry) => (entry.id === record.id ? record : entry));
      await this.#writeOutbox(patched);
      return { delivered: false, tgMessageId: undefined };
    }
  }

  /** Boot drain: per-record FIFO delivery of finals still missing mirrors. */
  async drainPendingFinals(): Promise<{ readonly delivered: number; readonly skipped: number }> {
    const records = await this.#readOutbox();
    let delivered = 0;
    let skipped = 0;
    for (const record of records) {
      if (this.#mirrors.has(record.nativeMessageId)) {
        skipped += 1;
        continue;
      }
      const result = await this.#sendPending(record);
      if (result.delivered) delivered += 1;
      else skipped += 1;
    }
    return { delivered, skipped };
  }

  /** Open a streaming turn with a stable draft id. */
  beginTurn(input: { readonly threadId: number; readonly draftId: number }): void {
    this.#streams.set(input.threadId, {
      draftId: input.draftId,
      turnStartMs: this.#clock.now(),
      placeholderMessageId: undefined,
      draftsDisabled: false,
      lastEditMs: 0,
    });
  }

  /** Stream one throttled text update; returns true when an update went out. */
  async streamText(threadId: number, text: string): Promise<boolean> {
    const state = this.#streams.get(threadId);
    if (state === undefined) return false;
    const nowMs = this.#clock.now();
    const delay = nextStreamDelayMs(nowMs - state.turnStartMs);
    if (state.lastEditMs !== 0 && nowMs - state.lastEditMs < delay) return false;
    if (text.trim().length === 0) return false;

    if (!state.draftsDisabled) {
      try {
        await this.#transport.sendDraft({ threadId, draftId: state.draftId, text });
        state.lastEditMs = nowMs;
        return true;
      } catch (error) {
        if (!(error instanceof TelegramUnsupportedError)) {
          return false;
        }
        state.draftsDisabled = true;
      }
    }
    if (state.placeholderMessageId === undefined) {
      const sent = await this.#transport.sendMessage({ threadId, text });
      state.placeholderMessageId = sent.messageId;
      state.lastEditMs = nowMs;
      return true;
    }
    await this.#transport.editMessageText({ messageId: state.placeholderMessageId, text });
    state.lastEditMs = nowMs;
    return true;
  }

  /** Send a transient progress line or card without a mirror or outbox record; failures are contained. */
  async sendTransient(input: {
    readonly threadId: number;
    readonly text: string;
  }): Promise<number | undefined> {
    try {
      return (await this.#transport.sendMessage({ threadId: input.threadId, text: input.text }))
        .messageId;
    } catch {
      return undefined;
    }
  }

  /** Close a streaming turn; the final send dismisses the draft, the fallback placeholder is removed best-effort. */
  async endTurn(threadId: number): Promise<void> {
    const state = this.#streams.get(threadId);
    if (state === undefined) return;
    if (state.placeholderMessageId !== undefined) {
      try {
        await this.#transport.deleteMessage(state.placeholderMessageId);
      } catch {
        // Best-effort removal only.
      }
    }
    this.#streams.delete(threadId);
  }
}
