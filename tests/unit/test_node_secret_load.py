"""One resolver, every consumer.

A project's declared secrets reach workers, the connector's commands, and
terminals through a single implementation with two transports — a process env
dict here, a `list[FlowEnv]` for a compute node. Two resolutions would mean a
change to how a secret resolves could apply to one path and miss the other.

Node attachment gates all of them. The back-compat rule does the heavy lifting:
an uncurated node reports None (no restriction), so nothing changes for anyone
who has never opened the attach UI.
"""

import pytest

from flow_sdk.builtin.faas.compute_node import ComputeNode
from flow_sdk.builtin.project import Project
from flow_sdk.builtin.secret_origin_resolver import resolve_project_secrets
from flow_sdk.core.flow.models.execution.env_context import resolve_node_secret_env
from flow_sdk.schema.type_info import register_all

register_all()


async def _project_with_values(tmp_path, **secrets):
    project = Project(name=str(tmp_path / "load-proj"))
    project.fs_storage_mount_path = str(tmp_path)
    await project.save()
    for env_var, value in secrets.items():
        await project.add_secret_pointer(
            name=env_var, env_var=env_var, scope="private",
            locator={"kind": "env-local", "env_key": env_var},
        )
        await project.provide_secret(env_var=env_var, value=value)
    return project


@pytest.mark.asyncio
async def test_resolver_returns_every_declared_secret_by_default(tmp_path, sod_env):
    project = await _project_with_values(tmp_path, A_KEY="a-val", B_KEY="b-val")

    resolved = await resolve_project_secrets(project)

    assert {k: v.get_secret_value() for k, v in resolved.items()} == {"A_KEY": "a-val", "B_KEY": "b-val"}


@pytest.mark.asyncio
async def test_the_only_filter_excludes_unattached_secrets(tmp_path, sod_env):
    project = await _project_with_values(tmp_path, A_KEY="a-val", B_KEY="b-val")

    resolved = await resolve_project_secrets(project, only=["A_KEY"])

    assert list(resolved) == ["A_KEY"]


@pytest.mark.asyncio
async def test_none_means_no_restriction(tmp_path, sod_env):
    project = await _project_with_values(tmp_path, A_KEY="a-val")

    assert list(await resolve_project_secrets(project, only=None)) == ["A_KEY"]


@pytest.mark.asyncio
async def test_an_unresolvable_secret_is_skipped_not_fatal(tmp_path, sod_env):
    """A missing value must never take down a spawn."""
    project = await _project_with_values(tmp_path, A_KEY="a-val")
    await project.add_secret_pointer(
        name="NEVER_PROVIDED", env_var="NEVER_PROVIDED", scope="private",
        locator={"kind": "env-local", "env_key": "NEVER_PROVIDED"},
    )

    resolved = await resolve_project_secrets(project)

    assert list(resolved) == ["A_KEY"]


@pytest.mark.asyncio
async def test_a_raising_driver_is_skipped(tmp_path, sod_env, monkeypatch):
    project = await _project_with_values(tmp_path, A_KEY="a-val")

    from flow_sdk.builtin.drivers import env_local_secret_driver as mod

    async def boom(*a, **k):
        raise RuntimeError("driver exploded")

    monkeypatch.setattr(mod.EnvLocalSecretDriver, "resolve", boom)

    assert await resolve_project_secrets(project) == {}


@pytest.mark.asyncio
async def test_node_transport_yields_flowenv_with_secretstr(tmp_path, sod_env):
    project = await _project_with_values(tmp_path, A_KEY="a-val")

    envs = await resolve_node_secret_env(project)

    assert [e.name for e in envs] == ["A_KEY"]
    assert envs[0].value.get_secret_value() == "a-val"
    # SecretStr, so an accidental str() or repr() shows asterisks, not the value.
    assert "a-val" not in repr(envs[0].value)


@pytest.mark.asyncio
async def test_node_transport_honours_the_attachment(tmp_path, sod_env):
    project = await _project_with_values(tmp_path, A_KEY="a-val", B_KEY="b-val")
    node = await ComputeNode.get_local(create=True)
    await node.detach_secret(project_id=str(project.id), env_var="B_KEY")

    envs = await resolve_node_secret_env(project)

    assert [e.name for e in envs] == ["A_KEY"]
