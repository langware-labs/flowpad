"""`diagnose` graph action — run the flow-diagnose skill from the UI.

Same functionality as the `flow diagnose` CLI command, exposed as a **null-entity
graph service action** (like ``inbox-list``) so the footer's Diagnose modal reaches
it the normal way — ``dataManager.callAction(new ActionInfo('diagnose', null, null,
'POST'))`` → ``/api/v1/graph/diagnose``. It runs ``_run_diagnose`` (the exact CLI
runner) headless and streams the worker's narration as SSE, so the modal shows the
same ``▸ …`` narration the CLI prints. An empty message means a full diagnostic
sweep, identical to pressing Enter at the CLI prompt.

It runs the runner with ``create_feed_entry=False``: unlike the CLI, the UI does NOT
post a Home-Feed card. The diagnosis (and, for a real issue, its support
Conversation/FlowMessage) is still recorded by ``report.py``; the modal surfaces it
directly — a "View diagnosis" popup with the same report buttons — using the
``diagnosis_id`` / ``conversation_id`` carried on the stream's ``done`` event.
"""
from __future__ import annotations

import asyncio
import json
import logging

from starlette.responses import StreamingResponse

from flow_sdk.actions.action_registry import action
from flow_sdk.agentic_run_consts import DEFAULT_TRANSCRIPT_TIMEOUT_S
from flow_sdk.cli.commands.diagnose_cmd import _run_diagnose
from flow_sdk.request_context.methods import get_current_request_info

logger = logging.getLogger(__name__)


@action.post(action_name="diagnose", types=None)
async def diagnose() -> StreamingResponse:
    request_info = get_current_request_info()
    body = await request_info.get_post_data() if request_info else None
    message = (body.get("message") or "").strip() if isinstance(body, dict) else ""

    queue: asyncio.Queue = asyncio.Queue()

    def emit(event: dict | None) -> None:
        # _run_diagnose runs on this same event loop, so a non-blocking put is safe.
        queue.put_nowait(event)

    async def _run() -> None:
        try:
            # UI surface: no Home-Feed card — the modal surfaces the diagnosis itself.
            await _run_diagnose(
                message, DEFAULT_TRANSCRIPT_TIMEOUT_S, emit=emit, create_feed_entry=False
            )
        except Exception as e:  # surface the failure into the stream, never 500 silently
            emit({"type": "error", "text": f"diagnose error: {e}"})
            emit({
                "type": "done", "ok": False, "diagnosis_id": None, "conversation_id": None,
                "flow_message_id": None, "feed_posted": False, "feed_entry_id": None,
            })
        finally:
            emit(None)  # sentinel: end of stream

    task = asyncio.create_task(_run())

    async def _events():
        # Immediate acknowledgment — bootstrap + agent spin-up before the first
        # "Diagnosing (session=…)" line can take several seconds (mirrors the CLI).
        ack = ("Running a full diagnostic sweep" if not message else "Diagnosing your issue") + \
            " — spinning up the agent (this can take a few seconds)…"
        yield f"data: {json.dumps({'type': 'status', 'text': ack})}\n\n"
        try:
            while True:
                event = await queue.get()
                if event is None:
                    break
                yield f"data: {json.dumps(event)}\n\n"
        finally:
            if not task.done():
                task.cancel()

    return StreamingResponse(
        _events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
