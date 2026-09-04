"""Cross-language parity for the config-form field vocabulary.

`FieldType` decides what a manifest's config field renders as, and it is declared twice:
`flow_sdk/builtin/data_source_spec.py` validates a manifest against it at load, and
`ts_sdk/src/entities/data-source-spec.ts` is what the form switches on to draw the input.

Nothing generates one from the other, and TypeScript cannot catch the drift: the value
arrives over the wire as untyped JSON, so a member the frontend has never heard of is just
a string that falls through to the default branch and silently renders a text box. The
`data-source-spec.ts` comment claims a typo is "a compile error at the three comparison
sites" — true for a typo in OUR source, not for a member only one side declares.

The `SpecConfigField` flags are pinned for the same reason: `choices` reaching the form as
`undefined` because only Python declares it would turn every picker back into a text input,
with nothing anywhere reporting a problem.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

_REPO = Path(__file__).resolve().parents[2]
_PY_FILE = _REPO / "flow_sdk" / "builtin" / "data_source_spec.py"
_TS_FILE = _REPO / "ts_sdk" / "src" / "entities" / "data-source-spec.ts"

#: Python:  class FieldType(StrEnum): \n TEXT = "text" ...
_PY_ENUM = r"class FieldType\(StrEnum\):(.*?)(?=\n\nclass |\n\nclass\b|\Z)"
#: TypeScript:  export enum FieldType { TEXT = 'text', ... }
_TS_ENUM = r"export enum FieldType\s*\{(.*?)\}"
_VALUE = re.compile(r"""=\s*['"]([^'"]+)['"]""")


def _values(path: Path, pattern: str, lang: str) -> set[str]:
    match = re.search(pattern, path.read_text(encoding="utf-8"), re.DOTALL)
    if not match:
        pytest.fail(f"{lang} FieldType declaration not found in {path}")
    return set(_VALUE.findall(match.group(1)))


def test_python_and_typescript_declare_the_same_field_types():
    py, ts = _values(_PY_FILE, _PY_ENUM, "Python"), _values(_TS_FILE, _TS_ENUM, "TypeScript")
    assert py, "parsed no members for Python FieldType"
    assert py == ts, (
        f"FieldType drift: only in Python={sorted(py - ts)!r} only in TS={sorted(ts - py)!r}. "
        "A member only Python declares renders as a plain text input with nothing reporting it."
    )


def test_the_parsed_python_members_match_the_live_enum():
    """A regex that stopped matching would make the test above vacuously true."""
    from flow_sdk.builtin.data_source_spec import FieldType

    assert _values(_PY_FILE, _PY_ENUM, "Python") == {member.value for member in FieldType}


@pytest.mark.parametrize("flag", ["required", "advanced", "account_key", "choices"])
def test_every_config_field_flag_exists_on_both_sides(flag: str):
    """A flag the form never receives is a feature that silently does not exist."""
    from flow_sdk.builtin.data_source_spec import ConfigFieldSpec

    assert flag in ConfigFieldSpec.model_fields, f"{flag} is not a ConfigFieldSpec field"
    interface = re.search(
        r"export interface SpecConfigField\s*\{(.*?)\n\}", _TS_FILE.read_text(encoding="utf-8"), re.DOTALL
    )
    assert interface, "SpecConfigField declaration not found"
    assert re.search(rf"\b{flag}\?:", interface.group(1)), f"SpecConfigField is missing {flag}"
