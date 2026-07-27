"""Tests for named-instance lifecycle commands."""

from __future__ import annotations

import json

from typer.testing import CliRunner

from flow_sdk.cli.commands import instance_cmd

runner = CliRunner()


def test_restart_backend_reaps_owned_processes_and_preserves_state(monkeypatch, tmp_path):
    instance_dir = tmp_path / "qa-owned"
    instance_dir.mkdir()
    launcher_path = instance_dir / "launcher.json"
    launcher_path.write_text(json.dumps({"backend_pid": 101, "frontend_pid": 202}))
    (instance_dir / "server.json").write_text(json.dumps({"server_pid": 303}))
    state_path = instance_dir / "flow.db"
    state_path.write_text("must survive")

    monkeypatch.setattr(instance_cmd, "_instance_dir", lambda _name: instance_dir)
    monkeypatch.setattr(
        instance_cmd,
        "_kill_instance_processes",
        lambda name, *, backend_only: [101, 303]
        if name == "qa-owned" and backend_only
        else [],
    )
    monkeypatch.setattr(instance_cmd, "_relaunch_backend_only", lambda _name: 404)

    result = runner.invoke(
        instance_cmd.instance_app,
        ["restart-backend", "qa-owned", "--json"],
    )

    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["killed_pids"] == [101, 303]
    assert json.loads(launcher_path.read_text())["backend_pid"] == 404
    assert state_path.read_text() == "must survive"
    assert (instance_dir / ".backend-restart-requested").read_text() == "303"


def test_restart_backend_does_not_relaunch_when_reap_fails(monkeypatch, tmp_path):
    relaunched = []

    def fail_reap(_name, *, backend_only):
        assert backend_only is True
        raise RuntimeError("owned process survived")

    monkeypatch.setattr(instance_cmd, "_kill_instance_processes", fail_reap)
    monkeypatch.setattr(instance_cmd, "_instance_dir", lambda _name: tmp_path)
    (tmp_path / "server.json").write_text(json.dumps({"server_pid": 101}))
    monkeypatch.setattr(
        instance_cmd,
        "_relaunch_backend_only",
        lambda name: relaunched.append(name),
    )

    result = runner.invoke(instance_cmd.instance_app, ["restart-backend", "qa-owned"])

    assert result.exit_code != 0
    assert relaunched == []
    assert not (tmp_path / ".backend-restart-requested").exists()


def test_restart_backend_requires_recorded_server_generation(
    monkeypatch,
    tmp_path,
):
    monkeypatch.setattr(instance_cmd, "_instance_dir", lambda _name: tmp_path)
    killed = []
    monkeypatch.setattr(
        instance_cmd,
        "_kill_instance_processes",
        lambda *args, **kwargs: killed.append((args, kwargs)),
    )

    result = runner.invoke(
        instance_cmd.instance_app,
        ["restart-backend", "qa-owned"],
    )

    assert result.exit_code != 0
    assert killed == []
    assert not (tmp_path / ".backend-restart-requested").exists()
