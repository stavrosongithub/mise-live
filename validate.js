// ============================================================================
// Mise — Valibot post-validation (Phase 2 / PARSE-03 / D-20)
// ----------------------------------------------------------------------------
// Pure two-stage validator for the LLM's parsed recipe JSON. Called from
// parse() during STATES.VALIDATING (the state slot opened by Plan 02-01).
// Returns side-channel { autoFixes, hardErrors } arrays alongside the
// corrected `value` so the form-pane can render inline notes next to each
// affected field without a second screen (D-20: every fix or warning is
// visible during the existing form review pass).
//
// This module is OFFLINE-PURE:
//   - No Alpine, no DOM, no Anthropic SDK, no PapaParse.
//   - Single external dependency: Valibot, pinned to 1.3.1 per D-04.
//   - No global state, no module-level mutations, no Date.now / Math.random.
//   - Receives the Structured-Outputs-guaranteed JSON; returns a new object.
//
// Two-stage pattern (Pitfall K — Valibot's transform() discards the original
// value, so the auto-fix detection cannot live inside the pipe):
//   Stage 1 (plain JS, in this module): clamp negative quantity_metric (and
//     quantity_volumetric when present) to 0, clamp popularity / difficulty
//     into 1..5. Each correction pushes a side-channel autoFix object so the
//     form can render the gray inline note next to the affected field.
//     (quick 260607-anu removed the range-swap + range-into-quantity clamps —
//     the v2 schema no longer carries the legacy range columns; ranges collapse
//     to the metric midpoint at parse time and raw_text preserves the original.)
//   Stage 2 (v.safeParse, in this module): shape-only checks that hard-reject
//     without auto-fixing — `raw_text` must be non-empty, `header.source`
//     must satisfy v.url(). Hard-rejects do NOT block Approve (D-20); they
//     surface as red inline labels the user can resolve before Approving.
//
// Path-syntax convention (intentional, do NOT collapse):
//   autoFixes  → bracket syntax  `rows[N].field`   (matches Valibot INPUT)
//   hardErrors → dot syntax      `rows.N.field`    (matches Valibot OUTPUT)
// index.html filters against BOTH syntaxes — preserve the distinction.
// ============================================================================

import * as v from 'https://esm.sh/valibot@1.3.1';
import { FLAGGED_FIELD_NAME_ENUM, REASON_CODE_ENUM, REVIEW_FLAG_ENUM, FSA14, UNIT_METRIC_ENUM, UNIT_VOLUMETRIC_ENUM } from './schema.js';

// ----------------------------------------------------------------------------
// Phase 3 / REVIEW-05 — D-35 cap-at-3 enforcement
// ----------------------------------------------------------------------------
// The LLM is also instructed to keep flagged_fields ≤ 3 entries per row
// (see system-prompt.js LOW-CONFIDENCE FLAGGING). This constant is the
// belt-and-braces local cap: any row that arrives with > 3 entries is
// suppressed at the UI level via the `_needsFullReview` runtime marker
// (the form renders a single "Needs full review" pill in place of the
// per-field yellow borders).
//
// Tunable via this single line (UI-SPEC Open Implementation Note 3); change
// site is here, not in the renderer.
const MAX_FLAGGED_FIELDS_PER_ROW = 3;

// ----------------------------------------------------------------------------
// Stage 2 schemas — shape-only / hard-reject rules
// ----------------------------------------------------------------------------
// Per D-20, Stage 2 fills ONLY the gaps Structured Outputs cannot enforce:
// non-empty raw_text and URL-format source. Numeric range constraints belong
// to Stage 1 (plain-JS auto-fix); putting them here would force Valibot to
// reject what we already corrected, defeating the auto-fix UX.
//
// Other row fields use loose nullable types — the Anthropic JSON Schema
// already enforced enums and types at token level; Valibot is gap-fill, not
// duplication. The loose `v.nullable(...)` shapes mean a row that survived
// Structured Outputs sails through Stage 2 unless the hard-reject rules fire.

// 03-REVIEW WR-02 — flagged_fields entry shape. Pull enums from schema.js so
// REVIEW-05's source-of-truth enum lives in exactly one place and a future
// edit to FLAGGED_FIELD_NAME_ENUM / REASON_CODE_ENUM in schema.js propagates
// here automatically (no silent drift).
const FlaggedFieldEntrySchema = v.object({
  field:       v.picklist(FLAGGED_FIELD_NAME_ENUM),
  reason_code: v.picklist(REASON_CODE_ENUM)
});

const RecipeRowSchema = v.object({
  line_order:      v.nullable(v.integer()),
  ingredient_id:   v.nullable(v.integer()),
  ingredient_name: v.nullable(v.string()),
  // quick 260607-anu — four-column quantity contract. unit_metric is the
  // always-populated metric unit; the volumetric pair is nullable (present only
  // when the source amount was non-metric). Enums pulled from schema.js so the
  // source of truth stays single.
  quantity_metric: v.number(),
  unit_metric:     v.picklist(UNIT_METRIC_ENUM),
  quantity_volumetric: v.nullable(v.number()),
  unit_volumetric: v.nullable(v.picklist(UNIT_VOLUMETRIC_ENUM)),
  section:         v.nullable(v.string()),
  prep_note:       v.nullable(v.string()),
  role:            v.picklist(['required', 'optional', 'garnish', 'to_taste']),
  // HARD REJECT — empty raw_text means the LLM dropped the verbatim source line.
  // D-20: non-fixable → red inline label, Approve still works.
  raw_text:        v.pipe(v.string(), v.nonEmpty()),
  flag_fix_me:     v.boolean(),
  // 03-REVIEW WR-02 — declare flagged_fields to match the source-of-truth
  // Structured-Outputs schema (schema.js:209). Today's behavior is unchanged
  // (v.object is non-strict and only safeParse().success is consumed) but a
  // future move to v.strictObject or a caller reading safeParse().output
  // would otherwise silently drop every row's flagged_fields → REVIEW-05's
  // per-field marker UI breaks. Field is required (non-nullable); the LLM
  // emits `[]` per system-prompt LOW-CONFIDENCE FLAGGING.
  flagged_fields:  v.array(FlaggedFieldEntrySchema)
});

// quick 260618-ihr (Workstream B) — parse-only review_flags entry shape.
// reason_code pulled from schema.js REVIEW_FLAG_ENUM (single source of truth,
// same pattern as FlaggedFieldEntrySchema). Non-strict pass-through: today
// RecipeHeaderSchema is consumed only via safeParse().success, so this neither
// hard-rejects nor mutates — it keeps the validator honest if a future caller
// reads safeParse().output.
const ReviewFlagEntrySchema = v.object({
  reason_code: v.picklist(REVIEW_FLAG_ENUM),
  note:        v.string()
});

const RecipeHeaderSchema = v.object({
  name:             v.nullable(v.string()),
  main_side_salad:  v.nullable(v.string()),
  prep:             v.nullable(v.string()),
  instructions_20:  v.nullable(v.string()),
  ingredients_20:   v.nullable(v.string()),
  // HARD REJECT — must be either null or a URL-shaped string.
  // D-20: non-fixable → red inline label, Approve still works.
  source:           v.nullable(v.pipe(v.string(), v.url())),
  max_servings:     v.nullable(v.integer()),
  // popularity / difficulty are NOT range-checked here — Stage 1 already
  // clamped them. Re-checking in Stage 2 would surface a stale hardError
  // every time Stage 1 succeeded, defeating the auto-fix UX.
  popularity:       v.nullable(v.integer()),
  difficulty:       v.nullable(v.integer()),
  last_made:        v.nullable(v.string()),
  serve_with:       v.nullable(v.string()),
  popularity_notes: v.nullable(v.string()),
  difficulty_notes: v.nullable(v.string()),
  allergens:        v.array(v.string()),
  // quick 260618-ihr (Workstream B, D2) — non-nullable array, parse-only.
  // Non-strict pass-through (mirrors flagged_fields): must NOT hard-reject.
  review_flags:     v.array(ReviewFlagEntrySchema)
});

const RecipeSchema = v.object({
  header: RecipeHeaderSchema,
  rows:   v.array(RecipeRowSchema)
});

// ----------------------------------------------------------------------------
// mapValibotIssue — Valibot issue → plain-language message (D-20 tone)
// ----------------------------------------------------------------------------
/**
 * Convert one Valibot issue into a plain-language sentence keyed to the
 * affected field. Matches the tone of app.js / mapToPlainLanguage — short
 * English, names the field, no developer jargon.
 *
 * @param {object} issue — one entry from `safeParse().issues`.
 * @returns {string}
 */
function mapValibotIssue(issue) {
  // issue.path is an array of { type, key, ... } segments — flatten to dot.
  const path = (issue && issue.path)
    ? issue.path.map(p => p.key).join('.')
    : '<root>';

  // Row-targeted messages (raw_text non-empty is the dominant case).
  const rowMatch = path.match(/^rows\.(\d+)\.(.+)$/);
  if (rowMatch) {
    const rowNum = parseInt(rowMatch[1], 10) + 1;
    const field  = rowMatch[2];
    if (field === 'raw_text' && issue.type === 'non_empty') {
      return `Row ${rowNum} is missing the recipe text. Add it before approving.`;
    }
  }

  // Header-source URL is the other hard-reject case.
  if (path === 'header.source' && issue.type === 'url') {
    return `The source URL looks wrong: "${issue.input}". Edit it before approving.`;
  }

  // Fallback — never hit on the happy path, but the form-pane filter only
  // matches the eight Valibot-touched fields, so a stray issue lands in the
  // store but never renders. Still: produce a non-jargon string.
  const fallbackMsg = (issue && issue.message)
    ? issue.message
    : 'value did not match expected shape';
  return `Something's wrong with "${path}": ${fallbackMsg}.`;
}

// ----------------------------------------------------------------------------
// validateRecipe — the entry point called from app.js / parse() VALIDATING
// ----------------------------------------------------------------------------
/**
 * Validate the LLM's parsed JSON via the two-stage pattern.
 *
 *   Stage 1 (plain JS): negative quantity_metric/quantity_volumetric clamp,
 *     popularity / difficulty 1..5 clamp. Records side-channel autoFixes.
 *   Stage 2 (v.safeParse): non-empty raw_text + URL-format source. Records
 *     side-channel hardErrors.
 *
 * Returns the corrected value alongside both arrays so the caller can
 * populate the form with the corrected values AND render inline notes.
 *
 * @param {object} parsed — Structured-Outputs-guaranteed JSON (header + rows).
 * @returns {{
 *   value: object,
 *   autoFixes: Array<{ path: string, original: any, corrected: any, message: string }>,
 *   hardErrors: Array<{ path: string, value: any, message: string }>
 * }}
 */
export function validateRecipe(parsed) {
  const autoFixes  = [];
  const hardErrors = [];

  // Deep-clone immediately so the input is never mutated. We use a JSON
  // round-trip (NOT structuredClone) because the Approve path (app.js ~2828)
  // passes LIVE Alpine reactive state, and structuredClone throws
  // DataCloneError on Alpine's Proxy exotic objects (UAT-04-G06 — Approve
  // failed on every attempt). JSON.parse(JSON.stringify(...)) strips the
  // Proxy wrapper and is safe here because the recipe payload is
  // JSON-serializable by construction (header + rows hold only strings,
  // numbers, booleans, null, and arrays — no functions, Dates, or circular
  // refs). The parse-time caller (plain API-response JSON) is unaffected: a
  // JSON round-trip on plain JSON is identity-by-value.
  const corrected = JSON.parse(JSON.stringify(parsed));

  // Defensive shape handling — Structured Outputs guarantees rows + header,
  // but a future caller (e.g. a synthetic-payload test in DevTools) might
  // pass an unexpected shape. Treat missing rows as [] and missing header
  // as a skip-Stage-1-header sentinel.
  if (!Array.isArray(corrected.rows)) {
    corrected.rows = [];
  }
  const headerPresent = corrected.header && typeof corrected.header === 'object';

  // --------------------------------------------------------------------------
  // Stage 1 — plain-JS clamps + side-channel autoFixes
  // --------------------------------------------------------------------------

  // (a) Per-row negative-quantity clamp — retargeted to the four-column
  // contract (quick 260607-anu). quantity_metric is always present; clamp it
  // when negative. quantity_volumetric is nullable; clamp only when it is a
  // negative number. The legacy range-swap + range-into-quantity clamps are
  // GONE (no range columns in the v2 schema).
  for (let i = 0; i < corrected.rows.length; i++) {
    const r = corrected.rows[i];
    if (typeof r.quantity_metric === 'number' && r.quantity_metric < 0) {
      autoFixes.push({
        path: 'rows[' + i + '].quantity_metric',
        original: r.quantity_metric,
        corrected: 0,
        message: 'Metric amount was negative (' + r.quantity_metric + '); set to 0.'
      });
      r.quantity_metric = 0;
    }
    if (typeof r.quantity_volumetric === 'number' && r.quantity_volumetric < 0) {
      autoFixes.push({
        path: 'rows[' + i + '].quantity_volumetric',
        original: r.quantity_volumetric,
        corrected: 0,
        message: 'Volumetric amount was negative (' + r.quantity_volumetric + '); set to 0.'
      });
      r.quantity_volumetric = 0;
    }
  }

  // (b) Header-level popularity / difficulty clamp into 1..5.
  if (headerPresent) {
    for (const key of ['popularity', 'difficulty']) {
      const val = corrected.header[key];
      if (typeof val === 'number') {
        if (val < 1) {
          autoFixes.push({
            path: 'header.' + key,
            original: val,
            corrected: 1,
            message: key + ' was below 1; set to 1.'
          });
          corrected.header[key] = 1;
        } else if (val > 5) {
          autoFixes.push({
            path: 'header.' + key,
            original: val,
            corrected: 5,
            message: key + ' was above 5; set to 5.'
          });
          corrected.header[key] = 5;
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // Stage 2 — Valibot shape-only / hard-reject (non-empty raw_text + URL)
  // --------------------------------------------------------------------------

  const result = v.safeParse(RecipeSchema, corrected);
  if (!result.success && Array.isArray(result.issues)) {
    for (const issue of result.issues) {
      hardErrors.push({
        path: (issue && issue.path)
          ? issue.path.map(p => p.key).join('.')
          : '<root>',
        value: issue.input,
        message: mapValibotIssue(issue)
      });
    }
  }

  // --------------------------------------------------------------------------
  // Stage 3 — D-35 cap-at-3 enforcement + defensive flagged_fields shape
  // --------------------------------------------------------------------------
  // Walk corrected.rows once. For each row:
  //   (i)  defensively initialize flagged_fields to [] if missing/non-array
  //        (covers older session-restore payloads or future regressions —
  //        the schema requires the field, but validate.js must not assume
  //        a non-Structured-Outputs caller honored that contract);
  //   (ii) if the LLM ignored the system-prompt cap and emitted > 3 entries,
  //        tag the row with `_needsFullReview = true` (runtime-only marker —
  //        toJoinCsvRow's whitelist drops it on disk write; the rendered
  //        "Needs full review" pill consumes this flag) AND auto-tick
  //        flag_fix_me (redundant given D-36 but documents intent).
  //
  // Stage 3 does NOT push to autoFixes (this is row-level suppression, not a
  // per-field correction) and does NOT push to hardErrors (Approve still
  // works — the pill is guidance, not a gate). The path-syntax convention
  // (autoFixes use bracket `rows[N].field` / hardErrors use dot `rows.N.field`)
  // is untouched.
  for (let i = 0; i < corrected.rows.length; i++) {
    const r = corrected.rows[i];
    if (!Array.isArray(r.flagged_fields)) {
      r.flagged_fields = [];
    }
    if (r.flagged_fields.length > MAX_FLAGGED_FIELDS_PER_ROW) {
      r._needsFullReview = true;
      r.flag_fix_me = true;
    }
  }

  // Stage 4 (Phase 4, D-48): suggested_allergens sanity — silent normalization, no autoFix/hardError pushes.
  // Structured Outputs already enforces FSA-14 at the token level on fresh parses, so this loop is a no-op
  // for the happy path. It catches restore-from-localStorage drift (Phase 3 D-42) where a persisted payload
  // could carry stale strings if FSA14 ever changes between save and restore. Per RESEARCH Pitfall 8:
  // null / [] / undefined are all semantically "no opinion"; only `null` and FSA-14-filtered arrays survive.
  for (let i = 0; i < corrected.rows.length; i++) {
    const r = corrected.rows[i];
    if (Array.isArray(r.suggested_allergens)) {
      const filtered = [...new Set(r.suggested_allergens)].filter(a => FSA14.includes(a));
      r.suggested_allergens = filtered.slice(0, FSA14.length);
    } else if (r.suggested_allergens !== null) {
      r.suggested_allergens = null;
    }
  }

  return { value: corrected, autoFixes, hardErrors };
}

// Re-exported so app.js / mapToPlainLanguage can reuse the issue → plain-
// language mapper without re-implementing the regex match.
export { mapValibotIssue };
