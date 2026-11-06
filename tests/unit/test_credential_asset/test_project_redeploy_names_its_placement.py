"""A project deploy names the placement it is for: a first deploy names none (the plan makes one), a redeploy
names its row, and one an earlier attempt planned but never put on a machine is continued, not doubled. A
project may otherwise be deployed any number of times. The hub is the in-memory double."""

from __future__ import annotations

import pytest

from flow_sdk.builtin.agent_cloud_deploy import run_deployment_steps
from flow_sdk.builtin.deployment import Deployment
from flow_sdk.builtin.project import Project
from tests.utils import fake_hub_store

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


@pytest.fixture
def hub(project, monkeypatch):
    monkeypatch.setattr(Project, "ensure_on_hub", _shared)  # sharing the project is not under test here
    return fake_hub_store.install(monkeypatch)


async def _shared(self, *args, **kwargs):
    return False


async def _placement(project, provider: str, *, on_a_machine: bool) -> Deployment:
    row = Deployment(
        name="app",
        parent_type_id=str(project.typeid),
        target={"provider": provider, "scope": "s"},
        environment="production",
        origin={"kind": provider, "provider": provider, "external_id": "compute_node-1" if on_a_machine else ""},
    )
    await row.save()
    return row


async def _deployed(project, **kwargs) -> str:
    """The placement one deploy (run to its end) is for."""
    import asyncio

    from flow_sdk.activity import monitor

    ended = asyncio.Event()
    stop = monitor.subscribe(lambda root, _t: ended.set() if root.is_terminal else None)
    try:
        answer = await run_deployment_steps(project, "user-1", None, "production", provider="e2b", **kwargs)
        await ended.wait()
    finally:
        stop()
    return answer["deployment_id"]


async def test_a_running_placement_is_not_reused(project, hub):
    running = await _placement(project, "e2b", on_a_machine=True)
    assert await _deployed(project) != str(running.id), "deployed again: a second deployment"


async def test_a_planned_placement_without_a_machine_is_continued(project, hub):
    planned = await project.plan_deployment("production", provider="e2b")  # a deploy refused before its machine
    assert await _deployed(project) == str(planned.id)


async def test_a_redeploy_names_its_row(project, hub):
    first = await _deployed(project)
    assert await _deployed(project, deployment_id=first) == first
