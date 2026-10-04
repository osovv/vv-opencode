// FILE: src/lib/systemone.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Provide a provider-neutral client for the de-facto System One decision protocol (POST /v1/systemone) returning typed noul, choice, and score answers over an injectable transport.
//   SCOPE: Request shaping (state, model, typed questions), typed answer decoding with unknown-field tolerance, a bounded timeout and retry policy, and credential-safe typed errors; no vendor-specific behavior, no default endpoint, no text generation.
//   DEPENDS: [none]
//   LINKS: [M-SYSTEMONE-PROVIDER, M-PLUGIN-GUARDIAN, M-ENV-SUBSTITUTION]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SYSTEMONE_PATH - Canonical System One evaluate path appended to a configured base URL.
//   MAX_CHOICE_OPTIONS - Protocol option ceiling for a choice question.
//   SystemOneJson - JSON value accepted as state, criteria, or instructions.
//   SystemOneNoulQuestion - Yes/no question shape.
//   SystemOneChoiceQuestion - Single-choice question shape.
//   SystemOneScoreQuestion - Ordered-rubric question shape.
//   SystemOneQuestion - Union of the three supported question shapes.
//   SystemOneNoulAnswer - Decoded noul answer.
//   SystemOneChoiceAnswer - Decoded choice answer.
//   SystemOneScoreAnswer - Decoded score answer.
//   SystemOneAnswer - Union of decoded answer shapes.
//   SystemOneConnection - Resolved connection settings for one provider.
//   SystemOneHttpRequest - Transport request shape.
//   SystemOneHttpResponse - Transport response shape.
//   SystemOneTransport - Injectable HTTP transport.
//   defaultSystemOneTransport - Fetch-based transport with an abort timeout.
//   SystemOneErrorCode - Stable client error codes.
//   SystemOneError - Typed, credential-safe client error.
//   SystemOneEvaluateInput - Input to evaluateSystemOne.
//   SystemOneEvaluation - Decoded evaluation result.
//   evaluateSystemOne - Shape, send, retry, and decode one System One evaluate call.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-SYSTEMONE-DECISION-BACKEND T-001 - Added the provider-neutral /v1/systemone client with typed noul/choice/score decoding, bounded timeout and retry, unknown-field tolerance, and credential-safe errors.]
// END_CHANGE_SUMMARY

export const SYSTEMONE_PATH = "/v1/systemone";
export const MAX_CHOICE_OPTIONS = 255;

/** JSON value accepted as state, criteria, or instructions. */
export type SystemOneJson =
  | string
  | number
  | boolean
  | null
  | SystemOneJson[]
  | { [key: string]: SystemOneJson };

export type SystemOneNoulQuestion = {
  type: "noul";
  instructions: SystemOneJson;
  criteria?: { true?: SystemOneJson; false?: SystemOneJson };
};

export type SystemOneChoiceQuestion = {
  type: "choice";
  instructions: SystemOneJson;
  criteria: Record<string, SystemOneJson>;
};

export type SystemOneScoreQuestion = {
  type: "score";
  instructions: SystemOneJson;
  criteria: SystemOneJson[];
};

export type SystemOneQuestion =
  | SystemOneNoulQuestion
  | SystemOneChoiceQuestion
  | SystemOneScoreQuestion;

export type SystemOneNoulAnswer = {
  type: "noul";
  noul: number;
  confidence?: number;
};

export type SystemOneChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence?: number;
};

export type SystemOneScoreAnswer = {
  type: "score";
  score: number;
  probabilities: Record<string, number>;
  legend?: Record<string, string>;
  confidence?: number;
};

export type SystemOneAnswer = SystemOneNoulAnswer | SystemOneChoiceAnswer | SystemOneScoreAnswer;

/** Resolved connection settings for one System One provider. */
export type SystemOneConnection = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
  maxRetries: number;
};

export type SystemOneHttpRequest = {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
};

export type SystemOneHttpResponse = {
  status: number;
  body: string;
};

export type SystemOneTransport = (request: SystemOneHttpRequest) => Promise<SystemOneHttpResponse>;

export type SystemOneErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_RESPONSE"
  | "UNAUTHORIZED"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "REQUEST_FAILED";

/** Typed, credential-safe client error. Never carries the API key, state, or raw body. */
export class SystemOneError extends Error {
  readonly code: SystemOneErrorCode;
  readonly status?: number;

  constructor(code: SystemOneErrorCode, message: string, status?: number) {
    super(message);
    this.name = "SystemOneError";
    this.code = code;
    if (status !== undefined) {
      this.status = status;
    }
  }
}

// START_BLOCK_TRANSPORT
/** Fetch-based transport with an abort timeout. Errors are normalized by the caller. */
export const defaultSystemOneTransport: SystemOneTransport = async (request) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    });
    const body = await response.text();
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
};
// END_BLOCK_TRANSPORT

// START_BLOCK_SHAPING
function joinUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${SYSTEMONE_PATH}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validateQuestion(id: string, question: SystemOneQuestion): void {
  if (question.type === "choice") {
    const count = Object.keys(question.criteria ?? {}).length;
    if (count < 1 || count > MAX_CHOICE_OPTIONS) {
      throw new SystemOneError(
        "INVALID_REQUEST",
        `question ${id}: choice criteria must contain between 1 and ${MAX_CHOICE_OPTIONS} options`,
      );
    }
  }
  if (question.type === "score") {
    const count = question.criteria?.length ?? 0;
    if (count < 2) {
      throw new SystemOneError(
        "INVALID_REQUEST",
        `question ${id}: score criteria must contain at least 2 levels`,
      );
    }
  }
}
// END_BLOCK_SHAPING

// START_BLOCK_DECODING
function decodeNoul(id: string, value: Record<string, unknown>): SystemOneNoulAnswer {
  if (!isFiniteUnit(value.noul)) {
    throw new SystemOneError("INVALID_RESPONSE", `answer ${id}: noul must be a probability`);
  }
  return {
    type: "noul",
    noul: value.noul,
    ...(isFiniteUnit(value.confidence) ? { confidence: value.confidence } : {}),
  };
}

function decodeProbabilities(id: string, value: unknown): Record<string, number> {
  if (!isPlainRecord(value)) {
    throw new SystemOneError("INVALID_RESPONSE", `answer ${id}: probabilities must be an object`);
  }
  const decoded: Record<string, number> = {};
  for (const [key, probability] of Object.entries(value)) {
    if (!isFiniteUnit(probability)) {
      throw new SystemOneError(
        "INVALID_RESPONSE",
        `answer ${id}: probability ${key} must be between 0 and 1`,
      );
    }
    decoded[key] = probability;
  }
  return decoded;
}

function decodeChoice(id: string, value: Record<string, unknown>): SystemOneChoiceAnswer {
  const probabilities = decodeProbabilities(id, value.probabilities);
  if (typeof value.choice !== "string" || !Object.hasOwn(probabilities, value.choice)) {
    throw new SystemOneError(
      "INVALID_RESPONSE",
      `answer ${id}: choice must match a probability key`,
    );
  }
  return {
    type: "choice",
    choice: value.choice,
    probabilities,
    ...(isFiniteUnit(value.confidence) ? { confidence: value.confidence } : {}),
  };
}

function decodeScore(id: string, value: Record<string, unknown>): SystemOneScoreAnswer {
  const probabilities = decodeProbabilities(id, value.probabilities);
  if (typeof value.score !== "number" || !Number.isFinite(value.score) || value.score < 0) {
    throw new SystemOneError("INVALID_RESPONSE", `answer ${id}: score must be a finite number`);
  }
  const legend = isPlainRecord(value.legend)
    ? Object.fromEntries(
        Object.entries(value.legend).filter((entry): entry is [string, string] => {
          return typeof entry[1] === "string";
        }),
      )
    : undefined;
  return {
    type: "score",
    score: value.score,
    probabilities,
    ...(legend ? { legend } : {}),
    ...(isFiniteUnit(value.confidence) ? { confidence: value.confidence } : {}),
  };
}

function decodeAnswer(id: string, value: unknown): SystemOneAnswer {
  if (!isPlainRecord(value)) {
    throw new SystemOneError("INVALID_RESPONSE", `answer ${id}: expected an object`);
  }
  switch (value.type) {
    case "noul":
      return decodeNoul(id, value);
    case "choice":
      return decodeChoice(id, value);
    case "score":
      return decodeScore(id, value);
    default:
      throw new SystemOneError("INVALID_RESPONSE", `answer ${id}: unknown answer type`);
  }
}
// END_BLOCK_DECODING

// START_BLOCK_REQUEST
function buildRequest(
  connection: SystemOneConnection,
  state: SystemOneJson,
  questions: Record<string, SystemOneQuestion>,
): SystemOneHttpRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (connection.apiKey !== undefined && connection.apiKey !== "") {
    headers.authorization = `Bearer ${connection.apiKey}`;
  }
  return {
    url: joinUrl(connection.baseUrl),
    method: "POST",
    headers,
    body: JSON.stringify({ state, model: connection.model, questions }),
    timeoutMs: connection.timeoutMs,
  };
}

function normalizeConnection(connection: SystemOneConnection): SystemOneConnection {
  if (!connection.baseUrl.trim() || !connection.model.trim()) {
    throw new SystemOneError("INVALID_REQUEST", "baseUrl and model are required");
  }
  return {
    ...connection,
    baseUrl: connection.baseUrl.trim(),
    model: connection.model.trim(),
    timeoutMs: Math.max(1, Math.floor(connection.timeoutMs)),
    maxRetries: Math.min(5, Math.max(0, Math.floor(connection.maxRetries))),
  };
}

function statusError(status: number, retryable: boolean): SystemOneError {
  if (status === 401 || status === 403) {
    return new SystemOneError("UNAUTHORIZED", "System One credential was rejected", status);
  }
  if (status === 429) {
    return new SystemOneError("RATE_LIMITED", "System One rate limit reached", status);
  }
  return new SystemOneError(
    "REQUEST_FAILED",
    `System One request failed with status ${status}${retryable ? " (retried)" : ""}`,
    status,
  );
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
// END_BLOCK_REQUEST

// START_CONTRACT: evaluateSystemOne
//   PURPOSE: Send one System One evaluate request and return decoded typed answers.
//   INPUTS: { input: SystemOneEvaluateInput - state, questions, resolved connection, optional transport }
//   OUTPUTS: { Promise<SystemOneEvaluation> - echoed model id and typed answers keyed by question id }
//   SIDE_EFFECTS: Performs one outbound HTTP call per attempt; no state is logged.
//   LINKS: [M-SYSTEMONE-PROVIDER]
// END_CONTRACT: evaluateSystemOne
// START_BLOCK_EVALUATE
export type SystemOneEvaluateInput = {
  state: SystemOneJson;
  questions: Record<string, SystemOneQuestion>;
  connection: SystemOneConnection;
  transport?: SystemOneTransport;
};

export type SystemOneEvaluation = {
  model: string;
  answers: Record<string, SystemOneAnswer>;
};

export async function evaluateSystemOne(
  input: SystemOneEvaluateInput,
): Promise<SystemOneEvaluation> {
  const connection = normalizeConnection(input.connection);
  const questionIds = Object.keys(input.questions);
  if (questionIds.length === 0) {
    throw new SystemOneError("INVALID_REQUEST", "at least one question is required");
  }
  for (const [id, question] of Object.entries(input.questions)) {
    validateQuestion(id, question);
  }

  const transport = input.transport ?? defaultSystemOneTransport;
  const request = buildRequest(connection, input.state, input.questions);
  const attempts = connection.maxRetries + 1;
  let lastError: SystemOneError | undefined;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      await delay(Math.min(100 * 2 ** (attempt - 1), 1000));
    }
    let response: SystemOneHttpResponse;
    try {
      response = await transport(request);
    } catch (error) {
      lastError = new SystemOneError(
        error instanceof Error && error.name === "AbortError" ? "TIMEOUT" : "REQUEST_FAILED",
        "System One request did not complete",
      );
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      const error = statusError(response.status, attempt + 1 < attempts);
      if (!isRetryableStatus(response.status)) {
        throw error;
      }
      lastError = error;
      continue;
    }
    return decodeEvaluation(response.body);
  }

  throw lastError ?? new SystemOneError("REQUEST_FAILED", "System One request failed");
}
// END_BLOCK_EVALUATE

function decodeEvaluation(body: string): SystemOneEvaluation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new SystemOneError("INVALID_RESPONSE", "System One response was not valid JSON");
  }
  if (!isPlainRecord(parsed) || !isPlainRecord(parsed.answers)) {
    throw new SystemOneError("INVALID_RESPONSE", "System One response is missing answers");
  }
  const answers: Record<string, SystemOneAnswer> = {};
  for (const [id, answer] of Object.entries(parsed.answers)) {
    answers[id] = decodeAnswer(id, answer);
  }
  const model = typeof parsed.model === "string" && parsed.model !== "" ? parsed.model : "";
  return { model, answers };
}
