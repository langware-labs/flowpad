"""Putting a question in front of a person.

Two ways in, tried in order, and neither is a new surface:

1. **A live browser tab** — a targeted ``ui_command`` sends it to ``win/``, the
   chrome-less focus layout that already exists (``FocusLayout``: "no sidebars,
   no footer, no tab strip, no app chrome"). The routed view IS the window.
2. **No tab** — open a browser at the same ``win/`` URL on THIS backend. A
   question is only ever raised in the process that serves the answer routes
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


async def raise_question(question) -> bool:
    """Show *question* to a person. True when something was actually raised.

    Never raises: the caller is mid-attempt and a window that failed to open is
    a reason to time out, not an exception to unwind a run with.
    """
    if await _push_to_live_tab(question):
        return True
    return await _open_a_window(question)


async def _push_to_live_tab(question) -> bool:
    """Send the active tab to the question. False when no tab is listening.

    Targeted, not broadcast, and the absence of a tab is the ANSWER here rather
    than an error: it is what makes the second route run. A broadcast would
    have reported success into an empty room, and no window would ever open.
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
            "navigate_dock",
            layout=WIN_LAYOUT,
            view_type=ASK_VIEW,
            pointer=question.id,
        )
        return True
    except Exception:  # noqa: BLE001 — no socket, no server: both are "not shown"
        _log.debug("ask: no live tab to raise the question in", exc_info=True)
        return False


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
