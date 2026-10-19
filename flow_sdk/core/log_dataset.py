"""A log as a dataset in Flowpad's temp folder: created and indexed on its first row, one writer.

Temp on purpose: the OS clears ``FLOWPAD_TEMP_DIR`` (``$TMPDIR/flowpad_temp``) now and then, and
``max_rows`` drops the oldest rows, so a log never grows without bound. Rows worth keeping are
copied into a kept dataset before they age out.

The writer under SmartNavigationLog (``core/navigation_log``) and every FlowCall log
(``core/compute_op/call_log``). A log never raises and never slows what it logs.
"""

from __future__ import annotations

import asyncio
import json
import logging
import weakref
from pathlib import Path
from typing import Any, Coroutine, Optional

logger = logging.getLogger(__name__)

#: One writer per event loop and log: ``append`` numbers rows by what is on disk, and an asyncio
#: lock belongs to the loop that first used it.
_locks: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, dict[str, asyncio.Lock]]" = weakref.WeakKeyDictionary()
_pending: set[asyncio.Task] = set()


def temp_datasets() -> Path:
    """This instance's datasets in Flowpad's TEMP folder."""
    from flow_sdk import config  # noqa: PLC0415
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    return Path(config.FLOWPAD_TEMP_DIR) / get_instance_settings().instance_name / "agentic-assets" / "dataset"


def _lock(name: str) -> asyncio.Lock:
    per_loop = _locks.setdefault(asyncio.get_running_loop(), {})
    return per_loop.setdefault(name, asyncio.Lock())


def spawn(coro: Coroutine[Any, Any, Any]) -> None:
    """Run a log write in the background, outside the caller's request; ``drain`` waits for it."""
    from flow_sdk.request_context.detached import add_detached_done_callback, create_detached_task  # noqa: PLC0415

    task = create_detached_task(coro, name="temp-log")
    _pending.add(task)
    add_detached_done_callback(task, _pending.discard)


async def drain() -> None:
    """Wait for the logs in flight (tests, shutdown)."""
    while _pending:
        await asyncio.gather(*list(_pending), return_exceptions=True)


def rows(folder: Path) -> list[Path]:
    """A log's example dirs, oldest first: numbered rows by number (``0009`` before ``10000``)."""
    from flow_sdk.schema.data_spec.layout import _row_dirs  # noqa: PLC0415 -- THE row enumeration

    return sorted(_row_dirs(folder), key=lambda p: (0, int(p.name), "") if p.name.isdigit() else (1, 0, p.name))


class TempLog:
    """One log dataset in temp."""

    def __init__(self, name: str, title: str, spec: Any, description: str) -> None:
        self.name, self.title, self.spec, self.description = name, title, spec, description
        self._row: Any = None  # the indexed row, once found: one DB lookup per log, not per append

    def folder(self) -> Path:
        return temp_datasets() / self.name

    def _create(self) -> None:
        manifest = self.folder() / "dataset.json"
        if manifest.exists():
            return
        self.folder().mkdir(parents=True, exist_ok=True)
        metadata = {"title": self.title, "description": self.description, "data_layout": "io_folder", "spec": self.spec}
        manifest.write_text(json.dumps({"metadata": metadata, "data": {}}, indent=2) + "\n")

    async def indexed(self) -> Any:
        """The log as the index holds it (no rows read) -- None before its first row."""
        from flow_sdk.builtin.dataset import Dataset  # noqa: PLC0415

        here = self.folder().resolve()  # the index stores the resolved path (/private/var/... on macOS)
        if self._row is not None and Path(self._row.asset_ref).resolve() == here and here.is_dir():
            return self._row
        found = await Dataset.get_all({"name": self.title})
        self._row = next((r for r in found if getattr(r, "asset_ref", None) and Path(r.asset_ref).resolve() == here), None)
        return self._row

    async def dataset(self) -> Any:
        """The log, created on first use: the indexed row when there is one, else the folder (no DB)."""
        from flow_sdk.builtin.dataset import Dataset  # noqa: PLC0415

        indexed = await self.indexed()
        if indexed is not None:
            return indexed
        self._create()
        return Dataset.at(self.folder())

    async def append(self, row: dict, *, max_rows: Optional[int] = None) -> Optional[str]:
        """Append one row; the new example id, else None. Never raises."""
        from flow_sdk.builtin.dataset import Dataset  # noqa: PLC0415
        from flow_sdk.fs_store.resolve import index_one, resolve_asset  # noqa: PLC0415

        try:
            async with _lock(self.name):
                indexed = await self.indexed()
                if indexed is None or getattr(indexed, "scope", None) != "system":
                    # The first row (or a row indexed as the user's before temp was system): index it once,
                    # so the UI lists the log. The temp folder classifies as system, so it is listed under
                    # the system project and not in every user project.
                    self._create()
                    try:
                        await index_one(await resolve_asset(self.folder(), write=True), notify=True)
                    except Exception as exc:  # noqa: BLE001 -- no index (no DB): the folder alone takes the row
                        logger.debug("%s: not indexed: %s", self.title, exc)
                    self._row = None
                    indexed = await self.indexed()
                ds = indexed or Dataset.at(self.folder())
                [row_id] = await ds.append([row])
                if max_rows is not None:
                    held = rows(self.folder())
                    if len(held) > max_rows:
                        ds.delete_rows([d.name for d in held[: len(held) - max_rows]])
                if indexed is not None:
                    # Only the counts change, and they follow from the cheap per-example index: a full
                    # re-index re-parses every row, which would make each append O(rows).
                    await indexed.refresh_counts()
            return row_id
        except Exception as exc:  # noqa: BLE001 -- a log must never break what it logs
            logger.warning("%s: could not append: %s", self.title, exc)
            return None

    def append_soon(self, row: dict, *, max_rows: Optional[int] = None) -> None:
        """``append`` in the background -- the caller has its answer already."""
        spawn(self.append(row, max_rows=max_rows))


__all__ = ["TempLog", "drain", "rows", "spawn", "temp_datasets"]
