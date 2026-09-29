"""The shipped `install-vcredist` wizard: on Windows, ask before installing the Microsoft Visual C++
Runtime, and install it only on Send. Anywhere else, do nothing at all.

usearch (the RAG vector index) links MSVCP140.dll, which Python does not bundle and a clean Windows
does not ship. Search announces ``rag.runtime.missing`` the first time it finds the runtime missing
(``test_rag_runtime``) and this wizard's own trigger runs it; it is deliberately NOT a step of
first-run setup, so a person who never uses search is never asked.

The real documents off disk, the real runner, the real ask waiter. Only the shell is a double — a
machine that either has the runtime or does not — and the person is played by answering the
question the op raised, which is what the ask route does in production.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from flow_sdk.assets.types.wizard import read_wizard
from flow_sdk.core.compute_op import ask, ask_window
from flow_sdk.core.wizard.runner import Resolved, run_wizard
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.returned_value_spec import CliResult, ExitCode

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

ASSETS = Path(__file__).resolve().parents[2] / "flow_sdk/system_projects/flowpad_assistant/agentic-assets"
WIZARD = ASSETS / "wizard" / "install-vcredist"
ASK, INSTALL = "ask-install-vcredist", "vcredist-installed"


@pytest.fixture(autouse=True)
def _someone_is_looking(monkeypatch):
    monkeypatch.setenv("FLOWPAD_NO_BROWSER", "1")
    monkeypatch.setattr(ask, "_SERVED_HERE", True)

    async def shown(_question, **_kwargs):
        return True

    monkeypatch.setattr(ask_window, "raise_question", shown)
    ask._PENDING.clear()
    yield
    ask._PENDING.clear()


def _op(name: str) -> ComputeOpSpec:
    return ComputeOpSpec.model_validate(json.loads((ASSETS / "compute_op" / name / "compute_op.json").read_text()))


async def _resolve_op(name: str):
    return Resolved(_op(name), True) if (ASSETS / "compute_op" / name).is_dir() else None


class Machine:
    """A Windows box that has the runtime or not. Knows only the documents' own commands."""

    def __init__(self, installed: bool):
        self.installed = installed
        self.ran: list[str] = []
        self.checks = {
            _op(INSTALL).completion_check.command_for("win32"): "",
            _op(ASK).completion_check.command_for("win32"): "{}\n",
        }
        self.install = _op(INSTALL).exe_data.command_for("win32")

    async def shell(self, command: str, **_) -> CliResult:
        self.ran.append(command)
        if command in self.checks:
            return CliResult.of_process(
                command, 0 if self.installed else 1, self.checks[command] if self.installed else ""
            )
        if command == self.install:
            self.installed = True
            return CliResult.of_process(command, 0)
        raise AssertionError(f"unexpected command {command!r}")


async def _run(machine: Machine, platform: str, reply: str | None):
    asked: list[str] = []

    async def person():
        while True:
            for question in ask.open_questions():
                if question.op_name == ASK and reply is not None:
                    asked.append(question.op_name)
                    ask.answer(question.id, {}) if reply == "yes" else ask.cancel(question.id)
            await asyncio.sleep(0.01)

    task = asyncio.create_task(person())
    try:
        result = await run_wizard(
            read_wizard(WIZARD),
            trusted=True,
            platform=platform,
            workdir=Path.cwd(),
            shell=machine.shell,
            resolve_op=_resolve_op,
        )
    finally:
        task.cancel()
    return result, asked


def test_the_documents_parse_and_speak_only_windows():
    spec = read_wizard(WIZARD)
    assert spec is not None and [s.id for s in spec.steps] == ["ask", "install"]
    assert _op(ASK).output_spec_kind == "confirm"
    for name in (ASK, INSTALL):
        assert set(_op(name).completion_check.commands) == {"win32"}, name
    assert "Microsoft.VCRedist.2015+.x64" in _op(INSTALL).exe_data.command_for("win32")
    op = _op(INSTALL)
    assert [r.subkind for r in op.attempts] == ["agent"]
    assert op.attempts[0].exe_data.agent == "provisioner" and op.attempts[0].exe_data.retries == 1


def test_first_run_setup_never_asks_for_it():
    """Only search needs the runtime, so only search asks — not the setup every person sees."""
    setup = read_wizard(ASSETS / "wizard" / "llm-setup")
    assert "install-vcredist" not in [s.ref for s in setup.steps]


def test_search_reaches_it_through_its_own_trigger():
    """Search announces the missing runtime; this wizard's trigger is what runs it, so search
    never names the wizard. Not fire_once: a person who said "Not now" and later asks for search
    is asked again — search itself keeps it to once per such request (``test_rag_runtime``)."""
    from flow_sdk.rag.rag_on_tag import RUNTIME_MISSING_TAG

    trigger = json.loads((WIZARD / "agentic-assets/trigger/on-runtime-missing/trigger.json").read_text())
    assert trigger["tag"] == {"on": RUNTIME_MISSING_TAG}
    assert trigger["actions"] == [{"run_wizard": ""}]
    assert not trigger.get("fire_once")


async def test_installed_after_send():
    machine = Machine(installed=False)
    result, asked = await _run(machine, "win32", "yes")

    assert result.exit_code is ExitCode.OK, result.detail
    assert asked == [ASK]
    assert machine.installed and machine.install in machine.ran


async def test_not_now_installs_nothing():
    machine = Machine(installed=False)
    result, asked = await _run(machine, "win32", "cancel")

    assert asked == [ASK]
    assert not machine.installed and machine.install not in machine.ran
    assert "install" not in result.steps


async def test_already_installed_asks_nothing():
    machine = Machine(installed=True)
    result, asked = await _run(machine, "win32", None)

    assert result.exit_code is ExitCode.OK and asked == [] and machine.install not in machine.ran


@pytest.mark.parametrize("platform", ["darwin", "linux"])
async def test_off_windows_nothing_runs(platform):
    machine = Machine(installed=False)
    result, asked = await _run(machine, platform, None)

    assert result.exit_code is ExitCode.OK, result.detail
    assert asked == [] and machine.ran == []
