"""The special-folder consent event must survive the webhook/listen seam.

Real chain under test (no link mocked):

    project under <home>/Documents  → gate_root() queues a consent note
    → surface_pending_consent()     → send_event() builds the envelope
    → detached-subprocess POST      → captured VERBATIM by a local HTTP sink
                                      (discovered through a real server.json,
                                      exactly how a live backend is found)
    → the captured bytes are replayed into the real /api/v1/webhook/listen
      route, where HookOpPayload validates them.

The sink stands in for nothing under test: it only records the wire bytes the
real emitter produced, and those exact bytes are then driven through the real
route. If the emitter's payload shape is wrong (missing ``event_name``, or a
``type`` outside RecordType), the listen route rejects it and the consent
prompt silently never reaches the frontend — which is the bug.
"""

import json
import os
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

LISTEN_URL = "/api/v1/webhook/listen"


class _CaptureHandler(BaseHTTPRequestHandler):
    """Record every POST body verbatim; answer 200."""

    captured: list[bytes] = []

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length", 0))
        _CaptureHandler.captured.append(self.rfile.read(length))
        self.send_response(200)
        self.end_headers()

    def log_message(self, *args):  # silence per-request stderr noise
        pass


@pytest.mark.asyncio
async def test_index_consent_event_reaches_listen_route(bootstrapped_client):
    from flow_sdk.fs_store.indexer.consent_notify import surface_pending_consent
    from flow_sdk.fs_store.indexer.special_folders import (
        IndexDecision,
        drain_pending_consent,
        gate_root,
    )
    from flow_sdk.instances.paths import instance_dir
    from flow_sdk.instance_settings import get_instance_settings

    # 1. Make a project under the (sandboxed) Documents special folder and let
    #    the REAL gate classify it — this is the exact trigger of the bug.
    project_dir = get_instance_settings().user_home / "Documents" / "consent-repro-project"
    project_dir.mkdir(parents=True, exist_ok=True)
    drain_pending_consent()  # clear anything queued by earlier tests
    assert gate_root(project_dir) is IndexDecision.ASK

    # 2. Local sink the real emitter can discover + POST to.
    _CaptureHandler.captured = []
    sink = ThreadingHTTPServer(("localhost", 0), _CaptureHandler)
    threading.Thread(target=lambda: sink.serve_forever(poll_interval=0.01), daemon=True).start()

    sink_instance = instance_dir(f"consent-sink-{uuid.uuid4().hex[:8]}")
    sink_instance.mkdir(parents=True, exist_ok=True)
    server_json = sink_instance / "server.json"
    server_json.write_text(
        json.dumps(
            {
                "port": sink.server_address[1],
                "webhook_path": LISTEN_URL,
                "health_path": "/api/v1/health/status",
                "server_pid": os.getpid(),
            }
        )
    )

    try:
        # 3. Real emitter, real transport (detached subprocess POST).
        assert surface_pending_consent() == 1

        deadline = time.monotonic() + 5.0
        while not _CaptureHandler.captured and time.monotonic() < deadline:
            time.sleep(0.01)
        assert _CaptureHandler.captured, "emitter never POSTed the consent event"
        wire_bytes = _CaptureHandler.captured[0]
    finally:
        sink.shutdown()
        sink.server_close()
        server_json.unlink(missing_ok=True)

    # The frontend contract (ts_sdk indexingConsent.ts) rides in event_data.
    envelope = json.loads(wire_bytes)
    event_data = envelope["webhook_payload"]["data"]["event_data"]
    assert event_data["kind"] == "index_folder_consent"
    assert event_data["category"] == "documents"

    # 4. Replay the EXACT bytes into the real listen route.
    response = await bootstrapped_client.post(
        LISTEN_URL, content=wire_bytes, headers={"Content-Type": "application/json"}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "SUCCESS", (
        f"listen route rejected the consent event: {body.get('message')}"
    )
    assert body["data"]["status"] == "received"
