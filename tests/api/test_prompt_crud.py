"""API tests for the Prompt entity (docs/prompt-library.md): CRUD round-trip,
library membership via the generic set-group action, and the children query
the prompt-library menu composes."""
import uuid

import pytest

from flow_sdk.builtin.group import Group
from flow_sdk.builtin.prompt import Prompt
from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter

pytestmark = pytest.mark.asyncio


def _ns() -> str:
    return f"prompt-lib-{uuid.uuid4().hex[:8]}"


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_prompt_crud_roundtrip(bootstrapped_client, user):
    p = Prompt(name="Review", text="Review the diff.", icon="Search", color="#7aa2f7")
    await p.save()
    fresh = await Prompt.get_by_id(p.id)
    assert fresh is not None
    assert fresh.name == "Review"
    assert fresh.text == "Review the diff."
    assert fresh.icon == "Search"
    assert fresh.color == "#7aa2f7"
    assert fresh.group_id is None


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_prompt_set_group_and_library_children_query(bootstrapped_client, user):
    client = bootstrapped_client
    ns = _ns()
    folder = Group(name="Reviews", group_namespace=ns)
    await folder.save()
    p = Prompt(name="Deep review", text="Go deep.")
    await p.save()

    resp = await client.post(f"/api/v1/graph/prompt/{p.id}/set-group", json={"group_id": folder.id})
    assert resp.json().get("status") == "SUCCESS", resp.text
    assert (await Prompt.get_by_id(p.id)).group_id == folder.id

    # the exact members query the library menu composes for a folder level
    members = await Prompt.get_all(
        entities_filter=QueryFilter(match=ExpressionNode(group_id=folder.id))
    )
    assert p.id in [m.id for m in members]


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_prompt_emoji_icon_roundtrip(bootstrapped_client, user):
    p = Prompt(name="Ship", text="Ship it.", icon="🚀")
    await p.save()
    assert (await Prompt.get_by_id(p.id)).icon == "🚀"
