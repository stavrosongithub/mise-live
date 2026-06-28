// ===========================================================================
// roster-sync.js  (Phase 17 / Plan 17-03, D-08 / D-09 / D-10)
// ===========================================================================
// The PURE half of the residents-roster snapshot sync. app.js holds the impure
// wiring (the fetchRoster push hook, the putJsonFile/ghPutFile transport + the
// LWW 409 re-pull-overwrite, the tokenless read-in via putRosterTable +
// loadRosterFromCache). This module owns ONLY the snapshot SHAPE so the
// SENSITIVE-tier no-creds guarantee (T-17-08) is Node-testable in isolation —
// mirroring how mealplan-sync.js owns projectSharedPlanDoc for the plan path.
//
// No Alpine, no IndexedDB, no network: pure data-in / data-out.
// ===========================================================================

/**
 * buildRosterSnapshot — Phase 17 (Plan 17-03, D-10). Build the residents_roster.json
 * snapshot from the two table row-sets already in hand at fetchRoster. The snapshot
 * is a pure MIRROR of the Coda rows — it is ROWS-ONLY:
 *
 *   { residency:  { rows: [...], fetchedAt }, onboarding: { rows: [...], fetchedAt } }
 *
 * CRITICAL (SENSITIVE tier, T-17-08): the snapshot carries NO this.codaApiToken,
 * NO GitHub PAT, NO cfg/credential field of any kind. This rows-only design is the
 * whole reason the roster can be GitHub-snapshotted — a tokenless device reads the
 * rows, never a secret. The function takes ONLY rows + a timestamp; there is no
 * parameter through which a credential could enter the payload.
 *
 * Defensive: an absent/undefined row-set coerces to an empty array (never throws),
 * mirroring loadRosterFromCache's "empty cache is valid" discipline.
 *
 * @param {Array<object>|null|undefined} residencyRows  — normalised residency rows
 * @param {Array<object>|null|undefined} onboardingRows — normalised onboarding rows
 * @param {string} fetchedAt — the ISO timestamp of this Coda fetch
 * @returns {{ residency: {rows: Array<object>, fetchedAt: string},
 *             onboarding: {rows: Array<object>, fetchedAt: string} }}
 */
export function buildRosterSnapshot(residencyRows, onboardingRows, fetchedAt) {
  return {
    residency:  { rows: Array.isArray(residencyRows)  ? residencyRows  : [], fetchedAt },
    onboarding: { rows: Array.isArray(onboardingRows) ? onboardingRows : [], fetchedAt }
  };
}
