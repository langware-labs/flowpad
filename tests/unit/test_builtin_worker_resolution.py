"""Which worker a BUILTIN process runs on (a capability install, a wizard step).

The rule (``resolve_builtin_worker_type``): the user's selected harness whenever it is actually
installed — it is their tool and their login funds it — and the ``Vendor.bootstrap`` worker only
when it is not. That second half is the fresh-install case: a box with no harness CLI at all can
still run the process that installs one.
"""

from __future__ import annotations

import inspect

import pytest

from flow_sdk.core.capabilities import registry as registry_mod
from flow_sdk.core.wizard import process_step
from flow_sdk.flowpad_types.vendors import VENDORS

BOOTSTRAP = next(v for v in VENDORS if v.bootstrap)


def _installed(monkeypatch, *keys: str) -> None:
    """Make exactly *keys* look installed to the one install gate everything reads."""
    from flow_sdk.builtin.agentic_process.cli_drivers import cli_worker_base_driver as base
    from flow_sdk.flowpad_types.vendors import vendor_for

    wanted = {vendor_for(k).key for k in keys}
    monkeypatch.setattr(base, "worker_bin_folder", lambda worker: "/bin" if vendor_for(worker).key in wanted else None)


def _selected(monkeypatch, worker_type: str | None) -> None:
    async def _resolve() -> str:
        if worker_type is None:
            raise RuntimeError("Default harness does not reference a concrete capability")
        return worker_type

    monkeypatch.setattr(registry_mod, "resolve_default_worker_type", _resolve)


async def test_the_selected_harness_wins_when_it_is_installed(monkeypatch):
    """Even with the bootstrap worker available: it is a last resort, not a preference."""
    _selected(monkeypatch, "claude_code")
    _installed(monkeypatch, "claude", BOOTSTRAP.key)
    assert await registry_mod.resolve_builtin_worker_type() == "claude_code"


async def test_a_missing_selected_harness_falls_back_to_the_bootstrap_worker(monkeypatch):
    """The fresh install: claude is selected (the seed default) but nothing is installed."""
    _selected(monkeypatch, "claude_code")
    _installed(monkeypatch, BOOTSTRAP.key)
    assert await registry_mod.resolve_builtin_worker_type() == BOOTSTRAP.worker_type


async def test_no_selection_at_all_falls_back_too(monkeypatch):
    _selected(monkeypatch, None)
    _installed(monkeypatch, BOOTSTRAP.key)
    assert await registry_mod.resolve_builtin_worker_type() == BOOTSTRAP.worker_type


async def test_with_neither_the_selected_worker_is_named_so_the_launch_can_say_so(monkeypatch):
    """Nothing is masked: the launch path reports "claude is not installed" by name."""
    _selected(monkeypatch, "claude_code")
    _installed(monkeypatch)
    assert await registry_mod.resolve_builtin_worker_type() == "claude_code"


async def test_with_neither_and_no_selection_the_original_error_surfaces(monkeypatch):
    _selected(monkeypatch, None)
    _installed(monkeypatch)
    with pytest.raises(RuntimeError, match="Default harness"):
        await registry_mod.resolve_builtin_worker_type()


def test_both_builtin_paths_use_the_one_rule():
    """The wizard step and the capability install must not drift apart."""
    assert "resolve_builtin_worker_type" in inspect.getsource(process_step)
    # The install path keeps its own availability PROBE, so it shares the fallback, not the lookup.
    assert "bootstrap_worker_type" in inspect.getsource(registry_mod.run_capability_install_process)


def test_the_rule_asks_the_fact_not_a_key():
    source = inspect.getsource(registry_mod.bootstrap_worker_type)
    assert ".bootstrap" in source and f'"{BOOTSTRAP.key}"' not in source
