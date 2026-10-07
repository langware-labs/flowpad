"""The TypeScript eval contract (``ts_sdk/src/evals/types.ts``) names the same fields as the kinds.

The Eval Browser reads runs through these types; a field added to ``EvalRun`` / ``ExampleEval`` in
Python and not in TypeScript would silently never show.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from flow_sdk.schema.data_spec.eval_spec import EvalRun, ExampleEval, Verdict

TYPES = (Path(__file__).resolve().parents[2] / "ts_sdk/src/evals/types.ts").read_text()


def _fields(interface: str) -> set[str]:
    body = re.search(rf"export interface {interface}\b[^{{]*\{{(.*?)\n\}}", TYPES, re.S).group(1)
    return set(re.findall(r"^\s+(\w+)\??:", body, re.M))


@pytest.mark.parametrize(("interface", "model"), [("ExampleEval", ExampleEval), ("EvalRun", EvalRun)])
def test_the_ts_interface_names_every_field(interface, model):
    assert _fields(interface) == set(model.model_fields)


def test_the_verdicts_agree():
    ts = set(re.search(r"export type Verdict = (.*?);", TYPES).group(1).replace("'", "").split(" | "))
    assert ts == {v.value for v in Verdict}
