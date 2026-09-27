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
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-003 - Created the loopback provider and bounded request trace for the packed host harness.]
// END_CHANGE_SUMMARY

import { appendFileSync, mkdirSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { assertLoopbackHttpUrl } from "./host.js";

/** One recorded provider request with model, path, and redacted body. */
export interface ProviderRequestRecord {
  readonly at: number;
  readonly event: "provider.request" | "provider.listen";
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
  return `data: ${JSON.stringify({
    id: "chatcmpl-e2e",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
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
}): Promise<LoopbackProvider> {
  assertLoopbackHttpUrl(`http://127.0.0.1:${input.port}`, "loopback provider");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: input.port,
    async fetch(request) {
      const url = new URL(request.url);
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
        if ((body as { stream?: boolean } | undefined)?.stream === true) {
          const stream = `${streamChunk(model, { role: "assistant", content: "" }, null)}${streamChunk(
            model,
            { content: "e2e-ok" },
            null,
          )}${streamChunk(model, {}, "stop")}data: [DONE]\n\n`;
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
