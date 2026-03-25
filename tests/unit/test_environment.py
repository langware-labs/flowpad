"""Tests for Environment domain class."""

import importlib

import pytest

from flow_sdk.domain.environment import Environment

_has_shell = importlib.util.find_spec("flow_sdk.domain.shell") is not None


class TestEnvironment:
    def test_load_creates_unsaved_record(self):
        env = Environment.load("/tmp/proj")
        assert env.work_dir == "/tmp/proj"
        assert env.name == "proj"
        assert env.record.record_dir is None

    @pytest.mark.skipif(not _has_shell, reason="Shell not yet implemented")
    def test_createShell_returns_shell(self):
        env = Environment.load("/tmp/proj")
        shell = env.createShell()
        from flow_sdk.domain.shell import Shell
        assert isinstance(shell, Shell)
        assert shell.env is env
