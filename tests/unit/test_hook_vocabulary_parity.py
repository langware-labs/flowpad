"""The Python and TypeScript hook vocabularies must not drift apart.

TS is a thin client over the Python actions, so every hook event and scope it
can name has to mean the same thing on both sides. Nothing enforced that before:
the two enums were maintained by hand, in two files, and a value added to one
would simply be missing from the other until someone hit it at runtime.

Parsing the ``.ts`` source is deliberate — generating one from the other would
be nicer, but this catches the drift today without a build step.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from flow_sdk.builtin.hooks.types import HookEventType, HookScope

TS_ROOT = Path(__file__).resolve().parents[2] / "ts_sdk" / "src"
TS_EVENTS = TS_ROOT / "claude_hook_events" / "event-types.ts"
TS_SCOPES = TS_ROOT / "entities" / "agent-hook-enums.ts"


def _enum_values(source: str, enum_name: str) -> set[str]:
    """Values of ``export enum <name> { A = 'a', ... }``."""
    match = re.search(rf"export enum {enum_name}\s*{{(.*?)}}", source, re.S)
    assert match, f"{enum_name} not found — did the file move?"
    return set(re.findall(r"=\s*'([^']+)'", match.group(1)))


@pytest.fixture(scope="module")
def ts_event_values() -> set[str]:
    return _enum_values(TS_EVENTS.read_text(), "HookEventType")


@pytest.fixture(scope="module")
def ts_scope_values() -> set[str]:
    return _enum_values(TS_SCOPES.read_text(), "HookScope")


def test_event_vocabularies_match_exactly(ts_event_values: set[str]):
    python_values = {e.value for e in HookEventType}
    assert ts_event_values == python_values, (
        "hook event enums drifted — "
        f"python-only={sorted(python_values - ts_event_values)}, "
        f"ts-only={sorted(ts_event_values - python_values)}"
    )


def test_scope_vocabularies_match_exactly(ts_scope_values: set[str]):
    python_values = {s.value for s in HookScope}
    assert ts_scope_values == python_values, (
        "hook scope enums drifted — "
        f"python-only={sorted(python_values - ts_scope_values)}, "
        f"ts-only={sorted(ts_scope_values - python_values)}"
    )


def test_process_scope_exists_on_both_sides(ts_scope_values: set[str]):
    """The scope the consolidation added — the one most likely to be half-wired."""
    assert HookScope.PROCESS.value == "process"
    assert "process" in ts_scope_values


def test_there_is_exactly_one_python_definition_of_each_enum():
    """``agent_hook`` re-exports; it must not redefine.

    The enums lived in ``agent_hook.py`` and were duplicated in TS. Keeping a
    second Python definition would give three sources of truth.
    """
    agent_hook = (
        Path(__file__).resolve().parents[2] / "flow_sdk" / "builtin" / "agent_hook.py"
    ).read_text()
    assert "class HookEventType" not in agent_hook
    assert "class HookScope" not in agent_hook

    from flow_sdk.builtin.agent_hook import HookEventType as ReExported

    assert ReExported is HookEventType
