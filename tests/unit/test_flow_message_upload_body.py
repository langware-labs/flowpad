"""Unit tests for FlowMessage.upload_body().

Verifies the three-step state machine: PUT body_status=UPLOADING → POST
fs/upload (multipart, BODY_FILENAME) → PUT body_status=READY +
attachment_filename. The hub calls are mocked at flow_sdk.utils.hub so no
network is touched.

# do not increase timeout without approval
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.builtin.flow_message import (
    Attachment,
    AttachmentType,
    BODY_FILENAME,
    BodyStatus,
    FlowMessage,
)


pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


def _fm_with_file_attachment() -> FlowMessage:
    fm = FlowMessage(
        text="hello",
        attachment=[Attachment(attachment_type=AttachmentType.FILE, data="data/foo.txt")],
    )
    fm.id = "aaaaaaaa-0000-0000-0000-000000000001"
    return fm


@pytest.mark.asyncio
async def test_upload_body_happy_path(tmp_path: Path) -> None:
    fm = _fm_with_file_attachment()
    fake_zip = tmp_path / "body.flowmsg"
    fake_zip.write_bytes(b"PK\x03\x04 pretend zip")
    to_file = AsyncMock(return_value=fake_zip)

    with (
        patch("flow_sdk.builtin.flow_message.FlowMessage.to_file", to_file),
        patch("flow_sdk.utils.hub.hub_put", AsyncMock(return_value={})) as mock_put,
        patch("flow_sdk.utils.hub.hub_post", AsyncMock(return_value={})) as mock_post,
    ):
        await fm.upload_body(transfer_mode="git")

    to_file.assert_awaited_once_with(transfer_mode="git")

    # No PUT: the hub auto-stamps body_status=UPLOADING server-side
    # (_attachments_require_body during message-header creation), so the
    # client doesn't announce it. See flow_message.upload_body docstring.
    assert mock_put.await_count == 0

    # Two POSTs: multipart fs/upload, then the set_body_status action that
    # flips READY (the action fans the UPDATE to receivers; a PUT would not).
    assert mock_post.await_count == 2
    post_kwargs = mock_post.await_args_list[0].kwargs
    files = post_kwargs["files"]
    assert "uploaded_file" in files
    filename, content, content_type = files["uploaded_file"]
    assert filename == BODY_FILENAME
    assert content == b"PK\x03\x04 pretend zip"
    assert content_type == "application/zip"

    set_status_payload = mock_post.await_args_list[1].args[1]
    assert mock_post.await_args_list[1].kwargs["action"] == "set_body_status"
    assert set_status_payload == {
        "flow_message_id": fm.id,
        "body_status": BodyStatus.READY.value,
        "attachment_filename": BODY_FILENAME,
    }

    # Local mirror of the field flips to READY.
    assert fm.body_status == BodyStatus.READY
    assert fm.attachment_filename == BODY_FILENAME

    # Temp zip is cleaned up.
    assert not fake_zip.exists()


@pytest.mark.asyncio
async def test_upload_body_pack_failure_leaves_uploading(tmp_path: Path) -> None:
    """If pack_bundle raises before any hub call, neither PUT nor POST fires.

    The caller observes the exception; the hub-side body_status is left at
    UPLOADING (server-stamped at message-creation time) so a retry resumes
    cleanly.
    """
    fm = _fm_with_file_attachment()

    with (
        patch("flow_sdk.builtin.flow_message.FlowMessage.to_file", AsyncMock(side_effect=RuntimeError("pack boom"))),
        patch("flow_sdk.utils.hub.hub_put", AsyncMock(return_value={})) as mock_put,
        patch("flow_sdk.utils.hub.hub_post", AsyncMock(return_value={})) as mock_post,
    ):
        with pytest.raises(RuntimeError, match="pack boom"):
            await fm.upload_body()

    # No client-side hub traffic at all — pack failed before to_file returned.
    assert mock_put.await_count == 0
    assert mock_post.await_count == 0
    # Local mirror never flipped to READY.
    assert fm.body_status != BodyStatus.READY


@pytest.mark.asyncio
async def test_upload_body_upload_failure_leaves_uploading(tmp_path: Path) -> None:
    """If fs/upload POST raises, body_status stays UPLOADING and READY PUT is skipped."""
    fm = _fm_with_file_attachment()
    fake_zip = tmp_path / "body.flowmsg"
    fake_zip.write_bytes(b"PK\x03\x04")

    with (
        patch("flow_sdk.builtin.flow_message.FlowMessage.to_file", AsyncMock(return_value=fake_zip)),
        patch("flow_sdk.utils.hub.hub_put", AsyncMock(return_value={})) as mock_put,
        patch("flow_sdk.utils.hub.hub_post", AsyncMock(side_effect=RuntimeError("upload boom"))) as mock_post,
    ):
        with pytest.raises(RuntimeError, match="upload boom"):
            await fm.upload_body()

    # No PUT (client doesn't announce UPLOADING); upload POST was attempted.
    assert mock_put.await_count == 0
    assert mock_post.await_count == 1
    assert fm.body_status != BodyStatus.READY
    # Temp zip is still cleaned up in finally.
    assert not fake_zip.exists()


@pytest.mark.asyncio
async def test_concurrent_upload_body_fires_single_fs_upload(tmp_path: Path) -> None:
    """Two callers racing upload_body() for the SAME FM must coalesce into ONE
    fs/upload POST — not two concurrent, blob-clobbering sessions to one hub
    VFSPath (RCA debug_log.md #11: the double fs/upload race lost the blob and
    404'd every downstream download).

    Mirrors production: the auto background upload and the explicit upload_body
    action hold two distinct FlowMessage instances for the same fm.id. Both must
    end READY, but the real upload (to_file + fs/upload) runs exactly once; the
    second caller awaits the first's in-flight task.
    """
    fm_id = "aaaaaaaa-0000-0000-0000-000000000042"

    def _fm() -> FlowMessage:
        fm = _fm_with_file_attachment()
        fm.id = fm_id
        return fm

    fm_auto, fm_explicit = _fm(), _fm()

    fake_zip = tmp_path / "body.flowmsg"
    fake_zip.write_bytes(b"PK\x03\x04 pretend zip")

    # to_file yields a fresh temp path per real invocation (each is unlink'd in
    # the finally); count calls to prove packing runs once under coalescing.
    to_file_calls = 0

    async def _fake_to_file(*_a, **_k) -> Path:
        nonlocal to_file_calls
        to_file_calls += 1
        p = tmp_path / f"body-{to_file_calls}.flowmsg"
        p.write_bytes(fake_zip.read_bytes())
        return p

    async def _fake_post(*_a, **kwargs):
        # Yield control so the owner's task is genuinely in-flight when the
        # second caller checks the guard — proves coalescing, not luck.
        await asyncio.sleep(0)
        return {}

    with (
        patch("flow_sdk.builtin.flow_message.FlowMessage.to_file", _fake_to_file),
        patch("flow_sdk.utils.hub.hub_put", AsyncMock(return_value={})),
        patch("flow_sdk.utils.hub.hub_post", AsyncMock(side_effect=_fake_post)) as mock_post,
    ):
        await asyncio.gather(fm_auto.upload_body(), fm_explicit.upload_body())

    # Exactly one real upload path ran: one packing, one fs/upload POST, one
    # set_body_status POST (2 total). The second caller fired neither.
    assert to_file_calls == 1
    fs_upload_posts = [c for c in mock_post.await_args_list if "files" in c.kwargs]
    set_status_posts = [
        c for c in mock_post.await_args_list if c.kwargs.get("action") == "set_body_status"
    ]
    assert len(fs_upload_posts) == 1, "double fs/upload race not coalesced"
    assert len(set_status_posts) == 1

    # Both callers observe READY on their own instance.
    assert fm_auto.body_status == BodyStatus.READY
    assert fm_auto.attachment_filename == BODY_FILENAME
    assert fm_explicit.body_status == BodyStatus.READY
    assert fm_explicit.attachment_filename == BODY_FILENAME


@pytest.mark.asyncio
async def test_sequential_upload_body_reuploads(tmp_path: Path) -> None:
    """Coalescing is in-flight only: once an upload completes and the guard is
    cleared, a later sequential call re-uploads (retry semantics preserved)."""
    fm = _fm_with_file_attachment()
    fake_zip = tmp_path / "body.flowmsg"

    async def _fake_to_file(*_a, **_k) -> Path:
        fake_zip.write_bytes(b"PK\x03\x04")
        return fake_zip

    with (
        patch("flow_sdk.builtin.flow_message.FlowMessage.to_file", _fake_to_file),
        patch("flow_sdk.utils.hub.hub_put", AsyncMock(return_value={})),
        patch("flow_sdk.utils.hub.hub_post", AsyncMock(return_value={})) as mock_post,
    ):
        await fm.upload_body()
        await fm.upload_body()

    # Two sequential calls → two fs/upload POSTs (one each), guard cleared between.
    fs_upload_posts = [c for c in mock_post.await_args_list if "files" in c.kwargs]
    assert len(fs_upload_posts) == 2


@pytest.mark.asyncio
async def test_concurrent_upload_body_failure_propagates_to_both(tmp_path: Path) -> None:
    """If the single in-flight upload fails, BOTH the owner and the coalesced
    waiter observe the exception and neither instance flips READY."""
    fm_id = "aaaaaaaa-0000-0000-0000-000000000043"

    def _fm() -> FlowMessage:
        fm = _fm_with_file_attachment()
        fm.id = fm_id
        return fm

    fm_a, fm_b = _fm(), _fm()

    async def _fake_to_file(*_a, **_k) -> Path:
        p = tmp_path / "body.flowmsg"
        p.write_bytes(b"PK\x03\x04")
        return p

    async def _boom(*_a, **_k):
        await asyncio.sleep(0)
        raise RuntimeError("upload boom")

    with (
        patch("flow_sdk.builtin.flow_message.FlowMessage.to_file", _fake_to_file),
        patch("flow_sdk.utils.hub.hub_put", AsyncMock(return_value={})),
        patch("flow_sdk.utils.hub.hub_post", AsyncMock(side_effect=_boom)),
    ):
        results = await asyncio.gather(
            fm_a.upload_body(), fm_b.upload_body(), return_exceptions=True
        )

    assert all(isinstance(r, RuntimeError) for r in results)
    assert fm_a.body_status != BodyStatus.READY
    assert fm_b.body_status != BodyStatus.READY


@pytest.mark.asyncio
async def test_upload_body_requires_id() -> None:
    fm = FlowMessage(
        text="t",
        attachment=[Attachment(attachment_type=AttachmentType.FILE, data="data/x")],
    )
    fm.id = None
    with pytest.raises(ValueError, match="upload_body requires self.id"):
        await fm.upload_body()
