"""``_LAUNCH_OUTPUT_FIELDS`` must mirror what ``_perform_open`` actually mints.

``start_pty`` runs the launch on a DB-fresh copy of the entity and copies the
launch's output fields back onto the caller's object. That list is hand-written,
so it can drift from ``_perform_open`` — and a missed field is invisible: the
caller simply keeps a stale value, exactly the bug the copy-back exists to fix.
It has drifted once already (the ``last_started_*``/``restart_required``
triplet), so the list is pinned here against the source of truth rather than
against a second hand-written list.
"""
from __future__ import annotations

import ast
import inspect
import re

from flow_sdk.builtin.agentic_process.agentic_process import (
    _LAUNCH_OUTPUT_FIELDS,
    AgenticProcess,
)

#: Launch INPUTS: set on the fresh copy by ``start_pty`` before the launch and
#: consumed by the driver at spawn time, never read back off the caller's
#: object. Copying them back would be harmless but meaningless.
_LAUNCH_INPUTS = {"terminal_theme"}


def _fields_assigned_in_perform_open() -> set[str]:
    """Every ``self.<name> = ...`` target in ``_perform_open``'s own body."""
    src = inspect.getsource(AgenticProcess._perform_open)
    # dedent so ast can parse the method standalone
    src = re.sub(r"^ {4}", "", src, flags=re.MULTILINE)
    tree = ast.parse(src)
    found: set[str] = set()
    for node in ast.walk(tree):
        targets = []
        if isinstance(node, ast.Assign):
            targets = node.targets
        elif isinstance(node, (ast.AugAssign, ast.AnnAssign)):
            targets = [node.target]
        for t in targets:
            if (
                isinstance(t, ast.Attribute)
                and isinstance(t.value, ast.Name)
                and t.value.id == "self"
            ):
                found.add(t.attr)
    return found


def test_launch_output_fields_covers_every_field_perform_open_mints() -> None:
    assigned = _fields_assigned_in_perform_open()
    assert assigned, "could not parse _perform_open — the guard would silently pass"
    missing = assigned - set(_LAUNCH_OUTPUT_FIELDS) - _LAUNCH_INPUTS
    assert not missing, (
        f"_perform_open assigns {sorted(missing)}, which _LAUNCH_OUTPUT_FIELDS does not "
        f"copy back onto the caller. Add them (or, if a field is a launch INPUT the "
        f"caller never reads back, add it to _LAUNCH_INPUTS with a reason)."
    )


def test_launch_output_fields_are_real_model_fields() -> None:
    """A typo'd name would make the copy-back raise AttributeError at launch."""
    unknown = [f for f in _LAUNCH_OUTPUT_FIELDS if f not in AgenticProcess.model_fields]
    assert not unknown, f"not AgenticProcess fields: {unknown}"
