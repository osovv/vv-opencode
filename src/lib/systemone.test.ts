// FILE: src/lib/systemone.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the provider-neutral System One client: request shaping, typed noul/choice/score decoding, unknown-field tolerance, bounded retry and timeout, vendor-neutral base URLs, and credential-safe errors.
//   SCOPE: Injected-transport tests for evaluateSystemOne over the /v1/systemone protocol; no live endpoint, API key, or network is used.
//   DEPENDS: [src/lib/systemone.ts]
//   LINKS: [M-SYSTEMONE-PROVIDER, V-M-SYSTEMONE-PROVIDER]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   jsonResponse - Build a transport response with a JSON body.
//   recordingTransport - Capture requests while returning queued responses.
//   connection - Base connection settings with a short timeout and no retries.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-SYSTEMONE-DECISION-BACKEND T-001 - Added deterministic client tests over an injected transport.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import {
  evaluateSystemOne,
  SystemOneError,
  type SystemOneConnection,
  type SystemOneHttpRequest,
  type SystemOneHttpResponse,
  type SystemOneTransport,
} from "./systemone.js";

function jsonResponse(status: number, body: unknown): SystemOneHttpResponse {
  return { status, body: JSON.stringify(body) };
}

function recordingTransport(responses: Array<SystemOneHttpResponse | Error>): {
  transport: SystemOneTransport;
  requests: SystemOneHttpRequest[];
} {
  const requests: SystemOneHttpRequest[] = [];
  let index = 0;
  const transport: SystemOneTransport = async (request) => {
    requests.push(request);
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next instanceof Error) {
      throw next;
    }
    return next;
  };
  return { transport, requests };
}

const connection: SystemOneConnection = {
  baseUrl: "http://localhost:8790",
  model: "example",
  apiKey: "secret-token",
  timeoutMs: 50,
  maxRetries: 0,
};

describe("evaluateSystemOne", () => {
  test("shapes the request and decodes noul, choice, and score answers", async () => {
    const { transport, requests } = recordingTransport([
      jsonResponse(200, {
        model: "provider-default",
        latency_ms: 41,
        answers: {
          low_risk: { type: "noul", noul: 0.97, latency_ms: 41 },
          team: {
            type: "choice",
            choice: "technical",
            confidence: 0.78,
            probabilities: { technical: 0.85, billing: 0.15 },
          },
          risk: {
            type: "score",
            score: 1.0,
            confidence: 1.0,
            legend: { "0": "low", "1": "medium" },
            probabilities: { "0": 0, "1": 1 },
          },
        },
      }),
    ]);

    const result = await evaluateSystemOne({
      state: "action",
      questions: {
        low_risk: { type: "noul", instructions: "Is the action low risk?" },
        team: {
          type: "choice",
          instructions: "Which team?",
          criteria: { technical: null, billing: null },
        },
        risk: { type: "score", instructions: "How risky?", criteria: ["low", "medium"] },
      },
      connection,
      transport,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://localhost:8790/v1/systemone");
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.headers.authorization).toBe("Bearer secret-token");
    const body = JSON.parse(requests[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body.model).toBe("example");
    expect(body.state).toBe("action");
    expect(Object.keys(body.questions as Record<string, unknown>).sort()).toEqual([
      "low_risk",
      "risk",
      "team",
    ]);

    expect(result.model).toBe("provider-default");
    expect(result.answers.low_risk).toEqual({ type: "noul", noul: 0.97 });
    expect(result.answers.team).toMatchObject({
      type: "choice",
      choice: "technical",
      confidence: 0.78,
    });
    expect(result.answers.risk).toMatchObject({ type: "score", score: 1 });
  });

  test("omits the authorization header when no apiKey is configured", async () => {
    const { transport, requests } = recordingTransport([
      jsonResponse(200, { answers: { a: { type: "noul", noul: 0.5 } } }),
    ]);
    await evaluateSystemOne({
      state: "x",
      questions: { a: { type: "noul", instructions: "?" } },
      connection: { ...connection, apiKey: undefined },
      transport,
    });
    expect(requests[0]?.headers.authorization).toBeUndefined();
  });

  test("reaches two distinct base URLs through the same client without a vendor branch", async () => {
    const cloud = recordingTransport([
      jsonResponse(200, { answers: { a: { type: "noul", noul: 0.5 } } }),
    ]);
    const local = recordingTransport([
      jsonResponse(200, { answers: { a: { type: "noul", noul: 0.5 } } }),
    ]);
    const questions = { a: { type: "noul" as const, instructions: "?" } };
    await evaluateSystemOne({
      state: "x",
      questions,
      connection: { ...connection, baseUrl: "https://api.example.test" },
      transport: cloud.transport,
    });
    await evaluateSystemOne({ state: "x", questions, connection, transport: local.transport });
    expect(cloud.requests[0]?.url).toBe("https://api.example.test/v1/systemone");
    expect(local.requests[0]?.url).toBe("http://localhost:8790/v1/systemone");
  });

  test("retries a retryable status then succeeds within the bound", async () => {
    const { transport, requests } = recordingTransport([
      jsonResponse(503, { detail: "busy" }),
      jsonResponse(200, { answers: { a: { type: "noul", noul: 0.5 } } }),
    ]);
    const result = await evaluateSystemOne({
      state: "x",
      questions: { a: { type: "noul", instructions: "?" } },
      connection: { ...connection, maxRetries: 1 },
      transport,
    });
    expect(requests).toHaveLength(2);
    expect(result.answers.a).toEqual({ type: "noul", noul: 0.5 });
  });

  test("does not retry a rejected credential and keeps the key out of the message", async () => {
    const { transport, requests } = recordingTransport([jsonResponse(401, { detail: "nope" })]);
    const error = await evaluateSystemOne({
      state: "top-secret-state",
      questions: { a: { type: "noul", instructions: "?" } },
      connection: { ...connection, maxRetries: 3 },
      transport,
    }).catch((cause: unknown) => cause as SystemOneError);
    expect(error).toBeInstanceOf(SystemOneError);
    expect((error as SystemOneError).code).toBe("UNAUTHORIZED");
    expect((error as SystemOneError).message).not.toContain("secret-token");
    expect((error as SystemOneError).message).not.toContain("top-secret-state");
    expect(requests).toHaveLength(1);
  });

  test("reports a timeout and a malformed response as typed errors", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const timeout = await evaluateSystemOne({
      state: "x",
      questions: { a: { type: "noul", instructions: "?" } },
      connection,
      transport: recordingTransport([abort]).transport,
    }).catch((cause: unknown) => cause as SystemOneError);
    expect((timeout as SystemOneError).code).toBe("TIMEOUT");

    const bad = await evaluateSystemOne({
      state: "x",
      questions: { a: { type: "noul", instructions: "?" } },
      connection,
      transport: recordingTransport([
        jsonResponse(200, { answers: { a: { type: "noul", noul: 5 } } }),
      ]).transport,
    }).catch((cause: unknown) => cause as SystemOneError);
    expect((bad as SystemOneError).code).toBe("INVALID_RESPONSE");
  });

  test("rejects invalid local request shapes before any call", async () => {
    const { transport, requests } = recordingTransport([jsonResponse(200, { answers: {} })]);
    const empty = await evaluateSystemOne({
      state: "x",
      questions: {},
      connection,
      transport,
    }).catch((cause: unknown) => cause as SystemOneError);
    expect((empty as SystemOneError).code).toBe("INVALID_REQUEST");

    const tooMany = Object.fromEntries(
      Array.from({ length: 256 }, (_, index) => [`o${index}`, null]),
    );
    const choice = await evaluateSystemOne({
      state: "x",
      questions: { a: { type: "choice", instructions: "?", criteria: tooMany } },
      connection,
      transport,
    }).catch((cause: unknown) => cause as SystemOneError);
    expect((choice as SystemOneError).code).toBe("INVALID_REQUEST");

    const oneLevel = await evaluateSystemOne({
      state: "x",
      questions: { a: { type: "score", instructions: "?", criteria: ["only"] } },
      connection,
      transport,
    }).catch((cause: unknown) => cause as SystemOneError);
    expect((oneLevel as SystemOneError).code).toBe("INVALID_REQUEST");
    expect(requests).toHaveLength(0);
  });

  test("requires baseUrl and model", async () => {
    const error = await evaluateSystemOne({
      state: "x",
      questions: { a: { type: "noul", instructions: "?" } },
      connection: { ...connection, baseUrl: "  " },
      transport: recordingTransport([jsonResponse(200, { answers: {} })]).transport,
    }).catch((cause: unknown) => cause as SystemOneError);
    expect((error as SystemOneError).code).toBe("INVALID_REQUEST");
  });
});
