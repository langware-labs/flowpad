"""`diagnose` graph action — run the flow-diagnose skill from the UI.

Same functionality as the `flow diagnose` CLI command, exposed as a **null-entity
graph service action** (like ``stream-inbox-search``) so the footer's Diagnose modal reaches
it the normal way — ``dataManager.callAction(new ActionInfo('diagnose', null, null,
'POST'))`` → ``/api/v1/graph/diagnose``. It runs ``_run_diagnose`` (the exact CLI
runner) headless and streams the worker's narration as SSE, so the modal shows the
same ``▸ …`` narration the CLI prints. An empty message means a full diagnostic
sweep, identical to pressing Enter at the CLI prompt.

Feed card + modal — every completed run posts exactly one Home-Feed card (via
``_run_diagnose`` → ``_post_home_feed_entry``), the same as the CLI, whether or not the
modal was still open when it finished. The modal remains the live window onto the run —
it streams the narration and (for an issue) shows the report buttons — but it no longer
gates the card: the result always lands on the Home Feed too. The diagnosis (and, for a
real issue, its support Conversation/FlowMessage) is recorded by ``report.py``.

If the SSE client disconnects early (the modal closed mid-run), the run is deliberately
NOT cancelled — it finishes detached so the diagnosis is still recorded and its card
posted.
"""
from __future__ import annotations

import asyncio
import json
import logging
import shutil
import tempfile
from pathlib import Path

from starlette.responses import StreamingResponse

from flow_sdk.actions.action_registry import action
from flow_sdk.agentic_run_consts import DEFAULT_TRANSCRIPT_TIMEOUT_S
from flow_sdk.cli.commands.diagnose_cmd import _run_diagnose
from flow_sdk.request_context.methods import get_current_request_info, request_fields
from flow_sdk.sources.files import safe_name

logger = logging.getLogger(__name__)

# Strong refs to detached diagnose runs. When the SSE client disconnects early we
# deliberately let the run continue (to record the diagnosis and post its Home-Feed
# card); without a reference the task could be garbage-collected mid-flight.
_PENDING_RUNS: set[asyncio.Task] = set()


async def _save_uploads(files) -> Path | None:
    """Write what the user attached (screenshots of the issue) where the diagnose agent can read it."""
    if not files:
        return None
    attach_dir = Path(tempfile.mkdtemp(prefix="flow-diagnose-attached-"))
    for n, upload in enumerate(files if isinstance(files, list) else [files], start=1):
        # Numbered, so two files of one name both arrive; streamed off the loop, so a large one stalls nothing.
        with (attach_dir / f"{n}-{safe_name(upload.filename, fallback='attachment')}").open("wb") as out:
            await asyncio.to_thread(shutil.copyfileobj, upload.file, out)
    return attach_dir


def _attached_prompt(attach_dir: Path) -> str:
    paths = "\n".join(f"- {path}" for path in sorted(attach_dir.iterdir()))
    return (
        "The user attached these files to show the issue (screenshots are images -- open each with "
        f"the Read tool before diagnosing, and use what they show):\n{paths}"
    )


@action.post(action_name="diagnose", types=None)
async def diagnose() -> StreamingResponse:
    request_info = get_current_request_info()
    body = await request_info.get_post_data() if request_info else None
    fields = request_fields(body)
    message = (fields.get("message") or "").strip()
    # The active project the user was in when they triggered the diagnosis — stamped
    # onto the record as its origin project so "Open in terminal" can reopen there.
    project_id = fields.get("project_id") or None
    # Read the uploads now: the request is gone by the time the detached run starts.
    attach_dir = await _save_uploads(body.get("files") if isinstance(body, dict) else None)
    prompt_extra = _attached_prompt(attach_dir) if attach_dir else ""

    queue: asyncio.Queue = asyncio.Queue()

    def emit(event: dict | None) -> None:
        # _run_diagnose runs on this same event loop, so a non-blocking put is safe.
        queue.put_nowait(event)

    async def _run() -> None:
        try:
            # Every completed run posts its own Home-Feed card (issue card or no-issue
            # summary card) — same as the CLI — so the result always reaches the feed.
            await _run_diagnose(
                message, DEFAULT_TRANSCRIPT_TIMEOUT_S, emit=emit, project_id=project_id, prompt_extra=prompt_extra
            )
        except Exception as e:  # surface the failure into the stream, never 500 silently
            emit({"type": "error", "text": f"diagnose error: {e}"})
            emit({
                "type": "done", "ok": False, "diagnosis_id": None, "conversation_id": None,
                "flow_message_id": None, "feed_posted": False, "feed_entry_id": None,
            })
        finally:
            if attach_dir:
                shutil.rmtree(attach_dir, ignore_errors=True)
            emit(None)  # sentinel: end of stream

    task = asyncio.create_task(_run())
    _PENDING_RUNS.add(task)
    task.add_done_callback(_PENDING_RUNS.discard)

    async def _events():
        # Immediate acknowledgment — bootstrap + agent spin-up before the first
        # "Diagnosing (session=…)" line can take several seconds (mirrors the CLI).
        ack = ("Diagnosing your issue" if message or attach_dir else "Running a full diagnostic sweep") + \
            " — spinning up the agent (this can take a few seconds)…"
        yield f"data: {json.dumps({'type': 'status', 'text': ack})}\n\n"
        while True:
            event = await queue.get()
            if event is None:
                break  # run reached its end-of-stream sentinel
            yield f"data: {json.dumps(event)}\n\n"
        # If the client disconnected before the sentinel, the run keeps going detached
        # (we never cancel ``task``) and posts its Home-Feed card on its own.

    return StreamingResponse(
        _events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
