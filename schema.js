// ============================================================================
// Mise — JSON Schema for Anthropic Structured Outputs
// ----------------------------------------------------------------------------
// Phase 1 contract (D-05): Structured Outputs grammar-constrains the LLM at
// token level for the closed enums (unit / role / allergens / ingredient_id).
//
// IMPORTANT MECHANICS (RESEARCH §Pattern 3 / Pitfall A):
//   - EVERY `type: 'object'` node MUST set `additionalProperties: false`,
//     otherwise the API rejects the schema with HTTP 400.
//   - `minimum` / `maximum` / `minLength` / `maxLength` / `multipleOf` are NOT
//     enforced by Structured Outputs — those land in Phase 2 (Valibot, PARSE-03).
//     Phase 1's safety net is the form itself.
//   - All FSA-14 allergen names are case-sensitive in the enum.
//   - `ingredient_id` is nullable via
//     `anyOf: [{ type: 'integer', enum: masterIds }, { type: 'null' }]` so the
//     model can emit a known master ID or `null` for unknown items (per D-13:
//     Phase 1 has no add-new flow; nulls write empty cells). The `null` is in
//     its own anyOf branch — not inside the integer enum — to keep the enum
//     homogeneously typed (required by Anthropic's Structured Outputs
//     validator, which rejects mixed-type enums and the `type: ['T', 'null']`
//     array-nullability sugar with HTTP 400).
//   - `recipe_id` is DELIBERATELY OMITTED — allocated locally at Approve
//     (RESEARCH §3 footnote, Pitfall I).
//   - `source_servings` is DELIBERATELY OMITTED — the user pre-scales every
//     recipe to 20 servings before pasting (D-07, permanent project decision).
//
// SCHEMA-VS-REQUIREMENTS DIVERGENCE — `prep` is free-text:
//   The live `recipes.csv` column is `prep_notes`, holding free-text like
//   "Chop onion finely; pre-heat oven to 180C". The in-memory / schema / form
//   key is the shorter `prep`, BOUNDARY-TRANSLATED to the disk column at the
//   read/write edges (app.js openRecipeForEdit + toHeaderCsvRow) exactly like
//   `main_side_salad ↔ main/side/salad`. (quick 260618-i9p fixed the drift
//   where the disk column had been renamed prep→prep_notes but the writer/reader
//   still keyed `prep`, silently blanking prep_notes.) REQUIREMENTS.md REVIEW-02
//   historically calls this `prep_time_min`, which sounds numeric — but the v2
//   DISK SCHEMA is the locked contract (CLAUDE.md "v2 CSV schema is a locked
//   contract"). Therefore `prep` is declared `type: 'string'` here and in the
//   form. The REQUIREMENTS.md naming artefact is a doc-cleanup candidate, NOT a
//   schema directive.
//
// FIELD NAME MAPPING — `main_side_salad` ↔ `main/side/salad`:
//   The live `recipes.csv` column literally contains a forward slash:
//   `main/side/salad`. JSON Schema property names accept arbitrary strings, but
//   for tractability the schema uses the underscore form `main_side_salad` and
//   Plan 03's CSV row serializer maps it back to the disk column on write.
// ============================================================================

// 14 UK FSA allergens — case-sensitive, exact order from PROJECT.md / RESEARCH §3.
export const FSA14 = [
  'Gluten',
  'Crustaceans',
  'Eggs',
  'Fish',
  'Peanuts',
  'Soya',
  'Milk',
  'Nuts',
  'Celery',
  'Mustard',
  'Sesame',
  'Sulphites',
  'Lupin',
  'Molluscs'
];

// Locked unit enums — see CLAUDE.md "Controlled vocabularies".
// quick 260607-anu (v2 schema evolution): the single UNIT_ENUM is SPLIT into a
// metric enum (always-populated quantity_metric/unit_metric pair) and a
// volumetric enum (quantity_volumetric/unit_volumetric, populated only when the
// raw text used a non-metric amount). The legacy quantity/unit/min/max columns
// are removed across the whole contract chain.
export const UNIT_METRIC_ENUM = ['g', 'ml'];
export const UNIT_VOLUMETRIC_ENUM = ['whole', 'tsp', 'tbsp', 'cup'];

// Locked role enum — see CLAUDE.md.
export const ROLE_ENUM = ['required', 'optional', 'garnish', 'to_taste'];

// ----------------------------------------------------------------------------
// Phase 3 / REVIEW-05 — low-confidence flagging enums
// ----------------------------------------------------------------------------
// Closed 6-code reason enum (D-33). Order matches the documented ordering
// in 03-CONTEXT.md so the system-prompt teaching block and the
// REASON_CODE_TOOLTIPS map in app.js stay in lock-step.
export const REASON_CODE_ENUM = [
  'unit_guessed',
  'quantity_guessed',
  'unknown_ingredient',
  'range_or_estimate',
  'dropped_content',
  'allergen_uncertain'
];

// Field-name enum for `flagged_fields[].field` (D-32). Snake_case matches the
// row column names verbatim so `form.rows[i][entry.field]` works without
// translation (UI-SPEC Open Implementation Note 2). Twelve per-row editable
// column names (quick 260607-anu split the quantity contract into four) — no
// header-level flagging (deferred).
export const FLAGGED_FIELD_NAME_ENUM = [
  'line_order',
  'ingredient_id',
  'ingredient_name',
  // quick 260607-anu — the four-column quantity contract replaces the legacy
  // unit/quantity/range columns. Per-field flagging stays aligned with the columns.
  'quantity_metric',
  'unit_metric',
  'quantity_volumetric',
  'unit_volumetric',
  'section',
  'prep_note',
  'role',
  'raw_text'
];

// quick 260618-ihr (Workstream B) — closed enum for the parse-only
// header.review_flags judgement-call codes (SPEC §4.3). One code per
// recipe_import_spec.md §12 judgement call the model can make while
// standardizing instructions_20 / prep. PARSE-ONLY (D2): review_flags is
// NEVER serialized to any CSV (toHeaderCsvRow is column-driven and has no
// review_flags column), and never persists past Approve. Keep in lock-step
// with REVIEW_FLAG_LABELS in app.js and the REVIEW FLAGS section of
// system-prompt.js's DEFAULT_PROMPT_TEMPLATE.
export const REVIEW_FLAG_ENUM = [
  'reconstructed_method',
  'temperature_inferred',
  'prep_note_added',
  'prep_note_changed',
  'pulse_mushy_risk',
  'ingredient_mismatch_fixed',
  'steps_cut',
  'no_source_instructions'
];

/**
 * Build the Structured-Outputs JSON Schema for one parsed recipe.
 *
 * Builder takes the array of `ingredient_id` values from the in-memory master
 * (235 entries in Phase 1) and produces the schema with `ingredient_id`'s
 * `enum` set to `[...masterIds, null]` — the model can emit any known ID or
 * `null` for "unknown" (D-13).
 *
 * Phase 25 / CLASS-04 (D-10): the header also carries `cuisine` and `protein`
 * as non-nullable arrays-of-enum, grammar-constrained to the SYNCED controlled
 * vocabulary (classifications.json → this.cuisineVocab / this.proteinVocab).
 * The enums are PASSED IN (never hardcoded here — DSAFE-02 / D-03: the vocab is
 * user-editable and synced, not a schema literal). Like `allergens`, these are
 * non-nullable arrays (the model emits `[]` when nothing applies) so they add
 * ZERO anyOf branches — the 16-anyOf Anthropic cap (which applies to the ROW
 * schema, not the header) is unaffected.
 *
 * @param {Array<number>} masterIds — every `ingredient_id` from the master.
 * @param {string[]} cuisineEnum — the closed cuisine vocabulary (non-empty).
 * @param {string[]} proteinEnum — the closed protein vocabulary (non-empty).
 * @returns {object} JSON Schema ready for `output_config.format.schema`.
 */
export function buildRecipeSchema(masterIds, cuisineEnum, proteinEnum) {
  // Fail-loud guard (Rule 2 — vocabulary-discipline correctness, T-25-11): an
  // empty/undefined enum would silently produce an UNCONSTRAINED string array,
  // letting the LLM emit off-vocab classifications. Both call sites resolve the
  // enum through effectiveVocab() (always non-empty), so this never trips in
  // practice — it defends the grammar-constraint invariant against a future
  // caller that forgets the args. We do NOT hardcode a fallback vocab here
  // (that belongs in the synced file, not the schema — D-03).
  if (!Array.isArray(cuisineEnum) || cuisineEnum.length === 0) {
    throw new Error('buildRecipeSchema: cuisineEnum must be a non-empty array');
  }
  if (!Array.isArray(proteinEnum) || proteinEnum.length === 0) {
    throw new Error('buildRecipeSchema: proteinEnum must be a non-empty array');
  }
  return {
    type: 'object',
    additionalProperties: false,
    required: ['header', 'rows'],
    properties: {
      header: {
        type: 'object',
        additionalProperties: false,
        // Every property is REQUIRED — Structured Outputs treats `required`
        // strictly. Nullability is expressed via
        // `anyOf: [{ type: 'T', ...rest }, { type: 'null' }]`, NOT via omitting
        // from `required`. (The `type: ['T', 'null']` JSON Schema sugar is
        // rejected by Anthropic's validator — see file-header note.)
        required: [
          'name',
          'main_side_salad',
          'prep',
          'instructions_20',
          'ingredients_20',
          'source',
          'max_servings',
          'popularity',
          'difficulty',
          'last_made',
          'serve_with',
          'popularity_notes',
          'difficulty_notes',
          'allergens',
          'cuisine',
          'protein',
          'review_flags'
        ],
        properties: {
          name:             { type: 'string' },
          main_side_salad:  { type: 'string' },
          // `prep` is FREE-TEXT; maps to the disk `prep_notes` column — see file header.
          prep:             { type: 'string' },
          instructions_20:  { type: 'string' },
          ingredients_20:   { type: 'string' },
          source:           { anyOf: [{ type: 'string', format: 'uri' }, { type: 'null' }] },
          max_servings:     { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          popularity:       { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          difficulty:       { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          last_made:        { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] },
          serve_with:       { anyOf: [{ type: 'string' }, { type: 'null' }] },
          popularity_notes: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          difficulty_notes: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          allergens: {
            type: 'array',
            items: { type: 'string', enum: FSA14 }
          },
          // Phase 25 / CLASS-04 (D-10) — at-ingest cuisine/protein classification.
          // Non-nullable arrays-of-enum grammar-constrained to the SYNCED closed
          // vocabulary passed in (cuisineEnum/proteinEnum — NOT hardcoded, D-03).
          // The model emits `[]` when a recipe has no specific cuisine / no
          // significant protein — same empty-array convention as `allergens`, so
          // NO anyOf branch is added and the 16-anyOf row cap is unaffected. There
          // is deliberately no "None" enum value (D-14): `[]` IS "none".
          cuisine: {
            type: 'array',
            items: { type: 'string', enum: cuisineEnum }
          },
          protein: {
            type: 'array',
            items: { type: 'string', enum: proteinEnum }
          },
          // quick 260618-ihr (Workstream B, D2) — PARSE-ONLY judgement-call
          // flags surfaced in the review pane. NEVER serialized to any CSV
          // (toHeaderCsvRow is column-driven; review_flags has no disk column),
          // never persists past Approve. Non-nullable array: the model emits
          // `[]` when there are no judgement calls — exactly the flagged_fields
          // `[]` empty convention, so this adds NO anyOf branch and the 16-anyOf
          // Anthropic cap noted above the row's flagged_fields is unaffected.
          review_flags: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['reason_code', 'note'],
              properties: {
                reason_code: { type: 'string', enum: REVIEW_FLAG_ENUM },
                note:        { type: 'string' }
              }
            }
          }
        }
      },
      rows: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'line_order',
            'ingredient_id',
            'ingredient_name',
            // quick 260607-anu four-column quantity contract.
            'quantity_metric',
            'unit_metric',
            'quantity_volumetric',
            'unit_volumetric',
            'section',
            'prep_note',
            'role',
            'raw_text',
            'flag_fix_me',
            'flagged_fields',
            'suggested_allergens'
          ],
          properties: {
            line_order:      { type: 'integer' },
            // Token-level closed enum: any known master ID, or null for unknown.
            // `null` lives in its own anyOf branch — NOT inside the enum —
            // because Anthropic's Structured Outputs validator requires the
            // enum to be homogeneously integer-typed.
            ingredient_id:   { anyOf: [{ type: 'integer', enum: masterIds }, { type: 'null' }] },
            ingredient_name: { type: 'string' },
            // quick 260607-anu — four-column quantity contract. Metric pair is
            // ALWAYS populated (quantity_metric is non-null; LLM-estimated when
            // the raw text gives no metric amount). Volumetric pair is populated
            // ONLY when the source amount was non-metric, else both null.
            // Net anyOf change vs the legacy quantity/min/max trio: dropped 3
            // anyOf branches, added 2 (quantity_volumetric + unit_volumetric) →
            // the row schema's anyOf count goes DOWN (Pitfall J headroom intact).
            quantity_metric: { type: 'number' },
            unit_metric:     { type: 'string', enum: UNIT_METRIC_ENUM },
            quantity_volumetric: { anyOf: [{ type: 'number' }, { type: 'null' }] },
            unit_volumetric: { anyOf: [{ type: 'string', enum: UNIT_VOLUMETRIC_ENUM }, { type: 'null' }] },
            section:         { anyOf: [{ type: 'string' }, { type: 'null' }] },
            prep_note:       { anyOf: [{ type: 'string' }, { type: 'null' }] },
            role:            { type: 'string', enum: ROLE_ENUM },
            raw_text:        { type: 'string' },
            flag_fix_me:     { type: 'boolean' },
            // ----------------------------------------------------------------
            // Pitfall J exception — schema sits at 16 anyOf branches (Anthropic
            // cap); flagged_fields uses non-nullable array + LLM-enforced []
            // empty convention to avoid the 17th union-type. Do NOT "fix" to
            // anyOf — see 03-RESEARCH §1 schema risk and 260522-cg2-SUMMARY.
            // The system prompt (system-prompt.js LOW-CONFIDENCE FLAGGING
            // section) instructs the LLM to emit `flagged_fields: []` when
            // nothing is flagged — equivalent semantics to null without the
            // anyOf cost.
            // ----------------------------------------------------------------
            flagged_fields: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['field', 'reason_code'],
                properties: {
                  field:       { type: 'string', enum: FLAGGED_FIELD_NAME_ENUM },
                  reason_code: { type: 'string', enum: REASON_CODE_ENUM }
                }
              }
            },
            // suggested_allergens — D-48, per-row nullable FSA-14 array; null when ingredient_id is non-null
            suggested_allergens: { anyOf: [{ type: 'array', items: { type: 'string', enum: FSA14 } }, { type: 'null' }] }
          }
        }
      }
    }
  };
}

/**
 * buildClassifySchema — Phase 25 / CLASS-03 (D-09/D-11/D-17). The DEDICATED LEAN
 * multi-recipe classification schema for the bulk backfill. This is deliberately
 * NOT `buildRecipeSchema` (which ships the full 30KB parse extraction contract):
 * the backfill sends only name + ingredients_20 + type per recipe and wants only
 * a cuisine/protein array back, keyed by recipe_id.
 *
 * Shape: `{ results: [ { recipe_id: integer, cuisine: [enum], protein: [enum] } ] }`.
 * `additionalProperties: false` on EVERY object (assertNoOpenObjects enforces it
 * pre-request). The cuisine/protein items are grammar-constrained arrays-of-enum
 * — the enums are PASSED IN from the SYNCED vocabulary (never hardcoded here,
 * D-03), exactly like `allergens` / the parse header cuisine/protein. Non-nullable
 * arrays (the model emits `[]` when nothing applies — no invented "None", D-14),
 * so no anyOf branch is added.
 *
 * Fail-loud guard (Rule 2 — vocabulary-discipline correctness, T-25-13): an
 * empty/undefined enum would silently produce an UNCONSTRAINED string array,
 * letting the LLM emit off-vocab classifications. The caller resolves the enum
 * through effectiveVocab() (always non-empty), so this never trips in practice.
 *
 * @param {string[]} cuisineEnum — the closed cuisine vocabulary (non-empty)
 * @param {string[]} proteinEnum — the closed protein vocabulary (non-empty)
 * @returns {object} JSON Schema for output_config.format
 * @throws {Error} when either enum is empty/undefined.
 */
export function buildClassifySchema(cuisineEnum, proteinEnum) {
  if (!Array.isArray(cuisineEnum) || cuisineEnum.length === 0) {
    throw new Error('buildClassifySchema: cuisineEnum must be a non-empty array');
  }
  if (!Array.isArray(proteinEnum) || proteinEnum.length === 0) {
    throw new Error('buildClassifySchema: proteinEnum must be a non-empty array');
  }
  return {
    type: 'object',
    additionalProperties: false,
    required: ['results'],
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['recipe_id', 'cuisine', 'protein'],
          properties: {
            recipe_id: { type: 'integer' },
            cuisine: {
              type: 'array',
              items: { type: 'string', enum: cuisineEnum }
            },
            protein: {
              type: 'array',
              items: { type: 'string', enum: proteinEnum }
            }
          }
        }
      }
    }
  };
}

/**
 * Recursive linter that throws if any `type: 'object'` node in the schema is
 * missing `additionalProperties: false`. Walks `properties.*`, `items`, and
 * every branch of `anyOf[*]` so future object-typed anyOf branches cannot
 * bypass the check.
 *
 * Call this BEFORE every API request (in app.js) so a malformed dynamically-
 * built schema fails locally with the offending path rather than as an opaque
 * Anthropic 400. RESEARCH §Pitfall A.
 *
 * @param {object} schema
 * @param {string} [path] — internal accumulator, defaults to '' for the root.
 * @throws {Error} when an object node lacks `additionalProperties: false`.
 */
export function assertNoOpenObjects(schema, path = '') {
  if (schema && schema.type === 'object' && schema.additionalProperties !== false) {
    throw new Error(`Schema at ${path || '<root>'} is missing additionalProperties: false`);
  }
  if (schema && schema.properties) {
    for (const [k, v] of Object.entries(schema.properties)) {
      assertNoOpenObjects(v, `${path}.${k}`);
    }
  }
  if (schema && schema.items) {
    assertNoOpenObjects(schema.items, `${path}[]`);
  }
  if (schema && Array.isArray(schema.anyOf)) {
    schema.anyOf.forEach((branch, i) => {
      assertNoOpenObjects(branch, `${path}|anyOf[${i}]`);
    });
  }
}
