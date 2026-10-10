"""A test that runs a turn needs its vendor CLI to be installed.

An uninstalled harness funds nothing (``llm_source._device_source``): its device login is
ineligible, so resolving the LLM source refuses the turn before the driver is reached. CI
has no vendor CLI on PATH, and a test written on a machine that has one passes there by
accident. A test that means to run a turn says so with this fixture; one that means to
test an absent CLI declares that instead (``test_connection_status._installed``).
"""

from __future__ import annotations

import pytest


def declare_harnesses_installed(monkeypatch) -> None:
    """Every harness reads as installed at a fixed path; nothing on disk is consulted."""
    monkeypatch.setattr(
        "flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver.worker_executable",
        lambda worker_type: f"/usr/local/bin/{worker_type}",
    )


def declare_harness_bin(monkeypatch, folder) -> None:
    """The per-turn spawn's own lookup: it prepends the DISCOVERED bin folder to the worker's PATH and
    resolves the vendor's executable there (``build_worker_spawn_env`` / ``resolve_worker_argv0``), which
    ``worker_executable`` alone does not answer. A folder holding a stub per vendor stands in for it."""
    from flow_sdk.flowpad_types.vendors import VENDORS  # noqa: PLC0415

    folder.mkdir(parents=True, exist_ok=True)
    for vendor in VENDORS:
        stub = folder / vendor.key
        stub.write_text("#!/bin/sh\n", encoding="utf-8")
        stub.chmod(0o755)
    monkeypatch.setattr(
        "flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver.worker_bin_folder",
        lambda worker_type: str(folder),
    )


@pytest.fixture
def harness_installed(monkeypatch):
    declare_harnesses_installed(monkeypatch)


@pytest.fixture
def funding_not_under_test(monkeypatch, tmp_path):
    """A launch on a box where something funds the harness: the spawn is funded by the device
    login, the LLM-source picker answers "chosen", and no login probe runs. For tests of spawn and turn mechanics, never of funding
    (the same stub ``test_assistant_context_key_create`` uses)."""
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from flow_sdk.builtin.agentic_process.cli_drivers import api_auth, llm_source

    declare_harnesses_installed(monkeypatch)
    declare_harness_bin(monkeypatch, tmp_path / "harness-bin")
    monkeypatch.setattr(llm_source, "check_unchecked_login", AsyncMock(return_value=None))
    monkeypatch.setattr(
        llm_source, "llm_picker_view", AsyncMock(return_value=SimpleNamespace(chosen=object(), blocked=""))
    )
    # The spawn's own funding question: a device login, nothing to inject (what ``None`` means).
    monkeypatch.setattr(api_auth, "resolve_worker_api_auth", AsyncMock(return_value=None))
