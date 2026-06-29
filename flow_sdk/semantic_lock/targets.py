"""Target adapters — every DependsOn target reduces to (bytes, sha256).

A target is anything a lock governs: a file on disk, an asset-backed entity
(its record bytes), or a DB-only entity (its canonical JSON). The checker
core sees only this protocol; resolving WHICH adapter applies is the route
layer's job.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Protocol, runtime_checkable

from flow_sdk.llm_index.core import sha256_bytes


@runtime_checkable
class TargetAdapter(Protocol):
    def resolve(self) -> bytes | None:
        """The target's current content bytes, or None when unresolvable."""
        ...

    def current_hash(self) -> str | None:
        """sha256 hex of the current content, or None when unresolvable."""
        ...


class BytesTarget:
    """In-memory target — entity bodies and tests."""

    def __init__(self, data: bytes | None):
        self._data = data

    def resolve(self) -> bytes | None:
        return self._data

    def current_hash(self) -> str | None:
        return sha256_bytes(self._data) if self._data is not None else None


class FileTarget:
    """A file on disk, resolved checkout-root + rel_path first (portable),
    falling back to the last known absolute path."""

    def __init__(self, rel_path: str = "", abs_path: str = "", checkout_root: str = ""):
        self.rel_path = rel_path
        self.abs_path = abs_path
        self.checkout_root = checkout_root

    def _path(self) -> Path | None:
        if self.checkout_root and self.rel_path:
            candidate = Path(self.checkout_root) / self.rel_path
            if candidate.is_file():
                return candidate
        if self.abs_path and Path(self.abs_path).is_file():
            return Path(self.abs_path)
        return None

    def resolve(self) -> bytes | None:
        path = self._path()
        if path is None:
            return None
        try:
            return path.read_bytes()
        except OSError:
            return None

    def current_hash(self) -> str | None:
        data = self.resolve()
        return sha256_bytes(data) if data is not None else None


def canonical_entity_bytes(entity_fields: dict) -> bytes:
    """The hash contract for DB-only entity targets: sorted-keys JSON of the
    persisted API fields. Changing this serialization invalidates every
    stored validated hash — treat it as frozen."""
    return json.dumps(
        entity_fields, sort_keys=True, ensure_ascii=False, separators=(",", ":"), default=str
    ).encode("utf-8")
