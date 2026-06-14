"""Unit tests for re-binding an AgenticProcess's session_id on SessionStart.

When a Claude tab is opened on a fresh session id and the user then resumes a
different session from inside Claude (the in-terminal ``/resume`` picker, or
``/clear`` / post-compact), Claude switches to a different ``session_id`` than
the tab launched with. ``handle_agent_hook`` must re-bind the process — found by
its stable execution-scope id — to the live session so shares / context chips /
transcript discovery resolve to the real on-disk transcript instead of the
throwaway launch id ("Claude session unavailable").

The re-bind is gated to ``SessionStart`` so sub-agent / sidechain sessions
(which carry their own session_id but never emit a top-level SessionStart)
cannot hijack the binding.
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from flow_sdk.app.actions.listen import handle_agent_hook
from flow_sdk.core.flow.models.webhook_flow_data import AgentHookData
from flow_sdk.responses.response import ApiSuccessResponse


ENTITY_ID = "d96c2d97-0e9b-468f-9a84-35e9762acf14"
LAUNCH_SID = "2987682a-425a-487c-b92c-cc04bc357056"  # throwaway shell id
RESUMED_SID = "eb6c7759-537b-429f-bc9a-b8af23b97b95"  # the real session


def _webhook(hook_event: str, session_id: str, entity_id: str | None = ENTITY_ID) -> AgentHookData:
    execution_scope = [{"type": "agentic_process", "id": entity_id}] if entity_id else None
    return AgentHookData(
        agent_hook_id="hook-123",
        hook_data={
            "hook_event_name": hook_event,
            "session_id": session_id,
            "execution_scope": execution_scope,
            "raw_hook_data": {},
        },
        hook_entry_id="entry-123",
        hook_metadata={},
        hook_file_path="/path/to/hook",
    )


def _mock_process(session_id: str) -> MagicMock:
    proc = MagicMock()
    proc.id = ENTITY_ID
    proc.session_id = session_id
    proc.save = AsyncMock()
    proc.emit_flow_data = AsyncMock()
    return proc


async def _run(webhook_data: AgentHookData, proc: MagicMock):
    """Drive ``handle_agent_hook`` with the AgentHook entity stubbed and
    ``AgenticProcess`` lookups returning ``proc``.

    Only the lookup *methods* are patched — patching the whole class would
    break ``AgenticProcess.get_type()`` used by ``_extract_agentic_process_id``.
    """
    with patch("flow_sdk.builtin.agent_hook.AgentHook") as mock_hook_cls, \
         patch("flow_sdk.builtin.agentic_process.AgenticProcess.get_by_id",
               AsyncMock(return_value=proc)), \
         patch("flow_sdk.builtin.agentic_process.AgenticProcess.get_by_session_id",
               AsyncMock(return_value=None)):
        mock_hook = AsyncMock()
        mock_hook.handle_webhook = AsyncMock(return_value=MagicMock(model_dump=MagicMock(return_value={})))
        mock_hook.emit_flow_data = AsyncMock()
        mock_hook_cls.get_by_id = AsyncMock(return_value=mock_hook)

        result = await handle_agent_hook(webhook_data)
    return result, None


@pytest.mark.asyncio
async def test_session_start_resume_rebinds_to_live_session():
    """SessionStart carrying a different session_id re-binds the process."""
    proc = _mock_process(LAUNCH_SID)

    result, _ = await _run(_webhook("SessionStart", RESUMED_SID), proc)

    assert isinstance(result, ApiSuccessResponse)
    assert proc.session_id == RESUMED_SID
    proc.save.assert_awaited()


@pytest.mark.asyncio
async def test_session_start_same_id_is_noop():
    """SessionStart for the id we launched with (normal startup) saves nothing."""
    proc = _mock_process(LAUNCH_SID)

    await _run(_webhook("SessionStart", LAUNCH_SID), proc)

    assert proc.session_id == LAUNCH_SID
    proc.save.assert_not_awaited()


@pytest.mark.asyncio
async def test_non_session_start_does_not_rebind():
    """A differing session_id on a non-SessionStart event must NOT re-bind —
    sub-agent / sidechain sessions emit tool events with their own id."""
    proc = _mock_process(LAUNCH_SID)

    await _run(_webhook("PostToolUse", RESUMED_SID), proc)

    assert proc.session_id == LAUNCH_SID
    proc.save.assert_not_awaited()


@pytest.mark.asyncio
async def test_session_start_without_execution_scope_does_not_rebind():
    """No execution-scope id → we can't safely identify the tab → no re-bind."""
    proc = _mock_process(LAUNCH_SID)

    await _run(_webhook("SessionStart", RESUMED_SID, entity_id=None), proc)

    assert proc.session_id == LAUNCH_SID
    proc.save.assert_not_awaited()
