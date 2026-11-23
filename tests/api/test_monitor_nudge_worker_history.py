"""A monitor's goal check must not add sessions to the user's session list.

Each nudge forks the watched session and asks the fork whether the goal is met. The fork is a
real ``AgenticProcess`` with its own transcript on disk, and the session list (``worker-history``)
shows every process row and every transcript -- so a fork that outlives its check is one more
"goal and stop condition check for monitor ..." chat per nudge.

Real here: the backend route, the DB, the fork (``AgenticProcess.fork`` + save) and the transcript
on disk. Faked: only the model's turn (``try_prompt_ap``), which writes the fork's transcript as
the CLI would and answers.
"""

from __future__ import annotations

import os
import time
import uuid

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.cli.commands import process_monitor_cmd
from flow_sdk.instance_settings import get_instance_settings
from tests.api.conftest import default_compute_node_id
from tests.unit.conftest import write_claude_transcript

WORKDIR = "/Users/alice/Documents/dev/flowpad-oss"
ENCODED_WORKDIR = "-Users-alice-Documents-dev-flowpad-oss"


async def _session_ids(client, node_id: str) -> list[str]:
    resp = await client.get(f"/api/v1/graph/compute_node/{node_id}/worker-history?limit=500")
    assert resp.status_code == 200, resp.text
    return sorted(entry["worker_id"] for entry in resp.json()["data"])


@pytest.mark.asyncio
@pytest.mark.timeout(60)  # do not increase timeout without approval
async def test_two_nudges_leave_the_session_list_as_it_was(bootstrapped_client, bootstrap_payload, monkeypatch):
    node_id = default_compute_node_id(bootstrap_payload)
    transcripts = get_instance_settings().claude_projects_dir / ENCODED_WORKDIR
    transcripts.mkdir(parents=True, exist_ok=True)

    watched = AgenticProcess(
        id=str(uuid.uuid4()),
        session_id=str(uuid.uuid4()),
        worker_type="claude_code",
        workdir=WORKDIR,
        project_id=str(uuid.uuid4()),
        name="the watched session",
    )
    await watched.save()
    write_claude_transcript(transcripts, watched.session_id)

    asked: list[str] = []

    async def answer_continue(process_id: str, prompt: str) -> str:
        """The fork's turn: the CLI writes the fork's transcript, the model answers."""
        fork = await AgenticProcess.get_by_id(process_id)
        jsonl = write_claude_transcript(transcripts, fork.session_id)
        now = time.time()
        os.utime(jsonl, (now, now))
        asked.append(process_id)
        return '{"answer": "continue_to_work"}'

    monkeypatch.setattr(process_monitor_cmd, "try_prompt_ap", answer_continue)

    before = await _session_ids(bootstrapped_client, node_id)
    assert watched.session_id in before, "precondition: the watched session is in the list"

    for _ in range(2):
        check = await process_monitor_cmd.try_check_goal(str(watched.id), "tests pass", "", "tests-green")
        assert check.verdict is not None and check.verdict.answer == "continue_to_work"

    assert len(set(asked)) == 2, "each nudge asked a fork of its own"
    assert await _session_ids(bootstrapped_client, node_id) == before
