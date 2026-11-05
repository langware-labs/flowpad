"""The context a diagnosis carries: where the tab is, the session on screen, and nothing that stops
a diagnosis when a part cannot be read."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.diagnose import build_flow_context
from flow_sdk.diagnose import context as ctx_module
from flow_sdk.schema.data_spec.diagnose_spec import SessionState, SessionTurn
from flow_sdk.transcript_analyzer.entry import EntryKind

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval

PROCESS = "agentic_process-7d9f6f0a-6f21-4d3c-9a33-0d4f0a1b2c3d"


def _entry(kind: EntryKind, text: str, **over) -> SimpleNamespace:
    return SimpleNamespace(kind=kind, text=text, is_sidechain=False, virtual=False, **over)


def test_turns_are_the_last_things_said_cut_and_redacted():
    entries = [_entry(EntryKind.USER_MESSAGE, f"turn {n}") for n in range(10)]
    entries.append(_entry(EntryKind.TOOL_USE, "not said"))
    entries.append(SimpleNamespace(kind=EntryKind.USER_MESSAGE, text="sub-agent", is_sidechain=True, virtual=False))
    entries.append(_entry(EntryKind.ASSISTANT_MESSAGE, "x" * 900))
    entries.append(_entry(EntryKind.USER_MESSAGE, "my password=hunter2secret"))

    with patch("flow_sdk.builtin.agent_serve.transcript_entries", return_value=entries):
        turns = ctx_module._turns(object())

    assert len(turns) == ctx_module.MAX_TURNS
    assert [t.text for t in turns[:-2]] == [f"turn {n}" for n in range(6, 10)]
    assert turns[-2].role == "assistant" and len(turns[-2].text) == ctx_module.MAX_TURN_CHARS
    assert "hunter2secret" not in turns[-1].text


async def test_the_tab_and_the_session_on_screen_fill_the_context():
    here = {
        "view": "agentic_process",
        "address": f"/dock/agentic_process/{PROCESS}",
        "project": {"typeid": "project-abc"},
        "process": {"typeid": PROCESS},
        "entity": {"typeid": "task-1", "title": "Fix the build"},
    }
    session = SessionState(process=PROCESS, status="running", turns=[SessionTurn(role="user", text="hi")])
    other = SessionState(process="agentic_process-other", status="running")
    with (
        patch.object(ctx_module, "_here", AsyncMock(return_value=here)),
        patch.object(ctx_module, "_session", AsyncMock(return_value=session)) as read_session,
        patch.object(ctx_module, "_other_sessions", AsyncMock(return_value=[other])),
        patch.object(ctx_module, "_hub_login", AsyncMock(return_value="offline")),
    ):
        ctx = await build_flow_context(user_report="stuck", origin="footer")

    read_session.assert_awaited_once_with(PROCESS)
    assert (ctx.view, ctx.entity, ctx.project_id, ctx.process) == ("agentic_process", "Fix the build", "abc", PROCESS)
    assert ctx.session == session and ctx.other_sessions == [other] and ctx.hub_login == "offline"


async def test_what_the_caller_knows_wins_over_the_tab():
    here = {"project": {"typeid": "project-tab"}, "process": {"typeid": "agentic_process-tab"}}
    with (
        patch.object(ctx_module, "_here", AsyncMock(return_value=here)),
        patch.object(ctx_module, "_session", AsyncMock(return_value=None)) as read_session,
        patch.object(ctx_module, "_other_sessions", AsyncMock(return_value=[])),
        patch.object(ctx_module, "_hub_login", AsyncMock(return_value="signed_in")),
    ):
        ctx = await build_flow_context(project_id="mine", process=PROCESS)

    read_session.assert_awaited_once_with(PROCESS)
    assert (ctx.project_id, ctx.process) == ("mine", PROCESS)


async def test_a_part_that_cannot_be_read_leaves_it_empty():
    boom = AsyncMock(side_effect=RuntimeError("no"))
    with (
        patch.object(ctx_module, "_here", boom),
        patch.object(ctx_module, "_other_sessions", boom),
        patch.object(ctx_module, "_hub_login", boom),
    ):
        ctx = await build_flow_context(user_report="stuck")

    assert ctx.user_report == "stuck" and not ctx.view and ctx.session is None
    assert ctx.hub_login == "" and ctx.other_sessions == []


async def test_the_window_asked_from_wins_over_the_active_tab():
    windows = {"asked": SimpleNamespace(browser_context={"CurrentPathname": "/dock/helpdesk/x"})}
    active = ("other", SimpleNamespace(browser_context={"CurrentPathname": "/"}))
    with (
        patch("flow_sdk.server.routes.websocket.get_connection_infos", return_value=windows),
        patch("flow_sdk.server.routes.websocket.get_active_connection_info", return_value=active),
    ):
        here = await ctx_module._here("asked")
        fallback = await ctx_module._here("closed-window")

    assert here["view"] == "helpdesk"
    assert fallback["view"] == "home", "a window that is gone falls back to the active tab"
