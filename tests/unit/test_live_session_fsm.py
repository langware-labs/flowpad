"""Live-session FSM + wire-derivation unit pins.

Pure logic, no DB: the ``can_transition`` lifecycle matrix, the
``apply_snapshot`` merge discipline (host rows never regressed, guest rows
adopt host-authoritative fields only on a fresher activity clock), and
``derive_session_fields`` (refilling hub-stripped header fields from the
authoritative ``remote_worker_session-<id>`` attachment carrier)."""

from __future__ import annotations

import json

import pytest

from flow_sdk.builtin.flow_message import (
    Attachment,
    AttachmentType,
    FlowMessage,
    FlowMessageKind,
    derive_session_fields,
)
from flow_sdk.builtin.remote_worker_session import (
    ACTIVE_STATUSES,
    TERMINAL_STATUSES,
    RemoteWorkerSession,
    RemoteWorkerSessionStatus as S,
    can_transition,
    is_active,
    is_terminal,
)

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval

SESSION_ID = "a1a1a1a1-0000-4000-8000-00000000c001"


# ── can_transition matrix ────────────────────────────────────────────────────

def test_lifecycle_happy_path():
    assert can_transition(S.DRAFT, S.PENDING)
    assert can_transition(S.PENDING, S.IDLE)          # host approve
    assert can_transition(S.PENDING, S.RUNNING)       # pre-granted approve+run fast path
    assert can_transition(S.IDLE, S.RUNNING)
    assert can_transition(S.RUNNING, S.IDLE)
    assert can_transition(S.IDLE, S.PAUSED)
    assert can_transition(S.RUNNING, S.PAUSED)
    assert can_transition(S.PAUSED, S.IDLE)           # resume
    assert can_transition(S.PENDING, S.DECLINED)


def test_anything_live_can_end():
    for cur in (S.DRAFT, S.PENDING, S.IDLE, S.RUNNING, S.PAUSED, S.ERROR):
        assert can_transition(cur, S.ENDED), cur


def test_terminals_absorb():
    for terminal in TERMINAL_STATUSES:
        for new in S:
            if new == terminal:
                assert can_transition(terminal, new)  # self-transition is a no-op
            else:
                assert not can_transition(terminal, new), (terminal, new)


def test_illegal_moves_rejected():
    assert not can_transition(S.DRAFT, S.IDLE)        # must go through PENDING
    assert not can_transition(S.DRAFT, S.RUNNING)
    assert not can_transition(S.DRAFT, S.DECLINED)    # nothing to decline yet
    assert not can_transition(S.IDLE, S.PENDING)      # no un-approve
    assert not can_transition(S.PAUSED, S.RUNNING)    # resume lands on IDLE
    assert not can_transition(S.IDLE, S.DECLINED)     # decline is a PENDING verb


def test_unknown_current_adopts_any_state():
    # Materializing a snapshot for a session we've never seen.
    assert can_transition(None, S.RUNNING)
    assert can_transition("", S.ENDED)


def test_status_predicates():
    assert ACTIVE_STATUSES == {S.IDLE, S.RUNNING}
    assert is_active(S.IDLE) and is_active(S.RUNNING)
    assert not is_active(S.PAUSED) and not is_active(None)
    assert is_terminal(S.ENDED) and is_terminal(S.DECLINED)
    assert not is_terminal(S.PAUSED) and not is_terminal(None)


# ── apply_snapshot merge discipline ──────────────────────────────────────────

def _snap(**over) -> dict:
    return {
        "id": SESSION_ID,
        "type": "remote_worker_session",
        "conversation_id": "c0c0c0c0-0000-4000-8000-000000000001",
        "host_user_id": "host-hub-id",
        "guest_user_id": "guest-hub-id",
        "host_name": "Alice",
        "guest_name": "Bob",
        "status": S.IDLE.value,
        "last_activity_at": "2026-07-14T10:00:00+00:00",
        "started_at": "2026-07-14T09:00:00+00:00",
        # Host-local fields must be ignored even if a hostile/buggy sender
        # smuggled them into a snapshot.
        "host_process_id": "should-never-land",
        "project_id": "should-never-land",
        **over,
    }


def test_snapshot_materializes_fresh_row():
    rws = RemoteWorkerSession.apply_snapshot(None, _snap(), local_is_host=False)
    assert rws.id == SESSION_ID
    assert rws.status == S.IDLE.value
    assert rws.host_name == "Alice"
    # Non-snapshot fields never travel.
    assert rws.host_process_id is None
    assert rws.project_id is None


def test_guest_adopts_only_fresher_clock():
    local = RemoteWorkerSession(
        id=SESSION_ID, status=S.RUNNING.value,
        last_activity_at="2026-07-14T10:30:00+00:00",
    )
    # Older snapshot → host-authoritative fields ignored.
    out = RemoteWorkerSession.apply_snapshot(
        local, _snap(status=S.IDLE.value, last_activity_at="2026-07-14T10:00:00+00:00"),
        local_is_host=False,
    )
    assert out.status == S.RUNNING.value
    # Fresher snapshot → adopted.
    out = RemoteWorkerSession.apply_snapshot(
        out, _snap(status=S.ENDED.value, last_activity_at="2026-07-14T11:00:00+00:00"),
        local_is_host=False,
    )
    assert out.status == S.ENDED.value
    assert out.last_activity_at == "2026-07-14T11:00:00+00:00"


def test_guest_draft_never_regressed_by_clockless_snapshot():
    local = RemoteWorkerSession(id=SESSION_ID, status=S.PENDING.value,
                                last_activity_at="2026-07-14T10:00:00+00:00")
    out = RemoteWorkerSession.apply_snapshot(
        local, _snap(status=S.DRAFT.value, last_activity_at=None), local_is_host=False,
    )
    assert out.status == S.PENDING.value


def test_host_row_is_authoritative():
    local = RemoteWorkerSession(
        id=SESSION_ID, status=S.RUNNING.value, host_process_id="ap-123",
        project_id="proj-1", last_activity_at="2026-07-14T09:00:00+00:00",
    )
    out = RemoteWorkerSession.apply_snapshot(
        local, _snap(status=S.ENDED.value, last_activity_at="2026-07-14T12:00:00+00:00",
                     guest_name="Bob"),
        local_is_host=True,
    )
    # Even a fresher snapshot never writes host state on the host.
    assert out.status == S.RUNNING.value
    assert out.host_process_id == "ap-123"
    assert out.project_id == "proj-1"
    # ...but missing identity fields fill-merge (guest-minted DRAFT info).
    assert out.guest_name == "Bob"


def test_host_row_heals_missing_own_identity():
    # A first carrier packed before the guest's roster resolved the peer ships
    # host_user_id=None; the host row materialized from it has no identity
    # (isHost false → no Approve bar). A later, correct snapshot must fill it —
    # the latch that made that state permanent is the bug this pins.
    orphan = RemoteWorkerSession.apply_snapshot(
        None, _snap(host_user_id=None, host_name=None), local_is_host=False,
    )
    assert orphan.host_user_id is None
    healed = RemoteWorkerSession.apply_snapshot(orphan, _snap(), local_is_host=True)
    assert healed.host_user_id == "host-hub-id"
    assert healed.host_name == "Alice"


def test_host_identity_never_overwritten_by_snapshot():
    local = RemoteWorkerSession(
        id=SESSION_ID, status=S.RUNNING.value,
        host_user_id="real-host-id", host_name="Real Host",
    )
    out = RemoteWorkerSession.apply_snapshot(
        local, _snap(host_user_id="impostor-id", host_name="Impostor"),
        local_is_host=True,
    )
    assert out.host_user_id == "real-host-id"
    assert out.host_name == "Real Host"


def test_snapshot_never_touches_host_local_fields_on_guest():
    local = RemoteWorkerSession(id=SESSION_ID, status=S.IDLE.value)
    out = RemoteWorkerSession.apply_snapshot(local, _snap(), local_is_host=False)
    assert out.host_process_id is None
    assert out.project_id is None


# ── derive_session_fields (F1 hub-strip fallback) ────────────────────────────

def _carrier(preview: str | None = None) -> Attachment:
    return Attachment(
        attachment_type=AttachmentType.TYPE_ID,
        data=f"remote_worker_session-{SESSION_ID}",
        prompt_preview=preview,
    )


def test_derives_session_id_from_carrier():
    fm = FlowMessage(text="hi", attachment=[_carrier()])
    derive_session_fields(fm)
    assert fm.remote_worker_session_id == SESSION_ID
    assert fm.kind == FlowMessageKind.USER


def test_derives_session_event_kind_from_marker():
    fm = FlowMessage(
        text="Alice approved the live session",
        attachment=[_carrier(json.dumps({"live_session_event": "approved"}))],
    )
    derive_session_fields(fm)
    assert fm.remote_worker_session_id == SESSION_ID
    assert fm.kind == FlowMessageKind.SESSION_EVENT


def test_derivation_is_idempotent_and_preserves_stamped_fields():
    fm = FlowMessage(text="hi", attachment=[_carrier()],
                     remote_worker_session_id="pre-stamped")
    derive_session_fields(fm)
    assert fm.remote_worker_session_id == "pre-stamped"
    derive_session_fields(fm)
    assert fm.remote_worker_session_id == "pre-stamped"


def test_non_json_preview_is_ignored():
    fm = FlowMessage(text="hi", attachment=[_carrier("not json at all")])
    derive_session_fields(fm)
    assert fm.remote_worker_session_id == SESSION_ID
    assert fm.kind == FlowMessageKind.USER


def test_no_carrier_is_a_noop():
    fm = FlowMessage(text="hi", attachment=[
        Attachment(attachment_type=AttachmentType.TYPE_ID, data="prompt-" + SESSION_ID),
    ])
    derive_session_fields(fm)
    assert fm.remote_worker_session_id is None
    assert fm.kind == FlowMessageKind.USER
