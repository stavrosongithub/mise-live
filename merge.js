// ============================================================================
// Mise — schema-migration transforms + detectors + CSV probe
// ----------------------------------------------------------------------------
// OFFLINE-PURE ESM module in the spirit of validate.js: no Alpine, no DOM, no
// globals. quick 260612-abt removed the FSA delta/merge file-I/O primitives
// (scanPendingDeltas / backupLiveFile / appendLiveCsv / verifyAppend /
// writeMergedSentinel / mergeCollisionScan) when the tool moved from a File
// System Access folder to an IndexedDB store. What remains is the mechanical
// no-LLM schema-migration transforms + header detectors (consumed by app.js
// migrateLiveSchema), detectCsvConventions (the CSV BOM/newline probe), and
// isShoppingUnitValue.
//
// CDN imports are VERSION-PINNED per D-04 (matches app.js). No floating
// version specifiers anywhere.
// ============================================================================

import Papa from 'https://esm.sh/papaparse@5.4.0';
// quick 260612-esy — Phase B: the name-heuristic backfill of scale_category at
// migration time reuses the SAME classifier the scaler uses. scale.js is pure
// and zero-import (it does NOT import merge.js), so there is no circular import.
import { classifyIngredientCategory } from './scale.js';

// ----------------------------------------------------------------------------
// quick 260607-anu — v2 schema-evolution pure helpers (no I/O, no Alpine/DOM).
// The live recipe_ingredients.csv migrates from the legacy
// unit/quantity/range column shape to the four-column
// quantity_metric/unit_metric/quantity_volumetric/unit_volumetric shape. These
// three exports are the mechanical, no-LLM transform + the header detectors the
// orchestrator (app.js migrateLiveSchema + merge old-schema refusal) consumes.
// ----------------------------------------------------------------------------

// The four migrated columns, in order, that REPLACE the legacy quantity-column
// run in place.
const MIGRATED_QUANTITY_COLUMNS = ['quantity_metric', 'unit_metric', 'quantity_volumetric', 'unit_volumetric'];
// The legacy quantity columns, in the order they appear in the live header. This
// array is load-bearing: it is the ONLY place the migration names the legacy
// columns (the detectors + the in-place header replacement key off it). It must
// retain the literal names so a real legacy CSV can be recognized + rewritten.
const LEGACY_QUANTITY_COLUMNS = ['unit', 'quantity', 'quantity_min', 'quantity_max'];
// Locked enums (kept local so merge.js stays import-free of schema.js — the
// migration is mechanical and must not drift if schema.js changes shape).
const METRIC_UNITS = ['g', 'ml'];
const VOLUMETRIC_UNITS = ['whole', 'tsp', 'tbsp', 'cup'];

/**
 * isMigratedJoinHeader — true iff `columns` includes ALL four migrated quantity
 * columns. Used for the migration idempotency check (refuse to run twice) and
 * the merge "this delta is already on the new schema" branch.
 *
 * @param {string[]} columns
 * @returns {boolean}
 */
export function isMigratedJoinHeader(columns) {
  if (!Array.isArray(columns)) return false;
  return MIGRATED_QUANTITY_COLUMNS.every(c => columns.includes(c));
}

/**
 * isOldSchemaJoinHeader — true iff `columns` carries a legacy quantity marker
 * (a legacy quantity/range column or a bare unit; see LEGACY_QUANTITY_COLUMNS)
 * AND is NOT already migrated. Used by the merge front-half to REFUSE a delta whose
 * recipe_ingredients_new.csv header predates the schema evolution.
 *
 * @param {string[]} columns
 * @returns {boolean}
 */
export function isOldSchemaJoinHeader(columns) {
  if (!Array.isArray(columns)) return false;
  if (isMigratedJoinHeader(columns)) return false;
  return columns.includes('quantity')
    || columns.includes('quantity_min')
    || columns.includes('quantity_max')
    || columns.includes('unit');
}

/**
 * migrateRecipeIngredientsRows — mechanical, no-LLM transform of legacy join
 * rows to the four-column shape (quick 260607-anu / CONTEXT "Migration").
 *
 * Bucketing by the OLD `unit` value:
 *   unit ∈ {g, ml}              → quantity_metric=quantity, unit_metric=unit;
 *                                 volumetric pair = ''.
 *   unit ∈ {whole,tsp,tbsp,cup} → quantity_volumetric=quantity,
 *                                 unit_volumetric=unit; metric pair = ''.
 *   else (blank / out-of-enum)  → all four new cells = ''. The out-of-enum unit
 *                                 is NEVER coerced into unit_volumetric (locked
 *                                 enum); raw_text preserves the original amount.
 * The legacy range-column values are DROPPED (preserved via raw_text).
 *
 * Header: the legacy quantity-column run (see LEGACY_QUANTITY_COLUMNS, wherever
 * each appears) is REPLACED IN PLACE by the four migrated columns, preserving the
 * position of the first legacy column and every other column by name. (Defensive
 * to legacy headers that omit one of the four legacy columns — only the present
 * ones are removed; the four migrated columns slot in at the first legacy index.)
 *
 * @param {Array<object>} rows — parsed legacy join rows (string cells).
 * @param {string[]} oldColumns — the legacy disk header (column order).
 * @returns {{ newColumns: string[], newRows: Array<object>, report: Array<object> }}
 */
export function migrateRecipeIngredientsRows(rows, oldColumns) {
  // Build newColumns: walk oldColumns; at the FIRST legacy quantity column,
  // splice in the four migrated columns; drop every legacy quantity column.
  const newColumns = [];
  let inserted = false;
  for (const col of oldColumns) {
    if (LEGACY_QUANTITY_COLUMNS.includes(col)) {
      if (!inserted) {
        for (const mc of MIGRATED_QUANTITY_COLUMNS) newColumns.push(mc);
        inserted = true;
      }
      // drop the legacy column itself
      continue;
    }
    newColumns.push(col);
  }
  // If the legacy header somehow lacked all four legacy columns, append the
  // migrated columns at the end so the contract still holds.
  if (!inserted) {
    for (const mc of MIGRATED_QUANTITY_COLUMNS) newColumns.push(mc);
  }

  const report = [];
  const newRows = (rows || []).map(r => {
    const out = {};
    // Copy every non-legacy-quantity column verbatim.
    for (const col of oldColumns) {
      if (LEGACY_QUANTITY_COLUMNS.includes(col)) continue;
      out[col] = r[col] != null ? r[col] : '';
    }
    // Bucket by the OLD unit value.
    const oldUnit = (r.unit != null ? String(r.unit) : '').trim();
    const oldQty = r.quantity != null ? String(r.quantity) : '';
    let quantity_metric = '';
    let unit_metric = '';
    let quantity_volumetric = '';
    let unit_volumetric = '';
    if (METRIC_UNITS.includes(oldUnit)) {
      quantity_metric = oldQty;
      unit_metric = oldUnit;
    } else if (VOLUMETRIC_UNITS.includes(oldUnit)) {
      quantity_volumetric = oldQty;
      unit_volumetric = oldUnit;
    }
    // else: blank / out-of-enum → all four stay '' (raw_text keeps the original).
    out.quantity_metric = quantity_metric;
    out.unit_metric = unit_metric;
    out.quantity_volumetric = quantity_volumetric;
    out.unit_volumetric = unit_volumetric;

    // Report EVERY row whose quantity_metric ended empty so the user can
    // backfill the metric estimate later.
    if (quantity_metric === '') {
      report.push({
        recipe_id: r.recipe_id != null ? r.recipe_id : '',
        line_order: r.line_order != null ? r.line_order : '',
        ingredient_name: r.ingredient_name != null ? r.ingredient_name : '',
        old_unit: oldUnit,
        old_quantity: oldQty,
        reason: VOLUMETRIC_UNITS.includes(oldUnit) ? 'volumetric-only' : 'unrecognized-unit'
      });
    }
    return out;
  });

  return { newColumns, newRows, report };
}

// ----------------------------------------------------------------------------
// quick 260607-c65 — ingredients.csv shopping_unit pure helpers (no I/O, no
// Alpine/DOM). This is locked-schema evolution #2: the live ingredients.csv
// master gains a `shopping_unit` enum column ({metric, whole}) that tells
// downstream shopping-list generation whether to aggregate the metric amount
// (g/ml) or the whole-count, per ingredient.
//
// These mirror the 260607-anu join-file helpers above, with ONE structural
// difference: this migration is ADDITIVE. anu REPLACED a legacy column run in
// place; c65 APPENDS a single new column at the end of the header and BACKFILLS
// every existing row with the default value 'metric' (CONTEXT user-lock:
// "writes shopping_unit=metric for ALL 235 existing master rows", NO LLM pass,
// NO review table — so migrateIngredientsRows returns NO report).
// ----------------------------------------------------------------------------

// Locked enum kept local so merge.js stays import-free of schema.js (same
// reason METRIC_UNITS / VOLUMETRIC_UNITS above are local).
const SHOPPING_UNIT_ENUM = ['metric', 'whole'];
const SHOPPING_UNIT_DEFAULT = 'metric';

/**
 * isMigratedIngredientsHeader — true iff `columns` includes 'shopping_unit'.
 * This is BOTH the migration idempotency lock (refuse to add the column twice)
 * and the merge "this ingredients delta is already on the new schema" detector.
 *
 * @param {string[]} columns
 * @returns {boolean}
 */
export function isMigratedIngredientsHeader(columns) {
  return Array.isArray(columns) && columns.includes('shopping_unit');
}

/**
 * isCategorizedIngredientsHeader — true iff `columns` includes 'scale_category'
 * (quick 260612-esy / Phase B). This is the SECOND, INDEPENDENT additive-column
 * gate for the ingredients master. DO NOT fold it into isMigratedIngredientsHeader
 * (which stays shopping_unit-only — the shopping_unit precedent must not shift).
 * The ingredients migration's combined "fully migrated" predicate is
 * `isMigratedIngredientsHeader(cols) && isCategorizedIngredientsHeader(cols)` so a
 * file that already has shopping_unit but lacks scale_category is NOT treated as
 * already-migrated and still gains the scale_category column.
 *
 * @param {string[]} columns
 * @returns {boolean}
 */
export function isCategorizedIngredientsHeader(columns) {
  return Array.isArray(columns) && columns.includes('scale_category');
}

/**
 * isStapleTaggedIngredientsHeader — true iff `columns` includes 'pantry_staple'
 * (quick 260614-eqa). This is the THIRD, INDEPENDENT additive-column gate for the
 * ingredients master. DO NOT fold it into isMigratedIngredientsHeader (shopping_unit)
 * or isCategorizedIngredientsHeader (scale_category) — each gate stays single-column.
 * The ingredients migration's combined "fully migrated" predicate is
 * `isMigratedIngredientsHeader(cols) && isCategorizedIngredientsHeader(cols) &&
 * isStapleTaggedIngredientsHeader(cols)` so a file that already carries shopping_unit
 * + scale_category but LACKS pantry_staple is NOT treated as already-migrated and
 * still gains the pantry_staple column.
 *
 * @param {string[]} columns
 * @returns {boolean}
 */
export function isStapleTaggedIngredientsHeader(columns) {
  return Array.isArray(columns) && columns.includes('pantry_staple');
}

/**
 * isSectionTaggedIngredientsHeader — true iff `columns` includes 'pantry_section'
 * (quick 260615-e1n). This is the FOURTH, INDEPENDENT additive-column gate for the
 * ingredients master. DO NOT fold it into isMigratedIngredientsHeader (shopping_unit),
 * isCategorizedIngredientsHeader (scale_category), or isStapleTaggedIngredientsHeader
 * (pantry_staple) — each gate stays single-column. The ingredients migration's combined
 * "fully migrated" predicate is now
 * `isMigratedIngredientsHeader(cols) && isCategorizedIngredientsHeader(cols) &&
 * isStapleTaggedIngredientsHeader(cols) && isSectionTaggedIngredientsHeader(cols)` so a
 * file that already carries shopping_unit + scale_category + pantry_staple but LACKS
 * pantry_section is NOT treated as already-migrated and still gains the pantry_section
 * column.
 *
 * @param {string[]} columns
 * @returns {boolean}
 */
export function isSectionTaggedIngredientsHeader(columns) {
  return Array.isArray(columns) && columns.includes('pantry_section');
}

/**
 * isPackUnitsTaggedIngredientsHeader — true iff `columns` includes 'pack_units'
 * (quick 260615-kid). This is the FIFTH, INDEPENDENT additive-column gate for the
 * ingredients master. DO NOT fold it into isMigratedIngredientsHeader (shopping_unit),
 * isCategorizedIngredientsHeader (scale_category), isStapleTaggedIngredientsHeader
 * (pantry_staple), or isSectionTaggedIngredientsHeader (pantry_section) — each gate
 * stays single-column. pack_units + pack_unit_label ride the SAME Migrate pass but
 * this single gate (keyed on pack_units) drives the migration-needed lighting / the
 * combined isMigratedFn AND-in; the label column is appended alongside in the same
 * pass. A file that already carries the prior four columns but LACKS pack_units is NOT
 * treated as already-migrated and still gains both pack_units and pack_unit_label.
 *
 * @param {string[]} columns
 * @returns {boolean}
 */
export function isPackUnitsTaggedIngredientsHeader(columns) {
  return Array.isArray(columns) && columns.includes('pack_units');
}

/**
 * isRegularTaggedIngredientsHeader — true iff `columns` includes 'regular'
 * (phase 08 / REG-01). This is the SIXTH, INDEPENDENT additive-column gate for the
 * ingredients master. DO NOT fold it into isMigratedIngredientsHeader (shopping_unit),
 * isCategorizedIngredientsHeader (scale_category), isStapleTaggedIngredientsHeader
 * (pantry_staple), isSectionTaggedIngredientsHeader (pantry_section), or
 * isPackUnitsTaggedIngredientsHeader (pack_units) — each gate stays single-column.
 * regular + regular_qty_per_person ride the SAME Migrate pass but this single gate
 * (keyed on regular) drives the migration-needed lighting / the combined isMigratedFn
 * AND-in; the rate column is appended alongside in the same pass. A file that already
 * carries the prior five columns but LACKS regular is NOT treated as already-migrated
 * and still gains both regular and regular_qty_per_person.
 *
 * @param {string[]} columns
 * @returns {boolean}
 */
export function isRegularTaggedIngredientsHeader(columns) {
  return Array.isArray(columns) && columns.includes('regular');
}

/**
 * isOldSchemaIngredientsHeader — true iff `columns` is a non-empty array that
 * looks like an ingredients header (carries the master primary key
 * 'ingredient_id') AND is NOT already migrated. Unlike the join file there is
 * no legacy quantity marker to key off; an ingredients header is "old" iff it
 * has the master's primary key but lacks shopping_unit.
 *
 * @param {string[]} columns
 * @returns {boolean}
 */
export function isOldSchemaIngredientsHeader(columns) {
  if (!Array.isArray(columns) || columns.length === 0) return false;
  if (isMigratedIngredientsHeader(columns)) return false;
  return columns.includes('ingredient_id');
}

/**
 * migrateIngredientsRows — mechanical, no-LLM, ADDITIVE backfill of the live
 * ingredients.csv master to carry shopping_unit (quick 260607-c65 / CONTEXT
 * "Backfill (default metric)"). Every row gets a value (default 'metric'),
 * nothing is left empty, so there is NO report (contrast anu, which reported
 * empty-metric rows for later backfill).
 *
 *   newColumns: a COPY of oldColumns with 'shopping_unit' APPENDED at the end
 *               if not already present (additive — nothing is spliced/replaced;
 *               contrast anu's legacy column-run REPLACEMENT).
 *   newRows:    each input row copied verbatim (every oldColumns cell), then
 *               out.shopping_unit = 'metric' for ALL rows unconditionally
 *               (CONTEXT user-lock).
 *
 * @param {Array<object>} rows — parsed ingredients master rows (string cells).
 * @param {string[]} oldColumns — the legacy ingredients header (column order).
 * @returns {{ newColumns: string[], newRows: Array<object> }}
 */
export function migrateIngredientsRows(rows, oldColumns) {
  const cols = Array.isArray(oldColumns) ? oldColumns : [];
  // PER-COLUMN idempotent (quick 260612-esy): only ADD a column when it is ABSENT
  // from oldColumns. A file already carrying shopping_unit but lacking
  // scale_category gains ONLY scale_category, and vice versa — never both blindly.
  const hadShoppingUnit = cols.includes('shopping_unit');
  const hadScaleCategory = cols.includes('scale_category');
  const hadPantryStaple = cols.includes('pantry_staple');
  const hadPantrySection = cols.includes('pantry_section');
  // quick 260615-kid: TWO additive columns added in ONE Migrate pass (pack_units +
  // pack_unit_label), each per-column idempotent (only ADD when ABSENT).
  const hadPackUnits = cols.includes('pack_units');
  const hadPackUnitLabel = cols.includes('pack_unit_label');
  // phase 08 / REG-01: TWO additive columns added in ONE Migrate pass (regular +
  // regular_qty_per_person), each per-column idempotent (only ADD when ABSENT).
  const hadRegular = cols.includes('regular');
  const hadRegularRate = cols.includes('regular_qty_per_person');
  const newColumns = cols.slice();
  if (!hadShoppingUnit) newColumns.push('shopping_unit');
  if (!hadScaleCategory) newColumns.push('scale_category');
  if (!hadPantryStaple) newColumns.push('pantry_staple');
  if (!hadPantrySection) newColumns.push('pantry_section');
  if (!hadPackUnits) newColumns.push('pack_units');
  if (!hadPackUnitLabel) newColumns.push('pack_unit_label');
  if (!hadRegular) newColumns.push('regular');
  if (!hadRegularRate) newColumns.push('regular_qty_per_person');

  const newRows = (rows || []).map(r => {
    const out = {};
    // Copy every original column cell verbatim.
    for (const col of cols) {
      out[col] = r[col] != null ? r[col] : '';
    }
    // shopping_unit backfill: default 'metric' (user-lock) ONLY when the column
    // was ABSENT. When it already existed, the verbatim copy above preserved the
    // real cell — NEVER clobber an existing shopping_unit (data-safety / T-esy-01).
    if (!hadShoppingUnit) {
      out.shopping_unit = SHOPPING_UNIT_DEFAULT;
    }
    // scale_category backfill: name-heuristic guess (master rows have no
    // unit/role; the name is the only signal) ONLY when the column was ABSENT.
    // An existing scale_category cell is preserved verbatim — never re-backfilled
    // or clobbered (idempotent on re-run; T-esy-01).
    if (!hadScaleCategory) {
      out.scale_category = classifyIngredientCategory({ ingredient_name: r.ingredient_name });
    }
    // pantry_staple backfill (quick 260614-eqa): BLANK, NO heuristic (contrast
    // scale_category's classifyIngredientCategory). blank = not a staple = default
    // (USER-LOCK) — the user opts ingredients in by hand in Manage Ingredients.
    // Backfill '' ONLY when the column was ABSENT; an existing pantry_staple cell is
    // preserved by the verbatim copy above and NEVER clobbered (idempotent; T-eqa-01).
    if (!hadPantryStaple) {
      out.pantry_staple = '';
    }
    // pantry_section backfill (quick 260615-e1n): BLANK, NO heuristic (exactly like
    // pantry_staple). blank = Unsorted = default — the user tags ingredients to a
    // curated storage location by hand in Manage Ingredients. Backfill '' ONLY when the
    // column was ABSENT; an existing pantry_section cell is preserved by the verbatim
    // copy above and NEVER clobbered (idempotent on re-run; T-e1n-01).
    if (!hadPantrySection) {
      out.pantry_section = '';
    }
    // pack_units + pack_unit_label backfill (quick 260615-kid): BLANK, NO heuristic
    // (exactly like pantry_staple / pantry_section). blank pack_units = behaves as
    // today (no multipack sub-unit display); the user tags multipack ingredients by
    // hand in Manage Ingredients. Backfill '' ONLY when the column was ABSENT; an
    // existing cell is preserved by the verbatim copy above and NEVER clobbered
    // (per-column idempotent on re-run; T-kid-01).
    if (!hadPackUnits) {
      out.pack_units = '';
    }
    if (!hadPackUnitLabel) {
      out.pack_unit_label = '';
    }
    // regular + regular_qty_per_person backfill (phase 08 / REG-01): BLANK, NO heuristic
    // (exactly like pantry_staple / pantry_section / pack_units). blank regular = not a
    // regular = default (opt-in membership); blank rate = no rate set = graceful (D-04).
    // The user tags regular ingredients + sets a per-person rate by hand in Manage
    // Ingredients. Backfill '' ONLY when the column was ABSENT; an existing cell is
    // preserved by the verbatim copy above and NEVER clobbered (per-column idempotent
    // on re-run; T-08-01).
    if (!hadRegular) {
      out.regular = '';
    }
    if (!hadRegularRate) {
      out.regular_qty_per_person = '';
    }
    return out;
  });

  return { newColumns, newRows };
}

/**
 * isShoppingUnitValue — true iff `v` is a member of the locked enum. Keeps the
 * enum's single source of truth in merge.js; consumed by the app.js add-new
 * delta-writer clamps (submitAddNew / toIngredientCsvRow).
 *
 * @param {*} v
 * @returns {boolean}
 */
export function isShoppingUnitValue(v) {
  return SHOPPING_UNIT_ENUM.includes(v);
}

// ----------------------------------------------------------------------------
// detectCsvConventions — the load-bearing primitive (RESEARCH §CSV Convention
// Audit). Used by the append seam AND the verify step. The user's real CSVs are
// NOT uniform: recipes/join use CRLF, the ingredients sample uses LF, the join
// file carries a UTF-8 BOM, and trailing-newline state varies and is often
// absent. Probe each live file at runtime — NEVER assume.
//
//   hasBOM         — file.text() decodes UTF-8 and exposes a leading BOM as
//                    U+FEFF (charCode 0xFEFF).
//   newline        — the TRUE row terminator (CRLF or LF), detected via
//                    PapaParse's own linebreak detection so embedded newlines
//                    inside quoted multiline fields do NOT skew it (see the
//                    2026-06-08 debug-fix note in the function body).
//   endsWithNewline— whether the existing content already ends in \r\n or \n.
// ----------------------------------------------------------------------------
export function detectCsvConventions(text) {
  const hasBOM = text.charCodeAt(0) === 0xFEFF;
  // 2026-06-08 debug-fix (merge-rowcount-off-by-one): detect the TRUE row
  // terminator, not the dominant newline BYTE. The previous code counted every
  // \r\n vs every lone \n across the whole text — including the many bare-LF
  // newlines embedded INSIDE quoted multiline fields (instructions_20,
  // ingredients_20, prep, notes). On a real v2 recipes.csv those embedded LFs
  // vastly outnumber the CRLF row terminators (observed: ~2722 LF vs ~112 CRLF),
  // so the byte-count picked newline='\n'. appendLiveCsv then unparsed the
  // appended rows joined by \n, but verifyAppend re-parses with PapaParse, which
  // auto-detects \r\n from the CRLF-terminated existing rows — so the \n-joined
  // appended rows glued into one row → off-by-one row-count verify failure
  // (the guard correctly refused to commit corrupted data).
  // Fix: derive the row terminator from PapaParse's OWN linebreak detection —
  // the SAME engine + the SAME auto-detection verifyAppend uses on re-parse —
  // so the unparse body separator and the verify parse always agree. PapaParse
  // detects the line terminator OUTSIDE quoted fields, so embedded \n no longer
  // skews it. Fall back to the legacy byte-count heuristic only if PapaParse
  // reports no linebreak (e.g. a single-line / header-only file).
  let newline;
  const meta = Papa.parse(text, { preview: 2 }).meta;
  if (meta && (meta.linebreak === '\r\n' || meta.linebreak === '\n')) {
    newline = meta.linebreak;
  } else {
    const crlf = (text.match(/\r\n/g) || []).length;
    const lfOnly = (text.match(/(?<!\r)\n/g) || []).length;
    newline = crlf >= lfOnly ? '\r\n' : '\n';
  }
  const endsWithNewline = /\r?\n$/.test(text);
  return { hasBOM, newline, endsWithNewline };
}
