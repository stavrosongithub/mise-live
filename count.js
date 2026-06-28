// ============================================================================
// Mise — count.js (Phase 2 / API-07 / D-22)
// ----------------------------------------------------------------------------
// Anthropic count_tokens wrapper for the pre-Parse cost estimate. Called from
// app.js's estimateTokenCost store action on textarea blur + model-dropdown
// change. Returns { input_tokens, usd } on success or null on ANY error so
// an unreachable endpoint never disrupts the user's flow.
//
// Per-call client construction (NOT a module-level singleton) because the
// apiKey lives in the Alpine store and may rotate via Settings — a cached
// client would silently send the old key. The SDK client is small; the
// per-call construction cost is dwarfed by the network round-trip.
//
// count_tokens vs messages.create (Pitfalls L + M / RESEARCH §B):
//   - count_tokens is FREE (Anthropic confirmed). Calling it on every
//     textarea blur is safe billing-wise.
//   - count_tokens responses have NO stop_reason field. Routing this call
//     through callLLM (which guards on stop_reason) would crash. We call
//     client.messages.countTokens directly, NOT via callLLM.
//   - count_tokens errors are SILENT (return null). They never surface to
//     parseError — the user just sees no estimate where one would appear.
//
// Pricing (PRICE_PER_MTOK_INPUT — current as of 2026-05-22 per RESEARCH §B):
//   - Sonnet 4.5 / 4.6: $3 / MTok input
//   - Haiku  4.5:       $1 / MTok input
// Pricing constants live HERE (single source of truth) — NOT in app.js. The
// formatter (formatCost) lives in app.js because it needs Alpine reactivity
// for the rendered string; the math lives here because the multiplier is a
// constant of the SDK call shape, not a UI concern.
//
// W4 review note: this module returns the AMOUNT in USD; the human-readable
// string (e.g. "≈ $0.06 to parse") is built by app.js's formatCost helper.
// ============================================================================

import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.97.1';

// Pricing per MTok (1,000,000 input tokens). The default fallback for an
// unrecognized model is 3 (Sonnet pricing) — over-estimate is safer than
// under-estimate for a user-facing cost preview.
const PRICE_PER_MTOK_INPUT = {
  'claude-sonnet-4-6': 3,
  'claude-sonnet-4-5': 3,
  'claude-haiku-4-5': 1
};

/**
 * Estimate the input-side cost of the impending Parse call. Calls the
 * Anthropic count_tokens endpoint with the SAME system + messages +
 * output_config shape that the Parse will use, so the count is accurate
 * to within ~4 tokens (the small variability per-call comes from the salt's
 * 12 hex chars — see Pitfall N / T-02-04-10).
 *
 * Returns { input_tokens, usd } on success, or null on ANY error:
 *   - network failure (offline, DNS, CORS misconfig)
 *   - 401 Unauthorized (bad apiKey)
 *   - 429 Too Many Requests
 *   - 400 Bad Request (malformed schema)
 *   - any other thrown exception
 *
 * Silent-fail discipline (Pitfall L; RESEARCH §B "Failure"):
 *   - No console.error. No console.warn. (A future debugging session can
 *     add a temporary log; the silent-fail contract is the steady state.)
 *   - No throw — caller can `await` without try/catch.
 *   - No echo of apiKey or any other secret in any return path (T-02-03).
 *
 * @param {{
 *   apiKey: string,
 *   model: string,
 *   systemPrompt: string,
 *   userMessage: string,
 *   schema: object
 * }} args
 * @returns {Promise<{ input_tokens: number, usd: number } | null>}
 */
export async function estimateParseCost({ apiKey, model, systemPrompt, userMessage, schema }) {
  try {
    // Per-call client construction so an apiKey rotation in Settings takes
    // effect on the next blur without a refresh. dangerouslyAllowBrowser is
    // the official opt-in for direct browser→Anthropic CORS (Aug 2024).
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

    // countTokens shape: same as messages.create except no max_tokens (it's
    // a cost-preview, not a generation call). output_config is included so
    // the schema's tokens contribute to the input_tokens count — Structured
    // Outputs compiles the schema into the prefix.
    const { input_tokens } = await client.messages.countTokens({
      model,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      output_config: {
        format: {
          type: 'json_schema',
          schema
        }
      }
    });

    // (input_tokens / 1M) * dollars-per-MTok → USD. Unknown model falls
    // back to Sonnet pricing — over-estimate beats under-estimate.
    const price = PRICE_PER_MTOK_INPUT[model] ?? 3;
    const usd = (input_tokens / 1_000_000) * price;
    return { input_tokens, usd };
  } catch (_e) {
    // Silent-fail per Pitfall L. Caller assigns null to tokenEstimate; the
    // .token-estimate <small> in the template hides via x-show="tokenEstimate".
    // No console output, no parseError surface — count_tokens being unreachable
    // is not a user-actionable error (Parse itself may still work).
    return null;
  }
}
