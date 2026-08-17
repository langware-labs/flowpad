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

from flow_sdk.fs_store.fs_ref.base import FSRef

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


def translations_dir(record_type: str, record_id: str) -> Path:
    """The ``translations/`` folder under an asset's record-data directory.

    ``record_type`` is the source entity's type (``markdown``/``plan``/…) and
    ``record_id`` its uuid. Pure path composition — does NOT touch the
    filesystem; only the write path (``ensure_placeholder``) creates the dir.
    """
    if not record_type:
        raise ValueError("record_type is required")
    if not record_id:
        raise ValueError("record_id is required")
    from flow_sdk.fs_store.record_paths import data_dir_for
    return data_dir_for(record_type, record_id) / TRANSLATIONS_SUBDIR


def translation_path(record_type: str, record_id: str, lang: str) -> Path:
    """Absolute path of one translation file: ``translations/<lang>.md``."""
    code = normalize_lang(lang)
    return translations_dir(record_type, record_id) / f"{code}.md"


def translation_ref(record_type: str, record_id: str, lang: str) -> FSRef:
    """FSRef to a translation file — the shape stored on ``Translation.ref`` so
    the frontend reads the ref directly instead of recomputing the path."""
    return FSRef(translation_path(record_type, record_id, lang))


def ensure_placeholder(record_type: str, record_id: str, lang: str) -> FSRef:
    """Create an empty ``translations/<lang>.md`` if it doesn't exist yet and
    return its FSRef.

    The placeholder lets the UI open the (pending) translation immediately; the
    translator worker overwrites it with real content. It carries NO frontmatter
    ``id:`` — the file is a data blob, never an entity.
    """
    path = translation_path(record_type, record_id, lang)
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("")
    return FSRef(path)
