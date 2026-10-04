"""A real, funded ``claude`` turn inside a hub test — one way, shared by every hub test that runs one.

Three things stand between a pytest process and a worker the LLM-source gate will fund, and each
used to fail SILENTLY (an unfunded spawn reads as "the agent said nothing", which the tests then
skipped as "no live CLI turn"):

1. **The CLI's own login lives under the real ``$HOME``.** The root conftest swaps HOME to a
   sandbox before flow_sdk imports, so a spawned ``claude`` finds no credentials. The subprocess
   needs the real HOME — but Flowpad's in-process state must NOT follow it: the session
   credentials (sodot) would be written under the real ``~/.flow`` (polluting it with
   ``test-*`` instances) and become unreadable the moment HOME is restored — after a
   pytest-timeout kill, before the test's ``finally`` releases its hub resources. So
   ``FLOW_HOME`` is pinned to the sandbox's flow home BEFORE HOME moves.
2. **The harness capability.** pytest never runs the server's discovery sweep, so the driver has
   no ``harness.claude.cli`` location; it is injected as the folder ON PATH (what a sweep
   records), not the symlink's versioned target.
3. **Stale login verdicts.** Anything that probed ``claude auth status`` under the sandbox HOME
   saved ``login_state=signed out`` in the session DB, and the gate honours verdicts. Forgotten on
   entry and exit, as ``tests/long_tests/conftest.py`` does — ``None`` is what a fresh box has.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

import pytest


@contextmanager
def real_home_for_the_cli() -> Iterator[None]:
    """The spawned CLI sees the real HOME; Flowpad's own state stays in the sandbox."""
    from flow_sdk.instances.paths import flow_home  # noqa: PLC0415

    real = os.environ.get("FLOWPAD_PRE_SANDBOX_HOME") or os.path.expanduser("~")
    saved = {k: os.environ.get(k) for k in ("HOME", "USERPROFILE", "FLOW_HOME")}
    os.environ["FLOW_HOME"] = str(flow_home())  # pinned BEFORE HOME moves — see module doc, (1)
    os.environ["HOME"] = real
    os.environ["USERPROFILE"] = real
    try:
        yield
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def inject_claude_harness() -> None:
    """Point the harness capability at the `claude` on PATH, or skip when there is none.

    Skips rather than fails when there is no CLI: an absent binary is this machine's state, not a
    defect in the feature under test — the same line `tests/long_tests` draws.
    """
    from flow_sdk.core.capabilities.discovery import get_capability_value, set_capability_value  # noqa: PLC0415
    from flow_sdk.core.capabilities.models import CapabilityKind, CapabilityValue  # noqa: PLC0415
    from flow_sdk.schema.data_spec import DataSpec  # noqa: PLC0415
    from tests.utils.claude_utils import find_claude  # noqa: PLC0415

    kind = CapabilityKind.CLAUDE_CLI.value
    if get_capability_value(kind) is not None:
        return
    binary = find_claude()
    if not binary:
        pytest.skip("no `claude` CLI on PATH — cannot run a real turn")
    set_capability_value(
        CapabilityValue(
            kind=kind,
            # The folder ON PATH, as a discovery sweep records it — not the symlink's target:
            # `claude` is a link into a versions dir whose file is named after the version
            # (`.../versions/2.1.288`), so that folder holds no `claude` at all and the
            # harness reads as "not installed".
            value={"path": str(Path(binary).parent), "ref_type": "folder"},
            value_spec=DataSpec.parse("fs_ref"),
        )
    )


async def forget_login_verdicts() -> None:
    """Drop every harness login verdict in the session DB — a fresh box's ``None``: nobody asked."""
    from flow_sdk.builtin.capability import Capability  # noqa: PLC0415

    for row in await Capability.get_all():
        if row.login_state is None and row.login_denied is None:
            continue
        row.login_state = row.login_message = row.login_denied = None
        row.login_identity = row.login_plan = None
        await row.save(notify=False)


async def fail_unless_a_turn_really_ran(no_process_reason: str) -> None:
    """Called when no reply came back: say WHY, so infrastructure never hides as a skip.

    * no agent process at all → OUR wiring never reached the agent: fail;
    * a process whose spawn was refused (``start_failure`` — e.g. the LLM-source gate's "has no
      usable LLM source") → the harness did not fund the worker: fail, with the gate's sentence;
    * a process that ran and said nothing → the CLI's own availability: skip.
    """
    from flow_sdk.builtin.agentic_process import AgenticProcess  # noqa: PLC0415
    from flow_sdk.fs_store.type_id import TypeId  # noqa: PLC0415

    # Composed from the delimiter the type owns, not the literal "conversation-".
    prefix = f"conversation{TypeId.TYPEID_DELIMITER}"
    turns = [
        p for p in await AgenticProcess.get_all({})
        if str(getattr(p, "target_typeid_str", "") or "").startswith(prefix)
    ]
    if not turns:
        pytest.fail(no_process_reason)
    refused = [str(p.start_failure) for p in turns if getattr(p, "start_failure", None)]
    if refused:
        pytest.fail(f"the agent's worker was refused at spawn — {refused[-1]}")
    pytest.skip("agent process ran but produced no reply (no live CLI turn available)")


@pytest.fixture
async def real_claude_turn():
    """Everything a hub test needs for a real, funded ``claude`` turn (see the module doc)."""
    with real_home_for_the_cli():
        inject_claude_harness()
        await forget_login_verdicts()
        try:
            yield
        finally:
            await forget_login_verdicts()
