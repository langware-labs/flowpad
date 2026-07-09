"""LocalOrigin — the ``kind="local"`` member of ``FSOrigin``.

A local origin points at a directory that is ALREADY present on the receiving
machine — a mounted network share, a synced folder, or any local base path. It
is the simplest non-git backend and exists to prove the FSOrigin seam is not
accidentally git-shaped: its ``materialize`` performs NO fetch (no clone, no
download) — it resolves ``base/rel_path`` and returns it. (Distinct from a git
repo cloned over ``file://``, which is ``kind="git"`` with ``provider="file"``.)
"""
from __future__ import annotations

import uuid
from typing import Literal

from flow_sdk.builtin.fs_origin import FSOrigin
from flow_sdk.fs_store.identifier import mint_uuid


class LocalOrigin(FSOrigin):
    kind: Literal["local"] = "local"
    # Absolute base directory on the receiver (a mount point / synced-folder
    # root). ``rel_path`` (inherited) descends into it.
    base: str = ""
    # key() is inherited from FSOrigin (delegates to the local driver); only
    # git overrides it, for byte-stability.


def local_origin_key(base: str, rel_path: str) -> str:
    """Deterministic v5 dedup handle for a local origin: uuid5 over base:rel_path."""
    b = (base or "").strip().replace("\\", "/").rstrip("/")
    r = (rel_path or "").strip().replace("\\", "/").strip("/")
    return mint_uuid(key=f"local:{b}:{r}", namespace=uuid.NAMESPACE_URL)
