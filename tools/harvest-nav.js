/**
 * harvest-nav.js — nav harvester. Paste into the DevTools console on
 * wardenfall.com (any page) and it prints a ready-to-paste `src/catalog.js`,
 * plus a diff against the catalog currently shipped.
 *
 * WHY THIS EXISTS
 * Wardenfall's sub-navigation is contextual. Measured on 2026-08-08: of 35
 * distinct nav entries across 19 pages, exactly six appear on every page. You
 * cannot see the whole tree from any single page, so something has to visit
 * them all. This does that once, at your keyboard, instead of the extension
 * doing it forever at runtime.
 *
 * HOW IT WORKS, AND WHY IT CHANGED
 * The first version CLICKED each nav link and waited for the row to re-render.
 * That is fatally fragile in a console: a click here triggers a real
 * navigation, which destroys the execution context and kills the script
 * mid-walk — it reports "Inspected target navigated or closed", or simply
 * stops. That is a property of the game, not a bug we can wait out.
 *
 * So the default path is now FETCH + PARSE. The game server-renders its
 * navigation, so `fetch("/expeditions")` returns HTML containing that door's
 * whole sub-nav row. Your session cookie rides along automatically. Nothing is
 * clicked, nothing navigates, the page you are on never changes, and it cannot
 * be interrupted. It is also many times faster.
 *
 * If fetching turns up no navigation — which would mean the app had moved to
 * client-side rendering — it falls back to the old click walk automatically.
 *
 * SAFETY: GET requests to navigation URLs only. It never posts, never submits
 * a form, never triggers a game action, and never spends a turn.
 */
(async () => {
  "use strict";

  const SETTLE_MS = globalThis.__senHarvestSettle ?? 900;
  const NAV_ROOTS = "header, nav, [role='banner'], [role='navigation']";
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const clean = (s) =>
    (s || "")
      .replace(/ /g, " ")
      .replace(/\s+/g, " ")
      .replace(/^[\s•●·]+/, "")
      .replace(/[\s•●·]+$/, "")
      .replace(/\s*▾\s*$/, "")
      .trim();

  // "Messages 153" carries a live unread count. Strip it: an entry must key on
  // something that does not change between two runs.
  const stableLabel = (l) => l.replace(/\s+\d[\d,]*\s*$/, "").trim();

  // The identity of an entry, used for dedupe, grouping AND the diff. It has to
  // be computed from the STABLE label everywhere — keying on the raw one made
  // "Messages 153" key as `messages153` while the shipped catalog held
  // `messages`, so every single run reported Messages as both gone and new.
  const idOf = (label) => stableLabel(label).toLowerCase().replace(/[^a-z0-9]+/g, "");

  const usable = (href) => href && !href.startsWith("#") && !/^https?:/i.test(href) && href.startsWith("/");

  /** Pull nav entries out of any document — the live one, or a fetched one. */
  const navIn = (doc, useRendered) =>
    [...doc.querySelectorAll(NAV_ROOTS)]
      .flatMap((root) => [...root.querySelectorAll("a[href]")])
      .filter((a) => {
        if (!useRendered) return true; // a fetched document has no layout
        const r = a.getBoundingClientRect();
        return r.width > 0 || r.height > 0;
      })
      .map((a) => ({
        label: clean(useRendered ? a.innerText || a.textContent : a.textContent),
        href: a.getAttribute("href"),
      }))
      .filter((x) => x.label && usable(x.href));

  const found = new Map(); // key -> {label, path, group}
  const pageRows = new Map(); // path -> Set(key), for working out groups
  const record = (entry, group) => {
    const k = idOf(entry.label);
    if (!k) return;
    if (!found.has(k)) found.set(k, { label: stableLabel(entry.label), path: entry.href, group });
  };

  const startPath = location.pathname;

  // ---- pass 1: whatever is on screen now ----------------------------------
  const here = navIn(document, true);
  here.forEach((e) => record(e, "Doors"));
  console.log(`Starting from ${startPath} — ${here.length} nav links visible.`);

  // ---- pass 2: fetch every path we know of, breadth-first ------------------
  const queue = [...new Set(here.map((e) => e.href))];
  const fetched = new Set();
  let fetchWorked = false;

  while (queue.length) {
    const path = queue.shift();
    if (fetched.has(path)) continue;
    fetched.add(path);
    try {
      const res = await fetch(path, { credentials: "include" });
      if (!res.ok) {
        console.log(`  ${path.padEnd(34)} ${res.status}`);
        continue;
      }
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      const rows = navIn(doc, false);
      if (!rows.length) continue;
      fetchWorked = true;

      const keys = new Set();
      const before = found.size;
      for (const entry of rows) {
        keys.add(idOf(entry.label));
        record(entry, "?");
        // Only follow links we have not already fetched, and keep the queue
        // bounded: this game has tens of pages, not thousands.
        if (!fetched.has(entry.href) && fetched.size + queue.length < 60) queue.push(entry.href);
      }
      pageRows.set(path, keys);
      console.log(`  ${path.padEnd(34)} +${found.size - before}`);
    } catch (e) {
      console.log(`  ${path.padEnd(34)} ${String(e).slice(0, 60)}`);
    }
  }

  // ---- fallback: the old click walk, if the server rendered no nav ---------
  if (!fetchWorked) {
    console.warn("Fetching returned no navigation — falling back to clicking. This can be interrupted by a page load.");
    const visited = new Set();
    let frontier = [...found.values()];
    for (let depth = 0; depth < 2; depth++) {
      const next = [];
      for (const door of frontier) {
        if (visited.has(door.path)) continue;
        visited.add(door.path);
        const link = document.querySelector(`a[href="${CSS.escape(door.path)}"]`);
        if (!link) continue;
        const before = found.size;
        link.click();
        await wait(SETTLE_MS);
        const keys = new Set();
        for (const entry of navIn(document, true)) {
          keys.add(idOf(entry.label));
          if (!found.has(idOf(entry.label))) next.push(entry);
          record(entry, "?");
        }
        pageRows.set(door.path, keys);
        console.log(`  ${door.label.padEnd(24)} → ${found.size - before ? `+${found.size - before}` : "—"}`);
      }
      frontier = next;
      if (!frontier.length) break;
    }
    // Put things back. If nothing links to the exact page we started on, fall
    // back to the first door rather than abandoning you on whatever page the
    // walk happened to end on.
    const first = [...found.values()][0];
    const backTo =
      document.querySelector(`a[href="${CSS.escape(startPath)}"]`) ||
      (first && document.querySelector(`a[href="${CSS.escape(first.path)}"]`));
    if (backTo) {
      backTo.click();
      await wait(SETTLE_MS);
      console.log(`Returned to ${backTo.getAttribute("href")}.`);
    } else {
      console.warn("Could not restore the starting page — navigate back yourself.");
    }
  }

  // ---- work out which door each entry belongs to --------------------------
  // An entry's group is the door whose sub-nav row contains it. This is not
  // derivable from the path: Buildings lives at /expeditions/buildings but
  // belongs to the Realm row, and Inventory is a top-level door despite
  // sitting under /expeditions.
  const universal = [...found.keys()].filter((k) =>
    [...pageRows.values()].every((keys) => keys.has(k))
  );
  const universalSet = new Set(universal);
  const doorName = new Map(); // path -> label, for the six primary doors
  for (const k of universalSet) doorName.set(found.get(k).path, found.get(k).label);

  for (const [key, entry] of found) {
    if (universalSet.has(key)) {
      entry.group = "Doors";
      continue;
    }
    let group = "Other";
    for (const [path, keys] of pageRows) {
      if (doorName.has(path) && keys.has(key)) {
        group = doorName.get(path);
        break;
      }
    }
    entry.group = group;
  }

  // ---- diff against the shipped catalog -----------------------------------
  const shipped = globalThis.SEN?.catalog;
  if (Array.isArray(shipped)) {
    const was = new Map(shipped.map((e) => [idOf(e.label), e]));
    const gone = [...was.keys()].filter((k) => !found.has(k));
    const added = [...found.keys()].filter((k) => !was.has(k));
    const moved = [...found.entries()].filter(([k, e]) => was.has(k) && was.get(k).path !== e.path);

    console.log(
      `\n%cDiff vs the shipped catalog: ${gone.length} gone, ${added.length} new, ${moved.length} moved`,
      "color:#d9a441;font-weight:bold"
    );
    gone.forEach((k) => console.log(`  - gone   ${was.get(k).label} (${was.get(k).path})`));
    added.forEach((k) => console.log(`  + new    ${found.get(k).label} (${found.get(k).path})`));
    moved.forEach(([k, e]) => console.log(`  ~ moved  ${e.label}: ${was.get(k).path} → ${e.path}`));
    if (!gone.length && !added.length && !moved.length) console.log("  (no change — the catalog is current)");
  } else {
    console.log("\n(No SEN.catalog on the page, so no diff. Load the extension to get one.)");
  }

  // ---- emit a paste-ready catalog -----------------------------------------
  const ORDER = ["Doors"];
  for (const label of doorName.values()) if (!ORDER.includes(label)) ORDER.push(label);
  ORDER.push("Other");
  const rank = (g) => (ORDER.indexOf(g) === -1 ? ORDER.length : ORDER.indexOf(g));

  const rows = [...found.values()].sort(
    (a, b) => rank(a.group) - rank(b.group) || a.label.localeCompare(b.label)
  );
  const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const stamp = new Date().toISOString().slice(0, 10);

  let lastGroup = null;
  const body = rows
    .map((r) => {
      const head = r.group !== lastGroup ? ((lastGroup = r.group), `\n    // ---- ${r.group} ----\n`) : "";
      return `${head}    { label: "${esc(r.label)}", path: "${esc(r.path)}", group: "${esc(r.group)}" },`;
    })
    .join("\n");

  const out =
    `  // Harvested ${stamp} by tools/harvest-nav.js — ${rows.length} destinations\n` +
    `  // across ${pageRows.size} pages; ${universal.length} of them appear on every page.\n` +
    `  SEN.catalog = [\n${body}\n  ];`;

  console.log(
    `\n%cHarvested ${rows.length} destinations from ${pageRows.size} pages. Paste into src/catalog.js:`,
    "color:#d9a441;font-weight:bold"
  );
  console.log(out);
  try {
    await navigator.clipboard.writeText(out);
    console.log("%c(copied to clipboard)", "color:#6b7686");
  } catch {
    // Expected when the console has focus: the document must be focused to
    // write the clipboard. Not an error worth shouting about.
    console.log("%c(select the block above and copy it)", "color:#6b7686");
  }
  return out;
})();
