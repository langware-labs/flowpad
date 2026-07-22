"""Journey interface — every method against every state.

Drives the `Journey` entity methods directly (no HTTP). The journal IS the
progress object, so each method's return value is asserted as a journal row.
Covers the matrix in the Iteration 2 plan (rows 1-19), including the
one-active invariant and all four statuses.
"""
import json

import pytest

from flow_sdk.builtin.journey import Journey
from flow_sdk.builtin.journey_journal import ACTIVE_STATUSES, JourneyJournal, JourneyStatus
from tests.conftest import async_context

USER = "user-1"
OTHER = "user-2"


def _step(node_id: str) -> dict:
    return {
        "id": node_id, "node_type": "guided_step", "name": node_id,
        "node_data": {
            "status_line": f"at {node_id}",
            "present": {"dock": {"kind": "asset_editor", "vfs": f"{node_id}.html"}},
            "await": {"kind": "manual"},
        },
    }


async def _make(tmp_path, *ids: str) -> Journey:
    """A journey whose guided steps run ids[0] → ids[1] → … on `done`."""
    journey = Journey(name="gs", asset_ref=str(tmp_path / "gs"))
    await journey.save()
    doc = {
        "version": 1, "id": journey.id, "name": "gs", "enabled": True,
        "nodes": [_step(i) for i in ids],
        "edges": [{"id": f"e{n}", "from": {"node": a, "event": "done"}, "to": {"node": b}}
                  for n, (a, b) in enumerate(zip(ids, ids[1:]))],
    }
    (tmp_path / "gs" / "graph.json").write_text(json.dumps(doc), encoding="utf-8")
    return journey


async def _actives(journey: Journey, user: str = USER) -> list[JourneyJournal]:
    return [j for j in await journey.history(user) if j.status in ACTIVE_STATUSES]


# ── 1-4: progress + launch ────────────────────────────────────────────────────


@async_context
async def test_01_progress_is_none_when_never_launched(tmp_path):
    journey = await _make(tmp_path, "s1", "s2")
    assert await journey.progress(USER) is None
    assert await journey.history(USER) == []


@async_context
async def test_02_launch_creates_new_at_entry(tmp_path):
    journey = await _make(tmp_path, "s1", "s2", "s3")
    j = await journey.launch(USER)
    assert j is not None and j.id
    assert j.status == JourneyStatus.NEW.value
    assert j.cursor == "s1"                      # the entry (no edge targets it)
    assert (j.total_steps, j.steps_left) == (3, 3)
    assert j.entries == []
    assert (await journey.progress(USER)).id == j.id


@async_context
async def test_03_launch_is_idempotent_on_the_active_journal(tmp_path):
    journey = await _make(tmp_path, "s1", "s2")
    first = await journey.launch(USER)
    second = await journey.launch(USER)
    assert second.id == first.id
    assert len(await journey.history(USER)) == 1


@async_context
async def test_04_launch_after_complete_starts_a_fresh_journal(tmp_path):
    journey = await _make(tmp_path, "s1")
    done = await journey.launch(USER)
    done = await journey.advance(USER, "s1")
    assert done.status == JourneyStatus.COMPLETE.value

    fresh = await journey.launch(USER)
    assert fresh.id != done.id and fresh.status == JourneyStatus.NEW.value
    # the completed run is untouched, and still in history
    assert (await JourneyJournal.get_by_id(done.id)).status == JourneyStatus.COMPLETE.value
    assert len(await journey.history(USER)) == 2


# ── 5-10: advance ─────────────────────────────────────────────────────────────


@async_context
async def test_05_advance_first_step_flips_new_to_launched(tmp_path):
    journey = await _make(tmp_path, "s1", "s2", "s3")
    await journey.launch(USER)
    j = await journey.advance(USER, "s1")
    assert j.status == JourneyStatus.LAUNCHED.value
    assert j.cursor == "s2"
    assert j.steps_left == 2
    assert j.entries[-1]["node_id"] == "s1" and j.entries[-1]["event"] == "done"
    assert j.entries[-1]["at"]


@async_context
async def test_06_advance_mid_stays_launched_and_tracks_counters(tmp_path):
    journey = await _make(tmp_path, "s1", "s2", "s3")
    await journey.launch(USER)
    await journey.advance(USER, "s1")
    j = await journey.advance(USER, "s2")
    assert j.status == JourneyStatus.LAUNCHED.value
    assert j.cursor == "s3" and j.steps_left == 1 and len(j.entries) == 2


@async_context
async def test_07_advance_final_step_completes(tmp_path):
    journey = await _make(tmp_path, "s1", "s2")
    await journey.launch(USER)
    await journey.advance(USER, "s1")
    j = await journey.advance(USER, "s2")
    assert j.status == JourneyStatus.COMPLETE.value
    assert j.cursor == "" and j.steps_left == 0
    assert await journey._active(USER) is None      # terminal → nothing active


@async_context
async def test_08_advance_records_skipped_and_still_moves_on(tmp_path):
    journey = await _make(tmp_path, "s1", "s2")
    await journey.launch(USER)
    j = await journey.advance(USER, "s1", event="skipped")
    assert j.entries[-1]["event"] == "skipped"
    assert j.cursor == "s2" and j.status == JourneyStatus.LAUNCHED.value


@async_context
async def test_09_advance_with_stale_node_id_is_a_noop(tmp_path):
    journey = await _make(tmp_path, "s1", "s2", "s3")
    await journey.launch(USER)
    await journey.advance(USER, "s1")             # cursor now s2
    j = await journey.advance(USER, "s1")         # stale/duplicate
    assert j.cursor == "s2" and len(j.entries) == 1 and j.steps_left == 2


@async_context
async def test_10_advance_without_an_active_journal_is_none(tmp_path):
    journey = await _make(tmp_path, "s1", "s2")
    assert await journey.advance(USER, "s1") is None
    assert await journey.history(USER) == []      # nothing was created


# ── 11-13: restart ────────────────────────────────────────────────────────────


@async_context
async def test_11_restart_from_new_archives_and_relaunches(tmp_path):
    journey = await _make(tmp_path, "s1", "s2")
    old = await journey.launch(USER)
    fresh = await journey.restart(USER)
    assert fresh.id != old.id and fresh.status == JourneyStatus.NEW.value
    assert (await JourneyJournal.get_by_id(old.id)).status == JourneyStatus.RESTARTED.value


@async_context
async def test_12_restart_from_launched_resets_the_counters(tmp_path):
    journey = await _make(tmp_path, "s1", "s2", "s3")
    old = await journey.launch(USER)
    await journey.advance(USER, "s1")             # old is launched at s2
    fresh = await journey.restart(USER)
    assert (await JourneyJournal.get_by_id(old.id)).status == JourneyStatus.RESTARTED.value
    assert fresh.status == JourneyStatus.NEW.value
    assert fresh.cursor == "s1" and fresh.steps_left == 3 and fresh.entries == []


@async_context
async def test_13_restart_when_only_a_complete_journal_exists(tmp_path):
    journey = await _make(tmp_path, "s1")
    done = await journey.launch(USER)
    await journey.advance(USER, "s1")
    fresh = await journey.restart(USER)
    assert fresh.status == JourneyStatus.NEW.value and fresh.id != done.id
    # a completed journal is history, not something to archive
    assert (await JourneyJournal.get_by_id(done.id)).status == JourneyStatus.COMPLETE.value


# ── 14: history ───────────────────────────────────────────────────────────────


@async_context
async def test_14_history_is_newest_first_and_keeps_every_status(tmp_path):
    journey = await _make(tmp_path, "s1", "s2")
    first = await journey.launch(USER)
    await journey.advance(USER, "s1")
    await journey.restart(USER)                   # first → restarted, second → new
    second = await journey._active(USER)

    hist = await journey.history(USER)
    assert [h.id for h in hist] == [second.id, first.id]          # newest-first
    assert {h.status for h in hist} == {JourneyStatus.NEW.value,
                                        JourneyStatus.RESTARTED.value}
    # another user's journals never leak in
    assert await journey.history(OTHER) == []


# ── 15-16: resume ─────────────────────────────────────────────────────────────


@async_context
async def test_15_resume_reactivates_a_restarted_journal(tmp_path):
    journey = await _make(tmp_path, "s1", "s2", "s3")
    old = await journey.launch(USER)
    await journey.advance(USER, "s1")             # old sits at s2
    current = await journey.restart(USER)

    resumed = await Journey.resume(old.id, USER)
    assert resumed.id == old.id
    assert resumed.status == JourneyStatus.LAUNCHED.value   # it had entries
    assert resumed.cursor == "s2"                           # cursor preserved
    # the journal that was active got archived — the invariant holds
    assert (await JourneyJournal.get_by_id(current.id)).status == JourneyStatus.RESTARTED.value
    assert len(await _actives(journey)) == 1


@async_context
async def test_16_resume_with_nothing_else_active(tmp_path):
    journey = await _make(tmp_path, "s1", "s2")
    old = await journey.launch(USER)              # never advanced → no entries
    old.status = JourneyStatus.RESTARTED.value
    await old.update()
    assert await journey._active(USER) is None

    resumed = await Journey.resume(old.id, USER)
    assert resumed.id == old.id
    assert resumed.status == JourneyStatus.NEW.value   # no entries → back to `new`
    assert len(await _actives(journey)) == 1


@async_context
async def test_16b_resume_of_an_unknown_journal_is_none(tmp_path):
    await _make(tmp_path, "s1")
    assert await Journey.resume("00000000-0000-4000-8000-000000000000", USER) is None


# ── 17-19: invariants, status coverage, bounds ────────────────────────────────


@async_context
async def test_17_at_most_one_active_journal_after_every_operation(tmp_path):
    journey = await _make(tmp_path, "s1", "s2", "s3")

    async def invariant():
        assert len(await _actives(journey)) <= 1, "one-active invariant violated"

    await invariant()
    first = await journey.launch(USER);      await invariant()
    await journey.launch(USER);              await invariant()   # idempotent
    await journey.advance(USER, "s1");       await invariant()
    await journey.restart(USER);             await invariant()
    await Journey.resume(first.id, USER);    await invariant()
    await journey.advance(USER, "s2");       await invariant()
    await journey.advance(USER, "s3");       await invariant()   # → complete, zero active
    assert len(await _actives(journey)) == 0


@async_context
async def test_18_every_status_is_reachable(tmp_path):
    journey = await _make(tmp_path, "s1", "s2")
    seen: set[str] = set()

    j = await journey.launch(USER); seen.add(j.status)                     # new
    j = await journey.advance(USER, "s1"); seen.add(j.status)              # launched
    await journey.restart(USER)
    seen.add((await JourneyJournal.get_by_id(j.id)).status)                # restarted
    j = await journey.advance(USER, "s1")
    j = await journey.advance(USER, "s2"); seen.add(j.status)              # complete

    assert seen == {s.value for s in JourneyStatus}


@async_context
async def test_19_counters_stay_in_bounds(tmp_path):
    journey = await _make(tmp_path, "s1", "s2")
    j = await journey.launch(USER)
    total = j.total_steps
    for node in ("s1", "s2"):
        j = await journey.advance(USER, node)
        assert 0 <= j.steps_left <= total
        assert j.total_steps == total          # stable across the whole run
    assert j.steps_left == 0

    fresh = await journey.restart(USER)        # and stable across a restart
    assert fresh.total_steps == total and fresh.steps_left == total


@async_context
async def test_20_journals_are_per_user(tmp_path):
    journey = await _make(tmp_path, "s1", "s2")
    mine = await journey.launch(USER)
    theirs = await journey.launch(OTHER)
    assert mine.id != theirs.id
    await journey.advance(USER, "s1")
    assert (await journey.progress(OTHER)).cursor == "s1"   # untouched by my advance
    assert (await journey.progress(USER)).cursor == "s2"
