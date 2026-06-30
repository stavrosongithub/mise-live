// ===========================================================================
// suppliers-sync.js  (quick 260630-e8v — supplier-aware search)
// ===========================================================================
// The PURE half of the suppliers list sync. app.js holds the impure wiring (the
// _pushSuppliers LWW push hook mirroring _pushRosterSnapshot, the
// putJsonFile/ghPutFile transport + the 409 re-read-overwrite, the pull-reflect
// into this.suppliers). This module owns ONLY the suppliers DATA SHAPE + the
// search-URL resolution so it is Node-testable in isolation — exactly mirroring
// how roster-sync.js owns the roster snapshot shape and mealplan-sync.js owns
// projectSharedPlanDoc.
//
// No Alpine, no IndexedDB, no network: pure data-in / data-out.
//
// A "supplier" is { name, label, searchUrl } where searchUrl is a template with
// a `{q}` slot for the (URL-encoded) search query. The supplier `name` is what
// an ingredient's `supplier` CSV column carries (e.g. 'amazon', 'supermarket'),
// resolved case-insensitively to its store search.
// ===========================================================================

/**
 * DEFAULT_SUPPLIERS — the built-in set that covers the CURRENT bucket values
 * (supermarket / amazon / wholesale) so EXISTING bucket-tagged ingredients work
 * with ZERO setup before the user customises anything. The user adds/edits
 * specific named suppliers in-app (synced via suppliers.json). `{q}` is the
 * query slot buildSearchUrl substitutes with the URL-encoded search term.
 * @type {ReadonlyArray<{name:string,label:string,searchUrl:string}>}
 */
export const DEFAULT_SUPPLIERS = [
  { name: 'supermarket', label: 'Morrisons', searchUrl: 'https://groceries.morrisons.com/search?q={q}' },
  { name: 'amazon', label: 'Amazon', searchUrl: 'https://www.amazon.co.uk/s?k={q}' },
  { name: 'wholesale', label: 'wholesale (web search)', searchUrl: 'https://www.google.com/search?q={q}' }
];

/**
 * DEFAULT_SUPPLIER — the supermarket/Morrisons entry; the fallback used for a
 * blank or unmapped ingredient supplier (so blank/unknown → Morrisons).
 * @type {{name:string,label:string,searchUrl:string}}
 */
export const DEFAULT_SUPPLIER = DEFAULT_SUPPLIERS[0];

/**
 * coerceSuppliers — normalise an arbitrary parsed blob into a clean
 * { suppliers: [...] }. Accepts either a `{ suppliers: [...] }` wrapper or a
 * bare array. Keeps ONLY entries that are objects with a non-empty string
 * `name` AND a string `searchUrl`; coerces `label` to a string (defaulting to
 * the name when absent). Malformed entries are dropped silently and the helper
 * NEVER throws (fail-open to `{ suppliers: [] }`) — mirroring buildRosterSnapshot's
 * "absent coerces to empty, never throws" discipline.
 *
 * @param {*} raw — a parsed JSON blob (object, array, or garbage)
 * @returns {{ suppliers: Array<{name:string,label:string,searchUrl:string}> }}
 */
export function coerceSuppliers(raw) {
  let list;
  if (Array.isArray(raw)) list = raw;
  else if (raw && typeof raw === 'object' && Array.isArray(raw.suppliers)) list = raw.suppliers;
  else return { suppliers: [] };

  const suppliers = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    const searchUrl = typeof entry.searchUrl === 'string' ? entry.searchUrl : '';
    if (name === '' || searchUrl === '') continue;
    const label = typeof entry.label === 'string' && entry.label.trim() !== ''
      ? entry.label
      : name;
    suppliers.push({ name, label, searchUrl });
  }
  return { suppliers };
}

/**
 * effectiveSuppliers — the passed list if it is a non-empty array, else the
 * built-in DEFAULT_SUPPLIERS. Guarantees lookups always resolve even before the
 * user has customised anything (or while suppliers.json is still seeding).
 *
 * @param {Array|undefined|null} list
 * @returns {Array<{name:string,label:string,searchUrl:string}>}
 */
export function effectiveSuppliers(list) {
  return Array.isArray(list) && list.length > 0 ? list : DEFAULT_SUPPLIERS;
}

/**
 * findSupplier — the entry in `list` whose `name` matches `supplierName`
 * case-insensitively + trimmed, else null. (Does NOT fall through to a default —
 * buildSearchUrl/searchLabel own the default fallback.)
 *
 * @param {Array} list
 * @param {string} supplierName
 * @returns {{name:string,label:string,searchUrl:string}|null}
 */
export function findSupplier(list, supplierName) {
  const needle = (supplierName ?? '').toString().trim().toLowerCase();
  if (needle === '') return null;
  const arr = Array.isArray(list) ? list : [];
  for (const entry of arr) {
    if (entry && typeof entry.name === 'string' && entry.name.trim().toLowerCase() === needle) {
      return entry;
    }
  }
  return null;
}

/**
 * buildSearchUrl — resolve the ingredient's supplier to a store-search URL.
 * Resolution: findSupplier over effectiveSuppliers(list); on no match (blank or
 * unmapped supplier) fall back to DEFAULT_SUPPLIER (Morrisons). The query is
 * trimmed + URL-encoded and substituted into the entry's `{q}` slot. If a
 * user-customised template lacks `{q}`, the encoded query is appended defensively
 * so a malformed template still produces a usable search URL.
 *
 * @param {Array} list — this.suppliers (may be empty → defaults)
 * @param {string} supplierName — the ingredient's `supplier` column value
 * @param {string} query — the ingredient name to search for
 * @returns {string} a ready-to-open search URL
 */
export function buildSearchUrl(list, supplierName, query) {
  const entry = findSupplier(effectiveSuppliers(list), supplierName) || DEFAULT_SUPPLIER;
  const q = encodeURIComponent((query ?? '').toString().trim());
  const template = typeof entry.searchUrl === 'string' ? entry.searchUrl : DEFAULT_SUPPLIER.searchUrl;
  if (template.includes('{q}')) return template.split('{q}').join(q);
  return template + q; // defensive: template lacked the {q} slot
}

/**
 * searchLabel — the human label of the resolved supplier (for the dynamic
 * 'Search <label>' button text). Blank/unmapped → DEFAULT_SUPPLIER.label.
 *
 * @param {Array} list
 * @param {string} supplierName
 * @returns {string}
 */
export function searchLabel(list, supplierName) {
  const entry = findSupplier(effectiveSuppliers(list), supplierName) || DEFAULT_SUPPLIER;
  return typeof entry.label === 'string' && entry.label.trim() !== '' ? entry.label : DEFAULT_SUPPLIER.label;
}
