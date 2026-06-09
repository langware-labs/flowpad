"""`diagnose` graph action — run the flow-diagnose skill from the UI.

Same functionality as the `flow diagnose` CLI command, exposed as a **null-entity
graph service action** (like ``inbox-list``) so the footer's Diagnose modal reaches
it the normal way — ``dataManager.callAction(new ActionInfo('diagnose', null, null,
'POST'))`` → ``/api/v1/graph/diagnose``. It runs ``_run_diagnose`` (the exact CLI
runner) headless and streams the worker's narration as SSE, so the modal shows the
same ``▸ …`` narration the CLI prints. An empty message means a full diagnostic
sweep, identical to pressing Enter at the CLI prompt. The skill records the diagnosis
(and a Feed entry only for real issues) itself — this action adds no diagnosis logic.
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


async def _broadcast_feed_entry_created(feed_entry_id: str) -> None:
    """Make the diagnosis Feed entry appear live, without a manual refresh.

    The FeedEntry is created by the skill's ``report.py``, which runs in a separate
    worker subprocess and writes straight to the DB — so the in-process WS broadcast
    that ``Entity.save`` normally fires never reached connected clients, and the Home
    Feed only picked it up on a manual refetch. This action runs INSIDE the server
    process, so once the entry is committed we load it and emit the exact same
    ``create`` notification a normal in-process save would: the Feed's type-level
    watch re-queries and the card shows up reactively.
    """
    try:
        from flow_sdk.api.api_types.messages import DataOpMessage, OperationType
        from flow_sdk.builtin.feed_entry import FeedEntry
        from flow_sdk.core.network.resource_tracker import handle_entity_op

        entry = await FeedEntry.get_by_id(feed_entry_id)
        if entry is None:
            return
        await handle_entity_op(
            DataOpMessage(data=entry, op=OperationType.CREATE, to_entity=entry.typeid)
        )
    except Exception as e:
        logger.warning("diagnose: failed to broadcast feed entry %s: %s", feed_entry_id, e)


@action.post(action_name="diagnose", types=None)
async def diagnose() -> StreamingResponse:
    request_info = get_current_request_info()
    body = await request_info.get_post_data() if request_info else None
    message = (body.get("message") or "").strip() if isinstance(body, dict) else ""

    queue: asyncio.Queue = asyncio.Queue()
    new_feed_entry_id: str | None = None

    def emit(event: dict | None) -> None:
        # _run_diagnose runs on this same event loop, so a non-blocking put is safe.
        nonlocal new_feed_entry_id
        if event is not None and event.get("type") == "done":
            new_feed_entry_id = event.get("feed_entry_id")
        queue.put_nowait(event)

    async def _run() -> None:
        try:
            await _run_diagnose(message, DEFAULT_TRANSCRIPT_TIMEOUT_S, emit=emit)
            # The entry was written out-of-process by report.py; rebroadcast its
            # creation in-process so the Home Feed updates without a refresh.
            if new_feed_entry_id:
                await _broadcast_feed_entry_created(new_feed_entry_id)
        except Exception as e:  # surface the failure into the stream, never 500 silently
            emit({"type": "error", "text": f"diagnose error: {e}"})
            emit({"type": "done", "ok": False, "diagnosis_id": None, "feed_posted": False, "feed_entry_id": None})
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
