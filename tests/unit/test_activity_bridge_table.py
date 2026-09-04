"""The legacy-table mirror — what every unmigrated producer looks like in the new chip.

Each producer already builds an ``IndexProgressTable`` and broadcasts it; reflecting that
table onto the activity holding its address is what makes the whole set visible at once,
without rewriting eight producers before any of them can be seen.

The conversions that matter are the ones where the two shapes DISAGREE: the old table's
`total=0` means "unknown", and its `done` already includes the skipped.
"""

import pytest

from flow_sdk.activity import Activity, ActivityState
from flow_sdk.activity.bridge import mirror_table
from flow_sdk.fs_store.indexer import PROGRESS_TEXT_COMPLETE, IndexProgressTable, TypeProgressRow

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


def table(**kw) -> IndexProgressTable:
    base = dict(job_name="index", rows=(), current=None, done=0, total=0, text=None, ts="")
    return IndexProgressTable(**{**base, **kw})


def test_the_job_name_becomes_a_label_and_a_glyph():
    act = Activity.get("index")

    mirror_table(act, table(job_name="index"))

    spec = act.spec()
    assert spec.label == "Indexing"
    assert spec.icon == "DatabaseZap"


def test_an_unknown_total_stops_meaning_zero():
    """The confusion this migration exists to end. `total=0` in the old shape means the
    producer does not know — a scan discovers as it goes — and a bar pinned at 0% for ten
    minutes is a lie about a job that is working fine."""
    act = Activity.get("scan")

    mirror_table(act, table(job_name="scan", done=1204, total=0))

    spec = act.spec()
    assert spec.total is None, "unknown, not zero — a bar pinned at 0% would be a lie"
    assert spec.done == 1204


def test_a_known_total_carries_through():
    act = Activity.get("index")

    mirror_table(act, table(done=25, total=100))

    assert act.spec().fraction() == 0.25


def test_rows_become_children_keyed_by_type():
    act = Activity.get("index")

    mirror_table(
        act,
        table(
            rows=(
                TypeProgressRow(type_name="markdown", done=10, total=10),
                TypeProgressRow(type_name="pdf", done=2, total=30, errors=1, skipped=1),
            ),
            done=12,
            total=40,
        ),
    )

    spec = act.spec()
    assert [c.name for c in spec.children] == ["markdown", "pdf"]
    pdf = spec.children[1]
    assert (pdf.done, pdf.total, pdf.errors_count, pdf.skipped) == (2, 30, 1, 1)


def test_skipped_is_not_double_counted():
    """The old row's `done` ALREADY includes its `skipped`. Adding both as deltas would
    make a folder of 1000 fresh files report 2000 done."""
    act = Activity.get("index")

    mirror_table(act, table(rows=(TypeProgressRow(type_name="markdown", done=1000, total=1000, skipped=900),)))

    child = act.spec().children[0]
    assert (child.done, child.skipped) == (1000, 900)


def test_successive_tables_advance_rather_than_restate():
    """Tables carry running totals and the activity's verbs take deltas, so mirroring the
    same table twice must not move anything."""
    act = Activity.get("index")

    def rows(done: int):
        return (TypeProgressRow(type_name="markdown", done=done, total=100),)

    mirror_table(act, table(rows=rows(10), done=10, total=100))
    mirror_table(act, table(rows=rows(40), done=40, total=100))
    mirror_table(act, table(rows=rows(40), done=40, total=100))

    assert act.spec().children[0].done == 40
    assert act.spec().done == 40


def test_a_count_that_goes_backwards_is_ignored():
    act = Activity.get("index")

    mirror_table(act, table(done=40, total=100))
    mirror_table(act, table(done=5, total=100))

    assert act.spec().done == 40


def test_current_and_phase_text_come_through():
    act = Activity.get("index")

    mirror_table(act, table(current="markdown", text="sweeping"))

    spec = act.spec()
    assert spec.current == "markdown"
    assert spec.message == "sweeping"


def test_the_terminal_marker_is_not_written_as_a_message():
    """`complete` is a state, not something to say. The caller ends the activity on it."""
    act = Activity.get("index")

    mirror_table(act, table(text=PROGRESS_TEXT_COMPLETE))

    assert act.spec().message is None


def test_errors_are_counted_even_though_the_table_carries_no_message():
    """The count was always true; the old shape simply never carried the reason."""
    act = Activity.get("index")

    mirror_table(act, table(rows=(TypeProgressRow(type_name="pdf", done=0, total=5, errors=300),)))

    child = act.spec().children[0]
    assert child.errors_count == 300
    assert child.errors, "a sample explains why there is no detail"


def test_a_mirror_failure_never_breaks_the_producer_and_is_not_silent(caplog):
    """A mirror must not fail the walk it describes — but a producer that renamed a field
    must not get a blank chip with nothing anywhere saying why either."""
    import logging

    from flow_sdk.builtin.faas.in_process_activity import InProcessActivity

    carrier = InProcessActivity(job_name="index", entity_id="node-1", activity=Activity.get("index"))

    with caplog.at_level(logging.DEBUG, logger="flow_sdk.builtin.faas.in_process_activity"):
        carrier.set_table(object())  # type: ignore[arg-type]

    assert Activity.get("index").state is not ActivityState.FAILED
    assert any("mirror failed" in r.message for r in caplog.records)
