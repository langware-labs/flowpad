"""Backend half of the front/back container-sort parity proof.

Runs the SHARED matrix (``ui/tests/fixtures/container-sort-matrix.json``)
through ``sort_container`` and asserts the same expected id sequences that
``ui/tests/unit/container-sort.test.ts`` asserts on ``sortContainer``.
"""

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from flow_sdk.builtin.bookmark import sort_container

_MATRIX = json.loads(
    (Path(__file__).resolve().parents[2] / "ui/tests/fixtures/container-sort-matrix.json").read_text()
)


@pytest.mark.parametrize("case", _MATRIX["cases"], ids=lambda c: c["name"])
def test_container_sort_parity(case):
    rows = [
        SimpleNamespace(
            id=r["id"],
            order=r.get("order", 0),
            created_date=r.get("created_date", ""),
        )
        for r in case["rows"]
    ]
    assert [r.id for r in sort_container(rows)] == case["expected"]
