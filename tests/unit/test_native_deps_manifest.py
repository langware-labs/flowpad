"""electron/native-deps.json must match uv.lock (scripts/native_deps_from_lock.py)."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _module():
    spec = importlib.util.spec_from_file_location(
        "native_deps_from_lock", ROOT / "scripts" / "native_deps_from_lock.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_manifest_matches_the_lock():
    mod = _module()
    expected = mod.render((ROOT / "uv.lock").read_text(encoding="utf-8"))
    actual = (ROOT / "electron" / "native-deps.json").read_text(encoding="utf-8")
    assert actual == expected, "electron/native-deps.json is stale: run `python scripts/native_deps_from_lock.py`"


def test_manifest_names_the_packages_application_control_can_refuse():
    data = json.loads((ROOT / "electron" / "native-deps.json").read_text(encoding="utf-8"))
    assert {"pydantic-core", "cryptography", "sqlalchemy"} <= set(data["packages"])
    assert "typer" not in data["packages"], "pure-Python packages carry no binaries and need no margin"


def test_the_scan_only_counts_platform_specific_wheels():
    mod = _module()
    lock = (
        '[[package]]\nname = "pure"\nversion = "1.0"\nwheels = [\n'
        '    { url = "https://x/pure-1.0-py3-none-any.whl" },\n]\n\n'
        '[[package]]\nname = "native"\nversion = "1.0"\nwheels = [\n'
        '    { url = "https://x/native-1.0-cp311-cp311-win_amd64.whl" },\n]\n'
    )
    assert mod.native_packages(lock) == ["native"]
