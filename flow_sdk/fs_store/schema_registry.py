"""SchemaRegistry — unified type system for Record + Entity layers.

Files:
  ~/.flow/schema/scan_log.jsonl                          — global scan log
  ~/.flow/schema/index_log.jsonl                         — global index log
  ~/.flow/schema/types/<sanitized_type>/type_info.json   — per-type TypeInfo
  ~/.flow/schema/types/<sanitized_type>/scan_log.jsonl   — per-type scan log
  ~/.flow/schema/types/<sanitized_type>/index_log.jsonl  — per-type index log

Each log file keeps at most _MAX_LOG_ENTRIES entries (oldest trimmed on append).
"""

from __future__ import annotations

import hashlib
import json
import logging
import uuid
from collections.abc import Container
from dataclasses import dataclass, field, fields
from datetime import datetime, timezone
from functools import cache
from pathlib import Path
from typing import Any, ClassVar, Literal, Optional, get_args, get_origin

from flow_sdk._compat import StrEnum
from flow_sdk.capsules import CapsuleSpec
from flow_sdk.api.api_types.identifier import is_valid_entity_id, mint_uuid
from flow_sdk.fs_store.identity_carrier import CarrierId, FrontmatterCarrier, IdentityCarrier
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.instance_settings import get_instance_settings
from flow_sdk.schema.view_mode import ViewMode, view_mode_rank, visible_in

_MAX_LOG_ENTRIES: int = 100


def _schema_dir() -> Path:
    """Resolve the per-instance schema dir at call time.

    Lives on InstanceSettings — never cache the result, never construct
    `~/.flow/<...>/schema` directly. This getter is the single chokepoint.
    """
    return get_instance_settings().schema_dir


def _sanitize_type_name(type_name: str) -> str:
    """Make a type name safe for use as a directory/file name component."""
    return type_name.replace(":", "__").replace(" ", "_")


def _schema_dir_for(type_name: str) -> Path:
    return _schema_dir() / "types" / _sanitize_type_name(type_name)


# ---------------------------------------------------------------------------
# JSONL helpers
# ---------------------------------------------------------------------------


def _append_jsonl(path: Path, entry: dict[str, Any]) -> None:
    """Append one JSON line to *path*, then trim to _MAX_LOG_ENTRIES lines."""
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(entry, default=str) + "\n"
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(line)
    _trim_jsonl(path)


def _trim_jsonl(path: Path) -> None:
    """If the file exceeds _MAX_LOG_ENTRIES lines, keep only the last N."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            lines = fh.readlines()
        if len(lines) <= _MAX_LOG_ENTRIES:
            return
        keep = lines[-_MAX_LOG_ENTRIES:]
        tmp = path.with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.writelines(keep)
        tmp.replace(path)
    except Exception:
        pass


def _read_last_entry(path: Path) -> dict[str, Any] | None:
    """Return the last JSON object from a JSONL file, or None."""
    try:
        if not path.exists():
            return None
        with open(path, "r", encoding="utf-8") as fh:
            lines = [ln for ln in fh if ln.strip()]
        if not lines:
            return None
        return json.loads(lines[-1])
    except Exception:
        return None


# ---------------------------------------------------------------------------
# SDK result types
# ---------------------------------------------------------------------------


@dataclass
class ClearResult:
    fts_cleared: int
    entities_cleared: int
    types_cleared: list[str]


@dataclass
class TypeIndexStatus:
    type_name: str
    last_indexed_at: str | None
    entity_count: int
    stale: bool
    orphan_count: int = 0


@dataclass
class IndexStatus:
    never_indexed: bool
    last_indexed_at: str | None
    stale: bool
    default_types: list[str]
    per_type: list[TypeIndexStatus]
    total_orphans: int = 0


@dataclass
class AssetStats:
    """Live per-type asset counts for a ScopeFilter — counts only. Freshness
    and orphans deliberately live in ``IndexStatus`` / ``get_index_status``;
    this is the single source the UI counter surfaces render from."""

    per_type: dict[str, int]
    total: int


# ---------------------------------------------------------------------------
# Hardcoded fallback list so get_default_index_types() works before any
# Record subclass has registered itself as indexed_by_default.
# ---------------------------------------------------------------------------

_BUILTIN_DEFAULT_TYPES: list[str] = [
    # Filesystem-scannable types (must overlap with INDEXABLE_TYPES in
    # flow_sdk/fs_store/indexer/builtin.py — the indexer can't walk types
    # not registered there). Runtime-only types like BOOKMARK, ANNOTATION,
    # AGENTIC_PROCESS, RECORD_ERROR, CLAUDE_ERROR are written to the DB by
    # Record.save and intentionally excluded from this list.
    RecordType.SKILL,
    RecordType.SUBAGENT,
    RecordType.AGENT,
    RecordType.TASK,
    RecordType.MARKDOWN,
    RecordType.PLAN,
    RecordType.CLAUDE_MD,
    RecordType.CLAUDE_MEMORY,
    RecordType.CLAUDE_RULES,
    RecordType.CLAUDE_HOOK,
    RecordType.COMMAND,
]


# ---------------------------------------------------------------------------
# TypeInfo
# ---------------------------------------------------------------------------


def humanize_type(type_name: str) -> str:
    """``"agentic_process"`` → ``"Agentic Process"``. The generic title-caser used
    as the fallback label when a type has no curated ``display_name`` — the Python
    mirror of the frontend ``humanizeType`` (``ui/src/tabs/provider-meta.tsx``)."""
    return " ".join(w[:1].upper() + w[1:] for w in type_name.replace("-", " ").replace("_", " ").split())


class LayoutKind(StrEnum):
    FOLDER = "folder"        # the path IS the asset folder
    MAIN_FILE = "main_file"  # the inner main file of a folder asset
    FILE = "file"            # a file-layout asset
    NONE = "none"            # not this type's shape


@dataclass(frozen=True)
class Layout:
    kind: LayoutKind
    root: "Path | None"   # the folder (folder types) / the file; None iff NONE
    body: "Path | None"   # the writable main document
    ref: "Path | None"    # where asset_ref points (``asset_ref_for(root)``)


_NO_LAYOUT = Layout(LayoutKind.NONE, None, None, None)



@dataclass
class TypeInfo:
    """Metadata for a single record/entity type."""

    # --- Structural fields (included in hash, persisted) ---
    type_name: str
    uid_field: str = "id"
    index_fields: list[str] = field(default_factory=list)
    defaults: dict[str, Any] = field(default_factory=dict)
    indexed_by_default: bool = False
    # Minimum view mode at which this type is browseable (None ⇒ never). See
    # flow_sdk/schema/view_mode.py — visibility is cumulative.
    browseable_by: ViewMode | None = None
    creatable: bool = False
    api_visible: bool = False
    icon: str | None = None
    parent_type: str | None = None
    locations: list[str] = field(default_factory=list)
    # UX-friendly label for the type (e.g. "Skills"). Presentational, surfaced to
    # the FE via ``to_dict``; deliberately NOT in ``schema_hash`` so relabeling a
    # type never forces a reindex. Read through ``get_display_name`` (falls back to
    # ``humanize_type``).
    display_name: str | None = None

    # --- Runtime refs (NOT in hash, NOT persisted) ---
    entity_cls: type | None = field(default=None, compare=False, repr=False)
    # The type's SHAPE — the ``DataSpec`` whose fields (and field TYPES) are
    # what the medium persists: frontmatter scalars, a ``Body``, a
    # ``FreeSection``, ``FileRef``s, rows, sub-assets. None ⇒ the legacy path
    # (``default_body_fn`` / ``from_disk_fn``). Runtime-only, not in the hash.
    asset_spec: type | None = field(default=None, compare=False, repr=False, metadata={"serialization": True})
    # Optional post-sync hook: async Callable[[FSRecord], None] — runs after
    # FSRecord.sync_to_db completes its entity/FTS/wiki writes. Used by
    # types that reconcile cross-record relationships (e.g. markdown folder-doc
    # parent/child edges) that the base sync doesn't know about.
    post_sync_fn: Any = field(default=None, compare=False, repr=False)
    # Per-type indexer dispatch callables, registered next to their definitions
    # in ``fs_store/indexer/functions/<type>.py``. The indexer reads these
    # instead of duck-typing classmethods on the entity:
    #   from_disk_fn:      Callable[[FSRef, str], list[FSRecord]] — parse payload
    #   identity_carrier:  IdentityCarrier — WHERE the id lives (frontmatter / folder json / …)
    #   id_stable_key_fn:  Callable[[FSRef | Path], str | None] — v5 key
    #   asset_hash_fn:     Callable[[FSRef], float] — cheap freshness stat
    from_disk_fn: Any = field(default=None, compare=False, repr=False)
    capsules: tuple[CapsuleSpec, ...] = field(default_factory=tuple)
    identity_carrier: IdentityCarrier | None = field(default=None, compare=False, repr=False)
    id_stable_key_fn: Any = field(default=None, compare=False, repr=False)
    #   identity_key_fn:   Callable[[FSRef | Path], str] — the type's natural key.
    #     The v5 key is derived as f"{type_name}:{identity_key_fn(ref)}"; set this
    #     instead of id_stable_key_fn unless the type needs a different shape.
    identity_key_fn: Any = field(default=None, compare=False, repr=False)
    id_namespace: uuid.UUID = field(default=uuid.NAMESPACE_URL, compare=False, repr=False)
    asset_hash_fn: Any = field(default=None, compare=False, repr=False)
    # Per-type default-body writer: Callable[[entity], str]. Read by
    # FSRecord.default_body / upsert_main_ref to materialize the backing file on
    # create. None ⇒ no auto-created body.
    default_body_fn: Any = field(default=None, compare=False, repr=False)
    # True ⇒ entity saves re-render the backing file from default_body_fn on
    # EVERY store() (entity is the file's sole editor), not just on create.
    owns_main_ref: bool = field(default=False, compare=False, repr=False)
    # True ⇒ sharing an entity of this type also shares its parent
    # (``parent_type_id``); the receive path materializes the parent first via
    # ``Entity.materialize_share_parent``. Runtime-only; not part of the
    # schema hash. Only safe when the parent type is deterministic/field-frozen.
    parent_share_on_default: bool = field(default=False, compare=False, repr=False)
    # True ⇒ this hub-hosted ``is_child`` type is pulled during the shared-context
    # catch-up sync (``_sync_shared_context_subtree``). The live bridge already
    # materializes any child type generically, so this flag only declares the
    # pull-side type list — sourced from the registry, not a hardcoded tuple.
    # Runtime-only; not part of the schema hash.
    shared_child: bool = field(default=False, compare=False, repr=False)
    # The declarative TypeMetadata (possibly a per-type subclass) this TypeInfo
    # was built from — home for type-specific extras beyond the flat fields.
    # Runtime-only; the flat fields above remain the serialized surface.
    metadata: Any = field(default=None, compare=False, repr=False)
    # True ⇒ Entity.save persists the row in the DB only and never creates an
    # FSRecord shadow. Such types have no disk→DB adopt path. Runtime-only; not
    # part of the schema hash.
    db_only: bool = field(default=False, compare=False, repr=False)
    # Cloud delivery capability for file-backed assets. Serialized to the UI
    # bootstrap but deliberately excluded from the local indexing schema hash.
    cloud_file_transport: Literal["embedded", "git"] = field(
        default="embedded", compare=False, repr=False
    )
    # Per-type pydantic metadata model: the FS↔DB schema. Its field set defines
    # which entity fields with ``persist=DEFAULT`` are mirrored to metadata.json,
    # and ``FSRecord.meta_dict`` returns a typed instance when it is set.
    # Runtime-only; not part of the schema hash.
    meta_model: Any = field(default=None, compare=False, repr=False)
    # --- Serialization (HOW/WHERE) — runtime-only, not part of the schema hash ---
    # The origin kind a store/load defaults to when the caller passes none:
    # "local" (disk) for asset types, "db" for db_only types.
    default_origin_kind: str = field(default="local", compare=False, repr=False, metadata={"serialization": True})
    # The path names the entity when the header carries no name: the folder
    # name for a folder type (an Agent at ``agent/q/`` is ``q``), the file stem
    # for a file type (``prompts/greet.md`` is ``greet``). A LAYOUT fact.
    name_from_path: bool = field(default=False, compare=False, repr=False, metadata={"serialization": True})
    # JSON main docs: ``"sections"`` = ``{metadata, data}`` (a dataset);
    # ``"flat"`` = the header's keys merged into the payload's own document (a
    # trace/report whose file predates us). None ⇒ flat when the class has no
    # ``data_field``, sections otherwise.
    manifest_layout: str | None = field(default=None, compare=False, repr=False, metadata={"serialization": True})
    # Facts the DISK carries that the header cannot say: counts over rows,
    # links scraped from a body, a name from the path. ``(data, root, header_raw)``
    # mutates the entity kwargs after the main doc and fields are read, before
    # the class is constructed.
    derive_fields_fn: Any = field(default=None, compare=False, repr=False, metadata={"serialization": True})
    # The entity field naming the rows' on-disk layout (``"data_layout"`` for a
    # dataset). Tells the disk serializer this type has layout-written rows,
    # without the serializer ever naming the type.
    rows_layout_field: str | None = field(default=None, compare=False, repr=False, metadata={"serialization": True})
    # The canonical filename the asset's main doc is published under on the hub
    # (``document.md`` for a markdown doc, ``SKILL.md`` for a skill folder).
    # Also the opt-in: ``None`` keeps the generic embedded-VFS push.
    hub_main_file: str | None = field(default=None, compare=False, repr=False, metadata={"serialization": True})
    # Row identity for row-only types: the fields whose tuple resolves an
    # existing row (``SourceItem``: data_source · segment · external id). None ⇒
    # identity is ``id`` alone. Read by ``DbSerializer.resolve``/``upsert``.
    natural_key: tuple[str, ...] | None = field(default=None, compare=False, repr=False, metadata={"serialization": True})
    # The no-op gate: the fields whose canonical digest decides "unchanged" on
    # re-delivery. None ⇒ no gate (every save writes).
    digest_fields: tuple[str, ...] | None = field(default=None, compare=False, repr=False, metadata={"serialization": True})
    # The row field that HOLDS the digest the gate compares against.
    digest_field: str = field(default="content_digest", compare=False, repr=False, metadata={"serialization": True})
    # A row-only (``db_only``) type that is nonetheless searchable: the row field
    # FTS indexes as ``content`` — fed from the row, no metadata.json shadow.
    fts_content: tuple[str, ...] = field(default=(), compare=False, repr=False, metadata={"serialization": True})
    # --- Placement axis (the harness-aware replacement for ``main_subdir``) ---
    # ``asset_class`` is the "definition" (INTERNAL / HARNESS / SHARED / NONE);
    # ``harness`` names the owning harness for HARNESS types; ``family`` is the
    # bare leaf subdir (``skills``, ``docs``, ``assets/datasets``). Placement is
    # resolved through ``flow_sdk.fs_store.placement``. ``main_subdir`` survives as
    # a DERIVED, read-only property (below) — the canonical claude-default family
    # subdir (``.claude/skills``, ``docs``) — so the many legacy consumers keep
    # working unchanged. Not hashed.
    asset_class: Any = None  # placement.AssetClass | None
    harness: Any = None  # placement.HarnessType | None
    family: str | None = None
    main_layout: str = "file"
    # For ``main_layout == "folder"`` owned types: the fixed inner filename of
    # the primary asset (e.g. ``spec.md`` under ``specs/<name>/``). When set,
    # ``compute_asset_ref`` targets ``<subdir>/<name>/<main_file>`` instead of
    # the bare folder, so ``owns_main_ref`` folder types can write/round-trip
    # the body file. Runtime-only; not part of the schema hash.
    main_file: str | None = None
    # Folder-layout types: True ⇒ asset_ref IS ``<subdir>/<name>/<main_file>``
    # (spec); False ⇒ asset_ref is the bare folder and the default body is
    # materialized into ``<folder>/<main_file>`` (skill). Runtime-only.
    main_file_is_asset_ref: bool = False
    # File extension for ``main_layout == "file"`` types — the suffix
    # ``compute_asset_ref`` appends to ``<subdir>/<name>``. Defaults to ``.md``
    # (the markdown-asset family); a ``.js``/``.py``/… asset overrides it so its
    # backing file matches the indexer's glob. Runtime-only.
    main_ext: str = ".md"
    # Fields the ASSIGNEE of a shared entity owns. When the local user is the
    # entity's assignee (and not its reporter), a hub-reflected update carries
    # ONLY these — everything else on the row belongs to whoever handed the work
    # over. Without it, one shared row means whole-row LWW
    # (``Entity.is_stale``): the assignee's UI PUTs its entire snapshot, so a
    # status click reverts the owner's title/body (measured, 2026-07-28). Empty
    # ⇒ no scoping, the historical behavior for every other type. Runtime-only;
    # not part of the schema hash.
    assignee_owned_fields: tuple = field(default_factory=tuple, compare=False, repr=False)
    # Filenames/globs inside a folder-backed asset that must NOT ride a share
    # bundle. The packer copies the folder verbatim, so this is the only place a
    # type can keep a private file at home (a task's inner ``spec.md`` — the
    # plan). Consumed by ``flow_message_bundle._pack_ignore``. Runtime-only; not
    # part of the schema hash.
    pack_exclude: tuple = field(default_factory=tuple, compare=False, repr=False)
    # Reception seam (runtime-only; not in the schema hash). ``setup_skill`` is the
    # built-in skill that sets a received attachment of this type up in a Vibe
    # session (``None`` ⇒ just open it; a value equal to ``type_name`` ⇒ run the
    # received entity as its own skill). ``reception_verb`` is the receive CTA verb
    # (label = ``"<reception_verb> the <typeLabel>"``). Read by
    # ``Entity.setup_on_receive`` and surfaced to the FE via ``to_dict``.
    setup_skill: str | None = None
    reception_verb: str = "Open"
    # ``receive_policy``: reception gate for a bundled entry of this type.
    # ``None`` ⇒ staged → review → explicit install; ``"auto"`` ⇒ row-only
    # payload installed immediately at unpack through the one install action
    # (no review dialog; its chip navigates). ``receive_row_overrides`` are the
    # local-state fields merged over the packed header when the row
    # materializes (backend-only; never serialized).
    receive_policy: str | None = None
    receive_row_overrides: dict | None = None

    @property
    def git_publishable(self) -> bool:
        """Whether this registered type can be re-parsed for Git publication."""
        return (
            self.cloud_file_transport == "git"
            and self.from_disk_fn is not None
            and self.identity_carrier is not None
        )

    def asset_ref_for(self, folder: Path) -> Path:
        """Where a folder-layout type's asset_ref points, given its folder.

        Spec-style (``main_file_is_asset_ref``) anchors asset_ref on the inner
        ``<folder>/<main_file>``; skill-style keeps it on the bare folder. The
        inverse of ``body_path_for`` — both live here so the folder↔body
        convention is stated once. Callers gate on ``main_layout == "folder"``.
        """
        if self.main_file and self.main_file_is_asset_ref:
            return folder / self.main_file
        return folder

    def layout_of(self, path: Path, *, verify: bool = False) -> "Layout":
        """THE path→layout classifier. A folder type names its folder (``FOLDER``)
        or the inner main file (``MAIN_FILE`` → root is the parent); a file type
        names the file (``FILE``). ``NONE`` when the path is not this type's shape.
        ``verify`` additionally requires the main file / the file to exist —
        the indexer's gate; every other mapper is a total, stat-light projection.
        Names compare case-insensitively (the default filesystem does)."""
        if self.main_layout == "folder":
            # Decide by NAME; the one stat keeps a real directory named like the
            # main file a directory. ``verify`` is where existence is required.
            names_main = bool(self.main_file) and path.name.lower() == self.main_file.lower()
            if names_main and not path.is_dir():
                root, kind = path.parent, LayoutKind.MAIN_FILE
            else:
                root, kind = path, LayoutKind.FOLDER
                if verify and not (path.is_dir() and self.main_file and (path / self.main_file).is_file()):
                    return _NO_LAYOUT
            body = root / self.main_file if self.main_file else None
            return Layout(kind, root, body, self.asset_ref_for(root))
        if (verify and not path.is_file()) or path.suffix.lower() != (self.main_ext or "").lower():
            return _NO_LAYOUT
        return Layout(LayoutKind.FILE, path, path, path)

    def body_path_for(self, asset_path: Path) -> Path:
        """The writable main-body file for an asset_ref (the file itself for a
        file type; ``<folder>/<main_file>`` for a folder type)."""
        return self.layout_of(asset_path).body or asset_path

    def record_for(self, ref: Any) -> Any:
        """Parse ONE asset: resolve its id through the one id seam (a
        ``read_only`` ref derives without stamping) and run ``from_disk_fn``;
        the first record or None."""
        if self.from_disk_fn is None:
            return None
        resolved = self.mint_entity_id(ref)
        records = self.from_disk_fn(ref, resolved)
        return records[0] if records else None

    def storage_root_for(self, path: Path) -> Path:
        """The asset ROOT a serializer stores at — the folder for a folder-layout
        type even when ``asset_ref`` names the inner main file; the file
        otherwise. Inverse of ``asset_ref_for``."""
        return self.layout_of(path).root or path

    @property
    def effective_meta_model(self) -> Any:
        """The FS↔DB field-membership model for this type.

        A hand-written ``meta_model`` wins. Otherwise it is DERIVED from the
        type's ``asset_spec`` (what the asset file holds) ∪ its
        ``Persist.TRUE`` fields (what the shadow index must carry — the
        indexer-computed counts) ∪ ``BaseMeta``. One declaration: the class.
        Membership only, never strict validation (``base_meta.py``)."""
        if self.meta_model is not None:
            return self.meta_model
        if self.entity_cls is None or self.asset_spec is None:
            return None
        return _derived_meta_model(self.entity_cls, self.asset_spec)

    def serializer(self, origin: Any = None) -> Any:
        """The ``DataSerializer`` for ``origin`` (by its kind), else this type's
        default. HOW/WHERE is the serializer's; this type only names a default."""
        from flow_sdk.fs_store.serializer.registry import get_serializer  # noqa: PLC0415

        kind = getattr(origin, "kind", None) or self.default_origin_kind
        return get_serializer(kind, self)

    @property
    def folder_backed(self) -> bool:
        """True when ``asset_ref`` points at a browsable folder — a folder-layout
        type whose asset_ref is the bare folder (skill-style,
        ``main_file_is_asset_ref=False``), not the inner ``main_file``
        (spec-style). The Assets sidebar expands these rows into their on-disk
        file tree. Derived from the existing folder-layout fields so no type
        carries a redundant flag."""
        return self.main_layout == "folder" and not self.main_file_is_asset_ref

    def stable_key_for(self, ref) -> str | None:
        """The v5 key text for *ref*, or None when this type has no stable key.

        Types that only need "``<type>:<natural key>``" declare
        ``identity_key_fn``; ``id_stable_key_fn`` stays the escape hatch for a
        different shape. The derived text is byte-identical to the per-type
        ``*_stable_key`` helpers it replaced — v5 ids depend on it.
        """
        if self.id_stable_key_fn is not None:
            return self.id_stable_key_fn(ref)
        if self.identity_key_fn is not None:
            return f"{self.type_name}:{self.identity_key_fn(ref)}"
        return None

    @staticmethod
    def _identity_path(ref: Any) -> Path:
        """Return the concrete asset path accepted by identity callbacks."""
        return Path(getattr(ref, "_path", ref))

    def carrier_path_for(self, ref: Any) -> Path:
        """The file or folder this type's identity carrier lives in: the main
        markdown document for a frontmatter carrier (``<folder>/<main_file>`` on
        a folder type), the folder for a folder-json carrier, the file otherwise."""
        path = self._identity_path(ref)
        if isinstance(self.identity_carrier, FrontmatterCarrier) and self.folder_backed and self.main_file:
            root = self.storage_root_for(path)
            main = root / self.main_file
            return main if main.is_file() else root   # no main doc (a yaml-only skill): the folder carries
        return self.storage_root_for(path) if self.folder_backed else path

    def _read_carrier(self, ref: Any) -> "tuple[Path | None, CarrierId]":
        """The carrier path and what it holds; raises ``MalformedCarrier`` — a
        corrupt source must never be silently re-identified."""
        if self.identity_carrier is None:
            return None, CarrierId()
        path = self.carrier_path_for(ref)
        return path, self.identity_carrier.read(path)

    def read_id(self, ref: Any) -> str | None:
        """The valid id the source already carries, else None. Never writes —
        the probe collision ranking and create guards rely on."""
        return self._read_carrier(ref)[1].id

    def mint_entity_id(
        self,
        ref: Any,
        *,
        proposed_id: str | None = None,
        owner_id: str | None = None,
        live_ids: "Container[str] | None" = None,
    ) -> str:
        """**The** entity-id seam for a filesystem asset: read the carrier; if
        it names a live id that is the answer; else the owning row; else mint
        and write. Nothing else may mint.

        An asset's id lives in its source, but a full-content rewrite — what an
        agent does on every revision — can wipe that carrier. A carrier-less
        source is therefore not a new asset when a row already owns the path:
        it is that row, and its id is stamped back (``owner_id``). ``live_ids``
        is the liveness oracle for a carrier that names a DIFFERENT id: ``None``
        means "cannot prove dead", so the carrier wins; only the index walk,
        holding the complete per-type id set, may conclude a carrier is a fossil.

        Writes happen only when the carrier is writable, the ref is not
        ``read_only``, and carrier writes are not suppressed (a git-tracked
        source) — the same gates for every caller. A carrier that holds a
        present-but-invalid value (a hand-written v7) keeps its bytes and gets
        a stable path-derived v5. A legacy markdown capsule is converted into
        the frontmatter in place, id unchanged. Sync; never touches the DB.
        """
        from flow_sdk.fs_store.fs_record import carrier_writes_are_suppressed  # noqa: PLC0415
        from flow_sdk.fs_store.identity_carrier import LEGACY_CONVERTIBLE  # noqa: PLC0415

        if proposed_id is not None and not is_valid_entity_id(proposed_id):
            raise ValueError("proposed entity id must be a UUID v4 or v5")

        path, carrier = self._read_carrier(ref)
        can_write = (
            path is not None
            and self.identity_carrier.writable
            and not bool(getattr(ref, "read_only", False))
            and not carrier_writes_are_suppressed()
        )

        if carrier.id is not None and (
            owner_id is None or carrier.id == owner_id or live_ids is None or carrier.id in live_ids
        ):
            if carrier.source in LEGACY_CONVERTIBLE and can_write and hasattr(self.identity_carrier, "convert") and path.is_file():
                try:
                    self.identity_carrier.convert(path, carrier.id)  # type: ignore[union-attr]
                except OSError:
                    logging.debug("[asset-id] capsule→frontmatter conversion skipped for %s", path, exc_info=True)
            return carrier.id

        # An owning row wins over an absent or dead carrier — but never for a
        # derived identity, which is a pure function of the source (a stale row
        # on a rotated session path must not swallow a different session).
        if owner_id and self.identity_carrier is not None and self.identity_carrier.writable:
            if carrier.id is not None:
                logging.warning(
                    "[asset-id] %s carrier %r names no live entity; path is owned by %s (%s)",
                    self.type_name, carrier.id, owner_id, self._identity_path(ref),
                )
            elif carrier.raw is None and can_write:
                try:
                    self.identity_carrier.write_if_absent(path, owner_id)
                except OSError:
                    logging.debug("[asset-id] re-stamp skipped for %s", path, exc_info=True)
            return owner_id

        stable_key = self.stable_key_for(ref)
        fallback_key = str(self._identity_path(ref).resolve())
        if carrier.raw is not None:
            # Present but not a UUID we accept: keep the bytes, derive a stable
            # v5 until the source is repaired.
            return mint_uuid(stable_key or fallback_key, namespace=self.id_namespace)

        new_id = proposed_id or mint_uuid(stable_key, namespace=self.id_namespace)
        if can_write:
            try:
                return self.identity_carrier.write_if_absent(path, new_id)  # type: ignore[union-attr]
            except OSError:
                logging.debug("[asset-id] mint write failed for %s", path, exc_info=True)
        # Not written: only a keyed id is deterministic enough to be an answer;
        # a random v4 that lands nowhere would differ on every call.
        if proposed_id or stable_key:
            return new_id
        return mint_uuid(fallback_key, namespace=self.id_namespace)

    @property
    def _resolved_layout(self) -> "tuple[Any, Any, str | None]":
        """The ``(asset_class, harness, family)`` placement triple. ``(None, …)``
        for non-file-backed types (e.g. ``claude_md``, fixed filename)."""
        return (self.asset_class, self.harness, self.family)

    @property
    def main_subdir(self) -> str | None:
        """Derived, read-only: the canonical claude-default family subdir
        (``.claude/skills``, ``docs``, ``assets/datasets``). The compatibility
        view for the many consumers that still think in ``<scope>/<subdir>``; the
        harness-aware source of truth is the placement axis. ``None`` for
        non-file-backed types."""
        from flow_sdk.fs_store.placement import family_subdir  # noqa: PLC0415

        return family_subdir(self.asset_class, self.harness, self.family, default_worker="claude")

    @property
    def browseable_by_str(self) -> str | None:
        """``browseable_by`` as its serialized string value (or None) — the one
        wire form used by both ``schema_hash`` and ``to_dict``."""
        return self.browseable_by.value if self.browseable_by else None

    @property
    def schema_hash(self) -> str:
        """MD5 of structural fields as canonical JSON. Stable across runs."""
        payload = {
            "type_name": self.type_name,
            "uid_field": self.uid_field,
            "index_fields": sorted(self.index_fields),
            "defaults": self.defaults,
            "indexed_by_default": self.indexed_by_default,
            "browseable_by": self.browseable_by_str,
            "creatable": self.creatable,
            "api_visible": self.api_visible,
            "icon": self.icon,
            "parent_type": self.parent_type,
            "locations": sorted(self.locations),
            "capsules": [
                {"name": spec.name, "version": spec.version}
                for spec in sorted(self.capsules, key=lambda item: item.name)
            ],
        }
        return hashlib.md5(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:16]

    @property
    def type_id(self) -> "TypeId":
        from flow_sdk.fs_store.type_id import TypeId  # lazy — avoids circular at module load

        return TypeId(type=self.type_name)

    @property
    def extends(self) -> "TypeInfo | None":
        if self.parent_type is None:
            return None
        return SchemaRegistry.get(self.parent_type)

    @property
    def subtypes(self) -> list["TypeInfo"]:
        return SchemaRegistry.get_subtypes(self.type_name)

    def to_dict(self) -> dict:
        return {
            "type_name": self.type_name,
            "uid_field": self.uid_field,
            "index_fields": self.index_fields,
            "defaults": self.defaults,
            "indexed_by_default": self.indexed_by_default,
            "browseable_by": self.browseable_by_str,
            "creatable": self.creatable,
            "api_visible": self.api_visible,
            "cloud_file_transport": self.cloud_file_transport,
            "icon": self.icon,
            "display_name": self.display_name,
            "parent_type": self.parent_type,
            "locations": self.locations,
            "main_subdir": self.main_subdir,
            # The placement axis itself, so the client never re-derives a mount
            # from a hand-written table. ``main_subdir`` above is only the
            # claude-default VIEW of these three; the FE needs the class to know
            # whether a harness choice even applies (REPO/INTERNAL are
            # harness-less) and the family to build a non-default harness mount.
            "asset_class": str(self.asset_class) if self.asset_class else None,
            "harness": str(self.harness) if self.harness else None,
            "family": self.family,
            "main_layout": self.main_layout,
            "main_file": self.main_file,
            "main_file_is_asset_ref": self.main_file_is_asset_ref,
            "folder_backed": self.folder_backed,
            # The entity owns its backing file (re-rendered from default_body on
            # every save) → a resolved-but-file-missing row can self-heal with a
            # single save. The editor uses this to rebuild an orphaned asset.
            "owns_main_ref": self.owns_main_ref,
            # Reception seam — the FE reads these to render the receive CTA label
            # (``"<reception_verb> the <typeLabel>"``) and to know a type sets up
            # via a skill in Vibe.
            "setup_skill": self.setup_skill,
            "reception_verb": self.reception_verb,
            # ``auto`` types' chips navigate instead of opening the review modal.
            "receive_policy": self.receive_policy,
            "schema_hash": self.schema_hash,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "TypeInfo":
        return cls(
            type_name=data["type_name"],
            uid_field=data.get("uid_field", "id"),
            index_fields=data.get("index_fields", []),
            defaults=data.get("defaults", {}),
            indexed_by_default=data.get("indexed_by_default", False),
            browseable_by=ViewMode(data["browseable_by"]) if data.get("browseable_by") else None,
            creatable=data.get("creatable", False),
            api_visible=data.get("api_visible", False),
            cloud_file_transport=data.get("cloud_file_transport", "embedded"),
            icon=data.get("icon"),
            display_name=data.get("display_name"),
            parent_type=data.get("parent_type"),
            locations=data.get("locations", []),
        )


# ---------------------------------------------------------------------------
# SchemaRegistry
# ---------------------------------------------------------------------------


@cache
def _derived_meta_model(cls: type, spec: type) -> type:
    """``create_model(<Cls>Meta, __base__=BaseMeta, <spec ∪ Persist.TRUE fields>)``, once per class."""
    from pydantic import create_model  # noqa: PLC0415

    from flow_sdk.api.api_types.api_field import Persist, persist_policy  # noqa: PLC0415
    from flow_sdk.fs_store.serializer.fields import spec_layout  # noqa: PLC0415
    from flow_sdk.schema.type_info.base_meta import BaseMeta  # noqa: PLC0415

    # The body / free section are the DOCUMENT, not metadata: they never
    # enter the shadow (the body rides ``content`` for FTS instead).
    names = set(spec_layout(spec).header_fields)
    names |= {name for name, model_field in cls.model_fields.items() if persist_policy(model_field) == Persist.TRUE}
    # A header field the class marks Persist.FALSE (a DB-only payload such
    # as SourceItem.raw) is selected by the header but never mirrored.
    names -= {name for name, model_field in cls.model_fields.items() if persist_policy(model_field) == Persist.FALSE}
    names -= set(BaseMeta.model_fields) | {"id", "type"}
    return create_model(
        f"{cls.__name__}Meta",
        __base__=BaseMeta,
        **{name: (Optional[Any], None) for name in sorted(names)},
    )


def _core_compatible(spec: Any, entity: Any) -> bool:
    """Equal cores, or the entity NARROWS the spec's core (``str`` → ``TypeId`` /
    a ``StrEnum``), recursing through ``list[...]``. ``Any`` on the spec accepts all."""
    from flow_sdk.fs_store.serializer.fields import unwrap_annotation  # noqa: PLC0415

    if spec == entity or spec is Any:
        return True
    # ``typing.Dict[str, Any]`` and ``dict[str, Any]`` are one core: compare
    # origin and arguments, not the alias objects.
    s_origin, e_origin = get_origin(spec), get_origin(entity)
    if s_origin is not None and e_origin is not None:
        if s_origin is not e_origin:
            return False
        s_args, e_args = get_args(spec), get_args(entity)
        return len(s_args) == len(e_args) and all(
            _core_compatible(unwrap_annotation(a), unwrap_annotation(b)) for a, b in zip(s_args, e_args)
        )
    # One side bare (``dict``), the other parameterised (``dict[str, Any]``):
    # compare the base classes.
    s_base, e_base = s_origin or spec, e_origin or entity
    if not (isinstance(s_base, type) and isinstance(e_base, type)):
        return False
    # A string on disk may be held as a ``str`` subclass (a ``StrEnum``) or a
    # custom type that validates from one (``TypeId`` declares its own pydantic
    # schema) — the row narrows. Not an ``int`` or a ``dict``.
    if s_base is str:
        return issubclass(e_base, str) or hasattr(e_base, "__get_pydantic_core_schema__")
    return issubclass(e_base, s_base)


def check_asset_spec(type_name: str, entity_cls: type, spec: type) -> None:
    """Every spec field is an entity field with a compatible core type. The
    spec is the lenient DISK form; the entity may narrow. Raises ``TypeError``
    naming the field — at registration, not on the first save."""
    from flow_sdk.fs_store.serializer.fields import (  # noqa: PLC0415
        FieldKind,
        asset_class,
        asset_info,
        field_kinds,
        unwrap_annotation,
    )

    entity_fields = getattr(entity_cls, "model_fields", {})
    kinds = dict(field_kinds(spec))
    for name, spec_field in spec.model_fields.items():
        if name not in entity_fields:
            raise TypeError(f"{type_name}: asset_spec field {name!r} is not a field of {entity_cls.__name__}")
        want = unwrap_annotation(spec_field.annotation)
        got = unwrap_annotation(entity_fields[name].annotation)
        if not _core_compatible(want, got):
            raise TypeError(f"{type_name}.{name}: asset_spec declares {want!r} but {entity_cls.__name__} holds {got!r}")
        if kinds[name] is FieldKind.SUB_ASSET_LIST:
            # A list of assets is a directory of FILES, one per element — a
            # class-shape fact, refused here rather than on the first save.
            sub_cls, _ = asset_class(spec_field.annotation)
            if asset_info(sub_cls).main_layout != "file":
                raise TypeError(f"{type_name}.{name}: a list of {sub_cls.__name__} is a directory of files, but {sub_cls.__name__} is folder-layout")


#: The TypeInfo slots the serializers read (``metadata={"serialization": True}``); merged by "non-default wins".
_SERIALIZATION_SLOTS = tuple(f for f in fields(TypeInfo) if f.metadata.get("serialization"))


class SchemaRegistry:
    """Unified type registry + scan/index orchestration."""

    _types: ClassVar[dict[str, TypeInfo]] = {}
    # kind → a class or a DataSpec. Lives HERE, not in a second registry: a kind
    # is a name in the same namespace type names draw from, and one lookup
    # table is the standing rule. Runtime-only, like ``entity_cls`` — not part
    # of ``to_dict()`` or the schema hash. A miss is None, never a mint.
    _kinds: ClassVar[dict[str, Any]] = {}
    _kind_of_shape: ClassVar[dict[int, str]] = {}   # id(shape) → kind; the O(1) inverse
    _subtypes: ClassVar[dict[str, list[str]]] = {}
    _default_index_types: ClassVar[list[str]] = []
    # Whether the declarative type-info registrations have run in this process.
    _loaded: ClassVar[bool] = False

    # Backward compat: direct class attribute access for default_index_types
    default_index_types: ClassVar[list[str]] = _BUILTIN_DEFAULT_TYPES

    # ---------------------------------------------------------------------------
    # Lazy initialization
    # ---------------------------------------------------------------------------

    @classmethod
    def _ensure_loaded(cls) -> None:
        """Populate the registry on first read.

        Entity types self-register on import (``__init_subclass__``), but the
        declarative *metadata* types only register when ``register_all()`` runs.
        Rather than require every process (CLI, SDK script, indexer, backend) to
        remember to call it, run it lazily the first time the registry is read —
        once per process. ``register_all()`` is idempotent, so a later explicit
        call (e.g. at server startup) is harmless.
        """
        if cls._loaded:
            return
        # Set the flag BEFORE running register_all: it calls register() many
        # times, which must not re-enter this loader.
        cls._loaded = True
        try:
            from flow_sdk.schema.data_spec._kinds import register_builtin_kinds  # lazy: avoid import cycle
            from flow_sdk.schema.type_info import register_all  # lazy: avoid import cycle

            register_all()
            register_builtin_kinds()
        except Exception:
            cls._loaded = False  # let the next access retry rather than wedge
            raise

    # ---------------------------------------------------------------------------
    # Registration
    # ---------------------------------------------------------------------------

    @classmethod
    def register_kind(cls, kind: str, shape: Any) -> None:
        """Bind a kind to a class or a ``DataSpec`` so a bare kind can name it."""
        from flow_sdk.schema.data_spec._kinds import PRIMITIVES  # noqa: PLC0415
        from flow_sdk.tags.grammar import normalize_tag  # noqa: PLC0415

        kind = normalize_tag(kind)
        if kind in PRIMITIVES:
            raise ValueError(f"{kind!r} is a reserved primitive and cannot be registered")
        cls._kinds[kind] = shape
        cls._kind_of_shape[id(shape)] = kind

    @classmethod
    def kind_for(cls, shape: Any) -> "str | None":
        """The kind a class is registered under, or None. Inverse of ``kind_type``."""
        cls._ensure_loaded()
        return cls._kind_of_shape.get(id(shape))

    @classmethod
    def kind_type(cls, kind: str) -> Any:
        """The class or ``DataSpec`` a kind names, or None (anonymous — not an
        error). Entity type names resolve through the same table: ONE namespace."""
        cls._ensure_loaded()
        hit = cls._kinds.get(kind)
        if hit is not None:
            return hit
        info = cls._types.get(kind)
        return info.entity_cls if info is not None else None

    @classmethod
    def register_crud_type(cls, type_name: str, *, icon: str | None = None) -> None:
        """Register a CRUD-only type that has no indexer walker.

        Such types (e.g. ``claude_error``, ``claude_debug_log``) are produced
        on demand and exist only so the fs-records routes accept them
        (GET returns an empty list instead of 400). They are never auto-indexed,
        browseable, or creatable.
        """
        cls.register(
            TypeInfo(
                type_name=type_name,
                icon=icon,
                indexed_by_default=False,
                browseable_by=None,
                creatable=False,
            )
        )

    @classmethod
    def register(cls, info: TypeInfo) -> None:
        """Register or enrich a TypeInfo. O(1). Idempotent — merges on re-register."""
        existing = cls._types.get(info.type_name)
        if existing is not None:
            for loc in info.locations:
                if loc not in existing.locations:
                    existing.locations.append(loc)
            # Placement axis — enrich from whichever registration declares it
            # (schema/type_info is the authoring home; entity/indexer modules
            # register the same type first without these fields).
            if info.asset_class is not None:
                existing.asset_class = info.asset_class
            if info.harness is not None:
                existing.harness = info.harness
            if info.family is not None:
                existing.family = info.family
            if info.main_layout != "file":
                existing.main_layout = info.main_layout
            if info.main_file is not None:
                existing.main_file = info.main_file
            if info.main_file_is_asset_ref:
                existing.main_file_is_asset_ref = True
            if info.main_ext != ".md":
                existing.main_ext = info.main_ext
            if info.cloud_file_transport == "git":
                existing.cloud_file_transport = "git"
            if info.assignee_owned_fields:
                existing.assignee_owned_fields = tuple(info.assignee_owned_fields)
            if info.pack_exclude:
                existing.pack_exclude = tuple(info.pack_exclude)
            if info.post_sync_fn is not None:
                existing.post_sync_fn = info.post_sync_fn
            if info.from_disk_fn is not None:
                existing.from_disk_fn = info.from_disk_fn
            if info.capsules:
                merged_capsules = {spec.name: spec for spec in existing.capsules}
                for spec in info.capsules:
                    current = merged_capsules.get(spec.name)
                    if current is not None and current != spec:
                        raise ValueError(
                            f"Conflicting capsule declaration for type {info.type_name!r}: {current!r} vs {spec!r}"
                        )
                    merged_capsules[spec.name] = spec
                existing.capsules = tuple(merged_capsules[name] for name in sorted(merged_capsules))
            if info.identity_carrier is not None:
                if existing.identity_carrier is not None and existing.identity_carrier != info.identity_carrier:
                    raise ValueError(f"Conflicting identity carrier registration for type {info.type_name!r}")
                existing.identity_carrier = info.identity_carrier
            if info.id_stable_key_fn is not None:
                existing.id_stable_key_fn = info.id_stable_key_fn
            # Both key spellings must survive a re-registration. Dropping this
            # one silently reverts the type to the `uuid5(resolved path)`
            # fallback — an id that moves with the install (FLOWPAD-2070).
            if info.identity_key_fn is not None:
                existing.identity_key_fn = info.identity_key_fn
            if info.id_namespace != uuid.NAMESPACE_URL:
                existing.id_namespace = info.id_namespace
            if info.asset_hash_fn is not None:
                existing.asset_hash_fn = info.asset_hash_fn
            if info.default_body_fn is not None:
                existing.default_body_fn = info.default_body_fn
            if info.owns_main_ref:
                existing.owns_main_ref = True
            if info.parent_share_on_default:
                existing.parent_share_on_default = True
            if info.shared_child:
                existing.shared_child = True
            if info.db_only:
                existing.db_only = True
            if info.metadata is not None:
                existing.metadata = info.metadata
            if info.meta_model is not None:
                existing.meta_model = info.meta_model
            # Serialization slots: a declared (non-default) value wins the merge.
            for slot in _SERIALIZATION_SLOTS:
                value = getattr(info, slot.name)
                if value != slot.default:
                    setattr(existing, slot.name, value)
            if info.entity_cls is not None:
                if existing.entity_cls is None:
                    existing.entity_cls = info.entity_cls
                elif existing.entity_cls is not info.entity_cls:
                    existing_fqn = f"{existing.entity_cls.__module__}.{existing.entity_cls.__name__}"
                    new_fqn = f"{info.entity_cls.__module__}.{info.entity_cls.__name__}"
                    if existing_fqn != new_fqn:
                        raise ValueError(
                            f"Duplicate entity registration for type '{info.type_name}': "
                            f"'{existing_fqn}' vs '{new_fqn}'. "
                            f"Each entity type name must map to exactly one class."
                        )
            if info.icon is not None:
                existing.icon = info.icon
            if info.display_name is not None:
                existing.display_name = info.display_name
            if info.setup_skill is not None:
                existing.setup_skill = info.setup_skill
            if info.reception_verb != "Open":
                existing.reception_verb = info.reception_verb
            if info.receive_policy is not None:
                existing.receive_policy = info.receive_policy
            if info.receive_row_overrides is not None:
                existing.receive_row_overrides = info.receive_row_overrides
            if info.creatable and not existing.creatable:
                existing.creatable = True
            if info.browseable_by is not None and (
                existing.browseable_by is None
                or view_mode_rank(info.browseable_by) < view_mode_rank(existing.browseable_by)
            ):
                # Keep the more permissive (lower-ordered) non-null level.
                existing.browseable_by = info.browseable_by
            if info.indexed_by_default and not existing.indexed_by_default:
                existing.indexed_by_default = True
            if info.api_visible and not existing.api_visible:
                existing.api_visible = True
            if info.index_fields:
                existing.index_fields = list(info.index_fields)
            if info.defaults:
                existing.defaults = {**existing.defaults, **info.defaults}
            info = existing
        else:
            cls._types[info.type_name] = info

        if info.parent_type:
            cls._subtypes.setdefault(info.parent_type, [])
            if info.type_name not in cls._subtypes[info.parent_type]:
                cls._subtypes[info.parent_type].append(info.type_name)

        if info.indexed_by_default and info.type_name not in cls._default_index_types:
            cls._default_index_types.append(info.type_name)
        final = cls._types[info.type_name]
        if final.from_disk_fn is None and final.asset_spec is not None and not final.db_only:
            from flow_sdk.fs_store.serializer.record import spec_extractor  # noqa: PLC0415

            final.from_disk_fn = spec_extractor(info.type_name)   # the spec IS the parser
        if info.asset_spec is not None:
            from flow_sdk.fs_store.serializer.fields import field_kinds  # noqa: PLC0415

            field_kinds.cache_clear()   # a new asset type can turn a field into a sub-asset

    @classmethod
    def check_asset_specs(cls) -> None:
        """The shape and the row must agree — run once every class is complete
        (``register_all``'s post-pass), never from an entity's ``__init_subclass__``.
        A violation RAISES; it is a class-shape bug, not a degraded type."""
        for info in cls._types.values():
            if info.asset_spec is not None and info.entity_cls is not None:
                check_asset_spec(info.type_name, info.entity_cls, info.asset_spec)

    @classmethod
    def get(cls, type_name: "str | TypeId") -> TypeInfo | None:
        cls._ensure_loaded()
        if not isinstance(type_name, str):
            type_name = type_name.type  # TypeId duck-type: .type is the type string
        return cls._types.get(type_name)

    @classmethod
    def get_subtypes(cls, type_name: str) -> list[TypeInfo]:
        cls._ensure_loaded()
        names = cls._subtypes.get(type_name, [])
        return [cls._types[n] for n in names if n in cls._types]

    @classmethod
    def get_all_types(cls) -> list[str]:
        cls._ensure_loaded()
        return list(cls._types.keys())

    @classmethod
    def browseable_type_names(cls) -> list[str]:
        """Every type that has its own asset-tree root (``browseable_by`` set).

        The containment predicate both tiers share: an asset whose parent is one
        of THESE is already reachable under that parent's row, so it is not a
        top-level row of its own type. ``project`` is deliberately absent — it
        has no tree root, so a project's assets have nowhere else to show and
        stay top-level. See ``apply_containment_filter``.
        """
        cls._ensure_loaded()
        return [k for k, v in cls._types.items() if v.browseable_by is not None]

    @classmethod
    def get_entity_cls(cls, type_name: str) -> type | None:
        info = cls.get(type_name)
        return info.entity_cls if info else None

    @classmethod
    def is_entity_type(cls, type_name: str) -> bool:
        info = cls.get(type_name)
        return bool(info and info.entity_cls is not None)

    @classmethod
    def is_implemented(cls, type_name: str) -> bool:
        return cls.is_entity_type(type_name)

    @classmethod
    def is_public_entity(cls, type_name: str) -> bool:
        info = cls.get(type_name)
        return bool(info and info.entity_cls is not None and info.api_visible)

    @classmethod
    def get_all_entity_types(cls) -> list[str]:
        cls._ensure_loaded()
        return [k for k, v in cls._types.items() if v.entity_cls is not None]

    @classmethod
    def get_all_entity_classes(cls) -> list[type]:
        cls._ensure_loaded()
        return [v.entity_cls for v in cls._types.values() if v.entity_cls is not None]

    @classmethod
    def get_shared_child_types(cls) -> list[str]:
        """Hub-hosted ``is_child`` type names the shared-context catch-up should pull.

        Registry-driven companion to the live bridge (which materializes any child
        generically): the catch-up sync iterates this list instead of a hardcoded
        tuple, so a new shareable child type enrolls by setting ``shared_child=True``
        on its ``TypeMetadata`` — no edit to the sync code.
        """
        cls._ensure_loaded()
        return [k for k, v in cls._types.items() if v.entity_cls is not None and v.shared_child]

    @classmethod
    def repo_family_to_info(cls) -> "dict[str, TypeInfo]":
        """Map a repo asset's ``<type>`` subdir (its ``family``) → its ``TypeInfo``
        — the reverse of the ``agentic-assets/<family>`` mount. The SINGLE owner of
        the ``asset_class == REPO`` predicate; a type enrolls by declaring
        ``asset_class="repo"`` (and a ``family``). The indexer walker reads this
        directly (it needs each type's layout + marker), and the name/type-only
        views below derive from it so the predicate lives in one place."""
        from flow_sdk.fs_store.placement import AssetClass  # noqa: PLC0415

        cls._ensure_loaded()
        return {v.family: v for v in cls._types.values() if v.asset_class == AssetClass.REPO and v.family}

    @classmethod
    def repo_family_to_type(cls) -> dict[str, str]:
        """Family → type-name view of ``repo_family_to_info``."""
        return {fam: info.type_name for fam, info in cls.repo_family_to_info().items()}

    @classmethod
    def get_repo_types(cls) -> list[str]:
        """Type names whose assets live in the recursive ``agentic-assets/<type>``
        hierarchy (repo types must declare a ``family`` to be placeable at all)."""
        return [info.type_name for info in cls.repo_family_to_info().values()]

    @classmethod
    def harness_scoped_families(cls) -> frozenset[str]:
        """Every family that mounts inside a harness dot-dir (``skills``,
        ``agents``, ``commands``, ``rules``, ``workflows``).

        The mirror of ``repo_family_to_info`` for the other half of the layout
        space, and the SINGLE owner of the ``harness_scoped`` predicate. Walkers
        that need "is this path already claimed by a typed indexer?" ask here
        rather than hand-listing directory names — a type enrolls by declaring
        its ``asset_class``, so the answer cannot drift behind the registry.
        """
        from flow_sdk.fs_store.placement import LAYOUT_REGISTRY  # noqa: PLC0415

        cls._ensure_loaded()
        return frozenset(
            v.family
            for v in cls._types.values()
            if v.asset_class and v.family and LAYOUT_REGISTRY[v.asset_class].harness_scoped
        )

    @classmethod
    def get_public_entity_types(cls) -> list[str]:
        cls._ensure_loaded()
        return [k for k, v in cls._types.items() if v.entity_cls is not None and v.api_visible]

    # --- Presentation read-through getters (registry is the single source) ---

    @classmethod
    def is_api_visible(cls, type_name: str) -> bool:
        info = cls.get(type_name)
        return bool(info and info.api_visible)

    @classmethod
    def get_icon(cls, type_name: str) -> str | None:
        info = cls.get(type_name)
        return info.icon if info else None

    @classmethod
    def get_display_name(cls, type_name: str) -> str:
        """UX-friendly label for a type — curated ``TypeInfo.display_name`` when set,
        else the generic title-caser ``humanize_type`` (parity with the frontend
        ``humanizeType`` fallback)."""
        info = cls.get(type_name)
        if info and info.display_name:
            return info.display_name
        return humanize_type(type_name)

    @classmethod
    def browseable_by(cls, type_name: str) -> ViewMode | None:
        """Minimum view mode at which ``type_name`` is browseable (None ⇒ never)."""
        info = cls.get(type_name)
        return info.browseable_by if info else None

    @classmethod
    def is_browseable_in(cls, type_name: str, mode: ViewMode) -> bool:
        """True iff ``type_name`` is browseable in the given view ``mode`` (cumulative)."""
        return visible_in(cls.browseable_by(type_name), mode)

    @classmethod
    def is_creatable(cls, type_name: str) -> bool:
        info = cls.get(type_name)
        return bool(info and info.creatable)

    @classmethod
    def is_indexed_by_default(cls, type_name: str) -> bool:
        info = cls.get(type_name)
        return bool(info and info.indexed_by_default)

    @classmethod
    def get_all_record_types(cls) -> list[str]:
        cls._ensure_loaded()
        return [k for k, v in cls._types.items() if v.entity_cls is not None]

    @classmethod
    def get_default_index_types(cls) -> list[str]:
        """Return authoritative list of default-indexed type names."""
        cls._ensure_loaded()
        if cls._default_index_types:
            return list(cls._default_index_types)
        return list(_BUILTIN_DEFAULT_TYPES)

    # ---------------------------------------------------------------------------
    # Logging methods
    # ---------------------------------------------------------------------------

    @staticmethod
    def append_scan(
        trigger: str,
        duration_ms: float,
        total_records: int,
        total_bytes: int,
        types: list[dict[str, Any]],
        type_name: str | None = None,
    ) -> str:
        """Log a scan operation. Returns the ISO timestamp written."""
        now = datetime.now(timezone.utc).isoformat()

        if type_name:
            entry = {
                "id": str(uuid.uuid4()),
                "type": "scan_log",
                "scan_trigger": trigger,
                "duration_ms": duration_ms,
                "total_records": total_records,
                "total_bytes": total_bytes,
                "type_name": type_name,
                "created_at": now,
            }
            sanitized = _sanitize_type_name(type_name)
            _append_jsonl(_schema_dir() / "types" / sanitized / "scan_log.jsonl", entry)
        else:
            global_entry = {
                "id": str(uuid.uuid4()),
                "type": "scan_log",
                "scan_trigger": trigger,
                "duration_ms": duration_ms,
                "total_records": total_records,
                "total_bytes": total_bytes,
                "types": types,
                "created_at": now,
            }
            _append_jsonl(_schema_dir() / "scan_log.jsonl", global_entry)
            for t in types:
                t_name = t.get("type", "")
                if not t_name:
                    continue
                t_entry = {
                    "id": str(uuid.uuid4()),
                    "type": "scan_log",
                    "scan_trigger": trigger,
                    "duration_ms": t.get("scan_ms", 0.0),
                    "total_records": t.get("count", 0),
                    "total_bytes": t.get("total_bytes", 0),
                    "type_name": t_name,
                    "created_at": now,
                }
                sanitized = _sanitize_type_name(t_name)
                _append_jsonl(_schema_dir() / "types" / sanitized / "scan_log.jsonl", t_entry)

        return now

    @staticmethod
    def append_index(
        trigger: str,
        duration_ms: float,
        total_indexed: int,
        types: list[dict[str, Any]],
        type_name: str | None = None,
    ) -> str:
        """Log an index operation. Returns the ISO timestamp written.

        Per-type log only — the "global" timestamp is derived in
        ``get_index_status`` as ``max(per_type[i].last_indexed_at)``. This
        means per-type indexing (e.g. UI's "Index Now" loop) automatically
        flips ``never_indexed`` to false without needing a separate global
        write call.
        """
        now = datetime.now(timezone.utc).isoformat()

        if type_name:
            entry = {
                "id": str(uuid.uuid4()),
                "type": "index_log",
                "index_trigger": trigger,
                "duration_ms": duration_ms,
                "total_indexed": total_indexed,
                "type_name": type_name,
                "created_at": now,
            }
            sanitized = _sanitize_type_name(type_name)
            _append_jsonl(_schema_dir() / "types" / sanitized / "index_log.jsonl", entry)
        else:
            for t in types:
                t_name = t.get("type", "")
                if not t_name:
                    continue
                t_entry = {
                    "id": str(uuid.uuid4()),
                    "type": "index_log",
                    "index_trigger": trigger,
                    # The caller's per-type dict already carries a measured
                    # duration (``types_out`` in fs_records_actions); reading
                    # ``indexed`` from it while writing a literal 0.0 here left
                    # every aggregate run's audit trail timeless.
                    "duration_ms": t.get("duration_ms", 0.0),
                    "total_indexed": t.get("indexed", 0),
                    "type_name": t_name,
                    "created_at": now,
                }
                sanitized = _sanitize_type_name(t_name)
                _append_jsonl(_schema_dir() / "types" / sanitized / "index_log.jsonl", t_entry)

        return now

    @staticmethod
    def get_last_scan_at(type_name: str) -> str | None:
        sanitized = _sanitize_type_name(type_name)
        entry = _read_last_entry(_schema_dir() / "types" / sanitized / "scan_log.jsonl")
        return (entry or {}).get("created_at")

    @staticmethod
    def get_last_index_at(type_name: str) -> str | None:
        sanitized = _sanitize_type_name(type_name)
        entry = _read_last_entry(_schema_dir() / "types" / sanitized / "index_log.jsonl")
        return (entry or {}).get("created_at")

    # ---------------------------------------------------------------------------
    # Internal helpers
    # ---------------------------------------------------------------------------

    @classmethod
    async def clear_index(cls, types: list[str] | None = None) -> ClearResult:
        from flow_sdk.db import get_db_driver  # noqa: PLC0415
        from flow_sdk.fs_store.operations.record_error import clear_all, clear_for_type  # noqa: PLC0415

        driver = get_db_driver()
        if types is None:
            fts_cleared = await driver.fts_clear() if hasattr(driver, "fts_clear") else 0
            entities_cleared = (
                await driver.delete_entities_by_type(None) if hasattr(driver, "delete_entities_by_type") else 0
            )
            global_log = _schema_dir() / "index_log.jsonl"
            if global_log.exists():
                global_log.unlink()
            types_dir = _schema_dir() / "types"
            if types_dir.is_dir():
                for per_type_log in types_dir.glob("*/index_log.jsonl"):
                    per_type_log.unlink()
            types_cleared = cls.get_all_record_types()
            await clear_all()
        else:
            fts_cleared = 0
            entities_cleared = 0
            types_cleared = []
            for type_name in types:
                if hasattr(driver, "delete_entities_by_type"):
                    entities_cleared += await driver.delete_entities_by_type(type_name)
                sanitized = _sanitize_type_name(type_name)
                log_file = _schema_dir() / "types" / sanitized / "index_log.jsonl"
                if log_file.exists():
                    log_file.unlink()
                types_cleared.append(type_name)
                await clear_for_type(type_name)
        return ClearResult(
            fts_cleared=fts_cleared,
            entities_cleared=entities_cleared,
            types_cleared=types_cleared,
        )

    # New name alias
    clear = clear_index

    @classmethod
    async def get_index_status(
        cls,
        types: list[str] | None = None,
        scope: "object | None" = None,
    ) -> IndexStatus:
        """Snapshot of index state. DB-free for freshness.

        * **Project scope** (``scope.projects == [one id]``) — the project IS a
          record, so its three states come from the project record's own
          on-disk ``.hash`` sentinel: ``never_indexed`` = no sentinel,
          ``last_indexed_at`` = the sentinel time, ``stale`` = ``index_required``
          ("changes pending"). No child aggregation.
        * **Unscoped / type list** — footer/scanner view. ``last_indexed_at``
          per type from the JSONL run-history (audit); ``entity_count`` from
          ``count_entities_by_type`` (the live searchable count).

        ``stale`` now means "changes pending next index", not a 24h timer.
        Orphan counts come from a scan, not from here.
        """
        import asyncio  # noqa: PLC0415

        from flow_sdk.db import get_db_driver  # noqa: PLC0415
        from flow_sdk.fs_store.fs_record import FSRecord  # noqa: PLC0415

        driver = get_db_driver()
        per_type: list[TypeIndexStatus] = []
        latest_iso: str | None = None
        target_types = list(types or cls.get_default_index_types())

        # `stale` is the endpoint's documented contract — "changes pending next
        # index" — and it used to be the literal False on every row, so the
        # freshness signal could never be true outside the single-project
        # branch below. It is now the same question that branch asks
        # (`index_required`), asked per type. `orphan_count` stays 0 by design:
        # orphans come from a scan, not from here.
        # One thread hop for the whole sweep, not one per type: the walk never
        # yields to the loop between types, so 30+ dispatches bought nothing.
        def _stale_by_type() -> dict[str, bool]:
            return {t: FSRecord.type_has_pending_changes(t) for t in target_types}

        stale_by_type = await asyncio.to_thread(_stale_by_type)
        nested = await cls._nested_counts(driver, scope)

        for type_name in target_types:
            type_last = cls.get_last_index_at(type_name)  # JSONL run-history (audit)
            if type_last and (latest_iso is None or type_last > latest_iso):
                latest_iso = type_last
            count = await cls._safe_count(driver, type_name, scope, nested)
            per_type.append(
                TypeIndexStatus(
                    type_name=type_name,
                    last_indexed_at=type_last,
                    entity_count=count,
                    stale=stale_by_type.get(type_name, False),
                    orphan_count=0,
                )
            )

        # Project-scoped freshness from the project record's own sentinel.
        project_id = cls._single_project_id(scope)
        if project_id is not None:
            prec = cls._project_record_for_status(project_id)
            indexed_at = prec.indexed_at if prec is not None else None
            return IndexStatus(
                never_indexed=indexed_at is None,
                last_indexed_at=indexed_at,
                stale=bool(prec.index_required) if prec is not None else False,
                default_types=cls.get_default_index_types(),
                per_type=per_type,
                total_orphans=0,
            )

        return IndexStatus(
            never_indexed=all(t.last_indexed_at is None for t in per_type),
            last_indexed_at=latest_iso,
            # Rolled up from the per-type answers rather than hardcoded.
            stale=any(t.stale for t in per_type),
            default_types=cls.get_default_index_types(),
            per_type=per_type,
            total_orphans=0,
        )

    @staticmethod
    async def _safe_count(
        driver,
        type_name: str,
        scope: "object | None",
        nested: "dict[str, int] | None" = None,
    ) -> int:
        """Per-type live count, tolerant of a driver whose
        ``count_entities_by_type`` predates the ``scope`` kwarg. Shared by
        ``get_index_status`` and ``get_asset_stats`` so there is one counting
        path, not two.

        ``nested`` (from ``_nested_counts``) is subtracted so the badge agrees
        with the list the user actually sees: ``/search?top_level=true`` drops
        assets nested inside another browseable asset, and a count that still
        included them would read 8 over a 4-row list. Clamped at 0 — the two
        queries are separate reads, so a concurrent write must not go negative.
        """
        try:
            total = await driver.count_entities_by_type(type_name, scope=scope)
        except TypeError:
            total = await driver.count_entities_by_type(type_name)
        except Exception:
            return 0
        return max(0, total - (nested or {}).get(type_name, 0))

    @classmethod
    async def _nested_counts(cls, driver, scope: "object | None") -> dict[str, int]:
        """Per-type count of rows nested inside a browseable asset, or ``{}``.

        Fetched ONCE per status/stats call (one grouped query), not per type.
        Fails soft to ``{}`` — a driver without the method, or a query error,
        degrades to today's raw counts rather than blanking the sidebar.
        """
        try:
            return await driver.count_nested_entities_by_type(
                tuple(cls.browseable_type_names()), scope=scope
            )
        except Exception:
            return {}

    @classmethod
    async def get_asset_stats(cls, scope: "object | None" = None) -> AssetStats:
        """Live per-type asset counts for a ScopeFilter, over the registry's
        default index types (P5 — derived, not hardcoded). Counts only; reuses
        the same per-type count path as ``get_index_status``."""
        from flow_sdk.db import get_db_driver  # noqa: PLC0415

        driver = get_db_driver()
        nested = await cls._nested_counts(driver, scope)
        per_type = {
            str(type_name): await cls._safe_count(driver, type_name, scope, nested)
            for type_name in cls.get_default_index_types()
        }
        return AssetStats(per_type=per_type, total=sum(per_type.values()))

    @staticmethod
    def _single_project_id(scope: "object | None") -> str | None:
        """The lone project id when ``scope`` targets exactly one project, else None."""
        projects = list(getattr(scope, "projects", None) or []) if scope is not None else []
        return projects[0] if len(projects) == 1 else None

    @classmethod
    def project_never_indexed(cls, project_id: str) -> bool:
        """True when this project has no index sentinel on disk.

        The per-project form of ``get_index_status``'s project branch, which
        cannot serve a caller holding SEVERAL projects: ``_single_project_id``
        returns None the moment a scope names more than one, so a multi-project
        view (e.g. a project plus its context folders) has to ask per project.

        Pure filesystem read (``FSRecord.indexed_at``) — no DB, no write, no walk.
        """
        prec = cls._project_record_for_status(project_id)
        return prec is None or getattr(prec, "indexed_at", None) is None

    @staticmethod
    def _project_record_for_status(project_id: str) -> "object | None":
        """Load the project record with its asset_ref bound to the project
        folder, so ``indexed_at`` / ``index_required`` resolve. None if the
        record (or its mount path) is unknown."""
        from flow_sdk.fs_store.fs_record import FSRecord  # noqa: PLC0415

        prec = FSRecord.load_or_none("project", project_id)
        return prec.ensure_asset_ref() if prec is not None else None

    # New name alias
    get_status = get_index_status

    @classmethod
    def get_errors(cls, type_name: "str | TypeId | None" = None) -> list:
        from flow_sdk.fs_store.fs_record import FSRecord  # noqa: PLC0415
        from flow_sdk.fs_store.record_types import RecordType  # noqa: PLC0415

        results = FSRecord.discover(RecordType.RECORD_ERROR)
        if type_name is not None:
            if not isinstance(type_name, str):
                type_name = type_name.type
            results = [
                e
                for e in results
                if e.__dict__.get("source_record_type") == type_name or getattr(e, "type", None) == type_name
            ]
        return results
