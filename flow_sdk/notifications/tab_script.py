"""Run a script in an open Flowpad tab and get its answer back.

Every other ``ui_command`` is one-way: the server tells a tab to do something and
never hears how it went. A script is a question, so this is the one request/response
on that channel: ``run_script`` goes out with a ``request_id``, the tab runs the code
with the SDK in scope, and answers with a ``ui_command_result`` frame carrying
``{ok, value}`` or ``{ok: false, error}``.

A script that throws is an ANSWER (``ok: false``). ``NoTab`` is the one failure: there
is no tab to run it in.
"""

from __future__ import annotations

import asyncio
from typing import Any, Optional
from uuid import uuid4

# How long one script may run. The caller (a live-session turn) holds its session's
# queue while it waits, so a script that never settles must not hold it forever.
SCRIPT_SECONDS = 120.0

# request id -> (the tab it was sent to, the waiter). A request outlives nothing: it is
# removed when answered, when its tab closes, and when its time is up.
_waiting: dict[str, tuple[str, asyncio.Future]] = {}


class NoTab(Exception):
    """No Flowpad tab is open to run the script in; the message says so."""


async def run_script_in_tab(code: str, *, connection_id: Optional[str] = None) -> dict[str, Any]:
    """Run ``code`` in the named tab, else the active one. Answers ``{"ok": True, "value": …}``
    (plain JSON) or ``{"ok": False, "error": "…"}``."""
    from flow_sdk.core.navigate import NavigateResult, pick_connection  # noqa: PLC0415
    from flow_sdk.notifications.ui_command import send_ui_command  # noqa: PLC0415

    picked = pick_connection(connection_id)
    if isinstance(picked, NavigateResult):
        raise NoTab("No Flowpad tab is open on this machine to run the script in.")
    tab_id, ws = picked
    request_id = str(uuid4())
    waiter: asyncio.Future = asyncio.get_running_loop().create_future()
    _waiting[request_id] = (tab_id, waiter)
    try:
        await send_ui_command(ws, "run_script", request_id=request_id, code=code)
        return await asyncio.wait_for(waiter, SCRIPT_SECONDS)
    except asyncio.TimeoutError:
        return {"ok": False, "error": f"the script did not finish within {SCRIPT_SECONDS:.0f}s"}
    finally:
        _waiting.pop(request_id, None)


def script_answered(frame: dict[str, Any]) -> None:
    """A tab's ``ui_command_result`` frame: hand it to whoever waits for it. A late or
    unknown answer is dropped."""
    held = _waiting.get(str(frame.get("request_id") or ""))
    if held is None or held[1].done():
        return
    if frame.get("ok"):
        held[1].set_result({"ok": True, "value": frame.get("value")})
    else:
        held[1].set_result({"ok": False, "error": str(frame.get("error") or "the script failed")})


def tab_closed(connection_id: str) -> None:
    """The tab is gone: every script it was running is answered now, not at its time cap."""
    for tab_id, waiter in list(_waiting.values()):
        if tab_id == connection_id and not waiter.done():
            waiter.set_result({"ok": False, "error": "the Flowpad tab closed before the script answered"})
