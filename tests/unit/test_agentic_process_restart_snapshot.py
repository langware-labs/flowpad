"""Regression tests for ``AgenticProcess._restart_snapshot`` stability.

The save-hook flips ``restart_required`` when the snapshot at hook-fire-time
differs from ``last_started_hash`` (captured at last successful ``start()``).
For the flag to behave correctly, the snapshot must be **stable** across every
construction / hydration path the entity goes through.

Original bug: the UI's "Start Claude" flow created an AgenticProcess via
``_scan_create_process`` (string ``worker_type``), then a downstream
``check_and_refresh_record`` chain re-hydrated the entity via
``Entity.from_record`` (enum-instance ``worker_type``). The save-hook computed
``str(WorkerType.CLAUDE_CODE)`` → ``"WorkerType.CLAUDE_CODE"`` (Python's
default ``Enum.__str__`` form) instead of the bare value ``"claude_code"`` —
two different snapshot inputs produced two different hashes for what was
otherwise the same entity, and ``restart_required`` flipped True ~700 ms after
a clean start. Fixed by normalizing enum-typed snapshot fields to ``.value``
inside ``_restart_snapshot``.
"""

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.flowpad_types.enums.worker_enums import WorkerType


def test_snapshot_stable_across_worker_type_forms():
    """The hash must NOT depend on whether ``worker_type`` arrived as a string
    or a ``WorkerType`` enum instance — both are valid representations of
    the same logical value (the enum's ``.value`` is the str)."""
    p_str = AgenticProcess(worker_type="claude_code")
    p_enum = AgenticProcess(worker_type=WorkerType.CLAUDE_CODE)

    # Both should hash to the same snapshot — different construction paths
    # in the codebase yield different in-memory representations.
    assert p_str._restart_snapshot() == p_enum._restart_snapshot()


def test_snapshot_does_not_use_enum_default_str():
    """Defensive: if ``str(WorkerType.CLAUDE_CODE)`` ever returns the prefixed
    form ``"WorkerType.CLAUDE_CODE"``, the snapshot helper must NOT include
    that form — it must normalize to the plain value ``"claude_code"``.

    This pins the contract so a future refactor of ``_restart_snapshot`` can't
    silently re-introduce the enum/string drift bug.
    """
    # Force the WorkerType field to the enum instance form on the entity.
    # We bypass pydantic coercion via ``object.__setattr__`` since pydantic
    # field validators in this codebase coerce enum input to plain str.
    p = AgenticProcess()
    object.__setattr__(p, "worker_type", WorkerType.CLAUDE_CODE)
    assert p.worker_type is WorkerType.CLAUDE_CODE

    # Sanity: confirm Python's default Enum.__str__ would corrupt the snapshot
    # if used directly.
    assert str(WorkerType.CLAUDE_CODE) == "WorkerType.CLAUDE_CODE"

    # The snapshot must equal the snapshot of the equivalent string form.
    p_str = AgenticProcess(worker_type="claude_code")
    assert p._restart_snapshot() == p_str._restart_snapshot()


@pytest.mark.parametrize(
    "form_a,form_b",
    [
        ("claude_code", WorkerType.CLAUDE_CODE),
        ("codex", WorkerType.CODEX),
        ("auto", WorkerType.AUTO),
        ("simple", WorkerType.SIMPLE),
    ],
)
def test_every_worker_type_member_is_snapshot_stable(form_a, form_b):
    """Cover every WorkerType member — any future addition that uses the
    default ``Enum.__str__`` form will fail this test."""
    p_str = AgenticProcess()
    object.__setattr__(p_str, "worker_type", form_a)
    p_enum = AgenticProcess()
    object.__setattr__(p_enum, "worker_type", form_b)
    assert p_str._restart_snapshot() == p_enum._restart_snapshot()
