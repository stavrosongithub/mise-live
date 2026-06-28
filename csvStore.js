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
