"""One resolver, every consumer.

A project's declared credentials reach workers, the connector's commands, and
terminals through a single implementation with two transports — a process env
dict here, a `list[FlowEnv]` for a compute node. Two resolutions would mean a
change to how a value resolves could apply to one path and miss the other.

Node attachment gates all of them. An uncurated node reports None (no
restriction), so nothing changes for anyone who has never opened the attach UI.
"""

import pytest

from flow_sdk.builtin.credential_resolver import resolve_project_secrets
from flow_sdk.builtin.credential_service import save_credential
from flow_sdk.builtin.faas.compute_node import ComputeNode
from flow_sdk.builtin.project import Project
from flow_sdk.core.flow.models.execution.env_context import resolve_node_secret_env
from flow_sdk.schema.type_info import register_all

register_all()


async def _project_with_values(tmp_path, **secrets):
    project = Project(name=str(tmp_path / "load-proj"))
    project.fs_storage_mount_path = str(tmp_path)
    await project.save()
    if secrets:
        await save_credential(
            scope="project",
            project_id=str(project.id),
            manifest={"name": "pack", "vars": {k: {"label": k} for k in secrets}},
            values=secrets,
        )
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
async def test_an_unfilled_variable_is_skipped_not_fatal(tmp_path, sod_env):
    """A missing value must never take down a spawn."""
    project = await _project_with_values(tmp_path, A_KEY="a-val")
    await save_credential(
        scope="project",
        project_id=str(project.id),
        manifest={"name": "empty", "vars": {"NEVER_PROVIDED": {"label": "x"}}},
    )

    resolved = await resolve_project_secrets(project)

    assert list(resolved) == ["A_KEY"]


@pytest.mark.asyncio
async def test_an_undeclared_env_local_key_is_not_injected(tmp_path, sod_env):
    """Only declared variables reach a process; the file also holds ports and flags."""
    project = await _project_with_values(tmp_path, A_KEY="a-val")
    with open(tmp_path / ".env.local", "a", encoding="utf-8") as f:
        f.write('VITE_PORT="5173"\n')

    assert list(await resolve_project_secrets(project)) == ["A_KEY"]


@pytest.mark.asyncio
async def test_a_raising_store_is_skipped(tmp_path, sod_env, monkeypatch):
    project = await _project_with_values(tmp_path, A_KEY="a-val")

    from flow_sdk.builtin import credential_store

    def boom(*a, **k):
        raise RuntimeError("store exploded")

    monkeypatch.setattr(credential_store, "_load_vault", boom)
    monkeypatch.setattr("flow_sdk.builtin.env_local_store.read_env_local_values", boom)

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
