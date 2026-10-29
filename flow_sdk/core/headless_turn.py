"""One headless agent turn as a stream of plain events -- shared by ``flow process start`` and the
server route that runs it inside a live backend.

Two callers, one body: with no backend the CLI runs this in its own process; with a backend up it
asks the server to (``POST /api/v1/agentic_process/headless-turn``), because the process row is
written to the instance's SQLite and a second writer beside a live server is lock contention.

Events are dicts so they cross HTTP as NDJSON unchanged:
``{"kind": "process", "id"}``, ``{"kind": "text", "text"}``, ``{"kind": "tool", "name"}``, and a
last ``{"kind": "done", "ok", "exit_code", "text", "detail"}``.
"""

from __future__ import annotations

import contextlib
import tempfile
import uuid
from typing import AsyncIterator, Optional


async def headless_turn(
    prompt: str,
    *,
    worker_type: Optional[str] = None,
    model: Optional[str] = None,
    workdir: Optional[str] = None,
    endpoint_typeid: Optional[str] = None,
) -> AsyncIterator[dict]:
    """Run one turn and yield its events. No ``worker_type`` takes the builtin-process rule (the
    selected harness when installed, else ``deepagents``)."""
    from flow_sdk.builtin.agent_serve import Turn, TurnEngine  # noqa: PLC0415
    from flow_sdk.builtin.agentic_process import AgenticProcess  # noqa: PLC0415
    from flow_sdk.core.capabilities.registry import resolve_builtin_worker_type  # noqa: PLC0415

    cli_config: dict = {"permission_mode": "bypassPermissions"}
    if model:
        cli_config["model"] = model
    ap = await AgenticProcess(
        worker_type=worker_type or await resolve_builtin_worker_type(),
        workdir=workdir or tempfile.mkdtemp(prefix="flow-process-"),
        cli_config=cli_config,
        pty_mode=False,
        visible=False,
        # Flowpad's own skills (web-app-builder and its templates) come with the assistant.
        load_flowpad_assistant=True,
        llm_endpoint_typeid=endpoint_typeid,
    ).save()
    yield {"kind": "process", "id": str(ap.typeid)}
    answer = None
    said = False
    try:
        turn = Turn(session=str(ap.typeid), key=str(uuid.uuid4()), body=prompt)
        async for event in TurnEngine().run_stream(turn, process=ap):
            if event.kind == "text":
                said = True
                yield {"kind": "text", "text": event.text}
            elif event.kind == "tool":
                yield {"kind": "tool", "name": event.name}
            elif event.kind == "done":
                answer = event.answer
    finally:
        with contextlib.suppress(Exception):
            await ap.exit()
    ok = bool(answer and answer.ok)
    yield {
        "kind": "done",
        "ok": ok,
        "exit_code": int(answer.exit_code) if answer else 1,
        # A reply written after the stream saw the turn end (codex writes its last message as the
        # session closes) is still the answer: the engine re-reads the transcript.
        "text": "" if said or answer is None else (answer.text or ""),
        "detail": "" if ok else ((answer.detail if answer else "") or "The turn did not finish."),
    }
