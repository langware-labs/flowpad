from __future__ import annotations

import inspect
import os
from contextlib import contextmanager
from contextvars import ContextVar

DEFAULT_BROWSE_LIMIT = 20
import types
from typing import (
    Any,
    ClassVar,
    Dict,
    List,
    Literal,
    Optional,
    Sequence,
    Type,
    TypeGuard,
    TypeVar,
)

# Make logfire optional
try:
    import logfire
except ImportError:
    # Provide no-op decorator fallback
    class logfire:
        @staticmethod
        def instrument(msg):
            def decorator(func):
                return func

            return decorator


from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from pydantic import (
    Field,
    SerializationInfo,
    SerializeAsAny,
    TypeAdapter,
    ValidationError,
    computed_field,
    field_validator,
    model_serializer,
)

import flow_sdk.service_log as service_log
from flow_sdk.api.api_types.api_field import APIField, EntityField, Persist, Sharing
from flow_sdk.config import StorageProvider
from flow_sdk.db import DBEntity
from flow_sdk.db.db_entity import EntityExpansion
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType, TypeId
from flow_sdk.db.drivers.db_driver import RelationshipDirection
from flow_sdk.db.drivers.query import ExpressionNode, OrderType, QueryFilter, QueryOp
from flow_sdk.flowpad_types.enums import AuthRole, ExpansionType
from flow_sdk.fs_store.asset_occurrences import AssetOccurrence, asset_occurrence_dicts
from flow_sdk.fs_store.schema_registry import SchemaRegistry

from .blob_index_entity_model import BLOB_INDEX_VFS_PATH, BlobIndexEntity
from .entity_env.env_types import EntityEnvVars, EnvVar, EnvVarType

EntityType = TypeVar("EntityType", bound="Entity")

# When set, ``Entity.save`` skips the disk write-back (``store()``). Used by the
# disk→DB adopt path (``from_record``) so the source-of-truth file is never
# rewritten. Override-agnostic: every ``save()`` override funnels through the
# base ``save()`` which reads this, so no per-type signature change is needed.
_SUPPRESS_STORE: "ContextVar[bool]" = ContextVar("_suppress_store", default=False)

# When set, the DB driver treats the write as a PURE REFLECTION of a hub-origin
# row: ``apply_create_fields`` / ``apply_update_fields`` preserve ``created_by``,
# ``updated_by``, ``created_date`` and ``updated_date`` VERBATIM from the payload
# — including ``None`` — instead of substituting the local request user (or the
# ``system`` sentinel). This is the single sanctioned way to materialize a remote
# conversation/message without the receiver fabricating attribution onto it.
# Intent-scoped (the reflecting write opts in), NOT keyed on ``record.remote`` —
# so sender-side flip-to-remote and local mutations of remote rows (mark_received,
# body_downloaded, …) keep normal stamping. Read by the driver via a function-local
# import to avoid an import cycle.
_REMOTE_REFLECTION: "ContextVar[bool]" = ContextVar("_remote_reflection", default=False)


@contextmanager
def remote_reflection():
    """Mark the enclosed save(s) as a verbatim reflection of hub-origin rows.

    Inside this block the DB driver preserves the wire ``created_by`` /
    ``updated_by`` / timestamps as-is (``None`` stays ``None``) rather than
    stamping the local request user. Use ONLY around materialize/upsert saves
    of remote conversations and flow messages.
    """
    token = _REMOTE_REFLECTION.set(True)
    try:
        yield
    finally:
        _REMOTE_REFLECTION.reset(token)


@dataclass
class PathQueryOptions:
    """Filter options for ``Entity.assets_by_path``.

    - ``search_dirs``: one or more absolute folder paths; results are the
      union of entities whose ``asset_ref`` is a strict descendant of any.
    - ``types``: limit to these entity types. ``None`` means *all registered
      entity types* (record-only types are skipped — they have no DB rows).
    - ``include_system``: when False, system-project entities are excluded
      via SQL (so paging stays correct).
    """

    search_dirs: List[str | Path]
    types: List[str] | None = None
    include_system: bool = True
    limit: int = 200
    offset: int = 0


# Sane upper bound for an asset epoch (year ~2200). ``asset_hash_fn`` is
# contractually a freshness stat that today returns the deepest inner-file
# mtime, but a future impl could return a byte-hash — reject any value outside a
# plausible epoch range so it can never poison ``updated_date`` with a garbage
# far-future timestamp; the caller falls back to the folder mtime.
_MAX_ASSET_EPOCH = 7_258_118_400.0


def _asset_updated_epoch(record_type: str, src_path: str) -> float | None:
    """Best "real last-modified" epoch for a source path, or None.

    ``getmtime(src_path)`` catches add/remove of children; for folder-backed
    types the registered ``asset_hash_fn`` returns the deepest INNER-file mtime
    (a dir's own mtime misses child-content edits). MAX of the two so BOTH an
    added file (folder mtime moves) and an edited inner file (asset_hash moves)
    advance the stamp — this is what drives the FE body-reindex reactivity loop.
    """
    epoch: float | None = None
    try:
        epoch = os.path.getmtime(src_path)
    except OSError:
        pass
    try:
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

        info = SchemaRegistry.get(record_type)
        hash_fn = getattr(info, "asset_hash_fn", None) if info else None
        if hash_fn is not None:
            from flow_sdk.fs_store.fs_ref import FSRef  # noqa: PLC0415

            val = float(hash_fn(FSRef(src_path)))
            if 0 < val <= _MAX_ASSET_EPOCH:
                epoch = val if epoch is None else max(epoch, val)
    except (OSError, ValueError, TypeError):
        pass  # non-mtime asset_hash_fn or bad path → keep getmtime
    return epoch


# Fire-and-forget setup runs scheduled by ``Entity.setup_on_receive``. Held in a
# module set so the event loop keeps a strong ref (a bare create_task can be GC'd
# mid-run); discarded on completion.
_RECEPTION_SETUP_TASKS: set = set()


def _schedule_setup_prompt(ap, seed: str) -> None:
    """Run ``ap.prompt(seed)`` in the background so the install request returns the
    Vibe target immediately — the setup agent populates the display asynchronously."""
    import asyncio  # noqa: PLC0415

    async def _run() -> None:
        try:
            await ap.prompt(seed)
        except Exception:
            service_log.warn(f"[reception] setup prompt failed for {ap.id}", exc_info=True)

    task = asyncio.create_task(_run(), name=f"setup-{ap.id[:8]}")
    _RECEPTION_SETUP_TASKS.add(task)
    task.add_done_callback(_RECEPTION_SETUP_TASKS.discard)


def migrate_presence_shaped_members(data: Any) -> Any:
    """Move a legacy presence-shaped ``members`` value to ``presence``.

    Before the roster cache became the generic ``Entity.members``, ``Project``
    and ``CollaborationRoom`` named this field ``members`` and stored session-code
    presence rows (``{member_id, ...}``, no ``role``). Old DB rows still carry that
    key; the hub roster rows have ``user_id``/``role``. A value that is all
    presence-shaped is migrated to ``presence`` and cleared from ``members`` (the
    roster self-heals from the hub on next read). Shared by both types'
    ``mode="before"`` validators — see each ``_migrate_legacy_presence``.
    """
    if isinstance(data, dict):
        legacy = data.get("members")
        if (
            isinstance(legacy, list)
            and legacy
            and all(isinstance(m, dict) and "member_id" in m and "role" not in m for m in legacy)
        ):
            data = {**data, "presence": data.get("presence") or legacy, "members": []}
    return data


class Entity(DBEntity):
    env_vars: SerializeAsAny[EntityEnvVars[EnvVar] | None] = Field(default=None)
    visitor_role: str | None = Field(default=None)
    labels: List[str] | None = APIField(default=None)
    tags: List[str] = APIField(default_factory=list, sharing=Sharing.PRIVATE)
    system: bool = APIField(default=False, description="True when this entity belongs to an SDK-shipped system project", sharing=Sharing.PRIVATE)
    remote: bool = APIField(
        sharing=Sharing.PRIVATE,
        default=False,
        description="True when this entity has a hub counterpart at the same id; refreshable from the hub",
    )
    # Hub-authoritative role roster cache: [{user_id, email, name, role, status}].
    # Membership is a generic capability of any remote entity — a user always has
    # a hub-set role on it. This field is a pure READ CACHE: the hub is the source
    # of truth (resolved from RoleRelationship edges), written here by the reflected
    # ``members`` action mirror (see _hub_reflect.mirror_hub_response_into_local)
    # and by the conversation roster fanout, and refreshed on every roster open.
    # Renamed from the per-type ``participants`` field; the conversation WIRE key
    # stays ``participants`` (hub contract) and is adapted to ``members`` at ingest.
    members: List[dict] = APIField(
        sharing=Sharing.PRIVATE,
        default_factory=list,
        description="Hub role roster cache: [{user_id, email, name, role, status}]. Hub-authoritative; local is a read cache.",
    )
    # Git provenance + placement for an asset RECEIVED via a conversation. A raw
    # ``GitOrigin`` dict ({provider,owner,name,branch,head_commit,rel_path}) —
    # stored as json to avoid a core→builtin import cycle; construct/validate via
    # ``flow_sdk.builtin.git_origin.GitOrigin`` at the boundaries. Set ONLY on the
    # receiver when a shared file-backed asset carried a git origin in the bundle,
    # so the receiver knows the asset's intended repo-relative location even
    # without git access. ``persist=TRUE`` → written to the backend record
    # metadata.json (survives reindex), NOT the asset's user-facing file. Excluded
    # from ``share()`` (local provenance, never a hub-synced field).
    git_origin: dict | None = APIField(
        sharing=Sharing.PRIVATE,
        default=None,
        persist=Persist.TRUE,
        description="Git provenance/placement of a received shared asset (local-only; see GitOrigin).",
    )
    asset_occurrences: list[dict] = APIField(
        sharing=Sharing.PRIVATE,
        default_factory=list,
        persist=Persist.FALSE,
        description=(
            "Local filesystem occurrences for this entity, ordered primary first. "
            "DB-only and never shared or mirrored into asset metadata."
        ),
    )
    semantic_lock: bool = APIField(
        default=False,
        description=(
            "True when this entity's content is ground truth for its DependsOn "
            "targets: any target content-hash drift raises a semantic conflict "
            "(see flow_sdk/semantic_lock). Marker only — never write-protection."
        ),
    )
    fetched_at: datetime | None = APIField(
        sharing=Sharing.PRIVATE,
        default=None,
        description=(
            "When THIS device last refreshed the entity from the hub (stamped "
            "at the hub→local merge boundary). Local-only observability for "
            "cache-staleness debugging and a future TTL hook — never a "
            "correctness gate (correctness stays on updated_date/count) and "
            "never sent to the hub."
        ),
    )
    parent_type_id: str | None = APIField(
        default=None,
        description=(
            "Canonical parent reference as a ``<type>-<id>`` TypeId string. The "
            "single source of truth for parentage; reflected to disk via the "
            "declarative persist path (``BaseMeta``). Supersedes the legacy "
            "per-type ``data.parent_id`` convention. Resolve the parent entity "
            "via the async ``parent()`` accessor."
        ),
    )
    group_id: str | None = APIField(
        default=None,
        description=(
            "Folder-like containment (docs/entities-groups.md): id of the "
            "``Group`` this entity lives in; null = ungrouped (tree root). "
            "Exactly one parent — moving = one field write. Generic for every "
            "type; a Group's own parent is this same inherited field, so "
            "nesting needs no extra mechanism. Mutate via the generic "
            "``set-group`` action (or ``Group.move``) so target/cycle "
            "validation runs; persisted to metadata.json via ``BaseMeta`` so "
            "grouping survives an index rebuild."
        ),
    )
    # Tab-strip membership is no longer a base-Entity flag — it is the `Tab`
    # entity (docs/tab-management.md). `tab_order`/`last_active_at` remain
    # generic (used by the Tab entity + the `activate` action).
    tab_order: int = APIField(
        default=0,
        persist=Persist.FALSE,
        description=(
            "Strip ordering among member tabs (0 = unassigned). DB-only "
            "(Persist.FALSE) — intentionally does not survive a "
            "rebuild-from-disk (tab-management.md Part 1, decision 3)."
        ),
    )
    last_active_at: int | None = APIField(
        default=None,
        description=(
            "Epoch-ms of this entity's last activation, stamped SERVER-SIDE by "
            "the generic ``activate`` action (authoritative clock). Consumers: "
            "the tab resolver's recency seed (resolveActive case 3 — never read "
            "to highlight the active tab; the URL is active truth), and Project "
            "open-recency (stamped when the user opens the project or one of "
            "its assets; wins the project-picker sort). ISO-string values from "
            "legacy rows are parsed tolerantly on load."
        ),
    )

    @field_validator("last_active_at", mode="before")
    @classmethod
    def _last_active_at_epoch_ms(cls, value):
        """Legacy rows stored ISO strings; the field is epoch-ms. Parse
        tolerantly (via ``_as_datetime``) so no data migration is needed."""
        if isinstance(value, str):
            dt = cls._as_datetime(value)
            return int(dt.timestamp() * 1000) if dt else None
        return value

    # Locally-authoritative fields a hub refresh must NEVER overwrite. The hub
    # is the source of truth for *content*; these describe the local copy's own
    # state (do-I-have-a-hub-twin, FS-indexer flags). Subclasses extend this
    # with their own local-only state (e.g. download/body status, on-disk
    # paths). Used by ``is_stale`` / ``merge_hub_payload`` at the remote
    # boundary. ClassVar so pydantic treats it as config, not a field.
    LOCAL_ONLY_FIELDS: ClassVar[frozenset[str]] = frozenset(
        {
            "remote",
            "system",
            "fetched_at",
            "asset_occurrences",
            # This machine's on-disk path for the asset. The hub payload carries
            # the SENDER's absolute path, which is never valid here — letting it
            # land (or letting a hub refresh blank it) makes the next save
            # re-derive placement from scratch, which is how a child's folder
            # ended up nested inside its parent's. ``_BASE_LOCAL_FIELDS`` already
            # strips it from the portable JSON for the same reason; the hub
            # boundary must agree.
            "asset_ref",
        }
    )

    # The base set of SENDER-LOCAL fields that never travel in the portable entity
    # JSON (``to_common_json`` — the bundle ``entities.json`` envelope and, in
    # time, the hub push). These describe THIS machine's copy — placement, mount,
    # local provenance, local user ids, local-only projections — so the receiver
    # re-derives them. Per-type additions are declared on ``TypeInfo.local_fields``
    # (e.g. a claude_session's ``worker_session_id``) and unioned in by
    # ``_local_fields``. NOTE: dates are deliberately NOT here — the bundle
    # preserves send-time; the hub body strips them separately.
    _BASE_LOCAL_FIELDS: ClassVar[frozenset[str]] = frozenset(
        {
            # placement / mount — the receiver re-derives from its own filesystem
            "scope",
            "project_id",
            "asset_ref",
            "path",
            "fs_storage_mount_path",
            "cwd",
            "installed_root",
            # local provenance / flags
            "git_origin",
            "remote",
            "system",
            "fetched_at",
            # local user ids — do not resolve on the receiver
            "created_by",
            "updated_by",
            # local-only projections / caches
            "private_context_entities_",
            "private_context_entities",
            "private_context_entity_data",
            "shared_context_entity_data",
            "message_count",
            "tags",
            "members",
            "asset_occurrences",
            "duplicate_count",
            # pydantic computed
            "expand",
        }
    )

    # Mirror-image of LOCAL_ONLY_FIELDS for ``remote=True`` rows: fields the
    # HUB owns and local bookkeeping must never move. ``updated_date`` is the
    # LWW clock (``is_stale`` compares it) — a local re-stamp runs the clock
    # ahead of the hub, pinning ``is_stale`` False and masking real hub
    # changes. Respected by ``from_record`` (the disk→DB re-index path).
    HUB_AUTHORITATIVE_FIELDS: ClassVar[frozenset[str]] = frozenset({"updated_date"})

    # Orphan-ness ("source asset missing on disk") is no longer a stored field —
    # it is the dynamic ``FSRecord.orphan`` (``not asset_ref.exists()``),
    # computed on demand by the index/scan layer. Nothing to persist.

    # Context-entity references — split into two buckets by the rule
    # "if it came over the wire, it is shared; otherwise private."
    #
    #   * ``shared_context_entities`` is wire-bound: deserialized from incoming
    #     payloads, serialized on outbound, propagates to any reader of the
    #     entity. Mutated via ``add_shared_context_entities`` /
    #     ``remove_shared_context_entities`` from backend actions that publish
    #     a link to the thread.
    #   * ``private_context_entities_`` (trailing underscore: raw storage)
    #     is local-only: persists to disk but is excluded from the wire by
    #     ``share()``. The computed ``private_context_entities`` property
    #     merges in per-subclass direct-field projections (project_id,
    #     assignee, etc.) via ``_direct_fields_as_typeids()``.
    shared_context_entities: list[TypeId] = APIField(
        default_factory=list,
        description=(
            "Wire-bound context references. Anything received over the wire "
            "lands here; anything added via add_shared_context_entities is "
            "republished. EntityChips render this as 'lineage everyone sees'."
        ),
    )
    private_context_entities_: list[TypeId] = APIField(
        sharing=Sharing.PRIVATE,
        default_factory=list,
        description=(
            "Local-only context references. Excluded from share()/hub push. "
            "Mutated by add_private_context_entities. Read via the computed "
            "``private_context_entities`` property, which adds direct-field "
            "projections (project_id, assignee, ...) at read time."
        ),
    )

    # Sidecar storage for per-entry data harvested at detection time. Keyed by
    # ``str(typeid)`` (e.g. "plan-b034e56e-..."). For file-backed types (Plan,
    # Markdown, Skill, ClaudeMd, ClaudeCommand) we store ``{"path": ...}`` so
    # the dock loader can self-heal a 404 by single-file-indexing the file.
    #
    # BOTH fields are LOCAL-ONLY despite the "shared/private" prefix — the
    # prefix tracks which typeid bucket the entry indexes, not its wire
    # visibility. The harvested ``path`` is always an absolute filesystem
    # path on the writer's machine; replicating it to other peers via the
    # hub would leak the writer's local FS layout (PII) and the path would
    # be meaningless on the receiver anyway. ``share()`` excludes both. If
    # a future cross-link wants to carry a hub-portable hint (URL, content
    # hash, anchor), add a separate field with a translatable schema.
    shared_context_entity_data: dict[str, dict] = APIField(
        sharing=Sharing.PRIVATE,
        default_factory=dict,
        description=(
            "Per-entry sidecar for shared_context_entities. Keyed by str(typeid). "
            "Local-only despite the 'shared' prefix — see field comment."
        ),
    )
    private_context_entity_data: dict[str, dict] = APIField(
        sharing=Sharing.PRIVATE,
        default_factory=dict,
        description=(
            "Per-entry sidecar for private_context_entities_. Same shape as "
            "shared_context_entity_data; both excluded from share()/hub push."
        ),
    )

    # Display label. BOTH are declared on the base and BOTH are optional, so
    # every entity type carries the same two slots on both sides of the hub
    # boundary — a payload that arrives under the "other" key is stored, not
    # silently dropped by pydantic's extra="ignore". Each type still AUTHORS
    # exactly one of them (``name`` for project/org/team/…, ``title`` for
    # task/page/…) and may override it with a required `str`; the display
    # chain (``APIEntity.defaultDisplayName``, ``iconForType`` callers,
    # invitation label resolution) reads ``name or title``.
    name: str | None = APIField(default=None, description="Display name")
    title: str | None = APIField(default=None, description="Display title")
    _icon: ClassVar[str | None] = None

    # Per-type schema for the sidecar ``{shared,private}_context_entity_data``
    # values when this Entity's typeid is referenced from another entity's
    # context bucket. None means "no declared shape" — sidecar writes against
    # this type pass through without validation. Subclasses override to
    # declare a Pydantic model (e.g. PlanContextData) and ``_add_to_bucket``
    # validates incoming data best-effort against it.
    context_data_schema: ClassVar[type | None] = None

    # Optional per-instance FS storage configuration
    # If not set, falls back to class default via get_default_fs_storage_provider()
    fs_storage_provider: StorageProvider | None = Field(default=None)
    fs_storage_mount_path: str | None = EntityField(default=None, sharing=Sharing.PRIVATE)

    # VFS path relative to a root entity (e.g., compute node)
    root_vfs_path: str | None = APIField(default=None, description="VFS path relative to a root entity")

    scope: str | None = APIField(
        sharing=Sharing.PRIVATE,
        default=None,
        description="Discovery scope: 'user' | 'project' | 'system'. Stamped from the asset path at the save chokepoints (from_record / _prepare_for_storage) and by the FSRef walk at index time.",
    )
    project_id: str | None = APIField(
        sharing=Sharing.PRIVATE,
        default=None, description="Owning project id, when applicable. Stamped at index time from the FSRef walk."
    )

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        if self.env_vars is None:
            self.env_vars = EntityEnvVars[EnvVar]()

    # Per-subclass entityEvent registry: event name → handler method name.
    # Method-name (not bound) so subclass overrides resolve at call time.
    _entity_event_handlers: ClassVar[dict[str, str]] = {}

    @classmethod
    def on_event(cls, event_name: str):
        """Register a method as the handler for a named entityEvent.

        Usage::

            class MyEntity(Entity):
                async def handle_ping(self, payload): ...

            Entity.on_event("ping")(MyEntity.handle_ping)

        Subclass-local: each subclass gets its own copy of the registry on
        first registration so registrations don't leak across siblings.
        """

        def deco(fn):
            handlers = cls.__dict__.get("_entity_event_handlers")
            if handlers is None:
                handlers = dict(getattr(cls, "_entity_event_handlers", {}))
                cls._entity_event_handlers = handlers
            handlers[event_name] = fn.__name__
            return fn

        return deco

    @classmethod
    def _lookup_event_handler(cls, event_name: str) -> str | None:
        """Walk the MRO to find an event handler registered on self or a parent."""
        for klass in cls.__mro__:
            handlers = klass.__dict__.get("_entity_event_handlers")
            if handlers and event_name in handlers:
                return handlers[event_name]
        return None

    async def entity_event(self, event: str = "", payload: dict | None = None) -> "ApiResponse":
        """Generic entity-addressed event dispatcher.

        TS-side ``APIEntity.entityEvent(name, payload)`` lands here for any
        entity type. Body params: ``event`` (str), ``payload`` (dict). Looks
        up the method registered via ``Entity.on_event(<name>)(method)`` on
        this instance's class (or any parent), and invokes it. Unregistered
        events return a noop success — never a 404 — because the wire
        surface is intentionally generic.
        """
        from flow_sdk.responses.response import ApiSuccessResponse  # noqa: PLC0415

        payload = payload or {}
        handler_name = type(self)._lookup_event_handler(event)
        if not handler_name:
            return ApiSuccessResponse(data={"status": "noop", "event": event})
        handler = getattr(self, handler_name)
        result = handler(payload)
        if inspect.iscoroutine(result):
            result = await result
        return ApiSuccessResponse(data={"status": "ok", "event": event, "result": result})

    async def rename(self, name: str) -> None:
        """Adopt ``name`` as this entity's display name and persist.

        This is the generic reflection target for a tab rename: ``Tab.rename``
        calls ``target.rename(name)`` so the new tab label is mirrored onto the
        backing entity for ANY type that has one — a conversation, an
        agentic_process, a shell, a markdown — without the Tab branching on
        ``target_type`` (slick P6). Subclasses MAY override to add side effects
        (shell/agentic_process pin ``auto_rename=False`` so a PTY/worker title
        can't clobber the user-chosen name). Empty/unchanged names are a no-op.
        """
        if name and self.name != name:
            self.name = name
            await self.save()

    @classmethod
    async def search(
        cls,
        query: str,
        limit: int = 10,
        record_type: str | None = None,
        status: str | None = None,
        calibration: "Any | None" = None,
    ) -> list[Entity]:
        """Full-text search using FTS5 MATCH. Returns Entity objects."""
        if not query:
            return []
        from flow_sdk.db import get_db_driver

        driver = get_db_driver()
        if not hasattr(driver, "fts_search"):
            return []
        return await driver.fts_search(
            query=query, limit=limit, record_type=record_type, status=status, calibration=calibration
        )

    @classmethod
    async def browse(
        cls,
        record_type: str,
        limit: int = DEFAULT_BROWSE_LIMIT,
        status: str | None = None,
    ) -> list[Entity]:
        """List entities of a type with FTS metadata, ordered by recency.

        Used for filter-only browsing (no search query). Returns fts_title
        populated so callers can display meaningful names without filesystem reads.
        """
        from flow_sdk.db import get_db_driver

        driver = get_db_driver()
        if not hasattr(driver, "browse_by_type"):
            return []
        return await driver.browse_by_type(entity_type=record_type, limit=limit, status=status)

    @classmethod
    async def assets_by_path(cls, opts: PathQueryOptions) -> list["Entity"]:
        """Return entities whose ``asset_ref`` is a strict descendant of any
        folder in ``opts.search_dirs``.

        Pushdown: each search dir becomes a half-open lex range
        ``asset_ref >= "<dir>/" AND asset_ref < "<dir>0"`` against
        ``json_extract(data, '$.asset_ref')`` (`/` is `0x2F`, next codepoint
        is `0`). Multiple dirs are OR'd. The query is dispatched per type
        because the SQL driver mandates a type filter — when ``opts.types``
        is None, every registered type is queried. Results are union'd,
        sorted by ``asset_ref``, then paged.
        """
        from flow_sdk.fs_store.path_utils import canonical_posix_path

        if not opts.search_dirs:
            return []

        folder_terms: list[ExpressionNode] = []
        for d in opts.search_dirs:
            f = canonical_posix_path(d).rstrip("/")
            if not f:
                continue
            folder_terms.append(
                ExpressionNode(
                    op=QueryOp.AND,
                    operands=[
                        ExpressionNode(op=QueryOp.GE, operands=["asset_ref", f + "/"]),
                        ExpressionNode(op=QueryOp.LT, operands=["asset_ref", f + "0"]),
                    ],
                )
            )
        if not folder_terms:
            return []

        folder_expr: ExpressionNode = (
            folder_terms[0] if len(folder_terms) == 1 else ExpressionNode(op=QueryOp.OR, operands=folder_terms)
        )

        match: ExpressionNode = folder_expr
        if not opts.include_system:
            match = ExpressionNode(
                op=QueryOp.AND,
                operands=[
                    match,
                    ExpressionNode(op=QueryOp.NE, operands=["system", True]),
                ],
            )

        types_to_query = opts.types if opts.types else SchemaRegistry.get_all_entity_types()

        # Each per-type query needs at most ``offset + limit`` rows; the global
        # offset is applied after merge because rows are split across types.
        per_type_limit = (opts.offset + opts.limit) if opts.limit else None

        results: list[Entity] = []
        for type_name in types_to_query:
            qf = QueryFilter(
                type=type_name,
                match=match,
                limit=per_type_limit,
                order_by={"asset_ref": "asc"},
            )
            results.extend(await cls.get_all(qf))

        results.sort(key=lambda e: getattr(e, "asset_ref", "") or "")
        end = opts.offset + opts.limit if opts.limit else None
        return results[opts.offset : end]

    @classmethod
    async def get_by_asset_ref(cls, path: "str | Path", *, resolve_containing: bool = False) -> "Entity | None":
        """Resolve the single entity whose ``asset_ref`` equals ``path``.

        ``asset_ref`` is globally unique (one entity per file path across all
        types), so the first hit is THE entity. Queries every file-backed type
        (those declaring an ``asset_ref`` field) in parallel — the generic
        replacement for the per-type resolution loops the cross-link helpers
        used to carry.

        ``resolve_containing`` (opt-in — the default keeps the strict
        exact-match contract existing callers rely on): when the exact match
        misses, a file INSIDE a folder-backed asset resolves to its owning
        entity — the path's ancestor directories are matched (one
        ``asset_ref IN (...)`` query per ``folder_backed`` type) and the
        deepest hit wins, e.g. any file under ``.claude/skills/foo/`` resolves
        to the ``foo`` Skill. Exact match always wins over containment.
        Returns ``None`` when no entity owns the path.
        """
        import asyncio  # noqa: PLC0415

        path_str = str(path)
        candidates = [
            ecls for ecls in SchemaRegistry.get_all_entity_classes() if "asset_ref" in getattr(ecls, "model_fields", {})
        ]

        async def _try(ecls: type) -> "Entity | None":
            try:
                return await ecls.get_one({"asset_ref": path_str})
            except Exception:
                return None

        for result in await asyncio.gather(*[_try(c) for c in candidates]):
            if result is not None:
                return result

        if not resolve_containing:
            return None
        return await cls._get_by_containing_folder(path_str, candidates)

    @classmethod
    async def _get_by_containing_folder(cls, path_str: str, candidates: list[type]) -> "Entity | None":
        """Deepest folder-backed entity whose ``asset_ref`` is an ancestor dir
        of ``path_str``. Pure DB lookup (indexed ``asset_ref IN`` per type) —
        no disk access, no discovery."""
        import asyncio  # noqa: PLC0415

        from flow_sdk.fs_store.path_utils import ancestors_of

        ancestors = ancestors_of(path_str)
        if not ancestors:
            return None

        def _folder_backed(ecls: type) -> bool:
            info = SchemaRegistry.get(ecls.get_type())
            return info is not None and info.folder_backed

        folder_types = [ecls for ecls in candidates if _folder_backed(ecls)]

        async def _hits(ecls: type) -> "list[Entity]":
            try:
                return await ecls.get_all(
                    QueryFilter(
                        type=ecls.get_type(),
                        match=ExpressionNode(op=QueryOp.IN, operands=["asset_ref", ancestors]),
                    )
                )
            except Exception:
                return []

        all_hits = [e for hits in await asyncio.gather(*[_hits(t) for t in folder_types]) for e in hits]
        return max(all_hits, key=lambda e: len(getattr(e, "asset_ref", "") or ""), default=None)

    @classmethod
    def allocate_id(cls, data: dict) -> str:
        """Return a stable UUID for this entity type given creation data.

        Validate-on-adopt + single minter:
        - If data['id'] is a **conforming** entity id (UUID v4/v5) → keep it.
        - Else if data['id'] is non-empty (a slug, or a foreign/non-conforming
          uuid such as a v7) → derive a stable ``uuid5(type:id)`` (normalizes
          it; a hand-authored v7 never survives as the id).
        - If empty/absent → fresh random uuid4.

        All cases route through ``mint_uuid`` so the version policy lives in one
        place. Override in subclasses with a natural fs identity key (e.g.
        Project uses fs_storage_mount_path).
        """
        import uuid as _uuid

        from flow_sdk.fs_store.identifier import is_valid_entity_id, mint_uuid

        rid = data.get("id") or ""
        if rid and is_valid_entity_id(rid):
            return rid
        if rid:
            type_str = data.get("type") or "record"
            return mint_uuid(f"{type_str}:{rid}", namespace=_uuid.NAMESPACE_DNS)
        return mint_uuid()

    @classmethod
    async def from_record(cls, record: "Record", notify: bool = True) -> Entity:
        """Create or update an Entity from a Record's meta_dict()."""
        record_type = record.type or record._record_type
        entity_cls = SchemaRegistry.get_entity_cls(record_type) or cls
        if cls is Entity and entity_cls is not cls and "from_record" in entity_cls.__dict__:
            token = _SUPPRESS_STORE.set(True)
            try:
                return await entity_cls.from_record(record, notify=notify)
            finally:
                _SUPPRESS_STORE.reset(token)
        data = record.meta_dict()
        # Lift the type's DECLARED typed metadata out of the nested ``metadata``
        # section onto top-level entity fields — symmetric with the DOWN path
        # (``metadata_payload``), which writes exactly the ``meta_model`` fields.
        # ``extract_*`` parsers stash known fields under a single ``metadata``
        # key that ``meta_dict()`` keeps nested; without this the DB row silently
        # keeps entity-field DEFAULTS for every meta_model field (e.g. deck
        # ``num_slides``/``html_file``/``template_ref``, deck_template
        # ``num_layouts``) — the drift ``_build_from_fs_record`` already corrects
        # for the DB-free ``from_fs_ref`` loader. Scoped to meta_model field
        # names so arbitrary carrier keys stay nested for types that expose a
        # generic ``metadata`` dict field (e.g. a skill's ``eval``); ``metadata``
        # is left in ``data`` so that dict field still populates.
        _nested = data.get("metadata")
        if isinstance(_nested, dict):
            _mm = getattr(SchemaRegistry.get(record_type), "meta_model", None)
            for _k in getattr(_mm, "model_fields", None) or {}:
                if _k in _nested and _k not in data:
                    data[_k] = _nested[_k]
        entity_uuid = entity_cls.allocate_id(data)
        # Filter by the *record's* type, not entity_cls.get_type(). The latter
        # is "entity" when entity_cls falls back to base Entity (most types
        # have no registered subclass), which would miss the existing typed
        # row and force a duplicate-create path that silently drops writes.
        entity = await entity_cls.get_one(QueryFilter.parse({"id": entity_uuid}, record_type))

        # Collect domain fields the entity understands but meta_dict() omits.
        # Only fetch the SPECIFIC missing fields — never call to_dict(), which on
        # ClaudeSessionRecord materialises 27 PropertyRecord descriptors and
        # triggers a full JSONL parse just to populate fields no caller asked for.
        # Pulling fields one-by-one with getattr still triggers the same descriptor
        # cache (e.g. _get_session_batch_stats) on first access — but only when an
        # entity field actually requires it, and only once per record.
        record_domain: dict = {}
        if entity_cls is not cls and hasattr(entity_cls, "model_fields"):
            entity_field_names = set(entity_cls.model_fields.keys())
            missing = entity_field_names - set(data.keys()) - {"id", "type"}
            if missing:
                record_fields = set(getattr(record, "_property_types", None) or {}) | set(
                    object.__getattribute__(record, "__dict__").keys()
                )
                for k in missing & record_fields:
                    try:
                        record_domain[k] = getattr(record, k, None)
                    except Exception:
                        record_domain[k] = None

        # Bridge the FSRef-derived scope/project_id from the Record onto the
        # Entity. Both columns live on the base Entity, so every type inherits.
        rec_scope = getattr(record, "scope", None)
        rec_scope = rec_scope.value if hasattr(rec_scope, "value") else rec_scope
        rec_pid = getattr(record, "project_id", None)
        # Source path the extractor set (asset_ref / source_file / path) — drives
        # both the scope fallback here and the mtime derivation further down.
        src_path = data.get("asset_ref") or data.get("source_file") or data.get("path")
        stamp: dict = {}
        if rec_scope not in (None, ""):
            stamp["scope"] = str(rec_scope)
        else:
            # Record-first saves that didn't come from an FSRef walk (e.g. an
            # HTTP create) carry no scope — derive it from the on-disk path so
            # the row is labeled here, not via a per-edge post-create patch.
            inferred = cls._scope_from_path(src_path)
            if inferred:
                stamp["scope"] = inferred
        if rec_pid not in (None, ""):
            stamp["project_id"] = str(rec_pid)

        # Real last-modified: when the record carries no explicit updated_date,
        # derive it from the source's mtime so search/listing reflect actual
        # activity rather than the index/sync instant (see _asset_updated_epoch —
        # it also folds inner-file mtimes for folder types so a child-content edit
        # advances the stamp, which drives the FE body-reindex reactivity loop).
        # Falls back to now() when no path resolves. One generic hook for every
        # file-backed indexed type — no per-extractor stamping.
        _asset_mtime = None
        if data.get("updated_date") is None and src_path:
            _epoch = _asset_updated_epoch(record_type, src_path)
            if _epoch is not None:
                try:
                    _asset_mtime = datetime.fromtimestamp(_epoch, tz=timezone.utc)
                except (OSError, ValueError, OverflowError):
                    pass

        if entity is None:
            create_kwargs = {"id": entity_uuid, "type": record_type}
            create_kwargs.update({k: v for k, v in data.items() if k not in ("id", "type")})
            create_kwargs.update(record_domain)
            create_kwargs.update(stamp)
            try:
                entity = entity_cls(**create_kwargs)
            except Exception:
                entity = Entity(**create_kwargs)
            if _asset_mtime is not None:
                entity.updated_date = _asset_mtime
        else:
            entity.type = record_type
            # Hub-owned fields (the LWW clock), captured before the setattr loop
            # can overwrite them with stale disk-mirrored values from meta_dict().
            hub_owned = {f: getattr(entity, f, None) for f in type(entity).HUB_AUTHORITATIVE_FIELDS}
            all_updates = {**data, **record_domain, **stamp}
            for k, v in all_updates.items():
                # Restrict to declared model fields so read-only computed
                # properties leaked in by stale metadata don't crash setattr.
                if k in ("id",) or k not in entity.__class__.model_fields:
                    continue
                field = entity.__class__.model_fields.get(k)
                if field is not None:
                    v = TypeAdapter(field.annotation).validate_python(v)
                setattr(entity, k, v)
            if getattr(entity, "remote", False):
                # Hub-authoritative rows: restore HUB_AUTHORITATIVE_FIELDS — a
                # disk→DB re-index must not move the hub's clock (see the
                # classvar). Index freshness is carried by the on-disk .hash
                # sentinel, not by updated_date. The driver preserves a
                # non-None updated_date on save.
                for f, v in hub_owned.items():
                    setattr(entity, f, v)
            elif _asset_mtime is not None:
                # Stamp the source file's real last-modified, not now(). Freshness
                # still holds: updated_date equals the file mtime right after
                # indexing, and a later edit pushes file_mtime past it.
                entity.updated_date = _asset_mtime
            elif data.get("updated_date") is None:
                # No record-supplied date and no source file — advance to now()
                # so the freshness check (file_mtime ≤ updated_date) can still
                # detect the next change. Reset so apply_update_fields stamps it.
                entity._db.reset_update_fields(entity)
            # else: the record supplied an explicit updated_date — kept as applied
            # by the setattr loop above.

        # Propagate PropertyRecord values to matching entity fields
        already_set = set(data.keys()) | set(record_domain.keys())
        if hasattr(record, "_property_types"):
            for prop_name in record._property_types:
                if hasattr(entity, prop_name) and prop_name not in already_set:
                    try:
                        setattr(entity, prop_name, record.get_prop(prop_name))
                    except Exception:
                        pass
        # from_record is the disk→DB adopt path: persist the DB row only, never
        # write back to disk. The record we just read IS the source of truth;
        # re-writing it is what creates the indexer loop. Suppressing store()
        # via the contextvar makes that structurally impossible (not dependent
        # on mtime timing) and works through any save() override.
        token = _SUPPRESS_STORE.set(True)
        try:
            await entity.save(notify=notify)
        finally:
            _SUPPRESS_STORE.reset(token)
        return entity

    @classmethod
    def from_fs_ref(
        cls,
        ref: "FSRef",
        record_type: "str | None" = None,
    ) -> "Entity | None":
        """Load an Entity from a folder/file ``FSRef`` WITHOUT touching the DB.

        A DB-free on-disk load: it resolves identity through ``TypeInfo`` and
        dispatches to the registered ``from_disk_fn`` — the SAME cold-path parser the indexer runs
        (e.g. ``extract_dataset``) — and builds the entity generically from the
        returned ``FSRecord``. Only that parser (and, for datasets, the
        ``iter_examples`` it reaches via ``Dataset.examples()``) is type-specific;
        everything here is generic and registry-driven.

        Distinct from the async ``from_record``: no ``await``, no ``save()``, no
        DB row. A missing asset id may be minted and persisted. Use it to load a folder-backed entity and call its on-disk
        accessors (``Dataset.examples()`` etc.). Returns ``None`` when ``ref`` is
        not a record of the resolved type (the parser yields nothing).
        """
        from flow_sdk.schema.type_info import register_all  # noqa: PLC0415

        # ``from_disk_fn`` is only wired by ``register_all`` (importing an entity
        # module registers its class but not its parser). Idempotent — cheap to
        # call on every load.
        register_all()

        rt = cls._resolve_fs_ref_type(ref, record_type)
        if rt is None:
            return None
        info = SchemaRegistry.get(rt)
        if info is None or info.from_disk_fn is None:
            return None

        resolved_id = info.extract_id(ref) or info.mint_id(ref)
        records = info.from_disk_fn(ref, resolved_id)
        if not records:
            return None
        return Entity._build_from_fs_record(records[0], fallback_cls=cls)

    @classmethod
    def _resolve_fs_ref_type(cls, ref: "FSRef", record_type) -> "str | None":
        """Resolve the record-type string for an ``FSRef``.

        Precedence: explicit ``record_type`` arg → ``ref.record_type`` → the
        concrete subclass's own declared ``type`` default (so
        ``Dataset.from_fs_ref(ref)`` self-identifies as ``"dataset"`` even for a
        bare folder ref). Base ``Entity`` with no hint yields ``None``.
        """
        if record_type is not None:
            return str(record_type)
        if ref.record_type is not None:
            return str(ref.record_type)
        if cls is not Entity:
            type_field = cls.model_fields.get("type")
            default = getattr(type_field, "default", None) if type_field else None
            if isinstance(default, str) and default:
                return default
        return None

    @staticmethod
    def _build_from_fs_record(record: "FSRecord", fallback_cls: "type | None" = None) -> "Entity":
        """Build a typed Entity from an ``FSRecord``, DB-free.

        Flattens the record's nested ``metadata`` section onto the entity's typed
        fields. ``extract_*`` parsers stash the known fields under a single
        ``metadata`` key, which ``meta_dict()`` keeps nested — the async
        ``from_record`` does NOT lift it, so this loader must. The ``asset_ref``
        path string is preserved so on-disk accessors resolve.
        """
        rt = record.type or getattr(record, "_record_type", None)
        entity_cls = SchemaRegistry.get_entity_cls(rt) or fallback_cls or Entity

        data = record.meta_dict()
        nested = data.pop("metadata", None)
        if isinstance(nested, dict):
            # The nested ``metadata`` section is the typed source of truth; let it
            # win over the duplicated top-level shells (name/status/content).
            data = {**data, **nested}

        model_fields = getattr(entity_cls, "model_fields", {})
        fields = {k: v for k, v in data.items() if k in model_fields}
        try:
            entity = entity_cls(**fields)
        except Exception:
            entity = Entity(**{k: v for k, v in fields.items() if k in Entity.model_fields})

        # Stamp asset_ref even for types that don't declare it as a field.
        if "asset_ref" in data and "asset_ref" not in fields:
            object.__setattr__(entity, "asset_ref", data["asset_ref"])
        return entity

    async def _fts_upsert(self, type_name: str, content: str) -> None:
        """Upsert this entity into the FTS5 table with the given content."""
        from flow_sdk.db import get_db_driver
        from flow_sdk.db.drivers.sqlite.sqlite_driver import FtsEntry

        driver = get_db_driver()
        if hasattr(driver, "fts_upsert"):
            await driver.fts_upsert(
                FtsEntry(
                    entity_id=self.id,
                    entity_type=type_name,
                    name=getattr(self, "name", None) or None,
                    content=content,
                )
            )

    async def get_record(self) -> "FSRecord | None":
        """Return the fs-record associated with this entity, or None if none exists."""
        from flow_sdk.fs_store.fs_record import FSRecord  # noqa: PLC0415 — lazy

        return FSRecord.load_or_none(self.get_type(), self.id)

    async def destroy(self) -> None:
        """Erase this entity's entire existence: the DB row + relationships AND
        its on-disk record folder.

        Unlike :meth:`delete` (DB row + relationships only — the on-disk shadow
        folder is left behind), ``destroy`` routes through the record so the
        whole ``<records_root>/<type>/<type>-@<id>/`` tree is removed too.
        Falls back to a plain ``delete`` for entities that have no record."""
        rec = await self.get_record()
        if rec is not None:
            await rec.destroy()
        else:
            await self.delete()

    async def updateSearchIndex(self) -> None:
        """Write this entity's searchable content into the FTS5 table.

        Content is sourced from the linked record's search_content. No-op if entity
        has no linked record or record returns None.
        """
        record = await self.get_record()
        if record is None:
            return
        content = record.search_content
        if content is None:
            return
        await self._fts_upsert(self.get_type(), content)

    async def removeSearchIndex(self) -> None:
        """Remove this entity from the FTS5 table."""
        from flow_sdk.db import get_db_driver

        driver = get_db_driver()
        if hasattr(driver, "fts_delete"):
            await driver.fts_delete(self.id)

    def metadata_payload(self) -> dict:
        """Resolve which entity fields are mirrored into metadata.json.

        Per-field ``persist`` policy (declared on the APIField):
          - TRUE    → always written.
          - FALSE   → never written (DB-only: computed/denormalized/runtime).
          - DEFAULT → written iff the field name is declared in the type's
                      metadata model (``TypeInfo.meta_model``), falling back to
                      ``BaseMeta`` when a type registers none.
        ``None`` values are omitted so a stale field never clobbers a fresh
        on-disk one under partial-merge.
        """
        from flow_sdk.api.api_types.api_field import Persist, persist_policy
        from flow_sdk.fs_store.schema_registry import SchemaRegistry
        from flow_sdk.schema.type_info.base_meta import BaseMeta

        info = SchemaRegistry.get(self.get_type())
        meta_model = (getattr(info, "meta_model", None) if info else None) or BaseMeta
        model_field_names = set(getattr(meta_model, "model_fields", {}) or {})

        out: dict = {}
        for name, field in self.__class__.model_fields.items():
            if name in ("id", "type") or name.startswith("_"):
                continue
            policy = persist_policy(field)
            if policy == Persist.FALSE:
                continue
            if policy == Persist.DEFAULT and name not in model_field_names:
                continue
            v = getattr(self, name, None)
            if v is None:
                continue
            out[name] = v
        return out

    async def store(self) -> "Record | None":
        """Sync entity metadata DOWN to its record on disk.

        Discovers the record for this entity type and id, writes the persisted
        meta fields (per ``metadata_payload``) via ``record.save_metadata``, and
        upserts the main asset body. Returns the record, or None if none exists.
        """
        return await self._store()

    async def _store(self) -> "Record | None":
        """Sync entity metadata DOWN to its record on disk.

        Callable as self._store() or Entity._store(entity) for testing and internal use.
        Returns None if entity has no associated record, or if a disk error occurs.
        """
        entity = self
        # If entity has a record_data_ref attribute explicitly set to None,
        # there is no associated record.
        if hasattr(entity, "record_data_ref") and entity.record_data_ref is None:
            return None
        type_name = entity.get_type()
        # FSRecord is the single record class. Load the shadow if present;
        # otherwise construct a fresh one with the entity's id+type.
        from flow_sdk.fs_store.fs_record import FSRecord

        try:
            record = FSRecord.load(type_name, entity.id)
        except FileNotFoundError:
            record = FSRecord(type=type_name, id=entity.id)
        # Propagate any pre-resolved asset_ref string from the entity (set in
        # _prepare_for_storage) onto the record so main_ref resolves correctly.
        if record.asset_ref is None:
            ar_str = getattr(entity, "asset_ref", None)
            if ar_str:
                from flow_sdk.fs_store.fs_ref import FSRef

                record.asset_ref = FSRef(ar_str)
        # The single declarative DB→disk write: persisted fields + the special
        # asset_ref (always mirrored so main_ref resolves). Partial-merge, so
        # action/indexer-written keys this entity doesn't own are preserved.
        payload = entity.metadata_payload()
        ar_str = getattr(entity, "asset_ref", None)
        if ar_str:
            payload["asset_ref"] = ar_str
        import asyncio

        try:
            # upsert_main_ref writes default_body iff main_ref doesn't exist
            # — write goes through the FSRef contract, never raw Path.write_text.
            await asyncio.to_thread(record.upsert_main_ref, entity)
            await asyncio.to_thread(record.save_metadata, payload)
        except Exception as exc:
            from flow_sdk.fs_store.operations.record_error import from_exception  # lazy (circular-safe)

            from_exception(record, exc, trigger="store").save()
            return None
        # Immediately index into FTS5 so the entity is searchable without a scan.
        content = record.search_content
        if content is not None:
            await entity._fts_upsert(type_name, content)
        return record

    async def _resolve_scope_project(self) -> "Entity | None":
        """Return the project entity when the request is project-scoped
        (POST /api/v1/graph/project/<id>/<type>), else None."""
        from flow_sdk.request_context.methods import get_current_request_info

        request_info = get_current_request_info()
        if (
            request_info is not None
            and getattr(request_info, "target_entity_typeid", None) is not None
            and request_info.target_entity_typeid.type == "project"
        ):
            try:
                return await request_info.get_target_entity()
            except Exception:
                return None
        return None

    async def _resolve_scope_root(self, scope_project: "Entity | None" = None) -> "Path | None":
        """Resolve filesystem scope root from request_context.

        Project context (POST /api/v1/graph/project/<id>/<type>) →
        ``project.fs_storage_mount_path``. Otherwise → per-instance user_home.

        Single source of truth for scope, called once per save(); per-type
        ``store()`` overrides must not duplicate this logic. ``scope_project``
        carries a project the caller already resolved (avoids re-resolving).

        The actual root computation is delegated to ``placement.root_for_scope``
        (the single authority shared with the receive path), so create and
        receive can no longer diverge on what "user root" means.
        """
        from flow_sdk.fs_store.placement import Scope, root_for_scope  # noqa: PLC0415

        proj = scope_project or await self._resolve_scope_project()
        mount = getattr(proj, "fs_storage_mount_path", None) if proj is not None else None
        if mount:
            return root_for_scope(Scope.PROJECT, project_mount=mount)
        return root_for_scope(Scope.USER)

    async def _resolve_repo_parent_container(self, info) -> "Path | None":
        """Container for a REPO child = its parent REPO asset's folder, so the
        child nests at ``<parent-folder>/agentic-assets/<type>/<name>`` (the
        recursive repo layout). Returns None when this isn't a repo child, the
        parent is missing/not-yet-placed, or the parent is a (leaf) file asset.
        """
        from pathlib import Path  # noqa: PLC0415

        from flow_sdk.fs_store.placement import AssetClass  # noqa: PLC0415

        if getattr(info, "asset_class", None) != AssetClass.REPO:
            return None
        parent = await self.parent()
        if parent is None:
            return None
        pinfo = SchemaRegistry.get(parent.get_type())
        if pinfo is None or pinfo.asset_class != AssetClass.REPO:
            return None
        par_ref = getattr(parent, "asset_ref", None)
        if not par_ref or pinfo.main_layout != "folder":
            return None  # a repo child can only nest inside a folder-backed parent
        # The parent's asset FOLDER owns where the child's agentic-assets/ goes.
        return pinfo.folder_for(Path(par_ref))

    async def check_and_refresh_record(self) -> bool:
        """If the source asset changed since the last index, re-sync. Returns
        True if a refresh happened. Freshness is the record's own on-disk
        ``index_required`` (source hash vs the index sentinel) — no DB read."""
        from flow_sdk.fs_store.fs_record import record_sync_guard

        async with record_sync_guard(self.get_type(), self.id):
            record = await self.get_record()
            if record is None:
                return False
            # Project records intentionally mirror their mount as
            # ``fs_storage_mount_path`` rather than a generic ``asset_ref``.
            # Bind that derived ref before checking the sentinel; otherwise an
            # unbound fresh record hashes as "" and every GET becomes a false
            # disk->DB writer.
            record.ensure_asset_ref()
            if not record.index_required:
                return False
            try:
                await record.sync_to_db()
                record.write_hash()
            except Exception:
                pass
            return True

    # ==================== Wiki link capability ====================
    # Mirrors Record.get_links / Record.get_backlinks. Both call into the
    # same flow_sdk.wiki module — the wiki layer takes only (type, id) and
    # is agnostic to who called.

    async def get_links(self) -> list:
        """Outgoing wiki links from this entity."""
        from flow_sdk import wiki

        return await wiki.outgoing(self.type, self.id)

    async def get_backlinks(self) -> list:
        """Inbound wiki links pointing at this entity."""
        from flow_sdk import wiki

        return await wiki.backlinks(self.type, self.id)

    async def reindex(self, body: str | None = None) -> list[dict]:
        """Re-extract wiki edges for this entity.

        ``body=None`` → load the linked record and read its ``wiki_body()``.
        Provide ``body`` directly for callers that already have it (e.g. the
        markdown editor toolbar after an out-of-band insert).

        Returns the resulting outgoing edges as plain dicts (same shape as
        ``GET /api/v1/graph/{type}/{id}/wiki/links``).
        """
        from flow_sdk import wiki

        if body is None:
            rec = await self.get_record()
            if rec is not None:
                body = rec.wiki_body()

        await wiki.index(self.type, self.id, body)
        return [
            {
                "id": e.id,
                "src_type": e.src_type,
                "src_id": e.src_id,
                "raw": e.raw,
                "target_type": e.target_type,
                "target_id": e.target_id,
                "line": e.line,
            }
            for e in await wiki.outgoing(self.type, self.id)
        ]

    def tooltip_summary(self) -> dict[str, str | None]:
        """Per-entity hover summary for favorite tiles / bookmark cards.

        Default: name only. Subclasses override to add a subtitle (e.g.
        AgenticProcess returns its last prompt).
        """
        return {"name": self.name, "subtitle": None}

    async def _favorite_bookmark(self):
        """Find this entity's favorite Bookmark for the current user, if any.

        Same shape as ``ui/src/hooks/use-favorites.ts`` matches on:
        ``bookmark_type='favorite'`` + ``data.entity_type`` + ``data.entity_id``.
        Owner-scoping is enforced by the request's auth context (the bookmark
        query only returns rows the current user can read).
        """
        from flow_sdk.builtin.bookmark import Bookmark, BookmarkType  # noqa: PLC0415

        bookmarks = await Bookmark.get_all(
            QueryFilter.by_type("bookmark", {"bookmark_type": BookmarkType.FAVORITE.value})
        )
        my_type = self.get_type()
        my_id = str(self.id)
        for b in bookmarks:
            data = b.data if isinstance(b.data, dict) else None
            if not data:
                continue
            if data.get("entity_type") == my_type and data.get("entity_id") == my_id:
                return b
        return None

    async def favorite(self, title: str | None = None):
        """Mark this entity as favorited for the current user. Idempotent —
        returns the existing favorite Bookmark if already favorited (without
        renaming it; use ``Bookmark.name = ...; save()`` to rename after).

        :param title: Display label for the favorite tile / star tooltip.
            Defaults to ``self.name`` when omitted. Mirrors the ``title`` field
            of ``useFavorites.addFavorite`` on the frontend.

        The Bookmark shape matches what the UI writes, so the watched
        bookmark query on the frontend re-fetches and re-renders
        ``FavoriteStar`` / ``FavoriteTile`` automatically.
        """
        from flow_sdk.builtin.bookmark import Bookmark, BookmarkType  # noqa: PLC0415
        from flow_sdk.request_context.methods import get_current_request_info  # noqa: PLC0415

        request_info = get_current_request_info()
        user = request_info.user if request_info is not None else None
        if user is None:
            raise ValueError("Entity.favorite() requires an authenticated user in the request context")

        existing = await self._favorite_bookmark()
        if existing is not None:
            return existing

        nav: dict[str, str] = {}
        asset_ref = getattr(self, "asset_ref", None)
        if asset_ref:
            nav["asset_ref"] = str(asset_ref)
        icon = getattr(getattr(self, "type_info", None), "icon", None)
        data: dict[str, object] = {
            "entity_type": self.get_type(),
            "entity_id": str(self.id),
        }
        if nav:
            data["nav"] = nav
        if icon:
            data["icon"] = icon

        # title=None → match useFavorites.addFavorite: set bookmark.title only
        # (UI falls back to live summary.name from tooltip_summary, so the tile
        # tracks the entity's current name).
        # title="<custom>" → match useFavorites.renameFavorite: set bookmark.name
        # as well so the custom label wins over the live summary.
        kwargs: dict[str, object] = {
            "bookmark_type": BookmarkType.FAVORITE.value,
            "title": (title if title is not None else self.name) or "",
            "source": "entity.favorite",
            "data": data,
        }
        if title is not None and title.strip():
            kwargs["name"] = title
        bookmark = Bookmark(**kwargs)
        await bookmark.save(owner=user)
        return bookmark

    async def unfavorite(self) -> bool:
        """Remove this entity's favorite Bookmark for the current user.
        Idempotent — returns True if a favorite was deleted, False if none
        existed.
        """
        existing = await self._favorite_bookmark()
        if existing is None:
            return False
        await existing.delete()
        return True

    async def is_favorited(self) -> bool:
        """Is this entity currently favorited by the current user?"""
        return (await self._favorite_bookmark()) is not None

    @staticmethod
    def api_visible_by_type(entity_type: str):
        return SchemaRegistry.is_api_visible(entity_type)

    @property
    def type_info(self):
        """The registry TypeInfo for this entity's type — the single source of
        truth for type metadata (icon/browseable/creatable/indexed_by_default/
        api_visible/asset layout). Read via ``self.type_info.icon`` etc.; never
        re-declared on concrete entity classes.
        """
        return SchemaRegistry.get(self.get_type())

    async def setup_on_receive(self, *, project_id: str | None = None, workdir: str | None = None) -> dict:
        """Reception hook: the DisplayTarget to navigate to after this entity is
        installed from a share.

        Generic on the base entity — behavior comes from the type's
        ``TypeInfo.setup_skill`` (declared next to the type, never branched here).
        No skill ⇒ just open the received entity. A skill ⇒ spawn a headless Vibe
        ``AgenticProcess`` seeded to run that skill against this entity and return
        ITS target, so the receiver lands in the live Vibe session while the agent
        sets the app up. The seed runs in the background (see
        ``_schedule_setup_prompt``) so the install request returns immediately.
        Best-effort: any spawn failure falls back to opening the entity itself.
        """
        from flow_sdk.core.display_target import _entity_payload  # noqa: PLC0415

        skill = getattr(self.type_info, "setup_skill", None)
        if not skill:
            return _entity_payload(self)
        return await self._spawn_setup_session(skill, project_id=project_id, workdir=workdir)

    async def _setup_workdir(self, project_id: str | None) -> str | None:
        """Resolve a workdir for a setup session: the entity's own folder (an
        artifact's served ``path``) when it is a real directory, else the mounted
        project root, else None."""
        from pathlib import Path as _Path  # noqa: PLC0415

        raw = getattr(self, "path", None)
        if raw and _Path(str(raw)).is_dir():
            return str(raw)
        if project_id:
            from flow_sdk.builtin.project import Project  # noqa: PLC0415

            proj = await Project.get_one({"id": project_id})
            mount = (getattr(proj, "fs_storage_mount_path", "") or "").strip() if proj else ""
            return mount or None
        return None

    async def _spawn_setup_session(
        self, skill: str, *, project_id: str | None = None, workdir: str | None = None
    ) -> dict:
        """Spawn the headless Vibe setup process and return its DisplayTarget. Split
        out of ``setup_on_receive`` so open-existing and install share one spawn."""
        from flow_sdk.core.display_target import _entity_payload  # noqa: PLC0415

        typeid_str = f"{self.get_type()}-{self.id}"
        # SELF sentinel (skill type == setup_skill): run the received entity as its
        # own skill; else run the declared built-in (e.g. "artifact-setup").
        skill_name = (getattr(self, "name", None) or self.id) if skill == self.get_type() else skill
        try:
            from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess  # noqa: PLC0415
            from flow_sdk.flowpad_types.enums import ProcessKind  # noqa: PLC0415

            # ``project_id``/``workdir`` are binding-frozen — set in the ctor only.
            ap = AgenticProcess(
                workdir=workdir,
                project_id=project_id,
                target_typeid_str=(f"project-{project_id}" if project_id else typeid_str),
                visible=False,
                pty_mode=False,
                process_type=ProcessKind.CHAT,
                load_flowpad_assistant=True,
                context_data={"source_artifact_id": self.id, "launched_from": "artifact_setup"},
            )
            await ap.save()
            _schedule_setup_prompt(ap, f"Use the {skill_name} skill to set up {typeid_str}.")
            return _entity_payload(ap)
        except Exception:
            service_log.warn(
                f"[reception] setup_on_receive spawn failed for {typeid_str}; opening entity", exc_info=True
            )
            return _entity_payload(self)

    @property
    def frontmatter(self):
        """Read/write access to this asset's on-disk YAML frontmatter.

        ``entity.frontmatter.get(key)`` / ``.set(key, val)`` / ``["k"] = v``.
        Backed by the main-body file (resolved via ``type_info.body_path_for``),
        which is the source of truth for frontmatter-persisted fields like
        ``version``. Returns a fresh accessor each call; reads are read-through,
        writes are merge-preserving.
        """
        from .frontmatter_accessor import FrontmatterAccessor  # noqa: PLC0415

        return FrontmatterAccessor(self)

    @staticmethod
    def get_entity_model_by_type(entity_type: str) -> type[Entity]:
        return SchemaRegistry.get_entity_cls(entity_type)

    def __str__(self) -> str:
        return f"{self.__repr_name__()}: {{{super().__str__()}}}"

    @property
    def current_config(self):
        from flow_sdk.request_context.methods import get_current_service_config  # noqa: PLC0415

        return get_current_service_config()

    @property
    def fs_storage(self):
        from flow_sdk.request_context.methods import get_entity_storage  # noqa: PLC0415

        entity_storage = get_entity_storage(self.typeid, entity=self)
        if not entity_storage:
            raise ValueError(f"Entity storage not found for {self.typeid}")
        return entity_storage

    @property
    def embedded_storage(self):
        from flow_sdk.request_context.methods import get_entity_embedded_storage  # noqa: PLC0415

        entity_storage = get_entity_embedded_storage(self.typeid)
        if not entity_storage:
            raise ValueError(f"Entity blob storage not found for {self.typeid}")
        return entity_storage

    @staticmethod
    def new_entity(entity_type: str, **kwargs) -> Entity:
        model = SchemaRegistry.get_entity_cls(entity_type)
        if not model:
            raise ValueError(f"New entity create error : Model not found for entity type {entity_type}")
        return model(**kwargs)

    def set_fields(self, fields: dict):
        for key, value in fields.items():
            setattr(self, key, value)

    async def set_visitor_role(self, role: str | None) -> Entity:
        self.visitor_role = role
        return await self.save()

    @classmethod
    def is_entity(cls: type[EntityType], db_entity: DBEntity) -> TypeGuard[EntityType]:
        return isinstance(db_entity, cls)

    @classmethod
    def assert_type(cls: type[EntityType], db_entity: DBEntity) -> EntityType:
        if not cls.is_entity(db_entity):
            raise ValueError(f"Entity is not of type {cls.get_type()}")
        return db_entity

    @classmethod
    async def update_by_id(cls: Type[EntityType], eid: str, fields: dict):
        # Invalidate cache before update (especially for relationship changes)
        from ..cache.entity_cache import entity_cache

        entity_typeid = TypeId(type=cls.get_type(), id=eid)
        entity_cache.invalidate_entity_cache(entity_typeid)

        updated_entity = await cls.get_by_id(eid)
        if not updated_entity:
            raise ValueError(f"Entity with id {eid} not found.")
        updated_entity.apply_field_updates(fields)
        return await updated_entity.update()

    @classmethod
    async def delete_by_id(cls, eid: str):
        """Override delete_by_id to invalidate cache when entity is deleted."""
        # Invalidate cache before deletion
        from ..cache.entity_cache import entity_cache

        entity_typeid = TypeId(type=cls.get_type(), id=eid)
        entity_cache.invalidate_entity_cache(entity_typeid)

        # Cleanup wiki edges that reference this entity on either side.
        # Best-effort — log on failure so a wiki hiccup never blocks deletes.
        try:
            from flow_sdk import wiki

            await wiki.delete_for_id(cls.get_type(), str(eid))
        except Exception as wiki_exc:
            import logging

            logging.getLogger(__name__).warning(
                "wiki.delete_for_id failed for %s:%s — %s",
                cls.get_type(),
                eid,
                wiki_exc,
            )

        # Orphan-Tab cleanup — the HTTP delete path (handle_delete_by_id) bypasses
        # the instance delete(), so it must fire here too.
        await cls._close_orphan_tabs_for(cls.get_type(), str(eid))

        # Call parent delete_by_id
        return await super().delete_by_id(eid)

    @classmethod
    async def get_one(
        cls: type[EntityType],
        entities_filter: QueryFilter | dict | None = None,
        source_entity: TypeId | None = None,
    ) -> EntityType | None:
        if isinstance(entities_filter, dict):
            entities_filter = QueryFilter.parse(entities_filter, cls.get_type())
        if not entities_filter:
            entities_filter = QueryFilter(type=cls.get_type())
        entities_filter.limit = 2
        entities = await cls.get_all(entities_filter, source_entity)
        if len(entities) > 1:
            raise ValueError(
                f"Multiple ({len(entities)}) existing entities with data {entities_filter} found, "
                f"cannot determine which to use."
            )
        if len(entities) == 0:
            return None
        one: EntityType = entities[0]
        await one.expand_blobs()
        # Flaky test, need the logs to debug, remove once fixed
        test_name = os.environ.get("PYTEST_CURRENT_TEST", "")
        if "test_template_markdown" in test_name and one.type.lower() == "page":
            if not getattr(one, "raw_content", None):
                service_log.error(f"Entity {one.typeid} has no raw_content(vfs root path: {one.vfs_root_path})")
                index_found = os.path.isfile(one.blob_index_path)
                index_content = ""
                if index_found:
                    # read the index file content
                    with open(one.blob_index_path, "r") as f:
                        index_content = f.read()
                service_log.warn(f"Index path: {one.blob_index_path}, exists: {index_found}, content: {index_content}")
        return one

    @classmethod
    async def get_recent(
        cls: type[EntityType],
        entities_filter: QueryFilter | dict | None = None,
        source_entity: TypeId | None = None,
    ) -> EntityType | None:
        if isinstance(entities_filter, dict):
            entities_filter = QueryFilter.parse(entities_filter, cls.get_type())
        if not entities_filter:
            entities_filter = QueryFilter(type=cls.get_type())
        order_by: OrderType = {"updated_at": "asc"}
        entities_filter.order_by = order_by
        entities_filter.limit = 1
        entities = await cls.get_all(entities_filter, source_entity)
        if len(entities) == 0:
            return None
        recent = entities[0]
        return recent

    @logfire.instrument("expand_blobs {self.typeid=}")
    async def expand_blobs(self):
        if self.is_expanded_blobs():
            return
        self.mark_expansion(ExpansionType.Blobs)
        await self._read_blobs()

    def is_expanded_blobs(self):
        return bool(self.expand and self.expand.expansions and ExpansionType.Blobs in self.expand.expansions)

    async def _read_blobs_index(self) -> BlobIndexEntity | None:
        index_vfs = BLOB_INDEX_VFS_PATH
        exists = await self.embedded_storage.exists(index_vfs)
        if not exists:
            service_log.debug(f"Blobs index not found {index_vfs}")
            return BlobIndexEntity()

        index_str = await self.embedded_storage.fetch(index_vfs)
        if not index_str:
            service_log.debug(f"Empty Blobs index !! {index_vfs}")
            return BlobIndexEntity()
        try:
            service_log.debug(f"Blobs index fetched !! len:{len(index_str)}")
            return BlobIndexEntity.parse(index_str)
        except ValidationError as e:
            service_log.debug(f"Error in Blobs index !! {index_vfs}")
            raise ValueError(f"Failed to decode JSON from {index_vfs}: {e}")

    async def _read_blobs(self) -> None:
        if not self.has_blob_fields():
            return
        blob_index_entity = await self._read_blobs_index()
        field_names = self.get_blob_fields_names()
        for field_name in field_names:
            value = blob_index_entity.get(field_name)
            setattr(self, field_name, value)

    @property
    def vfs_fs_root_path(self) -> str:
        if not self.fs_storage:
            return ""
        return self.fs_storage.vfs_root_path

    @property
    def vfs_embedded_root_path(self) -> str:
        if not self.embedded_storage:
            return ""
        return self.embedded_storage.vfs_root_path

    @property
    def blob_index_path(self) -> str:
        return self.vfs_embedded_root_path + "/" + BLOB_INDEX_VFS_PATH

    async def _save_blobs(self):
        if not self.has_blob_fields() or not self.dirty:
            return

        blob_index_entity = BlobIndexEntity()
        field_names = self.get_blob_fields_names()
        for field_name in field_names:
            blob_index_entity[field_name] = getattr(self, field_name)
        if blob_index_entity.is_empty and not self.is_expanded_blobs():
            # If blobs were not expanded and all blob fields are empty - do not save
            # or else it might overwrite the existing blobs
            return
        await blob_index_entity.save(self.embedded_storage)
        # logging.info(f"Saved blob index for {self.typeid} with fields: {blob_index_entity._blob_index.fields.keys()} on \n {self.storage.vfs_root_path}")

    def cloud_watch(self) -> "CloudWatch":
        """Async-context stream of hub events scoped to this entity.

        See ``flow_sdk.cloud_client.events.CloudWatch`` for the full API.
        Matches events whose ``entity_id`` *or* ``parent_id`` equals
        ``self.id`` — i.e., "events about me" + "events about my children".
        """
        from flow_sdk.cloud_client.events import CloudWatch  # noqa: PLC0415

        if not self.id:
            raise RuntimeError("cloud_watch requires entity.id; save first")
        return CloudWatch(self.id)

    async def share(self: EntityType, *, recursive: bool = False) -> EntityType:
        """Create this entity on the hub (POST /api/v1/graph/<type>).

        Generic, type-agnostic: the body is this entity's serialized dump,
        the URL is constructed via ``build_hub_url(self.type)``, auth is
        taken from the stored hub credentials. Returns ``self`` after
        flipping the ``remote`` field on the in-memory entity when the
        subclass declares one.

        ``recursive=True`` additionally walks this entity's ``is_child``
        subtree and creates each descendant on the hub under its parent via
        ``create_child`` (children get their own ``remote=True``). Late-added
        children are handled separately by the auto-share-on-create rule in
        the create handler.

        The caller is responsible for persisting ``remote=True`` to the
        local DB — typically by loading the on-disk row and saving it
        immediately after ``share()`` returns. ``self`` here is often a
        transient instance reconstructed from a request body and not
        bound to a DB row, so we deliberately do not call ``self.save()``
        from inside ``share()``.

        Raises ``RuntimeError`` if not cloud-logged-in or the hub rejects.
        """
        from flow_sdk.cli.auth.credentials import load_credentials  # noqa: PLC0415
        from flow_sdk.cloud_client.client import ApiConfig, FlowpadClient  # noqa: PLC0415
        from flow_sdk.core.urls.service_urls import build_hub_url  # noqa: PLC0415

        creds = load_credentials()
        if not creds or not creds.api_key:
            raise RuntimeError("Cloud login required before share()")

        # Body = entity dump, excluding:
        #  - ``private_context_entities_``  — local-only chip projection, not on hub schema
        #  - ``created_by`` / ``updated_by`` — local user ids do not resolve on
        #    the hub; the hub stamps these from the auth token. Leaving them in
        #    triggers the hub's role-lookup with an unknown user → 404.
        #  - ``created_date`` / ``updated_date`` — hub stamps timestamps itself.
        #  - ``remote``      — local "do I have a hub counterpart" flag; meaningless on the hub.
        #  - ``system``      — local "ships in an SDK system project" flag.
        #  - ``message_count`` — SDK projection from the conversation jsonl pointer index.
        #  - ``tags``        — local-only labels; the hub doesn't read them.
        #  - ``project_id``  — sender's local project; recipients resolve their
        #    own project mapping, so the hub deliberately doesn't store this.
        #  - ``participants`` — initial sender-side list (email-only entries).
        #    The hub builds the real participants list via ``/members`` invites
        #    + ``/join``, which stamps a real ``user_id`` per joiner.
        # All of the above were producing ``None API field !!!`` errors on the
        # hub at create because the hub schema doesn't declare them. They
        # have no hub semantics; the SDK simply shouldn't be sending them.
        # parent_share_on_default: a flagged type advertises its parent typeid
        # on the shared-context rail so receivers re-materialize it (same
        # kernel the message paths apply via collect_parent_share_typeids).
        from flow_sdk.core.entity.parent_share import parent_share_typeid  # noqa: PLC0415

        parent_tid = parent_share_typeid(self)
        if parent_tid is not None:
            self.add_shared_context_entities(parent_tid)
        body = self._hub_body()

        path = build_hub_url(self.get_type())
        async with FlowpadClient(ApiConfig.from_env(), api_key=creds.api_key) as client:
            resp = await client.post(path, body)

        # ``remote`` is opt-in per subclass. Flip it when present so callers
        # can branch on it. Subclasses without the field stay unchanged.
        if "remote" in type(self).model_fields:
            self.remote = True
            # The POST above carried every FIELD, but it is JSON — files can't
            # ride in it, and ``fs/upload`` needs the id that POST just created.
            # So files already in this entity's storage get their own pass, next
            # to their download counterpart in the fs layer.
            from flow_sdk.actions.fs.fs_actions import push_entity_files_to_hub  # noqa: PLC0415

            await push_entity_files_to_hub(self)
        if recursive:
            await self._share_children()
        return self

    def _local_fields(self) -> frozenset[str]:
        """The fields that never travel in ``to_common_json`` — every ``PRIVATE``
        field, derived from the declarations (``Sharing``).

        Was the union of ``_BASE_LOCAL_FIELDS`` and ``TypeInfo.local_fields``.
        Deriving it removes a live hazard as well as a list: the registry lookup
        returned EMPTY when an entity module was imported before
        ``register_all()``, so a type's own local fields silently travelled
        (see ``tests/unit/test_assignee_owned_fields.py``). A field declaration
        cannot have an import-order bug.
        """
        return self.__class__.fields_not_in_bundle()

    @computed_field(json_schema_extra={"sharing": str(Sharing.PRIVATE)})
    @property
    def duplicate_count(self) -> int:
        """Number of live filesystem occurrences excluding the primary path."""
        return max(0, len(self.asset_occurrences) - 1)

    async def reflect_asset_occurrences(
        self,
        occurrences: Sequence[AssetOccurrence],
        *,
        notify: bool = False,
    ) -> bool:
        """Persist collision projection to the DB without touching the filesystem.

        Returns whether state changed. Notification is explicit and emitted only
        after the store-suppressed DB write succeeds.
        """
        reflected = asset_occurrence_dicts(occurrences)
        if self.asset_occurrences == reflected:
            return False
        self.asset_occurrences = reflected
        token = _SUPPRESS_STORE.set(True)
        try:
            await self.save(notify=False)
        finally:
            _SUPPRESS_STORE.reset(token)
        if notify:
            await self.notify_updated()
        return True

    def to_common_json(self) -> dict:
        """The portable entity JSON: a full model dump minus the sender-local
        fields. This is the SINGLE wire-serialization seam — used by the bundle
        ``entities.json`` envelope (and, once hub-field parity is verified, the
        hub push). Sender-local placement/mount/provenance/user-id fields (plus
        each type's ``TypeInfo.local_fields``) are stripped; the receiver
        re-derives them. Unlike ``meta_dict`` this is the FULL model (so wire-only
        fields like ``text``/``status`` travel), not just the persisted subset.
        ``skip_api_serializer`` suppresses the API serializer that re-injects
        computed projections (e.g. ``expand``)."""
        return self.model_dump(
            mode="json",
            exclude_none=True,
            exclude=self._local_fields(),
            context={"skip_api_serializer": True},
        )

    def _hub_body(self) -> dict:
        """The serialized body to POST to the hub — shared by ``share`` and
        ``create_child``.

        Excludes every field declared ``PRIVATE`` (never leaves this machine) or
        ``HUB_READ`` (the hub owns it — the clocks). ``id`` is included so the hub
        honors the same-id invariant; the hub derives the parent from the URL, so
        a stray ``parent_type_id`` in the body is harmless (the hub sanitizes
        unknown fields).

        This was an 18-name literal that had drifted from the bundle seam's list
        in both directions. Deriving both from the same declarations is what
        stops local paths (``asset_ref``, ``cwd``, ``fs_storage_mount_path``, …)
        reaching the hub — they were stripped from share bundles but pushed here,
        which is why the receiver had to defend with ``sanitized.pop("asset_ref")``.
        """
        return self.model_dump(
            mode="json",
            exclude_none=True,
            exclude=set(self.__class__.fields_not_sent_to_hub()),
        )

    async def create_child(self: EntityType, child: "Entity") -> "Entity":
        """Create ``child`` on the hub as an ``is_child`` of this (remote) entity.

        POSTs to ``/graph/<self.type>/<self.id>/<child.type>`` so the hub's
        create handler runs ``add_child`` and writes the role-propagating
        ``is_child`` edge. The child's own id rides in the body (same-id
        invariant). Sets ``child.remote=True`` on success.

        Caller must ensure ``self`` is on the hub (``remote``/``effective_remote``);
        creating a child under a non-remote parent would 404 on the hub.
        """
        from flow_sdk.cli.auth.credentials import load_credentials  # noqa: PLC0415
        from flow_sdk.cloud_client.client import ApiConfig, FlowpadClient  # noqa: PLC0415
        from flow_sdk.core.urls.service_urls import build_hub_url  # noqa: PLC0415

        creds = load_credentials()
        if not creds or not creds.api_key:
            raise RuntimeError("Cloud login required before create_child()")
        body = child._hub_body()
        # build_hub_url(self) → /graph/<ptype>/<pid>; action=<childtype> appends
        # the trailing bare child type the hub parses as direct_resource_type.
        path = build_hub_url(self, action=child.get_type())
        async with FlowpadClient(ApiConfig.from_env(), api_key=creds.api_key) as client:
            await client.post(path, body)
        if "remote" in type(child).model_fields:
            child.remote = True
            # Direct and recursive child creation use the same byte-transport
            # seam as top-level share. The Hub entity must exist before its
            # entity-scoped fs/upload endpoint can accept content.
            from flow_sdk.actions.fs.fs_actions import push_entity_files_to_hub  # noqa: PLC0415

            await push_entity_files_to_hub(child)
        return child

    async def _share_children(self: EntityType) -> None:
        """Recursively create this entity's ``is_child`` subtree on the hub."""
        for ec in await self.get_children():
            child = getattr(ec, "value", ec)
            if child is None:
                continue
            await self.create_child(child)
            await child._share_children()

    async def unshare(self: EntityType, *, recursive: bool = True) -> EntityType:
        """Remove this entity (and, by default, its subtree) from the hub.

        Pure inverse of ``share``: ``recursive`` first unshares each child so
        the subtree is detached/deleted bottom-up, then deletes this entity on
        the hub and flips ``remote=False`` locally. Owner-gated server-side.
        """
        from flow_sdk.cli.auth.credentials import load_credentials  # noqa: PLC0415
        from flow_sdk.cloud_client.client import ApiConfig, FlowpadClient  # noqa: PLC0415
        from flow_sdk.core.urls.service_urls import build_hub_url  # noqa: PLC0415

        if recursive:
            for ec in await self.get_children():
                child = getattr(ec, "value", ec)
                if child is not None and getattr(child, "remote", False):
                    await child.unshare(recursive=True)

        if getattr(self, "remote", False):
            creds = load_credentials()
            if not creds or not creds.api_key:
                raise RuntimeError("Cloud login required before unshare()")
            path = build_hub_url(self)
            async with FlowpadClient(ApiConfig.from_env(), api_key=creds.api_key) as client:
                await client.request("DELETE", path)
            if "remote" in type(self).model_fields:
                self.remote = False
        return self

    async def parent(self: EntityType) -> Optional["Entity"]:
        """Resolve this entity's parent via ``parent_type_id`` (async DB load).

        Returns ``None`` when there is no parent reference or the type is
        unknown. ``parent_type_id`` is the canonical parent pointer; this
        supersedes the legacy per-type ``data.parent_id`` convention.
        """
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415
        from flow_sdk.fs_store.type_id import TypeId  # noqa: PLC0415

        pid = getattr(self, "parent_type_id", None)
        if not pid:
            return None
        tid = pid if isinstance(pid, TypeId) else TypeId(pid)
        cls = SchemaRegistry.get_entity_cls(tid.type)
        if cls is None or not tid.id:
            return None
        return await cls.get_one({"id": tid.id})

    async def effective_remote(self: EntityType) -> bool:
        """True if this entity is on the hub itself OR any ancestor is.

        ``remote`` is the sync, locally-authoritative fact ("I have a hub row").
        Effective remoteness additionally walks up ``parent`` so a child under a
        recursively-shared parent is treated as remote even before its own push.
        Thin wrapper over ``nearest_remote_ancestor`` (one walk, one cycle guard).
        """
        return (await self.nearest_remote_ancestor()) is not None

    async def nearest_ancestor(self: EntityType, predicate) -> Optional["Entity"]:
        """First entity (self included) matching ``predicate``, walking the
        ``parent_type_id`` chain. Cycle-safe; stops at a missing parent."""
        seen: set = set()
        cur: Optional["Entity"] = self
        while cur is not None and cur.id not in seen:
            if predicate(cur):
                return cur
            seen.add(cur.id)
            cur = await cur.parent()
        return None

    async def nearest_remote_ancestor(self: EntityType) -> Optional["Entity"]:
        """Closest entity (self or an ancestor) that has its OWN hub row
        (``remote=True``), walking ``parent``. ``None`` if none is remote.

        Used to pick the hub-side parent for a child create: a local-only type
        (e.g. ``markdown``, which the hub doesn't host) returns its conversation
        ancestor, so the child is created under a hub-known container while the
        child keeps its true ``parent_type_id`` (the doc) in its own payload.
        """
        return await self.nearest_ancestor(lambda e: getattr(e, "remote", False))

    @classmethod
    async def upsert_from_hub_child(
        cls,
        data: dict,
        parent_ref: Optional[str],
        someone_typeid: Optional[str] = None,
        notify: bool = True,
    ) -> "Entity":
        """Materialize a hub child payload locally as a ``remote`` ``is_child``.

        Shared by the live bridge path (``hub_bridge._handle_child_op``) and the
        sync catch-up (``_materialize_remote_child``). The child's own
        ``parent_type_id`` in the payload wins over ``parent_ref`` (the hub
        container it was pulled from); ``remote`` is stamped True.

        It is an UPSERT, not a create: when the row already exists locally the
        hub payload is merged over it through ``merge_hub_payload`` so
        ``LOCAL_ONLY_FIELDS`` survive. A blind ``model_validate`` here dropped
        the local ``asset_ref`` — and since the ORIGIN also receives an op for
        the child it just created, it clobbered its own row and the next save
        re-derived the folder under the parent, nesting the asset inside itself.
        """
        effective_parent = (data.get("parent_type_id") if isinstance(data, dict) else None) or parent_ref
        sanitized = {k: v for k, v in (data or {}).items() if cls.is_api_field(k)}
        if isinstance(data, dict) and data.get("id"):
            sanitized["id"] = data["id"]
        if effective_parent and "parent_type_id" in cls.model_fields:
            sanitized["parent_type_id"] = effective_parent
        # parent_share_on_default types materialize their deterministic parent
        # before the child. No built-in types currently use this hook.
        info = SchemaRegistry.get(cls.get_type())
        if info is not None and getattr(info, "parent_share_on_default", False):
            pid = await cls.materialize_share_parent(sanitized, someone_typeid)
            if pid and "parent_type_id" in cls.model_fields:
                sanitized["parent_type_id"] = pid
        existing = await cls.get_one({"id": sanitized["id"]}) if sanitized.get("id") else None
        if existing is not None:
            # Same LWW refresh the FlowMessage catch-up uses (see
            # ``flow_message_action`` → ``merge_hub_payload``): hub-owned fields
            # move, locally-authoritative ones stay.
            sanitized = cls.merge_hub_payload(existing, sanitized)
        ent = cls.model_validate(sanitized)
        if "remote" in cls.model_fields:
            ent.remote = True
        await ent.save(someone_typeid, notify=notify)
        # Receiver contract: replication replays the ORIGIN's write, not a weaker
        # one. The sender's create ran `add_child` → a local `is_child` role edge;
        # role-walk scope queries (e.g. the doc-comment gutter) resolve through
        # that edge, so a bare row save leaves the child invisible. Recreate it
        # when the parent row exists locally; when it doesn't (layer-1-gated doc
        # not installed yet), the catch-up rebind pass heals later. Non-fatal.
        try:
            await ent.ensure_child_edge()
        except Exception as e:  # noqa: BLE001
            import logging

            logging.getLogger(__name__).warning(
                "upsert_from_hub_child: edge recreation failed for %s: %s", ent.typeid, e
            )
        return ent

    async def ensure_child_edge(self) -> bool:
        """Ensure the local parent→self ``is_child`` role edge exists.

        The single edge-recreation seam for materialized remote children (live
        bridge + catch-up sync + orphan rebind). Resolves ``parent_type_id`` to a
        LOCAL row; absent parent → False (caller-side rebind heals when the
        parent materializes). ``attach_child``/``grant_role`` dedups an existing
        edge (pinned by test_attach_child_idempotency), but we pre-check anyway so
        the every-sync re-convergence path does zero writes when converged.
        Returns True iff the edge exists after the call.
        """
        from flow_sdk.db.rolerelationship import RoleRelationship  # noqa: PLC0415

        parent = await self.parent()
        if parent is None:
            return False
        rel_filter = QueryFilter(
            type=RoleRelationship.get_type(),
            match=ExpressionNode(op=QueryOp.EQ, operands=["is_child", True]),
        )
        rels = await self.get_incoming_relationships(rel_filter)
        parent_tid = str(parent.typeid)
        if any(str(r.from_typeid) == parent_tid for r in rels if r.from_typeid):
            return True
        await parent.attach_child(self)
        return True

    @classmethod
    async def materialize_share_parent(cls, payload: dict, someone_typeid: Optional[str] = None) -> Optional[str]:
        """Hook for ``parent_share_on_default`` types: ensure the entity's
        parent exists locally (upsert-by-deterministic-id) and return its
        typeid, or None. No-op on the base class."""
        return None

    @staticmethod
    def _as_datetime(value: Any) -> Optional[datetime]:
        """Coerce a stored/serialized timestamp to a ``datetime`` for compare.
        Accepts datetimes, ISO strings, and epoch-ms numbers (the
        ``last_active_at`` wire format). Returns ``None`` when the value is
        absent or unparseable."""
        if value is None or isinstance(value, datetime):
            return value
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            try:
                return datetime.fromtimestamp(value / 1000, tz=timezone.utc)
            except (ValueError, OSError, OverflowError):
                return None
        try:
            return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except (ValueError, TypeError):
            return None

    @classmethod
    def is_stale(cls, local: Optional["Entity"], hub_payload: Dict[str, Any]) -> bool:
        """LWW staleness at the hub→local boundary: ``True`` when the hub copy
        should replace the local one.

        - No local row  → stale (must materialize).
        - Hub provides no ``updated_date`` → cannot prove staleness, keep local
          (avoids clobbering local edits with a timestamp-less hub echo).
        - Otherwise stale iff ``hub.updated_date > local.updated_date``.

        ``updated_date`` is the single decision point; the hub is the real-time
        source of truth. See ``merge_hub_payload`` for the field-level merge.
        """
        if local is None:
            return True
        hub_dt = cls._as_datetime(hub_payload.get("updated_date"))
        if hub_dt is None:
            return False
        local_dt = cls._as_datetime(getattr(local, "updated_date", None))
        if local_dt is None:
            return True
        return hub_dt > local_dt

    @classmethod
    def merge_hub_payload(cls, local: "Entity", hub_payload: Dict[str, Any]) -> Dict[str, Any]:
        """Build a ``model_validate``-able dict that refreshes hub-owned fields
        from ``hub_payload`` while preserving this type's ``LOCAL_ONLY_FIELDS``
        (the locally-authoritative state the hub must never overwrite). The
        hub's ``updated_date`` is carried through so the local save records the
        hub timestamp (the driver preserves a non-None ``updated_date``)."""
        merged = dict(hub_payload)
        merged["id"] = local.id
        for field in cls.LOCAL_ONLY_FIELDS:
            if field in cls.model_fields:
                merged[field] = getattr(local, field, None)
        # This IS the hub→local refresh boundary — stamp it (after the
        # LOCAL_ONLY restore loop, which would otherwise carry the stale value).
        merged["fetched_at"] = datetime.now(timezone.utc)
        return merged

    async def save(
        self: EntityType, owner: DBEntity | TypeId | types.NoneType = None, notify: bool = True
    ) -> EntityType:
        user_id = owner
        if isinstance(owner, Entity):
            user_id = owner.typeid
        if not owner:
            if self.get_type() == BuiltinEntityType.USER.value:
                user_id = self.typeid
        # Framework: resolve scope from request_context once and pre-populate
        # asset_ref / parent_path on the entity BEFORE the DB write, so the
        # row carries them on first save. After this call, ``store()`` only
        # has to upsert main_ref and sync_from_entity.
        await self._prepare_for_storage()
        await self._save_blobs()
        # Captured before the write flips ``exist_in_db``: a fresh entity can't yet
        # have a Tab pointing at it, so the project-reconcile below is update-only.
        was_create = not self.exist_in_db
        suppress_store = _SUPPRESS_STORE.get()
        from flow_sdk.fs_store.fs_record import record_sync_guard

        # Keep a normal DB write and its filesystem mirror indivisible with
        # respect to the opposite disk→DB path.  ``record_sync_guard`` is
        # explicitly same-task reentrant: ``FSRecord.sync_to_db`` owns it when
        # it reaches this save through ``from_record``.
        async with record_sync_guard(self.get_type(), self.id):
            await super().save(user_id, notify=notify)
            if not suppress_store:
                # Sync metadata down to disk + upsert main_ref iff missing
                # (Record contract: writes go through main_ref FSRef, no
                # per-type store()).
                await self.store()

        # The disk→DB adopt path (from_record) suppresses disk write-back via
        # the _SUPPRESS_STORE contextvar so the source-of-truth file is never
        # rewritten — structural loop suppression, override-agnostic (all
        # save() overrides funnel through this base).
        if not suppress_store:
            # Reconcile dependent content Tabs when this entity's project changes.
            # ``tab.project_id`` is a denormalized snapshot of the target's project
            # taken at tab creation; without this a (re)assignment leaves the tab
            # showing its stale project color. Project-change sibling of the
            # orphan-close hook in ``delete()``; gated by the same _SUPPRESS_STORE
            # check so the disk→DB adopt / bulk-indexer path never triggers it.
            # Best-effort — the Tab type may be absent (e.g. a pytest env without
            # register_all), so a failure here must never block the save.
            if not was_create and self.type != "tab" and hasattr(self, "project_id"):
                try:
                    from flow_sdk.builtin.tab import reconcile_tab_project

                    await reconcile_tab_project(self.type, str(self.id), getattr(self, "project_id", None))
                except Exception as tab_exc:
                    import logging

                    logging.getLogger(__name__).warning(
                        "Tab project-reconcile failed for %s:%s — %s",
                        self.type,
                        self.id,
                        tab_exc,
                    )
        # Invalidate authorization cache since entity properties have changed
        from ..auth.auth_cache import get_auth_cache

        get_auth_cache().invalidate_entity(self.typeid)
        return self

    async def _prepare_for_storage(self, scope_root: "Path | None" = None) -> None:
        """Resolve scope-derived fields on the entity before DB save.

        For Records that declare ``_main_subdir``, this resolves scope_root
        from request_context and computes the asset_ref FSRef. The path
        string is mirrored onto ``entity.asset_ref`` (and ``parent_path`` if
        present) so the DB row persists them on first save without needing
        a second round-trip.

        ``scope_root`` overrides the request-context resolution — for callers
        whose URL targets a different entity than the scope the asset should
        land under (e.g. pin-prompt targets a process but scopes the Prompt
        to its project).
        """
        # Project-scoped create/save: stamp project_id so the entity is
        # visible in project-scoped surfaces immediately, not only after the
        # next indexer walk re-derives it from the asset path. Generic: any
        # entity with a project_id field saved under a project scope. The
        # resolved project is threaded into _resolve_scope_root below so the
        # (memoization-missing) failure edge never re-queries per save.
        scope_proj = None
        if hasattr(self, "project_id") and not getattr(self, "project_id", None):
            scope_proj = await self._resolve_scope_project()
            if scope_proj is not None:
                self.project_id = scope_proj.id
        if getattr(self, "asset_ref", None):
            # Already set (entity update or explicit caller-set path), but the
            # scope tag may still be unstamped — derive it (project-aware) so
            # every save labels its bucket, not just HTTP-create/indexer paths.
            self._stamp_scope()
            return
        type_name = self.get_type()
        info = SchemaRegistry.get(type_name)
        if info is None or info._resolved_layout[0] is None:
            return
        # REPO assets nest inside their parent: a repo child lands at
        # ``<parent-folder>/agentic-assets/<type>/<name>``, recursively. When this
        # entity is a repo child, its container IS the parent asset's folder, not
        # the scope root — ``compute_asset_ref`` then appends ``agentic-assets/…``.
        if scope_root is None:
            scope_root = await self._resolve_repo_parent_container(info)
        scope_root = scope_root or await self._resolve_scope_root(scope_proj)
        if scope_root is None:
            return
        # The machine's canonical harness picks the family prefix (.claude/… vs
        # .agents/…). Create-only path (asset_ref-set entities returned above),
        # so the capability lookup isn't per-save. Falls back to claude.
        from flow_sdk.fs_store.placement import resolve_default_harness

        default_worker = await resolve_default_harness()
        # Transient FSRecord just to compute the asset_ref convention.
        from flow_sdk.fs_store.fs_record import FSRecord

        rec = FSRecord(type=type_name, id=self.id)
        ar = rec.compute_asset_ref(scope_root, self, default_worker=default_worker)
        if ar is None or getattr(ar, "_path", None) is None:
            return
        from flow_sdk.fs_store.path_utils import canonical_posix_path

        path_str = canonical_posix_path(ar.path)
        if hasattr(self, "asset_ref"):
            self.asset_ref = path_str
        # parent_path lets DocsCategory / PlansCategory filter the markdown
        # entity-query result without waiting for the indexer.
        if hasattr(self, "parent_path"):
            self.parent_path = str(ar._path.parent)
        # Stamp the scope tag from the resolved path. This is the chokepoint
        # that makes EVERY writer (HTTP create, server-side .save(), triggers)
        # label its bucket — previously scope was only filled at index time
        # plus per-edge band-aids, so any other writer birthed a scope-less row
        # that leaked into every project scope (e.g. usage_report).
        self._stamp_scope()

    @staticmethod
    def _scope_from_path(path) -> str | None:
        """Classify a filesystem path into a scope tag ('user'|'project'|'system').

        The one place the save chokepoints turn a path into a scope; ``None`` when
        the path is empty or unclassifiable.
        """
        if not path:
            return None
        from flow_sdk.fs_store.indexer.roots import classify_path  # noqa: PLC0415

        return classify_path(path)

    def _scope_already_decided(self) -> bool:
        """True when ``scope`` must NOT be re-derived from the asset path.

        Two distinct cases, which a plain ``scope in (None, "")`` test cannot
        tell apart:

        * A **fresh** entity whose caller explicitly declared ``scope`` — including
          a deliberate ``None`` — owns that decision. A received asset carries no
          scope at DOWNLOADED and is stamped only at INSTALLED with the chosen
          scope (docs/collab/messages-and-attachments.md §6). Without this, the
          phantom user-home placement of a not-yet-installed asset stamped it
          ``'user'``, so it showed as personal before the user chose anything.
        * An already-stamped entity (any non-empty scope) keeps its label.

        A DB-loaded row always reports the field as "set", so it is deliberately
        NOT covered by the first case — legacy rows with a null scope keep
        back-filling on their next save exactly as before.
        """
        if "scope" in self.model_fields_set and not self.exist_in_db:
            return True
        return getattr(self, "scope", None) not in (None, "")

    def _stamp_scope_from_asset_ref(self) -> None:
        """Derive ``scope`` ('user'|'project'|'system') from ``asset_ref``.

        No-op when the entity has no scope field, the field is already set, or
        the path can't be classified — so it never clobbers an explicit scope.
        """
        if not hasattr(self, "scope") or self._scope_already_decided():
            return
        inferred = self._scope_from_path(getattr(self, "asset_ref", None))
        if inferred:
            self.scope = inferred

    def _stamp_scope(self) -> None:
        """Stamp ``scope`` for storage, preferring a resolved project over the
        path guess.

        ``_scope_from_path`` (``classify_path``) only treats the *server cwd* as
        a project, so a file inside a real workspace project — which lives under
        ``user_home`` — is mislabeled ``'user'`` and then filtered out of every
        project-scoped browse until the indexer walk re-derives it. A resolved
        ``project_id`` is authoritative: if this entity belongs to a project, it
        is project-scoped. ``'system'`` (SDK-shipped) paths still win, since that
        content is never project-scoped user data.

        No-op when there is no ``scope`` field or it is already set, mirroring
        ``_stamp_scope_from_asset_ref`` (never clobbers an explicit scope).
        """
        if not hasattr(self, "scope") or self._scope_already_decided():
            return
        if self._scope_from_path(getattr(self, "asset_ref", None)) == "system":
            self.scope = "system"
            return
        if getattr(self, "project_id", None):
            self.scope = "project"
            return
        self._stamp_scope_from_asset_ref()

    async def delete(self):
        """Override delete to invalidate cache when entity is deleted."""
        # Invalidate cache before deletion
        from ..auth.auth_cache import get_auth_cache
        from ..cache.entity_cache import entity_cache, uname_cache

        entity_cache.invalidate_entity_cache(self.typeid)

        # Invalidate uname cache if entity has a uname
        if hasattr(self, "uname") and self.uname:
            uname_cache.invalidate(self.get_type(), self.uname)

        # Invalidate authorization cache since entity is being deleted
        get_auth_cache().invalidate_entity(self.typeid)

        # Cleanup wiki edges that reference this entity on either side.
        # Best-effort — log on failure so a wiki hiccup never blocks deletes.
        try:
            from flow_sdk import wiki

            await wiki.delete_for_id(self.type, str(self.id))
        except Exception as wiki_exc:
            import logging

            logging.getLogger(__name__).warning(
                "wiki.delete_for_id failed for %s:%s — %s",
                self.type,
                self.id,
                wiki_exc,
            )

        # Soft-close any content Tab pointing at this entity so a deleted target
        # can't leave an orphan chip in the strip (docs/tab-management.md).
        await self._close_orphan_tabs_for(self.type, self.id)

        # Call parent delete
        return await super().delete()

    @staticmethod
    async def _close_orphan_tabs_for(entity_type: str, entity_id: str) -> None:
        """Soft-close every visible content Tab denormalized onto a now-deleted
        target entity so the deletion can't strand a dangling chip that 404s on
        click (docs/tab-management.md). Generic — one chokepoint, invoked from
        BOTH the instance :meth:`delete` and the classmethod :meth:`delete_by_id`
        (the HTTP delete path). Run BEFORE the row is removed so ``Tab.close`` can
        still dispatch teardown to the live target. Best-effort — the Tab type may
        be absent (e.g. a pytest env without ``register_all``) and a failure here
        must never block the delete.
        """
        if entity_type == "tab":  # don't recurse on a Tab deleting itself
            return
        try:
            from flow_sdk.builtin.tab import _tabs_for_target

            for tab in await _tabs_for_target(entity_type, str(entity_id)):
                if getattr(tab, "visible", False):
                    await tab.close()
        except Exception as tab_exc:
            import logging

            logging.getLogger(__name__).warning(
                "Tab orphan-cleanup failed for %s:%s — %s",
                entity_type,
                entity_id,
                tab_exc,
            )

    async def update(self):
        """Override update to invalidate cache when entity is updated."""
        # Invalidate cache before update (especially for relationship changes)
        from ..cache.entity_cache import entity_cache, uname_cache

        entity_cache.invalidate_entity_cache(self.typeid)

        # Invalidate uname cache for this entity (handles uname changes)
        uname_cache.invalidate_by_id(self.get_type(), self.id)

        # Call parent update
        return await super().update()

    async def emit_flow_data(self, flow_data: dict) -> None:
        """Send FlowData to all frontend watchers of this entity.

        Transforms backend FlowData format to frontend-expected format:
        - Backend: {flow_value, attributes, index}
        - Frontend: {element_type, data_type, content, attributes}

        Args:
            flow_data: Dictionary containing FlowData fields (flow_value, attributes, etc.)
        """
        import json

        from ..network.resource_tracker import send_flow_data_to_entity

        # Extract attributes
        attributes = flow_data.get("attributes", {})

        # Get element_type and data_type from attributes
        element_type = attributes.get("element-type", "notification")
        data_type = attributes.get("data-type", "text")

        # Serialize flow_value to content string
        flow_value = flow_data.get("flow_value", "")
        if isinstance(flow_value, (dict, list)):
            content = json.dumps(flow_value)
        else:
            content = str(flow_value) if flow_value else ""

        # Build frontend-compatible flow_data
        frontend_flow_data = {
            "element_type": element_type,
            "data_type": data_type,
            "content": content,
            "attributes": attributes,
        }

        await send_flow_data_to_entity(self.typeid, frontend_flow_data)

    async def emit_entity_event(self, event: str, payload: dict | None = None) -> None:
        """Outbound entity event — push a typed event to all WS watchers of this entity.

        Counterpart to :meth:`entity_event` (which dispatches inbound events from
        TS to a registered handler). Used by code paths that want to notify the
        frontend that "something happened to this entity" without changing entity
        fields (e.g. ``plan.create`` when a plan is detected mid-session). The
        ordinary ``save()``-time entity-update broadcast covers field changes;
        this surface adds a named-event channel for things that aren't field
        mutations.

        Wire format (via ``emit_flow_data``):
            element_type = "entity_event"
            data_type    = "json"
            attributes   = {"event": <name>, "payload": {...}, ...}
        """
        await self.emit_flow_data(
            {
                "attributes": {
                    "element-type": "entity_event",
                    "data-type": "json",
                    "event": event,
                    "payload": payload or {},
                },
            }
        )

    async def save_relationship(self, to_e, relationship_or_str, direction=RelationshipDirection.Outgoing, create=True):
        """Override save_relationship to invalidate cache when relationships are saved."""
        # Invalidate cache before saving relationship (especially for HostedBy relationships)
        from ..cache.entity_cache import entity_cache

        entity_cache.invalidate_entity_cache(self.typeid)

        # Call parent save_relationship
        return await super().save_relationship(to_e, relationship_or_str, direction, create)

    async def delete_relationship(self, to_e, relationship):
        """Override delete_relationship to invalidate cache when relationships are deleted."""
        # Invalidate cache before deleting relationship
        from ..cache.entity_cache import entity_cache

        entity_cache.invalidate_entity_cache(self.typeid)

        # Call parent delete_relationship
        return await super().delete_relationship(to_e, relationship)

    async def get_peers(
        self: EntityType,
        rel_type: str | None = None,
        direction: str | None = None,
        peer_type: str | None = None,
    ) -> List[EntityType]:
        return await self.get_peers_by_typeid(self.typeid, rel_type, direction, peer_type)

    @model_serializer(mode="wrap")
    def api_json_serializer(self, nxt, info: SerializationInfo):
        # Check if we want to skip API serialization
        if info.context and info.context.get("skip_api_serializer"):
            return nxt(self)
        data = nxt(self)
        if data is None:
            return None

        # Convert `expand` to `EntityExpansion` if it's an empty dict or None
        if data.get("expand") is None or (isinstance(data.get("expand"), dict) and not data["expand"]):
            data["expand"] = EntityExpansion()

        # Keep ``computed_field`` outputs visible to the API. ``is_api_field``
        # only knows about declared ``model_fields``; without this set,
        # computed fields like ``private_context_entities`` would be dropped
        # by the filter below.
        computed_keys = set(type(self).model_computed_fields.keys())

        # Exclude None values and private keys to remove
        data = {
            key: value
            for key, value in data.items()
            if value is not None and (key in computed_keys or self.is_api_field(key))
        }
        return data

    async def grant_access_to_public_data(self: EntityType, public_role=AuthRole.ANONYMOUS_VIEWER.value) -> EntityType:
        from flow_sdk.builtin.group import Group  # noqa: PLC0415

        # Make sure the public entity is a child of the saved entity
        public_entity = await Group.get_public_group()
        await public_entity.grant_role(self.typeid, to_role=public_role)
        return self

    async def get_public_data_role(self) -> List[str]:
        from flow_sdk.builtin.group import Group  # noqa: PLC0415

        # Make sure the public entity is a child of the saved entity
        public_entity = await Group.get_public_group()
        public_role, _ = await self.get_roles(public_entity.typeid)
        return public_role

    async def enable_public_access(self: EntityType) -> EntityType:
        from flow_sdk.builtin.group import Group  # noqa: PLC0415

        # Grant the public entity the specified role
        public_entity = await Group.get_public_group()
        await self.grant_role(public_entity.typeid)
        return self

    async def disable_public_access(self: EntityType) -> EntityType:
        from flow_sdk.builtin.group import Group  # noqa: PLC0415

        # Remove the role from the public entity
        public_entity = await Group.get_public_group()
        await self.remove_role(public_entity.typeid)
        return self

    def add_label(self, label: str) -> None:
        """Add a label to the entity."""
        if self.labels is None:
            self.labels = []
        # Check if label already exists
        if label not in self.labels:
            self.labels.append(label)

    def remove_label(self, label_id: str) -> bool:
        """Remove a label from the entity. Returns True if removed, False if not found."""
        if self.labels is None:
            return False
        original_count = len(self.labels)
        self.labels = [label for label in self.labels if label != label_id]
        return len(self.labels) < original_count

    def get_labels(self) -> List[str]:
        """Get all labels for the entity."""
        return self.labels or []

    # ── context_entities surface ─────────────────────────────────────────
    #
    # Mirrors the TS APIEntity API. Two buckets:
    #   * ``shared_context_entities``  — wire-bound. The read accessor is the
    #     field itself. One sanctioned auto-injection exists: at SHARE time a
    #     ``parent_share_on_default`` type appends its parent typeid via
    #     ``add_shared_context_entities`` (see ``share()`` / parent_share.py).
    #   * ``private_context_entities_``  — raw explicit storage (what the
    #     user/backend has actively attached). The computed property
    #     ``private_context_entities`` returns this *plus* implicit
    #     projections (e.g. the owning project), deduplicated.
    #
    # IMPORTANT — implicit projection lives in the backend, never the
    # frontend. The previous design had the FE compute ``project_id``-as-a-
    # chip via ``_directFieldsAsTypeIds`` (TS) / ``_direct_fields_as_typeids``
    # (Py). That meant two sides held the same projection logic and the FE
    # was effectively "computing context." User feedback: never compute
    # context on the FE. Implicit context comes from the server, always.
    #
    # The shape:
    #   * Subclasses extend implicit projection by overriding
    #     ``get_implicit_private_context_entities`` (call ``super()`` to
    #     keep the base project-id projection).
    #   * ``private_context_entities`` is a Pydantic computed field so it
    #     serializes to the wire; the FE just renders the resulting list.

    def get_implicit_private_context_entities(self) -> List[TypeId]:
        """Implicit private-context references derived from this entity's
        own state. Base implementation projects ``project_id`` when set —
        every entity that belongs to a project should display the project
        chip without anyone explicitly attaching it.

        Override in subclasses (and call ``super()``) to add more implicit
        projections. For now only ``project_id`` is implicit; previous
        per-subclass projections (assignee on Task, author_id on Spec,
        ``my_process_id`` / ``shared_process_id`` on Task) were removed
        when projection moved to the backend — they can be reintroduced as
        explicit subclass overrides here when there's a confirmed need."""
        project_id = getattr(self, "project_id", None)
        if project_id:
            return [TypeId(type=BuiltinEntityType.PROJECT.value, id=project_id)]
        return []

    async def effective_project_id(self: EntityType) -> "str | None":
        """Own ``project_id``, else the nearest ``parent_type_id`` ancestor's
        (e.g. a received claude session scopes to the conversation it was
        shared into). Read-only: the inherited project is never persisted onto
        the child, so a later re-mapping of the ancestor is followed live.
        """
        found = await self.nearest_ancestor(lambda e: getattr(e, "project_id", None))
        return found.project_id if found is not None else None

    @staticmethod
    async def project_id_of(entity_type: str, entity_id: str) -> "str | None":
        """The owning ``project_id`` of any entity, resolved SERVER-SIDE.

        Looks the type up in the registry and goes through its ``get_by_id``
        (which for some types includes on-disk recovery for unindexed rows),
        returning the target's ``effective_project_id`` — its own, else the
        nearest ``parent_type_id`` ancestor's. Best-effort: ``None`` when the
        type/target is unknown or the target is genuinely project-less. This is
        the single, entity-agnostic "what project owns this thing" primitive —
        used by tab project derivation and ``Conversation.resolve_project_id``.
        """
        try:
            model = SchemaRegistry.get_entity_cls(entity_type)
            if model is None:
                return None
            target = await model.get_by_id(str(entity_id))
            return await target.effective_project_id() if target is not None else None
        except Exception:
            import logging  # noqa: PLC0415

            logging.getLogger(__name__).debug("project_id_of: failed for %s/%s", entity_type, entity_id, exc_info=True)
            return None

    @computed_field(json_schema_extra={"sharing": str(Sharing.PRIVATE)})
    @property
    def private_context_entities(self) -> List[TypeId]:
        """Computed view: implicit projections + explicit raw storage,
        deduplicated by (type, id). This is what the FE sees over the
        wire — the FE never combines implicit + explicit itself.

        Decorated as a Pydantic ``computed_field`` so ``model_dump`` emits
        it on outbound payloads. Read-only on incoming payloads (the wire
        write path is ``private_context_entities_``)."""
        seen: set[tuple[str, str]] = set()
        out: List[TypeId] = []
        for t in self.get_implicit_private_context_entities():
            key = (t.type, t.id)
            if key in seen:
                continue
            seen.add(key)
            out.append(t)
        for t in self.private_context_entities_:
            key = (t.type, t.id)
            if key in seen:
                continue
            seen.add(key)
            out.append(t)
        return out

    @staticmethod
    def _normalize_typeids(args: tuple[Any, ...]) -> List[TypeId]:
        """Flatten variadic args that may mix TypeIds and lists/tuples of
        TypeIds. Drops ``None`` entries silently."""
        out: List[TypeId] = []
        for a in args:
            if a is None:
                continue
            if isinstance(a, TypeId):
                out.append(a)
            else:
                for t in a:
                    if t is not None:
                        out.append(t)
        return out

    _BUCKET_FIELDS = {"shared": "shared_context_entities", "private": "private_context_entities_"}
    _BUCKET_DATA_FIELDS = {"shared": "shared_context_entity_data", "private": "private_context_entity_data"}

    def _add_to_bucket(
        self,
        bucket: Literal["shared", "private"],
        type_ids: tuple[Any, ...],
        data: dict | None = None,
    ) -> bool:
        """Append typeids to a bucket, dedup by (type, id). Optionally attach
        per-entry sidecar ``data`` (applied to every typeid in ``type_ids``).
        Returns True if anything changed — either a new typeid added OR the
        sidecar data was added/updated for an existing typeid.

        Sidecar validation is best-effort: when the target type's class
        declares a ``context_data_schema``, ``data`` is run through it. On
        mismatch we warn but still store the data (sidecar is a hint for the
        404 self-heal; a malformed hint only degrades to the pre-fix 404
        behavior, never crashes).
        """
        incoming = self._normalize_typeids(type_ids)
        if not incoming:
            return False
        field = self._BUCKET_FIELDS[bucket]
        data_field = self._BUCKET_DATA_FIELDS[bucket]
        current = list(getattr(self, field))
        seen = {(t.type, t.id) for t in current}
        sidecar = dict(getattr(self, data_field) or {})
        changed = False
        for t in incoming:
            key = (t.type, t.id)
            if key not in seen:
                current.append(t)
                seen.add(key)
                changed = True
            if data is not None:
                tid_str = str(t)
                validated = self._validate_context_entry_data(t, data)
                if sidecar.get(tid_str) != validated:
                    sidecar[tid_str] = validated
                    changed = True
        if changed:
            setattr(self, field, current)
            setattr(self, data_field, sidecar)
        return changed

    @staticmethod
    def _validate_context_entry_data(target_typeid: TypeId, data: dict) -> dict:
        """Run sidecar ``data`` through the target type's declared
        ``context_data_schema`` when one exists. Returns the (possibly
        coerced) dict; on validation error logs a warning and returns the
        original dict unchanged so the hint still reaches the dock loader.
        """
        try:
            target_cls = SchemaRegistry.get_entity_cls(target_typeid.type)
        except Exception:
            target_cls = None
        schema = getattr(target_cls, "context_data_schema", None) if target_cls else None
        if schema is None:
            return dict(data)
        try:
            validated = schema.model_validate(data)
            return validated.model_dump()
        except ValidationError as exc:
            service_log.warn(
                f"context_entry_data validation failed for {target_typeid} "
                f"against {schema.__name__}: {exc}. Storing as-is."
            )
            return dict(data)

    def _remove_from_bucket(self, bucket: Literal["shared", "private"], type_ids: tuple[Any, ...]) -> bool:
        targets = self._normalize_typeids(type_ids)
        if not targets:
            return False
        field = self._BUCKET_FIELDS[bucket]
        data_field = self._BUCKET_DATA_FIELDS[bucket]
        drop = {(t.type, t.id) for t in targets}
        current: list[TypeId] = getattr(self, field)
        kept = [t for t in current if (t.type, t.id) not in drop]
        if len(kept) == len(current):
            return False
        setattr(self, field, kept)
        # Clean up sidecar entries for removed typeids.
        sidecar = getattr(self, data_field) or {}
        if sidecar:
            drop_strs = {str(t) for t in targets}
            pruned = {k: v for k, v in sidecar.items() if k not in drop_strs}
            if len(pruned) != len(sidecar):
                setattr(self, data_field, pruned)
        return True

    def add_shared_context_entities(
        self,
        *type_ids: "TypeId | list[TypeId] | None",
        data: dict | None = None,
    ) -> bool:
        """Append TypeIds to ``shared_context_entities`` (idempotent, deduped
        by (type, id)). Optional ``data`` is stored in
        ``shared_context_entity_data`` keyed by str(typeid); applied to every
        typeid in this call. Last-writer-wins on data conflicts."""
        return self._add_to_bucket("shared", type_ids, data=data)

    def remove_shared_context_entities(self, *type_ids: "TypeId | list[TypeId] | None") -> bool:
        return self._remove_from_bucket("shared", type_ids)

    def add_private_context_entities(
        self,
        *type_ids: "TypeId | list[TypeId] | None",
        data: dict | None = None,
    ) -> bool:
        """Append TypeIds to ``private_context_entities_`` (idempotent,
        deduped by (type, id)). Optional ``data`` is stored in
        ``private_context_entity_data`` keyed by str(typeid); applied to every
        typeid in this call. Last-writer-wins on data conflicts."""
        return self._add_to_bucket("private", type_ids, data=data)

    def remove_private_context_entities(self, *type_ids: "TypeId | list[TypeId] | None") -> bool:
        return self._remove_from_bucket("private", type_ids)

    def get_context_entry_data(self, typeid: "TypeId | str") -> dict | None:
        """Return the sidecar data dict for a typeid, or None if not present.
        Checks both shared and private sidecars (private wins on collision —
        consistent with the read-time precedence of explicit private storage).
        """
        key = str(typeid)
        priv = self.private_context_entity_data or {}
        if key in priv:
            return priv[key]
        shared = self.shared_context_entity_data or {}
        return shared.get(key)

    def _bucket_view(self, bucket: Literal["shared", "private", "both"]) -> List[TypeId]:
        if bucket == "shared":
            return list(self.shared_context_entities)
        if bucket == "private":
            return list(self.private_context_entities)
        if bucket == "both":
            return [*self.shared_context_entities, *self.private_context_entities]
        raise ValueError(f"bucket must be 'shared' | 'private' | 'both', got {bucket!r}")

    def context_of_type(self, type_name: str, *, bucket: Literal["shared", "private", "both"] = "both") -> List[TypeId]:
        """All context entries of the given entity type in the requested bucket."""
        return [t for t in self._bucket_view(bucket) if t.type == type_name]

    def first_context_of_type(
        self, type_name: str, *, bucket: Literal["shared", "private", "both"] = "both"
    ) -> TypeId | None:
        """First context entry of the given entity type in the requested bucket, or None."""
        return next((t for t in self._bucket_view(bucket) if t.type == type_name), None)

    def get_env_table(self) -> "EntityEnvVars":
        if not self.env_vars:
            return EntityEnvVars[EnvVar]()
        return self.env_vars

    def get_env_var(self, var_name: str) -> Optional[EnvVar]:
        if not self.env_vars:
            return None
        return self.env_vars.get_var(var_name)

    def set_env_var(self, env_var: EnvVar) -> None:
        if not self.env_vars:
            self.env_vars = EntityEnvVars[EnvVar]()
        existing_var = self.env_vars.get_var(env_var.name)
        if existing_var:
            existing_var.description = env_var.description
            existing_var.var_type = env_var.var_type
            existing_var.visible_value = env_var.visible_value
            existing_var.allowed_to_use = env_var.allowed_to_use
            existing_var.ref_type = env_var.ref_type
            existing_var.ref_name = env_var.ref_name
        else:
            self.env_vars.append(env_var)

    def update_env_var_visible_value(self, var_name: str, new_value: str) -> bool:
        if not self.env_vars:
            return False
        existing_var = self.env_vars.get_var(var_name)
        if existing_var:
            existing_var.visible_value = new_value
            return True
        return False

    def update_env_var_description(self, var_name: str, new_desc: str) -> bool:
        if not self.env_vars:
            return False
        existing_var = self.env_vars.get_var(var_name)
        if existing_var:
            existing_var.description = new_desc
            return True
        return False

    def remove_env_var(self, var_name: str) -> bool:
        if not self.env_vars:
            return False
        existing_var = self.env_vars.get_var(var_name)
        if existing_var:
            self.env_vars.remove(existing_var)
            return True
        return False

    async def get_triggers(self) -> List["Entity"]:
        """
        Get all Trigger entities connected to this entity via ConnectedTo relationship.

        Returns:
            List of Trigger entities connected to this entity (typed as Entity to avoid circular imports)
        """
        from flow_sdk.builtin.trigger import Trigger
        from flow_sdk.flowpad_types.enums import BuiltInRelationshipTypes

        relationships = await self.get_outgoing_relationships(
            relationships_filter=QueryFilter(type=BuiltInRelationshipTypes.ConnectedTo)
        )

        trigger_typeids = []
        for rel in relationships:
            to_typeid = rel.to_typeid
            if not to_typeid:
                continue
            if isinstance(to_typeid, str):
                to_typeid = TypeId(to_typeid)
            if to_typeid.type == BuiltinEntityType.TRIGGER.value:
                trigger_typeids.append(to_typeid)

        triggers: List[Entity] = []
        for typeid in trigger_typeids:
            trigger = await Trigger.get_by_typeid(typeid)
            if trigger:
                triggers.append(trigger)

        return triggers

    async def save_oauth_credentials(self, oauth_name: str, credentials: str, foreign_key: str = None) -> None:
        from flow_sdk.request_context.methods import set_user_credentials  # noqa: PLC0415

        await set_user_credentials(self, oauth_name, credentials, foreign_key)

        if self.env_vars is None:
            self.env_vars = EntityEnvVars[EnvVar]()

        existing_env_var = self.env_vars.get_var(oauth_name)
        if not existing_env_var:
            # Already imported at top

            new_env_var = EnvVar(
                name=oauth_name,
                description=f"OAuth credentials for {oauth_name}",
                var_type=EnvVarType.OAUTH_TOKEN,
                ref_type=BuiltinEntityType.USER,
                ref_name=oauth_name,  # ref_name must match the credentials name for get_user_credentials to find it
            )

            self.env_vars.append(new_env_var)
            await self.update()
        else:
            # Always ensure ref_type and ref_name are set correctly (handles env vars created through other paths)
            # Already imported at top

            existing_env_var.ref_type = BuiltinEntityType.USER
            existing_env_var.ref_name = oauth_name
            await self.update()

    async def remove_oauth_credentials(self, provider_id: str) -> bool:
        # This method is only valid for User entities
        if self.type != BuiltinEntityType.USER.value:
            raise ValueError(f"remove_oauth_credentials can only be called on User entities, not {self.type}")

        if self.env_vars is None or len(self.env_vars.values) == 0:
            return False

        env_var_to_remove = self.env_vars.get_var(provider_id)
        if not env_var_to_remove:
            return False

        try:
            from flow_sdk.request_context.methods import delete_user_credentials  # noqa: PLC0415

            # Pass self.id as foreign_key to match the device-flow write convention
            # in flow_sdk.app.actions.desktop_oauth._save_github_token_to_sod —
            # otherwise the composed SOD key diverges and the token is silently
            # leaked on disk after a user-initiated revocation.
            await delete_user_credentials(self, provider_id, self.id)
        except Exception as e:
            # ERROR (not warn): a swallowed FK ValueError here means a user
            # believed they revoked a credential but the SOD blob is still
            # on disk — a real security regression worth surfacing in logs.
            service_log.error(f"Failed to delete OAuth credentials for {provider_id}: {e}", exc_info=True)

        self.env_vars.values.remove(env_var_to_remove)
        await self.update()

        return True


# NOTE: the former ACL ``Group`` (name-unique principal with a "public" group)
# lived here. It was dormant (zero callers) and its ``"group"`` type value has
# been repurposed for the generic folder-like container entity in
# ``flow_sdk/builtin/group.py`` (docs/entities-groups.md).


from flow_sdk.actions.action_registry import action as _action_registry  # noqa: E402

# Bare-name registration: ActionManager's fallback lookup resolves it for any Entity subclass.
_action_registry.register(
    action_name="entity-event",
    function_name="entity_event",
    handler=Entity.entity_event,
    methods="post",
    types="all",
)


async def _http_favorite(self: Entity):
    from flow_sdk.request_context.methods import get_current_request_info  # noqa: PLC0415
    from flow_sdk.responses.response import ApiSuccessResponse  # noqa: PLC0415

    request_info = get_current_request_info()
    body = await request_info.get_post_data() if request_info is not None else {}
    title = body.get("title") if isinstance(body, dict) else None
    bookmark = await self.favorite(title=title)
    return ApiSuccessResponse(
        data={
            "bookmark_id": str(bookmark.id) if bookmark is not None else None,
            "bookmark_typeid": str(bookmark.typeid) if bookmark is not None else None,
            "title": getattr(bookmark, "title", None),
            "favorited": True,
        }
    )


async def _http_unfavorite(self: Entity):
    from flow_sdk.responses.response import ApiSuccessResponse  # noqa: PLC0415

    deleted = await self.unfavorite()
    return ApiSuccessResponse(data={"deleted": deleted, "favorited": False})


async def _http_setup(self: Entity):
    """Open / set up an already-materialized entity — the reception hook reused for
    the open-an-existing surfaces (artifact favorites/cards/chips, skill run).

    Returns the DisplayTarget to navigate to: ``setup_on_receive`` opens the entity
    directly (no setup skill) or spawns a headless Vibe setup session and returns
    ITS target. Project/workdir default to the entity's own binding; the caller may
    override ``project_id`` (e.g. the conversation-mapped project)."""
    from flow_sdk.request_context.methods import get_current_request_info  # noqa: PLC0415
    from flow_sdk.responses.response import ApiSuccessResponse  # noqa: PLC0415

    request_info = get_current_request_info()
    body = await request_info.get_post_data() if request_info is not None else {}
    project_id = (body.get("project_id") if isinstance(body, dict) else None) or getattr(self, "project_id", None)
    workdir = await self._setup_workdir(project_id)
    show = await self.setup_on_receive(project_id=project_id, workdir=workdir)
    return ApiSuccessResponse(data={"show": show})


_action_registry.register(
    action_name="favorite",
    function_name="favorite",
    handler=_http_favorite,
    methods="post",
    types="all",
)
_action_registry.register(
    action_name="unfavorite",
    function_name="unfavorite",
    handler=_http_unfavorite,
    methods="post",
    types="all",
)
_action_registry.register(
    action_name="setup",
    function_name="setup",
    handler=_http_setup,
    methods="post",
    types="all",
)


async def _http_set_group(self: Entity):
    """Generic membership move: place this entity into a Group (or ungroup).

    The folder semantics and every rule (target exists, same project, no
    cycles, namespace immutability) live in ``Group.validate_membership`` —
    this handler only parses the body and delegates (docs/entities-groups.md).
    """
    from flow_sdk.builtin.group import Group  # noqa: PLC0415
    from flow_sdk.request_context.methods import get_current_request_info  # noqa: PLC0415
    from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse  # noqa: PLC0415

    request_info = get_current_request_info()
    body = await request_info.get_post_data() if request_info is not None else {}
    group_id = body.get("group_id") if isinstance(body, dict) else None

    error = await Group.validate_membership(self, group_id)
    if error:
        return ApiFailResponse(message=error)
    self.group_id = group_id
    await self.save()
    return ApiSuccessResponse(data={"group_id": group_id})


_action_registry.register(
    action_name="set-group",
    function_name="set_group",
    handler=_http_set_group,
    methods="post",
    types="all",
)


async def _http_semantic_status(self: Entity):
    """This entity's dependson rows, both directions (as lock / as target),
    with their SemanticLock verdict fields. Minimal v1 relationship surface."""
    from flow_sdk.responses.response import ApiSuccessResponse  # noqa: PLC0415
    from flow_sdk.semantic_lock.runner import semantic_status  # noqa: PLC0415

    return ApiSuccessResponse(data=await semantic_status(self))


async def _http_semantic_waive(self: Entity):
    """User waive ("it's ok"): align the relationship's validated hashes to
    the CURRENT content, stamp validated_by=user / status=ok, and resolve the
    open lock_break annotations. Body: ``{"relationship_id": ...}`` — must
    reference a dependson row touching this entity."""
    from flow_sdk.request_context.methods import get_current_request_info  # noqa: PLC0415
    from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse  # noqa: PLC0415
    from flow_sdk.semantic_lock.runner import waive_relationship  # noqa: PLC0415

    request_info = get_current_request_info()
    body = await request_info.get_post_data() if request_info is not None else {}
    relationship_id = body.get("relationship_id") if isinstance(body, dict) else None
    if not relationship_id:
        return ApiFailResponse(message="relationship_id is required")
    updated = await waive_relationship(self, str(relationship_id))
    if updated is None:
        return ApiFailResponse(message=f"No dependson relationship {relationship_id} on {self.typeid}")
    return ApiSuccessResponse(data=updated)


_action_registry.register(
    action_name="semantic-status",
    function_name="semantic_status",
    handler=_http_semantic_status,
    methods="get",
    types="all",
)
_action_registry.register(
    action_name="semantic-waive",
    function_name="semantic_waive",
    handler=_http_semantic_waive,
    methods="post",
    types="all",
)


async def _http_activate(self: Entity):
    """Stamp ``last_active_at = now`` (server clock, epoch-ms) — the tab
    resolver's recency seed (docs/tab-management.md Part 3 §4). Loaders call
    this fire-and-forget on tab activation. Never touches membership:
    membership promotion is explicit-only (``tabs/open``)."""
    from flow_sdk.api.api_types.messages import DataOpMessage, OperationType  # noqa: PLC0415
    from flow_sdk.fs_store.fs_record import record_sync_guard  # noqa: PLC0415
    from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse  # noqa: PLC0415
    from flow_sdk.utils.serialization import now_epoch_ms  # noqa: PLC0415

    stamped_at = now_epoch_ms()
    async with record_sync_guard(self.get_type(), self.id):
        persisted, did_stamp = await self._db.stamp_last_active_at(self.id, stamped_at)
        if persisted is None:
            return ApiFailResponse(message=f"Entity no longer exists: {self.typeid}", status_code=404)

        # A soft-closed (``visible=False``) Tab is not a resolver candidate, and
        # activation is recency-only — it NEVER re-shows membership (reopen goes
        # through ``tabs/open`` → ``ensure_tab``, which is the sole re-show path).
        # Inspect the authoritative row inside the writer transaction above, not
        # ``self``: this request snapshot can predate the close it races with.
        if not did_stamp:
            return ApiSuccessResponse(data={"last_active_at": persisted.last_active_at})

        # Generic activate historically flowed through ``Entity.save``.  Some
        # types (notably ShellMeta) deliberately persist recency to their record,
        # so retain that contract with a one-field merge from the authoritative
        # row.  Never full-save ``self``: it may be the stale request snapshot.
        if "last_active_at" in persisted.metadata_payload():
            record = await persisted.get_record()
            if record is not None:
                import asyncio  # noqa: PLC0415

                try:
                    await asyncio.to_thread(record.save_metadata_field, "last_active_at", stamped_at)
                except Exception as exc:
                    from flow_sdk.fs_store.operations.record_error import (  # noqa: PLC0415
                        from_exception,
                    )

                    from_exception(record, exc, trigger="activate").save()

        # Keep the action receiver coherent without clearing any unrelated
        # pending mutation it may carry.  The DB write above is deliberately
        # recency-only.
        was_dirty = self._dirty
        self.last_active_at = stamped_at
        self._dirty = was_dirty

        # Publish before releasing the record guard, so a newer normal save
        # cannot emit first and then be followed by this older full-row update.
        # The payload is the freshly persisted row, never stale ``self``.
        change = DataOpMessage(
            data=persisted,
            op=OperationType.UPDATE,
            to_entity=self.typeid,
        )
        await self.add_entity_op_notification(change)
        self._notify_observers(change)
        return ApiSuccessResponse(data={"last_active_at": stamped_at})


_action_registry.register(
    action_name="activate",
    function_name="activate",
    handler=_http_activate,
    methods="post",
    types="all",
)
