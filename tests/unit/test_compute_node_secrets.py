"""Which of a project's secrets a compute node may see.

The model is a plain value-free field on the node: `{project_id: [ENV_VAR]}`.
The token IS the env var name and the project is the namespace, so nothing
secret is stored and the map can travel with a shared node — which is the point,
since secrets live on the node and whoever gets the node gets them.

The back-compat rule carries real weight: an ABSENT project key means "all",
so a node nobody has curated behaves exactly as it did before attachment
existed.
"""

import json

import pytest

from flow_sdk.builtin.faas.compute_node import ComputeNode
from flow_sdk.builtin.project import Project
from flow_sdk.schema.type_info import register_all

register_all()


async def _project_with(tmp_path, *env_vars, name="node-secrets-proj"):
    project = Project(name=str(tmp_path / name))
    project.fs_storage_mount_path = str(tmp_path)
    await project.save()
    for env_var in env_vars:
        await project.add_secret_pointer(
            name=env_var, env_var=env_var, scope="private",
            locator={"kind": "env-local", "env_key": env_var},
        )
    return project


async def _node():
    node = ComputeNode(name="unit-node")
    await node.save()
    return node


@pytest.mark.asyncio
async def test_an_uncurated_node_sees_everything(tmp_path, sod_env):
    """No key recorded means no restriction — existing nodes keep working."""
    project = await _project_with(tmp_path, "A_KEY", "B_KEY")
    node = await _node()

    assert node.attached_env_vars(project.id) is None

    resp = await node.list_attached_secrets(project_id=str(project.id))
    assert resp.data["all_attached"] is True
    assert all(row["attached"] for row in resp.data["secrets"])


@pytest.mark.asyncio
async def test_attaching_one_secret_does_not_silently_detach_the_rest(tmp_path, sod_env):
    """First curation turns the implicit 'all' into an explicit list. Starting
    from an empty set instead would quietly revoke everything else."""
    project = await _project_with(tmp_path, "A_KEY", "B_KEY")
    node = await _node()

    await node.attach_secret(project_id=str(project.id), env_var="A_KEY")

    assert sorted(node.attached_env_vars(project.id)) == ["A_KEY", "B_KEY"]


@pytest.mark.asyncio
async def test_detach_then_the_node_stops_seeing_it(tmp_path, sod_env):
    project = await _project_with(tmp_path, "A_KEY", "B_KEY")
    node = await _node()

    await node.detach_secret(project_id=str(project.id), env_var="A_KEY")

    assert node.attached_env_vars(project.id) == ["B_KEY"]


@pytest.mark.asyncio
async def test_attach_is_idempotent(tmp_path, sod_env):
    project = await _project_with(tmp_path, "A_KEY")
    node = await _node()

    await node.attach_secret(project_id=str(project.id), env_var="A_KEY")
    await node.attach_secret(project_id=str(project.id), env_var="A_KEY")

    assert node.attached_env_vars(project.id) == ["A_KEY"]


@pytest.mark.asyncio
async def test_an_undeclared_env_var_is_rejected(tmp_path, sod_env):
    project = await _project_with(tmp_path, "A_KEY")
    node = await _node()

    resp = await node.attach_secret(project_id=str(project.id), env_var="NOT_DECLARED")

    assert resp.status == "FAIL"
    assert node.attached_env_vars(project.id) is None


@pytest.mark.asyncio
async def test_attach_all_is_a_snapshot_not_a_standing_wildcard(tmp_path, sod_env):
    """A '*' sentinel would silently widen what a shared node exposes every time
    someone declares a new secret. Attach-all records today's set."""
    project = await _project_with(tmp_path, "A_KEY", "B_KEY")
    node = await _node()

    await node.attach_all_secrets(project_id=str(project.id))
    assert sorted(node.attached_env_vars(project.id)) == ["A_KEY", "B_KEY"]

    await project.add_secret_pointer(
        name="C_KEY", env_var="C_KEY", scope="private",
        locator={"kind": "env-local", "env_key": "C_KEY"},
    )

    assert "C_KEY" not in node.attached_env_vars(project.id)


@pytest.mark.asyncio
async def test_two_projects_on_one_node_do_not_see_each_other(tmp_path, sod_env):
    """The @local node serves every project, so the map has to be per-project or
    curating one would leak into all of them."""
    a = await _project_with(tmp_path / "a", "A_KEY", name="proj-a")
    b = await _project_with(tmp_path / "b", "B_KEY", name="proj-b")
    node = await _node()

    await node.detach_secret(project_id=str(a.id), env_var="A_KEY")

    assert node.attached_env_vars(a.id) == []
    assert node.attached_env_vars(b.id) is None, "project b is untouched"


@pytest.mark.asyncio
async def test_a_stale_project_key_is_not_fatal(tmp_path, sod_env):
    node = await _node()
    node.attached_secrets = {"deleted-project-id": ["GONE_KEY"]}
    await node.update()

    resp = await node.list_attached_secrets(project_id="deleted-project-id")

    assert resp.status == "SUCCESS"
    assert resp.data["secrets"] == []


@pytest.mark.asyncio
async def test_the_attachment_map_holds_names_only(tmp_path, sod_env):
    project = await _project_with(tmp_path, "A_KEY")
    node = await _node()
    await project.provide_secret(env_var="A_KEY", value="sk-super-secret")
    await node.attach_all_secrets(project_id=str(project.id))

    blob = json.dumps(node.model_dump(mode="json"), default=str)

    assert "A_KEY" in blob
    assert "sk-super-secret" not in blob
