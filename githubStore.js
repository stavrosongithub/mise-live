// ============================================================================
// Mise — githubStore.js (Phase 09 / SYNC-02)
// ----------------------------------------------------------------------------
// THE GitHub Contents API transport layer for the v2.0 Multiplayer milestone.
// Raw `fetch` to four endpoints (GET / PUT-create / PUT-update / DELETE), a
// byte-faithful base64 codec, and a complete HTTP-status -> typed-error
// taxonomy. It has ZERO coupling to Alpine or IndexedDB — exactly so the two
// existential pitfalls of the milestone can be proven correct in isolation,
// before any UI state is tangled in:
//   (1) silent byte corruption through base64 (SYNC-02), and
//   (2) a blind 409 auto-retry that clobbers a co-user's save.
//
// PURE-vs-I/O SPLIT (mirrors csvStore.js:11-19): the codec, mapError, and
//   buildHeaders are PURE — no fetch, no config-as-global — so the Node test
//   (scripts/githubstore.test.mjs) imports them directly with ZERO network and
//   ZERO GitHub setup. The I/O functions (ghGetFile / ghPutFile / ghDeleteFile
//   + the transport-only lock CRUD) take their config as an explicit per-call
//   `cfg = {owner, repo, branch, token}` FIRST argument (the recorded
//   config-injection choice — no module-level mutable state, no stale-token
//   footgun on rotation). They are exercised in-browser (and by the live
//   harness in Node-with-token); only the no-retry CONTRACT is unit-tested here
//   against a stubbed fetch.
//
// NODE-vs-BROWSER base64 gap (the analog of csvStore's IndexedDB/Node gap):
//   Node 20 lacks native `Uint8Array.toBase64()` / `fromBase64()` (Baseline
//   2025, present in the user's Chromium). So the PURE codec test exercises the
//   `btoa`/`atob` byte-string FALLBACK path — which is also the path a co-user
//   on an older/other browser hits. The NATIVE path is proven in-browser by the
//   live harness / Playwright. Do NOT gate any logic on the native method
//   existing; the fallback is the cross-runtime path.
//
// NO-DUPLICATION (CLAUDE.md): the CSV byte contract lives in ONE place —
//   csvStore.js's serializeCsv / parseCsv / verifyRoundTrip. This module NEVER
//   re-stringifies CSV (no PapaParse, no `Papa.unparse`, no `split(',')`); its
//   codec operates on `string <-> base64` only. The CALLER (Phase 10/11) threads
//   the CSV string through csvStore's helpers on both sides of base64.
//
// SENSITIVE tier — the token appears ONLY in the Authorization header. It is
//   NEVER placed in an error message or any log line: mapError carries only the
//   HTTP `status` + GitHub's `body.message`.
//
// BOM handling in fixtures/tests — always the escape `"﻿"`, NEVER a
//   literal byte (the csvStore.js convention; a literal BOM is the exact
//   corruption hazard this phase guards against).
// ============================================================================

// ----------------------------------------------------------------------------
// PURE HELPERS (Node-testable; no fetch, no cfg)
// ----------------------------------------------------------------------------

/**
 * bytesToBase64 — encode raw bytes to a base64 string, byte-faithfully.
 * Prefers the native `Uint8Array.prototype.toBase64()` (Baseline 2025, D-04);
 * falls back to the `btoa(byte-string)` idiom (`String.fromCharCode` over the
 * bytes) for pre-Sept-2025 / non-Chromium browsers and Node 20. The fallback is
 * byte-faithful ONLY because it is fed a byte-string, NEVER the raw CSV string —
 * `btoa(csvString)` would mangle the BOM / accented names.
 *
 * @param {Uint8Array} bytes
 * @returns {string} base64
 */
export function bytesToBase64(bytes) {
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64(); // native (D-04)
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b); // byte-string, NOT the CSV string
  return btoa(bin); // portable fallback (D-04)
}

/**
 * base64ToBytes — decode a base64 string back to raw bytes, byte-faithfully.
 * STRIPS `\n` FIRST — GitHub's GET response wraps base64 at ~60 columns, and
 * some decoders choke / produce wrong bytes on the embedded newlines. Prefers
 * native `Uint8Array.fromBase64()`; falls back to `atob` + charCode mapping.
 *
 * @param {string} b64
 * @returns {Uint8Array}
 */
export function base64ToBytes(b64) {
  const clean = b64.replace(/\n/g, ''); // strip GitHub's ~60-col wrapping FIRST
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(clean);
  const bin = atob(clean);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

/**
 * encodeText — string -> base64 (byte-faithful). string -> UTF-8 bytes (via
 * TextEncoder) -> bytesToBase64. NEVER `btoa(text)`.
 *
 * @param {string} text
 * @returns {string} base64
 */
export function encodeText(text) {
  return bytesToBase64(new TextEncoder().encode(text));
}

/**
 * decodeText — base64 -> string (byte-faithful inverse of encodeText). Strips
 * GitHub's `\n`-wrapping, base64 -> bytes -> TextDecoder('utf-8'). Recovers the
 * exact original string (BOM / CRLF / no-trailing-newline / accents intact).
 *
 * `ignoreBOM: true` is REQUIRED — by default TextDecoder CONSUMES a leading
 * UTF-8 BOM, which would silently drop the `﻿` the v2 CSVs carry (the
 * exact byte-corruption this phase exists to prevent). With it set, the BOM is
 * decoded as a literal `﻿` character and round-trips byte-identical.
 *
 * @param {string} b64
 * @returns {string}
 */
export function decodeText(b64) {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(base64ToBytes(b64));
}

/**
 * buildHeaders — the four headers every GitHub Contents API call sends. The
 * token appears ONLY here, in the Authorization header (SENSITIVE tier).
 *
 * @param {string} token
 * @returns {object}
 */
export function buildHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json' // on PUT/DELETE bodies; harmless on GET
  };
}

/**
 * GhError — base typed transport error. Carries the HTTP `status` and GitHub's
 * `message` body string ONLY — NEVER the token. Subclasses set their own `name`.
 */
export class GhError extends Error {
  constructor(status, githubMessage) {
    super(githubMessage || `GitHub error ${status}`);
    this.name = 'GhError';
    this.status = status;
    this.githubMessage = githubMessage;
  }
}
/** 401 — bad / expired / missing token. */
export class GhAuthError extends GhError {
  constructor(status, githubMessage) { super(status, githubMessage); this.name = 'GhAuthError'; }
}
/** 403 / 404 — no access, or repo/path not found. */
export class GhAccessError extends GhError {
  constructor(status, githubMessage) { super(status, githubMessage); this.name = 'GhAccessError'; }
}
/** 409 — stale blob SHA: someone wrote first. HARD STOP; NEVER auto-retried. */
export class GhConflictError extends GhError {
  constructor(status, githubMessage) { super(status, githubMessage); this.name = 'GhConflictError'; }
}
/** 422 — `sha` not supplied to an existing file (CREATE-over-existing). */
export class GhCreateError extends GhError {
  constructor(status, githubMessage) { super(status, githubMessage); this.name = 'GhCreateError'; }
}
/**
 * 403 / 429 — primary/secondary rate limit hit (ACCESS-04, D-08/D-09). Carries
 * ONLY safe fields — status + githubMessage (inherited) plus ONE extra SAFE
 * numeric `retryAfterSeconds` hint. NEVER carries the token (T-14-04). Detected
 * at the throw site (which can read response headers) BEFORE mapError's generic
 * 403 -> GhAccessError mapping, so a rate-limit 403 is disambiguated from a
 * permissions 403 (T-14-05 / Pitfall 2). The banner this drives is inform-only —
 * there is NO auto-retry (D-08 / T-14-06).
 */
export class GhRateLimitError extends GhError {
  constructor(status, githubMessage, retryAfterSeconds) {
    super(status, githubMessage);
    this.name = 'GhRateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * mapError — PURE (status, body) -> typed GhError. All HTTP-status knowledge is
 * centralized here (D-05).
 *
 * The 409-vs-422 distinction is real and load-bearing (SC#3):
 *   409 = "your sha is STALE" — you sent a sha, but the file changed since your
 *         GET (message form: "is at <currentSha> but expected <yourSha>"). HARD
 *         STOP — the caller must NEVER auto-retry (that silently clobbers a
 *         co-user). Surfaced as GhConflictError.
 *   422 = "sha wasn't SUPPLIED" — you PUT without a sha to a file that already
 *         exists (CREATE-over-existing). Surfaced as GhCreateError, distinct
 *         from 409 so Phase 13's clobber guard can tell them apart.
 *
 * @param {number} status
 * @param {object} body — GitHub's JSON error body ({message} typically)
 * @returns {GhError}
 */
export function mapError(status, body) {
  const msg = body && body.message;
  switch (status) {
    case 401: return new GhAuthError(status, msg);
    case 403:
    case 404: return new GhAccessError(status, msg);
    case 409: return new GhConflictError(status, msg);
    case 422: return new GhCreateError(status, msg);
    default:  return new GhError(status, msg);
  }
}

// ----------------------------------------------------------------------------
// ACCESS-04 rate-limit detection — IMPURE header readers (live at the throw
// site, NOT in mapError, which is PURE (status, body) and cannot read headers).
//
// CORS reality (RESEARCH.md §2-4, Pitfall 1): cross-origin, GitHub exposes
// `x-ratelimit-limit` / `-remaining` / `-reset` (reset = epoch SECONDS) but does
// NOT expose `retry-after` (it reads null cross-origin — the landmine). So the
// PRIMARY signal is `x-ratelimit-remaining === '0'`; `retry-after` is only a
// secondary, opportunistic read. A permissions 403 (remaining > 0, no
// retry-after) deliberately FALLS THROUGH to GhAccessError (Pitfall 2 / T-14-05).
// ----------------------------------------------------------------------------

/**
 * isRateLimited — true only for a 403/429 that ALSO shows a rate-limit signal:
 * `x-ratelimit-remaining === '0'` (primary, CORS-exposed) OR a present
 * `retry-after` (secondary, may be null cross-origin). A 403 with remaining > 0
 * is a permissions failure and returns false (it maps to GhAccessError instead).
 *
 * @param {Response} res
 * @returns {boolean}
 */
export function isRateLimited(res) {
  if (!(res.status === 403 || res.status === 429)) return false;
  return res.headers.get('x-ratelimit-remaining') === '0'
      || res.headers.get('retry-after') != null;
}

/**
 * retryAfterSeconds — the cosmetic "try again in about N s" hint. Prefer
 * `retry-after` when readable (rare cross-origin), else derive from the
 * CORS-exposed `x-ratelimit-reset` (epoch SECONDS), else fall back to 60 (GitHub
 * docs: wait at least one minute when no signal is readable). NEVER depends
 * solely on `retry-after` (T-14-07 / Pitfall 1 — it reads null cross-origin and
 * would yield a blank/NaN banner that masks the failure).
 *
 * NOTE: the local-clock subtraction (Date.now()) here is a COSMETIC hint only,
 * NOT a safety comparison — unlike the lock TTL staleness check (which MUST use
 * a server-clock body field). A skewed local clock at worst shows a slightly-off
 * countdown; it can never clobber data.
 *
 * @param {Response} res
 * @returns {number} seconds, always >= 1
 */
export function retryAfterSeconds(res) {
  const ra = res.headers.get('retry-after');
  if (ra != null && Number.isFinite(+ra)) return Math.max(1, +ra);
  const reset = res.headers.get('x-ratelimit-reset');
  if (reset != null && Number.isFinite(+reset)) {
    return Math.max(1, Math.ceil((+reset * 1000 - Date.now()) / 1000));
  }
  return 60;
}

// ----------------------------------------------------------------------------
// LOCK-02 timing substrate — PURE, NaN-guarded server-clock helpers.
//
// THE HEADLINE AVAILABILITY BUG (RESEARCH.md Pitfall 1): the skew-safe "now"
// MUST come from a CORS-readable response BODY field — `commit.committer.date`
// (PUT body for the holder, GET /commits for an observer) — NEVER the `Date`
// response header. `fetch().headers.get('Date')` returns `null` cross-origin
// (the `Date` header is not CORS-safelisted and GitHub does not expose it), so
// `Date.parse(null)` -> `NaN` -> `NaN > expires` is ALWAYS false -> no lock is
// ever judged stale -> a forgotten editor freezes the whole team. These two
// helpers are the SINGLE chokepoint enforcing the body-only, hard-error rule;
// there is no Date.now() fallback anywhere in this path by design.
// ----------------------------------------------------------------------------

/**
 * parseServerTime — the SINGLE NaN-guarded chokepoint for GitHub's server clock
 * (LOCK-02). Parses an ISO string from the response BODY to epoch ms and
 * HARD-ERRORS on null / undefined / unparseable rather than returning NaN or
 * falling through to Date.now(). This is what makes the Date-header trap
 * (Pitfall 1) impossible to hit silently.
 *
 * @param {string} isoString — e.g. commit.committer.date
 * @returns {number} epoch ms (always finite)
 * @throws {GhError} when the value cannot be parsed to a finite time
 */
export function parseServerTime(isoString) {
  const ms = Date.parse(isoString);
  if (!Number.isFinite(ms)) {
    throw new GhError(0, `Could not read GitHub server time (got ${isoString}).`);
  }
  return ms;
}

/**
 * isLockStale — the single LOCK-02 comparison `now > expires`. Parses expiresIso
 * THROUGH parseServerTime so a corrupt/unparseable expires also hard-errors
 * (never silently reads "live forever"), then returns serverNowMs > expires.
 *
 * @param {number} serverNowMs — finite epoch ms from parseServerTime
 * @param {string} expiresIso — the lock's ISO expiry timestamp
 * @returns {boolean} true when the lock has expired
 * @throws {GhError} when expiresIso cannot be parsed
 */
export function isLockStale(serverNowMs, expiresIso) {
  const expiresMs = parseServerTime(expiresIso);
  return serverNowMs > expiresMs;
}

// ----------------------------------------------------------------------------
// IMPURE — GitHub Contents API I/O (fetch; browser + Node-with-token)
//   cfg = { owner, repo, branch, token } as the FIRST arg (per-call injection).
// ----------------------------------------------------------------------------

/**
 * Build the Contents API URL for a path within cfg's repo (no query string).
 * WR-01: `path` is percent-encoded so a space / `?` / `#` (or a `/` in a
 * user-mistyped name) cannot inject query params or alter the request target.
 * The four paths this module ever sends are single segments (the three CSV
 * filenames + `.mise-lock.json`), so encoding the whole segment is correct —
 * encodeURIComponent also encodes `/`, which is the intended hardening here.
 */
function contentsUrl(cfg, path) {
  return `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${encodeURIComponent(path)}`;
}

/**
 * ghGetFile — GET a file's content + blob sha. Rejects the >1 MB
 * `encoding === 'none'` case (Pitfall 5) by throwing rather than returning
 * empty bytes as success — a naive empty decode could later blank the file.
 *
 * @param {object} cfg — {owner, repo, branch, token}
 * @param {string} path
 * @returns {Promise<{text: string, sha: string}>}
 */
export async function ghGetFile(cfg, path) {
  // WR-01: percent-encode the branch ref so a branch name with `/`, a space, or
  // a `?` (e.g. "feat/x y") cannot break or hijack the ?ref= query.
  const url = `${contentsUrl(cfg, path)}?ref=${encodeURIComponent(cfg.branch)}`;
  // gap-closure GAP 1: the GitHub Contents API returns `Cache-Control: private,
  // max-age=60` on authenticated GETs. Without `cache: 'no-store'` the browser
  // serves the PRE-PUSH cached body on the SAVE-04 read-back for up to 60s,
  // false-failing isPushVerifyMismatch on every SUCCESSFUL save (and letting
  // pullFromRemote/refreshKeepEdit pull a stale sha within the window). This is
  // the single shared read primitive, so the directive covers every read path.
  const res = await fetch(url, { headers: buildHeaders(cfg.token), cache: 'no-store' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (isRateLimited(res)) throw new GhRateLimitError(res.status, body && body.message, retryAfterSeconds(res));
    throw mapError(res.status, body);
  }
  const json = await res.json();
  // WR-03: a GET on a directory (or any non-file) returns a JSON ARRAY, not the
  // expected `{content, sha}` object. Surface it as a typed GhError BEFORE the
  // decode path — otherwise `decodeText(undefined)` throws an opaque TypeError
  // that bypasses the friendly-error map. The message carries only `path`
  // (never the token — SENSITIVE tier).
  if (Array.isArray(json) || json.content == null) {
    throw mapError(res.status, { message: `\`${path}\` is a directory or has no content — expected a file.` });
  }
  if (json.encoding === 'none') {
    // >1 MB Contents-API ceiling: content comes back empty. Never treat empty
    // bytes as a successful read (Pitfall 5) — the Git Blobs API is the fix
    // (out of scope this phase).
    throw new GhError(res.status, `${path} exceeds the 1 MB Contents API limit (encoding: none).`);
  }
  return { text: decodeText(json.content), sha: json.sha };
}

/**
 * ghPutFile — create or update a file. `sha` present = UPDATE; absent = CREATE.
 *
 * STRUCTURAL no-retry contract (Pitfall 2 / D-05 hard rule): on `!res.ok` this
 * THROWS the typed error and returns control to the caller. There is NO
 * catch-then-GET-then-PUT anywhere — a 409 (stale sha) is surfaced, never
 * silently resolved, because an internal retry would clobber a co-user's save.
 *
 * @param {object} cfg — {owner, repo, branch, token}
 * @param {string} path
 * @param {string} text — the file content (a CSV string from csvStore.serializeCsv)
 * @param {string} [sha] — present = UPDATE; falsy = CREATE
 * @param {string} message — commit message
 * @returns {Promise<{sha: string}>}
 */
export async function ghPutFile(cfg, path, text, sha, message) {
  const url = contentsUrl(cfg, path);
  const body = { message, content: encodeText(text), branch: cfg.branch };
  if (sha) body.sha = sha; // present = UPDATE; absent = CREATE
  const res = await fetch(url, { method: 'PUT', headers: buildHeaders(cfg.token), body: JSON.stringify(body) });
  if (!res.ok) { // 409/422 typed; NO retry
    const errBody = await res.json().catch(() => ({}));
    if (isRateLimited(res)) throw new GhRateLimitError(res.status, errBody && errBody.message, retryAfterSeconds(res));
    throw mapError(res.status, errBody);
  }
  const json = await res.json();
  // WR-02 (deferred from Phase 10): read content.sha NULL-SAFELY. A normal file
  // UPDATE always returns content.sha, so this is a defensive guard only — a
  // malformed PUT response (no content) returns { sha: undefined } and the
  // caller's GET-back verify (SAVE-04) catches a sha that does not match a real
  // remote state. This is NOT a retry/fallback — the module's STRUCTURAL
  // no-retry contract (above) stays intact (no catch-then-GET).
  //
  // Phase 12 / LOCK-02: additively surface `serverTime` ALONGSIDE the unchanged
  // `sha`. This is the HOLDER-side skew-safe clock — GitHub's own
  // `commit.committer.date` from the PUT 200/201 body (the only CORS-readable
  // clock; the `Date` header is null cross-origin — RESEARCH.md Pitfall 1). The
  // field is additive: Phase 11's pushToRemote destructures only `{ sha: newSha }`
  // so no existing caller breaks (Q4). The caller runs parseServerTime to
  // NaN-guard it — a malformed body with no commit returns serverTime undefined
  // (defensive, no throw here).
  return { sha: json?.content?.sha, serverTime: json?.commit?.committer?.date };
}

/**
 * ghGetServerTime — OBSERVER-side read of GitHub's server clock (Phase 12 /
 * LOCK-02). Mirrors ghGetFile's transport shape exactly (buildHeaders +
 * cache:'no-store' + typed mapError throw). Reads `commit.committer.date` from
 * GET /commits?per_page=1 — the Contents GET body has NO date field (verified
 * RESEARCH.md), so observers need this separate read. Costs 1 GET point and
 * makes ZERO commit noise; it is the D-09 per-presence-check clock source. The
 * CALLER runs parseServerTime on the returned ISO string to NaN-guard it.
 *
 * @param {object} cfg — {owner, repo, branch, token}
 * @returns {Promise<string|undefined>} the latest commit's ISO date string
 */
export async function ghGetServerTime(cfg) {
  const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/commits?per_page=1`;
  const res = await fetch(url, { headers: buildHeaders(cfg.token), cache: 'no-store' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (isRateLimited(res)) throw new GhRateLimitError(res.status, body && body.message, retryAfterSeconds(res));
    throw mapError(res.status, body);
  }
  const [c] = await res.json();
  return c?.commit?.committer?.date;
}

/**
 * ghListCommits — CHANGES-02 transport sibling of ghGetServerTime. Same exact
 * shape (buildHeaders + cache:'no-store' + typed mapError throw) but widens
 * per_page (default 30) and returns the FULL raw commit array rather than
 * slicing one date field. The caller (app.js openRecentChanges) does the
 * filter (drop `[lock]` noise) + map (who/what/when) — this stays a pure
 * transport read. Each array item is `{ sha, commit: { message,
 * committer: { date } } }` (verified RESEARCH.md §5); `commit.author.name` is
 * the SHARED git identity and is deliberately NOT used for "who".
 *
 * @param {object} cfg — {owner, repo, branch, token}
 * @param {number} [perPage=30] — how many recent commits to request
 * @returns {Promise<Array>} the raw GET /commits array
 */
export async function ghListCommits(cfg, perPage = 30) {
  const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/commits?per_page=${perPage}`;
  const res = await fetch(url, { headers: buildHeaders(cfg.token), cache: 'no-store' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (isRateLimited(res)) throw new GhRateLimitError(res.status, body && body.message, retryAfterSeconds(res));
    throw mapError(res.status, body);
  }
  return res.json();
}

/**
 * ghDeleteFile — delete a file. `sha` is REQUIRED by the Contents API.
 *
 * @param {object} cfg — {owner, repo, branch, token}
 * @param {string} path
 * @param {string} sha — the blob sha of the file being deleted (REQUIRED)
 * @param {string} message — commit message
 * @returns {Promise<void>}
 */
export async function ghDeleteFile(cfg, path, sha, message) {
  const url = contentsUrl(cfg, path);
  const body = JSON.stringify({ message, sha, branch: cfg.branch }); // sha REQUIRED
  const res = await fetch(url, { method: 'DELETE', headers: buildHeaders(cfg.token), body });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    if (isRateLimited(res)) throw new GhRateLimitError(res.status, errBody && errBody.message, retryAfterSeconds(res));
    throw mapError(res.status, errBody);
  }
}

// ----------------------------------------------------------------------------
// IMPURE — transport-only lock CRUD (D-03)
//   These move `.mise-lock.json` bytes/JSON over the SAME Contents API path as
//   the CSVs. They are SHAPE-AGNOSTIC: they do NOT define, freeze, or interpret
//   any {holder, expires, ...} lock-file fields, and own NO timing logic. The
//   lock-file JSON shape + the advisory-lock state machine (heartbeat / TTL /
//   staleness / force-release) are Phase 12's responsibility.
// ----------------------------------------------------------------------------

const LOCK_PATH = '.mise-lock.json';

/**
 * ghReadLock — GET the lock file's raw text + sha. A missing lock surfaces as a
 * GhAccessError (404) so Phase 12 can treat absent-lock specially. The contents
 * are returned uninterpreted (raw text) — the caller parses/interprets them.
 *
 * @param {object} cfg — {owner, repo, branch, token}
 * @returns {Promise<{text: string, sha: string}>}
 */
export async function ghReadLock(cfg) {
  return ghGetFile(cfg, LOCK_PATH);
}

/**
 * ghWriteLock — create or update the lock file. The caller-supplied payload is
 * JSON-stringified (if not already a string) and threaded through the SAME
 * byte-faithful encodeText path as the CSVs. This function does NOT inspect the
 * payload's shape (D-03).
 *
 * @param {object} cfg — {owner, repo, branch, token}
 * @param {object|string} payload — caller-owned lock contents (shape is Phase 12's)
 * @param {string} [sha] — present = UPDATE; falsy = CREATE
 * @param {string} message — commit message
 * @returns {Promise<{sha: string}>}
 */
export async function ghWriteLock(cfg, payload, sha, message) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return ghPutFile(cfg, LOCK_PATH, text, sha, message);
}

/**
 * ghDeleteLock — delete the lock file. `sha` REQUIRED (same as ghDeleteFile).
 *
 * @param {object} cfg — {owner, repo, branch, token}
 * @param {string} sha — blob sha of the lock file (REQUIRED)
 * @param {string} message — commit message
 * @returns {Promise<void>}
 */
export async function ghDeleteLock(cfg, sha, message) {
  return ghDeleteFile(cfg, LOCK_PATH, sha, message);
}
