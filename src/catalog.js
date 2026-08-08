/**
 * catalog.js — seed list of known destinations.
 *
 * WHY THIS EXISTS: Wardenfall's sub-navigation is CONTEXTUAL. Only the six
 * primary doors (REALM / EXPEDITIONS / CHAMPIONS / INVENTORY / LORE / RANKINGS)
 * are present on every page; second-row entries like BUILDINGS, DELVE, ARENA or
 * HUNT only render once you are already inside their parent door. So a palette
 * that scanned *only* the current header could never offer you the thing you
 * actually want to jump to.
 *
 * Three sources feed the index, in descending trust:
 *   1. live scan of the header right now          (scanner.js)
 *   2. everything we have EVER seen in a header   (learned + persisted)
 *   3. this seed catalog                          (so it is useful on install)
 *
 * Entries here are best-effort and safe to edit. `path` may be null for items
 * that are only reachable by clicking (see the note on /buildings below).
 */
(function () {
  "use strict";

  const SEN = (globalThis.SEN = globalThis.SEN || {});

  SEN.catalog = [
    // ---- primary doors -----------------------------------------------------
    { label: "Realm", path: "/empire", group: "Realm", keywords: "empire dashboard home overview" },
    { label: "Expeditions", path: "/expeditions", group: "Expeditions", keywords: "raids leads scouting board" },
    { label: "Champions", path: "/heroes", group: "Champions", keywords: "heroes armory gear party" },
    { label: "Inventory", path: "/inventory", group: "Inventory", keywords: "trove trinkets items" },
    { label: "Lore", path: "/lore", group: "Lore", keywords: "codex whispers guide" },
    { label: "Rankings", path: "/rankings", group: "Rankings", keywords: "leaderboard score rivals" },

    // ---- realm sub-nav -----------------------------------------------------
    // NOTE: a hard page load of /buildings renders near-empty; it only paints
    // when reached by clicking the nav link. activate() therefore always
    // prefers clicking a live anchor over assigning location. See README.
    { label: "Buildings", path: "/buildings", group: "Realm", keywords: "works construct upgrade treasury granary", clickOnly: true },
    { label: "Craftables", path: null, group: "Realm", keywords: "craft scout pack siege kit war banner greedsight elixir" },
    { label: "Market", path: "/market", group: "Realm", keywords: "land buy sell food commodity trade" },
    { label: "Military", path: "/military", group: "Realm", keywords: "army soldiers recruit units" },
    { label: "Statecraft", path: "/diplomacy", group: "Realm", keywords: "diplomacy alliances pacts espionage" },
    { label: "Messages", path: "/messages", group: "Realm", keywords: "inbox mail events news" },
    { label: "Necromancy", path: null, group: "Realm", keywords: "crypt souls rites dark" },
    { label: "Stable", path: null, group: "Realm", keywords: "horses couriers turns" },

    // ---- expeditions sub-nav ----------------------------------------------
    { label: "Conquest", path: "/conquest", group: "Expeditions", keywords: "siege fortress realms march" },
    { label: "Sieges", path: null, group: "Expeditions", keywords: "conquest walls assault" },
    { label: "Delve", path: null, group: "Expeditions", keywords: "dungeon depths abyssal descend" },
    { label: "Arena", path: null, group: "Expeditions", keywords: "duels hex combat champion" },
    { label: "Holds", path: null, group: "Expeditions", keywords: "contested territory king of the hill" },
    { label: "Hunt", path: null, group: "Expeditions", keywords: "greatboar monster quarry co-op" },
    { label: "War", path: null, group: "Expeditions", keywords: "war room attack espionage covert spy" },
    { label: "Engines", path: null, group: "Expeditions", keywords: "siege workshop trebuchet" },

    // ---- champions sub-nav -------------------------------------------------
    { label: "Spellbook", path: null, group: "Champions", keywords: "spells mage wizard tower arcane" },
  ];
})();
