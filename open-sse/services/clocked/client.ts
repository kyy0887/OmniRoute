/**
 * Clocked client — typed decisions & exact extraction against clocked.rezolve.ai.
 *
 * Used by the clocked combo strategy and the /v1/clocked decisions passthrough.
 * Not a chat executor: Clocked answers noul / choice / multiselect / score
 * questions and returns verbatim extractions with source positions.
 *
 * Docs: https://clocked.rezolve.ai/docs
 */

import { sanitizeErrorMessage } from "../../utils/error.ts";

export const CLOCKED_PROVIDER_ID = "clocked";
export const CLOCKED_BASE_URL = "https://clocked.rezolve.ai";
export const CLOCKED_PATH_PREFIX = "/clocked";
export const CLOCKED_DEFAULT_MODEL = "clocked-1.0";
export const CLOCKED_MODEL_ALIAS = "clocked-1";

/** Published plan concurrency (docs/limits): Trial 1, Build 4, Production 8, Scale 16. */
export const CLOCKED_TRIAL_CONCURRENCY = 1;

/** Hard ceiling so a hung Clocked call cannot stall combo dispatch. */
export const CLOCKED_TIMEOUT_MS = 15_000;
/** Clocked choice questions accept at most 255 options. */
export const CLOCKED_MAX_CHOICE_OPTIONS = 255;
/** Cap on `state` so a long transcript cannot be forwarded wholesale. */
export const CLOCKED_MAX_STATE_CHARS = 8_000;
/** Clocked requires a UUID Idempotency-Key header on every request. */
export const CLOCKED_IDEMPOTENCY_HEADER = "Idempotency-Key";
/** Clocked billing headers (25 ms model time = 1 credit, min 1 per request). */
export const CLOCKED_CREDITS_HEADER = "x-clocked-credits";
export const CLOCKED_COST_HEADER = "x-clocked-cost-usd";

export const CLOCKED_ENDPOINT_PATHS = {
  decide: "/clocked/decide",
  extract: "/clocked/extract",
  fill: "/clocked/fill",
  pii: "/clocked/pii",
  injection: "/clocked/injection",
  script: "/clocked/script",
  grounding: "/clocked/grounding",
  compare: "/clocked/compare",
  rerank: "/clocked/rerank",
  pipeline: "/clocked/pipeline",
} as const;

export type ClockedEndpointName = keyof typeof CLOCKED_ENDPOINT_PATHS;

/** Model ids accepted in the `model` field of /v1/clocked requests. */
export const CLOCKED_MODELS: readonly string[] = [
  CLOCKED_DEFAULT_MODEL,
  CLOCKED_MODEL_ALIAS,
];

type FetchLike = typeof fetch;

export type ClockedChoiceCriteria = Readonly<Record<string, string | null>>;

export type ClockedChoiceSuccess = {
  ok: true;
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
};

export type ClockedUnavailableReason =
  | "missing_api_key"
  | "empty_criteria"
  | "timeout"
  | "http_error"
  | "invalid_response"
  | "network_error";

export type ClockedChoiceUnavailable = {
  ok: false;
  reason: ClockedUnavailableReason;
  status: number | null;
  /** Sanitized, safe to log or put in a decision-trace detail field. */
  detail: string;
};

export type ClockedChoiceResult = ClockedChoiceSuccess | ClockedChoiceUnavailable;

export type EvaluateClockedChoiceOptions = {
  apiKey: string | null | undefined;
  state: string;
  criteria: ClockedChoiceCriteria;
  /** Defaults to a routing-oriented instruction. */
  instructions?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  baseUrl?: string;
  /** Aborted when the caller cancels; combined with the timeout. */
  signal?: AbortSignal | null;
};

const DEFAULT_INSTRUCTIONS =
  "Which of these configured models is the most appropriate for this request?";

function unavailable(
  reason: ClockedUnavailableReason,
  detail: string,
  status: number | null = null
): ClockedChoiceUnavailable {
  return {
    ok: false,
    reason,
    status,
    detail: sanitizeErrorMessage(detail) || reason,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toFiniteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function parseProbabilities(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    const n = toFiniteNumber(raw);
    if (n === null || n < 0) return null;
    out[key] = n;
  }
  return out;
}

/**
 * Parse a Clocked decide response body into a choice result. Pure — no I/O.
 * Exported for unit tests.
 */
export function parseClockedChoiceResponse(body: unknown): ClockedChoiceResult {
  if (!isRecord(body)) {
    return unavailable("invalid_response", "Clocked response was not a JSON object");
  }

  const answers = body.answers;
  if (!isRecord(answers)) {
    return unavailable("invalid_response", "Clocked response missing answers");
  }

  const route = answers.route;
  if (!isRecord(route)) {
    return unavailable("invalid_response", "Clocked response missing answers.route");
  }

  if (route.type !== "choice") {
    return unavailable(
      "invalid_response",
      `Clocked answers.route.type was ${String(route.type)}, expected choice`
    );
  }

  const choice = typeof route.choice === "string" ? route.choice.trim() : "";
  if (!choice) {
    return unavailable("invalid_response", "Clocked choice answer had an empty choice");
  }

  const probabilities = parseProbabilities(route.probabilities);
  if (!probabilities) {
    return unavailable("invalid_response", "Clocked choice answer missing probabilities");
  }

  const confidence = toFiniteNumber(route.confidence);
  if (confidence === null || confidence < 0 || confidence > 1) {
    return unavailable("invalid_response", "Clocked choice answer missing confidence");
  }

  const usage = isRecord(body.usage) ? body.usage : null;
  return {
    ok: true,
    choice,
    probabilities,
    confidence,
    model: typeof body.model === "string" ? body.model : null,
    inputTokens: usage ? toFiniteNumber(usage.input_tokens) : null,
    outputTokens: usage ? toFiniteNumber(usage.output_tokens) : null,
  };
}

/**
 * Build the headers Clocked requires. The Idempotency-Key must be a fresh UUID
 * for each new logical request; retries of the same logical request reuse it.
 */
export function buildClockedHeaders(apiKey: string, idempotencyKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    [CLOCKED_IDEMPOTENCY_HEADER]: idempotencyKey,
  };
}

/** True when the value is shaped like a UUID v4 (Clocked rejects other shapes). */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Ask Clocked (decide) to pick one option from `criteria`.
 *
 * Never throws. Missing key, timeout, HTTP errors, and malformed bodies all
 * return `{ ok: false, reason, ... }` so combo dispatch can fall open.
 */
export async function evaluateClockedChoice(
  options: EvaluateClockedChoiceOptions
): Promise<ClockedChoiceResult> {
  const apiKey = typeof options.apiKey === "string" ? options.apiKey.trim() : "";
  if (!apiKey) {
    return unavailable("missing_api_key", "No Clocked API key configured");
  }

  const criteriaEntries = Object.entries(options.criteria || {}).filter(
    ([key]) => typeof key === "string" && key.trim().length > 0
  );
  if (criteriaEntries.length === 0) {
    return unavailable("empty_criteria", "Clocked choice requires at least one criterion");
  }
  if (criteriaEntries.length > CLOCKED_MAX_CHOICE_OPTIONS) {
    return unavailable(
      "invalid_response",
      `Clocked choice accepts at most ${CLOCKED_MAX_CHOICE_OPTIONS} options`
    );
  }

  const criteria: Record<string, string | null> = {};
  for (const [key, value] of criteriaEntries) {
    criteria[key.trim()] =
      typeof value === "string"
        ? value
        : value === null || value === undefined
          ? null
          : String(value);
  }

  const rawState = typeof options.state === "string" ? options.state : "";
  const state =
    rawState.length > CLOCKED_MAX_STATE_CHARS
      ? rawState.slice(0, CLOCKED_MAX_STATE_CHARS)
      : rawState;
  const instructions =
    typeof options.instructions === "string" && options.instructions.trim().length > 0
      ? options.instructions.trim()
      : DEFAULT_INSTRUCTIONS;
  const model =
    typeof options.model === "string" && options.model.trim().length > 0
      ? options.model.trim()
      : CLOCKED_DEFAULT_MODEL;
  const timeoutMs =
    typeof options.timeoutMs === "number" &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs > 0
      ? options.timeoutMs
      : CLOCKED_TIMEOUT_MS;
  const baseUrl = (options.baseUrl || CLOCKED_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  if (options.signal?.aborted) {
    return unavailable("timeout", "Clocked call aborted before it started");
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`${baseUrl}${CLOCKED_ENDPOINT_PATHS.decide}`, {
      method: "POST",
      headers: buildClockedHeaders(apiKey, crypto.randomUUID()),
      body: JSON.stringify({
        model,
        state,
        questions: {
          route: {
            type: "choice",
            instructions,
            criteria,
          },
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Status only. Upstream bodies can echo the state or the key.
      return unavailable(
        "http_error",
        `Clocked returned HTTP ${response.status}`,
        response.status
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (err) {
      const message = err instanceof Error ? err.message : "invalid JSON";
      return unavailable("invalid_response", `Clocked response was not JSON: ${message}`);
    }

    return parseClockedChoiceResponse(json);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return unavailable("timeout", `Clocked timed out after ${timeoutMs}ms`);
    }
    return unavailable("network_error", "Clocked request failed");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
