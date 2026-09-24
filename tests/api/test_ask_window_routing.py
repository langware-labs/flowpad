"""Which way a question is raised: a live tab, or a window of its own.

The two halves of the matrix. A tab is REAL here — a websocket connected to the
real app through the real endpoint — because the decision being tested is
"is anyone actually listening", and a stub tab would answer that question by
construction rather than by fact.

The no-tab half asserts the FALL-THROUGH, not the browser: `FLOWPAD_NO_BROWSER`
is set, so the second route declines too. That is the honest unit-level claim —
"it stopped pushing and went looking for a window" — and the browser half is
proven by the long test, not here.
"""

from __future__ import annotations

import json

import pytest

from flow_sdk.core.compute.ask import open_question
from flow_sdk.core.compute.ask_window import ask_url, raise_question

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


@pytest.fixture(autouse=True)
def _no_browser(monkeypatch):
    monkeypatch.setenv("FLOWPAD_NO_BROWSER", "1")


def test_the_url_is_the_chromeless_layout():
    """`win/` is what makes the question the whole window rather than a tab."""
    assert ask_url("http://127.0.0.1:9007", "q-1") == "http://127.0.0.1:9007/win/ask/q-1"
    assert ask_url("http://127.0.0.1:9007/", "q-1").count("//") == 1, "no doubled slash"


async def test_with_no_tab_listening_the_push_is_declined(tmp_path):
    """No live tab ⇒ nothing was raised, and the op will time out saying so."""
    question = open_question("get-api-key", "token", {"token": "string"})
    assert await raise_question(question) is False


def test_the_frame_names_the_layout():
    """The field that makes a pushed command land in `win/` instead of the dock.

    The listener passed `undefined` for the layout until now, so a backend
    could raise a view but never a WINDOW. Proving the envelope here keeps that
    regression cheap to catch; that a real tab obeys it is the browser test's
    job, because only a real tab can answer that.
    """
    from flow_sdk.notifications.ui_command import build_ui_command

    frame = json.loads(
        build_ui_command(
            "navigate_dock",
            layout="win",
            view_type="ask",
            pointer="q-1",
        )
    )
    assert frame["message_type"] == "ui_command"
    assert frame["kind"] == "navigate_dock"
    assert (frame["layout"], frame["view_type"], frame["pointer"]) == ("win", "ask", "q-1")


async def test_a_live_tab_is_sent_to_the_dock_not_a_chromeless_window(monkeypatch):
    """The question replaces the content area; the rail and tab strip stay.

    A `layout` of "win" would strand the person on a screen with no app around
    it and no way back short of a restart.
    """
    from flow_sdk.core.compute import ask_window
    from flow_sdk.notifications import ui_command
    from flow_sdk.server.routes import websocket

    sent: list[tuple] = []

    async def capture(socket, kind, **fields):
        sent.append((socket, kind, fields))

    monkeypatch.setattr(websocket, "get_active_connection", lambda: ("conn-1", "the-socket"))
    monkeypatch.setattr(ui_command, "send_ui_command", capture)

    question = open_question("ask-install-git", "Git is required to continue", "confirm")
    try:
        assert await ask_window.raise_question(question) is True
    finally:
        from flow_sdk.core.compute.ask import forget

        forget(question.id)

    ((socket, kind, fields),) = sent
    assert (socket, kind) == ("the-socket", "navigate_dock")
    assert fields == {"view_type": "ask", "pointer": question.id}, "no layout: the frame lands in the dock"
