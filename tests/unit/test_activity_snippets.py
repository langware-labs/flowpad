"""The snippets in ``docs/snippets/activity.md``, run verbatim.

The shelf's rule is that a snippet cannot drift silently, and a snippet nobody executes
drifts the moment a signature moves. Keep each test a transcription of one section; if a
snippet changes, change the test with it.
"""

import pytest

from flow_sdk.activity import Activity, ActivityState, monitor

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


@pytest.fixture(autouse=True)
def _clean_monitor():
    monitor.clear()
    yield
    monitor.clear()


def test_snippet_1_count():
    act = Activity.get("index").label("Indexing").total(5000)
    act.inc_success()
    act.inc_skipped()
    act.inc_error("encrypted", ref="a.pdf")
    act.inc("orphans", 17)
    act.set_counter("tokens", 4_200)
    act.current("~/notes/q3-plan.md")

    spec = act.spec()
    assert (spec.done, spec.skipped, spec.errors_count) == (2, 1, 1)
    assert spec.counters == {"orphans": 17, "tokens": 4_200}
    assert spec.current == "~/notes/q3-plan.md"
    assert spec.state is ActivityState.RUNNING and spec.started_at is not None

    # "unknown is not zero" — the prose's claim, made true.
    assert Activity.get("scan").total(None).inc_success().spec().fraction() is None


def test_snippet_2_children_from_anywhere():
    Activity.get("index").child("pdf").total(3000)

    Activity.get("index/pdf").inc_success()
    Activity.get("index/pdf").child("ocr").inc_error("0 pages", ref="b.pdf")

    tree = monitor.get("index")
    assert [n.path for n in tree.walk()] == ["index", "index/pdf", "index/pdf/ocr"]
    # A parent with no total of its own rolls up its children.
    assert tree.fraction() == pytest.approx(1 / 3000)
    # A child at work started and refreshed its ancestors.
    assert Activity.get("index").state is ActivityState.RUNNING
    assert Activity.get("index").updated_at is not None

    with pytest.raises(ValueError):
        Activity.get("a/b/c/d").child("e")


def test_snippet_3_end_it():
    act = Activity.get("index")
    act.inc_success()

    act.block("waiting for hub login")
    assert act.state is ActivityState.BLOCKED and not act.is_terminal
    act.resume()

    unfinished = act.child("pdf")
    unfinished.inc_success()
    act.done("indexed 5,000 · 17 orphans")

    assert act.state is ActivityState.COMPLETED
    assert unfinished.state is ActivityState.INTERRUPTED
    act.inc_success(99)
    assert act.spec().done == 1, "terminal is sticky"


def test_snippet_4_read_it_back():
    Activity.get("index").total(10).inc_success()
    Activity.get("index/pdf").current("a.pdf")

    spec = monitor.get("index")
    assert (spec.state, spec.done, spec.total, spec.errors_count, spec.skipped) == (
        ActivityState.RUNNING,
        1,
        10,
        0,
        0,
    )
    assert spec.children[0].current == "a.pdf"
    assert spec.fraction() == 0.1


def test_snippet_5_what_is_running_now():
    Activity.get("index").inc_success()
    Activity.get("qa").child("phase-1").inc_success()

    assert sorted(s.path for s in monitor.list()) == ["index", "qa"]
    assert monitor.count() == 2
    assert monitor.stale(seconds=60) == []

    act = Activity.get("index")
    if act.state == "running":
        with pytest.raises(RuntimeError):
            raise RuntimeError(f"index already running since {act.spec().started_at}")


def test_snippet_6_eviction():
    Activity.get("index").child("pdf").inc_success()
    Activity.get("index").done("indexed 5,000")

    assert monitor.get("index") is None
    assert Activity.get("index").state == "pending"


def test_snippet_7_scope():
    Activity.get("index").inc_success()
    Activity.get("run", scope="agentic_process-abc").inc_success()

    assert [s.path for s in monitor.list(scope="agentic_process-abc")] == ["run"]
    assert [s.path for s in monitor.list()] == ["index"]
