"""On a deployment's machine: the values the hub places land where this machine's own lookup reads
them, a name nothing here declares is declared from the agent's requirements, and the dropped values
file never outlives the call. Names only come back."""
from __future__ import annotations

import json
import stat
from pathlib import Path

import pytest

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.credential_resolver import resolve_project_secrets
from flow_sdk.builtin.credential_service import (
    CredentialError,
    drop_folder,
    place_values,
    save_credential,
    unplace_values,
)
from flow_sdk.builtin.credential_store import Placement
from flow_sdk.schema.data_spec.requirement_spec import RequirementSpec
from tests.unit.test_credential_asset.test_project_setup import templates  # noqa: F401
from tests.utils.deployments import make_deployment

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


def _drop(values: dict) -> str:
    path = drop_folder() / "values.json"
    path.write_text(json.dumps({"values": values}))
    return str(path)


async def _agent_deployment(project):
    agent = Agent(name="placed-agent", project_id=str(project.id),
                  requirements=[RequirementSpec(kind="credential", name="stripe", vars=["STRIPE_KEY"])])
    await agent.save()
    deployment = await make_deployment("production", name="placed")
    deployment.parent_type_id = str(agent.typeid)
    await deployment.save()
    return deployment


async def test_placed_values_are_read_by_this_machines_lookup_and_the_drop_is_gone(home, project):
    deployment = await _agent_deployment(project)
    await save_credential(scope="project", project_id=str(project.id),
                          manifest={"name": "sentry", "vars": {"SENTRY_DSN": {}}, "setup": "x"})
    file = _drop({"STRIPE_KEY": "sk-placed", "SENTRY_DSN": "https://x@sentry"})

    outcome = await place_values(str(deployment.id), str(project.id), file)

    assert outcome == {"placed": ["SENTRY_DSN", "STRIPE_KEY"], "failed": {}}
    assert not Path(file).exists(), "the dropped values file is deleted at once"
    assert "sk-placed" not in json.dumps(outcome)
    values = await resolve_project_secrets(project, placement=await Placement.of(deployment))
    assert {k: v.get_secret_value() for k, v in values.items()} == {"STRIPE_KEY": "sk-placed", "SENTRY_DSN": "https://x@sentry"}
    assert (Path(project.fs_storage_mount_path) / ".env.production.local").exists(), "a project credential's own env file"
    assert stat.S_IMODE((home / ".env.production.local").stat().st_mode) == 0o600, "an undeclared name: declared here, user scope"


async def test_unplace_removes_what_was_placed(home, project):
    deployment = await _agent_deployment(project)
    await place_values(str(deployment.id), str(project.id), _drop({"STRIPE_KEY": "sk-placed"}))

    assert await unplace_values(str(deployment.id), str(project.id), ["STRIPE_KEY"]) == {"removed": ["STRIPE_KEY"]}
    assert await resolve_project_secrets(project, placement=await Placement.of(deployment)) == {}


async def test_only_a_file_inside_the_drop_folder_is_ever_read(home, project, tmp_path):
    deployment = await _agent_deployment(project)
    outside = tmp_path / "elsewhere.json"
    outside.write_text(json.dumps({"values": {"STRIPE_KEY": "x"}}))

    with pytest.raises(CredentialError, match="not a dropped values file"):
        await place_values(str(deployment.id), str(project.id), str(outside))
    assert outside.exists(), "never deleted either"
    assert stat.S_IMODE(drop_folder().stat().st_mode) == 0o700


@pytest.fixture
def instance_config(monkeypatch):
    """This instance's config.json in memory: the default environment set here must not outlive the test."""
    from flow_sdk.cli import app_config

    held: dict = {}
    monkeypatch.setattr(app_config, "get_config", lambda key, default=None: held.get(key, default))
    monkeypatch.setattr(app_config, "set_config", lambda key, value: held.__setitem__(key, value))
    return held


async def test_a_machine_that_never_adopted_the_hubs_id_places_at_its_own_placement(home, project, instance_config):
    """The hub places before, or without, a successful ``adopt_placement`` (it races the box's index):
    the machine IS the deployment, so the values land where this machine reads, in its environment."""
    from flow_sdk.builtin.deployment import Deployment
    from flow_sdk.instance_settings.environment import get_default_environment

    unknown = "3b8b2362-4500-47d6-a5ca-f88f89d85602"
    await save_credential(scope="project", project_id=str(project.id),
                          manifest={"name": "stripe", "vars": {"STRIPE_KEY": {}}, "setup": "x"})

    outcome = await place_values(unknown, str(project.id), _drop({"STRIPE_KEY": "sk-placed"}), "production")

    assert outcome == {"placed": ["STRIPE_KEY"], "failed": {}}
    assert get_default_environment() == "production", "terminals and the agent read the deployment's environment"
    values = await resolve_project_secrets(project, placement=await Placement.of(await Deployment.this_computer()))
    assert {k: v.get_secret_value() for k, v in values.items()} == {"STRIPE_KEY": "sk-placed"}
    assert await unplace_values(unknown, str(project.id), ["STRIPE_KEY"], "production") == {"removed": ["STRIPE_KEY"]}


async def test_the_environment_the_hub_sends_wins_over_a_serving_row_under_the_same_id(home, project, instance_config):
    """``expose-endpoints`` keys a serving row by the hub's id, in the instance default environment; a
    rotation placed at that row's environment would land in the development file."""
    serving = await make_deployment("development", name="served")
    await save_credential(scope="project", project_id=str(project.id),
                          manifest={"name": "stripe", "vars": {"STRIPE_KEY": {}}, "setup": "x"})

    await place_values(str(serving.id), str(project.id), _drop({"STRIPE_KEY": "sk-rotated"}), "production")

    mount = Path(project.fs_storage_mount_path)
    assert "sk-rotated" in (mount / ".env.production.local").read_text()
    assert not (mount / ".env.local").exists() or "sk-rotated" not in (mount / ".env.local").read_text()


async def test_a_placed_name_is_declared_from_its_shipped_template(home, project, instance_config, templates):  # noqa: F811
    """The laptop's credential does not travel with the repo; the box declares it from the catalogue
    entry the agent's requirements name, keeping its labels — not a bare invented one."""
    from flow_sdk.builtin.credential_resolver import declared_vars
    from flow_sdk.builtin.credential_service import template_named

    agent = Agent(name="bot-agent", project_id=str(project.id),
                  requirements=[RequirementSpec(kind="credential", name="telegram", vars=["TELEGRAM_BOT_TOKEN"])])
    await agent.save()
    deployment = await make_deployment("production", name="bot")
    deployment.parent_type_id = str(agent.typeid)
    await deployment.save()

    outcome = await place_values(str(deployment.id), str(project.id), _drop({"TELEGRAM_BOT_TOKEN": "123:abc"}))

    assert outcome == {"placed": ["TELEGRAM_BOT_TOKEN"], "failed": {}}
    declared, template = (await declared_vars(project))["TELEGRAM_BOT_TOKEN"].spec, await template_named("telegram")
    assert declared.setup == template.setup and declared.vars["TELEGRAM_BOT_TOKEN"] == template.vars["TELEGRAM_BOT_TOKEN"]
