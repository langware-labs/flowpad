"""SchemaRegistry — unified type system for Record + Entity layers.

Index-run bookkeeping (scan/index logs, index status, scan issues) lives in
``flow_sdk.fs_store.indexer.index_log``, not here.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import stat
import uuid
from collections.abc import Container
from dataclasses import MISSING, dataclass, field, fields
from functools import cache
from pathlib import Path
from typing import Any, Callable, ClassVar, Literal, Optional, get_args, get_origin

from flow_sdk.api.api_types.identifier import is_valid_entity_id, mint_uuid
from flow_sdk.capsules import CapsuleSpec
from flow_sdk.fs_store.identity_carrier import (
    LEGACY_CONVERTIBLE,
    Absent,
    Derived,
    ForeignId,
    Found,
    IdentityCarrier,
    NotWritable,
    UnclaimedPath,
    Unstamped,
)
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.schema.layout import (  # noqa: F401 — Layout/LayoutKind re-exported
    File,
    Folder,
    Layout,
    LayoutKind,
    Walk,
    shape_from_dict,
)
from flow_sdk.schema.view_mode import ViewMode, view_mode_rank, visible_in

# ---------------------------------------------------------------------------
# Hardcoded fallback list so get_default_index_types() works before any
# Record subclass has registered itself as indexed_by_default.
# ---------------------------------------------------------------------------

_BUILTIN_DEFAULT_TYPES: list[str] = [
    # Bootstrap fallback only: the types ``get_default_index_types()`` answers
    # before any type has registered itself as ``indexed_by_default``. The set
    # the indexer actually writes is derived from its walker graph
    # (``flow_sdk.fs_store.indexer.builtin.indexable_types``), not kept in
    # step with this list. Runtime-only types like BOOKMARK, ANNOTATION,
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


#: A field tagged ``merge`` is carried onto an existing registration by
#: "non-default wins"; the untagged fields have bespoke rules in ``register``.
_MERGE = {"merge": True}
_DEFAULT_SHAPE = File(ext=".md")


def _may_write(ref: Any) -> bool:
    """Carrier writes are allowed for ``ref``: it is not read-only and no
    suppression context (a git working tree) is active."""
    from flow_sdk.fs_store.fs_record import carrier_writes_are_suppressed  # noqa: PLC0415

    return not bool(getattr(ref, "read_only", False)) and not carrier_writes_are_suppressed()


@dataclass
class TypeInfo:
    """Metadata for a single record/entity type."""

    # --- Structural fields (included in hash, persisted) ---
    type_name: str
    uid_field: str = "id"
    index_fields: list[str] = field(default_factory=list, metadata=_MERGE)
    defaults: dict[str, Any] = field(default_factory=dict)
    indexed_by_default: bool = field(default=False, metadata=_MERGE)
    # Minimum view mode at which this type is browseable (None ⇒ never). See
    # flow_sdk/schema/view_mode.py — visibility is cumulative.
    browseable_by: ViewMode | None = None
    creatable: bool = field(default=False, metadata=_MERGE)
    api_visible: bool = field(default=False, metadata=_MERGE)
    icon: str | None = field(default=None, metadata=_MERGE)
    parent_type: str | None = None
    locations: list[str] = field(default_factory=list)
    # UX-friendly label for the type (e.g. "Skills"). Presentational, surfaced to
    # the FE via ``to_dict``; deliberately NOT in ``schema_hash`` so relabeling a
    # type never forces a reindex. Read through ``get_display_name`` (falls back to
    # ``humanize_type``).
    display_name: str | None = field(default=None, metadata=_MERGE)

    # --- Runtime refs (NOT in hash, NOT persisted) ---
    entity_cls: type | None = field(default=None, compare=False, repr=False)
    # The type's SHAPE — the ``DataSpec`` whose fields (and field TYPES) are
    # what the medium persists: frontmatter scalars, a ``Body``, a
    # ``FreeSection``, ``FileRef``s, rows, sub-assets. None ⇒ the legacy path
    # (``default_body_fn`` / ``from_disk_fn``). Runtime-only, not in the hash.
    asset_spec: type | None = field(default=None, compare=False, repr=False, metadata=_MERGE)
    # Optional post-sync hook: async Callable[[FSRecord], None] — runs after
    # FSRecord.sync_to_db completes its entity/FTS/wiki writes. Used by
    # types that reconcile cross-record relationships (e.g. markdown folder-doc
    # parent/child edges) that the base sync doesn't know about.
    post_sync_fn: Any = field(default=None, compare=False, repr=False)

    def __post_init__(self) -> None:
        self.type_name = str(self.type_name)   # an EntityType member is accepted, a str is stored
        self.walk = (self.walk,) if isinstance(self.walk, Walk) else tuple(self.walk or ())

    @property
    def default_origin_kind(self) -> str:
        """The origin kind a store/load defaults to: the declared ``origin_kind``,
        else "db" for a row-only type and "local" for an asset type."""
        return self.origin_kind or ("db" if self.db_only else "local")

    @property
    def post_sync_callbacks(self) -> tuple:
        """``post_sync_fn`` as a tuple, whichever shape it was declared in.

        One callable, several, or none. Callers iterate and nobody branches on the shape — the
        field held a single value for years, and a second consumer should not have to know that.
        """
        declared = self.post_sync_fn
        if declared is None:
            return ()
        if callable(declared):
            return (declared,)
        return tuple(fn for fn in declared if callable(fn))
    # Per-type indexer dispatch callables, registered next to their definitions
    # in ``fs_store/indexer/functions/<type>.py``. The indexer reads these
    # instead of duck-typing classmethods on the entity:
    #   from_disk_fn:      Callable[[FSRef, str], list[FSRecord]] — parse payload
    #   identity_carrier:  IdentityCarrier — WHERE the id lives (frontmatter / folder json / …)
    #   id_stable_key_fn:  Callable[[FSRef | Path], str | None] — v5 key
    #   asset_hash_fn:     Callable[[FSRef], float] — cheap freshness stat
    from_disk_fn: Any = field(default=None, compare=False, repr=False, metadata=_MERGE)
    capsules: tuple[CapsuleSpec, ...] = field(default_factory=tuple)
    identity_carrier: IdentityCarrier | None = field(default=None, compare=False, repr=False)
    id_stable_key_fn: Any = field(default=None, compare=False, repr=False, metadata=_MERGE)
    #   identity_key_fn:   Callable[[FSRef | Path], str] — the type's natural key.
    #     The v5 key is derived as f"{type_name}:{identity_key_fn(ref)}"; set this
    #     instead of id_stable_key_fn unless the type needs a different shape.
    identity_key_fn: Any = field(default=None, compare=False, repr=False, metadata=_MERGE)
    id_namespace: uuid.UUID = field(default=uuid.NAMESPACE_URL, compare=False, repr=False, metadata=_MERGE)
    asset_hash_fn: Any = field(default=None, compare=False, repr=False, metadata=_MERGE)
    # Per-type default-body writer: Callable[[entity], str]. Read by
    # FSRecord.default_body / upsert_main_ref to materialize the backing file on
    # create. None ⇒ no auto-created body.
    default_body_fn: Any = field(default=None, compare=False, repr=False, metadata=_MERGE)
    # True ⇒ entity saves re-render the backing file from default_body_fn on
    # EVERY store() (entity is the file's sole editor), not just on create.
    owns_main_ref: bool = field(default=False, compare=False, repr=False, metadata=_MERGE)
    # True ⇒ sharing an entity of this type also shares its parent
    # (``parent_type_id``); the receive path materializes the parent first via
    # ``Entity.materialize_share_parent``. Runtime-only; not part of the
    # schema hash. Only safe when the parent type is deterministic/field-frozen.
    parent_share_on_default: bool = field(default=False, compare=False, repr=False, metadata=_MERGE)
    # True ⇒ this hub-hosted ``is_child`` type is pulled during the shared-context
    # catch-up sync (``_sync_shared_context_subtree``). The live bridge already
    # materializes any child type generically, so this flag only declares the
    # pull-side type list — sourced from the registry, not a hardcoded tuple.
    # Runtime-only; not part of the schema hash.
    shared_child: bool = field(default=False, compare=False, repr=False, metadata=_MERGE)
    # True for a type declared by a ``schema/type_info`` module (stamped by
    # ``register(declared=True)``); False for an ad-hoc ``TypeInfo`` (a test
    # probe, a ``from_dict`` mirror). Registry-wide checks over "the declared
    # types" filter on this.
    declared: bool = field(default=False, compare=False, repr=False, metadata=_MERGE)
    # True ⇒ Entity.save persists the row in the DB only and never creates an
    # FSRecord shadow. Such types have no disk→DB adopt path. Runtime-only; not
    # part of the schema hash.
    db_only: bool = field(default=False, compare=False, repr=False, metadata=_MERGE)
    # Cloud delivery capability for file-backed assets. Serialized to the UI
    # bootstrap but deliberately excluded from the local indexing schema hash.
    cloud_file_transport: Literal["embedded", "git"] = field(
        default="embedded", compare=False, repr=False, metadata=_MERGE
    )
    # Per-type pydantic metadata model: the FS↔DB schema. Its field set defines
    # which entity fields with ``persist=DEFAULT`` are mirrored to metadata.json,
    # and ``FSRecord.meta_dict`` returns a typed instance when it is set.
    # Runtime-only; not part of the schema hash.
    meta_model: Any = field(default=None, compare=False, repr=False, metadata=_MERGE)
    # --- Serialization (HOW/WHERE) — runtime-only, not part of the schema hash ---
    # The DECLARED origin kind ("db" | "local"); None = not declared, which
    # resolves through ``default_origin_kind`` above. Kept None so an
    # entity-class registration (which never knows ``db_only``) cannot
    # overwrite a module's declaration through the registry merge.
    origin_kind: str | None = field(default=None, compare=False, repr=False, metadata=_MERGE)
    # The path names the entity when the header carries no name: the folder
    # name for a folder type (an Agent at ``agent/q/`` is ``q``), the file stem
    # for a file type (``prompts/greet.md`` is ``greet``). A LAYOUT fact.
    name_from_path: bool = field(default=False, compare=False, repr=False, metadata=_MERGE)
    # JSON main docs: ``"sections"`` = ``{metadata, data}`` (a dataset);
    # ``"flat"`` = the header's keys merged into the payload's own document (a
    # trace/report whose file predates us). None ⇒ flat when the class has no
    # ``data_field``, sections otherwise.
    manifest_layout: str | None = field(default=None, compare=False, repr=False, metadata=_MERGE)
    # Facts the DISK carries that the header cannot say: counts over rows,
    # links scraped from a body, a name from the path. ``(data, root, header_raw)``
    # mutates the entity kwargs after the main doc and fields are read, before
    # the class is constructed.
    derive_fields_fn: Any = field(default=None, compare=False, repr=False, metadata=_MERGE)
    # The entity field naming the rows' on-disk layout (``"data_layout"`` for a
    # dataset). Tells the disk serializer this type has layout-written rows,
    # without the serializer ever naming the type.
    rows_layout_field: str | None = field(default=None, compare=False, repr=False, metadata=_MERGE)
    # The canonical filename the asset's main doc is published under on the hub
    # (``document.md`` for a markdown doc, ``SKILL.md`` for a skill folder).
    # Also the opt-in: ``None`` keeps the generic embedded-VFS push.
    hub_main_file: str | None = field(default=None, compare=False, repr=False, metadata=_MERGE)
    # Row identity for row-only types: the fields whose tuple resolves an
    # existing row (``SourceItem``: data_source · segment · external id). None ⇒
    # identity is ``id`` alone. Read by ``DbSerializer.resolve``/``upsert``.
    natural_key: tuple[str, ...] | None = field(default=None, compare=False, repr=False, metadata=_MERGE)
    # The no-op gate: the fields whose canonical digest decides "unchanged" on
    # re-delivery. None ⇒ no gate (every save writes).
    digest_fields: tuple[str, ...] | None = field(default=None, compare=False, repr=False, metadata=_MERGE)
    # The row field that HOLDS the digest the gate compares against.
    digest_field: str = field(default="content_digest", compare=False, repr=False, metadata=_MERGE)
    # A row-only (``db_only``) type that is nonetheless searchable: the row field
    # FTS indexes as ``content`` — fed from the row, no metadata.json shadow.
    fts_content: tuple[str, ...] = field(default=(), compare=False, repr=False, metadata=_MERGE)
    # --- Placement axis ---
    # ``asset_class`` is the "definition" (INTERNAL / HARNESS / SHARED / REPO / …);
    # ``harness`` names the owning harness for HARNESS types; ``family`` is the
    # bare leaf subdir (``skills``, ``docs``, ``assets/datasets``). Resolved
    # through ``flow_sdk.fs_store.placement``; ``main_subdir`` below is the
    # claude-default view. Not hashed.
    asset_class: Any = field(default=None, metadata=_MERGE)  # placement.AssetClass | None
    harness: Any = field(default=None, metadata=_MERGE)  # placement.HarnessType | None
    family: str | None = field(default=None, metadata=_MERGE)
    # --- THE shape declaration: ``File(ext)`` | ``Folder(main, ref_is_main)`` ---
    # ``main_layout`` / ``main_file`` / ``main_ext`` / ``main_file_is_asset_ref``
    # are read-only projections of it (below). Not hashed.
    shape: Any = field(default=_DEFAULT_SHAPE, metadata=_MERGE)  # flow_sdk.schema.layout.Shape
    # The asset editor that opens this type (``"markdown"``, ``"skill"``, …);
    # shipped in the bootstrap so the frontend derives its editor tables from
    # the registry instead of a hand-maintained per-type map. None ⇒ no editor.
    editor: str | None = field(default=None, metadata=_MERGE)
    # The declarative SCAN(s) for this type (``flow_sdk.schema.layout.Walk``):
    # which root nodes each hangs on and which mounts it looks in. A single
    # ``Walk`` is accepted and stored as a 1-tuple; ``()`` ⇒ the type is walked
    # by a bespoke function (or not walked at all).
    walk: tuple[Walk, ...] = field(default=(), metadata=_MERGE)
    # Fields the ASSIGNEE of a shared entity owns. When the local user is the
    # entity's assignee (and not its reporter), a hub-reflected update carries
    # ONLY these — everything else on the row belongs to whoever handed the work
    # over. Without it, one shared row means whole-row LWW
    # (``Entity.is_stale``): the assignee's UI PUTs its entire snapshot, so a
    # status click reverts the owner's title/body. Empty ⇒ no scoping.
    # Runtime-only; not part of the schema hash.
    assignee_owned_fields: tuple = field(default_factory=tuple, compare=False, repr=False, metadata=_MERGE)
    # Filenames/globs inside a folder-backed asset that must NOT ride a share
    # bundle. The packer copies the folder verbatim, so this is the only place a
    # type can keep a private file at home (a task's inner ``spec.md`` — the
    # plan). Consumed by ``flow_message_bundle._pack_ignore``. Runtime-only; not
    # part of the schema hash.
    pack_exclude: tuple = field(default_factory=tuple, compare=False, repr=False, metadata=_MERGE)
    # Reception seam (runtime-only; not in the schema hash). ``setup_skill`` is the
    # built-in skill that sets a received attachment of this type up in a Vibe
    # session (``None`` ⇒ just open it; a value equal to ``type_name`` ⇒ run the
    # received entity as its own skill). ``reception_verb`` is the receive CTA verb
    # (label = ``"<reception_verb> the <typeLabel>"``). Read by
    # ``Entity.setup_on_receive`` and surfaced to the FE via ``to_dict``.
    setup_skill: str | None = field(default=None, metadata=_MERGE)
    reception_verb: str = field(default="Open", metadata=_MERGE)
    # ``receive_policy``: reception gate for a bundled entry of this type.
    # ``None`` ⇒ staged → review → explicit install; ``"auto"`` ⇒ row-only
    # payload installed immediately at unpack through the one install action
    # (no review dialog; its chip navigates). ``receive_row_overrides`` are the
    # local-state fields merged over the packed header when the row
    # materializes (backend-only; never serialized).
    receive_policy: str | None = field(default=None, metadata=_MERGE)
    receive_row_overrides: dict | None = field(default=None, metadata=_MERGE)

    # --- Projections of ``shape`` (read-only) ---

    @property
    def main_layout(self) -> str:
        return "folder" if isinstance(self.shape, Folder) else "file"

    @property
    def main_file(self) -> str | None:
        """A folder type's inner main document (``SKILL.md``); None for a file type."""
        return self.shape.main if isinstance(self.shape, Folder) else None

    @property
    def main_file_is_asset_ref(self) -> bool:
        """Folder types: ``asset_ref`` IS ``<folder>/<main_file>`` (spec) rather than the folder (skill)."""
        return isinstance(self.shape, Folder) and self.shape.ref_is_main

    @property
    def main_ext(self) -> str:
        """The document suffix a create writes: the file's, or the folder's main document's."""
        if isinstance(self.shape, File):
            return self.shape.ext
        return (Path(self.shape.main).suffix.lower() if self.shape.main else "") or ".md"

    @property
    def folder_backed(self) -> bool:
        """``asset_ref`` points at a browsable folder (skill-style), not the
        inner main file (spec-style). The Assets sidebar expands these rows."""
        return isinstance(self.shape, Folder) and not self.shape.ref_is_main

    @property
    def git_publishable(self) -> bool:
        """Whether this registered type can be re-parsed for Git publication."""
        return (
            self.cloud_file_transport == "git"
            and self.from_disk_fn is not None
            and self.identity_carrier is not None
        )

    def asset_ref_for(self, folder: Path) -> Path:
        """Where ``asset_ref`` points for the asset rooted at ``folder``."""
        return self.shape.ref_for(folder)

    def layout_of(self, path: Path, *, verify: bool = False) -> "Layout":
        """THE path→layout classifier: ``shape.locate``. ``NONE`` when the path
        is not this type's shape; ``verify`` additionally requires the main
        file / the file to exist (the indexer's gate)."""
        return self.shape.locate(path, verify=verify)

    def body_path_for(self, asset_path: Path) -> Path:
        """The writable main-body file for an asset_ref (the file itself for a
        file type; ``<folder>/<main_file>`` for a folder type)."""
        return self.layout_of(asset_path).body or asset_path

    def record_for(self, ref: Any, resolved_id: str) -> Any:
        """Parse ONE asset whose id the caller already resolved through the
        id seam; run ``from_disk_fn`` and answer the first record or None."""
        if self.from_disk_fn is None:
            return None
        records = self.from_disk_fn(ref, resolved_id)
        return records[0] if records else None

    def storage_root_for(self, path: Path) -> Path:
        """The asset ROOT a serializer stores at — the folder for a folder-layout
        type even when ``asset_ref`` names the inner main file; the file
        otherwise. Inverse of ``asset_ref_for``; the shape's ``root_of``."""
        return self.shape.root_of(path)

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

    def stable_key_for(self, ref) -> str | None:
        """The v5 key text for *ref*, or None when this type has no stable key.
        ``identity_key_fn`` yields ``<type>:<natural key>``; ``id_stable_key_fn``
        is the escape hatch for a different shape. v5 ids depend on the text."""
        if self.id_stable_key_fn is not None:
            return self.id_stable_key_fn(ref)
        if self.identity_key_fn is not None:
            return f"{self.type_name}:{self.identity_key_fn(ref)}"
        return None

    # --- SCAN declarations ---

    @property
    def walks_anywhere(self) -> bool:
        """One of the type's walks is the folder-wide one (a skill is a skill anywhere)."""
        return any(walk.anywhere for walk in self.walk)

    @property
    def scan_mounts(self) -> tuple[str, ...]:
        """Every root-relative directory a copy of this type may BE in: the
        declared walk mounts plus placement's (``placement.scan_mounts``)."""
        from flow_sdk.fs_store.placement import scan_mounts  # noqa: PLC0415

        declared = (m for walk in self.walk if not walk.anywhere for m in walk.mounts)
        return tuple(dict.fromkeys((*declared, *scan_mounts(*self._resolved_layout))))

    # --- The id seam ---

    @property
    def carrier(self) -> IdentityCarrier:
        """The declared carrier; a type without one derives (never writes)."""
        return self.identity_carrier if self.identity_carrier is not None else Derived()

    def layout_for(self, ref: Any) -> "Layout":
        """Classify one ref for the id seam. A writable carrier refuses
        (``UnclaimedPath``) a path the type does not claim; a derived type's
        id is a keyed function of the source, never a write, so an unshaped
        path is the file itself (mcp_server declares ``.json`` but also
        derives from ``.toml`` and settings entries)."""
        path = Path(getattr(ref, "_path", ref))
        layout = self.layout_of(path)
        if self.carrier.writable and (reason := self._refusal(path, layout)) is not None:
            raise UnclaimedPath(self.type_name, path, reason)
        return layout if layout.kind is not LayoutKind.NONE else Layout(LayoutKind.FILE, path, path, path)

    def claims(self, path: Path) -> "str | None":
        """Why this type does NOT claim ``path`` — or ``None`` when it does."""
        return self._refusal(path, self.layout_of(path))

    def _refusal(self, path: Path, layout: "Layout") -> "str | None":
        """A path not on disk yet is a save target (claimed); a directory is a
        folder asset receiving its capsule; a file is this type's unless
        another walked folder type owns it as its main document (``SKILL.md``
        is a skill, never a ``markdown``) or it is not the shape."""
        try:
            st = path.stat()
        except (FileNotFoundError, NotADirectoryError):
            return None
        if stat.S_ISDIR(st.st_mode):
            return None if isinstance(self.shape, Folder) else "a directory is not a file asset"
        owners = SchemaRegistry.main_file_owners(path)
        if owners and self.type_name not in owners:
            return f"{path.name} is the main document of {', '.join(sorted(owners))}"
        if layout.kind not in (LayoutKind.FILE, LayoutKind.MAIN_FILE):
            return f"not shaped as a {self.type_name} ({self.shape})"
        return None

    def read_id(self, ref: Any) -> str | None:
        """The valid id the source already carries, else None. Never writes."""
        layout = self.layout_for(ref)
        found = self.carrier.read(self.carrier.locate(layout))
        return found.id if isinstance(found, Found) else None

    def _stampable(self, layout: "Layout", where: Path) -> bool:
        """The carrier accepts ``where`` AND a folder asset has its main
        document: a folder without it (a yaml-only skill) is not the shape,
        so nothing is ever written into it — a scan issue, not an asset."""
        if isinstance(self.shape, Folder) and where == layout.body and not where.exists():
            return False
        return self.carrier.accepts(where)

    def mint(self, layout: "Layout", *, write: bool = True, ref: Any = None, found: Any = None) -> str:
        """MINT: ``Found`` is the answer; ``Foreign`` raises ``ForeignId``;
        absent ⇒ mint (v5 when the type has a stable key, else v4) and, with
        ``write``, stamp it through the carrier — which refuses
        (``NotWritable``) a path that is not its own format. Without a write a
        keyless id is not an answer (``Unstamped``). ``ref`` reaches the
        stable-key function when it carries more than the path; ``found`` is
        the carrier's read when the caller already has it."""
        carrier = self.carrier
        where = carrier.locate(layout)
        if found is None:
            found = carrier.read(where)
        if isinstance(found, Found):
            return found.id
        if not isinstance(found, Absent):
            raise ForeignId(where, found.raw)
        key = self.stable_key_for(ref if ref is not None else layout.ref)
        new_id = mint_uuid(key or None, namespace=self.id_namespace)
        if not write:
            if key:
                return new_id
            raise Unstamped(f"{self.type_name} at {where}: a keyless id must be written to be an answer")
        if not self._stampable(layout, where):
            # A keyed id is deterministic, so a carrier that cannot take the
            # write (derived; a path not of its format) still has an answer.
            if key:
                return new_id
            if not carrier.writable:
                raise Unstamped(f"{self.type_name} at {where}: a derived identity has no key and is never written")
            raise NotWritable(f"{self.type_name}: {type(carrier).__name__} cannot write into {where}")
        try:
            return carrier.stamp(where, new_id)
        except OSError:
            logging.debug("[asset-id] mint write failed for %s", where, exc_info=True)
        if key:
            return new_id
        raise Unstamped(f"{self.type_name} at {where}: mint write failed")

    def stamp_id(self, ref: Any, entity_id: str) -> str:
        """The create-flow seam: persist ``entity_id`` into the source through
        the carrier. A ``Found`` id wins and is returned; ``Foreign`` raises.
        A ``read_only`` ref, suppressed carrier writes or a derived type answer
        the carrier or ``entity_id`` without writing."""
        return self._stamp(self.layout_for(ref), ref, entity_id)

    def _stamp(self, layout: "Layout", ref: Any, entity_id: str) -> str:
        if not is_valid_entity_id(entity_id):
            raise ValueError("proposed entity id must be a UUID v4 or v5")
        carrier = self.carrier
        where = carrier.locate(layout)
        write = carrier.writable and _may_write(ref)
        if write and not self._stampable(layout, where):
            raise NotWritable(f"{self.type_name}: {type(carrier).__name__} cannot write into {where}")
        found = carrier.read(where)
        if isinstance(found, Found):
            if write and found.source in LEGACY_CONVERTIBLE and hasattr(carrier, "convert"):
                carrier.convert(where, found.id)   # a create over a legacy source moves the id into the header
            return found.id
        if not write:
            return entity_id
        return carrier.stamp(where, entity_id)

    def mint_entity_id(
        self,
        ref: Any,
        *,
        proposed_id: str | None = None,
        owner_id: str | None = None,
        live_ids: "Container[str] | None" = None,
    ) -> str:
        """Adapter over the seam: ``proposed_id`` ⇒ stamp it; everything else
        ⇒ the indexer's ``reconcile`` (carrier vs owning row, legacy
        conversion, the foreign-id fallback). Writes are gated by the ref's
        ``read_only`` and the carrier-write suppression context."""
        from flow_sdk.fs_store.indexer.reconcile import reconcile  # noqa: PLC0415

        layout = self.layout_for(ref)
        if proposed_id is not None and not owner_id:
            try:
                return self._stamp(layout, ref, proposed_id)
            except ForeignId:
                pass   # reconcile records the foreign id and answers with the keyed/path v5
        return reconcile(self, layout, owner_id or None, live_ids, write=_may_write(ref), ref=ref)

    @property
    def _resolved_layout(self) -> "tuple[Any, Any, str | None]":
        """The ``(asset_class, harness, family)`` placement triple. ``(None, …)``
        for non-file-backed types (e.g. ``claude_md``, fixed filename)."""
        return (self.asset_class, self.harness, self.family)

    @property
    def main_subdir(self) -> str | None:
        """The claude-default family subdir (``.claude/skills``, ``docs``,
        ``assets/datasets``); ``None`` for non-file-backed types."""
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
            # THE shape declaration the four fields above project; the client
            # reads this one and derives, never a hand-written per-type table.
            "shape": self.shape.to_dict(),
            "editor": self.editor,
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
            shape=shape_from_dict(data.get("shape")) or _DEFAULT_SHAPE,
            editor=data.get("editor"),
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


#: The ``merge``-tagged TypeInfo fields: a later registration's non-default value wins.
_MERGE_SLOTS = tuple(f for f in fields(TypeInfo) if f.metadata.get("merge"))


def _slot_default(slot: Any) -> Any:
    return slot.default if slot.default is not MISSING else slot.default_factory()


@dataclass(frozen=True)
class _ShapeTables:
    """The SCAN lookup tables, one dict lookup per classification:
    main name → walked folder types (``SKILL.md`` → skill); fixed filename →
    walked file types (``CLAUDE.md`` → claude_md); ``(ext, mount)`` → placed
    file types (``.md`` under ``.claude/commands``), glob mounts bucketed by
    ``(ext, depth)``; ext → walked file types (``.csv`` → spreadsheet)."""

    by_main: dict[str, tuple[TypeInfo, ...]]
    by_name: dict[str, tuple[TypeInfo, ...]]
    by_ext: dict[str, tuple[TypeInfo, ...]]
    by_mount: dict[tuple[str, tuple[str, ...]], tuple[TypeInfo, ...]]
    wild: dict[tuple[str, int], tuple[tuple[tuple[str, ...], TypeInfo], ...]]
    depths: tuple[int, ...]   # every mount depth, deepest first

    @classmethod
    def build(cls, infos: "Any") -> "_ShapeTables":
        by_main: dict[str, list[TypeInfo]] = {}
        by_name: dict[str, list[TypeInfo]] = {}
        by_ext: dict[str, list[TypeInfo]] = {}
        by_mount: dict[tuple[str, tuple[str, ...]], list[TypeInfo]] = {}
        wild: dict[tuple[str, int], list[tuple[tuple[str, ...], TypeInfo]]] = {}
        for info in infos:
            if info.from_disk_fn is None:
                continue   # a type with no walker never claims a path (test probes register too)
            if isinstance(info.shape, Folder):
                if info.shape.main:
                    by_main.setdefault(info.shape.main.lower(), []).append(info)
                continue
            if not isinstance(info.shape, File):
                continue
            if info.shape.names:
                for name in info.shape.names:
                    by_name.setdefault(name.lower(), []).append(info)
                continue   # a fixed-name file is never "any file of that extension"
            for ext in info.shape.exts:
                by_ext.setdefault(ext, []).append(info)
                for mount in info.scan_mounts:
                    parts = tuple(part.lower() for part in Path(mount).parts)
                    if "*" in parts:
                        wild.setdefault((ext, len(parts)), []).append((parts, info))
                    else:
                        by_mount.setdefault((ext, parts), []).append(info)
        depths = {len(parts) for _ext, parts in by_mount} | {depth for _ext, depth in wild}
        return cls(
            by_main={k: tuple(v) for k, v in by_main.items()},
            by_name={k: tuple(v) for k, v in by_name.items()},
            by_ext={k: tuple(v) for k, v in by_ext.items()},
            by_mount={k: tuple(v) for k, v in by_mount.items()},
            wild={k: tuple(v) for k, v in wild.items()},
            depths=tuple(sorted(depths, reverse=True)),
        )


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
    #: Run when an entity class first binds to a type (see ``on_entity_bound``).
    _entity_bound_hooks: ClassVar[list[Callable[[], None]]] = []
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
    def on_entity_bound(cls, hook: Callable[[], None]) -> None:
        """Run ``hook`` whenever an entity class first binds to a type.

        The subscriber is ``core.schema`` (its payload memo must drop). A hook
        rather than an import: entities register from ``__init_subclass__``
        mid-import, and importing ``core.schema`` from here at that moment
        re-enters the partially initialized entity package.
        """
        if hook not in cls._entity_bound_hooks:
            cls._entity_bound_hooks.append(hook)

    @classmethod
    def register(cls, info: TypeInfo, *, declared: bool = False) -> None:
        """Register or enrich a TypeInfo. O(1). Idempotent — merges on
        re-register. ``declared`` marks a ``schema/type_info`` declaration."""
        if declared:
            info.declared = True
        existing = cls._types.get(info.type_name)
        cls._registry_generation += 1
        # An entity class binding to a type AFTER the per-type schema payloads
        # were memoized (``core.schema``) leaves that type's bootstrap ``schema``
        # frozen at ``None``: entities self-register on import, and some are
        # imported lazily by a server subsystem well after the first bootstrap
        # assembled the cache (``Trigger`` via ``builtin_triggers``). A new
        # binding therefore drops the memo so the next assembly sees the class.
        newly_bound = info.entity_cls is not None and (existing is None or existing.entity_cls is None)
        if existing is not None:
            for loc in info.locations:
                if loc not in existing.locations:
                    existing.locations.append(loc)
            if info.post_sync_fn is not None:
                # Appended, not replaced: two modules may each register an observer for one type.
                already = existing.post_sync_callbacks
                existing.post_sync_fn = (
                    *already,
                    *(fn for fn in info.post_sync_callbacks if fn not in already),
                )
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
            if info.browseable_by is not None and (
                existing.browseable_by is None
                or view_mode_rank(info.browseable_by) < view_mode_rank(existing.browseable_by)
            ):
                # Keep the more permissive (lower-ordered) non-null level.
                existing.browseable_by = info.browseable_by
            if info.defaults:
                existing.defaults = {**existing.defaults, **info.defaults}
            for slot in _MERGE_SLOTS:
                value = getattr(info, slot.name)
                if value != _slot_default(slot):
                    setattr(existing, slot.name, value)
            info = existing
        else:
            cls._types[info.type_name] = info

        if info.parent_type:
            cls._subtypes.setdefault(info.parent_type, [])
            if info.type_name not in cls._subtypes[info.parent_type]:
                cls._subtypes[info.parent_type].append(info.type_name)

        if info.indexed_by_default and info.type_name not in cls._default_index_types:
            cls._default_index_types.append(info.type_name)
        if newly_bound:
            for hook in cls._entity_bound_hooks:
                hook()
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

    # --- SCAN tables, built lazily from the declarations and keyed on the
    # registry generation so a (re)registration or a test clearing ``_types``
    # rebuilds them.
    _registry_generation: int = 0
    _shape_tables_key: Any = None
    _tables: "_ShapeTables | None" = None

    @classmethod
    def _shape_tables(cls) -> "_ShapeTables":
        cls._ensure_loaded()
        key = (len(cls._types), cls._registry_generation)
        if cls._shape_tables_key != key:
            cls._tables = _ShapeTables.build(cls._types.values())
            cls._shape_tables_key = key
        return cls._tables

    @classmethod
    def main_file_owners(cls, path: "Path | str") -> frozenset[str]:
        """The walked folder-layout types whose declared main document IS
        ``path``: by name (case-insensitive) AND by placement — under one of
        the type's ``scan_mounts``, or anywhere for a type that walks anywhere
        (``agentic-assets/spec/<x>/spec.md`` is a spec, a loose ``SPEC.md`` is
        a document; a ``SKILL.md`` is a skill wherever it sits). Two types may
        share a name at one placement; the set carries that."""
        from flow_sdk.fs_store.placement import mount_matches  # noqa: PLC0415

        p = Path(path)
        candidates = cls._shape_tables().by_main.get(p.name.lower())
        if not candidates:
            return frozenset()
        parent_parts = p.parent.parent.parts
        return frozenset(
            info.type_name
            for info in candidates
            if info.walks_anywhere or any(mount_matches(parent_parts, Path(m).parts) for m in info.scan_mounts)
        )

    @classmethod
    def _placed_owners(cls, p: Path, suffix: str) -> "tuple[TypeInfo, ...]":
        """The file types whose declared mount is the NEAREST ancestor of ``p``
        that is any type's mount, for ``p``'s extension. ``.claude/commands/x.md``
        → command; ``docs/guide/index.md`` → the docs family; a loose ``x.md`` → ()."""
        from flow_sdk.fs_store.placement import mount_matches  # noqa: PLC0415

        tables = cls._shape_tables()
        parts = tuple(part.lower() for part in p.parent.parts)
        for cut in range(len(parts), 0, -1):
            for depth in tables.depths:
                if depth > cut:
                    continue
                tail = parts[cut - depth:cut]
                hit = tables.by_mount.get((suffix, tail))
                if hit:
                    return hit
                wild = tuple(info for mount, info in tables.wild.get((suffix, depth), ()) if mount_matches(tail, mount))
                if wild:
                    return wild
        return ()

    @staticmethod
    def _declared_type(p: Path) -> str | None:
        """The ``type:`` a markdown document's own frontmatter declares, if any —
        how two types sharing one mount and extension (``markdown`` and
        ``markdown_index`` under ``docs``) are told apart."""
        from flow_sdk.fs_store.indexer._frontmatter import _extract_frontmatter, _yaml_load  # noqa: PLC0415

        try:
            head = p.read_text(encoding="utf-8", errors="ignore")[:4096]
        except OSError:
            return None
        fm = _extract_frontmatter(head)
        if not fm:
            return None
        declared = _yaml_load(fm).get("type")
        return str(declared).strip() if declared else None

    @classmethod
    def type_for(cls, path: "Path | str") -> str | None:
        """THE registry-wide path → type classifier (name + placement + stat;
        no walk roots). Precedence:

        1. a folder type's declared main document, by name and placement
           (``SKILL.md`` → ``skill``; ``agentic-assets/mcp/x/mcp.json`` → ``mcp``;
           a folder holding one → that type);
        2. a file type's declared FIXED filename (``CLAUDE.md`` → ``claude_md``);
        3. a file type's declared family dir, for its extension, as the nearest
           such ancestor (``.claude/commands/x.md`` → ``command``,
           ``.agents/agents/x.md`` → ``subagent``, ``agentic-assets/plan/x.md``
           → ``plan``); when several types share the mount, the document's own
           frontmatter ``type:`` decides (``docs/index.md`` declaring
           ``markdown_index``), else fall through;
        4. a file type whose declared extension is unique among walked file
           types (``.js`` → dynamic_workflow, ``.csv`` → spreadsheet);
        5. ``markdown`` for any remaining ``.md``;
        6. ``None`` — not an asset, or ambiguous (``.json``/``.jsonl`` are
           claimed by several bespoke-walked types and need their roots).

        A name shared by two types at one tier is ``None``, never registration
        order. Every tier is read off the declarations (``shape``, ``asset_class``
        / ``harness`` / ``family``); there is no hand-written path table.
        """
        p = Path(path)
        tables = cls._shape_tables()
        if p.is_dir():
            try:
                names = {entry.lower() for entry in os.listdir(p)}
            except OSError:
                return None
            for name in names & tables.by_main.keys():
                owners = cls.main_file_owners(p / name)
                if len(owners) == 1:
                    return next(iter(owners))
            return None
        owners = cls.main_file_owners(p)
        if len(owners) == 1:
            return next(iter(owners))
        if owners:
            return None
        named = tables.by_name.get(p.name.lower(), ())
        if named:
            return named[0].type_name if len(named) == 1 else None
        suffix = p.suffix.lower()
        if not suffix:
            return None
        placed = cls._placed_owners(p, suffix)
        if len(placed) == 1:
            return placed[0].type_name
        if placed:
            declared = cls._declared_type(p)
            if declared in {info.type_name for info in placed}:
                return declared
        if suffix != ".md":
            by = tables.by_ext.get(suffix, ())
            return by[0].type_name if len(by) == 1 else None
        return "markdown" if "markdown" in cls._types else None

    @classmethod
    def ref_for(cls, type_name: str, path: "Path | str") -> str:
        """The ``asset_ref`` spelling of the asset at ``path`` for ``type_name``
        — a folder asset's DIRECTORY when handed its inner main file; ``path``
        itself when the type is unknown or does not shape it."""
        info = cls.get(type_name)
        ref = info.layout_of(Path(path)).ref if info is not None else None
        return str(ref) if ref is not None else str(path)

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
        in its ``TypeInfo`` declaration — no edit to the sync code.
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
