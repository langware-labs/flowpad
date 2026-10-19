"""Cancelling a PTY turn must interrupt it, not destroy the session.

``cancel-prompt``'s PTY branch sent a bare Ctrl-C to every vendor. Measured on
opencode 1.18.16, a single ``\\x03`` mid-turn EXITS the TUI — the process dies
and prints its ``opencode -s <id>`` resume hint — so "cancel this turn" tore the
whole session down and left the process ``stopped``. Escape stops generation and
leaves the composer up (verified: output goes to zero, process stays alive).

The interrupt key is therefore a vendor trait, like ``pty_submits_on_paste``.
"""

from __future__ import annotations

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import get_driver

CTRL_C = b"\x03"
ESCAPE = b"\x1b"


def _interrupt_for(worker_type: str) -> bytes:
    driver = get_driver(worker_type)
    return getattr(driver, "pty_interrupt_sequence", CTRL_C)


def test_opencode_interrupts_with_escape_not_ctrl_c():
    assert _interrupt_for("opencode") == ESCAPE


@pytest.mark.parametrize("worker_type", ["claude", "codex", "copilot"])
def test_every_other_vendor_keeps_ctrl_c(worker_type):
    """The default is unchanged — this trait must not silently alter the others."""
    assert _interrupt_for(worker_type) == CTRL_C


def test_the_trait_is_read_through_a_default_so_a_vendor_may_omit_it():
    """A driver that never declares the attribute still cancels with Ctrl-C."""

    class BareDriver:
        pass

    assert getattr(BareDriver(), "pty_interrupt_sequence", CTRL_C) == CTRL_C


@pytest.mark.asyncio
async def test_cancel_sends_the_drivers_interrupt_not_a_hardcoded_ctrl_c(monkeypatch):
    """Pin the call site BEHAVIOURALLY: the bytes the PTY receives are the
    driver's, whatever they are.

    This used to assert on ``inspect.getsource``, which passes for any file that
    merely mentions the attribute and breaks on any edit to the method — it
    could not tell a real read from a comment. Driving the cancel and capturing
    what reaches the PTY cannot be fooled either way.
    """
    import uuid

    from flow_sdk.builtin.agentic_process import AgenticProcess

    SENTINEL = b"\x99-not-ctrl-c"

    class _SentinelDriver:
        name = "claude"
        pty_interrupt_sequence = SENTINEL

    ap = AgenticProcess(id=str(uuid.uuid4()), worker_type="claude_code")
    ap.pty_mode = True
    ap.shell_id = "shell-1"
    # `driver` is a cached_property — seed the cache rather than the row.
    ap.__dict__["driver"] = _SentinelDriver()

    sent: list[bytes] = []

    async def _capture(self, payload):
        sent.append(payload)

    # Patch on the class — the entity forbids setting unknown attributes.
    monkeypatch.setattr(AgenticProcess, "send", _capture, raising=False)

    result = await ap._http_cancel_prompt()

    assert sent == [SENTINEL], (
        "the PTY cancel branch stopped consulting the driver — a hardcoded "
        "Ctrl-C here kills an opencode session instead of interrupting its turn"
    )
    assert result.data["transport"] == "pty"
