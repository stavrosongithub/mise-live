// ===========================================================================
// settings-sync.js  (quick 260712-i1y — synced kitchen-global settings)
// ===========================================================================
// The PURE half of the settings.json sync. app.js holds the impure wiring (the
// _pushSettings LWW push hook mirroring _pushSuppliers, the putJsonFile/ghPutFile
// transport + the 409 re-read + per-key MERGE re-PUT, the stampSetting clock, the
// _applySettingsWinners pull-reflect into Alpine state + localStorage). This
// module owns ONLY the settings DATA SHAPE + the per-key LWW arithmetic so it is
// Node-testable in isolation — exactly mirroring how suppliers-sync.js owns the
// suppliers shape and roster-sync.js owns buildRosterSnapshot.
//
// No Alpine, no IndexedDB, no network: pure data-in / data-out.
//
// THE ONE DEVIATION FROM suppliers.json's whole-file LWW: settings.json merges
// PER-KEY. Each synced key carries its own `{ value, editedAt }` clock, and the
// greater editedAt wins PER KEY — so a scaling change on device A never clobbers
// a prompt-override change on device B. The doc shape is:
//
//   { servingsPerResidentMain: { value: 3.5, editedAt: 1720000000000 }, ... }
//
// editedAt is an ms-epoch number; a fresh un-stamped local default uses editedAt=0
// (the low sentinel) so any real remote edit strictly wins over it.
// ===========================================================================

/**
 * SYNCED_SETTING_KEYS — the WHITELIST of the 14 kitchen-global settings that ride
 * settings.json. This is the ONLY set of keys that can ever be built into / read
 * out of the synced doc.
 *
 * CRITICAL (SENSITIVE tier, T-i1y-01): the 8 secret/identity fields — the Anthropic
 * key, codaApiToken, githubToken, githubOwner, githubRepo, githubBranch, userName,
 * selectedModel — are DELIBERATELY ABSENT from this list. buildSettingsDoc is driven
 * ENTIRELY by this whitelist: there is NO parameter through which a credential could
 * enter the payload (the per-key-LWW counterpart to roster-sync's rows-only
 * guarantee). coerceSettingsDoc likewise STRIPS any non-whitelisted key from an
 * incoming remote blob, so a hostile settings.json carrying codaApiToken is dropped.
 * @type {ReadonlyArray<string>}
 */
export const SYNCED_SETTING_KEYS = Object.freeze([
  'servingsPerResidentMain',
  'servingsPerResidentSide',
  'servingsPerResidentSalad',
  'scaleStrengths',
  'pantrySections',
  'systemPromptOverride',
  'conversionsJsonOverride',
  'allergenKeywordsOverride',
  'weatherLocation',
  'weatherLat',
  'weatherLon',
  'codaExportDocId',
  'codaResidencyTableId',
  'codaOnboardingTableId'
]);

const SYNCED_SETTING_KEY_SET = new Set(SYNCED_SETTING_KEYS);

/**
 * coerceSettingsDoc — normalise an arbitrary parsed blob into a clean per-key doc
 * `{ key: { value, editedAt } }`. Fail-open: returns {} for a non-object / array /
 * garbage input and NEVER throws (mirrors coerceSuppliers' discipline).
 *
 * Keeps ONLY entries that are (a) keyed by a WHITELISTED setting key, (b) a plain
 * object, (c) carrying a NUMERIC editedAt, and (d) with `value` defined (an
 * `undefined` value is dropped — there is nothing to apply). A hostile remote blob
 * carrying codaApiToken / githubToken is stripped because those keys are not in
 * SYNCED_SETTING_KEY_SET (T-i1y-02 tampering mitigation).
 *
 * @param {*} raw — a parsed JSON blob (object, array, or garbage)
 * @returns {Object<string,{value:*,editedAt:number}>}
 */
export function coerceSettingsDoc(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const key of SYNCED_SETTING_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const entry = raw[key];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if (typeof entry.editedAt !== 'number' || !Number.isFinite(entry.editedAt)) continue;
    if (entry.value === undefined) continue;
    out[key] = { value: entry.value, editedAt: entry.editedAt };
  }
  return out;
}

/**
 * mergeSettingsDoc — per-key UNION of two coerced docs. For a key present in both,
 * the entry with STRICTLY greater editedAt wins; an equal editedAt is a deterministic
 * tie broken in favour of `base`. A key on only one side is kept verbatim. NEVER
 * mutates its inputs (returns a fresh object with fresh entry copies).
 *
 * This is the whole point of per-key LWW: a concurrent edit to a DIFFERENT key on
 * the other device is preserved (T-i1y-05) — the 409 re-read + mergeSettingsDoc
 * re-PUT in app.js relies on this.
 *
 * @param {Object<string,{value:*,editedAt:number}>} base
 * @param {Object<string,{value:*,editedAt:number}>} incoming
 * @returns {Object<string,{value:*,editedAt:number}>}
 */
export function mergeSettingsDoc(base, incoming) {
  const a = (base && typeof base === 'object' && !Array.isArray(base)) ? base : {};
  const b = (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) ? incoming : {};
  const out = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const inA = a[key];
    const inB = b[key];
    if (inA && inB) {
      // strictly-greater incoming wins; tie -> base (deterministic).
      out[key] = (inB.editedAt > inA.editedAt)
        ? { value: inB.value, editedAt: inB.editedAt }
        : { value: inA.value, editedAt: inA.editedAt };
    } else if (inA) {
      out[key] = { value: inA.value, editedAt: inA.editedAt };
    } else if (inB) {
      out[key] = { value: inB.value, editedAt: inB.editedAt };
    }
  }
  return out;
}

/**
 * buildSettingsDoc — assemble the per-key doc from the live values + the local clock
 * map. Iterates the WHITELIST ONLY: a key present in valuesByKey and in
 * SYNCED_SETTING_KEYS lands as `{ value, editedAt }`; a key with no clock entry seeds
 * editedAt=0 (the low sentinel so an un-stamped local default never beats a real
 * remote edit). A key absent from valuesByKey is skipped.
 *
 * CRITICAL (SENSITIVE tier, T-i1y-01): because the loop is over SYNCED_SETTING_KEYS
 * and NOT over Object.keys(valuesByKey), NO non-whitelisted property (codaApiToken,
 * githubToken, apiKey, …) passed alongside in valuesByKey can reach the output. There
 * is no parameter through which a credential could enter the payload — the whitelist
 * IS the boundary (mirrors roster-sync's rows-only guarantee).
 *
 * @param {Object<string,*>} valuesByKey — current live values keyed by setting name
 * @param {Object<string,number>} editedAtByKey — the local per-key ms-epoch clock
 * @returns {Object<string,{value:*,editedAt:number}>}
 */
export function buildSettingsDoc(valuesByKey, editedAtByKey) {
  const vals = (valuesByKey && typeof valuesByKey === 'object') ? valuesByKey : {};
  const clock = (editedAtByKey && typeof editedAtByKey === 'object') ? editedAtByKey : {};
  const out = {};
  for (const key of SYNCED_SETTING_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(vals, key)) continue;
    const value = vals[key];
    if (value === undefined) continue; // nothing to sync for an undefined value
    const editedAt = (typeof clock[key] === 'number' && Number.isFinite(clock[key])) ? clock[key] : 0;
    out[key] = { value, editedAt };
  }
  return out;
}

/**
 * settingsToApply — the list of keys where the REMOTE doc STRICTLY wins over local,
 * i.e. the winners a pull should reflect into local state. A remote key wins when it
 * is absent locally, or its editedAt is STRICTLY greater than local's. Ties and
 * local-wins are excluded (nothing to change locally).
 *
 * @param {Object<string,{value:*,editedAt:number}>} localDoc
 * @param {Object<string,{value:*,editedAt:number}>} remoteDoc
 * @returns {Array<{key:string,value:*,editedAt:number}>}
 */
export function settingsToApply(localDoc, remoteDoc) {
  const local = (localDoc && typeof localDoc === 'object' && !Array.isArray(localDoc)) ? localDoc : {};
  const remote = (remoteDoc && typeof remoteDoc === 'object' && !Array.isArray(remoteDoc)) ? remoteDoc : {};
  const winners = [];
  for (const key of Object.keys(remote)) {
    if (!SYNCED_SETTING_KEY_SET.has(key)) continue; // defensive: only whitelisted keys
    const r = remote[key];
    if (!r || typeof r !== 'object' || typeof r.editedAt !== 'number') continue;
    const l = local[key];
    const localAt = (l && typeof l.editedAt === 'number') ? l.editedAt : -Infinity;
    if (!l || r.editedAt > localAt) {
      winners.push({ key, value: r.value, editedAt: r.editedAt });
    }
  }
  return winners;
}
