"""End-to-end test: prompt annotation appears in the annotation gutter.

Scenario:
1. Create an AgenticProcess and post the UserPromptSubmit hook payload
2. Verify that an Annotation entity with labels=['prompt:'] and the correct
   session_id was created in the DB by the UserPromptSubmit hook handler.
3. Print the process URL for manual browser / Playwright validation.

Run manually:
    python -m pytest tests/long_tests/test_annotation_gutter_e2e.py -v -s

Requires:
  - DEEP_TESTING=1
"""

import asyncio
import time
import uuid

import pytest
from flow_sdk.builtin.agent_hook import AgentHook, AgentProvider, HookScope
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.config import load_server_info
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.responses.response import ApiResponse, ApiResponseStatus
from tests.test_settings import test_service_config

pytestmark = pytest.mark.skipif(
    not test_service_config.deep_testing,
    reason="Skipping long tests when DEEP_TESTING is disabled",
)


def _server_url() -> str:
    info = load_server_info()
    port = info.get("port", 9007)
    return f"http://localhost:{port}"


async def _query_annotations(client, session_id: str) -> list[dict]:
    """Query annotations with the given session_id from the in-process app."""
    resp = await client.get("/api/v1/graph/annotation")
    assert resp.status_code == 200, resp.text
    res = ApiResponse(**resp.json())
    assert res.status == ApiResponseStatus.SUCCESS.value
    annotations = res.data or []
    return [a for a in annotations if a.get("session_id") == session_id]


@pytest.mark.asyncio
# do not increase timeout without approval
@pytest.mark.timeout(30)
async def test_prompt_annotation_created_and_visible(bootstrapped_client, local_project, local_compute_node):
    """
    Full flow:
      create process → post UserPromptSubmit hook
      → assert Annotation with labels=['prompt:'] exists for session
      → print process URL for browser verification
    """
    server = _server_url()

    # ── 1. Create process and hook entity ───────────────────────────────────
    session_id = f"e2e-{uuid.uuid4()}"
    process = await AgenticProcess(
        worker_type=WorkerType.CLAUDE_CODE,
        session_id=session_id,
        workdir=str(local_project.fs_storage_mount_path),
    ).save()
    process_id = process.id
    agent_hook = AgentHook(
        name="test-hook-annotation-gutter-e2e",
        provider=AgentProvider.CLAUDE_CODE,
        hook_scope=HookScope.USER,
        event="UserPromptSubmit",
        enabled=True,
    )
    await agent_hook.save()

    try:
        print(f"\n[e2e] session_id = {session_id}")
        print(f"[e2e] process_id        = {process_id}")
        print(f"[e2e] Process URL       = {server}/dock/shell/agentic_process-{process_id}")

        # ── 2. Send prompt hook payload ─────────────────────────────────────
        prompt = "hi"
        payload = {
            "webhook_type": "agent_hook",
            "webhook_payload": {
                "agent_hook_id": agent_hook.id,
                "hook_data": {
                    "hook_event_name": "UserPromptSubmit",
                    "prompt": prompt,
                    "session_id": session_id,
                },
            },
        }
        resp = await bootstrapped_client.post("/api/v1/webhook/listen", json=payload)
        assert resp.status_code == 200, resp.text
        res = ApiResponse(**resp.json())
        assert res.status == ApiResponseStatus.SUCCESS.value

        # ── 3. Verify annotation was created ────────────────────────────────
        annotations = []
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            annotations = await _query_annotations(bootstrapped_client, session_id)
            prompt_annotations = [
                a for a in annotations
                if "prompt:" in (a.get("labels") or [])
            ]
            if prompt_annotations:
                break
            await asyncio.sleep(0.1)

        prompt_annotations = [
            a for a in annotations
            if "prompt:" in (a.get("labels") or [])
        ]
        assert len(prompt_annotations) >= 1, (
            f"Expected at least 1 prompt annotation for session {session_id}, "
            f"got {annotations}"
        )

        ann = prompt_annotations[0]
        assert ann.get("target_id") == process_id
        assert ann.get("content") == prompt
        print(f"[e2e] Annotation found: id={ann.get('id')!r} "
              f"content={ann.get('content')!r} labels={ann.get('labels')}")

        # ── 4. Print URL for Playwright browser validation ───────────────────
        process_url = f"{server}/dock/shell/agentic_process-{process_id}"
        print(f"\n[e2e] Open this URL to verify the annotation gutter:")
        print(f"[e2e]   {process_url}")
        print(f"[e2e] Expected: lime Tag icon in the annotation column "
              f"(right side of terminal).")
    finally:
        await agent_hook.delete()
        await process.delete()
