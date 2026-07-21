"""Storage backends for :class:`TypeInfo` identity policy.

Backends only observe and persist identity candidates.  UUID validation,
stable-key selection, and minting remain owned by ``TypeInfo``.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Protocol, runtime_checkable

from flow_sdk.capsules import (
    AssetCapsule,
    CapsuleData,
    CapsuleError,
    DuplicateCapsuleError,
    MalformedCapsuleError,
    UnsupportedCapsuleVersionError,
)
from flow_sdk.fs_store.identifier import is_valid_entity_id
from flow_sdk.fs_store.indexer._frontmatter import _atomic_write_text

IdentityReader = Callable[[Any], object | None]


class IdentityState(str, Enum):
    ABSENT = "absent"
    VALID = "valid"
    INVALID_ID = "invalid_id"
    MALFORMED = "malformed"


@dataclass(frozen=True, slots=True)
class IdentityObservation:
    state: IdentityState
    candidate: object | None = None
    source: str | None = None
    detail: str | None = None
    error: Exception | None = None


@runtime_checkable
class IdentityBackend(Protocol):
    def observe(self, path: Path) -> IdentityObservation: ...

    def store_if_absent(self, path: Path, entity_id: str) -> IdentityObservation: ...


def _candidate_observation(candidate: object | None, source: str) -> IdentityObservation:
    if candidate is None:
        return IdentityObservation(IdentityState.ABSENT, source=source)
    if is_valid_entity_id(candidate):
        return IdentityObservation(IdentityState.VALID, candidate=str(candidate), source=source)
    return IdentityObservation(IdentityState.INVALID_ID, candidate=candidate, source=source)


@dataclass(frozen=True, slots=True)
class CapsuleIdentityBackend:
    """Canonical named capsule plus ordered, read-only legacy readers."""

    legacy_readers: tuple[IdentityReader, ...] = ()
    capsule_name: str = "identity"
    capsule_version: int = 1

    def _legacy(self, path: Path) -> IdentityObservation:
        first_invalid: IdentityObservation | None = None
        for index, reader in enumerate(self.legacy_readers):
            source = f"legacy:{getattr(reader, '__name__', index)}"
            try:
                observed = _candidate_observation(reader(path), source)
            except Exception as exc:  # a broken legacy carrier is not absence
                return IdentityObservation(
                    IdentityState.MALFORMED,
                    source=source,
                    detail=str(exc),
                    error=exc,
                )
            if observed.state is IdentityState.VALID:
                return observed
            if observed.state is IdentityState.INVALID_ID and first_invalid is None:
                first_invalid = observed
        return first_invalid or IdentityObservation(IdentityState.ABSENT)

    def observe(self, path: Path) -> IdentityObservation:
        try:
            data = AssetCapsule.from_path(path).read(self.capsule_name)
        except (MalformedCapsuleError, DuplicateCapsuleError, UnsupportedCapsuleVersionError) as exc:
            return IdentityObservation(
                IdentityState.MALFORMED,
                source=f"capsule:{self.capsule_name}",
                detail=str(exc),
                error=exc,
            )
        except (CapsuleError, OSError) as exc:
            return IdentityObservation(
                IdentityState.MALFORMED,
                source=f"capsule:{self.capsule_name}",
                detail=str(exc),
                error=exc,
            )

        if data is None:
            return self._legacy(path)
        if data.version != self.capsule_version:
            exc = UnsupportedCapsuleVersionError(
                f"capsule {self.capsule_name!r} has version {data.version}; "
                f"expected {self.capsule_version}"
            )
            return IdentityObservation(
                IdentityState.MALFORMED,
                source=f"capsule:{self.capsule_name}",
                detail=str(exc),
                error=exc,
            )

        if set(data.data) != {"id"}:
            exc = MalformedCapsuleError(
                f"capsule {self.capsule_name!r} data must contain exactly the 'id' key"
            )
            return IdentityObservation(
                IdentityState.MALFORMED,
                source=f"capsule:{self.capsule_name}",
                detail=str(exc),
                error=exc,
            )
        candidate = data.data.get("id")
        canonical = _candidate_observation(candidate, f"capsule:{self.capsule_name}")
        if canonical.state is IdentityState.VALID:
            return canonical
        legacy = self._legacy(path)
        if legacy.state is IdentityState.VALID:
            return legacy
        return canonical

    def store_if_absent(self, path: Path, entity_id: str) -> IdentityObservation:
        try:
            committed = AssetCapsule.from_path(path).write_if_absent(
                self.capsule_name,
                CapsuleData(version=self.capsule_version, data={"id": entity_id}),
            )
        except (CapsuleError, OSError) as exc:
            return IdentityObservation(
                IdentityState.MALFORMED,
                source=f"write:capsule:{self.capsule_name}",
                detail=str(exc),
                error=exc,
            )
        candidate = committed.data.get("id") if set(committed.data) == {"id"} else None
        return _candidate_observation(candidate, f"capsule:{self.capsule_name}")


@dataclass(frozen=True, slots=True)
class NativeJsonIdentityBackend:
    """Preserve report/trace root-JSON identity storage."""

    def observe(self, path: Path) -> IdentityObservation:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            return IdentityObservation(IdentityState.MALFORMED, source="native-json", detail=str(exc), error=exc)
        if not isinstance(data, dict):
            return IdentityObservation(IdentityState.MALFORMED, source="native-json", detail="root must be an object")
        return _candidate_observation(data.get("id"), "native-json")

    def store_if_absent(self, path: Path, entity_id: str) -> IdentityObservation:
        current = self.observe(path)
        if current.state is not IdentityState.ABSENT:
            return current
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                return IdentityObservation(IdentityState.MALFORMED, source="native-json", detail="root must be an object")
            data["id"] = entity_id
            _atomic_write_text(path, json.dumps(data, indent=2) + "\n")
        except (OSError, ValueError) as exc:
            return IdentityObservation(IdentityState.MALFORMED, source="native-json", detail=str(exc), error=exc)
        return self.observe(path)


@dataclass(frozen=True, slots=True)
class DerivedIdentityBackend:
    """Read-only provider/natural identity candidate."""

    reader: IdentityReader | None = None

    def observe(self, path: Path) -> IdentityObservation:
        if self.reader is None:
            return IdentityObservation(IdentityState.ABSENT, source="derived")
        try:
            return _candidate_observation(self.reader(path), "derived")
        except Exception as exc:
            return IdentityObservation(IdentityState.MALFORMED, source="derived", detail=str(exc), error=exc)

    def store_if_absent(self, path: Path, entity_id: str) -> IdentityObservation:
        return self.observe(path)
