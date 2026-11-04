"""A project's cloud deploy names the placement it already has on that provider, so the hub gives that row its
machine (or returns it) instead of booting a second box. A first deploy names none. The hub is the in-memory double."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

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


def _asked(monkeypatch, body: dict) -> None:
    async def post_data():
        return body

    info = SimpleNamespace(someone_typeid="someone-user-1", get_post_data=post_data)
    monkeypatch.setattr("flow_sdk.request_context.methods.get_current_request_info", lambda: info)


async def _placement(project, provider: str, environment: str = "production") -> Deployment:
    row = Deployment(
        name="app",
        parent_type_id=str(project.typeid),
        target={"provider": provider, "scope": "s"},
        environment=environment,
    )
    await row.save()
    return row


async def test_a_first_deploy_names_no_placement(project, hub, monkeypatch):
    _asked(monkeypatch, {})

    await project.deploy_action()

    assert hub.deploy_ids == [None]


async def test_a_redeploy_names_the_placement_the_project_has_on_that_provider(project, hub, monkeypatch):
    await _placement(project, "local")
    await _placement(project, "e2b", environment="staging")
    on_gcp = await _placement(project, "gcp_vm")
    _asked(monkeypatch, {"provider": "gcp_vm"})

    await project.deploy_action()

    assert hub.deploy_ids == [str(on_gcp.id)]


async def test_no_provider_is_the_default_provider_s_placement(project, hub, monkeypatch):
    on_e2b = await _placement(project, "e2b")
    _asked(monkeypatch, {})

    await project.deploy_action()

    assert hub.deploy_ids == [str(on_e2b.id)]
