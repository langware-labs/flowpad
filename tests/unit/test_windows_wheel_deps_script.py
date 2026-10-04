"""The Windows-wheel dependency scan decides what counts as "needs a DLL a clean Windows lacks".

The scan itself reads real wheels over the network (``.github/workflows/windows-wheel-deps.yml``). What is
pinned here is its judgement, offline, on a real PE file: the ``msvcp140.dll`` Flowpad ships imports the
Visual C++ runtime, which makes it a faithful stand-in for a native extension that needs one.
"""

from __future__ import annotations

import importlib.util
import zipfile
from pathlib import Path

import pytest

from flow_sdk.rag import runtime

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location(
    "check_windows_wheel_deps", ROOT / "scripts" / "check_windows_wheel_deps.py"
)
scan = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(scan)

SHIPPED_DLL = runtime._VCRUNTIME_DIR / "win-amd64" / "msvcp140.dll"


def _wheel(tmp_path, members: dict[str, bytes]) -> Path:
    path = tmp_path / "pkg-1.0-cp311-cp311-win_amd64.whl"
    with zipfile.ZipFile(path, "w") as archive:
        for name, data in members.items():
            archive.writestr(name, data)
    return path


def test_a_native_extension_that_imports_the_runtime_is_seen(tmp_path):
    wheel = _wheel(tmp_path, {"pkg/_native.pyd": SHIPPED_DLL.read_bytes(), "pkg/__init__.py": b""})

    found = scan.redistributable_imports(wheel, scan._pe_imports())

    assert set(found) == {"pkg/_native.pyd"}, "only the binary, not the .py"
    assert "vcruntime140.dll" in found["pkg/_native.pyd"]


def test_a_data_file_named_dll_is_not_a_crash(tmp_path):
    wheel = _wheel(tmp_path, {"pkg/notes.dll": b"just text"})

    assert scan.redistributable_imports(wheel, scan._pe_imports()) == {}


def test_what_python_brings_is_never_a_failure():
    assert scan.unsupplied("anything", {"a.pyd": {"vcruntime140.dll", "vcruntime140_1.dll"}}) == set()


def test_a_package_needing_a_dll_nobody_supplies_fails():
    assert scan.unsupplied("newcomer", {"a.pyd": {"msvcp140.dll", "vcruntime140.dll"}}) == {"msvcp140.dll"}
    assert scan.unsupplied("newcomer", {"a.pyd": {"vcomp140.dll"}}) == {"vcomp140.dll"}


def test_usearchs_runtime_dll_is_covered_because_flowpad_ships_it():
    assert scan.unsupplied("usearch", {"a.pyd": {"msvcp140.dll", "vcruntime140.dll"}}) == set()
    # ...but only that one: another Redistributable DLL of usearch's is still a failure.
    assert scan.unsupplied("usearch", {"a.pyd": {"msvcp140_1.dll"}}) == {"msvcp140_1.dll"}


def test_the_scan_and_the_shipped_files_name_the_same_dlls():
    """If a DLL is shipped for another package, the scan must be told, and the other way round."""
    shipped = {path.name.lower() for path in runtime._VCRUNTIME_DIR.glob("*/*.dll")}

    assert set().union(*scan.SHIPPED_BY_FLOWPAD.values()) == shipped


def test_pywins_mapi_bindings_are_ignored_but_the_rest_of_pywin32_is_not():
    assert scan.unsupplied("pywin32", {"win32comext/mapi/mapi.pyd": {"msvcp140.dll"}}) == set()
    assert scan.unsupplied("pywin32", {"win32/win32api.pyd": {"msvcp140.dll"}}) == {"msvcp140.dll"}


def test_only_windows_wheels_of_the_asked_python_are_scanned(tmp_path):
    lock = tmp_path / "uv.lock"
    base = "https://files.example/"
    lock.write_text(
        "version = 1\n"
        "[[package]]\n"
        'name = "native"\nversion = "1"\n'
        "wheels = [\n"
        f'  {{ url = "{base}native-1-cp311-cp311-win_amd64.whl", hash = "sha256:aa" }},\n'
        f'  {{ url = "{base}native-1-cp312-cp312-win_amd64.whl", hash = "sha256:bb" }},\n'
        f'  {{ url = "{base}native-1-cp311-cp311-manylinux_2_17_x86_64.whl", hash = "sha256:cc" }},\n'
        f'  {{ url = "{base}native-1-cp311-abi3-win_arm64.whl", hash = "sha256:dd" }},\n'
        "]\n"
        "[[package]]\n"
        'name = "purepython"\nversion = "1"\n'
        "wheels = [\n"
        f'  {{ url = "{base}purepython-1-py3-none-any.whl", hash = "sha256:ee" }},\n'
        "]\n"
    )

    wheels = scan.windows_wheels(lock, ("cp311",))

    assert set(wheels) == {"native"}, "a pure-Python wheel has no binary to scan"
    assert [w["hash"] for w in wheels["native"]] == ["sha256:aa", "sha256:dd"]
