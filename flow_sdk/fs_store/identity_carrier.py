"""Identity carriers — WHERE a filesystem asset's id is stored, per type.

The TYPE names one carrier (its strategy). MINT (``TypeInfo.mint``) reads the
carrier and, when it is absent, mints an id and stamps it back through the
same carrier. A carrier enforces its own format — ``Frontmatter`` only ever
writes a markdown document, ``Sidecar`` only a folder, ``JsonRoot`` only a
json file, ``Derived`` never — so a write can only land in a source of the
carrier's own kind. Validation (v4/v5), stable-key policy and minting belong
to ``TypeInfo``; owner/fossil reconciliation to the indexer
(``flow_sdk.fs_store.indexer.reconcile``); a carrier never decides an id.

    Frontmatter   a markdown document — ``id:`` in its YAML frontmatter,
                  with read-only legacy readers (the HTML-comment ``identity``
                  capsule, ``asset_id:``, a folder's ``.flow/capsules`` json).
    Sidecar       a folder — ``<folder>/.flow/capsules/identity.json``.
    JsonRoot      a report — the ``"id"`` key of its own JSON root.
    Derived       nothing is written: the id is a pure function of the
                  source (sessions, projects, provider files).

What ``read`` answers is one of three outcomes: ``Found`` (a valid v4/v5),
``Foreign`` (something is there but it is not an id we accept — a
hand-written v7, a slug; present-but-unusable is distinct from absent) or
``ABSENT``.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, ClassVar, Protocol, runtime_checkable

from flow_sdk.api.api_types.identifier import is_valid_entity_id
from flow_sdk.capsules import (
    AssetCapsule,
    CapsuleData,
    CapsuleError,
    DuplicateCapsuleError,
    MalformedCapsuleError,
    UnsupportedCapsuleVersionError,
    strip_capsule_blocks,
)
from flow_sdk.capsules.folder import FolderCapsule
from flow_sdk.fs_store.indexer._frontmatter import (
    _atomic_write_text,
    _extract_frontmatter,
    _yaml_load,
    merge_frontmatter,
)
from flow_sdk.schema.layout import Layout

#: A legacy reader returns the raw value it found (validated here) or a
#: ``Found``/``Foreign``/``ABSENT`` of its own when it knows the source.
IdentityReader = Callable[[Any], object | None]

#: Source names for the two legacy forms ``reconcile`` converts in place: the
#: markdown HTML-comment capsule (stripped) and a folder's json capsule under a
#: markdown main document (left in place; the id is copied into the header).
CAPSULE_SOURCE = "capsule"
FOLDER_JSON_SOURCE = "folder-json"
LEGACY_CONVERTIBLE = frozenset({CAPSULE_SOURCE, FOLDER_JSON_SOURCE})


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class MalformedCarrier(ValueError):
    """The carrier is present but unreadable (corrupt capsule, non-object JSON).
    A corrupt source must never be silently re-identified, so this fails closed."""


class NotWritable(ValueError):
    """The carrier refuses to write at this path: it is not the carrier's own
    format (a ``.py`` under ``Frontmatter``), or the carrier never writes."""


class ForeignId(ValueError):
    """The carrier holds a value that is not an entity id (a v7, a slug). The
    bytes are the user's; the seam neither adopts nor overwrites them."""

    def __init__(self, where: Path, raw: object) -> None:
        self.where = where
        self.raw = raw
        super().__init__(f"{where} carries a foreign id {raw!r}")


class Unstamped(ValueError):
    """A keyless mint could not be persisted (``write=False``, or the write
    failed): a random id that lands nowhere would differ on every call, so
    there is no honest answer."""


class UnclaimedPath(ValueError):
    """A type was asked to identify a path that does not have its shape.
    Raised BEFORE the carrier is read, so a ``.py`` reached under ``markdown``
    is never parsed, stamped, or answered with a path-derived id."""

    def __init__(self, type_name: str, path: Path, reason: str = "") -> None:
        self.type_name = type_name
        self.path = path
        super().__init__(f"{type_name} does not claim {path}" + (f": {reason}" if reason else ""))


# ---------------------------------------------------------------------------
# Read outcomes
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Found:
    """The source names a valid v4/v5 id; ``source`` says which reader answered."""

    id: str
    source: str = ""


@dataclass(frozen=True, slots=True)
class Foreign:
    """The source names something that is NOT an id we accept."""

    raw: object
    source: str = ""


class Absent:
    """Nothing is there. A singleton: compare with ``is ABSENT``."""

    __slots__ = ()

    def __repr__(self) -> str:
        return "ABSENT"


ABSENT = Absent()

CarrierRead = Found | Foreign | Absent


def _outcome(value: object | None, source: str) -> CarrierRead:
    if value is None:
        return ABSENT
    if isinstance(value, (Found, Foreign, Absent)):
        return value
    if is_valid_entity_id(value):
        return Found(str(value), source)
    return Foreign(value, source)


# ---------------------------------------------------------------------------
# The protocol
# ---------------------------------------------------------------------------


@runtime_checkable
class IdentityCarrier(Protocol):
    #: False for a carrier that never writes: the id is a pure function of the
    #: source, so an owning DB row must never be handed to it either — a stale
    #: row on a rotated session path would otherwise swallow a different asset.
    writable: bool

    def locate(self, layout: Layout) -> Path:
        """WHERE in this layout the id lives (the body for a document carrier,
        the root for a folder carrier)."""
        ...

    def accepts(self, where: Path) -> bool:
        """True when ``where`` is this carrier's own format, so a write may land."""
        ...

    def read(self, where: Path) -> CarrierRead: ...

    def stamp(self, where: Path, entity_id: str) -> str:
        """Write-if-absent: a ``Found`` id wins and is returned; ``Foreign``
        raises ``ForeignId``; a path the carrier does not ``accept`` raises
        ``NotWritable``."""
        ...


def _read_legacy(readers: tuple[IdentityReader, ...], path: Path) -> CarrierRead:
    """First legacy reader naming a valid id wins; a reader that raises is a
    broken carrier (fail closed); else the first present-but-foreign value."""
    first_foreign: Foreign | None = None
    for index, reader in enumerate(readers):
        source = getattr(reader, "__name__", f"legacy:{index}")
        try:
            found = _outcome(reader(path), source)
        except Exception as exc:  # noqa: BLE001 — a broken legacy carrier is not absence
            raise MalformedCarrier(f"{source}: {exc}") from exc
        if isinstance(found, Found):
            return found
        if isinstance(found, Foreign) and first_foreign is None:
            first_foreign = found
    return first_foreign or ABSENT


def _resolve(primary: CarrierRead, legacy: CarrierRead) -> CarrierRead:
    """A valid id from either wins (primary first); else the primary's foreign
    value, else the legacy's, else absent."""
    if isinstance(primary, Found):
        return primary
    if isinstance(legacy, Found):
        return legacy
    return primary if isinstance(primary, Foreign) else legacy


def _read_identity_capsule(capsule: AssetCapsule, where: Path, source: str) -> CarrierRead:
    """The named ``identity`` capsule, raising ``MalformedCarrier`` on a corrupt one."""
    try:
        data = capsule.read("identity")
    except (MalformedCapsuleError, DuplicateCapsuleError, UnsupportedCapsuleVersionError, CapsuleError, OSError) as exc:
        raise MalformedCarrier(f"identity capsule at {where}: {exc}") from exc
    if data is None:
        return ABSENT
    if data.version != 1:
        raise MalformedCarrier(f"identity capsule at {where} has version {data.version}; expected 1")
    if set(data.data) != {"id"}:
        raise MalformedCarrier(f"identity capsule at {where} must contain exactly the 'id' key")
    return _outcome(data.data.get("id"), source)


def capsule_id(path: Path) -> CarrierRead:
    """Legacy reader: the id in a markdown ``identity`` comment-capsule block."""
    if not path.is_file():
        return ABSENT
    try:
        capsule = AssetCapsule.from_path(path)
    except (CapsuleError, OSError) as exc:
        raise MalformedCarrier(f"identity capsule at {path}: {exc}") from exc
    return _read_identity_capsule(capsule, path, CAPSULE_SOURCE)


def folder_capsule_json_id(path: Path) -> CarrierRead:
    """Legacy reader for a folder type whose main doc is markdown: the id its
    ``.flow/capsules/identity.json`` carried before the doc's frontmatter did."""
    folder = path if path.is_dir() else path.parent
    if not (folder / ".flow" / "capsules" / "identity.json").exists():
        return ABSENT
    return _read_identity_capsule(FolderCapsule(folder), folder, FOLDER_JSON_SOURCE)


# ---------------------------------------------------------------------------
# The carriers
# ---------------------------------------------------------------------------

_MARKDOWN_SUFFIXES = frozenset({".md", ".mdx", ".markdown"})


@dataclass(frozen=True, slots=True)
class Frontmatter:
    """A markdown document: ``id:`` in its YAML frontmatter. ``legacy`` readers
    are read-only fallbacks; the two convertible ones among them are moved
    into the header by ``convert`` (invoked only from ``reconcile``)."""

    legacy: tuple[IdentityReader, ...] = ()

    writable: ClassVar[bool] = True

    def locate(self, layout: Layout) -> Path:
        return layout.body if layout.body is not None else layout.root

    def accepts(self, where: Path) -> bool:
        """A markdown file, or a markdown save target whose bytes land moments
        later (a serializer mints against the asset_ref before it writes)."""
        return where.suffix.lower() in _MARKDOWN_SUFFIXES and (where.is_file() or not where.exists())

    def read(self, where: Path) -> CarrierRead:
        try:
            text = where.read_text(encoding="utf-8")
        except OSError:
            header = None
        else:
            header = _extract_frontmatter(text)
        fields = (_yaml_load(header) or {}) if header else {}
        primary = _outcome(fields.get("id"), "frontmatter")
        if isinstance(primary, Found):
            return primary
        return _resolve(primary, _read_legacy(self.legacy, where))

    def stamp(self, where: Path, entity_id: str) -> str:
        if not self.accepts(where):
            raise NotWritable(f"frontmatter carrier cannot write into {where}")
        current = self.read(where)
        if isinstance(current, Found):
            return current.id
        if isinstance(current, Foreign):
            raise ForeignId(where, current.raw)
        try:
            text = where.read_text(encoding="utf-8")
        except FileNotFoundError:
            text = ""
        _atomic_write_text(where, merge_frontmatter(text, {"id": entity_id}, prepend=True))
        return entity_id

    def convert(self, where: Path, entity_id: str) -> None:
        """Move a legacy carrier into the header: one rewrite, same id. A
        markdown comment capsule is stripped; a folder json is left in place."""
        if not self.accepts(where):
            raise NotWritable(f"frontmatter carrier cannot write into {where}")
        text = where.read_text(encoding="utf-8")
        _atomic_write_text(where, merge_frontmatter(strip_capsule_blocks(text), {"id": entity_id}, prepend=True))


@dataclass(frozen=True, slots=True)
class Sidecar:
    """A folder asset: ``<folder>/.flow/capsules/identity.json``; ``legacy``
    readers (``.flow/id``, a name-derived id) are read-only fallbacks. Goes
    through ``FolderCapsule`` directly — never ``AssetCapsule.from_path``,
    which sniffs suffixes and would write a comment capsule into a file."""

    legacy: tuple[IdentityReader, ...] = ()

    writable: ClassVar[bool] = True

    def locate(self, layout: Layout) -> Path:
        return layout.root

    def accepts(self, where: Path) -> bool:
        return where.is_dir()

    def read(self, where: Path) -> CarrierRead:
        primary = _read_identity_capsule(FolderCapsule(where), where, FOLDER_JSON_SOURCE) if where.is_dir() else ABSENT
        if isinstance(primary, Found):
            return primary
        return _resolve(primary, _read_legacy(self.legacy, where))

    def stamp(self, where: Path, entity_id: str) -> str:
        if not self.accepts(where):
            raise NotWritable(f"sidecar carrier cannot write into {where}")
        current = self.read(where)
        if isinstance(current, Found):
            return current.id
        if isinstance(current, Foreign):
            raise ForeignId(where, current.raw)
        try:
            committed = FolderCapsule(where).write_if_absent("identity", CapsuleData(version=1, data={"id": entity_id}))
        except CapsuleError as exc:
            raise MalformedCarrier(f"identity capsule at {where}: {exc}") from exc
        return str(committed.data.get("id") or entity_id)


@dataclass(frozen=True, slots=True)
class JsonRoot:
    """A report: the ``"id"`` key of its own JSON root."""

    writable: ClassVar[bool] = True

    def locate(self, layout: Layout) -> Path:
        return layout.body if layout.body is not None else layout.root

    def accepts(self, where: Path) -> bool:
        return where.suffix.lower() == ".json" and where.is_file()

    def _load(self, where: Path) -> dict:
        try:
            data = json.loads(where.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise MalformedCarrier(f"{where}: {exc}") from exc
        if not isinstance(data, dict):
            raise MalformedCarrier(f"{where}: root must be an object")
        return data

    def read(self, where: Path) -> CarrierRead:
        return _outcome(self._load(where).get("id"), "native-json")

    def stamp(self, where: Path, entity_id: str) -> str:
        if not self.accepts(where):
            raise NotWritable(f"json-root carrier cannot write into {where}")
        data = self._load(where)
        current = _outcome(data.get("id"), "native-json")
        if isinstance(current, Found):
            return current.id
        if isinstance(current, Foreign):
            raise ForeignId(where, current.raw)
        data["id"] = entity_id
        _atomic_write_text(where, json.dumps(data, indent=2) + "\n")
        return entity_id


@dataclass(frozen=True, slots=True)
class Derived:
    """Nothing is written; ``reader`` (if any) computes the id from the source."""

    reader: IdentityReader | None = None

    writable: ClassVar[bool] = False

    def locate(self, layout: Layout) -> Path:
        return layout.root

    def accepts(self, where: Path) -> bool:
        return False

    def read(self, where: Path) -> CarrierRead:
        if self.reader is None:
            return ABSENT
        try:
            value = self.reader(where)
        except Exception as exc:  # noqa: BLE001
            raise MalformedCarrier(f"derived identity for {where}: {exc}") from exc
        return Found(str(value), "derived") if is_valid_entity_id(value) else ABSENT

    def stamp(self, where: Path, entity_id: str) -> str:
        raise NotWritable(f"a derived identity is never written ({where})")
