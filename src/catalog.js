/**
 * catalog.js — the destination list.
 *
 * HARVESTED FROM THE LIVE SITE on 2026-08-08, by fetching all 19 reachable
 * nav pages and diffing their navigation rows. Before that, this file was
 * written from captured page text and was wrong in ways that mattered:
 * `/buildings`, `/lore`, `/inventory` and `/craftables` were all invented and
 * all return 404. Regenerate with tools/harvest-nav.js rather than by hand.
 *
 * WHAT THE MEASUREMENT SHOWED
 *
 * Wardenfall's sub-navigation is contextual, and now with numbers: of 35
 * distinct nav entries across 19 pages, exactly SIX appear on all of them —
 * REALM · EXPEDITIONS · CHAMPIONS · INVENTORY · LORE · RANKINGS. Everything
 * else is 8/19 (the Expeditions row), 5/19 (the Realm row), or 2/19 and below.
 * A palette that scanned only the current page could never offer you the rest,
 * which is why the index merges a live scan, a learned index, and this file.
 *
 * TWO TRAPS IN THE URLS, both of which the old guesses fell into:
 *   - the path often does NOT match the door. Buildings lives under
 *     /expeditions/buildings but renders the REALM row; Inventory is a primary
 *     door at /expeditions/inventory; Craftables is three levels deep at
 *     /expeditions/buildings/craftables.
 *   - LORE is /quests, not /lore.
 *
 * `group` is the door whose sub-nav row the entry appears in — which is what a
 * human means by where something lives, and is not always derivable from path.
 */
(function () {
  "use strict";

  const SEN = (globalThis.SEN = globalThis.SEN || {});

  SEN.catalog = [
    // ---- the six primary doors, present on every page ---------------------
    { label: "Realm", path: "/empire", group: "Doors", keywords: "empire dashboard home overview" },
    { label: "Expeditions", path: "/expeditions", group: "Doors", keywords: "raids leads scouting board" },
    { label: "Champions", path: "/heroes", group: "Doors", keywords: "heroes armory gear party" },
    { label: "Inventory", path: "/expeditions/inventory", group: "Doors", keywords: "trove trinkets items bag" },
    { label: "Lore", path: "/quests", group: "Doors", keywords: "codex whispers guide quests" },
    { label: "Rankings", path: "/rankings", group: "Doors", keywords: "leaderboard score rivals" },

    // ---- Realm row --------------------------------------------------------
    { label: "Empire", path: "/empire", group: "Realm", keywords: "overview summary home" },
    { label: "Buildings", path: "/expeditions/buildings", group: "Realm", keywords: "works construct upgrade treasury granary" },
    { label: "Market", path: "/market", group: "Realm", keywords: "land buy sell food commodity trade" },
    { label: "Military", path: "/military", group: "Realm", keywords: "army soldiers recruit units" },
    { label: "Statecraft", path: "/diplomacy", group: "Realm", keywords: "diplomacy alliances pacts espionage" },

    // ---- Expeditions row --------------------------------------------------
    { label: "Raids", path: "/expeditions", group: "Expeditions", keywords: "leads scouting board expeditions" },
    { label: "Holds", path: "/holds", group: "Expeditions", keywords: "contested territory king of the hill" },
    { label: "🐗 Hunt", path: "/hunt", group: "Expeditions", keywords: "greatboar monster quarry co-op" },
    { label: "Delve", path: "/delve", group: "Expeditions", keywords: "dungeon depths abyssal descend" },
    { label: "Arena", path: "/arena", group: "Expeditions", keywords: "duels hex combat champion pvp" },
    { label: "Sieges", path: "/conquest", group: "Expeditions", keywords: "conquest walls assault fortress march" },
    { label: "🏗️ Engines", path: "/siegeworks", group: "Expeditions", keywords: "siege workshop trebuchet siegeworks" },
    { label: "⚔ War", path: "/attack", group: "Expeditions", keywords: "war room attack espionage covert spy" },

    // ---- Champions row ----------------------------------------------------
    { label: "Heroes", path: "/heroes", group: "Champions", keywords: "roster party champions" },
    { label: "🐎 Stable", path: "/stable", group: "Champions", keywords: "horses couriers turns mounts" },
    { label: "Spellbook", path: "/spellbook", group: "Champions", keywords: "spells mage wizard tower arcane" },
    { label: "🜃 Ash", path: "/expeditions/ash", group: "Champions", keywords: "ash burn remains" },
    { label: "⚗️ Rites", path: "/heroes/rites", group: "Champions", keywords: "ritual ceremony alchemy" },
    { label: "⛪ Path", path: "/heroes/path", group: "Champions", keywords: "class progression devotion" },
    { label: "⚱️ Unbinding", path: "/heroes/unbinding", group: "Champions", keywords: "release unbind free" },
    { label: "⚰ Necromancy", path: "/expeditions/buildings/necromancy", group: "Champions", keywords: "crypt souls rites dark" },

    // ---- Inventory row ----------------------------------------------------
    { label: "🛠 Craftables", path: "/expeditions/buildings/craftables", group: "Inventory", keywords: "craft scout pack siege kit war banner greedsight elixir" },

    // ---- Lore row ---------------------------------------------------------
    { label: "Whispers", path: "/quests", group: "Lore", keywords: "quests rumours tasks" },
    { label: "🗺️ Atlas", path: "/expeditions/locations", group: "Lore", keywords: "map locations places" },
    { label: "📖 Codex", path: "/expeditions/relics", group: "Lore", keywords: "relics artifacts collection" },
    { label: "📕 Tome", path: "/expeditions/equipment", group: "Lore", keywords: "equipment gear reference" },

    // ---- Rankings row -----------------------------------------------------
    // NOTE: this renders as "Messages 153" — the label carries a live unread
    // count. Anything matching on the visible label must not depend on it.
    { label: "Messages", path: "/messages", group: "Rankings", keywords: "inbox mail events unread" },
    { label: "News", path: "/news", group: "Rankings", keywords: "announcements patch notes updates" },
    { label: "Invite", path: "/referral", group: "Rankings", keywords: "referral friends recruit" },
  ];
})();
