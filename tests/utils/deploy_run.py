"""Run an agent's cloud deploy to its end in a test: it answers at once and its steps run after, on its activity."""

from __future__ import annotations

import asyncio
from typing import Any

from flow_sdk.activity import monitor
from flow_sdk.builtin.agent import Agent
from flow_sdk.schema.data_spec.activity_spec import ActivityProgressSpec


async def deploy_ended(agent: Agent, *args: Any, **kwargs: Any) -> ActivityProgressSpec:
    """``agent.deploy_to_cloud(*args, **kwargs)``, then the deploy activity's last tree once it has ended."""
    ended = asyncio.Event()
    last: list[ActivityProgressSpec] = []

    def hear(root, transition) -> None:
        if root.is_terminal:
            last.append(root.spec())
            ended.set()

    stop = monitor.subscribe(hear)
    try:
        await agent.deploy_to_cloud(*args, **kwargs)
        await ended.wait()
    finally:
        stop()
    return last[-1]
