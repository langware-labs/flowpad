"""The session browser: one rule picks it, the manifest stores it, the launch renders it."""

import builtins
import json
import sys
from pathlib import Path

import pytest

from flow_sdk.assets.project_manifest import ManifestError, manifest_path, read_browser, set_browser
from flow_sdk.builtin.agentic_process import browser_choice as bc
from flow_sdk.builtin.agentic_process.cli_drivers.claude.cli import ClaudeAgentOptions
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import ProcessMcpRuntime
from flow_sdk.builtin.agentic_process.cli_drivers.mcp_projection import to_mcp_config_json
from flow_sdk.core.agent_browser import mcp_spec
from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.cli_drivers import get_driver
from flow_sdk.flowpad_types.vendors import VENDORS


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
    opts.browser_extension = chrome
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
        {"timestamp": "t2", "message": {"content": [{"type": "tool_use", "id": "b", "name": "mcp__agent_browser__browser_navigate", "input": {"url": "https://example.com"}}]}},
        {"timestamp": "t3", "message": {"content": [{"type": "tool_result", "tool_use_id": "b", "is_error": True}]}},
    ]
    t.write_text("\n".join(json.dumps(r) for r in rows))
    assert bc.last_browser_use(t) == {"family": "agent", "tool": "browser_navigate", "url": "https://example.com", "at": "t2", "failed": True}
    assert bc.last_browser_use(tmp_path / "missing.jsonl") is None


def test_last_browser_use_codex(tmp_path):
    t = tmp_path / "codex.jsonl"
    item = {"type": "mcp_tool_call", "server": "agent_browser", "tool": "browser_navigate", "arguments": {"url": "https://example.com"}, "error": None, "status": "completed"}
    t.write_text(json.dumps({"type": "item.completed", "item": item}))
    got = bc.last_browser_use(t)
    assert got["family"] == "agent" and got["url"] == "https://example.com" and got["at"]  # mtime stands in


# ── every worker renders the same launch with its own CLI switches ───────────

#: What a launch must never write: the user's own harness configs.
_GLOBAL = (".claude", ".claude.json", ".codex", ".copilot", ".config/opencode")


@pytest.fixture
def no_global_writes(monkeypatch):
    home = Path.home()
    hits: list[str] = []

    def guard(path) -> None:
        rel = str(Path(path).expanduser()).removeprefix(str(home) + "/")
        if any(rel == g or rel.startswith(g + "/") for g in _GLOBAL):
            hits.append(rel)

    real_open, real_write = builtins.open, Path.write_text

    def open_(file, mode="r", *a, **k):
        if any(m in mode for m in "wax+"):
            guard(file)
        return real_open(file, mode, *a, **k)

    def write_text(self, *a, **k):
        guard(self)
        return real_write(self, *a, **k)

    monkeypatch.setattr(builtins, "open", open_)
    monkeypatch.setattr(Path, "write_text", write_text)
    yield hits


@pytest.mark.parametrize("vendor", VENDORS, ids=lambda v: v.key)
@pytest.mark.parametrize("kind", ["agent", "extension"])
def test_each_worker_renders_the_launch_as_cli_switches(vendor, kind, no_global_writes, monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")
    process = AgenticProcess(worker_type=vendor.worker_type, workdir="/repo")
    driver = get_driver(vendor.key)
    opts = driver.cli_options(process)
    opts.session_id = "00000000-0000-4000-8000-000000000000"  # deepagents' runner needs one
    launch = bc.resolve(override=kind, legacy_chrome=False, project_browser="agent", supports_extension=opts.EXTENSION_FLAG is not None)
    runtime = driver.prepare_process_mcp([mcp_spec()] if launch == "agent" else [])
    if launch == "agent":
        runtime = runtime.model_copy(update={"strict": False})
    opts.apply_process_mcp(runtime)
    opts.browser_extension = launch == "extension"
    argv = opts.cli_cmd()

    if kind == "extension" and opts.EXTENSION_FLAG is None:
        assert launch == "agent", "a worker with no extension switch falls back to the agent browser"
    if launch == "extension":
        assert opts.EXTENSION_FLAG in argv and "agent_browser" not in " ".join(argv)
    else:
        rendered = " ".join(map(str, argv)) + json.dumps(runtime.config_fragment)
        assert "agent_browser" in rendered, f"{vendor.key}: the browser server is not in its launch"
        assert not opts.STRICT_MCP_FLAG or opts.STRICT_MCP_FLAG not in argv, "Flowpad's server alone is additive"
    assert not no_global_writes, f"{vendor.key} wrote global config: {no_global_writes}"


def test_scan_extension_finds_the_profile_it_is_installed_in(tmp_path, monkeypatch):
    from flow_sdk.core import browser_profiles as bp

    root = tmp_path / "Google/Chrome"
    (root / "Profile 1/Extensions/ext-id").mkdir(parents=True)
    (root / "Default").mkdir(parents=True)
    state = {"profile": {"info_cache": {"Default": {"name": "Shlomo"}, "Profile 1": {"name": "Work", "user_name": "w@x.com"}}}}
    (root / "Local State").write_text(json.dumps(state))
    monkeypatch.setattr(bp, "_profile_roots", lambda b, os_name: [root] if b.id == "chrome" else [])
    scan = bp.scan_extension("ext-id")
    assert {(p.profile.name, p.installed) for p in scan.profiles} == {("Shlomo", False), ("Work", True)}
    assert not scan.denied
    (root / "Local State").write_text("{}")  # unreadable shape ⇒ unknown, not absent
    assert bp.scan_extension("ext-id").denied


def test_last_browser_use_copilot(tmp_path):
    t = tmp_path / "copilot.jsonl"
    start = {"toolCallId": "c1", "mcpServerName": "agent_browser", "mcpToolName": "browser_navigate", "arguments": {"url": "https://example.com"}}
    rows = [
        {"type": "tool.execution_start", "timestamp": "t1", "data": start},
        {"type": "tool.execution_complete", "timestamp": "t2", "data": {"toolCallId": "c1", "success": False}},
    ]
    t.write_text("\n".join(json.dumps(r) for r in rows))
    assert bc.last_browser_use(t) == {"family": "agent", "tool": "browser_navigate", "url": "https://example.com", "at": "t1", "failed": True}
