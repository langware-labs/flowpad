"""An agent's ``disallowed_tools`` hold on the deepagents harness, as they do under claude --
the diagnose agent falls back to deepagents when claude cannot run."""

import json
from pathlib import Path

from deepagents.backends.local_shell import LocalShellBackend

from flow_sdk.builtin.agentic_process.cli_drivers.deepagents.bans import banned_backend
from flow_sdk.builtin.agentic_process.cli_drivers.deepagents.cli import DeepAgentsAgentOptions
from flow_sdk.builtin.agentic_process.cli_drivers.deepagents.runner import build_parser
from flow_sdk.cli.commands.diagnose_cmd import (
    REPORT_ONLY_DENIED_TOOLS,
    _claude_could_not_run,
    _claude_shaper,
    _extract_report_result,
)
from flow_sdk.config import flowpad_assistant_project_root

DIAGNOSE_BANS = json.loads(
    (flowpad_assistant_project_root() / "agentic-assets" / "agent" / "diagnose" / "agent.json").read_text()
)["disallowed_tools"]


def _backend(tmp_path: Path, rules: list[str]):
    return banned_backend(LocalShellBackend, rules, root_dir=str(tmp_path), virtual_mode=False, inherit_env=True)


def test_the_diagnose_agents_bans_refuse_the_command_and_run_nothing(tmp_path):
    victim = tmp_path / "keep"
    victim.write_text("x")
    backend = _backend(tmp_path, DIAGNOSE_BANS)

    removed = backend.execute(f"rm -rf {victim}")
    chained = backend.execute("cd /tmp && git reset --hard")
    listed = backend.execute(f"ls {tmp_path}")

    assert removed.exit_code == 1 and "Bash(rm -rf:*)" in removed.output and victim.exists()
    assert chained.exit_code == 1 and "Bash(git reset:*)" in chained.output, "a ban holds inside a chain"
    assert listed.exit_code == 0 and "keep" in listed.output


def test_report_only_refuses_writing_files(tmp_path):
    backend = _backend(tmp_path, list(REPORT_ONLY_DENIED_TOOLS))

    assert backend.write(str(tmp_path / "new"), "x").error and not (tmp_path / "new").exists()


def test_the_bans_reach_the_runner():
    argv = DeepAgentsAgentOptions(session_id="s", workdir="/w", disallowed_tools=DIAGNOSE_BANS)._emit_flags()
    parsed = build_parser().parse_args(argv)

    assert json.loads(parsed.disallowed_tools) == DIAGNOSE_BANS


def test_only_a_claude_cli_failure_falls_back_not_the_budget():
    assert _claude_could_not_run(None), "no transcript at all"
    assert _claude_could_not_run("claude exited with code 1 before answering")
    assert not _claude_could_not_run("Model mismatch: this session needs the 'sm' model size, but ...")


def test_a_deepagents_run_reports_its_diagnosis_the_way_claude_does():
    """``flow diagnose`` reads report.py's result out of the transcript; a deepagents line must reach it."""
    report = (
        '{"diagnosis_id": "24299f7a-3575-4fdc-acf5-d7e6403aa7dd", "conversation_id": null, "flow_message_id": null}'
    )
    lines = [
        {"type": "text", "session_id": "s", "message_id": "m1", "text": "The backend is not running."},
        {"type": "tool_result", "session_id": "s", "tool_call_id": "c1", "name": "execute", "output": report},
    ]
    shape = _claude_shaper("deepagents")

    shaped = [e for i, line in enumerate(lines) for e in shape(line, i)]
    blocks = [e["message"]["content"][0] for e in shaped]

    assert {"type": "text", "text": "The backend is not running."} in blocks
    results = [_extract_report_result(b["content"]) for b in blocks if b["type"] == "tool_result"]
    assert results[0]["diagnosis_id"] == "24299f7a-3575-4fdc-acf5-d7e6403aa7dd"


def test_an_agent_written_for_claude_asks_deepagents_for_the_same_size():
    """``model: haiku`` (the diagnose agent's) is claude's spelling of sm; on deepagents it spends the budget's sm."""
    from types import SimpleNamespace

    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import _slug_for, driver_api_auth_spec

    spec = driver_api_auth_spec("deepagents")
    source = SimpleNamespace(endpoint_typeid="llm_endpoint-x", name="budget")

    assert _slug_for("deepagents", spec, {"sm": "google/gemini-3.1-pro-preview"}, source, "haiku").endswith(
        "google/gemini-3.1-pro-preview"
    )
