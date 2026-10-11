"""The TypeScript diagnosis contract (``ts_sdk/src/diagnose/types.ts``) names the same fields as the kinds."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from flow_sdk.diagnose import (
    DiagnosePurpose,
    DiagnosisEnvironment,
    DiagnosisFinding,
    DiagnosisSpec,
    DiagnosisStatus,
    FlowContextSpec,
    LogTail,
)

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval

TYPES = (Path(__file__).resolve().parents[3] / "ts_sdk/src/diagnose/types.ts").read_text()


def _fields(interface: str) -> set[str]:
    body = re.search(rf"export interface {interface}\b[^{{]*\{{(.*?)\n\}}", TYPES, re.S).group(1)
    return set(re.findall(r"^\s+(\w+)\??:", body, re.M))


def _union(name: str) -> set[str]:
    return set(re.search(rf"export type {name} = (.*?);", TYPES).group(1).replace("'", "").split(" | "))


@pytest.mark.parametrize(
    "model", [DiagnosisSpec, FlowContextSpec, DiagnosisFinding, DiagnosisEnvironment, LogTail], ids=lambda m: m.__name__
)
def test_the_ts_interface_names_every_field(model):
    assert _fields(model.__name__) == set(model.model_fields)


def test_the_enums_agree():
    assert _union("DiagnosisStatus") == {s.value for s in DiagnosisStatus}
    assert _union("DiagnosePurpose") == {p.value for p in DiagnosePurpose}
