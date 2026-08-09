/**
 * Unit tests for the quick menu's config model.
 *   node --test test/config.test.mjs
 *
 * These cover the two things that decide whether a dock entry behaves: what
 * counts as a usable path (it ends up in location.assign, so this is a safety
 * boundary) and how a `menu` pattern is matched against a visible label.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const sandbox = { globalThis: null, Date, URL, RegExp, crypto: globalThis.crypto };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(here, "..", "src", "config.js"), "utf8"), sandbox);

const CFG = sandbox.SEN.config;

// Values that come back out of the vm belong to another realm, so
// deepStrictEqual rejects them on prototype identity alone (see CLAUDE.md).
// Copy into this realm before comparing.
const mine = (value) => JSON.parse(JSON.stringify(value));

// --- patterns ---------------------------------------------------------------

test("a plain pattern matches the folded label, emoji and ● and all", () => {
  assert.equal(CFG.matchesPattern("craftables", "🛠 CRAFTABLES ●"), true);
  assert.equal(CFG.matchesPattern("hunt", "🐗 HUNT ●"), true);
  assert.equal(CFG.matchesPattern("Craftables", "craftables"), true);
});

test("a plain pattern matches on a substring, so decoration cannot break it", () => {
  assert.equal(CFG.matchesPattern("arena", "THE GRAND ARENA ●"), true);
  assert.equal(CFG.matchesPattern("arena", "MARKET"), false);
});

test("folding ignores spacing and punctuation on both sides", () => {
  assert.equal(CFG.matchesPattern("war room", "WAR-ROOM"), true);
  assert.equal(CFG.foldLabel("🛠 CRAFTABLES ●"), "craftables");
  assert.equal(CFG.foldLabel(null), "");
});

test("a /slashed/ pattern is a real regular expression", () => {
  assert.equal(CFG.matchesPattern("/^hunt/i", "HUNT ●"), true);
  assert.equal(CFG.matchesPattern("/^hunt/i", "THE HUNT"), false);
});

test("a /g/ flag is stripped, so repeated tests do not alternate", () => {
  const { regex } = CFG.parsePattern("/arena/gi");
  assert.equal(regex.test("ARENA"), true);
  assert.equal(regex.test("ARENA"), true, "a sticky lastIndex would fail the second call");
});

test("an invalid regular expression is reported, not thrown", () => {
  const parsed = CFG.parsePattern("/([unclosed/");
  assert.match(parsed.error, /invalid regular expression/);
  assert.equal(CFG.matchesPattern("/([unclosed/", "anything"), false);
});

test("a pattern of pure decoration is rejected rather than matching everything", () => {
  assert.match(CFG.parsePattern("●●").error, /no letters or digits/);
  assert.equal(CFG.matchesPattern("●●", "MARKET"), false);
  assert.match(CFG.parsePattern("   ").error, /empty/);
});

// --- paths ------------------------------------------------------------------

test("site-relative paths are internal", () => {
  assert.deepEqual(mine(CFG.classifyPath("/market")), { kind: "internal", href: "/market" });
  assert.deepEqual(mine(CFG.classifyPath("  /market?tab=2  ")), { kind: "internal", href: "/market?tab=2" });
});

test("a full URL on the game's own origin stays internal", () => {
  const out = CFG.classifyPath("https://wardenfall.com/market?a=1#b", "https://wardenfall.com");
  assert.deepEqual(mine(out), { kind: "internal", href: "/market?a=1#b" });
});

test("an off-site http(s) URL is external", () => {
  const out = CFG.classifyPath("https://example.com/wiki", "https://wardenfall.com");
  assert.equal(out.kind, "external");
  assert.equal(out.href, "https://example.com/wiki");
});

test("dangerous and ambiguous schemes are refused outright", () => {
  // These strings reach location.assign, so this is the security boundary.
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "//evil.example", "market", "", null]) {
    assert.equal(CFG.classifyPath(bad), null, `expected ${String(bad)} to be refused`);
  }
});

// --- items ------------------------------------------------------------------

test("a url entry needs a label and a usable path", () => {
  assert.equal(CFG.validateItem({ label: "Market", type: "url", path: "/market" }).ok, true);
  assert.match(CFG.validateItem({ label: "", type: "url", path: "/market" }).reason, /label/);
  assert.match(CFG.validateItem({ label: "Market", type: "url", path: "" }).reason, /path/);
  assert.match(CFG.validateItem({ label: "X", type: "url", path: "javascript:1" }).reason, /http/);
});

test("a menu entry needs a pattern; the door is optional but must be a path", () => {
  assert.equal(CFG.validateItem({ label: "Arena", type: "menu", match: "arena" }).ok, true);
  assert.equal(CFG.validateItem({ label: "Arena", type: "menu", match: "arena", door: "/expeditions" }).ok, true);
  assert.match(CFG.validateItem({ label: "Arena", type: "menu", match: "" }).reason, /empty/);
  assert.match(CFG.validateItem({ label: "Arena", type: "menu", match: "arena", door: "nope" }).reason, /door/);
});

test("an entry with no type is treated as a url entry", () => {
  const out = CFG.validateItem({ label: "Market", path: "/market" });
  assert.equal(out.ok, true);
  assert.equal(out.item.type, "url");
});

test("labels are trimmed, collapsed and capped; a validated entry gets an id", () => {
  const out = CFG.validateItem({ label: "  Grand   Market  ", type: "url", path: "/market" });
  assert.equal(out.item.label, "Grand Market");
  assert.ok(out.item.id);

  const long = CFG.validateItem({ label: "x".repeat(200), type: "url", path: "/x" });
  assert.equal(long.item.label.length, CFG.MAX_LABEL);
});

test("a menu entry keeps only the fields that belong to it", () => {
  const out = CFG.validateItem({ label: "Arena", type: "menu", match: "arena", path: "/whatever" });
  assert.equal(out.item.path, undefined);
  assert.equal(out.item.match, "arena");
});

// --- whole config -----------------------------------------------------------

test("garbage in gives the defaults back, with both surfaces on", () => {
  for (const input of [null, undefined, 42, "nope", []]) {
    const { config } = CFG.normalize(input);
    assert.ok(config.dock.items.length > 0, `expected defaults for ${JSON.stringify(input)}`);
    assert.equal(config.dock.side, "right");
    assert.equal(config.dock.enabled, true);
    assert.equal(config.palette.enabled, true);
  }
});

test("each surface can be switched off independently", () => {
  const off = CFG.normalize({ palette: { enabled: false }, dock: { enabled: false, items: [] } }).config;
  assert.equal(off.palette.enabled, false);
  assert.equal(off.dock.enabled, false);

  // Half a config still yields a whole one: a missing switch means ON, so a
  // truncated or older stored object never leaves the user with nothing.
  const half = CFG.normalize({ dock: { items: [] } }).config;
  assert.equal(half.palette.enabled, true);
  assert.equal(half.dock.enabled, true);
});

test("a flat dock-only object still loads, so an older export is not lost", () => {
  const { config } = CFG.normalize({ side: "left", items: [{ label: "M", type: "url", path: "/m" }] });
  assert.equal(config.dock.side, "left");
  assert.deepEqual(mine(config.dock.items).map((i) => i.label), ["M"]);
  assert.equal(config.palette.enabled, true);
});

test("an unknown side falls back to the default rather than breaking layout", () => {
  assert.equal(CFG.normalize({ dock: { side: "up", items: [] } }).config.dock.side, "right");
  assert.equal(CFG.normalize({ dock: { side: "left", items: [] } }).config.dock.side, "left");
});

test("an explicitly empty menu is honoured, not overwritten with defaults", () => {
  const { config } = CFG.normalize({ dock: { side: "left", items: [] } });
  assert.deepEqual(mine(config.dock.items), []);
});

test("bad entries are dropped AND reported, never silently swallowed", () => {
  const { config, problems } = CFG.normalize({
    dock: {
      items: [
        { label: "Good", type: "url", path: "/good" },
        { label: "Bad", type: "url", path: "javascript:1" },
        { label: "", type: "url", path: "/nameless" },
      ],
    },
  });
  assert.deepEqual(mine(config.dock.items).map((i) => i.label), ["Good"]);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /"Bad"/);
});

test("duplicate ids are re-minted so edits cannot hit the wrong row", () => {
  const { config } = CFG.normalize({
    dock: {
      items: [
        { id: "same", label: "One", type: "url", path: "/one" },
        { id: "same", label: "Two", type: "url", path: "/two" },
      ],
    },
  });
  assert.equal(config.dock.items.length, 2);
  assert.notEqual(config.dock.items[0].id, config.dock.items[1].id);
});

test("the entry count is capped, and the truncation is reported", () => {
  const items = Array.from({ length: CFG.MAX_ITEMS + 5 }, (_, i) => ({
    label: "n" + i,
    type: "url",
    path: "/n" + i,
  }));
  const { config, problems } = CFG.normalize({ dock: { items } });
  assert.equal(config.dock.items.length, CFG.MAX_ITEMS);
  assert.ok(problems.some((p) => /first 40/.test(p)));
});

test("a saved config round-trips through JSON unchanged", () => {
  const first = CFG.normalize(null).config;
  const second = CFG.normalize(JSON.parse(JSON.stringify(first))).config;
  assert.equal(JSON.stringify(second), JSON.stringify(first));
});

test("every default entry is valid", () => {
  // Deliberately does NOT assert which KINDS the defaults use. They were all
  // `menu` patterns until the nav harvest found real paths, and pinning the
  // mix here would make a data improvement look like a test failure. Both
  // kinds are covered by the validateItem tests above.
  const { items } = CFG.defaults().dock;
  for (const item of items) {
    assert.equal(CFG.validateItem(item).ok, true, `default entry ${item.label} is invalid`);
  }
  assert.ok(items.length > 0);
});

test("the default paths are the harvested ones, not the guessable ones", () => {
  // /buildings, /lore, /inventory and /craftables were all invented by the
  // pre-harvest catalog and all return 404 on the live site. If someone
  // "tidies" a path back to its obvious-looking form, this fails.
  const byLabel = Object.fromEntries(CFG.defaults().dock.items.map((i) => [i.label, i.path]));
  assert.equal(byLabel.Sieges, "/conquest", "Sieges is /conquest, not /sieges");
  assert.equal(byLabel.Craftables, "/expeditions/buildings/craftables");
  assert.equal(byLabel.Champions, "/heroes");
});

// --- repairing entries an earlier build got wrong ---------------------------

test("a stored legacy menu seed is rewritten to its harvested path", () => {
  // This is the bug the user hit: pressing Craftables walked to /empire, which
  // does not carry that label, and then correctly announced it could not find
  // a menu entry called "craftables".
  const stored = {
    dock: {
      items: [{ id: "seed-craftables", icon: "🛠", label: "Craftables", type: "menu", match: "craftables", door: "/empire" }],
    },
  };
  const { config, problems } = CFG.normalize(stored);
  const item = config.dock.items[0];
  // Arrays out of the vm sandbox are cross-realm, so compare the length.
  assert.equal(problems.length, 0, problems.join(" · "));
  assert.equal(item.type, "url");
  assert.equal(item.path, "/expeditions/buildings/craftables");
  assert.equal(item.match, undefined, "the dead pattern is gone, not carried alongside a path");
  assert.equal(item.door, undefined);
  assert.equal(item.label, "Craftables", "the label the user sees is untouched");
});

test("a legacy seed pointing at a 404 path is repaired too", () => {
  // /inventory does not exist; the real route is /expeditions/inventory.
  const { config } = CFG.normalize({
    dock: { items: [{ id: "seed-inventory", icon: "🎒", label: "Inventory", type: "url", path: "/inventory" }] },
  });
  assert.equal(config.dock.items[0].path, "/expeditions/inventory");
});

test("an edited legacy seed is left alone", () => {
  // A stored config is the user's. Only entries still identical to what we
  // shipped get rewritten; change any part of it and it is yours.
  const mine = { id: "seed-craftables", icon: "🛠", label: "Craftables", type: "menu", match: "craftables", door: "/expeditions/buildings" };
  const { config } = CFG.normalize({ dock: { items: [mine] } });
  const item = config.dock.items[0];
  assert.equal(item.type, "menu");
  assert.equal(item.door, "/expeditions/buildings");
});

test("migration leaves entries it does not recognise untouched", () => {
  const mine = { id: "it-abc123", label: "My page", type: "menu", match: "craftables", door: "/empire" };
  assert.equal(CFG.migrateItem(mine), mine);
});

test("every legacy repair lands on a path the catalog knows", () => {
  // Guards against repairing one invented path into another. Each target must
  // be a real harvested route.
  const known = new Set([
    "/expeditions/buildings",
    "/expeditions/buildings/craftables",
    "/expeditions/inventory",
    "/arena",
    "/hunt",
  ]);
  for (const id of ["seed-buildings", "seed-craftables", "seed-arena", "seed-hunt", "seed-inventory"]) {
    const legacy = {
      "seed-buildings": { type: "menu", match: "buildings", door: "/empire" },
      "seed-craftables": { type: "menu", match: "craftables", door: "/empire" },
      "seed-arena": { type: "menu", match: "arena", door: "/expeditions" },
      "seed-hunt": { type: "menu", match: "hunt", door: "/expeditions" },
      "seed-inventory": { type: "url", path: "/inventory" },
    }[id];
    const out = CFG.migrateItem({ id, label: id, ...legacy });
    assert.equal(out.type, "url", `${id} should end up as a url entry`);
    assert.ok(known.has(out.path), `${id} migrated to unknown path ${out.path}`);
  }
});
