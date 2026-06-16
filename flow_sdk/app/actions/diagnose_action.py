"""`diagnose` graph action — run the flow-diagnose skill from the UI.

Same functionality as the `flow diagnose` CLI command, exposed as a **null-entity
graph service action** (like ``inbox-list``) so the footer's Diagnose modal reaches
it the normal way — ``dataManager.callAction(new ActionInfo('diagnose', null, null,
'POST'))`` → ``/api/v1/graph/diagnose``. It runs ``_run_diagnose`` (the exact CLI
runner) headless and streams the worker's narration as SSE, so the modal shows the
same ``▸ …`` narration the CLI prints. An empty message means a full diagnostic
sweep, identical to pressing Enter at the CLI prompt.

Feed card vs. modal — the modal is the user's window onto the run. While it stays
open (the SSE client keeps consuming) the user reaches the finished popup and its
report buttons, so the UI posts NO Home-Feed card. But if the modal closed before the
run finished — the user defocused and the popup vanished while the agent was still
working — the run keeps going **detached** from the dead stream and posts a Home-Feed
card after all, so those same buttons stay reachable from the Home Feed. That late
decision is wired through ``_run_diagnose(create_feed_entry=…)`` as a callable that
reads the live connection state at posting time. The diagnosis (and, for a real issue,
its support Conversation/FlowMessage) is recorded by ``report.py`` regardless.
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

# Strong refs to detached diagnose runs. When the SSE client disconnects early we
# deliberately let the run continue (to record the diagnosis and post a Home-Feed
# card); without a reference the task could be garbage-collected mid-flight.
_PENDING_RUNS: set[asyncio.Task] = set()


@action.post(action_name="diagnose", types=None)
async def diagnose() -> StreamingResponse:
    request_info = get_current_request_info()
    body = await request_info.get_post_data() if request_info else None
    message = (body.get("message") or "").strip() if isinstance(body, dict) else ""

    queue: asyncio.Queue = asyncio.Queue()
    # Live connection state: True while the modal/SSE client is still consuming the
    # stream. The run reads this (via the create_feed_entry callable) at the moment it
    # would post the Feed card — open modal ⇒ the modal shows the buttons, no card;
    # closed-early ⇒ post the card so the buttons stay reachable from the Home Feed.
    watching = {"v": True}

    def emit(event: dict | None) -> None:
        # _run_diagnose runs on this same event loop, so a non-blocking put is safe.
        queue.put_nowait(event)

    async def _run() -> None:
        try:
            await _run_diagnose(
                message,
                DEFAULT_TRANSCRIPT_TIMEOUT_S,
                emit=emit,
                # Post a Home-Feed card ONLY if the modal is already gone by the time
                # the diagnosis is recorded — otherwise the modal surfaces it itself.
                create_feed_entry=lambda: not watching["v"],
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
    _PENDING_RUNS.add(task)
    task.add_done_callback(_PENDING_RUNS.discard)

    async def _events():
        # Immediate acknowledgment — bootstrap + agent spin-up before the first
        # "Diagnosing (session=…)" line can take several seconds (mirrors the CLI).
        ack = ("Running a full diagnostic sweep" if not message else "Diagnosing your issue") + \
            " — spinning up the agent (this can take a few seconds)…"
        yield f"data: {json.dumps({'type': 'status', 'text': ack})}\n\n"
        completed = False
        try:
            while True:
                event = await queue.get()
                if event is None:
                    completed = True  # run reached its end-of-stream sentinel
                    break
                yield f"data: {json.dumps(event)}\n\n"
        finally:
            if not completed:
                # The client disconnected before the run finished — the modal closed
                # (defocus / unmount) while the agent was still working. Do NOT cancel
                # the run: mark the modal gone and let it finish detached, so it records
                # the diagnosis and posts a Home-Feed card with the report buttons.
                watching["v"] = False

    return StreamingResponse(
        _events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
