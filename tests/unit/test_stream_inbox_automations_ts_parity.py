"""Cross-language parity for what Phase B added and the TS SDK mirrors by hand.

`AutomationRun` / `AutomationSummary` (`automation_spec.py` ↔ `automation-types.ts`) and
`DecisionVerdict` (`returned_value_spec.py` ↔ `models/ReturnedValue.ts`): every field Python
sends must be one TypeScript declares, or the UI silently never reads it.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from flow_sdk.schema.data_spec.automation_spec import AutomationRun, AutomationSummary
from flow_sdk.schema.data_spec.returned_value_spec import DecisionVerdict, ReturnedValue

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

_REPO = Path(__file__).resolve().parents[2]
_FIELD = re.compile(r"^\s*([a-z_]+)\??:", re.MULTILINE)


def _ts_fields(path: Path, name: str) -> set[str]:
    text = path.read_text(encoding="utf-8")
    match = re.search(rf"export interface {name}\b[^{{]*\{{(.*?)\n\}}", text, re.DOTALL)
    if not match:
        pytest.fail(f"`export interface {name}` not found in {path}")
    return set(_FIELD.findall(match.group(1)))


@pytest.mark.parametrize(
    ("spec", "path", "interface"),
    [
        (AutomationRun, _REPO / "ts_sdk/src/entities/automation-types.ts", "AutomationRun"),
        (AutomationSummary, _REPO / "ts_sdk/src/entities/automation-types.ts", "AutomationSummary"),
    ],
)
def test_every_python_field_is_declared_in_typescript(spec, path, interface):
    missing = set(spec.model_fields) - _ts_fields(path, interface)
    assert not missing, f"{interface}: TypeScript does not declare {sorted(missing)}"


def test_decision_verdict_fields_are_mirrored():
    own = set(DecisionVerdict.model_fields) - set(ReturnedValue.model_fields)
    declared = _ts_fields(_REPO / "ts_sdk/src/models/ReturnedValue.ts", "DecisionVerdict")
    assert own <= declared, f"DecisionVerdict: TypeScript does not declare {sorted(own - declared)}"
