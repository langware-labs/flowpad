"""``ActivityProgressSpec`` — the shape every progress producer reports through.

These pin the three invariants the old ``IndexProgressTable`` got wrong, because each
one was a user-visible defect and not a matter of taste: unknown is not zero, the error
count is not the error sample, and the shape is capped so a full snapshot per tick stays
affordable.
"""

import json

import pytest

from flow_sdk.schema.data_spec.activity_spec import (
    MAX_DEPTH,
    MAX_ERROR_SAMPLE,
    TERMINAL,
    ActivityErrorSpec,
    ActivityProgressSpec,
    ActivityState,
    trim_errors,
)

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


def spec(**kw) -> ActivityProgressSpec:
    base = {"activity_id": "a1", "path": "index", "name": "index"}
    return ActivityProgressSpec(**{**base, **kw})


def test_kind_is_registered_and_resolvable():
    """A kind that is never imported resolves to ``Any`` and fails SILENTLY — no error
    anywhere, just an untyped field. This is the test that catches a missing line in
    ``register_builtin_kinds``."""
    from flow_sdk.fs_store.schema_registry import SchemaRegistry
    from flow_sdk.schema.data_spec._kinds import register_builtin_kinds

    register_builtin_kinds()

    assert SchemaRegistry.kind_type("activity.progress") is ActivityProgressSpec
    assert SchemaRegistry.kind_type("activity.error") is ActivityErrorSpec
    assert SchemaRegistry.kind_for(ActivityProgressSpec) == "activity.progress"


def test_extra_keys_are_forbidden():
    """A misspelled key must fail loudly rather than yield a row with an empty field."""
    with pytest.raises(Exception):
        ActivityProgressSpec(activity_id="a", path="p", name="p", totl=5)


def test_frozen():
    s = spec(done=1)
    with pytest.raises(Exception):
        s.done = 2


def test_total_none_means_unknown_and_zero_means_zero():
    """The bug this replaces: ``total=0`` doubled as "unknown", so a scan whose
    discovery IS the count could not be told from a job with nothing to do."""
    assert spec(total=None, done=7).fraction() is None
    assert spec(total=0, done=0).fraction() is None
    assert spec(total=4, done=1).fraction() == 0.25


def test_fraction_prefers_own_total_then_rolls_up_children():
    parent = spec(
        path="index",
        children=[
            spec(activity_id="c1", path="index/md", name="md", total=100, done=100),
            spec(activity_id="c2", path="index/pdf", name="pdf", total=100, done=0),
        ],
    )
    assert parent.fraction() == 0.5, "a parent that only orchestrates still shows a bar"

    parent_with_own = parent.model_copy(update={"total": 10, "done": 1})
    assert parent_with_own.fraction() == 0.1, "own total wins over the rollup"


def test_fraction_ignores_children_with_unknown_totals():
    parent = spec(
        children=[
            spec(activity_id="c1", path="index/md", name="md", total=10, done=5),
            spec(activity_id="c2", path="index/scan", name="scan", total=None, done=999),
        ],
    )
    assert parent.fraction() == 0.5


def test_fraction_never_exceeds_one():
    """A producer that over-counts must not render a 340% bar."""
    assert spec(total=10, done=34).fraction() == 1.0


def test_error_sample_is_capped_head_and_tail():
    """The count is the truth, the list is a sample. Keeping only the tail would lose
    the first failure (usually the one that explains the rest); keeping only the head
    would show errors that stopped being current an hour ago."""
    errors = [ActivityErrorSpec(message=f"e{i}") for i in range(50)]
    kept = trim_errors(errors)

    assert len(kept) == MAX_ERROR_SAMPLE
    assert kept[0].message == "e0", "the first failure survives"
    assert kept[-1].message == "e49", "so does the most recent"


def test_error_sample_under_the_cap_is_untouched():
    errors = [ActivityErrorSpec(message=f"e{i}") for i in range(4)]
    assert [e.message for e in trim_errors(errors)] == ["e0", "e1", "e2", "e3"]


def test_terminal_set_covers_every_ending_and_no_live_state():
    assert TERMINAL == {
        ActivityState.COMPLETED,
        ActivityState.FAILED,
        ActivityState.CANCELLED,
        ActivityState.INTERRUPTED,
    }
    for live in (ActivityState.PENDING, ActivityState.RUNNING, ActivityState.PAUSED, ActivityState.BLOCKED):
        assert not spec(state=live).is_terminal
    for done in TERMINAL:
        assert spec(state=done).is_terminal


def test_walk_and_find_address_the_whole_tree():
    tree = spec(
        children=[
            spec(
                activity_id="c1",
                path="index/pdf",
                name="pdf",
                children=[spec(activity_id="g1", path="index/pdf/ocr", name="ocr")],
            )
        ]
    )
    assert [n.path for n in tree.walk()] == ["index", "index/pdf", "index/pdf/ocr"]
    assert tree.find("index/pdf/ocr").name == "ocr"
    assert tree.find("index/nope") is None


def test_round_trips_through_json():
    """The wire form. A field that does not survive this never reaches the frontend."""
    original = spec(
        label="Indexing",
        icon="Search",
        state=ActivityState.BLOCKED,
        current="~/notes/q3.md",
        total=100,
        done=25,
        skipped=3,
        errors_count=9,
        errors=[ActivityErrorSpec(message="encrypted", ref="a.pdf", code="E_ENC")],
        counters={"orphans": 17},
        seq=812,
        children=[spec(activity_id="c1", path="index/pdf", name="pdf", total=10)],
    )

    restored = ActivityProgressSpec.model_validate(json.loads(original.model_dump_json()))

    assert restored == original
    assert restored.state is ActivityState.BLOCKED
    assert restored.counters == {"orphans": 17}
    assert restored.children[0].name == "pdf"


def test_state_serialises_as_a_plain_string():
    """The frontend mirror is a string union; an enum that dumped as an object would
    silently break it."""
    assert json.loads(spec(state=ActivityState.RUNNING).model_dump_json())["state"] == "running"


def test_depth_cap_is_declared_for_producers_to_honour():
    """The cap belongs to the shape, not to one emitter's manners. ``Activity.child``
    enforces it — see ``test_activity_handle.py``."""
    assert MAX_DEPTH == 3
