"""A result read back from disk is the result that was written.

`run.json` stores a WizardResult; `run-detail` serves it back. Nested answers
already came back as their own classes (`Tagged`, by `spec_kind`), but a
DataSpec `value` — an op's declared output — came back a plain dict, so "an
instance of output_spec_kind" held only until the first save.
"""
from __future__ import annotations

from typing import ClassVar

import pytest

from flow_sdk.schema.data_spec.returned_value_spec import CliResult, OUTPUT_CAP, WizardResult
from flow_sdk.schema.data_spec.spec import DataSpec

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


class Port(DataSpec):
    spec_kind: ClassVar[str] = "test.round_trip.port"
    port: int


def _back(answer):
    return type(answer).model_validate(answer.model_dump(mode="json"))


def test_a_dataspec_value_comes_back_as_its_class():
    written = WizardResult.satisfied("", steps={"a": CliResult.satisfied("", value=Port(port=8080))})
    read = _back(written)
    assert type(read.steps["a"].value) is Port and read.steps["a"].value.port == 8080


def test_plain_values_are_untouched():
    assert _back(CliResult.satisfied("", value=5)).value == 5
    assert _back(CliResult.satisfied("", value={"read": 1})).value == {"read": 1}
    assert _back(CliResult.satisfied("", value=["a", "b"])).value == ["a", "b"]


def test_an_unknown_kind_stays_a_dict_rather_than_failing_the_read():
    """One unreadable value must not make the whole run.json unreadable."""
    raw = {"exit_code": 0, "value": {"spec_kind": "nobody.registered.this", "x": 1}}
    assert CliResult.model_validate(raw).value == {"spec_kind": "nobody.registered.this", "x": 1}


def test_output_is_whole_when_read_and_trimmed_only_when_persisted():
    """D-3: a caller that PARSES output gets all of it; `trimmed()` is for disk
    and for a person — and it reaches into the check and every nested step."""
    big = "A" * (OUTPUT_CAP * 2) + "END"
    step = CliResult.of_process("x", 0, big, "", check=CliResult.of_process("c", 0, big, ""))
    assert step.stdout == big, "read whole"

    kept = WizardResult.satisfied("", steps={"s": step}).trimmed()
    assert len(kept.steps["s"].stdout) == OUTPUT_CAP and kept.steps["s"].stdout.endswith("END")
    assert len(kept.steps["s"].check.stdout) == OUTPUT_CAP, "the check's output too"
