"""A hidden vendor (``Vendor.hidden``) is a worker like any other that no picker ever offers.

Hidden is a FACT generic machinery asks — these pin every place that asks it, and that the
vendor stays fully spawnable by ``worker_type`` regardless.
"""

from __future__ import annotations

import inspect
import re
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    get_driver,
    no_worker_message,
)
from flow_sdk.core.capabilities import discovery as discovery_mod
from flow_sdk.core.capabilities import harness_state
from flow_sdk.flowpad_types.vendors import VENDORS

REPO = Path(__file__).resolve().parents[2]
HIDDEN = [v for v in VENDORS if v.hidden]
OFFERED = [v for v in VENDORS if not v.hidden]


def test_there_is_a_hidden_vendor_to_pin():
    assert HIDDEN, "no hidden vendor — this file would silently assert nothing"


async def test_the_harness_picker_never_lists_a_hidden_vendor(monkeypatch):
    """``compute_harness_state`` is the bootstrap payload's harness list — what the picker shows."""

    async def _no_sweep() -> bool:
        return True

    monkeypatch.setattr(harness_state, "ensure_discovered", _no_sweep)
    state = await harness_state.compute_harness_state()
    kinds = {h["kind"] for h in state["harnesses"]}

    assert kinds == {v.capability_kind for v in OFFERED}
    for vendor in HIDDEN:
        assert vendor.capability_kind not in kinds


async def test_the_capabilities_window_never_lists_a_hidden_vendor():
    """The window renders the summary's ``capabilities`` — so that is where hidden is enforced.
    The capability ROW must still exist: funding and the install gate are keyed on it."""
    from flow_sdk.core.capabilities.registry import get_capability_registry
    from flow_sdk.core.capabilities.summary import compute_capabilities_summary

    summary = await compute_capabilities_summary(wait_for_discovery=False)
    listed = {access.kind for access in summary.capabilities}
    for vendor in HIDDEN:
        assert vendor.capability_kind not in listed
        assert vendor.capability_kind in get_capability_registry().kinds(), "hidden is not unregistered"
    for vendor in OFFERED:
        assert vendor.capability_kind in listed


def test_a_spawn_error_never_tells_a_person_to_install_a_hidden_vendor(monkeypatch, tmp_path):
    discovery_mod._VALUES.clear()
    monkeypatch.setenv("PATH", str(tmp_path))  # nothing on PATH; the hidden package may well be installed
    message = no_worker_message("codex")

    for vendor in HIDDEN:
        assert vendor.key not in message, message
    for vendor in OFFERED:
        assert vendor.key in message, "say which harnesses were looked for"


@pytest.mark.parametrize("vendor", HIDDEN, ids=[v.key for v in HIDDEN])
def test_hidden_is_not_disabled(vendor):
    """Still a real vendor: it resolves to a driver and an options class by ``worker_type``."""
    from flow_sdk.builtin.agentic_process.cli_drivers import factory

    assert get_driver(vendor.worker_type).name == vendor.key
    assert factory({}, vendor.worker_type).WORKER_TYPE == vendor.worker_type


def test_the_frontend_picker_lists_do_not_name_a_hidden_vendor():
    """The TS lists are hand-written, so hidden means "never added". Reading the source is the
    only py↔ts link there is — and it keeps a well-meant "add the fifth vendor" edit honest."""
    sources = {
        "ui/src/components/workers/worker-types.ts": r"LAUNCHABLE_WORKERS[^;]*;",
        "ts_sdk/src/capabilities/index.ts": r"HARNESS_CAPABILITY_KINDS[^;]*;",
        "ui/src/components/terminal/openers/tab_opener_types.ts": r"VALID_OPENER_IDS[^;]*;",
    }
    for relative, pattern in sources.items():
        text = (REPO / relative).read_text(encoding="utf-8")
        match = re.search(pattern, text, re.DOTALL)
        assert match, f"{relative}: the picker list moved — update this guard"
        for vendor in HIDDEN:
            assert vendor.key not in match.group(0), f"{relative} offers the hidden vendor {vendor.key!r}"


def test_the_filters_ask_the_fact_not_a_key():
    """No ``== "deepagents"`` in generic machinery: a second hidden vendor must need no edit."""
    from flow_sdk.core.capabilities.summary import compute_capabilities_summary

    for fn in (harness_state.compute_harness_state, no_worker_message, compute_capabilities_summary):
        source = inspect.getsource(fn)
        assert ".hidden" in source or "HIDDEN_CAPABILITY_KINDS" in source
        for vendor in HIDDEN:
            assert f'"{vendor.key}"' not in source and f"'{vendor.key}'" not in source


# ── headless-only (``Vendor.interactive`` False) ─────────────────────────────


def test_the_stored_transport_intent_is_honest_for_a_headless_only_vendor(monkeypatch):
    """``pty_mode`` is the INTENT, defaults to interactive, and is what every router and client
    routes on (the TS SDK reads the persisted value). So it is the ROW that has to say "headless"
    — for a named vendor and for an unset ``worker_type`` following a headless-only default
    alike — or a caller that never thought about transports asks for a terminal that cannot
    exist and its turn never starts. (Found by the real-LLM markdown_index test, which creates
    its process without ``pty_mode=False``.) An interactive vendor keeps the default."""
    from flow_sdk.builtin.agentic_process import AgenticProcess

    for vendor in VENDORS:
        assert AgenticProcess(name="t", worker_type=vendor.worker_type).pty_mode is vendor.interactive, vendor.key

    headless_only = next(v for v in VENDORS if not v.interactive)
    monkeypatch.setenv("FLOWPAD_DEFAULT_WORKER", headless_only.key)
    assert AgenticProcess(name="t").pty_mode is False
    monkeypatch.setenv("FLOWPAD_DEFAULT_WORKER", "claude")
    assert AgenticProcess(name="t").pty_mode is True


async def test_opening_a_terminal_on_a_headless_only_vendor_is_refused_before_anything_changes():
    """The one later writer of ``pty_mode=True`` is the open path, and it refuses — so the stored
    intent above cannot be flipped back."""
    from flow_sdk.builtin.agentic_process import AgenticProcess

    headless_only = next(v for v in VENDORS if not v.interactive)
    process = AgenticProcess(name="t", worker_type=headless_only.worker_type, workdir="/tmp")
    response = await process._perform_open(None, True)

    assert getattr(response, "status", None) == "FAIL" and "headless worker" in str(response.message)
    assert process.pty_mode is False and not process.visible
