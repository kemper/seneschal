/**
 * Unit tests for the remembered-navigation retention policy.
 *   node --test test/learned.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const sandbox = { globalThis: null, Date };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(here, "..", "src", "learned.js"), "utf8"), sandbox);
const { prune, isStale, TTL_MS } = sandbox.SEN.learned;

// Objects returned from the vm belong to another realm, so deepStrictEqual
// would reject them on prototype identity alone. Compare key sets instead.
const keys = (o) => Object.keys(o).sort();

const NOW = 1_800_000_000_000;
const days = (n) => n * 24 * 60 * 60 * 1000;
const entry = (label, ageDays) => ({ label, path: "/" + label, seen: NOW - days(ageDays) });

test("keeps entries seen inside the TTL", () => {
  const out = prune({ a: entry("a", 1), b: entry("b", 89) }, NOW);
  assert.deepEqual(keys(out), ["a", "b"]);
});

test("drops entries past the TTL", () => {
  const out = prune({ fresh: entry("fresh", 10), ghost: entry("ghost", 200) }, NOW);
  assert.deepEqual(Object.keys(out), ["fresh"]);
});

test("TTL boundary is exclusive at exactly 90 days", () => {
  const at = { x: { label: "x", path: "/x", seen: NOW - TTL_MS } };
  assert.deepEqual(keys(prune(at, NOW)), []);
});

test("an entry with no timestamp is treated as ancient and dropped", () => {
  const out = prune({ legacy: { label: "legacy", path: "/legacy" } }, NOW);
  assert.deepEqual(keys(out), []);
});

test("caps the map at max, keeping the most recently seen", () => {
  const map = {};
  for (let i = 0; i < 10; i++) map["k" + i] = entry("k" + i, i);
  const out = prune(map, NOW, TTL_MS, 3);
  assert.deepEqual(Object.keys(out), ["k0", "k1", "k2"]);
});

test("does not mutate its input", () => {
  const map = { ghost: entry("ghost", 200) };
  const before = JSON.stringify(map);
  prune(map, NOW);
  assert.equal(JSON.stringify(map), before);
});

test("tolerates an empty or missing map", () => {
  assert.deepEqual(keys(prune({}, NOW)), []);
  assert.deepEqual(keys(prune(undefined, NOW)), []);
});

test("isStale: an unseen entry is always stale", () => {
  assert.equal(isStale(undefined, "/a", NOW), true);
});

test("isStale: a moved path is stale even if just seen", () => {
  assert.equal(isStale({ path: "/old", seen: NOW }, "/new", NOW), true);
});

test("isStale: an unchanged entry seen minutes ago is not rewritten", () => {
  assert.equal(isStale({ path: "/a", seen: NOW - 60_000 }, "/a", NOW), false);
});

test("isStale: an unchanged entry goes stale once the refresh window passes", () => {
  assert.equal(isStale({ path: "/a", seen: NOW - days(1) }, "/a", NOW), true);
});
