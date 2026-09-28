"""The shipped ``whatsapp-test`` wizard, run for real by the wizard runner over its own asset files.

Only the shell is a stand-in: it plays ``flow source step`` — each step's goal holds once its call ran with
the values it needs. A person answers each question. This proves the wiring the documents promise: every
answer reaches the step that reads it (as FLOWPAD_WIZARD_INPUT_*, never argv), the steps run in order, and
running the wizard again resumes at the first goal not met — asking nothing already answered.
"""
from __future__ import annotations

import asyncio
import json
import re
import sys
from pathlib import Path

import pytest

from flow_sdk.core.compute_op import ask
from flow_sdk.core.wizard.runner import Resolved, run_wizard
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.returned_value_spec import CliResult, PromptResult
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

ASSETS = Path(__file__).resolve().parents[1] / "agentic-assets"
ANSWERS = {
    "Your Meta app's App ID": "app1", "Your Meta app's App secret": "sec1",
    "The test number's Phone number ID": "555000", "The WhatsApp Business Account ID": "waba1",
    "The access token from API Setup": "TEMP", "Your own WhatsApp number, with country code": "972500000000",
    "Send hi to your agent from your phone, then type ok": "ok",
}
#: What each step needs in its env before its call can succeed.
NEEDS = {
    "app": {"APP_ID", "APP_SECRET"}, "number": {"PHONE_NUMBER_ID", "WABA_ID", "ACCESS_TOKEN"}, "me": {"MY_NUMBER"},
    "public-webhook": set(), "subscribe": set(), "verify": set(), "answered": set(), "first-turn": {"WAIT"},
}


def _spec(path: Path) -> dict:
    body = json.loads(path.read_text())
    body.pop("type", None)
    return body


def _ops() -> dict[str, ComputeOpSpec]:
    out = {}
    for f in ASSETS.glob("compute_op/*/compute_op.json"):
        body = _spec(f)
        body["setup"] = (f.parent / "setup.md").read_text()
        out[body["name"]] = ComputeOpSpec.model_validate(body)
    return out


class _Provider:
    """``flow source step`` over a pretend Meta: a goal holds once its call ran with what it needs."""

    def __init__(self):
        self.done: set[str] = set()
        self.calls: list[tuple[str, dict]] = []

    async def shell(self, command, *, extra_env=None, **_kw):
        env = {k.removeprefix("FLOWPAD_WIZARD_INPUT_"): v for k, v in (extra_env or {}).items()}
        step = re.search(r"source step \S+ (\S+)", command).group(1)
        assert env.get("SOURCE") == "ds-1", "every step names the source it sets up"
        if command.endswith("--check"):
            return CliResult.of_process(command, 0 if step in self.done else 1)
        missing = NEEDS[step] - set(env)
        assert not missing, f"{step} ran without {missing}"
        assert "sec1" not in command and "TEMP" not in command, "a secret never rides the command line"
        self.calls.append((step, env))
        self.done.add(step)
        return CliResult.of_process(command, 0)


async def _launch(**_kw):
    return PromptResult.satisfied("n/a")


async def _person(asked: list[str], stop_after: int | None = None):
    """Answer every question the wizard raises, as the person would from the setup dialog."""
    while True:
        for q in ask.open_questions():
            asked.append(q.prompt)
            assert q.guide, f"{q.prompt!r} is asked with its guide beside it"
            ask.answer(q.id, ANSWERS[q.prompt])
            if stop_after is not None and len(asked) >= stop_after:
                return
        await asyncio.sleep(0.005)


@pytest.fixture(autouse=True)
def _backend(monkeypatch):
    monkeypatch.setenv("FLOWPAD_NO_BROWSER", "1")
    monkeypatch.setattr(ask, "_SERVED_HERE", True)
    ask._PENDING.clear()
    yield
    ask._PENDING.clear()


async def _run(provider, tmp_path, ops):
    async def resolve(name):
        return Resolved(ops[name], True) if name in ops else None

    wizard = WizardSpec.model_validate(_spec(ASSETS / "wizard" / "whatsapp-test" / "wizard.json"))
    return await run_wizard(
        wizard, trusted=True, platform=sys.platform, workdir=tmp_path, inputs={"source": "ds-1"},
        shell=provider.shell, launch=_launch, resolve_op=resolve, activity_path=f"wz-{tmp_path.name}",
    )


async def test_the_test_wizard_runs_every_step_with_the_answers_it_needs(tmp_path):
    provider, asked = _Provider(), []
    person = asyncio.create_task(_person(asked))
    result = await _run(provider, tmp_path, _ops())
    person.cancel()

    assert result.ok, result.detail
    assert [s for s, _ in provider.calls] == [
        "app", "number", "me", "public-webhook", "subscribe", "verify", "answered", "first-turn",
    ]
    assert dict(provider.calls[-1][1])["WAIT"] == "240"
    assert len(asked) == 7


async def test_running_it_again_resumes_and_asks_nothing_already_answered(tmp_path):
    provider, asked = _Provider(), []
    provider.done |= {"app", "number"}  # a first run got this far, then the person closed the dialog

    person = asyncio.create_task(_person(asked))
    result = await _run(provider, tmp_path, _ops())
    person.cancel()

    assert result.ok, result.detail
    assert [s for s, _ in provider.calls][:1] == ["me"], "the met goals are skipped, calls and questions alike"
    assert asked == ["Your own WhatsApp number, with country code", "Send hi to your agent from your phone, then type ok"]
