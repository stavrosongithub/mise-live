// ============================================================================
// Mise — scale.js (quick 260611-enp / Task 1 / T-enp-01)
// ----------------------------------------------------------------------------
// PURE, TOTAL, BROWSER-FREE deterministic scaling for the meal-plan view.
//
// This module has ZERO imports — no Alpine, no PapaParse, no esm.sh, no DOM or
// browser globals — exactly like schema.js / validate.js / count.js are plain
// importable modules. That is what lets BOTH the browser (app.js) AND a Node
// test (scripts/scale.test.mjs) import it unchanged. Do NOT add a browser/CDN
// import here or the Node test stops working.
//
// DOMAIN (grounding D-07): every recipe in the project is pre-normalized to a
// FIXED 20 servings. quantity_metric (g/ml) is ALWAYS populated at 20 servings;
// quantity_volumetric + unit_volumetric (whole / tsp / tbsp / cup) are OPTIONAL.
// To scale a recipe to N target servings we multiply every quantity by
// factor = N / 20.
//
// ----------------------------------------------------------------------------
// THE null-factor CONVENTION (pin it, reuse it everywhere):
//   factor() returns `null` when no usable scaling factor exists (blank / 0 /
//   negative / non-finite servings). A null factor means "NO SCALING POSSIBLE".
//   EVERY scale function treats a null factor as PASSTHROUGH — it returns the
//   ORIGINAL value untouched and NEVER emits NaN. This is the core safety
//   invariant (T-enp-01): a blank/0/negative servings input must surface a
//   "set a servings number" hint in the UI, never a row full of NaN amounts.
// ----------------------------------------------------------------------------
// ============================================================================

// ============================================================================
// quick 260612-dr4 — Phase A NONLINEAR scaling: per-category "scaling strength".
// ----------------------------------------------------------------------------
// Linear scaling over-scales seasonings/leavening and under-respects fixed
// items (a single bay leaf should not become five). A per-category STRENGTH in
// [0,1] interpolates between "scales fully" (1) and "never scales" (0):
//   effectiveFactor = 1 + (factor - 1) * strength
// strength 1 degrades EXACTLY to today's linear factor; strength 0 pins the
// quantity at its base regardless of servings. classifyIngredientCategory()
// infers the category HEURISTICALLY from role/name/unit (Phase A). Phase B
// (OUT OF SCOPE here) replaces these heuristics with an explicit, persisted
// per-ingredient tag + schema column — see DECISIONS.md.
//
// The keyword arrays below are NAMED module-scope constants so the heuristics
// stay easy to tune. All matching is case-insensitive (substring on a
// lowercased name). Precedence is locked in classifyIngredientCategory().
// ============================================================================

// Phase A heuristic — Phase B replaces with an explicit per-ingredient tag.
// Items whose quantity should NOT scale with servings (a recipe needs ~1 bay
// leaf / a splash of vanilla whether it serves 6 or 60).
const FIXED_NAME_KEYWORDS = ['bay leaf', 'bay leaves', 'vanilla extract', 'vanilla essence'];

// Phase A heuristic — Phase B replaces with an explicit per-ingredient tag.
// Chemical/biological leaveners — scaling these linearly ruins texture.
const LEAVENING_NAME_KEYWORDS = ['baking powder', 'baking soda', 'bicarbonate of soda', 'yeast', 'cream of tartar'];

// Phase A heuristic — Phase B replaces with an explicit per-ingredient tag.
// Seasonings/spices/acids — over-scale linearly and the dish becomes inedible.
const SEASONING_NAME_KEYWORDS = [
  'salt', 'pepper', 'cumin', 'paprika', 'chilli', 'chili', 'cinnamon', 'nutmeg',
  'oregano', 'thyme', 'basil', 'curry', 'cayenne', 'ground ginger',
  'garlic powder', 'garlic granules', 'onion powder', 'mixed spice', 'vinegar',
  'lemon juice', 'lime juice'
];

// Phase A heuristic — Phase B replaces with an explicit per-ingredient tag.
// Liquids — scale linearly (strength 1 by default) but worth classifying so the
// default strength is editable per-category in Settings.
const LIQUID_NAME_KEYWORDS = ['stock', 'broth', 'water', 'milk', 'cream', 'juice', 'wine'];

// ============================================================================
// quick 260612-esy — Phase B: persisted EDITABLE per-ingredient scale_category.
// ----------------------------------------------------------------------------
// SCALE_CATEGORIES is the SINGLE SOURCE OF TRUTH for the five locked scaling
// categories (matches the five branches of classifyIngredientCategory's
// heuristic + the strength keys in DECISIONS.md). Object.freeze so a caller
// cannot mutate the shared contract. isValidScaleCategory mirrors merge.js's
// isShoppingUnitValue (enum-membership single source of truth) and is used as a
// defense-in-depth clamp at master-load, on write, and at classify-time.
// ============================================================================
export const SCALE_CATEGORIES = Object.freeze(['standard', 'liquid', 'seasoning', 'leavening', 'fixed']);

/**
 * isValidScaleCategory(v) — true iff `v` is a string whose trimmed, lowercased
 * form is a member of SCALE_CATEGORIES. Non-strings (null/undefined/number)
 * return false. Blank ('' / whitespace) returns false — blank means "no stored
 * tag, fall through to the heuristic".
 *
 * @param {*} v
 * @returns {boolean}
 */
export function isValidScaleCategory(v) {
  if (typeof v !== 'string') return false;
  return SCALE_CATEGORIES.includes(v.trim().toLowerCase());
}

/**
 * classifyIngredientCategory(row) — infer a scaling category from role/name/unit
 * (Phase A heuristic). FIRST match wins; matching is case-insensitive.
 *
 * Precedence (locked):
 *   0. (Phase B) row.scale_category is a VALID stored tag -> the trimmed,
 *      lowercased stored tag (the persisted user-corrected category WINS over the
 *      heuristic). A blank/missing/invalid scale_category falls through to the
 *      Phase A heuristic below BYTE-FOR-BYTE — Phase A behavior is preserved.
 *   1. row.role === 'to_taste'                -> 'fixed'
 *   2. name matches FIXED_NAME_KEYWORDS       -> 'fixed'
 *   3. name matches LEAVENING_NAME_KEYWORDS   -> 'leavening'
 *   4. name matches SEASONING_NAME_KEYWORDS   -> 'seasoning'
 *   5. unit_metric === 'ml' OR name matches LIQUID_NAME_KEYWORDS -> 'liquid'
 *   6. else                                   -> 'standard'
 *
 * @param {{ ingredient_name?: any, role?: any, unit_metric?: any, scale_category?: any }} row
 * @returns {'fixed'|'leavening'|'seasoning'|'liquid'|'standard'}
 */
export function classifyIngredientCategory(row) {
  // 0. (Phase B) a valid persisted scale_category WINS over the heuristic.
  if (row && isValidScaleCategory(row.scale_category)) {
    return row.scale_category.trim().toLowerCase();
  }

  // 1. role to_taste beats everything (a "to taste" item never scales).
  if (row && row.role === 'to_taste') return 'fixed';

  // Lowercase the name ONCE; guard null/undefined.
  const name = (row && typeof row.ingredient_name === 'string') ? row.ingredient_name.toLowerCase() : '';

  // 2-4. name-keyword categories, in precedence order.
  if (FIXED_NAME_KEYWORDS.some(k => name.includes(k))) return 'fixed';
  if (LEAVENING_NAME_KEYWORDS.some(k => name.includes(k))) return 'leavening';
  if (SEASONING_NAME_KEYWORDS.some(k => name.includes(k))) return 'seasoning';

  // 5. liquid via unit_metric === 'ml' OR a liquid name keyword.
  if ((row && row.unit_metric === 'ml') || LIQUID_NAME_KEYWORDS.some(k => name.includes(k))) return 'liquid';

  // 6. default.
  return 'standard';
}

/**
 * effectiveFactor(factor, strength) — interpolate the linear factor by strength.
 *   ef = 1 + (factor - 1) * strength
 * strength 1 -> ef === factor (linear); strength 0 -> ef === 1 (never scales).
 * Preserves the null-factor passthrough convention: a null factor stays null
 * (no scaling possible -> NaN never produced downstream).
 *
 * @param {number|null} factor
 * @param {number} strength  expected finite in [0,1] (caller clamps)
 * @returns {number|null}
 */
export function effectiveFactor(factor, strength) {
  if (factor === null) return null;
  return 1 + (factor - 1) * strength;
}

/**
 * factor(targetServings) — the multiplier to scale a fixed-20-servings recipe
 * to `targetServings`. Returns targetServings / 20 ONLY when targetServings is
 * a finite number strictly greater than 0. For blank ('' / null / undefined),
 * 0, negative, or NaN it returns `null` (the no-scaling-possible sentinel —
 * see the convention above). Never returns NaN.
 *
 * @param {number|string|null|undefined} targetServings
 * @returns {number|null}
 */
export function factor(targetServings) {
  // Number('') === 0, Number(null) === 0, Number(undefined) === NaN — coerce
  // then gate on finite-and-positive so all the no-scaling cases collapse to null.
  const n = Number(targetServings);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n / 20;
}

/**
 * scaleMetric(quantity_metric, factor) — scale a metric (g/ml) quantity.
 *
 * Passthrough rules (return the input UNCHANGED, never NaN):
 *   - quantity_metric is 0, null, or '' -> return it as-is (0 or null or '').
 *   - factor is null (no-scaling) -> return the original quantity_metric.
 *
 * Otherwise raw = Number(quantity_metric) * factor, then ROUND with sensible
 * precision:
 *   - raw >= 10  -> Math.round to the nearest whole number.
 *   - 0 < raw < 10 -> round to ONE decimal via Math.round(raw * 10) / 10.
 *
 * CLAMP (the floor branch): if the input quantity was POSITIVE but one-decimal
 * rounding produced 0 (i.e. raw was below 0.05, so Math.round(raw*10)/10 === 0),
 * clamp the result UP to 0.1 — a real ingredient never rounds away to nothing.
 * The clamp fires ONLY when rounding would yield exactly 0; a raw of 0.06 rounds
 * to 0.1 NATURALLY (Math.round(0.6)/10 = 0.1) and never touches the clamp.
 *
 * @param {number|string|null} quantity_metric
 * @param {number|null} factor
 * @returns {number|string|null}
 */
export function scaleMetric(quantity_metric, factor) {
  // Passthrough: 0 / null / '' (note: 0 is a legitimate stored value, keep it).
  if (quantity_metric === 0 || quantity_metric === null || quantity_metric === '') {
    return quantity_metric;
  }
  // Passthrough: null factor = no scaling possible.
  if (factor === null) return quantity_metric;

  const raw = Number(quantity_metric) * factor;

  if (raw >= 10) {
    return Math.round(raw);
  }
  // 0 < raw < 10 (and the >= 10 branch handled): round to one decimal.
  let rounded = Math.round(raw * 10) / 10;
  // CLAMP: a positive input that rounds to 0 is floored UP to 0.1.
  if (rounded === 0 && raw > 0) {
    rounded = 0.1;
  }
  return rounded;
}

/**
 * scaleVolumetric(quantity_volumetric, unit_volumetric, factor) — scale the
 * OPTIONAL volumetric quantity, rounded by unit family.
 *
 * Passthrough rules:
 *   - quantity_volumetric is null or '' -> return null (no volumetric value).
 *   - factor is null (no-scaling) -> return the original quantity_volumetric.
 *
 * Otherwise raw = Number(quantity_volumetric) * factor, then round by unit:
 *   - 'whole' -> Math.round(raw); and if raw > 0, FLOOR the result at a minimum
 *     of 1 (a halved "2 eggs" becomes 1, never 0 — you still need an egg).
 *   - 'tsp' / 'tbsp' / 'cup' -> nearest 0.25 via Math.round(raw * 4) / 4.
 *   - any other / unknown unit -> the nearest-0.25 fallback (a measuring-spoon
 *     granularity is the safer default for an unrecognized volumetric unit than
 *     whole-number rounding, which could erase a fractional measure).
 *
 * Derived from the SAME `factor` argument as scaleMetric — NEVER re-derived from
 * the metric value (the two are independent measures of the same ingredient).
 *
 * @param {number|string|null} quantity_volumetric
 * @param {string|null} unit_volumetric
 * @param {number|null} factor
 * @returns {number|null}
 */
export function scaleVolumetric(quantity_volumetric, unit_volumetric, factor) {
  // Passthrough: no volumetric value present.
  if (quantity_volumetric === null || quantity_volumetric === '') return null;
  // Passthrough: null factor = no scaling possible (return the original value).
  if (factor === null) return quantity_volumetric;

  const raw = Number(quantity_volumetric) * factor;

  if (unit_volumetric === 'whole') {
    const r = Math.round(raw);
    // min-1 floor: a positive raw never collapses to 0 whole units.
    return raw > 0 ? Math.max(1, r) : r;
  }
  // tsp / tbsp / cup AND the unknown-unit fallback: nearest 0.25.
  return Math.round(raw * 4) / 4;
}

/**
 * scaleRow(row, factor, strengthByCategory?) — return a NEW object spreading
 * `row` plus the two derived scaled fields. PURE — does not mutate the input.
 *
 * The 3rd `strengthByCategory` arg is OPTIONAL and ADDITIVE (quick 260612-dr4):
 *   - OMITTED / undefined => EXACTLY today's behavior. Pass `factor` straight
 *     through to scaleMetric/scaleVolumetric and add NO new keys, so existing
 *     callers + the backward-compat test stay byte-identical.
 *   - PROVIDED => classify the row's category, look up its strength (default 1
 *     when the category is missing from the map), compute the effective factor,
 *     and pass THAT (not `factor`) to scaleMetric/scaleVolumetric. Also spread in
 *     scale_category + scale_strength so the meal-plan UI can label/flag the row.
 *
 * scaleMetric/scaleVolumetric (and their rounding) are UNTOUCHED — interpolation
 * happens BEFORE them, so the metric 0.1 clamp + whole min-1 floor still apply to
 * the post-interpolation value.
 *
 * @param {{ quantity_metric?: any, quantity_volumetric?: any, unit_volumetric?: any }} row
 * @param {number|null} factor
 * @param {Record<string, number>=} strengthByCategory  lowercase-keyed [0,1] map
 * @returns {object}
 */
export function scaleRow(row, factor, strengthByCategory) {
  // Backward-compat path: no strength map -> today's linear behavior, no new keys.
  if (strengthByCategory === undefined) {
    return {
      ...row,
      scaled_quantity_metric: scaleMetric(row.quantity_metric, factor),
      scaled_quantity_volumetric: scaleVolumetric(row.quantity_volumetric, row.unit_volumetric, factor)
    };
  }

  // Nonlinear path: classify -> strength (default 1) -> effective factor.
  const cat = classifyIngredientCategory(row);
  const strength = (typeof strengthByCategory[cat] === 'number') ? strengthByCategory[cat] : 1;
  const ef = effectiveFactor(factor, strength);
  return {
    ...row,
    scaled_quantity_metric: scaleMetric(row.quantity_metric, ef),
    scaled_quantity_volumetric: scaleVolumetric(row.quantity_volumetric, row.unit_volumetric, ef),
    scale_category: cat,
    scale_strength: strength
  };
}
