"""``POST /api/v1/shell/belonging-to`` — the terminal a thing has (``Shell.belonging_to``).

A class-level lookup, so it is not an action on one shell: whoever needs "the terminal of X"
(the code editor's Run terminal, a view with a terminal of its own) asks here by X's natural name
and gets the shell — the one it had, else a new one — with a live PTY.
"""

from __future__ import annotations

from fastapi import APIRouter

from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse
from flow_sdk.core.shell_request import ShellBelongingToRequest

router = APIRouter()




@router.post("/api/v1/shell/belonging-to")
async def shell_belonging_to(req: ShellBelongingToRequest):
    from flow_sdk.builtin.shell import Shell  # noqa: PLC0415

    if not req.what.strip():
        return ApiFailResponse(message="what is required")
    try:
        shell = await Shell.belonging_to(req.what, workdir=req.workdir, name=req.name)
    except RuntimeError as exc:
        return ApiFailResponse(message=str(exc))
    return ApiSuccessResponse(data=shell.model_dump(mode="json"))
