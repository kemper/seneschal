/**
 * necro.js — reading and driving the Rites of Remembrance.
 *
 * Raising a spectral host is the first thing Seneschal does that SPENDS
 * something. Everything else in this extension navigates; this clicks a button
 * that consumes souls, and — when souls are short — sacrifices living veterans
 * to make more. Both are irreversible. That single fact drives every design
 * choice in here:
 *
 *   1. PARSE, DON'T ASSUME. Nothing acts on a rite it has not first read a
 *      number off. If the balance line cannot be found, we refuse.
 *   2. REFUSE RATHER THAN GUESS. Every locator below can come back null, and
 *      every caller treats null as "stop and say so", never as "try anyway".
 *   3. VERIFY EVERY WRITE. Setting the host size checks the field actually
 *      took the value; clicking harvest checks the balance actually moved.
 *      A click that changes nothing halts the run instead of repeating.
 *
 * WHERE THE VOCABULARY COMES FROM — READ THIS BEFORE TRUSTING IT.
 * The strings matched here were reconstructed from a capture of the rites
 * panel taken 2026-07-01, when it still lived on /expeditions:
 *
 *     [ RITES OF REMEMBRANCE ]
 *     ⚰️ WAR CEMETERY
 *     💀 4,120 souls · Disturbance 12/50
 *     👻 Spectral Host · +6 disturb
 *     💀 Soul-Harvest · +4 disturb
 *     🕯️ Rite of Honor · -8 disturb
 *     PERFORM · +240 SOULS
 *
 * v1.96 moved the panel to REALM › NECROMANCY. Nobody has since captured its
 * DOM, so the SHAPE below (a card per rite, a number field, a PERFORM button)
 * is inferred, not measured. `tools/harvest-necromancy.js` is what turns it
 * into fact — run it before relying on any of this. Until then the refusals
 * above are load-bearing, not defensive padding.
 */
(function () {
  "use strict";

  const SEN = (globalThis.SEN = globalThis.SEN || {});

  // How many times we will click a harvest button in one run. Each click is a
  // permanent sacrifice, so this is a hard stop, not a retry budget.
  const MAX_HARVESTS = 40;

  // The soul bounds live in config.js, which is the single authority on what a
  // valid entry holds (CLAUDE.md); read lazily so load order does not matter.
  const clampSouls = (v, fallback) => SEN.config.clampSouls(v, fallback);

  /** The rites we know how to drive, by folded label. */
  const RITE = {
    host: { needle: "spectralhost", name: "Spectral Host" },
    harvest: { needle: "soulharvest", name: "Soul-Harvest" },
  };

  // --- numbers --------------------------------------------------------------

  /**
   * Read an integer out of a rendered number, tolerating the separators a UI
   * might use: "12,340" / "12 340" / "12 340" (narrow no-break space).
   * @returns {number|null} null when there is no digit at all, so a caller can
   *   tell "absent" from a genuine zero.
   */
  function toInt(raw) {
    if (raw == null) return null;
    const digits = String(raw).replace(/[^0-9]/g, "");
    if (!digits) return null;
    const n = Number(digits);
    return Number.isFinite(n) ? n : null;
  }

  /** Thousands-separated, for anything the user reads and compares. */
  function formatCount(n) {
    return Number(n || 0).toLocaleString("en-US");
  }

  /** Short form for the rail badge, where there is room for four characters. */
  function formatShort(n) {
    const v = Number(n || 0);
    if (v < 1000) return String(v);
    if (v < 1000000) {
      const k = v / 1000;
      return (k < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)) + "k";
    }
    const m = v / 1000000;
    return (m < 10 ? m.toFixed(1).replace(/\.0$/, "") : Math.round(m)) + "m";
  }

  /** "4 minutes ago" — the balance is a cache, so its age is part of the reading. */
  function formatAge(at, now = Date.now()) {
    const ms = Math.max(0, now - (at || 0));
    const mins = Math.round(ms / 60000);
    if (mins < 1) return "just now";
    if (mins === 1) return "1 minute ago";
    if (mins < 60) return `${mins} minutes ago`;
    const hours = Math.round(mins / 60);
    if (hours === 1) return "1 hour ago";
    if (hours < 48) return `${hours} hours ago`;
    return `${Math.round(hours / 24)} days ago`;
  }

  // --- reading the panel ----------------------------------------------------

  /**
   * Pull the soul balance out of rendered page text.
   *
   * Requires a DIGIT immediately before the word, so the rite blurbs ("Call
   * the restless dead to give up their souls") cannot be mistaken for a
   * balance. Disturbance is optional: it is a warning input, not a gate, and
   * a panel redesign that drops it should not block raising a host.
   *
   * @returns {{souls:number, disturbance:number|null, tolerance:number|null}|null}
   */
  function parseBalance(text) {
    const s = String(text == null ? "" : text);

    const souls = /([0-9][0-9,.   ]*)\s*souls?\b/i.exec(s);
    if (!souls) return null;
    const count = toInt(souls[1]);
    if (count == null) return null;

    const disturb = /disturbance[^0-9]{0,4}([0-9][0-9,.   ]*)\s*\/\s*([0-9][0-9,.   ]*)/i.exec(s);
    return {
      souls: count,
      disturbance: disturb ? toInt(disturb[1]) : null,
      tolerance: disturb ? toInt(disturb[2]) : null,
    };
  }

  /**
   * How many souls a rite button says it will yield or cost.
   * "PERFORM · +240 SOULS" → +240; "PERFORM · −10,000 SOULS" → -10000.
   * @returns {number|null} null when the button does not quantify itself.
   */
  function parseSoulDelta(label) {
    const m = /([+−–-])\s*([0-9][0-9,.   ]*)\s*souls?\b/i.exec(String(label || ""));
    if (!m) return null;
    const n = toInt(m[2]);
    if (n == null) return null;
    return m[1] === "+" ? n : -n;
  }

  /** How much disturbance a rite header advertises: "👻 Spectral Host · +6 disturb". */
  function parseDisturbDelta(label) {
    const m = /([+−–-])\s*([0-9]+)\s*disturb/i.exec(String(label || ""));
    if (!m) return null;
    const n = toInt(m[2]);
    if (n == null) return null;
    return m[1] === "+" ? n : -n;
  }

  // --- planning -------------------------------------------------------------

  /**
   * Work out what raising `want` ghosts actually entails, given what we read.
   *
   * Pure: no DOM, no clicking. The dock renders this straight into the
   * confirmation modal, so the user approves the same object that then runs.
   *
   * @returns {{kind:"raise"|"harvest"|"blocked", ...}} `kind` is the decision:
   *   raise    — enough souls in hand, one click
   *   harvest  — short, and sacrificing can cover it (DESTRUCTIVE)
   *   blocked  — short, and we cannot or should not cover it
   */
  function plan({ have, want, perHarvest = null, disturbance = null, tolerance = null, harvestDisturb = null, raiseDisturb = null }) {
    const target = clampSouls(want);
    const held = Math.max(0, Number(have) || 0);

    const projectDisturb = (harvests) => {
      if (disturbance == null) return null;
      return disturbance + (raiseDisturb || 0) + (harvestDisturb || 0) * harvests;
    };
    const finish = (p) => {
      const after = projectDisturb(p.harvests || 0);
      return {
        ...p,
        have: held,
        want: target,
        disturbance,
        tolerance,
        disturbanceAfter: after,
        // Crossing tolerance turns the grounds Haunted — a standing support
        // drain. Worth saying out loud before the click, not after.
        disturbanceWarning: after != null && tolerance != null && after > tolerance,
      };
    };

    if (held >= target) {
      return finish({ kind: "raise", raise: target, harvests: 0, remaining: held - target });
    }

    const shortfall = target - held;
    if (!perHarvest || perHarvest <= 0) {
      // Either there is no harvest rite on the page or its button does not say
      // what it yields. Guessing a yield would mean clicking a sacrifice an
      // unknown number of times; offer the smaller host instead.
      return finish({
        kind: "blocked",
        shortfall,
        harvests: 0,
        reason: perHarvest === 0 || perHarvest === null ? "no-harvest" : "unknown-yield",
        canRaiseInstead: held > 0 ? held : 0,
      });
    }

    const harvests = Math.ceil(shortfall / perHarvest);
    if (harvests > MAX_HARVESTS) {
      return finish({
        kind: "blocked",
        shortfall,
        harvests,
        reason: "too-many-harvests",
        perHarvest,
        canRaiseInstead: held > 0 ? held : 0,
      });
    }

    return finish({
      kind: "harvest",
      raise: target,
      shortfall,
      harvests,
      perHarvest,
      projected: held + harvests * perHarvest,
      remaining: held + harvests * perHarvest - target,
      // There is always a non-destructive alternative when we hold anything at
      // all: raise the host the souls already cover. Offering it beside the
      // sacrifice is the difference between a choice and an ultimatum.
      canRaiseInstead: held > 0 ? held : 0,
    });
  }

  /** One line of plain English for the modal — the sentence the user approves. */
  function describe(p) {
    if (!p) return "";
    if (p.kind === "raise") {
      return `Raise ${formatCount(p.raise)} ghosts for ${formatCount(p.raise)} souls, leaving ${formatCount(p.remaining)}.`;
    }
    if (p.kind === "harvest") {
      return (
        `You hold ${formatCount(p.have)} souls — ${formatCount(p.shortfall)} short. ` +
        `Soul-Harvest ${p.harvests}× (about ${formatCount(p.perHarvest)} souls each, paid in living veterans), ` +
        `then raise ${formatCount(p.raise)}.`
      );
    }
    if (p.reason === "too-many-harvests") {
      return `You hold ${formatCount(p.have)} souls. Covering ${formatCount(p.shortfall)} more would take ${formatCount(p.harvests)} sacrifices — past the ${MAX_HARVESTS} this will do in one go.`;
    }
    if (p.reason === "unknown-yield") {
      return `You hold ${formatCount(p.have)} souls — ${formatCount(p.shortfall)} short. The Soul-Harvest button does not say how many souls it yields, so this will not click it blind.`;
    }
    return `You hold ${formatCount(p.have)} souls — ${formatCount(p.shortfall)} short, and there is no Soul-Harvest rite on this page.`;
  }

  // --- finding things on the page -------------------------------------------

  const BLOCKS = "div,section,article,li,form,fieldset,td";

  /**
   * Find the card for one rite: the smallest block that names it AND holds a
   * button, without also naming a DIFFERENT rite.
   *
   * That last clause is the whole point. Walking up from a label to find a
   * button is easy to get subtly wrong — one hop too far and you are holding
   * the container for ALL the rites, whose first button belongs to whichever
   * rite happens to render first. Clicking that is how you sacrifice veterans
   * while trying to raise ghosts. So an over-walk is detected and refused.
   *
   * @returns {{el:Element, buttons:Element[]}|null}
   */
  function findRiteCard(key, doc = document) {
    const rite = RITE[key];
    if (!rite) return null;
    const fold = SEN.config.foldLabel;
    const others = Object.keys(RITE).filter((k) => k !== key).map((k) => RITE[k].needle);

    const naming = [...doc.querySelectorAll(BLOCKS)].filter((el) => {
      if (SEN.scanner.isOurs(el) || !SEN.scanner.isVisible(el)) return false;
      return fold(el.textContent).includes(rite.needle);
    });
    if (!naming.length) return null;

    // Smallest text first: the innermost block naming the rite is the one
    // closest to its own controls.
    naming.sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);

    let node = naming[0];
    for (let hops = 0; node && hops < 6; hops++) {
      const folded = fold(node.textContent);
      if (others.some((needle) => folded.includes(needle))) return null; // over-walked
      const buttons = [...node.querySelectorAll('button, [role="button"]')].filter(
        (b) => !SEN.scanner.isOurs(b) && SEN.scanner.isVisible(b)
      );
      if (buttons.length) return { el: node, buttons };
      node = node.parentElement;
    }
    return null;
  }

  /**
   * The button inside a card that actually performs the rite. Prefers one that
   * says PERFORM; falls back to the only button there is. Two unlabelled
   * candidates is ambiguous, and ambiguous means refuse.
   */
  function performButton(card) {
    if (!card || !card.buttons.length) return null;
    const named = card.buttons.filter((b) =>
      /perform|raise|invoke|enact/i.test(SEN.scanner.labelOf(b))
    );
    if (named.length === 1) return named[0];
    if (named.length > 1) {
      // Several: take the one that quantifies itself, which is the real action
      // rather than a help link styled as a button.
      const quantified = named.filter((b) => parseSoulDelta(SEN.scanner.labelOf(b)) != null);
      return quantified.length === 1 ? quantified[0] : named[0];
    }
    return card.buttons.length === 1 ? card.buttons[0] : null;
  }

  /** The number field for the host size, if the card has one. */
  function sizeInput(card) {
    if (!card) return null;
    const inputs = [...card.el.querySelectorAll("input")].filter(
      (el) => !SEN.scanner.isOurs(el) && SEN.scanner.isVisible(el) && el.type !== "checkbox" && el.type !== "radio"
    );
    if (inputs.length === 1) return inputs[0];
    return inputs.find((el) => el.type === "number") || null;
  }

  /**
   * Put a number into a controlled input so the app actually notices.
   *
   * React installs its own `value` setter on the node and dedupes against a
   * cached copy, so a plain `el.value = n` updates the pixels and leaves the
   * app's state untouched — you then click PERFORM and it uses the OLD number.
   * Going through the prototype's native setter sidesteps that, and the input
   * event tells the app to re-read.
   *
   * @returns {boolean} whether the field is actually holding the value now.
   *   Callers must not perform the rite when this is false.
   */
  function setNumber(input, value) {
    if (!input) return false;
    const proto = Object.getPrototypeOf(input);
    const native = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    const text = String(value);
    try {
      input.focus();
    } catch {
      /* not focusable; the write below is what matters */
    }
    if (native) native.call(input, text);
    else input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return toInt(input.value) === Math.floor(Number(value));
  }

  /**
   * Read the balance off the live page.
   *
   * `textContent` rather than `innerText`: the latter forces a synchronous
   * reflow, and this runs on a poll (see CLAUDE.md finding 6). The cheap
   * substring test comes first so the regex only runs on a page that plausibly
   * has a balance on it.
   */
  function readBalance(doc = document) {
    const body = doc && doc.body;
    if (!body) return null;
    const text = body.textContent || "";
    if (text.indexOf("soul") === -1 && text.indexOf("Soul") === -1) return null;
    return parseBalance(text);
  }

  SEN.necro = {
    MAX_HARVESTS,
    RITE,
    toInt,
    formatCount,
    formatShort,
    formatAge,
    parseBalance,
    parseSoulDelta,
    parseDisturbDelta,
    plan,
    describe,
    findRiteCard,
    performButton,
    sizeInput,
    setNumber,
    readBalance,
  };
})();
