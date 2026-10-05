"""Cross-language parity for the decision specs and the decision-API availability record.

`decision_spec.py` / `api_endpoint_spec.py` are mirrored by hand in `ts_sdk/src/decision/types.ts`;
`DecisionApiSpec` in `ts_sdk/src/services/llm-sources-service.ts`. Nothing generates one from the
other and TypeScript cannot catch the drift -- the values arrive as untyped JSON -- so a field only
Python sends is one the UI silently never reads.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from flow_sdk.external_apis.decision.errors import DecisionFailure
from flow_sdk.schema.data_spec.api_endpoint_spec import APIEndpointOffer
from flow_sdk.schema.data_spec.decision_spec import (
    ChoiceAnswer,
    ChoiceQuestion,
    DecisionResult,
    DecisionSpec,
    DecisionUsage,
    ScoreAnswer,
    ScoreQuestion,
    YesNoAnswer,
    YesNoQuestion,
)
from flow_sdk.schema.data_spec.llm_source_spec import DecisionApiSpec

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

_REPO = Path(__file__).resolve().parents[2]
_TYPES_TS = _REPO / "ts_sdk" / "src" / "decision" / "types.ts"
_FUNDING_TS = _REPO / "ts_sdk" / "src" / "services" / "llm-sources-service.ts"
_FIELD = re.compile(r"^\s*([a-z_]+)\??:", re.MULTILINE)


def _ts_fields(path: Path, name: str) -> set[str]:
    match = re.search(rf"export interface {name}\s*\{{(.*?)\n\}}", path.read_text(encoding="utf-8"), re.DOTALL)
    if not match:
        pytest.fail(f"`export interface {name}` not found in {path}")
    return set(_FIELD.findall(match.group(1)))


@pytest.mark.parametrize(
    ("spec", "path", "interface"),
    [
        (DecisionSpec, _TYPES_TS, "DecisionSpec"),
        (ChoiceQuestion, _TYPES_TS, "ChoiceQuestion"),
        (ScoreQuestion, _TYPES_TS, "ScoreQuestion"),
        (YesNoQuestion, _TYPES_TS, "YesNoQuestion"),
        (DecisionResult, _TYPES_TS, "DecisionResult"),
        (ChoiceAnswer, _TYPES_TS, "ChoiceAnswer"),
        (ScoreAnswer, _TYPES_TS, "ScoreAnswer"),
        (YesNoAnswer, _TYPES_TS, "YesNoAnswer"),
        (DecisionUsage, _TYPES_TS, "DecisionUsage"),
        (APIEndpointOffer, _TYPES_TS, "APIEndpointOffer"),
        (DecisionApiSpec, _FUNDING_TS, "DecisionApi"),
    ],
    ids=lambda v: getattr(v, "__name__", None) if isinstance(v, type) else None,
)
def test_every_field_is_declared_on_both_sides(spec, path: Path, interface: str):
    py, ts = set(spec.model_fields), _ts_fields(path, interface)
    assert py == ts, f"{interface} drift: only in Python={sorted(py - ts)!r} only in TS={sorted(ts - py)!r}"


def test_every_failure_reason_is_declared_on_both_sides():
    from typing import get_args

    block = re.search(r"export type DecisionFailure\s*=(.*?);", _TYPES_TS.read_text(encoding="utf-8"), re.DOTALL)
    ts = set(re.findall(r"'([a-z_]+)'", block.group(1))) if block else set()
    assert set(get_args(DecisionFailure)) == ts
