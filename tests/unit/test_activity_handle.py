"""``Activity`` — addressing, the verbs, and the state machine.

The point of the handle is that an ADDRESS is enough: code three modules from the root
of a walk must be able to report without anyone threading a handle down to it. These
tests pin that, and pin the arithmetic each verb is responsible for — including the two
distinctions that are easy to get wrong and invisible when wrong: a skip is done work,
and an error is not.
"""

import pytest

from flow_sdk.activity import Activity, ActivityState, monitor
from flow_sdk.schema.data_spec.activity_spec import MAX_DEPTH, MAX_ERROR_SAMPLE

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


# ---------------------------------------------------------------- addressing


def test_get_is_find_or_create_and_returns_the_same_node():
    first = Activity.get("index")
    assert Activity.get("index") is first, "an address resolves to exactly one node"


def test_deep_address_and_walked_address_are_the_same_node():
    """``Activity.get("a/b")`` is the whole point: no handle needs to be passed down."""
    walked = Activity.get("index").child("pdf")
    assert Activity.get("index/pdf") is walked


def test_child_creates_intermediate_nodes_on_first_touch():
    Activity.get("index/pdf/ocr").inc_success()

    tree = monitor.get("index")
    assert [n.path for n in tree.walk()] == ["index", "index/pdf", "index/pdf/ocr"]


def test_path_normalisation_collapses_stray_separators():
    assert Activity.get("/index//pdf/") is Activity.get("index/pdf")


def test_child_beyond_the_depth_cap_raises():
    """The cap is a wire budget. Silently flattening would hide a producer about to put
    a per-file node on the socket, so it fails loudly at the call site instead."""
    deep = Activity.get("a/b/c/d")
    assert deep.depth == MAX_DEPTH, "a root counts as depth 0, so four tiers are legal"

    with pytest.raises(ValueError, match="depth cap"):
        deep.child("e")


def test_scope_is_part_of_the_address():
    local = Activity.get("index")
    scoped = Activity.get("index", scope="agentic_process-1")

    assert local is not scoped, "two entities can each have an 'index' activity"
    assert scoped.scope == "agentic_process-1"


def test_children_inherit_their_parents_scope():
    assert Activity.get("qa", scope="p-1").child("phase-1").scope == "p-1"


def test_empty_path_is_rejected():
    with pytest.raises(ValueError):
        Activity.get("/")


# ---------------------------------------------------------------- lifecycle


def test_first_mutation_starts_the_activity():
    """There is no ``start()``: touching it IS starting it."""
    act = Activity.get("index")
    assert act.state is ActivityState.PENDING
    assert act.started_at is None

    act.inc_success()

    assert act.state is ActivityState.RUNNING
    assert act.started_at is not None


def test_verbs_chain():
    act = Activity.get("index").label("Indexing").total(5000).icon("Search").current("a.md")

    spec = act.spec()
    assert (spec.label, spec.total, spec.icon, spec.current) == ("Indexing", 5000, "Search", "a.md")


def test_inc_success_counts_done():
    act = Activity.get("index")
    act.inc_success()
    act.inc_success(4)
    assert act.spec().done == 5


def test_inc_skipped_counts_as_done_too():
    """A walk that skips 900 fresh files out of 1000 has not got 10% through the folder.
    The skip is finished business; ``skipped`` records only that it was cheap."""
    act = Activity.get("index").total(1000)
    act.inc_skipped(900)
    act.inc_success(100)

    spec = act.spec()
    assert (spec.done, spec.skipped) == (1000, 900)
    assert spec.fraction() == 1.0


def test_inc_error_does_not_advance_done():
    """A file that errored was not processed. Counting it as done would let a run of
    pure failures render a full green bar."""
    act = Activity.get("index").total(10)
    act.inc_error("encrypted", ref="a.pdf", code="E_ENC")

    spec = act.spec()
    assert spec.done == 0
    assert spec.errors_count == 1
    assert (spec.errors[0].message, spec.errors[0].ref, spec.errors[0].code) == ("encrypted", "a.pdf", "E_ENC")
    assert spec.errors[0].ts is not None


def test_error_count_is_the_truth_and_the_list_is_a_sample():
    """Three thousand bad inputs must report three thousand and ship ten."""
    act = Activity.get("index")
    for i in range(3000):
        act.inc_error(f"bad {i}")

    spec = act.spec()
    assert spec.errors_count == 3000
    assert len(spec.errors) == MAX_ERROR_SAMPLE
    assert spec.errors[0].message == "bad 0"
    assert spec.errors[-1].message == "bad 2999"


def test_set_counter_takes_an_absolute_value_and_never_goes_backwards():
    """The verb for a producer whose source is a running total rather than an event — an
    agent's token count, a re-parsed transcript. Without it every such producer computes
    the delta itself and invents its own answer for a total that went down."""
    act = Activity.get("index")

    act.set_counter("tokens", 100)
    act.set_counter("tokens", 250)
    assert act.spec().counters["tokens"] == 250

    act.set_counter("tokens", 40)
    assert act.spec().counters["tokens"] == 250, "a re-read that lost information is not undone work"


def test_inc_counts_domain_counters():
    act = Activity.get("index")
    act.inc("orphans", 17)
    act.inc("orphans")
    act.inc("dupes", 2)

    assert act.spec().counters == {"orphans": 18, "dupes": 2}


def test_block_and_resume_are_not_terminal():
    act = Activity.get("index").inc_success()

    act.block("waiting for hub login")
    assert act.state is ActivityState.BLOCKED
    assert act.spec().message == "waiting for hub login"
    assert not act.is_terminal

    act.resume()
    assert act.state is ActivityState.RUNNING


def test_a_blocked_activity_still_counts():
    """Blocked is a live state — a producer that resumes must not have lost its work."""
    act = Activity.get("index").inc_success()
    act.block("waiting")
    act.inc_success()
    assert act.spec().done == 2


@pytest.mark.parametrize(
    ("verb", "expected"),
    [
        ("done", ActivityState.COMPLETED),
        ("fail", ActivityState.FAILED),
        ("cancel", ActivityState.CANCELLED),
    ],
)
def test_done_fail_and_cancel_are_terminal_and_stamp_finished_at(verb, expected):
    act = Activity.get("index").inc_success()
    getattr(act, verb)("that is that")

    assert act.state is expected
    assert act.is_terminal
    assert act.spec().finished_at is not None
    assert act.spec().message == "that is that"


def test_terminal_is_sticky_and_later_mutations_are_dropped():
    """A producer that keeps counting past its own terminal is reporting on work that is
    over. The snapshot must not move — and it must not raise either, because a late tick
    from a background thread is not an error worth failing a job over."""
    act = Activity.get("index").total(10)
    act.inc_success(3)
    act.done()

    act.inc_success(99)
    act.inc_error("late")
    act.label("renamed")
    act.block("nope")

    spec = act.spec()
    assert (spec.done, spec.errors_count, spec.state) == (3, 0, ActivityState.COMPLETED)
    assert spec.label is None


def test_root_terminal_marks_unfinished_children_interrupted():
    """A child still running when its root ended did not complete — it was cut off.
    Recording it as completed would be a lie the receipt then carries forever."""
    root = Activity.get("qa")
    finished = root.child("phase-1").inc_success()
    finished.done()
    running = root.child("phase-2").inc_success()

    root.done("out of time")

    assert finished.state is ActivityState.COMPLETED
    assert running.state is ActivityState.INTERRUPTED
    assert running.finished_at is not None


def test_reset_returns_a_node_to_pending_and_drops_children():
    act = Activity.get("index").total(10)
    act.inc_success(5)
    act.child("pdf").inc_success()

    act.reset()

    spec = act.spec()
    assert spec.state is ActivityState.PENDING
    assert (spec.done, spec.total, spec.children) == (0, None, [])
    assert monitor.node("index/pdf") is None


# ---------------------------------------------------------------- reading


def test_spec_is_a_snapshot_that_does_not_track_later_changes():
    act = Activity.get("index")
    act.inc_success()
    before = act.spec()
    act.inc_success()

    assert before.done == 1, "the frozen snapshot is a value, not a view"
    assert act.spec().done == 2


def test_seq_increases_on_every_mutation_anywhere_in_the_tree():
    """Consumers drop any snapshot whose seq is not greater than what they hold, so a
    child's tick must move the ROOT's counter or the update is discarded."""
    root = Activity.get("index")
    first = root.spec().seq
    root.child("pdf").inc_success()

    assert root.spec().seq > first


def test_fraction_comes_from_the_spec_and_nowhere_else():
    """One implementation of the completed-share rule. The node used to carry a second
    copy over its own field names, which is two places for one policy to drift."""
    act = Activity.get("index").total(4)
    act.inc_success()

    assert act.spec().fraction() == 0.25
    assert not hasattr(act, "fraction")


def test_show_renders_one_line_per_node():
    root = Activity.get("index").total(10)
    root.inc_success(2)
    root.child("pdf").total(5).inc_error("bad")

    lines = root.show().splitlines()

    assert len(lines) == 2
    assert "index" in lines[0] and "running" in lines[0]
    assert "pdf" in lines[1] and "!1" in lines[1], "errors are visible in the terminal form"


# ---------------------------------------------------------------- liveness propagates up


def test_a_child_at_work_starts_its_ancestors():
    """A parent whose child is working IS working. A QA cycle's root only orchestrates;
    if it stayed ``pending`` the chip would show a cycle that had not begun while its
    phases ran."""
    root = Activity.get("qa")
    assert root.state is ActivityState.PENDING

    Activity.get("qa/phase-1/step-2").inc_success()

    assert root.state is ActivityState.RUNNING
    assert Activity.get("qa/phase-1").state is ActivityState.RUNNING
    assert root.started_at is not None


def test_a_child_tick_keeps_its_ancestors_fresh():
    """Without this a root that only orchestrates carries no ``updated_at`` and is
    reported stale by ``monitor.stale()`` while its children tick furiously."""
    root = Activity.get("qa")
    root.inc_success()
    before = root.updated_at

    root.child("phase-1").inc_success()

    assert root.updated_at > before


def test_a_blocked_parent_is_not_un_blocked_by_a_draining_child():
    """Only ``pending`` is woken. A parent that was deliberately blocked stays blocked —
    a child still finishing its last item is not the block clearing."""
    root = Activity.get("qa")
    root.child("phase-1").inc_success()
    root.block("waiting on the hub")

    root.child("phase-1").inc_success()

    assert root.state is ActivityState.BLOCKED


def test_a_terminal_ancestor_is_not_revived_by_a_late_child_tick():
    root = Activity.get("qa")
    child = root.child("phase-1")
    child.inc_success()
    root.done()

    child.inc_success()

    assert root.state is ActivityState.COMPLETED
