"""The languages the OS user reads or types, as BCP-47-ish tags.

Two kinds of signal, both counted, because both mean "this person uses this
language":

* **Display languages** — the OS preferred-language list (Windows' user language
  list, macOS ``AppleLanguages``, POSIX ``LANGUAGE``/``LANG``).
* **Keyboard layouts** — a Hebrew keyboard on an English Windows is a Hebrew
  reader. The browser cannot see layouts (``navigator.languages`` is the display
  list only), which is why this lives in the backend: it runs on the user's own
  machine and can read them.

The UI unions this with ``navigator.languages`` and offers the footer's quick
language switch only when that union shares 2+ languages with the app's
supported locales (``ui/src/contexts/locale-context.tsx``).

Every source is best-effort: a missing key, an unreadable plist or an absent
``gsettings`` drops that source, never the bootstrap. The result is cached for
the process — layouts change rarely and a restart picks up a new one.
"""

from __future__ import annotations

import ast
import functools
import locale
import logging
import os
import plistlib
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Iterable, List

from flow_sdk.i18n.supported_locales import SUPPORTED_LOCALES

logger = logging.getLogger(__name__)

#: xkb layout codes are mostly COUNTRY codes, so they need a hint to name a
#: language. Only layouts whose language differs from the code are listed.
_XKB_LANGUAGE = {"il": "he", "ara": "ar", "us": "en", "gb": "en"}


def _normalize(tag: str) -> str | None:
    """``he_IL.UTF-8`` / ``he-IL`` / ``he`` → ``he-IL`` / ``he``; junk → None."""
    tag = tag.split(".")[0].split("@")[0].replace("_", "-").strip()
    if not tag or tag in ("C", "POSIX") or not re.match(r"^[A-Za-z]{2,3}(-[A-Za-z0-9]+)*$", tag):
        return None
    head, *rest = tag.split("-")
    return "-".join([head.lower(), *rest])


def _windows_languages() -> List[str]:
    import winreg  # Windows-only stdlib module

    out: List[str] = []
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Control Panel\International\User Profile") as key:
            languages, _ = winreg.QueryValueEx(key, "Languages")
            out.extend(languages)
    except OSError:
        pass
    # Preload holds every enabled keyboard as a KLID; its low word is the LCID
    # of the layout's language (0000040d → 0x040d → he_IL).
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Keyboard Layout\Preload") as key:
            for i in range(winreg.QueryInfoKey(key)[1]):
                _, klid, _ = winreg.EnumValue(key, i)
                name = locale.windows_locale.get(int(str(klid), 16) & 0xFFFF)
                if name:
                    out.append(name)
    except (OSError, ValueError):
        pass
    return out


def _layout_name_language(name: str) -> str | None:
    """macOS layout names lead with the language: ``Hebrew-QWERTY``, ``Arabic - PC``."""
    first = re.split(r"[^A-Za-z]+", name.strip(), maxsplit=1)[0].lower()
    for loc in SUPPORTED_LOCALES:
        if loc["englishName"].lower() == first:
            return str(loc["code"])
    return None


def _macos_languages() -> List[str]:
    prefs = Path.home() / "Library" / "Preferences"
    out: List[str] = []
    try:
        with open(prefs / ".GlobalPreferences.plist", "rb") as f:
            out.extend(plistlib.load(f).get("AppleLanguages", []))
    except (OSError, plistlib.InvalidFileException):
        pass
    try:
        with open(prefs / "com.apple.HIToolbox.plist", "rb") as f:
            sources = plistlib.load(f).get("AppleEnabledInputSources", [])
        for src in sources:
            lang = _layout_name_language(str(src.get("KeyboardLayout Name", "")))
            if lang:
                out.append(lang)
    except (OSError, plistlib.InvalidFileException):
        pass
    return out


def _linux_languages() -> List[str]:
    out: List[str] = []
    out.extend(os.environ.get("LANGUAGE", "").split(":"))
    for var in ("LC_ALL", "LC_MESSAGES", "LANG"):
        out.append(os.environ.get(var, ""))
    layouts: List[str] = []
    if shutil.which("gsettings"):
        try:
            raw = subprocess.run(
                ["gsettings", "get", "org.gnome.desktop.input-sources", "sources"],
                capture_output=True,
                text=True,
                timeout=2,
            ).stdout.strip()
            # "[('xkb', 'us'), ('xkb', 'il')]"; an empty list prints "@a(ss) []".
            parsed = ast.literal_eval(raw.removeprefix("@a(ss) ")) if raw else []
            layouts.extend(code for kind, code in parsed if kind == "xkb")
        except (OSError, subprocess.SubprocessError, ValueError, SyntaxError):
            pass
    if not layouts and shutil.which("setxkbmap"):
        try:
            query = subprocess.run(["setxkbmap", "-query"], capture_output=True, text=True, timeout=2).stdout
            match = re.search(r"^layout:\s*(\S+)", query, re.MULTILINE)
            if match:
                layouts.extend(match.group(1).split(","))
        except (OSError, subprocess.SubprocessError):
            pass
    for layout in layouts:
        base = layout.split("+")[0].split("(")[0]
        out.append(_XKB_LANGUAGE.get(base, base))
    return out


def _dedupe(tags: Iterable[str]) -> List[str]:
    seen: set[str] = set()
    result: List[str] = []
    for raw in tags:
        tag = _normalize(str(raw))
        if tag and tag not in seen:
            seen.add(tag)
            result.append(tag)
    return result


@functools.lru_cache(maxsize=1)
def _probe() -> tuple[str, ...]:
    try:
        if sys.platform == "win32":
            raw = _windows_languages()
        elif sys.platform == "darwin":
            raw = _macos_languages()
        else:
            raw = _linux_languages()
    except Exception:  # noqa: BLE001 — a language hint is never worth failing bootstrap over
        logger.debug("os language probe failed", exc_info=True)
        raw = []
    return tuple(_dedupe(raw))


def get_os_languages() -> List[str]:
    """The OS user's display + keyboard languages, display languages first."""
    return list(_probe())
