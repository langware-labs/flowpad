"""A live project invite pulls its bundle on arrival (FLOWPAD-2194).

The invite's bundle stages the shared project (a MessageAttachment the chip
installs through). A message that arrives while the desktop is open must pull
that bundle right away, as it does for skills and docs; otherwise the project
stays unstaged until a catch-up, a deep link or a manual Download.

The download itself is stubbed at ``_download_and_unpack_bundle``; the arrival
decision above it is real.
"""

from __future__ import annotations

from uuid import uuid4

import pytest

from flow_sdk.app.actions import flow_message_action
from flow_sdk.cloud_client import hub_bridge


@pytest.fixture
def pulls(monkeypatch):
    seen: list[str] = []

    async def _download(fm_id, attachment_filename, **_kwargs):
        seen.append(fm_id)

    monkeypatch.setattr(flow_message_action, "_download_and_unpack_bundle", _download)
    return seen


def _attachments(*typeids: str) -> list[dict]:
    return [{"attachment_type": "type_id", "data": t} for t in typeids]


async def test_a_live_project_invite_pulls_its_bundle(pulls):
    fm_id = str(uuid4())

    await hub_bridge._maybe_eager_pull_bundle(fm_id, "body.flowmsg", _attachments(f"project-{uuid4()}"), "ready")

    assert pulls == [fm_id]


async def test_a_message_with_only_a_conversation_reference_still_waits(pulls):
    await hub_bridge._maybe_eager_pull_bundle(
        str(uuid4()), "body.flowmsg", _attachments(f"conversation-{uuid4()}"), "ready"
    )

    assert pulls == []
