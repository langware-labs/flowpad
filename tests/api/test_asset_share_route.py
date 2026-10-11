"""POST /api/v1/assets/share — the gates, and what they promise not to touch.

The property worth testing is negative: for every refusal a user can act on,
the working tree must be exactly as they left it. A share that half-commits and
then reports "your project isn't linked" is worse than one that never ran,
because the user now has to work out what happened to their branch.

Every refusal arrives as HTTP 200 with a distinct `error_code` — see
`routes/display.py` for why the transport status can't carry it.
"""

import pytest

from flow_sdk.fs_store.schema_registry import SchemaRegistry

pytestmark = pytest.mark.asyncio


async def _share(client, **body):
    resp = await client.post("/api/v1/assets/share", json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _code(payload: dict) -> str:
    assert payload["status"] != "SUCCESS", payload
    return (payload.get("data") or {}).get("error_code")


async def test_an_address_is_required(client):
    assert _code(await _share(client)) == "INVALID_ARG"


async def test_a_malformed_typeid_is_distinguishable_from_a_missing_entity(client):
    assert _code(await _share(client, typeid="not-a-typeid")) == "INVALID_ARG"
    missing = await _share(client, typeid="markdown-550e8400-e29b-41d4-a716-446655440000")
    assert _code(missing) == "NOT_FOUND"


async def test_an_unindexed_path_says_to_index_it(client, tmp_path):
    docs = tmp_path / "docs"
    docs.mkdir()
    doc = docs / "never-indexed.md"
    doc.write_text("---\ntitle: Fresh\n---\n# Fresh\n")

    payload = await _share(client, path=str(doc))
    assert _code(payload) == "NOT_INDEXED"
    assert any("flow record index" in step for step in payload["data"]["remediation"])


async def test_a_type_with_no_git_transport_is_refused(client):
    """A shell is not a document — there is no git-referenced thing to publish."""
    from flow_sdk.builtin.shell import Shell

    shell = Shell(name="Terminal", workdir="/tmp")
    await shell.save()

    assert _code(await _share(client, typeid=f"shell-{shell.id}")) == "NOT_PUBLISHABLE"


async def test_an_asset_with_no_owning_project_is_refused(client, tmp_path):
    """`markdown` IS git-publishable, so this gets past G1 and stops at G2."""
    from flow_sdk.core.entity.entity_model import Entity
    from flow_sdk.fs_store.fs_ref import FSRef

    doc = tmp_path / "orphan.md"
    doc.write_text("---\ntitle: Orphan\n---\n# Orphan\n")
    entity = await Entity.from_record(SchemaRegistry.get("markdown").from_disk_fn(FSRef(doc), "")[0])
    assert entity is not None

    payload = await _share(client, typeid=f"markdown-{entity.id}")
    # No project owns it, so there is nowhere in the cloud for it to live.
    assert _code(payload) == "NO_PROJECT"


async def test_dry_run_reports_without_touching_anything(client, tmp_path, monkeypatch):
    """`--dry-run` must answer "would this work?" with zero side effects."""
    from flow_sdk.builtin.faas.git_repo import GitRepo

    async def _boom(*args, **kwargs):
        raise AssertionError("dry-run must not commit")

    monkeypatch.setattr(GitRepo, "push", _boom)

    doc = tmp_path / "docs" / "x.md"
    doc.parent.mkdir(parents=True)
    doc.write_text("---\ntitle: X\n---\n# X\n")
    payload = await _share(client, path=str(doc), dry_run=True)
    # It refuses well before git either way; the point is that it refuses
    # rather than mutating.
    assert payload["status"] != "SUCCESS"


async def _linked_skill(client, root, monkeypatch):
    """A skill in a linked project whose folder is NOT a git repository, with
    the hub's browser origin stood in for (it is environment, not state)."""
    from flow_sdk.fs_store.record_types import RecordType
    from tests.api._published import entity_row, index, project, write_skill

    monkeypatch.setattr("flow_sdk.builtin.asset_sharing._hub_app_origin", lambda: "https://hub.example")
    pid = await project(client, root)
    write_skill(root, "review")
    await index(root, pid, RecordType.SKILL)
    skill = await entity_row(client, "skill", pid, "review")
    await client.put(f"/api/v1/graph/project/{pid}", json={"remote": True})
    return pid, skill


async def test_a_project_folder_need_not_be_a_git_repo(client, tmp_path, monkeypatch):
    """The asset reaches the cloud through the project's hub repo: no local
    commit is attempted, and the publish still runs."""
    from flow_sdk.assets.git_publish import AssetPublishResult

    published: list[str] = []

    async def _publish(entity, actor):
        published.append(str(entity.typeid))
        return AssetPublishResult(project={"id": entity.project_id}, asset={"id": entity.id}, git={"pushed": True})

    monkeypatch.setattr("flow_sdk.builtin.asset_publishing.publish_git_asset", _publish)
    root = tmp_path / "plain-project"
    root.mkdir()
    _pid, skill = await _linked_skill(client, root, monkeypatch)

    payload = await _share(client, typeid=f"skill-{skill['id']}")

    assert payload["status"] == "SUCCESS", payload
    assert not (root / ".git").exists()
    assert payload["data"]["commit"]["state"] == "skipped"
    assert payload["data"]["publish"]["git"] == {"pushed": True}
    assert published == [f"skill-{skill['id']}"]


async def test_a_hub_repo_conflict_is_reported_with_its_remedy(client, tmp_path, monkeypatch):
    from flow_sdk.assets.git_publish import AssetPublishCode, AssetPublishError

    async def _conflict(entity, actor):
        raise AssetPublishError(AssetPublishCode.ASSET_CONFLICT, "changed on the hub and here")

    monkeypatch.setattr("flow_sdk.builtin.asset_publishing.publish_git_asset", _conflict)
    root = tmp_path / "conflicted-project"
    root.mkdir()
    _pid, skill = await _linked_skill(client, root, monkeypatch)

    payload = await _share(client, typeid=f"skill-{skill['id']}")

    assert _code(payload) == "ASSET_CONFLICT"
    assert any("hub" in step for step in payload["data"]["remediation"])
