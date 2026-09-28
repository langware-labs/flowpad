"""Helpers for long tests that run agent deployments as REAL processes (``runs_deployments``).

A test drives entities from its own (sync) process against the backend's database, starts a
deployment with ``agent.run_locally(snippet=WRAPPER)`` — the stock loop on the mock worker — and
ends it with :func:`end` (a pause, which stops the process and keeps the supervisor from starting
it again).
"""
from __future__ import annotations

import asyncio
import time
import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin import deployment_process
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.deployment import Deployment

#: The deployment's loop on the mock worker (a subprocess cannot be monkeypatched).
WRAPPER = str(Path(__file__).resolve().parents[1] / "utils" / "mock_agent_loop.py")


def run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def until(what: str, predicate, *, within: float):
    """``predicate()`` once it is truthy; a failure naming *what* after *within* seconds."""
    deadline = time.monotonic() + within
    while time.monotonic() < deadline:
        found = predicate()
        if found:
            return found
        time.sleep(0.2)
    pytest.fail(f"{what}: not within {within}s")


def agent(prefix: str, **fields) -> Agent:
    made = Agent(name=f"{prefix}-{uuid.uuid4().hex[:6]}", worker_type="claude", system_prompt="Be brief.", **fields)
    run(made.save())
    return made


def alive(deployment):
    """The deployment's row while its process runs, else ``None``."""
    fresh = run(Deployment.get_by_id(deployment.id))
    return fresh if fresh is not None and deployment_process.alive(fresh) else None


class Console:
    """What the deployment's process printed: its terminal's output (``Shell.read``)."""

    def __init__(self, deployment) -> None:
        self.deployment = deployment

    def read_text(self) -> str:
        from flow_sdk.builtin.shell import Shell

        fresh = run(Deployment.get_by_id(self.deployment.id))
        shell_id = deployment_process.shell_id_of(fresh) if fresh is not None else ""
        shell = run(Shell.get_by_id(shell_id)) if shell_id else None
        return run(shell.read()).decode(errors="replace") if shell is not None else ""

    def __str__(self) -> str:
        return self.read_text()[-1500:]


def ready(deployment, channels: int) -> Console:
    """Wait until the deployment's process runs its loop over *channels* channels; its console."""
    until("the deployment's process", lambda: alive(deployment), within=30)
    console = Console(deployment)
    until(f"the loop to answer {channels} channels", lambda: f"answers {channels} channel(s)" in console.read_text(), within=30)
    return console


def end(*deployments) -> None:
    """Pause each deployment: its process stops, and the supervisor does not start it again."""
    for deployment in deployments:
        fresh = run(Deployment.get_by_id(deployment.id))
        if fresh is not None:
            run(fresh.pause())
