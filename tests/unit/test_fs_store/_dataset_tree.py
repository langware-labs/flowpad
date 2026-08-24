"""Readers for a dataset example's ``Datum`` tree.

Shared by ``test_indexer_dataset.py`` (the walker) and
``test_dataset_from_fs_ref.py`` (the cold-path loader), which must agree
byte-for-byte — so they must read the tree the same way too.

The tree mirrors the example directory: a file is a leaf whose value is its
relative path, a folder is a branch of its members, and a ``«slot»[-N].json``
sidecar is a sibling leaf keyed by its full filename.

``_keys`` deliberately delegates to the production ``_keys_for`` rather than
restating the data-vs-sidecar key rule. Re-implementing it here is how the tests
would keep asserting an old rule after the parser changed.
"""
from __future__ import annotations

from typing import Any, Optional

from flow_sdk.fs_store.indexer.functions.dataset import _keys_for
from flow_sdk.schema.datum import Datum


def keys(ex: Any, base: str) -> list[str]:
    """Data occurrence keys for one slot base, in canonical order."""
    return _keys_for(ex.datum, base)


def node(ex: Any, base: str) -> Optional[Datum]:
    """The bare/first occurrence node for a slot base, or ``None``."""
    found = keys(ex, base)
    return ex.datum.fields[found[0]] if found else None


def paths(target: Optional[Datum]) -> list[str]:
    """Every leaf path under a node — a file yields itself, a folder its members."""
    return [] if target is None else [n.value for _, n in target.leaves()]


def sidecar(ex: Any, name: str) -> dict:
    """The two-section dict of a ``«slot»[-N].json`` sidecar, or ``{}``."""
    found = (ex.datum.fields or {}).get(name)
    return found.value if found is not None else {}
