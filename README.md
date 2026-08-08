# Seneschal

A Chrome extension that adds a **Cmd-K / Ctrl-K command palette** to
[Wardenfall](https://wardenfall.com) — fuzzy-search every destination in the
game's navigation and jump straight there.

*A seneschal is the officer who administers the estate on the lord's behalf.*

<!-- v0.1.0 — command palette only. Dashboard is future work; see "Where this goes next". -->

## Install (unpacked, developer mode)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this repository's root directory.
4. Open <https://wardenfall.com> and press **Cmd-K** (macOS) or **Ctrl-K**.

After editing any file, hit the ↻ reload icon on the extension card, then
reload the game tab.

| Key | Action |
| --- | --- |
| `Cmd-K` / `Ctrl-K` | open / close the palette |
| `↑` `↓`, `Tab`, `Ctrl-N` / `Ctrl-P` | move the selection |
| `Enter` | jump |
| `Esc`, or click the backdrop | close |

## How it finds things

Wardenfall's navigation is **contextual**: only the six primary doors
(`REALM · EXPEDITIONS · CHAMPIONS · INVENTORY · LORE · RANKINGS`) are on every
page. The second row — `BUILDINGS`, `MARKET`, `DELVE`, `ARENA`, `🐗 HUNT`,
`🛠 CRAFTABLES` … — only renders once you are already inside its parent door.
A palette that scanned just the current header would therefore never be able to
offer you the thing you actually want.

So the index draws on three sources, most-trusted first:

1. **Live scan** of the header right now (`src/scanner.js`).
2. **Learned entries** — every nav item ever seen in a header, persisted to
   `chrome.storage.local`. Browsing naturally teaches it the whole tree.
3. **Seed catalog** (`src/catalog.js`) so it is useful on a fresh install.

Entries you pick often float to the top (frecency), and destinations visible on
screen right now outrank remembered ones.

### Two deliberate choices

**Nothing is matched by CSS class.** The scanner finds candidates by role
(`a[href]`, `button`, `[role=button]`) and by visible text. Wardenfall ships
patches most days and reorganised its entire nav in v1.96 — class names and DOM
shape are the parts that rot; labels and URLs are the parts that survive.

**Activation clicks the real element, it does not set `location.href`.** The
game is a client-routed SPA and some routes (notably `/buildings`) are reported
to render near-empty on a hard load but paint correctly when reached through the
nav link. Clicking also leaves the router's own state intact. `location.assign`
is only a last-resort fallback.

## Layout

```
manifest.json         MV3, one content script bundle, "storage" permission
src/fuzzy.js          subsequence scorer (word-start / run / prefix bonuses)
src/catalog.js        the destination list — regenerate with tools/harvest-nav.js
src/learned.js        retention policy for remembered nav (pure, unit-tested)
src/scanner.js        harvests jump targets from the live DOM
src/styles.js         CSS, injected into the shadow root
src/palette.js        index, filter, render, activate
src/content.js        entry point; binds the Cmd-K chord
tools/harvest-nav.js  DevTools one-shot: walks the doors, prints a catalog
test/fuzzy.test.mjs   matcher unit tests
test/learned.test.mjs retention-policy unit tests
test/e2e.py           loads the real unpacked extension in Chromium
test/harvest.py       proves the harvester finds nav hidden behind other doors
```

The whole UI lives in a **shadow root** on a host appended to
`document.documentElement`, so the game's stylesheet cannot reach in, ours
cannot leak out, and the game re-rendering `<body>` cannot sweep it away.

## Refreshing the destination list

`src/catalog.js` was written from captured page text, not from the live site, so
several entries have **no path at all** and a couple are inferred. Fix that in
about ten seconds:

1. Open wardenfall.com and log in.
2. Paste `tools/harvest-nav.js` into the DevTools console.
3. Paste what it prints over the array in `src/catalog.js`.

It clicks each nav link, waits for the row to re-render, records what appeared,
and puts you back where you started. Navigation only — it never triggers a game
action, spends a turn, or submits a form. It refuses to run if a modal is open,
because a full-screen overlay swallows every click and would otherwise produce
a misleadingly short list.

Re-run it whenever a patch reshuffles the nav. This is the deliberate trade: a
manual refresh every month or so, instead of runtime machinery that tries to
keep up on its own.

## Tests

```bash
node --test test/fuzzy.test.mjs     # 12 matcher unit tests
node --test test/learned.test.mjs   # 11 retention-policy unit tests
python3 test/e2e.py                 # 21 checks, real extension in Chromium
python3 test/harvest.py             # 15 checks, the nav harvester
```

All 59 pass.

`e2e.py` serves a mock Wardenfall shell (`test/fixture/index.html`), loads the
unpacked extension with `--load-extension`, and drives it exactly as a user
would: press Cmd-K, type, arrow around, hit Enter, and assert the correct anchor
was clicked. It uses opaque class names in the fixture on purpose, to prove the
scanner is not secretly depending on readable selectors.

Every bug found during development was caught by that harness rather than by
reading the code: an author `display: flex` silently overriding the `hidden`
attribute, a backtick inside a CSS comment terminating the JS template literal
that holds the stylesheet, and a harvester that abandoned you on whatever page
its walk happened to end on.

## Where this goes next

The palette is the thin end of the wedge; the dashboard is the real goal. Two
notes for that work:

- **Read data from the JSON API, not the DOM.** `/api/empire/summary`,
  `/api/trade`, `/api/bounties` and `/api/alliances` return stable structured
  JSON, and a content script's `fetch` carries the session cookie
  automatically. Scraping rendered numbers is the brittle path.
- **Don't try to share Wardenfall's React.** A content script runs in an
  isolated world and cannot reach the page's component tree; even injected into
  the main world, a production React build exposes no stable handle on state.
  Own your rendering — the two only need to agree on URLs and the JSON API.

## How durable is this, honestly

The layers are not equally stable, so it is worth being precise.

**Very stable.** The matcher is a pure function. The shadow-root UI cannot be
reached by the game's CSS. The Cmd-K binding is a capture-phase listener, and
Chrome lets pages claim Cmd-K (which is why every web app uses it).

**Stable by construction.** Discovery finds candidates by role and visible
text, never by class name, and clicks real elements instead of assembling URLs.
When the game reshuffles its nav — as it did wholesale in v1.96 — the labels
move but the mechanism does not care.

**The part that needed hardening.** Wardenfall marks nav entries with a
trailing `●`, which is a genuinely useful signal — it catches sub-nav rows
rendered outside any landmark. The first draft made it load-bearing: learning
was gated on it, so the day that dot became a CSS pseudo-element the palette
would have quietly stopped learning anything, with no error and no visible
symptom until the index went stale. It is now one of *two* independent signals
(the other structural: living inside a `header`/`nav`), either sufficient. The
fixture carries an unmarked entry specifically to hold that line.

**Known limits, accepted.** A renamed destination lingers in the remembered
index until its 90-day TTL expires — clicking a stale one falls through to a
plain navigation. Two different destinations sharing one label would collapse
into a single entry. Neither is silent-wrong in a way that costs you anything
worse than a re-click.

## Name

**Seneschal** — the officer who administers the estate on the lord's behalf,
which is exactly the job. It started life as `Better Wardenfall`.
