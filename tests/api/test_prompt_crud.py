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


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_prompt_project_scoped_create_materializes_md(bootstrapped_client, user, tmp_path):
    """The exact UI create path: project-scoped POST → .md under
    <project>/prompts/ with frontmatter ``extract_prompt`` can round-trip."""
    from pathlib import Path

    from flow_sdk.fs_store.fs_ref import FSRef
    from flow_sdk.fs_store.indexer.functions.prompt import extract_prompt

    client = bootstrapped_client
    resp = await client.post(
        "/api/v1/graph/project",
        json={"type": "project", "name": "plib", "fs_storage_mount_path": str(tmp_path)},
    )
    assert resp.json().get("status") == "SUCCESS", resp.text
    project_id = resp.json()["data"]["id"]

    resp = await client.post(
        f"/api/v1/graph/project/{project_id}/prompt",
        json={"type": "prompt", "name": "Code review pass", "text": "Review the diff.",
              "icon": "Rocket", "color": "#16a34a"},
    )
    assert resp.json().get("status") == "SUCCESS", resp.text
    created = resp.json()["data"]

    md = tmp_path / "prompts" / "code_review_pass.md"
    assert created["asset_ref"] == str(md), created
    assert md.is_file(), "create must materialize the backing .md"

    # what the indexer would read back equals what the API wrote
    [rec] = extract_prompt(FSRef(Path(md)))
    assert rec.id == created["id"]
    assert rec.name == "Code review pass"
    assert rec.icon == "Rocket"
    assert rec.color == "#16a34a"
    assert rec.text == "Review the diff."

    # EDIT must reach the on-disk source of truth (owns_main_ref): otherwise
    # the next rescan of the stale frontmatter reverts the entity edit.
    edited = await Prompt.get_by_id(created["id"])
    edited.color = "#8b5cf6"
    await edited.save()
    [rec2] = extract_prompt(FSRef(Path(md)))
    assert rec2.color == "#8b5cf6"
    assert rec2.text == "Review the diff."  # body preserved
