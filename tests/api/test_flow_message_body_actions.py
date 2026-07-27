"""API tests for the three new FlowMessage body-actions.

Covers the local-backend routes that expose the header/body interface:

  GET  /api/v1/graph/flow_message/<id>/has_body
  POST /api/v1/graph/flow_message/<id>/upload_body
  POST /api/v1/graph/flow_message/<id>/download_body

All hub I/O is mocked at ``flow_sdk.utils.hub`` so the tests run hermetically
against the FastAPI app via ``bootstrapped_client`` (the same ASGI client
``tests/api/test_flow_message_actions.py`` uses) — no live hub required.

# do not increase timeout without approval
"""
from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.builtin.flow_message import (
    BODY_FILENAME,
    Attachment,
    AttachmentType,
    BodyStatus,
    FlowMessage,
)


pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _save_local_fm(*, text: str, attachments: list[Attachment] | None = None,
                         body_status: BodyStatus | None = None,
                         attachment_filename: str | None = None) -> str:
    """Persist a FlowMessage to the same DB the FastAPI app reads, return its id.

    Bypasses the hub completely — the body actions resolve the FM locally
    first; only on miss do they fall back to ``hub_get``. For the API tests
    we always want the local path so we exercise the route handler shape,
    not the hub fallback.
    """
    fm = FlowMessage(
        text=text,
        attachment=attachments or [],
        body_status=body_status or BodyStatus.NA,
        attachment_filename=attachment_filename,
    )
    if not fm.id:
        fm.id = FlowMessage.allocate_id(fm.model_dump(mode="python"))
    # `save(owner=None)` skips the owner-relationship branch — fine for the
    # API tests; the route handlers don't gate on ownership.
    await fm.save(None)
    return fm.id


# ---------------------------------------------------------------------------
# has_body
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_has_body_true_for_file_attachment(bootstrapped_client) -> None:
    fm_id = await _save_local_fm(
        text="t",
        attachments=[Attachment(attachment_type=AttachmentType.FILE, data="data/x.png")],
    )
    r = await bootstrapped_client.get(f"/api/v1/graph/flow_message/{fm_id}/has_body")
    assert r.status_code == 200
    body = r.json()
    assert body.get("status") in ("SUCCESS", "success")
    assert body["data"] == {"has_body": True}


@pytest.mark.asyncio
async def test_has_body_false_for_text_only(bootstrapped_client) -> None:
    fm_id = await _save_local_fm(text="plain text, no attachments")
    r = await bootstrapped_client.get(f"/api/v1/graph/flow_message/{fm_id}/has_body")
    assert r.status_code == 200
    assert r.json()["data"] == {"has_body": False}


# ---------------------------------------------------------------------------
# upload_body
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_upload_body_happy_path(bootstrapped_client, tmp_path: Path) -> None:
    """End-to-end shape: handler packs (mocked), POSTs fs/upload (mocked),
    PUTs body_status=READY (mocked), returns 200 with body_status=ready."""
    fm_id = await _save_local_fm(
        text="with body",
        attachments=[Attachment(attachment_type=AttachmentType.FILE, data="data/x.bin")],
        body_status=BodyStatus.NA,
    )
    fake_zip = tmp_path / "body.flowmsg"
    fake_zip.write_bytes(b"PK\x03\x04 fake zip")

    with (
        patch("flow_sdk.builtin.flow_message.FlowMessage.to_file", AsyncMock(return_value=fake_zip)),
        patch("flow_sdk.utils.hub.hub_put", AsyncMock(return_value={})) as mock_put,
        patch("flow_sdk.utils.hub.hub_post", AsyncMock(return_value={})) as mock_post,
    ):
        r = await bootstrapped_client.post(f"/api/v1/graph/flow_message/{fm_id}/upload_body", json={})

    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("status") in ("SUCCESS", "success")
    assert body["data"]["body_status"] == BodyStatus.READY.value
    assert body["data"]["attachment_filename"] == BODY_FILENAME

    # Two POSTs — fs/upload + the set_body_status action (READY flip).
    # No PUT: the hub stamps body_status=UPLOADING server-side (via
    # _attachments_require_body when the message header is created), so
    # the client never needs to PUT it. See flow_message.upload_body
    # docstring for the rationale.
    assert mock_put.await_count == 0
    assert mock_post.await_count == 2
    upload_files = mock_post.await_args_list[0].kwargs["files"]
    filename, _content, ctype = upload_files["uploaded_file"]
    assert filename == BODY_FILENAME
    assert ctype == "application/zip"


@pytest.mark.asyncio
async def test_upload_body_accepts_git_transfer_mode(bootstrapped_client, tmp_path: Path) -> None:
    fm_id = await _save_local_fm(
        text="with git body",
        attachments=[Attachment(attachment_type=AttachmentType.TYPE_ID, data="skill-deadbeef")],
        body_status=BodyStatus.NA,
    )
    fake_zip = tmp_path / "body.flowmsg"
    fake_zip.write_bytes(b"PK\x03\x04 fake git zip")
    to_file = AsyncMock(return_value=fake_zip)

    with (
        patch("flow_sdk.builtin.flow_message.FlowMessage.to_file", to_file),
        patch("flow_sdk.utils.hub.hub_put", AsyncMock(return_value={})),
        patch("flow_sdk.utils.hub.hub_post", AsyncMock(return_value={})),
    ):
        r = await bootstrapped_client.post(
            f"/api/v1/graph/flow_message/{fm_id}/upload_body",
            json={"transfer_mode": "git"},
        )

    assert r.status_code == 200, r.text
    to_file.assert_awaited_once_with(transfer_mode="git", create_bookmark=False)


@pytest.mark.asyncio
async def test_upload_body_404_when_entity_missing(
    bootstrapped_client,
) -> None:
    """Unknown FM id → the graph-route framework returns a 404 before the
    handler even runs (target_entity_typeid resolution fails)."""
    bogus_id = "00000000-0000-0000-0000-000000000abc"
    r = await bootstrapped_client.post(
        f"/api/v1/graph/flow_message/{bogus_id}/upload_body", json={},
    )
    assert r.status_code == 404, r.text
    body = r.json()
    assert "not found" in (body.get("message") or "").lower()


# ---------------------------------------------------------------------------
# download_body
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_download_body_happy_path(bootstrapped_client) -> None:
    fm_id = await _save_local_fm(
        text="t",
        body_status=BodyStatus.READY,
        attachment_filename=BODY_FILENAME,
    )
    with patch(
        "flow_sdk.app.actions.flow_message_action._download_and_unpack_bundle",
        AsyncMock(return_value=True),
    ) as mock_dl:
        r = await bootstrapped_client.post(
            f"/api/v1/graph/flow_message/{fm_id}/download_body", json={},
        )

    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("status") in ("SUCCESS", "success")
    assert body["data"]["body_status"] == BodyStatus.READY.value
    # Asked for the canonical body filename.
    assert mock_dl.await_count == 1
    args = mock_dl.await_args_list[0].args
    assert args[0] == fm_id
    assert args[1] == BODY_FILENAME


@pytest.mark.asyncio
async def test_download_body_refused_while_uploading(bootstrapped_client) -> None:
    """body_status=UPLOADING must refuse with the BodyNotReadyError path."""
    fm_id = await _save_local_fm(
        text="t",
        attachments=[Attachment(attachment_type=AttachmentType.FILE, data="data/x")],
        body_status=BodyStatus.UPLOADING,
    )
    r = await bootstrapped_client.post(
        f"/api/v1/graph/flow_message/{fm_id}/download_body", json={},
    )
    body = r.json()
    assert body.get("status") in ("FAIL", "fail")
    msg = (body.get("message") or "").lower()
    # Either the explicit BodyNotReadyError message or the wrapped
    # download_body failure path — both are acceptable signals.
    assert "uploading" in msg or "not ready" in msg or "refused" in msg or "must be ready" in msg, msg


@pytest.mark.asyncio
async def test_download_body_refused_when_na(bootstrapped_client) -> None:
    """body_status=NA (text-only FM) must also refuse — there's no body."""
    fm_id = await _save_local_fm(text="text only", body_status=BodyStatus.NA)
    r = await bootstrapped_client.post(
        f"/api/v1/graph/flow_message/{fm_id}/download_body", json={},
    )
    body = r.json()
    assert body.get("status") in ("FAIL", "fail")


@pytest.mark.asyncio
async def test_download_body_uses_legacy_attachment_filename(bootstrapped_client) -> None:
    """When the FM stores a legacy slugified filename, the handler honors it
    so pre-refactor conversations still resolve."""
    legacy = "share-notes-7d3a.flowmsg"
    fm_id = await _save_local_fm(
        text="t",
        body_status=BodyStatus.READY,
        attachment_filename=legacy,
    )
    with patch(
        "flow_sdk.app.actions.flow_message_action._download_and_unpack_bundle",
        AsyncMock(return_value=True),
    ) as mock_dl:
        r = await bootstrapped_client.post(
            f"/api/v1/graph/flow_message/{fm_id}/download_body", json={},
        )
    assert r.status_code == 200
    assert r.json().get("status") in ("SUCCESS", "success")
    assert mock_dl.await_args_list[0].args[1] == legacy


# ---------------------------------------------------------------------------
# download_body — 409 envelopes + overwrite plumbing (handle_download_body)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_download_body_409_envelopes_and_overwrite_plumbing(
    bootstrapped_client,
) -> None:
    """Drive the error branches of ``handle_download_body`` through the ASGI
    client, plus the ``overwrite`` plumb-through.

    The real ``download_body`` runs end-to-end (READY gate + filename resolution)
    and delegates to ``_download_and_unpack_bundle``; we stub only that delegate
    (same seam the happy-path tests use) so each underlying exception travels the
    genuine ``FlowMessage.download_body`` → ``handle_download_body`` path and
    lands in the documented envelope branch. (There is no needs_project branch
    anymore — downloads STAGE and never require a mapped project.)
    """
    from flow_sdk.builtin.flow_message_bundle import FlowMessageExistsError

    DL = "flow_sdk.app.actions.flow_message_action._download_and_unpack_bundle"

    # (a) FlowMessageExistsError → 409 {asset_conflict: True, conflicts: [...]}.
    conflicts = [{"type": "markdown", "id": "11111111-1111-4111-8111-111111111111"}]
    fm_conflict = await _save_local_fm(
        text="conflict",
        body_status=BodyStatus.READY,
        attachment_filename=BODY_FILENAME,
    )
    with patch(DL, AsyncMock(side_effect=FlowMessageExistsError(conflicts))):
        r = await bootstrapped_client.post(
            f"/api/v1/graph/flow_message/{fm_conflict}/download_body", json={},
        )
    assert r.status_code == 409, r.text
    body = r.json()
    assert body.get("status") in ("FAIL", "fail")
    assert body["data"]["asset_conflict"] is True
    assert body["data"]["conflicts"] == conflicts

    # (b) overwrite=True in the POST body reaches _download_and_unpack_bundle.
    fm_ovr = await _save_local_fm(
        text="overwrite",
        body_status=BodyStatus.READY,
        attachment_filename=BODY_FILENAME,
    )
    with patch(DL, AsyncMock(return_value=True)) as mock_dl:
        r = await bootstrapped_client.post(
            f"/api/v1/graph/flow_message/{fm_ovr}/download_body",
            json={"overwrite": True},
        )
    assert r.status_code == 200, r.text
    assert r.json().get("status") in ("SUCCESS", "success")
    assert mock_dl.await_count == 1
    assert mock_dl.await_args.kwargs["overwrite"] is True
    # And the explicit download path opts into hard failures (not log-and-drop).
    assert mock_dl.await_args.kwargs["raise_on_conflict"] is True

    # Control: omitting overwrite defaults it to False on the same seam.
    fm_default = await _save_local_fm(
        text="overwrite-default",
        body_status=BodyStatus.READY,
        attachment_filename=BODY_FILENAME,
    )
    with patch(DL, AsyncMock(return_value=True)) as mock_dl_default:
        r = await bootstrapped_client.post(
            f"/api/v1/graph/flow_message/{fm_default}/download_body", json={},
        )
    assert r.status_code == 200, r.text
    assert mock_dl_default.await_args.kwargs["overwrite"] is False

    # (d) BodyNotReadyError path → HTTP 409 (refused before any download).
    # body_status != READY is rejected inside FlowMessage.download_body itself,
    # so _download_and_unpack_bundle is never reached.
    fm_uploading = await _save_local_fm(
        text="still-uploading",
        attachments=[Attachment(attachment_type=AttachmentType.FILE, data="data/x")],
        body_status=BodyStatus.UPLOADING,
    )
    with patch(DL, AsyncMock(return_value=True)) as mock_dl_never:
        r = await bootstrapped_client.post(
            f"/api/v1/graph/flow_message/{fm_uploading}/download_body", json={},
        )
    assert r.status_code == 409, r.text
    body = r.json()
    assert body.get("status") in ("FAIL", "fail")
    assert "ready" in (body.get("message") or "").lower()
    assert mock_dl_never.await_count == 0
