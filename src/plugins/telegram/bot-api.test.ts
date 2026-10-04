// FILE: src/plugins/telegram/bot-api.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the Telegram transport assembly over an injected call seam: payloads, chat and thread targeting, the drafts-unsupported latch, file-download caps, connectivity exclusivity, and credential-safe errors.
//   SCOPE: Fake-call payload capture for topics, sends, edits, callbacks, commands, and polling reads; sendDraft latch transition and permanence; downloadFile path building, declared and actual size caps; apiRoot plus proxyUrl rejection; token redaction inside normalized errors; no grammy client construction anywhere in the suite.
//   DEPENDS: [src/plugins/telegram/bot-api.ts]
//   LINKS: [M-TELEGRAM-BOT-API, V-M-TELEGRAM-BOT-API]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   RecordedCall - One captured method invocation.
//   FakeCall - Scriptable call seam capturing payloads.
//   transportWith - Build a transport over a fresh fake call.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-TELEGRAM-BRIDGE-PLUGIN T-002 - Covered transport payloads, targeting, the drafts latch, download caps, connectivity exclusivity, and token redaction.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import {
  createTelegramTransport,
  TelegramApiError,
  TelegramUnsupportedError,
  type TelegramCall,
  type TelegramTransport,
} from "./bot-api.js";

interface RecordedCall {
  method: string;
  payload: Record<string, unknown>;
}

/** Scriptable call seam: respond per method and record every invocation. */
class FakeCall {
  readonly calls: RecordedCall[] = [];
  #responses = new Map<string, unknown | ((payload: Record<string, unknown>) => unknown)>();
  #fallback: ((payload: Record<string, unknown>) => unknown) | undefined;

  respond(method: string, result: unknown | ((payload: Record<string, unknown>) => unknown)): void {
    this.#responses.set(method, result);
  }

  fallback(fn: (payload: Record<string, unknown>) => unknown): void {
    this.#fallback = fn;
  }

  callsTo(method: string): RecordedCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  readonly call: TelegramCall = async (method, payload) => {
    this.calls.push({ method, payload: { ...payload } });
    const scripted = this.#responses.get(method);
    if (scripted !== undefined) {
      return typeof scripted === "function" ? scripted(payload) : scripted;
    }
    if (this.#fallback) return this.#fallback(payload);
    return { ok: true };
  };
}

function transportWith(fake: FakeCall): TelegramTransport {
  return createTelegramTransport({
    token: "123:secret-token",
    chatId: 424_242,
    call: fake.call,
  });
}

describe("transport payload shaping", () => {
  test("topic calls carry the owner chat id and thread targeting", async () => {
    const fake = new FakeCall();
    fake.respond("createForumTopic", { message_thread_id: 777 });
    const transport = transportWith(fake);
    const created = await transport.createForumTopic("General");
    expect(created).toEqual({ threadId: 777 });
    await transport.editForumTopic(777, "⚙️ work");
    await transport.closeForumTopic(777);
    await transport.reopenForumTopic(777);
    expect(fake.callsTo("createForumTopic")[0]?.payload).toEqual({
      chat_id: 424_242,
      name: "General",
    });
    expect(fake.callsTo("editForumTopic")[0]?.payload).toEqual({
      chat_id: 424_242,
      message_thread_id: 777,
      name: "⚙️ work",
    });
    expect(fake.callsTo("closeForumTopic")[0]?.payload).toEqual({
      chat_id: 424_242,
      message_thread_id: 777,
    });
    expect(fake.callsTo("reopenForumTopic")[0]?.payload).toEqual({
      chat_id: 424_242,
      message_thread_id: 777,
    });
  });

  test("sendMessage targets the thread and returns the message id", async () => {
    const fake = new FakeCall();
    fake.respond("sendMessage", { message_id: 55 });
    const transport = transportWith(fake);
    const sent = await transport.sendMessage({ threadId: 9, text: "hi", parseMode: "HTML" });
    expect(sent).toEqual({ messageId: 55 });
    expect(fake.callsTo("sendMessage")[0]?.payload).toEqual({
      chat_id: 424_242,
      message_thread_id: 9,
      text: "hi",
      parse_mode: "HTML",
    });
  });

  test("editMessageText carries chat and message identity", async () => {
    const fake = new FakeCall();
    const transport = transportWith(fake);
    await transport.editMessageText({ messageId: 55, text: "edited" });
    expect(fake.callsTo("editMessageText")[0]?.payload).toEqual({
      chat_id: 424_242,
      message_id: 55,
      text: "edited",
    });
  });

  test("callback answers and command registration pass through", async () => {
    const fake = new FakeCall();
    const transport = transportWith(fake);
    await transport.answerCallback("cq-1", "done");
    await transport.setMyCommands([{ command: "new", description: "Create a session" }]);
    expect(fake.callsTo("answerCallbackQuery")[0]?.payload).toEqual({
      callback_query_id: "cq-1",
      text: "done",
    });
    expect(fake.callsTo("setMyCommands")[0]?.payload).toEqual({
      commands: [{ command: "new", description: "Create a session" }],
    });
  });

  test("getUpdates forwards the offset, timeout, and allowed updates", async () => {
    const fake = new FakeCall();
    fake.respond("getUpdates", []);
    const transport = transportWith(fake);
    const updates = await transport.getUpdates(
      { offset: 41, timeoutSec: 25 },
      new AbortController().signal,
    );
    expect(updates).toEqual([]);
    expect(fake.callsTo("getUpdates")[0]?.payload).toEqual({
      offset: 41,
      timeout: 25,
      allowed_updates: ["message", "edited_message", "callback_query"],
    });
  });
});

describe("drafts latch", () => {
  test("the first unsupported response latches and every later sendDraft rejects without calling", async () => {
    const fake = new FakeCall();
    fake.respond("sendMessageDraft", () => {
      throw { error_code: 404, description: "Not Found" };
    });
    const transport = transportWith(fake);
    await expect(
      transport.sendDraft({ threadId: 1, draftId: 5, text: "x" }),
    ).rejects.toBeInstanceOf(TelegramUnsupportedError);
    await expect(
      transport.sendDraft({ threadId: 1, draftId: 5, text: "y" }),
    ).rejects.toBeInstanceOf(TelegramUnsupportedError);
    expect(fake.callsTo("sendMessageDraft")).toHaveLength(1);
  });

  test("a supported draft call passes the stable draft id and thread", async () => {
    const fake = new FakeCall();
    const transport = transportWith(fake);
    await transport.sendDraft({ threadId: 3, draftId: 991, text: "stream" });
    expect(fake.callsTo("sendMessageDraft")[0]?.payload).toEqual({
      chat_id: 424_242,
      message_thread_id: 3,
      draft_id: 991,
      text: "stream",
    });
  });
});

describe("file download caps", () => {
  function okResponse(bytes: Uint8Array, declared: string | null): Response {
    return new Response(bytes as unknown as ConstructorParameters<typeof Response>[0], {
      status: 200,
      headers: declared === null ? {} : { "content-length": declared },
    });
  }

  test("downloads through the api root file path and enforces the declared cap", async () => {
    const fake = new FakeCall();
    fake.respond("getFile", { file_path: "photos/file_1.jpg" });
    let fetchedUrl = "";
    const transport = createTelegramTransport({
      token: "123:secret-token",
      chatId: 1,
      call: fake.call,
      fetchFile: async (url) => {
        fetchedUrl = url;
        return okResponse(new Uint8Array([1, 2, 3]), "3");
      },
    });
    const bytes = await transport.downloadFile("file-1", 10);
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(fetchedUrl).toBe("https://api.telegram.org/file/bot123:secret-token/photos/file_1.jpg");
  });

  test("rejects when the declared or actual size exceeds the cap", async () => {
    const fake = new FakeCall();
    fake.respond("getFile", { file_path: "docs/big.pdf" });
    const transport = createTelegramTransport({
      token: "123:secret-token",
      chatId: 1,
      call: fake.call,
      fetchFile: async () => okResponse(new Uint8Array(4), "4"),
    });
    await expect(transport.downloadFile("file-1", 3)).rejects.toBeInstanceOf(TelegramApiError);
  });
});

describe("connectivity and credential safety", () => {
  test("apiRoot and proxyUrl together are rejected at construction", () => {
    expect(() =>
      createTelegramTransport({
        token: "t",
        chatId: 1,
        apiRoot: "https://tg.example.com",
        proxyUrl: "socks5://127.0.0.1:9050",
        call: async () => ({}),
      }),
    ).toThrow("mutually exclusive");
  });

  test("error descriptions never contain the token", async () => {
    const fake = new FakeCall();
    fake.respond("sendMessage", () => {
      throw {
        error_code: 429,
        description: "retry later at url bot123:secret-token/x",
        parameters: { retry_after: 7 },
      };
    });
    const transport = transportWith(fake);
    try {
      await transport.sendMessage({ threadId: 1, text: "x" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TelegramApiError);
      const apiError = error as TelegramApiError;
      expect(apiError.code).toBe(429);
      expect(apiError.retryAfter).toBe(7);
      expect(apiError.description).not.toContain("123:secret-token");
      expect(apiError.description).toContain("[redacted]");
    }
  });

  test("missing message ids surface as credential-safe errors", async () => {
    const fake = new FakeCall();
    fake.respond("createForumTopic", {});
    const transport = transportWith(fake);
    await expect(transport.createForumTopic("x")).rejects.toBeInstanceOf(TelegramApiError);
  });
});
