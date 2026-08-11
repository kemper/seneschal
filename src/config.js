/**
 * config.js — the settings model for both of Seneschal's surfaces.
 *
 * One stored object covers everything:
 *
 *   { version, palette: { enabled },
 *              dock:    { enabled, side, collapsed, items: [...] },
 *              heroes:  { enabled, siege } }
 *
 * Either surface can be switched off entirely — from the toolbar popup or the
 * options page — and both watch storage, so a toggle takes effect in every
 * open tab without a reload.
 *
 * Pure and dependency-free: no DOM, no chrome.*, no knowledge of Wardenfall's
 * markup. dock.js owns the rendering and options/options.js owns the editor;
 * both go through here so there is exactly one definition of what a valid
 * entry is, and it can be unit tested directly (test/config.test.mjs).
 *
 * An entry is one of two kinds:
 *
 *   { type: "url",  path: "/market" }
 *       A destination with an address. Activated by clicking a live anchor for
 *       that path if one is on screen, else by navigating.
 *
 *   { type: "menu", match: "craftables", door: "/empire" }
 *       Reached by NAME rather than by address. `match` is a pattern tested
 *       against the VISIBLE LABEL of nav entries; `door` is where to go first
 *       when nothing on this page matches.
 *
 *       Most nav entries in this game DO have a URL, so prefer `url` when you
 *       know it. This kind earns its place in four narrower cases:
 *         - the URL is not known yet (11 of catalog.js's 23 entries have none,
 *           because the catalog was written from captured text — harvest them
 *           with tools/harvest-nav.js and those become plain `url` entries);
 *         - the route misbehaves on a hard load, as /buildings is reported to
 *           (second-hand and unverified), so clicking through is safer;
 *         - the control genuinely has no href — a dropdown toggle such as the
 *           user menu is a button, and there is nothing to navigate to;
 *         - you would rather pin the name than the address, because you expect
 *           the URL to move and the label to stay.
 *
 *   { type: "host", souls: 10000, match: "necromancy", door: "/empire" }
 *       Not a destination at all: raise a spectral host of `souls` ghosts.
 *       Reaches the rites panel exactly like a `menu` entry, then reads the
 *       balance and asks before spending anything (see necro.js).
 *
 * Matching visible labels rather than class names or DOM shape is deliberate:
 * the game reorganised its whole navigation in v1.96 and ships patches most
 * days. Labels and URLs are the parts that survive.
 */
(function () {
  "use strict";

  const SEN = (globalThis.SEN = globalThis.SEN || {});

  const STORAGE_KEY = "seneschal.settings.v1";
  // v2 added the `host` entry type. See migrate() for what a v1 config gains.
  const VERSION = 2;
  const SIDES = ["left", "right"];
  const TYPES = ["url", "menu", "host"];
  const MAX_ITEMS = 40;
  const MAX_LABEL = 32;

  // How big a host a `host` entry raises, and the bounds on that number.
  // MAX is not a game limit — it is a typo guard: 10,000 souls is already a
  // large host, and a stray keystroke turning it into 100,000,000 must not be
  // spendable in one click.
  const SOULS_DEFAULT = 10000;
  const SOULS_MIN = 1;
  const SOULS_MAX = 10000000;

  // Where the rites panel lives. v1.96 filed NECROMANCY under REALM; both are
  // per-entry overrides precisely because that will move again.
  const RITES_MATCH = "necromancy";
  // HARVESTED, not guessed (2026-08-11, against the live site). The rites are
  // NOT in the Realm row: "⚰ Necromancy" renders in the CHAMPIONS row, and its
  // path is three levels deep under /expeditions/buildings. An earlier default
  // sent this entry to /empire, whose row is Empire · Buildings · Market ·
  // Military · Statecraft — so it walked the wrong door and then correctly
  // announced it could not find anything called "necromancy". Take this from
  // catalog.js; never from the label, and never from the group name.
  const RITES_DOOR = "/expeditions/buildings/necromancy";

  /**
   * The out-of-the-box menu, as requested.
   *
   * Every one of these is a `url` entry, because the nav harvest of 2026-08-08
   * found a real path for all twelve. An earlier build shipped several as
   * `menu` patterns purely because catalog.js did not know their URLs — which
   * was a gap in our data, never a property of the game. One hop beats two.
   *
   * Four of these paths are ones you would not guess, which is exactly why they
   * were harvested rather than inferred: SIEGES is /conquest, MARKET is
   * /market but sits in the Realm row, CRAFTABLES is three levels deep at
   * /expeditions/buildings/craftables, and RAIDS is the Expeditions door's own
   * first sub-entry so it points back at /expeditions. Take every one of these
   * from catalog.js; never from the label.
   */
  const DEFAULT_ITEMS = [
    { id: "seed-realm", icon: "🏰", label: "Realm", type: "url", path: "/empire" },
    { id: "seed-champions", icon: "🛡", label: "Champions", type: "url", path: "/heroes" },
    { id: "seed-raids", icon: "🏴", label: "Raids", type: "url", path: "/expeditions" },
    { id: "seed-sieges", icon: "🏯", label: "Sieges", type: "url", path: "/conquest" },
    { id: "seed-arena", icon: "⚔️", label: "Arena", type: "url", path: "/arena" },
    { id: "seed-craftables", icon: "🛠", label: "Craftables", type: "url", path: "/expeditions/buildings/craftables" },
    { id: "seed-spellbook", icon: "🔮", label: "Spellbook", type: "url", path: "/spellbook" },
    { id: "seed-military", icon: "🪖", label: "Military", type: "url", path: "/military" },
    { id: "seed-market", icon: "🪙", label: "Market", type: "url", path: "/market" },
    { id: "seed-holds", icon: "🚩", label: "Holds", type: "url", path: "/holds" },
    { id: "seed-stable", icon: "🐎", label: "Stable", type: "url", path: "/stable" },
    { id: "seed-rankings", icon: "🏆", label: "Rankings", type: "url", path: "/rankings" },
    { id: "seed-host", icon: "👻", label: "Raise host", type: "host", souls: SOULS_DEFAULT, match: RITES_MATCH, door: RITES_DOOR },
  ];

  /**
   * Entries an earlier build shipped that were WRONG, and how to repair them.
   *
   * Two separate mistakes, both from writing the menu before the nav was
   * harvested. Four entries were reached by NAME through a door that does not
   * carry that name, so pressing Craftables walked to /empire and then
   * announced it could not find a menu entry called "craftables" — the loud
   * failure working exactly as designed, on a config we had authored badly.
   * And two paths were invented rather than observed: /inventory and
   * /craftables are both 404s.
   *
   * A stored config is the user's, so this repairs only entries still IDENTICAL
   * to what we shipped. Change the label, the pattern or the door and it is
   * yours; we leave it alone and let the loud failure tell you it is broken.
   */
  const LEGACY_SEEDS = [
    { was: { id: "seed-buildings", type: "menu", match: "buildings", door: "/empire" }, now: { path: "/expeditions/buildings" } },
    { was: { id: "seed-craftables", type: "menu", match: "craftables", door: "/empire" }, now: { path: "/expeditions/buildings/craftables" } },
    { was: { id: "seed-arena", type: "menu", match: "arena", door: "/expeditions" }, now: { path: "/arena" } },
    { was: { id: "seed-hunt", type: "menu", match: "hunt", door: "/expeditions" }, now: { path: "/hunt" } },
    { was: { id: "seed-inventory", type: "url", path: "/inventory" }, now: { path: "/expeditions/inventory" } },
  ];

  /**
   * Every menu we have ever SHIPPED, verbatim, oldest first.
   *
   * A default only ever reaches a fresh install: change DEFAULT_ITEMS and
   * everyone already running keeps whatever was written to storage the first
   * time they loaded the extension. That is how a repaired Craftables path
   * still walked to /empire for the one person who reported it.
   *
   * So a stored menu that is still EXACTLY one of these — same entries, same
   * order, nothing edited — is ours rather than theirs, and is replaced with
   * the current default. Add one entry, move one, rename one, and the
   * fingerprint stops matching and we never touch it again.
   *
   * WHEN YOU CHANGE DEFAULT_ITEMS, PASTE THE OUTGOING LIST HERE. Forget, and
   * the change silently applies to new installs only.
   */
  const SHIPPED_MENUS = [
    // v0.1 — written before the nav was harvested; four entries hunted for a
    // label behind a door that does not carry it, and /inventory is a 404.
    [
      { id: "seed-realm", icon: "🏰", label: "Realm", type: "url", path: "/empire" },
      { id: "seed-expeditions", icon: "🧭", label: "Expeditions", type: "url", path: "/expeditions" },
      { id: "seed-champions", icon: "⚔️", label: "Champions", type: "url", path: "/heroes" },
      { id: "seed-inventory", icon: "🎒", label: "Inventory", type: "url", path: "/inventory" },
      { id: "seed-buildings", icon: "🏛", label: "Buildings", type: "menu", match: "buildings", door: "/empire" },
      { id: "seed-craftables", icon: "🛠", label: "Craftables", type: "menu", match: "craftables", door: "/empire" },
      { id: "seed-arena", icon: "🗡", label: "Arena", type: "menu", match: "arena", door: "/expeditions" },
      { id: "seed-hunt", icon: "🐗", label: "Hunt", type: "menu", match: "hunt", door: "/expeditions" },
    ],
    // The first requested menu, still reaching four destinations by name.
    [
      { id: "seed-champions", icon: "🛡", label: "Champions", type: "url", path: "/heroes" },
      { id: "seed-raids", icon: "🏴", label: "Raids", type: "menu", match: "raids", door: "/expeditions" },
      { id: "seed-sieges", icon: "🏯", label: "Sieges", type: "menu", match: "sieges", door: "/expeditions" },
      { id: "seed-arena", icon: "⚔️", label: "Arena", type: "menu", match: "arena", door: "/expeditions" },
      { id: "seed-craftables", icon: "🛠", label: "Craftables", type: "menu", match: "craftables", door: "/empire" },
      { id: "seed-military", icon: "🪖", label: "Military", type: "url", path: "/military" },
    ],
    // The same six after the harvest, as real paths.
    [
      { id: "seed-champions", icon: "🛡", label: "Champions", type: "url", path: "/heroes" },
      { id: "seed-raids", icon: "🏴", label: "Raids", type: "url", path: "/expeditions" },
      { id: "seed-sieges", icon: "🏯", label: "Sieges", type: "url", path: "/conquest" },
      { id: "seed-arena", icon: "⚔️", label: "Arena", type: "url", path: "/arena" },
      { id: "seed-craftables", icon: "🛠", label: "Craftables", type: "url", path: "/expeditions/buildings/craftables" },
      { id: "seed-military", icon: "🪖", label: "Military", type: "url", path: "/military" },
    ],
    // The twelve-entry menu, before "Raise host" was appended to it. Anyone
    // who installed between the harvest and v0.3 is holding exactly this.
    [
      { id: "seed-realm", icon: "🏰", label: "Realm", type: "url", path: "/empire" },
      { id: "seed-champions", icon: "🛡", label: "Champions", type: "url", path: "/heroes" },
      { id: "seed-raids", icon: "🏴", label: "Raids", type: "url", path: "/expeditions" },
      { id: "seed-sieges", icon: "🏯", label: "Sieges", type: "url", path: "/conquest" },
      { id: "seed-arena", icon: "⚔️", label: "Arena", type: "url", path: "/arena" },
      { id: "seed-craftables", icon: "🛠", label: "Craftables", type: "url", path: "/expeditions/buildings/craftables" },
      { id: "seed-spellbook", icon: "🔮", label: "Spellbook", type: "url", path: "/spellbook" },
      { id: "seed-military", icon: "🪖", label: "Military", type: "url", path: "/military" },
      { id: "seed-market", icon: "🪙", label: "Market", type: "url", path: "/market" },
      { id: "seed-holds", icon: "🚩", label: "Holds", type: "url", path: "/holds" },
      { id: "seed-stable", icon: "🐎", label: "Stable", type: "url", path: "/stable" },
      { id: "seed-rankings", icon: "🏆", label: "Rankings", type: "url", path: "/rankings" },
    ],
  ];

  /**
   * A comparable string for a menu. Covers every field an entry can carry, so
   * editing ANY of them — including the icon, and including the host size —
   * makes the menu yours. `souls` matters here as much as any of them: someone
   * who dialled the host down to 500 has expressed a preference about a rite
   * that SPENDS, and replacing that with our default would be the worst kind of
   * silent overwrite.
   */
  function fingerprint(items) {
    if (!Array.isArray(items)) return "";
    return items
      .map((it) =>
        it && typeof it === "object"
          ? [it.id, it.icon, it.label, it.type, it.path, it.match, it.door, it.souls]
              .map((v) => (v == null ? "" : String(v)))
              .join("")
          : ""
      )
      .join("");
  }

  /**
   * Is this stored menu still one we shipped, untouched?
   *
   * Compared in MIGRATED form on both sides, which matters more than it looks.
   * `LEGACY_SEEDS` repairs entries in place on every load, and the moment
   * anything writes settings back — collapsing the rail, adding a link,
   * switching siege — storage holds the repaired menu rather than the one we
   * shipped. Fingerprinting the raw form missed those completely, so a menu
   * that had been repaired could never be brought forward again.
   */
  function isShippedMenu(items) {
    if (!Array.isArray(items) || !items.length) return false;
    const settle = (menu) => fingerprint(menu.map(migrateItem));
    const mark = settle(items);
    return SHIPPED_MENUS.some((menu) => settle(menu) === mark);
  }

  /**
   * Rewrite one entry if it is an untouched copy of something we got wrong.
   * Returns the entry unchanged otherwise.
   */
  function migrateItem(raw) {
    if (!raw || typeof raw !== "object") return raw;
    const rule = LEGACY_SEEDS.find(
      (r) => r.was.id === raw.id && Object.keys(r.was).every((k) => raw[k] === r.was[k])
    );
    if (!rule) return raw;
    // Always lands as a `url` entry: we now know the address, and one hop beats
    // walking a door and hunting for a label.
    const { match, door, ...rest } = raw;
    return { ...rest, type: "url", path: rule.now.path };
  }

  function defaults() {
    return {
      version: VERSION,
      palette: { enabled: true },
      // `siege` is the siege NAME the heal panel acts on, empty meaning "the
      // first one the page offers". A name, not an id: ids are opaque and the
      // visible name is the part that survives a patch.
      heroes: { enabled: true, siege: "" },
      dock: {
        enabled: true,
        side: "right",
        collapsed: false,
        items: DEFAULT_ITEMS.map((it) => ({ ...it })),
      },
    };
  }

  // --- labels ---------------------------------------------------------------

  /**
   * Fold a visible label down to comparable characters: lowercase, letters and
   * digits only. Collapses the decoration the game hangs off nav entries, so
   * "🛠 CRAFTABLES ●" and "Craftables" both fold to "craftables".
   */
  function foldLabel(s) {
    return String(s == null ? "" : s)
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "");
  }

  // --- patterns -------------------------------------------------------------

  /**
   * Parse a `match` pattern. Two forms:
   *   "craftables"   folded substring — forgiving, survives emoji and ● churn
   *   "/^hunt/i"     a real regular expression, tested against the raw label
   *
   * @returns {{needle:string}|{regex:RegExp}|{error:string}}
   */
  function parsePattern(pattern) {
    const raw = String(pattern == null ? "" : pattern).trim();
    if (!raw) return { error: "pattern is empty" };

    const asRegex = /^\/(.+)\/([gimsuy]*)$/.exec(raw);
    if (asRegex) {
      try {
        // Strip /g: a sticky lastIndex would make repeated .test() calls
        // alternate between true and false on the same element.
        return { regex: new RegExp(asRegex[1], asRegex[2].replace(/g/g, "")) };
      } catch (e) {
        return { error: `invalid regular expression: ${e.message}` };
      }
    }

    const needle = foldLabel(raw);
    if (!needle) return { error: "pattern has no letters or digits to match on" };
    return { needle };
  }

  /** Does `label` (a visible nav label) satisfy `pattern`? */
  function matchesPattern(pattern, label) {
    const p = parsePattern(pattern);
    if (p.error) return false;
    if (p.regex) return p.regex.test(String(label == null ? "" : label));
    return foldLabel(label).includes(p.needle);
  }

  // --- paths ----------------------------------------------------------------

  /**
   * Work out what a `path` field actually points at.
   *
   * Only site-relative paths and http(s) URLs are accepted. Anything else —
   * `javascript:`, `data:`, a bare word — is rejected rather than normalised
   * into something surprising: these strings end up in `location.assign`.
   *
   * @param {string} path
   * @param {string} [origin] the page's origin, so a full wardenfall.com URL
   *   is recognised as internal and stays inside the SPA.
   * @returns {{kind:"internal"|"external", href:string}|null}
   */
  function classifyPath(path, origin) {
    const raw = String(path == null ? "" : path).trim();
    if (!raw) return null;

    if (raw.startsWith("//")) return null; // protocol-relative: ambiguous, refuse
    if (raw.startsWith("/")) return { kind: "internal", href: raw };

    if (!/^https?:\/\//i.test(raw)) return null;
    let url;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (origin && url.origin === origin) {
      return { kind: "internal", href: url.pathname + url.search + url.hash };
    }
    return { kind: "external", href: url.href };
  }

  // --- souls ----------------------------------------------------------------

  /** Coerce a soul count into the allowed range. Never throws; used at render. */
  function clampSouls(value, fallback = SOULS_DEFAULT) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(SOULS_MAX, Math.max(SOULS_MIN, n));
  }

  // --- items ----------------------------------------------------------------

  let idCounter = 0;

  function newId() {
    const rand = globalThis.crypto?.randomUUID?.();
    if (rand) return "it-" + rand.slice(0, 8);
    idCounter += 1;
    return `it-${Date.now().toString(36)}-${idCounter}`;
  }

  function trimTo(value, max) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
  }

  /**
   * Check one entry and return a cleaned copy, or the reason it cannot be used.
   * The options editor shows `reason` inline; normalize() drops the entry and
   * reports it, so a bad row is never silently swallowed.
   *
   * @returns {{ok:true, item:Object}|{ok:false, reason:string}}
   */
  function validateItem(raw) {
    if (!raw || typeof raw !== "object") return { ok: false, reason: "not an entry" };

    const type = TYPES.includes(raw.type) ? raw.type : "url";
    const label = trimTo(raw.label, MAX_LABEL);
    if (!label) return { ok: false, reason: "needs a label" };

    const item = {
      id: typeof raw.id === "string" && raw.id ? raw.id : newId(),
      icon: trimTo(raw.icon, 4),
      label,
      type,
    };

    if (type === "url") {
      const path = String(raw.path == null ? "" : raw.path).trim();
      if (!path) return { ok: false, reason: "needs a path, e.g. /market" };
      if (!classifyPath(path)) {
        return { ok: false, reason: "path must start with / or be an http(s) URL" };
      }
      item.path = path;
      return { ok: true, item };
    }

    // Field order below mirrors DEFAULT_ITEMS so a normalized entry serialises
    // byte-identically to the seed it came from — otherwise exporting a config
    // that has merely been loaded shows a diff.
    if (type === "host") {
      // An empty field means "use the default", but a field with something
      // unreadable in it is an error — silently raising 10,000 when the user
      // typed "1oooo" would spend souls they did not agree to spend.
      const soulsRaw = raw.souls;
      if (soulsRaw === undefined || soulsRaw === null || String(soulsRaw).trim() === "") {
        item.souls = SOULS_DEFAULT;
      } else {
        const n = Number(String(soulsRaw).replace(/[,\s]/g, ""));
        if (!Number.isFinite(n) || Math.floor(n) !== n) {
          return { ok: false, reason: "souls must be a whole number" };
        }
        if (n < SOULS_MIN || n > SOULS_MAX) {
          return {
            ok: false,
            reason: `souls must be between ${SOULS_MIN} and ${SOULS_MAX.toLocaleString("en-US")}`,
          };
        }
        item.souls = n;
      }
    }

    // Both remaining types find their target the same way — by the visible
    // label of a nav entry, walking through a door first if need be. A `host`
    // entry defaults that journey so nobody has to know where the game filed
    // the rites this week, but both fields stay overridable because it moves.
    const wantsDefaults = type === "host";
    const rawMatch = String(raw.match == null ? "" : raw.match).trim();
    const matchSource = rawMatch || (wantsDefaults ? RITES_MATCH : "");

    const parsed = parsePattern(matchSource);
    if (parsed.error) return { ok: false, reason: parsed.error };
    item.match = matchSource;

    const rawDoor = String(raw.door == null ? "" : raw.door).trim();
    const door = rawDoor || (wantsDefaults ? RITES_DOOR : "");
    if (door) {
      if (!classifyPath(door)) {
        return { ok: false, reason: "door must start with / or be an http(s) URL" };
      }
      item.door = door;
    }
    return { ok: true, item };
  }

  /**
   * Bring a config forward a version.
   *
   * The only migration so far: v2 introduced the `host` entry, and DEFAULT_ITEMS
   * is not enough on its own — it is consulted only when a config has NO items,
   * so anyone already using the quick menu would never see the new button.
   * Appended once, and only if there is no host entry already; removing it then
   * sticks, because the version is stamped forward when the config is saved.
   *
   * @returns {boolean} whether anything changed, so the caller can persist it.
   */
  function migrate(config, fromVersion) {
    if (fromVersion >= VERSION) return false;
    // An empty rail is a choice, not an absence. Putting a button back into
    // one somebody deliberately cleared is exactly the sort of surprise a
    // migration must not spring.
    if (!config.dock.items.length) return false;
    if (config.dock.items.some((it) => it.type === "host")) return false;
    if (config.dock.items.length >= MAX_ITEMS) return false;
    const seed = DEFAULT_ITEMS.find((it) => it.type === "host");
    if (!seed) return false;
    config.dock.items.push({ ...seed, id: newId() });
    return true;
  }

  /**
   * Coerce whatever came out of storage (or an imported JSON blob) into a
   * usable config.
   *
   * @returns {{config:Object, problems:string[], migrated:boolean}} `problems`
   *   names every entry that had to be dropped, so the caller can say so out
   *   loud; `migrated` means the caller should write the result back, without
   *   which the migration would re-run (and undo a deletion) on every load.
   */
  function normalize(raw) {
    const base = defaults();
    const problems = [];
    if (!raw || typeof raw !== "object") return { config: base, problems, migrated: false };

    // Accept a bare dock section too, so a config hand-written (or exported by
    // an earlier build) as { side, items } still loads.
    const rawDock =
      raw.dock && typeof raw.dock === "object"
        ? raw.dock
        : Array.isArray(raw.items) || raw.side
          ? raw
          : {};

    const config = {
      version: VERSION,
      palette: {
        enabled: raw.palette?.enabled === undefined ? true : Boolean(raw.palette.enabled),
      },
      heroes: {
        enabled: raw.heroes?.enabled === undefined ? true : Boolean(raw.heroes.enabled),
        siege: typeof raw.heroes?.siege === "string" ? raw.heroes.siege.slice(0, 60) : "",
      },
      dock: {
        enabled: rawDock.enabled === undefined ? base.dock.enabled : Boolean(rawDock.enabled),
        side: SIDES.includes(rawDock.side) ? rawDock.side : base.dock.side,
        collapsed: Boolean(rawDock.collapsed),
        items: [],
      },
    };

    const from = Number(raw.version) || 1;

    if (!Array.isArray(rawDock.items)) {
      // No item list at all: the defaults already include everything current,
      // so there is nothing to migrate onto them.
      config.dock.items = base.dock.items;
      return { config, problems, migrated: false };
    }

    // A menu still identical to one we shipped is ours to keep current.
    if (isShippedMenu(rawDock.items)) {
      config.dock.items = base.dock.items;
      return { config, problems };
    }

    const seenIds = new Set();
    for (const candidate of rawDock.items.slice(0, MAX_ITEMS)) {
      const result = validateItem(migrateItem(candidate));
      if (!result.ok) {
        const name = candidate && candidate.label ? `"${candidate.label}"` : "an entry";
        problems.push(`${name} was dropped: ${result.reason}`);
        continue;
      }
      // Duplicate ids would make edit-by-id in the options page hit the wrong
      // row, so re-mint rather than trust the input.
      if (seenIds.has(result.item.id)) result.item.id = newId();
      seenIds.add(result.item.id);
      config.dock.items.push(result.item);
    }
    if (rawDock.items.length > MAX_ITEMS) {
      problems.push(`only the first ${MAX_ITEMS} entries were kept`);
    }
    const migrated = migrate(config, from);
    return { config, problems, migrated };
  }

  SEN.config = {
    STORAGE_KEY,
    VERSION,
    SIDES,
    TYPES,
    MAX_ITEMS,
    MAX_LABEL,
    SOULS_DEFAULT,
    SOULS_MIN,
    SOULS_MAX,
    RITES_MATCH,
    RITES_DOOR,
    defaults,
    foldLabel,
    parsePattern,
    matchesPattern,
    classifyPath,
    clampSouls,
    validateItem,
    migrateItem,
    isShippedMenu,
    normalize,
    migrate,
    newId,
  };
})();
