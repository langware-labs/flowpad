"""Desktop <-> backend version compatibility (flow_sdk/utils/compat.py).

Both directions of the contract are mandatory — a newer version is never
assumed compatible — and the shipped declarations themselves must stay valid:
``flow_sdk/compat.json`` (the backend's desktop floor, included in the wheel)
and ``electron/engine-compat.json`` (the desktop's backend floor). The electron
mirror of the check logic lives in ``electron/engine-compat.js`` with its own
test; this file also cross-checks the two REAL config files so a release can
never ship floors the shared semver cannot compare.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from typer.testing import CliRunner

from flow_sdk import __version__
from flow_sdk.cli.flow_cli import app
from flow_sdk.server import self_update
from flow_sdk.utils import compat
from flow_sdk.utils.semver import string2semver

REPO = Path(__file__).resolve().parents[2]


# ── meets_floor ───────────────────────────────────────────────────────────────

def test_no_floor_is_no_constraint():
    assert compat.meets_floor("0.0.1", None) is True
    assert compat.meets_floor(None, None) is True


@pytest.mark.parametrize(
    ("version", "floor", "expected"),
    [
        ("0.2.50", "0.2.50", True),   # equal passes
        ("0.2.51", "0.2.50", True),
        ("0.3.0", "0.2.50", True),
        ("0.2.49", "0.2.50", False),
        ("0.2.50-rc1", "0.2.50", True),   # extra tag sorts NEWER (shared semver rule)
        ("0.2.49-rc1", "0.2.50", False),  # ...but never jumps a whole patch
    ],
)
def test_floor_comparisons_use_the_shared_semver_ordering(version, floor, expected):
    assert compat.meets_floor(version, floor) is expected


def test_unparseable_sides_are_indeterminate_not_waved_through():
    assert compat.meets_floor("garbage", "0.2.50") is None
    assert compat.meets_floor(None, "0.2.50") is None
    assert compat.meets_floor("0.2.50", "garbage") is None


# ── check_pair: both directions mandatory ─────────────────────────────────────

def test_compatible_pair_passes_both_directions():
    verdict = compat.check_pair(
        desktop_version="0.2.60",
        backend_version="0.2.70",
        min_desktop_version="0.2.60",
        min_backend_version="0.2.50",
    )
    assert verdict.compatible and verdict.reasons == []


def test_backend_requiring_newer_desktop_fails_even_when_backend_is_newer():
    # "Newer" is NOT "compatible": backend 0.2.70 > every floor, yet it demands desktop 0.2.60.
    verdict = compat.check_pair(
        desktop_version="0.2.45",
        backend_version="0.2.70",
        min_desktop_version="0.2.60",
        min_backend_version="0.2.50",
    )
    assert not verdict.compatible
    assert any("requires Desktop 0.2.60" in r for r in verdict.reasons)


def test_backend_below_desktop_floor_fails():
    verdict = compat.check_pair(
        desktop_version="0.2.60",
        backend_version="0.2.40",
        min_desktop_version=None,
        min_backend_version="0.2.50",
    )
    assert not verdict.compatible
    assert any("Backend 0.2.50 or newer" in r for r in verdict.reasons)


def test_both_directions_can_fail_at_once():
    verdict = compat.check_pair(
        desktop_version="0.1.0",
        backend_version="0.1.0",
        min_desktop_version="0.2.0",
        min_backend_version="0.2.0",
    )
    assert not verdict.compatible and len(verdict.reasons) == 2


def test_legacy_pair_without_floors_is_compatible():
    verdict = compat.check_pair(
        desktop_version=None, backend_version="0.2.1",
        min_desktop_version=None, min_backend_version=None,
    )
    assert verdict.compatible


def test_invalid_version_against_a_declared_floor_is_rejected():
    verdict = compat.check_pair(
        desktop_version="not-a-version",
        backend_version="0.2.70",
        min_desktop_version="0.2.60",
        min_backend_version=None,
    )
    assert not verdict.compatible
    assert any("cannot compare" in r for r in verdict.reasons)


# ── the shipped declaration files ─────────────────────────────────────────────

def test_backend_compat_file_is_valid_and_parseable():
    floor = compat.backend_min_desktop_version()
    assert floor is not None, "flow_sdk/compat.json must declare min_desktop_version"
    assert string2semver(floor) is not None


def test_backend_compat_file_ships_in_the_wheel():
    text = (REPO / "pyproject.toml").read_text(encoding="utf-8")
    assert '"compat.json"' in text, "flow_sdk/compat.json must be listed in [tool.setuptools.package-data]"


def test_electron_compat_file_is_valid_and_parseable():
    data = json.loads((REPO / "electron" / "engine-compat.json").read_text(encoding="utf-8"))
    assert isinstance(data, dict)
    floor = data.get("min_backend_version")
    assert isinstance(floor, str) and string2semver(floor) is not None, (
        "electron/engine-compat.json must declare a parseable min_backend_version"
    )


def test_the_current_backend_version_satisfies_the_desktop_floor():
    """A release whose own version is below the desktop's declared floor could never activate."""
    data = json.loads((REPO / "electron" / "engine-compat.json").read_text(encoding="utf-8"))
    assert compat.meets_floor(__version__, data["min_backend_version"]) is True


def test_missing_file_is_the_legacy_policy_and_garbage_is_an_error(tmp_path):
    assert compat.backend_min_desktop_version(tmp_path / "absent.json") is None
    bad = tmp_path / "compat.json"
    bad.write_text("not json", encoding="utf-8")
    with pytest.raises(compat.CompatError):
        compat.backend_min_desktop_version(bad)
    non_object = tmp_path / "list.json"
    non_object.write_text("[1, 2]", encoding="utf-8")
    with pytest.raises(compat.CompatError):
        compat.backend_min_desktop_version(non_object)


def test_unknown_keys_are_ignored_for_forward_extension(tmp_path):
    f = tmp_path / "compat.json"
    f.write_text(json.dumps({"min_desktop_version": "0.2.9", "max_desktop_version": "9.9.9"}), encoding="utf-8")
    assert compat.backend_min_desktop_version(f) == "0.2.9"


# ── desktop constraints from the env (self_update gates) ─────────────────────

def test_headless_backend_is_never_constrained(monkeypatch):
    monkeypatch.delenv(compat.ENV_DESKTOP_VERSION, raising=False)
    monkeypatch.delenv(compat.ENV_DESKTOP_MIN_BACKEND, raising=False)
    assert self_update.desktop_compat_block("0.0.1") is None
    assert self_update.verify_installed_against_desktop() is None


def test_desktop_floor_from_env_blocks_an_older_backend(monkeypatch):
    monkeypatch.setenv(compat.ENV_DESKTOP_VERSION, "0.2.60")
    monkeypatch.setenv(compat.ENV_DESKTOP_MIN_BACKEND, "0.2.50")
    assert self_update.desktop_compat_block("0.2.49") is not None
    assert self_update.desktop_compat_block("0.2.50") is None
    assert self_update.desktop_compat_block("0.2.51") is None
    # Unparseable target against a declared floor: refused, not waved through.
    assert self_update.desktop_compat_block("weird") is not None


def test_verify_installed_against_desktop_reads_the_on_disk_floor(monkeypatch):
    monkeypatch.setenv(compat.ENV_DESKTOP_VERSION, "0.2.45")
    monkeypatch.setattr(self_update, "installed_min_desktop", lambda: "0.2.60")
    reason = self_update.verify_installed_against_desktop()
    assert reason is not None and "0.2.60" in reason

    monkeypatch.setattr(self_update, "installed_min_desktop", lambda: "0.2.40")
    assert self_update.verify_installed_against_desktop() is None

    monkeypatch.setattr(self_update, "installed_min_desktop", lambda: None)  # legacy release
    assert self_update.verify_installed_against_desktop() is None

    def broken():
        raise compat.CompatError("boom")

    monkeypatch.setattr(self_update, "installed_min_desktop", broken)
    assert "invalid" in (self_update.verify_installed_against_desktop() or "")


# ── flow compat (the CLI check) ───────────────────────────────────────────────

def test_flow_compat_passes_a_compatible_desktop():
    out = CliRunner().invoke(app, ["compat", "--desktop-version", "99.0.0"])
    assert out.exit_code == 0, out.output
    assert "Compatible" in out.output


def test_flow_compat_rejects_a_desktop_below_the_backend_floor(monkeypatch):
    from flow_sdk.cli.commands import compat_cmd  # noqa: F401 — force-register the lazy command first

    monkeypatch.setattr(compat, "backend_min_desktop_version", lambda path=None: "0.2.60")
    out = CliRunner().invoke(app, ["compat", "--desktop-version", "0.2.45"])
    assert out.exit_code == 1
    assert "0.2.60" in out.output


def test_flow_compat_checks_the_other_direction_too(monkeypatch):
    monkeypatch.setattr(compat, "backend_min_desktop_version", lambda path=None: None)
    out = CliRunner().invoke(
        app, ["compat", "--desktop-version", "99.0.0", "--desktop-min-backend", "999.0.0", "--json"]
    )
    assert out.exit_code == 1
    data = json.loads(re.search(r"\{.*\}", out.output, re.S).group(0))
    assert data["compatible"] is False
    assert data["backend_version"] == __version__


def test_flow_compat_json_verdict_is_machine_readable():
    out = CliRunner().invoke(app, ["compat", "--desktop-version", "99.0.0", "--json"])
    assert out.exit_code == 0, out.output
    data = json.loads(re.search(r"\{.*\}", out.output, re.S).group(0))
    assert data["compatible"] is True and data["desktop_version"] == "99.0.0"
