"""``Dataset.count`` beyond a count: date buckets and metrics -- one shared table of cases
(``test_fixtures/dataset_count_cases.json``), whose bucket keys the TypeScript side checks too."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.datasets.query import bucket_of, count

pytestmark = pytest.mark.timeout(5)

FIXTURE = json.loads((Path(__file__).parents[3] / "test_fixtures/dataset_count_cases.json").read_text())


@pytest.mark.parametrize("case", FIXTURE["buckets"], ids=lambda c: f"{c['day']} {c['unit']} {c['week_start']}")
def test_the_period_a_day_falls_in(case):
    assert bucket_of(case["day"], case["unit"], case["week_start"]) == case["key"]


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda c: c["name"])
def test_the_shared_count_cases(case):
    got = count(FIXTURE["rows"], **case["ask"])
    if "groups" in case:
        assert [[g["by"], g["count"], *([g["metrics"]] if "metrics" in g else [])] for g in got["groups"]] == case["groups"]
    if "metrics" in case:
        assert got["metrics"] == case["metrics"]


def test_metrics_are_absent_unless_asked_and_a_count_stays_a_count():
    assert count(FIXTURE["rows"]) == {"total": 6, "groups": []}
    assert set(count(FIXTURE["rows"], group_by=["input.metric"])["groups"][0]) == {"by", "count"}


@pytest.mark.parametrize("ask, why", [
    ({"group_by": ["fortnight:input.day"]}, "one of day:<path>"),
    ({"metrics": {"x": "avg:input.n"}}, "one of distinct:<path>"),
    ({"metrics": {"x": "input.n"}}, "one of distinct:<path>"),
    ({"group_by": ["input.metric"], "week_start": "saturday"}, "week_start"),
    ({"group_by": ["input.metric"], "order_by": {"input.day": "asc"}}, "a group is ordered by"),
    ({"group_by": ["input.metric"], "order_by": {"count": "up"}}, "'asc' or 'desc'"),
])
def test_a_question_that_cannot_be_asked_is_refused_by_name(ask, why):
    with pytest.raises(ValueError, match=why):
        count(FIXTURE["rows"], **ask)


def test_a_sum_skips_what_is_no_number_and_an_empty_min_is_null():
    rows = [{"input": {"n": "7"}}, {"input": {"n": True}}, {"input": {"n": 2.5}}, {"input": {}}]
    assert count(rows, metrics={"n": "sum:input.n", "lo": "min:input.absent"})["metrics"] == {"n": 2.5, "lo": None}
