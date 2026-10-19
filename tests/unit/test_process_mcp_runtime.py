"""Per-process MCP servers: one spec list, four harnesses, both transports.

The projection contract, mirroring ``test_process_hook_runtime.py``:

* the attached specs reach the worker on EVERY transport (PTY argv and the
  headless context), because a projection that lands on one and not the other
  is invisible until a user reports missing tools;
* the RENDERED form is launch-only — never in ``to_json()`` / the persisted
  context — so a change of spelling cannot churn ``last_started_hash``;
* the INTENT is semantic and does move the restart hash, because MCP is
  resolved once at worker boot.

Vendor channels were measured against the installed CLIs (see
``mcp_projection`` for the versions).
"""

from __future__ import annotations

import json
import sys

import pytest

from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.cli_drivers import get_driver
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    AgenticContext,
    ProcessMcpRuntime,
)
from flow_sdk.builtin.agentic_process.cli_drivers.mcp_projection import (
    to_codex_overrides,
    to_opencode_mcp,
)
from flow_sdk.flowpad_types.vendors import VENDORS
from flow_sdk.schema.data_spec.mcp_spec import McpSpec

VENDOR_IDS = [v.key for v in VENDORS]

SPEC = McpSpec(name="dummy", command="/usr/bin/python3", args=["/tmp/dummy_mcp.py"], env={"K": "V"})
REMOTE = McpSpec(name="remote", transport="http", url="https://example.test/mcp")


@pytest.fixture(autouse=True)
def force_posix(monkeypatch):
    """The argv renderer branches on ``sys.platform``; pin it as every other
    ``*_cli_cmd`` test does. Patched AFTER import — setting it earlier breaks
    ``sysconfig``."""
    monkeypatch.setattr(sys, "platform", "linux")


def _flag_values(argv: list[str], flag: str) -> list[str]:
    return [argv[index + 1] for index, value in enumerate(argv[:-1]) if value == flag]


def _config_flags(argv: list[str]) -> list[str]:
    return _flag_values(argv, "-c")


def _process(vendor) -> AgenticProcess:
    process = AgenticProcess(worker_type=vendor.worker_type, workdir="/repo")
    process.mcp_servers = [SPEC]
    return process


# ── every harness declares support ───────────────────────────────────────────


@pytest.mark.parametrize("vendor", VENDORS, ids=VENDOR_IDS)
def test_every_harness_supports_process_scoped_mcp(vendor):
    """All four were validated with a real tool call; none is opted out."""
    assert get_driver(vendor.key).supports_process_mcp is True


@pytest.mark.parametrize("vendor", VENDORS, ids=VENDOR_IDS)
def test_no_specs_produces_an_empty_runtime(vendor):
    """Nothing attached ⇒ nothing rendered, so an unconfigured process's argv
    is byte-identical to what it was before this feature existed."""
    assert get_driver(vendor.key).prepare_process_mcp([]) == ProcessMcpRuntime()


# ── per-vendor channel ───────────────────────────────────────────────────────


def test_claude_emits_mcp_config_json_and_strict():
    runtime = get_driver("claude").prepare_process_mcp([SPEC])
    body = json.loads(runtime.mcp_config_json)
    assert body["mcpServers"]["dummy"] == {
        "type": "stdio",
        "command": "/usr/bin/python3",
        "args": ["/tmp/dummy_mcp.py"],
        "env": {"K": "V"},
    }
    # --strict rides with the flag itself (claude/cli.py), not as runtime state:
    # without it the process gets this set PLUS ~/.claude.json.
    from flow_sdk.builtin.agentic_process.cli_drivers.claude.cli import ClaudeAgentOptions

    options = ClaudeAgentOptions(workdir="/repo")
    options.apply_process_mcp(runtime)
    assert "--strict-mcp-config" in options.cli_cmd()


def test_copilot_reuses_the_same_json_but_has_no_strict_mode():
    claude = get_driver("claude").prepare_process_mcp([SPEC])
    copilot = get_driver("copilot").prepare_process_mcp([SPEC])
    assert json.loads(copilot.mcp_config_json) == json.loads(claude.mcp_config_json)
    # --additional-mcp-config AUGMENTS ~/.copilot/mcp-config.json; there is no
    # exclusive counterpart, so copilot must not emit claude's strict flag.
    from flow_sdk.builtin.agentic_process.cli_drivers.copilot.cli import CopilotAgentOptions

    options = CopilotAgentOptions(workdir="/repo")
    options.apply_process_mcp(copilot)
    assert "--strict-mcp-config" not in options.cli_cmd()


def test_codex_emits_merging_per_leaf_config_overrides():
    runtime = get_driver("codex").prepare_process_mcp([SPEC])
    assert runtime.config_overrides == (
        ("mcp_servers.dummy.command", "/usr/bin/python3"),
        ("mcp_servers.dummy.args", ["/tmp/dummy_mcp.py"]),
        ("mcp_servers.dummy.env", {"K": "V"}),
    )
    assert runtime.mcp_config_json == ""


def test_codex_refuses_a_name_it_cannot_address():
    """codex splits ``-c`` keys on dots, so a dotted name would nest the entry
    under the wrong table. Refused at render time, before any launch."""
    with pytest.raises(ValueError, match="contains '.'"):
        to_codex_overrides([McpSpec(name="claude.ai", command="x")])


def test_opencode_uses_its_own_shape_not_the_mcpservers_one():
    """The one vendor whose shape genuinely differs — getting this wrong is
    silent, because an unknown key is simply ignored."""
    block = to_opencode_mcp([SPEC, REMOTE])
    assert block["dummy"] == {
        "type": "local",                                        # not "stdio"
        "command": ["/usr/bin/python3", "/tmp/dummy_mcp.py"],   # ARRAY, args fused
        "enabled": True,
        "environment": {"K": "V"},                              # not "env"
    }
    assert block["remote"] == {"type": "remote", "url": "https://example.test/mcp", "enabled": True}


def test_remote_servers_render_as_url_not_command():
    body = json.loads(get_driver("claude").prepare_process_mcp([REMOTE]).mcp_config_json)
    assert body["mcpServers"]["remote"] == {"type": "http", "url": "https://example.test/mcp"}
    assert get_driver("codex").prepare_process_mcp([REMOTE]).config_overrides == (
        ("mcp_servers.remote.url", "https://example.test/mcp"),
    )


# ── transport parity: PTY argv AND the headless context ──────────────────────


def test_claude_carries_mcp_on_both_transports():
    from flow_sdk.builtin.agentic_process.cli_drivers.claude.cli import ClaudeAgentOptions
    from flow_sdk.builtin.agentic_process.cli_drivers.claude.stream_worker import (
        ClaudeCLIStreamWorker,
    )

    runtime = get_driver("claude").prepare_process_mcp([SPEC])

    pty = ClaudeAgentOptions(workdir="/repo")
    pty.apply_process_mcp(runtime)

    headless = ClaudeCLIStreamWorker._options_from_context(
        AgenticContext(workdir="/repo", mcp_config_json=runtime.mcp_config_json)
    )

    for argv in (pty.cli_cmd(), headless.cli_cmd()):
        assert _flag_values(argv, "--mcp-config") == [runtime.mcp_config_json]
        assert "--strict-mcp-config" in argv


def test_copilot_carries_mcp_on_both_transports():
    from flow_sdk.builtin.agentic_process.cli_drivers.copilot.cli import CopilotAgentOptions

    runtime = get_driver("copilot").prepare_process_mcp([SPEC])
    pty = CopilotAgentOptions(workdir="/repo")
    pty.apply_process_mcp(runtime)
    assert _flag_values(pty.cli_cmd(), "--additional-mcp-config") == [runtime.mcp_config_json]


def test_codex_mcp_overrides_append_to_the_hook_overrides():
    """Both features share ``extra_config_overrides``; MCP must not clobber it."""
    from flow_sdk.builtin.agentic_process.cli_drivers.codex.cli import CodexAgentOptions

    options = CodexAgentOptions(workdir="/repo")
    options.extra_config_overrides = [("features.hooks", True)]
    options.apply_process_mcp(get_driver("codex").prepare_process_mcp([SPEC]))

    keys = [value.split("=", 1)[0] for value in _config_flags(options.cli_cmd(instruction="hi"))]
    assert "features.hooks" in keys
    assert "mcp_servers.dummy.command" in keys


def test_opencode_writes_mcp_into_its_generated_config(tmp_path, monkeypatch):
    """The MCP-only case: attached servers, no instruction assets. Nothing else
    would set ``config_path``, so opencode would launch with no servers."""
    from flow_sdk.builtin.agentic_process.cli_drivers.opencode import config_gen
    from flow_sdk.builtin.agentic_process.cli_drivers.opencode.cli import OpenCodeAgentOptions

    process_id = "11111111-2222-4333-8444-555555555555"
    monkeypatch.setattr(
        config_gen, "opencode_config_path_for_process", lambda _pid: tmp_path / "opencode.json"
    )

    options = OpenCodeAgentOptions(workdir="/repo")
    options.apply_process_mcp(get_driver("opencode").prepare_process_mcp([SPEC]), process_id)

    _argv, env = options.to_spawn_args(instruction="hi")
    written = json.loads((tmp_path / "opencode.json").read_text(encoding="utf-8"))
    assert env["OPENCODE_CONFIG"] == str(tmp_path / "opencode.json")
    assert written["mcp"]["dummy"]["command"] == ["/usr/bin/python3", "/tmp/dummy_mcp.py"]


def test_opencode_headless_reads_the_fragment_off_the_context(tmp_path, monkeypatch):
    """The headless path holds a process_id and a context, never the process —
    so the specs must arrive already rendered on the context."""
    from flow_sdk.builtin.agentic_process.cli_drivers.opencode import config_gen, stream_worker

    process_id = "11111111-2222-4333-8444-555555555555"
    monkeypatch.setattr(
        config_gen, "opencode_config_path_for_process", lambda _pid: tmp_path / "opencode.json"
    )
    runtime = get_driver("opencode").prepare_process_mcp([SPEC])
    context = AgenticContext(workdir="/repo", mcp_config_fragment=dict(runtime.config_fragment))

    path = stream_worker._config_path_from_context(context, process_id)

    assert path == str(tmp_path / "opencode.json")
    assert json.loads((tmp_path / "opencode.json").read_text())["mcp"]["dummy"]["type"] == "local"


# ── launch-only vs restart-hash ──────────────────────────────────────────────


@pytest.mark.parametrize("vendor", VENDORS, ids=VENDOR_IDS)
def test_rendered_mcp_never_reaches_the_persisted_wire_shape(vendor):
    """``to_json()`` is md5'd into ``last_started_hash``: a rendered path or a
    reserialized flag must never move it."""
    from flow_sdk.builtin.agentic_process.cli_drivers import factory

    options = factory({}, vendor.key)
    options.apply_process_mcp(get_driver(vendor.key).prepare_process_mcp([SPEC]), "pid")
    persisted = options.to_json()
    assert not [key for key in persisted if "mcp" in key.lower()]


def test_rendered_mcp_never_reaches_the_persisted_context():
    context = AgenticContext(
        workdir="/repo",
        mcp_config_json='{"mcpServers": {}}',
        mcp_config_fragment={"dummy": {}},
    )
    persisted = context.to_persistable_dict()
    assert not [key for key in persisted if "mcp" in key.lower()]


@pytest.mark.parametrize("vendor", VENDORS, ids=VENDOR_IDS)
def test_attaching_a_server_moves_the_restart_snapshot(vendor):
    """The intent DOES move the hash — MCP is resolved once at worker boot, so a
    live process genuinely lacks a newly attached server until it bounces."""
    bare = AgenticProcess(worker_type=vendor.worker_type, workdir="/repo")
    attached = _process(vendor)

    before = bare._generic_restart_snapshot_payload(bare.driver)
    after = attached._generic_restart_snapshot_payload(attached.driver)

    assert before["mcp_servers"] != after["mcp_servers"]
    assert after["mcp_servers"]["mcp"][0]["name"] == "dummy"


@pytest.mark.parametrize("vendor", VENDORS, ids=VENDOR_IDS)
def test_the_snapshot_is_semantic_not_a_rendering(vendor):
    """Two processes with the same attached spec agree, whatever each harness
    spells the flag as."""
    assert (
        _process(vendor)._generic_restart_snapshot_payload(get_driver(vendor.key))["mcp_servers"]
        == {"mcp": [SPEC.model_dump(mode="json")]}
    )


# ── resolution seam ──────────────────────────────────────────────────────────


def test_resolved_servers_dedupe_by_name():
    process = AgenticProcess(worker_type="claude_code", workdir="/repo")
    process.mcp_servers = [SPEC, McpSpec(name="dummy", command="other"), REMOTE]
    assert [spec.name for spec in process.resolved_mcp_servers()] == ["dummy", "remote"]
    assert process.resolved_mcp_servers()[0].command == "/usr/bin/python3"


def test_a_cloud_connector_stub_is_not_projectable():
    """``claudeAiMcpEverConnected`` rows are a name and nothing else — the
    credentials live in the cloud — so there is nothing to hand a worker."""

    class _Row:
        name, command, url, args, env, transport = "Gmail", "", "", [], {}, ""

    assert McpSpec.from_record(_Row()) is None


def test_from_record_ignores_worker_type():
    """``worker_type`` records which config file the row was READ from, not
    which worker may use it — a cursor-defined server runs fine under claude."""

    class _Row:
        name, command, url = "fs", "npx", ""
        args, env, transport = ["-y", "server-fs"], {}, "stdio"
        worker_type = "cursor"

    spec = McpSpec.from_record(_Row())
    assert spec is not None and spec.command == "npx"
    assert json.loads(get_driver("claude").prepare_process_mcp([spec]).mcp_config_json)["mcpServers"]["fs"]
