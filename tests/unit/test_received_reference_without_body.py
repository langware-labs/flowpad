"""Received reference messages with no body bundle, on the receive path.

A message the hub stores without the client send pipeline (a helpdesk
ticket's opening message, from ``start_guest_conversation``) carries a
``<type>-<id>`` reference attachment at ``body_status`` ``na`` — there is no
body bundle to pull. The client-side contract:

* A received (``remote``) message at ``na`` is body-free: no download
  affordance and no catch-up download, whatever its reference points at.
  ``has_body()`` itself is unchanged — a freshly composed local message also
  starts at ``na`` and senders call ``has_body()`` to decide whether to upload.

# do not increase timeout without approval
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.app.actions import flow_message_action as fma
from flow_sdk.builtin.flow_message import BodyStatus, FlowMessage

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

_OTHER_ID = "33333333-0000-4000-8000-000000000003"


def _body_free_payload(*, ref: str, sender_id: str = _OTHER_ID, conv_id: str | None = None) -> dict:
    """A body-free reference message as it arrives on the wire."""
    return {
        "id": mint_uuid(),
        "type": "flow_message",
        "text": "Alice opened a ticket",
        "conversation_id": conv_id or mint_uuid(),
        "sender_id": sender_id,
        "sender_name": "Alice",
        "kind": "user",
        "body_status": "na",
        "attachment": [{"attachment_type": "type_id", "data": ref}],
    }


def _received(payload: dict) -> FlowMessage:
    return FlowMessage.model_validate({**payload, "remote": True})


# --------------------------------------------------------------------------- #
# Body-free references on the receiving side
# --------------------------------------------------------------------------- #


def test_received_project_reference_materializes_without_download_affordance() -> None:
    fm = _received(_body_free_payload(ref=f"project-{mint_uuid()}"))

    # has_body() is unchanged: a TYPE_ID attachment still "requires a body".
    assert fm.has_body() is True
    # ...but a received message at ``na`` has nothing to pull.
    assert fm.has_downloadable_body() is False
    dumped = fm.model_dump(mode="json")
    assert dumped["body_downloaded"] is True, "nothing left to pull → no Download affordance"
    assert dumped["body_missing_attachments"] == []


def test_received_generic_reference_has_no_download_affordance() -> None:
    """R15: the reference is generic. A body-free reference to an entity that is
    not on this machine must not look like a pending download (the context
    panel's "Download <type>" row, the bubble's pending count)."""
    fm = _received(_body_free_payload(ref=f"markdown-{mint_uuid()}"))

    assert fm.has_body() is True
    assert fm.has_downloadable_body() is False
    dumped = fm.model_dump(mode="json")
    assert dumped["body_downloaded"] is True
    assert dumped["body_missing_attachments"] == []
    assert fm.is_body_downloaded() is True


def test_fresh_local_message_still_has_a_body_to_upload() -> None:
    """A freshly composed message starts at ``na`` too. It is not received, so
    it still reports a body: senders gate the UPLOADING stamp + upload on
    ``has_body()`` and the receive-side predicate must agree for local rows."""
    fm = FlowMessage.model_validate(
        {
            "id": mint_uuid(),
            "text": "here is a doc",
            "attachment": [
                {"attachment_type": "type_id", "data": f"markdown-{mint_uuid()}"},
                {"attachment_type": "file", "data": "data/notes.txt"},
            ],
        }
    )
    assert fm.body_status == BodyStatus.NA
    assert fm.remote is False
    assert fm.has_body() is True
    assert fm.has_downloadable_body() is True
    assert fm.model_dump(mode="json")["body_downloaded"] is False


@pytest.mark.parametrize("status", [BodyStatus.UPLOADING, BodyStatus.READY])
def test_received_message_with_a_real_body_still_downloads(status: BodyStatus) -> None:
    payload = _body_free_payload(ref=f"markdown-{mint_uuid()}")
    payload["body_status"] = status.value
    fm = _received(payload)

    assert fm.has_downloadable_body() is True
    assert fm.model_dump(mode="json")["body_downloaded"] is False


@pytest.mark.asyncio
async def test_catch_up_does_not_pull_a_body_free_message() -> None:
    """Catch-up (``_process_single_hub_message``) keys its pull on the body
    being on disk; a body-free received row has nothing to pull, so the bundle
    download is never attempted for it."""
    payload = _body_free_payload(ref=f"markdown-{mint_uuid()}")
    payload["attachment_filename"] = f"flow_message-{payload['id']}.flowmsg"
    existing = _received(payload)
    download = AsyncMock(return_value=False)

    with (
        patch.object(fma.FlowMessage, "get_one", new=AsyncMock(return_value=existing)),
        patch.object(fma, "_download_and_unpack_bundle", new=download),
        patch.object(fma.FlowMessage, "is_stale", return_value=False),
    ):
        result = await fma._process_single_hub_message(payload)

    assert result == payload["id"]
    assert download.await_count == 0
