"""Cross-language parity test for BODY_FILENAME.

The constant is the single source of truth for the body bundle filename on
the hub blob store. Python and TS each declare their own copy (no codegen).
If they drift the receiver-side download path 404s silently. This test
parses both source files with a regex and asserts they declare the same
literal.

# do not increase timeout without approval
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest


pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


_REPO_ROOT = Path(__file__).resolve().parents[2]
_PY_FILE = _REPO_ROOT / "flow_sdk" / "builtin" / "flow_message.py"
_TS_FILE = _REPO_ROOT / "ts_sdk" / "src" / "entities" / "flow-message.ts"

# Python:  BODY_FILENAME = "body.flowmsg"
_PY_RE = re.compile(r"""^BODY_FILENAME\s*=\s*['"]([^'"]+)['"]""", re.MULTILINE)
# TypeScript:  export const BODY_FILENAME = 'body.flowmsg';
_TS_RE = re.compile(r"""^export const BODY_FILENAME\s*=\s*['"]([^'"]+)['"]""", re.MULTILINE)


def _extract(path: Path, pattern: re.Pattern[str], lang: str) -> str:
    text = path.read_text(encoding="utf-8")
    match = pattern.search(text)
    if not match:
        pytest.fail(f"{lang} BODY_FILENAME declaration not found in {path}")
    return match.group(1)


def test_body_filename_python_value():
    """The Python literal must match the expected runtime value."""
    from flow_sdk.builtin.flow_message import BODY_FILENAME as PY_BODY_FILENAME

    assert _extract(_PY_FILE, _PY_RE, "Python") == PY_BODY_FILENAME == "body.flowmsg"


def test_body_filename_typescript_value():
    """The TS literal in source must match the Python runtime value."""
    from flow_sdk.builtin.flow_message import BODY_FILENAME as PY_BODY_FILENAME

    assert _extract(_TS_FILE, _TS_RE, "TypeScript") == PY_BODY_FILENAME


def test_python_and_typescript_agree():
    """Same string in both source files."""
    py_value = _extract(_PY_FILE, _PY_RE, "Python")
    ts_value = _extract(_TS_FILE, _TS_RE, "TypeScript")
    assert py_value == ts_value, (
        f"BODY_FILENAME drift: Python={py_value!r} TS={ts_value!r}. "
        f"Update both files so the parity contract holds."
    )
