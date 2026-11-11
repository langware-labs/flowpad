"""``<kind>.id.<uuid>`` parses the same here as in the browser: one shared table
(``test_fixtures/value_ref_cases.json``), which ``ui/tests/unit/value-ref-cases.test.ts`` runs too."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.schema.data_spec.value_ref import parse_ref, ref_of

FIXTURE = json.loads((Path(__file__).parents[3] / "test_fixtures/value_ref_cases.json").read_text())


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda c: c["text"] or "<empty>")
def test_a_reference_parses_as_the_table_says(case):
    want = case["ref"]
    assert parse_ref(case["text"]) == ((want["kind"], want["id"]) if want else None)
    if want:
        assert ref_of(want["kind"], want["id"]) == case["text"]
