# Seneschal — working notes for agents

A Chrome extension (Manifest V3) that adds a Cmd-K command palette to
[wardenfall.com](https://wardenfall.com), a browser strategy game. The palette
is v0.1; a companion dashboard is the eventual goal.

This repo is **secret-free by design**. Do not add credentials, cookies,
encrypted secret files, or keys — none are needed. A content script runs inside
the user's already-logged-in browser, so its `fetch` carries the session cookie
automatically. If a session cookie ever has to be supplied for testing, it goes
in a local file or environment variable, never into a commit or a chat message —
it is a full bearer credential.

## Findings that cost real effort to get — don't rediscover them

**1. The game's sub-navigation is CONTEXTUAL.** Confirmed against the live
site on 2026-08-08 by fetching all 19 reachable nav pages: of **35** distinct
entries, exactly **six** appear on every page (`REALM · EXPEDITIONS ·
CHAMPIONS · INVENTORY · LORE · RANKINGS`). Everything else is 8/19 (the
Expeditions row), 5/19 (the Realm row), or 2/19 and below. **No single page
shows the whole nav**, which is why the palette merges three sources instead of
scanning one header.

**2. Prefer CLICKING a real element, but the old reason for it was WRONG.**
The story was that `/buildings` "renders near-empty on a hard load". Measured:
`/buildings` returns **404**. So do `/lore`, `/inventory` and `/craftables` —
all four were invented by the pre-harvest catalog and none is a real route.
The near-empty page was a 404 shell. The real paths are `/expeditions/buildings`,
`/quests`, `/expeditions/inventory` and
`/expeditions/buildings/craftables`. Clicking a live anchor is still preferred
(it keeps the router's state and costs nothing), but `location.assign` to a
**harvested** path is fine — the thing to distrust is a guessed URL, not a hard
load. **Never infer a path from a label.**

**3. The game changes absurdly fast** — on the order of a shipped release per
day, and it reorganised its entire navigation in v1.96. **Design so failures are
LOUD, not silent.** Anything coupled to class names or DOM shape will rot;
visible labels and URLs are what survive.

**4. Never make one signal load-bearing.** The game marks nav entries with a
trailing `●`. The first draft gated *learning* on that glyph, so the day it
became a CSS pseudo-element the palette would have silently stopped learning —
no error, no symptom, just a quietly staling index. It is now two independent
signals (`marked`, and `inNav` for anything inside a `header`/`nav`), either
sufficient. `test/fixture/index.html` carries an **unmarked** entry (`LEDGER`)
specifically to hold that line. **Preserve this property.**

**5. Content scripts run in an ISOLATED WORLD.** You cannot reach the page's
React tree, and a production React build exposes no stable handle on state
anyway. Own the rendering. The extension and the game only need to agree on URLs
and the JSON API.

**6. `innerText` is a reflow, and it was the palette's main cost.** The
scanner's ●-marker pre-filter runs over EVERY clickable on the page; reading
`innerText` there forced a synchronous layout per element (measured 5x slower
than `textContent` on 800 nodes). Same class of problem: `findHeaderRoot()`
walks every `a`/`div`/`span`/`h1`, so it caches. And the index is now built in
the background — **`show()` must never scan.** If you add work to the open
path, you are undoing this.

**7. Anything the palette's key handler acts on must `stopPropagation()`.**
Otherwise the game also handles the key and re-renders, and that lands between
the keypress and the cursor moving. This is what made Ctrl-N / Ctrl-P sluggish.

**8. For data, read the JSON API, not the DOM.** `/api/empire/summary`,
`/api/trade`, `/api/bounties`, `/api/alliances` return stable structured JSON.
Scraping rendered numbers is the brittle path.

**9. Quick menu `menu` entries are deliberately coupled to a visible label.**
That is the only handle contextual sub-nav offers, so instead of engineering the
coupling away, the failure is made LOUD: walk the door, wait `RESOLVE_MS`, and
if the entry never appears, warn on screen and in the console naming the
pattern. `test/dock.py` holds that line. Don't "fix" it into a silent no-op.

**10. There is NO heal endpoint, and no REST API for mutations at all.**
Measured: the game drives writes through Next.js **Server Actions**
(`createServerReference` x33, `callServer` x50). Every `/api/*` route in the
whole bundle set is a peripheral read — `alliances/pending-count`,
`messages/unread-count`, `news`, `conquest/chat`, `auth/logout`. The heal
button's `onClick` is a plain closure with **no exposed action reference** in
props or fiber, so there is nothing to call directly; and a hand-built
`Next-Action` POST would depend on a per-build hash that changes every deploy.
**Don't go looking for the endpoint again — it isn't there.**

**11. The hidden same-origin iframe is the safe way to drive game UI.**
The site sends no `X-Frame-Options` and no CSP, so it frames itself and
`contentDocument` is reachable. Measured for loading `/conquest` and selecting
a siege location: **33 requests, all GET, zero POSTs, zero localStorage
writes.** So getting to a control costs nothing and cannot disturb the page the
user is looking at — only the final click mutates. Note localStorage IS shared
across same-origin frames, which is why the write count was checked rather than
assumed.

**12. Heal buttons carry `title="Heal <Name> for 4 <Resource>"`.** Hero, cost
and currency in plain readable text — the durable handle. Each class heals with
a different resource (mage Cinder-Coal, warrior Greathide, rogue Fluxsalt,
archer Warden-Resin). Buttons are `disabled` when `hp === maxHp`.

**13. `/heroes` prints the roster TWICE**, and both are needed: a roster row
with class icon and level (`● 🔮 Krogdolf Lv50`) and an HP row with current/max
(`Heroes Krogdolf 489/489 · ...`). The page also carries ratios that are NOT hp
(`Power 900/70`, `Morale 100/85`); the parser rejects them by requiring
`current <= max`.

**14. Healing has TWO separate systems — don't conflate them.**
  - *Siege provisions*: the assault panel's `⛑` button, `title="Heal <Name> for
    4 <Resource>"`, class-specific currency, only inside a siege.
  - *Elixirs*: craftable consumables on `/expeditions/buildings/craftables`,
    used via a `USE ON HERO` button. Measured 2026-08-08:

    | Elixir | Mends | Cost | Held |
    | --- | --- | --- | --- |
    | 🧪 Salveroot Tonic | +10 HP | 6 timber + 2 iron | 0 |
    | 🍵 Knitbone Draught | +25 HP | 12 timber + 6 iron | 0 |
    | 💧 Wardenbalm Elixir | +50 HP | 2 wardenstone + 2 Warden-Resin | 1 |

    Wardenbalm also rouses a gravely-wounded champion to march at once.
    Craftables page buttons: `CRAFT · SMELT · USE ON HERO · USE VIAL · TRADE ·
    REFINE · BUY`. `USE ON HERO` is paired with a hero `<select>` whose options
    read `Krogdolf — 410/489 HP`, and appears for elixirs you actually hold.

  - *Heal all*: `[ 💚 HEAL ALL HEROES ]` on `/heroes` DOES exist — an earlier
    note here said it did not, because it only renders when someone is wounded.
    It prices itself: `1 wounded · 79 HP to mend · brews 4 draughts: 48 timber ·
    24 iron`. **Quote that line, never recompute it** — the game picks the
    elixirs and does the arithmetic, and a second implementation would
    eventually disagree with it.

**14b. An ACTIVE siege is one rendering assault locations, not one named.**
`/conquest` names every bulwark you could attack alongside the ones you are
besieging, so a `The X Bulwark` regex reported three active sieges when there
were none. The structural signal is a row of location buttons (The Gate / West
Wall / Postern / Regent's Hall …); tie the name to the siege by walking UP from
those buttons. You must be committed to a siege before provisions healing is
possible at all.

**15. Heal and "use" controls only render when a hero is DAMAGED.** With a full
roster the buttons are `disabled` (siege panel) or absent (elixirs), which is
why several recon passes came back empty. Plan recon for a moment when someone
is actually hurt.

**16. "Failed to fetch" on every page is usually just navigation.** Each
in-game click is a full page load, which cancels requests in flight and rejects
them as `TypeError: Failed to fetch`. `heroes.js` sets a flag on `pagehide` and
`isAbort()` classifies these, so callers stay silent. Don't "fix" a cancelled
request by retrying it — the next page will refresh anyway.

**17. Never let one button pick which resource to spend.** A single `⛑` heal
chose the method itself and spent a Wardenbalm (+50 HP, the scarcest, needing
wardenstone) closing a 79 HP wound. Every spending action now names its method
and quotes its price BEFORE it runs — one button per method, each with a title
giving the elixir, what it mends, how many you hold, and what brewing would
cost. Elixir cards are keyed to their "Mend a Hero · +N HP" use-block by the
MEND AMOUNT; the hero picker and USE ON HERO only exist for an elixir you
actually hold, so a held count of 0 means CRAFT first.

**18. NEVER `alert()`, `confirm()` or `prompt()` — not now, not later.**
A standing instruction from the user. Native dialogs are browser chrome, so
they read as Chrome speaking rather than the extension; they cannot be styled
or placed; they freeze the page and every timer on it; and under automation
they hang the session outright (which is why the browser-automation guidance
says the same thing). Anything needing an answer uses `Dock._ask()`, which
opens the `.dk-ask` panel beside the rail and resolves a promise. `test/dock.py`
registers a `page.on("dialog")` listener that fails the run if one ever fires —
keep it, because Playwright auto-dismisses dialogs when nothing is listening,
so a `confirm()` would otherwise pass silently.

**19. Verify a mutation by POLLING the server, not by one read after a wait.**
A heal is a Server Action plus a re-render, and that round trip is not a fixed
cost. `healAll` clicked, waited 2s, read once, and reported "did not take" on a
heal that had gone through — the user saw it work on `/heroes` a moment later.
`pollUntil()` in `heroes.js` now reads until the change appears or 15s passes,
treating a failed read as "not yet" (a cancelled request during navigation is
routine). When it still hasn't changed, `blockedBy(doc)` reports any
`role="dialog"` in the frame rather than shrugging — but it never clicks
through one, because an unidentified button here can commit an assault.

**20. A DEFAULT ONLY EVER REACHES A FRESH INSTALL.** Changing
`DEFAULT_ITEMS` does nothing for anyone already running — their menu was
written to storage on first load and stays there. This has now bitten twice
(a repaired Craftables path that still walked to /empire; a new menu nobody
would have seen). Two mechanisms in `config.js` close it, both keyed on "still
exactly what we shipped, therefore ours":
  - `LEGACY_SEEDS` repairs individual entries we got wrong.
  - `SHIPPED_MENUS` holds every menu we have ever shipped, verbatim, and
    replaces a stored one that still fingerprints identical with the current
    default. **When you change `DEFAULT_ITEMS`, paste the outgoing list into
    `SHIPPED_MENUS`** or the change silently applies to new installs only.

The fingerprint covers every field including icon and order, so adding,
removing, reordering or re-icing ONE entry makes the menu the user's and we
never touch it again.

**The two mechanisms interact, and getting it wrong is silent.** `LEGACY_SEEDS`
rewrites entries on EVERY load, so as soon as anything writes settings back —
collapsing the rail, adding a link, switching siege — storage holds the
*repaired* menu, not the shipped one. Fingerprinting the raw form therefore
missed every already-repaired menu, which is a config that can never be brought
forward again. `isShippedMenu` compares in MIGRATED form on both sides.
Reported as "I'm not seeing it update after a refresh"; keep the tests that
pin it.

**Also: an unpacked extension does not pick up file changes on a page
refresh.** Reload it at `chrome://extensions` first. The ID is derived from the
directory path and does NOT change. Rule that out before debugging config.

**21. The rail's LINK LIST scrolls, not the rail.** Twelve links plus a full
hero panel outgrow a laptop screen. When `.dk-rail` scrolled as one block the
heal buttons and the ＋/⚙ tools fell below the fold — caught by a screenshot,
not by the suite. `.dk-items` now has `flex: 0 100 auto` so it surrenders space
first (a link you scroll to is a far smaller loss than a heal button you cannot
see), `.dk-heroes` shrinks only after that, and `.dk-sep`/`.dk-tools` never
shrink. `min-height: 0` is what permits any of it. `test/dock.py` pins this at
a 720px viewport.

## Working agreements

- **Verify in a browser; do not trust reading.** Every bug so far was caught by
  the Playwright suite and none would have survived review: an author
  `display: flex` overriding the `hidden` attribute (the palette never closed);
  a backtick inside a CSS comment terminating the JS template literal holding
  the whole stylesheet; a harvester that abandoned you on whatever page its walk
  ended on.
- **Look at a screenshot before calling UI done.** Two layout bugs in the
  quick menu survived a green test suite and died instantly on a screenshot:
  the rail was not flush with the screen edge, and opening the add form shoved
  the whole rail sideways. Both were child-order problems in one flex row.
- **Fixtures use opaque class names on purpose**, to prove the scanner is not
  leaning on readable selectors. Keep that.
- Be explicit about which layers are stable and which are best-effort. The
  README's "How durable is this, honestly" section is the contract.

## Tests

```bash
node --test test/fuzzy.test.mjs     # 12
node --test test/learned.test.mjs   # 11
node --test test/config.test.mjs    # 43
node --test test/heroes.test.mjs    # 14
python3 test/e2e.py                 # 26
python3 test/dock.py                # 75
python3 test/harvest.py             # 15
```

196 checks. Keep them passing.

The Python tests need Playwright. There is a local `.venv` (gitignored):
`.venv/bin/python3 test/dock.py`. `test/chromium_path.py` finds a Chromium
across the cloud container and a Mac; override with `SENESCHAL_CHROMIUM`.
Never run `playwright install` in the container.

`test/dock.py` drives the options page and the toolbar popup as real
extension pages (get the id from `ctx.service_workers[0].url`), which is also
the only way to write `chrome.storage` from a test.

Two gotchas already solved — don't re-hit them:

- Objects returned from a `vm` sandbox are **cross-realm**, so
  `deepStrictEqual` rejects them. Compare key sets, or copy into the test realm.
- `node --test <dir>` needs an explicit file path in some environments; pass the
  file.

Launch Chromium with `--no-sandbox --disable-setuid-sandbox --disable-quic
--no-proxy-server`.

## Open work, in priority order

**1. ~~Harvest the real destination list.~~ DONE 2026-08-08.** `src/catalog.js`
now holds all 35 live entries with real paths and real groups, verified
35/35 with a zero diff. `tools/harvest-nav.js` regenerates it and reports
"n gone, n new, n moved" against what is shipped.

**0. Settings live in one object**, `seneschal.settings.v1` in
`chrome.storage.local`: `{ palette: {enabled}, dock: {enabled, side, collapsed,
items} }`. Both surfaces watch `chrome.storage.onChanged`, so toggles land live
in every tab. `src/config.js` is the only place that decides what is valid;
never validate an entry anywhere else.

**2. Decide whether to strip the runtime learning index.** The user leans toward
a plain hardcoded list, and that is probably right — once the catalog is
harvested, the learning machinery solves a problem that no longer exists.
Deleting `learned.js`, the TTL/prune, the persistence and the marker heuristics,
and collapsing `scanner.js` to a single find-anchor-for-path helper, removes
~200 lines and one whole concept. **Keep** the matcher, the shadow-DOM palette,
and click-then-navigate activation. This was offered and **not yet decided** —
confirm before ripping it out.

**3. ~~A harvester diff mode.~~ DONE.** `harvest-nav.js` diffs against
`SEN.catalog` when the extension is loaded on the page.

**3b. A label can carry live state.** `MESSAGES` renders as "Messages 153" —
the unread count is IN the label. The harvester strips a trailing number and
keys entries on the stable form; getting this wrong made every run report
Messages as both gone and new. Anything that matches or dedupes on a visible
label must assume the label can move.

**3c. Selection state is styling-only.** The raid page's region picker marks
the selected button with Tailwind colour classes (`border-amber-400
text-amber-300`) and nothing else — no `aria-selected`, no `data-state`, not in
the URL, not in localStorage. To detect a selection, diff a button's class
signature against its SIBLINGS (odd-one-out) rather than hardcoding a colour,
so a palette change cannot break it. `?realm=near` IS in the URL, so that axis
is preserved for free by restoring the full URL.

**4. Arena sound effects — deliberately NOT in this repo yet.** The user wants
spell sounds, bow twangs, hit grunts, death cries. Playing audio is trivial;
knowing *when* is the entire problem, and there is currently **zero**
information about how the Arena page is built. A recon script (paste into
DevTools, take one turn, read a report) was drafted elsewhere and is the right
first step: it must establish whether the grid is a `<canvas>` (DOM watching
dead), whether a text log **streams** as the fight animates or lands as one
**burst** summary (a summary cannot carry timed audio), and whether each action
returns a structured network result. **Do not source a single sound file before
that report exists.** If the network path wins, hooking `fetch` needs
`world: "MAIN"` in the manifest — running inside the game's own context rather
than politely beside it. That is a real escalation in invasiveness; get an
explicit yes rather than sliding into it.

## Live-site access

Two routes, in order of preference:

**1. `claude --chrome` from a LOCAL session.** Claude Code drives the real
browser through the Claude in Chrome extension, with the user's existing login.
This is how the 2026-08-08 harvest was done. It needs a local CLI — the
integration runs over Chrome **native messaging**, which is machine-local by
construction, so a cloud session can never reach it. Teleport first
(`claude --teleport <session-id>`), then `/chrome`.

**2. DevTools scripts the user pastes and reports back** — design tooling for
that when no browser is attached.

**Do NOT drive the live site by clicking.** A click is a real navigation, which
destroys the JS execution context and kills any in-page script mid-walk
("Inspected target navigated or closed"). This is what made the first harvester
fail in practice. **`fetch` + `DOMParser` instead**: the game server-renders its
nav, the session cookie rides along automatically, nothing navigates, and it
cannot be interrupted. Also far faster. Same rule for any future recon.

If a pasted script mysteriously no-ops on the live site, **check for an open
`role="dialog"` modal first**: the game's hero level-40 ascension whisper
intercepts every pointer event app-wide. `tools/harvest-nav.js` already refuses
to run when one is open.
