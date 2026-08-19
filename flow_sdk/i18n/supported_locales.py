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


#: Locales that need no directive — the CLIs already default to English.
_NEUTRAL_LOCALES = frozenset({"en-US"})

#: Verbatim the ``# Language`` section Claude Code builds from its own ``language``
#: setting (lifted from the 2.1.234 binary). Kept here so Codex — which ships no
#: language setting of its own — receives the identical instruction through its
#: ``developer_instructions`` config override, and both vendors say the same thing.
_LANGUAGE_PROMPT = """# Language
Always respond in {name}. Use {name} for all explanations, comments, and
communications with the user. Technical terms and code identifiers should remain
in their original form.
Maintain full orthographic correctness for {name}, including all required
diacritical marks, accents, and special characters. Never substitute accented
characters with their ASCII equivalents."""


def language_name(code: str | None) -> str | None:
    """English name of the language a worker must reply in, or ``None`` for none.

    ``None`` means *say nothing* — unset locale, English, or a code we do not
    ship — which leaves the worker's default behaviour (infer the language from
    the conversation) untouched. That default is the thing that drifts; naming
    the language outright is the whole point of the caller.
    """
    if not code or code in _NEUTRAL_LOCALES:
        return None
    for loc in SUPPORTED_LOCALES:
        if loc["code"] == code:
            return str(loc["englishName"])
    return None


def language_prompt_block(name: str) -> str:
    """The ``# Language`` system-prompt section naming ``name``."""
    return _LANGUAGE_PROMPT.format(name=name)
