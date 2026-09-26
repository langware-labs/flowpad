"""An agent's requirements — derived from what it owns, shipped with it — and one deployment's readiness.

Three sources on one agent: one reading a credential (a key: present = ``declared``, never verifiable),
one needing an OAuth permission (``verified`` against the held connection's scopes, else ``missing``),
and one needing an API-key permission (``declared`` when the variable that grants it is present).
"""
from __future__ import annotations

import pytest

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.credential_service import save_credential
from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.readiness import readiness, refresh_requirements, requirements
from flow_sdk.ingest.driver_runtime import DRIVERS
from flow_sdk.ingest.testing import make_data_source
from flow_sdk.schema.data_spec.connection_spec import ConnectionSpec
from flow_sdk.schema.data_spec.data_driver_spec import CURRENT_SCHEMA, AuthSpec, DataDriverSpec
from flow_sdk.schema.data_spec.requirement_spec import RequirementSpec
from flow_sdk.sources.families import RecordSource
from tests.utils.connection_rows import fake_connections

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

DRIVE = "https://www.googleapis.com/auth/drive.readonly"


class _Keyed(RecordSource):
    provider = "ready-keyed"


class _Drive(RecordSource):
    provider = "ready-drive"


class _Voice(RecordSource):
    provider = "ready-voice"


@pytest.fixture
def drivers():
    manifests = {
        _Keyed: DataDriverSpec(name=_Keyed.provider, schema=CURRENT_SCHEMA,
                               auth=AuthSpec(credential="stripe", vars={"key": "STRIPE_KEY"})),
        _Drive: DataDriverSpec(name=_Drive.provider, schema=CURRENT_SCHEMA, auth=AuthSpec(connector="google", scopes=[DRIVE]),
                               permissions={"permission.google.drive.read": {"mechanism": "oauth", "oauth_scopes": [DRIVE]}}),
        _Voice: DataDriverSpec(name=_Voice.provider, schema=CURRENT_SCHEMA, auth=AuthSpec(env=["READY_OPENAI_KEY"]),
                               permissions={"permission.openai.ready_test": {"mechanism": "api_key", "api_key": "READY_OPENAI_KEY"}}),
    }
    for cls, manifest in manifests.items():
        DataDriver.register(DataDriver.for_class(cls, manifest=manifest))
    yield
    for cls in manifests:
        DRIVERS.unregister(cls.provider)


async def _agent(project) -> Agent:
    agent = Agent(name="ready-agent", project_id=str(project.id))
    await agent.save()
    for cls in (_Keyed, _Drive, _Voice):
        await make_data_source(cls.provider, name=f"{cls.provider} source", owner=f"agent-{agent.id}").save()
    return agent


def _manifest(name: str, *env_vars: str) -> dict:
    return {"name": name, "vars": {v: {"label": v} for v in env_vars}, "setup": f"`flow credentials set {name} --stdin`."}


async def test_requirements_are_derived_from_what_the_agent_owns(project, drivers):
    agent = await _agent(project)
    await save_credential(scope="project", project_id=str(project.id), manifest=_manifest("openai-test", "READY_OPENAI_KEY"))

    got = {(r.kind, r.name): r for r in await requirements(agent)}

    assert set(got) == {
        ("credential", "stripe"),
        ("permission", "permission.google.drive.read"),
        ("permission", "permission.openai.ready_test"),
        ("credential", "openai-test"),
    }
    assert got[("credential", "stripe")].vars == ["STRIPE_KEY"]
    assert got[("credential", "openai-test")].vars == ["READY_OPENAI_KEY"], "a named variable maps to the credential declaring it"
    assert all(r.derived for r in got.values())


async def test_readiness_per_item_and_it_changes_as_values_and_grants_arrive(project, drivers, monkeypatch):
    agent = await _agent(project)
    rows = {"google": ConnectionSpec(provider="google", display_name="Google", connected=False)}
    fake_connections(monkeypatch, rows)

    before = {i.requirement.name: i for i in (await readiness(agent)).items}
    assert {n: i.status for n, i in before.items()} == {
        "stripe": "missing", "permission.google.drive.read": "missing", "permission.openai.ready_test": "missing",
        "READY_OPENAI_KEY": "missing",  # nothing declares it yet: a bare variable
    }
    assert before["permission.google.drive.read"].fix == "flow connections connect google"

    await save_credential(scope="project", project_id=str(project.id), manifest=_manifest("stripe", "STRIPE_KEY"),
                          values={"STRIPE_KEY": "sk-test-never-shown"})
    await save_credential(scope="project", project_id=str(project.id), manifest=_manifest("openai-test", "READY_OPENAI_KEY"),
                          values={"READY_OPENAI_KEY": "k"})
    rows["google"] = ConnectionSpec(provider="google", display_name="Google", connected=True, scopes=(DRIVE,))

    after = await readiness(agent)
    assert {i.requirement.name: i.status for i in after.items} == {
        "stripe": "declared", "permission.google.drive.read": "verified",
        "permission.openai.ready_test": "declared", "openai-test": "declared",
    }
    assert after.ready and "sk-test-never-shown" not in after.model_dump_json()


async def test_an_oauth_grant_without_the_scope_is_missing_and_says_which(project, drivers, monkeypatch):
    agent = await _agent(project)
    fake_connections(monkeypatch, {"google": ConnectionSpec(provider="google", display_name="Google", connected=True, scopes=())})

    drive = next(i for i in (await readiness(agent)).items if i.requirement.name == "permission.google.drive.read")
    assert (drive.status, drive.fix) == ("missing", f"reconnect google, granting {DRIVE}")


async def test_authored_requirements_are_kept_and_refresh_writes_them_to_the_agent(project, drivers):
    agent = await _agent(project)
    agent.requirements = [RequirementSpec(kind="variable", name="SENTRY_DSN", why="error reports")]
    await agent.save()

    assert await refresh_requirements(agent)
    names = [(r.kind, r.name, r.derived) for r in (await Agent.get_by_id(agent.id)).requirements]
    assert ("variable", "SENTRY_DSN", False) in names and ("credential", "stripe", True) in names
    assert not await refresh_requirements(agent), "nothing changed, nothing written"
