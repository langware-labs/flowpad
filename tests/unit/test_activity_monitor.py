"""``ActivityProgressMonitor`` — the live registry, and what eviction means.

The monitor tracks LIVE work only, so the sharp edge is what happens at a root's
terminal: the tree is untracked and a later ``get`` on the same address returns a fresh
node. That is deliberate, and these tests pin it, because the tracker it replaces
conflated "is it running" with "when did it last finish" and a restart therefore made
the footer indicator vanish with nothing said.
"""

from datetime import timedelta

import pytest

from flow_sdk.activity import Activity, ActivityState, monitor
from flow_sdk.activity import activity as activity_module

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


@pytest.fixture(autouse=True)
def _clean_monitor():
    monitor.clear()
    yield
    monitor.clear()


@pytest.fixture()
def clock(monkeypatch):
    """A movable clock. ``stale()`` is about elapsed time, and a test that proved it by
    sleeping would be a slow test that pinned nothing extra."""

    class Clock:
        def __init__(self):
            from datetime import datetime, timezone

            self.now = datetime(2026, 9, 3, 12, 0, 0, tzinfo=timezone.utc)

        def advance(self, seconds):
            self.now += timedelta(seconds=seconds)

    c = Clock()
    # One patch point: the monitor reads the clock through this module rather than
    # binding its own copy, so time is mockable in exactly one place.
    monkeypatch.setattr(activity_module, "_now", lambda: c.now)
    return c


# ---------------------------------------------------------------- registry


def test_the_monitor_is_the_find_or_create_registry():
    """Two callers who ask for the same address get the same node — not two rows that
    disagree about the same work."""
    a = Activity.get("index")
    b = monitor.activity("index")
    assert a is b


def test_list_returns_live_roots_only():
    Activity.get("index").inc_success()
    Activity.get("qa").inc_success()
    Activity.get("index").child("pdf").inc_success()

    paths = [s.path for s in monitor.list()]
    assert sorted(paths) == ["index", "qa"], "children are reached through their root"


def test_list_is_ordered_by_most_recently_updated(clock):
    Activity.get("first").inc_success()
    clock.advance(10)
    Activity.get("second").inc_success()

    assert [s.path for s in monitor.list()] == ["second", "first"]


def test_list_filters_by_scope():
    Activity.get("index").inc_success()
    Activity.get("run", scope="agentic_process-1").inc_success()

    assert [s.path for s in monitor.list(scope="agentic_process-1")] == ["run"]
    assert [s.path for s in monitor.list()] == ["index"], "the default scope is the instance"
    assert len(monitor.list(all_scopes=True)) == 2


def test_count_counts_roots_not_nodes():
    """The chip shows one number to a person. A cycle with twelve phases is one thing
    happening, not thirteen."""
    root = Activity.get("qa")
    for i in range(12):
        root.child(f"phase-{i}").inc_success()

    assert monitor.count() == 1


def test_get_returns_a_snapshot_and_node_returns_the_live_node():
    Activity.get("index").total(10).inc_success()

    assert monitor.get("index").done == 1
    assert monitor.node("index") is Activity.get("index")


def test_node_does_not_mint():
    """A caller checking whether something is running must not create it by asking."""
    assert monitor.node("nothing-here") is None
    assert monitor.count() == 0


# ---------------------------------------------------------------- eviction


def test_a_root_terminal_untracks_the_whole_tree():
    root = Activity.get("index").total(10)
    root.child("pdf").inc_success()

    root.done("finished")

    assert monitor.count() == 0
    assert monitor.get("index") is None
    assert monitor.node("index/pdf") is None


def test_a_child_terminal_leaves_the_tree_tracked():
    """A finished phase of a running cycle is still part of live work. Dropping it would
    make the tree lie about what it did."""
    root = Activity.get("qa")
    phase = root.child("phase-1").inc_success()

    phase.done()

    assert monitor.count() == 1
    assert monitor.get("qa").children[0].state is ActivityState.COMPLETED


def test_get_after_eviction_returns_a_fresh_pending_node():
    """The consequence worth stating out loud: "is it running" is a question for the
    monitor; "when did it last finish" is a question for the receipt (phase 2). Asking
    the monitor about finished work is asking the wrong component."""
    first = Activity.get("index").total(10)
    first.inc_success(10)
    first.done()

    second = Activity.get("index")

    assert second is not first
    assert second.state is ActivityState.PENDING
    assert second.spec().done == 0
    assert second.activity_id != first.activity_id


def test_seq_starts_over_with_the_fresh_node():
    """A recycled address must not inherit a stale counter — a consumer drops anything
    not greater than what it holds, and an inherited-high seq would make the new
    activity's first ticks invisible."""
    first = Activity.get("index")
    for _ in range(20):
        first.inc_success()
    first.done()

    assert Activity.get("index").spec().seq == 0


def test_drop_force_untracks_a_root():
    Activity.get("index").inc_success()

    assert monitor.drop("index") is True
    assert monitor.count() == 0
    assert monitor.drop("index") is False, "dropping what is not there is not an error"


# ---------------------------------------------------------------- duplicate starts


def test_state_is_the_duplicate_start_gate():
    """There is no separate slot to take: find-or-create plus state IS the gate. This
    replaces the old holder's bespoke dedupe and its liveness budget."""
    Activity.get("index").inc_success()

    assert Activity.get("index").state is ActivityState.RUNNING

    Activity.get("index").done()
    assert Activity.get("index").state is ActivityState.PENDING, "the slot is free again"


# ---------------------------------------------------------------- stalls


def test_stale_reports_roots_that_have_not_ticked(clock):
    """The monitor is the only component that knows when each activity last moved, so
    it is the only one that can tell a slow job from a hung one."""
    Activity.get("slow").inc_success()
    Activity.get("busy").inc_success()

    clock.advance(120)
    Activity.get("busy").inc_success()

    stale = monitor.stale(seconds=60)

    assert [s.path for s in stale] == ["slow"]


def test_stale_reports_but_never_kills(clock):
    """It REPORTS. Timing something out here would be inventing a wait budget."""
    Activity.get("slow").inc_success()
    clock.advance(600)

    monitor.stale(seconds=1)

    assert monitor.count() == 1
    assert Activity.get("slow").state is ActivityState.RUNNING


# ---------------------------------------------------------------- subscribers


def test_subscribers_are_handed_the_root_and_the_transition_flag():
    seen = []
    unsubscribe = monitor.subscribe(lambda root, transition: seen.append((root.path, transition)))

    Activity.get("index").child("pdf").inc_success()
    Activity.get("index").done()

    assert seen[0] == ("index", False), "a child's tick notifies about its ROOT"
    assert seen[-1] == ("index", True), "a terminal is a transition"

    unsubscribe()
    Activity.get("other").inc_success()
    assert len(seen) == len([s for s in seen if s[0] in ("index",)])


def test_seq_increases_across_every_notification():
    seqs = []
    monitor.subscribe(lambda root, _t: seqs.append(root.seq))

    act = Activity.get("index")
    for _ in range(5):
        act.inc_success()

    assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs)


def test_a_raising_subscriber_never_breaks_the_producer():
    """Progress reporting is not a reason for a walk to fail."""

    def boom(root, transition):
        raise RuntimeError("sink is down")

    monitor.subscribe(boom)

    Activity.get("index").inc_success()

    assert monitor.get("index").done == 1


def test_a_terminal_snapshot_is_emitted_before_the_tree_is_evicted():
    """Ordering contract. Phase 2 inserts the receipt persist right here, so a sink that
    could not see the final state would make that insert impossible."""
    captured = []

    def sink(root, transition):
        if transition and root.is_terminal:
            captured.append(root.spec())

    monitor.subscribe(sink)

    act = Activity.get("index").total(10)
    act.inc_success(10)
    act.done("indexed 10")

    assert len(captured) == 1
    final = captured[0]
    assert final.state is ActivityState.COMPLETED
    assert (final.done, final.message) == (10, "indexed 10")
    assert final.finished_at is not None
    assert monitor.get("index") is None, "and only then is it gone"


def test_two_threads_addressing_the_same_path_get_the_same_node():
    """A walk is often threaded, and every worker calls ``Activity.get`` for itself. Two
    nodes for one address would split the count in half and lose whichever tree lost the
    race — so creation is under the registry's lock, and this is the test that says so."""
    import threading

    seen: "list" = []
    barrier = threading.Barrier(8)

    def worker():
        barrier.wait()
        seen.append(Activity.get("index/pdf"))

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len({id(node) for node in seen}) == 1
    assert monitor.count() == 1


def test_concurrent_increments_do_not_lose_counts():
    """The counters are plain ints behind the GIL, but the tree walk and the notify are
    not — a lost increment here would show up as a bar that never reaches its total."""
    import threading

    act = Activity.get("index").total(800)
    barrier = threading.Barrier(8)

    def worker():
        barrier.wait()
        for _ in range(100):
            Activity.get("index").inc_success()

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert act.spec().done == 800
