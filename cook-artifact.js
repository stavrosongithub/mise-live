// ============================================================================
// Mise — cook-artifact.js (Phase 6 / Plan 06-01)
// ----------------------------------------------------------------------------
// PURE, TOTAL, BROWSER-FREE logic for the day's cooking artifact (Phase 6).
//
// This module has ZERO imports — no Alpine, no PapaParse, no esm.sh, no DOM or
// browser globals — exactly like scale.js / schema.js / validate.js. That is
// what lets BOTH the browser (app.js) AND a Node test
// (scripts/cook-artifact.test.mjs) import it unchanged. Do NOT add a
// browser/CDN import here, reference `document`/`window`/`this`, or read app
// state — the Node test stops working and the purity contract breaks.
//
// It implements the two riskiest deterministic pieces the cooking artifact
// depends on, isolated so step-splitting bugs surface in a fast `node` test
// rather than in a generated kitchen sheet:
//
//   1. splitInstructionSteps(text)  — D-10 / D-16, grounded in
//      docs/recipe_import_spec.md §2 (numbered steps), §3 (Tip: lines),
//      §13 (section headings + per-section restart), §14 (worked example).
//   2. orderEntriesByType(entries)  — D-07, the main -> side -> salad -> other
//      dish bucket sort (case-insensitive substring on the free-text type).
// ============================================================================

// ----------------------------------------------------------------------------
// Line classifiers (spec-derived). All anchored at line start so an inline
// marker (e.g. "...for 1. minute") is NEVER a false step boundary (D-10).
// ----------------------------------------------------------------------------

// A STEP marker: one-or-more digits + dot + at least one space, at line start.
// `\d+` (not `\d`) so multi-digit markers `10.`, `11.` are recognised (D-10).
const STEP_RE = /^\s*(\d+)\.\s+(.*)$/;

// A TIP line (spec §3): advice, folded into the current step's tips[] — never
// its own wizard step. Case-insensitive `Tip:` prefix.
const TIP_RE = /^\s*Tip:\s*(.*)$/i;

// A SECTION HEADING (spec §13): "a short name followed by a colon, on its own
// line" (`Tofu:`, `Peanut sauce:`, `To finish:`, `Putting it together:`).
// Requirements that keep it from swallowing real steps: NO leading digit (a
// numbered line is ALWAYS a step regardless of a trailing colon), short
// (1..40 chars before the colon), and the colon ends the line (whole-line
// heading).
//
// IN-02: the heading BODY is restricted to the characters real spec §13
// headings actually use — letters, digits, spaces, and the joiners `&`/`-`/`'`
// (covers "Tofu", "Peanut sauce", "To finish", "Putting it together"). This
// EXCLUDES prose punctuation like `.`, `,`, `(`, `)`, `;`, `/` so a wrapped
// step CONTINUATION line that happens to end in a colon — e.g.
// `the sauce (note this):` or `reduce, then strain:` — is NOT misclassified as
// a new section heading (which would start a new group and orphan the steps
// that follow). A line failing this falls through to the CONTINUATION branch,
// which is the safe default per D-16 (never best-effort-split prose).
const HEADING_RE = /^\s*([A-Za-z0-9&'\- ]{1,40}):\s*$/;

/**
 * splitInstructionSteps(text) — D-10 / D-16 instruction parser.
 *
 * Splits a recipe's standardized `instructions_20` text into an array of
 * step-GROUPS. Each group is `{ heading: string|null, steps: [{ text, tips }] }`.
 * A recipe with no section headings yields ONE group with `heading: null`.
 * Per spec §13, numbering restarts at 1 per section — that falls out naturally
 * because a heading line starts a fresh group with its own step list, and
 * groups are never merged.
 *
 * Classification of each non-blank line (precedence as ordered here):
 *   - STEP_RE     -> a new step in the current group (text = after the marker)
 *   - TIP_RE      -> folded into the current step's tips[]; if no step exists
 *                    yet, held and attached to the NEXT step (orphan tip)
 *   - HEADING_RE  -> starts a NEW group (per-section restart, D-10/§13)
 *   - otherwise   -> a CONTINUATION of the current step's text (joined with a
 *                    single space). NEVER synthesised into a step — D-16
 *                    forbids best-effort-splitting free-form prose.
 *
 * D-16 signal: free-form prose with zero numbered lines yields zero TOTAL steps
 * (sum of group.steps.length) so the caller can fall back to Overview-only.
 * Empty/whitespace-only input likewise yields zero steps (the caller
 * distinguishes truly-blank via the raw value for the D-17 warning; the parser
 * need not).
 *
 * Splits on /\r\n|\r|\n/ so CRLF (Windows) and LF (Unix) both work.
 *
 * Pure: no DOM, no app state, does not mutate its argument.
 *
 * @param {string} text  the recipe's instructions_20 value (may be '' / nullish)
 * @returns {Array<{heading: string|null, steps: Array<{text: string, tips: string[]}>}>}
 */
export function splitInstructionSteps(text) {
  const src = typeof text === 'string' ? text : '';
  const lines = src.split(/\r\n|\r|\n/);

  // Groups accumulate here. We lazily create the first (heading:null) group
  // only when content arrives, so a heading-led recipe doesn't carry an empty
  // leading group, and an all-blank input yields [] (zero steps).
  const groups = [];
  let currentGroup = null; // the group steps/continuations append to
  let currentStep = null;  // the step tips/continuations append to
  let pendingTips = [];     // orphan Tip: lines awaiting the next step

  const ensureGroup = (heading) => {
    currentGroup = { heading: heading ?? null, steps: [] };
    groups.push(currentGroup);
    currentStep = null;
    // Note: pendingTips deliberately survive a group boundary so a Tip: that
    // precedes the first step of a new section still attaches to that step.
  };

  for (const rawLine of lines) {
    const line = rawLine;
    if (line.trim() === '') continue; // blank lines separate, carry no content

    const stepMatch = line.match(STEP_RE);
    if (stepMatch) {
      if (!currentGroup) ensureGroup(null);
      currentStep = { text: stepMatch[2].trim(), tips: [] };
      if (pendingTips.length) {
        currentStep.tips.push(...pendingTips);
        pendingTips = [];
      }
      currentGroup.steps.push(currentStep);
      continue;
    }

    const tipMatch = line.match(TIP_RE);
    if (tipMatch) {
      const tipText = tipMatch[1].trim();
      if (currentStep) currentStep.tips.push(tipText);
      else pendingTips.push(tipText); // hold for the next step (orphan tip)
      continue;
    }

    // Heading test runs AFTER step/tip so a numbered or Tip: line is never
    // misread as a heading. A heading has no leading digit by construction
    // (STEP_RE already consumed numbered lines).
    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) {
      ensureGroup(headingMatch[1].trim());
      continue;
    }

    // Continuation: append to the current step's text. If there is no current
    // step (prose before any numbered marker — the D-16 case), this line is
    // simply ignored as far as step COUNT goes: we do NOT synthesise a step.
    if (currentStep) {
      currentStep.text = `${currentStep.text} ${line.trim()}`.trim();
    }
    // else: no step to attach to and not a heading -> dropped from the step
    // model on purpose (D-16: never best-effort-split prose into steps).
  }

  return groups;
}

/**
 * countSteps(groups) — convenience accessor: total step count across all
 * groups = sum of group.steps.length. The caller uses `countSteps(...) === 0`
 * as the cheap D-16 "no numbered steps -> Overview-only fallback" signal.
 *
 * @param {Array<{steps: any[]}>} groups  output of splitInstructionSteps
 * @returns {number}
 */
export function countSteps(groups) {
  return (groups || []).reduce((sum, g) => sum + (g.steps ? g.steps.length : 0), 0);
}

// ----------------------------------------------------------------------------
// D-07 dish ordering: main -> side -> salad -> other (blank/unrecognised last).
// ----------------------------------------------------------------------------

/**
 * orderEntriesByType(entries) — D-07 dish bucket sort.
 *
 * Sorts meal-plan entries so dishes appear in cooking order: mains first, then
 * sides, then salads (made fresh, so last among recognised types), with any
 * blank/unrecognised type sorting to the very END, after salads.
 *
 * The type field is free-text (`"Main"`, `"Side"`, `"Dressed Salad"`, …), so
 * the mapping is CASE-INSENSITIVE SUBSTRING (per D-07):
 *   - contains 'salad' -> bucket 2 (after sides)
 *   - contains 'side'  -> bucket 1 (between main and salad)
 *   - any other non-empty value -> bucket 0 (the main bucket, first)
 *   - blank / whitespace-only -> bucket 3 (very end, after salads)
 *
 * 'salad' is tested before 'side' so a hypothetical "Side Salad" still sorts as
 * a salad. The sort is STABLE within a bucket (entries keep their input order)
 * — achieved by carrying the original index as the tie-break rather than
 * relying on Array.prototype.sort engine stability. Does NOT mutate its input
 * (returns a new array).
 *
 * Pure: no DOM, no app state.
 *
 * @param {Array<{type?: string}>} entries
 * @returns {Array} a NEW array of the same entries in D-07 order
 */
export function orderEntriesByType(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const bucketOf = (entry) => {
    const t = ((entry && entry.type) || '').toLowerCase().trim();
    if (t === '') return 3;            // blank / unrecognised -> very end
    if (t.includes('salad')) return 2; // salads last among recognised
    if (t.includes('side')) return 1;  // sides between main and salad
    return 0;                          // any other non-empty -> main bucket
  };
  // Decorate with original index so the tie-break is explicit and stable,
  // then sort by (bucket, index), then strip the decoration.
  return list
    .map((entry, index) => ({ entry, index, bucket: bucketOf(entry) }))
    .sort((a, b) => (a.bucket - b.bucket) || (a.index - b.index))
    .map((d) => d.entry);
}
