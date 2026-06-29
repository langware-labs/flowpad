"""Unit tests for the generic Group containment rules (docs/entities-groups.md).

Pure in-memory: ``Group.get_by_id`` is monkeypatched onto a dict registry, so
``validate_membership`` / ``_is_descendant`` are exercised without a DB.
"""
import uuid

import pytest

from flow_sdk.builtin.group import Group, MAX_GROUP_DEPTH
from flow_sdk.core.entity.entity_model import Entity

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


def _uid() -> str:
    return str(uuid.uuid4())


def _patch_registry(monkeypatch, groups):
    """Serve ``Group.get_by_id`` from an in-memory dict."""
    by_id = {g.id: g for g in groups}

    async def fake_get_by_id(gid):
        return by_id.get(gid)

    monkeypatch.setattr(Group, "get_by_id", fake_get_by_id)
    return by_id


@pytest.mark.asyncio
async def test_ungroup_always_allowed(monkeypatch):
    _patch_registry(monkeypatch, [])
    entity = Entity(id=_uid())
    assert await Group.validate_membership(entity, None) is None


@pytest.mark.asyncio
async def test_self_parent_rejected(monkeypatch):
    g = Group(id=_uid(), name="a", group_namespace="ns")
    _patch_registry(monkeypatch, [g])
    error = await Group.validate_membership(g, g.id)
    assert error and "own parent" in error


@pytest.mark.asyncio
async def test_missing_target_rejected(monkeypatch):
    _patch_registry(monkeypatch, [])
    entity = Entity(id=_uid())
    error = await Group.validate_membership(entity, _uid())
    assert error and "does not exist" in error


@pytest.mark.asyncio
async def test_cross_project_rejected(monkeypatch):
    target = Group(id=_uid(), name="g", group_namespace="ns", project_id=_uid())
    _patch_registry(monkeypatch, [target])
    entity = Entity(id=_uid(), project_id=_uid())
    error = await Group.validate_membership(entity, target.id)
    assert error and "project" in error


@pytest.mark.asyncio
async def test_plain_member_into_group_allowed(monkeypatch):
    project = _uid()
    target = Group(id=_uid(), name="g", group_namespace="ns", project_id=project)
    _patch_registry(monkeypatch, [target])
    entity = Entity(id=_uid(), project_id=project)
    assert await Group.validate_membership(entity, target.id) is None


@pytest.mark.asyncio
async def test_group_cross_namespace_rejected(monkeypatch):
    target = Group(id=_uid(), name="t", group_namespace="ns-b")
    mover = Group(id=_uid(), name="m", group_namespace="ns-a")
    _patch_registry(monkeypatch, [target, mover])
    error = await Group.validate_membership(mover, target.id)
    assert error and "namespace" in error


@pytest.mark.asyncio
async def test_cycle_rejected(monkeypatch):
    """A under B is rejected when B is A's descendant (A -> B chain)."""
    a = Group(id=_uid(), name="a", group_namespace="ns")
    b = Group(id=_uid(), name="b", group_namespace="ns", group_id=a.id)
    _patch_registry(monkeypatch, [a, b])
    error = await Group.validate_membership(a, b.id)
    assert error and "descendant" in error


@pytest.mark.asyncio
async def test_deep_move_without_cycle_allowed(monkeypatch):
    """Moving a sibling subtree under a deep (unrelated) chain is fine."""
    a = Group(id=_uid(), name="a", group_namespace="ns")
    b = Group(id=_uid(), name="b", group_namespace="ns", group_id=a.id)
    c = Group(id=_uid(), name="c", group_namespace="ns", group_id=b.id)
    other = Group(id=_uid(), name="other", group_namespace="ns")
    _patch_registry(monkeypatch, [a, b, c, other])
    assert await Group.validate_membership(other, c.id) is None


@pytest.mark.asyncio
async def test_pathological_parent_loop_rejected(monkeypatch):
    """A corrupted on-disk loop (x <-> y) must exhaust the depth bound and
    reject instead of spinning."""
    x = Group(id=_uid(), name="x", group_namespace="ns")
    y = Group(id=_uid(), name="y", group_namespace="ns")
    x.group_id = y.id
    y.group_id = x.id
    _patch_registry(monkeypatch, [x, y])
    mover = Group(id=_uid(), name="m", group_namespace="ns")
    _patch_registry(monkeypatch, [x, y, mover])
    error = await Group.validate_membership(mover, x.id)
    assert error and "descendant" in error
    assert MAX_GROUP_DEPTH >= 64  # the bound itself stays generous


@pytest.mark.asyncio
async def test_group_id_field_exists_on_base_entity():
    """The generic membership field lives on base Entity and persists via BaseMeta."""
    from flow_sdk.schema.type_info.base_meta import BaseMeta

    assert Entity(id=_uid()).group_id is None
    assert "group_id" in BaseMeta.model_fields
