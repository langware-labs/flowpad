"""A local agent deployment's process: its Python file — the loop (``deployment_loop``), shown and
editable — run by ``main("<deployment id>", loop=…)``,
in the deployment's terminal (``builtin/deployment_process``).

Plain SDK code in the same instance (it inherits ``FLOW_INSTANCE`` from whoever started it), told
which deployment it is by its file (or ``FLOW_DEPLOYMENT_ID``). It holds the deployment's lock while
it runs — a second copy leaves at once — and says what it does on its terminal. It runs the agent loop — :func:`serve` over the
channels this deployment answers: listen → gates → turn → reply on the channel → ack — and keeps it
running:

* **Channels change, the loop follows.** Every ``RECHECK_SECONDS`` it re-reads what it answers; a
  channel added, removed, re-pointed or re-gated restarts the loop over the new set, between turns.
* **A loop that fails is started again**, after ``RESTART_SECONDS`` — a crash is logged, never the
  end of the deployment.
* **It ends when the deployment does**: deleted, no longer ``serving``, or its agent disabled there.
  SIGTERM ends it between turns.
* **It polls what it answers.** The app polls none of these channels while this process runs
  (``agent_serve.polled_by_a_deployment``), so the heartbeat for them beats here, every
  ``RECHECK_SECONDS``, each at its own interval; the loop's attention arms a driver's fast lane.

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


async def run(deployment_id: str, *, stop: Optional[asyncio.Event] = None, loop=None) -> None:
    """Run the deployment's loop until the deployment ends (or *stop* is set)."""
    stop = stop or asyncio.Event()
    while not stop.is_set():
        state = await _state(deployment_id)
        if state is None:
            logger.info("deployment %s: no longer runs here — the loop ends", deployment_id)
            return
        await _serve_until_changed(deployment_id, state, stop, loop)


async def _serve_until_changed(deployment_id: str, state: _State, stop: asyncio.Event, loop=None) -> None:
    """One generation of the loop: :func:`serve` over *state*'s channels until *stop*, a change to
    what it serves, or the loop failing (logged; the caller starts the next generation)."""
    from flow_sdk.builtin.agent_serve import hold_positions, serve, stop_serving  # noqa: PLC0415
    from flow_sdk.ingest.poller import dispatch_due_sources  # noqa: PLC0415

    await hold_positions(state.deployment, state.sources)
    own = {str(s.id) for s in state.sources}
    logger.info("deployment %s: %s answers %d channel(s)", deployment_id, state.agent.name or state.agent.id,
                len(state.sources))
    stopping = asyncio.create_task(stop.wait())
    task = (asyncio.create_task(serve(state.agent, state.deployment, sources=state.sources, poll_every=POLL_SECONDS, loop=loop))
            if state.sources else None)
    try:
        while not stop.is_set():
            await dispatch_due_sources(only=own)
            done, _ = await asyncio.wait({stopping, *([task] if task else [])}, timeout=RECHECK_SECONDS,
                                         return_when=asyncio.FIRST_COMPLETED)
            if task is not None and task in done:
                if not task.cancelled() and task.exception() is not None:
                    logger.error("deployment %s: the loop failed — started again", deployment_id,
                                 exc_info=task.exception())
                await asyncio.sleep(RESTART_SECONDS)
                return
            if stopping in done:
                return
            now = await _state(deployment_id)
            if now is None or now.key != state.key:
                return
    finally:
        stopping.cancel()
        if task is not None and not task.done():
            await stop_serving(task)


#: The deployment's console: one plain line per thing that happened (``agent_serve.console``).
CONSOLE = "flow.deployment"


def _log_to_terminal() -> None:
    """This process's story on its terminal: the loop's own lines and the console's, and every SDK
    warning or error — which otherwise went nowhere anyone looks. Its own handler, not the root's
    configuration: the SDK configures logging as it loads, and this must survive that."""
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(asctime)s %(message)s", datefmt="%H:%M:%S"))
    for name in ("agent_loop", CONSOLE):
        named = logging.getLogger(name)
        named.addHandler(handler)
        named.setLevel(logging.INFO)
        named.propagate = False
    trouble = logging.StreamHandler(sys.stderr)
    trouble.setLevel(logging.WARNING)
    trouble.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s", datefmt="%H:%M:%S"))
    logging.getLogger().addHandler(trouble)


def main(deployment_id: Optional[str] = None, loop=None) -> None:
    """Run *deployment_id*'s loop in this process (the command line's, else ``FLOW_DEPLOYMENT_ID``,
    when not given) — *loop* the deployment file's own (``deployment_loop``'s shape), else the stock
    one — unless
    another process already runs it, which this says and leaves."""
    from flow_sdk.builtin.deployment_process import hold  # noqa: PLC0415

    _log_to_terminal()
    typed = sys.argv[1] if len(sys.argv) > 1 else ""  # ``python <file> <deployment id>``
    deployment_id = (deployment_id or typed or os.environ.get(DEPLOYMENT_ENV, "")).strip()
    if not deployment_id:
        raise SystemExit(f"{DEPLOYMENT_ENV} is not set: which deployment should this process run?")
    lock = hold(deployment_id)
    if lock is None:
        logger.info("deployment %s already runs in another process — nothing to do here", deployment_id)
        return
    logger.info("deployment %s: pid %s, instance %s", deployment_id, os.getpid(), os.environ.get("FLOW_INSTANCE", "prod"))

    async def _main() -> None:
        from flow_sdk.tags.relay import start_relay_to_app  # noqa: PLC0415

        # This process's bus has no clients; what it emits for them goes to the app's.
        start_relay_to_app()
        stop = asyncio.Event()
        events = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                events.add_signal_handler(sig, stop.set)
            except (NotImplementedError, RuntimeError):  # pragma: no cover - windows
                pass
        await run(deployment_id, stop=stop, loop=loop)

    try:
        asyncio.run(_main())
    finally:
        logger.info("deployment %s: stopped", deployment_id)
        lock.close()


if __name__ == "__main__":
    main()
