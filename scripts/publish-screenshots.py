#!/usr/bin/env python3
"""Publish capture-rig PNGs as the documentation and README screenshots.

The rig in ``apps/desktop/electron/main/bootstrap/window.ts`` writes PNGs to
``/tmp/codex-screens`` when the app runs with ``PI_DESKTOP_CAPTURE=1``. Those
frames are the source of truth for every screenshot the project ships, so the
docs never drift from the shell the e2e UI scenarios describe.

Run the rig once per locale, then publish each pass:

    python3 scripts/publish-screenshots.py --source /tmp/shots-en --locale en
    python3 scripts/publish-screenshots.py --source /tmp/shots-zh --locale zh

The rig must run against a throwaway data directory rather than the developer's
own profile. Without this the sidebar, the file tree, and the composer in every
frame carry that developer's real project and session titles:

    PI_DESKTOP_CAPTURE=1 \\
    PI_DESKTOP_DATA_DIR=/tmp/shots-profile \\
    electron apps/desktop --lang=en-US

Three stores come out of one pass, and every file in all three is written here —
none of them is hand-made, because a hand-made frame is one the rig cannot
reproduce and therefore one that rots silently:

    docs/public/screenshots/app/<locale>/<scene>.webp   the docs gallery
    docs/image/readme/<stem>.<locale>.webp              the GitHub READMEs
    docs/public/readme/<stem>.<locale>.webp             the docs-site landing page

Scenes the rig produces but ``SCENES`` omits are duplicates of another frame,
not surfaces we hide.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
GALLERY_ROOT = ROOT / "docs" / "public" / "screenshots" / "app"
README_ROOT = ROOT / "docs" / "image" / "readme"
LANDING_ROOT = ROOT / "docs" / "public" / "readme"

# Rendered at 2x the ~800px docs content column; webp keeps each frame around
# 35 KB, so the whole bilingual gallery costs a few megabytes.
TARGET_WIDTH = 1600
QUALITY = 82

LOCALES = ("en", "zh")

# Scene id (the rig's shot() name without the "pi-" prefix) in gallery order.
#
# Every entry must be a frame the rig actually writes; `screenshot-catalog`
# asserts that, because this list silently rotted once already. It kept naming
# `pulls-live` and `dark-pulls` after ADR 0308 removed the destination, and
# `panel-menu` after the work panel lost its overflow menu. `publish()` fails
# loudly on a missing frame, so a stale entry does not publish a partial
# gallery — it refuses to publish anything, which is exactly why the committed
# gallery sat at v0.14.6 while the shell moved on.
#
# A scene also has to be *distinct*. Five are deliberately absent rather than
# shipped as a second copy of a frame that already appears under another
# caption — the rig drives a UI that ignores the step, so the shot fires on an
# unchanged screen. `search-anchor` lands back on the home screen,
# `dark-home` reproduces `home-dark` once the preceding scene has already
# restored the chat page, and `extensions-subagents-provided`,
# `extensions-subagent-editor` and `settings-extensions-custom` come out
# identical to the scene before them (the subagent editor button and the
# marketplace source picker both moved to components the rig's selectors no
# longer reach). `screenshot-catalog` fails if any two published frames are
# byte-identical, so restoring one of these scenes means fixing the step that
# drives it.
SCENES = (
    # Home and conversation
    "home-light",
    "home-dark",
    "minimap",
    "minimap-hover",
    "model-menu",
    "composer-slash",
    "composer-at",
    # Work panels
    "panel-review",
    "panel-browser",
    "panel-files",
    # Destinations
    "project-archive-live",
    "dark-project-archive",
    "scheduled-live",
    # Notifications and toasts
    "notifications-light",
    "notifications-dark",
    "notifications-narrow",
    "toasts-light",
    "toasts-dark",
    # Global search
    "search",
    "search-query",
    "search-settings",
    "search-pages",
    "search-dark",
    # Plugins
    "plugins-live",
    "plugins-market",
    "plugins-menu",
    "plugins-row-menu",
    "plugins-template",
    # Extensions
    "extensions-mcp",
    "extensions-scope",
    "extensions-mcp-editor",
    "extensions-skills",
    "extensions-subagents",
    "extensions-subagents-dark",
    "extensions-mcp-dark",
    # Settings
    "settings-live",
    "dark-settings",
    "settings-models",
    "settings-extensions",
)

# Gallery scene -> README file stem, written to docs/image/readme/ as
# <stem>.<locale>.webp. Both front pages embed their own locale's variant, so
# the Chinese README never shows an English shell.
README_SHOTS = {
    "home-light": "home",
    "minimap": "conversation",
    "panel-review": "review",
    "plugins-market": "marketplace",
    "model-menu": "models",
    "scheduled-live": "scheduled",
}

# Gallery scene -> landing-page slot stem, written to docs/public/readme/ as
# <stem>.<locale>.webp for DocumentationHome.vue. Same rule as
# the README set: generated here, never checked in by hand.
LANDING_SHOTS = {
    "home-light": "hero",
    "minimap": "sessions",
    "plugins-market": "plugins",
    "delegation-cards": "orchestration",
    "model-menu": "models",
    "settings-provider-dialog": "providers",
    "run-rows": "workers",
}


def _resize(frame: Image.Image) -> Image.Image:
    height = round(frame.height * TARGET_WIDTH / frame.width)
    return frame.resize((TARGET_WIDTH, height), Image.LANCZOS)


def _save(frame: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    frame.save(path, "WEBP", quality=QUALITY, method=6)


def publish(source: Path, locale: str) -> int:
    gallery = GALLERY_ROOT / locale
    gallery.mkdir(parents=True, exist_ok=True)

    # The landing set draws on scenes outside SCENES, so validate against the
    # union rather than the gallery list alone.
    needed = dict.fromkeys([*SCENES, *LANDING_SHOTS])
    missing = [scene for scene in needed if not (source / f"pi-{scene}.png").exists()]
    if missing:
        print(f"missing {len(missing)} scene(s) in {source}: {', '.join(missing)}")
        return 1

    frames: dict[str, Image.Image] = {}
    for scene in needed:
        frame = _resize(Image.open(source / f"pi-{scene}.png").convert("RGB"))
        frames[scene] = frame
        if scene in SCENES:
            _save(frame, gallery / f"{scene}.webp")

    for scene, stem in README_SHOTS.items():
        _save(frames[scene], README_ROOT / f"{stem}.{locale}.webp")

    for scene, stem in LANDING_SHOTS.items():
        _save(frames[scene], LANDING_ROOT / f"{stem}.{locale}.webp")

    published = sorted(gallery.glob("*.webp"))
    total = sum(path.stat().st_size for path in published)
    print(f"{locale}: {len(published)} gallery frames, {total / 1e6:.2f} MB")
    print(f"{locale}: {len(README_SHOTS)} README frames in {README_ROOT.relative_to(ROOT)}")
    print(f"{locale}: {len(LANDING_SHOTS)} landing frames in {LANDING_ROOT.relative_to(ROOT)}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path, help="capture PNG directory")
    parser.add_argument("--locale", required=True, choices=LOCALES, help="UI language of the pass")
    arguments = parser.parse_args()
    return publish(arguments.source, arguments.locale)


if __name__ == "__main__":
    sys.exit(main())
