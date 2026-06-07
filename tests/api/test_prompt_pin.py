"""API tests for pin-from-history (``prompt_pin_action.py``): pin creates a
project-scoped Prompt mutually cross-linked with the AgenticProcess (private
context, both ways), re-pin of the same normalized text dedups, and unpin
removes the link AND the prompt (entity + backing .md).
"""
from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.prompt import Prompt
from flow_sdk.flowpad_types.enums import WorkerType

pytestmark = pytest.mark.asyncio


def _has_link(entries, type_, id_) -> bool:
    return any(t.type == type_ and t.id == id_ for t in entries)


async def _make_project(client, tmp_path) -> str:
    resp = await client.post(
        "/api/v1/graph/project",
        json={"type": "project", "name": "pinlib", "fs_storage_mount_path": str(tmp_path)},
    )
    assert resp.json().get("status") == "SUCCESS", resp.text
    return resp.json()["data"]["id"]


async def _make_process(project_id: str | None = None) -> AgenticProcess:
    return await AgenticProcess(
        id=str(uuid.uuid4()),
        session_id=str(uuid.uuid4()),
        worker_type=WorkerType.CLAUDE_CODE,
        **({"project_id": project_id} if project_id else {}),
    ).save()


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_pin_creates_prompt_and_cross_links(bootstrapped_client, user, tmp_path):
    client = bootstrapped_client
    project_id = await _make_project(client, tmp_path)
    proc = await _make_process(project_id)

    text = "Fix the auth flow\nand add tests."
    resp = await client.post(f"/api/v1/graph/agentic_process/{proc.id}/pin-prompt", json={"text": text})
    assert resp.json().get("status") == "SUCCESS", resp.text
    data = resp.json()["data"]
    assert data["pinned"] is True
    prompt_id = data["prompt_id"]

    prompt = await Prompt.get_by_id(prompt_id)
    assert prompt is not None
    assert prompt.text == text
    assert prompt.name == "Fix the auth flow"  # auto-name = first line
    assert prompt.project_id == project_id
    # Project-scoped backing .md under <project>/prompts/.
    assert prompt.asset_ref and prompt.asset_ref.startswith(str(tmp_path))
    assert Path(prompt.asset_ref).is_file()

    # Mutual private-context links.
    ap_reloaded = await AgenticProcess.get_by_id(proc.id)
    assert _has_link(prompt.private_context_entities_, AgenticProcess.get_type(), proc.id)
    assert _has_link(ap_reloaded.private_context_entities_, Prompt.get_type(), prompt_id)


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_repin_same_text_dedups(bootstrapped_client, user, tmp_path):
    client = bootstrapped_client
    project_id = await _make_project(client, tmp_path)
    proc = await _make_process(project_id)

    first = await client.post(
        f"/api/v1/graph/agentic_process/{proc.id}/pin-prompt", json={"text": "same   text\nhere"}
    )
    # Whitespace-normalized match → same prompt reused.
    second = await client.post(
        f"/api/v1/graph/agentic_process/{proc.id}/pin-prompt", json={"text": "same text here"}
    )
    assert first.json()["data"]["prompt_id"] == second.json()["data"]["prompt_id"]

    ap_reloaded = await AgenticProcess.get_by_id(proc.id)
    prompt_id = first.json()["data"]["prompt_id"]
    assert sum(1 for t in ap_reloaded.private_context_entities_ if t.id == prompt_id) == 1


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_unpin_removes_link_entity_and_file(bootstrapped_client, user, tmp_path):
    client = bootstrapped_client
    project_id = await _make_project(client, tmp_path)
    proc = await _make_process(project_id)

    resp = await client.post(
        f"/api/v1/graph/agentic_process/{proc.id}/pin-prompt", json={"text": "Ephemeral pin."}
    )
    prompt_id = resp.json()["data"]["prompt_id"]
    prompt = await Prompt.get_by_id(prompt_id)
    md_path = Path(prompt.asset_ref)
    assert md_path.is_file()

    resp = await client.post(
        f"/api/v1/graph/agentic_process/{proc.id}/unpin-prompt", json={"prompt_id": prompt_id}
    )
    assert resp.json().get("status") == "SUCCESS", resp.text
    assert resp.json()["data"]["pinned"] is False

    assert await Prompt.get_by_id(prompt_id) is None
    assert not md_path.exists(), "unpin must remove the backing .md"
    ap_reloaded = await AgenticProcess.get_by_id(proc.id)
    assert not _has_link(ap_reloaded.private_context_entities_, Prompt.get_type(), prompt_id)

    # Idempotent: unpinning again is a no-op success.
    resp = await client.post(
        f"/api/v1/graph/agentic_process/{proc.id}/unpin-prompt", json={"prompt_id": prompt_id}
    )
    assert resp.json().get("status") == "SUCCESS", resp.text
