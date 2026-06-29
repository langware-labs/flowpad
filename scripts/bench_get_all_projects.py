#!/usr/bin/env python3
"""Benchmark: phase-by-phase breakdown of get_all_projects.

Run from repo root:

    uv run python scripts/bench_get_all_projects.py
"""

from __future__ import annotations

import asyncio
import time
from collections import Counter
from pathlib import Path

from flow_sdk.fs_store.indexer.functions._claude_projects import iter_claude_project_paths
from flow_sdk.fs_store.operations.all_projects import (
    ProjectInfo,
    get_all_projects,
    iter_codex_project_paths,
)
from flow_sdk.fs_store.path_utils import canonical_posix_path


def _ms(start: float) -> float:
    return (time.perf_counter() - start) * 1000


async def instrumented(*, create_missing: bool = True) -> dict:
    """Replay get_all_projects with per-phase timings."""
    from flow_sdk.builtin.project import Project

    times: dict[str, float] = {}

    # Phase 1a: Claude scan
    t = time.perf_counter()
    claude_paths = list(iter_claude_project_paths())
    times["1a_claude_scan"] = _ms(t)

    # Phase 1b: Codex scan
    t = time.perf_counter()
    codex_paths = list(iter_codex_project_paths())
    times["1b_codex_scan"] = _ms(t)

    # Phase 1c: canonicalize all FS paths
    t = time.perf_counter()
    fs_by_cwd: dict[str, ProjectInfo] = {}
    for path in claude_paths:
        c = canonical_posix_path(path)
        if c and c not in fs_by_cwd:
            fs_by_cwd[c] = ProjectInfo(cwd=c, name=Path(c).name or c, project_id="",
                                       worker_types=["claude"])
        elif c:
            if "claude" not in fs_by_cwd[c].worker_types:
                fs_by_cwd[c].worker_types.append("claude")
    for path in codex_paths:
        c = canonical_posix_path(path)
        if c and c not in fs_by_cwd:
            fs_by_cwd[c] = ProjectInfo(cwd=c, name=Path(c).name or c, project_id="",
                                       worker_types=["codex"])
        elif c:
            if "codex" not in fs_by_cwd[c].worker_types:
                fs_by_cwd[c].worker_types.append("codex")
    times["1c_canonicalize_merge"] = _ms(t)

    # Phase 2: Project.get_all()
    t = time.perf_counter()
    existing = await Project.get_all()
    times["2_project_get_all"] = _ms(t)

    # Phase 2b: build by_cwd lookup
    t = time.perf_counter()
    by_cwd: dict[str, Project] = {}
    for proj in existing:
        if proj.fs_storage_mount_path:
            by_cwd[canonical_posix_path(proj.fs_storage_mount_path)] = proj
    times["2b_build_lookup"] = _ms(t)

    # Phase 3: pair-up
    t = time.perf_counter()
    to_create: list[ProjectInfo] = []
    for cwd, info in fs_by_cwd.items():
        if cwd in by_cwd:
            proj = by_cwd[cwd]
            info.project_id = proj.id
            info.modified_at = getattr(proj, "updated_date", None)
            if getattr(proj, "name", None):
                info.name = proj.name  # type: ignore[assignment]
        else:
            info.project_id = Project.derive_id_for_path(cwd) or ""
            info.is_new = True
            to_create.append(info)
    times["3_pair_up"] = _ms(t)

    # Phase 4: materialize
    t = time.perf_counter()
    if create_missing and to_create:
        from flow_sdk.fs_store.operations.all_projects import _materialize
        await asyncio.gather(*(_materialize(info) for info in to_create))
    times["4_materialize"] = _ms(t)

    # Phase 5: backfill entity-only
    t = time.perf_counter()
    for cwd, proj in by_cwd.items():
        if cwd in fs_by_cwd:
            continue
        fs_by_cwd[cwd] = ProjectInfo(
            cwd=cwd, name=proj.name or cwd, project_id=proj.id,
            worker_types=[], modified_at=getattr(proj, "updated_date", None),
        )
    times["5_backfill"] = _ms(t)

    # Phase 6: sort
    t = time.perf_counter()
    projects = sorted(
        fs_by_cwd.values(),
        key=lambda p: (str(p.modified_at) if p.modified_at else "", p.name),
        reverse=True,
    )
    times["6_sort"] = _ms(t)

    times["_total"] = sum(v for k, v in times.items() if not k.startswith("_"))

    return {
        "times": times,
        "fs_count": len(claude_paths) + len(codex_paths),
        "claude_count": len(claude_paths),
        "codex_count": len(codex_paths),
        "entity_count": len(existing),
        "merged_count": len(projects),
        "to_create_count": len(to_create),
    }


async def main() -> int:
    print("get_all_projects — phase-by-phase breakdown")
    print("=" * 60)

    # Warm everything once so cold-DB doesn't dominate the breakdown
    await get_all_projects(create_missing=False)

    for label in ("call 1", "call 2", "call 3"):
        r = await instrumented(create_missing=False)
        print(f"\n{label}:  fs={r['fs_count']} (claude={r['claude_count']} codex={r['codex_count']})"
              f"  entities={r['entity_count']}  merged={r['merged_count']}  to_create={r['to_create_count']}")
        for phase, ms in r["times"].items():
            bar = "█" * int(ms / 2) if ms > 0 else ""
            print(f"  {phase:<24} {ms:>7.2f} ms  {bar}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
