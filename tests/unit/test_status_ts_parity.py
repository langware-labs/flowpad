"""Cross-language parity for the status record and the funding refusal codes.

`flow_sdk/schema/data_spec/status_spec.py` is the status record; `ts_sdk/src/entities/status-record.ts`
is its hand-written mirror. `LLMSourceRefusal` is declared in `llm_source_spec.py` and mirrored in
`ts_sdk/src/entities/llm-source.ts`.

Nothing generates one from the other, and TypeScript cannot catch the drift: the record arrives as
untyped JSON. A state only Python declares is a string no `STATUS_TEXT` row knows, so a harness row
renders blank; a field only Python sends is a fact the UI silently never shows; a refusal code only
Python sends is a device row whose "Sign in" button never appears.
"""
from __future__ import annotations

import re
from enum import StrEnum
from pathlib import Path

import pytest

from flow_sdk.schema.data_spec.llm_source_spec import LLMSourceRefusal
from flow_sdk.schema.data_spec.status_spec import (
    AccountSpec,
    HarnessStatusSpec,
    HubLogin,
    HubStatusSpec,
    InstallState,
    KeyStatusSpec,
    LoginState,
    StatusSpec,
)

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

_REPO = Path(__file__).resolve().parents[2]
_STATUS_TS = _REPO / "ts_sdk" / "src" / "entities" / "status-record.ts"
_SOURCE_TS = _REPO / "ts_sdk" / "src" / "entities" / "llm-source.ts"
_VALUE = re.compile(r"""=\s*['"]([^'"]+)['"]""")
_FIELD = re.compile(r"^\s*([a-z_]+)\??:", re.MULTILINE)


def _block(path: Path, header: str) -> str:
    match = re.search(rf"export {header}\s*\{{(.*?)\n\}}", path.read_text(encoding="utf-8"), re.DOTALL)
    if not match:
        pytest.fail(f"`export {header}` not found in {path}")
    return match.group(1)


def _ts_enum(path: Path, name: str) -> set[str]:
    return set(_VALUE.findall(_block(path, f"enum {name}")))


def _ts_fields(name: str) -> set[str]:
    return set(_FIELD.findall(_block(_STATUS_TS, f"interface {name}")))


@pytest.mark.parametrize(
    ("enum", "path"),
    [
        (InstallState, _STATUS_TS),
        (LoginState, _STATUS_TS),
        (HubLogin, _STATUS_TS),
        (LLMSourceRefusal, _SOURCE_TS),
    ],
    ids=lambda v: getattr(v, "__name__", ""),
)
def test_every_state_is_declared_on_both_sides(enum: type[StrEnum], path: Path):
    py, ts = {member.value for member in enum}, _ts_enum(path, enum.__name__)
    assert py == ts, f"{enum.__name__} drift: only in Python={sorted(py - ts)!r} only in TS={sorted(ts - py)!r}"


@pytest.mark.parametrize(
    ("spec", "interface"),
    [
        (StatusSpec, "StatusRecord"),
        (HarnessStatusSpec, "HarnessStatus"),
        (AccountSpec, "StatusAccount"),
        (KeyStatusSpec, "KeyStatus"),
        (HubStatusSpec, "HubStatus"),
    ],
    ids=lambda v: getattr(v, "__name__", v),
)
def test_every_field_is_declared_on_both_sides(spec, interface: str):
    py, ts = set(spec.model_fields), _ts_fields(interface)
    assert py == ts, f"{interface} drift: only in Python={sorted(py - ts)!r} only in TS={sorted(ts - py)!r}"
