// FILE: src/plugins/web-tools/http.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the bounded HTTP transport: success path, timeout, caller abort, size cap, HTTP errors, network errors, and fetch injection.
//   SCOPE: Deterministic tests using injected fetch implementations; no real network I/O.
//   DEPENDS: [bun:test, src/plugins/web-tools/http.ts]
//   LINKS: [M-WEB-HTTP]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   URL - Stable request URL used by transport tests.
//   signalAwareFetch - Hanging fetch fixture that rejects when aborted.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Initial coverage for the bounded HTTP transport.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { requestBounded, WebHttpError, type FetchLike } from "./http.js";

const URL = "https://example.test/resource";

/** A fetch that respects the abort signal and otherwise never resolves. */
const signalAwareFetch: FetchLike = (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    signal?.addEventListener("abort", () => reject(new Error("aborted")));
  });

describe("requestBounded", () => {
  test("resolves a 200 response within limits with status, bytes, and finalUrl", async () => {
    const okFetch: FetchLike = async () => new Response("hello", { status: 200 });
    const response = await requestBounded({ url: URL, timeoutMs: 1000, maxBytes: 100 }, okFetch);
    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(response.bytes)).toBe("hello");
    expect(response.finalUrl).toBe(URL);
  });

  test("rejects with TIMEOUT when the request exceeds timeoutMs", async () => {
    await expect(
      requestBounded({ url: URL, timeoutMs: 20, maxBytes: 100 }, signalAwareFetch),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  test("rejects with ABORTED when the caller abort signal fires", async () => {
    const controller = new AbortController();
    const promise = requestBounded(
      { url: URL, timeoutMs: 5000, maxBytes: 100, abort: controller.signal },
      signalAwareFetch,
    );
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toMatchObject({ code: "ABORTED" });
  });

  test("rejects with ABORTED when the caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      requestBounded(
        { url: URL, timeoutMs: 5000, maxBytes: 100, abort: controller.signal },
        signalAwareFetch,
      ),
    ).rejects.toMatchObject({ code: "ABORTED" });
  });

  test("rejects with OVERSIZED when the body exceeds maxBytes", async () => {
    const bigFetch: FetchLike = async () => new Response("hello world", { status: 200 });
    await expect(
      requestBounded({ url: URL, timeoutMs: 1000, maxBytes: 5 }, bigFetch),
    ).rejects.toMatchObject({ code: "OVERSIZED" });
  });

  test("rejects with HTTP_ERROR carrying the status for non-2xx responses", async () => {
    const notFoundFetch: FetchLike = async () => new Response("nope", { status: 404 });
    const error = await requestBounded(
      { url: URL, timeoutMs: 1000, maxBytes: 100 },
      notFoundFetch,
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(WebHttpError);
    expect(error.code).toBe("HTTP_ERROR");
    expect(error.status).toBe(404);
  });

  test("rejects with NETWORK_ERROR on a connection failure", async () => {
    const failingFetch: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(
      requestBounded({ url: URL, timeoutMs: 1000, maxBytes: 100 }, failingFetch),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });

  test("uses the injected fetchImpl as the only network path", async () => {
    let called = 0;
    const countingFetch: FetchLike = async () => {
      called += 1;
      return new Response("ok", { status: 200 });
    };
    await requestBounded({ url: URL, timeoutMs: 1000, maxBytes: 100 }, countingFetch);
    expect(called).toBe(1);
  });
});
