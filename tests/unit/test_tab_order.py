"""Backend half of the front/back tab-ordering parity proof.

Runs the SHARED matrix (``ui/tests/fixtures/tab-order-matrix.json``) through the
pure ``flow_sdk.builtin.tab_order`` algebra and asserts the expected global order,
the persisted-rows set, and every per-project filtered view. The frontend suite
(``ui/tests/unit/tab-order.test.ts``) runs the same JSON through its port and
asserts the SAME ``expectedOrder`` — so if both suites pass, front and back agree
on tab order for every case by construction.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.builtin.tab_order import (
    changed_ids,
    compute_close,
    compute_insert_new,
    compute_reorder,
    filter_for_project,
)

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

_MATRIX = json.loads(
    (Path(__file__).resolve().parents[2] / "ui/tests/fixtures/tab-order-matrix.json").read_text()
)
_CASES = _MATRIX["cases"]


def _project_map(case: dict) -> dict[str, str | None]:
    pmap: dict[str, str | None] = {t["id"]: t["project"] for t in case["tabs"]}
    if case["op"] == "new_tab":
        pmap[case["args"]["new_id"]] = case["args"].get("project")
    return pmap


def _apply(case: dict) -> list[str]:
    order = [t["id"] for t in case["tabs"]]
    op, args = case["op"], case["args"]
    if op == "reorder":
        return compute_reorder(order, args["reorder_id"], args["after_id"], args["before_id"])
    if op == "new_tab":
        return compute_insert_new(order, args["new_id"], args["after_id"])
    if op == "close":
        return compute_close(order, args["id"])
    if op in ("reopen", "filter"):
        return list(order)
    raise AssertionError(f"unknown op {op!r}")


@pytest.mark.parametrize("case", _CASES, ids=[c["name"] for c in _CASES])
def test_tab_order_matrix(case: dict) -> None:
    input_order = [t["id"] for t in case["tabs"]]
    result = _apply(case)

    assert result == case["expectedOrder"], f"order mismatch for {case['name']}"

    if "expectedWrites" in case:
        assert changed_ids(input_order, result) == set(case["expectedWrites"]), (
            f"changed-rows mismatch for {case['name']}"
        )

    pmap = _project_map(case)
    for key, expected in case.get("expectedFiltered", {}).items():
        pid = None if key == "null" else key
        assert filter_for_project(result, pmap, pid) == expected, (
            f"filtered view {key!r} mismatch for {case['name']}"
        )
