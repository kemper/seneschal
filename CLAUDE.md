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

**1. The game's sub-navigation is CONTEXTUAL.** Only six labels appear on every
page (`REALM · EXPEDITIONS · CHAMPIONS · INVENTORY · LORE · RANKINGS`).
`BUILDINGS`, `MARKET`, `DELVE`, `ARENA`, `🐗 HUNT`, `🛠 CRAFTABLES` render only
once you are inside their parent door. Measured by diffing six captures of the
live page: six labels at 6/6, everything else 1/6–4/6. **No single page shows the
whole nav**, which is why `tools/harvest-nav.js` walks the doors and why the
palette merges three sources instead of scanning one header.

**2. Navigate by CLICKING a real element, never `location.href`.** The game is a
client-routed SPA, and `/buildings` is reported to render near-empty on a hard
load while painting correctly when reached via the nav link. That report is
second-hand and unverified — but clicking costs nothing and doesn't depend on it
being true. `location.assign` is the fallback only.

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

**6. For data, read the JSON API, not the DOM.** `/api/empire/summary`,
`/api/trade`, `/api/bounties`, `/api/alliances` return stable structured JSON.
Scraping rendered numbers is the brittle path.

## Working agreements

- **Verify in a browser; do not trust reading.** Every bug so far was caught by
  the Playwright suite and none would have survived review: an author
  `display: flex` overriding the `hidden` attribute (the palette never closed);
  a backtick inside a CSS comment terminating the JS template literal holding
  the whole stylesheet; a harvester that abandoned you on whatever page its walk
  ended on.
- **Fixtures use opaque class names on purpose**, to prove the scanner is not
  leaning on readable selectors. Keep that.
- Be explicit about which layers are stable and which are best-effort. The
  README's "How durable is this, honestly" section is the contract.

## Tests

```bash
node --test test/fuzzy.test.mjs     # 12
node --test test/learned.test.mjs   # 11
python3 test/e2e.py                 # 21
python3 test/harvest.py             # 15
```

59 checks. Keep them passing.

Two gotchas already solved — don't re-hit them:

- Objects returned from a `vm` sandbox are **cross-realm**, so
  `deepStrictEqual` rejects them. Compare key sets, or copy into the test realm.
- `node --test <dir>` needs an explicit file path in some environments; pass the
  file.

Chromium for tests lives at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.
Never run `playwright install`. Launch with `--no-sandbox
--disable-setuid-sandbox --disable-quic --no-proxy-server`.

## Open work, in priority order

**1. Harvest the real destination list.** `src/catalog.js` was written from
captured page text without live-site access, and it shows: **11 of its 23 entries
have no path at all**, and `/lore` and `/inventory` are inferred. Ask the user to
open wardenfall.com, paste `tools/harvest-nav.js` into DevTools, and hand back
what it prints; paste that over the array in `catalog.js`.

**2. Decide whether to strip the runtime learning index.** The user leans toward
a plain hardcoded list, and that is probably right — once the catalog is
harvested, the learning machinery solves a problem that no longer exists.
Deleting `learned.js`, the TTL/prune, the persistence and the marker heuristics,
and collapsing `scanner.js` to a single find-anchor-for-path helper, removes
~200 lines and one whole concept. **Keep** the matcher, the shadow-DOM palette,
and click-then-navigate activation. This was offered and **not yet decided** —
confirm before ripping it out.

**3. A harvester diff mode** was proposed and not built: have `harvest-nav.js`
compare what it found against the shipped catalog and report "3 gone, 2 new,
1 moved" instead of a blind regenerate. ~15 lines, dev-time only.

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

There is no automated login here. All live-site work goes through DevTools
scripts the user pastes and reports back — design tooling for that.

If a pasted script mysteriously no-ops on the live site, **check for an open
`role="dialog"` modal first**: the game's hero level-40 ascension whisper
intercepts every pointer event app-wide. `tools/harvest-nav.js` already refuses
to run when one is open.
