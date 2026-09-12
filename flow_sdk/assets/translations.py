"""Document-translation local-data operations — where an asset keeps its
translated bodies.

Layout (under the source asset's dedicated record-data directory)::

    <records_data_root>/<type>/<type>-@<id>/
        translations/<lang>.md      one translated copy of the primary doc per lang

A translation is NOT a separate entity — it is an alternate body file of the
same asset, selected inline by the ``?lang=<code>`` dock prop. Nothing under
``records_data`` is walked by the indexer, so a translation file never becomes
an entity of its own (same guarantee the flow_message staging area relies on,
see ``operations/flow_message.py``). Placeholders are written WITHOUT a
frontmatter ``id:`` so no id is ever adopted from them (entity-id policy).

This module is the single owner of the ``translations/<lang>.md`` path grammar —
the slick equivalent of ``compute_asset_ref`` for the source file.
"""
from __future__ import annotations

import re
from pathlib import Path

TRANSLATIONS_SUBDIR = "translations"

# A language code is BCP-47-ish: letters, digits and hyphens (e.g. ``es``,
# ``he``, ``fr-CA``, ``zh-Hans``). Anything else is rejected so a caller can't
# escape the translations dir via ``../`` or absolute paths in the filename.
_LANG_RE = re.compile(r"^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$")


def normalize_lang(lang: str) -> str:
    """Validate + canonicalize a language code for use as a filename stem.

    Raises ``ValueError`` for anything that isn't a plain BCP-47-ish code — the
    single guard against path traversal in ``translation_path``.
    """
    code = (lang or "").strip()
    if not _LANG_RE.match(code):
        raise ValueError(f"invalid language code: {lang!r}")
    return code


def translation_path(record_data_dir: Path, lang: str) -> Path:
    """One alternate body under an explicitly selected record-data folder."""
    return Path(record_data_dir) / TRANSLATIONS_SUBDIR / f"{normalize_lang(lang)}.md"


def ensure_placeholder(record_data_dir: Path, lang: str) -> Path:
    """Create an empty support file only if absent; never truncate authored bytes."""
    from flow_sdk.assets.directory import AssetDir

    folder = AssetDir(record_data_dir).subdir(TRANSLATIONS_SUBDIR).os_path
    path = folder / f"{normalize_lang(lang)}.md"
    try:
        with path.open("x", encoding="utf-8"):
            pass
    except FileExistsError:
        pass
    return path
