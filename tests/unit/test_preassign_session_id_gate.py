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

import inspect

import pytest

from flow_sdk.builtin.agentic_process import agentic_process
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import get_driver


def _preassigns(worker_type: str) -> bool:
    return bool(getattr(get_driver(worker_type), "preassign_interactive_session_id", False))


@pytest.mark.parametrize("worker_type", ["claude", "copilot"])
def test_vendors_that_accept_a_launch_id_preassign(worker_type):
    assert _preassigns(worker_type) is True


@pytest.mark.parametrize("worker_type", ["codex", "opencode"])
def test_vendors_that_mint_their_own_id_do_not(worker_type):
    """These reject a caller-minted id, so a provisional uuid is a phantom."""
    assert _preassigns(worker_type) is False


@pytest.mark.parametrize("worker_type", ["claude", "codex", "copilot", "opencode"])
def test_the_trait_is_always_readable(worker_type):
    """Two drivers omit the attribute entirely — a bare access would raise."""
    getattr(get_driver(worker_type), "preassign_interactive_session_id", False)


def test_open_path_consults_the_trait():
    source = inspect.getsource(agentic_process.AgenticProcess._perform_open)
    assert "preassign_interactive_session_id" in source, (
        "the open path stamps a uuid unconditionally again — that hands codex "
        "and opencode a session id their own store will never match"
    )
    assert "self.session_id = self.session_id or str(uuid4())" not in source


def test_open_path_reads_the_trait_defensively():
    """A bare attribute access would raise for codex/opencode."""
    source = inspect.getsource(agentic_process.AgenticProcess._perform_open)
    assert 'getattr(self.driver, "preassign_interactive_session_id", False)' in source


def test_prompt_path_still_honours_it():
    """The two paths must not drift apart again."""
    source = inspect.getsource(agentic_process.AgenticProcess._http_prompt)
    assert "preassign_interactive_session_id" in source
