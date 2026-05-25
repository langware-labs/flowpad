"""Canonical project list: Claude scan ∪ Codex scan ∪ Project.get_all(), deduped
by canonical posix cwd. When ``create_missing=True``, materializes a Project for
any FS-discovered cwd not yet in the entity table (id via ``Project.derive_id_for_path``).
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator

from flow_sdk.fs_records._claude_projects import iter_claude_project_paths
from flow_sdk.fs_records.codex.codex_project import (
    _is_valid_cwd,
    _read_codex_projects_from_config,
)
from flow_sdk.fs_store.path_utils import canonical_posix_path
from flow_sdk.instance_settings import get_instance_settings


@dataclass
class ProjectInfo:
    """Enriched project descriptor: identity + provenance + freshness."""

    cwd: str                                              # canonical posix path
    name: str                                             # display name (basename, or entity override)
    project_id: str                                       # Project entity id (uuid5-of-cwd)
    worker_types: list[str] = field(default_factory=list) # ['claude'] / ['codex'] / both
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

    def _scan(paths: Iterator[Path], worker: str) -> None:
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
                )
                fs_by_cwd[canonical] = info
            if worker not in info.worker_types:
                info.worker_types.append(worker)

    _scan(iter_claude_project_paths(include_temp=include_temp), "claude")
    _scan(iter_codex_project_paths(include_temp=include_temp), "codex")

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
            info.modified_at = getattr(proj, "updated_date", None)
            # Prefer entity name when set (user may have renamed)
            if getattr(proj, "name", None):
                info.name = proj.name  # type: ignore[assignment]
        else:
            info.project_id = Project.derive_id_for_path(cwd) or ""
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
        fs_by_cwd[cwd] = ProjectInfo(
            cwd=cwd,
            name=proj.name or cwd,
            project_id=proj.id,
            worker_types=[],
            modified_at=getattr(proj, "updated_date", None),
        )

    # `modified_at` may arrive as ISO string or datetime — coerce for ordering.
    return sorted(
        fs_by_cwd.values(),
        key=lambda p: (str(p.modified_at) if p.modified_at else "", p.name),
        reverse=True,
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
