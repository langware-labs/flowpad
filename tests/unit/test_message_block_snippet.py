"""The documented simple MessageBlock program is executable as written."""

from __future__ import annotations

import pytest

from tests.utils.mock_worker import MockDriver
from tests.utils.snippets import doc, fences, run_fence


@pytest.mark.asyncio
async def test_documented_message_block_program_runs_verbatim(
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

    (source,) = fences(doc("message-block.md"))
    namespace = await run_fence(source, filename="message-block.md")

    expected = "Mock reply: Where is the treasure?"
    assert driver.received_prompts == ["Where is the treasure?"]
    assert namespace["reply"] == expected
    assert capsys.readouterr().out.strip() == expected
