"""Ask for help through the real local hub: the request is ONE help_request message whose attachments are the
diagnosis and the context, and the helper can open them. Review-first and private requests never reach the hub
until (or unless) the person shares them.

Identities: this instance is the requester (``hub_session``); ``bob_token`` is the helper -- the desk owner, or
the person asked. Ground truth is always the hub's own rows.
"""

from __future__ import annotations

import io
import uuid
import zipfile
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from tests.hub_tests.test_ask_for_help_never_fails import _eventually, _hub, desk, task_storage  # noqa: F401

pytestmark = [pytest.mark.asyncio, pytest.mark.hub, pytest.mark.timeout(60)]  # do not increase timeout without approval

#: logs.txt rides too when the instance has logs; a fresh test instance has none.
CONTEXT = {"help_request.value.json", "diagnosis.value.json", "screen.value.json"}


async def _call(fn, body: dict, conv_id: str | None = None):
    from flow_sdk.app.actions import ask_for_help_action as afh
    from flow_sdk.fs_store.type_id import TypeId
    from flow_sdk.server.routes.bootstrap import get_or_create_local_user

    someone = (await get_or_create_local_user()).typeid
    request = SimpleNamespace(
        someone_typeid=someone,
        get_post_data=AsyncMock(return_value=body),
        target_entity_typeid=TypeId(type="conversation", id=conv_id) if conv_id else None,
    )
    with patch.object(afh, "get_current_request_info", return_value=request):
        return await fn()


def _names(row: dict) -> set[str]:
    return {(a.get("data") or "").rsplit("/", 1)[-1] for a in row.get("attachment") or [] if a.get("attachment_type") == "file"}


async def _body_files(base: str, token: str, fm_id: str) -> set[str]:
    """What the helper downloads: the message's body bundle, as file names."""
    async with httpx.AsyncClient(timeout=20) as h:
        r = await h.get(
            f"{base}/api/v1/graph/flow_message/{fm_id}/fs/download/body.flowmsg", headers={"Authorization": f"Bearer {token}"}
        )
    assert r.status_code == 200, f"the helper cannot download the request's attachments: {r.status_code} {r.text[:200]}"
    return {name.rsplit("/", 1)[-1] for name in zipfile.ZipFile(io.BytesIO(r.content)).namelist()}


async def _hub_messages(base: str, token: str, conv_id: str) -> list[dict]:
    """The conversation's messages as ``token`` sees them -- ``messages`` is what a desk owner reads a ticket by."""
    async with httpx.AsyncClient(timeout=10) as h:
        for path in ("messages", "flow_message"):
            r = await h.get(f"{base}/api/v1/graph/conversation/{conv_id}/{path}", headers={"Authorization": f"Bearer {token}"})
            rows = (r.json().get("data") or []) if r.status_code == 200 else []
            if rows:
                return rows
    return []


async def _ready_on_hub(base: str, token: str, conv_id: str, n: int = 1) -> list[dict]:
    async def probe():
        rows = await _hub_messages(base, token, conv_id)
        return rows if len(rows) >= n and all((m.get("body_status") or "") == "ready" for m in rows) else None

    rows = await _eventually(probe)
    assert rows, f"the request never became openable on the hub (rows: {await _hub_messages(base, token, conv_id)})"
    return rows


async def test_a_person_gets_one_request_with_its_diagnosis_and_context(hub_session, task_storage, bob_token):  # noqa: F811
    from tests.hub_tests.conftest import _resolve_identities

    base = hub_session["base_url"]
    _, helper = _resolve_identities()
    body = {"conversation_id": str(uuid.uuid4()), "recipients": [{"kind": "person", "email": helper}], "text": f"skills empty {uuid.uuid4().hex[:6]}"}

    from flow_sdk.app.actions import ask_for_help_action as afh

    response = await _call(afh.ask_for_help, body)
    assert response.data["shared"] and response.data["context_shared"], response.data

    (row,) = await _ready_on_hub(base, bob_token, body["conversation_id"])
    assert (row.get("text") or "").strip() == body["text"]
    assert CONTEXT <= _names(row), _names(row)
    assert CONTEXT <= await _body_files(base, bob_token, row["id"])


async def test_a_desk_ticket_is_one_request_with_its_context(hub_session, task_storage, bob_token, desk):  # noqa: F811
    from flow_sdk.app.actions import ask_for_help_action as afh

    base = hub_session["base_url"]
    body = {"conversation_id": str(uuid.uuid4()), "recipients": [{"kind": "desk", "desk_project_id": desk}], "text": f"cannot log in {uuid.uuid4().hex[:6]}"}

    response = await _call(afh.ask_for_help, body)
    assert response.data["shared"], response.data

    (row,) = await _ready_on_hub(base, bob_token, body["conversation_id"])
    assert (row.get("text") or "").strip() == body["text"]
    # A desk agent opens a ticket once they pick it up -- then its attachments are theirs to read.
    await _hub(base, bob_token, "POST", f"/graph/conversation/{body['conversation_id']}/pickup", json={})
    assert CONTEXT <= await _body_files(base, bob_token, row["id"])


async def test_review_first_reaches_the_hub_only_on_share(hub_session, task_storage, bob_token):  # noqa: F811
    from flow_sdk.app.actions import ask_for_help_action as afh
    from tests.hub_tests.conftest import _resolve_identities

    base = hub_session["base_url"]
    _, helper = _resolve_identities()
    body = {
        "conversation_id": str(uuid.uuid4()),
        "recipients": [{"kind": "person", "email": helper}],
        "text": f"review me {uuid.uuid4().hex[:6]}",
        "send": "review_first",
    }

    response = await _call(afh.ask_for_help, body)
    assert response.data["shared"] is False
    assert await _hub_messages(base, bob_token, body["conversation_id"]) == [], "nothing may leave before Share"

    shared = await _call(afh.help_request_share, {}, body["conversation_id"])
    assert "diagnosis.value.json" in shared.data["shared"]

    rows = await _ready_on_hub(base, bob_token, body["conversation_id"], n=2)
    context_rows = [r for r in rows if "diagnosis.value.json" in _names(r)]
    assert len(context_rows) == 1, [_names(r) for r in rows]
    assert CONTEXT <= await _body_files(base, bob_token, context_rows[0]["id"])


async def test_a_private_request_never_reaches_the_hub(hub_session, task_storage, bob_token):  # noqa: F811
    from flow_sdk.app.actions import ask_for_help_action as afh

    base = hub_session["base_url"]
    body = {"conversation_id": str(uuid.uuid4()), "recipients": [], "text": f"note to self {uuid.uuid4().hex[:6]}"}

    response = await _call(afh.ask_for_help, body)

    assert response.data["shared"] is False
    assert await _hub_messages(base, hub_session["api_key"], body["conversation_id"]) == []
