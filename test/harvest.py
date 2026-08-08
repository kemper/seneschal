#!/usr/bin/env python3
"""
Test the nav harvester against the mock shell.

    python3 test/harvest.py

The fixture hides sub-nav behind its parent door exactly like the real game,
so ARENA / DELVE / HOLDS / HUNT / SPELLBOOK are NOT in the DOM on load. If the
harvester finds them, it proved it walked the doors — which is the whole point
of running it instead of scanning one page.
"""
import asyncio
import http.server
import socketserver
import sys
import threading
from pathlib import Path

from playwright.async_api import async_playwright

EXT = Path(__file__).resolve().parents[1]
FIXTURE = EXT / "test" / "fixture"
CHROMIUM = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"

results: list[tuple[bool, str]] = []


def check(ok: bool, label: str, detail: str = "") -> None:
    results.append((ok, label))
    print(("ok   " if ok else "FAIL ") + label + (f"\n       {detail}" if detail and not ok else ""))


async def main() -> int:
    handler = lambda *a, **kw: http.server.SimpleHTTPRequestHandler(  # noqa: E731
        *a, directory=str(FIXTURE), **kw
    )
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]

    script = (EXT / "tools" / "harvest-nav.js").read_text()

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            executable_path=CHROMIUM,
            headless=True,
            args=["--no-sandbox", "--disable-setuid-sandbox", "--disable-quic", "--no-proxy-server"],
        )
        page = await browser.new_page()
        await page.goto(f"http://127.0.0.1:{port}/index.html", wait_until="load")

        # Sanity: the deep entries really are absent before the walk.
        hidden = await page.evaluate(
            "() => ['/arena','/delve','/holds','/hunt','/spellbook']"
            ".filter(p => !document.querySelector(`a[href='${p}']`))"
        )
        check(len(hidden) == 5, "deep sub-nav is not in the DOM on load", str(hidden))

        # Shrink the per-door settle so the walk takes seconds, not minutes.
        await page.evaluate("() => { globalThis.__senHarvestSettle = 40; }")
        out = await page.evaluate(script)
        check(bool(out), "harvester returns a catalog block")

        for path in ["/empire", "/expeditions", "/heroes", "/buildings", "/market"]:
            check(f'"{path}"' in out, f"harvested {path}")

        # The payoff: destinations only reachable by walking into another door.
        for path in ["/arena", "/delve", "/holds", "/hunt", "/spellbook"]:
            check(f'"{path}"' in out, f"harvested {path} (behind another door)")

        check('"/ledger"' in out, "harvested an entry with no ● marker")
        check("SEN.catalog = [" in out, "output is paste-ready into catalog.js")

        # It must leave the page where it found it.
        await page.wait_for_timeout(300)
        log = await page.locator("#log").text_content()
        check(
            log == "navigated:/empire",
            "restores a sane page after the walk",
            f"log={log!r}",
        )

        await browser.close()

    httpd.shutdown()
    passed = sum(1 for ok, _ in results if ok)
    print(f"\n{passed}/{len(results)} checks passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
