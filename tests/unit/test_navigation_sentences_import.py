"""The 200 UX sentences as SmartNavigator eval rows: each one valid, complete and typed.

Reads ``docs/navigation/navigation-sentences.md`` through the importer's own ``build`` -- nothing is
written -- and checks every row against the shipped ``navigator.dataset`` row kind.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "import_navigation_sentences.py"


def first(row: dict) -> dict:
    gt = row["ground_truth"]
    return gt[0] if isinstance(gt, list) else gt


@pytest.fixture(scope="module")
def built() -> list[dict]:
    spec = importlib.util.spec_from_file_location("import_navigation_sentences", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.build({})


def test_two_hundred_rows_each_a_valid_navigator_example(built):
    from flow_sdk.fs_store.schema_registry import SchemaRegistry
    from flow_sdk.schema.data_spec import declared

    declared.ensure_shipped()
    row_type = SchemaRegistry.kind_type("navigator.dataset").example_type()
    assert len(built) == 200 and sorted(r["data"]["n"] for r in built) == list(range(1, 201))
    for r in built:
        row_type.model_validate(r)


def test_every_target_is_concrete_and_every_action_is_typed(built):
    for r in built:
        target = first(r)["target"]
        assert "<" not in target["value"] and "…" not in target["value"], r["data"]["target"]
        assert (target["kind"] == "action") == r["data"]["target"].startswith("ACTION:")
    assert sum(first(r)["target"]["kind"] == "action" for r in built) == 53  # the doc's ACTION rows


def test_a_this_sentence_is_typed_where_this_is(built):
    by_n = {r["data"]["n"]: r for r in built}
    transcript = by_n[24]  # "show this session's transcript"
    assert transcript["data"]["from"] == "session" and transcript["input"]["here"]["process"]["title"] == "refactor session"
    task = by_n[74]  # "open the zoom oauth task": the task is among the recorded candidates
    assert task["context"]["candidates"][0]["title"] == "Zoom OAuth on dev"
    assert first(task)["target"] == {"kind": "entity", "value": task["context"]["candidates"][0]["typeid"]}
    connections = by_n[101]  # "open connections": the bare screen opens its only tab -- both right
    gold = connections["ground_truth"]
    assert gold["target"]["value"] == "credentials/connections", "one gold: the eval judges a screen and its default tab one place"
