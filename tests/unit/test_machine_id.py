"""Unit tests for flow_sdk.utils.machine_id.

The function under test has three concerns kept tested independently:
  1. Cache-first lookup (returns cached value, doesn't recompute)
  2. OS-specific derivation (Linux/Darwin/Windows branches)
  3. Atomic cache write + concurrent-write safety
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
from pathlib import Path
from unittest.mock import patch

import pytest

from flow_sdk.utils import machine_id as mid_mod
from flow_sdk.utils.machine_id import (
    CACHE_FILENAME,
    CACHE_KEY,
    _derive_machine_id,
    _read_cache,
    _write_cache,
    get_machine_id,
)


# ----------------------------------------------------------------------
# get_machine_id — cache-first contract
# ----------------------------------------------------------------------

def test_first_call_derives_and_caches(tmp_path):
    cache_path = tmp_path / "global" / CACHE_FILENAME
    assert not cache_path.exists()
    val = get_machine_id(flow_home=tmp_path)
    assert isinstance(val, str) and val
    assert cache_path.is_file()
    on_disk = json.loads(cache_path.read_text())
    assert on_disk[CACHE_KEY] == val
    assert "_provenance" in on_disk
    assert "_first_seen" in on_disk
    assert "_created_by_version" in on_disk


def test_subsequent_call_returns_cached_value(tmp_path, monkeypatch):
    first = get_machine_id(flow_home=tmp_path)
    # Sabotage derivation — if cache works, this never runs.
    monkeypatch.setattr(
        mid_mod, "_derive_machine_id",
        lambda: (_ for _ in ()).throw(AssertionError("must not derive on cache hit")),
    )
    second = get_machine_id(flow_home=tmp_path)
    assert first == second


def test_cache_survives_os_id_disappearing(tmp_path, monkeypatch):
    """The whole point of the cache: even if the OS-derived value
    later disappears or changes, the machine's flow identity is
    preserved."""
    first = get_machine_id(flow_home=tmp_path)
    # Pretend /etc/machine-id (or equivalent) is gone.
    monkeypatch.setattr(
        mid_mod, "_derive_machine_id",
        lambda: (_ for _ in ()).throw(AssertionError("cache should win")),
    )
    assert get_machine_id(flow_home=tmp_path) == first


def test_cache_corruption_recomputes(tmp_path):
    cache_path = tmp_path / "global" / CACHE_FILENAME
    cache_path.parent.mkdir(parents=True)
    cache_path.write_text("not valid json {{{ ")
    val = get_machine_id(flow_home=tmp_path)
    assert val
    # Recomputed and rewrote cleanly.
    assert json.loads(cache_path.read_text())[CACHE_KEY] == val


def test_cache_missing_key_recomputes(tmp_path):
    cache_path = tmp_path / "global" / CACHE_FILENAME
    cache_path.parent.mkdir(parents=True)
    cache_path.write_text(json.dumps({"some_other_key": "x"}))
    val = get_machine_id(flow_home=tmp_path)
    assert val
    assert json.loads(cache_path.read_text())[CACHE_KEY] == val


def test_cache_empty_value_recomputes(tmp_path):
    cache_path = tmp_path / "global" / CACHE_FILENAME
    cache_path.parent.mkdir(parents=True)
    cache_path.write_text(json.dumps({CACHE_KEY: ""}))
    val = get_machine_id(flow_home=tmp_path)
    assert val
    assert val != ""


# ----------------------------------------------------------------------
# _derive_machine_id — OS-specific branches
# ----------------------------------------------------------------------

def test_derive_linux_reads_etc_machine_id(monkeypatch, tmp_path):
    fake_machine_id = "a1b2c3d4e5f6"
    fake_path = tmp_path / "machine-id"
    fake_path.write_text(fake_machine_id + "\n")

    monkeypatch.setattr("platform.system", lambda: "Linux")

    real_is_file = Path.is_file

    def fake_is_file(self):
        if str(self) == "/etc/machine-id":
            return True
        return real_is_file(self)

    real_read_text = Path.read_text

    def fake_read_text(self, *a, **kw):
        if str(self) == "/etc/machine-id":
            return real_read_text(fake_path, *a, **kw)
        return real_read_text(self, *a, **kw)

    monkeypatch.setattr(Path, "is_file", fake_is_file)
    monkeypatch.setattr(Path, "read_text", fake_read_text)

    val, prov = _derive_machine_id()
    assert val == fake_machine_id
    assert prov == "linux:/etc/machine-id"


def test_derive_linux_fallback_to_dbus(monkeypatch):
    monkeypatch.setattr("platform.system", lambda: "Linux")

    def fake_is_file(self):
        return str(self) == "/var/lib/dbus/machine-id"

    def fake_read_text(self, *a, **kw):
        if str(self) == "/var/lib/dbus/machine-id":
            return "dbus-fallback-id\n"
        raise OSError("nope")

    monkeypatch.setattr(Path, "is_file", fake_is_file)
    monkeypatch.setattr(Path, "read_text", fake_read_text)

    val, prov = _derive_machine_id()
    assert val == "dbus-fallback-id"
    assert prov == "linux:/var/lib/dbus/machine-id"


def test_derive_darwin_parses_ioreg(monkeypatch):
    monkeypatch.setattr("platform.system", lambda: "Darwin")
    ioreg_out = (
        '    | |   "IOPlatformSerialNumber" = "ABC123"\n'
        '    | |   "IOPlatformUUID" = "12345678-1234-1234-1234-123456789ABC"\n'
        '    | |   "platform-name" = <"foo">\n'
    )
    monkeypatch.setattr(
        subprocess, "check_output",
        lambda *a, **kw: ioreg_out,
    )
    val, prov = _derive_machine_id()
    assert val == "12345678-1234-1234-1234-123456789ABC"
    assert prov == "darwin:IOPlatformUUID"


def test_derive_unknown_os_falls_back(monkeypatch):
    monkeypatch.setattr("platform.system", lambda: "Plan9")
    monkeypatch.setattr("platform.machine", lambda: "riscv64")
    val, prov = _derive_machine_id()
    assert val.startswith("fallback-riscv64-")
    assert prov == "fallback:Plan9"


def test_derive_handles_subprocess_failure(monkeypatch):
    monkeypatch.setattr("platform.system", lambda: "Darwin")

    def bad(*a, **kw):
        raise subprocess.CalledProcessError(1, "ioreg")

    monkeypatch.setattr(subprocess, "check_output", bad)
    val, prov = _derive_machine_id()
    # Falls back, doesn't raise.
    assert val.startswith("fallback-")
    assert prov.startswith("fallback:")


# ----------------------------------------------------------------------
# Cache writes — atomicity + filelock
# ----------------------------------------------------------------------

def test_write_creates_global_dir(tmp_path):
    assert not (tmp_path / "global").exists()
    _write_cache(tmp_path / "global" / CACHE_FILENAME, "abc", "test:fake")
    assert (tmp_path / "global" / CACHE_FILENAME).is_file()


def test_write_is_atomic_no_temp_left_behind(tmp_path):
    _write_cache(tmp_path / "global" / CACHE_FILENAME, "abc", "test:fake")
    leftover_temps = list((tmp_path / "global").glob(".system_*.tmp"))
    assert leftover_temps == []


def test_second_write_loses_to_first(tmp_path):
    """Inside the filelock, re-check the cache. If another process won
    the race, accept their value rather than overwriting."""
    cache_path = tmp_path / "global" / CACHE_FILENAME
    _write_cache(cache_path, "first-winner", "test:race")
    _write_cache(cache_path, "second-loser", "test:race")
    assert _read_cache(cache_path) == "first-winner"


def test_concurrent_first_writes_converge(tmp_path):
    """N threads racing to be the first writer must converge on a
    single value (whichever got the lock first)."""
    cache_path = tmp_path / "global" / CACHE_FILENAME
    barrier = threading.Barrier(10)
    results: list[str] = []
    lock = threading.Lock()

    def worker(i: int):
        barrier.wait()
        val = get_machine_id(flow_home=tmp_path)
        with lock:
            results.append(val)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(10)]
    for t in threads: t.start()
    for t in threads: t.join(timeout=15)

    assert len(results) == 10
    assert len(set(results)) == 1, f"diverged: {set(results)}"
    # Only one cache file exists (no race-corrupted siblings).
    cache_files = list((tmp_path / "global").glob("system*"))
    # Allow the lock file as a sibling.
    json_files = [p for p in cache_files if p.suffix == ".json" or p.name == "system.json"]
    assert len(json_files) == 1


def test_read_cache_returns_none_for_missing(tmp_path):
    assert _read_cache(tmp_path / "missing.json") is None


def test_read_cache_returns_none_for_non_dict(tmp_path):
    p = tmp_path / "x.json"
    p.write_text(json.dumps(["not", "a", "dict"]))
    assert _read_cache(p) is None
