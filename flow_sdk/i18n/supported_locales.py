"""Canonical list of locales the app ships translations for.

This is the SINGLE SOURCE OF TRUTH for supported locales. It is surfaced to the
frontend through the ``bootstrap`` payload (``BootstrapInfo.supported_locales``);
the UI no longer hardcodes its own list. Each descriptor matches the shape the UI
expects (``code``/``englishName``/``nativeName``/``dir``/``flag``).

This list MUST NOT drift from reality: there has to be a compiled catalog
(``ui/src/locales/<code>/messages.po``) for every entry, and ``ui/lingui.config.ts``
must list the same codes. That invariant is enforced by
``tests/unit/test_supported_locales.py`` — do not add a row here without shipping
its catalog and updating lingui.config.

``dir`` drives ``<html dir>`` on the frontend (the single writer of text
direction). ``flag`` is a chosen representative ISO-3166-1 alpha-2 region for the
flag-icons SVG (a language is not a country — this is presentational only).
"""

from typing import Any, Dict, List

# code, englishName, nativeName, dir, flag
SUPPORTED_LOCALES: List[Dict[str, Any]] = [
    {"code": "en-US", "englishName": "English", "nativeName": "English", "dir": "ltr", "flag": "us"},
    {"code": "he", "englishName": "Hebrew", "nativeName": "עברית", "dir": "rtl", "flag": "il"},
    {"code": "ar", "englishName": "Arabic", "nativeName": "العربية", "dir": "rtl", "flag": "sa"},
]


def get_supported_locales() -> List[Dict[str, Any]]:
    """Return a fresh copy of the supported-locale descriptors for the bootstrap payload."""
    return [dict(loc) for loc in SUPPORTED_LOCALES]
