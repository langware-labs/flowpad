"""Watch one file on disk and tell the connections that asked: ``file_changed_msg``.

The file counterpart of the entity ``watch`` action, built from the same parts:
watchers live in ``watch_registry`` (under a ``file:`` key, so a dropped socket's
``cleanup_connection`` clears them too), and the change reaches exactly the
connections watching it over their own WebSocket.

One watch loop per FOLDER, started by its first watcher and stopped when none is
left. The folder rather than the file because saves replace the file by rename
(``atomic_write``), which a watch on the file itself loses — and one loop for the
whole folder because each ``awatch`` holds a worker thread for as long as it runs,
so a loop per open file in one folder is a thread per open file.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from flow_sdk.app.actions.watch_registry import add_watch, get_watched_by, remove_watch

logger = logging.getLogger(__name__)

#: folder -> the watch loop over it, shared by every watched file inside it
_loops: dict[str, asyncio.Task] = {}
#: local path -> the (entity, path) addresses clients named it by; echoed back so
#: each client matches the message against what it registered.
_addresses: dict[str, set[tuple[str, str]]] = {}


def _key(entity: str, path: str) -> str:
    return f"file:{entity}:{path}"


def _watched(local: str) -> bool:
    return any(get_watched_by(_key(e, p)) for e, p in _addresses.get(local, ()))


def _folder(local: str) -> str:
    return os.path.dirname(local)


def _watched_in(folder: str) -> list[str]:
    """The files of *folder* someone is still watching."""
    return [local for local in list(_addresses) if _folder(local) == folder and _watched(local)]


def watch_file(connection_id: str, local: str, entity: str, path: str) -> None:
    add_watch(connection_id, _key(entity, path))
    _addresses.setdefault(local, set()).add((entity, path))
    folder = _folder(local)
    loop = _loops.get(folder)
    if loop is None or loop.done():
        _loops[folder] = asyncio.get_running_loop().create_task(_watch_loop(folder))


def unwatch_file(connection_id: str, local: str, entity: str, path: str) -> None:
    remove_watch(connection_id, _key(entity, path))
    if not _watched(local):
        _stop(local)


def _stop(local: str) -> None:
    """Forget *local*; the folder's loop ends with the last file it was watching."""
    _addresses.pop(local, None)
    folder = _folder(local)
    if _watched_in(folder):
        return
    loop = _loops.pop(folder, None)
    if loop is not None:
        loop.cancel()


async def _watch_loop(folder: str) -> None:
    from watchfiles import awatch  # noqa: PLC0415

    def is_watched(_change, changed: str) -> bool:
        return os.path.join(folder, os.path.basename(changed)) in _addresses

    async for changes in awatch(folder, watch_filter=is_watched, recursive=False, debounce=50):
        touched = {os.path.join(folder, os.path.basename(changed)) for _change, changed in changes}
        for local in touched:
            if _watched(local):
                await _notify(local)
            else:  # every watcher's socket dropped since the last change
                _stop(local)
        if not _watched_in(folder):
            _loops.pop(folder, None)
            return


async def _notify(local: str) -> None:
    from flow_sdk.core.network.connections import get_connection  # noqa: PLC0415

    sends = []
    for entity, path in list(_addresses.get(local, ())):
        message = json.dumps(
            {
                "message_type": "file_changed_msg",
                "message_id": str(uuid4()),
                "entity": entity,
                "path": path,
                "t": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            }
        )
        for connection_id in get_watched_by(_key(entity, path)):
            ws = get_connection(connection_id)
            if ws is None:
                continue
            sends.append(_send(ws, message, connection_id))
    # Together: one slow socket must not hold up the rest.
    await asyncio.gather(*sends)


async def _send(ws, message: str, connection_id: str) -> None:
    try:
        await ws.send_text(message)
    except Exception:  # noqa: BLE001 — one closed socket must not starve the rest
        logger.debug("file_changed_msg to %s failed", connection_id, exc_info=True)


def watching(local: str) -> bool:
    """Whether *local* is being watched by its folder's loop (tests, diagnostics)."""
    local = str(Path(local))
    loop = _loops.get(_folder(local))
    return local in _addresses and loop is not None and not loop.done()
