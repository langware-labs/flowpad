"""``launch_step_process`` — one agent turn, answered as a ``PromptResult``.

With ``process_id`` it prompts THAT process: a further turn in the same
session, which is how a caller continues an agent op (``run_op(executor=…)``).
Nothing is spawned for it.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.schema.data_spec.returned_value_spec import ExitCode, PromptResult

pytestmark = pytest.mark.timeout(5)


class _Process:
    """An agent process: takes a turn, and ``wait()`` returns when it has ended."""

    def __init__(self):
        self.id = "proc-1"
        self.prompts: list = []

    async def wait(self, timeout=None, on_status=None):
        return None

    @property
    def typeid(self):
        return f"agentic_process-{self.id}"

    async def send_turn(self, text):
        self.prompts.append(text)
        return PromptResult.satisfied("The turn was accepted.", executor=self.typeid)

    #: How the worker ended (None: it idled, the way a good run ends).
    worker = None

    def fetch_worker_status(self):
        from flow_sdk.transcript_analyzer.worker_status import WorkerStatus  # noqa: PLC0415

        return self.worker or WorkerStatus.IDLE


@pytest.mark.asyncio
async def test_launch_with_a_process_id_prompts_that_process(monkeypatch, tmp_path):
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
    from flow_sdk.core.compute import process_step

    process = _Process()

    async def get_by_typeid(typeid):
        return process if str(typeid) == "agentic_process-proc-1" else None

    async def no_spawn(*_a, **_kw):
        raise AssertionError("a further turn must not spawn a process")

    monkeypatch.setattr(AgenticProcess, "get_by_typeid", staticmethod(get_by_typeid))
    monkeypatch.setattr("flow_sdk.builtin.agent_registry.get_agent_local_deployment", no_spawn)

    result = await process_step.launch_step_process(
        agent="provisioner",
        prompt="again",
        name="kafka",
        workdir=Path(tmp_path),
        executor="agentic_process-proc-1",
    )
    assert isinstance(result, PromptResult)
    assert result.ok and result.executor == "agentic_process-proc-1"
    assert process.prompts == ["again"]

    gone = await process_step.launch_step_process(
        agent="provisioner",
        prompt="again",
        name="kafka",
        workdir=Path(tmp_path),
        executor="agentic_process-proc-9",
    )
    assert not gone.ok and gone.ran is False and "no longer exists" in gone.detail


@pytest.mark.asyncio
async def test_a_turn_that_runs_out_of_time_says_so(monkeypatch, tmp_path):
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
    from flow_sdk.core.compute import process_step

    class _Slow(_Process):
        async def wait(self, timeout=None, on_status=None):
            raise TimeoutError  # the turn outlived its budget

    async def get_by_typeid(_typeid):
        return _Slow()

    monkeypatch.setattr(AgenticProcess, "get_by_typeid", staticmethod(get_by_typeid))
    result = await process_step.launch_step_process(
        agent="provisioner",
        prompt="again",
        name="kafka",
        workdir=Path(tmp_path),
        executor="agentic_process-proc-1",
    )
    # Busy, not finished: the executor is named so the caller knows WHICH
    # process is still running — and must not be prompted on top of itself.
    assert result.timed_out and result.exit_code is ExitCode.NOT_YET
    assert result.executor == "agentic_process-proc-1"


@pytest.mark.asyncio
async def test_an_agent_that_ended_in_error_is_not_reported_as_done(monkeypatch, tmp_path):
    """`wait()` returns on any terminal state, FAILED included. The step used to
    answer `satisfied` regardless, so an agent op with no completion check — a
    continuation — reported a crashed agent as done."""
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
    from flow_sdk.core.compute import process_step
    from flow_sdk.schema.data_spec.returned_value_spec import ExitCode
    from flow_sdk.transcript_analyzer.worker_status import WorkerStatus

    process = _Process()
    process.worker = WorkerStatus.ERROR

    async def get_by_typeid(typeid):
        return process

    monkeypatch.setattr(AgenticProcess, "get_by_typeid", staticmethod(get_by_typeid))
    answer = await process_step.launch_step_process(
        agent="provisioner",
        prompt="do it",
        name="kafka",
        workdir=Path(tmp_path),
        executor=process.typeid,
    )
    assert answer.exit_code is ExitCode.NOT_YET, answer.detail
    assert answer.executor == process.typeid


@pytest.mark.asyncio
async def test_only_a_change_in_what_the_agent_reports_counts_as_a_sign_of_life(monkeypatch, tmp_path):
    """`wait` polls every 2s and reports each time. Forwarding every poll would stamp the row alive
    whether or not the agent did anything; only a change (state, item, counters) is progress."""
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
    from flow_sdk.core.compute import process_step

    process = _Process()
    reports = iter(["a", "a", "a", "b", "b"])

    async def wait(timeout=None, on_status=None):
        for status in reports:
            on_status(status)

    process.wait = wait

    async def get_by_typeid(typeid):
        return process

    monkeypatch.setattr(AgenticProcess, "get_by_typeid", staticmethod(get_by_typeid))
    monkeypatch.setattr(
        process_step,
        "_progress_for",
        lambda _pid, ws: process_step.ProcessProgress(text="working", counters={"tokens": ws}),
    )
    said = []
    await process_step.launch_step_process(
        agent="provisioner",
        prompt="go",
        name="x",
        workdir=Path(tmp_path),
        executor="agentic_process-proc-1",
        on_status=said.append,
    )
    # Five polls, two distinct reports: the repeats said nothing.
    assert [p.counters["tokens"] for p in said if p.text == "working"][-2:] == ["a", "b"]
    assert sum(1 for p in said if p.text == "working") == 2


@pytest.mark.asyncio
async def test_the_agents_transcript_growing_is_a_sign_of_life_even_when_its_report_is_unchanged(monkeypatch, tmp_path):
    """The counters can sit still through a long tool call while the agent's transcript keeps
    growing — that is real activity, so it must reach the row."""
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
    from flow_sdk.core.compute import process_step

    process = _Process()
    signatures = iter([(10, 1), (10, 1), (25, 2), (25, 2)])
    process.wait = None

    async def wait(timeout=None, on_status=None):
        for _ in range(4):
            on_status("working")

    process.wait = wait

    async def get_by_typeid(typeid):
        return process

    monkeypatch.setattr(AgenticProcess, "get_by_typeid", staticmethod(get_by_typeid))
    monkeypatch.setattr(
        process_step, "_progress_for", lambda _pid, _ws: process_step.ProcessProgress(text="working", counters={})
    )
    monkeypatch.setattr(process_step, "_transcript_signature", lambda _p: next(signatures))
    said = []
    await process_step.launch_step_process(
        agent="provisioner",
        prompt="go",
        name="x",
        workdir=Path(tmp_path),
        executor="agentic_process-proc-1",
        on_status=said.append,
    )
    # Four polls, the transcript moved once between the second and third: two updates, not four.
    assert len(said) == 2


@pytest.mark.asyncio
async def test_a_command_doing_work_is_a_sign_of_life_and_the_row_says_so(monkeypatch, tmp_path):
    """One long command (a download + unpack) leaves the agent's report AND transcript still for
    minutes — on the clean-Windows VM the row read "may be stuck" while Node was downloading. The
    command's own CPU and I/O growing is real activity; a command sitting still is not."""
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
    from flow_sdk.core.compute import process_step

    process = _Process()
    activity = iter([None, (1, 0.1, 100), (1, 0.6, 9_000), (1, 0.6, 9_000)])

    async def wait(timeout=None, on_status=None):
        for _ in range(4):
            on_status("working")

    process.wait = wait

    async def get_by_typeid(typeid):
        return process

    monkeypatch.setattr(AgenticProcess, "get_by_typeid", staticmethod(get_by_typeid))
    monkeypatch.setattr(
        process_step, "_progress_for", lambda _pid, _ws: process_step.ProcessProgress(text="working", counters={})
    )
    monkeypatch.setattr(process_step, "_transcript_signature", lambda _p: (10, 1))
    monkeypatch.setattr(process_step, "_command_activity", lambda _pid: next(activity))
    said = []
    await process_step.launch_step_process(
        agent="provisioner",
        prompt="go",
        name="x",
        workdir=Path(tmp_path),
        executor="agentic_process-proc-1",
        on_status=said.append,
    )
    # Nothing running, then a command started, then it did more work, then it sat still: three.
    assert [p.text for p in said] == ["working", *[f"working · {process_step.RUNNING_A_COMMAND}"] * 2]


def test_command_activity_measures_the_agents_child_processes(monkeypatch):
    """Real processes: a busy child moves the numbers; no worker, or no child, is ``None``."""
    import os
    import subprocess
    import sys
    import time

    from flow_sdk.builtin.agentic_process import agentic_process
    from flow_sdk.core.compute import process_step

    assert process_step._command_activity("no-such-process") is None

    monkeypatch.setattr(agentic_process, "prompt_worker_pid", lambda _pid: os.getpid())
    busy = subprocess.Popen(
        [sys.executable, "-c", "import time\nend = time.time() + 0.6\nwhile time.time() < end: pass"]
    )
    try:
        time.sleep(0.15)
        first = process_step._command_activity("proc-1")
        time.sleep(0.3)
        later = process_step._command_activity("proc-1")
    finally:
        busy.wait(timeout=5)
    assert first is not None and later is not None
    assert later[1] > first[1], "a busy command's CPU time grows between polls"


class _Deployment:
    """Creates the agent process; counts how often it was asked to, and can fail doing it."""

    def __init__(self, process, error=None):
        self.process, self.error, self.created = process, error, 0

    async def create_process(self, *_a, **_kw):
        self.created += 1
        if self.error is not None:
            raise self.error
        return self.process


def _spawn_path(monkeypatch, *, deployment, refusals, settled):
    """The spawn path with a scripted funding verdict (`refusals`, one per `_unfunded` call) and a
    scripted answer from the chooser (`settled`); returns the list of chooser calls."""
    from flow_sdk.core.compute import process_step
    from flow_sdk.schema.data_spec.returned_value_spec import CliResult

    class _Worker:
        value = "claude"

    async def deployment_for(_agent):
        return deployment

    async def worker_type():
        return _Worker()

    verdicts = iter(refusals)

    async def unfunded(_worker):
        return next(verdicts)

    asked = []

    async def settle(**kw):
        asked.append(kw)
        return CliResult.satisfied("funded") if settled else CliResult.not_yet("skipped")

    async def save(_self, **_kw):
        return None

    monkeypatch.setattr(_Process, "save", save, raising=False)
    monkeypatch.setattr("flow_sdk.builtin.agent_registry.get_agent_local_deployment", deployment_for)
    monkeypatch.setattr("flow_sdk.core.capabilities.registry.resolve_builtin_worker_type", worker_type)
    monkeypatch.setattr(process_step, "_unfunded", unfunded)
    monkeypatch.setattr(process_step, "settle_llm_source", settle)
    return asked


async def _launch(tmp_path, **kw):
    from flow_sdk.core.compute import process_step

    return await process_step.launch_step_process(
        agent="provisioner", prompt="go", name="x", workdir=Path(tmp_path), **kw
    )


@pytest.mark.asyncio
async def test_a_funded_agent_never_asks_for_an_llm_source(monkeypatch, tmp_path):
    deployment = _Deployment(_Process())
    asked = _spawn_path(monkeypatch, deployment=deployment, refusals=[None], settled=True)
    result = await _launch(tmp_path)
    assert asked == [] and deployment.created == 1 and result.ok


@pytest.mark.asyncio
async def test_no_llm_source_asks_the_person_once_then_launches_with_the_one_they_pick(monkeypatch, tmp_path):
    deployment = _Deployment(_Process())
    # Refused before the chooser, funded after it.
    asked = _spawn_path(monkeypatch, deployment=deployment, refusals=["no source is configured", None], settled=True)
    said = []
    result = await _launch(tmp_path, on_status=said.append)
    assert asked == [{"only_if_watched": True}], "asked once, and only when someone is watching"
    assert deployment.created == 1 and result.ok
    assert any("choose an LLM source" in p.text for p in said), "the row says what it is waiting for"


@pytest.mark.asyncio
async def test_a_skipped_chooser_leaves_the_step_failing_with_the_reason(monkeypatch, tmp_path):
    deployment = _Deployment(_Process())
    _spawn_path(monkeypatch, deployment=deployment, refusals=["no source is configured"], settled=False)
    result = await _launch(tmp_path)
    assert not result.ok and result.ran is False
    assert "no usable LLM source" in result.detail and "no source is configured" in result.detail
    assert deployment.created == 0, "nothing was launched without a source"


@pytest.mark.asyncio
async def test_a_failure_that_is_not_about_the_llm_source_never_opens_the_chooser(monkeypatch, tmp_path):
    deployment = _Deployment(_Process(), error=RuntimeError("harness exploded"))
    asked = _spawn_path(monkeypatch, deployment=deployment, refusals=[None], settled=True)
    result = await _launch(tmp_path)
    assert asked == [], "a funded agent that fails to start is not a reason to pick another source"
    assert not result.ok and "harness exploded" in result.detail


@pytest.mark.asyncio
async def test_a_driver_that_draws_on_no_llm_source_is_never_refused_for_lacking_one(monkeypatch):
    """The spawn asks the driver that will ACTUALLY run about its source. A mock or bootstrap driver
    has no API-auth spec and needs none, so it is never refused — even when the harness name that
    was resolved (`claude`) would have needed one. No funding lookup, no chooser: the agent runs."""
    from flow_sdk.builtin.agentic_process import agentic_process
    from flow_sdk.builtin.agentic_process.cli_drivers import llm_source
    from flow_sdk.core.compute import process_step

    class _Resolved:
        value = "claude"

    class _MockDriver:
        name = "mock"

    async def picker(*_a, **_kw):
        raise AssertionError("a driver with no source must not be looked up for funding")

    monkeypatch.setattr(agentic_process, "get_driver", lambda _t: _MockDriver())
    monkeypatch.setattr(llm_source, "llm_picker_view", picker)
    assert await process_step._unfunded(_Resolved()) is None
