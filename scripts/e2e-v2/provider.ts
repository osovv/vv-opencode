#!/usr/bin/env bun
// FILE: scripts/e2e-v2/provider.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Serve a deterministic loopback-only OpenAI-compatible provider and record the exact request payloads the owned host dispatches.
//   SCOPE: In-process 127.0.0.1 HTTP server, `/v1/models` catalog response, chat completion and streaming responses, JSONL trace of request bodies and models with all authorization material dropped, and loopback-only binding. It performs no paid or public network calls and never proxies to another origin.
//   DEPENDS: [node:fs, node:path, scripts/e2e-v2/host.ts]
//   LINKS: [M-E2E-V2-HARNESS, V-M-E2E-V2-HARNESS]
//   ROLE: SCRIPT
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ProviderRequestRecord - One recorded provider request with model, path, and redacted body.
//   LoopbackProvider - Running loopback provider handle with base URL, trace path, and stop.
//   createLoopbackProvider - Start the loopback provider and JSONL trace on 127.0.0.1.
//   readProviderTrace - Read the recorded provider requests in order.
//   providerCatalog - Load the pinned model catalog fixture.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-009-FULL - Streaming responses carry an OpenAI usage chunk (real analytics), a scripted tool-call plan (per-step args derived from the request, a pre-call side-effect hook, and optional activation-marker gating) makes the host execute named tools, and a loopback WebSocket transport responder records provider.websocket events and echoes a split placeholder across frames.]
//   PREVIOUS: [C-OPENCODE-V2-NATIVE T-003 - Created the loopback provider and bounded request trace for the packed host harness.]
// END_CHANGE_SUMMARY

import { appendFileSync, mkdirSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { assertLoopbackHttpUrl } from "./host.js";

/** One recorded provider request with model, path, and redacted body. */
export interface ProviderRequestRecord {
  readonly at: number;
  readonly event: "provider.request" | "provider.listen" | "provider.websocket";
  readonly path?: string;
  readonly model?: string;
  readonly body?: unknown;
}

/** Running loopback provider handle. */
export interface LoopbackProvider {
  readonly baseUrl: string;
  readonly port: number;
  readonly tracePath: string;
  readonly catalog: unknown;
  stop(): void;
}

function traceAppend(tracePath: string, record: ProviderRequestRecord): void {
  try {
    mkdirSync(dirname(tracePath), { recursive: true });
    appendFileSync(tracePath, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Diagnostics only; a trace write failure never changes hosted behavior.
  }
}

function streamChunk(model: string, delta: unknown, finish: string | null): string {
  return `data: ${JSON.stringify(wsChunk(model, delta, finish))}\n\n`;
}

/** One OpenAI chat-completion chunk object (used as a protocol frame or SSE data). */
function wsChunk(model: string, delta: unknown, finish: string | null): Record<string, unknown> {
  return {
    id: "chatcmpl-e2e",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

/**
 * Terminal streaming chunk carrying provider-reported usage, mirroring the
 * OpenAI `stream_options.include_usage` tail so the host records native
 * `session.step.ended` token usage (analytics) from a real loopback turn.
 */
function streamUsageChunk(model: string): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-e2e",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [],
    usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 },
  })}\n\n`;
}

/** SSE response streaming one scripted function call so the host executes a tool. */
function streamToolCallResponse(model: string, callID: string, tool: string, args: unknown): string {
  return `${streamChunk(
    model,
    {
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: callID,
          type: "function",
          function: { name: tool, arguments: JSON.stringify(args) },
        },
      ],
    },
    null,
  )}${streamChunk(model, {}, "tool_calls")}${streamUsageChunk(model)}data: [DONE]\n\n`;
}

/** One scripted tool call the loopback provider streams to make the host execute a tool. */
export interface ProviderToolStep {
  readonly tool: string;
  readonly args?: unknown;
  /** Derive this step's args from the inbound request body (e.g. a read result anchor). */
  readonly argsFromRequest?: (body: unknown) => unknown;
  /** Side effect run after args are derived and before the tool call is streamed. */
  readonly before?: () => Promise<void> | void;
}

/**
 * Start the loopback provider and its JSONL trace. The server binds 127.0.0.1
 * only; the configured base URL is re-validated as loopback so a misconfigured
 * fixture can never dispatch to a public origin.
 */
export async function createLoopbackProvider(input: {
  readonly port: number;
  readonly tracePath: string;
  readonly catalog: unknown;
  readonly toolPlan?: readonly ProviderToolStep[];
  /** Only serve the tool plan when the request messages contain this text (skips warmup turns). */
  readonly toolPlanActivationText?: string;
}): Promise<LoopbackProvider> {
  assertLoopbackHttpUrl(`http://127.0.0.1:${input.port}`, "loopback provider");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: input.port,
    async fetch(request, serverRef) {
      const url = new URL(request.url);
      if ((request.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
        // Native session WebSocket (`settings.transport: "websocket"`): the host
        // sends the request JSON as the first text frame and reads protocol frames
        // back. Recorded so a real WS path can never be replaced by HTTP fallback.
        if (serverRef.upgrade(request)) return undefined;
      }
      let body: unknown = null;
      try {
        body = await request.clone().json();
      } catch {
        body = await request.clone().text().catch(() => undefined);
      }
      const model = (body as { model?: string } | undefined)?.model ?? "unknown";
      // Authorization headers are never recorded, so even fixture credentials
      // stay out of evidence.
      traceAppend(input.tracePath, {
        at: Date.now(),
        event: "provider.request",
        path: url.pathname,
        model,
        body,
      });
      if (url.pathname.endsWith("/models")) {
        return Response.json(input.catalog);
      }
      if (url.pathname.endsWith("/chat/completions")) {
        const messages = (body as { messages?: Array<{ role?: string }> } | undefined)?.messages ?? [];
        const toolResults = messages.filter((message) => message.role === "tool").length;
        const plan = input.toolPlan;
        const planActive =
          plan !== undefined &&
          (input.toolPlanActivationText === undefined ||
            JSON.stringify(messages).includes(input.toolPlanActivationText));
        if (planActive && plan !== undefined && toolResults < plan.length) {
          const step = plan[toolResults];
          if (step !== undefined) {
            const args = step.argsFromRequest ? step.argsFromRequest(body) : step.args;
            if (step.before) await step.before();
            return new Response(streamToolCallResponse(model, `call_${toolResults + 1}`, step.tool, args), {
              headers: { "content-type": "text/event-stream" },
            });
          }
        }
        if ((body as { stream?: boolean } | undefined)?.stream === true) {
          const stream = `${streamChunk(model, { role: "assistant", content: "" }, null)}${streamChunk(
            model,
            { content: "e2e-ok" },
            "stop",
          )}${streamUsageChunk(model)}data: [DONE]\n\n`;
          return new Response(stream, { headers: { "content-type": "text/event-stream" } });
        }
        return Response.json({
          id: "chatcmpl-e2e",
          object: "chat.completion",
          created: 1,
          model,
          choices: [
            { index: 0, message: { role: "assistant", content: "e2e-ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open() {
        traceAppend(input.tracePath, { at: Date.now(), event: "provider.websocket", path: "open" });
      },
      message(socket, message) {
        const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
        traceAppend(input.tracePath, {
          at: Date.now(),
          event: "provider.websocket",
          path: "message",
          body: raw,
        });
        const model = (() => {
          try {
            return (JSON.parse(raw) as { model?: string }).model ?? "seam-smart";
          } catch {
            return "seam-smart";
          }
        })();
        // Echo any redacted placeholder split across two TEXT frames so the real
        // secrets `experimental.ws.receive` restoration is exercised; otherwise a
        // plain completion. The placeholder token grammar matches the plugin's.
        const placeholder = /__VVOC_SECRET_[A-Za-z0-9_]+_[0-9a-f]{12}(?:_\d+)?__/.exec(raw)?.[0];
        const text = placeholder ?? "e2e-ok";
        const head = text.slice(0, Math.ceil(text.length / 2));
        const tail = text.slice(head.length);
        socket.send(JSON.stringify(wsChunk(model, { role: "assistant", content: "" }, null)));
        socket.send(JSON.stringify(wsChunk(model, { content: head }, null)));
        socket.send(JSON.stringify(wsChunk(model, { content: tail }, null)));
        socket.send(JSON.stringify(wsChunk(model, {}, "stop")));
        socket.close(1000);
      },
    },
  });
  traceAppend(input.tracePath, { at: Date.now(), event: "provider.listen" });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    port: server.port,
    tracePath: input.tracePath,
    catalog: input.catalog,
    stop: () => server.stop(true),
  };
}

/** Read the recorded provider requests in order. */
export async function readProviderTrace(tracePath: string): Promise<ProviderRequestRecord[]> {
  let text: string;
  try {
    text = await readFile(tracePath, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ProviderRequestRecord);
}

/** Load the pinned model catalog fixture. */
export async function providerCatalog(path: string): Promise<unknown> {
  await mkdir(dirname(path), { recursive: true });
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
