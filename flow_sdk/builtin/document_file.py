"""``DocumentFile`` — a read-only ``.docx`` / ``.txt`` file inside a docs folder.

Listed with the markdown Documents and opened in a read-only preview. The
file is never written; the extractor lives in
``flow_sdk/assets/types/document_file.py``, the type registration in
``flow_sdk/schema/type_info/document_file_type_info.py``.
"""
from __future__ import annotations

from flow_sdk.api.api_types.api_field import APIField, Persist, Sharing
from flow_sdk.core import Entity


class DocumentFile(Entity):
    type: str = APIField(default="document_file")
    title: str = APIField("")
    # "docx" | "txt" — the on-disk format; picks the preview renderer.
    format: str = APIField("")
    asset_ref: str = APIField(default="", sharing=Sharing.PRIVATE)
    # The containing directory, so the Documents folder view lists this file.
    parent_path: str = APIField(default="", persist=Persist.TRUE, sharing=Sharing.PRIVATE)
