"""``Folder`` — a watched directory as a block: the object-shaped sibling of ``Inbox``.

A view over the ``folder`` ``DataSource`` for that directory (found or created by its root, the
driver's natural key), exactly as ``Inbox`` is a view over a mailbox's source. ``listen()`` pages
the ``SourceChange`` rows reflection writes, in ingest order, from this workflow's position, and
yields one ``FolderChange`` per page with the same ``ack()`` an inbox item carries.

**A folder consumer starts from the beginning, not from now.** An inbox yields arrivals — a
mailbox's history is not something to reply to — but a search index has to see the tree once,
so the position is created with no baseline and the first page is the source's first sync,
which reports every file as added.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import AsyncIterator

from flow_sdk.blocks.delivery import Delivered
from flow_sdk.schema.data_spec.folder_change_spec import FolderChange


class Folder:
    def __init__(
        self,
        root: str,
        *,
        name: str = "",
        reflect: str = "none",
        mirror_to: str = "",
    ):
        """*root* is the directory to watch. ``mirror_to`` copies it into another tree
        (``reflect="copy"`` under the hood); the default indexes it where it sits."""
        self.root = str(Path(root).expanduser().resolve())
        self.name = name
        self.reflect = "copy" if mirror_to else reflect
        self.mirror_to = str(Path(mirror_to).expanduser().resolve()) if mirror_to else ""
        self._source = None

    async def _ensure_source(self):
        if self._source is not None:
            return self._source
        from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415

        existing = await DataSource.find_for_account("folder", "root", self.root)
        if existing is not None:
            self._source = existing
            return existing
        source = DataSource(
            name=self.name or f"Folder {Path(self.root).name}",
            provider="folder",
            config={"root": self.root},
            reflect=self.reflect,
            reflect_into=self.mirror_to,
        )
        await source.save()
        self._source = source
        return source

    async def sync(self):
        """One cycle now: enumerate → reflect → reindex → one ``SourceChange`` if anything moved."""
        return await (await self._ensure_source()).sync()

    async def listen(
        self,
        *,
        poll_every: "float | timedelta | None" = None,
        page: int = 50,
    ) -> AsyncIterator["Delivered[FolderChange]"]:
        """Async-iterate change pages as they land, each with an ``ack()``.

        Same loop as ``Inbox.listen``: poll through the poller's slot, then drain from the
        consumer's position — durable inside a named ``workflow()``, in-memory outside one. A
        page handed out and never acked is yielded again after a restart with
        ``redelivered=True``.
        """
        from flow_sdk.blocks import _cadence, current_workflow  # noqa: PLC0415
        from flow_sdk.builtin.consumer_position import ConsumerPosition, key_of  # noqa: PLC0415
        from flow_sdk.builtin.source_change import SourceChange  # noqa: PLC0415
        from flow_sdk.ingest.driver import get_driver  # noqa: PLC0415
        from flow_sdk.ingest.poller import poll_source  # noqa: PLC0415

        source = await self._ensure_source()
        position = await ConsumerPosition.ensure_for(current_workflow.get(), str(source.id), baseline=None)
        cadence = _cadence(poll_every, get_driver("folder"))
        last_seen = position.watermark()
        in_flight_at_start = position.in_flight_key()

        while True:
            await poll_source(source, datetime.now(timezone.utc))
            while True:
                rows = await SourceChange.page_after(str(source.id), last_seen, limit=page)
                if not rows:
                    break
                for row in rows:
                    key = key_of(row)
                    last_seen = key
                    redelivered = in_flight_at_start is not None and key <= in_flight_at_start
                    if position.mark_in_flight(row):
                        await position.commit()
                    change = FolderChange(
                        source_id=str(source.id), root=self.root,
                        added=list(row.added), changed=list(row.changed),
                        removed=list(row.removed), renamed=dict(row.renamed),
                    )
                    yield Delivered(change, position=position, row=row, source_id=str(source.id), redelivered=redelivered)
            await asyncio.sleep(cadence)


__all__ = ["Folder", "FolderChange"]
