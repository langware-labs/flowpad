"""Test helper: put folders in a project's context the one way there is — ``flow.json``.

A context folder is a resolved ``flow.json`` dependency (``project_dependencies``). A
test that only needs "this project also sees that folder" declares each folder as a
``file:`` dependency and resolves, so the links it reads are the ones production writes.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterable

from flow_sdk.builtin.project_dependencies import safe_name


def declare_file_dependencies(root: str | Path, dirs: Iterable[str | Path]) -> dict[str, str]:
    """Write ``flow.json`` at ``root`` declaring each of ``dirs`` as a required ``file:``
    dependency (named after its leaf). Returns ``{name: source}``."""
    deps: dict[str, str] = {}
    for d in dirs:
        base = safe_name(Path(d).name)
        name, n = base, 2
        while name in deps:
            name, n = f"{base}-{n}", n + 1
        deps[name] = f"file:{d}"
    path = Path(root) / "flow.json"
    document = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    document["dependencies"] = {**document.get("dependencies", {}), **deps}
    path.write_text(json.dumps(document, indent=2), encoding="utf-8")
    return deps


async def link_context_dirs(project, dirs: Iterable[str | Path], *, index: bool = False):
    """Declare ``dirs`` in the project's ``flow.json`` and resolve them into its context.

    ``index=True`` also scans each newly linked folder (what ``resolve_dependencies``
    does); the default is the network-free, scan-free status read."""
    dirs = list(dirs)
    if not dirs:
        return []
    Path(project.fs_storage_mount_path).mkdir(parents=True, exist_ok=True)
    declare_file_dependencies(project.fs_storage_mount_path, dirs)
    if index:
        return await project.resolve_dependencies()
    return await project.dependencies()
