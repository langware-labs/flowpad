"""``POST agentic_process/<id>/session-transcript`` for a fork with no turn of its own yet.

A Claude fork writes its own JSONL only on its first turn. Until then the share
must attach the transcript it branched off, not fall back to the bare process.
"""

import json
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.instance_settings import get_instance_settings
from flow_sdk.responses.response import ApiResponse
from tests.api.conftest import create_agentic_process

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)


async def _session_transcript(client, pid: str) -> dict:
    resp = await client.post(f"/api/v1/graph/agentic_process/{pid}/session-transcript", json={})
    assert resp.status_code == 200, resp.text
    return ApiResponse(**resp.json()).data


@pytest.mark.asyncio
async def test_unturned_fork_attaches_its_source_transcript(bootstrapped_client):
    source_id = mint_uuid()
    projects_dir = get_instance_settings().claude_projects_dir
    projects_dir.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix="e2etest-fork-", dir=projects_dir) as folder:
        line = {
            "type": "user",
            "sessionId": source_id,
            "uuid": mint_uuid(),
            "timestamp": "2026-10-18T07:29:32.444Z",
            "cwd": folder,
            "message": {"role": "user", "content": "the source session's first prompt"},
        }
        (Path(folder) / f"{source_id}.jsonl").write_text(json.dumps(line) + "\n", encoding="utf-8")
        pid = await create_agentic_process(
            bootstrapped_client,
            session_id=mint_uuid(),
            cli_config={"worker_type": "claude", "fork_session_id": source_id},
        )
        data = await _session_transcript(bootstrapped_client, pid)

    assert data["reason"] is None
    assert data["type_id"] and data["type_id"].startswith("claude_session-")


@pytest.mark.asyncio
async def test_unturned_process_without_a_fork_source_has_no_transcript(bootstrapped_client):
    pid = await create_agentic_process(bootstrapped_client, session_id=mint_uuid())
    data = await _session_transcript(bootstrapped_client, pid)
    assert data["type_id"] is None
