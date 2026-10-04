"""``run_op`` — ask, make ONE call, prove.

Every case drives the real runner with the shell and the agent launcher passed
through its seams. That is what those seams are for: the machine has no I/O of
its own, so its whole behaviour is assertable in milliseconds.

The case that carries the design is the one where the call REPORTS SUCCESS and
the goal is still not met — `exit 0` is never the verdict, the re-check is.
"""

from __future__ import annotations

from pathlib import Path
from typing import ClassVar

import pytest

from flow_sdk.core.compute_op import check_op, run_op
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.returned_value_spec import CliResult, ExitCode, PromptResult
from flow_sdk.schema.data_spec.spec import DataSpec

pytestmark = pytest.mark.timeout(5)


class Port(DataSpec):
    spec_kind: ClassVar[str] = "test.runner.port"
    port: int


def _spec(**over) -> ComputeOpSpec:
    body = {
        "name": "jq-on-path",
        "label": "jq",
        "subkind": "cli",
        "exe_data": {"commands": {"linux": "install jq"}},
        "completion_check": {"commands": {"linux": "have jq"}},
    }
    body.update(over)
    return ComputeOpSpec.model_validate(body)


def _shell(code_for, *, seen=None):
    """A shell whose exit code is a function of the command."""

    async def shell(command, **_kw):
        if seen is not None:
            seen.append(command)
        code = code_for(command)
        if code == "timeout":
            return CliResult.of_process(command, None, timed_out=True)
        return CliResult.of_process(command, code, "", f"{command}: nope" if code else "")

    return shell


async def _run_op(spec, shell, launch=None, *, tmp_path, **over):
    kw = {"launch": launch} if launch is not None else {}
    return await run_op(
        spec,
        trusted=True,
        workdir=Path(tmp_path),
        platform="linux",
        shell=shell,
        **kw,
        **over,
    )


# ── the check, on its own ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_check_is_cheap_and_answers_three_ways(tmp_path):
    spec = _spec(not_applicable_codes=[99])

    def ask(code):
        return check_op(spec, workdir=tmp_path, platform="linux", shell=_shell(lambda _c: code))

    assert (await ask(0)).exit_code is ExitCode.OK
    assert (await ask(1)).exit_code is ExitCode.NOT_YET
    assert (await ask(99)).exit_code is ExitCode.NOT_APPLICABLE
    assert isinstance(await ask(0), CliResult)


@pytest.mark.asyncio
async def test_a_platform_with_no_command_is_not_applicable_never_a_failure(tmp_path):
    seen: list[str] = []
    spec = _spec(completion_check={"commands": {"darwin": "have jq"}})
    answer = await check_op(spec, workdir=tmp_path, platform="linux", shell=_shell(lambda _c: 0, seen=seen))
    assert answer.exit_code is ExitCode.NOT_APPLICABLE
    assert seen == [], "a check that cannot be asked here must not run anything"


@pytest.mark.asyncio
async def test_a_timed_out_check_is_not_a_satisfied_one(tmp_path):
    answer = await check_op(_spec(), workdir=tmp_path, platform="linux", shell=_shell(lambda _c: "timeout"))
    assert answer.exit_code is ExitCode.NOT_YET and answer.timed_out


@pytest.mark.asyncio
async def test_no_check_at_all_means_work_to_do(tmp_path):
    answer = await check_op(
        _spec(completion_check=None), workdir=tmp_path, platform="linux", shell=_shell(lambda _c: 0)
    )
    assert answer.exit_code is ExitCode.NOT_YET and answer.ran is False


# ── one call, then the re-check ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_satisfied_costs_one_check_and_runs_nothing(tmp_path):
    seen: list[str] = []
    answer = await _run_op(_spec(), _shell(lambda _c: 0, seen=seen), tmp_path=tmp_path)

    assert answer.ok and answer.ran is False and "already satisfied" in answer.detail
    assert isinstance(answer, CliResult) and answer.check is not None
    assert seen == ["have jq"], "a satisfied goal must not run its call"


@pytest.mark.asyncio
async def test_the_call_makes_the_check_pass(tmp_path):
    installed = {"jq": False}

    async def shell(command, **_kw):
        if command == "install jq":
            installed["jq"] = True
            return CliResult.of_process(command, 0)
        return CliResult.of_process(command, 0 if installed["jq"] else 1)

    answer = await _run_op(_spec(), shell, tmp_path=tmp_path)

    assert answer.ok and answer.ran and answer.exit_code is ExitCode.OK
    assert answer.command == "install jq" and answer.returncode == 0
    assert answer.check.returncode == 0


@pytest.mark.asyncio
async def test_a_call_that_exits_zero_without_reaching_the_goal_is_not_yet(tmp_path):
    """The case that breaks any design that trusts exit codes.

    `uv` installs happily into ~/.local/bin and the shell still cannot find it.
    The call succeeds, the CHECK does not — and the check is the verdict.
    """

    async def shell(command, **_kw):
        if command == "install uv":
            return CliResult.of_process(command, 0, "installed to ~/.local/bin")
        return CliResult.of_process(command, 1, "", "uv: not found")

    spec = _spec(
        name="uv-on-path",
        label="uv",
        exe_data={"commands": {"linux": "install uv"}},
        completion_check={"commands": {"linux": "uv --version"}},
    )
    answer = await _run_op(spec, shell, tmp_path=tmp_path)

    assert answer.ok is False and answer.exit_code is ExitCode.NOT_YET
    assert answer.returncode == 0, "the call's own exit is kept, and is not the verdict"
    assert answer.check.stderr == "uv: not found", "the check's evidence rides on the answer"
    assert "\n" not in answer.detail


@pytest.mark.asyncio
async def test_a_failed_call_carries_its_evidence_and_one_sentence(tmp_path):
    answer = await _run_op(_spec(completion_check=None), _shell(lambda _c: 100), tmp_path=tmp_path)

    assert answer.exit_code is ExitCode.NOT_YET
    assert answer.returncode == 100 and answer.stderr == "install jq: nope"
    assert "\n" not in answer.detail


@pytest.mark.asyncio
async def test_not_applicable_is_a_pass_not_a_failure(tmp_path):
    spec = _spec(completion_check={"commands": {"linux": "locale | grep -q UTF-8"}}, not_applicable_codes=[2])
    answer = await _run_op(spec, _shell(lambda _c: 2), tmp_path=tmp_path)

    assert answer.ok and answer.ran is False and "not applicable here" in answer.detail


@pytest.mark.asyncio
async def test_a_call_silent_on_this_platform_runs_nothing(tmp_path):
    seen: list[str] = []
    spec = _spec(exe_data={"commands": {"darwin": "brew install jq"}}, completion_check=None)
    answer = await _run_op(spec, _shell(lambda _c: 0, seen=seen), tmp_path=tmp_path)

    assert seen == []
    assert answer.exit_code is ExitCode.NOT_APPLICABLE


@pytest.mark.asyncio
async def test_a_call_silent_on_this_platform_stays_not_applicable_after_the_recheck(tmp_path):
    """A check THIS box can run does not turn "not my platform" into a failure.

    The op installs on darwin only; the check runs everywhere and says no. The
    re-check has nothing to report about a call that never happened, so the
    call's own answer stands.
    """
    seen: list[str] = []
    spec = _spec(exe_data={"commands": {"darwin": "brew install jq"}})
    answer = await _run_op(spec, _shell(lambda _c: 1, seen=seen), tmp_path=tmp_path)

    assert answer.exit_code is ExitCode.NOT_APPLICABLE
    assert "no command for this platform" in answer.detail
    assert answer.check is not None and answer.check.exit_code is ExitCode.NOT_YET
    # And the check ran ONCE: nothing happened, so re-checking would spend a
    # process to learn what the first check already said.
    assert seen == ["have jq"]


@pytest.mark.asyncio
async def test_a_call_that_never_started_keeps_its_own_reason(tmp_path):
    """ "Nothing ran" must not be reported as "it ran and the check still fails".

    The launcher answers the way it does with no harness on the box: NOT_YET,
    ``ran=False``, and the sentence that is the only account of why.
    """

    async def launch(*_a, **_kw):
        return PromptResult.not_yet("No coding-agent harness is available to run this.", ran=False)

    spec = _spec(subkind="agent", exe_data={"agent": "provisioner"})
    answer = await _run_op(spec, _shell(lambda _c: 1), launch, tmp_path=tmp_path)

    assert answer.exit_code is ExitCode.NOT_YET and answer.ran is False
    assert "No coding-agent harness" in answer.detail
    assert answer.check is not None


# ── the agent subkind ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_the_agent_is_told_the_goal_the_manual_way_and_the_bar(tmp_path):
    prompts: list[str] = []

    async def launch(**kw):
        prompts.append(kw["prompt"])
        return PromptResult.satisfied("The agent finished.", executor="agentic_process-p1")

    spec = _spec(
        subkind="agent",
        exe_data={"agent": "provisioner", "prompt": "install jq"},
        description="jq parses JSON on the command line.",
        setup="Run `apt-get update` first — a fresh image ships an empty index.",
    )
    answer = await _run_op(spec, _shell(lambda _c: 1), launch, tmp_path=tmp_path)

    prompt = prompts[0]
    assert "install jq" in prompt
    assert "apt-get update" in prompt, "...and how a person does it by hand"
    assert "have jq" in prompt, "...and what proves it is done"
    assert isinstance(answer, PromptResult) and answer.executor == "agentic_process-p1"
    assert answer.exit_code is ExitCode.NOT_YET, "the agent finished, the check did not pass"


@pytest.mark.asyncio
async def test_an_executor_continues_that_process_instead_of_spawning(tmp_path):
    seen: list[dict] = []

    async def launch(**kw):
        seen.append(kw)
        return PromptResult.satisfied("The agent finished.", executor="agentic_process-p1")

    spec = _spec(
        subkind="agent", exe_data={"agent": "provisioner", "prompt": "the check still fails"}, completion_check=None
    )
    answer = await _run_op(spec, _shell(lambda _c: 0), launch, tmp_path=tmp_path, executor="agentic_process-p1")

    assert seen[0]["executor"] == "agentic_process-p1", "the executor is handed on as-is, never re-parsed"
    assert seen[0]["prompt"] == "the check still fails", "a further turn is told only what the caller says"
    assert answer.ok


# ── trust ────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_an_unapproved_op_is_refused_before_it_asks_anything(tmp_path):
    seen: list[str] = []
    answer = await run_op(
        _spec(), trusted=False, workdir=Path(tmp_path), platform="linux", shell=_shell(lambda _c: 0, seen=seen)
    )
    # Refused, returned — never raised, never blocked, nothing run to find out.
    assert answer.exit_code is ExitCode.REFUSED and answer.ran is False
    assert seen == []


# ── a cli op returns a value ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_cli_op_returns_its_declared_kind(tmp_path):
    op = ComputeOpSpec.model_validate(
        {
            "name": "pick-port",
            "subkind": "cli",
            "exe_data": {"commands": {"linux": "free-port"}},
            "output_spec_kind": "test.runner.port",
        }
    )

    async def shell(command, **_kw):
        return CliResult.of_process(command, 0, '{"port": 8099}\n')

    answer = await run_op(op, trusted=True, workdir=tmp_path, platform="linux", shell=shell)
    assert answer.exit_code is ExitCode.OK
    assert isinstance(answer.value, Port) and answer.value.port == 8099


@pytest.mark.asyncio
async def test_a_command_that_prints_plain_text_returns_it_as_a_string(tmp_path):
    op = ComputeOpSpec.model_validate(
        {
            "name": "whoami",
            "subkind": "cli",
            "output_spec_kind": "string",
            "exe_data": {"commands": {"linux": "whoami"}},
        }
    )

    async def shell(command, **_kw):
        return CliResult.of_process(command, 0, "  ada  \n")

    assert (await run_op(op, trusted=True, workdir=tmp_path, platform="linux", shell=shell)).value == "ada"


@pytest.mark.asyncio
async def test_a_value_that_is_not_the_declared_kind_fails_the_op(tmp_path):
    op = ComputeOpSpec.model_validate(
        {
            "name": "pick-port",
            "subkind": "cli",
            "exe_data": {"commands": {"linux": "free-port"}},
            "output_spec_kind": "test.runner.port",
        }
    )

    async def shell(command, **_kw):
        return CliResult.of_process(command, 0, "not json")

    answer = await run_op(op, trusted=True, workdir=tmp_path, platform="linux", shell=shell)
    assert answer.exit_code is ExitCode.NOT_YET and answer.value is None
    assert answer.stdout == "not json", "what the call printed stays readable"


def test_an_unknown_output_kind_is_refused_at_read():
    with pytest.raises(ValueError, match="unknown kind"):
        _spec(output_spec_kind="test.runner.prot")


@pytest.mark.asyncio
async def test_a_call_silent_on_this_platform_with_a_declared_kind_stays_not_applicable(tmp_path):
    """No check, a declared output kind, and no command for this platform.

    NOT_APPLICABLE is `ok`, so the no-check path used to hold its (absent) value
    to the declared kind — and demote "not this machine's problem" to NOT_YET
    with "returned a value that is not an int". Nothing ran; there is no value
    to hold to anything.
    """
    spec = _spec(exe_data={"commands": {"darwin": "echo 8080"}}, completion_check=None, output_spec_kind="int")
    answer = await _run_op(spec, _shell(lambda _c: 0), tmp_path=tmp_path)

    assert answer.exit_code is ExitCode.NOT_APPLICABLE
    assert "no command for this platform" in answer.detail


@pytest.mark.asyncio
async def test_a_failed_call_says_why_in_its_own_words(tmp_path):
    """A call that failed printed its reason ("Meta refused that App ID …") — the person's next step. The
    op's sentence carries it rather than the generic "the check still fails"; a call that succeeded but did
    not reach the goal has no reason of its own, and keeps the generic one."""
    failed = await _run_op(_spec(), _shell(lambda _c: 1), tmp_path=tmp_path)
    assert failed.exit_code is ExitCode.NOT_YET and failed.detail == "jq: install jq: nope"

    quiet = await _run_op(_spec(), _shell(lambda c: 0 if c.startswith("install") else 1), tmp_path=tmp_path)
    assert quiet.detail == "jq: the cli call ran, but the check still fails."


@pytest.mark.asyncio
async def test_an_agent_rung_with_nobody_to_run_it_says_what_the_person_can_do(tmp_path):
    """The install failed and the rung that could try another way has no LLM source. The report says so in plain
    words and what to do next — not "claude_code has no usable LLM source: …", a fact about the machine."""

    async def launch(**_kw):
        return PromptResult.not_yet("claude_code has no usable LLM source: claude is signed out", ran=False)

    spec = _spec(attempts=[{"subkind": "agent", "exe_data": {"agent": "provisioner", "prompt": "do it"}}])
    answer = await _run_op(spec, _shell(lambda _c: 1), launch, tmp_path=tmp_path)

    assert answer.exit_code is ExitCode.NOT_YET
    assert answer.detail.startswith("jq wasn't installed")
    assert "no assistant is signed in" in answer.detail and "run setup again" in answer.detail
    assert "claude_code" not in answer.detail and "LLM source" not in answer.detail
    assert "install jq: nope" in answer.detail, "what the automatic install said stays, as the detail"


# ── a Windows permission prompt is the person's turn, not a hang ─────────────


@pytest.mark.asyncio
async def test_an_open_windows_permission_prompt_says_waiting_for_you_until_it_closes(tmp_path, monkeypatch):
    import asyncio

    from flow_sdk.core.compute_op import runner

    prompt = {"open": True}
    monkeypatch.setattr(runner, "_permission_prompt_open", lambda: prompt["open"])
    monkeypatch.setattr(runner, "_PERMISSION_PROMPT_POLL_SECONDS", 0.01)
    said: list[str] = []

    async def until(pred):
        while not pred():
            await asyncio.sleep(0.01)

    installed: list[bool] = []

    async def shell(command, **_kw):
        if command == "install jq":
            await until(lambda: any("waiting for you" in s for s in said))
            prompt["open"] = False
            await until(lambda: said[-1] == "jq: cli")
            installed.append(True)
            return CliResult.of_process(command, 0, "", "")
        return CliResult.of_process(command, 0 if installed else 1, "", "")

    spec = _spec(exe_data={"commands": {"win32": "install jq"}}, completion_check={"commands": {"win32": "have jq"}})
    answer = await run_op(spec, trusted=True, workdir=tmp_path, platform="win32", shell=shell, on_status=said.append)

    assert answer.exit_code is ExitCode.OK
    assert any("waiting for you" in s and "Windows permission prompt" in s for s in said)


@pytest.mark.asyncio
async def test_no_permission_prompt_watch_off_windows(tmp_path, monkeypatch):
    from flow_sdk.core.compute_op import runner

    probed: list[bool] = []
    monkeypatch.setattr(runner, "_permission_prompt_open", lambda: probed.append(True) or True)
    said: list[str] = []
    installed: list[bool] = []

    def code_for(command):
        if command == "install jq":
            installed.append(True)
        return 0 if installed else 1

    answer = await _run_op(_spec(), _shell(code_for), tmp_path=tmp_path, on_status=said.append)
    assert answer.exit_code is ExitCode.OK
    assert probed == [] and not any("waiting for you" in s for s in said)


@pytest.mark.asyncio
async def test_a_window_the_command_opened_says_waiting_for_you_until_it_is_answered(tmp_path, monkeypatch):
    """An installer that opens its own window (not a UAC prompt) blocks silently too: the row must point at it."""
    import asyncio

    from flow_sdk.core.compute_op import runner

    window = {"open": True}
    asked_about: list = []

    def window_open(pid):
        asked_about.append(pid)
        return window["open"]

    monkeypatch.setattr(runner, "_permission_prompt_open", lambda: False)
    monkeypatch.setattr(runner, "_command_window_open", window_open)
    monkeypatch.setattr(runner, "_PERMISSION_PROMPT_POLL_SECONDS", 0.01)
    said: list[str] = []

    async def until(pred):
        while not pred():
            await asyncio.sleep(0.01)

    installed: list[bool] = []

    async def shell(command, *, on_spawn=None, **_kw):
        if command == "install jq":
            on_spawn(4242)
            await until(lambda: any("waiting for you" in s for s in said))
            window["open"] = False
            await until(lambda: said[-1] == "jq: cli")
            installed.append(True)
            return CliResult.of_process(command, 0, "", "")
        return CliResult.of_process(command, 0 if installed else 1, "", "")

    spec = _spec(exe_data={"commands": {"win32": "install jq"}}, completion_check={"commands": {"win32": "have jq"}})
    answer = await run_op(spec, trusted=True, workdir=tmp_path, platform="win32", shell=shell, on_status=said.append)

    assert answer.exit_code is ExitCode.OK
    assert any("waiting for you" in s and "window opened by the installer" in s and "taskbar" in s for s in said)
    assert 4242 in asked_about, "only the command's own windows are looked at"
    assert not any("Windows permission prompt" in s for s in said), "it is not a UAC prompt"


def test_no_window_is_looked_for_without_a_command_or_off_windows():
    from flow_sdk.core.compute_op import runner

    assert runner._command_window_open(None) is False
    assert runner._command_window_open(1234) is False  # not Windows here


@pytest.mark.asyncio
async def test_a_silent_install_shows_life_by_what_it_writes_to_its_own_temp_folder(tmp_path, monkeypatch):
    """A quiet installer prints nothing but downloads into TEMP: growth there is a sign of life, silence is not."""
    import asyncio
    import os

    from flow_sdk.core.compute_op import runner

    monkeypatch.setattr(runner, "_PROGRESS_POLL_SECONDS", 0.01)
    said: list[str] = []
    temps: list[str] = []
    installed: list[bool] = []

    async def shell(command, *, extra_env=None, **_kw):
        if command == "install jq":
            folder = extra_env["TEMP"]
            temps.append(folder)
            assert extra_env["TMP"] == folder == extra_env["TMPDIR"], "one folder, whichever variable the tool reads"
            before = said.count("jq: cli")
            await asyncio.sleep(0.05)  # silent: nothing written yet
            quiet = said.count("jq: cli")
            assert quiet == before, "nothing written, nothing said"
            with open(os.path.join(folder, "download.part"), "wb") as f:
                f.write(b"x" * 1000)
            await asyncio.sleep(0.1)
            assert said.count("jq: cli") > quiet, "growth re-says the rung, like output does"
            installed.append(True)
            return CliResult.of_process(command, 0, "", "")
        return CliResult.of_process(command, 0 if installed else 1, "", "")

    answer = await run_op(_spec(), trusted=True, workdir=tmp_path, platform="linux", shell=shell, on_status=said.append)

    assert answer.exit_code is ExitCode.OK
    assert temps and not os.path.exists(temps[0]), "the private folder is removed afterwards"


@pytest.mark.asyncio
async def test_an_agent_blocked_on_a_windows_permission_prompt_says_waiting_for_you(tmp_path, monkeypatch):
    import asyncio

    from flow_sdk.core.compute.process_step import ProcessProgress
    from flow_sdk.core.compute_op import runner

    prompt = {"open": True}
    monkeypatch.setattr(runner, "_permission_prompt_open", lambda: prompt["open"])
    monkeypatch.setattr(runner, "_PERMISSION_PROMPT_POLL_SECONDS", 0.01)
    said: list[str] = []

    async def until(pred):
        while not pred():
            await asyncio.sleep(0.01)

    async def launch(*, on_status, **_kw):
        await until(lambda: any("waiting for you" in s for s in said))
        on_status(ProcessProgress(text="jq: installing"))
        assert "waiting for you" in said[-1], "the agent's own line must not hide an open prompt"
        prompt["open"] = False
        await until(lambda: said[-1] == "jq: installing")
        return PromptResult.satisfied("The agent finished.")

    spec = _spec(subkind="agent", exe_data={"agent": "provisioner"}, completion_check=None)
    answer = await run_op(
        spec,
        trusted=True,
        workdir=tmp_path,
        platform="win32",
        shell=_shell(lambda _c: 0),
        launch=launch,
        on_status=said.append,
    )

    assert answer.exit_code is ExitCode.OK
