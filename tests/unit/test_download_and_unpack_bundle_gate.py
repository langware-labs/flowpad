"""Unit tests for the single backend download gate.

``_download_and_unpack_bundle`` is the one chokepoint every bundle pull funnels
through. The body-status gate lives HERE (and only here) for the implicit
callers: when ``body_status`` is anything other than READY there is no bundle on
the hub to fetch, so the function must skip the hub GET entirely rather than
404. ``None`` means "caller did not supply a status" and proceeds unchanged.

Two more invariants of that chokepoint live here (FLOWPAD-2153): a bundle that
is already staged in full is never pulled again, and every exit path ends by
fanning the settled state — so a client can never be left holding a half-state
that only a page reload cleared.

# do not increase timeout without approval
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flow_sdk.app.actions.flow_message_action import _download_and_unpack_bundle
from flow_sdk.builtin.flow_message import BodyStatus, FlowMessage
from flow_sdk.builtin.flow_message_bundle import FlowMessageExistsError

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

FM_ID = "aaaaaaaa-0000-0000-0000-000000000001"


def _fake_fm(*, is_complete: bool) -> MagicMock:
    """A stand-in row whose staging state is dictated, not stat-ed off disk.

    These tests pin the ordering between the pull and the staging tree, so the
    disk probe is the part to hold fixed rather than reproduce.
    """
    fm = MagicMock(spec=FlowMessage)
    fm.id = FM_ID
    fm.body_status = BodyStatus.READY
    fm.is_body_complete.return_value = is_complete
    fm.notify_updated = AsyncMock()
    fm.save = AsyncMock()
    return fm


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


@pytest.mark.asyncio
async def test_same_message_downloads_are_serialized() -> None:
    """Two pull sources for one FM cannot overlap the shared staging update."""
    first_entered = asyncio.Event()
    release_first = asyncio.Event()
    active = 0
    max_active = 0
    calls = 0

    async def controlled_get(*args, **kwargs) -> bytes:
        nonlocal active, max_active, calls
        calls += 1
        active += 1
        max_active = max(max_active, active)
        try:
            if calls == 1:
                first_entered.set()
                await release_first.wait()
            return b""
        finally:
            active -= 1

    with patch("flow_sdk.app.actions.flow_message_action.hub_get", controlled_get):
        first = asyncio.create_task(_download_and_unpack_bundle(FM_ID, "body.flowmsg", body_status=BodyStatus.READY))
        await first_entered.wait()
        second = asyncio.create_task(_download_and_unpack_bundle(FM_ID, "body.flowmsg", body_status=BodyStatus.READY))
        await asyncio.sleep(0)
        assert calls == 1, "the second pull must wait outside hub_get/unpack"
        release_first.set()
        assert await asyncio.gather(first, second) == [False, False]

    assert calls == 2
    assert max_active == 1


@pytest.mark.asyncio
async def test_complete_bundle_is_not_pulled_again() -> None:
    """A fully-staged message short-circuits: no hub GET, no destructive re-unpack.

    FLOWPAD-2153. The auto-pull on conversation-open and the user's own Download
    click routinely land within the same second. The second pull can add nothing,
    but re-unpacking REPLACES ``unpacked/`` wholesale — and a serialization that
    lands inside that swap publishes the tree as unpacked with its entries gone,
    i.e. the sticky "pulled, but arrived short" false warning. Not pulling is
    what keeps that window shut.
    """
    complete = _fake_fm(is_complete=True)
    with (
        patch("flow_sdk.app.actions.flow_message_action.hub_get", AsyncMock()) as mock_get,
        patch.object(FlowMessage, "get_one", AsyncMock(return_value=complete)),
    ):
        result = await _download_and_unpack_bundle(FM_ID, "body.flowmsg", body_status=BodyStatus.READY)

    assert result is True, "already staged in full counts as a successful pull"
    assert mock_get.await_count == 0, "must not re-fetch a bundle that is already staged in full"


@pytest.mark.asyncio
async def test_short_bundle_is_pulled_again() -> None:
    """An unpacked-but-SHORT message still re-pulls — ``is_body_downloaded`` is
    true there, so gating on it would strand a genuinely incomplete message."""
    short = _fake_fm(is_complete=False)
    with (
        patch("flow_sdk.app.actions.flow_message_action.hub_get", AsyncMock(return_value=b"")) as mock_get,
        patch.object(FlowMessage, "get_one", AsyncMock(return_value=short)),
    ):
        await _download_and_unpack_bundle(FM_ID, "body.flowmsg", body_status=BodyStatus.READY)

    assert mock_get.await_count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("bundle_bytes", [b"", None])
async def test_settled_update_fans_out_on_every_exit(bundle_bytes) -> None:
    """Even a pull that returns nothing ends with a fresh UPDATE.

    FLOWPAD-2153. ``body_downloaded`` / ``body_missing_attachments`` are derived
    from disk at serialize time, so an UPDATE that raced an unpack could strand
    the UI on a half-state no later event corrected — the user had to reload the
    tab. The last word must always be the settled state, on every exit path.
    """
    fm = _fake_fm(is_complete=False)
    with (
        patch("flow_sdk.app.actions.flow_message_action.hub_get", AsyncMock(return_value=bundle_bytes)),
        patch.object(FlowMessage, "get_one", AsyncMock(return_value=fm)),
    ):
        result = await _download_and_unpack_bundle(FM_ID, "body.flowmsg", body_status=BodyStatus.READY)

    assert result is False
    assert fm.notify_updated.await_count == 1


@pytest.mark.asyncio
async def test_settled_update_fans_out_when_the_unpack_raises() -> None:
    """A conflict propagates to the caller AND still leaves the client settled."""
    fm = _fake_fm(is_complete=False)
    with (
        patch("flow_sdk.app.actions.flow_message_action.hub_get", AsyncMock(return_value=b"zip-bytes")),
        patch.object(FlowMessage, "get_one", AsyncMock(return_value=fm)),
        patch(
            "flow_sdk.builtin.flow_message_bundle.unpack_bundle",
            AsyncMock(side_effect=FlowMessageExistsError("collision")),
        ),
    ):
        with pytest.raises(FlowMessageExistsError):
            await _download_and_unpack_bundle(
                FM_ID, "body.flowmsg", body_status=BodyStatus.READY, raise_on_conflict=True
            )

    assert fm.notify_updated.await_count == 1
