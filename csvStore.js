// ============================================================================
// Mise — csvStore.js (quick 260612-abt / Task 1)
// ----------------------------------------------------------------------------
// THE persistence substrate. Re-architecture: the tool no longer binds to a
// File System Access folder handle. Instead the user imports the 3 v2 CSVs once,
// they live in IndexedDB (object store `csvFiles` keyed by filename), and an
// Export-CSVs control serializes them back out byte-faithfully. A browser-data
// clear wipes the store — that durability tradeoff is accepted and mitigated by
// Export (see DECISIONS.md 2026-06-12).
//
// IMPORT SEAM (why the pure helpers take an injected `Papa`):
//   serializeCsv / parseCsv / verifyRoundTrip are PURE — no IndexedDB, no DOM,
//   no globals. They accept PapaParse as an argument so the BROWSER passes the
//   `Papa` global app.js already imports, and the NODE test (scripts/csvstore.
//   test.mjs) passes a tiny PapaParse-shaped stub. This keeps the (de)serialize
//   + verify-comparison logic Node-testable with ZERO CDN/npm dependency —
//   exactly the dependency-free precedent set by scale.js + scale.test.mjs.
//   IndexedDB itself does NOT run in Node, so the impure methods (openStore /
//   getFile / putFile / hasAnyFile) are exercised only in-browser (Playwright).
//
// DATA-SAFETY (the user's REAL recipe data): every putFile is
//   snapshot -> write -> re-read + re-parse + verify (row-count + header
//   integrity) -> AUTOMATIC in-band REVERT to the snapshot on verify failure.
//   The revert is automatic — there is NO user-triggered restore step. On a
//   forced verify failure the store ends holding the SNAPSHOT (no corruption,
//   no partial). The verify reason strings are copied VERBATIM from app.js's
//   _rewriteIngredientsInPlace so the existing informational banner copy is
//   unchanged; the thrown error carries `.isRestoreOfferSentinel = true` to
//   match what app.js catch blocks already key on.
//
// BOM handling — use the escape `"\uFEFF"`, NEVER a literal byte. The newline
//   is derived from PapaParse's own `meta.linebreak` (NOT a byte count across
//   the file — a byte count miscounts embedded bare-LF newlines inside quoted
//   multiline v2 fields; see the 2026-06-08 merge-rowcount-off-by-one debug
//   note in merge.js detectCsvConventions).
// ============================================================================

// The files the store holds. STORE_FILES is the canonical ITERATION list — the
// sync funnels (probe / pull PASS-2 write / export / server-import) walk it, so
// adding a name here makes the generic paths pick the file up for free.
//
// REQUIRED-vs-OPTIONAL split (Phase 16 / D41 + 16-RESEARCH Pitfall 1):
// `residents_allergens.csv` is the 4th, mise-OWNED, ADDITIVE file. It is NOT
// part of the locked v2 3-CSV contract and is legitimately ABSENT on any shared
// repo seeded by a pre-Phase-16 (3-file) client. Therefore the empty/partial/full
// REPO-SHAPE classification + the first-run import prompt MUST run over the 3
// REQUIRED recipe CSVs ONLY — never over STORE_FILES.length (4). A 404 on the 4th
// file is a first-class "optional-absent → seed locally" state, never PARTIAL and
// never an error. See app.js _probeRemoteShape / pullFromRemote / importCsvs / the
// seedStatus copy, all of which classify over REQUIRED_STORE_FILES.
export const REQUIRED_STORE_FILES = ['recipes.csv', 'ingredients.csv', 'recipe_ingredients.csv'];
export const STORE_FILES = ['recipes.csv', 'ingredients.csv', 'recipe_ingredients.csv', 'residents_allergens.csv'];

// Phase 17 (D-15) — the two GitHub-synced JSON artifacts (shared meal plan +
// Coda roster snapshot). They ride the SAME `csvFiles` IndexedDB store keyed by
// filename (exactly like a CSV), but are NOT CSVs: they store/verify JSON, so
// they are deliberately KEPT OUT of both STORE_FILES (which routes every entry
// through the CSV parseCsv+putFile PASS-2 write loop in pullFromRemote — wrong
// for JSON) AND REQUIRED_STORE_FILES (the empty/partial/full shape-counting set).
// A 404 on either file is a first-class "optional-absent → seed empty/local"
// state, never PARTIAL and never an error — a pre-Phase-17 repo with NO JSON
// files MUST classify 'full', not 'partial' (D-15, SPEC acceptance #7). They are
// probed/pulled on their OWN JSON path (app.js), never via the CSV machinery.
//
// quick 260712-i1y adds settings.json as the 4th safe-rail optional JSON artifact
// (synced kitchen-global settings on the PER-KEY LWW rail). Same discipline: absent
// = seed empty/local (defaults), never PARTIAL and never an error. It is EXPLICITLY
// NOT the fragile meal_plan.json 3-way merge — it rides the whole-file LWW transport
// like suppliers.json / residents_roster.json, just with a per-key merge inside.
//
// Phase 25 (D-03) adds classifications.json as the 5th safe-rail optional JSON
// artifact — the synced, in-app-editable cuisine/protein controlled vocabulary
// (closed enum, DSAFE-02). Same discipline: absent = seed the approved DEFAULT_VOCAB
// locally, never PARTIAL and never an error (a repo predating the file classifies
// 'full', per classifyRemoteShape over REQUIRED_STORE_FILES only). It rides the
// whole-file LWW transport like suppliers.json / residents_roster.json — NOT the
// fragile meal_plan.json 3-way merge (DSAFE-01 preserved).
export const OPTIONAL_JSON_FILES = ['meal_plan.json', 'residents_roster.json', 'suppliers.json', 'settings.json', 'classifications.json'];

const DB_NAME = 'recipe_ingest';
const STORE_NAME = 'csvFiles';
// v1->v2 (Phase 07): adds the codaRoster store (resident-roster slice) alongside
// the existing csvFiles store. csvStore.js is the SINGLE owner of DB_VERSION +
// onupgradeneeded — residents.js must NEVER call indexedDB.open itself (two opens
// of the same DB at different versions triggers a VersionError).
const DB_VERSION = 2;
const ROSTER_STORE = 'codaRoster';

// ----------------------------------------------------------------------------
// PURE HELPERS (Node-testable; inject Papa)
// ----------------------------------------------------------------------------

/**
 * classifyRemoteShape — PURE repo-shape classifier (Phase 16 / D41 + 16-RESEARCH
 * Pitfall 1). Given the count of ABSENT REQUIRED recipe CSVs (the optional 4th
 * file's absence is NOT included in this count — see _probeRemoteShape), decide
 * the remote shape that drives the pull/connect branch:
 *
 *   - 'empty'   — ALL required recipe CSVs absent (a seedable empty repo).
 *   - 'partial' — SOME (1..n-1) required recipe CSVs absent (incomplete → read-only).
 *   - 'full'    — ZERO required recipe CSVs absent (a complete, writable repo).
 *
 * THE backward-compat invariant: because the optional 4th file is excluded from
 * `requiredAbsentCount` upstream, a repo holding all 3 recipe CSVs and NO
 * residents_allergens.csv yields requiredAbsentCount === 0 → 'full' — never
 * 'partial'/read-only. This is the function sync-backcompat.test.mjs pins, and the
 * one pullFromRemote / saveConnection branch over.
 *
 * @param {number} requiredAbsentCount — count of absent REQUIRED_STORE_FILES
 * @returns {'empty'|'partial'|'full'}
 */
export function classifyRemoteShape(requiredAbsentCount) {
  if (requiredAbsentCount === REQUIRED_STORE_FILES.length) return 'empty';
  if (requiredAbsentCount > 0) return 'partial';
  return 'full';
}

/**
 * serializeCsv — turn a structured record back into CSV text. Preserves column
 * ORDER (via `columns`), the BOM (prepend "\uFEFF" iff hasBOM), and the detected
 * newline. PapaParse stays the serializer.
 *
 * @param {{columns: string[], rows: Array<object>}} record
 * @param {{hasBOM: boolean, newline: string}} conventions
 * @param {object} Papa — injected PapaParse (browser global / Node stub)
 * @returns {string}
 */
export function serializeCsv({ columns, rows }, { hasBOM, newline }, Papa) {
  const body = Papa.unparse(rows, { columns, header: true, newline });
  return (hasBOM ? '\uFEFF' : '') + body;
}

/**
 * parseCsv — parse CSV text into the structured record shape the store holds
 * and consumers expect ({columns, rows}), plus the conventions needed to write
 * it back byte-faithfully (hasBOM, newline).
 *
 * newline is derived from PapaParse's meta.linebreak (the SAME engine the verify
 * re-parse uses), with a byte-count fallback ONLY when PapaParse reports no
 * linebreak (a single-line / header-only file). This mirrors merge.js
 * detectCsvConventions and avoids the embedded-bare-LF miscount.
 *
 * @param {string} text
 * @param {object} Papa — injected PapaParse
 * @returns {{columns: string[], rows: Array<object>, hasBOM: boolean, newline: string}}
 */
export function parseCsv(text, Papa) {
  const hasBOM = text.charCodeAt(0) === 0xFEFF;
  const result = Papa.parse(text, { header: true, skipEmptyLines: true, dynamicTyping: false });
  const meta = result.meta || {};
  let newline;
  if (meta.linebreak === '\r\n' || meta.linebreak === '\n') {
    newline = meta.linebreak;
  } else {
    const crlf = (text.match(/\r\n/g) || []).length;
    const lfOnly = (text.match(/(?<!\r)\n/g) || []).length;
    newline = crlf >= lfOnly ? '\r\n' : '\n';
  }
  return {
    columns: meta.fields || [],
    rows: Array.isArray(result.data) ? result.data : [],
    hasBOM,
    newline
  };
}

/**
 * verifyRoundTrip — the post-write data-safety comparison (PURE; no I/O). ok iff
 * the re-parsed record has the expected row count AND a header that deep-equals
 * the expected columns (same length + every field index matches) AND, if a
 * headerCheckFn is supplied (a migration gate), it returns true.
 *
 * The `reason` strings mirror _rewriteIngredientsInPlace VERBATIM so the
 * informational banner copy is unchanged.
 *
 * @param {object} opts
 * @param {Array<object>} opts.expectedRows — the rows we wrote (count source)
 * @param {string[]} opts.expectedColumns — the header we wrote (order source)
 * @param {{rows: Array<object>, columns: string[]}} opts.reparsed — read-back
 * @param {(cols:string[])=>boolean} [opts.headerCheckFn]
 * @param {string} [opts.filename] — for the reason string (default 'the file')
 * @returns {{ok: boolean, reason: string|null}}
 */
export function verifyRoundTrip({ expectedRows, expectedColumns, reparsed, headerCheckFn, filename }) {
  const name = filename || 'the file';
  const reRows = Array.isArray(reparsed.rows) ? reparsed.rows : [];
  const reCols = Array.isArray(reparsed.columns) ? reparsed.columns : [];
  const fieldsMatch = reCols.length === expectedColumns.length
    && reCols.every((f, idx) => f === expectedColumns[idx]);
  const headerGateOk = headerCheckFn ? !!headerCheckFn(reCols) : true;

  if (reRows.length !== expectedRows.length) {
    return {
      ok: false,
      reason: `After saving, ${name} had ${reRows.length} rows but should have ${expectedRows.length}. The save was stopped so your file can be restored.`
    };
  }
  if (!fieldsMatch || !headerGateOk) {
    return {
      ok: false,
      reason: `After saving, the columns in ${name} didn't read back as expected. The save was stopped so your file can be restored.`
    };
  }
  return { ok: true, reason: null };
}

// ----------------------------------------------------------------------------
// IMPURE — IndexedDB (browser only; verified via Playwright at the checkpoint)
// ----------------------------------------------------------------------------

/**
 * openStore — open (creating on first run) the IndexedDB database. Idempotent:
 * safe to call repeatedly; resolves to the same db. The object store `csvFiles`
 * is keyed by filename; each record is the structured shape
 * {name, columns, rows, hasBOM, newline}.
 *
 * @returns {Promise<IDBDatabase>}
 */
export function openStore() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // csvFiles create is idempotent (guarded) — a v1->v2 upgrade keeps the
      // user's existing recipe data untouched.
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'name' });
      }
      // codaRoster: the resident-roster cache (Phase 07), keyed by table name
      // ('residency' | 'onboarding'). Sibling store — does NOT disturb csvFiles.
      if (!db.objectStoreNames.contains(ROSTER_STORE)) {
        db.createObjectStore(ROSTER_STORE, { keyPath: 'name' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // If another tab triggers a later version upgrade, close this connection
      // so that upgrade is not blocked (prevents a `blocked` hang). RESEARCH §2d.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    // A second mise tab holding an old-version connection open blocks the v2
    // upgrade — surface a clear "close other tabs" message rather than hanging.
    req.onblocked = () => reject(new Error('Database upgrade blocked — close other Mise tabs and reload.'));
  });
}

// Small promise wrapper for a single object-store transaction.
// HARDCODED to STORE_NAME ('csvFiles'): this feeds putFile's snapshot/verify/
// revert recipe data-safety path (hasAnyFile / getFile / rawPut / rawDelete),
// which has NO IndexedDB-level automated guard. Do NOT generalise it to take a
// store name — the roster slice uses the sibling txStore() below instead.
function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_NAME, mode);
    const store = t.objectStore(STORE_NAME);
    let result;
    const r = fn(store);
    if (r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/**
 * txStore — sibling of tx() that takes an explicit `storeName`. Used ONLY by the
 * resident-roster cache (residents.js putRosterTable / getRosterTable on the
 * 'codaRoster' store). Kept SEPARATE from tx() so the recipe data-safety path
 * (tx + its csvFiles call sites) stays byte-unchanged — that path is unguarded
 * at the IndexedDB level (residents.test.mjs is Node-only and never opens real
 * IndexedDB), so generalising tx itself would be an unguarded edit to it.
 *
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore) => IDBRequest|void} fn
 * @returns {Promise<*>}
 */
export function txStore(db, storeName, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    let result;
    const r = fn(store);
    if (r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/**
 * hasAnyFile — true iff at least one of the 3 REQUIRED recipe CSVs exists in the
 * store. Drives the first-run import prompt vs auto-load decision.
 *
 * Phase 16: scoped to REQUIRED_STORE_FILES (NOT STORE_FILES) so a store holding
 * ONLY the optional 4th file (`residents_allergens.csv`, seeded/synced before any
 * recipe import) still reads as first-run — the 4th file alone is NOT "has files".
 *
 * @returns {Promise<boolean>}
 */
export async function hasAnyFile() {
  const db = await openStore();
  const keys = await tx(db, 'readonly', store => store.getAllKeys());
  const set = new Set(keys || []);
  return REQUIRED_STORE_FILES.some(f => set.has(f));
}

/**
 * getFile — read one stored record (already structured), or null if absent. The
 * returned shape is {columns, rows, hasBOM, newline} — `.rows` / `.columns` are
 * exactly what the FSA readCsvFromHandle consumers expect.
 *
 * @param {string} name
 * @returns {Promise<{columns:string[], rows:Array<object>, hasBOM:boolean, newline:string} | null>}
 */
export async function getFile(name) {
  const db = await openStore();
  const rec = await tx(db, 'readonly', store => store.get(name));
  if (!rec) return null;
  return {
    columns: rec.columns || [],
    rows: rec.rows || [],
    hasBOM: !!rec.hasBOM,
    newline: rec.newline || '\r\n',
    // Additive (Phase 10 / SYNC-01): the GitHub blob sha + fetch time that rode
    // alongside the bytes. `undefined` on legacy / never-synced records — the 36
    // pure-read render sites simply ignore the extra key.
    meta: rec.meta
  };
}

// Internal raw put/delete used by putFile's write + revert.
function rawPut(db, record) {
  return tx(db, 'readwrite', store => store.put(record));
}
function rawDelete(db, name) {
  return tx(db, 'readwrite', store => store.delete(name));
}

/**
 * putFile — THE data-safety write. snapshot -> write -> re-read + re-parse +
 * verify -> AUTOMATIC in-band REVERT on failure.
 *
 *   (1) SNAPSHOT: read the current record (may be null).
 *   (2) WRITE the new record.
 *   (3) Re-read it back, serialize -> parse round-trip the written record, run
 *       verifyRoundTrip (row-count + header deep-equal + optional headerCheckFn).
 *   (4) On failure: AUTOMATICALLY REVERT — put the snapshot back (or delete if
 *       the snapshot was null), then throw a tagged isRestoreOfferSentinel Error
 *       carrying the verify reason. The revert is in-band and automatic — the
 *       caller does NOT need a separate restore step. On a forced-failure the
 *       store ends holding the snapshot.
 *
 * @param {string} name — filename key (e.g. 'ingredients.csv')
 * @param {{columns:string[], rows:Array<object>, hasBOM:boolean, newline:string}} record
 * @param {object} opts
 * @param {object} opts.Papa — injected PapaParse (browser global)
 * @param {(cols:string[])=>boolean} [opts.headerCheckFn] — optional migration gate
 * @returns {Promise<void>}
 */
export async function putFile(name, record, { Papa, headerCheckFn } = {}) {
  const db = await openStore();

  // (1) SNAPSHOT the prior version (may be null = the file didn't exist).
  const snapshot = await tx(db, 'readonly', store => store.get(name));

  const newRecord = {
    name,
    columns: record.columns || [],
    rows: record.rows || [],
    hasBOM: !!record.hasBOM,
    newline: record.newline || '\r\n',
    // Additive (Phase 10 / SYNC-01): persist meta:{sha,fetchedAt} ONLY when the
    // caller supplies it (a remote pull). Kept ABSENT otherwise (never written as
    // `meta: undefined`) so legacy / manual-import records stay "never synced".
    // CRITICAL: `meta` is a plain extra property on the stored value — it MUST
    // NOT enter the serializeCsv call below, so the byte-faithfulness verify
    // round-trip (and its auto-revert gate) is unaffected. No DB_VERSION bump:
    // IndexedDB stores arbitrary object shapes and `meta` is not an index.
    ...(record.meta !== undefined ? { meta: record.meta } : {})
  };

  // (2) WRITE the new record.
  await rawPut(db, newRecord);

  // (3) Re-read + round-trip-verify. We serialize the just-written record and
  //     re-parse it through the SAME PapaParse engine, then compare against what
  //     we intended to write (row count + header order + optional gate).
  const readBack = await tx(db, 'readonly', store => store.get(name));
  const text = serializeCsv(
    { columns: readBack.columns, rows: readBack.rows },
    { hasBOM: readBack.hasBOM, newline: readBack.newline },
    Papa
  );
  const reparsed = parseCsv(text, Papa);
  const { ok, reason } = verifyRoundTrip({
    expectedRows: newRecord.rows,
    expectedColumns: newRecord.columns,
    reparsed,
    headerCheckFn,
    filename: name
  });

  // (4) AUTOMATIC in-band REVERT on failure.
  if (!ok) {
    if (snapshot) {
      await rawPut(db, snapshot);
    } else {
      await rawDelete(db, name);
    }
    const sentinel = new Error(reason);
    sentinel.isRestoreOfferSentinel = true;
    throw sentinel;
  }
}

/**
 * getJsonFile — read one stored JSON record, or null if absent. Sibling of
 * getFile for the two OPTIONAL_JSON_FILES (Phase 17). The stored shape is
 * {name, json, meta} — `meta:{sha,fetchedAt}` rides alongside the value exactly
 * like getFile's meta (the GitHub blob sha + fetch time), `undefined` until the
 * file has been pulled. JSON has no columns/rows/BOM/newline — those CSV-only
 * keys are absent on a JSON record.
 *
 * @param {string} name — filename key (e.g. 'meal_plan.json')
 * @returns {Promise<{json:*, meta:*} | null>}
 */
export async function getJsonFile(name) {
  const db = await openStore();
  const rec = await tx(db, 'readonly', store => store.get(name));
  if (!rec) return null;
  return { json: rec.json, meta: rec.meta };
}

/**
 * putJsonFile — THE JSON data-safety write (Phase 17 / D-11, D-12). A PARALLEL
 * sibling of putFile that mirrors its four steps — snapshot -> write -> re-read +
 * verify -> AUTOMATIC in-band REVERT on failure — but stores/verifies JSON
 * instead of CSV. putFile (the proven recipe-CSV path, SENSITIVE-tier) is left
 * UNTOUCHED: this is a separate function reusing only the low-level primitives
 * (openStore / tx / rawPut / rawDelete), exactly as the in-module comment on tx
 * requires (do NOT generalize tx).
 *
 *   (1) SNAPSHOT the prior record (may be null = the file didn't exist).
 *   (2) WRITE the new {name, json, meta?} record.
 *   (3) Re-read it back; verify = a JSON round-trip (JSON.parse(JSON.stringify))
 *       AND shapeCheck(parsed) === true. A structurally-wrong-but-valid-JSON blob
 *       (e.g. {} with no entries) FAILS shapeCheck and is reverted — it must NOT
 *       blank the stored value (D-12).
 *   (4) On failure: AUTOMATICALLY REVERT — put the snapshot back (or delete if the
 *       snapshot was null, mirroring putFile's rawDelete branch), then throw a
 *       tagged isRestoreOfferSentinel Error. The reason copy mirrors putFile's so
 *       the existing app.js auto-revert banner reads consistently.
 *
 * JSON has no columns/rows/BOM/newline, so it is NOT routed through
 * serializeCsv/parseCsv/verifyRoundTrip — those are CSV-specific.
 *
 * @param {string} name — filename key (e.g. 'meal_plan.json')
 * @param {*} jsonValue — the value to store (must be JSON-serializable)
 * @param {object} opts
 * @param {(parsed:*)=>boolean} [opts.shapeCheck] — top-level shape gate; a falsy
 *   return reverts the write (D-12). Defaults to "any valid JSON" if omitted.
 * @param {{sha:string, fetchedAt:string}} [opts.meta] — additive sync metadata,
 *   persisted ONLY when supplied (a remote pull), kept ABSENT otherwise.
 * @returns {Promise<void>}
 */
export async function putJsonFile(name, jsonValue, { shapeCheck, meta } = {}) {
  const db = await openStore();

  // Structured-clone safety: the value can arrive as an Alpine reactive Proxy
  // (the meal-plan / roster push paths derive `jsonValue` from reactive state).
  // IndexedDB cannot structured-clone a Proxy — store.put throws DataCloneError
  // ("[object Array] could not be cloned"). The value is JSON by contract, so
  // canonicalize to a plain deep copy before any IDB write. (Phase 17 live-gate fix.)
  const plainValue = JSON.parse(JSON.stringify(jsonValue));

  // (1) SNAPSHOT the prior version (may be null = the file didn't exist).
  const snapshot = await tx(db, 'readonly', store => store.get(name));

  const newRecord = {
    name,
    json: plainValue,
    // Additive: persist meta:{sha,fetchedAt} ONLY when supplied (a remote pull);
    // kept ABSENT otherwise (never written as `meta: undefined`) so a
    // lazy-created / never-synced record stays "never synced". Mirrors putFile.
    ...(meta !== undefined ? { meta } : {})
  };

  // (2) WRITE the new record.
  await rawPut(db, newRecord);

  // (3) Re-read + verify. Re-read the just-written value, prove it survives a
  //     JSON round-trip (valid JSON), then run the top-level shapeCheck (D-12).
  const readBack = await tx(db, 'readonly', store => store.get(name));
  let ok = false;
  let reason = '';
  try {
    const parsed = JSON.parse(JSON.stringify(readBack.json));
    const passesShape = typeof shapeCheck === 'function' ? shapeCheck(parsed) === true : true;
    if (!passesShape) {
      reason = `The save to ${name} did not match the expected structure. The save was stopped so your file can be restored.`;
    } else {
      ok = true;
    }
  } catch (_e) {
    reason = `The save to ${name} could not be re-read as valid JSON. The save was stopped so your file can be restored.`;
  }

  // (4) AUTOMATIC in-band REVERT on failure.
  if (!ok) {
    if (snapshot) {
      await rawPut(db, snapshot);
    } else {
      await rawDelete(db, name);
    }
    const sentinel = new Error(reason);
    sentinel.isRestoreOfferSentinel = true;
    throw sentinel;
  }
}
