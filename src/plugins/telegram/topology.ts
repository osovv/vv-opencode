// FILE: src/plugins/telegram/topology.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Own the durable Telegram DM-topic topology: the fixed General mapping, the topic and session map under versioned storage keys, the activity policy, idempotent reconciliation, and throttled status-emoji titles.
//   SCOPE: Injectable store and transport boundaries, fingerprint-checked state load with full reset on bot change, General created exactly once per bot, create, close-not-delete, and reuse transitions with per-transition failure containment, an injectable activity window and title-edit throttle, code-point title clamping, and a per-pass report.
//   DEPENDS: [src/plugins/telegram/bot-api.ts]
//   LINKS: [M-TELEGRAM-TOPICS, M-TELEGRAM-BOT-API, M-TELEGRAM-GATEWAY, V-M-TELEGRAM-TOPICS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   TELEGRAM_STORAGE_SCHEMA_VERSION - Current durable topology storage schema version.
//   TELEGRAM_TOPIC_TITLE_MAX_CHARS - Bot API forum-topic name limit applied by code points.
//   TOPIC_META_KEY - Storage key holding schema version, bot fingerprint, and the General mapping.
//   TOPIC_PREFIX - Storage key prefix for per-topic rows.
//   SESSION_PREFIX - Storage key prefix for per-session rows.
//   SESSION_STATUS_EMOJI - Fixed status emoji table keyed by session status.
//   TelegramStore - Injectable durable key-value boundary mirroring ctx.storage.
//   TelegramStorageEntry - One scanned storage entry.
//   TopicRow - Persisted per-topic mapping row.
//   SessionRow - Persisted per-session mapping row.
//   TopicMeta - Persisted topology metadata.
//   SessionActivityView - Structural session facts reconciliation consumes.
//   TopicPassReport - Per-reconcile outcome summary.
//   isSessionActive - Pure activity policy over running and last-activity recency.
//   composeTopicTitle - Pure emoji-plus-title composition with code-point clamping.
//   TelegramTopology - Topology manager bound to injectable store, transport, and clock.
//   SessionStatus - Session status key of the fixed emoji table.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-TELEGRAM-BRIDGE-PLUGIN T-003 - Created the durable topology manager with fingerprint reset, General-once, create, close-not-delete, reuse, idempotent reconcile, the activity policy, and throttled status-emoji titles.]
// END_CHANGE_SUMMARY

import type { TelegramTransport } from "./bot-api.js";

/** Current durable topology storage schema version. */
export const TELEGRAM_STORAGE_SCHEMA_VERSION = 1;

/** Bot API forum-topic name limit: 1-128 characters. */
export const TELEGRAM_TOPIC_TITLE_MAX_CHARS = 128;

/** Storage key holding schema version, bot fingerprint, and the General mapping. */
export const TOPIC_META_KEY = "telegram/v1/meta";

/** Storage key prefix for per-topic rows. */
export const TOPIC_PREFIX = "telegram/v1/topic/";

/** Storage key prefix for per-session rows. */
export const SESSION_PREFIX = "telegram/v1/session/";

/** Fixed status emoji table keyed by session status; none omits the emoji. */
export const SESSION_STATUS_EMOJI = {
  running: "⚙️",
  idle: "💤",
  question: "❓",
  permission: "🔐",
  error: "‼️",
  aborted: "⏹",
} as const;

export type SessionStatus = keyof typeof SESSION_STATUS_EMOJI;

/** Injectable durable key-value boundary mirroring ctx.storage. */
export interface TelegramStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  scan(prefix: string): Promise<readonly TelegramStorageEntry[]>;
}

export interface TelegramStorageEntry {
  readonly key: string;
  readonly value: unknown;
}

/** Persisted per-topic mapping row. */
export interface TopicRow {
  readonly sessionID: string;
  title: string;
  state: "open" | "closed";
}

/** Persisted per-session mapping row. */
export interface SessionRow {
  threadId: number;
  cleanTitle: string;
  botCreated: boolean;
  lastUsedMs: number;
}

/** Persisted topology metadata. */
export interface TopicMeta {
  schema: number;
  fingerprint: string;
  generalThreadId: number | null;
}

/** Structural session facts reconciliation consumes. */
export interface SessionActivityView {
  readonly sessionID: string;
  readonly title: string;
  readonly timeUpdatedMs: number;
  readonly running: boolean;
}

/** Per-reconcile outcome summary. */
export interface TopicPassReport {
  created: number;
  closed: number;
  reused: number;
  titled: number;
  failures: number;
}

/** Pure activity policy: running now, or active within the recency window. */
export function isSessionActive(input: {
  readonly running: boolean;
  readonly lastActivityMs: number;
  readonly windowMs: number;
  readonly nowMs: number;
}): boolean {
  if (input.running) return true;
  return input.nowMs - input.lastActivityMs <= input.windowMs;
}

/** Compose a topic title as emoji plus clean title, clamped by code points. */
export function composeTopicTitle(emoji: string | null, title: string): string {
  const clean = title.trim().length > 0 ? title.trim() : "session";
  const composed = emoji === null ? clean : `${emoji} ${clean}`;
  const chars = Array.from(composed);
  return chars.length <= TELEGRAM_TOPIC_TITLE_MAX_CHARS
    ? composed
    : chars.slice(0, TELEGRAM_TOPIC_TITLE_MAX_CHARS).join("");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeTopicRow(value: unknown): TopicRow | undefined {
  if (!isPlainObject(value)) return undefined;
  const sessionID = value.sessionID;
  const title = value.title;
  const state = value.state;
  if (typeof sessionID !== "string" || typeof title !== "string") return undefined;
  if (state !== "open" && state !== "closed") return undefined;
  return { sessionID, title, state };
}

function decodeSessionRow(value: unknown): SessionRow | undefined {
  if (!isPlainObject(value)) return undefined;
  const threadId = value.threadId;
  const cleanTitle = value.cleanTitle;
  const botCreated = value.botCreated;
  const lastUsedMs = value.lastUsedMs;
  if (typeof threadId !== "number" || typeof cleanTitle !== "string") return undefined;
  return {
    threadId,
    cleanTitle,
    botCreated: botCreated === true,
    lastUsedMs: typeof lastUsedMs === "number" ? lastUsedMs : 0,
  };
}

/**
 * Topology manager. Storage is the sole authority (the Bot API exposes no
 * list-topics): every mutation persists before the next pass, General is created
 * exactly once per bot fingerprint, and a changed fingerprint resets every
 * stored row instead of reusing stale bindings.
 */
export class TelegramTopology {
  readonly #transport: TelegramTransport;
  readonly #store: TelegramStore;
  readonly #clock: { now(): number };
  readonly #windowMs: number;
  readonly #titleEditMinIntervalMs: number;
  readonly #lastTitleEditMs = new Map<number, number>();
  #meta: TopicMeta = {
    schema: TELEGRAM_STORAGE_SCHEMA_VERSION,
    fingerprint: "",
    generalThreadId: null,
  };
  readonly #topics = new Map<number, TopicRow>();
  readonly #sessions = new Map<string, SessionRow>();

  constructor(deps: {
    transport: TelegramTransport;
    store: TelegramStore;
    clock: { now(): number };
    windowMinutes: number;
    titleEditMinIntervalMs?: number;
  }) {
    this.#transport = deps.transport;
    this.#store = deps.store;
    this.#clock = deps.clock;
    this.#windowMs = deps.windowMinutes * 60_000;
    this.#titleEditMinIntervalMs = deps.titleEditMinIntervalMs ?? 4_000;
  }

  /** Load durable state for this bot fingerprint; a mismatch resets everything. */
  async initialize(fingerprint: string): Promise<void> {
    const stored = await this.#store.get(TOPIC_META_KEY);
    const compatible =
      isPlainObject(stored) &&
      stored.schema === TELEGRAM_STORAGE_SCHEMA_VERSION &&
      stored.fingerprint === fingerprint;
    if (compatible) {
      this.#meta = {
        schema: TELEGRAM_STORAGE_SCHEMA_VERSION,
        fingerprint,
        generalThreadId: typeof stored.generalThreadId === "number" ? stored.generalThreadId : null,
      };
      for (const entry of await this.#store.scan(TOPIC_PREFIX)) {
        const row = decodeTopicRow(entry.value);
        const threadId = Number(entry.key.slice(TOPIC_PREFIX.length));
        if (row !== undefined && Number.isInteger(threadId) && threadId > 0) {
          this.#topics.set(threadId, row);
        }
      }
      for (const entry of await this.#store.scan(SESSION_PREFIX)) {
        const row = decodeSessionRow(entry.value);
        const sessionID = entry.key.slice(SESSION_PREFIX.length);
        if (row !== undefined && sessionID.length > 0) {
          this.#sessions.set(sessionID, row);
        }
      }
      return;
    }
    for (const entry of await this.#store.scan("telegram/v1/")) {
      await this.#store.remove(entry.key);
    }
    this.#topics.clear();
    this.#sessions.clear();
    this.#lastTitleEditMs.clear();
    this.#meta = { schema: TELEGRAM_STORAGE_SCHEMA_VERSION, fingerprint, generalThreadId: null };
    await this.#store.set(TOPIC_META_KEY, this.#meta);
  }

  /** The General control topic id, creating and mapping it exactly once per bot. */
  async ensureGeneral(): Promise<number> {
    if (this.#meta.generalThreadId !== null) return this.#meta.generalThreadId;
    const created = await this.#transport.createForumTopic("General");
    this.#meta.generalThreadId = created.threadId;
    await this.#store.set(TOPIC_META_KEY, this.#meta);
    return created.threadId;
  }

  /** General topic id once known, without creating. */
  get generalThreadId(): number | null {
    return this.#meta.generalThreadId;
  }

  /** Activity policy bound to this topology's configured window, folding stored bot usage into recency. */
  isActive(
    sessionID: string,
    view: { readonly running: boolean; readonly timeUpdatedMs: number },
    nowMs: number = this.#clock.now(),
  ): boolean {
    const lastActivityMs = Math.max(
      view.timeUpdatedMs,
      this.#sessions.get(sessionID)?.lastUsedMs ?? 0,
    );
    return isSessionActive({
      running: view.running,
      lastActivityMs,
      windowMs: this.#windowMs,
      nowMs,
    });
  }

  /** Owner thread id bound to a session, if any. */
  topicIdFor(sessionID: string): number | undefined {
    return this.#sessions.get(sessionID)?.threadId;
  }

  /** Session bound to a topic thread id, if any. */
  sessionFor(threadId: number): string | undefined {
    return this.#topics.get(threadId)?.sessionID;
  }

  /** Mark a session as used through the bot, advancing its activity timestamp. */
  async touchSession(sessionID: string): Promise<void> {
    const row = this.#sessions.get(sessionID);
    if (row === undefined) return;
    row.lastUsedMs = this.#clock.now();
    await this.#store.set(SESSION_PREFIX + sessionID, row);
  }

  /** Create and durably map a topic for a session created or adopted through the bot. */
  async openTopicForSession(
    sessionID: string,
    cleanTitle: string,
    initialStatus: SessionStatus = "idle",
  ): Promise<number> {
    const existing = this.#sessions.get(sessionID);
    if (existing !== undefined) {
      const topic = this.#topics.get(existing.threadId);
      if (topic !== undefined && topic.state === "closed") {
        await this.#transport.reopenForumTopic(existing.threadId);
        topic.state = "open";
        await this.#persistTopic(existing.threadId);
      }
      return existing.threadId;
    }
    const title = composeTopicTitle(SESSION_STATUS_EMOJI[initialStatus], cleanTitle);
    const created = await this.#transport.createForumTopic(title);
    this.#topics.set(created.threadId, { sessionID, title, state: "open" });
    this.#sessions.set(sessionID, {
      threadId: created.threadId,
      cleanTitle,
      botCreated: true,
      lastUsedMs: this.#clock.now(),
    });
    await this.#persistTopic(created.threadId);
    await this.#persistSession(sessionID);
    return created.threadId;
  }

  /** Apply a status transition as a throttled title edit; failures degrade to the last known title. */
  async setStatus(
    sessionID: string,
    status: SessionStatus | "none",
    cleanTitle?: string,
  ): Promise<void> {
    const row = this.#sessions.get(sessionID);
    if (row === undefined) return;
    const nextClean = cleanTitle ?? row.cleanTitle;
    const emoji = status === "none" ? null : SESSION_STATUS_EMOJI[status];
    const title = composeTopicTitle(emoji, nextClean);
    const topic = this.#topics.get(row.threadId);
    if (topic === undefined || topic.title === title) {
      if (topic !== undefined && nextClean !== row.cleanTitle) {
        row.cleanTitle = nextClean;
        await this.#persistSession(sessionID);
      }
      return;
    }
    const last = this.#lastTitleEditMs.get(row.threadId) ?? 0;
    if (this.#clock.now() - last < this.#titleEditMinIntervalMs) return;
    try {
      await this.#transport.editForumTopic(row.threadId, title);
      this.#lastTitleEditMs.set(row.threadId, this.#clock.now());
      topic.title = title;
      row.cleanTitle = nextClean;
      await this.#persistTopic(row.threadId);
      await this.#persistSession(sessionID);
    } catch {
      // Degrade to the last known title; the next pass retries through reconcile.
    }
  }

  /** Idempotent reconcile of the displayed topic set to the active session set. */
  async reconcile(active: readonly SessionActivityView[]): Promise<TopicPassReport> {
    const report: TopicPassReport = { created: 0, closed: 0, reused: 0, titled: 0, failures: 0 };
    const nowMs = this.#clock.now();
    const activeIds = new Set(active.map((view) => view.sessionID));

    for (const view of active) {
      const row = this.#sessions.get(view.sessionID);
      if (row === undefined) {
        try {
          const threadId = await this.openTopicForSession(
            view.sessionID,
            view.title,
            view.running ? "running" : "idle",
          );
          report.created += 1;
          this.#lastTitleEditMs.set(threadId, nowMs);
        } catch {
          report.failures += 1;
        }
        continue;
      }
      const topic = this.#topics.get(row.threadId);
      if (topic === undefined) continue;
      if (topic.state === "closed") {
        try {
          await this.#transport.reopenForumTopic(row.threadId);
          topic.state = "open";
          await this.#persistTopic(row.threadId);
          report.reused += 1;
        } catch {
          report.failures += 1;
        }
      }
      const emoji = view.running ? SESSION_STATUS_EMOJI.running : SESSION_STATUS_EMOJI.idle;
      const title = composeTopicTitle(emoji, view.title);
      if (topic.title !== title) {
        const last = this.#lastTitleEditMs.get(row.threadId) ?? 0;
        if (nowMs - last >= this.#titleEditMinIntervalMs) {
          try {
            await this.#transport.editForumTopic(row.threadId, title);
            this.#lastTitleEditMs.set(row.threadId, nowMs);
            topic.title = title;
            row.cleanTitle = view.title;
            await this.#persistTopic(row.threadId);
            await this.#persistSession(view.sessionID);
            report.titled += 1;
          } catch {
            report.failures += 1;
          }
        }
      }
    }

    for (const [threadId, topic] of this.#topics) {
      if (activeIds.has(topic.sessionID)) continue;
      if (topic.state !== "open") continue;
      try {
        await this.#transport.closeForumTopic(threadId);
        topic.state = "closed";
        await this.#persistTopic(threadId);
        report.closed += 1;
      } catch {
        report.failures += 1;
      }
    }

    return report;
  }

  async #persistTopic(threadId: number): Promise<void> {
    const row = this.#topics.get(threadId);
    if (row !== undefined) await this.#store.set(TOPIC_PREFIX + threadId, row);
  }

  async #persistSession(sessionID: string): Promise<void> {
    const row = this.#sessions.get(sessionID);
    if (row !== undefined) await this.#store.set(SESSION_PREFIX + sessionID, row);
  }
}
