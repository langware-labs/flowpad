"""Spawning resolves its CLI itself — no sweep, no backend, no handshake.

`worker_bin_folder` is the only reader of the capability dict in the whole
agentic-process tree, and it used to be a bare read: if no discovery sweep had
run in THIS process it returned None and the spawn raised, even with the binary
plainly on PATH. Three spawn paths each grew their own compensation and 13
callers had to remember `await ensure_discovered()` — a 4.4s sweep whose actual
`discover()` hooks take 0.001s, the rest being an env-probe subprocess and a
live re-test of every capability to refresh UI badges.

These tests pin the replacement: resolve from the swept value, else from PATH,
memoize a hit, never sweep. PATH is pinned to a tmp dir throughout, so what the
host has installed cannot change any outcome.
"""
from __future__ import annotations

import os
import shutil

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    WorkerSpawnError,
    build_worker_spawn_env,
    worker_bin_folder,
    worker_capability_kind,
)
from flow_sdk.core.capabilities import discovery as discovery_mod
from flow_sdk.core.capabilities.discovery import (
    resolve_capability_value,
    set_capability_value,
)
from flow_sdk.core.capabilities.models import CapabilityKind, CapabilityValue
from flow_sdk.flowpad_types.vendors import VENDORS
from flow_sdk.schema.data_spec import DataSpec
from tests.utils.fake_cli import write_fake_cli_stub as _install

VENDOR_IDS = [v.key for v in VENDORS]


@pytest.fixture(autouse=True)
def _empty_discovery():
    """No swept values — the state a plain `python -c` spawn starts from."""
    discovery_mod._VALUES.clear()
    yield
    discovery_mod._VALUES.clear()


@pytest.fixture
def bin_dir(tmp_path, monkeypatch):
    """An empty PATH containing only what a test puts there."""
    d = tmp_path / "bin"
    d.mkdir()
    monkeypatch.setenv("PATH", str(d))
    return d


def _count_which(monkeypatch) -> list[str]:
    """Record every executable `shutil.which` is asked for."""
    asked: list[str] = []
    inner = shutil.which

    def _which(cmd, mode=os.F_OK | os.X_OK, path=None):
        asked.append(cmd)
        return inner(cmd, mode, path)

    monkeypatch.setattr(shutil, "which", _which)
    return asked


# ── the fallback ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize("vendor", VENDORS, ids=VENDOR_IDS)
def test_resolves_from_path_with_no_sweep(vendor, bin_dir):
    """Every worker: on PATH and never swept ⇒ resolved, and usable as a spawn env."""
    _install(bin_dir, vendor.key)

    assert worker_bin_folder(vendor.worker_type) == str(bin_dir)
    env = build_worker_spawn_env(vendor.worker_type, {})
    assert env["PATH"].split(os.pathsep)[0] == str(bin_dir)


@pytest.mark.parametrize("vendor", VENDORS, ids=VENDOR_IDS)
def test_a_hit_is_probed_once(vendor, bin_dir, monkeypatch):
    _install(bin_dir, vendor.key)
    asked = _count_which(monkeypatch)

    assert worker_bin_folder(vendor.worker_type) == str(bin_dir)
    assert worker_bin_folder(vendor.worker_type) == str(bin_dir)

    assert asked.count(vendor.key) == 1, f"probed {asked.count(vendor.key)}x, expected once"


@pytest.mark.parametrize("vendor", VENDORS, ids=VENDOR_IDS)
def test_a_swept_value_outranks_path(vendor, tmp_path, monkeypatch):
    """A sweep looked with the LOGIN-shell PATH; that answer wins over ours."""
    swept, on_path = tmp_path / "swept", tmp_path / "on-path"
    swept.mkdir()
    on_path.mkdir()
    monkeypatch.setenv("PATH", str(on_path))
    _install(on_path, vendor.key)
    set_capability_value(
        CapabilityValue(
            kind=worker_capability_kind(vendor.worker_type),
            value={"path": str(swept)},
            spec=DataSpec.parse("fs_ref"),
        )
    )

    assert worker_bin_folder(vendor.worker_type) == str(swept)


@pytest.mark.parametrize("vendor", VENDORS, ids=VENDOR_IDS)
def test_a_swept_absence_outranks_path(vendor, bin_dir):
    """A swept `value=None` is a real "looked, absent" and is not second-guessed."""
    _install(bin_dir, vendor.key)
    set_capability_value(
        CapabilityValue(
            kind=worker_capability_kind(vendor.worker_type),
            value=None,
            spec=DataSpec.parse("fs_ref"),
        )
    )

    assert worker_bin_folder(vendor.worker_type) is None


@pytest.mark.parametrize("vendor", VENDORS, ids=VENDOR_IDS)
def test_a_later_sweep_replaces_a_path_resolution(vendor, tmp_path, monkeypatch):
    """Install-then-refresh takes effect: the sweep overwrites the memo."""
    on_path, swept = tmp_path / "on-path", tmp_path / "swept"
    on_path.mkdir()
    swept.mkdir()
    monkeypatch.setenv("PATH", str(on_path))
    _install(on_path, vendor.key)
    assert worker_bin_folder(vendor.worker_type) == str(on_path)

    set_capability_value(  # what `_discover_one` does at the end of a sweep
        CapabilityValue(
            kind=worker_capability_kind(vendor.worker_type),
            value={"path": str(swept)},
            spec=DataSpec.parse("fs_ref"),
        )
    )
    assert worker_bin_folder(vendor.worker_type) == str(swept)


# ── the exceptions ────────────────────────────────────────────────────────────


@pytest.mark.parametrize("vendor", VENDORS, ids=VENDOR_IDS)
def test_the_selected_worker_is_missing(vendor, bin_dir):
    """One absent, the others present: name it, and do NOT claim there are none."""
    for other in VENDORS:
        if other.key != vendor.key:
            _install(bin_dir, other.key)

    with pytest.raises(WorkerSpawnError) as exc:
        build_worker_spawn_env(vendor.worker_type, {})

    message = str(exc.value)
    assert worker_capability_kind(vendor.worker_type) in message
    assert "no harness is installed" not in message
    for other in VENDORS:
        if other.key != vendor.key:
            assert other.key in message, "the message should say what IS available"


def test_no_workers_at_all(bin_dir):
    """Nothing selected, nothing installed — a different problem, said differently."""
    with pytest.raises(WorkerSpawnError) as exc:
        build_worker_spawn_env(VENDORS[0].worker_type, {})

    message = str(exc.value)
    assert "no harness is installed" in message
    for vendor in VENDORS:
        assert vendor.key in message, "say which harnesses were looked for"


@pytest.mark.parametrize("vendor", VENDORS, ids=VENDOR_IDS)
def test_a_miss_is_not_remembered(vendor, bin_dir):
    """A miss must not stick: this process's PATH is not the login shell's, and a
    CLI installed outside Flowpad has no other way back in."""
    kind = worker_capability_kind(vendor.worker_type)

    assert worker_bin_folder(vendor.worker_type) is None
    assert kind not in discovery_mod._VALUES, "a PATH miss must not be cached"

    _install(bin_dir, vendor.key)
    assert worker_bin_folder(vendor.worker_type) == str(bin_dir), "must self-heal"


# ── what it must NOT do ───────────────────────────────────────────────────────


def test_resolution_never_sweeps(bin_dir, monkeypatch):
    """The guard against the 4.4s behaviour creeping back."""

    async def _boom(*a, **k):
        raise AssertionError("resolution ran a discovery sweep")

    monkeypatch.setattr(discovery_mod, "_run_env_probe", _boom)
    monkeypatch.setattr(discovery_mod, "_run_discovery_inner", _boom)
    monkeypatch.setattr(discovery_mod, "_mirror_to_rows", _boom)

    for vendor in VENDORS:
        _install(bin_dir, vendor.key)
        assert worker_bin_folder(vendor.worker_type) == str(bin_dir)


@pytest.mark.parametrize(
    "kind",
    [CapabilityKind.CHROME_AUTHENTICATED.value, CapabilityKind.GITHUB.value, CapabilityKind.HARNESS.value],
)
def test_non_cli_kinds_are_left_to_a_real_sweep(kind, bin_dir):
    """Only a CLI lookup is answerable from PATH; the rest write nothing."""
    assert resolve_capability_value(kind) is None
    assert kind not in discovery_mod._VALUES


def test_an_unregistered_kind_is_not_an_error(bin_dir):
    assert resolve_capability_value("nope.not.a.kind") is None
