// ============================================================================
// Mise — prompt-utils.js (PARSE-07 salted-XML defense)
// ----------------------------------------------------------------------------
// Pure helper module for Phase 2's prompt-injection defense. Zero external
// dependencies — loaded by app.js's ESM import block.
//
// Two exports:
//
//   generateSalt() — returns a 12-character lowercase hex string from 6
//     cryptographically-random bytes via crypto.getRandomValues. The salt
//     is the unpredictable boundary marker for the <recipe-text-${salt}>
//     scope: an injection payload pasted into a recipe body cannot know
//     the salt at generation time, so it cannot forge a matching close tag.
//     6 bytes = 2^48 = 281 trillion possibilities, which is more than
//     enough against the indirect-injection threat model (a generic
//     blog-post payload guessing the per-request salt by chance).
//     RESEARCH Pitfall N analyzed and accepted 12-hex as the right length:
//     long enough to be unguessable, short enough to never approach the
//     model's token-boundary attention quirks.
//
//   buildUserMessage(rawText, salt) — wraps the pasted recipe text in
//     <recipe-text-${salt}>...</recipe-text-${salt}> tags. Does NOT trim
//     or otherwise modify rawText — the salted scope's purpose is to
//     define a DATA region; modifying the content would silently change
//     what the LLM sees vs what the user pasted.
//
// Why this is its own module (not inline in app.js):
//   - Lets parse() be tested with a fixed salt by passing in a mocked
//     buildUserMessage.
//   - Keeps app.js's import block at L49-L54 stable (Pitfall I — the
//     new import lands BELOW the system-prompt.js import, preserving
//     the canonical Alpine ESM order).
//   - Documents the salt's role next to the function that creates it.
// ============================================================================

/**
 * Generate a 12-character lowercase hex string from 6 cryptographically-
 * random bytes. Used as the per-request salt for the salted-XML user-
 * message wrap. Each call returns an independent value.
 *
 * @returns {string} 12-character lowercase hex (e.g. "7f3a9c2d1234").
 */
export function generateSalt() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Wrap the user's recipe text in <recipe-text-${salt}>...</recipe-text-${salt}>
 * so the LLM (instructed via the system prompt's INPUT DATA SCOPE section)
 * treats the contents as DATA, not instructions. The salt is unpredictable
 * per-request so an injection payload inside `rawText` cannot forge a
 * matching close tag to escape the scope.
 *
 * rawText is passed through VERBATIM — no trimming, no normalization. The
 * raw_text contract in system-prompt.js depends on the LLM seeing exactly
 * what the user pasted.
 *
 * @param {string} rawText — the pasted recipe (any length, any content).
 * @param {string} salt — 12-hex from generateSalt().
 * @returns {string} the wrapped user message ready to pass as the user-
 *   turn content on the Messages call.
 */
export function buildUserMessage(rawText, salt) {
  return `<recipe-text-${salt}>\n${rawText}\n</recipe-text-${salt}>`;
}
