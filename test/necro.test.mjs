/**
 * Unit tests for the rites logic — the parsing and the planning.
 *   node --test test/necro.test.mjs
 *
 * These matter more than most tests in this repo. Everything here feeds a
 * decision to spend souls or sacrifice veterans, so a parser that reads 4,120
 * as 4 is not a cosmetic bug. The DOM-touching half (finding cards, setting
 * inputs, clicking) is covered by test/dock.py against a real browser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const sandbox = { globalThis: null, Date, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const file of ["config.js", "necro.js"]) {
  vm.runInContext(readFileSync(join(here, "..", "src", file), "utf8"), sandbox);
}
const N = sandbox.SEN.necro;
const CFG = sandbox.SEN.config;

/**
 * The smallest thing that behaves like the part of a document blockText walks:
 * elements with children, and text nodes with values. Enough to prove that the
 * read puts element boundaries back, without pulling in a DOM implementation
 * for what is three properties.
 */
function fakeDoc(rows) {
  const textNode = (value) => ({ nodeType: 3, nodeValue: value, get textContent() { return value; } });
  const el = (tag, value) => {
    const child = textNode(value);
    return {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      firstChild: child,
      nextSibling: null,
      get textContent() { return value; },
    };
  };
  const children = rows.map(([tag, value]) => el(tag, value));
  children.forEach((node, i) => { node.nextSibling = children[i + 1] || null; });
  return {
    body: {
      nodeType: 1,
      firstChild: children[0] || null,
      get textContent() { return rows.map(([, v]) => v).join(""); },
    },
  };
}

// --- reading the balance -----------------------------------------------------

test("reads the balance line as the game renders it", () => {
  const got = N.parseBalance("⚰️ WAR CEMETERY 💀 4,120 souls · Disturbance 12/50");
  assert.equal(got.souls, 4120);
  assert.equal(got.disturbance, 12);
  assert.equal(got.tolerance, 50);
});

test("survives the separators a UI might use", () => {
  assert.equal(N.parseBalance("💀 1,234,567 souls").souls, 1234567);
  assert.equal(N.parseBalance("💀 1 234 567 souls").souls, 1234567); // narrow no-break
  assert.equal(N.parseBalance("💀 12 340 souls").souls, 12340);
});

test("a balance with no disturbance readout still parses", () => {
  const got = N.parseBalance("💀 900 souls");
  assert.equal(got.souls, 900);
  assert.equal(got.disturbance, null);
  assert.equal(got.tolerance, null);
});

test("rite prose is not mistaken for a balance", () => {
  // This blurb sits on the same panel. Matching it would hand the planner a
  // number that does not exist.
  assert.equal(
    N.parseBalance("Call the restless dead to give up their souls. They do not give them gladly."),
    null
  );
  assert.equal(N.parseBalance("A great cleansing lays every restless soul back to rest."), null);
});

test("zero souls reads as zero, not as absent", () => {
  const got = N.parseBalance("💀 0 souls · Disturbance 3/50");
  assert.equal(got.souls, 0);
});

test("a number cannot run on into the one after it", () => {
  // The live panel, read through blockText: "Disturbance 100/65" and the line
  // beneath it, "60 scouts lost to the dark". Flattened with textContent those
  // weld into "100/6560", the tolerance parsed as 6560, and the Haunted
  // warning silently stopped firing on grounds already 35 over the line.
  const got = N.parseBalance(
    "💀 0 souls\n👻 284,745 raisable dead\nDisturbance 100/65\n60 scouts lost to the dark"
  );
  assert.equal(got.souls, 0);
  assert.equal(got.disturbance, 100);
  assert.equal(got.tolerance, 65, "65, not 6560");
});

test("blockText keeps the boundaries textContent throws away", () => {
  // The regex above can only work if the read preserves element edges, so pin
  // the read as well as the parse — this is the half that actually regressed.
  const doc = fakeDoc([
    ["div", "Disturbance 100/65"],
    ["div", "60 scouts lost to the dark"],
  ]);
  assert.equal(doc.body.textContent, "Disturbance 100/6560 scouts lost to the dark");
  const text = N.blockText(doc.body);
  assert.match(text, /100\/65\s/, "the tolerance ends where its element ends");
  assert.equal(N.parseBalance("0 souls" + text).tolerance, 65);
});

test("reads what a rite button costs or yields", () => {
  assert.equal(N.parseSoulDelta("PERFORM · +240 SOULS"), 240);
  assert.equal(N.parseSoulDelta("PERFORM · −10,000 SOULS"), -10000); // U+2212
  assert.equal(N.parseSoulDelta("PERFORM · -1,000 SOULS"), -1000); // hyphen
  assert.equal(N.parseSoulDelta("PERFORM"), null, "an unquantified button says nothing");
});

test("the live Soul-Harvest wording does NOT quantify, so that path stays shut", () => {
  // Measured 2026-08-11: the button reads "Sacrifice · +1 💀" — the currency is
  // a glyph, not the word. parseSoulDelta therefore returns null, plan() comes
  // back blocked, and no veteran is ever sacrificed against the live page.
  //
  // That is the CURRENT, deliberate state. Teaching this the 💀 glyph would arm
  // the one irreversible path in the extension, so it is a decision to take on
  // purpose and not a gap to tidy up. Pinned here so nobody tidies it up.
  assert.equal(N.parseSoulDelta("Sacrifice · +1 💀"), null);
  assert.equal(N.parseSoulDelta("Regular · 1💀 ea"), null);
  assert.equal(
    N.plan({ have: 0, want: 10000, rate: { souls: 1, dead: 1, per: 1000 }, perHarvest: null }).kind,
    "blocked"
  );
});

test("a disabled control is the game refusing, and is never clicked", () => {
  // Live, with no souls, the host button renders "RAISE 0 · 0👻 + 0💀" disabled.
  // Clicking it does nothing, which then surfaced as "the balance did not
  // move" — our bug's phrasing for the game's own answer.
  assert.equal(N.isBlocked({ disabled: true, getAttribute: () => null }), true);
  assert.equal(N.isBlocked({ disabled: false, getAttribute: () => "true" }), true);
  assert.equal(N.isBlocked({ disabled: false, getAttribute: () => null }), false);
  assert.equal(N.isBlocked(null), true, "nothing to click is also a refusal");
});

test("reads the disturbance a rite advertises", () => {
  assert.equal(N.parseDisturbDelta("👻 Spectral Host · +6 disturb"), 6);
  assert.equal(N.parseDisturbDelta("🕯️ Rite of Honor · -8 disturb"), -8);
  assert.equal(N.parseDisturbDelta("👻 Spectral Host"), null);
});

// --- the price of a host -----------------------------------------------------

// Measured off the live Spectral Host card, 2026-08-11. Every planning test
// below goes through this rather than the 1:1 rate an earlier draft assumed.
const RATE = { souls: 1, dead: 1, per: 1000 };

test("reads the rate off the rite's own description", () => {
  const got = N.parseHostRate(
    "Raise a horde from your fallen — +power on your next raid, or a ghost column for " +
      "Conquest. Costs 1 dead + 1 soul per 1,000 raised. No cap; the pool drains as you raise."
  );
  assert.deepEqual({ ...got }, { souls: 1, dead: 1, per: 1000 });
});

test("a card that does not price itself yields no rate at all", () => {
  // Which is the point: no rate, no plan, no click. Never a fallback of 1:1 —
  // that assumption overstated a 10,000 host by a factor of a thousand.
  assert.equal(N.parseHostRate("Raise a horde from your fallen."), null);
  assert.equal(N.parseHostRate("Costs souls per raised."), null);
});

test("a host is priced per BLOCK, rounding up", () => {
  assert.deepEqual({ ...N.costOf(10000, RATE) }, { souls: 10, dead: 10, blocks: 10 });
  assert.deepEqual(
    { ...N.costOf(10001, RATE) },
    { souls: 11, dead: 11, blocks: 11 },
    "a part block still costs a whole one — quote the higher price, never the lower"
  );
  assert.deepEqual({ ...N.costOf(1, RATE) }, { souls: 1, dead: 1, blocks: 1 });
});

test("reads the raisable dead pool", () => {
  assert.equal(N.parseRaisableDead("👻 284,745 raisable dead (your fallen)"), 284745);
  assert.equal(N.parseRaisableDead("💀 0 souls (catalyst — from veteran sacrifice)"), null);
});

test("a balance carries the pool alongside the souls", () => {
  // The rail shows both, and plan() needs both — souls alone will happily
  // describe a host the fallen cannot fill.
  const got = N.parseBalance(
    "💀 30 souls (catalyst — from veteran sacrifice)\n" +
      "👻 221,557 raisable dead (your fallen)\nDisturbance 10/65\n60 scouts lost"
  );
  assert.equal(got.souls, 30);
  assert.equal(got.dead, 221557);
  assert.equal(got.tolerance, 65);
});

test("a panel with no pool on it still yields a reading", () => {
  // Older wording, and any future redesign that drops the line. The pool is
  // null rather than zero, so the rail omits it instead of claiming none.
  const got = N.parseBalance("💀 4,120 souls · Disturbance 12/50");
  assert.equal(got.souls, 4120);
  assert.equal(got.dead, null);
});

// --- planning ----------------------------------------------------------------

test("no rate means no plan — the refusal that outranks every other branch", () => {
  const p = N.plan({ have: 1e6, want: 10000, rate: null, perHarvest: 240 });
  assert.equal(p.kind, "blocked");
  assert.equal(p.reason, "unknown-rate");
  assert.equal(p.canRaiseInstead, 0, "not even a smaller host: we cannot price that either");
});

test("enough souls in hand is a plain raise", () => {
  const p = N.plan({ have: 12000, want: 10000, rate: RATE });
  assert.equal(p.kind, "raise");
  assert.equal(p.harvests, 0);
  assert.equal(p.cost.souls, 10, "10,000 ghosts is 10 souls, not 10,000");
  assert.equal(p.cost.dead, 10);
  assert.equal(p.remaining, 11990);
});

test("exactly enough is still a plain raise", () => {
  assert.equal(N.plan({ have: 10, want: 10000, rate: RATE }).kind, "raise");
});

test("the live reading that used to propose sacrifices now cannot", () => {
  // 0 souls, a 10,000 host, a harvest yielding 1 each. Under the old 1:1 model
  // this was a 10,000-soul shortfall; under the real rate it is 10.
  const p = N.plan({ have: 0, want: 10000, rate: RATE, perHarvest: 1 });
  assert.equal(p.kind, "harvest");
  assert.equal(p.shortfall, 10);
  assert.equal(p.harvests, 10, "ten sacrifices, not ten thousand");
});

test("a shortfall becomes a counted number of sacrifices", () => {
  const p = N.plan({ have: 4, want: 10000, rate: RATE, perHarvest: 3 });
  assert.equal(p.kind, "harvest");
  assert.equal(p.shortfall, 6);
  assert.equal(p.harvests, 2, "ceil(6/3) — never round down and come up short");
  assert.equal(p.projected, 4 + 2 * 3);
  assert.equal(
    p.canRaiseInstead,
    4000,
    "a destructive plan still carries the non-destructive alternative, so the sheet can offer both"
  );
});

test("the smaller host offered is the one the souls actually buy", () => {
  // 9 souls at 1 per 1,000 buys 9,000 ghosts — not 9.
  const p = N.plan({ have: 9, want: 10000, rate: RATE, perHarvest: null });
  assert.equal(p.canRaiseInstead, 9000);
});

test("no harvest rite on the page means blocked, not a guess", () => {
  const p = N.plan({ have: 9, want: 10000, rate: RATE, perHarvest: null });
  assert.equal(p.kind, "blocked");
  assert.equal(p.reason, "no-harvest");
});

test("an unquantified harvest button blocks rather than clicking blind", () => {
  // The button exists but does not say what it yields. Clicking it an unknown
  // number of times is exactly what must not happen.
  const p = N.plan({ have: 1, want: 10000, rate: RATE, perHarvest: 0 });
  assert.equal(p.kind, "blocked");
});

test("an absurd number of sacrifices is refused, not attempted", () => {
  const p = N.plan({ have: 0, want: 1000000, rate: RATE, perHarvest: 1 });
  assert.equal(p.kind, "blocked");
  assert.equal(p.reason, "too-many-harvests");
  assert.equal(p.harvests, 1000);
});

test("the pool of fallen is a hard ceiling no sacrifice can lift", () => {
  // Souls can be harvested; the dead cannot. A host bigger than the pool is
  // blocked outright rather than offered as something to sacrifice towards.
  const p = N.plan({ have: 1e6, want: 10000, rate: RATE, deadHave: 4, perHarvest: 240 });
  assert.equal(p.kind, "blocked");
  assert.equal(p.reason, "not-enough-dead");
  assert.equal(p.canRaiseInstead, 4000, "capped by the pool, not by the souls");
});

test("the smaller host is capped by whichever runs out first", () => {
  const p = N.plan({ have: 9, want: 10000, rate: RATE, deadHave: 3, perHarvest: null });
  assert.equal(p.canRaiseInstead, 3000, "three fallen cover 3,000 even though nine souls cover 9,000");
});

test("projects the disturbance the whole plan would cause", () => {
  const p = N.plan({
    have: 8,
    want: 10000,
    rate: RATE,
    perHarvest: 1,
    disturbance: 10,
    tolerance: 50,
    harvestDisturb: 4,
    raiseDisturb: 6,
  });
  assert.equal(p.harvests, 2);
  assert.equal(p.disturbanceAfter, 10 + 6 + 4 * 2);
  assert.equal(p.disturbanceWarning, false);
});

test("warns when a plan would push the grounds past tolerance", () => {
  const p = N.plan({
    have: 0,
    want: 5000,
    rate: RATE,
    perHarvest: 1,
    disturbance: 40,
    tolerance: 50,
    harvestDisturb: 4,
    raiseDisturb: 6,
  });
  assert.equal(p.harvests, 5);
  assert.equal(p.disturbanceAfter, 40 + 6 + 20);
  assert.equal(p.disturbanceWarning, true, "crossing tolerance turns the grounds Haunted");
});

test("already past tolerance warns before it spends anything further", () => {
  // The live reading on 2026-08-11: Disturbance 100/65, grounds already
  // Haunted. Misreading the tolerance as 6560 made this come back false.
  const p = N.plan({
    have: 1000,
    want: 10000,
    rate: RATE,
    disturbance: 100,
    tolerance: 65,
    raiseDisturb: 0,
  });
  assert.equal(p.disturbanceAfter, 100);
  assert.equal(p.disturbanceWarning, true);
});

test("no disturbance readout means no false warning", () => {
  const p = N.plan({ have: 20000, want: 10000, rate: RATE, disturbance: null, tolerance: null });
  assert.equal(p.disturbanceAfter, null);
  assert.equal(p.disturbanceWarning, false);
});

test("the requested size is clamped before anything is planned", () => {
  assert.equal(N.plan({ have: 0, want: -5, rate: RATE }).want, CFG.SOULS_MIN);
  assert.equal(N.plan({ have: 0, want: 1e12, rate: RATE }).want, CFG.SOULS_MAX);
  assert.equal(N.plan({ have: 0, want: "not a number", rate: RATE }).want, CFG.SOULS_DEFAULT);
});

test("every plan describes itself in words the user can check", () => {
  for (const p of [
    N.plan({ have: 12000, want: 10000, rate: RATE }),
    N.plan({ have: 4, want: 10000, rate: RATE, perHarvest: 3 }),
    N.plan({ have: 9, want: 10000, rate: RATE, perHarvest: null }),
    N.plan({ have: 0, want: 1000000, rate: RATE, perHarvest: 1 }),
    N.plan({ have: 1e6, want: 10000, rate: RATE, deadHave: 4 }),
    N.plan({ have: 1e6, want: 10000, rate: null }),
  ]) {
    const text = N.describe(p);
    assert.ok(text.length > 20, "not empty");
  }
  assert.match(
    N.describe(N.plan({ have: 4, want: 10000, rate: RATE, perHarvest: 3 })),
    /living veterans/,
    "the destructive plan says so in the sentence itself"
  );
  assert.match(
    N.describe(N.plan({ have: 12000, want: 10000, rate: RATE })),
    /10 souls \+ 10 dead/,
    "the price is quoted in BOTH currencies, since only one of them can be harvested"
  );
});

// --- formatting --------------------------------------------------------------

test("formats counts for reading and for the badge", () => {
  assert.equal(N.formatCount(1234567), "1,234,567");
  assert.equal(N.formatShort(940), "940");
  assert.equal(N.formatShort(1200), "1.2k");
  assert.equal(N.formatShort(12000), "12k");
  assert.equal(N.formatShort(1200000), "1.2m");
  assert.equal(N.formatShort(0), "0");
});

test("ages a reading in plain words", () => {
  const now = Date.parse("2026-08-11T12:00:00Z");
  assert.equal(N.formatAge(now - 10 * 1000, now), "just now");
  assert.equal(N.formatAge(now - 60 * 1000, now), "1 minute ago");
  assert.equal(N.formatAge(now - 25 * 60 * 1000, now), "25 minutes ago");
  assert.equal(N.formatAge(now - 3 * 3600 * 1000, now), "3 hours ago");
  assert.equal(N.formatAge(now - 5 * 86400 * 1000, now), "5 days ago");
});

// --- the souls setting -------------------------------------------------------

test("a host entry defaults its size and its route to the rites", () => {
  const r = CFG.validateItem({ label: "Raise host", type: "host" });
  assert.ok(r.ok);
  assert.equal(r.item.souls, CFG.SOULS_DEFAULT);
  assert.equal(r.item.match, CFG.RITES_MATCH);
  assert.equal(r.item.door, CFG.RITES_DOOR);
});

test("a host entry keeps a size the user chose", () => {
  assert.equal(CFG.validateItem({ label: "Small", type: "host", souls: 250 }).item.souls, 250);
  assert.equal(
    CFG.validateItem({ label: "Typed", type: "host", souls: "12,500" }).item.souls,
    12500,
    "a pasted number with separators is still a number"
  );
});

test("an unreadable size is an error, never a silent default", () => {
  // Defaulting here would spend 10,000 souls the user never asked for.
  for (const bad of ["1oooo", "abc", "12.5", NaN]) {
    const r = CFG.validateItem({ label: "Bad", type: "host", souls: bad });
    assert.equal(r.ok, false, `rejects ${String(bad)}`);
    assert.match(r.reason, /whole number/);
  }
});

test("a size outside the guard rails is refused with the range named", () => {
  const low = CFG.validateItem({ label: "Zero", type: "host", souls: 0 });
  assert.equal(low.ok, false);
  const high = CFG.validateItem({ label: "Huge", type: "host", souls: CFG.SOULS_MAX + 1 });
  assert.equal(high.ok, false);
  assert.match(high.reason, /between/);
});

test("an empty size box means the default, which is the one safe coercion", () => {
  assert.equal(CFG.validateItem({ label: "Blank", type: "host", souls: "" }).item.souls, CFG.SOULS_DEFAULT);
});

// --- the v1 -> v2 migration --------------------------------------------------

test("an existing menu gains the host entry exactly once", () => {
  const v1 = {
    version: 1,
    dock: { items: [{ id: "a", label: "Realm", type: "url", path: "/empire" }] },
  };
  const first = CFG.normalize(v1);
  assert.equal(first.migrated, true);
  assert.equal(first.config.dock.items.filter((i) => i.type === "host").length, 1);

  // Feeding the migrated config back in must not add a second one.
  const second = CFG.normalize(first.config);
  assert.equal(second.migrated, false);
  assert.equal(second.config.dock.items.filter((i) => i.type === "host").length, 1);
});

test("deleting the host entry sticks once the version is stamped forward", () => {
  const current = { version: CFG.VERSION, dock: { items: [{ id: "a", label: "Realm", type: "url", path: "/empire" }] } };
  const out = CFG.normalize(current);
  assert.equal(out.migrated, false);
  assert.equal(out.config.dock.items.some((i) => i.type === "host"), false, "stays deleted");
});

test("a fresh install already has the host entry, with nothing to migrate", () => {
  const fresh = CFG.normalize(null);
  assert.equal(fresh.migrated, false);
  assert.equal(fresh.config.dock.items.filter((i) => i.type === "host").length, 1);
});
