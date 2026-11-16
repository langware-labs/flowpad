"""Deterministic model boundary for the real message-tags browser acceptance rig.

Only the LLM endpoint is replaced. Ontology selection, FlowCall validation,
message persistence, tag mutation and automation execution remain production code.
"""
from __future__ import annotations

import asyncio
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_gates: dict[str, tuple[asyncio.AbstractEventLoop, asyncio.Event]] = {}


async def _external_executor_gate(run_id: str) -> None:
    """Hold a test executor at its external boundary, correlated by exact run ID."""
    if not os.environ.get("MOCK_MESSAGE_TAG_CONTROL_PORT"):
        return
    release = asyncio.Event()
    _gates[run_id] = (asyncio.get_running_loop(), release)
    try:
        await release.wait()
    finally:
        _gates.pop(run_id, None)


def _start_control() -> None:
    port = os.environ.get("MOCK_MESSAGE_TAG_CONTROL_PORT")
    if not port:
        return

    class Control(BaseHTTPRequestHandler):
        def do_POST(self):
            run_id = self.path.removeprefix("/release/")
            gate = _gates.get(run_id)
            self.send_response(204 if gate else 404)
            self.end_headers()
            if gate:
                gate[0].call_soon_threadsafe(gate[1].set)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", int(port)), Control)
    threading.Thread(target=server.serve_forever, daemon=True).start()


class MessageTagEndpoint:
    typeid = "llm_endpoint-message-tags-test"

    async def create_completion(self, system: str, user: str, timeout: float) -> str:
        del system, timeout
        payload = user.split("Input JSON:\n", 1)[1].split("\n\nAnswer with JSON", 1)[0]
        data = json.loads(payload)
        message = json.dumps(data["message"]).lower()
        if "classifier-failure" in message:
            raise RuntimeError("Intentional classifier fixture failure")
        names = [entry["name"] for entry in data["ontology"]]
        suffixes = ("billing.refund", "priority.today", "message.action-required")
        tags = [] if "unmatched-message" in message else [
            name for name in names if name.endswith(suffixes)
        ]
        return json.dumps({"tags": tags})


def install() -> None:
    from flow_sdk.core.compute_op import runner  # noqa: PLC0415
    from flow_sdk.builtin import trigger_callbacks  # noqa: PLC0415

    async def endpoint():
        return MessageTagEndpoint()

    runner._box_llm = endpoint
    _start_control()

    @trigger_callbacks.register("message_tags_acceptance_refund")
    async def refund(_trigger, _changes):
        from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415
        from flow_sdk.stream_inbox.message_tags import automation_assignment  # noqa: PLC0415

        correlation = automation_assignment.get()
        assert correlation, "The queue must carry exact message/trigger/run identity"
        message = await FlowMessage.get_by_id(correlation[0])
        await message.add_tag("qa.message-tags.billing.receipt")
        await _external_executor_gate(correlation[2])
        await message.add_tag("qa.message-tags.billing.review")

    @trigger_callbacks.register("message_tags_acceptance_review")
    async def review(_trigger, _changes):
        from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415
        from flow_sdk.stream_inbox.message_tags import automation_assignment  # noqa: PLC0415

        correlation = automation_assignment.get()
        await _external_executor_gate(correlation[2])
        message = await FlowMessage.get_by_id(correlation[0])
        # The cycle reaches the real assignment path. It must not run refund twice.
        await message.add_tag("qa.message-tags.billing.refund")
