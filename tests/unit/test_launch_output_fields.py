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
import textwrap

from flow_sdk.builtin.agentic_process.agentic_process import (
    _LAUNCH_OUTPUT_FIELDS,
    AgenticProcess,
)

#: Launch INPUTS: set on the fresh copy by ``start_pty`` before the launch and
#: consumed by the driver at spawn time, never read back off the caller's
#: object. Copying them back would be harmless but meaningless.
_LAUNCH_INPUTS = {"terminal_theme"}


def _self_assigned_fields(src: str) -> set[str]:
    """Every ``self.<name> = ...`` target in one method's source.

    Split from the caller so the detector itself is testable — see
    ``test_the_detector_actually_detects``. ``textwrap.dedent`` rather than
    stripping a hardcoded 4 spaces: the latter breaks the moment the method
    moves a level deeper.
    """
    tree = ast.parse(textwrap.dedent(src))
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


def _self_called_methods(src: str) -> set[str]:
    """PRIVATE ``self._name(...)`` helpers invoked directly in this body.

    Private only, and deliberately: a leading underscore is what separates a
    launch-internal helper from a general-purpose method that merely happens to
    be called during a launch. ``_record_worker_started_at`` and
    ``_adopt_shell_tab_order`` mint real launch state; ``get_project()`` lazily
    backfills ``workdir`` as a side effect for every caller everywhere, and
    ``save()`` re-enters the whole persistence chain. Copying those back would
    be wrong, not merely noisy — so the rule is a boundary, not an exclusion
    list that has to be maintained.
    """
    tree = ast.parse(textwrap.dedent(src))
    return {
        node.func.attr
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "self"
        and node.func.attr.startswith("_")
    }


def _fields_assigned_in_perform_open() -> set[str]:
    """Fields ``_perform_open`` mints, INCLUDING via the helpers it calls.

    Walking only ``_perform_open``'s own body is not enough: it DELEGATES some
    of its self-mutation (``_record_worker_started_at`` assigns
    ``self.context_data``), and a delegated write is exactly as invisible to the
    caller — and exactly as stale — as an inline one. Following one level of
    ``self.<helper>()`` calls is what makes this guard's claim true rather than
    merely plausible; the first version of it missed ``context_data`` for
    precisely this reason.
    """
    src = inspect.getsource(AgenticProcess._perform_open)
    found = _self_assigned_fields(src)
    for name in _self_called_methods(src):
        helper = getattr(AgenticProcess, name, None)
        if helper is None or not callable(helper):
            continue
        try:
            found |= _self_assigned_fields(inspect.getsource(helper))
        except (OSError, TypeError, SyntaxError):
            continue  # C-level or unavailable source — nothing to walk
    return found


def test_the_detector_actually_detects() -> None:
    """A guard that cannot fail is not a guard (same reasoning as
    ``test_mint_entity_id_call_sites.test_the_detectors_actually_detect``).

    ``_perform_open`` only plain-assigns today, so the augmented/annotated arms
    would be untested dead branches — but a guard that ignores ``self.x += 1``
    has precisely the silent blind spot it exists to close. Covered here
    instead of dropped, so they are live code rather than speculation.
    """
    probe = (
        "def m(self):\n"
        "    self.plain = 1\n"       # ast.Assign
        "    self.augmented += 1\n"  # ast.AugAssign
        "    self.annotated: int = 1\n"  # ast.AnnAssign
        "    self.a = self.b = 1\n"  # multiple targets
        "    other.ignored = 2\n"    # not self
        "    local = 3\n"            # not an attribute
    )
    assert _self_assigned_fields(probe) == {"plain", "augmented", "annotated", "a", "b"}


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
