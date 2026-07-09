import logging
import os
import random
import string
import sys
from datetime import datetime, timezone
from typing import Any, List, Optional

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, computed_field, model_validator
from pydantic.alias_generators import to_camel

from flow_sdk._compat import StrEnum  # 3.10-safe StrEnum (project pins py3.10)
from flow_sdk.api.api_types.api_field import APIField, Persist
from flow_sdk.api.type_id import TypeId
from flow_sdk.builtin.faas.compute_node import ComputeNode
from flow_sdk.builtin.worker_sessions import get_worker_sessions
from flow_sdk.config import AGENT_MOUNT_FOLDER, PLATFORM_WIN32, StorageProvider
from flow_sdk.core import Entity, QueryFilter, action
from flow_sdk.core.flow.flow_source_control import ComputeSourceControlInitializeOptions
from flow_sdk.core.flow.mcp_server import MCPConnector, mcp_connector_pool
from flow_sdk.core.flow.models.execution.env_context import get_env_vars_context
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.fs_store.path_utils import canonical_posix_path
from flow_sdk.request_context.methods import (
    get_current_request_info,
)
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse


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
    fs_storage_provider: StorageProvider | None = StorageProvider.SANDBOX
    fs_storage_mount_path: str | None = APIField(
        default=None, description="Full path to the project folder"
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
    members: list[dict] = APIField(
        default_factory=list,
        description="Collaboration participants: [{member_id, name, joined_at, last_seen_at}]",
    )
    # ── Hub collaboration (Project as a shared unit — mirrors Conversation) ──
    # The project's own (uuid4) id IS the shared hub identity: on share the hub
    # row and the recipient's local mirror both live under it (no separate cloud
    # id). This works because project ids are opaque uuid4, not path-derived.
    # Hub-authoritative role roster: [{user_id, email, name, role}] with roles
    # owner/admin/member/reader. Distinct from the local presence ``members``
    # overlay (session-code join, no roles). Written by the reflected ``members``
    # action / ``_upsert_hub_project_metadata``; read by the Members UI.
    participants: list[dict] = APIField(
        default_factory=list,
        description="Hub role roster: [{user_id, email, name, role}]. Distinct from presence ``members``.",
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

    @model_validator(mode="after")
    def set_fs_storage_mount_path(self):
        """Set the storage mount path based on project name and create the folder if needed."""
        # A remote mirror (a project shared TO this instance) has no local
        # working directory — it lives under the sharer's cwd on their machine,
        # not ours. Never derive a mount path from its display name or mkdir a
        # folder for it; that would materialize a bogus directory named after the
        # project on every recipient. Only canonicalize an explicit path below.
        if self.remote and not self.fs_storage_mount_path:
            return self
        if self.name and not self.fs_storage_mount_path:
            if os.path.isabs(self.name):
                # Name is an absolute path - use it directly as mount path
                self.fs_storage_mount_path = self.name
                self.name = os.path.basename(self.name)
            elif "/" in self.name or "\\" in self.name:
                # Name is a VFS-relative path - convert to absolute OS path
                # VFS root maps to OS root ("/" on Unix, "C:\" on Windows)
                if sys.platform == PLATFORM_WIN32:
                    drive = os.path.splitdrive(AGENT_MOUNT_FOLDER)[0]
                    os_root = drive + os.sep
                else:
                    os_root = os.sep
                self.fs_storage_mount_path = os.path.normpath(
                    os.path.join(os_root, self.name)
                )
                self.name = os.path.basename(self.fs_storage_mount_path)
            else:
                # Simple name like "my_first_project"
                self.fs_storage_mount_path = os.path.join(AGENT_MOUNT_FOLDER, self.name)

        # Prevent project mount path from being the user's home directory.
        home_dir = os.path.expanduser("~").rstrip(os.sep)
        if (
            self.fs_storage_mount_path
            and self.fs_storage_mount_path.rstrip(os.sep) == home_dir
        ):
            self.fs_storage_mount_path = os.path.join(
                AGENT_MOUNT_FOLDER, self.name or "home"
            )

        # Create the project folder if it doesn't exist.
        if self.fs_storage_mount_path and not os.path.exists(
            self.fs_storage_mount_path
        ):
            try:
                os.makedirs(self.fs_storage_mount_path, exist_ok=True)
            except OSError as e:
                # Non-fatal and expected for discovered/external project roots
                # (e.g. decoded Claude project paths on read-only mounts). Debug,
                # not warning — otherwise enumerating many such projects floods
                # the log with hundreds of non-actionable lines.
                logging.debug(
                    f"Project: could not create mount path {self.fs_storage_mount_path!r}: {e}"
                )
        if self.fs_storage_mount_path:
            self.fs_storage_mount_path = canonical_posix_path(
                self.fs_storage_mount_path
            )
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
        import uuid

        from flow_sdk.fs_store.path_utils import canonical_posix_path
        return str(uuid.uuid5(uuid.NAMESPACE_DNS, f"project:{canonical_posix_path(path)}"))

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
        import uuid

        from flow_sdk.fs_store.identifier import is_valid_entity_id
        rid = data.get("id") or ""
        if rid and is_valid_entity_id(rid):
            return rid
        return str(uuid.uuid4())

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
        canonical = canonical_posix_path(cwd)
        existing = await cls.get_all()
        for proj in existing:
            mp = proj.fs_storage_mount_path
            if mp and canonical_posix_path(mp) == canonical:
                return proj
        return None

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

        canonical = canonical_posix_path(path)

        # Phase 1: existing project at this canonical cwd.
        existing = await cls.find_by_cwd(canonical)
        if existing is not None:
            return existing

        # Phase 2: construct a fresh Project with an opaque uuid4 id. Records
        # stamped with the path-derived alias still resolve via ``record_projects``
        # (``derive_id_for_path`` is injected server-side by resolve_project_scope),
        # so the entity id no longer needs to equal the alias.
        proj = cls.model_validate({
            "fs_storage_mount_path": canonical,
            "name": os.path.basename(canonical.rstrip(os.sep)) or canonical,
        })
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
        mount_path = (
            data.get("fs_storage_mount_path")
            or data.get("cwd")
            or data.get("real_path")
        )
        if not mount_path:
            name = data.get("name", "")
            if name and os.path.isabs(name):
                mount_path = name

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
        for record_only in ("claude_project", "codex_project", "encoded_path",
                            "last_indexed_at", "real_path", "cwd"):
            create_kwargs.pop(record_only, None)
        proj = cls(**create_kwargs)
        proj.id = cls.allocate_id(create_kwargs)
        await proj.save(notify=notify)
        return proj

    def _hub_body(self) -> dict:
        """Hub POST body for a shared project.

        The project's own (uuid4) id is the shared identity — the base body
        already emits ``id = self.id`` (same-id invariant), so no id swap. This
        override only (1) maps the local ``name`` to the hub's ``title`` field
        and (2) strips local-only project fields the hub doesn't host (the
        working-dir path, the presence overlay, indexer hints).
        """
        body = super()._hub_body()
        # Hub Project uses ``title``; local Project uses ``name``.
        if self.name:
            body["title"] = self.name
        for local_only in (
            "name",
            "fs_storage_mount_path",
            "fs_storage_provider",
            "session_code",
            "host_member_id",
            "members",
            "include_dirs",
            "session_count",
            "last_session_at",
        ):
            body.pop(local_only, None)
        return body

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

        await super().share()  # POSTs _hub_body() (id == self.id); flips remote=True
        if not recipients:
            return self

        creds = load_credentials()
        if not creds or not creds.api_key:
            raise RuntimeError("Cloud login required")

        async with FlowpadClient(ApiConfig.from_env(), api_key=creds.api_key) as client:
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
                logging.warning(
                    f"Multiple compute nodes found for project {self.typeid}"
                )
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
            logging.warning(
                f"No project or compute node found for process {process_typeid}"
            )
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
    async def initialize(
        self, initialize_options: ProjectInitializeOptions | None = None
    ):
        if not initialize_options:
            initialize_options = ProjectInitializeOptions()

        mcp_connector = await self.get_mcp_connector()
        if initialize_options.mcp_connector_init:
            process_env_list = await get_env_vars_context(
                get_current_request_info().user, self
            )
            async with mcp_connector.initialize(initialize_options, process_env_list):
                pass

        compute_node = await self.get_compute_node()
        return ApiSuccessResponse(
            data={"compute_node": compute_node.model_dump() if compute_node else None}
        )

    async def _get_process_by_source_impl(self, asset_ref: str):
        """Find an existing process entity associated with the given asset_ref."""
        from flow_sdk.builtin.process import Flow

        if not asset_ref:
            raise HTTPException(status_code=400, detail="asset_ref is required")

        process_filter = QueryFilter.by_type(Flow.get_type())
        child_processes = await self.get_children(child_filter=process_filter)

        for child in child_processes:
            process_entity = child.value
            if (
                isinstance(process_entity, Flow)
                and process_entity.asset_ref == asset_ref
            ):
                return ApiSuccessResponse(data=process_entity)

        return ApiSuccessResponse(data=None)

    @action.get(action_name="get-process-by-source")
    async def get_process_by_source(self, asset_ref: str):
        return await self._get_process_by_source_impl(asset_ref)

    @action.get(action_name="get-flow-by-source")
    async def get_flow_by_source(self, asset_ref: str):
        """Backward-compatible alias for get_process_by_source."""
        return await self._get_process_by_source_impl(asset_ref)

    @action.get(action_name="get-compute-node")
    async def get_compute_node_action(self):
        compute_node = await self.get_compute_node()
        return ApiSuccessResponse(
            data={"compute_node": compute_node.model_dump() if compute_node else None}
        )

    @action.get(action_name="get-worker-sessions")
    async def _get_worker_sessions_action(self):
        """Get worker sessions for current directory."""
        sessions = get_worker_sessions()
        return ApiSuccessResponse(data=sessions)

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
            self.add_private_context_entities(folder.typeid, data={"path": canonical})
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
        """
        if self.legacy_include_dirs_:
            await self._migrate_legacy_context_dirs()
        return await super().save(owner, notify=notify)

    @action.post(action_name="add-context-dir")
    async def add_context_dir(self, path: str, scope: str = "private") -> "ApiResponse":
        """Attach a directory to this project as a context folder.

        Mints (or reuses — deterministic v5 from the canonical path) the
        ``Folder`` entity and links it into the project's context bucket:
        ``private`` (default; never leaves this machine) or ``shared``
        (travels when the project is shared). The canonical path is stamped
        into the per-entry sidecar so the computed ``include_dirs`` derives
        synchronously. On a new add we kick a one-shot indexer scan over the
        path so skills/agents under it become discoverable.
        """
        if not path:
            return ApiFailResponse(message="path is required")
        if scope not in ("private", "shared"):
            return ApiFailResponse(message="scope must be 'private' or 'shared'")
        # No explicit legacy migration here: the computed include_dirs already
        # merges the stash (so is_new sees legacy dirs), and save() below is
        # the migration chokepoint.
        canonical = canonical_posix_path(path)
        is_new = canonical not in self.include_dirs
        from flow_sdk.builtin.folder import Folder

        folder = await Folder.mint_for_path(canonical)
        if scope == "shared":
            self.add_shared_context_entities(folder.typeid, data={"path": canonical})
        else:
            self.add_private_context_entities(folder.typeid, data={"path": canonical})
        await self.save()
        if is_new:
            from flow_sdk.builtin.agentic_process.agentic_process import (
                _index_additional_dir,
            )
            await _index_additional_dir(canonical)
        return ApiSuccessResponse(data=self.model_dump(mode="json"))

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
            logging.info(
                f"Connected project {self.id} to @local workspace {local_workspace.id}"
            )

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
                "compute_node": local_compute_node.model_dump()
                if local_compute_node
                else None,
            }
        )

    # ── Collaboration helpers (merged from CollaborationSpace) ──────────────

    async def _upsert_member(self, member_id: str, name: str) -> dict:
        now = _now_iso()
        members = list(self.members or [])
        for m in members:
            if m.get("member_id") == member_id:
                m["name"] = name
                m["last_seen_at"] = now
                if not m.get("joined_at"):
                    m["joined_at"] = now
                self.members = members
                await self.save()
                return m
        entry = {
            "member_id": member_id,
            "name": name,
            "joined_at": now,
            "last_seen_at": now,
        }
        members.append(entry)
        self.members = members
        await self.save()
        return entry

    async def _touch_member(self, member_id: str) -> bool:
        members = list(self.members or [])
        now = _now_iso()
        for m in members:
            if m.get("member_id") == member_id:
                m["last_seen_at"] = now
                self.members = members
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
                (m for m in (self.members or []) if m.get("member_id") == host_member_id),
                None,
            )
            if existing is None:
                await self._upsert_member(host_member_id, host_name)
        return ApiSuccessResponse(data=self.model_dump(mode="json"))

    @action.post(action_name="join-collaboration")
    async def _http_join_collaboration(self) -> ApiResponse:
        """POST body: {member_id, name} → add the caller to project.members."""
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
        return ApiSuccessResponse(data={"ok": updated, "members": self.members})

    async def _delete_with_children(self) -> dict:
        """Permanently delete this project and everything that belongs to it.

        Irreversible. Removes, for the project and for every indexed record
        whose ``project_id`` is this project:
          * the DB row + FTS entry + wiki edges (via ``FSRecord.destroy``),
          * the on-disk record shadow under ``records/<type>/<type>-@<id>/``,
          * the ``records_data`` bundle (both the canonical ``<type>-@<id>``
            and the legacy ``<id>``-only shape used by index types),
        and finally the project's own source folder on disk
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
            record_stem,
        )

        log = logging.getLogger(__name__)
        pid = str(self.id)
        records_root = get_default_records_root()
        data_root = get_default_records_data_root()

        def _purge_data(rtype: str, rid: str) -> None:
            # records_data has two on-disk shapes across types: the canonical
            # <type>/<type>-@<id>/ and the legacy <id>-only used by index types.
            for sub in (record_stem(rtype, rid), rid):
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

        # 3. Delete the project's own source folder on disk (the user's files).
        mount = self.fs_storage_mount_path
        if mount:
            try:
                shutil.rmtree(mount)  # idempotent — FileNotFoundError when absent
            except FileNotFoundError:
                pass
            except OSError as exc:
                log.warning("[project-delete] source folder rmtree failed %s: %s", mount, exc)

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
