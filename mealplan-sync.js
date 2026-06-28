// ============================================================================
// mealplan-sync.js — Phase 17 (Plan 17-02). PURE meal-plan sync helpers.
// ----------------------------------------------------------------------------
// The shared meal plan rides a synced `meal_plan.json` document. This module
// holds the PURE, Node-testable pieces of the sync engine — no Alpine `this`,
// no IndexedDB, no network — so the merge contract (D-01..D-04) and the
// shared/local field split (SPEC #1) can be pinned by `scripts/mealplan-sync.test.mjs`
// the same way scale.js / merge.js / cook-artifact.js pure helpers are.
//
// The IMPURE wiring (read this.githubCfg, putJsonFile/getJsonFile, ghGetFile/
// ghPutFile, the debounce timer, pull-on-open) lives in app.js and calls these
// helpers; that wiring is Playwright/two-port-harness verified (the executor
// has no browser — memory `gsd-executor-lacks-playwright`).
//
// Shared doc shape (SPEC #1):
//   {
//     entries: [{ id, recipe_id, date, servings }],   // NO per-entry `collapsed` (view-state, local-only)
//     cooksByDay, dayLeftovers, prepDoneByDay,         // keyed maps (by day)
//     regularsOverrides,                               // keyed map (by ingredient_id)
//     adHocExtras,                                     // keyed map (by id) OR array — see note
//     orderScopeRange                                  // null | { startKey, endKey }
//   }
// Pure view-state (`collapsed`, `pickerCollapsed`, `dayCollapsedByDay`) is
// EXCLUDED from the shared doc and stays in localStorage (SPEC #1).
// ============================================================================

// The keyed-MAP fields merged per-key by the 3-way base rule (D-02). These are
// plain objects keyed by day-string / ingredient_id. `adHocExtras` is an array
// in the live state but is merged as an ARRAY-union below (D-03 id-union), not
// as a keyed map — it is handled separately from MAP_FIELDS.
export const SHARED_MAP_FIELDS = ['cooksByDay', 'dayLeftovers', 'prepDoneByDay', 'regularsOverrides'];

// The entry fields that ride the shared doc (NO `collapsed` — that is view-state).
export const SHARED_ENTRY_FIELDS = ['id', 'recipe_id', 'date', 'servings'];

/**
 * emptySharedPlanDoc — the safe empty default. Used as the fail-open value when a
 * persisted base is corrupt/absent, and as the "fresh remote" stand-in when
 * meal_plan.json does not yet exist (a 404 on first push, D-13).
 */
export function emptySharedPlanDoc() {
  return {
    entries: [],
    cooksByDay: {},
    dayLeftovers: {},
    prepDoneByDay: {},
    regularsOverrides: {},
    adHocExtras: [],
    orderScopeRange: null
  };
}

/**
 * projectSharedPlanDoc — PURE projection of raw plan state into the synced
 * document (SPEC #1). Prunes per-entry `collapsed` (view-state) from each entry;
 * carries only the 4 SHARED entry fields; copies the keyed maps + adHocExtras +
 * orderScopeRange. Defensive: a non-array entries / non-object map coerces to the
 * empty default for that field so a malformed live state never produces a doc
 * that fails the shapeCheck.
 *
 * @param {object} state — { mealPlan, cooksByDay, dayLeftovers, prepDoneByDay,
 *                           regularsOverrides, adHocExtras, orderScopeRange }
 * @returns {object} the shared doc
 */
export function projectSharedPlanDoc(state) {
  const s = state || {};
  const entries = (Array.isArray(s.mealPlan) ? s.mealPlan : [])
    .filter(e => e && typeof e === 'object')
    .map(e => ({
      id: e.id,
      recipe_id: e.recipe_id,
      date: typeof e.date === 'string' ? e.date : '',
      servings: e.servings
      // NB: `collapsed` is DELIBERATELY omitted — view-state stays local (SPEC #1).
    }));
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  return {
    entries,
    cooksByDay: obj(s.cooksByDay),
    dayLeftovers: obj(s.dayLeftovers),
    prepDoneByDay: obj(s.prepDoneByDay),
    regularsOverrides: obj(s.regularsOverrides),
    adHocExtras: Array.isArray(s.adHocExtras) ? s.adHocExtras : [],
    orderScopeRange: (s.orderScopeRange
      && typeof s.orderScopeRange === 'object'
      && !Array.isArray(s.orderScopeRange))
      ? s.orderScopeRange
      : null
  };
}

/**
 * coerceSharedPlanDoc — defensive normalizer used when restoring the persisted
 * 3-way base or accepting a pulled/parsed remote doc: any throw / non-object /
 * missing field falls back to the empty default for that field, so a corrupt
 * base NEVER degrades the merge into garbage (fail-open, mirrors _restoreMealPlan).
 *
 * @param {*} raw
 * @returns {object} a well-formed shared doc (empty default on corruption)
 */
export function coerceSharedPlanDoc(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptySharedPlanDoc();
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  const entries = (Array.isArray(raw.entries) ? raw.entries : [])
    .filter(e => e && typeof e === 'object' && e.id != null)
    .map(e => ({
      id: e.id,
      recipe_id: e.recipe_id,
      date: typeof e.date === 'string' ? e.date : '',
      servings: e.servings
    }));
  return {
    entries,
    cooksByDay: obj(raw.cooksByDay),
    dayLeftovers: obj(raw.dayLeftovers),
    prepDoneByDay: obj(raw.prepDoneByDay),
    regularsOverrides: obj(raw.regularsOverrides),
    adHocExtras: Array.isArray(raw.adHocExtras) ? raw.adHocExtras : [],
    orderScopeRange: (raw.orderScopeRange
      && typeof raw.orderScopeRange === 'object'
      && !Array.isArray(raw.orderScopeRange))
      ? raw.orderScopeRange
      : null
  };
}

// ---------------------------------------------------------------------------
// 3-way merge primitives (D-01..D-04).
// ---------------------------------------------------------------------------

// Stable structural equality for plain JSON values (entries / map values are
// JSON-serializable). Used to ask "did THIS side change this thing vs base?".
function jsonEq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * mergeKeyedMap — the per-key 3-way base merge (D-02), delete-wins (D-04).
 * For every key seen across base/local/remote:
 *   - present in base, absent on EITHER side  => DELETE (delete-wins, D-04)
 *   - local changed it vs base                => take local's value (local wins per key)
 *   - else if remote changed it vs base       => take remote's value
 *   - else                                    => unchanged (base value, == remote == local)
 *   - brand-new key (not in base) on a side   => keep it (union, D-03 at key level)
 *
 * @param {object} base @param {object} local @param {object} remote
 * @returns {object} merged map
 */
export function mergeKeyedMap(base, local, remote) {
  const b = base || {}, l = local || {}, r = remote || {};
  const keys = new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)]);
  const out = {};
  for (const k of keys) {
    const inBase = Object.prototype.hasOwnProperty.call(b, k);
    const inLocal = Object.prototype.hasOwnProperty.call(l, k);
    const inRemote = Object.prototype.hasOwnProperty.call(r, k);

    // Delete-wins (D-04): a key present in base but removed on EITHER side is gone.
    if (inBase && (!inLocal || !inRemote)) continue;

    if (!inBase) {
      // Brand-new key (D-03 union at key level). If both sides added the same key,
      // local wins (arbitrary-but-deterministic; matches the entry rule below).
      if (inLocal) { out[k] = l[k]; }
      else { out[k] = r[k]; } // remote-only new key
      continue;
    }

    // Key existed in base and survives on both sides — 3-way field merge.
    const localChanged = inLocal && !jsonEq(l[k], b[k]);
    const remoteChanged = inRemote && !jsonEq(r[k], b[k]);
    if (localChanged) { out[k] = l[k]; }       // local change wins (D-01/D-02)
    else if (remoteChanged) { out[k] = r[k]; } // keep remote-only change
    else { out[k] = r[k]; }                    // unchanged (r == b == l)
  }
  return out;
}

/**
 * mergeEntries — the entry-array 3-way merge (D-03 id-union, D-04 delete-wins).
 * Entries are keyed by `id`. Same rule as mergeKeyedMap but over an array indexed
 * by id, and the merged result keeps remote's ordering for surviving base/remote
 * entries with brand-new local entries appended (deterministic, order is not
 * load-bearing — the view groups by date).
 *
 * @param {Array} base @param {Array} local @param {Array} remote
 * @returns {Array} merged entries
 */
export function mergeEntries(base, local, remote) {
  const byId = (arr) => {
    const m = new Map();
    for (const e of (Array.isArray(arr) ? arr : [])) {
      if (e && typeof e === 'object' && e.id != null) m.set(e.id, e);
    }
    return m;
  };
  const b = byId(base), l = byId(local), r = byId(remote);
  const ids = new Set([...b.keys(), ...l.keys(), ...r.keys()]);
  const out = [];
  for (const id of ids) {
    const inBase = b.has(id), inLocal = l.has(id), inRemote = r.has(id);

    // Delete-wins (D-04): in base + removed on EITHER side => gone.
    if (inBase && (!inLocal || !inRemote)) continue;

    if (!inBase) {
      // Brand-new entry (D-03 union). Both-added-same-id => local wins.
      out.push(inLocal ? l.get(id) : r.get(id));
      continue;
    }

    const baseE = b.get(id);
    const localChanged = inLocal && !jsonEq(l.get(id), baseE);
    const remoteChanged = inRemote && !jsonEq(r.get(id), baseE);
    if (localChanged) { out.push(l.get(id)); }       // local edit wins (per-entry, D-01)
    else if (remoteChanged) { out.push(r.get(id)); } // keep remote-only edit
    else { out.push(r.get(id)); }                    // unchanged
  }
  return out;
}

/**
 * mergeMealPlan — the top-level 3-way merge (D-01..D-04). Computes what THIS
 * device changed vs `base` and applies it onto the FRESH `remote`, with
 * delete-wins at both entry and map-key level. PURE: takes three shared-doc
 * shapes, returns a new merged shared doc; never mutates its inputs. Idempotent
 * against the base, so a re-pull-and-re-merge after a 409 is safe (D-01).
 *
 * @param {object} base   — the last-pulled remote doc (the 3-way base)
 * @param {object} local  — this device's current shared doc (buildSharedPlanDoc)
 * @param {object} remote — the FRESH remote doc just pulled
 * @returns {object} merged shared doc
 */
export function mergeMealPlan(base, local, remote) {
  const B = coerceSharedPlanDoc(base);
  const L = coerceSharedPlanDoc(local);
  const R = coerceSharedPlanDoc(remote);

  const merged = {
    entries: mergeEntries(B.entries, L.entries, R.entries),
    orderScopeRange: (() => {
      // orderScopeRange is a single scalar-ish value (null | {startKey,endKey}),
      // merged by the same 3-way rule: local-changed wins, else remote.
      const localChanged = !jsonEq(L.orderScopeRange, B.orderScopeRange);
      const remoteChanged = !jsonEq(R.orderScopeRange, B.orderScopeRange);
      if (localChanged) return L.orderScopeRange;
      if (remoteChanged) return R.orderScopeRange;
      return R.orderScopeRange;
    })()
  };
  for (const field of SHARED_MAP_FIELDS) {
    merged[field] = mergeKeyedMap(B[field], L[field], R[field]);
  }
  // adHocExtras is an ARRAY of id-bearing objects — merge by id like entries
  // (D-03 union, D-04 delete-wins). A non-id-bearing array degrades to a plain
  // union by JSON identity.
  merged.adHocExtras = mergeAdHocExtras(B.adHocExtras, L.adHocExtras, R.adHocExtras);
  return merged;
}

/**
 * mergeAdHocExtras — array-of-objects 3-way merge. If the items carry an `id`,
 * merge by id (entries rule). Otherwise fall back to a JSON-identity union that
 * is delete-wins against the base (an item in base removed on either side is gone).
 */
export function mergeAdHocExtras(base, local, remote) {
  const b = Array.isArray(base) ? base : [];
  const l = Array.isArray(local) ? local : [];
  const r = Array.isArray(remote) ? remote : [];
  const allHaveId = [...b, ...l, ...r].every(x => x && typeof x === 'object' && x.id != null);
  if (allHaveId && (b.length || l.length || r.length)) {
    return mergeEntries(b, l, r);
  }
  // No stable id — JSON-identity union with delete-wins against base.
  const key = (x) => JSON.stringify(x);
  const bSet = new Set(b.map(key));
  const lSet = new Set(l.map(key));
  const rSet = new Set(r.map(key));
  const seen = new Set();
  const out = [];
  for (const x of [...l, ...r]) {
    const k = key(x);
    if (seen.has(k)) continue;
    // delete-wins: present in base but missing on either side => drop.
    if (bSet.has(k) && (!lSet.has(k) || !rSet.has(k))) { seen.add(k); continue; }
    seen.add(k);
    out.push(x);
  }
  return out;
}
