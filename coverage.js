// ============================================================================
// Mise — token-coverage check (Phase 2 / PARSE-04 / D-23)
// ----------------------------------------------------------------------------
// Pure tokenizer + drop detector + row-attribution heuristic. Called from
// parse() during STATES.VALIDATING (the same state slot Plan 02-03's
// validateRecipe occupies — coverage runs AFTER validate so it reads the
// CORRECTED row set, not the LLM's raw parsed.rows).
//
// Returns shouldWarn (boolean) + dropped-token lists + affected-row indices.
// D-23 makes the resulting banner NON-BLOCKING; Approve is never gated by
// coverage. The auto-flag flag_fix_me=true on affected rows persists past
// the banner's Dismiss so downstream review still sees the warning.
//
// This module is OFFLINE-PURE:
//   - Zero external dependencies (no Alpine, no Anthropic SDK, no Valibot).
//   - No module-level mutations, no Date.now / Math.random.
//   - Receives the source text + post-validate rows; returns a new object.
//
// Threshold (locked by ROADMAP success criterion 6):
//   shouldWarn = droppedWords.length > 5 || droppedNumbers.length > 0
//   — i.e. ANY number dropped, OR more than five content words dropped.
//
// Row attribution heuristic (RESEARCH §J lines 1085-1098):
//   A row is "affected" iff its raw_text length is < 50% of the longest
//   row's raw_text length. Best-effort; D-23 accepts "no row clearly
//   attributable" as a valid state.
//
// ASCII-only tokenizer note: WORD_RE accepts the false-positive rate on
// Unicode accent characters (RESEARCH §J line 1110). The banner is
// non-blocking so a false positive is mildly annoying, never error-state.
// Upgrade to /\p{Letter}+/u is a Phase 3 polish if real-recipe false
// positives spike.
// ============================================================================

// Letters with optional apostrophe contractions ("don't", "it's"). Global flag
// so .match() returns every occurrence, not just the first.
const WORD_RE = /[A-Za-z]+(?:'[A-Za-z]+)?/g;

// Integers and decimals with comma OR dot fraction separator. Captures 1, 1.5,
// 200, 500 (and the European "1,5" form some recipes use).
const NUMBER_RE = /\d+(?:[.,]\d+)?/g;

// 24 common English articles/prepositions/auxiliaries (RESEARCH §J line 1034).
// Filtered OUT of droppedWords because their absence in raw_text is
// uninformative — every recipe drops "the", "of", "and".
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'for', 'in', 'on', 'to', 'with',
  'at', 'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'this', 'that', 'these', 'those'
]);

/**
 * Lower-case `text` and extract its words + numbers + the union of both.
 * Returns an object with three arrays. `.match()` returns null when there
 * are no matches; the `|| []` guard normalizes to an empty array.
 *
 * @param {string} text
 * @returns {{ words: string[], numbers: string[], all: string[] }}
 */
function tokenize(text) {
  if (!text) return { words: [], numbers: [], all: [] };
  const lower = text.toLowerCase();
  const words = lower.match(WORD_RE) || [];
  const numbers = lower.match(NUMBER_RE) || [];
  return { words, numbers, all: [...words, ...numbers] };
}

/**
 * Predicate: is this token "content" — i.e. worth counting toward the drop
 * threshold? Numbers always count (a number absence is a recipe quantity
 * loss). Stopwords don't count. Tokens shorter than 3 characters don't
 * count (matches "g", "ml" — likely the unit token, not a content word).
 *
 * @param {string} token
 * @returns {boolean}
 */
function isContentToken(token) {
  if (/^\d/.test(token)) return true;        // numbers always content
  if (STOPWORDS.has(token)) return false;    // stopwords filtered
  if (token.length < 3) return false;        // 1-2 char tokens filtered (units)
  return true;
}

/**
 * Compute the dropped-content set: source tokens (lower-cased) that do NOT
 * appear in the concatenated raw_text of any row. Set.has gives O(1) lookup
 * for the difference computation — meaningful even for 30-row recipes if a
 * user pastes a long preamble.
 *
 * The function does NOT mutate its arguments. It does NOT throw on empty
 * rows (longest === 0 yields no affected indices). It does NOT depend on
 * any external module (no Alpine, no SDK, no validators).
 *
 * @param {string} sourceText — the user's pasted recipe (whole text).
 * @param {Array<{ raw_text?: string }>} rows — the corrected form.rows
 *   AFTER Plan 02-03's validateRecipe ran.
 * @returns {{
 *   droppedWords: string[],       // content words in src, missing from emitted
 *   droppedNumbers: string[],     // numbers in src, missing from emitted (any => warn)
 *   affectedRowIndices: number[], // 0-based row indices flagged for review
 *   shouldWarn: boolean           // > 5 words OR any number dropped
 * }}
 */
export function checkCoverage(sourceText, rows) {
  // Tokenize source. The union "srcContent" is the SET of tokens we expect
  // to see preserved somewhere in the emitted rows' raw_text. Filter words
  // through isContentToken; numbers are added verbatim (always content).
  const srcTok = tokenize(sourceText);
  const srcContent = new Set([
    ...srcTok.words.filter(isContentToken),
    ...srcTok.numbers
  ]);

  // Collect every token (word + number) from every row's raw_text into one
  // big set for O(1) "did the LLM keep this?" lookup. Lower-cased via tokenize.
  const emittedAll = new Set();
  for (const r of rows) {
    const t = tokenize(r.raw_text || '');
    for (const w of t.words) emittedAll.add(w);
    for (const n of t.numbers) emittedAll.add(n);
  }

  // Set difference: items in src but not in emitted. Iterate via for-of and
  // push to a flat array — Set.has is O(1), Array.includes would be O(N).
  const dropped = [];
  for (const tok of srcContent) {
    if (!emittedAll.has(tok)) dropped.push(tok);
  }

  // Split the drop list into the two reported categories. Numbers start
  // with a digit; words don't.
  const droppedWords = dropped.filter(t => !/^\d/.test(t));
  const droppedNumbers = dropped.filter(t => /^\d/.test(t));

  // Row-attribution heuristic per RESEARCH §J lines 1091-1097. Find the
  // longest row's raw_text length; any row shorter than 50% of that is
  // suspicious (probably truncated by the LLM). Empty rows → longest=0 →
  // (length < 0) never true → empty affectedRowIndices.
  const longest = Math.max(0, ...rows.map(r => (r.raw_text || '').length));
  const affectedRowIndices = [];
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i].raw_text || '').length < longest * 0.5) {
      affectedRowIndices.push(i);
    }
  }

  // Locked thresholds per ROADMAP success criterion 6. > 5 (strictly greater
  // than five) means six or more words. Any number dropped is its own
  // sufficient reason to warn — number drops are quantity-data loss.
  const shouldWarn = droppedWords.length > 5 || droppedNumbers.length > 0;

  return { droppedWords, droppedNumbers, affectedRowIndices, shouldWarn };
}
