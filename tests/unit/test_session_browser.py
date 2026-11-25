"""The session browser: one rule picks it, the manifest stores it, the launch renders it."""

import builtins
import io
import json
import sys
from pathlib import Path

import pytest

from flow_sdk.assets.project_manifest import ManifestError, manifest_path, read_browser, set_browser
from flow_sdk.builtin.agentic_process import browser_choice as bc
from flow_sdk.builtin.agentic_process.cli_drivers.claude.cli import ClaudeAgentOptions
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import ProcessMcpRuntime
from flow_sdk.builtin.agentic_process.cli_drivers.mcp_projection import to_mcp_config_json
from flow_sdk.core import agent_browser as ab
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
    assert bc.resolve(override=override, legacy_chrome=legacy, project_browser=project, worker="claude", has_switch=ext) == want


def test_the_sessions_own_browser_wins_and_says_so():
    """session > project default (pick) > project > default; the harness cap still applies, and the answer names its rung."""
    ask = dict(override=None, legacy_chrome=False, project_browser="agent", worker="claude", has_switch=True)
    picked = bc.decide(**ask, pick="extension")
    assert (picked.kind, picked.source, picked.extension) == ("extension", "pick", True)
    own = bc.decide(**{**ask, "override": "chrome_debug"}, pick="extension")
    assert (own.kind, own.source) == ("chrome_debug", "session"), "what a channel or `flow browser select` set wins over the default"
    assert bc.decide(**ask, pick="bogus").source == "default", "a pick that names no browser is no pick"
    assert bc.decide(**{**ask, "project_browser": "extension"}).source == "project"
    capped = bc.decide(**{**ask, "worker": "codex", "has_switch": False}, pick="extension")
    assert (capped.kind, capped.source, capped.requested) == ("agent", "default", "extension"), "and it says what was asked"
    debug = bc.decide(**{**ask, "worker": "codex", "has_switch": False}, pick="chrome_debug")
    assert (debug.kind, debug.extension, debug.mcp_spec().name) == ("chrome_debug", False, "chrome_debug")


def test_a_choice_may_name_one_profile():
    """A browser kind is a choice too: the driver is read off it, and the launch keeps the profile."""
    from flow_sdk.core import browser_drivers as bd

    assert [bd.driver_of(value) for value in (
        "extension", "chrome.extension.name.Profile 2", "canary.cdp.name.chrome_debug-default", "chrome.cdp.name.agent-default",
        "chrome.cdp.name.nobody-default", "chrome.extension", "",
    )] == ["extension", "extension", "chrome_debug", "agent", "", "", ""]
    launch = bc.decide(override="chrome.extension.name.Profile 2", legacy_chrome=False, project_browser="agent", worker="claude", has_switch=True)
    assert (launch.kind, launch.chosen, launch.source) == ("extension", "chrome.extension.name.Profile 2", "session")
    with pytest.raises(ValueError):
        bc.known_browser("chrome.extension.name.")


def test_a_session_keeps_its_first_decision():
    """The first launch's browser becomes the session's own, so a later project default does not move it."""
    process = AgenticProcess(context_data={"other": 1})
    assert bc.keep_choice(process, "chrome.extension.name.Default") and not bc.keep_choice(process, "chrome.extension.name.Default")
    assert process.context_data == {"other": 1, "browser": "chrome.extension.name.Default"}
    later = bc.decide(override=process.context_data["browser"], pick="agent", legacy_chrome=False, project_browser="agent",
                      worker="claude", has_switch=True)
    assert (later.kind, later.source) == ("extension", "session")
    assert bc.keep_choice(process, "") and process.context_data == {"other": 1}


def test_the_state_word_is_decided_once_on_the_backend(monkeypatch):
    """What a menu shows for a driver, per worker — read without starting anything."""
    from flow_sdk.core import agent_browser, browser_drivers as bd

    monkeypatch.setattr(agent_browser, "status", lambda instance=None, driver="agent": agent_browser.AgentBrowserStatus(up=driver == "agent"))
    monkeypatch.setattr(agent_browser, "executable_for", lambda driver="agent": None if driver == "chrome_debug" else "/bin/chrome")
    assert [bd.state_of(name, "codex") for name in ("agent", "chrome_debug", "extension")] == ["running", "not_installed", "unsupported"]
    ext = lambda **k: bd.state_of("extension", "claude", has_switch=True, **k)  # noqa: E731
    assert ext() == "not_installed"
    assert ext(extension_installed=True) == "not_connected"
    assert ext(extension_installed=True, in_use=True) == "connected"
    assert ext(last_use={"family": "extension", "failed": False}) == "connected", "a session's own call proves it"
    assert ext(extension_installed=True, in_use=True, last_use={"family": "extension", "failed": True}) == "not_connected"


def test_a_browser_is_a_folder(tmp_path, monkeypatch):
    """A driver nothing in the code names: its folder alone makes it listed, pickable, attached with
    its own server (config filled in) and limited to the workers it declares."""
    from flow_sdk.core import browser_drivers as bd

    root = tmp_path / "browser_driver"
    for name in ("agent", "lynx"):
        (root / name).mkdir(parents=True)
    (root / "agent" / "browser_driver.json").write_text((bd.SHIPPED_ROOT / "agent" / "browser_driver.json").read_text())
    (root / "lynx" / "browser_driver.json").write_text(json.dumps({
        "name": "lynx", "title": "Lynx", "workers": {"codex": {"setup": "install lynx"}},
        "mcp": {"name": "lynx", "command": "lynx-mcp", "args": ["--port", "{port}", "--as", "{driver}"]},
        "config_fields": [{"name": "port"}], "defaults": {"port": "7000"}, "tool_prefixes": ["mcp__lynx__"],
    }))
    (root / "lynx" / "instructions.md").write_text("# Your browser\n\nLynx.")
    monkeypatch.setattr(bd, "SHIPPED_ROOT", root)
    bd._registry.cache_clear()
    prefs: dict = {}
    monkeypatch.setattr("flow_sdk.preferences.read_instance_pref", lambda key, default: prefs.get(key, default))
    monkeypatch.setattr("flow_sdk.preferences.write_instance_pref", lambda key, value: prefs.__setitem__(key, value) or True)
    try:
        assert bd.names() == ("agent", "lynx")
        ask = dict(override=None, legacy_chrome=False, project_browser="agent", pick="lynx")
        on_codex = bc.decide(**ask, worker="codex")
        assert (on_codex.kind, on_codex.instructions(), bc._family("mcp__lynx__open")) == ("lynx", "# Your browser\n\nLynx.", "lynx")
        assert on_codex.mcp_spec().args == ["--port", "7000", "--as", "lynx"]
        bd.write_config("lynx", {"port": "7100"})
        assert bc.decide(**ask, worker="codex").mcp_spec().args[1] == "7100", "a saved setting fills the server's arguments"
        with pytest.raises(bd.BrowserConfigError):
            bd.write_config("lynx", {"port": "80"})
        on_claude = bc.decide(**ask, worker="claude")
        assert (on_claude.kind, on_claude.requested) == ("agent", "lynx"), "a worker it does not name gets the default"
        assert bd.state_of("lynx", "claude") == "unsupported"
    finally:
        bd._registry.cache_clear()


def test_a_pick_is_saved_on_this_instance_only(tmp_path, monkeypatch):
    prefs: dict = {}
    monkeypatch.setattr("flow_sdk.preferences.read_instance_pref", lambda key, default: prefs.get(key, default))
    monkeypatch.setattr("flow_sdk.preferences.write_instance_pref", lambda key, value: prefs.__setitem__(key, value) or True)
    bc.set_browser_pick("p1", "extension")
    assert (bc.browser_pick("p1"), bc.browser_pick("p2")) == ("extension", "")
    assert read_browser(tmp_path) == "agent" and not manifest_path(tmp_path).exists()
    bc.set_browser_pick("p1", "")
    assert bc.browser_pick("p1") == ""
    with pytest.raises(ValueError):
        bc.set_browser_pick("p1", "safari")


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
    launch = bc.resolve(override=kind, legacy_chrome=False, project_browser="agent", worker=vendor.key, has_switch=opts.EXTENSION_FLAG is not None)
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
    (root / "Profile 1/History").write_text("")
    blind = bp.scan_extension("ext-id")
    assert blind.denied
    by_folder = {p.profile.id: p for p in blind.profiles}
    assert {k: (p.profile.name, p.installed) for k, p in by_folder.items()} == {
        "Default": ("Default", False), "Profile 1": ("Profile 1", True)}, "an unreadable list is read off the folders"
    assert by_folder["Profile 1"].profile.last_used and not by_folder["Default"].profile.last_used


def test_the_kinds_are_one_per_profile(tmp_path, monkeypatch):
    """The list the footer menu and `flow browser list` share: a managed driver's own window, and
    one entry per real profile for the driver that rides the worker's extension."""
    from flow_sdk.core import agent_browser, browser_drivers as bd, browser_profiles as bp

    root = tmp_path / "Google/Chrome"
    (root / "Profile 2/Extensions/ext-id").mkdir(parents=True)
    (root / "Default").mkdir(parents=True)
    (root / "Local State").write_text(json.dumps({"profile": {"info_cache": {"Default": {"name": "Home"}, "Profile 2": {"name": "Work"}}}}))
    monkeypatch.setattr(bp, "_profile_roots", lambda b, os_name: [root] if b.id == "chrome" else [])
    monkeypatch.setattr(bp, "app_binary", lambda app, os_name=None: "/bin/chrome" if app == "chrome" else None)
    monkeypatch.setattr(agent_browser, "profile_dir", lambda driver="agent", instance=None: tmp_path / driver)
    monkeypatch.setattr(bd, "read_config", lambda name: {"app": "", "profile": "default"})

    states = {"agent": "ready", "chrome_debug": "ready", "extension": "not_connected"}
    scan = bp.scan_extension("ext-id")
    kinds = bd.list_kinds(states, scan)
    assert {k.kind: (k.name, k.driver, k.state) for k in kinds} == {
        "chrome.cdp.name.agent-default": ("Flowpad integrated browser", "agent", "ready"),
        "chrome.cdp.name.chrome_debug-default": ("Chrome debug", "chrome_debug", "ready"),
        "chrome.extension.name.Default": ("Home", "extension", "not_installed"),
        "chrome.extension.name.Profile 2": ("Work", "extension", "not_connected"),
    }

    # What this machine keeps about a kind: the person's own name for it, and a reported failure.
    saved: dict = {}
    monkeypatch.setattr(bd, "_kind_prefs", lambda: (dict(saved.get(bd.PREF_NAMES, {})), dict(saved.get(bd.PREF_ERRORS, {}))))
    monkeypatch.setattr("flow_sdk.preferences.write_instance_pref", lambda key, value: saved.__setitem__(key, value))
    work = "chrome.extension.name.Profile 2"
    bd.rename_kind(work, " LinkedIn ")
    bd.report_error(work, "signed out")
    bd.report_error("chrome.extension.name.Default", "ignored: nothing to fail there")
    after = {k.kind: (k.name, k.state, k.error) for k in bd.list_kinds(states, scan)}
    assert after[work] == ("LinkedIn", "error", "signed out"), "renaming never changes the kind"
    assert after["chrome.extension.name.Default"] == ("Home", "not_installed", "")
    state_of_work = lambda **k: {x.kind: x.state for x in bd.list_kinds(states, scan, **k)}[work]  # noqa: E731
    assert state_of_work(proven=(work, "2999-01-01T00:00:00Z")) == "not_connected", "a later call that worked ends it"
    assert state_of_work(proven=(work, "2000-01-01T00:00:00Z")) == "error", "an earlier one does not"
    bd.report_error(work, "")
    assert state_of_work() == "not_connected"


def test_last_browser_use_opencode_and_deepagents(tmp_path):
    """OpenCode names a tool ``<server>_<tool>``; Deep Agents names it bare, so the session's own driver is credited."""
    oc = tmp_path / "opencode_transcript.jsonl"
    oc.write_text(json.dumps({"type": "tool_use", "timestamp": 1795208705729, "part": {
        "type": "tool", "tool": "chrome_debug_browser_navigate", "state": {"status": "completed", "input": {"url": "https://a.example"}}}}) + "\n")
    use = bc.last_browser_use(oc)
    assert (use["family"], use["url"], use["failed"], use["at"][:4]) == ("chrome_debug", "https://a.example", False, "2026")
    da = tmp_path / "deepagents_transcript.jsonl"
    da.write_text("".join(json.dumps(r) + "\n" for r in (
        {"type": "tool_call", "timestamp": "2026-11-20T21:05:13+00:00", "tool_call_id": "t1", "name": "browser_navigate", "input": {"url": "https://b.example"}},
        {"type": "tool_result", "tool_call_id": "t1", "name": "browser_navigate", "is_error": True},
    )))
    assert bc.last_browser_use(da) is None, "a bare name belongs to no driver by itself"
    use = bc.last_browser_use(da, unnamed="agent")
    assert (use["family"], use["url"], use["failed"]) == ("agent", "https://b.example", True)


def test_last_browser_use_copilot(tmp_path):
    t = tmp_path / "copilot.jsonl"
    start = {"toolCallId": "c1", "mcpServerName": "agent_browser", "mcpToolName": "browser_navigate", "arguments": {"url": "https://example.com"}}
    rows = [
        {"type": "tool.execution_start", "timestamp": "t1", "data": start},
        {"type": "tool.execution_complete", "timestamp": "t2", "data": {"toolCallId": "c1", "success": False}},
    ]
    t.write_text("\n".join(json.dumps(r) for r in rows))
    assert bc.last_browser_use(t) == {"family": "agent", "tool": "browser_navigate", "url": "https://example.com", "at": "t1", "failed": True}


class _FakeChild:
    def __init__(self):
        self.sent = []
        self.stdin = self
        self.stdout = iter(['{"jsonrpc":"2.0","id":"proxy-init","result":{}}\n'])

    def write(self, s):
        self.sent.append(json.loads(s))

    def flush(self):
        pass

    def close(self):
        pass

    def wait(self):
        return 0


def _serve(monkeypatch, tmp_path, lines, ensure):
    spawned = []
    monkeypatch.setattr(ab, "_base_dir", lambda instance=None: tmp_path)
    (tmp_path / "tools.json").write_text(json.dumps({"server": ab.PLAYWRIGHT_MCP, "tools": [{"name": "browser_navigate"}]}))
    monkeypatch.setattr(ab, "ensure_running", ensure)
    monkeypatch.setattr(ab, "_spawn_playwright", lambda port: spawned.append(_FakeChild()) or spawned[-1])
    out = io.StringIO()
    ab.serve(io.StringIO("".join(json.dumps(m) + "\n" for m in lines)), out)
    return [json.loads(x) for x in out.getvalue().splitlines()], spawned


_INIT = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26"}}
_CALL = {"jsonrpc": "2.0", "method": "tools/call", "params": {"name": "browser_navigate", "arguments": {"url": "x"}}}


def test_agent_browser_list_opens_no_window(monkeypatch, tmp_path):
    def ensure(**_):
        raise AssertionError("no window before the first call")

    replies, spawned = _serve(monkeypatch, tmp_path, [_INIT, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}], ensure)
    assert replies[1]["result"]["tools"] == [{"name": "browser_navigate"}] and not spawned


def test_agent_browser_first_call_starts_it_once(monkeypatch, tmp_path):
    calls = []
    ensure = lambda **_: calls.append(1) or ab.AgentBrowserStatus(up=True, port=1234)  # noqa: E731
    _, spawned = _serve(monkeypatch, tmp_path, [_INIT, {**_CALL, "id": 3}, {**_CALL, "id": 4}], ensure)
    assert calls == [1] and len(spawned) == 1
    assert [m.get("id") for m in spawned[0].sent] == ["proxy-init", None, 3, 4]


def test_agent_browser_start_failure_is_a_tool_error(monkeypatch, tmp_path):
    def ensure(**_):
        raise ab.AgentBrowserError("NO_BROWSER: neither Chrome nor Edge is installed")

    replies, _ = _serve(monkeypatch, tmp_path, [_INIT, {**_CALL, "id": 3}, {"jsonrpc": "2.0", "id": 5, "method": "ping"}], ensure)
    assert replies[1]["result"]["isError"] and "NO_BROWSER" in replies[1]["result"]["content"][0]["text"]
    assert replies[2] == {"jsonrpc": "2.0", "id": 5, "result": {}}  # still serving
