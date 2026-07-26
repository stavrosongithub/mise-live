// ============================================================================
// Mise — revise-ops.js (Phase 27 / plan 27-02 / D-01)
// ----------------------------------------------------------------------------
// PURE, TOTAL, BROWSER-FREE application of Claude's proposed recipe edits.
//
// This is the ONE gate between model output and the operator's recipe form.
// Everything the operator's safety depends on lives here: row resolution, the
// writable-field allow-list, value validation against the closed vocabularies,
// op application, the D-12 paired-quantity derivation, and the locally-computed
// diff.
//
// This module has EXACTLY TWO imports — './scale.js' and './schema.js' — and
// both are themselves plain, zero-import, node-safe modules (no Alpine, no
// PapaParse, no esm.sh, no DOM or browser globals). That is what lets BOTH the
// browser (app.js) AND a Node test import it unchanged. Do NOT add a
// browser/CDN import here or the Node test stops working.
//
// ----------------------------------------------------------------------------
// CORE SAFETY INVARIANTS (the reason this module exists — D-01/D-03)
//
//   1. WHOLE-PROPOSAL REJECTION. A proposal is all-or-nothing. One bad op means
//      ZERO ops applied — never a partial apply, never "the good ones went in".
//      Every refusal is an early return taken BEFORE anything is written.
//
//   2. THE INPUT `form` IS NEVER MUTATED, and nothing returned shares a nested
//      reference with it. Callers hand us live Alpine state; a shared reference
//      would leak an edit into the caller's form (and into its Undo snapshots)
//      behind the operator's back. `cloneForm` is the boundary copy.
//
//   3. REFUSALS ARE RETURN VALUES, never throws. `applyOps` always returns
//      `{ ok, nextForm, diff, error }` and `error` carries DISPLAY-READY plain
//      language ending in "Nothing was changed." A refusal is an expected
//      outcome of this feature, not a malfunction. We throw ONLY for a caller-
//      contract violation (e.g. `master` is not an array) — the fail-loud
//      programmer-error style `buildClassifySchema` already uses in schema.js.
//
// ----------------------------------------------------------------------------
// WHERE VOCABULARY DISCIPLINE IS SPLIT (read this precisely)
//
// `buildReviseSchema` (schema.js) grammar-constrains the field NAME — so a field
// outside ROW_WRITABLE / HEADER_WRITABLE and an off-master ingredient id are
// token-level IMPOSSIBLE for the model to emit. It CANNOT constrain the VALUE of
// a generic set-field op (the field name and the value live in the same object
// and Structured Outputs has no conditional keywords). So an off-enum unit/role/
// cuisine IS possible to emit and is IMPOSSIBLE TO APPLY: this module validates
// it and refuses the whole proposal. Both halves are load-bearing; neither is
// redundant.
//
// ----------------------------------------------------------------------------
// INJECTED DEPENDENCY — `blankRow` (PURE seam, the residents.js idiom)
//
// `add_row` must produce a row with exactly app.js's `blankRow` defaults, but
// `blankRow` lives in app.js because it calls the app-local monotonic
// `nextRowKey()` counter. Duplicating its defaults here would create a SECOND
// source of truth for row shape — precisely what scripts/check-editor-row-
// fields.mjs exists to prevent. So the caller INJECTS it on the `applyOps`
// argument object (production passes app.js's real `blankRow` verbatim; the
// Node test passes a small fixture factory). `revise-ops.js` stays 100%
// browser-free and `blankRow` stays app-local and unrefactored.
// ⚠ RESIDUAL DRIFT RISK, named so it is not forgotten: the Node test asserts
// against its own fixture, not against the real `blankRow`, so a future edit to
// `blankRow`'s defaults would not fail that test. MITIGATION (plan 27-03): the
// fixture is `fixtureBlankRow` in scripts/revise.test.mjs, and `blankRow` in
// app.js carries a paired SHARED-ROW-FIELDS marker comment naming it. There is
// no automated guard for this pairing — the two comments ARE the control. If
// you change `blankRow`'s defaults, change the fixture in the same commit.
// ============================================================================

import { scaleMetric, scaleVolumetric } from './scale.js';
import {
  ROW_WRITABLE,
  HEADER_WRITABLE,
  UNIT_METRIC_ENUM,
  UNIT_VOLUMETRIC_ENUM,
  ROLE_ENUM
} from './schema.js';

// ----------------------------------------------------------------------------
// FIELD_LABELS — operator-facing names for every field a message can mention.
// ----------------------------------------------------------------------------
// The diff and every refusal must name fields with the labels the operator
// already sees on the Edit tab, NEVER the CSV column name (27-UI-SPEC I6).
// The 18 writable entries are I6 verbatim. The trailing UNWRITABLE entries exist
// so a "Chat can't change X" refusal can name X in the same operator language
// rather than leaking a schema identifier.
export const FIELD_LABELS = Object.freeze({
  // --- header, writable (10) ---
  name:                 'Name',
  main_side_salad:      'Type',
  instructions_20:      'Instructions (at 20 servings)',
  prep:                 'Prep',
  serve_with:           'Serve with',
  max_servings:         'Max servings',
  difficulty:           'Difficulty (1-5)',
  popularity:           'Popularity (1-5)',
  cuisine:              'Cuisine',
  protein:              'Protein',
  // --- row, writable (8) ---
  quantity_metric:      'Quantity (metric)',
  unit_metric:          'Unit (metric)',
  quantity_volumetric:  'Quantity (volumetric)',
  unit_volumetric:      'Unit (volumetric)',
  role:                 'Role',
  section:              'Section',
  prep_note:            'Prep note',
  ingredient_id:        'Ingredient',
  // --- common UNWRITABLE names, for refusal copy only ---
  raw_text:             'Recipe text',
  line_order:           'Line order',
  allergens:            'Allergens',
  ingredients_20:       'Ingredients summary',
  ingredient_name:      'Ingredient name'
});

/** Operator-facing label for a field name, falling back to the raw name. */
function labelFor(field) {
  return Object.prototype.hasOwnProperty.call(FIELD_LABELS, field)
    ? FIELD_LABELS[field]
    : String(field);
}

/**
 * cloneForm(form) — THE boundary copy. An EXPLICIT two-level structural copy of
 * `{ header, rows }`: a fresh header object with fresh `allergens` / `cuisine` /
 * `protein` arrays, and a fresh object per row with a fresh `flagged_fields`
 * array. Nothing in the result shares a reference with the input.
 *
 * WHY NOT `structuredClone`: it throws `DataCloneError` on an Alpine reactive
 * Proxy, and the caller hands us live form state (memory
 * `reactive-proxy-into-indexeddb`; validate.js documents the same trap).
 *
 * WHY NOT `JSON.parse(JSON.stringify(form))`: a JSON round-trip converts `NaN`
 * to `null`, and a cleared `x-model.number` quantity input IS `NaN`. Cloning
 * that way would silently mutate UNTOUCHED sibling rows (NaN → null) and break
 * SPEC req 4's byte-identical-siblings guarantee — a data change the operator
 * never asked for and would never see in the diff.
 *
 * app.js reuses this SAME helper for its Undo snapshots (plan 27-05) — sharing
 * object refs between the live form and the undo stack is the
 * `mealplan-base-must-be-deep-cloned` bug class. Do not grow a second copy of
 * this logic there.
 *
 * @param {{header?: object, rows?: Array<object>}} form
 * @returns {{header: object, rows: Array<object>}}
 */
export function cloneForm(form) {
  const f = (form && typeof form === 'object') ? form : {};
  const h = (f.header && typeof f.header === 'object') ? f.header : {};
  const rows = Array.isArray(f.rows) ? f.rows : [];

  // Copy the nested arrays IN PLACE on the spread copy — never as literal keys,
  // because assigning `allergens: undefined` on a header that never had the key
  // would ADD it, and a no-op proposal's nextForm must be deep-equal to the
  // input form (an added `undefined` key fails deepStrictEqual).
  const header = { ...h };
  for (const k of ['allergens', 'cuisine', 'protein']) {
    if (Array.isArray(header[k])) header[k] = header[k].slice();
  }

  return {
    header,
    rows: rows
      .filter(r => r && typeof r === 'object')
      .map(r => {
        const row = { ...r };
        if (Array.isArray(row.flagged_fields)) row.flagged_fields = row.flagged_fields.slice();
        return row;
      })
  };
}

/**
 * resolveRowIndex(rows, line_order, ingredient_id) — JOINT row addressing.
 *
 * An op names a row by BOTH its `line_order` and its `ingredient_id`. A row
 * matches only when BOTH agree. Anything other than exactly one unambiguous
 * match REFUSES — so an op can never land on a row it did not name, which is
 * the whole point of carrying two coordinates instead of one (SPEC req 4).
 *
 * Resolution order matters: ambiguity is checked FIRST, because when two rows
 * share a `line_order` the address is unusable even if the `ingredient_id`
 * happens to single one of them out — the operator's own numbering is broken
 * and a silent pick would be a guess.
 *
 * @param {Array<object>} rows — the form's rows (the ORIGINAL, never a partly-applied copy)
 * @param {number|string} line_order
 * @param {number|string} ingredient_id
 * @param {string} [opIngredientLabel] — optional operator-facing name for the
 *   ingredient the op named, used only in the pointer-mismatch message. Defaults
 *   to `ingredient {id}` when the caller has no master to resolve it against.
 * @returns {{ok: true, index: number} | {ok: false, error: string}}
 */
export function resolveRowIndex(rows, line_order, ingredient_id, opIngredientLabel) {
  const list = Array.isArray(rows) ? rows : [];
  const n = Number(line_order);
  const wantId = Number(ingredient_id);
  const shown = String(line_order);

  const sameLine = [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (r && typeof r === 'object' && Number(r.line_order) === n) sameLine.push(i);
  }

  if (sameLine.length >= 2) {
    return {
      ok: false,
      error: `Two ingredients share line ${shown}, so that change could go to either. Nothing was changed.`
    };
  }
  if (sameLine.length === 0) {
    return {
      ok: false,
      error: `There's no line ${shown} in this recipe any more. Nothing was changed.`
    };
  }

  const idx = sameLine[0];
  if (Number(list[idx].ingredient_id) === wantId) {
    return { ok: true, index: idx };
  }

  const actual = list[idx].ingredient_name ? String(list[idx].ingredient_name) : `ingredient ${list[idx].ingredient_id}`;
  const proposed = opIngredientLabel ? String(opIngredientLabel) : `ingredient ${String(ingredient_id)}`;
  return {
    ok: false,
    error: `That change points at line ${shown}, but line ${shown} is ${actual}, not ${proposed}. Nothing was changed.`
  };
}

/**
 * checkWritable(scope, field) — THE allow-list gate, shared by both set ops.
 *
 * Membership is tested against the IMPORTED `ROW_WRITABLE` / `HEADER_WRITABLE`
 * from schema.js — the same frozen arrays the Structured Outputs grammar's
 * field-name enums are built from. Never a local literal list: a second copy is
 * a second source of truth, and the one that drifts is always the one enforcing
 * safety.
 *
 * @param {'row'|'header'} scope
 * @param {string} field
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function checkWritable(scope, field) {
  const allowed = scope === 'header' ? HEADER_WRITABLE : ROW_WRITABLE;
  if (allowed.indexOf(field) !== -1) return { ok: true };
  return {
    ok: false,
    error: `Chat can't change ${labelFor(field)} — edit it on the Edit tab. Nothing was changed.`
  };
}

// ============================================================================
// VALUE VALIDATION — the half of vocabulary discipline the grammar cannot do
// ============================================================================
// Every failure here refuses the WHOLE proposal (invariant 1). Nothing is
// coerced-and-hoped: a value that is not a member of its closed vocabulary, or
// that does not coerce to a finite number, is an error the operator is told
// about — never a silent 0, never a silent ''.

/** Blank in the model's vocabulary: '' / null / undefined all mean "no value". */
function isBlank(v) {
  return v === '' || v === null || v === undefined;
}

function offEnumError(value, field, allowed) {
  return `"${String(value)}" isn't a valid ${labelFor(field)} — Chat can only use ${allowed.join(', ')}. Nothing was changed.`;
}

function notANumberError(value, field) {
  return `"${String(value)}" isn't a number for ${labelFor(field)}. Nothing was changed.`;
}

/**
 * Validate + coerce ONE row field's value. Numbers arrive as strings (the
 * grammar has no number branch for `set_row_field.value` — adding one would
 * make it ambiguous with the master-id branch), so every numeric field is
 * `Number()`-coerced here and REFUSED when the result is not finite.
 *
 * Range checks (`difficulty`/`popularity` ∈ 1..5) are deliberately NOT done
 * here: Structured Outputs cannot enforce `minimum`/`maximum`, and this project
 * already enforces them in `validateRecipe` at Save. Two enforcement points for
 * one rule is how they drift.
 *
 * @returns {{ok:true, value:*, ingredient_name?:string} | {ok:false, error:string}}
 */
function validateRowValue(field, value, masterById) {
  switch (field) {
    case 'quantity_metric': {
      // No blank clear: the metric quantity is the always-populated half of the
      // four-column quantity contract. Clearing it is an Edit-tab action.
      if (isBlank(value)) return { ok: false, error: notANumberError(value, field) };
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) return { ok: false, error: notANumberError(value, field) };
      return { ok: true, value: n };
    }
    case 'quantity_volumetric': {
      if (isBlank(value)) return { ok: true, value: null };   // blank CLEARS the optional half
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) return { ok: false, error: notANumberError(value, field) };
      return { ok: true, value: n };
    }
    case 'unit_metric': {
      const s = String(value);
      if (UNIT_METRIC_ENUM.indexOf(s) === -1) return { ok: false, error: offEnumError(value, field, UNIT_METRIC_ENUM) };
      return { ok: true, value: s };
    }
    case 'unit_volumetric': {
      if (isBlank(value)) return { ok: true, value: null };
      const s = String(value);
      if (UNIT_VOLUMETRIC_ENUM.indexOf(s) === -1) return { ok: false, error: offEnumError(value, field, UNIT_VOLUMETRIC_ENUM) };
      return { ok: true, value: s };
    }
    case 'role': {
      const s = String(value);
      if (ROLE_ENUM.indexOf(s) === -1) return { ok: false, error: offEnumError(value, field, ROLE_ENUM) };
      return { ok: true, value: s };
    }
    case 'section':
    case 'prep_note':
      return { ok: true, value: isBlank(value) ? '' : String(value) };
    case 'ingredient_id': {
      const n = Number(value);
      if (!Number.isInteger(n) || !masterById.has(n)) {
        return { ok: false, error: `Ingredient ${String(value)} isn't in your ingredient list. Nothing was changed.` };
      }
      // The NAME is re-derived LOCALLY from the master — never taken from the
      // model, which has no writable path to `ingredient_name` at all (T-27-02).
      const entry = masterById.get(n);
      const nm = entry.ingredient_name;
      return { ok: true, value: n, ingredient_name: nm == null ? '' : String(nm) };
    }
    default:
      // Unreachable: checkWritable already rejected anything outside ROW_WRITABLE.
      // Fail closed rather than fall through to a silent write.
      return { ok: false, error: `Chat can't change ${labelFor(field)} — edit it on the Edit tab. Nothing was changed.` };
  }
}

/**
 * Validate + coerce ONE header field's value.
 *
 * `cuisine` / `protein` are ARRAYS in the form (they bind to checkbox `x-model`
 * on `form.header.*`). Writing a `;`-joined STRING there triggers a documented
 * Alpine bug — checkbox `x-model` on a non-array key takes the boolean branch
 * and CHECKS EVERY BOX (memory `alpine-checkbox-xmodel-boolean-fallback`). So a
 * string value is split (Phase-25 D-13 read-tolerant `/[;,]/`) and stored as an
 * array; the `;`-join is a DISPLAY concern, done in `computeDiff` only.
 *
 * Each member is filtered against its OWN vocabulary — a cuisine value must be
 * in `cuisineEnum`, not merely in the de-duplicated union the grammar permits
 * (the grammar cannot tell which header field a value belongs to).
 *
 * @returns {{ok:true, value:*} | {ok:false, error:string}}
 */
function validateHeaderValue(field, value, cuisineEnum, proteinEnum) {
  switch (field) {
    case 'max_servings':
    case 'difficulty':
    case 'popularity': {
      if (isBlank(value)) return { ok: false, error: notANumberError(value, field) };
      const n = Number(value);
      if (!Number.isFinite(n)) return { ok: false, error: notANumberError(value, field) };
      return { ok: true, value: n };
    }
    case 'cuisine':
    case 'protein': {
      const vocabIn = field === 'cuisine' ? cuisineEnum : proteinEnum;
      const vocab = Array.isArray(vocabIn) ? vocabIn : [];
      const raw = Array.isArray(value) ? value : String(isBlank(value) ? '' : value).split(/[;,]/);
      const members = raw.map(s => String(s).trim()).filter(Boolean);
      for (const mem of members) {
        if (vocab.indexOf(mem) === -1) return { ok: false, error: offEnumError(mem, field, vocab) };
      }
      return { ok: true, value: members };
    }
    default:
      // name / main_side_salad / instructions_20 / prep / serve_with — free text.
      return { ok: true, value: isBlank(value) ? '' : String(value) };
  }
}

// ============================================================================
// applyOps — the whole-proposal applier
// ============================================================================

/**
 * applyOps({ form, ops, master, cuisineEnum, proteinEnum, blankRow })
 *
 * Apply a proposal to a COPY of the operator's form, or refuse the whole thing.
 *
 * Two passes, deliberately. PASS 1 resolves every row address, gates every
 * field name against the allow-list and validates every value — WITHOUT writing
 * anything. PASS 2 writes. That is what makes "one bad op applies zero ops"
 * structural rather than a discipline the next edit can quietly break.
 *
 * `ops` MAY BE EMPTY — a reply with nothing to apply is a normal, supported
 * outcome (D-11), not an error: it returns `ok:true` with an empty diff.
 *
 * Fields this function must NEVER write, anywhere: `recipe_id`,
 * `header.allergens` (derived from the rows by app.js's `derivedAllergens`
 * getter, so an ingredient swap updates it for free), `header.ingredients_20`,
 * row `raw_text` (verbatim source provenance — the real write path in app.js
 * derives it), row `line_order` (except `blankRow`'s own assignment on an add),
 * `ingredient_name` (re-derived from the master, never model-set), `flag_fix_me`,
 * `flagged_fields`, `_key`, `_confirmed`.
 *
 * @param {object}   args
 * @param {object}   args.form         — the operator's form `{header, rows}` (NEVER mutated)
 * @param {Array}    args.ops          — the model's proposed ops (may be empty)
 * @param {Array}    args.master       — the ingredient master (rows with `ingredient_id` / `ingredient_name`)
 * @param {string[]} args.cuisineEnum  — the synced cuisine vocabulary
 * @param {string[]} args.proteinEnum  — the synced protein vocabulary
 * @param {Function} args.blankRow     — INJECTED app.js `blankRow(form)` (see the header note)
 * @returns {{ok: boolean, nextForm: object|null, diff: Array, error: string|null}}
 * @throws {Error} only on a CALLER-contract violation (bad `master` / `blankRow`)
 */
export function applyOps({ form, ops, master, cuisineEnum, proteinEnum, blankRow } = {}) {
  // Fail-loud programmer-error guards (the schema.js builder style). These are
  // NOT operator-facing refusals — a missing master would silently disable the
  // ingredient-membership check, i.e. the control would fail OPEN.
  if (!Array.isArray(master)) throw new Error('applyOps: master must be an array');
  if (typeof blankRow !== 'function') throw new Error('applyOps: blankRow must be a function');

  const refuse = (error) => ({ ok: false, nextForm: null, diff: [], error });
  const opList = Array.isArray(ops) ? ops : [];

  // Build `next` up front and mutate ONLY `next`. Every refusal returns before
  // `next` escapes, so the caller's form is untouched BY CONSTRUCTION.
  const next = cloneForm(form);

  // Row addresses resolve against the PRE-PROPOSAL rows — `next.rows` as cloned,
  // before PASS 2 touches it. A row added by this same proposal has no
  // `line_order` until Apply assigns it, so it is deliberately unaddressable.
  const baseRows = next.rows;

  const masterById = new Map();
  for (const m of master) {
    if (!m || typeof m !== 'object') continue;
    const id = Number(m.ingredient_id);
    if (Number.isInteger(id) && !masterById.has(id)) masterById.set(id, m);
  }
  const masterName = (id) => {
    const e = masterById.get(Number(id));
    return (e && e.ingredient_name != null) ? String(e.ingredient_name) : '';
  };

  // --------------------------------------------------------------------------
  // PASS 1 — resolve, gate, validate. Writes NOTHING.
  // --------------------------------------------------------------------------
  const headerSets = [];    // {field, value}
  const rowSets = [];       // {index, field, value, ingredient_name?}
  const rowRemovals = [];   // {index}
  const rowAdds = [];       // {fields, ingredient_name}
  const setLines = new Map();       // rowIndex -> line_order as the op wrote it
  const removeLines = new Map();    // rowIndex -> line_order as the op wrote it
  const quantityProposed = new Map(); // rowIndex -> Set of the quantity fields set (drives D-12)

  for (const op of opList) {
    if (!op || typeof op !== 'object') {
      return refuse(`Chat proposed a change it can't make (${String(op)}). Nothing was changed.`);
    }
    const kind = op.kind;

    if (kind === 'set_row_field') {
      const gate = checkWritable('row', op.field);
      if (!gate.ok) return refuse(gate.error);

      const res = resolveRowIndex(baseRows, op.line_order, op.ingredient_id, masterName(op.ingredient_id));
      if (!res.ok) return refuse(res.error);

      const val = validateRowValue(op.field, op.value, masterById);
      if (!val.ok) return refuse(val.error);

      rowSets.push({ index: res.index, field: op.field, value: val.value, ingredient_name: val.ingredient_name });
      setLines.set(res.index, String(op.line_order));

      if (op.field === 'quantity_metric' || op.field === 'quantity_volumetric') {
        if (!quantityProposed.has(res.index)) quantityProposed.set(res.index, new Set());
        quantityProposed.get(res.index).add(op.field);
      }

    } else if (kind === 'set_header_field') {
      const gate = checkWritable('header', op.field);
      if (!gate.ok) return refuse(gate.error);

      const val = validateHeaderValue(op.field, op.value, cuisineEnum, proteinEnum);
      if (!val.ok) return refuse(val.error);

      headerSets.push({ field: op.field, value: val.value });

    } else if (kind === 'remove_row') {
      const res = resolveRowIndex(baseRows, op.line_order, op.ingredient_id, masterName(op.ingredient_id));
      if (!res.ok) return refuse(res.error);
      rowRemovals.push({ index: res.index });
      removeLines.set(res.index, String(op.line_order));

    } else if (kind === 'add_row') {
      const fields = {};
      let addedName;
      // Only the allow-listed add fields are read; anything else the model sent
      // is ignored rather than written (the grammar forbids extra keys anyway).
      for (const f of ['ingredient_id', 'quantity_metric', 'unit_metric', 'role', 'section', 'prep_note']) {
        if (op[f] === undefined) continue;
        const val = validateRowValue(f, op[f], masterById);
        if (!val.ok) return refuse(val.error);
        fields[f] = val.value;
        if (f === 'ingredient_id') addedName = val.ingredient_name;
      }
      rowAdds.push({ fields, ingredient_name: addedName });

    } else {
      return refuse(`Chat proposed a change it can't make (${String(kind)}). Nothing was changed.`);
    }
  }

  // A row cannot be both edited and removed by one proposal — whichever we did
  // last would silently win, and the diff would read as a lie either way.
  for (const [index, line] of removeLines) {
    if (setLines.has(index)) {
      return refuse(`Chat proposed both a change and a removal for line ${line}. Nothing was changed.`);
    }
  }

  // --------------------------------------------------------------------------
  // PASS 2 — apply. Everything below is already validated; no refusal past here.
  // --------------------------------------------------------------------------

  // Pre-application quantities, index-aligned with next.rows. Read by the D-12
  // derivation so the ratio is computed against the OLD value, not the new one.
  const beforeQty = next.rows.map(r => ({
    quantity_metric: r.quantity_metric,
    quantity_volumetric: r.quantity_volumetric
  }));

  for (const s of headerSets) {
    next.header[s.field] = s.value;
  }

  for (const s of rowSets) {
    const row = next.rows[s.index];
    row[s.field] = s.value;
    if (s.field === 'ingredient_id' && s.ingredient_name !== undefined) {
      row.ingredient_name = s.ingredient_name;   // locally derived, see validateRowValue
    }
  }

  // --- D-12: derive the paired quantity LOCALLY -----------------------------
  // A row can carry both a metric and a volumetric amount. Claude proposes ONE
  // side; we derive the other from the ratio using scale.js's existing per-unit
  // rounding — deterministic, no model arithmetic, no density guessing.
  //
  // GUARD (all three required, else derive nothing and refuse nothing):
  //   • the proposal sets exactly ONE of the two quantity fields for this row
  //     (if it set both, the model has already decided the pair);
  //   • the OTHER half currently holds a value (non-null, non-'');
  //   • the OLD value of the proposed half is a FINITE number > 0.
  // The third clause is the important one: an old value of 0 or null yields an
  // Infinity/NaN ratio, and scaleVolumetric(2,'cup',Infinity) returns Infinity —
  // which would land in a quantity field and then in a CSV cell.
  //
  // Only the two primitives are used, each with a plain numeric ratio. The
  // meal-plan scaler's per-category scaling strengths must NOT be involved:
  // this is a base-recipe edit, not a servings projection (RCHAT-04).
  for (const [index, fields] of quantityProposed) {
    if (fields.size !== 1) continue;

    const proposedField = fields.has('quantity_metric') ? 'quantity_metric' : 'quantity_volumetric';
    const otherField = proposedField === 'quantity_metric' ? 'quantity_volumetric' : 'quantity_metric';

    const before = beforeQty[index] || {};
    const otherOld = before[otherField];
    if (otherOld === null || otherOld === undefined || otherOld === '') continue;

    const oldVal = Number(before[proposedField]);
    if (!Number.isFinite(oldVal) || oldVal <= 0) continue;

    const newVal = Number(next.rows[index][proposedField]);
    if (!Number.isFinite(newVal)) continue;

    const ratio = newVal / oldVal;
    if (!Number.isFinite(ratio)) continue;

    if (proposedField === 'quantity_metric') {
      next.rows[index].quantity_volumetric = scaleVolumetric(otherOld, next.rows[index].unit_volumetric, ratio);
    } else {
      next.rows[index].quantity_metric = scaleMetric(otherOld, ratio);
    }
  }

  // --- removals: splice HIGHEST index first so earlier indices stay valid.
  // Surviving rows are NOT renumbered — `line_order` is the operator's own
  // numbering and renumbering it would silently re-address every later row.
  const removeIdx = [...new Set(rowRemovals.map(r => r.index))].sort((a, b) => b - a);
  for (const i of removeIdx) next.rows.splice(i, 1);

  // --- additions: blankRow() against the ACCUMULATING form, so successive adds
  // get max+1, max+2 and fresh _keys. raw_text stays '' (blankRow's default) —
  // this module never derives it.
  for (const add of rowAdds) {
    const row = blankRow(next);
    for (const f of Object.keys(add.fields)) row[f] = add.fields[f];
    if (add.ingredient_name !== undefined) row.ingredient_name = add.ingredient_name;
    next.rows.push(row);
  }

  // The diff is computed from the two FORMS only — the ORIGINAL input form and
  // the applied copy — so a before-value structurally cannot come from a
  // model-supplied field. Pass `form`, never a copy taken after a mutation.
  return { ok: true, nextForm: next, diff: computeDiff(form, next), error: null };
}

// ============================================================================
// computeDiff — the operator's review surface
// ============================================================================

/** Display rendering for one value: arrays `;`-joined, null/undefined as ''. */
function displayValue(v) {
  if (Array.isArray(v)) return v.join(';');   // Phase-25 D-13: write/display with ';'
  if (v === null || v === undefined) return '';
  return String(v);
}

/** A row's amount as one display string, e.g. `450 g`. */
function amountText(row) {
  const q = displayValue(row.quantity_metric);
  const u = displayValue(row.unit_metric);
  return (q + ' ' + u).trim();
}

/** Stable per-row identity for matching prev↔next. `_key` is the real one. */
function rowKeyOf(row, index) {
  return (row && row._key !== undefined && row._key !== null) ? row._key : `#${index}`;
}

/**
 * computeDiff(prevForm, nextForm) — the compact changed-only list the operator
 * reviews before pressing Apply (D-07).
 *
 * ⚠ THE SIGNATURE IS THE GUARANTEE. This function takes EXACTLY TWO FORMS and
 * nothing else — no ops, no reply, no model-supplied data of any kind. So a
 * before-value it reports CANNOT have come from a field the model wrote; it can
 * only have been read out of the operator's own form. That is SPEC req 6's
 * "the diff is computed in JS by applying ops against the form, never a diff the
 * model describes", enforced structurally rather than by convention. Do not add
 * a third parameter.
 *
 * Only CHANGED things are emitted — unchanged rows and fields are not rendered.
 * Values are display-ready strings; nothing is rounded or reformatted here (the
 * values are already the applied values).
 *
 * Entry shape:
 *   { scope, change, field, label, rowKey, line_order, name, old, new }
 * `change:'set'` entries name a writable `field`; `change:'add'`/`'remove'`
 * entries describe a WHOLE row, so their `field`/`label` are `''` (never an
 * unwritable field name) and they carry the row's identity instead.
 *
 * Order: header entries first in `HEADER_WRITABLE` order, then row entries by
 * `line_order` and then `ROW_WRITABLE` order — so both halves of a derived
 * metric/volumetric pair render as two adjacent lines (D-12 / UI-SPEC I6).
 *
 * @param {{header?: object, rows?: Array<object>}} prevForm
 * @param {{header?: object, rows?: Array<object>}} nextForm
 * @returns {Array<object>}
 */
export function computeDiff(prevForm, nextForm) {
  const pf = (prevForm && typeof prevForm === 'object') ? prevForm : {};
  const nf = (nextForm && typeof nextForm === 'object') ? nextForm : {};
  const pHead = (pf.header && typeof pf.header === 'object') ? pf.header : {};
  const nHead = (nf.header && typeof nf.header === 'object') ? nf.header : {};
  const pRows = Array.isArray(pf.rows) ? pf.rows : [];
  const nRows = Array.isArray(nf.rows) ? nf.rows : [];

  const headerEntries = [];
  for (const field of HEADER_WRITABLE) {
    const oldText = displayValue(pHead[field]);
    const newText = displayValue(nHead[field]);
    if (oldText === newText) continue;
    headerEntries.push({
      scope: 'header',
      change: 'set',
      field,
      label: labelFor(field),
      rowKey: null,
      line_order: null,
      name: '',
      old: oldText,
      new: newText
    });
  }

  const pByKey = new Map();
  pRows.forEach((r, i) => { if (r && typeof r === 'object') pByKey.set(rowKeyOf(r, i), r); });
  const nByKey = new Map();
  nRows.forEach((r, i) => { if (r && typeof r === 'object') nByKey.set(rowKeyOf(r, i), r); });

  const rowEntries = [];

  nRows.forEach((row, i) => {
    if (!row || typeof row !== 'object') return;
    const key = rowKeyOf(row, i);
    const prevRow = pByKey.get(key);

    if (!prevRow) {
      rowEntries.push({
        scope: 'row',
        change: 'add',
        field: '',
        label: '',
        rowKey: key,
        line_order: row.line_order,
        name: displayValue(row.ingredient_name),
        old: '',
        new: amountText(row),
        quantity_metric: row.quantity_metric,
        unit_metric: row.unit_metric
      });
      return;
    }

    for (const field of ROW_WRITABLE) {
      let oldText = displayValue(prevRow[field]);
      let newText = displayValue(row[field]);
      if (oldText === newText) continue;
      if (field === 'ingredient_id') {
        // Show the operator the NAMES (`Salt → Onion`), not the raw ids. Both
        // names are read from their own form, never from the op.
        oldText = displayValue(prevRow.ingredient_name);
        newText = displayValue(row.ingredient_name);
        if (oldText === newText) continue;
      }
      rowEntries.push({
        scope: 'row',
        change: 'set',
        field,
        label: labelFor(field),
        rowKey: key,
        line_order: row.line_order,
        name: displayValue(row.ingredient_name),
        old: oldText,
        new: newText
      });
    }
  });

  pRows.forEach((row, i) => {
    if (!row || typeof row !== 'object') return;
    const key = rowKeyOf(row, i);
    if (nByKey.has(key)) return;
    rowEntries.push({
      scope: 'row',
      change: 'remove',
      field: '',
      label: '',
      rowKey: key,
      line_order: row.line_order,
      name: displayValue(row.ingredient_name),
      old: amountText(row),
      new: ''
    });
  });

  rowEntries.sort((a, b) => {
    const la = Number(a.line_order); const lb = Number(b.line_order);
    const na = Number.isFinite(la) ? la : 0;
    const nb = Number.isFinite(lb) ? lb : 0;
    if (na !== nb) return na - nb;
    return ROW_WRITABLE.indexOf(a.field) - ROW_WRITABLE.indexOf(b.field);
  });

  return headerEntries.concat(rowEntries);
}
