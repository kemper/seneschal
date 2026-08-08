#!/usr/bin/env python3
"""
End-to-end test: load the UNPACKED extension into Chromium and drive the palette
against a mock Wardenfall shell — the same way the user will load it.

    python3 test/e2e.py

Serves the fixture over http:// (not file://) because content scripts and
chrome.storage behave differently on file URLs. The extension's manifest is
copied to a temp dir with the match pattern pointed at localhost so we exercise
the real content-script injection path rather than manually eval'ing the source.
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
    mark = "ok  " if ok else "FAIL"
    print(f"{mark} {label}" + (f"\n       {detail}" if detail and not ok else ""))


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

        # --- the extension is present ------------------------------------
        host = page.locator("#seneschal-root")
        check(await host.count() == 1, "content script mounts a shadow host")

        overlay = page.locator("#seneschal-root").locator(
            "css=.sen-overlay"
        )
        check(await overlay.is_hidden(), "palette starts hidden")

        # --- Cmd-K opens it ------------------------------------------------
        await page.keyboard.press("ControlOrMeta+k")
        await page.wait_for_timeout(200)
        check(await overlay.is_visible(), "Ctrl/Cmd-K opens the palette")

        focused = await page.evaluate(
            "() => document.getElementById('seneschal-root')"
            ".shadowRoot.activeElement?.className"
        )
        check(focused == "sen-input", "search input takes focus", f"got {focused!r}")

        # --- it indexed the header ------------------------------------------
        def item_labels():
            return page.evaluate(
                "() => [...document.getElementById('seneschal-root')"
                ".shadowRoot.querySelectorAll('.sen-item .sen-label')]"
                ".map(e => e.textContent)"
            )

        labels = await item_labels()
        for want in ["REALM", "EXPEDITIONS", "CHAMPIONS", "BUILDINGS", "MARKET"]:
            check(want in labels, f"index contains {want}")
        check(
            not any("●" in l for l in labels),
            "decorative ● stripped from labels",
            str([l for l in labels if "●" in l]),
        )
        check(
            any("CRAFTABLES" in l for l in labels),
            "emoji-prefixed sub-nav entry indexed",
        )

        # --- fuzzy filtering -------------------------------------------------
        await page.keyboard.type("exp")
        await page.wait_for_timeout(150)
        labels = await item_labels()
        check(bool(labels) and "EXPEDITIONS" in labels[0], "'exp' ranks EXPEDITIONS first", str(labels[:3]))

        marks = await page.evaluate(
            "() => [...document.getElementById('seneschal-root')"
            ".shadowRoot.querySelectorAll('.sen-item')][0]"
            ".querySelectorAll('mark').length"
        )
        check(marks > 0, "matched characters are highlighted")

        # --- Enter activates by clicking the real anchor ---------------------
        await page.keyboard.press("Enter")
        await page.wait_for_timeout(200)
        log = await page.locator("#log").text_content()
        check(log == "navigated:/expeditions", "Enter clicks the live nav link", f"log={log!r}")
        check(await overlay.is_hidden(), "palette closes after activation")

        # --- most-recently-used ordering -------------------------------------
        # EXPEDITIONS was just activated, which swapped the sub-nav row. Walk
        # back through REALM (so MARKET is on the page again) and jump to it,
        # then reopen with an empty query: the list is your history, newest
        # first, so Cmd-K then Enter repeats your last jump.
        async def jump(query: str) -> None:
            await page.keyboard.press("ControlOrMeta+k")
            await page.wait_for_timeout(150)
            await page.keyboard.type(query)
            await page.wait_for_timeout(150)
            await page.keyboard.press("Enter")
            await page.wait_for_timeout(200)

        await jump("realm")
        await jump("market")

        await page.keyboard.press("ControlOrMeta+k")
        await page.wait_for_timeout(200)
        labels = await item_labels()
        check(
            labels[:3] == ["MARKET", "REALM", "EXPEDITIONS"],
            "an empty query lists destinations most-recently-used first",
            str(labels[:5]),
        )
        groups = await page.evaluate(
            "() => [...document.getElementById('seneschal-root')"
            ".shadowRoot.querySelectorAll('.sen-group')].map(e => e.textContent)"
        )
        check(groups[:1] == ["Recent"], "the history sits under a Recent heading", str(groups[:3]))

        await page.keyboard.press("Enter")
        await page.wait_for_timeout(200)
        log = await page.locator("#log").text_content()
        check(log == "navigated:/market", "Cmd-K then Enter repeats the last jump", f"log={log!r}")

        # Typing still ranks by match quality, not by history.
        await page.keyboard.press("ControlOrMeta+k")
        await page.wait_for_timeout(150)
        await page.keyboard.type("exped")
        await page.wait_for_timeout(150)
        labels = await item_labels()
        check(
            bool(labels) and "EXPEDITIONS" in labels[0],
            "a query still ranks by match quality",
            str(labels[:3]),
        )
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(120)

        # --- arrow keys ------------------------------------------------------
        await page.keyboard.press("ControlOrMeta+k")
        await page.wait_for_timeout(150)
        await page.keyboard.type("m")
        await page.wait_for_timeout(120)
        await page.keyboard.press("ArrowDown")
        await page.wait_for_timeout(80)
        sel = await page.evaluate(
            "() => document.getElementById('seneschal-root').shadowRoot"
            ".querySelector('.sen-item[aria-selected=\"true\"]')?.dataset.index"
        )
        check(sel == "1", "ArrowDown moves the selection", f"index={sel!r}")

        # --- Escape ----------------------------------------------------------
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(150)
        check(await overlay.is_hidden(), "Escape closes the palette")

        # --- the warm index must not go stale --------------------------------
        # The index is built in the background so that opening the palette does
        # no scanning at all. The risk that buys is staleness, so: add a nav
        # entry, and it has to be findable.
        await page.evaluate(
            """() => {
                const link = document.createElement('a');
                link.setAttribute('href', '/treasury');
                link.textContent = 'TREASURY ●';
                document.querySelector('nav.c3d4').appendChild(link);
            }"""
        )
        await page.wait_for_timeout(1200)  # past the quiet period, into the idle rebuild
        await page.keyboard.press("ControlOrMeta+k")
        await page.wait_for_timeout(200)
        await page.keyboard.type("treas")
        await page.wait_for_timeout(200)
        labels = await item_labels()
        check(
            bool(labels) and "TREASURY" in labels[0],
            "a nav entry added after startup is indexed",
            str(labels[:3]),
        )
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(120)

        # --- learning survives losing the header, and does not need the ● ----
        # Strip BOTH nav rows, as if we had navigated to a door that does not
        # carry them, then reload so the index can only come from storage.
        #   LEDGER  — in a <nav> but carries NO ● marker, and is absent from the
        #             seed catalog, so seeing it proves structural learning works
        #             without the glyph (the guard for the day that dot becomes
        #             a CSS pseudo-element).
        #   BUILDINGS — marked, also learned.
        #   LORD KRISTOPH — a <button> with no href: nowhere to jump, so it must
        #             NOT be remembered once it leaves the page.
        await page.evaluate(
            "() => { document.querySelector('nav.c3d4').remove();"
            "        document.querySelector('header.a1b2').remove(); }"
        )
        await page.keyboard.press("ControlOrMeta+k")
        await page.wait_for_timeout(200)
        labels = await item_labels()
        check(
            any("LEDGER" in l for l in labels),
            "unmarked nav entry is learned (● is not load-bearing)",
            str(labels[:6]),
        )
        check(
            any("BUILDINGS" in l for l in labels),
            "contextual sub-nav still reachable after it leaves the DOM",
            str(labels[:6]),
        )
        check(
            not any("KRISTOPH" in l for l in labels),
            "hrefless header controls are not remembered",
            str([l for l in labels if "KRISTOPH" in l]),
        )
        await page.keyboard.press("Escape")

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
