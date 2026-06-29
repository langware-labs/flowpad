"""Step 10: _validate_watch_path — reject paths outside the allowlist.

The allowlist prevents accidental "/etc/hosts" style mistakes. Allowed roots:
  - User's HOME (~/.flow, ~/Documents, anywhere under home)
  - /tmp (and macOS /private/var/folders/.../T/ which is symlinked from /tmp)

Validation runs at trigger save time. None / empty watch_path is allowed (e.g.,
during construction-time defaults before configuration completes).
"""
from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.builtin.trigger import Trigger, TriggerType, _validate_watch_path


# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)


# ── basic acceptance ─────────────────────────────────────────────────────────


def test_none_path_allowed():
    """None / empty paths are allowed (trigger may be partially constructed)."""
    _validate_watch_path(None)  # must not raise


def test_empty_path_allowed():
    _validate_watch_path("")


def test_home_subpath_allowed(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    _validate_watch_path(str(tmp_path / "flow" / "instances" / "alice" / "toplog.json"))


def test_tmp_path_allowed(tmp_path):
    """tmp_path is under /private/var/folders on macOS or /tmp on Linux — both allowed."""
    _validate_watch_path(str(tmp_path / "test.txt"))


# ── rejection ────────────────────────────────────────────────────────────────


def test_etc_hosts_rejected():
    with pytest.raises(ValueError, match="not in allowlist"):
        _validate_watch_path("/etc/hosts")


def test_var_log_rejected():
    with pytest.raises(ValueError, match="not in allowlist"):
        _validate_watch_path("/var/log/syslog")


def test_root_rejected():
    with pytest.raises(ValueError, match="not in allowlist"):
        _validate_watch_path("/")


# ── relative paths ───────────────────────────────────────────────────────────


def test_relative_path_resolved_and_validated(monkeypatch, tmp_path):
    """Relative paths get resolved against cwd, then checked."""
    monkeypatch.chdir(tmp_path)
    # Relative path under tmp_path (allowlist match) → ok
    _validate_watch_path("foo.txt")


# ── integration with Trigger ────────────────────────────────────────────────


def test_trigger_create_with_allowlisted_path_ok(tmp_path):
    t = Trigger(
        name="t",
        trigger_type=TriggerType.FSOP,
        watch_path=str(tmp_path / "x.txt"),
    )
    # Manually invoke validation to confirm it doesn't raise (entity construction
    # doesn't auto-validate paths in v1 — validation is called at save time).
    _validate_watch_path(t.watch_path)


def test_validation_disallowed_path_raises():
    with pytest.raises(ValueError):
        _validate_watch_path("/etc/passwd")
