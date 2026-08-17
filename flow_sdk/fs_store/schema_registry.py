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
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, ClassVar, Literal

from flow_sdk.capsules import CapsuleSpec
from flow_sdk.fs_store.identity_backend import IdentityBackend, IdentityObservation, IdentityState
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
class ScanResult:
    """Result of scanning a single record type."""

    type_name: str
    count: int
    total_bytes: int
    scan_ms: float
    last_scan_at: str | None = None
    records: list[dict] | None = None
    avg_bytes: int = 0
    min_bytes: int = 0
    max_bytes: int = 0


@dataclass
class IndexResult:
    """Result of indexing a single record type."""

    type_name: str
    indexed: int
    skipped: int
    duration_ms: float
    last_index_at: str | None = None
    errors: int = 0
    fresh: int = 0


PROGRESS_EMIT_EVERY: int = 25  # emit one event per this many records


@dataclass
class IndexRequest:
    """Declarative description of a scan+index operation."""

    types: list[str] | None = None
    actions: list[str] = field(default_factory=lambda: ["scan", "index"])
    start_time: datetime | None = None
    end_time: datetime | None = None
    trigger: str = "manual"
    limit_per_type: int | None = None


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
    # Optional post-sync hook: async Callable[[FSRecord], None] — runs after
    # FSRecord.sync_to_db completes its entity/FTS/wiki writes. Used by
    # types that reconcile cross-record relationships (e.g. markdown folder-doc
    # parent/child edges) that the base sync doesn't know about.
    post_sync_fn: Any = field(default=None, compare=False, repr=False)
    # Per-type indexer dispatch callables, registered next to their definitions
    # in ``fs_store/indexer/functions/<type>.py``. The indexer reads these
    # instead of duck-typing classmethods on the entity:
    #   from_disk_fn:      Callable[[FSRef, str], list[FSRecord]] — parse payload
    #   identity_backend:  IdentityBackend — carrier observation/persistence
    #   id_stable_key_fn:  Callable[[FSRef | Path], str | None] — v5 key
    #   asset_hash_fn:     Callable[[FSRef], float] — cheap freshness stat
    from_disk_fn: Any = field(default=None, compare=False, repr=False)
    capsules: tuple[CapsuleSpec, ...] = field(default_factory=tuple)
    identity_backend: IdentityBackend | None = field(default=None, compare=False, repr=False)
    id_stable_key_fn: Any = field(default=None, compare=False, repr=False)
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
            and self.identity_backend is not None
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

    def body_path_for(self, asset_path: Path) -> Path:
        """Map an asset_ref path to the writable main-body file.

        Folder-layout types whose asset_ref is the bare folder (skill-style,
        ``main_file_is_asset_ref=False``) keep the body at ``<folder>/<main_file>``;
        every other shape's asset_ref already IS the body target.
        """
        if self.main_layout == "folder" and self.main_file and not self.main_file_is_asset_ref:
            return asset_path / self.main_file
        return asset_path

    def folder_for(self, asset_ref: Path) -> Path:
        """Map an asset_ref back to its owning folder (inverse of ``asset_ref_for``).

        Bare-folder asset_ref (skill-style) IS the folder; spec-style inner-file
        asset_ref → its containing dir. Callers gate on ``main_layout == "folder"``.
        """
        return asset_ref if self.folder_backed else asset_ref.parent

    @property
    def folder_backed(self) -> bool:
        """True when ``asset_ref`` points at a browsable folder — a folder-layout
        type whose asset_ref is the bare folder (skill-style,
        ``main_file_is_asset_ref=False``), not the inner ``main_file``
        (spec-style). The Assets sidebar expands these rows into their on-disk
        file tree. Derived from the existing folder-layout fields so no type
        carries a redundant flag."""
        return self.main_layout == "folder" and not self.main_file_is_asset_ref

    @staticmethod
    def _identity_path(ref: Any) -> Path:
        """Return the concrete asset path accepted by identity callbacks."""
        return Path(getattr(ref, "_path", ref))

    def capsule_target_for(self, ref: Any) -> Path:
        """Return the owning file/folder used by this type's capsule backend."""
        path = self._identity_path(ref)
        if not self.folder_backed:
            return path
        if path.is_dir():
            return path
        if self.main_file and path.name == self.main_file:
            return path.parent
        return path

    def _observe(self, ref: Any) -> "IdentityObservation | None":
        """Read + parse the source's identity carrier ONCE, failing closed.

        Lego piece 1 of :meth:`mint_entity_id`. A MALFORMED carrier raises —
        a corrupt source must never be silently re-identified.
        """
        if self.identity_backend is None:
            return None
        observation = self.identity_backend.observe(self.capsule_target_for(ref))
        if observation.state is IdentityState.MALFORMED:
            if observation.error is not None:
                raise observation.error
            raise ValueError(observation.detail or "malformed asset identity")
        return observation

    @staticmethod
    def _adopt(observation: "IdentityObservation | None") -> str | None:
        """Lego piece 2: the v4/v5 adoption gate over an observation.

        Per-type readers only locate a candidate; a foreign id (e.g. a v7) is
        never adopted, so it reads as "no carrier" and the caller derives.
        """
        from flow_sdk.fs_store.identifier import adopt_entity_id  # noqa: PLC0415

        if observation is None or observation.state is not IdentityState.VALID:
            return None
        return adopt_entity_id(observation.candidate)

    def mint_entity_id(
        self,
        ref: Any,
        *,
        owner_id: str | None = None,
        live_ids: "Container[str] | None" = None,
        proposed_id: str | None = None,
        derive: bool = False,
        overwrite: bool = False,
    ) -> str | None:
        """**The** entity-id seam for a filesystem asset. Nothing else may mint.

        An asset's id lives in the source (a capsule), but a full-content
        rewrite — what an agent does on every revision — WIPES that carrier.
        Deriving from the source alone then invents a fresh id for a path a row
        already owns, forking the entity; the same-path sweep reaps the old row
        and every reference pinned to it dangles. So a carrier-less source is
        not a new asset: it is an existing one whose id must be RECOVERED.

        Ordering, by CARRIER LIVENESS::

            1. the carrier      IF no row owns this path
                                OR the carrier IS that row
                                OR the carrier is a live id of this type
            2. else ``owner_id`` — the row that owns ``ref``'s path
            3. else derive (stable key / path-v5 / fresh v4)  [``derive=True``]

        ``live_ids`` is the liveness oracle. ``None`` means "cannot prove dead",
        so a valid carrier always wins — only a caller holding the complete
        per-type id set (the index walk) may conclude a carrier names no entity.

        Two orthogonal flags, both defaulting to the inert corner, because the
        three real callers need three different behaviours:

        * ``derive=False, overwrite=False`` (default) — **probe**. Answers only
          from evidence and returns ``None`` when there is none. Required by
          collision-identity ranking, create guards and assertions: a *derived*
          value would make two unstamped copies look identical and an assertion
          vacuously true.
        * ``derive=True, overwrite=False`` — compute the id the indexer would
          assign, touching nothing. For request handlers and read-only mounts.
        * ``derive=True, overwrite=True`` — compute AND commit, healing an
          ABSENT carrier in place. The index walk.

        Contract:

        * **Sync, and never touches the DB.** ``owner_id``/``live_ids`` are
          supplied by the caller, which keeps DB-free callers and the
          zero-extra-query index walk working.
        * **Never writes ``asset_ref``.** Primary-path selection belongs to
          ``resolve_asset_collisions`` alone — writing it here would let a copy
          steal the original's path and flip the row every walk.
        * An INVALID carrier keeps its bytes even under ``overwrite`` — only an
          ABSENT one is stamped. A read-only ref or a non-persisting (derived)
          backend is never written.

        Known trade-off: because an absent carrier yields to the owning row,
        deleting a file and creating a DIFFERENT file at the same path before
        the next index makes the new content adopt the old entity. That is the
        price of keeping every reference alive across a rewrite, and it applies
        only while the old row exists — once swept as an orphan, a fresh id is
        minted.
        """
        from flow_sdk.fs_store.identifier import is_valid_entity_id  # noqa: PLC0415

        # Validate FIRST, before any early return. ``mint_id`` used to raise
        # here and ``resolve_id`` did not, so a caller passing a bad id could
        # silently get the carrier back instead of the error.
        if proposed_id is not None and not is_valid_entity_id(proposed_id):
            raise ValueError("proposed entity id must be a UUID v4 or v5")

        observation = self._observe(ref)
        carrier = self._adopt(observation)

        if carrier is not None and (
            owner_id is None or carrier == owner_id or live_ids is None or carrier in live_ids
        ):
            return carrier

        # A derived/provider identity is a pure function of the source, so an
        # owning row must never override it — a stale row on a rotated session
        # path would otherwise swallow a genuinely different session.
        persists = self.identity_backend is not None and self.identity_backend.persists_identity
        if owner_id and persists:
            absent = observation is None or observation.state is IdentityState.ABSENT
            if overwrite and absent and not bool(getattr(ref, "read_only", False)):
                # store_if_absent is enough here (the carrier IS absent) and
                # keeps the write path identical to a normal mint.
                self.identity_backend.store_if_absent(self.capsule_target_for(ref), owner_id)
            elif not absent:
                logging.warning(
                    "[asset-id] %s carrier %r names no live entity; path is owned by %s (%s)",
                    self.type_name,
                    observation.candidate,
                    owner_id,
                    self._identity_path(ref),
                )
            return owner_id

        if not derive:
            # Probe mode: the evidence is exhausted and computing a value here
            # is exactly what breaks collision ranking and create guards.
            return None

        # Reuse the observation above — deriving must not re-read the carrier.
        return self._derive(ref, observation, proposed_id=proposed_id, commit=overwrite)

    def _derive(
        self,
        ref: Any,
        observation: "IdentityObservation | None",
        *,
        proposed_id: str | None = None,
        commit: bool = True,
    ) -> str:
        """Lego piece 3: compute this type's configured id, optionally committing it.

        Portable assets have no stable key: they receive a random v4 only when
        their backend commits it. If the asset cannot carry that id, the stable
        path-v5 fallback keeps repeated scans idempotent. Natural/provider
        identities supply ``id_stable_key_fn`` and derive deterministic v5 ids.

        Takes the observation rather than re-reading, so an asset's carrier is
        parsed once per resolution — this runs per asset on every index walk.
        """
        from flow_sdk.fs_store.identifier import mint_uuid  # noqa: PLC0415

        path = self.capsule_target_for(ref)
        if observation is not None and observation.state is IdentityState.VALID:
            return str(observation.candidate)

        stable_key = self.id_stable_key_fn(ref) if self.id_stable_key_fn is not None else None
        # Invalid canonical data is never overwritten or treated as a brand-new
        # portable asset.  Derive a stable v5 until the source is repaired.
        if observation is not None and observation.state is IdentityState.INVALID_ID:
            return mint_uuid(stable_key or str(path.resolve()), namespace=self.id_namespace)

        minted = proposed_id or mint_uuid(stable_key, namespace=self.id_namespace)
        read_only = bool(getattr(ref, "read_only", False))
        # ``commit=False`` (a read-only derive) falls through to the stable
        # path-v5 below for portable types: a random v4 that is never persisted
        # would differ on every call, so it is not an answer.
        if commit and self.identity_backend is not None and not read_only:
            committed = self.identity_backend.store_if_absent(path, minted)
            if committed.state is IdentityState.VALID:
                return str(committed.candidate)
            if committed.state is IdentityState.MALFORMED and committed.error is not None:
                from flow_sdk.capsules import (  # noqa: PLC0415
                    DuplicateCapsuleError,
                    MalformedCapsuleError,
                    UnsupportedCapsuleVersionError,
                )

                # OS/storage write failures fall back deterministically below;
                # source corruption still fails closed.
                if isinstance(
                    committed.error,
                    (MalformedCapsuleError, DuplicateCapsuleError, UnsupportedCapsuleVersionError),
                ):
                    raise committed.error

        if stable_key:
            return minted
        return mint_uuid(str(path.resolve()), namespace=self.id_namespace)

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


class SchemaRegistry:
    """Unified type registry + scan/index orchestration."""

    @classmethod
    def mint_row_entity_id(cls, type_name: str, data: dict) -> str:
        """Mint the id for a ROW-ONLY entity — one with no file behind it.

        The other half of :meth:`mint_entity_id`, split out because it takes a
        creation ``dict`` rather than an ``FSRef``, and because the types that
        need it most (``flow_message``, ``conversation``) have no ``TypeInfo``
        at all — so it cannot live on the instance.

        Policy, all routed through ``mint_uuid`` so the v4/v5 rule stays in one
        place:

        * a conforming (v4/v5) ``data['id']`` is adopted;
        * a non-conforming one (a slug, a foreign v7) is normalized to
          ``uuid5(DNS, "<type>:<id>")`` — a hand-authored id never survives;
        * absent → random v4.

        A type may override the whole decision with a ``_row_id_policy``
        classmethod on its entity class (``Project`` keeps ids opaque; ``Tag``
        derives from its name and ignores caller ids).
        """
        import uuid as _uuid  # noqa: PLC0415

        from flow_sdk.fs_store.identifier import is_valid_entity_id, mint_uuid  # noqa: PLC0415

        entity_cls = cls.get_entity_cls(str(type_name)) if type_name else None
        policy = getattr(entity_cls, "_row_id_policy", None)
        if policy is not None:
            decided = policy(data)
            if decided:
                return str(decided)

        rid = data.get("id") or ""
        if rid and is_valid_entity_id(rid):
            return rid
        if rid:
            return mint_uuid(f"{type_name or 'record'}:{rid}", namespace=_uuid.NAMESPACE_DNS)
        return mint_uuid()


    _types: ClassVar[dict[str, TypeInfo]] = {}
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
            from flow_sdk.schema.type_info import register_all  # lazy: avoid import cycle

            register_all()
        except Exception:
            cls._loaded = False  # let the next access retry rather than wedge
            raise

    # ---------------------------------------------------------------------------
    # Registration
    # ---------------------------------------------------------------------------

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
            if info.identity_backend is not None:
                if existing.identity_backend is not None and existing.identity_backend != info.identity_backend:
                    raise ValueError(f"Conflicting identity backend registration for type {info.type_name!r}")
                existing.identity_backend = info.identity_backend
            if info.id_stable_key_fn is not None:
                existing.id_stable_key_fn = info.id_stable_key_fn
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
                    "duration_ms": 0.0,
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
        from flow_sdk.db import get_db_driver  # noqa: PLC0415

        driver = get_db_driver()
        per_type: list[TypeIndexStatus] = []
        latest_iso: str | None = None
        for type_name in types or cls.get_default_index_types():
            type_last = cls.get_last_index_at(type_name)  # JSONL run-history (audit)
            if type_last and (latest_iso is None or type_last > latest_iso):
                latest_iso = type_last
            count = await cls._safe_count(driver, type_name, scope)
            per_type.append(
                TypeIndexStatus(
                    type_name=type_name,
                    last_indexed_at=type_last,
                    entity_count=count,
                    stale=False,
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
            stale=False,
            default_types=cls.get_default_index_types(),
            per_type=per_type,
            total_orphans=0,
        )

    @staticmethod
    async def _safe_count(driver, type_name: str, scope: "object | None") -> int:
        """Per-type live count, tolerant of a driver whose
        ``count_entities_by_type`` predates the ``scope`` kwarg. Shared by
        ``get_index_status`` and ``get_asset_stats`` so there is one counting
        path, not two."""
        try:
            return await driver.count_entities_by_type(type_name, scope=scope)
        except TypeError:
            return await driver.count_entities_by_type(type_name)
        except Exception:
            return 0

    @classmethod
    async def get_asset_stats(cls, scope: "object | None" = None) -> AssetStats:
        """Live per-type asset counts for a ScopeFilter, over the registry's
        default index types (P5 — derived, not hardcoded). Counts only; reuses
        the same per-type count path as ``get_index_status``."""
        from flow_sdk.db import get_db_driver  # noqa: PLC0415

        driver = get_db_driver()
        per_type = {
            str(type_name): await cls._safe_count(driver, type_name, scope)
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
