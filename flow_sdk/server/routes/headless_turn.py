"""``POST /api/v1/agentic_process/headless-turn`` -- ``flow process start`` run inside the live backend.

The CLI asks for this whenever a backend is up for its instance, so the process row is written by
the server's own SQLite connection rather than by a second process beside it. The answer streams
back as NDJSON, one ``flow_sdk.core.headless_turn`` event per line.
"""

from __future__ import annotations

import json
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel
from starlette.responses import StreamingResponse

from flow_sdk.core.headless_turn import headless_turn

router = APIRouter()


class HeadlessTurnRequest(BaseModel):
    prompt: str
    worker: Optional[str] = None
    model: Optional[str] = None
    workdir: Optional[str] = None
    llm: Optional[str] = None  # an endpoint typeid; the CLI resolves row numbers and names first


@router.post("/api/v1/agentic_process/headless-turn")
async def run_headless_turn(body: HeadlessTurnRequest) -> StreamingResponse:
    async def lines():
        try:
            async for event in headless_turn(
                body.prompt,
                worker_type=body.worker,
                model=body.model,
                workdir=body.workdir,
                endpoint_typeid=body.llm,
            ):
                yield json.dumps(event) + "\n"
        except Exception as exc:  # noqa: BLE001 -- the stream has started; the error is the last event
            yield json.dumps({"kind": "done", "ok": False, "exit_code": 1, "text": "", "detail": str(exc)}) + "\n"

    return StreamingResponse(lines(), media_type="application/x-ndjson")
