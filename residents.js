// ============================================================================
// Mise — residents.js (Phase 07 / live resident data from Coda roster sync)
// ----------------------------------------------------------------------------
// THE resident-roster slice. This is SEPARATE from the recipe v2-CSV slice:
// it does NOT touch csvFiles / deriveSessionStateFromCsvs / csvStoreLoaded
// (CONTEXT data-isolation LOCKED). It holds the live Coda Residency + Onboarding
// roster, decoded into flat records, joined, and queried for "who is present on
// date D" + their onboarding-derived allergy/skill info.
//
// PURE seam (why the helpers take injected deps): normalizeCodaRows / joinRoster /
//   isPresentOnDate / residentsPresentOnDate / detectChainedOverlap are PURE —
//   no network, no IndexedDB, no DOM, no globals. fetchCodaTable takes an injected
//   `fetchImpl` (defaults to the browser `fetch`) so the NODE test
//   (scripts/residents.test.mjs) drives it with a tiny fetch STUB and ZERO network.
//   This keeps ALL load-bearing logic (the EXACT present-on-D rule, the APPID
//   join, the timezone-safe date compare, the Coda-envelope decode + pagination)
//   Node-testable — the dependency-free precedent set by csvStore.js + scale.js.
//
// ROSTER CACHE (not the recipe data-safety path): the roster is a RE-FETCHABLE
//   cache of an external source. putRosterTable therefore writes with a PLAIN
//   IndexedDB put — NO snapshot/verify/revert ceremony (that is exclusively the
//   recipe csvFiles path's putFile). The absence of that ceremony here is
//   DELIBERATE (a stale/lost roster is re-fetched, never silently corrupting the
//   user's irreplaceable recipe data). It uses a NEW sibling txStore() on
//   csvStore.js so the recipe data-safety tx() path stays byte-unchanged.
//
// TOKEN DISCIPLINE: the Coda PAT is PII-bearing. fetchCodaTable uses it ONLY in
//   the Authorization header and NEVER concatenates it into a returned value or a
//   thrown message (mirrors app.js apiKey discipline). The Node test asserts the
//   token is absent from outputs.
// ============================================================================

import { openStore, txStore } from './csvStore.js';
// Phase 16 (D39) — the closed FSA-14 vocab. Imported HERE (schema.js is a sibling
// ES module) so the seed suggestion + curated-tag read re-impose canonical order
// via FSA14.filter — the helpers NEVER invent an off-vocab tag.
import { FSA14 } from './schema.js';

// The two Coda tables this slice reads (also the keyPath values in codaRoster).
export const ROSTER_TABLES = ['residency', 'onboarding'];

// Phase 16 (D41) — the canonical column set/order of the 4th file
// residents_allergens.csv (16-RESEARCH §column set). NOT part of the locked v2
// contract; the seed helper uses it as the default header for a fresh file.
export const RESIDENT_ALLERGEN_COLUMNS = [
  'appid', 'full_name', 'allergies_raw', 'allergies_detail', 'fsa14_allergens', 'reviewed', 'notes'
];

// Centralised Coda column DISPLAY-NAME strings — the ACTUAL live keys returned
// under useColumnNames=true (07-LIVE-PROBE-FINDINGS, 2026-06-20 + same-day
// re-probe). A Coda-side rename is then a one-line fix here.
//
// residency `Type` is a scalar string enum re-added by the re-probe — it is
// carried through AS-IS (no fixed-enum validation; live values include
// "Volunteer", which is NOT in the contract enum). `room_display_label` is still
// ABSENT from the export — do NOT reference it.
export const CODA_FIELDS = {
  residency: {
    fullName: 'Full name',
    email: 'Email',
    type: 'Type',
    roles: 'Roles',
    checkIn: 'Check in',
    checkOut: 'Check out',
    awayFrom: 'Away from',
    awayUntil: 'Away until',
    appid: 'APPID',
    parentId: 'Parent ID',
    childId: 'Child ID'
  },
  onboarding: {
    appId: 'App id',
    allergies: 'Allergies dietary requirements',
    allergiesDetail: 'Allergies additional details',
    skill: 'How would you rate your cooking skills',
    fullName: 'Full name'
  }
};

// ----------------------------------------------------------------------------
// PURE HELPERS (Node-testable; zero deps; inject fetchImpl where network needed)
// ----------------------------------------------------------------------------

// unwrap1 — Coda lookup columns come back as array[1] under simpleWithArrays.
// Unwrap a single-element array to its scalar; pass scalars through untouched.
// Defends against array OR scalar so callers never need to know which they got.
function unwrap1(v) {
  if (Array.isArray(v)) return v.length ? v[0] : '';
  return v;
}

/**
 * codaDate — extract the timezone-safe YYYY-MM-DD calendar date from a Coda DATE
 * cell. Coda returns full ISO-8601 datetimes WITH the doc's tz offset, e.g.
 * "2024-11-17T00:00:00.000+00:00". We SLICE the first 10 chars and string-compare
 * downstream — we do NOT `new Date()` (that re-localises to the host TZ and can
 * shift the calendar day, an off-by-one). Live blanks come back as the empty
 * STRING "" (NOT null) — treat both null and "" as "no date" (null).
 *
 * @param {*} v
 * @returns {string|null} YYYY-MM-DD or null
 */
export function codaDate(v) {
  if (v == null || String(v).trim() === '') return null;
  // timezone-safe: slice the YYYY-MM-DD prefix and string-compare; do NOT
  // new Date() — Coda returns ISO-8601 with the doc's tz offset
  // (07-LIVE-PROBE-FINDINGS: 'Check in'='2024-11-17T00:00:00.000+00:00').
  return String(v).slice(0, 10);
}

/**
 * normalizeCodaRows — decode the live Coda row envelope (each item is
 * `{ values: { <columnName>: value } }` under useColumnNames=true) into flat
 * records keyed by the SAME column-name strings. Residency values are scalars
 * (Roles is a real array, APPID a number, Type a plain string carried as-is).
 * Onboarding values are all array[1] (Coda lookup columns) and are UNWRAPPED to
 * scalars so downstream code sees plain values regardless of source table.
 *
 * @param {Array<{values: object}>} apiItems
 * @returns {Array<object>} flat records
 */
export function normalizeCodaRows(apiItems) {
  if (!Array.isArray(apiItems)) return [];
  return apiItems.map(item => {
    const values = (item && item.values) || {};
    const out = {};
    for (const key of Object.keys(values)) {
      const v = values[key];
      // Roles is a genuine multi-value array — keep it. Everything else that is
      // an array[1] (the lookup-column shape) is unwrapped to a scalar. A scalar
      // passes through untouched.
      if (key === CODA_FIELDS.residency.roles && Array.isArray(v)) {
        out[key] = v;
      } else {
        out[key] = unwrap1(v);
      }
    }
    return out;
  });
}

/**
 * isPresentOnDate — the EXACT present-on-date-D rule (07-LIVE-PROBE-FINDINGS):
 *   inStay = checkIn <= D && D < checkOut   (Check out EXCLUSIVE => strict <)
 *   away   = awayFrom != null && awayUntil != null && awayFrom <= D && D <= awayUntil
 *            (Away window INCLUSIVE both ends)
 *   present = inStay && !away   (and false if check in/out absent — defensive)
 * All comparisons are on YYYY-MM-DD string prefixes (codaDate) — lexicographic
 * order on a zero-padded ISO date IS calendar order, so string-compare is correct
 * and timezone-safe.
 *
 * @param {object} row — a residency (or joined) record
 * @param {string} D — YYYY-MM-DD target date
 * @returns {boolean}
 */
export function isPresentOnDate(row, D) {
  if (!row || !D) return false;
  const F = CODA_FIELDS.residency;
  const checkIn = codaDate(row[F.checkIn]);
  const checkOut = codaDate(row[F.checkOut]);
  if (checkIn == null || checkOut == null) return false; // defensive: incomplete stay

  const inStay = checkIn <= D && D < checkOut; // Check out EXCLUSIVE
  if (!inStay) return false;

  const awayFrom = codaDate(row[F.awayFrom]);
  const awayUntil = codaDate(row[F.awayUntil]);
  const away = awayFrom != null && awayUntil != null && awayFrom <= D && D <= awayUntil; // INCLUSIVE both ends
  return !away;
}

/**
 * joinRoster — join residency rows to onboarding rows on
 * `residency.APPID === onboarding["App id"]` AFTER unwrapping App id[0] AND
 * coercing BOTH sides to the same type (trimmed string). A raw `===` of int-vs-
 * array (or int-vs-string) gives ZERO matches (verified live: naive=0, correct=
 * 15/42). BOTH the unwrap AND the coercion are required.
 *
 * Returns ONE row per residency record. A residency with no matching onboarding
 * gets `onboarding: null` + `allergiesKnown: false` — the EXPLICIT UNKNOWN state
 * (the MAJORITY live: 27/42), NEVER an empty/"safe" allergy value. Orphan
 * onboarding rows (matching no residency — live: 1) are DROPPED, never crashed on
 * and never surfaced as residents.
 *
 * The raw allergy free-text + additional details + cooking skill are carried
 * THROUGH the join unmodified (allergen normalisation is a later-slice seam;
 * raw allergy strings are not surfaced — CONTEXT deferred + caveats).
 *
 * @param {Array<object>} residencyRows — normalised residency records
 * @param {Array<object>} onboardingRows — normalised onboarding records
 * @returns {Array<object>} joined records (residency fields + onboarding + allergiesKnown)
 */
export function joinRoster(residencyRows, onboardingRows) {
  const RF = CODA_FIELDS.residency;
  const OF = CODA_FIELDS.onboarding;
  const res = Array.isArray(residencyRows) ? residencyRows : [];
  const onb = Array.isArray(onboardingRows) ? onboardingRows : [];

  // Index onboarding by the coerced+unwrapped App id key.
  const onboardingByAppId = new Map();
  for (const o of onb) {
    // normalizeCodaRows already unwrapped App id to a scalar, but defend against
    // a raw array too (so joinRoster is correct on un-normalised input as well).
    const key = String(unwrap1(o[OF.appId])).trim();
    if (key !== '' && !onboardingByAppId.has(key)) onboardingByAppId.set(key, o);
  }

  return res.map(r => {
    // coerce residency APPID (int) to the SAME type as the onboarding key
    // (string). naive `APPID === App id` (int vs array/string) => 0 matches.
    const key = String(unwrap1(r[RF.appid])).trim();
    const onboarding = key !== '' ? (onboardingByAppId.get(key) || null) : null;
    return {
      ...r,
      onboarding,
      allergiesKnown: onboarding != null // explicit UNKNOWN when no onboarding
    };
  });
}

/**
 * residentsPresentOnDate — filter joined rows to those present on D, returning
 * the present list + a count equal to the number of ROWS present (fork 4: count
 * rows, not people).
 *
 * @param {Array<object>} joined — joinRoster output
 * @param {string} D — YYYY-MM-DD
 * @returns {{present: Array<object>, count: number}}
 */
export function residentsPresentOnDate(joined, D) {
  const rows = Array.isArray(joined) ? joined : [];
  const present = rows.filter(r => isPresentOnDate(r, D));
  return { present, count: present.length };
}

/**
 * detectChainedOverlap — dev-only signal: returns truthy iff two roster rows are
 * linked by a shared Parent ID / Child ID AND are BOTH present on D (a chained
 * stay that overlaps). Used later for a dev-only console.warn; not a hard error.
 *
 * @param {Array<object>} rows — joined rows
 * @param {string} D — YYYY-MM-DD
 * @returns {boolean}
 */
export function detectChainedOverlap(rows, D) {
  const RF = CODA_FIELDS.residency;
  const list = Array.isArray(rows) ? rows : [];
  const present = list.filter(r => isPresentOnDate(r, D));
  // Collect every non-blank link id appearing across Parent ID / Child ID of the
  // present rows; an overlap is a link value shared by 2+ present rows.
  const linkCounts = new Map();
  for (const r of present) {
    const links = new Set();
    const p = String(r[RF.parentId] ?? '').trim();
    const c = String(r[RF.childId] ?? '').trim();
    if (p !== '') links.add(p);
    if (c !== '') links.add(c);
    for (const l of links) linkCounts.set(l, (linkCounts.get(l) || 0) + 1);
  }
  for (const count of linkCounts.values()) {
    if (count >= 2) return true;
  }
  return false;
}

// ----------------------------------------------------------------------------
// Phase 16 (D39/D40) — PURE resident-allergen seed + classify helpers.
//   BOTH are zero-I/O (no await, no putFile/getFile, no DOM, no `this`) so the
//   Node test (scripts/residents.test.mjs) proves the two SAFETY-CRITICAL seams
//   without IndexedDB or Coda. The app.js caller owns ALL I/O (read current rows,
//   putFile, push, DOM) and INJECTS the keyword-match suggestion (findKeywordHits
//   stays in app.js — these helpers never import it). The APPID key is derived via
//   the SAME `String(unwrap1(...)).trim()` coercion joinRoster uses — never a raw
//   APPID compare (an int-vs-array/string === gives ZERO matches, verified live).
// ----------------------------------------------------------------------------

/**
 * seedResidentAllergens — PURE insert-if-absent (D40, never re-clobber). Given the
 * joined roster, the CURRENT 4th-file rows, and a suggestFn that maps raw allergy
 * text → an array of FSA-14 tags (the caller wraps findKeywordHits), return ONLY
 * the NEW rows to append — one per joined APPID that has NO existing row.
 *
 * Existing rows (their text OR tags) are NEVER touched: a curated/reviewed record
 * survives every subsequent roster refresh (D40 / 16-RESEARCH Pitfall 5). A joined
 * row with a blank/missing APPID is skipped (no empty-key row). Seeded rows carry
 * `reviewed: ''` (blank) — seeded is DISTINCT from reviewed (the null-vs-empty
 * marker): a machine guess is never authoritative until a human confirms it.
 *
 * @param {Array<object>} joinedRoster — joinRoster output (residency + onboarding)
 * @param {Array<object>} existingRows — the current residents_allergens.csv rows
 * @param {(rawText:string)=>string[]} suggestFn — injected FSA-14 keyword matcher
 * @returns {Array<object>} the rows to ADD (empty array when nothing new)
 */
export function seedResidentAllergens(joinedRoster, existingRows, suggestFn) {
  const RF = CODA_FIELDS.residency;
  const OF = CODA_FIELDS.onboarding;
  const joined = Array.isArray(joinedRoster) ? joinedRoster : [];
  const existing = Array.isArray(existingRows) ? existingRows : [];
  const suggest = typeof suggestFn === 'function' ? suggestFn : () => [];

  // Index the known APPIDs via the SAME coercion the join uses (never raw compare).
  const known = new Set();
  for (const r of existing) {
    const k = String(unwrap1(r && r.appid)).trim();
    if (k !== '') known.add(k);
  }

  const newRows = [];
  // De-dupe within a single seed pass too (two residency rows sharing one APPID
  // must not seed twice) — mirrors joinRoster's "first wins" indexing.
  const seenThisPass = new Set();
  for (const jr of joined) {
    const appid = String(unwrap1(jr && jr[RF.appid])).trim();
    if (appid === '' || known.has(appid) || seenThisPass.has(appid)) continue;
    seenThisPass.add(appid);
    const onb = (jr && jr.onboarding) || null;
    const raw = ((onb && onb[OF.allergies]) || '').toString().trim();
    const detail = ((onb && onb[OF.allergiesDetail]) || '').toString();
    const suggested = Array.isArray(suggest(raw)) ? suggest(raw) : [];
    // Re-impose canonical FSA-14 order; never invent an off-vocab tag.
    const tags = FSA14.filter(a => suggested.includes(a));
    newRows.push({
      appid,
      full_name: (jr && jr[RF.fullName]) || '',
      allergies_raw: raw,
      allergies_detail: detail,
      fsa14_allergens: tags.join(';'),
      reviewed: '',   // seeded, NOT reviewed (the null-vs-empty marker — D40)
      notes: ''
    });
  }
  return newRows;
}

/**
 * classifyResidentAllergens — PURE per-resident allergen-conflict classifier (D40
 * tri-state, SAFETY-CRITICAL). Returns a discriminated contribution the caller
 * folds into dayAllergenStatus's accumulators. The classifier NEVER matches text
 * itself — the caller passes `keywordTags` (FSA-14 array from findKeywordHits) AND
 * a `rawNonEmpty` flag so the helper can distinguish "non-empty text, zero hits"
 * (→ unmatched) from "blank text" (→ clear/contributes nothing). The
 * allergiesKnown===false UNKNOWN short-circuit stays OWNED BY THE CALLER (it is not
 * reached here — the caller pushes unknown before calling).
 *
 * Tri-state (a seeded-but-NOT-reviewed record may NEVER read "clear" on a machine
 * guess — it falls back to raw-text keyword behaviour; keyword hits still RAISE a
 * conflict, failing toward warning):
 *   • record present + reviewed===true + curated tags NON-EMPTY → conflict-check the
 *     CURATED tags against dayAllergens → {kind:'conflict', allergens:[...]} else
 *     {kind:'clear'}.
 *   • record present + reviewed===true + curated tags EMPTY → reviewed-empty →
 *     {kind:'clear'} (contributes no allergens — the ONLY way to read clear).
 *   • record absent OR reviewed===false (seeded-not-reviewed) → FALL BACK to
 *     keywordTags: keywordTags empty AND rawNonEmpty → {kind:'unmatched'};
 *     keywordTags intersect dayAllergens → {kind:'conflict'}; else {kind:'clear'}.
 *
 * @param {{reviewed:boolean, fsa14:string[]}|null} curatedRecord — parsed 4th-file row or null
 * @param {string[]} keywordTags — FSA-14 tags the caller derived from the raw text
 * @param {Set<string>} dayAllergens — the day's planned FSA-14 allergens
 * @param {boolean} [rawNonEmpty=false] — was the resident's raw allergy text non-empty?
 * @returns {{kind:'conflict', allergens:string[]} | {kind:'unmatched'} | {kind:'clear'}}
 */
export function classifyResidentAllergens(curatedRecord, keywordTags, dayAllergens, rawNonEmpty = false) {
  const day = dayAllergens instanceof Set ? dayAllergens : new Set(Array.isArray(dayAllergens) ? dayAllergens : []);
  const kw = Array.isArray(keywordTags) ? keywordTags : [];

  // REVIEWED record (D40): curated tags are AUTHORITATIVE.
  if (curatedRecord && curatedRecord.reviewed === true) {
    const curated = Array.isArray(curatedRecord.fsa14) ? curatedRecord.fsa14 : [];
    if (curated.length === 0) return { kind: 'clear' };   // reviewed-empty → no allergens
    const hits = FSA14.filter(a => curated.includes(a) && day.has(a));
    if (hits.length > 0) return { kind: 'conflict', allergens: hits };
    return { kind: 'clear' };
  }

  // ABSENT or seeded-not-reviewed → keyword fallback (never "clear" on a guess).
  if (kw.length === 0) {
    // Non-empty text the matcher couldn't classify → review manually (NEVER "no allergens").
    return rawNonEmpty ? { kind: 'unmatched' } : { kind: 'clear' };
  }
  const hits = FSA14.filter(a => kw.includes(a) && day.has(a));
  if (hits.length > 0) return { kind: 'conflict', allergens: hits };
  return { kind: 'clear' };
}

// ----------------------------------------------------------------------------
// IMPURE — network (injected-fetch testable) / IndexedDB (browser only)
// ----------------------------------------------------------------------------

/**
 * fetchCodaTable — fetch ALL rows of a Coda table, decoding the live envelope
 * `{ href, items, nextSyncToken }` (and following `nextPageToken`/`nextPageLink`
 * pagination IF present — at live scale there is none, so this is a single page).
 *
 * IMPORTANT: do NOT loop on `nextSyncToken` — that is a SYNC cursor, not a
 * pagination token; looping on it would never terminate. Only follow an explicit
 * page token.
 *
 * The token is used ONLY in the Authorization header and is NEVER concatenated
 * into the returned value or a thrown message.
 *
 * @param {{token: string, docId: string, tableId: string}} config
 * @param {typeof fetch} [fetchImpl=fetch] — injected for Node testing
 * @returns {Promise<Array<{values: object}>>} all raw Coda items (decode with normalizeCodaRows)
 */
export async function fetchCodaTable({ token, docId, tableId }, fetchImpl = fetch) {
  const base = `https://coda.io/apis/v1/docs/${encodeURIComponent(docId)}/tables/${encodeURIComponent(tableId)}/rows`;
  const headers = { 'Authorization': `Bearer ${token}` };
  const items = [];

  let url = `${base}?useColumnNames=true&valueFormat=simpleWithArrays&limit=200`;
  // Loop ONLY while a page token / link is present. Guard against a runaway loop.
  let guard = 0;
  while (url && guard < 1000) {
    guard += 1;
    const resp = await fetchImpl(url, { headers });
    if (!resp.ok) {
      // status only — NEVER the token (401 bad token, 404 wrong id, 429 rate limit)
      throw new Error(`Coda fetch failed: HTTP ${resp.status}`);
    }
    const body = await resp.json();
    if (Array.isArray(body.items)) items.push(...body.items);

    // Pagination: follow an explicit page token/link ONLY. Coda returns a full
    // nextPageLink when more pages exist; some shapes give nextPageToken. NEVER
    // follow nextSyncToken (a sync cursor, not pagination).
    if (body.nextPageLink) {
      url = body.nextPageLink;
    } else if (body.nextPageToken) {
      url = `${base}?useColumnNames=true&valueFormat=simpleWithArrays&limit=200&pageToken=${encodeURIComponent(body.nextPageToken)}`;
    } else {
      url = null;
    }
  }
  return items;
}

/**
 * putRosterTable — PLAIN cache write of one roster table into the codaRoster
 * IndexedDB store. NO snapshot/verify/revert (that is exclusively the recipe
 * csvFiles putFile path) — the roster is a re-fetchable external cache. Reuses
 * csvStore.openStore + the sibling txStore so the recipe data-safety tx() path
 * is untouched (never a second indexedDB.open of recipe_ingest).
 *
 * @param {string} name — one of ROSTER_TABLES ('residency' | 'onboarding')
 * @param {{rows: Array<object>, fetchedAt?: string}} record
 * @returns {Promise<void>}
 */
export async function putRosterTable(name, record) {
  const db = await openStore();
  const stored = {
    name,
    rows: (record && record.rows) || [],
    fetchedAt: (record && record.fetchedAt) || new Date().toISOString()
  };
  await txStore(db, 'codaRoster', 'readwrite', store => store.put(stored));
}

/**
 * getRosterTable — read one cached roster table, or null if absent.
 *
 * @param {string} name — one of ROSTER_TABLES
 * @returns {Promise<{name:string, rows:Array<object>, fetchedAt:string}|null>}
 */
export async function getRosterTable(name) {
  const db = await openStore();
  const rec = await txStore(db, 'codaRoster', 'readonly', store => store.get(name));
  return rec || null;
}
