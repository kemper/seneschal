/**
 * Unit tests for the palette's fuzzy matcher.
 *   node --test test/fuzzy.test.mjs
 *
 * fuzzy.js is a plain IIFE meant for a content script, so we evaluate its
 * source against a stub global rather than importing it as a module.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const sandbox = { globalThis: null };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(here, "..", "src", "fuzzy.js"), "utf8"), sandbox);
const rawMatch = sandbox.SEN.fuzzy.match;

// Values built inside the vm belong to another realm, so their Array/Object
// prototypes differ and deepStrictEqual would reject them. Copy into this realm.
const match = (q, t) => {
  const r = rawMatch(q, t);
  return r === null ? null : { score: r.score, positions: [...r.positions] };
};

const score = (q, t) => {
  const r = match(q, t);
  return r ? r.score : null;
};

/** Rank a query across candidates, best first. */
const rank = (q, candidates) =>
  candidates
    .map((c) => ({ c, s: score(q, c) }))
    .filter((x) => x.s !== null)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.c);

test("empty query matches everything with no highlights", () => {
  const r = match("", "Expeditions");
  assert.deepEqual(r, { score: 0, positions: [] });
});

test("returns null when a character is missing", () => {
  assert.equal(match("zzz", "Expeditions"), null);
});

test("respects subsequence order", () => {
  assert.equal(match("dr", "Realm"), null, "'dr' is not a subsequence of Realm");
  assert.ok(match("rl", "Realm"), "'rl' is a subsequence of Realm");
});

test("highlight positions point at the matched characters", () => {
  const r = match("exp", "Expeditions");
  assert.deepEqual(r.positions, [0, 1, 2]);
});

test("prefix match beats a mid-word match", () => {
  assert.ok(score("mar", "Market") > score("mar", "Realm Archive"));
});

test("acronym across words ranks the multi-word entry first", () => {
  const best = rank("hu", ["Hunt", "Buildings", "Champions"])[0];
  assert.equal(best, "Hunt");
});

test("word-start preference: 'cr' finds Craftables over an incidental match", () => {
  assert.ok(score("cr", "Craftables") > score("cr", "Necromancy"));
});

test("shorter targets win when both match equally well", () => {
  assert.ok(score("war", "War") > score("war", "War Banner Workshop"));
});

test("consecutive runs outrank scattered hits", () => {
  assert.ok(score("del", "Delve") > score("del", "Detailed Ledger"));
});

test("spaces in the query are soft separators", () => {
  assert.ok(match("re bu", "Realm Buildings"));
});

test("matching is case-insensitive but positions index the original string", () => {
  const r = match("REALM", "Realm");
  assert.ok(r);
  assert.deepEqual(r.positions, [0, 1, 2, 3, 4]);
});

test("real nav set: each door is its own top hit for its natural query", () => {
  const doors = [
    "Realm", "Expeditions", "Champions", "Inventory", "Lore", "Rankings",
    "Buildings", "Craftables", "Market", "Military", "Statecraft", "Messages",
    "Conquest", "Sieges", "Delve", "Arena", "Holds", "Hunt", "War", "Engines",
    "Spellbook", "Necromancy", "Stable",
  ];
  const expected = {
    exp: "Expeditions", cham: "Champions", inv: "Inventory", rank: "Rankings",
    bui: "Buildings", craft: "Craftables", mark: "Market", mil: "Military",
    stat: "Statecraft", msg: null, conq: "Conquest", del: "Delve",
    are: "Arena", hol: "Holds", hun: "Hunt", eng: "Engines", spell: "Spellbook",
    necro: "Necromancy", stab: "Stable",
  };
  for (const [q, want] of Object.entries(expected)) {
    if (!want) continue;
    assert.equal(rank(q, doors)[0], want, `query "${q}" should hit ${want}`);
  }
});
