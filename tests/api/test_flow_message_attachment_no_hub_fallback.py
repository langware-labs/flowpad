"""A FILE attachment whose bytes are not local yet must NOT be chased on the hub.

The incident: opening a conversation whose message bundles were never downloaded
fired one ``GET /api/v1/graph/flow_message/<id>/fs/download/data/<name>`` per
attachment at the hub, each a guaranteed 404 ("FS item was not found"), each
surfaced to the user as a "Cloud Request Failed" warning.

The hub can never answer that request. For a FlowMessage it stores exactly one
object — the packed ``body.flowmsg`` bundle (``docs/collab/messages-and-attachments.md``
§3); individual attachment files are never uploaded. So the local cache-miss
fallback in ``fs_actions.fetch_remote_entity_file`` — gated on the entity's
``remote`` flag rather than its type since 568033609 — is futile for this type
and only manufactures a scary warning out of a benign, self-healing miss.

Driven through the REAL route with a REAL (unreachable) hub: the hub URL points
at a closed port, so the fallback's HTTP attempt is a real socket connect that
really fails. Nothing is mocked — the assertion is on whether the backend
*attempted* the per-file hub GET at all, which is the bug.

# do not increase timeout without approval
"""

from __future__ import annotations

import logging
import socket
import uuid

import pytest

from flow_sdk.builtin.flow_message import (
    BODY_FILENAME,
    Attachment,
    AttachmentType,
    BodyStatus,
    FlowMessage,
)

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

ATTACHMENT_NAME = "probe-screenshot.png"
VFS_SUBPATH = f"data/{ATTACHMENT_NAME}"

HUB_TRANSPORT_LOGGER = "flow_sdk.cloud_client.transport.hub_http"


def _closed_port() -> int:
    """A port nothing is listening on — bind, read the number, release it."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _per_file_hub_attempts(caplog) -> list[str]:
    """Hub GETs aimed at an individual attachment path (``fs/download/data/...``).

    The bundle GET (``fs/download/body.flowmsg``) is legitimate and excluded —
    only the per-file variant is the futile one.
    """
    return [
        rec.getMessage()
        for rec in caplog.records
        if rec.name == HUB_TRANSPORT_LOGGER and "/fs/download/data/" in rec.getMessage()
    ]


@pytest.mark.asyncio
async def test_missing_attachment_does_not_chase_the_hub(bootstrapped_client, monkeypatch, caplog) -> None:
    """A remote FM whose attachment bytes are not on disk must fail locally.

    The route may 404 — that is correct and the UI already renders a Download
    button off ``local_path=null``. What it must NOT do is ask the hub for
    ``data/<name>``, a path the hub structurally never holds for a flow_message.
    """
    from flow_sdk.config import default_service_config

    fm = FlowMessage(
        text="see the screenshot",
        body_status=BodyStatus.READY,
        attachment_filename=BODY_FILENAME,
        conversation_id=str(uuid.uuid4()),
        attachment=[Attachment(attachment_type=AttachmentType.FILE, data=VFS_SUBPATH)],
    )
    fm.id = str(uuid.uuid4())
    # ``remote`` is the flag the fallback gates on — a hub-mirrored message, which
    # is exactly what every shared message is.
    fm.remote = True
    await fm.save(None)

    # A real hub URL that really cannot be reached: the fallback's HTTP call is a
    # genuine connect() to a closed port, not a stubbed failure.
    monkeypatch.setattr(default_service_config, "flowpad_hub_url", f"http://127.0.0.1:{_closed_port()}", raising=False)

    with caplog.at_level(logging.INFO, logger=HUB_TRANSPORT_LOGGER):
        response = await bootstrapped_client.get(f"/api/v1/graph/flow_message/{fm.id}/fs/download/{VFS_SUBPATH}")

    # The bytes genuinely are not local, so a 404 is the right answer.
    assert response.status_code == 404, response.text

    attempts = _per_file_hub_attempts(caplog)
    assert attempts == [], (
        "backend chased an individual attachment on the hub, which only ever stores "
        f"the packed bundle for a flow_message: {attempts}"
    )
