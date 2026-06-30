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
//     recipeLineStrikes,                               // keyed map (by ingredient_id) — skip-this-shop strikethrough (quick 260628-v0i)
//     adHocExtras,                                     // keyed map (by id) OR array — see note
//     orderScopeRange,                                 // null | { startKey, endKey }
//     shopOrderedFor                                   // null | { scope: (null | {startKey,endKey}), orderedAt, orderedBy } — quick 260630-d81
//   }
// Pure view-state (`collapsed`, `pickerCollapsed`, `dayCollapsedByDay`) is
// EXCLUDED from the shared doc and stays in localStorage (SPEC #1).
// ============================================================================

// The keyed-MAP fields merged per-key by the 3-way base rule (D-02). These are
// plain objects keyed by day-string / ingredient_id. `adHocExtras` is an array
// in the live state but is merged as an ARRAY-union below (D-03 id-union), not
// as a keyed map — it is handled separately from MAP_FIELDS.
// quick 260628-v0i — `recipeLineStrikes` ({ ingredient_id: true }) joins the keyed-map
// family so the per-shop recipe-line strikethrough syncs between users by the SAME 3-way
// per-key delete-wins rule (no bespoke merge — mergeMealPlan iterates this array).
export const SHARED_MAP_FIELDS = ['cooksByDay', 'dayLeftovers', 'prepDoneByDay', 'regularsOverrides', 'recipeLineStrikes'];

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
    recipeLineStrikes: {},
    adHocExtras: [],
    orderScopeRange: null,
    // quick 260630-d81 — per-shopping-period "ordered" stamp. null = not ordered,
    // or { scope: (null | {startKey,endKey}), orderedAt: <ISO>, orderedBy: <string> }.
    // A synced SCALAR (not a keyed map) — merged like orderScopeRange.
    shopOrderedFor: null
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
 *                           regularsOverrides, adHocExtras, orderScopeRange,
 *                           shopOrderedFor }
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
    recipeLineStrikes: obj(s.recipeLineStrikes),
    adHocExtras: Array.isArray(s.adHocExtras) ? s.adHocExtras : [],
    orderScopeRange: (s.orderScopeRange
      && typeof s.orderScopeRange === 'object'
      && !Array.isArray(s.orderScopeRange))
      ? s.orderScopeRange
      : null,
    // quick 260630-d81 — per-period ordered stamp; same plain-non-null-object guard
    // as orderScopeRange (a malformed array/scalar coerces to null = not ordered).
    shopOrderedFor: (s.shopOrderedFor
      && typeof s.shopOrderedFor === 'object'
      && !Array.isArray(s.shopOrderedFor))
      ? s.shopOrderedFor
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
    recipeLineStrikes: obj(raw.recipeLineStrikes),
    adHocExtras: Array.isArray(raw.adHocExtras) ? raw.adHocExtras : [],
    orderScopeRange: (raw.orderScopeRange
      && typeof raw.orderScopeRange === 'object'
      && !Array.isArray(raw.orderScopeRange))
      ? raw.orderScopeRange
      : null,
    // quick 260630-d81 — BACKWARD-COMPAT: an existing remote meal_plan.json predates
    // this field, so a MISSING shopOrderedFor coerces to null (not ordered). A malformed
    // array/scalar likewise => null. (The shapeCheck is deliberately NOT extended.)
    shopOrderedFor: (raw.shopOrderedFor
      && typeof raw.shopOrderedFor === 'object'
      && !Array.isArray(raw.shopOrderedFor))
      ? raw.shopOrderedFor
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
 * mergeCookListMap — list-aware 3-way merge for `cooksByDay` (quick 260629-dsq).
 *
 * WHY this differs from `mergeKeyedMap`: `cooksByDay[dateKey]` is NOT an opaque
 * scalar — it is an ARRAY of cook APPID strings (multiple cooks can be assigned
 * to one day). `mergeKeyedMap` treats each day's whole array as a single value
 * and applies "side that changed wins", so one side's list replaces the other and
 * any cook present only on the losing side is silently dropped. (Real-world
 * trigger: a SINGLE user with the app open in MULTIPLE windows/devices — each
 * window holds its own stale in-memory plan + cached merge-base, so a cook added
 * in one window is lost when another stale window pushes its day-list.) This
 * helper instead does a PER-DAY, per-cook-id 3-way UNION with delete-wins per id,
 * mirroring the id-union spirit of `mergeEntries` / `mergeAdHocExtras`.
 *
 * Rules per day key (UNION of base/local/remote day-keys):
 *   - KEY-level delete-wins (mirrors mergeKeyedMap): a key present in base but
 *     ABSENT (key missing) on EITHER side is gone — skip it. (An emptied-to-`[]`
 *     day is NOT "absent" — the key still exists and falls through to the per-id
 *     union, yielding `[]`, which IS kept.)
 *   - Brand-new key (not in base): keep it; union the lists of whichever sides
 *     have it.
 *   - Key in base + present on both sides: per-id 3-way union with delete-wins —
 *     keep an id UNLESS it was in base AND removed on EITHER side. Every other id
 *     (added on either side, or unchanged) is kept.
 *
 * KEEP-`[]` decision (load-bearing): a day key whose merged list is empty is
 * KEPT, not dropped. `cooksForDay()` lazy-inits `this.cooksByDay[dateKey] = []`
 * and `projectSharedPlanDoc` carries those empty arrays verbatim, so the merge
 * MUST round-trip empty-list days unchanged — otherwise it would diverge from the
 * projection and arm a spurious no-op push (jq9 guard). Only a genuinely DELETED
 * key (the key itself removed vs base on a side) is dropped, per delete-wins.
 *
 * PURE: builds and returns a fresh object; never mutates base/local/remote.
 *
 * @param {object} base @param {object} local @param {object} remote
 * @returns {object} merged `cooksByDay` map
 */
export function mergeCookListMap(base, local, remote) {
  const b = base || {}, l = local || {}, r = remote || {};
  const asList = (v) => (Array.isArray(v) ? v : []); // defensive: non-array => []
  const keys = new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)]);
  const out = {};
  for (const k of keys) {
    const inBase = Object.prototype.hasOwnProperty.call(b, k);
    const inLocal = Object.prototype.hasOwnProperty.call(l, k);
    const inRemote = Object.prototype.hasOwnProperty.call(r, k);

    // KEY-level delete-wins (D-04): a key in base but removed (key missing) on
    // EITHER side is gone. NB: an emptied-to-[] day still HAS the key, so it is
    // not caught here — it falls through to the per-id union below and yields [].
    if (inBase && (!inLocal || !inRemote)) continue;

    const bl = asList(b[k]), ll = asList(l[k]), rl = asList(r[k]);

    if (!inBase) {
      // Brand-new day key (D-03 union at key level): union of whichever sides
      // have it, deterministic order (local additions first, then remote-only).
      const seen = new Set();
      const merged = [];
      for (const id of [...ll, ...rl]) {
        if (seen.has(id)) continue;
        seen.add(id);
        merged.push(id);
      }
      out[k] = merged;
      continue;
    }

    // Key existed in base and survives on both sides — per-id 3-way union with
    // delete-wins: keep an id unless it was in base AND removed on EITHER side.
    const lSet = new Set(ll), rSet = new Set(rl), bSet = new Set(bl);
    const seen = new Set();
    const merged = [];
    // Deterministic order: surviving base ids first, then new-local, then new-remote.
    for (const id of [...bl, ...ll, ...rl]) {
      if (seen.has(id)) continue;
      seen.add(id);
      // delete-wins per id: in base but missing on either side => drop.
      if (bSet.has(id) && (!lSet.has(id) || !rSet.has(id))) continue;
      merged.push(id);
    }
    out[k] = merged; // emit even if empty ([] is KEPT — see KEEP-[] note above)
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
    })(),
    shopOrderedFor: (() => {
      // quick 260630-d81 — shopOrderedFor is a single scalar-ish value
      // (null | { scope, orderedAt, orderedBy }), merged by the SAME 3-way rule as
      // orderScopeRange: local-changed wins (a fresh stamp or an Undo→null), else
      // remote-changed, else remote. NOT a keyed map — it stays OUT of
      // SHARED_MAP_FIELDS / mergeKeyedMap / mergeCookListMap.
      const localChanged = !jsonEq(L.shopOrderedFor, B.shopOrderedFor);
      const remoteChanged = !jsonEq(R.shopOrderedFor, B.shopOrderedFor);
      if (localChanged) return L.shopOrderedFor;
      if (remoteChanged) return R.shopOrderedFor;
      return R.shopOrderedFor;
    })()
  };
  for (const field of SHARED_MAP_FIELDS) {
    // `cooksByDay` is a map of ARRAYS (per-day cook id lists), not opaque scalars,
    // so it gets a list-aware merge — routing it through mergeKeyedMap would drop
    // a cook present only on one side (quick 260629-dsq). It stays in
    // SHARED_MAP_FIELDS (the constant remains a faithful list of synced map
    // fields) and is special-cased here; the other four maps merge per-key.
    if (field === 'cooksByDay') continue; // assigned via mergeCookListMap below
    merged[field] = mergeKeyedMap(B[field], L[field], R[field]);
  }
  merged.cooksByDay = mergeCookListMap(B.cooksByDay, L.cooksByDay, R.cooksByDay);
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
