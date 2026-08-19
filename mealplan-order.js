// ============================================================================
// Mise — mealplan-order.js (quick 260819-d92)
// ----------------------------------------------------------------------------
// PURE, TOTAL, BROWSER-FREE display ordering for ONE meal-plan day's dishes.
//
// The operator reads a day card top-to-bottom to see what the meal IS. Before
// this module the dish rows appeared in the order they were ADDED, so a Salad
// could head a day and the Main sit under a Side. These two functions are the
// whole policy:
//
//   orderDayEntriesByType — the fixed render order
//                           Main -> Side -> Salad -> other non-blank -> blank
//   startsDayTypeGroup    — whether the dish at an index in that ORDERED array
//                           begins a new typegroup run (the F7 uppercase label)
//
// LOCKED POLICY (user decision — do not revisit):
//   - order is Main, then Side, then Salad, then everything else, blank LAST
//   - classification is STRICT EXACT MATCH on the trimmed, lower-cased type
//   - stable within a type (dishes keep their insertion order)
//   - multiple dishes of a type and ZERO dishes of a type are both fine
//   - nothing is deduped, dropped, added or renamed
//
// PLANNER DISCRETION (recorded here so it is reviewable): the locked decision
// does not specify the INTERNAL order of the "everything else" bucket. This
// module sub-groups it by FIRST APPEARANCE of the normalised type, so an
// interleaved Component / Salad Dressing / Component day renders as
// Component, Component, Salad Dressing. That is what makes the
// one-label-per-type invariant hold UNIVERSALLY — without it the same day
// renders three labels, two of them adjacent COMPONENTs. It preserves
// insertion order WITHIN each type, so it does not weaken the locked
// stability rule.
//
// DIVERGENCE FROM cook-artifact.js (deliberate, and worth knowing about).
// `orderEntriesByType` there implements the Cook-sheet's D-07 order and is a
// CASE-INSENSITIVE SUBSTRING match that sorts any unrecognised non-blank type
// (e.g. 'Component') into the MAIN bucket FIRST. This module is STRICT exact
// match — matching the convention already encoded in app.js's dayTypeSummary,
// where 'Salad Dressing' and 'Component' both fall to Other. So under D-07 a
// 'Salad Dressing' cooks as a salad and a 'Component' leads the sheet, whereas
// on the day card both sort into the other-bucket after the salads.
//   DEFERRED FOLLOW-UP: the day-card order and the Cook-sheet D-07 order are
//   now two different policies. The user may want them reconciled; that is a
//   separate task, and this module must NOT import, call or edit
//   cook-artifact.js in the meantime.
//
// DISPLAY-ONLY. This module reaches no storage and no sync: it takes an array
// of entries and returns a NEW array of THE SAME REFERENCES. Stored and synced
// order are untouched — there is no write path here at all. The same-reference
// guarantee is load-bearing rather than cosmetic: the markup mutates entries in
// place (`entry.collapsed = !entry.collapsed`, the servings `x-model`, the
// per-dish note), so a clone would send the operator's edits to a throwaway
// object — they would appear to work, then vanish. Asserted by T7/T7b/T8 in
// scripts/mealplan-order.test.mjs.
//
// ----------------------------------------------------------------------------
// THIS MODULE MUST NEVER GROW AN IMPORT.
// Zero imports, no DOM, no Alpine, no app state, no I/O — the same shape as
// scale.js / cook-artifact.js / chat-turns.js. It exists as its own module
// precisely so the ordering policy gets a REAL behavioural node gate
// (scripts/mealplan-order.test.mjs) instead of a source-slicing harness.
// ============================================================================

/** The named buckets, in render order. Anything else non-blank sorts after. */
const BUCKET_MAIN = 0;
const BUCKET_SIDE = 1;
const BUCKET_SALAD = 2;
const BUCKET_OTHER = 3;
const BUCKET_BLANK = 4;

/**
 * normaliseType — the ONE normalisation both exported functions share.
 *
 * Trimmed + lower-cased, and total: a missing entry, a missing `type` key, a
 * null/undefined/numeric type all normalise to '' (blank). The user's live
 * recipes.csv holds lowercase `main` and `salad` alongside the capitalised
 * ones, and the label CSS applies `text-transform: uppercase` — so a
 * case-SENSITIVE comparison would render TWO adjacent "MAIN" labels.
 *
 * @param {*} entry
 * @returns {string} '' for blank/whitespace-only/absent, else the normal form
 */
function normaliseType(entry) {
  return String((entry && entry.type) || '').trim().toLowerCase();
}

/**
 * bucketOf — STRICT exact match, no substring test (see the divergence note).
 *
 * @param {string} normalisedType
 * @returns {number} BUCKET_MAIN | BUCKET_SIDE | BUCKET_SALAD | BUCKET_OTHER | BUCKET_BLANK
 */
function bucketOf(normalisedType) {
  if (normalisedType === '') return BUCKET_BLANK;
  if (normalisedType === 'main') return BUCKET_MAIN;
  if (normalisedType === 'side') return BUCKET_SIDE;
  if (normalisedType === 'salad') return BUCKET_SALAD;
  return BUCKET_OTHER;
}

/**
 * orderDayEntriesByType(entries) — the day card's fixed dish order.
 *
 * Returns a NEW array holding THE SAME entry references in the order
 * Main -> Side -> Salad -> other non-blank -> blank. Within the other-bucket,
 * dishes of the same normalised type are contiguous, ordered by when that type
 * FIRST appeared in the input (the planner-discretion note above). Within any
 * one type, insertion order is preserved.
 *
 * The sort key is (bucket, first-appearance index of the normalised type,
 * original index), decorated onto each entry and stripped after — so the
 * tie-break is EXPLICIT rather than leaning on engine sort stability (the
 * house technique, mirroring cook-artifact.js).
 *
 * Total: a non-array input returns []. Never mutates its input. Never clones,
 * drops, dedupes, adds or renames an entry.
 *
 * @param {Array<{type?: string}>} entries a day's entries, in insertion order
 * @returns {Array} a NEW array of the SAME entries in fixed type order
 */
export function orderDayEntriesByType(entries) {
  const list = Array.isArray(entries) ? entries : [];
  // First appearance of each normalised type, so the other-bucket groups.
  const firstSeen = new Map();
  list.forEach((entry, index) => {
    const type = normaliseType(entry);
    if (!firstSeen.has(type)) firstSeen.set(type, index);
  });
  return list
    .map((entry, index) => {
      const type = normaliseType(entry);
      return { entry, index, bucket: bucketOf(type), first: firstSeen.get(type) };
    })
    .sort((a, b) => (a.bucket - b.bucket) || (a.first - b.first) || (a.index - b.index))
    .map((decorated) => decorated.entry);
}

/**
 * startsDayTypeGroup(entries, index) — the F7 typegroup-label break test.
 *
 * Takes the UNORDERED entries plus an index into the ORDERED array, and orders
 * internally. That is deliberate: it makes it STRUCTURALLY IMPOSSIBLE for the
 * label test and the render loop to disagree about the order. The old markup
 * was one edit away from exactly that bug — it compared against the previous
 * entry of the unordered array while the loop could iterate something else.
 *
 * Returns true only for the FIRST dish of each non-blank normalised-type run,
 * so exactly ONE label renders per distinct type per day (a day holding both
 * `Main` and lowercase `main` shows ONE "MAIN"). Blank-typed dishes are never
 * labelled.
 *
 * Total: a missing entry, an out-of-range / non-integer index, or a non-array
 * `entries` all return false rather than throwing.
 *
 * @param {Array<{type?: string}>} entries the UNORDERED day entries
 * @param {number} index an index into orderDayEntriesByType(entries)
 * @returns {boolean} true when this dish begins a new typegroup run
 */
export function startsDayTypeGroup(entries, index) {
  if (!Array.isArray(entries) || !Number.isInteger(index) || index < 0) return false;
  const ordered = orderDayEntriesByType(entries);
  if (index >= ordered.length) return false;
  const type = normaliseType(ordered[index]);
  if (type === '') return false;          // blank-typed dishes carry no label
  if (index === 0) return true;           // the first ORDERED dish always heads its run
  return normaliseType(ordered[index - 1]) !== type;
}
