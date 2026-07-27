"""Regression + contract for the @local compute node SINGLETON.

Pins the single source of truth introduced after the "deleting a project broke
project selection" incident (prod instance 9007):

  * ``ComputeNode.get_local()`` is robust — it self-heals (recreates the
    deterministic-id singleton) when the row is gone, and ``create=False``
    is a pure read that must NOT mint a node as a side effect.

  * Deleting a project must NOT delete the shared @local compute node, EVEN
    when the legacy ``is_child`` edge (project → compute_node) is present.
    That edge is what ``Project.delete_with_children``'s cascading delete
    followed, destroying the node out from under every live PTY/agentic
    session. ``create_local`` no longer makes the node a child, and the
    delete defensively detaches it first.

Real DB (session ``initialize_test_db`` fixture), real ``ComputeNode`` +
``Project`` + real delete path — no mocks of the unit under test.
"""

from __future__ import annotations

import pytest

from flow_sdk.builtin.faas.compute_node import ComputeNode
from flow_sdk.builtin.project import Project


async def _delete_local_compute_node() -> None:
    """Establish the precondition: no @local compute node anywhere."""
    from flow_sdk.core.cache.entity_cache import uname_cache

    existing = await ComputeNode.get_local(create=False)
    if existing is not None:
        await existing.delete()
    uname_cache.invalidate("compute_node", "local")


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_get_local_self_heals_and_create_flag_is_read_only() -> None:
    await _delete_local_compute_node()

    # create=False is a pure read — it must NOT mint the node.
    assert await ComputeNode.get_local(create=False) is None

    # The default self-heals: mints the deterministic-id singleton.
    node = await ComputeNode.get_local()
    assert node is not None
    assert str(node.id) == ComputeNode._local_id()
    assert node.uname == "local"

    # Idempotent: resolving again returns the SAME node (no churn / duplicates).
    again = await ComputeNode.get_local()
    assert str(again.id) == str(node.id)


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_project_delete_preserves_local_compute_node() -> None:
    cn = await ComputeNode.get_local()
    cn_id = str(cn.id)

    # A project that points at a non-existent mount (rmtree is a no-op) and —
    # crucially — carries the LEGACY bad edge: the @local compute node attached
    # as a project child. This is exactly the state older instances are in.
    project = Project(name="/tmp/flowpad-cn-singleton-delete-test")
    await project.save()
    await project.attach_child(cn.typeid)

    # Delete the project the way the UI does.
    await project._delete_with_children()

    # The shared singleton must survive — same id, still resolvable read-only.
    survivor = await ComputeNode.get_local(create=False)
    assert survivor is not None, "project delete destroyed the shared @local compute node"
    assert str(survivor.id) == cn_id


@pytest.mark.asyncio
async def test_project_delete_preserves_dynamic_protected_source(
    tmp_path,
    monkeypatch,
) -> None:
    import flow_sdk.config as config
    from flow_sdk.fs_store.path_utils import canonical_posix_path

    source = tmp_path / "dynamic-protected-source"
    source.mkdir()
    sentinel = source / "keep.txt"
    sentinel.write_text("keep")

    # It begins as an ordinary project. Changing the configured workspace root
    # later proves protection is derived at deletion time, not stored stale.
    project = Project(name=source.name, fs_storage_mount_path=str(source))
    await project.save()
    assert not project.protected_path

    canonical = canonical_posix_path(source)
    monkeypatch.setattr(config, "AGENT_MOUNT_FOLDER", canonical)
    monkeypatch.setattr(config, "agent_workspace_root", lambda: source)
    assert project.protected_path

    await project._delete_with_children()

    assert sentinel.read_text() == "keep"
    assert await Project.get_by_id(project.id) is None
