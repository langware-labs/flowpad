"""Target languages offered by the *document*-translation feature.

DISTINCT from ``supported_locales.py``: that list is the set of languages the
**app UI** ships Lingui catalogs for (en-US/he/ar today) and is drift-guarded
against ``ui/src/locales/`` + ``lingui.config.ts``. Document translation has no
such constraint — the translator worker can render a doc into any language — so
its target list is a broad, standalone catalog and MUST NOT be conflated with the
UI-locale list (adding rows here does not require a Lingui catalog).

Surfaced to the frontend via ``BootstrapInfo.translation_targets`` and rendered
by the Translations side-panel language picker. Descriptor shape mirrors
``SupportedLocale`` (``code``/``englishName``/``nativeName``/``dir``) so the
existing ``LanguageSelector`` picker renders it unchanged. ``dir`` drives the
translated document's text direction (RTL for he/ar/fa/ur).
"""

from typing import Any, Dict, List

# code, englishName, nativeName, dir. Codes are BCP-47-ish (lowercase ISO-639-1
# where one exists) — the ``?lang=`` dock-prop value and the ``<lang>.md``
# filename stem. Kept alphabetical by englishName for a stable picker order.
TRANSLATION_TARGETS: List[Dict[str, Any]] = [
    {"code": "ar", "englishName": "Arabic", "nativeName": "العربية", "dir": "rtl"},
    {"code": "bn", "englishName": "Bengali", "nativeName": "বাংলা", "dir": "ltr"},
    {"code": "zh-Hans", "englishName": "Chinese (Simplified)", "nativeName": "简体中文", "dir": "ltr"},
    {"code": "zh-Hant", "englishName": "Chinese (Traditional)", "nativeName": "繁體中文", "dir": "ltr"},
    {"code": "cs", "englishName": "Czech", "nativeName": "Čeština", "dir": "ltr"},
    {"code": "nl", "englishName": "Dutch", "nativeName": "Nederlands", "dir": "ltr"},
    {"code": "en", "englishName": "English", "nativeName": "English", "dir": "ltr"},
    {"code": "fi", "englishName": "Finnish", "nativeName": "Suomi", "dir": "ltr"},
    {"code": "fr", "englishName": "French", "nativeName": "Français", "dir": "ltr"},
    {"code": "de", "englishName": "German", "nativeName": "Deutsch", "dir": "ltr"},
    {"code": "el", "englishName": "Greek", "nativeName": "Ελληνικά", "dir": "ltr"},
    {"code": "he", "englishName": "Hebrew", "nativeName": "עברית", "dir": "rtl"},
    {"code": "hi", "englishName": "Hindi", "nativeName": "हिन्दी", "dir": "ltr"},
    {"code": "hu", "englishName": "Hungarian", "nativeName": "Magyar", "dir": "ltr"},
    {"code": "id", "englishName": "Indonesian", "nativeName": "Bahasa Indonesia", "dir": "ltr"},
    {"code": "it", "englishName": "Italian", "nativeName": "Italiano", "dir": "ltr"},
    {"code": "ja", "englishName": "Japanese", "nativeName": "日本語", "dir": "ltr"},
    {"code": "ko", "englishName": "Korean", "nativeName": "한국어", "dir": "ltr"},
    {"code": "fa", "englishName": "Persian", "nativeName": "فارسی", "dir": "rtl"},
    {"code": "pl", "englishName": "Polish", "nativeName": "Polski", "dir": "ltr"},
    {"code": "pt", "englishName": "Portuguese", "nativeName": "Português", "dir": "ltr"},
    {"code": "pt-BR", "englishName": "Portuguese (Brazil)", "nativeName": "Português (Brasil)", "dir": "ltr"},
    {"code": "ro", "englishName": "Romanian", "nativeName": "Română", "dir": "ltr"},
    {"code": "ru", "englishName": "Russian", "nativeName": "Русский", "dir": "ltr"},
    {"code": "es", "englishName": "Spanish", "nativeName": "Español", "dir": "ltr"},
    {"code": "sv", "englishName": "Swedish", "nativeName": "Svenska", "dir": "ltr"},
    {"code": "th", "englishName": "Thai", "nativeName": "ไทย", "dir": "ltr"},
    {"code": "tr", "englishName": "Turkish", "nativeName": "Türkçe", "dir": "ltr"},
    {"code": "uk", "englishName": "Ukrainian", "nativeName": "Українська", "dir": "ltr"},
    {"code": "ur", "englishName": "Urdu", "nativeName": "اردو", "dir": "rtl"},
    {"code": "vi", "englishName": "Vietnamese", "nativeName": "Tiếng Việt", "dir": "ltr"},
]

_BY_CODE: Dict[str, Dict[str, Any]] = {t["code"]: t for t in TRANSLATION_TARGETS}


def get_translation_targets() -> List[Dict[str, Any]]:
    """Return a fresh copy of the target descriptors for the bootstrap payload."""
    return [dict(t) for t in TRANSLATION_TARGETS]


def get_translation_target(code: str) -> Dict[str, Any] | None:
    """Descriptor for one code, or ``None`` if unknown."""
    target = _BY_CODE.get(code)
    return dict(target) if target else None
