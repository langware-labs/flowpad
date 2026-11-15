"""The session browser: one rule picks it, the manifest stores it, the launch renders it."""

import json

import pytest

from flow_sdk.assets.project_manifest import ManifestError, manifest_path, read_browser, set_browser
from flow_sdk.builtin.agentic_process import browser_choice as bc
from flow_sdk.builtin.agentic_process.cli_drivers.claude.cli import ClaudeAgentOptions
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import ProcessMcpRuntime
from flow_sdk.builtin.agentic_process.cli_drivers.mcp_projection import to_mcp_config_json
from flow_sdk.core.agent_browser import mcp_spec


@pytest.mark.parametrize(
    ("override", "legacy", "project", "ext", "want"),
    [
        (None, False, "agent", True, "agent"),
        (None, False, "extension", True, "extension"),
        ("agent", False, "extension", True, "agent"),  # the session wins
        (None, True, "agent", True, "extension"),  # a caller that asked for --chrome
        (None, False, "extension", False, "agent"),  # no extension on this harness
        ("bogus", False, "nonsense", True, "agent"),
    ],
)
def test_resolve(override, legacy, project, ext, want):
    assert bc.resolve(override=override, legacy_chrome=legacy, project_browser=project, supports_extension=ext) == want


def test_manifest_default_is_silent(tmp_path):
    assert read_browser(tmp_path) == "agent"
    set_browser(tmp_path, "extension")
    assert json.loads(manifest_path(tmp_path).read_text())["browser"] == "extension"
    set_browser(tmp_path, "agent")
    assert "browser" not in json.loads(manifest_path(tmp_path).read_text())
    with pytest.raises(ManifestError):
        set_browser(tmp_path, "safari")


def _flags(runtime=None, chrome=False):
    opts = ClaudeAgentOptions()
    if runtime is not None:
        opts.apply_process_mcp(runtime)
    opts.chrome = chrome
    return opts._emit_flags()


def test_agent_browser_adds_to_user_servers_without_strict():
    flags = _flags(ProcessMcpRuntime(mcp_config_json=to_mcp_config_json([mcp_spec()]), strict=False))
    assert "--mcp-config" in flags and "--strict-mcp-config" not in flags and "--chrome" not in flags


def test_extension_is_chrome_flag_only():
    flags = _flags(chrome=True)
    assert "--chrome" in flags and "--mcp-config" not in flags


def test_last_browser_use(tmp_path):
    t = tmp_path / "s.jsonl"
    rows = [
        {"timestamp": "t1", "message": {"content": [{"type": "tool_use", "id": "a", "name": "Bash", "input": {}}]}},
        {"timestamp": "t2", "message": {"content": [{"type": "tool_use", "id": "b", "name": "mcp__browser__browser_navigate", "input": {"url": "https://example.com"}}]}},
        {"timestamp": "t3", "message": {"content": [{"type": "tool_result", "tool_use_id": "b", "is_error": True}]}},
    ]
    t.write_text("\n".join(json.dumps(r) for r in rows))
    assert bc.last_browser_use(t) == {"family": "agent", "tool": "browser_navigate", "url": "https://example.com", "at": "t2", "failed": True}
    assert bc.last_browser_use(tmp_path / "missing.jsonl") is None


def test_last_browser_use_codex(tmp_path):
    t = tmp_path / "codex.jsonl"
    item = {"type": "mcp_tool_call", "server": "browser", "tool": "browser_navigate", "arguments": {"url": "https://example.com"}, "error": None, "status": "completed"}
    t.write_text(json.dumps({"type": "item.completed", "item": item}))
    got = bc.last_browser_use(t)
    assert got["family"] == "agent" and got["url"] == "https://example.com" and got["at"]  # mtime stands in
