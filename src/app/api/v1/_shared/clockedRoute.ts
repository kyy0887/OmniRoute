/**
 * POST/GET handler for /v1/clocked. Credential selection, rate-limit handling
 * and usage logging mirror /v1/systemone (systemOneRoute.ts) — the Clocked
 * provider is a decisions-only provider (#13987 family) with its own endpoint
 * family and Idempotency-Key requirement.
 */

import {
  handleClockedProxy,
  type ClockedCredentials,
} from "@omniroute/open-sse/handlers/clocked.ts";
import { resolveClockedTarget } from "@omniroute/open-sse/config/clockedRegistry.ts";
import {
  getProviderCredentialsWithQuotaPreflight,
  clearRecoveredProviderState,
} from "@/sse/services/auth";
import { withInjectionGuard } from "@/middleware/promptInjectionGuard";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import {
  isKeyScopeBlockedCredentials,
  keyScopeBlockedResponse,
  resolveKeyConnectionScope,
} from "@/sse/services/keyConnectionScope";
import { v1ClockedSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import {
  isAllRateLimitedCredentials,
  rateLimitedProviderResponse,
} from "@/app/api/v1/_shared/rateLimit";
import { getSpecialtyModelsResponse } from "@/app/api/v1/_shared/specialtyCatalog";
import { CLOCKED_ADVERTISED_MODELS } from "@omniroute/open-sse/config/clockedRegistry.ts";

function optionsResponse() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/** Clocked models advertised by the unified catalog (type "decisions"). */
export function clockedModelsGet(pathname: string) {
  return (request?: Request) =>
    getSpecialtyModelsResponse(request, pathname, (model) => {
      if (model.type === "decisions") return true;
      const endpoints = model.supported_endpoints;
      return Array.isArray(endpoints) && endpoints.includes("decisions");
    });
}

async function postHandler(request: Request): Promise<Response> {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const validation = validateBody(v1ClockedSchema, rawBody);
  if (isValidationFailure(validation)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, validation.error.message);
  }
  const body = validation.data as Record<string, unknown>;
  const model = typeof body.model === "string" ? body.model.trim() : undefined;

  const target = resolveClockedTarget(model);
  if (!target) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Unknown Clocked model: ${model ?? "(missing)"}. Use "clocked-1.0" (or "clocked-1"), ` +
        `or "clocked/<endpoint>" where <endpoint> is one of: ` +
        `decide, extract, fill, pii, injection, script, grounding, compare, rerank, pipeline.`
    );
  }

  const policy = await enforceApiKeyPolicy(request, model ?? target.upstreamModel);
  if (policy.rejection) return policy.rejection;

  // GHSA-3w2r: credential selection stays inside the key's connection scope,
  // the same scope chat and /v1/systemone apply.
  const scope = await resolveKeyConnectionScope(policy.apiKeyInfo);
  if (scope.rejection) return scope.rejection;

  const credentials = await getProviderCredentialsWithQuotaPreflight(
    "clocked",
    null,
    scope.allowedConnections
  );
  if (!credentials) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `No active credentials for provider: clocked`
    );
  }
  if (isKeyScopeBlockedCredentials(credentials)) {
    return keyScopeBlockedResponse("clocked", credentials);
  }
  if (isAllRateLimitedCredentials(credentials)) {
    return rateLimitedProviderResponse("clocked", credentials);
  }

  const response = await handleClockedProxy({
    path: new URL(request.url).pathname,
    target,
    body,
    // The key-scope-blocked and all-rate-limited sentinels were refused above;
    // what is left is a real credential record.
    credentials: credentials as ClockedCredentials,
    requestedModel: model ?? null,
    idempotencyKey:
      typeof request.headers.get("idempotency-key") === "string"
        ? request.headers.get("idempotency-key")
        : null,
  });
  if (response.ok) {
    await clearRecoveredProviderState(credentials);
  }
  return response;
}

export function createClockedRouteHandlers(pathname: string) {
  return {
    OPTIONS: optionsResponse,
    GET: clockedModelsGet(pathname),
    POST: withInjectionGuard(postHandler),
  };
}
