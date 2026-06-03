"""Docs knowledge-graph route — native LLMIndexer scan → {nodes, edges}.

``GET /api/v1/docs-graph?root=<path>`` runs a structural (no-LLM) scan of a docs
tree and returns nodes/edges in the dep-graph format (``flow_sdk/dep_graph``).
Scan progress is emitted through the shared ``progress_report`` envelope — the
same one the fs-records scan and the footer pill use — so no new WS channel is
introduced.
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query

from flow_sdk.builtin.faas.in_process_activity import InProcessActivity
from flow_sdk.core.network.resource_tracker import broadcast_progress
from flow_sdk.fs_store.indexer import IndexProgressTable, TypeProgressRow
from flow_sdk.llm_index import LLMIndexer, typeid_for
from flow_sdk.llm_index.indexer import ScanTick

logger = logging.getLogger(__name__)
router = APIRouter()

# Must be a recognised SystemActivity (the footer IndexerStatusPill labels the
# progress_report by job_name). A docs scan is a scan; reuse that activity.
_JOB = "scan"


def _resolve_root(root: str) -> Path:
    """Resolve the ``root`` query arg (a docs-root filesystem path) to a directory."""
    path = Path(root.strip()).expanduser()
    try:
        path = path.resolve()
    except OSError:
        pass
    if not path.is_dir():
        raise HTTPException(status_code=404, detail=f"Not a directory: {root}")
    return path


async def _emit(
    activity: InProcessActivity,
    *,
    folders: int,
    files: int,
    current: str | None,
    complete: bool = False,
) -> None:
    activity.latest_table = IndexProgressTable(
        job_name=_JOB,
        rows=(TypeProgressRow(type_name="markdown", done=files, total=0),),
        current=None if complete else current,
        done=files,
        total=0,
        text="complete" if complete else None,
        ts=datetime.now(timezone.utc).isoformat(),
    )
    await broadcast_progress(to_entity=activity.entity_id, flow_data=activity.make_flow_data())


@router.get("/api/v1/docs-graph")
async def docs_graph(root: str = Query(...)) -> dict:
    """Native scan of ``root`` → ``{nodes, edges, counts, duration_ms}``."""
    root_path = _resolve_root(root)
    activity = InProcessActivity(job_name=_JOB, entity_id=typeid_for(root_path))

    # Plain counters mutated by the (sync) scan thread; the async pump reads them
    # and broadcasts — no cross-thread event-loop access.
    counter = {"folders": 0, "files": 0, "current": "", "done": False}

    def on_tick(tick: ScanTick) -> None:
        counter["folders"] = tick.folders_seen
        counter["files"] = tick.files_seen
        counter["current"] = tick.current

    async def pump() -> None:
        last = -1
        while not counter["done"]:
            await asyncio.sleep(0.2)
            if counter["files"] != last:
                last = counter["files"]
                await _emit(
                    activity,
                    folders=counter["folders"],
                    files=counter["files"],
                    current=str(counter["current"]),
                )

    await _emit(activity, folders=0, files=0, current=str(root_path))
    pump_task = asyncio.create_task(pump())
    started = time.perf_counter()
    try:
        graph = await asyncio.to_thread(
            lambda: LLMIndexer(root_path).scan(on_tick=on_tick).to_graph()
        )
    finally:
        counter["done"] = True
        await pump_task
    await _emit(
        activity,
        folders=counter["folders"],
        files=counter["files"],
        current=None,
        complete=True,
    )

    graph["duration_ms"] = round((time.perf_counter() - started) * 1000, 1)
    return {"status": "SUCCESS", "message": "success", "data": graph}
