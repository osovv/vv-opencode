// FILE: src/plugins/secrets-redaction/stream.test.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify split-placeholder restoration across streamed text deltas and exact preservation of opaque/binary/tool-protocol frames for SSE, byte-level SSE, non-SSE JSON/text bodies and WebSocket TEXT frames.
//   SCOPE: TextDeltaRestorer carry semantics, per-lane SseRestoreStream restoration for OpenAI chat/Responses, Anthropic and Gemini shapes, terminal-aware flushing before the held terminal frame, CRLF opaque passthrough, bounded buffers, non-SSE body restoration, and WebSocket frame restoration across frame boundaries (complete SSE events, mid-line data-line splits with no injected newline, unterminated complete lines, interleaved lanes, terminal flush/reset).
//   DEPENDS: [bun:test, src/plugins/secrets-redaction/session.ts, src/plugins/secrets-redaction/stream.ts]
//   LINKS: [M-PLUGIN-SECRETS-REDACTION, V-M-PLUGIN-SECRETS-REDACTION, DF-SECRETS-REDACTION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SECRET_A - First stable secret fixture.
//   SECRET_B - Second stable secret fixture.
//   makeSession - Build a placeholder session with two redacted secrets.
//   splitAt - Split a string into two parts.
//   chatChunk - Build an OpenAI chat SSE delta frame.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-009 - Added category-grammar transport coverage: lowercase/punctuation split across SSE and Unicode/over-long split across WebSocket frames, plus an unrecognized-placeholder disabled control. PREVIOUS: [wi-7 - WebSocket regression coverage for split placeholders, mid-line splits, unterminated JSON lines, interleaved lanes, and terminal flush/reset.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { PlaceholderSession } from "./session.js";
import {
  TextDeltaRestorer,
  createFrameRestoreState,
  createResponseByteTransform,
  createSseByteTransform,
  createSseRestoreStream,
  restoreNonSseBody,
  restoreProviderFrame,
} from "./stream.js";

const SECRET_A = "qa-stream-secret-771243@example.invalid";
const SECRET_B = "qa-stream-secret-882355@example.invalid";

function makeSession(): { session: PlaceholderSession; a: string; b: string } {
  const session = new PlaceholderSession({
    prefix: "__VVOC_SECRET_",
    ttlMs: 0,
    maxMappings: 100,
    secret: "unit-test-secret",
  });
  return {
    session,
    a: session.getOrCreatePlaceholder(SECRET_A, "EMAIL"),
    b: session.getOrCreatePlaceholder(SECRET_B, "EMAIL"),
  };
}

function splitAt(value: string, at: number): [string, string] {
  return [value.slice(0, at), value.slice(at)];
}

function chatChunk(content: string, index = 0): string {
  return `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model: "m", choices: [{ index, delta: { content }, finish_reason: null }] })}\n\n`;
}

describe("TextDeltaRestorer", () => {
  test("restores a placeholder split across two text pushes", () => {
    const { session, a } = makeSession();
    const restorer = new TextDeltaRestorer(session);
    const [head, tail] = splitAt(a, 9);
    const first = restorer.push(`prefix ${head}`);
    const second = restorer.push(`${tail} suffix`);
    expect(first).not.toContain(SECRET_A);
    expect(`${first}${second}`).toContain(`prefix ${SECRET_A} suffix`);
  });

  test("carries and safely flushes a trailing '__' ordinary suffix", () => {
    const { session, a } = makeSession();
    const restorer = new TextDeltaRestorer(session);
    expect(restorer.push("plain __")).toBe("plain ");
    expect(restorer.pending).toBe(true);
    expect(restorer.flush()).toBe("__");

    const afterComplete = new TextDeltaRestorer(session);
    expect(afterComplete.push(`${a}__`)).toBe(SECRET_A);
    expect(afterComplete.flush()).toBe("__");
  });

  test("emits a complete trailing placeholder immediately and withholds a trailing fragment", () => {
    const { session, a } = makeSession();
    const restorer = new TextDeltaRestorer(session);
    expect(restorer.push(`x ${a} y`)).toContain(SECRET_A);
    expect(restorer.flush()).toBe("");

    const [head] = splitAt(a, 4);
    expect(restorer.push(`z ${head}`)).toBe("z ");
    expect(restorer.pending).toBe(true);
    expect(restorer.flush()).toBe(head);
  });
});

describe("SseRestoreStream", () => {
  test("restores an OpenAI chat delta placeholder split across two SSE events", () => {
    const { session, a } = makeSession();
    const stream = createSseRestoreStream(session);
    const [head, tail] = splitAt(a, 7);
    const output = `${stream.push(chatChunk(`hello ${head}`))}${stream.push(chatChunk(`${tail} world`))}${stream.push("data: [DONE]\n\n")}${stream.flush()}`;
    expect(output).toContain(SECRET_A);
    expect(output).not.toContain(a);
    expect(output.indexOf(SECRET_A)).toBeLessThan(output.indexOf("[DONE]"));
  });

  test("flushes a trailing carry as a recognized lane event before the terminal frame", () => {
    const { session, a } = makeSession();
    const stream = createSseRestoreStream(session);
    const [head] = splitAt(a, 6);
    const before = stream.push(chatChunk(`tail ${head}`));
    const terminal = stream.push("data: [DONE]\n\n");
    const flushed = stream.flush();
    const total = `${before}${terminal}${flushed}`;
    expect(total).toContain(head);
    expect(total.indexOf(head)).toBeLessThan(total.indexOf("[DONE]"));
    // No free text is appended after the terminal marker.
    expect(total.trimEnd().endsWith("[DONE]")).toBe(true);
  });

  test("ends only the identified Anthropic block and keeps restoring a later block", () => {
    const { session, a } = makeSession();
    const stream = createSseRestoreStream(session);
    const [head, tail] = splitAt(a, 5);
    const block = (index: number, text: string) =>
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index, delta: { type: "text_delta", text } })}\n\n`;
    const stop = (index: number) =>
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index })}\n\n`;
    const output =
      stream.push(block(0, `x ${head}`)) +
      stream.push(stop(0)) +
      stream.push(block(1, `y ${head}`)) +
      stream.push(block(1, `${tail} z`)) +
      stream.push(stop(1)) +
      stream.push("data: [DONE]\n\n") +
      stream.flush();
    // Block 0's carry was flushed before its stop frame, and block 1 still restored.
    expect(output).toContain("__VVO");
    expect(output).toContain("content_block_stop");
    expect(output).toContain(SECRET_A);
    expect(output.indexOf(SECRET_A)).toBeLessThan(output.indexOf("[DONE]"));
  });

  test("an OpenAI choice stop ends only that choice lane", () => {
    const { session, a, b } = makeSession();
    const stream = createSseRestoreStream(session);
    const [aHead] = splitAt(a, 6);
    const [bHead, bTail] = splitAt(b, 6);
    const first = `data: ${JSON.stringify({
      id: "c",
      model: "m",
      choices: [
        { index: 0, delta: { content: `A ${aHead}` }, finish_reason: null },
        { index: 1, delta: { content: `B ${bHead}` }, finish_reason: null },
      ],
    })}\n\n`;
    // Choice 0 finishes; choice 1 keeps streaming and completes its placeholder.
    const second = `data: ${JSON.stringify({
      id: "c",
      model: "m",
      choices: [
        { index: 0, delta: {}, finish_reason: "stop" },
        { index: 1, delta: { content: `${bTail} done` }, finish_reason: null },
      ],
    })}\n\n`;
    const output = `${stream.push(first)}${stream.push(second)}${stream.push("data: [DONE]\n\n")}${stream.flush()}`;
    // Choice 0 stopped mid-placeholder, so its partial carry is flushed (not completed);
    // choice 1 continues independently and its secret restores.
    expect(output).toContain(SECRET_B);
    expect(output).toContain(`"index":0`);
  });

  test("scopes Responses restoration by item/content identity", () => {
    const { session, a, b } = makeSession();
    const stream = createSseRestoreStream(session);
    const [aHead, aTail] = splitAt(a, 6);
    const [bHead, bTail] = splitAt(b, 6);
    const delta = (item: string, index: number, text: string) =>
      `data: ${JSON.stringify({ type: "response.output_text.delta", item_id: item, output_index: index, content_index: 0, delta: text })}\n\n`;
    const output = `${stream.push(delta("item_a", 0, aHead))}${stream.push(delta("item_b", 1, bHead))}${stream.push(delta("item_a", 0, aTail))}${stream.push(delta("item_b", 1, bTail))}${stream.push(
      `data: ${JSON.stringify({ type: "response.output_text.done", item_id: "item_a", output_index: 0, content_index: 0 })}\n\n`,
    )}${stream.push("data: [DONE]\n\n")}${stream.flush()}`;
    expect(output).toContain(SECRET_A);
    expect(output).toContain(SECRET_B);
  });

  test("flushes two lanes from one frame as separate minimal frames without sibling text", () => {
    const { session, a, b } = makeSession();
    const stream = createSseRestoreStream(session);
    const [aHead] = splitAt(a, 6);
    const [bHead] = splitAt(b, 6);
    const frame = `data: ${JSON.stringify({
      id: "c",
      model: "m",
      choices: [
        { index: 0, delta: { content: `A ${aHead}` }, finish_reason: null },
        { index: 1, delta: { content: `B ${bHead}` }, finish_reason: null },
      ],
    })}\n\n`;
    const out = `${stream.push(frame)}${stream.flush()}`;
    const flushed = out
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map(
        (line) =>
          JSON.parse(line.slice(6)) as {
            choices?: Array<{ index: number; delta: { content: string } }>;
          },
      )
      .filter((parsed) => Array.isArray(parsed.choices) && parsed.choices.length === 1);
    expect(flushed).toHaveLength(2);
    for (const parsed of flushed) {
      const content = parsed.choices![0]!.delta.content;
      expect(content === aHead || content === bHead).toBe(true);
    }
  });

  test("keeps processing frames after a choice stop instead of buffering them", () => {
    const { session } = makeSession();
    const stream = createSseRestoreStream(session);
    const stop = `data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`;
    let output = stream.push(stop);
    for (let index = 0; index < 200; index += 1) output += stream.push(chatChunk("more"));
    expect(output).toContain("more");
    expect(output.length).toBeGreaterThan(200 * 10);
  });

  test("preserves opaque, comment, malformed and CRLF frames byte-for-byte", () => {
    const { session } = makeSession();
    const stream = createSseRestoreStream(session);
    const opaque = "event: ping\r\n: keep-alive\r\ndata: not-json\r\ndata: [DONE]\r\n\r\n";
    const output = stream.push(opaque) + stream.flush();
    expect(output).toBe(opaque);
  });

  test("scopes carries by lane so interleaved choices do not conflate", () => {
    const { session, a, b } = makeSession();
    const stream = createSseRestoreStream(session);
    const [aHead, aTail] = splitAt(a, 8);
    const [bHead, bTail] = splitAt(b, 8);
    const event1 = `data: ${JSON.stringify({
      id: "c",
      choices: [
        { index: 0, delta: { content: `A ${aHead}` }, finish_reason: null },
        { index: 1, delta: { content: `B ${bHead}` }, finish_reason: null },
      ],
    })}\n\n`;
    const event2 = `data: ${JSON.stringify({
      id: "c",
      choices: [
        { index: 0, delta: { content: `${aTail} done` }, finish_reason: null },
        { index: 1, delta: { content: `${bTail} done` }, finish_reason: null },
      ],
    })}\n\n`;
    const output = `${stream.push(event1)}${stream.push(event2)}${stream.flush()}`;
    expect(output).toContain(SECRET_A);
    expect(output).toContain(SECRET_B);
  });

  test("restores Anthropic and Gemini text shapes", () => {
    const { session, a } = makeSession();
    const anthropic = createSseRestoreStream(session);
    expect(
      anthropic.push(
        `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: a } })}\n\n`,
      ),
    ).toContain(SECRET_A);

    const gemini = createSseRestoreStream(session);
    expect(
      gemini.push(
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: a }] } }] })}\n\n`,
      ),
    ).toContain(SECRET_A);
  });

  test("bounds an oversized unterminated line instead of buffering without limit", () => {
    const { session } = makeSession();
    const stream = createSseRestoreStream(session);
    const huge = `data: ${"x".repeat(70_000)}`;
    const output = stream.push(huge);
    expect(output.length).toBeGreaterThanOrEqual(huge.length);
    // The internal buffer is released; a following small frame still processes.
    expect(stream.push(chatChunk("after"))).toContain("after");
  });

  test("caps lane state instead of growing without bound", () => {
    const { session, a } = makeSession();
    const stream = createSseRestoreStream(session);
    const [head] = splitAt(a, 6);
    for (let index = 0; index < 200; index += 1) {
      stream.push(chatChunk(head, index));
    }
    expect(() => stream.flush()).not.toThrow();
  });
});

describe("createSseByteTransform", () => {
  test("restores placeholders split across byte chunks", async () => {
    const { session, a } = makeSession();
    const payload = chatChunk(a) + "data: [DONE]\n\n";
    const bytes = new TextEncoder().encode(payload);
    const split = Math.floor(bytes.length / 2);
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, split));
        controller.enqueue(bytes.slice(split));
        controller.close();
      },
    });
    const text = await new Response(source.pipeThrough(createSseByteTransform(session))).text();
    expect(text).toContain(SECRET_A);
  });
});

describe("non-SSE body restoration", () => {
  test("restores recognized JSON completion text without corrupting structure", async () => {
    const { session, a } = makeSession();
    const body = JSON.stringify({
      id: "c",
      choices: [
        { index: 0, message: { role: "assistant", content: `hi ${a}` }, finish_reason: "stop" },
      ],
    });
    const restored = restoreNonSseBody(session, body);
    expect(restored).toContain(SECRET_A);
    expect(JSON.parse(restored).choices[0].message.content).toBe(`hi ${SECRET_A}`);

    expect(restoreNonSseBody(session, "{not json")).toBe("{not json");
    expect(restoreNonSseBody(session, "\u0000binary")).toBe("\u0000binary");
    expect(restoreNonSseBody(session, `plain ${a}`)).toBe(`plain ${SECRET_A}`);
  });

  test("createResponseByteTransform restores a buffered non-SSE JSON body", async () => {
    const { session, a } = makeSession();
    const body = JSON.stringify({ content: [{ type: "text", text: `hi ${a}` }] });
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(body);
        controller.enqueue(bytes.slice(0, 10));
        controller.enqueue(bytes.slice(10));
        controller.close();
      },
    });
    const text = await new Response(
      source.pipeThrough(createResponseByteTransform(session, "application/json")),
    ).text();
    expect(text).toContain(SECRET_A);
  });
});

describe("restoreProviderFrame", () => {
  test("restores an OpenAI Responses delta placeholder split across WebSocket frames", () => {
    const { session, a } = makeSession();
    const state = createFrameRestoreState(session);
    const [head, tail] = splitAt(a, 5);
    const first = restoreProviderFrame(
      session,
      JSON.stringify({ type: "response.output_text.delta", delta: `hi ${head}` }),
      state,
    );
    const second = restoreProviderFrame(
      session,
      JSON.stringify({ type: "response.output_text.delta", delta: `${tail} bye` }),
      state,
    );
    expect(`${first}${second}`).toContain(SECRET_A);
  });

  test("resets per-connection state on a terminal frame so it cannot bleed across requests", () => {
    const { session, a } = makeSession();
    const state = createFrameRestoreState(session);
    const [head] = splitAt(a, 5);
    restoreProviderFrame(
      session,
      JSON.stringify({ choices: [{ delta: { content: head } }] }),
      state,
    );
    expect(state.restorers.size).toBeGreaterThan(0);
    restoreProviderFrame(
      session,
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      state,
    );
    expect(state.restorers.size).toBe(0);
    expect(state.text.pending).toBe(false);
  });

  test("preserves opaque, binary and tool-protocol frames exactly", () => {
    const { session } = makeSession();
    const state = createFrameRestoreState(session);
    for (const frame of [
      "\u0000\u0001\u0002binary",
      JSON.stringify({ type: "tool.protocol", callID: "c1", payload: { n: 1 } }),
      "{not json",
    ]) {
      expect(restoreProviderFrame(session, frame, state)).toBe(frame);
    }
  });

  test("restores a placeholder split across two complete SSE events in distinct WebSocket frames", () => {
    const { session, a } = makeSession();
    const state = createFrameRestoreState(session);
    const [head, tail] = splitAt(a, 7);
    const event = (content: string): string =>
      `data: ${JSON.stringify({
        id: "c",
        model: "m",
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      })}\n\n`;
    const output =
      restoreProviderFrame(session, event(`hi ${head}`), state) +
      restoreProviderFrame(session, event(`${tail} bye`), state);
    // Carry persisted across the frame boundary instead of resetting per frame.
    expect(output).toContain(SECRET_A);
    expect(output).not.toContain(a);
  });

  test("does not inject a newline into a data line split across WebSocket frames", () => {
    const { session, a } = makeSession();
    const state = createFrameRestoreState(session);
    const [head, tail] = splitAt(a, 9);
    const first = `data: {"id":"c","model":"m","choices":[{"index":0,"delta":{"content":"cut ${head}`;
    const second = `${tail} tail"},"finish_reason":null}]}\n\n`;
    const output =
      restoreProviderFrame(session, first, state) + restoreProviderFrame(session, second, state);
    const dataLines = output.split("\n").filter((line) => line.startsWith("data:"));
    expect(dataLines).toHaveLength(1);
    expect(dataLines[0]).toContain(SECRET_A);
    expect(output).not.toContain(a);
  });

  test("restores a complete JSON data line that arrives without a trailing newline", () => {
    const { session, a } = makeSession();
    const state = createFrameRestoreState(session);
    const [head, tail] = splitAt(a, 9);
    const first = `data: {"choices":[{"delta":{"content":"part ${head}`;
    const second = `${tail}} more"}}]}`;
    const output =
      restoreProviderFrame(session, first, state) + restoreProviderFrame(session, second, state);
    const nonEmpty = output.split("\n").filter((line) => line.trim() !== "");
    expect(nonEmpty).toHaveLength(1);
    expect(nonEmpty[0]).toContain(SECRET_A);
    expect(output).not.toContain(a);
  });

  test("keeps independent lanes across WebSocket frames", () => {
    const { session, a, b } = makeSession();
    const state = createFrameRestoreState(session);
    const [aHead, aTail] = splitAt(a, 8);
    const [bHead, bTail] = splitAt(b, 8);
    const event = (contentA: string, contentB: string): string =>
      `data: ${JSON.stringify({
        id: "c",
        model: "m",
        choices: [
          { index: 0, delta: { content: contentA }, finish_reason: null },
          { index: 1, delta: { content: contentB }, finish_reason: null },
        ],
      })}\n\n`;
    const output =
      restoreProviderFrame(session, event(`A ${aHead}`, `B ${bHead}`), state) +
      restoreProviderFrame(session, event(`${aTail} done`, `${bTail} done`), state);
    expect(output).toContain(SECRET_A);
    expect(output).toContain(SECRET_B);
  });

  test("a terminal frame flushes the carry and resets connection state", () => {
    const { session, a } = makeSession();
    const state = createFrameRestoreState(session);
    const [head] = splitAt(a, 6);
    const partial = `data: ${JSON.stringify({
      id: "c",
      model: "m",
      choices: [{ index: 0, delta: { content: `tail ${head}` }, finish_reason: null }],
    })}\n\n`;
    restoreProviderFrame(session, partial, state);
    expect(state.sse).not.toBeNull();
    const terminal = restoreProviderFrame(session, "data: [DONE]\n\n", state);
    expect(terminal).toContain(head);
    expect(terminal.indexOf(head)).toBeLessThan(terminal.indexOf("[DONE]"));
    expect(state.sse).toBeNull();
  });
});

describe("placeholder category grammar across transports", () => {
  function categorySession(category: string, value: string) {
    const session = new PlaceholderSession({
      prefix: "__VVOC_SECRET_",
      ttlMs: 0,
      maxMappings: 100,
      secret: "unit-test-secret",
    });
    return { session, placeholder: session.getOrCreatePlaceholder(value, category) };
  }

  test("lowercase and punctuation categories restore when split across SSE events", () => {
    for (const category of ["lowercase", "custom-key", "dotted.key", "mixedCase9"]) {
      const { session, placeholder } = categorySession(category, `secret-${category}`);
      const stream = createSseRestoreStream(session);
      const [head, tail] = splitAt(placeholder, 8);
      const output = `${stream.push(chatChunk(`hello ${head}`))}${stream.push(chatChunk(`${tail} world`))}${stream.push("data: [DONE]\n\n")}${stream.flush()}`;
      expect(output).toContain(`secret-${category}`);
      expect(output).not.toContain(placeholder);
    }
  });

  test("Unicode and over-long categories restore when split across WebSocket frames", () => {
    for (const category of ["подпись", "a".repeat(200), "!!!", "IPV4"]) {
      const value = `secret-${category.length}`;
      const { session, placeholder } = categorySession(category, value);
      const state = createFrameRestoreState(session);
      const [head, tail] = splitAt(placeholder, 7);
      const first = restoreProviderFrame(
        session,
        JSON.stringify({ type: "response.output_text.delta", delta: `hi ${head}` }),
        state,
      );
      const second = restoreProviderFrame(
        session,
        JSON.stringify({ type: "response.output_text.delta", delta: `${tail} bye` }),
        state,
      );
      expect(`${first}${second}`).toContain(value);
    }
  });

  test("an unrecognized placeholder from another session stays untouched (disabled control)", () => {
    const { session } = categorySession("lowercase", "secret-one");
    const other = categorySession("lowercase", "secret-two");
    const restorer = new TextDeltaRestorer(session);
    expect(`${restorer.push(other.placeholder)}${restorer.flush()}`).toBe(other.placeholder);
  });
});
