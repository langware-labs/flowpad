"""The context a diagnosis is taken in -- one builder for the Diagnose window and Ask for help.

Where the person is comes from their tab (the ``browser_context`` its socket reports, read as
``navigation.here``); what they were doing from the session on screen. It travels with the
diagnosis, so it goes out only when the person sends one. Every part is best-effort: with no tab
open (``flow diagnose`` in a terminal) or a session that cannot be read, that part stays empty.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Awaitable, Optional

from flow_sdk.diagnose.baseline import redact
from flow_sdk.schema.data_spec.diagnose_spec import DiagnosePurpose, FlowContextSpec, SessionState, SessionTurn

logger = logging.getLogger(__name__)

#: How much of the session on screen travels: enough to see what was going on, not the whole chat.
MAX_TURNS = 6
MAX_TURN_CHARS = 500
#: How many other running sessions are named.
MAX_OTHER_SESSIONS = 5


async def _quietly(what: str, step: Awaitable[Any]) -> Any:
    try:
        return await step
    except Exception as exc:  # noqa: BLE001 -- a part that cannot be read never stops a diagnosis
        logger.info("[diagnose] context: %s not read: %s", what, exc)
        return None


async def _here(connection_id: Optional[str]) -> dict[str, Any]:
    """Where the window asked from is, as plain data; the active tab when it is not known, empty
    with no tab."""
    from flow_sdk.core.navigation import here_from  # noqa: PLC0415
    from flow_sdk.server.routes.websocket import get_active_connection_info, get_connection_infos  # noqa: PLC0415

    asked_from = get_connection_infos().get(connection_id) if connection_id else None
    active = get_active_connection_info()
    info = asked_from or (active[1] if active else None)
    if info is None:
        return {}
    here = await here_from(info.browser_context or {})
    return here.model_dump(mode="json", exclude_none=True)


def _turns(process: Any) -> list[SessionTurn]:
    """The session's last turns: what was said, without tools, sub-agents or anything derived."""
    from flow_sdk.builtin.agent_serve import transcript_entries  # noqa: PLC0415
    from flow_sdk.transcript_analyzer.entry import EntryKind  # noqa: PLC0415

    roles = {EntryKind.USER_MESSAGE: "user", EntryKind.ASSISTANT_MESSAGE: "assistant"}
    said = [
        SessionTurn(role=roles[entry.kind], text=redact(entry.text.strip()[:MAX_TURN_CHARS]))
        for entry in transcript_entries(process)
        if entry.kind in roles and not entry.is_sidechain and not entry.virtual and (entry.text or "").strip()
    ]
    return said[-MAX_TURNS:]


def _state(process: Any, turns: Optional[list[SessionTurn]] = None) -> SessionState:
    return SessionState(
        process=f"agentic_process-{process.id}",
        title=str(getattr(process, "name", None) or getattr(process, "title", None) or ""),
        status=str(getattr(process, "status", None) or ""),
        worker=str(getattr(process, "worker_type", None) or ""),
        turns=turns or [],
    )


async def _session(typeid: str) -> Optional[SessionState]:
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess  # noqa: PLC0415

    process = await AgenticProcess.get_by_id(typeid.partition("-")[2])
    if process is None:
        return None
    # Parsing a transcript reads the whole file: off the backend's loop.
    return _state(process, await asyncio.to_thread(_turns, process))


async def _other_sessions(typeid: Optional[str]) -> list[SessionState]:
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess  # noqa: PLC0415
    from flow_sdk.builtin.process_lifecycle import ProcessStatus  # noqa: PLC0415
    from flow_sdk.db.drivers.query import QueryFilter  # noqa: PLC0415

    running = await AgenticProcess.get_all(
        QueryFilter(
            match={"status": ProcessStatus.RUNNING.value},
            order_by=[{"updated_date": "desc"}],
            limit=MAX_OTHER_SESSIONS + 1,
        )
    )
    return [_state(p) for p in running if f"agentic_process-{p.id}" != typeid][:MAX_OTHER_SESSIONS]


async def _hub_login() -> str:
    from flow_sdk.core.status.build import hub_status  # noqa: PLC0415

    return hub_status().login.value


async def build_flow_context(
    *,
    purpose: DiagnosePurpose = DiagnosePurpose.REPORT,
    project_id: Optional[str] = None,
    process: Optional[str] = None,
    user_report: str = "",
    origin: str = "",
    connection_id: Optional[str] = None,
) -> FlowContextSpec:
    """The context for a diagnosis. Never raises. What the caller knows wins over what the tab says."""
    here = await _quietly("the tab", _here(connection_id)) or {}
    typeid = process or (here.get("process") or {}).get("typeid")
    tab_project = (here.get("project") or {}).get("typeid") or ""
    entity = here.get("entity") or {}
    session, others, hub_login = await asyncio.gather(
        _quietly("the session on screen", _session(typeid)) if typeid else asyncio.sleep(0),
        _quietly("the other sessions", _other_sessions(typeid)),
        _quietly("the hub login", _hub_login()),
    )
    return FlowContextSpec(
        purpose=purpose,
        project_id=project_id or tab_project.partition("-")[2] or None,
        process=typeid,
        user_report=user_report,
        origin=origin,
        view=here.get("view") or "",
        address=here.get("address") or "",
        entity=entity.get("title") or entity.get("typeid") or "",
        session=session,
        hub_login=hub_login or "",
        other_sessions=others or [],
    )
