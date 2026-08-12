/**
 * heroes.js — hero roster, HP, and the heal driver.
 *
 * TWO HALVES, VERY DIFFERENT RISK PROFILES.
 *
 * Reading is free: `/heroes` is server-rendered and carries every hero's
 * name, class icon, level and current/max HP. One GET, parsed out of the HTML,
 * works from any page. The parsers here are pure so they can be unit tested
 * without a browser (test/heroes.test.mjs).
 *
 * Healing SPENDS RESOURCES, and there is no API for it. Measured on the live
 * site: the game drives mutations through Next.js Server Actions
 * (createServerReference x33, callServer x50) and the only /api/* routes are
 * peripheral reads — pending-count, unread-count, news, chat, logout. The heal
 * button's onClick is a plain closure with no exposed action reference, so
 * there is nothing to call directly, and a hand-built Next-Action POST would
 * depend on a per-build hash that changes with every deploy — daily, for this
 * game.
 *
 * So we drive the game's OWN button, in a hidden same-origin iframe. Measured:
 * loading /conquest and selecting a siege location issues only GETs (33 of
 * them, zero POSTs) and writes nothing to localStorage, so getting to the
 * button costs nothing and cannot disturb the page you are looking at. The
 * only mutation is the heal click itself, which is the thing you asked for.
 *
 * The handle we click by is `title="Heal <Name> for 4 <Resource>"` — visible,
 * human-readable text, which is the part of this game that survives. Never a
 * class name.
 */
(function () {
  "use strict";

  const SEN = (globalThis.SEN = globalThis.SEN || {});

  const HEROES_PATH = "/heroes";
  const CONQUEST_PATH = "/conquest";
  const CRAFTABLES_PATH = "/expeditions/buildings/craftables";
  const FRAME_LOAD_MS = 20000;
  const SETTLE_MS = 2500; // React hydration inside the frame
  const STEP_MS = 2000;
  const VERIFY_MS = 15000; // how long a heal has to show up on the server
  const VERIFY_EVERY_MS = 900;

  // --- parsing (pure) -------------------------------------------------------

  /**
   * Pull the roster out of /heroes' rendered text.
   *
   * The page prints the same heroes twice, in two different shapes, and we
   * need both: a roster row carrying the class icon and level
   * ("● 🔮 Krogdolf Lv50"), and an HP row carrying current/max
   * ("Heroes Krogdolf 489/489 · Krogloff 459/459"). Joined on name.
   *
   * @param {string} text  document.body.textContent, whitespace-collapsed
   * @returns {Array<{name,icon,level,hp,maxHp}>}
   */
  function parseHeroes(text) {
    const flat = String(text || "").replace(/\s+/g, " ");

    const meta = new Map();
    // Icon is optional: if the game drops the emoji, we still get name+level.
    for (const m of flat.matchAll(/(\p{Extended_Pictographic}️?)?\s*([A-Z][A-Za-z']{1,19})\s+Lv(\d{1,3})\b/gu)) {
      if (!meta.has(m[2])) meta.set(m[2], { icon: m[1] || "", level: Number(m[3]) });
    }

    const hp = new Map();
    for (const m of flat.matchAll(/([A-Z][A-Za-z']{1,19})\s+(\d{1,5})\s*\/\s*(\d{1,5})/g)) {
      const cur = Number(m[2]);
      const max = Number(m[3]);
      // A ratio is only an HP reading if it is plausible: max must be positive
      // and current must not exceed it. This rejects "900/70"-style pairs that
      // appear elsewhere on the page.
      if (max > 0 && cur <= max && !hp.has(m[1])) hp.set(m[1], { hp: cur, maxHp: max });
    }

    const out = [];
    for (const [name, h] of hp) {
      const m = meta.get(name);
      out.push({ name, icon: m ? m.icon : "", level: m ? m.level : null, hp: h.hp, maxHp: h.maxHp });
    }
    return out;
  }

  // A siege you are COMMITTED to renders a row of assault locations. A siege
  // merely named on the page does not — /conquest lists bulwarks you could
  // attack alongside ones you are in, so matching the name alone reported
  // three "active" sieges when there were none.
  const LOCATION = /\bThe (Gate|West Wall|East Wall|Postern Door|Postern|Yard|Inner Wall|Outer Wall|Keep|Regent's Hall)\b/i;
  const SIEGE_NAME = /The [A-Z][A-Za-z]+ Bulwark/;

  /**
   * Sieges you are actually in, by name. Empty when there are none — which is
   * the state that must disable healing rather than offering a siege that
   * cannot be healed from.
   *
   * Needs the DOM, not just text: the tie between a siege's name and its
   * location buttons is structural.
   *
   * @param {Document} doc a parsed /conquest document
   */
  function parseActiveSieges(doc) {
    if (!doc || !doc.querySelectorAll) return [];
    const buttons = [...doc.querySelectorAll("button")].filter((b) =>
      LOCATION.test((b.textContent || "").replace(/\s+/g, " "))
    );
    if (!buttons.length) return [];

    const names = new Set();
    for (const button of buttons) {
      let node = button;
      for (let hops = 0; node && hops < 10; hops++, node = node.parentElement) {
        const found = (node.textContent || "").replace(/\s+/g, " ").match(SIEGE_NAME);
        if (found) {
          names.add(found[0]);
          break;
        }
      }
    }
    // A siege with locations but no readable name is still a real siege.
    return names.size ? [...names] : ["the active siege"];
  }

  /** Bulwark names mentioned anywhere — NOT a list of sieges you are in. */
  function parseSiegeNames(text) {
    const flat = String(text || "").replace(/\s+/g, " ");
    return [...new Set((flat.match(/The [A-Z][A-Za-z]+ Bulwark/g) || []))];
  }

  // The game's own "heal all" control, on /heroes. It only renders when someone
  // is wounded, and it prices itself:
  //   "1 wounded · 79 HP to mend · brews 4 draughts: 48 timber · 24 iron"
  // That summary is the game's arithmetic, not ours — show it verbatim rather
  // than recomputing HP gaps and elixir counts and risking a different answer.
  const HEAL_ALL = /HEAL ALL HEROES/i;

  /**
   * @param {Document} doc a parsed /heroes document
   * @returns {{available:boolean, label:string, summary:string}}
   */
  function parseHealAll(doc) {
    const none = { available: false, label: "", summary: "" };
    if (!doc || !doc.querySelectorAll) return none;
    const button = [...doc.querySelectorAll("button")].find((b) => HEAL_ALL.test(b.textContent || ""));
    if (!button || button.disabled) return none;

    const label = (button.textContent || "").replace(/\s+/g, " ").trim();
    // The costing line sits beside the button; take the nearest ancestor that
    // carries it, then subtract the button's own text.
    let summary = "";
    let node = button;
    for (let hops = 0; node && hops < 5; hops++, node = node.parentElement) {
      const text = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (/wounded/i.test(text) && text.length > label.length) {
        // Keep only the costing itself: the surrounding block also carries a
        // "Mend the wounded" heading, which is redundant next to our button.
        summary = text
          .split(label)
          .join(" ")
          .replace(/\s+/g, " ")
          .replace(/^.*?(?=\d+\s+wounded)/i, "")
          .trim();
        break;
      }
    }
    return { available: true, label, summary };
  }

  // --- elixirs --------------------------------------------------------------

  // The craftables page holds one card per elixir. Each card knows what it
  // mends, what brewing costs, and how many you hold; a separate "Mend a Hero"
  // block appears for each elixir you actually hold, carrying the hero picker
  // and USE ON HERO. The two are tied together by the MEND AMOUNT, which is
  // the stable, meaningful key — +10, +25, +50.
  const ELIXIRS = [
    { key: "salveroot", name: "Salveroot Tonic", icon: "🧪" },
    { key: "knitbone", name: "Knitbone Draught", icon: "🍵" },
    { key: "wardenbalm", name: "Wardenbalm Elixir", icon: "💧" },
  ];

  const rendered = (el) => !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName);
  const flatten = (el) => (el.textContent || "").replace(/\s+/g, " ").trim();

  /**
   * Read every elixir's state off the craftables page.
   *
   * @param {Document} doc
   * @returns {Array<{key,name,icon,mend,cost,held,canCraft,canUse,reason}>}
   */
  function parseElixirs(doc) {
    if (!doc || !doc.querySelectorAll) return [];
    const all = [...doc.querySelectorAll("*")].filter(rendered);

    return ELIXIRS.map((elixir) => {
      // Smallest rendered element naming it — the card's title. Taking the
      // smallest matters: the page ships a <script> flight payload that
      // mentions every name, and any ancestor would swallow the whole page.
      const naming = all.filter((el) => flatten(el).includes(elixir.name));
      if (!naming.length) return { ...elixir, mend: null, cost: "", held: 0, canCraft: false, canUse: false, reason: "not on the page" };
      const title = naming.reduce((a, b) => (flatten(b).length < flatten(a).length ? b : a));

      let card = title;
      for (let hops = 0; hops < 10 && card; hops++, card = card.parentElement) {
        if ([...card.querySelectorAll("button")].some((b) => /^CRAFT$/i.test(flatten(b)))) break;
      }
      const text = card ? flatten(card) : "";
      const craft = card ? [...card.querySelectorAll("button")].find((b) => /^CRAFT$/i.test(flatten(b))) : null;

      const mend = Number((text.match(/mend \+(\d+) HP/i) || [])[1]) || null;
      const held = Number((text.match(/held:?\s*(\d+)/i) || [])[1]) || 0;
      const cost = (text.match(/([\d]+ [\w-]+(?: \+ [\d]+ [\w-]+)*)\s*CRAFT/i) || [])[1] || "";
      const canCraft = Boolean(craft && !craft.disabled);

      return {
        ...elixir,
        mend,
        cost,
        held,
        canCraft,
        canUse: held > 0 || canCraft,
        reason: held > 0 ? "" : canCraft ? `will brew one for ${cost}` : "cannot brew — not enough materials",
      };
    });
  }

  /** Fraction of max HP remaining, clamped. Used for the bar and its colour. */
  function hpFraction(hero) {
    if (!hero || !hero.maxHp) return 0;
    return Math.max(0, Math.min(1, hero.hp / hero.maxHp));
  }

  function isDamaged(hero) {
    return Boolean(hero && hero.maxHp && hero.hp < hero.maxHp);
  }

  // --- reading (network, read-only) ----------------------------------------

  // Every in-game navigation is a full page load, which cancels any request in
  // flight and rejects it as "Failed to fetch". That is routine, not a fault,
  // so it is tagged and callers stay quiet about it.
  let unloading = false;
  // Guarded: the parsers are unit tested in a bare sandbox with no DOM, and
  // this module has to stay loadable there.
  if (typeof addEventListener === "function") {
    addEventListener("pagehide", () => { unloading = true; }, { capture: true });
  }

  function isAbort(error) {
    return unloading || (error && (error.name === "AbortError" || /Failed to fetch/i.test(error.message || "")));
  }

  async function fetchText(path) {
    const res = await fetch(path, { credentials: "include" });
    if (!res.ok) throw new Error(`${path} returned ${res.status}`);
    return res.text();
  }

  function textOf(html) {
    return new DOMParser().parseFromString(html, "text/html").body.textContent || "";
  }

  async function loadHeroes() {
    return parseHeroes(textOf(await fetchText(HEROES_PATH)));
  }

  /** Roster and the heal-all offer in one read, since both live on /heroes. */
  async function loadRoster() {
    const doc = new DOMParser().parseFromString(await fetchText(HEROES_PATH), "text/html");
    return {
      heroes: parseHeroes(doc.body.textContent || ""),
      healAll: parseHealAll(doc),
    };
  }

  async function loadElixirs() {
    const html = await fetchText(CRAFTABLES_PATH);
    return parseElixirs(new DOMParser().parseFromString(html, "text/html"));
  }

  async function loadSieges() {
    const html = await fetchText(CONQUEST_PATH);
    return parseActiveSieges(new DOMParser().parseFromString(html, "text/html"));
  }

  // --- healing (the only mutating path) ------------------------------------

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Wait for the SERVER to agree that something changed.
   *
   * A heal is a Next.js Server Action followed by a re-render, and that round
   * trip is not a fixed cost — measured against a single 2s wait, heal-all
   * reported "did not take" on a heal that had in fact gone through. So poll
   * /heroes until the change shows up or the window closes, instead of reading
   * once and calling a slow success a failure.
   *
   * A read that fails is treated as "not yet": every in-game click is a full
   * page load, so a request can be cancelled mid-poll, and that is routine.
   *
   * @param {() => Promise<any>} read
   * @param {(value:any) => boolean} changed
   * @returns {Promise<any>} the last value read, changed or not
   */
  async function pollUntil(read, changed) {
    const deadline = Date.now() + VERIFY_MS;
    let latest = null;
    for (;;) {
      try {
        latest = await read();
        if (changed(latest)) return latest;
      } catch (e) {
        if (unloading) return latest;
      }
      if (Date.now() >= deadline) return latest;
      await wait(VERIFY_EVERY_MS);
    }
  }

  /**
   * A hidden same-origin frame for driving the game's own controls.
   *
   * Shared rather than heal-specific: the rites need exactly the same thing.
   * Measured (CLAUDE.md finding 11) — loading a page and selecting a control
   * costs GETs only, no POSTs and no storage writes, so getting to a button is
   * free and only the final click mutates anything.
   */
  function openFrame(path) {
    const frame = document.createElement("div");
    frame.setAttribute("data-seneschal", "frame"); // never indexed by the scanner
    const el = document.createElement("iframe");
    // Off-screen rather than display:none — a hidden frame can skip layout,
    // and the game's own click handlers want a laid-out document.
    el.style.cssText = "position:fixed;left:-10000px;top:0;width:1200px;height:900px;opacity:0;border:0";
    el.setAttribute("aria-hidden", "true");
    el.setAttribute("tabindex", "-1");
    el.src = path;
    frame.appendChild(el);
    document.documentElement.appendChild(frame);

    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${path} did not load in time`)), FRAME_LOAD_MS);
      el.addEventListener("load", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    return { host: frame, el, ready, close: () => frame.remove() };
  }

  const visibleText = (el) => (el.textContent || "").replace(/\s+/g, " ").trim();

  /**
   * Anything that commits an assault. We only ever click a siege name, a
   * location, and a Heal button — but the guard is here so that a future edit,
   * or a game that renames a location to something unfortunate, cannot turn
   * this into an attack.
   */
  const COMMITTING = /lay siege|all in|storm|assault now|attack now|confirm/i;

  /**
   * If a heal did not take, say what the page is showing instead of shrugging.
   *
   * The most likely explanation for a click that changes nothing is a modal
   * that appeared over it — a second-step confirmation, or the game's
   * ascension whisper, which intercepts pointer events app-wide. We report it
   * and stop; we never click through it blind, because on this game an
   * unidentified button can commit an assault.
   *
   * @returns {string} a short description, or "" if nothing is in the way
   */
  function blockedBy(doc) {
    if (!doc || !doc.querySelector) return "";
    const modal = doc.querySelector('[role="dialog"], [role="alertdialog"]');
    if (!modal) return "";
    const text = visibleText(modal).slice(0, 90);
    return text ? `a dialog is in the way: "${text}"` : "a dialog is in the way";
  }

  function clickByText(doc, matcher, what) {
    const btn = [...doc.querySelectorAll("button, a[href]")].find((b) => matcher(visibleText(b)));
    if (!btn) throw new Error(`could not find ${what}`);
    if (COMMITTING.test(visibleText(btn))) throw new Error(`refusing to click "${visibleText(btn)}" — that commits an assault`);
    if (btn.disabled) throw new Error(`${what} is disabled`);
    btn.click();
    return btn;
  }

  /**
   * Heal one hero from anywhere, by driving the game's own button in a hidden
   * frame. Resolves with the HP before and after, read back from /heroes, so
   * the caller can prove it worked rather than assume it.
   *
   * @param {{heroName:string, siege?:string}} opts
   */
  async function heal({ heroName, siege }) {
    if (!heroName) throw new Error("no hero given");

    const before = (await loadHeroes()).find((h) => h.name === heroName);
    if (!before) throw new Error(`${heroName} is not in the roster`);
    if (!isDamaged(before)) throw new Error(`${heroName} is already at full health`);

    // Healing draws on a siege's provisions, so being in one is a precondition
    // rather than something to discover halfway through the frame dance.
    if (!(await loadSieges()).length) {
      throw new Error("no siege is active — provisions healing needs one");
    }

    const frame = openFrame(CONQUEST_PATH);
    try {
      await frame.ready;
      await wait(SETTLE_MS);
      const doc = frame.el.contentDocument;
      if (!doc) throw new Error("could not reach the siege page");

      // Optional: switch to a named siege before picking a location.
      if (siege) {
        const found = [...doc.querySelectorAll("button, a[href]")].find((b) => visibleText(b).includes(siege));
        if (found && !COMMITTING.test(visibleText(found))) {
          found.click();
          await wait(STEP_MS);
        }
      }

      // A location has to be selected before the provisions panel exists. This
      // is client-side only — measured: no request, no storage write — and it
      // happens in a throwaway document, so it cannot change what you have
      // selected on screen.
      const target = [...doc.querySelectorAll("button")].find(
        (b) => /The (Gate|West Wall|East Wall|Postern|Yard|Inner Wall|Keep|Regent)/i.test(visibleText(b))
          && !COMMITTING.test(visibleText(b))
      );
      if (!target) throw new Error("no siege location to select — is a siege actually active?");
      target.click();
      await wait(STEP_MS);

      const healBtn = [...doc.querySelectorAll("button[title]")].find((b) =>
        new RegExp(`^Heal\\s+${heroName}\\b`, "i").test(b.getAttribute("title") || "")
      );
      if (!healBtn) throw new Error(`no heal button for ${heroName} on this siege`);
      if (healBtn.disabled) throw new Error(`the heal button for ${heroName} is disabled`);

      const cost = healBtn.getAttribute("title");
      healBtn.click();

      // Verify against the server rather than trusting the click, and give it
      // as long as the round trip actually takes.
      const after = await pollUntil(
        async () => (await loadHeroes()).find((h) => h.name === heroName),
        (h) => Boolean(h && h.hp > before.hp)
      );
      const healed = Boolean(after && after.hp > before.hp);
      return {
        healed,
        cost,
        before: before.hp,
        after: after ? after.hp : null,
        maxHp: before.maxHp,
        blocked: healed ? false : blockedBy(doc),
      };
    } finally {
      frame.close();
    }
  }

  /**
   * Press the game's own "heal all" button, in a hidden frame. It brews
   * whatever draughts are needed and spends the resources it quoted.
   *
   * Verified by total HP across the roster, not by the click returning.
   */
  async function healAll() {
    const before = await loadHeroes();
    const hurt = before.filter(isDamaged);
    if (!hurt.length) throw new Error("nobody is wounded");
    const totalBefore = before.reduce((sum, h) => sum + h.hp, 0);

    const frame = openFrame(HEROES_PATH);
    try {
      await frame.ready;
      await wait(SETTLE_MS);
      const doc = frame.el.contentDocument;
      if (!doc) throw new Error("could not reach the champions page");

      const button = [...doc.querySelectorAll("button")].find((b) => HEAL_ALL.test(b.textContent || ""));
      if (!button) throw new Error("no heal-all button — is anyone actually wounded?");
      if (button.disabled) throw new Error("the heal-all button is disabled");
      button.click();

      // Heal-all brews the draughts it needs and then spends them, so it is the
      // SLOWEST action here — this is the one that a fixed wait misread as a
      // failure while the heal was still in flight.
      const after = await pollUntil(
        () => loadHeroes(),
        (roster) => Boolean(roster && roster.reduce((sum, h) => sum + h.hp, 0) > totalBefore)
      );
      const totalAfter = (after || before).reduce((sum, h) => sum + h.hp, 0);
      const healed = totalAfter > totalBefore;
      return {
        healed,
        gained: totalAfter - totalBefore,
        wounded: hurt.length,
        blocked: healed ? false : blockedBy(doc),
      };
    } finally {
      frame.close();
    }
  }

  /**
   * Heal a hero with a NAMED elixir, brewing one first if none is held.
   *
   * Which elixir is never inferred: a single "heal" button once spent a
   * Wardenbalm (+50 HP, the scarcest) closing a 79 HP gap, which is exactly
   * the ambiguity this signature removes.
   *
   * React tracks input values, so the hero dropdown is set through the native
   * setter and given a real change event — assigning `.value` alone leaves
   * React believing nothing was chosen.
   *
   * @param {{heroName:string, key:string}} opts  `key` is an ELIXIRS key
   */
  async function healWithElixir({ heroName, key }) {
    const wanted = ELIXIRS.find((e) => e.key === key);
    if (!wanted) throw new Error(`unknown elixir "${key}"`);

    const before = (await loadHeroes()).find((h) => h.name === heroName);
    if (!before) throw new Error(`${heroName} is not in the roster`);
    if (!isDamaged(before)) throw new Error(`${heroName} is already at full health`);

    const frame = openFrame(CRAFTABLES_PATH);
    try {
      await frame.ready;
      await wait(SETTLE_MS);
      const doc = frame.el.contentDocument;
      if (!doc) throw new Error("could not reach the craftables page");

      const state = parseElixirs(doc).find((e) => e.key === key);
      if (!state || !state.mend) throw new Error(`${wanted.name} is not on the craftables page`);

      // Brew one first if the shelf is empty. This spends materials, which is
      // why the caller has already quoted `cost` to the user.
      if (state.held < 1) {
        if (!state.canCraft) throw new Error(`no ${wanted.name} held, and not enough materials to brew one`);
        const naming = [...doc.querySelectorAll("*")].filter((el) => rendered(el) && flatten(el).includes(wanted.name));
        const titleEl = naming.reduce((a, b) => (flatten(b).length < flatten(a).length ? b : a));
        let card = titleEl;
        for (let hops = 0; hops < 10 && card; hops++, card = card.parentElement) {
          if ([...card.querySelectorAll("button")].some((b) => /^CRAFT$/i.test(flatten(b)))) break;
        }
        const craft = [...card.querySelectorAll("button")].find((b) => /^CRAFT$/i.test(flatten(b)));
        if (!craft || craft.disabled) throw new Error(`cannot brew ${wanted.name}`);
        craft.click();
        await wait(STEP_MS);
      }

      // The "Mend a Hero · +N HP" block for THIS elixir, keyed on its mend.
      const blocks = [...doc.querySelectorAll("*")].filter(
        (el) => rendered(el) && new RegExp(`Mend a Hero\\s*·?\\s*\\+${state.mend} HP`, "i").test(flatten(el))
      );
      if (!blocks.length) throw new Error(`no "use" control for ${wanted.name} — brewing may not have taken`);
      const block = blocks.reduce((a, b) => (flatten(b).length < flatten(a).length ? b : a));
      let panel = block;
      for (let hops = 0; hops < 10 && panel; hops++, panel = panel.parentElement) {
        if (panel.querySelector && panel.querySelector("select") && [...panel.querySelectorAll("button")].some((b) => /USE ON HERO/i.test(flatten(b)))) break;
      }
      if (!panel) throw new Error(`could not find the hero picker for ${wanted.name}`);

      const select = panel.querySelector("select");
      const option = [...select.options].find((o) => o.textContent.includes(heroName));
      if (!option) throw new Error(`${heroName} is not offered in the hero picker`);

      const view = frame.el.contentWindow;
      const setValue = Object.getOwnPropertyDescriptor(view.HTMLSelectElement.prototype, "value").set;
      setValue.call(select, option.value);
      select.dispatchEvent(new view.Event("change", { bubbles: true }));
      await wait(700);

      const use = [...panel.querySelectorAll("button")].find((b) => /USE ON HERO/i.test(flatten(b)));
      if (!use || use.disabled) throw new Error(`USE ON HERO is unavailable for ${wanted.name}`);
      use.click();

      const after = await pollUntil(
        async () => (await loadHeroes()).find((h) => h.name === heroName),
        (h) => Boolean(h && h.hp > before.hp)
      );
      const healed = Boolean(after && after.hp > before.hp);
      return {
        healed,
        blocked: healed ? false : blockedBy(doc),
        elixir: wanted.name,
        brewed: state.held < 1,
        before: before.hp,
        after: after ? after.hp : null,
        maxHp: before.maxHp,
      };
    } finally {
      frame.close();
    }
  }

  SEN.heroes = {
    parseHeroes,
    parseHealAll,
    parseElixirs,
    loadElixirs,
    loadRoster,
    ELIXIRS,
    healAll,
    healWithElixir,
    parseActiveSieges,
    parseSiegeNames,
    isAbort,
    hpFraction,
    isDamaged,
    loadHeroes,
    loadSieges,
    heal,
    HEROES_PATH,
    CONQUEST_PATH,
    openFrame,
    pollUntil,
    wait,
    SETTLE_MS,
    STEP_MS,
  };
})();
