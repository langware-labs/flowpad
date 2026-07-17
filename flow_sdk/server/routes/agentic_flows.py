"""AgenticFlow routes — single owner under ``/api/v1/agentic-flows/*``.

* ``POST /<flow_id>/inject`` — deliver an event into a flow. Body:
  ``{"event", "data"?, "execution_id"?, "source_node"?, "target_node"?}``.
  ``execution_id`` + ``source_node`` is how subprocess functions emit back
  into their run; ``target_node`` delivers directly, bypassing edge routing.
* ``GET  /<flow_id>/runs`` — recent runs (AgenticFlowRun rows, newest first).
* ``GET  /<flow_id>/runs/<run_id>`` — the run's full journal entries.
* ``POST /<flow_id>/runs/<run_id>/replay`` — re-inject the run's recorded
  ENTRY events into a fresh run (a real re-execution — side effects re-fire).
* ``POST /<flow_id>/reexecute`` ``{"run_id", "seq"}`` — re-deliver one past
  execution's recorded input to its node, in a fresh run.
* ``GET  /functions`` — the FlowFunction registry (Function-picker feed).

graph.json / display.json read+write go through the standard asset/FSRef
surface — no bespoke graph REST here.
"""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Request

from flow_sdk.flow_manager import get_flow_manager
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

router = APIRouter(prefix="/api/v1/agentic-flows")


@router.get("/functions")
async def functions():
    from flow_sdk.flow_manager import flow_functions

    return ApiSuccessResponse(data=flow_functions.list_registered())


@router.post("/{flow_id}/inject")
async def inject(flow_id: str, request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    event = (body or {}).get("event")
    if not event:
        return ApiFailResponse(message="event is required")
    data = body.get("data") or {}
    if not isinstance(data, dict):
        return ApiFailResponse(message="data must be an object")
    try:
        fe = await get_flow_manager().inject(
            flow_id,
            str(event),
            data,
            execution_id=body.get("execution_id") or None,
            source_node=body.get("source_node") or "$external",
            target_node=body.get("target_node") or None,
        )
    except ValueError as e:
        return ApiFailResponse(message=str(e))
    return ApiSuccessResponse(data=fe.model_dump(mode="json") if fe else None)


@router.get("/{flow_id}/runs")
async def runs(flow_id: str):
    from flow_sdk.builtin.agentic_flow_run import AgenticFlowRun

    rows = await AgenticFlowRun.get_all({"flow_id": flow_id})
    rows.sort(key=lambda r: r.started_at or "", reverse=True)
    return ApiSuccessResponse(data=[
        r.model_dump(mode="json", include={
            "id", "flow_id", "status", "started_at", "ended_at",
            "event_count", "execution_count", "error",
        })
        for r in rows[:50]
    ])


@router.post("/{flow_id}/runs/{run_id}/replay")
async def replay(flow_id: str, run_id: str):
    try:
        new_run_id = await get_flow_manager().replay_run(flow_id, run_id)
    except ValueError as e:
        return ApiFailResponse(message=str(e))
    return ApiSuccessResponse(data={"run_id": new_run_id})


@router.post("/{flow_id}/reexecute")
async def reexecute(flow_id: str, request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    run_id = str((body or {}).get("run_id") or "")
    seq = (body or {}).get("seq")
    if not run_id or not isinstance(seq, int):
        return ApiFailResponse(message="run_id and integer seq are required")
    try:
        new_run_id = await get_flow_manager().reexecute(flow_id, run_id, seq)
    except ValueError as e:
        return ApiFailResponse(message=str(e))
    return ApiSuccessResponse(data={"run_id": new_run_id})


@router.get("/{flow_id}/runs/{run_id}")
async def run_journal(flow_id: str, run_id: str):
    from flow_sdk.builtin.agentic_flow import AgenticFlow
    from flow_sdk.flow_manager.journal import read_run_journal

    flow = await AgenticFlow.get_by_id(flow_id)
    if flow is None or not flow.asset_ref:
        return ApiFailResponse(message=f"Unknown flow: {flow_id}")
    return ApiSuccessResponse(data=read_run_journal(Path(flow.asset_ref), run_id))
