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
from flow_sdk.builtin.agentic_process.cli_drivers.codex import CodexCliOptions
from flow_sdk.builtin.process_lifecycle import ProcessStatus
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


def test_codex_snapshot_treats_null_and_missing_optional_cli_keys_the_same():
    """Persisted cli_config may omit null fields present in CodexCliOptions JSON."""
    cli_config_with_nulls = CodexCliOptions(
        workdir=None,
        session_id=None,
        model=None,
    ).to_json()
    cli_config_missing_nulls = {
        key: value
        for key, value in cli_config_with_nulls.items()
        if value is not None
    }

    p_nulls = AgenticProcess(
        worker_type="codex",
        cli_config=cli_config_with_nulls,
        workdir="/repo",
        session_id="session-1",
    )
    p_missing = AgenticProcess(
        worker_type="codex",
        cli_config=cli_config_missing_nulls,
        workdir="/repo",
        session_id="session-1",
    )

    assert p_nulls._restart_snapshot() == p_missing._restart_snapshot()


def test_codex_snapshot_ignores_unrecognized_claude_cli_config_fields():
    base = AgenticProcess(worker_type="codex", cli_config={})
    claude_field = AgenticProcess(worker_type="codex", cli_config={"chrome": True})

    assert base._restart_snapshot() == claude_field._restart_snapshot()


def test_codex_snapshot_tracks_codex_worker_fields():
    base = AgenticProcess(worker_type="codex", cli_config={"model": "gpt-5.2"})
    changed = AgenticProcess(worker_type="codex", cli_config={"model": "gpt-5.3"})

    assert base._restart_snapshot() != changed._restart_snapshot()


@pytest.mark.parametrize("worker_type", ["claude_code", "codex"])
def test_toggling_flowpad_assistant_changes_restart_snapshot(worker_type):
    """Flipping ``load_flowpad_assistant`` must change the restart snapshot so
    the save-hook flips ``restart_required`` — the toggle's whole point.

    The Flowpad Assistant root is only reflected in ``resolved_add_dirs`` (not
    raw ``additional_dirs``), and the generic snapshot payload hashes the raw
    list. The signal therefore rides on the *worker* payload: both drivers set
    ``cmd.add_dirs = process.resolved_add_dirs`` in ``cli_options`` and include
    ``add_dirs`` in ``to_json``. This test pins that propagation so a future
    refactor can't silently sever the toggle → restart link (the "dir change
    doesn't propagate" failure mode).
    """
    on = AgenticProcess(worker_type=worker_type)
    off = AgenticProcess(worker_type=worker_type)
    on.load_flowpad_assistant = True
    off.load_flowpad_assistant = False

    assert on.assistant_enabled is True
    assert off.assistant_enabled is False
    # The assistant root lands in resolved_add_dirs only when enabled.
    assert on.resolved_add_dirs and not off.resolved_add_dirs
    # Generic payload alone is blind to it (hashes raw additional_dirs)…
    assert on._generic_restart_snapshot_payload(None) == off._generic_restart_snapshot_payload(None)
    # …but the full snapshot (incl. worker add_dirs) is not.
    assert on._restart_snapshot() != off._restart_snapshot()


def test_pty_mode_changes_codex_launch_shape_but_never_restart_hash():
    # The worker argv keys on the *transport intent* (``pty_mode``), NOT on tab
    # ``visible`` (commit 624ddb89): codex's interactive PTY shape differs from
    # its ``codex exec --json`` headless shape, so pty_mode flips the raw launch
    # PAYLOAD (ephemeral/json_stream). But the restart HASH must ignore those
    # transport-derived fields (QA R03): a PTY⇄CLI switch replaces the worker
    # itself, so it must never read as config drift / a phantom "restart
    # required" glow. Both comparators share TRANSPORT_DERIVED_WORKER_FIELDS.
    codex_headless = AgenticProcess(worker_type="codex", pty_mode=False)
    codex_pty = AgenticProcess(worker_type="codex", pty_mode=True)
    headless_worker = codex_headless._restart_snapshot_payload()["worker"]
    pty_worker = codex_pty._restart_snapshot_payload()["worker"]
    assert (headless_worker["ephemeral"], headless_worker["json_stream"]) != (
        pty_worker["ephemeral"],
        pty_worker["json_stream"],
    )
    assert codex_headless._restart_snapshot() == codex_pty._restart_snapshot()

    codex_hidden = AgenticProcess(worker_type="codex", visible=False)
    codex_visible = AgenticProcess(worker_type="codex", visible=True)
    assert codex_hidden._restart_snapshot() == codex_visible._restart_snapshot()

    claude_headless = AgenticProcess(worker_type="claude_code", pty_mode=False)
    claude_pty = AgenticProcess(worker_type="claude_code", pty_mode=True)
    assert claude_headless._restart_snapshot() == claude_pty._restart_snapshot()


@pytest.mark.asyncio
async def test_restart_required_flips_on_config_change_and_clears_on_revert():
    """The save-hook maintains ``restart_required`` symmetrically against the
    snapshot-hash contract: a worker-relevant config change while RUNNING flips it
    ON, and reverting that change back to the running worker's hash clears it.

    Fails pre-fix: the hook only flipped the flag ON — a change-then-undo left a
    phantom "restart needed" glow that only a real restart could clear.
    """
    p = AgenticProcess(
        worker_type="claude_code",
        status=ProcessStatus.RUNNING.value,
        workdir="/repo/original",
    )
    # Pin the baseline exactly as a successful start_pty() would.
    p.last_started_hash = p._restart_snapshot()
    await p.save()
    assert p.restart_required is False

    # A worker-relevant config change (workdir is in the generic snapshot) → drift → flag ON.
    p.workdir = "/repo/moved"
    await p.save()
    assert p.restart_required is True

    # Revert it → snapshot matches the running worker's hash again → flag clears.
    p.workdir = "/repo/original"
    await p.save()
    assert p.restart_required is False
