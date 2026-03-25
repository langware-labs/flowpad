"""Tests for WorkerCLICommand base class — cross-platform shell string building."""

import sys
import pytest
from unittest.mock import patch

from flow_sdk.builtin.cli_workers.base import WorkerCLICommand


# Minimal concrete subclass for testing the base
class _EchoCmd(WorkerCLICommand):
    def _build_worker_args(self) -> list[str]:
        return ["myworker", "--flag"]


# ─── POSIX tests ─────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def force_posix(monkeypatch):
    """Force POSIX path in all tests unless test patches sys.platform itself."""
    monkeypatch.setattr(sys, "platform", "linux")


def test_workdir_cd_posix():
    cmd = _EchoCmd(workdir="/my/project")
    result = cmd.to_shell_string()
    assert "cd " in result and "/my/project" in result
    assert "&&" in result


def test_posix_env_prefix():
    cmd = _EchoCmd(workdir="/proj", env_vars={"FOO": "bar", "BAZ": "qux"})
    result = cmd.to_shell_string()
    assert "FOO=bar" in result
    assert "BAZ=qux" in result


def test_posix_env_special_chars_quoted():
    cmd = _EchoCmd(workdir="/proj", env_vars={"KEY": "val with spaces"})
    result = cmd.to_shell_string()
    assert "KEY='val with spaces'" in result


def test_posix_worker_args_present():
    cmd = _EchoCmd(workdir="/proj")
    result = cmd.to_shell_string()
    assert "myworker" in result
    assert "--flag" in result


def test_instruction_single_line_posix():
    cmd = _EchoCmd(workdir="/proj")
    result = cmd.to_shell_string(instruction="fix the bug")
    assert "'fix the bug'" in result


def test_instruction_multiline_posix():
    cmd = _EchoCmd(workdir="/proj")
    result = cmd.to_shell_string(instruction="line one\nline two")
    assert "EOF" in result
    assert "line one" in result
    assert "line two" in result


def test_no_instruction_posix():
    cmd = _EchoCmd(workdir="/proj")
    result = cmd.to_shell_string()
    # command ends after worker args — no stray quotes
    assert result.endswith("myworker --flag")


def test_no_workdir_defaults_to_dot():
    cmd = _EchoCmd()
    result = cmd.to_shell_string()
    assert result.startswith("cd ")


# ─── Win32 tests ─────────────────────────────────────────────────────────────


def test_workdir_cd_win32(monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    cmd = _EchoCmd(workdir="C:\\Users\\foo")
    result = cmd.to_shell_string()
    assert "cd " in result and "C:\\Users\\foo" in result
    assert ";" in result


def test_win32_env_prefix(monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    cmd = _EchoCmd(workdir="C:\\proj", env_vars={"FOO": "bar"})
    result = cmd.to_shell_string()
    assert "$env:FOO = 'bar'" in result


def test_instruction_win32_base64(monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    cmd = _EchoCmd(workdir="C:\\proj")
    result = cmd.to_shell_string(instruction="hello world")
    assert "FromBase64String" in result
    assert "UTF8.GetString" in result


# ─── add_env ─────────────────────────────────────────────────────────────────


def test_add_env_mutates():
    cmd = _EchoCmd()
    cmd.add_env("MY_KEY", "my_val")
    assert cmd.env_vars["MY_KEY"] == "my_val"


def test_add_env_overwrites():
    cmd = _EchoCmd(env_vars={"K": "old"})
    cmd.add_env("K", "new")
    assert cmd.env_vars["K"] == "new"


def test_add_env_appears_in_string():
    cmd = _EchoCmd(workdir="/proj")
    cmd.add_env("RUNTIME_VAR", "runtime_val")
    result = cmd.to_shell_string()
    assert "RUNTIME_VAR=runtime_val" in result


# ─── Serialisation ───────────────────────────────────────────────────────────


def test_from_to_json_roundtrip():
    cmd = _EchoCmd(workdir="/proj", env_vars={"A": "1"})
    d = cmd.to_json()
    loaded = _EchoCmd.from_json(d)
    assert loaded.workdir == "/proj"
    assert loaded.env_vars == {"A": "1"}


def test_to_json_contains_workdir_and_env():
    cmd = _EchoCmd(workdir="/x", env_vars={"E": "v"})
    d = cmd.to_json()
    assert d["workdir"] == "/x"
    assert d["env_vars"] == {"E": "v"}
