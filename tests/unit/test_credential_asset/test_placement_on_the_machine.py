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
from flow_sdk.builtin.credential_service import CredentialError, drop_folder, place_values, save_credential, unplace_values
from flow_sdk.builtin.credential_store import Placement
from flow_sdk.schema.data_spec.requirement_spec import RequirementSpec
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
