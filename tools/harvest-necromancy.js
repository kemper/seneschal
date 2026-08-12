/**
 * harvest-necromancy.js — recon for the Rites of Remembrance panel.
 *
 * Paste into the DevTools console **while the rites panel is on screen**
 * (CHAMPIONS › ⚰ NECROMANCY, i.e. /expeditions/buildings/necromancy as of
 * 2026-08-11) and hand the output back.
 *
 * WHY THIS EXISTS
 * The extension's "Raise host" button drives a rite that SPENDS souls, and
 * that — when souls are short — sacrifices living veterans. Everything it
 * knows about the panel was reconstructed from a page-text capture taken
 * 2026-07-01, back when the rites lived on /expeditions:
 *
 *     💀 4,120 souls · Disturbance 12/50
 *     👻 Spectral Host · +6 disturb
 *     💀 Soul-Harvest · +4 disturb
 *     PERFORM · +240 SOULS
 *
 * Text, not DOM. So src/necro.js currently GUESSES the shape — a card per
 * rite, a number field for the host size, a PERFORM button — and refuses to
 * act whenever the guess does not hold. This script replaces the guess with a
 * measurement.
 *
 * IT READS ONLY. It clicks nothing, submits nothing, spends nothing, and
 * changes no field. Running it cannot cost you a soul or a veteran.
 *
 * WHAT TO DO WITH THE OUTPUT
 * Copy the whole JSON blob it prints. If anything reads "MISSING" or
 * "AMBIGUOUS", that is precisely the part the extension will refuse on, and
 * the part worth fixing first.
 */
(() => {
  "use strict";

  const clean = (s) =>
    (s || "")
      .replace(/ /g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const fold = (s) => clean(s).toLowerCase().replace(/[^a-z0-9]+/g, "");

  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  };

  // Same refusal the nav harvester makes: a full-screen modal (the hero
  // level-40 ascension whisper) hides the page behind it, and a report taken
  // through one describes the modal, not the panel.
  const modal = document.querySelector('[role="dialog"][aria-modal="true"]');
  if (modal) {
    console.error(
      "%cA modal is open — dismiss it, then re-run.",
      "color:#d9a441;font-weight:bold"
    );
    console.log("Modal text:", clean(modal.innerText).slice(0, 200));
    return;
  }

  const bodyText = clean(document.body.innerText);

  // --- the balance line ------------------------------------------------------
  const soulMatch = /([0-9][0-9,.  ]*)\s*souls?\b/i.exec(bodyText);
  const disturbMatch = /disturbance[^0-9]{0,4}([0-9][0-9,.  ]*)\s*\/\s*([0-9][0-9,.  ]*)/i.exec(bodyText);

  if (!soulMatch) {
    console.error(
      "%cNo soul balance on this page — is the rites panel actually open?",
      "color:#d9a441;font-weight:bold"
    );
    console.log(
      "Looked for a number followed by the word 'souls'. Open /expeditions/buildings/necromancy (or wherever the rites live now) and re-run."
    );
    return;
  }

  // Where that number actually lives, so we can see how it is marked up.
  const soulHost = [...document.querySelectorAll("div,span,p,li,td,section,h1,h2,h3,h4")]
    .filter((el) => visible(el) && /[0-9][0-9,.  ]*\s*souls?\b/i.test(clean(el.textContent)))
    .sort((a, b) => (a.textContent || "").length - (b.textContent || "").length)[0];

  const describeEl = (el) =>
    el
      ? {
          tag: el.tagName.toLowerCase(),
          className: typeof el.className === "string" ? el.className.slice(0, 120) : "",
          id: el.id || "",
          text: clean(el.textContent).slice(0, 160),
        }
      : null;

  // --- the rite cards --------------------------------------------------------
  const RITES = [
    { key: "host", needle: "spectralhost", label: "Spectral Host" },
    { key: "harvest", needle: "soulharvest", label: "Soul-Harvest" },
    { key: "honor", needle: "riteofhonor", label: "Rite of Honor" },
  ];
  const allNeedles = RITES.map((r) => r.needle);

  const BLOCKS = "div,section,article,li,form,fieldset,td";

  function inspect(rite) {
    const naming = [...document.querySelectorAll(BLOCKS)]
      .filter((el) => visible(el) && fold(el.textContent).includes(rite.needle))
      .sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);

    if (!naming.length) return { rite: rite.label, status: "MISSING — no element names it" };

    // Walk up to the first ancestor holding a button, exactly as the extension
    // does, and report if that walk runs into a DIFFERENT rite — the failure
    // mode that would otherwise click the wrong PERFORM.
    let node = naming[0];
    let hops = 0;
    let overWalked = false;
    let card = null;
    for (; node && hops < 6; hops++) {
      const folded = fold(node.textContent);
      if (allNeedles.some((n) => n !== rite.needle && folded.includes(n))) {
        overWalked = true;
        break;
      }
      const buttons = [...node.querySelectorAll('button,[role="button"]')].filter(visible);
      if (buttons.length) {
        card = { node, buttons };
        break;
      }
      node = node.parentElement;
    }

    if (overWalked) {
      return {
        rite: rite.label,
        status: "AMBIGUOUS — the nearest ancestor with a button also names another rite",
        innermost: describeEl(naming[0]),
      };
    }
    if (!card) {
      return { rite: rite.label, status: "MISSING — named, but no button within 6 ancestors", innermost: describeEl(naming[0]) };
    }

    const inputs = [...card.node.querySelectorAll("input,select")].filter(visible);

    return {
      rite: rite.label,
      status: "found",
      hopsUpFromLabel: hops,
      card: describeEl(card.node),
      buttons: card.buttons.map((b) => ({
        text: clean(b.innerText || b.textContent),
        ariaLabel: b.getAttribute("aria-label") || "",
        disabled: Boolean(b.disabled || b.getAttribute("aria-disabled") === "true"),
        tag: b.tagName.toLowerCase(),
        className: typeof b.className === "string" ? b.className.slice(0, 120) : "",
      })),
      inputs: inputs.map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") || "",
        value: el.value,
        min: el.getAttribute("min") || "",
        max: el.getAttribute("max") || "",
        step: el.getAttribute("step") || "",
        placeholder: el.getAttribute("placeholder") || "",
        ariaLabel: el.getAttribute("aria-label") || "",
        readOnly: Boolean(el.readOnly),
        // React installs its own value setter on controlled inputs; whether it
        // did tells us if the native-setter write in necro.js is needed.
        hasOwnValueSetter: Boolean(Object.getOwnPropertyDescriptor(el, "value")),
      })),
      // If there is no field, the host size must come from the button text —
      // report whether it quantifies itself.
      buttonQuantifies: card.buttons.some((b) =>
        /[+−–-]\s*[0-9][0-9,.  ]*\s*souls?\b/i.test(clean(b.innerText || b.textContent))
      ),
    };
  }

  const report = {
    capturedAt: new Date().toISOString(),
    url: location.pathname + location.search,
    balance: {
      souls: Number(soulMatch[1].replace(/[^0-9]/g, "")),
      soulsRawMatch: clean(soulMatch[0]),
      disturbance: disturbMatch ? Number(disturbMatch[1].replace(/[^0-9]/g, "")) : null,
      tolerance: disturbMatch ? Number(disturbMatch[2].replace(/[^0-9]/g, "")) : null,
      renderedIn: describeEl(soulHost),
    },
    rites: RITES.map(inspect),
    // A short slice of the panel's own text, which is what the extension reads.
    panelText: clean(
      (soulHost && soulHost.closest("section,div[class*=card],div") ? soulHost.closest("section,div[class*=card],div").textContent : bodyText)
    ).slice(0, 1200),
  };

  const json = JSON.stringify(report, null, 2);
  console.log("%c=== Seneschal · necromancy recon ===", "color:#d9a441;font-weight:bold");
  console.log(json);

  const problems = report.rites.filter((r) => r.status !== "found");
  if (problems.length) {
    console.warn(
      "Rites the extension will REFUSE to act on:",
      problems.map((p) => `${p.rite} (${p.status})`).join(" · ")
    );
  }
  const host = report.rites.find((r) => r.rite === "Spectral Host");
  if (host && host.status === "found" && !host.inputs.length && !host.buttonQuantifies) {
    console.warn(
      "Spectral Host has no size field AND its button does not state a cost — the extension cannot know what performing it would spend, so it will refuse."
    );
  }

  try {
    copy(json); // DevTools-only helper
    console.log("%cCopied to the clipboard — paste it back.", "color:#7fc98a");
  } catch {
    console.log("Select the JSON above and copy it.");
  }
})();
