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

test("reads what a rite button costs or yields", () => {
  assert.equal(N.parseSoulDelta("PERFORM · +240 SOULS"), 240);
  assert.equal(N.parseSoulDelta("PERFORM · −10,000 SOULS"), -10000); // U+2212
  assert.equal(N.parseSoulDelta("PERFORM · -1,000 SOULS"), -1000); // hyphen
  assert.equal(N.parseSoulDelta("PERFORM"), null, "an unquantified button says nothing");
});

test("reads the disturbance a rite advertises", () => {
  assert.equal(N.parseDisturbDelta("👻 Spectral Host · +6 disturb"), 6);
  assert.equal(N.parseDisturbDelta("🕯️ Rite of Honor · -8 disturb"), -8);
  assert.equal(N.parseDisturbDelta("👻 Spectral Host"), null);
});

// --- planning ----------------------------------------------------------------

test("enough souls in hand is a plain raise", () => {
  const p = N.plan({ have: 12000, want: 10000 });
  assert.equal(p.kind, "raise");
  assert.equal(p.harvests, 0);
  assert.equal(p.remaining, 2000);
});

test("exactly enough is still a plain raise", () => {
  assert.equal(N.plan({ have: 10000, want: 10000 }).kind, "raise");
});

test("a shortfall becomes a counted number of sacrifices", () => {
  const p = N.plan({ have: 9000, want: 10000, perHarvest: 240 });
  assert.equal(p.kind, "harvest");
  assert.equal(p.shortfall, 1000);
  assert.equal(p.harvests, 5, "ceil(1000/240) — never round down and come up short");
  assert.equal(p.projected, 9000 + 5 * 240);
  assert.equal(
    p.canRaiseInstead,
    9000,
    "a destructive plan still carries the non-destructive alternative, so the sheet can offer both"
  );
});

test("no harvest rite on the page means blocked, not a guess", () => {
  const p = N.plan({ have: 9000, want: 10000, perHarvest: null });
  assert.equal(p.kind, "blocked");
  assert.equal(p.reason, "no-harvest");
  assert.equal(p.canRaiseInstead, 9000, "offers the host we can actually afford");
});

test("an unquantified harvest button blocks rather than clicking blind", () => {
  // The button exists but does not say what it yields. Clicking it an unknown
  // number of times is exactly what must not happen.
  const p = N.plan({ have: 100, want: 10000, perHarvest: 0 });
  assert.equal(p.kind, "blocked");
});

test("an absurd number of sacrifices is refused, not attempted", () => {
  const p = N.plan({ have: 0, want: 10000, perHarvest: 1 });
  assert.equal(p.kind, "blocked");
  assert.equal(p.reason, "too-many-harvests");
  assert.equal(p.harvests, 10000);
});

test("projects the disturbance the whole plan would cause", () => {
  const p = N.plan({
    have: 9000,
    want: 10000,
    perHarvest: 500,
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
    perHarvest: 1000,
    disturbance: 40,
    tolerance: 50,
    harvestDisturb: 4,
    raiseDisturb: 6,
  });
  assert.equal(p.harvests, 5);
  assert.equal(p.disturbanceAfter, 40 + 6 + 20);
  assert.equal(p.disturbanceWarning, true, "crossing tolerance turns the grounds Haunted");
});

test("no disturbance readout means no false warning", () => {
  const p = N.plan({ have: 20000, want: 10000, disturbance: null, tolerance: null });
  assert.equal(p.disturbanceAfter, null);
  assert.equal(p.disturbanceWarning, false);
});

test("the requested size is clamped before anything is planned", () => {
  assert.equal(N.plan({ have: 0, want: -5 }).want, CFG.SOULS_MIN);
  assert.equal(N.plan({ have: 0, want: 1e12 }).want, CFG.SOULS_MAX);
  assert.equal(N.plan({ have: 0, want: "not a number" }).want, CFG.SOULS_DEFAULT);
});

test("every plan describes itself in words the user can check", () => {
  for (const p of [
    N.plan({ have: 12000, want: 10000 }),
    N.plan({ have: 9000, want: 10000, perHarvest: 240 }),
    N.plan({ have: 9000, want: 10000, perHarvest: null }),
    N.plan({ have: 0, want: 10000, perHarvest: 1 }),
  ]) {
    const text = N.describe(p);
    assert.ok(text.length > 20, "not empty");
    assert.ok(/[0-9]/.test(text), "names actual numbers");
  }
  assert.match(
    N.describe(N.plan({ have: 9000, want: 10000, perHarvest: 240 })),
    /living veterans/,
    "the destructive plan says so in the sentence itself"
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
