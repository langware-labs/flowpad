"""Harness check: does a commit reach the graph through the git source?"""
from __future__ import annotations

import pytest

from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.ingest.reflect import ReflectMode
from flow_sdk.ingest.sync import sync_source

from .conftest import git

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


async def test_commit_reaches_the_graph(git_db, asset_repo, make_source):
    (asset_repo / "a.md").write_text("# Alpha\n\nquartzfeather\n", encoding="utf-8")
    git(asset_repo, "add", "."); git(asset_repo, "commit", "-q", "-m", "add doc")
    source, _proj, landing = await make_source(ReflectMode.IN_PLACE.value)

    await sync_source(source)

    ent = await Entity.get_by_asset_ref(str(landing / "a.md"), resolve_containing=True)
    assert ent is not None, "commit produced no entity"
    assert await Entity.search("quartzfeather", limit=10, record_type="markdown")
    # decision 1: the working tree must be untouched
    assert git(asset_repo, "status", "--porcelain") == "", "indexing dirtied the repo"
