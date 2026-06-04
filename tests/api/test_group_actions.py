"""API tests for the generic grouping layer (docs/entities-groups.md).

Covers: the types="all" ``set-group`` action, ``move`` (cycle-checked),
``delete-group`` move-children-up, children/roots listing through the generic
entity query (the exact queries the ts_sdk composes), and on-disk persistence
of ``group_id``/``group_namespace`` via the declarative record path.
"""
import json
import uuid

import pytest

from flow_sdk.builtin.group import Group
from flow_sdk.builtin.spec import Spec
from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp

pytestmark = pytest.mark.asyncio

NS = "test-lib"


def _ns() -> str:
    """Unique namespace per test so parallel/api-suite runs never collide."""
    return f"{NS}-{uuid.uuid4().hex[:8]}"


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_set_group_on_member_entity(bootstrapped_client, user):
    client = bootstrapped_client
    ns = _ns()
    folder = Group(name="Folder", group_namespace=ns)
    await folder.save()
    member = Spec(title="m1")
    await member.save()

    resp = await client.post(f"/api/v1/graph/spec/{member.id}/set-group", json={"group_id": folder.id})
    assert resp.status_code == 200, resp.text
    assert resp.json().get("status") == "SUCCESS"
    fresh = await Spec.get_by_id(member.id)
    assert fresh.group_id == folder.id

    # ungroup
    resp = await client.post(f"/api/v1/graph/spec/{member.id}/set-group", json={"group_id": None})
    assert resp.json().get("status") == "SUCCESS"
    assert (await Spec.get_by_id(member.id)).group_id is None


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_set_group_rejects_missing_target(bootstrapped_client, user):
    client = bootstrapped_client
    member = Spec(title="m2")
    await member.save()
    resp = await client.post(
        f"/api/v1/graph/spec/{member.id}/set-group", json={"group_id": str(uuid.uuid4())}
    )
    assert resp.json().get("status") != "SUCCESS"
    assert (await Spec.get_by_id(member.id)).group_id is None


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_move_rejects_cycles(bootstrapped_client, user):
    client = bootstrapped_client
    ns = _ns()
    root = Group(name="Root", group_namespace=ns)
    await root.save()
    child = Group(name="Child", group_namespace=ns, group_id=root.id)
    await child.save()

    # self-parent
    resp = await client.post(f"/api/v1/graph/group/{child.id}/move", json={"group_id": child.id})
    assert resp.json().get("status") != "SUCCESS"
    # under own descendant
    resp = await client.post(f"/api/v1/graph/group/{root.id}/move", json={"group_id": child.id})
    assert resp.json().get("status") != "SUCCESS"
    # legal re-parent to root level
    resp = await client.post(f"/api/v1/graph/group/{child.id}/move", json={"group_id": None})
    assert resp.json().get("status") == "SUCCESS"
    assert (await Group.get_by_id(child.id)).group_id is None


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_children_and_roots_queries(bootstrapped_client, user):
    """The exact generic queries the ts_sdk composes for the tree."""
    ns = _ns()
    root = Group(name="Root", group_namespace=ns)
    await root.save()
    child = Group(name="Child", group_namespace=ns, group_id=root.id)
    await child.save()
    member = Spec(title="m3", group_id=root.id)
    await member.save()

    # children of root: subgroups + members, each one per-type EQ query
    sub = await Group.get_all(entities_filter=QueryFilter(match=ExpressionNode(group_id=root.id)))
    assert [g.id for g in sub] == [child.id]
    members = await Spec.get_all(entities_filter=QueryFilter(match=ExpressionNode(group_id=root.id)))
    assert member.id in [m.id for m in members]

    # roots of the namespace: namespace EQ AND group_id IS_NULL.
    # NOTE: leaves must carry TWO operands — _expr_to_sql rejects
    # single-operand leaves as non-pushable (sqlite_driver.py:1341) — so
    # IS_NULL is expressed as ["group_id", None]; the SDK composes the same.
    roots = await Group.get_all(
        entities_filter=QueryFilter(
            match=ExpressionNode(
                operands=[
                    ExpressionNode(group_namespace=ns),
                    ExpressionNode(operands=["group_id", None], op=QueryOp.IS_NULL),
                ],
                op=QueryOp.AND,
            )
        )
    )
    root_ids = [g.id for g in roots]
    assert root.id in root_ids
    assert child.id not in root_ids


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_delete_group_moves_children_up(bootstrapped_client, user):
    client = bootstrapped_client
    ns = _ns()
    root = Group(name="Root", group_namespace=ns)
    await root.save()
    mid = Group(name="Mid", group_namespace=ns, group_id=root.id)
    await mid.save()
    leaf_group = Group(name="Leaf", group_namespace=ns, group_id=mid.id)
    await leaf_group.save()
    member = Spec(title="m4", group_id=mid.id)
    await member.save()

    resp = await client.post(f"/api/v1/graph/group/{mid.id}/delete-group", json={})
    body = resp.json()
    assert body.get("status") == "SUCCESS", resp.text
    assert body["data"]["moved_children"] >= 2

    assert await Group.get_by_id(mid.id) is None
    assert (await Group.get_by_id(leaf_group.id)).group_id == root.id
    assert (await Spec.get_by_id(member.id)).group_id == root.id


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_group_record_persists_membership_and_namespace(bootstrapped_client, user):
    """Disk is the source of truth: group_id + group_namespace land in metadata.json."""
    from flow_sdk.fs_store.record_paths import get_default_records_root
    from flow_sdk.fs_store.fs_record import record_stem

    ns = _ns()
    parent = Group(name="P", group_namespace=ns)
    await parent.save()
    child = Group(name="C", group_namespace=ns, icon="Star", color="#7aa2f7", group_id=parent.id)
    await child.save()
    child.store()  # explicit entity→record sync (rule 17)

    meta_path = (
        get_default_records_root() / "group" / record_stem("group", child.id) / "metadata.json"
    )
    assert meta_path.exists(), f"record metadata not written at {meta_path}"
    meta = json.loads(meta_path.read_text())
    assert meta.get("group_id") == parent.id
    assert meta.get("group_namespace") == ns
    assert meta.get("icon") == "Star"
    assert meta.get("color") == "#7aa2f7"
