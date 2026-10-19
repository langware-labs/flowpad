"""Headless dependency Load never turns an ordinary invocation into setup approval."""
from __future__ import annotations

import json

import pytest
from typer.testing import CliRunner

from flow_sdk.cli.commands import dep_cmd


@pytest.mark.parametrize("approve", [False, True])
def test_load_passes_only_explicit_approval_and_reports_setup_required(monkeypatch, approve):
    calls = []
    monkeypatch.setattr(dep_cmd, "discover_port", lambda **_kw: 1234)
    monkeypatch.setattr(dep_cmd, "get_graph_json", lambda *_a, **_kw: {
        "dependencies": [{"name": "service", "project_id": "provider"}],
    })

    def post(url, body, **_kw):
        calls.append((url, body))
        return {"state": "running" if approve else "setup_required", "project_id": "provider", "detail": "Install required"}

    monkeypatch.setattr(dep_cmd, "post_graph_json", post)
    args = ["load", "service", "--project", "consumer"] + (["--approve"] if approve else [])
    result = CliRunner().invoke(dep_cmd.dep_app, args)
    assert result.exit_code == (0 if approve else 1), result.output
    assert len(calls) == 1 and calls[0][0].endswith("/project/provider/load")
    assert calls[0][1] == {"approved": approve}
    if not approve:
        assert json.loads(result.output.splitlines()[-1])["error_code"] == "SETUP_REQUIRED"
