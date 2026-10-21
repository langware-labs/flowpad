"""Filesystem contracts independent of application entities.

A DOCUMENT_FILE is a ``.docx`` or ``.txt`` file inside a docs folder. It is
read-only: the file is never written, so its id is derived from its path (the
read-only-asset exception of the entity id policy). The extractor reads the
text for full-text search; the UI renders the file itself.
"""
from __future__ import annotations

import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from flow_sdk.assets.types.spreadsheet import spreadsheet_asset_hash
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_types import RecordType

# The ONE extension list: the TypeInfo shape, the folder emitter and the
# Documents tree walk all read it.
DOCUMENT_FILE_EXTS: tuple[str, ...] = (".docx", ".txt")

# Search only needs enough text to match on; a long document is cut here.
_MAX_CONTENT_CHARS = 64_000

_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def _docx_text(path: Path) -> str:
    """The paragraphs of a .docx, one per line, via stdlib zip+xml, streamed and
    stopped at the cap. ``""`` on a bad file."""
    lines: list[str] = []
    size = 0
    try:
        with zipfile.ZipFile(path) as zf, zf.open("word/document.xml") as fh:
            for _event, el in ET.iterparse(fh):
                if el.tag != f"{_W}p":
                    continue
                line = "".join(t.text or "" for t in el.iter(f"{_W}t"))
                el.clear()
                if line.strip():
                    lines.append(line)
                    size += len(line) + 1
                    if size >= _MAX_CONTENT_CHARS:
                        break
    except (OSError, KeyError, zipfile.BadZipFile, ET.ParseError):
        return ""
    return "\n".join(lines)[:_MAX_CONTENT_CHARS]


def _txt_text(path: Path) -> str:
    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            return fh.read(_MAX_CONTENT_CHARS)
    except OSError:
        return ""


def extract_document_file(ref: FSRef, resolved_id: str) -> list[FSRecord]:
    """One FSRecord for a .docx/.txt file, with its text as search content.

    Gated on the extension here too: single-path index calls bypass the
    walker, so any file handed to ``resolve_asset`` would otherwise mint.
    """
    path = ref._path
    suffix = path.suffix.lower()
    if suffix not in DOCUMENT_FILE_EXTS:
        return []
    try:
        if not path.is_file():
            return []
    except OSError:
        return []
    text = _docx_text(path) if suffix == ".docx" else _txt_text(path)
    rec = FSRecord(
        type=RecordType.DOCUMENT_FILE,
        id=resolved_id,
        name=path.name,
        status="active",
        content="\n".join(p for p in (path.stem, text) if p),
        # parent_path: the Documents folder view lists a folder by it, as for markdown.
        metadata={"title": path.stem, "format": suffix.lstrip("."), "parent_path": str(path.parent)},
    )
    object.__setattr__(rec, "_asset_ref", FSRef(path))
    return [rec]


document_file_asset_hash = spreadsheet_asset_hash  # one flat file: its mtime
