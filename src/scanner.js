/**
 * scanner.js — harvest jump targets out of the live page.
 *
 * Deliberately knows as little about Wardenfall's markup as possible: it finds
 * things by ROLE (anchor / button) and by VISIBLE TEXT, never by generated
 * class names. The game ships patches most days and reorganised its whole
 * navigation in v1.96, so anything coupled to their DOM internals would rot;
 * visible labels and URLs are the parts that stay stable.
 */
(function () {
  "use strict";

  const SEN = (globalThis.SEN = globalThis.SEN || {});

  const CLICKABLE = 'a[href], button, [role="button"], summary';

  // Wardenfall currently marks every navigation entry with a trailing "●".
  // That is a useful BONUS signal — it catches sub-nav rows sitting outside
  // <header>/<nav> — but it must never be load-bearing: the day they render
  // that dot as a CSS pseudo-element or an SVG it vanishes from innerText.
  // Anything inside a header/nav landmark counts as navigation regardless.
  const NAV_MARKER = /[●•]\s*$/;

  /**
   * Dedupe key: letters and digits only, lowercased. Collapses the same
   * destination written differently across sources — "🛠 CRAFTABLES" (live),
   * "Craftables" (seed) and "CRAFTABLES ●" all key to "craftables".
   */
  function normalizeKey(label) {
    return (label || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  function cleanLabel(raw) {
    return (raw || "")
      .replace(/ /g, " ")
      .replace(/\s+/g, " ")
      .replace(/^[\s•●·]+/, "")
      .replace(/[\s•●·]+$/, "")
      .replace(/\s*▾\s*$/, "")
      .trim();
  }

  function labelOf(el) {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return cleanLabel(aria);
    const text = el.innerText || el.textContent || "";
    if (text.trim()) return cleanLabel(text);
    const title = el.getAttribute("title");
    if (title && title.trim()) return cleanLabel(title);
    return "";
  }

  function isVisible(el) {
    if (!el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  }

  /**
   * Locate the header: walk up from the "WARDENFALL" brand until we reach an
   * ancestor holding several links. Falls back to semantic landmarks.
   */
  let headerCache = null;

  function findHeaderRoot() {
    // Finding the brand means walking every a/div/span/h1 in the document, so
    // hold on to the answer. The game re-renders constantly; a root that has
    // been swapped out is simply detached, which is cheap to notice.
    if (headerCache && headerCache.isConnected) return headerCache;

    const brand = [...document.querySelectorAll("a, div, span, h1")].find(
      (el) => cleanLabel(el.textContent).toUpperCase() === "WARDENFALL"
    );
    if (brand) {
      let node = brand;
      for (let hops = 0; node && hops < 8; hops++) {
        if (node.querySelectorAll("a[href]").length >= 4) {
          headerCache = node;
          return node;
        }
        node = node.parentElement;
      }
    }
    headerCache = document.querySelector("header, [role='banner'], nav") || null;
    return headerCache;
  }

  /** Collect the candidate containers we are willing to harvest from. */
  function navRoots() {
    const roots = new Set();
    const header = findHeaderRoot();
    if (header) roots.add(header);
    document
      .querySelectorAll("header, nav, [role='banner'], [role='navigation']")
      .forEach((el) => roots.add(el));
    return [...roots];
  }

  /**
   * Scan the page for jump targets.
   *
   * `inNav` (structural) and `marked` (the ● glyph) are tracked separately and
   * either one makes an entry learnable, so neither signal alone is a single
   * point of failure.
   *
   * @returns {Array<{key,label,group,path,el,inNav,marked,learnable}>}
   */
  /**
   * Is this element part of Seneschal's own UI? Both the palette and the dock
   * render inside shadow roots, which document.querySelectorAll cannot reach
   * into — this is the belt to that braces, and it covers any future surface
   * because the hosts are tagged with `data-seneschal` rather than by id.
   */
  function isOurs(el) {
    return Boolean(el.closest("[data-seneschal]"));
  }

  function scan() {
    const seen = new Map();
    const roots = navRoots();

    const consider = (el, inNav) => {
      if (isOurs(el)) return; // never index our own UI
      if (!isVisible(el)) return;

      const rawText = (el.innerText || el.textContent || "").replace(/ /g, " ");
      const label = labelOf(el);
      if (!label || label.length > 60) return;

      const href = el.getAttribute("href");
      const path = href && !href.startsWith("#") ? href : null;

      const marked = NAV_MARKER.test(rawText.trim());

      const key = normalizeKey(label) || label.toLowerCase();
      const prev = seen.get(key);
      if (prev) {
        // Same destination reached via a second root: keep the first entry but
        // upgrade its flags, so a structural sighting is not lost because a
        // marker sighting happened to land first.
        prev.inNav = prev.inNav || inNav;
        prev.marked = prev.marked || marked;
        prev.learnable = Boolean(prev.path) && (prev.inNav || prev.marked);
        return;
      }

      seen.set(key, {
        key,
        label,
        group: marked || inNav ? "Navigation" : "Header",
        path,
        el,
        inNav,
        marked,
        // Only entries with a real destination are worth remembering: a
        // dropdown toggle with no href cannot be jumped to from another page.
        learnable: Boolean(path) && (inNav || marked),
      });
    };

    for (const root of roots) {
      root.querySelectorAll(CLICKABLE).forEach((el) => consider(el, true));
    }

    // Catch-all for nav rows rendered outside any landmark: the ● marker.
    //
    // PERFORMANCE: this pre-filter runs over EVERY clickable on the page, so it
    // must not touch layout. `innerText` is layout-dependent — reading it forces
    // a synchronous reflow per element, and on the real game (hundreds of
    // buttons) that was most of what opening the palette cost. textContent is
    // free. Only the handful of elements that survive reach consider(), where
    // the pricier rendered-text and visibility checks are affordable.
    document.querySelectorAll(CLICKABLE).forEach((el) => {
      const text = (el.textContent || "").replace(/ /g, " ").trim();
      if (NAV_MARKER.test(text)) consider(el, false);
    });

    return [...seen.values()];
  }

  /**
   * Re-find an element for an item whose captured node was replaced by a
   * re-render (the game's boards auto-refresh on a timer, so this is common).
   */
  function resolve(item) {
    if (item.el && item.el.isConnected && isVisible(item.el)) return item.el;

    if (item.path) {
      const byHref = [...document.querySelectorAll(`a[href="${CSS.escape(item.path)}"]`)].find(
        (el) => isVisible(el) && !isOurs(el)
      );
      if (byHref) return byHref;
    }
    const wanted = item.label.toLowerCase();
    return (
      [...document.querySelectorAll(CLICKABLE)].find(
        (el) => isVisible(el) && !isOurs(el) && labelOf(el).toLowerCase() === wanted
      ) || null
    );
  }

  SEN.scanner = { scan, resolve, cleanLabel, labelOf, findHeaderRoot, normalizeKey, isOurs, isVisible };
})();
