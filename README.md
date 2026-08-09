# Seneschal

A Chrome extension for [Wardenfall](https://wardenfall.com) with two surfaces:

- a **Cmd-K / Ctrl-K command palette** — fuzzy-search every destination in the
  game's navigation and jump straight there, most-recently-used first;
- a **floating quick menu** — a configurable rail on the left or right edge,
  holding the handful of places you actually go.

Either can be switched off entirely from the toolbar popup.

*A seneschal is the officer who administers the estate on the lord's behalf.*

<!-- v0.2.0 — palette + quick menu. Dashboard is future work; see "Where this goes next". -->

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

Click the toolbar icon for the on/off switches and a way into the full editor.

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
3. **Seed catalog** (`src/catalog.js`) — all 35 live destinations, harvested
   from the site itself, so it is complete on a fresh install.

How contextual is contextual? Measured across all 19 reachable nav pages: of
35 distinct entries, exactly **six** are on every page. The rest are 8/19, 5/19,
or lower.

**With an empty query the list is your history** — everything you have jumped
to before, most recent first, under a `Recent` heading, with everything else
below in its normal groups. So `Cmd-K` `Enter` repeats your last jump. Start
typing and match quality takes over again, with recency breaking near-ties;
destinations visible on screen right now outrank remembered ones.

### Keeping it instant

The palette must feel like it costs nothing, including on a laptop in low-power
mode. Three things buy that:

- **Opening the palette does no scanning.** The index is built at startup and
  kept warm in the background: a `MutationObserver` marks it stale, and it is
  rebuilt during an idle callback once the page has been still for 700ms. The
  game re-renders its boards on a timer, so waiting for a lull matters — and
  the rebuild is skipped entirely while the palette is open or the tab is in
  the background.
- **Nothing in the hot path touches layout.** The scan's pre-filter runs over
  every clickable on the page, and it used to read `innerText`, which is
  layout-dependent — a forced synchronous reflow *per element*. It reads
  `textContent` now (measured 5× faster on a page of 800 buttons), and the
  header-root search, which walks every `a`/`div`/`span`/`h1` looking for the
  brand, caches its answer until the node is detached.
- **Keys the palette handles do not reach the game.** `Ctrl-N` / `Ctrl-P`,
  the arrows and `Enter` all `stopPropagation()`. Otherwise every cursor move
  also ran whatever the game binds to that key, and that work landed between
  the keypress and the highlight moving. Cursor moves themselves touch two
  rows — no re-render, no `querySelector`.

The overlay has no `backdrop-filter` for the same reason: a full-screen blur is
recomposited every frame over whatever the game is animating underneath.

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

## The floating quick menu

A rail pinned to the left or right edge, holding whatever you put on it. Add a
page without leaving the game with the **＋** button on the rail; the **⚙**
opens the full editor (reorder, rename, change sides, import/export JSON).

Entries come in two kinds, and the second is the interesting one:

| Kind | Field | What happens on click |
| --- | --- | --- |
| **Path** | `/market` | Clicks a live anchor for that path if one is on screen, else navigates. A full `https://` URL opens in a new tab. |
| **Menu entry** | `craftables`, plus an optional door `/empire` | Clicks the navigation entry whose **visible label** matches. If nothing on this page matches, it goes through the door first, waits for the row to render, and clicks it there. |

The second kind exists because the game's sub-navigation is contextual:
`CRAFTABLES`, `ARENA` and `🐗 HUNT` are simply **not on the page** unless you
are already inside their parent door. The honest description of the journey is
"go to `/expeditions`, then click the thing called ARENA", and that is what the
entry stores.

**Prefer a path when you know it.** Most of these destinations do have a URL —
a *Menu entry* is not a claim that one does not exist. Since the harvest, every
entry in `src/catalog.js` has a real path, and the default quick menu is
entirely path entries. A *Menu entry* is the right choice in four narrower
cases:

- **The URL is not known yet**, for something the harvester has not reached.
- **The route misbehaves on a hard load,** as `/buildings` is reported to.
  (Second-hand and unverified — but clicking through costs nothing.)
- **The control genuinely has no href.** A dropdown toggle like the user menu
  is a `<button>`; there is no address to go to, and a pattern is the only way
  to put it on the rail.
- **You would rather pin the name than the address,** because you expect the
  URL to move and the label to stay.

A pattern is matched with case, spacing, emoji and the trailing `●` folded
away, so `craftables` matches `🛠 CRAFTABLES ●`. Wrap it in slashes
(`/^hunt/i`) for a real regular expression.

**When a pattern stops matching, it says so.** After the door has been walked
and the entry still has not appeared, you get a visible warning naming the
pattern, plus a `console.warn` — not a button that quietly does nothing. That
matters because a pattern is coupled to a visible label, and the game renames
things.

The pending click is held in `sessionStorage` as well as in memory, so it
survives a full page load and not just same-document routing.

## Layout

```
manifest.json         MV3, one content script bundle, "storage" permission
src/fuzzy.js          subsequence scorer (word-start / run / prefix bonuses)
src/catalog.js        the destination list — regenerate with tools/harvest-nav.js
src/config.js         settings model for both surfaces (pure, unit-tested)
src/learned.js        retention policy for remembered nav (pure, unit-tested)
src/scanner.js        harvests jump targets from the live DOM
src/styles.js         palette CSS, injected into its shadow root
src/dock-styles.js    quick menu CSS, injected into its shadow root
src/palette.js        index, filter, render, activate
src/dock.js           the quick menu: render, activate, walk doors, warn loudly
src/background.js     service worker; exists only to open the options page
src/content.js        entry point; mounts both surfaces, binds the Cmd-K chord
popup/                toolbar popup: the two on/off switches
options/              the quick menu editor
tools/harvest-nav.js  DevTools one-shot: walks the doors, prints a catalog
test/fuzzy.test.mjs   matcher unit tests
test/learned.test.mjs retention-policy unit tests
test/config.test.mjs  settings model: patterns, paths, validation
test/e2e.py           loads the real unpacked extension in Chromium
test/dock.py          drives the quick menu, options page and popup
test/harvest.py       proves the harvester finds nav hidden behind other doors
```

Each surface lives in its own **shadow root**, on a host appended to
`document.documentElement`, so the game's stylesheet cannot reach in, ours
cannot leak out, and the game re-rendering `<body>` cannot sweep it away. Both
hosts carry `data-seneschal`, which is how the scanner knows never to index our
own buttons.

Settings live in one object under `seneschal.settings.v1` in
`chrome.storage.local`; both surfaces watch `chrome.storage.onChanged`, so a
toggle or an edit lands in every open tab without a reload.

## The hero panel

Under the quick menu: every hero's class, name, level and HP, with a bar that
colours as it drops. Read from `/heroes` with a single GET and parsed out of
the server-rendered HTML, so it works on any page and mutates nothing.

**Heal all** mirrors the game's own `[ 💚 HEAL ALL HEROES ]`, which brews the
draughts it needs and prices the job itself — the panel shows that quote
verbatim (`1 wounded · 79 HP to mend · brews 4 draughts: 48 timber · 24 iron`)
rather than recomputing it, so the number you confirm is the game's own.

A **heal button** sits next to every hero, enabled only when they are hurt.
Inside a siege it spends siege provisions; otherwise it spends an elixir you
hold, chosen through the craftables page's own hero picker.
Pressing it asks first, then drives the game's own button — in a hidden
same-origin iframe, so it works from anywhere without navigating you to the
siege page.

That indirection is deliberate. There is no heal API: the game does its writes
through Next.js Server Actions, and the button's handler exposes no callable
reference, so a synthesised request would mean reverse-engineering a payload
keyed on a build hash that changes with every deploy. Clicking the real button
needs none of that. Measured: loading the siege page and selecting a location
issues **33 requests, all GET, and writes nothing to localStorage** — only the
heal click itself mutates anything.

Afterwards it **re-reads `/heroes` and checks the HP actually moved**, and says
so loudly if it did not, rather than reporting success because a click didn't
throw. When more than one siege is active, a small control picks which one the
heals draw from.

## Refreshing the destination list

`src/catalog.js` was harvested from the live site on 2026-08-08 and verified
against it with a zero diff. To refresh after a patch reshuffles the nav:

1. Open wardenfall.com and log in.
2. Paste `tools/harvest-nav.js` into the DevTools console.
3. Paste what it prints over the array in `src/catalog.js`.

It **fetches** each nav page and parses the HTML — it does not click. The game
server-renders its navigation, your session cookie rides along automatically,
and nothing on your screen changes. That is not a stylistic choice: clicking
triggers a real navigation, which destroys the console's execution context and
kills the script mid-walk. The click walk is still there as a fallback if the
game ever moves to client-side rendering.

GET requests to navigation URLs only. It never posts, submits a form, triggers
a game action, or spends a turn. It also **diffs against the shipped catalog**
and reports "n gone, n new, n moved" rather than making you eyeball a
regenerate.

### What the first harvest found

The pre-harvest catalog had been written from captured page text, and four of
its paths were invented — `/buildings`, `/lore`, `/inventory` and `/craftables`
all return **404**. The real ones are not guessable from the label:

| Entry | Guessed | Actually |
| --- | --- | --- |
| Lore | `/lore` | `/quests` |
| Inventory | `/inventory` | `/expeditions/inventory` |
| Buildings | `/buildings` | `/expeditions/buildings` |
| Craftables | `/craftables` | `/expeditions/buildings/craftables` |
| Sieges | — | `/conquest` |

This also retired a piece of folklore: `/buildings` was said to "render
near-empty on a hard load", which was taken as evidence the SPA needed clicking
through. It was a 404 page. **Never infer a path from a label.**

## Tests

```bash
node --test test/fuzzy.test.mjs     # 12 matcher unit tests
node --test test/learned.test.mjs   # 11 retention-policy unit tests
node --test test/config.test.mjs    # 27 settings-model unit tests
node --test test/heroes.test.mjs    # 14 hero, siege and heal-all parsers
python3 test/e2e.py                 # 26 checks, real extension in Chromium
python3 test/dock.py                # 57 checks, quick menu + hero panel
python3 test/harvest.py             # 15 checks, the nav harvester
```

All 151 pass. The Python tests need Playwright; `test/chromium_path.py` locates
a Chromium on either Linux or macOS, overridable with `SENESCHAL_CHROMIUM`.

`e2e.py` serves a mock Wardenfall shell (`test/fixture/index.html`), loads the
unpacked extension with `--load-extension`, and drives it exactly as a user
would: press Cmd-K, type, arrow around, hit Enter, and assert the correct anchor
was clicked. It uses opaque class names in the fixture on purpose, to prove the
scanner is not secretly depending on readable selectors.

`dock.py` does the same for the quick menu, and drives the options page and the
popup as real extension pages: it asserts that flipping a switch there changes
the live dock in the game tab.

Every bug found during development was caught by that harness — or by looking
at a screenshot — rather than by reading the code: an author `display: flex`
silently overriding the `hidden` attribute, a backtick inside a CSS comment
terminating the JS template literal that holds the stylesheet, a harvester that
abandoned you on whatever page its walk happened to end on, a `Recent` heading
that never rendered because the group was read off the wrong object, and a rail
that shoved itself sideways every time the add form opened.

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

**Very stable.** The settings model and the matcher are pure functions. The shadow-root UI cannot be
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

**The quick menu's pattern entries are the deliberate exception.** They are
coupled to a visible label by design — that is the only handle a contextual menu
entry offers. So the failure is made loud instead of being engineered away: walk
the door, wait, and if the entry never appears, say which pattern missed. Fixing
it is a one-field edit in the options page.

**Known limits, accepted.** A renamed destination lingers in the remembered
index until its 90-day TTL expires — clicking a stale one falls through to a
plain navigation. Two different destinations sharing one label would collapse
into a single entry. Neither is silent-wrong in a way that costs you anything
worse than a re-click.

## Name

**Seneschal** — the officer who administers the estate on the lord's behalf,
which is exactly the job. It started life as `Better Wardenfall`.
