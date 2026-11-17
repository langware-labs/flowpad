"""Claude Code's workspace trust. A workdir's trust stays the person's step in Claude's prompt; the folders Flowpad
itself mounts with ``--add-dir`` (its own folders and the project's dependencies) are trusted before launch."""

from __future__ import annotations

import json
from collections.abc import Sequence
from pathlib import Path

from flow_sdk.instance_settings import get_instance_settings

#: ``~/.claude.json``'s projects map, kept until the file changes (it is megabytes, and read per worktree launch).
_cached: tuple[tuple[float, int], dict] | None = None


def _projects() -> dict:
    global _cached
    path = get_instance_settings().user_home / ".claude.json"
    try:
        stat = path.stat()
    except OSError:
        return {}
    key = (stat.st_mtime, stat.st_size)
    if _cached is None or _cached[0] != key:
        try:
            settings = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        projects = settings.get("projects") if isinstance(settings, dict) else None
        _cached = (key, projects if isinstance(projects, dict) else {})
    return _cached[1]


def claude_trusts(workdir: str | None) -> bool:
    """Whether Claude has its workspace trust accepted for ``workdir`` itself. A trusted folder above it does not
    count: Claude refuses --worktree there even with ``/`` trusted."""
    if not workdir:
        return False
    return _trusted(Path(workdir).expanduser().resolve(), _projects())


def _trusted(folder: Path, projects: dict) -> bool:
    # Claude keys a Windows folder with forward slashes (C:/x); str(Path) uses backslashes.
    return any((projects.get(key) or {}).get("hasTrustDialogAccepted") for key in (str(folder), folder.as_posix()))


def _flowpad_roots() -> list[Path]:
    """The product folders Flowpad mounts: the assistant project, its skill views, and the sessions' own folders
    (``execution/assets`` and ``execution/input``). Trusting a folder covers everything below it, so never a folder
    holding the person's data — the instance folder holds their ``workspace/`` projects."""
    from flow_sdk.builtin.agentic_process.assistant_view import _assistant_root, _views_root  # noqa: PLC0415

    roots = (_assistant_root(), _views_root(), get_instance_settings().records_root / "agentic_process")
    return [root.expanduser().resolve() for root in roots]


def trust_mounted_dirs(add_dirs: Sequence[str], dependency_dirs: Sequence[str]) -> None:
    """Since Claude 2.1.326 ``--add-dir`` asks for trust on every folder not trusted yet. The ones Flowpad mounts
    are not the person's to judge: one under a Flowpad folder trusts that folder (once, for every session), a
    project dependency trusts itself (the person chose it). Any other added folder still gets Claude's prompt."""
    from flow_sdk.fs_store.operations.claude_settings import write_claude_flags  # noqa: PLC0415

    roots = _flowpad_roots()
    dependencies = {Path(d).expanduser().resolve() for d in dependency_dirs}
    projects, wanted = _projects(), []
    for raw in add_dirs:
        folder = Path(raw).expanduser().resolve()
        target = next((root for root in roots if root == folder or root in folder.parents), None)
        target = target or (folder if folder in dependencies else None)
        if target and target not in wanted and not any(_trusted(f, projects) for f in (target, *target.parents)):
            wanted.append(target)
    if wanted:
        write_claude_flags(trust_folders=[str(f) for f in wanted])
