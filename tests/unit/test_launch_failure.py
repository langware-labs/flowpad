import asyncio  # noqa: E401
import json
import logging
import os
import sys
import uuid
from types import SimpleNamespace as NS

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process import agentic_process as ap
from flow_sdk.builtin.agentic_process.cli_drivers import cli_worker_base_driver as base
from flow_sdk.builtin.agentic_process.cli_drivers import headless_turn, llm_source
from flow_sdk.builtin.agentic_process.cli_drivers.claude import launch_screen as screen
from flow_sdk.builtin.agentic_process.cli_drivers.claude import trust
from flow_sdk.builtin.agentic_process.cli_drivers.claude.stream_worker import ClaudeCLIStreamWorker
from flow_sdk.builtin.agentic_process.cli_drivers.replay_envelope import final_end_frame, status_frame
from flow_sdk.builtin.agentic_process.launch_health import CODE_TABLE, LaunchError, LaunchErrorCode, code_for_refusal
from flow_sdk.cli.auth import lm_api_keys
from flow_sdk.core.status import InstallState, LoginState
from flow_sdk.flowpad_types.enums.lm_provider_enums import LMApiProvider
from flow_sdk.fs_store.operations import claude_settings
from flow_sdk.responses.response import ApiSuccessResponse
from flow_sdk.schema.data_spec.llm_source_spec import LLMSource
from tests.utils.fake_cli import patch_build_spawn

TRUST = " Accessing workspace:\n C:\\Users\\qa\\proj\n Is this a project you created or one you trust?\n ❯ No, exit\n   Yes, I trust this folder\n"
REFUSALS = {
    "not_installed": "not_installed",
    "no_key": "signed_out",
    "": "signed_out",
    "key_rejected": "key_rejected",
    "cli_crashed": "cli_crashed",
    "budget_not_ready": "budget_not_ready",
    "pinned_elsewhere": "pinned_source_unavailable",
}
src = lambda code: LLMSource(endpoint_typeid=f"llm_endpoint-{code}", reason="r", reason_code=code)  # noqa: E731


def test_contract_tables():
    assert len(CODE_TABLE) == 11 and CODE_TABLE["budget_not_ready"] == (
        "transient_error",
        "wait",
    )  # the contract's table
    for code, (health, fix) in CODE_TABLE.items():
        wire = LaunchError.of(LaunchErrorCode(code)).wire(
            "blocked", evidence="x" * 3000, facts={"folder": "/p", "provider": ""}
        )
        assert (wire["fix"], wire["health"], wire["facts"], len(wire["evidence"])) == (
            fix,
            health,
            {"folder": "/p"},
            2048,
        )
    assert {r: str(code_for_refusal(r)) for r in REFUSALS} == REFUSALS
    for sources, flag, code in (
        (["not_installed", "no_key"], False, "not_installed"),
        (["signed_out", "key_rejected"], False, "key_rejected"),
        (["signed_out"], True, "budget_not_ready"),
    ):
        exc = llm_source.LLMSourceError("claude", [src(c) for c in sources])
        exc.budget_not_ready = flag
        wrapped = base.WorkerSpawnError("claude", "no source")
        wrapped.__cause__ = exc  # a spawn refused for funding is classified by its funding error
        assert str(LaunchError.classify(wrapped).code) == code


def test_screens():
    for text, verdict, auth in (
        (TRUST, "folder_not_trusted", None),
        (" Choose the text style that looks best", "first_run_setup", None),
        ("Claude Code running in Bypass Permissions mode", "bypass_warning", None),
        (TRUST + '│ ❯ Try "fix lint" │', "ready", None),
        ("Welcome to Claude Code", None, None),
        ("✻ 401 User not found. · Retrying in 10s · attempt 5/10", None, "401 User not found."),
        ("✻ 529 Overloaded · Retrying in 3s", None, None),
        ("we discussed HTTP 401", None, None),
    ):
        assert (screen.classify(text), (screen.classify_auth(text) or [None, None])[1]) == (verdict, auth)


def test_headless_turn_failure():
    retry401 = {"type": "system", "subtype": "api_retry", "error_status": 401, "error": "authentication_failed"}
    for events, returncode, code in (
        ([retry401], None, "key_rejected"),
        ([], 1, "cli_crashed"),
        ([{"type": "result", "is_error": True, "result": "Not logged in · Please run /login"}], 1, "signed_out"),
        ([{"type": "result", "is_error": True, "result": "API Error: 500"}], 1, None),
    ):
        (worker := ClaudeCLIStreamWorker())._proc = NS(returncode=returncode) if returncode else None
        [worker._observe_session_events(event) for event in events]
        assert (str(f[0].code) if (f := worker.turn_failure()) else None) == code


def test_funding_verdicts(monkeypatch):
    lm_api_keys.mark_key_rejected("openrouter", "401 User not found.", "****abcd")
    spec = NS(supported_providers=[LMApiProvider.OPENROUTER])
    assert llm_source._key_sources(spec, {}, {"openrouter"}, {})[0].source.reason_code == "key_rejected"
    lm_api_keys.mark_key_rejected("openrouter", None)
    assert llm_source._key_sources(spec, {}, {"openrouter"}, {})[0].source.eligible
    monkeypatch.setitem(llm_source.CLI_CRASHES, "claude", "Error: Cannot find module")
    assert (
        llm_source._device_source("claude", InstallState.INSTALLED, LoginState.SIGNED_IN).source.reason_code
        == "cli_crashed"
    )
    for top, pending, code in (
        ("signed_out", True, "budget_not_ready"),
        ("signed_out", False, "signed_out"),
        ("cli_crashed", True, "cli_crashed"),
    ):
        monkeypatch.setattr(llm_source, "_hub_budget_pending", lambda: pending)
        assert llm_source._blocked_code(src(top), [], "claude") == code


def recorder(seen, value=None):
    async def call(*a, **k):
        seen.append(value)
        return ApiSuccessResponse(data={}) if isinstance(value, str) else value

    return call


async def test_headless_crash_latches_before_end_once():
    await (proc := AgenticProcess(id=str(uuid.uuid4()), status="running", pty_mode=False)).save()
    (worker := ClaudeCLIStreamWorker())._proc = NS(returncode=1)
    for frame, code in ((status_frame("exit-error", "x"), None), (final_end_frame(), "cli_crashed")):
        await base.latch_turn_failure(proc, worker, frame)
        assert ((await AgenticProcess.get_by_id(proc.id)).launch_failure or {}).get("code") == code


async def test_cli_killed_mid_turn_by_quitting_flowpad_is_not_a_crash(monkeypatch, tmp_path):
    """Quitting Flowpad from Activity Monitor (not a graceful stop) SIGTERMs the CLI mid-turn. Nothing crashed,
    so the chat must stay sendable: a latched FAILED outlives the restart and refuses every later message."""
    (cli := tmp_path / "claude.py").write_text(
        "import json, os, signal\n"
        "signal.signal(signal.SIGTERM, lambda *_: os._exit(143))\n"  # the code the real CLI left: 143
        "print(json.dumps({'type': 'system', 'subtype': 'init', 'session_id': 's'}), flush=True)\n"
        "os.kill(os.getpid(), signal.SIGTERM)\n"
        "signal.pause()\n"
    )
    patch_build_spawn(
        monkeypatch, ClaudeCLIStreamWorker, [sys.executable, str(cli)], env=dict(os.environ), stdin="hi\n"
    )
    await (proc := AgenticProcess(id=str(uuid.uuid4()), status="running", pty_mode=False)).save()
    turn_over = asyncio.Event()

    async def finished():
        turn_over.set()

    await headless_turn.run_headless_turn(
        NS(name="claude"),
        proc,
        ClaudeCLIStreamWorker(),
        prompt="hi",
        context=base.AgenticContext(workdir=str(tmp_path)),
        logger=logging.getLogger(__name__),
        on_turn_finally=finished,
    )
    await turn_over.wait()

    latched = await AgenticProcess.get_by_id(proc.id)
    assert (latched.launch_failure, latched.status != "failed") == (None, True)


async def test_blocking_prompt_then_exit_latches_without_respawn_and_trust_fix_relaunches(monkeypatch, tmp_path):
    from flow_sdk.app.actions.watch_registry import add_watch, remove_watch
    from flow_sdk.server.pty_recovery import run_pty_recovery

    seen = []
    monkeypatch.setattr(AgenticProcess, "start_pty", recorder(seen, "start"))
    monkeypatch.setattr(AgenticProcess, "exit", recorder(seen, "exit"))
    [
        monkeypatch.setattr(mod, "get_instance_settings", lambda: NS(user_home=tmp_path))
        for mod in (trust, claude_settings)
    ]
    await (
        proc := AgenticProcess(
            id=str(uuid.uuid4()), status="running", workdir=str(tmp_path), shell_id=str(uuid.uuid4())
        )
    ).save()
    await proc._apply_launch_screen("folder_not_trusted", TRUST, screen)
    got = await AgenticProcess.get_by_id(proc.id)
    assert (
        got.pending_user_input() == {"kind": "launch_blocked", "code": "folder_not_trusted"}
        and got.start_failure is None
    )
    (
        add_watch("c", f"agentic_process:{proc.id}"),
        await run_pty_recovery(),
        remove_watch("c", f"agentic_process:{proc.id}"),
    )
    assert seen == []  # never respawned onto the same prompt
    monkeypatch.setattr(
        ap, "get_current_request_info", lambda: NS(get_post_data=recorder([], {"fix": "trust_folder"}), action="x")
    )
    assert isinstance(await got.http_resolve_launch_failure(), ApiSuccessResponse) and seen == ["exit", "start"]
    assert json.loads((tmp_path / ".claude.json").read_text())["projects"] and trust.claude_trusts(str(tmp_path))
    coros = []
    monkeypatch.setattr(ap.asyncio, "run_coroutine_threadsafe", lambda coro, loop: coros.append(coro))
    monkeypatch.setattr(ap, "_release_after_armed_flush", lambda p: None)
    await got._apply_launch_screen("bypass_warning", "running in Bypass Permissions mode", screen)
    got._make_pty_exit_callback()(1)  # "No, exit"
    await coros[0]
    got = await AgenticProcess.get_by_id(proc.id)
    assert (got.status, got.launch_failure["code"], got.launch_blocked()) == ("failed", "bypass_warning", None)


@pytest.mark.parametrize("kind, code", [("api_key", "key_rejected"), ("device", "signed_out")])
async def test_refused_credential_marks_only_a_stored_key(monkeypatch, kind, code):
    monkeypatch.setattr(
        llm_source, "resolve_llm_endpoint", recorder([], (NS(kind=kind, provider="x"), NS(detail="****")))
    )
    await (proc := AgenticProcess(id=str(uuid.uuid4()), status="running")).save()
    await base.latch_credential_failure(proc, LaunchError.of(LaunchErrorCode.KEY_REJECTED, "401"), "401")
    assert (proc.launch_failure["code"], "x" in lm_api_keys.KEY_REJECTIONS) == (code, kind == "api_key")
    lm_api_keys.mark_key_rejected("x", None)
