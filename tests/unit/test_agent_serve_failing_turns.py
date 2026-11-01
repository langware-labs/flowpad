"""A deployment whose turns fail reads ``failing`` (not "alive"), and the messages they failed hold until answered.

Built from real turn records (``started_record`` → ``done_record``), the ones ``TurnEngine`` writes.
"""
from __future__ import annotations

from flow_sdk.builtin.agent_serve import (
    DONE,
    FAILED,
    HELD,
    done_record,
    held_of,
    started_record,
    turns_health,
)

REFUSED = "API Error: 429 the hub refused the request: this endpoint's budget is exhausted"


def _turn(status: str, text: str = "", at: str = "") -> dict:
    record = done_record(started_record(), text, status)
    if at:
        record["at"] = record["ended_at"] = at
    return record


def test_two_failed_turns_in_a_row_read_failing_with_the_reason_and_the_unanswered_count():
    records = [
        _turn(DONE, "hi", "2026-10-28T09:00:00+00:00"),
        _turn(FAILED, REFUSED, "2026-10-28T09:05:00+00:00"),
        _turn(FAILED, REFUSED + "\nsecond line", "2026-10-28T09:07:00+00:00"),
    ]
    state, detail = turns_health(records)
    assert state == "failing"
    assert detail.endswith("· 2 messages unanswered since 09:05 UTC")
    assert "\n" not in detail and detail.startswith("API Error: 429")
    assert len(detail.split(" · ")[0]) <= 160


def test_a_success_after_the_failures_reads_alive():
    records = [
        _turn(FAILED, REFUSED, "2026-10-28T09:05:00+00:00"),
        _turn(FAILED, REFUSED, "2026-10-28T09:06:00+00:00"),
        _turn(DONE, "back", "2026-10-28T09:10:00+00:00"),
    ]
    assert turns_health(records) == ("alive", "")


def test_one_failure_is_not_yet_an_outage_and_turns_in_flight_do_not_count():
    records = [_turn(DONE, "ok", "2026-10-28T09:00:00+00:00"), _turn(FAILED, REFUSED, "2026-10-28T09:05:00+00:00"),
               started_record()]
    assert turns_health(records) == ("alive", "")
    assert turns_health([]) == ("alive", "")


def test_a_failure_with_no_text_still_names_a_reason():
    records = [_turn(FAILED, "", "2026-10-28T09:05:00+00:00"), _turn(FAILED, "", "2026-10-28T09:06:00+00:00")]
    state, detail = turns_health(records)
    assert state == "failing" and detail.startswith("the agent's turns are failing ·")


def test_held_messages_come_back_oldest_first_and_only_from_failed_turns():
    late = {**_turn(FAILED, REFUSED, "2026-10-28T09:07:00+00:00"), HELD: {"source": "s", "row": "r2"}}
    early = {**_turn(FAILED, REFUSED, "2026-10-28T09:05:00+00:00"), HELD: {"source": "s", "row": "r1"}}
    answered = {**_turn(DONE, "ok", "2026-10-28T09:01:00+00:00"), HELD: {"source": "s", "row": "r0"}}
    plain_failure = _turn(FAILED, REFUSED, "2026-10-28T09:02:00+00:00")
    held = held_of({"k2": late, "k1": early, "k0": answered, "kx": plain_failure})
    assert [(key, record[HELD]["row"]) for key, record in held] == [("k1", "r1"), ("k2", "r2")]


def test_the_live_procurement_box_reads_failing_with_the_refusal_named():
    """The real turn records of deployment ac5708e1 on 2026-10-28 (read from the GCP box): the last answer on
    Oct 27 06:36, then three turns refused by the hub's budget gate. Old records carry no reason; new ones do."""
    from flow_sdk.builtin.agent_serve import DONE, ERROR, FAILED, turns_health

    live = [
        {"status": DONE, "at": "2026-10-27T06:32:51.909633+00:00", "ended_at": "2026-10-27T06:36:09.571703+00:00"},
        {"status": FAILED, "text": "", "at": "2026-10-28T06:03:31.365768+00:00", "ended_at": "2026-10-28T06:03:48.219393+00:00"},
        {"status": FAILED, "text": "", "at": "2026-10-28T07:17:23.401802+00:00", "ended_at": "2026-10-28T07:17:29.337233+00:00"},
        {"status": FAILED, "text": "", "at": "2026-10-28T07:18:27.668133+00:00", "ended_at": "2026-10-28T07:18:35.190621+00:00"},
    ]
    assert turns_health(live) == ("failing", "the agent's turns are failing · 3 messages unanswered since 06:03 UTC")

    refusal = "The agent ended error. API Error: Request rejected (429) · limit 'cost_usd_total' exceeded"
    live[-1] = {**live[-1], ERROR: refusal}
    state, detail = turns_health(live)
    assert state == "failing" and "limit 'cost_usd_total' exceeded" in detail and detail.endswith("since 06:03 UTC")
