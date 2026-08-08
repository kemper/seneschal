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
 * Matching visible labels rather than class names or DOM shape is deliberate:
 * the game reorganised its whole navigation in v1.96 and ships patches most
 * days. Labels and URLs are the parts that survive.
 */
(function () {
  "use strict";

  const SEN = (globalThis.SEN = globalThis.SEN || {});

  const STORAGE_KEY = "seneschal.settings.v1";
  const VERSION = 1;
  const SIDES = ["left", "right"];
  const TYPES = ["url", "menu"];
  const MAX_ITEMS = 40;
  const MAX_LABEL = 32;

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

    const parsed = parsePattern(raw.match);
    if (parsed.error) return { ok: false, reason: parsed.error };
    item.match = String(raw.match).trim();

    const door = String(raw.door == null ? "" : raw.door).trim();
    if (door) {
      if (!classifyPath(door)) {
        return { ok: false, reason: "door must start with / or be an http(s) URL" };
      }
      item.door = door;
    }
    return { ok: true, item };
  }

  /**
   * Coerce whatever came out of storage (or an imported JSON blob) into a
   * usable config.
   *
   * @returns {{config:Object, problems:string[]}} `problems` names every entry
   *   that had to be dropped, so the caller can say so out loud.
   */
  function normalize(raw) {
    const base = defaults();
    const problems = [];
    if (!raw || typeof raw !== "object") return { config: base, problems };

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

    if (!Array.isArray(rawDock.items)) {
      config.dock.items = base.dock.items;
      return { config, problems };
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
    return { config, problems };
  }

  SEN.config = {
    STORAGE_KEY,
    VERSION,
    SIDES,
    TYPES,
    MAX_ITEMS,
    MAX_LABEL,
    defaults,
    foldLabel,
    parsePattern,
    matchesPattern,
    classifyPath,
    validateItem,
    normalize,
    newId,
  };
})();
