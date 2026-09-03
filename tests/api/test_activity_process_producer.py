"""A running agentic process reports as an activity.

This is the producer wired in phase 1 — the reason the footer chip can show one list and
one count covering agents alongside every other kind of long-running work. The bridge is a
projection of the status report that is already computed on each debounce flush, so what
these pin is the mapping, not a second source of truth.
"""

import pytest

from flow_sdk.activity import ActivityState, monitor
from flow_sdk.builtin.agentic_process.activity_bridge import (
    PROCESS_ACTIVITY_PATH,
    end_process_activity,
    scope_for,
    sync_process_activity,
)
from flow_sdk.builtin.worker_status import WorkerStatus

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

PROC = "11111111-1111-4111-8111-111111111111"


@pytest.fixture(autouse=True)
def _clean_monitor():
    monitor.clear()
    yield
    monitor.clear()


def spec():
    return monitor.get(PROCESS_ACTIVITY_PATH, scope=scope_for(PROC))


def report(**counters):
    base = {
        "assistant_messages": 0,
        "tool_calls": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
    }
    return {"counters": {**base, **counters}}


def test_a_flush_creates_the_process_activity_in_its_own_scope():
    sync_process_activity(PROC, label="fix nav bug", worker_status=WorkerStatus.WORKING, report=report())

    assert spec() is not None
    assert spec().label == "fix nav bug"
    assert spec().scope == f"agentic_process-{PROC}"
    assert monitor.get(PROCESS_ACTIVITY_PATH) is None, "it is not on the instance-wide address"


def test_the_activity_carries_no_icon_so_the_process_glyph_is_inherited():
    """An activity's icon falls back to its scope entity's ``TypeInfo.icon``, and the scope
    IS the process. Setting a glyph here would duplicate the type registry."""
    sync_process_activity(PROC, worker_status=WorkerStatus.WORKING, report=report())

    assert spec().icon is None


def test_counters_are_projected_as_totals_not_compounded():
    """The report carries running totals and ``inc`` is a delta verb. Passing the total
    through on every flush would compound it into nonsense within seconds."""
    sync_process_activity(PROC, worker_status=WorkerStatus.WORKING, report=report(assistant_messages=3, tool_calls=7, input_tokens=100))
    sync_process_activity(PROC, worker_status=WorkerStatus.WORKING, report=report(assistant_messages=5, tool_calls=9, input_tokens=250))

    assert spec().counters == {"messages": 5, "tool_calls": 9, "tokens": 250}


def test_a_counter_that_goes_backwards_is_ignored_not_subtracted():
    """A re-parsed transcript can report a lower total. A row must not count down."""
    sync_process_activity(PROC, worker_status=WorkerStatus.WORKING, report=report(tool_calls=9))
    sync_process_activity(PROC, worker_status=WorkerStatus.WORKING, report=report(tool_calls=2))

    assert spec().counters["tool_calls"] == 9


def test_tokens_sum_the_four_disjoint_buckets():
    sync_process_activity(
        PROC,
        worker_status=WorkerStatus.WORKING,
        report=report(input_tokens=100, output_tokens=50, cache_read_tokens=20, cache_write_tokens=5),
    )

    assert spec().counters["tokens"] == 175


def test_the_focused_asset_becomes_what_is_in_hand():
    sync_process_activity(
        PROC, worker_status=WorkerStatus.WORKING, report=report(), focused_asset="compute_node-@local/ui/src/app.tsx"
    )

    assert spec().current == "compute_node-@local/ui/src/app.tsx"


@pytest.mark.parametrize(
    "worker_status",
    [WorkerStatus.WORKING, WorkerStatus.THINKING, WorkerStatus.TOOL_CALL, WorkerStatus.TOOL_RUNNING],
)
def test_every_active_worker_status_reads_as_running(worker_status):
    """To someone reading a chip these all mean the same thing. Mapping each one would
    make the row flicker between synonyms."""
    sync_process_activity(PROC, worker_status=worker_status, report=report())

    assert spec().state is ActivityState.RUNNING


def test_pending_user_blocks_the_activity():
    """The worker asked a question and handed control back — that is a person's cue, which
    is exactly what blocked means."""
    sync_process_activity(PROC, worker_status=WorkerStatus.WORKING, report=report())
    sync_process_activity(PROC, worker_status=WorkerStatus.PENDING_USER, report=report())

    assert spec().state is ActivityState.BLOCKED
    assert spec().message == "waiting for you"


def test_leaving_pending_user_resumes_it():
    sync_process_activity(PROC, worker_status=WorkerStatus.PENDING_USER, report=report())
    sync_process_activity(PROC, worker_status=WorkerStatus.WORKING, report=report())

    assert spec().state is ActivityState.RUNNING


def test_a_terminal_worker_status_ends_and_evicts_the_activity():
    sync_process_activity(PROC, worker_status=WorkerStatus.WORKING, report=report())

    sync_process_activity(PROC, worker_status=WorkerStatus.COMPLETE, report=report())

    assert spec() is None, "the chip stops counting a finished process"
    assert monitor.count() == 0


def test_an_errored_worker_fails_the_activity():
    captured = []
    monitor.subscribe(lambda root, transition: captured.append((root.state, transition)))

    sync_process_activity(PROC, worker_status=WorkerStatus.WORKING, report=report())
    sync_process_activity(PROC, worker_status=WorkerStatus.ERROR, report=report())

    assert (ActivityState.FAILED, True) in captured
    assert spec() is None


def test_a_late_flush_after_a_terminal_is_ignored():
    """Debounce callbacks hold independently hydrated process objects and can arrive after
    the process is gone. A late one must not resurrect a row on the chip."""
    sync_process_activity(PROC, worker_status=WorkerStatus.COMPLETE, report=report())

    sync_process_activity(PROC, worker_status=WorkerStatus.WORKING, report=report(tool_calls=99))

    assert monitor.count() == 1, "a fresh row was minted rather than the old one revived"
    assert spec().counters.get("tool_calls") == 99


def test_end_process_activity_closes_it_explicitly():
    sync_process_activity(PROC, worker_status=WorkerStatus.WORKING, report=report())

    end_process_activity(PROC, message="closed")

    assert spec() is None


def test_the_bridge_never_raises_on_a_malformed_report():
    """It runs inside the transcript debounce path, where an exception would be far from
    its cause — and progress reporting is never a reason for a turn to fail."""
    sync_process_activity(PROC, worker_status=WorkerStatus.WORKING, report={"counters": "not-a-dict"})
    sync_process_activity(PROC, worker_status=WorkerStatus.WORKING, report=None)
    sync_process_activity(PROC, worker_status=None, report=report())

    assert monitor.count() <= 1


def test_counters_use_the_absolute_verb_so_the_policy_lives_on_activity():
    """The report carries running totals. Doing the delta arithmetic here would make every
    producer invent its own answer for a total that went down; ``set_counter`` puts that
    one decision on ``Activity`` where they all inherit it."""
    import inspect

    from flow_sdk.builtin.agentic_process import activity_bridge

    source = inspect.getsource(activity_bridge.sync_process_activity)
    assert "set_counter" in source
    assert ".inc(" not in source, "a producer should not be computing counter deltas"


def test_close_and_delete_end_the_activity():
    """A process closed or deleted mid-turn produces no further status flush, so a
    terminal worker status never arrives — without an explicit end its row sits on the
    footer chip as live work forever."""
    import inspect

    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

    for method in (AgenticProcess.close, AgenticProcess.delete):
        assert "end_process_activity" in inspect.getsource(method), (
            f"{method.__name__} must end the process's activity"
        )
