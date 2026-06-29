"""API tests for the single backend download gate, driven through real routes.

The implicit sync/nav actions (open / inbox-open / conversation-sync / …) pull a
message's body bundle to materialize it. They must forward ``body_status`` into
the one chokepoint (``_download_and_unpack_bundle``) so that a *dangling pointer*
— a hub FlowMessage with FILE attachments + ``attachment_filename`` set but
``body_status='na'`` (body never uploaded) — does NOT trigger a ``fs/download``
GET (which would 404 and surface a "Cloud Request Failed" toast).

Hub I/O is mocked at the ``flow_message_action`` boundary so the tests run
hermetically against the FastAPI app via ``bootstrapped_client``; the dangling FM
is served from the (mocked) hub and is intentionally absent from the local store,
which is exactly what forces the caller to reach the chokepoint.

# do not increase timeout without approval
"""
from __future__ import annotations

import io
import json
import uuid
import zipfile
from datetime import datetime, timezone
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

# Ensure the file-backed TypeInfo family (prompt: main_subdir="prompts") is
# registered in the pytest process — otherwise SchemaRegistry.get("prompt")
# is None and unpack_bundle treats the entry as a generic DB-record (no parking).
import flow_sdk.fs_store.indexer.registrations  # noqa: F401

from flow_sdk.builtin.flow_message import BODY_FILENAME, AttachmentType, BodyStatus, FlowMessage


pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

FM_ID = "dddddddd-0000-0000-0000-00000000da91"
DANGLING_FILENAME = "conversation-91b6b0bf.flowmsg"


def _hub_fm(body_status: str) -> dict[str, Any]:
    """A hub FlowMessage payload with FILE attachments + a bundle filename but
    the given body_status — the shape of the reported dangling pointer."""
    return {
        "id": FM_ID,
        "text": "see screen shot and log",
        "attachment": [
            {"attachment_type": AttachmentType.FILE.value, "data": "data/clip.mov"},
            {"attachment_type": AttachmentType.FILE.value, "data": "data/issue.log"},
        ],
        "attachment_filename": DANGLING_FILENAME,
        "body_status": body_status,
        "shared_context_entities": [],
    }


def _download_gets(mock_get) -> list:
    """Sub-list of hub_get calls that hit the bundle download endpoint
    (``hub_get(FLOW_MESSAGE, id, "fs", "download/<file>", ...)``)."""
    hits = []
    for call in mock_get.await_args_list:
        args = call.args
        if "fs" in args and any(
            isinstance(a, str) and a.startswith("download/") for a in args
        ):
            hits.append(call)
    return hits


# The deep-link ``open`` action (handle_open_flow_message) is the incident path:
# it tolerates a hub-only entity (the framework does not require a local row), and
# a *local* dangling FM would short-circuit before ever reaching the chokepoint —
# so driving ``open`` against a mocked, hub-only dangling FM is what actually
# exercises the gate.


@pytest.mark.asyncio
async def test_open_dangling_pointer_issues_no_download(bootstrapped_client) -> None:
    """body_status='na' (dangling) → the gate skips; no fs/download GET fires."""
    with patch(
        "flow_sdk.app.actions.flow_message_action.hub_get",
        AsyncMock(return_value=_hub_fm("na")),
    ) as mock_get:
        r = await bootstrapped_client.get(f"/api/v1/graph/flow_message/{FM_ID}/open")

    assert r.status_code == 200, r.text
    assert _download_gets(mock_get) == [], "must not attempt a body download for a dangling pointer"


@pytest.mark.asyncio
async def test_open_ready_pointer_issues_download(bootstrapped_client) -> None:
    """Control: body_status='ready' → the gate lets it through; a download GET fires.

    Proves the suppression above is the body_status gate, not some unrelated
    short-circuit. The download returns empty bytes (no real bundle) but the GET
    is attempted — exactly the behaviour the dangling case must avoid.
    """
    async def _fake_get(*args, **kwargs):
        if "fs" in args:  # the bundle download call → empty bytes
            return b""
        return _hub_fm("ready")

    with patch(
        "flow_sdk.app.actions.flow_message_action.hub_get",
        AsyncMock(side_effect=_fake_get),
    ) as mock_get:
        r = await bootstrapped_client.get(f"/api/v1/graph/flow_message/{FM_ID}/open")

    assert r.status_code == 200, r.text
    assert len(_download_gets(mock_get)) >= 1, "ready body should attempt the download"


# ---------------------------------------------------------------------------
# No-project parking gate (explicit download_body path)
#
# A READY body whose bundle carries a file-backed asset (prompt) but whose
# conversation maps to NO project must: materialize the top FlowMessage, PARK
# the asset (extract-but-don't-copy/index), and surface a 409 with
# ``{needs_project: True, pending_types: [...]}`` so the UI prompts "map a
# project first" and re-downloads. Driven through the real route + real
# unpack_bundle; only the hub bundle fetch is stubbed (the file's house style).
# ---------------------------------------------------------------------------


def _no_project_bundle_bytes(fm_id: str, conv_id: str, prompt_id: str) -> bytes:
    """A real .flowmsg carrying a file-backed prompt asset + a conversation
    with NO project mapped. The conversation entry is a DB-record branch (not
    parked); the prompt entry is the file-backed family that gets parked when
    no project root resolves for the conversation."""
    msg = {
        "id": fm_id,
        "type": "flow_message",
        "text": "see the shared prompt",
        "conversation_id": conv_id,
        "shared_context_entities": [f"conversation-{conv_id}"],
        "attachment": [{"attachment_type": AttachmentType.TYPE_ID.value, "data": f"prompt-{prompt_id}"}],
        "sender_id": "11111111-1111-4111-8111-111111111111",
        "sender_name": "Alice",
        "receiver_address": "bob@local.test",
        "receiver_address_type": "email",
        "instruction": None,
    }
    pointer = {"typeid": f"flow_message-{fm_id}", "ts": datetime.now(timezone.utc).isoformat()}
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("header.json", json.dumps(msg, ensure_ascii=False))
        # Conversation entry → creates a local Conversation with NO project_id.
        zf.writestr(
            f"attachment/conversation-@{conv_id}/header.json",
            json.dumps(
                {"type": "conversation", "id": conv_id, "participants": [], "project_id": None},
                ensure_ascii=False,
            ),
        )
        zf.writestr(
            f"attachment/conversation-@{conv_id}/conversation.jsonl",
            json.dumps(pointer, ensure_ascii=False) + "\n",
        )
        # File-backed prompt asset → parked when no project is mapped.
        zf.writestr(
            f"attachment/prompt-@{prompt_id}/prompts/shared.md",
            f"---\nid: {prompt_id}\nname: Shared Prompt\nuse_count: 1\n---\n\nFix the auth bug.\n",
        )
    return buf.getvalue()


@pytest.mark.asyncio
async def test_download_body_no_project_parks_assets_and_returns_needs_project_409(
    bootstrapped_client,
) -> None:
    """body_status=READY + file-backed asset + conversation with no project →
    the FM materializes, the asset is parked (not indexed), and the route
    returns 409 with ``{needs_project: True, pending_types: ['prompt']}``."""
    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.builtin.prompt import Prompt

    fm_id = str(uuid.uuid4())
    conv_id = str(uuid.uuid4())
    prompt_id = str(uuid.uuid4())

    # Local hub-delivered FM whose body is READY on the hub. Saved locally so
    # the route resolves it without a metadata hub_get — the only hub call is
    # the bundle download, which we stub with real bundle bytes.
    fm = FlowMessage(
        text="see the shared prompt",
        body_status=BodyStatus.READY,
        attachment_filename=BODY_FILENAME,
        conversation_id=conv_id,
    )
    fm.id = fm_id
    await fm.save(None)

    bundle = _no_project_bundle_bytes(fm_id, conv_id, prompt_id)

    async def _fake_get(*args, **kwargs):
        if "fs" in args:  # the bundle download GET → real bundle bytes
            return bundle
        return None

    with patch(
        "flow_sdk.app.actions.flow_message_action.hub_get",
        AsyncMock(side_effect=_fake_get),
    ):
        r = await bootstrapped_client.post(
            f"/api/v1/graph/flow_message/{fm_id}/download_body", json={},
        )

    assert r.status_code == 409, r.text
    body = r.json()
    assert body.get("status") in ("FAIL", "fail"), body
    data = body.get("data") or {}
    assert data.get("needs_project") is True, body
    assert "prompt" in (data.get("pending_types") or []), body

    # The top FlowMessage still materialized despite the gate being raised.
    assert await FlowMessage.get_one({"id": fm_id}) is not None
    # The conversation was created (parked context) with NO project mapped.
    conv = await Conversation.get_one({"id": conv_id})
    assert conv is not None
    assert not getattr(conv, "project_id", None), "conversation must stay project-less"
    # The file-backed prompt was PARKED — never copied into a project / indexed.
    assert await Prompt.get_one({"id": prompt_id}) is None, "prompt must NOT be materialized"
