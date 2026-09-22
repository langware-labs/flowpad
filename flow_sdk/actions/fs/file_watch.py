"""Watch one file on disk and tell the connections that asked: ``file_changed_msg``.

The file counterpart of the entity ``watch`` action, built from the same parts:
watchers live in ``watch_registry`` (under a ``file:`` key, so a dropped socket's
``cleanup_connection`` clears them too), and the change reaches exactly the
connections watching it over their own WebSocket.

One watch loop per file, started by its first watcher and stopped when none is
left. It watches the file's FOLDER, filtered to the file's name: saves replace
the file by rename (``atomic_write``), which a watch on the file itself loses.
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

#: local path -> its watch loop
_loops: dict[str, asyncio.Task] = {}
#: local path -> the (entity, path) addresses clients named it by; echoed back so
#: each client matches the message against what it registered.
_addresses: dict[str, set[tuple[str, str]]] = {}


def _key(entity: str, path: str) -> str:
    return f"file:{entity}:{path}"


def _watched(local: str) -> bool:
    return any(get_watched_by(_key(e, p)) for e, p in _addresses.get(local, ()))


def watch_file(connection_id: str, local: str, entity: str, path: str) -> None:
    add_watch(connection_id, _key(entity, path))
    _addresses.setdefault(local, set()).add((entity, path))
    loop = _loops.get(local)
    if loop is None or loop.done():
        _loops[local] = asyncio.get_running_loop().create_task(_watch_loop(local))


def unwatch_file(connection_id: str, local: str, entity: str, path: str) -> None:
    remove_watch(connection_id, _key(entity, path))
    if not _watched(local):
        _stop(local)


def _stop(local: str) -> None:
    _addresses.pop(local, None)
    loop = _loops.pop(local, None)
    if loop is not None:
        loop.cancel()


async def _watch_loop(local: str) -> None:
    from watchfiles import awatch  # noqa: PLC0415

    name = os.path.basename(local)
    async for _changes in awatch(
        os.path.dirname(local),
        watch_filter=lambda _change, changed: os.path.basename(changed) == name,
        recursive=False,
        debounce=50,
    ):
        if not _watched(local):  # every watcher's socket dropped since the last change
            _stop(local)
            return
        await _notify(local)


async def _notify(local: str) -> None:
    from flow_sdk.core.network.connections import get_connection  # noqa: PLC0415

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
            try:
                await ws.send_text(message)
            except Exception:  # noqa: BLE001 — one closed socket must not starve the rest
                logger.debug("file_changed_msg to %s failed", connection_id, exc_info=True)


def watching(local: str) -> bool:
    """Whether a watch loop is running for *local* (tests, diagnostics)."""
    loop = _loops.get(str(Path(local)))
    return loop is not None and not loop.done()
