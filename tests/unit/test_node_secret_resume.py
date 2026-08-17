"""Resume semantics: trust what is there.

The claim is easy to state and easy to break by "fixing" one of these lines, so
each is pinned:

  - nothing secret is ever written to the node, so there is nothing to
    invalidate on resume;
  - the connector's loaded env is sticky — a later initialize(env=None) keeps
    it rather than silently unloading mid-session;
  - resume/pause do no secret work at all.
"""

import pytest

from flow_sdk.builtin.faas.compute_node import ComputeNode
from flow_sdk.builtin.project import Project
from flow_sdk.core.flow.flow_source_control import (
    ComputeSourceControl,
    ComputeSourceControlInitializeOptions,
)
from flow_sdk.core.flow.models.execution.env_context import FlowEnv
from flow_sdk.schema.type_info import register_all

register_all()


def _sc(node) -> ComputeSourceControl:
    return ComputeSourceControl(compute_node=node)


def _no_node_boot(monkeypatch, node):
    """Skip the real node lifecycle — this file is about the env field, not
    about booting a sandbox."""
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def _ready(_self=None):
        yield node

    monkeypatch.setattr(type(node), "ready_session", _ready, raising=False)


async def _node():
    node = ComputeNode(name="resume-node")
    await node.save()
    return node


@pytest.mark.asyncio
async def test_a_fresh_connector_holds_nothing(sod_env):
    assert _sc(await _node())._env is None


@pytest.mark.asyncio
async def test_a_later_initialize_without_env_keeps_what_is_loaded(sod_env, monkeypatch):
    """`if env:` rather than plain assignment. This IS 'trust what is there'."""
    node = await _node()
    _no_node_boot(monkeypatch, node)
    sc = _sc(node)
    loaded = [FlowEnv(name="A_KEY", value="a-val")]
    opts = ComputeSourceControlInitializeOptions(git_init=False)

    async with sc.initialize(opts, env=loaded):
        pass
    async with sc.initialize(opts, env=None):
        pass

    assert [e.name for e in sc._env] == ["A_KEY"]


@pytest.mark.asyncio
async def test_resume_and_pause_do_no_secret_work(sod_env, monkeypatch):
    node = await ComputeNode.get_local(create=True)
    calls = []

    import flow_sdk.builtin.secret_origin_resolver as resolver

    async def spy(*a, **k):
        calls.append(a)
        return {}

    monkeypatch.setattr(resolver, "resolve_project_secrets", spy)

    await node.resume()
    await node.pause()

    assert calls == [], "loading is bound to Project.initialize, not to a state change"


@pytest.mark.asyncio
async def test_attached_secrets_survive_a_reload_verbatim(tmp_path, sod_env):
    """The map is trusted as stored; nothing re-validates it against the
    project's current declarations on the way back in."""
    project = Project(name=str(tmp_path / "p"))
    project.fs_storage_mount_path = str(tmp_path)
    await project.save()
    await project.add_secret_pointer(
        name="A_KEY", env_var="A_KEY", scope="private",
        locator={"kind": "env-local", "env_key": "A_KEY"},
    )
    node = await _node()
    await node.attach_all_secrets(project_id=str(project.id))

    reloaded = await ComputeNode.get_by_id(node.id)

    assert reloaded.attached_env_vars(project.id) == ["A_KEY"]


@pytest.mark.asyncio
async def test_a_removed_secret_just_resolves_to_nothing(tmp_path, sod_env):
    """No repair pass: an attachment naming a secret the project no longer
    declares is inert, not an error."""
    project = Project(name=str(tmp_path / "p2"))
    project.fs_storage_mount_path = str(tmp_path)
    await project.save()
    node = await _node()
    node.attached_secrets = {str(project.id): ["LONG_GONE"]}
    await node.update()

    resp = await node.list_attached_secrets(project_id=str(project.id))

    assert resp.status == "SUCCESS"
    assert resp.data["secrets"] == []


@pytest.mark.asyncio
async def test_loading_writes_nothing_to_the_node_rc_file(tmp_path, sod_env, monkeypatch):
    """The invariant behind all of the above: project secrets are NEVER
    persisted onto the node. set_env/~/.bashrc is for the FLOWPAD_* proxy
    config only."""
    monkeypatch.setenv("HOME", str(tmp_path))
    project = Project(name=str(tmp_path / "p3"))
    project.fs_storage_mount_path = str(tmp_path)
    await project.save()
    await project.add_secret_pointer(
        name="RC_PROBE_KEY", env_var="RC_PROBE_KEY", scope="private",
        locator={"kind": "env-local", "env_key": "RC_PROBE_KEY"},
    )
    await project.provide_secret(env_var="RC_PROBE_KEY", value="sk-never-on-disk")

    from flow_sdk.core.flow.models.execution.env_context import resolve_node_secret_env

    envs = await resolve_node_secret_env(project)
    assert [e.name for e in envs] == ["RC_PROBE_KEY"]

    rc = tmp_path / ".bashrc"
    rc_text = rc.read_text() if rc.exists() else ""
    assert "RC_PROBE_KEY" not in rc_text
    assert "sk-never-on-disk" not in rc_text
