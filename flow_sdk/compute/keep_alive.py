"""Keep-alive — the machine telling the hub "someone is working in me".

A hub-launched sandbox pauses when its provider clock runs out. The hub keeps no
timer: every minute this loop reports whether the machine was in use during that
minute, and each report resets the clock to the active window
(``e2b_sandbox_active_timeout`` on the hub). No report, and the box pauses on
its own; the next inbound request wakes it.

"In use" is either of:

* a person acted in the UI during the last minute -- the UI reports it through
  the ``keep-alive`` action on this instance's ComputeNode (``note_user_activity``). An open tab nobody
  touches is NOT activity; that is exactly the box that should pause.
* an agent turn is in flight (``any_prompt_in_flight``) -- an agent working
  unattended must not be frozen mid-turn because nobody is watching.

Only an instance the hub assigned a ComputeNode to runs the loop; a desktop
install never has one and never talks to the hub about this.
"""

from __future__ import annotations

import asyncio
import logging
import time

logger = logging.getLogger(__name__)

#: How often the machine reports, and how far back "the last minute" looks.
KEEP_ALIVE_INTERVAL_S = 60.0

_last_user_activity: float | None = None


def note_user_activity() -> None:
    """A person just acted in the UI."""
    global _last_user_activity
    _last_user_activity = time.monotonic()


def is_in_use(now: float | None = None) -> bool:
    """Whether the machine was in use during the last interval."""
    from flow_sdk.builtin.agentic_process.agentic_process import any_prompt_in_flight

    now = time.monotonic() if now is None else now
    if _last_user_activity is not None and now - _last_user_activity <= KEEP_ALIVE_INTERVAL_S:
        return True
    return any_prompt_in_flight()


async def send_keep_alive_if_in_use() -> bool:
    """One tick: report to the hub if this machine is a hub node and was in use. True if sent."""
    from flow_sdk.cloud_client.shared.errors import HubError
    from flow_sdk.cloud_client.transport.hub_http import hub_post
    from flow_sdk.instance_settings.runtime import get_assigned_compute_node

    node_typeid = get_assigned_compute_node()
    if node_typeid is None or not is_in_use():
        return False
    try:
        # The hub addresses an entity by its bare id; the typeid form is a 422 there.
        node_id = node_typeid.removeprefix("compute_node-")
        await hub_post("compute_node", {}, entity_id=node_id, action="keep-alive")
    except HubError as e:
        # Not retried: the next tick is a minute away, and a missed report costs at
        # most the difference between the active and idle windows.
        logger.warning("keep-alive for %s was refused: %s", node_typeid, e)
        return False
    return True


async def run_keep_alive_loop() -> None:
    """Report once a minute for the life of the server."""
    while True:
        await asyncio.sleep(KEEP_ALIVE_INTERVAL_S)
        try:
            await send_keep_alive_if_in_use()
        except Exception:  # noqa: BLE001 -- the loop must outlive any one bad tick
            logger.exception("keep-alive tick failed")
