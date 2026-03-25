"""Tests for --agents flag plumbing in agentic_processor."""

import json
from unittest import mock

import pytest

from flow_sdk.builtin.agentic_processor import ContextData


class TestContextDataAgentsJson:
    def test_agents_json_field_default_none(self):
        ctx = ContextData()
        assert ctx.agents_json is None

    def test_agents_json_field_set(self):
        agents = {"analyzer": {"description": "Analyze", "prompt": "Do it"}}
        ctx = ContextData(agents_json=agents)
        assert ctx.agents_json == agents
        assert ctx.agents_json["analyzer"]["description"] == "Analyze"

    def test_agents_json_serializes(self):
        agents = {"test-agent": {"description": "Test", "model": "sonnet"}}
        ctx = ContextData(agents_json=agents)
        data = ctx.model_dump()
        assert data["agents_json"] == agents

    def test_agents_json_in_context_data_dict(self):
        """Verify agents_json passes through when context_data is used as a dict."""
        agents = {"my-agent": {"description": "Desc", "prompt": "Prompt"}}
        context_data = {
            "workdir": "/tmp",
            "permission_mode": "bypassPermissions",
            "agents_json": agents,
        }
        # Simulate what _run_claude_subprocess does
        agents_json = context_data.get("agents_json")
        assert agents_json is not None
        args = []
        if agents_json:
            args.extend(["--agents", json.dumps(agents_json)])
        assert "--agents" in args
        parsed = json.loads(args[1])
        assert "my-agent" in parsed
