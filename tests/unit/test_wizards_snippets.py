"""``docs/snippets/wizards.md``, checked as written.

Every ``python`` fence runs literally, in an async body, against the REAL
runner and a real shell. A line ending ``# <expected>`` becomes
``assert (expr) == (expected)`` — the page's comments ARE its assertions, so a
fence cannot claim a value the code does not return. Prose after `` — `` is
ignored.

The only things injected are names, a workdir and a platform: the fences spell
``darwin`` commands, and pinning the platform key lets the same fence run on a
Linux CI box (only ``win32`` is spawned differently). The commands themselves
are POSIX, so they run either way.
"""
from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from flow_sdk.core.wizard.runner import MAX_WIZARD_DEPTH, Resolved, run_wizard
from flow_sdk.schema.data_spec.compute_op_spec import CliOp, ComputeOpSpec
from flow_sdk.schema.data_spec.returned_value_spec import CliResult, ExitCode, WizardResult
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec, WizardStepSpec
from tests.unit.test_call_returns_snippets import with_assertions
from tests.utils.snippets import record_run

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

DOC = Path(__file__).resolve().parents[2] / "docs" / "snippets" / "wizards.md"


def fences() -> list[str]:
    import re

    return re.findall(r"```python\n(.*?)```", DOC.read_text(), re.S)


FENCES = fences()


def _scope(tmp_path: Path) -> dict:
    return {
        "ComputeOpSpec": ComputeOpSpec, "CliOp": CliOp, "CliResult": CliResult,
        "WizardSpec": WizardSpec, "WizardStepSpec": WizardStepSpec,
        "WizardResult": WizardResult, "ExitCode": ExitCode, "Resolved": Resolved,
        "run_wizard": run_wizard, "MAX_WIZARD_DEPTH": MAX_WIZARD_DEPTH,
        "tmp": tmp_path,
    }


def test_the_page_has_its_fences():
    assert len(FENCES) == 5, "one per section — a section without one proves nothing"


@pytest.mark.parametrize("index", range(len(FENCES)))
@pytest.mark.asyncio
async def test_every_fence_runs_as_written(index, tmp_path):
    body, asserted = with_assertions(FENCES[index])
    assert asserted, "a fence with no `# expected` line proves nothing"
    scope = _scope(tmp_path)
    exec("async def __fence():\n" + textwrap.indent(body, "    "), scope)
    await scope["__fence"]()
    record_run(FENCES[index])
