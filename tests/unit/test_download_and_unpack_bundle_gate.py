"""Unit tests for the single backend download gate.

``_download_and_unpack_bundle`` is the one chokepoint every bundle pull funnels
through. The body-status gate lives HERE (and only here) for the implicit
callers: when ``body_status`` is anything other than READY there is no bundle on
the hub to fetch, so the function must skip the hub GET entirely rather than
404. ``None`` means "caller did not supply a status" and proceeds unchanged.

# do not increase timeout without approval
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.app.actions.flow_message_action import _download_and_unpack_bundle
from flow_sdk.builtin.flow_message import BodyStatus

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

FM_ID = "aaaaaaaa-0000-0000-0000-000000000001"


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [BodyStatus.NA, BodyStatus.UPLOADING, "na", "uploading"])
async def test_skips_hub_get_when_not_ready(status) -> None:
    """NA / UPLOADING (enum or raw hub string) → no hub GET, returns False."""
    with patch("flow_sdk.app.actions.flow_message_action.hub_get", AsyncMock()) as mock_get:
        result = await _download_and_unpack_bundle(
            FM_ID,
            "conversation-deadbeef.flowmsg",
            hub_updated=None,
            body_status=status,
        )
    assert result is False
    assert mock_get.await_count == 0, "must not attempt a download for a non-ready body"


@pytest.mark.asyncio
async def test_proceeds_when_ready() -> None:
    """READY → the hub GET fires (then returns no bytes → False, but it tried)."""
    with patch(
        "flow_sdk.app.actions.flow_message_action.hub_get",
        AsyncMock(return_value=b""),
    ) as mock_get:
        result = await _download_and_unpack_bundle(
            FM_ID,
            "body.flowmsg",
            hub_updated=None,
            body_status=BodyStatus.READY,
        )
    assert mock_get.await_count == 1
    assert result is False  # empty bytes → unpack short-circuits, but GET happened


@pytest.mark.asyncio
async def test_proceeds_when_status_omitted() -> None:
    """No body_status supplied → back-compat: proceed (gate is opt-in per caller)."""
    with patch(
        "flow_sdk.app.actions.flow_message_action.hub_get",
        AsyncMock(return_value=b""),
    ) as mock_get:
        await _download_and_unpack_bundle(FM_ID, "body.flowmsg", hub_updated=None)
    assert mock_get.await_count == 1
