"""FSOrigin driver registry — the behavior side of the origin abstraction.

An ``FSOriginDriver`` knows how to act on an ``FSOrigin`` of a given ``kind``:
materialize its bytes to a local path, decide whether a local dir IS that
origin, reverse-detect an origin from a local path, and compute its dedup
``key``. Drivers hold clients and (at materialize time) resolve credentials
from the RECEIVER's own store — credentials never ride the wire value object.

One ``KindRegistry`` (``flow_sdk/utils/kind_registry.py``); git-hosting
providers (github/gitlab/bitbucket) fold onto the single ``git`` backend.
Concrete drivers are lazy-imported on first use so a backend's heavy deps
(git subprocess helpers now; boto3/Drive later) don't load unless that kind
is actually used.
"""
from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Optional, Protocol, runtime_checkable

from flow_sdk.fs_store.origin.fs_origin import ORIGIN_KIND_ALIASES
from flow_sdk.utils.kind_registry import KindRegistry

if TYPE_CHECKING:
    from flow_sdk.fs_store.origin.fs_origin import FSOrigin


#: Git-hosting provider names fold onto the storage-backend kind. ``origin.kind``
#: is already "git" for git origins; this is defensive for callers that pass a
#: hosting-provider value where a kind is expected. Shared with the serializer
#: registry, which is keyed by the same origin kinds.


@runtime_checkable
class FSOriginDriver(Protocol):
    """Behavior for one origin ``kind``. Holds no wire state."""

    kind: str

    def key(self, origin: "FSOrigin") -> str:
        """Deterministic, location-independent dedup handle."""
        ...

    async def materialize(
        self,
        origin: "FSOrigin",
        *,
        preferred_root: Optional[Path] = None,
        preferred_project_id: Optional[str] = None,
        token: Optional[str] = None,
    ) -> tuple[Path, Optional[str]]:
        """Fetch/reuse the origin's bytes to a local path. ``token`` is the
        caller's credential for a remote fetch; a driver with no remote ignores it.

        Returns ``(local_root, project_id)`` — the local directory the origin's
        ``rel_path`` is joined onto, and the local project it maps to (or None).
        """
        ...

    def matches(self, origin: "FSOrigin", local_path: Path) -> bool:
        """Whether ``local_path`` is a materialization of ``origin``. Optional
        capability — a driver with no notion of it returns False."""
        ...

    async def detect(self, asset_root: Path) -> "Optional[FSOrigin]":
        """Reverse lookup: which origin (if any) does ``asset_root`` come from?
        Optional — returns None when the backend can't auto-discover it."""
        ...


def _build_default_registry(registry: "KindRegistry[FSOriginDriver]") -> None:
    # Lazy-import concrete drivers so their deps load only with this module.
    from flow_sdk.builtin.drivers.git_driver import GitOriginDriver
    from flow_sdk.builtin.drivers.local_driver import LocalOriginDriver

    registry.register(GitOriginDriver())
    registry.register(LocalOriginDriver())


ORIGIN_DRIVERS: "KindRegistry[FSOriginDriver]" = KindRegistry(
    "FSOrigin", aliases=ORIGIN_KIND_ALIASES, builder=_build_default_registry
)




def get_origin_driver(kind: str) -> FSOriginDriver:
    """Resolve the driver for an origin ``kind`` (alias-normalized)."""
    return ORIGIN_DRIVERS.get(kind)
