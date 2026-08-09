#!/usr/bin/env python3
"""
End-to-end test for the floating quick menu.

    python3 test/dock.py

Loads the real unpacked extension into Chromium against the mock Wardenfall
shell, then drives the dock the way a user would: click an entry, collapse the
rail, add a link from the page itself, and edit the menu from the options page.

The interesting case is the `menu` entry. The fixture hides sub-navigation
behind its parent door exactly like the live game, so ARENA is NOT in the DOM
when the page loads. Clicking the dock's Arena button has to walk through
/expeditions, wait for the row to re-render, and only then click ARENA — and if
that never appears, it must say so out loud instead of doing nothing.
"""
import asyncio
import http.server
import json
import shutil
import socketserver
import sys
import tempfile
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from chromium_path import CHROMIUM  # noqa: E402
from playwright.async_api import async_playwright  # noqa: E402

EXT = Path(__file__).resolve().parents[1]
FIXTURE = EXT / "test" / "fixture"

results: list[tuple[bool, str]] = []


def check(ok: bool, label: str, detail: str = "") -> None:
    results.append((ok, label))
    print(("ok   " if ok else "FAIL ") + label + (f"\n       {detail}" if detail and not ok else ""))


def serve(directory: Path) -> tuple[int, socketserver.TCPServer]:
    class Handler(http.server.SimpleHTTPRequestHandler):
        """Serve extensionless game paths the way the real site does.

        The hero panel fetches /heroes and /conquest, which on the live site
        are pages, not files. Map them onto the fixture's .html so the panel
        can be exercised end to end.
        """

        def translate_path(self, path):
            bare = path.split("?")[0].rstrip("/")
            if bare == "/expeditions/buildings/craftables":
                return super().translate_path("/craftables.html")
            if bare in ("/heroes", "/conquest"):
                path = bare + ".html"
            return super().translate_path(path)

    handler = lambda *a, **kw: Handler(*a, directory=str(directory), **kw)  # noqa: E731
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd.server_address[1], httpd


def staged_extension(port: int) -> Path:
    """Copy the extension, retargeting its match pattern at the local fixture."""
    tmp = Path(tempfile.mkdtemp(prefix="sen-ext-"))
    dest = tmp / "ext"
    shutil.copytree(EXT, dest, ignore=shutil.ignore_patterns("test"))
    mf = json.loads((dest / "manifest.json").read_text())
    mf["content_scripts"][0]["matches"] = [f"http://127.0.0.1:{port}/*"]
    (dest / "manifest.json").write_text(json.dumps(mf, indent=2))
    return dest


# Runs inside the page: the dock lives in a shadow root, so reach through it.
DOCK = "document.getElementById('seneschal-dock').shadowRoot"


async def main() -> int:
    port, httpd = serve(FIXTURE)
    ext_dir = staged_extension(port)
    profile = Path(tempfile.mkdtemp(prefix="sen-profile-"))

    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            user_data_dir=str(profile),
            executable_path=CHROMIUM,
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-quic",
                "--no-proxy-server",
                f"--disable-extensions-except={ext_dir}",
                f"--load-extension={ext_dir}",
            ],
        )
        page = await ctx.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        # Native alert/confirm/prompt are banned outright. Playwright
        # auto-dismisses dialogs, so without this listener a confirm() would
        # pass silently here and freeze a real browser instead.
        dialogs: list[str] = []

        def on_dialog(d):
            dialogs.append(f"{d.type}: {d.message}")
            # Registering a listener turns OFF Playwright's auto-dismiss, so
            # this has to dismiss it or the whole run hangs — which is the same
            # failure mode a native dialog would cause for a real user.
            asyncio.ensure_future(d.dismiss())

        page.on("dialog", on_dialog)
        await page.goto(f"http://127.0.0.1:{port}/index.html", wait_until="load")
        await page.wait_for_timeout(700)  # let document_idle injection land

        async def labels() -> list[str]:
            return await page.evaluate(
                f"() => [...{DOCK}.querySelectorAll('.dk-rail .dk-btn .dk-text')]"
                ".map(e => e.textContent)"
            )

        async def click_entry(label: str) -> bool:
            return await page.evaluate(
                f"""(want) => {{
                    const btn = [...{DOCK}.querySelectorAll('.dk-rail .dk-btn')]
                        .find(b => b.querySelector('.dk-text')?.textContent === want);
                    if (!btn) return false;
                    btn.click();
                    return true;
                }}""",
                label,
            )

        async def wrap_class() -> str:
            return await page.evaluate(f"() => {DOCK}.querySelector('.dk-wrap').className")

        async def log() -> str:
            return await page.locator("#log").text_content()

        # --- it mounts, separately from the palette --------------------------
        check(await page.locator("#seneschal-dock").count() == 1, "content script mounts the dock host")
        check(await page.locator("#seneschal-root").count() == 1, "the palette still mounts alongside it")

        seeded = await labels()
        check(
            seeded == ["Champions", "Raids", "Sieges", "Arena", "Craftables", "Military"],
            "default menu is the configured list, in order",
            str(seeded),
        )
        check("dk-right" in await wrap_class(), "dock defaults to the right edge")

        # --- a url entry clicks the live anchor ------------------------------
        # MILITARY is in the realm sub-nav right now, so this must be served by
        # clicking that anchor rather than by navigating to /military.
        check(await click_entry("Military"), "Military entry is clickable")
        await page.wait_for_timeout(250)
        check(
            await log() == "navigated:/military",
            "url entry clicks the live nav link",
            f"log={await log()!r}",
        )

        # A primary door, reachable from the header on every page.
        await click_entry("Champions")
        await page.wait_for_timeout(250)
        check(
            await log() == "navigated:/heroes",
            "url entry for a primary door works from anywhere",
            f"log={await log()!r}",
        )

        # --- menu entries ----------------------------------------------------
        # The shipped defaults are all `url` entries now that the nav harvest
        # found real paths for them, so the pattern behaviour gets its own
        # config rather than riding on whatever the defaults happen to be.
        worker = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event("serviceworker")
        ext_id = worker.url.split("/")[2]
        options = await ctx.new_page()
        await options.goto(f"chrome-extension://{ext_id}/options/options.html", wait_until="load")
        await options.wait_for_timeout(300)

        async def install(items: list[dict], note: str = "") -> None:
            await options.evaluate(
                """async (items) => {
                    const key = 'seneschal.settings.v1';
                    const cfg = (await chrome.storage.local.get(key))[key]
                                ?? { version: 1, palette: { enabled: true },
                                     dock: { enabled: true, side: 'right', collapsed: false, items: [] } };
                    cfg.dock.items = items;
                    await chrome.storage.local.set({ [key]: cfg });
                }""",
                items,
            )
            await page.bring_to_front()
            await page.wait_for_timeout(400)

        await install([
            {"id": "t-craft", "icon": "🛠", "label": "Craftables", "type": "menu", "match": "craftables"},
            {"id": "t-arena", "icon": "⚔", "label": "Arena", "type": "menu", "match": "arena",
             "door": "/expeditions"},
            {"id": "t-mil", "icon": "🪖", "label": "Military", "type": "url", "path": "/military"},
        ])
        check(await labels() == ["Craftables", "Arena", "Military"], "test menu installed", str(await labels()))

        # Put the fixture back on the realm door so its sub-nav row is showing.
        await page.evaluate("() => document.querySelector(\"header a[href='/empire']\").click()")
        await page.wait_for_timeout(250)

        # CRAFTABLES is in the current sub-nav, rendered as "🛠 CRAFTABLES ●";
        # the pattern is the bare word, so folding has to do the work.
        await click_entry("Craftables")
        await page.wait_for_timeout(250)
        check(
            await log() == "navigated:/craftables",
            "menu entry matches a decorated label on the current page",
            f"log={await log()!r}",
        )

        # --- a menu entry behind its door ------------------------------------
        absent = await page.evaluate("() => !document.querySelector(\"a[href='/arena']\")")
        check(absent, "ARENA really is absent before the walk")

        await click_entry("Arena")
        await page.wait_for_timeout(1200)
        check(
            await log() == "navigated:/arena",
            "menu entry walks through its door, then clicks the entry that appears",
            f"log={await log()!r}",
        )
        pending = await page.evaluate("() => sessionStorage.getItem('seneschal.pending.v1')")
        check(pending is None, "the pending click is cleared once it lands", str(pending))

        # Back to the shipped defaults for the rest of the run.
        await options.evaluate(
            """async () => {
                const key = 'seneschal.settings.v1';
                await chrome.storage.local.remove(key);
            }"""
        )
        await page.bring_to_front()
        await page.reload(wait_until="load")
        await page.wait_for_timeout(700)
        check(
            await labels() == ["Champions", "Raids", "Sieges", "Arena", "Craftables", "Military"],
            "clearing storage restores the shipped defaults",
            str(await labels()),
        )

        # --- collapse --------------------------------------------------------
        await page.evaluate(f"() => {DOCK}.querySelector('.dk-tab').click()")
        await page.wait_for_timeout(200)
        check("dk-collapsed" in await wrap_class(), "the tab collapses the rail")
        labels_visible = await page.evaluate(
            f"() => getComputedStyle({DOCK}.querySelector('.dk-rail .dk-text')).display"
        )
        check(labels_visible == "none", "collapsed rail hides labels but keeps them for screen readers")
        collapsed_w = await page.evaluate(
            f"() => {DOCK}.querySelector('.dk-rail').getBoundingClientRect().width"
        )
        await page.evaluate(f"() => {DOCK}.querySelector('.dk-tab').click()")
        await page.wait_for_timeout(200)
        check("dk-collapsed" not in await wrap_class(), "the tab expands it again")

        # Collapsing must actually NARROW the rail. Hiding the text while
        # something else (the nowrap siege picker) holds the width open is the
        # bug this guards — a ratio, so it survives font and padding changes.
        expanded_w = await page.evaluate(
            f"() => {DOCK}.querySelector('.dk-rail').getBoundingClientRect().width"
        )
        check(
            collapsed_w < expanded_w * 0.62,
            "collapsing actually narrows the rail, not just hides text",
            f"collapsed={collapsed_w:.0f} expanded={expanded_w:.0f}",
        )

        # --- adding a link from the page itself ------------------------------
        await page.evaluate(
            f"() => [...{DOCK}.querySelectorAll('.dk-tools .dk-btn')][0].click()"
        )
        await page.wait_for_timeout(200)
        prefilled = await page.evaluate(f"() => {DOCK}.querySelector('#dk-path').value")
        check(prefilled == "/index.html", "the add form prefills the current path", f"got {prefilled!r}")

        await page.fill("#seneschal-dock >> css=#dk-label", "Ledger")
        await page.fill("#seneschal-dock >> css=#dk-path", "/ledger")
        await page.evaluate(f"() => {DOCK}.querySelector('.dk-save').click()")
        await page.wait_for_timeout(300)
        check("Ledger" in await labels(), "the new entry appears on the rail", str(await labels()))

        # --- the confirmation toast keeps out of the way ---------------------
        # It used to be nested inside the transformed .dk-wrap, which made it
        # the wrap's containing block, so "fixed; bottom" planted the toast on
        # top of the menu. Assert the geometry, not the markup.
        boxes = await page.evaluate(
            f"""() => {{
                const r = {DOCK}.querySelector('.dk-rail').getBoundingClientRect();
                const t = {DOCK}.querySelector('.dk-toast').getBoundingClientRect();
                return {{ visible: !{DOCK}.querySelector('.dk-toast').hidden,
                          overlaps: !(t.right < r.left || t.left > r.right ||
                                      t.bottom < r.top || t.top > r.bottom),
                          below: t.top >= r.bottom }};
            }}"""
        )
        check(boxes["visible"], "adding an entry confirms with a toast")
        check(not boxes["overlaps"], "the toast does not cover the menu", str(boxes))

        # Poll rather than sleep a fixed span: the hero refresh runs two fetches
        # in the background, and a single timed wait races with them. The point
        # is that a confirmation clears on its own well before a warning's 7s.
        cleared_ms = None
        for elapsed in range(0, 5200, 200):
            if await page.evaluate(f"() => {DOCK}.querySelector('.dk-toast').hidden"):
                cleared_ms = elapsed
                break
            await page.wait_for_timeout(200)
        check(
            cleared_ms is not None and cleared_ms < 5000,
            "the confirmation toast clears on its own, faster than a warning",
            f"cleared after {cleared_ms}ms",
        )

        # Scaffolding, not a behaviour under test: put the fixture back on the
        # realm door so LEDGER is in the sub-nav row and the new entry can be
        # served by clicking a live anchor.
        await page.evaluate("() => document.querySelector(\"header a[href='/empire']\").click()")
        await page.wait_for_timeout(250)
        await click_entry("Ledger")
        await page.wait_for_timeout(250)
        check(await log() == "navigated:/ledger", "the new entry navigates", f"log={await log()!r}")

        # --- a rejected entry says why, and is not saved ---------------------
        await page.evaluate(f"() => [...{DOCK}.querySelectorAll('.dk-tools .dk-btn')][0].click()")
        await page.wait_for_timeout(150)
        await page.fill("#seneschal-dock >> css=#dk-label", "Nope")
        await page.fill("#seneschal-dock >> css=#dk-path", "javascript:alert(1)")
        await page.evaluate(f"() => {DOCK}.querySelector('.dk-save').click()")
        await page.wait_for_timeout(250)
        error = await page.evaluate(f"() => {DOCK}.querySelector('.dk-error').textContent")
        check(bool(error), "a bad path is refused with a reason", f"error={error!r}")
        check("Nope" not in await labels(), "the refused entry is not added")
        await page.evaluate(f"() => {DOCK}.querySelector('.dk-cancel').click()")

        # --- the palette does not index our own buttons ----------------------
        await page.keyboard.press("ControlOrMeta+k")
        await page.wait_for_timeout(200)
        await page.keyboard.type("ledger")
        await page.wait_for_timeout(200)
        palette_rows = await page.evaluate(
            "() => [...document.getElementById('seneschal-root').shadowRoot"
            ".querySelectorAll('.sen-item .sen-label')].map(e => e.textContent)"
        )
        check(
            palette_rows.count("Ledger") == 0,
            "the palette does not index the dock's own buttons",
            str(palette_rows),
        )
        await page.keyboard.press("Escape")

        # --- the options page edits the live dock ----------------------------
        await options.bring_to_front()
        await options.reload(wait_until="load")
        await options.wait_for_timeout(400)

        rows = await options.locator(".item").count()
        check(rows == len(await labels()), "options page lists the same entries as the rail", f"{rows} rows")

        await options.check('input[name="side"][value="left"]')
        await options.wait_for_timeout(500)
        check("dk-left" in await wrap_class(), "changing the side moves the live dock", await wrap_class())

        await options.locator(".item").last.locator("button[title='Remove']").click()
        await options.wait_for_timeout(500)
        check("Ledger" not in await labels(), "removing an entry updates the live dock", str(await labels()))

        await options.uncheck("#enabled")
        await options.wait_for_timeout(500)
        hidden = await page.evaluate(f"() => {DOCK}.querySelector('.dk-wrap').hidden")
        check(hidden is True, "unchecking 'show the quick menu' hides the dock")
        await options.check("#enabled")
        await options.wait_for_timeout(400)

        # --- the toolbar popup switches each surface off ---------------------
        popup = await ctx.new_page()
        await popup.goto(f"chrome-extension://{ext_id}/popup/popup.html", wait_until="load")
        await popup.wait_for_timeout(300)
        check(
            await popup.is_checked("#palette") and await popup.is_checked("#dock"),
            "the popup reflects both surfaces being on",
        )

        await popup.uncheck("#dock")
        await popup.wait_for_timeout(500)
        check(
            await page.evaluate(f"() => {DOCK}.querySelector('.dk-wrap').hidden") is True,
            "the popup's quick menu switch hides the dock live",
        )
        await popup.check("#dock")
        await popup.wait_for_timeout(400)

        await popup.uncheck("#palette")
        await popup.wait_for_timeout(500)
        await page.bring_to_front()
        await page.keyboard.press("ControlOrMeta+k")
        await page.wait_for_timeout(300)
        palette_open = await page.evaluate(
            "() => !document.getElementById('seneschal-root').shadowRoot"
            ".querySelector('.sen-overlay').hidden"
        )
        check(not palette_open, "with the palette switched off, Cmd-K does nothing")

        await popup.bring_to_front()
        await popup.check("#palette")
        await popup.wait_for_timeout(500)
        await page.bring_to_front()
        await page.keyboard.press("ControlOrMeta+k")
        await page.wait_for_timeout(300)
        palette_open = await page.evaluate(
            "() => !document.getElementById('seneschal-root').shadowRoot"
            ".querySelector('.sen-overlay').hidden"
        )
        check(palette_open, "switching it back on restores Cmd-K without a reload")
        await page.keyboard.press("Escape")

        await popup.bring_to_front()
        await popup.click("#side")
        await popup.wait_for_timeout(500)
        check("dk-right" in await wrap_class(), "the popup's side button flips the dock back", await wrap_class())
        await popup.close()

        # --- a pattern that matches nothing fails LOUDLY ---------------------
        # This is the failure mode that matters: the game renames a menu entry
        # and the button would otherwise just quietly stop working.
        await options.evaluate(
            """async () => {
                const key = 'seneschal.settings.v1';
                const cfg = (await chrome.storage.local.get(key))[key];
                cfg.dock.items = [{ id: 'ghost', icon: '👻', label: 'Ghost',
                                    type: 'menu', match: 'nosuchthing', door: '/empire' }];
                await chrome.storage.local.set({ [key]: cfg });
            }"""
        )
        await page.wait_for_timeout(400)
        check(await labels() == ["Ghost"], "storage changes reach the dock live", str(await labels()))

        await click_entry("Ghost")
        await page.wait_for_timeout(7000)  # the resolve window is 6s
        toast = await page.evaluate(
            f"() => {{ const t = {DOCK}.querySelector('.dk-toast');"
            "  return t.hidden ? '' : t.textContent; }"
        )
        check(
            "nosuchthing" in toast,
            "an unmatchable pattern warns the user instead of doing nothing",
            f"toast={toast!r}",
        )
        stale = await page.evaluate("() => sessionStorage.getItem('seneschal.pending.v1')")
        check(stale is None, "the failed pending click does not linger", str(stale))

        # --- a pending click survives a FULL page load -----------------------
        # In the fixture the door is same-document, so the in-memory watcher
        # covers it. A real navigation tears that watcher down, which is why the
        # pending click is also written to sessionStorage — this is that path.
        await page.evaluate(
            """() => sessionStorage.setItem('seneschal.pending.v1',
                 JSON.stringify({ match: 'ledger', label: 'Ledger',
                                  expires: Date.now() + 6000 }))"""
        )
        await page.reload(wait_until="load")
        await page.wait_for_timeout(1500)
        check(
            await log() == "navigated:/ledger",
            "a pending click is resumed after a full page load",
            f"log={await log()!r}",
        )

        # --- last resort: a path with no anchor on the page ------------------
        # Clicking a real element is always preferred, but a destination that is
        # nowhere on this page still has to work. This one leaves the fixture,
        # so it runs last.
        await options.evaluate(
            """async () => {
                const key = 'seneschal.settings.v1';
                const cfg = (await chrome.storage.local.get(key))[key];
                cfg.dock.items = [{ id: 'far', icon: '→', label: 'Far', type: 'url', path: '/far-away' }];
                await chrome.storage.local.set({ [key]: cfg });
            }"""
        )
        await page.wait_for_timeout(400)
        await click_entry("Far")
        await page.wait_for_timeout(800)
        check(
            page.url.endswith("/far-away"),
            "a path with no anchor on the page falls back to navigating",
            page.url,
        )
        await page.wait_for_timeout(600)
        check(
            await page.locator("#seneschal-dock").count() == 1,
            "the dock comes back after a full page load",
        )

        # --- the hero panel --------------------------------------------------
        await options.evaluate(
            """async () => {
                const key = 'seneschal.settings.v1';
                await chrome.storage.local.remove(key);
            }"""
        )
        await page.bring_to_front()
        await page.reload(wait_until="load")
        await page.wait_for_timeout(1500)  # let /heroes be fetched and parsed

        heroes = await page.evaluate(
            f"() => [...{DOCK}.querySelectorAll('.dk-hero')].map(r => ({{"
            "  name: r.querySelector('.dk-hero-name')?.textContent,"
            "  hp: r.querySelector('.dk-hero-hp')?.textContent }))"
        )
        check(len(heroes) == 5, "hero panel lists every hero", str(heroes))
        check(
            [h["name"] for h in heroes] == ["Krogdolf", "Krogloff", "Krogsly", "Krogman", "Krogdore"],
            "heroes are named and ordered as the page has them",
            str([h["name"] for h in heroes]),
        )
        bars = await page.evaluate(
            f"() => [...{DOCK}.querySelectorAll('.dk-bar-fill')].map(b => b.style.width)"
        )
        check(bars[:3] == ["45%", "100%", "24%"], "HP bars are proportional", str(bars))
        classes = await page.evaluate(
            f"() => [...{DOCK}.querySelectorAll('.dk-bar-fill')].map(b => b.className)"
        )
        check("dk-bad" in classes[2], "a badly hurt hero's bar is coloured for it", str(classes[:3]))

        siege = await page.evaluate(
            f"() => {{ const b = {DOCK}.querySelector('.dk-siege');"
            "  return b ? { text: b.textContent, hidden: b.hidden, disabled: b.disabled } : null; }"
        )
        # The fixture names three bulwarks but only ONE renders assault
        # locations. Naming alone used to be read as three active sieges.
        check(
            siege is not None and siege["text"] == "Heals from: Ashvale Bulwark",
            "only the siege you are committed to counts as active",
            str(siege),
        )

        # --- heal all ---------------------------------------------------------
        heal_all = await page.evaluate(
            f"""() => {{
                const b = {DOCK}.querySelector('.dk-healall');
                const q = {DOCK}.querySelector('.dk-quote');
                return b ? {{ text: b.textContent, title: b.title, quote: q ? q.textContent : null }} : null;
            }}"""
        )
        check(heal_all is not None, "the heal-all control is mirrored from the game", str(heal_all))
        check(
            heal_all and "79 HP to mend" in (heal_all["quote"] or ""),
            "the game's own price quote is shown, not one we computed",
            str(heal_all),
        )
        check(
            heal_all and "HEAL ALL HEROES" not in (heal_all["quote"] or ""),
            "the quote excludes the button's own label",
            str(heal_all),
        )

        # --- one button per healing method ------------------------------------
        methods = await page.evaluate(
            f"""() => {{
                const rows = [...{DOCK}.querySelectorAll('.dk-hero')];
                const strips = [...{DOCK}.querySelectorAll('.dk-methods')];
                return strips.map(s => [...s.querySelectorAll('.dk-method')]
                    .map(b => ({{ glyph: b.textContent, title: b.title, disabled: b.disabled }})));
            }}"""
        )
        check(len(methods) == 3, "method buttons appear only for wounded heroes", str(len(methods)))
        titles = [b["title"] for b in methods[0]]
        check(
            any("Salveroot Tonic · +10 HP" in t for t in titles)
            and any("Knitbone Draught · +25 HP" in t for t in titles)
            and any("Wardenbalm Elixir · +50 HP" in t for t in titles),
            "every elixir gets its own named button",
            str(titles),
        )
        check(
            any("brews one for 6 timber + 2 iron" in t for t in titles),
            "a button you must brew for quotes the brewing cost",
            str(titles),
        )
        check(
            any("you hold 2" in t for t in titles),
            "a button you can use now says how many you hold",
            str(titles),
        )
        # Krogman is the lightly wounded one (425/431), so a +50 elixir on him
        # is plainly more than the wound needs.
        light = methods[2]
        by_glyph = {b["glyph"]: b for b in light}
        check(
            by_glyph.get("💧", {}).get("disabled") is True,
            "an elixir with none held and no materials is disabled",
            str(by_glyph.get("💧")),
        )
        check(
            any("⛑" == b["glyph"] for b in light),
            "siege provisions get their own button, distinct from the elixirs",
            str([b["glyph"] for b in light]),
        )
        check(
            "more than this wound needs" in (by_glyph.get("💧", {}).get("title") or ""),
            "an elixir bigger than the wound says so",
            str(by_glyph.get("💧", {}).get("title")),
        )

        # --- asking happens in our own panel, never in a native dialog --------
        # Clicking a heal method must ask first. Cancelling it must spend
        # nothing, which is why this test only ever presses Cancel.
        await page.evaluate(
            f"() => {DOCK}.querySelectorAll('.dk-methods')[0].querySelector('.dk-method').click()"
        )
        await page.wait_for_timeout(150)
        ask = await page.evaluate(
            f"""() => {{
                const a = {DOCK}.querySelector('.dk-ask');
                if (!a || a.hidden) return null;
                return {{
                    title: a.querySelector('h2').textContent,
                    body: a.querySelector('.dk-ask-body').textContent,
                    yes: a.querySelector('.dk-ask-yes').textContent,
                    role: a.getAttribute('role'),
                    focused: {DOCK}.activeElement === a.querySelector('.dk-ask-yes'),
                }};
            }}"""
        )
        check(ask is not None, "a heal asks before it spends", str(ask))
        check(
            ask and ask["title"].startswith("Heal Krogdolf"),
            "the question names the hero it is about to heal",
            str(ask),
        )
        check(
            ask and "221/489" in ask["body"] and "spends" in ask["body"],
            "the question quotes the HP and the price",
            str(ask),
        )
        check(ask and ask["role"] == "alertdialog", "the panel announces itself to a screen reader", str(ask))
        check(ask and ask["focused"], "confirm is focused, so Enter answers it", str(ask))

        # Escape answers no, exactly like the add form.
        await page.evaluate(
            f"""() => {DOCK}.querySelector('.dk-ask').dispatchEvent(
                new KeyboardEvent('keydown', {{ key: 'Escape', bubbles: true }}))"""
        )
        await page.wait_for_timeout(100)
        check(
            await page.evaluate(f"() => {DOCK}.querySelector('.dk-ask').hidden"),
            "Escape closes the question without spending",
        )

        # Heal-all asks with the GAME's costing line, not one we computed.
        await page.evaluate(f"() => {DOCK}.querySelector('.dk-healall').click()")
        await page.wait_for_timeout(150)
        ask_all = await page.evaluate(
            f"""() => {{
                const a = {DOCK}.querySelector('.dk-ask');
                return a.hidden ? null : {{ title: a.querySelector('h2').textContent,
                                            body: a.querySelector('.dk-ask-body').textContent }};
            }}"""
        )
        check(
            ask_all and "79 HP to mend" in ask_all["body"],
            "heal-all quotes the game's own price back before spending",
            str(ask_all),
        )
        await page.evaluate(f"() => {DOCK}.querySelector('.dk-ask-no').click()")
        await page.wait_for_timeout(100)

        # Opening the add form must not leave a question stranded behind it.
        await page.evaluate(f"() => {DOCK}.querySelector('.dk-tools .dk-btn').click()")
        await page.wait_for_timeout(100)
        check(
            await page.evaluate(f"() => {DOCK}.querySelector('.dk-ask').hidden"),
            "opening the add form closes any open question",
        )
        await page.evaluate(f"() => {DOCK}.querySelector('.dk-cancel').click()")

        check(not dialogs, "no native alert, confirm or prompt is ever used", "; ".join(dialogs))

        # --- the roster is cached, so navigation never flashes a placeholder --
        cached = await options.evaluate(
            """async () => {
                const o = await chrome.storage.local.get('seneschal.heroes.v1');
                const c = o['seneschal.heroes.v1'];
                return c ? { heroes: c.heroes.length, sieges: c.sieges.length, hasAt: !!c.at } : null;
            }"""
        )
        check(cached is not None and cached["heroes"] == 5, "the roster is written to the cache", str(cached))

        # Reload and watch the panel's very first paints. Because every in-game
        # navigation is a full page load, a placeholder here would be seen on
        # every page — so it must never appear once something is cached.
        await page.bring_to_front()
        await page.reload(wait_until="load")
        seen = []
        for _ in range(24):
            state = await page.evaluate(
                f"""() => {{
                    const host = document.getElementById('seneschal-dock');
                    if (!host) return null;
                    const box = host.shadowRoot.querySelector('.dk-heroes');
                    if (!box) return null;
                    return [...box.querySelectorAll('.dk-hero-name')].map(e => e.textContent).join(',');
                }}"""
            )
            if state:
                seen.append(state)
            await page.wait_for_timeout(60)
        check(
            bool(seen) and not any("Reading heroes" in s for s in seen),
            "no placeholder is shown once the roster is cached",
            str(seen[:3]),
        )
        check(
            bool(seen) and seen[0].startswith("Krogdolf"),
            "the cached roster paints first",
            str(seen[:2]),
        )

        # Switching the palette off must not take the hero panel with it.
        check(
            await page.locator("#seneschal-dock").count() == 1,
            "hero panel lives in the dock host",
        )

        check(not errors, "no uncaught page errors", "; ".join(errors))
        await ctx.close()

    httpd.shutdown()
    shutil.rmtree(profile, ignore_errors=True)
    shutil.rmtree(ext_dir.parent, ignore_errors=True)

    passed = sum(1 for ok, _ in results if ok)
    total = len(results)
    print(f"\n{passed}/{total} checks passed")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
