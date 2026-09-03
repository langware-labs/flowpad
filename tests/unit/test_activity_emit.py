"""``ActivityEmitter`` — coalescing, the trailing edge, and the two channels.

The core notifies on every mutation; this layer decides what actually goes on the wire.
Two properties matter and both are user-visible when broken: a burst must cost one emit
(or a tight walk floods the socket), and the LAST tick of a burst must still arrive (or
a job that slows down leaves the bar frozen short of where it really is).
"""

import asyncio

import pytest

from flow_sdk.activity import Activity, ActivityState, monitor
from flow_sdk.activity.emit import (
    ACTIVITY_KIND,
    PROGRESS_ELEMENT,
    ActivityEmitter,
    envelope,
    local_scope_typeid,
)

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

#: Short enough to keep these tests inside the unit tier's one-second budget, long
#: enough that a coalesced burst is unambiguous. The production value is TICK_INTERVAL_S.
INTERVAL = 0.02


@pytest.fixture(autouse=True)
def _clean_monitor():
    monitor.clear()
    yield
    monitor.clear()


@pytest.fixture()
def sent(monkeypatch):
    """Capture what would go on the socket, without a socket.

    Patches the transport call, not the emitter: everything above ``broadcast_progress``
    — coalescing, scope routing, the envelope shape — is what these tests are about.
    """
    captured: list = []

    async def fake_broadcast(to_entity, flow_data):
        captured.append((f"*broadcast*{to_entity}", flow_data))

    async def fake_to_entity(entity_typeid, flow_data):
        captured.append((entity_typeid, flow_data))

    monkeypatch.setattr(
        "flow_sdk.core.network.resource_tracker.broadcast_progress", fake_broadcast
    )
    monkeypatch.setattr(
        "flow_sdk.core.network.resource_tracker.send_flow_data_to_entity", fake_to_entity
    )
    return captured


@pytest.fixture()
async def emitter():
    e = ActivityEmitter(interval_s=INTERVAL)
    e.install()
    yield e
    e.uninstall()


async def settle(times: int = 3) -> None:
    """Let the flush task run. One interval plus a couple of loop turns for the
    ``create_task`` the flush itself schedules."""
    for _ in range(times):
        await asyncio.sleep(INTERVAL)


# ---------------------------------------------------------------- envelope


async def test_envelope_is_a_progress_report_carrying_the_spec():
    """The element is shared with the indexer table and the process status report, so the
    kind discriminator is what tells a consumer which payload it has."""
    Activity.get("index").total(10).inc_success()

    env = envelope(monitor.get("index"))

    assert env["element_type"] == PROGRESS_ELEMENT
    assert env["attributes"]["kind"] == ACTIVITY_KIND
    assert env["attributes"]["path"] == "index"
    assert env["attributes"]["done"] == 1


async def test_envelope_is_json_safe():
    """It goes through ``json.dumps`` on the way out; a raw datetime or enum would throw
    there, far from the producer that caused it."""
    import json

    Activity.get("index").inc_error("bad")
    json.dumps(envelope(monitor.get("index")))


# ---------------------------------------------------------------- coalescing


async def test_a_burst_of_ticks_costs_one_emit(emitter, sent):
    act = Activity.get("index").total(1000)
    for _ in range(500):
        act.inc_success()

    await settle()

    assert len(sent) == 1, "500 increments, one snapshot"
    assert sent[0][1]["attributes"]["done"] == 500


async def test_the_last_tick_of_a_burst_still_arrives(emitter, sent):
    """The trailing edge. Without it the final increments stay invisible until the
    activity ends — exactly the state a user stares at when a job slows down."""
    act = Activity.get("index").total(10)
    act.inc_success()
    await settle()
    first = len(sent)

    act.inc_success(9)
    await settle()

    assert len(sent) > first
    assert sent[-1][1]["attributes"]["done"] == 10


async def test_each_root_gets_its_own_snapshot(emitter, sent):
    Activity.get("index").inc_success()
    Activity.get("qa").inc_success()

    await settle()

    paths = sorted(f[1]["attributes"]["path"] for f in sent)
    assert paths == ["index", "qa"]


async def test_a_child_tick_emits_the_whole_root_tree(emitter, sent):
    """Every event is complete state, which is what lets a consumer treat any snapshot as
    the truth and need no replay logic beyond one GET."""
    Activity.get("index").total(10)
    Activity.get("index/pdf").total(5).inc_success()

    await settle()

    attrs = sent[-1][1]["attributes"]
    assert attrs["path"] == "index"
    assert [c["name"] for c in attrs["children"]] == ["pdf"]
    assert attrs["children"][0]["done"] == 1


# ---------------------------------------------------------------- transitions


async def test_a_transition_is_emitted_immediately_not_coalesced(emitter, sent):
    """Started, blocked and the terminals are what a person is waiting to see. Holding
    one back for a sampling interval would make the UI feel broken at the only moments
    that matter."""
    Activity.get("index").block("waiting for hub login")

    await asyncio.sleep(0)  # one loop turn, no interval

    assert len(sent) == 1
    assert sent[0][1]["attributes"]["state"] == ActivityState.BLOCKED.value


async def test_a_terminal_snapshot_reaches_the_wire_before_eviction(emitter, sent):
    """The root is untracked the moment its terminal is recorded, so the snapshot has to
    be built synchronously in the callback. Deferring it would serialise a tree that no
    longer exists — and it is the snapshot phase 2 persists as the receipt."""
    act = Activity.get("index").total(10)
    act.inc_success(10)
    act.done("indexed 10")

    await asyncio.sleep(0)

    final = sent[-1][1]["attributes"]
    assert final["state"] == ActivityState.COMPLETED.value
    assert (final["done"], final["message"]) == (10, "indexed 10")
    assert monitor.get("index") is None


# ---------------------------------------------------------------- routing


async def test_an_unscoped_activity_is_addressed_to_the_instance(emitter, sent):
    """No scope means the work belongs to the box — an index, a walk, a docs scan — so
    every connection gets it, watcher list or not."""
    Activity.get("index").block("x")
    await asyncio.sleep(0)

    assert sent[0][0] == f"*broadcast*{local_scope_typeid()}"


async def test_a_scoped_activity_is_addressed_to_its_entity(emitter, sent):
    """Scope is the routing key: a scoped activity goes to that entity's WATCHERS, not
    to everyone. Broadcasting a process's activity to every connection is a volume
    problem on a busy box and, on a shared hub, a privacy one."""
    Activity.get("run", scope="agentic_process-abc").block("x")
    await asyncio.sleep(0)

    assert sent[0][0] == "agentic_process-abc", "watcher-filtered send, not broadcast"


# ---------------------------------------------------------------- robustness


async def test_a_failing_transport_never_breaks_the_producer(emitter, monkeypatch):
    async def boom(to_entity, flow_data):
        raise RuntimeError("socket is gone")

    monkeypatch.setattr("flow_sdk.core.network.resource_tracker.broadcast_progress", boom)

    Activity.get("index").inc_success()
    await settle()

    assert monitor.get("index").done == 1


async def test_producing_with_no_event_loop_installed_does_not_raise():
    """A sync producer in a worker thread must be able to report. The tick rides out with
    the next flush; a sampled view is not a dropped one."""
    e = ActivityEmitter(interval_s=INTERVAL)
    e._loop = None
    e.install()
    e._loop = None
    try:
        Activity.get("index").inc_success()
        assert monitor.get("index").done == 1
    finally:
        e.uninstall()


async def test_install_is_idempotent(emitter, sent):
    emitter.install()
    emitter.install()

    Activity.get("index").block("x")
    await asyncio.sleep(0)

    assert len(sent) == 1, "a second install must not double every emit"


async def test_uninstall_stops_emission(emitter, sent):
    emitter.uninstall()

    Activity.get("index").block("x")
    await settle()

    assert sent == []


async def test_in_flight_sends_are_held_until_they_finish(emitter, sent):
    """``loop.create_task`` returns a task the loop only WEAKLY references.

    A send nobody holds can be garbage-collected mid-flight and simply never happen. That
    ate exactly the transition frames in a live browser — ticks survived because the
    coalescing task kept the loop busy around them — leaving a finished activity stuck on
    "running" in the UI while the backend had already evicted it.
    """
    Activity.get("index").block("x")

    assert emitter._in_flight, "the send must be referenced while it is in flight"

    await settle()

    assert not emitter._in_flight, "and released once it lands"
    assert len(sent) == 1


async def test_many_transitions_do_not_leak_task_references(emitter, sent):
    for i in range(20):
        Activity.get(f"job-{i}").block("x")

    await settle()

    assert emitter._in_flight == set()
    assert len(sent) == 20


@pytest.mark.parametrize("scope", [None, "agentic_process-abc"])
async def test_every_frame_is_addressed_to_something_that_parses_as_a_typeid(emitter, sent, scope):
    """The client DROPS a flow_data message whose ``to_entity`` will not parse as a TypeId
    (``ConnectionManager.onFlowDataMessage``), warns to the console and moves on. So an
    empty address is not "broadcast to nobody in particular" — it is a frame nobody ever
    sees, which is exactly what happened: every activity tick was emitted correctly and
    silently discarded in the browser."""
    Activity.get("index", scope=scope).block("x")
    await asyncio.sleep(0)

    to_entity = sent[0][0].replace("*broadcast*", "")
    kind, _, ident = to_entity.partition("-")
    assert kind and ident, f"{to_entity!r} will not parse as a TypeId"


async def test_the_instance_address_is_this_machines_compute_node(emitter, sent):
    """Not the ``@local`` alias: the indexer addresses its own progress with the real
    TypeId, and two spellings of one box would be two addresses for one stream."""
    from flow_sdk.utils.machine_id import local_entity_id

    Activity.get("index").block("x")
    await asyncio.sleep(0)

    assert sent[0][0] == f"*broadcast*compute_node-{local_entity_id('compute_node')}"


async def test_a_producer_reporting_from_a_worker_thread_still_reaches_the_wire(emitter, sent):
    """Not every producer is async. A walk runs in a thread and reports from there, and
    ``loop.create_task`` is NOT thread-safe — calling it cross-thread is undefined
    behaviour rather than an error anyone would ever see. The hop has to go through
    ``call_soon_threadsafe``, which is what this proves end to end."""
    import threading

    def worker():
        Activity.get("walk").total(3)
        for _ in range(3):
            Activity.get("walk").inc_success()
        Activity.get("walk").done("walked")

    thread = threading.Thread(target=worker)
    thread.start()
    thread.join()

    await settle()

    finals = [f for f in sent if f[1]["attributes"]["path"] == "walk"]
    assert finals, "a thread-borne producer emitted nothing at all"
    assert finals[-1][1]["attributes"]["state"] == ActivityState.COMPLETED.value
    assert finals[-1][1]["attributes"]["done"] == 3
