/**
 * config.js — the settings model for both of Seneschal's surfaces.
 *
 * One stored object covers everything:
 *
 *   { version, palette: { enabled },
 *              dock: { enabled, side, collapsed, items: [...] } }
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
 *       A destination with NO stable address — the game's sub-navigation is
 *       contextual, so CRAFTABLES / ARENA / HUNT only exist as clickable
 *       entries once you are already inside their parent door. `match` is a
 *       pattern tested against the VISIBLE LABEL of nav entries; `door` is
 *       where to go first when nothing on this page matches.
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
  const RITES_DOOR = "/empire";

  /**
   * The out-of-the-box menu. Deliberately shows off BOTH kinds: the four
   * primary doors have real paths, while BUILDINGS / CRAFTABLES / ARENA / HUNT
   * are contextual sub-nav reached by pattern. (Buildings has a path, but a
   * hard load of it is reported to render near-empty, so clicking is the
   * better route — exactly what a `menu` entry does.)
   */
  const DEFAULT_ITEMS = [
    { id: "seed-realm", icon: "🏰", label: "Realm", type: "url", path: "/empire" },
    { id: "seed-expeditions", icon: "🧭", label: "Expeditions", type: "url", path: "/expeditions" },
    { id: "seed-champions", icon: "⚔️", label: "Champions", type: "url", path: "/heroes" },
    { id: "seed-inventory", icon: "🎒", label: "Inventory", type: "url", path: "/inventory" },
    { id: "seed-buildings", icon: "🏛", label: "Buildings", type: "menu", match: "buildings", door: "/empire" },
    { id: "seed-craftables", icon: "🛠", label: "Craftables", type: "menu", match: "craftables", door: "/empire" },
    { id: "seed-arena", icon: "🗡", label: "Arena", type: "menu", match: "arena", door: "/expeditions" },
    { id: "seed-hunt", icon: "🐗", label: "Hunt", type: "menu", match: "hunt", door: "/expeditions" },
    { id: "seed-host", icon: "👻", label: "Raise host", type: "host", souls: SOULS_DEFAULT, match: RITES_MATCH, door: RITES_DOOR },
  ];

  function defaults() {
    return {
      version: VERSION,
      palette: { enabled: true },
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

    const seenIds = new Set();
    for (const candidate of rawDock.items.slice(0, MAX_ITEMS)) {
      const result = validateItem(candidate);
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
    normalize,
    migrate,
    newId,
  };
})();
