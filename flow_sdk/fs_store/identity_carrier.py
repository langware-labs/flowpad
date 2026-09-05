"""Identity carriers — WHERE a filesystem asset's id is stored, per type.

A carrier does two things: ``read`` the id already in the source, and
``write_if_absent`` a new one. Validation (v4/v5), stable-key policy and minting
belong to ``TypeInfo.mint_entity_id``; a carrier never decides an id.

    FrontmatterCarrier   a markdown document — ``id:`` in its YAML frontmatter.
                         Legacy readers: the HTML-comment ``identity`` capsule
                         markdown used to carry (converted in place on the next
                         index), ``asset_id:``, a folder's ``.flow/capsules`` json.
    FolderJsonCarrier    a folder whose main document is JSON — ``.flow/capsules/identity.json``.
    NativeJsonCarrier    a report — the ``"id"`` key of its own JSON root.
    DerivedCarrier       nothing is written: the id is a pure function of the
                         source (sessions, projects, provider files).
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, ClassVar, Protocol, runtime_checkable

from flow_sdk.capsules import (
    AssetCapsule,
    CapsuleData,
    CapsuleError,
    DuplicateCapsuleError,
    MalformedCapsuleError,
    UnsupportedCapsuleVersionError,
    strip_capsule_blocks,
)
from flow_sdk.api.api_types.identifier import is_valid_entity_id
from flow_sdk.fs_store.indexer._frontmatter import (
    _atomic_write_text,
    _extract_frontmatter,
    _yaml_load,
    merge_frontmatter,
)

#: A legacy reader returns the raw value it found (validated here) or a
#: ``CarrierId`` of its own when it knows the source.
IdentityReader = Callable[[Any], object | None]

#: Source names for the two legacy carriers the seam converts in place: the
#: markdown HTML-comment capsule (stripped) and a folder's json capsule under a
#: markdown main document (left in place; the id is copied into the header).
CAPSULE_SOURCE = "capsule"
FOLDER_JSON_SOURCE = "folder-json"
LEGACY_CONVERTIBLE = frozenset({CAPSULE_SOURCE, FOLDER_JSON_SOURCE})


class MalformedCarrier(ValueError):
    """The carrier is present but unreadable (corrupt capsule, non-object JSON).
    A corrupt source must never be silently re-identified, so this fails closed."""


class UnclaimedPath(ValueError):
    """A type was asked to identify a path that does not have its shape.

    Raised BEFORE the carrier is read, so a ``.py`` reached under ``markdown``
    is never parsed as a document, never stamped (FLOWPAD-2083), and never
    answered with a path-derived id that no row and no carrier would agree
    with. The caller mis-classified the path; "not an asset of this type" is
    the only honest answer.
    """

    def __init__(self, type_name: str, path: Path, reason: str = "") -> None:
        self.type_name = type_name
        self.path = path
        super().__init__(f"{type_name} does not claim {path}" + (f": {reason}" if reason else ""))


@dataclass(frozen=True, slots=True)
class CarrierId:
    """What ``read`` found: ``id`` when the source names a valid v4/v5 UUID;
    ``raw`` when it names something that is NOT one (a hand-written v7, a
    slug) — present-but-unusable is distinct from absent; ``source`` says which
    carrier answered."""

    id: str | None = None
    raw: object | None = None
    source: str | None = None

    @property
    def present(self) -> bool:
        return self.id is not None or self.raw is not None


ABSENT = CarrierId()


def _carrier_id(value: object | None, source: str) -> CarrierId:
    if value is None:
        return ABSENT
    if is_valid_entity_id(value):
        return CarrierId(id=str(value), source=source)
    return CarrierId(raw=value, source=source)


@runtime_checkable
class IdentityCarrier(Protocol):
    #: False for a carrier that never writes: the id is a pure function of the
    #: source, so an owning DB row must never be handed to it either — a stale
    #: row on a rotated session path would otherwise swallow a different asset.
    writable: bool

    def read(self, path: Path) -> CarrierId: ...

    def write_if_absent(self, path: Path, entity_id: str) -> str: ...


def _read_legacy(readers: tuple[IdentityReader, ...], path: Path) -> CarrierId:
    """First legacy reader naming a valid id wins; a reader that raises is a
    broken carrier (fail closed); else the first present-but-invalid value."""
    first_invalid: CarrierId | None = None
    for index, reader in enumerate(readers):
        source = getattr(reader, "__name__", f"legacy:{index}")
        try:
            value = reader(path)
            found = value if isinstance(value, CarrierId) else _carrier_id(value, source)
        except Exception as exc:  # noqa: BLE001 — a broken legacy carrier is not absence
            raise MalformedCarrier(f"{source}: {exc}") from exc
        if found.id is not None:
            return found
        if found.raw is not None and first_invalid is None:
            first_invalid = found
    return first_invalid or ABSENT


def _read_identity_capsule(path: Path) -> CarrierId:
    """The named ``identity`` capsule at ``path`` (markdown comment block or
    folder json), raising ``MalformedCarrier`` on a corrupt one."""
    try:
        data = AssetCapsule.from_path(path).read("identity")
    except (MalformedCapsuleError, DuplicateCapsuleError, UnsupportedCapsuleVersionError, CapsuleError, OSError) as exc:
        raise MalformedCarrier(f"identity capsule at {path}: {exc}") from exc
    if data is None:
        return ABSENT
    if data.version != 1:
        raise MalformedCarrier(f"identity capsule at {path} has version {data.version}; expected 1")
    if set(data.data) != {"id"}:
        raise MalformedCarrier(f"identity capsule at {path} must contain exactly the 'id' key")
    # The markdown comment block is the one legacy form the seam converts; a
    # folder's json capsule is a live carrier and must not be mistaken for it.
    return _carrier_id(data.data.get("id"), CAPSULE_SOURCE if path.is_file() else FOLDER_JSON_SOURCE)


def capsule_id(path: Path) -> CarrierId:
    """Legacy reader: the id in a markdown ``identity`` capsule block."""
    return _read_identity_capsule(path) if path.is_file() else ABSENT


def folder_capsule_json_id(path: Path) -> CarrierId:
    """Legacy reader for a folder type whose main doc is markdown: the id its
    ``.flow/capsules/identity.json`` carried before the doc's frontmatter did."""
    folder = path.parent if path.is_file() else path
    return _read_identity_capsule(folder) if (folder / ".flow" / "capsules" / "identity.json").exists() else ABSENT


@dataclass(frozen=True, slots=True)
class FrontmatterCarrier:
    """A markdown document: ``id:`` in its YAML frontmatter. ``legacy`` readers
    are read-only fallbacks; the markdown capsule among them is CONVERTED in
    place by ``convert`` (id written to the header, block stripped)."""

    legacy: tuple[IdentityReader, ...] = ()

    writable: ClassVar[bool] = True

    def read(self, path: Path) -> CarrierId:
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            return ABSENT
        header = _extract_frontmatter(text)
        fields = (_yaml_load(header) or {}) if header else {}
        found = _carrier_id(fields.get("id"), "frontmatter")
        if found.id is not None:
            return found
        legacy = _read_legacy(self.legacy, path)
        return legacy if legacy.id is not None else (found if found.raw is not None else legacy)

    def write_if_absent(self, path: Path, entity_id: str) -> str:
        current = self.read(path)
        if current.id is not None:
            return current.id
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            text = ""
        _atomic_write_text(path, merge_frontmatter(text, {"id": entity_id}, prepend=True))
        return entity_id

    def convert(self, path: Path, entity_id: str) -> None:
        """Move a legacy markdown capsule into the header: one rewrite, same id."""
        text = path.read_text(encoding="utf-8")
        _atomic_write_text(path, merge_frontmatter(strip_capsule_blocks(text), {"id": entity_id}, prepend=True))


@dataclass(frozen=True, slots=True)
class FolderMdCarrier(FrontmatterCarrier):
    """A folder type whose main document is markdown (``SKILL.md``, ``task.md``):
    the id lives in that document's frontmatter. When the folder has no main
    document at all (a yaml-only skill) the folder's ``.flow/capsules/identity.json``
    stays the carrier — ``carrier_path_for`` hands over the folder in that case."""

    def read(self, path: Path) -> CarrierId:
        if path.is_dir():
            return FolderJsonCarrier(legacy=self.legacy).read(path)
        return FrontmatterCarrier.read(self, path)  # explicit base call: zero-arg super is unavailable under slots=True

    def write_if_absent(self, path: Path, entity_id: str) -> str:
        if path.is_dir():
            return FolderJsonCarrier(legacy=self.legacy).write_if_absent(path, entity_id)
        return FrontmatterCarrier.write_if_absent(self, path, entity_id)


@dataclass(frozen=True, slots=True)
class FolderJsonCarrier:
    """A folder asset: ``<folder>/.flow/capsules/identity.json``; ``legacy``
    readers (``.flow/id``, a name-derived id) are read-only fallbacks."""

    legacy: tuple[IdentityReader, ...] = ()

    writable: ClassVar[bool] = True

    def read(self, path: Path) -> CarrierId:
        found = _read_identity_capsule(path)
        if found.id is not None:
            return found
        legacy = _read_legacy(self.legacy, path)
        return legacy if legacy.id is not None else (found if found.raw is not None else legacy)

    def write_if_absent(self, path: Path, entity_id: str) -> str:
        try:
            committed = AssetCapsule.from_path(path).write_if_absent("identity", CapsuleData(version=1, data={"id": entity_id}))
        except (CapsuleError, OSError) as exc:
            raise MalformedCarrier(f"identity capsule at {path}: {exc}") from exc
        return str(committed.data.get("id") or entity_id)


@dataclass(frozen=True, slots=True)
class NativeJsonCarrier:
    """A report: the ``"id"`` key of its own JSON root."""

    writable: ClassVar[bool] = True

    def _load(self, path: Path) -> dict:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise MalformedCarrier(f"{path}: {exc}") from exc
        if not isinstance(data, dict):
            raise MalformedCarrier(f"{path}: root must be an object")
        return data

    def read(self, path: Path) -> CarrierId:
        return _carrier_id(self._load(path).get("id"), "native-json")

    def write_if_absent(self, path: Path, entity_id: str) -> str:
        data = self._load(path)
        if data.get("id") is not None:
            return str(data["id"])
        data["id"] = entity_id
        _atomic_write_text(path, json.dumps(data, indent=2) + "\n")
        return entity_id


@dataclass(frozen=True, slots=True)
class DerivedCarrier:
    """Nothing is written; ``reader`` (if any) computes the id from the source."""

    reader: IdentityReader | None = None

    writable: ClassVar[bool] = False

    def read(self, path: Path) -> CarrierId:
        if self.reader is None:
            return ABSENT
        try:
            return _carrier_id(self.reader(path), "derived")
        except Exception as exc:  # noqa: BLE001
            raise MalformedCarrier(f"derived identity for {path}: {exc}") from exc

    def write_if_absent(self, path: Path, entity_id: str) -> str:
        return self.read(path).id or entity_id
