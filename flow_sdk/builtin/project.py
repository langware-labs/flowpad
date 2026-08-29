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
from flow_sdk.api.api_types.api_field import APIField, EntityField, Persist, Sharing
from flow_sdk.api.type_id import TypeId
from flow_sdk.builtin.asset_menu import BrowsingOptions
from flow_sdk.builtin.faas.compute_node import ComputeNode
from flow_sdk.builtin.fs_origin_field import FSOriginField
from flow_sdk.builtin.git_origin import GitOrigin, as_git
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
    is_path_under,
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


def _fresh_clone_slot(preferred_leaf: str) -> Path:
    """An unused workspace directory named after ``preferred_leaf``.

    Blocking (stats the workspace) — call via ``asyncio.to_thread``.

    Deliberately NOT ``GitOrigin.next_clone_target``: that one reuses an
    existing checkout when the origin matches, which is right when the repo IS
    the project's identity and wrong when it is a template being instantiated
    for the Nth time. This one always suffixes past a collision.
    """
    base = Path(AGENT_MOUNT_FOLDER)
    base.mkdir(parents=True, exist_ok=True)
    leaf = (
        "".join(c if c.isalnum() or c in ("-", "_", ".") else "-" for c in (preferred_leaf or "")).strip("-. ")
        or "project"
    )
    candidate = base / leaf
    n = 2
    # An EMPTY directory is not a collision — nothing there can be lost, and
    # ``git clone`` is happy to write into one. This matters because a Project
    # reserves ``<workspace>/<name>`` when it is constructed, so treating that
    # as taken would push every engagement to ``<name>-2`` and strand the
    # reserved directory as an empty stray (which the workspace scan then mints
    # a second, empty project for).
    while candidate.exists() and any(candidate.iterdir()):
        candidate = base / f"{leaf}-{n}"
        n += 1
    return candidate


def _detach_git_history(repo_root: Path) -> None:
    """Replace a template checkout's history with an empty one, in place.

    Blocking (rmtree + subprocess) — call via ``asyncio.to_thread``.

    Deliberately narrow about what it will delete. It removes exactly one path,
    ``<repo_root>/.git``, and only when that is a real directory INSIDE the
    directory we just cloned into: a template repo controls its own contents,
    and a ``.git`` symlink pointing at somebody else's repository is the one
    way this could be turned into a delete-arbitrary-directory primitive. A
    checkout with no ``.git`` (already detached, re-entered) is fine — this is
    idempotent by design, since setup may be retried.
    """
    import shutil  # noqa: PLC0415

    root = Path(repo_root).resolve()
    git_dir = root / ".git"
    if git_dir.is_symlink():
        raise RuntimeError(f"refusing to detach: {git_dir} is a symlink")
    if git_dir.is_dir():
        # Confirm it really is under the root we resolved, not reached via one.
        if git_dir.resolve().parent != root:
            raise RuntimeError(f"refusing to detach: {git_dir} resolves outside {root}")
        shutil.rmtree(git_dir)
    # A fresh empty repo so the customer's first commit is theirs. No commit is
    # made — that needs a configured identity, and failing setup on a missing
    # ``user.email`` would be absurd.
    import subprocess  # noqa: PLC0415

    subprocess.run(["git", "init", "-q"], cwd=root, capture_output=True, timeout=30, check=False)


class ProjectInitializeOptions(ComputeSourceControlInitializeOptions):
    model_config = ConfigDict(alias_generator=to_camel, validate_by_name=True)

    mcp_connector_init: bool = Field(default=True)


class HelpdeskMode(StrEnum):
    """Who answers helpdesk (support) conversations on this project.

    Only ``HUMAN`` is wired in v1: staff pick tickets up from a shared pool and
    reply under the masked ``display_name``. ``AI`` / ``HYBRID`` are reserved
    for an automated responder and are intentionally not yet implemented.
    """

    HUMAN = "human"
    AI = "ai"
    HYBRID = "hybrid"


class HelpdeskConfig(BaseModel):
    """Per-project helpdesk (support center) configuration.

    When ``enabled``, the project accepts guest-opened helpdesk conversations
    (support tickets). All staff replies in those conversations are displayed
    under the single ``display_name`` identity regardless of which member
    actually replied — the responder's real ``sender_id`` is preserved on the
    wire, only the displayed ``sender_name`` is masked to ``display_name``.

    ``portal_git_url`` is the desk's PORTAL repository — the help content a
    requester clones and browses locally. Independent of the ticket queue: a
    desk may have a queue and no portal, and the two are configured separately.
    """

    enabled: bool = False
    display_name: Optional[str] = None
    avatar_url: Optional[str] = None
    welcome_message: Optional[str] = None
    mode: HelpdeskMode = HelpdeskMode.HUMAN
    portal_git_url: Optional[str] = None


class Project(Entity):
    type: str = APIField(default=BuiltinEntityType.PROJECT.value)
    name: str | None = APIField(default=None, description="Display name of the project")
    artifacts: List[str] = APIField(
        default_factory=list,
        description="List of artifact IDs belonging to this project",
    )
    # Help-desk (support center) config. None on ordinary projects. Persisted
    # (persist=TRUE) so it round-trips FS<->DB and is readable on the hub at
    # message-write time to mask responder identity. See ``HelpdeskConfig``.
    helpdesk: Optional[HelpdeskConfig] = APIField(
        default=None,
        persist=Persist.TRUE,
        description="Help-desk configuration; set on a project that answers support tickets.",
    )
    last_mode: str | None = APIField(
        default=None,
        description="Last UI view mode used in this project (vibe|standard|advanced|dev). "
        "Applied on project load so the mode is remembered per project.",
    )
    # TRAVELS to the hub (unlike `last_mode` next to it, which is per-device UI
    # state). The language a project is worked in is a property of the WORK, not
    # of the machine reading it: a recipient of a shared project — including the
    # box behind a sandbox handover — opens it in the language its author chose.
    locale: str | None = APIField(
        default=None,
        description="UI language for this project, as a supported locale code (see "
        "flow_sdk.i18n.supported_locales — en-US|he|ar). Applied on project load so "
        "the app switches language when you enter a project that reads differently. "
        "Shared: travels with the project so a recipient opens it in the same language.",
    )
    fs_storage_provider: StorageProvider | None = EntityField(default=StorageProvider.SANDBOX, sharing=Sharing.PRIVATE)
    fs_storage_mount_path: str | None = APIField(
        default=None, description="Full path to the project folder", sharing=Sharing.PRIVATE
    )
    # Portable repository identity for a project shared through the hub. This
    # is never the sender's local worktree path; the recipient uses it to
    # clone/materialize its own checkout.
    origin: Optional[FSOriginField] = APIField(
        sharing=Sharing.PRIVATE,
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
    hub_published_at: str | None = APIField(
        default=None,
        description=(
            "When THIS instance published the project to the hub. Distinct from "
            "``remote``, which is also set when a project is shared TO us — so "
            "``remote`` cannot answer 'may I write to the hub row?' and this can."
        ),
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
        return bool(self.fs_storage_mount_path and is_protected_path(self.fs_storage_mount_path))

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
    def context_roots(self) -> list[str]:
        """API mirror of :meth:`direct_context_roots` — see it for the rule.

        Serialized because the boundary has frontend consumers now (the home
        agent tiles ask "which directories count as this project's?"), and a
        client re-deriving mount + ``include_dirs`` would be a fourth copy of
        the rule that canonicalizes differently from the three server-side ones.
        """
        return self.direct_context_roots()

    def direct_context_roots(self) -> list[str]:
        """Canonical Project root followed by its direct context roots.

        This is the shared scope boundary for project-owned features such as
        Journey auto-launch and adopted Helpdesk resolution. Ordering is
        meaningful: the Project itself wins, then context links in declaration
        order. Duplicate paths are removed without sorting.
        """
        roots: list[str] = []
        for path in (self.fs_storage_mount_path, *self.include_dirs):
            if not path:
                continue
            try:
                canonical = canonical_posix_path(path)
            except OSError:
                continue
            if canonical not in roots:
                roots.append(canonical)
        return roots

    @computed_field
    @property
    def customization(self) -> dict[str, Any]:
        """Optional per-project branding, read from ``.flow/customization/``.

        A project (e.g. a launched template, or a cloned helpdesk portal) can
        ship a ``.flow/customization/`` folder to brand surfaces that render it:
        * ``string.json`` → ``{"home_title": "..."}`` overrides the greeting.
        * ``home.png`` present → the home renders it as a background.
        * ``string.json`` → ``{"brand": {...}}`` names the project's identity —
          see ``_read_brand``. Used by the helpdesk portal, ignored elsewhere.

        Strictly sync + best-effort (missing mount / dir / file / bad JSON →
        defaults), like ``include_dirs`` — it serializes into the Project
        payload the UI already receives, so no route or bootstrap change.
        Image BYTES are served on demand via the generic ``fs`` download action;
        here we surface only a flag (home background) or a repo-relative path
        (brand logos) so the UI knows what to ask for.
        """
        import json  # noqa: PLC0415
        from pathlib import Path  # noqa: PLC0415

        default = {"home_title": None, "has_home_background": False, "brand": None}
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
        brand: dict[str, Any] | None = None
        try:
            string_path = cust_dir / "string.json"
            if string_path.is_file():
                data = json.loads(string_path.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    raw = data.get("home_title")
                    if isinstance(raw, str) and raw.strip():
                        home_title = raw.strip()
                    brand = self._read_brand(data.get("brand"), Path(root))
        except (OSError, ValueError):
            pass
        try:
            has_bg = (cust_dir / "home.png").is_file()
        except OSError:
            has_bg = False
        return {"home_title": home_title, "has_home_background": has_bg, "brand": brand}

    @staticmethod
    def _read_brand(raw: Any, root: "Path") -> dict[str, Any] | None:
        """Validate a ``brand`` block from ``string.json``, or ``None``.

        Shape (every key optional)::

            {"name", "tagline", "accent", "logo", "logo_dark"}

        ``logo`` / ``logo_dark`` are REPO-RELATIVE paths (e.g. ``brand/mark.svg``)
        and are surfaced only when the file actually exists, so a consumer can
        hand the path straight to the ``fs`` download action without a probe.
        Unlike ``home.png`` this accepts any extension — the desk names the file,
        which is what lets a portal ship an SVG.

        Paths that escape the project root are dropped: this data comes from a
        cloned third-party repo, and the download action would happily serve
        ``../../.ssh/id_rsa``. Returns ``None`` when nothing usable survives, so
        "has a brand" is a single truthiness check at every call site.
        """
        if not isinstance(raw, dict):
            return None

        def _text(key: str) -> str | None:
            value = raw.get(key)
            return value.strip() if isinstance(value, str) and value.strip() else None

        # Resolved once, not per key: both logo lookups compare against it.
        try:
            root_resolved = root.resolve()
        except OSError:
            return None

        def _asset(key: str) -> str | None:
            rel = _text(key)
            if not rel:
                return None
            candidate = (root / rel).resolve()
            try:
                # `is_relative_to` is the containment check; `resolve()` above
                # collapses any `..` first so a traversal cannot slip past it.
                if not candidate.is_relative_to(root_resolved) or not candidate.is_file():
                    return None
            except OSError:
                return None
            return rel.lstrip("/")

        brand = {
            "name": _text("name"),
            "tagline": _text("tagline"),
            "accent": _text("accent"),
            "logo": _asset("logo"),
            "logo_dark": _asset("logo_dark"),
        }
        return brand if any(brand.values()) else None

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
                        "description": entry.get("description") or "",
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
                self.fs_storage_mount_path = os.path.normpath(os.path.join(os_root, relative_name))
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
    def _row_id_policy(cls, data: dict) -> str:
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
            if mp and is_valid_project_cwd(mp, include_temp=True) and canonical_posix_path(mp) == canonical:
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
            # `fs_storage_mount_path` / `fs_storage_provider` are withheld by
            # their declarations now.
            "last_mode",
            "session_code",
            "host_member_id",
            "presence",
            "include_dirs",
            "context_roots",
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
            description = entry.get("description") or ""
            if not locator or not name or not env_var:
                secret = await SecretOrigin.get_by_id(tid.id)
                if secret is None:
                    continue
                locator = secret.locator.model_dump(mode="json")
                name = secret.name or ""
                env_var = secret.env_var
                sod_store = secret.effective_sod_store()
                description = description or secret.description or ""
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
                # Travels: a receiver needs to know what the value they are being
                # asked to provide is actually for.
                "description": description,
            }
        return payload

    async def ensure_on_hub(self) -> bool:
        """Publish this Project once and persist the local publication marker.

        Deploying a Project or one of its repository-backed assets is a single
        user operation. Callers must not have to manually publish the Project
        first merely to satisfy the asset publisher's parent-before-child
        ordering requirement.
        """
        if self.remote:
            return False
        await self.share()
        self.remote = True
        await self.save()
        return True

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
        ``POST /graph/project/<id>/members``. Under the Hub's assignment policy,
        the recipient is granted immediately and receives the full Project over
        the live bridge; explicit invitation acceptance remains the fallback
        when Hub auto-accept is disabled.
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
                self.origin = origin
                body["git_origin"] = origin.model_dump(mode="json", exclude={"project_id", "id"})
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
            # Publication marker. Receiver materialization also sets ``remote``,
            # so only this line distinguishes "I published it" from "it was
            # shared to me" — which is what the push-to-cloud gate needs.
            self.hub_published_at = _now_iso()
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
        origin = as_git(self.origin)
        if origin is None:
            raise RuntimeError("Shared project has no Git origin")

        from flow_sdk.app.actions.oauth_action import _get_github_token_for_current_user  # noqa: PLC0415
        from flow_sdk.builtin.agentic_process.agentic_process import _index_additional_dir  # noqa: PLC0415

        existing = await asyncio.to_thread(find_local_repo_for_url, origin.clone_url())
        if existing and origin.matches_checkout(existing, require_branch=bool(origin.branch)):
            target_dir = existing
        else:
            target_dir = str(await asyncio.to_thread(origin.next_clone_target))
            token = await _get_github_token_for_current_user()
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

    @action.post(action_name="setup-from-bootstrap-git")
    async def setup_from_bootstrap_git(self, url: str, branch: str = "") -> ApiResponse:
        """Seed this project from a TEMPLATE repo — files, not history.

        The sibling of ``setup_from_git``, and deliberately its opposite in the
        one way that matters. ``setup_from_git`` binds a project to a repo it
        keeps tracking; this SEVERS the link: the checkout's ``.git`` is removed
        and a fresh empty repo initialized in its place, so the customer's first
        commit is their own and the vendor's history is not theirs to carry.
        The template is a starting point, not an upstream.

        Which leaves the obvious question — how does a template improve after it
        is cloned? It doesn't. That is what ``.flowpad/bootstrap.json``'s
        ``helpdesks`` are for: they are attached as ordinary context folders,
        stay linked to the vendor's repo, and so keep updating in every
        engagement long after the template that named them went stale. Anything
        meant to keep improving belongs in a declared help desk, not in the
        template body.

        Not re-committed after init: an initial commit needs a git identity this
        machine may not have configured, and failing setup on that would be
        absurd. The customer gets their files staged for a first commit they
        author.
        """
        if not url or not url.strip():
            return ApiFailResponse(message="url is required")

        origin = GitOrigin.from_url(url.strip(), branch=branch.strip(), rel_path=".")
        if origin is None:
            return ApiFailResponse(message=f"Not a recognizable git URL: {url}")

        from flow_sdk.app.actions.oauth_action import (  # noqa: PLC0415
            _get_github_token_for_current_user,
        )
        from flow_sdk.builtin.agentic_process.agentic_process import (  # noqa: PLC0415
            _index_additional_dir,
        )
        from flow_sdk.builtin.bootstrap_manifest import read_bootstrap_manifest  # noqa: PLC0415

        # A fresh slot every time, named after the ENGAGEMENT rather than the
        # template. ``origin.next_clone_target`` is right for ``setup_from_git``
        # (the repo is the project's identity, and reusing a matching checkout
        # is correct) and wrong on both counts here: two engagements from one
        # template are two independent working copies, and a customer whose
        # folder is called ``cloudnsite-bootstrap`` has been handed the vendor's
        # name for their own work.
        target_dir = str(await asyncio.to_thread(_fresh_clone_slot, self.name or origin.name))
        token = await _get_github_token_for_current_user()
        ok, message = await git_clone(origin.clone_url(), target_dir, branch=origin.branch or None, token=token)
        if not ok:
            return ApiFailResponse(message=message, status_code=502)

        target = Path(target_dir)
        # Read the manifest BEFORE severing history — the file itself stays, it
        # is only the vendor's `.git` that goes.
        manifest = read_bootstrap_manifest(target)
        await asyncio.to_thread(_detach_git_history, target)

        self.fs_storage_mount_path = canonical_posix_path(target_dir)
        if not self.name:
            self.name = os.path.basename(target_dir.rstrip(os.sep))
        await self.save()
        await self.setup_for_desktop()
        await _index_additional_dir(target_dir)

        # One semantic owner for manifest convergence. A template that already
        # finished copying remains usable when a dependency is unreachable, so
        # this setup action maps reconciliation failure into its historical
        # per-dependency report instead of undoing the new Project.
        reconciled = await self.reconcile_bootstrap()
        reconcile_data = dict(getattr(reconciled, "data", None) or {})
        installed = list(reconcile_data.get("content_projects") or [])
        install_failed = list(reconcile_data.get("failed") or [])
        legacy_urls = set(manifest.helpdesks)
        attached = [record for record in installed if record.get("url") in legacy_urls]
        failed = [record for record in install_failed if record.get("url") in legacy_urls]
        content_projects = [record for record in installed if record.get("url") not in legacy_urls]
        content_projects_failed = [record for record in install_failed if record.get("url") not in legacy_urls]

        return ApiSuccessResponse(
            data={
                "project_id": self.id,
                "path": self.fs_storage_mount_path,
                "template_url": origin.clone_url(),
                "helpdesks": attached,
                "helpdesks_failed": failed,
                "content_projects": content_projects,
                "content_projects_failed": content_projects_failed,
                "autolaunch_journey": manifest.autolaunch_journey,
            }
        )

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
            # Union in the node's attached project secrets. get_env_vars_context
            # wins a name collision, mirroring the setdefault precedence the
            # worker path has always used.
            from flow_sdk.core.flow.models.execution.env_context import (  # noqa: PLC0415
                resolve_node_secret_env,
            )

            taken = {e.name for e in process_env_list}
            process_env_list = process_env_list + [
                e for e in await resolve_node_secret_env(self) if e.name not in taken
            ]
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
                "subagent",
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
                # defaults to the flat staging list (skill/subagent/markdown/spec);
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
        description: str | None = None,
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
            project_id=str(self.id),
            env_var=env_var,
            locator=loc,
            name=name,
            sod_store=sod_store,
            description=description,
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
        env_local_names, sodot_names = self._local_store_names()
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
            found_in = await self._where_is_secret_value(env_var, loc, driver, env_local_names, sodot_names)
            hint = driver.setup_hint(loc)
            rows.append(
                {
                    "typeid": entry.get("typeid"),
                    "name": entry.get("name"),
                    "env_var": env_var,
                    "kind": loc.kind,
                    "scope": entry.get("scope"),
                    "description": entry.get("description") or "",
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

    def _local_store_names(self) -> tuple[set[str], set[str]]:
        """``(env-local keys, sodot names)`` — both whole-store scans, done ONCE.

        Each is a full read (a file parse and a sodot decrypt), so doing them per
        secret turned one Secrets-card render into S file reads and S store
        walks. Names only: neither call reads a value.
        """
        from flow_sdk.builtin.env_local_store import list_env_local  # noqa: PLC0415

        try:
            env_local = {row["key"] for row in list_env_local(self)}
        except Exception:  # noqa: BLE001
            env_local = set()
        try:
            from flow_sdk.cli.auth.secrets import get_secrets  # noqa: PLC0415

            sodot = {entry.get("name") for entry in get_secrets()}
        except Exception:  # noqa: BLE001
            sodot = set()
        return env_local, sodot

    async def _where_is_secret_value(
        self, env_var: str, loc, driver, env_local: set[str], sodot: set[str]
    ) -> str | None:
        """Which store on THIS machine can satisfy this declaration, if any.

        Deliberately a UNION across both local stores and the declared provider,
        not just the provider the declaration names. The local stores exist for
        usage — a value sitting in .env.local under the right env var satisfies a
        `gcp` declaration on this machine just as well, and reporting it missing
        would be wrong.

        Every probe is existence-only. No value is fetched here; that contract is
        what lets the Secrets card call this on every render.
        """
        if env_var:
            if env_var in env_local:
                return "env-local"
            if env_var in sodot:
                return "sodot"
        try:
            if await driver.can_resolve(loc, project=self):
                return "provider"
        except Exception:  # noqa: BLE001
            pass
        return None

    @action.post(action_name="push-secret-to-cloud")
    async def push_secret_to_cloud(self, env_var: str = "", value: str = "") -> "ApiResponse":
        """Store a secret on the hub, which is the system of record.

        Reuses the hub's own ``env-var`` action — we are not building a second
        secret manager. The hub stores the value through the same path as every
        other hub secret.

        Gated on publication: there is no hub row to attach a secret to until
        the project exists there. The failure carries ``project_not_published``
        so the UI can offer to publish rather than parse prose.
        """
        from flow_sdk.builtin.secret_origin import is_valid_secret_origin_env_var  # noqa: PLC0415
        from flow_sdk.cloud_client.transport.hub_http import hub_post  # noqa: PLC0415
        from flow_sdk.core.entity.entity_env.env_types import EnvVarType  # noqa: PLC0415

        env_var = (env_var or "").strip()
        if not is_valid_secret_origin_env_var(env_var):
            return ApiFailResponse(message=f"invalid env_var: {env_var!r}")
        if not value:
            return ApiFailResponse(message="a value is required to push a secret to the cloud")
        if not self.hub_published_at:
            return ApiFailResponse(
                message="This project is not in the cloud yet.",
                data={"error": "project_not_published"},
            )

        response = await hub_post(
            BuiltinEntityType.PROJECT,
            {"name": env_var, "value": value, "var_type": EnvVarType.API_KEY.value},
            str(self.id),
            action="env-var",
        )
        if response is None:
            return ApiFailResponse(message="could not reach the hub")

        # Point the local declaration at the hub copy. The value stays there.
        await self.add_secret_pointer(
            name=env_var,
            env_var=env_var,
            scope="shared",
            locator={"kind": "flowpad-hub", "project_id": str(self.id), "name": env_var},
        )
        return ApiSuccessResponse(data={"ok": True, "env_var": env_var})

    @action.post(action_name="delete-secret-from-cloud")
    async def delete_secret_from_cloud(self, env_var: str = "") -> "ApiResponse":
        """Delete a secret from the hub — CLOUD ONLY.

        The local copy is deliberately untouched: not the SecretOrigin
        declaration, not the sodot entry, not ``.env.local``, not this project's
        own env_vars. "Delete from cloud" means exactly that and nothing more.

        Calls hub_delete directly rather than routing through _hub_reflect,
        which silently no-ops when ``remote`` is false — unacceptable for a
        destructive operation the user believes happened.
        """
        from flow_sdk.cloud_client.transport.hub_http import hub_delete  # noqa: PLC0415

        env_var = (env_var or "").strip()
        if not env_var:
            return ApiFailResponse(message="env_var is required")
        if not self.hub_published_at:
            return ApiFailResponse(
                message="This project is not in the cloud.",
                data={"error": "project_not_published"},
            )

        response = await hub_delete(BuiltinEntityType.PROJECT, str(self.id), action="env-var", sub_path=env_var)
        if response is None:
            return ApiFailResponse(message="could not reach the hub")
        return ApiSuccessResponse(data={"ok": True, "env_var": env_var})

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
            drifted = await asyncio.to_thread(check_drift, str(self.id), env_var, resolved.get_secret_value())
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
        # One probe, reused — gitignore_status costs three git subprocesses.
        gitignore = gitignore_status(self)
        block = env_local_block(gitignore)
        declared = {row.get("env_var") for row in self.secret_origins if row.get("env_var")}
        keys = [
            {"key": row["key"], "line": row["line"], "declared": row["key"] in declared} for row in list_env_local(self)
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
            from flow_sdk.fs_store.indexer.auto_index import schedule_auto_index

            schedule_auto_index(str(self.id), created=True)
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

    @action.post(action_name="deploy")
    async def deploy_action(self) -> "ApiResponse":
        """`POST /project/<id>/deploy` — run this project's app in a cloud box.

        The web half of deployment, and the same verb an Agent gets. A micro app
        is deployed by deploying the project that holds it: the project is what
        has a repository, and the sandbox materializes exactly that. It is also
        what a LOCAL web placement already parents to, so both tiers agree on
        what a web deployment hangs off.

        Sharing is implicit — a deploy names a project the hub has to already
        know, so the two are never separately orderable by a caller.

        Long by nature (E2B create + boot + health is tens of seconds); if that
        becomes a timeout in practice the fix is 202-and-poll on the node's
        ``ops/status``, which already exists, not a longer client timeout.
        """
        from flow_sdk.builtin.cloud_deploy import deploy_entity_to_cloud  # noqa: PLC0415
        from flow_sdk.request_context.methods import get_current_request_info  # noqa: PLC0415

        request_info = get_current_request_info()
        actor = request_info.someone_typeid if request_info else None
        if not actor:
            return ApiFailResponse(message="deploy requires an authenticated user", status_code=401)
        try:
            await self.ensure_on_hub()
            data = await deploy_entity_to_cloud(self)
        except Exception as exc:
            return ApiFailResponse(message=f"deploy failed: {exc}")
        return ApiSuccessResponse(data={"project_id": self.id, **data})

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
        from flow_sdk.fs_store.indexer.auto_index import schedule_auto_index

        resp = await _http_activate(self)
        if isinstance(resp, ApiSuccessResponse):
            schedule_auto_index(str(self.id), created=False)
        return resp

    @action.post(action_name="add-context-dir-from-git")
    async def add_context_dir_from_git(
        self,
        url: str,
        branch: str = "",
        scope: str = "private",
        *,
        preferred_root=None,
    ) -> "ApiResponse":
        """Clone a git repo and attach it to this project as a context folder.

        The deterministic form of what the ``git-context-folder`` wizard does in
        prose for its ``existing`` mode. It composes pieces that already exist
        rather than reimplementing them:

        * ``Folder.mint_for_origin`` keys the folder by ``origin.key()``, so the
          SAME repo attached to a second project reuses one Folder and one
          checkout — the second attach costs no download.
        * ``Folder.resolve_location`` owns clone/reuse/pull and the post-clone
          index, including the read-only guard that keeps the checkout pullable.
        * ``add_context_dir`` owns the link, so ``already_linked`` / ``is_new``
          and the legacy migration stay in exactly one place.

        ``rel_path="."`` is deliberate: the whole repo is the context folder, and
        a subfolder-scoped origin would never see a manifest at the repo root.

        **The branch is always pinned**, to the caller's when given and to the
        remote's default (``git ls-remote --symref … HEAD``) otherwise. An
        unpinned origin is not merely "freezes at whatever it first cloned" —
        it silently adopts a checkout it never made. ``matches_repo`` skips its
        branch check when the origin names no branch
        (``if require_branch and self.branch``), so ANY checkout of this URL
        anywhere on disk matches, on any branch, at any commit; and
        ``_resolve_git_checkout`` gates its pull on ``if origin.branch`` too, so
        nothing brings it up to date afterwards. The result is a vendor folder
        whose contents depend on what some unrelated flow happened to leave in
        the workspace. Resolving the default branch costs one ``ls-remote`` (no
        objects fetched) and makes both the match and the pull real.
        """
        if not url or not url.strip():
            return ApiFailResponse(message="url is required")
        if scope not in ("private", "shared"):
            return ApiFailResponse(message="scope must be 'private' or 'shared'")

        origin = GitOrigin.from_url(url.strip(), branch=branch.strip(), rel_path=".")
        if origin is None:
            return ApiFailResponse(message=f"Not a recognizable git URL: {url}")

        if not origin.branch:
            from flow_sdk.app.actions.oauth_action import (  # noqa: PLC0415
                _get_github_token_for_current_user,
            )
            from flow_sdk.utils.git import git_remote_access  # noqa: PLC0415

            token = await _get_github_token_for_current_user()
            reachable, default_branch = await git_remote_access(origin.clone_url(), token)
            if not reachable:
                return ApiFailResponse(
                    message=f"Cannot read {origin.clone_url()} — check the URL and your access",
                    status_code=502,
                )
            if default_branch:
                origin = origin.model_copy(update={"branch": default_branch})

        from flow_sdk.builtin.folder import Folder  # noqa: PLC0415

        folder = await Folder.mint_for_origin(origin)
        existing_branch = str(getattr(folder.origin, "branch", "") or "")
        requested_branch = str(origin.branch or "")
        if existing_branch != requested_branch:
            return ApiFailResponse(
                message=(
                    f"Repository is already materialized for branch {existing_branch or '(unpinned)'}; "
                    f"requested {requested_branch or '(unpinned)'}"
                ),
                status_code=409,
            )
        resolved = await folder.resolve_location(
            preferred_root=preferred_root,
            strict_index=True,
        )
        data = getattr(resolved, "data", None) or {}
        if data.get("kind") != "ready" or not folder.path:
            # Surface the driver's own message — it names the actual failure
            # (auth, unreachable host, unsafe rel_path) far better than we could.
            return ApiFailResponse(
                message=data.get("message") or "Could not materialize the repository",
                status_code=502,
            )

        requested_bucket = "shared" if scope == "shared" else "private"
        opposite_bucket = "private" if scope == "shared" else "shared"
        requested_ids = {str(tid) for tid in self.context_of_type("folder", bucket=requested_bucket)}
        opposite_ids = {str(tid) for tid in self.context_of_type("folder", bucket=opposite_bucket)}
        already_linked = str(folder.typeid) in requested_ids and str(folder.typeid) not in opposite_ids
        scope_changed = str(folder.typeid) in opposite_ids
        linked = await self.add_context_dir(folder.path, scope=scope)
        if not isinstance(linked, ApiSuccessResponse):
            return linked
        return ApiSuccessResponse(
            data={
                "folder_id": folder.id,
                "path": folder.path,
                "scope": scope,
                "cloned_url": origin.clone_url(),
                "already_linked": already_linked,
                "scope_changed": scope_changed,
            }
        )

    @action.post(action_name="reconcile-bootstrap")
    async def reconcile_bootstrap(self) -> "ApiResponse":
        """Converge this Project to the live dependencies in its manifest.

        The manifest is declarative; this action is deliberately a thin
        composition over ``add_context_dir_from_git``. Folder materialization,
        Git authentication, shared-context validation, indexing, and link
        idempotency therefore keep their single existing owners.
        """
        if not self.fs_storage_mount_path:
            return ApiFailResponse(message="Project has no local working directory")

        from flow_sdk.builtin.bootstrap_manifest import (  # noqa: PLC0415
            BootstrapContentProject,
            read_bootstrap_manifest,
        )
        from flow_sdk.builtin.helpdesk import Helpdesk  # noqa: PLC0415
        from flow_sdk.builtin.journey import Journey  # noqa: PLC0415
        from flow_sdk.builtin.skill import Skill  # noqa: PLC0415

        manifest = read_bootstrap_manifest(Path(self.fs_storage_mount_path))
        dependencies = list(manifest.content_projects)
        # Legacy manifests remain useful and converge through the exact same
        # context-folder primitive. They are private because that was their
        # original contract.

        # Canonical Git identity ignores URL spelling and branch. Use it for a
        # mutation-free preflight so aliases cannot bypass conflict detection.
        declared: dict[str, tuple[str, str]] = {}
        content_keys: set[str] = set()
        canonical_dependencies: list[BootstrapContentProject] = []
        for dependency in dependencies:
            origin = GitOrigin.from_url(
                dependency.url,
                branch=dependency.branch,
                rel_path=".",
            )
            if origin is None:
                return ApiFailResponse(
                    message=f"Not a recognizable git URL: {dependency.url}",
                    status_code=400,
                )
            key = origin.key()
            previous = declared.get(key)
            requested = (str(origin.branch or ""), dependency.scope)
            if previous is not None and previous != requested:
                return ApiFailResponse(
                    message=(f"Content project {origin.clone_url()} has conflicting branches or scopes"),
                    status_code=409,
                )
            if previous is not None:
                # Different URL spellings of the same repository declaration
                # are one dependency, not two install result rows.
                continue
            declared[key] = requested
            content_keys.add(key)
            canonical_dependencies.append(dependency)

        dependencies = canonical_dependencies

        for url in manifest.helpdesks:
            origin = GitOrigin.from_url(url, branch="", rel_path=".")
            if origin is None:
                return ApiFailResponse(message=f"Not a recognizable git URL: {url}", status_code=400)
            # The richer content_projects declaration wins over its legacy
            # URL-only alias; never attach the same repository twice.
            if origin.key() in content_keys:
                continue
            dependencies.append(BootstrapContentProject(url=url, scope="private"))

        attached: list[tuple[BootstrapContentProject, dict, str]] = []
        failed: list[dict] = []
        for dependency in dependencies:
            response = await self.add_context_dir_from_git(
                dependency.url,
                branch=dependency.branch,
                scope=dependency.scope,
            )
            if not isinstance(response, ApiSuccessResponse):
                failed.append(
                    {
                        "url": dependency.url,
                        "branch": dependency.branch,
                        "scope": dependency.scope,
                        "error": getattr(response, "message", "attach failed"),
                    }
                )
                continue
            data = dict(response.data or {})
            root = canonical_posix_path(data.get("path") or "")
            attached.append((dependency, data, root))

        # One Project table read for every attached root. The old per-root
        # find/recover sequence scanned the same table repeatedly.
        projects_by_mount = await Project.index_by_mount()
        installed: list[dict] = []
        for dependency, data, root in attached:
            content_project = projects_by_mount.get(root) if root else None
            if content_project is None and root:
                content_project = await Project.recover_by_path(root)
                if content_project is not None:
                    projects_by_mount[root] = content_project
            installed.append(
                {
                    "url": dependency.url,
                    "branch": dependency.branch,
                    "content_project_id": content_project.id if content_project else None,
                    "folder_id": data.get("folder_id"),
                    "path": root,
                    "scope": dependency.scope,
                    "status": "already_installed" if data.get("already_linked") else "installed",
                }
            )

        install_status = (
            "installed" if any(record["status"] == "installed" for record in installed) else "already_installed"
        )
        roots = list(dict.fromkeys(record["path"] for record in installed if record["path"]))

        def result_data(failures: list[dict]) -> dict:
            return {
                "target_project_id": self.id,
                "content_projects": installed,
                "status": install_status,
                "failed": failures,
            }

        if failed:
            return ApiFailResponse(
                message="Could not install every declared content project",
                data=result_data(failed),
                status_code=502,
            )

        def assets_in_roots(entities: list[Any]) -> list[Any]:
            scoped: list[tuple[str, str, Any]] = []
            for entity in entities:
                if not entity.asset_ref:
                    continue
                asset_ref = canonical_posix_path(entity.asset_ref)
                if any(is_path_under(asset_ref, root) for root in roots):
                    scoped.append((asset_ref, str(entity.id), entity))
            return [entity for _asset_ref, _entity_id, entity in sorted(scoped)]

        all_journeys, all_skills, all_desks = await asyncio.gather(
            Journey.get_all({}),
            Skill.get_all({}),
            Helpdesk.get_all({}),
        )
        journeys = assets_in_roots(all_journeys)
        skills = assets_in_roots(all_skills)
        desks = assets_in_roots(all_desks)

        declared_journeys = [
            (root, preferred) for root in roots if (preferred := read_bootstrap_manifest(Path(root)).autolaunch_journey)
        ]
        journey_matches = {
            selector: next(
                (journey for journey in journeys if journey.matches_selector(selector)),
                None,
            )
            for _root, selector in declared_journeys
        }
        preferred_journey = next(
            (
                journey_matches[selector]
                for _root, selector in declared_journeys
                if journey_matches[selector] is not None
            ),
            None,
        )
        preferred_journey_id = preferred_journey.id if preferred_journey else None
        if preferred_journey_id is None:
            preferred_journey_id = next(
                (journey.id for journey in journeys if journey.enabled and journey.auto_launch_enabled()),
                None,
            )

        missing_journeys = [
            {
                "path": root,
                "error": f"Declared auto-launch Journey was not indexed: {selector}",
            }
            for root, selector in declared_journeys
            if journey_matches[selector] is None
        ]
        if missing_journeys:
            return ApiFailResponse(
                message="Installed content is missing its declared auto-launch Journey",
                data=result_data(missing_journeys),
                status_code=502,
            )

        return ApiSuccessResponse(
            data={
                **result_data([]),
                "helpdesk_id": desks[0].id if desks else None,
                "journey_ids": [journey.id for journey in journeys],
                "skill_ids": [skill.id for skill in skills],
                "auto_launch_journey_id": preferred_journey_id,
            }
        )

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
        opposite = "private" if scope == "shared" else "shared"
        folder = await Folder.mint_for_origin(origin, local_path=canonical)
        requested_ids = {str(tid) for tid in self.context_of_type("folder", bucket=bucket)}
        opposite_ids = {str(tid) for tid in self.context_of_type("folder", bucket=opposite)}
        already_linked = str(folder.typeid) in requested_ids
        linked_opposite = str(folder.typeid) in opposite_ids
        is_new = canonical not in self.include_dirs
        if not already_linked or linked_opposite:
            entry_data = {"path": canonical, "origin_kind": origin.kind}
            if linked_opposite:
                if opposite == "shared":
                    self.remove_shared_context_entities(folder.typeid)
                else:
                    self.remove_private_context_entities(folder.typeid)
            if scope == "shared":
                self.add_shared_context_entities(folder.typeid, data=entry_data)
            else:
                self.add_private_context_entities(folder.typeid, data=entry_data)
            await self.save()
        if is_new:
            from flow_sdk.builtin.agentic_process.agentic_process import (
                _index_additional_dir,
            )

            # A transportable origin means these bytes came from a repo we clone
            # but do not author. Indexing normally COMMITS the id it mints back
            # into the source (markdown gets a ``flowpad:capsule`` block
            # appended), which dirties every tracked file and makes the next
            # ``git pull`` abort on "local changes would be overwritten" —
            # silently, until someone tries to update the folder.
            # ``Folder.resolve_location`` makes the same call for the same
            # reason; both are needed, because a folder can be attached here
            # without ever going through resolve (an already-local checkout).
            await _index_additional_dir(canonical, read_only=origin.transportable)
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
        #    unless the dynamic path policy marks it as protected. That policy
        #    also covers SDK-shipped system projects, so deleting the Flowpad
        #    Assistant cannot rmtree the shipped docs/skills/agents out of the
        #    install. Portal checkouts live under the workspace and stay
        #    deletable.
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
