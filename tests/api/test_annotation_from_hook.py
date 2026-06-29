"""
API test: verify Annotation entity is auto-created when a UserPromptSubmit
agent_hook event arrives at POST /api/v1/webhook/listen.

Flow:
  1. Bootstrap + create an AgentHook and an AgenticProcess with a known session_id
  2. POST a UserPromptSubmit webhook payload
  3. Yield the event loop so the asyncio.create_task inside _create_prompt_annotation runs
  4. GET /api/v1/graph/annotation and verify the annotation was created with correct fields
  5. Test edge cases: prompt truncated at 50 chars, no annotation when session_id missing
"""

import uuid

import pytest

from flow_sdk.builtin.agent_hook import AgentHook, AgentProvider, HookScope
from flow_sdk.builtin.annotation import Annotation
from flow_sdk.responses.response import ApiResponse, ApiResponseStatus


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------

def _user_prompt_submit_payload(agent_hook_id: str, prompt: str, session_id: str) -> dict:
    return {
        "webhook_type": "agent_hook",
        "webhook_payload": {
            "agent_hook_id": agent_hook_id,
            "hook_data": {
                "hook_event_name": "UserPromptSubmit",
                "prompt": prompt,
                "session_id": session_id,
            },
        },
    }


async def _get_all_annotations(client) -> list:
    resp = await client.get("/api/v1/graph/annotation")
    assert resp.status_code == 200, resp.text
    res = ApiResponse(**resp.json())
    assert res.status == ApiResponseStatus.SUCCESS.value
    return res.data or []


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_annotation_created_on_user_prompt_submit(bootstrapped_client, user):
    """
    Posting a UserPromptSubmit event creates an Annotation with:
      - labels == ["prompt:"]
      - target_type == "agentic_process"
      - content == first 50 chars of the prompt
      - session_id == the Claude session_id from the hook payload
    """
    client = bootstrapped_client
    session_id = str(uuid.uuid4())

    # Create the AgenticProcess so _create_prompt_annotation can link to it
    from flow_sdk.builtin.agentic_process import AgenticProcess
    process = AgenticProcess(
        name="test-process-for-annotation",
        session_id=session_id,
    )
    await process.save(user.typeid)

    # Create an AgentHook to receive the webhook
    agent_hook = AgentHook(
        name="test-hook-annotation",
        provider=AgentProvider.CLAUDE_CODE,
        hook_scope=HookScope.USER,
        event="UserPromptSubmit",
        enabled=True,
    )
    await agent_hook.save(user.typeid)

    prompt = "Please fix the authentication bug in the login module"
    payload = _user_prompt_submit_payload(agent_hook.id, prompt, session_id)

    # Snapshot annotations before the call
    before = await _get_all_annotations(client)
    before_ids = {a.get("id") for a in before}

    # Fire the webhook
    resp = await client.post("/api/v1/webhook/listen", json=payload)
    assert resp.status_code == 200, resp.text
    res = ApiResponse(**resp.json())
    assert res.status == ApiResponseStatus.SUCCESS.value

    # asyncio.create_task runs on the next event-loop iteration; yield a few ticks
    # Fetch annotations and find newly created ones
    after = await _get_all_annotations(client)
    new_annotations = [a for a in after if a.get("id") not in before_ids]

    assert len(new_annotations) >= 1, (
        f"Expected at least 1 new annotation, got 0. All annotations: {after}"
    )

    ann = new_annotations[0]
    assert ann.get("labels") == ["prompt:"], f"Unexpected labels: {ann.get('labels')}"
    assert ann.get("target_type") == "agentic_process", f"Unexpected target_type: {ann.get('target_type')}"
    assert ann.get("target_id") == process.id, f"Unexpected target_id: {ann.get('target_id')}"
    assert ann.get("session_id") == session_id
    assert ann.get("content") == prompt[:50], f"Unexpected content: {ann.get('content')!r}"

    # Cleanup
    await agent_hook.delete()
    await process.delete()


@pytest.mark.asyncio
async def test_annotation_content_truncated_at_50_chars(bootstrapped_client, user):
    """Prompt longer than 50 chars is truncated to exactly 50 chars in the Annotation."""
    client = bootstrapped_client
    session_id = str(uuid.uuid4())

    from flow_sdk.builtin.agentic_process import AgenticProcess
    process = AgenticProcess(name="test-process-truncation", worker_session_id=session_id)
    await process.save(user.typeid)

    agent_hook = AgentHook(
        name="test-hook-truncation",
        provider=AgentProvider.CLAUDE_CODE,
        hook_scope=HookScope.USER,
        event="UserPromptSubmit",
        enabled=True,
    )
    await agent_hook.save(user.typeid)

    long_prompt = "A" * 200
    payload = _user_prompt_submit_payload(agent_hook.id, long_prompt, session_id)

    before = await _get_all_annotations(client)
    before_ids = {a.get("id") for a in before}

    await client.post("/api/v1/webhook/listen", json=payload)

    after = await _get_all_annotations(client)
    new_annotations = [a for a in after if a.get("id") not in before_ids]

    assert len(new_annotations) >= 1
    assert len(new_annotations[0].get("content", "")) == 50

    await agent_hook.delete()
    await process.delete()


@pytest.mark.asyncio
async def test_no_annotation_when_session_id_missing(bootstrapped_client, user):
    """If session_id is absent from the hook payload, no Annotation is created."""
    client = bootstrapped_client

    agent_hook = AgentHook(
        name="test-hook-no-session",
        provider=AgentProvider.CLAUDE_CODE,
        hook_scope=HookScope.USER,
        event="UserPromptSubmit",
        enabled=True,
    )
    await agent_hook.save(user.typeid)

    payload = {
        "webhook_type": "agent_hook",
        "webhook_payload": {
            "agent_hook_id": agent_hook.id,
            "hook_data": {
                "hook_event_name": "UserPromptSubmit",
                "prompt": "some prompt",
                # session_id intentionally omitted
            },
        },
    }

    before = await _get_all_annotations(client)
    before_ids = {a.get("id") for a in before}

    await client.post("/api/v1/webhook/listen", json=payload)

    after = await _get_all_annotations(client)
    new_annotations = [a for a in after if a.get("id") not in before_ids]

    assert len(new_annotations) == 0, (
        f"Expected no new annotations without session_id, got: {new_annotations}"
    )

    await agent_hook.delete()


@pytest.mark.asyncio
async def test_no_annotation_for_non_prompt_event(bootstrapped_client, user):
    """Non-UserPromptSubmit events (e.g. PreToolUse) do NOT create Annotations."""
    client = bootstrapped_client
    session_id = str(uuid.uuid4())

    agent_hook = AgentHook(
        name="test-hook-pretooluse",
        provider=AgentProvider.CLAUDE_CODE,
        hook_scope=HookScope.USER,
        event="PreToolUse",
        enabled=True,
    )
    await agent_hook.save(user.typeid)

    payload = {
        "webhook_type": "agent_hook",
        "webhook_payload": {
            "agent_hook_id": agent_hook.id,
            "hook_data": {
                "hook_event_name": "PreToolUse",
                "tool_name": "Bash",
                "session_id": session_id,
            },
        },
    }

    before = await _get_all_annotations(client)
    before_ids = {a.get("id") for a in before}

    await client.post("/api/v1/webhook/listen", json=payload)

    after = await _get_all_annotations(client)
    new_annotations = [a for a in after if a.get("id") not in before_ids]

    assert len(new_annotations) == 0, f"Unexpected annotation for PreToolUse: {new_annotations}"

    await agent_hook.delete()


@pytest.mark.asyncio
async def test_annotation_readable_via_graph_api(bootstrapped_client, user):
    """The created Annotation is readable by ID via GET /api/v1/graph/annotation/<id>."""
    client = bootstrapped_client
    session_id = str(uuid.uuid4())

    from flow_sdk.builtin.agentic_process import AgenticProcess
    process = AgenticProcess(name="test-process-read", worker_session_id=session_id)
    await process.save(user.typeid)

    agent_hook = AgentHook(
        name="test-hook-read",
        provider=AgentProvider.CLAUDE_CODE,
        hook_scope=HookScope.USER,
        event="UserPromptSubmit",
        enabled=True,
    )
    await agent_hook.save(user.typeid)

    payload = _user_prompt_submit_payload(agent_hook.id, "readable annotation test", session_id)

    before = await _get_all_annotations(client)
    before_ids = {a.get("id") for a in before}

    await client.post("/api/v1/webhook/listen", json=payload)

    after = await _get_all_annotations(client)
    new_annotations = [a for a in after if a.get("id") not in before_ids]
    assert len(new_annotations) >= 1

    ann_id = new_annotations[0]["id"]
    resp = await client.get(f"/api/v1/graph/annotation/{ann_id}")
    assert resp.status_code == 200, resp.text
    res = ApiResponse(**resp.json())
    assert res.status == ApiResponseStatus.SUCCESS.value
    assert res.data["id"] == ann_id
    assert res.data["content"] == "readable annotation test"

    await agent_hook.delete()
    await process.delete()

