"""Shared fixtures-as-functions for the session api tests (real DB, no worker)."""
from __future__ import annotations

import json

from flow_sdk.builtin.flow_message import (
    LIVE_SESSION_EVENT_MARKER_KEY,
    Attachment,
    AttachmentType,
    FlowMessage,
    _carrier_marker,
)
from flow_sdk.builtin.remote_worker_session import RemoteWorkerSession


async def local_project_id(client) -> str:
    projects = (await client.get("/api/v1/graph/project")).json()["data"]
    return next(p for p in projects if p.get("uname") == "local")["id"]


async def make_conversation(client) -> str:
    project_id = await local_project_id(client)
    resp = await client.post(
        "/api/v1/graph/conversation-create",
        json={"project_id": project_id, "participants": []},
    )
    assert resp.json().get("status") == "SUCCESS", resp.text
    return resp.json()["data"]["conversation_id"]


async def session_messages(conv_id: str, *, kind: str | None = None) -> list[FlowMessage]:
    fms = await FlowMessage.get_all({"conversation_id": conv_id})
    out = [m for m in fms if getattr(m, "remote_worker_session_id", None)]
    if kind is not None:
        out = [m for m in out if m.kind == kind]
    return out


def event_marker(fm: FlowMessage) -> str | None:
    return (_carrier_marker(fm) or {}).get(LIVE_SESSION_EVENT_MARKER_KEY)


async def make_session(conv_id: str, status: str, session_id: str | None = None, **extra) -> RemoteWorkerSession:
    rws = RemoteWorkerSession(
        conversation_id=conv_id,
        host_user_id=extra.pop("host_user_id", "host-local"),
        guest_user_id=extra.pop("guest_user_id", "guest-remote"),
        host_name="Alice",
        guest_name="Bob",
        status=status,
        **extra,
    )
    if session_id:
        rws.id = session_id
    await rws.save(notify=False)
    return rws


def inbound_prompt_fm(conv_id: str, session_id: str | None, *, fm_id: str,
                      sender_id: str = "guest-remote", start_marker: dict | None = None) -> FlowMessage:
    atts = [Attachment(attachment_type=AttachmentType.PROMPT, data="run the tests")]
    if session_id:
        atts.append(Attachment(
            attachment_type=AttachmentType.TYPE_ID,
            data=f"remote_worker_session-{session_id}",
            prompt_preview=json.dumps({"session_start": start_marker}) if start_marker is not None else None,
        ))
    fm = FlowMessage(
        text="please run this",
        sender_id=sender_id,
        sender_name="Bob",
        conversation_id=conv_id,
        remote_worker_session_id=session_id,
        attachment=atts,
    )
    fm.id = fm_id
    return fm
