"""``docs/snippets/call-returns.md``, checked as written.

* Every ``python`` fence runs literally, in an async body. A line ending
  ``# <expected>`` becomes ``assert (expr) == (expected)`` — the page's comments
  ARE its assertions, so a fence cannot claim a value the code does not return.
  Prose after `` — `` is ignored. A fence whose first line starts
  ``# long tier`` needs a real harness or LLM and runs in
  ``tests/long_tests/test_call_returns_live.py`` instead.
* Every ``pyi`` fence is a shape listing; each ``class`` in it must list exactly
  the real class's fields.

The only things injected are names and a platform: the snippets spell
``darwin`` commands, and pinning ``run_op`` to that key lets the same fence run
on a Linux CI box (only ``win32`` is spawned differently).
"""
from __future__ import annotations

import asyncio
import ast
import functools
import re
import textwrap
from pathlib import Path
from typing import ClassVar

import pytest
from pydantic import ValidationError

from flow_sdk.core.compute_op.ask import answer, open_questions
from flow_sdk.core.compute_op import runner
from flow_sdk.core.wizard.runner import Resolved, run_wizard
from flow_sdk.schema.data_spec import compute_op_spec, returned_value_spec
from flow_sdk.schema.data_spec.compute_op_spec import (
    CHECK_TIMEOUT,
    AgentOp,
    AskOp,
    CliOp,
    ComputeOpSpec,
    ExeData,
    PromptOp,
)
from flow_sdk.schema.data_spec.returned_value_spec import (
    AskResult,
    CliResult,
    ExitCode,
    OpNotReached,
    PromptResult,
    ReturnedValue,
    WizardResult,
)
from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec, WizardStepSpec

DOC = Path(__file__).resolve().parents[2] / "docs" / "snippets" / "call-returns.md"
LONG_TIER = "# long tier"
#: What a person types into the §7 question.
TYPED = {"token": "sk-live-1"}


def fences(lang: str) -> list[str]:
    return re.findall(rf"```{lang}\n(.*?)```", DOC.read_text(), re.S)


def _compiles(text: str) -> bool:
    try:
        compile(text, "<fence>", "eval", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
    except SyntaxError:
        return False
    return True


def with_assertions(fence: str) -> "tuple[str, int]":
    """The fence, each ``expr  # expected`` line turned into an assertion."""
    out, asserted = [], 0
    for line in fence.splitlines():
        m = re.match(r"^(\s*)(\S.*?)\s{2,}#\s(.+)$", line)
        if m:
            indent, code, comment = m.groups()
            expected = comment.split(" — ")[0].strip()
            if _compiles(code) and _compiles(expected):
                out.append(f"{indent}assert ({code}) == ({expected}), {line.strip()!r}")
                asserted += 1
                continue
        out.append(line)
    return "\n".join(out), asserted


def _scope(tmp_path: Path) -> dict:
    return {
        "ComputeOpSpec": ComputeOpSpec, "CliOp": CliOp, "PromptOp": PromptOp,
        "AgentOp": AgentOp, "AskOp": AskOp, "CHECK_TIMEOUT": CHECK_TIMEOUT,
        "ReturnedValue": ReturnedValue, "CliResult": CliResult, "PromptResult": PromptResult,
        "AskResult": AskResult, "WizardResult": WizardResult, "ExitCode": ExitCode,
        "OpNotReached": OpNotReached, "ValidationError": ValidationError,
        "DataSpec": DataSpec, "ClassVar": ClassVar,
        "WizardSpec": WizardSpec, "WizardStepSpec": WizardStepSpec,
        "Resolved": Resolved, "run_wizard": run_wizard,
        "run_op": functools.partial(runner.run_op, platform="darwin"),
        "tmp": tmp_path,
    }


async def _person_answers() -> None:
    """A person at the window: answers every question the moment it is raised."""
    while True:
        for question in open_questions():
            answer(question.id, TYPED)
        await asyncio.sleep(0.01)


FAST = [f for f in fences("python") if not f.lstrip().startswith(LONG_TIER)]


@pytest.fixture(autouse=True)
def _no_browser(monkeypatch):
    # The §7 question is answered by `_person_answers`, never by a window.
    monkeypatch.setenv("FLOWPAD_NO_BROWSER", "1")


def test_the_page_has_its_fences():
    assert len(FAST) == 6 and len(fences("pyi")) == 2
    assert len(fences("python")) - len(FAST) == 2, "the agent and prompt fences are the long tier's"


@pytest.mark.parametrize("index", range(len(FAST)))
@pytest.mark.asyncio
async def test_every_fence_runs_as_written(index, tmp_path):
    body, asserted = with_assertions(FAST[index])
    assert asserted, "a fence with no `# expected` line proves nothing"
    scope = _scope(tmp_path)
    exec("async def __fence():\n" + textwrap.indent(body, "    "), scope)
    person = asyncio.create_task(_person_answers()) if "AskOp(" in body else None
    try:
        await scope["__fence"]()
    finally:
        if person is not None:
            person.cancel()


_CLASSES = {
    **{name: getattr(compute_op_spec, name) for name in ("ExeData", "CliOp", "PromptOp", "AgentOp", "AskOp", "ComputeOpSpec")},
    **{name: getattr(returned_value_spec, name) for name in ("ReturnedValue", "CliResult", "PromptResult", "AskResult", "WizardResult")},
}


def _listed() -> "list[tuple[str, set[str]]]":
    classes: list[tuple[str, set[str]]] = []
    for fence in fences("pyi"):
        for block in re.split(r"\n(?=class )", fence.strip()):
            name = re.match(r"class (\w+)", block).group(1)
            fields = set(re.findall(r"^    (\w+):", block, re.M))
            classes.append((name, fields))
    return classes


@pytest.mark.parametrize("name,fields", _listed(), ids=[n for n, _ in _listed()])
def test_every_listing_names_exactly_the_real_fields(name, fields):
    real = _CLASSES[name]
    parent = next((b for b in real.__mro__[1:] if b in _CLASSES.values()), None)
    own = set(real.model_fields) - (set(parent.model_fields) if parent else set())
    assert fields == own, f"{name}: the page lists {sorted(fields)}, the class has {sorted(own)}"


def test_exe_data_declares_no_kind_of_its_own():
    assert "spec_kind" not in ExeData.__dict__
