"""Answer a form on a message (``message_form_spec``).

``POST /graph/conversation/<id>/form-answer`` — body ``{message_id, values}`` (JSON, or multipart
with ``values`` as JSON text plus ``files`` when a ``file`` field uploaded something):
checks ``values`` against the form, fills the defaults the receiver kept, and posts ONE reply
carrying the ``FormAnswers`` (plus any files a ``file`` field uploaded). Answering again is a
change: a new reply whose ``changed`` is measured against the previous answers.
"""

from __future__ import annotations

import json
from json import JSONDecodeError
from typing import Any, Optional

from flow_sdk.actions import action
from flow_sdk.app.actions.process_call_action import _conversation_request
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse
from flow_sdk.schema.data_spec.message_form_spec import (
    FormAnswers,
    answers_attachment,
    answers_in,
    changed_fields,
    check_answers,
    form_in,
)


async def _latest_answers(conversation_id: str, form_id: str) -> "tuple[Optional[str], Optional[dict[str, Any]]]":
    """The newest answers message for this form: its id and values."""
    from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415

    latest = None
    for fm in await FlowMessage.get_all({"conversation_id": conversation_id}):
        ans = answers_in(fm.attachment)
        if ans is not None and ans.form_id == form_id:
            key = str(getattr(fm, "created_date", "") or "")
            if latest is None or key >= latest[0]:
                latest = (key, fm.id, ans.values)
    return (latest[1], latest[2]) if latest else (None, None)


async def answer_form(conversation_id: str, body: dict, someone_typeid: str) -> ApiResponse:
    from flow_sdk.app.actions.notification_action import handle_add_message  # noqa: PLC0415
    from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415
    from flow_sdk.app.actions.flow_message_action import _current_cloud_user_id  # noqa: PLC0415
    from flow_sdk.server.routes.bootstrap import get_or_create_local_user  # noqa: PLC0415

    fm_id = str(body.get("message_id") or "")
    fm = await FlowMessage.get_one({"id": fm_id}) if fm_id else None
    if fm is None or fm.conversation_id != conversation_id:
        return ApiFailResponse(message="no such message in this conversation", status_code=404)
    form = form_in(fm.attachment)
    if form is None:
        return ApiFailResponse(message="this message carries no form", status_code=400)
    # A hub message's sender is the CLOUD user id; the local user id only for a local-only send.
    me = {await _current_cloud_user_id(), getattr(await get_or_create_local_user(), "id", None)} - {None, ""}
    if fm.sender_id and fm.sender_id in me:
        return ApiFailResponse(message="you sent this form — its receiver answers it", status_code=403)

    values = body.get("values") or {}
    if isinstance(values, str):  # a multipart send (a ``file`` field) carries the values as JSON text
        try:
            values = json.loads(values)
        except ValueError:
            values = None
    if not isinstance(values, dict):
        return ApiFailResponse(message="values must be an object", status_code=400)
    clean, problems = check_answers(form, values)
    if problems:
        return ApiFailResponse(message="; ".join(problems), status_code=400, data={"problems": problems})

    previous_id, previous = await _latest_answers(conversation_id, form.form_id)
    answers = FormAnswers(
        form_id=form.form_id,
        values=clean,
        changed=changed_fields(form, clean, previous),
        supersedes=previous_id,
    )
    reply: dict = {"conversation_id": conversation_id, "message": "", "attachment": [answers_attachment(answers)]}
    if body.get("files"):  # a ``file`` field's upload rides on the same reply
        reply["files"] = body["files"]
    sent = await handle_add_message(reply, someone_typeid)
    if isinstance(sent, ApiFailResponse):
        return sent
    return ApiSuccessResponse(data={"form_id": form.form_id, "values": clean, "changed": answers.changed,
                                    "supersedes": previous_id})


@action.post(action_name="form-answer", types=["conversation"])
async def conversation_form_answer() -> ApiResponse:
    conversation_id, someone_typeid, refused = _conversation_request()
    if refused is not None:
        return refused
    try:
        body = await get_current_request_info().get_post_data() or {}
    except JSONDecodeError:
        body = {}
    return await answer_form(conversation_id, body, someone_typeid)
