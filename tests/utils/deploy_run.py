"""Run a project's cloud deploy to its end in a test: it answers at once and its steps run after, on its activity."""

from __future__ import annotations

import asyncio
from typing import Any

from flow_sdk.activity import monitor
from flow_sdk.builtin.agent_cloud_deploy import run_deployment_steps
from flow_sdk.schema.data_spec.activity_spec import ActivityProgressSpec


async def deploy_ended(agent, *args: Any, **kwargs: Any) -> ActivityProgressSpec:
    """``run_deployment_steps(<agent's project>, actor, agent, ...)`` — the agent deployed as main — then the deploy activity's last tree once it has ended."""
    ended = asyncio.Event()
    last: list[ActivityProgressSpec] = []

    def hear(root, transition) -> None:
        if root.is_terminal:
            last.append(root.spec())
            ended.set()

    stop = monitor.subscribe(hear)
    try:
        actor, *rest = args
        await run_deployment_steps(await agent._owning_project(), actor, agent, *rest, **kwargs)
        await ended.wait()
    finally:
        stop()
    return last[-1]


async def deploy_steps(agent, actor, *args: Any, **kwargs: Any) -> dict:
    """``run_deployment_steps`` for *agent*'s project, the agent as main."""
    return await run_deployment_steps(await agent._owning_project(), actor, agent, *args, **kwargs)


async def plan_for(agent, *args: Any, **kwargs: Any):
    """``Project.plan_deployment`` for *agent*'s project, the agent as main."""
    return await (await agent._owning_project()).plan_deployment(*args, main_agent=agent, **kwargs)
