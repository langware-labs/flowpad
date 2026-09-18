"""A harness that is a Python package (``Vendor.python_module``) — the install gate.

``test_lazy_capability_resolution.py`` pins five guarantees for a BINARY found on PATH. A
``python -m`` harness is located in this interpreter's environment instead, and the same five
have to hold for it, or a box with the package installed cannot spawn its builtin worker.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    WorkerSpawnError,
    build_worker_spawn_env,
    worker_bin_folder,
    worker_capability_kind,
    worker_executable,
)
from flow_sdk.core.capabilities import discovery as discovery_mod
from flow_sdk.core.capabilities.discovery import set_capability_value
from flow_sdk.core.capabilities.models import CapabilityValue
from flow_sdk.core.capabilities.registry import PythonModuleCapabilityRunner, get_capability_registry
from flow_sdk.flowpad_types.vendors import VENDORS
from flow_sdk.schema.data_spec import DataSpec

MODULE_VENDORS = [v for v in VENDORS if v.python_module]
IDS = [v.key for v in MODULE_VENDORS]
INTERPRETER_DIR = str(Path(sys.executable).parent)


@pytest.fixture(autouse=True)
def _empty_discovery():
    discovery_mod._VALUES.clear()
    yield
    discovery_mod._VALUES.clear()


@pytest.fixture
def installed(monkeypatch):
    monkeypatch.setattr(PythonModuleCapabilityRunner, "missing_distributions", lambda self: [])


@pytest.fixture
def not_installed(monkeypatch):
    monkeypatch.setattr(PythonModuleCapabilityRunner, "missing_distributions", lambda self: ["deepagents"])


def test_there_is_a_module_vendor_to_pin():
    assert MODULE_VENDORS, "no python_module vendor — this file would silently assert nothing"


@pytest.mark.parametrize("vendor", MODULE_VENDORS, ids=IDS)
def test_the_registry_built_the_module_runner_from_the_vendor_fact(vendor):
    runner = get_capability_registry().get(vendor.capability_kind)
    assert isinstance(runner, PythonModuleCapabilityRunner)
    assert runner.module == vendor.python_module and runner.requires == vendor.python_requires
    assert runner.executable == Path(sys.executable).name
    assert runner.test_args == ["-m", vendor.python_module, "--version"]


@pytest.mark.parametrize("vendor", MODULE_VENDORS, ids=IDS)
def test_resolves_with_no_sweep_and_an_empty_path(vendor, installed, monkeypatch, tmp_path):
    """PATH is irrelevant: the value is THIS interpreter's bin folder, usable as a spawn env."""
    monkeypatch.setenv("PATH", str(tmp_path))

    assert worker_bin_folder(vendor.worker_type) == INTERPRETER_DIR
    assert worker_executable(vendor.worker_type) == sys.executable
    env = build_worker_spawn_env(vendor.worker_type, {})
    assert INTERPRETER_DIR in env["PATH"].split(os.pathsep)[:2]


@pytest.mark.parametrize("vendor", MODULE_VENDORS, ids=IDS)
def test_a_missing_distribution_is_not_installed(vendor, not_installed):
    assert worker_bin_folder(vendor.worker_type) is None
    with pytest.raises(WorkerSpawnError):
        build_worker_spawn_env(vendor.worker_type, {})


@pytest.mark.parametrize("vendor", MODULE_VENDORS, ids=IDS)
def test_a_miss_is_not_remembered(vendor, monkeypatch):
    """``pip install`` outside FlowPad must be noticed without a restart."""
    missing = ["deepagents"]
    monkeypatch.setattr(PythonModuleCapabilityRunner, "missing_distributions", lambda self: list(missing))
    kind = worker_capability_kind(vendor.worker_type)

    assert worker_bin_folder(vendor.worker_type) is None
    assert kind not in discovery_mod._VALUES, "a miss must not be cached"

    missing.clear()
    assert worker_bin_folder(vendor.worker_type) == INTERPRETER_DIR, "must self-heal"


@pytest.mark.parametrize("vendor", MODULE_VENDORS, ids=IDS)
def test_a_swept_absence_outranks_the_environment(vendor, installed):
    set_capability_value(
        CapabilityValue(kind=worker_capability_kind(vendor.worker_type), value=None, spec=DataSpec.parse("fs_ref"))
    )
    assert worker_bin_folder(vendor.worker_type) is None


@pytest.mark.parametrize("vendor", MODULE_VENDORS, ids=IDS)
async def test_the_sweep_asks_the_environment_not_the_terminal_path(vendor, installed):
    """The terminal-PATH probe has nothing to say about a package; an empty probe must not read
    as "absent"."""
    runner = get_capability_registry().get(vendor.capability_kind)
    value = await runner.discover({"executables": {}})  # the PATH probe found nothing
    assert isinstance(value.value, dict) and value.value["path"] == INTERPRETER_DIR


@pytest.mark.parametrize("vendor", MODULE_VENDORS, ids=IDS)
async def test_an_absent_package_says_which_distribution_is_missing(vendor, not_installed):
    runner = get_capability_registry().get(vendor.capability_kind)
    value = await runner.discover({})
    assert value.value is None and "deepagents" in value.message


def test_presence_is_read_from_metadata_never_by_importing():
    """The engine takes seconds to import and this answers on the spawn path.

    Asked of a FRESH interpreter: ``sys.modules`` is process-global, and in a full run another
    test has legitimately imported the engine already.
    """
    import subprocess

    probe = (
        "import sys\n"
        "from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import worker_bin_folder\n"
        "from flow_sdk.core.capabilities.registry import get_capability_registry\n"
        "runner = get_capability_registry().get('harness.deepagents.cli')\n"
        "runner.missing_distributions(); runner.locate_on_process_path(); worker_bin_folder('deepagents')\n"
        "print(sorted(m for m in sys.modules if m.split('.')[0] in ('deepagents', 'langchain', 'langgraph')))\n"
    )
    repo = Path(__file__).resolve().parents[2]
    proc = subprocess.run(
        [sys.executable, "-c", probe], capture_output=True, text=True, check=False, cwd=str(repo), env={**os.environ, "PYTHONPATH": str(repo)}
    )
    assert proc.returncode == 0, proc.stderr[-1500:]
    assert proc.stdout.strip().splitlines()[-1] == "[]", "the install gate imported the engine"
