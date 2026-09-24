"""``AgenticProcess.input()`` types into a live PTY only once the composer is up.

A resuming claude TUI goes quiet for ~300ms between its terminal probes and the
transcript repaint, and discards anything typed into that gap. ``input()`` used to
gate on output quiescence alone, so the first line typed after a Vibe→terminal
switch was lost (vibe_return_from_terminal_reconcile step 3). It now waits for
the vendor's composer marker — the same gate ``prompt()`` types behind — and
keeps quiescence only for a vendor that declares no marker.
"""

import asyncio
import re
from types import SimpleNamespace

import pytest

from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

pytestmark = pytest.mark.timeout(5)


class _Shell:
    def __init__(self, *, composer_opens: bool = True):
        self._composer = asyncio.Event()
        self._composer_opens = composer_opens
        self.quiet_waits = 0

    def paint_composer(self):
        self._composer.set()

    async def wait_for_composer_ready(self, pattern) -> bool:
        assert isinstance(pattern, re.Pattern)
        await self._composer.wait()
        return self._composer_opens

    async def wait_for_input_ready(self) -> None:
        self.quiet_waits += 1


def _process(shell, pattern):
    sent: list = []

    async def _shell():
        return shell

    async def _is_running():
        return True

    async def _send(data):
        sent.append(data)

    fake = SimpleNamespace(
        id="proc-input-gate",
        driver=SimpleNamespace(pty_composer_ready_pattern=pattern),
        pty_mode=True,
        shell=_shell,
        is_running=_is_running,
        send=_send,
    )
    fake._is_live_pty = AgenticProcess._is_live_pty.__get__(fake)
    return AgenticProcess.input.__get__(fake), sent


async def _settle():
    for _ in range(5):
        await asyncio.sleep(0)


async def test_nothing_is_typed_until_the_composer_paints():
    shell = _Shell()
    input_, sent = _process(shell, re.compile(r"READY"))

    typing = asyncio.create_task(input_("hello"))
    await _settle()
    assert sent == [], "a keystroke typed before the composer is up is discarded by the TUI"

    shell.paint_composer()
    result = await typing

    assert sent == [b"hello"], "typed once, raw (no Enter), after the composer"
    assert result.data["status"] == "typed"
    assert shell.quiet_waits == 0, "the composer marker replaces quiescence, it is not added to it"


async def test_a_terminal_that_closes_first_types_nothing_and_says_so():
    shell = _Shell(composer_opens=False)
    shell.paint_composer()
    input_, sent = _process(shell, re.compile(r"READY"))

    result = await input_("hello")

    assert sent == []
    assert result.status != "success"


async def test_a_vendor_without_a_marker_keeps_the_quiescence_gate():
    shell = _Shell()
    input_, sent = _process(shell, None)

    await input_("hello")

    assert shell.quiet_waits == 1 and sent == [b"hello"]
