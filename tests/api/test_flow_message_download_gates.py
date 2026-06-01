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

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.builtin.flow_message import AttachmentType, BodyStatus


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
