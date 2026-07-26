// ============================================================================
// Mise — chat-turns.js (Phase 27 / plan 27-09)
// ----------------------------------------------------------------------------
// PURE, TOTAL, BROWSER-FREE derivations over a chat transcript.
//
// These three functions are the transcript's own consistency rules — which
// proposal may still be applied, what the outgoing `messages` array looks like,
// and what a "Try again" control is allowed to do. They were lifted OUT of
// app.js because all three shipped defects (CR-01, CR-02, WR-01) lived in logic
// that only a browser could reach, and all three are STATE TRANSITIONS rather
// than states:
//
//   CR-02  apply the NEWEST proposal, then look at an OLDER one
//   CR-01  fail a turn, then send a DIFFERENT message (not a retry)
//   WR-01  click an OLD error's control AFTER a later turn succeeded
//
// A static grep cannot see a transition and a one-proposal / happy-path browser
// seed structurally cannot reach one. Out here they are ordinary node
// assertions — see scripts/chat-turns.test.mjs, which was first run against a
// verbatim transcription of the pre-fix app.js logic (commit 5660f5d) so every
// case is proven to distinguish before from after.
//
// ----------------------------------------------------------------------------
// THIS MODULE MUST NEVER GROW AN IMPORT.
//
// ZERO imports, no state of any kind, no DOM, no `window`/`document`, no
// `fetch`, no `localStorage`, no Alpine, no `this`. Every function is a total
// function of its arguments: degenerate input (null, a non-array, holes) returns
// the empty answer rather than throwing, because these run inside Alpine getters
// and render bindings where a throw is a blank pane. `chat-turns.js` ships to
// the live site automatically — scripts/deploy-to-live.sh globs root-level
// `*.js` — so nothing here may assume a bundler or a browser global.
//
// TURN SHAPE (app.js pushes it in four places):
//   { id: number, role: 'you'|'claude'|'error'|'applied', text: string,
//     proposal: {ops, diff, error, applied, reverted} | null,
//     unanswered?: true }        // `you` turns only; set by sendChatMessage's catch
// Ids come from a monotonic counter, so a larger id is unambiguously a later
// turn — several rules below lean on that.
// ============================================================================

/**
 * liveProposalTurnId(turns) — the id of the ONE proposal that may still be
 * applied, or `null` when there is none.
 *
 * THE RULE (SPEC req 10b): only the NEWEST proposal-bearing turn may be live. If
 * that proposal is applied there is NO live Apply anywhere. Every older proposal
 * is PERMANENTLY superseded — it stays visible as read-only transcript with its
 * diff intact (UI state 11), but its Apply never comes back.
 *
 * CR-02 — WHAT THIS REPLACES. The shipped getter returned the newest turn whose
 * proposal was not *currently applied*:
 *
 *     if (t && t.proposal && !t.proposal.applied) return t.id;   // WRONG
 *
 * so applying the newest proposal made the loop walk straight PAST it and hand
 * the live Apply back to an older, abandoned one. `applyChatProposal`'s guard
 * reads the same expression, so it concurred; the older proposal's row address
 * still resolved, so whole-proposal rejection never fired; and pressing its
 * re-rendered Apply silently wrote a value the operator had walked away from.
 * Reproduced live: 650 -> apply P2 -> 222 -> invoke P1 -> 111, with this
 * derivation going 16 (P2) -> 14 (P1). With three proposals it cascaded.
 *
 * UI state 15 still works: Undo sets `applied = false` on the newest proposal,
 * and it becomes live again on the very next read.
 *
 * A newest proposal carrying an `error` still OWNS the slot and returns its own
 * id. Deciding `refused` is `chatProposalState`'s job (it tests `p.error` first)
 * — doing it here as well would be two enforcement points for one rule, which is
 * how they drift, and is half of why CR-02 existed.
 *
 * @param {Array<object>} turns  the transcript, oldest first
 * @returns {number|null}
 */
export function liveProposalTurnId(turns) {
  const list = Array.isArray(turns) ? turns : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const t = list[i];
    // The FIRST proposal-bearing turn found walking backwards is the newest one,
    // and it is the only candidate there will ever be. Applied => nobody is live.
    if (t && t.proposal) return t.proposal.applied ? null : t.id;
  }
  return null;
}

/**
 * buildChatMessages(turns, wrap) — the Anthropic Messages `messages` array for a
 * send, built from the transcript.
 *
 * THE RULE: an unanswered question is never re-sent, and the result always
 * alternates strictly — beginning with `user` and ending with `user`.
 *
 * CR-01 — WHY. The shipped loop mapped `you` -> user and `claude` -> assistant
 * and skipped `error` turns, so a FAILED turn left an unanswered `you` with no
 * reply behind it. The moment the operator typed a NEW message instead of
 * pressing Try again, the payload carried two consecutive `user` messages; the
 * Messages API rejects those with a 400 ("roles must alternate"), and
 * `mapToPlainLanguage`'s 400 branch renders it as "There's a bug in the schema
 * our tool sent. (Tell the dev.)" — actively misleading, since the schema is
 * fine. Every later send in the session then failed identically, and the only
 * escape was closing the modal. Note that `retryLastChatMessage` DID recover the
 * single-failure case; the break was in the message-building, which is why the
 * fix is here and not in retry.
 *
 * Re-sending an unanswered question as conversational context is also simply
 * wrong on its own terms — Claude never saw it, and answering it now would
 * answer a question the operator has already replaced.
 *
 * THREE LAYERS, in this order:
 *   1. `unanswered` turns and `error` / `applied` turns are dropped. (`applied`
 *      is the D-14 transcript separator; the fact that changes were applied
 *      reaches the model through the note folded into the newest user message,
 *      not as a turn of its own.)
 *   2. BELT AND BRACES — adjacent same-role messages collapse, keeping the LATER
 *      one (the newer question, the newer reply). This holds even if a future
 *      path forgets to set the marker, so the 400 cannot come back by omission.
 *   3. Leading assistant messages and trailing assistant messages are trimmed.
 *      Leading, because a conversation cannot open on an assistant turn.
 *      Trailing, because `sendChatMessage` rewrites `messages[length - 1]` to
 *      fold in the D-14 applied note — that slot MUST be the operator's newest
 *      question, or the note would rewrite Claude's own words into a user
 *      message. In practice the caller always pushes the new `you` turn before
 *      assembling, so the trim is a guarantee rather than a behaviour change.
 *
 * `wrap` is INJECTED rather than built here: it carries the per-request salt for
 * the `<operator-message-{salt}>` boundary, which is request state and must not
 * leak into a pure module. It is called exactly once per EMITTED user message
 * (never for a dropped one) and its return value is used verbatim.
 *
 * Neither the array nor any turn object is mutated.
 *
 * @param {Array<object>} turns  the transcript, oldest first
 * @param {(text: string) => string} wrap  the salted user-content wrapper
 * @returns {Array<{role: 'user'|'assistant', content: string}>}
 */
export function buildChatMessages(turns, wrap) {
  const list = Array.isArray(turns) ? turns : [];
  const wrapFn = typeof wrap === 'function' ? wrap : (t) => String(t ?? '');

  // Collect ROLES AND RAW TEXT first, wrapping only at the end — so `wrap` is
  // never called for a message that the collapse or the trim then discards.
  const picked = [];
  const push = (role, text) => {
    const last = picked.length > 0 ? picked[picked.length - 1] : null;
    // Same role as the previous entry => the later one replaces it.
    if (last && last.role === role) { last.text = text; return; }
    picked.push({ role, text });
  };

  for (const turn of list) {
    if (!turn) continue;
    if (turn.role === 'you') {
      // CR-01 — an unanswered question is never re-sent.
      if (turn.unanswered === true) continue;
      push('user', String(turn.text ?? ''));
    } else if (turn.role === 'claude') {
      push('assistant', String(turn.text ?? ''));
    }
    // `error` and `applied` turns are deliberately not part of the conversation.
  }

  while (picked.length > 0 && picked[0].role !== 'user') picked.shift();
  while (picked.length > 0 && picked[picked.length - 1].role !== 'user') picked.pop();

  return picked.map((m) => (m.role === 'user'
    ? { role: 'user', content: wrapFn(m.text) }
    : { role: 'assistant', content: m.text }));
}

/**
 * planRetry(turns, errorTurnId) — what a "Try again" click on ONE error turn is
 * allowed to do. Returns `{ok: false}` or `{ok: true, text, turns}`, where
 * `text` goes back into the composer and `turns` is the transcript to keep.
 * Decides only; changes nothing.
 *
 * THE RULE: only the newest error turn may retry, and it retries the `you` turn
 * that immediately precedes it.
 *
 * WR-01 — WHY. The button renders on EVERY error turn, but the shipped handler
 * took no turn id: it popped the trailing error run and spliced the LAST `you`
 * turn in the whole transcript. So with `[you1, error1, you2, claude2]`,
 * clicking error1's Try again re-sent `you2` — the message that had already
 * SUCCEEDED — and left `claude2`'s reply sitting above the question it answered,
 * with the payload presenting claude2 as the answer to you1. A per-turn control
 * must receive the turn it belongs to.
 *
 * "Newest" means: part of the TRAILING run of error turns. Anything earlier has
 * been overtaken by a turn that worked, and retrying it would reorder the
 * transcript. Every card inside that trailing run plans the SAME retry, so it
 * does not matter which one the operator clicks.
 *
 * SURVIVORS ARE PASSED THROUGH BY REFERENCE — never cloned. The live `proposal`
 * objects hang off those identities (Apply and Undo mutate `proposal.applied` /
 * `proposal.reverted` in place, and the undo stack addresses turns by id), and
 * Alpine's reactivity is attached to the objects themselves. Cloning would
 * silently detach both.
 *
 * `app.js` reads this in TWO places — `retryLastChatMessage` (the click) and
 * `chatCanRetry` (the markup's `x-show`) — so the button cannot be offered where
 * the handler would refuse.
 *
 * @param {Array<object>} turns  the transcript, oldest first
 * @param {number} errorTurnId   the id of the clicked `error` turn
 * @returns {{ok: false} | {ok: true, text: string, turns: Array<object>}}
 */
export function planRetry(turns, errorTurnId) {
  const list = Array.isArray(turns) ? turns : [];

  const i = list.findIndex((t) => t && t.id === errorTurnId);
  if (i === -1) return { ok: false };
  if (list[i].role !== 'error') return { ok: false };

  // Where the TRAILING run of error turns begins. Everything from `start` to the
  // end is an error turn; anything before it has been overtaken.
  let start = list.length;
  while (start > 0 && list[start - 1] && list[start - 1].role === 'error') start--;
  if (i < start) return { ok: false };

  // The question this run failed on: the newest `you` turn before the run.
  let j = start - 1;
  while (j >= 0 && !(list[j] && list[j].role === 'you')) j--;
  if (j < 0) return { ok: false };

  const text = String(list[j].text ?? '');
  // Keep everything before the trailing error run except the failed question,
  // which is lifted back into the composer. BY REFERENCE — see the JSDoc.
  const kept = [];
  for (let k = 0; k < start; k++) {
    if (k === j) continue;
    kept.push(list[k]);
  }
  return { ok: true, text, turns: kept };
}
