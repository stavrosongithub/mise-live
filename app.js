// ============================================================================
// Mise — Alpine reactive store (Phase 1 scope)
// ----------------------------------------------------------------------------
// This file is loaded as an ES module from index.html. It imports Alpine
// as an ES module (so Alpine cannot dispatch alpine:init before this file
// runs), registers the Alpine component named "app" via Alpine.data(), and
// then explicitly calls Alpine.start() to boot the runtime. Consumed by
// `<body x-data="app">` (no parens — Alpine.data takes the factory itself).
//
// Store shape (quick 260612-abt — persistence is now IndexedDB, not an FSA
// folder handle):
//
//   apiKey            : string    — current saved Anthropic key (from localStorage)
//   apiKeyDraft       : string    — bound to settings-modal <input type="password">
//   settingsOpen      : boolean   — controls .modal x-show
//   csvStoreLoaded    : boolean   — true once the IndexedDB store is loaded into
//                                    session state (boot auto-load or after import)
//   csvHeaders        : { recipes, ingredients, recipe_ingredients }
//                                  — column orders captured at session start
//   ingredientMaster  : Array<{ ingredient_id, ingredient_name, allergens: string[] }>
//                                  — cached 235-row ingredient master
//   maxRecipeIdAtSessionStart
//                     : number    — snapshot for Approve's recipe_id allocation
//   parseError        : string    — inline error region content (cross-plan)
//   rawText           : string    — textarea x-model bind (Plan 02 / PARSE-01)
//   parsing           : boolean   — Parse button :disabled flag (Plan 02 / PARSE-06)
//   form              : { header, rows[] }
//                                  — populated by parse(); Plan 03 renders it
//   devMode           : boolean   — true when ?dev=1; unhides Load Example button
//
// Actions:
//   init()           — open Settings modal when no API key; read devMode; auto-load store.
//   importCsvs(ev)   — seed the IndexedDB store from 3 uploaded CSVs, then loadFromStore.
//   exportCsvs()     — download all 3 store files byte-faithfully (backup).
//   saveApiKey()     — persist apiKeyDraft.trim() + close modal.
//   clearApiKey()    — wipe apiKey + localStorage.
//   parse()          — Anthropic Structured-Outputs LLM round-trip (Plan 02).
//   loadExample()    — dev-only: populate rawText from EXAMPLE_RECIPE.
//
// localStorage key:
//   'recipe_ingest_api_key' — plain string, no encryption (D-16 / P12).
//
// CDN imports are VERSION-PINNED per D-04. No floating version specifiers anywhere.
// ============================================================================

import Papa from 'https://esm.sh/papaparse@5.4.0';
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.97.1';
import Alpine from 'https://esm.sh/alpinejs@3.15.12';
window.Alpine = Alpine;
// Phase 4 (Plan 04-02) — Fuse.js 7.3 pinned per D-04 (CLAUDE.md TL;DR locked stack).
// Used for top-3 fuzzy-match candidates in the unknown-ingredient modal + the
// D-55 auto-resolve cascade after Add-new. 235-entry master is trivially small;
// search runs in <1ms (RESEARCH §Standard Stack).
import Fuse from 'https://esm.sh/fuse.js@7.3.0';
import { buildRecipeSchema, assertNoOpenObjects, FSA14, REASON_CODE_ENUM, FLAGGED_FIELD_NAME_ENUM, REVIEW_FLAG_ENUM } from './schema.js';
import { buildSystemPrompt, DEFAULT_PROMPT_TEMPLATE } from './system-prompt.js';
import { generateSalt, buildUserMessage } from './prompt-utils.js';
import { validateRecipe } from './validate.js';
import { checkCoverage } from './coverage.js';
import { estimateParseCost } from './count.js';
// quick 260611-enp — pure deterministic scaling for the read-only meal-plan view.
// scale.js has ZERO browser imports so the same module is unit-tested under Node
// (scripts/scale.test.mjs). factor + scaleRow are the only entry points the
// meal-plan getters need (scaleRow folds in scaled_quantity_metric/volumetric).
import { factor, scaleRow, classifyIngredientCategory, isValidScaleCategory, SCALE_CATEGORIES } from './scale.js';
// Phase 06 (Plan 06-02) — pure, browser-free cook-artifact logic (D-07/D-10/D-16).
// splitInstructionSteps turns standardized instructions_20 into step-groups;
// orderEntriesByType applies the main->side->salad->other dish sort. Both are
// unit-tested under scripts/cook-artifact.test.mjs (scale.js precedent).
import { splitInstructionSteps, orderEntriesByType } from './cook-artifact.js';
// Phase 17 (Plan 17-02) — PURE meal-plan sync helpers (shared/local field split +
// the 3-way merge: delete-wins D-04, id-keyed entries D-03, per-key maps D-02).
// Node-tested in scripts/mealplan-sync.test.mjs; the impure wiring (Alpine state,
// debounce, putJsonFile/ghPutFile, pull-on-open) lives in this file and calls them.
import {
  projectSharedPlanDoc,
  coerceSharedPlanDoc,
  emptySharedPlanDoc,
  mergeMealPlan
} from './mealplan-sync.js';
// Phase 17 (Plan 17-03) — PURE roster-snapshot helper (residents_roster.json
// shape, ROWS-ONLY, NO credential — T-17-08). Node-tested in
// scripts/roster-sync.test.mjs; the impure wiring (fetchRoster push hook,
// putJsonFile/ghPutFile LWW, tokenless read-in) lives in this file.
import { buildRosterSnapshot } from './roster-sync.js';
// merge.js — schema migration transforms + detectors + CSV convention probe.
// (The delta/merge file-I/O helpers are removed in quick 260612-abt; only the
// migration transforms + detectCsvConventions + isShoppingUnitValue remain.)
// Registration order preserved per quick task 260522-avm — imports resolve
// before Alpine.data / Alpine.start.
import {
  // quick 260607-anu — one-time live-CSV schema migration + header detectors.
  migrateRecipeIngredientsRows,
  isMigratedJoinHeader,
  isOldSchemaJoinHeader,
  // quick 260607-c65 — ingredients.csv shopping_unit migration + header detectors.
  migrateIngredientsRows,
  isMigratedIngredientsHeader,
  isOldSchemaIngredientsHeader,
  isShoppingUnitValue,
  // quick 260612-esy — Phase B: the second additive-column gate for the master.
  isCategorizedIngredientsHeader,
  // quick 260614-eqa — the third additive-column gate for the master (pantry_staple).
  isStapleTaggedIngredientsHeader,
  // quick 260615-e1n — the fourth additive-column gate for the master (pantry_section).
  isSectionTaggedIngredientsHeader,
  // quick 260615-kid — the fifth additive-column gate for the master (pack_units;
  // pack_unit_label rides the same Migrate pass).
  isPackUnitsTaggedIngredientsHeader,
  // phase 08 / REG-01 — the sixth additive-column gate for the master (regular;
  // regular_qty_per_person rides the same Migrate pass).
  isRegularTaggedIngredientsHeader
} from './merge.js';
// quick 260612-abt — IndexedDB persistence substrate (replaces FSA folder handle).
// The pure helpers take an injected Papa (the page global imported above) so they
// stay Node-testable; the impure methods are the live store read/write path.
import {
  openStore,
  hasAnyFile,
  getFile,
  putFile,
  serializeCsv,
  parseCsv,
  STORE_FILES,
  REQUIRED_STORE_FILES,
  classifyRemoteShape,
  // Phase 17 (D-11/D-15) — the parallel JSON data-safety write + read, and the
  // optional-absent JSON file-set the shared meal plan + roster snapshot ride.
  putJsonFile,
  OPTIONAL_JSON_FILES
} from './csvStore.js';

// Phase 10 (ACCESS-01/02) — the GitHub Contents transport (Phase 09 module,
// Plan 01-hardened). saveConnection() validates a connection on Save via a
// GET /repos private assertion (buildHeaders for the same Bearer/Accept/version
// headers) + a test pull (ghGetFile); the typed-error classes feed the D-05
// friendly-string map. The token lives ONLY in buildHeaders' Authorization
// header and is NEVER surfaced in any error copy (SENSITIVE tier).
import {
  ghGetFile,
  ghPutFile,
  buildHeaders,
  GhError,
  GhConflictError,
  GhAuthError,
  GhAccessError,
  // Phase 12 (LOCK-01..04) — advisory-lock transport (Plan 09 module) + the
  // Plan 12-01 timing substrate the state machine consumes (never reimplements):
  // ghReadLock/ghWriteLock/ghDeleteLock move the .mise-lock.json bytes; the lock
  // SHAPE + heartbeat/TTL/staleness logic is THIS file's job. ghGetServerTime is
  // the observer-side skew-safe clock, parseServerTime its NaN-guard, isLockStale
  // the single `now > expires` comparison.
  ghReadLock,
  ghWriteLock,
  ghDeleteLock,
  ghGetServerTime,
  parseServerTime,
  isLockStale,
  // Phase 14 (CHANGES-02) — recent-changes transport: the raw GET /commits array
  // that openRecentChanges filters ([lock] noise) + maps (who/what/when).
  ghListCommits
} from './githubStore.js';

// Phase 07 — Coda roster helpers (Plan 07-01). Sibling import to csvStore.js.
// getRosterTable reads the codaRoster cache; joinRoster joins residency↔onboarding;
// ROSTER_TABLES is the ['residency','onboarding'] name list.
import {
  getRosterTable,
  joinRoster,
  ROSTER_TABLES,
  // Plan 07-03 — present-on-D panel + live fetch.
  residentsPresentOnDate,
  detectChainedOverlap,
  fetchCodaTable,
  normalizeCodaRows,
  putRosterTable,
  CODA_FIELDS,
  // Phase 16 (D39/D40) — the two PURE safety-critical seams + the 4th-file column
  // set. app.js owns ALL I/O around them (seed hook reads current rows → calls the
  // helper → putFile + push; dayAllergenStatus calls the classifier per resident).
  seedResidentAllergens,
  classifyResidentAllergens,
  RESIDENT_ALLERGEN_COLUMNS
} from './residents.js';

// Plan 07-03 (WR-01) — dedup key for the dev-only overlap console.warn. The
// residentsPresent getter is read several times per render cycle (count, x-show,
// x-for, empty-state), so warning inside the getter unconditionally would fire a
// warn STORM. This MODULE-scoped key (deliberately NOT on `this` — mutating a
// reactive prop inside a getter read during render risks an Alpine effect loop)
// makes the warn fire once per distinct (date + overlap-state) transition.
let _lastOverlapWarnKey = null;

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

// Phase 1 hardcodes the Sonnet 4.6 model. Phase 2 (SHELL-03) adds a settings
// modal selector. If your Anthropic account doesn't have access to 4-6 yet,
// edit this to 'claude-sonnet-4-5' — the mapToPlainLanguage 404 branch also
// names this constant in the user-facing error so the swap is obvious.
const DEFAULT_MODEL = 'claude-sonnet-4-6';

// ----------------------------------------------------------------------------
// quick 260612-dr4 — per-category scaling strengths (Phase A nonlinear scaling)
// ----------------------------------------------------------------------------
// The 5 scaling categories produced by scale.js classifyIngredientCategory(),
// UI-keyed (TitleCase) for the Settings inputs. Values are PERCENT (0..100);
// strengthByCategory getter divides by 100 into the [0,1] strengths scale.js
// expects. Defaults: standard/liquid scale fully (100), seasoning halfway (50),
// leavening mostly (70), fixed never (0). See DECISIONS.md (2026-06-12).
const DEFAULT_SCALE_STRENGTHS = { Standard: 100, Liquid: 100, Seasoning: 50, Leavening: 70, Fixed: 0 };
const SCALE_STRENGTH_KEY = 'recipe_ingest_scale_strengths';

// quick 260615-e1n — the curated, ordered, editable list of storage LOCATIONS used
// to group the combined shopping list + "Check you have these" list. This ORDER is
// the section order in those lists (USER-LOCKED seed). Mirrors the scaleStrengths
// localStorage precedent. An ingredient's pantry_section cell holds one of these
// strings (or blank = Unsorted); the list itself lives in localStorage, NOT on the
// CSV, so it is freely editable without a schema migration.
const DEFAULT_PANTRY_SECTIONS = ['Chest Freezer', 'Standing Freezer', 'Ingredients Fridge', 'Spice Cupboard', 'Pantry', 'Shelves'];
const PANTRY_SECTIONS_KEY = 'recipe_ingest_pantry_sections';

// Phase 12 (LOCK-01..04) — advisory-lock state-machine constants. Named, never
// magic numbers. TTL is the lifetime baked into each lock's `expires`
// (heartbeat + TTL); the heartbeat refreshes well inside it. LOCK_COMMIT_PREFIX
// tags every lock commit `[lock]` — DISTINCT from Phase 11's `Name: action…`
// changelog format so Phase 14 can filter the lock noise out of history (D-08).
const LOCK_TTL_MS = 300000;        // 5 min — a lock older than this is stale (LOCK-02)
const LOCK_HEARTBEAT_MS = 60000;   // 60 s — single-owner refresh interval (LOCK-01)
const LOCK_COMMIT_PREFIX = '[lock]';

// loadPantrySections() — seed pantrySections from localStorage, defensively
// (T-e1n-04). Mirrors loadScaleStrengths: JSON-parse in try/catch; if not a non-empty
// array, return a fresh copy of the defaults; else coerce each entry to a trimmed
// String, drop blanks, DEDUPE (case-sensitive, keep first), and fall back to a fresh
// copy of defaults if nothing survives. The UI never boots into a broken location list.
function loadPantrySections() {
  let stored = null;
  try {
    const raw = localStorage.getItem(PANTRY_SECTIONS_KEY);
    if (raw) stored = JSON.parse(raw);
  } catch (_e) {
    stored = null; // corrupt JSON -> fall back to defaults below.
  }
  if (!Array.isArray(stored) || stored.length === 0) {
    return [...DEFAULT_PANTRY_SECTIONS];
  }
  const out = [];
  const seen = new Set();
  for (const x of stored) {
    const s = String(x).trim();
    if (s === '' || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out.length > 0 ? out : [...DEFAULT_PANTRY_SECTIONS];
}

// loadScaleStrengths() — seed scaleStrengths from localStorage, defensively.
// (T-dr4-01) JSON-parse in try/catch; on missing/corrupt/non-object fall back to
// the defaults; for each of the 5 keys coerce to Number + clamp to 0..100, and
// NaN -> that key's default. Mirrors how selectedModel reads localStorage so the
// state initializer stays a single expression.
function loadScaleStrengths() {
  let stored = null;
  try {
    const raw = localStorage.getItem(SCALE_STRENGTH_KEY);
    if (raw) stored = JSON.parse(raw);
  } catch (_e) {
    stored = null; // corrupt JSON -> fall back to defaults below.
  }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    stored = {};
  }
  const out = {};
  for (const key of Object.keys(DEFAULT_SCALE_STRENGTHS)) {
    const n = Number(stored[key]);
    out[key] = Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : DEFAULT_SCALE_STRENGTHS[key];
  }
  return out;
}

// max_tokens=16k from day one per RESEARCH §Pitfall B / API-03. Default 1024
// or 4096 silently truncates 30-row recipes; we surface stop_reason explicitly.
const MAX_TOKENS = 16000;

// ----------------------------------------------------------------------------
// Parse state machine (PARSE-02) — RESEARCH §E
// ----------------------------------------------------------------------------
// Explicit 9-value finite state machine wraps parse() and (later) approve().
// 'resolving' is RESERVED for Phase 4 (unknown-ingredient queue); declared
// here so the TRANSITIONS table is complete, but Phase 2's happy path never
// enters it (validating → reviewing directly).
//
// Double-parse guard (P20): parse() refuses re-entry while not in IDLE,
// APPROVED, or ERROR — formalizes the previous boolean-flag guard.
const STATES = Object.freeze({
  IDLE: 'idle',
  PREFLIGHT: 'preflight',
  CALLING: 'calling',
  VALIDATING: 'validating',
  REVIEWING: 'reviewing',
  RESOLVING: 'resolving',   // Reserved for Phase 4
  APPROVING: 'approving',
  APPROVED: 'approved',
  ERROR: 'error'
});

// transitions[fromState] = Set<allowedToState>
const TRANSITIONS = {
  // REVIEW-09 / D-42 — 'reviewing' added to idle's allow-list so the
  // restore-on-load action can warp from IDLE into REVIEWING via the
  // canonical state-machine entry (not a direct this.state assignment).
  // The restore-prompt is a real transition, documented in the table.
  idle:       new Set(['preflight', 'error', 'reviewing']),
  preflight:  new Set(['calling', 'error', 'idle']),
  calling:    new Set(['validating', 'error']),
  validating: new Set(['reviewing', 'resolving', 'error']),
  reviewing:  new Set(['approving', 'idle', 'error']),
  resolving:  new Set(['reviewing', 'error']),
  approving:  new Set(['approved', 'error', 'reviewing']),
  approved:   new Set(['idle']),
  error:      new Set(['idle', 'preflight'])
};

// ----------------------------------------------------------------------------
// REVIEW-09 / D-42 (Plan 03-04) — single localStorage slot key
// ----------------------------------------------------------------------------
// In-flight review persistence: ONE slot per browser profile. On parse-success
// and every subsequent form edit, a debounced (750ms — D-43) write snapshots
// rawText + form (header + rows stripped of _key/_needsFullReview) +
// recipeIdSuggestion + version + timestamp. On page load, init() reads this
// slot and offers the user a Resume-or-start-fresh modal (D-42).
//
// Naming follows the existing recipe_ingest_<purpose> convention used by
// apiKey / model / system_prompt_override / conversions_json_override.
const INFLIGHT_REVIEW_KEY = 'recipe_ingest_inflight_review';

// quick 260615-dap — meal-plan persistence slot. Holds a MINIMAL projection of
// the plan ONLY: an array of { recipe_id, servings, collapsed }. NEVER recipe
// data (name/type are refreshed from disk on open) and NEVER mealPlanGrouped
// (rebuilt fresh on open). The plan survives a browser refresh; a pick whose
// recipe no longer exists is reconciled (dropped + user notified) on open.
const MEAL_PLAN_KEY = 'recipe_ingest_meal_plan';
// quick 260620-esf — ONE localStorage slot holding BOTH meal-plan UI prefs
// (Add-recipes collapsed + per-day collapse map). UI-prefs ONLY; never touches
// the CSV/IndexedDB store. Mirrors the MEAL_PLAN_KEY persist/restore idiom.
const MEAL_PLAN_UI_KEY = 'recipe_ingest_meal_plan_ui';
// Phase 17 (Plan 17-02, D-01/D-14) — the persisted 3-way MERGE BASE: the last
// shared meal_plan.json doc this device pulled/wrote. The merge-on-push diffs
// THIS device's changes vs this base and applies only those onto fresh remote
// (no whole-doc clobber, no 409 hard-stop). It MUST survive reloads (D-14) or the
// merge degrades to last-write-wins; restored on boot alongside _restoreMealPlan.
const MEAL_PLAN_BASE_KEY = 'recipe_ingest_meal_plan_base';

// Hardcoded short recipe shown when the user clicks the dev-only Load Example
// button. Already framed as scaled-to-20-servings (D-07). Trivial to remove.
const EXAMPLE_RECIPE = `Hummus (serves 20)

Ingredients:
- 1.6 kg cooked chickpeas (or 4 x 400g tins, drained)
- 400 g tahini
- 240 ml lemon juice (about 8 lemons)
- 8 cloves garlic, crushed
- 4 tsp salt
- 200 ml extra virgin olive oil
- 2 tsp ground cumin

Instructions:
1. Blend chickpeas, tahini, lemon juice, garlic, salt, and cumin until smooth.
2. With the motor running, slowly drizzle in olive oil until creamy.
3. Taste; adjust salt and lemon. Serve drizzled with more olive oil.
`;

// ----------------------------------------------------------------------------
// REVIEW-05 / D-34 — plain-English tooltip captions per reason code
// ----------------------------------------------------------------------------
// One short sentence per code, hover/focus-revealed in the per-row marker UI.
// Strings copied VERBATIM from 03-UI-SPEC.md "Reason-code tooltip captions"
// table — do NOT paraphrase, do NOT include the raw reason_code token, do NOT
// surface developer jargon ("LLM" / "schema" / "Valibot"). Keys MUST match
// REASON_CODE_ENUM in schema.js exactly so the renderer's lookup
// `REASON_CODE_TOOLTIPS[entry.reason_code]` never returns undefined for a
// schema-validated flagged_fields entry.
const REASON_CODE_TOOLTIPS = {
  unit_guessed:       'The unit here was a best guess — please double-check it matches the recipe.',
  quantity_guessed:   'The amount here was estimated from the text — please confirm the number.',
  unknown_ingredient: "This ingredient isn't in your master list — review the name before approving.",
  range_or_estimate:  "The recipe gave a range or an 'about' amount — the middle value was used.",
  dropped_content:    'Some words from the recipe near this row may not have made it in — check the raw text on the left.',
  allergen_uncertain: "An allergen for this ingredient may be incomplete — please review the recipe's allergen list."
};

// quick 260618-ihr (Workstream B) — plain-English captions for the parse-only
// header.review_flags judgement-call codes, rendered in the review-pane banner
// (NON-BLOCKING; gates nothing — mirrors the duplicate-detector posture). Same
// tone rules as REASON_CODE_TOOLTIPS: no jargon, no raw code token. Keys MUST
// match REVIEW_FLAG_ENUM in schema.js exactly so the template lookup
// `REVIEW_FLAG_LABELS[f.reason_code]` never returns undefined for a
// schema-validated entry.
const REVIEW_FLAG_LABELS = {
  reconstructed_method:      'Method reconstructed from the ingredient list',
  temperature_inferred:      'A temperature was filled in that the source did not give',
  prep_note_added:           'A prep note was added that was not in the source',
  prep_note_changed:         'An existing prep note was changed',
  pulse_mushy_risk:          'A pulse may go mushy — pick pressure cook vs gentle boil',
  ingredient_mismatch_fixed: 'A step named an ingredient that did not match the list — corrected',
  steps_cut:                 'One or more steps were cut',
  no_source_instructions:    'There were no source instructions — left blank'
};
// Dev-time completeness assertion: every enum code has a caption (keeps the
// label map in lock-step with schema.js REVIEW_FLAG_ENUM).
if (REVIEW_FLAG_ENUM.some(code => !(code in REVIEW_FLAG_LABELS))) {
  console.warn('REVIEW_FLAG_LABELS is missing a caption for a REVIEW_FLAG_ENUM code');
}

// ----------------------------------------------------------------------------
// Module-private helpers (kept above window.app so they're hoisted-ready)
// ----------------------------------------------------------------------------

/**
 * deriveSessionStateFromCsvs — quick 260612-abt. THE single derivation path for
 * the in-memory session state (csvHeaders / ingredientMaster /
 * maxRecipeIdAtSessionStart) from the three parsed CSVs. Extracted from the old
 * loadLiveCsvs so BOTH the (still-present) FSA load AND the new store load
 * (loadFromStore) call ONE code path — including the ingredient_id column guard,
 * the skip-blank-row guard, the shopping_unit default, and the maxRecipeId
 * snapshot. PURE: takes parsed {rows, columns} objects, returns the derived
 * state. No I/O, no `this`.
 *
 * @param {{rows:Array<object>, columns:string[]}} recipes
 * @param {{rows:Array<object>, columns:string[]}} ingredients
 * @param {{rows:Array<object>, columns:string[]}} recipeIngredients
 * @returns {{csvHeaders:object, ingredientMaster:Array<object>, maxRecipeIdAtSessionStart:number}}
 */
function deriveSessionStateFromCsvs(recipes, ingredients, recipeIngredients) {
  // D-26 / CR-03 — fail loud with a plain-language column-name error BEFORE
  // any parseInt(NaN) sneaks into the master and corrupts the schema's enum.
  // The check is case-sensitive on the literal column header "ingredient_id";
  // a misnamed column (e.g. "Ingredient_ID", "ingredient id") trips this.
  if (!ingredients.columns.includes('ingredient_id')) {
    throw new Error(
      "The ingredients.csv file is missing the 'ingredient_id' column. " +
      "Found columns: " + ingredients.columns.join(', ') + ". " +
      "Rename or add the ingredient_id column and import again."
    );
  }

  // Derive ingredient master from ingredients.csv per the Phase 1 interface
  // contract. Allergens are stored semicolon-separated in v2; if a future
  // master uses a different separator we'll see it in the rendered form and
  // can adjust here. Empty/whitespace allergens are filtered out.
  //
  // D-26 / CR-03 — skip rows where ingredient_id is blank or whitespace.
  // parseInt('   ', 10) returns NaN, NaN serializes to null in JSON.stringify,
  // and the schema's enum then carries duplicate-null entries that produce a
  // misleading HTTP 400. The skip-blank-row guard prevents NaN from entering
  // the master in the first place.
  const ingredientMaster = [];
  for (const r of ingredients.rows) {
    if (String(r.ingredient_id ?? '').trim() === '') continue;
    ingredientMaster.push({
      ingredient_id: parseInt(r.ingredient_id, 10),
      ingredient_name: r.ingredient_name,
      // quick 260623-fjq — tolerant split on BOTH ';' and ',' so legacy
      // comma-joined cells (e.g. Soy Sauce's "Gluten,Soya", written before the
      // ';'-join contract) parse into valid FSA-14 tokens, not one bad token.
      // The write path (.join(';')) normalises the cell to ';' on next save.
      allergens: (r.allergens ?? '')
        .split(/[;,]/)
        .map(s => s.trim())
        .filter(Boolean),
      // quick 260607-c65 — master loads shopping_unit, defaults metric for any
      // pre-migration / blank / out-of-enum cell so an un-migrated folder still
      // loads and the master is never missing the field.
      shopping_unit: (function () {
        const v = (r.shopping_unit ?? '').trim();
        return v === 'metric' || v === 'whole' ? v : 'metric';
      })(),
      // quick 260612-esy — Phase B: master loads scale_category, clamped to a
      // valid category (trimmed + lowercased) else BLANK. Unlike shopping_unit
      // (which defaults to 'metric'), the fallback is '' NOT a category — a blank
      // tag means "use the name heuristic at scale time" (Phase A preserved), so
      // an untagged row stays heuristic-driven and a future heuristic tweak still
      // reaches it. A pre-migration / blank / out-of-enum cell loads as ''.
      scale_category: (function () {
        const v = (r.scale_category ?? '').trim().toLowerCase();
        return isValidScaleCategory(v) ? v : '';
      })(),
      // quick 260614-eqa — master loads pantry_staple as a BOOLEAN; a pre-migration
      // / blank / non-TRUE cell loads as false (default = not a staple), so an
      // un-migrated file still loads and behaves exactly as before.
      pantry_staple: (r.pantry_staple ?? '').trim().toUpperCase() === 'TRUE',
      // quick 260615-e1n — master loads pantry_section as a STRING (the storage
      // location). Keep the literal verbatim — do NOT clamp to the current curated
      // list (accepted cut-corner: a leftover/renamed-out value renders under its own
      // header). A pre-migration / blank cell loads as ''.
      pantry_section: (r.pantry_section ?? '').trim(),
      // quick 260615-f3o — master loads pack_size/pack_unit (read-only, additive)
      // so combinedShoppingList can show the on-screen pack count. Parse rule is
      // VERBATIM from openShoppingExport's packById (blank/whitespace size -> null,
      // else Number(); unit trimmed). No clamp/validate here beyond null-on-blank —
      // finiteness/>0 is checked at count time, matching the export. reloadMasterFromDisk
      // re-derives through this same path so post-edit/post-import reload inherits them.
      pack_size: (String(r['1st_pack_size'] ?? '').trim() === '')
        ? null
        : Number(r['1st_pack_size']),
      pack_unit: String(r['1st_pack_unit'] ?? '').trim(),
      // quick 260615-kid — master loads pack_units (sub-units per ONE orderable
      // 1st-pack, e.g. 4 cans) + pack_unit_label (the sub-unit name, e.g. "can").
      // pack_units mirrors pack_size's parse (finite Number or null; finiteness/>=1
      // checked at display time in formatPackLine); pack_unit_label mirrors pack_unit
      // (trimmed string). A pre-migration / blank cell loads null / '' respectively.
      pack_units: (String(r.pack_units ?? '').trim() === '')
        ? null
        : Number(r.pack_units),
      pack_unit_label: String(r.pack_unit_label ?? '').trim(),
      // phase 08 / REG-01 — master loads regular as a BOOLEAN (exactly like
      // pantry_staple; a pre-migration / blank / non-TRUE cell loads as false =
      // default not-a-regular) and regular_qty_per_person as NUMBER-OR-NULL
      // (exactly like pack_size; blank/absent -> null = "no rate set", NOT 0 — a
      // blank rate is deliberately distinct from an explicit 0). The rate is in
      // the ingredient's pack_size unit; read by the regulars buying layer.
      regular: (r.regular ?? '').trim().toUpperCase() === 'TRUE',
      regular_qty_per_person: (String(r.regular_qty_per_person ?? '').trim() === '')
        ? null
        : Number(r.regular_qty_per_person),
      // quick 260625-cg8 — master loads link1 (the ingredient's 1st_link buy URL)
      // as a read-only ADDITIVE projection field, mirroring the pack_size additive
      // load. The combined shopping list reads it to open the buy link in a new tab
      // on a name-click. NOT a v2 CSV schema / write-path change — link1 is in-memory
      // only; blank/absent loads as '' (no link → renders as plain non-clickable text).
      link1: String(r['1st_link'] ?? '').trim()
    });
  }

  // Snapshot the largest existing recipe_id at session start. Plan 03's
  // Approve allocates `recipe_id = ++maxRecipeIdAtSessionStart` per Pitfall I.
  // Math.max(0, ...) covers an empty recipes.csv and skips NaN safely.
  const maxRecipeIdAtSessionStart = Math.max(
    0,
    ...recipes.rows
      .map(r => parseInt(r.recipe_id, 10))
      .filter(n => Number.isFinite(n))
  );

  return {
    csvHeaders: {
      recipes: recipes.columns,
      ingredients: ingredients.columns,
      recipe_ingredients: recipeIngredients.columns
    },
    ingredientMaster,
    maxRecipeIdAtSessionStart
  };
}

// ----------------------------------------------------------------------------
// Anthropic SDK wrapper (RESEARCH §Pattern 2)
// ----------------------------------------------------------------------------

/**
 * Construct an Anthropic SDK client. `dangerouslyAllowBrowser: true` is the
 * explicit opt-in required for direct browser-to-API calls — Anthropic
 * supports CORS for this pattern since Aug 2024 (RESEARCH §2a). The constructor
 * reads apiKey at call time so a freshly-saved key is picked up without reload.
 *
 * @param {string} apiKey
 * @returns {Anthropic}
 */
function makeClient(apiKey) {
  return new Anthropic({
    apiKey,
    dangerouslyAllowBrowser: true
  });
}

/**
 * Run one Anthropic Messages call with Structured Outputs.
 *
 * Verifies the schema locally with `assertNoOpenObjects` before the request,
 * sets `max_tokens` from the module constant, sends `output_config.format`
 * (NOT the legacy `output_format`), throws on truncation/refusal
 * (`stop_reason !== 'end_turn'`) so partial responses NEVER render as success
 * (RESEARCH §Pitfall B / API-03), and JSON.parses the guaranteed-valid text.
 *
 * Phase 2 / Plan 02-04 / API-07: returns `{ parsed, usage }` so the caller
 * can record the REAL post-call input/output token counts into the store
 * field actualUsage. The pre-call count_tokens estimate (count.js) is an
 * approximation; this captures ground truth for the user's billing audit.
 *
 * @param {{ apiKey: string, model: string, systemPrompt: string,
 *           userMessage: string, schema: object }} args
 * @returns {Promise<{ parsed: object, usage: { input_tokens: number, output_tokens: number } | null }>}
 *   — parsed JSON object matching the schema + the response.usage object
 *   from the Anthropic API (or null if the SDK omitted it).
 */
async function callLLM({ apiKey, model, systemPrompt, userMessage, schema }) {
  // Local linter — fails fast with a debug-friendly path rather than as an
  // Anthropic HTTP 400. RESEARCH §Pitfall A.
  assertNoOpenObjects(schema);

  const client = makeClient(apiKey);
  let response;
  try {
    response = await client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      output_config: {
        format: {
          type: 'json_schema',
          schema
        }
      }
    });
  } catch (e) {
    // 03-REVIEW WR-09 — tag the error with the actual model the call was
    // made against so mapToPlainLanguage's 404 branch can name the model
    // the user has selected (not the DEFAULT_MODEL constant). Anthropic's
    // SDK throws plain Error subclasses with .status / .name; mutating
    // .model is safe and survives the throw.
    if (e && typeof e === 'object') {
      try { e.model = model; } catch (_) { /* frozen error — ignore */ }
    }
    throw e;
  }

  // Pitfall B: refuse partial output. Possible stop_reason values:
  //   'end_turn'   — normal completion (the only acceptable value here)
  //   'max_tokens' — truncated; the JSON is structurally valid but content-short
  //   'refusal'    — model declined; content is a refusal message, not JSON
  //   'stop_sequence' — irrelevant for this call (we don't pass one)
  if (response.stop_reason !== 'end_turn') {
    if (response.stop_reason === 'max_tokens') {
      throw new Error('The recipe was too long for one parse. Try splitting it or pasting fewer notes.');
    }
    if (response.stop_reason === 'refusal') {
      throw new Error('The model declined to parse this. Check the recipe text for unusual content and try again.');
    }
    throw new Error(`Parse incomplete (stop_reason=${response.stop_reason}). Try a shorter recipe.`);
  }

  // Capture the real input/output token counts. Plan 02-04 / API-07 exposes
  // this on the store field actualUsage for DevTools-visibility (no UI in
  // Phase 2 per Claude's Discretion in 02-CONTEXT.md). Defensive `|| null`
  // covers an older SDK version that omits `.usage` — 0.97.1 always
  // includes it but the guard makes the contract drift-resistant.
  const usage = response.usage || null;

  // Structured Outputs guarantees the text is valid JSON conforming to the
  // schema, but we wrap defensively so a malformed-JSON surface (Pitfall: bug
  // in our schema or transient SDK weirdness) surfaces as a plain parse error.
  const text = response.content && response.content[0] && response.content[0].text;
  if (!text) {
    throw new Error("Anthropic's response had no text content. Try again.");
  }
  const parsed = JSON.parse(text);
  return { parsed, usage };
}

/**
 * Convert an SDK error or thrown Error into a plain-language string suitable
 * for the inline parseError banner. Plain-language strings come from
 * RESEARCH §2c verbatim — do not invent new phrasings.
 *
 * IMPORTANT: never concatenate `apiKey` into any returned string (T-02-03).
 *
 * @param {unknown} e
 * @returns {string}
 */
function mapToPlainLanguage(e) {
  if (!e) return 'Something went wrong. Try again.';

  // Errors we throw ourselves from callLLM — pass straight through.
  if (e instanceof Error && (
    e.message.startsWith('The recipe was too long') ||
    e.message.startsWith('The model declined') ||
    e.message.startsWith('Parse incomplete') ||
    e.message.startsWith("Anthropic's response had no text")
  )) {
    return e.message;
  }

  // Plan 02-03 — Valibot hard-reject messages already arrive in plain
  // English from validate.js / mapValibotIssue. The primary surface for
  // these is the inline red label next to the affected form field; this
  // pass-through branch is defensive insurance in case a hardError ever
  // escapes the inline path into parseError (e.g. a future code change
  // that uses hardErrors as a banner trigger). The two stable prefixes
  // come from validate.js — keep them in lock-step with that file.
  if (e instanceof Error && (
    (e.message.startsWith('Row ') && e.message.includes('is missing the recipe text')) ||
    e.message.startsWith('The source URL looks wrong:')
  )) {
    return e.message;
  }

  // Anthropic SDK shapes a wide range of failure modes. Status codes follow
  // HTTP semantics; e.name covers the network/transport class.
  const status  = e && e.status;
  const name    = e && e.name;
  const message = (e && e.message) ? String(e.message) : '';

  if (status === 401) {
    return 'Your Anthropic API key was rejected. Check it in Settings.';
  }
  if (status === 429) {
    return 'Anthropic asked us to slow down. Wait a moment and try again.';
  }
  // 404 with a "model" hint — most likely the user's account doesn't have
  // access to the requested model yet.
  // 03-REVIEW WR-09 — callLLM tags the thrown error with .model = the
  // actual model the call was made against (which is `this.selectedModel`,
  // NOT the DEFAULT_MODEL constant). Use that to name the model the user
  // is being told is unavailable; fall back to DEFAULT_MODEL if absent
  // (e.g. an Anthropic 404 from a code path that doesn't go through
  // callLLM, or a frozen error object).
  if (status === 404 && /model/i.test(message)) {
    const erroredModel = (e && e.model) || DEFAULT_MODEL;
    return `Your Anthropic account doesn't have access to the model "${erroredModel}". Pick a different model in Settings, or edit DEFAULT_MODEL near the top of app.js.`;
  }
  if (status === 400) {
    return "There's a bug in the schema our tool sent. (Tell the dev.)";
  }
  if (name === 'APIConnectionError' || name === 'TypeError' || /fetch|network/i.test(message)) {
    return "Couldn't reach Anthropic. Are you online?";
  }
  if (e instanceof SyntaxError) {
    return "There's a bug in the schema our tool sent. (Tell the dev.) Anthropic returned text we couldn't parse.";
  }
  // Last-resort generic phrasing. We deliberately do NOT inline the raw
  // message (could echo back key material in unexpected error shapes).
  return 'Something went wrong calling Anthropic. Try again.';
}

/**
 * Build a SAFE, copyable detail string from an Anthropic SDK error for the
 * "Copy error" button (quick 260618-jr7). This is the raw-detail counterpart to
 * mapToPlainLanguage's friendly banner text — it surfaces the schema-validation
 * message a 400 carries so a dev can paste it without digging in DevTools.
 *
 * T-02-03 (load-bearing): the apiKey is only ever a REQUEST header — it is NOT
 * present in the SDK error's response body, `.error`, or `.message` for a 4xx.
 * We therefore read ONLY specific named fields and NEVER `JSON.stringify(e)` /
 * `e.headers` wholesale (which could echo request headers in some SDK shapes).
 * The request-id is pulled by its exact key only.
 *
 * @param {unknown} e
 * @returns {string} multi-line detail, or '' when nothing useful/safe is present.
 */
function extractErrorDetail(e) {
  if (!e || typeof e !== 'object') return '';

  const status = e.status;
  // Anthropic's structured body: { type: 'error', error: { type, message } }.
  const apiType = e.error && e.error.error && e.error.error.type;
  const apiMsg  = e.error && e.error.error && e.error.error.message;
  // SDK-composed message — safe for a structured 4xx (the schema text, no key).
  const sdkMsg  = typeof e.message === 'string' ? e.message : '';
  // Request id by EXACT key only — never enumerate headers.
  let requestId = e.request_id;
  if (!requestId && e.headers) {
    if (typeof e.headers.get === 'function') requestId = e.headers.get('request-id');
    else if (typeof e.headers === 'object') requestId = e.headers['request-id'];
  }
  const model = e.model;

  const lines = [];
  if (status != null) lines.push(`status: ${status}`);
  if (apiType) lines.push(`type: ${apiType}`);
  // Prefer the structured API message; fall back to the SDK message only if the
  // structured one is absent (both are schema/validation text, never the key).
  const message = apiMsg || sdkMsg;
  if (message) lines.push(`message: ${message}`);
  if (requestId) lines.push(`request_id: ${requestId}`);
  if (model) lines.push(`model: ${model}`);

  if (lines.length === 0) return '';
  return ['Anthropic error', ...lines].join('\n');
}

/**
 * Map the form's recipe header to an object whose keys MATCH the captured
 * `csvHeaders.recipes` order. Critical: the live recipes.csv column is
 * literally `main/side/salad` (with slashes); the form field is the
 * underscore form `main_side_salad` (JSON-friendly). The function picks the
 * right source per disk column.
 *
 * Defensive contract: walk `capturedColumns` and emit a value for EVERY
 * column. Any column not explicitly mapped gets an explicit empty string ''
 * — NEVER `undefined`, because Papa.unparse with `columns:` would silently
 * write a blank cell for missing keys (which is a silent-data-loss
 * foot-gun).
 *
 * Allergens convention: the form's `form.header.allergens` is an Array
 * (FSA14 checkbox group writes a Set-like array). The live recipes.csv uses
 * semicolon-joined strings for multi-valued cells (matching the ingredient
 * master allergen convention in ingredients.csv).
 *
 * @param {object} formHeader
 * @param {number} recipeId
 * @param {Array<string>} capturedColumns
 * @returns {object} — keyed exactly by `capturedColumns`.
 */
function toHeaderCsvRow(formHeader, recipeId, capturedColumns) {
  // Detect the literal `main/side/salad` column (with slash) — Pitfall E.
  const hasSlashColumn = capturedColumns.includes('main/side/salad');
  if (!hasSlashColumn && !capturedColumns.includes('main_side_salad')) {
    // Either: an unrecognized schema variant, or the user has a CSV that
    // never had a main/side/salad column. Warn once so a future executor
    // can trace the mismatch from the console.
    console.warn(
      "toHeaderCsvRow: csvHeaders.recipes contains neither 'main/side/salad' " +
      "nor 'main_side_salad' — the recipe type will not be written to disk."
    );
  }

  // Convert allergens (Array of FSA14 strings) to a semicolon-joined string
  // matching the ingredients.csv convention. Non-array values are stringified
  // as-is — covers the rare case where the user-edit produced a plain string.
  let allergensCell = '';
  const a = formHeader.allergens;
  if (Array.isArray(a)) {
    allergensCell = a.filter(Boolean).join(';');
  } else if (a != null) {
    allergensCell = String(a);
  }

  // Start with every captured column set to '' — overwrite known keys below.
  // This is the defensive pattern from the Plan: never let Papa.unparse fill
  // blanks; we are the source of truth for every cell.
  const out = {};
  for (const col of capturedColumns) out[col] = '';

  // Map known disk columns to form fields. `?? ''` everywhere so we never
  // produce `undefined` for a known column with a missing form field.
  const map = {
    recipe_id:        csvNumber(recipeId),
    name:             formHeader.name ?? '',
    // NOTE: `prep` is NOT mapped here — the live recipes.csv column is
    // `prep_notes`, but the in-memory/form/schema key is `prep` (boundary-
    // translated like `main/side/salad`, see below). Keying it `prep` here
    // would silently drop it (the disk column isn't `prep`) → blank prep_notes.
    instructions_20:  formHeader.instructions_20 ?? '',
    ingredients_20:   formHeader.ingredients_20 ?? '',
    source:           formHeader.source ?? '',
    max_servings:     csvNumber(formHeader.max_servings),
    popularity:       csvNumber(formHeader.popularity),
    difficulty:       csvNumber(formHeader.difficulty),
    last_made:        formHeader.last_made ?? '',
    serve_with:       formHeader.serve_with ?? '',
    popularity_notes: formHeader.popularity_notes ?? '',
    difficulty_notes: formHeader.difficulty_notes ?? '',
    allergens:        allergensCell
  };
  for (const k of Object.keys(map)) {
    if (k in out) out[k] = map[k];
  }

  // The slash column (`main/side/salad`) is the special case — write to
  // whichever variant the live CSV actually uses.
  if (hasSlashColumn) {
    out['main/side/salad'] = formHeader.main_side_salad ?? '';
  } else if ('main_side_salad' in out) {
    out['main_side_salad'] = formHeader.main_side_salad ?? '';
  }

  // `prep` is the same disk-vs-memory split as `main/side/salad`: the live
  // recipes.csv column is `prep_notes`, but the in-memory/form/schema key is
  // `prep`. Write the prep value to whichever column the captured header has —
  // `prep_notes` (current contract) if present, else the legacy `prep` column.
  // Without this the prep notes are silently dropped on every Approve/save.
  const prepValue = formHeader.prep ?? '';
  if ('prep_notes' in out) {
    out['prep_notes'] = prepValue;
  } else if ('prep' in out) {
    out['prep'] = prepValue;
  }

  return out;
}

/**
 * Map one form row to an object keyed by the captured `recipe_ingredients`
 * disk columns. Handles two schema variants:
 *
 *   (a) Legacy-headers case (user's verified live file, 2026-05-22):
 *       columns include the booleans `is_optional`, `is_garnish`,
 *       `is_to_taste` and NOT `role`. We derive each boolean from
 *       `formRow.role` and emit the literal strings 'TRUE'/'FALSE'.
 *       `canonical_name` is emitted as '' — Phase 1 has no canonical-name
 *       logic; that lives in Phase 4's add-new flow.
 *
 *   (b) v2-headers case: columns include `role` and NOT the three booleans.
 *       We emit `role` directly.
 *
 *   (c) Both columns present: write both (role authoritative, derive
 *       booleans for legacy compatibility).
 *
 *   (d) Neither present: throw a plain-language error — the schema is
 *       unrecognized.
 *
 * Defensive contract: same as toHeaderCsvRow — initialize every column to
 * '' first, then overwrite known keys. Never rely on Papa.unparse to fill
 * blanks (silent-data-loss path).
 *
 * Other special cases:
 *   - `ingredient_id` == null → empty string (D-13, no add-new flow in
 *     Phase 1; the row gets written with a blank ingredient_id cell).
 *   - `flag_fix_me` boolean → 'TRUE'/'FALSE' string (legacy CSV convention
 *     matching the live recipe_ingredients.csv).
 *
 * @param {object} formRow
 * @param {number} recipeId
 * @param {Array<string>} capturedColumns
 * @returns {object} — keyed exactly by `capturedColumns`.
 */
function toJoinCsvRow(formRow, recipeId, capturedColumns) {
  const hasRoleCol     = capturedColumns.includes('role');
  const hasIsOptional  = capturedColumns.includes('is_optional');
  const hasIsGarnish   = capturedColumns.includes('is_garnish');
  const hasIsToTaste   = capturedColumns.includes('is_to_taste');
  const hasAnyBoolean  = hasIsOptional || hasIsGarnish || hasIsToTaste;

  if (!hasRoleCol && !hasAnyBoolean) {
    throw new Error(
      "Couldn't write delta CSV: live recipe_ingredients.csv has no 'role' " +
      "column and no 'is_optional/is_garnish/is_to_taste' columns. The schema " +
      "is unrecognized."
    );
  }

  // Initialize every captured column to '' so any unmapped column is an
  // explicit blank cell (defensive pattern — see toHeaderCsvRow).
  const out = {};
  for (const col of capturedColumns) out[col] = '';

  // Common fields shared between both schema variants. Numeric cells route
  // through csvNumber() so NaN (from x-model.number on a cleared input) maps
  // to '' instead of the literal three-character string "NaN" (D-27 / WR-07).
  const map = {
    recipe_id:       csvNumber(recipeId),
    line_order:      csvNumber(formRow.line_order),
    ingredient_id:   csvNumber(formRow.ingredient_id),   // D-13 + D-27
    ingredient_name: formRow.ingredient_name ?? '',
    // quick 260607-anu — four-column quantity contract. csvNumber maps
    // null/NaN → '' (D-27); the volumetric pair writes '' when not populated.
    quantity_metric:     csvNumber(formRow.quantity_metric),
    unit_metric:         formRow.unit_metric ?? '',
    quantity_volumetric: csvNumber(formRow.quantity_volumetric),
    unit_volumetric:     formRow.unit_volumetric ?? '',
    section:         formRow.section   ?? '',
    prep_note:       formRow.prep_note ?? '',
    raw_text:        formRow.raw_text  ?? '',
    flag_fix_me:     formRow.flag_fix_me ? 'TRUE' : 'FALSE'
  };
  for (const k of Object.keys(map)) {
    if (k in out) out[k] = map[k];
  }

  // Role-vs-legacy-booleans branch.
  if (hasRoleCol) {
    out['role'] = formRow.role ?? '';
  }
  if (hasIsOptional) {
    out['is_optional'] = (formRow.role === 'optional') ? 'TRUE' : 'FALSE';
  }
  if (hasIsGarnish) {
    out['is_garnish']  = (formRow.role === 'garnish')  ? 'TRUE' : 'FALSE';
  }
  if (hasIsToTaste) {
    out['is_to_taste'] = (formRow.role === 'to_taste') ? 'TRUE' : 'FALSE';
  }

  // canonical_name: Phase 1 has NO canonical-name logic (Phase 4 territory).
  // The column exists in the user's legacy live CSV; we write '' explicitly.
  if ('canonical_name' in out) {
    out['canonical_name'] = '';
  }

  return out;
}

/**
 * Phase 4 / Plan 04-04 / D-53 — Map one in-session new ingredient entry to
 * an object keyed by the captured `ingredients.csv` disk columns. Mirrors
 * toHeaderCsvRow / toJoinCsvRow's defensive-init-every-column pattern so
 * any unmapped column (supplier, shopping links, legacy extras) writes as
 * an explicit blank cell rather than `undefined`.
 *
 * Allergens cell: array values joined by ';' (matches loadLiveCsvs L257-L260
 * split convention — the disk CSV's allergens column is semicolon-separated
 * inside a single CSV cell; PapaParse handles RFC 4180 quoting).
 *
 * Numeric cells (ingredient_id, 1st_pack_size) route through csvNumber()
 * so NaN/null become '' (D-27 / WR-07).
 *
 * @param {object} newIngredient — { ingredient_id, ingredient_name, allergens: string[], pack_size?: number, pack_unit?: string }
 * @param {Array<string>} capturedColumns — column order captured at session load
 * @returns {object} — keyed exactly by `capturedColumns`
 */
function toIngredientCsvRow(newIngredient, capturedColumns) {
  // Defensive: init every column to '' so any column the map doesn't
  // explicitly handle becomes a blank cell (not undefined).
  const out = {};
  for (const col of capturedColumns) out[col] = '';

  // Allergens cell — array joined by ';' per loadLiveCsvs convention.
  let allergensCell = '';
  const a = newIngredient.allergens;
  if (Array.isArray(a)) {
    allergensCell = a.filter(Boolean).join(';');
  } else if (a != null) {
    allergensCell = String(a);
  }

  // Known disk-column mappings. Numeric fields route through csvNumber().
  // The '1st_pack_size' / '1st_pack_unit' / 'supplier' fields exist in the
  // user's live ingredients.csv schema and may or may not be present per
  // session — the in/out guard below ensures we only write them when the
  // captured columns include the matching key.
  const map = {
    ingredient_id: csvNumber(newIngredient.ingredient_id),
    ingredient_name: newIngredient.ingredient_name ?? '',
    allergens: allergensCell,
    '1st_pack_size': newIngredient.pack_size != null ? csvNumber(newIngredient.pack_size) : '',
    '1st_pack_unit': newIngredient.pack_unit ?? '',
    supplier: '',
    // quick 260607-c65 — shopping_unit cell (defensive enum clamp). Only written
    // when the captured ingredients columns include 'shopping_unit' (the in/out
    // guard below); a pre-migration captured header that lacks it silently skips
    // — the merge old-schema refusal (_prepareMergeContext) catches that mismatch.
    shopping_unit: isShoppingUnitValue(newIngredient.shopping_unit) ? newIngredient.shopping_unit : 'metric',
    // quick 260612-esy — Phase B: scale_category cell (defensive clamp). Valid
    // (trimmed + lowercased) else BLANK ('' = use the name heuristic at scale
    // time). Only written when the captured columns include 'scale_category' (the
    // in/out guard below) — a pre-migration captured header never gains a phantom
    // column (T-esy-04).
    scale_category: isValidScaleCategory(newIngredient.scale_category)
      ? newIngredient.scale_category.trim().toLowerCase()
      : '',
    // quick 260614-eqa — pantry_staple cell ('TRUE' / blank). Only written when the
    // captured columns include 'pantry_staple' (the in/out guard below) — a
    // pre-migration captured header never gains a phantom column (T-eqa-02 /
    // T-esy-04 equivalent).
    pantry_staple: newIngredient.pantry_staple ? 'TRUE' : '',
    // quick 260615-e1n — pantry_section cell (the storage-location string / blank).
    // Only written when the captured columns include 'pantry_section' (the in/out
    // guard below) — a pre-migration captured header never gains a phantom column
    // (T-e1n-02).
    pantry_section: newIngredient.pantry_section ?? '',
    // quick 260615-kid — pack_units (finite number cell / blank) + pack_unit_label
    // (the sub-unit name string / blank). Only written when the captured columns
    // include each key (the in/out guard below) — a pre-migration captured header
    // never gains a phantom column (BLOCKER-PREEMPT #2, T-kid-04).
    pack_units: newIngredient.pack_units != null && newIngredient.pack_units !== '' ? csvNumber(newIngredient.pack_units) : '',
    pack_unit_label: newIngredient.pack_unit_label ?? '',
    // phase 08 / REG-01 — regular ('TRUE' / blank, exactly like pantry_staple) +
    // regular_qty_per_person (finite number cell / blank, mirroring pack_units;
    // blank = no rate set). Only written when the captured columns include each
    // key (the in/out guard below) — a pre-migration captured header never gains a
    // phantom column (T-08-01).
    regular: newIngredient.regular ? 'TRUE' : '',
    regular_qty_per_person: newIngredient.regular_qty_per_person != null && newIngredient.regular_qty_per_person !== '' ? csvNumber(newIngredient.regular_qty_per_person) : ''
  };
  for (const k of Object.keys(map)) {
    if (k in out) out[k] = map[k];
  }
  return out;
}

// ----------------------------------------------------------------------------
// Module-level helpers used by blankRow / parse / toJoinCsvRow (Plan 02-01)
// ----------------------------------------------------------------------------

// D-25 / CR-02 / Pitfall Q — synthetic, focus-stable x-for key.
// Allocated in blankRow() AND assigned to every LLM-returned row in parse().
// The integer counter is monotonically increasing and never reused; Alpine's
// reactivity reseats rows only when this key changes, so editing line_order
// no longer drops focus mid-keystroke. Stays a `let` (not const) because the
// counter is incremented in nextRowKey().
let _nextRowKey = 1;
function nextRowKey() { return _nextRowKey++; }

// D-27 / WR-07 — delta-CSV numeric routing helper.
// `x-model.number` on a cleared input produces NaN; the previous
// `String(NaN)` path wrote the literal three-character string "NaN" to disk.
// This helper maps null AND NaN to '' (empty cell) and stringifies everything
// else. Used by toJoinCsvRow + toHeaderCsvRow for every numeric column. Do
// NOT route through `Number(v)` first — the safety property is that NaN
// becomes empty, not that the value is re-coerced.
function csvNumber(v) {
  return (v == null || Number.isNaN(v)) ? '' : String(v);
}

/**
 * Construct a fresh blank row for the "+ Add row" button. Assigns
 * `line_order = max(...existing, 0) + 1` so the synthetic line_order is
 * unique. The `_key` is the focus-stable synthetic key consumed by Alpine's
 * x-for :key binding (D-25 / Pitfall Q) — it is monotonically allocated by
 * nextRowKey() and silently dropped by toJoinCsvRow's allow-list so it
 * never reaches disk. Defaults match what the LLM would have emitted for an
 * unknown ingredient.
 *
 * @param {object} form — the reactive form (form.rows).
 * @returns {object} — a new row object.
 */
function blankRow(form) {
  const nextLineOrder = Math.max(
    0,
    ...form.rows.map(r => r.line_order ?? 0)
  ) + 1;
  return {
    _key: nextRowKey(),    // D-25 — synthetic, focus-stable x-for key (dropped on write)
    // quick 260607-bru — transient session-only review marker. Confirming a row
    // sets this true (collapses it to a one-liner + drops it to the sort bottom);
    // any edit re-opens it. Dropped on write like _key (allow-list serializers
    // never see it — see persistInflight strip + toJoinCsvRow columns:).
    _confirmed: false,
    line_order: nextLineOrder,
    ingredient_id: null,
    ingredient_name: '',
    // quick 260607-anu — four-column quantity contract. Metric pair defaults
    // populated (matches the always-populated contract); volumetric pair null.
    quantity_metric: 0,
    unit_metric: 'g',
    quantity_volumetric: null,
    unit_volumetric: null,
    section: '',
    prep_note: '',
    role: 'required',
    raw_text: '',
    flag_fix_me: false,
    // 04-REVIEW CR-01 — Stage-2 RecipeRowSchema (validate.js:96) requires
    // flagged_fields as a non-nullable array; without it, Approve's CR-03
    // re-validation hard-rejects every hand-added row. LLM rows carry [] per
    // the system-prompt contract; hand-added rows must match.
    flagged_fields: []
  };
}

/**
 * deriveRawTextFromRow — quick-260621-bhx (manual-add ONLY). Synthesize a
 * schema-faithful, non-empty raw_text for a hand-entered ingredient row that
 * has no pasted source line. Composes "{qty} {unit} {name}{, prep_note}",
 * preferring the volumetric quantity+unit pair when present, else the metric
 * pair. Used by saveNewRecipe BEFORE validation so the v2 schema's non-empty
 * raw_text contract is met without forcing redundant manual entry.
 *
 * Pure (does not read `this`); never mutates the row. Returns a trimmed,
 * collapsed-whitespace string. Falls back to the bare ingredient_name (always
 * present for a "real" row by the time this is called).
 */
function deriveRawTextFromRow(row) {
  if (!row) return '';
  const name = (row.ingredient_name == null ? '' : String(row.ingredient_name)).trim();
  const prep = (row.prep_note == null ? '' : String(row.prep_note)).trim();

  // Prefer the volumetric pair, else metric. A quantity counts as present if it
  // is a finite, > 0 number (0 / null / blank → omit the qty+unit prefix).
  const volQty = Number(row.quantity_volumetric);
  const volUnit = (row.unit_volumetric == null ? '' : String(row.unit_volumetric)).trim();
  const metQty = Number(row.quantity_metric);
  const metUnit = (row.unit_metric == null ? '' : String(row.unit_metric)).trim();

  let qtyPart = '';
  if (row.quantity_volumetric != null && Number.isFinite(volQty) && volQty > 0) {
    qtyPart = volUnit ? `${volQty} ${volUnit}` : `${volQty}`;
  } else if (row.quantity_metric != null && Number.isFinite(metQty) && metQty > 0) {
    qtyPart = metUnit ? `${metQty} ${metUnit}` : `${metQty}`;
  }

  let out = qtyPart ? `${qtyPart} ${name}` : name;
  if (prep) out = `${out}, ${prep}`;
  return out.replace(/\s+/g, ' ').trim();
}

// ----------------------------------------------------------------------------
// REVIEW-07 (Plan 03-03) — click-to-source highlight helpers (module-scope)
// ----------------------------------------------------------------------------
// Two pure helpers consumed by the Alpine factory's highlightSource action.
// Kept at module-scope so they're trivially unit-testable and stay outside the
// reactive proxy boundary — neither helper reads `this`. The D-29 algorithm
// (whitespace-normalize + case-sensitive exact substring search) is the
// canonical user-locked matching strategy; the cap-3 + idempotency contract
// in tryAddFlaggedField mirrors validate.js Stage 3 (D-35).

/**
 * REVIEW-07 / D-29 — find the 0-based line index of `rowRawText` inside
 * `rawText`, after collapsing runs of whitespace (`\s+` → single space) on
 * BOTH sides. Case-sensitive. Returns -1 on no-match (including empty inputs
 * or empty needle after normalization).
 *
 * The whitespace-normalize on both haystack and needle handles the realistic
 * deviation between the user's paste and the LLM's verbatim raw_text emission
 * (trailing-space trim, double-space → single, embedded tab → space). The
 * function is split-then-search rather than concat-then-search so the return
 * value is a line index (consumed by data-line-index in the <pre> template),
 * not a character offset.
 *
 * @param {string} rawText — the full raw paste (multi-line)
 * @param {string} rowRawText — the row's raw_text field (typically one line)
 * @returns {number} — 0-based line index, or -1 on no-match
 */
function findSourceLineIndex(rawText, rowRawText) {
  if (!rawText || !rowRawText) return -1;
  const needle = rowRawText.replace(/\s+/g, ' ').trim();
  if (!needle) return -1;
  const lines = rawText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const haystack = lines[i].replace(/\s+/g, ' ').trim();
    if (haystack.includes(needle)) return i;
  }
  return -1;
}

// Mirrors validate.js MAX_FLAGGED_FIELDS_PER_ROW (D-35) — kept in sync manually;
// runtime-side cap for highlight path post-parse. If validate.js ever moves the
// cap to a non-3 value, change this in lockstep.
const MAX_FLAGGED_FIELDS_PER_ROW_APP = 3;

/**
 * REVIEW-07 no-match path + Pitfall "no-match dropping flagged_fields entries
 * on idempotency check" — RESEARCH §Common Pitfalls.
 *
 * Push a `{field, reason_code}` entry onto `row.flagged_fields` ONLY if no
 * existing entry already matches that (field, reason_code) tuple — idempotent.
 * Auto-ticks `row.flag_fix_me = true` on every push (D-36 parity). If the push
 * brings the row's flagged_fields length over MAX_FLAGGED_FIELDS_PER_ROW_APP,
 * flips `row._needsFullReview = true` so the per-field marker template
 * suppresses individual borders and renders the "Needs full review" pill
 * instead (D-35 cap-3 transition). Defensive: initializes a missing/non-array
 * flagged_fields to []  before the idempotency check (matches validate.js
 * Stage 3 defensive init).
 *
 * Canonical post-parse mutation path for flagged_fields — any future code
 * adding flags after parse (Phase 4 unknown-ingredient flow, future header-
 * level flags) should route through this helper, not direct .push().
 *
 * @param {object} row — a form.rows[] element (must carry _key for downstream
 *                       getter lookups; not mutated by this helper)
 * @param {string} field — one of FLAGGED_FIELD_NAME_ENUM
 * @param {string} reason — one of REASON_CODE_ENUM
 * @returns {boolean} — true if pushed, false if idempotent no-op
 */
/**
 * Phase 4 / Plan 04-04 / D-56 — case-insensitive substring keyword lookup.
 *
 * Walks the lookup table (the parsed contents of allergen-keywords.json or
 * its localStorage override) and returns a Map<allergen, keyword> of every
 * FSA-14 allergen any matching keyword would imply, paired with the FIRST
 * keyword that triggered each allergen (used by the soft-block warning
 * copy to name which keyword fired). Module-scope (NOT on the factory) —
 * the helper has no `this` dependency.
 *
 * Defensive against bad input: a null/undefined name returns an empty Map;
 * a non-array lookup is treated as empty; a malformed entry (missing
 * keyword or allergens) is skipped (no throw).
 *
 * @param {string} name — the ingredient name being typed in the Add-new form
 * @param {Array<{keyword: string, allergens: string[]}>} lookup
 * @returns {Map<string, string>} — allergen → matched-keyword (first hit wins)
 */
function findKeywordHits(name, lookup) {
  const lower = (name || '').toLowerCase();
  const hits = new Map();
  if (!Array.isArray(lookup) || !lower) return hits;
  for (const entry of lookup) {
    if (!entry || typeof entry.keyword !== 'string' || !Array.isArray(entry.allergens)) continue;
    if (lower.includes(entry.keyword.toLowerCase())) {
      for (const allergen of entry.allergens) {
        if (!hits.has(allergen)) hits.set(allergen, entry.keyword);
      }
    }
  }
  return hits;
}

function tryAddFlaggedField(row, field, reason) {
  if (!Array.isArray(row.flagged_fields)) row.flagged_fields = [];
  const exists = row.flagged_fields.some(f => f.field === field && f.reason_code === reason);
  if (!exists) {
    row.flagged_fields.push({ field, reason_code: reason });
    row.flag_fix_me = true;  // D-36 auto-tick parity
  }
  // 03-REVIEW WR-06 — ALWAYS reflect the current length, idempotently. The
  // previous "only flip _needsFullReview when our own push crosses the cap"
  // logic missed the cap-3 state when the row already arrived with 4+
  // entries (e.g. from a restored payload that bypassed Stage 3, or a
  // future code path that bypasses this helper). Computing
  // _needsFullReview from the actual flagged_fields.length makes the
  // helper safe to call on any row at any time — Stage 3's invariant
  // re-converges on every call.
  row._needsFullReview = row.flagged_fields.length > MAX_FLAGGED_FIELDS_PER_ROW_APP;
  return !exists;
}

// ----------------------------------------------------------------------------
// Phase 4 (Plan 04-02) — Fuse.js options + thresholds (D-48 / D-55)
// ----------------------------------------------------------------------------
// Phase 4 D-48 / D-55 — Fuse threshold settings. Locked starting values per
// RESEARCH §Research Focus 2/3 + 04-CONTEXT Claude's Discretion. Planner can
// retune from the 10-recipe pilot if false-positives appear (RESEARCH Pitfall 3).
//   threshold: 0.4         — tighter than Fuse default 0.6; balances recall + precision
//   keys: ['ingredient_name'] — only key Phase 4 indexes (master shape)
//   includeScore: true     — required for top-3 sort + D-55 auto-resolve decision
//   minMatchCharLength: 2  — filter single-char noise (Pitfall 3)
//   ignoreLocation: true   — match anywhere ("olive oil, extra virgin" vs reversed)
//   isCaseSensitive: false — explicit; matches Fuse default
const FUSE_OPTIONS = Object.freeze({
  keys: ['ingredient_name'],
  threshold: 0.4,
  includeScore: true,
  minMatchCharLength: 2,
  ignoreLocation: true,
  isCaseSensitive: false
});

// Phase 4 D-48 / D-55 — Fuse threshold (planner can retune from 10-recipe pilot).
// Tighter than FUSE_OPTIONS.threshold per RESEARCH §Research Focus 3 — D-55
// auto-resolve must avoid false-positives that quietly mis-resolve cards.
// Plan 04-04 consumes this for the post-Add-new cascade; declared now for cohesion.
const AUTO_RESOLVE_THRESHOLD = 0.3;

// ----------------------------------------------------------------------------
// quick 260608-h1i — Duplicate-recipe detector: named tunable thresholds
// ----------------------------------------------------------------------------
// Soft, non-blocking nudge thresholds. All are tunable starting values — retune
// from real use if false-positives/negatives appear. Each is named + commented
// per the plan's "thresholds are named tunable constants" invariant.
//
// DUP_NAME_THRESHOLD — Fuse score cutoff for the recipe-NAME signal. Lower =
//   stricter. 0.35 is stricter than the ingredient-master FUSE_OPTIONS 0.4
//   because a name near-match is a strong duplicate signal and we want few
//   false positives. Tunable starting value.
const DUP_NAME_THRESHOLD = 0.35;

// DUP_NAME_FUSE_OPTIONS — mirrors FUSE_OPTIONS but keyed on the recipe 'name'
//   column and using the stricter DUP_NAME_THRESHOLD. Frozen so it can't drift.
const DUP_NAME_FUSE_OPTIONS = Object.freeze({
  keys: ['name'],
  threshold: DUP_NAME_THRESHOLD,
  includeScore: true,
  minMatchCharLength: 2,
  ignoreLocation: true,
  isCaseSensitive: false
});

// DUP_OVERLAP_THRESHOLD — Jaccard cutoff for the INGREDIENT-set signal
//   (intersection / union). 0.6 = "60% of the combined ingredient sets are
//   shared" before we nudge. Tunable starting value.
const DUP_OVERLAP_THRESHOLD = 0.6;

// DUP_OVERLAP_ABS_MIN — absolute-overlap floor: a big recipe and a small one can
//   never reach 0.6 Jaccard yet still be obvious duplicates. So ALSO fire when
//   at least DUP_OVERLAP_ABS_MIN ingredient_ids are shared AND that intersection
//   is >= 50% of the SMALLER set. Tunable starting value.
const DUP_OVERLAP_ABS_MIN = 5;

// DUP_MAX_CANDIDATES — cap the surfaced nudges so the banner never floods.
const DUP_MAX_CANDIDATES = 3;

/**
 * quick 260608-h1i — PURE duplicate matcher. No I/O, no `this`.
 *
 * Fuzzy-matches a parsed recipe's name (Fuse) AND its ingredient_id set
 * (Jaccard) against an in-memory index of existing recipes, returning up to
 * DUP_MAX_CANDIDATES soft-nudge candidates ranked by combined strength.
 *
 * FAIL-OPEN CONTRACT: a malformed/absent index (missing fields, null) yields
 * [] rather than throwing. This is load-bearing — the parse() hook also wraps
 * the call in try/catch, but the function itself must never throw.
 *
 * @param {string} name — parsed recipe name (may be blank/whitespace)
 * @param {Array<{ingredient_id:(number|null)}>} parsedRows — parsed form rows
 * @param {{recipeNameFuse?:object, recipeNameList?:Array<{recipe_id:number,name:string}>, ingredientIdsByRecipeId?:Map<number,Set<number>>}} index
 * @returns {Array<{recipe_id:number, name:string, reasons:string[]}>}
 */
function findDuplicateCandidates(name, parsedRows, index) {
  // Strength tiers (higher = ranked first): exact-name > fuzzy-name > ingredient.
  const TIER_EXACT_NAME = 3;
  const TIER_FUZZY_NAME = 2;
  const TIER_INGREDIENT = 1;

  // candidates: recipe_id -> { recipe_id, name, reasons:[], strength:number }
  const candidates = new Map();
  const recipeNameList = (index && Array.isArray(index.recipeNameList)) ? index.recipeNameList : [];
  // Resolve a display name for a recipe_id from the name list (fallback to Fuse hit name).
  const nameById = new Map(recipeNameList.map(r => [r.recipe_id, r.name]));

  const bump = (recipe_id, displayName, reason, tier, withinTier) => {
    let c = candidates.get(recipe_id);
    if (!c) {
      c = { recipe_id, name: displayName || nameById.get(recipe_id) || ('#' + recipe_id), reasons: [], strength: 0 };
      candidates.set(recipe_id, c);
    }
    if (displayName && (!c.name || c.name === ('#' + recipe_id))) c.name = displayName;
    if (reason && !c.reasons.includes(reason)) c.reasons.push(reason);
    // strength = tier weight + a small within-tier fraction (0..1) so higher
    // Jaccard / better Fuse score ranks higher inside its tier without ever
    // crossing into the next tier.
    const candidate = tier + Math.max(0, Math.min(1, withinTier || 0));
    if (candidate > c.strength) c.strength = candidate;
  };

  // ---- Name signal ----
  // Skip entirely if the name is blank/whitespace.
  const trimmedName = (name == null ? '' : String(name)).trim();
  if (trimmedName !== '') {
    const normalized = trimmedName.toLowerCase();
    // Exact normalized-equality FIRST — treat any exact match as top strength
    // regardless of Fuse score (Fuse can score an exact match imperfectly).
    for (const r of recipeNameList) {
      if (typeof r.name === 'string' && r.name.trim().toLowerCase() === normalized) {
        bump(r.recipe_id, r.name, 'near-identical name', TIER_EXACT_NAME, 1);
      }
    }
    // Then fuzzy — only if a Fuse instance is present in the index.
    const fuse = index && index.recipeNameFuse;
    if (fuse && typeof fuse.search === 'function') {
      let hits = [];
      try {
        hits = fuse.search(trimmedName) || [];
      } catch (_e) {
        hits = []; // fail-open: a Fuse failure must not throw out
      }
      for (const hit of hits) {
        const item = hit && hit.item;
        if (!item || typeof item.recipe_id === 'undefined') continue;
        const score = typeof hit.score === 'number' ? hit.score : 1;
        if (score > DUP_NAME_THRESHOLD) continue;
        // Don't downgrade an exact match already recorded for this id.
        if (candidates.has(item.recipe_id) && candidates.get(item.recipe_id).strength >= TIER_EXACT_NAME) continue;
        // withinTier: lower Fuse score = better match = higher rank.
        bump(item.recipe_id, item.name, 'similar name', TIER_FUZZY_NAME, 1 - score);
      }
    }
  }

  // ---- Ingredient signal ----
  const idMap = (index && index.ingredientIdsByRecipeId instanceof Map) ? index.ingredientIdsByRecipeId : null;
  if (idMap) {
    const parsedIds = new Set(
      (Array.isArray(parsedRows) ? parsedRows : [])
        .map(r => (r ? r.ingredient_id : null))
        .filter(Number.isFinite)
    );
    if (parsedIds.size > 0) {
      for (const [recipe_id, idSet] of idMap.entries()) {
        if (!(idSet instanceof Set) || idSet.size === 0) continue;
        let inter = 0;
        for (const id of parsedIds) if (idSet.has(id)) inter++;
        if (inter === 0) continue;
        const union = parsedIds.size + idSet.size - inter;
        const jaccard = union > 0 ? inter / union : 0;
        const smaller = Math.min(parsedIds.size, idSet.size);
        const absHit = inter >= DUP_OVERLAP_ABS_MIN && inter >= 0.5 * smaller;
        if (jaccard >= DUP_OVERLAP_THRESHOLD || absHit) {
          const pct = Math.round(jaccard * 100);
          const reason = pct + '% of ingredients match (' + inter + ' of ' + union + ')';
          // withinTier: higher Jaccard ranks higher among ingredient-only hits.
          bump(recipe_id, nameById.get(recipe_id), reason, TIER_INGREDIENT, jaccard);
        }
      }
    }
  }

  // ---- Combine, rank, cap ----
  return [...candidates.values()]
    .sort((a, b) => b.strength - a.strength)
    .slice(0, DUP_MAX_CANDIDATES)
    .map(c => ({ recipe_id: c.recipe_id, name: c.name, reasons: c.reasons }));
}
// end findDuplicateCandidates 260608-h1i

// ----------------------------------------------------------------------------
// Alpine factory — registered directly after ESM import, then Alpine.start() boots the runtime for <body x-data="app">.
// ----------------------------------------------------------------------------

Alpine.data('app', () => ({
  // ---------- SHELL state ----------
  // quick 260612-abt — chromiumSupported removed: the FSA folder picker is gone,
  // so the tool runs in any browser with IndexedDB (Chromium-only constraint relaxed).
  apiKey: localStorage.getItem('recipe_ingest_api_key') ?? '',
  apiKeyDraft: '',

  // Phase 07 (ROSTER-02) — the four Coda config values, each rebuilt from
  // localStorage at construction (NOT cached at module load — Plan 07-03's fetch
  // reads this.coda* FRESH at call time so a rotated token takes effect without a
  // reload; PATTERNS §"read-fresh-per-call"). LOCKED key names (CONTEXT fork 2).
  // Persistence is Save-button batch (saveCodaConfig) — NO per-field @change.
  // The *Draft siblings are re-seeded on every Settings open (goToView).
  codaApiToken: localStorage.getItem('coda_api_token') ?? '',
  codaApiTokenDraft: '',
  codaExportDocId: localStorage.getItem('coda_export_doc_id') ?? '',
  codaExportDocIdDraft: '',
  codaResidencyTableId: localStorage.getItem('coda_residency_table_id') ?? '',
  codaResidencyTableIdDraft: '',
  codaOnboardingTableId: localStorage.getItem('coda_onboarding_table_id') ?? '',
  codaOnboardingTableIdDraft: '',

  // Phase 10 (ACCESS-01/02) — the "Connect to shared database" config: the four
  // values that assemble the githubStore `cfg = {owner, repo, branch, token}`.
  // Mirrors the Coda four-field shape (live field + *Draft sibling, seeded on
  // Settings open, persisted on Save). Keys follow the DOMINANT
  // recipe_ingest_<purpose> convention (NOT the legacy bare coda_*). The branch
  // defaults to 'main' when its key is absent. The token CAN WRITE shared data
  // (Phase 11) — so disconnect() (D-08) is a prominent affordance, more so than
  // for the read-only Anthropic key. Read-fresh-per-call via the githubCfg
  // getter so a rotated token takes effect without a reload.
  githubOwner: localStorage.getItem('recipe_ingest_github_owner') ?? '',
  githubOwnerDraft: '',
  githubRepo: localStorage.getItem('recipe_ingest_github_repo') ?? '',
  githubRepoDraft: '',
  githubBranch: localStorage.getItem('recipe_ingest_github_branch') ?? 'main',
  githubBranchDraft: '',
  githubToken: localStorage.getItem('recipe_ingest_github_token') ?? '',
  githubTokenDraft: '',
  // Phase 11 (CHANGES-01, D-05/D-06) — the SELF-DECLARED name baked into every
  // push's commit message. All users share ONE fine-grained token (PROJECT.md),
  // so GitHub cannot distinguish authors; the "who" must live in the commit
  // MESSAGE, not the git author. Plain string in localStorage (same convention
  // as the token/Anthropic key — NOT a secret, it is attribution courtesy, not
  // authz). Independent of the connection: it is per-PERSON and survives a token
  // disconnect/rotation (disconnect() does NOT clear it). The D-07 block-save
  // guard (pushToRemote, isPushNameMissing) refuses a push until this is set, so
  // every landed commit carries an attribution. Draft re-seeded on Settings open
  // (LOAD-BEARING, same as the github drafts), persisted by saveConnection.
  userName: localStorage.getItem('recipe_ingest_user_name') ?? '',
  userNameDraft: '',
  // Connection lifecycle. Set true after a successful validate-on-Save
  // (saveConnection), cleared by disconnect(). It is ALSO rehydrated from the
  // persisted credentials on boot (init() — CR-01): without that, a returning
  // user with all four keys in localStorage comes back disconnected every
  // reload, the boot pull (gated on this flag) never runs, and they are stuck
  // read-only until they manually re-Save. remoteOk still gates writability, so
  // boot-rehydration alone never makes a stale cache writable (T-10-10).
  githubConnected: false,
  // The D-06 inline error string shown UNDER the Settings fields (NOT a second
  // modal — no-modal-stacking). NEVER contains the token (the friendly map keys
  // only on status/name/githubMessage).
  connectionError: '',
  // ACCESS-04 (D-08/D-09) — the ONE inform-only rate-limit banner string. Empty
  // = hidden. Raised by _maybeRateLimitBanner from every githubFriendlyError
  // catch when the caught error is a GhRateLimitError; cleared by
  // dismissRateLimitBanner. NO auto-retry (D-08) — the user re-triggers.
  rateLimitBanner: '',
  // Async-Settings-action busy flag (mirrors serverImportBusy) — gates the
  // Save & connect button during the GET /repos + test-pull round-trip.
  connectionBusy: false,

  // Phase 13 (MIGRATE-01, D-02/D-03) — the empty-repo seed state.
  // remoteEmpty is set by saveConnection's 3-file existence probe: true when all
  // 3 CSVs 404 (a brand-new shared repo a founder can seed), false on a populated
  // repo (the normal connect). seedBusy gates the "Initialize shared database"
  // button during the 3 CREATE PUTs + post-seed pull. seedStatus is the seed's
  // OWN error/status channel (mirrors connectionError/remoteStatus) — it carries
  // the success copy, the D-04 migration-block copy, the name-missing copy and any
  // friendly seed-failure copy; it is NEVER parseError and NEVER contains the token.
  remoteEmpty: false,
  seedBusy: false,
  seedStatus: '',

  // Phase 13 Plan 02 (MIGRATE-02, the clobber-guard, D-01/D-05/D-06/D-07) — the
  // NON-EMPTY-repo overwrite state. seedSharedDatabase now 404-probes all 3 CSVs;
  // ANY present defaults to JOIN (pullFromRemote, no write). The only destructive
  // write in the milestone is reached EXCLUSIVELY via the type-the-repo-name modal:
  // overwriteConfirmOpen drives its x-show (joins anyModalOpen for no-stacking);
  // overwriteConfirmText is the type-to-confirm input (must === githubRepo to enable
  // the Overwrite button, the D-01 human firewall). overwritePreview is the lazily-
  // fetched [{name,rowCount,sha}] of the CSVs that already exist (so the founder
  // SEES what will be destroyed); overwritePartial is true when 1-2 of 3 are present
  // (D-06 "partially initialized" note). The probe SHAs are reused by the overwrite
  // UPDATEs so a partial re-seed CREATEs the missing + UPDATEs the existing (no
  // spurious 422 on a legitimately-missing file).
  overwriteConfirmOpen: false,
  overwriteConfirmText: '',
  overwritePreview: [],
  overwritePartial: false,

  // Phase 10 Plan 03 (SYNC-01/04/05) — the READ-PATH pull state. These are the
  // pull's OWN error/status channel (NOT parseError), mirroring rosterError vs
  // parseError. remoteStatus carries the friendly read-only/offline copy;
  // remoteOk is the write-safety gate (starts false; flips true ONLY after a
  // full successful pull — a connected-but-never-pulled session is read-only
  // until the first good pull, which is correct: never present a stale cache as
  // writable, T-10-10). pulling is the busy flag (mirrors serverImportBusy) the
  // Refresh button reads. lastSyncedAt holds the most recent meta.fetchedAt so
  // the "Last synced N min ago" indicator needs no async getFile in a getter.
  remoteStatus: '',
  remoteOk: false,
  pulling: false,
  lastSyncedAt: '',

  // quick 260620-rm6 — advisory "suggested servings per resident" multipliers by
  // recipe type (Main/Side/Salad), used ONLY to display a headcount-driven serving
  // suggestion on the meal-plan day cards. localStorage UI-prefs ONLY — NO
  // CSV/IndexedDB writes, NEVER wired into scaling. Mirror the coda config pattern:
  // numeric live field (NaN-guarded default) + a string Draft sibling re-seeded on
  // Settings open, persisted by the Save button (saveServingsConfig), NOT @change.
  servingsPerResidentMain: (() => { const v = parseFloat(localStorage.getItem('servings_per_resident_main')); return Number.isFinite(v) ? v : 1.0; })(),
  servingsPerResidentMainDraft: '',
  servingsPerResidentSide: (() => { const v = parseFloat(localStorage.getItem('servings_per_resident_side')); return Number.isFinite(v) ? v : 0.5; })(),
  servingsPerResidentSideDraft: '',
  servingsPerResidentSalad: (() => { const v = parseFloat(localStorage.getItem('servings_per_resident_salad')); return Number.isFinite(v) ? v : 0.5; })(),
  servingsPerResidentSaladDraft: '',

  settingsOpen: false,

  // Phase 12 (LOCK-04, D-10) — LIVE-lock takeover confirm dialog visibility.
  // Transient UI state (NOT persisted). The presence banner's "Take over editing…"
  // button (shown only for a LIVE foreign lock) opens it; the confirm's proceed
  // calls takeOverLock(), cancel dismisses. Joins anyModalOpen below so it honours
  // the no-modal-stacking convention. The STALE path is one-click (no dialog).
  lockTakeoverConfirmOpen: false,

  // quick 260615-nx6 — left navigation drawer visibility. Transient UI state
  // (NOT persisted). The hamburger sets it true; backdrop click / Escape / the
  // close button / any drawer-item navigation sets it false. The drawer is the
  // single top-level nav surface (Meal Planner / Ingredient Manager / Recipe
  // Manager / Settings) replacing the old .toolbar button strip.
  drawerOpen: false,

  // quick 260614-sht — modal-stack guard (UI-REVIEW BLOCKER, Phase-4 "no modal
  // stacks"). Read-only derived getter: true when ANY OTHER modal is open,
  // EXCLUDING settingsOpen (so the topbar Settings trigger can be :disabled to
  // stop it stacking on top of an edit/other modal, while the no-key auto-open
  // path that sets settingsOpen directly stays unaffected). NO writes/side-effects.
  // mergeRestoreOffer holds an object-or-null, so a bare truthiness check is correct.
  get anyModalOpen() {
    // INTEG-01 merge: UNION of both branches' modal flags (18 distinct). master added
    // trayModalDay/prepModalDay (compared !== '' not truthiness); multiplayer added
    // pushConflictOffer/lockTakeoverConfirmOpen/overwriteConfirmOpen/recentChangesOpen.
    // Phase 16 — the resident edit modal (editingResidentAppid !== null) joins the
    // no-stacking gate so a second top-level modal can't open over it.
    return this.editingRecipeId !== null || this.editingIngredientId !== null || this.currentUnknownKey !== null || this.addNewTargetKey !== null || this.previewOpen || this.shoppingExportOpen || this.checkStockExportOpen || this.trayExportOpen || this.serverImportOpen || this.restorePromptOpen || this.mergeRestoreOffer || this.pushConflictOffer || this.mealPlanPickerOpen || this.lockTakeoverConfirmOpen || this.overwriteConfirmOpen || this.recentChangesOpen || this.editingResidentAppid !== null || this.trayModalDay !== '' || this.prepModalDay !== '' || this.allergenModalDay !== '';
  },

  // Phase 10 — read-fresh-per-call githubStore cfg. Assembles {owner, repo,
  // branch, token} from the LIVE fields (not the drafts) at call time so a
  // rotated token takes effect without a reload (mirrors the Coda
  // read-fresh-per-call comment). Read-only derived getter — NO side-effects.
  get githubCfg() {
    return {
      owner: this.githubOwner,
      repo: this.githubRepo,
      branch: this.githubBranch || 'main',
      token: this.githubToken
    };
  },

  // Phase 13 (MIGRATE-01, D-03) — the EMPTY-repo seed affordance gate. Read-only
  // derived getter, NO side-effects. True ONLY when connected, a token is present,
  // the remote was probed empty, and a seed isn't already running. This drives the
  // "Initialize shared database" button's x-show. Plan 13-02 will widen the seed UI
  // to cover the non-empty overwrite path; this getter stays the EMPTY-only gate.
  get canSeed() {
    return this.githubConnected && !!this.githubToken && this.remoteEmpty === true && !this.seedBusy;
  },

  // Phase 13 Plan 02 (MIGRATE-02, D-01) — the type-the-repo-name confirm gate for
  // the ONLY destructive write in the milestone. Read-only derived getter, NO
  // side-effects. EXACT analog of recipeDeleteConfirmed (=== 'DELETE'): true ONLY
  // when the founder has typed the exact repo name into overwriteConfirmText. The
  // Overwrite-shared-database button binds :disabled="!overwriteConfirmed || seedBusy";
  // confirmOverwriteSharedDatabase ALSO checks it (defense in depth).
  get overwriteConfirmed() {
    return (this.overwriteConfirmText ?? '').trim() === this.githubRepo;
  },

  // ---------- Settings — advanced (SHELL-03 / D-21) ----------
  // Model selector — exactly two options per the constraints in CLAUDE.md
  // (sonnet-4-6 default, haiku-4-5 cheaper fallback). Persisted to localStorage
  // so the user's last selection survives a refresh. The dropdown @change
  // handler in index.html writes this key.
  selectedModel: localStorage.getItem('recipe_ingest_model') ?? 'claude-sonnet-4-6',
  // quick 260612-dr4 — per-category scaling strengths (PERCENT 0..100), seeded
  // defensively from localStorage (corrupt/out-of-range -> per-key default via
  // loadScaleStrengths). The Settings "Scaling" inputs x-model.number these;
  // strengthByCategory feeds the [0,1] map to scaleRow in scaledRowsFor.
  scaleStrengths: loadScaleStrengths(),
  // quick 260615-e1n — the curated, ordered storage-location list (reactive). Seeded
  // defensively from localStorage. The Settings "Storage locations" editor mutates this
  // via explicit-persist handlers (NOT Alpine $watch — it misses nested-array
  // mutations, lesson 260615-dap). The two shopping lists group by this order.
  pantrySections: loadPantrySections(),
  // Draft text for the "add a storage location" input in Settings; cleared on add.
  addPantrySectionDraft: '',
  // Bundled defaults — populated by init():
  //   defaultSystemPrompt — DEFAULT_PROMPT_TEMPLATE constant from
  //     system-prompt.js (wiring is added in Task 3 of this plan).
  //   defaultConversionsJsonText — raw text fetched from ./conversions.json.
  defaultSystemPrompt: '',
  defaultConversionsJsonText: '',
  // Phase 4 / Plan 04-04 / D-56 — bundled-default allergen-keyword mapping.
  // Fetched at init() from ./allergen-keywords.json (silent-fail to '' on
  // load error; the currentAllergenKeywords getter fail-opens to []).
  defaultAllergenKeywordsText: '',
  // User overrides — empty string means "use the bundled default".
  // The advanced-section textareas x-model against these; save actions
  // validate then persist; reset actions clear in-memory + localStorage.
  systemPromptOverride: localStorage.getItem('recipe_ingest_system_prompt_override') ?? '',
  conversionsJsonOverride: localStorage.getItem('recipe_ingest_conversions_json_override') ?? '',
  // Phase 4 / Plan 04-04 / D-56 — allergen-keywords.json localStorage override.
  // Mirrors the conversions.json override mechanism (Pitfall R/S — overrides
  // are read at parse time via the getter, not cached at session start; empty
  // string treated as "use the bundled default", not as malformed input).
  allergenKeywordsOverride: localStorage.getItem('recipe_ingest_allergen_keywords_override') ?? '',
  // Collapsed by default per D-21 — power-user surface, not in the user's way
  // for the common case.
  advancedOpen: false,

  // Getter: which system prompt does the next Parse use?
  // Override wins when non-empty; otherwise the bundled default. This is a
  // GETTER so settings-save followed by a Parse uses the new value WITHOUT
  // a page refresh (Pitfall R — override-read-timing).
  get currentSystemPrompt() {
    return this.systemPromptOverride || this.defaultSystemPrompt;
  },

  // Getter: which conversions object does the next Parse use?
  // Override wins when non-empty; otherwise the bundled default. Parsed
  // here (not at save time) so an override saved successfully but later
  // corrupted by some other code path can't poison a Parse with NaN. On
  // parse failure returns {} so the prompt still renders the (empty)
  // CONVERSIONS fenced block — Pitfall S guidance.
  get currentConversions() {
    const text = (this.conversionsJsonOverride || this.defaultConversionsJsonText || '').trim();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (_e) {
      return {};
    }
  },

  // Phase 4 / Plan 04-04 / D-56 — getter for the active allergen-keyword
  // lookup. Override wins when non-empty; otherwise bundled default. Parsed
  // here (not at save time) so an override saved successfully but later
  // corrupted by some other code path can't poison the soft-block heuristic.
  // Fail-open to [] on parse failure or missing input — the soft-block stays
  // dormant rather than throwing or surfacing an error to the user (the
  // D-56 keyword-block is advisory; an empty list means "no soft-blocks
  // fire", which is the safe default).
  get currentAllergenKeywords() {
    const text = (this.allergenKeywordsOverride || this.defaultAllergenKeywordsText || '').trim();
    if (!text) return [];
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_e) {
      return [];
    }
  },

  // ---------- REVIEW-04 / REVIEW-05 — reactive getters (Plan 03-01) ----------
  // Pure-functional derivations on form.rows. Each is invoked inside Alpine's
  // template render cycle (x-text / x-show / :class), so Alpine's reactivity
  // proxy automatically re-runs them whenever a row property they read
  // mutates. NO standalone watcher / NO explicit recompute.

  /**
   * REVIEW-04 / D-47 — session-header counter source.
   *
   * Returns the count of rows currently flagged for follow-up. Pure
   * derivation: re-evaluates whenever any row's flag_fix_me toggles. The
   * sticky-header span hides at N=0 (x-show), displays "1 row flagged for
   * follow-up" at N=1 (singular), and "{N} rows flagged for follow-up"
   * otherwise.
   */
  get flaggedRowCount() {
    return (this.form && this.form.rows)
      ? this.form.rows.filter(r => r && r.flag_fix_me).length
      : 0;
  },

  // quick 260607-bru — count of confirmed rows (mirrors flaggedRowCount style).
  // Feeds the preview "N of M rows confirmed" counter (read-only, non-gating).
  get confirmedRowCount() {
    return (this.form && this.form.rows)
      ? this.form.rows.filter(r => r && r._confirmed).length
      : 0;
  },

  /**
   * quick 260607-qic — LIVE null-ingredient-row count for the Approve re-gate
   * (QIC-02 / T-qic-03). `unknownQueue` is a parse-time SNAPSHOT, so clearing a
   * mis-matched row to null (× button) after parse does NOT re-block Approve —
   * a null-ingredient join row could silently ship. This getter counts rows
   * whose ingredient_id is currently null (loose `== null` matches undefined too,
   * per RESEARCH Pitfall 8 — same convention the unknownQueue derivation uses).
   *
   * STATE GUARD (T-qic-04, anti-deadlock / anti-double-count): returns 0 outside
   * REVIEWING. Rationale —
   *   • During RESOLVING (and any pre-review state) the form is NOT rendered
   *     (RESEARCH Pitfall 4) and the unknownQueue is the source of truth; letting
   *     this term bite there would deadlock the resolving flow (every unmatched
   *     row is null by definition while the queue is still being worked).
   *   • In REVIEWING the queue snapshot is stale (cleared on the REVIEWING
   *     transition) and the live null count is the correct gate.
   * Because the two Approve gate terms (unknownQueue.length and this getter) are
   * active in DISJOINT states, they can never double-count.
   */
  get liveNullRowCount() {
    if (this.state !== STATES.REVIEWING) return 0;
    return (this.form && Array.isArray(this.form.rows))
      ? this.form.rows.filter(r => r && r.ingredient_id == null).length
      : 0;
  },

  /**
   * quick 260607-bru — DISPLAY-ONLY needs-attention sort.
   *
   * Returns a SHALLOW COPY of form.rows (same reactive row references, so
   * x-model bindings stay live) sorted into three buckets, ties broken by
   * line_order ascending. Never mutates form.rows or line_order — the true
   * row identity/order on disk is untouched; this only reorders the rendered
   * list so confirmed/parked rows sink to the bottom and unconfirmed-flagged
   * rows float to the top.
   *
   *   bucket 0: unconfirmed + flagged   (top — needs most attention)
   *   bucket 1: unconfirmed + unflagged (middle)
   *   bucket 2: confirmed               (bottom — parked)
   *
   * index.html iterates this getter but derives each row's TRUE index via
   * form.rows.indexOf(row) for validation-path strings (sorted position must
   * never leak into rows[i] paths).
   */
  get sortedRowsForDisplay() {
    if (!this.form || !Array.isArray(this.form.rows)) return [];
    // quick 260607-qic — a row cleared to null ingredient_id (× button) is
    // needs-attention even if not flag_fix_me, so it ALSO floats to bucket 0.
    // DISPLAY-ONLY (Plan 04-03 / bru contract): never mutates flag_fix_me or
    // line_order. A null-ingredient row that was somehow _confirmed still sorts
    // to the top (the null check precedes the _confirmed check) — a confirmed
    // row should never be null in practice (clear/select both unconfirm), but
    // surfacing it is the safe behavior.
    const bucket = (r) => {
      if (r && r.ingredient_id == null) return 0;
      return (r && r._confirmed) ? 2 : (r && r.flag_fix_me ? 0 : 1);
    };
    return [...this.form.rows].sort((a, b) => {
      const db = bucket(a) - bucket(b);
      if (db !== 0) return db;
      return (a.line_order ?? 0) - (b.line_order ?? 0);
    });
  },

  /**
   * REVIEW-05 — lookup table consumed by per-field marker class bindings.
   *
   * Returns a `Record<rowKey, Record<fieldName, reasonCode>>` so the
   * template can do `flaggedFieldsByKey[row._key]['quantity_metric']` and get
   * either the reason code (truthy → render yellow border) or undefined
   * (falsy → no border). O(rows * fields_per_row) per invocation, fine
   * for 30-row recipes. Rebuilt on every form mutation that touches
   * flagged_fields or _key.
   */
  get flaggedFieldsByKey() {
    const out = {};
    if (!this.form || !Array.isArray(this.form.rows)) return out;
    for (const row of this.form.rows) {
      if (!row || row._key == null) continue;
      if (!Array.isArray(row.flagged_fields)) continue;
      const byField = {};
      for (const entry of row.flagged_fields) {
        if (entry && entry.field && entry.reason_code) {
          byField[entry.field] = entry.reason_code;
        }
      }
      out[row._key] = byField;
    }
    return out;
  },

  /**
   * REVIEW-05 / D-35 — Set of row keys where the cap-3 suppression kicked in.
   *
   * validate.js Stage 3 sets `row._needsFullReview = true` on any row with
   * > 3 flagged_fields entries. The per-field marker template consults
   * this set: if `needsFullReviewKeys.has(row._key)`, per-field borders
   * are suppressed and the "Needs full review" pill renders instead.
   * Returning a Set gives the template O(1) `.has(...)` membership checks.
   */
  get needsFullReviewKeys() {
    const out = new Set();
    if (!this.form || !Array.isArray(this.form.rows)) return out;
    for (const row of this.form.rows) {
      if (row && row._needsFullReview === true && row._key != null) {
        out.add(row._key);
      }
    }
    return out;
  },

  // REVIEW-06 / D-37 — pure function of row state; no llm_extras term
  // (narrowed from REQUIREMENTS.md REVIEW-06 wording at /gsd:discuss-phase 3,
  // 2026-05-24). The chip list = union of allergen arrays over every row whose
  // ingredient_id is known in the ingredient master, filtered through FSA14 to
  // produce FSA-canonical ordering (NOT row-insertion order — UI-SPEC stability
  // requirement). At Approve-time, approve() copies this list into
  // form.header.allergens immediately before toHeaderCsvRow runs, so the disk
  // serializer (whitelist-based, joins with ';') sees the same union the chip
  // list shows. The READ surface (chip list UI) is this getter;
  // form.header.allergens stays as the WRITE surface for serialization.
  // Defensive: returns [] if form/rows/master/header are missing — covers the
  // pre-parse phase where form.header is still null.
  get derivedAllergens() {
    if (!this.form || !this.form.header) return [];
    if (!Array.isArray(this.form.rows)) return [];
    if (!Array.isArray(this.ingredientMaster) || this.ingredientMaster.length === 0) {
      return [];
    }
    // Build the id → allergens lookup ONCE per invocation (avoids O(N×M)
    // per-row scans across the 235-row master). `m.allergens || []` covers the
    // defensive Phase 1 contract: ingredientMaster entries always carry an
    // allergens array, but the empty/missing case is treated as "no allergens"
    // rather than throwing.
    const masterById = new Map(
      this.ingredientMaster.map(m => [m.ingredient_id, m.allergens || []])
    );
    const set = new Set();
    for (const row of this.form.rows) {
      if (!row || row.ingredient_id == null) continue; // == null catches null + undefined
      const allergens = masterById.get(row.ingredient_id);
      if (!Array.isArray(allergens)) continue;
      for (const a of allergens) {
        if (a) set.add(a);
      }
    }
    // FSA14.filter preserves the canonical FSA-14 order rather than insertion
    // order (chips stay visually stable as the user adds/removes rows — UI-SPEC
    // Interaction Contract "chip-list animation: none; appear/disappear instantly").
    return FSA14.filter(a => set.has(a));
  },

  // quick 260610-dzs / 260614-od7 — single :disabled lock expression for the SHARED
  // recipe-header template (<template id="editor-header-fields">). The lock now keys
  // on editingRecipeId (NOT recipeManagerView): when a recipe is loaded into the
  // editor (editingRecipeId !== null) the recipe modal locks its header on `merging`
  // (mid-save) — and it does so regardless of the active view, so the lock is correct
  // when the modal is opened OVER the meal-plan view (recipeManagerView=false). When
  // no recipe is loaded the parse editor locks its header on `approved` (form-lock
  // after Approve). One getter so the shared header markup binds a single
  // :disabled="editorDisabled" instead of forking the markup per editor.
  // (The parse ROW still binds :disabled="approved" directly — rows are NOT shared.)
  get editorDisabled() {
    // Phase 10 Plan 03 (SYNC-04, D-02) — read-only mode short-circuit. When the
    // app cannot SAFELY write to the shared store (not connected / no token /
    // last pull failed or never ran), all mutating actions are disabled. ONE
    // prepended OR-clause through the SINGLE editorDisabled getter — no forked
    // markup, no parallel disable flag (the same getter Phase 12 extends for
    // presence). Browse / meal-plan / shopping / export stay usable (pure cache
    // reads), so the offline view is a usable read-only view (SYNC-05).
    if (this.readOnlyMode) return true;
    // Phase 12 (LOCK-03) — presence OR-clause. When ANOTHER user holds a live
    // advisory lock, mutating actions are disabled (read-only-while-they-edit).
    // ONE prepended OR-clause through the SAME single getter (no parallel disable
    // flag, no forked markup — the drift guard enforces this). _lockIsMine keeps
    // the holder's OWN editor enabled.
    if (this.presenceLock && !this._lockIsMine) return true;
    return this.editingRecipeId !== null ? this.merging : this.approved;
  },

  // Phase 12 (LOCK-03) — true when THIS user holds the advisory lock, so the
  // presence OR-clause above must NOT disable their own editor. A pure getter.
  get _lockIsMine() {
    return this.heldLock !== null;
  },

  // readOnlyMode — Phase 10 Plan 03 (SYNC-04, D-01/D-02). Side-effect-free
  // derived getter (mirrors anyModalOpen) — true when the app cannot safely
  // write to the shared store, so a stale cache is NEVER presented as writable
  // (T-10-10). NOT connected -> read-only view of the last cache; connected but
  // the most recent pull failed / never ran (remoteOk false) -> read-only
  // (offline / pull error). Connected + last pull OK -> writable. remoteOk
  // starts false and flips true only after a successful pull, so a
  // connected-but-never-pulled session is read-only until the first good pull.
  get readOnlyMode() {
    return !this.githubConnected || !this.githubToken || this.remoteOk === false;
  },

  // readOnlyBanner — Phase 10 Plan 03 (SYNC-04/05). Side-effect-free copy for
  // the read-only/offline informational banner (NOT a modal). Makes clear the
  // data is a usable read-only VIEW (SYNC-05), never implying it can be
  // edited/saved (T-10-13 — staleness/read-only legible at a glance).
  get readOnlyBanner() {
    if (!this.githubConnected || !this.githubToken) {
      return 'Read-only — not connected. Showing your last synced data. Connect in Settings to edit.';
    }
    // DK6 — connected but the shared repo is EMPTY (all-3-404 pull). Calm,
    // actionable copy: the Initialize affordance itself lives in Settings (canSeed).
    if (this.remoteEmpty) {
      return 'This shared database is empty — open Settings and choose "Initialize shared database" to set it up.';
    }
    // Connected but offline / the last pull failed — prefer the specific
    // friendly status if set, else a generic offline line.
    return this.remoteStatus
      ? `${this.remoteStatus} Showing your last synced data — editing is paused until you reconnect.`
      : 'Working offline — showing your last synced data. Editing is paused until you reconnect.';
  },

  // presenceBanner — Phase 12 (LOCK-03/04). Side-effect-free copy getter mirroring
  // readOnlyBanner: the informational line for the "someone else is editing"
  // banner. Returns '' when there is no FOREIGN live lock (the markup guards
  // x-show="presenceLock && !_lockIsMine" so this is never rendered empty —
  // console-baseline safe). When the observed lock is past its `expires` (stale)
  // it flips to the abandoned/take-over copy (the LOCK-04 affordance). Elapsed is
  // computed from the stored server-now (_lockServerNowMs, stamped by the
  // observer read) and the lock's heartbeat/acquiredAt — NO async I/O in a getter.
  get presenceBanner() {
    if (!this.presenceLock || this._lockIsMine) return '';
    const lock = this.presenceLock;
    const sinceMs = this._lockServerNowMs;
    const sinceLabel = this._formatLockElapsed(lock.heartbeat || lock.acquiredAt, sinceMs);
    // Stale = the observed lock is past its expires (the single LOCK-02 test,
    // reusing the Plan 01 substrate). A corrupt expires hard-errors there, but
    // _parseLock already guaranteed expires is a string before it reached here.
    let stale = false;
    if (sinceMs != null) {
      try { stale = isLockStale(sinceMs, lock.expires); }
      catch (e) { stale = false; /* unparseable expires — treat as live, never crash a getter */ }
    }
    if (stale) {
      return `${lock.holder}'s edit looks abandoned (no activity for ${sinceLabel}). Take over?`;
    }
    return `${lock.holder} is editing — saving paused (${sinceLabel}).`;
  },

  // presenceLockStale — Phase 12 (LOCK-04). Side-effect-free getter: true when the
  // OBSERVED foreign lock is past its `expires` (the single LOCK-02 staleness test,
  // reusing the Plan 01 isLockStale substrate against the stored server-now). Drives
  // the banner's affordance split (D-10): stale → one-click forceReleaseLock; live →
  // the confirm-gated takeOverLock. False when there is no foreign lock or the clock
  // is unknown (fail toward the friction-gated LIVE path — never one-click a lock we
  // can't prove abandoned). Never throws (console-baseline safe).
  get presenceLockStale() {
    if (!this.presenceLock || this._lockIsMine) return false;
    const sinceMs = this._lockServerNowMs;
    if (sinceMs == null) return false;
    try { return isLockStale(sinceMs, this.presenceLock.expires); }
    catch (e) { return false; /* unparseable expires — treat as live (friction path) */ }
  },

  // _formatLockElapsed — Phase 12 helper for presenceBanner. PURE: formats the
  // elapsed time between a lock timestamp (ISO) and the stored server-now (epoch
  // ms) into a friendly "N min"/"N s"/"N h" string. Mirrors lastSyncedLabel's
  // shape. Falls back to a neutral 'a while' when either input is missing/bad so
  // the getter never throws (console-baseline safe).
  _formatLockElapsed(iso, nowMs) {
    if (!iso || nowMs == null) return 'a while';
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return 'a while';
    const secs = Math.max(0, Math.floor((nowMs - then) / 1000));
    if (secs < 60) return `${secs} s`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins} min`;
    const hrs = Math.floor(mins / 60);
    return `${hrs} h`;
  },

  // lastSyncedLabel — Phase 10 Plan 03 (SYNC-03, D-03). Side-effect-free derived
  // getter (mirrors anyModalOpen) formatting lastSyncedAt (stamped from the
  // freshest meta.fetchedAt at the end of a successful pull) into a
  // "Last synced N min ago"-style string so staleness is legible at a glance
  // (T-10-13). "just now" under 1 min; "N min ago" up to an hour; "N h ago"
  // past that. When never synced returns 'Not synced yet'.
  get lastSyncedLabel() {
    if (!this.lastSyncedAt) return 'Not synced yet';
    const then = new Date(this.lastSyncedAt).getTime();
    if (!Number.isFinite(then)) return 'Not synced yet';
    const mins = Math.floor((Date.now() - then) / 60000);
    if (mins < 1) return 'Last synced just now';
    if (mins < 60) return `Last synced ${mins} min ago`;
    const hrs = Math.floor(mins / 60);
    return `Last synced ${hrs} h ago`;
  },

  // openRecentChanges — Phase 14 (CHANGES-02). Fetches GET /commits, filters out
  // the `[lock]` heartbeat/acquire/release noise (D-02), and maps each remaining
  // commit to { who, what, when, sha } for the recent-changes modal.
  //   who  = the self-declared `Name:` prefix (the substring of commit.message
  //          BEFORE the first `': '`), DEFENSIVELY falling back to '(unknown)'
  //          when there is no `': '` — a co-user can write a malformed message
  //          and this must never throw (Security V5 / T-14-02). NOT
  //          commit.author.name (that is the SHARED git identity — D-04/T-14-03).
  //   what = the substring AFTER the first `': '` (or the whole message on
  //          fallback).
  //   when = commit.committer.date — the clock-skew-safe BODY field (D-04), NOT a
  //          header. recentChangeWhen() renders it relative at display time.
  // Errors route through githubFriendlyError into recentChangesError (status/name
  // only — NEVER this.githubToken, T-14-01). recentChangesBusy always clears in a
  // finally so a failed fetch never wedges the modal in a spinner.
  async openRecentChanges() {
    if (!this.githubConnected || !this.githubToken) return; // guard (mirrors githubConnected gates)
    this.recentChangesBusy = true;
    this.recentChangesError = '';
    this.recentChanges = [];
    this.recentChangesOpen = true;
    try {
      const commits = await ghListCommits(this.githubCfg, 30);
      this.recentChanges = (Array.isArray(commits) ? commits : [])
        .filter(c => !(c?.commit?.message || '').startsWith(LOCK_COMMIT_PREFIX)) // drop [lock] noise (D-02)
        .map(c => {
          const message = c?.commit?.message || '';
          const sep = message.indexOf(': ');
          const who = sep === -1 ? '(unknown)' : message.slice(0, sep);   // defensive (T-14-02)
          const what = sep === -1 ? message : message.slice(sep + 2);
          return { who, what, when: c?.commit?.committer?.date, sha: c?.sha };
        });
    } catch (e) {
      this.recentChangesError = this.githubFriendlyError(e); // never leaks the token (T-14-01)
      this._maybeRateLimitBanner(e); // ACCESS-04: a rate-limited /commits also raises the shared banner
    } finally {
      this.recentChangesBusy = false;
    }
  },

  // recentChangeWhen — Phase 14 (CHANGES-02). Relative-time formatter mirroring
  // lastSyncedLabel's Date-math: "just now" under 1 min; "N min ago" up to an
  // hour; "N h ago" past that. NaN-guarded (T-14-02) — a malformed/absent date
  // falls back to the raw ISO string rather than throwing or showing "NaN".
  recentChangeWhen(iso) {
    if (!iso) return '';
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return iso; // bad date — show the raw string, never throw
    const mins = Math.floor((Date.now() - then) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.floor(mins / 60);
    return `${hrs} h ago`;
  },

  // quick-260618-biu — UI-only gate for the shared header's "Ingredients
  // (at 20 servings)" textarea. Mirrors the editorDisabled discriminator so
  // the shared template stays unforked: true in the PARSE editor
  // (editingRecipeId === null) → show; false in the MANAGER editor → hide.
  // Purely visual — form.header.ingredients_20 is untouched and still
  // serializes to recipes.csv on save (read by name, not by visibility).
  get showHeaderIngredients20() {
    return this.editingRecipeId === null;
  },

  // Phase 5 / Plan 05-01 / WRITE-01 / D-41 + D-68 — allergen-union assertion.
  // Returns true when the about-to-be-written form.header.allergens array
  // element-wise equals derivedAllergens. Both are FSA-14-canonical (Phase 3
  // D-37 — derivedAllergens uses FSA14.filter; openPreview/approve() assign
  // derivedAllergens.slice() into form.header.allergens before this is read),
  // so a simple ordered element-wise compare is correct (no set normalization
  // needed). This is the D-41 assertion — NO llm_extras term. It is a
  // belt-and-braces desync guard: expected to never fail in normal operation;
  // when it does, confirmApprove() refuses the write with no override (D-68).
  // Pure: derivedAllergens returns [] pre-parse, and an array of one empty []
  // vs another [] compares equal — so the pre-parse state passes vacuously
  // (the modal can't open pre-parse anyway; openPreview guards on it).
  get unionAssertionPasses() {
    const header = (this.form && this.form.header && Array.isArray(this.form.header.allergens))
      ? this.form.header.allergens
      : [];
    const derived = this.derivedAllergens; // already a fresh FSA-canonical array
    if (header.length !== derived.length) return false;
    for (let i = 0; i < derived.length; i++) {
      if (header[i] !== derived[i]) return false;
    }
    return true;
  },

  // Phase 5 / Plan 05-01 / D-65 — preview summary getters (pure, no I/O;
  // mirror the derivedAllergens / flaggedRowCount reactive-getter style).
  // previewNewIngredientNames — names of master ingredients the user added in
  //   this session (for "N new master ingredients: X, Y"). inSessionNewIngredients
  //   entries carry ingredient_name (Plan 04-04 submitAddNew).
  get previewNewIngredientNames() {
    return (Array.isArray(this.inSessionNewIngredients) ? this.inSessionNewIngredients : [])
      .map(e => (e && e.ingredient_name) ? e.ingredient_name : '')
      .filter(Boolean);
  },
  // previewIngredientRowCount — count of ingredient rows about to be written.
  get previewIngredientRowCount() {
    return (this.form && Array.isArray(this.form.rows)) ? this.form.rows.length : 0;
  },

  // Phase 5 / Plan 05-01 / D-65 — "Show exact rows" CSV-shaped preview data.
  // These build the SAME row objects approve() serializes (toHeaderCsvRow /
  // toJoinCsvRow), keyed in captured disk-column order (csvHeaders.*), so the
  // expandable tables show exactly what will be written. Pure; defensive
  // against the pre-parse / null-recipeId state (return [] so the template's
  // x-for renders nothing rather than throwing).
  get previewHeaderColumns() {
    return Array.isArray(this.csvHeaders?.recipes) ? this.csvHeaders.recipes : [];
  },
  get previewJoinColumns() {
    return Array.isArray(this.csvHeaders?.recipe_ingredients) ? this.csvHeaders.recipe_ingredients : [];
  },
  get previewIngredientColumns() {
    return Array.isArray(this.csvHeaders?.ingredients) ? this.csvHeaders.ingredients : [];
  },
  get previewHeaderRow() {
    if (!this.form || !this.form.header) return null;
    if (!Number.isFinite(this.recipeIdSuggestion)) return null;
    return toHeaderCsvRow(this.form.header, this.recipeIdSuggestion, this.previewHeaderColumns);
  },
  get previewJoinRows() {
    if (!this.form || !Array.isArray(this.form.rows)) return [];
    if (!Number.isFinite(this.recipeIdSuggestion)) return [];
    return this.form.rows.map(r => toJoinCsvRow(r, this.recipeIdSuggestion, this.previewJoinColumns));
  },
  get previewIngredientRows() {
    if (!Array.isArray(this.inSessionNewIngredients) || this.inSessionNewIngredients.length === 0) return [];
    return this.inSessionNewIngredients.map(ing => toIngredientCsvRow(ing, this.previewIngredientColumns));
  },

  // quick 260612-abt — pendingDeltaCount getter removed with the delta/merge surface.

  // REVIEW-07 / D-29 — derived line array consumed by the left-pane <pre>
  // review-mode swap-in. Splits the current raw paste on /\r?\n/ so mixed-EOL
  // pastes (CRLF + LF) render correctly. Re-derives via Alpine's reactivity
  // proxy whenever `rawText` changes; trivial cost on a 30-row recipe.
  // Defensive: (this.rawText || '') covers the pre-parse phase where rawText
  // is the empty string (split returns [''] — one empty <span> renders, hidden
  // by x-show="form.header" until parse populates).
  get rawTextLines() {
    return (this.rawText || '').split(/\r?\n/);
  },

  // ---------- Phase 4 / Plan 04-02 — unknown-modal reactive getters ----------
  // currentUnknown — the unknownQueue entry whose _key === currentUnknownKey.
  //   Returns null when the modal is closed (currentUnknownKey is null) OR
  //   when the queue has been cleared (defensive against an out-of-band
  //   close path). The modal template reads `currentUnknown?.raw_text`
  //   etc. via optional chaining, so a null result hides those nodes
  //   without throwing.
  get currentUnknown() {
    if (this.currentUnknownKey == null) return null;
    return this.unknownQueue.find(c => c._key === this.currentUnknownKey) || null;
  },

  // topThreeMatches — reactive top-3 Fuse hits against currentUnknown.
  //   UAT-04-G02 gap closure (260526) — search Fuse with the LLM-parsed
  //   ingredient_name, NOT the full raw_text. Fuse scoring penalises long
  //   noisy queries against short canonical master keys: '200 g almond flour'
  //   vs 'Almonds' exceeds threshold 0.4 (false negative); 'almond flour' vs
  //   'Almonds' scores within threshold. Falls back to raw_text only if the
  //   LLM emitted an empty ingredient_name despite the schema contract.
  //
  //   Follows the L1011-L1020 needsFullReviewKeys idiom: defensive early
  //   returns of [], then Fuse.search. Fuse v7 returns
  //   Array<{ item, refIndex, score }> already sorted ascending by score
  //   (0 = perfect, 1 = worst). The minMatchCharLength: 2 setting in
  //   FUSE_OPTIONS handles single-char noise inside Fuse; we also
  //   short-circuit on query length < 2 to avoid an unnecessary Fuse call
  //   on the open-modal transition.
  //
  //   UAT-04-G04 gap closure (260606) — TOKENISED per-token search with
  //   merged best-score ranking. The single-phrase search (`fuse.search(
  //   'almond flour')`) penalised the multi-word query so heavily that the
  //   best short candidate ('Almonds') scored ABSENT from the top-3, even
  //   though the token 'almond' alone matches 'Almonds' at ~0.001. We now
  //   split the query into tokens, search each token, and merge keeping the
  //   BEST (lowest) score per master entry, then cap at 3. Single-word
  //   queries (e.g. 'gochujang') reduce to one token / one search and order
  //   identically to before. The query SOURCE is unchanged (ingredient_name
  //   first, raw_text fallback) — this does NOT reintroduce the full-raw_text
  //   query that G02 fixed.
  //
  //   Threshold note: returned merged scores can exceed FUSE_OPTIONS.threshold
  //   (0.4) — Fuse applies threshold per-token/per-key internally and
  //   includeScore surfaces the aggregate, so a merged result legitimately
  //   carries a score above 0.4. This is expected: the top-3 display
  //   intentionally shows the closest-N regardless. Do NOT add a
  //   `.filter(h => h.score <= 0.4)` here — that would re-empty the list
  //   (threshold is per-token, not a post-filter).
  get topThreeMatches() {
    if (!this.fuse || !this.currentUnknown) return [];
    const name = (this.currentUnknown.ingredient_name || '').trim();
    const fallback = (this.currentUnknown.raw_text || '').trim();
    const query = name.length >= 2 ? name : fallback;
    if (query.length < 2) return [];

    // Split into tokens; drop tokens < 2 chars (matches
    // FUSE_OPTIONS.minMatchCharLength rationale). If no token survives,
    // fall back to a single search on the whole query.
    const tokens = query.split(/\s+/).filter(t => t.length >= 2);
    const searchTerms = tokens.length > 0 ? tokens : [query];

    // Merge per-token hits keeping the BEST (lowest) score per master entry.
    // Key on hit.item._key when present, else hit.refIndex (master entries
    // are stable per Fuse index, so refIndex is a reliable per-entry key).
    const bestByKey = new Map();
    for (const term of searchTerms) {
      for (const hit of this.fuse.search(term)) {
        const key = hit.item && hit.item._key != null ? hit.item._key : hit.refIndex;
        const prev = bestByKey.get(key);
        if (!prev || hit.score < prev.score) {
          bestByKey.set(key, hit);
        }
      }
    }

    return Array.from(bestByKey.values())
      .sort((a, b) => a.score - b.score)
      .slice(0, 3);
  },

  /**
   * Phase 4 / Plan 04-05 / D-58 + D-59 — per-row flag-source tooltip text.
   *
   * Returns a UI-SPEC locked plain-English string describing WHY a row's
   * flag_fix_me is auto-ticked. Pure derivation from existing in-memory
   * state — no new persisted field. Method (not getter) because it takes
   * a rowKey arg; bind via `:title="flagSourceTooltip(row._key)"` on the
   * per-row flag_fix_me checkbox.
   *
   * Four sources (UI-SPEC §Copywriting Contract §Flag-source tooltip):
   *   (1) low-confidence fields:  row.flagged_fields entries whose
   *                               reason_code !== 'dropped_content'
   *   (2) coverage drop:           flagSourcesByRowKey[key].coverageDropped
   *                               (written by parse() coverage block; D-59
   *                               source 2 plumbing landed in THIS plan)
   *   (3) dropped source content:  row.flagged_fields entries with
   *                               reason_code === 'dropped_content'
   *   (4) new ingredient:          flagSourcesByRowKey[key].addedNewIngredient
   *                               (written by Plan 04-04 submitAddNew + cascade)
   *
   * Return shape:
   *   - 0 sources → '' (user manually ticked flag_fix_me; UI-SPEC: render
   *     nothing — :title="''" produces no native tooltip)
   *   - 1 source  → the single-source locked sentence verbatim from UI-SPEC
   *     §Copywriting Contract §Flag-source tooltip table
   *   - 2+ sources → "Auto-flagged: {short-form list joined with ' + '}."
   *
   * @param {number} rowKey — the row's _key (stable per-parse, NOT line_order)
   * @returns {string} — tooltip text (possibly empty)
   */
  flagSourceTooltip(rowKey) {
    const row = (this.form?.rows || []).find(r => r._key === rowKey);
    if (!row) return '';
    if (!row.flag_fix_me) return '';
    const ff = Array.isArray(row.flagged_fields) ? row.flagged_fields : [];
    const src = this.flagSourcesByRowKey[rowKey] || {};
    const sources = [];
    if (ff.some(f => f && f.reason_code !== 'dropped_content')) {
      sources.push('low-confidence fields');
    }
    if (src.coverageDropped) {
      sources.push('coverage drop');
    }
    if (ff.some(f => f && f.reason_code === 'dropped_content')) {
      sources.push('dropped source content');
    }
    if (src.addedNewIngredient) {
      sources.push('new ingredient');
    }
    if (sources.length === 0) return '';
    if (sources.length === 1) {
      // UI-SPEC locked single-source sentences (verbatim).
      switch (sources[0]) {
        case 'low-confidence fields':
          return 'Auto-flagged: the LLM was uncertain about one or more fields in this row.';
        case 'coverage drop':
          return "Auto-flagged: some words near this row didn't make it into any ingredient row.";
        case 'dropped source content':
          return 'Auto-flagged: some source text near this row may have been dropped.';
        case 'new ingredient':
          return 'Auto-flagged: this row uses an ingredient you added in this session.';
        default:
          return '';
      }
    }
    // 2+ sources — UI-SPEC multi-source composition.
    return 'Auto-flagged: ' + sources.join(' + ') + '.';
  },

  /**
   * Quick 260607-9zz item 2 — lean-core auto-expand guard.
   *
   * Returns true if ANY hidden (secondary) field for this row carries a
   * flag/error/warning, so the template force-shows the "More fields" block
   * (no flag is ever invisible behind a collapsed row).
   *
   * Hidden fields (behind the More-fields toggle): line_order, role, section,
   * prep_note, raw_text. (quick 260607-anu: the legacy range columns are gone;
   * the core, always-visible fields are ingredient_id, ingredient_name,
   * quantity_metric, unit_metric, the volumetric pair when populated, and
   * flag_fix_me.)
   *
   * Signature: (rowKey) — resolves the row index internally via findIndex so
   * the template only passes row._key. Checks three sources, matching the
   * per-field template bindings:
   *   - flaggedFieldsByKey[rowKey][field]                (LLM low-confidence)
   *   - validationErrors   path `rows.${i}.${field}`     (dot-path / Valibot output)
   *   - validationWarnings path `rows[${i}].${field}`    (bracket-path / Valibot input)
   *
   * @param {number} rowKey — the row's _key
   * @returns {boolean}
   */
  rowFlagOnHiddenField(rowKey) {
    const HIDDEN = ['line_order', 'role', 'section', 'prep_note', 'raw_text'];
    const ff = (this.flaggedFieldsByKey || {})[rowKey] || {};
    if (HIDDEN.some(f => ff[f])) return true;
    const i = (this.form?.rows || []).findIndex(r => r._key === rowKey);
    if (i < 0) return false;
    const errPaths = new Set(HIDDEN.map(f => `rows.${i}.${f}`));
    if ((this.validationErrors || []).some(e => errPaths.has(e.path))) return true;
    const warnPaths = new Set(HIDDEN.map(f => `rows[${i}].${f}`));
    if ((this.validationWarnings || []).some(w => warnPaths.has(w.path))) return true;
    return false;
  },

  // ---------- Quick 260607-9zz item 5 — ingredient combobox ----------
  // Type-to-search replacement for the per-row ingredient <select>. Reuses the
  // EXISTING this.fuse instance (built in pickCsvFolder over ingredientMaster)
  // and the topThreeMatches per-token best-score merge — does NOT build a new
  // Fuse. row.ingredient_id stays the single source of truth; the displayed
  // text derives from it via displaySelectedIngredient(), so external writes
  // (e.g. the unknown-modal useMatch) still render correctly.

  // Lazily init + return the transient UI state for a row's combobox.
  comboboxStateFor(rowKey) {
    if (!this.comboboxState[rowKey]) {
      this.comboboxState[rowKey] = { query: '', open: false, activeIndex: 0 };
    }
    return this.comboboxState[rowKey];
  },

  // Filter candidates for the dropdown. Reuses this.fuse with the same
  // per-token best-score merge as topThreeMatches, but returns up to ~10 so the
  // user can scroll. Empty query → show the first 10 of ingredientMaster (so the
  // dropdown is useful as a plain browse list on focus). Returns ingredient
  // master objects ({ ingredient_id, ingredient_name, ... }).
  comboboxFilter(rowKey, query) {
    const q = (query || '').trim();
    if (q.length < 2) {
      // Empty / too-short query: offer a browse list of the first N master rows.
      return this.ingredientMaster.slice(0, 10);
    }
    if (!this.fuse) return [];
    const tokens = q.split(/\s+/).filter(t => t.length >= 2);
    const searchTerms = tokens.length > 0 ? tokens : [q];
    const bestByKey = new Map();
    for (const term of searchTerms) {
      for (const hit of this.fuse.search(term)) {
        const key = hit.item && hit.item._key != null ? hit.item._key : hit.refIndex;
        const prev = bestByKey.get(key);
        if (!prev || hit.score < prev.score) bestByKey.set(key, hit);
      }
    }
    return Array.from(bestByKey.values())
      .sort((a, b) => a.score - b.score)
      .slice(0, 10)
      .map(hit => hit.item);
  },

  // Write the chosen ingredient_id (number) onto the row, close the dropdown,
  // and sync the visible query to the canonical "id — name" label.
  selectIngredient(rowKey, ingredientId) {
    const row = (this.form?.rows || []).find(r => r._key === rowKey);
    if (!row) return;
    // quick 260607-bru — combobox mutates ingredient_id via this METHOD (no
    // bubbling native input on a tracked field), so @input/@change.capture in
    // index.html would miss it. Explicit unconfirm required here.
    this.unconfirm(rowKey);
    row.ingredient_id = ingredientId == null ? null : parseInt(ingredientId, 10);
    const st = this.comboboxStateFor(rowKey);
    st.query = this.displaySelectedIngredient(row.ingredient_id);
    st.open = false;
    st.activeIndex = 0;
  },

  // quick 260613-9n4 — pure read-only predicate (no state, no writes, no new
  // schema field). True ONLY for a "volumetric-only" row: a volumetric quantity
  // OR unit is present AND there is NO metric quantity. Drives the recipe-manager
  // editor's lean-view lead-pair swap (volumetric leads for these rows; metric
  // drops into More fields). Both-present and metric-only rows return false.
  isVolumetricLeadRow(row) {
    const hasMetric = row.quantity_metric !== null && row.quantity_metric !== '' && row.quantity_metric !== undefined && !Number.isNaN(row.quantity_metric);
    const hasVolQty = row.quantity_volumetric !== null && row.quantity_volumetric !== '' && row.quantity_volumetric !== undefined && !Number.isNaN(row.quantity_volumetric);
    const hasVolUnit = !!row.unit_volumetric && row.unit_volumetric !== '';
    return (hasVolQty || hasVolUnit) && !hasMetric;
  },

  // quick 260613-aj3 — pure read-only predicate (no state, no writes, no new
  // schema field). Mirrors the a2t browse-list flag on the in-memory editor row
  // shape: true ONLY for a REAL ingredient line (has an id OR a non-blank name)
  // that is missing BOTH a metric AND a volumetric quantity. 0 / blank / NaN
  // (from a cleared input) all count as missing. A brand-new empty "+ Add row"
  // (no ingredient) is NOT flagged. Drives the manager-editor row tint only.
  // quick 260614-f9t — READ-ONLY derived Set of master ingredient_ids that are
  // pantry staples (master pantry_staple=TRUE). Master ingredient_id is already a
  // parsed integer, so this is a Set of NUMBERS. No state, no writes — recomputed
  // on read from the live ingredientMaster.
  get pantryStapleIdSet() {
    return new Set((Array.isArray(this.ingredientMaster) ? this.ingredientMaster : []).filter(m => m && m.pantry_staple).map(m => m.ingredient_id));
  },

  isRowMissingQuantity(row) {
    // quick 260613-aw1 — required-only: a non-required (optional/garnish/to_taste)
    // row legitimately has no amount, so never tint it. Editor rows carry role
    // (default 'required'), so default-required rows behave exactly as before.
    if ((row.role || 'required') !== 'required') return false;
    // quick 260614-f9t — a pantry staple is never ordered (removed from the
    // shopping list per quick-260614-eqa), so a missing quantity on it is a
    // false-positive flag — never tint it, even when required with no quantity.
    // Editor row ingredient_id is a NUMBER or null; the != null guard skips
    // brand-new rows; Number(...) normalises defensively against the numeric Set.
    if (row.ingredient_id != null && this.pantryStapleIdSet.has(Number(row.ingredient_id))) return false;
    const isRealLine = (row.ingredient_id != null) || (row.ingredient_name && String(row.ingredient_name).trim() !== '');
    if (!isRealLine) return false;
    const hasQty = (v) => v !== null && v !== '' && v !== undefined && !Number.isNaN(v) && Number(v) > 0;
    return !hasQty(row.quantity_metric) && !hasQty(row.quantity_volumetric);
  },

  // quick 260607-bru — confirm a row: clear its flag, mark it confirmed.
  // Collapse-to-summary + drop-to-bottom are PURELY a function of _confirmed in
  // the template + sortedRowsForDisplay getter — no separate collapse flag.
  confirmRow(rowKey) {
    if (this.approved) return;   // defense-in-depth; UI also disables the button
    const row = (this.form?.rows || []).find(r => r._key === rowKey);
    if (!row) return;
    // USER-LOCKED D: confirming means the row is fixed → it leaves flag_log
    // scope. The flag_fix_me checkbox stays interactive so the user can manually
    // re-tick a confirmed (re-expanded) row.
    row.flag_fix_me = false;
    row._confirmed = true;
    // NOTE: flagged_fields, line_order, expandedRows[_key] are untouched — the
    // More-fields expand state is preserved and restored when the row re-opens.
  },

  // quick 260607-bru — un-confirm a row (idempotent). Called explicitly from
  // select/clearIngredient and via @input.capture/@change.capture in index.html.
  unconfirm(rowKey) {
    const row = (this.form?.rows || []).find(r => r._key === rowKey);
    if (!row) return;
    if (!row._confirmed) return;   // idempotent no-op — avoids reactive churn on every keystroke
    // Un-confirming is NOT re-flagging: a stale confirm simply becomes editable
    // again. We do NOT re-tick flag_fix_me (it was cleared on confirm; the user
    // can re-tick manually if they decide the row still needs follow-up).
    row._confirmed = false;
  },

  // Clear the row's ingredient to null (the "(none / unknown)" state) and reset
  // the visible query.
  clearIngredient(rowKey) {
    const row = (this.form?.rows || []).find(r => r._key === rowKey);
    if (!row) return;
    row.ingredient_id = null;
    const st = this.comboboxStateFor(rowKey);
    st.query = '';
    st.open = false;
    st.activeIndex = 0;
    // quick 260607-bru — method-driven mutation; @input/@change.capture would
    // miss it. Explicit unconfirm (parity with selectIngredient).
    this.unconfirm(rowKey);
  },

  // Resolve an ingredient_id to its "id — name" display label via the master
  // lookup. Returns '' for null/unmatched (the unknown state).
  displaySelectedIngredient(ingredientId) {
    if (ingredientId == null) return '';
    const ing = (this.ingredientMaster || []).find(m => m.ingredient_id === ingredientId);
    return ing ? `${ing.ingredient_id} — ${ing.ingredient_name}` : '';
  },

  // quick 260615-ljm — THE single display-name resolver. The per-recipe-line
  // ingredient_name is LLM scratch / a matching artefact; the CANONICAL identity
  // is the master ingredient_name looked up by ingredient_id. This drives EVERY
  // ingredient-name DISPLAY site (meal-plan rows, combined shopping list lines/
  // staples/check-stock, qty-gap tooltip, parse confirmed-row summary) so there is
  // ONE lookup, never a copied one. Resolution: matched id -> master name; else the
  // (non-empty) recipe-line `fallback`; else '(unnamed)'. NEVER returns blank.
  // ingredientId may be a number OR a numeric string (callers pass either; the
  // master id is a parsed integer, so coerce via Number for the find).
  masterIngredientName(ingredientId, fallback) {
    if (ingredientId != null) {
      const idNum = Number(ingredientId);
      const ing = Number.isFinite(idNum)
        ? (this.ingredientMaster || []).find(m => m.ingredient_id === idNum)
        : undefined;
      if (ing && ing.ingredient_name) return ing.ingredient_name;
    }
    const fb = String(fallback ?? '').trim();
    return fb !== '' ? fallback : '(unnamed)';
  },

  // quick 260607-anu — the quick-9zz originalVolumetric(row) helper (which
  // reconstructed the source amount from a raw_text regex when the LLM had
  // converted a volumetric line to metric) is REMOVED. The real
  // quantity_volumetric/unit_volumetric columns now carry the original
  // non-metric amount directly, so the regex reconstruction is obsolete.

  // quick 260612-abt — buildFlagLogRows removed: per-Approve flag_log.csv was part
  // of the deleted delta surface. Approve now writes straight to the live store.

  // ---------- CSV / store state ----------
  // quick 260612-abt — true once the IndexedDB store has been loaded into session
  // state (on boot if a store exists, or after import). THE gate for
  // store-dependent affordances (the FSA folder handle is gone).
  csvStoreLoaded: false,
  csvHeaders: { recipes: [], ingredients: [], recipe_ingredients: [] },
  ingredientMaster: [],
  maxRecipeIdAtSessionStart: 0,

  // ---------- Cross-plan error region ----------
  parseError: '',
  // quick 260618-jr7 — SAFE, copyable Anthropic error detail backing the
  // "Copy error" button on the parse banner. Set ONLY in the parse catch (via
  // extractErrorDetail, which never includes the apiKey); '' hides the button.
  // Cleared wherever parseError is reset at a flow start (parse/startFresh/etc).
  parseErrorDetail: '',
  errorCopied: false,   // transient "Copied ✓" feedback for copyErrorDetail()

  // quick 260613-c20 — Import from server (pull) state. Same-origin fetch of
  // live-data/import/*.csv; per-file presence detection; confirm-before-write;
  // putFile is the sole store-write path (verify + auto-revert protected).
  serverImportOpen: false,
  serverImportFound: [],   // [{ name, rows, record }] — record is the parsed CSV, not serialized
  serverImportBusy: false,
  serverImportError: '',
  serverImportNotice: '',

  // Phase 14 (CHANGES-02) — recent-changes modal state. openRecentChanges()
  // fetches GET /commits, drops `[lock]` noise (D-02), and maps each remaining
  // commit to { who, what, when, sha } for a glanceable in-app changelog.
  recentChangesOpen: false,
  recentChanges: [],       // [{ who, what, when, sha }]
  recentChangesBusy: false,
  recentChangesError: '',

  // ---------- Parse-pipeline state (Plan 02) ----------
  rawText: '',
  parsing: false,
  form: { header: null, rows: [] },
  devMode: false,

  // Quick 260607-9zz — raw-pane collapse, session-only Alpine state (no persistence)
  rawPaneCollapsed: false,

  // Quick 260607-9zz — per-row lean-core expand state. Keyed by row._key
  // (session-only, not persisted). expandedRows[key] truthy → that row's
  // secondary "More fields" block is shown. rowFlagOnHiddenField() OR-composes
  // so a flagged/errored hidden field force-shows the block regardless.
  expandedRows: {},

  // Quick 260607-9zz item 5 — ingredient combobox per-row UI state. Keyed by
  // row._key, session-only (not persisted). Each entry: { query, open,
  // activeIndex }. row.ingredient_id remains the single source of truth — this
  // map only holds transient typeahead/dropdown UI state. comboboxStateFor()
  // lazily initialises a row's entry so templates can read it safely.
  comboboxState: {},

  // ---------- Parse state machine (PARSE-02) ----------
  // `state` is the single source of truth for the parse-pipeline phase the
  // tool is in. `parsing` is preserved alongside it so existing :disabled
  // bindings keep working without rewiring (RESEARCH §E note).
  state: STATES.IDLE,

  /**
   * Attempt a state transition. Returns true on success, false on disallowed
   * transition (logged to console.error). When devMode is true, throws on
   * disallowed transitions so programming errors surface loudly during
   * development.
   *
   * @param {string} to — target state (use STATES.* constants from above).
   * @returns {boolean}
   */
  transition(to) {
    const from = this.state;
    const allowed = TRANSITIONS[from];
    if (!allowed || !allowed.has(to)) {
      console.error(`Illegal state transition: ${from} → ${to}`);
      if (this.devMode) {
        throw new Error(`Illegal state transition: ${from} → ${to}`);
      }
      return false;
    }
    this.state = to;
    return true;
  },

  // ---------- Validation (PARSE-03 / D-20) ----------
  // Side-channel arrays populated by validateRecipe() inside parse()'s
  // VALIDATING state slot. The form-pane's per-field inline notes filter
  // these arrays by path:
  //   validationWarnings — gray "auto-corrected" notes (bracket-path syntax
  //     `rows[N].field` / `header.field` matching the Valibot input convention).
  //   validationErrors   — red hard-reject labels (dot-path syntax
  //     `rows.N.field` / `header.source` matching the Valibot output path).
  // Cleared by startFresh() so a new parse starts with a clean slate.
  validationWarnings: [],
  validationErrors: [],

  // ---------- Token / cost estimate (API-07) ----------
  // tokenEstimate is { input_tokens, usd } from count.js's estimateParseCost,
  // populated by the estimateTokenCost action on textarea blur + model-change.
  // null when no estimate is available (preconditions missing, or count_tokens
  // failed silently). The small grey <small class="token-estimate"> next to
  // the Parse button binds `x-show="tokenEstimate"` so it hides on null.
  //
  // actualUsage is the REAL { input_tokens, output_tokens } from the Anthropic
  // response.usage after a successful Parse — captured by parse() from the
  // callLLM return shape. Phase 2 keeps this DevTools-only (no UI display
  // per Claude's Discretion in 02-CONTEXT.md). Inspect via
  // `Alpine.$data(document.body).actualUsage` after a Parse.
  tokenEstimate: null,
  actualUsage: null,

  // ---------- Token coverage (PARSE-04 / D-23) ----------
  // Populated by parse() inside the VALIDATING state slot AFTER Plan 02-03's
  // validateRecipe — checkCoverage(this.rawText, this.form.rows) compares the
  // CORRECTED rows' concatenated raw_text against the pasted recipe and
  // reports dropped content (words + numbers) plus a heuristic list of rows
  // suspected of truncation. When shouldWarn=true, this field holds the
  // whole result object so the yellow banner can render droppedWords +
  // droppedNumbers + affectedRowIndices. When shouldWarn=false, this is null.
  //
  // The banner's Dismiss button sets this back to null — but the auto-ticked
  // flag_fix_me on the affected rows persists past Dismiss so downstream
  // review still sees the warning (D-23).
  //
  // Cleared by startFresh() so a new parse starts with no stale banner.
  coverageWarning: null,

  // ---------- quick 260608-h1i — Duplicate-recipe detector (soft, non-blocking) ----------
  // duplicateCandidates — [] = no nudge. Populated by parse() (and reset there +
  //   in startFresh) with up to DUP_MAX_CANDIDATES {recipe_id, name, reasons[]}.
  //   Drives BOTH the review-pane banner and the approve-modal reminder line.
  //   NON-BLOCKING: nothing here gates Approve/Save.
  duplicateCandidates: [],
  // duplicateDismissed — true once the user dismisses the review-pane banner.
  //   The banner hides; the approve-modal reminder still reads duplicateCandidates.
  duplicateDismissed: false,

  // ---------- quick 260618-ihr — Instruction-standardization review flags (soft, non-blocking) ----------
  // reviewFlags — PARSE-ONLY / ephemeral (D2). [] = no judgement calls.
  //   Populated by parse() from the validated header flags (after the header is
  //   assigned). Each entry is { reason_code, note }. Drives the review-pane
  //   banner only. NON-BLOCKING: gates nothing (same posture as
  //   duplicateCandidates). Never written to disk — the column-driven header
  //   writer has no column for these flags — and reset on new parse + startFresh
  //   + restoreInflight.
  reviewFlags: [],
  // reviewFlagsDismissed — true once the user dismisses the review-pane banner.
  reviewFlagsDismissed: false,
  // duplicateIndex — NON-reactive holder for the read-only index
  //   { recipeNameFuse, recipeNameList, ingredientIdsByRecipeId }. Built at
  //   folder-pick + refreshed post-merge. A plain field (not deep-proxied by
  //   Alpine) is fine and avoids reactivity overhead over a Fuse instance + Map.
  //   null = feature silently no-ops (graceful degradation).
  duplicateIndex: null,

  // ---------- Phase 4 / Plan 04-02 — unknown-ingredient queue + modal ----------
  // Single-store, top-level slots per RESEARCH Pattern 1 (no nesting). Each
  // field is independently reactive; the modal template binds to them
  // directly. See <interfaces> in 04-02-PLAN.md for the full contract.
  //
  // unknownQueue — derived in parse() validating-success path from rows whose
  //   ingredient_id is null (loose-equal also matches undefined per RESEARCH
  //   Pitfall 8). Each card is a shallow projection: { _key, raw_text,
  //   section, line_order, suggested_allergens }. Cards are removed (filter)
  //   by useMatch / skipAsFreeform / submitAddNew once the row resolves.
  // currentUnknownKey — null = modal closed; non-null = the open unknown's
  //   row._key. Drives the modal's x-show binding and the currentUnknown
  //   accessor that the modal template + Fuse query read from.
  // addNewMode — false = modal default state (top-3 + actions); true =
  //   add-new sub-form. Plan 04-04 wires the sub-form body; this plan
  //   reserves the placeholder.
  // addNewFormState — Add-new sub-form fields. Reset by openUnknownModal /
  //   closeUnknownModal so a fresh modal always starts clean.
  // flagSourcesByRowKey — D-59 transient session map. Phase 4 polish (Plan
  //   04-05) reads from this for the flag-source tooltip; Plan 04-02 leaves
  //   it as the empty object (no writes yet).
  // inSessionNewIngredients — Add-new entries queued for the delta write on
  //   Approve (D-53). Plan 04-04 populates; Plan 04-02 declares the slot.
  // maxIngredientIdAtSessionStart — D-54 session counter base. Seeded from
  //   ingredientMaster in pickCsvFolder. Plan 04-04 increments on Add-new.
  // fuse — Fuse instance handle. Built once in pickCsvFolder after master
  //   loads (initFuse); rebuilt via setCollection on master mutation
  //   (refreshFuse). null when no folder is picked yet.
  // D-56 keyword-block lookup is now exposed via the `currentAllergenKeywords`
  //   reactive getter (Plan 04-04 wiring). The bundled default lives in
  //   `defaultAllergenKeywordsText` (fetched at init()); the localStorage
  //   override lives in `allergenKeywordsOverride`. The soft-block heuristic
  //   reads from the getter, never directly from a reactive store array.
  unknownQueue: [],
  currentUnknownKey: null,
  // quick 260607-qic — SINGLE source of truth for "which row does the open
  // Add-new sub-form target". The queue path sets it to currentUnknownKey (in
  // enterAddNewMode); the combobox/live-row path sets it directly to a live
  // row._key (in openAddNewForRow). submitAddNew reads ONLY this field, then
  // branches on whether the key is currently in unknownQueue (queue path) vs
  // not (live-row path) — see submitAddNew for the queue-vs-live branch.
  addNewTargetKey: null,
  addNewMode: false,
  // quick 260607-c65 — shopping_unit selector defaults 'metric' (CONTEXT
  // user-lock). shoppingUnitTouched tracks whether the user manually changed
  // the selector this session; the LLM pre-suggestion only applies when it is
  // still false (manual choice stays authoritative).
  // quick 260614-eqa — pantry_staple added for state-shape completeness. INERT here:
  // the parse-flow submitAddNew does NOT carry pantry_staple (exactly like
  // scale_category — there is no submitAddNew wiring to add).
  addNewFormState: { name: '', allergens: [], pack_size: null, pack_unit: '', shopping_unit: 'metric', pantry_staple: false, pantry_section: '', pack_units: null, pack_unit_label: '' }, // quick 260615-kid (inert: add-new uses managerAddForm)
  shoppingUnitTouched: false,
  // addNewFormError — inline validation surface for the Add-new sub-form
  // (UI-SPEC §Error state copy). Empty string when no error; non-empty
  // string renders inside the sub-form via x-show / x-text. Cleared on
  // entering/exiting Add-new mode and at the top of submitAddNew's happy path.
  addNewFormError: '',
  flagSourcesByRowKey: {},
  inSessionNewIngredients: [],
  maxIngredientIdAtSessionStart: 0,
  fuse: null,

  // ---------- quick 260607-qbj — Ingredient Master Manager ----------
  // CONTEXT user-lock: a top-level "Manage ingredients" toolbar toggle swaps the
  // WHOLE workspace between Parse and a manager view, with parse/form state
  // PRESERVED underneath (x-show, NOT x-if). Edit + add both write in place to
  // ingredients.csv via the ONE shared _rewriteIngredientsInPlace chain (the
  // second sanctioned live-write surface after migrateLiveSchema). All these
  // fields are transient UI state — none are persisted.
  managerView: false,
  managerFilter: '',
  // editingIngredientId — the ingredient_id (number) of the row currently in
  //   edit mode (inline expand), or null. editForm holds the in-flight edit; its
  //   pack_size/pack_unit are read FRESH from disk on edit-open (the in-memory
  //   master does not carry them).
  editingIngredientId: null,
  // quick 260614-nw0 — detection-only warning shown INSIDE the edit modal when a
  //   set field's backing column is absent from the loaded ingredients.csv. The
  //   write path is unchanged (the `if ('<col>' in merged)` guards still drop the
  //   value); this only makes that drop VISIBLE and keeps the modal open.
  editIngredientWarning: '',
  // quick 260614-nw0 — the EXACT scale_category value pre-filled into editForm on
  //   edit-open (the disk value when valid, ELSE the name-heuristic, which
  //   classifyIngredientCategory NEVER returns blank for). Because scale_category is
  //   heuristic-prefilled, the save-time drop check treats it as set-by-user ONLY
  //   when it DIFFERS from this captured value — preventing a false-warn on a field
  //   the user never touched. Overwritten on every edit-open; needs no reset.
  editScaleCategoryInitial: '',
  editForm: { ingredient_name: '', allergens: [], shopping_unit: 'metric', scale_category: '', pantry_staple: false, pantry_section: '', pack_size: null, pack_unit: '', pack_units: null, pack_unit_label: '', regular: false, regular_qty_per_person: null, link1: '', link2: '', pack2_size: null, pack2_unit: '', supplier: '' }, // pack_units/pack_unit_label: quick 260615-kid; regular/regular_qty_per_person: phase 08 REG-01
  // quick 260627-pfu — backdrop-close dirty guard. Per-edit-modal at-open JSON
  //   baseline, keyed 'recipe' | 'ingredient' | 'resident' | 'unknownAddNew'.
  //   snapshotEditModal() writes it at open; editModalIsDirty() compares the live
  //   bound object against it; requestCloseEditModal() pops a native Discard confirm
  //   only when dirty. An undefined entry (never snapshotted) reads as NOT dirty
  //   (fail-safe — never block a close on a missing baseline).
  _dirtySnapshot: {},
  // quick 260610-jzu: collapsed-by-default "More fields" expand in the ingredient
  //   inline EDIT panel, exposing the 5 previously-hidden ingredients.csv columns
  //   (1st_link/2nd_link/2nd_pack_size/2nd_pack_unit/supplier) as editable inputs.
  //   Transient UI state, reset to false on edit-open + cancel.
  editMoreFieldsOpen: false,
  // quick 260627-q7x — collapsed-by-default "More fields" disclosure in the SHARED
  //   editor-header-fields template (recipe HEADER), hiding the rarely-touched fields
  //   (Prep / Instructions / Last made / Serve with / Popularity & Difficulty notes)
  //   behind a petrol toggle. Presentation state only (NOT data, NOT persisted);
  //   single source shared by both editors (you only ever see one editor at a time).
  headerMoreOpen: false,
  managerAddMode: false,
  managerAddForm: { name: '', allergens: [], shopping_unit: 'metric', scale_category: '', pantry_staple: false, pantry_section: '', pack_size: null, pack_unit: '', pack_units: null, pack_unit_label: '', regular: false, regular_qty_per_person: null }, // pack_units/pack_unit_label: quick 260615-kid; regular/regular_qty_per_person: phase 08 REG-01
  // managerError — inline plain-language error/refusal surface for the manager
  //   (old-schema refusal, read-error fail-closed, validation). Empty when clean.
  managerError: '',
  // managerNotice — lightweight success line after a write (e.g. "Saved ✓").
  managerNotice: '',
  // manager-scoped LLM pre-suggestion touch tracker (mirrors shoppingUnitTouched
  //   for the add-new sub-form, but isolated so the manager's add-form blur hook
  //   does not entangle with the parse-time add-new selector).
  managerShoppingUnitTouched: false,

  // ---------- quick 260608-agp — Recipe Manager (browse/edit/delete) ----------
  // Mirrors the ingredient-master manager: a top-level "Manage recipes" toolbar
  // toggle swaps the WHOLE workspace into a browse/edit/delete surface for the
  // live recipes, REUSING the existing parse-view editor (form.header + form.rows)
  // as the recipe editor. Edits + deletes write IN PLACE to BOTH recipes.csv and
  // recipe_ingredients.csv via the shared _rewriteTwoFilesInPlace orchestrator
  // (the third sanctioned live-write surface). All transient UI state — none
  // persisted.
  recipeManagerView: false,
  recipeManagerFilter: '',
  // quick 260610-eyh — Recipe Manager BROWSE filters (READ-ONLY over recipeList).
  //   recipeManagerTypeFilter — selected dish types (lowercase 'main'/'side'/'salad');
  //     OR within the selected set; empty = all types; a blank-type recipe is hidden
  //     once ANY type is selected.
  //   recipeManagerAllergenFilter — FSA-14 allergens to AVOID ("Hide recipes containing:").
  // SAFETY (allergens): a recipe whose ingredient set carries an unmatched/blank
  //   ingredient_id (or is absent from duplicateIndex.ingredientIdsByRecipeId) has an
  //   INCOMPLETE derived allergen set and is NEVER hidden by the allergen-exclude
  //   filter — it surfaces with a "⚠ allergens may be incomplete" caveat so the user
  //   checks it manually. Both filters compose with the existing name filter via AND.
  recipeManagerTypeFilter: [],
  recipeManagerAllergenFilter: [],
  // quick 260621-9lo — Filters-disclosure open state for the browse-list allergen
  // filter (mirrors mealPlanFiltersOpen). TRANSIENT: not persisted; defaults closed.
  recipeManagerFiltersOpen: false,
  // recipeList — fresh disk rows for the browse table: { recipe_id, name, type }.
  recipeList: [],
  // recipeQtyGapsById — quick 260613-a2t. READ-ONLY browse-list tally keyed by
  //   recipe_id → { missing:number, total:number }; derived from a fresh read of
  //   recipe_ingredients.csv. Reassigned WHOLESALE (never mutated in place) so
  //   Alpine reactivity fires. Used by recipeQtyGapLabel() for the browse caveat.
  recipeQtyGapsById: {},
  // editingRecipeId — the recipe_id (number) currently loaded into the editor
  //   form, or null (browse mode).
  editingRecipeId: null,
  recipeManagerError: '',
  recipeManagerNotice: '',
  // recipeDeleteConfirmText — the type-to-confirm input model; must equal the
  //   literal 'DELETE' to enable the destructive button (see recipeDeleteConfirmed).
  recipeDeleteConfirmText: '',
  // _recipeEditFormBackup — quick 260614-od7. Snapshot of the user's in-progress
  //   PARSE form (header + rows, by reference) taken by openEditRecipe BEFORE it
  //   loads a recipe into the SHARED this.form (which openRecipeForEdit clobbers in
  //   place). closeEditRecipe is the SINGLE owner of restore+null+clear, called from
  //   Cancel/Escape AND from the save/delete success paths — so the recipe-edit modal
  //   lifecycle owns this snapshot end-to-end (openRecipeManager/closeRecipeManager no
  //   longer touch it).
  _recipeEditFormBackup: null,

  // ---------- Approve / delta-write state (Plan 03) ----------
  sessionFolderHandle: null,          // FileSystemDirectoryHandle | null
  sessionFolderName: '',              // display name e.g. 'delta_2026-05-22_14-30-15'
  approved: false,                    // form-lock gate (D-17); cleared by startFresh
  lastWriteSummary: null,             // { folder, recipesRows, ingredientRows, flagLogRows } | null
  approving: false,                   // Approve-button double-click guard (T-03-05)

  // ---------- Phase 5 / Plan 05-01 — Approve preview gate (WRITE-01) ----------
  // previewOpen — controls the pre-Approve preview modal (D-65). Clicking
  //   Approve now opens this modal instead of writing directly; the write only
  //   proceeds via the modal's "Save to delta" button (confirmApprove()).
  // previewShowRows — toggles the "Show exact rows" expandable CSV-shaped
  //   tables inside the preview (D-65 compact-summary + expandable-detail).
  previewOpen: false,
  previewShowRows: false,

  // ---------- Phase 5 / Plan 05-01 — Merge handoff to Plan 02 (WRITE-08) ----------
  // merging — double-click / mutual-exclusion guard for the live-file Merge
  //   action. DECLARED here (Plan 05-01) so the post-Approve success state's
  //   "Merge into live now" button can bind :disabled="merging || approving"
  //   without a ReferenceError BEFORE Plan 05-02 lands. Plan 05-02 owns the
  //   merge() action that flips this flag (mirrors the approving pattern) and
  //   the full backup → append → verify transaction. Until then the button is
  //   wired but merge() does not exist; Plan 05-02 is the next wave and lands
  //   before a user would click it. Do NOT add a merge() stub that writes
  //   anything here — the field declaration is the entire Plan 05-01 contribution.
  merging: false,

  // quick 260612-abt — the delta/merge/Pending-merges machinery is removed. The
  // ONLY survivor here is mergeRestoreOffer: it is now the INFORMATIONAL
  // auto-rollback notice set by putFile's automatic in-band revert-on-failed-verify
  // (a write failed and was rolled back; the user's data is unchanged). There is
  // no user-triggered restore. `merging` (above) stays as the generic
  // write-in-flight lock.
  mergeRestoreOffer: null,
  // ---------- Phase 11 / Plan 03 (SAVE-02, D-01/D-03/D-04/D-07) ----------
  // pushConflictOffer — the WRITE-PATH push-failure banner state. Object-or-null,
  // modelled EXACTLY on mergeRestoreOffer (same banner shape, same anyModalOpen
  // gate) — NOT a new banner system. It is set by the write callers' catch (via
  // _routePushFailure) when a push to the shared repo fails AFTER the local
  // putFile already succeeded (so the cache was D-02-reverted by
  // _pushFileAfterCacheWrite, but the open editor's in-memory edit is UNTOUCHED).
  // Shape: { reason: <friendly copy, never the token>, kind, filesWritten? }
  //   kind ∈ conflict409 | network | verifyMismatch | nameMissing | partialSave.
  // It is DISTINCT from mergeRestoreOffer: that one is the LOCAL all-or-nothing
  // auto-rollback notice ("rolled back, data unchanged"); this one is the REMOTE
  // push hard-stop whose ONLY recovery affordance is refreshKeepEdit() + re-Save
  // (the write is NEVER auto-retried — SAVE-02 / T-11-10). Single-banner
  // discipline: a push failure sets ONLY this, never also parseError, never also
  // mergeRestoreOffer.
  pushConflictOffer: null,

  // Phase 12 (LOCK-01..04) — advisory-lock state-machine reactive state. The
  // lock is COURTESY only: the CSV-blob 409 (Phase 11) stays the real arbiter, so
  // a lock-layer bug must degrade to "the 409 still protects the data", never to
  // a silent clobber.
  //   presenceLock — the OTHER user's live lock as OBSERVED (D-09), or null when
  //     the lock file is absent / unparseable / mine. Shape:
  //     { holder, acquiredAt, heartbeat, expires, sha } (ISO strings + the blob
  //     sha). Read by editorDisabled's OR-clause + presenceBanner.
  //   heldLock — THIS user's OWN lock, or null when we don't hold it. Shape:
  //     { sha, acquiredAt, expires }. heartbeatLock threads the fresh sha here.
  //   _lockHeartbeatTimer — the single-owner setInterval handle (null when idle);
  //     _startHeartbeat clears it first so an interval can NEVER stack (Pitfall 2).
  //   _lockServerNowMs — the most recent server-now (epoch ms) stamped by the
  //     observer reads, so the side-effect-free presenceBanner getter can compute
  //     elapsed without doing async I/O in a getter.
  presenceLock: null,
  heldLock: null,
  _lockHeartbeatTimer: null,
  _lockServerNowMs: null,

  // quick 260611-enp — Meal plan view state. mealPlanView is the FOURTH
  // mutually-exclusive top-level view. This whole path is READ-ONLY + EPHEMERAL:
  // it reads recipes.csv + recipe_ingredients.csv FRESH, scales in memory, and
  // NEVER writes to disk (no _rewrite / delta / merge / approve). Nothing here is
  // ever persisted — the in-memory plan lives only for the session.
  mealPlanView: false,
  mealPlanError: '',

  // Phase 17 (Plan 17-02) — meal-plan SYNC slice. The shared plan rides
  // meal_plan.json; these track the 3-way merge base + the debounced push state.
  // OWN error channel (mealPlanSyncStatus) — never parseError, never blocks boot.
  _mealPlanBase: null,        // the persisted 3-way merge base (D-01/D-14); restored on boot
  _mealPlanSha: undefined,    // cached blob sha for meal_plan.json (D-13: absent = CREATE first write)
  _planPushTimer: null,       // the ~10s debounce handle (D-05); null = no push pending
  _planPushPending: false,    // true while a debounced push is scheduled OR in flight
  _suppressPlanPush: false,   // set while a NON-user mutation runs (boot restore / pull-apply / open reconcile) so a pull never bounces back into a push
  planSyncing: false,         // true while a push/pull is actually in flight (for the label)
  mealPlanSyncStatus: '',     // own-error-channel copy on a failed plan sync (never parseError)
  mealPlanLastSyncedAt: '',   // ISO of the last successful plan push/pull (for mealPlanSyncLabel)

  // Phase 07 (ROSTER-02) — resident-roster session slice. DATA-ISOLATED from the
  // recipe csvFiles slice (PATTERNS §D, CONTEXT data-isolation LOCKED): these
  // fields are NEVER mixed with csvStoreLoaded / csvHeaders / ingredientMaster,
  // and loadRosterFromCache() never writes any of those. Loaded non-fatally on
  // boot from the codaRoster cache (an empty cache is a valid first-run state,
  // NOT an error). The roster's error channel (rosterError) is SEPARATE from
  // parseError so a roster failure and a recipe failure never cross.
  rosterLoaded: false,
  rosterError: '',
  rosterTables: { residency: [], onboarding: [] },
  joinedRoster: [],
  // Plan 07-03 — present-on-D panel slice. residentsView is the FIFTH top-level
  // mutually-exclusive view (sibling to managerView/recipeManagerView/mealPlanView).
  // residentsDate is the picked date (YYYY-MM-DD); defaulted to LOCAL today in
  // init() (NOT toISOString().slice(0,10), which is UTC and can be off by a day
  // near midnight — RESEARCH §3c). rosterFetching is the live-fetch busy flag.
  residentsView: false,
  residentsDate: '',
  rosterFetching: false,
  // quick 260620-p1f — the roster cache's last-fetch ISO timestamp (from the
  // cached residency table's fetchedAt), used by maybeAutoFetchRoster for the
  // once-per-day staleness check. null when the cache is absent.
  rosterFetchedAt: null,
  // Phase 17 (Plan 17-03, D-09/D-13) — cached blob sha for residents_roster.json.
  // absent/undefined = CREATE on the first snapshot write; present = UPDATE
  // thereafter. The snapshot push is LWW OUTSIDE the advisory lock: on a stale-sha
  // 409 it re-pulls this sha and re-PUTs (overwrite), never a hard-stop.
  _rosterSnapshotSha: undefined,

  // Phase 16 (D40/D41) — the curated 4th-file (residents_allergens.csv) session
  // slice. DATA-ISOLATED like the roster: loaded NON-FATALLY (a missing 4th file
  // never blocks the recipe load — 16-RESEARCH Pitfall 3). `residentAllergenRows`
  // is the parsed disk-row array (kept for the edit modal + commit); `_residentAllergenByAppid`
  // is the per-render conflict-lookup Map (keyed by the SAME String(appid).trim()
  // coercion the join uses), built ONCE off the rows by the getter below.
  residentAllergenRows: [],
  residentAllergenColumns: null,   // captured header (or null → use RESIDENT_ALLERGEN_COLUMNS on create)
  residentAllergenError: '',       // own error channel (never parseError/rosterError)
  // Phase 16 — resident edit modal state. editingResidentAppid !== null drives the
  // modal x-show (joins anyModalOpen — no stacking). residentEditForm holds the
  // in-flight edit (raw text + curated FSA-14 array + reviewed marker).
  editingResidentAppid: null,
  residentEditError: '',
  residentEditForm: { appid: '', full_name: '', allergies_raw: '', allergies_detail: '', fsa14: [], reviewed: false, notes: '' },
  // quick 260615-dap — reconcile notice: set on openMealPlan when a persisted
  // pick is dropped because its recipe no longer exists. Cleared on a clean open.
  mealPlanNotice: '',
  mealPlanFilter: '',
  // mealPlan — the user's picked recipes. Each entry: { id:string,
  // recipe_id:number, name:string, type:string, servings:number,
  // collapsed:boolean, date:string } (servings defaults to 4; collapsed
  // defaults true — quick 260615-dap; id is a per-entry crypto.randomUUID and
  // date is 'YYYY-MM-DD' or '' — quick 260615-lzq, so the SAME recipe can sit
  // on multiple days). A MINIMAL projection ({id, recipe_id, date, servings,
  // collapsed}) is persisted to localStorage so the plan survives a refresh;
  // name/type/mealPlanGrouped are refreshed/rebuilt on open (never persisted).
  mealPlan: [],
  // mealPlanGrouped — READ-ONLY source rows for scaling, keyed by recipe_id ->
  // Array of lightweight scaled-source objects (ingredient_id, ingredient_name,
  // quantity_metric, unit_metric, quantity_volumetric, unit_volumetric,
  // line_order, raw_text). Built once on openMealPlan from a FRESH disk read.
  // These are sources for scale.js ONLY; nothing on this path is written back.
  mealPlanGrouped: {},
  // phase 09-08 / PORT-04 (D24) — the per-day tray + prep collapse maps
  // (trayCollapsedByDay / prepCollapsedByDay) were REMOVED here: Tray/Prep are now
  // focused MODALS keyed off the transient trayModalDay / prepModalDay state
  // (declared further down with cooksPopoverOpenFor). The inline collapse mechanism
  // they backed no longer exists.
  // quick 260621-sjs — READ-ONLY map of recipe_id (parseInt number) ->
  // recipe-level prep_notes string. Built inside _rebuildMealPlanGrouped from a
  // FRESH recipes.csv read (mirrors mealPlanGrouped liveness — refreshes on open
  // and after recipe saves). NOT persisted. Recipe-level prep_notes ONLY (recipes.csv
  // col 4) — NEVER the ingredient-level prep_note from recipe_ingredients.csv.
  recipePrepById: {},
  // quick 260620-esf — persisted UI pref: the "Add recipes" picker section is
  // COLLAPSED BY DEFAULT (locked decision 1). Toggled in the markup with an
  // explicit _persistMealPlanUi() call. Persisted via MEAL_PLAN_UI_KEY.
  mealPlanPickerCollapsed: true,
  // quick 260620-esf — per-day collapse, keyed by group.key. Convention: missing key
  // === COLLAPSED default, === false === EXPANDED. IS persisted (MEAL_PLAN_UI_KEY).
  dayCollapsedByDay: {},
  // quick 260620-s49 — per-day COOKS map, keyed by 'YYYY-MM-DD' date string →
  // array of resident APPIDs (stringified, decision 5). Local planning annotation
  // ONLY: never exported / never wired into scaling/shopping/tray (decision 7).
  // Persisted in MEAL_PLAN_UI_KEY alongside dayCollapsedByDay (decision 4). A
  // stored APPID no longer present that day is KEPT in the map but NOT rendered
  // as a checkbox and OMITTED from the label (decision 6 — keep simple, never
  // deref a missing lookup). Capped at 3 cooks per day (decision 2).
  cooksByDay: {},
  // quick 260621-co6 — per-day EXCLUDE-FROM-SHOPPING map, keyed by group.key (the
  // 'YYYY-MM-DD' day string, or '' for the Unscheduled group). CHOSEN CONVENTION:
  // dayExcludedFromShopping[key] === true means that day is EXCLUDED from the
  // combined shopping list + the linked "Check you have these" check-stock; a MISSING
  // key (or any non-true value) means INCLUDED. Missing-key = included makes
  // "default = INCLUDED" the natural default (locked decision 2), mirroring how
  // dayCollapsedByDay treats a missing key as its default. Persisted in
  // MEAL_PLAN_UI_KEY alongside dayCollapsedByDay/cooksByDay. Per-day tray lists
  // (trayForDay) are UNAFFECTED by this map (locked decision 1).
  dayExcludedFromShopping: {},
  // quick 260627-i6h (D13a) — the "shopping period" / ORDER-SCOPE range. The single
  // source of truth for which days are in the CURRENT shopping order, REPLACING the
  // per-day dayExcludedFromShopping toggle. Value shape: null (the DEFAULT — "whole
  // plan", behaviour IDENTICAL to before this feature) OR a plain object
  // { startKey, endKey } where both are ISO 'YYYY-MM-DD' day-key strings and
  // startKey <= endKey (lexicographic). Stored as a RANGE (not a per-day map) so days
  // added to the plan LATER auto-fall in/out of scope correctly. localStorage UI-pref
  // ONLY (MEAL_PLAN_UI_KEY) — NEVER an IndexedDB/CSV write. Membership is decided by
  // the ONE shared helper isDayInOrderScope (do NOT duplicate the range logic).
  orderScopeRange: null,
  // quick 260621-lft — per-day LEFTOVERS map, keyed by group.key (the 'YYYY-MM-DD'
  // day string). CONVENTION: dayLeftovers[key] === true marks that day as a
  // "leftovers day" — its roster headcount rolls onto the IMMEDIATELY PRECEDING
  // calendar day (decision 1: STRICTLY the day directly above, NO chaining), because
  // that previous day cooks enough to cover this day too. A MISSING key (or any
  // non-true value) means NOT a leftovers day (the default). ADVISORY ONLY (decision
  // 2): the rollover boosts the previous day's "N present" subtitle + its per-recipe
  // SUGGESTED servings (suggestedServingsFor) — it NEVER mutates entry.servings or the
  // shopping list. The toggle is only offered on EMPTY upcoming days (see markup), and
  // _leftoverBonusInto re-checks emptiness so a stale flag on a day that later gained
  // recipes contributes nothing. Persisted in MEAL_PLAN_UI_KEY alongside cooksByDay.
  dayLeftovers: {},
  // quick 260627-iy8 — per-day PREP-DONE map, keyed by group.key (the 'YYYY-MM-DD'
  // day string, '' for Unscheduled). CONVENTION: prepDoneByDay[key] === true marks
  // that day's advance-prep as DONE — its Prep day-button flips amber→green but STAYS
  // VISIBLE (the x-show gate is unchanged; done is purely a colour/label state). A
  // MISSING key (or any non-true value) means NOT done (the default). Persisted in
  // MEAL_PLAN_UI_KEY alongside dayLeftovers; localStorage UI-prefs ONLY — NEVER an
  // IndexedDB/CSV write.
  prepDoneByDay: {},
  // phase 08 REG-07 — per-PLAN regulars overrides, keyed by String(ingredient_id) →
  // { qty?, skip? }. qty absent/null = use the suggested qty (rate × person-days); an
  // explicit qty of 0 is a DELIBERATE zero-out (distinct from absent/null — see
  // regularSuggestedQty's contract); skip === true = excluded from this shop. A MISSING
  // key = no override (use suggested, not skipped). Persisted in MEAL_PLAN_UI_KEY
  // alongside dayExcludedFromShopping with the SAME fail-open plain-non-null-object
  // guard. localStorage UI-prefs ONLY — NEVER an IndexedDB/CSV write.
  regularsOverrides: {},
  // phase 08 REG-07 — per-PLAN ad-hoc "buy this once" extras, an array of
  // { ingredient_id } (id only; no qty/flag — REG-06). Surfaced as plain buy lines by
  // Plan 03's merge. Persisted in MEAL_PLAN_UI_KEY with an Array.isArray guard.
  // localStorage UI-prefs ONLY — NEVER an IndexedDB/CSV write.
  adHocExtras: [],
  // quick 260620-s49 — TRANSIENT (NOT persisted): the date key whose cooks popover
  // is currently open ('' = none open; one popover at a time). MUST NOT be added
  // to _persistMealPlanUi()/_restoreMealPlanUi() (mirrors mealPlanFiltersOpen).
  cooksPopoverOpenFor: '',
  // quick 260627-i6h (D13a) — TRANSIENT (NOT persisted; mirrors cooksPopoverOpenFor):
  // is the order-scope ("shopping for this order") from→to range picker open?
  // false = closed. It is ephemeral view state, like cooksPopoverOpenFor, and is
  // DELIBERATELY excluded from the localStorage UI-prefs payload + its restore.
  // @click.outside closes it.
  scopePickerOpen: false,
  // quick 260627-i6h (D13a) — TRANSIENT (NOT persisted) From/To <select> bindings for
  // the range picker. Seeded from the active orderScopeRange (or first/last dated day
  // when no range is set) each time the picker opens (openScopePicker). Writing a
  // select calls applyOrderScope(scopeFromKey, scopeToKey) which is the real persisted
  // state mutation; these two are just the live picker widgets' model. MUST NOT be
  // persisted.
  scopeFromKey: '',
  scopeToKey: '',
  // phase 09-08 / PORT-04 — TRANSIENT view-dialog state (NOT persisted; modelled on
  // cooksPopoverOpenFor): the date key whose Tray / Prep modal is open ('' = closed,
  // one of each at a time). REPLACES the old inline trayCollapsedByDay /
  // prepCollapsedByDay collapse sections (D24 — Tray/Prep are now focused MODALS over
  // the dimmed plan). MUST NOT be added to _persistMealPlanUi/_restoreMealPlanUi —
  // these are ephemeral view states, like cooksPopoverOpenFor. Both join anyModalOpen
  // (below) so the top-level Settings/Import openers can't stack over an open dialog.
  trayModalDay: '',
  prepModalDay: '',
  // quick 260627-r94 (R94-3) — the date key whose per-day ALLERGEN modal is open
  // ('' = closed). Ephemeral view state like trayModalDay/prepModalDay; NOT persisted;
  // joins anyModalOpen below for no-stacking parity. Replaces the old inline per-day
  // allergen banner — the header now shows just a dayAllergenIcon, which opens this.
  allergenModalDay: '',
  // phase 09-08 / PORT-04 — TRANSIENT (NOT persisted; modelled on cooksPopoverOpenFor):
  // the date key whose per-day ⋯ overflow menu is open ('' = none, one at a time).
  // Holds ONLY real lower-frequency day actions (Cook this day + Exclude/Include from
  // this order). @click.outside closes it. NOT in _persistMealPlanUi/_restoreMealPlanUi.
  dayMenuOpenFor: '',
  // quick 260607-anu — transient one-time-migration result banner. Shapes:
  // { migrated, rowCount, backfillCount } | { alreadyMigrated:true }. A verify
  // failure surfaces via the informational mergeRestoreOffer (putFile auto-revert).
  lastMigrationSummary: null,
  // fast 2026-06-08 — drives the Migrate schema button's visibility. Computed
  // from the loaded headers (true iff EITHER file is still off the new schema)
  // and forced false after a successful migrateLiveSchema. Shown only when
  // csvStoreLoaded && schemaMigrationNeeded.
  schemaMigrationNeeded: false,

  // quick 260612-m6c — order-format shopping-list export modal state. ADDITIVE +
  // READ-ONLY: openShoppingExport() reads ingredients.csv FRESH via getFile (pack
  // size / unit / link reflect edits without reload) and never writes the store;
  // Download builds a NEW browser file (Blob/anchor), not a store write.
  shoppingExportOpen: false,
  shoppingExportText: '',
  shoppingExportCopied: false,

  // quick 260618-9sq — meal-list tab switcher + check-stock text-export modal.
  // mealListTab selects which body of the merged shopping/check-stock panel is
  // visible (default 'shopping'). The check-stock export is ADDITIVE + READ-ONLY,
  // parallel to the shopping export: openCheckStockExport is SYNCHRONOUS (reads
  // checkStockSections / formatPackLine in-memory; no getFile, no store write);
  // Download builds a NEW browser file (Blob/anchor), not a store write.
  // quick 260620-esf — now accepts a THIRD value 'tray' (Tray lists tab, stacks
  // every Upcoming day's trayForDay grouping). Default stays 'shopping'.
  mealListTab: 'shopping',
  // quick 260618-ahg — meal-plan Upcoming/Past view toggle. NOT persisted: always
  // starts on 'upcoming' each load. Distinct from mealListTab above (do not conflate).
  mealPlanTab: 'upcoming',
  // quick 260618-e1z — meal-plan picker filter+sort state (upcoming-tab only).
  // These PARALLEL the recipeManager* filters but are PICKER-LOCAL and TRANSIENT:
  // separate fields (never reuse recipeManager*), and NOT persisted (reset per
  // session, same as mealPlanTab). Consumed only by filteredMealPlanPickList.
  //   mealPlanTypeFilter      []          selected types (lowercase: main/side/salad)
  //   mealPlanAllergenFilter  []          FSA14 allergens to AVOID (hide containing)
  //   mealPlanSort            'default'   default | least-recent | max-servings-desc | easiest
  //   mealPlanMinServings     ''          number → keep max_servings >= N; '' = off
  //   mealPlanMaxDifficulty   ''          1..5 → keep difficulty <= N; '' = off
  //   mealPlanHidePlanned     false       hide recipe_ids already in upcomingEntries
  mealPlanTypeFilter: [],
  mealPlanAllergenFilter: [],
  mealPlanSort: 'default',
  mealPlanMinServings: '',
  mealPlanMaxDifficulty: '',
  mealPlanHidePlanned: false,
  // quick 260620-fn6 — advanced-filters disclosure. TRANSIENT: deliberately NOT
  // persisted (advanced filters default hidden each session, like mealPlanTab).
  // MUST NOT be added to _persistMealPlanUi()/_restoreMealPlanUi().
  mealPlanFiltersOpen: false,
  // quick 260621-amm — days-first picker MODAL state. BOTH TRANSIENT (NOT persisted,
  // NOT in _persistMealPlanUi/_restoreMealPlanUi): the focused recipe picker now opens
  // as a modal pre-targeted to a specific day. mealPlanPickerOpen drives the modal's
  // x-show (and is registered in anyModalOpen for no-stacking); mealPlanPickerTargetDate
  // is the 'YYYY-MM-DD' day a pick lands on ('' = Unscheduled). Set via openPickerForDate.
  mealPlanPickerOpen: false,
  mealPlanPickerTargetDate: '',
  checkStockExportOpen: false,
  checkStockExportText: '',
  checkStockExportCopied: false,

  // quick 260615-nev — tray-list text-export modal state. ADDITIVE + READ-ONLY:
  // the copy/print companion to the on-screen per-day tray panels (260615-ms3).
  // Unlike openShoppingExport, openTrayExport needs NO fresh CSV read — trayForDay /
  // mealPlanByDay / formatPackLine are synchronous in-memory getters/methods, so the
  // opener is synchronous and never touches getFile or the store. Download builds a
  // NEW browser file (Blob/anchor), not a store write.
  trayExportOpen: false,
  trayExportText: '',
  trayExportCopied: false,

  // Phase 06 (Plan 06-02) — "Cook this day" artifact generation flags. ADDITIVE +
  // non-persisted. cookArtifactWarning surfaces the file:// degraded-mode notice
  // (localStorage/Wake-Lock die on an opaque-origin blob — RESEARCH Pitfall 1);
  // cookArtifactBlocked surfaces a popup-blocked notice (RESEARCH Pitfall 2);
  // cookArtifactError surfaces a fail-closed recipes.csv read error. All start clear.
  cookArtifactWarning: '',
  cookArtifactBlocked: false,
  cookArtifactError: '',

  // ---------- REVIEW-04 / REVIEW-05 (Plan 03-01) ----------
  // Quick 260607-9zz item 3 — `hoveredFlaggedField` REMOVED. Per-field reason
  // codes now render always-visible (the .field-tooltip span x-shows on the
  // flaggedFieldsByKey entry directly), so the hover/focus reveal state and its
  // label-level handlers are gone. No remaining consumer in app.js or index.html.

  // ---------- REVIEW-07 (Plan 03-03) ----------
  // Click-to-source highlight state. The user clicks any per-row editable
  // field; highlightSource(rowKey, field) looks up the row's raw_text in the
  // current raw paste (D-29 whitespace-normalized exact substring) and stamps
  // these two fields so the left pane's <pre> review-mode swap-in renders the
  // matched line with a persistent yellow ribbon (D-30) + scrolls it into view.
  // Both reset to null on no-match (highlight stays as before — see action),
  // on clearHighlight() (user clicks the <pre>), and on parse() start.
  //
  // matchedHighlightKey — the _key of the row whose line is currently
  //   highlighted (or null). Tracked so a stale click on a removed row can be
  //   detected (the row.find returns undefined → action no-ops defensively).
  // matchedLineIndex — the 0-based line index in rawTextLines of the currently
  //   highlighted <span>, consumed by :class="raw-line-highlighted" binding.
  matchedHighlightKey: null,
  matchedLineIndex: null,

  // ---------- REVIEW-09 / REVIEW-10 (Plan 03-04) ----------
  // In-flight review persistence (REVIEW-09) + recipe_id recompute (REVIEW-10).
  //
  // inflightPersistTimer — setTimeout handle for the 750ms debounce (D-43).
  //   scheduleInflightPersist() clears + re-arms; the settled timer calls
  //   persistInflight() which snapshots to localStorage.
  // inflightRestorable — parsed restore-candidate payload from localStorage,
  //   populated by init() when the slot exists and shape-validates. Drives
  //   the restore-prompt's recipe-name preview.
  // restorePromptOpen — boolean controlling the restore-prompt modal x-show.
  // recipeIdSuggestion — editable form value for the recipe_id (REVIEW-10).
  //   Populated on parse-success from maxRecipeIdAtSessionStart + 1; bound
  //   to a header input via x-model.number; recomputed from disk at Approve.
  // recipeIdRecomputeNotice — { newSuggestion, oldFormValue } when the
  //   Approve-time disk recompute reveals a mismatch; null otherwise. Drives
  //   the inline notice with "Use {N}" / "Keep my number" buttons.
  inflightPersistTimer: null,
  inflightRestorable: null,
  restorePromptOpen: false,
  recipeIdSuggestion: null,
  recipeIdRecomputeNotice: null,

  // ---------- Read-only references exposed for the template ----------
  // Alpine's reactive proxy lets the <template x-for="allergen in FSA14">
  // iterate over this. Never mutate at runtime — it's the locked FSA-14 list.
  FSA14,
  // REASON_CODE_TOOLTIPS (REVIEW-05 / D-34) exposed on the factory so the
  // per-row template can do `REASON_CODE_TOOLTIPS[entry.reason_code]` directly
  // without an extra wrapper getter. The map is frozen-by-convention (module
  // constant) so iteration order matches REASON_CODE_ENUM.
  REASON_CODE_TOOLTIPS,
  // quick 260618-ihr — REVIEW_FLAG_LABELS exposed on the factory so the
  // review-pane banner template can do `REVIEW_FLAG_LABELS[f.reason_code]`
  // directly. Keys match REVIEW_FLAG_ENUM (schema.js).
  REVIEW_FLAG_LABELS,
  // FLAGGED_FIELD_NAME_ENUM exposed for any template-side iteration / sanity
  // assertions; not strictly required by the current Phase 3 bindings (each
  // input's field name is hard-coded in the markup) but cheap to expose and
  // matches the schema.js source of truth.
  FLAGGED_FIELD_NAME_ENUM,
  // `blankRow` is expressed on the store so the inline x-on handler
  // `@click="form.rows.push(blankRow(form))"` resolves it as a method.
  blankRow,

  // ----- Lifecycle -----
  async init() {
    // Synchronous fields above already capture chromiumSupported + apiKey
    // (read from localStorage). The only init-time side effect in Phase 1 is
    // to auto-open the Settings modal when there's no saved API key — this is
    // SHELL-02 (first-run flow). We do NOT touch the File System Access API
    // here; that's gated behind a user-gesture click on Pick CSV folder.
    // 03-REVIEW WR-07 — gate the Settings auto-open on no-restore-pending so
    // the two modals (.modal sharing z-index 1000) cannot stack. If the
    // user has no API key AND an inflight slot exists, the restore prompt
    // wins on first render; the user dismisses or resumes, then we re-open
    // Settings if the key is still missing (see end of restoreInflight /
    // dismissInflight). Order of evaluation matters: the inflight-restore
    // read happens AFTER this conditional, so we use a forward-reference
    // check by reading the persisted localStorage key directly here.
    const _inflightPending = localStorage.getItem(INFLIGHT_REVIEW_KEY) != null;
    if (!this.apiKey && !_inflightPending) {
      this.settingsOpen = true;
    }

    // Plan 07-03 — default the residents-panel date to LOCAL today. Build it from
    // a local Date's getFullYear/getMonth/getDate (NOT toISOString, which is UTC
    // and can land on the wrong calendar day near midnight — RESEARCH §3c). The
    // panel passes this string straight to residentsPresentOnDate (an <input
    // type=date>.value is already YYYY-MM-DD), so the comparison stays TZ-safe.
    if (!this.residentsDate) {
      const _now = new Date();
      const _pad = n => String(n).padStart(2, '0');
      this.residentsDate = `${_now.getFullYear()}-${_pad(_now.getMonth() + 1)}-${_pad(_now.getDate())}`;
    }

    // Dev affordance: ?dev=1 unhides the Load Example button. Stored once at
    // init so dropping the query param mid-session doesn't surprise the user.
    this.devMode = new URLSearchParams(window.location.search).get('dev') === '1';

    // Bundled-defaults loading (SHELL-03 / D-22 / API-06).
    // The system-prompt default comes from the DEFAULT_PROMPT_TEMPLATE
    // constant exported by system-prompt.js — assigned synchronously so a
    // conversions.json fetch failure does not lose the prompt default. The
    // conversions.json fetch lives here so the Settings advanced section
    // has the bundled default to show. On fetch failure we surface a plain-
    // language warning and proceed — parse() still works (with the empty
    // currentConversions getter returning {}) and the override path remains
    // available.
    this.defaultSystemPrompt = DEFAULT_PROMPT_TEMPLATE;
    try {
      const resp = await fetch('./conversions.json');
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      this.defaultConversionsJsonText = await resp.text();
    } catch (_e) {
      this.parseError = "Couldn't load the conversions file. The advanced settings section may be empty.";
    }

    // Phase 4 / Plan 04-04 / D-56 — load bundled allergen-keywords.json. Silent
    // fail on missing/corrupt: the currentAllergenKeywords getter fail-opens
    // to [] so the soft-block heuristic simply lies dormant. We deliberately
    // do NOT set parseError here — an absent keyword list is advisory-only and
    // does not block parsing or Add-new submission (D-49 — empty allergens is
    // a valid state when no keyword fires).
    try {
      const resp = await fetch('./allergen-keywords.json');
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      this.defaultAllergenKeywordsText = await resp.text();
    } catch (_e) {
      console.warn('allergen-keywords.json load failed');
    }

    // Phase 1 explicitly does NOT attempt to restore a persisted directory
    // handle. D-15 accepts re-pick-on-refresh; persistence (RESEARCH §5c) is
    // deferred to a Phase 2 polish ticket.

    // REVIEW-09 / D-42 (Plan 03-04) — restore-prompt branch. If a previous
    // session left an inflight slot, parse + shape-validate it and queue the
    // restore prompt. Per D-42-ambiguity-resolution (RESEARCH §4 Open Question
    // 1) the prompt fires whenever the slot exists; we do NOT gate on a
    // separate persisted-rawText match check (matches UI-SPEC modal copy).
    // Corrupt-blob handling: JSON.parse throw OR version !== 1 OR malformed
    // shape → removeItem + plain-language banner via parseError with 5s
    // auto-dismiss (UI-SPEC Error State).
    try {
      const raw = localStorage.getItem(INFLIGHT_REVIEW_KEY);
      if (raw) {
        const payload = JSON.parse(raw);
        if (payload && payload.version === 1 && payload.form && payload.form.header) {
          this.inflightRestorable = payload;
          this.restorePromptOpen = true;
        } else {
          // Wrong shape or future version — silently discard.
          localStorage.removeItem(INFLIGHT_REVIEW_KEY);
        }
      }
    } catch (_e) {
      localStorage.removeItem(INFLIGHT_REVIEW_KEY);
      this.parseError = "Your saved progress couldn't be read — starting fresh. (You can paste the recipe again to retry.)";
      setTimeout(() => {
        if (this.parseError && this.parseError.startsWith("Your saved progress")) {
          this.parseError = '';
        }
      }, 5000);
    }

    // REVIEW-09 / D-42..D-43 (Plan 03-04) — Alpine.effect deep-tracking
    // watcher. Touches every reactive read source the persistence layer
    // cares about (form.header, form.rows via JSON.stringify deep-track per
    // Alpine discussion #3922, rawText, recipeIdSuggestion) so any mutation
    // schedules a debounced persist. The `if (this.form.header)` gate
    // prevents the watcher from scheduling persists pre-parse (typing into
    // the rawText textarea during paste mode is not in-flight review state).
    Alpine.effect(() => {
      // Touch the reactive properties the effect should track.
      const _h = this.form.header;
      const _r = this.form.rows.length;
      // Deep-track every row's fields — JSON.stringify forces full traversal
      // (the documented Alpine pattern for deep watchers).
      JSON.stringify(this.form.rows);
      const _t = this.rawText;
      const _id = this.recipeIdSuggestion;
      if (this.form.header) this.scheduleInflightPersist();
    });

    // quick 260615-dap — restore the persisted meal plan (minimal projection)
    // BEFORE loadFromStore. It needs no disk read: name/type are refreshed and
    // any stale pick is reconciled on the next openMealPlan. The $watch below is
    // belt-and-braces ONLY — explicit _persistMealPlan() calls on each mutation
    // are the load-bearing persist path (Alpine $watch is unreliable on nested
    // array-element mutations — plan-check WARNING).
    // Phase 17 (Plan 17-02, D-05) — boot restore mutates the plan but is NOT a
    // user edit; suppress the debounced push so a reload never auto-pushes.
    this._suppressPlanPush = true;
    this._restoreMealPlan();
    // quick 260620-esf — restore the meal-plan UI prefs (Add-recipes collapsed +
    // per-day collapse map). UI-prefs only; no disk read.
    this._restoreMealPlanUi();
    // Phase 17 (Plan 17-02, D-14) — restore the persisted 3-way merge base BEFORE
    // any plan pull so the first merge-on-push diffs against the surviving base
    // (not a fresh-empty base, which would degrade to last-write-wins).
    this._restoreMealPlanBase();
    this._suppressPlanPush = false;
    this.$watch('mealPlan', () => this._persistMealPlan());

    // Phase 10 (CR-01) — rehydrate the shared-store connection from the persisted
    // credentials BEFORE the boot pull. githubConnected is false in the data
    // literal (it can't read sibling fields there); seed it here from the
    // presence of owner+repo+token (branch defaults to 'main') so loadFromStore's
    // `if (this.githubConnected)` boot pull actually runs for a returning user.
    // remoteOk stays false until that pull succeeds, so a stale cache is never
    // presented as writable in the meantime (readOnlyMode / T-10-10).
    this.githubConnected = !!(this.githubOwner && this.githubRepo && this.githubToken);

    // quick 260612-abt — auto-load from the IndexedDB store on boot. If a store
    // exists (the user imported before), populate session state with NO pick /
    // import. If not, leave csvStoreLoaded=false so the import prompt shows
    // (first-run). Wrapped so a store-read failure never blocks the rest of init.
    try {
      await this.loadFromStore();
    } catch (e) {
      this.parseError = `Couldn't load your saved data from this browser: ${(e && e.message) || 'unknown error'}.`;
    }

    // Phase 07 (ROSTER-02) — load the cached resident roster as a SEPARATE,
    // non-fatal slice AFTER loadFromStore. These two awaited blocks are
    // independent: a roster read failure must NOT block recipe load, and a recipe
    // read failure must NOT block roster load (PATTERNS §"non-fatal awaited load
    // in init"). The roster's error goes to rosterError, never parseError.
    try {
      await this.loadRosterFromCache();
    } catch (e) {
      this.rosterError = `Couldn't load the cached roster: ${(e && e.message) || 'unknown error'}.`;
    }

    // Phase 16 (D40/D41) — load the curated 4th file (residents_allergens.csv) as a
    // SEPARATE, non-fatal slice. A missing/absent 4th file (first run, or an old
    // shared repo) is a VALID state and must NEVER block the recipe slice — its
    // error goes to residentAllergenError, never parseError/rosterError.
    try {
      await this.loadResidentAllergens();
    } catch (e) {
      this.residentAllergenError = `Couldn't load the curated resident allergens: ${(e && e.message) || 'unknown error'}.`;
    }

    // quick 260620-p1f — boundary-crossing daily auto-fetch (config-gated,
    // once-per-LOCAL-day, fire-and-forget). NOT awaited: must never block/affect
    // recipe load. Placed HERE (not openMealPlan, which runs inside loadFromStore
    // BEFORE the roster cache loads) so rosterFetchedAt is populated by the
    // preceding loadRosterFromCache.
    this.maybeAutoFetchRoster();

    // Phase 12 (LOCK-01, D-06) — best-effort lock release on tab close. This is a
    // COURTESY only and must NEVER be relied on: the TTL (LOCK_TTL_MS) is the real
    // guarantee that an abandoned lock frees itself. Deliberately NOT a
    // beforeunload/sendBeacon dance (those are unreliable + heavy) — just a fire-
    // and-forget DELETE on pagehide when we happen to hold the lock. If the tab is
    // killed before it lands, the stale-lock takeover (LOCK-04) covers it.
    window.addEventListener('pagehide', () => {
      if (this.heldLock) { try { this.releaseLock(); } catch (e) { /* best-effort */ } }
    });
  },

  /**
   * loadFromStore — quick 260612-abt. THE store read path. If the store is empty
   * (hasAnyFile false) leave csvStoreLoaded=false (first-run -> import prompt).
   * Otherwise read the 3 files, derive session state via the SINGLE shared
   * deriveSessionStateFromCsvs path, detect whether a schema migration is needed,
   * rebuild the duplicate index, and set csvStoreLoaded=true. Called on boot
   * (init) and after import.
   */
  async loadFromStore() {
    // Phase 10 Plan 03 (SYNC-01) — the READ-PATH chokepoint. When connected,
    // pull HEAD bytes + blob SHA for all 3 CSVs into the cache BEFORE the
    // hasAnyFile() early-return, so a fresh connected user with an EMPTY cache
    // gets SEEDED from remote (the pull writes the rows, then hasAnyFile() sees
    // them and falls through to render instead of returning to the import
    // prompt). The pull is NON-FATAL: a failure routes to its OWN remoteStatus
    // channel (never parseError) and we fall through to render whatever the
    // cache holds (D-02/D-05 read-only fallback). The NOT-connected path is
    // unchanged: pullFromRemote no-ops (its connected/token guard) and the
    // benign first-run import prompt shows exactly as before.
    if (this.githubConnected) {
      try {
        await this.pullFromRemote();
      } catch (e) {
        this.remoteStatus = this.githubFriendlyError(e);
        this._maybeRateLimitBanner(e); // ACCESS-04
        this.remoteOk = false;
      }
    }
    const any = await hasAnyFile();
    if (!any) {
      this.csvStoreLoaded = false;
      return;
    }
    // Phase 16: the recipe slice reads ONLY the 3 REQUIRED CSVs by literal name.
    // The optional 4th file (residents_allergens.csv) is DELIBERATELY NOT read here
    // and is NOT part of this partial-store check — a missing/absent 4th file must
    // never block the recipe load (16-RESEARCH Pitfall 3). It is read in a separate
    // non-fatal slice in 16-02.
    const recipes = await getFile('recipes.csv');
    const ingredients = await getFile('ingredients.csv');
    const recipeIngredients = await getFile('recipe_ingredients.csv');
    if (!recipes || !ingredients || !recipeIngredients) {
      // A partial store (some but not all 3 files) — surface a clear message and
      // do not flip csvStoreLoaded so the import prompt can re-seed the missing.
      this.csvStoreLoaded = false;
      this.parseError = 'Your saved data is incomplete (one of the 3 CSVs is missing). Import all three again.';
      return;
    }
    const derived = deriveSessionStateFromCsvs(recipes, ingredients, recipeIngredients);
    this.csvHeaders = derived.csvHeaders;
    this.ingredientMaster = derived.ingredientMaster;
    this.maxRecipeIdAtSessionStart = derived.maxRecipeIdAtSessionStart;

    // Schema-migration detection: the Migrate button shows iff either file is
    // still OFF the new schema (mirror the old folder-pick logic — needed iff
    // EITHER header is not yet migrated).
    this.schemaMigrationNeeded =
      !isMigratedJoinHeader(recipeIngredients.columns || [])
      || !isMigratedIngredientsHeader(ingredients.columns || [])
      // quick 260612-esy — Phase B: also light up when the master lacks
      // scale_category (a file migrated for shopping_unit but not yet categorized).
      || !isCategorizedIngredientsHeader(ingredients.columns || [])
      // quick 260614-eqa — also light up when the master lacks pantry_staple (a file
      // migrated for shopping_unit + scale_category but not yet staple-tagged).
      || !isStapleTaggedIngredientsHeader(ingredients.columns || [])
      // quick 260615-e1n — also light up when the master lacks pantry_section (a file
      // migrated for the prior three columns but not yet section-tagged).
      || !isSectionTaggedIngredientsHeader(ingredients.columns || [])
      // quick 260615-kid — also light up when the master lacks pack_units (a file
      // migrated for the prior four columns but not yet pack-unit-tagged; the
      // pack_unit_label column rides the same Migrate pass).
      || !isPackUnitsTaggedIngredientsHeader(ingredients.columns || [])
      // phase 08 / REG-01 — also light up when the master lacks regular (a file
      // migrated for the prior five columns but not yet regular-tagged; the
      // regular_qty_per_person column rides the same Migrate pass).
      || !isRegularTaggedIngredientsHeader(ingredients.columns || []);

    // Phase 4 / Plan 04-02 — D-54 session counter seed + Fuse instance init
    // (ported from the old pickCsvFolder). maxIngredientIdAtSessionStart is the
    // base for new-ingredient ID allocation; initFuse builds the match index
    // over the loaded master so parse()'s unknown-ingredient queue works.
    this.maxIngredientIdAtSessionStart = Math.max(
      0,
      ...this.ingredientMaster.map(e => Number.isFinite(e.ingredient_id) ? e.ingredient_id : 0)
    );
    this.initFuse();

    // Build the read-only duplicate index from the store (replaces the
    // folder-pick-time build). Fail-open: a build error never blocks load.
    try {
      await this.buildDuplicateIndex();
    } catch (_e) { /* fail-open — duplicate nudge simply stays dormant */ }

    // quick 260615-nx6 (NAV-DEFAULT-MEALPLAN) — land on the Meal Planner, not
    // Parse, once a store is loaded. openMealPlan early-returns if !csvStoreLoaded,
    // but here it is set true immediately below so this always enters the planner.
    // First-run (no store) is unaffected: loadFromStore returns early at
    // csvStoreLoaded=false above and the import surface still governs.
    this.csvStoreLoaded = true;
    await this.openMealPlan();

    // Phase 12 (LOCK-03, D-09) — surface presence passively on the boot read.
    // Piggybacks the existing on-boot cadence (NO new background timer); the
    // authoritative acquire-time check is the editor-open read (openEditRecipe /
    // openEditIngredient). Connected-only + fail-open: a presence-read failure
    // must NEVER block the data load.
    if (this.githubConnected && this.githubToken) {
      try { await this.refreshPresence(); } catch (_e) { /* presence is best-effort on boot */ }
    }
  },

  /**
   * _probeRemoteShape — the SHARED PASS-1 probe of the STORE_FILES. GETs each
   * via ghGetFile and applies the ONE 404-vs-error policy: a 404 means THAT file
   * is absent (counted, tolerated); ANY non-404 error (401/403/network/rate-limit)
   * is RE-THROWN for the caller to handle in its own channel. Writes NOTHING — a
   * pure probe. Returns { absentCount, fetched, optionalAbsent } where fetched is
   * [{ name, text, sha }] for the present files, so a caller can write the cache
   * (pullFromRemote PASS 2) without a second network round-trip; saveConnection's
   * connect-time existence probe ignores `fetched` and reads only `absentCount`.
   * Centralising the loop keeps the 404-vs-error decision in ONE place (it was
   * duplicated in pullFromRemote and saveConnection).
   *
   * Phase 16 (D41 + 16-RESEARCH Pitfall 1) — THE backward-compat split:
   * `absentCount` counts ONLY the REQUIRED recipe CSVs (REQUIRED_STORE_FILES, the
   * 3-file v2 contract). The optional 4th file `residents_allergens.csv` is probed
   * (and its bytes captured into `fetched` when present, so a connected pull writes
   * it for free) but its absence is recorded SEPARATELY as `optionalAbsent` and is
   * NEVER counted into `absentCount`. This keeps the empty/partial/full repo-shape
   * math correct: a repo seeded by a pre-Phase-16 (3-file) client classifies FULL,
   * not PARTIAL/read-only, for a 4-file client — the 4th file's 404 is the calm
   * "optional-absent → seed locally" state, never an error.
   *
   * Phase 17 (D-15) — the two OPTIONAL_JSON_FILES (`meal_plan.json`,
   * `residents_roster.json`) are probed in a DEDICATED JSON pass with the SAME
   * 404-vs-error policy, but their absence is recorded as `jsonOptionalAbsent` and
   * NEVER counted into `absentCount` (they are not CSVs and not in STORE_FILES).
   * Present JSON files' bytes are captured into `jsonFiles` ([{name,text,sha}]) so
   * pullFromRemote can write them via putJsonFile without a second round-trip. The
   * invariant: a pre-Phase-17 repo with NO JSON files yields absentCount unchanged
   * → classifies 'full', never 'partial' (SPEC acceptance #7). All four return keys
   * are additive — existing callers destructure only { absentCount, fetched }.
   *
   * @param {object} cfg — {owner, repo, branch, token}
   * @returns {Promise<{absentCount: number, fetched: Array<{name: string, text: string, sha: string}>, optionalAbsent: string[], jsonFiles: Array<{name: string, text: string, sha: string}>, jsonOptionalAbsent: string[]}>}
   */
  async _probeRemoteShape(cfg) {
    let absentCount = 0;            // REQUIRED files only (shape classification)
    const fetched = [];            // [{ name, text, sha }] for ALL present CSV files
    const optionalAbsent = [];     // optional STORE_FILES (e.g. the 4th) that 404'd
    for (const name of STORE_FILES) {
      const isRequired = REQUIRED_STORE_FILES.includes(name);
      try {
        const { text, sha } = await ghGetFile(cfg, name);
        fetched.push({ name, text, sha });
      } catch (e) {
        // 404 = that file is absent: tolerate. Any other error (genuine
        // 401/403/network reach failure) re-throws to the caller.
        if (e && e.status === 404) {
          if (isRequired) {
            absentCount++;          // counted toward empty/partial/full
          } else {
            optionalAbsent.push(name); // 4th-file 404 = optional-absent, NOT partial
          }
          continue;
        }
        throw e;
      }
    }

    // Phase 17 (D-15) — dedicated JSON probe pass. These ride their OWN path
    // (NOT the CSV STORE_FILES loop / PASS-2 write), so they are probed here but
    // NEVER touch absentCount: a 404 is optional-absent (seed empty/local), and
    // any non-404 re-throws to the caller exactly like the CSV branch.
    const jsonFiles = [];          // present OPTIONAL_JSON_FILES [{name,text,sha}]
    const jsonOptionalAbsent = []; // JSON files that 404'd — NEVER absentCount++
    for (const name of OPTIONAL_JSON_FILES) {
      try {
        const { text, sha } = await ghGetFile(cfg, name);
        jsonFiles.push({ name, text, sha });
      } catch (e) {
        if (e && e.status === 404) {
          jsonOptionalAbsent.push(name); // optional-absent, NOT partial (D-15)
          continue;
        }
        throw e; // 401/403/network/rate-limit → caller's own channel
      }
    }

    return { absentCount, fetched, optionalAbsent, jsonFiles, jsonOptionalAbsent };
  },

  /**
   * _jsonShapeCheckFor — Phase 17 (D-12). The per-file top-level shape gate
   * passed to putJsonFile so a structurally-wrong-but-valid-JSON blob is REVERTED
   * (never blanks the stored plan/roster). The check is deliberately TOP-LEVEL
   * only (presence + coarse type of the known keys) — it is a corruption tripwire,
   * not a deep schema validator. An unknown name returns a permissive "any object"
   * check (defensive; OPTIONAL_JSON_FILES is the only caller today).
   *
   * @param {string} name — 'meal_plan.json' | 'residents_roster.json'
   * @returns {(parsed:*) => boolean}
   */
  _jsonShapeCheckFor(name) {
    if (name === 'meal_plan.json') {
      // entries array + the 6 known map keys present (D-12). orderScopeRange may
      // be null; the maps may be empty objects — only presence + coarse type.
      const MAP_KEYS = ['cooksByDay', 'dayLeftovers', 'prepDoneByDay', 'regularsOverrides'];
      return (p) => {
        if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
        if (!Array.isArray(p.entries)) return false;
        // adHocExtras is an ARRAY, not a keyed map — `typeof [] === 'object'` would
        // let a corrupt `{}` slip past a generic map check (WR-03). Gate it explicitly.
        if (!Array.isArray(p.adHocExtras)) return false;
        for (const k of MAP_KEYS) {
          if (!(k in p) || typeof p[k] !== 'object' || p[k] === null) return false;
        }
        if (!('orderScopeRange' in p)) return false; // may be null
        return true;
      };
    }
    if (name === 'residents_roster.json') {
      // residency + onboarding objects, each with a rows array (D-10 / D-12).
      const hasRows = (t) => t && typeof t === 'object' && Array.isArray(t.rows);
      return (p) => {
        if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
        return hasRows(p.residency) && hasRows(p.onboarding);
      };
    }
    // Defensive default: any non-null object passes (no known shape to enforce).
    return (p) => !!p && typeof p === 'object';
  },

  /**
   * pullFromRemote — Phase 10 Plan 03 (SYNC-01, D-01 remote-wins). THE remote
   * read primitive: for each of the 3 STORE_FILES, fetch HEAD bytes + blob SHA
   * via ghGetFile, parse with the PURE parseCsv helper, and write into the
   * IndexedDB cache via putFile with the additive meta:{sha,fetchedAt} (Plan 01).
   * The pull OVERWRITES the cache with HEAD (remote-wins); each putFile keeps the
   * snapshot->verify->auto-revert chain (a verify failure reverts that one file
   * and throws, surfacing here as a non-fatal remoteStatus — never a partial
   * corrupt cache treated as good, T-10-11).
   *
   * Modelled on loadRosterFromCache's own-error-channel, non-fatal shape:
   * - Guard up front — no connection / no token = nothing to pull; return early
   *   so the caller falls through to the existing cache (the NOT-connected
   *   read-only view, D-02/D-05).
   * - On a thrown GhError / network error, route the friendly copy to remoteStatus
   *   (its OWN channel, NEVER parseError), set remoteOk=false, and RETURN so
   *   loadFromStore renders whatever the cache holds (T-10-12 — a pull error must
   *   never block boot).
   * - On full success set remoteOk=true, clear remoteStatus, and stamp
   *   lastSyncedAt with the freshest fetchedAt for the "Last synced" indicator.
   *
   * EMPTY/PARTIAL detection (DK6): a 404 on a STORE_FILE is COUNTED, not thrown,
   * so the all-3-404 case (a connected-but-empty shared repo) is recognised as
   * the calm, seedable state it is — NOT a generic reach failure. PASS 1 probes
   * all 3 files first (no cache writes) to learn the remote shape; only then does
   * it branch:
   *   - all 3 absent  → EMPTY: set remoteEmpty=true, clear remoteStatus, leave
   *     remoteOk=false (stay read-only until seeded), write NOTHING, return. This
   *     re-derives remoteEmpty on EVERY boot pull so the Initialize affordance
   *     (canSeed) survives a reload, and gives readOnlyBanner its empty signal.
   *   - all 3 present → FULL: PASS 2 writes every file (remote-wins) from the
   *     captured bytes, set remoteOk=true, clear remoteStatus, stamp lastSyncedAt,
   *     and clear remoteEmpty (correct a stale flag on empty→populated).
   *   - some absent   → PARTIAL: write NOTHING, set a clear incomplete-remote
   *     remoteStatus, remoteOk=false, remoteEmpty=false, return.
   * Probing first (never writing during the probe) preserves the property that a
   * failed/empty/partial pull NEVER overwrites the user's pre-seed local data.
   * Every non-404 error still re-throws to the existing catch → unchanged
   * alarming reach-failure banner (T-dk6-02).
   */
  async pullFromRemote() {
    // No connection / no token = nothing to pull. The caller falls through to
    // the last cache (read-only view). remoteOk is left as-is (false until a
    // good pull) so a never-connected session stays read-only.
    if (!this.githubConnected || !this.githubToken) return;
    const cfg = this.githubCfg; // read-fresh-per-call (rotated token, no reload)
    this.pulling = true;
    try {
      // PASS 1 — probe ALL 3 files first to learn the remote shape WITHOUT
      // writing the cache (shared _probeRemoteShape: counts 404s, captures present
      // files' bytes, re-throws any non-404 error to the existing catch below as
      // the genuine 401/403/network reach failure). The captured `fetched` lets
      // PASS 2 write without a second network round-trip.
      const { absentCount, fetched, jsonFiles } = await this._probeRemoteShape(cfg);

      // Phase 16: classify over the REQUIRED set via the PURE helper (the optional
      // 4th file's absence is excluded from absentCount in _probeRemoteShape, so a
      // 3-present/1-absent repo is 'full', never 'partial'). sync-backcompat.test.mjs
      // pins this decision.
      const shape = classifyRemoteShape(absentCount);

      if (shape === 'empty') {
        // EMPTY repo (DK6) — all REQUIRED recipe CSVs absent. A valid connected
        // state the founder can seed. Write
        // NOTHING (preserve pre-seed local data, T-dk6-01); flag remoteEmpty so
        // readOnlyBanner shows the calm copy and canSeed surfaces Initialize.
        // remoteOk stays false → readOnlyMode stays true until seeded.
        this.remoteEmpty = true;
        this.remoteStatus = '';
        this.remoteOk = false;
        return; // finally still runs this.pulling = false
      }

      if (shape === 'partial') {
        // PARTIAL remote (T-dk6-03) — a REQUIRED recipe CSV is missing. Never
        // write a partial cache. Surface a clear incomplete-remote message; stay
        // read-only; not an empty repo. (Phase 16: a 3-present/1-absent repo — the
        // 4th file missing — never reaches here; it is 'full' and falls through to
        // the PASS-2 write below.)
        this.remoteStatus = 'The shared database is incomplete — some files are missing. Ask whoever set it up to finish initializing it.';
        this.remoteOk = false;
        this.remoteEmpty = false;
        return;
      }

      // PASS 2 — all present, normal remote-wins pull. Write every captured file.
      let latestFetchedAt = '';
      for (const { name, text, sha } of fetched) {
        const record = parseCsv(text, Papa);
        const fetchedAt = new Date().toISOString();
        await putFile(name, { ...record, meta: { sha, fetchedAt } }, { Papa });
        latestFetchedAt = fetchedAt;
      }

      // Phase 17 (D-15 / D-12) — PARALLEL JSON write step. For each PRESENT
      // OPTIONAL_JSON_FILE, JSON.parse the bytes and land them in the store via
      // putJsonFile (its OWN snapshot->verify->auto-revert with the per-file
      // shapeCheck — a structurally-wrong blob reverts, never blanks the value).
      // This task ONLY lands the bytes + classifies absence; the in-memory
      // meal-plan / roster read-in is owned by Plan 02 / Plan 03.
      for (const { name, text, sha } of (jsonFiles || [])) {
        const parsed = JSON.parse(text); // a parse throw routes to the catch below
        const fetchedAt = new Date().toISOString();
        await putJsonFile(name, parsed, { shapeCheck: this._jsonShapeCheckFor(name), meta: { sha, fetchedAt } });
        // Phase 17 (Plan 17-03, D-08) — TOKENLESS roster read-in. Once the snapshot
        // bytes have landed (+ passed putJsonFile's shapeCheck), write its two
        // tables into the codaRoster cache so the existing roster UI renders with
        // NO Coda token. Cache the pulled sha so a later token-holder push UPDATEs
        // (D-13) instead of blindly CREATE-409ing. _readInRosterSnapshot is on the
        // roster's OWN error channel — it never throws into this pull's catch (a
        // read-in failure must not block the recipe pull / boot, T-17-10 parity).
        if (name === 'residents_roster.json') {
          this._rosterSnapshotSha = sha;
          await this._readInRosterSnapshot(parsed);
        }
      }

      // Full success — remote-wins pull landed for all 3 files.
      this.remoteOk = true;
      this.remoteStatus = '';
      this.lastSyncedAt = latestFetchedAt;
      this.remoteEmpty = false; // correct a stale flag on empty→populated
    } catch (e) {
      // Non-fatal: route to the pull's OWN channel and return so the cache
      // renders read-only. NEVER parseError (T-10-12); NEVER the token (the
      // friendly map keys only on status/name/githubMessage, T-10-14).
      this.remoteStatus = this.githubFriendlyError(e);
      this._maybeRateLimitBanner(e); // ACCESS-04
      this.remoteOk = false;
      return;
    } finally {
      this.pulling = false;
    }
  },

  /**
   * refreshFromRemote — Phase 10 Plan 03 (SYNC-03, D-03). The manual Refresh
   * affordance: a thin single-pass re-pull. Because loadFromStore() itself now
   * runs pullFromRemote() (when connected) before re-deriving session state, a
   * SINGLE loadFromStore() call re-pulls all 3 CSVs + SHAs AND re-renders.
   * Calling pullFromRemote() AND loadFromStore() would fetch every file TWICE
   * per Refresh — a needless rate-limit cost the phase explicitly minimises
   * (D-03 / T-10-15). So Refresh = ONE loadFromStore() pass. Busy state surfaces
   * via the existing `pulling` flag (set inside pullFromRemote); errors route to
   * the existing remoteStatus channel (no parallel channel).
   */
  async refreshFromRemote() {
    if (this.pulling) return; // double-click / in-flight guard
    await this.loadFromStore();
    // Phase 12 (LOCK-03, D-09) — the manual Refresh also re-reads presence so an
    // observer's banner clears/updates when they press Refresh (loadFromStore
    // already does a boot-style read; this keeps the manual-Refresh contract
    // explicit and robust if loadFromStore early-returns). Fail-open.
    if (this.githubConnected && this.githubToken) {
      try { await this.refreshPresence(); } catch (_e) { /* presence is best-effort on Refresh */ }
    }
  },

  // ==========================================================================
  // Phase 12 (LOCK-01..04) — advisory-lock state machine (read side).
  // The lock is COURTESY only; the Phase 11 CSV-blob 409 stays the real arbiter.
  // ==========================================================================

  /**
   * getServerNow — Phase 12 (LOCK-02). The OBSERVER-side skew-safe clock. Reads
   * GitHub's own server time via ghGetServerTime (Plan 01) and NaN-guards it via
   * parseServerTime — so a null/NaN/unparseable response HARD-ERRORS instead of
   * silently falling through to the local wall clock (the Date-header trap,
   * RESEARCH.md Pitfall 1). Reads fresh cfg per call (never cached — rotated
   * token). Returns epoch ms. Callers also stamp _lockServerNowMs so the
   * presenceBanner getter can compute elapsed without async I/O.
   */
  async getServerNow() {
    const cfg = this.githubCfg; // fresh per call
    const iso = await ghGetServerTime(cfg);
    return parseServerTime(iso); // THROWS GhError on null/NaN — no local-clock fallback
  },

  /**
   * _parseLock — Phase 12 (T-12-04, V5). DEFENSIVE parser for the UNTRUSTED
   * .mise-lock.json body (any co-user with the shared token, or a hand-edit, can
   * produce a malformed/partial file). Returns the parsed object only when it has
   * the required string fields; returns null ("no usable lock") on ANY defect —
   * NEVER throws, so a malformed lock can never crash refreshPresence and freeze
   * the state machine. Mirrors the try/catch-ignore precedent at the wake-lock
   * restore path. The force-release/takeover affordances stay available.
   */
  _parseLock(text) {
    try {
      const o = JSON.parse(text);
      if (!o || typeof o.holder !== 'string' || typeof o.expires !== 'string') return null;
      return o;
    } catch {
      return null;
    }
  },

  // --- single-owner heartbeat timer (T-12-07, wake-lock precedent) ---

  /**
   * _startHeartbeat — Phase 12 (LOCK-01, Pitfall 2). Starts the single-owner
   * heartbeat interval. Calls _stopHeartbeat() FIRST so the timer can NEVER stack
   * across repeated acquire/open cycles (the duplicate-interval commit-noise +
   * sha-race class, T-12-07). Mirrors the wake-lock single-handle precedent.
   */
  _startHeartbeat() {
    this._stopHeartbeat();
    this._lockHeartbeatTimer = setInterval(() => this.heartbeatLock(), LOCK_HEARTBEAT_MS);
  },

  /**
   * _stopHeartbeat — Phase 12 (LOCK-01). Idempotent: clears + nulls the single
   * interval handle. Safe to call when none is running (release/eviction paths).
   */
  _stopHeartbeat() {
    if (this._lockHeartbeatTimer !== null) {
      clearInterval(this._lockHeartbeatTimer);
      this._lockHeartbeatTimer = null;
    }
  },

  // --- observer read (D-09) ---

  /**
   * refreshPresence — Phase 12 (LOCK-03, D-09). The OBSERVER read: pulls the
   * current .mise-lock.json and reflects it into the reactive presenceLock the
   * getters read. A 404 = no lock = free (presenceLock null). A malformed body
   * parses to null via _parseLock (T-12-04 — never crashes the SM). Also stamps
   * _lockServerNowMs (best-effort) so presenceBanner can compute elapsed/staleness
   * without async I/O in a getter. Wired into boot/Refresh/editor-open in Plan 03.
   */
  async refreshPresence() {
    const cfg = this.githubCfg; // fresh per call
    // Best-effort server-now for the banner's elapsed/staleness math. Swallowed
    // on failure — a missing clock just means the banner shows 'a while' and
    // never flags stale; it must NEVER block the presence read itself.
    try { this._lockServerNowMs = await this.getServerNow(); } catch (e) { /* keep last */ }
    try {
      const { text, sha } = await ghReadLock(cfg);
      const lock = this._parseLock(text);
      this.presenceLock = lock ? { ...lock, sha } : null;
    } catch (e) {
      if (e instanceof GhAccessError && e.status === 404) { this.presenceLock = null; return; }
      throw e; // a real transport error — let the caller route it
    }
  },

  // --- acquire / heartbeat / release lifecycle (LOCK-01) ---

  /**
   * acquireLock — Phase 12 (LOCK-01). Claims the advisory lock for THIS user.
   * Reads any existing lock (404 → none), stamps fresh server time, writes the
   * {holder, acquiredAt, heartbeat, expires} payload via ghWriteLock (sha present
   * = UPDATE an abandoned/foreign file, absent = CREATE), records heldLock, clears
   * presenceLock, and starts the single-owner heartbeat. A RACED acquire 409s —
   * it PROPAGATES to the Plan 03 caller (no internal retry — SAVE-02 hard rule).
   */
  async acquireLock() {
    const cfg = this.githubCfg; // fresh per call
    // Read the existing lock so we UPDATE its sha rather than blind-CREATE (a
    // CREATE over an existing file 422s). 404 = none → CREATE.
    let existingSha;
    try {
      const { text, sha } = await ghReadLock(cfg);
      // Even a malformed existing file has a real blob sha we must UPDATE against.
      existingSha = sha;
    } catch (e) {
      if (e instanceof GhAccessError && e.status === 404) { existingSha = undefined; }
      else throw e;
    }
    const now = await this.getServerNow();
    const iso = (ms) => new Date(ms).toISOString();
    const payload = {
      holder: this.userName,
      acquiredAt: iso(now),
      heartbeat: iso(now),
      expires: iso(now + LOCK_TTL_MS)
    };
    const result = await ghWriteLock(
      cfg, payload, existingSha, `${LOCK_COMMIT_PREFIX} ${this.userName} acquired`
    );
    this.heldLock = { sha: result.sha, acquiredAt: payload.acquiredAt, expires: payload.expires };
    this.presenceLock = null; // it's ours now, not a foreign presence
    this._startHeartbeat();
  },

  /**
   * heartbeatLock — Phase 12 (LOCK-01, D-07, Pitfall 3). Refreshes our lock's
   * heartbeat/expires on the single-owner interval. Guards on heldLock (a stray
   * tick after release is a no-op). Threads the NEW sha forward (Pitfall 3 — a
   * stale sha next tick would self-409). A 409 means someone TOOK OVER while we
   * held it → route to _onLockEvicted and STOP; NEVER re-acquire (the SAVE-02 hard
   * rule, D-07 — auto-retry is the #1 silent-clobber trap). Other errors propagate.
   */
  async heartbeatLock() {
    if (!this.heldLock) return;
    const cfg = this.githubCfg; // fresh per call
    const now = await this.getServerNow();
    const iso = (ms) => new Date(ms).toISOString();
    const payload = {
      holder: this.userName,
      acquiredAt: this.heldLock.acquiredAt, // keep the original acquire stamp
      heartbeat: iso(now),
      expires: iso(now + LOCK_TTL_MS)
    };
    try {
      const r = await ghWriteLock(
        cfg, payload, this.heldLock.sha, `${LOCK_COMMIT_PREFIX} ${this.userName} heartbeat`
      );
      this.heldLock.sha = r.sha;          // thread the fresh sha (Pitfall 3)
      this.heldLock.expires = payload.expires;
    } catch (e) {
      if (e instanceof GhConflictError || e.status === 409) {
        this._onLockEvicted();            // someone took over — DO NOT re-acquire
      } else {
        throw e;
      }
    }
  },

  /**
   * _onLockEvicted — Phase 12 (LOCK-01, D-07). The heartbeat-409 landing: stop the
   * heartbeat, drop heldLock, and surface the takeover through the EXISTING Phase
   * 11 pushConflictOffer banner with the new `lockTakeover` kind — so the proven
   * refreshKeepEdit() recovery (pull fresh + clear the banner) handles it (wired
   * into the button x-show in Plan 03). The user's unsaved in-memory edit is left
   * UNTOUCHED (SAVE-02). Never re-acquires.
   */
  _onLockEvicted() {
    this._stopHeartbeat();
    this.heldLock = null;
    this.pushConflictOffer = {
      reason: 'Someone took over editing — your unsaved edit is safe. Refresh before saving.',
      kind: 'lockTakeover'
    };
  },

  /**
   * releaseLock — Phase 12 (LOCK-01, D-05). The clean common-path release: DELETE
   * our lock file and stop the heartbeat. A 409/404 here means it was already
   * taken over / gone (TTL or a takeover beat us) — SWALLOW it; the takeover path
   * already handled the state. heldLock + the timer are ALWAYS cleared in finally
   * so we never leave a zombie interval.
   */
  async releaseLock() {
    if (!this.heldLock) { this._stopHeartbeat(); return; }
    const cfg = this.githubCfg; // fresh per call
    const sha = this.heldLock.sha;
    try {
      await ghDeleteLock(cfg, sha, `${LOCK_COMMIT_PREFIX} ${this.userName} released`);
    } catch (e) {
      /* 409/404: already taken/gone — TTL or takeover handled it. Swallow. */
    } finally {
      this.heldLock = null;
      this._stopHeartbeat();
    }
  },

  // --- LOCK-04 takeover (stale = one click; live = UI-gated) ---

  /**
   * forceReleaseLock — Phase 12 (LOCK-04). The STALE-lock takeover in ONE call:
   * overwrite the foreign (past-TTL) lock with OUR lock using its known sha
   * (UPDATE), then adopt heldLock + start the heartbeat. Intended for the calm
   * one-click on a lock the banner already judged abandoned. A 409 here means
   * someone else raced the same takeover — it PROPAGATES to the caller (no loop);
   * the Contents PUT-with-sha 409 keeps acquisition race-safe (T-12-08).
   */
  async forceReleaseLock() {
    const cfg = this.githubCfg; // fresh per call
    const foreignSha = this.presenceLock && this.presenceLock.sha;
    const now = await this.getServerNow();
    const iso = (ms) => new Date(ms).toISOString();
    const payload = {
      holder: this.userName,
      acquiredAt: iso(now),
      heartbeat: iso(now),
      expires: iso(now + LOCK_TTL_MS)
    };
    const result = await ghWriteLock(
      cfg, payload, foreignSha, `${LOCK_COMMIT_PREFIX} ${this.userName} took over`
    );
    this.heldLock = { sha: result.sha, acquiredAt: payload.acquiredAt, expires: payload.expires };
    this.presenceLock = null;
    this._startHeartbeat();
  },

  /**
   * takeOverLock — Phase 12 (LOCK-04, D-10). The LIVE-lock takeover. The WRITE
   * mechanism is identical to forceReleaseLock (overwrite the foreign sha with our
   * lock); the FRICTION (the confirm dialog) is the UI's responsibility in Plan 03
   * — this method does the write only, so the state machine stays UI-agnostic. A
   * raced 409 PROPAGATES to the caller (T-12-08).
   */
  async takeOverLock() {
    return this.forceReleaseLock();
  },

  /**
   * confirmTakeOverLock — Phase 12 (LOCK-04, D-10). The UI gate for the LIVE-lock
   * takeover: closes the confirm dialog, then performs the takeover write. A raced
   * 409 (someone else took over first) propagates from takeOverLock → refresh
   * presence so the banner reflects the winner; NEVER loop (SAVE-02). The STALE path
   * (forceReleaseLock) is one-click and does NOT route through here (D-10).
   */
  async confirmTakeOverLock() {
    this.lockTakeoverConfirmOpen = false;
    try {
      await this.takeOverLock();
    } catch (e) {
      try { await this.refreshPresence(); } catch (_e2) { /* best-effort */ }
    }
  },

  /**
   * refreshKeepEdit — Phase 11 Plan 03 (SAVE-02, D-01/D-03). The EDIT-PRESERVING
   * Refresh, the pushConflictOffer banner's recovery affordance for a stale-SHA
   * 409 (and the partial-save case). It pulls fresh remote bytes + sha into the
   * cache via pullFromRemote() so the next Save pushes against the FRESH sha —
   * but it DELIBERATELY does NOT call loadFromStore(), because loadFromStore
   * re-derives the whole session state (that is the toolbar Refresh's job,
   * refreshFromRemote above) which would CLOBBER the open editor's in-memory edit.
   * SAVE-02 requires the user's edit to survive: pullFromRemote only writes the
   * cache (bytes + meta.sha), leaving this.form / editing*Id untouched on screen.
   * The write is NEVER auto-retried — the user re-presses Save themselves
   * (T-11-10 / T-11-12). Guarded against double-click by pullFromRemote's own
   * `pulling` flag. After it resolves the cache holds the fresh sha; the banner
   * is dismissed so the user can re-Save.
   */
  async refreshKeepEdit() {
    if (this.pulling) return; // double-click / in-flight guard (mirrors refreshFromRemote)
    await this.pullFromRemote();
    this.pushConflictOffer = null;
  },

  /**
   * buildCommitMessage — Phase 11 (CHANGES-01, D-08/D-09). A PURE helper that
   * assembles the structured commit message every push carries. Format is
   * `Name: action object (title)` (D-08), e.g.
   *   "David: edit recipe 72 (Beef Wellington)"
   *   "David: add recipe 'Dahl'"
   * When `groupTag` is supplied (one of ingredients/recipe/links — D-09) it is
   * appended as ` — ${groupTag}` so the 3 commits of a multi-file Approve read
   * as one coherent group AND a partial push (D-04) is legible after the fact:
   *   "David: add recipe 'Dahl' — ingredients"
   *
   * Reads `this.userName` (the self-declared name, D-05/D-06) — NO other I/O.
   * It does NOT itself enforce the D-07 block (that guard lives in pushToRemote
   * so a missing name never reaches a PUT); a blank name here simply yields a
   * "": "-prefixed message, which pushToRemote will have already refused.
   * It is a plain template — no shell, no URL interpolation; embedded
   * quotes/newlines in `title` stay inside the commit-message JSON body field
   * (githubStore JSON.stringify-encodes the body), so they cannot break out
   * into other API params (T-11-02).
   *
   * @param {object} args
   * @param {string} args.action — e.g. 'edit', 'add', 'delete'
   * @param {string} args.objectKind — e.g. 'recipe', 'ingredient'
   * @param {string} args.title — the human identifier (id + name, or a quoted name)
   * @param {string} [args.groupTag] — ingredients | recipe | links (D-09)
   * @returns {string}
   */
  buildCommitMessage({ action, objectKind, title, groupTag } = {}) {
    let msg = `${this.userName}: ${action} ${objectKind} ${title}`;
    if (groupTag) msg += ` — ${groupTag}`;
    return msg;
  },

  /**
   * pushToRemote — Phase 11 (SAVE-01, D-10/D-11). The GET→PUT MIRROR of
   * pullFromRemote: a thin SINGLE-FILE push the three _rewrite*InPlace funnels
   * will compose in Plan 02. It serializes the cache record BYTE-FAITHFULLY,
   * reads fresh cfg, and PUTs against the cache meta.sha, returning the new sha.
   *
   * Deliberately thin:
   * - D-07 pre-push guard: refuse (throw isPushNameMissing) if no name is set —
   *   every landed commit MUST carry an attribution (T-11-03). No PUT happens.
   * - Reads fresh `this.githubCfg` per call (never cached — rotated token, no
   *   reload), exactly like pullFromRemote.
   * - Serializes via the SAME serializeCsv call putFile/pullFromRemote use, so
   *   the pushed bytes === the bytes the local cache verified (v2 byte-faithful
   *   contract: column order / BOM / newline preserved).
   * - PUTs against record.meta.sha (sha present = UPDATE; the file exists in the
   *   cache so a sha is always present on a synced record).
   * - Returns { newSha }. Does NOT write the sha back to the cache here — the
   *   funnel owns the meta-write transaction (Plan 02), so this stays composable.
   * - Does NOT catch a 409 and retry: GhConflictError PROPAGATES to the funnel
   *   caller (SAVE-02 hard rule — auto-retry is the #1 silent-clobber trap).
   * - Sets NO banner state and NEVER touches parseError — error routing/UX is
   *   the funnel's job (Plan 03 banner). It only OWNS the D-07 name guard.
   *
   * Multi-file ordering (SAVE-03), cache-revert (D-02) and partial-save (D-04)
   * are the funnel's responsibility in Plan 02 — keep this a single PUT.
   *
   * @param {string} filename — STORE_FILES name (e.g. 'recipes.csv')
   * @param {object} record — { columns, rows, hasBOM, newline, meta } cache record
   * @param {string} message — the buildCommitMessage() output
   * @returns {Promise<{newSha: string}>}
   */
  async pushToRemote(filename, record, message) {
    // (1) D-07 pre-push guard — refuse to PUT until a name is set. Tagged so the
    // funnel can branch on it for the "set your name in Settings" copy.
    if (!(this.userName ?? '').trim()) {
      const e = new Error('Set your name in Settings to save to the shared database.');
      e.isPushNameMissing = true;
      throw e;
    }
    // (2) Read fresh cfg per call (never cache it) — mirrors pullFromRemote.
    const cfg = this.githubCfg;
    // (3) Serialize byte-faithfully — identical to putFile/pullFromRemote so the
    // pushed bytes equal the verified local bytes.
    const text = serializeCsv(
      { columns: record.columns, rows: record.rows },
      { hasBOM: record.hasBOM, newline: record.newline },
      Papa
    );
    // (4) Read the current sha from the cache meta (the write token).
    const sha = record.meta && record.meta.sha;
    // (5) PUT against that sha (sha present = UPDATE). A stale sha throws
    // GhConflictError (409) — let it propagate; do NOT catch-and-retry.
    const { sha: newSha } = await ghPutFile(cfg, filename, text, sha, message);
    // (6) Return the new sha; the funnel writes it back to cache meta (Plan 02).
    return { newSha };
  },

  /**
   * seedSharedDatabase — Phase 13 (MIGRATE-01, D-03/D-04/D-08). The founder's
   * one-time "initialize the empty shared repo from my local cache" action,
   * DISTINCT from the per-recipe pushToRemote write path (which it does NOT
   * touch). It composes existing primitives only — no new transport.
   *
   * Happy path (this plan): the repo is confirmed empty (remoteEmpty true via
   * the saveConnection probe), so all 3 CSVs are CREATEd (PUT with sha ABSENT).
   * Plan 13-02 extends this same orchestrator with the non-empty clobber-guard
   * branch (404-probe → PULL default, type-the-repo-name overwrite modal,
   * partial-repo re-seed, raced-422). The per-file write goes through the inner
   * writeSeedFile(name, sha) helper precisely so 13-02 can pass a real sha for
   * the overwrite-existing (D-06) path — keep that seam intact.
   *
   * Guards (no network on a refusal):
   * - D-07 name guard (mirrors pushToRemote): refuse when userName is blank —
   *   every seed commit must carry an attribution.
   * - D-04 migration block: refuse when schemaMigrationNeeded, pointing the
   *   founder at the existing Migrate button — the shared repo can only ever be
   *   initialized in the migrated additive-columns schema (T-13-02).
   *
   * All failures route through githubFriendlyError into seedStatus (T-13-01 —
   * never leaks the token). On success a D-08 post-seed pullFromRemote
   * repopulates the cache meta SHAs and lands in the normal connected state.
   */
  async seedSharedDatabase() {
    // (1) Connection / name guard. No connection or token = nothing to seed.
    if (!this.githubConnected || !this.githubToken) return;
    if (!(this.userName ?? '').trim()) {
      this.seedStatus = 'Set your name in Settings to seed the shared database.';
      return;
    }
    // (2) D-04 migration block — refuse WITHOUT any network call when the local
    // cache is un-migrated. Read the existing flag; do NOT re-derive predicates.
    if (this.schemaMigrationNeeded) {
      this.seedStatus = 'Migrate your local data to the current schema before seeding the shared database.';
      return;
    }
    // (3) Busy + own-error-channel discipline (mirrors pullFromRemote).
    this.seedBusy = true;
    this.seedStatus = '';
    try {
      // (4) Read fresh cfg per call (rotated token, no reload) — like pullFromRemote.
      const cfg = this.githubCfg;
      // Per-file groupTag so the 3 seed commits read as a legible group. Must NOT
      // collide with the Phase 12 lock-commit prefix (those are .mise-lock.json).
      const groupTagByName = {
        'recipes.csv': 'recipe',
        'ingredients.csv': 'ingredients',
        'recipe_ingredients.csv': 'links',
        // Phase 16 (D41) — the optional 4th file gets a legible group tag too, so
        // a seed that includes it does not emit `groupTag: undefined`.
        'residents_allergens.csv': 'residents'
      };
      // (5) Inner per-file write helper — THE seam for Plan 13-02. sha undefined
      // here = CREATE; 13-02 passes a real sha for the overwrite (D-06) path.
      // Serializes byte-faithfully via the SAME serializeCsv call pushToRemote/
      // putFile use (T-13-03 — the seeded bytes equal the locally-verified bytes).
      const writeSeedFile = async (name, sha) => {
        const record = await getFile(name);
        const text = serializeCsv(
          { columns: record.columns, rows: record.rows },
          { hasBOM: record.hasBOM, newline: record.newline },
          Papa
        );
        const message = this.buildCommitMessage({
          action: 'initialize',
          objectKind: 'shared database',
          title: '',
          groupTag: groupTagByName[name]
        });
        // sha falsy/undefined = CREATE (ghPutFile). A CREATE-over-existing throws
        // GhCreateError (422) — Plan 13-02 owns that catch + the overwrite branch.
        // Normalize a falsy sha to undefined so the CREATE path is explicit at the
        // transport boundary (sha ABSENT = CREATE); 13-02 passes a real sha here.
        await ghPutFile(cfg, name, text, sha || undefined, message);
      };
      // (5b) EXISTENCE PROBE (Plan 13-02, D-05/D-06). Before ANY write, 404-probe
      // all 3 STORE_FILES. ghGetFile throws GhAccessError (.status===404) when the
      // file is absent — caught here as "absent"; ANY OTHER error (auth/403/network)
      // propagates to the catch below (do NOT misclassify a 401 as "empty"). Record
      // per-file existence + the returned sha (the overwrite UPDATEs reuse the sha).
      const present = [];
      for (const name of STORE_FILES) {
        try {
          const { sha } = await ghGetFile(cfg, name);
          present.push({ name, sha });
        } catch (e) {
          if (e && e.status === 404) continue; // absent — fine, this is a seed candidate
          throw e; // auth/access/network — surface, never treat as empty
        }
      }
      // (5c) BRANCH (D-05). ANY file present = NON-EMPTY → DEFAULT to JOIN: do NOT
      // write. Run the remote-wins pull (join the existing DB) and explain. The
      // destructive overwrite is NOT taken automatically — it is reachable ONLY via
      // the explicit type-the-repo-name modal (confirmOverwriteSharedDatabase). This
      // makes "run seed twice" trip the guard the second time (SC#2).
      if (present.length > 0) {
        await this.pullFromRemote();
        this.remoteEmpty = false;
        // WR-01 — if the join-pull itself failed, remoteStatus already carries the
        // friendly error and the app is read-only; don't paper over it with a
        // "joined it" success line.
        if (!this.remoteOk) return;
        // Phase 16: "fully initialized" is a REQUIRED-set property. Count present
        // REQUIRED recipe CSVs (the optional 4th file never affects this copy nor
        // the "X of 3" partial wording).
        const requiredPresent = present.filter(p => REQUIRED_STORE_FILES.includes(p.name)).length;
        this.seedStatus = requiredPresent === REQUIRED_STORE_FILES.length
          ? 'This repo already has a shared database — joined it instead of seeding. Use "Overwrite…" only to replace it.'
          : `This repo is partially initialized (${requiredPresent} of ${REQUIRED_STORE_FILES.length} files) — joined it instead of seeding. Use "Overwrite…" only to replace it.`;
        return;
      }
      // (5d) ALL-404 → EMPTY: the Plan 13-01 CREATE happy path. CREATE the recipe
      // CSVs in canonical order (sha ABSENT = CREATE). A file that appeared between
      // the probe and the PUT (a raced CREATE) returns 422 (GhCreateError); the
      // catch below hard-stops with the D-07 race copy — never a silent overwrite.
      // Phase 16: SKIP the optional 4th file when the local cache has no record for
      // it (getFile null) — the founder may seed the recipe DB before any resident
      // record exists; never CREATE an empty/garbage residents_allergens.csv.
      for (const name of STORE_FILES) {
        if (!REQUIRED_STORE_FILES.includes(name) && !(await getFile(name))) continue;
        await writeSeedFile(name, undefined);
      }
      // (6) D-08 post-seed confirm — repopulate cache meta:{sha,fetchedAt} from the
      // freshly-created files and flip remoteOk true via the normal read path.
      await this.pullFromRemote();
      // The repo is no longer empty; the seed affordance retires, app sits in the
      // normal connected read/write state (no separate post-seed mode, D-08).
      this.remoteEmpty = false;
      // WR-01 — the seed WRITE succeeded, but pullFromRemote swallows its own
      // errors into remoteStatus. Only claim success when the confirm-pull also
      // landed (remoteOk); otherwise be honest that the app is read-only.
      this.seedStatus = this.remoteOk
        ? 'Shared database initialized.'
        : `Shared database initialized, but the confirmation pull failed — the app is read-only until you reconnect. ${this.remoteStatus}`.trim();
    } catch (e) {
      // Friendly translate — NEVER the token (T-13-01). A raced CREATE (422 /
      // GhCreateError) maps to the D-07 race copy in githubFriendlyError and
      // HARD-STOPS the seed (no auto-retry-as-overwrite).
      this.seedStatus = this.githubFriendlyError(e);
      this._maybeRateLimitBanner(e); // ACCESS-04
      return;
    } finally {
      this.seedBusy = false;
    }
  },

  /**
   * fetchOverwritePreview — Phase 13 Plan 02 (MIGRATE-02, D-01/D-06). The LAZY
   * row-count content fetch that powers the overwrite-confirm modal: for each CSV
   * that already exists, fetch its bytes via ghGetFile, parse with the PURE
   * parseCsv helper, and record { name, rowCount, sha } so the founder SEES exactly
   * what will be destroyed (CSV names + remote row counts). Per the CONTEXT
   * discretion this content fetch runs ONLY when the founder heads toward overwrite
   * (the "Overwrite…" entry point), NOT on every cheap 404-probe. The probe SHAs
   * are kept on overwritePreview so confirmOverwriteSharedDatabase reuses them for
   * the sha-present UPDATEs (D-06). overwritePartial is true when 1-2 of 3 present.
   * Reads only CSV row counts — never the token (T-13-08); errors route through
   * githubFriendlyError into seedStatus.
   */
  async fetchOverwritePreview() {
    if (!this.githubConnected || !this.githubToken) return false;
    // WR-02 — clear any stale preview BEFORE fetching, so a failed retry can never
    // leave the founder reviewing (and overwriting against) SHAs from a prior call.
    this.overwritePreview = [];
    this.overwritePartial = false;
    this.seedBusy = true;
    this.seedStatus = '';
    try {
      const cfg = this.githubCfg; // read-fresh-per-call (rotated token, no reload)
      const preview = [];
      for (const name of STORE_FILES) {
        try {
          const { text, sha } = await ghGetFile(cfg, name);
          const record = parseCsv(text, Papa);
          preview.push({ name, rowCount: record.rows.length, sha });
        } catch (e) {
          if (e && e.status === 404) continue; // absent — will be CREATEd on overwrite
          throw e; // auth/access/network — surface, do not present a partial preview
        }
      }
      this.overwritePreview = preview;
      // Phase 16: "partial" is a REQUIRED-set property (the UI copy reads "of 3
      // files"). Count how many of the 3 REQUIRED recipe CSVs are present; the
      // optional 4th file (residents_allergens.csv) being present-or-absent never
      // makes a repo "partial". A repo with all 3 recipe CSVs reads NOT-partial
      // whether or not it also has residents_allergens.csv.
      const requiredPresent = preview.filter(p => REQUIRED_STORE_FILES.includes(p.name)).length;
      this.overwritePartial = requiredPresent > 0 && requiredPresent < REQUIRED_STORE_FILES.length;
      // CR-02 — signal success so the caller opens the modal ONLY when the founder
      // has a real "what will be destroyed" list (the D-01 human firewall).
      return true;
    } catch (e) {
      this.seedStatus = this.githubFriendlyError(e); // NEVER the token (T-13-08)
      this._maybeRateLimitBanner(e); // ACCESS-04
      return false; // CR-02 — caller must NOT open the modal on a failed preview
    } finally {
      this.seedBusy = false;
    }
  },

  /**
   * confirmOverwriteSharedDatabase — Phase 13 Plan 02 (MIGRATE-02, D-06). The ONLY
   * destructive write in the milestone: re-seed ALL 3 CSVs over a shared DB that
   * 2-4 people built. There is NO 409 backstop and git history is the only undo —
   * hence it runs ONLY behind the type-the-repo-name gate (overwriteConfirmed). For
   * each STORE_FILES name it passes the probe's sha when the file exists (UPDATE)
   * and undefined when missing (CREATE the missing file) — so a PARTIAL repo
   * re-seeds correctly (D-06, T-13-09: no spurious 422 on a legitimately-missing
   * file). A raced 422 (GhCreateError on a file that appeared after the preview)
   * HARD-STOPS via githubFriendlyError's D-07 arm — never an auto-retry. On success
   * a D-08 pullFromRemote confirms the new SHAs, the modal clears, and the app lands
   * in the normal connected state.
   */
  async confirmOverwriteSharedDatabase() {
    // Defense in depth — the button is :disabled, but never write without the gate.
    if (!this.githubConnected || !this.githubToken) return;
    if (!this.overwriteConfirmed) return;
    if (!(this.userName ?? '').trim()) {
      this.seedStatus = 'Set your name in Settings to seed the shared database.';
      return;
    }
    // D-04 migration block (CR-01) — the overwrite path is the ONLY destructive
    // write in the milestone, so it MUST honour the same migration invariant as
    // seedSharedDatabase: refuse WITHOUT any network call when the local cache is
    // un-migrated, or a founder could clobber the shared DB with old-schema CSVs.
    if (this.schemaMigrationNeeded) {
      this.seedStatus = 'Migrate your local data to the current schema before overwriting the shared database.';
      return;
    }
    this.seedBusy = true;
    this.seedStatus = '';
    try {
      const cfg = this.githubCfg; // read-fresh-per-call (rotated token, no reload)
      const groupTagByName = {
        'recipes.csv': 'recipe',
        'ingredients.csv': 'ingredients',
        'recipe_ingredients.csv': 'links',
        // Phase 16 (D41) — optional 4th file's legible group tag (see seed path).
        'residents_allergens.csv': 'residents'
      };
      // sha by name from the lazily-fetched preview (existing files = UPDATE).
      const shaByName = {};
      for (const p of this.overwritePreview) shaByName[p.name] = p.sha;
      // Re-seed: sha-present UPDATE for existing, sha-absent CREATE for missing.
      // Phase 16: SKIP the optional 4th file when the local cache has no record for
      // it (getFile null) — same discipline as the seed CREATE loop; never push an
      // empty/garbage residents_allergens.csv. A present local 4th file IS written.
      for (const name of STORE_FILES) {
        const record = await getFile(name);
        if (!REQUIRED_STORE_FILES.includes(name) && !record) continue;
        const text = serializeCsv(
          { columns: record.columns, rows: record.rows },
          { hasBOM: record.hasBOM, newline: record.newline },
          Papa
        );
        const message = this.buildCommitMessage({
          action: 'initialize',
          objectKind: 'shared database',
          title: '',
          groupTag: groupTagByName[name]
        });
        // shaByName[name] present = UPDATE (overwrite existing); undefined = CREATE
        // the legitimately-missing file (D-06). A raced 422 on a CREATE hard-stops.
        await ghPutFile(cfg, name, text, shaByName[name], message);
      }
      // D-08 post-overwrite confirm — repopulate cache meta:{sha,fetchedAt}.
      await this.pullFromRemote();
      this.remoteEmpty = false;
      this.overwriteConfirmOpen = false;
      this.overwriteConfirmText = '';
      this.overwritePreview = [];
      this.overwritePartial = false;
      // WR-01 — the overwrite WRITE succeeded; only claim full success when the
      // confirm-pull also landed (remoteOk), else be honest about the read-only state.
      this.seedStatus = this.remoteOk
        ? 'Shared database overwritten with your local copy.'
        : `Shared database overwritten, but the confirmation pull failed — the app is read-only until you reconnect. ${this.remoteStatus}`.trim();
    } catch (e) {
      // A raced CREATE (422 / GhCreateError) → D-07 race copy; HARD-STOP, no retry.
      this.seedStatus = this.githubFriendlyError(e); // NEVER the token (T-13-08)
      this._maybeRateLimitBanner(e); // ACCESS-04
      return;
    } finally {
      this.seedBusy = false;
    }
  },

  /**
   * loadRosterFromCache — Phase 07 (ROSTER-02). THE roster cache read path,
   * modelled on loadFromStore() but reading the codaRoster cache via residents.js
   * getRosterTable. DATA-ISOLATED: it touches ONLY the roster slice
   * (rosterLoaded / rosterError / rosterTables / joinedRoster) and NEVER
   * csvStoreLoaded / csvHeaders / ingredientMaster / deriveSessionStateFromCsvs
   * (PATTERNS §D — data isolation LOCKED).
   *
   * Empty cache = valid first-run state, NOT an error: if either table is absent
   * leave rosterLoaded=false and return. If both are present, store the rows and
   * compute joinedRoster via joinRoster. A thrown read failure sets rosterError
   * (the roster's OWN error channel, never parseError) so a roster failure never
   * blocks the recipe slice and vice-versa.
   */
  async loadRosterFromCache() {
    const residency = await getRosterTable('residency');
    const onboarding = await getRosterTable('onboarding');
    // Empty cache (either table missing) is a valid first-run state, not an error.
    if (!residency || !onboarding) {
      this.rosterLoaded = false;
      this.rosterFetchedAt = null; // quick 260620-p1f — cache-absent path
      return;
    }
    const residencyRows = residency.rows || [];
    const onboardingRows = onboarding.rows || [];
    this.rosterTables = { residency: residencyRows, onboarding: onboardingRows };
    this.joinedRoster = joinRoster(residencyRows, onboardingRows);
    this.rosterLoaded = true;
    // quick 260620-p1f — stamp the cache's last-fetch time for the once-per-day
    // staleness check (residency record always carries fetchedAt, per residents.js).
    this.rosterFetchedAt = residency.fetchedAt || null;
  },

  /**
   * _readInRosterSnapshot — Phase 17 (Plan 17-03, D-08). The TOKENLESS read-in: write
   * a pulled residents_roster.json snapshot's two tables into the codaRoster cache via
   * putRosterTable (reused verbatim from residents.js), then loadRosterFromCache so the
   * existing roster UI recomputes — all with NO Coda token. This is what lets a fresh
   * device holding only the shared PAT (no Coda credential) see the full roster (SPEC #4).
   *
   * Defensive (mirrors loadRosterFromCache's "empty cache is valid" discipline + the
   * T-17-09 tampering mitigation): a malformed/absent snapshot — missing residency or
   * onboarding, or either lacking a rows array — is a NO-OP. It does NOT throw and does
   * NOT clobber the existing cache; the prior roster (if any) stays intact. The whole
   * method is on the roster's OWN error channel (rosterError) — a read-in failure NEVER
   * blocks boot or the recipe slice (T-17-10 parity).
   * @param {object} snapshot — a pulled {residency:{rows,fetchedAt}, onboarding:{rows,fetchedAt}}
   */
  async _readInRosterSnapshot(snapshot) {
    // Guard malformed/absent as a no-op (do not throw, leave the existing cache).
    const res = snapshot && snapshot.residency;
    const onb = snapshot && snapshot.onboarding;
    if (!res || !Array.isArray(res.rows) || !onb || !Array.isArray(onb.rows)) return;
    try {
      await putRosterTable('residency', { rows: res.rows, fetchedAt: res.fetchedAt });
      await putRosterTable('onboarding', { rows: onb.rows, fetchedAt: onb.fetchedAt });
      // Existing roster UI recomputes from the cache — no Coda token needed (D-08).
      await this.loadRosterFromCache();
    } catch (e) {
      // Roster's OWN error channel — a read-in failure never blocks boot / recipes.
      this.rosterError = "Couldn't load the shared roster snapshot.";
    }
  },

  /**
   * loadResidentAllergens — Phase 16 (D40/D41). THE non-fatal read of the curated
   * 4th file residents_allergens.csv into the session slice. Modelled on
   * loadRosterFromCache's own-error-channel discipline: a missing/absent 4th file
   * is a VALID state (first run, or an old shared repo that predates the 4th file —
   * 16-RESEARCH Pitfall 3), NOT an error, and must NEVER block the recipe load. A
   * thrown read failure sets residentAllergenError (this slice's OWN channel, never
   * parseError/rosterError). Captures the live header (column order/conventions) so
   * a later save round-trips byte-faithfully.
   */
  async loadResidentAllergens() {
    const rec = await getFile('residents_allergens.csv');
    if (!rec || !Array.isArray(rec.rows)) {
      // Absent = valid first-run / pre-4th-file repo state, not an error.
      this.residentAllergenRows = [];
      this.residentAllergenColumns = null;
      return;
    }
    this.residentAllergenRows = rec.rows;
    this.residentAllergenColumns = (Array.isArray(rec.columns) && rec.columns.length) ? rec.columns : null;
  },

  /**
   * _residentAllergenByAppid — Phase 16 (D40). READ-ONLY render getter built ONCE
   * per read (NOT inside the dayAllergenStatus per-resident loop). Keyed by
   * String(appid).trim() (the SAME coercion the join uses) → { reviewed:boolean,
   * fsa14:string[] }. `reviewed` decodes TRUE/blank (the null-vs-empty marker, like
   * pantry_staple); `fsa14` parses the semicolon-joined cell and re-imposes
   * canonical FSA-14 order. Absent APPIDs are simply not in the Map (→ the
   * classifier's keyword-fallback branch).
   */
  get _residentAllergenByAppid() {
    const map = new Map();
    const rows = Array.isArray(this.residentAllergenRows) ? this.residentAllergenRows : [];
    for (const r of rows) {
      const appid = String(r && r.appid != null ? r.appid : '').trim();
      if (appid === '') continue;
      const reviewed = (r.reviewed ?? '').toString().trim().toUpperCase() === 'TRUE';
      const fsa14 = this.FSA14.filter(a => (r.fsa14_allergens ?? '').split(';').map(s => s.trim()).includes(a));
      map.set(appid, { reviewed, fsa14 });
    }
    return map;
  },

  /**
   * residentAllergenSummary — Phase 16 follow-up. READ-ONLY at-a-glance status for
   * a resident present-list ROW, derived from the resident's OWN curated record
   * (NOT day context). Discriminated { state, tags, label }:
   *   'tags'         — reviewed WITH curated FSA-14 allergens (the markup lists them).
   *   'none'         — reviewed, NO allergens (confirmed safe).
   *   'needs-review' — NOT reviewed (seeded-not-reviewed OR no record at all) — this
   *                    NEVER reads as safe (D42); a machine-seeded guess is not a clear.
   * The present-list stays RAW-TEXT-FREE (T-07-07): only curated FSA-14 tags + the
   * status label surface here; raw allergy text is modal-only. `tags` is ALWAYS an
   * array so the row markup never dereferences null (console-baseline guard).
   */
  residentAllergenSummary(appid) {
    const key = String(Array.isArray(appid) ? (appid[0] ?? '') : (appid ?? '')).trim();
    const rec = key ? this._residentAllergenByAppid.get(key) : null;
    if (!rec || !rec.reviewed) return { state: 'needs-review', tags: [], label: 'Needs review' };
    if (Array.isArray(rec.fsa14) && rec.fsa14.length > 0) return { state: 'tags', tags: rec.fsa14, label: '' };
    return { state: 'none', tags: [], label: 'No allergens' };
  },

  /**
   * _seedResidentAllergensFromRoster — Phase 16 (D40). The I/O HALF of the seed the
   * PURE seedResidentAllergens helper does not do: read the current 4th-file rows,
   * call the helper with an injected suggestFn (wraps the app-local findKeywordHits),
   * and if it returns NEW rows, write the WHOLE rewritten file through the protected
   * putFile path (NO headerCheckFn — the 4th file is NOT v2-schema-gated) and, when
   * connected AND not read-only, push it ONCE (decision 2: read-only → stays local
   * until reconnect). insert-if-absent → never re-clobbers (the helper guarantees it).
   * Best-effort + own error channel: a seed failure must never break a roster fetch.
   */
  async _seedResidentAllergensFromRoster() {
    try {
      const existing = await getFile('residents_allergens.csv'); // null on first run
      const existingRows = (existing && Array.isArray(existing.rows)) ? existing.rows : [];
      const suggestFn = (raw) => [...findKeywordHits(raw, this.currentAllergenKeywords).keys()];
      const newRows = seedResidentAllergens(this.joinedRoster || [], existingRows, suggestFn);
      if (newRows.length === 0) return; // nothing new — never re-clobber, never a no-op write

      const columns = (existing && Array.isArray(existing.columns) && existing.columns.length)
        ? existing.columns
        : RESIDENT_ALLERGEN_COLUMNS;
      const hasBOM = existing ? existing.hasBOM ?? false : false;
      const newline = existing ? (existing.newline ?? '\r\n') : '\r\n';
      const allRows = [...existingRows, ...newRows];
      // last-known-remote sha from the PRE-putFile read (the push helper re-reads
      // nothing — a post-write getFile would yield meta:undefined → 422).
      const sha = existing && existing.meta ? existing.meta.sha : undefined;

      // Protected write (snapshot→verify→auto-revert). NO headerCheckFn — the v2
      // migration gates are recipe-specific and would wrongly reject this file.
      try {
        await putFile('residents_allergens.csv', { columns, rows: allRows, hasBOM, newline }, { Papa });
      } catch (e) {
        if (e && e.isRestoreOfferSentinel) {
          this.mergeRestoreOffer = { reason: e.message, filesWritten: ['residents_allergens.csv'] };
        }
        throw e;
      }
      // Refresh the session slice so the panel/edit modal + dayAllergenStatus see it.
      await this.loadResidentAllergens();

      // Decision 2 (CONFIRMED): push the seeded file ONCE if connected AND not
      // read-only; read-only → stays local until reconnect. Non-PII commit title
      // (decision 3): "resident allergens", never a resident name.
      if (!this.readOnlyMode) {
        await this._pushFileAfterCacheWrite({
          filename: 'residents_allergens.csv',
          columns,
          sha,
          newRows: allRows,
          hasBOM,
          newline,
          message: this.buildCommitMessage({ action: 'seed', objectKind: 'resident allergens', title: '', groupTag: 'residents' }),
          preEditRecord: existing || { columns, rows: existingRows, hasBOM, newline }
        });
      }
    } catch (e) {
      // Own error channel — a seed failure must NEVER break the roster fetch or the
      // recipe slice. A push 409/verify mismatch leaves the local cache reverted by
      // the push helper; surface a non-PII status line only.
      if (this._routePushFailure && this._routePushFailure(e)) return; // 409 → existing banner
      this.residentAllergenError = `Couldn't sync resident allergens: ${(e && e.message) || 'unknown error'}.`;
    }
  },

  /**
   * openEditResident — Phase 16 (D39). The single, view-independent opener for the
   * resident edit MODAL (mirrors openEditIngredient). Guard, then delegate — NO view
   * switch (the modal is a top-level overlay driven by editingResidentAppid !== null).
   * startEditResident owns its own not-found path.
   */
  openEditResident(appid) {
    const key = String(appid != null ? appid : '').trim();
    if (key === '') return;
    this.startEditResident(key);
  },

  /**
   * startEditResident — Phase 16 (D39). Snapshot the current 4th-file row (or, if
   * none yet exists for this APPID, a blank seed-shaped record) into residentEditForm.
   * Reads from the session slice (loadResidentAllergens); parses the curated tags via
   * split(';') → FSA14.filter (canonical order). reviewed decodes TRUE/blank.
   */
  startEditResident(appid) {
    const key = String(appid != null ? appid : '').trim();
    this.residentEditError = '';
    const rows = Array.isArray(this.residentAllergenRows) ? this.residentAllergenRows : [];
    const row = rows.find(r => String(r && r.appid != null ? r.appid : '').trim() === key) || null;
    // D41 reverses the no-raw-text caveat FOR THE EDIT MODAL ONLY — surface raw text here.
    this.residentEditForm = {
      appid: key,
      full_name: row ? (row.full_name ?? '') : '',
      allergies_raw: row ? (row.allergies_raw ?? '') : '',
      allergies_detail: row ? (row.allergies_detail ?? '') : '',
      fsa14: this.FSA14.filter(a => (row ? (row.fsa14_allergens ?? '') : '').split(';').map(s => s.trim()).includes(a)),
      reviewed: row ? (row.reviewed ?? '').toString().trim().toUpperCase() === 'TRUE' : false,
      notes: row ? (row.notes ?? '') : '',
      // Pre-existing row present + NOT reviewed = seeded-from-Coda, awaiting curation.
      _seededNotReviewed: !!row && !((row.reviewed ?? '').toString().trim().toUpperCase() === 'TRUE')
    };
    this.editingResidentAppid = key;
    // quick 260627-pfu — baseline the dirty guard after residentEditForm is assigned.
    this.snapshotEditModal('resident');
  },

  /**
   * cancelEditResident — Phase 16. Close the modal without writing; clear the form.
   */
  cancelEditResident() {
    this.editingResidentAppid = null;
    this.residentEditError = '';
    this.residentEditForm = { appid: '', full_name: '', allergies_raw: '', allergies_detail: '', fsa14: [], reviewed: false, notes: '' };
  },

  /**
   * saveEditResident — Phase 16 (D39/D41). Build the WHOLE updated row set for
   * residents_allergens.csv and funnel it through the SAME data-safety write chain as
   * _rewriteIngredientsInPlace: read current → sha = current.meta?.sha (PRE-putFile,
   * never a re-read → 422) → putFile (NO headerCheckFn — not v2-gated) → _pushFileAfterCacheWrite
   * (409 HARD-STOP, no read-only push). The curated tags serialize canonical-ordered;
   * reviewed writes TRUE/blank (the null-vs-empty marker). Non-PII commit title (decision 3).
   */
  async saveEditResident() {
    const key = String(this.editingResidentAppid != null ? this.editingResidentAppid : '').trim();
    if (key === '') return;
    this.residentEditError = '';

    const current = await getFile('residents_allergens.csv'); // may be null on a fresh file
    const existingRows = (current && Array.isArray(current.rows)) ? current.rows : [];
    const columns = (current && Array.isArray(current.columns) && current.columns.length)
      ? current.columns
      : RESIDENT_ALLERGEN_COLUMNS;
    const hasBOM = current ? (current.hasBOM ?? false) : false;
    const newline = current ? (current.newline ?? '\r\n') : '\r\n';
    const sha = current && current.meta ? current.meta.sha : undefined;

    const f = this.residentEditForm;
    const updatedRow = {
      appid: key,
      full_name: f.full_name ?? '',
      allergies_raw: f.allergies_raw ?? '',
      allergies_detail: f.allergies_detail ?? '',
      // canonical FSA-14 order; never an off-vocab tag.
      fsa14_allergens: this.FSA14.filter(a => Array.isArray(f.fsa14) && f.fsa14.includes(a)).join(';'),
      reviewed: f.reviewed ? 'TRUE' : '',   // TRUE/blank null-vs-empty marker
      notes: f.notes ?? ''
    };
    // Replace the matching row in place, else append (the file may not yet hold it).
    let replaced = false;
    const newRows = existingRows.map(r => {
      if (String(r && r.appid != null ? r.appid : '').trim() === key) { replaced = true; return { ...r, ...updatedRow }; }
      return r;
    });
    if (!replaced) newRows.push(updatedRow);

    this.merging = true;
    try {
      try {
        await putFile('residents_allergens.csv', { columns, rows: newRows, hasBOM, newline }, { Papa });
      } catch (e) {
        if (e && e.isRestoreOfferSentinel) {
          // INFORMATIONAL auto-rollback — putFile already reverted the cache.
          this.mergeRestoreOffer = { reason: e.message, filesWritten: ['residents_allergens.csv'] };
        }
        throw e;
      }
      // Refresh the session slice so the panel + dayAllergenStatus see the edit.
      await this.loadResidentAllergens();
      // Push the just-verified bytes (409 HARD-STOP, no read-only push). Non-PII title.
      await this._pushFileAfterCacheWrite({
        filename: 'residents_allergens.csv',
        columns,
        sha,
        newRows,
        hasBOM,
        newline,
        message: this.buildCommitMessage({ action: 'edit', objectKind: 'resident allergens', title: '', groupTag: 'residents' }),
        preEditRecord: current || { columns, rows: existingRows, hasBOM, newline }
      });
      this.cancelEditResident();
    } catch (e) {
      if (e && e.isRestoreOfferSentinel) {
        // The auto-rollback banner is already set; keep the modal open so the edit survives.
      } else if (this._routePushFailure(e)) {
        // 409 / push failure → the single pushConflictOffer banner; edit survives on screen.
        this.residentEditError = 'Someone else changed this — Refresh, then re-save.';
      } else {
        this.residentEditError = (e && e.message) ? e.message : "Couldn't save the resident allergen record.";
      }
    } finally {
      this.merging = false;
    }
  },

  /**
   * maybeAutoFetchRoster — quick 260620-p1f. Boundary-crossing daily auto-fetch.
   * Plan 07 deliberately kept fetchRoster out of boot (credential-gated, user-
   * gesture only); this crosses that boundary SAFELY: config-gated, once-per-LOCAL
   * -day, fire-and-forget, and SILENT when unconfigured (no rosterError). It performs
   * NO writes of its own — fetchRoster remains the sole owner of the roster-cache
   * write and owns its own rosterFetching guard, try/catch, and error channel.
   */
  maybeAutoFetchRoster() {
    // SILENT config gate — unconfigured boot is a no-op (no rosterError, no log).
    if (!this.codaApiToken || !this.codaExportDocId ||
        !this.codaResidencyTableId || !this.codaOnboardingTableId) {
      return;
    }
    const today = this.todayStr; // LOCAL 'YYYY-MM-DD'
    if (this.rosterFetchedAt) {
      // Derive the cache's date the SAME LOCAL way todayStr does (NOT toISOString),
      // so the comparison is timezone-consistent.
      const d = new Date(this.rosterFetchedAt);
      const cached = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (cached === today) {
        return; // already fetched today
      }
    }
    // Stale (or never fetched) + configured: refresh. INTENTIONALLY not awaited and
    // not wrapped — fire-and-forget so it never blocks/affects recipe load;
    // fetchRoster owns its rosterFetching guard, try/catch, and rosterError channel.
    this.fetchRoster();
  },

  /**
   * residentsPresent — Plan 07-03 REACTIVE GETTER (mirrors the getter precedent
   * documented above visiblePlanByDay / currentAllergenKeywords: it re-runs in the
   * render cycle whenever a read source mutates, so changing residentsDate
   * live-updates the panel with NO watcher). Reads this.residentsDate +
   * this.joinedRoster and delegates the EXACT present-on-D rule to the pure
   * residents.js helper. Returns the helper's { present, count } shape (count =
   * ROWS present, fork 4 — never deduped).
   *
   * Dev-only signal: when an overlapping chained-stay pair is present on D, emit a
   * single console.warn (the count STILL counts both rows). This is a developer
   * diagnostic, not a user-facing error.
   *
   * Surfaces Full name + Type + Roles ONLY via the markup (Type is a residency
   * SCALAR string carried through as-is — NO fixed-enum validation; e.g. the live
   * value `Volunteer` is outside the contract enum). Raw allergy free-text and
   * allergies-additional-details are carried in the joined rows but are NEVER
   * rendered by the panel (CONTEXT caveat — stray identifying text; T-07-07).
   * room_display_label is still ABSENT from the export — not referenced here.
   */
  get residentsPresent() {
    const joined = this.joinedRoster || [];
    const D = this.residentsDate;
    const overlap = detectChainedOverlap(joined, D);
    // Dev-only diagnostic; the count still counts every present ROW. Deduped on a
    // MODULE-scoped key (WR-01) so it fires once per distinct (date + overlap)
    // transition, NOT on every reactive getter read (~4× per render).
    const warnKey = overlap ? D : null;
    if (warnKey !== _lastOverlapWarnKey) {
      _lastOverlapWarnKey = warnKey;
      if (overlap) {
        console.warn(`[roster] overlapping chained-stay rows are present on ${D} (count includes both rows; not deduped).`);
      }
    }
    return residentsPresentOnDate(joined, D);
  },

  /**
   * headcountForDate — quick 260620-gi4. READ-ONLY display helper for the per-day
   * meal-plan subtitle. Returns the number of resident ROWS present on dateStr, or
   * null when the roster is not loaded OR dateStr is empty (the Unscheduled group
   * has key === '', which must show buckets but NO headcount). Delegates the
   * present-on-D rule to the same pure residents.js helper as residentsPresent.
   *
   * Deliberately does NOT call detectChainedOverlap: that console.warn diagnostic
   * is confined to the residentsPresent getter. This helper runs once PER
   * DAY-GROUP per render, so reusing the overlap warn here would spam the console.
   * No writes — pure read + return.
   */
  headcountForDate(dateStr) {
    if (!this.rosterLoaded || !dateStr) return null;
    return residentsPresentOnDate(this.joinedRoster || [], dateStr).count;
  },

  /**
   * dayTypeSummary — quick 260620-gi4. READ-ONLY display helper for the per-day
   * meal-plan subtitle. Groups a day's entries into recipe-type buckets in the
   * FIXED order [Main, Side, Salad, Other], preserving entry order within each
   * bucket. Classification is STRICT exact-match on the trimmed/lower-cased type:
   * only 'main'/'side'/'salad' map to their bucket; everything else (incl.
   * 'Dressed Salad', 'Salad Dressing', 'Component', blanks) falls to Other
   * (user decision). Returns ONLY non-empty buckets as { label, names: [] }.
   * No writes, no scaling wiring, no detectChainedOverlap — pure read + return.
   */
  dayTypeSummary(entries) {
    if (!Array.isArray(entries)) return [];
    const buckets = { Main: [], Side: [], Salad: [], Other: [] };
    for (const entry of entries) {
      const t = (entry.type || '').trim().toLowerCase();
      const label = t === 'main' ? 'Main' : t === 'side' ? 'Side' : t === 'salad' ? 'Salad' : 'Other';
      buckets[label].push(entry.name || '(unnamed)');
    }
    return ['Main', 'Side', 'Salad', 'Other']
      .filter((label) => buckets[label].length > 0)
      .map((label) => ({ label, names: buckets[label] }));
  },

  /**
   * daySubtitleSegments — quick 260620-gi4. READ-ONLY. Flattens the day subtitle
   * into ONE ordered list of segments so the markup renders a single x-for and the
   * dot separator can be index-gated (separator shown only when i > 0). This avoids
   * the stray LEADING dot the CSS `* + *` sibling approach produced when the
   * headcount was absent (Unscheduled / roster-not-loaded): a hidden headcount span
   * still counted as a preceding sibling, so the first bucket got a separator with
   * nothing visible before it. Headcount segment is OMITTED entirely when null, so
   * whatever segment ends up first is genuinely first (i === 0, no separator).
   * Segment kinds: { kind:'headcount', text } | { kind:'bucket', label, names }.
   * No writes — pure read + return.
   */
  daySubtitleSegments(group) {
    const segs = [];
    const key = group && group.key;
    // quick 260627-joq — a truly empty day (no entries) renders as JUST the petrol
    // header band (header-only treatment), so it shows NO headcount. The headcount is
    // a populated-day signal; the leftovers segment below stays (it's empty-day-only).
    const hasEntries = !!(group && Array.isArray(group.entries) && group.entries.length > 0);
    const base = this.headcountForDate(key);
    if (base !== null && hasEntries) {
      // quick 260621-lft — fold in any leftover headcount rolling onto THIS day from
      // the next (leftovers) day, and SHOW THE BREAKDOWN (decision 3) so the boost is
      // never silent: "12 present (8 + 4 leftovers)" vs a plain "8 present".
      const bonus = this._leftoverBonusInto(key);
      // quick 260627-r94 (R94-1) — the "present" word is replaced by the person
      // emoji "👤" to tighten the header band. The leftovers breakdown is KEPT.
      // Accessibility: the header span carries a title/aria-label so the emoji-only
      // count is not the sole signal (see index.html .meal-plan-day-headcount).
      const text = bonus > 0
        ? `${base + bonus} 👤 (${base} + ${bonus} leftovers)`
        : `${base} 👤`;
      segs.push({ kind: 'headcount', text });
    }
    // quick 260621-lft — when THIS day is itself a leftovers day, mark it and name
    // where its headcount went (the previous day) so the rollover is legible from
    // both ends. Guarded to genuinely-empty days (matches the toggle's visibility).
    if (key && this.dayLeftovers[key] === true && (group && Array.isArray(group.entries) ? group.entries.length === 0 : false)) {
      const prevLabel = this._dayLabel(this._stepDayKey(key, -1));
      segs.push({ kind: 'leftovers', text: prevLabel ? `Leftovers → ${prevLabel}` : 'Leftovers' });
    }
    // J4 (quick 260625-itm) — the redundant kind:'bucket' type-summary segments
    // ("Main: … · Side: …") are DROPPED: the F7 typegroup labels (in the day body)
    // now carry the per-type structure, so repeating it in the subtitle is noise.
    // The headcount + leftovers segments are KEPT. dayTypeSummary() is left in place
    // (now consumed by nothing — harmless; not deleted to avoid touching unrelated code).
    return segs;
  },

  /**
   * dayHeadlineRecipe — quick 260627-r94 (R94-2). PURE read-only display helper.
   * Returns the day's HEADLINE recipe name for the header row: the FIRST entry whose
   * type is exactly 'main' (same STRICT classification as dayTypeSummary —
   * (type||'').trim().toLowerCase() === 'main'); if no main exists, the FIRST entry of
   * ANY type. Empty / no-entry days return '' so the header shows nothing. Uses the
   * existing `entry.name || '(unnamed)'` fallback. No writes, no new state, no warn.
   */
  dayHeadlineRecipe(group) {
    if (!group || !Array.isArray(group.entries) || group.entries.length === 0) return '';
    const main = group.entries.find((entry) => (entry.type || '').trim().toLowerCase() === 'main');
    const pick = main || group.entries[0];
    return pick.name || '(unnamed)';
  },

  /**
   * dayAllergenIcon — quick 260627-r94 (R94-3). PURE read. Maps the SAFETY-CRITICAL
   * dayAllergenStatus state to ONE header glyph (the full per-day banner moved into a
   * modal). Resolves the status ONCE. LOCKED mapping:
   *   conflict → ⚠   unmatched → ⚠   unknown → ⚠   cant-check → ❓
   *   clear → ''  (green all-clear is SILENT — no icon)   none → ''  (already hidden)
   * The warning sign carries the U+FE0E text-presentation selector so it renders as a
   * mono glyph the CSS can COLOUR (red for conflict, amber for unmatched/unknown via the
   * .allergen-icon-danger / .allergen-icon-warn classes) — an emoji ⚠️ would ignore
   * `color`. Severity (which colour) is driven by the state classes in the markup, NOT
   * by the glyph; this helper only decides triangle-vs-question-vs-nothing.
   * Any unrecognised state → '' (fail safe: never a false-reassurance glyph; the button
   * x-show is icon-gated so it simply won't render). The button is x-show-gated on this
   * truthiness, so absence-of-icon means "checked, no conflict" — and because clear is
   * silent, cant-check MUST keep its ❓ (never silently imply safe). No writes/no warn.
   */
  dayAllergenIcon(group) {
    const st = this.dayAllergenStatus(group);
    switch (st && st.state) {
      case 'conflict': return '⚠︎';  // ⚠ text-presentation (colour via .allergen-icon-danger)
      case 'unmatched': return '⚠︎'; // ⚠ text-presentation (colour via .allergen-icon-warn)
      case 'unknown': return '⚠︎';   // ⚠ text-presentation (colour via .allergen-icon-warn)
      case 'cant-check': return '❓';
      default: return ''; // clear / none / unrecognised → silent
    }
  },

  /**
   * dayAllergenStatus — quick 260627-e6t. READ-ONLY, SAFETY-CRITICAL advisory.
   * Per meal-plan day (the passed visiblePlanByDay group), cross the roster
   * present THAT day against the FSA-14 allergens of that day's planned recipes
   * and return a DISCRIMINATED status object the per-day banner renders. Pure
   * read: NO writes, NO new state, NO new console.warn (must not add a 4th
   * console-baseline error). Reuses the EXISTING helpers — residentsPresentOnDate
   * (the one present-on-D rule), findKeywordHits (the one matcher),
   * this.allergensByRecipeId (the same recipe→allergen source the manager filter
   * uses), this.currentAllergenKeywords, and this.FSA14 — it never invents an
   * allergen tag outside what those produce.
   *
   * Five conservative states (+ 'none' = hide), per docs/coda-data-contract.md:
   *   cant-check : roster NOT loaded — never imply safe.
   *   conflict   : a present resident's allergy maps to an allergen cooked today.
   *   unmatched  : present resident with non-empty allergy text that yields ZERO
   *                FSA-14 hits — surfaced for manual review, NEVER silently dropped.
   *   unknown    : present resident with allergiesKnown===false — can't confirm safe.
   *   clear      : roster loaded, residents present, none of the above (distinct
   *                from cant-check).
   *   none       : roster loaded but nobody present this day — banner hidden (NOT
   *                a safety claim; nobody is being cooked for).
   *
   * Conflict is most severe and wins; it still CARRIES unmatched/unknown along so
   * those caveats don't disappear behind a conflict. Every field the markup
   * x-texts is returned as a PRE-JOINED STRING (allergensText / residentsText /
   * unmatchedText / unknownText, '' when N/A) so the markup never dereferences an
   * array under x-show — the classic 4th-console-error trap.
   */
  dayAllergenStatus(group) {
    // 0. Nothing planned this day → nothing to check; HIDE the banner. This is
    //    NOT a safety claim (no food planned = no exposure) and it MUST precede
    //    the roster-not-loaded check below: the roster is loaded only after a
    //    Coda fetch, so "not loaded" is the common default — without this guard
    //    every empty day in the window would flood the meal plan with identical
    //    "can't check" banners. A day with planned recipes + no roster still
    //    correctly falls through to cant-check (verification 260627-e6t).
    const entries = (group && Array.isArray(group.entries)) ? group.entries : [];
    if (entries.length === 0) return { state: 'none' };

    // 1. Roster not loaded → CAN'T CHECK (never imply safe).
    if (!this.rosterLoaded) return { state: 'cant-check' };

    // Oxford-comma join helper (local, pure) for the pre-joined display strings.
    const oxford = (arr) => {
      const a = (arr || []).filter(Boolean);
      if (a.length === 0) return '';
      if (a.length === 1) return a[0];
      if (a.length === 2) return a[0] + ' and ' + a[1];
      return a.slice(0, -1).join(', ') + ', and ' + a[a.length - 1];
    };

    // 2. Present residents — delegate the present-on-D rule (group.key is '' for
    //    Unscheduled → residentsPresentOnDate yields count 0 → no present residents).
    const { present } = residentsPresentOnDate(this.joinedRoster || [], group && group.key);

    // 3. The day's planned FSA-14 allergen set (resolve the getter ONCE).
    //    `entries` was resolved in step 0 above (guaranteed non-empty here).
    const byRecipe = this.allergensByRecipeId;
    const dayAllergens = new Set();
    for (const entry of entries) {
      const rec = byRecipe.get(entry && entry.recipe_id);
      if (rec && Array.isArray(rec.allergens)) {
        for (const a of rec.allergens) { if (a) dayAllergens.add(a); }
      }
    }

    // 4. Walk present residents, accumulating three disjoint findings.
    const nameField = CODA_FIELDS.residency.fullName;
    const allergyField = CODA_FIELDS.onboarding.allergies;
    const displayName = (row) => {
      const n = row && row[nameField];
      const s = (typeof n === 'string' ? n : '').trim();
      return s || 'a resident'; // NEVER surface raw allergy text or email.
    };
    const unknownNames = [];
    const unmatchedNames = [];
    const conflictAllergens = new Set();
    const conflictResidents = []; // { name, allergens: [...] }
    // Phase 16 (D40) — build the curated-record lookup ONCE (NOT in the loop). Keyed
    // by String(appid).trim() (the SAME coercion the join/seed use). Each value:
    // { reviewed:boolean, fsa14:string[] }; an absent APPID is simply not in the Map
    // → the classifier's keyword-fallback branch.
    const curatedByAppid = this._residentAllergenByAppid;
    for (const row of present) {
      // Phase 16 (D40) — match the curated row by the SAME APPID coercion (resolved
      // BEFORE the short-circuit so a human-reviewed record can override "unknown" —
      // quick 260627-kfs). The classifier is tag-driven and returns only FSA-14 tags.
      const rawAppid = row && row['APPID'];
      const appid = String(Array.isArray(rawAppid) ? (rawAppid.length ? rawAppid[0] : '') : (rawAppid != null ? rawAppid : '')).trim();
      const curated = curatedByAppid.get(appid) || null;
      const isReviewed = !!(curated && curated.reviewed === true);
      if (row && row.allergiesKnown === false && !isReviewed) {
        // No onboarding record → explicit UNKNOWN (do NOT read .onboarding here).
        // The allergiesKnown===false → unknown short-circuit stays OWNED HERE (it is
        // never pushed into the PURE classifier — 16-02 Task 3), UNLESS a human-reviewed
        // curated record (curated.reviewed===true) overrides it: a reviewed record is
        // authoritative and falls through to the classifier (conflict or clear from its
        // curated FSA-14 tags — quick 260627-kfs). Seeded-but-not-reviewed and
        // no-record-at-all STILL go UNKNOWN — the gate is reviewed===true ONLY, never
        // mere presence of a curated record (strictly narrows "unknown", never widens "clear").
        unknownNames.push(displayName(row));
        continue;
      }
      const rawText = ((row && row.onboarding && row.onboarding[allergyField]) || '').toString().trim();
      // Compute the resident's keyword tags as today (findKeywordHits stays in app.js); then
      // DELEGATE the safety-critical tri-state to the PURE Node-asserted classifyResidentAllergens
      // (reviewed tags win / reviewed-empty clear / absent-or-seeded-not-reviewed → keyword
      // fallback). For a reviewed-no-onboarding resident, rawText/keywordTags are empty and the
      // classifier reads curated.reviewed===true → authoritative result.
      const keywordTags = [...findKeywordHits(rawText, this.currentAllergenKeywords).keys()];
      const contribution = classifyResidentAllergens(curated, keywordTags, dayAllergens, !!rawText);
      if (contribution.kind === 'conflict') {
        const allergens = this.FSA14.filter(a => contribution.allergens.includes(a));
        for (const a of allergens) conflictAllergens.add(a);
        conflictResidents.push({ name: displayName(row), allergens });
      } else if (contribution.kind === 'unmatched') {
        unmatchedNames.push(displayName(row));
      }
      // 'clear' → contributes nothing (a reviewed-empty record, a non-conflicting
      // curated/keyword set, or blank text with no curated tags).
    }

    // 5. Decide the state by PRIORITY (one banner per day; conflict most severe).
    const unmatchedText = oxford(unmatchedNames);
    const unknownText = oxford(unknownNames);
    if (conflictAllergens.size > 0) {
      const allergens = this.FSA14.filter(a => conflictAllergens.has(a));
      return {
        state: 'conflict',
        allergens,
        residents: conflictResidents,
        unmatchedNames,
        unknownNames,
        allergensText: oxford(allergens),
        residentsText: oxford(conflictResidents.map(r => r.name)),
        unmatchedText,
        unknownText
      };
    }
    if (unmatchedNames.length > 0) {
      return { state: 'unmatched', unmatchedNames, unknownNames, unmatchedText, unknownText };
    }
    if (unknownNames.length > 0) {
      return { state: 'unknown', unknownNames, unknownText };
    }
    if (present.length > 0) {
      return { state: 'clear' };
    }
    // Roster loaded but nobody present this day → hide the banner (not a claim).
    return { state: 'none' };
  },

  /**
   * suggestedServingsFor — quick 260620-rm6. READ-ONLY advisory helper for the
   * meal-plan day cards. Returns { servings, headcount, mult } for an exact
   * Main/Side/Salad recipe on a day with a known headcount, else null. PURE read —
   * NO writes, NO scaling wiring, NO detectChainedOverlap. Returns null when: the
   * roster headcount is unknown (headcountForDate === null — Unscheduled / roster
   * not loaded); the type is not an exact 'main'/'side'/'salad' match (e.g.
   * 'Dressed Salad', 'Salad Dressing', 'Component', blank); or the per-type
   * multiplier is not a positive finite number. servings = ceil(headcount × mult).
   */
  suggestedServingsFor(entry, group) {
    const base = this.headcountForDate(group && group.key);
    if (base === null) return null;
    // quick 260621-lft — scale the suggestion to the EFFECTIVE headcount so a cooking
    // day covers any leftovers day rolling onto it (advisory only — never writes
    // entry.servings). bonus is 0 unless the next day is a genuine, flagged leftovers day.
    const hc = base + this._leftoverBonusInto(group && group.key);
    const t = ((entry && entry.type) || '').trim().toLowerCase();
    const mult = t === 'main' ? this.servingsPerResidentMain
      : t === 'side' ? this.servingsPerResidentSide
        : t === 'salad' ? this.servingsPerResidentSalad
          : null;
    if (mult === null) return null;
    if (!(Number.isFinite(mult) && mult > 0)) return null;
    return { servings: Math.ceil(hc * mult), headcount: hc, mult };
  },

  /**
   * scaleNoteText — quick 260620-rm6. The meal-plan card note text. ALWAYS returns
   * a STRING (never null) — the null-safety guard so the markup never dereferences a
   * null suggestion (console baseline must stay at exactly 3 errors). Prefers the
   * advisory suggestion when one applies; otherwise falls back to the existing
   * scaled-line text; otherwise returns '' (blank servings → the markup hides the
   * note via x-show). Advisory ONLY — does NOT change entry.servings or scaling.
   */
  scaleNoteText(entry, group) {
    const s = this.suggestedServingsFor(entry, group);
    if (s) return `Suggested: ${s.servings} servings`;
    if (this.factorOrNull(entry.servings) !== null) return `scaled 20 → ${entry.servings} servings · ×${Math.round(entry.servings / 20 * 100) / 100}`;
    return '';
  },

  /**
   * applySuggestedServings — quick 260620-sg9. Click-to-apply the advisory
   * suggestion: set the entry's servings to the suggested value and persist via
   * the SAME meal-plan localStorage path the servings <input> already uses
   * (_persistMealPlan) — NOT a CSV/IndexedDB write. No-op when there is no
   * suggestion (guards against a stray call). The suggestion line keeps showing
   * afterwards (suggestedServingsFor is headcount-driven, not servings-driven), so
   * re-clicking is harmless/idempotent.
   */
  applySuggestedServings(entry, group) {
    const s = this.suggestedServingsFor(entry, group);
    if (!s) return;
    entry.servings = s.servings;
    this._persistMealPlan();
  },

  /**
   * fetchRoster — Plan 07-03. THE one credential-gated step, isolated behind a
   * user gesture (the "Fetch / refresh roster" button) — NEVER called from init()
   * (PATTERNS §7). Reads the four coda_* config values FRESH off `this` at call
   * time (they are rebuilt-from-localStorage per construction, never module-cached,
   * so a rotated token applies without a reload — Plan 07-02). Pulls both Coda
   * tables live, normalises, caches via putRosterTable (plain write — the roster is
   * a re-fetchable cache, NOT the user's irreplaceable recipe data), then refreshes
   * the joined session slice via loadRosterFromCache so the panel recomputes.
   *
   * Security (T-07-08): the token is used ONLY inside fetchCodaTable's Bearer
   * header; no error message ever includes it (status-aware text only). The
   * one-shot diagnostic logs the date-cell format + value-object KEYS only — never
   * full PII rows (RESEARCH Security V9).
   */
  async fetchRoster() {
    // Guard against a double-fire while a fetch is already in flight.
    if (this.rosterFetching) return;

    // Read the four config values FRESH at call time.
    const token = this.codaApiToken;
    const docId = this.codaExportDocId;
    const residencyTableId = this.codaResidencyTableId;
    const onboardingTableId = this.codaOnboardingTableId;

    // Blank config short-circuits with a friendly message — do NOT throw.
    if (!token || !docId || !residencyTableId || !onboardingTableId) {
      this.rosterError = 'Enter your Coda config (token + doc id + both table ids) in Settings first.';
      return;
    }

    this.rosterFetching = true;
    this.rosterError = '';
    try {
      // Inject the browser's fetch as the impl. At live scale the response is a
      // SINGLE page (no nextPageToken); fetchCodaTable follows page tokens only and
      // never loops on nextSyncToken (a sync cursor, not pagination).
      const residencyItems = await fetchCodaTable(
        { token, docId, tableId: residencyTableId },
        fetch
      );
      const onboardingItems = await fetchCodaTable(
        { token, docId, tableId: onboardingTableId },
        fetch
      );

      // One-shot, PII-free diagnostic on the first successful live response:
      // confirms the doc-tz offset date format + that live column names match
      // CODA_FIELDS (incl. that onboarding values are array-wrapped). Logs the
      // date string + value KEYS only — never a full PII row.
      const firstResidency = residencyItems && residencyItems[0];
      if (firstResidency && firstResidency.values) {
        const sampleDate = firstResidency.values[CODA_FIELDS.residency.checkIn];
        console.log('[roster] sample residency date cell:', sampleDate, '| residency value keys:', Object.keys(firstResidency.values));
      }
      const firstOnboarding = onboardingItems && onboardingItems[0];
      if (firstOnboarding && firstOnboarding.values) {
        console.log('[roster] onboarding value keys:', Object.keys(firstOnboarding.values));
      }

      const residencyRows = normalizeCodaRows(residencyItems);
      const onboardingRows = normalizeCodaRows(onboardingItems);

      // One fetchedAt stamp shared by the cache write AND the GitHub snapshot
      // (Phase 17, D-10) so the cached table and the snapshot agree on when this
      // fetch happened.
      const rosterFetchedAt = new Date().toISOString();

      // Plain cache write (no snapshot/verify/revert — re-fetchable cache).
      await putRosterTable('residency', { rows: residencyRows, fetchedAt: rosterFetchedAt });
      await putRosterTable('onboarding', { rows: onboardingRows, fetchedAt: rosterFetchedAt });

      // Refresh the joined session slice + recompute the panel.
      await this.loadRosterFromCache();

      // Phase 16 (D40) — seed residents_allergens.csv for any NEW APPID (the seed
      // hook goes AFTER joinedRoster is populated). insert-if-absent: an existing
      // curated record is NEVER re-clobbered. Best-effort + own error channel so a
      // seed failure never turns a successful roster fetch into a fetch error.
      await this._seedResidentAllergensFromRoster();

      // Phase 17 (Plan 17-03, D-08/D-10) — snapshot BOTH roster tables to the
      // shared repo so a tokenless device can read the roster. Best-effort with
      // its OWN error channel (mirrors _seedResidentAllergensFromRoster above): a
      // snapshot-push failure must NEVER set rosterError or turn this successful
      // Coda fetch into a fetch error. Built from the rows already in hand.
      await this._pushRosterSnapshot(this.buildRosterSnapshot(residencyRows, onboardingRows, rosterFetchedAt));
    } catch (e) {
      // Status-aware message — NEVER include the token (T-07-08).
      const msg = (e && e.message) || '';
      let friendly;
      if (/\b401\b/.test(msg)) {
        friendly = 'Coda rejected the request (401) — the API token is missing, wrong, or expired. Check it in Settings.';
      } else if (/\b404\b/.test(msg)) {
        friendly = 'Coda returned 404 — the doc id or a table id looks wrong. Check them in Settings.';
      } else if (/\b429\b/.test(msg)) {
        friendly = 'Coda rate-limited the request (429) — wait a moment and try again.';
      } else {
        friendly = `Couldn't fetch the roster from Coda: ${msg || 'unknown error'}.`;
      }
      this.rosterError = friendly;
    } finally {
      this.rosterFetching = false;
    }
  },

  /**
   * buildRosterSnapshot — Phase 17 (Plan 17-03, D-10). Thin Alpine wrapper over the
   * PURE roster-sync helper (Node-tested in scripts/roster-sync.test.mjs). Returns
   * the ROWS-ONLY residents_roster.json shape from the rows already fetched in
   * fetchRoster. CRITICAL (SENSITIVE tier, T-17-08): the payload is rows + fetchedAt
   * only — the pure helper takes no credential parameter, so NO codaApiToken / PAT /
   * cfg field can enter the snapshot. Kept as a method (not inlined) so the
   * no-creds contract is verified once in the pure helper's test.
   * @param {Array<object>} residencyRows
   * @param {Array<object>} onboardingRows
   * @param {string} fetchedAt — the ISO timestamp of this Coda fetch
   * @returns {{residency:{rows,fetchedAt}, onboarding:{rows,fetchedAt}}}
   */
  buildRosterSnapshot(residencyRows, onboardingRows, fetchedAt) {
    return buildRosterSnapshot(residencyRows, onboardingRows, fetchedAt);
  },

  /**
   * _pushRosterSnapshot — Phase 17 (Plan 17-03, D-08/D-09/D-13). Write the roster
   * snapshot to the shared repo. LOCAL-first (putJsonFile — its own snapshot ->
   * verify[JSON.parse + the residents_roster.json shapeCheck] -> auto-revert, D-12)
   * then REMOTE (ghPutFile). First write is a CREATE (sha undefined, D-13); the
   * cached this._rosterSnapshotSha makes it an UPDATE thereafter.
   *
   * Concurrency is LAST-WRITE-WINS, OUTSIDE the advisory lock (D-09):
   * - NEVER acquireLock/releaseLock — a roster refresh must not flip the other user
   *   read-only (T-17-11). The snapshot is a pure Coda mirror with no user-authored
   *   data to lose, so on a stale-sha 409 it re-reads the current sha and re-PUTs
   *   (overwrite) — NO hard-stop, NO merge (contrast the meal plan's 3-way merge).
   *
   * Best-effort with its OWN error channel (T-17-10): a connection/name/transport
   * failure is SWALLOWED here — it must NEVER set rosterError or turn a successful
   * Coda fetch into a fetch error. Guards refuse on the network before any I/O:
   * not connected / no token / no name set.
   * @param {{residency:{rows,fetchedAt}, onboarding:{rows,fetchedAt}}} snapshot
   */
  async _pushRosterSnapshot(snapshot) {
    // Guards — no connection / no token / no attribution = nothing to push (no
    // network, no error surfaced). The roster still lives locally either way.
    if (!this.githubConnected || !this.githubToken) return;
    if (!(this.userName ?? '').trim()) return; // every commit needs a name (D-07)
    try {
      // LOCAL-first: putJsonFile verifies (shapeCheck) + auto-reverts a malformed
      // blob before it ever reaches the wire (D-08/D-12).
      await putJsonFile('residents_roster.json', snapshot, { shapeCheck: this._jsonShapeCheckFor('residents_roster.json') });
      const cfg = this.githubCfg; // fresh per call (rotated token, no reload)
      const message = this.buildCommitMessage({ action: 'sync', objectKind: 'residents roster', title: '', groupTag: 'roster' });
      const text = JSON.stringify(snapshot);
      try {
        // CREATE on the first write (sha undefined, D-13); UPDATE with the cached sha.
        const { sha: newSha } = await ghPutFile(cfg, 'residents_roster.json', text, this._rosterSnapshotSha, message);
        this._rosterSnapshotSha = newSha;
      } catch (e) {
        // Stale-sha 409 → LWW: re-read the CURRENT sha and re-PUT (overwrite). The
        // snapshot is a pure Coda mirror — there is nothing to merge or lose (D-09).
        if (e instanceof GhConflictError) {
          let currentSha;
          try { const { sha } = await ghGetFile(cfg, 'residents_roster.json'); currentSha = sha; }
          catch (_e) { currentSha = undefined; } // 404/etc → CREATE on the re-PUT
          const { sha: newSha } = await ghPutFile(cfg, 'residents_roster.json', text, currentSha, message);
          this._rosterSnapshotSha = newSha;
          return;
        }
        throw e;
      }
    } catch (_e) {
      // Own error channel (T-17-10): a snapshot-push failure is best-effort and
      // SWALLOWED — it never sets rosterError and never fails the Coda fetch. The
      // roster is fully usable locally; the next refresh re-attempts the snapshot.
    }
  },

  /**
   * importCsvs — quick 260612-abt. The one-time seed of EXISTING CSVs into the
   * store. Reads each selected File's text, parseCsv's it, putFile's each into
   * the store (verify-protected), then loadFromStore() to populate session state.
   * Files are mapped by filename (the input is multi-select). REUSES the
   * isOldSchema* guards via loadFromStore's schemaMigrationNeeded detection so an
   * old-schema import still offers Migrate.
   *
   * @param {Event} ev — the file input change event
   */
  async importCsvs(ev) {
    const files = ev && ev.target && ev.target.files ? Array.from(ev.target.files) : [];
    if (files.length === 0) return;
    this.parseError = '';
    this.parseErrorDetail = '';   // quick 260618-jr7 — drop any stale parse-API detail
    // Map selected files by basename so order doesn't matter.
    const byName = {};
    for (const f of files) byName[f.name] = f;

    // Phase 16: first-run import requires the 3 REQUIRED recipe CSVs (the v2
    // contract), NOT the optional 4th file. residents_allergens.csv is seeded /
    // synced, never user-imported as part of first-run — so the "select all three"
    // requirement and the import loop are scoped to REQUIRED_STORE_FILES.
    const missing = REQUIRED_STORE_FILES.filter(n => !byName[n]);
    if (missing.length > 0) {
      this.parseError = `Please select all three CSVs. Missing: ${missing.join(', ')}.`;
      // Reset the input so re-selecting the same files re-fires change.
      if (ev.target) ev.target.value = '';
      return;
    }

    try {
      for (const name of REQUIRED_STORE_FILES) {
        const text = await byName[name].text();
        const record = parseCsv(text, Papa);
        if (!record.columns || record.columns.length === 0) {
          throw new Error(`${name} had no readable header row.`);
        }
        // Seed the store. No headerCheckFn on import — we accept old-schema files
        // here (the Migrate path rewrites them afterwards); putFile still verifies
        // the round-trip (row-count + header order) so a corrupt import is caught.
        await putFile(name, record, { Papa });
      }
      await this.loadFromStore();
    } catch (e) {
      if (e && e.isRestoreOfferSentinel) {
        // mergeRestoreOffer set by putFile's revert — leave it informational.
      } else {
        this.parseError = `Couldn't import your CSVs: ${(e && e.message) || 'unknown error'}.`;
      }
    } finally {
      // Always reset the input so the same files can be re-imported if needed.
      if (ev.target) ev.target.value = '';
    }
  },

  /**
   * exportCsvs — quick 260612-abt. Download all 3 store files byte-faithfully
   * (column order / BOM / newline preserved by serializeCsv). One Blob +
   * download-anchor per file. The primary backup affordance.
   */
  async exportCsvs() {
    this.parseError = '';
    this.parseErrorDetail = '';   // quick 260618-jr7 — drop any stale parse-API detail
    try {
      for (const name of STORE_FILES) {
        const rec = await getFile(name);
        if (!rec) continue;   // skip an absent file rather than download an empty one
        const text = serializeCsv(
          { columns: rec.columns, rows: rec.rows },
          { hasBOM: rec.hasBOM, newline: rec.newline },
          Papa
        );
        const blob = new Blob([text], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      this.parseError = `Couldn't export your CSVs: ${(e && e.message) || 'unknown error'}.`;
    }
  },

  /**
   * openServerImport — quick 260613-c20. PULL direction. Same-origin GET of the
   * live-data/import/ directory LISTING (the static `python -m http.server`
   * autoindex; no backend / no CORS), parses the <a href> links, intersects with
   * STORE_FILES — so absent files are simply not listed (no 404 console noise).
   * PER-FILE: each present file is fetched + parsed to show its row count in the
   * confirm modal; a parse/fetch failure on one is skipped (others still import).
   * Stashes ONLY { name, rows } on Alpine state — NOT the parsed record (a
   * reactive Proxy can't be structured-cloned by IndexedDB); confirmServerImport
   * re-parses fresh. If NONE present the modal does NOT open — serverImportError
   * surfaces instead. No write happens here; this only gathers + opens the modal.
   */
  async openServerImport() {
    this.serverImportError = '';
    this.serverImportNotice = '';
    this.serverImportFound = [];
    // DISCOVER via the dev server's directory listing (python http.server
    // autoindex), NOT by probing fixed names — probing 404s the absent files,
    // which the browser logs as console errors. One GET on the dir → parse the
    // <a href="…csv"> links → intersect with STORE_FILES (canonical order).
    let names = [];
    try {
      const res = await fetch('live-data/import/', { cache: 'no-store' });
      if (res.ok) {
        const html = await res.text();
        const present = new Set();
        for (const m of html.matchAll(/href="([^"]+)"/g)) {
          const base = decodeURIComponent(m[1].split('/').pop().split('?')[0]);
          if (STORE_FILES.includes(base)) present.add(base);
        }
        names = STORE_FILES.filter(n => present.has(n));
      }
    } catch (_e) { /* no listing → nothing found (handled below) */ }
    // Fetch + parse each present file to show row counts in the confirm modal.
    // IMPORTANT: do NOT stash the parsed record on Alpine state — Alpine wraps it
    // in a reactive Proxy, and putFile's IndexedDB put() (a structured clone)
    // cannot clone a Proxy. confirmServerImport re-parses FRESH instead.
    for (const name of names) {
      try {
        const res = await fetch('live-data/import/' + name, { cache: 'no-store' });
        if (!res.ok) continue;
        const record = parseCsv(await res.text(), Papa);
        if (!record.columns || !record.columns.length) continue;   // no readable header → skip
        this.serverImportFound.push({ name, rows: (record.rows || []).length });
      } catch (_e) {
        continue;   // skip this file; the others still import
      }
    }
    if (this.serverImportFound.length === 0) {
      this.serverImportError = 'No CSVs found in live-data/import/ on the server.';
      return;   // do NOT open the modal
    }
    this.serverImportOpen = true;
  },

  /**
   * confirmServerImport — quick 260613-c20. Re-fetches + parses each confirmed
   * file FRESH (local record, never the reactive one) and writes it via putFile
   * (the EXISTING snapshot->verify->auto-revert chain — NO headerCheckFn, same as
   * importCsvs), then loadFromStore() to repopulate session state, then a success
   * notice listing per-file row counts. Restore-sentinel handling mirrors
   * importCsvs: putFile's auto-revert already rolled the failed write back and set
   * the informational mergeRestoreOffer banner, so we just close the modal and
   * leave it informational; any other error surfaces via serverImportError.
   * serverImportBusy guards the confirm/cancel buttons during the write.
   */
  async confirmServerImport() {
    this.serverImportBusy = true;
    this.serverImportError = '';
    try {
      for (const f of this.serverImportFound) {
        // Re-fetch + parse FRESH into a LOCAL record (never the reactive one) so
        // putFile's IndexedDB put() can structured-clone it. Mirrors importCsvs.
        const res = await fetch('live-data/import/' + f.name, { cache: 'no-store' });
        if (!res.ok) throw new Error(`${f.name} is no longer available on the server.`);
        const record = parseCsv(await res.text(), Papa);
        await putFile(f.name, record, { Papa });
      }
      await this.loadFromStore();
      this.serverImportNotice =
        'Imported from server: ' +
        this.serverImportFound.map(f => `${f.name} (${f.rows} rows)`).join(', ') + '.';
      this.serverImportOpen = false;
    } catch (e) {
      if (e && e.isRestoreOfferSentinel) {
        // mergeRestoreOffer set by putFile's revert — leave it informational.
        this.serverImportOpen = false;
      } else {
        this.serverImportError = `Couldn't import from server: ${(e && e.message) || 'unknown error'}.`;
      }
    } finally {
      this.serverImportBusy = false;
    }
  },

  // ----- Settings: API key persistence -----
  saveApiKey() {
    const next = (this.apiKeyDraft ?? '').trim();
    this.apiKey = next;
    localStorage.setItem('recipe_ingest_api_key', next);
    this.settingsOpen = false;
  },

  clearApiKey() {
    this.apiKey = '';
    this.apiKeyDraft = '';
    localStorage.removeItem('recipe_ingest_api_key');
  },

  // ----- Settings: Coda roster config persistence (Phase 07, ROSTER-02) -----
  // saveCodaConfig — Save-button BATCH persist (mirrors saveApiKey's single-write
  // ergonomics): trim each of the four drafts, assign to its field, and write all
  // four LOCKED localStorage keys in one click. Drafts are seeded on Settings open
  // (goToView 'settings'), so this is the ONLY persist path — there is deliberately
  // NO per-field @change handler. CLOSES the modal on save (settingsOpen = false),
  // matching saveApiKey for consistent Settings ergonomics.
  saveCodaConfig() {
    this.codaApiToken = (this.codaApiTokenDraft ?? '').trim();
    this.codaExportDocId = (this.codaExportDocIdDraft ?? '').trim();
    this.codaResidencyTableId = (this.codaResidencyTableIdDraft ?? '').trim();
    this.codaOnboardingTableId = (this.codaOnboardingTableIdDraft ?? '').trim();
    localStorage.setItem('coda_api_token', this.codaApiToken);
    localStorage.setItem('coda_export_doc_id', this.codaExportDocId);
    localStorage.setItem('coda_residency_table_id', this.codaResidencyTableId);
    localStorage.setItem('coda_onboarding_table_id', this.codaOnboardingTableId);
    this.settingsOpen = false;
  },

  // clearCodaConfig — the PII "clear creds" affordance (RESEARCH Security V9;
  // T-07-04 removeItem path). Wipes all four fields + drafts and removes all four
  // LOCKED keys (mirror clearApiKey).
  clearCodaConfig() {
    this.codaApiToken = '';
    this.codaApiTokenDraft = '';
    this.codaExportDocId = '';
    this.codaExportDocIdDraft = '';
    this.codaResidencyTableId = '';
    this.codaResidencyTableIdDraft = '';
    this.codaOnboardingTableId = '';
    this.codaOnboardingTableIdDraft = '';
    localStorage.removeItem('coda_api_token');
    localStorage.removeItem('coda_export_doc_id');
    localStorage.removeItem('coda_residency_table_id');
    localStorage.removeItem('coda_onboarding_table_id');
  },

  // ----- Settings: Connect to shared database (Phase 10, ACCESS-01/02) -----

  // githubFriendlyError — the D-05 typed-error -> friendly-copy map. This is the
  // THIN translation layer; ALL HTTP-status knowledge already lives in
  // githubStore.mapError (no new status logic here). Keys ONLY on err.name /
  // err.status / err.githubMessage — it NEVER reads this.githubToken, so the
  // token can never leak into connectionError (T-10-07). The GhError contract
  // guarantees .githubMessage excludes the token, so surfacing it is safe.
  githubFriendlyError(err) {
    // GhAuthError / 401 — bad / expired token.
    if ((err && err.name === 'GhAuthError') || (err && err.status === 401)) {
      return 'That token is invalid or expired — check your shared token in Settings.';
    }
    // GhRateLimitError — ACCESS-04 (D-08/D-09). MUST precede the GhAccessError /
    // 403 branch below: a rate-limit hit IS a 403 (or 429), so matching on
    // err.name first disambiguates "GitHub is busy" from a genuine permissions
    // 403 (Pitfall 2 / T-14-05). Reads ONLY err.name + err.retryAfterSeconds —
    // NEVER this.githubToken (T-14-04). Inform-only copy: the user re-triggers;
    // there is NO auto-retry (D-08 / T-14-06).
    if (err && err.name === 'GhRateLimitError') {
      const n = err.retryAfterSeconds || 60;
      return `GitHub is busy — try again in about ${n}s.`;
    }
    // GhAccessError / 403 / 404 — no access, wrong repo/owner/branch, not found.
    if ((err && err.name === 'GhAccessError') || (err && (err.status === 403 || err.status === 404))) {
      return "That token can't reach that repo — check the owner, name and branch.";
    }
    // GhConflictError / 409 — Phase 11 (SAVE-02, D-03). A stale blob sha: someone
    // else wrote the file first. This is a HARD STOP — the write is NEVER
    // auto-retried; the user must Refresh (refreshKeepEdit, which keeps their open
    // edit) then re-Save against the fresh sha. GhConflictError already carries
    // status 409 from githubStore.mapError, so this stays the thin translator (no
    // new status logic here).
    if ((err && err.name === 'GhConflictError') || (err && err.status === 409)) {
      return 'Someone else changed this — Refresh, then re-save.';
    }
    // GhCreateError / 422 — Phase 13 Plan 02 (MIGRATE-02, D-07). The seed-time
    // analogue of the 409 hard-stop: a CREATE (PUT without sha) landed on a file
    // that appeared between the 404-probe and the PUT — another founder/user raced
    // the seed. GitHub returns 422, githubStore.mapError maps it to GhCreateError.
    // This is a HARD STOP — the seed is NEVER auto-retried as an overwrite (which
    // would silently clobber the file the racer just created). Stays the thin
    // translator (no new status logic — the 422→GhCreateError mapping lives in
    // githubStore.mapError); the founder must Refresh and join instead.
    if ((err && err.name === 'GhCreateError') || (err && err.status === 422)) {
      return 'Someone else initialized this repo first — Refresh and join instead.';
    }
    // Network / offline — a fetch reject is a TypeError with no .status.
    if (err && err.status === undefined) {
      return "Couldn't reach GitHub — check your connection.";
    }
    // Default — surface the GhError's safe .githubMessage (never the token), or
    // a generic status-tagged fallback.
    if (err && err.githubMessage) return err.githubMessage;
    return `Connection failed${err && err.status ? ` (${err.status})` : ''}.`;
  },

  // _maybeRateLimitBanner — ACCESS-04 (D-09 central). Called beside EVERY catch
  // that already routes through githubFriendlyError so a rate-limit error on ANY
  // GitHub path (get/put/delete/commits/connect/seed/push) additionally raises
  // the ONE shared inform-only banner — without disturbing that catch's normal
  // inline status copy. Reads ONLY e.name (never the token, T-14-04). Inform-only:
  // NO retry/refresh logic (D-08 / T-14-06) — the user re-triggers the action.
  _maybeRateLimitBanner(e) {
    if (e && e.name === 'GhRateLimitError') this.rateLimitBanner = this.githubFriendlyError(e);
  },

  // dismissRateLimitBanner — clears the inform-only banner (the only affordance;
  // there is deliberately no Refresh/retry button — D-08).
  dismissRateLimitBanner() { this.rateLimitBanner = ''; },

  /**
   * _routePushFailure — Phase 11 Plan 03 (SAVE-02, D-01/D-03/D-04/D-07). The
   * SINGLE place every write caller's catch routes a PUSH failure into the
   * pushConflictOffer banner. Returns true if it recognised + handled a push
   * failure (so the caller skips its generic error channel — single-banner
   * discipline: a push failure sets ONLY pushConflictOffer, never parseError,
   * never mergeRestoreOffer), or false if the error is NOT a push failure (the
   * caller falls through to its own error/notice copy).
   *
   * Callers MUST check e.isRestoreOfferSentinel (the LOCAL all-or-nothing
   * auto-rollback path → mergeRestoreOffer, handled by the writer) BEFORE calling
   * this — a local-verify failure is NOT a push failure.
   *
   * CRUCIALLY: this NEVER touches the open editor's in-memory state (this.form /
   * editing*Id). SAVE-02 requires the user's edit to survive on screen after a
   * 409 so they can Refresh + re-Save. All reason strings come from
   * githubFriendlyError (which never reads the token, T-11-11) or fixed literals
   * — no raw err.message passthrough that could echo a URL/token.
   *
   * Kind selection (priority order):
   *   - isRemotePartialSave → partialSave (D-04: file A landed, B did not). The
   *       reason names what landed vs not, branching on the underlying cause.
   *   - GhConflictError / 409 → conflict409 ("Someone else changed this…").
   *   - isPushVerifyMismatch → verifyMismatch (SAVE-04 GET-back didn't match;
   *       flag/block, no auto-revert — git history holds the truth).
   *   - isPushNameMissing → nameMissing (D-07; surfaces the guard's own copy).
   *   - true network (status undefined) / 5xx → network ("Couldn't reach the
   *       shared repo — try again."); simple retry, NO Refresh button.
   *   - any other GhError (401/403/404) → network kind but with the precise
   *       githubFriendlyError copy (token/access wording), still a simple retry.
   */
  _routePushFailure(e) {
    if (!e) return false;
    // ACCESS-04 — a rate-limited PUSH ALSO raises the shared inform-only banner
    // (D-09 central), beside whichever pushConflictOffer branch classifies it.
    this._maybeRateLimitBanner(e);
    // D-04 partial-save (the two-file orchestrator tagged it). recipes.csv landed
    // remotely, recipe_ingredients.csv did not — name what landed (filesWritten).
    if (e.isRemotePartialSave) {
      const reason =
        (e instanceof GhConflictError || e.status === 409)
          ? "The recipe was saved, but its ingredient links weren't — someone else changed the file. Refresh, then re-save."
          : e.isPushVerifyMismatch
            ? "The recipe was saved, but the read-back of its ingredient links didn't match — please re-check and re-save."
            : e.isPushNameMissing
              ? (e.message || 'Set your name in Settings to save to the shared database.')
              : "The recipe was saved, but its ingredient links couldn't be pushed to the shared database — try again.";
      // Phase 16: name the file that actually landed (carried on the error by the
      // orchestrator); fall back to recipes.csv for the established recipe pair.
      this.pushConflictOffer = { reason, kind: 'partialSave', filesWritten: e.partialSaveFilesWritten || ['recipes.csv'] };
      return true;
    }
    // Missing-name block (D-07) — surfaces before status branches (it never PUT).
    if (e.isPushNameMissing) {
      this.pushConflictOffer = {
        reason: e.message || 'Set your name in Settings to save to the shared database.',
        kind: 'nameMissing'
      };
      return true;
    }
    // Stale-SHA 409 — the headline hard stop. Refresh-then-re-save copy.
    if (e instanceof GhConflictError || e.status === 409) {
      this.pushConflictOffer = { reason: this.githubFriendlyError(e), kind: 'conflict409' };
      return true;
    }
    // SAVE-04 verify mismatch — the GET-back did not match the bytes we pushed.
    // Flag/block (no Refresh, no auto-revert — git history is the deep rollback).
    if (e.isPushVerifyMismatch) {
      this.pushConflictOffer = {
        reason: "Saved, but the read-back from the shared repo didn't match what was sent — re-check and re-save (the file's history holds the previous version).",
        kind: 'verifyMismatch'
      };
      return true;
    }
    // Network (fetch reject = TypeError, status undefined) or 5xx — simple retry,
    // distinct from the 409 Refresh path (Claude's-Discretion distinction).
    if (e.status === undefined || (typeof e.status === 'number' && e.status >= 500) || e instanceof TypeError) {
      this.pushConflictOffer = {
        reason: 'Couldn’t reach the shared repo — try again.',
        kind: 'network'
      };
      return true;
    }
    // Any other typed GhError (401/403/404) — a token/access problem. Use the
    // precise githubFriendlyError copy (never the token); still a simple retry.
    if (e instanceof GhError || (typeof e.status === 'number')) {
      this.pushConflictOffer = { reason: this.githubFriendlyError(e), kind: 'network' };
      return true;
    }
    // Not a push failure — let the caller use its own error channel.
    return false;
  },

  // saveConnection — D-04 validate-on-Save (NO separate Test button). The four
  // drafts are trimmed into LOCAL consts and the connection is validated BEFORE
  // anything is committed: (1) GET /repos for the ACCESS-02 private assertion,
  // then (2) a test pull via ghGetFile. On ANY failure the live fields,
  // localStorage and githubConnected are LEFT UNTOUCHED and a distinct inline
  // error (D-06 — inline, NOT a second modal) is shown; the modal STAYS OPEN.
  // Only on full success are the four fields assigned, the four
  // recipe_ingest_github_* keys written, githubConnected set true, and the modal
  // closed. connectionBusy gates the button (mirrors serverImportBusy).
  async saveConnection() {
    this.connectionBusy = true;
    this.connectionError = '';
    try {
      // (2) trim drafts into locals — do NOT assign live fields yet.
      const owner = (this.githubOwnerDraft ?? '').trim();
      const repo = (this.githubRepoDraft ?? '').trim();
      const branch = (this.githubBranchDraft ?? '').trim() || 'main';
      const token = (this.githubTokenDraft ?? '').trim();
      // Non-empty guard (branch defaults to 'main' if blank).
      if (!owner || !repo || !token) {
        this.connectionError = 'Fill in the repo owner, repo name and shared token.';
        return;
      }
      const cfg = { owner, repo, branch, token };

      // (4) GET /repos private assertion. Same Bearer/Accept/version headers the
      // transport uses (buildHeaders). On non-ok, map the status to friendly
      // copy via githubStore.mapError -> githubFriendlyError, and return WITHOUT
      // committing.
      let json;
      try {
        const res = await fetch(
          `https://api.github.com/repos/${owner}/${repo}`,
          { headers: buildHeaders(token) }
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          // Reuse the module's typed-error map so all status knowledge stays in
          // githubStore (D-05) — then translate via the friendly map.
          const ghErr = new GhError(res.status, body && body.message);
          ghErr.name = res.status === 401 ? 'GhAuthError'
                     : (res.status === 403 || res.status === 404) ? 'GhAccessError'
                     : 'GhError';
          this.connectionError = this.githubFriendlyError(ghErr);
          this._maybeRateLimitBanner(ghErr); // ACCESS-04
          return;
        }
        json = await res.json();
      } catch (e) {
        // Network / offline (fetch reject — TypeError, no .status).
        this.connectionError = this.githubFriendlyError(e);
        this._maybeRateLimitBanner(e); // ACCESS-04
        return;
      }

      // (5) ACCESS-02 gate — refuse a public repo with the loud inline refusal
      // (D-06). A public shared store would expose the WHOLE recipe DB to anyone.
      // Connection is NOT established.
      if (json.private !== true) {
        this.connectionError = 'That repo is PUBLIC — connecting would expose your entire recipe database to anyone on the internet. Use a PRIVATE repo. Connection was not established.';
        return;
      }

      // (6) Existence probe (Phase 13 / MIGRATE-01, D-02) — prove the token
      // genuinely reaches the repo, but TOLERATE an EMPTY repo (a founder
      // connecting to a brand-new shared store has none of the 3 CSVs yet). The
      // GET /repos private assertion above is the real access proof; this probe
      // only distinguishes "empty repo (seed-able)" from "populated repo
      // (normal connect)" and still hard-fails on any non-404 error (a 401/403
      // means the token genuinely can't read this repo). Probe all 3 STORE_FILES
      // so a partially-populated repo is detected too. Uses the shared
      // _probeRemoteShape (same 404-vs-error policy as pullFromRemote): a 404 is
      // counted as absent; any non-404 error re-throws and is mapped to a
      // connect-time failure here (connectionError + return, modal stays open).
      let remoteIsEmpty;
      try {
        const { absentCount } = await this._probeRemoteShape(cfg);
        // All REQUIRED recipe CSVs absent = an empty repo: a valid connected state
        // the founder can seed. (Phase 16: classify over REQUIRED via the pure
        // helper — a repo holding only the 3 recipe CSVs and no residents_allergens.csv
        // is a FULL, non-empty repo, never "empty".)
        remoteIsEmpty = classifyRemoteShape(absentCount) === 'empty';
      } catch (e) {
        // Any non-404 error (401/403/network) is a genuine connect failure.
        this.connectionError = this.githubFriendlyError(e);
        this._maybeRateLimitBanner(e); // ACCESS-04
        return;
      }

      // (7) SUCCESS — commit. Assign the live fields, persist the four keys, mark
      // connected, clear the error, close the modal, and (D-01) trigger the
      // pull-into-cache via loadFromStore (non-fatal — if Plan 03 isn't merged
      // yet this just re-reads the cache, which is harmless).
      this.githubOwner = owner;
      this.githubRepo = repo;
      this.githubBranch = branch;
      this.githubToken = token;
      localStorage.setItem('recipe_ingest_github_owner', owner);
      localStorage.setItem('recipe_ingest_github_repo', repo);
      localStorage.setItem('recipe_ingest_github_branch', branch);
      localStorage.setItem('recipe_ingest_github_token', token);
      // Phase 11 (D-06/D-07) — persist the self-declared name on the same Save.
      // It is LOGICALLY independent of the connection (the name is per-person,
      // the token per-connection), but riding the one Save button is the
      // lowest-friction path since both live in this Settings fieldset. A BLANK
      // name does NOT block saveConnection — a connection can succeed read-only;
      // the D-07 block fires only at push time (pushToRemote).
      this.userName = (this.userNameDraft ?? '').trim();
      localStorage.setItem('recipe_ingest_user_name', this.userName);
      this.githubConnected = true;
      // Phase 13 (MIGRATE-01, D-02) — record whether the remote is empty so the
      // "Initialize shared database" affordance (canSeed) can light up. A
      // populated repo sets this false (the normal connect path).
      this.remoteEmpty = remoteIsEmpty;
      this.connectionError = '';
      this.settingsOpen = false;
      try {
        await this.loadFromStore();
      } catch (e) {
        // Non-fatal: the connection is established; a pull/render hiccup must not
        // un-commit it. Plan 03 owns the read-only-fallback banner.
      }
    } finally {
      this.connectionBusy = false;
    }
  },

  // disconnect — D-08 prominent clear-token affordance. Because this PAT can
  // WRITE shared data, clearing it must be obvious and easy (more so than the
  // read-only Anthropic key). Mirrors clearCodaConfig: wipe the four fields +
  // four drafts, removeItem the four keys, mark disconnected, clear the inline
  // error. Does NOT close the modal — let the user SEE the cleared state.
  disconnect() {
    this.githubOwner = '';
    this.githubOwnerDraft = '';
    this.githubRepo = '';
    this.githubRepoDraft = '';
    this.githubBranch = 'main';
    this.githubBranchDraft = '';
    this.githubToken = '';
    this.githubTokenDraft = '';
    localStorage.removeItem('recipe_ingest_github_owner');
    localStorage.removeItem('recipe_ingest_github_repo');
    localStorage.removeItem('recipe_ingest_github_branch');
    localStorage.removeItem('recipe_ingest_github_token');
    this.githubConnected = false;
    this.connectionError = '';
  },

  // clearToken — ACCESS-03 token-ROTATION control (Phase 14 Plan 03). A STRICT
  // SUBSET of disconnect(): it wipes ONLY the shared write token surface — the
  // live token, its draft, and its single localStorage key — and clears the
  // inline error. It deliberately KEEPS owner/repo/branch (+ their drafts + their
  // localStorage keys) AND userName (+ recipe_ingest_user_name) so rotating a
  // leaked/expired PAT is a 10-second action: Clear token → paste the new token
  // → Save & connect (which re-runs saveConnection's GET /repos validate + pull).
  // A committed/leaked shared write token is "burned forever" — rotation is the
  // only remediation, so it must be the easy path. githubConnected is set false
  // because a blank token cannot reach the repo (githubCfg 401s every call); this
  // matches boot rehydration (app.js requires the token), so NO init() change is
  // needed (RESEARCH.md Open Q1/A2). Like disconnect(), it does NOT close the
  // modal — the user sees the cleared, ready-to-paste state. Produces no message
  // containing the token (T-14-11).
  clearToken() {
    this.githubToken = '';
    this.githubTokenDraft = '';
    localStorage.removeItem('recipe_ingest_github_token');
    this.githubConnected = false;
    this.connectionError = '';
  },

  // saveServingsConfig — quick 260620-rm6. Save-button BATCH persist for the three
  // advisory suggested-servings multipliers (mirrors saveCodaConfig). For each
  // draft: parseFloat, accept ONLY when finite and >= 0 — on accept assign the
  // field AND write its localStorage key (as a String); on reject leave the current
  // persisted field/value untouched (NEVER store NaN, NEVER write a rejected key).
  // These keys are display prefs, NOT PII, so they stay OUT of clearCodaConfig.
  // Per RM6-01. Closes the modal on save (settingsOpen = false).
  saveServingsConfig() {
    const apply = (draft, field, key) => {
      const v = parseFloat(draft);
      if (Number.isFinite(v) && v >= 0) {
        this[field] = v;
        localStorage.setItem(key, String(v));
      }
    };
    apply(this.servingsPerResidentMainDraft, 'servingsPerResidentMain', 'servings_per_resident_main');
    apply(this.servingsPerResidentSideDraft, 'servingsPerResidentSide', 'servings_per_resident_side');
    apply(this.servingsPerResidentSaladDraft, 'servingsPerResidentSalad', 'servings_per_resident_salad');
    this.settingsOpen = false;
  },

  // ----- Settings: scaling strengths (quick 260612-dr4) -----
  // saveScaleStrengths — clamp all 5 categories to 0..100 (NaN -> per-key
  // default) then persist. Called on @change from each Settings input so an
  // edit recomputes the meal plan live AND survives a reload. LOCKED SCOPE: this
  // is SEPARATE from resetAllToDefault() (D-21) — scaling has its own reset.
  saveScaleStrengths() {
    for (const key of Object.keys(DEFAULT_SCALE_STRENGTHS)) {
      const n = Number(this.scaleStrengths[key]);
      this.scaleStrengths[key] = Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : DEFAULT_SCALE_STRENGTHS[key];
    }
    localStorage.setItem(SCALE_STRENGTH_KEY, JSON.stringify(this.scaleStrengths));
  },

  // resetScaleStrengths — restore the 5 category defaults (fresh copy) + persist.
  // Dedicated to the "Reset scaling to defaults" button; resetAllToDefault()
  // (D-21) is intentionally NOT touched (prompt + conversions only).
  resetScaleStrengths() {
    this.scaleStrengths = { ...DEFAULT_SCALE_STRENGTHS };
    localStorage.setItem(SCALE_STRENGTH_KEY, JSON.stringify(this.scaleStrengths));
  },

  // ----- Settings: storage locations (quick 260615-e1n) -----
  // savePantrySections — persist the current ordered list to localStorage. Called
  // EXPLICITLY by every mutation handler below (NOT via Alpine $watch — $watch misses
  // nested-array mutations like push/splice/swap; lesson 260615-dap). The grouping
  // getters (shoppingSections/checkStockSections) read pantrySections reactively, so
  // a mutation re-groups the on-screen lists live.
  savePantrySections() {
    localStorage.setItem(PANTRY_SECTIONS_KEY, JSON.stringify(this.pantrySections));
  },

  // resetPantrySections — restore the 6 seed locations (fresh copy) + persist.
  resetPantrySections() {
    this.pantrySections = [...DEFAULT_PANTRY_SECTIONS];
    this.savePantrySections();
  },

  // addPantrySection(name) — append a trimmed location; ignore blank or a
  // case-sensitive duplicate already in the list.
  addPantrySection(name) {
    const s = String(name ?? '').trim();
    if (s === '' || this.pantrySections.includes(s)) return;
    this.pantrySections.push(s);
    this.savePantrySections();
  },

  // renamePantrySection(index, name) — rename in place; ignore blank or a duplicate
  // of ANOTHER entry (leave the prior value, so the bound input reverts on re-render).
  renamePantrySection(index, name) {
    const s = String(name ?? '').trim();
    if (index < 0 || index >= this.pantrySections.length) return;
    if (s === '') return;
    // duplicate of a DIFFERENT entry -> reject (a no-op rename to itself is allowed).
    const dupElsewhere = this.pantrySections.some((v, i) => i !== index && v === s);
    if (dupElsewhere) return;
    this.pantrySections[index] = s;
    this.savePantrySections();
  },

  // removePantrySection(index) — drop the entry at index.
  removePantrySection(index) {
    if (index < 0 || index >= this.pantrySections.length) return;
    this.pantrySections.splice(index, 1);
    this.savePantrySections();
  },

  // movePantrySection(index, dir) — swap with index+dir when in-bounds (reorder).
  movePantrySection(index, dir) {
    const j = index + dir;
    if (index < 0 || index >= this.pantrySections.length) return;
    if (j < 0 || j >= this.pantrySections.length) return;
    const tmp = this.pantrySections[index];
    this.pantrySections[index] = this.pantrySections[j];
    this.pantrySections[j] = tmp;
    this.savePantrySections();
  },

  // strengthByCategory — LOWERCASE-keyed [0,1] map matching scale.js
  // classifyIngredientCategory output. GETTER so a Settings edit recomputes the
  // meal plan live (scaledRowsFor reads it). Each value is clamp(0..100)/100.
  get strengthByCategory() {
    const clamp01 = pct => {
      const n = Number(pct);
      return (Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 100) / 100;
    };
    return {
      standard: clamp01(this.scaleStrengths.Standard),
      liquid: clamp01(this.scaleStrengths.Liquid),
      seasoning: clamp01(this.scaleStrengths.Seasoning),
      leavening: clamp01(this.scaleStrengths.Leavening),
      fixed: clamp01(this.scaleStrengths.Fixed)
    };
  },

  // ----- Settings: advanced overrides (SHELL-03 / D-21 / API-04 / API-06) -----
  // saveSystemPromptOverride — validate non-empty + length-sane, then persist
  // to localStorage. Empty values are refused (with a plain-language hint to
  // use "Reset this one") so we never silently swap in a 0-byte system prompt
  // and produce a broken parse. The 100k cap is a DoS guard (T-02-02-07) —
  // an accidental paste of a huge buffer shouldn't poison every Parse.
  saveSystemPromptOverride() {
    this.parseErrorDetail = '';   // quick 260618-jr7 — this banner reuses parseError; drop stale API detail
    const v = this.systemPromptOverride ?? '';
    if (!v.trim()) {
      this.parseError = 'The system prompt cannot be empty. Use "Reset this one" to restore the default.';
      return;
    }
    if (v.length > 100000) {
      this.parseError = `The system prompt is too long (${v.length} characters; the limit is 100,000). Trim it down and try Save again.`;
      return;
    }
    localStorage.setItem('recipe_ingest_system_prompt_override', v);
    this.parseError = '';
  },

  resetSystemPromptOverride() {
    this.systemPromptOverride = '';
    localStorage.removeItem('recipe_ingest_system_prompt_override');
    this.parseError = '';
  },

  // saveConversionsOverride — JSON.parse must succeed AND yield a plain object
  // (not an array, not a primitive). Empty input is treated as a reset per
  // Pitfall S so the user doesn't end up with an empty-string override that
  // shadows the bundled default. The `/` heuristic on the parse error message
  // points the user at the most-likely cause (// comments — Pitfall T).
  saveConversionsOverride() {
    this.parseErrorDetail = '';   // quick 260618-jr7 — this banner reuses parseError; drop stale API detail
    const v = this.conversionsJsonOverride ?? '';
    if (!v.trim()) {
      // Empty input → treat as reset (Pitfall S).
      this.resetConversionsOverride();
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(v);
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      // 03-REVIEW WR-10 — tighten the // comment heuristic. The previous
      // `msg.includes('/')` triggered the comment-removal advice whenever
      // the JSON.parse error message contained a slash, including unrelated
      // cases (e.g. `{"a": 1/2}` produces an error mentioning `/` as the
      // offending char). Look for the literal `//` token in the INPUT
      // — either at the start of a line or after whitespace.
      if (/^\s*\/\/|\n\s*\/\//.test(v)) {
        this.parseError = "That's not valid JSON. JSON files can't have // comments. Remove the comment line and try Save again.";
      } else {
        this.parseError = `That's not valid JSON. ${msg}`;
      }
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      this.parseError = "That's not a JSON object. Make sure it starts with { and ends with }.";
      return;
    }
    localStorage.setItem('recipe_ingest_conversions_json_override', v);
    this.parseError = '';
  },

  resetConversionsOverride() {
    this.conversionsJsonOverride = '';
    localStorage.removeItem('recipe_ingest_conversions_json_override');
    this.parseError = '';
  },

  // Phase 4 / Plan 04-05 / D-56 — save the allergen-keywords.json override.
  // Mirrors saveConversionsOverride above: empty input = RESET per Pitfall S
  // (so the user doesn't end up with an empty-string override that shadows
  // the bundled default). Validates shape: must be a JSON array of objects
  // each with `keyword: string` and `allergens: array-of-FSA14`. On success,
  // writes localStorage then re-reads back into the in-memory cache so the
  // currentAllergenKeywords getter picks up the new value WITHOUT a page
  // refresh (Pitfall R hot-reload).
  saveAllergenKeywordsOverride() {
    this.parseErrorDetail = '';   // quick 260618-jr7 — this banner reuses parseError; drop stale API detail
    const v = this.allergenKeywordsOverride ?? '';
    if (!v.trim()) {
      // Empty input → treat as reset (Pitfall S — symmetric with conversions).
      this.resetAllergenKeywordsOverride();
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(v);
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      // Same // comment heuristic as saveConversionsOverride (Pitfall T).
      if (/^\s*\/\/|\n\s*\/\//.test(v)) {
        this.parseError = "That's not valid JSON. JSON files can't have // comments. Remove the comment line and try Save again.";
      } else {
        this.parseError = `That's not valid JSON. ${msg}`;
      }
      return;
    }
    if (!Array.isArray(parsed)) {
      this.parseError = "allergen-keywords.json must be a JSON array of {keyword, allergens} entries.";
      return;
    }
    // Shape sanity: every entry must have keyword: string + allergens: array
    // of FSA-14 strings. FSA14 is already imported at the top of app.js for
    // derivedAllergens (Plan 03-02).
    for (let i = 0; i < parsed.length; i++) {
      const entry = parsed[i];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        this.parseError = `Entry ${i + 1} is not an object — each entry needs { keyword, allergens }.`;
        return;
      }
      if (typeof entry.keyword !== 'string' || !entry.keyword.trim()) {
        this.parseError = `Entry ${i + 1} is missing the "keyword" string.`;
        return;
      }
      if (!Array.isArray(entry.allergens)) {
        this.parseError = `Entry ${i + 1} ("${entry.keyword}") is missing the "allergens" array.`;
        return;
      }
      for (const a of entry.allergens) {
        if (!FSA14.includes(a)) {
          this.parseError = `Entry ${i + 1} ("${entry.keyword}") has unknown allergen "${a}" — must be one of: ${FSA14.join(', ')}.`;
          return;
        }
      }
    }
    // Stage-2 validated — persist + re-read into in-memory cache so the
    // currentAllergenKeywords getter sees the new value without a refresh.
    localStorage.setItem('recipe_ingest_allergen_keywords_override', v);
    this.allergenKeywordsOverride = localStorage.getItem('recipe_ingest_allergen_keywords_override') ?? '';
    this.parseError = '';
  },

  resetAllergenKeywordsOverride() {
    this.allergenKeywordsOverride = '';
    localStorage.removeItem('recipe_ingest_allergen_keywords_override');
    this.parseError = '';
  },

  // resetAllToDefault — D-21 explicitly preserves the API key and the model
  // dropdown. Only the prompt + conversions overrides are wiped. The native
  // window.confirm prompt matches the user's expectation that "reset all" is
  // a recoverable but destructive-to-tinkering action.
  resetAllToDefault() {
    if (!confirm('Reset the system prompt and conversions to their defaults? Your API key and model selection are not affected.')) {
      return;
    }
    this.resetSystemPromptOverride();
    this.resetConversionsOverride();
  },

  // ----- Pre-Parse cost estimate (API-07 / Plan 02-04) -----
  /**
   * Ask Anthropic's count_tokens endpoint how big the impending Parse will
   * be. Called from the textarea @blur and from the Settings model dropdown
   * @change. Builds the SAME prompt shape parse() will send (system + user
   * messages + output_config schema) so the count is accurate to within
   * ~4 tokens (salt variability — Pitfall N / T-02-04-10).
   *
   * Early-exits with tokenEstimate=null when any Parse precondition is
   * missing (no rawText, no apiKey, no loaded store) so we never waste an
   * API call where the Parse button itself would be :disabled.
   *
   * Silent-fail (Pitfall L): if count_tokens errors, estimateParseCost
   * returns null, we assign null to tokenEstimate, and the small grey
   * element in the template hides via x-show. The user sees nothing where
   * the estimate would appear; parseError stays untouched.
   *
   * Not wrapped in a loading flag: the call is sub-second and the user is
   * not visibly waiting. A spinner would add noise for no UX gain.
   */
  async estimateTokenCost() {
    // Mirror the Parse-button preconditions. If any are missing, clear
    // any stale estimate and return — no point counting tokens for a
    // Parse the user cannot click.
    if (!this.rawText.trim() || !this.apiKey || !this.csvStoreLoaded) {
      this.tokenEstimate = null;
      return;
    }

    // Build the SAME shape parse() will use. Fresh salt per estimate call
    // (per-request randomness; 0–4 token variability across estimate→Parse
    // is well below user-perceivable accuracy per Pitfall N).
    const salt = generateSalt();
    const userMessage = buildUserMessage(this.rawText, salt);
    // Dedupe masterIds (defense-in-depth — loadLiveCsvs already skips
    // blanks; D-26 / Plan 02-01 carry-forward).
    const masterIds = [...new Set(this.ingredientMaster.map(m => m.ingredient_id))];
    const schema = buildRecipeSchema(masterIds);
    // Same getters parse() uses (Pitfall R override-read-timing): an
    // in-session settings save is reflected in the next estimate.
    const systemPrompt = buildSystemPrompt(
      this.currentSystemPrompt,
      this.ingredientMaster,
      this.currentConversions,
      salt
    );

    // estimateParseCost returns null on any error (silent-fail per
    // Pitfall L). When null, the small grey estimate hides via x-show.
    this.tokenEstimate = await estimateParseCost({
      apiKey: this.apiKey,
      model: this.selectedModel,
      systemPrompt,
      userMessage,
      schema
    });
  },

  /**
   * Format a USD amount as a human-readable cost label INCLUDING the trailing
   * " to parse" suffix. The HTML template binds `x-text="formatCost(tokenEstimate.usd)"`
   * and appends NOTHING — this helper owns the entire visible string (W4
   * review decision: helper-owns-full-string keeps the suffix in one place).
   *
   * Sub-dollar amounts read as "about Nc to parse" (N = cents rounded to
   * nearest integer). Dollar-scale amounts read as "≈ $X.XX to parse" with
   * two-decimal precision via .toFixed(2). The threshold ($0.10) matches
   * RESEARCH §4 line 1446 — "tiny amounts in cents, larger amounts in dollars".
   *
   * @param {number} usd
   * @returns {string}
   */
  formatCost(usd) {
    if (typeof usd !== 'number' || !isFinite(usd)) return '';
    if (usd < 0.10) {
      const cents = Math.round(usd * 100);
      return `about ${cents}¢ to parse`;
    }
    return `≈ $${usd.toFixed(2)} to parse`;
  },

  // ----- quick 260608-h1i — duplicate-index builder (READ-ONLY) -----
  /**
   * Build the read-only duplicate index from recipes.csv + recipe_ingredients.csv.
   *
   * READ-ONLY CONTRACT: this method NEVER writes or deletes any CSV — it only
   * calls readCsvFromHandle. GRACEFUL DEGRADATION: any failure (no folder,
   * missing/malformed file) sets this.duplicateIndex = null so the feature
   * silently no-ops; it never sets parseError, never rethrows, and must never
   * break folder-pick (mirrors the pendingDeltas non-fatal seed in pickCsvFolder).
   */
  async buildDuplicateIndex() {
    try {
      const recipes = await getFile('recipes.csv');
      const joins = await getFile('recipe_ingredients.csv');
      // quick 260612-abt — store-backed: fail-open if either file is absent
      // (first-run before import) so the duplicate nudge simply stays dormant.
      if (!recipes || !joins) {
        this.duplicateIndex = null;
        return;
      }

      // recipeNameList — coerce recipe_id to int (mirror loadLiveCsvs ~303-308),
      // keep only finite ids with a non-empty name.
      const recipeNameList = [];
      for (const r of recipes.rows) {
        const rid = parseInt(r.recipe_id, 10);
        const name = (r.name ?? '').trim();
        if (Number.isFinite(rid) && name !== '') {
          recipeNameList.push({ recipe_id: rid, name });
        }
      }

      // ingredientIdsByRecipeId — Map<recipe_id, Set<ingredient_id>>; both
      // coerced + finite-checked (PapaParse hands back strings).
      const ingredientIdsByRecipeId = new Map();
      for (const j of joins.rows) {
        const rid = parseInt(j.recipe_id, 10);
        const iid = parseInt(j.ingredient_id, 10);
        if (!Number.isFinite(rid) || !Number.isFinite(iid)) continue;
        let set = ingredientIdsByRecipeId.get(rid);
        if (!set) { set = new Set(); ingredientIdsByRecipeId.set(rid, set); }
        set.add(iid);
      }

      const recipeNameFuse = new Fuse(recipeNameList, DUP_NAME_FUSE_OPTIONS);
      this.duplicateIndex = { recipeNameFuse, recipeNameList, ingredientIdsByRecipeId };
    } catch (_e) {
      // Degrade silently — no banner, no parseError, no rethrow. A build
      // failure must never break folder-pick (mirrors pendingDeltas seed).
      this.duplicateIndex = null;
    }
  },

  // ----- Phase 4 / Plan 04-02 — Fuse + unknown-modal handlers -----
  /**
   * Build the Fuse instance over ingredientMaster. Idempotent — overwriting
   * this.fuse is fine (Fuse's constructor builds an internal index from the
   * provided collection; the previous instance is GC'd). Called from
   * pickCsvFolder after master load; also called by refreshFuse() as the
   * fallback when no instance exists yet.
   */
  initFuse() {
    this.fuse = new Fuse(this.ingredientMaster, FUSE_OPTIONS);
  },

  /**
   * Refresh the Fuse instance after a master mutation (Plan 04-04's Add-new
   * push). Per RESEARCH Pitfall 2 — Fuse's internal index is built at
   * construction time; pushing to ingredientMaster does NOT update the
   * index. setCollection() is the documented Fuse 7.3 API for swapping the
   * underlying array (verified via fusejs.io/api/methods.html#setcollection).
   * Falls through to initFuse() if no instance exists yet (defensive).
   */
  refreshFuse() {
    if (this.fuse) {
      this.fuse.setCollection(this.ingredientMaster);
    } else {
      this.initFuse();
    }
  },

  /**
   * Open the unknown-ingredient modal for a specific queue card. Sets the
   * current key (drives currentUnknown getter + modal x-show), resets
   * addNewMode to false (default state = top-3 + actions), and clears
   * addNewFormState so a fresh modal always starts with empty fields.
   * Then schedules a focus on the first interactive button via $nextTick —
   * matches the restore-prompt modal's focus pattern at index.html L685.
   *
   * @param {number} rowKey — the queue card's _key (matches row._key)
   */
  openUnknownModal(rowKey) {
    this.currentUnknownKey = rowKey;
    this.addNewMode = false;
    this.addNewFormState = { name: '', allergens: [], pack_size: null, pack_unit: '', shopping_unit: 'metric' };
    this.shoppingUnitTouched = false;
    this.$nextTick(() => {
      const focusTarget = document.querySelector(
        '.modal-content-wide .use-match-btn, .modal-content-wide .add-new-btn'
      );
      if (focusTarget) focusTarget.focus();
    });
  },

  /**
   * Close the unknown modal as a no-op. Used by Esc-key handler and by
   * useMatch / skipAsFreeform / submitAddNew after their respective
   * resolution. The card stays in the queue if this is a no-op close (the
   * resolution paths remove the card before calling closeUnknownModal).
   * Always resets addNewMode + addNewFormState so a re-open of the same
   * card starts fresh.
   */
  closeUnknownModal() {
    this.currentUnknownKey = null;
    this.addNewMode = false;
    this.addNewFormState = { name: '', allergens: [], pack_size: null, pack_unit: '', shopping_unit: 'metric' };
    this.shoppingUnitTouched = false;
    // quick 260607-qic — null the shared target so a stale key cannot leak into
    // a later combobox-path open (which reads addNewTargetKey, not currentUnknownKey).
    this.addNewTargetKey = null;
  },

  /**
   * UNKNOWN-04 partial wiring — Use this match. Sets the row's ingredient_id
   * to the chosen master id, removes the card from the queue, closes the
   * modal, and transitions to REVIEWING if the queue is now empty. Per
   * RESEARCH Pitfall 4, the form is NOT rendered during RESOLVING, so the
   * 260525-bk3 ingredient_id race is not present here — no $nextTick +
   * x-effect deferred resync is needed.
   *
   * @param {number} masterId — ingredient_id from the chosen Fuse hit
   *                            (hit.item.ingredient_id, already numeric)
   */
  useMatch(masterId) {
    // Defensive: if the modal was closed mid-click somehow, bail.
    const key = this.currentUnknownKey;
    if (key == null) return;
    const row = this.form.rows.find(r => r._key === key);
    // Defensive: a stale click on a removed row (shouldn't happen — the
    // queue + form.rows share the same _key namespace) is a no-op.
    if (!row) return;

    row.ingredient_id = masterId;
    // Reactivity tick batches: chip list re-derives once at end-of-tick
    // (Phase 3 D-37/D-41); no animation; instant.
    this.unknownQueue = this.unknownQueue.filter(c => c._key !== key);
    this.closeUnknownModal();

    if (this.unknownQueue.length === 0) {
      this.transition(STATES.REVIEWING);
    }
  },

  /**
   * UNKNOWN-04 / D-52 — Skip as freeform. Sets the row's flag_fix_me=TRUE
   * (the auditable signal that the user chose Skip — the existing per-row
   * checkbox will show ticked once the form renders), removes the card from
   * the queue, closes the modal, and transitions to REVIEWING if the queue
   * is now empty.
   *
   * D-52: Skip-as-freeform sets flag_fix_me=true, removes card from queue,
   * no flagged_fields push. row.ingredient_id stays null; row.raw_text stays
   * verbatim. The Phase 3 cap-3 "Needs full review" pill + the existing
   * flag_fix_me checkbox carry the user-visible reminder — no separate
   * "skipped" annotation per D-52 / D-58/D-59 (Skip path is row-level
   * flag_fix_me only, NOT a flagged_fields push). Per RESEARCH Pitfall 4,
   * the form is NOT rendered during RESOLVING, so the 260525-bk3 ingredient_id
   * race surface is absent — no $nextTick + x-effect deferred resync is needed.
   */
  skipAsFreeform() {
    // Defensive: if the modal was closed mid-click somehow, bail (closing
    // the modal first so it does not stay open in an inconsistent state).
    const key = this.currentUnknownKey;
    if (key == null) {
      this.closeUnknownModal();
      return;
    }
    const row = this.form.rows.find(r => r._key === key);
    // Defensive: a stale click on a removed row (shouldn't happen — the
    // queue + form.rows share the same _key namespace) closes the modal
    // and returns rather than mutating an unrelated row.
    if (!row) {
      this.closeUnknownModal();
      return;
    }

    row.flag_fix_me = true;
    // Reactivity tick batches: chip list, queue panel, and Approve :disabled
    // all re-derive in one pass.
    this.unknownQueue = this.unknownQueue.filter(c => c._key !== key);
    this.closeUnknownModal();

    if (this.unknownQueue.length === 0) {
      this.transition(STATES.REVIEWING);
    }
  },

  /**
   * UNKNOWN-05 / D-51 — Enter the Add-new sub-form (inline modal expansion).
   *
   * Resets addNewFormState with FSA-14 allergens pre-ticked from the current
   * unknown's `suggested_allergens` (D-48 / RESEARCH Pitfall 8 defensive
   * guard — Array.isArray(...) covers null AND missing-property). Schedules
   * focus on the name input via $nextTick so keyboard users land in the
   * primary editable field on expansion. Clears any pending validation
   * error from a previous open.
   */
  enterAddNewMode() {
    this.addNewMode = true;
    // quick 260607-qic — the queue path targets the open card. submitAddNew now
    // reads addNewTargetKey (not currentUnknownKey) so both entry points share
    // one field; here we point it at the currently-open queue card.
    this.addNewTargetKey = this.currentUnknownKey;
    const pretick = Array.isArray(this.currentUnknown?.suggested_allergens)
      ? this.currentUnknown.suggested_allergens
      : [];
    this.addNewFormState = {
      name: '',
      allergens: [...pretick],
      pack_size: null,
      pack_unit: '',
      // quick 260607-c65 — default 'metric' (CONTEXT user-lock). The optional
      // LLM pre-suggestion fires on name blur/change (suggestShoppingUnit) and
      // only applies while shoppingUnitTouched is false.
      shopping_unit: 'metric'
    };
    this.shoppingUnitTouched = false;
    this.addNewFormError = '';
    // quick 260627-pfu — baseline the dirty guard after the Add-new sub-form is reset
    // (queue path). The pre-ticked allergens are part of the baseline, so only further
    // typed edits make it dirty.
    this.snapshotEditModal('unknownAddNew');
    this.$nextTick(() => {
      const input = document.querySelector('.modal-content-wide .add-new-name-input');
      if (input) input.focus();
    });
  },

  /**
   * UNKNOWN-05 / D-51 — Collapse the Add-new sub-form back to the modal
   * default state ("Back to matches"). Same unknown stays open
   * (currentUnknownKey preserved); only the sub-form fields are cleared.
   */
  exitAddNewMode() {
    this.addNewMode = false;
    this.addNewFormState = { name: '', allergens: [], pack_size: null, pack_unit: '', shopping_unit: 'metric' };
    this.shoppingUnitTouched = false;
    this.addNewFormError = '';
    // quick 260607-qic — null the shared target on collapse so a stale key
    // cannot leak across opens.
    this.addNewTargetKey = null;
  },

  /**
   * quick 260607-qic — Combobox / live-row entry point into the Add-new
   * sub-form. Opens the SAME sub-form the unknown queue uses, but targeting a
   * live review row instead of a queue card — for the "LLM mis-matched this row
   * to a real ingredient, so it never entered the unknown queue" case (the
   * Orange-Zest-as-Lemon-Zest defect). Pre-fills the name with the user's typed
   * combobox query and pre-ticks allergens from THIS row's suggested_allergens.
   *
   * Crucially this does NOT enter the queue modal: currentUnknownKey stays
   * null. The modal scaffold still renders because index.html's outer modal
   * x-show also fires on (addNewMode && addNewTargetKey !== null). submitAddNew
   * then sees the key is NOT in unknownQueue and takes the live-row branch
   * (skip cascade + skip transition; we are already in REVIEWING).
   *
   * @param {number} rowKey      — the live row._key the new ingredient targets
   * @param {string} prefillName — the typed combobox query (trimmed for the name)
   */
  openAddNewForRow(rowKey, prefillName) {
    this.addNewTargetKey = rowKey;
    this.currentUnknownKey = null;   // live-row path — NOT the queue modal
    this.addNewMode = true;
    const row = (this.form?.rows || []).find(r => r._key === rowKey);
    // D-48 / RESEARCH Pitfall 8 guard — Array.isArray covers null AND missing.
    const pretick = Array.isArray(row?.suggested_allergens) ? row.suggested_allergens : [];
    this.addNewFormState = {
      name: (prefillName || '').trim(),
      allergens: [...pretick],
      pack_size: null,
      pack_unit: '',
      shopping_unit: 'metric'
    };
    this.shoppingUnitTouched = false;
    this.addNewFormError = '';
    // Close the originating row's combobox dropdown so it doesn't stay open
    // behind the modal.
    const st = this.comboboxStateFor(rowKey);
    st.open = false;
    st.activeIndex = 0;
    // quick 260627-pfu — baseline the dirty guard after the Add-new sub-form is reset
    // (live-row path). The prefilled name + pre-ticked allergens are part of the
    // baseline, so only further typed edits make it dirty.
    this.snapshotEditModal('unknownAddNew');
    this.$nextTick(() => {
      const input = document.querySelector('.modal-content-wide .add-new-name-input');
      if (input) input.focus();
    });
  },

  /**
   * quick 260607-qic — Close the Add-new sub-form for the LIVE-ROW path WITHOUT
   * touching currentUnknownKey. Used by the combobox path's Cancel/escape and
   * by submitAddNew's live-row branch. Deliberately does NOT null
   * currentUnknownKey (it is already null on this path) so it can never falsely
   * dismiss an open queue card. Mirrors exitAddNewMode's field reset + also
   * clears addNewTargetKey.
   */
  closeAddNewForm() {
    this.addNewMode = false;
    this.addNewFormState = { name: '', allergens: [], pack_size: null, pack_unit: '', shopping_unit: 'metric' };
    this.shoppingUnitTouched = false;
    this.addNewFormError = '';
    this.addNewTargetKey = null;
  },

  /**
   * quick 260607-c65 — optional, FAIL-OPEN LLM pre-suggestion for the Add-new
   * shopping_unit selector.
   *
   * DESIGN DECISION: the allergen pre-suggestion is a PARSE-time schema field
   * (`suggested_allergens`); the parse prompt + parse schema are LOCKED-untouched
   * and at the Anthropic 16-anyOf cap (schema.js Pitfall J), so shopping_unit
   * CANNOT ride the parse path. Instead this is a tiny, dedicated, one-field
   * Structured-Outputs sub-call fired when the user types the ingredient name.
   *
   * Fail-open: returns 'metric' on ANY error / missing key and NEVER blocks or
   * errors the add-new flow. No console logging of the key or stack (count.js
   * T-02-03 precedent — even console.error could leak the apiKey via a stack).
   *
   * suggestAndApplyShoppingUnit() is the UI entry point (name blur/change): it
   * only applies the suggestion when the user has not manually changed the
   * selector this session (shoppingUnitTouched), keeping the manual choice
   * authoritative (default-metric lock honored; suggestion is advisory).
   *
   * @param {string} ingredientName
   * @returns {Promise<'metric'|'whole'>}
   */
  async suggestShoppingUnit(ingredientName) {
    const name = (ingredientName || '').trim();
    if (!name || !this.apiKey) return 'metric';
    try {
      const { parsed } = await callLLM({
        apiKey: this.apiKey,
        model: this.selectedModel,
        systemPrompt:
          'Given a grocery ingredient name, answer whether it is typically bought ' +
          'by metric weight/volume (metric) or as whole countable units (whole). ' +
          'Eggs, onions, tins, lemons, peppers → whole. Flour, milk, oil, sugar → metric. ' +
          'Reply with only the shopping_unit field.',
        userMessage: name,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['shopping_unit'],
          properties: {
            shopping_unit: { type: 'string', enum: ['metric', 'whole'] }
          }
        }
      });
      const v = parsed && parsed.shopping_unit;
      return v === 'whole' || v === 'metric' ? v : 'metric';
    } catch (_e) {
      // Fail-open — never surface an error or touch parseError; the selector
      // simply stays at its current value. No logging (apiKey-leak guard).
      return 'metric';
    }
  },

  /**
   * quick 260607-c65 — UI hook for the name input's blur/change. Fires the
   * fail-open pre-suggestion and applies it ONLY if the user has not manually
   * touched the selector this session. Awaits the async race safely: if the
   * user touches the selector while the call is in flight, the result is
   * discarded (shoppingUnitTouched re-checked after await).
   */
  async suggestAndApplyShoppingUnit() {
    if (this.shoppingUnitTouched) return;
    const name = (this.addNewFormState.name || '').trim();
    if (!name) return;
    const suggested = await this.suggestShoppingUnit(name);
    // Re-check after the await — the user may have picked a value meanwhile.
    if (!this.shoppingUnitTouched && this.addNewMode) {
      this.addNewFormState.shopping_unit = suggested;
    }
  },

  // ==========================================================================
  // quick 260607-qbj — Ingredient Master Manager actions.
  // openManager/closeManager toggle the top-level view (parse state survives via
  // x-show). filteredMaster reuses the loaded Fuse instance. start/cancel/save
  // EditIngredient + addFromManager/submitManagerAdd are the browse-edit-add
  // surface; both writes funnel through the ONE shared _rewriteIngredientsInPlace
  // data-safety chain. reloadMasterFromDisk re-derives the master + rebuilds Fuse
  // after every write so the parse view reflects manager changes immediately.
  // ==========================================================================

  /**
   * Manager-scoped fail-open shopping_unit pre-suggestion (mirrors
   * suggestAndApplyShoppingUnit but bound to managerAddForm + managerShoppingUnitTouched).
   */
  async suggestAndApplyManagerShoppingUnit() {
    if (this.managerShoppingUnitTouched) return;
    const name = (this.managerAddForm.name || '').trim();
    if (!name) return;
    const suggested = await this.suggestShoppingUnit(name);
    if (!this.managerShoppingUnitTouched && this.managerAddMode) {
      this.managerAddForm.shopping_unit = suggested;
    }
  },

  /**
   * Toggle INTO the manager view. Does NOT reset parse/form state (x-show keeps
   * in-progress parse work alive underneath). Clears only manager-local transient
   * state so a fresh open starts clean.
   */
  // quick 260615-nx6 (NAV-HAMBURGER-DRAWER) — thin navigation dispatcher for the
  // four drawer items. Closes the drawer, then delegates to the EXISTING open*
  // methods (which already enforce four-way view mutual-exclusion) — it does NOT
  // duplicate that logic. 'settings' opens the Settings modal by setting the flag
  // directly (the same no-stacking-respecting path the no-API-key auto-open uses;
  // anyModalOpen excludes settingsOpen by design). async because the recipe/meal
  // openers read the store fresh and are async.
  async goToView(name) {
    this.drawerOpen = false;
    if (name === 'mealPlan') {
      await this.openMealPlan();
    } else if (name === 'ingredients') {
      this.openManager();
    } else if (name === 'recipes') {
      await this.openRecipeManager();
    } else if (name === 'residents') {
      this.openResidents();
    } else if (name === 'settings') {
      this.apiKeyDraft = this.apiKey;
      // Phase 07 — seed the four Coda drafts from their persisted fields. This is
      // LOAD-BEARING: persistence is on the Save button (not @change), so without
      // re-seeding here reopening Settings would show stale blanks, not the
      // persisted values.
      this.codaApiTokenDraft = this.codaApiToken;
      this.codaExportDocIdDraft = this.codaExportDocId;
      this.codaResidencyTableIdDraft = this.codaResidencyTableId;
      this.codaOnboardingTableIdDraft = this.codaOnboardingTableId;
      // Phase 10 — seed the four github connection drafts from their persisted
      // fields (LOAD-BEARING, same reason as the Coda drafts: persistence is the
      // Save button, so without re-seeding reopening Settings shows stale blanks
      // instead of the connected values). Clear any stale inline error on open.
      this.githubOwnerDraft = this.githubOwner;
      this.githubRepoDraft = this.githubRepo;
      this.githubBranchDraft = this.githubBranch;
      this.githubTokenDraft = this.githubToken;
      // Phase 11 (D-06) — seed the "Your name" draft from the persisted field.
      // LOAD-BEARING (same reason as the github drafts: persistence is the Save
      // button, so without re-seeding reopening Settings shows a stale blank).
      this.userNameDraft = this.userName;
      this.connectionError = '';
      // quick 260620-rm6 — seed the three suggested-servings drafts as STRINGS from
      // their persisted numeric fields. LOAD-BEARING (mirrors the coda drafts):
      // persistence is the Save button, so without this reopening Settings would
      // show stale blanks instead of the saved multipliers.
      this.servingsPerResidentMainDraft = String(this.servingsPerResidentMain);
      this.servingsPerResidentSideDraft = String(this.servingsPerResidentSide);
      this.servingsPerResidentSaladDraft = String(this.servingsPerResidentSalad);
      this.settingsOpen = true;
    }
  },

  openManager() {
    // Phase 17 (Plan 17-02, D-05) — leaving the meal-plan view flushes any pending
    // debounced push so an un-synced edit is never stranded.
    if (this.mealPlanView) this._flushPlanPush();
    // quick 260608-bd5 — three-way mutual exclusion: opening this view clears the
    // other two so only one top-level view is ever visible.
    this.recipeManagerView = false;
    this.mealPlanView = false; // quick 260611-enp — four-way mutual exclusion
    this.residentsView = false; // Plan 07-03 — five-way mutual exclusion
    this.managerView = true;
    this.managerError = '';
    this.managerNotice = '';
    this.editingIngredientId = null;
    this.managerAddMode = false;
  },

  /**
   * openResidents — Plan 07-03. Enter the FIFTH top-level view (residents-present
   * panel). Mutually exclusive with the other four — clears them and sets
   * residentsView. Does NOT perform any network fetch (the live fetch is behind
   * the explicit "Fetch / refresh roster" button); the panel renders from the
   * cached joinedRoster already loaded non-fatally on boot. Data-isolated: touches
   * only the roster/residents slice, never the recipe csvStore state.
   */
  openResidents() {
    if (this.mealPlanView) this._flushPlanPush(); // Phase 17 (D-05) flush-on-close
    this.managerView = false;
    this.recipeManagerView = false;
    this.mealPlanView = false;
    this.residentsView = true;
  },

  /** Toggle back to Parse view. Parse/form state is untouched. */
  closeManager() {
    this.managerView = false;
  },

  /**
   * canEditIngredient — quick 260612-k86. True iff the id is an integer AND
   * present in the in-memory master. The meal-plan markup uses this to decide
   * whether to render a clickable link (vs plain text), so "looks like a link"
   * exactly matches "clicking navigates" (no dead links for unmatched ids).
   */
  canEditIngredient(ingredient_id) {
    return Number.isInteger(ingredient_id)
      && this.ingredientMaster.some(m => m.ingredient_id === ingredient_id);
  },

  /**
   * openEditIngredient — quick 260614-fo7. The single, view-independent opener for
   * the edit-ingredient MODAL. Used from the manager Edit button, meal-plan
   * ingredient links, the combined shopping list, and the check-stock list.
   * Deliberately does NOT navigate (no openManager, no view switch, no
   * back-button flag, no scrollIntoView): startEditIngredient is view-independent
   * and the edit form now lives in a top-level overlay driven by
   * editingIngredientId !== null, so simply setting editingIngredientId opens the
   * modal over whatever view is current. Replaces the old
   * editIngredientFromMealPlan navigation path for INGREDIENT clicks.
   */
  async openEditIngredient(ingredient_id) {
    // GUARD: only a matched ingredient opens (same predicate as the link markup).
    if (!this.canEditIngredient(ingredient_id)) return;
    // startEditIngredient owns its own failure paths (sets managerError + returns
    // on read-error / old-schema / not-found) — do not duplicate its guards.
    await this.startEditIngredient(ingredient_id);
  },

  /**
   * hasShoppingLink — quick 260625-cg8. True iff the id is a matched master
   * ingredient (canEditIngredient) AND that row carries a non-empty link1
   * (1st_link). The combined-shopping markup uses this to decide whether to
   * render a clickable buy-link (vs plain text), so "looks like a link" exactly
   * matches "clicking opens a link" (no dead links for unmatched / link-less ids).
   */
  hasShoppingLink(ingredient_id) {
    if (!this.canEditIngredient(ingredient_id)) return false;
    const row = this.ingredientMaster.find(m => m.ingredient_id === ingredient_id);
    return !!(row && typeof row.link1 === 'string' && row.link1 !== '');
  },

  /**
   * openShoppingLink — quick 260625-cg8. The combined-shopping name-click opener.
   * GUARD: only a matched ingredient WITH a non-empty link1 opens (hasShoppingLink).
   * Opens the buy URL in a new tab; deliberately view-independent (no navigation,
   * no view switch, no async) — mirrors openEditIngredient. Replaces the edit-modal
   * open for combined-Shopping name-clicks (edit moved to the Ingredient Manager).
   */
  openShoppingLink(ingredient_id) {
    if (!this.hasShoppingLink(ingredient_id)) return;
    const row = this.ingredientMaster.find(m => m.ingredient_id === ingredient_id);
    window.open(row.link1, '_blank', 'noopener');
  },

  /**
   * openEditRecipe — quick 260614-od7. The single, view-independent opener for the
   * recipe-edit MODAL. Used from BOTH the Manage-Recipes browse list (row + Edit
   * button) AND the meal-plan recipe-title click-through. Mirrors openEditIngredient,
   * but with the SHARED-this.form snapshot that the recipe editor requires.
   *
   * #1-RISK ordering: SNAPSHOT the current parse form (header + rows, by reference)
   * BEFORE loading the recipe — openRecipeForEdit clobbers this.form in place, so the
   * snapshot MUST be taken first to capture in-progress parse work. closeEditRecipe is
   * the single owner of the restore. No view switch, no scrollIntoView: the modal
   * (x-show editingRecipeId !== null && form.header) opens over whatever view is live.
   *
   * openRecipeForEdit owns its own read-error / not-found / old-schema failure paths
   * (sets recipeManagerError and returns WITHOUT setting editingRecipeId — so the
   * modal won't open). On that failure a backup is set but this.form was never
   * clobbered; the by-reference snapshot costs nothing and the next open overwrites it
   * (closeEditRecipe nulls it).
   */
  async openEditRecipe(recipe_id) {
    if (!Number.isInteger(recipe_id)) return;
    this._recipeEditFormBackup = { header: this.form.header, rows: this.form.rows };
    await this.openRecipeForEdit(recipe_id);
    // Phase 12 (LOCK-01, D-02) — acquire-on-open (existing-record edit). Guard on a
    // successful open (openRecipeForEdit sets editingRecipeId only on success, so a
    // read-error/not-found open never acquires). _acquireLockForEditorOpen does the
    // refreshPresence + conditional acquireLock.
    if (this.editingRecipeId === recipe_id) {
      await this._acquireLockForEditorOpen(); // refreshPresence + acquireLock (D-02/D-03)
      // quick 260627-pfu — baseline the dirty guard only on a successful open (the
      // form is now populated; a read-error open never set editingRecipeId).
      this.snapshotEditModal('recipe');
    }
    // Contrast the parse/Add flow: append-only, so it acquires ONLY at Approve —
    // holding the global lock through a long review would freeze the team (Pitfall 4).
    // The 'new' sentinel (openAddRecipe) deliberately does NOT route through here.
  },

  /**
   * isAddingRecipe — quick 260621-bhx. Readable discriminator for the manual
   * "Add recipe" flow. We REUSE the existing edit-recipe modal verbatim by
   * setting editingRecipeId to the string sentinel 'new' (the modal's
   * visibility binding is already `editingRecipeId !== null`, so the sentinel
   * shows the modal with ZERO markup forks). Templates/guards read this getter
   * instead of comparing against the raw sentinel.
   */
  get isAddingRecipe() {
    return this.editingRecipeId === 'new';
  },

  /**
   * openAddRecipe — quick 260621-bhx. Open the EXISTING edit-recipe modal blank
   * for a brand-new recipe: empty header, one starter ingredient row, and a
   * suggested next recipe_id. Mirrors openEditRecipe's snapshot discipline so
   * Cancel/Escape → closeEditRecipe restores the shared this.form unchanged
   * (closeEditRecipe just nulls editingRecipeId, so the 'new' sentinel tears
   * down identically to an integer id).
   *
   * FAIL-CLOSED: if recipes.csv can't be re-read we cannot allocate a
   * collision-safe id, so we surface recipeManagerError and DO NOT open — never
   * open a modal that can't allocate a safe id. (Write-time re-validation in
   * saveNewRecipe is the real collision guard; this open-time id is only a
   * suggestion for display.)
   */
  async openAddRecipe() {
    if (this.approving || this.merging) return;
    this.recipeManagerError = '';
    this.recipeManagerNotice = '';

    // Snapshot the SHARED form the same way openEditRecipe does (by reference —
    // closeEditRecipe restores it).
    this._recipeEditFormBackup = { header: this.form.header, rows: this.form.rows };

    // Re-read recipes.csv fresh to suggest the id (maxOnDisk + 1, mirroring
    // recomputeRecipeId). On read failure, fail closed.
    let recipes;
    try {
      recipes = await getFile('recipes.csv');
    } catch (_e) {
      this._recipeEditFormBackup = null;
      this.recipeManagerError = "Couldn't read your recipe files, so the new-recipe form wasn't opened. Try Pick CSV folder again.";
      return;
    }
    const diskIds = recipes.rows
      .map(r => parseInt(r.recipe_id, 10))
      .filter(n => Number.isFinite(n));
    const maxOnDisk = Math.max(0, ...diskIds);
    this.recipeIdSuggestion = maxOnDisk + 1;
    // Keep session bookkeeping consistent with disk (mirrors approve()'s
    // Math.max guard — never rewind the session counter).
    this.maxRecipeIdAtSessionStart = Math.max(this.maxRecipeIdAtSessionStart, maxOnDisk);

    // Blank header mirroring openRecipeForEdit's full shape (app.js header
    // build): string fields '', numeric fields null, allergens [].
    this.form.header = {
      name: '',
      main_side_salad: '',
      prep: '',
      instructions_20: '',
      ingredients_20: '',
      // source is v.nullable(v.url()) — an EMPTY string ('') fails the URL
      // check and hard-errors, but null (= "no source") passes. The edit flow
      // tolerates '' only because it renders-not-blocks (D-20); since the new
      // path BLOCKS on hardErrors, we MUST seed null so an optional/absent
      // source doesn't falsely block the add. toHeaderCsvRow serializes
      // (source ?? '') → still writes a blank cell to disk.
      source: null,
      max_servings: null,
      popularity: null,
      difficulty: null,
      last_made: '',
      serve_with: '',
      popularity_notes: '',
      difficulty_notes: '',
      allergens: [],
      // review_flags is a REQUIRED array in the validator (v.array(...)) — the
      // parse flow always supplies it; omitting it makes validateRecipe hard-
      // error "Expected review_flags but received undefined", which would block
      // the add. It is ephemeral (never serialized by toHeaderCsvRow), so seed
      // [] purely to satisfy the schema shape.
      review_flags: []
    };
    // ONE starter row. blankRow() reads form.rows for next line_order, so reset
    // rows to [] first (the snapshot above already captured the prior rows).
    this.form.rows = [];
    this.form.rows = [blankRow(this.form)];

    this.validationWarnings = [];
    this.validationErrors = [];
    this.recipeDeleteConfirmText = '';

    // LAST — set the sentinel, which opens the modal.
    this.editingRecipeId = 'new';
    // quick 260627-pfu — baseline the dirty guard after the blank form is assigned
    // (a backdrop click on an untouched Add-recipe form closes immediately).
    this.snapshotEditModal('recipe');
  },

  /**
   * closeEditRecipe — quick 260614-od7. SINGLE owner of the recipe-edit modal
   * teardown: restore the parse snapshot into the SHARED this.form, then null the
   * editing id, clear the delete-confirm text, and null the backup. Called from
   * Cancel/Escape AND (via delegation) from the saveRecipeEdit/deleteRecipe success
   * paths — exactly ONE restore per modal session (no double-restore, no stale
   * backup). MUST NOT clear recipeManagerNotice/recipeManagerError: save/delete set
   * the "Saved/Deleted ✓" notice BEFORE calling this, and it must survive the close.
   */
  closeEditRecipe() {
    if (this._recipeEditFormBackup) {
      this.form.header = this._recipeEditFormBackup.header;
      this.form.rows = this._recipeEditFormBackup.rows;
    }
    this.editingRecipeId = null;
    this.recipeDeleteConfirmText = '';
    this._recipeEditFormBackup = null;
    // Phase 12 (LOCK-01, D-05) — RELEASE on close (the SINGLE teardown owner;
    // Cancel/Escape + save/delete success all funnel here). Fire-and-forget;
    // releaseLock no-ops when heldLock is null and swallows its own errors.
    this.releaseLock();
  },

  /**
   * quick 260627-pfu — backdrop-close dirty guard (DRY, ONE mechanism for all
   * edit modals; CLAUDE.md "no duplicated load-bearing markup" applies to JS too).
   *
   * _dirtyTargets — single source of truth mapping each edit-modal `which` to its
   * live bound working object. Adding a future edit modal is a one-line change here.
   * NOTE: the unknown modal's typed surface is addNewFormState (the Add-new sub-form
   * the queue + live-row paths both bind), NOT managerAddForm (which is the separate
   * Manage-Ingredients add form, not a .modal). The default top-3/resolve state of the
   * unknown modal binds an effectively-empty addNewFormState → never dirty → closes
   * immediately, which is the intended behavior.
   */
  _dirtyTargets() {
    return {
      recipe: { header: this.form?.header, rows: this.form?.rows },
      ingredient: this.editForm,
      resident: this.residentEditForm,
      unknownAddNew: this.addNewFormState
    };
  },

  /**
   * snapshotEditModal — capture the at-open JSON baseline for `which`. Called at the
   * END of each opener AFTER the working object is fully assigned.
   */
  snapshotEditModal(which) {
    this._dirtySnapshot[which] = JSON.stringify(this._dirtyTargets()[which] ?? null);
  },

  /**
   * editModalIsDirty — true iff the live bound object differs from its at-open
   * baseline. Fail-safe: a missing baseline (never snapshotted) is NOT dirty, so a
   * close is never blocked on an absent snapshot.
   */
  editModalIsDirty(which) {
    if (this._dirtySnapshot[which] === undefined) return false;
    return JSON.stringify(this._dirtyTargets()[which] ?? null) !== this._dirtySnapshot[which];
  },

  /**
   * requestCloseEditModal — backdrop/Escape close router for edit modals. If the
   * modal is dirty, pop a native window.confirm('Discard changes?') — cancel keeps
   * the modal open (return without closing); confirm (or not-dirty) delegates to the
   * existing closer `closeFn`, which stays the SINGLE owner of restore/null/release-lock.
   *
   * window.confirm is the chosen surface: CLAUDE.md forbids modal stacking (a second
   * modal can't open over an edit modal; top-level openers are :disabled="anyModalOpen"),
   * so an in-app confirm modal would be blocked. Native confirm is the simplest correct
   * option for a personal local tool; it introduces no new modal CSS and stacking stays
   * impossible. closeFn is passed by reference and invoked with `this` bound.
   */
  requestCloseEditModal(which, closeFn) {
    if (this.editModalIsDirty(which)) {
      if (!window.confirm('Discard changes?')) return; // cancel → keep modal open
    }
    closeFn.call(this);
  },

  /**
   * _acquireLockForEditorOpen — Phase 12 (LOCK-01, D-02/D-03). Shared acquire-on-open
   * helper for the EXISTING-RECORD editors (recipe + ingredient). Re-reads presence
   * fresh (the authoritative acquire-time check, D-09), then acquires ONLY if no
   * FOREIGN live lock is held (`!presenceLock || _lockIsMine`). Per D-03 we never
   * refuse to open: if someone else holds a live lock the editor opens READ-ONLY
   * (editorDisabled already gates the fields) and we simply do not acquire. A raced
   * acquire 409 → refresh presence so the banner shows who won; NEVER loop (SAVE-02).
   */
  async _acquireLockForEditorOpen() {
    // Connected-only: with no token the lock CRUD can't run; the editor is already
    // read-only via readOnlyMode, so there is nothing to acquire.
    if (!this.githubConnected || !this.githubToken) return;
    try {
      await this.refreshPresence();
    } catch (_e) { /* presence read is best-effort; fall through to the acquire guard */ }
    // D-03 — a FOREIGN live lock means open read-only, do NOT acquire (no refuse path).
    if (this.presenceLock && !this._lockIsMine) return;
    try {
      await this.acquireLock();
    } catch (e) {
      // A raced acquire 409 (someone claimed it between our read and write): refresh
      // presence so the banner reflects the winner. NEVER re-acquire (SAVE-02).
      try { await this.refreshPresence(); } catch (_e2) { /* best-effort */ }
    }
  },

  /**
   * editRecipeFromMealPlan — quick 260612-kv1 / 260614-od7. Thin delegate kept for
   * back-compat; the meal-plan title now calls openEditRecipe directly. Opens the
   * recipe-edit modal OVER the meal-plan view (no navigation, no view switch).
   */
  async editRecipeFromMealPlan(recipe_id) {
    await this.openEditRecipe(recipe_id);
  },

  // ---------- quick 260608-agp — Recipe Manager actions ----------

  /**
   * openRecipeManager — quick 260608-agp / 260614-od7. Enter the recipe-manager
   * (browse-only) view. Refuses while a write is in flight (approving/merging), then
   * reads recipes.csv FRESH and builds the browse list. Fails closed on read error /
   * bad header (does NOT enter a half-open manager). The parse-form snapshot is NO
   * LONGER managed here — the recipe-edit modal lifecycle (openEditRecipe /
   * closeEditRecipe) owns it now, so toggling Manage-Recipes on/off never touches
   * this.form.
   */
  async openRecipeManager() {
    if (this.approving || this.merging) return;
    if (this.mealPlanView) this._flushPlanPush(); // Phase 17 (D-05) flush-on-close
    // quick 260608-bd5 — three-way mutual exclusion: clear the other two views.
    this.managerView = false;
    this.mealPlanView = false; // quick 260611-enp — four-way mutual exclusion
    this.residentsView = false; // Plan 07-03 — five-way mutual exclusion
    this.recipeManagerView = true;
    this.recipeManagerError = '';
    this.recipeManagerNotice = '';
    this.editingRecipeId = null;
    this.recipeDeleteConfirmText = '';

    let recipes;
    try {
      recipes = await getFile('recipes.csv');
    } catch (_e) {
      this.recipeManagerError = "Couldn't read recipes.csv, so the recipe list couldn't be loaded. Try Pick CSV folder again.";
      return;
    }
    const cols = recipes.columns || [];
    if (!cols.includes('recipe_id') || !cols.includes('name')) {
      this.recipeManagerError = "recipes.csv doesn't look right (no recipe_id / name column). Try Pick CSV folder again.";
      return;
    }
    this.recipeList = this._buildRecipeList(recipes.rows);
    await this._refreshRecipeQtyGaps();   // quick 260613-a2t — READ-ONLY browse-list qty-gap tally
  },

  /**
   * _buildRecipeList — quick 260608-agp. Map fresh recipes.csv disk rows to the
   * browse-list shape { recipe_id, name, type }. Skips blank-recipe_id rows
   * (mirrors loadLiveCsvs skip-blank guard). Reads the disk `main/side/salad`
   * column (with slashes) OR the `main_side_salad` variant for the type.
   * quick 260618-e1z — ADDITIVELY carries three more fields for the meal-plan
   * picker filters/sorts (mirrors the editor-header disk read at ~5235): {
   *   max_servings: number|null,   // null when blank/missing
   *   last_made: ''|'YYYY-MM-DD',  // '' = never made
   *   difficulty: number|null      // null when blank/missing
   * }. These are PURELY ADDITIVE — recipe_id/name/type are unchanged so
   * filteredRecipeList and the manager result counts keep working.
   */
  _buildRecipeList(rows) {
    const out = [];
    for (const r of (Array.isArray(rows) ? rows : [])) {
      const idRaw = (r.recipe_id ?? '').toString().trim();
      if (idRaw === '') continue;   // skip blank-recipe_id rows
      out.push({
        recipe_id: parseInt(idRaw, 10),
        name: r.name ?? '',
        type: r['main/side/salad'] ?? r['main_side_salad'] ?? '',
        // quick 260618-e1z — additive picker fields (null-coercion mirrors the editor header read).
        max_servings: (r.max_servings === '' || r.max_servings == null) ? null : Number(r.max_servings),
        last_made: r.last_made ?? '',
        difficulty: (r.difficulty === '' || r.difficulty == null) ? null : Number(r.difficulty)
      });
    }
    return out;
  },

  /**
   * _buildRecipeQtyGaps — quick 260613-a2t. Build & RETURN a tally object
   * keyed by recipe_id (number) → { missing, total } from recipe_ingredients.csv
   * join rows. A "real ingredient line" has a non-blank ingredient_id OR
   * ingredient_name (totally-blank padding rows are skipped). A real line is
   * "missing a quantity" iff neither quantity_metric NOR quantity_volumetric is a
   * finite number > 0 (blank, 0, and non-numeric all count as missing). Rows with
   * a blank recipe_id are skipped. READ-ONLY — never writes anything.
   *
   * quick 260614-f9t — `stapleIds` (default empty Set = no staple exclusion, so a
   * no-arg / single-arg call behaves exactly as before) is an injected Set of
   * NUMERIC master ingredient_ids flagged pantry_staple. A staple line is excluded
   * from BOTH total and missing (never counted, never pushed to names) — a staple
   * is never ordered, so a missing quantity on it is a false-positive flag.
   * stapleIds is injected (not read off `this`) so the tally logic stays testable.
   *
   * quick 260615-ljm — the missing-qty display NAME now resolves the CANONICAL
   * master name via this.masterIngredientName (recipe-line name as fallback), so
   * the function reads `this`; it is always called as this._buildRecipeQtyGaps.
   */
  _buildRecipeQtyGaps(joinRows, stapleIds = new Set()) {
    const hasQty = (cell) => {
      const s = String(cell ?? '').trim();
      return Number.isFinite(Number(s)) && Number(s) > 0;
    };
    const out = {};
    for (const r of (Array.isArray(joinRows) ? joinRows : [])) {
      const idRaw = String(r.recipe_id ?? '').trim();
      if (idRaw === '') continue;   // skip blank-recipe_id rows
      const ingId = String(r.ingredient_id ?? '').trim();
      const ingName = String(r.ingredient_name ?? '').trim();
      if (ingId === '' && ingName === '') continue;   // skip non-ingredient padding rows
      // quick 260613-aw1 — count ONLY required rows toward total+missing. A
      // to-taste/optional/garnish line legitimately has no amount, so it must not
      // flag. Reuse the canonical role-vs-legacy-booleans derivation (disk row);
      // default 'required' keeps role-less recipes flagged exactly as before.
      const role = r.role
        ? r.role
        : ((r.is_garnish === 'TRUE') ? 'garnish'
          : (r.is_optional === 'TRUE') ? 'optional'
          : (r.is_to_taste === 'TRUE') ? 'to_taste'
          : 'required');
      if (role !== 'required') continue;
      // quick 260614-f9t — exclude pantry staples from BOTH total and missing
      // (this continue runs before out[id].total += 1). ingId is the trimmed
      // string; parseInt yields a number matching the numeric staple Set.
      const sid = parseInt(ingId, 10);
      if (Number.isFinite(sid) && stapleIds.has(sid)) continue;
      const id = parseInt(idRaw, 10);
      // quick 260614-c2a — additive `names: []` collects the display name of each
      // missing-quantity line (length === missing; no dedup). Read-only; missing/total unchanged.
      if (!out[id]) out[id] = { missing: 0, total: 0, names: [] };
      out[id].total += 1;
      if (!hasQty(r.quantity_metric) && !hasQty(r.quantity_volumetric)) {
        out[id].missing += 1;
        // quick 260615-ljm — prefer the CANONICAL master name (resolved by id) over
        // the recipe-line name, falling back to the recipe-line name then #<id>.
        // ingId is the trimmed STRING; parseInt yields the numeric master id.
        // (Always called as this._buildRecipeQtyGaps, so `this` is bound.)
        const masterName = this.masterIngredientName(parseInt(ingId, 10), ingName);
        out[id].names.push(
          masterName && masterName !== '(unnamed)' ? masterName
            : (ingName !== '' ? ingName : `#${ingId}`)
        );
      }
    }
    return out;
  },

  /**
   * _refreshRecipeQtyGaps — quick 260613-a2t. FAIL-OPEN, READ-ONLY async refresh
   * of the browse-list qty-gap tally. Reads recipe_ingredients.csv via getFile and
   * reassigns recipeQtyGapsById wholesale. On ANY read error → {} (empty → no
   * false flags). Never throws; safe to await after the existing list refresh.
   */
  async _refreshRecipeQtyGaps() {
    try {
      const ri = await getFile('recipe_ingredients.csv');
      this.recipeQtyGapsById = this._buildRecipeQtyGaps(ri && ri.rows ? ri.rows : [], this.pantryStapleIdSet);
    } catch (_e) {
      this.recipeQtyGapsById = {};
    }
  },

  /**
   * recipeQtyGapLabel — quick 260613-a2t. PURE; safe for x-show + x-text. Returns
   * the browse-list caveat text for a recipe, or '' when there is no gap.
   */
  recipeQtyGapLabel(recipe_id) {
    const g = this.recipeQtyGapsById[recipe_id];
    if (!g || !g.missing) return '';
    if (g.missing === g.total) return `⚠ all ${g.total} ingredient${g.total === 1 ? '' : 's'} missing quantities`;
    return `⚠ ${g.missing} ingredient${g.missing === 1 ? '' : 's'} missing quantities`;
  },

  /**
   * recipeQtyGapTooltip — quick 260614-c2a. PURE; safe as a native :title binding.
   * Returns a bulleted list of the ingredient names missing a quantity (so the user
   * sees WHICH lines to fix, not just how many), or '' when there is no gap. Mirrors
   * recipeQtyGapLabel's guard. Native title attrs render \n as line breaks. No mutation.
   */
  recipeQtyGapTooltip(recipe_id) {
    const g = this.recipeQtyGapsById[recipe_id];
    if (!g || !g.missing) return '';
    const names = (g.names && Array.isArray(g.names)) ? g.names : [];
    if (names.length === 0) return '';
    return `Missing quantities — add them in the editor:\n${names.map((n) => `• ${n}`).join('\n')}`;
  },

  /**
   * closeRecipeManager — quick 260608-agp / 260614-od7. Toggle back to Parse. The
   * parse-form snapshot is NO LONGER restored here — the recipe-edit modal lifecycle
   * (closeEditRecipe) owns snapshot+restore now, so toggling the browse-only manager
   * off never touches this.form. Just clears the manager-local transient state.
   */
  closeRecipeManager() {
    this.recipeManagerView = false;
    this.editingRecipeId = null;
    this.recipeDeleteConfirmText = '';
  },

  // quick 260615-nx6 (NAV-PARSE-VIA-RECIPE-MANAGER) — Parse is no longer "home";
  // it is reached FROM the Recipe Manager. openParseFromRecipeManager just clears
  // all four view flags so the Parse workspace shows (its gate is
  // !managerView && !recipeManagerView && !mealPlanView). It deliberately does NOT
  // touch this.form or rawText — in-progress parse state lives under x-show and
  // must survive the navigation.
  openParseFromRecipeManager() {
    if (this.mealPlanView) this._flushPlanPush(); // Phase 17 (D-05) flush-on-close
    this.recipeManagerView = false;
    this.managerView = false;
    this.mealPlanView = false;
  },

  // backToRecipeManager — the coherent Back path out of Parse: Parse's parent is
  // now the Recipe Manager, so Back re-enters the browse view (fresh, fail-closed
  // read) which also clears the other view flags.
  async backToRecipeManager() {
    await this.openRecipeManager();
  },

  // ==========================================================================
  // quick 260611-enp — Meal plan view (READ-ONLY + EPHEMERAL).
  // --------------------------------------------------------------------------
  // openMealPlan reads recipes.csv + recipe_ingredients.csv FRESH and groups the
  // join rows by recipe_id into mealPlanGrouped (read-only scaling sources). The
  // user picks recipes (addToMealPlan / removeFromMealPlan) with per-recipe target
  // servings; scaledRowsFor + combinedShoppingList derive scaled values live via
  // scale.js. NOTHING on this path writes to disk — there is no _rewrite / delta /
  // merge / approve call anywhere in these methods/getters by design (T-enp-03).
  // ==========================================================================

  /**
   * openMealPlan — enter the meal-plan view. MIRRORS openRecipeManager (refuse
   * while a write is in flight; clear the other three views; fail closed on read
   * error / un-migrated schema). Reads BOTH live files FRESH, rebuilds recipeList
   * for the picker, applies the openRecipeForEdit fail-closed schema guard, then
   * groups recipe_ingredients.csv join rows by recipe_id into mealPlanGrouped.
   */
  async openMealPlan() {
    if (this.approving || this.merging) return;
    // Four-way mutual exclusion — clear the other three top-level views.
    this.managerView = false;
    this.recipeManagerView = false;
    this.residentsView = false; // Plan 07-03 — five-way mutual exclusion
    this.mealPlanView = true;
    this.mealPlanError = '';

    if (!this.csvStoreLoaded) {
      this.mealPlanError = 'Import your CSVs first.';
      return;
    }

    let recipes, recipeIngredients;
    try {
      recipes = await getFile('recipes.csv');
      recipeIngredients = await getFile('recipe_ingredients.csv');
    } catch (_e) {
      this.mealPlanError = "Couldn't read your recipe files, so the meal plan couldn't load. Try Pick CSV folder again.";
      return;
    }
    // Fresh picker list (reuses the existing browse-list builder).
    this.recipeList = this._buildRecipeList(recipes.rows);

    // EXACT fail-closed schema guard (mirrors openRecipeForEdit): refuse old /
    // un-migrated recipe_ingredients.csv rather than mis-scaling against the
    // wrong column shape. This stays in openMealPlan (the error-surface path);
    // _rebuildMealPlanGrouped just builds grouped from a fresh read.
    if (isOldSchemaJoinHeader(recipeIngredients.columns) || !isMigratedJoinHeader(recipeIngredients.columns)) {
      this.mealPlanError = 'recipe_ingredients.csv is on the old schema — click Migrate schema first.';
      return;
    }

    // quick 260615-dap — build mealPlanGrouped via the extracted reusable method
    // (byte-identical to the previously inlined block). It re-reads the join file
    // FRESH itself, so the open path and the post-save rebuild share one builder.
    await this._rebuildMealPlanGrouped();

    // Phase 17 (Plan 17-02, D-06) — PULL-ON-OPEN. Pull the latest meal_plan.json
    // and apply it BEFORE the reconcile loop runs, so the other cook's changes are
    // reflected on open. NON-FATAL: a 404 / reach error routes to mealPlanSyncStatus
    // (its own channel) and leaves the local plan in place — never blocks the view.
    // applySharedPlanDoc suppresses the debounced push (this is a pull, not an edit).
    await this.pullPlanFromRemote();

    // quick 260615-dap — RECONCILE the persisted plan against the fresh recipe
    // list (runs AFTER recipeList is built + grouped is set AND after the pull). A
    // pick whose recipe_id no longer exists is dropped; kept entries get their
    // name/type refreshed from the current list (so renames show). The explicit
    // _persistMealPlan() below is SUPPRESSED from triggering a push (this is a
    // pull/reconcile, not a user edit). If any were dropped, surface a one-line
    // notice; a clean open clears any stale notice.
    const presentIds = new Set((Array.isArray(this.recipeList) ? this.recipeList : []).map(r => r.recipe_id));
    const kept = [];
    let droppedCount = 0;
    for (const entry of (Array.isArray(this.mealPlan) ? this.mealPlan : [])) {
      if (presentIds.has(entry.recipe_id)) {
        const meta = this.recipeList.find(r => r.recipe_id === entry.recipe_id);
        kept.push({
          ...entry,
          name: meta ? meta.name : entry.name,
          type: meta ? meta.type : entry.type
        });
      } else {
        droppedCount++;
      }
    }
    // Phase 17 (Plan 17-02, D-05) — the reconcile is NOT a user edit; suppress the
    // debounced push around the assignment + explicit persist (and the deferred
    // $watch flush) so opening the view never auto-pushes.
    this._suppressPlanPush = true;
    queueMicrotask(() => { this._suppressPlanPush = false; });
    this.mealPlan = kept;
    this._persistMealPlan();
    if (droppedCount > 0) {
      this.mealPlanNotice = `${droppedCount} saved recipe${droppedCount > 1 ? 's were' : ' was'} removed because ${droppedCount > 1 ? "they're" : "it's"} no longer in your recipes.`;
    } else {
      this.mealPlanNotice = '';
    }
  },

  /**
   * _rebuildMealPlanGrouped — quick 260615-dap. EXTRACTED from openMealPlan. Reads
   * recipe_ingredients.csv FRESH and (re)builds this.mealPlanGrouped: the
   * READ-ONLY, recipe_id-keyed scaling sources consumed by scaledRowsFor /
   * combinedShoppingList. Reassigning this.mealPlanGrouped is what makes the open
   * meal plan rescale LIVE after a recipe (or ingredient-master) save — those
   * derived getters read it reactively. This method does NOT touch mealPlanError
   * (the open path keeps its own schema guard); on a read failure it fail-opens
   * (leaves grouped as-is) so a best-effort post-save refresh never breaks the UI.
   * Behaviour for the open path is byte-identical to the previously inlined block.
   */
  async _rebuildMealPlanGrouped() {
    // quick 260621-sjs — build the recipe_id -> recipe-level prep_notes map from a
    // FRESH recipes.csv read FIRST (before the recipe_ingredients guard), so the
    // Prep section is best-effort and refreshes live like mealPlanGrouped. Key by
    // the SAME id coercion used below (parseInt of the trimmed recipe_id); skip rows
    // whose recipe_id trims to ''. Store the raw prep_notes (guard blank, do NOT trim
    // internal newlines). On a falsy read, set {} and continue (do NOT early-return —
    // the recipe_ingredients guard below still owns the scaling path).
    const recipes = await getFile('recipes.csv');
    if (recipes) {
      const prepMap = {};
      for (const r of (Array.isArray(recipes.rows) ? recipes.rows : [])) {
        const ridRaw = (r.recipe_id ?? '').toString().trim();
        if (ridRaw === '') continue;
        prepMap[parseInt(ridRaw, 10)] = r.prep_notes ?? '';
      }
      this.recipePrepById = prepMap;
    } else {
      this.recipePrepById = {};
    }

    const recipeIngredients = await getFile('recipe_ingredients.csv');
    if (!recipeIngredients) return;
    // Group join rows by recipe_id into lightweight READ-ONLY scaling sources.
    // num() mirrors _diskRowToEditorRow: '' / null -> null, else Number.
    const num = (v) => (v === '' || v == null) ? null : Number(v);
    // quick 260612-esy — Phase B: build a NUMERIC-keyed ingredient_id -> stored
    // scale_category lookup from the master ONCE. The master's ingredient_id is a
    // parsed integer and num(r.ingredient_id) returns a Number, so the Map key and
    // the lookup key are both numbers. A blank/untagged/unmatched lookup yields ''
    // (=> the Phase A heuristic at scale time; Phase A preserved).
    const catById = new Map(this.ingredientMaster.map(m => [m.ingredient_id, m.scale_category]));
    // quick 260615-ljm — NUMERIC-keyed ingredient_id -> CANONICAL master
    // ingredient_name (same id-coercion convention as catById; the master id is a
    // parsed integer and num(r.ingredient_id) returns a Number). Feeding the master
    // name into the grouped row propagates it through scaledRowsFor into BOTH the
    // meal-plan per-recipe rows AND combinedShoppingList with no binding change. The
    // recipe-line name stays the fallback for null/unmatched ids.
    const nameById = new Map(this.ingredientMaster.map(m => [m.ingredient_id, m.ingredient_name]));
    const grouped = {};
    for (const r of (Array.isArray(recipeIngredients.rows) ? recipeIngredients.rows : [])) {
      const ridRaw = (r.recipe_id ?? '').toString().trim();
      if (ridRaw === '') continue;
      const rid = parseInt(ridRaw, 10);
      if (!grouped[rid]) grouped[rid] = [];
      grouped[rid].push({
        ingredient_id: num(r.ingredient_id),
        // quick 260615-ljm — CANONICAL master name by id; recipe-line name is the
        // fallback only when the id is null/unmatched. Propagates to the meal-plan
        // row + combinedShoppingList display via scaledRowsFor (no binding change).
        ingredient_name: nameById.get(num(r.ingredient_id)) || (r.ingredient_name ?? ''),
        quantity_metric: num(r.quantity_metric),
        unit_metric: r.unit_metric ?? '',
        quantity_volumetric: num(r.quantity_volumetric),
        unit_volumetric: r.unit_volumetric ?? null,
        line_order: num(r.line_order),
        raw_text: r.raw_text ?? '',
        // quick 260612-esy — stored category joined from the master by id; '' when
        // unmatched/untagged. classifyIngredientCategory (step 0) prefers a valid
        // scale_category, so the stored tag flows through scaleRow automatically.
        scale_category: catById.get(num(r.ingredient_id)) || '',
        // quick 260613-aw1 — role rides the grouped row so scaleRow's {...row}
        // spread carries it into combinedShoppingList. Reuse the canonical
        // role-vs-legacy-booleans derivation (mirrors _diskRowToEditorRow ~L4036);
        // default 'required' keeps role-less recipes shopped exactly as before.
        role: r.role
          ? r.role
          : ((r.is_garnish === 'TRUE') ? 'garnish'
            : (r.is_optional === 'TRUE') ? 'optional'
            : (r.is_to_taste === 'TRUE') ? 'to_taste'
            : 'required')
      });
    }
    // Sort each group by line_order (null/blank sort to 0, matching the editor).
    for (const rid of Object.keys(grouped)) {
      grouped[rid].sort((a, b) => (Number(a.line_order) || 0) - (Number(b.line_order) || 0));
    }
    this.mealPlanGrouped = grouped;
  },

  /**
   * closeMealPlan — back to Parse. Parse state survives via x-show (this view
   * never touches this.form, so no snapshot is needed). mealPlan + mealPlanGrouped
   * are left INTACT so re-opening keeps the in-memory plan (ephemeral within the
   * session; never persisted to disk).
   */
  closeMealPlan() {
    this.mealPlanView = false;
  },

  /**
   * addToMealPlan — add a recipe to the in-memory plan with default servings 4
   * (the locked decision). quick 260615-lzq: ALWAYS pushes a NEW entry — repeats
   * are allowed (the same recipe can be planned for multiple days), so there is
   * no dedup guard. Each entry gets a fresh crypto.randomUUID() id and an empty
   * date (set later via the per-entry date input). Looks up name/type from the
   * freshly-built recipeList.
   */
  addToMealPlan(recipe_id) {
    // quick 260621-amm — delegate to the day-targeted add with the '' (Unscheduled)
    // default, so the existing date:'' default is preserved byte-faithfully for any
    // remaining callers (the recipe-manager "plan this" path, etc.).
    this.addToMealPlanForDate(recipe_id, '');
  },

  /**
   * addToMealPlanForDate — quick 260621-amm. Identical to addToMealPlan but seeds
   * the new entry's date to the passed 'YYYY-MM-DD' string (or '' for Unscheduled).
   * RENDER/INTERACTION change only — the entry SHAPE is unchanged (same fresh
   * crypto.randomUUID id, servings 4, collapsed true); only the seeded date value
   * differs, set through the existing _persistMealPlan path. NO new persisted fields.
   */
  addToMealPlanForDate(recipe_id, date) {
    const rid = Number(recipe_id);
    const meta = this.recipeList.find(r => r.recipe_id === rid);
    this.mealPlan.push({
      // quick 260615-lzq — per-entry unique id (replaces recipe_id-based keying),
      // so two entries for the same recipe are distinct rows under distinct days.
      id: crypto.randomUUID(),
      recipe_id: rid,
      name: meta ? meta.name : '',
      type: meta ? meta.type : '',
      servings: 4,
      // quick 260615-dap — cards default COLLAPSED (head only). Per-card toggle
      // flips this independently. Persisted in the minimal localStorage projection.
      collapsed: true,
      // quick 260615-lzq — 'YYYY-MM-DD' from the per-entry date input, '' = unscheduled.
      // quick 260621-amm — now seeded from the day-targeted add (defaults to '').
      date: (typeof date === 'string') ? date : ''
    });
    // quick 260615-dap — explicit persist (plan-check WARNING: Alpine $watch is
    // unreliable on nested array-element mutations, so we persist directly on
    // every mutation; the $watch in init() is belt-and-braces only).
    this._persistMealPlan();
  },

  /**
   * openPickerForDate / closeMealPlanPicker — quick 260621-amm. Open the focused
   * recipe picker MODAL pre-targeted to a specific day (date = '' targets Unscheduled,
   * an edge affordance). The modal STAYS OPEN across multiple adds; Done (or Escape)
   * closes it. Both transient — no persistence.
   */
  openPickerForDate(date) {
    this.mealPlanPickerTargetDate = (typeof date === 'string') ? date : '';
    this.mealPlanPickerOpen = true;
  },
  closeMealPlanPicker() {
    this.mealPlanPickerOpen = false;
    this.mealPlanPickerTargetDate = '';
    // quick 260621-amm follow-up — closing resets the picker to a clean slate so the
    // next open never inherits a stale search/filter (full reset, mirrors the Clear link).
    this.clearMealPlanFilters();
  },
  /**
   * addFromPicker — quick 260621-amm follow-up. The modal pick-list Add handler:
   * add the recipe to the modal's target day, then clear the SEARCH text so the
   * spent query ('baguettes') doesn't linger while the modal stays open for the
   * next add. Deliberately clears only mealPlanFilter, NOT the type/sort context
   * the user may be browsing within (a full reset happens on close instead).
   */
  addFromPicker(recipe_id) {
    this.addToMealPlanForDate(recipe_id, this.mealPlanPickerTargetDate);
    this.mealPlanFilter = '';
  },
  // quick 260621-amm — header label for the picker modal. Reuses _dayLabel; '' (or a
  // malformed/blank target) degrades to '' so the header reads just "Add recipe".
  get mealPlanPickerTargetLabel() {
    if (!this.mealPlanPickerTargetDate) return '';
    return this._dayLabel(this.mealPlanPickerTargetDate) || '';
  },

  /**
   * removeFromMealPlan — quick 260615-lzq: remove ONLY the entry whose unique id
   * matches (recipe_id is no longer a unique key — repeats share a recipe_id).
   * Persist the change.
   */
  removeFromMealPlan(id) {
    const i = this.mealPlan.findIndex(e => e.id === id);
    if (i !== -1) this.mealPlan.splice(i, 1);
    // quick 260615-dap — explicit persist (see addToMealPlan).
    this._persistMealPlan();
  },

  /**
   * _persistMealPlan — quick 260615-dap. Snapshot a MINIMAL projection of the
   * plan to localStorage: { id, recipe_id, date, servings, collapsed } per entry
   * ONLY (id + date added quick 260615-lzq so the per-entry identity and day
   * survive a refresh). Never persists name/type (refreshed on open) or
   * mealPlanGrouped (rebuilt on open). Fail-open: any quota/serialization error is
   * swallowed so persistence never throws into the UI. Called directly on every
   * plan mutation (add / remove / servings edit / collapse toggle / date change /
   * reconcile) — see plan-check WARNING: Alpine $watch is unreliable on nested
   * array-element mutations.
   */
  _persistMealPlan() {
    try {
      const projection = (Array.isArray(this.mealPlan) ? this.mealPlan : []).map(e => ({
        id: e.id,
        recipe_id: e.recipe_id,
        date: e.date,
        servings: e.servings,
        collapsed: e.collapsed
      }));
      localStorage.setItem(MEAL_PLAN_KEY, JSON.stringify(projection));
    } catch (_e) {
      /* fail-open — persistence is best-effort, never block the UI. */
    }
    // Phase 17 (Plan 17-02, D-05) — debounced REMOTE push alongside the instant
    // local persist. Suppressed during boot restore / pull-apply / open reconcile
    // (NOT user edits) so a pull never bounces straight back into a push.
    if (!this._suppressPlanPush) this._schedulePlanPush();
  },

  /**
   * _restoreMealPlan — quick 260615-dap. Read + validate the persisted minimal
   * projection on boot, BEFORE any disk read (it needs none — name/type are
   * placeholders refreshed on the next openMealPlan, and any pick whose recipe
   * no longer exists is reconciled there). Defensive: any throw/corruption /
   * non-array resets the plan to []. Each entry is coerced — recipe_id must be a
   * finite number (NaN entries dropped); servings coerced to Number; collapsed
   * defaults true unless explicitly false.
   * quick 260615-lzq — backward-compatible restore of PRE-lzq plans (no separate
   * migration): an entry with no/invalid id gets a generated crypto.randomUUID();
   * a non-string date is coerced to '' (unscheduled). So old projections
   * ([{recipe_id, servings, collapsed}]) restore cleanly with a fresh id + empty date.
   */
  _restoreMealPlan() {
    try {
      const raw = localStorage.getItem(MEAL_PLAN_KEY);
      if (!raw) { this.mealPlan = []; return; }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) { this.mealPlan = []; return; }
      const restored = [];
      for (const e of parsed) {
        if (!e || typeof e !== 'object') continue;
        const rid = Number(e.recipe_id);
        if (!Number.isFinite(rid)) continue;
        restored.push({
          // quick 260615-lzq — defensive id default for pre-lzq projections.
          id: (typeof e.id === 'string' && e.id) ? e.id : crypto.randomUUID(),
          recipe_id: rid,
          // name/type are placeholders — refreshed from recipeList on open.
          name: '',
          type: '',
          servings: Number(e.servings),
          collapsed: e.collapsed !== false,
          // quick 260615-lzq — coerce a missing/invalid date to '' (unscheduled).
          date: (typeof e.date === 'string') ? e.date : ''
        });
      }
      this.mealPlan = restored;
    } catch (_e) {
      this.mealPlan = [];
    }
  },

  /**
   * _persistMealPlanUi — quick 260620-esf. Snapshot the meal-plan UI prefs
   * (Add-recipes collapsed + per-day collapse map) to localStorage under
   * MEAL_PLAN_UI_KEY. UI-prefs ONLY — never touches the CSV/IndexedDB store.
   * Fail-open: any quota/serialization error is swallowed so persistence never
   * throws into the UI (byte-for-byte mirror of _persistMealPlan's structure).
   * Called directly on every picker/day collapse toggle.
   */
  _persistMealPlanUi() {
    try {
      localStorage.setItem(MEAL_PLAN_UI_KEY, JSON.stringify({
        pickerCollapsed: this.mealPlanPickerCollapsed,
        dayCollapsedByDay: this.dayCollapsedByDay,
        // quick 260620-s49 — per-day cooks map (date key → [APPID,...]).
        cooksByDay: this.cooksByDay,
        // quick 260627-i6h (D13a) — the order-scope range (null = whole plan, or
        // { startKey, endKey }). REPLACES the retired per-day dayExcludedFromShopping
        // map (D13b — no permanently-excluded per-day state); old persisted exclude
        // maps are simply ignored on restore.
        orderScopeRange: this.orderScopeRange,
        // quick 260621-lft — per-day leftovers map (date key → true).
        dayLeftovers: this.dayLeftovers,
        // quick 260627-iy8 — per-day prep-done map (date key → true).
        prepDoneByDay: this.prepDoneByDay,
        // phase 08 REG-07 — per-plan regulars overrides + ad-hoc extras.
        regularsOverrides: this.regularsOverrides,
        adHocExtras: this.adHocExtras
      }));
    } catch (_e) {
      /* fail-open — persistence is best-effort, never block the UI. */
    }
    // Phase 17 (Plan 17-02, D-05) — this funnel also persists SHARED fields
    // (cooksByDay/dayLeftovers/prepDoneByDay/regularsOverrides/adHocExtras/
    // orderScopeRange), so it triggers the debounced push too. A toggle of the
    // local-only pickerCollapsed/dayCollapsedByDay also lands here; the resulting
    // push merges to identical shared bytes (a debounced no-op), so it is safe.
    if (!this._suppressPlanPush) this._schedulePlanPush();
  },

  /**
   * _restoreMealPlanUi — quick 260620-esf. Read + defensively validate the
   * persisted UI prefs on boot. ONLY accepts well-formed values:
   *   - pickerCollapsed coerced to boolean; DEFAULT true when absent/invalid
   *     (collapsed-by-default is the locked behaviour).
   *   - dayCollapsedByDay accepted only if a plain non-null object, else {}.
   * Any throw/corruption leaves the safe defaults (picker collapsed, empty day
   * map). Does NOT touch this.mealPlan.
   */
  _restoreMealPlanUi() {
    try {
      const raw = localStorage.getItem(MEAL_PLAN_UI_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;
      this.mealPlanPickerCollapsed = (typeof parsed.pickerCollapsed === 'boolean')
        ? parsed.pickerCollapsed
        : true;
      this.dayCollapsedByDay = (parsed.dayCollapsedByDay
        && typeof parsed.dayCollapsedByDay === 'object'
        && !Array.isArray(parsed.dayCollapsedByDay))
        ? parsed.dayCollapsedByDay
        : {};
      // quick 260620-s49 — restore the per-day cooks map with the SAME defensive
      // plain-non-null-object guard as dayCollapsedByDay; anything else => {}.
      this.cooksByDay = (parsed.cooksByDay
        && typeof parsed.cooksByDay === 'object'
        && !Array.isArray(parsed.cooksByDay))
        ? parsed.cooksByDay
        : {};
      // quick 260627-i6h (D13a) — restore the order-scope range with a defensive guard
      // mirroring the sibling maps: accept ONLY a plain non-null non-array object that
      // has BOTH string startKey AND endKey with startKey <= endKey (lexicographic);
      // ANYTHING else (incl. an old persisted dayExcludedFromShopping map, null, an
      // array, a malformed/half range) => null (whole plan). The retired
      // dayExcludedFromShopping restore is deliberately GONE — old values are ignored;
      // this.dayExcludedFromShopping stays at its {} default declaration (harmless).
      this.orderScopeRange = (parsed.orderScopeRange
        && typeof parsed.orderScopeRange === 'object'
        && !Array.isArray(parsed.orderScopeRange)
        && typeof parsed.orderScopeRange.startKey === 'string'
        && typeof parsed.orderScopeRange.endKey === 'string'
        && parsed.orderScopeRange.startKey <= parsed.orderScopeRange.endKey)
        ? { startKey: parsed.orderScopeRange.startKey, endKey: parsed.orderScopeRange.endKey }
        : null;
      // quick 260621-lft — restore the per-day leftovers map with the SAME defensive
      // plain-non-null-object guard as dayCollapsedByDay; anything else => {}.
      this.dayLeftovers = (parsed.dayLeftovers
        && typeof parsed.dayLeftovers === 'object'
        && !Array.isArray(parsed.dayLeftovers))
        ? parsed.dayLeftovers
        : {};
      // quick 260627-iy8 — restore the per-day prep-done map with the SAME defensive
      // plain-non-null-object guard as dayLeftovers; anything else => {}.
      this.prepDoneByDay = (parsed.prepDoneByDay
        && typeof parsed.prepDoneByDay === 'object'
        && !Array.isArray(parsed.prepDoneByDay))
        ? parsed.prepDoneByDay
        : {};
      // phase 08 REG-07 — restore regularsOverrides with the SAME plain-non-null-object
      // guard the siblings use; anything else (incl. an array or null) => {}.
      this.regularsOverrides = (parsed.regularsOverrides
        && typeof parsed.regularsOverrides === 'object'
        && !Array.isArray(parsed.regularsOverrides))
        ? parsed.regularsOverrides
        : {};
      // phase 08 REG-07 — adHocExtras is an ARRAY; guard with Array.isArray, else [].
      this.adHocExtras = Array.isArray(parsed.adHocExtras) ? parsed.adHocExtras : [];
    } catch (_e) {
      this.mealPlanPickerCollapsed = true;
      this.dayCollapsedByDay = {};
      this.cooksByDay = {};
      this.dayExcludedFromShopping = {};
      this.orderScopeRange = null; // quick 260627-i6h (D13a) — fail-open to whole plan.
      this.dayLeftovers = {};
      this.prepDoneByDay = {}; // quick 260627-iy8 — fail-open to empty on corruption.
      // phase 08 REG-07 — fail-open: both reset to empty on any corruption.
      this.regularsOverrides = {};
      this.adHocExtras = [];
    }
  },

  // =========================================================================
  // Phase 17 (Plan 17-02) — MEAL-PLAN SYNC ENGINE
  // -------------------------------------------------------------------------
  // The shared meal plan rides meal_plan.json (entries + the keyed maps +
  // orderScopeRange). Pure view-state (per-entry collapsed, pickerCollapsed,
  // dayCollapsedByDay) is EXCLUDED and stays in localStorage (SPEC #1). Sync
  // is a 3-way merge against a persisted base (D-01..D-04), debounced ~10s
  // (D-05), pull-on-open (D-06), OUTSIDE the advisory lock (SPEC #6).
  // The PURE merge/projection helpers live in mealplan-sync.js (Node-tested);
  // these methods are the Alpine-state + transport wiring.
  // =========================================================================

  /**
   * buildSharedPlanDoc — Phase 17 (Plan 17-02, SPEC #1). Project the CURRENT
   * Alpine plan state into the synced shared document, pruning all view-state
   * (per-entry `collapsed`, pickerCollapsed, dayCollapsedByDay never enter it).
   * Delegates to the PURE projectSharedPlanDoc so the field split is unit-tested.
   * @returns {object} the shared doc { entries, cooksByDay, dayLeftovers,
   *   prepDoneByDay, regularsOverrides, adHocExtras, orderScopeRange }
   */
  buildSharedPlanDoc() {
    return projectSharedPlanDoc({
      mealPlan: this.mealPlan,
      cooksByDay: this.cooksByDay,
      dayLeftovers: this.dayLeftovers,
      prepDoneByDay: this.prepDoneByDay,
      regularsOverrides: this.regularsOverrides,
      adHocExtras: this.adHocExtras,
      orderScopeRange: this.orderScopeRange
    });
  },

  /**
   * applySharedPlanDoc — Phase 17 (Plan 17-02, D-06). Load a shared doc back into
   * Alpine state. The shared entries are merged with this device's LOCAL-ONLY
   * `collapsed` view-state by id (a pulled entry keeps its prior collapsed value,
   * defaulting to collapsed=true for a brand-new entry); the 6 maps + orderScopeRange
   * are assigned. name/type are left as placeholders — openMealPlan's reconcile loop
   * refreshes them from the fresh recipe list immediately after this is called.
   * Defensive: a corrupt doc coerces to the empty default (never throws).
   * @param {object} doc — a shared doc (or anything; coerced)
   */
  applySharedPlanDoc(doc) {
    // Suppress the debounced push while we assign shared state (this is a pull/merge
    // result, NOT a user edit). The $watch('mealPlan') + any _persist* fired by these
    // assignments must not bounce a pull straight back into a push. Cleared on the
    // next microtask so the deferred reactive flush is also covered.
    this._suppressPlanPush = true;
    queueMicrotask(() => { this._suppressPlanPush = false; });
    const safe = coerceSharedPlanDoc(doc);
    // Preserve LOCAL-ONLY per-entry collapsed by id (view-state stays local, SPEC #1).
    const priorCollapsed = new Map(
      (Array.isArray(this.mealPlan) ? this.mealPlan : [])
        .filter(e => e && e.id != null)
        .map(e => [e.id, e.collapsed])
    );
    this.mealPlan = safe.entries.map(e => ({
      id: e.id,
      recipe_id: Number(e.recipe_id),
      name: '',   // refreshed by openMealPlan's reconcile loop
      type: '',
      servings: Number(e.servings),
      date: typeof e.date === 'string' ? e.date : '',
      // local-only collapsed: keep this device's value, default collapsed=true.
      collapsed: priorCollapsed.has(e.id) ? (priorCollapsed.get(e.id) !== false) : true
    }));
    this.cooksByDay = safe.cooksByDay;
    this.dayLeftovers = safe.dayLeftovers;
    this.prepDoneByDay = safe.prepDoneByDay;
    this.regularsOverrides = safe.regularsOverrides;
    this.adHocExtras = safe.adHocExtras;
    this.orderScopeRange = safe.orderScopeRange;
  },

  /**
   * _persistMealPlanBase — Phase 17 (Plan 17-02, D-01/D-14). Snapshot the 3-way
   * merge base to localStorage. Fail-open (mirrors _persistMealPlan): any
   * quota/serialization error is swallowed so persistence never throws into the UI.
   * @param {object} doc — the shared doc to store as the new base
   */
  _persistMealPlanBase(doc) {
    const coerced = coerceSharedPlanDoc(doc);
    // Update the in-memory merge mirror FIRST — a localStorage quota error must not
    // leave the base stale on this front too (WR-02), which would skew later 3-way merges.
    this._mealPlanBase = coerced;
    try {
      localStorage.setItem(MEAL_PLAN_BASE_KEY, JSON.stringify(coerced));
    } catch (_e) {
      /* fail-open — persistence is best-effort, never block the UI. In-memory mirror set above. */
    }
  },

  /**
   * _restoreMealPlanBase — Phase 17 (Plan 17-02, D-01/D-14). Read + defensively
   * coerce the persisted base on boot. Any throw / corruption / non-object => the
   * safe empty default (so the merge degrades to "everything local is new" rather
   * than garbage). Caches the result in this._mealPlanBase. MUST be called on boot
   * so the base survives reloads (D-14). @returns {object} the base shared doc
   */
  _restoreMealPlanBase() {
    try {
      const raw = localStorage.getItem(MEAL_PLAN_BASE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      this._mealPlanBase = coerceSharedPlanDoc(parsed);
    } catch (_e) {
      this._mealPlanBase = emptySharedPlanDoc();
    }
    return this._mealPlanBase;
  },

  /**
   * pushPlanToRemote — Phase 17 (Plan 17-02, D-01..D-04, D-13, SPEC #2/#6). The
   * merge-on-push: re-pull FRESH remote meal_plan.json, 3-way-merge THIS device's
   * changes (vs the persisted base) onto it, write LOCAL-first (putJsonFile verify
   * + auto-revert) then REMOTE (ghPutFile), and update the base to the merged doc.
   *
   * Differs from the recipe pushToRemote:
   * - NO 409 hard-stop. On a stale-sha GhConflictError it RE-PULLS fresh and
   *   RE-MERGES (the merge is idempotent against the base — D-01), bounded to one
   *   retry so a pathological race can never spin.
   * - NEVER calls acquireLock/releaseLock (SPEC #6) — editing the plan must not
   *   flip the other user read-only on recipes. Relies on merge + blob-SHA only.
   * - First write is a CREATE (no sha → ghPutFile with sha undefined, D-13);
   *   thereafter UPDATE with the cached this._mealPlanSha.
   * - Own-error-channel: failures route to mealPlanSyncStatus (NEVER parseError,
   *   NEVER blocks boot — mirrors pullFromRemote's remoteStatus discipline).
   *
   * Guards (no network on refusal): not connected / no token / no name set.
   */
  async pushPlanToRemote() {
    if (!this.githubConnected || !this.githubToken) return; // nothing to push to
    if (!(this.userName ?? '').trim()) {
      // D-07 name guard (mirrors pushToRemote): every commit needs an attribution.
      this.mealPlanSyncStatus = 'Set your name in Settings to sync the meal plan.';
      return;
    }
    this.planSyncing = true;
    this.mealPlanSyncStatus = '';
    try {
      await this._pushPlanOnce(/* allowRetry */ true);
      this.mealPlanLastSyncedAt = new Date().toISOString();
      this.mealPlanSyncStatus = '';
    } catch (e) {
      // Non-fatal: route to the plan's OWN channel; never parseError, never the token.
      this.mealPlanSyncStatus = this.githubFriendlyError(e);
      this._maybeRateLimitBanner(e); // ACCESS-04 parity
    } finally {
      this.planSyncing = false;
    }
  },

  /**
   * _pushPlanOnce — Phase 17 (Plan 17-02). One merge-then-write pass, factored out
   * so the 409 path can re-run it exactly once. Reads fresh cfg per call (rotated
   * token). A 404 on the GET means the file does not exist yet → CREATE (D-13):
   * fresh remote = empty doc, sha undefined.
   * @param {boolean} allowRetry — re-pull+re-merge once on a stale-sha 409
   */
  async _pushPlanOnce(allowRetry) {
    const cfg = this.githubCfg; // fresh per call (rotated token, no reload)
    // (1) FRESH remote doc + sha. 404 = not yet created → CREATE path (D-13).
    let freshRemote = emptySharedPlanDoc();
    let sha; // undefined = CREATE
    try {
      const { text, sha: remoteSha } = await ghGetFile(cfg, 'meal_plan.json');
      freshRemote = coerceSharedPlanDoc(JSON.parse(text));
      sha = remoteSha;
    } catch (e) {
      if (!(e && e.status === 404)) throw e; // a real reach error propagates
      // 404 → first write: freshRemote stays empty, sha stays undefined (CREATE).
    }
    // (2) 3-way merge THIS device's changes (vs base) onto fresh remote (D-01..D-04).
    const base = this._mealPlanBase || this._restoreMealPlanBase();
    const local = this.buildSharedPlanDoc();
    const merged = mergeMealPlan(base, local, freshRemote);
    // (3) LOCAL-first write (putJsonFile verify + auto-revert) then REMOTE.
    await putJsonFile('meal_plan.json', merged, { shapeCheck: this._jsonShapeCheckFor('meal_plan.json') });
    const message = this.buildCommitMessage({ action: 'sync', objectKind: 'meal plan', title: '', groupTag: 'plan' });
    try {
      const { sha: newSha } = await ghPutFile(cfg, 'meal_plan.json', JSON.stringify(merged), sha, message);
      // (4) Success — adopt the merged doc as the new base + cache the sha.
      this._mealPlanSha = newSha;
      this._persistMealPlanBase(merged);
      // Reflect the merged result into Alpine state so a remote-only change made
      // by the other cook becomes visible without waiting for the next open.
      this.applySharedPlanDoc(merged);
    } catch (e) {
      // Stale-sha 409 → re-pull + re-merge ONCE (idempotent against the base, D-01).
      // NO hard-stop, NO whole-doc clobber (T-17-05).
      if (e instanceof GhConflictError && allowRetry) {
        await this._pushPlanOnce(/* allowRetry */ false);
        return;
      }
      throw e;
    }
  },

  // Phase 17 (Plan 17-02, D-05) — the debounce window for the plan auto-push.
  // ~10s after edits stop: a burst of N edits collapses to ONE bounded push
  // (T-17-07 — never per-keystroke). Module-level would be cleaner but the timer
  // handle must live on `this` for the flush-on-close path to clear it.
  get _PLAN_PUSH_DEBOUNCE_MS() { return 10000; },

  /**
   * _schedulePlanPush — Phase 17 (Plan 17-02, D-05). The DEBOUNCED remote push.
   * Called from every plan-mutation path ALONGSIDE the existing synchronous
   * localStorage persist (the debounce is the REMOTE push only — local persist
   * stays instant). Resets the ~10s timer on each call so a burst collapses to one
   * push when edits stop. No-op when not connected (nothing to push to). The timer
   * fires pushPlanToRemote, which owns its own error channel.
   */
  _schedulePlanPush() {
    if (!this.githubConnected || !this.githubToken) return; // nothing to sync to
    this._planPushPending = true;
    if (this._planPushTimer) { clearTimeout(this._planPushTimer); }
    this._planPushTimer = setTimeout(() => {
      this._planPushTimer = null;
      this._planPushPending = false;
      // Fire-and-forget; pushPlanToRemote routes its own failures to mealPlanSyncStatus.
      this.pushPlanToRemote();
    }, this._PLAN_PUSH_DEBOUNCE_MS);
  },

  /**
   * _flushPlanPush — Phase 17 (Plan 17-02, D-05 safety net). If a debounced push
   * is pending, clear the timer and push IMMEDIATELY. Called on meal-plan-view
   * close / navigation-away so an un-flushed edit is never stranded. Idempotent /
   * safe when nothing is pending (no-op).
   */
  _flushPlanPush() {
    if (!this._planPushTimer && !this._planPushPending) return;
    if (this._planPushTimer) { clearTimeout(this._planPushTimer); this._planPushTimer = null; }
    this._planPushPending = false;
    if (!this.githubConnected || !this.githubToken) return;
    this.pushPlanToRemote(); // fire-and-forget; own error channel
  },

  /**
   * pullPlanFromRemote — Phase 17 (Plan 17-02, D-06). Pull the latest meal_plan.json
   * and apply it before render. NON-FATAL: a missing file (404) or any reach error
   * routes to the own channel and returns, leaving the local cache in place (mirrors
   * pullFromRemote / loadFromStore boot-pull discipline at app.js init pull). On
   * success it applies the pulled doc into Alpine state, adopts it as the 3-way base,
   * and caches the sha. The CALLER (openMealPlan) runs the reconcile loop afterwards
   * so an entry whose recipe_id is gone is dropped + names refresh.
   */
  async pullPlanFromRemote() {
    if (!this.githubConnected || !this.githubToken) return; // nothing to pull
    const cfg = this.githubCfg; // fresh per call (rotated token)
    this.planSyncing = true;
    try {
      const { text, sha } = await ghGetFile(cfg, 'meal_plan.json');
      const parsed = JSON.parse(text);
      // Shape gate (WR-01): the boot-pull path rejects a structurally-wrong remote
      // via putJsonFile's shapeCheck. This pull-on-open path now 3-way-MERGES the
      // pulled doc with the local plan (below) rather than applying it directly, but
      // the gate is still load-bearing: without it a valid-JSON-but-wrong-shape
      // remote (e.g. `{}`, a manual edit) would coerce to empty and feed an empty doc
      // into the merge / become a new base. Skip-and-keep-local entirely instead —
      // a wrong-shape remote never becomes a merge input nor a new base.
      if (!this._jsonShapeCheckFor('meal_plan.json')(parsed)) {
        this.mealPlanSyncStatus = 'Remote plan has an unexpected shape — kept your local plan.';
        return;
      }
      const pulled = coerceSharedPlanDoc(parsed);
      // quick 260628-it8 — 3-WAY MERGE on pull-on-open (do NOT wholesale-replace).
      // Previously applySharedPlanDoc(pulled) clobbered a richer LOCAL plan with an
      // emptier remote (real data loss, 2026-06-28). Mirror the merge-on-push path
      // (_pushPlanOnce): merge this device's local plan (vs the persisted base) onto
      // the fresh remote so local-only entries are UNIONED in, never dropped.
      // mergeMealPlan is pure, idempotent against the base, and already covered by
      // scripts/mealplan-sync.test.mjs.
      const base = this._mealPlanBase || this._restoreMealPlanBase();
      const local = this.buildSharedPlanDoc();
      const merged = mergeMealPlan(base, local, pulled);
      this.applySharedPlanDoc(merged);
      this._mealPlanSha = sha;
      // Base = the ACTUAL remote we just observed (NOT `merged`). Local-only entries
      // must read as "new vs base" on the next push so they PROPAGATE; adopting
      // `merged` as the base would make them "in base, absent on remote" → delete-wins
      // would eat them on the next push. (merged != remote until a push writes it out.)
      this._persistMealPlanBase(pulled);
      this.mealPlanLastSyncedAt = new Date().toISOString();
      this.mealPlanSyncStatus = '';
    } catch (e) {
      if (e && e.status === 404) {
        // Optional-absent (D-15): the file does not exist yet. NOT an error — the
        // local plan is authoritative until this device's first push creates it.
        this.mealPlanSyncStatus = '';
        return;
      }
      if (e instanceof SyntaxError) {
        // Invalid JSON (a status-less error) — githubFriendlyError would mislabel it
        // "Couldn't reach GitHub" (IN-02). Give a data-format message; keep local.
        this.mealPlanSyncStatus = 'Remote plan could not be read — file may be corrupted.';
        return;
      }
      // Any other failure: own channel, render the local cache (NEVER parseError).
      this.mealPlanSyncStatus = this.githubFriendlyError(e);
      this._maybeRateLimitBanner(e);
    } finally {
      this.planSyncing = false;
    }
  },

  /**
   * mealPlanSyncLabel — Phase 17 (Plan 17-02, D-07). The binding surface for the
   * Plan 04 UI. Side-effect-free getter (mirrors lastSyncedLabel's shape):
   *   - 'Syncing…' while a push/pull is in flight OR a debounced push is pending
   *   - an own-channel error copy when mealPlanSyncStatus is set
   *   - 'Synced' just now / 'Last synced HH:MM' otherwise
   *   - 'Not synced yet' when nothing has synced and nothing is connected
   */
  get mealPlanSyncLabel() {
    if (this.planSyncing || this._planPushPending) return 'Syncing…';
    if (this.mealPlanSyncStatus) return this.mealPlanSyncStatus;
    if (!this.mealPlanLastSyncedAt) return 'Not synced yet';
    const then = new Date(this.mealPlanLastSyncedAt).getTime();
    if (!Number.isFinite(then)) return 'Not synced yet';
    const mins = Math.floor((Date.now() - then) / 60000);
    if (mins < 1) return 'Synced';
    const d = new Date(this.mealPlanLastSyncedAt);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `Last synced ${hh}:${mm}`;
  },

  /**
   * syncPlanNow — Phase 17 (Plan 17-02, D-07). The manual "Sync now" action for the
   * Plan 04 UI — doubles as the fallback if a debounced push was missed. Flushes any
   * pending debounce then forces a push. await-able so the UI can show a spinner.
   */
  async syncPlanNow() {
    if (this._planPushTimer) { clearTimeout(this._planPushTimer); this._planPushTimer = null; }
    this._planPushPending = false;
    await this.pushPlanToRemote();
  },

  /**
   * cookIdOf — quick 260620-s49. Stable string identity for a resident, used for
   * x-model :value, label resolution and the max-3 cap check. Mirrors the join's
   * string-coercion of APPID (residents.js joinRoster coerces via String(...).trim())
   * so a checkbox :value matches the stored array entries. Decision 5: APPID is the
   * cook identity. Returns String(resident.APPID); never throws on a null resident.
   */
  cookIdOf(resident) {
    return String(resident && resident['APPID']);
  },

  /**
   * cooksForDay — quick 260620-s49. Return the stored cooks array for a date key,
   * LAZY-INITIALISING this.cooksByDay[dateKey] = [] when absent so x-model has a
   * stable array lvalue to bind to. Called from toggleCooksPopover BEFORE the
   * popover renders, guaranteeing the slot exists before the checkbox x-model
   * evaluates. Stores APPIDs verbatim (no type coercion here — decision 5).
   */
  cooksForDay(dateKey) {
    if (!Array.isArray(this.cooksByDay[dateKey])) {
      this.cooksByDay[dateKey] = [];
    }
    return this.cooksByDay[dateKey];
  },

  /**
   * cookOptionsForDay — quick 260620-s49. The ONLY checkbox options rendered: the
   * resident rows PRESENT that day (decision 6 — absent stored ids are NOT shown).
   * Delegates the present-on-D rule to residentsPresentOnDate; returns [] when the
   * roster isn't loaded or there's no roster — never throws.
   */
  cookOptionsForDay(dateKey) {
    return residentsPresentOnDate(this.joinedRoster || [], dateKey).present;
  },

  /**
   * cooksLabelFor — quick 260620-s49. Build the button label suffix: map each
   * STORED APPID to a PRESENT resident's Full name (matched on cookIdOf among
   * cookOptionsForDay), dropping any stored id with no present match (decision 6 —
   * omit absent, never deref null). Returns a comma-joined names string, or '' when
   * none resolve (the markup then shows the bare 'Cooks' label).
   */
  cooksLabelFor(dateKey) {
    const stored = Array.isArray(this.cooksByDay[dateKey]) ? this.cooksByDay[dateKey] : [];
    if (stored.length === 0) return '';
    const present = this.cookOptionsForDay(dateKey);
    const byId = new Map(present.map(r => [this.cookIdOf(r), r]));
    return stored
      .map(id => byId.get(String(id)))
      .filter(r => r != null)
      .map(r => r['Full name'] || '(unnamed)')
      .join(', ');
  },

  /**
   * cooksChipsFor — phase 09-08 / PORT-04. PRESENTATION helper: the same stored-id
   * → present-resident resolution as cooksLabelFor, but returns an ARRAY of
   * { id, name } objects so the day header can render one petrol chip per selected
   * cook (specimen `.cook-chip`) instead of a single comma-joined label. Reads the
   * SAME cooksByDay / cookOptionsForDay source of truth — adds no new data; drops
   * any stored id with no present match (decision 6). Pure read, no writes.
   */
  cooksChipsFor(dateKey) {
    const stored = Array.isArray(this.cooksByDay[dateKey]) ? this.cooksByDay[dateKey] : [];
    if (stored.length === 0) return [];
    const present = this.cookOptionsForDay(dateKey);
    const byId = new Map(present.map(r => [this.cookIdOf(r), r]));
    return stored
      .map(id => ({ id: String(id), r: byId.get(String(id)) }))
      .filter(x => x.r != null)
      .map(x => ({ id: x.id, name: this._abbrevCookName(x.r['Full name'] || '(unnamed)') }));
  },

  /**
   * _abbrevCookName — Round-2 fidelity (quick 260625-itm). The cooks-chip display
   * abbreviates a roster Full name to "First L." (specimen `.cook-chip`), saving the
   * day-header width. DISPLAY ONLY — cooksByDay still stores APPIDs; the popover still
   * shows full names. "Mara Robertson" → "Mara R."; single-token names pass through.
   */
  _abbrevCookName(full) {
    const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) return parts[0] || '(unnamed)';
    return `${parts[0]} ${parts[parts.length - 1].charAt(0)}.`;
  },

  /**
   * removeCookFromDay — phase 09-08 / PORT-04. Unselect ONE cook directly from its
   * header chip (the chip's ✕). Mutates the SAME cooksByDay array the popover's
   * checkbox x-model writes to (lazy-inits via cooksForDay first so the lvalue
   * exists), removing the id, then persists via the existing _persistMealPlanUi —
   * identical end-state to unticking that cook's checkbox in the popover. No new
   * data model; the 3-cook cap / present-only gating are unaffected (removal only
   * ever shrinks the selection).
   */
  removeCookFromDay(dateKey, id) {
    const arr = this.cooksForDay(dateKey);
    const idx = arr.indexOf(String(id));
    if (idx !== -1) {
      arr.splice(idx, 1);
      this._persistMealPlanUi();
    }
  },

  /**
   * openTrayModal / openPrepModal / closeTrayModal / closePrepModal —
   * phase 09-08 / PORT-04 (D24). Open/close the Tray / Prep day DIALOGS by setting
   * the transient trayModalDay / prepModalDay key ('' = closed). These replace the
   * old inline trayCollapsedByDay / prepCollapsedByDay toggles. No persistence (view
   * state). The modal shells (rendered ONCE, outside the day x-for) resolve their
   * content via trayModalGroup / prepModalGroup.
   */
  openTrayModal(dateKey) { this.trayModalDay = dateKey; },
  closeTrayModal() { this.trayModalDay = ''; },
  openPrepModal(dateKey) { this.prepModalDay = dateKey; },
  closePrepModal() { this.prepModalDay = ''; },
  // quick 260627-r94 (R94-3) — open/close the per-day ALLERGEN modal (the header icon
  // opens it; Escape/backdrop/Close dismiss). Mirrors openTrayModal/openPrepModal.
  openAllergenModal(dateKey) { this.allergenModalDay = dateKey; },
  closeAllergenModal() { this.allergenModalDay = ''; },

  /**
   * togglePrepDone — quick 260627-iy8. Flip the prep-done state for a day key and
   * persist. Mirrors the dayLeftovers inline reactive key-write idiom (direct key
   * assignment on the existing reactive object, then _persistMealPlanUi()). UI-prefs
   * ONLY (MEAL_PLAN_UI_KEY) — NEVER an IndexedDB/CSV write.
   */
  togglePrepDone(dateKey) {
    this.prepDoneByDay[dateKey] = this.prepDoneByDay[dateKey] === true ? false : true;
    this._persistMealPlanUi();
  },

  /**
   * trayModalGroup / prepModalGroup — phase 09-08 / PORT-04. Resolve the day-group
   * object ({ key, label, entries }) whose Tray / Prep modal is open, looked up by
   * key from visiblePlanByDay (the SAME projection the day cards render from). Returns
   * null when none is open or the key no longer matches a visible day (so the modal
   * shell's x-show stays false and never derefs null). Pure read.
   */
  get trayModalGroup() {
    if (!this.trayModalDay) return null;
    return this.visiblePlanByDay.find(g => g.key === this.trayModalDay) || null;
  },
  get prepModalGroup() {
    if (!this.prepModalDay) return null;
    return this.visiblePlanByDay.find(g => g.key === this.prepModalDay) || null;
  },
  /**
   * allergenModalStatus — quick 260627-r94 (R94-3). Resolve the OPEN allergen modal's
   * day to the SAME discriminated object the old inline banner consumed
   * (dayAllergenStatus). Returns null when no modal is open or the key no longer maps a
   * visible day (so the modal x-show stays false and never derefs null). Pure read; the
   * SAFETY-CRITICAL classification stays untouched in dayAllergenStatus.
   */
  get allergenModalStatus() {
    if (!this.allergenModalDay) return null;
    const group = this.visiblePlanByDay.find(g => g.key === this.allergenModalDay) || null;
    if (!group) return null;
    return this.dayAllergenStatus(group);
  },
  /**
   * allergenModalLabel — quick 260627-r94 (R94-3). The OPEN allergen modal day's label
   * for the modal title; '' when none open / not found. Pure read.
   */
  get allergenModalLabel() {
    if (!this.allergenModalDay) return '';
    const group = this.visiblePlanByDay.find(g => g.key === this.allergenModalDay) || null;
    return group ? (group.label || '') : '';
  },

  /**
   * cookDisabledFor — quick 260620-s49. Decision 2: cap at 3 cooks/day. Returns
   * true iff the stored array already holds 3 entries AND residentId (stringified
   * via cookIdOf semantics) is NOT already selected — so unselected checkboxes
   * disable at the cap while already-checked ones stay toggleable.
   */
  cookDisabledFor(dateKey, residentId) {
    const stored = Array.isArray(this.cooksByDay[dateKey]) ? this.cooksByDay[dateKey] : [];
    const id = String(residentId);
    return stored.length >= 3 && !stored.includes(id);
  },

  /**
   * toggleCooksPopover — quick 260620-s49. Open/close the per-day cooks popover
   * (one at a time). ENSURES cooksForDay(dateKey) is initialised first so the
   * x-model array lvalue exists before the popover's checkboxes bind, then toggles
   * cooksPopoverOpenFor between dateKey and '' (transient; not persisted).
   */
  toggleCooksPopover(dateKey) {
    this.cooksForDay(dateKey); // lazy-init the array before x-model binds
    this.cooksPopoverOpenFor = (this.cooksPopoverOpenFor === dateKey) ? '' : dateKey;
  },

  /**
   * mealPlanHiddenFilterCount — quick 260620-fn6. Count of active HIDDEN filters
   * only (those moved into the Filters disclosure): avoid-allergens + min-servings
   * + max-difficulty. Drives the accent badge on the Filters disclosure button.
   * Mirrors the exact emptiness checks filteredMealPlanPickList uses: minServings
   * is "off" when '' or non-finite; maxDifficulty is "off" when falsy. Type / Sort
   * / Hide-planned live OUTSIDE the disclosure and are deliberately excluded.
   */
  get mealPlanHiddenFilterCount() {
    return (Array.isArray(this.mealPlanAllergenFilter) ? this.mealPlanAllergenFilter.length : 0)
      + (Number.isFinite(Number(this.mealPlanMinServings)) && this.mealPlanMinServings !== '' ? 1 : 0)
      + (this.mealPlanMaxDifficulty ? 1 : 0);
  },

  /**
   * clearMealPlanFilters — quick 260620-fn6. Reset ALL picker filters to their
   * existing defaults (the "Clear" link in the meta row). UI state ONLY — no
   * putFile / no IndexedDB / no localStorage write. Deliberately does NOT touch
   * mealPlanFiltersOpen (disclosure stays as the user left it) or the outer
   * mealPlanPickerCollapsed (the Add-recipes zone collapse is separate).
   */
  clearMealPlanFilters() {
    this.mealPlanFilter = '';
    this.mealPlanTypeFilter = [];
    this.mealPlanAllergenFilter = [];
    this.mealPlanMinServings = '';
    this.mealPlanMaxDifficulty = '';
    this.mealPlanHidePlanned = false;
    this.mealPlanSort = 'default';
  },

  /**
   * filteredMealPlanPickList — the recipe picker source. Self-contained — NEVER
   * reads or mutates recipe-manager filter state.
   * quick 260615-lzq — repeats allowed (a recipe can be planned for multiple days).
   * quick 260618-e1z — refactored into a staged AND filter + final STABLE sort,
   * mirroring filteredRecipeList's composition. Stages (all AND, in order):
   *   1. NAME    — case-insensitive substring on mealPlanFilter (existing behaviour).
   *   2. TYPE    — manager semantics: empty = all; blank-type hidden once any selected.
   *   3. ALLERGEN-AVOID — reuses allergensByRecipeId + allergenFilterAvailable; no-op
   *      unless available AND ≥1 avoided. SAFETY: NEVER hides incomplete/unknown recipes.
   *   4. MAX-SERVINGS ≥ N — when Number(mealPlanMinServings) is finite, keep
   *      max_servings == null (blank ALWAYS shown) OR >= N; only KNOWN values < N hidden.
   *   5. MAX-DIFFICULTY ≤ N — when mealPlanMaxDifficulty parses to finite 1..5, keep
   *      difficulty != null && <= N (null/unknown hidden while active).
   *   6. HIDE-PLANNED — when mealPlanHidePlanned, drop recipe_ids in upcomingEntries.
   * SORT (final, STABLE via decorate-with-original-index tie-break):
   *   'default'           → recipeList order (no reorder).
   *   'least-recent'      → never-made ('' last_made) FIRST, then dated ASC (YYYY-MM-DD).
   *   'max-servings-desc' → max_servings DESC, null/blank LAST.
   *   'easiest'           → difficulty ASC, null/blank LAST.
   */
  get filteredMealPlanPickList() {
    let result = Array.isArray(this.recipeList) ? this.recipeList : [];

    // Stage 1 — NAME (existing case-insensitive substring).
    const q = (this.mealPlanFilter || '').trim().toLowerCase();
    if (q) result = result.filter(r => (r.name || '').toLowerCase().includes(q));

    // Stage 2 — TYPE (manager semantics; empty = all; blank type hidden once any selected).
    const types = Array.isArray(this.mealPlanTypeFilter) ? this.mealPlanTypeFilter : [];
    if (types.length > 0) {
      const wanted = new Set(types.map(t => (t || '').trim().toLowerCase()));
      result = result.filter(r => wanted.has((r.type || '').trim().toLowerCase()));
    }

    // Stage 3 — ALLERGEN-AVOID (reuse manager machinery; never hide incomplete/unknown).
    const avoided = Array.isArray(this.mealPlanAllergenFilter) ? this.mealPlanAllergenFilter : [];
    if (this.allergenFilterAvailable && avoided.length > 0) {
      const avoidSet = new Set(avoided);
      const byId = this.allergensByRecipeId;
      result = result.filter(r => {
        const entry = byId.get(r.recipe_id);
        if (!entry || entry.incomplete) return true; // never hide incomplete/unknown — SAFETY
        return !entry.allergens.some(a => avoidSet.has(a));
      });
    }

    // Stage 4 — MAX-SERVINGS ≥ N. ALWAYS keep null/unknown max_servings (can't be
    // ruled out, and a blank shouldn't drop a recipe); only hide KNOWN values < N.
    const minServings = Number(this.mealPlanMinServings);
    if (Number.isFinite(minServings) && this.mealPlanMinServings !== '') {
      result = result.filter(r => r.max_servings == null || r.max_servings >= minServings);
    }

    // Stage 5 — MAX-DIFFICULTY ≤ N (null/unknown hidden while active).
    const maxDiff = Number(this.mealPlanMaxDifficulty);
    if (Number.isFinite(maxDiff) && this.mealPlanMaxDifficulty !== '') {
      result = result.filter(r => r.difficulty != null && r.difficulty <= maxDiff);
    }

    // Stage 6 — HIDE-PLANNED (drop recipe_ids already in the upcoming plan).
    if (this.mealPlanHidePlanned) {
      const plannedIds = new Set((this.upcomingEntries || []).map(e => e.recipe_id));
      result = result.filter(r => !plannedIds.has(r.recipe_id));
    }

    // FINAL SORT — stable via decorate-sort-undecorate (original index tie-break).
    const sort = this.mealPlanSort || 'default';
    if (sort === 'default') return result;
    const decorated = result.map((r, i) => ({ r, i }));
    let cmp;
    if (sort === 'least-recent') {
      // never-made ('') FIRST, then dated ASC (YYYY-MM-DD sorts correctly as string).
      cmp = (a, b) => {
        const av = a.r.last_made || '';
        const bv = b.r.last_made || '';
        if (av === bv) return 0;
        if (av === '') return -1; // never-made first
        if (bv === '') return 1;
        return av < bv ? -1 : 1;
      };
    } else if (sort === 'max-servings-desc') {
      cmp = (a, b) => {
        const av = a.r.max_servings, bv = b.r.max_servings;
        if (av == null && bv == null) return 0;
        if (av == null) return 1;  // null/blank LAST
        if (bv == null) return -1;
        return bv - av;            // DESC
      };
    } else if (sort === 'easiest') {
      cmp = (a, b) => {
        const av = a.r.difficulty, bv = b.r.difficulty;
        if (av == null && bv == null) return 0;
        if (av == null) return 1;  // null/blank LAST
        if (bv == null) return -1;
        return av - bv;            // ASC
      };
    } else {
      return result; // unknown sort key → no reorder
    }
    decorated.sort((a, b) => {
      const c = cmp(a, b);
      return c !== 0 ? c : a.i - b.i; // stable tie-break on original index
    });
    return decorated.map(d => d.r);
  },

  /**
   * mealPlanByDay — quick 260615-lzq. Group the meal-plan entries by their `date`
   * for the day-grouped UI. Returns [{ key, label, entries }]: scheduled days
   * (non-empty date) sorted ASCENDING by the raw 'YYYY-MM-DD' string (which sorts
   * correctly lexicographically), each labelled "[Weekday], DD/MM"; then a single
   * { key:'', label:'Unscheduled', entries } group LAST, included ONLY if the
   * unscheduled bucket is non-empty.
   *
   * Local-time rationale (off-by-one): a 'YYYY-MM-DD' string is parsed by SPLITTING
   * on '-' and building `new Date(y, m-1, d)` (LOCAL midnight). We deliberately do
   * NOT use `new Date('2026-06-15')` — that parses as UTC midnight and renders the
   * PREVIOUS day's weekday in negative-UTC timezones. A malformed date (not three
   * numeric parts) is treated as Unscheduled rather than throwing.
   */
  // quick 260618-ahg — LOCAL 'YYYY-MM-DD' for today. Built from getFullYear/
  // getMonth/getDate (NOT toISOString, which is UTC and wrong in negative-UTC
  // zones), mirroring the local-midnight rationale documented above mealPlanByDay.
  // String-comparable against a zero-padded entry.date.
  get todayStr() {
    const now = new Date();
    const y = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return `${y}-${mm}-${dd}`;
  },

  // quick 260618-ahg — PAST predicate, defined ONCE and reused by both filters.
  // An entry is PAST iff its date is exactly three finite numeric parts AND
  // strictly less than today (zero-padded string compare is correct). Everything
  // else — '', malformed, or >= today (today INCLUDED) — is UPCOMING.
  _entryIsPast(entry) {
    const raw = (entry && typeof entry.date === 'string') ? entry.date : '';
    const parts = raw.split('-');
    if (parts.length !== 3) return false;
    if (!parts.every(p => Number.isFinite(Number(p)))) return false;
    return raw < this.todayStr;
  },

  // quick 260618-ahg — grouping body EXTRACTED verbatim from the old mealPlanByDay.
  // Operates on a passed entries array. Scheduled groups sort ASC by default, DESC
  // when { descending: true }; the Unscheduled group (key '') is ALWAYS last.
  // quick 260621-amm — EXTRACTED from _groupEntriesByDay's old inline labelFor so
  // both the grouper and the synthesised 14-day window share ONE label formula.
  // Returns "[Weekday], DD/MM" for a valid 'YYYY-MM-DD' (LOCAL midnight — avoids the
  // UTC off-by-one), or null for a malformed/blank string. '' → '' is handled by
  // callers that want a graceful degrade (e.g. mealPlanPickerTargetLabel).
  _dayLabel(dateStr) {
    const parts = String(dateStr).split('-');
    if (parts.length !== 3) return null;
    const y = Number(parts[0]);
    const m = Number(parts[1]);
    const d = Number(parts[2]);
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
    const dt = new Date(y, m - 1, d); // LOCAL midnight — avoids the UTC off-by-one.
    const weekday = dt.toLocaleDateString(undefined, { weekday: 'long' });
    const dd = String(d).padStart(2, '0');
    const mm = String(m).padStart(2, '0');
    return `${weekday}, ${dd}/${mm}`;
  },

  // F5 (quick 260625-itm) — SEPARATE chip-label helper for the day-header date tick
  // (specimen `.day-tick`): 3-letter UPPERCASE weekday + ' ' + DD/MM, e.g. "FRI 26/06".
  // PURE display read — NO writes, NO change to grouping/keys/persistence. Distinct
  // from _dayLabel (which stays "Weekday, DD/MM" and is shared by the subtitle, picker,
  // cook-artifact + tray export — must NOT be mutated). Returns '' for blank/malformed
  // (the day header falls back to group.label "Unscheduled" in that case).
  dayTickLabel(dateStr) {
    const parts = String(dateStr).split('-');
    if (parts.length !== 3) return '';
    const y = Number(parts[0]);
    const m = Number(parts[1]);
    const d = Number(parts[2]);
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return '';
    const dt = new Date(y, m - 1, d); // LOCAL midnight — avoids the UTC off-by-one.
    const weekday = dt.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase();
    const dd = String(d).padStart(2, '0');
    const mm = String(m).padStart(2, '0');
    return `${weekday} ${dd}/${mm}`;
  },

  // quick 260621-co6 — return the SAME day key _groupEntriesByDay would compute for a
  // SINGLE entry, so the shopping-list filter and the day headers agree on keys
  // (including the Unscheduled '' case for blank/malformed dates). Verbatim to the
  // grouper's per-entry logic: a malformed/blank date maps to '' (Unscheduled).
  _dayKeyForEntry(entry) {
    const raw = (entry && typeof entry.date === 'string') ? entry.date : '';
    return (raw && this._dayLabel(raw) !== null) ? raw : '';
  },

  // quick 260627-i6h (D13a) — the ONLY definition of order-scope range membership.
  // Reused by BOTH shopping read-sites AND the UI chip/menu — do NOT duplicate this
  // logic. PURE read, no writes. Rules:
  //   - orderScopeRange not a plain non-null object (incl. null) → true (whole plan =
  //     the default = current behaviour exactly).
  //   - a blank/Unscheduled key ('') → false: an undated day cannot sit in a dated
  //     range (preserves "Unscheduled drops out when a range is set").
  //   - else dayKey >= startKey && dayKey <= endKey (lexicographic ISO compare).
  //   - defensive: if startKey/endKey are missing/non-string, treat range as unset →
  //     true (fail-open to whole plan, never silently hide everything).
  isDayInOrderScope(dayKey) {
    const r = this.orderScopeRange;
    if (!r || typeof r !== 'object' || Array.isArray(r)) return true; // whole plan
    if (typeof r.startKey !== 'string' || typeof r.endKey !== 'string') return true; // unset → whole plan
    if (!dayKey) return false; // undated/Unscheduled can't be in a dated range
    return dayKey >= this.orderScopeRange.startKey && dayKey <= this.orderScopeRange.endKey;
  },

  // quick 260627-i6h (D13a) — the ASCENDING list of DATED day keys the range picker
  // offers, derived from upcomingByDay's group keys (already ASC by its construction)
  // EXCLUDING the '' Unscheduled key (an undated group can't be a range endpoint).
  // PURE read; both From/To <select>s iterate this.
  get orderScopeDayKeys() {
    return (this.upcomingByDay || [])
      .map(g => g.key)
      .filter(k => k !== '');
  },

  // quick 260627-i6h (D13a) — the scope chip's text. null range → 'whole plan ▾'
  // (byte-identical to the old static label). A range → a compact mono label built
  // from its endpoints via the SHARED dayTickLabel helper (no second date-formatting
  // path); collapses to a single tick when start === end. PURE read.
  get orderScopeChipLabel() {
    const r = this.orderScopeRange;
    if (!r || typeof r !== 'object' || Array.isArray(r)
        || typeof r.startKey !== 'string' || typeof r.endKey !== 'string') {
      return 'whole plan ▾';
    }
    const start = this.dayTickLabel(r.startKey);
    const end = this.dayTickLabel(r.endKey);
    return (r.startKey === r.endKey)
      ? `${start} ▾`
      : `${start} → ${end} ▾`;
  },

  // quick 260627-i6h (D13a) — toggle the range picker. When OPENING, seed the From/To
  // select bindings from the active range (or the first/last dated day when no range
  // is set) so the selects reflect current scope. TRANSIENT (scopePickerOpen + the
  // From/To bindings are view-only state, never serialized); the real persisted
  // mutation happens in applyOrderScope on a select change.
  toggleScopePicker() {
    this.scopePickerOpen = !this.scopePickerOpen;
    if (!this.scopePickerOpen) return;
    const keys = this.orderScopeDayKeys;
    const first = keys.length ? keys[0] : '';
    const last = keys.length ? keys[keys.length - 1] : '';
    const r = this.orderScopeRange;
    const hasRange = r && typeof r === 'object' && !Array.isArray(r)
      && typeof r.startKey === 'string' && typeof r.endKey === 'string';
    this.scopeFromKey = hasRange ? r.startKey : first;
    this.scopeToKey = hasRange ? r.endKey : last;
  },

  // quick 260627-i6h (D13a) — apply a contiguous from→to range. Defensively coerce to
  // strings; a blank endpoint is a no-op. Swap if startKey > endKey (lexicographic) so
  // the stored range is ALWAYS ordered. Persists the new orderScopeRange. Does NOT
  // close the picker (the user may still be adjusting the other endpoint — the popover
  // closes on @click.outside or via the "Whole plan" reset). Models the persisted
  // UI-pref pattern (cooksPopover + the persist helper).
  applyOrderScope(startKey, endKey) {
    let s = (startKey == null) ? '' : String(startKey);
    let e = (endKey == null) ? '' : String(endKey);
    if (!s || !e) return; // need both endpoints
    if (s > e) { const t = s; s = e; e = t; } // keep the range ordered
    this.orderScopeRange = { startKey: s, endKey: e };
    this._persistMealPlanUi();
  },

  // quick 260627-i6h (D13a) — the "Whole plan" reset: clear the range (null) and
  // persist. Restores full whole-plan shopping + regulars output. The markup closes
  // the popover alongside this call.
  clearOrderScope() {
    this.orderScopeRange = null;
    this._persistMealPlanUi();
  },

  // quick 260621-lft — step a 'YYYY-MM-DD' key by ±1 LOCAL day (offset = +1 next,
  // -1 previous). LOCAL-midnight arithmetic like windowDayKeys/_dayLabel (never
  // toISOString — negative-UTC zones would render the wrong day). Returns '' for a
  // malformed/blank input so callers degrade gracefully.
  _stepDayKey(dateStr, offset) {
    const parts = String(dateStr).split('-');
    if (parts.length !== 3) return '';
    const y = Number(parts[0]);
    const m = Number(parts[1]);
    const d = Number(parts[2]);
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return '';
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + offset);
    const yy = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  },

  // quick 260621-lft — does dateStr have ANY upcoming meal-plan entries? Cheap scan
  // over upcomingEntries (small) using the SAME key formula as the day grouper, so
  // the answer agrees with what the day-group renders. Used to ignore a STALE
  // leftovers flag on a day that has since gained recipes.
  _dateHasEntries(dateStr) {
    if (!dateStr) return false;
    return (this.upcomingEntries || []).some((e) => this._dayKeyForEntry(e) === dateStr);
  },

  // quick 260621-lft — the leftover headcount rolling INTO dateStr from the next
  // calendar day. Non-zero only when that next day is flagged a leftovers day AND is
  // genuinely empty (stale-flag guard) AND the roster headcount is known. Returns 0
  // otherwise (incl. roster not loaded / blank key). NO chaining: only the single
  // immediately-following day can contribute (decision 1).
  _leftoverBonusInto(dateStr) {
    if (!dateStr) return 0;
    const nextKey = this._stepDayKey(dateStr, 1);
    if (!nextKey || this.dayLeftovers[nextKey] !== true) return 0;
    if (this._dateHasEntries(nextKey)) return 0;
    const hc = this.headcountForDate(nextKey);
    return hc === null ? 0 : hc;
  },

  _groupEntriesByDay(entries, { descending = false } = {}) {
    const list = Array.isArray(entries) ? entries : [];
    const groups = new Map(); // date string ('' = unscheduled) -> { key, label, entries }
    const labelFor = (dateStr) => this._dayLabel(dateStr);
    for (const entry of list) {
      const raw = (typeof entry.date === 'string') ? entry.date : '';
      let key = '';
      let label = 'Unscheduled';
      if (raw) {
        const lbl = labelFor(raw);
        if (lbl !== null) { key = raw; label = lbl; }
        // else: malformed date → falls through to Unscheduled.
      }
      if (!groups.has(key)) groups.set(key, { key, label, entries: [] });
      groups.get(key).entries.push(entry);
    }
    // Scheduled groups by date string (ASC default / DESC when requested); Unscheduled (key '') last.
    const scheduled = [...groups.values()]
      .filter(g => g.key !== '')
      .sort((a, b) => {
        const cmp = (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
        return descending ? -cmp : cmp;
      });
    const unscheduled = groups.get('');
    return unscheduled && unscheduled.entries.length ? [...scheduled, unscheduled] : scheduled;
  },

  // quick 260618-ahg — date-split filters. Upcoming = NOT past (today/future/undated/malformed).
  get upcomingEntries() {
    const entries = Array.isArray(this.mealPlan) ? this.mealPlan : [];
    return entries.filter(e => !this._entryIsPast(e));
  },
  get pastEntries() {
    const entries = Array.isArray(this.mealPlan) ? this.mealPlan : [];
    return entries.filter(e => this._entryIsPast(e));
  },

  // quick 260621-amm — the rolling 14-day window keys: today .. today+13 inclusive,
  // as 14 consecutive 'YYYY-MM-DD' strings. Built from the REAL current date each
  // call (parses todayStr, steps with LOCAL-midnight setDate — never toISOString, or
  // negative-UTC zones render the wrong day). RENDER-ONLY — not persisted anywhere.
  get windowDayKeys() {
    const parts = this.todayStr.split('-');
    const y = Number(parts[0]);
    const m = Number(parts[1]);
    const d = Number(parts[2]);
    const keys = [];
    for (let i = 0; i < 14; i++) {
      const dt = new Date(y, m - 1, d); // LOCAL midnight start-of-today
      dt.setDate(dt.getDate() + i);
      const yy = dt.getFullYear();
      const mm = String(dt.getMonth() + 1).padStart(2, '0');
      const dd = String(dt.getDate()).padStart(2, '0');
      keys.push(`${yy}-${mm}-${dd}`);
    }
    return keys;
  },

  // quick 260618-ahg / rebuilt quick 260621-amm — the Upcoming tab's day groups.
  // DAYS-FIRST projection (RENDER-ONLY — the mealPlan data model is untouched):
  //   1. The 14 rolling window days (today..today+13) ALWAYS present, even empty,
  //      each { key, label, entries: [] } seeded then filled from in-window entries.
  //   2. BELOW the window: any upcoming entries dated AFTER today+13, ASC, in their
  //      own day-groups.
  //   3. LAST: the Unscheduled group (key '') ONLY when it has entries.
  // _groupEntriesByDay does the heavy grouping; we overlay the window on top.
  get upcomingByDay() {
    const grouped = this._groupEntriesByDay(this.upcomingEntries); // scheduled ASC, Unscheduled last (if any)
    const winKeys = this.windowDayKeys;
    const winFirst = winKeys[0];
    const winLast = winKeys[winKeys.length - 1];

    // Index real scheduled groups by key for O(1) overlay; pull out Unscheduled.
    const byKey = new Map();
    let unscheduled = null;
    for (const g of grouped) {
      if (g.key === '') { unscheduled = g; continue; }
      byKey.set(g.key, g);
    }

    // 1. The 14 window slots — always present, filled from in-window real groups.
    const windowDays = winKeys.map(key => {
      const hit = byKey.get(key);
      return hit ? hit : { key, label: this._dayLabel(key), entries: [] };
    });

    // 2. Beyond-window scheduled groups (key > winLast), ASC. (Anything before
    //    winFirst is already excluded by upcomingEntries / not-past, but guard anyway.)
    const beyond = grouped.filter(g =>
      g.key !== '' && (g.key > winLast || g.key < winFirst)
    );

    // 3. Unscheduled last, only when non-empty (it is omitted by the grouper otherwise).
    return unscheduled
      ? [...windowDays, ...beyond, unscheduled]
      : [...windowDays, ...beyond];
  },
  get pastByDay() {
    return this._groupEntriesByDay(this.pastEntries, { descending: true });
  },

  // quick 260618-ahg — mealPlanByDay now delegates to the extracted grouper.
  get mealPlanByDay() {
    return this._groupEntriesByDay(Array.isArray(this.mealPlan) ? this.mealPlan : []);
  },

  // quick 260618-ahg — what the main loop binds to: the active tab's day groups.
  get visiblePlanByDay() {
    return this.mealPlanTab === 'past' ? this.pastByDay : this.upcomingByDay;
  },

  /**
   * scaledRowsFor — quick 260611-enp. Given a mealPlan entry, compute its scale
   * factor from entry.servings and map this recipe's READ-ONLY source rows through
   * scaleRow. Because it READS entry.servings + this.mealPlanGrouped, Alpine
   * re-invokes it reactively whenever a servings input changes — that IS the live
   * recompute. Kept DERIVED (called inside x-for); the scaled result is never
   * cached in stored state. A null factor (blank/0/negative servings) makes
   * scaleRow pass the originals through (no NaN) — the template shows a "set a
   * servings number" hint in that case instead of these rows.
   */
  scaledRowsFor(entry) {
    const f = factor(entry && entry.servings);
    const src = (entry && this.mealPlanGrouped[entry.recipe_id]) || [];
    // quick 260612-dr4 — pass the per-category strength map so seasoning/leavening
    // scale sub-linearly and fixed items stay at base. combinedShoppingList sums
    // this output, so it inherits the nonlinearity with no change of its own.
    return src.map(row => scaleRow(row, f, this.strengthByCategory));
  },

  /**
   * trayForDay — quick 260615-ms3. PURE per-day mise-en-place "tray" aggregation,
   * called from inside the mealPlanByDay x-for loop as trayForDay(group.entries).
   * Unlike combinedShoppingList it includes EVERYTHING for the day — pantry staples
   * AND optional/garnish/to-taste roles — summed across the day's recipes, grouped by
   * storage location. The SUMMATION reuses the SAME shared helpers (_ensureAccEntry /
   * _accumulateRow / _derivePartsCaveat / _derivePackCount) that combinedShoppingList
   * uses, so amounts/caveats/packs can never drift from the shopping list. It does NOT
   * re-derive day grouping (the caller's x-for already did). Returns the _groupBySection
   * sectioned array ([{ section, items }]).
   * @param {Array} entries — one day-group's mealPlan entries.
   */
  trayForDay(entries) {
    const list = Array.isArray(entries) ? entries : [];
    // masterById built the SAME way combinedShoppingList does (data assembly, not the
    // load-bearing summation — that is shared via the Task 1 methods).
    const masterById = new Map(
      (Array.isArray(this.ingredientMaster) ? this.ingredientMaster : [])
        .map(m => [m.ingredient_id, { ingredient_name: m.ingredient_name, shopping_unit: m.shopping_unit, pantry_staple: m.pantry_staple, pantry_section: m.pantry_section, pack_size: m.pack_size, pack_unit: m.pack_unit, pack_units: m.pack_units, pack_unit_label: m.pack_unit_label, regular: m.regular, regular_qty_per_person: m.regular_qty_per_person }]) // regular/regular_qty_per_person: phase 08 REG-05 (Plan 01 read-side deferral mirrored here)
    );

    const acc = new Map();        // keyed by ingredient_id (matched rows)
    const unknownAcc = new Map(); // keyed by 'name:'+name (blank/unmatched ingredient_id)
    const roleByKey = new Map();  // first-seen role per acc/unknown key
    const stapleByKey = new Map();// pantry_staple per acc key (from master)
    const nameByKey = new Map();  // display name (master-name-first) per key

    for (const entry of list) {
      const rows = this.scaledRowsFor(entry);
      for (const row of rows) {
        const iid = row.ingredient_id;
        const role = row.role || 'required';
        const master = (iid != null) ? masterById.get(iid) : undefined;
        // NO role filter, NO staple exclusion — the tray includes everything.
        if (iid == null || !master) {
          // Unmatched / blank id: accumulate by NAME, synthetic metric master so
          // _accumulateRow sums metric-by-unit. Never cross-summed with matched rows.
          const nm = this.masterIngredientName(iid, row.ingredient_name) || '(unnamed ingredient)';
          const key = 'name:' + nm;
          this._accumulateRow(this._ensureAccEntry(unknownAcc, key, { shopping_unit: 'metric', ingredient_name: nm }, row), { shopping_unit: 'metric' }, row);
          if (!roleByKey.has(key)) roleByKey.set(key, role);
          if (!nameByKey.has(key)) nameByKey.set(key, nm);
          continue;
        }
        const key = iid;
        this._accumulateRow(this._ensureAccEntry(acc, iid, master, row), master, row);
        if (!roleByKey.has(key)) roleByKey.set(key, role);
        if (!stapleByKey.has(key)) stapleByKey.set(key, !!master.pantry_staple);
        if (!nameByKey.has(key)) nameByKey.set(key, this.masterIngredientName(iid, row.ingredient_name) || '(unnamed ingredient)');
      }
    }

    const items = [];
    for (const [iid, a] of acc.entries()) {
      const { parts, caveat } = this._derivePartsCaveat(a);
      const m = masterById.get(iid);
      items.push({
        ingredient_id: iid,
        ingredient_name: nameByKey.get(iid) || a.ingredient_name,
        parts,
        caveat,
        packs: this._derivePackCount(parts, caveat, m),
        pack_size: m?.pack_size ?? null,
        pack_units: m?.pack_units ?? null,
        pack_unit_label: m?.pack_unit_label || '',
        role: roleByKey.get(iid) || 'required',
        pantry_staple: !!stapleByKey.get(iid),
        pantry_section: m?.pantry_section || ''
      });
    }
    for (const [key, a] of unknownAcc.entries()) {
      const { parts, caveat } = this._derivePartsCaveat(a);
      items.push({
        ingredient_id: null,
        ingredient_name: nameByKey.get(key) || a.ingredient_name,
        parts,
        caveat,
        packs: null,
        pack_size: null,
        pack_units: null,
        pack_unit_label: '',
        role: roleByKey.get(key) || 'required',
        pantry_staple: false,
        pantry_section: ''
      });
    }
    return this._groupBySection(items);
  },

  /**
   * prepForDay — quick 260621-sjs. PURE per-day advance-prep aggregation, called
   * from inside the mealPlanByDay x-for loop as prepForDay(group.entries). Returns
   * one { recipe_id, name, prep_notes } per UNIQUE recipe_id (first-seen order),
   * INCLUDING ONLY recipes whose recipe-level prep_notes (looked up in
   * this.recipePrepById) is a non-blank string. A recipe scheduled twice the same
   * day appears once. Locked decision: reads recipe-level prep_notes ONLY from
   * recipePrepById — it MUST NOT touch recipe_ingredients / ingredient-level
   * prep_note. The display name comes from the entry (falls back to '').
   * @param {Array} entries — one day-group's mealPlan entries.
   */
  prepForDay(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const seen = new Set();
    const out = [];
    for (const entry of list) {
      // Coerce to the numeric key written by _rebuildMealPlanGrouped.
      const rid = parseInt(entry.recipe_id, 10);
      if (Number.isNaN(rid) || seen.has(rid)) continue;
      const prep_notes = this.recipePrepById[rid] ?? '';
      if ((prep_notes ?? '').trim() === '') continue;
      seen.add(rid);
      out.push({ recipe_id: rid, name: entry.name ?? '', prep_notes });
    }
    return out;
  },

  /**
   * factorOrNull — quick 260611-enp. Thin template-facing wrapper around the
   * imported scale.js factor() (Alpine expressions can only call methods on the
   * component, not module-scope imports). Returns null for blank/0/negative
   * servings so the template can show a "set a servings number" hint instead of
   * rendering NaN amounts.
   */
  factorOrNull(servings) {
    return factor(servings);
  },

  /**
   * mealPlanOrigRef — quick 260611-enp. The muted "orig" reference string shown
   * under each scaled row. Prefer the source row's verbatim raw_text; if blank,
   * compose a compact "orig: {quantity_metric}{unit_metric}" fallback. Pure string.
   */
  mealPlanOrigRef(row) {
    if (row && row.raw_text && row.raw_text.trim()) return row.raw_text.trim();
    const q = (row && row.quantity_metric != null) ? row.quantity_metric : '';
    const u = (row && row.unit_metric) ? row.unit_metric : '';
    if (q === '' && u === '') return '';
    return `orig: ${q}${u}`;
  },

  /**
   * combinedShoppingList — quick 260611-enp. Aggregate across ALL picked, scaled
   * recipes into one shopping list, per ingredient_id, in the unit dictated by
   * each ingredient's shopping_unit. PURE getter (derived from mealPlan +
   * mealPlanGrouped + ingredientMaster) so it recomputes live when any servings
   * change. NO writes.
   *
   * Returns { lines: [ { ingredient_name, parts: [ {total, unit} ], caveat? } ],
   *           unknown: [ { ingredient_name } ] }.
   *
   * AGGREGATION (locked decision + the 260610-eyh never-silently-mislead safety
   * pattern). We SUM the already-rounded per-row scaled values (the per-recipe
   * lists already show rounded values, so summing rounded values keeps the
   * combined totals consistent with what the user sees per recipe):
   *
   *   - shopping_unit 'metric': SUM scaled_quantity_metric in its unit_metric
   *     (g or ml). EDGE (c): if the SAME ingredient_id appears with MISMATCHED
   *     unit_metric (g vs ml), do NOT cross-sum — SPLIT into per-unit subtotals
   *     and FLAG the line ("mixed units — shown separately").
   *   - shopping_unit 'whole': SUM the scaled whole-count
   *     (scaled_quantity_volumetric where unit_volumetric is 'whole'). EDGE (a):
   *     a contributing row LACKING a whole value falls back to summing its
   *     scaled_quantity_metric and the line is flagged ("whole-count missing for
   *     some lines, showing metric"). Never drop the contribution.
   *   - EDGE (b): rows whose ingredient_id is blank/null OR absent from the master
   *     go into a SEPARATE "couldn't combine (unknown ingredient)" bucket — listed
   *     by name, never mis-summed into another line.
   */
  get combinedShoppingList() {
    // masterById: ingredient_id -> { ingredient_name, shopping_unit }. Reuses the
    // derivedAllergens/allergensByRecipeId masterById pattern.
    const masterById = new Map(
      (Array.isArray(this.ingredientMaster) ? this.ingredientMaster : [])
        .map(m => [m.ingredient_id, { ingredient_name: m.ingredient_name, shopping_unit: m.shopping_unit, pantry_staple: m.pantry_staple, pantry_section: m.pantry_section, pack_size: m.pack_size, pack_unit: m.pack_unit, pack_units: m.pack_units, pack_unit_label: m.pack_unit_label, regular: m.regular, regular_qty_per_person: m.regular_qty_per_person }]) // pack_units/pack_unit_label: quick 260615-kid; regular/regular_qty_per_person: phase 08 REG-05 (Plan 01 read-side deferral mirrored here)
    );

    // acc keyed by ingredient_id. Each: { ingredient_name, shopping_unit,
    //   metricByUnit: Map<unit, total>, wholeTotal, missingWhole:bool }.
    const acc = new Map();
    const unknown = new Map(); // name -> true (dedup by name)

    // quick 260613-aw1 — role split. acc/lines/unknown aggregate ONLY required
    // rows; non-required (optional/garnish/to_taste) rows go to a separate
    // check-stock list. TWO-PASS by necessity: requiredKeys must be COMPLETE
    // across ALL picked recipes before any check-stock decision, because an
    // ingredient required in a LATER recipe must still suppress a non-required
    // occurrence seen earlier ("required-anywhere wins" regardless of order).
    const rowKey = (iid, nm) => (iid != null ? 'id:' + iid : 'name:' + (nm || ''));
    const requiredKeys = new Set();   // every key that appears required anywhere
    const nonRequired = [];           // { key, ingredient_name, role } candidates
    // quick 260614-eqa — pantry staples: collected here and ALWAYS surfaced on
    // check-stock, NEVER added to lines/unknown/requiredKeys (see short-circuit
    // below). stapleKeys lets the non-required pass defensively skip a staple.
    const staples = [];               // { key, ingredient_name }
    const stapleKeys = new Set();
    // quick 260615-brp — aggregate staple SCALED quantities so each check-stock
    // staple entry can show the total amount needed across the whole plan. Keyed
    // by ingredient_id, SAME entry shape as `acc`. stapleAcc sums EVERY occurrence
    // (across all recipes/picks) regardless of the dedup-by-key order in the emit
    // pass below, because it is keyed by iid not by first-seen.
    const stapleAcc = new Map();

    // quick 260615-ms3 — the four local aggregation closures (ensureAccEntry /
    // accumulateRow / derivePartsCaveat / derivePackCount) were LIFTED VERBATIM into
    // shared instance methods (_ensureAccEntry / _accumulateRow / _derivePartsCaveat /
    // _derivePackCount, near formatPackLine) so trayForDay calls the IDENTICAL code and
    // the tray + shopping list cannot drift (project convention: no duplicated
    // load-bearing logic). Call sites below use the `this._…` method form.

    // quick 260618-ahg — aggregate UPCOMING entries only (today/future/undated);
    // past-dated meals never affect the shopping list / check-stock / pack counts.
    for (const entry of this.upcomingEntries) {
      // quick 260627-i6h (D13a) — scope to the current shopping-period RANGE via the
      // shared isDayInOrderScope helper (replaces the retired per-day exclude map). A
      // day OUTSIDE the range drops out of BOTH the order list (lines/unknown/staples)
      // AND the check-stock list, because both are derived from this single loop. When
      // no range is set (orderScopeRange === null) the helper returns true for every
      // day (incl. '' Unscheduled) → whole-plan output, identical to before. Tray lists
      // (trayForDay) use a separate path and are deliberately untouched.
      if (!this.isDayInOrderScope(this._dayKeyForEntry(entry))) continue;
      const rows = this.scaledRowsFor(entry);
      for (const row of rows) {
        const iid = row.ingredient_id;
        const role = row.role || 'required';
        // quick 260614-eqa — USER-LOCK: pantry staples are NEVER ordered and ALWAYS
        // check-stock; this wins over role. Short-circuit BEFORE the role check so a
        // staple is never added to requiredKeys, acc, nonRequired, or unknown -> it is
        // fully removed from `lines` AND `unknown` AND ordering, and always surfaced
        // on check-stock (per-ingredient, regardless of how a recipe marks the line).
        if (iid != null && masterById.get(iid)?.pantry_staple) {
          const k = rowKey(iid, row.ingredient_name);
          // quick 260614-fo7 — carry the raw iid so the check-stock entry can render
          // a clickable edit link. Staples always have a non-null iid (the
          // short-circuit above requires iid != null).
          staples.push({ key: k, ingredient_name: this.masterIngredientName(iid, row.ingredient_name) || '(unnamed ingredient)', ingredient_id: iid }); // quick 260615-ljm — master-name-first (belt-and-braces; iid is non-null here)
          stapleKeys.add(k);
          // quick 260615-brp — also accumulate the staple's scaled quantity so the
          // check-stock entry can show the total needed. Same convention as `acc`
          // (the short-circuit above guarantees iid != null && master pantry_staple).
          const stapleMaster = masterById.get(iid);
          if (stapleMaster) {
            this._accumulateRow(this._ensureAccEntry(stapleAcc, iid, stapleMaster, row), stapleMaster, row);
          }
          continue;
        }
        if (role !== 'required') {
          // Defer the check-stock decision until requiredKeys is complete.
          nonRequired.push({
            key: rowKey(iid, row.ingredient_name),
            // quick 260615-ljm — master-name-first (belt-and-braces; a null iid
            // falls back to the recipe-line name, which is the genuinely-unmatched
            // case). masterIngredientName never returns blank.
            ingredient_name: this.masterIngredientName(iid, row.ingredient_name) || '(unnamed ingredient)',
            role,
            // quick 260614-fo7 — carry iid (MAY be null for a name-only unmatched
            // row) so the check-stock entry can render a clickable edit link;
            // canEditIngredient gates rendering, so a null id stays plain text.
            ingredient_id: iid
          });
          continue;
        }
        requiredKeys.add(rowKey(iid, row.ingredient_name));
        const master = (iid != null) ? masterById.get(iid) : undefined;
        // EDGE (b): unknown / blank ingredient_id -> separate bucket.
        if (iid == null || !master) {
          const nm = row.ingredient_name || '(unnamed ingredient)';
          unknown.set(nm, true);
          continue;
        }
        this._accumulateRow(this._ensureAccEntry(acc, iid, master, row), master, row);
      }
    }

    // phase 08 REG-05 — REGULARS + AD-HOC EXTRAS FOLD-IN. Injected AFTER the recipe
    // loop fills `acc` and BEFORE `lines` is built, so a regular for the SAME
    // ingredient_id as a recipe-derived line joins that SAME acc entry as its own
    // unit-part (2 L + 3 L → 5 L); a regular for a not-yet-listed product creates a new
    // acc entry. READ regularsOverrides + adHocExtras here so Alpine re-invokes this
    // getter when an override / skip / extra changes (reactivity wiring — RESEARCH note).
    const _regularsOverrides = this.regularsOverrides;   // touch for reactivity (read below via String(iid))
    const _adHocExtras = this.adHocExtras;               // touch for reactivity (iterated below)

    // 1. Regulars fold-in. For each master tagged regular AND not skipped this shop.
    for (const [iid, m] of masterById.entries()) {
      if (m.regular !== true) continue;                                   // not a regular
      if (_regularsOverrides[String(iid)]?.skip === true) continue;       // skipped this shop (D-02)
      const qty = this.regularSuggestedQty(iid);                          // override.qty ?? blank→null ?? rate×person-days
      if (qty == null) continue;                                          // blank-rate regular → contributes nothing (D-04)
      if (!(qty > 0)) continue;                                           // explicit 0 zero-out → contributes nothing (deliberate)
      // Add the suggested qty as its OWN metric part in the ingredient's pack_unit (the
      // rate is in pack_size's unit — Constraint, NO conversion). If a recipe already
      // contributed the same unit, _accumulateRow SUMS them into one part (2 L + 3 L → 5 L);
      // a different unit fires the EXISTING mixed-units caveat (no new code). A skipped
      // regular is skipped here while the recipe-derived contribution stays untouched
      // (REG-07: drops to recipe-only qty, not zero).
      const accMaster = { ingredient_name: m.ingredient_name, shopping_unit: 'metric' };
      const row = { scaled_quantity_metric: qty, unit_metric: (m.pack_unit || '') };
      this._accumulateRow(this._ensureAccEntry(acc, iid, accMaster, row), accMaster, row);
    }

    // 2. Ad-hoc extras fold-in. An "I'm out of this" add (A2 / Open Q2) carries NO
    // recipe-derived qty. If the product is ALREADY in acc it's already represented
    // (folds into that line's existing quantity — no duplicate row). If NOT present,
    // create a QUANTITY-LESS acc entry (parts.length === 0) so it surfaces as a plain
    // buy line; because it has no partTotal, the export's `formattable` gate routes it
    // to the existing `needsSetup` ("⚠ Needs pack/link") bucket — never a ready
    // `${name} ${packs} x ${link}` line. Do NOT synthesise a fake quantity.
    for (const ex of (Array.isArray(_adHocExtras) ? _adHocExtras : [])) {
      const iid = Number(ex && ex.ingredient_id);
      if (!Number.isFinite(iid)) continue;
      if (acc.has(iid)) continue;                                         // already represented — folds in
      const m = masterById.get(iid);
      if (!m) continue;                                                   // unknown id (e.g. master changed) — skip
      // Quantity-less entry: _ensureAccEntry creates an empty metricByUnit/wholeTotal,
      // _derivePartsCaveat then emits parts.length === 0 + a "no scaled quantity" caveat,
      // and _derivePackCount returns null → the export routes it to Needs-pack/link.
      this._ensureAccEntry(acc, iid, { ingredient_name: m.ingredient_name, shopping_unit: m.shopping_unit }, {});
    }

    const lines = [];
    for (const [iid, a] of acc.entries()) {
      const { parts, caveat } = this._derivePartsCaveat(a);
      lines.push({ ingredient_id: iid, ingredient_name: a.ingredient_name, parts, caveat, pantry_section: masterById.get(iid)?.pantry_section || '', packs: this._derivePackCount(parts, caveat, masterById.get(iid)), pack_size: masterById.get(iid)?.pack_size ?? null, pack_units: masterById.get(iid)?.pack_units ?? null, pack_unit_label: masterById.get(iid)?.pack_unit_label || '' }); // pack_units/pack_unit_label: quick 260615-kid
    }

    // quick 260613-aw1 — check-stock list: non-required items NOT bought as a
    // required item anywhere. Dedup by key; keep the FIRST role seen. requiredKeys
    // is now complete (all picked recipes processed), so this filter is order-safe.
    const checkStock = [];
    const seenCheck = new Set();
    // quick 260614-eqa — STAPLES FIRST. A staple entry carries { pantry_staple: true }
    // (no role); the index.html renderer distinguishes it from a role entry. One
    // shared seenCheck across both passes so a name appearing as both a staple and a
    // non-required line is listed once (staple wins, added first).
    for (const s of staples) {
      if (seenCheck.has(s.key)) continue;       // dedup staples by key
      seenCheck.add(s.key);
      // quick 260615-brp — derive the scaled total from stapleAcc (keyed by iid,
      // so it already sums ALL occurrences across recipes regardless of which
      // staple occurrence won the dedup above). A staple with genuinely no scaled
      // quantity still surfaces by name with the "no scaled quantity" caveat.
      const sa = stapleAcc.get(s.ingredient_id);
      const { parts, caveat } = sa ? this._derivePartsCaveat(sa) : { parts: [], caveat: undefined };
      checkStock.push({ ingredient_name: s.ingredient_name, pantry_staple: true, ingredient_id: s.ingredient_id, parts, caveat, pantry_section: masterById.get(s.ingredient_id)?.pantry_section || '', packs: this._derivePackCount(parts, caveat, masterById.get(s.ingredient_id)), pack_size: masterById.get(s.ingredient_id)?.pack_size ?? null, pack_units: masterById.get(s.ingredient_id)?.pack_units ?? null, pack_unit_label: masterById.get(s.ingredient_id)?.pack_unit_label || '' }); // pack_units/pack_unit_label: quick 260615-kid
    }
    for (const c of nonRequired) {
      if (stapleKeys.has(c.key)) continue;      // staple already listed (staple wins)
      if (requiredKeys.has(c.key)) continue;    // required-anywhere wins
      if (seenCheck.has(c.key)) continue;       // dedup, keep first role seen
      seenCheck.add(c.key);
      checkStock.push({ ingredient_name: c.ingredient_name, role: c.role, ingredient_id: c.ingredient_id, pantry_section: c.ingredient_id != null ? (masterById.get(c.ingredient_id)?.pantry_section || '') : '' });
    }

    return {
      lines,
      unknown: [...unknown.keys()].map(nm => ({ ingredient_name: nm })),
      checkStock
    };
  },

  /**
   * regularsPersonDays — phase 08 REG-02. The person-days multiplier a rated
   * regular's qty-per-person is multiplied by. Mirrors combinedShoppingList's
   * day-iteration domain EXACTLY: iterate upcomingEntries, map each to its
   * _dayKeyForEntry, skip the '' (undated/Unscheduled) key, skip any day OUTSIDE the
   * order-scope range (quick 260627-i6h / D13a — via the shared isDayInOrderScope
   * helper, replacing the retired dayExcludedFromShopping map), dedupe via a Set so
   * each dated day counts ONCE, and sum headcountForDate(key) treating null (roster
   * not loaded / no roster row) as 0. RAW headcount — does NOT add the display-only
   * leftover bonus (_leftoverBonusInto), matching the SPEC numbers literally (resolved
   * decision). PURE getter — reads upcomingEntries + orderScopeRange + the roster, so
   * it recomputes reactively when any of those change. No writes.
   * Verified: dated 10/11/10, no range → 31; range over only the first/last day → 20.
   */
  get regularsPersonDays() {
    const seen = new Set();
    let total = 0;
    for (const entry of this.upcomingEntries) {
      const key = this._dayKeyForEntry(entry);
      if (!key) continue;                                        // undated/Unscheduled never contributes
      if (!this.isDayInOrderScope(key)) continue;                // out-of-range day (D13a)
      if (seen.has(key)) continue;                               // each dated day counts ONCE
      seen.add(key);
      const hc = this.headcountForDate(key);
      if (hc != null) total += hc;                               // null (roster not loaded) → 0
    }
    return total;
  },

  /**
   * regularSuggestedQty — phase 08 REG-03. The suggested REAL quantity (in the
   * ingredient's pack_size unit) for a regular-buy ingredient. PINS the
   * null-vs-0 contract precisely (shared with Plan 01's master parse):
   *   1. An override qty that is NOT null → returned as-is. An explicit override
   *      of 0 is a DELIBERATE zero-out (a distinct state) and is returned as 0,
   *      NOT coerced to null.
   *   2. Else the ingredient's regular_qty_per_person rate. A BLANK rate is null
   *      → return null ("no rate set; show the nudge; contributes nothing", D-04).
   *      This null is what Plan 03's "qty null → skip" branch keys on, so it MUST
   *      be null and NOT 0.
   *   3. Else (a real numeric rate) → rate × regularsPersonDays.
   * Key normalised with String(iid) at the boundary (JSON object keys are
   * strings; ingredient_id is numeric). PURE — no writes.
   */
  regularSuggestedQty(iid) {
    const ov = this.regularsOverrides[String(iid)];
    if (ov && ov.qty != null) return ov.qty;   // explicit override (an override of 0 is preserved)
    const m = (Array.isArray(this.ingredientMaster) ? this.ingredientMaster : [])
      .find(x => x.ingredient_id === Number(iid) || x.ingredient_id === iid);
    const rate = m ? m.regular_qty_per_person : null;
    if (rate == null) return null;             // blank rate → null (D-04 nudge state; NOT 0)
    return rate * this.regularsPersonDays;
  },

  /**
   * regularLineFor — phase 08 REG-03. Build a line-shaped object
   * { parts, caveat, packs, pack_size, pack_unit, pack_units, pack_unit_label }
   * for a regular-buy ingredient, by feeding its suggested qty (already in the
   * ingredient's pack_size unit — the rate IS in that unit, NO conversion)
   * through the existing parts machinery (_ensureAccEntry/_accumulateRow/
   * _derivePartsCaveat) and _derivePackCount. The regulars row AND the Plan 03
   * merge can both call formatPackLine(regularLineFor(iid)).
   *
   * Returns a SAFE default { parts: [], packs: null, … } when the suggested qty
   * is null (blank rate — D-04) or <= 0, so no unguarded x-text fires (Pitfall 4).
   * The qty is summed as a metric value in the ingredient's pack_unit so the
   * generic 'metric' shopping_unit summation applies. PURE — no writes.
   */
  regularLineFor(iid) {
    const m = (Array.isArray(this.ingredientMaster) ? this.ingredientMaster : [])
      .find(x => x.ingredient_id === Number(iid) || x.ingredient_id === iid);
    const packUnit = m ? (m.pack_unit || '') : '';
    const safe = {
      parts: [],
      caveat: undefined,
      packs: null,
      pack_size: m ? (m.pack_size ?? null) : null,
      pack_unit: packUnit,
      pack_units: m ? (m.pack_units ?? null) : null,
      pack_unit_label: m ? (m.pack_unit_label || '') : ''
    };
    const qty = this.regularSuggestedQty(iid);
    if (qty == null || !(qty > 0) || !m) return safe;   // blank rate / zero-out / unknown → safe default
    // Feed the qty through the shared metric summation (a 'metric' acc entry so
    // _derivePartsCaveat emits a single { total, unit } part), then _derivePackCount.
    const acc = new Map();
    const accMaster = { ingredient_name: m.ingredient_name, shopping_unit: 'metric' };
    const row = { scaled_quantity_metric: qty, unit_metric: packUnit };
    this._accumulateRow(this._ensureAccEntry(acc, iid, accMaster, row), accMaster, row);
    const { parts, caveat } = this._derivePartsCaveat(acc.get(iid));
    const packs = this._derivePackCount(parts, caveat, { pack_size: m.pack_size, pack_unit: packUnit });
    return { ...safe, parts, caveat, packs };
  },

  /**
   * regularsRows — phase 08 REG-04. The rows the Regulars sub-view renders: every
   * master ingredient tagged regular === true. PURE getter (reads ingredientMaster +,
   * transitively via regularSuggestedQty, regularsOverrides + the roster) so it
   * recomputes reactively. Sort: rated regulars first (alphabetical by name), then
   * blank-rate regulars (the "set a rate" nudge rows) LAST — keeps the actionable rows
   * up top. Each row carries just the iid + name; the template calls
   * regularSuggestedQty(iid) / regularLineFor(iid) / isAdHocExtra etc. live.
   */
  get regularsRows() {
    const master = Array.isArray(this.ingredientMaster) ? this.ingredientMaster : [];
    const rows = master
      .filter(m => m.regular === true)
      .map(m => ({ ingredient_id: m.ingredient_id, ingredient_name: m.ingredient_name || '(unnamed ingredient)', blankRate: m.regular_qty_per_person == null }));
    return rows.sort((a, b) => {
      if (a.blankRate !== b.blankRate) return a.blankRate ? 1 : -1;   // blank-rate nudge rows last
      return String(a.ingredient_name).localeCompare(String(b.ingredient_name));
    });
  },

  /**
   * regularIsEdited — phase 08 REG-04 / D-03. True iff the regular has an explicit
   * override qty set (drives the "edited" marker + reset control). Numeric 0 counts as
   * edited (a deliberate zero-out). Never throws.
   */
  regularIsEdited(iid) {
    const ov = this.regularsOverrides[String(iid)];
    return !!(ov && ov.qty != null);
  },

  /**
   * regularIsSkipped — phase 08 REG-04 / D-02. True iff the regular is skipped this
   * shop (drives the skip-toggle label/state). Never throws.
   */
  regularIsSkipped(iid) {
    const ov = this.regularsOverrides[String(iid)];
    return !!(ov && ov.skip === true);
  },

  // phase 08 REG-07 — mutation helpers for the per-plan regulars overrides + ad-hoc
  // extras. EACH mutates reactive state then persists via the UI-prefs path
  // (_persistMealPlanUi → MEAL_PLAN_UI_KEY/localStorage). NO _persistMealPlan(), NO
  // IndexedDB, NO CSV/store write. Keys normalised with String(iid) at the boundary so
  // a numeric ingredient_id and its stringified JSON key never mismatch.

  /**
   * setRegularOverrideQty — D-02. Set an explicit override qty for a regular. An
   * explicit 0 is a VALID, deliberate zero-out — it is stored, NOT discarded as
   * falsy. Preserves any existing skip flag on the entry.
   */
  setRegularOverrideQty(iid, qty) {
    const k = String(iid);
    const entry = (this.regularsOverrides[k] && typeof this.regularsOverrides[k] === 'object')
      ? this.regularsOverrides[k] : {};
    this.regularsOverrides[k] = { ...entry, qty };   // explicit 0 preserved (not dropped)
    this._persistMealPlanUi();
  },

  /**
   * resetRegularOverride — D-03 reset-to-suggested. Clear the qty override (and
   * drop the whole entry when nothing meaningful remains) so regularSuggestedQty
   * falls back to rate × person-days.
   */
  resetRegularOverride(iid) {
    const k = String(iid);
    const entry = this.regularsOverrides[k];
    if (!entry || typeof entry !== 'object') { this._persistMealPlanUi(); return; }
    const next = { ...entry };
    delete next.qty;
    if (next.skip === true) {
      this.regularsOverrides[k] = next;              // keep a meaningful skip flag
    } else {
      delete this.regularsOverrides[k];              // empty entry → drop it
    }
    this._persistMealPlanUi();
  },

  /**
   * toggleRegularSkip — D-02 skip-this-shop. Flip the skip flag for a regular,
   * preserving any override qty. Dropping skip leaves a qty-only entry; dropping
   * skip with no qty removes the entry entirely.
   */
  toggleRegularSkip(iid) {
    const k = String(iid);
    const entry = (this.regularsOverrides[k] && typeof this.regularsOverrides[k] === 'object')
      ? { ...this.regularsOverrides[k] } : {};
    if (entry.skip === true) {
      delete entry.skip;
    } else {
      entry.skip = true;
    }
    if (entry.skip === true || entry.qty != null) {
      this.regularsOverrides[k] = entry;
    } else {
      delete this.regularsOverrides[k];              // nothing meaningful left → drop
    }
    this._persistMealPlanUi();
  },

  /**
   * toggleAdHocExtra — D-06 add/remove. Add { ingredient_id } to adHocExtras if
   * absent, else remove it. Membership compared numerically (Number(iid)) so a
   * string/number id never duplicates.
   */
  toggleAdHocExtra(iid) {
    const n = Number(iid);
    const idx = this.adHocExtras.findIndex(x => Number(x && x.ingredient_id) === n);
    if (idx >= 0) {
      this.adHocExtras.splice(idx, 1);
    } else {
      this.adHocExtras.push({ ingredient_id: n });
    }
    this._persistMealPlanUi();
  },

  /**
   * isAdHocExtra — D-06. True iff iid is currently an ad-hoc extra (drives the
   * button label in Plan 03). Numeric comparison, never throws.
   */
  isAdHocExtra(iid) {
    const n = Number(iid);
    return this.adHocExtras.some(x => Number(x && x.ingredient_id) === n);
  },

  /**
   * formatPackLine — quick 260615-kid. The SINGLE source of the shopping-amount
   * display string for BOTH the combined shopping list AND the "Check you have these"
   * list (no duplicated ternary). Three display tiers:
   *   TIER C (no pack): packs == null -> raw amount join, e.g. "420 g" / "2 × 19 g".
   *   TIER A (multipack): a finite pack_units > 0 + finite pack_size > 0 + single part
   *     -> "{cans} {label}s · buy {packs} × {pack_units}-pack ({total} {unit})",
   *     e.g. "24 cans · buy 6 × 4-pack (9600 g)". The sub-unit (can) size is
   *     pack_size / pack_units; the can count is the need ÷ sub-unit size, epsilon-
   *     rounded to an integer (else 1 dp). A non-finite count falls through to TIER B
   *     (never renders "NaN" — T-kid-03).
   *   TIER B (pack, no pack_units, the CURRENT format):
   *     "{packs} × {pack_size} {unit}, (total: {total} {unit})".
   * @param {object} entry — a shopping-list `line` or check-stock `item`.
   * @returns {string}
   */
  formatPackLine(entry) {
    const e = entry || {};
    const parts = Array.isArray(e.parts) ? e.parts : [];
    // TIER C — no pack: raw amount join (multi-part safe).
    if (e.packs == null) {
      return parts.map(p => `${p.total} ${p.unit}`).join(' + ');
    }
    // TIER A — multipack (finite pack_units/pack_size, single part).
    if (Number.isFinite(e.pack_units) && e.pack_units > 0
        && Number.isFinite(e.pack_size) && e.pack_size > 0
        && parts.length === 1) {
      const subUnitSize = e.pack_size / e.pack_units;
      const raw = Number(parts[0].total) / subUnitSize;
      const cansNeeded = Math.abs(raw - Math.round(raw)) < 1e-6
        ? Math.round(raw)
        : Math.round(raw * 10) / 10;
      if (Number.isFinite(cansNeeded)) {
        const labelBase = (e.pack_unit_label || 'unit');
        const labelPlural = labelBase + (cansNeeded === 1 ? '' : 's');
        return `${cansNeeded} ${labelPlural} · buy ${e.packs} × ${e.pack_units}-pack (${parts[0].total} ${parts[0].unit})`;
      }
      // non-finite -> fall through to TIER B (never show NaN).
    }
    // TIER B — pack but no usable pack_units: the current pack-size format.
    return `${e.packs} × ${e.pack_size} ${parts[0].unit}, (total: ${parts[0].total} ${parts[0].unit})`;
  },

  /**
   * formatBuyDisplay — quick 260625-itm (F13). DISPLAY-ONLY wrapper over
   * formatPackLine for the combined shopping list's BOLD buy line. The specimen
   * `.buy` reads as a clean buy instruction ("buy 3 × 4-pack"); the redundant
   * "(total: X)" the raw TIER-B string carries now lives in the faint mono
   * "need X" detail line above it, so we strip it here and prefix "buy " on the
   * bare pack tier so it reads as an instruction. formatPackLine itself is LEFT
   * BYTE-IDENTICAL — it is the single source the text export / cart-filler
   * contract (and the tray/regulars/check-stock displays) still read, so this
   * reformat is scoped to the shopping list display ONLY and changes no data.
   */
  formatBuyDisplay(entry) {
    const s = this.formatPackLine(entry);
    // Drop the ", (total: … )" parenthetical (TIER B only ever has this; the
    // need-detail line already shows that total). TIER A's "(N whole)" buy-total
    // is a different parenthetical and is intentionally left intact.
    const stripped = s.replace(/,\s*\(total:[^)]*\)/, '');
    // TIER A already contains "· buy …"; TIER C is a bare amount the faint
    // "need …" line mirrors. Only the bare pack tier ("N × size unit") needs the
    // "buy " instruction prefix to match the specimen idiom.
    if (/\bbuy\b/.test(stripped)) return stripped;
    if (/^\d+(\.\d+)?\s*×\s/.test(stripped)) return `buy ${stripped}`;
    return stripped;
  },

  /**
   * formatShopAmount — quick 260628-byd (BYD-01). DISPLAY-ONLY wrapper over
   * formatPackLine for the combined shopping list's SINGLE-LINE amount span
   * (replacing the F13 two-tier "need …"/"buy …" stack, which had grown 2-4
   * lines tall per ingredient). The user-approved design is one dense baseline
   * line — "name | amount | icons" — so the amount drops the "need"/"buy" verbs
   * and folds the need-total into a paren on the pack string. Two transforms:
   *   TIER A "{n} label · buy {packs} × {units}-pack ({total} {unit})"
   *     -> strip the leading "… · buy " instruction prefix, keeping only the
   *        "{packs} × {units}-pack ({total} {unit})" pack clause + its paren.
   *   TIER B "{packs} × {size} {unit}, (total: {X})"
   *     -> rewrite ", (total: X)" -> " (X)" so the need total reads as a paren.
   *   TIER C bare amount ("5 whole" / "2 × 19 g") -> unchanged (it IS the need;
   *     no redundant paren). An empty/bare formatPackLine (e.g. Tomatoes, no
   *     scaled buyable amount) passes straight through as "" so the row renders
   *     only its trailing ⚠ icon.
   * PURE / display-only: it READS formatPackLine and serializes NOTHING.
   * formatPackLine itself stays BYTE-IDENTICAL — it is the single source of the
   * text-export / cart-filler contract (and the tray/regulars/check-stock
   * displays still read it verbatim), so this reformat is scoped to the
   * combined shopping list display ONLY and changes no data. DO NOT modify
   * formatPackLine. (Sibling formatBuyDisplay becomes unreferenced once Task 2
   * rewires the markup; left in place to keep this diff scoped — safe to remove
   * in a later cleanup if it ends up dead.)
   */
  formatShopAmount(entry) {
    const s = this.formatPackLine(entry);
    // TIER A: drop everything up to and including the "· buy " instruction
    // prefix, leaving the "{packs} × {units}-pack ({total} {unit})" clause.
    if (s.includes(' · buy ')) {
      return s.replace(/^.*·\s*buy\s*/, '');
    }
    // TIER B: rewrite the redundant ", (total: X)" parenthetical to " (X)".
    if (/,\s*\(total:/.test(s)) {
      return s.replace(/,\s*\(total:\s*([^)]*)\)/, ' ($1)');
    }
    // TIER C (and empty): bare amount, unchanged.
    return s;
  },

  /**
   * formatNeedDisplay — quick 260625-s1g (X5). DISPLAY-ONLY wrapper over
   * formatPackLine for the Check + Tray panel AMOUNT spans. Those panels were
   * leaking the raw TIER-B "N × size, (total: X)" string on screen; this strips
   * the redundant ", (total: X)" parenthetical exactly as formatBuyDisplay does,
   * so the panels read a clean pack instruction. NO "buy " prefix here — Check is
   * a stock-confirm context and Tray is a mise-en-place context, neither is a buy
   * instruction. PURE / display-only: it READS formatPackLine and serializes
   * NOTHING. formatPackLine itself stays BYTE-IDENTICAL — it is the single source
   * of the text-export / cart-filler contract (and the export modals still read it
   * verbatim), so this reformat is scoped to the on-screen Check + Tray amounts
   * ONLY and changes no data. The deeper Check/Tray row rebuilds (C-/T-items) are
   * a separate deferred task. DO NOT modify formatPackLine.
   */
  formatNeedDisplay(entry) {
    const s = this.formatPackLine(entry);
    return s.replace(/,\s*\(total:[^)]*\)/, '');
  },

  /**
   * formatRegularBuy — quick 260625-sv2. DISPLAY-ONLY wrapper over formatPackLine
   * for the Regulars grid's BUY column. Unlike the shopping list (no qty column),
   * the Regulars grid has a dedicated Qty column already showing the need, so the
   * Buy column must read as the TERSE pack instruction the specimen shows
   * ("buy 3 × 6-pack") — NOT formatBuyDisplay's richer "{n} units · buy … (total)"
   * which here just repeats the adjacent Qty. So: strip the TIER-A "{n} label · "
   * prefix and its trailing "(total)" parenthetical, keeping only the "buy …" pack
   * clause; for the bare-pack TIER-B, reuse the formatBuyDisplay "buy {packs} × …"
   * shape; TIER-C bare amounts pass through. PURE / display-only — READS
   * formatPackLine, mutates/serializes NOTHING. formatPackLine stays BYTE-IDENTICAL
   * (the export contract). DO NOT modify formatPackLine.
   */
  formatRegularBuy(entry) {
    const s = this.formatPackLine(entry);
    // TIER A: "{n} label · buy {packs} × {units}-pack ({total} {unit})" → keep "buy …" up to " (".
    const tierA = s.match(/buy [^(]*/);
    if (tierA) return tierA[0].trim();
    // TIER B: "{packs} × {size} unit, (total: …)" → drop the total, prefix "buy ".
    const stripped = s.replace(/,\s*\(total:[^)]*\)/, '');
    if (/^\d+(\.\d+)?\s*×\s/.test(stripped)) return `buy ${stripped}`;
    return stripped;   // TIER C bare amount
  },

  /**
   * formatCheckNeed — quick 260625-tum (C3). DISPLAY-ONLY helper that builds the
   * Check ("Check you have these") panel's faint mono "need …" line from the
   * SCALED total already on the entry (`item.parts`). Unlike its siblings it does
   * NOT read formatPackLine and serializes NOTHING — the Check panel confirms the
   * stock QUANTITY needed, not a pack-buy instruction, so there is no pack string
   * to reformat here. PURE: reads item.parts only, mutates/serializes nothing.
   * formatPackLine + formatNeedDisplay + the text-export / cart-filler contract are
   * UNTOUCHED. DO NOT modify formatPackLine.
   *
   * Behaviour (matches mise-design-sketch.html L975–986):
   *  - No parts (role items / staple with no scaled qty) → '' (renders nothing; the
   *    separate .shopping-caveat marker still surfaces the "no scaled quantity" note).
   *  - Mass/volume part (unit ∈ g/kg/mg/ml/l/cl, case-insensitive) → "≈ {total} {unit}".
   *  - Count part with a bare count word (whole/ea/each) → just "{total}" (drop the word).
   *  - Any other discrete unit → "{total} {unit}" (no ≈).
   *  - Multi-part (mixed units) → each part formatted per the above, joined with " + ".
   *  - The whole result is prefixed ONCE with "need ". item.parts totals are already
   *    _roundQty-rounded upstream (_derivePartsCaveat) — do NOT re-round.
   */
  formatCheckNeed(item) {
    if (!item || !item.parts || item.parts.length === 0) return '';
    const massVolume = new Set(['g', 'kg', 'mg', 'ml', 'l', 'cl']);
    const bareCount = new Set(['whole', 'ea', 'each']);
    const segs = item.parts.map(p => {
      const unit = (p.unit || '').trim();
      const u = unit.toLowerCase();
      if (massVolume.has(u)) return `≈ ${p.total} ${unit}`;   // continuous → approximate
      if (bareCount.has(u)) return `${p.total}`;              // count word dropped (specimen "need 8")
      return unit ? `${p.total} ${unit}` : `${p.total}`;      // other discrete unit kept verbatim
    });
    return `need ${segs.join(' + ')}`;
  },

  /**
   * formatTrayPull — quick 260625-ue4 (T3). DISPLAY-ONLY helper that builds the
   * Tray-lists panel's plain mono pull amount from the SCALED total already on the
   * entry (`item.parts`). The Tray panel is a mise-en-place PULL list: it states the
   * bare amount to pull from storage — NO "need " prefix, NO "≈" approximation, NO
   * "buy "/"(total:)" pack instruction. PURE: reads item.parts only, mutates/
   * serializes nothing. formatPackLine + formatNeedDisplay + formatCheckNeed and the
   * text-export / cart-filler contract are UNTOUCHED. DO NOT modify formatPackLine.
   *
   * Behaviour (matches mise-design-sketch.html tray lines):
   *  - No parts (role items / staple with no scaled qty) → '' (the markup falls
   *    through to the role/caveat fallback so the line still has a right annotation).
   *  - Every part → "{total} {unit}" keeping the unit VERBATIM, INCLUDING bare count
   *    words whole/ea/each (specimen shows "3 whole") — the key divergence from
   *    formatCheckNeed, which drops the count word.
   *  - Multi-part (mixed units) → each part formatted as above, joined with " + ".
   *  - item.parts totals are already _roundQty-rounded upstream (_derivePartsCaveat)
   *    — do NOT re-round.
   */
  formatTrayPull(item) {
    if (!item || !item.parts || item.parts.length === 0) return '';
    const segs = item.parts.map(p => {
      const unit = (p.unit || '').trim();
      return unit ? `${p.total} ${unit}` : `${p.total}`;   // unit kept verbatim, count word included
    });
    return segs.join(' + ');
  },

  // quick 260615-brp · extracted quick 260615-ms3 — shared accumulator. Mutates an
  // acc-style entry given a master + scaled row using the ONE whole-vs-metric
  // summation convention (no second/simplified convention). Both combinedShoppingList
  // (required + staple paths) and trayForDay route through these so they can never drift
  // apart. PURE (no `this`); lifted verbatim from the combinedShoppingList closures.
  _ensureAccEntry(map, iid, master, row) {
    if (!map.has(iid)) {
      map.set(iid, {
        ingredient_name: master.ingredient_name || row.ingredient_name || '(unnamed)',
        shopping_unit: master.shopping_unit,
        metricByUnit: new Map(),
        wholeTotal: 0,
        hasWhole: false,
        missingWhole: false
      });
    }
    return map.get(iid);
  },
  _accumulateRow(a, master, row) {
    if (master.shopping_unit === 'whole') {
      // Prefer the scaled whole-count; fall back to metric (EDGE a) + flag.
      const w = row.scaled_quantity_volumetric;
      if (row.unit_volumetric === 'whole' && w != null && w !== '') {
        a.wholeTotal += Number(w) || 0;
        a.hasWhole = true;
      } else {
        // Missing whole-count: contribute the metric value instead (never drop).
        const m = row.scaled_quantity_metric;
        if (m != null && m !== '') {
          const u = row.unit_metric || '';
          a.metricByUnit.set(u, (a.metricByUnit.get(u) || 0) + (Number(m) || 0));
        }
        a.missingWhole = true;
      }
    } else {
      // shopping_unit 'metric' (or anything not 'whole'): sum metric by unit.
      const m = row.scaled_quantity_metric;
      if (m != null && m !== '') {
        const u = row.unit_metric || '';
        a.metricByUnit.set(u, (a.metricByUnit.get(u) || 0) + (Number(m) || 0));
      }
    }
  },
  // quick 260615-brp · extracted quick 260615-ms3 — shared parts/caveat derivation
  // (the old `lines` loop body). Used for order-list lines AND staple check-stock
  // entries AND the tray so the caveat conventions stay identical.
  // quick 260620-sqw — totals here are pure SUMS of stored 1-dp quantities, so
  // binary float error surfaces as "3.9000000000000004 g" in the lists. Stored
  // amounts never exceed ~3 dp, so rounding to 3 dp strips the float tail
  // without changing any genuine value (3.9000000000000004 -> 3.9, 8.5 -> 8.5,
  // 1410 -> 1410). Applied at this single derivation point so the order list,
  // check-stock list and tray all read clean.
  _roundQty(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return n;
    return Math.round(v * 1000) / 1000;
  },
  _derivePartsCaveat(a) {
    const parts = [];
    let caveat;
    if (a.shopping_unit === 'whole') {
      if (a.hasWhole) parts.push({ total: this._roundQty(a.wholeTotal), unit: 'whole' });
      // EDGE (a): some/all lines lacked a whole-count -> metric fallback + caveat.
      if (a.missingWhole) {
        for (const [u, total] of a.metricByUnit) parts.push({ total: this._roundQty(total), unit: u });
        caveat = 'whole-count missing for some lines, showing metric';
      }
    } else {
      // metric shopping_unit. EDGE (c): >1 distinct unit -> split + flag.
      for (const [u, total] of a.metricByUnit) parts.push({ total: this._roundQty(total), unit: u });
      if (a.metricByUnit.size > 1) caveat = 'mixed units — shown separately';
    }
    // No parts (e.g. only null metric AND null whole) still surfaces by name.
    if (parts.length === 0) {
      caveat = caveat || 'no scaled quantity — check this ingredient';
    }
    return { parts, caveat };
  },
  // quick 260615-f3o · extracted quick 260615-ms3 — PURE pack-count helper. Returns
  // ceil(scaled total ÷ 1st_pack_size) or null. Matches the export pack-count rule
  // (openShoppingExport) EXACTLY except the link gate is export-only (the count needs a
  // pack size, not a URL), so an item with a pack but no link still shows its on-screen
  // count while routing to Needs-pack/link in the export. Everything else is byte-
  // identical to the export rule, so the COUNT matches whenever the export also produces
  // a count.
  _derivePackCount(parts, caveat, master) {
    if (!master) return null;
    const partTotal = parts.length === 1 ? Number(parts[0].total) : NaN;
    const partUnit = parts.length === 1 ? String(parts[0].unit || '').toLowerCase() : '';
    const unitsCompatible = master.pack_unit === '' || String(master.pack_unit).toLowerCase() === partUnit;
    const formattable =
      parts.length === 1 &&
      !caveat &&
      Number.isFinite(master.pack_size) && master.pack_size > 0 &&
      Number.isFinite(partTotal) && partTotal > 0 &&
      unitsCompatible;
    return formattable ? Math.ceil(partTotal / master.pack_size) : null;
  },

  /**
   * _groupBySection — quick 260615-e1n. PURE grouping of shopping/check-stock items
   * by their pantry_section into ordered { section, items } groups. Order:
   *   1. each curated pantrySections value IN ORDER (only emitted if it has ≥1 item);
   *   2. then any leftover non-blank section value present on items but NOT in
   *      pantrySections, sorted alphabetically (accepted cut-corner: a renamed/removed
   *      location keeps its LITERAL value under its own header — non-lossy, T-e1n-03);
   *   3. then the blank/"" group LAST, labelled "Unsorted".
   * No writes, no caching — recomputed reactively by the getters below.
   */
  _groupBySection(items) {
    const list = Array.isArray(items) ? items : [];
    const bySection = new Map();
    for (const it of list) {
      const sec = (it && it.pantry_section) ? String(it.pantry_section) : '';
      if (!bySection.has(sec)) bySection.set(sec, []);
      bySection.get(sec).push(it);
    }
    const groups = [];
    const curated = Array.isArray(this.pantrySections) ? this.pantrySections : [];
    const emitted = new Set();
    // 1. curated order
    for (const sec of curated) {
      if (bySection.has(sec) && !emitted.has(sec)) {
        groups.push({ section: sec, items: bySection.get(sec) });
        emitted.add(sec);
      }
    }
    // 2. leftover non-blank literals (not in the curated list), alphabetical
    const leftovers = [...bySection.keys()]
      .filter(sec => sec !== '' && !emitted.has(sec))
      .sort((a, b) => a.localeCompare(b));
    for (const sec of leftovers) {
      groups.push({ section: sec, items: bySection.get(sec) });
      emitted.add(sec);
    }
    // 3. blank -> "Unsorted" LAST
    if (bySection.has('')) {
      groups.push({ section: 'Unsorted', items: bySection.get('') });
    }
    return groups;
  },

  /**
   * shoppingSections — quick 260615-e1n. The combined shopping list `lines` grouped
   * by storage location in curated order. Reactive: reads combinedShoppingList (itself
   * derived from mealPlan + master + pantrySections), so it recomputes when servings
   * change or a location is edited. PURE.
   */
  get shoppingSections() {
    return this._groupBySection(this.combinedShoppingList.lines);
  },

  /**
   * checkStockSections — quick 260615-e1n. The check-stock list grouped by storage
   * location in curated order (same convention as shoppingSections). PURE.
   */
  get checkStockSections() {
    return this._groupBySection(this.combinedShoppingList.checkStock);
  },

  /**
   * openShoppingExport — quick 260612-m6c. Build the order-format plaintext for the
   * combined shopping list and open the export modal. ADDITIVE + READ-ONLY: reads
   * ingredients.csv FRESH via getFile (so pack size / unit / link reflect edits made
   * since load, without a reload) and NEVER writes the store.
   *
   * Ready lines: `<Ingredient Name> <packs> x <1st_link>`, where
   * packs = Math.ceil(scaled total / pack size). One blank line between items.
   * A line is FORMATTABLE iff: exactly one part, no caveat, a pack entry exists for
   * its ingredient_id, pack_size is finite > 0, link is non-empty, total is finite > 0,
   * and units are compatible (blank 1st_pack_unit is ASSUMED to match the part unit —
   * documented assumption; a non-blank pack_unit that differs routes to Needs-pack/link
   * so a wrong count is never emitted). Everything non-formattable + the unknown bucket
   * goes to ⚠ Needs pack/link with its raw quantity text. Nothing is dropped.
   */
  async openShoppingExport() {
    let rec;
    try {
      rec = await getFile('ingredients.csv');
    } catch (e) {
      this.shoppingExportText = "Couldn't read your ingredients to build the order list.";
      this.shoppingExportCopied = false;
      this.shoppingExportOpen = true;
      return;
    }
    // getFile returns null (does NOT throw) for a genuinely-absent file — guard the
    // null case BEFORE touching rec.rows so we never hit an uncaught TypeError.
    if (!rec) {
      this.shoppingExportText = "Couldn't read your ingredients to build the order list.";
      this.shoppingExportCopied = false;
      this.shoppingExportOpen = true;
      return;
    }

    // packById: ingredient_id(Number) -> { pack_size, pack_unit, link }. Skip rows
    // whose ingredient_id is blank/whitespace (mirror the master-load guard at ~L280).
    const packById = new Map();
    for (const r of (Array.isArray(rec.rows) ? rec.rows : [])) {
      if (String(r.ingredient_id ?? '').trim() === '') continue;
      const id = parseInt(r.ingredient_id, 10);
      const pack_size = (String(r['1st_pack_size'] ?? '').trim() === '')
        ? null
        : Number(r['1st_pack_size']);
      const pack_unit = String(r['1st_pack_unit'] ?? '').trim();
      const link = String(r['1st_link'] ?? '').trim();
      packById.set(id, { pack_size, pack_unit, link });
    }

    // Capture the getter ONCE — it recomputes on each access.
    const csl = this.combinedShoppingList;
    const ready = [];
    const needsSetup = [];

    for (const line of csl.lines) {
      const p = packById.get(line.ingredient_id);
      const partTotal = line.parts.length === 1 ? Number(line.parts[0].total) : NaN;
      const partUnit = line.parts.length === 1 ? String(line.parts[0].unit || '').toLowerCase() : '';
      const unitsCompatible = !!p && (p.pack_unit === '' || p.pack_unit.toLowerCase() === partUnit);
      const formattable =
        line.parts.length === 1 &&
        !line.caveat &&
        !!p &&
        Number.isFinite(p.pack_size) && p.pack_size > 0 &&
        !!p.link &&
        Number.isFinite(partTotal) && partTotal > 0 &&
        unitsCompatible;

      if (formattable) {
        const packs = Math.ceil(partTotal / p.pack_size);
        ready.push(`${line.ingredient_name} ${packs} x ${p.link}`);
      } else {
        needsSetup.push({
          name: line.ingredient_name,
          qtyText: line.parts.length
            ? line.parts.map(pt => `${pt.total} ${pt.unit}`).join(' + ')
            : '—'
        });
      }
    }

    for (const u of csl.unknown) {
      needsSetup.push({ name: u.ingredient_name, qtyText: '—' });
    }

    const readyText = ready.join('\n\n');
    let text = readyText;
    if (needsSetup.length) {
      const needsBlock = '⚠ Needs pack/link (add in Manage Ingredients):\n'
        + needsSetup.map(n => `  ${n.name} — ${n.qtyText}`).join('\n');
      text = readyText ? readyText + '\n\n' + needsBlock : needsBlock;
    }
    if (!ready.length && !needsSetup.length) {
      text = 'Your meal plan is empty — nothing to order.';
    }

    // quick 260618-9sq — the check-stock section is no longer appended here; it
    // has its own dedicated export modal (openCheckStockExport). This modal is
    // now order-only: ready lines + the ⚠ Needs pack/link bucket.

    this.shoppingExportText = text;
    this.shoppingExportCopied = false;
    this.shoppingExportOpen = true;
  },

  /**
   * copyShoppingExport — quick 260612-m6c. Copy the order text to the clipboard and
   * flip the button label. Clipboard may be blocked (insecure context / permissions);
   * on failure the user can still select the <pre> text manually.
   */
  async copyShoppingExport() {
    try {
      await navigator.clipboard.writeText(this.shoppingExportText);
      this.shoppingExportCopied = true;
    } catch (e) {
      /* clipboard blocked; user selects manually */
    }
  },

  /**
   * downloadShoppingExport — quick 260612-m6c. Download the order text as
   * shopping-list.txt via the exportCsvs Blob + download-anchor lifecycle. Builds a
   * NEW browser file; never writes the store.
   */
  downloadShoppingExport() {
    const blob = new Blob([this.shoppingExportText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'shopping-list.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  /**
   * openCheckStockExport — quick 260618-9sq. Build a PLAIN grouped plaintext for the
   * check-you-have-these list and open the dedicated export modal. SYNCHRONOUS (no
   * getFile, no async): checkStockSections (_groupBySection over combinedShoppingList
   * .checkStock) and formatPackLine read already-loaded in-memory data, mirroring
   * openTrayExport's sync design. ADDITIVE + READ-ONLY — never touches the store.
   *
   * Per group: the storage-location header line, then one line per item:
   * `  <ingredient_name> — <amount-or-role>` where amount = formatPackLine(item) when
   * the item has scaled parts, else the role/staple label (same logic as the on-page
   * .check-stock-role span). NO flagging, NO caveats, NO ⚠ Needs pack/link bucket —
   * these items are never ordered. Blank line between groups.
   */
  openCheckStockExport() {
    const csl = this.combinedShoppingList;
    let text;
    if (csl.checkStock.length === 0) {
      text = 'Nothing to check — every ingredient is on your order list.';
    } else {
      const blocks = [];
      for (const grp of this.checkStockSections) {
        const lines = [grp.section];
        for (const item of grp.items) {
          const amount = (item.parts && item.parts.length)
            ? this.formatPackLine(item)
            : (item.pantry_staple
                ? 'pantry staple'
                : (item.role === 'to_taste' ? 'to taste' : item.role));
          lines.push(`  ${item.ingredient_name} — ${amount}`);
        }
        blocks.push(lines.join('\n'));
      }
      text = blocks.join('\n\n');
    }
    this.checkStockExportText = text;
    this.checkStockExportCopied = false;
    this.checkStockExportOpen = true;
  },

  /**
   * copyCheckStockExport — quick 260618-9sq. Copy the check-stock text to the
   * clipboard and flip the button label. Clipboard may be blocked (insecure context /
   * permissions); on failure the user can still select the <pre> manually. Mirrors
   * copyTrayExport.
   */
  async copyCheckStockExport() {
    try {
      await navigator.clipboard.writeText(this.checkStockExportText);
      this.checkStockExportCopied = true;
    } catch (e) {
      /* clipboard blocked; user selects manually */
    }
  },

  /**
   * downloadCheckStockExport — quick 260618-9sq. Download the check-stock text as
   * check-you-have-these.txt via the Blob + download-anchor lifecycle. Builds a NEW
   * browser file; never writes the store. Mirrors downloadTrayExport.
   */
  downloadCheckStockExport() {
    const blob = new Blob([this.checkStockExportText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'check-you-have-these.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  /**
   * openTrayExport — quick 260615-nev. Build the per-day tray-list plaintext export
   * and open the modal. SYNCHRONOUS (no getFile, no async): trayForDay / mealPlanByDay /
   * formatPackLine all read already-loaded in-memory data. ADDITIVE + READ-ONLY — it
   * REUSES the shared aggregation/formatting (trayForDay + formatPackLine), it does NOT
   * re-implement them (project convention: no duplicated load-bearing logic), and it
   * touches no CSV / write path.
   *
   * The per-item amount fallback is COPIED EXACTLY from the on-screen tray template
   * (index.html ~1594) so the export wording matches the screen verbatim.
   */
  openTrayExport() {
    // quick 260618-ahg — tray export covers UPCOMING days only (matches the on-screen tray gating).
    const groups = this.upcomingByDay;
    let text;
    if (!groups.length) {
      text = 'Your meal plan is empty — nothing to set aside.';
    } else {
      const blocks = [];
      for (const group of groups) {
        const lines = [`=== ${group.label} ===`];
        for (const grp of this.trayForDay(group.entries)) {
          lines.push(grp.section);
          for (const item of grp.items) {
            const amount = (item.parts && item.parts.length)
              ? this.formatPackLine(item)
              : (item.role === 'to_taste'
                  ? 'to taste'
                  : (item.role && item.role !== 'required' ? item.role : (item.caveat || '')));
            lines.push(`  ${item.ingredient_name} — ${amount}${item.pantry_staple ? ' [staple]' : ''}`);
          }
        }
        blocks.push(lines.join('\n'));
      }
      text = blocks.join('\n\n');
    }
    this.trayExportText = text;
    this.trayExportCopied = false;
    this.trayExportOpen = true;
  },

  /**
   * copyTrayExport — quick 260615-nev. Copy the tray text to the clipboard and flip
   * the button label. Clipboard may be blocked (insecure context / permissions); on
   * failure the user can still select the <pre> text manually. Mirrors copyShoppingExport.
   */
  async copyTrayExport() {
    try {
      await navigator.clipboard.writeText(this.trayExportText);
      this.trayExportCopied = true;
    } catch (e) {
      /* clipboard blocked; user selects manually */
    }
  },

  /**
   * downloadTrayExport — quick 260615-nev. Download the tray text as tray-lists.txt
   * via the Blob + download-anchor lifecycle. Builds a NEW browser file; never writes
   * the store. Mirrors downloadShoppingExport.
   */
  downloadTrayExport() {
    const blob = new Blob([this.trayExportText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tray-lists.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  /**
   * generateCookArtifact — Phase 06 (Plan 06-02). Async orchestrator for the
   * "Cook this day" artifact (D-01/D-03/D-04). Gathers ONE day's dishes from the
   * passed group ({ key, label, entries }), reads recipe headers, orders dishes by
   * type (D-07), splits instructions (D-10), gates on blank instructions (D-17),
   * guards file:// (RESEARCH Pitfall 1), and opens a self-contained Overview HTML
   * document in a new tab via a Blob URL.
   *
   * Popup-safety (RESEARCH Pitfall 2 OPTION A): the placeholder window is opened
   * SYNCHRONOUSLY inside the click gesture BEFORE the `await getFile`, then pointed
   * at the Blob URL. window.open after the await would be popup-blocked.
   *
   * Read-only + additive: touches no write path, no store write — only one
   * getFile('recipes.csv') read in the parent app (the emitted artifact is offline,
   * D-01). NO Anthropic API call (D-02). Called once = frozen snapshot (D-05).
   */
  async generateCookArtifact(group) {
    // Clear any stale notices from a prior generation.
    this.cookArtifactWarning = '';
    this.cookArtifactBlocked = false;
    this.cookArtifactError = '';

    // file:// guard (RESEARCH Pitfall 1): a blob minted from an opaque file://
    // origin silently kills the wizard's localStorage progress-save + Wake Lock.
    // Warn but DON'T hard-refuse — the Overview still renders and prints.
    if (location.protocol === 'file:') {
      this.cookArtifactWarning = 'Open this tool via http://localhost:8000 (not by double-clicking the file) so the cooking sheet can save your progress and keep the screen awake.';
    }

    // Open the placeholder tab synchronously inside the gesture (popup-safe).
    const win = window.open('', '_blank');
    if (!win) {
      this.cookArtifactBlocked = true;
      return;
    }

    // Fail-closed header read (mirrors openMealPlan ~L4066-4070): on failure show
    // an error AND close the placeholder tab so it doesn't sit blank.
    let recipes;
    try {
      recipes = await getFile('recipes.csv');
    } catch (_e) {
      this.cookArtifactError = "Couldn't read your recipe files, so the cooking sheet couldn't be built.";
      try { win.close(); } catch (_e2) { /* ignore */ }
      return;
    }
    const headerById = new Map(
      (Array.isArray(recipes.rows) ? recipes.rows : []).map(r => [parseInt(r.recipe_id, 10), r])
    );

    // D-17 gate: blank instructions_20 (empty/whitespace-only) is distinct from
    // "has text but doesn't split into steps" (D-16, handled in _buildCookModel).
    // Name the offending dishes and confirm() before producing the artifact.
    const blankDishes = [];
    for (const entry of (Array.isArray(group.entries) ? group.entries : [])) {
      const header = headerById.get(parseInt(entry.recipe_id, 10));
      const instr = header ? String(header.instructions_20 ?? '') : '';
      if (instr.trim() === '') {
        blankDishes.push((header && header.name) || entry.name || `Recipe ${entry.recipe_id}`);
      }
    }
    if (blankDishes.length) {
      const ok = window.confirm(
        `These dishes have no instructions and will appear with no method:\n\n  • ${blankDishes.join('\n  • ')}\n\nGenerate the cooking sheet anyway?`
      );
      if (!ok) {
        try { win.close(); } catch (_e2) { /* ignore */ }
        return;
      }
    }

    // Build the frozen model + render the standalone document, then point the
    // already-open tab at the Blob URL. Do NOT revokeObjectURL synchronously —
    // the new tab fetches the blob AFTER this returns (RESEARCH Pitfall 1 / Pattern 1).
    const model = this._buildCookModel(group, headerById);
    const html = this._renderCookArtifactHtml(model);
    win.location = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  },

  /**
   * _buildCookModel — Phase 06 (Plan 06-02). Gather one day's dishes into a plain,
   * serializable model (the FROZEN snapshot embedded in the artifact, D-05). NO
   * re-scaling later: scaledRowsFor is called ONCE here and the display strings are
   * precomputed so the artifact renders frozen text (D-05).
   *
   * Dishes are ordered main->side->salad->other (D-07) via orderEntriesByType.
   * Amounts use the D-12 verbatim formula copied from index.html ~L1632 (metric
   * leads; volumetric shown in parens only when BOTH present). Header fields are
   * read from the DISK row (so disk column names: prep_notes / serve_with /
   * instructions_20 — NOT the in-memory `prep` key). Planning metadata (popularity,
   * difficulty, last_made, source, *_notes) is deliberately SUPPRESSED.
   *
   * dayKey is group.key VERBATIM — the 'YYYY-MM-DD' date string for scheduled days
   * or the empty string '' for the Unscheduled bucket (confirmed against
   * _groupEntriesByDay). NOT normalized: Plan 03's wizard keys per-day localStorage
   * (cook-progress:v1:<dayKey>) off this exact value (D-14).
   */
  _buildCookModel(group, headerById) {
    const ordered = orderEntriesByType(Array.isArray(group.entries) ? group.entries : []);
    const dishes = ordered.map(entry => {
      const header = headerById.get(parseInt(entry.recipe_id, 10)) || {};
      const name = (header.name != null && header.name !== '') ? String(header.name) : (entry.name || `Recipe ${entry.recipe_id}`);

      // D-12 amount strings, copied VERBATIM from index.html ~L1632-1636.
      const ingredients = this.scaledRowsFor(entry).map(row => {
        const metricStr = (row.scaled_quantity_metric !== null && row.scaled_quantity_metric !== '')
          ? `${row.scaled_quantity_metric}${row.unit_metric || ''}` : '';
        const volStr = (row.scaled_quantity_volumetric !== null && row.scaled_quantity_volumetric !== '')
          ? `${row.scaled_quantity_volumetric} ${row.unit_volumetric || ''}` : '';
        const amount = metricStr || volStr;                          // headline
        const volParen = (metricStr && volStr) ? `(${volStr})` : ''; // muted secondary
        return {
          name: row.ingredient_name || '',
          amount,
          volParen,
          role: row.role || ''
        };
      });

      const instructionGroups = splitInstructionSteps(String(header.instructions_20 ?? ''));
      const stepCount = instructionGroups.reduce((n, g) => n + (Array.isArray(g.steps) ? g.steps.length : 0), 0);

      return {
        recipeId: entry.recipe_id,
        name,
        servings: entry.servings,
        prepNote: String(header.prep_notes ?? '').trim(),
        serveWith: String(header.serve_with ?? '').trim(),
        ingredients, // D-12 scaled cooking amounts (frozen strings, D-05)
        instructionGroups,
        hasSteps: stepCount > 0 // false = D-16 Overview-only (recorded for Plan 03's wizard skip)
      };
    });

    return {
      dayLabel: group.label,
      dayKey: group.key, // verbatim — 'YYYY-MM-DD' or '' (D-14); do NOT normalize
      generatedAt: new Date().toISOString(),
      dishes
    };
  },

  /**
   * _renderCookArtifactHtml — Phase 06 (Plan 06-02). Turn the frozen model into a
   * complete, self-contained <!doctype html> string (D-01: zero external deps, all
   * CSS/JS inlined, NO design tokens). The model is embedded as a JSON data island
   * (<script type="application/json" id="cook-data">) with the only escape needed
   * being every < -> < so a recipe step containing </script> (in ANY casing)
   * can't close the tag early. JSON.parse re-expands < back to < transparently.
   * All recipe text is rendered CLIENT-SIDE via textContent (NOT innerHTML), so no
   * HTML escaping of recipe text is needed and malformed-HTML/XSS is structurally
   * avoided (RESEARCH escaping recommendation; threat T-06-03).
   *
   * Renders the Overview document: header (day label, dish list w/ servings, a
   * generated-on timestamp), then per dish a .dish block (name, "Prep ahead"
   * callout, scaled ingredient list, numbered steps from instructionGroups, a
   * serve_with line). Includes an @media print sheet (D-13): hides .screen-only
   * chrome, keeps .dish together via break-inside:avoid, @page margins, 12pt body.
   * A .mode-toggle / .wizard seam is left for Plan 03's dual-mode runtime.
   */
  _renderCookArtifactHtml(model) {
    const json = JSON.stringify(model).replace(/</g, '\\u003c');
    const titleDay = String(model.dayLabel || 'Cook');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cook — ${titleDay.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</title>
<style>
  /* STANDALONE artifact CSS — literal values, NOT the parent app's design tokens (D-01).
     Tuned for kitchen-distance legibility: large body type, generous line-height. */
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 24px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 19px;
    line-height: 1.5;
    color: #1a1a1a;
    background: #fafafa;
  }
  .sheet { max-width: 820px; margin: 0 auto; }
  header.sheet-header {
    border-bottom: 3px solid #1a1a1a;
    padding-bottom: 16px;
    margin-bottom: 28px;
  }
  header.sheet-header h1 { font-size: 34px; margin: 0 0 8px; line-height: 1.2; }
  .dish-index { margin: 8px 0 0; padding: 0; list-style: none; font-size: 17px; color: #333; }
  .dish-index li { margin: 2px 0; }
  .dish-index .srv { color: #666; }
  .generated-at { font-size: 14px; color: #888; margin-top: 10px; }
  .dish {
    margin: 0 0 36px;
    padding: 20px 22px;
    background: #fff;
    border: 1px solid #ddd;
    border-radius: 8px;
  }
  .dish h2 { font-size: 27px; margin: 0 0 6px; line-height: 1.2; }
  .dish .servings { font-size: 15px; color: #666; margin: 0 0 14px; }
  .prep-ahead {
    background: #fff4d6;
    border-left: 5px solid #e0a800;
    padding: 10px 14px;
    margin: 0 0 16px;
    border-radius: 4px;
  }
  .prep-ahead .label { font-weight: 700; display: block; font-size: 15px; text-transform: uppercase; letter-spacing: 0.04em; color: #8a6d00; }
  h3.block-label { font-size: 16px; text-transform: uppercase; letter-spacing: 0.05em; color: #555; margin: 18px 0 8px; }
  ul.ingredients { margin: 0; padding: 0; list-style: none; }
  ul.ingredients li { padding: 5px 0; border-bottom: 1px solid #f0f0f0; display: flex; gap: 10px; flex-wrap: wrap; }
  ul.ingredients .amt { font-weight: 700; min-width: 90px; }
  ul.ingredients .vol { color: #888; }
  ul.ingredients .role { color: #999; font-style: italic; font-size: 15px; }
  .step-group { margin: 14px 0 0; }
  .step-group > .heading { font-weight: 700; font-size: 18px; margin: 14px 0 6px; color: #333; }
  ol.steps { margin: 0; padding-left: 1.6em; }
  ol.steps li { padding: 5px 0; }
  ol.steps .tip { display: block; margin-top: 4px; font-size: 15px; color: #666; font-style: italic; }
  .no-steps { color: #999; font-style: italic; margin: 8px 0 0; }
  .serve-with { margin: 16px 0 0; font-style: italic; color: #444; }
  .serve-with .label { font-style: normal; font-weight: 700; }

  /* ---- Dual-mode toggle (D-08/D-09) — Plan 03 ---- */
  .mode-toggle {
    display: flex;
    gap: 0;
    margin: 0 auto 24px;
    max-width: 820px;
    border: 2px solid #1a1a1a;
    border-radius: 8px;
    overflow: hidden;
  }
  .mode-toggle button {
    flex: 1 1 0;
    font: inherit;
    font-size: 18px;
    font-weight: 700;
    padding: 12px 16px;
    border: none;
    background: #fff;
    color: #1a1a1a;
    cursor: pointer;
  }
  .mode-toggle button + button { border-left: 2px solid #1a1a1a; }
  .mode-toggle button[aria-pressed="true"] { background: #1a1a1a; color: #fff; }

  /* The toggle flips a class on <body>: default (no class) = Overview (D-09);
     body.mode-wizard shows the wizard region and hides the overview. */
  .wizard { display: none; }
  body.mode-wizard .overview-region { display: none; }
  body.mode-wizard .wizard { display: block; }

  /* ---- Wizard (D-10/D-11/D-16) ---- */
  .wizard { max-width: 820px; margin: 0 auto; }
  .wizard-progress {
    font-size: 15px;
    color: #555;
    margin: 0 0 8px;
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 12px;
  }
  .wizard-progress .ticks { color: #2e7d32; font-weight: 700; }
  .wizard-card {
    background: #fff;
    border: 1px solid #ddd;
    border-radius: 8px;
    padding: 22px 24px 26px;
    min-height: 220px;
  }
  .wizard-card .dish-name {
    font-size: 16px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #555;
    margin: 0 0 6px;
  }
  .wizard-card .group-heading {
    font-weight: 700;
    font-size: 18px;
    color: #1a1a1a;
    margin: 0 0 12px;
    padding-bottom: 8px;
    border-bottom: 2px solid #eee;
  }
  .wizard-card .step-kind {
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #8a6d00;
    font-weight: 700;
    margin: 0 0 8px;
  }
  .wizard-card .step-text { font-size: 24px; line-height: 1.45; margin: 0; }
  .wizard-card .step-tip {
    display: block;
    margin-top: 12px;
    font-size: 16px;
    color: #666;
    font-style: italic;
  }
  .wizard-card.overview-only .step-text { font-size: 20px; color: #555; }
  .wizard-card .see-overview-hint {
    margin-top: 14px;
    font-size: 16px;
    color: #555;
  }
  .wizard-done {
    margin: 16px 0 0;
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 17px;
    cursor: pointer;
    user-select: none;
  }
  .wizard-done input { width: 22px; height: 22px; }

  /* Per-step collapsible full ingredient list (D-11) */
  .wizard-ingredients { margin: 18px 0 0; border-top: 1px solid #eee; }
  .wizard-ingredients > summary {
    cursor: pointer;
    font-weight: 700;
    font-size: 16px;
    padding: 12px 0 4px;
    list-style: revert;
  }
  .wizard-ingredients ul.ingredients { margin-top: 8px; }

  .wizard-nav {
    margin: 22px 0 0;
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }
  .wizard-nav button {
    font: inherit;
    font-size: 18px;
    font-weight: 700;
    padding: 12px 24px;
    border: 2px solid #1a1a1a;
    border-radius: 8px;
    background: #fff;
    color: #1a1a1a;
    cursor: pointer;
  }
  .wizard-nav button.primary { background: #1a1a1a; color: #fff; }
  .wizard-nav button:disabled { opacity: 0.4; cursor: default; }
  .wake-status { font-size: 13px; color: #999; margin: 12px 0 0; text-align: center; }

  @media print {
    body { background: #fff; font-size: 12pt; padding: 0; }
    .screen-only, .mode-toggle, .wizard { display: none !important; }
    /* Force Overview visible regardless of toggle state (D-13). */
    body.mode-wizard .overview-region { display: block !important; }
    .overview, .overview-region { display: block !important; }
    .dish {
      break-inside: avoid;
      page-break-inside: avoid;
      border: none;
      box-shadow: none;
      padding: 0;
      margin-bottom: 20pt;
    }
    .dish h2 { break-after: avoid; }
    @page { margin: 15mm; }
    a[href]::after { content: ""; }
  }
</style>
</head>
<body>
<script type="application/json" id="cook-data">${json}</script>
<div class="sheet">
  <header class="sheet-header">
    <h1 data-x="dayLabel"></h1>
    <ul class="dish-index" id="dish-index"></ul>
    <p class="generated-at" id="generated-at"></p>
  </header>
  <!-- Mode toggle (D-08): Overview default (D-09); flips body.mode-wizard. -->
  <div class="mode-toggle screen-only" id="mode-toggle">
    <button type="button" id="mode-overview" aria-pressed="true">Overview</button>
    <button type="button" id="mode-wizard-btn" aria-pressed="false">Step-by-step</button>
  </div>
  <!-- Overview region (everything visible). -->
  <div class="overview-region overview">
    <main id="dishes"></main>
  </div>
  <!-- Wizard region (one step at a time) — populated by the runtime (D-10/D-11/D-16). -->
  <div class="wizard" id="wizard">
    <p class="wizard-progress"><span id="wizard-position"></span><span class="ticks" id="wizard-ticks"></span></p>
    <div class="wizard-card" id="wizard-card"></div>
    <div class="wizard-nav">
      <button type="button" id="wizard-prev">‹ Back</button>
      <button type="button" id="wizard-next" class="primary">Next ›</button>
    </div>
    <p class="wake-status" id="wake-status"></p>
  </div>
</div>
<script>
  // STANDALONE artifact runtime — hand-written vanilla JS (D-01, no Alpine/CDN).
  // All recipe text is injected via textContent so it can never break the document.
  (function () {
    var DATA = JSON.parse(document.getElementById('cook-data').textContent);

    // Shared ingredient-list builder — used by BOTH the Overview and the wizard's
    // per-step collapsible panel (D-11: the SAME scaled amount strings, full list).
    function buildIngredientList(dish) {
      var ul = document.createElement('ul');
      ul.className = 'ingredients';
      (dish.ingredients || []).forEach(function (ing) {
        var li = document.createElement('li');
        if (ing.amount) {
          var a = document.createElement('span');
          a.className = 'amt';
          a.textContent = ing.amount;
          li.appendChild(a);
        }
        var n = document.createElement('span');
        n.className = 'ing-name';
        n.textContent = ing.name;
        li.appendChild(n);
        if (ing.volParen) {
          var v = document.createElement('span');
          v.className = 'vol';
          v.textContent = ing.volParen;
          li.appendChild(v);
        }
        if (ing.role && ing.role !== 'required') {
          var r = document.createElement('span');
          r.className = 'role';
          r.textContent = ing.role === 'to_taste' ? 'to taste' : ing.role;
          li.appendChild(r);
        }
        ul.appendChild(li);
      });
      return ul;
    }

    document.querySelector('[data-x="dayLabel"]').textContent = DATA.dayLabel || 'Cooking sheet';

    var idx = document.getElementById('dish-index');
    DATA.dishes.forEach(function (d) {
      var li = document.createElement('li');
      var nm = document.createElement('span');
      nm.textContent = d.name;
      li.appendChild(nm);
      if (d.servings != null && d.servings !== '') {
        var srv = document.createElement('span');
        srv.className = 'srv';
        srv.textContent = ' — ' + d.servings + ' servings';
        li.appendChild(srv);
      }
      idx.appendChild(li);
    });

    var gen = document.getElementById('generated-at');
    var when = DATA.generatedAt ? new Date(DATA.generatedAt) : null;
    gen.textContent = 'Generated ' + (when && !isNaN(when) ? when.toLocaleString() : (DATA.generatedAt || ''));

    var host = document.getElementById('dishes');
    DATA.dishes.forEach(function (d) {
      var sec = document.createElement('section');
      sec.className = 'dish';

      var h2 = document.createElement('h2');
      h2.textContent = d.name;
      sec.appendChild(h2);

      if (d.servings != null && d.servings !== '') {
        var srv = document.createElement('p');
        srv.className = 'servings';
        srv.textContent = d.servings + ' servings';
        sec.appendChild(srv);
      }

      if (d.prepNote) {
        var pa = document.createElement('div');
        pa.className = 'prep-ahead';
        var lab = document.createElement('span');
        lab.className = 'label';
        lab.textContent = 'Prep ahead';
        pa.appendChild(lab);
        var pn = document.createElement('span');
        pn.textContent = d.prepNote;
        pa.appendChild(pn);
        sec.appendChild(pa);
      }

      if (d.ingredients && d.ingredients.length) {
        var ih = document.createElement('h3');
        ih.className = 'block-label';
        ih.textContent = 'Ingredients';
        sec.appendChild(ih);
        sec.appendChild(buildIngredientList(d));
      }

      var mh = document.createElement('h3');
      mh.className = 'block-label';
      mh.textContent = 'Method';
      sec.appendChild(mh);

      if (d.hasSteps) {
        d.instructionGroups.forEach(function (g) {
          var grp = document.createElement('div');
          grp.className = 'step-group';
          if (g.heading) {
            var hd = document.createElement('div');
            hd.className = 'heading';
            hd.textContent = g.heading;
            grp.appendChild(hd);
          }
          var ol = document.createElement('ol');
          ol.className = 'steps';
          (g.steps || []).forEach(function (st) {
            var li = document.createElement('li');
            li.textContent = st.text;
            (st.tips || []).forEach(function (t) {
              var tip = document.createElement('span');
              tip.className = 'tip';
              tip.textContent = 'Tip: ' + t;
              li.appendChild(tip);
            });
            ol.appendChild(li);
          });
          grp.appendChild(ol);
          sec.appendChild(grp);
        });
      } else {
        var ns = document.createElement('p');
        ns.className = 'no-steps';
        ns.textContent = 'No numbered method recorded for this dish — see the recipe.';
        sec.appendChild(ns);
      }

      if (d.serveWith) {
        var sw = document.createElement('p');
        sw.className = 'serve-with';
        var swl = document.createElement('span');
        swl.className = 'label';
        swl.textContent = 'Serve with: ';
        sw.appendChild(swl);
        var swt = document.createElement('span');
        swt.textContent = d.serveWith;
        sw.appendChild(swt);
        sec.appendChild(sw);
      }

      host.appendChild(sec);
    });

    // ====================================================================
    // WIZARD (D-08/D-09/D-10/D-11/D-16) — hand-written vanilla, no Alpine.
    // One numbered instruction line = one wizard step (D-10); section headings
    // are non-counting group dividers shown above their first step; prepNote is
    // an optional per-dish step-zero ("Prep ahead"); EVERY step carries a
    // collapsible full scaled ingredient list (D-11); a hasSteps===false dish is
    // a single "see Overview" card and is never best-effort-split (D-16).
    // ====================================================================

    // Flatten the model into an ordered sequence of wizard cards. Each item:
    //   { dishIdx, dishName, kind, heading?, text?, tips?, isFirstOfGroup, stepLabel }
    // kind ∈ 'prep' | 'step' | 'overview-only'. dishIdx is the dish's index in
    // model order — the stable per-dish id used for completed-step keying (D-14).
    var SEQUENCE = (function buildSequence() {
      var seq = [];
      DATA.dishes.forEach(function (d, dishIdx) {
        if (!d.hasSteps) {
          // D-16: Overview-only dish — single pointer card, no synthesized steps.
          seq.push({ dishIdx: dishIdx, dishName: d.name, kind: 'overview-only' });
          return;
        }
        // Optional step-zero from prepNote (Claude's-discretion wizard placement).
        if (d.prepNote) {
          seq.push({ dishIdx: dishIdx, dishName: d.name, kind: 'prep', text: d.prepNote });
        }
        (d.instructionGroups || []).forEach(function (g) {
          (g.steps || []).forEach(function (st, sIdx) {
            seq.push({
              dishIdx: dishIdx,
              dishName: d.name,
              kind: 'step',
              heading: g.heading || null,
              isFirstOfGroup: sIdx === 0 && !!g.heading,
              text: st.text,
              tips: st.tips || []
            });
          });
        });
      });
      return seq;
    })();

    var cardEl = document.getElementById('wizard-card');
    var posEl = document.getElementById('wizard-position');
    var ticksEl = document.getElementById('wizard-ticks');
    var prevBtn = document.getElementById('wizard-prev');
    var nextBtn = document.getElementById('wizard-next');
    var overviewBtn = document.getElementById('mode-overview');
    var wizardBtn = document.getElementById('mode-wizard-btn');

    // In-memory progress state, mirrored to localStorage (D-14).
    var state = {
      pos: 0,                 // index into SEQUENCE (dishIndex + stepIndex collapse to one cursor)
      completed: {}           // { [dishIdx]: { [seqIndex]: true } } — ticked steps
    };

    // ---- D-14: per-day localStorage progress ----
    // Deterministic per-day key sourced from the island's dayKey VERBATIM (= group.key:
    // 'YYYY-MM-DD' for scheduled days, '' for Unscheduled → literal 'cook-progress:v1:').
    // NOT the blob UUID, NOT a recomputed/normalized value (RESEARCH Pitfall 4, T-06-08).
    // Schema-versioned (v1) so a future shape change can't read stale data.
    var STORAGE_KEY = 'cook-progress:v1:' + (DATA.dayKey == null ? '' : String(DATA.dayKey));

    // localStorage throws on an opaque origin (file://-served artifact) — wrap every
    // access in try/catch and fail soft to in-memory-only (T-06-09, D-14 file:// note).
    function persist() {
      try {
        var payload = {
          dishIndex: SEQUENCE.length ? SEQUENCE[state.pos].dishIdx : 0,
          stepIndex: state.pos,
          completed: state.completed
        };
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      } catch (e) { /* opaque origin / quota / private mode — no-op, in-memory only */ }
    }
    function restore() {
      var raw = null;
      try { raw = window.localStorage.getItem(STORAGE_KEY); }
      catch (e) { return; } // opaque origin → keep defaults, in-memory only
      if (!raw) return;
      try {
        var saved = JSON.parse(raw);
        if (saved && typeof saved === 'object') {
          if (typeof saved.stepIndex === 'number' && saved.stepIndex >= 0) {
            state.pos = Math.min(saved.stepIndex, Math.max(0, SEQUENCE.length - 1));
          }
          if (saved.completed && typeof saved.completed === 'object') {
            state.completed = saved.completed;
          }
        }
      } catch (e) { /* corrupt/stale shape — ignore, start fresh */ }
    }

    // ---- D-15: Screen Wake Lock (keep a kitchen tablet awake) ----
    // Feature-detected + try/catch swallowed → graceful no-op where unsupported or
    // denied (battery saver, hidden doc). Re-acquired on visibilitychange because the
    // OS auto-releases on hide and does NOT re-acquire (RESEARCH Pitfall 3, T-06-10).
    var wakeLock = null;
    var inWizardMode = false;
    var wakeStatusEl = document.getElementById('wake-status');
    function setWakeStatus(msg) { if (wakeStatusEl) wakeStatusEl.textContent = msg || ''; }

    function acquireWake() {
      if (!('wakeLock' in navigator)) { setWakeStatus('Screen stay-awake not supported on this device.'); return; }
      if (document.visibilityState !== 'visible') return;
      if (wakeLock) return; // already held
      try {
        navigator.wakeLock.request('screen').then(function (lock) {
          // WR-02: request() is async. If the user left wizard mode (or a
          // release ran) while it was in flight, the lock resolves AFTER exit —
          // release it immediately rather than letting it persist in Overview.
          if (!inWizardMode) {
            try { lock.release(); } catch (e) { /* no-op */ }
            return;
          }
          wakeLock = lock;
          setWakeStatus('Screen will stay awake while cooking.');
          if (lock && typeof lock.addEventListener === 'function') {
            lock.addEventListener('release', function () { wakeLock = null; });
          }
        }).catch(function () { /* denied — no-op, wizard still works (D-15) */ });
      } catch (e) { /* never throw (D-15) */ }
    }
    function releaseWake() {
      try { if (wakeLock && typeof wakeLock.release === 'function') wakeLock.release(); }
      catch (e) { /* no-op */ }
      wakeLock = null;
    }
    function onEnterWizard() { inWizardMode = true; acquireWake(); }
    function onExitWizard() { inWizardMode = false; releaseWake(); setWakeStatus(''); }

    document.addEventListener('visibilitychange', function () {
      // Re-acquire only when visible AND still in the wizard (OS released it on hide).
      if (document.visibilityState === 'visible' && inWizardMode) acquireWake();
    });
    window.addEventListener('pagehide', function () { releaseWake(); });

    function countCompleted() {
      var n = 0;
      Object.keys(state.completed).forEach(function (dk) {
        n += Object.keys(state.completed[dk] || {}).length;
      });
      return n;
    }

    function isCompleted(item, seqIdx) {
      var byDish = state.completed[item.dishIdx];
      return !!(byDish && byDish[seqIdx]);
    }

    function setCompleted(item, seqIdx, on) {
      if (item.kind === 'overview-only') return;
      var byDish = state.completed[item.dishIdx] || (state.completed[item.dishIdx] = {});
      if (on) { byDish[seqIdx] = true; } else { delete byDish[seqIdx]; }
      persist();
    }

    function renderCard() {
      if (!SEQUENCE.length) {
        cardEl.textContent = '';
        var empty = document.createElement('p');
        empty.className = 'step-text';
        empty.textContent = 'No wizard steps — see Overview for this day.';
        cardEl.appendChild(empty);
        posEl.textContent = '';
        ticksEl.textContent = '';
        prevBtn.disabled = true;
        nextBtn.disabled = true;
        return;
      }
      if (state.pos < 0) { state.pos = 0; }
      if (state.pos > SEQUENCE.length - 1) { state.pos = SEQUENCE.length - 1; }
      var item = SEQUENCE[state.pos];
      cardEl.textContent = '';
      cardEl.className = 'wizard-card' + (item.kind === 'overview-only' ? ' overview-only' : '');

      // Dish name (which dish this step belongs to).
      var dn = document.createElement('p');
      dn.className = 'dish-name';
      dn.textContent = item.dishName;
      cardEl.appendChild(dn);

      // Section heading divider (D-10) — only above the first step of a group.
      if (item.isFirstOfGroup && item.heading) {
        var gh = document.createElement('p');
        gh.className = 'group-heading';
        gh.textContent = item.heading;
        cardEl.appendChild(gh);
      }

      if (item.kind === 'prep') {
        var pk = document.createElement('p');
        pk.className = 'step-kind';
        pk.textContent = 'Prep ahead';
        cardEl.appendChild(pk);
      }

      if (item.kind === 'overview-only') {
        var ot = document.createElement('p');
        ot.className = 'step-text';
        ot.textContent = 'This dish has no numbered steps.';
        cardEl.appendChild(ot);
        var hint = document.createElement('p');
        hint.className = 'see-overview-hint';
        hint.textContent = 'See Overview for this dish — switch to Overview mode for its full method.';
        cardEl.appendChild(hint);
      } else {
        var stx = document.createElement('p');
        stx.className = 'step-text';
        stx.textContent = item.text;
        (item.tips || []).forEach(function (t) {
          var tip = document.createElement('span');
          tip.className = 'step-tip';
          tip.textContent = 'Tip: ' + t;
          stx.appendChild(tip);
        });
        cardEl.appendChild(stx);

        // Per-step "done" tick (skipped for overview-only).
        var doneLabel = document.createElement('label');
        doneLabel.className = 'wizard-done';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = isCompleted(item, state.pos);
        cb.addEventListener('change', function () {
          setCompleted(item, state.pos, cb.checked);
          updateProgress();
        });
        doneLabel.appendChild(cb);
        var dt = document.createElement('span');
        dt.textContent = 'Mark this step done';
        doneLabel.appendChild(dt);
        cardEl.appendChild(doneLabel);
      }

      // Collapsible full scaled ingredient list on EVERY step (D-11).
      var dish = DATA.dishes[item.dishIdx];
      if (dish && dish.ingredients && dish.ingredients.length) {
        var det = document.createElement('details');
        det.className = 'wizard-ingredients';
        var sum = document.createElement('summary');
        sum.textContent = 'Ingredients (' + dish.name + ')';
        det.appendChild(sum);
        det.appendChild(buildIngredientList(dish));
        cardEl.appendChild(det);
      }

      prevBtn.disabled = state.pos <= 0;
      nextBtn.disabled = state.pos >= SEQUENCE.length - 1;
      updateProgress();
    }

    function updateProgress() {
      posEl.textContent = 'Step ' + (state.pos + 1) + ' of ' + SEQUENCE.length;
      var done = countCompleted();
      ticksEl.textContent = done ? ('✓ ' + done + ' done') : '';
    }

    prevBtn.addEventListener('click', function () {
      if (state.pos > 0) { state.pos -= 1; persist(); renderCard(); }
    });
    nextBtn.addEventListener('click', function () {
      if (state.pos < SEQUENCE.length - 1) { state.pos += 1; persist(); renderCard(); }
    });

    function setMode(wizard) {
      document.body.classList.toggle('mode-wizard', !!wizard);
      overviewBtn.setAttribute('aria-pressed', wizard ? 'false' : 'true');
      wizardBtn.setAttribute('aria-pressed', wizard ? 'true' : 'false');
      if (wizard) { renderCard(); onEnterWizard(); } else { onExitWizard(); }
    }
    overviewBtn.addEventListener('click', function () { setMode(false); });
    wizardBtn.addEventListener('click', function () { setMode(true); });

    // Restore persisted progress (no-op until Plan 03 Task 2), then prime the card.
    restore();
    renderCard();
    // Default mode = Overview (D-09): no body.mode-wizard class is set on load.
  })();
</script>
</body>
</html>`;
  },

  /**
   * allergensByRecipeId — quick 260610-eyh. Per-recipe derived allergen union for
   * the Recipe Manager allergen-exclude filter. Returns a
   * `Map<recipe_id:number, { allergens: string[], incomplete: boolean }>` recomputed
   * from the current `this.duplicateIndex.ingredientIdsByRecipeId` + `this.ingredientMaster`
   * (recomputed each access so it stays correct when either changes — recipeList is
   * ~hundreds of rows and the master ~235, so the cost is trivial).
   *
   * Reuses the derivedAllergens masterById pattern (build the id→allergens Map ONCE).
   * For each recipe_id's Set<ingredient_id>: if masterById HAS the id, union its
   * allergens; else flip `incomplete=true` (an ingredient_id not in the master).
   *
   * SAFETY (allergens): `incomplete` drives the "⚠ allergens may be incomplete" caveat
   * AND the never-hide rule in filteredRecipeList — an incomplete recipe is NEVER
   * filtered OUT by the allergen-exclude filter (it could under-report allergens).
   * A recipe absent from the Map entirely is treated by the caller as incomplete too
   * (unknown ingredient data → kept visible + caveated).
   *
   * Guard: returns an empty Map when duplicateIndex is null/has no
   * ingredientIdsByRecipeId, or when the ingredient master is empty.
   */
  get allergensByRecipeId() {
    const out = new Map();
    const idMap = (this.duplicateIndex && this.duplicateIndex.ingredientIdsByRecipeId instanceof Map)
      ? this.duplicateIndex.ingredientIdsByRecipeId
      : null;
    if (!idMap) return out;
    if (!Array.isArray(this.ingredientMaster) || this.ingredientMaster.length === 0) return out;
    const masterById = new Map(
      this.ingredientMaster.map(m => [m.ingredient_id, m.allergens || []])
    );
    for (const [recipeId, idSet] of idMap) {
      const set = new Set();
      let incomplete = false;
      if (idSet instanceof Set) {
        for (const iid of idSet) {
          if (masterById.has(iid)) {
            const allergens = masterById.get(iid);
            if (Array.isArray(allergens)) {
              for (const a of allergens) { if (a) set.add(a); }
            }
          } else {
            incomplete = true; // ingredient_id not in the master → allergen set may be partial
          }
        }
      } else {
        incomplete = true; // no usable ingredient set for this recipe
      }
      // FSA14.filter preserves the canonical FSA-14 order (matches derivedAllergens).
      out.set(recipeId, { allergens: FSA14.filter(a => set.has(a)), incomplete });
    }
    return out;
  },

  /**
   * allergenFilterAvailable — quick 260610-eyh. True only when the read-only
   * duplicate index (and its ingredientIdsByRecipeId Map) loaded — the allergen
   * filter is a no-op / disabled otherwise (graceful degrade, T-eyh-02).
   */
  get allergenFilterAvailable() {
    return !!(this.duplicateIndex && this.duplicateIndex.ingredientIdsByRecipeId);
  },

  /**
   * filteredRecipeList — quick 260608-agp; quick 260610-eyh extends with Type +
   * Allergen-exclude filters. Composition order (all AND): NAME (existing
   * case-insensitive substring — preserved byte-compatibly as the first stage),
   * then TYPE (OR within the selected set; none = all; blank type hidden once any
   * type is selected), then ALLERGEN-EXCLUDE.
   *
   * Allergen-exclude rule: a recipe is HIDDEN iff the avoided set is non-empty AND
   * the filter is available AND its derived allergen union intersects the avoided
   * set AND it is NOT incomplete. SAFETY: incomplete/unknown-data recipes (no entry
   * in allergensByRecipeId, or entry.incomplete) are NEVER hidden by this filter —
   * they survive (with a caveat in the UI) regardless of their known allergens.
   * (Does NOT reuse the ingredient Fuse index — that indexes ingredients, not recipes.)
   */
  get filteredRecipeList() {
    const list = Array.isArray(this.recipeList) ? this.recipeList : [];
    // Stage 1 — NAME (existing behaviour, preserved byte-compatibly).
    const q = (this.recipeManagerFilter || '').trim();
    let result = list;
    if (q) {
      const lower = q.toLowerCase();
      result = result.filter(r => (r.name || '').toLowerCase().includes(lower));
    }
    // Stage 2 — TYPE (quick 260610-eyh). OR within the selected set; none = all;
    // a blank type fails membership → hidden once any type is selected.
    const types = Array.isArray(this.recipeManagerTypeFilter) ? this.recipeManagerTypeFilter : [];
    if (types.length > 0) {
      const wanted = new Set(types.map(t => (t || '').trim().toLowerCase()));
      result = result.filter(r => wanted.has((r.type || '').trim().toLowerCase()));
    }
    // Stage 3 — ALLERGEN-EXCLUDE (quick 260610-eyh). No-op unless available AND
    // at least one allergen avoided. SAFETY: never hide incomplete/unknown-data.
    const avoided = Array.isArray(this.recipeManagerAllergenFilter) ? this.recipeManagerAllergenFilter : [];
    if (this.allergenFilterAvailable && avoided.length > 0) {
      const avoidSet = new Set(avoided);
      const byId = this.allergensByRecipeId;
      result = result.filter(r => {
        const entry = byId.get(r.recipe_id);
        if (!entry || entry.incomplete) return true; // never hide incomplete/unknown — surfaced with caveat
        return !entry.allergens.some(a => avoidSet.has(a)); // hide only when a KNOWN allergen is avoided
      });
    }
    return result;
  },

  /**
   * recipeManagerResultCount — quick 260610-eyh. Count of currently-visible
   * recipes (drives the "N of M recipes" line + empty-state).
   */
  get recipeManagerResultCount() {
    return this.filteredRecipeList.length;
  },

  /**
   * recipeManagerHiddenFilterCount — quick 260621-9lo. Count of active filters
   * living INSIDE the Filters disclosure (allergen-exclude only — Type lives
   * outside in the primary chip row). Drives the accent badge on the Filters
   * disclosure button. Mirrors mealPlanHiddenFilterCount.
   */
  get recipeManagerHiddenFilterCount() {
    return Array.isArray(this.recipeManagerAllergenFilter) ? this.recipeManagerAllergenFilter.length : 0;
  },

  /**
   * clearManagerFilters — quick 260610-eyh. Resets all three browse filters.
   */
  clearManagerFilters() {
    this.recipeManagerFilter = '';
    this.recipeManagerTypeFilter = [];
    this.recipeManagerAllergenFilter = [];
  },

  /**
   * openRecipeForEdit — quick 260608-agp. Load one recipe into the EXISTING
   * parse-view editor (form.header + form.rows). Refuses while approving/merging.
   * Reads BOTH files FRESH; refuses old/un-migrated recipe_ingredients.csv;
   * maps the disk `main/side/salad` column to the in-memory `main_side_salad`
   * key and splits the allergens string on ';' into an Array.
   */
  async openRecipeForEdit(recipe_id) {
    if (this.approving || this.merging) return;
    this.recipeManagerError = '';
    this.recipeManagerNotice = '';

    let recipes, recipeIngredients;
    try {
      recipes = await getFile('recipes.csv');
      recipeIngredients = await getFile('recipe_ingredients.csv');
    } catch (_e) {
      this.recipeManagerError = "Couldn't read your recipe files, so nothing was opened for editing. Try Pick CSV folder again.";
      return;
    }
    if (isOldSchemaJoinHeader(recipeIngredients.columns) || !isMigratedJoinHeader(recipeIngredients.columns)) {
      this.recipeManagerError = 'recipe_ingredients.csv is on the old schema — click Migrate schema first.';
      return;
    }

    const idNum = Number(recipe_id);
    const diskRow = recipes.rows.find(r => parseInt(r.recipe_id, 10) === idNum);
    if (!diskRow) {
      this.recipeManagerError = "That recipe wasn't found — try Pick CSV folder again.";
      return;
    }

    // Build the editor header from the disk row. CRITICAL: the recipes.csv disk
    // column is `main/side/salad` (slashes) but the editor binds the in-memory
    // key `main_side_salad` (underscores) — read both variants and assign to the
    // underscore key (a wrong mapping here silently drops the recipe type).
    this.form.header = {
      name: diskRow.name ?? '',
      main_side_salad: diskRow['main/side/salad'] ?? diskRow['main_side_salad'] ?? '',
      // Disk column is `prep_notes` (legacy files may use `prep`); the editor
      // binds the in-memory key `prep` — boundary-translated like main_side_salad.
      prep: diskRow.prep_notes ?? diskRow.prep ?? '',
      instructions_20: diskRow.instructions_20 ?? '',
      ingredients_20: diskRow.ingredients_20 ?? '',
      source: diskRow.source ?? '',
      max_servings: diskRow.max_servings === '' || diskRow.max_servings == null ? null : Number(diskRow.max_servings),
      popularity: diskRow.popularity === '' || diskRow.popularity == null ? null : Number(diskRow.popularity),
      difficulty: diskRow.difficulty === '' || diskRow.difficulty == null ? null : Number(diskRow.difficulty),
      last_made: diskRow.last_made ?? '',
      serve_with: diskRow.serve_with ?? '',
      popularity_notes: diskRow.popularity_notes ?? '',
      difficulty_notes: diskRow.difficulty_notes ?? '',
      // Disk stores a semicolon-joined string; the editor binds an Array.
      allergens: (diskRow.allergens ?? '').split(';').map(s => s.trim()).filter(Boolean)
    };

    // Build editor rows from the join rows for THIS recipe, sorted by line_order.
    const joinRows = recipeIngredients.rows
      .filter(r => parseInt(r.recipe_id, 10) === idNum)
      .sort((a, b) => (Number(a.line_order) || 0) - (Number(b.line_order) || 0));
    this.form.rows = joinRows.map(r => this._diskRowToEditorRow(r));

    this.editingRecipeId = idNum;
    // Clear stale parse-time validation notes so they don't bleed into the editor.
    this.validationWarnings = [];
    this.validationErrors = [];
    this.recipeDeleteConfirmText = '';
  },

  /**
   * _diskRowToEditorRow — quick 260608-agp. Map one recipe_ingredients.csv disk
   * row to the blankRow()-shaped editor row (the inverse of toJoinCsvRow), adding
   * the synthetic _key + _confirmed review markers.
   */
  _diskRowToEditorRow(r) {
    const num = (v) => (v === '' || v == null) ? null : Number(v);
    return {
      _key: nextRowKey(),
      _confirmed: false,
      line_order: num(r.line_order),
      ingredient_id: num(r.ingredient_id),
      ingredient_name: r.ingredient_name ?? '',
      quantity_metric: num(r.quantity_metric),
      unit_metric: r.unit_metric ?? 'g',
      quantity_volumetric: num(r.quantity_volumetric),
      unit_volumetric: r.unit_volumetric ?? null,
      section: r.section ?? '',
      prep_note: r.prep_note ?? '',
      // role-vs-legacy-booleans: prefer the explicit role column; fall back to the
      // legacy boolean trio when role is absent.
      role: r.role
        ? r.role
        : ((r.is_garnish === 'TRUE') ? 'garnish'
          : (r.is_optional === 'TRUE') ? 'optional'
          : (r.is_to_taste === 'TRUE') ? 'to_taste'
          : 'required'),
      raw_text: r.raw_text ?? '',
      flag_fix_me: r.flag_fix_me === 'TRUE',
      flagged_fields: []
    };
  },

  /**
   * saveRecipeEdit — quick 260608-agp. Write the edited recipe back to BOTH live
   * files in place. Mirrors saveEditIngredient's guard+permission+write skeleton
   * but drives the two-file orchestrator (_rewriteTwoFilesInPlace).
   *
   * Data-safety (T-agp-01/02/03): re-reads BOTH files FRESH before building
   * newRows, REPLACES only the edited recipe's header row + join rows (line_order
   * re-derived 1..N in form order) and PRESERVES every other recipe's rows
   * verbatim (same object reference — never reconstructed from in-memory state).
   * Validates first (render-don't-block per D-20).
   */
  async saveRecipeEdit() {
    if (this.approving || this.merging) return;
    this.recipeManagerError = '';
    this.recipeManagerNotice = '';
    // quick 260621-bhx — the 'new' sentinel routes to the APPEND path
    // (saveNewRecipe) instead of the replace-by-id path below, which assumes an
    // integer id that must already exist in recipes.csv. The Save button keeps
    // @click="saveRecipeEdit()" — this branch is the single dispatch point.
    if (this.isAddingRecipe) return this.saveNewRecipe();
    if (this.editingRecipeId == null) return;

    // Validate first — surface autoFixes/hardErrors as the editor's inline labels.
    // D-20: render, do NOT hard-block. Use the CORRECTED `value` for the write so
    // clamps are persisted (matches the parse-flow behaviour).
    const { value, autoFixes, hardErrors } = validateRecipe({ header: this.form.header, rows: this.form.rows });
    this.validationWarnings = autoFixes;
    this.validationErrors = hardErrors;

    const idNum = Number(this.editingRecipeId);
    this.merging = true;
    try {
      // Re-read BOTH files FRESH (read-before-write).
      let recipes, recipeIngredients;
      try {
        recipes = await getFile('recipes.csv');
        recipeIngredients = await getFile('recipe_ingredients.csv');
      } catch (_e) {
        this.recipeManagerError = "Couldn't re-read your recipe files before saving, so nothing was changed. Try Pick CSV folder again.";
        this.merging = false;
        return;
      }
      if (isOldSchemaJoinHeader(recipeIngredients.columns) || !isMigratedJoinHeader(recipeIngredients.columns)) {
        this.recipeManagerError = 'recipe_ingredients.csv is on the old schema — click Migrate schema first.';
        this.merging = false;
        return;
      }

      const recipesColumns = recipes.columns || [];
      const joinColumns = recipeIngredients.columns || [];

      // recipes.csv newRows — replace ONLY the edited recipe's header row; every
      // other row preserved verbatim (same reference). Refuse if the target id is
      // not in the fresh read (someone changed the file).
      const targetIdx = recipes.rows.findIndex(r => parseInt(r.recipe_id, 10) === idNum);
      if (targetIdx === -1) {
        this.recipeManagerError = "That recipe is no longer in recipes.csv — the file may have changed. Try Pick CSV folder again.";
        this.merging = false;
        return;
      }
      const recipesNewRows = recipes.rows.map((r, i) =>
        i === targetIdx ? toHeaderCsvRow(value.header, idNum, recipesColumns) : r
      );

      // recipe_ingredients.csv newRows — drop all rows for this recipe, then
      // APPEND the edited recipe's rows (value.rows order) with line_order
      // re-derived 1..N. All OTHER recipes' rows preserved verbatim. The edited
      // block is appended after the preserved others (downstream reads filter by
      // recipe_id and sort by line_order, so position is immaterial).
      const preservedJoinRows = recipeIngredients.rows.filter(r => parseInt(r.recipe_id, 10) !== idNum);
      const editedJoinRows = value.rows.map((row, i) =>
        toJoinCsvRow({ ...row, line_order: i + 1 }, idNum, joinColumns)
      );
      const joinNewRows = [...preservedJoinRows, ...editedJoinRows];

      // ORDER: recipes.csv first, recipe_ingredients.csv second (both backed up
      // first regardless). recipes.csv has no migration gate (headerCheckFn
      // undefined); the join file is verified against isMigratedJoinHeader.
      await this._rewriteTwoFilesInPlace(
        { filename: 'recipes.csv', newRows: recipesNewRows },
        { filename: 'recipe_ingredients.csv', newRows: joinNewRows, headerCheckFn: isMigratedJoinHeader },
        // Phase 11 Plan 02 (D-08) — "Name: edit recipe <id> ('Title')".
        { action: 'edit', title: `${idNum} ('${value.header?.name ?? ''}')` }
      );

      // Success — refresh the browse list from disk so the edited name shows, then
      // collapse back to the list (matches the ingredient manager's save pattern).
      try {
        const fresh = await getFile('recipes.csv');
        this.recipeList = this._buildRecipeList(fresh.rows);
        await this._refreshRecipeQtyGaps();   // quick 260613-a2t — READ-ONLY qty-gap tally refresh
      } catch (_e) { /* non-fatal — list refresh only */ }
      // quick 260615-dap — PRIMARY live-rescale hook. The recipe editor opens as a
      // MODAL OVER the meal plan, so after closeEditRecipe the user lands back on it.
      // Rebuilding mealPlanGrouped from disk (new amounts) makes scaledRowsFor /
      // combinedShoppingList recompute LIVE — no manual re-open. Fail-open: a refresh
      // failure must never block the save's success path.
      try { if (this.csvStoreLoaded) await this._rebuildMealPlanGrouped(); } catch (_e) { /* best-effort scaling refresh */ }
      this.recipeManagerNotice = `Saved "${value.header.name}" ✓`;
      // quick 260614-od7 — delegate teardown to closeEditRecipe (SINGLE owner of the
      // parse-snapshot restore). The recipe is now persisted, so this.form is returned
      // to the pre-edit parse state; the notice was set ABOVE and survives the close.
      this.closeEditRecipe();
    } catch (e) {
      if (e && e.isRestoreOfferSentinel) {
        // The COMBINED restore banner (mergeRestoreOffer) is already set by the
        // orchestrator — just stop (do NOT also set recipeManagerError).
      } else if (this._routePushFailure(e)) {
        // Phase 11 Plan 03 (SAVE-02): remote push failure → pushConflictOffer
        // (the only banner); the open editor's edit is left untouched on screen.
      } else {
        // A backup-failure abort arrives here as a PLAIN error (no sentinel) and
        // correctly falls into this branch — no restore banner, nothing written.
        this.recipeManagerError = (e && e.message) ? e.message : "Couldn't save your changes.";
      }
    } finally {
      this.merging = false;
    }
  },

  /**
   * saveNewRecipe — quick 260621-bhx. APPEND a brand-new recipe to BOTH live
   * files. Modeled on saveRecipeEdit's APPEND half (never the replace half):
   * it adds ONE new header row to recipes.csv and the recipe's join rows
   * (line_order 1..N) to recipe_ingredients.csv, preserving every existing row
   * verbatim (same object reference).
   *
   * Data-safety:
   *  - T-bhx-01: reuses _rewriteTwoFilesInPlace verbatim (snapshot → write →
   *    re-verify → AUTOMATIC revert on verify failure). Never bypassed.
   *  - T-bhx-02: the recipe_id is recomputed as max(existing recipe_id)+1
   *    against the FRESHLY re-read recipes.csv at WRITE time (not the open-time
   *    suggestion — the file may have changed since open). Computing maxOnDisk+1
   *    fresh is inherently collision-free for an append with no user-chosen id,
   *    so we do it inline rather than via recomputeRecipeId (which is geared to
   *    a user-editable suggestion).
   *  - T-bhx-03: STRICTER-than-edit — unlike saveRecipeEdit (which renders
   *    hardErrors and proceeds with the corrected value, D-20), the new path
   *    BLOCKS on hardErrors so a brand-new empty recipe can't append a junk row
   *    (e.g. a blank starter row hard-errors on raw_text — the intended "no
   *    usable ingredient" block). A junk first-ever row is worse than a junk
   *    edit because it manufactures schema-violating data from nothing.
   */
  async saveNewRecipe() {
    // ── quick-260621-bhx checkpoint fix (manual-add ONLY) ──────────────────
    // raw_text is a PARSE-flow artifact (the verbatim pasted source line). In
    // manual entry there IS no pasted source, so we must NOT force the user to
    // type a per-row "recipe text". Two pre-validation transforms, scoped
    // strictly to this saveNewRecipe path (never parse/approve or edit-existing):
    //
    //   STEP 2 — drop genuinely-empty rows: a row counts as "real" iff it has an
    //   ingredient (non-null ingredient_id OR non-blank ingredient_name). Rows
    //   with neither are dropped SILENTLY (the leftover blank starter row must
    //   never block the save). After dropping, re-derive line_order 1..N. If
    //   ZERO real rows remain, block with a clear "add an ingredient" message.
    //
    //   STEP 1 — auto-derive raw_text for any surviving row whose raw_text is
    //   blank/whitespace, composed from the structured fields the user filled
    //   ("{qty} {unit} {name}{, prep_note}", preferring the volumetric pair,
    //   else metric). A user-typed raw_text is preserved verbatim.
    //
    // Doing both BEFORE validateRecipe means every surviving row already carries
    // a non-empty raw_text by the time validation runs — so validateRecipe's
    // raw_text non-empty rule is satisfied without weakening it for any flow.

    // STEP 2 — drop entirely-empty rows (no ingredient_id AND blank name).
    const realRows = (this.form.rows || []).filter(r => {
      const hasId = r.ingredient_id !== null && r.ingredient_id !== undefined && String(r.ingredient_id).trim() !== '';
      const hasName = !!(r.ingredient_name && String(r.ingredient_name).trim());
      return hasId || hasName;
    });
    if (!realRows.length) {
      this.recipeManagerError = 'Add at least one ingredient.';
      return;
    }
    // STEP 1 — auto-derive raw_text where blank, then re-derive line_order 1..N.
    const preparedRows = realRows.map((r, i) => {
      const existing = (r.raw_text == null) ? '' : String(r.raw_text).trim();
      const raw_text = existing || deriveRawTextFromRow(r);
      return { ...r, raw_text, line_order: i + 1 };
    });
    // Mutate the live form so inline validation labels (if any fire) line up
    // with the rows we actually validate + write.
    this.form.rows = preparedRows;

    // Validate first — surface autoFixes/hardErrors as inline labels EXACTLY
    // like saveRecipeEdit (render parity for warnings).
    const { value, autoFixes, hardErrors } = validateRecipe({ header: this.form.header, rows: this.form.rows });
    this.validationWarnings = autoFixes;
    this.validationErrors = hardErrors;
    // STRICTER-than-edit (T-bhx-03): block the append on hardErrors so an empty
    // / no-usable-ingredient recipe can't enter the schema-locked CSVs. By now
    // every surviving row has a derived raw_text, so this no longer fires solely
    // on a blank raw_text in the manual-add path.
    if (hardErrors && hardErrors.length) {
      this.recipeManagerError = "This recipe can't be added yet — fix the highlighted problems first (each ingredient needs a name and a usable quantity).";
      return;
    }

    this.merging = true;
    try {
      // Re-read BOTH files FRESH (read-before-write).
      let recipes, recipeIngredients;
      try {
        recipes = await getFile('recipes.csv');
        recipeIngredients = await getFile('recipe_ingredients.csv');
      } catch (_e) {
        this.recipeManagerError = "Couldn't re-read your recipe files before saving, so nothing was changed. Try Pick CSV folder again.";
        this.merging = false;
        return;
      }
      if (isOldSchemaJoinHeader(recipeIngredients.columns) || !isMigratedJoinHeader(recipeIngredients.columns)) {
        this.recipeManagerError = 'recipe_ingredients.csv is on the old schema — click Migrate schema first.';
        this.merging = false;
        return;
      }

      const recipesColumns = recipes.columns || [];
      const joinColumns = recipeIngredients.columns || [];

      // COLLISION SAFETY (T-bhx-02): recompute the id from the FRESH disk read,
      // not the open-time suggestion. max(existing)+1 is collision-free.
      const diskIds = recipes.rows
        .map(r => parseInt(r.recipe_id, 10))
        .filter(Number.isFinite);
      const newId = Math.max(0, ...diskIds) + 1;

      // recipes.csv newRows — APPEND the new header (never replace). Every
      // existing row preserved verbatim (same reference).
      const recipesNewRows = [
        ...recipes.rows,
        toHeaderCsvRow(value.header, newId, recipesColumns)
      ];

      // recipe_ingredients.csv newRows — APPEND the new recipe's rows with
      // line_order re-derived 1..N. All existing rows preserved verbatim.
      const joinNewRows = [
        ...recipeIngredients.rows,
        ...value.rows.map((row, i) => toJoinCsvRow({ ...row, line_order: i + 1 }, newId, joinColumns))
      ];

      // Same call shape as saveRecipeEdit (recipes.csv first, join second;
      // both snapshotted regardless; join verified against isMigratedJoinHeader).
      await this._rewriteTwoFilesInPlace(
        { filename: 'recipes.csv', newRows: recipesNewRows },
        { filename: 'recipe_ingredients.csv', newRows: joinNewRows, headerCheckFn: isMigratedJoinHeader },
        // Phase 11 Plan 02 (D-08) — "Name: add recipe <id> ('Title')".
        { action: 'add', title: `${newId} ('${value.header?.name ?? ''}')` }
      );

      // Success tail — mirror saveRecipeEdit verbatim: refresh list from disk,
      // refresh qty gaps, best-effort meal-plan rebuild, set notice, teardown.
      try {
        const fresh = await getFile('recipes.csv');
        this.recipeList = this._buildRecipeList(fresh.rows);
        await this._refreshRecipeQtyGaps();
      } catch (_e) { /* non-fatal — list refresh only */ }
      try { if (this.csvStoreLoaded) await this._rebuildMealPlanGrouped(); } catch (_e) { /* best-effort scaling refresh */ }
      // Advance the session counter so the NEXT add/parse suggests beyond this
      // id (mirrors approve()'s Math.max guard).
      this.maxRecipeIdAtSessionStart = Math.max(this.maxRecipeIdAtSessionStart, newId);
      this.recipeManagerNotice = `Added "${value.header.name}" ✓`;
      this.closeEditRecipe();
    } catch (e) {
      if (e && e.isRestoreOfferSentinel) {
        // The COMBINED restore banner is already set by the orchestrator — stop.
      } else if (this._routePushFailure(e)) {
        // Phase 11 Plan 03 (SAVE-02): remote push failure → pushConflictOffer only.
      } else {
        this.recipeManagerError = (e && e.message) ? e.message : "Couldn't add your recipe.";
      }
    } finally {
      this.merging = false;
    }
  },

  /**
   * filteredMaster — the manager table source. Blank filter → the full master in
   * its stable load order. Otherwise reuse the loaded Fuse instance to search by
   * name and map hits back to master entries. Belt-and-braces: if this.fuse is
   * null, fall back to a case-insensitive substring filter on ingredient_name.
   * Note: master entries carry id/name/allergens/shopping_unit only — pack
   * fields are read FRESH on edit-open (startEditIngredient).
   */
  get filteredMaster() {
    const master = Array.isArray(this.ingredientMaster) ? this.ingredientMaster : [];
    const q = (this.managerFilter || '').trim();
    if (!q) return master;
    if (this.fuse) {
      const seen = new Set();
      const out = [];
      for (const hit of this.fuse.search(q)) {
        const item = hit.item;
        if (item && !seen.has(item.ingredient_id)) {
          seen.add(item.ingredient_id);
          out.push(item);
        }
      }
      return out;
    }
    const lower = q.toLowerCase();
    return master.filter(e => (e.ingredient_name || '').toLowerCase().includes(lower));
  },

  /**
   * startEditIngredient — open inline edit for one master row. Refuses while a
   * write is in flight (approving/merging). Reads ingredients.csv FRESH so the
   * pack_size/pack_unit cells (not carried on the in-memory master) are accurate;
   * refuses on old-schema (directs to Migrate schema) and fails closed on read
   * error.
   */
  async startEditIngredient(ingredient_id) {
    if (this.approving || this.merging) return;
    this.managerError = '';
    this.managerNotice = '';
    let ingredients;
    try {
      ingredients = await getFile('ingredients.csv');
    } catch (_e) {
      this.managerError = "Couldn't read the ingredients file, so nothing was opened for editing. Try Pick CSV folder again.";
      return;
    }
    if (isOldSchemaIngredientsHeader(ingredients.columns) || !isMigratedIngredientsHeader(ingredients.columns)) {
      this.managerError = 'ingredients.csv is on the old schema — click Migrate schema first.';
      return;
    }
    const idNum = Number(ingredient_id);
    const diskRow = ingredients.rows.find(r => parseInt(r.ingredient_id, 10) === idNum);
    if (!diskRow) {
      this.managerError = "That ingredient wasn't found in the file — try Pick CSV folder again.";
      return;
    }
    this.editForm = {
      ingredient_name: diskRow.ingredient_name ?? '',
      // quick 260623-fjq — tolerant split on BOTH ';' and ',' (legacy comma-joined
      // cells parse into valid FSA-14 tokens; the write path normalises to ';' on save).
      allergens: (diskRow.allergens ?? '').split(/[;,]/).map(s => s.trim()).filter(Boolean),
      shopping_unit: isShoppingUnitValue((diskRow.shopping_unit ?? '').trim()) ? diskRow.shopping_unit.trim() : 'metric',
      // quick 260612-esy — Phase B: pre-fill the select with the disk value when
      // valid, ELSE the name-heuristic guess. A blank disk cell pre-fills the
      // heuristic SUGGESTION (the user corrects a suggestion, never an empty box).
      scale_category: (function () {
        const v = (diskRow.scale_category ?? '').trim().toLowerCase();
        return isValidScaleCategory(v) ? v : classifyIngredientCategory({ ingredient_name: diskRow.ingredient_name });
      })(),
      // quick 260614-eqa — pantry_staple read from disk as a boolean (blank / absent /
      // non-TRUE -> false). No heuristic fallback (contrast scale_category).
      pantry_staple: (diskRow.pantry_staple ?? '').trim().toUpperCase() === 'TRUE',
      // quick 260615-e1n — pantry_section read from disk as the LITERAL string (blank
      // / absent -> ''). Do NOT clamp to the current curated list so an out-of-list
      // stored value round-trips intact through an edit.
      pantry_section: (diskRow.pantry_section ?? '').trim(),
      pack_size: (diskRow['1st_pack_size'] ?? '') === '' ? null : Number(diskRow['1st_pack_size']),
      pack_unit: diskRow['1st_pack_unit'] ?? '',
      // quick 260615-kid — pack_units (finite number or null) + pack_unit_label
      // (string) read FRESH from disk, mirroring pack_size/pack_unit. No heuristic.
      pack_units: (diskRow.pack_units ?? '') === '' ? null : Number(diskRow.pack_units),
      pack_unit_label: diskRow.pack_unit_label ?? '',
      // phase 08 / REG-01 — regular read from disk as a boolean (blank / absent /
      // non-TRUE -> false; mirrors pantry_staple, no heuristic) + regular_qty_per_person
      // as number-or-null (blank / absent -> null = no rate set; mirrors pack_units).
      regular: (diskRow.regular ?? '').trim().toUpperCase() === 'TRUE',
      regular_qty_per_person: (diskRow.regular_qty_per_person ?? '') === '' ? null : Number(diskRow.regular_qty_per_person),
      link1: diskRow['1st_link'] ?? '',
      link2: diskRow['2nd_link'] ?? '',
      pack2_size: (diskRow['2nd_pack_size'] ?? '') === '' ? null : Number(diskRow['2nd_pack_size']),
      pack2_unit: diskRow['2nd_pack_unit'] ?? '',
      supplier: diskRow.supplier ?? ''
    };
    // quick 260614-nw0 — capture the EXACT pre-filled scale_category (the value
    // Alpine now holds: disk value or heuristic) so the save-time drop check only
    // treats scale_category as set-by-user when it later differs from this.
    this.editScaleCategoryInitial = this.editForm.scale_category;
    // Clear any stale warning from a prior edit so reopening starts clean.
    this.editIngredientWarning = '';
    this.editingIngredientId = idNum;
    this.editMoreFieldsOpen = false;
    // quick 260627-pfu — baseline the dirty guard after editForm + editingIngredientId
    // are set (so a backdrop click on an untouched edit closes immediately).
    this.snapshotEditModal('ingredient');
    // Phase 12 (LOCK-01, D-02) — EXISTING-RECORD ingredient edit acquires the
    // advisory lock ON OPEN (mirrors openEditRecipe; short hold, same-row collision
    // is the wasted-work case). Released on cancel AND on clean save (the two
    // teardown points). The parse/Add flow differs (append-only → Approve-only).
    await this._acquireLockForEditorOpen();
  },

  /** Cancel an in-flight edit. */
  cancelEditIngredient() {
    this.editingIngredientId = null;
    // Phase 12 (LOCK-01, D-05) — RELEASE on cancel. releaseLock no-ops safely when
    // heldLock is null (a read-only open never acquired). Fire-and-forget.
    this.releaseLock();
    // quick 260614-nw0 — clear the dropped-field warning on cancel.
    this.editIngredientWarning = '';
    this.editForm = { ingredient_name: '', allergens: [], shopping_unit: 'metric', scale_category: '', pantry_staple: false, pantry_section: '', pack_size: null, pack_unit: '', pack_units: null, pack_unit_label: '', regular: false, regular_qty_per_person: null, link1: '', link2: '', pack2_size: null, pack2_unit: '', supplier: '' }; // pack_units/pack_unit_label: quick 260615-kid; regular/regular_qty_per_person: phase 08 REG-01
    this.editMoreFieldsOpen = false;
  },

  /**
   * saveEditIngredient — write one edited master row in place. Guard + permission
   * re-check + validation mirror merge()/submitAddNew. Re-reads the FULL disk rows
   * fresh, mutates ONLY the matched ingredient_id row's cells, and funnels through
   * _rewriteIngredientsInPlace (backup→rewrite→verify→restore-on-failure). Reloads
   * the master from disk on success so the parse view reflects the change.
   */
  async saveEditIngredient() {
    if (this.approving || this.merging) return;
    this.managerError = '';
    this.managerNotice = '';
    // quick 260614-nw0 — clear any prior dropped-field warning up-front.
    this.editIngredientWarning = '';

    // Validation (same rules as submitAddNew): non-empty name, allergens ⊂ FSA14,
    // shopping_unit ∈ {metric, whole}.
    const trimmedName = (this.editForm.ingredient_name || '').trim();
    if (!trimmedName) {
      this.managerError = 'Please enter an ingredient name.';
      return;
    }
    if (!Array.isArray(this.editForm.allergens) || this.editForm.allergens.some(a => !FSA14.includes(a))) {
      this.managerError = `Allergens must each be one of: ${FSA14.join(', ')}.`;
      return;
    }
    if (!isShoppingUnitValue(this.editForm.shopping_unit)) {
      this.managerError = 'Shopping unit must be metric or whole.';
      return;
    }
    // quick 260612-esy — Phase B: scale_category is blank-OR-valid (blank = "use
    // the heuristic" is legitimate). Refuse only an out-of-range non-blank value.
    {
      const sc = (this.editForm.scale_category ?? '').trim();
      if (sc !== '' && !isValidScaleCategory(sc)) {
        this.managerError = `Scaling category must be one of: ${SCALE_CATEGORIES.join(', ')}.`;
        return;
      }
    }

    const idNum = Number(this.editingIngredientId);
    this.merging = true;
    try {
      // Re-read FRESH (read-before-write). Fail closed on read error / old-schema.
      let ingredients;
      try {
        ingredients = await getFile('ingredients.csv');
      } catch (_e) {
        this.managerError = "Couldn't re-read the ingredients file before saving, so nothing was changed. Try Pick CSV folder again.";
        this.merging = false;
        return;
      }
      if (isOldSchemaIngredientsHeader(ingredients.columns) || !isMigratedIngredientsHeader(ingredients.columns)) {
        this.managerError = 'ingredients.csv is on the old schema — click Migrate schema first.';
        this.merging = false;
        return;
      }
      const targetIdx = ingredients.rows.findIndex(r => parseInt(r.ingredient_id, 10) === idNum);
      if (targetIdx === -1) {
        this.managerError = "That ingredient wasn't found in the file — try Pick CSV folder again.";
        this.merging = false;
        return;
      }

      // quick 260614-nw0 — DROPPED-FIELD DETECTION (detection only; the write path
      // below is unchanged). For each optional column-guarded field, if the user
      // set a MEANINGFUL value but the live ingredients.csv lacks that backing
      // column, the value will be silently dropped by the `if ('<col>' in merged)`
      // guard. Collect those so we can WARN and keep the modal open.
      //   - scale_category is TOUCH-TRACKED: it's heuristic-prefilled on open (never
      //     blank), so it only counts as set-by-user when it DIFFERS from the
      //     on-open value (this.editScaleCategoryInitial) — else every save on a
      //     file lacking that column would false-warn.
      //   - No `allergens` entry: a file passing the save gate (has shopping_unit)
      //     ALWAYS carries the allergens column, so that drop-path is dead code.
      //   - ingredient_name / shopping_unit are unconditional (guaranteed present).
      const cols = ingredients.columns || [];
      const MAP = [
        { column: 'scale_category', label: 'Scaling category', meaningful: f => (f.scale_category || '').trim() !== '' && f.scale_category !== this.editScaleCategoryInitial },
        { column: 'pantry_staple', label: 'Pantry staple', meaningful: f => f.pantry_staple === true },
        { column: 'pantry_section', label: 'Storage location', meaningful: f => (f.pantry_section || '').trim() !== '' },
        { column: '1st_pack_size', label: 'Pack size', meaningful: f => f.pack_size != null && f.pack_size !== '' },
        { column: '1st_pack_unit', label: 'Pack unit', meaningful: f => (f.pack_unit || '').trim() !== '' },
        // quick 260615-kid — surface a dropped pack_units/pack_unit_label edit on a
        // pre-migration CSV (modal stays open, no silent drop).
        { column: 'pack_units', label: 'Units per pack', meaningful: f => f.pack_units != null && f.pack_units !== '' },
        { column: 'pack_unit_label', label: 'Pack sub-unit name', meaningful: f => (f.pack_unit_label || '').trim() !== '' },
        // phase 08 / REG-01 — surface a dropped regular / regular_qty_per_person edit on
        // a pre-migration CSV (modal stays open, no silent drop).
        { column: 'regular', label: 'Regular buy', meaningful: f => f.regular === true },
        { column: 'regular_qty_per_person', label: 'Regular qty per person', meaningful: f => f.regular_qty_per_person != null && f.regular_qty_per_person !== '' },
        { column: '1st_link', label: 'Shopping link 1', meaningful: f => (f.link1 || '').trim() !== '' },
        { column: '2nd_link', label: 'Shopping link 2', meaningful: f => (f.link2 || '').trim() !== '' },
        { column: '2nd_pack_size', label: '2nd pack size', meaningful: f => f.pack2_size != null && f.pack2_size !== '' },
        { column: '2nd_pack_unit', label: '2nd pack unit', meaningful: f => (f.pack2_unit || '').trim() !== '' },
        { column: 'supplier', label: 'Supplier', meaningful: f => (f.supplier || '').trim() !== '' }
      ];
      const dropped = MAP.filter(m => m.meaningful(this.editForm) && !cols.includes(m.column)).map(m => m.label);

      // Build newRows = fresh disk rows with ONLY the matched row's cells mutated.
      // Every other row object is preserved verbatim (same reference, same cells).
      const allergensCell = this.editForm.allergens.filter(Boolean).join(';');
      const newRows = ingredients.rows.map((r, i) => {
        if (i !== targetIdx) return r;
        const merged = { ...r };
        merged.ingredient_name = trimmedName;
        if ('allergens' in merged) merged.allergens = allergensCell;
        merged.shopping_unit = this.editForm.shopping_unit;
        // quick 260612-esy — Phase B: guarded scale_category write. Validated to a
        // category (trimmed + lowercased) else BLANK ('' = use the heuristic — a
        // legitimate value). Behind the `in merged` guard so a pre-migration CSV
        // that lacks the column never gains a phantom one (T-esy-04).
        if ('scale_category' in merged) {
          merged.scale_category = isValidScaleCategory(this.editForm.scale_category)
            ? this.editForm.scale_category.trim().toLowerCase()
            : '';
        }
        // quick 260614-eqa — guarded pantry_staple write ('TRUE' / blank). Behind the
        // `in merged` guard so a pre-migration CSV that lacks the column never gains a
        // phantom one (T-eqa-02). A checkbox is always valid TRUE/blank — no validation.
        if ('pantry_staple' in merged) {
          merged.pantry_staple = this.editForm.pantry_staple ? 'TRUE' : '';
        }
        // quick 260615-e1n — guarded pantry_section write (the storage-location string
        // / blank). Behind the `in merged` guard so a pre-migration CSV that lacks the
        // column never gains a phantom one (T-e1n-02); the nw0 MAP surfaces the drop.
        if ('pantry_section' in merged) {
          merged.pantry_section = this.editForm.pantry_section ?? '';
        }
        if ('1st_pack_size' in merged) {
          merged['1st_pack_size'] = this.editForm.pack_size != null && this.editForm.pack_size !== ''
            ? csvNumber(this.editForm.pack_size) : '';
        }
        if ('1st_pack_unit' in merged) merged['1st_pack_unit'] = this.editForm.pack_unit ?? '';
        // quick 260615-kid — guarded pack_units (number-or-blank, mirrors 1st_pack_size)
        // + pack_unit_label (string) writes. Behind the `in merged` guard so a
        // pre-migration CSV that lacks the columns never gains a phantom one (T-kid-04);
        // the nw0 MAP surfaces the drop + keeps the modal open.
        if ('pack_units' in merged) {
          merged.pack_units = this.editForm.pack_units != null && this.editForm.pack_units !== ''
            ? csvNumber(this.editForm.pack_units) : '';
        }
        if ('pack_unit_label' in merged) merged.pack_unit_label = this.editForm.pack_unit_label ?? '';
        // phase 08 / REG-01 — guarded regular ('TRUE' / blank, mirrors pantry_staple) +
        // regular_qty_per_person (number-or-blank, mirrors pack_units; blank = no rate set,
        // NOT 0) writes. Behind the `in merged` guard so a pre-migration CSV that lacks the
        // columns never gains a phantom one (T-08-01); the nw0 MAP surfaces the drop.
        if ('regular' in merged) {
          merged.regular = this.editForm.regular ? 'TRUE' : '';
        }
        if ('regular_qty_per_person' in merged) {
          merged.regular_qty_per_person = this.editForm.regular_qty_per_person != null && this.editForm.regular_qty_per_person !== ''
            ? csvNumber(this.editForm.regular_qty_per_person) : '';
        }
        // quick 260610-jzu — 5 new guarded writes for the previously-hidden columns.
        // Each behind the SAME `if ('<col>' in merged)` guard so a minimal CSV that
        // lacks these columns never has them invented; pack2_size mirrors the
        // 1st_pack_size number-or-blank pattern exactly.
        if ('1st_link' in merged) merged['1st_link'] = this.editForm.link1 ?? '';
        if ('2nd_link' in merged) merged['2nd_link'] = this.editForm.link2 ?? '';
        if ('2nd_pack_size' in merged) {
          merged['2nd_pack_size'] = this.editForm.pack2_size != null && this.editForm.pack2_size !== ''
            ? csvNumber(this.editForm.pack2_size) : '';
        }
        if ('2nd_pack_unit' in merged) merged['2nd_pack_unit'] = this.editForm.pack2_unit ?? '';
        if ('supplier' in merged) merged['supplier'] = this.editForm.supplier ?? '';
        return merged;
      });

      // Phase 11 Plan 02 (D-08) — structured commit message: "Name: edit ingredient 'X'".
      await this._rewriteIngredientsInPlace(
        newRows,
        this.buildCommitMessage({ action: 'edit', objectKind: 'ingredient', title: `'${trimmedName}'` })
      );

      await this.reloadMasterFromDisk();
      // quick 260614-nw0 — the write ran (writable fields persisted) in BOTH
      // branches. Branch on whether any set field was dropped for lacking a column.
      if (dropped.length === 0) {
        // Clean save — byte-identical to prior behaviour: close the modal + notice.
        this.editingIngredientId = null;
        // Phase 12 (LOCK-01, D-05) — RELEASE on clean save-success (one of the two
        // ingredient-edit teardown points alongside cancelEditIngredient). The
        // dropped-field branch below KEEPS the modal open, so it deliberately does
        // NOT release. Fire-and-forget; no-ops safely if we never acquired.
        this.releaseLock();
        this.managerNotice = `Saved "${trimmedName}" ✓`;
        this.editIngredientWarning = '';
        // quick 260615-dap — SECONDARY live-rescale hook (mark: SECONDARY). Each
        // grouped row's scale_category is JOINED from the master at build time, so
        // editing an ingredient's scale_category otherwise leaves meal-plan scaling
        // stale. Rebuild from disk so an open meal plan reflects the new category.
        // Same fail-open pattern as the primary saveRecipeEdit hook.
        try { if (this.csvStoreLoaded) await this._rebuildMealPlanGrouped(); } catch (_e) { /* best-effort scaling refresh */ }
      } else {
        // Dropped a field — KEEP THE MODAL OPEN (do NOT null editingIngredientId)
        // so the in-modal warning is seen; suppress the success notice.
        this.managerNotice = '';
        this.editIngredientWarning = 'Saved your other changes, but couldn’t save ' + dropped.join(', ') + ' — your ingredients.csv doesn’t have ' + (dropped.length > 1 ? 'those columns' : 'that column') + ' yet. Close this and click Migrate schema to add ' + (dropped.length > 1 ? 'them' : 'it') + ', then edit again.';
      }
    } catch (e) {
      if (e && e.isRestoreOfferSentinel) {
        // The restore banner (mergeRestoreOffer) is already set; just stop.
      } else if (this._routePushFailure(e)) {
        // Phase 11 Plan 03 (SAVE-02): remote push failure → pushConflictOffer only.
      } else {
        this.managerError = (e && e.message) ? e.message : "Couldn't save your change.";
      }
    } finally {
      this.merging = false;
    }
  },

  /**
   * recipeDeleteConfirmed — quick 260608-agp. Type-to-confirm gate (D-2): the
   * destructive Delete button is enabled ONLY when a recipe is loaded AND the
   * confirm input is exactly the literal word DELETE. The UI binds the button's
   * :disabled to `!recipeDeleteConfirmed || approving || merging`.
   */
  get recipeDeleteConfirmed() {
    return this.editingRecipeId != null && this.recipeDeleteConfirmText.trim() === 'DELETE';
  },

  /**
   * deleteRecipe — quick 260608-agp. Delete the loaded recipe from BOTH live
   * files. Uses the SAME backup-both-first / verify-each / combined-restore chain
   * as saveRecipeEdit — the only difference is the newRows arrays DROP (rather
   * than replace) the target rows. Gated behind recipeDeleteConfirmed.
   */
  async deleteRecipe() {
    if (this.approving || this.merging) return;
    // Defense-in-depth even though the button is gated on recipeDeleteConfirmed.
    if (this.editingRecipeId == null || !this.recipeDeleteConfirmed) return;
    this.recipeManagerError = '';
    this.recipeManagerNotice = '';

    const idNum = Number(this.editingRecipeId);
    this.merging = true;
    try {
      // Re-read BOTH files FRESH.
      let recipes, recipeIngredients;
      try {
        recipes = await getFile('recipes.csv');
        recipeIngredients = await getFile('recipe_ingredients.csv');
      } catch (_e) {
        this.recipeManagerError = "Couldn't re-read your recipe files before deleting, so nothing was changed. Try Pick CSV folder again.";
        this.merging = false;
        return;
      }
      if (isOldSchemaJoinHeader(recipeIngredients.columns) || !isMigratedJoinHeader(recipeIngredients.columns)) {
        this.recipeManagerError = 'recipe_ingredients.csv is on the old schema — click Migrate schema first.';
        this.merging = false;
        return;
      }

      // recipes.csv newRows — drop the target header row. Refuse if it's already
      // gone (already deleted / file changed).
      const present = recipes.rows.some(r => parseInt(r.recipe_id, 10) === idNum);
      if (!present) {
        this.recipeManagerError = "That recipe is no longer in recipes.csv — it may already be deleted. Try Pick CSV folder again.";
        this.merging = false;
        return;
      }
      const recipesNewRows = recipes.rows.filter(r => parseInt(r.recipe_id, 10) !== idNum);

      // recipe_ingredients.csv newRows — drop ALL matching join rows.
      const joinNewRows = recipeIngredients.rows.filter(r => parseInt(r.recipe_id, 10) !== idNum);

      await this._rewriteTwoFilesInPlace(
        { filename: 'recipes.csv', newRows: recipesNewRows },
        { filename: 'recipe_ingredients.csv', newRows: joinNewRows, headerCheckFn: isMigratedJoinHeader },
        // Phase 11 Plan 02 (D-08) — "Name: delete recipe <id> ('Title')".
        { action: 'delete', title: `${idNum} ('${this.form.header?.name ?? ''}')` }
      );

      // Success — refresh the browse list, return to the list.
      try {
        const fresh = await getFile('recipes.csv');
        this.recipeList = this._buildRecipeList(fresh.rows);
        await this._refreshRecipeQtyGaps();   // quick 260613-a2t — READ-ONLY qty-gap tally refresh
      } catch (_e) { /* non-fatal — list refresh only */ }
      this.recipeManagerNotice = `Deleted recipe #${idNum} ✓`;
      // quick 260614-od7 — delegate teardown to closeEditRecipe (SINGLE owner of the
      // parse-snapshot restore); the notice set ABOVE survives the close.
      this.closeEditRecipe();
    } catch (e) {
      if (e && e.isRestoreOfferSentinel) {
        // Combined restore banner already set by the orchestrator — just stop.
      } else if (this._routePushFailure(e)) {
        // Phase 11 Plan 03 (SAVE-02): remote push failure → pushConflictOffer only.
      } else {
        // Backup-failure aborts arrive as a PLAIN error → this branch, no banner.
        this.recipeManagerError = (e && e.message) ? e.message : "Couldn't delete the recipe.";
      }
    } finally {
      this.merging = false;
    }
  },

  /** Enter the manager add-new sub-form. */
  addFromManager() {
    if (this.approving || this.merging) return;
    this.managerError = '';
    this.managerNotice = '';
    this.managerAddForm = { name: '', allergens: [], shopping_unit: 'metric', scale_category: '', pack_size: null, pack_unit: '', pack_units: null, pack_unit_label: '', regular: false, regular_qty_per_person: null }; // pack_units/pack_unit_label: quick 260615-kid; regular/regular_qty_per_person: phase 08 REG-01
    this.managerShoppingUnitTouched = false;
    this.managerAddMode = true;
  },

  /** Cancel the manager add-new sub-form. */
  cancelManagerAdd() {
    this.managerAddMode = false;
    this.managerError = '';
  },

  /**
   * submitManagerAdd — append one new ingredient. Mirrors saveEditIngredient's
   * guard+permission+validation+write skeleton, but: computes a fresh max+1
   * ingredient_id from the FRESH disk read (NOT the session counter — read-before-
   * write per CONTEXT, fail-closed on read error), rejects duplicate names against
   * the fresh disk rows, builds a new disk row via toIngredientCsvRow, appends it,
   * and funnels through _rewriteIngredientsInPlace.
   */
  async submitManagerAdd() {
    if (this.approving || this.merging) return;
    this.managerError = '';
    this.managerNotice = '';

    const trimmedName = (this.managerAddForm.name || '').trim();
    if (!trimmedName) {
      this.managerError = 'Please enter an ingredient name.';
      return;
    }
    if (!Array.isArray(this.managerAddForm.allergens) || this.managerAddForm.allergens.some(a => !FSA14.includes(a))) {
      this.managerError = `Allergens must each be one of: ${FSA14.join(', ')}.`;
      return;
    }
    if (!isShoppingUnitValue(this.managerAddForm.shopping_unit)) {
      this.managerError = 'Shopping unit must be metric or whole.';
      return;
    }

    this.merging = true;
    try {
      // Re-read FRESH immediately before the write (read-before-write per CONTEXT;
      // fresh max+1 id avoids collisions). Fail closed on read error / old-schema.
      let ingredients;
      try {
        ingredients = await getFile('ingredients.csv');
      } catch (_e) {
        this.managerError = "Couldn't re-read the ingredients file before adding, so nothing was changed. Try Pick CSV folder again.";
        this.merging = false;
        return;
      }
      if (isOldSchemaIngredientsHeader(ingredients.columns) || !isMigratedIngredientsHeader(ingredients.columns)) {
        this.managerError = 'ingredients.csv is on the old schema — click Migrate schema first.';
        this.merging = false;
        return;
      }

      // Duplicate-name check against the FRESH disk rows (case-insensitive).
      const lowerName = trimmedName.toLowerCase();
      if (ingredients.rows.some(r => (r.ingredient_name || '').trim().toLowerCase() === lowerName)) {
        this.managerError = `"${trimmedName}" is already in your master list.`;
        this.merging = false;
        return;
      }

      // Fresh max+1 id from the disk read (NOT the session counter).
      const maxId = Math.max(
        0,
        ...ingredients.rows.map(r => parseInt(r.ingredient_id, 10)).filter(Number.isFinite)
      ) + 1;

      const newDiskRow = toIngredientCsvRow({
        ingredient_id: maxId,
        ingredient_name: trimmedName,
        allergens: [...this.managerAddForm.allergens],
        pack_size: this.managerAddForm.pack_size != null && this.managerAddForm.pack_size !== ''
          ? Number(this.managerAddForm.pack_size) : null,
        pack_unit: this.managerAddForm.pack_unit ?? '',
        // quick 260615-kid — pass the manager add-new pack_units/pack_unit_label THROUGH.
        // toIngredientCsvRow emits each only when captured columns include the column;
        // without these lines the new inputs are dead (always blank).
        pack_units: this.managerAddForm.pack_units != null && this.managerAddForm.pack_units !== ''
          ? Number(this.managerAddForm.pack_units) : null,
        pack_unit_label: this.managerAddForm.pack_unit_label ?? '',
        shopping_unit: this.managerAddForm.shopping_unit,
        // quick 260612-esy — Phase B: toIngredientCsvRow validates+blanks this and
        // only writes it when the captured columns include scale_category.
        scale_category: this.managerAddForm.scale_category,
        // quick 260614-eqa — BLOCKER fix: pass the manager add-new checkbox value
        // THROUGH this explicit literal. toIngredientCsvRow blanks/emits it only when
        // the captured columns include pantry_staple. Without this line
        // newIngredient.pantry_staple is undefined -> the checkbox is dead (always blank).
        pantry_staple: this.managerAddForm.pantry_staple,
        // quick 260615-e1n — pass the manager add-new storage-location dropdown value
        // THROUGH. toIngredientCsvRow emits it only when captured columns include
        // pantry_section; without this the dropdown is dead (always blank).
        pantry_section: this.managerAddForm.pantry_section,
        // phase 08 / REG-01 — pass the manager add-new regular checkbox + per-person rate
        // THROUGH. toIngredientCsvRow emits each only when captured columns include the
        // column; without these lines the new inputs are dead (always blank).
        regular: this.managerAddForm.regular,
        regular_qty_per_person: this.managerAddForm.regular_qty_per_person
      }, ingredients.columns);

      const newRows = [...ingredients.rows, newDiskRow];

      // Phase 11 Plan 02 (D-08) — structured commit message: "Name: add ingredient 'X'".
      await this._rewriteIngredientsInPlace(
        newRows,
        this.buildCommitMessage({ action: 'add', objectKind: 'ingredient', title: `'${trimmedName}'` })
      );

      await this.reloadMasterFromDisk();
      this.managerAddMode = false;
      this.managerNotice = `Added "${trimmedName}" (id ${maxId}) ✓`;
    } catch (e) {
      if (e && e.isRestoreOfferSentinel) {
        // Restore banner already set.
      } else if (this._routePushFailure(e)) {
        // Phase 11 Plan 03 (SAVE-02): remote push failure → pushConflictOffer only.
      } else {
        this.managerError = (e && e.message) ? e.message : "Couldn't add the ingredient.";
      }
    } finally {
      this.merging = false;
    }
  },

  /**
   * reloadMasterFromStore — quick 260612-abt (was reloadMasterFromDisk). Post-write
   * reload so the Parse view reflects manager edits immediately. Re-reads the 3
   * files from the STORE, re-derives ingredientMaster + csvHeaders via the shared
   * deriveSessionStateFromCsvs path, rebuilds the Fuse index, and bumps
   * maxIngredientIdAtSessionStart to the new max.
   */
  async reloadMasterFromDisk() {
    const recipes = await getFile('recipes.csv');
    const ingredients = await getFile('ingredients.csv');
    const recipeIngredients = await getFile('recipe_ingredients.csv');
    if (!recipes || !ingredients || !recipeIngredients) return;
    const { csvHeaders, ingredientMaster } = deriveSessionStateFromCsvs(recipes, ingredients, recipeIngredients);
    this.ingredientMaster = ingredientMaster;
    this.csvHeaders = csvHeaders;
    this.initFuse();
    this.maxIngredientIdAtSessionStart = Math.max(
      0,
      ...ingredientMaster.map(e => Number.isFinite(e.ingredient_id) ? e.ingredient_id : 0)
    );
  },

  /**
   * UNKNOWN-07 / D-56 / D-57 — reactive soft-block warning copy.
   *
   * Pure derivation over addNewFormState.name + addNewFormState.allergens +
   * currentAllergenKeywords. Returns:
   *   - '' when there's no name OR no keyword hits OR every keyword-implied
   *     allergen is already ticked (no override needed)
   *   - the UI-SPEC §Soft-block warning copy when at least one
   *     keyword-implied allergen is unticked
   *
   * Plain-English composition per UI-SPEC: 1 unticked → "{Allergen}",
   * 2 → "{A} and {B}", 3+ → Oxford-comma joined ("A, B, and C"); pronoun
   * "it" for 1, "them" for 2+. The leading ⚠ glyph (U+26A0) matches the
   * .banner.banner-warning informational tone.
   *
   * Re-runs automatically on every Alpine reactivity tick that touches the
   * name input or any allergen checkbox — re-ticking the missing allergen
   * clears the warning without a separate dismiss button (D-57).
   */
  get softBlockWarning() {
    const rawName = (this.addNewFormState.name || '').trim();
    if (!rawName) return '';
    const lookup = this.currentAllergenKeywords;
    if (!Array.isArray(lookup) || lookup.length === 0) return '';
    const hits = findKeywordHits(rawName, lookup);
    if (hits.size === 0) return '';
    const ticked = new Set(this.addNewFormState.allergens || []);
    const missing = [];
    for (const allergen of hits.keys()) {
      if (!ticked.has(allergen)) missing.push(allergen);
    }
    if (missing.length === 0) return '';

    const displayName = rawName;
    let allergenPhrase;
    if (missing.length === 1) {
      allergenPhrase = missing[0];
    } else if (missing.length === 2) {
      allergenPhrase = `${missing[0]} and ${missing[1]}`;
    } else {
      allergenPhrase = missing.slice(0, -1).join(', ') + ', and ' + missing[missing.length - 1];
    }
    const pronoun = missing.length === 1 ? 'it' : 'them';
    return `⚠ ${displayName} usually contains ${allergenPhrase}. You've unticked ${pronoun} — is that right?`;
  },

  /**
   * UNKNOWN-05 / UNKNOWN-08 / D-53 / D-54 / D-55 — Submit Add-new sub-form.
   *
   * 1. Validate name (non-empty + duplicate-name checks against
   *    ingredientMaster + inSessionNewIngredients).
   * 2. Allocate a session-local ingredient_id (D-54): max of session-start
   *    base and existing in-session adds, plus 1. recompute-before-write is
   *    deferred to approve() (recomputeMaxIngredientId).
   * 3. Push the new ingredient onto in-memory ingredientMaster AND the
   *    inSessionNewIngredients[] queue (the delta-write list).
   * 4. Rebuild the Fuse index via refreshFuse() so subsequent unknown cards
   *    see the new entry as a fuzzy-match candidate (RESEARCH Pitfall 2 —
   *    Fuse instance staleness).
   * 5. Mutate the current row: ingredient_id = new id; flag_fix_me = true
   *    (UNKNOWN-08 row-level auto-flag); flagSourcesByRowKey[row._key] +=
   *    addedNewIngredient (D-59 transient session map for Plan 04-05's
   *    tooltip).
   * 6. Remove this card from unknownQueue.
   * 7. D-55 auto-resolve cascade: for every remaining card, Fuse-search
   *    the new name against the card's raw_text at the tighter
   *    AUTO_RESOLVE_THRESHOLD (0.3 — RESEARCH Pitfall 3). Above-threshold
   *    hits get the same row mutation (ingredient_id, flag_fix_me,
   *    flagSourcesByRowKey) and are removed from the queue.
   * 8. Close the modal. Transition to REVIEWING if the queue is now empty.
   *
   * Per RESEARCH Pitfall 4: the form is NOT rendered during RESOLVING, so
   * the 260525-bk3 ingredient_id race surface is absent. No $nextTick +
   * x-effect deferred resync is needed for the row mutation.
   */
  submitAddNew() {
    // Clear stale validation message (a previous attempt's error should not
    // persist past a fresh submit click).
    this.addNewFormError = '';

    // quick 260607-qic — read the SHARED target key (set by enterAddNewMode for
    // the queue path or openAddNewForRow for the live-row path), not
    // currentUnknownKey. Steps 1-5 below are identical for both paths; the
    // queue-vs-live branch happens AFTER the row mutation (step 6).
    const key = this.addNewTargetKey;
    if (key == null) return;

    // 1. Validate name — non-empty.
    const trimmedName = (this.addNewFormState.name || '').trim();
    if (!trimmedName) {
      this.addNewFormError = 'Please enter an ingredient name.';
      return;
    }

    // 1b. Duplicate-name check against master (case-insensitive).
    const lowerName = trimmedName.toLowerCase();
    if (this.ingredientMaster.some(e => (e.ingredient_name || '').toLowerCase() === lowerName)) {
      // UI-SPEC §Error state copy. The internal ingredient_id is NOT exposed;
      // the "use existing match" link is a UX polish item deferred to a
      // follow-up plan — this message guides the user back to Use this match
      // (Back to matches → top-3 list).
      this.addNewFormError = `"${trimmedName}" is already in your master list. Use that existing entry instead?`;
      return;
    }

    // 1c. Duplicate-name check against in-session new ingredients.
    if (this.inSessionNewIngredients.some(e => (e.ingredient_name || '').toLowerCase() === lowerName)) {
      this.addNewFormError = `"${trimmedName}" was already added in this session. Use that one?`;
      return;
    }

    // 2. Allocate a session-local ingredient_id (D-54).
    const allocated = Math.max(
      0,
      this.maxIngredientIdAtSessionStart,
      ...this.inSessionNewIngredients.map(e => Number.isFinite(e.ingredient_id) ? e.ingredient_id : 0)
    ) + 1;

    // 3. Build the new ingredient entry. Allergens array is defensively
    //    copied so subsequent edits to the sub-form (after submit) cannot
    //    mutate the master entry by reference.
    const newEntry = {
      ingredient_id: allocated,
      ingredient_name: trimmedName,
      allergens: [...this.addNewFormState.allergens],
      pack_size: this.addNewFormState.pack_size != null ? Number(this.addNewFormState.pack_size) : null,
      pack_unit: this.addNewFormState.pack_unit ?? '',
      // quick 260607-c65 — defensive enum clamp (isShoppingUnitValue is the
      // single source of truth in merge.js). Rides onto BOTH ingredientMaster
      // and inSessionNewIngredients (same object) so the in-session master + the
      // delta writer both carry shopping_unit.
      shopping_unit: isShoppingUnitValue(this.addNewFormState.shopping_unit)
        ? this.addNewFormState.shopping_unit
        : 'metric'
    };
    this.ingredientMaster.push(newEntry);
    this.inSessionNewIngredients.push(newEntry);

    // 4. Rebuild the Fuse index so subsequent unknown cards' top-3 surface
    //    + the auto-resolve loop both see the new entry.
    this.refreshFuse();

    // 5. Mutate the current unknown's row (UNKNOWN-08 — flag_fix_me=true,
    //    addedNewIngredient source attribution for Plan 04-05 tooltip).
    const thisRow = this.form.rows.find(r => r._key === key);
    if (thisRow) {
      thisRow.ingredient_id = allocated;
      thisRow.flag_fix_me = true;
      this.flagSourcesByRowKey[thisRow._key] = {
        ...(this.flagSourcesByRowKey[thisRow._key] || {}),
        addedNewIngredient: true
      };
    }

    // quick 260607-qic — queue-vs-live-row branch.
    //   isQueuePath: the target key is a card currently in unknownQueue → this
    //     is the original unknown-queue Add-new flow. Steps 6-8 below (queue
    //     removal + D-55 cascade + closeUnknownModal + transition-on-empty) run
    //     UNCHANGED, byte-for-byte.
    //   else (combobox / live-row path): the row was never in the queue (the LLM
    //     mis-matched it to a real ingredient). We MUST NOT run the cascade
    //     (a queue-only convenience that would be a surprising side effect when
    //     adding from one row) and MUST NOT call transition() — we are already
    //     in REVIEWING and must STAY there. Just unconfirm the mutated row
    //     (parity with selectIngredient — a method-driven ingredient_id mutation
    //     must unconfirm a confirmed row) and close the sub-form via
    //     closeAddNewForm (which leaves currentUnknownKey untouched).
    const isQueuePath = this.unknownQueue.some(c => c._key === key);
    if (!isQueuePath) {
      this.unconfirm(key);
      this.closeAddNewForm();
      return;
    }

    // 6. Remove this card from the queue.
    this.unknownQueue = this.unknownQueue.filter(c => c._key !== key);

    // 7. D-55 auto-resolve cascade — UAT-04-G02 gap closure (260526) +
    //    CR-01 false-positive defence.
    //
    //    Direction: search the NEW NAME as the QUERY against each remaining
    //    card's INGREDIENT_NAME (+ raw_text fallback) as the corpus. This
    //    matches user mental model ("does this card name the new ingredient?")
    //    and behaves predictably under ignoreLocation:true. Threshold stays at
    //    AUTO_RESOLVE_THRESHOLD (0.3, Plan 04-04 lock).
    //
    //    Pre-fix (Plan 04-04): built a single-entry Fuse over [{ingredient_name: lowerNewName}]
    //    and searched each card.raw_text against it — long noisy query vs
    //    short canonical corpus, scored unpredictably (CR-01 §40-50).
    //
    //    False-positive defence (CR-01 anticipated direction): require the new
    //    name to appear as a whole-word substring of the card text BEFORE
    //    accepting the Fuse hit. Whole-word = surrounded by non-word characters
    //    or string boundaries. Cheap regex defence against e.g. 'tahin' matching
    //    'tahini' or 'mil' matching 'milk'. The cascade fires ONLY when both
    //    Fuse-above-threshold AND whole-word match succeed.
    const lowerNewName = trimmedName.toLowerCase();
    const escapedName = lowerNewName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wholeWordRe = new RegExp('(?:^|\\W)' + escapedName + '(?:$|\\W)', 'i');

    const cascadeCorpus = this.unknownQueue.map(c => ({
      _key: c._key,
      ingredient_name: (c.ingredient_name || c.raw_text || '').toLowerCase()
    }));
    const cascadeFuse = new Fuse(cascadeCorpus, {
      keys: ['ingredient_name'],
      threshold: AUTO_RESOLVE_THRESHOLD,
      includeScore: true,
      ignoreLocation: true,
      isCaseSensitive: false,
      minMatchCharLength: 2
    });
    const fuseHits = cascadeFuse.search(lowerNewName);
    const hitKeysBelowThreshold = new Set(
      fuseHits.filter(h => h.score <= AUTO_RESOLVE_THRESHOLD).map(h => h.item._key)
    );

    const remaining = [];
    for (const card of this.unknownQueue) {
      const cardName = (card.ingredient_name || '').toLowerCase();
      const cardRaw  = (card.raw_text || '').toLowerCase();
      const fuseOk   = hitKeysBelowThreshold.has(card._key);
      const wordOk   = wholeWordRe.test(cardName) || wholeWordRe.test(cardRaw);
      if (fuseOk && wordOk) {
        const row = this.form.rows.find(r => r._key === card._key);
        if (row) {
          row.ingredient_id = allocated;
          row.flag_fix_me = true;
          this.flagSourcesByRowKey[row._key] = {
            ...(this.flagSourcesByRowKey[row._key] || {}),
            addedNewIngredient: true
          };
        }
        // Card resolved by cascade — do NOT keep in queue.
      } else {
        remaining.push(card);
      }
    }
    this.unknownQueue = remaining;

    // 8. Close the modal + transition if queue empty.
    this.closeUnknownModal();
    if (this.unknownQueue.length === 0) {
      this.transition(STATES.REVIEWING);
    }
  },

  // ----- Phase 4 / Plan 04-02 — queue card hint helper -----
  /**
   * Compose the optional "Section: X · line N" hint shown beneath each
   * queue card's raw_text. Per UI-SPEC §Copywriting Contract:
   *   - both present: `Section: {section} · line {line_order}` (U+00B7)
   *   - section only: `Section: {section}`
   *   - line_order only: `Line {line_order}`
   *   - neither: '' (the parent x-show="card.section || card.line_order"
   *     already hides the hint line, so the empty return is defensive).
   * Defensive on undefined / non-truthy line_order (line_order can be 0 in
   * edge cases — treat 0 as "no value" via truthy check; the Phase 1
   * blankRow always allocates line_order >= 1).
   *
   * @param {{ section?: string, line_order?: number }} card
   * @returns {string}
   */
  formatQueueCardHint(card) {
    if (!card) return '';
    const hasSection = !!(card.section && String(card.section).trim());
    const hasLine = !!card.line_order;
    if (hasSection && hasLine) {
      return `Section: ${card.section} · line ${card.line_order}`;
    }
    if (hasSection) {
      return `Section: ${card.section}`;
    }
    if (hasLine) {
      return `Line ${card.line_order}`;
    }
    return '';
  },

  // ----- Parse: pasted recipe → LLM → structured form (Plan 02) -----
  /**
   * One Anthropic round-trip. Sets `parsing=true` for the duration so the
   * Parse button is :disabled (PARSE-06 / double-click guard). On success,
   * stores the result into `this.form` for Plan 03's form UI. On failure,
   * writes a plain-language message to `parseError` and leaves the previous
   * form untouched. The `finally` block GUARANTEES `parsing=false` so the
   * Parse button always re-enables (no stuck-disabled failure mode).
   */
  async parse() {
    // Double-parse guard (P20 — formalized via state machine). If a previous
    // parse is still in-flight (preflight / calling / validating / reviewing
    // / approving), silently ignore the click. Re-entry is allowed only from
    // IDLE, APPROVED, or ERROR states. We deliberately do NOT overwrite the
    // existing parseError on a guarded re-entry — the prior message stands.
    if (![STATES.IDLE, STATES.APPROVED, STATES.ERROR].includes(this.state)) return;

    // Move into PREFLIGHT before any state mutations. If the transition is
    // refused (programming error caught by the TRANSITIONS table), bail.
    if (!this.transition(STATES.PREFLIGHT)) return;

    this.parsing = true;
    this.parseError = '';
    this.parseErrorDetail = '';   // quick 260618-jr7 — clear stale copyable detail
    this.errorCopied = false;
    // Plan 03 — reset Approve-side state so a fresh parse after a previous
    // Approve clears the form-lock and success banner cleanly. Session-level
    // state (sessionFolderHandle, sessionFolderName, maxRecipeIdAtSessionStart)
    // is preserved (D-12 + D-15).
    this.approved = false;
    this.lastWriteSummary = null;
    // REVIEW-07 / Plan 03-03 — reset click-to-source highlight state BEFORE
    // transitioning to REVIEWING. A re-parse on a different recipe must not
    // leave the prior recipe's matchedLineIndex pointing at a span that maps
    // to an unrelated line in the new raw paste.
    this.matchedHighlightKey = null;
    this.matchedLineIndex = null;
    // Phase 4 / Plan 04-02 — reset transient unknown-queue state so a
    // re-parse cannot inherit the previous run's queue / modal / flag
    // sources. inSessionNewIngredients is also wiped (a re-parse means the
    // user abandoned the previous Add-news). Session-level state (Fuse
    // instance, maxIngredientIdAtSessionStart, ingredientMaster) is
    // preserved — the master persists across parses per Phase 1 contract.
    this.unknownQueue = [];
    this.currentUnknownKey = null;
    this.addNewMode = false;
    this.flagSourcesByRowKey = {};
    this.inSessionNewIngredients = [];

    try {
      // Precondition guards. These are PREFLIGHT-phase work; if any fail we
      // set parseError and transition to ERROR (NOT idle — keep them in the
      // error funnel for symmetry per the plan's action step 4b).
      if (!this.rawText.trim()) {
        this.parseError = 'Paste a recipe first.';
        this.transition(STATES.ERROR);
        return;
      }
      if (!this.apiKey) {
        this.parseError = 'Set your Anthropic API key in Settings first.';
        this.transition(STATES.ERROR);
        return;
      }
      if (!this.csvStoreLoaded) {
        this.parseError = 'Import your CSVs first so we know which ingredients are valid.';
        this.transition(STATES.ERROR);
        return;
      }

      // Build the schema fresh per call: ingredientMaster is loaded once at
      // session start (Plan 01), but a future "reload master" affordance
      // could in principle re-derive masterIds — keep this dynamic.
      // D-26 / CR-03 — dedupe masterIds before passing to buildRecipeSchema.
      // The skip-blank-rows guard in loadLiveCsvs prevents NaN entries, but
      // a master accidentally containing duplicate ingredient_ids would still
      // produce a malformed JSON-schema enum. Defense in depth.
      const masterIds = [...new Set(this.ingredientMaster.map(m => m.ingredient_id))];
      const schema = buildRecipeSchema(masterIds);

      // PARSE-07 salted-XML defense (Plan 02-02). Generate a fresh
      // 12-hex salt per request via crypto.getRandomValues, wrap the
      // pasted recipe in <recipe-text-${salt}>...</recipe-text-${salt}>
      // tags. An injection payload inside this.rawText cannot forge a
      // matching close tag because it cannot guess the per-request salt.
      const salt = generateSalt();
      const userMessage = buildUserMessage(this.rawText, salt);

      // Defensive wrap-shape assertion (PARSE-07 / RESEARCH §C). If the
      // wrap is malformed for any reason (e.g. a future prompt-utils.js
      // regression), fail loud with a plain-language Error rather than
      // sending an unwrapped recipe to the LLM. The assertion is cheap
      // and catches the entire class of "wrap silently broke" bugs.
      if (!userMessage.startsWith('<recipe-text-' + salt + '>')
        || !userMessage.endsWith('</recipe-text-' + salt + '>')) {
        throw new Error('Internal error preparing the parse request. Please refresh and try again.');
      }

      // Build the system prompt from the CURRENT template (override OR
      // default) + master + conversions + salt. Uses the GETTERS from
      // Task 1 so an in-session settings save takes effect on the next
      // Parse without a refresh (Pitfall R override-read-timing).
      // buildSystemPrompt's first argument is the template string —
      // see Task 3 step 5 of plan 02-02 for the signature evolution.
      const systemPrompt = buildSystemPrompt(
        this.currentSystemPrompt,
        this.ingredientMaster,
        this.currentConversions,
        salt
      );

      // Move into CALLING immediately before the Anthropic round-trip.
      // Pass the SELECTED model (from the Settings dropdown) and the
      // WRAPPED user message (not this.rawText). DEFAULT_MODEL remains
      // declared above as the dropdown's default initial value, read
      // by the localStorage fallback in selectedModel's initializer.
      this.transition(STATES.CALLING);
      const { parsed, usage } = await callLLM({
        apiKey: this.apiKey,
        model: this.selectedModel,
        systemPrompt,
        userMessage,
        schema
      });

      // Plan 02-04 / API-07 — capture the REAL post-call token counts into
      // actualUsage. Done BEFORE validateRecipe so the usage record persists
      // even if Stage-1 Stage-2 validation throws (defensive: validate.js
      // is offline-pure and shouldn't throw, but a future refactor might).
      // Phase 2 keeps this DevTools-only; no UI display.
      this.actualUsage = usage;

      // Move into VALIDATING. Plan 02-03 fills this slot with the Valibot
      // post-validation pass; Plan 02-04 adds the coverage check here.
      this.transition(STATES.VALIDATING);

      // PARSE-03 / D-20 — two-stage post-validation. Stage 1 auto-fixes
      // clampable rules (negative quantity, reversed range, range-clamp,
      // popularity / difficulty 1..5) and records side-channel autoFixes.
      // Stage 2 hard-rejects non-empty raw_text + URL-format source and
      // records side-channel hardErrors. We populate form.header / form.rows
      // from the CORRECTED `value`, not from the raw parsed response, so
      // the user sees the clamped values in the form. The two side-channel
      // arrays drive the per-field inline notes in index.html.
      const { value, autoFixes, hardErrors } = validateRecipe(parsed);

      // Structured Outputs guarantees `value.header` and `value.rows` exist
      // and conform to the schema — validate.js preserves both (defensive
      // shape handling treats missing as empty).
      // D-25 / CR-02 — assign a synthetic _key to every CORRECTED row so
      // Alpine's x-for :key reseats rows by stable identity (not by editable
      // line_order). The _key is silently dropped by toJoinCsvRow's allow-list
      // on write — never reaches disk.
      this.form.header = value.header;
      // quick 260607-bru — init _confirmed:false on every parsed row so freshly
      // parsed rows render unconfirmed regardless of unknownQueue gating. Never
      // set true here — confirmation is a user action.
      this.form.rows = value.rows.map(r => ({ ...r, _key: nextRowKey(), _confirmed: false }));
      this.validationWarnings = autoFixes;
      this.validationErrors = hardErrors;

      // PARSE-04 / D-23 — token-coverage check. Runs AFTER validate so it
      // reads the CORRECTED rows' raw_text, not the LLM's raw parsed.rows.
      // If the LLM dropped > 5 content words OR any number, populate the
      // coverageWarning field (drives the yellow banner above the workspace)
      // AND auto-tick flag_fix_me on every row the heuristic attributes the
      // drop to. Approve is NOT gated by this — D-23 makes it advisory.
      const cov = checkCoverage(this.rawText, this.form.rows);
      if (cov.shouldWarn) {
        this.coverageWarning = cov;
        // Auto-flag the affected rows. Mutating form.rows[i].flag_fix_me on
        // the live Alpine proxy triggers reactivity correctly because
        // form.rows was assigned just above (top-level field, fully proxied).
        // Plan 04-05 / D-59 source (2) plumbing — alongside the existing
        // flag_fix_me=true tick, record coverage attribution into
        // flagSourcesByRowKey[row._key].coverageDropped so the per-row
        // flag-source tooltip (D-58) can attribute the source correctly.
        // RESEARCH §Research Focus 8 recommendation: attribute to ALL rows
        // whose coverage is affected per cov.affectedRowIndices (NOT just
        // the first/last). Preserves the existing flag_fix_me write
        // unchanged; the new write is a sibling, not a replacement.
        for (const i of cov.affectedRowIndices) {
          this.form.rows[i].flag_fix_me = true;
          const row = this.form.rows[i];
          if (row && row._key != null) {
            this.flagSourcesByRowKey[row._key] = {
              ...(this.flagSourcesByRowKey[row._key] || {}),
              coverageDropped: true
            };
          }
        }
      } else {
        this.coverageWarning = null;
      }

      // REVIEW-04 / D-36 — auto-tick flag_fix_me on any row with flagged_fields
      // entries. OR-composes with the D-23 coverage auto-flag above: once true,
      // stays true — the user can manually untick after reviewing. The schema
      // requires flagged_fields to exist (defensively initialized to [] by
      // validate.js Stage 3); the `>= 1` predicate naturally skips empty arrays.
      for (const row of this.form.rows) {
        if (Array.isArray(row.flagged_fields) && row.flagged_fields.length >= 1) {
          row.flag_fix_me = true;
        }
      }

      // REVIEW-10 / D-46 (Plan 03-04) — initial recipe_id suggestion. The
      // suggestion uses the session-start max + 1; Approve re-reads disk and
      // surfaces a notice if the disk has moved ahead (see recomputeRecipeId).
      this.recipeIdSuggestion = this.maxRecipeIdAtSessionStart + 1;

      // quick 260608-h1i — duplicate-recipe soft nudge. Runs AFTER form.rows is
      // populated and BEFORE the RESOLVING/REVIEWING branch below. NON-BLOCKING
      // + FAIL-OPEN: the synchronous matcher runs over the cached index (no I/O)
      // and is wrapped in its own try/catch so it can NEVER throw out of parse()
      // and can NEVER prevent the VALIDATING -> REVIEWING/RESOLVING transition.
      // Reset both flags at the START of the block too (defense against stale
      // mid-parse state; the primary reset also lives in startFresh).
      this.duplicateCandidates = [];
      this.duplicateDismissed = false;
      try {
        this.duplicateCandidates = findDuplicateCandidates(
          this.form.header?.name || '',
          this.form.rows,
          this.duplicateIndex
        );
      } catch (_e) {
        this.duplicateCandidates = [];
      }

      // quick 260618-ihr — instruction-standardization review flags. Parse-only
      // (D2), NON-BLOCKING, populated from the validated header.review_flags
      // (assigned above at this.form.header = value.header). Reset to [] first,
      // then populate defensively (empty array when absent). Reset on new parse
      // (here) + startFresh + restoreInflight.
      this.reviewFlags = [];
      this.reviewFlagsDismissed = false;
      if (Array.isArray(this.form.header?.review_flags)) {
        this.reviewFlags = this.form.header.review_flags;
      }

      // Phase 4 / Plan 04-02 / UNKNOWN-01 — derive unknownQueue from
      // null-ingredient_id rows. If non-empty, transition to RESOLVING so
      // the queue panel takes over the right pane and the form template is
      // suppressed (D-50). When the queue empties (via useMatch /
      // skipAsFreeform / Plan 04-04 submitAddNew), the resolving handlers
      // call transition(STATES.REVIEWING) themselves. When NO unknowns
      // exist, stay on Phase 2's existing path (validating → reviewing).
      // Loose `== null` catches both null and undefined per RESEARCH
      // Pitfall 8 (defense-in-depth against restore-from-localStorage drift).

      // quick 260610-9yz — auto-collapse the raw pane on parse SUCCESS so the
      // form reflows to near-full width. This sits inside the try, AFTER the
      // LLM call + validation + duplicate-detect have all succeeded, and
      // BEFORE both success transitions (RESOLVING / REVIEWING below). The
      // catch block (parse error → STATES.ERROR) is AFTER this point, so this
      // never fires on a parse error. The existing one-click Collapse/restore
      // toggle (index.html, @click="rawPaneCollapsed = !rawPaneCollapsed")
      // remains the user's manual re-expand and is unaffected; the next parse
      // re-collapses. startFresh / re-pick reset paths are untouched.
      this.rawPaneCollapsed = true;

      const unknownRows = this.form.rows.filter(r => r.ingredient_id == null);
      if (unknownRows.length > 0) {
        this.unknownQueue = unknownRows.map(r => ({
          _key: r._key,
          raw_text: r.raw_text,
          // Phase 4 gap-closure / UAT-04-G02 (260526) — carry the LLM-parsed
          // ingredient_name onto the card so topThreeMatches + the D-55
          // cascade can Fuse-search a clean phrase instead of the noisy
          // raw_text. Schema (schema.js:170) guarantees this is a required
          // non-nullable string; `|| ''` is defensive against a future LLM
          // emitting empty despite the contract.
          ingredient_name: r.ingredient_name || '',
          section: r.section,
          line_order: r.line_order,
          suggested_allergens: r.suggested_allergens || []
        }));
        this.transition(STATES.RESOLVING);
      } else {
        // Form populated, no unknowns — Phase 2's existing path.
        this.transition(STATES.REVIEWING);
      }
    } catch (e) {
      // Never log the raw error or the apiKey — RESEARCH §T-02-03.
      this.parseError = mapToPlainLanguage(e);
      // quick 260618-jr7 — capture a SAFE copyable detail (named fields only,
      // never the apiKey) so the banner's "Copy error" button can surface the
      // underlying Anthropic message (e.g. a schema 400) without DevTools.
      this.parseErrorDetail = extractErrorDetail(e);
      this.transition(STATES.ERROR);
    } finally {
      this.parsing = false;
    }
  },

  // ----- quick 260618-jr7 — copy the safe Anthropic error detail to clipboard -----
  // Fail-soft: navigator.clipboard is absent outside secure contexts and
  // writeText can reject (permissions). On success, flash "Copied ✓" for 2s.
  async copyErrorDetail() {
    if (!this.parseErrorDetail) return;
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) return;
      await navigator.clipboard.writeText(this.parseErrorDetail);
      this.errorCopied = true;
      setTimeout(() => { this.errorCopied = false; }, 2000);
    } catch (_e) {
      // Clipboard denied/unavailable — leave the label unchanged (no throw).
    }
  },

  // ----- Dev: hardcoded example recipe (visible only when ?dev=1) -----
  loadExample() {
    this.rawText = EXAMPLE_RECIPE;
  },

  // ----- Approve: write reviewed form to delta CSVs (Plan 03 / WRITE-02) -----
  /**
   * Write the reviewed form to `recipes_new.csv` + `recipe_ingredients_new.csv`
   * inside the per-session delta folder (D-11 amended / Q-1 option b /
   * D-12 append semantics). Safety-critical write path:
   *   - Live recipes.csv / ingredients.csv / recipe_ingredients.csv are NEVER
   *     opened for write (T-03-01).
   *   - PapaParse.unparse with explicit `columns:` is the ONLY serializer
   *     (D-14 / WRITE-04 / Pitfall E).
   *   - Permission re-checked immediately before writing (Pitfall C /
   *     T-03-04).
   *   - `approving` flag prevents double-click (T-03-05).
   *   - On error, `approved` stays false so the user can retry; parseError
   *     surfaces a plain-language message.
   */
  // ----- Phase 5 / Plan 05-01 / WRITE-01 — Approve preview gate -----
  /**
   * D-65 — open the pre-Approve preview modal. The Approve button now calls
   * THIS (not approve() directly): the user reviews exactly what will be
   * written, with a live allergen-union pass/fail indicator (D-41), before any
   * delta file lands. Writes NOTHING to disk.
   *
   * Before opening, assign the derived allergens into the header exactly as
   * approve() does immediately pre-write (form.header.allergens =
   * derivedAllergens.slice()). This makes the unionAssertionPasses indicator
   * reflect the about-to-be-written state — the same reconciliation approve()
   * performs, so the preview is truthful. (approve() still re-runs the assign +
   * its own recomputeRecipeId guard — defense in depth; do not remove those.)
   */
  openPreview() {
    if (this.approving || this.approved) return;
    if (!this.form.header) {
      this.parseError = 'Parse a recipe first.';
      return;
    }
    // Mirror approve()'s pre-write allergen reconciliation so the preview's
    // assertion indicator shows the state that will actually be written.
    this.form.header.allergens = this.derivedAllergens.slice();
    this.previewShowRows = false;
    this.previewOpen = true;
  },

  /** D-65 — close the preview without writing (Cancel / Escape). */
  closePreview() {
    this.previewOpen = false;
    this.previewShowRows = false;
  },

  /**
   * D-65 / D-68 — the "Save to delta" handler. Re-checks the allergen-union
   * assertion; if it FAILS, refuses the write (no override per D-68): the modal
   * stays open showing the fail indicator and a plain-English parseError points
   * the user back at the allergen chips. If it passes, closes the preview and
   * calls the existing approve() (which performs its own pre-write assign +
   * recomputeRecipeId collision guard — defense in depth).
   */
  confirmApprove() {
    if (!this.unionAssertionPasses) {
      // D-68 — refuse the write. Plain-English, points at the allergen chips.
      this.parseError = "The recipe's allergen list doesn't match the allergens of its ingredients, so the recipe wasn't saved. Check the allergen chips in the preview and try again.";
      return;
    }
    this.previewOpen = false;
    this.previewShowRows = false;
    this.approve();
  },

  async approve() {
    // Precondition guards. The Approve button's :disabled binds to these in
    // the UI, but a programmatic caller (e.g. future keyboard shortcut)
    // should fail safely with a plain-language message.
    // Phase 5 / Plan 05-02 / Pattern 4 — Approve/Merge mutual exclusion. A merge
    // in flight opens the live files for writing; approving concurrently could
    // append a delta whose ids the merge already reconciled. Guard extended with
    // `|| this.merging`.
    if (this.approving || this.approved || this.merging) return;
    if (!this.form.header) {
      this.parseError = 'Parse a recipe first.';
      return;
    }
    if (!this.csvStoreLoaded) {
      this.parseError = 'Import your CSVs first.';
      return;
    }
    // 03-REVIEW CR-01 — recipeIdSuggestion is bound via `x-model.number` on a
    // <input type="number">. When the user clears the input Alpine writes
    // `null` (or NaN). Without this guard, csvNumber(null/NaN) renders an
    // empty cell in both recipes_new.csv AND every row of
    // recipe_ingredients_new.csv, breaking the v2 schema's primary-key
    // referential integrity (recipes ↔ recipe_ingredients join by recipe_id).
    // The "Keep my number" button in the recompute-notice (index.html:198) re-
    // enters approve() bypassing recomputeRecipeId()'s null-comparison, so
    // this is the single chokepoint. Must run BEFORE the state-machine gate so
    // a programmatic caller in a non-REVIEWING state still sees the helpful
    // error rather than a silent no-op.
    if (this.recipeIdSuggestion == null
        || !Number.isFinite(this.recipeIdSuggestion)
        || !Number.isInteger(this.recipeIdSuggestion)
        || this.recipeIdSuggestion < 1) {
      this.parseError = 'Set a recipe ID (1 or greater) before approving.';
      return;
    }
    // CR-01 — state-machine gate. approve() is only valid from REVIEWING.
    // The TRANSITIONS table allows reviewing → approving → approved (happy
    // path) and approving → error (catch block). Without this gate + the
    // matching transitions below, this.state would stay at REVIEWING after
    // a successful Approve and parse()'s re-entry guard (line above the
    // parse body) would silently no-op the next Parse — see CR-01 in
    // 02-REVIEW.md for the full reproduction.
    if (this.state !== STATES.REVIEWING) return;

    this.approving = true;
    this.parseError = '';
    if (!this.transition(STATES.APPROVING)) {
      // Defensive: should never happen given the gate above, but if the
      // TRANSITIONS table is ever edited to remove reviewing → approving
      // we want to fail loud rather than silently writing in a bad state.
      this.approving = false;
      return;
    }

    // CR-02 — rewind tracker for the recipe_id allocation. If any write
    // (or any pre-write step that happens AFTER the ++maxRecipeIdAtSessionStart)
    // fails, the catch block decrements the counter so a retry reuses the
    // SAME id rather than skipping to N+1 — bounding the damage to a
    // single half-written row pair instead of leaving an unrecoverable
    // hole in the recipe_id sequence.
    let recipeIdAllocated = false;

    try {
      // quick 260612-abt — no FS permission re-check; the store needs no grant.

      // 1b. REVIEW-10 / D-46 (Plan 03-04) — recipe_id recompute. Re-read
      //     recipes.csv from disk and check if it has advanced beyond the
      //     user's current recipeIdSuggestion. On mismatch, populate the
      //     recipeIdRecomputeNotice and PAUSE — exit cleanly with
      //     approving=false so the notice's "Use {N}" / "Keep my number"
      //     buttons can re-invoke approve(). State machine rolls back to
      //     REVIEWING (TRANSITIONS allows approving → reviewing). This is
      //     the display-only half; Phase 5 WRITE-06 adds the actual refuse-
      //     write step for true collisions.
      const proceed = await this.recomputeRecipeId();
      if (proceed === false) {
        this.transition(STATES.REVIEWING);
        this.approving = false;
        return;
      }

      // 3. Use the user's editable recipeIdSuggestion as the canonical
      //    recipe_id (REVIEW-10 / D-46). recipeIdSuggestion was seeded from
      //    maxRecipeIdAtSessionStart+1 on parse-success and may have been
      //    edited by the user or updated by the recompute notice's
      //    "Use {N}" button. Phase 5 WRITE-06 will add the refuse-write
      //    collision check; Phase 3 trusts the user's value here.
      const recipeId = this.recipeIdSuggestion;
      recipeIdAllocated = true;

      // 4. CR-02 — atomic-ish two-CSV write.
      //    Build BOTH row payloads in memory FIRST so any toJoinCsvRow /
      //    toHeaderCsvRow throw aborts before either file is touched. Then
      //    write recipe_ingredients_new.csv BEFORE recipes_new.csv so a
      //    partial-write window cannot leave an orphan recipe header
      //    (recipe row with zero ingredient rows referencing it — a
      //    referential-integrity violation in the v2 schema the downstream
      //    app reads against). The reverse order means the worst possible
      //    half-write state is: join rows on disk pointing at a recipe_id
      //    that doesn't yet exist in recipes_new.csv — those join rows
      //    produce zero results in a downstream JOIN, which is recoverable
      //    on retry (Option C below decrements the recipe_id so the retry
      //    reuses the SAME id, making the second join-write idempotent in
      //    practice for the row count we just wrote).
      //
      //    See 02-REVIEW.md CR-02 for the full half-write reproduction.

      // REVIEW-06 / D-37 — synchronize disk-bound allergens to the derived
      // union immediately before write. Keeps toHeaderCsvRow pure (no
      // signature change — it still reads form.header.allergens as
      // Array<string> and joins with ';' for the CSV cell). The
      // derivedAllergens getter returns a fresh array each invocation;
      // .slice() defensively copies so any downstream mutation of
      // form.header.allergens cannot reach back through the getter into
      // shared state. Phase 5 WRITE-01 (D-41) will assert that the disk
      // cell equals union(ingredient_allergens) — simplified to "no
      // llm_extras term" by D-37. The assert reads the same source the
      // chip list shows; this line guarantees they agree.
      this.form.header.allergens = this.derivedAllergens.slice();

      // 03-REVIEW CR-03 — re-run Stage 2 validation immediately before write
      // so user-edit drift (e.g. a typed `12.5` in max_servings, popularity,
      // or difficulty — all integer in the v2 schema) is caught with a
      // plain-language error instead of silently corrupting disk. Stage 2
      // ran once during parse() but never re-runs on form edits; this is
      // the disk-write gate the user-facing UI lacks. We pass the live
      // form values (NOT structuredClone — validateRecipe already clones
      // internally) and ignore the returned `value` and `autoFixes` (those
      // are for the post-parse render path; on Approve we only care whether
      // the form HARD-rejects). On reject: roll the state machine back to
      // REVIEWING, clear the approving flag, and surface the first hard
      // error in parseError so the inline label is co-located with the
      // wider banner. The :disabled gating on integer inputs (step="1") is
      // the UX guard; this is the data-safety gate.
      const recheck = validateRecipe({ header: this.form.header, rows: this.form.rows });
      if (recheck.hardErrors.length > 0) {
        this.parseError = recheck.hardErrors[0].message;
        this.transition(STATES.REVIEWING);
        this.approving = false;
        return;
      }

      // Phase 12 (LOCK-01, D-02) — ACQUIRE the advisory lock ONLY HERE, just before
      // the first write. The parse→review→Approve flow is APPEND-ONLY: two people
      // parsing concurrently don't corrupt each other (worst case = a 2nd Approve
      // 409 that refreshKeepEdit handles cheaply), so we must NOT hold the global
      // lock through the long Anthropic call + leisurely review — that would freeze
      // the whole team (Pitfall 4). We hold it only for the brief write window and
      // call releaseLock() in the finally below (success, 409, or error alike). A
      // raced acquire 409 propagates to the catch below, where
      // _routePushFailure surfaces the existing pushConflictOffer / refreshKeepEdit
      // path — NEVER auto-retried (SAVE-02). Connected-only: with no token the write
      // path itself can't run, so skip the acquire.
      if (this.githubConnected && this.githubToken) {
        await this.acquireLock();
      }

      const headerRow = toHeaderCsvRow(
        this.form.header,
        recipeId,
        this.csvHeaders.recipes
      );
      const joinRows = this.form.rows.map(r =>
        toJoinCsvRow(r, recipeId, this.csvHeaders.recipe_ingredients)
      );

      // quick 260612-abt — DIRECT LIVE STORE WRITE (Approve->delta->Merge
      // collapsed). Read the current recipes + recipe_ingredients (+ ingredients
      // if new ingredients were added) from the store, APPEND the new rows to the
      // in-memory row arrays, and write back through the data-safety path
      // (_rewriteTwoFilesInPlace -> putFile snapshot->verify->AUTOMATIC revert).
      // A write/verify failure reverts BOTH files and surfaces the informational
      // mergeRestoreOffer. New ingredients are written FIRST (so a failure there
      // never half-writes the recipe pair), each via the same verify-protected
      // putFile; on any failure the whole Approve aborts.
      const liveRecipes = await getFile('recipes.csv');
      const liveJoins = await getFile('recipe_ingredients.csv');
      if (!liveRecipes || !liveJoins) {
        throw new Error('Your saved recipes data is missing — import the 3 CSVs again before approving.');
      }

      // Phase 4 / Plan 04-04 / D-53 — write any user-added new ingredients to the
      // live ingredients.csv store FIRST. recomputeMaxIngredientId (now reading
      // the store) silently bumps in-session ids if the master has grown AND
      // rewrites form rows referencing bumped ids — keeping the join rows
      // consistent. On read failure it sets parseError + returns null; we then
      // abort the whole Approve (nothing has been written yet) so we never write
      // a recipe that references ids we couldn't allocate.
      if (this.inSessionNewIngredients.length > 0) {
        const ok = await this.recomputeMaxIngredientId();
        if (!ok) {
          // parseError already populated; abort before any write (data-safety).
          this.transition(STATES.REVIEWING);
          this.approving = false;
          return;
        }
        const liveIngredients = await getFile('ingredients.csv');
        if (!liveIngredients) {
          throw new Error('Your ingredients data is missing — import the 3 CSVs again before approving.');
        }
        const newIngredientRows = this.inSessionNewIngredients.map(ing =>
          toIngredientCsvRow(ing, this.csvHeaders.ingredients)
        );
        // Re-read joinRows AFTER recompute (it may have rewritten form.rows ids).
        const joinRowsAfter = this.form.rows.map(r =>
          toJoinCsvRow(r, recipeId, this.csvHeaders.recipe_ingredients)
        );
        joinRows.length = 0;
        joinRows.push(...joinRowsAfter);
        // Phase 11 Plan 02 (D-08/D-09) — the ingredients write of an Approve gets
        // the "— ingredients" group tag so the 3 commits of the Approve read as a set.
        await this._rewriteIngredientsInPlace(
          [...liveIngredients.rows, ...newIngredientRows],
          this.buildCommitMessage({
            action: 'add',
            objectKind: 'recipe',
            title: `'${this.form.header?.name ?? ''}'`,
            groupTag: 'ingredients'
          })
        );
      }

      // Append the new recipe header + join rows and write the pair atomically
      // (all-or-nothing via _rewriteTwoFilesInPlace). line_order/recipe_id are
      // carried verbatim from the form rows; existing rows preserved.
      await this._rewriteTwoFilesInPlace(
        { filename: 'recipes.csv', newRows: [...liveRecipes.rows, headerRow] },
        { filename: 'recipe_ingredients.csv', newRows: [...liveJoins.rows, ...joinRows], headerCheckFn: isMigratedJoinHeader },
        // Phase 11 Plan 02 (D-08) — recipe action+title context for the pair commits.
        { action: 'add', title: `${recipeId} ('${this.form.header?.name ?? ''}')` }
      );

      // 5. Lock the form and populate the success banner (D-17). The
      //    lastWriteSummary shape is now exactly { recipesRows, ingredientRows }
      //    — the delta `folder` + `flagLogRows` fields are gone with the delta
      //    surface (flag_log.csv is no longer written).
      this.approved = true;
      this.lastWriteSummary = {
        recipesRows: 1,
        ingredientRows: joinRows.length
      };
      // REVIEW-10 (Plan 03-04) — advance session-start counter so the NEXT
      // parse() in this session suggests max(disk-known, recipeId) + 1
      // instead of duplicating the just-written id. Uses Math.max so a
      // user-decremented recipeIdSuggestion can't rewind the session counter.
      this.maxRecipeIdAtSessionStart = Math.max(this.maxRecipeIdAtSessionStart, recipeId);
      // quick 260612-abt — rebuild the read-only duplicate index from the store
      // so it reflects the just-written recipe (previously done post-Merge).
      // Fail-open: an index rebuild error never blocks the successful Approve.
      try {
        await this.buildDuplicateIndex();
      } catch (_e) { /* fail-open — duplicate nudge stays as-is */ }
      // REVIEW-09 / D-44 (Plan 03-04) — clear the in-flight slot on Approve
      // success. Placed AFTER the success state set so a failed write does
      // NOT clear the slot (the user can retry from in-memory state on the
      // same page, or refresh + restore).
      localStorage.removeItem(INFLIGHT_REVIEW_KEY);
      // 03-REVIEW CR-02 — cancel any pending debounced persist timer. Without
      // this, the Alpine.effect's deep-track of form.rows fires on the
      // `this.form.header.allergens = ...` mutation above (line ~1862),
      // starting a 750ms debounce. The synchronous removeItem above runs,
      // then 750ms later persistInflight() re-creates the slot — silently
      // resurrecting the just-cleared inflight slot. Next page load offers
      // to restore an already-approved recipe (the exact D-44 regression).
      // The `this.approved = true` guard below in persistInflight() is the
      // belt; this timer-clear is the braces.
      if (this.inflightPersistTimer) {
        clearTimeout(this.inflightPersistTimer);
        this.inflightPersistTimer = null;
      }
      // CR-01 — advance the state machine to APPROVED on the happy path.
      // The parse() re-entry guard accepts APPROVED as a valid prior state,
      // so the next Parse (after a startFresh()) is permitted to begin.
      this.transition(STATES.APPROVED);
    } catch (e) {
      // Plain-language error mapping for the approve path. We deliberately
      // do NOT pass through raw e.message for the generic branch (defensive
      // against future Chrome/FS Access errors echoing path components or
      // other context we don't want surfaced).
      // Also: never log or concatenate apiKey into any returned string —
      // apiKey is not used in this code path, but the prohibition stands
      // (T-02-03 from Plan 02).
      const name    = e && e.name;
      const message = (e && e.message) ? String(e.message) : '';
      // quick 260612-abt — a store write/verify failure threw the tagged
      // isRestoreOfferSentinel; putFile already AUTOMATICALLY reverted in-band and
      // the writer set the INFORMATIONAL mergeRestoreOffer. Surface ONLY that
      // notice — do NOT also set a parseError (no double banner).
      if (e && e.isRestoreOfferSentinel) {
        // mergeRestoreOffer already set by the writer; nothing else to show.
      } else if (this._routePushFailure(e)) {
        // Phase 11 Plan 03 (SAVE-02): a REMOTE push failure (409 / network /
        // verify-mismatch / missing-name / partial-save). _routePushFailure set
        // pushConflictOffer (the ONLY banner) and left this.form untouched so the
        // edit survives on screen for a Refresh + re-Save. No parseError here.
      } else if (message.startsWith('Permission to the folder was lost')) {
        this.parseError = message;
      } else if (message.startsWith("Couldn't write delta CSV") || message.startsWith("Couldn't write CSV")) {
        // Schema-unrecognized error from toJoinCsvRow — pass through verbatim.
        this.parseError = message;
      } else {
        this.parseError = `Couldn't save the recipe to your browser store: ${message || 'unknown error'}`;
      }
      // Leave `approved` false so the user can retry.
      // CR-02 — rewind the recipe_id allocation so a retry reuses the SAME
      // id (Option C in the review). Bounded-damage guarantee: when retry
      // succeeds, any partial-write residue (join rows from the failed
      // attempt) on disk references the SAME recipe_id as the retry's
      // header row — so the downstream join produces a consistent recipe
      // rather than a phantom recipe-id gap.
      // REVIEW-10 (Plan 03-04) note: the recipe_id is now sourced from
      // recipeIdSuggestion (user-editable, NOT a session counter), so the
      // value stays in the form for a natural retry. The recipeIdAllocated
      // guard is retained for symmetry with future Phase 5 / WRITE-06 work
      // but the explicit decrement is no longer needed — Phase 1's
      // ++maxRecipeIdAtSessionStart counter no longer advances on Approve.
      // Suppress an unused-var lint by deliberately referencing the guard.
      void recipeIdAllocated;
      // CR-01 — advance the state machine to ERROR on failure. The TRANSITIONS
      // table permits approving → error and error → preflight/idle, so the
      // next Parse re-entry (via parse()'s IDLE/APPROVED/ERROR allow-list)
      // remains permitted. Also keeps Approve failures in the same error
      // funnel as parse() failures for symmetric UX.
      this.transition(STATES.ERROR);
    } finally {
      this.approving = false;
      // Phase 12 (LOCK-01, D-02) — RELEASE the brief Approve-window lock whether the
      // write succeeded, 409'd, or errored. releaseLock no-ops safely when heldLock
      // is null (e.g. the acquire itself 409'd, or we never connected) and swallows
      // its own errors, so the parse flow holds the global lock only for the write.
      this.releaseLock();
    }
  },

  // ----- REVIEW-07 / D-28..D-31 (Plan 03-03) — click-to-source highlight -----
  // REVIEW-07 / D-28..D-31 — whole-line highlight, exact-substring whitespace-
  // normalized match, no-match silent auto-flag, row-fields only.
  //
  // Architectural property: pure store action — read-the-store + mutate-the-
  // store + one defensive querySelector inside $nextTick. NO try/catch wrapper
  // (defensive null-checks suffice; Alpine's error surface catches anything
  // unexpected). Plan 04 / Pitfall 18: this MUST stay a pure store mutation
  // on top-level fields; no draft-intermediate layer (Phase 4 persistence
  // reads the store directly).
  highlightSource(rowKey, field) {
    const row = this.form.rows.find(r => r._key === rowKey);
    if (!row) return;  // defensive: click came from a stale row state
    // 03-REVIEW WR-08 — skip the auto-flag for rows the user added by hand
    // with no raw_text (blankRow() sets raw_text:''). Without this guard,
    // the first focus into ANY field on a brand-new user-added row marks
    // it `{raw_text, dropped_content}` — semantically wrong (the row was
    // never derived from source, so it can't have "dropped" anything) and
    // surprising UX (a fresh row appears LLM-flagged).
    if (!row.raw_text || !row.raw_text.trim()) return;
    const lineIdx = findSourceLineIndex(this.rawText, row.raw_text);
    if (lineIdx === -1) {
      // D-29 no-match: silently auto-flag with dropped_content. The FLAG
      // attaches to 'raw_text' (the field being audited), NOT to the field
      // the user clicked. Helper enforces idempotency + cap-3. Leave the
      // previous highlight intact (RESEARCH §3).
      tryAddFlaggedField(row, 'raw_text', 'dropped_content');
      return;
    }
    this.matchedHighlightKey = rowKey;
    this.matchedLineIndex = lineIdx;
    // D-30 scroll-into-view via $nextTick — the span must exist in the DOM
    // when queried (Alpine renders the :class update first).
    this.$nextTick(() => {
      const span = document.querySelector('[data-line-index="' + lineIdx + '"]');
      if (span) span.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  },

  // REVIEW-07 / D-30 escape hatch — invoked by click on the raw <pre>.
  // Clears any persistent ribbon so the user can read the raw paste freely.
  clearHighlight() {
    this.matchedHighlightKey = null;
    this.matchedLineIndex = null;
  },

  // ----- REVIEW-09 / D-42..D-45 (Plan 03-04) — in-flight persistence -----
  // Debounced write of in-progress review state to localStorage so a mid-review
  // browser refresh recovers via the restore-prompt modal. 750ms debounce per
  // D-43. Single slot key per D-42. Quota errors silently console.warn'd per
  // D-45 + UI-SPEC Error State.
  //
  // Pitfall 18 (load-bearing for Phase 4): this layer reads form directly.
  // Phase 4 modals MUST mutate form directly, NOT a draft layer. If Phase 4
  // introduces a parallel "draft" state that commits on Save, a mid-modal
  // refresh loses every unsaved entry — exactly the regression Pitfall 18
  // warns against. The persistence layer NEVER opens/closes modals, NEVER
  // intercepts edits; it is a read-the-store derived backup.
  scheduleInflightPersist() {
    if (this.inflightPersistTimer) clearTimeout(this.inflightPersistTimer);
    this.inflightPersistTimer = setTimeout(() => {
      this.persistInflight();
      this.inflightPersistTimer = null;
    }, 750);
  },

  // Pitfall 18 (load-bearing for Phase 4): this layer reads form directly.
  // Phase 4 modals MUST mutate form directly, NOT a draft layer.
  persistInflight() {
    // Nothing to persist pre-parse — Alpine.effect's form.header gate also
    // suppresses scheduling, but this defensive guard covers programmatic
    // callers (e.g. a future "save now" button) and the brief window between
    // form.header being set and Alpine's first re-render firing the effect.
    if (!this.form.header) return;
    // 03-REVIEW CR-02 — D-44: the slot is cleared on Approve success and must
    // STAY cleared. The timer-clear in approve() handles the in-flight
    // debounce; this guard handles any future code path that mutates a
    // tracked field AFTER `approved = true` (e.g. the form is locked but a
    // post-approve effect re-fires the watcher). Both guards must remain in
    // place — removing either re-opens the inflight-restore-after-approve
    // regression.
    if (this.approved) return;

    // Strip runtime markers (_key, _needsFullReview) from each row per
    // UI-SPEC Open Implementation Note 4. _key is re-allocated fresh via
    // nextRowKey() on restore; _needsFullReview is derived runtime state.
    //
    // Phase 4 / Plan 04-05 / D-53 polish — extend the payload to carry
    // inSessionNewIngredients[] and flagSourcesByRowKey across a refresh.
    // Without this, a user who Adds a new ingredient then refreshes BEFORE
    // Approve loses the in-memory master entry (and the form row referencing
    // it dangles with a stale ingredient_id). Version stays at 1 because the
    // new fields are backward-compatible: older payloads simply lack the
    // fields → restoreInflight treats missing fields as empty.
    //
    // Note on _key correspondence: flagSourcesByRowKey is keyed by the
    // current-session _key values. On restore, _key is re-allocated fresh
    // (nextRowKey() generates new ids), so the persisted flagSourcesByRowKey
    // would normally point at stale keys. We persist anyway and accept the
    // staleness — the new-ingredient + coverage attribution survives only
    // for rows whose _key happens to match; in the typical loss-edge case
    // (refresh-during-review), the user's primary concern is the form +
    // master content, not the per-row source attribution. Rebuilding key
    // correspondence would require persisting a stable row id which Phase 3
    // D-25 explicitly avoided.
    const payload = {
      version: 1,
      rawText: this.rawText,
      form: {
        header: this.form.header,
        // quick 260607-bru — _confirmed is a transient review marker (parity
        // with _key/_needsFullReview): stripped here so it never persists.
        // Restored rows correctly start unconfirmed (a refresh mid-review
        // re-opens everything for re-checking; no stale "Confirmed" survives a
        // reload). restoreInflight needs no change — rows arrive without
        // _confirmed → falsy → unconfirmed.
        rows: this.form.rows.map(({ _key, _needsFullReview, _confirmed, ...rest }) => rest)
      },
      recipeIdSuggestion: this.recipeIdSuggestion,
      inSessionNewIngredients: this.inSessionNewIngredients,
      flagSourcesByRowKey: this.flagSourcesByRowKey,
      timestamp: Date.now()
    };
    try {
      localStorage.setItem(INFLIGHT_REVIEW_KEY, JSON.stringify(payload));
    } catch (e) {
      // QuotaExceededError or similar — silent fail per D-45 + UI-SPEC Error
      // State "localStorage quota exceeded on debounced save". The user's
      // edits remain in memory; next 750ms settle re-attempts. NEVER surface
      // to the user — persistence is best-effort, the in-memory store is
      // the source of truth.
      console.warn('Inflight-review persist failed (likely quota):', e && e.message ? e.message : e);
    }
  },

  // Restore-prompt → "Resume editing" click. Re-allocates fresh _key on every
  // row per UI-SPEC Open Implementation Note 4 (the persisted blob STRIPS
  // _key on serialize); defensively initializes missing flagged_fields to []
  // (consistent with validate.js Stage 3); warps the state machine to
  // REVIEWING via the canonical transition() call (idle → reviewing was
  // added to TRANSITIONS above to make this legal).
  restoreInflight() {
    if (!this.inflightRestorable) return;
    const p = this.inflightRestorable;
    this.rawText = p.rawText || '';
    this.form.header = p.form.header;
    // 03-REVIEW WR-03 — re-apply validate.js Stage 3's _needsFullReview
    // invariant on every restored row. The persisted blob strips
    // _needsFullReview (it's a runtime marker — UI-SPEC Open Implementation
    // Note 4), so on restore each row arrives without the flag. If the user
    // persisted a row with > MAX_FLAGGED_FIELDS_PER_ROW_APP (3) flagged_fields
    // entries — possible if the LLM emitted 5 and the user hadn't trimmed —
    // the per-field yellow borders render instead of the single "Needs full
    // review" pill, silently breaking D-35's cap-3 suppression contract.
    // Compute _needsFullReview from the restored flagged_fields.length so
    // the UI matches Stage 3's invariant.
    this.form.rows = (p.form.rows || []).map(r => {
      const flagged = Array.isArray(r.flagged_fields) ? r.flagged_fields : [];
      return {
        ...r,
        _key: nextRowKey(),
        flagged_fields: flagged,
        _needsFullReview: flagged.length > MAX_FLAGGED_FIELDS_PER_ROW_APP
      };
    });
    this.recipeIdSuggestion = p.recipeIdSuggestion ?? null;

    // quick 260618-ihr — re-derive the instruction-standardization review flags
    // from the restored header (parse-only / ephemeral; default [] when absent),
    // mirroring how row state is re-derived above. reviewFlagsDismissed resets
    // so the banner re-surfaces after a session restore.
    this.reviewFlags = [];
    this.reviewFlagsDismissed = false;
    if (Array.isArray(p.form.header?.review_flags)) {
      this.reviewFlags = p.form.header.review_flags;
    }

    // Phase 4 / Plan 04-05 / D-53 polish — rehydrate in-session new
    // ingredients + flag-source attribution map. Append in-session adds onto
    // ingredientMaster (dedupe by ingredient_id — the live master may
    // already contain entries with overlapping ids if the user has
    // re-loaded a folder where the master file grew on disk between
    // persist and restore). Then call refreshFuse so subsequent unknown
    // cards see the restored adds as fuzzy-match candidates.
    this.inSessionNewIngredients = Array.isArray(p.inSessionNewIngredients)
      ? p.inSessionNewIngredients
      : [];
    for (const ing of this.inSessionNewIngredients) {
      if (!ing || ing.ingredient_id == null) continue;
      if (!this.ingredientMaster.some(e => e.ingredient_id === ing.ingredient_id)) {
        this.ingredientMaster.push(ing);
      }
    }
    this.flagSourcesByRowKey = (p.flagSourcesByRowKey && typeof p.flagSourcesByRowKey === 'object' && !Array.isArray(p.flagSourcesByRowKey))
      ? p.flagSourcesByRowKey
      : {};
    // Only call refreshFuse if a Fuse instance has been initialized (i.e.,
    // the user has picked a CSV folder before; if not, the Fuse instance is
    // still null and initFuse will run on pickCsvFolder later).
    if (this.fuse) {
      this.refreshFuse();
    }

    this.restorePromptOpen = false;
    this.inflightRestorable = null;
    this.transition(STATES.REVIEWING);
    // 03-REVIEW WR-07 — re-evaluate the Settings auto-open contract now that
    // the restore prompt is closed. init() suppressed it to avoid two-modal
    // stacking; surface it now if the user is still keyless.
    if (!this.apiKey) this.settingsOpen = true;
  },

  // Restore-prompt → "Start fresh" click. Clears the slot per D-44 and
  // dismisses the prompt without restoring. Form state remains empty.
  dismissInflight() {
    localStorage.removeItem(INFLIGHT_REVIEW_KEY);
    this.inflightRestorable = null;
    this.restorePromptOpen = false;
    // 03-REVIEW WR-07 — see restoreInflight().
    if (!this.apiKey) this.settingsOpen = true;
  },

  // ----- REVIEW-10 / D-46 (Plan 03-04) — recipe_id recompute on Approve -----
  // Re-read recipes.csv from disk and compare max(recipe_id) + 1 against the
  // user's current recipeIdSuggestion. If the disk has moved ahead, populate
  // recipeIdRecomputeNotice and pause Approve (return false). Otherwise
  // proceed (return true).
  //
  // Phase 3 ONLY adds the recompute-and-display half. Phase 5 / WRITE-06
  // implements the actual refuse-write step (D-46 explicit). "Keep my number"
  // here WILL proceed with the user's value even if it would collide on disk.
  //
  // Disk-read failure surfaces a plain-language warning via parseError and
  // returns true (non-blocking per D-46 + UI-SPEC Error State).
  /**
   * Phase 4 / Plan 04-04 / D-54 — recompute-before-write for in-session new
   * ingredient IDs. Mirrors recomputeRecipeId() (D-46) but for the
   * ingredients_new.csv delta-write path.
   *
   * 1. Re-read ingredients.csv from disk via the existing readCsvFromHandle.
   * 2. Compute max(ingredient_id) currently on disk.
   * 3. If disk grew past maxIngredientIdAtSessionStart, bump every entry in
   *    inSessionNewIngredients[] to a fresh sequential id above the new
   *    disk max — AND rewrite every form row whose ingredient_id is in the
   *    map. This guarantees that what gets written to recipe_ingredients_new.csv
   *    (form rows) still references valid ingredient_id values from the
   *    ingredients_new.csv we're about to write.
   *
   * Returns:
   *   - `true` on success (caller proceeds to delta-write)
   *   - `null` on disk-read failure (caller skips the delta-write; parseError
   *     surfaces a plain-language note). The recipe header + join rows
   *     still write successfully; only the third (ingredients_new.csv)
   *     file is skipped — the user can manually add the new ingredient
   *     to their live ingredients.csv afterwards if needed.
   *
   * No user-facing notice on bump (D-54 — silent recompute). The bump is
   * defensive against the unlikely case of the user editing ingredients.csv
   * mid-session in a separate app; for the typical single-user single-session
   * flow the bump path never fires.
   */
  async recomputeMaxIngredientId() {
    let ingredients;
    try {
      ingredients = await getFile('ingredients.csv');
    } catch (_e) {
      // Disk-read failure — surface a plain-language note and signal the
      // caller to skip the delta-write rather than write with potentially
      // stale ids (data-safety > completeness).
      this.parseError = "Couldn't re-check the ingredients file before writing new ingredients. The recipe was saved, but new-ingredient rows weren't written to ingredients_new.csv — add them manually if needed.";
      return null;
    }
    const maxOnDisk = Math.max(
      0,
      ...ingredients.rows
        .map(r => parseInt(r.ingredient_id, 10))
        .filter(n => Number.isFinite(n))
    );
    if (maxOnDisk > this.maxIngredientIdAtSessionStart) {
      // Build old→new id map and apply to inSessionNewIngredients[] in order.
      const idMap = new Map();
      let nextId = maxOnDisk;
      for (const entry of this.inSessionNewIngredients) {
        nextId += 1;
        idMap.set(entry.ingredient_id, nextId);
        entry.ingredient_id = nextId;
      }
      // Walk form.rows and rewrite ingredient_id where it matches a bumped entry.
      if (this.form && Array.isArray(this.form.rows)) {
        for (const row of this.form.rows) {
          if (idMap.has(row.ingredient_id)) {
            row.ingredient_id = idMap.get(row.ingredient_id);
          }
        }
      }
    }
    return true;
  },

  async recomputeRecipeId() {
    let recipes;
    try {
      recipes = await getFile('recipes.csv');
    } catch (_e) {
      // Phase 5 / Plan 05-01 / WRITE-06 / D-46 — FAIL-CLOSED on disk-read
      // failure. Phase 3 shipped this branch fail-OPEN (returned true, letting
      // the user Approve with their current value). Phase 5 promotes recipe_id
      // safety to refuse-write: if we cannot re-read recipes.csv we cannot
      // prove the suggested id is collision-free, so we REFUSE the write rather
      // than risk an overwrite/duplicate. Mirrors recomputeMaxIngredientId's
      // fail-closed SKIP precedent (data-safety > completeness). approve()'s
      // `if (proceed === false)` guard cleanly aborts and rolls back to
      // REVIEWING.
      this.parseError = "Couldn't re-check the recipe ID file before saving, so the recipe wasn't saved (to avoid overwriting an existing recipe). Try Pick CSV folder again, then Approve.";
      return false;
    }
    const diskIds = recipes.rows
      .map(r => parseInt(r.recipe_id, 10))
      .filter(n => Number.isFinite(n));
    const maxOnDisk = Math.max(0, ...diskIds);
    const nextSuggestion = maxOnDisk + 1;

    // Phase 5 / Plan 05-01 / WRITE-06 / D-46 — TRUE-COLLISION refuse-write.
    // If the user's current recipeIdSuggestion ALREADY EXISTS as a recipe_id in
    // the freshly re-read live recipes.csv, writing it would later (at Merge)
    // collide with — and risk overwriting — a real recipe. This is distinct
    // from the "disk moved ahead" pause below: an exact match is a hard
    // collision, not merely a stale suggestion. Refuse the write and offer
    // re-allocation to maxOnDisk+1. Only meaningful for a finite suggestion;
    // the approve() precondition guard already rejects null/NaN before we get
    // here, but check defensively for callers that bypass it.
    if (Number.isFinite(this.recipeIdSuggestion)
        && diskIds.includes(this.recipeIdSuggestion)) {
      this.recipeIdRecomputeNotice = {
        newSuggestion: nextSuggestion,
        oldFormValue: this.recipeIdSuggestion,
        // collision flag lets the notice template show the stronger
        // "already used in your live file" copy instead of the softer
        // "disk has more recipes than expected" wording.
        collision: true
      };
      return false;
    }
    // 03-REVIEW CR-01 hardening — `nextSuggestion > this.recipeIdSuggestion`
    // coerces null to 0, so a null recipeIdSuggestion would silently match
    // any non-empty recipes.csv. Use -Infinity for the comparison so any
    // non-finite suggestion (null, NaN, undefined) ALWAYS triggers the
    // recompute notice — surfacing the issue to the user, not bypassing it.
    // The approve() precondition guard above catches the null-write case
    // first; this is belt-and-braces for callers that bypass approve() (e.g.
    // a future "validate before approve" preview).
    const current = Number.isFinite(this.recipeIdSuggestion) ? this.recipeIdSuggestion : -Infinity;
    if (nextSuggestion > current) {
      this.recipeIdRecomputeNotice = {
        newSuggestion: nextSuggestion,
        oldFormValue: this.recipeIdSuggestion
      };
      return false;
    }
    return true;
  },

  /**
   * quick 260607-anu — ONE-TIME live recipe_ingredients.csv schema migration.
   *
   * Mechanically (no LLM) rewrites the live join CSV from the legacy
   * unit/quantity/range column shape to the four-column
   * quantity_metric/unit_metric/quantity_volumetric/unit_volumetric shape.
   * Phase-5-grade data safety: timestamped byte-faithful backup BEFORE any
   * write, a single whole-file rewrite (the one sanctioned rewrite — distinct
   * from appendLiveCsv's append-only path), round-trip re-read+re-parse verify,
   * a one-click restore offer (D-64) on any verify failure, and an
   * isMigratedJoinHeader idempotency check so it refuses to run twice. Emits a
   * migration_report_<ts>.csv listing every row left with an empty
   * quantity_metric so the user can backfill later.
   *
   * Reuses the merge() guard ladder (approving/merging exclusion +
   * readwrite-permission re-check) verbatim. No new packages; PapaParse only.
   */
  async migrateLiveSchema() {
    // Pattern 4 — double-click + write-in-flight exclusion. The migration
    // rewrites the live store, so it must be exclusive with approve() too.
    if (this.approving || this.merging) return;
    if (!this.csvStoreLoaded) {
      this.parseError = 'Import your CSVs first.';
      return;
    }
    this.merging = true;
    this.parseError = '';
    this.lastMigrationSummary = null;
    this.mergeRestoreOffer = null;

    try {
      // quick 260612-abt — migration now rewrites the STORE; no folder permission
      // re-check. Each _migrateOneFile reads + putFile-rewrites its file, verified.

      // quick 260607-c65 — the SAME button now migrates BOTH files
      // independently. The user already ran the recipe_ingredients migration on
      // their live folder, so per-file state is detected (not all-or-nothing):
      // an already-migrated file is left UNTOUCHED (no backup, no rewrite) via
      // its idempotent header check; the not-yet-migrated file is backed up +
      // rewritten + verified. Each file is an independent committed unit with
      // its own backup. A verify-failure on either file throws a tagged sentinel
      // (handled below) that surfaces the D-64 restore offer for THAT file and
      // stops cleanly without a second (double-displayed) parseError banner.
      const files = [];

      // recipe_ingredients.csv — existing four-column quantity migration (its
      // report logic stays; on the user's live folder this returns alreadyMigrated).
      files.push(await this._migrateOneFile({
        filename: 'recipe_ingredients.csv',
        isMigratedFn: isMigratedJoinHeader,
        transformFn: migrateRecipeIngredientsRows
      }));

      // ingredients.csv — additive shopping_unit + scale_category + pantry_staple
      // migration (no report). quick 260612-esy / 260614-eqa: the isMigratedFn is the
      // COMBINED "fully migrated" predicate (has shopping_unit AND scale_category AND
      // pantry_staple). _migrateOneFile uses it BOTH as the early-return idempotency
      // lock AND as putFile's verify gate — so a file that already has shopping_unit
      // + scale_category but LACKS pantry_staple does NOT early-return as
      // alreadyMigrated (it still gains pantry_staple), and the post-write verify
      // requires ALL FOUR columns to be present (quick 260615-e1n adds pantry_section).
      files.push(await this._migrateOneFile({
        filename: 'ingredients.csv',
        // quick 260615-kid — AND-in isPackUnitsTaggedIngredientsHeader so Migrate does
        // NOT no-op on a file already carrying the prior four columns but lacking
        // pack_units/pack_unit_label (BLOCKER-PREEMPT #1, recurring additive-column lesson).
        // phase 08 / REG-01 — AND-in isRegularTaggedIngredientsHeader so a file already
        // carrying the prior five additive columns still gains regular + regular_qty_per_person.
        isMigratedFn: cols => isMigratedIngredientsHeader(cols) && isCategorizedIngredientsHeader(cols) && isStapleTaggedIngredientsHeader(cols) && isSectionTaggedIngredientsHeader(cols) && isPackUnitsTaggedIngredientsHeader(cols) && isRegularTaggedIngredientsHeader(cols),
        transformFn: migrateIngredientsRows
      }));

      this.lastMigrationSummary = { files };
      // fast 2026-06-08 — a successful run (no throw) leaves BOTH files on the
      // new schema (each was either already-migrated or just migrated+verified),
      // so the button has done its job and can hide.
      this.schemaMigrationNeeded = false;
      this.merging = false;
    } catch (e) {
      // quick 260612-abt — a verify-failure sentinel already set the INFORMATIONAL
      // mergeRestoreOffer (putFile auto-reverted the store in-band); surface ONLY
      // that notice. Otherwise a plain-language migration error.
      if (e && e.isRestoreOfferSentinel) {
        this.merging = false;
        return;
      }
      this.parseError = `Couldn't migrate your data: ${(e && e.message) || 'unknown error'}.`;
      this.merging = false;
    }
  },

  /**
   * _rewriteIngredientsInPlace(newRows) — quick 260607-qbj. Extracted shared
   * in-place ingredients rewrite; the manager's edit + add both funnel here.
   * Mirrors _migrateOneFile's data-safety chain (steps 2/4/5/6/7) MINUS the
   * idempotency early-return and report writing. The CALLER does the readwrite
   * permission re-check + read-before-write of the disk rows and passes the
   * COMPLETE array of disk-shaped row objects (one mutated or appended); this
   * helper never reconstructs rows from the lossy in-memory master.
   *
   * Chain: read live ingredients.csv text once (detectCsvConventions + capture
   * the live header column order) → backup first (throw aborts with NO write)
   * → Papa.unparse with the captured columns + detected newline (BOM iff present)
   * → one TRUNCATING whole-file rewrite → round-trip re-read+re-parse verify
   * (row count + header deep-equal + isMigratedIngredientsHeader) → on verify
   * failure set this.mergeRestoreOffer + THROW the tagged isRestoreOfferSentinel
   * (verbatim shape from _migrateOneFile).
   *
   * @param {Array<object>} newRows — complete disk rows keyed by the live header
   * @returns {Promise<void>}
   */
  async _rewriteIngredientsInPlace(newRows, message) {
    const filename = 'ingredients.csv';
    // quick 260612-abt — STORE-BACKED rewrite. Read the current record from the
    // store for its captured column order + conventions (BOM/newline), build the
    // new record keyed by that header, and delegate the snapshot->verify->AUTOMATIC
    // in-band revert to putFile. The verify chain (row-count + header deep-equal +
    // isMigratedIngredientsHeader gate) now lives inside putFile/verifyRoundTrip;
    // on the thrown isRestoreOfferSentinel we set the INFORMATIONAL
    // mergeRestoreOffer (a write was automatically rolled back) and re-throw.
    const current = await getFile(filename);
    if (!current || !current.columns || current.columns.length === 0) {
      const reason = `Couldn't read ${filename} from the browser store before saving, so nothing was changed.`;
      const sentinel = new Error(reason);
      sentinel.isRestoreOfferSentinel = true;
      this.mergeRestoreOffer = { reason, filesWritten: [filename] };
      throw sentinel;
    }
    // Phase 11 Plan 02 (D-11): the last-known-remote sha MUST come from this
    // pre-putFile `current` read (the funnel's own putFile writes no meta, so a
    // re-read after it would yield meta === undefined → a 422 push). `current`
    // is also the D-02 revert target (preEditRecord).
    const sha = current.meta && current.meta.sha;
    try {
      await putFile(
        filename,
        { columns: current.columns, rows: newRows, hasBOM: current.hasBOM, newline: current.newline },
        { Papa, headerCheckFn: isMigratedIngredientsHeader }
      );
    } catch (e) {
      if (e && e.isRestoreOfferSentinel) {
        // INFORMATIONAL auto-rollback notice — putFile already reverted the store
        // to the snapshot in-band; this banner just tells the user it happened.
        this.mergeRestoreOffer = {
          reason: e.message,
          filesWritten: [filename]
        };
      }
      throw e;
    }
    // Phase 11 Plan 02 (D-10/D-11) — push the just-verified bytes to the shared
    // repo AFTER the local cache write succeeded. The shared helper write-gates
    // on readOnlyMode, GET-back verifies (SAVE-04), writes the new sha back on
    // success, and on any failure D-02-reverts the cache to `current` and
    // re-throws the typed error (this standalone funnel OWNS its banner, but
    // Plan 03 owns the push-failure banner copy — here the error just propagates
    // to the Manage-Ingredients caller's catch).
    await this._pushFileAfterCacheWrite({
      filename,
      columns: current.columns,
      sha,
      newRows,
      hasBOM: current.hasBOM,
      newline: current.newline,
      headerCheckFn: isMigratedIngredientsHeader,
      message,
      preEditRecord: current
    });
  },

  /**
   * _rewriteOneFileInPlace — quick 260608-agp, store-backed in quick 260612-abt.
   * A FILENAME-AGNOSTIC single-record store write that delegates the
   * snapshot->verify->AUTOMATIC in-band revert to putFile. Does NOT set
   * this.mergeRestoreOffer (the orchestrator _rewriteTwoFilesInPlace owns the
   * COMBINED informational offer); it just lets putFile's tagged sentinel
   * propagate. Fails closed on an empty captured header (T-agp-05).
   *
   * headerCheckFn is OPTIONAL (recipes.csv has no migration gate).
   * `backupTs` is accepted for signature compatibility only (now unused — putFile
   * owns its own snapshot).
   *
   * @param {object} opts
   * @param {string} opts.filename
   * @param {Array<object>} opts.newRows — complete rows keyed by the live header
   * @param {(cols:string[])=>boolean} [opts.headerCheckFn]
   * @param {string} [opts.backupTs] — unused (signature compatibility)
   * @returns {Promise<void>}
   */
  async _rewriteOneFileInPlace({ filename, newRows, headerCheckFn, backupTs, message }) {
    // quick 260612-abt — STORE-BACKED single-file rewrite. Read the current
    // record from the store for its captured column order + conventions, then
    // delegate to putFile (snapshot->verify->AUTOMATIC in-band revert). Backup
    // is no longer a separate step — putFile owns the snapshot+revert. This
    // helper still does NOT set this.mergeRestoreOffer (the orchestrator owns the
    // COMBINED offer); it just lets putFile's tagged sentinel propagate.
    // `backupTs` is accepted for signature compatibility but is now unused.
    void backupTs;
    const current = await getFile(filename);
    const columns = (current && current.columns) || [];

    // Fail closed on an empty captured header (T-agp-05) — a truncated/empty read
    // must NOT silently overwrite a file with a column-less unparse.
    if (columns.length === 0) {
      const reason = `Couldn't read the columns in ${filename} before saving, so nothing was changed.`;
      const sentinel = new Error(reason);
      sentinel.isRestoreOfferSentinel = true;
      throw sentinel;
    }

    // Phase 11 Plan 02 (D-11): the last-known-remote sha comes from THIS
    // pre-putFile `current` read (a post-putFile re-read would be meta-less → 422).
    // `current` is also the D-02 revert target.
    const sha = current.meta && current.meta.sha;

    // putFile snapshots the prior record, writes, re-reads+re-parses+verifies
    // (row-count + header deep-equal + optional headerCheckFn) and AUTOMATICALLY
    // reverts to the snapshot on failure, throwing a tagged sentinel.
    await putFile(
      filename,
      { columns, rows: newRows, hasBOM: current.hasBOM, newline: current.newline },
      { Papa, headerCheckFn }
    );

    // Phase 11 Plan 02 (D-10/D-11) — push AFTER the local cache write succeeds.
    // This funnel does NOT own the combined banner (the two-file orchestrator
    // does), so let any thrown push error propagate up — do NOT set a banner here.
    await this._pushFileAfterCacheWrite({
      filename,
      columns,
      sha,
      newRows,
      hasBOM: current.hasBOM,
      newline: current.newline,
      headerCheckFn,
      message,
      preEditRecord: current
    });
  },

  /**
   * _rewriteTwoFilesInPlace — quick 260608-agp, store-backed in quick 260612-abt.
   * The ORCHESTRATOR for a consistent two-record store write (recipes.csv +
   * recipe_ingredients.csv). saveRecipeEdit, deleteRecipe and Approve funnel here.
   *
   * putFile owns each file's own snapshot->verify->AUTOMATIC in-band revert; the
   * ALL-OR-NOTHING pair guarantee is the orchestrator's job: snapshot BOTH records
   * up front, write A then B, and if B fails revert A by putting A's snapshot back.
   * On any failure surface the COMBINED informational mergeRestoreOffer (both
   * records are back to their pre-write state) and re-throw the tagged sentinel.
   *
   * Phase 11 Plan 02 (SAVE-03 / D-04 / D-09): `message` carries the recipe
   * action+title context. Per-file commit messages are built with D-09 group
   * tags (recipes.csv → "— recipe", recipe_ingredients.csv → "— links") and
   * threaded down to _rewriteOneFileInPlace, whose own pre-putFile `current`
   * read is the last-known-remote sha + D-02 revert target for its push.
   *
   * CRITICAL DIVERGENCE — the remote half does the OPPOSITE of the local
   * all-or-nothing. For a LOCAL verify failure on B the existing rule holds
   * (revert A; both back to pre-write — "rolled back, data unchanged"). But for
   * a REMOTE push failure on B (after A already pushed), D-04 says HARD STOP and
   * LEAVE A's landed remote row (you cannot un-PUT — that is itself a write that
   * could 409). SAVE-03's referenced-before-referencing order (A=recipes before
   * B=recipe_ingredients, with ingredients already pushed by the Approve caller)
   * guarantees the orphan has no inbound FK. The honest partial-save banner names
   * what landed vs not.
   *
   * @param {{filename:string,newRows:Array<object>,headerCheckFn?:Function}} fileA
   * @param {{filename:string,newRows:Array<object>,headerCheckFn?:Function}} fileB
   * @param {{action?:string,title?:string}} [message] — recipe action+title context
   * @returns {Promise<void>}
   */
  async _rewriteTwoFilesInPlace(fileA, fileB, message = {}) {
    // quick 260612-abt — STORE-BACKED two-file all-or-nothing write. putFile owns
    // each file's own snapshot+verify+auto-revert; the LOCAL ALL-OR-NOTHING pair
    // guarantee (a LOCAL verify failure on B must also undo A) is the
    // orchestrator's job. Phase 11 layers the REMOTE push on top with the
    // DIVERGENT D-04 partial-save rule (see the class doc above).
    const snapA = await getFile(fileA.filename);
    const snapB = await getFile(fileB.filename);
    if (!snapA || (snapA.columns || []).length === 0 || !snapB || (snapB.columns || []).length === 0) {
      // PLAIN Error — nothing written, nothing to roll back, no restore banner.
      const which = (!snapA || (snapA.columns || []).length === 0) ? fileA.filename : fileB.filename;
      throw new Error(`Couldn't read ${which} from the browser store before saving, so nothing was changed.`);
    }

    // D-09 per-file commit messages with group tags. fileA = recipes.csv → recipe,
    // fileB = recipe_ingredients.csv → links. Built once here so both files of the
    // pair read as one coherent set in the commit history.
    const { action = 'edit', title = '' } = message || {};
    const messageA = this.buildCommitMessage({ action, objectKind: 'recipe', title, groupTag: 'recipe' });
    const messageB = this.buildCommitMessage({ action, objectKind: 'recipe', title, groupTag: 'links' });

    try {
      // _rewriteOneFileInPlace A: local putFile (snapshot->verify->auto-revert)
      // THEN push (its own `current` read supplies the sha + D-02 revert target).
      await this._rewriteOneFileInPlace({ ...fileA, message: messageA });
      try {
        await this._rewriteOneFileInPlace({ ...fileB, message: messageB });
      } catch (eB) {
        // B failed. DISTINGUISH the failure class (the heart of D-04):
        //
        //   LOCAL verify failure (eB.isRestoreOfferSentinel): putFile already
        //   reverted B's cache in-band BEFORE any push. Honour the all-or-nothing
        //   pair — revert A's cache too so both are back to pre-write state.
        //
        //   REMOTE push failure (anything else — GhConflictError / network /
        //   isPushVerifyMismatch / isPushNameMissing): A already PUT to remote
        //   (a harmless orphan with no inbound FK per SAVE-03). DO NOT revert A
        //   (un-PUT is forbidden — another write that could 409). _pushFileAfterCacheWrite
        //   already D-02-reverted B's CACHE. Leave A's cache with its new sha.
        const isLocalVerifyFailure = !!(eB && eB.isRestoreOfferSentinel);
        if (isLocalVerifyFailure) {
          try {
            await putFile(
              fileA.filename,
              { columns: snapA.columns, rows: snapA.rows, hasBOM: snapA.hasBOM, newline: snapA.newline },
              { Papa }
            );
          } catch (_revertErr) {
            // Best-effort revert of A; putFile's own verify protects the snapshot.
          }
        }
        // Tag the error so the OUTER catch can pick the right banner copy.
        // Phase 16: also carry WHICH file landed (fileA) so _routePushFailure can
        // name it instead of hard-coding 'recipes.csv' — robust if this partial-save
        // tag is ever set for a different file pair.
        if (!isLocalVerifyFailure) {
          eB.isRemotePartialSave = true;
          eB.partialSaveFilesWritten = [fileA.filename];
        }
        throw eB;
      }
    } catch (e) {
      // gap-closure GAP 2 — mergeRestoreOffer is LOCAL-VERIFY-ROLLBACK-ONLY.
      // Phase 11 single-banner discipline: EVERY remote push failure (file-A or
      // file-B GhConflictError / network 5xx / isPushVerifyMismatch /
      // isPushNameMissing, including the D-04 isRemotePartialSave path) is routed
      // by the CALLER's catch via _routePushFailure → the single pushConflictOffer
      // banner. Setting mergeRestoreOffer here for any remote failure double-banners
      // and leaks the raw GitHub message. The OLD `else` fired for a file-A remote
      // failure too (it never carries isRemotePartialSave), which was the bug.
      // So: set mergeRestoreOffer ONLY for a LOCAL verify rollback, identified by
      // e.isRestoreOfferSentinel (set by csvStore.js putFile's in-band revert) —
      // at that point both store records are back to their pre-write state (B by
      // putFile's in-band revert, A by the snapshot restore above). Re-throw the
      // typed error unchanged in all cases for the caller to route.
      if (e && e.isRestoreOfferSentinel) {
        this.mergeRestoreOffer = {
          reason: (e && e.message) ? e.message : 'Saving failed partway through and was automatically rolled back — your data is unchanged.',
          filesWritten: ['recipes.csv', 'recipe_ingredients.csv']
        };
      }
      throw e;   // re-throw the typed error for the caller's catch + Plan 03 banner
    }
  },

  /**
   * _pushFileAfterCacheWrite — Phase 11 Plan 02 (SAVE-01/03/04, D-02/D-04/D-10/D-11).
   * The SHARED per-file remote half the three _rewrite*InPlace funnels compose
   * immediately AFTER their local putFile resolves. It pushes the just-verified
   * bytes to the shared repo, GET-back verifies, writes the new sha into the
   * cache meta on success, and reverts the cache to last-known-remote on any
   * failure — so the funnels share ONE push+verify+revert implementation (D-10
   * "wire at funnel level", no scattering).
   *
   * CRITICAL — the sha + revert target come FROM THE CALLER, never a re-read:
   *   The funnels call putFile WITHOUT meta, and rawPut replaces the whole
   *   record (csvStore.js), so a post-write getFile() here would return
   *   meta === undefined → a no-sha CREATE → a guaranteed 422 on EVERY save.
   *   The last-known-remote sha therefore arrives via `sha` (extracted by the
   *   caller from its pre-putFile `current` read), and the D-02 revert target
   *   is the caller's `preEditRecord` (that same pre-edit { columns, rows,
   *   hasBOM, newline, meta }) — NOT the post-edit `newRows` (reverting to
   *   post-edit rows under the old sha would leave the cache in a state that
   *   never existed remotely, violating D-02).
   *
   * @param {object} args
   * @param {string} args.filename
   * @param {string[]} args.columns — the captured live header (from `current`)
   * @param {string} [args.sha] — LAST-KNOWN-REMOTE blob sha (from current.meta.sha)
   * @param {Array<object>} args.newRows — the just-written (post-edit) rows
   * @param {boolean} args.hasBOM
   * @param {string} args.newline
   * @param {(cols:string[])=>boolean} [args.headerCheckFn]
   * @param {string} args.message — buildCommitMessage() output
   * @param {object} args.preEditRecord — pre-edit `current` (D-02 revert target)
   * @returns {Promise<void>}
   */
  async _pushFileAfterCacheWrite({ filename, columns, sha, newRows, hasBOM, newline, headerCheckFn, message, preEditRecord }) {
    // (1) Write-gate (D-02 stale-cache-as-writable guard): never push from a
    // not-connected / not-pulled session. The editors are already :disabled when
    // read-only; reuse the SAME getter (Phase 12's lock extends it) — no second flag.
    if (this.readOnlyMode) return;

    // (2) Build the record to push from the args in hand (NO post-write re-read —
    // the funnels' putFile wrote no meta, so a getFile here would 422 the push).
    const toPush = { columns, rows: newRows, hasBOM, newline, meta: { sha } };

    try {
      // (3) Push. pushToRemote serializes byte-faithfully and PUTs against the
      // supplied last-known-remote sha. A stale sha throws GhConflictError (409);
      // a network/5xx throws a GhError; a blank name throws isPushNameMissing.
      // NONE caught here — they fall to the catch below (revert + re-throw).
      const { newSha } = await this.pushToRemote(filename, toPush, message);

      // (4) SAVE-04 GET-back verify — row-count + header + byte round-trip against
      // the bytes we pushed. A mismatch throws isPushVerifyMismatch (flags, no
      // silent pass); we do NOT auto-revert the remote (git history is the deep
      // rollback) — but the catch below still applies the LOCAL D-02 cache-revert.
      //
      // Phase 16 (T-16-12): a FIRST push of a brand-new file (e.g.
      // residents_allergens.csv created against an existing repo) can transiently
      // 404 on the contents API for a moment right after a successful create —
      // GitHub's read-after-create consistency lag. pushToRemote ALREADY returned
      // newSha, so the write SUCCEEDED; a 404 here is therefore definitionally
      // transient, NOT "the file is missing". Retry the read-back a few times with
      // a short backoff before giving up. Bounded (≈1.4s worst case) so a genuine
      // persistent 404 still surfaces. Scoped to THIS post-push read only — never
      // ghGetFile itself (the pull/probe paths rely on 404 == absent).
      //
      // quick 260627-k7b: the SAME read-after-write lag also manifests on an
      // UPDATE push as a stale-but-200 read — the contents API briefly serves the
      // OLD bytes with a 200 right after a successful PUT. pushToRemote ALREADY
      // returned newSha, so (as with the 404 create case) the write SUCCEEDED; a
      // content-mismatch on an EARLY attempt is therefore transient lag, NOT a real
      // mismatch. Fold the content-match verify INTO this same bounded loop so a
      // stale-200 is retried with the same backoff/budget as the 404 — only a
      // mismatch that PERSISTS through all retries is a genuine mismatch (e.g. a
      // concurrent edit) and surfaces isPushVerifyMismatch. ONE loop, ONE
      // `attempt >= 3` cap governs both paths, so worst-case latency stays ≈1.4s.
      const pushedText = serializeCsv({ columns, rows: newRows }, { hasBOM, newline }, Papa);
      let remoteText, getSha;
      for (let attempt = 0; ; attempt++) {
        try {
          const g = await ghGetFile(this.githubCfg, filename);
          const remoteParsed = parseCsv(g.text, Papa);
          const headerMatches =
            Array.isArray(remoteParsed.columns) &&
            remoteParsed.columns.length === columns.length &&
            remoteParsed.columns.every((c, i) => c === columns[i]);
          if (
            g.text !== pushedText ||
            remoteParsed.rows.length !== newRows.length ||
            !headerMatches
          ) {
            // Content-mismatch: a stale-200 (read-after-write lag) on an early
            // attempt is transient — retry within the shared budget. Only after
            // the retries exhaust is it a genuine mismatch.
            if (attempt >= 3) {
              const e = new Error(
                `Saved to the shared database, but the read-back of ${filename} didn't match what was written — please re-check.`
              );
              e.isPushVerifyMismatch = true;
              throw e;
            }
            await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
            continue;
          }
          remoteText = g.text; getSha = g.sha;
          break;
        } catch (ge) {
          // A content-mismatch we just constructed must propagate as-is — it is
          // already the typed isPushVerifyMismatch, NOT a transient GET error.
          if (ge && ge.isPushVerifyMismatch) throw ge;
          const transient404 = ge && (ge.status === 404 || ge.name === 'GhAccessError');
          if (!transient404 || attempt >= 3) throw ge;
          await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
        }
      }

      // (5) SUCCESS (push + verify OK): write the new sha back into the cache,
      // keeping meta additive. Prefer the GET-back sha (authoritative — it
      // reflects the file as it now exists remotely) over the PUT-returned sha.
      const authoritativeSha = getSha || newSha;
      await putFile(
        filename,
        { columns, rows: newRows, hasBOM, newline, meta: { sha: authoritativeSha, fetchedAt: new Date().toISOString() } },
        { Papa, headerCheckFn }
      );
    } catch (e) {
      // (6) ANY remote failure (409 / network / 5xx / verify mismatch / name
      // missing): D-02 cache-revert to the PRE-EDIT record (last-known-remote
      // bytes+sha — NOT post-edit rows), then re-throw the typed error UNCHANGED
      // so Plan 03's banner can branch (GhConflictError vs network vs
      // isPushVerifyMismatch vs isPushNameMissing). NEVER catch a 409 and retry.
      // NO banner here (Plan 03 owns push-failure UX) — just revert + re-throw.
      if (preEditRecord && Array.isArray(preEditRecord.columns) && preEditRecord.columns.length > 0) {
        try {
          await putFile(
            filename,
            {
              columns: preEditRecord.columns,
              rows: preEditRecord.rows,
              hasBOM: preEditRecord.hasBOM,
              newline: preEditRecord.newline,
              // Keep meta additive — only thread it when the pre-edit record had it.
              ...(preEditRecord.meta !== undefined ? { meta: preEditRecord.meta } : {})
            },
            { Papa }
          );
        } catch (_revertErr) {
          // Best-effort cache-revert; putFile's own verify protects the snapshot.
        }
      }
      throw e;
    }
  },

  /**
   * _migrateOneFile — one file's worth of the migrateLiveSchema data-safety
   * chain (quick 260607-anu mechanics generalized in quick 260607-c65). The
   * caller does the readwrite-permission re-check ONCE; this runs steps 2–9 for
   * a single file:
   *   read raw text once → idempotency check (early-return {alreadyMigrated})
   *   → backup first → pure transform → one truncating whole-file rewrite
   *   (BOM iff original had one, detected newline) → round-trip verify
   *   → on verify failure set this.mergeRestoreOffer + THROW a tagged sentinel
   *   → write report only if transformFn returned a non-empty report
   *   → return a per-file result object.
   *
   * @param {object} opts
   * @param {string} opts.filename
   * @param {(cols:string[])=>boolean} opts.isMigratedFn
   * @param {(rows,cols)=>{newColumns,newRows,report?}} opts.transformFn
   * @returns {Promise<object>} per-file result for lastMigrationSummary.files
   */
  async _migrateOneFile({ filename, isMigratedFn, transformFn }) {
    // quick 260612-abt — migration now rewrites the STORE, not a disk file.
    // 2. Read the current record from the store (columns + rows + conventions).
    const current = await getFile(filename);
    const liveRows = (current && current.rows) || [];
    const liveColumns = (current && current.columns) || [];
    const hasBOM = !!(current && current.hasBOM);
    const newline = (current && current.newline) || '\r\n';

    // 3. IDEMPOTENCY — an already-migrated file is NEVER rewritten. Per-file
    //    independence lock: recipe_ingredients.csv (already migrated) returns here
    //    while ingredients.csv proceeds.
    if (isMigratedFn(liveColumns)) {
      return { filename, alreadyMigrated: true };
    }

    // 5. Pure transform (migrateRecipeIngredientsRows returns a report;
    //    migrateIngredientsRows does not — report is then undefined).
    const { newColumns, newRows, report } = transformFn(liveRows, liveColumns);

    // 6/7. Whole-record rewrite + round-trip verify via putFile (snapshot ->
    //      write -> re-read+re-parse+verify [row-count + header deep-equal +
    //      isMigratedFn gate] -> AUTOMATIC in-band revert on failure). On the
    //      thrown isRestoreOfferSentinel set the INFORMATIONAL mergeRestoreOffer
    //      (the migration was automatically rolled back) and re-throw.
    try {
      await putFile(
        filename,
        { columns: newColumns, rows: newRows, hasBOM, newline },
        { Papa, headerCheckFn: isMigratedFn }
      );
    } catch (e) {
      if (e && e.isRestoreOfferSentinel) {
        this.mergeRestoreOffer = { reason: e.message, filesWritten: [filename] };
      }
      throw e;
    }

    // 9. Per-file success result. The disk migration_report_<ts>.csv is no longer
    //    written (no folder in the store model); backfillCount still reports how
    //    many rows were left with an empty quantity_metric for the user.
    return {
      filename,
      migrated: true,
      rowCount: newRows.length,
      backfillCount: Array.isArray(report) ? report.length : 0
    };
  },

  // ----- Start fresh: clear the form but PRESERVE session state (D-17) -----
  /**
   * Clear the per-recipe state so the user can paste another recipe in the
   * same session. Preserves session-level state (csvStoreLoaded, csvHeaders,
   * ingredientMaster, maxRecipeIdAtSessionStart) so the NEXT Approve writes to
   * the SAME live store. Session ends only on browser refresh.
   */
  startFresh() {
    this.form = { header: null, rows: [] };
    this.rawText = '';
    this.parseError = '';
    this.approved = false;
    this.lastWriteSummary = null;
    // Plan 02-03 — clear the Valibot side-channels so a new parse starts
    // with no stale inline notes lingering from the previous recipe.
    this.validationWarnings = [];
    this.validationErrors = [];
    // Plan 02-04 — clear the token-coverage banner so a new parse starts
    // with no stale yellow banner lingering from the previous recipe.
    this.coverageWarning = null;
    // quick 260608-h1i — clear any lingering duplicate nudge on explicit Start
    // fresh. Do NOT clear this.duplicateIndex — the session/folder persists, so
    // the index stays valid across a Start-fresh.
    this.duplicateCandidates = [];
    this.duplicateDismissed = false;
    // quick 260618-ihr — clear the instruction-standardization review flags on
    // Start fresh (parse-only / ephemeral, same posture as the duplicate nudge).
    this.reviewFlags = [];
    this.reviewFlagsDismissed = false;
    // quick 260618-jr7 — clear the copyable error detail + copied flag on Start fresh.
    this.parseErrorDetail = '';
    this.errorCopied = false;
    // Plan 02-04 / API-07 — clear the pre-Parse estimate AND the post-Parse
    // actualUsage so a fresh paste starts with a clean slate. The estimate
    // will repopulate on the next textarea @blur; actualUsage repopulates
    // after the next successful Parse.
    this.tokenEstimate = null;
    this.actualUsage = null;
    // REVIEW-07 / Plan 03-03 — clear the click-to-source highlight state so
    // a fresh paste starts with no stale ribbon (matchedLineIndex would still
    // resolve to a span in the new paste but to the wrong line).
    this.matchedHighlightKey = null;
    this.matchedLineIndex = null;
    // REVIEW-09 / REVIEW-10 / Plan 03-04 — clear the in-flight slot and
    // Phase 3 state on the explicit Start-fresh path (D-44 clears on (a)
    // Approve success above, (b) explicit Start fresh here, and (c) restore-
    // prompt → "Start fresh" via dismissInflight). Also clear the restore
    // prompt + recipe_id state so the next paste starts clean.
    localStorage.removeItem(INFLIGHT_REVIEW_KEY);
    this.inflightRestorable = null;
    this.restorePromptOpen = false;
    this.recipeIdSuggestion = null;
    this.recipeIdRecomputeNotice = null;
    // Phase 5 / Plan 05-01 — close any open preview so a fresh paste starts
    // with no stale preview modal lingering.
    this.previewOpen = false;
    this.previewShowRows = false;
    // CR-01 — reset the parse state machine to IDLE so the next Parse is
    // permitted. startFresh() can be called from REVIEWING (user clicks
    // Start fresh after a parse but before Approve), APPROVED (after a
    // successful Approve), or ERROR (after a failed parse/approve). The
    // TRANSITIONS table does not have a single transition that covers all
    // three; a direct assignment is the documented "reset" escape hatch
    // (the state-machine pattern is reentrant per recipe, not per session).
    this.state = STATES.IDLE;
    // DO NOT touch: csvStoreLoaded, csvHeaders, ingredientMaster,
    // maxRecipeIdAtSessionStart, apiKey, parsing, approving, devMode.
    // Session continues.
  }
}));

// ===========================================================================
// quick 260610-dzs — SHARED EDITOR-HEADER MOUNT
// ===========================================================================
// Both editors (parse-view + recipe-manager) render the SAME recipe-HEADER field
// set, now authored ONCE in <template id="editor-header-fields"> (index.html).
// This function clones that template's content into each editor's mount slot.
//
// WHY this is subtle (the plan-checker blocker): each editor is itself a
// <template x-if> block. Content inside a <template> lives in its `.content`
// DocumentFragment and is INVISIBLE to document.querySelector* (which only walks
// the LIVE document). The header mount placeholder ([data-mount=editor-header-fields])
// sits INSIDE each editor's x-if .content — so a bare
// `document.querySelectorAll('[data-mount]')` would find ZERO slots, mount
// nothing, and the editors would render an empty header. We MUST reach into each
// editor x-if template's `.content` fragment.
//
// ORDERING: this runs AFTER Alpine.data('app', ...) (so the factory exists) but
// IMMEDIATELY BEFORE Alpine.start() (so Alpine has initialised NOTHING yet). We
// populate each editor's .content fragment with the header markup; when
// Alpine.start() later stamps an editor (its x-if turns true), Alpine clones the
// now-populated .content and binds every header directive in form.header scope —
// exactly as if the markup had been authored inline. Cloning AFTER Alpine.start()
// would be too late (Alpine has already cached/walked the editor templates).
//
// FAIL-LOUD: a missing header template, a wrong editor count, or a missing slot
// THROWS a clear Error. A silent zero-slot mount (an empty editor) is the exact
// bug we are preventing — make it a loud boot failure instead.
function mountSharedEditorTemplate() {
  const headerTpl = document.getElementById('editor-header-fields');
  if (!headerTpl) {
    throw new Error('mountSharedEditorTemplate: #editor-header-fields template not found');
  }

  // Locate the two editor x-if <template> elements by their data-editor
  // discriminator (parse + manager). A plain attribute on an x-if <template>
  // does not change Alpine's behaviour.
  const editors = document.querySelectorAll('template[data-editor]');
  if (editors.length !== 2) {
    throw new Error(
      'mountSharedEditorTemplate: expected exactly 2 editor templates (parse + manager), found ' + editors.length
    );
  }

  for (const editorTpl of editors) {
    // Reach INTO the editor x-if's .content fragment — the mount placeholder is
    // NOT in the live document at boot (it lives inside this inert fragment).
    const slot = editorTpl.content.querySelector('[data-mount="editor-header-fields"]');
    if (!slot) {
      throw new Error(
        'mountSharedEditorTemplate: no [data-mount=editor-header-fields] in editor ' +
          editorTpl.getAttribute('data-editor')
      );
    }
    // replaceWith() so the placeholder div itself is removed and the header
    // fields become DIRECT children of .header-form — matching the original
    // inline layout (appendChild would leave an empty wrapper div).
    slot.replaceWith(headerTpl.content.cloneNode(true));
  }
}

// MUST be called before Alpine.start() — see the ORDERING note above.
mountSharedEditorTemplate();

Alpine.start();
