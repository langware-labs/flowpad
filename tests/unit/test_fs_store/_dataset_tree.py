"""Readers for a dataset example's typed row.

Shared by ``test_indexer_dataset.py`` (the walker) and
``test_dataset_from_fs_ref.py`` (the cold-path loader), which must agree
byte-for-byte — so they must read the row the same way too.

A slot is a ``FileRef`` (a file: its relative path), a ``FolderSpec`` (a
folder: its members), a ``TextSpec`` (a CSV cell), or a ``list`` of those
(numbered occurrences). An occurrence's KEY comes from the production
``occurrence_key`` — the same rule the reader applies — not restated here.
"""
from __future__ import annotations

from typing import Any, Optional, Union

from flow_sdk.schema.data_spec.dataset_spec import FileRef, FolderSpec, TextSpec
from flow_sdk.schema.data_spec.layout import occurrence_key

Node = Union[str, dict]


def _occ(ex: Any, base: str) -> list:
    v = getattr(ex, base, None)
    return [] if v is None else (v if isinstance(v, list) else [v])


def _plain(o: Any) -> Node:
    if isinstance(o, FileRef):
        return o.path
    if isinstance(o, FolderSpec):
        return {name: _plain(m) for name, m in o.files.items()}
    if isinstance(o, TextSpec):
        return o.text
    raise TypeError(type(o).__name__)


def keys(ex: Any, base: str) -> list[str]:
    """Data occurrence keys for one slot base, in canonical order."""
    return [occurrence_key(o, base) for o in _occ(ex, base)]


def node(ex: Any, base: str) -> Optional[Node]:
    """The bare/first occurrence for a slot base as plain JSON, or ``None``."""
    occ = _occ(ex, base)
    return _plain(occ[0]) if occ else None


def is_file(target: Optional[Node]) -> bool:
    """A file is a ``str`` path; a folder is a ``dict``."""
    return isinstance(target, str)


def paths(target: Optional[Node]) -> list[str]:
    """Every file path under a node — a file yields itself, a folder its members, depth-first."""
    if target is None:
        return []
    if isinstance(target, str):
        return [target]
    return [p for child in target.values() for p in paths(child)]


def sidecar(ex: Any, name: str) -> dict:
    """The two-section dict of a ``«slot»[-N].json`` sidecar, or ``{}``."""
    return ex.metadata.get(name) or {}
