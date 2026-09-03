"""SemanticLock checker route — batch entry over mixed typeids.

``POST /api/v1/semantic-checker {"type_ids": [...]}`` runs the deterministic
checker (flow_sdk/semantic_lock) over every dependson edge reachable from the
given ids — a lock id contributes its outgoing edges, anything else its
governing locks. Flag-only: verdicts land on the relationship rows and as
``lock_break`` Annotations; targets are never written.

Per-entity operations (``semantic-status`` / ``semantic-waive``) are generic
entity actions registered in core/entity/entity_model.py, not routes.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException

from flow_sdk.activity import Activity
from flow_sdk.builtin.faas.in_process_activity import InProcessActivity
from flow_sdk.core.network.resource_tracker import broadcast_progress
from flow_sdk.fs_store.indexer import PROGRESS_TEXT_COMPLETE, IndexProgressTable, TypeProgressRow
from flow_sdk.semantic_lock.runner import run_semantic_checker

logger = logging.getLogger(__name__)
router = APIRouter()

# Footer pill labels the progress_report by job_name — must stay a recognised
# SystemActivity (same reuse as docs_graph).
_JOB = "scan"


async def _emit(activity: InProcessActivity, *, done: int, total: int, complete: bool = False) -> None:
    activity.set_table(
        IndexProgressTable(
            job_name=_JOB,
            rows=(TypeProgressRow(type_name="dependson", done=done, total=total),),
            current=None if complete else "semantic check",
            done=done,
            total=total,
            text=PROGRESS_TEXT_COMPLETE if complete else None,
            ts=datetime.now(timezone.utc).isoformat(),
        )
    )
    await broadcast_progress(to_entity=activity.entity_id, flow_data=activity.make_flow_data())


@router.post("/api/v1/semantic-checker")
async def semantic_checker(body: dict) -> dict:
    type_ids = (body or {}).get("type_ids")
    if not isinstance(type_ids, list) or not type_ids:
        raise HTTPException(status_code=422, detail="type_ids (non-empty list) is required")
    activity = InProcessActivity(
        job_name=_JOB,
        entity_id=str(type_ids[0]),
        # The legacy ``job_name`` is what the old pill recognises; the activity path is
        # what this job actually is. Its terminal emit is in a `finally` below, so the
        # activity cannot be left running when the check raises.
        activity=Activity.get("semantic.check", scope=str(type_ids[0])),
    )
    await _emit(activity, done=0, total=0)

    async def on_progress(done: int, total: int) -> None:
        await _emit(activity, done=done, total=total)

    try:
        summary = await run_semantic_checker([str(t) for t in type_ids], on_progress=on_progress)
    finally:
        await _emit(activity, done=0, total=0, complete=True)
    return {"status": "SUCCESS", "message": "success", "data": summary}
