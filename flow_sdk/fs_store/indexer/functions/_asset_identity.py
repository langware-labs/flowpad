"""Identity carrier factories — the vocabulary a type declares ``identity_carrier=`` in.

Validation and minting belong to ``TypeInfo.mint``; owner reconciliation to
the indexer (``flow_sdk.fs_store.indexer.reconcile``).
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from flow_sdk.fs_store.identity_carrier import Derived, Frontmatter, JsonRoot, Sidecar

__all__ = [
    "NATIVE_JSON_IDENTITY",
    "derived_identity",
    "folder_json_identity",
    "frontmatter_identity",
    "native_json_identity",
    "resolved_path_key",
]


def resolved_path_key(ref: Any) -> str:
    return str(Path(getattr(ref, "_path", ref)).resolve())


NATIVE_JSON_IDENTITY = JsonRoot()


def frontmatter_identity() -> Frontmatter:
    """The carrier for a type whose main document is markdown: ``id:`` in its
    frontmatter — a file type, or a folder type whose main document is
    markdown (``SKILL.md``, ``task.md``)."""
    return Frontmatter()


def folder_json_identity() -> Sidecar:
    return Sidecar()


def native_json_identity() -> JsonRoot:
    return NATIVE_JSON_IDENTITY


def derived_identity(reader: Any = None) -> Derived:
    return Derived(reader=reader)
