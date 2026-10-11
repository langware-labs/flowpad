"""Asking a dataset for SOME of its rows -- ``Dataset.query`` / ``count`` and the ``rows`` / ``count``
actions -- on the expression entity queries already speak, evaluated in memory
(``flow_sdk.datasets.query``). The cases the TypeScript evaluator must answer the same way live in
``test_fixtures/dataset_query_cases.json``; ``ui/tests/unit/dataset-query-parity.test.ts`` runs them too.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import ClassVar, Optional

import pytest

from flow_sdk.datasets.query import count, expression, field_of, matches, order, select
from flow_sdk.schema.data_spec.dataset_spec import DatasetSpec, ExampleSpec
from flow_sdk.schema.data_spec.spec import DataSpec

pytestmark = pytest.mark.timeout(5)

CASES = json.loads((Path(__file__).parents[3] / "test_fixtures/dataset_query_cases.json").read_text())


@pytest.mark.parametrize("case", CASES["cases"], ids=lambda c: c["name"])
def test_the_shared_cases(case):
    assert matches(expression(case["match"]), CASES["row"]) is case["passes"]


def test_no_match_passes_everything_and_a_bad_one_is_refused():
    assert matches(expression(None), {"a": 1}) and matches(expression({}), {"a": 1})
    with pytest.raises(ValueError):
        expression("input.day > 3")
    with pytest.raises(ValueError):
        matches(expression({"op": "$PROP", "operands": ["a", "b"]}), {"a": 1})


def test_a_key_written_with_a_dot_wins_over_the_walk():
    assert field_of({"a.b": 1, "a": {"b": 2}}, "a.b") == 1
    assert field_of({"a": {"b": 2}}, "a.b") == 2
    assert field_of({"a": [10, 20]}, "a.5") is None and field_of(None, "a") is None


def test_a_comparison_across_kinds_is_false_not_an_error():
    assert matches(expression({"op": "$GT", "operands": ["n", "x"]}), {"n": 3}) is False


ROWS = [{"key": k, "input": {"day": d, "metric": m, "n": n}} for k, d, m, n in [
    ("a", "2026-09-03", "sent", 2), ("b", "2026-09-01", "reply", None), ("c", "2026-09-02", "sent", 1),
    ("d", "2026-08-30", "reply", 5), ("e", "2026-09-02", "mtg", 3)]]


def test_order_is_stable_takes_several_fields_and_puts_nulls_last():
    assert [r["key"] for r in order(ROWS, {"input.day": "asc"})] == ["d", "b", "c", "e", "a"]
    assert [r["key"] for r in order(ROWS, [{"input.metric": "asc"}, {"input.day": "desc"}])] == ["e", "b", "d", "a", "c"]
    assert [r["key"] for r in order(ROWS, {"input.n": "asc"})] == ["c", "a", "e", "d", "b"]
    assert [r["key"] for r in order(ROWS, {"input.n": "desc"})] == ["b", "d", "e", "a", "c"]
    with pytest.raises(ValueError, match="'asc' or 'desc'"):
        order(ROWS, {"input.day": "up"})


def test_select_matches_orders_then_pages_and_counts_before_paging():
    september = {"op": "$GE", "operands": ["input.day", "2026-09-01"]}
    page, total = select(ROWS, match=september, order_by={"input.day": "asc"}, limit=2, offset=1)
    assert ([r["key"] for r in page], total) == (["c", "e"], 4)
    assert select(ROWS, limit=0) == ([], 5)
    assert [r["key"] for r in select(ROWS, offset=4)[0]] == ["e"]


def test_count_and_group_by():
    assert count(ROWS) == {"total": 5, "groups": []}
    got = count(ROWS, match={"op": "$GE", "operands": ["input.day", "2026-09-01"]}, group_by=["input.metric"])
    assert got == {"total": 4, "groups": [{"by": {"input.metric": "sent"}, "count": 2},
                                           {"by": {"input.metric": "reply"}, "count": 1},
                                           {"by": {"input.metric": "mtg"}, "count": 1}]}
    two = count(ROWS, group_by=["input.metric", "input.day"])
    assert two["total"] == 5 and len(two["groups"]) == 5 and two["groups"][0]["by"] == {"input.metric": "sent", "input.day": "2026-09-03"}


# ── on a dataset, and over HTTP ──────────────────────────────────────────────


class Touch(DataSpec):
    spec_kind: ClassVar[str] = "unittest.rowquery.touch"
    metric: str
    day: str
    person: Optional[str] = None


class Touches(DatasetSpec[ExampleSpec[Touch, DataSpec, DataSpec]]):
    spec_kind: ClassVar[str] = "unittest.rowquery.dataset"


def _dataset(tmp_path, dataset_id="7e0f3a4b-5c6d-4e7f-9a8b-9c0d1e2f3a4b"):
    from flow_sdk.builtin.dataset import Dataset

    return Dataset(id=dataset_id, name="touches", asset_ref=str(tmp_path), data_layout="io_folder", spec="unittest.rowquery.dataset")


async def _filled(tmp_path, save=False):
    d = _dataset(tmp_path)
    if save:
        await d.save()
    await d.append([{"key": f"t{n}", "input": {"metric": "reply" if n % 2 else "sent", "day": f"2026-09-{n:02d}", "person": f"P{n}"}}
                    for n in range(1, 7)])
    return d


async def test_query_answers_matching_rows_with_their_key_ref_and_version(tmp_path):
    d = await _filled(tmp_path)
    got = d.query({"op": "$AND", "operands": [{"input.metric": "reply"}, {"op": "$GE", "operands": ["input.day", "2026-09-03"]}]},
                  order_by={"input.day": "desc"})
    assert [r["key"] for r in got["rows"]] == ["t5", "t3"] and got["total"] == 2 and got["problems"] == []
    assert set(got["rows"][0]) >= {"key", "id", "ref", "version", "input"}
    assert d.query(limit=2, offset=4)["total"] == 6
    assert d.count({"input.metric": "sent"}, group_by=["input.metric"]) == {"total": 3, "groups": [{"by": {"input.metric": "sent"}, "count": 3}]}


async def test_a_filter_never_hides_a_row_that_does_not_fit(tmp_path):
    d = await _filled(tmp_path)
    doc = next((tmp_path / "examples/t2/input").glob("*.json"))
    doc.write_text(doc.read_text().replace('"sent"', "7"))
    got = d.query({"input.metric": "reply"})
    assert got["total"] == 3 and [p["key"] for p in got["problems"]] == ["t2"]
    assert d.count()["total"] == 5


async def test_the_read_actions_over_http(tmp_path):
    from tests.unit._graph_client import call_local

    d = await _filled(tmp_path, save=True)
    base = f"dataset/{d.id}"
    everything = (await call_local("GET", f"{base}/rows")).json()["data"]
    assert len(everything["rows"]) == 6 and everything["total"] == 6          # no filter: every row, as before

    flt = json.dumps({"match": {"op": "$GE", "operands": ["input.day", "2026-09-03"]}, "order_by": {"input.day": "desc"}, "limit": 2})
    page = (await call_local("GET", f"{base}/rows", params={"filter": flt})).json()["data"]
    assert [r["key"] for r in page["rows"]] == ["t6", "t5"] and page["total"] == 4

    bare = (await call_local("GET", f"{base}/rows", params={"filter": json.dumps({"input.metric": "sent"}), "limit": "1", "offset": "1"})).json()["data"]
    assert [r["key"] for r in bare["rows"]] == ["t4"] and bare["total"] == 3   # a bare map is the match; top-level paging

    counted = (await call_local("GET", f"{base}/count", params={"group_by": "input.metric"})).json()["data"]
    assert counted["total"] == 6 and {g["by"]["input.metric"]: g["count"] for g in counted["groups"]} == {"reply": 3, "sent": 3}

    assert (await call_local("GET", f"{base}/rows", params={"filter": "{not json"})).status_code == 400
    assert (await call_local("GET", f"{base}/rows", params={"limit": "-1"})).status_code == 400
