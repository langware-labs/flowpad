"""Pins ``docs/snippets/project-dependencies.md``: every python fence runs as written, in
order, as one session — the worker is the mock worker, which answers from what the
process can actually see (its context dirs), so §4 proves the dependency reached it.

# do not increase timeout without approval
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.schema.type_info import register_all
from tests.utils.snippets import run_page

register_all()

pytestmark = [pytest.mark.timeout(15), pytest.mark.usefixtures("home")]  # do not increase timeout without approval


def _answer_from_context(turn) -> str:
    """Find ``docs/guide.md`` in the process's context folders — never in its prompt — and
    reply with the code word in it, reading it the way a worker would."""
    for folder in turn.process.resolved_add_dirs:
        guide = Path(folder) / "docs" / "guide.md"
        if guide.is_file():
            text = turn.read(guide)
            return text.split("The code word is ", 1)[1].strip().rstrip(".")
    return "I could not find guide.md in my context."


async def test_every_fence_runs_as_written(initialize_test_db, mock_driver):
    driver = mock_driver(_answer_from_context)
    ns = await run_page("project-dependencies.md")

    assert ns["site"].include_dirs == [str(ns["b_root"])]
    assert len(driver.received_prompts) == 1, "§4 ran exactly one worker turn"
    assert "guide.md" in driver.received_prompts[0] and str(ns["b_root"]) not in driver.received_prompts[0], (
        "the prompt names the file but not where it is — the context does"
    )
