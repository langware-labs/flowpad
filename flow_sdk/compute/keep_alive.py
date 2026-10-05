"""Keep-alive — the machine telling the hub "someone is working in me".

A hub-launched sandbox pauses when its provider clock runs out. The hub keeps no
timer: every minute this loop reports whether the machine was in use during that
minute, and each report resets the clock to the active window
(``e2b_sandbox_active_timeout`` on the hub). No report, and the box pauses on
its own; the next inbound request wakes it.

"In use" is any of:

* a person acted in the UI during the last minute -- the UI reports it through
  the ``keep-alive`` action on this instance's ComputeNode (``note_user_activity``). An open tab nobody
  touches is NOT activity; that is exactly the box that should pause.
* an agent turn is in flight (``any_prompt_in_flight``) -- an agent working
  unattended must not be frozen mid-turn because nobody is watching. A turn
  lasts until its CLI exits, which includes the CLI waiting on the agent's
  background tasks after the answer.

* a process of this machine's user kept a core busy over the last interval
  (``detached_work_running``) -- work an agent started outside any turn, such as
  a test run launched with ``setsid nohup``, which no turn or process tree holds.
  An idle server or a sleeping shell is not; a process stuck spinning is, and
  keeps the box up until the provider's own cap.

The turn signal lives in the memory of the process running the turn, so every
process that runs turns runs this loop: the app, and each local agent deployment
(``builtin/agent_loop``), whose turns the app never sees.

Only an instance the hub assigned a ComputeNode to reports; a desktop install
never has one and never talks to the hub about this.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time

logger = logging.getLogger(__name__)

#: How often the machine reports, and how far back "the last minute" looks.
KEEP_ALIVE_INTERVAL_S = 60.0

#: The share of one core a single process must average over an interval to count as work.
BUSY_PROCESS_CORE_SHARE = 0.25

_last_user_activity: float | None = None

#: (pid, create time) -> CPU seconds that process had used at the previous tick.
_cpu_at_last_tick: dict[tuple[int, float], float] = {}


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


def detached_work_running(
    min_cpu_seconds: float = BUSY_PROCESS_CORE_SHARE * KEEP_ALIVE_INTERVAL_S, processes=None
) -> bool:
    """Whether some other process of this user used *min_cpu_seconds* of CPU since the previous call.

    Measured per process, not summed: a dozen idle loops each ticking at a few percent are
    not work, one test runner pinning a core is. The first call only takes the baseline.
    *processes* narrows the look to those ``psutil.Process`` objects (all processes by default).
    """
    import psutil  # noqa: PLC0415

    global _cpu_at_last_tick
    own = os.getpid()
    user = psutil.Process(own).username()
    now: dict[tuple[int, float], float] = {}
    busy = False
    fields = ["pid", "username", "create_time", "cpu_times"]
    candidates = psutil.process_iter(fields) if processes is None else processes
    for proc in candidates:
        try:
            info = proc.as_dict(fields) if processes is not None else proc.info
        except psutil.Error:
            continue
        if info["pid"] == own or info["username"] != user or info["cpu_times"] is None:
            continue
        key = (info["pid"], info["create_time"])
        now[key] = info["cpu_times"].user + info["cpu_times"].system
        before = _cpu_at_last_tick.get(key)
        if before is not None and now[key] - before >= min_cpu_seconds:
            busy = True
    _cpu_at_last_tick = now
    return busy


async def send_keep_alive_if_in_use() -> bool:
    """One tick: report to the hub if this machine is a hub node and was in use. True if sent."""
    from flow_sdk.cloud_client.shared.errors import HubError
    from flow_sdk.cloud_client.transport.hub_http import hub_post
    from flow_sdk.instance_settings.runtime import get_assigned_compute_node

    node_typeid = get_assigned_compute_node()
    if node_typeid is None:
        return False
    # Sampled every tick, used or not: each sample is the next one's baseline.
    detached = detached_work_running()
    if not (is_in_use() or detached):
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
