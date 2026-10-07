"""The REST surface of a ``DiagnosisRequest`` — what the request's asset screen calls.

Open one (``open_request``), change one (``edit``), list what may fund one (``funding_sources``),
send it more (``attachments``), and read back what was written into one (``runs``). Each is a thin door onto ``builtin/diagnosis_request.py``;
the hub calls happen there, server-side, so the page never sees a hub URL or a key.
"""

from __future__ import annotations

from fastapi import HTTPException
from pydantic import ValidationError

from flow_sdk.actions import action
from flow_sdk.cloud_client.shared.errors import HubError
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiSuccessResponse
from flow_sdk.schema.data_spec.diagnosis_request_spec import (
    DiagnosisAttachmentSpec,
    DiagnosisRequestEditSpec,
    DiagnosisRequestOpenSpec,
)
from flow_sdk.schema.types import EntityType

_TYPES = [EntityType.DIAGNOSIS_REQUEST.value]


async def _request():
    """The addressed ``DiagnosisRequest``, or a 404."""
    from flow_sdk.builtin.diagnosis_request import DiagnosisRequest  # noqa: PLC0415

    info = get_current_request_info()
    target = getattr(getattr(info, "auth_result", None), "target", None)
    if isinstance(target, DiagnosisRequest):
        return target
    entity = await DiagnosisRequest.get_by_typeid(info.target_entity_typeid) if info else None
    if entity is None:
        raise HTTPException(status_code=404, detail="diagnosis_request not found")
    return entity


@action.post(action_name="open_request", types=_TYPES)
async def open_request_action():
    """``POST /graph/diagnosis_request/open_request`` ``DiagnosisRequestOpenSpec`` -> the request and
    the command to send. Needs a hub login: the request lives on the hub."""
    from flow_sdk.builtin.diagnosis_request import DiagnosisRequest  # noqa: PLC0415

    info = get_current_request_info()
    body = await info.get_post_data() if info else None
    try:
        spec = DiagnosisRequestOpenSpec.model_validate(body or {})
    except ValidationError as e:
        raise HTTPException(status_code=400, detail=str(e))
    try:
        request = await DiagnosisRequest.open(spec, info.someone_typeid if info else None)
    except HubError as e:
        return e.fail_response("Could not open the diagnosis request")
    except (RuntimeError, ValueError) as e:  # signed out (``share``), or an unusable local key
        raise HTTPException(status_code=400, detail=str(e))
    return ApiSuccessResponse(data={"request": request, "command": request.command})


@action.post(action_name="edit", types=_TYPES)
async def edit_action():
    """``POST /graph/diagnosis_request/<id>/edit`` ``DiagnosisRequestEditSpec`` -> the request."""
    request = await _request()
    info = get_current_request_info()
    try:
        spec = DiagnosisRequestEditSpec.model_validate((await info.get_post_data() if info else None) or {})
    except ValidationError as e:
        raise HTTPException(status_code=400, detail=str(e))
    try:
        return ApiSuccessResponse(data=await request.edit(spec))
    except HubError as e:
        return e.fail_response("Could not change the diagnosis request")
    except ValueError as e:  # an unusable local key
        raise HTTPException(status_code=400, detail=str(e))


@action.get(action_name="funding_sources", types=_TYPES)
async def funding_sources_action():
    """``GET /graph/diagnosis_request/funding_sources`` -> ``{hub: [...], local_keys: [...]}``."""
    from flow_sdk.builtin.diagnosis_request import funding_sources  # noqa: PLC0415

    try:
        return ApiSuccessResponse(data=await funding_sources())
    except HubError as e:
        return e.fail_response("Could not list funding sources")


@action.get(action_name="runs", types=_TYPES)
async def runs_action():
    """``GET /graph/diagnosis_request/<id>/runs`` lists the kept runs; ``runs/<n>`` returns one whole."""
    request = await _request()
    info = get_current_request_info()
    sub_path = ((info.sub_path if info else "") or "").strip("/")
    if sub_path and not sub_path.isdigit():
        raise HTTPException(status_code=400, detail="runs/<n>: n must be a run number")
    try:
        return ApiSuccessResponse(data=await request.runs(int(sub_path) if sub_path else None))
    except HubError as e:
        return e.fail_response("Could not read the runs")


@action.all(action_name="attachments", methods=["get", "post"], types=_TYPES)
async def attachments_action():
    """``GET /graph/diagnosis_request/<id>/attachments`` lists what the runner will receive;
    ``POST`` ``DiagnosisAttachmentSpec`` sends one more (a file, or an asset such as a skill)."""
    request = await _request()
    info = get_current_request_info()
    try:
        if info is not None and info.method.upper() == "POST":
            try:
                spec = DiagnosisAttachmentSpec.model_validate(await info.get_post_data() or {})
            except ValidationError as e:
                raise HTTPException(status_code=400, detail=str(e))
            try:
                await request.attach(spec)
            except ValueError as e:  # an asset with nothing on disk to send
                raise HTTPException(status_code=400, detail=str(e))
        return ApiSuccessResponse(data=await request.attachments())
    except HubError as e:
        return e.fail_response("Could not reach the request's attachments")
