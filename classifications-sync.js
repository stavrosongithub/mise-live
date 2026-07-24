// ===========================================================================
// classifications-sync.js  (Phase 25 / D-03, D-14 — recipe cuisine/protein vocab)
// ===========================================================================
// The PURE half of the classification-vocabulary sync. app.js holds the impure
// wiring (the _pushVocab LWW push hook mirroring _pushSuppliers, the
// putJsonFile/ghPutFile transport + the 409 re-read-overwrite, the pull-reflect
// into this.cuisineVocab / this.proteinVocab). This module owns ONLY the vocab
// DATA SHAPE + the fail-open coercion so it is Node-testable in isolation —
// exactly mirroring how suppliers-sync.js owns the suppliers list shape and
// roster-sync.js owns the roster snapshot shape.
//
// No Alpine, no IndexedDB, no network: pure data-in / data-out.
//
// The vocab is the closed controlled cuisine/protein enum (D-01) that drives the
// vocabulary-discipline control (DSAFE-02: the LLM cannot invent values), the
// editor multi-selects (Plan 03), the parse schema (Plan 04), the backfill
// (Plan 05) and the filters (Plan 06). It rides the OPTIONAL_JSON_FILES LWW
// reference-file rails (classifications.json) — NOT mealplan-sync.js (DSAFE-01).
// ===========================================================================

/**
 * DEFAULT_VOCAB — the user-approved seed (D-14). 8 cuisine buckets + 9 protein
 * buckets covering the real (entirely plant-based, D-16) recipe corpus. Blank =
 * "no significant protein / no specific cuisine" — there is deliberately NO
 * "None" enum value. The file is in-app editable afterward (the vocab-manager
 * panel), so this is only the seed installed when classifications.json is absent.
 * @type {{ cuisines: string[], proteins: string[] }}
 */
export const DEFAULT_VOCAB = {
  cuisines: [
    'Italian',
    'Indian/S.Asian',
    'East Asian',
    'SE Asian',
    'Middle-Eastern/Med',
    'Mexican/Latin',
    'African',
    'British/European/American'
  ],
  proteins: [
    'Tofu',
    'Tempeh',
    'Soya/TVP',
    'Lentils',
    'Chickpeas',
    'Beans',
    'Peanut',
    'Tree nuts',
    'Peas'
  ]
};

/**
 * cleanStringList — internal helper. Keep ONLY non-empty trimmed unique strings
 * from an arbitrary value; anything that isn't an array yields []. Never throws.
 * @param {*} v
 * @returns {string[]}
 */
function cleanStringList(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  const seen = new Set();
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const s = item.trim();
    if (s === '' || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * coerceVocab — normalise an arbitrary parsed blob into a clean
 * { cuisines: [...], proteins: [...] }. Accepts a `{ cuisines:[], proteins:[] }`
 * object; keeps ONLY non-empty trimmed unique strings per field. FAIL-OPENS to a
 * fresh copy of DEFAULT_VOCAB on null/array/non-object/garbage input, and NEVER
 * throws — mirroring coerceSuppliers' "malformed coerces silently, never throws"
 * discipline (T-25-01: a malformed remote blob can't crash a device). A valid
 * object with an empty/malformed FIELD yields [] for that field; effectiveVocab
 * backstops empties to the defaults for lookups.
 *
 * @param {*} raw — a parsed JSON blob (object, array, or garbage)
 * @returns {{ cuisines: string[], proteins: string[] }}
 */
export function coerceVocab(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    // Fail-open to the approved defaults (a bare/garbage blob → seed vocabulary).
    return {
      cuisines: DEFAULT_VOCAB.cuisines.slice(),
      proteins: DEFAULT_VOCAB.proteins.slice()
    };
  }
  return {
    cuisines: cleanStringList(raw.cuisines),
    proteins: cleanStringList(raw.proteins)
  };
}

/**
 * effectiveVocab — resolve each field to the passed list if it is a non-empty
 * array, else the built-in DEFAULT_VOCAB field. Guarantees lookups (parse-schema
 * enum, editor options, filter options) always resolve to a usable vocabulary
 * even before classifications.json has seeded / while a field is empty —
 * mirroring effectiveSuppliers.
 *
 * @param {{cuisines?:*, proteins?:*}|null|undefined} v
 * @returns {{ cuisines: string[], proteins: string[] }}
 */
export function effectiveVocab(v) {
  const cuisines = v && Array.isArray(v.cuisines) && v.cuisines.length > 0
    ? v.cuisines
    : DEFAULT_VOCAB.cuisines;
  const proteins = v && Array.isArray(v.proteins) && v.proteins.length > 0
    ? v.proteins
    : DEFAULT_VOCAB.proteins;
  return { cuisines, proteins };
}
