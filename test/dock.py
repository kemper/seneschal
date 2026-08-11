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
from playwright.async_api import async_playwright  # noqa: E402

EXT = Path(__file__).resolve().parents[1]
FIXTURE = EXT / "test" / "fixture"
CHROMIUM = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"

results: list[tuple[bool, str]] = []


def check(ok: bool, label: str, detail: str = "") -> None:
    results.append((ok, label))
    print(("ok   " if ok else "FAIL ") + label + (f"\n       {detail}" if detail and not ok else ""))


def serve(directory: Path) -> tuple[int, socketserver.TCPServer]:
    handler = lambda *a, **kw: http.server.SimpleHTTPRequestHandler(  # noqa: E731
        *a, directory=str(directory), **kw
    )
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
        for want in ["Realm", "Expeditions", "Buildings", "Craftables", "Arena", "Hunt"]:
            check(want in seeded, f"default menu contains {want}", str(seeded))
        check("dk-right" in await wrap_class(), "dock defaults to the right edge")

        # --- a url entry clicks the live anchor ------------------------------
        check(await click_entry("Realm"), "Realm entry is clickable")
        await page.wait_for_timeout(200)
        check(await log() == "navigated:/empire", "url entry clicks the live nav link", f"log={await log()!r}")

        # --- a menu entry already on the page --------------------------------
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

        # --- collapse --------------------------------------------------------
        await page.evaluate(f"() => {DOCK}.querySelector('.dk-tab').click()")
        await page.wait_for_timeout(200)
        check("dk-collapsed" in await wrap_class(), "the tab collapses the rail")
        labels_visible = await page.evaluate(
            f"() => getComputedStyle({DOCK}.querySelector('.dk-rail .dk-text')).display"
        )
        check(labels_visible == "none", "collapsed rail hides labels but keeps them for screen readers")
        await page.evaluate(f"() => {DOCK}.querySelector('.dk-tab').click()")
        await page.wait_for_timeout(200)
        check("dk-collapsed" not in await wrap_class(), "the tab expands it again")

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

        # Back to the realm door, so LEDGER is in the sub-nav row again and the
        # entry can be served by clicking a live anchor.
        await click_entry("Realm")
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
        worker = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event("serviceworker")
        ext_id = worker.url.split("/")[2]
        options = await ctx.new_page()
        await options.goto(f"chrome-extension://{ext_id}/options/options.html", wait_until="load")
        await options.wait_for_timeout(300)

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

        # --- raising a spectral host -----------------------------------------
        # The only thing the extension does that SPENDS something. These tests
        # are about the guarantees around that: it reads the panel before it
        # acts, it asks first, and it never clicks a rite it cannot account
        # for. The fixture's rites panel is a RECONSTRUCTION of a page-text
        # capture (see index.html), so this pins the extension's behaviour
        # against that reconstruction — not against the live game.
        async def set_items(items: list[dict]) -> None:
            await options.evaluate(
                """async (items) => {
                    const key = 'seneschal.settings.v1';
                    const cfg = (await chrome.storage.local.get(key))[key];
                    cfg.dock.items = items;
                    await chrome.storage.local.set({ [key]: cfg });
                }""",
                items,
            )

        SHEET = """() => {
          const root = document.getElementById('seneschal-dock').shadowRoot;
          const scrim = root.querySelector('.dk-scrim');
          if (scrim.hidden) return { open: false };
          return {
            open: true,
            title: root.querySelector('.dk-sheet h2').textContent,
            readings: [...root.querySelectorAll('.dk-read div')]
                        .map(d => d.querySelector('dt').textContent + '=' + d.querySelector('dd').textContent),
            body: root.querySelector('.dk-sheet-body').textContent,
            warn: root.querySelector('.dk-sheet-warn').hidden
                    ? '' : root.querySelector('.dk-sheet-warn').textContent,
            actions: [...root.querySelectorAll('.dk-sheet-actions button')]
                       .map(b => ({ text: b.textContent, danger: b.classList.contains('dk-danger') })),
          };
        }"""

        async def sheet() -> dict:
            return await page.evaluate(SHEET)

        async def click_sheet(fragment: str) -> bool:
            return await page.evaluate(
                """(want) => {
                    const root = document.getElementById('seneschal-dock').shadowRoot;
                    const b = [...root.querySelectorAll('.dk-sheet-actions button')]
                                .find(x => x.textContent.includes(want));
                    if (!b) return false;
                    b.click();
                    return true;
                }""",
                fragment,
            )

        async def badge(entry_id: str) -> str:
            return await page.evaluate(
                """(id) => {
                    const root = document.getElementById('seneschal-dock').shadowRoot;
                    const b = [...root.querySelectorAll('.dk-btn')].find(x => x.dataset.id === id);
                    const el = b && b.querySelector('[data-role="souls"]');
                    return el ? el.textContent : null;
                }""",
                entry_id,
            )

        async def souls_on_page() -> str:
            return await page.evaluate(
                "() => (/([0-9][0-9,]*) souls/.exec(document.body.textContent) || [])[1] || ''"
            )

        await set_items(
            [
                {"id": "host-small", "icon": "👻", "label": "Small host", "type": "host",
                 "souls": 1000, "match": "necromancy", "door": "/empire"},
                {"id": "host-big", "icon": "👻", "label": "Big host", "type": "host",
                 "souls": 4500, "match": "necromancy", "door": "/empire"},
                {"id": "host-lost", "icon": "👻", "label": "Lost host", "type": "host",
                 "souls": 500, "match": "nosuchrite", "door": "/empire"},
                {"id": "exp", "icon": "🧭", "label": "Expeditions", "type": "url", "path": "/expeditions"},
            ]
        )
        await page.bring_to_front()
        await page.wait_for_timeout(500)
        check(await badge("host-small") == "—",
              "a host entry shows no balance before one has been read", str(await badge("host-small")))

        # Stand where the rites are NOT reachable, so the entry has to walk its
        # door first — the same journey a `menu` entry makes.
        await click_entry("Expeditions")
        await page.wait_for_timeout(300)
        check(await page.evaluate("() => !document.querySelector(\"a[href='/necromancy']\")"),
              "the rites are genuinely out of reach before the walk")

        await click_entry("Small host")
        await page.wait_for_timeout(2500)
        s = await sheet()
        check(s["open"], "raising a host asks first, and spends nothing yet", str(s))
        check("Souls=4,120" in s.get("readings", []),
              "the sheet shows the balance it actually read off the page", str(s.get("readings")))
        check("Disturbance=12 / 50" in s.get("readings", []),
              "and the disturbance it read", str(s.get("readings")))
        check("1,000" in s.get("body", ""), "it names the size it is about to raise", s.get("body", ""))
        check(await log() == "navigated:/necromancy",
              "it walked the door and opened the rites panel", f"log={await log()!r}")

        # Escape has to back out of a sheet that is about to spend souls.
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(300)
        check(not (await sheet())["open"], "Escape dismisses the sheet")
        check(await log() == "navigated:/necromancy", "and nothing was performed", f"log={await log()!r}")

        # --- the plain case: enough souls in hand ----------------------------
        await click_entry("Small host")
        await page.wait_for_timeout(1500)
        s = await sheet()
        check(s["open"], "the sheet opens again, now from the rites page itself", str(s))
        check(s["actions"] and not any(a["danger"] for a in s["actions"]),
              "with souls in hand there is nothing destructive to offer", str(s.get("actions")))
        check(await click_sheet("Raise 1,000"), "the confirm button is there to click", str(s.get("actions")))
        await page.wait_for_timeout(1500)
        check(await log() == "rite:host:1000",
              "confirming performs the rite at the configured size", f"log={await log()!r}")
        check(await souls_on_page() == "3,120",
              "the balance moved by exactly what was approved", await souls_on_page())
        check(await badge("host-small") == "3.1k",
              "the rail picks the new balance up", str(await badge("host-small")))

        # --- the destructive case: short, and sacrifice would cover it -------
        # 4,500 wanted against 3,120 held is 1,380 short: six harvests at the
        # 240 the button advertises.
        await click_entry("Big host")
        await page.wait_for_timeout(1500)
        s = await sheet()
        check(s["open"], "a shortfall asks first too", str(s))
        check("6" in s.get("body", "") and "1,380" in s.get("body", ""),
              "the sheet counts the sacrifices and names the shortfall", s.get("body", ""))
        check("living veterans" in s.get("warn", ""),
              "it says out loud what a sacrifice costs", s.get("warn", ""))
        check(len([a for a in s["actions"] if a["danger"]]) == 1,
              "the destructive choice is the one marked as such", str(s["actions"]))
        check(any("instead" in a["text"] for a in s["actions"]),
              "the smaller, non-destructive host is offered beside it", str(s["actions"]))

        check(await click_sheet("Sacrifice"), "the sacrifice button is there to click")
        await page.wait_for_timeout(7000)
        check(await log() == "rite:host:4500",
              "it harvests the shortfall, then raises the full host", f"log={await log()!r}")
        # 3,120 + 6 x 240 = 4,560, less the 4,500 raised.
        check(await souls_on_page() == "60",
              "the arithmetic across six harvests and a raise holds", await souls_on_page())

        # --- a rites page it cannot reach fails LOUDLY -----------------------
        # Leave the panel first. Standing ON it, the entry short-circuits and
        # never hunts at all — correct, but not what is under test here.
        await click_entry("Expeditions")
        await page.wait_for_timeout(300)
        check(await souls_on_page() == "", "the rites panel is off screen again")

        await click_entry("Lost host")
        await page.wait_for_timeout(7000)  # door walk plus the 6s resolve window
        toast = await page.evaluate(
            f"() => {{ const t = {DOCK}.querySelector('.dk-toast');"
            "  return t.hidden ? '' : t.textContent; }"
        )
        check("nosuchrite" in toast,
              "an unreachable rites page warns, naming the pattern that failed", f"toast={toast!r}")
        check(not (await sheet())["open"], "no sheet is left open behind the failure")
        check(await log() != "rite:host:500", "and nothing was performed", f"log={await log()!r}")

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
        BUSY_PROBE = """() => {
          const root = document.getElementById('seneschal-dock').shadowRoot;
          const b = [...root.querySelectorAll('.dk-btn')].find(x => x.dataset.id === 'ghost');
          const icon = b && b.querySelector('.dk-icon');
          const t = root.querySelector('.dk-toast');
          return { busy: b && b.getAttribute('data-busy'),
                   aria: b && b.getAttribute('aria-busy'),
                   spinner: !!(icon && icon.classList.contains('dk-spinner')),
                   glyph: icon ? icon.textContent : null,
                   toast: t.hidden ? '' : t.textContent };
        }"""

        # --- the in-flight indicator -----------------------------------------
        # The hunt can run the full RESOLVE_MS with nothing on screen moving,
        # which reads as a button that did nothing. While it runs, the entry's
        # icon becomes a spinner and the status line names what is pending.
        await page.wait_for_timeout(500)
        flight = await page.evaluate(BUSY_PROBE)
        check(flight["busy"] == "true", "the entry shows as in flight while hunting", str(flight))
        check(flight["spinner"], "its icon becomes a spinner", str(flight))
        check(flight["aria"] == "true", "it is marked aria-busy for screen readers", str(flight))
        check("Ghost" in flight["toast"], "the status line names the pending entry", str(flight))

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

        settled = await page.evaluate(BUSY_PROBE)
        check(settled["busy"] is None, "the indicator clears when the hunt gives up", str(settled))
        check(not settled["spinner"], "the spinner is removed", str(settled))
        check(settled["glyph"] == "\U0001F47B", "the entry's own glyph comes back", str(settled))

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
