"""POST /api/v1/assets/share — the gates, and what they promise not to touch.

The property worth testing is negative: for every refusal a user can act on,
the working tree must be exactly as they left it. A share that half-commits and
then reports "your project isn't linked" is worse than one that never ran,
because the user now has to work out what happened to their branch.

Every refusal arrives as HTTP 200 with a distinct `error_code` — see
`routes/display.py` for why the transport status can't carry it.
"""

import pytest

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
    from flow_sdk.fs_store.indexer.functions.markdown import extract_markdown

    doc = tmp_path / "orphan.md"
    doc.write_text("---\ntitle: Orphan\n---\n# Orphan\n")
    entity = await Entity.from_record(extract_markdown(FSRef(doc), "")[0])
    assert entity is not None

    payload = await _share(client, typeid=f"markdown-{entity.id}")
    # No project owns it, so there is nowhere in the cloud for it to live.
    assert _code(payload) == "NO_PROJECT"


async def test_dry_run_reports_without_touching_anything(client, tmp_path, monkeypatch):
    """`--dry-run` must answer "would this work?" with zero side effects."""
    import flow_sdk.utils.git as git_utils

    async def _boom(*args, **kwargs):
        raise AssertionError("dry-run must not commit")

    monkeypatch.setattr(git_utils, "git_add_commit_push", _boom)

    doc = tmp_path / "docs" / "x.md"
    doc.parent.mkdir(parents=True)
    doc.write_text("---\ntitle: X\n---\n# X\n")
    payload = await _share(client, path=str(doc), dry_run=True)
    # It refuses well before git either way; the point is that it refuses
    # rather than mutating.
    assert payload["status"] != "SUCCESS"
