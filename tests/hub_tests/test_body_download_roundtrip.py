"""Body upload→download round-trip against a live local hub, and the gate.

Validates the two halves of the single backend download gate end-to-end:

  * READY round-trip — a body that was actually uploaded downloads cleanly
    through the real hub. The gate must NOT block the happy path.
  * NOT-READY skip — a message whose body was never uploaded (``body_status``
    stays NA, the reported dangling-pointer shape) refuses without issuing any
    hub ``fs/download`` GET. The gate short-circuits before the hub.

Auto-skips when no local hub is reachable (see tests/hub_tests/conftest.py).

# do not increase timeout without approval
"""
from __future__ import annotations

import time
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from flow_sdk.builtin.flow_message import (
    BODY_FILENAME,
    Attachment,
    AttachmentType,
    BodyNotReadyError,
    BodyStatus,
    FlowMessage,
)

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


def _login(hub_login_payload):
    from tests.hub_tests._local_login import login_as
    return login_as(hub_login_payload)


@pytest.mark.asyncio
async def test_ready_body_round_trips_through_hub(
    hub_base_url, hub_login_payload, isolated_hub_keyring,
) -> None:
    """add_message(attachment) → upload_body (READY) → download_body succeeds.

    Proves the gate lets a genuinely-ready body through the real hub.
    """
    from flow_sdk.builtin.conversation import Conversation

    api_key = _login(hub_login_payload)

    conv = Conversation(title=f"body-roundtrip-{int(time.time())}")
    await conv.share()
    assert conv.remote is True

    # Attachment-bearing message → hub stamps body_status=UPLOADING at create.
    data = await conv.add_message(
        "with body",
        attachments=[
            {"attachment_type": AttachmentType.TYPE_ID.value,
             "data": "skill-deadbeef-0000-0000-0000-000000000001"},
        ],
    )
    assert data.get("body_status") == BodyStatus.UPLOADING.value, data

    fm = FlowMessage.model_validate(data)
    assert fm.has_body() is True

    # Sender packs + uploads → hub flips READY, stamps the body filename.
    await fm.upload_body()
    assert fm.body_status == BodyStatus.READY

    async with httpx.AsyncClient(timeout=5.0) as h:
        r = await h.get(
            f"{hub_base_url}/api/v1/graph/flow_message/{fm.id}",
            headers={"Authorization": f"Bearer {api_key}"},
        )
    assert r.status_code == 200, r.text
    on_hub = r.json()["data"]
    assert on_hub["body_status"] == "ready"
    assert on_hub["attachment_filename"] == BODY_FILENAME

    # The gate under test: a READY body downloads cleanly (no BodyNotReadyError,
    # the real hub GET fires and the bundle unpacks — already-present entities
    # count as success).
    await fm.download_body()
    assert fm.body_status == BodyStatus.READY


@pytest.mark.asyncio
async def test_not_ready_body_makes_no_hub_download(
    hub_base_url, hub_login_payload, isolated_hub_keyring,
) -> None:
    """A never-uploaded body (NA) + a set attachment_filename — the dangling
    pointer — refuses and issues no hub download, even when cloud-logged-in."""
    from flow_sdk.app.actions.flow_message_action import _download_and_unpack_bundle

    _login(hub_login_payload)

    fm = FlowMessage(
        text="see screen shot and log",
        attachment=[Attachment(attachment_type=AttachmentType.FILE, data="data/clip.mov")],
        body_status=BodyStatus.NA,
        attachment_filename="conversation-91b6b0bf.flowmsg",
    )
    fm.id = "cccccccc-0000-0000-0000-00000000da91"

    # Explicit path refuses up front.
    with pytest.raises(BodyNotReadyError):
        await fm.download_body()

    # Chokepoint (the implicit-caller seam) skips before any hub GET, even with
    # live creds present.
    with patch(
        "flow_sdk.app.actions.flow_message_action.hub_get", AsyncMock()
    ) as mock_get:
        ok = await _download_and_unpack_bundle(
            fm.id, fm.attachment_filename, body_status="na",
        )
    assert ok is False
    assert mock_get.await_count == 0
