"""A driver that takes provider pushes declares which variable holds its public URL; a cloud deploy asks
the hub for one webhook per such driver, whose URL the hub stores as that variable — so readiness finds it
and "use mine" never copies this computer's. On the deployment's machine, placing the values verifies the
sources that read them. The hub is the in-memory double (``tests/utils/fake_hub_store``). No network."""
from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.credential_service import drop_folder, place_values, save_credential, use_mine
from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.data_source import DataSource, SourceStatus
from flow_sdk.builtin.readiness import NotReady
from flow_sdk.ingest.driver_runtime import DRIVERS
from flow_sdk.ingest.testing import make_data_source
from flow_sdk.schema.data_spec.data_driver_spec import CURRENT_SCHEMA, AuthSpec, DataDriverSpec
from flow_sdk.schema.data_spec.webhook_spec import DriverWebhookSpec
from flow_sdk.sources.families import RecordSource
from tests.utils import fake_hub_store
from tests.utils.deployments import make_deployment

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

VARS = {"key": "PUSHED_KEY", "webhook_url": "PUSHED_WEBHOOK_URL"}


class _Pushed(RecordSource):
    provider = "hook-pushed"


class _Polled(RecordSource):
    provider = "hook-polled"


@pytest.fixture
def drivers():
    manifests = {
        _Pushed: DataDriverSpec(name=_Pushed.provider, schema=CURRENT_SCHEMA,
                                auth=AuthSpec(credential="pushed", vars=VARS),
                                webhook=DriverWebhookSpec(url_var="webhook_url", required_headers=["x-sig"])),
        _Polled: DataDriverSpec(name=_Polled.provider, schema=CURRENT_SCHEMA,
                                auth=AuthSpec(credential="polled", vars={"key": "POLLED_KEY"})),
    }
    for cls, manifest in manifests.items():
        DataDriver.register(DataDriver.for_class(cls, manifest=manifest))
    yield
    for cls in manifests:
        DRIVERS.unregister(cls.provider)


@pytest.fixture
def hub(monkeypatch):
    return fake_hub_store.install(monkeypatch)


async def _agent(project) -> Agent:
    agent = Agent(name="hooked-agent", project_id=str(project.id))
    await agent.save()
    for cls in (_Pushed, _Pushed, _Polled):
        await make_data_source(cls.provider, owner=f"agent-{agent.id}").save()
    return agent


async def _published(self, actor=None):
    return None


async def test_a_webhook_url_must_be_one_of_the_drivers_credential_variables():
    with pytest.raises(ValidationError, match="must be a key of auth.vars"):
        DataDriverSpec(name="hook-bad", schema=CURRENT_SCHEMA, auth=AuthSpec(credential="bad", vars={"key": "BAD_KEY"}),
                       webhook=DriverWebhookSpec(url_var="webhook_url"))


async def test_one_webhook_per_pushing_driver_named_by_it_and_stored_as_its_variable(home, project, drivers):
    agent = await _agent(project)

    (spec,) = await agent.webhook_specs()

    assert (spec.name, spec.var, spec.path) == ("hook-pushed", "PUSHED_WEBHOOK_URL", "/api/v1/data_source/webhook/hook-pushed")
    assert spec.methods == ["POST"] and spec.required_headers == ["x-sig"]


async def test_the_hub_stores_the_url_so_use_mine_never_copies_this_computers(home, project, drivers, hub, monkeypatch):
    agent = await _agent(project)
    await save_credential(scope="project", project_id=str(project.id),
                          manifest={"name": "pushed", "vars": {v: {} for v in VARS.values()}, "setup": "x"},
                          values={"PUSHED_KEY": "k-1", "PUSHED_WEBHOOK_URL": "http://host.docker.internal:6001/hook"})
    await save_credential(scope="project", project_id=str(project.id),
                          manifest={"name": "polled", "vars": {"POLLED_KEY": {}}, "setup": "x"}, values={"POLLED_KEY": "p-1"})
    monkeypatch.setattr(Agent, "ensure_on_hub", _published)

    with pytest.raises(NotReady):
        await agent.deploy_to_cloud("user-1", "production", provider="e2b")
    deployment = await agent.plan_deployment("production", provider="e2b")
    copied = await use_mine(str(deployment.id))
    await agent.deploy_to_cloud("user-1", "production", provider="e2b")

    assert copied["copied"] == ["POLLED_KEY", "PUSHED_KEY"], "the store already holds the webhook URL"
    assert hub.values[str(deployment.id)]["PUSHED_WEBHOOK_URL"] == hub.webhook_url("hook-pushed")
    assert hub.webhooks[str(deployment.id)] == ["hook-pushed"] and "webhooks" not in hub.deploys[-1]


async def test_placing_the_values_verifies_the_sources_that_read_them(home, project, drivers):
    agent = await _agent(project)
    deployment = await make_deployment("production", name="hooked")
    deployment.parent_type_id = str(agent.typeid)
    await deployment.save()
    pushed = await DataSource.find_owned(agent.typeid)
    for source in pushed:
        source.status = SourceStatus.SETUP.value
        await source.save_runtime()
    file = drop_folder() / "values.json"
    file.write_text(json.dumps({"values": {"PUSHED_KEY": "k-1", "PUSHED_WEBHOOK_URL": "https://hub.test/api/v1/webhook/x"}}))

    outcome = await place_values(str(deployment.id), str(project.id), str(file))

    readers = {str(s.name) for s in pushed if s.provider == _Pushed.provider}
    assert outcome["verified"] == dict.fromkeys(readers, "ready"), "only the sources reading a placed variable"
    for source in await DataSource.find_owned(agent.typeid):
        expected = SourceStatus.ACTIVE.value if source.provider == _Pushed.provider else SourceStatus.SETUP.value
        assert source.status == expected
