"""Unit tests for FlowMessage.download_body().

Refuses (BodyNotReadyError) when body_status != READY; otherwise delegates
to _download_and_unpack_bundle with BODY_FILENAME (or the FM's legacy
attachment_filename when present, for backward compat). All hub I/O is
mocked at the boundary.

# do not increase timeout without approval
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.builtin.flow_message import (
    BODY_FILENAME,
    BodyNotReadyError,
    BodyStatus,
    FlowMessage,
)


pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


@pytest.mark.asyncio
async def test_download_body_happy_path() -> None:
    fm = FlowMessage(text="t", body_status=BodyStatus.READY)
    fm.id = "bbbbbbbb-0000-0000-0000-000000000002"

    with patch(
        "flow_sdk.app.actions.flow_message_action._download_and_unpack_bundle",
        AsyncMock(return_value=True),
    ) as mock_dl:
        await fm.download_body()

    assert mock_dl.await_count == 1
    args = mock_dl.await_args_list[0].args
    assert args[0] == fm.id
    assert args[1] == BODY_FILENAME


@pytest.mark.asyncio
async def test_download_body_refused_when_status_not_ready() -> None:
    for status in (BodyStatus.NA, BodyStatus.UPLOADING):
        fm = FlowMessage(text="t", body_status=status)
        fm.id = "bbbbbbbb-0000-0000-0000-000000000002"
        with pytest.raises(BodyNotReadyError):
            await fm.download_body()


@pytest.mark.asyncio
async def test_download_body_uses_legacy_attachment_filename_when_present() -> None:
    """Backward compat: pre-refactor FMs have per-message slugified filenames
    in attachment_filename. download_body must honor them rather than
    blindly using BODY_FILENAME — otherwise we 404 on old conversations.
    """
    legacy = "share-notes-7d3a.flowmsg"
    fm = FlowMessage(text="t", body_status=BodyStatus.READY, attachment_filename=legacy)
    fm.id = "bbbbbbbb-0000-0000-0000-000000000002"

    with patch(
        "flow_sdk.app.actions.flow_message_action._download_and_unpack_bundle",
        AsyncMock(return_value=True),
    ) as mock_dl:
        await fm.download_body()

    args = mock_dl.await_args_list[0].args
    assert args[1] == legacy  # legacy filename respected


@pytest.mark.asyncio
async def test_download_body_raises_on_unpack_failure() -> None:
    fm = FlowMessage(text="t", body_status=BodyStatus.READY)
    fm.id = "bbbbbbbb-0000-0000-0000-000000000002"

    with patch(
        "flow_sdk.app.actions.flow_message_action._download_and_unpack_bundle",
        AsyncMock(return_value=False),
    ):
        with pytest.raises(RuntimeError, match="download_body failed"):
            await fm.download_body()


@pytest.mark.asyncio
async def test_download_body_requires_id() -> None:
    fm = FlowMessage(text="t", body_status=BodyStatus.READY)
    fm.id = None
    with pytest.raises(ValueError, match="download_body requires self.id"):
        await fm.download_body()
