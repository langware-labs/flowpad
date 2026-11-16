"""The failed hub calls this backend recorded since it started — ``/api/v1/network-errors``.

* ``GET``    — every recorded failure, shown or silent (Logs → Network errors).
* ``DELETE`` — forget them.

The record is memory only (``cloud_client/error_reporter``); a restart starts it empty.
"""

from __future__ import annotations

from fastapi import APIRouter

from flow_sdk.cloud_client.error_reporter import hub_error_reporter
from flow_sdk.responses.response import ApiSuccessResponse

router = APIRouter(prefix="/api/v1/network-errors")


@router.get("")
async def list_network_errors():
    return ApiSuccessResponse(data={"entries": [e.model_dump(mode="json") for e in hub_error_reporter.entries()]})


@router.delete("")
async def clear_network_errors():
    hub_error_reporter.clear()
    return ApiSuccessResponse(data={"entries": []})
