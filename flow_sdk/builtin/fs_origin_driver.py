"""FSOrigin driver registry — the behavior side of the origin abstraction.

An ``FSOriginDriver`` knows how to act on an ``FSOrigin`` of a given ``kind``:
materialize its bytes to a local path, decide whether a local dir IS that
origin, reverse-detect an origin from a local path, and compute its dedup
``key``. Drivers hold clients and (at materialize time) resolve credentials
from the RECEIVER's own store — credentials never ride the wire value object.

Mirrors ``core/capabilities/registry.py`` (register-by-kind + ``get(kind)`` +
module singleton) and lifts the alias-normalization idiom from the worker
``get_driver`` so git-hosting providers (github/gitlab/bitbucket) fold onto the
single ``git`` backend. Concrete drivers are lazy-imported on first use so a
backend's heavy deps (git subprocess helpers now; boto3/Drive later) don't load
unless that kind is actually used.
"""
from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional, Protocol, runtime_checkable

if TYPE_CHECKING:
    from flow_sdk.builtin.fs_origin import FSOrigin


# Fold git-hosting provider names onto the storage-backend kind. ``origin.kind``
# is already "git" for git origins; this is defensive for callers that pass a
# hosting-provider value where a kind is expected.
_KIND_ALIASES = {
    "github": "git",
    "gitlab": "git",
    "bitbucket": "git",
}


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
    ) -> tuple[Path, Optional[str]]:
        """Fetch/reuse the origin's bytes to a local path.

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


class FSOriginDriverRegistry:
    def __init__(self) -> None:
        self._drivers: dict[str, FSOriginDriver] = {}

    def register(self, driver: FSOriginDriver) -> None:
        self._drivers[driver.kind] = driver

    def kinds(self) -> list[str]:
        return list(self._drivers.keys())

    def get(self, kind: str) -> FSOriginDriver:
        name = normalize_origin_kind(kind)
        try:
            return self._drivers[name]
        except KeyError as exc:
            raise KeyError(f"Unknown FSOrigin kind: {kind!r}") from exc


def normalize_origin_kind(kind: Any) -> str:
    """Lower/strip a kind and fold git-hosting-provider aliases onto ``git``."""
    key = str(kind or "").strip().lower()
    return _KIND_ALIASES.get(key, key)


def _build_default_registry() -> FSOriginDriverRegistry:
    registry = FSOriginDriverRegistry()
    # Lazy-import concrete drivers so their deps load only with this module.
    from flow_sdk.builtin.drivers.git_driver import GitOriginDriver
    from flow_sdk.builtin.drivers.local_driver import LocalOriginDriver

    registry.register(GitOriginDriver())
    registry.register(LocalOriginDriver())
    return registry


_DEFAULT_REGISTRY: Optional[FSOriginDriverRegistry] = None


def get_origin_registry() -> FSOriginDriverRegistry:
    global _DEFAULT_REGISTRY
    if _DEFAULT_REGISTRY is None:
        _DEFAULT_REGISTRY = _build_default_registry()
    return _DEFAULT_REGISTRY


def get_origin_driver(kind: str) -> FSOriginDriver:
    """Resolve the driver for an origin ``kind`` (alias-normalized)."""
    return get_origin_registry().get(kind)
