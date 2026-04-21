"""End-to-end test: prompt annotation appears in the annotation gutter.

Scenario:
1. Create AgenticProcess, start(), prompt("hi"), wait()
2. Verify that an Annotation entity with labels=['prompt:'] and the correct
   session_id was created in the DB by the UserPromptSubmit hook handler.
3. Print the process URL for manual browser / Playwright validation.

Run manually:
    python -m pytest tests/long_tests/test_annotation_gutter_e2e.py -v -s

Requires:
  - Running server:  uv run -m flow_sdk.server.run
  - Running UI:      cd ui && npm run dev
  - Claude CLI in PATH
"""

import asyncio
import socket
import time

import pytest
import requests
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.config import load_server_info
from flow_sdk.flowpad_types.enums import WorkerType
from tests.test_settings import test_service_config

pytestmark = pytest.mark.skipif(
    not test_service_config.deep_testing,
    reason="Skipping long tests when DEEP_TESTING is disabled",
)


def _server_url() -> str:
    info = load_server_info()
    port = info.get("port", 9007)
    return f"http://localhost:{port}"


def _server_running() -> bool:
    info = load_server_info()
    port = info.get("port", 9007)
    try:
        with socket.create_connection(("localhost", port), timeout=1):
            return True
    except OSError:
        return False


def _query_annotations(session_id: str) -> list[dict]:
    """Query annotations with the given session_id from the live server."""
    resp = requests.get(f"{_server_url()}/api/v1/graph/annotation", timeout=10)
    if resp.status_code != 200:
        return []
    data = resp.json()
    annotations = data.get("data") or []
    return [a for a in annotations if a.get("session_id") == session_id]


@pytest.mark.asyncio
@pytest.mark.timeout(300)
async def test_prompt_annotation_created_and_visible(bootstrapped_client, local_project, local_compute_node):
    """
    Full flow:
      process.start() → process.prompt("hi") → wait()
      → assert Annotation with labels=['prompt:'] exists for session
      → print process URL for browser verification
    """
    if not _server_running():
        pytest.skip(f"Server not running at {_server_url()} — start it with: uv run -m flow_sdk.server.run")

    server = _server_url()
    # ── 1. Bootstrap server (creates @local entities if not yet done) ──────
    # bootstrapped_client already bootstrapped the in-process test DB.
    # Also bootstrap the running server so its DB has @local entities.
    resp = requests.get(f"{server}/api/v1/graph/bootstrap", timeout=15)
    assert resp.status_code == 200, f"Bootstrap failed: {resp.text}"

    # ── 2. Create and start process ─────────────────────────────────────────
    process = await AgenticProcess(worker_type=WorkerType.CLAUDE_CODE).save()
    process_id = process.id

    # ── 3. Send prompt ───────────────────────────────────────────────────────
    await process.prompt("hi")
    assert process.is_idle is False, "Process should be busy after prompt"

    session_id = process.session_id
    print(f"\n[e2e] session_id = {session_id}")
    print(f"[e2e] process_id        = {process_id}")
    print(f"[e2e] Process URL       = {server}/dock/shell/agentic_process-{process_id}")

    # ── 4. Wait for Claude to finish ─────────────────────────────────────────
    await process.wait(timeout=120)
    from flow_sdk.builtin.agentic_process.status_predicates import is_ready_for_input
    assert is_ready_for_input(process) is True, "Process should be ready for input after completion"

    # ── 5. Verify annotation was created ─────────────────────────────────────
    # The UserPromptSubmit hook fires synchronously when prompt() is called,
    # so by the time wait() returns the annotation should be in the DB.
    # We give it up to 10s of polling in case of DB write delay.
    assert session_id, "session_id must be set after prompt()"

    annotations = []
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        annotations = _query_annotations(session_id)
        prompt_annotations = [
            a for a in annotations
            if "prompt:" in (a.get("labels") or [])
        ]
        if prompt_annotations:
            break
        await asyncio.sleep(1)

    prompt_annotations = [
        a for a in annotations
        if "prompt:" in (a.get("labels") or [])
    ]
    assert len(prompt_annotations) >= 1, (
        f"Expected at least 1 prompt annotation for session {session_id}, "
        f"got {annotations}"
    )

    ann = prompt_annotations[0]
    print(f"[e2e] Annotation found: id={ann.get('id')!r} "
          f"content={ann.get('content')!r} labels={ann.get('labels')}")

    # ── 6. Print URL for Playwright browser validation ───────────────────────
    process_url = f"{server}/dock/shell/agentic_process-{process_id}"
    print(f"\n[e2e] Open this URL to verify the annotation gutter:")
    print(f"[e2e]   {process_url}")
    print(f"[e2e] Expected: lime Tag icon in the annotation column "
          f"(right side of terminal).")
