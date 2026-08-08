/**
 * fuzzy.js — subsequence scorer for the command palette.
 *
 * Self-contained and DOM-free so it can be unit-tested in isolation
 * (see test/fuzzy.test.mjs, which imports this file's source directly).
 */
(function () {
  "use strict";

  const SEN = (globalThis.SEN = globalThis.SEN || {});

  // Characters that make the next character a "word start" — worth a big bonus
  // so that acronym-ish queries ("rb" -> "REALM / BUILDINGS") rank first.
  const BOUNDARY = /[\s\-_/\\.,:;·•●>|()[\]]/;

  function isWordStart(target, i) {
    if (i === 0) return true;
    const prev = target[i - 1];
    if (BOUNDARY.test(prev)) return true;
    // camelCase / lowerUPPER transition
    if (prev === prev.toLowerCase() && prev !== prev.toUpperCase()) {
      const cur = target[i];
      if (cur === cur.toUpperCase() && cur !== cur.toLowerCase()) return true;
    }
    return false;
  }

  /**
   * Score `query` against `target`.
   *
   * Greedy left-to-right, but for each query character we prefer the next
   * WORD-START occurrence over the next plain occurrence. Plain greedy would
   * match "cr" in "CRAFTABLES" at C-R (good) but "hu" in "THE HUNT" at
   * (T)H-...-U inside the wrong word; the word-start preference fixes that
   * class of mis-ranking, which matters a lot for a nav palette.
   *
   * @returns {{score:number, positions:number[]}|null} null when no match.
   */
  function match(query, target) {
    if (!query) return { score: 0, positions: [] };
    if (!target) return null;

    const q = query.toLowerCase();
    const t = target.toLowerCase();
    const positions = [];
    let score = 0;
    let cursor = 0;
    let prev = -2;

    for (let qi = 0; qi < q.length; qi++) {
      const ch = q[qi];
      if (ch === " ") continue; // spaces are soft separators in the query

      // Find the next plain occurrence and the next word-start occurrence.
      let plain = -1;
      let wordStart = -1;
      for (let k = cursor; k < t.length; k++) {
        if (t[k] !== ch) continue;
        if (plain === -1) plain = k;
        if (isWordStart(target, k)) {
          wordStart = k;
          break;
        }
      }
      // Only jump ahead to a word start if it is not absurdly far away;
      // otherwise a late acronym hit would beat a tight consecutive run.
      let at = plain;
      if (wordStart !== -1 && (plain === -1 || wordStart - plain <= 18)) at = wordStart;
      if (at === -1) return null;

      let points = 10;
      if (at === 0) points += 14;
      else if (isWordStart(target, at)) points += 11;

      if (at === prev + 1) points += 7; // consecutive run

      const gap = prev >= 0 ? at - prev - 1 : 0;
      if (gap > 0) points -= Math.min(gap, 10);

      score += points;
      positions.push(at);
      prev = at;
      cursor = at + 1;
    }

    // Mild preference for shorter targets, and a bonus for a full prefix hit.
    score -= target.length * 0.2;
    if (t.startsWith(q)) score += 18;

    return { score, positions };
  }

  SEN.fuzzy = { match, isWordStart };
})();
