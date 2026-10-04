// FILE: src/plugins/telegram/bot-api.ts
// VERSION: 1.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Own the narrow Telegram Bot API surface the bridge consumes, with a raw HTTP production transport (vv-chat shape) and an injectable call seam for deterministic tests.
//   SCOPE: The TelegramTransport interface (topics, sends, edits, drafts and rich messages with permanent unsupported latches, callbacks, commands, file download with a hard size cap, getUpdates polling reads, and markdown chunking with fence balancing, typed structural update shapes, credential-safe error normalization that never exposes the token, connectivity wiring for a custom API root or an outbound proxy (never both), and a raw HTTP call factory that performs no I/O at module import.
//   DEPENDS: [none]
//   LINKS: [M-TELEGRAM-BOT-API, M-TELEGRAM-GATEWAY, M-TELEGRAM-CONFIG, V-M-TELEGRAM-BOT-API]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   TELEGRAM_DEFAULT_API_ROOT - Default Bot API root.
//   TelegramCall - Low-level method-call seam (method, payload) to result.
//   TelegramApiError - Normalized Bot API failure with optional code, description, and retryAfter.
//   TelegramUnsupportedError - Permanent signal that a method is unavailable for this bot.
//   TelegramUser - Structural update sender shape.
//   TelegramChat - Structural update chat shape.
//   TelegramPhotoSize - Structural photo size variant.
//   TelegramMessage - Structural update message shape (thread, text, media, album grouping).
//   TelegramCallbackQuery - Structural callback query shape.
//   TelegramUpdate - Structural update envelope with album grouping key.
//   TelegramBotCommand - Registered command description.
//   TelegramTransport - The narrow send-side plus polling-read API surface the bridge consumes.
//   createRawHttpCallApi - Raw HTTP Bot API call seam (vv-chat transport shape) with credential-safe errors.
//   TELEGRAM_RICH_MAX_CHARS - Rich-message character cap per message.
//   TELEGRAM_PLAIN_MAX_CHARS - Plain-message fallback character cap per message.
//   chunkText - Cap-aware text splitting with code-fence balancing.
//   createTelegramTransport - Assemble the transport over an injectable call seam with the drafts and rich latches and credential-safe errors.
//   TelegramInlineButton - Inline keyboard button description.
//   TelegramTransportOptions - Construction options for the transport assembly.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [DIRECT-FIX - Replaced the grammy call layer with the vv-chat raw HTTP transport so Bot API 10.1 rich messages and drafts reach Telegram without a client-library method table.]
// END_CHANGE_SUMMARY

/** Default Bot API root; a custom root or proxy replaces it through configuration. */
export const TELEGRAM_DEFAULT_API_ROOT = "https://api.telegram.org";

/** Rich-message (Bot API 10.1 sendRichMessage) character cap per message. */
export const TELEGRAM_RICH_MAX_CHARS = 32_768;

/** Plain-message fallback character cap per message. */
export const TELEGRAM_PLAIN_MAX_CHARS = 4_096;

/** Cap-aware text splitting with code-fence balancing, cut at paragraph then line boundaries. */
export function chunkText(text: string, cap: number): readonly string[] {
  if (text.length <= cap) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    const cut = rest.length > cap ? findCutPoint(rest, cap) : rest.length;
    let chunk = rest.slice(0, cut);
    rest = rest.slice(cut);
    const fenceOpen = (chunk.match(/```/g) ?? []).length % 2 === 1;
    if (fenceOpen && rest.length > 0) {
      chunk += "\n```";
      rest = `\`\`\`\n${rest}`;
    }
    chunks.push(chunk);
    if (rest.length <= cap) {
      if (rest.length > 0) chunks.push(rest);
      rest = "";
    }
  }
  return chunks;
}

function findCutPoint(text: string, cap: number): number {
  const paragraph = text.lastIndexOf("\n\n", cap);
  if (paragraph > cap * 0.5) return paragraph;
  const line = text.lastIndexOf("\n", cap);
  if (line > cap * 0.5) return line;
  return cap;
}

/** Low-level method-call seam: one Bot API method with a JSON payload. */
export type TelegramCall = (method: string, payload: Record<string, unknown>) => Promise<unknown>;

/** Normalized Bot API failure; the description never contains the token. */
export class TelegramApiError extends Error {
  constructor(
    readonly code: number | undefined,
    readonly description: string,
    readonly retryAfter: number | undefined = undefined,
  ) {
    super(`Telegram API error ${code ?? "?"}: ${description}`);
    this.name = "TelegramApiError";
  }
}

/** Permanent signal that a method is unavailable for this bot; callers fall back. */
export class TelegramUnsupportedError extends Error {
  constructor(readonly method: string) {
    super(`Telegram method unsupported: ${method}`);
    this.name = "TelegramUnsupportedError";
  }
}

// START_BLOCK_STRUCTURAL_UPDATES
/** Structural update sender; only the fields the bridge routes on. */
export interface TelegramUser {
  readonly id: number;
  readonly is_bot?: boolean;
}

/** Structural update chat; private chats only in this bridge. */
export interface TelegramChat {
  readonly id: number;
  readonly type?: string;
}

/** Structural photo size variant; file_id and size drive bounded downloads. */
export interface TelegramPhotoSize {
  readonly file_id: string;
  readonly file_size?: number;
  readonly width?: number;
  readonly height?: number;
}

/** Structural update message; thread targeting, text, bounded media, album grouping. */
export interface TelegramMessage {
  readonly message_id: number;
  readonly from?: TelegramUser;
  readonly chat: TelegramChat;
  readonly date?: number;
  readonly message_thread_id?: number;
  readonly text?: string;
  readonly caption?: string;
  readonly photo?: readonly TelegramPhotoSize[];
  readonly document?: {
    readonly file_id: string;
    readonly file_size?: number;
    readonly file_name?: string;
    readonly mime_type?: string;
  };
  readonly media_group_id?: string;
  readonly voice?: {
    readonly file_id: string;
    readonly file_size?: number;
    readonly duration?: number;
  };
  readonly audio?: {
    readonly file_id: string;
    readonly file_size?: number;
    readonly file_name?: string;
  };
}

/** Structural callback query for inline-button decisions. */
export interface TelegramCallbackQuery {
  readonly id: string;
  readonly from: TelegramUser;
  readonly message?: {
    readonly message_id: number;
    readonly chat: TelegramChat;
    readonly message_thread_id?: number;
  };
  readonly data?: string;
}

/** Structural update envelope; consecutive photos sharing media_group_id form one album. */
export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage;
  readonly edited_message?: TelegramMessage;
  readonly callback_query?: TelegramCallbackQuery;
}

/** Registered command description for setMyCommands. */
export interface TelegramBotCommand {
  readonly command: string;
  readonly description: string;
}
// END_BLOCK_STRUCTURAL_UPDATES

/** Inline keyboard button description. */
export interface TelegramInlineButton {
  readonly text: string;
  readonly callbackData: string;
}

/** The narrow Bot API surface the bridge consumes. */
export interface TelegramTransport {
  createForumTopic(name: string): Promise<{ readonly threadId: number }>;
  editForumTopic(threadId: number, name: string): Promise<void>;
  closeForumTopic(threadId: number): Promise<void>;
  reopenForumTopic(threadId: number): Promise<void>;
  sendMessage(input: {
    readonly threadId: number;
    readonly text: string;
    readonly parseMode?: "MarkdownV2" | "HTML";
    readonly disableNotification?: boolean;
    readonly replyMarkup?: readonly (readonly TelegramInlineButton[])[];
  }): Promise<{ readonly messageId: number }>;
  /** Native rich send (Bot API 10.1) rendering markdown; throws TelegramUnsupportedError permanently once latched. */
  sendRich(input: {
    readonly threadId: number;
    readonly markdown: string;
  }): Promise<{ readonly messageId: number }>;
  sendDocument(input: {
    readonly threadId: number;
    readonly filename: string;
    readonly content: Uint8Array;
    readonly caption?: string;
  }): Promise<{ readonly messageId: number }>;
  editMessageText(input: {
    readonly messageId: number;
    readonly text: string;
    readonly parseMode?: "MarkdownV2" | "HTML";
    readonly replyMarkup?: readonly (readonly TelegramInlineButton[])[];
  }): Promise<void>;
  deleteMessage(messageId: number): Promise<void>;
  /** Ephemeral streaming preview; the same draftId animates in place. Throws TelegramUnsupportedError permanently once latched. */
  sendDraft(input: {
    readonly threadId: number;
    readonly draftId: number;
    readonly text: string;
  }): Promise<void>;
  answerCallback(callbackQueryId: string, text?: string): Promise<void>;
  setMyCommands(commands: readonly TelegramBotCommand[]): Promise<void>;
  /** Download one file with a hard byte cap enforced before and during the read. */
  downloadFile(fileId: string, maxBytes: number): Promise<Uint8Array>;
  /** Polling read; offset is the last acknowledged update_id, or null to let the server pick. */
  getUpdates(
    input: { readonly offset: number | null; readonly timeoutSec: number },
    signal: AbortSignal,
  ): Promise<readonly TelegramUpdate[]>;
}

/** True when an error description marks a method as unknown or removed for this bot. */
function isUnsupportedDescription(description: string): boolean {
  const lowered = description.toLowerCase();
  return lowered.includes("method not found") || lowered.includes("not found");
}

/** Replace any token occurrence inside free-text error material; never returns the token. */
function redactToken(text: string, token: string): string {
  if (token.length === 0) return text;
  return text.split(token).join("[redacted]");
}

/** Normalize any thrown value into a TelegramApiError without leaking the token. */
function normalizeApiError(error: unknown, token: string): TelegramApiError {
  if (error instanceof TelegramUnsupportedError) return new TelegramApiError(404, error.message);
  const record = error as {
    error_code?: unknown;
    description?: unknown;
    parameters?: { retry_after?: unknown };
    message?: unknown;
  };
  const code = typeof record.error_code === "number" ? record.error_code : undefined;
  const rawDescription =
    typeof record.description === "string"
      ? record.description
      : typeof record.message === "string"
        ? record.message
        : "unknown telegram failure";
  const retryAfter =
    typeof record.parameters?.retry_after === "number" ? record.parameters.retry_after : undefined;
  return new TelegramApiError(code, redactToken(rawDescription, token), retryAfter);
}

export type TelegramTransportOptions = {
  readonly token: string;
  /** Owner private chat id; in private chats the chat id equals the owner user id. */
  readonly chatId: number;
  readonly apiRoot?: string | undefined;
  readonly proxyUrl?: string | undefined;
  /** Injectable call seam for tests; defaults to the raw HTTP factory. */
  readonly call?: TelegramCall | undefined;
  /** Injectable file fetch for tests; defaults to global fetch with the proxy option. */
  readonly fetchFile?: ((url: string, init: RequestInit) => Promise<Response>) | undefined;
};

// START_BLOCK_RAW_FACTORY
/**
 * Raw HTTP Bot API call seam (the vv-chat transport shape): one POST per method to
 * `${apiRoot}/bot<token>/<method>` with a JSON body. The token exists only inside the
 * URL, is never part of errors, and unknown-to-SDK Bot API 10.x methods (rich messages,
 * drafts) pass straight through without a client library method table.
 */
export function createRawHttpCallApi(options: {
  readonly token: string;
  readonly apiRoot?: string | undefined;
  readonly proxyUrl?: string | undefined;
}): TelegramCall {
  if (options.apiRoot !== undefined && options.proxyUrl !== undefined) {
    throw new Error("telegram connectivity: apiRoot and proxyUrl are mutually exclusive");
  }
  const apiRoot = options.apiRoot ?? TELEGRAM_DEFAULT_API_ROOT;
  const init: RequestInit =
    options.proxyUrl === undefined ? {} : ({ proxy: options.proxyUrl } as RequestInit);
  return async (method, payload) => {
    const response = await fetch(`${apiRoot}/bot${options.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      ...init,
    });
    const body = (await response.json().catch(() => undefined)) as
      | {
          ok?: unknown;
          result?: unknown;
          error_code?: unknown;
          description?: unknown;
          parameters?: { retry_after?: unknown };
        }
      | undefined;
    if (body === undefined) {
      throw new TelegramApiError(response.status, `no JSON response (HTTP ${response.status})`);
    }
    if (body.ok !== true) {
      const code = typeof body.error_code === "number" ? body.error_code : response.status;
      const description = typeof body.description === "string" ? body.description : "unknown error";
      const retryAfter =
        typeof body.parameters?.retry_after === "number" ? body.parameters.retry_after : undefined;
      throw new TelegramApiError(code, description, retryAfter);
    }
    return body.result;
  };
}
// END_BLOCK_RAW_FACTORY

// START_BLOCK_TRANSPORT
/**
 * Assemble the transport over an injectable call seam. Draft availability is a
 * per-transport permanent latch: the first unsupported signal switches every
 * later sendDraft call into an immediate TelegramUnsupportedError so callers
 * fall back without repeat probing. Every failure surfaces as a credential-safe
 * TelegramApiError whose description never contains the token.
 */
export function createTelegramTransport(options: TelegramTransportOptions): TelegramTransport {
  if (options.apiRoot !== undefined && options.proxyUrl !== undefined) {
    throw new Error("telegram connectivity: apiRoot and proxyUrl are mutually exclusive");
  }
  const token = options.token;
  const chatId = options.chatId;
  const call: TelegramCall = options.call ?? createRawHttpCallApi(options);
  const fetchFile = options.fetchFile ?? ((url: string, init: RequestInit) => fetch(url, init));
  const apiRoot = options.apiRoot ?? TELEGRAM_DEFAULT_API_ROOT;
  const proxyInit =
    options.proxyUrl === undefined ? {} : ({ proxy: options.proxyUrl } as RequestInit);
  let draftsSupported = true;
  let richSupported = true;

  const serializeMarkup = (
    rows: readonly (readonly TelegramInlineButton[])[] | undefined,
  ): Record<string, unknown> | undefined =>
    rows === undefined
      ? undefined
      : {
          inline_keyboard: rows.map((row) =>
            row.map((button) => ({ text: button.text, callback_data: button.callbackData })),
          ),
        };

  const invoke = async <T>(method: string, payload: Record<string, unknown>): Promise<T> => {
    try {
      return (await call(method, payload)) as T;
    } catch (error) {
      throw normalizeApiError(error, token);
    }
  };

  return {
    async createForumTopic(name) {
      const result = await invoke<{ message_thread_id?: unknown }>("createForumTopic", {
        chat_id: chatId,
        name,
      });
      const threadId = result?.message_thread_id;
      if (typeof threadId !== "number") {
        throw new TelegramApiError(undefined, "createForumTopic returned no message_thread_id");
      }
      return { threadId };
    },
    async editForumTopic(threadId, name) {
      await invoke<boolean>("editForumTopic", {
        chat_id: chatId,
        message_thread_id: threadId,
        name,
      });
    },
    async closeForumTopic(threadId) {
      await invoke<boolean>("closeForumTopic", { chat_id: chatId, message_thread_id: threadId });
    },
    async reopenForumTopic(threadId) {
      await invoke<boolean>("reopenForumTopic", { chat_id: chatId, message_thread_id: threadId });
    },
    async sendMessage(input) {
      const markup = serializeMarkup(input.replyMarkup);
      const result = await invoke<{ message_id?: unknown }>("sendMessage", {
        chat_id: chatId,
        message_thread_id: input.threadId,
        text: input.text,
        ...(input.parseMode === undefined ? {} : { parse_mode: input.parseMode }),
        ...(input.disableNotification === undefined
          ? {}
          : { disable_notification: input.disableNotification }),
        ...(markup === undefined ? {} : { reply_markup: markup }),
      });
      const messageId = result?.message_id;
      if (typeof messageId !== "number") {
        throw new TelegramApiError(undefined, "sendMessage returned no message_id");
      }
      return { messageId };
    },
    async sendRich(input: { readonly threadId: number; readonly markdown: string }) {
      if (!richSupported) {
        throw new TelegramUnsupportedError("sendRichMessage");
      }
      try {
        const result = await invoke<{ message_id?: unknown }>("sendRichMessage", {
          chat_id: chatId,
          message_thread_id: input.threadId,
          rich_message: { markdown: input.markdown },
        });
        const messageId = result?.message_id;
        if (typeof messageId !== "number") {
          throw new TelegramApiError(undefined, "sendRichMessage returned no message_id");
        }
        return { messageId };
      } catch (error) {
        if (
          error instanceof TelegramApiError &&
          (error.code === 404 || isUnsupportedDescription(error.description))
        ) {
          richSupported = false;
          throw new TelegramUnsupportedError("sendRichMessage");
        }
        throw error;
      }
    },
    async sendDocument(input) {
      const form = new FormData();
      form.set("chat_id", String(chatId));
      form.set("message_thread_id", String(input.threadId));
      form.set("document", new Blob([input.content]), input.filename);
      if (input.caption !== undefined) form.set("caption", input.caption);
      let response: Response;
      try {
        response = await fetch(`${apiRoot}/bot${token}/sendDocument`, {
          method: "POST",
          body: form,
          ...proxyInit,
        });
      } catch (error) {
        throw normalizeApiError(error, token);
      }
      if (!response.ok) {
        throw new TelegramApiError(
          response.status,
          `document upload failed (HTTP ${response.status})`,
        );
      }
      const body = (await response.json().catch(() => undefined)) as
        | { ok?: unknown; result?: { message_id?: unknown }; description?: string }
        | undefined;
      if (body?.ok !== true || typeof body.result?.message_id !== "number") {
        throw new TelegramApiError(
          undefined,
          body?.description ?? "sendDocument returned no message_id",
        );
      }
      return { messageId: body.result.message_id };
    },
    async editMessageText(input) {
      const markup = serializeMarkup(input.replyMarkup);
      await invoke<boolean>("editMessageText", {
        chat_id: chatId,
        message_id: input.messageId,
        text: input.text,
        ...(input.parseMode === undefined ? {} : { parse_mode: input.parseMode }),
        ...(markup === undefined ? {} : { reply_markup: markup }),
      });
    },
    async deleteMessage(messageId) {
      await invoke<boolean>("deleteMessage", { chat_id: chatId, message_id: messageId });
    },
    async sendDraft(input) {
      if (!draftsSupported) {
        throw new TelegramUnsupportedError("sendMessageDraft");
      }
      try {
        await invoke<boolean>("sendMessageDraft", {
          chat_id: chatId,
          message_thread_id: input.threadId,
          draft_id: input.draftId,
          text: input.text,
        });
      } catch (error) {
        if (
          error instanceof TelegramApiError &&
          (error.code === 404 || isUnsupportedDescription(error.description))
        ) {
          draftsSupported = false;
          throw new TelegramUnsupportedError("sendMessageDraft");
        }
        throw error;
      }
    },
    async answerCallback(callbackQueryId, text) {
      await invoke<boolean>("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        ...(text === undefined ? {} : { text }),
      });
    },
    async setMyCommands(commands) {
      await invoke<boolean>("setMyCommands", {
        commands: commands.map((entry) => ({
          command: entry.command,
          description: entry.description,
        })),
      });
    },
    async downloadFile(fileId, maxBytes) {
      const file = await invoke<{ file_path?: unknown }>("getFile", { file_id: fileId });
      const filePath = file?.file_path;
      if (typeof filePath !== "string" || filePath.length === 0) {
        throw new TelegramApiError(undefined, "getFile returned no file_path");
      }
      const url = `${apiRoot}/file/bot${token}/${filePath}`;
      const response = await fetchFile(url, proxyInit);
      if (!response.ok) {
        throw new TelegramApiError(
          response.status,
          `file download failed with HTTP ${response.status}`,
        );
      }
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > maxBytes) {
        throw new TelegramApiError(undefined, "file exceeds the configured size cap");
      }
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.byteLength > maxBytes) {
        throw new TelegramApiError(undefined, "file exceeds the configured size cap");
      }
      return buffer;
    },
    async getUpdates(input) {
      const updates = await invoke<readonly TelegramUpdate[]>("getUpdates", {
        ...(input.offset === null ? {} : { offset: input.offset }),
        timeout: input.timeoutSec,
        allowed_updates: ["message", "edited_message", "callback_query"],
      });
      return Array.isArray(updates) ? updates : [];
    },
  };
}
// END_BLOCK_TRANSPORT
