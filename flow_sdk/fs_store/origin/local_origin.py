"""LocalOrigin — the ``kind="local"`` member of ``FSOrigin``.

A local origin points at a directory that is ALREADY present on the machine — a
mounted network share, a synced folder, or any local base path. It is the
simplest non-git backend and exists to prove the FSOrigin seam is not
accidentally git-shaped: its ``materialize`` performs NO fetch (no clone, no
download). It is NOT transportable (its ``base`` is a path on one machine), so a
folder/asset carrying it is never shareable. (Distinct from a git repo cloned
over ``file://``, which is ``kind="git"`` with ``provider="file"``.)
"""
from __future__ import annotations

from pathlib import Path
from typing import Literal

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.fs_store.origin.fs_origin import ORIGIN_MODELS, FSOrigin
from flow_sdk.fs_store.path_utils import canonical_posix_path


class LocalOrigin(FSOrigin):
    kind: Literal["local"] = "local"
    # Absolute base directory (a mount point / synced-folder root). ``rel_path``
    # (inherited) descends into it.
    base: str = ""
    # key() is inherited from FSOrigin (delegates to the local driver); only
    # git overrides it, for byte-stability.

    @property
    def transportable(self) -> bool:
        return False


def local_origin_key(base: str, rel_path: str) -> str:
    """Deterministic dedup handle for a local origin = its canonical local path.

    Byte-stable to ``Folder.id_for_path`` (``mint_uuid(canonical_posix_path)``):
    a local folder's identity IS its canonical path, so ``LocalOrigin.key()``
    equals the legacy path-derived id — this is what lets ``Folder.id_for_origin``
    be a uniform ``origin.key()`` with no kind-branch and zero migration.
    """
    b = (base or "").strip()
    r = (rel_path or "").strip().replace("\\", "/").strip("/")
    full = f"{b.rstrip('/')}/{r}" if r else b
    return mint_uuid(canonical_posix_path(full))


def local_origin_for_path(path: "str | Path") -> LocalOrigin:
    """The ``LocalOrigin`` of an absolute asset path: ``base`` = parent, ``rel_path``
    = leaf. The split is arbitrary for a local origin (``key()`` canonicalizes
    the join), so this is THE one way to build one from a path — the bundle,
    the process asset mount and the serializer all agree byte-for-byte."""
    p = Path(path)
    return LocalOrigin(base=str(p.parent), rel_path=p.name or ".")


ORIGIN_MODELS.register(LocalOrigin, "local")
