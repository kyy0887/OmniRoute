/**
 * POST /v1/clocked — Clocked typed decisions & extraction.
 *
 * Body: `{ model?, ...endpoint fields }` where model selects the Clocked
 * endpoint: `clocked-1.0` / `clocked-1` (decide) or `clocked/<endpoint>` for
 * one of the ten published endpoints (decide, extract, fill, pii, injection,
 * script, grounding, compare, rerank, pipeline). Response passthrough with
 * Clocked billing headers (X-Clocked-Credits). GET lists decisions-capable
 * models.
 *
 * Not a chat endpoint — Clocked models never join chat pickers or combos.
 */

import { createClockedRouteHandlers } from "@/app/api/v1/_shared/clockedRoute";

const handlers = createClockedRouteHandlers("/v1/clocked");

export const dynamic = "force-dynamic";

export const OPTIONS = handlers.OPTIONS;
export const GET = handlers.GET;
export const POST = handlers.POST;
