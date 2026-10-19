"""Search works on a Windows that lacks the C++ runtime, without installing anything or asking anyone.

usearch links ``MSVCP140.dll``. Flowpad ships that one DLL (``rag/vcruntime/``) and, only AFTER a normal import has
failed, puts its folder on the loader's search path with ``os.add_dll_directory`` — no installer, so no Windows
permission prompt. The machine without the runtime is played by an import finder that refuses usearch the way
``DLL load failed`` does; registering the folder is modelled as its effect (the import works again). What
cannot be played here — that the Windows loader really resolves the dependency through that folder — was measured on
a Windows VM and is recorded in ``rag/vcruntime/README.md``.
"""

from __future__ import annotations

import hashlib
import importlib.abc
import os
import struct
import sys

import pytest

from flow_sdk.rag import runtime

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

PE_MACHINE = {"win-amd64": 0x8664, "win-arm64": 0xAA64}


class _NoRuntime(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path=None, target=None):
        if name == "usearch" or name.startswith("usearch."):
            raise ImportError("DLL load failed while importing compiled: The specified module could not be found.")


@pytest.fixture(autouse=True)
def _forget_registered_folder(monkeypatch):
    monkeypatch.setattr(runtime, "_dll_directory", None)


@pytest.fixture
def windows(monkeypatch):
    """Pretend to be a Windows interpreter of the given platform tag. Returns ``set_platform(tag)``."""
    monkeypatch.setattr(sys, "platform", "win32")

    def set_platform(tag: str) -> None:
        monkeypatch.setattr(runtime.sysconfig, "get_platform", lambda: tag)

    set_platform("win-amd64")
    return set_platform


@pytest.fixture
def no_runtime(monkeypatch):
    """usearch cannot load. Returns ``install()``, which puts it back (what finding the DLL does)."""
    import usearch.index  # noqa: F401 — so there is something to hide and later restore

    saved = {k: v for k, v in sys.modules.items() if k == "usearch" or k.startswith("usearch.")}
    for name in saved:
        monkeypatch.delitem(sys.modules, name)
    finder = _NoRuntime()
    monkeypatch.setattr(sys, "meta_path", [finder, *sys.meta_path])

    def install() -> None:
        sys.meta_path.remove(finder)
        sys.modules.update(saved)

    return install


def _ours(calls: list[str]) -> list[str]:
    """The registrations that are Flowpad's. usearch (and numpy) register their own libs folders on import."""
    return [c for c in calls if str(runtime._VCRUNTIME_DIR) in c]


@pytest.fixture
def dll_directories(monkeypatch):
    """Record ``os.add_dll_directory`` (it only exists on Windows). The effect is up to the test."""
    calls: list[str] = []
    effect = {"run": lambda: None}

    class _Handle:
        def close(self):  # pragma: no cover — only here so the handle looks like the real one
            pass

    def add_dll_directory(path):
        calls.append(path)
        effect["run"]()
        return _Handle()

    monkeypatch.setattr(os, "add_dll_directory", add_dll_directory, raising=False)
    return calls, effect


# --- the shipped files ---------------------------------------------------------------------------------


@pytest.mark.parametrize("tag", sorted(PE_MACHINE))
def test_the_shipped_dll_is_the_pinned_one_for_its_architecture(tag):
    dll = runtime._VCRUNTIME_DIR / tag / "msvcp140.dll"
    blob = dll.read_bytes()

    assert hashlib.sha256(blob).hexdigest() == runtime._VCRUNTIME_SHA256[tag]
    pe = struct.unpack_from("<I", blob, 0x3C)[0]
    assert blob[pe : pe + 4] == b"PE\0\0"
    assert struct.unpack_from("<H", blob, pe + 4)[0] == PE_MACHINE[tag], "an x64 DLL in the ARM64 folder cannot load"


@pytest.mark.parametrize("tag", sorted(PE_MACHINE))
def test_the_shipped_dll_still_carries_its_signature(tag):
    """Microsoft's signature is what makes these bytes trustworthy, so a re-built or stripped file is caught here.
    (That it is VALID is checked on Windows with Get-AuthenticodeSignature, when the files are refreshed.)"""
    blob = (runtime._VCRUNTIME_DIR / tag / "msvcp140.dll").read_bytes()
    pe = struct.unpack_from("<I", blob, 0x3C)[0]
    optional = pe + 24
    magic = struct.unpack_from("<H", blob, optional)[0]
    directories = optional + (112 if magic == 0x20B else 96)
    security_offset, security_size = struct.unpack_from("<II", blob, directories + 4 * 8)  # entry 4: certificate table

    assert security_size > 0 and security_offset > 0


def test_every_pinned_architecture_has_a_file_and_every_file_a_pin():
    on_disk = {p.parent.name for p in runtime._VCRUNTIME_DIR.glob("*/msvcp140.dll")}

    assert on_disk == set(runtime._VCRUNTIME_SHA256)


# --- which folder, when ---------------------------------------------------------------------------------


def test_nothing_is_offered_off_windows():
    assert sys.platform != "win32"
    assert runtime.app_local_runtime_dir() is None
    assert runtime.use_app_local_runtime() is False


@pytest.mark.parametrize("tag", sorted(PE_MACHINE))
def test_the_folder_follows_the_interpreters_architecture(windows, tag):
    windows(tag)

    assert runtime.app_local_runtime_dir() == runtime._VCRUNTIME_DIR / tag


def test_a_32_bit_python_gets_nothing(windows):
    windows("win32")

    assert runtime.app_local_runtime_dir() is None


def test_a_dll_that_is_not_the_pinned_one_is_never_used(windows, monkeypatch, dll_directories):
    calls, _ = dll_directories
    monkeypatch.setitem(runtime._VCRUNTIME_SHA256, "win-amd64", "0" * 64)

    assert runtime.app_local_runtime_dir() is None
    assert runtime.use_app_local_runtime() is False
    assert _ours(calls) == [], "a replaced DLL must not reach the loader's search path"


def test_registering_twice_registers_once(windows, dll_directories):
    calls, _ = dll_directories

    assert runtime.use_app_local_runtime() is True
    assert runtime.use_app_local_runtime() is True
    assert _ours(calls) == [str(runtime._VCRUNTIME_DIR / "win-amd64")]


# --- the order: the machine's own runtime first, ours only when it is missing -----------------------------


def test_a_machine_that_has_the_runtime_keeps_using_its_own(windows, dll_directories):
    calls, _ = dll_directories

    assert runtime.refusal() == "", "usearch imports normally on this box"
    assert _ours(calls) == [], (
        "the shipped copy must not be registered where the real one works (Windows Update patches that one)"
    )


def test_without_the_runtime_the_shipped_copy_makes_search_work(windows, no_runtime, dll_directories):
    calls, effect = dll_directories
    effect["run"] = no_runtime  # finding msvcp140.dll in that folder is what lets the import succeed

    assert runtime.refusal() == "", "no prompt, no question: the import just works"
    assert _ours(calls) == [str(runtime._VCRUNTIME_DIR / "win-amd64")]


def test_when_even_the_shipped_copy_is_not_usable_search_falls_back_to_asking(windows, no_runtime, dll_directories):
    calls, _ = dll_directories  # the folder is registered, but the import still fails: nothing changed

    assert runtime.refusal() == runtime.MISSING_RUNTIME
    assert _ours(calls) == [str(runtime._VCRUNTIME_DIR / "win-amd64")]


def test_an_unsupported_architecture_goes_straight_to_the_old_path(windows, no_runtime, dll_directories):
    calls, _ = dll_directories
    windows("win32")

    assert runtime.refusal() == runtime.MISSING_RUNTIME
    assert _ours(calls) == []
