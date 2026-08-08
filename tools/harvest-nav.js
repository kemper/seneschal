/**
 * harvest-nav.js — one-shot nav harvester. Paste into the DevTools console on
 * wardenfall.com (any page) and it prints a ready-to-paste `src/catalog.js`.
 *
 * WHY THIS EXISTS
 * Wardenfall's sub-navigation is contextual: only the six primary doors are on
 * every page, and BUILDINGS / DELVE / ARENA / HUNT only render once you are
 * already inside their parent door. So you cannot see every destination from
 * any single page — something has to walk the doors. This does that once, at
 * your keyboard, instead of the extension doing it forever at runtime.
 *
 * Re-run it whenever the game reshuffles its nav (roughly: when a patch note
 * says so, or when the palette starts missing something) and paste the result
 * over the array in src/catalog.js.
 *
 * WHAT IT DOES: clicks each navigation link, waits for the row to re-render,
 * and records what appeared. Navigation only — it never touches a game action,
 * spends a turn, or submits a form. It leaves you back where you started.
 */
(async () => {
  "use strict";

  // Time given to the SPA to paint a door's sub-nav. Generous by default
  // because a missed render silently costs you a whole door's worth of
  // entries; the override exists so the test suite does not crawl.
  const SETTLE_MS = globalThis.__senHarvestSettle ?? 900;
  const NAV_ROOTS = "header, nav, [role='banner'], [role='navigation']";
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const clean = (s) =>
    (s || "")
      .replace(/ /g, " ")
      .replace(/\s+/g, " ")
      .replace(/^[\s•●·]+/, "")
      .replace(/[\s•●·]+$/, "")
      .replace(/\s*▾\s*$/, "")
      .trim();

  const keyOf = (label) => label.toLowerCase().replace(/[^a-z0-9]+/g, "");

  // A full-screen modal swallows every click (the hero level-40 ascension
  // whisper does exactly this), which would make the walk silently harvest
  // nothing. Refuse to run rather than produce a misleadingly short list.
  const modal = document.querySelector('[role="dialog"][aria-modal="true"]');
  if (modal) {
    console.error(
      "%cA modal is open and will swallow every click — dismiss it, then re-run.",
      "color:#d9a441;font-weight:bold"
    );
    console.log("Modal text:", clean(modal.innerText).slice(0, 200));
    return;
  }

  /** Every visible nav link on the page right now. */
  const visibleNavLinks = () =>
    [...document.querySelectorAll(NAV_ROOTS)]
      .flatMap((root) => [...root.querySelectorAll("a[href]")])
      .filter((a) => {
        const r = a.getBoundingClientRect();
        return r.width > 0 || r.height > 0;
      })
      .map((a) => ({ label: clean(a.innerText || a.textContent), path: a.getAttribute("href") }))
      .filter((x) => x.label && x.path && !x.path.startsWith("#") && !/^https?:/i.test(x.path));

  const found = new Map(); // key -> {label, path, group}
  const record = (entry, group) => {
    const k = keyOf(entry.label);
    if (k && !found.has(k)) found.set(k, { ...entry, group });
  };

  const startPath = location.pathname;
  const visited = new Set();

  // Pass 1: whatever is on screen now — the primary doors plus this door's row.
  const primary = visibleNavLinks();
  primary.forEach((e) => record(e, "Primary"));
  console.log(`Starting from ${startPath} — ${primary.length} links visible.`);

  // Pass 2: walk each door, then walk what those doors revealed, so a third
  // level of nav is picked up too. Two passes is plenty for this game.
  let frontier = [...primary];
  for (let depth = 0; depth < 2; depth++) {
    const next = [];
    for (const door of frontier) {
      if (visited.has(door.path)) continue;
      visited.add(door.path);

      const link = document.querySelector(`a[href="${CSS.escape(door.path)}"]`);
      if (!link) continue;

      link.click();
      await wait(SETTLE_MS);

      const before = found.size;
      for (const entry of visibleNavLinks()) {
        if (!found.has(keyOf(entry.label))) next.push(entry);
        record(entry, door.label);
      }
      const gained = found.size - before;
      console.log(`  ${door.label.padEnd(24)} → ${gained ? `+${gained}` : "—"}`);
    }
    frontier = next;
    if (!frontier.length) break;
  }

  // Put things back where we found them. If nothing links to the exact page we
  // started on, fall back to the first primary door rather than abandoning you
  // on whatever page the walk happened to end on.
  const backTo =
    document.querySelector(`a[href="${CSS.escape(startPath)}"]`) ||
    (primary[0] && document.querySelector(`a[href="${CSS.escape(primary[0].path)}"]`));
  if (backTo) {
    backTo.click();
    await wait(SETTLE_MS);
    console.log(`Returned to ${backTo.getAttribute("href")}.`);
  } else {
    console.warn("Could not restore the starting page — navigate back yourself.");
  }

  // ---- emit a paste-ready catalog ----------------------------------------
  const rows = [...found.values()].sort(
    (a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label)
  );
  const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const stamp = new Date().toISOString().slice(0, 10);

  const body = rows
    .map((r) => `    { label: "${esc(r.label)}", path: "${esc(r.path)}", group: "${esc(r.group)}" },`)
    .join("\n");

  const out = `  // Harvested ${stamp} by tools/harvest-nav.js — ${rows.length} destinations.\n` +
              `  SEN.catalog = [\n${body}\n  ];`;

  console.log(`\n%cHarvested ${rows.length} destinations. Paste into src/catalog.js:`,
              "color:#d9a441;font-weight:bold");
  console.log(out);
  try {
    await navigator.clipboard.writeText(out);
    console.log("%c(copied to clipboard)", "color:#6b7686");
  } catch {
    console.log("%c(select the block above and copy it)", "color:#6b7686");
  }
  return out;
})();
