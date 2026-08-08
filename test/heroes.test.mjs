/**
 * Unit tests for the hero roster parser.
 *   node --test test/heroes.test.mjs
 *
 * The fixtures here are VERBATIM text captured from the live /heroes page on
 * 2026-08-08, including the shapes that nearly fooled the parser: the page
 * prints heroes twice (a roster row with class icon and level, an HP row with
 * current/max) and carries other ratios that are not HP at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const sandbox = { globalThis: null, Date, URL, RegExp, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(here, "..", "src", "heroes.js"), "utf8"), sandbox);
const H = sandbox.SEN.heroes;
const mine = (v) => JSON.parse(JSON.stringify(v));

const LIVE =
  "Heroes◀● 🔮 Krogdolf Lv50● ⚔️ Krogloff Lv40● 🗡️ Krogsly Lv35● 🏹 Krogman Lv38● 🔮 Krogdore Lv43▶ " +
  "Heroes Krogdolf 489/489 · Krogloff 459/459 · Krogsly 382/382 · Krogman 431/431 · Krogdore 373/373";

test("parses every hero from the live page shape", () => {
  const out = H.parseHeroes(LIVE);
  assert.equal(out.length, 5);
  assert.deepEqual(mine(out[0]), { name: "Krogdolf", icon: "🔮", level: 50, hp: 489, maxHp: 489 });
  assert.deepEqual(mine(out).map((h) => h.name), ["Krogdolf", "Krogloff", "Krogsly", "Krogman", "Krogdore"]);
});

test("joins the two rows: class icon and level come from the roster row", () => {
  const byName = Object.fromEntries(mine(H.parseHeroes(LIVE)).map((h) => [h.name, h]));
  assert.equal(byName.Krogman.icon, "🏹");
  assert.equal(byName.Krogman.level, 38);
  assert.equal(byName.Krogman.hp, 431);
});

test("ratios that are not HP are rejected", () => {
  // Both appear on the real page. current > max is the tell.
  const out = H.parseHeroes(LIVE + " Power 900/70 Morale 100/85 Upkeep 300/90");
  assert.deepEqual(mine(out).map((h) => h.name), ["Krogdolf", "Krogloff", "Krogsly", "Krogman", "Krogdore"]);
});

test("a hero with no icon still parses, so losing the emoji is not fatal", () => {
  const out = H.parseHeroes("Ragnar Lv12 Ragnar 40/80");
  assert.equal(out.length, 1);
  assert.equal(out[0].icon, "");
  assert.equal(out[0].level, 12);
  assert.equal(out[0].hp, 40);
});

test("a damaged hero is reported as damaged, a full one is not", () => {
  assert.equal(H.isDamaged({ hp: 40, maxHp: 80 }), true);
  assert.equal(H.isDamaged({ hp: 80, maxHp: 80 }), false);
  assert.equal(H.isDamaged({ hp: 0, maxHp: 0 }), false);
  assert.equal(H.isDamaged(null), false);
});

test("hpFraction is clamped and never divides by zero", () => {
  assert.equal(H.hpFraction({ hp: 40, maxHp: 80 }), 0.5);
  assert.equal(H.hpFraction({ hp: 99, maxHp: 80 }), 1);
  assert.equal(H.hpFraction({ hp: 5, maxHp: 0 }), 0);
  assert.equal(H.hpFraction(undefined), 0);
});

test("empty or junk input yields no heroes rather than throwing", () => {
  for (const input of ["", null, undefined, "no heroes here", "12/34"]) {
    assert.deepEqual(mine(H.parseHeroes(input)), []);
  }
});

test("siege names are picked out of the page text, deduped", () => {
  const text = "The Ashvale Bulwark ... The Ashvale Bulwark ... The Bonekeep Bulwark ... The Stormmire Bulwark";
  assert.deepEqual(mine(H.parseSieges(text)), ["The Ashvale Bulwark", "The Bonekeep Bulwark", "The Stormmire Bulwark"]);
  assert.deepEqual(mine(H.parseSieges("")), []);
});
