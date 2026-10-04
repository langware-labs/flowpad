"""`flow wizard run` / `flow op run` with no backend: a shipped wizard runs in this process.

The pieces a wheel-only box needs to install a harness by itself: the shipped folders read from
disk, confirm questions answered by `--yes` (and only those), the answer saying WHICH call settled
it, and discovery finding a CLI where its installer put it rather than only on PATH.
"""

from __future__ import annotations

import asyncio
import stat

import pytest

from flow_sdk.core.capabilities import discovery
from flow_sdk.core.compute_op import ask
from flow_sdk.core.wizard import local_run
from flow_sdk.schema.data_spec.returned_value_spec import AskResult, CliResult, PromptResult

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval


@pytest.fixture(autouse=True)
def _no_questions_left():
    ask._PENDING.clear()
    yield
    ask._PENDING.clear()


def test_every_harness_wizard_and_its_ops_read_from_disk():
    for harness in ("claude-code", "codex", "copilot", "opencode"):
        assert local_run.read_op(f"{harness}-on-path") is not None, harness
        assert local_run.read_op(f"ask-install-{harness}") is not None, harness
    assert local_run.read_op("no-such-op") is None


async def test_the_shipped_wizard_resolves_trusted():
    found = await local_run.resolve_wizard("llm-setup-codex")
    assert found is not None and found.trusted and found.spec.name == "llm-setup-codex"
    assert await local_run.resolve_wizard("no-such-wizard") is None


@pytest.mark.parametrize(
    ("answer", "by"),
    [
        (CliResult.satisfied("installed", ran=True), "cli"),
        (CliResult.satisfied("already", ran=False), "already"),
        (CliResult.not_yet("not installed yet", ran=False), "nothing"),
        (PromptResult.satisfied("rescued", executor="agentic_process-1"), "agent"),
        (AskResult.satisfied("answered"), "ask"),
    ],
)
def test_the_answer_says_which_call_settled_it(answer, by):
    assert local_run.satisfied_by(answer) == by


async def _ask(shape: str) -> AskResult:
    return await ask.ask_person("op", f"a {shape}?", shape, timeout=None, label="op")


async def test_yes_answers_a_confirm_question_with_no_tab_to_show_it():
    """No tab, no window: the answerer in this process is the person, so `until_answered` waits for
    it instead of concluding nobody could be shown the question."""
    said: list[str] = []
    answer = await local_run._answered(_ask("confirm"), yes=True, say=said.append)
    assert answer.ok, answer.detail
    assert any("yes (--yes)" in line for line in said)


async def test_yes_never_answers_a_question_that_needs_a_person():
    said: list[str] = []
    answer = await local_run._answered(_ask("string"), yes=True, say=said.append)
    assert not answer.ok and answer.cancelled
    assert any("needs a person" in line for line in said)


async def test_without_yes_a_confirm_is_declined_at_once_not_after_a_wait():
    said: list[str] = []
    answer = await asyncio.wait_for(local_run._answered(_ask("confirm"), yes=False, say=said.append), timeout=2)
    assert answer.cancelled
    assert any("pass --yes" in line for line in said)


def test_discovery_finds_a_cli_where_its_installer_put_it(tmp_path, monkeypatch):
    """`~/.opencode/bin` is on nobody's PATH until a new login shell reads the rc the installer
    edited — the binary is on disk long before that."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("PATH", "/nonexistent")
    folder = tmp_path / ".opencode" / "bin"
    folder.mkdir(parents=True)
    binary = folder / "opencode"
    binary.write_text("#!/bin/sh\necho 1.0\n")
    binary.chmod(binary.stat().st_mode | stat.S_IEXEC)

    assert discovery.in_install_dirs("opencode") == str(binary)
    assert discovery.in_install_dirs("claude") is None  # its folder is ~/.local/bin, which is empty
    assert discovery.in_install_dirs("not-a-harness") is None
