"""Cross-language parity test for the guided-step vocabulary.

A journey's ``graph.json`` is validated on the Python side
(``GraphWorkflowDoc.problems``) and, for a code-built journey that never makes
that round trip, on the TS side (``JourneyGraph.problems``). Each declares its
own copy of the legal ``present.dock.kind`` and ``act.kind`` sets — no codegen.

If they drift, the two validators disagree about what a valid journey is: a
step the backend accepts renders as an authoring error in the frontend, or a
kind the frontend accepts is rejected on load. This test parses both source
files with a regex and asserts they declare the same members.

# do not increase timeout without approval
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest


pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


_REPO_ROOT = Path(__file__).resolve().parents[2]
_PY_FILE = _REPO_ROOT / "flow_sdk" / "graph_workflow_manager" / "graph_workflow_doc.py"
_TS_STEP_FILE = _REPO_ROOT / "ts_sdk" / "src" / "entities" / "journey" / "journey-step.ts"
_TS_WAIT_FILE = _REPO_ROOT / "ts_sdk" / "src" / "entities" / "journey" / "journey-wait.ts"


def _ts_file(name: str) -> Path:
    """Wait kinds live with the wait model, the others with the step model."""
    return _TS_WAIT_FILE if name == "GUIDED_WAIT_KINDS" else _TS_STEP_FILE

# Python:  GUIDED_PRESENT_KINDS = {"asset_editor", "wiki", ...}
_PY_RE = r"^{name}\s*=\s*\{{(.*?)\}}"
# TypeScript:  export const GUIDED_PRESENT_KINDS: ReadonlySet<string> = new Set([...])
_TS_RE = r"^export const {name}[^=]*=\s*new Set(?:<[^>]*>)?\(\s*\[(.*?)\]"

_MEMBER_RE = re.compile(r"""['"]([^'"]+)['"]""")


def _members(path: Path, pattern: str, name: str, lang: str) -> set[str]:
    text = path.read_text(encoding="utf-8")
    match = re.search(pattern.format(name=name), text, re.MULTILINE | re.DOTALL)
    if not match:
        pytest.fail(f"{lang} {name} declaration not found in {path}")
    return set(_MEMBER_RE.findall(match.group(1)))


@pytest.mark.parametrize("name", ["GUIDED_PRESENT_KINDS", "GUIDED_ACT_KINDS", "GUIDED_WAIT_KINDS"])
def test_python_and_typescript_agree(name: str):
    """The same vocabulary in both source files."""
    py_members = _members(_PY_FILE, _PY_RE, name, "Python")
    ts_members = _members(_ts_file(name), _TS_RE, name, "TypeScript")
    assert py_members, f"parsed no members for Python {name}"
    assert py_members == ts_members, (
        f"{name} drift: only in Python={sorted(py_members - ts_members)!r} "
        f"only in TS={sorted(ts_members - py_members)!r}. "
        f"Update both files so the parity contract holds."
    )


def test_python_members_match_runtime():
    """The parsed Python literals must match what the module actually exports."""
    from flow_sdk.graph_workflow_manager.graph_workflow_doc import (
        GUIDED_ACT_KINDS,
        GUIDED_PRESENT_KINDS,
        GUIDED_WAIT_KINDS,
    )

    assert _members(_PY_FILE, _PY_RE, "GUIDED_PRESENT_KINDS", "Python") == GUIDED_PRESENT_KINDS
    assert _members(_PY_FILE, _PY_RE, "GUIDED_ACT_KINDS", "Python") == GUIDED_ACT_KINDS
    assert _members(_PY_FILE, _PY_RE, "GUIDED_WAIT_KINDS", "Python") == GUIDED_WAIT_KINDS


def test_shipped_journeys_use_waitFor():
    """The three shipped journeys carry the current spelling — there is no
    compatibility path, so an unconverted `await` is a broken journey."""
    import json

    base = _REPO_ROOT / "flow_sdk" / "system_projects" / "flowpad_assistant" / "agentic-assets" / "journey"
    seen = 0
    for graph in sorted(base.glob("*/graph.json")):
        doc = json.loads(graph.read_text(encoding="utf-8"))
        for node in doc.get("nodes", []):
            if node.get("node_type") != "guided_step":
                continue
            data = node.get("node_data") or {}
            assert "await" not in data, f"{graph.parent.name}:{node['id']} still uses the retired `await`"
            assert data.get("waitFor"), f"{graph.parent.name}:{node['id']} has no waitFor"
            seen += 1
    assert seen >= 15, f"expected the shipped guided steps, found {seen}"


def test_typescript_act_kinds_match_the_union_type():
    """The TS runtime Set and the `JourneyActKind` union must not drift either —
    they are two declarations of the same vocabulary in one file."""
    text = _TS_STEP_FILE.read_text(encoding="utf-8")
    union = re.search(r"export type JourneyActKind\s*=(.*?);", text, re.DOTALL)
    assert union, "JourneyActKind union not found"
    union_members = set(_MEMBER_RE.findall(union.group(1)))
    set_members = _members(_TS_STEP_FILE, _TS_RE, "GUIDED_ACT_KINDS", "TypeScript")
    assert union_members == set_members, (
        f"JourneyActKind union vs GUIDED_ACT_KINDS drift: "
        f"only in union={sorted(union_members - set_members)!r} "
        f"only in set={sorted(set_members - union_members)!r}"
    )
