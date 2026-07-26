// FILE: src/plugins/web-tools/http.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Provide shared bounded HTTP execution for the web tools providers and media loader.
//   SCOPE: Timeout enforcement, caller abort propagation, a hard response-size cap, redirect following, and a transport error taxonomy.
//   DEPENDS: [none]
//   LINKS: [M-WEB-HTTP, M-WEB-EXA, M-WEB-BRAVE, M-WEB-NATIVE-FETCH, M-WEB-SPIDER, M-WEB-MEDIA-LOADER]
//   ROLE: UTILITY
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   WebHttpErrorCode - Transport error codes.
//   WebHttpError - Transport-level error carrying a code and optional HTTP status.
//   BoundedHttpRequest - Request input with timeout, size cap, and optional caller abort.
//   BoundedHttpResponse - Response with status, headers, bytes, and final URL.
//   FetchLike - Minimal fetch-compatible callable for injectable mocks.
//   DEFAULT_TEXT_MAX_BYTES - Default cap for textual responses.
//   DEFAULT_MEDIA_MAX_BYTES - Default cap for media responses.
//   DEFAULT_REQUEST_TIMEOUT_MS - Default request timeout.
//   requestBounded - Execute one bounded HTTP request.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Initial bounded HTTP transport and error taxonomy for the unified web tools.]
// END_CHANGE_SUMMARY

export type WebHttpErrorCode = "NETWORK_ERROR" | "TIMEOUT" | "ABORTED" | "OVERSIZED" | "HTTP_ERROR";

/** Transport-level failure. status is set only for HTTP_ERROR. Messages never include credentials. */
export class WebHttpError extends Error {
  readonly code: WebHttpErrorCode;
  readonly status?: number;

  constructor(code: WebHttpErrorCode, message: string, status?: number) {
    super(message);
    this.name = "WebHttpError";
    this.code = code;
    this.status = status;
  }
}

export type BoundedHttpRequest = {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /** Wall-clock timeout in milliseconds. */
  timeoutMs: number;
  /** Hard response body cap in bytes. */
  maxBytes: number;
  /** Optional caller abort signal; combined with the internal timeout controller. */
  abort?: AbortSignal;
};

export type BoundedHttpResponse = {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
  finalUrl: string;
};

/** Minimal fetch-compatible callable; avoids Bun-specific fetch properties for injectable mocks. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Default cap for textual responses (5 MiB). */
export const DEFAULT_TEXT_MAX_BYTES = 5 * 1024 * 1024;
/** Default cap for media responses (20 MiB). */
export const DEFAULT_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
/** Default request timeout (30 seconds). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

// START_BLOCK_HELPERS
function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mapTransportError(
  error: unknown,
  controller: AbortController,
  timedOut: boolean,
  timeoutMs: number,
): WebHttpError {
  if (controller.signal.aborted) {
    if (timedOut) {
      return new WebHttpError("TIMEOUT", `request timed out after ${timeoutMs}ms`);
    }
    return new WebHttpError("ABORTED", "request aborted by caller");
  }
  return new WebHttpError("NETWORK_ERROR", `network error: ${safeMessage(error)}`);
}

async function readBodyWithCap(
  response: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<Uint8Array> {
  const body = response.body;
  if (!body) {
    return new Uint8Array(0);
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        controller.abort();
        throw new WebHttpError("OVERSIZED", `response body exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
// END_BLOCK_HELPERS

// START_CONTRACT: requestBounded
//   PURPOSE: Execute one bounded HTTP request.
//   INPUTS: { request: BoundedHttpRequest; fetchImpl: injectable fetch implementation for tests }
//   OUTPUTS: { BoundedHttpResponse - status, headers, bytes, and finalUrl }
//   SIDE_EFFECTS: performs network I/O through fetchImpl; rejects with WebHttpError on failure
//   LINKS: M-WEB-EXA, M-WEB-BRAVE, M-WEB-NATIVE-FETCH, M-WEB-SPIDER, M-WEB-MEDIA-LOADER
// END_CONTRACT: requestBounded
export async function requestBounded(
  request: BoundedHttpRequest,
  fetchImpl: FetchLike = fetch,
): Promise<BoundedHttpResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.timeoutMs);

  const onCallerAbort = () => controller.abort();
  if (request.abort) {
    if (request.abort.aborted) {
      controller.abort();
    } else {
      request.abort.addEventListener("abort", onCallerAbort, { once: true });
    }
  }

  try {
    let response: Response;
    try {
      response = await fetchImpl(request.url, {
        method: request.method ?? "GET",
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
        redirect: "follow",
      });
    } catch (error) {
      throw mapTransportError(error, controller, timedOut, request.timeoutMs);
    }

    if (!response.ok) {
      throw new WebHttpError(
        "HTTP_ERROR",
        `HTTP ${response.status} for ${request.url}`,
        response.status,
      );
    }

    let bytes: Uint8Array;
    try {
      bytes = await readBodyWithCap(response, request.maxBytes, controller);
    } catch (error) {
      if (error instanceof WebHttpError) {
        throw error;
      }
      throw mapTransportError(error, controller, timedOut, request.timeoutMs);
    }

    return {
      status: response.status,
      headers: response.headers,
      bytes,
      finalUrl: response.url || request.url,
    };
  } finally {
    clearTimeout(timeout);
    request.abort?.removeEventListener("abort", onCallerAbort);
  }
}
