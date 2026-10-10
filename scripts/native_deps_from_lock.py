#!/usr/bin/env python3
"""Write electron/native-deps.json: the dependencies in uv.lock that ship platform-specific (native) wheels.

The desktop app freezes the engine's dependencies in time at install (`uv tool install --exclude-newer`,
electron/uv-manager.js). Only packages with native code can be refused by Windows application control, and
only they need the reputation margin (a wheel released days ago has no Smart App Control reputation yet);
pure-Python packages get the engine's release date as their cut-off. Run after every `uv lock`:

    python scripts/native_deps_from_lock.py

tests/unit/test_native_deps_manifest.py fails when the manifest is out of date.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / "uv.lock"
OUT = ROOT / "electron" / "native-deps.json"
PLATFORM_TAG = re.compile(r"-(win_amd64|win32|win_arm64|manylinux|musllinux|macosx)")


def native_packages(lock_text: str) -> list[str]:
    names: set[str] = set()
    for block in re.split(r"\n\[\[package\]\]\n", lock_text):
        name = re.search(r'^name = "([^"]+)"', block, re.M)
        if not name:
            continue
        wheels = re.findall(r'url = "([^"]+\.whl)"', block)
        if any(PLATFORM_TAG.search(w) for w in wheels):
            names.add(name.group(1))
    return sorted(names)


def render(lock_text: str) -> str:
    return json.dumps({"generatedFrom": "uv.lock", "packages": native_packages(lock_text)}, indent=2) + "\n"


if __name__ == "__main__":
    text = render(LOCK.read_text(encoding="utf-8"))
    if "--check" in sys.argv:
        current = OUT.read_text(encoding="utf-8") if OUT.exists() else ""
        sys.exit(0 if current == text else 1)
    OUT.write_text(text, encoding="utf-8")
    sys.stdout.write(f"{OUT}: {len(json.loads(text)['packages'])} native packages\n")
