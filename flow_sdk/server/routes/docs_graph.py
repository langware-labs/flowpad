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
import subprocess
import time
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query

from flow_sdk.activity import Activity
from flow_sdk.builtin.faas.in_process_activity import InProcessActivity
from flow_sdk.core.network.resource_tracker import broadcast_progress
from flow_sdk.fs_store.indexer import PROGRESS_TEXT_COMPLETE, IndexProgressTable, TypeProgressRow
from flow_sdk.fs_store.operations.markdown_index import (
    entity_data_dir,
    entity_id_for_root,
    file_summaries_dir,
)
from flow_sdk.llm_index import LLMIndexer, typeid_for
from flow_sdk.llm_index.diff import MAX_DIFF_BYTES, git_unified_diff, is_binary_bytes
from flow_sdk.llm_index.indexer import ScanTick

logger = logging.getLogger(__name__)
router = APIRouter()

# Must be a recognised SystemActivity (the footer IndexerStatusPill labels the
# progress_report by job_name). A docs scan is a scan; reuse that activity.
_JOB = "scan"

# Stamp is an explicit user action; serialize concurrent stamps per root.
_stamp_locks: dict[str, asyncio.Lock] = {}


def _indexer(root_path: Path) -> LLMIndexer:
    """LLMIndexer wired to this vault's per-entity data dir (baseline + blobs).

    Same entity id the rest of the system uses for the vault: uuid5 of the
    resolved root path, via the shared ``entity_id_for_root`` derivation.
    """
    entity_uuid = entity_id_for_root(root_path)
    base = entity_data_dir(entity_uuid)
    return LLMIndexer(
        # Shared with the LLM rebuild flow — its per-file summaries (content-
        # addressed) get carried into stamped baselines and onto graph edges.
        summaries_dir=file_summaries_dir(entity_uuid),
        baseline_dir=base / "baseline",
        blobs_dir=base / "blobs",
    )


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
    activity.set_table(
        IndexProgressTable(
            job_name=_JOB,
            rows=(TypeProgressRow(type_name="markdown", done=files, total=0),),
            current=None if complete else current,
            done=files,
            total=0,
            text=PROGRESS_TEXT_COMPLETE if complete else None,
            ts=datetime.now(timezone.utc).isoformat(),
        )
    )
    await broadcast_progress(to_entity=activity.entity_id, flow_data=activity.make_flow_data())


@router.get("/api/v1/docs-graph/doc")
async def docs_graph_doc(root: str = Query(...), rel: str = Query(...)) -> dict:
    """Read one markdown doc under the scanned root (for the Atlas reading
    drawer). ``rel`` is the node's ``rel_path``; paths escaping ``root`` 403."""
    root_path = _resolve_root(root)
    target = (root_path / rel).resolve()
    if target != root_path and not target.is_relative_to(root_path):
        raise HTTPException(status_code=403, detail="path escapes root")
    if not target.is_file():
        raise HTTPException(status_code=404, detail=f"Not a file: {rel}")
    text = await asyncio.to_thread(
        lambda: target.read_text(encoding="utf-8", errors="replace")
    )
    from flow_sdk.llm_index import MarkdownDocument  # noqa: PLC0415

    doc = MarkdownDocument.from_text(text, path=target)
    return {
        "status": "SUCCESS",
        "message": "success",
        "data": {"title": doc.title, "content": text, "rel_path": rel},
    }


@router.post("/api/v1/docs-graph/stamp")
async def docs_graph_stamp(root: str = Query(...)) -> dict:
    """Stamp the vault's baseline (native, no LLM) into the entity data dir.

    Explicit user action only — never called automatically. Idempotent; also
    stores content blobs (CAS) for later line diffs and GC's orphans.
    """
    root_path = _resolve_root(root)
    lock = _stamp_locks.setdefault(str(root_path), asyncio.Lock())
    async with lock:
        stats = await asyncio.to_thread(
            lambda: _indexer(root_path).scan(root_path).stamp()
        )
    return {"status": "SUCCESS", "message": "success", "data": asdict(stats)}


@router.get("/api/v1/docs-graph/changes")
async def docs_graph_changes(root: str = Query(...)) -> dict:
    """Manifest diff since the last stamp: added/removed/modified/renamed."""
    root_path = _resolve_root(root)
    changes = await asyncio.to_thread(
        lambda: _indexer(root_path).scan(root_path).diff_since_baseline()
    )
    return {"status": "SUCCESS", "message": "success", "data": changes}


@router.get("/api/v1/docs-graph/diff")
async def docs_graph_diff(root: str = Query(...), rel: str = Query(...)) -> dict:
    """Line diff of one doc vs its stamped baseline, as a git-style unified
    diff string (the UI's gitdiff-parser requires the ``diff --git`` header).

    Old text: CAS blob → ``git show HEAD:./<rel>`` → empty (renders as added).
    """
    root_path = _resolve_root(root)
    target = (root_path / rel).resolve()
    if target != root_path and not target.is_relative_to(root_path):
        raise HTTPException(status_code=403, detail="path escapes root")

    def _build() -> dict:
        idx = _indexer(root_path)  # baseline_file/blob_path need no scan
        old_text = ""
        baseline = idx.baseline_file(rel)
        if baseline is not None:
            blob = idx.blob_path(baseline.content_hash)
            if blob.is_file():
                old_bytes = blob.read_bytes()
                if len(old_bytes) > MAX_DIFF_BYTES or is_binary_bytes(old_bytes):
                    return {"diff": "", "skipped": "binary_or_large", "rel_path": rel}
                old_text = old_bytes.decode("utf-8", "replace")
            else:
                proc = subprocess.run(
                    ["git", "-C", str(root_path), "show", f"HEAD:./{rel}"],
                    capture_output=True,
                    timeout=10,
                )
                if proc.returncode == 0:
                    old_text = proc.stdout.decode("utf-8", "replace")
        new_text = ""
        if target.is_file():
            new_bytes = target.read_bytes()
            if len(new_bytes) > MAX_DIFF_BYTES or is_binary_bytes(new_bytes):
                return {"diff": "", "skipped": "binary_or_large", "rel_path": rel}
            new_text = new_bytes.decode("utf-8", "replace")
        return {
            "diff": git_unified_diff(rel, old_text, new_text),
            "skipped": None,
            "rel_path": rel,
        }

    data = await asyncio.to_thread(_build)
    return {"status": "SUCCESS", "message": "success", "data": data}


@router.get("/api/v1/docs-graph")
async def docs_graph(root: str = Query(...)) -> dict:
    """Native scan of ``root`` → ``{nodes, edges, counts, duration_ms}``."""
    root_path = _resolve_root(root)
    # ``job_name`` stays "scan" so the legacy footer pill still labels it; the ACTIVITY
    # names itself honestly, so a docs scan and a real index no longer share one address.
    activity = InProcessActivity(
        job_name=_JOB,
        entity_id=typeid_for(root_path),
        # ``job_name`` stays "scan" so the legacy footer pill still labels it; the ACTIVITY
        # names itself honestly, so a docs scan and a real index no longer share an address.
        activity=Activity.get("docs.scan", scope=typeid_for(root_path)),
    )

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
            lambda: _indexer(root_path).scan(root_path, on_tick=on_tick).to_graph()
        )
    except BaseException:
        # Without this the activity never reaches a terminal state, so the monitor keeps a
        # permanently "running" root per scanned folder and the chip reports work that
        # stopped. The terminal table is only sent on the happy path below.
        if activity.activity is not None:
            activity.activity.fail("docs scan failed")
        raise
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
