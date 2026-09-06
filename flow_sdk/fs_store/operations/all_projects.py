"""Canonical project list: worker scans ∪ Project.get_all(), deduped
by canonical posix cwd. When ``create_missing=True``, materializes a Project for
any FS-discovered cwd not yet in the entity table and keeps the path-derived
record id as a compatibility alias for existing fs-record rows.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Iterator

from flow_sdk.config import agent_workspace_root, is_hidden_project
from flow_sdk.fs_store.indexer.functions._claude_projects import iter_claude_project_paths
from flow_sdk.fs_store.indexer.functions.codex_projects import (
    _read_codex_projects_from_config,
)
from flow_sdk.fs_store.path_utils import canonical_posix_path, is_valid_project_cwd
from flow_sdk.instance_settings import get_instance_settings

if TYPE_CHECKING:
    from flow_sdk.server.search_filters import ScopeFilter


@dataclass
class ProjectInfo:
    """Enriched project descriptor: identity + provenance + freshness."""

    cwd: str                                              # canonical posix path
    name: str                                             # display name (basename, or entity override)
    project_id: str                                       # Project entity id
    record_project_id: str = ""                           # legacy uuid5(project:<cwd>) id
    worker_types: list[str] = field(default_factory=list) # worker provenance keys
    is_new: bool = False                                  # entity was created by THIS call
    modified_at: str | None = None                        # entity updated_date, when known
    last_active_at: int | None = None                     # entity last_active_at (epoch-ms), when known
    system: bool = False                                  # SDK-shipped system project (any install)


# ── GET vs FETCH ──────────────────────────────────────────────────────────────
# `get_all_projects` is the FETCH path: a blocking filesystem scan of
# ~/.claude/projects (∪ codex/copilot/workspace) plus optional entity creation.
# It belongs on the footer project picker only.
#
# Read paths (scope resolution, list / count / search) only need KNOWN
# (entity-table) projects. They go through the cached reads below — NO filesystem
# scan, NO writes — so the UI's repeated scoped requests don't re-read all rows.
_PROJECTS_CACHE: list | None = None


def invalidate_projects_cache() -> None:
    """Drop the cached Project list. Called when a project is materialized; the
    scope resolver also force-refreshes on a token miss, so a freshly-created
    project self-heals even without an explicit invalidate."""
    global _PROJECTS_CACHE
    _PROJECTS_CACHE = None


async def get_cached_projects(*, force: bool = False):
    """Cached ``Project.get_all()`` for the scope-resolution hot path.

    Builds the Project-entity list once and serves it from memory thereafter, so
    the UI's repeated scoped requests don't re-read every row each time. The
    scope resolver passes ``force=True`` on a token miss to pick up a
    freshly-created project. NO filesystem scan (that is the FETCH path).
    """
    global _PROJECTS_CACHE
    if force or _PROJECTS_CACHE is None:
        from flow_sdk.builtin.project import Project  # local: avoid circular import
        _PROJECTS_CACHE = await Project.get_all()
    return _PROJECTS_CACHE


def _entity_to_project_info(proj, cwd: str) -> ProjectInfo:
    """Build a ``ProjectInfo`` from a Project entity row at canonical ``cwd``.
    ``worker_types`` is empty — that provenance comes from the FS scan."""
    from flow_sdk.builtin.project import Project  # local: avoid circular import
    return ProjectInfo(
        cwd=cwd,
        name=getattr(proj, "name", None) or cwd,
        project_id=proj.id,
        record_project_id=Project.derive_id_for_path(cwd) or "",
        worker_types=[],
        modified_at=getattr(proj, "updated_date", None),
        last_active_at=getattr(proj, "last_active_at", None),
        system=is_hidden_project(cwd, bool(getattr(proj, "system", False))),
    )


async def get_known_projects(*, include_temp: bool = False) -> list[ProjectInfo]:
    """Cheap read of KNOWN projects — entity table only, NO FS scan, NO writes.

    The GET counterpart to the FETCH ``get_all_projects``. Returns the same
    ``ProjectInfo`` shape sourced from the cached ``Project.get_all()`` read.
    Unordered: callers use it as a lookup source, not a display list.

    Projects that exist on disk but were never materialized into an entity are
    intentionally absent — scope resolution never references them (no entity id),
    and the footer picker, which DOES surface them, uses the FETCH path.
    """
    infos: list[ProjectInfo] = []
    for proj in await get_cached_projects():
        mount = getattr(proj, "fs_storage_mount_path", None)
        cwd = canonical_posix_path(mount) if mount else ""
        if not is_valid_project_cwd(cwd, include_temp=include_temp):
            continue
        infos.append(_entity_to_project_info(proj, cwd))
    return infos


def iter_codex_project_paths(include_temp: bool = False) -> Iterator[Path]:
    """Yield canonical Codex project paths from ``<home>/.codex/config.toml``.

    Skips temp paths and non-existent dirs to match ``iter_claude_project_paths``
    semantics. Reads only ``config.toml`` — the rollout-JSONL deep scan (see
    ``codex_projects_fn``) is deliberately skipped here; cold-call perf >> 100% recall.
    """
    config_path = get_instance_settings().codex_config_path
    seen: set[str] = set()
    for cwd_str in _read_codex_projects_from_config(
        config_path,
        include_temp=include_temp,
    ):
        if cwd_str in seen:
            continue
        seen.add(cwd_str)
        path = Path(cwd_str)
        try:
            if not path.is_dir():
                continue
        except OSError:
            continue
        yield path


def iter_workspace_project_paths(include_temp: bool = False) -> Iterator[Path]:
    """Yield every immediate, non-hidden subdirectory of the Flowpad workspace.

    Each top-level folder under ``<user_home>/Flowpad workspace`` whose name does
    not start with ``.`` is treated as a project, even with no worker
    worker history. Hidden folders (``.claude``, ``.flow``, ``.git`` …) are
    skipped. Same semantics as the Claude/Codex iterators: only existing dirs,
    temp paths excluded unless ``include_temp``.
    """
    workspace = agent_workspace_root()
    try:
        # list() forces eager evaluation: iterdir() is a lazy generator, so a
        # missing workspace dir would otherwise raise at the for-loop below,
        # outside this guard.
        children = list(workspace.iterdir())
    except OSError:
        return
    for child in children:
        if child.name.startswith("."):
            continue
        try:
            if not child.is_dir():
                continue
        except OSError:
            continue
        if not is_valid_project_cwd(child, include_temp=include_temp):
            continue
        yield child


def _read_copilot_workspace_cwd(path: Path) -> str | None:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped.startswith("cwd:"):
            continue
        value = stripped.split(":", 1)[1].strip()
        if (value.startswith('"') and value.endswith('"')) or (
            value.startswith("'") and value.endswith("'")
        ):
            value = value[1:-1]
        return value or None
    return None


def iter_copilot_project_paths(include_temp: bool = False) -> Iterator[Path]:
    """Yield canonical Copilot workspace cwds from ``~/.copilot/session-state``."""
    root = get_instance_settings().copilot_session_state_dir
    if not root.is_dir():
        return
    seen: set[str] = set()
    for workspace in root.glob("*/workspace.yaml"):
        cwd = _read_copilot_workspace_cwd(workspace)
        if not cwd or not is_valid_project_cwd(
            cwd,
            include_temp=include_temp,
        ):
            continue
        canonical = canonical_posix_path(cwd)
        if not canonical or canonical in seen:
            continue
        path = Path(canonical)
        try:
            if not path.is_dir():
                continue
        except OSError:
            continue
        seen.add(canonical)
        yield path


async def get_all_projects(
    *,
    include_temp: bool = False,
    create_missing: bool = True,
) -> list[ProjectInfo]:
    """Return every known project — FS scan + entity table, deduped by cwd,
    sorted by modified_at desc (None last).
    """
    from flow_sdk.builtin.project import Project  # local: avoid circular import

    fs_by_cwd: dict[str, ProjectInfo] = {}

    def _scan(paths: Iterator[Path], worker: str | None) -> None:
        for path in paths:
            canonical = canonical_posix_path(path)
            if not is_valid_project_cwd(
                canonical,
                include_temp=include_temp,
            ):
                continue
            info = fs_by_cwd.get(canonical)
            if info is None:
                info = ProjectInfo(
                    cwd=canonical,
                    name=Path(canonical).name or canonical,
                    project_id="",
                    record_project_id=Project.derive_id_for_path(canonical) or "",
                )
                fs_by_cwd[canonical] = info
            # Workspace folders (worker=None) register as projects without a
            # worker tag; they still flow through the same reconcile → mint →
            # materialize path below as Claude/Codex-discovered cwds.
            if worker and worker not in info.worker_types:
                info.worker_types.append(worker)

    def _scan_all() -> None:
        # Four filesystem walks (every historical worker cwd + the workspace).
        # Seconds on a busy machine; kept OFF the event loop so a project
        # picker cannot stall every other request behind it.
        _scan(iter_claude_project_paths(include_temp=include_temp), "claude")
        _scan(iter_codex_project_paths(include_temp=include_temp), "codex")
        _scan(iter_copilot_project_paths(include_temp=include_temp), "copilot")
        _scan(iter_workspace_project_paths(include_temp=include_temp), None)

    await asyncio.to_thread(_scan_all)

    existing = await Project.get_all()
    by_cwd: dict[str, "Project"] = {}
    for proj in existing:
        if proj.fs_storage_mount_path:
            canonical = canonical_posix_path(proj.fs_storage_mount_path)
            if is_valid_project_cwd(canonical, include_temp=include_temp):
                # FIRST match wins — the contract `Project.find_by_cwd` and
                # `Project.index_by_mount` both document and implement. This used
                # to overwrite, so when two rows shared a mount path (a duplicate
                # the find-then-create upsert let through) the picker attributed
                # the folder to the LAST row while every find_by_cwd caller got
                # the FIRST. One folder, two project ids, depending on who asked.
                by_cwd.setdefault(canonical, proj)

    to_create: list[ProjectInfo] = []
    for cwd, info in fs_by_cwd.items():
        if cwd in by_cwd:
            proj = by_cwd[cwd]
            info.project_id = proj.id
            info.record_project_id = Project.derive_id_for_path(cwd) or info.record_project_id
            info.modified_at = getattr(proj, "updated_date", None)
            info.last_active_at = getattr(proj, "last_active_at", None)
            info.system = is_hidden_project(cwd, bool(getattr(proj, "system", False)))
            # Prefer entity name when set (user may have renamed)
            if getattr(proj, "name", None):
                info.name = proj.name  # type: ignore[assignment]
        else:
            info.project_id = Project.derive_id_for_path(cwd) or ""
            info.record_project_id = info.project_id
            info.is_new = True
            info.system = is_hidden_project(cwd)
            to_create.append(info)

    # Sequential saves: SQLite serializes writes anyway and asyncio.gather hits
    # "database is locked" under contention from concurrent indexer scans.
    if create_missing and to_create:
        for info in to_create:
            try:
                await _materialize(info, include_temp=include_temp)
            except Exception as exc:  # noqa: BLE001
                import logging
                logging.warning("get_all_projects: skip materialize %s: %s", info.cwd, exc)

    for cwd, proj in by_cwd.items():
        if cwd in fs_by_cwd:
            continue
        # DB-only projects bypass the scan-time temp filter (the scans above
        # already drop temp cwds). Apply the same guard here so a Project
        # entity that was once materialized for a temp cwd (e.g. via an
        # include_temp=True indexer run) doesn't resurface in the picker.
        if not is_valid_project_cwd(cwd, include_temp=include_temp):
            continue
        # A stale mount-root entity is tagged system=True by _entity_to_project_info
        # (via is_hidden_project) rather than dropped, so it lands in the hidden list.
        fs_by_cwd[cwd] = _entity_to_project_info(proj, cwd)

    # `modified_at` may arrive as ISO string or datetime — coerce for ordering.
    return sorted(
        fs_by_cwd.values(),
        key=lambda p: (str(p.modified_at) if p.modified_at else "", p.name),
        reverse=True,
    )


async def get_all_scope_filter(
    *,
    include_temp: bool = False,
    create_missing: bool = True,
) -> "ScopeFilter":
    """Build the canonical ``ScopeFilter`` covering user + every known project.

    This is the explicit replacement for the silent "no filter = walk the
    universe" pattern. Callers that previously passed ``scope_filter=None``
    into the indexer (and got an implicit fanout via the since-retired
    ``USER_HOME_FOLDER`` expander walker) should call this
    helper instead — the returned filter materialises every Claude/Codex
    project cwd as an explicit ``REAL_PROJECT_CWD`` root via
    ``_resolve_scoped_roots``, so the work the scan does becomes visible at
    the route boundary instead of buried inside the indexer registration table.
    """
    from flow_sdk.server.search_filters import ScopeFilter  # noqa: PLC0415
    projects = await get_all_projects(
        include_temp=include_temp, create_missing=create_missing
    )
    return ScopeFilter(
        user=True,
        projects=tuple(p.project_id for p in projects if p.project_id),
        record_projects=tuple(p.record_project_id for p in projects if p.record_project_id),
        project_roots=tuple((p.project_id, p.cwd) for p in projects if p.project_id and p.cwd),
    )


async def _materialize(
    info: ProjectInfo,
    *,
    include_temp: bool = False,
) -> None:
    """Save a fresh ``Project`` for ``info.cwd``; mutate ``info.project_id``.

    The entity gets an opaque uuid4 id (NOT ``info.project_id``, which is the
    path-derived alias). ``info.record_project_id`` keeps the alias so records
    stamped with it still resolve; ``info.project_id`` is updated to the new id.
    """
    from flow_sdk.builtin.project import Project
    if not is_valid_project_cwd(info.cwd, include_temp=include_temp):
        return
    proj = Project.model_validate({
        "fs_storage_mount_path": info.cwd,
        "name": info.name,
    })
    proj.id = Project.allocate_id(proj.model_dump())
    info.project_id = proj.id
    await proj.save()
    invalidate_projects_cache()  # a new project entity exists — drop the GET cache
