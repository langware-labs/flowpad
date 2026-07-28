import asyncio
import logging
import ntpath
import os
import random
import string
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, List, Optional

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    TypeAdapter,
    computed_field,
    model_validator,
)
from pydantic.alias_generators import to_camel

from flow_sdk._compat import StrEnum  # 3.10-safe StrEnum (project pins py3.10)
from flow_sdk.api.api_types.api_field import APIField, Persist
from flow_sdk.api.type_id import TypeId
from flow_sdk.builtin.asset_menu import BrowsingOptions
from flow_sdk.builtin.faas.compute_node import ComputeNode
from flow_sdk.builtin.git_origin import GitOrigin
from flow_sdk.builtin.worker_sessions import get_worker_sessions
from flow_sdk.config import AGENT_MOUNT_FOLDER, PLATFORM_WIN32, StorageProvider
from flow_sdk.core import Entity, action
from flow_sdk.core.entity.entity_model import migrate_presence_shaped_members
from flow_sdk.core.flow.flow_source_control import ComputeSourceControlInitializeOptions
from flow_sdk.core.flow.mcp_server import MCPConnector, mcp_connector_pool
from flow_sdk.core.flow.models.execution.env_context import get_env_vars_context
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.fs_store.identifier import mint_uuid
from flow_sdk.fs_store.path_utils import (
    canonical_posix_path,
    is_protected_path,
    is_valid_project_cwd,
)
from flow_sdk.request_context.methods import (
    get_current_request_info,
)
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse
from flow_sdk.utils.git import find_local_repo_for_url, git_clone

log = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _generate_session_code() -> str:
    """Generate a shareable XXXX-XXXX join code."""
    alphabet = string.ascii_uppercase + string.digits
    left = "".join(random.choices(alphabet, k=4))
    right = "".join(random.choices(alphabet, k=4))
    return f"{left}-{right}"


class ProjectInitializeOptions(ComputeSourceControlInitializeOptions):
    model_config = ConfigDict(alias_generator=to_camel, validate_by_name=True)

    mcp_connector_init: bool = Field(default=True)


class CommunityMode(StrEnum):
    """Who answers community (support-center) conversations on this project.

    Only ``HUMAN`` is wired in v1: staff pick tickets up from a shared pool and
    reply under the masked ``display_name``. ``AI`` / ``HYBRID`` are reserved
    for an automated responder and are intentionally not yet implemented.
    """

    HUMAN = "human"
    AI = "ai"
    HYBRID = "hybrid"


class CommunityConfig(BaseModel):
    """Per-project "support center" configuration.

    When ``enabled``, the project accepts guest-opened community conversations
    (support tickets). All staff replies in those conversations are displayed
    under the single ``display_name`` identity regardless of which member
    actually replied — the responder's real ``sender_id`` is preserved on the
    wire, only the displayed ``sender_name`` is masked to ``display_name``.
    """

    enabled: bool = False
    display_name: Optional[str] = None
    avatar_url: Optional[str] = None
    welcome_message: Optional[str] = None
    mode: CommunityMode = CommunityMode.HUMAN


class Project(Entity):
    type: str = APIField(default=BuiltinEntityType.PROJECT.value)
    name: str | None = APIField(default=None, description="Display name of the project")
    artifacts: List[str] = APIField(
        default_factory=list,
        description="List of artifact IDs belonging to this project",
    )
    # Support-center / community config. None on ordinary projects. Persisted
    # (persist=TRUE) so it round-trips FS<->DB and is readable on the hub at
    # message-write time to mask responder identity. See ``CommunityConfig``.
    community: Optional[CommunityConfig] = APIField(
        default=None,
        persist=Persist.TRUE,
        description="Support-center configuration; set on the canonical community project.",
    )
    last_mode: str | None = APIField(
        default=None,
        description="Last UI view mode used in this project (vibe|standard|advanced|dev). "
        "Applied on project load so the mode is remembered per project.",
    )
    fs_storage_provider: StorageProvider | None = StorageProvider.SANDBOX
    fs_storage_mount_path: str | None = APIField(default=None, description="Full path to the project folder")
    # Portable repository identity for a project shared through the hub. This
    # is never the sender's local worktree path; the recipient uses it to
    # clone/materialize its own checkout.
    git_origin: GitOrigin | None = APIField(
        default=None,
        description="Portable Git repository origin used to materialize a shared project.",
    )
    # Legacy stash for the removed stored ``include_dirs`` field. Context
    # folders are now Folder entities linked via the base-Entity context
    # buckets (see the computed ``include_dirs`` property); any raw
    # ``include_dirs`` key still arriving from old DB rows / metadata.json is
    # captured here by ``_stash_legacy_include_dirs`` and converted into
    # folder links at the next write (``_migrate_legacy_context_dirs``).
    # persist=FALSE: the stash itself must never be re-persisted.
    legacy_include_dirs_: list[str] = APIField(
        default_factory=list,
        persist=Persist.FALSE,
        description="Legacy include_dirs values pending migration into Folder context links.",
    )
    # ── Collaboration overlay (merged from the former CollaborationSpace entity) ──
    session_code: str | None = APIField(
        default=None,
        description="Shareable join code for the project's collaboration space, e.g. ABCD-EFGH. Lazily generated.",
    )
    host_member_id: str | None = APIField(
        default=None,
        description="Stable local member_id of whoever first started collaboration on this project",
    )
    presence: list[dict] = APIField(
        default_factory=list,
        description="Local collaboration presence: [{member_id, name, joined_at, last_seen_at}] (session-code join, no roles). Renamed from ``members`` to free that name for the hub role roster now on the Entity base.",
    )
    # ── Hub collaboration (Project as a shared unit — mirrors Conversation) ──
    # The project's own (uuid4) id IS the shared hub identity: on share the hub
    # row and the recipient's local mirror both live under it (no separate cloud
    # id). This works because project ids are opaque uuid4, not path-derived.
    # The hub role roster is cached generically on the Entity base as ``members``
    # ([{user_id, email, name, role}] with roles owner/admin/member/reader),
    # written by the reflected ``members`` action mirror and read by the Members
    # UI. Distinct from the local ``presence`` overlay (session-code join, no roles).
    shared_secret_origins: dict[str, dict[str, Any]] = APIField(
        default_factory=dict,
        description="Hub-side value-free secret pointer metadata keyed by SecretOrigin typeid.",
    )
    shared_context_origins: dict[str, dict[str, Any]] = APIField(
        default_factory=dict,
        persist=Persist.FALSE,
        description="Hub-side transportable context-folder origins keyed by Folder typeid.",
    )
    # ── Indexer-denormalized fields (project consolidation, Path A 2026-05-09) ──
    # Written by the indexer at adopt time via ``Project.from_record`` so the
    # frontend can render activity hints (session count, last activity) without
    # querying records. Records remain backend-only.
    session_count: int = APIField(
        default=0,
        persist=Persist.FALSE,
        description="Total session count across providers (Claude + Codex) at this project's cwd. "
        "Denormalized from the matching ProjectFsRecord at indexer-write time.",
    )
    last_session_at: str | None = APIField(
        default=None,
        persist=Persist.FALSE,
        description="ISO timestamp of the most recent session activity at this project's cwd, "
        "denormalized from the matching ProjectFsRecord. Null if no sessions yet.",
    )

    @property
    def protected_path(self) -> bool:
        """Whether this project's source path is forbidden as a delete target."""
        return bool(
            self.fs_storage_mount_path
            and is_protected_path(self.fs_storage_mount_path)
        )

    @model_validator(mode="before")
    @classmethod
    def _migrate_legacy_presence(cls, data):
        return migrate_presence_shaped_members(data)

    @model_validator(mode="before")
    @classmethod
    def _stash_legacy_include_dirs(cls, data):
        """Capture a raw ``include_dirs`` key into the legacy stash.

        ``include_dirs`` is a computed field now; pydantic would silently drop
        the raw key on hydration (old DB rows, old metadata.json, or a
        ``Project(**model_dump())`` round-trip feeding the computed output
        back in). Stashing keeps the values visible through the computed
        merge until ``_migrate_legacy_context_dirs`` converts them into
        Folder context links. Idempotent: post-migration round-trips re-stash
        already-covered paths, which the migration then no-ops on.
        """
        if isinstance(data, dict) and "include_dirs" in data:
            raw = data.pop("include_dirs")
            if isinstance(raw, list):
                merged = list(data.get("legacy_include_dirs_") or [])
                merged.extend(d for d in raw if isinstance(d, str) and d)
                data["legacy_include_dirs_"] = list(dict.fromkeys(merged))
        return data

    @computed_field
    @property
    def include_dirs(self) -> list[str]:
        """Project context folders, derived from Folder context links.

        Walks both context buckets (private links never leave this machine;
        shared links travel with the project) and reads each folder's
        canonical path from the per-entry sidecar stamped at link time —
        strictly sync/in-memory, because the agentic-process spawn path reads
        this via ``getattr`` (see ``resolved_add_dirs``). Entries without a
        locally-resolvable sidecar path (e.g. a shared link received from a
        peer) are skipped. Legacy stashed values are merged until migrated.
        """
        out: list[str] = []
        seen: set[str] = set()
        for tid in self.context_of_type("folder", bucket="both"):
            entry = self.get_context_entry_data(tid) or {}
            p = entry.get("path")
            if isinstance(p, str) and p and p not in seen:
                seen.add(p)
                out.append(p)
        for p in self.legacy_include_dirs_ or []:
            if p and p not in seen:
                seen.add(p)
                out.append(p)
        return out

    @computed_field
    @property
    def customization(self) -> dict[str, Any]:
        """Optional per-project home branding, read from ``.flow/customization/``.

        A project (e.g. a launched template) can ship a ``.flow/customization/``
        folder to brand the desktop home when it is the active project:
        * ``string.json`` → ``{"home_title": "..."}`` overrides the greeting.
        * ``home.png`` present → the home renders it as a background.

        Strictly sync + best-effort (missing mount / dir / file / bad JSON →
        defaults), like ``include_dirs`` — it serializes into the Project
        payload the UI already receives, so no route or bootstrap change.
        The image bytes are served on demand via the generic ``fs`` download
        action; here we only surface a boolean so the UI knows to ask.
        """
        import json  # noqa: PLC0415
        from pathlib import Path  # noqa: PLC0415

        default = {"home_title": None, "has_home_background": False}
        root = self.fs_storage_mount_path
        if not root:
            return default
        cust_dir = Path(root) / ".flow" / "customization"
        # Fast path: almost every project has no customization dir — one stat and
        # out, rather than stat-ing each file below on every serialization.
        try:
            if not cust_dir.is_dir():
                return default
        except OSError:
            return default
        home_title: str | None = None
        try:
            string_path = cust_dir / "string.json"
            if string_path.is_file():
                data = json.loads(string_path.read_text(encoding="utf-8"))
                raw = data.get("home_title") if isinstance(data, dict) else None
                if isinstance(raw, str) and raw.strip():
                    home_title = raw.strip()
        except (OSError, ValueError):
            pass
        try:
            has_bg = (cust_dir / "home.png").is_file()
        except OSError:
            has_bg = False
        return {"home_title": home_title, "has_home_background": has_bg}

    @computed_field
    @property
    def context_dir_infos(self) -> list[dict[str, str]]:
        """Per-context-folder info the UI needs beyond the bare path.

        Same sync sidecar walk as ``include_dirs`` (and the same ordering),
        plus the ``origin_kind`` stamped at link time ("git" / "local") so the
        UI can render git-backed folders distinctly, and the linked Folder's
        ``typeid`` so the UI can reference the folder entity (e.g. as a
        message attachment chip). Entries linked before the stamp existed —
        and legacy stashed dirs — default to "local".
        """
        out: list[dict[str, str]] = []
        seen: set[str] = set()
        for tid in self.context_of_type("folder", bucket="both"):
            entry = self.get_context_entry_data(tid) or {}
            p = entry.get("path")
            if isinstance(p, str) and p and p not in seen:
                seen.add(p)
                out.append(
                    {
                        "path": p,
                        "origin_kind": str(entry.get("origin_kind") or "local"),
                        "typeid": str(tid),
                    }
                )
        for p in self.legacy_include_dirs_ or []:
            if p and p not in seen:
                seen.add(p)
                out.append({"path": p, "origin_kind": "local", "typeid": ""})
        return out

    @computed_field
    @property
    def secret_origins(self) -> list[dict[str, Any]]:
        """Project secret pointer summaries, derived from SecretOrigin links.

        This read surface is intentionally value-free. It is sync-only because
        workers and the UI read it from serialized project state.
        """
        out: list[dict[str, Any]] = []
        seen: set[str] = set()
        for scope, bucket in (("shared", "shared"), ("private", "private")):
            for tid in self.context_of_type("secret_origin", bucket=bucket):
                key = str(tid)
                if key in seen:
                    continue
                seen.add(key)
                entry = dict(self.get_context_entry_data(tid) or {})
                # Receiver path: a project shared TO this instance carries the
                # value-free reference in the mirrored ``shared_secret_origins``
                # map (hub-authoritative), not in the local sidecar — the sidecar
                # is only populated on the machine that authored the pointer. Fall
                # back to the mirror so a received secret reads its metadata,
                # mirroring how context folders read ``shared_context_origins``.
                if not entry and bucket == "shared":
                    mirror = self.shared_secret_origins.get(key)
                    if isinstance(mirror, dict):
                        entry = dict(mirror)
                locator = entry.get("locator") if isinstance(entry.get("locator"), dict) else {}
                out.append(
                    {
                        "typeid": key,
                        "name": entry.get("name") or "",
                        "env_var": entry.get("env_var") or "",
                        "kind": entry.get("kind") or locator.get("kind") or "",
                        "locator": locator,
                        "sod_store": entry.get("sod_store") or "",
                        "scope": entry.get("scope") or scope,
                    }
                )
        return out

    @model_validator(mode="after")
    def set_fs_storage_mount_path(self):
        """Resolve a safe mount path and create its folder when needed."""
        # A remote mirror (a project shared TO this instance) has no local
        # working directory — it lives under the sharer's cwd on their machine,
        # not ours. Never derive a mount path from its display name or mkdir a
        # folder for it; that would materialize a bogus directory named after the
        # project on every recipient. Only canonicalize an explicit path below.
        if self.remote and not self.fs_storage_mount_path:
            return self
        if self.name and not self.fs_storage_mount_path:
            if os.path.isabs(self.name) or ntpath.isabs(self.name):
                # Name is an absolute path - use it directly as mount path
                self.fs_storage_mount_path = self.name
                self.name = ntpath.basename(self.name.rstrip("/\\"))
            elif "/" in self.name or "\\" in self.name:
                # Name is a VFS-relative path - convert to absolute OS path
                # VFS root maps to OS root ("/" on Unix, "C:\" on Windows)
                if sys.platform == PLATFORM_WIN32:
                    drive = os.path.splitdrive(AGENT_MOUNT_FOLDER)[0]
                    os_root = drive + os.sep
                else:
                    os_root = os.sep
                relative_name = self.name.lstrip("/\\")
                self.fs_storage_mount_path = os.path.normpath(
                    os.path.join(os_root, relative_name)
                )
                self.name = os.path.basename(self.fs_storage_mount_path)
            else:
                # Simple name like "my_first_project"
                leaf = os.path.basename(self.name)
                self.fs_storage_mount_path = os.path.join(AGENT_MOUNT_FOLDER, leaf)

        # Retain protected legacy paths so the model carries one truthful source
        # value. They remain readable for cleanup/migration, but must never be
        # created, canonicalized, recovered, or recursively deleted.
        if self.fs_storage_mount_path and self.protected_path:
            return self

        # Create the project folder if it doesn't exist.
        if self.fs_storage_mount_path and not os.path.exists(self.fs_storage_mount_path):
            try:
                os.makedirs(self.fs_storage_mount_path, exist_ok=True)
            except OSError as e:
                # Non-fatal and expected for discovered/external project roots
                # (e.g. decoded Claude project paths on read-only mounts). Debug,
                # not warning — otherwise enumerating many such projects floods
                # the log with hundreds of non-actionable lines.
                logging.debug(f"Project: could not create mount path {self.fs_storage_mount_path!r}: {e}")
        if self.fs_storage_mount_path:
            self.fs_storage_mount_path = canonical_posix_path(self.fs_storage_mount_path)
        return self

    @classmethod
    def derive_id_for_path(cls, path: str) -> str | None:
        """Legacy record ``project_id`` alias for a mount path.

        ``Project.id`` is the canonical entity id used by UI scope filters and
        project routes. Existing fs-record rows may still be stamped with this
        path-derived uuid5 before a Project row exists, so scope resolution
        keeps accepting it as a record-match alias. ``None`` when no path is
        given.
        """
        if not path:
            return None
        if not is_valid_project_cwd(path, include_temp=True):
            return None
        return mint_uuid(
            f"project:{canonical_posix_path(path)}",
            namespace=uuid.NAMESPACE_DNS,
        )

    @classmethod
    def allocate_id(cls, data: dict) -> str:
        """Return an opaque uuid4 entity id for this Project.

        Project entity ids are random uuid4, like every other entity — so a
        project can be shared under its own id (the Conversation model). The
        canonical ``fs_storage_mount_path`` is still the natural key, but dedup
        is the job of ``find_by_cwd`` (a lookup), NOT of a path-derived id.
        ``derive_id_for_path`` lives on only as a record-match *alias* (records
        stamped with it still resolve via ``record_projects``); it must never
        become the entity id again.

        Order of precedence:
          1. ``data['id']`` if it's a valid entity id (v4/v5 — a caller/materialize
             pre-mint, or an existing v5 project being reconstructed pre-migration).
          2. Random uuid4.

        Uses ``is_valid_entity_id`` (the v4/v5 mint/adopt gate), NOT ``is_valid_uuid``:
        a foreign non-v4/v5 id (e.g. a client-supplied v7) must not be adopted as an
        entity id. Deliberately keeps this override rather than inheriting the base —
        the base derives ``uuid5(type:id)`` from a non-uuid slug, which would
        reintroduce a v5 project id.
        """
        from flow_sdk.fs_store.identifier import is_valid_entity_id

        rid = data.get("id") or ""
        if rid and is_valid_entity_id(rid):
            return rid
        return mint_uuid()

    @classmethod
    async def find_by_cwd(cls, cwd: str) -> "Project | None":
        """Find an existing Project whose ``fs_storage_mount_path`` matches the
        given canonical posix cwd. Returns the first match, or ``None``.

        This is the natural key for project dedup. Callers that mint a fresh
        Project should always check find_by_cwd first; idempotent upsert is
        ``find_by_cwd or save-new``.
        """
        if not cwd:
            return None
        if not is_valid_project_cwd(cwd, include_temp=True):
            return None
        canonical = canonical_posix_path(cwd)
        existing = await cls.get_all()
        for proj in existing:
            mp = proj.fs_storage_mount_path
            if (
                mp
                and is_valid_project_cwd(mp, include_temp=True)
                and canonical_posix_path(mp) == canonical
            ):
                return proj
        return None

    @classmethod
    async def index_by_mount(cls) -> dict[str, "Project"]:
        """One read → ``{canonical_mount: Project}``, for resolving MANY paths.

        ``find_by_cwd`` is O(all projects) *per call*; a caller resolving a whole
        tree of paths with it does one full table read per path. This is the
        object-carrying twin of ``indexer.roots.load_project_mounts()``, which
        returns ``(mount, id)`` pairs only — callers that must then read each
        project's fields (``context_dir_infos``, ``name``) need the entities.

        Read-only: a pure lookup that never mints. Callers wanting find-or-create
        want ``recover_by_path`` instead. First mount wins on a duplicate,
        matching ``find_by_cwd``'s first-match contract.
        """
        out: dict[str, Project] = {}
        for proj in await cls.get_all():
            mount = proj.fs_storage_mount_path
            if not mount or not is_valid_project_cwd(mount, include_temp=True):
                continue
            key = canonical_posix_path(mount).rstrip("/")
            if key and key not in out:
                out[key] = proj
        return out

    @classmethod
    async def recover_by_path(cls, path: str) -> "Project | None":
        """Recover (or materialize) a Project for ``path``.

        Used by ``AgenticProcess.recover_project_action`` to resurrect orphaned
        processes whose ``project_id`` references a deleted project. ``path`` is
        typically ``AgenticProcess.workdir``.

        Phase 1 — exact-match an existing Project by canonical mount_path
                  (delegates to ``find_by_cwd``).
        Phase 2 — construct a fresh Project with an opaque uuid4 id. Records
                  stamped with the path-derived alias still resolve via
                  ``record_projects`` (injected by ``resolve_project_scope``), so
                  the entity id need not equal the alias.

        Returns ``None`` only when ``path`` is empty/falsy.
        """
        if not path:
            return None

        if not is_valid_project_cwd(path, include_temp=True):
            return None
        canonical = canonical_posix_path(path)

        # Phase 1: existing project at this canonical cwd.
        existing = await cls.find_by_cwd(canonical)
        if existing is not None:
            return existing

        # Phase 2: construct a fresh Project with an opaque uuid4 id. Records
        # stamped with the path-derived alias still resolve via ``record_projects``
        # (``derive_id_for_path`` is injected server-side by resolve_project_scope),
        # so the entity id no longer needs to equal the alias.
        proj = cls.model_validate(
            {
                "fs_storage_mount_path": canonical,
                "name": os.path.basename(canonical.rstrip(os.sep)) or canonical,
            }
        )
        proj.id = cls.allocate_id(proj.model_dump())
        await proj.save()
        return proj

    @classmethod
    async def from_record(cls, record, notify: bool = True):  # type: ignore[override]
        """Create or update a Project from a Record's meta_dict.

        Overrides ``Entity.from_record`` to dedup by canonical mount_path
        (the natural key) instead of by id (which is now an opaque uuid4).
        Without this override, every call would mint a new entity since the
        base implementation looks up by ``allocate_id``-derived id.

        Path source priority (first non-empty wins):
          1. ``fs_storage_mount_path`` — explicit field on the record's meta
          2. ``cwd`` — what ``ProjectFsRecord`` exposes (the natural key)
          3. ``real_path`` — legacy claude-project metadata
          4. ``name`` if it's an absolute path

        With (2) in place, the indexer-driven flow auto-adopts: each
        ``ProjectFsRecord`` written by ``upsert_for_cwd`` gets a matching
        ``Project`` entity created (or updated) on ``rec.sync_to_db()``.
        """
        data = record.meta_dict()
        mount_path = data.get("fs_storage_mount_path") or data.get("cwd") or data.get("real_path")
        if not mount_path:
            name = data.get("name", "")
            if name and (os.path.isabs(name) or ntpath.isabs(name)):
                mount_path = name

        if mount_path and not is_valid_project_cwd(
            mount_path,
            include_temp=True,
        ):
            return None
        canonical_mp = canonical_posix_path(mount_path) if mount_path else None
        existing: Project | None = None
        if canonical_mp:
            existing = await cls.find_by_cwd(canonical_mp)

        if existing is not None:
            # Update in place — apply meta fields the entity understands.
            for k, v in data.items():
                if k in ("id", "type"):
                    continue
                # Legacy stored include_dirs (now a computed field): route into
                # the migration stash instead of a doomed setattr.
                if k == "include_dirs":
                    if isinstance(v, list):
                        stash = list(existing.legacy_include_dirs_ or [])
                        stash.extend(d for d in v if isinstance(d, str) and d)
                        existing.legacy_include_dirs_ = list(dict.fromkeys(stash))
                    continue
                field = cls.model_fields.get(k)
                if field is not None:
                    # Declared fields validate through their annotation —
                    # metadata.json carries e.g. TypeId lists as plain strings
                    # (json default=str) and must coerce back on adopt.
                    try:
                        setattr(existing, k, TypeAdapter(field.annotation).validate_python(v))
                    except Exception:
                        pass
                elif hasattr(existing, k):
                    try:
                        setattr(existing, k, v)
                    except Exception:
                        pass
            # Ensure the canonical form is what's stored.
            existing.fs_storage_mount_path = canonical_mp
            # Denormalize indexer-supplied activity hints (Path A).
            if "session_count" in data:
                existing.session_count = int(data.get("session_count") or 0)
            if "last_session_at" in data:
                existing.last_session_at = data.get("last_session_at")
            await existing.save(notify=notify)
            return existing

        # Net-new project: opaque uuid4 entity id (via ``allocate_id``). Records
        # stamped with ``derive_id_for_path(cwd)`` still resolve via the record
        # alias, so the entity id no longer needs to equal that derived value.
        create_kwargs = {k: v for k, v in data.items() if k != "id"}
        if canonical_mp:
            create_kwargs["fs_storage_mount_path"] = canonical_mp
        # Drop record-only fields the Project entity doesn't carry — provenance
        # flags stay on ProjectFsRecord (backend only). Only denormalized
        # activity hints surface on the entity.
        for record_only in ("claude_project", "codex_project", "encoded_path", "last_indexed_at", "real_path", "cwd"):
            create_kwargs.pop(record_only, None)
        proj = cls(**create_kwargs)
        proj.id = cls.allocate_id(create_kwargs)
        await proj.save(notify=notify)
        return proj

    def _hub_body(self) -> dict:
        """Hub POST body for a shared project.

        The project's own (uuid4) id is the shared identity — the base body
        already emits ``id = self.id`` (same-id invariant), so no id swap. This
        override only strips local-only project fields the hub doesn't host
        (the working-dir path, the presence overlay, indexer hints).

        ``name`` travels VERBATIM: a project's display label is ``name`` on
        both sides. There is deliberately no ``name``→``title`` mapping here —
        that rename was the seam a project rename fell through (the reflected
        update PUT sends the raw request body, not this method, so the renamed
        ``name`` was dropped by the hub as an unknown field).
        """
        body = super()._hub_body()
        for local_only in (
            "fs_storage_mount_path",
            "fs_storage_provider",
            "last_mode",
            "session_code",
            "host_member_id",
            "presence",
            "include_dirs",
            "context_dir_infos",
            "secret_origins",
            "shared_secret_origins",
            "shared_context_origins",
            "session_count",
            "last_session_at",
        ):
            body.pop(local_only, None)
        return body

    async def _shared_context_origin_payload(self) -> dict[str, dict[str, Any]]:
        """Build the wire-safe origin map for shared context Folder refs."""
        payload: dict[str, dict[str, Any]] = {}
        from flow_sdk.builtin.folder import Folder  # noqa: PLC0415

        for tid in self.context_of_type("folder", bucket="shared"):
            folder = await Folder.get_by_id(tid.id)
            origin = folder.origin if folder is not None else None
            if origin is None or not origin.transportable:
                continue
            payload[str(tid)] = origin.model_dump(mode="json")
        return payload

    async def _shared_secret_origin_payload(self) -> dict[str, dict[str, Any]]:
        """Build the value-free hub payload for shared secret pointers."""
        payload: dict[str, dict[str, Any]] = {}
        from flow_sdk.builtin.secret_origin import SecretOrigin  # noqa: PLC0415

        for tid in self.context_of_type("secret_origin", bucket="shared"):
            entry = dict(self.get_context_entry_data(tid) or {})
            locator = entry.get("locator") if isinstance(entry.get("locator"), dict) else None
            name = entry.get("name") or ""
            env_var = entry.get("env_var") or ""
            sod_store = entry.get("sod_store") or ""
            if not locator or not name or not env_var:
                secret = await SecretOrigin.get_by_id(tid.id)
                if secret is None:
                    continue
                locator = secret.locator.model_dump(mode="json")
                name = secret.name or ""
                env_var = secret.env_var
                sod_store = secret.effective_sod_store()
            # EVERY declaration travels, including ``local``. A receiver has to
            # SEE a declaration in order to be told they are missing its value —
            # dropping it would silently hide the secret the project needs. What
            # does not travel is the machine-specific coordinate: a sod_name
            # names an entry in the sender's keychain and means nothing
            # elsewhere, so it is stripped from the wire locator.
            locator = dict(locator or {})
            if locator.get("kind") == "local":
                locator.pop("sod_name", None)
            payload[str(tid)] = {
                "name": name,
                "project_id": str(self.id),
                "env_var": env_var,
                "kind": locator.get("kind"),
                "locator": locator,
                "sod_store": sod_store,
            }
        return payload

    async def share(self, recipients: Optional[List[str]] = None) -> "Project":
        """Publish this project to the hub as a shared unit + invite recipients.

        Mirrors ``Conversation.share``: the project's own (uuid4) id is the shared
        identity, so ``super().share()`` publishes the hub row under ``self.id`` —
        no separate cloud id. Persisting ``remote=True`` on the local row is the
        caller's responsibility (``share_action.share_entity``).

        Without ``recipients``: just the hub create. The hub stamps the creator
        as ``owner`` on create (``save(owner=...)`` → literal 'owner' role edge;
        ``project`` relies on the hub's default ``owner:["*"]`` policy chain), so
        no explicit join is needed — the roster derives from role edges.
        With ``recipients`` (emails): one ``MembershipRequest`` per recipient
        targets ``project-<id>`` with role ``member`` via
        ``POST /graph/project/<id>/members`` — the recipient discovers it via
        ``GET /graph/invitation/pending`` and accepts via the standard flow
        (``flow_message_action.handle_invitation_accept`` →
        ``_membership_cls('project')`` → local ``remote=True`` Project mirror).
        """
        from flow_sdk.builtin.user import normalize_email  # noqa: PLC0415
        from flow_sdk.cli.auth.credentials import load_credentials  # noqa: PLC0415
        from flow_sdk.cloud_client.client import ApiConfig, FlowpadClient  # noqa: PLC0415
        from flow_sdk.core.entity.parent_share import parent_share_typeid  # noqa: PLC0415
        from flow_sdk.core.urls.service_urls import build_hub_url  # noqa: PLC0415

        creds = load_credentials()
        if not creds or not creds.api_key:
            raise RuntimeError("Cloud login required")

        parent_tid = parent_share_typeid(self)
        if parent_tid is not None:
            self.add_shared_context_entities(parent_tid)
        body = self._hub_body()
        if self.fs_storage_mount_path:
            origin = await asyncio.to_thread(GitOrigin.for_asset_path, self.fs_storage_mount_path)
            if origin is not None:
                self.git_origin = origin
                body["git_origin"] = origin.model_dump(mode="json")
        shared_context_origins = await self._shared_context_origin_payload()
        invalid_shared_folders = [
            str(tid)
            for tid in self.context_of_type("folder", bucket="shared")
            if str(tid) not in shared_context_origins
        ]
        if invalid_shared_folders:
            raise RuntimeError(
                "Shared context folders must have transportable origins before sharing: "
                + ", ".join(invalid_shared_folders)
            )
        if shared_context_origins:
            body["shared_context_origins"] = shared_context_origins
        body["shared_secret_origins"] = await self._shared_secret_origin_payload()

        async with FlowpadClient(ApiConfig.from_env(), api_key=creds.api_key) as client:
            await client.post(build_hub_url(self.get_type()), body)
            if "remote" in type(self).model_fields:
                self.remote = True
            if not recipients:
                return self
            for email in recipients:
                if not email or not isinstance(email, str):
                    continue
                email = normalize_email(email)
                if not email:
                    continue
                await client.post(
                    f"/graph/project/{self.id}/members",
                    {
                        "recipient_email": email,
                        "invitation_targets": [
                            {"typeid": f"project-{self.id}", "role": "member"},
                        ],
                    },
                )
        return self

    async def setup_from_git_origin(self) -> "Project":
        """Materialize this shared project into a local Git worktree.

        The hub carries only ``GitOrigin``. This method owns the recipient-side
        placement: reuse a matching local checkout when present, otherwise clone
        into the workspace slot ``GitOrigin.next_clone_target`` picks, then bind
        the existing shared Project id to that checkout and index it.
        """
        origin = self.git_origin
        if origin is None:
            raise RuntimeError("Shared project has no Git origin")

        from flow_sdk.app.actions.oauth_action import _get_github_token_for_current_user  # noqa: PLC0415
        from flow_sdk.builtin.agentic_process.agentic_process import _index_additional_dir  # noqa: PLC0415

        existing = await asyncio.to_thread(find_local_repo_for_url, origin.clone_url())
        if existing and origin.matches_checkout(existing, require_branch=bool(origin.branch)):
            target_dir = existing
        else:
            target_dir = str(await asyncio.to_thread(origin.next_clone_target))
            token, _ = await _get_github_token_for_current_user()
            ok, message = await git_clone(
                origin.clone_url(),
                target_dir,
                branch=origin.branch or None,
                token=token,
            )
            if not ok:
                raise RuntimeError(message)

        self.fs_storage_mount_path = canonical_posix_path(target_dir)
        self.name = os.path.basename(target_dir.rstrip(os.sep))
        self.remote = True
        await self.save()
        await self.setup_for_desktop()
        await _index_additional_dir(target_dir)
        return self

    @action.post(action_name="setup-from-git")
    async def setup_from_git(self) -> ApiResponse:
        """Materialize a remote project's transmitted GitOrigin locally."""
        try:
            project = await self.setup_from_git_origin()
            return ApiSuccessResponse(data=project)
        except Exception as exc:  # noqa: BLE001
            return ApiFailResponse(message=str(exc), status_code=400)

    @property
    def main_ref(self):
        """FSRef pointing to the project working directory."""
        if not self.fs_storage_mount_path:
            return None
        from pathlib import Path

        from flow_sdk.fs_store.fs_ref import FSRef

        return FSRef(Path(self.fs_storage_mount_path))

    async def git_workdir(self):
        """``GitRepo`` bound to this project's working tree, or ``None`` when the
        project has no working directory or compute node. ``None`` does NOT mean
        "not a git repo" — that stays the async ``is_init()`` probe on the result.

        Mirrored by ``Project.getGitWorkdir()`` in ts_sdk.
        """
        if not self.fs_storage_mount_path:
            return None
        compute_node = await self.get_compute_node()
        if compute_node is None:
            return None
        from flow_sdk.builtin.faas.git_repo import GitRepo

        return GitRepo(self.fs_storage_mount_path, compute_node)

    async def get_compute_node(self):
        from flow_sdk.config import default_service_config

        # In desktop/local mode, always use the @local compute node singleton
        # (resolved/self-healed by the single source of truth).
        if default_service_config.is_local:
            return await ComputeNode.get_local()

        project_compute_nodes = await ComputeNode.get_all(source_entity=self.typeid)
        if project_compute_nodes:
            if len(project_compute_nodes) > 1:
                logging.warning(f"Multiple compute nodes found for project {self.typeid}")
                project_compute_nodes = list(
                    sorted(
                        project_compute_nodes,
                        key=lambda x: x.created_date or 0,
                        reverse=True,
                    )
                )
            return project_compute_nodes[0]
        return None

    async def get_mcp_connector(self):
        project_compute_node = await self.get_compute_node()
        if project_compute_node:
            return MCPConnector(compute_node=project_compute_node)
        warm_mcp_connector = await mcp_connector_pool.get_warm_mcp_connector()
        # Ensure compute_node exists in DB before creating relationship
        # Note: The pool's compute_node might think it exists in DB (created_by set from previous save)
        # but the DB may have been reset. Force-check and save if needed.
        compute_node = warm_mcp_connector.compute_node
        db_compute_node = await ComputeNode.get_by_id(compute_node.id)
        if not db_compute_node:
            # Node doesn't actually exist in DB - clear created_by to force save
            compute_node.created_by = None
            await compute_node.save()
        await self.add_child(compute_node)
        return warm_mcp_connector

    @classmethod
    async def get_mcp_connector_for_process(cls, process_typeid: TypeId):
        compute_node = await ComputeNode.get_one(source_entity=process_typeid)
        if compute_node:
            return MCPConnector(compute_node=compute_node)

        project = await cls.get_ancestor(process_typeid)
        if not project:
            logging.warning(f"No project or compute node found for process {process_typeid}")
            new_project = cls()
            await new_project.save()
            await new_project.attach_child(process_typeid)
            project = new_project
        return await project.get_mcp_connector()

    @classmethod
    async def get_mcp_connector_for_flow(cls, flow_typeid: TypeId):
        """Backward-compatible alias for get_mcp_connector_for_process."""
        return await cls.get_mcp_connector_for_process(flow_typeid)

    @action.post(action_name="initialize")
    async def initialize(self, initialize_options: ProjectInitializeOptions | None = None):
        if not initialize_options:
            initialize_options = ProjectInitializeOptions()

        mcp_connector = await self.get_mcp_connector()
        if initialize_options.mcp_connector_init:
            process_env_list = await get_env_vars_context(get_current_request_info().user, self)
            async with mcp_connector.initialize(initialize_options, process_env_list):
                pass

        compute_node = await self.get_compute_node()
        return ApiSuccessResponse(data={"compute_node": compute_node.model_dump() if compute_node else None})

    @action.get(action_name="get-compute-node")
    async def get_compute_node_action(self):
        compute_node = await self.get_compute_node()
        return ApiSuccessResponse(data={"compute_node": compute_node.model_dump() if compute_node else None})

    @action.get(action_name="get-assets")
    async def get_assets_action(
        self,
        types: str | None = None,
        limit: int = 1000,
        browsing: BrowsingOptions | None = None,
    ):
        """Discoverable assets for this project, pre-process (staging).

        The project-level counterpart of ``agentic_process/{id}/get-assets``:
        what a NEW process started in this project would see, before any
        process exists. Same path-scan + longest-prefix attribution
        (``scan_path_asset_descriptors``) over user-home / project-mount /
        context dirs; ``spec`` (not file-backed) comes from a bounded scoped
        DB list instead. Response shape matches the process action, plus
        ``project_id`` per row and a top-level ``truncated`` flag — the seam
        for FTS-backed long-tail search. Never unbounded: ``limit`` is
        clamped; callers wanting more should search, not list.

        ``browsing.menu`` adds ONE key, ``menu`` — the Assets navigator's
        structure (per-type groups with accumulated counts) for this project and,
        recursively, for each of its context folders. ``assets`` and
        ``truncated`` are unchanged and always present, so the existing flat
        consumers are untouched. The menu carries no leaves: type rows still
        load their entities lazily from ``/search`` on expand.

        Read-only throughout — no mint, no write, no indexer walk.
        """
        from flow_sdk.builtin.agentic_process.agentic_process import (  # noqa: PLC0415
            AssetDescriptor,
            AssetSource,
            collect_base_source_dirs,
            hydrate_asset_descriptor_remote,
            scan_path_asset_descriptors,
        )

        requested = (
            [t.strip() for t in types.split(",") if t.strip()]
            if types
            else [
                "skill",
                "agent",
                "markdown",
                "spec",
            ]
        )
        limit = max(1, min(int(limit), 2000))

        want_assets = browsing is None or browsing.assets
        sources, _seen = collect_base_source_dirs(self)

        file_backed = [t for t in requested if t != "spec"] if want_assets else []
        descriptors: list[AssetDescriptor] = []
        if file_backed:
            descriptors = await scan_path_asset_descriptors(
                sources,
                own_project_id=str(self.id),
                types=file_backed,
                limit=limit,
            )

        if want_assets and "spec" in requested and len(descriptors) < limit:
            from flow_sdk.builtin.spec import Spec  # noqa: PLC0415
            from flow_sdk.db.drivers.query import QueryFilter  # noqa: PLC0415

            # Own-project OR global (project_id unset) — one query; $IS_NULL is
            # unary, single-operand [field] shape.
            spec_rows = await Spec.get_all(
                QueryFilter.parse(
                    {
                        "match": {
                            "op": "$OR",
                            "operands": [
                                {"project_id": str(self.id)},
                                {"op": "$IS_NULL", "operands": ["project_id"]},
                            ],
                        },
                        "limit": limit - len(descriptors),
                    },
                    "spec",
                )
            )
            for spec_entity in spec_rows:
                spec_project_id = getattr(spec_entity, "project_id", None)
                descriptors.append(
                    AssetDescriptor(
                        typeid=f"spec-{spec_entity.id}",
                        source=(
                            AssetSource.PROJECT_DIR
                            if str(spec_project_id or "") == str(self.id)
                            else AssetSource.USER_DIR
                        ),
                        posix_path=None,
                        project_id=str(spec_project_id) if spec_project_id else None,
                        remote=bool(getattr(spec_entity, "remote", False)),
                    )
                )

        await hydrate_asset_descriptor_remote(descriptors)
        data = {
            "assets": [d.to_row() for d in descriptors],
            "truncated": len(descriptors) >= limit,
        }
        if browsing is not None and browsing.menu:
            from flow_sdk.builtin.asset_menu import build_asset_menu  # noqa: PLC0415

            menu = await build_asset_menu(
                self,
                # Only narrow when the CALLER asked for types. ``requested``
                # defaults to the flat staging list (skill/agent/markdown/spec);
                # the menu's own default is every browseable scannable type,
                # because it stands in for the whole Assets navigator.
                types=requested if types else None,
                recursive=browsing.recursive,
                max_depth=browsing.max_depth,
            )
            data["menu"] = menu.to_row()
        return ApiSuccessResponse(data=data)

    @action.get(action_name="get-worker-sessions")
    async def _get_worker_sessions_action(self):
        """Get worker sessions for current directory."""
        sessions = get_worker_sessions()
        return ApiSuccessResponse(data=sessions)

    # ── Secret pointers (SecretOrigin entities linked via context buckets) ──

    def _assets_sodot_dir(self) -> "Path | None":
        """``<project mount>/assets/sodot`` — where value-free secret reference
        json files live so they're indexed + travel with a git-shared project."""
        from pathlib import Path  # noqa: PLC0415

        mount = self.fs_storage_mount_path
        return (Path(mount) / "assets" / "sodot") if mount else None

    @action.post(action_name="add-secret-pointer")
    async def add_secret_pointer(
        self,
        name: str = "",
        env_var: str = "",
        scope: str = "private",
        kind: str = "local",
        locator: dict[str, Any] | None = None,
        sod_store: str = "",
        sod_name: str | None = None,
        secret_id: str | None = None,
    ) -> "ApiResponse":
        """Attach a value-free secret pointer to this project and write its
        reference json under ``assets/sodot/<name>.json`` (indexed + travels)."""
        from flow_sdk.builtin.secret_origin import (  # noqa: PLC0415
            SecretOrigin,
            is_valid_secret_origin_env_var,
        )
        from flow_sdk.builtin.secret_origin_driver import (  # noqa: PLC0415
            get_secret_origin_driver,
            normalize_secret_origin_kind,
        )
        from flow_sdk.builtin.secret_origin_field import SECRET_ORIGIN_ADAPTER  # noqa: PLC0415

        name = (name or "").strip()
        env_var = (env_var or "").strip()
        scope = (scope or "private").strip().lower()
        if not env_var:
            return ApiFailResponse(message="env_var is required")
        if not is_valid_secret_origin_env_var(env_var):
            return ApiFailResponse(message="env_var must be a valid environment variable name")
        if scope not in ("private", "shared"):
            return ApiFailResponse(message="scope must be 'private' or 'shared'")

        # Build the value-free locator from an explicit ``locator`` dict, or the
        # convenience kind + sod_name/secret_id params (back-compat).
        raw_locator = dict(locator or {})
        if not raw_locator:
            resolved_kind = normalize_secret_origin_kind(kind or ("flowpad-hub" if secret_id else "local"))
            raw_locator = {"kind": resolved_kind}
            if resolved_kind == "local":
                raw_locator["sod_name"] = (sod_name or name or "").strip()
            elif resolved_kind == "flowpad-hub":
                raw_locator["secret_id"] = (secret_id or "").strip()
        try:
            loc = SECRET_ORIGIN_ADAPTER.validate_python(raw_locator)
            get_secret_origin_driver(loc.kind)  # ensure a driver is registered for this kind
        except Exception as e:  # noqa: BLE001
            return ApiFailResponse(message=f"Invalid secret locator: {e}")

        if loc.kind == "local" and not getattr(loc, "sod_name", ""):
            return ApiFailResponse(message="sod_name is required for local secret pointers")
        name = name or getattr(loc, "sod_name", "") or getattr(loc, "secret_id", "") or env_var

        # No uniqueness CHECK is needed any more: the id is (project_id, env_var),
        # so re-declaring an env var mints the same row and updates it in place.
        # The name is the key — pointing it at a different provider is an edit,
        # not a second secret.
        secret = await SecretOrigin.mint_for(
            project_id=str(self.id), env_var=env_var, locator=loc, name=name, sod_store=sod_store
        )
        data = secret.context_data(scope=scope)
        if scope == "shared":
            self.add_shared_context_entities(secret.typeid, data=data)
        else:
            self.add_private_context_entities(secret.typeid, data=data)

        # Write the value-free reference json so it's indexed like any asset and
        # travels with the project's git-backed folder (see docs/secret_share.md).
        sodot_dir = self._assets_sodot_dir()
        if sodot_dir is not None:
            try:
                secret.to_json_asset(sodot_dir / f"{env_var}.json")
            except Exception as e:  # noqa: BLE001
                log.warning("[secret] could not write reference asset for %s: %s", name, e)

        await self.save()
        return ApiSuccessResponse(data=self.model_dump(mode="json"))

    @action.post(action_name="remove-secret-pointer")
    async def remove_secret_pointer(
        self,
        typeid: str | None = None,
        name: str | None = None,
        env_var: str | None = None,
    ) -> "ApiResponse":
        """Detach project secret pointers. The SecretOrigin row and secret value remain."""
        if not typeid and not name and not env_var:
            return ApiFailResponse(message="typeid, name, or env_var is required")
        targets: list[TypeId] = []
        if typeid:
            try:
                targets.append(TypeId.to_typeid(typeid))
            except Exception:
                targets.append(TypeId(type=BuiltinEntityType.SECRET_ORIGIN.value, id=typeid))
        else:
            want_name = (name or "").strip()
            want_env_var = (env_var or "").strip()
            for tid in self.context_of_type("secret_origin", bucket="both"):
                entry = self.get_context_entry_data(tid) or {}
                if want_name and entry.get("name") != want_name:
                    continue
                if want_env_var and entry.get("env_var") != want_env_var:
                    continue
                targets.append(tid)
        if targets:
            # Delete the value-free reference asset(s) too so removal is complete.
            sodot_dir = self._assets_sodot_dir()
            if sodot_dir is not None:
                for tid in targets:
                    entry = self.get_context_entry_data(tid) or {}
                    ev = (entry.get("env_var") or "").strip()
                    if ev:
                        try:
                            (sodot_dir / f"{ev}.json").unlink(missing_ok=True)
                        except OSError:
                            pass
            self.remove_shared_context_entities(*targets)
            self.remove_private_context_entities(*targets)
            await self.save()
        return ApiSuccessResponse(data=self.model_dump(mode="json"))

    @action.post(action_name="secret-resolve-status")
    async def secret_resolve_status(self) -> "ApiResponse":
        """Per-secret resolve status for the Secrets card / wizard: can each
        secret's value be resolved on THIS machine right now? Value-free — calls
        ``driver.can_resolve`` (never fetches a value)."""
        from flow_sdk.builtin.secret_origin_driver import get_secret_origin_driver  # noqa: PLC0415
        from flow_sdk.builtin.secret_origin_field import SECRET_ORIGIN_ADAPTER  # noqa: PLC0415

        rows: list[dict[str, Any]] = []
        # Drive off the value-free ``secret_origins`` summary — it reads the local
        # sidecar on the authoring machine and the mirrored ``shared_secret_origins``
        # on a receiver, so a shared pointer resolves on both sides.
        for entry in self.secret_origins:
            try:
                loc = SECRET_ORIGIN_ADAPTER.validate_python(entry.get("locator") or {})
                driver = get_secret_origin_driver(loc.kind)
            except Exception:  # noqa: BLE001
                continue
            env_var = entry.get("env_var") or ""
            found_in = await self._where_is_secret_value(env_var, loc, driver)
            hint = driver.setup_hint(loc)
            rows.append(
                {
                    "typeid": entry.get("typeid"),
                    "name": entry.get("name"),
                    "env_var": env_var,
                    "kind": loc.kind,
                    "scope": entry.get("scope"),
                    "sod_store": entry.get("sod_store") or hint.get("sod_store"),
                    "status": "available" if found_in else "missing",
                    "found_in": found_in,
                    # The receiver-facing warning: a declaration this machine
                    # cannot satisfy. Computed, never stored.
                    "warning": None if found_in else "missing-value",
                    "setup_hint": hint,
                }
            )
        return ApiSuccessResponse(data={"secrets": rows})

    async def _where_is_secret_value(self, env_var: str, loc, driver) -> str | None:
        """Which store on THIS machine can satisfy this declaration, if any.

        Deliberately a UNION across both local stores and the declared provider,
        not just the provider the declaration names. The local stores exist for
        usage — a value sitting in .env.local under the right env var satisfies a
        `gcp` declaration on this machine just as well, and reporting it missing
        would be wrong.

        Every probe is existence-only. No value is fetched here; that contract is
        what lets the Secrets card call this on every render.
        """
        from flow_sdk.builtin.env_local_store import list_env_local  # noqa: PLC0415

        if env_var:
            try:
                if any(row["key"] == env_var for row in list_env_local(self)):
                    return "env-local"
            except Exception:  # noqa: BLE001
                pass
            try:
                from flow_sdk.cli.auth.secrets import get_secrets  # noqa: PLC0415

                # Names only — get_secrets never reads a value out of the store.
                if any(entry.get("name") == env_var for entry in get_secrets()):
                    return "sodot"
            except Exception:  # noqa: BLE001
                pass
        try:
            if await driver.can_resolve(loc, project=self):
                return "provider"
        except Exception:  # noqa: BLE001
            pass
        return None

    @action.post(action_name="secret-drift-status")
    async def secret_drift_status(self) -> "ApiResponse":
        """Which declared secrets hold a different value than when last provided.

        Separate from ``secret-resolve-status`` on purpose: answering this
        REQUIRES fetching values, which would violate ``can_resolve``'s
        documented no-fetch contract. Keeping it a distinct, opt-in action means
        the cheap status call stays cheap and honest, and values are only pulled
        when someone is actually looking at the Secrets tab.

        Values are hashed and discarded — never returned, logged, or persisted.
        """
        from flow_sdk.builtin.secret_origin_digest import check_drift  # noqa: PLC0415
        from flow_sdk.builtin.secret_origin_driver import get_secret_origin_driver  # noqa: PLC0415
        from flow_sdk.builtin.secret_origin_field import SECRET_ORIGIN_ADAPTER  # noqa: PLC0415

        rows: list[dict[str, Any]] = []
        for entry in self.secret_origins:
            env_var = entry.get("env_var") or ""
            try:
                loc = SECRET_ORIGIN_ADAPTER.validate_python(entry.get("locator") or {})
                driver = get_secret_origin_driver(loc.kind)
            except Exception:  # noqa: BLE001
                continue
            try:
                resolved = await driver.resolve(loc, project=self)
            except Exception:  # noqa: BLE001
                resolved = None
            if resolved is None:
                continue
            drifted = await asyncio.to_thread(
                check_drift, str(self.id), env_var, resolved.get_secret_value()
            )
            rows.append(
                {
                    "typeid": entry.get("typeid"),
                    "env_var": env_var,
                    "warning": "value-changed" if drifted else None,
                }
            )
        return ApiSuccessResponse(data={"secrets": rows})

    @action.post(action_name="provide-secret")
    async def provide_secret(
        self,
        typeid: str | None = None,
        env_var: str | None = None,
        value: str = "",
    ) -> "ApiResponse":
        """Setup wizard: store a user-provided value in the secret's designated
        SOD store — the encrypted ``sodot`` (for ``local`` pointers) or the
        project's ``.env.local`` (for ``env-local`` pointers). The value is NEVER
        written to the reference json or any hub payload. V1 supports the two
        local stores; external providers (gcp/1password/hub) are 'coming soon'."""
        from flow_sdk.builtin.secret_origin_driver import (  # noqa: PLC0415
            SecretProvideUnsupported,
            get_secret_origin_driver,
        )
        from flow_sdk.builtin.secret_origin_field import SECRET_ORIGIN_ADAPTER  # noqa: PLC0415

        if not (value or "").strip():
            return ApiFailResponse(message="value is required")
        want_typeid = (typeid or "").strip()
        want_env_var = (env_var or "").strip()
        entry = None
        for row in self.secret_origins:
            if (want_typeid and row.get("typeid") == want_typeid) or (
                want_env_var and row.get("env_var") == want_env_var
            ):
                entry = row
                break
        if entry is None:
            return ApiFailResponse(message="secret pointer not found on this project")
        try:
            loc = SECRET_ORIGIN_ADAPTER.validate_python(entry.get("locator") or {})
        except Exception as e:  # noqa: BLE001
            return ApiFailResponse(message=f"invalid locator: {e}")

        # Driver-dispatched, symmetric with resolve(): the driver owns which SOD
        # store it writes to. External-provider slots raise SecretProvideUnsupported.
        from flow_sdk.builtin.env_local_store import EnvLocalNotWritable  # noqa: PLC0415

        try:
            await get_secret_origin_driver(loc.kind).store(loc, value, project=self)
        except SecretProvideUnsupported as e:
            return ApiFailResponse(message=str(e))
        except EnvLocalNotWritable as e:
            # Hard block, not a warning: the destination file is committable, so
            # writing the value there would leak it on the next git share. The
            # code lets the UI render the specific fix.
            return ApiFailResponse(message=str(e), data={"block_code": e.code})
        except Exception as e:  # noqa: BLE001
            return ApiFailResponse(message=f"could not store value: {e}")
        from flow_sdk.builtin.secret_origin_digest import record_digest  # noqa: PLC0415

        # Baseline for the value-changed warning. Best-effort and value-free —
        # only a salted digest is kept, in the encrypted store.
        await asyncio.to_thread(record_digest, str(self.id), entry.get("env_var") or "", value)
        return ApiSuccessResponse(data={"ok": True, "env_var": entry.get("env_var")})

    @action.post(action_name="env-local-status")
    async def env_local_status(self) -> "ApiResponse":
        """What is in this project's ``.env.local``, and may we write to it?

        **Names only — no value ever crosses this boundary.** The detected-keys
        table renders straight from this, so the response physically cannot
        carry one.

        ``blocked`` is the hard block: ``.env.local`` sits in a git repo that
        does not exclude it, so a value written there would be committable.
        """
        from flow_sdk.builtin.env_local_store import (  # noqa: PLC0415
            env_local_block,
            env_local_path,
            gitignore_status,
            list_env_local,
        )

        path = env_local_path(self)
        gitignore = gitignore_status(self)
        block = env_local_block(self)
        declared = {row.get("env_var") for row in self.secret_origins if row.get("env_var")}
        keys = [
            {"key": row["key"], "line": row["line"], "declared": row["key"] in declared}
            for row in list_env_local(self)
        ]
        return ApiSuccessResponse(
            data={
                "path": str(path) if path is not None else None,
                "exists": bool(path is not None and path.exists()),
                "gitignore": gitignore,
                "blocked": block is not None,
                "block_code": block["code"] if block else None,
                "block_reason": block["reason"] if block else None,
                "keys": keys,
            }
        )

    # ── Context folders (Folder entities linked via context buckets) ────────

    async def _migrate_legacy_context_dirs(self) -> bool:
        """Convert stashed legacy ``include_dirs`` into Folder context links.

        Each stashed path is minted as a Folder entity (idempotent v5) and
        linked as PRIVATE context (legacy dirs were always hub-excluded).
        Clears the stash and neutralizes the stale ``include_dirs`` key in the
        record's metadata.json — ``save_metadata`` is a merge-writer, so
        without the explicit empty-list write the old key would resurrect
        removed dirs after a DB rebuild. Returns True when anything changed;
        the CALLER persists (this never calls ``self.save()``).
        """
        stash = [d for d in (self.legacy_include_dirs_ or []) if d]
        if not stash:
            return False
        from flow_sdk.builtin.folder import Folder

        covered: set[str] = set()
        for tid in self.context_of_type("folder", bucket="both"):
            entry = self.get_context_entry_data(tid) or {}
            if entry.get("path"):
                covered.add(entry["path"])
        for path in stash:
            canonical = canonical_posix_path(path)
            if canonical in covered:
                continue
            folder = await Folder.mint_for_path(canonical)
            kind = folder.origin.kind if folder.origin else "local"
            self.add_private_context_entities(folder.typeid, data={"path": canonical, "origin_kind": kind})
            covered.add(canonical)
        self.legacy_include_dirs_ = []
        # Drop the stale on-disk key (best-effort): save_metadata is a
        # merge-writer, so without removal the key would re-hydrate — and
        # resurrect removed dirs — on every adopt after a DB rebuild.
        try:
            import asyncio

            from flow_sdk.fs_store.fs_record import FSRecord

            record = await asyncio.to_thread(FSRecord.load_or_none, self.get_type(), self.id)
            if record is not None:
                await asyncio.to_thread(record.remove_metadata_keys, "include_dirs")
        except Exception:
            log.debug("[project] legacy include_dirs disk-key removal failed", exc_info=True)
        return True

    async def save(self, owner=None, notify: bool = True) -> "Project":
        """Project save — lazy-migration chokepoint for legacy context dirs.

        Any project write converges stashed legacy ``include_dirs`` into
        Folder context links first (no-op once clean), so old rows migrate on
        their first save without a dedicated migration run.

        On creation the (empty, instant) index is stamped so a brand-new project
        never reads as ``never_indexed`` — otherwise the UI shows a spurious
        "no index / Build Index" warning on a project with nothing to index yet.
        """
        if self.legacy_include_dirs_:
            await self._migrate_legacy_context_dirs()
        was_create = not self.exist_in_db
        await super().save(owner, notify=notify)
        if was_create:
            await self._stamp_index_sentinel()
            # Auto-index trigger "Project Create". Detached: a project create must
            # never wait on (or fail because of) a filesystem walk. The hook
            # itself no-ops unless the preference selects that trigger.
            from flow_sdk.fs_store.indexer.auto_index import maybe_auto_index

            asyncio.create_task(maybe_auto_index(str(self.id), created=True))
        # Every Project owns one deterministic DB-only Wiki. This idempotent
        # repair also converges Projects created before Wiki existed.
        from flow_sdk.wiki.service import ensure_default_wiki

        await ensure_default_wiki(self)
        return self

    async def _stamp_index_sentinel(self) -> None:
        """Stamp a brand-new project's ``.hash`` index sentinel so an empty
        project isn't reported as ``never_indexed``. No-op if a sentinel already
        exists (preserves a stale project's ``index_required`` state)."""
        try:
            record = await self.get_record()
            if record is not None and record.ensure_asset_ref().indexed_at is None:
                record.write_hash()
        except Exception:
            log.debug("[project] index-sentinel stamp on create failed", exc_info=True)

    @action.post(action_name="activate")
    async def activate(self) -> "ApiResponse":
        """Project activation — the one "the user is now in this project" signal.

        Overrides the generic all-types ``activate`` for projects only:
        ``ActionRegistry.get_by_name`` resolves ``project.activate`` before the
        bare ``activate``, and ``action.all`` builds that key from this class's
        ``type`` field default. The recency stamp is delegated to the generic
        handler verbatim, so the response contract (``{"last_active_at": …}``) is
        unchanged.

        The auto-index is a DETACHED task, never awaited. The caller is a
        fire-and-forget recency stamp from ``setContextEntityTypeId`` on the
        frontend, whose equality guard means this fires exactly once per real
        project switch. Detaching is what guarantees an index conflict (409) or a
        slow walk can never reach the activation response.
        """
        from flow_sdk.core.entity.entity_model import _http_activate
        from flow_sdk.fs_store.indexer.auto_index import maybe_auto_index

        resp = await _http_activate(self)
        if isinstance(resp, ApiSuccessResponse):
            asyncio.create_task(maybe_auto_index(str(self.id), created=False))
        return resp

    @action.post(action_name="add-context-dir")
    async def add_context_dir(self, path: str, scope: str = "private") -> "ApiResponse":
        """Attach a directory to this project as a context folder.

        Mints (or reuses) the ``Folder`` entity — detecting whether the dir is
        inside a git repo (→ transportable ``GitOrigin``) or plain (→
        ``LocalOrigin``) — and links it into the project's context bucket:
        ``private`` (default; never leaves this machine) or ``shared`` (travels
        when the project is shared). The canonical LOCAL path is stamped into
        the per-entry sidecar so the computed ``include_dirs`` derives
        synchronously. On a new add we kick a one-shot indexer scan.

        A ``LocalOrigin`` (non-git) folder cannot be reconstructed on a peer, so
        it is rejected from ``scope="shared"``.
        """
        if not path:
            return ApiFailResponse(message="path is required")
        if scope not in ("private", "shared"):
            return ApiFailResponse(message="scope must be 'private' or 'shared'")
        # No explicit legacy migration here: the computed include_dirs already
        # merges the stash (so is_new sees legacy dirs), and save() below is
        # the migration chokepoint.
        canonical = canonical_posix_path(path)
        from flow_sdk.builtin.folder import Folder

        # Detect the origin BEFORE minting so a rejected shared add leaves no
        # orphan Folder row. A non-transportable origin (local) can't be
        # reconstructed on a peer, so it can't be shared.
        origin = await Folder.detect_origin(canonical)
        if scope == "shared" and not origin.transportable:
            return ApiFailResponse(
                message="Only git-backed folders can be shared. Add this folder as private, "
                "or use a folder inside a git repository."
            )
        bucket = "shared" if scope == "shared" else "private"
        already_linked = any(
            (self.get_context_entry_data(tid) or {}).get("path") == canonical
            for tid in self.context_of_type("folder", bucket=bucket)
        )
        is_new = canonical not in self.include_dirs
        if not already_linked:
            folder = await Folder.mint_for_origin(origin, local_path=canonical)
            entry_data = {"path": canonical, "origin_kind": origin.kind}
            if scope == "shared":
                self.add_shared_context_entities(folder.typeid, data=entry_data)
            else:
                self.add_private_context_entities(folder.typeid, data=entry_data)
            await self.save()
        if is_new:
            from flow_sdk.builtin.agentic_process.agentic_process import (
                _index_additional_dir,
            )

            await _index_additional_dir(canonical)
        return ApiSuccessResponse(data=self.model_dump(mode="json"))

    @action.post(action_name="folder-for-path")
    async def folder_for_path(self, path: str) -> "ApiResponse":
        """Get-or-create the ``Folder`` entity for a directory, without linking it.

        The share gate needs an entity to preflight, but only CONTEXT folders are
        linked — a directory the user is merely browsing inside the project's own
        tree has no ``Folder`` yet. Minting is idempotent (a Folder's id IS its
        origin key), so this is a safe get-or-create: it never attaches a context
        folder, never indexes, and returns the same id for the same directory
        forever. Deliberately NOT ``add-context-dir``: clicking Share must not
        silently restructure the project.
        """
        if not path:
            return ApiFailResponse(message="path is required")
        from pathlib import Path

        from flow_sdk.builtin.folder import Folder

        canonical = canonical_posix_path(path)
        if not Path(canonical).is_dir():
            return ApiFailResponse(message=f"not a directory: {canonical}", status_code=404)
        folder = await Folder.mint_for_path(canonical)
        return ApiSuccessResponse(
            data={
                "typeid": str(folder.typeid),
                "path": canonical,
                "origin_kind": folder.origin.kind if folder.origin else None,
            }
        )

    @action.post(action_name="resolve-context-folders")
    async def resolve_context_folders(self) -> "ApiResponse":
        """Resolve shared context folders whose receiver-local sidecar is empty."""
        from flow_sdk.builtin.folder import Folder

        results: list[dict[str, Any]] = []
        changed = False
        for tid in self.context_of_type("folder", bucket="shared"):
            entry = self.get_context_entry_data(tid) or {}
            if entry.get("path"):
                results.append({"typeid": str(tid), "kind": "already_ready", "path": entry.get("path")})
                continue
            folder = await Folder.get_by_id(tid.id)
            if folder is None:
                results.append({"typeid": str(tid), "kind": "error", "message": "Folder entity not found"})
                continue
            if folder.origin is None:
                results.append({"typeid": str(tid), "kind": "error", "message": "Folder has no origin"})
                continue
            if not folder.origin.transportable:
                results.append({"typeid": str(tid), "kind": "error", "message": "Folder origin is not transportable"})
                continue
            resp = await folder.resolve_location()
            data = getattr(resp, "data", None) or {}
            if not isinstance(data, dict):
                data = {"kind": "error", "message": "Unexpected resolve response"}
            result = {"typeid": str(tid), **data}
            resolved = data.get("path") if data.get("kind") == "ready" else None
            if isinstance(resolved, str) and resolved:
                canonical = canonical_posix_path(resolved)
                self.add_shared_context_entities(
                    folder.typeid,
                    data={"path": canonical, "origin_kind": folder.origin.kind},
                )
                result["path"] = canonical
                changed = True
            results.append(result)
        if changed:
            await self.save()
        payload = self.model_dump(mode="json")
        payload["context_folder_results"] = results
        return ApiSuccessResponse(data=payload)

    @action.post(action_name="remove-context-dir")
    async def remove_context_dir(self, path: str) -> "ApiResponse":
        """Detach a context folder from this project. No-op if not attached.

        Matches on the canonical path against the folder links' sidecar
        entries and unlinks from BOTH buckets. The Folder entity itself is
        never deleted (it may be linked by other projects) and the directory
        on disk is never touched.
        """
        if not path:
            return ApiFailResponse(message="path is required")
        migrated = await self._migrate_legacy_context_dirs()
        canonical = canonical_posix_path(path)
        to_remove = [
            tid
            for tid in self.context_of_type("folder", bucket="both")
            if (self.get_context_entry_data(tid) or {}).get("path") == canonical
        ]
        if to_remove:
            self.remove_shared_context_entities(*to_remove)
            self.remove_private_context_entities(*to_remove)
        if to_remove or migrated:
            await self.save()
        return ApiSuccessResponse(data=self.model_dump(mode="json"))

    @action.post(action_name="setup-for-desktop")
    async def setup_for_desktop(self):
        """Connect project to desktop entities (workspace, agent, compute node).

        This action links the project to the @local workspace, @local agent, and @local compute node
        that were created during desktop bootstrap. Should be called after creating/opening a project
        in desktop mode.

        Returns:
            ApiSuccessResponse with workspace, agent, and compute_node entities
        """
        from flow_sdk.builtin.workspace import Workspace

        # Get the @local workspace
        local_workspace = await Workspace.get_by_uname("local")
        if local_workspace:
            # Add project as child of workspace
            await local_workspace.attach_child(self.typeid)
            logging.info(f"Connected project {self.id} to @local workspace {local_workspace.id}")

        # Get (self-healing) the @local compute node. It is a shared singleton
        # resolved via ComputeNode.get_local(), NOT a project-owned resource —
        # so we deliberately do NOT attach_child it to the project. Making it a
        # child created an `is_child` edge that deleteWithChildren's cascading
        # delete would follow, destroying the global @local compute node and
        # breaking every PTY/agentic session on the instance. Per-project cloud
        # compute nodes (cloud mode) are a different path and remain legitimate
        # project children.
        local_compute_node = await ComputeNode.get_local()

        return ApiSuccessResponse(
            data={
                "workspace": local_workspace.model_dump() if local_workspace else None,
                "agent": None,
                "compute_node": local_compute_node.model_dump() if local_compute_node else None,
            }
        )

    # ── Collaboration helpers (merged from CollaborationSpace) ──────────────

    async def _upsert_member(self, member_id: str, name: str) -> dict:
        now = _now_iso()
        presence = list(self.presence or [])
        for m in presence:
            if m.get("member_id") == member_id:
                m["name"] = name
                m["last_seen_at"] = now
                if not m.get("joined_at"):
                    m["joined_at"] = now
                self.presence = presence
                await self.save()
                return m
        entry = {
            "member_id": member_id,
            "name": name,
            "joined_at": now,
            "last_seen_at": now,
        }
        presence.append(entry)
        self.presence = presence
        await self.save()
        return entry

    async def _touch_member(self, member_id: str) -> bool:
        presence = list(self.presence or [])
        now = _now_iso()
        for m in presence:
            if m.get("member_id") == member_id:
                m["last_seen_at"] = now
                self.presence = presence
                await self.save()
                return True
        return False

    @classmethod
    async def get_by_session_code(cls, code: str) -> "Project | None":
        """Find a Project whose session_code matches (case-insensitive)."""
        normalized = (code or "").upper().strip()
        if not normalized:
            return None
        all_projects = await cls.get_all()
        for proj in all_projects:
            if (proj.session_code or "").upper() == normalized:
                return proj
        return None

    @action.post(action_name="ensure-collaboration-code")
    async def _http_ensure_collaboration_code(self) -> ApiResponse:
        """Ensure this project has a session_code + host. Idempotent."""
        request_info = get_current_request_info()
        body: dict[str, Any] = await request_info.get_post_data() if request_info else {}
        host_name = body.get("host_name")
        host_member_id = body.get("host_member_id")
        changed = False
        if not self.session_code:
            self.session_code = _generate_session_code()
            changed = True
        if host_member_id and not self.host_member_id:
            self.host_member_id = host_member_id
            changed = True
        if changed:
            await self.save()
        # Seed the host as the first member on first call.
        if host_name and host_member_id:
            existing = next(
                (m for m in (self.presence or []) if m.get("member_id") == host_member_id),
                None,
            )
            if existing is None:
                await self._upsert_member(host_member_id, host_name)
        return ApiSuccessResponse(data=self.model_dump(mode="json"))

    @action.post(action_name="join-collaboration")
    async def _http_join_collaboration(self) -> ApiResponse:
        """POST body: {member_id, name} → add the caller to project.presence."""
        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}
        member_id = body.get("member_id")
        name = body.get("name")
        if not member_id or not name:
            return ApiFailResponse(message="member_id and name are required")
        await self._upsert_member(member_id=member_id, name=name)
        return ApiSuccessResponse(data=self.model_dump(mode="json"))

    @action.post(action_name="heartbeat-collaboration")
    async def _http_heartbeat_collaboration(self) -> ApiResponse:
        """POST body: {member_id} → bump last_seen_at for that member."""
        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}
        member_id = body.get("member_id")
        if not member_id:
            return ApiFailResponse(message="member_id is required")
        updated = await self._touch_member(member_id)
        return ApiSuccessResponse(data={"ok": updated, "presence": self.presence})

    async def _delete_with_children(self) -> dict:
        """Permanently delete this project and everything that belongs to it.

        Irreversible. Removes, for the project and for every indexed record
        whose ``project_id`` is this project:
          * the DB row + FTS entry + wiki edges (via ``FSRecord.destroy``),
          * the on-disk record shadow under ``records/<type>/<type>-@<id>/``,
          * the ``records_data`` bundle (both the canonical ``<type>-@<id>``
            and the legacy ``<id>``-only shape used by index types),
        and finally the project's own source folder on disk when its dynamic
        ``protected_path`` policy permits that destructive operation
        (``fs_storage_mount_path`` — the user's real files).

        Cross-type enumeration walks the shadow store on disk: ``Entity.get_all``
        is type-locked, but each ``metadata.json`` carries its ``project_id``,
        so a single sweep of ``records_root`` finds children of every type.
        """
        import json  # noqa: PLC0415
        import logging  # noqa: PLC0415
        import shutil  # noqa: PLC0415

        from flow_sdk.fs_store import (  # noqa: PLC0415
            FSRecord,
            get_default_records_data_root,
            get_default_records_root,
        )

        log = logging.getLogger(__name__)
        pid = str(self.id)
        records_root = get_default_records_root()
        data_root = get_default_records_data_root()

        def _purge_data(rtype: str, rid: str) -> None:
            # records_data has two on-disk shapes: the current bare <id>/ and the
            # legacy uname-sigil <type>-@<id>/ (pre-rename installs).
            for sub in (str(rid), f"{rtype}-@{rid}"):
                p = data_root / rtype / sub
                try:
                    shutil.rmtree(p)  # idempotent — FileNotFoundError when absent
                except FileNotFoundError:
                    pass
                except OSError as exc:
                    log.warning("[project-delete] records_data rmtree failed %s: %s", p, exc)

        async def _destroy(meta: dict) -> None:
            rtype, rid = meta["type"], meta["id"]
            # Build the record from the metadata we already read — no second
            # read of metadata.json. destroy() = DB row + FTS + wiki + shadow.
            try:
                await FSRecord.from_dict(meta).destroy()
            except Exception as exc:  # noqa: BLE001
                log.warning("[project-delete] destroy %s:%s failed: %s", rtype, rid, exc)
            _purge_data(rtype, rid)

        # 1. Collect every child record's metadata by scanning the shadow store.
        #    Materialize the full list first — destroy() rmtree's folders, so we
        #    must not mutate the directory tree while iterating it.
        targets: list[dict] = []
        if records_root.exists():
            for type_dir in sorted(records_root.iterdir()):
                if not type_dir.is_dir():
                    continue
                for rec_dir in type_dir.iterdir():
                    meta_path = rec_dir / "metadata.json"
                    if not meta_path.exists():
                        continue
                    try:
                        data = json.loads(meta_path.read_text(encoding="utf-8"))
                    except (OSError, ValueError):
                        continue
                    if data.get("project_id") != pid:
                        continue
                    if not data.get("type") or not data.get("id") or data.get("id") == pid:
                        continue  # skip malformed + the project's own record
                    targets.append(data)

        # 2. Destroy each child record.
        for meta in targets:
            await _destroy(meta)

        # 3. Delete the project's own source folder on disk (the user's files),
        #    unless the dynamic path policy marks it as protected.
        mount = self.fs_storage_mount_path
        if mount and not self.protected_path:
            try:
                shutil.rmtree(mount)  # idempotent — FileNotFoundError when absent
            except FileNotFoundError:
                pass
            except OSError as exc:
                log.warning("[project-delete] source folder rmtree failed %s: %s", mount, exc)
        elif mount:
            log.warning("[project-delete] preserved protected source path %s", mount)

        # 4. Sever the shared @local compute node before deleting the project
        #    record. Destroying the project record cascades down `is_child` edges
        #    (sqlite delete walks get_children_sub_tree), and older projects were
        #    set up with the @local compute node mistakenly attached as a child
        #    (see setup_for_desktop). Detaching it here keeps the cascade from
        #    deleting the global compute node and breaking every PTY/agentic
        #    session. Idempotent: detach_child is a no-op when no edge exists.
        try:
            # Read-only resolve: do NOT mint a node just to detach it.
            local_compute_node = await ComputeNode.get_local(create=False)
            if local_compute_node:
                await self.detach_child(local_compute_node.typeid)
        except Exception as exc:  # noqa: BLE001
            log.warning("[project-delete] detach @local compute node failed: %s", exc)

        # 5. Delete the project's own record (DB row + FTS + wiki + shadow + data).
        await _destroy({"type": self.type, "id": pid})

        return {"project_id": pid, "deleted_children": len(targets)}

    @action.post(action_name="delete-with-children")
    async def _http_delete_with_children(self) -> ApiResponse:
        """Permanently delete this project and all of its children. Irreversible."""
        result = await self._delete_with_children()
        return ApiSuccessResponse(data=result)
