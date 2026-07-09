"""Regression: a bundle-carrying hub message materialises its FlowMessage HEADER
even when the bundle body can't be downloaded yet.

RCA #14 (2026-07-08 QA cycle): a shared conversation whose latest message carried
a git/asset ARTIFACT (``attachment_filename`` + ``asset_references``) never
materialised its FlowMessage entity on the recipient PRE-ACCEPT, while a plain
TEXT message did. The inbox's latest-pointer visibility gate then hid the whole
invitation row. Root cause in ``_process_single_hub_message``: when the message
advertised a bundle but the download failed (body still uploading, or — pre-accept
— the recipient can't pull the bundle yet) AND no row existed, the function
``return``ed ``None`` and left nothing behind. A text message (no
``attachment_filename``) instead fell through and persisted its header from the
hub payload.

The fix drops that special-case early-return: on a failed download with no
existing row, the header is materialised from the hub payload (metadata only, no
body) exactly like the text branch. The body stays un-downloaded, so the next
sync pass re-attempts the bundle (the download gate is keyed on body-presence,
not row existence).

# do not increase timeout without approval
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.app.actions import flow_message_action as fma
from flow_sdk.builtin.flow_message import FlowMessage


pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

_FM_ID = "aaaaaaaa-0000-4000-8000-000000000abc"
_CONV_ID = "bbbbbbbb-0000-4000-8000-000000000def"


def _artifact_hub_payload() -> dict:
    """A hub FM dict for a git/asset-share message: it advertises a bundle
    (``attachment_filename``) and carries artifact metadata, but the body is not
    yet locally downloadable."""
    return {
        "id": _FM_ID,
        "type": "flow_message",
        "text": "shared a workflow",
        "conversation_id": _CONV_ID,
        "sender_id": "cccccccc-0000-4000-8000-000000000001",
        "sender_name": "Alice",
        "attachment_filename": f"flow_message-{_FM_ID}.flowmsg",
        "body_status": "ready",
        "asset_references": [{"type": "workflow", "id": "dddddddd-0000-4000-8000-000000000002"}],
    }


@pytest.mark.asyncio
async def test_artifact_header_materializes_when_bundle_download_fails(
    initialize_test_db,
) -> None:
    """Download fails + no existing row → the FM header is still persisted from
    the hub payload (metadata only), so the message resolves locally pre-body."""
    saved: dict[str, FlowMessage] = {}

    async def _fake_save(self: FlowMessage) -> FlowMessage:
        saved["fm"] = self
        return self

    with (
        patch.object(fma.FlowMessage, "get_one", new=AsyncMock(return_value=None)),
        # Pre-accept / still-uploading: the bundle can't be pulled → False.
        patch.object(fma, "_download_and_unpack_bundle", new=AsyncMock(return_value=False)),
        patch.object(fma.FlowMessage, "save", new=_fake_save),
        # Pointer-append is best-effort and conversation-file-bound; stub the
        # jsonl read so the header-materialisation is what we isolate.
        patch.object(fma, "from_jsonl", side_effect=RuntimeError("no conv file in unit test")),
    ):
        result = await fma._process_single_hub_message(_artifact_hub_payload())

    # The header was materialised (not dropped) — the message resolves locally.
    assert result == _FM_ID
    fm = saved.get("fm")
    assert fm is not None, "artifact message header must be persisted even without its body"
    assert fm.id == _FM_ID
    assert fm.remote is True
    # It is a HEADER only — the body is not downloaded, so a later sync pass
    # re-attempts the bundle (the download gate is keyed on body-presence).
    assert fm.is_body_downloaded() is False
    # The artifact metadata rode along from the hub payload.
    assert fm.attachment_filename == f"flow_message-{_FM_ID}.flowmsg"


@pytest.mark.asyncio
async def test_artifact_success_does_not_double_persist(initialize_test_db) -> None:
    """When the bundle download SUCCEEDS with no existing row, unpack already
    materialised the row — the function returns without re-persisting a header."""
    save_spy = AsyncMock()

    with (
        patch.object(fma.FlowMessage, "get_one", new=AsyncMock(return_value=None)),
        patch.object(fma, "_download_and_unpack_bundle", new=AsyncMock(return_value=True)),
        patch.object(fma.FlowMessage, "save", new=save_spy),
        patch.object(fma, "from_jsonl", side_effect=RuntimeError("must not reach pointer-append")),
    ):
        result = await fma._process_single_hub_message(_artifact_hub_payload())

    assert result == _FM_ID
    # unpack owns the row on the success path — no second header save here.
    assert save_spy.await_count == 0
