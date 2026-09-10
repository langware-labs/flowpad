"""A trigger is an asset: one spec, indexed off disk, armed on arrival.

The document declares; the ROW counts. Keeping those apart is the whole design,
and the test that matters most here is the last one — re-indexing a spent
`fire_once` trigger must not re-arm it. The seed path got that guarantee from
`_UPSERT_SKIP_KEYS`; the index path has no equivalent, so it is proved here.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.builtin.trigger import TriggerType
from flow_sdk.fs_store.indexer.functions.trigger import (
    extract_trigger,
    read_trigger,
    row_fields,
    trigger_document_problem,
)
from flow_sdk.schema.data_spec.trigger_spec import TriggerActionSpec, TriggerSpec

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


def _write(tmp_path: Path, doc: dict, name: str = "on-app-ready") -> Path:
    folder = tmp_path / "agentic-assets" / "trigger" / name
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "trigger.json").write_text(json.dumps(doc), encoding="utf-8")
    return folder


TAG_DOC = {
    "name": "On app ready",
    "fire_once": True,
    "tag": {"on": "app.ready"},
    "actions": [{"run_wizard": ""}],
}


# ── the spec ────────────────────────────────────────────────────────────────

def test_exactly_one_kind_and_exactly_one_verb():
    """Four disjoint variants as a type tag plus thirty optionals is what the
    entity does; a spec says which block is present."""
    ok = TriggerSpec.model_validate(TAG_DOC)
    assert ok.kind == "tag"
    assert ok.actions[0].verb == "run_wizard"

    for bad in ({"name": "x"}, {"name": "x", "tag": {"on": "a"}, "hook": {"events": []}}):
        with pytest.raises(ValueError, match="exactly one of"):
            TriggerSpec.model_validate(bad)
    for bad_action in ({}, {"run_wizard": "w", "callback": "c"}):
        with pytest.raises(ValueError, match="exactly one of"):
            TriggerActionSpec.model_validate(bad_action)


def test_a_document_can_never_carry_runtime_state():
    """A counter committed to a document lands on a fresh machine already spent,
    and `fire_once` suppresses the very first run — silently, and only on other
    people's machines. `extra="forbid"` is what makes that unwriteable."""
    for runtime in ("counter", "last_run", "last_triggered", "next_run"):
        with pytest.raises(ValueError):
            TriggerSpec.model_validate({**TAG_DOC, runtime: 1})


def test_an_empty_run_wizard_means_my_parent(tmp_path):
    """The case an author can actually write: a trigger nested in a wizard, by
    someone who does not have the wizard's uuid yet."""
    spec = read_trigger(_write(tmp_path, TAG_DOC))
    implied = row_fields(spec, parent_type_id="wizard-abc")["actions"][0]
    assert implied["target_type_id"] == "wizard-abc"

    named = row_fields(TriggerSpec.model_validate(
        {**TAG_DOC, "actions": [{"run_wizard": "wizard-xyz"}]}
    ), parent_type_id="wizard-abc")["actions"][0]
    # An explicit target wins: a standalone trigger launches something elsewhere.
    assert named["target_type_id"] == "wizard-xyz"


# ── the flattening ──────────────────────────────────────────────────────────

@pytest.mark.parametrize("doc,expected_type,check", [
    ({"tag": {"on": "app.ready"}}, TriggerType.TAG, ("tag_pattern", "app.ready")),
    ({"schedule": {"every": "cron", "expr": "0 9 * * *"}}, TriggerType.SCHEDULE, ("expr", "0 9 * * *")),
    ({"watch": {"path": "/tmp/x"}}, TriggerType.FSOP, ("watch_path", "/tmp/x")),
    ({"hook": {"events": ["PostToolUse"]}}, TriggerType.HOOK, ("hook_events", ["PostToolUse"])),
])
def test_each_kind_flattens_onto_the_row(doc, expected_type, check):
    """The document is nested because that is honest; the row is flat because
    that is what every existing reader expects. This is the translation."""
    fields = row_fields(TriggerSpec.model_validate({"name": "t", **doc}))
    assert fields["trigger_type"] == expected_type
    key, value = check
    assert fields[key] == value


def test_firing_policy_is_general_not_tag_only():
    """`fire_once` and the storm cap are labelled "(TAG only)" on the entity
    because that is where they were implemented — nothing about them is about
    the bus. A watch on a noisy path wants a cap more than a tag does."""
    fields = row_fields(TriggerSpec.model_validate({
        "name": "t", "fire_once": True, "max_fires_per_minute": 5,
        "watch": {"path": "/tmp/x"},
    }))
    assert fields["trigger_type"] == TriggerType.FSOP
    assert fields["fire_once"] is True
    assert fields["max_fires_per_minute"] == 5


# ── the reader ──────────────────────────────────────────────────────────────

def test_a_broken_document_still_emits_a_row_and_says_why(tmp_path):
    """The row is the only way to open the thing and fix it — so the reader
    swallows, but it does not stay silent."""
    folder = tmp_path / "agentic-assets" / "trigger" / "broken"
    folder.mkdir(parents=True)
    (folder / "trigger.json").write_text('{"name": "no kind here"}', encoding="utf-8")

    assert read_trigger(folder) is None
    assert "exactly one of" in trigger_document_problem(folder)

    from flow_sdk.fs_store.fs_ref import FSRef
    records = extract_trigger(FSRef(folder), "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")
    assert len(records) == 1
    assert records[0].name == "broken"


def test_the_row_fields_ride_the_record_FLAT(tmp_path):
    """`Entity.from_record` lifts a NESTED `metadata` onto entity fields only
    for names the type's `meta_model` declares — TRIGGER declares none. So a
    nested payload stays nested and the row silently keeps its DEFAULTS.

    Caught in a container: the trigger indexed cleanly, produced a row, and the
    row came back `trigger_type='hook'` — the enum default — with a tag pattern
    nowhere. Nothing errored, which is what makes it worth a test."""
    from flow_sdk.fs_store.fs_ref import FSRef

    rec = extract_trigger(FSRef(_write(tmp_path, TAG_DOC)), "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")[0]
    flat = rec.meta_dict()
    assert flat["trigger_type"] == TriggerType.TAG, "the kind must not fall back to the default"
    assert flat["tag_pattern"] == "app.ready"
    assert flat["fire_once"] is True


def test_the_asset_ref_is_the_folder_not_the_document(tmp_path):
    from flow_sdk.fs_store.fs_ref import FSRef

    folder = _write(tmp_path, TAG_DOC)
    rec = extract_trigger(FSRef(folder), "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")[0]
    assert rec._asset_ref.path == str(folder.resolve())


# ── the guarantee the index path does not inherit ───────────────────────────

def test_reindexing_never_writes_runtime_state(tmp_path):
    """`_UPSERT_SKIP_KEYS` kept counter/last_run off the seed path. The index
    path has no such list — the guarantee has to come from the extractor never
    producing those fields at all. If this breaks, every re-index re-arms every
    spent fire-once trigger on the machine."""
    from flow_sdk.fs_store.fs_ref import FSRef

    rec = extract_trigger(FSRef(_write(tmp_path, TAG_DOC)), "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")[0]
    produced = rec.meta_dict()
    nested = produced.get("metadata") or {}
    for runtime in ("counter", "last_run", "last_triggered", "next_run",
                    "last_seen_mtime", "last_seen_size"):
        assert runtime not in produced, f"{runtime} must never come off disk"
        assert runtime not in nested, f"{runtime} must never come off disk"
