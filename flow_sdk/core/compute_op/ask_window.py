"""Putting a question in front of a person.

Two ways in, tried in order, and neither is a new surface:

1. **A live browser tab** — a targeted ``ui_command`` opens the question as a
   MODAL, on top of whatever the person is already looking at. If that happens
   to be a wizard's own progress page, it stays visible right behind the
   dialog — nothing about that page has to know a question exists. Answering
   or cancelling just closes the dialog; there was never anywhere to "go back"
   to, because nothing was ever navigated away from.
2. **No tab** — open a browser at the chrome-less ``win/`` URL on THIS backend:
   that window exists only for this question, so there is no app around it to
   keep, and no page that could stay visible behind a dialog. A question is
   only ever raised in the process that serves the answer routes
   (``ask.ask_person``), so the window points back at the one place its answer
   can land.

Degrading to nothing is a legitimate outcome, not a failure: a headless box, a
test, or ``FLOWPAD_NO_BROWSER`` all mean the question is registered and nobody
was shown it. The op then times out and says so, which is the truthful answer —
better than raising here and blaming the machine for a window that could never
have opened.
"""

from __future__ import annotations

import logging
import os

_log = logging.getLogger(__name__)

#: The chrome-less layout and the view that draws a question. Both already
#: exist as routes; this module only addresses them.
ASK_VIEW = "ask"
WIN_LAYOUT = "win"


def ask_url(base: str, question_id: str) -> str:
    """Where a question is drawn. One spelling, shared by the push and the open."""
    return f"{base.rstrip('/')}/{WIN_LAYOUT}/{ASK_VIEW}/{question_id}"


async def raise_question(question, *, try_window: bool = True) -> bool:
    """Show *question* to a person. True when something was actually raised.

    Never raises: the caller is mid-attempt and a window that failed to open is
    a reason to time out, not an exception to unwind a run with.

    ``try_window=False`` skips the browser fallback — for a caller RETRYING the
    live-tab push after an earlier ``raise_question`` already tried both: a
    window that failed to open once (no display, or ``FLOWPAD_NO_BROWSER``,
    which the desktop app always sets) would open a fresh tab on every retry
    otherwise, instead of failing the same way every time.
    """
    if await _push_to_live_tab(question):
        return True
    return await _open_a_window(question) if try_window else False


async def _push_to_live_tab(question) -> bool:
    """Open the question as a MODAL on the active tab. False when none is listening.

    Targeted, not broadcast, and the absence of a tab is the ANSWER here rather
    than an error: it is what makes the second route run. A broadcast would
    have reported success into an empty room, and no window would ever open.

    Never a navigation: this used to send the tab to ``navigate_dock`` (the ask
    view replacing the content area), which meant leaving whatever the person
    was looking at — a wizard's own progress page included — to see a question
    that was itself often about that same wizard. A modal needs nothing about
    the tab's CURRENT screen; it opens on top of it, whatever it is.
    """
    try:
        from flow_sdk.notifications.ui_command import send_ui_command  # noqa: PLC0415
        from flow_sdk.server.routes.websocket import get_active_connection  # noqa: PLC0415

        target = get_active_connection()
        if target is None:
            return False
        _connection_id, socket = target
        await send_ui_command(
            socket,
            "open_ask_modal",
            pointer=question.id,
            # A screen showing this run claims the question instead of the tab being sent away.
            run=question.run,
        )
        return True
    except Exception:  # noqa: BLE001 — no socket, no server: both are "not shown"
        _log.debug("ask: no live tab to raise the question in", exc_info=True)
        return False


async def withdraw_question(question) -> None:
    """Close *question*'s modal on the active tab — nobody is waiting for its answer.

    For an ask whose caller was cancelled (a setup run replaced by a newer one):
    left open, the modal offers a form whose answer resolves nothing. The tab
    closes it only when it is still showing THIS question, so a newer question
    that already replaced it stays. Never raises, same as the push that opened it.
    """
    try:
        from flow_sdk.notifications.ui_command import send_ui_command  # noqa: PLC0415
        from flow_sdk.server.routes.websocket import get_active_connection  # noqa: PLC0415

        target = get_active_connection()
        if target is None:
            return
        _connection_id, socket = target
        await send_ui_command(socket, "close_ask_modal", pointer=question.id)
    except Exception:  # noqa: BLE001 — no socket, no server: nothing to close
        _log.debug("ask: no live tab to withdraw the question from", exc_info=True)


async def _open_a_window(question) -> bool:
    """Open a browser at the question on this backend's own port."""
    if os.environ.get("FLOWPAD_NO_BROWSER"):
        # The same guard `flow start` uses: Electron has its own window, and a
        # test has no business spawning browsers.
        return False
    try:
        import asyncio  # noqa: PLC0415
        import webbrowser  # noqa: PLC0415

        from flow_sdk.config import load_server_info  # noqa: PLC0415

        port = load_server_info().get("port")
        if not port:
            return False
        url = ask_url(f"http://127.0.0.1:{port}", question.id)
        return bool(await asyncio.to_thread(webbrowser.open, url))
    except Exception:  # noqa: BLE001 — headless, no display
        _log.debug("ask: could not open a window for the question", exc_info=True)
        return False
