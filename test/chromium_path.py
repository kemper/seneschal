"""Locate a Chromium build for the Playwright tests.

The suite runs in two places with different layouts: a Linux container that
keeps browsers in /opt/pw-browsers, and a developer's Mac where Playwright
installs them under ~/Library/Caches/ms-playwright. Hardcoding either one
makes the tests unrunnable on the other machine, so resolve at run time.

Set SENESCHAL_CHROMIUM to override.
"""
import os
from pathlib import Path

# Newest build wins, so a Playwright upgrade doesn't need a code change.
# The macOS bundle is named "Google Chrome for Testing.app", not Chromium.app,
# so match any .app rather than a fixed name.
SEARCH = [
    ("/opt/pw-browsers", "chromium-*/chrome-linux/chrome"),
    (str(Path.home() / "Library/Caches/ms-playwright"), "chromium-*/chrome-mac*/*.app/Contents/MacOS/*"),
    (str(Path.home() / ".cache/ms-playwright"), "chromium-*/chrome-linux/chrome"),
    (str(Path(os.environ.get("LOCALAPPDATA", "")) / "ms-playwright") if os.environ.get("LOCALAPPDATA") else "",
     "chromium-*/chrome-win/chrome.exe"),
]


def chromium() -> str:
    override = os.environ.get("SENESCHAL_CHROMIUM")
    if override:
        if not Path(override).exists():
            raise SystemExit(f"SENESCHAL_CHROMIUM points at a missing file: {override}")
        return override

    found: list[Path] = []
    for root, pattern in SEARCH:
        if not root:
            continue
        base = Path(root)
        if base.is_dir():
            found.extend(sorted(base.glob(pattern)))

    if not found:
        raise SystemExit(
            "No Chromium found. Looked in:\n  "
            + "\n  ".join(f"{r}/{p}" for r, p in SEARCH if r)
            + "\n\nInstall one with `python3 -m pip install playwright && python3 -m playwright install chromium`,"
            "\nor point SENESCHAL_CHROMIUM at an existing binary."
        )

    # Sort by the numeric build id in the directory name, newest last.
    def build_id(path: Path) -> int:
        for part in path.parts:
            if part.startswith("chromium-"):
                tail = part.split("-")[-1]
                return int(tail) if tail.isdigit() else 0
        return 0

    return str(sorted(found, key=build_id)[-1])


CHROMIUM = chromium()
