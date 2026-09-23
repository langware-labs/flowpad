"""A local agent deployment's process: ``python -m flow_sdk.builtin.agent_loop``.

Plain SDK code in the same instance (it inherits ``FLOW_INSTANCE`` from whoever started it), told
which deployment it is by ``FLOW_DEPLOYMENT_ID``. It runs the agent loop — :func:`serve` over the
channels this deployment answers: listen → gates → turn → reply on the channel → ack — and keeps it
running:

* **Channels change, the loop follows.** Every ``RECHECK_SECONDS`` it re-reads what it answers; a
  channel added, removed, re-pointed or re-gated restarts the loop over the new set, between turns.
* **A loop that fails is started again**, after ``RESTART_SECONDS`` — a crash is logged, never the
  end of the deployment.
* **It ends when the deployment does**: deleted, no longer ``serving``, or its agent disabled there.
  SIGTERM ends it between turns.

The app's ``AgentServer`` starts this process and starts it again if it dies.
"""
from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys
from typing import Any, NamedTuple, Optional

from flow_sdk.builtin.deployment_process import DEPLOYMENT_ENV

logger = logging.getLogger("agent_loop")

#: How often the loop re-reads which channels it answers and whether it should still run.
RECHECK_SECONDS = 5.0
#: How long a failed loop waits before it is started again — so a loop that fails at once does not spin.
RESTART_SECONDS = 1.0
#: The drain's cadence per channel when nothing wakes it sooner (the tag bus is this process's own).
POLL_SECONDS = 1.0


class _State(NamedTuple):
    agent: Any
    deployment: Any
    sources: list
    #: What the loop depends on — a change to it restarts the loop over the new sources.
    key: frozenset


async def _state(deployment_id: str) -> Optional[_State]:
    """What the deployment runs over, while it should run here; ``None`` once it should not."""
    from flow_sdk.builtin.agent_serve import answered_sources, serving_key  # noqa: PLC0415
    from flow_sdk.builtin.deployment import Deployment  # noqa: PLC0415

    deployment = await Deployment.get_by_id(deployment_id)
    if deployment is None or not deployment.serving:
        return None
    agent = await deployment.agent()
    if agent is None or not agent.enabled_on(deployment.id):
        return None
    sources = await answered_sources(agent, deployment)
    return _State(agent, deployment, sources, frozenset(serving_key(s) for s in sources))


async def run(deployment_id: str, *, stop: Optional[asyncio.Event] = None) -> None:
    """Run the deployment's loop until the deployment ends (or *stop* is set)."""
    stop = stop or asyncio.Event()
    while not stop.is_set():
        state = await _state(deployment_id)
        if state is None:
            logger.info("deployment %s: no longer runs here — the loop ends", deployment_id)
            return
        await _serve_until_changed(deployment_id, state, stop)


async def _serve_until_changed(deployment_id: str, state: _State, stop: asyncio.Event) -> None:
    """One generation of the loop: :func:`serve` over *state*'s channels until *stop*, a change to
    what it serves, or the loop failing (logged; the caller starts the next generation)."""
    from flow_sdk.builtin.agent_serve import hold_positions, serve, stop_serving  # noqa: PLC0415

    await hold_positions(state.deployment, state.sources)
    logger.info("deployment %s: %s answers %d channel(s)", deployment_id, state.agent.name or state.agent.id,
                len(state.sources))
    stopping = asyncio.create_task(stop.wait())
    loop = (asyncio.create_task(serve(state.agent, state.deployment, sources=state.sources, poll_every=POLL_SECONDS))
            if state.sources else None)
    try:
        while not stop.is_set():
            done, _ = await asyncio.wait({stopping, *([loop] if loop else [])}, timeout=RECHECK_SECONDS,
                                         return_when=asyncio.FIRST_COMPLETED)
            if loop is not None and loop in done:
                if not loop.cancelled() and loop.exception() is not None:
                    logger.error("deployment %s: the loop failed — started again", deployment_id,
                                 exc_info=loop.exception())
                await asyncio.sleep(RESTART_SECONDS)
                return
            if stopping in done:
                return
            now = await _state(deployment_id)
            if now is None or now.key != state.key:
                return
    finally:
        stopping.cancel()
        if loop is not None and not loop.done():
            await stop_serving(loop)


def _log_to_stderr() -> None:
    """The loop's own lines on stderr — the deployment's log file. Its own handler, not the root's:
    the SDK configures logging as it loads, and this process's story must survive that."""
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False


def main() -> None:
    _log_to_stderr()
    deployment_id = os.environ.get(DEPLOYMENT_ENV, "").strip()
    if not deployment_id:
        raise SystemExit(f"{DEPLOYMENT_ENV} is not set: which deployment should this process run?")

    async def _main() -> None:
        from flow_sdk.tags.relay import start_relay_to_app  # noqa: PLC0415

        # This process's bus has no clients; what it emits for them goes to the app's.
        start_relay_to_app()
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                loop.add_signal_handler(sig, stop.set)
            except (NotImplementedError, RuntimeError):  # pragma: no cover - windows
                pass
        await run(deployment_id, stop=stop)

    asyncio.run(_main())


if __name__ == "__main__":
    main()
