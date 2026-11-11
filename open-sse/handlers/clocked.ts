/**
 * Clocked decisions proxy.
 *
 * POST /v1/clocked forwards one typed-decision/extraction request — a `state`
 * (or `documents`) plus endpoint-specific fields — to the Clocked endpoint
 * selected by resolveClockedTarget. The response (typed answers, extractions,
 * usage) flows through untouched; Clocked billing headers
 * (X-Clocked-Credits / X-Clocked-Cost-Usd) are copied onto the response so
 * clients can meter usage.
 *
 * Clocked requires a UUID Idempotency-Key on every request; one is generated
 * per proxy attempt here (the caller's own Idempotency-Key is forwarded when
 * present so logical-request identity survives client retries).
 *
 * Follows the same credential, rate-limit and call-log contract as
 * handlers/systemOne.ts (POST /v1/systemone).
 */

import { CORS_HEADERS } from "../utils/cors.ts";
import { errorResponse } from "../utils/error.ts";
import { attachOmniRouteMetaHeaders } from "@/domain/omnirouteResponseMeta";
import { generateRequestId } from "@/shared/utils/requestId";
import { saveCallLog } from "@/lib/usageDb";
import type { ClockedTarget } from "../config/clockedRegistry.ts";
import {
  CLOCKED_IDEMPOTENCY_HEADER,
  isUuid,
} from "../services/clocked/client.ts";

export interface ClockedCredentials {
  apiKey?: string | null;
  accessToken?: string | null;
  connectionId?: string | null;
}

export interface ClockedProxyOptions {
  /** Public path the client called ("/v1/clocked"). */
  path: string;
  target: ClockedTarget;
  body: Record<string, unknown>;
  credentials: ClockedCredentials | null;
  /** Client-requested model id (for logs when upstream reports none). */
  requestedModel?: string | null;
  /** Client-supplied idempotency key, forwarded when it is a valid UUID. */
  idempotencyKey?: string | null;
  fetchImpl?: typeof fetch;
}

interface ClockedUpstreamResponse {
  model?: string;
  answers?: unknown;
  result?: unknown;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  error?: { message?: string } | string;
  message?: string;
}

function parseUpstreamBody(text: string): ClockedUpstreamResponse | null {
  try {
    return text ? (JSON.parse(text) as ClockedUpstreamResponse) : null;
  } catch {
    return { error: text.slice(0, 500) };
  }
}

function upstreamErrorMessage(parsed: ClockedUpstreamResponse | null): string | undefined {
  const { message, error } = parsed ?? {};
  return message || (typeof error === "string" ? error : error?.message);
}

function buildSuccessResponse(
  parsed: ClockedUpstreamResponse | null,
  meta: {
    provider: string;
    model: string;
    cost: unknown;
    startTime: number;
    credits: string | null;
  }
): Response {
  const headers = new Headers({ ...CORS_HEADERS, "Content-Type": "application/json" });
  attachOmniRouteMetaHeaders(headers, {
    provider: meta.provider,
    model: meta.model,
    costUsd: typeof meta.cost === "number" ? meta.cost : 0,
    latencyMs: Date.now() - meta.startTime,
    requestId: generateRequestId(),
  });
  if (meta.credits) {
    headers.set("X-Clocked-Credits", meta.credits);
  }
  return new Response(JSON.stringify(parsed), { status: 200, headers });
}

function postClocked(options: ClockedProxyOptions, token: string): Promise<Response> {
  const fetchImpl: typeof fetch = options.fetchImpl ?? fetch;
  const clientKey = options.idempotencyKey;
  const idempotencyKey =
    typeof clientKey === "string" && isUuid(clientKey) ? clientKey : crypto.randomUUID();
  const { idempotencyKey: _client, ...body } = options.body;
  return fetchImpl(options.target.upstreamUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      [CLOCKED_IDEMPOTENCY_HEADER]: idempotencyKey,
    },
    body: JSON.stringify({
      ...body,
      model: options.target.upstreamModel,
    }),
  });
}

function logClockedCall(
  options: ClockedProxyOptions,
  outcome: {
    status: number;
    ok: boolean;
    model: string;
    usage: ClockedUpstreamResponse["usage"];
    error: string;
    startTime: number;
  }
): void {
  saveCallLog({
    method: "POST",
    path: options.path,
    status: outcome.status,
    model: outcome.model,
    provider: "clocked",
    duration: Date.now() - outcome.startTime,
    tokens: {
      prompt_tokens: outcome.usage?.input_tokens ?? 0,
      completion_tokens: outcome.usage?.output_tokens ?? 0,
    },
    connectionId: options.credentials?.connectionId || null,
    ...(outcome.ok ? {} : { error: outcome.error }),
  }).catch(() => {});
}

function resolveAnsweredModel(
  parsed: ClockedUpstreamResponse | null,
  options: ClockedProxyOptions
): string {
  const upstreamModel = typeof parsed?.model === "string" ? parsed.model : "";
  return upstreamModel || options.requestedModel || "clocked";
}

export async function handleClockedProxy(options: ClockedProxyOptions): Promise<Response> {
  const startTime = Date.now();
  const provider = "clocked";
  const token = options.credentials?.apiKey || options.credentials?.accessToken;

  if (!token) {
    return errorResponse(401, `No active credentials for provider: ${provider}`);
  }

  try {
    const res = await postClocked(options, token);
    const text = await res.text();
    const parsed = parseUpstreamBody(text);
    const usage = res.ok ? parsed?.usage : undefined;
    const answeredModel = resolveAnsweredModel(parsed, options);
    const upstreamError = upstreamErrorMessage(parsed);
    const credits = res.headers.get("x-clocked-credits");

    logClockedCall(options, {
      status: res.status,
      ok: res.ok,
      model: answeredModel,
      usage,
      error: upstreamError || text.slice(0, 500),
      startTime,
    });

    if (!res.ok) {
      return errorResponse(res.status, upstreamError || `Provider returned HTTP ${res.status}`);
    }

    return buildSuccessResponse(parsed, {
      provider,
      model: answeredModel,
      cost: usage && typeof (usage as Record<string, unknown>).cost === "number"
        ? (usage as Record<string, unknown>).cost
        : 0,
      startTime,
      credits,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(500, `Clocked request failed: ${message}`);
  }
}
