"""Each process's transcript location, remembered between serializations.

Every ``AgenticProcess`` serialization derives ``worker_status`` from its
transcript, and every driver found that file by searching the filesystem — on
the event loop, once per process per response (RCA 2026-09-16: a 235-process
list blocked the loop for 3.4s). A resolved location is reused while nothing it
was resolved from has changed, if the process is terminal (no worker is left to
move its transcript) or the driver declares the path final
(``transcript_is_final``: the session's own record, which a live turn only
appends to). Everything else resolves every time, exactly as before.

Module-level, not on the entity: each request re-hydrates processes from the DB.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Callable

from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import AgenticProcessContextKey
from flow_sdk.builtin.process_lifecycle import ProcessStatus

if TYPE_CHECKING:
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

_TERMINAL = frozenset({ProcessStatus.STOPPED.value, ProcessStatus.FAILED.value})
# Far above any real process count; a backstop against unbounded growth, not a policy.
_MAX_ENTRIES = 4096

_entries: dict[str, tuple[tuple[str, ...], Path | None]] = {}
# A finished process's worker status: no worker is left to append to its transcript, so the tail never changes.
_terminal_status: dict[str, tuple[tuple[str, ...], object]] = {}


def _key(process: "AgenticProcess") -> tuple[str, ...]:
    """Every input a driver resolves from: a change to any of them is a miss."""
    started_at = (process.context_data or {}).get(AgenticProcessContextKey.WORKER_STARTED_AT.value)
    return (
        str(process.worker_type or ""),
        process.session_id or "",
        process.workdir or "",
        str(started_at or ""),
        process.status or "",
    )


def _store(cache: dict, process_id: str, key: tuple[str, ...], value: object) -> None:
    """Remember ``value`` under ``key``; full, the oldest entry goes (never the whole cache at once)."""
    if len(cache) >= _MAX_ENTRIES:
        cache.pop(next(iter(cache)))
    cache[process_id] = (key, value)


def transcript_path(process: "AgenticProcess") -> Path | None:
    """The process's transcript file, resolving through its driver only when needed."""
    key = _key(process)
    entry = _entries.get(str(process.id))
    if entry is not None and entry[0] == key and (entry[1] is None or entry[1].exists()):
        return entry[1]
    path = process.driver.transcript_path(process)
    is_final = getattr(process.driver, "transcript_is_final", None)
    if process.status in _TERMINAL or (path is not None and is_final is not None and is_final(process, path)):
        _store(_entries, str(process.id), key, path)
    else:
        _entries.pop(str(process.id), None)
    return path


def terminal_status(process: "AgenticProcess", discover: "Callable[[], object]") -> object:
    """A finished process's status from its transcript, discovered once per key; a live one, every time."""
    if process.status not in _TERMINAL:
        return discover()
    key = _key(process)
    entry = _terminal_status.get(str(process.id))
    if entry is not None and entry[0] == key:
        return entry[1]
    value = discover()
    _store(_terminal_status, str(process.id), key, value)
    return value


def invalidate(process_id: str | None) -> None:
    """Forget one process's remembered transcript location and status."""
    if process_id is not None:
        _entries.pop(str(process_id), None)
        _terminal_status.pop(str(process_id), None)


def clear() -> None:
    """Forget every remembered transcript location and status."""
    _entries.clear()
    _terminal_status.clear()
