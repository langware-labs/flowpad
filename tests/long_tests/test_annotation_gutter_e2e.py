"""End-to-end test: prompt annotation appears in the annotation gutter.

Scenario:
1. Create AgenticProcess, start(), prompt("hi"), waitForIdle()
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
from tests.test_settings import test_service_config

pytestmark = pytest.mark.skipif(
    not test_service_config.deep_testing,
    reason="Skipping long tests when DEEP_TESTING is disabled",
)

from flow_sdk.builtin.agentic_process import AgenticProcess, WorkerType

SERVER_URL = "http://localhost:9007"
UI_URL = "http://localhost:4097"


def _server_running(host: str = "localhost", port: int = 9007) -> bool:
    try:
        with socket.create_connection((host, port), timeout=1):
            return True
    except OSError:
        return False


def _query_annotations(session_id: str) -> list[dict]:
    """Query annotations with the given session_id from the live server."""
    resp = requests.get(f"{SERVER_URL}/api/v1/graph/annotation", timeout=10)
    if resp.status_code != 200:
        return []
    data = resp.json()
    annotations = data.get("data") or []
    return [a for a in annotations if a.get("session_id") == session_id]


@pytest.mark.asyncio
@pytest.mark.timeout(300)
async def test_prompt_annotation_created_and_visible():
    """
    Full flow:
      process.start() → process.prompt("hi") → waitForIdle()
      → assert Annotation with labels=['prompt:'] exists for session
      → print process URL for browser verification
    """
    if not _server_running():
        pytest.skip("Server not running at localhost:9007 — start it with: uv run -m flow_sdk.server.run")

    # ── 1. Bootstrap server (creates @local entities if not yet done) ──────
    resp = requests.get(f"{SERVER_URL}/api/v1/graph/bootstrap", timeout=15)
    assert resp.status_code == 200, f"Bootstrap failed: {resp.text}"

    # ── 2. Create and start process ─────────────────────────────────────────
    process = AgenticProcess(workerType=WorkerType.CLAUDE)
    process.start()
    assert process.idle is True, "Process should be idle before prompt"

    # ── 3. Send prompt ───────────────────────────────────────────────────────
    process.prompt("hi")
    assert process.idle is False, "Process should be busy after prompt"

    worker_session_id = process.worker_session_id
    process_id = process.record.id
    print(f"\n[e2e] worker_session_id = {worker_session_id}")
    print(f"[e2e] process_id        = {process_id}")
    print(f"[e2e] Process URL       = {UI_URL}/dock/shell/agentic_process-{process_id}")

    # ── 4. Wait for Claude to finish ─────────────────────────────────────────
    await process.waitForIdle(timeout=120)
    assert process.idle is True, "Process should be idle after completion"

    # ── 5. Verify annotation was created ─────────────────────────────────────
    # The UserPromptSubmit hook fires synchronously when prompt() is called,
    # so by the time waitForIdle() returns the annotation should be in the DB.
    # We give it up to 10s of polling in case of DB write delay.
    assert worker_session_id, "worker_session_id must be set after prompt()"

    annotations = []
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        annotations = _query_annotations(worker_session_id)
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
        f"Expected at least 1 prompt annotation for session {worker_session_id}, "
        f"got {annotations}"
    )

    ann = prompt_annotations[0]
    print(f"[e2e] Annotation found: id={ann.get('id')!r} "
          f"content={ann.get('content')!r} labels={ann.get('labels')}")

    # ── 6. Print URL for Playwright browser validation ───────────────────────
    process_url = f"{UI_URL}/dock/shell/agentic_process-{process_id}"
    print(f"\n[e2e] Open this URL to verify the annotation gutter:")
    print(f"[e2e]   {process_url}")
    print(f"[e2e] Expected: lime Tag icon in the annotation column "
          f"(right side of terminal).")
