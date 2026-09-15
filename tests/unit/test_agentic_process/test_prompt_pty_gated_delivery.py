"""``AgenticProcess.prompt()`` types the prompt for a vendor whose PTY launch drops it.

Copilot and codex read the prompt from stdin, which a PTY launch never feeds:
``prompt()`` used to hand it over as ``start_pty(instruction=...)`` and copilot
booted to a ready composer with nothing typed, so the turn never started. Those
vendors now launch blank and type through ``_typed_pty_delivery``; a vendor whose
launch argument works (claude) keeps it.
"""

import asyncio
import re
from types import SimpleNamespace

import pytest

from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.cli_drivers.copilot.driver import CopilotDriver

pytestmark = pytest.mark.timeout(5)

MESSAGE = "Rebuild the index.\nROOT_PATH=/tmp/docs"


class _GatedShell:
    def __init__(self):
        self._composer = asyncio.Event()
        self.submitted: list[str] = []

    def release_composer(self):
        self._composer.set()

    async def wait_for_composer_ready(self, pattern) -> bool:
        assert isinstance(pattern, re.Pattern)
        await self._composer.wait()
        return True

    async def write_then_submit(self, text: str) -> None:
        self.submitted.append(text)


class _LaunchArgDriver:
    """A driver whose launch argument carries the prompt (claude-shaped)."""

    name = "claude"
    pty_submits_on_paste = True

    def __init__(self, pattern):
        self.pty_composer_ready_pattern = pattern


def _fake_process(shell, *, driver, running: bool):
    starts: list[str | None] = []
    sent: list = []

    async def _shell():
        return shell

    async def _is_running():
        return running

    async def _start_pty(instruction=None, **_kw):
        starts.append(instruction)
        return SimpleNamespace(status="SUCCESS")

    async def _send(data):
        sent.append(data)

    async def _reconcile_name(**_kw):
        return None

    fake = SimpleNamespace(
        id="proc-gated-prompt",
        driver=driver,
        pty_mode=True,
        exist_in_db=True,
        shell=_shell,
        is_running=_is_running,
        start_pty=_start_pty,
        send=_send,
        reconcile_name=_reconcile_name,
    )
    fake._typed_pty_delivery = AgenticProcess._typed_pty_delivery.__get__(fake)
    fake._schedule_gated_pty_delivery = AgenticProcess._schedule_gated_pty_delivery.__get__(fake)
    return fake, starts, sent


async def _settle():
    for _ in range(5):
        await asyncio.sleep(0)


async def test_cold_launch_dropping_vendor_launches_blank_and_types_after_the_composer():
    shell = _GatedShell()
    proc, starts, sent = _fake_process(shell, driver=CopilotDriver(), running=False)

    await AgenticProcess.prompt.__get__(proc)(MESSAGE)
    await _settle()

    assert starts == [None], "the launch must not carry a prompt the vendor drops"
    assert shell.submitted == [], "nothing may be typed before the composer is ready"

    shell.release_composer()
    await _settle()

    assert shell.submitted == [MESSAGE], "the prompt is typed exactly once, verbatim"
    assert sent == []


async def test_hot_launch_dropping_vendor_types_through_the_gate_not_a_raw_paste():
    shell = _GatedShell()
    shell.release_composer()
    proc, starts, sent = _fake_process(shell, driver=CopilotDriver(), running=True)

    await AgenticProcess.prompt.__get__(proc)(MESSAGE)
    await _settle()

    assert starts == []
    assert sent == [], "a raw paste with a trailing CR is literal text to copilot"
    assert shell.submitted == [MESSAGE]


@pytest.mark.parametrize("pattern", [None, re.compile(r"READY")], ids=["no-marker", "composer-marker"])
async def test_a_working_launch_argument_is_kept(pattern):
    shell = _GatedShell()
    proc, starts, sent = _fake_process(shell, driver=_LaunchArgDriver(pattern), running=False)

    await AgenticProcess.prompt.__get__(proc)(MESSAGE)
    await _settle()

    assert starts == [MESSAGE]
    assert shell.submitted == [] and sent == []
