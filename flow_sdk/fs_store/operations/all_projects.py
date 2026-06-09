"""Canonical project list: worker scans ∪ Project.get_all(), deduped
by canonical posix cwd. When ``create_missing=True``, materializes a Project for
any FS-discovered cwd not yet in the entity table and keeps the path-derived
record id as a compatibility alias for existing fs-record rows.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Iterator

from flow_sdk.fs_store.indexer.functions._claude_projects import iter_claude_project_paths
from flow_sdk.fs_store.indexer.functions.codex_projects import (
    _is_valid_cwd,
    _read_codex_projects_from_config,
)
from flow_sdk.fs_store.path_utils import canonical_posix_path
from flow_sdk.instance_settings import get_instance_settings
from flow_sdk.utils.file_system import is_temp_path

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


def iter_codex_project_paths(include_temp: bool = False) -> Iterator[Path]:
    """Yield canonical Codex project paths from ``<home>/.codex/config.toml``.

    Skips temp paths and non-existent dirs to match ``iter_claude_project_paths``
    semantics. Reads only ``config.toml`` — the rollout-JSONL deep scan (see
    ``codex_projects_fn``) is deliberately skipped here; cold-call perf >> 100% recall.
    """
    config_path = get_instance_settings().codex_config_path
    seen: set[str] = set()
    for cwd_str in _read_codex_projects_from_config(config_path):
        if not _is_valid_cwd(cwd_str):
            continue
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
    workspace = get_instance_settings().user_home / "Flowpad workspace"
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
        if not include_temp and is_temp_path(canonical_posix_path(child)):
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
    root = get_instance_settings().user_home / ".copilot" / "session-state"
    if not root.is_dir():
        return
    seen: set[str] = set()
    for workspace in root.glob("*/workspace.yaml"):
        cwd = _read_copilot_workspace_cwd(workspace)
        if not cwd or not cwd.startswith("/") or cwd == "/":
            continue
        canonical = canonical_posix_path(cwd)
        if not canonical or canonical in seen:
            continue
        if not include_temp and is_temp_path(canonical):
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
            if not canonical:
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

    _scan(iter_claude_project_paths(include_temp=include_temp), "claude")
    _scan(iter_codex_project_paths(include_temp=include_temp), "codex")
    _scan(iter_copilot_project_paths(include_temp=include_temp), "copilot")
    _scan(iter_workspace_project_paths(include_temp=include_temp), None)

    existing = await Project.get_all()
    by_cwd: dict[str, "Project"] = {}
    for proj in existing:
        if proj.fs_storage_mount_path:
            by_cwd[canonical_posix_path(proj.fs_storage_mount_path)] = proj

    to_create: list[ProjectInfo] = []
    for cwd, info in fs_by_cwd.items():
        if cwd in by_cwd:
            proj = by_cwd[cwd]
            info.project_id = proj.id
            info.record_project_id = Project.derive_id_for_path(cwd) or info.record_project_id
            info.modified_at = getattr(proj, "updated_date", None)
            # Prefer entity name when set (user may have renamed)
            if getattr(proj, "name", None):
                info.name = proj.name  # type: ignore[assignment]
        else:
            info.project_id = Project.derive_id_for_path(cwd) or ""
            info.record_project_id = info.project_id
            info.is_new = True
            to_create.append(info)

    # Sequential saves: SQLite serializes writes anyway and asyncio.gather hits
    # "database is locked" under contention from concurrent indexer scans.
    if create_missing and to_create:
        for info in to_create:
            try:
                await _materialize(info)
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
        if not include_temp and is_temp_path(cwd):
            continue
        fs_by_cwd[cwd] = ProjectInfo(
            cwd=cwd,
            name=proj.name or cwd,
            project_id=proj.id,
            record_project_id=Project.derive_id_for_path(cwd) or "",
            worker_types=[],
            modified_at=getattr(proj, "updated_date", None),
        )

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
    into the indexer (and got an implicit fanout via the
    ``real_project_cwd_fn`` expander on ``USER_HOME_FOLDER``) should call this
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


async def _materialize(info: ProjectInfo) -> None:
    """Save a fresh ``Project`` for ``info.cwd``; mutate ``info.project_id``."""
    from flow_sdk.builtin.project import Project
    proj = Project.model_validate({
        "id": info.project_id,
        "fs_storage_mount_path": info.cwd,
        "name": info.name,
    })
    proj.id = Project.allocate_id(proj.model_dump())
    info.project_id = proj.id
    await proj.save()
