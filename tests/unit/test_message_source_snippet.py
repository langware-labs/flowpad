"""The documented simple MessageSource program is executable as written."""

from __future__ import annotations

import ast
import inspect
import re
from pathlib import Path

import pytest

from tests.utils.mock_worker import MockDriver

_DOC = Path(__file__).parents[2] / "docs" / "snippets" / "message-source.md"


def _first_python_fence(markdown: str) -> str:
    match = re.search(r"```python\n(.*?)\n```", markdown, re.DOTALL)
    assert match is not None, f"no Python fence found in {_DOC}"
    return match.group(1)


@pytest.mark.asyncio
async def test_documented_message_source_program_runs_verbatim(
    initialize_test_db,
    monkeypatch,
    tmp_path,
    capsys,
):
    driver = MockDriver(tmp_path / "mock-transcripts")
    monkeypatch.setattr(
        "flow_sdk.builtin.agentic_process.agentic_process.get_driver",
        lambda _worker_type: driver,
    )

    source = _first_python_fence(_DOC.read_text(encoding="utf-8"))
    code = compile(
        source,
        str(_DOC),
        "exec",
        flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT,
    )
    namespace = {"__name__": "__message_source_snippet__"}
    execution = eval(code, namespace)  # noqa: S307 - executes our checked-in documentation
    assert inspect.isawaitable(execution)
    await execution

    expected = "Mock reply: Where is the treasure?"
    assert driver.received_prompts == ["Where is the treasure?"]
    assert namespace["reply"] == expected
    assert capsys.readouterr().out.strip() == expected
