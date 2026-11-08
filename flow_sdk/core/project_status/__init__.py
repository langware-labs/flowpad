"""A project's status on this machine (``local_status``): read at once, refreshed in the background, pushed.

One file per project per instance, ``<records data root>/project/<id>/status.json`` — this machine's state, never
in the project's folder. A read answers from that file and never checks anything; a part that is missing, older
than its TTL or marked stale is refreshed in the background (once at a time per part), written back, and pushed:
the Project row's ``local_status`` field is computed from this file, so ``notify_updated`` carries the new answer to every
screen watching the project. Something that changes what a part depends on calls :func:`mark_stale`.
"""

from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

from flow_sdk.schema.data_spec.project_status_spec import ProjectStatusSpec, StatusPartSpec

logger = logging.getLogger(__name__)

STATUS_FILE = "status.json"
LOCK_FILE = "status.lock"

#: ``setup``: what is left to set up here — a ``project.setup.readiness`` value (``readiness_of``).
SETUP = "setup"


async def _build_setup(project_id: str) -> dict[str, Any]:
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.builtin.project_setup import readiness_of  # noqa: PLC0415

    project = await Project.get_by_id(project_id)
    if project is None:
        raise LookupError(f"no project {project_id}")
    readiness = await readiness_of(project, include_ready=True)
    return readiness.model_dump(mode="json")


#: Each part: its TTL and how it is answered.
PARTS: dict[str, tuple[float, Callable[[str], Awaitable[dict[str, Any]]]]] = {
    SETUP: (30.0, _build_setup),
}

#: A project read this recently is on someone's screen: a change refreshes it at once instead of on next read.
_SEEN_S = 600.0
_seen: dict[str, float] = {}
_running: dict[tuple[str, str], asyncio.Task] = {}
#: A change that landed while the part was being refreshed: refresh once more when that one ends.
_again: set[tuple[str, str]] = set()
#: When something every project (``""``) or one project reads last changed: an answer older is due. In memory —
#: a project off screen costs nothing per change, and a restart drops it (the TTL bounds what is missed).
_changed_at: dict[str, float] = {}


def _bare(project_id: str) -> str:
    return str(project_id).removeprefix("project-")


def path_of(project_id: str) -> Path:
    from flow_sdk.fs_store.record_paths import data_dir_for  # noqa: PLC0415

    return data_dir_for("project", _bare(project_id)) / STATUS_FILE


_PARSED: dict[Path, tuple[tuple[int, int], ProjectStatusSpec]] = {}


def read_stored(project_id: str) -> ProjectStatusSpec:
    """What is stored for ``project_id``; an empty status when nothing is (or it cannot be read). Never checks."""
    from flow_sdk.instances.atomic import read_json  # noqa: PLC0415

    path = path_of(project_id)
    try:
        stat = path.stat()
        token = (stat.st_mtime_ns, stat.st_size)
    except OSError:
        return ProjectStatusSpec(project_id=_bare(project_id))
    kept = _PARSED.get(path)
    if kept is not None and kept[0] == token:
        return kept[1]
    try:
        parsed = ProjectStatusSpec.model_validate(read_json(path) or {"project_id": _bare(project_id)})
    except ValueError as exc:
        logger.warning("unreadable project status of %s: %s", project_id, exc)
        return ProjectStatusSpec(project_id=_bare(project_id))
    _PARSED[path] = (token, parsed)
    return parsed


def _write_part(project_id: str, part: str, **changes: Any) -> bool:
    """Apply ``changes`` to one part under the file's lock. True when it changed."""
    from flow_sdk.instances.atomic import locked, write_json_atomic  # noqa: PLC0415

    path = path_of(project_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    with locked(path.parent / LOCK_FILE):
        before = read_stored(project_id)
        ttl = PARTS[part][0] if part in PARTS else 30.0
        old = before.parts.get(part) or StatusPartSpec(ttl_s=ttl)
        new = old.model_copy(update={**changes, "ttl_s": ttl})
        if new == old:
            return False
        after = before.model_copy(update={"parts": {**before.parts, part: new}})
        write_json_atomic(path, after.model_dump(mode="json"))
    return True


def _due(project_id: str, part: Optional[StatusPartSpec], now: float) -> bool:
    if part is None or part.checked_at is None or part.stale:
        return True
    changed = max(_changed_at.get("", 0.0), _changed_at.get(project_id, 0.0))
    return part.checked_at < changed or now - part.checked_at >= part.ttl_s


def _asked(parts: Optional[list[str]]) -> list[str]:
    """The known parts among ``parts`` (every part when none is named)."""
    return [p for p in parts or PARTS if p in PARTS]


async def _push(project_id: str) -> None:
    """Every screen watching the project re-reads its row, and so its ``status``. Best effort."""
    try:
        from flow_sdk.builtin.project import Project  # noqa: PLC0415

        project = await Project.get_by_id(_bare(project_id))
        if project is not None:
            await project.notify_updated()
    except Exception as exc:  # noqa: BLE001 — a missed push is caught by the next read
        logger.debug("project status push of %s failed: %s", project_id, exc)


async def _refresh(project_id: str, part: str) -> None:
    key = (project_id, part)
    build = PARTS[part][1]
    while True:
        _again.discard(key)
        if await asyncio.to_thread(_write_part, project_id, part, checking=True):
            await _push(project_id)
        try:
            value = await build(project_id)
            changes: dict[str, Any] = {"value": value, "checked_at": time.time(), "error": ""}
        except Exception as exc:  # noqa: BLE001 — the part keeps its last answer and says why it is old
            logger.warning("project status %s of %s failed: %s", part, project_id, exc, exc_info=True)
            changes = {"error": str(exc) or type(exc).__name__}
        again = key in _again
        await asyncio.to_thread(_write_part, project_id, part, checking=again, stale=again, **changes)
        await _push(project_id)
        if not again:
            return


def refresh(project_id: str, part: str, *, changed: bool = True) -> asyncio.Task:
    """Refresh ``part`` in the background — the one already running when there is one. ``changed``: something it
    reads changed, so a refresh already under way runs once more after it (a mere read does not ask that)."""
    project_id = _bare(project_id)
    key = (project_id, part)
    task = _running.get(key)
    if task is not None and not task.done():
        if changed:
            _again.add(key)
        return task
    from flow_sdk.request_context.detached import add_detached_done_callback, create_detached_task  # noqa: PLC0415

    # Detached: a caller inside a DB session (an entity write's bus hook) must not lend that session to the refresh.
    task = create_detached_task(_refresh(project_id, part), name=f"project-status:{project_id}:{part}")
    _running[key] = task
    add_detached_done_callback(task, lambda _t, k=key: _running.pop(k, None) if _running.get(k) is _t else None)
    return task


def read(project_id: str, parts: Optional[list[str]] = None) -> ProjectStatusSpec:
    """What is stored, at once; every asked part that is missing, old or stale starts refreshing behind it."""
    project_id = _bare(project_id)
    now = time.time()
    _seen[project_id] = now
    stored = read_stored(project_id)
    for part in _asked(parts):
        if _due(project_id, stored.parts.get(part), now):
            refresh(project_id, part, changed=False)
    return stored


async def fresh(project_id: str, part: str = SETUP) -> StatusPartSpec:
    """The part's answer, refreshed first when it is due — for a caller that must not get an old one."""
    project_id = _bare(project_id)
    stored = read_stored(project_id).parts.get(part)
    if _due(project_id, stored, time.time()):
        await refresh(project_id, part)
        stored = read_stored(project_id).parts.get(part)
    return stored or StatusPartSpec()


def mark_stale(project_id: Optional[str] = None, parts: Optional[list[str]] = None) -> None:
    """Something ``parts`` depend on changed (``project_id`` None: every project's). A project on someone's screen is
    refreshed now; any other is due on its next read. Never touches disk here. Safe from any code."""
    now = time.time()
    _changed_at[_bare(project_id) if project_id else ""] = now
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return  # no loop (a CLI process): nobody is watching
    for pid, seen in list(_seen.items()):
        if (not project_id or pid == _bare(project_id)) and now - seen < _SEEN_S:
            for part in _asked(parts):
                refresh(pid, part)


def changes_status(fn):
    """Decorator: once the wrapped coroutine finishes (raised or not), what every project's status reads may have
    changed. For a write that is not an entity write (a credential value, an OAuth grant)."""
    import functools  # noqa: PLC0415

    @functools.wraps(fn)
    async def run(*args, **kwargs):
        try:
            return await fn(*args, **kwargs)
        finally:
            mark_stale()

    return run


__all__ = ["PARTS", "changes_status", "SETUP", "fresh", "mark_stale", "path_of", "read", "read_stored", "refresh"]
