/**
 * learned.js — retention policy for the remembered-navigation index.
 *
 * Pure and dependency-free (no DOM, no chrome.*) so the policy can be unit
 * tested directly; palette.js owns the storage plumbing around it.
 */
(function () {
  "use strict";

  const SEN = (globalThis.SEN = globalThis.SEN || {});

  // A remembered entry is only re-stamped when you next visit the door it lives
  // under, so the TTL has to be generous — but not infinite, or a nav item the
  // game renames or retires would haunt the palette (and 404) forever.
  const TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
  const MAX = 400;

  /**
   * Drop entries past the TTL, then keep only the MAX most recently seen.
   * @param {Object<string, {label:string, path:?string, seen:number}>} map
   * @param {number} [now]
   * @returns {Object} a new map; the input is not mutated.
   */
  function prune(map, now = Date.now(), ttl = TTL_MS, max = MAX) {
    const live = Object.entries(map || {}).filter(
      ([, v]) => v && now - (v.seen || 0) < ttl
    );
    live.sort((a, b) => (b[1].seen || 0) - (a[1].seen || 0));
    return Object.fromEntries(live.slice(0, max));
  }

  /**
   * Should this sighting be written back? Re-stamping on every scan would
   * thrash storage, so refresh at most hourly unless something actually moved.
   */
  function isStale(prev, path, now = Date.now(), refreshMs = 36e5) {
    if (!prev) return true;
    if (prev.path !== path) return true;
    return now - (prev.seen || 0) >= refreshMs;
  }

  SEN.learned = { prune, isStale, TTL_MS, MAX };
})();
