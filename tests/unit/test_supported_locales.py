"""Anti-drift guard for the backend supported-locale list.

The backend `SUPPORTED_LOCALES` (flow_sdk/i18n/supported_locales.py) is the single
source of truth surfaced to the UI via bootstrap. It MUST NOT claim a locale we
don't actually ship. This test pins it to reality:

  backend codes  ==  on-disk catalogs (ui/src/locales/<code>/messages.po)
                 ==  ui/lingui.config.ts `locales: [...]`

If any of the three drift, this fails — so you can't add a row to the array
without shipping its catalog and updating lingui.config (or vice versa).

Skips cleanly when the `ui/` source tree is absent (e.g. a packaged install that
only ships compiled assets), since there's nothing to compare against there.
"""

import re
from pathlib import Path

import pytest

from flow_sdk.i18n.supported_locales import SUPPORTED_LOCALES, language_name, language_prompt_block

_REPO_ROOT = Path(__file__).resolve().parents[2]
_LOCALES_DIR = _REPO_ROOT / "ui" / "src" / "locales"
_LINGUI_CONFIG = _REPO_ROOT / "ui" / "lingui.config.ts"

_DESCRIPTOR_KEYS = {"code", "englishName", "nativeName", "dir", "flag"}


def _backend_codes() -> set[str]:
    return {loc["code"] for loc in SUPPORTED_LOCALES}


def _catalog_codes() -> set[str]:
    return {p.parent.name for p in _LOCALES_DIR.glob("*/messages.po")}


def _lingui_codes() -> set[str]:
    text = _LINGUI_CONFIG.read_text(encoding="utf-8")
    match = re.search(r"locales\s*:\s*\[([^\]]*)\]", text)
    assert match, "could not find `locales: [...]` in lingui.config.ts"
    return set(re.findall(r"['\"]([^'\"]+)['\"]", match.group(1)))


def test_backend_descriptors_well_formed():
    """Every descriptor has exactly the expected keys and a sane direction."""
    assert SUPPORTED_LOCALES, "SUPPORTED_LOCALES must not be empty"
    codes = [loc["code"] for loc in SUPPORTED_LOCALES]
    assert len(codes) == len(set(codes)), f"duplicate locale codes: {codes}"
    assert "en-US" in codes, "en-US (the source locale) must be supported"
    for loc in SUPPORTED_LOCALES:
        assert set(loc) == _DESCRIPTOR_KEYS, f"unexpected keys in {loc}"
        assert loc["dir"] in ("ltr", "rtl"), f"bad dir in {loc}"


@pytest.mark.skipif(not _LOCALES_DIR.is_dir(), reason="ui/ source tree not present (packaged install)")
def test_backend_matches_on_disk_catalogs():
    """Backend codes == the messages.po catalogs that actually exist on disk."""
    assert _backend_codes() == _catalog_codes(), (
        "supported-locale drift: backend SUPPORTED_LOCALES vs on-disk catalogs differ.\n"
        f"  backend:  {sorted(_backend_codes())}\n"
        f"  catalogs: {sorted(_catalog_codes())}"
    )


@pytest.mark.skipif(not _LINGUI_CONFIG.is_file(), reason="ui/ source tree not present (packaged install)")
def test_backend_matches_lingui_config():
    """Backend codes == the `locales` array lingui compiles."""
    assert _backend_codes() == _lingui_codes(), (
        "supported-locale drift: backend SUPPORTED_LOCALES vs ui/lingui.config.ts differ.\n"
        f"  backend: {sorted(_backend_codes())}\n"
        f"  lingui:  {sorted(_lingui_codes())}"
    )


def test_language_name_resolves_only_non_english_locales():
    """``None`` is the signal for "add no directive" — it must cover every case
    where naming a language would be wrong or meaningless."""
    assert language_name("he") == "Hebrew"
    assert language_name("ar") == "Arabic"
    assert language_name("en-US") is None  # already the CLI default
    assert language_name(None) is None  # locale never set on the project
    assert language_name("") is None
    assert language_name("zz") is None  # a code we do not ship


def test_language_prompt_block_names_the_language_everywhere():
    block = language_prompt_block("Hebrew")

    assert block.startswith("# Language\n")
    assert block.count("Hebrew") == 3
    assert "{name}" not in block
