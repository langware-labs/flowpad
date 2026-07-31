"""Runs — one list of what ran, and one way to read what it produced.

Eight surfaces showed a run before this, none of them a destination: every list
was keyed on the entity that SPAWNED the run, so a run with no spawning entity
— an ingest driver's worker, an agent launched from its profile — was
unreachable from the UI at all.

Centred on ``AgenticProcess`` deliberately. A flow run looks like the natural
unit, but ``GraphWorkflowRun`` is pruned to ``retention_runs`` (5) per flow and
takes its child rows, record dir and journal with it, so flow-run history barely
exists. Processes are the unbounded, universal record; a flow run is a grouping
over them, which is what ``context_data.flow_run_id`` now expresses.

**The list projection is deliberate.** ``AgenticProcess.api_json_serializer``
reads the transcript tail off disk per row and materializes up to four folders;
at 50 rows that is 50 file reads and 200 mkdirs to draw a list. This builds rows
from stored fields only.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter

from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/runs")

#: Page size. No virtualization exists in this UI, so the list is paged rather
#: than unbounded.
DEFAULT_LIMIT = 50
MAX_LIMIT = 200


def _badge(process) -> str:
    """One vocabulary for the list, from the lifecycle axis.

    `ProcessStatus` and `RunStatus` are the same axis and share `running` /
    `failed` verbatim; `WorkerStatus` is explicitly a different one ("what we
    found in the transcript") and is NOT consulted here — reading it is what
    makes the full serializer expensive.
    """
    from flow_sdk.builtin.process_lifecycle import ProcessStatus  # noqa: PLC0415

    if getattr(process, "start_failure", None):
        return "failed"
    status = str(getattr(process, "status", "") or "")
    if status == ProcessStatus.FAILED.value:
        return "failed"
    if status in (ProcessStatus.NEW.value,):
        return "queued"
    if status in (ProcessStatus.STARTING.value, ProcessStatus.RUNNING.value,
                  ProcessStatus.STOPPING.value):
        return "running"
    exit_code = getattr(process, "exit_code", None)
    return "done" if exit_code in (0, None) else "failed"


def _row(process) -> dict[str, Any]:
    context = getattr(process, "context_data", None) or {}
    return {
        "id": process.id,
        "name": process.name or "",
        # What was asked. The list is unreadable without it — a run identified
        # only by an id prefix tells you nothing about whether it is the one.
        "prompt": (str(getattr(process, "instruction_content", "") or "")[:280]),
        "badge": _badge(process),
        "status": str(getattr(process, "status", "") or ""),
        "started_at": str(getattr(process, "created_date", "") or ""),
        "updated_at": str(getattr(process, "updated_date", "") or ""),
        "agent": context.get("launched_by_agent") or "",
        "flow_run_id": context.get("flow_run_id") or None,
        "flow_id": context.get("flow_id") or None,
        "node_id": context.get("node_id") or None,
        "deployment_id": getattr(process, "deployment_id", None) or None,
        "project_id": getattr(process, "project_id", None) or None,
        "session_id": getattr(process, "session_id", None) or None,
        "start_failure": getattr(process, "start_failure", None) or None,
        "cost_usd": getattr(process, "total_cost_usd", None),
    }


@router.get("")
async def list_runs(limit: int = DEFAULT_LIMIT, offset: int = 0,
                    agent: Optional[str] = None, flow_run_id: Optional[str] = None,
                    project_id: Optional[str] = None):
    """Recent runs, newest first.

    Ordered by ``created_date`` — a real column, so ORDER BY and LIMIT are
    pushed to SQL. Ordering on a JSON field instead would load every process
    row into Python before slicing.
    """
    from flow_sdk.builtin.agentic_process import AgenticProcess  # noqa: PLC0415

    bounded = max(1, min(int(limit or DEFAULT_LIMIT), MAX_LIMIT))
    match: dict[str, Any] = {}
    if project_id:
        match["project_id"] = project_id
    if flow_run_id:
        match["context_data.flow_run_id"] = flow_run_id
    if agent:
        match["context_data.launched_by_agent"] = agent

    try:
        rows = await AgenticProcess.get_all({
            "match": match,
            "order_by": {"created_date": "desc"},
            "limit": bounded,
            "offset": max(0, int(offset or 0)),
        })
    except Exception as exc:  # noqa: BLE001 — a list must not 500 the app
        logger.exception("runs: list failed")
        return ApiFailResponse(message=f"could not list runs: {exc}")

    return ApiSuccessResponse(data={
        "runs": [_row(r) for r in rows],
        "limit": bounded,
        "offset": max(0, int(offset or 0)),
    })


@router.get("/{process_id}")
async def get_run(process_id: str):
    """One run's detail, plus its artifacts."""
    from flow_sdk.builtin.agentic_process import AgenticProcess  # noqa: PLC0415
    from flow_sdk.server.routes.artifacts import artifacts_for_record  # noqa: PLC0415

    process = await AgenticProcess.get_by_id(process_id)
    if process is None:
        return ApiFailResponse(message=f"no run {process_id}")

    detail = _row(process)
    detail["instruction"] = str(getattr(process, "instruction_content", "") or "")
    detail["workdir"] = str(getattr(process, "workdir", "") or "")
    detail["worker_type"] = str(getattr(process, "worker_type", "") or "")
    detail["executions"] = artifacts_for_record("agentic_process", process_id)
    return ApiSuccessResponse(data=detail)


@router.get("/{process_id}/artifact")
async def get_run_artifact(process_id: str, key: str, name: str):
    """Read one of a run's files. ``key`` must come from the detail listing."""
    from flow_sdk.server.routes.artifacts import read_artifact  # noqa: PLC0415

    found = read_artifact("agentic_process", process_id, key, name)
    if found is None:
        return ApiFailResponse(message=f"no such artifact: {name}")
    if isinstance(found, str):
        return ApiFailResponse(message=found)
    return ApiSuccessResponse(data=found)


def run_record_path(process_id: str) -> Path:
    from flow_sdk.fs_store.record_paths import shadow_dir_for  # noqa: PLC0415

    return shadow_dir_for("agentic_process", process_id)
