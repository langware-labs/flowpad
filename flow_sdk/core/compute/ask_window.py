"""Putting a question in front of a person.

Two ways in, tried in order, and neither is a new surface:

1. **A live browser tab** — a targeted ``ui_command`` sends it to the ask view
   IN THE DOCK: the question replaces the content area, and the rail (user
   avatar, login) and the tab strip stay where they are. The person is still
   inside the app, and answering returns them to where they were.
2. **No tab** — borrow or start a backend through ``flow_service()`` and open a
   browser at the chrome-less ``win/`` URL: that window exists only for this
   question, so there is no app around it to keep.

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
    """Send the active tab to the question. False when no tab is listening.

    Targeted, not broadcast, and the absence of a tab is the ANSWER here rather
    than an error: it is what makes the second route run. A broadcast would
    have reported success into an empty room, and no window would ever open.

    No ``layout``: the frame lands in the dock. Sending the tab to ``win/`` used
    to strand the person on a chrome-less screen with no way back but a restart.
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
            view_type=ASK_VIEW,
            pointer=question.id,
        )
        return True
    except Exception:  # noqa: BLE001 — no socket, no server: both are "not shown"
        _log.debug("ask: no live tab to raise the question in", exc_info=True)
        return False


async def _open_a_window(question) -> bool:
    """Ensure a backend, then open a browser at the question."""
    if os.environ.get("FLOWPAD_NO_BROWSER"):
        # The same guard `flow start` uses: Electron has its own window, and a
        # test has no business spawning browsers.
        return False
    try:
        import asyncio  # noqa: PLC0415
        import webbrowser  # noqa: PLC0415

        from flow_sdk.core.connections.service import flow_service  # noqa: PLC0415

        async with flow_service() as lease:
            url = ask_url(f"http://127.0.0.1:{lease.port}", question.id)
            return bool(await asyncio.to_thread(webbrowser.open, url))
    except Exception:  # noqa: BLE001 — headless, no display, no server we may own
        _log.debug("ask: could not open a window for the question", exc_info=True)
        return False
