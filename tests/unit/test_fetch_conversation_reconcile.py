"""Authoritative reconcile in ``_fetch_conversation_messages``.

The hub child list IS the conversation's message set: after the per-message
LWW pass, conversation.jsonl is rewritten to exactly
``(hub children, created_date order) ∪ (local-pending not yet on the hub)``
and the entity projection is recomputed unconditionally. These tests pin the
rewrite semantics:

* bare Conversation row + intact jsonl  → projection recomputed (the Jun-4
  prod incident shape: every pointer "already present" must no longer dead-end),
* hub-side delete                       → stale local pointer dropped,
* each local-pending predicate          → pointer survives the rewrite,
* FM row unloadable                     → fail-closed keep,
* pointer lost from the file (orphan)   → restored from the hub list,
* hub listing unavailable (None)        → local state untouched,
* hub listing EMPTY (a real answer)     → remote pointers dropped.
"""

from __future__ import annotations

import asyncio
import os
from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.app.actions.flow_message_action import (
    _conv_fetch_inflight,
    _drain_conversation_message_fetches,
    _fetch_conversation_messages,
)
from flow_sdk.builtin.conversation import _PROJECTION_SENTINEL
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.fs_store.operations.conversation import default_jsonl_path
from flow_sdk.fs_store.pointer import Pointer
from flow_sdk.fs_store.type_id import TypeId

_TS = "2026-06-01T10:00:00Z"


def _hub_child(fm_id: str, created: str = _TS) -> dict:
    return {"id": fm_id, "text": "m", "created_date": created, "updated_date": created}


def _fm(fm_id: str, **over) -> FlowMessage:
    base = {"id": fm_id, "text": "m", "delivery_status": "sent", "remote": True}
    base.update(over)
    return FlowMessage.model_validate(base)


def _write_jsonl(conv_id: str, fm_ids: list[str]) -> None:
    path = default_jsonl_path(conv_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [Pointer(TypeId(type="flow_message", id=i), _TS).to_jsonl_line() for i in fm_ids]
    path.write_text("".join(line + "\n" for line in lines))


def _pointer_ids(conv_id: str) -> list[str]:
    path = default_jsonl_path(conv_id)
    if not path.exists():
        return []
    return [Pointer.from_jsonl_line(line).id for line in path.read_text().splitlines() if line.strip()]


async def _run(conv_id: str, hub_children, fm_by_id: dict[str, FlowMessage | Exception]):
    """Drive _fetch_conversation_messages with hub + FM lookups mocked.

    ``fm_by_id`` maps id → FlowMessage (current rows; is_stale=False so the
    LWW loop is a pure skip and the reconcile is what's under test), or an
    Exception instance to simulate an unloadable row.
    """

    async def fake_get_one(query):
        val = fm_by_id.get(query.get("id"))
        if isinstance(val, Exception):
            raise val
        return val

    project_mock = AsyncMock(return_value=None)
    with (
        patch(
            "flow_sdk.app.actions.flow_message_action.hub_get",
            new=AsyncMock(return_value=hub_children),
        ),
        patch.object(FlowMessage, "get_one", new=AsyncMock(side_effect=fake_get_one)),
        patch(
            "flow_sdk.app.actions.flow_message_action._process_single_hub_message",
            new=AsyncMock(return_value=None),
        ),
        patch(
            "flow_sdk.app.actions.flow_message_action.project_pointers_to_entity",
            new=project_mock,
        ),
    ):
        await _fetch_conversation_messages(conv_id, someone_typeid="user-x")
    return project_mock


@pytest.mark.asyncio
async def test_overlapping_drains_claim_each_conversation_once():
    """StrictMode can dispatch two list reconciles in the same event-loop
    turn. The detached drains must atomically claim an id before their first
    await; checking ``Lock.locked()`` before the semaphore let both copies
    queue and fetch the same conversation serially."""
    conv_id = "aaaa0010-1111-4111-8111-000000000010"
    started = asyncio.Event()
    release = asyncio.Event()
    calls = 0

    async def fake_fetch(_conv_id, _someone_typeid):
        nonlocal calls
        calls += 1
        started.set()
        await release.wait()

    _conv_fetch_inflight.clear()
    with patch(
        "flow_sdk.app.actions.flow_message_action._fetch_conversation_messages",
        new=fake_fetch,
    ):
        first = asyncio.create_task(
            _drain_conversation_message_fetches([conv_id], "user-x"),
        )
        await started.wait()
        second = asyncio.create_task(
            _drain_conversation_message_fetches([conv_id], "user-x"),
        )
        try:
            # The overlapping drain observes the existing atomic claim and
            # finishes without entering fake_fetch.
            await second
            assert calls == 1
        finally:
            release.set()
            await asyncio.gather(first, second)
            _conv_fetch_inflight.clear()


@pytest.fixture(autouse=True)
def _records_root(monkeypatch, tmp_path):
    monkeypatch.setattr(
        "flow_sdk.fs_store.record_paths.get_default_records_data_root",
        lambda: tmp_path,
    )


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_bare_row_reprojects_when_everything_current():
    """The prod incident shape: all pointers already on disk, all FM rows
    current — the pass must STILL re-project (it used to dead-end with
    'synced 0 of N' and leave a bare row empty forever)."""
    conv = "aaaa0001-1111-4111-8111-000000000001"
    ids = ["bbbb0001-1111-4111-8111-00000000000%d" % i for i in range(1, 4)]
    _write_jsonl(conv, ids)
    project_mock = await _run(conv, [_hub_child(i) for i in ids], {i: _fm(i) for i in ids})

    assert _pointer_ids(conv) == ids  # rewrite preserved the full set
    project_mock.assert_awaited()  # projection ALWAYS recomputed


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_in_sync_reconcile_leaves_jsonl_untouched():
    """A reconcile whose merged pointer set already matches the on-disk index
    must NOT rewrite the file. The record freshness fingerprint is mtime+size,
    so a byte-identical rewrite still reads as "source changed" and re-arms the
    GET-time record refresh — which stamped phantom ``updated_date`` bumps on
    remote conversations (the "1m last activity with no new message" bug)."""
    conv = "aaaa0008-1111-4111-8111-000000000008"
    ids = ["bbbb0008-1111-4111-8111-00000000000%d" % i for i in range(1, 3)]
    _write_jsonl(conv, ids)
    path = default_jsonl_path(conv)
    # Pin a fixed past mtime so any rewrite is detectable regardless of the
    # filesystem's timestamp resolution.
    os.utime(path, (1_000_000_000, 1_000_000_000))
    before = path.stat().st_mtime_ns

    await _run(conv, [_hub_child(i) for i in ids], {i: _fm(i) for i in ids})

    assert path.stat().st_mtime_ns == before  # file not rewritten
    assert _pointer_ids(conv) == ids  # and still holds the same set


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_ready_body_reconciles_even_when_metadata_is_current():
    """Hub READY is pull-correctness work even with equal metadata clocks.

    A receiver that missed the best-effort READY bridge frame can have the
    exact current header at UPLOADING. Exact conversation sync must still route
    that row through body recovery instead of letting the LWW skip hide it.
    """
    conv = "aaaa0011-1111-4111-8111-000000000011"
    fm_id = "bbbb0011-1111-4111-8111-000000000011"
    _write_jsonl(conv, [fm_id])
    local = _fm(
        fm_id,
        updated_date=_TS,
        body_status="uploading",
        attachment_filename="body.flowmsg",
    )
    hub_child = {
        **_hub_child(fm_id),
        "body_status": "ready",
        "attachment_filename": "body.flowmsg",
    }
    process = AsyncMock(return_value=fm_id)

    with (
        patch(
            "flow_sdk.app.actions.flow_message_action.hub_get",
            new=AsyncMock(return_value=[hub_child]),
        ),
        patch.object(FlowMessage, "get_one", new=AsyncMock(return_value=local)),
        patch(
            "flow_sdk.app.actions.flow_message_action._process_single_hub_message",
            new=process,
        ),
        patch(
            "flow_sdk.app.actions.flow_message_action.project_pointers_to_entity",
            new=AsyncMock(return_value=None),
        ),
    ):
        await _fetch_conversation_messages(conv, someone_typeid="user-x")

    process.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_hub_side_delete_drops_stale_pointer():
    conv = "aaaa0002-1111-4111-8111-000000000002"
    kept = "bbbb0002-1111-4111-8111-000000000001"
    deleted = "bbbb0002-1111-4111-8111-000000000002"
    _write_jsonl(conv, [kept, deleted])
    await _run(conv, [_hub_child(kept)], {kept: _fm(kept), deleted: _fm(deleted)})

    assert _pointer_ids(conv) == [kept]


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.parametrize(
    "pending_fields",
    [
        {"delivery_status": "created", "remote": False},  # pre-accept local send
        {"kind": "invitation", "remote": True},  # invitation placeholder
        {"is_draft": True, "remote": True},  # local draft
        {"remote": False},  # no confirmed hub twin
    ],
    ids=["created", "invitation", "draft", "not-remote"],
)
async def test_local_pending_survives_rewrite(pending_fields):
    conv = "aaaa0003-1111-4111-8111-000000000003"
    on_hub = "bbbb0003-1111-4111-8111-000000000001"
    pending = "bbbb0003-1111-4111-8111-000000000002"
    _write_jsonl(conv, [on_hub, pending])
    await _run(
        conv,
        [_hub_child(on_hub)],
        {on_hub: _fm(on_hub), pending: _fm(pending, **pending_fields)},
    )

    assert set(_pointer_ids(conv)) == {on_hub, pending}


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_invitation_placeholder_is_prepended_and_ts_clamped():
    """A local-only invitation placeholder is the conversation's logical
    first message, but its own ts post-dates the first real message (the
    synth path loses a materialization race) — the rewrite must PREPEND it
    AND clamp its ts to the earliest hub message's, because the UI re-sorts
    bubbles by pointer ts (conversation-items.ts) and would otherwise swap
    the invitation back after the first paint (FLOWPAD-1940)."""
    conv = "aaaa0009-1111-4111-8111-000000000009"
    real = "bbbb0009-1111-4111-8111-000000000001"
    invite = "bbbb0009-1111-4111-8111-000000000002"
    late_ts = "2026-06-01T10:00:00.750Z"  # placeholder lost the race by ~750ms
    # On-disk shape is the bug shape: real message first, invitation last.
    path = default_jsonl_path(conv)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        Pointer(TypeId(type="flow_message", id=real), _TS).to_jsonl_line()
        + "\n"
        + Pointer(TypeId(type="flow_message", id=invite), late_ts).to_jsonl_line()
        + "\n"
    )
    await _run(
        conv,
        [_hub_child(real)],
        {real: _fm(real), invite: _fm(invite, kind="invitation", remote=True)},
    )

    assert _pointer_ids(conv) == [invite, real]
    ptrs = [Pointer.from_jsonl_line(line) for line in path.read_text().splitlines() if line.strip()]
    # Clamped to the real message's ts — a tie, which the UI's stable sort
    # resolves by list order, keeping the prepended invitation first.
    assert ptrs[0].ts == _TS


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_unloadable_fm_row_is_kept_fail_closed():
    conv = "aaaa0004-1111-4111-8111-000000000004"
    on_hub = "bbbb0004-1111-4111-8111-000000000001"
    broken = "bbbb0004-1111-4111-8111-000000000002"
    _write_jsonl(conv, [on_hub, broken])
    await _run(
        conv,
        [_hub_child(on_hub)],
        {on_hub: _fm(on_hub), broken: RuntimeError("db unavailable")},
    )

    assert set(_pointer_ids(conv)) == {on_hub, broken}


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_orphaned_pointer_restored_from_hub_list():
    """Pointer file lost/empty while the hub has messages → rebuilt."""
    conv = "aaaa0005-1111-4111-8111-000000000005"
    ids = ["bbbb0005-1111-4111-8111-00000000000%d" % i for i in (1, 2)]
    _write_jsonl(conv, [])  # file exists but is empty
    project_mock = await _run(conv, [_hub_child(i) for i in ids], {i: _fm(i) for i in ids})

    assert _pointer_ids(conv) == ids
    project_mock.assert_awaited()


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_hub_unavailable_leaves_local_state_untouched():
    """hub_get returning None means "could not prove anything" — no rewrite,
    no projection."""
    conv = "aaaa0006-1111-4111-8111-000000000006"
    ids = ["bbbb0006-1111-4111-8111-000000000001"]
    _write_jsonl(conv, ids)
    project_mock = await _run(conv, None, {ids[0]: _fm(ids[0])})

    assert _pointer_ids(conv) == ids
    project_mock.assert_not_awaited()


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_should_fetch_rule():
    """The dispatch gate: updated_date LWW OR bidirectional count mismatch;
    hub count None ⇒ date-only (old-hub compatible)."""
    from flow_sdk.app.actions.flow_message_action import _should_fetch_messages
    from flow_sdk.builtin.conversation import Conversation

    ts = "2026-06-01T10:00:00+00:00"
    later = "2026-06-01T11:00:00+00:00"

    def conv(count: int) -> Conversation:
        c = Conversation.model_validate({"id": mint_uuid(), "updated_date": ts})
        c._set_projection("message_count", count, _PROJECTION_SENTINEL)
        if count:
            c._set_projection(
                "message_ids",
                '[{"typeid": "flow_message-x"}]',
                _PROJECTION_SENTINEL,
            )
        return c

    # No local row → fetch.
    assert _should_fetch_messages(None, {"updated_date": ts, "message_count": 1})
    # Hub newer → fetch, regardless of count.
    assert _should_fetch_messages(conv(3), {"updated_date": later, "message_count": 3})
    # Equal date, equal count → in sync, no fetch.
    assert not _should_fetch_messages(conv(3), {"updated_date": ts, "message_count": 3})
    # THE INCIDENT SHAPE: equal date, bare local (0) vs hub N → fetch.
    assert _should_fetch_messages(conv(0), {"updated_date": ts, "message_count": 3})
    # Reverse drift: local has a stale extra after a missed delete → fetch.
    assert _should_fetch_messages(conv(4), {"updated_date": ts, "message_count": 3})
    # Old hub (no count on the wire) → date-only when the local projection is
    # populated…
    assert not _should_fetch_messages(conv(3), {"updated_date": ts})
    assert _should_fetch_messages(conv(3), {"updated_date": later})
    # …but an EMPTY local projection cannot be verified cheaply against an
    # old hub — that's the incident shape, so verify via fetch.
    assert _should_fetch_messages(conv(0), {"updated_date": ts})


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_empty_hub_list_is_a_real_answer():
    """An empty children list reconciles to zero remote pointers (the hub is
    the source of truth) while still keeping local-pending rows."""
    conv = "aaaa0007-1111-4111-8111-000000000007"
    gone = "bbbb0007-1111-4111-8111-000000000001"
    pending = "bbbb0007-1111-4111-8111-000000000002"
    _write_jsonl(conv, [gone, pending])
    project_mock = await _run(
        conv,
        [],
        {gone: _fm(gone), pending: _fm(pending, delivery_status="created", remote=False)},
    )

    assert _pointer_ids(conv) == [pending]
    project_mock.assert_awaited()
