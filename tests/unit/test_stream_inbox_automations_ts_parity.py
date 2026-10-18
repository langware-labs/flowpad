"""Cross-language parity for what Phase B added and the TS SDK mirrors by hand.

`AutomationRun` / `AutomationSummary` (`automation_spec.py` ↔ `automation-types.ts`) and
`ReturnedValue` and its subclasses (`returned_value_spec.py` ↔ `models/ReturnedValue.ts`): every field Python
sends must be one TypeScript declares, or the UI silently never reads it.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from flow_sdk.schema.data_spec.automation_spec import AutomationRun, AutomationSummary
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode, ReturnedValue

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


@pytest.mark.parametrize("spec", [ReturnedValue, *ReturnedValue.__subclasses__()], ids=lambda spec: spec.__name__)
def test_flowcall_result_fields_and_kinds_are_mirrored(spec):
    path = _REPO / "ts_sdk/src/models/ReturnedValue.ts"
    own = set(spec.model_fields)
    if spec is not ReturnedValue:
        own -= set(ReturnedValue.model_fields)
        assert f"'{spec.spec_kind}'" in path.read_text(), spec.__name__
    declared = _ts_fields(path, spec.__name__)
    assert own <= declared, f"{spec.__name__}: TypeScript does not declare {sorted(own - declared)}"


def test_flowcall_exit_codes_are_mirrored():
    text = (_REPO / "ts_sdk/src/models/ReturnedValue.ts").read_text()
    body = re.search(r"export const ExitCode = \{(.*?)\}", text, re.DOTALL).group(1)
    declared = {name: int(value) for name, value in re.findall(r"(\w+): (\d+)", body)}
    assert declared == {code.name: int(code) for code in ExitCode}
