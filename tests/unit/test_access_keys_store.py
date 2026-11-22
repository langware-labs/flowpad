"""The Remote control store (``core/compute/access_keys``): which hub keys this machine accepts, and the window
remote control is open for after a passkey answered one of this machine's challenges.

Time is passed in and the store lives in a temp dir, so nothing here sleeps or touches ``~/.flow``.
"""

from __future__ import annotations

import json
import stat
import threading
from datetime import datetime, timedelta, timezone

import pytest

from flow_sdk.core.compute import access_keys

NODE = "compute_node-8c353ca8-8d88-40f9-8958-020255a952ef"
OTHER_NODE = "compute_node-0d1b6c1e-5a52-4b0c-9a6e-3f1c2d4e5f60"
T0 = datetime(2026, 11, 21, 12, 0, tzinfo=timezone.utc)


@pytest.fixture
def store(tmp_path):
    return tmp_path / "remote_control.json"


def hub_key(credential_id: str, request_id: str | None = None, request_node: str | None = None) -> dict:
    return {
        "id": f"row-{credential_id}",
        "kind": "passkey",
        "credential_id": credential_id,
        "public_key": "cHVibGlj",
        "algorithm": -7,
        "label": "Passkey",
        "code": "0a1b2c3d",
        "request_id": request_id,
        "request_node": request_node,
    }


def states(state: dict) -> dict:
    return {cid: key["state"] for cid, key in state["keys"].items()}


def opened(store, hours: int = 1, now: datetime = T0) -> dict:
    """Remote control opened at ``now`` through a fresh challenge that key ``k1`` answered. Answers the new state."""
    made = access_keys.new_turn_on(hours, now, path=store)
    return access_keys.open_with(made["challenge"], now, credential_id="k1", path=store)


def is_on(store, now: datetime) -> bool:
    return access_keys.is_on(access_keys.read_state(store), now)


def view(store, now: datetime) -> dict:
    return access_keys.status_view(access_keys.read_state(store), reason=None, hostname="host", now=now)


def test_a_key_added_through_this_machines_live_request_is_accepted(store):
    request = access_keys.new_request(now=T0, path=store)
    state = access_keys.apply_hub_keys(
        [hub_key("k1", request["id"], NODE)], NODE, T0 + timedelta(minutes=1), path=store
    )
    assert states(state) == {"k1": "accepted"}
    assert [key["credential_id"] for key in access_keys.machine_access_keys(store)] == ["k1"]
    assert stat.S_IMODE(store.stat().st_mode) == 0o600


def test_an_unknown_request_or_another_node_is_pending(store):
    request = access_keys.new_request(now=T0, path=store)
    hub_keys = [hub_key("unknown", "not-ours", NODE), hub_key("other", request["id"], OTHER_NODE), hub_key("bare")]
    state = access_keys.apply_hub_keys(hub_keys, NODE, T0, path=store)
    assert states(state) == {"unknown": "pending", "other": "pending", "bare": "pending"}
    assert access_keys.machine_access_keys(store) == []


def test_an_expired_request_is_pending(store):
    request = access_keys.new_request(now=T0, path=store)
    late = T0 + access_keys.REQUEST_TTL + timedelta(seconds=1)
    assert states(access_keys.apply_hub_keys([hub_key("k1", request["id"], NODE)], NODE, late, path=store)) == {
        "k1": "pending"
    }


def test_a_pending_key_is_dropped_after_ten_minutes_until_asked_again(store):
    keys = [hub_key("k1")]
    access_keys.apply_hub_keys(keys, NODE, T0, path=store)
    still = access_keys.apply_hub_keys(keys, NODE, T0 + timedelta(minutes=9, seconds=59), path=store)
    assert states(still) == {"k1": "pending"}
    late = T0 + timedelta(minutes=10, seconds=1)
    assert not access_keys.allow("k1", now=late, path=store)
    assert states(access_keys.apply_hub_keys(keys, NODE, late, path=store)) == {}
    assert states(access_keys.apply_hub_keys(keys, NODE, late + timedelta(hours=1), path=store)) == {}
    access_keys.new_request(now=late + timedelta(hours=2), path=store)
    again = access_keys.apply_hub_keys(keys, NODE, late + timedelta(hours=2), path=store)
    assert states(again) == {"k1": "pending"}


def test_allow_accepts_a_pending_key(store):
    access_keys.apply_hub_keys([hub_key("k1")], NODE, T0, path=store)
    assert access_keys.allow("k1", now=T0 + timedelta(minutes=5), path=store)
    assert states(access_keys.read_state(store)) == {"k1": "accepted"}
    assert access_keys.new_turn_on(1, T0 + timedelta(minutes=5), path=store)["hours"] == 1


def test_turning_on_is_refused_with_no_accepted_key(store):
    access_keys.apply_hub_keys([hub_key("pending-only")], NODE, T0, path=store)
    with pytest.raises(access_keys.NoAcceptedKey):
        access_keys.new_turn_on(1, T0, path=store)
    state = access_keys.read_state(store)
    assert state["challenges"] == [] and not access_keys.is_on(state, T0)


@pytest.mark.parametrize("hours", [0, 2, 25, -1, 1.0, "1", True, None])
def test_hours_outside_the_four_choices_are_refused(store, hours):
    access_keys.set_machine_access_key(hub_key("k1"), now=T0, path=store)
    with pytest.raises(access_keys.BadHours):
        access_keys.new_turn_on(hours, T0, path=store)
    assert access_keys.read_state(store)["challenges"] == []


def test_a_challenge_opens_remote_control_for_its_hours(store):
    access_keys.set_machine_access_key(hub_key("k1"), now=T0, path=store)
    made = access_keys.new_turn_on(3, T0, path=store)
    assert made["expires_at"] == (T0 + access_keys.CHALLENGE_TTL).isoformat() and len(made["challenge"]) == 43
    assert not is_on(store, T0), "a challenge alone opens nothing"
    answered_at = T0 + timedelta(minutes=2)
    state = access_keys.open_with(made["challenge"], answered_at, credential_id="k1", sign_count=7, path=store)
    deadline = answered_at + timedelta(hours=3)
    assert state["open_until"] == deadline.isoformat() and state["hours"] == 3 and state["last_off"] is None
    assert state["keys"]["k1"]["sign_count"] == 7
    assert is_on(store, deadline - timedelta(seconds=1)) and not is_on(store, deadline)
    seen = view(store, answered_at)
    assert (seen["on"], seen["open_until"], seen["hours"], seen["last_off"], seen["hours_options"]) == (
        True, deadline.isoformat(), 3, None, [1, 3, 10, 24],
    )  # fmt: skip


def test_a_challenge_is_used_once(store):
    access_keys.set_machine_access_key(hub_key("k1"), now=T0, path=store)
    made = access_keys.new_turn_on(1, T0, path=store)
    access_keys.open_with(made["challenge"], T0, credential_id="k1", path=store)
    access_keys.lock(T0 + timedelta(minutes=1), path=store)
    with pytest.raises(access_keys.ChallengeGone):
        access_keys.open_with(made["challenge"], T0 + timedelta(minutes=2), credential_id="k1", path=store)
    assert not is_on(store, T0 + timedelta(minutes=2))


def test_a_challenge_lives_five_minutes_and_is_pruned_on_the_next_write(store):
    access_keys.set_machine_access_key(hub_key("k1"), now=T0, path=store)
    made = access_keys.new_turn_on(1, T0, path=store)
    last_moment = T0 + timedelta(minutes=4, seconds=59)
    assert access_keys.live_challenges(access_keys.read_state(store), last_moment) == [made["challenge"]]
    late = T0 + timedelta(minutes=5)
    assert access_keys.live_challenges(access_keys.read_state(store), late) == []
    with pytest.raises(access_keys.ChallengeGone):
        access_keys.open_with(made["challenge"], late, credential_id="k1", path=store)
    with pytest.raises(access_keys.ChallengeGone):
        access_keys.open_with("never-made-here", T0, credential_id="k1", path=store)
    fresh = access_keys.new_turn_on(1, late, path=store)
    assert [c["challenge"] for c in access_keys.read_state(store)["challenges"]] == [fresh["challenge"]]


def test_the_key_that_answered_must_still_be_accepted(store):
    access_keys.set_machine_access_key(hub_key("k1"), now=T0, path=store)
    made = access_keys.new_turn_on(1, T0, path=store)
    with pytest.raises(access_keys.NoAcceptedKey):
        access_keys.open_with(made["challenge"], T0, credential_id="another", sign_count=1, path=store)
    assert not is_on(store, T0)
    assert access_keys.live_challenges(access_keys.read_state(store), T0) == [made["challenge"]]


def test_after_the_deadline_it_is_off_and_expired_once(store):
    access_keys.set_machine_access_key(hub_key("k1"), now=T0, path=store)
    opened(store, hours=1)
    before = T0 + timedelta(minutes=59, seconds=59)
    assert not access_keys.expire_if_due(before, path=store)[1] and is_on(store, before)
    deadline = T0 + timedelta(hours=1)
    unrecorded = view(store, deadline)
    assert (unrecorded["on"], unrecorded["open_until"], unrecorded["last_off"]) == (False, None, "expired")
    state, expired = access_keys.expire_if_due(deadline, path=store)
    assert expired is True and state == access_keys.read_state(store)
    assert access_keys.expire_if_due(deadline + timedelta(minutes=1), path=store) == (state, False)
    assert (state["open_until"], state["hours"], state["last_off"]) == (None, 1, "expired")
    assert view(store, deadline)["last_off"] == "expired"
    assert opened(store, hours=10, now=deadline)["last_off"] is None


def test_lock_turns_it_off_at_once_and_forgets_unanswered_turn_ons(store):
    access_keys.set_machine_access_key(hub_key("k1"), now=T0, path=store)
    assert access_keys.lock(T0, path=store)["last_off"] is None
    opened(store, hours=24)
    waiting = access_keys.new_turn_on(1, T0, path=store)
    later = T0 + timedelta(minutes=1)
    state = access_keys.lock(later, path=store)
    assert state == access_keys.read_state(store)
    assert (state["open_until"], state["hours"], state["last_off"]) == (None, 24, "locked")
    assert not access_keys.is_on(state, later) and not access_keys.expire_if_due(later, path=store)[1]
    with pytest.raises(access_keys.ChallengeGone):
        access_keys.open_with(waiting["challenge"], later, credential_id="k1", path=store)


def test_removing_the_last_accepted_key_turns_remote_control_off(store):
    access_keys.set_machine_access_key(hub_key("k1"), now=T0, path=store)
    access_keys.set_machine_access_key(hub_key("k2"), now=T0, path=store)
    opened(store)
    access_keys.new_turn_on(1, T0, path=store)
    assert access_keys.remove_machine_access_key("k1", now=T0, path=store)
    assert is_on(store, T0)
    assert access_keys.remove_machine_access_key("k2", now=T0, path=store)
    state = access_keys.read_state(store)
    assert not access_keys.is_on(state, T0) and state["open_until"] is None and state["challenges"] == []


def test_an_old_file_that_was_on_migrates_to_off(store):
    accepted = {**hub_key("k1"), "state": "accepted", "accepted_at": T0.isoformat(), "expires_at": None}
    store.write_text(json.dumps({"node_typeid": NODE, "on": True, "keys": {"k1": accepted}}))
    state = access_keys.read_state(store)
    assert "on" not in state and not access_keys.is_on(state, T0)
    assert (state["open_until"], state["hours"], state["last_off"], state["challenges"]) == (None, None, None, [])
    assert view(store, T0)["on"] is False
    access_keys.set_node(NODE, "@studio", path=store)
    assert "on" not in json.loads(store.read_text())
    assert states(access_keys.read_state(store)) == {"k1": "accepted"}


def test_a_removed_key_is_not_accepted_again_through_its_old_request(store):
    request = access_keys.new_request(now=T0, path=store)
    keys = [hub_key("k1", request["id"], NODE)]
    access_keys.apply_hub_keys(keys, NODE, T0, path=store)
    access_keys.remove_machine_access_key("k1", path=store)
    assert states(access_keys.apply_hub_keys(keys, NODE, T0 + timedelta(minutes=1), path=store)) == {}
    access_keys.new_request(now=T0 + timedelta(minutes=2), path=store)
    back = access_keys.apply_hub_keys(keys, NODE, T0 + timedelta(minutes=2), path=store)
    assert states(back) == {"k1": "pending"}


def test_a_key_gone_from_the_hub_is_removed_and_the_switch_follows(store):
    access_keys.set_machine_access_key(hub_key("k1"), now=T0, path=store)
    opened(store)
    state = access_keys.apply_hub_keys([], NODE, T0 + timedelta(minutes=1), path=store)
    assert state["keys"] == {} and state["open_until"] is None
    assert not access_keys.is_on(state, T0 + timedelta(minutes=1))


def test_the_status_shows_keys_the_request_and_the_node_name(store):
    access_keys.set_node(NODE, "@studio", path=store)
    request = access_keys.new_request(now=T0, path=store)
    access_keys.apply_hub_keys([hub_key("k1"), hub_key("k2", request["id"], NODE)], NODE, T0, path=store)
    access_keys.new_request(now=T0, path=store)
    view = access_keys.status_view(access_keys.read_state(store), reason=None, hostname="host", now=T0)
    assert view["available"] is True and view["machine_name"] == "studio" and view["node_typeid"] == NODE
    assert [(key["credential_id"], key["state"]) for key in view["keys"]] == [("k2", "accepted"), ("k1", "pending")]
    assert set(view["keys"][0]) == {"credential_id", "label", "code", "kind", "state", "accepted_at", "expires_at"}
    assert view["request"]["expires_at"] == (T0 + access_keys.REQUEST_TTL).isoformat()
    signed_out = access_keys.status_view(access_keys.read_state(store.with_name("none.json")), reason="signed_out",
                                         hostname="host", now=T0)  # fmt: skip
    assert signed_out["available"] is False and signed_out["machine_name"] == "host" and signed_out["request"] is None


def test_concurrent_writers_keep_the_file_whole(store):
    per_writer = 15

    def write(prefix: str) -> None:
        for index in range(per_writer):
            access_keys.set_machine_access_key(hub_key(f"{prefix}{index}"), now=T0, path=store)

    writers = [threading.Thread(target=write, args=(prefix,)) for prefix in ("a", "b")]
    for writer in writers:
        writer.start()
    for writer in writers:
        writer.join()
    on_disk = json.loads(store.read_text())
    assert sorted(on_disk["keys"]) == sorted(f"{p}{i}" for p in ("a", "b") for i in range(per_writer))
