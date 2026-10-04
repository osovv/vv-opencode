// FILE: src/plugins/telegram/gateway.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Own the Telegram long-polling gateway loop: persisted update offset advanced only after dispatch, owner allowlist enforcement, plain-lane and stale-update dropping, album grouping inside one poll batch, bounded error backoff, and graceful stop.
//   SCOPE: Injectable transport, store, command dispatch, clock, and diagnostic boundaries; the durable offset key; a pure album grouper; a pure staleness predicate; one contained dispatch per update; backoff schedule with an abortable sleep.
//   DEPENDS: [src/plugins/telegram/bot-api.ts, src/plugins/telegram/topology.ts]
//   LINKS: [M-TELEGRAM-GATEWAY, M-TELEGRAM-BOT-API, V-M-TELEGRAM-GATEWAY]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   OFFSET_KEY - Storage key holding the last acknowledged update id.
//   POLLING_TIMEOUT_SEC - Long-poll timeout forwarded to getUpdates.
//   GATEWAY_BACKOFF_MS - Bounded error backoff schedule.
//   STALE_UPDATE_GRACE_SEC - Updates older than this grace at dispatch time are dropped.
//   TelegramOwnerMessage - Dispatch input for one routed owner message or album.
//   isStaleUpdate - Pure staleness predicate over the message date and now.
//   groupAlbums - Pure batch grouper: consecutive photos sharing a media_group id form one dispatch.
//   TelegramGateway - Long-polling loop bound to injectable boundaries.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-TELEGRAM-BRIDGE-PLUGIN T-008 - Created the polling gateway with persisted offset, owner allowlist, stale-drop, album grouping, bounded backoff, and graceful stop.]
// END_CHANGE_SUMMARY

import type { TelegramMessage, TelegramTransport, TelegramUpdate } from "./bot-api.js";
import type { TelegramStore } from "./topology.js";

/** Storage key holding the last acknowledged update id. */
export const OFFSET_KEY = "telegram/v1/offset";

/** Long-poll timeout forwarded to getUpdates. */
export const POLLING_TIMEOUT_SEC = 25;

/** Bounded error backoff schedule; the last entry is the cap. */
export const GATEWAY_BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000] as const;

/** Updates older than this grace at dispatch time are dropped as stale. */
export const STALE_UPDATE_GRACE_SEC = 60;

/** Dispatch input for one routed owner message or album. */
export interface TelegramOwnerMessage {
  readonly threadId: number;
  readonly text: string | undefined;
  readonly attachments: readonly {
    readonly fileId: string;
    readonly filename: string | undefined;
    readonly mimeType: string | undefined;
  }[];
}

/** Pure staleness predicate over the message date and now. */
export function isStaleUpdate(message: TelegramMessage, nowMs: number): boolean {
  if (message.date === undefined) return false;
  const ageSec = Math.floor(nowMs / 1000) - message.date;
  return ageSec > STALE_UPDATE_GRACE_SEC;
}

interface BatchEntry {
  readonly updateId: number;
  readonly kind: "message" | "callback" | "album" | "ignored";
  readonly message?: TelegramMessage;
  readonly album?: readonly TelegramMessage[];
  readonly update?: TelegramUpdate;
}

/** Pure batch grouper: consecutive photos sharing a media_group id form one dispatch entry. */
export function groupAlbums(updates: readonly TelegramUpdate[]): readonly BatchEntry[] {
  const entries: BatchEntry[] = [];
  let pendingAlbum: { key: string; items: BatchEntry[] } | null = null;
  const flush = () => {
    if (pendingAlbum === null) return;
    const messages = pendingAlbum.items
      .map((item) => item.message)
      .filter((message): message is TelegramMessage => message !== undefined);
    if (messages.length > 0) {
      entries.push({
        kind: "album",
        updateId: pendingAlbum.items.at(-1)?.updateId ?? 0,
        album: messages,
      });
    }
    pendingAlbum = null;
  };
  for (const update of updates) {
    if (update.message !== undefined) {
      const group = update.message.photo !== undefined ? update.message.media_group_id : undefined;
      if (group !== undefined) {
        if (pendingAlbum !== null && pendingAlbum.key !== group) flush();
        pendingAlbum ??= { key: group, items: [] };
        pendingAlbum.items.push({
          updateId: update.update_id,
          kind: "message",
          message: update.message,
        });
        continue;
      }
      flush();
      entries.push({ updateId: update.update_id, kind: "message", message: update.message });
      continue;
    }
    flush();
    if (update.callback_query !== undefined) {
      entries.push({ updateId: update.update_id, kind: "callback", update });
    } else {
      entries.push({ updateId: update.update_id, kind: "ignored" });
    }
  }
  flush();
  return entries;
}

/**
 * Long-polling gateway. The offset advances only after an update's dispatch
 * resolves, stale messages queued while the bot was offline are dropped, and
 * every dispatch failure is contained so the loop continues with bounded
 * backoff. Exactly one gateway per bot token may run.
 */
export class TelegramGateway {
  readonly #transport: TelegramTransport;
  readonly #store: TelegramStore;
  readonly #ownerIds: readonly number[];
  readonly #dispatch: {
    handleMessage(input: TelegramOwnerMessage): Promise<void>;
    handleCallback(update: TelegramUpdate): Promise<void>;
  };
  readonly #clock: { now(): number };
  readonly #log: (level: "warn", message: string) => void;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  #abort: AbortController | undefined;
  #loop: Promise<void> | undefined;
  #offset: number | undefined;

  constructor(deps: {
    transport: TelegramTransport;
    store: TelegramStore;
    ownerIds: readonly number[];
    dispatch: {
      handleMessage(input: TelegramOwnerMessage): Promise<void>;
      handleCallback(update: TelegramUpdate): Promise<void>;
    };
    clock: { now(): number };
    log?: (level: "warn", message: string) => void;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  }) {
    this.#transport = deps.transport;
    this.#store = deps.store;
    this.#ownerIds = deps.ownerIds;
    this.#dispatch = deps.dispatch;
    this.#clock = deps.clock;
    this.#log = deps.log ?? (() => undefined);
    this.#sleep =
      deps.sleep ??
      ((ms, signal) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, ms);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new DOMException("Sleep aborted", "AbortError"));
            },
            { once: true },
          );
        }));
  }

  /** Load the persisted offset and start polling; resolves once the loop exits. */
  async start(): Promise<void> {
    const stored = await this.#store.get(OFFSET_KEY);
    this.#offset = typeof stored === "number" ? stored : undefined;
    this.#abort = new AbortController();
    const signal = this.#abort.signal;
    this.#loop = this.#run(signal);
    await this.#loop;
  }

  /** Abort the in-flight poll and settle the loop. */
  async stop(): Promise<void> {
    this.#abort?.abort();
    await this.#loop?.catch(() => undefined);
    this.#loop = undefined;
    this.#abort = undefined;
  }

  async #run(signal: AbortSignal): Promise<void> {
    let errorIndex = 0;
    while (!signal.aborted) {
      try {
        const updates = await this.#transport.getUpdates(
          {
            offset: this.#offset === undefined ? null : this.#offset + 1,
            timeoutSec: POLLING_TIMEOUT_SEC,
          },
          signal,
        );
        errorIndex = 0;
        for (const entry of groupAlbums(updates)) {
          if (signal.aborted) return;
          await this.#dispatchEntry(entry);
          await this.#store.set(OFFSET_KEY, entry.updateId);
          this.#offset = entry.updateId;
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof Error && error.name === "AbortError") return;
        const backoff = GATEWAY_BACKOFF_MS[Math.min(errorIndex, GATEWAY_BACKOFF_MS.length - 1)];
        errorIndex += 1;
        this.#log("warn", `gateway poll error; backing off ${backoff}ms`);
        await this.#sleep(backoff, signal).catch(() => undefined);
      }
    }
  }

  async #dispatchEntry(entry: BatchEntry): Promise<void> {
    try {
      if (entry.kind === "callback") {
        // The dispatch layer re-checks the sender before acting.
        if (entry.update !== undefined) {
          await this.#dispatch.handleCallback(entry.update);
        }
        return;
      }
      if (entry.kind === "ignored") return;
      const message = entry.kind === "album" ? entry.album?.[0] : entry.message;
      if (message === undefined) return;
      if (message.from !== undefined && !this.#ownerIds.includes(message.from.id)) {
        this.#log("warn", "ignored update from non-owner sender");
        return;
      }
      if (message.message_thread_id === undefined) return;
      if (isStaleUpdate(message, this.#clock.now())) {
        this.#log("warn", "dropped stale update");
        return;
      }
      const text = message.text ?? message.caption;
      const sources = entry.kind === "album" ? (entry.album ?? []) : [message];
      const attachments = sources.flatMap((source) => {
        const files: {
          fileId: string;
          filename: string | undefined;
          mimeType: string | undefined;
        }[] = [];
        if (source.photo !== undefined && source.photo.length > 0) {
          const largest = source.photo.at(-1);
          if (largest !== undefined) {
            files.push({ fileId: largest.file_id, filename: undefined, mimeType: "image/jpeg" });
          }
        }
        if (source.document !== undefined) {
          files.push({
            fileId: source.document.file_id,
            filename: source.document.file_name,
            mimeType: source.document.mime_type,
          });
        }
        return files;
      });
      if (text === undefined && attachments.length === 0) return;
      await this.#dispatch.handleMessage({
        threadId: message.message_thread_id,
        text,
        attachments,
      });
    } catch (error) {
      this.#log(
        "warn",
        `dispatch contained: ${error instanceof Error ? error.name : typeof error}`,
      );
    }
  }

  /** Exposed for tests: dispatch one raw update entry without polling. */
  async dispatchUpdate(update: TelegramUpdate): Promise<void> {
    for (const entry of groupAlbums([update])) {
      await this.#dispatchEntry(entry);
    }
  }
}
