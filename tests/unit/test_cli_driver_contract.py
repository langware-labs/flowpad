"""CLI-driver contract unit tests — the vendor-agnostic ``WorkerDriver`` seam.

Drives the documented driver Protocol (``docs/interface/cli-drivers.md``) directly
against tmp session stores — no HTTP, no real CLI binary:

- ``has_resumable_session`` per driver (claude / codex / copilot), True + False
- negatives: codex/copilot ``supports_plan_mode`` is False; the resume/cli-options
  path never emits ``--fork-session`` for them; ``pins_resume_cwd`` is False
- ``compose_prompt`` stays a user-prompt passthrough; embedded-agent bodies are
  delivered by generated process instruction assets instead
- ``report_event`` claude stub contract (``handled: False``); codex/copilot omit it

Session-store isolation:
- claude / codex read ``get_instance_settings()`` paths, redirected via the
  ``FLOWPAD_TEST_SANDBOX`` env + ``reset_instance_settings()`` (same pattern as
  ``test_codex_transcript_resolution.py``).
- copilot's ``find_copilot_session_jsonl`` reads ``~/.copilot/session-state``
  directly, so we monkeypatch ``copilot_session_state_root``; its process-local
  tee lives under the records root, redirected via ``set_default_records_root``.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.cli_drivers.claude import ClaudeDriver
from flow_sdk.builtin.agentic_process.cli_drivers.codex import CodexAgentOptions, CodexDriver
from flow_sdk.builtin.agentic_process.cli_drivers.copilot import CopilotAgentOptions, CopilotDriver
from flow_sdk.builtin.agentic_process.cli_drivers.opencode import OpenCodeAgentOptions, OpenCodeDriver
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.fs_store.record_paths import get_default_records_root, set_default_records_root
from flow_sdk.instance_settings import get_instance_settings, reset_instance_settings


@pytest.fixture()
def isolated_homes(tmp_path, monkeypatch):
    """Sandbox claude_projects_dir + codex_sessions_dir under a tmp home."""
    monkeypatch.setenv("FLOWPAD_TEST_SANDBOX", str(tmp_path / "sandbox"))
    reset_instance_settings()
    yield get_instance_settings()
    reset_instance_settings()


@pytest.fixture()
def isolated_records_root(tmp_path):
    original = get_default_records_root()
    set_default_records_root(tmp_path / "records")
    yield
    set_default_records_root(original)


def _process(worker_type: WorkerType, **kwargs) -> AgenticProcess:
    return AgenticProcess(
        id=str(uuid.uuid4()),
        worker_type=worker_type,
        workdir="/repo",
        **kwargs,
    )


# ── has_resumable_session: Claude ─────────────────────────────────────────────


def _write_claude_session(projects_dir: Path, session_id: str) -> Path:
    cwd = "/repo"
    encoded = cwd.replace("/", "-")
    path = projects_dir / encoded / f"{session_id}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "type": "user",
                "uuid": "00000000-0000-4000-8000-0000000000aa",
                "sessionId": session_id,
                "cwd": cwd,
                "timestamp": "2026-05-06T21:39:48.000Z",
                "message": {"role": "user", "content": "hi"},
            }
        )
        + "\n",
        encoding="utf-8",
    )
    return path


def test_claude_has_resumable_true_when_session_jsonl_present(isolated_homes):
    session_id = "11111111-1111-4111-8111-111111111111"
    _write_claude_session(isolated_homes.claude_projects_dir, session_id)
    proc = _process(WorkerType.CLAUDE_CODE, session_id=session_id)

    assert proc.driver.has_resumable_session(proc) is True


def test_claude_has_resumable_false_when_absent(isolated_homes):
    proc = _process(WorkerType.CLAUDE_CODE, session_id="99999999-9999-4999-8999-999999999999")

    assert proc.driver.has_resumable_session(proc) is False


def test_claude_has_resumable_false_without_session_id(isolated_homes):
    proc = _process(WorkerType.CLAUDE_CODE)

    assert proc.driver.has_resumable_session(proc) is False


# ── has_resumable_session: Codex ──────────────────────────────────────────────


def _write_codex_rollout(sessions_root: Path, thread_id: str) -> Path:
    path = sessions_root / "2026" / "05" / "06" / f"rollout-2026-05-06T21-39-48-{thread_id}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "timestamp": "2026-05-06T21:39:48.000Z",
                "type": "session_meta",
                "payload": {"id": thread_id, "cwd": "/repo"},
            }
        )
        + "\n",
        encoding="utf-8",
    )
    return path


def test_codex_has_resumable_true_when_rollout_present(isolated_homes):
    thread_id = "019dfe96-cc36-7d80-a907-de19575a6ea4"
    _write_codex_rollout(isolated_homes.codex_sessions_dir, thread_id)
    proc = _process(WorkerType.CODEX, session_id=thread_id)

    assert proc.driver.has_resumable_session(proc) is True


def test_codex_has_resumable_false_when_no_rollout(isolated_homes):
    # A preassigned/PTY session_id codex never wrote a rollout for is NOT
    # resumable — ``codex exec resume <unknown-id>`` would error, so the driver
    # starts fresh instead.
    proc = _process(WorkerType.CODEX, session_id="flowpad-preassigned-no-rollout")

    assert proc.driver.has_resumable_session(proc) is False


def test_codex_has_resumable_false_without_session_id(isolated_homes):
    proc = _process(WorkerType.CODEX)

    assert proc.driver.has_resumable_session(proc) is False


# ── has_resumable_session: Copilot ────────────────────────────────────────────


@pytest.fixture()
def copilot_session_root(tmp_path, monkeypatch):
    root = tmp_path / "copilot-session-state"
    root.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(
        "flow_sdk.builtin.agentic_process.cli_drivers.copilot.session_history.copilot_session_state_root",
        lambda: root,
    )
    return root


def _write_copilot_session(root: Path, session_id: str) -> Path:
    events = root / session_id / "events.jsonl"
    events.parent.mkdir(parents=True, exist_ok=True)
    events.write_text(
        json.dumps({"type": "result", "sessionId": session_id, "exitCode": 0}) + "\n",
        encoding="utf-8",
    )
    return events


def test_copilot_has_resumable_true_when_session_file_present(copilot_session_root):
    session_id = "d816f984-5b1f-4785-83a1-8e4589530637"
    _write_copilot_session(copilot_session_root, session_id)
    proc = _process(WorkerType.COPILOT, session_id=session_id)

    assert proc.driver.has_resumable_session(proc) is True


def test_copilot_has_resumable_false_when_only_process_local_tee_exists(copilot_session_root, isolated_records_root):
    # A stdout tee is Flowpad's replay record, not Copilot's resumable session
    # state. Treating it as resumable emits ``--resume=<id>`` for a session the
    # vendor never created (notably after a launch-time model failure).
    from flow_sdk.builtin.agentic_process.cli_drivers.copilot.session_history import (
        copilot_transcript_path_for_process,
    )

    proc = _process(WorkerType.COPILOT, session_id="tee-only-session")
    tee = copilot_transcript_path_for_process(proc.id)
    tee.write_text('{"type":"result"}\n', encoding="utf-8")

    assert proc.driver.has_resumable_session(proc) is False


def test_copilot_has_resumable_false_when_absent(copilot_session_root, isolated_records_root):
    proc = _process(WorkerType.COPILOT, session_id="absent-session")

    assert proc.driver.has_resumable_session(proc) is False


def test_copilot_has_resumable_false_without_session_id(copilot_session_root):
    proc = _process(WorkerType.COPILOT)

    assert proc.driver.has_resumable_session(proc) is False


# ── negatives: plan mode, fork flags, resume-cwd pinning ──────────────────────


def test_codex_and_copilot_do_not_support_plan_mode():
    codex_proc = _process(WorkerType.CODEX, session_id="x")
    copilot_proc = _process(WorkerType.COPILOT, session_id="x")

    assert CodexDriver().supports_plan_mode(codex_proc) is False
    assert CopilotDriver().supports_plan_mode(copilot_proc) is False
    # OpenCode ships a built-in ``plan`` agent, but not the ExitPlanMode tool
    # contract FlowPad's plan flow needs to surface ``plan_path``.
    assert OpenCodeDriver().supports_plan_mode(_process(WorkerType.OPENCODE, session_id="x")) is False


def test_codex_and_copilot_do_not_pin_resume_cwd():
    # Only claude pins the resume cwd (and only claude forks).
    assert CodexDriver.pins_resume_cwd is False
    assert CopilotDriver.pins_resume_cwd is False
    assert OpenCodeDriver.pins_resume_cwd is False


def test_codex_never_emits_fork_session_flag():
    # ``fork_session_id`` lives on the base options so callers can read it
    # without a hasattr guard, but only claude serialises/emits it. Setting it
    # on codex options must not leak a ``--fork-session`` flag into argv or the
    # shell string on the resume path.
    cmd = CodexAgentOptions(workdir="/repo", session_id="s", resume=True)
    cmd.fork_session_id = "parent-src"
    argv, _ = cmd.to_spawn_args()

    assert "--fork-session" not in argv
    assert "--fork-session" not in cmd.to_shell_string()


def test_copilot_never_emits_fork_session_flag():
    cmd = CopilotAgentOptions(workdir="/repo", session_id="s", resume=True)
    cmd.fork_session_id = "parent-src"
    argv, _ = cmd.to_spawn_args()

    assert "--fork-session" not in argv
    assert "--fork-session" not in cmd.to_shell_string()


# ── compose_prompt: user-prompt passthrough ───────────────────────────────────

_AGENTS = {
    "reviewer": {"prompt": "REVIEW THE DIFF", "description": "reviews code"},
}


@pytest.mark.parametrize("driver", [ClaudeDriver(), CodexDriver(), CopilotDriver(), OpenCodeDriver()])
def test_compose_prompt_passthrough_without_agents(driver):
    assert driver.compose_prompt("just do it", None) == "just do it"
    assert driver.compose_prompt("just do it", {}) == "just do it"


@pytest.mark.parametrize("driver", [ClaudeDriver(), CodexDriver(), CopilotDriver(), OpenCodeDriver()])
def test_compose_prompt_passthrough_with_agents(driver):
    composed = driver.compose_prompt("use the reviewer agent", _AGENTS)

    assert composed == "use the reviewer agent"


# ── report_event: claude stub contract (codex/copilot omit it) ────────────────


@pytest.mark.asyncio
async def test_claude_report_event_returns_unhandled_stub(isolated_homes):
    proc = _process(WorkerType.CLAUDE_CODE, session_id="sess-report")

    result = await ClaudeDriver().report_event(proc, "some.custom.event", {"k": "v"})

    assert result == {
        "handled": False,
        "worker": "claude",
        "event_name": "some.custom.event",
        "session_id": "sess-report",
        "reason": "unsupported_event",
    }


def test_codex_and_copilot_omit_report_event():
    # The Protocol is structural: report_event is claude-only. AgenticProcess
    # only calls it for vendors that implement it, so codex/copilot omitting it
    # is the documented contract — pin that they truly don't define it.
    assert not hasattr(CodexDriver, "report_event")
    assert not hasattr(CopilotDriver, "report_event")
    assert not hasattr(OpenCodeDriver, "report_event")


# ── opencode ─────────────────────────────────────────────────────────────────


def test_opencode_omits_preassign_because_the_cli_rejects_unknown_ids():
    """``opencode run --session <unknown>`` exits 1 with "Session not found",
    so a caller-minted id can never be handed over at launch. Like codex, the
    driver omits the attribute entirely and captures the vendor's own id."""
    assert not hasattr(OpenCodeDriver, "preassign_interactive_session_id")


def test_opencode_submits_on_paste():
    """Measured on 1.18.16: a single paste ending in \\r created a real session.

    OpenCode sides with claude here; codex and copilot need a discrete Enter.
    """
    assert OpenCodeDriver.pty_submits_on_paste is True


def test_opencode_composer_pattern_is_a_regex_trait():
    assert OpenCodeDriver.pty_composer_ready_pattern is not None
    assert OpenCodeDriver.pty_composer_ready_pattern.search("  Ask anything... \"Fix broken tests\"")


def test_opencode_can_fork_unlike_codex_and_copilot():
    """OpenCode is the second forking vendor after claude — but its ``--fork``
    is a modifier on a resume, not a standalone flag."""
    forked = OpenCodeAgentOptions(
        workdir="/repo", session_id="ses_a", resume=True, fork_session_id="ses_parent"
    )
    argv = forked.cli_cmd()
    assert "--fork" in argv
    assert "--session" in argv

    plain = OpenCodeAgentOptions(workdir="/repo", session_id="ses_a", resume=True)
    assert "--fork" not in plain.cli_cmd()


def test_opencode_never_emits_add_dir():
    """There is no ``--add-dir`` on opencode: instructions and skills ride the
    generated config. A copy-paste from copilot would silently drop them."""
    cmd = OpenCodeAgentOptions(workdir="/repo", add_dirs=["/repo/assets"])
    assert "--add-dir" not in cmd.cli_cmd(instruction="hi")
    assert "--add-dir" not in cmd.to_shell_string(instruction="hi")
