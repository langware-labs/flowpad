"""Transactional owner of session names and their tab projections."""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING

from .state import (
    NameObservation,
    NamePhase,
    SessionNameState,
    bind_name_state,
    consume_name_observation,
    reduce_name,
)

if TYPE_CHECKING:
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class NamingResult:
    process: AgenticProcess | None
    changed: bool = False
    tabs_changed: bool = False


def migrate_legacy_name(process, tabs) -> SessionNameState:
    """Retain ambiguous legacy authority, with every losing candidate recorded.

    A tab's update time is a deterministic conflict tie-break, not evidence that
    somebody renamed it. Placeholder-looking explicit text remains a valid name.
    """
    candidates: dict[str, str] = {}
    if isinstance(process.name, str) and process.name.strip():
        candidates["process.name"] = process.name
    for tab in sorted(tabs, key=lambda row: (str(row.updated_date or ""), str(row.id)), reverse=True):
        if isinstance(tab.name, str) and tab.name.strip():
            candidates[f"tab:{tab.id}"] = tab.name
    context_title = (process.context_data or {}).get("display_name")
    if isinstance(context_title, str) and context_title.strip():
        candidates["context_data.display_name"] = context_title
    if not candidates:
        return SessionNameState(session_id=process.session_id)
    source, title = next(iter(candidates.items()))
    pinned = source == "process.name" and process.auto_rename is False
    return SessionNameState(
        phase=NamePhase.USER_PINNED if pinned else NamePhase.PROTECTED_UNKNOWN,
        title=title,
        source=source,
        session_id=process.session_id,
        legacy_candidates=candidates,
    )


async def reconcile_name(
    process_id: str,
    *,
    user_name: str | None = None,
    first_prompt: str | None = None,
    observation: NameObservation | None = None,
    baseline_observations: Sequence[NameObservation] = (),
    migration_observations: Sequence[NameObservation] = (),
) -> NamingResult:
    """Resolve against the durable process and atomically repair every tab.

    Provider reads belong to adapters BEFORE this call. The writer transaction
    holds no model, filesystem or network work. It never inserts missing rows.
    A user rename may include a provider snapshot captured before this call;
    its cursors are consumed atomically with the user choice, so delayed native
    manual-name records from that snapshot cannot overwrite the new name.
    """
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
    from flow_sdk.builtin.tab import Tab, broadcast_tabs_changed

    if baseline_observations and user_name is None:
        raise ValueError("Name baselines require an explicit user rename")
    db = AgenticProcess._db
    changed = tabs_changed = False
    async with db.write_transaction():
        process = await db.get_by_id(str(process_id), AgenticProcess.get_type())
        if process is None:
            return NamingResult(None)
        tabs = await Tab.get_all({"target_type": process.type, "target_id": str(process.id)})
        previous = process.naming_state
        state = SessionNameState.model_validate(previous) if previous is not None else migrate_legacy_name(process, tabs)
        state = bind_name_state(state, process.session_id)
        if state.protected and (previous is None or previous.session_id != process.session_id):
            for baseline in migration_observations:
                state = consume_name_observation(state, baseline)
        for baseline in baseline_observations:
            state = consume_name_observation(state, baseline)
        state = reduce_name(state, user_name=user_name, first_prompt=first_prompt, observation=observation)
        history_changed = process.name != state.title or (previous.session_id if previous else None) != process.session_id
        automatic = not state.protected
        changed = previous != state or process.name != state.title or process.auto_rename != automatic
        if changed:
            process, _ = await db.update_existing_data_fields(str(process.id), process.type, {
                "name": state.title,
                "naming_state": state.model_dump(mode="json"),
                "auto_rename": automatic,
            })
        if process is None:
            return NamingResult(None)
        for tab in tabs:
            if tab.name != state.title:
                _, patched = await db.update_existing_data_fields(str(tab.id), tab.type, {"name": state.title})
                tabs_changed |= patched

        async def publish() -> None:
            # The callback runs after the standalone OR enclosing request commit.
            # Hydrate then so an intervening explicit rename always wins on wire.
            durable = await db.get_by_id(str(process_id), AgenticProcess.get_type())
            if durable is not None and changed:
                await durable.notify_updated()
            if tabs_changed:
                await broadcast_tabs_changed()
            if history_changed:
                from flow_sdk.api.messages import BroadcastMessage
                from flow_sdk.server.routes.websocket import broadcast

                await broadcast(BroadcastMessage(broadcast_type="worker_history_changed").model_dump_json())

        if changed or tabs_changed:
            await db.after_commit(publish)

    durable = await db.get_by_id(str(process_id), AgenticProcess.get_type())
    if changed:
        logger.debug("session-name process=%s phase=%s revision=%s source=%s", process_id, state.phase.value, state.revision, state.source)
    return NamingResult(durable, changed, tabs_changed)
