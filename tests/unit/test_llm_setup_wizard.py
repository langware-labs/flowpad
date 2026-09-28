"""The shipped `llm-setup` wizard: ask before installing, never install
unasked, and fall back to an agent when the plain install command does not get
there. (The LLM source is settled BEFORE this wizard — `run_llm_setup`, covered
in `test_wizard_trigger_reconcile.py` — so here it is simply present or not.)

The real documents off disk, the real runner, the real ask waiter. Only the
shell is a double — a fake machine whose tools are a set — and the person is
played by answering the question the op raised, which is what the ask route
does in production.

The rule under test is the whole point of the wizard: a tool that is present is
neither asked about nor installed; a missing one is asked about, and installed
only when the person presses Send. Every case runs per platform, because the
product ships on Windows and Unix and each OS has its own commands.
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
from flow_sdk.schema.data_spec.returned_value_spec import CliResult, ExitCode, PromptResult

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

ASSETS = Path(__file__).resolve().parents[2] / "flow_sdk/system_projects/flowpad_assistant/agentic-assets"
TOOLS = ("jq", "ripgrep", "claude-code", "python", "git", "node", "npm")
#: Each tool whose install op carries an agent `fallback`. npm has none: it ships
#: with node's own installer, and on apt it is a plain second package.
AGENT_FALLBACK = ("jq", "ripgrep", "claude-code", "python", "git", "node")
#: Whether the box has an LLM source. Settled before the wizard; here it only
#: decides whether an agent fallback can run.
LLM = "llm"
EVERYTHING = {*TOOLS, LLM}
PLATFORMS = pytest.mark.parametrize("platform", ["darwin", "linux", "win32"])


@pytest.fixture(autouse=True)
def _no_browser(monkeypatch):
    monkeypatch.setenv("FLOWPAD_NO_BROWSER", "1")
    # The answers below are delivered in THIS process, so it plays the backend.
    monkeypatch.setattr(ask, "_SERVED_HERE", True)


@pytest.fixture(autouse=True)
def _someone_is_looking(monkeypatch):
    """A person sees every question. The asks wait with no deadline, and a
    question nobody could be shown is abandoned at once — so without this the
    runs below would give up before `_person` could answer. The headless case
    has its own test, with the real raiser."""

    async def shown(_question, **_kwargs):
        return True

    monkeypatch.setattr(ask_window, "raise_question", shown)


@pytest.fixture(autouse=True)
def _only_our_questions():
    ask._PENDING.clear()
    yield
    ask._PENDING.clear()


def _op(name: str) -> ComputeOpSpec:
    return ComputeOpSpec.model_validate(json.loads((ASSETS / "compute_op" / name / "compute_op.json").read_text()))


async def _resolve_op(name: str):
    return Resolved(_op(name), True) if (ASSETS / "compute_op" / name).is_dir() else None


async def _resolve_wizard(name: str):
    spec = read_wizard(ASSETS / "wizard" / name)
    return None if spec is None else Resolved(spec, True)


class Machine:
    """A machine whose installed tools are a set.

    Every command it knows is read off the documents for ``platform``: each
    op's check answers from the set, and an install command adds every tool
    whose install op uses it — so `brew install node` bringing npm along is the
    documents' own claim, not the test's. A command it does not know fails the
    test, which is what catches an op that runs something it should not.

    An install command the documents deliberately broke (a package id that does
    not exist) fails and installs nothing, as it would for real. An agent
    installs the tool it was launched for — when the box has an LLM source to
    run it on.
    """

    def __init__(self, platform: str, installed: set[str]):
        self.installed = set(installed)
        self.ran: list[str] = []
        self.agents: list[str] = []
        self.checks: dict[str, tuple[str, bool]] = {}
        self.installs: dict[str, set[str]] = {}
        self.broken: set[str] = set()
        self.by_agent_label: dict[str, str] = {}
        for tool in TOOLS:
            install, question = _op(f"{tool}-on-path"), _op(f"ask-install-{tool}")
            self.checks[install.completion_check.command_for(platform)] = (tool, False)
            # An ask op's check prints the value it returns: the empty confirm.
            self.checks[question.completion_check.command_for(platform)] = (tool, True)
            command = install.exe_data.command_for(platform)
            if "deliberately" in command.lower():
                self.broken.add(command)
            else:
                self.installs.setdefault(command, set()).add(tool)
        for tool in AGENT_FALLBACK:
            # The fallback runs under its op's own label — one op, one name.
            self.by_agent_label[_op(f"{tool}-on-path").display_label] = tool

    async def shell(self, command: str, **_) -> CliResult:
        self.ran.append(command)
        if command in self.checks:
            tool, echoes = self.checks[command]
            if tool not in self.installed:
                return CliResult.of_process(command, 1)
            return CliResult.of_process(command, 0, "{}\n" if echoes else "")
        if command in self.broken:
            return CliResult.of_process(command, 1, stderr="No package found matching input criteria.")
        if command in self.installs:
            self.installed |= self.installs[command]
            return CliResult.of_process(command, 0)
        raise AssertionError(f"unexpected command {command!r}")

    async def launch(self, *, name: str, **_) -> PromptResult:
        if LLM not in self.installed:
            return PromptResult.not_yet("No LLM source can fund the agent.", ran=False)
        tool = self.by_agent_label[name]
        self.agents.append(tool)
        self.installed.add(tool)
        return PromptResult.satisfied(f"installed {tool}")

    @property
    def installed_anything(self) -> bool:
        return any(command in self.installs for command in self.ran)


async def _person(replies: dict[str, str], asked: list[str]) -> None:
    """Answer every question raised: Send for "yes", Cancel otherwise."""
    while True:
        for question in ask.open_questions():
            reply = replies.get(question.op_name)
            if reply is None:
                # Not one this test is driving — e.g. a give-up race, where the
                # registry can show the question for a poll or two before it is
                # forgotten. Leave it; asserting on it is that test's job, and
                # `replies[...]` would KeyError here and be silently dropped.
                continue
            asked.append(question.op_name)
            if reply == "yes":
                ask.answer(question.id, {})
            else:
                ask.cancel(question.id)
        await asyncio.sleep(0.01)


async def _run(machine: Machine, platform: str, replies: dict[str, str]):
    asked: list[str] = []
    person = asyncio.create_task(_person(replies, asked))
    try:
        result = await run_wizard(
            read_wizard(ASSETS / "wizard" / "llm-setup"),
            trusted=True,
            platform=platform,
            workdir=Path.cwd(),
            shell=machine.shell,
            launch=machine.launch,
            resolve_op=_resolve_op,
            resolve_wizard=_resolve_wizard,
            parent=_Node(),
        )
    finally:
        person.cancel()
    return result, asked


class _Node:
    """A stand-in Activity node, so the run needs no server."""

    def __getattr__(self, _name):
        return lambda *a, **k: self


def test_every_document_parses():
    # npm has no sub-wizard of its own: its ask/install are steps of
    # llm-setup-node, reached only after node's own ask/install (see
    # `test_declining_node_never_asks_about_npm`).
    setup = read_wizard(ASSETS / "wizard" / "llm-setup")
    assert [s.id for s in setup.steps] == ["jq", "ripgrep", "claude-code", "python", "git", "node"]
    for tool in AGENT_FALLBACK:
        sub = read_wizard(ASSETS / "wizard" / f"llm-setup-{tool}")
        assert sub is not None, tool
        assert [s.id for s in sub.steps][:2] == ["ask", "install"]
    assert not (ASSETS / "wizard" / "llm-setup-npm").exists()
    node = read_wizard(ASSETS / "wizard" / "llm-setup-node")
    assert [s.id for s in node.steps] == ["ask", "install", "ask_npm", "install_npm"]
    for tool in TOOLS:
        assert _op(f"ask-install-{tool}").output_spec_kind == "confirm"


def test_every_install_falls_back_to_an_agent_with_one_retry():
    """The ladder is in the op: the command, then `provisioner` on the same check,
    with one more turn in its session if the check still fails."""
    for tool in AGENT_FALLBACK:
        op = _op(f"{tool}-on-path")
        assert op.subkind == "cli" and [r.subkind for r in op.attempts] == ["agent"], tool
        assert op.attempts[0].exe_data.agent == "provisioner" and op.attempts[0].exe_data.retries == 1, tool
        assert not (ASSETS / "compute_op" / f"{tool}-on-path-agent").exists(), "the agent lives in the op now"


def test_windows_never_asks_for_python3_or_the_npm_script():
    """`python3` on a stock Windows is the Store alias stub, and `npm` resolves
    to npm.ps1, which the default execution policy blocks. Either would make a
    check fail on a machine that has the tool."""
    for name in ("python-on-path", "ask-install-python"):
        assert "python3" not in _op(name).completion_check.command_for("win32")
    for name in ("npm-on-path", "ask-install-npm"):
        assert "npm.cmd --version" in _op(name).completion_check.command_for("win32")


@PLATFORMS
async def test_everything_installed_asks_nothing_and_installs_nothing(platform):
    machine = Machine(platform, EVERYTHING)
    result, asked = await _run(machine, platform, {})

    assert result.exit_code is ExitCode.OK
    assert result.ran is False
    assert asked == []
    assert not machine.installed_anything
    assert machine.agents == []


@PLATFORMS
async def test_a_missing_tool_is_installed_only_after_send(platform):
    machine = Machine(platform, EVERYTHING - {"node", "npm"})
    result, asked = await _run(machine, platform, {"ask-install-node": "yes", "ask-install-npm": "yes"})

    assert result.exit_code is ExitCode.OK
    assert machine.installed == EVERYTHING
    # node's own command is deliberately broken (see its setup.md), so the
    # agent installs it — not the bundled `brew install node` / winget command,
    # so npm is not brought along for free the way a working one would.
    assert machine.agents == ["node"]
    assert asked == ["ask-install-node", "ask-install-npm"]


@PLATFORMS
async def test_cancel_leaves_the_tool_uninstalled_and_the_run_goes_on(platform):
    machine = Machine(platform, EVERYTHING - {"git"})
    result, asked = await _run(machine, platform, {"ask-install-git": "cancel"})

    assert result.exit_code is ExitCode.NOT_YET
    assert asked == ["ask-install-git"]
    assert not machine.installed_anything
    # The cancelled tool's sub-wizard stopped before its install step...
    git = result.steps["git"]
    assert "install" not in git.steps and git.steps["ask"].cancelled
    # ...and the tool after it — node, with npm folded into the same
    # sub-wizard — was still checked in full.
    node = result.steps["node"]
    assert node.ok
    assert set(node.steps) == {"ask", "install", "ask_npm", "install_npm"}


@PLATFORMS
async def test_declining_node_never_asks_about_npm(platform):
    """npm is folded into node's own sub-wizard, checked strictly AFTER it —
    so a person who declines Node.js is never followed by a second, orphaned
    question about npm, which is useless without it."""
    machine = Machine(platform, EVERYTHING - {"node", "npm"})  # node AND npm both missing
    result, asked = await _run(machine, platform, {"ask-install-node": "cancel"})

    assert result.exit_code is ExitCode.NOT_YET
    assert asked == ["ask-install-node"]
    assert not machine.installed_anything
    node = result.steps["node"]
    # "no activity child for a step never reached" (core/wizard/runner.py) —
    # ask_npm/install_npm are simply ABSENT, not present-and-skipped.
    assert set(node.steps) == {"ask"}
    assert node.steps["ask"].cancelled


def test_it_runs_once_on_the_first_ui_load():
    """`fire_once`: the first tab that loads after install runs setup, and it
    never runs on its own again — Settings → General runs it on demand. A tab,
    not `app.ready`: the chooser and the questions need someone looking."""
    trigger = json.loads((ASSETS / "wizard/llm-setup/agentic-assets/trigger/on-tab-ready/trigger.json").read_text())
    assert trigger["tag"] == {"on": "app.tab.ready"}
    assert trigger["fire_once"] is True


async def test_a_question_waits_with_no_deadline(monkeypatch):
    for tool in TOOLS:
        assert _op(f"ask-install-{tool}").exe_data.until_answered

    deadlines = []
    real_wait = ask.wait_for

    async def spy(question, *, timeout):
        deadlines.append(timeout)
        return await real_wait(question, timeout=timeout)

    monkeypatch.setattr(ask, "wait_for", spy)
    machine = Machine("darwin", EVERYTHING - {"git"})
    result, asked = await _run(machine, "darwin", {"ask-install-git": "yes"})

    assert result.exit_code is ExitCode.OK
    assert deadlines == [None]


@PLATFORMS
async def test_nobody_to_ask_gives_up_after_the_presence_grace_and_installs_nothing(platform, monkeypatch):
    """A headless instance (a sandbox, a VM) has no tab and no browser, ever —
    not even within the boot-race grace window (`test_a_live_tab_connecting...`
    covers that one connecting late). With no deadline, waiting there would
    never end and would hold the wizard's slot for good, so the question is
    dropped and the run moves on."""
    from flow_sdk.core.compute_op import ask as op_ask

    monkeypatch.setattr(op_ask, "PRESENCE_GRACE_SECONDS", 0.03)
    monkeypatch.setattr(op_ask, "PRESENCE_POLL_SECONDS", 0.01)
    # Every tool but python is missing. Each one's OWN ask gives up in turn —
    # keyed by op name because their calls interleave in one flat timeline
    # otherwise. npm's ask is never reached at all: it is node's
    # sub-wizard's THIRD step, behind `on_fail: abort` on node's own ask giving
    # up — asking it too would just reach the identical "nobody's there"
    # conclusion a second time, 15s later, for nothing.
    calls: dict[str, list[bool]] = {}

    async def not_shown(question, **kwargs):
        calls.setdefault(question.op_name, []).append(kwargs.get("try_window", True))
        return False

    monkeypatch.setattr(ask_window, "raise_question", not_shown)
    machine = Machine(platform, {"python", LLM})
    result, asked = await _run(machine, platform, {})

    assert result.exit_code is ExitCode.NOT_YET
    assert asked == [] and ask.open_questions() == []
    assert not machine.installed_anything
    assert machine.agents == []
    assert set(calls) == {f"ask-install-{tool}" for tool in ("jq", "ripgrep", "claude-code", "git", "node")}
    assert set(result.steps["node"].steps) == {"ask"}
    for op_calls in calls.values():
        # The FIRST attempt may still open a browser; every retry after it
        # must not — that would spam a fresh tab on every poll of a box with
        # no tab.
        assert op_calls[0] is True
        assert all(call is False for call in op_calls[1:])
        assert len(op_calls) > 1  # the grace window actually polled more than once


async def test_a_live_tab_connecting_during_the_grace_window_is_still_shown(monkeypatch):
    """The boot race this grace window exists for: `app.ready` can fire before
    the app's own tab finishes its WS handshake. A tab that shows up a moment
    late must still get the question — not lose it to a give-up that fired
    first."""
    from flow_sdk.core.compute_op import ask as op_ask

    monkeypatch.setattr(op_ask, "PRESENCE_GRACE_SECONDS", 0.2)
    monkeypatch.setattr(op_ask, "PRESENCE_POLL_SECONDS", 0.02)
    attempts = []

    async def connects_on_the_third_try(_question, **kwargs):
        attempts.append(kwargs.get("try_window", True))
        return len(attempts) >= 3

    monkeypatch.setattr(ask_window, "raise_question", connects_on_the_third_try)
    machine = Machine("darwin", EVERYTHING - {"python"})
    result, asked = await _run(machine, "darwin", {"ask-install-python": "yes"})

    assert result.exit_code is ExitCode.OK
    assert asked == ["ask-install-python"]
    assert machine.installed == EVERYTHING
    assert result.steps["git"].steps["ask"].ran is False
    assert result.steps["node"].steps["ask"].ran is False
    assert result.steps["node"].steps["ask_npm"].ran is False


# ── The LLM source, and the agent rung behind a failed command ───────────────


@PLATFORMS
async def test_a_failed_install_command_falls_back_to_the_agent(platform):
    """jq's, ripgrep's, claude-code's and node's install commands are broken on
    purpose (see their setup.md). The command fails, the agent reaches the same
    goal, and the run is a success — a rung covered by a later one is not a
    failure."""
    broken = ("jq", "ripgrep", "claude-code", "node")
    machine = Machine(platform, EVERYTHING - set(broken))
    result, asked = await _run(machine, platform, {f"ask-install-{tool}": "yes" for tool in broken})

    assert result.exit_code is ExitCode.OK, result.detail
    assert asked == [f"ask-install-{tool}" for tool in broken]
    assert machine.agents == list(broken)
    assert machine.installed == EVERYTHING
    for tool in broken:
        install = result.steps[tool].steps["install"]
        assert install.ok and isinstance(install, PromptResult), "the agent's answer, from the one install step"
        assert "after the cli attempt" in install.detail


@PLATFORMS
async def test_with_no_llm_source_the_plain_installs_still_run(platform):
    """A person who never picks a source still gets every tool whose command
    works. Only the agent rung needs the source, so a tool whose command failed
    stays missing and the run says so."""
    machine = Machine(platform, EVERYTHING - {LLM, "jq", "git"})
    result, asked = await _run(machine, platform, {"ask-install-jq": "yes", "ask-install-git": "yes"})

    assert result.exit_code is ExitCode.NOT_YET
    assert "git" in machine.installed, "the command needs no LLM source"
    assert "jq" not in machine.installed and machine.agents == []
    assert not result.steps["jq"].steps["install"].ok
