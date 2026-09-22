"""A provisional session id is minted only for vendors that accept one.

``_perform_open`` stamped ``session_id = session_id or str(uuid4())`` on EVERY
vendor. Codex and opencode mint their own ids (``rollout-…`` / ``ses_…``) and
reject a foreign one, so those two carried a phantom uuid that no vendor store
had ever heard of — every lookup keyed on it missed until the real id was
adopted. ``prompt()`` already honoured the trait; only the open path did not.

The trait is declared (True) by the vendors that CAN be handed an id at launch,
and omitted by those that cannot — so it must always be read defensively.
"""

from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import get_driver


def _preassigns(worker_type: str) -> bool:
    return bool(getattr(get_driver(worker_type), "preassign_interactive_session_id", False))


@pytest.mark.parametrize("worker_type", ["claude", "copilot", "deepagents"])
def test_vendors_that_accept_a_launch_id_preassign(worker_type):
    assert _preassigns(worker_type) is True


@pytest.mark.parametrize("worker_type", ["codex", "opencode"])
def test_vendors_that_mint_their_own_id_do_not(worker_type):
    """These reject a caller-minted id, so a provisional uuid is a phantom."""
    assert _preassigns(worker_type) is False


@pytest.mark.parametrize("worker_type", ["claude", "codex", "copilot", "opencode", "deepagents"])
def test_the_trait_is_always_readable(worker_type):
    """Two drivers omit the attribute entirely — a bare access would raise."""
    getattr(get_driver(worker_type), "preassign_interactive_session_id", False)


@pytest.mark.parametrize(
    ("worker_type", "expected"),
    [("claude_code", True), ("copilot", True), ("codex", False), ("opencode", False)],
)
def test_the_gate_itself_decides_per_vendor(worker_type, expected):
    """Drive the real gate, not the text of its callers.

    Both the open path and the prompt path route through
    ``_should_preassign_session_id``. This replaces three
    ``inspect.getsource`` assertions: the policy now lives in exactly ONE
    expression, so the drift those tests watched for is structurally
    impossible, and what remains worth testing is the decision itself.
    """
    from flow_sdk.builtin.agentic_process import AgenticProcess

    ap = AgenticProcess(id=str(uuid.uuid4()), worker_type=worker_type)
    assert ap._should_preassign_session_id() is expected


def test_an_existing_session_id_is_never_replaced():
    """The gate is "mint if absent" — re-stamping would orphan the live session."""
    from flow_sdk.builtin.agentic_process import AgenticProcess

    ap = AgenticProcess(id=str(uuid.uuid4()), worker_type="claude_code")
    ap.session_id = "already-here"
    assert ap._should_preassign_session_id() is False


def test_a_driver_that_omits_the_trait_does_not_preassign():
    """Codex and opencode omit the attribute entirely — a bare read would raise."""
    from flow_sdk.builtin.agentic_process import AgenticProcess

    class BareDriver:
        name = "bare"

    ap = AgenticProcess(id=str(uuid.uuid4()), worker_type="claude_code")
    ap.__dict__["driver"] = BareDriver()
    assert ap._should_preassign_session_id() is False
