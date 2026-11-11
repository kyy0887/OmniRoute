/**
 * Clocked decisions registry — pure backend resolution.
 *
 * Maps a client model id to the Clocked endpoint that serves it, mirroring
 * systemOneRegistry.ts. No I/O; the route and the proxy handler both live on
 * top of this.
 *
 *   clocked/clocked-1.0          → https://clocked.rezolve.ai  (model clocked-1.0)
 *   clocked-1.0 / clocked-1      → bare aliases route natively
 *   clocked/extract (or any of the ten endpoint names as the model suffix)
 *                                → that Clocked endpoint
 *
 * Anything else is not a Clocked decisions model → null (the route 400s with
 * guidance).
 */

import {
  CLOCKED_BASE_URL,
  CLOCKED_DEFAULT_MODEL,
  CLOCKED_ENDPOINT_PATHS,
  CLOCKED_MODEL_ALIAS,
  CLOCKED_PROVIDER_ID,
  type ClockedEndpointName,
} from "../services/clocked/client.ts";

export { CLOCKED_PROVIDER_ID };
export const CLOCKED_DECISIONS_URL = `${CLOCKED_BASE_URL}${CLOCKED_ENDPOINT_PATHS.decide}`;

export interface ClockedTarget {
  /** Model id forwarded upstream. */
  upstreamModel: string;
  /** Absolute URL of the Clocked endpoint to POST. */
  upstreamUrl: string;
  /** Which of the ten Clocked endpoints this targets. */
  endpoint: ClockedEndpointName;
}

const ENDPOINT_NAMES = new Set(Object.keys(CLOCKED_ENDPOINT_PATHS));

/**
 * Resolve the request model to a Clocked endpoint. Pure — unit-tested directly.
 *
 * Accepted shapes:
 *  - bare `clocked-1.0` / `clocked-1` → the /clocked/decide endpoint
 *  - `clocked/decide` … `clocked/pipeline` → the named endpoint
 *  - `clocked/<endpoint>/<model>` → named endpoint with explicit model
 */
export function resolveClockedTarget(model: string | undefined): ClockedTarget | null {
  const trimmed = (model ?? "").trim();
  if (!trimmed) return null;

  if (trimmed === CLOCKED_DEFAULT_MODEL || trimmed === CLOCKED_MODEL_ALIAS) {
    return {
      upstreamModel: CLOCKED_DEFAULT_MODEL,
      upstreamUrl: CLOCKED_DECISIONS_URL,
      endpoint: "decide",
    };
  }

  if (trimmed.startsWith(`${CLOCKED_PROVIDER_ID}/`)) {
    const rest = trimmed.slice(CLOCKED_PROVIDER_ID.length + 1);
    const [first, second] = rest.split("/");
    if (first && ENDPOINT_NAMES.has(first)) {
      const endpoint = first as ClockedEndpointName;
      const upstreamModel =
        second && second.length > 0 ? second : CLOCKED_DEFAULT_MODEL;
      return {
        upstreamModel,
        upstreamUrl: `${CLOCKED_BASE_URL}${CLOCKED_ENDPOINT_PATHS[endpoint]}`,
        endpoint,
      };
    }
    // clocked/<model> where <model> is not an endpoint name — treat the whole
    // rest as a model id against the decide endpoint.
    return {
      upstreamModel: rest || CLOCKED_DEFAULT_MODEL,
      upstreamUrl: CLOCKED_DECISIONS_URL,
      endpoint: "decide",
    };
  }

  return null;
}

/** All model ids advertised for Clocked in catalogs and the GET handler. */
export const CLOCKED_ADVERTISED_MODELS: readonly string[] = [
  ...Object.keys(CLOCKED_ENDPOINT_PATHS).map(
    (endpoint) => `${CLOCKED_PROVIDER_ID}/${endpoint}`
  ),
  `${CLOCKED_PROVIDER_ID}/${CLOCKED_DEFAULT_MODEL}`,
  CLOCKED_DEFAULT_MODEL,
  CLOCKED_MODEL_ALIAS,
];
